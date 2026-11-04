package artifacts

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/db"
)

// Artifact kinds (artifacts.kind CHECK).
const (
	KindScreenshot = "screenshot"
	KindVideo      = "video"
	KindTrace      = "trace"
	KindLog        = "log"
	KindAttachment = "attachment"
)

var kinds = []string{KindScreenshot, KindVideo, KindTrace, KindLog, KindAttachment}

// DefaultMIME is used when the uploader gives no content type.
const DefaultMIME = "application/octet-stream"

// Artifact is the OpenAPI Artifact schema.
type Artifact struct {
	ID        uuid.UUID  `json:"id"`
	Kind      string     `json:"kind"`
	Name      string     `json:"name"`
	URL       string     `json:"url"`
	MIME      string     `json:"mime"`
	SizeBytes int64      `json:"size_bytes"`
	Expired   bool       `json:"expired"`
	RunStepID *uuid.UUID `json:"run_step_id"`
	CreatedAt time.Time  `json:"created_at"`
}

// URLFor is the API download URL of an artifact.
func URLFor(id uuid.UUID) string { return "/api/v1/artifacts/" + id.String() }

// Columns selects an Artifact (plus run_case_id) from a table aliased "a"; scan with ScanRow.
const Columns = `a.id, a.kind, a.name, a.mime, a.size_bytes, a.purged_at IS NOT NULL, a.run_step_id, a.created_at, a.run_case_id`

// Row is an artifact plus the run case it belongs to (for grouping in run DTOs).
type Row struct {
	Artifact
	RunCaseID *uuid.UUID
}

// Scanner is satisfied by pgx.Row and pgx.Rows.
type Scanner interface{ Scan(dest ...any) error }

// ScanRow scans Columns.
func ScanRow(row Scanner) (Row, error) {
	var r Row
	err := row.Scan(&r.ID, &r.Kind, &r.Name, &r.MIME, &r.SizeBytes, &r.Expired, &r.RunStepID, &r.CreatedAt, &r.RunCaseID)
	if err != nil {
		return r, err
	}
	r.URL = URLFor(r.ID)
	r.CreatedAt = r.CreatedAt.UTC()
	return r, nil
}

// Meta describes an artifact to record.
type Meta struct {
	ProjectID  uuid.UUID
	RunID      uuid.UUID
	RunCaseID  *uuid.UUID
	RunStepID  *uuid.UUID
	Kind       string
	Name       string
	MIME       string
	UploadedBy *uuid.UUID // tester attachments
}

// Save uploads file to store and inserts the artifacts row (expires_at =
// now + the project's artifact_retention_days). The worker uses it for
// screenshots / videos; afterwards it sets run_steps.screenshot_artifact_id or
// run_cases.video_artifact_id itself.
//
// q may be a transaction; if the INSERT fails the uploaded object is deleted.
// If the caller's transaction later rolls back, the caller should Delete the
// object (Artifact.ID → StorageKey) — or let it be orphaned.
func Save(ctx context.Context, q db.Querier, store Store, projectID, runID uuid.UUID, caseID, stepID *uuid.UUID, kind, name, mime string, file io.Reader) (Artifact, error) {
	return SaveWith(ctx, q, store, Meta{
		ProjectID: projectID, RunID: runID, RunCaseID: caseID, RunStepID: stepID,
		Kind: kind, Name: name, MIME: mime,
	}, file, -1)
}

