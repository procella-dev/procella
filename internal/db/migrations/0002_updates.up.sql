-- Update kinds
CREATE TYPE update_kind AS ENUM (
    'update',
    'preview',
    'refresh',
    'destroy',
    'rename',
    'import',
    'resource-import'
);

-- Update statuses
CREATE TYPE update_status AS ENUM (
    'not started',
    'requested',
    'running',
    'failed',
    'succeeded',
    'cancelled'
);

-- Updates table
CREATE TABLE IF NOT EXISTS updates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stack_id        UUID NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
    kind            update_kind NOT NULL,
    status          update_status NOT NULL DEFAULT 'not started',

    -- Program metadata from UpdateProgramRequest
    program_name    TEXT NOT NULL DEFAULT '',
    program_runtime TEXT NOT NULL DEFAULT '',
    program_main    TEXT NOT NULL DEFAULT '',
    program_description TEXT NOT NULL DEFAULT '',
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Lease management
    lease_token     TEXT,
    lease_expires_at TIMESTAMPTZ,

    -- Version tracking
    version         INT NOT NULL DEFAULT 0,

    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

-- Only one active update per stack
CREATE UNIQUE INDEX IF NOT EXISTS idx_updates_active_per_stack
    ON updates (stack_id) WHERE status IN ('not started', 'requested', 'running');

CREATE INDEX IF NOT EXISTS idx_updates_stack ON updates (stack_id);

-- Update events table
CREATE TABLE IF NOT EXISTS update_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    update_id       UUID NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
    sequence        INT NOT NULL,
    timestamp       INT NOT NULL,
    event_data      JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (update_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_update_events_update ON update_events (update_id, sequence);

-- Checkpoints table
CREATE TABLE IF NOT EXISTS checkpoints (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stack_id        UUID NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
    update_id       UUID NOT NULL REFERENCES updates(id) ON DELETE CASCADE,
    version         INT NOT NULL,
    sequence_number INT NOT NULL DEFAULT 0,
    deployment      JSONB,
    is_invalid      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest checkpoint per stack (only need the latest)
CREATE INDEX IF NOT EXISTS idx_checkpoints_stack_version
    ON checkpoints (stack_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoints_update ON checkpoints (update_id);
