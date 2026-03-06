package updates

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
)

const (
	defaultLeaseDuration = 300 // seconds
	maxLeaseDuration     = 300 // seconds
)

// PostgresService implements the update lifecycle backed by PostgreSQL.
type PostgresService struct {
	db *pgxpool.Pool
}

// NewPostgresService creates a new PostgreSQL-backed update service.
func NewPostgresService(db *pgxpool.Pool) *PostgresService {
	return &PostgresService{db: db}
}

func (s *PostgresService) CreateUpdate(ctx context.Context, org, project, stack string, kind apitype.UpdateKind, req apitype.UpdateProgramRequest) (*apitype.UpdateProgramResponse, error) {
	// Find the stack.
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return nil, err
	}

	configJSON, err := json.Marshal(req.Config)
	if err != nil {
		return nil, fmt.Errorf("marshal config: %w", err)
	}

	metadataJSON, err := json.Marshal(req.Metadata)
	if err != nil {
		return nil, fmt.Errorf("marshal metadata: %w", err)
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin create update transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Check for active updates.
	var activeCount int
	err = tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM updates
		WHERE stack_id = $1 AND status IN ('not started', 'requested', 'running')
	`, stackID).Scan(&activeCount)
	if err != nil {
		return nil, fmt.Errorf("check active updates: %w", err)
	}
	if activeCount > 0 {
		return nil, ErrUpdateConflict
	}

	var updateID string
	err = tx.QueryRow(ctx, `
		INSERT INTO updates (stack_id, kind, status, program_name, program_runtime, program_main, program_description, config, metadata)
		VALUES ($1, $2, 'not started', $3, $4, $5, $6, $7, $8)
		RETURNING id::text
	`, stackID, string(kind), req.Name, req.Runtime, req.Main, req.Description, configJSON, metadataJSON).Scan(&updateID)
	if err != nil {
		return nil, fmt.Errorf("insert update: %w", err)
	}

	// Set the stack's current operation.
	if _, err = tx.Exec(ctx, `
		UPDATE stacks SET current_operation_id = $1::uuid, updated_at = now()
		WHERE id = $2
	`, updateID, stackID); err != nil {
		return nil, fmt.Errorf("set current operation: %w", err)
	}

	if err = tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit create update: %w", err)
	}

	return &apitype.UpdateProgramResponse{
		UpdateID:         updateID,
		RequiredPolicies: []apitype.RequiredPolicy{},
	}, nil
}

func (s *PostgresService) StartUpdate(ctx context.Context, org, project, stack, updateID string, _ apitype.StartUpdateRequest) (*apitype.StartUpdateResponse, error) {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return nil, err
	}

	// Generate lease token.
	tokenBytes := make([]byte, 32)
	if _, err = rand.Read(tokenBytes); err != nil {
		return nil, fmt.Errorf("generate lease token: %w", err)
	}
	plainToken := hex.EncodeToString(tokenBytes)
	hashedToken := hashToken(plainToken)

	leaseExpires := time.Now().Add(time.Duration(defaultLeaseDuration) * time.Second)

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, fmt.Errorf("begin start update transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Verify the update exists and belongs to this stack.
	var currentStatus string
	err = tx.QueryRow(ctx, `
		SELECT status FROM updates WHERE id = $1::uuid AND stack_id = $2
	`, updateID, stackID).Scan(&currentStatus)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUpdateNotFound
		}
		return nil, fmt.Errorf("find update: %w", err)
	}

	// Get current stack version.
	var stackVersion int64
	err = tx.QueryRow(ctx, `
		SELECT last_checkpoint_version FROM stacks WHERE id = $1
	`, stackID).Scan(&stackVersion)
	if err != nil {
		return nil, fmt.Errorf("get stack version: %w", err)
	}

	version := int(stackVersion + 1)

	// Update the update record.
	ct, err := tx.Exec(ctx, `
		UPDATE updates
		SET status = 'running', started_at = now(), lease_token = $1, lease_expires_at = $2, version = $3
		WHERE id = $4::uuid AND stack_id = $5
	`, hashedToken, leaseExpires, version, updateID, stackID)
	if err != nil {
		return nil, fmt.Errorf("start update: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return nil, ErrUpdateNotFound
	}

	if err = tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit start update: %w", err)
	}

	return &apitype.StartUpdateResponse{
		Version:         version,
		Token:           plainToken,
		TokenExpiration: leaseExpires.Unix(),
	}, nil
}

func (s *PostgresService) PatchCheckpoint(ctx context.Context, org, project, stack, updateID string, req apitype.PatchUpdateCheckpointRequest) error {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return err
	}

	if err := s.verifyUpdateRunning(ctx, updateID, stackID); err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin patch checkpoint transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err = tx.Exec(ctx, `
		INSERT INTO checkpoints (stack_id, update_id, version, deployment, is_invalid)
		VALUES ($1, $2::uuid, $3, $4, $5)
	`, stackID, updateID, req.Version, req.Deployment, req.IsInvalid); err != nil {
		return fmt.Errorf("insert checkpoint: %w", err)
	}

	if _, err = tx.Exec(ctx, `
		UPDATE stacks SET last_checkpoint_version = $1, updated_at = now() WHERE id = $2
	`, req.Version, stackID); err != nil {
		return fmt.Errorf("update stack version: %w", err)
	}

	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit patch checkpoint: %w", err)
	}

	return nil
}

func (s *PostgresService) PatchCheckpointVerbatim(ctx context.Context, org, project, stack, updateID string, req apitype.PatchUpdateVerbatimCheckpointRequest) error {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return err
	}

	if err := s.verifyUpdateRunning(ctx, updateID, stackID); err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin patch checkpoint verbatim transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err = tx.Exec(ctx, `
		INSERT INTO checkpoints (stack_id, update_id, version, sequence_number, deployment, is_invalid)
		VALUES ($1, $2::uuid, $3, $4, $5, false)
		ON CONFLICT (update_id, sequence_number) WHERE sequence_number > 0
		DO NOTHING
	`, stackID, updateID, req.Version, req.SequenceNumber, req.UntypedDeployment); err != nil {
		return fmt.Errorf("insert verbatim checkpoint: %w", err)
	}

	if _, err = tx.Exec(ctx, `
		UPDATE stacks SET last_checkpoint_version = $1, updated_at = now() WHERE id = $2
	`, req.Version, stackID); err != nil {
		return fmt.Errorf("update stack version: %w", err)
	}

	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit patch checkpoint verbatim: %w", err)
	}

	return nil
}

func (s *PostgresService) RecordEvents(ctx context.Context, org, project, stack, updateID string, batch apitype.EngineEventBatch) error {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return err
	}

	if err := s.verifyUpdateRunning(ctx, updateID, stackID); err != nil {
		return err
	}

	if len(batch.Events) == 0 {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin record events transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, event := range batch.Events {
		eventData, err := json.Marshal(event)
		if err != nil {
			return fmt.Errorf("marshal event: %w", err)
		}

		if _, err = tx.Exec(ctx, `
			INSERT INTO update_events (update_id, sequence, timestamp, event_data)
			VALUES ($1::uuid, $2, $3, $4)
			ON CONFLICT (update_id, sequence) DO NOTHING
		`, updateID, event.Sequence, event.Timestamp, eventData); err != nil {
			return fmt.Errorf("insert event: %w", err)
		}
	}

	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit record events: %w", err)
	}

	return nil
}

func (s *PostgresService) RenewLease(ctx context.Context, org, project, stack, updateID string, req apitype.RenewUpdateLeaseRequest) (*apitype.RenewUpdateLeaseResponse, error) {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return nil, err
	}

	if err := s.verifyUpdateRunning(ctx, updateID, stackID); err != nil {
		return nil, err
	}

	// Generate new lease token.
	tokenBytes := make([]byte, 32)
	if _, err = rand.Read(tokenBytes); err != nil {
		return nil, fmt.Errorf("generate new lease token: %w", err)
	}
	newToken := hex.EncodeToString(tokenBytes)
	hashedToken := hashToken(newToken)

	duration := req.Duration
	if duration <= 0 || duration > maxLeaseDuration {
		duration = maxLeaseDuration
	}
	newExpires := time.Now().Add(time.Duration(duration) * time.Second)

	ct, err := s.db.Exec(ctx, `
		UPDATE updates SET lease_token = $1, lease_expires_at = $2
		WHERE id = $3::uuid AND stack_id = $4 AND status = 'running'
	`, hashedToken, newExpires, updateID, stackID)
	if err != nil {
		return nil, fmt.Errorf("renew lease: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return nil, ErrUpdateNotFound
	}

	return &apitype.RenewUpdateLeaseResponse{
		Token:           newToken,
		TokenExpiration: newExpires.Unix(),
	}, nil
}

func (s *PostgresService) CompleteUpdate(ctx context.Context, org, project, stack, updateID string, req apitype.CompleteUpdateRequest) error {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin complete update transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	ct, err := tx.Exec(ctx, `
		UPDATE updates SET status = $1, completed_at = now(), lease_token = NULL, lease_expires_at = NULL
		WHERE id = $2::uuid AND stack_id = $3 AND status IN ('not started', 'requested', 'running')
	`, string(req.Status), updateID, stackID)
	if err != nil {
		return fmt.Errorf("complete update: %w", err)
	}

	if ct.RowsAffected() == 0 {
		var exists bool
		if err = tx.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM updates WHERE id = $1::uuid AND stack_id = $2)
		`, updateID, stackID).Scan(&exists); err != nil {
			return fmt.Errorf("check update existence: %w", err)
		}
		if !exists {
			return ErrUpdateNotFound
		}
		return nil
	}

	// Clear the stack's current operation.
	if _, err = tx.Exec(ctx, `
		UPDATE stacks SET current_operation_id = NULL, updated_at = now() WHERE id = $1
	`, stackID); err != nil {
		return fmt.Errorf("clear current operation: %w", err)
	}

	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit complete update: %w", err)
	}

	return nil
}

