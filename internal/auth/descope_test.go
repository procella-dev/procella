package auth

import (
	"context"
	"os"
	"testing"

	"github.com/descope/go-sdk/descope"
)

func testToken(id string, claims map[string]any) *descope.Token {
	return &descope.Token{ID: id, Claims: claims}
}

func TestCallerFromDescopeToken_SingleTenantAdmin(t *testing.T) {
	token := testToken("user-1", map[string]any{
		"email": "alice@acme.com",
		"name":  "Alice",
		"sub":   "user-1",
		"tenants": map[string]any{
			"org-acme": map[string]any{
				"roles": []any{"admin"},
			},
		},
	})

	caller := callerFromDescopeToken(token)

	assertEqual(t, "user-1", caller.UserID)
	assertEqual(t, "alice@acme.com", caller.GithubLogin)
	assertEqual(t, "Alice", caller.DisplayName)
	assertEqual(t, "alice@acme.com", caller.Email)
	assertEqual(t, "org-acme", caller.OrgLogin)

	if len(caller.OrgMemberships) != 1 {
		t.Fatalf("expected 1 org membership, got %d", len(caller.OrgMemberships))
	}
	assertEqual(t, "org-acme", caller.OrgMemberships[0].OrgLogin)
	assertEqual(t, string(RoleAdmin), string(caller.OrgMemberships[0].Role))
}

func TestCallerFromDescopeToken_MultiTenant(t *testing.T) {
	token := testToken("user-2", map[string]any{
		"email": "bob@example.com",
		"name":  "Bob",
		"tenants": map[string]any{
			"org-alpha": map[string]any{
				"roles": []any{"admin"},
			},
			"org-beta": map[string]any{
				"roles": []any{"viewer"},
			},
		},
	})

	caller := callerFromDescopeToken(token)

	if len(caller.OrgMemberships) != 2 {
		t.Fatalf("expected 2 org memberships, got %d", len(caller.OrgMemberships))
	}

	roleByOrg := make(map[string]Role)
	for _, m := range caller.OrgMemberships {
		roleByOrg[m.OrgLogin] = m.Role
	}

	if roleByOrg["org-alpha"] != RoleAdmin {
		t.Errorf("org-alpha: expected admin, got %s", roleByOrg["org-alpha"])
	}
	if roleByOrg["org-beta"] != RoleViewer {
		t.Errorf("org-beta: expected viewer, got %s", roleByOrg["org-beta"])
	}
}

func TestCallerFromDescopeToken_NoTenants(t *testing.T) {
	token := testToken("user-3", map[string]any{
		"email": "solo@example.com",
	})

	caller := callerFromDescopeToken(token)

	if len(caller.OrgMemberships) != 0 {
		t.Fatalf("expected 0 org memberships, got %d", len(caller.OrgMemberships))
	}
	if caller.OrgLogin != "" {
		t.Errorf("expected empty OrgLogin, got %q", caller.OrgLogin)
	}
}

func TestCallerFromDescopeToken_FallbackLogin(t *testing.T) {
	tests := []struct {
		name          string
		claims        map[string]any
		tokenID       string
		expectedLogin string
	}{
		{
			name:          "email first",
			claims:        map[string]any{"email": "a@b.com", "name": "Name", "sub": "sub-1"},
			expectedLogin: "a@b.com",
		},
		{
			name:          "name when no email",
			claims:        map[string]any{"name": "Name", "sub": "sub-1"},
			expectedLogin: "Name",
		},
		{
			name:          "sub when no email or name",
			claims:        map[string]any{"sub": "sub-1"},
			expectedLogin: "sub-1",
		},
		{
			name:          "token ID when no claims",
			claims:        map[string]any{},
			tokenID:       "tok-fallback",
			expectedLogin: "tok-fallback",
		},
		{
			name:          "hardcoded fallback",
			claims:        map[string]any{},
			tokenID:       "",
			expectedLogin: "descope-user",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			token := testToken(tt.tokenID, tt.claims)
			caller := callerFromDescopeToken(token)
			assertEqual(t, tt.expectedLogin, caller.GithubLogin)
		})
	}
}

