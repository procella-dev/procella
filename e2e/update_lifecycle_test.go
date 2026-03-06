//go:build e2e

package e2e

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestPulumiPreview runs a preview against a no-resource YAML program.
// This exercises: CreateUpdate → StartUpdate → checkpoint → events → CompleteUpdate.
func TestPulumiPreview(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "preview-project")
	env.login()

	fqn := devOrgLogin + "/preview-project/dev"
	env.run("stack", "init", "--stack", fqn)

	// Run preview (no resources, so it should succeed quickly).
	stdout, stderr := env.run("preview", "--stack", fqn)
	output := combinedOutput(stdout, stderr)
	t.Logf("preview output: %s", output)

	// Verify stack is still accessible after preview.
	listOut, _ := env.run("stack", "ls", "--json")
	stacks := mustJSON[[]stackEntry](t, listOut)
	if len(stacks) != 1 {
		t.Fatalf("expected 1 stack after preview, got %d", len(stacks))
	}
}

// TestPulumiUp runs `pulumi up --yes` with a no-resource YAML program, then destroys it.
// This exercises the full update lifecycle end-to-end.
func TestPulumiUp(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "up-project")
	env.login()

	fqn := devOrgLogin + "/up-project/dev"
	env.run("stack", "init", "--stack", fqn)

	// Run up (no resources).
	stdout, stderr := env.run("up", "--yes", "--stack", fqn)
	output := combinedOutput(stdout, stderr)
	t.Logf("up output: %s", output)

	// Verify the update completed — the stack should not have an active operation.
	listOut, _ := env.run("stack", "ls", "--json")
	stacks := mustJSON[[]stackEntry](t, listOut)
	if len(stacks) != 1 {
		t.Fatalf("expected 1 stack after up, got %d", len(stacks))
	}
	if stacks[0].UpdateInProgress {
		t.Fatal("expected no update in progress after up")
	}

	// Verify a checkpoint was stored.
	var checkpointCount int
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := dbPool.QueryRow(ctx, `SELECT COUNT(*) FROM checkpoints`).Scan(&checkpointCount)
	if err != nil {
		t.Fatalf("query checkpoints: %v", err)
	}
	if checkpointCount == 0 {
		t.Fatal("expected at least 1 checkpoint after up, got 0")
	}
	t.Logf("checkpoint count after up: %d", checkpointCount)

	// Verify events were stored.
	var eventCount int
	err = dbPool.QueryRow(ctx, `SELECT COUNT(*) FROM update_events`).Scan(&eventCount)
	if err != nil {
		t.Fatalf("query events: %v", err)
	}
	if eventCount == 0 {
		t.Fatal("expected at least 1 event after up, got 0")
	}
	t.Logf("event count after up: %d", eventCount)

	// Verify the update record is in 'succeeded' status.
	var updateStatus string
	err = dbPool.QueryRow(ctx, `SELECT status FROM updates ORDER BY created_at DESC LIMIT 1`).Scan(&updateStatus)
	if err != nil {
		t.Fatalf("query update status: %v", err)
	}
	if updateStatus != "succeeded" {
		t.Fatalf("expected update status 'succeeded', got %q", updateStatus)
	}
}

// TestPulumiUpDestroy runs up followed by destroy — the full create/teardown cycle.
func TestPulumiUpDestroy(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "updestroy-project")
	env.login()

	fqn := devOrgLogin + "/updestroy-project/dev"
	env.run("stack", "init", "--stack", fqn)

	// Run up.
	env.run("up", "--yes", "--stack", fqn)

	// Run destroy.
	stdout, stderr := env.run("destroy", "--yes", "--stack", fqn)
	output := combinedOutput(stdout, stderr)
	t.Logf("destroy output: %s", output)

	// Verify both updates completed successfully.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var succeededCount int
	err := dbPool.QueryRow(ctx, `SELECT COUNT(*) FROM updates WHERE status = 'succeeded'`).Scan(&succeededCount)
	if err != nil {
		t.Fatalf("query succeeded updates: %v", err)
	}
	// CLI runs preview before each operation, so: preview+up + preview+destroy = 4 updates.
	if succeededCount < 2 {
		t.Fatalf("expected at least 2 succeeded updates, got %d", succeededCount)
	}
	t.Logf("succeeded update count: %d", succeededCount)

	// Stack should have no active operation.
	listOut, _ := env.run("stack", "ls", "--json")
	stacks := mustJSON[[]stackEntry](t, listOut)
	if len(stacks) != 1 {
		t.Fatalf("expected 1 stack, got %d", len(stacks))
	}
	if stacks[0].UpdateInProgress {
		t.Fatal("expected no update in progress after destroy")
	}
}

