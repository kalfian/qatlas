-- Responsive testing: runs on several devices (docs/14-responsive-testing.md).
--
--   * run_cases.device_index: 0-based index into runs.options.devices. A run
--     executes every enabled case once per device; positions stay unique per
--     run and go device by device (device 0 = 1..N, device 1 = N+1..2N, …),
--     so run_cases_run_position_key and every "ORDER BY position" keep
--     working. Runs created before this migration have one device → 0.
--   * run_steps.only_on: snapshot of the DSL step's only_on (NULL = every
--     device). A step that does not apply to the case's device category is
--     stored with enabled = false and ends skipped.
--
-- runs.options of older runs (and projects.default_run_options) have no
-- "devices": readers derive one device from "viewport" (no backfill).

-- +goose Up

ALTER TABLE run_cases
    ADD COLUMN device_index smallint NOT NULL DEFAULT 0 CHECK (device_index >= 0);

ALTER TABLE run_steps
    ADD COLUMN only_on text[] CHECK (only_on IS NULL OR (cardinality(only_on) > 0 AND only_on <@ ARRAY['mobile', 'tablet', 'desktop']::text[]));

-- +goose Down

ALTER TABLE run_steps DROP COLUMN IF EXISTS only_on;
ALTER TABLE run_cases DROP COLUMN IF EXISTS device_index;