func TestHighestTenantRole(t *testing.T) {
	tests := []struct {
		name     string
		roles    any
		expected Role
	}{
		{"admin wins", []any{"viewer", "admin"}, RoleAdmin},
		{"member without admin", []any{"viewer", "member"}, RoleMember},
		{"viewer only", []any{"viewer"}, RoleViewer},
		{"empty roles", []any{}, RoleViewer},
		{"nil roles", nil, RoleViewer},
		{"admin short-circuits", []any{"admin", "viewer"}, RoleAdmin},
		{"unknown role ignored", []any{"superuser"}, RoleViewer},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tenantClaims := map[string]any{}
			if tt.roles != nil {
				tenantClaims["roles"] = tt.roles
			}
			token := testToken("u", map[string]any{
				"tenants": map[string]any{
					"org": tenantClaims,
				},
			})
			got := highestTenantRole(token, "org")
			if got != tt.expected {
				t.Errorf("expected %s, got %s", tt.expected, got)
			}
		})
	}
}

type mockDescopeAuth struct {
	exchangeFn func(ctx context.Context, accessKey string) (bool, *descope.Token, error)
}

func (m *mockDescopeAuth) ExchangeAccessKey(ctx context.Context, accessKey string, _ *descope.AccessKeyLoginOptions) (bool, *descope.Token, error) {
	return m.exchangeFn(ctx, accessKey)
}

func TestDescopeAuthenticator_ValidToken(t *testing.T) {
	mock := &mockDescopeAuth{
		exchangeFn: func(_ context.Context, accessKey string) (bool, *descope.Token, error) {
			assertEqual(t, "my-secret-key", accessKey)
			return true, testToken("user-1", map[string]any{
				"email": "test@acme.com",
				"tenants": map[string]any{
					"acme": map[string]any{"roles": []any{"admin"}},
				},
			}), nil
		},
	}

	auth := NewDescopeAuthenticatorFrom(mock)
	caller, err := auth.ValidateToken(context.Background(), "token my-secret-key")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	assertEqual(t, "test@acme.com", caller.GithubLogin)
	assertEqual(t, "acme", caller.OrgLogin)
	if !caller.HasOrgRole("acme", RoleAdmin) {
		t.Error("expected admin role for acme")
	}
}

func TestDescopeAuthenticator_InvalidKey(t *testing.T) {
	mock := &mockDescopeAuth{
		exchangeFn: func(_ context.Context, _ string) (bool, *descope.Token, error) {
			return false, nil, descope.ErrInvalidArguments
		},
	}

	auth := NewDescopeAuthenticatorFrom(mock)
	_, err := auth.ValidateToken(context.Background(), "token bad-key")
	if err == nil {
		t.Fatal("expected error for invalid key")
	}
}

func TestDescopeAuthenticator_BadScheme(t *testing.T) {
	auth := NewDescopeAuthenticatorFrom(&mockDescopeAuth{})
	_, err := auth.ValidateToken(context.Background(), "Bearer some-jwt")
	if err == nil {
		t.Fatal("expected error for wrong scheme")
	}
}

func TestDescopeAuthenticator_EmptyToken(t *testing.T) {
	auth := NewDescopeAuthenticatorFrom(&mockDescopeAuth{})
	_, err := auth.ValidateToken(context.Background(), "token ")
	if err == nil {
		t.Fatal("expected error for empty token")
	}
}

func TestDescopeIntegration(t *testing.T) {
	projectID := os.Getenv("STRATA_DESCOPE_PROJECT_ID")
	accessKey := os.Getenv("STRATA_DESCOPE_ACCESS_KEY")
	if projectID == "" || accessKey == "" {
		t.Skip("STRATA_DESCOPE_PROJECT_ID and STRATA_DESCOPE_ACCESS_KEY required")
	}

	auth, err := NewDescopeAuthenticator(projectID)
	if err != nil {
		t.Fatalf("create authenticator: %v", err)
	}

	caller, err := auth.ValidateToken(context.Background(), "token "+accessKey)
	if err != nil {
		t.Fatalf("validate token: %v", err)
	}

	if caller.UserID == "" {
		t.Error("expected non-empty UserID")
	}
	if caller.GithubLogin == "" {
		t.Error("expected non-empty GithubLogin")
	}
	if len(caller.OrgMemberships) == 0 {
		t.Error("expected at least one org membership")
	}

	t.Logf("authenticated as %s (%s), orgs: %v", caller.GithubLogin, caller.UserID, caller.OrgLogins())
	for _, m := range caller.OrgMemberships {
		t.Logf("  tenant %s: role=%s", m.OrgLogin, m.Role)
	}
}

func assertEqual(t *testing.T, expected, got string) {
	t.Helper()
	if expected != got {
		t.Errorf("expected %q, got %q", expected, got)
	}
}
