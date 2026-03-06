package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"

	"github.com/strata-iac/strata/internal/updates"
)

type mockUpdateService struct {
	createUpdateFn            func(ctx context.Context, org, project, stack string, kind apitype.UpdateKind, req apitype.UpdateProgramRequest) (*apitype.UpdateProgramResponse, error)
	startUpdateFn             func(ctx context.Context, org, project, stack, updateID string, req apitype.StartUpdateRequest) (*apitype.StartUpdateResponse, error)
	patchCheckpointFn         func(ctx context.Context, org, project, stack, updateID string, req apitype.PatchUpdateCheckpointRequest) error
	patchCheckpointVerbatimFn func(ctx context.Context, org, project, stack, updateID string, req apitype.PatchUpdateVerbatimCheckpointRequest) error
	recordEventsFn            func(ctx context.Context, org, project, stack, updateID string, batch apitype.EngineEventBatch) error
	renewLeaseFn              func(ctx context.Context, org, project, stack, updateID string, req apitype.RenewUpdateLeaseRequest) (*apitype.RenewUpdateLeaseResponse, error)
	completeUpdateFn          func(ctx context.Context, org, project, stack, updateID string, req apitype.CompleteUpdateRequest) error
	validateUpdateTokenFn     func(ctx context.Context, org, project, stack, updateID, token string) error
}

func (m *mockUpdateService) CreateUpdate(ctx context.Context, org, project, stack string, kind apitype.UpdateKind, req apitype.UpdateProgramRequest) (*apitype.UpdateProgramResponse, error) {
	return m.createUpdateFn(ctx, org, project, stack, kind, req)
}

func (m *mockUpdateService) StartUpdate(ctx context.Context, org, project, stack, updateID string, req apitype.StartUpdateRequest) (*apitype.StartUpdateResponse, error) {
	return m.startUpdateFn(ctx, org, project, stack, updateID, req)
}

func (m *mockUpdateService) PatchCheckpoint(ctx context.Context, org, project, stack, updateID string, req apitype.PatchUpdateCheckpointRequest) error {
	return m.patchCheckpointFn(ctx, org, project, stack, updateID, req)
}

func (m *mockUpdateService) PatchCheckpointVerbatim(ctx context.Context, org, project, stack, updateID string, req apitype.PatchUpdateVerbatimCheckpointRequest) error {
	return m.patchCheckpointVerbatimFn(ctx, org, project, stack, updateID, req)
}

func (m *mockUpdateService) RecordEvents(ctx context.Context, org, project, stack, updateID string, batch apitype.EngineEventBatch) error {
	return m.recordEventsFn(ctx, org, project, stack, updateID, batch)
}

func (m *mockUpdateService) RenewLease(ctx context.Context, org, project, stack, updateID string, req apitype.RenewUpdateLeaseRequest) (*apitype.RenewUpdateLeaseResponse, error) {
	return m.renewLeaseFn(ctx, org, project, stack, updateID, req)
}

func (m *mockUpdateService) CompleteUpdate(ctx context.Context, org, project, stack, updateID string, req apitype.CompleteUpdateRequest) error {
	return m.completeUpdateFn(ctx, org, project, stack, updateID, req)
}

func (m *mockUpdateService) ValidateUpdateToken(ctx context.Context, org, project, stack, updateID, token string) error {
	return m.validateUpdateTokenFn(ctx, org, project, stack, updateID, token)
}

func newUpdateTestRouter(svc updates.Service) *chi.Mux {
	h := NewUpdateHandler(svc)
	r := chi.NewRouter()
	r.Post("/api/stacks/{org}/{project}/{stack}/update", h.CreateUpdateFor("update"))
	r.Post("/api/stacks/{org}/{project}/{stack}/preview", h.CreateUpdateFor("preview"))
	r.Post("/api/stacks/{org}/{project}/{stack}/refresh", h.CreateUpdateFor("refresh"))
	r.Post("/api/stacks/{org}/{project}/{stack}/destroy", h.CreateUpdateFor("destroy"))
	r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}", h.StartUpdate)
	r.Patch("/api/stacks/{org}/{project}/{stack}/update/{updateID}/checkpoint", h.PatchCheckpoint)
	r.Patch("/api/stacks/{org}/{project}/{stack}/update/{updateID}/checkpointverbatim", h.PatchCheckpointVerbatim)
	r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}/events/batch", h.RecordEvents)
	r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}/renew_lease", h.RenewLease)
	r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}/complete", h.CompleteUpdate)
	return r
}