// SaveFile is Save for a file on disk (runner artifact_dir). name defaults to
// the file's base name.
func SaveFile(ctx context.Context, q db.Querier, store Store, projectID, runID uuid.UUID, caseID, stepID *uuid.UUID, kind, name, mime, path string) (Artifact, error) {
	f, err := os.Open(path)
	if err != nil {
		return Artifact{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return Artifact{}, err
	}
	if name == "" {
		name = filepath.Base(path)
	}
	return SaveWith(ctx, q, store, Meta{
		ProjectID: projectID, RunID: runID, RunCaseID: caseID, RunStepID: stepID,
		Kind: kind, Name: name, MIME: mime,
	}, f, st.Size())
}

// SaveWith is the general form of Save; size is the expected byte count or -1.
func SaveWith(ctx context.Context, q db.Querier, store Store, m Meta, file io.Reader, size int64) (Artifact, error) {
	if !slices.Contains(kinds, m.Kind) {
		return Artifact{}, fmt.Errorf("unknown artifact kind %q", m.Kind)
	}
	if m.MIME == "" {
		m.MIME = DefaultMIME
	}
	m.Name = strings.TrimSpace(m.Name)
	if m.Name == "" {
		m.Name = m.Kind
	}
	id := db.NewID()
	key := StorageKey(m.ProjectID, m.RunID, id, m.Name)
	cr := &countingReader{r: file}
	if err := store.Put(ctx, key, cr, size, m.MIME); err != nil {
		return Artifact{}, fmt.Errorf("store artifact: %w", err)
	}
	a := Artifact{ID: id, Kind: m.Kind, Name: m.Name, URL: URLFor(id), MIME: m.MIME, SizeBytes: cr.n, RunStepID: m.RunStepID}
	err := q.QueryRow(ctx, `
		INSERT INTO artifacts (id, project_id, run_id, run_case_id, run_step_id, kind, name, storage_key, mime, size_bytes, uploaded_by, expires_at)
		SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(days => p.artifact_retention_days)
		FROM projects p WHERE p.id = $2
		RETURNING created_at`,
		id, m.ProjectID, m.RunID, m.RunCaseID, m.RunStepID, m.Kind, m.Name, key, m.MIME, cr.n, m.UploadedBy).Scan(&a.CreatedAt)
	if err != nil {
		_ = store.Delete(context.WithoutCancel(ctx), key)
		return Artifact{}, fmt.Errorf("insert artifact: %w", err)
	}
	a.CreatedAt = a.CreatedAt.UTC()
	return a, nil
}

var unsafeExt = regexp.MustCompile(`[^a-z0-9]`)

// StorageKey is "<project>/<run>/<artifact><.ext>"; the extension comes from
// name (sanitised) so files stay recognisable on disk.
func StorageKey(projectID, runID, artifactID uuid.UUID, name string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	ext = unsafeExt.ReplaceAllString(ext, "")
	if len(ext) > 10 {
		ext = ext[:10]
	}
	key := projectID.String() + "/" + runID.String() + "/" + artifactID.String()
	if ext != "" {
		key += "." + ext
	}
	return key
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// Purge deletes the files of artifacts older than their project's
// artifact_retention_days (as of now) and marks them purged (Artifact.expired).
// Rows stay so run reports can show "artifact expired". Retention is evaluated
// against the project's current setting, so changing it applies to existing
// artifacts too. Returns the number of artifacts purged. Safe to run concurrently
// (rows are locked with SKIP LOCKED).
func Purge(ctx context.Context, b db.TxBeginner, store Store, now time.Time, logger *slog.Logger) (int, error) {
	if logger == nil {
		logger = slog.Default()
	}
	total := 0
	for {
		purged, failed := 0, 0
		err := db.WithTx(ctx, b, func(tx pgx.Tx) error {
			rows, err := tx.Query(ctx, `
				SELECT a.id, a.storage_key
				FROM artifacts a JOIN projects p ON p.id = a.project_id
				WHERE a.purged_at IS NULL
				  AND a.created_at + make_interval(days => p.artifact_retention_days) <= $1
				ORDER BY a.created_at
				LIMIT 200
				FOR UPDATE OF a SKIP LOCKED`, now)
			if err != nil {
				return err
			}
			type item struct {
				id  uuid.UUID
				key string
			}
			var items []item
			for rows.Next() {
				var it item
				if err := rows.Scan(&it.id, &it.key); err != nil {
					rows.Close()
					return err
				}
				items = append(items, it)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
			var done []uuid.UUID
			for _, it := range items {
				if err := store.Delete(ctx, it.key); err != nil && !errors.Is(err, ErrNotFound) {
					logger.WarnContext(ctx, "artifact purge: delete failed", "artifact_id", it.id, "err", err)
					failed++
					continue
				}
				done = append(done, it.id)
			}
			if len(done) > 0 {
				if _, err := tx.Exec(ctx, `UPDATE artifacts SET purged_at = $2 WHERE id = ANY ($1)`, done, now); err != nil {
					return err
				}
			}
			purged = len(done)
			return nil
		})
		if err != nil {
			return total, err
		}
		total += purged
		if purged == 0 || failed > 0 {
			return total, nil
		}
	}
}
