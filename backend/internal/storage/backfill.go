package storage

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db"
)

// Backfill consumes the one-time marker left by migration 0002: artifact rows
// that existed before artifacts.storage was added default to "local"; when
// this process runs with QATLAS_STORAGE=s3 in its environment (the previous
// version wrote every artifact there), they are switched to "s3". Called by
// `qatlas migrate up`, `server`, `worker` and `all`; whichever runs first
// after the upgrade does it (row lock), later calls are no-ops. Returns the
// number of rows switched.
func Backfill(ctx context.Context, pool *pgxpool.Pool, cfg *config.Config, logger *slog.Logger) (int64, error) {
	if logger == nil {
		logger = slog.Default()
	}
	var pending bool
	err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM system_settings WHERE key = $1)`, backfillKey).Scan(&pending)
	if isUndefinedTable(err) || (err == nil && !pending) {
		return 0, nil // migration 0002 not applied yet, or already done
	}
	if err != nil {
		return 0, err
	}
	var n int64
	err = db.WithTx(ctx, pool, func(tx pgx.Tx) error {
		var raw []byte
		err := tx.QueryRow(ctx, `SELECT value FROM system_settings WHERE key = $1 FOR UPDATE`, backfillKey).Scan(&raw)
		if db.IsNoRows(err) {
			return nil // another process did it meanwhile
		}
		if err != nil {
			return err
		}
		var marker struct {
			Pending bool `json:"pending"`
		}
		_ = json.Unmarshal(raw, &marker)
		if marker.Pending && cfg.StorageFromEnv && cfg.Storage == config.StorageS3 {
			tag, err := tx.Exec(ctx, `UPDATE artifacts SET storage = 's3' WHERE storage = 'local'`)
			if err != nil {
				return err
			}
			n = tag.RowsAffected()
		}
		_, err = tx.Exec(ctx, `DELETE FROM system_settings WHERE key = $1`, backfillKey)
		return err
	})
	if n > 0 {
		logger.Info("existing artifacts marked as stored in S3 (QATLAS_STORAGE=s3)", "count", n)
	}
	return n, err
}
