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
	exportStackFn             func(ctx context.Context, org, project, stack string) (*apitype.UntypedDeployment, error)
	exportStackVersionFn      func(ctx context.Context, org, project, stack string, version int) (*apitype.UntypedDeployment, error)
	importStackFn             func(ctx context.Context, org, project, stack string, deployment apitype.UntypedDeployment) (string, error)
	getUpdateStatusFn         func(ctx context.Context, org, project, stack, updateID string, continuationToken *string) (*apitype.UpdateResults, error)
	cancelUpdateFn            func(ctx context.Context, org, project, stack, updateID string) error
	patchCheckpointDeltaFn    func(ctx context.Context, org, project, stack, updateID string, req apitype.PatchUpdateCheckpointDeltaRequest) error
	listUpdatesFn             func(ctx context.Context, org, project, stack string, page, pageSize int) ([]apitype.UpdateInfo, error)
	getLatestUpdateFn         func(ctx context.Context, org, project, stack string) (*apitype.UpdateInfo, error)
	getUpdateEventsFn         func(ctx context.Context, org, project, stack, updateID string, continuationToken *string) (*apitype.GetUpdateEventsResponse, error)
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

func (m *mockUpdateService) ExportStack(ctx context.Context, org, project, stack string) (*apitype.UntypedDeployment, error) {
	if m.exportStackFn != nil {
		return m.exportStackFn(ctx, org, project, stack)
	}
	return nil, nil
}

func (m *mockUpdateService) ExportStackVersion(ctx context.Context, org, project, stack string, version int) (*apitype.UntypedDeployment, error) {
	if m.exportStackVersionFn != nil {
		return m.exportStackVersionFn(ctx, org, project, stack, version)
	}
	return nil, nil
}

func (m *mockUpdateService) ImportStack(ctx context.Context, org, project, stack string, deployment apitype.UntypedDeployment) (string, error) {
	if m.importStackFn != nil {
		return m.importStackFn(ctx, org, project, stack, deployment)
	}
	return "", nil
}

func (m *mockUpdateService) GetUpdateStatus(ctx context.Context, org, project, stack, updateID string, continuationToken *string) (*apitype.UpdateResults, error) {
	if m.getUpdateStatusFn != nil {
		return m.getUpdateStatusFn(ctx, org, project, stack, updateID, continuationToken)
	}
	return nil, nil
}

func (m *mockUpdateService) CancelUpdate(ctx context.Context, org, project, stack, updateID string) error {
	if m.cancelUpdateFn != nil {
		return m.cancelUpdateFn(ctx, org, project, stack, updateID)
	}
	return nil
}

func (m *mockUpdateService) PatchCheckpointDelta(ctx context.Context, org, project, stack, updateID string, req apitype.PatchUpdateCheckpointDeltaRequest) error {
	if m.patchCheckpointDeltaFn != nil {
		return m.patchCheckpointDeltaFn(ctx, org, project, stack, updateID, req)
	}
	return nil
}

func (m *mockUpdateService) ListUpdates(ctx context.Context, org, project, stack string, page, pageSize int) ([]apitype.UpdateInfo, error) {
	if m.listUpdatesFn != nil {
		return m.listUpdatesFn(ctx, org, project, stack, page, pageSize)
	}
	return []apitype.UpdateInfo{}, nil
}

func (m *mockUpdateService) GetLatestUpdate(ctx context.Context, org, project, stack string) (*apitype.UpdateInfo, error) {
	if m.getLatestUpdateFn != nil {
		return m.getLatestUpdateFn(ctx, org, project, stack)
	}
	return nil, updates.ErrUpdateNotFound
}

func (m *mockUpdateService) GetUpdateEvents(ctx context.Context, org, project, stack, updateID string, continuationToken *string) (*apitype.GetUpdateEventsResponse, error) {
	if m.getUpdateEventsFn != nil {
		return m.getUpdateEventsFn(ctx, org, project, stack, updateID, continuationToken)
	}
	return &apitype.GetUpdateEventsResponse{Events: []apitype.EngineEvent{}}, nil
}

