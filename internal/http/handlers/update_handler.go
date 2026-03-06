package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

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

// ExportStack handles GET /api/stacks/{org}/{project}/{stack}/export.
func (h *UpdateHandler) ExportStack(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")

	deployment, err := h.updates.ExportStack(r.Context(), org, project, stack)
	if err != nil {
		h.writeUpdateError(w, err)
		return
	}

	encode.WriteJSON(w, http.StatusOK, deployment)
}

func (h *UpdateHandler) ExportStackVersion(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")
	versionStr := chi.URLParam(r, "version")

	version, err := strconv.Atoi(versionStr)
	if err != nil {
		encode.WriteError(w, http.StatusBadRequest, "Bad Request: invalid version")
		return
	}

	deployment, err := h.updates.ExportStackVersion(r.Context(), org, project, stack, version)
	if err != nil {
		h.writeUpdateError(w, err)
		return
	}

	encode.WriteJSON(w, http.StatusOK, deployment)
}

func (h *UpdateHandler) ImportStack(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")

	var req apitype.UntypedDeployment
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		encode.WriteError(w, http.StatusBadRequest, "Bad Request: invalid JSON body")
		return
	}

	updateID, err := h.updates.ImportStack(r.Context(), org, project, stack, req)
	if err != nil {
		h.writeUpdateError(w, err)
		return
	}

	encode.WriteJSON(w, http.StatusOK, apitype.ImportStackResponse{UpdateID: updateID})
}

func (h *UpdateHandler) GetUpdateStatus(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")
	updateID := chi.URLParam(r, "updateID")

	var continuationToken *string
	if ct := r.URL.Query().Get("continuationToken"); ct != "" {
		continuationToken = &ct
	}

	results, err := h.updates.GetUpdateStatus(r.Context(), org, project, stack, updateID, continuationToken)
	if err != nil {
		h.writeUpdateError(w, err)
		return
	}

	encode.WriteJSON(w, http.StatusOK, results)
}

// PatchCheckpointDelta handles PATCH .../checkpointdelta.
func (h *UpdateHandler) PatchCheckpointDelta(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")
	updateID := chi.URLParam(r, "updateID")

	var req apitype.PatchUpdateCheckpointDeltaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		encode.WriteError(w, http.StatusBadRequest, "Bad Request: invalid JSON body")
		return
	}

	if err := h.updates.PatchCheckpointDelta(r.Context(), org, project, stack, updateID, req); err != nil {
		h.writeUpdateError(w, err)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (h *UpdateHandler) ListUpdates(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")

	page := 1
	if p := r.URL.Query().Get("page"); p != "" {
		if parsed, err := strconv.Atoi(p); err == nil && parsed > 0 {
			page = parsed
		}
	}

	pageSize := 10
	if ps := r.URL.Query().Get("pageSize"); ps != "" {
		if parsed, err := strconv.Atoi(ps); err == nil && parsed > 0 {
			pageSize = parsed
		}
	}

	infos, err := h.updates.ListUpdates(r.Context(), org, project, stack, page, pageSize)
	if err != nil {
		h.writeUpdateError(w, err)
		return
	}

	encode.WriteJSON(w, http.StatusOK, apitype.GetHistoryResponse{Updates: infos})
}

func (h *UpdateHandler) GetLatestUpdate(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")

	info, err := h.updates.GetLatestUpdate(r.Context(), org, project, stack)
	if err != nil {
		h.writeUpdateError(w, err)
		return
	}

	encode.WriteJSON(w, http.StatusOK, struct {
		Info apitype.UpdateInfo `json:"info"`
	}{Info: *info})
}

func (h *UpdateHandler) GetUpdateEvents(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")
	updateID := chi.URLParam(r, "updateID")

	var continuationToken *string
	if ct := r.URL.Query().Get("continuationToken"); ct != "" {
		continuationToken = &ct
	}

	resp, err := h.updates.GetUpdateEvents(r.Context(), org, project, stack, updateID, continuationToken)
	if err != nil {
		h.writeUpdateError(w, err)
		return
	}

	encode.WriteJSON(w, http.StatusOK, resp)
}

func (h *UpdateHandler) CancelUpdate(w http.ResponseWriter, r *http.Request) {
	org := chi.URLParam(r, "org")
	project := chi.URLParam(r, "project")
	stack := chi.URLParam(r, "stack")
	updateID := chi.URLParam(r, "updateID")

	if err := h.updates.CancelUpdate(r.Context(), org, project, stack, updateID); err != nil {
		h.writeUpdateError(w, err)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (h *UpdateHandler) writeUpdateError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, updates.ErrUpdateNotFound), errors.Is(err, updates.ErrStackNotFound):
		encode.WriteError(w, http.StatusNotFound, "Not Found")
	case errors.Is(err, updates.ErrUpdateConflict), errors.Is(err, updates.ErrDeltaHashMismatch):
		encode.WriteError(w, http.StatusConflict, err.Error())
	case errors.Is(err, updates.ErrInvalidToken), errors.Is(err, updates.ErrLeaseExpired):
		encode.WriteError(w, http.StatusUnauthorized, err.Error())
	default:
		encode.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
	}
}
