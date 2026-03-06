//go:build e2e

package e2e

import (
	"strings"
	"testing"
)

func TestLogin(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "login-project")
	stdout, stderr := env.run("login", strataURL)

	output := combinedOutput(stdout, stderr)
	if !strings.Contains(output, "Logged in") {
		t.Fatalf("expected 'Logged in' in output, got:\n%s", output)
	}
}

func TestWhoami(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "whoami-project")
	env.login()

	stdout, _ := env.run("whoami")
	if !strings.Contains(stdout, devUserLogin) {
		t.Fatalf("whoami: expected %q in stdout, got:\n%s", devUserLogin, stdout)
	}
}

func TestWhoamiJSON(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "whoami-json-project")
	env.login()

	stdout, _ := env.run("whoami", "--json")

	result := mustJSON[map[string]any](t, stdout)
	user, ok := result["user"].(string)
	if !ok || user != devUserLogin {
		t.Fatalf("whoami --json: expected user=%q, got %v", devUserLogin, result["user"])
	}
}

func TestLoginBadToken(t *testing.T) {
	truncateDB(t)
	env := newTestEnvWithToken(t, "bad-token-project", "wrongtoken")

	_, stderr := env.runExpectErr("login", strataURL)
	output := strings.ToLower(stderr)

	if !strings.Contains(output, "unauthorized") && !strings.Contains(output, "401") && !strings.Contains(output, "invalid") {
		t.Fatalf("expected auth error in output, got:\n%s", stderr)
	}
}
