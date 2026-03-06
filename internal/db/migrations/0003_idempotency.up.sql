-- Unique index for checkpoint idempotency (sequence_number > 0).
-- PatchCheckpointVerbatim and PatchCheckpointDelta use ON CONFLICT DO NOTHING
-- with sequence_number as the idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoints_update_seq
    ON checkpoints (update_id, sequence_number) WHERE sequence_number > 0;
