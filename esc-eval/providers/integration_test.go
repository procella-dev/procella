//go:build integration

package providers

import (
	"os"
	"testing"
)

func TestProvidersIntegrationPlaceholder(t *testing.T) {
	if os.Getenv("ESC_PROVIDERS_INTEGRATION") != "1" {
		t.Skip("set ESC_PROVIDERS_INTEGRATION=1 to enable provider integration tests; LocalStack/real-AWS fixture wiring is still pending")
	}
	t.Skip("placeholder integration suite: add LocalStack or real AWS fixtures before enabling in CI")
}
