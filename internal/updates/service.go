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

	// ExportStack returns the latest deployment/state for a stack.
	ExportStack(ctx context.Context, org, project, stack string) (*apitype.UntypedDeployment, error)

	// ExportStackVersion returns a specific version of the deployment/state for a stack.
	ExportStackVersion(ctx context.Context, org, project, stack string, version int) (*apitype.UntypedDeployment, error)

	// ImportStack imports a deployment into the given stack, returning the update ID.
	ImportStack(ctx context.Context, org, project, stack string, deployment apitype.UntypedDeployment) (string, error)

	// GetUpdateStatus returns the current status and events for an update (used for polling after import).
	GetUpdateStatus(ctx context.Context, org, project, stack, updateID string, continuationToken *string) (*apitype.UpdateResults, error)

	// CancelUpdate cancels an active update, releasing the stack lock.
	CancelUpdate(ctx context.Context, org, project, stack, updateID string) error

	// PatchCheckpointDelta applies a delta (textual diff) to the last-saved checkpoint.
	PatchCheckpointDelta(ctx context.Context, org, project, stack, updateID string, req apitype.PatchUpdateCheckpointDeltaRequest) error

	// ListUpdates returns paginated update history for a stack.
	ListUpdates(ctx context.Context, org, project, stack string, page, pageSize int) ([]apitype.UpdateInfo, error)

	// GetLatestUpdate returns the most recent update for a stack.
	GetLatestUpdate(ctx context.Context, org, project, stack string) (*apitype.UpdateInfo, error)

	// GetUpdateEvents returns engine events for an update with continuation token pagination.
	GetUpdateEvents(ctx context.Context, org, project, stack, updateID string, continuationToken *string) (*apitype.GetUpdateEventsResponse, error)
}
