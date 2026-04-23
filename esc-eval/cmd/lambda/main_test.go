package main

import (
	"context"
	"strings"
	"testing"
)

func TestHandleRejectsEmptyEncryptionKey(t *testing.T) {
	_, err := handle(context.Background(), EvaluateRequest{
		Definition:       "values: {foo: bar}",
		EncryptionKeyHex: "",
	})
	if err == nil {
		t.Fatal("expected error for empty encryptionKeyHex, got nil")
	}
	if !strings.Contains(err.Error(), "64 hex characters") {
		t.Fatalf("expected length error, got: %v", err)
	}
}

func TestHandleRejectsWrongLengthEncryptionKey(t *testing.T) {
	_, err := handle(context.Background(), EvaluateRequest{
		Definition:       "values: {foo: bar}",
		EncryptionKeyHex: "deadbeef",
	})
	if err == nil {
		t.Fatal("expected error for 8-char encryptionKeyHex, got nil")
	}
	if !strings.Contains(err.Error(), "64 hex characters") {
		t.Fatalf("expected length error, got: %v", err)
	}
}

func TestHandleRejectsInvalidHex(t *testing.T) {
	nonHex := strings.Repeat("Z", 64)
	_, err := handle(context.Background(), EvaluateRequest{
		Definition:       "values: {foo: bar}",
		EncryptionKeyHex: nonHex,
	})
	if err == nil {
		t.Fatal("expected error for non-hex encryptionKeyHex, got nil")
	}
	if !strings.Contains(err.Error(), "encryptionKeyHex") {
		t.Fatalf("expected hex error, got: %v", err)
	}
}

func TestHandleRejectsEmptyDefinition(t *testing.T) {
	_, err := handle(context.Background(), EvaluateRequest{
		Definition:       "",
		EncryptionKeyHex: strings.Repeat("00", 32),
	})
	if err == nil {
		t.Fatal("expected error for empty definition, got nil")
	}
	if !strings.Contains(err.Error(), "definition") {
		t.Fatalf("expected definition error, got: %v", err)
	}
}

func TestHandleAcceptsValidInputs(t *testing.T) {
	_, err := handle(context.Background(), EvaluateRequest{
		Definition:       "values:\n  foo: bar\n",
		EncryptionKeyHex: strings.Repeat("00", 32),
	})
	if err == nil {
		t.Fatal("expected 'not implemented' error, got nil")
	}
	if !strings.Contains(err.Error(), "procella-yj7.11") {
		t.Fatalf("expected not-implemented marker referencing the follow-up bead, got: %v", err)
	}
}
