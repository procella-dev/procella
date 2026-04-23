// Procella ESC evaluator Lambda.
//
// Embeds github.com/pulumi/esc as a library. Accepts a pre-resolved
// {definition, imports, encryptionKeyHex} payload — the TS side resolves the
// import graph from PostgreSQL before invoking, so this Lambda never reads
// the DB or the network for imports.
//
// Scaffold only (procella-yj7.3). Real handler (procella-yj7.11) implements
// EnvironmentLoader, ProviderLoader, Decrypter and wires them to
// eval.EvalEnvironment.

package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/aws/aws-lambda-go/lambda"

	// Blank import pins github.com/pulumi/esc in go.mod (required by
	// procella-yj7.11 which swaps this for the real eval.EvalEnvironment).
	_ "github.com/pulumi/esc"
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
const encryptionKeyByteLen = 32

func handle(ctx context.Context, req EvaluateRequest) (EvaluateResponse, error) {
	if req.Definition == "" {
		return EvaluateResponse{}, errors.New("definition is required")
	}
	if len(req.EncryptionKeyHex) != encryptionKeyHexLen {
		return EvaluateResponse{}, fmt.Errorf(
			"encryptionKeyHex must be exactly %d hex characters", encryptionKeyHexLen,
		)
	}
	key, err := hex.DecodeString(req.EncryptionKeyHex)
	if err != nil {
		return EvaluateResponse{}, fmt.Errorf("encryptionKeyHex: %w", err)
	}
	if len(key) != encryptionKeyByteLen {
		return EvaluateResponse{}, fmt.Errorf(
			"encryptionKeyHex must decode to exactly %d bytes", encryptionKeyByteLen,
		)
	}

	return EvaluateResponse{}, errors.New("not implemented — see procella-yj7.11")
}

func main() {
	lambda.Start(handle)
}