func newUpdateTestRouter(svc updates.Service) *chi.Mux {
	h := NewUpdateHandler(svc)
	r := chi.NewRouter()
	r.Get("/api/stacks/{org}/{project}/{stack}/updates/latest", h.GetLatestUpdate)
	r.Get("/api/stacks/{org}/{project}/{stack}/updates", h.ListUpdates)
	r.Get("/api/stacks/{org}/{project}/{stack}/export/{version}", h.ExportStackVersion)
	r.Post("/api/stacks/{org}/{project}/{stack}/import", h.ImportStack)
	r.Get("/api/stacks/{org}/{project}/{stack}/update/{updateID}", h.GetUpdateStatus)
	r.Get("/api/stacks/{org}/{project}/{stack}/update/{updateID}/events", h.GetUpdateEvents)
	r.Post("/api/stacks/{org}/{project}/{stack}/update", h.CreateUpdateFor("update"))
	r.Post("/api/stacks/{org}/{project}/{stack}/preview", h.CreateUpdateFor("preview"))
	r.Post("/api/stacks/{org}/{project}/{stack}/refresh", h.CreateUpdateFor("refresh"))
	r.Post("/api/stacks/{org}/{project}/{stack}/destroy", h.CreateUpdateFor("destroy"))
	r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}", h.StartUpdate)
	r.Patch("/api/stacks/{org}/{project}/{stack}/update/{updateID}/checkpoint", h.PatchCheckpoint)
	r.Patch("/api/stacks/{org}/{project}/{stack}/update/{updateID}/checkpointverbatim", h.PatchCheckpointVerbatim)
	r.Patch("/api/stacks/{org}/{project}/{stack}/update/{updateID}/checkpointdelta", h.PatchCheckpointDelta)
	r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}/events/batch", h.RecordEvents)
	r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}/renew_lease", h.RenewLease)
	r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}/complete", h.CompleteUpdate)
	r.Post("/api/stacks/{org}/{project}/{stack}/update/{updateID}/cancel", h.CancelUpdate)
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

