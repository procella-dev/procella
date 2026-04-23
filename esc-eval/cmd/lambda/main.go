package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strings"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/pulumi/esc"
	"github.com/pulumi/esc/eval"
	"github.com/pulumi/esc/syntax"
)

// EvaluateRequest mirrors the TS EvaluatePayload in packages/esc/src/evaluator-client.ts.
type EvaluateRequest struct {
	Definition       string            `json:"definition"`
	Imports          map[string]string `json:"imports"`
	EncryptionKeyHex string            `json:"encryptionKeyHex"`
}

type EvaluateDiagnostic struct {
	Severity string   `json:"severity"`
	Summary  string   `json:"summary"`
	Path     []string `json:"path,omitempty"`
}

type EvaluateResponse struct {
	Values      map[string]any       `json:"values"`
	Secrets     []string             `json:"secrets"`
	Diagnostics []EvaluateDiagnostic `json:"diagnostics"`
}

// encryptionKeyHexLen is 32 bytes AES-256 key as hex (2 chars per byte).
const encryptionKeyHexLen = 64

func handle(ctx context.Context, req EvaluateRequest) (EvaluateResponse, error) {
	if req.Definition == "" {
		return EvaluateResponse{}, errors.New("definition is required")
	}
	if len(req.EncryptionKeyHex) != encryptionKeyHexLen {
		return EvaluateResponse{}, fmt.Errorf(
			"encryptionKeyHex must be exactly %d hex characters", encryptionKeyHexLen,
		)
	}
	if _, err := hex.DecodeString(req.EncryptionKeyHex); err != nil {
		return EvaluateResponse{}, fmt.Errorf("encryptionKeyHex: %w", err)
	}

	envDecl, parseDiags, err := eval.LoadYAMLBytes("env", []byte(req.Definition))
	if err != nil {
		return EvaluateResponse{}, fmt.Errorf("parse definition: %w", err)
	}
	if envDecl == nil {
		return EvaluateResponse{
			Values:      map[string]any{},
			Secrets:     []string{},
			Diagnostics: convertDiagnostics(parseDiags),
		}, nil
	}

	dec := noopDecrypter{}
	loader := &payloadEnvironmentLoader{imports: req.Imports, decrypter: dec}
	execCtx, err := esc.NewExecContext(map[string]esc.Value{})
	if err != nil {
		return EvaluateResponse{}, fmt.Errorf("exec context: %w", err)
	}

	result, evalDiags := eval.EvalEnvironment(ctx, "env", envDecl, dec, stubProviderLoader{}, loader, execCtx)

	allDiags := make(syntax.Diagnostics, 0, len(parseDiags)+len(evalDiags))
	allDiags = append(allDiags, parseDiags...)
	allDiags = append(allDiags, evalDiags...)

	for _, d := range allDiags {
		if d.Severity == 1 { // hcl.DiagError
			log.Printf("[esc-eval] diag: %s (path=%s)", d.Summary, d.Path)
		}
	}

	if result == nil && allDiags.HasErrors() {
		return EvaluateResponse{
			Values:      map[string]any{},
			Secrets:     []string{},
			Diagnostics: convertDiagnostics(allDiags),
		}, fmt.Errorf("evaluation failed: %s", allDiags.Error())
	}

	values := make(map[string]any)
	var secrets []string
	if result != nil {
		for k, v := range result.Properties {
			values[k] = v.ToJSON(false)
			collectSecretPaths(v, k, &secrets)
		}
	}
	if secrets == nil {
		secrets = []string{}
	}

	return EvaluateResponse{
		Values:      values,
		Secrets:     secrets,
		Diagnostics: convertDiagnostics(allDiags),
	}, nil
}

func convertDiagnostics(diags syntax.Diagnostics) []EvaluateDiagnostic {
	result := make([]EvaluateDiagnostic, 0, len(diags))
	for _, d := range diags {
		severity := "warning"
		if d.Severity == 1 { // hcl.DiagError
			severity = "error"
		}
		diag := EvaluateDiagnostic{
			Severity: severity,
			Summary:  d.Summary,
		}
		if d.Path != "" {
			diag.Path = strings.Split(d.Path, ".")
		}
		result = append(result, diag)
	}
	return result
}

func collectSecretPaths(v esc.Value, prefix string, paths *[]string) {
	if v.Secret {
		*paths = append(*paths, prefix)
	}
	switch inner := v.Value.(type) {
	case map[string]esc.Value:
		for k, child := range inner {
			collectSecretPaths(child, prefix+"."+k, paths)
		}
	case []esc.Value:
		for i, child := range inner {
			collectSecretPaths(child, fmt.Sprintf("%s[%d]", prefix, i), paths)
		}
	}
}

func main() {
	lambda.Start(handle)
}
