//go:build e2e

package e2e

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestStackRename(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "rename-project")
	env.login()

	env.run("stack", "init", "--stack", devOrgLogin+"/rename-project/dev")

	resp := env.httpDo("POST", "/api/stacks/"+devOrgLogin+"/rename-project/dev/rename", `{"newName":"staging"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rename: got status %d want %d", resp.StatusCode, http.StatusOK)
	}

	stdout, _ := env.run("stack", "ls", "--json")
	if !strings.Contains(stdout, "staging") {
		t.Fatalf("expected 'staging' in stack list after rename, got:\n%s", stdout)
	}
	stacks := mustJSON[[]stackEntry](t, stdout)
	for _, s := range stacks {
		if strings.Contains(s.Name, "dev") && !strings.Contains(s.Name, "dev-org") {
			t.Fatalf("old name 'dev' should not appear as stack name, got: %s", s.Name)
		}
	}
}

func TestStackRenameNonexistent(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "rename-ghost-project")
	env.login()

	resp := env.httpDo("POST", "/api/stacks/"+devOrgLogin+"/rename-ghost-project/ghost/rename", `{"newName":"staging"}`)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("rename nonexistent: got status %d want %d\nbody: %s", resp.StatusCode, http.StatusNotFound, body)
	}
}

func TestStackRenameConflict(t *testing.T) {
	truncateDB(t)
	env := newTestEnv(t, "rename-conflict-project")
	env.login()

	env.run("stack", "init", "--stack", devOrgLogin+"/rename-conflict-project/dev")
	env.run("stack", "init", "--stack", devOrgLogin+"/rename-conflict-project/staging")

	resp := env.httpDo("POST", "/api/stacks/"+devOrgLogin+"/rename-conflict-project/dev/rename", `{"newName":"staging"}`)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("rename conflict: got status %d want %d\nbody: %s", resp.StatusCode, http.StatusConflict, body)
	}
}