func TestCreateUpdate_Success(t *testing.T) {
	kinds := []string{"update", "preview", "refresh", "destroy"}

	for _, kind := range kinds {
		t.Run(kind, func(t *testing.T) {
			svc := &mockUpdateService{
				createUpdateFn: func(_ context.Context, org, project, stack string, k apitype.UpdateKind, _ apitype.UpdateProgramRequest) (*apitype.UpdateProgramResponse, error) {
					if org != "test-org" || project != "test-project" || stack != "dev" {
						t.Errorf("unexpected params: org=%s project=%s stack=%s", org, project, stack)
					}
					if string(k) != kind {
						t.Errorf("expected kind %s, got %s", kind, k)
					}
					return &apitype.UpdateProgramResponse{
						UpdateID:         "update-123",
						RequiredPolicies: []apitype.RequiredPolicy{},
					}, nil
				},
			}

			body, _ := json.Marshal(apitype.UpdateProgramRequest{Name: "test-prog"})
			req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/"+kind, bytes.NewReader(body))
			rr := httptest.NewRecorder()

			newUpdateTestRouter(svc).ServeHTTP(rr, req)

			if rr.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
			}

			var resp apitype.UpdateProgramResponse
			if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if resp.UpdateID != "update-123" {
				t.Errorf("expected updateID update-123, got %s", resp.UpdateID)
			}
		})
	}
}

func TestCreateUpdate_Conflict(t *testing.T) {
	svc := &mockUpdateService{
		createUpdateFn: func(context.Context, string, string, string, apitype.UpdateKind, apitype.UpdateProgramRequest) (*apitype.UpdateProgramResponse, error) {
			return nil, updates.ErrUpdateConflict
		},
	}

	body, _ := json.Marshal(apitype.UpdateProgramRequest{Name: "test-prog"})
	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/update", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestCreateUpdate_StackNotFound(t *testing.T) {
	svc := &mockUpdateService{
		createUpdateFn: func(context.Context, string, string, string, apitype.UpdateKind, apitype.UpdateProgramRequest) (*apitype.UpdateProgramResponse, error) {
			return nil, updates.ErrStackNotFound
		},
	}

	body, _ := json.Marshal(apitype.UpdateProgramRequest{Name: "test-prog"})
	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/update", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestStartUpdate_Success(t *testing.T) {
	svc := &mockUpdateService{
		startUpdateFn: func(_ context.Context, _, _, _, updateID string, _ apitype.StartUpdateRequest) (*apitype.StartUpdateResponse, error) {
			if updateID != "uid-abc" {
				t.Errorf("expected updateID uid-abc, got %s", updateID)
			}
			return &apitype.StartUpdateResponse{
				Version:         1,
				Token:           "lease-token-xyz",
				TokenExpiration: 1700000000,
			}, nil
		},
	}

	body, _ := json.Marshal(apitype.StartUpdateRequest{})
	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/update/uid-abc", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp apitype.StartUpdateResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Token != "lease-token-xyz" {
		t.Errorf("expected token lease-token-xyz, got %s", resp.Token)
	}
	if resp.Version != 1 {
		t.Errorf("expected version 1, got %d", resp.Version)
	}
}

