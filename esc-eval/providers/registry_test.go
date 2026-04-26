package providers

import (
	"context"
	"errors"
	"testing"
)

func TestNewRegistry_LoadsAllProviders(t *testing.T) {
	r := NewRegistry()
	for _, name := range []string{"aws-login", "aws-secrets", "aws-parameter-store", "vault-secrets"} {
		provider, err := r.LoadProvider(context.Background(), name)
		if err != nil {
			t.Fatalf("LoadProvider(%q) error = %v", name, err)
		}
		if provider == nil {
			t.Fatalf("LoadProvider(%q) returned nil provider", name)
		}
	}
}

func TestNewRegistry_RejectsUnknown(t *testing.T) {
	r := NewRegistry()
	_, err := r.LoadProvider(context.Background(), "fn::open::nonexistent")
	if !errors.Is(err, ErrUnknownProvider) {
		t.Fatalf("expected ErrUnknownProvider, got %v", err)
	}
}
