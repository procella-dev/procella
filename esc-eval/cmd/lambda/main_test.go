package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

var validKey = strings.Repeat("00", 32)

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
		EncryptionKeyHex: validKey,
	})
	if err == nil {
		t.Fatal("expected error for empty definition, got nil")
	}
	if !strings.Contains(err.Error(), "definition") {
		t.Fatalf("expected definition error, got: %v", err)
	}
}

func TestHandleAcceptsValidInputs(t *testing.T) {
	resp, err := handle(context.Background(), EvaluateRequest{
		Definition:       "values:\n  foo: bar\n",
		EncryptionKeyHex: validKey,
	})
	if err != nil {
		t.Fatalf("expected success, got error: %v", err)
	}
	if resp.Values["foo"] != "bar" {
		t.Errorf("Values.foo = %v, want bar", resp.Values["foo"])
	}
}

func TestHandleEvaluatesStaticValues(t *testing.T) {
	resp, err := handle(context.Background(), EvaluateRequest{
		Definition:       "values:\n  foo: bar\n  baz: 42\n",
		EncryptionKeyHex: validKey,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Values["foo"] != "bar" {
		t.Errorf("Values.foo = %v (%T), want string bar", resp.Values["foo"], resp.Values["foo"])
	}
	bazJSON, _ := json.Marshal(resp.Values["baz"])
	if string(bazJSON) != "42" {
		t.Errorf("Values.baz JSON = %s, want 42", bazJSON)
	}
	if len(resp.Secrets) != 0 {
		t.Errorf("Secrets = %v, want empty", resp.Secrets)
	}
	if len(resp.Diagnostics) != 0 {
		t.Errorf("Diagnostics = %v, want empty", resp.Diagnostics)
	}
}

func TestHandleEvaluatesInterpolation(t *testing.T) {
	resp, err := handle(context.Background(), EvaluateRequest{
		Definition:       "values:\n  a: 1\n  b: \"${a}-x\"\n",
		EncryptionKeyHex: validKey,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	bJSON, _ := json.Marshal(resp.Values["b"])
	if string(bJSON) != `"1-x"` {
		t.Errorf("Values.b JSON = %s, want \"1-x\"", bJSON)
	}
}

func TestHandleResolvesImports(t *testing.T) {
	resp, err := handle(context.Background(), EvaluateRequest{
		Definition:       "imports:\n  - shared\nvalues:\n  inherited: ${key}\n",
		Imports:          map[string]string{"shared": "values:\n  key: hello\n"},
		EncryptionKeyHex: validKey,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	inheritedJSON, _ := json.Marshal(resp.Values["inherited"])
	if string(inheritedJSON) != `"hello"` {
		t.Errorf("Values.inherited JSON = %s, want \"hello\"", inheritedJSON)
	}
}

func TestHandleDiagnosticsForUnknownProvider(t *testing.T) {
	resp, _ := handle(context.Background(), EvaluateRequest{
		Definition:       "values:\n  creds:\n    fn::open::aws-login:\n      region: us-east-1\n",
		EncryptionKeyHex: validKey,
	})
	if len(resp.Diagnostics) == 0 {
		t.Fatal("expected at least one diagnostic for unknown provider")
	}
	var hasError bool
	for _, d := range resp.Diagnostics {
		if d.Severity == "error" {
			hasError = true
		}
	}
	if !hasError {
		t.Fatalf("expected error-severity diagnostic, got: %+v", resp.Diagnostics)
	}
}

func TestHandleRejectsMalformedYAML(t *testing.T) {
	resp, err := handle(context.Background(), EvaluateRequest{
		Definition:       "values: [unclosed",
		EncryptionKeyHex: validKey,
	})
	if err != nil {
		return
	}
	var hasError bool
	for _, d := range resp.Diagnostics {
		if d.Severity == "error" {
			hasError = true
		}
	}
	if !hasError {
		t.Fatal("expected error or error-severity diagnostic for malformed YAML")
	}
}