func (s *PostgresService) ValidateUpdateToken(ctx context.Context, org, project, stack, updateID, token string) error {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return err
	}

	var storedHash string
	var leaseExpiresAt time.Time
	err = s.db.QueryRow(ctx, `
		SELECT lease_token, lease_expires_at FROM updates
		WHERE id = $1::uuid AND stack_id = $2 AND status = 'running'
	`, updateID, stackID).Scan(&storedHash, &leaseExpiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrUpdateNotFound
		}
		return fmt.Errorf("find update for token validation: %w", err)
	}

	if time.Now().After(leaseExpiresAt) {
		return ErrLeaseExpired
	}

	providedHash := hashToken(token)
	if providedHash != storedHash {
		return ErrInvalidToken
	}

	return nil
}

func (s *PostgresService) ExportStack(ctx context.Context, org, project, stack string) (*apitype.UntypedDeployment, error) {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return nil, err
	}

	var deployment json.RawMessage
	err = s.db.QueryRow(ctx, `
		SELECT deployment FROM checkpoints
		WHERE stack_id = $1 AND deployment IS NOT NULL
		ORDER BY version DESC, created_at DESC
		LIMIT 1
	`, stackID).Scan(&deployment)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &apitype.UntypedDeployment{
				Version:    3,
				Deployment: json.RawMessage(`{"manifest":{"time":"0001-01-01T00:00:00Z","magic":"","version":""},"resources":null}`),
			}, nil
		}
		return nil, fmt.Errorf("query latest checkpoint: %w", err)
	}

	return &apitype.UntypedDeployment{
		Version:    3,
		Deployment: deployment,
	}, nil
}

