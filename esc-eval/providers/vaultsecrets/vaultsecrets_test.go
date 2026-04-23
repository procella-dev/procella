package vaultsecrets

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/pulumi/esc"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) Do(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestOpenReturnsSecretDataMap(t *testing.T) {
	p := New(WithHTTPClient(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != "https://vault.example.com/v1/secret/data/app/config" {
			t.Fatalf("unexpected url: %s", req.URL.String())
		}
		if got := req.Header.Get("X-Vault-Token"); got != "vault-token" {
			t.Fatalf("unexpected token header: %s", got)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"data":{"data":{"username":"demo","enabled":true}}}`)),
		}, nil
	}))).(*provider)

	v, err := p.Open(t.Context(), map[string]esc.Value{
		"address":   esc.NewValue("https://vault.example.com"),
		"token":     esc.NewSecret("vault-token"),
		"mountPath": esc.NewValue("secret"),
		"path":      esc.NewValue("app/config"),
	}, nil)
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	data := v.Value.(map[string]esc.Value)
	if !v.Secret || !data["username"].Secret || data["username"].Value != "demo" {
		t.Fatalf("unexpected value: %#v", v)
	}
}

func TestOpenRejectsMissingAddress(t *testing.T) {
	_, err := New().Open(t.Context(), map[string]esc.Value{
		"token":     esc.NewSecret("vault-token"),
		"mountPath": esc.NewValue("secret"),
		"path":      esc.NewValue("app/config"),
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "address") {
		t.Fatalf("expected address error, got %v", err)
	}
}

func TestOpenPropagatesHTTPError(t *testing.T) {
	p := New(WithHTTPClient(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusForbidden,
			Body:       io.NopCloser(strings.NewReader(`permission denied`)),
		}, nil
	}))).(*provider)

	_, err := p.Open(t.Context(), map[string]esc.Value{
		"address":   esc.NewValue("https://vault.example.com"),
		"token":     esc.NewSecret("vault-token"),
		"mountPath": esc.NewValue("secret"),
		"path":      esc.NewValue("app/config"),
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("expected http error, got %v", err)
	}
}
