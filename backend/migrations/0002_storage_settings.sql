-- Artifact storage configured from the platform (Admin → Storage).
--
--   * system_settings: one row per settings group. key 'storage' holds the
--     artifact storage configuration as jsonb ({"backend":"s3","s3":{endpoint,
--     region, bucket, access_key_id, prefix, force_path_style}}); the S3 secret
--     key is AES-256-GCM encrypted with QATLAS_MASTER_KEY in secret_enc
--     (nonce ‖ ciphertext, internal/secrets) and never returned by the API.
--   * artifacts.storage: the backend each object was written to. Reads, deletes
--     and retention use the store of the row, so switching the active backend
--     never strands old files.
--   * storage_migrations: progress of "copy artifacts into the active backend"
--     jobs started from the UI; at most one queued/running at a time.
--
-- Backfill: SQL cannot see the environment, so existing artifact rows default
-- to 'local' and the migration leaves a marker row
-- (system_settings key 'artifacts_storage_backfill'). The first `qatlas
-- migrate up`, `server`, `worker` or `all` that runs afterwards consumes it:
-- when that process has QATLAS_STORAGE=s3 in its environment, every existing
-- row is marked 's3' (that is where the previous version wrote them). Manual
-- equivalent: UPDATE artifacts SET storage = 's3' WHERE storage = 'local';

-- +goose Up

CREATE TABLE system_settings (
    key               text PRIMARY KEY,
    value             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    secret_enc        bytea,       -- encrypted secret of the group (S3 secret key)
    secret_updated_at timestamptz,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    updated_by        uuid REFERENCES users (id) ON DELETE SET NULL
);

INSERT INTO system_settings (key, value) VALUES ('artifacts_storage_backfill', '{"pending": true}');

ALTER TABLE artifacts
    ADD COLUMN storage text NOT NULL DEFAULT 'local' CHECK (storage IN ('local', 's3'));
CREATE INDEX artifacts_storage_idx ON artifacts (storage, created_at, id) WHERE purged_at IS NULL;

CREATE TABLE storage_migrations (
    id            uuid PRIMARY KEY,
    status        text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    from_backend  text        NOT NULL CHECK (from_backend IN ('local', 's3')),
    to_backend    text        NOT NULL CHECK (to_backend IN ('local', 's3')),
    delete_source boolean     NOT NULL DEFAULT false,
    total         integer     NOT NULL DEFAULT 0,
    copied        integer     NOT NULL DEFAULT 0,
    failed        integer     NOT NULL DEFAULT 0,
    error         text,
    job_id        bigint,      -- river_job.id
    created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    started_at    timestamptz,
    finished_at   timestamptz,
    CHECK (from_backend <> to_backend)
);
CREATE INDEX storage_migrations_created_idx ON storage_migrations (created_at DESC);
-- At most one migration waiting or running.
CREATE UNIQUE INDEX storage_migrations_active_key ON storage_migrations ((status IN ('queued', 'running')))
    WHERE status IN ('queued', 'running');

-- +goose Down

DROP TABLE IF EXISTS storage_migrations;
DROP INDEX IF EXISTS artifacts_storage_idx;
ALTER TABLE artifacts DROP COLUMN IF EXISTS storage;
DROP TABLE IF EXISTS system_settings;
