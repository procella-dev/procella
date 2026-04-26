package main

import (
	"bytes"
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

func TestHandleSurfacesEvalFailureAsResponseNotError(t *testing.T) {
	resp, err := handle(context.Background(), EvaluateRequest{
		Definition:       "values:\n  creds:\n    fn::open::nonexistent:\n      foo: bar\n",
		EncryptionKeyHex: validKey,
	})
	if err != nil {
		t.Fatalf("expected nil error (diagnostics carry failure info), got: %v", err)
	}
	var hasError bool
	for _, d := range resp.Diagnostics {
		if d.Severity == "error" {
			hasError = true
		}
	}
	if !hasError {
		t.Fatal("expected error-severity diagnostic in response")
	}
}

func TestRunStdioMalformedYAML(t *testing.T) {
	req := EvaluateRequest{
		Definition:       "values: [unclosed",
		EncryptionKeyHex: validKey,
	}
	input, _ := json.Marshal(req)

	var out bytes.Buffer
	if err := runStdio(bytes.NewReader(input), &out); err != nil {
		t.Fatalf("runStdio returned error: %v", err)
	}

	// Check for {"error":"..."} shape FIRST — Go's json.Unmarshal would
	// lenient-accept that input into EvaluateResponse (all fields zero),
	// masking the real outcome.
	var errResp struct{ Error string }
	if err := json.Unmarshal(out.Bytes(), &errResp); err == nil && errResp.Error != "" {
		return
	}

	var resp EvaluateResponse
	if err := json.Unmarshal(out.Bytes(), &resp); err != nil {
		t.Fatalf("stdout was not valid JSON response or error shape (raw: %s)", out.String())
	}
	var hasError bool
	for _, d := range resp.Diagnostics {
		if d.Severity == "error" {
			hasError = true
		}
	}
	if !hasError {
		t.Fatalf("expected error diagnostic in response: %+v", resp.Diagnostics)
	}
}

func TestRunStdioSuccess(t *testing.T) {
	req := EvaluateRequest{
		Definition:       "values:\n  foo: bar\n",
		EncryptionKeyHex: validKey,
	}
	input, _ := json.Marshal(req)

	var out bytes.Buffer
	if err := runStdio(bytes.NewReader(input), &out); err != nil {
		t.Fatalf("runStdio returned error: %v", err)
	}

	var resp EvaluateResponse
	if err := json.Unmarshal(out.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v (raw: %s)", err, out.String())
	}
	if resp.Values["foo"] != "bar" {
		t.Errorf("Values.foo = %v, want bar", resp.Values["foo"])
	}
}

func TestRunStdioHandlerError(t *testing.T) {
	req := EvaluateRequest{
		Definition:       "",
		EncryptionKeyHex: validKey,
	}
	input, _ := json.Marshal(req)

	var out bytes.Buffer
	if err := runStdio(bytes.NewReader(input), &out); err != nil {
		t.Fatalf("runStdio returned error: %v", err)
	}

	var errResp struct{ Error string }
	if err := json.Unmarshal(out.Bytes(), &errResp); err != nil {
		t.Fatalf("failed to unmarshal error response: %v (raw: %s)", err, out.String())
	}
	if errResp.Error == "" {
		t.Fatal("expected non-empty error field")
	}
	if !strings.Contains(errResp.Error, "definition") {
		t.Errorf("expected definition error, got: %s", errResp.Error)
	}
}

func TestRunStdioMalformedJSON(t *testing.T) {
	err := runStdio(strings.NewReader("{bad json"), &bytes.Buffer{})
	if err == nil {
		t.Fatal("expected error for malformed JSON input")
	}
	if !strings.Contains(err.Error(), "unmarshal") {
		t.Errorf("expected unmarshal error, got: %v", err)
	}
}
