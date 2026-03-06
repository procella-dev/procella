package middleware

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/strata-iac/strata/internal/http/encode"
	"github.com/strata-iac/strata/internal/updates"
)

// UpdateAuth returns middleware that validates the update-token Authorization header
// for execution-phase requests (checkpoint, events, renew_lease, complete).
func UpdateAuth(svc updates.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				encode.WriteError(w, http.StatusUnauthorized, "Unauthorized: missing Authorization header")
				return
			}

			const scheme = "update-token "
			if !strings.HasPrefix(authHeader, scheme) {
				encode.WriteError(w, http.StatusUnauthorized, "Unauthorized: invalid authorization scheme")
				return
			}

			token := strings.TrimPrefix(authHeader, scheme)
			if token == "" {
				encode.WriteError(w, http.StatusUnauthorized, "Unauthorized: missing update token")
				return
			}

			org := chi.URLParam(r, "org")
			project := chi.URLParam(r, "project")
			stack := chi.URLParam(r, "stack")
			updateID := chi.URLParam(r, "updateID")

			if err := svc.ValidateUpdateToken(r.Context(), org, project, stack, updateID, token); err != nil {
				encode.WriteError(w, http.StatusUnauthorized, "Unauthorized: "+err.Error())
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