func (s *PostgresService) ExportStackVersion(ctx context.Context, org, project, stack string, version int) (*apitype.UntypedDeployment, error) {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return nil, err
	}

	var deployment json.RawMessage
	err = s.db.QueryRow(ctx, `
		SELECT deployment FROM checkpoints
		WHERE stack_id = $1 AND version = $2 AND deployment IS NOT NULL
		ORDER BY created_at DESC
		LIMIT 1
	`, stackID, version).Scan(&deployment)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUpdateNotFound
		}
		return nil, fmt.Errorf("query checkpoint version %d: %w", version, err)
	}

	return &apitype.UntypedDeployment{
		Version:    3,
		Deployment: deployment,
	}, nil
}

func (s *PostgresService) ImportStack(ctx context.Context, org, project, stack string, deployment apitype.UntypedDeployment) (string, error) {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return "", err
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", fmt.Errorf("begin import transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Check for active updates — cannot import while an update is running.
	var activeCount int
	err = tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM updates
		WHERE stack_id = $1 AND status IN ('not started', 'requested', 'running')
	`, stackID).Scan(&activeCount)
	if err != nil {
		return "", fmt.Errorf("check active updates: %w", err)
	}
	if activeCount > 0 {
		return "", ErrUpdateConflict
	}

	// Get next version.
	var lastVersion int64
	err = tx.QueryRow(ctx, `
		SELECT last_checkpoint_version FROM stacks WHERE id = $1
	`, stackID).Scan(&lastVersion)
	if err != nil {
		return "", fmt.Errorf("get stack version: %w", err)
	}
	newVersion := lastVersion + 1

	// Create a completed import update record.
	var updateID string
	err = tx.QueryRow(ctx, `
		INSERT INTO updates (stack_id, kind, status, version, completed_at)
		VALUES ($1, 'import', 'succeeded', $2, now())
		RETURNING id::text
	`, stackID, newVersion).Scan(&updateID)
	if err != nil {
		return "", fmt.Errorf("insert import update: %w", err)
	}

	// Store the checkpoint.
	if _, err = tx.Exec(ctx, `
		INSERT INTO checkpoints (stack_id, update_id, version, deployment)
		VALUES ($1, $2::uuid, $3, $4)
	`, stackID, updateID, newVersion, deployment.Deployment); err != nil {
		return "", fmt.Errorf("insert import checkpoint: %w", err)
	}

	// Bump the stack version.
	if _, err = tx.Exec(ctx, `
		UPDATE stacks SET last_checkpoint_version = $1, updated_at = now() WHERE id = $2
	`, newVersion, stackID); err != nil {
		return "", fmt.Errorf("update stack version: %w", err)
	}

	if err = tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit import: %w", err)
	}

	return updateID, nil
}

func (s *PostgresService) GetUpdateStatus(ctx context.Context, org, project, stack, updateID string, _ *string) (*apitype.UpdateResults, error) {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return nil, err
	}

	var status string
	err = s.db.QueryRow(ctx, `
		SELECT status FROM updates WHERE id = $1::uuid AND stack_id = $2
	`, updateID, stackID).Scan(&status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUpdateNotFound
		}
		return nil, fmt.Errorf("get update status: %w", err)
	}

	return &apitype.UpdateResults{
		Status: apitype.UpdateStatus(status),
		Events: []apitype.UpdateEvent{},
	}, nil
}

func (s *PostgresService) CancelUpdate(ctx context.Context, org, project, stack, updateID string) error {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin cancel update transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	ct, err := tx.Exec(ctx, `
		UPDATE updates
		SET status = 'cancelled', completed_at = now(), lease_token = NULL, lease_expires_at = NULL
		WHERE id = $1::uuid AND stack_id = $2 AND status IN ('not started', 'requested', 'running')
	`, updateID, stackID)
	if err != nil {
		return fmt.Errorf("cancel update: %w", err)
	}

	if ct.RowsAffected() == 0 {
		var exists bool
		if err = tx.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM updates WHERE id = $1::uuid AND stack_id = $2)
		`, updateID, stackID).Scan(&exists); err != nil {
			return fmt.Errorf("check update existence: %w", err)
		}
		if !exists {
			return ErrUpdateNotFound
		}
		return nil
	}

	if _, err = tx.Exec(ctx, `
		UPDATE stacks SET current_operation_id = NULL, updated_at = now() WHERE id = $1
	`, stackID); err != nil {
		return fmt.Errorf("clear current operation: %w", err)
	}

	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit cancel update: %w", err)
	}

	return nil
}