func TestExportStackVersion_Success(t *testing.T) {
	svc := &mockUpdateService{
		exportStackVersionFn: func(_ context.Context, org, project, stack string, version int) (*apitype.UntypedDeployment, error) {
			if org != "test-org" || project != "test-project" || stack != "dev" {
				t.Errorf("unexpected params: org=%s project=%s stack=%s", org, project, stack)
			}
			if version != 3 {
				t.Errorf("expected version 3, got %d", version)
			}
			return &apitype.UntypedDeployment{
				Version:    3,
				Deployment: json.RawMessage(`{"manifest":{}}`),
			}, nil
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/export/3", nil)
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp apitype.UntypedDeployment
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Version != 3 {
		t.Errorf("expected version 3, got %d", resp.Version)
	}
}

func TestExportStackVersion_InvalidVersion(t *testing.T) {
	svc := &mockUpdateService{}
	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/export/abc", nil)
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestExportStackVersion_NotFound(t *testing.T) {
	svc := &mockUpdateService{
		exportStackVersionFn: func(context.Context, string, string, string, int) (*apitype.UntypedDeployment, error) {
			return nil, updates.ErrUpdateNotFound
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/export/99", nil)
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestImportStack_Success(t *testing.T) {
	svc := &mockUpdateService{
		importStackFn: func(_ context.Context, org, project, stack string, dep apitype.UntypedDeployment) (string, error) {
			if org != "test-org" || project != "test-project" || stack != "dev" {
				t.Errorf("unexpected params: org=%s project=%s stack=%s", org, project, stack)
			}
			if dep.Version != 3 {
				t.Errorf("expected deployment version 3, got %d", dep.Version)
			}
			return "import-update-123", nil
		},
	}

	body, _ := json.Marshal(apitype.UntypedDeployment{
		Version:    3,
		Deployment: json.RawMessage(`{"manifest":{},"resources":null}`),
	})
	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/import", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp apitype.ImportStackResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.UpdateID != "import-update-123" {
		t.Errorf("expected updateID import-update-123, got %s", resp.UpdateID)
	}
}

func TestImportStack_Conflict(t *testing.T) {
	svc := &mockUpdateService{
		importStackFn: func(context.Context, string, string, string, apitype.UntypedDeployment) (string, error) {
			return "", updates.ErrUpdateConflict
		},
	}

	body, _ := json.Marshal(apitype.UntypedDeployment{Version: 3, Deployment: json.RawMessage(`{}`)})
	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/import", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestImportStack_StackNotFound(t *testing.T) {
	svc := &mockUpdateService{
		importStackFn: func(context.Context, string, string, string, apitype.UntypedDeployment) (string, error) {
			return "", updates.ErrStackNotFound
		},
	}

	body, _ := json.Marshal(apitype.UntypedDeployment{Version: 3, Deployment: json.RawMessage(`{}`)})
	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/import", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestImportStack_BadJSON(t *testing.T) {
	svc := &mockUpdateService{}
	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/import", bytes.NewReader([]byte("not json")))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestGetUpdateStatus_Success(t *testing.T) {
	svc := &mockUpdateService{
		getUpdateStatusFn: func(_ context.Context, _, _, _, updateID string, ct *string) (*apitype.UpdateResults, error) {
			if updateID != "uid-abc" {
				t.Errorf("expected updateID uid-abc, got %s", updateID)
			}
			if ct != nil {
				t.Errorf("expected nil continuation token, got %s", *ct)
			}
			return &apitype.UpdateResults{
				Status: apitype.StatusSucceeded,
				Events: []apitype.UpdateEvent{},
			}, nil
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/update/uid-abc", nil)
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp apitype.UpdateResults
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Status != apitype.StatusSucceeded {
		t.Errorf("expected status succeeded, got %s", resp.Status)
	}
	if resp.ContinuationToken != nil {
		t.Errorf("expected nil continuation token, got %v", resp.ContinuationToken)
	}
}

func TestGetUpdateStatus_NotFound(t *testing.T) {
	svc := &mockUpdateService{
		getUpdateStatusFn: func(context.Context, string, string, string, string, *string) (*apitype.UpdateResults, error) {
			return nil, updates.ErrUpdateNotFound
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/update/nonexistent", nil)
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestCancelUpdate_Success(t *testing.T) {
	var calledOrg, calledProject, calledStack, calledUpdateID string
	svc := &mockUpdateService{
		cancelUpdateFn: func(_ context.Context, org, project, stack, updateID string) error {
			calledOrg = org
			calledProject = project
			calledStack = stack
			calledUpdateID = updateID
			return nil
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/update/abc-123/cancel", nil)
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if calledOrg != "test-org" || calledProject != "test-project" || calledStack != "dev" || calledUpdateID != "abc-123" {
		t.Fatalf("unexpected params: org=%s project=%s stack=%s updateID=%s", calledOrg, calledProject, calledStack, calledUpdateID)
	}
}

func TestCancelUpdate_NotFound(t *testing.T) {
	svc := &mockUpdateService{
		cancelUpdateFn: func(context.Context, string, string, string, string) error {
			return updates.ErrUpdateNotFound
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/update/abc-123/cancel", nil)
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestCancelUpdate_StackNotFound(t *testing.T) {
	svc := &mockUpdateService{
		cancelUpdateFn: func(context.Context, string, string, string, string) error {
			return updates.ErrStackNotFound
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/stacks/test-org/test-project/dev/update/abc-123/cancel", nil)
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestPatchCheckpointDelta_Success(t *testing.T) {
	svc := &mockUpdateService{
		patchCheckpointDeltaFn: func(_ context.Context, _, _, _, updateID string, req apitype.PatchUpdateCheckpointDeltaRequest) error {
			if updateID != "uid-abc" {
				t.Errorf("expected updateID uid-abc, got %s", updateID)
			}
			if req.SequenceNumber != 2 {
				t.Errorf("expected sequence 2, got %d", req.SequenceNumber)
			}
			if req.CheckpointHash != "abc123" {
				t.Errorf("expected hash abc123, got %s", req.CheckpointHash)
			}
			return nil
		},
	}

	body, _ := json.Marshal(apitype.PatchUpdateCheckpointDeltaRequest{
		Version:         3,
		SequenceNumber:  2,
		CheckpointHash:  "abc123",
		DeploymentDelta: json.RawMessage(`[]`),
	})
	req := httptest.NewRequest(http.MethodPatch, "/api/stacks/test-org/test-project/dev/update/uid-abc/checkpointdelta", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestPatchCheckpointDelta_HashMismatch(t *testing.T) {
	svc := &mockUpdateService{
		patchCheckpointDeltaFn: func(context.Context, string, string, string, string, apitype.PatchUpdateCheckpointDeltaRequest) error {
			return updates.ErrDeltaHashMismatch
		},
	}

	body, _ := json.Marshal(apitype.PatchUpdateCheckpointDeltaRequest{
		Version:         3,
		SequenceNumber:  1,
		CheckpointHash:  "wrong",
		DeploymentDelta: json.RawMessage(`[]`),
	})
	req := httptest.NewRequest(http.MethodPatch, "/api/stacks/test-org/test-project/dev/update/uid-abc/checkpointdelta", bytes.NewReader(body))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestPatchCheckpointDelta_BadJSON(t *testing.T) {
	svc := &mockUpdateService{}
	req := httptest.NewRequest(http.MethodPatch, "/api/stacks/test-org/test-project/dev/update/uid-abc/checkpointdelta", bytes.NewReader([]byte("not json")))
	rr := httptest.NewRecorder()

	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestListUpdates_Empty(t *testing.T) {
	t.Parallel()
	svc := &mockUpdateService{
		listUpdatesFn: func(_ context.Context, _, _, _ string, _, _ int) ([]apitype.UpdateInfo, error) {
			return []apitype.UpdateInfo{}, nil
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/updates", nil)
	rr := httptest.NewRecorder()
	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp apitype.GetHistoryResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Updates) != 0 {
		t.Fatalf("expected 0 updates, got %d", len(resp.Updates))
	}
}

func TestListUpdates_WithResults(t *testing.T) {
	t.Parallel()
	svc := &mockUpdateService{
		listUpdatesFn: func(_ context.Context, _, _, _ string, _, _ int) ([]apitype.UpdateInfo, error) {
			return []apitype.UpdateInfo{
				{Kind: apitype.UpdateUpdate, Version: 1, Result: apitype.SucceededResult},
				{Kind: apitype.PreviewUpdate, Version: 2, Result: apitype.InProgressResult},
			}, nil
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/updates", nil)
	rr := httptest.NewRecorder()
	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp apitype.GetHistoryResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Updates) != 2 {
		t.Fatalf("expected 2 updates, got %d", len(resp.Updates))
	}
	if resp.Updates[0].Kind != apitype.UpdateUpdate {
		t.Fatalf("expected first update kind 'update', got %s", resp.Updates[0].Kind)
	}
}

func TestListUpdates_PaginationParams(t *testing.T) {
	t.Parallel()
	var gotPage, gotPageSize int
	svc := &mockUpdateService{
		listUpdatesFn: func(_ context.Context, _, _, _ string, page, pageSize int) ([]apitype.UpdateInfo, error) {
			gotPage = page
			gotPageSize = pageSize
			return []apitype.UpdateInfo{}, nil
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/updates?page=3&pageSize=25", nil)
	rr := httptest.NewRecorder()
	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if gotPage != 3 {
		t.Fatalf("expected page=3, got %d", gotPage)
	}
	if gotPageSize != 25 {
		t.Fatalf("expected pageSize=25, got %d", gotPageSize)
	}
}

func TestListUpdates_StackNotFound(t *testing.T) {
	t.Parallel()
	svc := &mockUpdateService{
		listUpdatesFn: func(context.Context, string, string, string, int, int) ([]apitype.UpdateInfo, error) {
			return nil, updates.ErrStackNotFound
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/updates", nil)
	rr := httptest.NewRecorder()
	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestGetLatestUpdate_Success(t *testing.T) {
	t.Parallel()
	svc := &mockUpdateService{
		getLatestUpdateFn: func(_ context.Context, _, _, _ string) (*apitype.UpdateInfo, error) {
			return &apitype.UpdateInfo{
				Kind:    apitype.UpdateUpdate,
				Version: 5,
				Result:  apitype.SucceededResult,
				Config:  map[string]apitype.ConfigValue{},
			}, nil
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/updates/latest", nil)
	rr := httptest.NewRecorder()
	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp struct {
		Info apitype.UpdateInfo `json:"info"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Info.Version != 5 {
		t.Fatalf("expected version=5, got %d", resp.Info.Version)
	}
}

func TestGetLatestUpdate_NotFound(t *testing.T) {
	t.Parallel()
	svc := &mockUpdateService{
		getLatestUpdateFn: func(context.Context, string, string, string) (*apitype.UpdateInfo, error) {
			return nil, updates.ErrUpdateNotFound
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/updates/latest", nil)
	rr := httptest.NewRecorder()
	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestGetUpdateEvents_Empty(t *testing.T) {
	t.Parallel()
	svc := &mockUpdateService{
		getUpdateEventsFn: func(_ context.Context, _, _, _, _ string, ct *string) (*apitype.GetUpdateEventsResponse, error) {
			if ct != nil {
				t.Errorf("expected nil continuation token, got %s", *ct)
			}
			return &apitype.GetUpdateEventsResponse{Events: []apitype.EngineEvent{}}, nil
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/update/uid-abc/events", nil)
	rr := httptest.NewRecorder()
	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp apitype.GetUpdateEventsResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(resp.Events))
	}
	if resp.ContinuationToken != nil {
		t.Errorf("expected nil continuation token, got %v", *resp.ContinuationToken)
	}
}

func TestGetUpdateEvents_WithEvents(t *testing.T) {
	t.Parallel()
	svc := &mockUpdateService{
		getUpdateEventsFn: func(_ context.Context, _, _, _, _ string, _ *string) (*apitype.GetUpdateEventsResponse, error) {
			token := "42"
			return &apitype.GetUpdateEventsResponse{
				Events: []apitype.EngineEvent{
					{Sequence: 1, Timestamp: 1000},
					{Sequence: 2, Timestamp: 1001},
				},
				ContinuationToken: &token,
			}, nil
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/update/uid-abc/events", nil)
	rr := httptest.NewRecorder()
	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp apitype.GetUpdateEventsResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(resp.Events))
	}
	if resp.Events[0].Sequence != 1 {
		t.Errorf("expected first event sequence 1, got %d", resp.Events[0].Sequence)
	}
	if resp.ContinuationToken == nil || *resp.ContinuationToken != "42" {
		t.Errorf("expected continuation token '42', got %v", resp.ContinuationToken)
	}
}

func TestGetUpdateEvents_NotFound(t *testing.T) {
	t.Parallel()
	svc := &mockUpdateService{
		getUpdateEventsFn: func(context.Context, string, string, string, string, *string) (*apitype.GetUpdateEventsResponse, error) {
			return nil, updates.ErrUpdateNotFound
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/update/uid-abc/events", nil)
	rr := httptest.NewRecorder()
	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestGetUpdateEvents_WithContinuationToken(t *testing.T) {
	t.Parallel()
	var gotToken *string
	svc := &mockUpdateService{
		getUpdateEventsFn: func(_ context.Context, _, _, _, _ string, ct *string) (*apitype.GetUpdateEventsResponse, error) {
			gotToken = ct
			return &apitype.GetUpdateEventsResponse{Events: []apitype.EngineEvent{}}, nil
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/stacks/test-org/test-project/dev/update/uid-abc/events?continuationToken=100", nil)
	rr := httptest.NewRecorder()
	newUpdateTestRouter(svc).ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if gotToken == nil || *gotToken != "100" {
		t.Fatalf("expected continuation token '100', got %v", gotToken)
	}
}
