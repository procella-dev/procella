package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"

	"github.com/strata-iac/strata/internal/http/encode"
	"github.com/strata-iac/strata/internal/updates"
)

// UpdateHandler handles update lifecycle HTTP endpoints.
type UpdateHandler struct {
	updates updates.Service
}

// NewUpdateHandler creates a new UpdateHandler.
func NewUpdateHandler(svc updates.Service) *UpdateHandler {
	return &UpdateHandler{updates: svc}
}

// CreateUpdateFor returns a handler that creates an update of the given kind.
func (h *UpdateHandler) CreateUpdateFor(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		org := chi.URLParam(r, "org")
		project := chi.URLParam(r, "project")
		stack := chi.URLParam(r, "stack")

		var req apitype.UpdateProgramRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			encode.WriteError(w, http.StatusBadRequest, "Bad Request: invalid JSON body")
			return
		}

		resp, err := h.updates.CreateUpdate(r.Context(), org, project, stack, apitype.UpdateKind(kind), req)
		if err != nil {
			h.writeUpdateError(w, err)
			return
		}

		encode.WriteJSON(w, http.StatusOK, resp)
	}
}

// StartUpdate handles POST /api/stacks/{org}/{project}/{stack}/update/{updateID}.
func (h *UpdateHandler) StartUpdate(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")
	updateID := chi.URLParam(r, "updateID")

	var req apitype.StartUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		encode.WriteError(w, http.StatusBadRequest, "Bad Request: invalid JSON body")
		return
	}

	resp, err := h.updates.StartUpdate(r.Context(), org, project, stack, updateID, req)
	if err != nil {
		h.writeUpdateError(w, err)
		return
	}

	encode.WriteJSON(w, http.StatusOK, resp)
}

// PatchCheckpoint handles PATCH /api/stacks/{org}/{project}/{stack}/update/{updateID}/checkpoint.
func (h *UpdateHandler) PatchCheckpoint(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")
	updateID := chi.URLParam(r, "updateID")

	var req apitype.PatchUpdateCheckpointRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		encode.WriteError(w, http.StatusBadRequest, "Bad Request: invalid JSON body")
		return
	}

	if err := h.updates.PatchCheckpoint(r.Context(), org, project, stack, updateID, req); err != nil {
		h.writeUpdateError(w, err)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// PatchCheckpointVerbatim handles PATCH .../checkpointverbatim.
func (h *UpdateHandler) PatchCheckpointVerbatim(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")
	updateID := chi.URLParam(r, "updateID")

	var req apitype.PatchUpdateVerbatimCheckpointRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		encode.WriteError(w, http.StatusBadRequest, "Bad Request: invalid JSON body")
		return
	}

	if err := h.updates.PatchCheckpointVerbatim(r.Context(), org, project, stack, updateID, req); err != nil {
		h.writeUpdateError(w, err)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// RecordEvents handles POST .../events/batch.
func (h *UpdateHandler) RecordEvents(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")
	updateID := chi.URLParam(r, "updateID")

	var batch apitype.EngineEventBatch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		encode.WriteError(w, http.StatusBadRequest, "Bad Request: invalid JSON body")
		return
	}

	if err := h.updates.RecordEvents(r.Context(), org, project, stack, updateID, batch); err != nil {
		h.writeUpdateError(w, err)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// RenewLease handles POST .../renew_lease.
func (h *UpdateHandler) RenewLease(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")
	updateID := chi.URLParam(r, "updateID")

	var req apitype.RenewUpdateLeaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		encode.WriteError(w, http.StatusBadRequest, "Bad Request: invalid JSON body")
		return
	}

	resp, err := h.updates.RenewLease(r.Context(), org, project, stack, updateID, req)
	if err != nil {
		h.writeUpdateError(w, err)
		return
	}

	encode.WriteJSON(w, http.StatusOK, resp)
}

// CompleteUpdate handles POST .../complete.
func (h *UpdateHandler) CompleteUpdate(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")
	updateID := chi.URLParam(r, "updateID")

	var req apitype.CompleteUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		encode.WriteError(w, http.StatusBadRequest, "Bad Request: invalid JSON body")
		return
	}

	if err := h.updates.CompleteUpdate(r.Context(), org, project, stack, updateID, req); err != nil {
		h.writeUpdateError(w, err)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (h *UpdateHandler) writeUpdateError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, updates.ErrUpdateNotFound), errors.Is(err, updates.ErrStackNotFound):
		encode.WriteError(w, http.StatusNotFound, "Not Found")
	case errors.Is(err, updates.ErrUpdateConflict):
		encode.WriteError(w, http.StatusConflict, err.Error())
	case errors.Is(err, updates.ErrInvalidToken), errors.Is(err, updates.ErrLeaseExpired):
		encode.WriteError(w, http.StatusUnauthorized, err.Error())
	default:
		encode.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
	}
}