func (s *PostgresService) PatchCheckpointDelta(ctx context.Context, org, project, stack, updateID string, req apitype.PatchUpdateCheckpointDeltaRequest) error {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return err
	}

	if err := s.verifyUpdateRunning(ctx, updateID, stackID); err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin patch checkpoint delta transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var lastDeployment json.RawMessage
	err = tx.QueryRow(ctx, `
		SELECT deployment FROM checkpoints
		WHERE stack_id = $1 AND deployment IS NOT NULL
		ORDER BY version DESC, created_at DESC
		LIMIT 1
	`, stackID).Scan(&lastDeployment)
	if err != nil {
		return fmt.Errorf("fetch last checkpoint for delta: %w", err)
	}

	result, err := applyDelta(lastDeployment, req.DeploymentDelta)
	if err != nil {
		return fmt.Errorf("apply delta: %w", err)
	}

	if checksumDeployment(result) != req.CheckpointHash {
		return ErrDeltaHashMismatch
	}

	if _, err = tx.Exec(ctx, `
		INSERT INTO checkpoints (stack_id, update_id, version, sequence_number, deployment, is_invalid)
		VALUES ($1, $2::uuid, $3, $4, $5, false)
		ON CONFLICT (update_id, sequence_number) WHERE sequence_number > 0
		DO NOTHING
	`, stackID, updateID, req.Version, req.SequenceNumber, json.RawMessage(result)); err != nil {
		return fmt.Errorf("insert delta checkpoint: %w", err)
	}

	if _, err = tx.Exec(ctx, `
		UPDATE stacks SET last_checkpoint_version = $1, updated_at = now() WHERE id = $2
	`, req.Version, stackID); err != nil {
		return fmt.Errorf("update stack version: %w", err)
	}

	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit patch checkpoint delta: %w", err)
	}

	return nil
}

