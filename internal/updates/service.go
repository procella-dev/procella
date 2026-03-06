package updates

import (
	"context"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
)

// Service defines the update lifecycle operations.
type Service interface {
	// CreateUpdate creates a new update for the given stack.
	CreateUpdate(ctx context.Context, org, project, stack string, kind apitype.UpdateKind, req apitype.UpdateProgramRequest) (*apitype.UpdateProgramResponse, error)

	// StartUpdate starts a previously created update, returning a lease token.
	StartUpdate(ctx context.Context, org, project, stack, updateID string, req apitype.StartUpdateRequest) (*apitype.StartUpdateResponse, error)

	// PatchCheckpoint stores a checkpoint for an in-progress update.
	PatchCheckpoint(ctx context.Context, org, project, stack, updateID string, req apitype.PatchUpdateCheckpointRequest) error

	// PatchCheckpointVerbatim stores a verbatim checkpoint (preserving exact JSON).
	PatchCheckpointVerbatim(ctx context.Context, org, project, stack, updateID string, req apitype.PatchUpdateVerbatimCheckpointRequest) error

	// RecordEvents stores a batch of engine events.
	RecordEvents(ctx context.Context, org, project, stack, updateID string, batch apitype.EngineEventBatch) error

	// RenewLease extends the lease for an in-progress update.
	RenewLease(ctx context.Context, org, project, stack, updateID string, req apitype.RenewUpdateLeaseRequest) (*apitype.RenewUpdateLeaseResponse, error)

	// CompleteUpdate marks an update as completed.
	CompleteUpdate(ctx context.Context, org, project, stack, updateID string, req apitype.CompleteUpdateRequest) error

	// ValidateUpdateToken validates the lease token for an update.
	ValidateUpdateToken(ctx context.Context, org, project, stack, updateID, token string) error
}