func TestStartUpdate_NotFound(t *testing.T) {
	svc := &mockUpdateService{
		startUpdateFn: func(context.Context, string, string, string, string, apitype.StartUpdateRequest) (*apitype.StartUpdateResponse, error) {
			return nil, updates.ErrUpdateNotFound
		},
	}

	body, _ := json.Marshal(apitype.StartUpdateRequest{})
	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/update/nonexistent", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestPatchCheckpoint_Success(t *testing.T) {
	svc := &mockUpdateService{
		patchCheckpointFn: func(_ context.Context, _, _, _, updateID string, req apitype.PatchUpdateCheckpointRequest) error {
			if updateID != "uid-abc" {
				t.Errorf("expected updateID uid-abc, got %s", updateID)
			}
			if req.Version != 3 {
				t.Errorf("expected version 3, got %d", req.Version)
			}
			return nil
		},
	}

	body, _ := json.Marshal(apitype.PatchUpdateCheckpointRequest{Version: 3, Deployment: json.RawMessage(`{}`)})
	req := httptest.NewRequest(http.MethodPatch, "/api/stacks/test-org/test-project/dev/update/uid-abc/checkpoint", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestPatchCheckpointVerbatim_Success(t *testing.T) {
	svc := &mockUpdateService{
		patchCheckpointVerbatimFn: func(_ context.Context, _, _, _, _ string, req apitype.PatchUpdateVerbatimCheckpointRequest) error {
			if req.SequenceNumber != 5 {
				t.Errorf("expected sequence 5, got %d", req.SequenceNumber)
			}
			return nil
		},
	}

	body, _ := json.Marshal(apitype.PatchUpdateVerbatimCheckpointRequest{
		Version:           3,
		UntypedDeployment: json.RawMessage(`{}`),
		SequenceNumber:    5,
	})
	req := httptest.NewRequest(http.MethodPatch, "/api/stacks/test-org/test-project/dev/update/uid-abc/checkpointverbatim", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestRecordEvents_Success(t *testing.T) {
	svc := &mockUpdateService{
		recordEventsFn: func(_ context.Context, _, _, _, _ string, batch apitype.EngineEventBatch) error {
			if len(batch.Events) != 2 {
				t.Errorf("expected 2 events, got %d", len(batch.Events))
			}
			return nil
		},
	}

	body, _ := json.Marshal(apitype.EngineEventBatch{
		Events: []apitype.EngineEvent{
			{Sequence: 1, Timestamp: 1000},
			{Sequence: 2, Timestamp: 1001},
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/update/uid-abc/events/batch", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestRenewLease_Success(t *testing.T) {
	svc := &mockUpdateService{
		renewLeaseFn: func(_ context.Context, _, _, _, _ string, req apitype.RenewUpdateLeaseRequest) (*apitype.RenewUpdateLeaseResponse, error) {
			if req.Duration != 300 {
				t.Errorf("expected duration 300, got %d", req.Duration)
			}
			return &apitype.RenewUpdateLeaseResponse{
				Token:           "new-token",
				TokenExpiration: 1700000300,
			}, nil
		},
	}

	body, _ := json.Marshal(apitype.RenewUpdateLeaseRequest{Duration: 300})
	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/update/uid-abc/renew_lease", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp apitype.RenewUpdateLeaseResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Token != "new-token" {
		t.Errorf("expected token new-token, got %s", resp.Token)
	}
}

func TestCompleteUpdate_Success(t *testing.T) {
	svc := &mockUpdateService{
		completeUpdateFn: func(_ context.Context, _, _, _, updateID string, req apitype.CompleteUpdateRequest) error {
			if updateID != "uid-abc" {
				t.Errorf("expected updateID uid-abc, got %s", updateID)
			}
			if req.Status != apitype.UpdateStatusSucceeded {
				t.Errorf("expected status succeeded, got %s", req.Status)
			}
			return nil
		},
	}

	body, _ := json.Marshal(apitype.CompleteUpdateRequest{Status: apitype.UpdateStatusSucceeded})
	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/update/uid-abc/complete", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestCompleteUpdate_NotFound(t *testing.T) {
	svc := &mockUpdateService{
		completeUpdateFn: func(context.Context, string, string, string, string, apitype.CompleteUpdateRequest) error {
			return updates.ErrUpdateNotFound
		},
	}

	body, _ := json.Marshal(apitype.CompleteUpdateRequest{Status: apitype.UpdateStatusFailed})
	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/update/uid-abc/complete", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}
