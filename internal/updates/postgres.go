package updates

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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

	// Use ON CONFLICT for idempotency based on sequence number.
	if _, err = tx.Exec(ctx, `
		INSERT INTO checkpoints (stack_id, update_id, version, sequence_number, deployment, is_invalid)
		VALUES ($1, $2::uuid, $3, $4, $5, false)
		ON CONFLICT (update_id, sequence_number) WHERE sequence_number > 0
		DO NOTHING
	`, stackID, updateID, req.Version, req.SequenceNumber, req.UntypedDeployment); err != nil {
		// The ON CONFLICT may not work with our schema — fall back to simple insert.
		// Try without the conflict clause for now.
		if _, err2 := tx.Exec(ctx, `
			INSERT INTO checkpoints (stack_id, update_id, version, sequence_number, deployment, is_invalid)
			VALUES ($1, $2::uuid, $3, $4, $5, false)
		`, stackID, updateID, req.Version, req.SequenceNumber, req.UntypedDeployment); err2 != nil {
			return fmt.Errorf("insert verbatim checkpoint: %w", err2)
		}
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
		WHERE id = $2::uuid AND stack_id = $3
	`, string(req.Status), updateID, stackID)
	if err != nil {
		return fmt.Errorf("complete update: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrUpdateNotFound
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