// TestPulumiRefresh runs `pulumi refresh --yes` on an empty stack.
func TestPulumiRefresh(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "refresh-project")
	env.login()

	fqn := devOrgLogin + "/refresh-project/dev"
	env.run("stack", "init", "--stack", fqn)

	// First run up (to have state), then refresh.
	env.run("up", "--yes", "--stack", fqn)
	stdout, stderr := env.run("refresh", "--yes", "--stack", fqn)
	output := combinedOutput(stdout, stderr)
	t.Logf("refresh output: %s", output)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var updateCount int
	err := dbPool.QueryRow(ctx, `SELECT COUNT(*) FROM updates WHERE status = 'succeeded'`).Scan(&updateCount)
	if err != nil {
		t.Fatalf("query updates: %v", err)
	}
	// At least 2 (up + refresh).
	if updateCount < 2 {
		t.Fatalf("expected at least 2 succeeded updates, got %d", updateCount)
	}
}

// TestPulumiUpWithResources runs up with a YAML program that creates a config output.
// This tests that actual deployment data flows through correctly.
func TestPulumiUpWithResources(t *testing.T) {
	truncateDB(t)

	// Create a custom project dir with an outputs section.
	home := t.TempDir()
	projectDir := t.TempDir()
	pulumiYAML := `name: resource-project
runtime: yaml
description: E2E test with outputs
outputs:
  greeting: "hello from strata"
`
	if err := os.WriteFile(filepath.Join(projectDir, "Pulumi.yaml"), []byte(pulumiYAML), 0o644); err != nil {
		t.Fatalf("write Pulumi.yaml: %v", err)
	}

	env := &testEnv{
		t:           t,
		home:        home,
		projectDir:  projectDir,
		accessToken: devAuthToken,
	}
	env.login()

	fqn := devOrgLogin + "/resource-project/dev"
	env.run("stack", "init", "--stack", fqn)
	stdout, stderr := env.run("up", "--yes", "--stack", fqn)
	output := combinedOutput(stdout, stderr)

	if !strings.Contains(output, "greeting") {
		t.Logf("expected 'greeting' in output, got: %s", output)
	}

	// Verify stack output via CLI.
	outStdout, _ := env.run("stack", "output", "--json", "--stack", fqn)
	t.Logf("stack output: %s", outStdout)
	if !strings.Contains(outStdout, "hello from strata") {
		t.Fatalf("expected 'hello from strata' in stack output, got: %s", outStdout)
	}

	// Clean up.
	env.run("destroy", "--yes", "--stack", fqn)
}

// TestPulumiUpConflict verifies that two concurrent updates on the same stack are rejected.
func TestPulumiUpConflict(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "conflict-project")
	env.login()

	fqn := devOrgLogin + "/conflict-project/dev"
	env.run("stack", "init", "--stack", fqn)

	// Create an update via the HTTP API directly, leaving it in 'not started' state.
	resp := env.httpDo("POST", fmt.Sprintf("/api/stacks/%s/conflict-project/dev/update", devOrgLogin), `{"name":"conflict-project","runtime":"yaml"}`)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200 creating update, got %d", resp.StatusCode)
	}

	// Now try to run pulumi up — it should fail because there's already an active update.
	_, stderr := env.runExpectErr("up", "--yes", "--stack", fqn)
	output := combinedOutput("", stderr)
	t.Logf("conflict output: %s", output)

	// The CLI should report some error (either conflict or a non-success status).
	if !strings.Contains(strings.ToLower(output), "conflict") && !strings.Contains(strings.ToLower(output), "409") && !strings.Contains(strings.ToLower(output), "already") {
		t.Logf("note: CLI error message was: %s", output)
	}
}