func (s *PostgresService) ListUpdates(ctx context.Context, org, project, stack string, page, pageSize int) ([]apitype.UpdateInfo, error) {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return nil, err
	}

	if page < 1 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 10
	}
	offset := (page - 1) * pageSize

	rows, err := s.db.Query(ctx, `
		SELECT kind, status, version, config, metadata, created_at, started_at, completed_at
		FROM updates
		WHERE stack_id = $1
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
	`, stackID, pageSize, offset)
	if err != nil {
		return nil, fmt.Errorf("list updates: %w", err)
	}
	defer rows.Close()

	result := make([]apitype.UpdateInfo, 0, pageSize)
	for rows.Next() {
		info, err := scanUpdateInfo(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, info)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate updates: %w", err)
	}

	return result, nil
}

func (s *PostgresService) GetLatestUpdate(ctx context.Context, org, project, stack string) (*apitype.UpdateInfo, error) {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return nil, err
	}

	row := s.db.QueryRow(ctx, `
		SELECT kind, status, version, config, metadata, created_at, started_at, completed_at
		FROM updates
		WHERE stack_id = $1
		ORDER BY created_at DESC
		LIMIT 1
	`, stackID)

	var (
		kind        string
		status      string
		version     int
		configJSON  json.RawMessage
		metaJSON    json.RawMessage
		createdAt   time.Time
		startedAt   *time.Time
		completedAt *time.Time
	)
	if err := row.Scan(&kind, &status, &version, &configJSON, &metaJSON, &createdAt, &startedAt, &completedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUpdateNotFound
		}
		return nil, fmt.Errorf("get latest update: %w", err)
	}

	info := buildUpdateInfo(kind, status, version, configJSON, metaJSON, createdAt, startedAt, completedAt)
	return &info, nil
}

func scanUpdateInfo(rows pgx.Rows) (apitype.UpdateInfo, error) {
	var (
		kind        string
		status      string
		version     int
		configJSON  json.RawMessage
		metaJSON    json.RawMessage
		createdAt   time.Time
		startedAt   *time.Time
		completedAt *time.Time
	)
	if err := rows.Scan(&kind, &status, &version, &configJSON, &metaJSON, &createdAt, &startedAt, &completedAt); err != nil {
		return apitype.UpdateInfo{}, fmt.Errorf("scan update info: %w", err)
	}
	return buildUpdateInfo(kind, status, version, configJSON, metaJSON, createdAt, startedAt, completedAt), nil
}

