//go:build e2e

package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	devAuthToken = "devtoken123"
	devUserLogin = "dev-user"
	devOrgLogin  = "dev-org"
)

var (
	strataURL   string
	dbPool      *pgxpool.Pool
	projectRoot string
)

func TestMain(m *testing.M) {
	pulumiPath, err := exec.LookPath("pulumi")
	if err != nil {
		fmt.Fprintln(os.Stderr, "e2e: pulumi not found on PATH, skipping")
		os.Exit(0)
	}
	_ = pulumiPath

	wd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2e: getwd: %v\n", err)
		os.Exit(1)
	}
	projectRoot = filepath.Dir(wd)

	databaseURL := os.Getenv("STRATA_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = "postgres://strata:strata@localhost:5432/strata?sslmode=disable"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2e: connect to postgres: %v — skipping\n", err)
		os.Exit(0)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		fmt.Fprintf(os.Stderr, "e2e: ping postgres: %v — skipping\n", err)
		os.Exit(0)
	}
	dbPool = pool

	tmpDir, err := os.MkdirTemp("", "strata-e2e-*")
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2e: create temp dir: %v\n", err)
		os.Exit(1)
	}
	defer os.RemoveAll(tmpDir)

	binaryPath := filepath.Join(tmpDir, "strata")
	blobDir := filepath.Join(tmpDir, "blobs")
	if err := os.MkdirAll(blobDir, 0o750); err != nil {
		fmt.Fprintf(os.Stderr, "e2e: create blob dir: %v\n", err)
		os.Exit(1)
	}

	buildCmd := exec.Command("go", "build", "-o", binaryPath, "./cmd/strata")
	buildCmd.Dir = projectRoot
	buildCmd.Stdout = os.Stdout
	buildCmd.Stderr = os.Stderr
	if err := buildCmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "e2e: build strata: %v\n", err)
		os.Exit(1)
	}

	port, err := freePort()
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2e: find free port: %v\n", err)
		os.Exit(1)
	}

	strataURL = fmt.Sprintf("http://127.0.0.1:%d", port)

	srvCtx, srvCancel := context.WithCancel(context.Background())
	srvCmd := exec.CommandContext(srvCtx, binaryPath)
	srvCmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		fmt.Sprintf("STRATA_LISTEN_ADDR=:%d", port),
		"STRATA_DATABASE_URL=" + databaseURL,
		"STRATA_AUTH_MODE=dev",
		"STRATA_DEV_AUTH_TOKEN=" + devAuthToken,
		"STRATA_DEV_USER_LOGIN=" + devUserLogin,
		"STRATA_DEV_ORG_LOGIN=" + devOrgLogin,
		"STRATA_BLOB_BACKEND=local",
		"STRATA_BLOB_LOCAL_PATH=" + blobDir,
	}
	srvCmd.Stdout = os.Stdout
	srvCmd.Stderr = os.Stderr

	if err := srvCmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "e2e: start strata: %v\n", err)
		os.Exit(1)
	}

	if err := waitForHealthy(strataURL+"/healthz", 15*time.Second); err != nil {
		fmt.Fprintf(os.Stderr, "e2e: strata not healthy: %v\n", err)
		srvCancel()
		_ = srvCmd.Wait()
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "e2e: strata running at %s (pid %d)\n", strataURL, srvCmd.Process.Pid)

	code := m.Run()

	srvCancel()
	done := make(chan error, 1)
	go func() { done <- srvCmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = srvCmd.Process.Signal(syscall.SIGKILL)
		<-done
	}

	dbPool.Close()
	os.Exit(code)
}

type testEnv struct {
	t           *testing.T
	home        string
	projectDir  string
	accessToken string
}

func newTestEnv(t *testing.T, projectName string) *testEnv {
	t.Helper()
	home := t.TempDir()
	projectDir := newProjectDir(t, projectName)
	return &testEnv{
		t:           t,
		home:        home,
		projectDir:  projectDir,
		accessToken: devAuthToken,
	}
}

func newTestEnvWithToken(t *testing.T, projectName, token string) *testEnv {
	t.Helper()
	env := newTestEnv(t, projectName)
	env.accessToken = token
	return env
}

func (e *testEnv) login() {
	e.t.Helper()
	e.run("login", strataURL)
}

func (e *testEnv) run(args ...string) (string, string) {
	e.t.Helper()
	stdout, stderr, err := e.execPulumi(args...)
	if err != nil {
		e.t.Fatalf("pulumi %v failed: %v\nstdout:\n%s\nstderr:\n%s", args, err, stdout, stderr)
	}
	return stdout, stderr
}

func (e *testEnv) runExpectErr(args ...string) (string, string) {
	e.t.Helper()
	stdout, stderr, err := e.execPulumi(args...)
	if err == nil {
		e.t.Fatalf("pulumi %v should have failed but succeeded\nstdout:\n%s\nstderr:\n%s", args, stdout, stderr)
	}
	return stdout, stderr
}

func (e *testEnv) execPulumi(args ...string) (string, string, error) {
	cmd := exec.Command("pulumi", args...)
	cmd.Dir = e.projectDir
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"PULUMI_HOME=" + e.home,
		"PULUMI_ACCESS_TOKEN=" + e.accessToken,
		"PULUMI_SKIP_UPDATE_CHECK=true",
		"PULUMI_CONFIG_PASSPHRASE=test",
		"PULUMI_DIY_BACKEND_URL=",
		"PULUMI_BACKEND_URL=",
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

func (e *testEnv) httpDo(method, path, body string) *http.Response {
	e.t.Helper()
	var bodyReader io.Reader
	if body != "" {
		bodyReader = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, strataURL+path, bodyReader)
	if err != nil {
		e.t.Fatalf("create request: %v", err)
	}
	req.Header.Set("Authorization", "token "+e.accessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/vnd.pulumi+8")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("http %s %s: %v", method, path, err)
	}
	return resp
}

func newProjectDir(t *testing.T, projectName string) string {
	t.Helper()
	dir := t.TempDir()
	content := fmt.Sprintf("name: %s\nruntime: yaml\ndescription: E2E test project\n", projectName)
	if err := os.WriteFile(filepath.Join(dir, "Pulumi.yaml"), []byte(content), 0o644); err != nil {
		t.Fatalf("write Pulumi.yaml: %v", err)
	}
	return dir
}

func truncateDB(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := dbPool.Exec(ctx, `TRUNCATE checkpoints, update_events, updates, stacks, projects, organization_members, api_tokens, organizations, users CASCADE`)
	if err != nil {
		t.Fatalf("truncate database: %v", err)
	}
}

func waitForHealthy(url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			cancel()
			return fmt.Errorf("create health request: %w", err)
		}
		resp, err := client.Do(req)
		cancel()
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("server not healthy after %s", timeout)
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port, nil
}

func mustJSON[T any](t *testing.T, data string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(strings.TrimSpace(data)), &v); err != nil {
		t.Fatalf("parse JSON: %v\ndata: %s", err, data)
	}
	return v
}

func combinedOutput(stdout, stderr string) string {
	return stdout + stderr
}
