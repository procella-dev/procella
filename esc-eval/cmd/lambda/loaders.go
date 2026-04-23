package main

import (
	"context"
	"fmt"

	"github.com/pulumi/esc"
	"github.com/pulumi/esc/eval"
)

// payloadEnvironmentLoader reads env bodies from the in-memory imports map.
// Never reads DB or network — the TS side pre-resolves the import graph.
type payloadEnvironmentLoader struct {
	imports   map[string]string
	decrypter eval.Decrypter
}

func (l *payloadEnvironmentLoader) LoadEnvironment(_ context.Context, name string) ([]byte, eval.Decrypter, error) {
	body, ok := l.imports[name]
	if !ok {
		return nil, nil, fmt.Errorf("environment %q not found in payload imports", name)
	}
	return []byte(body), l.decrypter, nil
}

// stubProviderLoader — LoadProvider/LoadRotator return descriptive errors.
// Real providers (fn::open::aws-login etc.) land in procella-yj7.17-21.
type stubProviderLoader struct{}

func (stubProviderLoader) LoadProvider(_ context.Context, name string) (esc.Provider, error) {
	return nil, fmt.Errorf("provider %q: unknown (real providers land in procella-yj7.17-21)", name)
}

func (stubProviderLoader) LoadRotator(_ context.Context, name string) (esc.Rotator, error) {
	return nil, fmt.Errorf("rotator %q: unknown (real providers land in procella-yj7.17-21)", name)
}

// noopDecrypter returns ciphertext unchanged. P2 doesn't decrypt user secrets
// in-transit; the TS side decrypts at rest before invoking.
type noopDecrypter struct{}

func (noopDecrypter) Decrypt(_ context.Context, value []byte) ([]byte, error) {
	return value, nil
}