func buildUpdateInfo(kind, status string, version int, configJSON, metaJSON json.RawMessage, createdAt time.Time, startedAt, completedAt *time.Time) apitype.UpdateInfo {
	info := apitype.UpdateInfo{
		Kind:    apitype.UpdateKind(kind),
		Version: version,
		Result:  statusToUpdateResult(status),
	}

	info.StartTime = createdAt.Unix()
	if startedAt != nil {
		info.StartTime = startedAt.Unix()
	}
	if completedAt != nil {
		info.EndTime = completedAt.Unix()
	}

	var meta apitype.UpdateMetadata
	if len(metaJSON) > 0 {
		_ = json.Unmarshal(metaJSON, &meta)
	}
	info.Message = meta.Message
	info.Environment = meta.Environment
	if info.Environment == nil {
		info.Environment = map[string]string{}
	}

	var cfg map[string]apitype.ConfigValue
	if len(configJSON) > 0 {
		_ = json.Unmarshal(configJSON, &cfg)
	}
	if cfg == nil {
		cfg = map[string]apitype.ConfigValue{}
	}
	info.Config = cfg

	return info
}

const (
	statusCancelled = "cancelled" //nolint:misspell // matches DB enum value
	eventsPageSize  = 500
)

func (s *PostgresService) GetUpdateEvents(ctx context.Context, org, project, stack, updateID string, continuationToken *string) (*apitype.GetUpdateEventsResponse, error) {
	stackID, err := s.findStackID(ctx, org, project, stack)
	if err != nil {
		return nil, err
	}

	var exists bool
	if err := s.db.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM updates WHERE id = $1::uuid AND stack_id = $2)
	`, updateID, stackID).Scan(&exists); err != nil {
		return nil, fmt.Errorf("check update existence: %w", err)
	}
	if !exists {
		return nil, ErrUpdateNotFound
	}

	afterSequence := 0
	if continuationToken != nil && *continuationToken != "" {
		if parsed, err := strconv.Atoi(*continuationToken); err == nil {
			afterSequence = parsed
		}
	}

	rows, err := s.db.Query(ctx, `
		SELECT event_data FROM update_events
		WHERE update_id = $1::uuid AND sequence > $2
		ORDER BY sequence ASC
		LIMIT $3
	`, updateID, afterSequence, eventsPageSize+1)
	if err != nil {
		return nil, fmt.Errorf("query update events: %w", err)
	}
	defer rows.Close()

	events := make([]apitype.EngineEvent, 0, eventsPageSize)
	for rows.Next() {
		var eventData json.RawMessage
		if err := rows.Scan(&eventData); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		var event apitype.EngineEvent
		if err := json.Unmarshal(eventData, &event); err != nil {
			return nil, fmt.Errorf("unmarshal event: %w", err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate events: %w", err)
	}

	resp := &apitype.GetUpdateEventsResponse{}
	if len(events) > eventsPageSize {
		events = events[:eventsPageSize]
		lastSeq := strconv.Itoa(events[len(events)-1].Sequence)
		resp.ContinuationToken = &lastSeq
	}
	resp.Events = events

	return resp, nil
}

func statusToUpdateResult(status string) apitype.UpdateResult {
	switch status {
	case "succeeded":
		return apitype.SucceededResult
	case "failed", statusCancelled:
		return apitype.FailedResult
	case "running", "requested":
		return apitype.InProgressResult
	default:
		return apitype.NotStartedResult
	}
}

// findStackID looks up a stack by org/project/stack, returning the stack UUID.
func (s *PostgresService) findStackID(ctx context.Context, org, project, stack string) (string, error) {
	var stackID string
	err := s.db.QueryRow(ctx, `
		SELECT s.id::text
		FROM stacks s
		JOIN projects p ON p.id = s.project_id
		JOIN organizations o ON o.id = p.organization_id
		WHERE o.github_login = $1 AND p.name = $2 AND s.name = $3
	`, org, project, stack).Scan(&stackID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrStackNotFound
		}
		return "", fmt.Errorf("find stack: %w", err)
	}
	return stackID, nil
}

// verifyUpdateRunning checks that the given update exists and is in 'running' status.
func (s *PostgresService) verifyUpdateRunning(ctx context.Context, updateID, stackID string) error {
	var status string
	err := s.db.QueryRow(ctx, `
		SELECT status FROM updates WHERE id = $1::uuid AND stack_id = $2
	`, updateID, stackID).Scan(&status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrUpdateNotFound
		}
		return fmt.Errorf("verify update: %w", err)
	}
	if status != "running" {
		return ErrUpdateNotFound
	}
	return nil
}

// hashToken hashes a token using SHA-256.
func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}
