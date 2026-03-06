package updates

import (
	"context"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
)

// NopService is a no-op implementation of Service for phases where updates are not yet supported.
type NopService struct{}

func NewNopService() *NopService {
	return &NopService{}
}

func (s *NopService) CreateUpdate(_ context.Context, _, _, _ string, _ apitype.UpdateKind, _ apitype.UpdateProgramRequest) (*apitype.UpdateProgramResponse, error) {
	return &apitype.UpdateProgramResponse{}, nil
}

func (s *NopService) StartUpdate(_ context.Context, _, _, _, _ string, _ apitype.StartUpdateRequest) (*apitype.StartUpdateResponse, error) {
	return &apitype.StartUpdateResponse{}, nil
}

func (s *NopService) PatchCheckpoint(_ context.Context, _, _, _, _ string, _ apitype.PatchUpdateCheckpointRequest) error {
	return nil
}

func (s *NopService) PatchCheckpointVerbatim(_ context.Context, _, _, _, _ string, _ apitype.PatchUpdateVerbatimCheckpointRequest) error {
	return nil
}

func (s *NopService) RecordEvents(_ context.Context, _, _, _, _ string, _ apitype.EngineEventBatch) error {
	return nil
}

func (s *NopService) RenewLease(_ context.Context, _, _, _, _ string, _ apitype.RenewUpdateLeaseRequest) (*apitype.RenewUpdateLeaseResponse, error) {
	return &apitype.RenewUpdateLeaseResponse{}, nil
}

func (s *NopService) CompleteUpdate(_ context.Context, _, _, _, _ string, _ apitype.CompleteUpdateRequest) error {
	return nil
}

func (s *NopService) ValidateUpdateToken(_ context.Context, _, _, _, _, _ string) error {
	return nil
}

func (s *NopService) ExportStack(_ context.Context, _, _, _ string) (*apitype.UntypedDeployment, error) {
	return nil, nil
}

func (s *NopService) ExportStackVersion(_ context.Context, _, _, _ string, _ int) (*apitype.UntypedDeployment, error) {
	return nil, nil
}

func (s *NopService) ImportStack(_ context.Context, _, _, _ string, _ apitype.UntypedDeployment) (string, error) {
	return "", nil
}

func (s *NopService) GetUpdateStatus(_ context.Context, _, _, _, _ string, _ *string) (*apitype.UpdateResults, error) {
	return &apitype.UpdateResults{Status: apitype.StatusSucceeded}, nil
}

func (s *NopService) CancelUpdate(_ context.Context, _, _, _, _ string) error {
	return nil
}

func (s *NopService) PatchCheckpointDelta(_ context.Context, _, _, _, _ string, _ apitype.PatchUpdateCheckpointDeltaRequest) error {
	return nil
}

func (s *NopService) ListUpdates(_ context.Context, _, _, _ string, _, _ int) ([]apitype.UpdateInfo, error) {
	return []apitype.UpdateInfo{}, nil
}

func (s *NopService) GetLatestUpdate(_ context.Context, _, _, _ string) (*apitype.UpdateInfo, error) {
	return nil, ErrUpdateNotFound
}

func (s *NopService) GetUpdateEvents(_ context.Context, _, _, _, _ string, _ *string) (*apitype.GetUpdateEventsResponse, error) {
	return &apitype.GetUpdateEventsResponse{Events: []apitype.EngineEvent{}}, nil
}
