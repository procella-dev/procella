//go:build e2e

package e2e

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestHealthEndpoint(t *testing.T) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, strataURL+"/healthz", nil)
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz status: got %d want %d", resp.StatusCode, http.StatusOK)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}

	var result map[string]string
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("parse JSON: %v\nbody: %s", err, body)
	}

	if result["status"] != "ok" {
		t.Fatalf("health status: got %q want %q", result["status"], "ok")
	}
}

func TestCapabilitiesEndpoint(t *testing.T) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, strataURL+"/api/capabilities", nil)
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	req.Header.Set("Accept", "application/vnd.pulumi+8")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /api/capabilities: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("capabilities status: got %d want %d", resp.StatusCode, http.StatusOK)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}

	var result map[string]json.RawMessage
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("parse JSON: %v\nbody: %s", err, body)
	}

	if _, ok := result["capabilities"]; !ok {
		t.Fatalf("response missing 'capabilities' key: %s", body)
	}
}
