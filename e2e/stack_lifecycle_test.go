//go:build e2e

package e2e

import (
	"strings"
	"testing"
)

func TestStackInit(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "init-project")
	env.login()

	_, stderr := env.run("stack", "init", "--stack", devOrgLogin+"/init-project/dev")
	output := combinedOutput("", stderr)
	if !strings.Contains(strings.ToLower(output), "created stack") && !strings.Contains(output, "dev") {
		t.Logf("stack init output: %s", output)
	}

	stdout, _ := env.run("stack", "ls", "--json")
	stacks := mustJSON[[]stackEntry](t, stdout)
	if len(stacks) != 1 {
		t.Fatalf("expected 1 stack, got %d: %s", len(stacks), stdout)
	}
}

func TestStackInitDuplicate(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "dup-project")
	env.login()

	fqn := devOrgLogin + "/dup-project/dev"
	env.run("stack", "init", "--stack", fqn)

	_, stderr := env.runExpectErr("stack", "init", "--stack", fqn)
	if !strings.Contains(strings.ToLower(stderr), "already exists") {
		t.Fatalf("expected 'already exists' in error, got:\n%s", stderr)
	}
}

func TestStackList(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "list-project")
	env.login()

	env.run("stack", "init", "--stack", devOrgLogin+"/list-project/alpha")
	env.run("stack", "init", "--stack", devOrgLogin+"/list-project/beta")

	stdout, _ := env.run("stack", "ls", "--json")
	stacks := mustJSON[[]stackEntry](t, stdout)

	if len(stacks) != 2 {
		t.Fatalf("expected 2 stacks, got %d: %s", len(stacks), stdout)
	}

	names := stackNames(stacks)
	if !containsStackName(names, "alpha") {
		t.Fatalf("expected stack 'alpha' in list, got: %v", names)
	}
	if !containsStackName(names, "beta") {
		t.Fatalf("expected stack 'beta' in list, got: %v", names)
	}
}

func TestStackSelect(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "select-project")
	env.login()

	env.run("stack", "init", "--stack", devOrgLogin+"/select-project/first")
	env.run("stack", "init", "--stack", devOrgLogin+"/select-project/second")
	env.run("stack", "select", "--stack", devOrgLogin+"/select-project/first")

	stdout, _ := env.run("stack", "ls", "--json")
	stacks := mustJSON[[]stackEntry](t, stdout)

	var found bool
	for _, s := range stacks {
		if strings.Contains(s.Name, "first") && s.Current {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected 'first' to be current stack, got: %s", stdout)
	}
}

func TestStackRemove(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "rm-project")
	env.login()

	fqn := devOrgLogin + "/rm-project/ephemeral"
	env.run("stack", "init", "--stack", fqn)

	stdout, _ := env.run("stack", "ls", "--json")
	before := mustJSON[[]stackEntry](t, stdout)
	if len(before) != 1 {
		t.Fatalf("expected 1 stack before rm, got %d", len(before))
	}

	_, stderr := env.run("stack", "rm", "--yes", "--stack", fqn)
	if !strings.Contains(stderr, "has been removed") {
		t.Logf("rm output: %s", stderr)
	}

	stdout, _ = env.run("stack", "ls", "--json")
	after := mustJSON[[]stackEntry](t, stdout)
	if len(after) != 0 {
		t.Fatalf("expected 0 stacks after rm, got %d: %s", len(after), stdout)
	}
}

func TestStackFullLifecycle(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "lifecycle-project")
	env.login()

	base := devOrgLogin + "/lifecycle-project"

	env.run("stack", "init", "--stack", base+"/dev")

	stdout, _ := env.run("stack", "ls", "--json")
	stacks := mustJSON[[]stackEntry](t, stdout)
	if len(stacks) != 1 {
		t.Fatalf("after first init: expected 1 stack, got %d", len(stacks))
	}

	env.run("stack", "init", "--stack", base+"/staging")
	env.run("stack", "select", "--stack", base+"/dev")

	stdout, _ = env.run("stack", "ls", "--json")
	stacks = mustJSON[[]stackEntry](t, stdout)
	if len(stacks) != 2 {
		t.Fatalf("after second init: expected 2 stacks, got %d", len(stacks))
	}

	env.run("stack", "rm", "--yes", "--stack", base+"/dev")

	stdout, _ = env.run("stack", "ls", "--json")
	stacks = mustJSON[[]stackEntry](t, stdout)
	if len(stacks) != 1 {
		t.Fatalf("after first rm: expected 1 stack, got %d", len(stacks))
	}
	if !containsStackName(stackNames(stacks), "staging") {
		t.Fatalf("expected 'staging' to remain, got: %s", stdout)
	}

	env.run("stack", "rm", "--yes", "--stack", base+"/staging")

	stdout, _ = env.run("stack", "ls", "--json")
	stacks = mustJSON[[]stackEntry](t, stdout)
	if len(stacks) != 0 {
		t.Fatalf("after all rm: expected 0 stacks, got %d: %s", len(stacks), stdout)
	}
}

type stackEntry struct {
	Name             string `json:"name"`
	Current          bool   `json:"current"`
	UpdateInProgress bool   `json:"updateInProgress"`
	ResourceCount    *int   `json:"resourceCount"`
	URL              string `json:"url"`
}

func stackNames(stacks []stackEntry) []string {
	names := make([]string, len(stacks))
	for i, s := range stacks {
		names[i] = s.Name
	}
	return names
}

func containsStackName(names []string, substr string) bool {
	for _, n := range names {
		if strings.Contains(n, substr) {
			return true
		}
	}
	return false
}
