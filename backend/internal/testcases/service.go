// Package testcases owns folders, tags, test cases, their revisions and bulk
// actions (behaviour: web/src/mocks/handlers.ts; shapes: api/openapi.yaml).
//
// last_run_status / last_run_at: test_cases carries denormalised columns that
// the worker maintains. When they are NULL (seeded or historic data, or a
// worker that has not caught up yet) the read model falls back to the latest
// run whose target is the test case (runs.test_case_id, ordered by queued_at),
// which is exactly the mock's lastRunFor: flow runs do not count for a case.
// Both values always come from the same source, so status and time stay paired.
package testcases

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Audit actions.
const (
	ActionCreate       = "test_case.create"
	ActionUpdate       = "test_case.update"
	ActionDelete       = "test_case.delete"
	ActionBulk         = "test_case.bulk"
	ActionFolderCreate = "folder.create"
	ActionFolderUpdate = "folder.update"
	ActionFolderDelete = "folder.delete"
)

// Service implements the test case endpoints (REST and, later, MCP tools).
type Service struct {
	pool *pgxpool.Pool
}

// New builds the service.
func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

/* ------------------------------------------------------------------ read model */

// LastRunStatusExpr / LastRunAtExpr are the effective last-run values of a
// test case aliased "tc" joined with lastRunJoin (see package doc).
const (
	LastRunStatusExpr = `CASE WHEN tc.last_run_status IS NOT NULL THEN tc.last_run_status ELSE lr.status END`
	LastRunAtExpr     = `CASE WHEN tc.last_run_status IS NOT NULL THEN tc.last_run_at ELSE lr.queued_at END`
	lastRunJoin       = `
	LEFT JOIN LATERAL (
		SELECT r.status, r.queued_at FROM runs r
		WHERE r.test_case_id = tc.id
		ORDER BY r.queued_at DESC, r.seq DESC LIMIT 1
	) lr ON tc.last_run_status IS NULL`
)

const summarySelect = `
	SELECT tc.id, tc.seq, tc.folder_id, tc.title, tc.priority, tc.status, tc.execution, tc.tags,
	       jsonb_array_length(tc.steps), tc.revision, ` + LastRunStatusExpr + `, ` + LastRunAtExpr + `,
	       tc.updated_at, tc.updated_by, ub.name, ub.email`

const summaryFrom = `
	FROM test_cases tc
	LEFT JOIN users ub ON ub.id = tc.updated_by` + lastRunJoin

func scanSummary(row pgx.Row, projectKey string, extra ...any) (Summary, error) {
	var (
		s          Summary
		seq        int
		updID      *uuid.UUID
		updName    *string
		updEmail   *string
		lastStatus *string
	)
	dest := append([]any{&s.ID, &seq, &s.FolderID, &s.Title, &s.Priority, &s.Status, &s.Execution, &s.Tags,
		&s.StepCount, &s.Revision, &lastStatus, &s.LastRunAt, &s.UpdatedAt, &updID, &updName, &updEmail}, extra...)
	if err := row.Scan(dest...); err != nil {
		return Summary{}, err
	}
	s.Key = Key(projectKey, seq)
	s.Tags = nonNilStrings(s.Tags)
	s.LastRunStatus = lastStatus
	s.LastRunAt = auth.UTCPtr(s.LastRunAt)
	s.UpdatedAt = s.UpdatedAt.UTC()
	s.UpdatedBy = auth.NewUserRef(updID, updName, updEmail)
	return s, nil
}

// load reads the full TestCase DTO by id.
func load(ctx context.Context, q db.Querier, projectKey string, id uuid.UUID) (TestCase, error) {
	var (
		tc       TestCase
		crID     *uuid.UUID
		crName   *string
		crEmail  *string
		vars     []byte
		stepsRaw []byte
	)
	row := q.QueryRow(ctx, summarySelect+`, tc.description, tc.preconditions, tc.variables, tc.steps, tc.created_at,
		       tc.created_by, cb.name, cb.email`+summaryFrom+`
		LEFT JOIN users cb ON cb.id = tc.created_by
		WHERE tc.id = $1`, id)
	sum, err := scanSummary(row, projectKey, &tc.Description, &tc.Preconditions, &vars, &stepsRaw, &tc.CreatedAt, &crID, &crName, &crEmail)
	if err != nil {
		return TestCase{}, err
	}
	tc.Summary = sum
	tc.ProjectKey = projectKey
	tc.Variables = json.RawMessage(vars)
	tc.Steps = json.RawMessage(stepsRaw)
	tc.CreatedAt = tc.CreatedAt.UTC()
	tc.CreatedBy = auth.NewUserRef(crID, crName, crEmail)
	return tc, nil
}

// loadSnapshot reads the editable state (TestCaseInput) and revision.
func loadSnapshot(ctx context.Context, q db.Querier, id uuid.UUID) (Snapshot, int, error) {
	var (
		s        Snapshot
		rev      int
		vars     []byte
		stepsRaw []byte
	)
	err := q.QueryRow(ctx, `
		SELECT folder_id, title, description, preconditions, priority, status, execution, tags, variables, steps, revision
		FROM test_cases WHERE id = $1`, id).
		Scan(&s.FolderID, &s.Title, &s.Description, &s.Preconditions, &s.Priority, &s.Status, &s.Execution, &s.Tags, &vars, &stepsRaw, &rev)
	s.Tags = nonNilStrings(s.Tags)
	s.Variables = vars
	s.Steps = stepsRaw
	return s, rev, err
}

// findCase resolves caseKey (exact key, like the mock's `t.key === caseKey`)
// after checking action on its project. lock adds FOR UPDATE.
func findCase(ctx context.Context, q db.Querier, actor *auth.Actor, caseKey string, action authz.Action, lock bool) (authz.Project, uuid.UUID, error) {
	p, _, err := authz.ProjectAccess(ctx, q, actor, authz.ProjectKeyOf(caseKey), action)
	if err != nil {
		return p, uuid.Nil, err
	}
	notFound := httpx.NotFound("Test case " + caseKey + " not found")
	_, seq, ok := authz.ParseEntityKey(caseKey, 'T')
	if !ok || Key(p.Key, seq) != caseKey {
		return p, uuid.Nil, notFound
	}
	sql := `SELECT id FROM test_cases WHERE project_id = $1 AND seq = $2 AND deleted_at IS NULL`
	if lock {
		sql += ` FOR UPDATE`
	}
	var id uuid.UUID
	err = q.QueryRow(ctx, sql, p.ID, seq).Scan(&id)
	if db.IsNoRows(err) {
		return p, uuid.Nil, notFound
	}
	return p, id, err
}

// folderInProject reports whether folder id belongs to the project. It takes a
// FOR SHARE lock so a concurrent folder delete cannot orphan the reference.
func folderInProject(ctx context.Context, q db.Querier, projectID, folderID uuid.UUID) (bool, error) {
	var one int
	err := q.QueryRow(ctx, `SELECT 1 FROM folders WHERE id = $1 AND project_id = $2 FOR SHARE`, folderID, projectID).Scan(&one)
	if db.IsNoRows(err) {
		return false, nil
	}
	return err == nil, err
}

func insertRevision(ctx context.Context, q db.Querier, caseID uuid.UUID, rev int, snap Snapshot, author uuid.UUID, note string) error {
	raw, err := json.Marshal(snap)
	if err != nil {
		return fmt.Errorf("revision snapshot: %w", err)
	}
	_, err = q.Exec(ctx, `
		INSERT INTO test_case_revisions (test_case_id, revision, snapshot, author_id, change_note)
		VALUES ($1, $2, $3, $4, $5)`, caseID, rev, raw, author, note)
	return err
}

/* ------------------------------------------------------------------ list & tags */

// ListFilter holds the GET /projects/{key}/test-cases query filters.
type ListFilter struct {
	Folder        string // folder id (descendants included) or "root"
	Q             string
	Tags          []string // all must match
	Status        string
	Priority      string
	Execution     string
	LastRunStatus string
}

// List returns test case summaries ordered by key number.
func (s *Service) List(ctx context.Context, actor *auth.Actor, projectKey string, f ListFilter, page httpx.PageRequest) (httpx.Page[Summary], error) {
	p, _, err := authz.ProjectAccess(ctx, s.pool, actor, projectKey, authz.View)
	if err != nil {
		return httpx.Page[Summary]{}, err
	}
	args := []any{p.ID}
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	where := []string{"tc.project_id = $1", "tc.deleted_at IS NULL"}
	switch {
	case f.Folder == "root":
		where = append(where, "tc.folder_id IS NULL")
	case f.Folder != "":
		id, err := uuid.Parse(f.Folder)
		if err != nil { // unknown folder → no match (mock behaviour)
			return httpx.NewPage([]Summary{}, page), nil
		}
		// UNION (not UNION ALL) terminates even on a corrupt cyclic tree.
		where = append(where, `tc.folder_id IN (
			WITH RECURSIVE d AS (
				SELECT id FROM folders WHERE id = `+arg(id)+` AND project_id = $1
				UNION SELECT c.id FROM folders c JOIN d ON c.parent_id = d.id
			) SELECT id FROM d)`)
	}
	if q := strings.TrimSpace(f.Q); q != "" {
		a := arg(q)
		where = append(where, fmt.Sprintf(`(strpos(lower(tc.title), lower(%[1]s)) > 0 OR strpos(lower(%[2]s || '-T' || tc.seq), lower(%[1]s)) > 0)`, a, arg(p.Key)))
	}
	if len(f.Tags) > 0 {
		where = append(where, "tc.tags @> "+arg(f.Tags)+"::text[]")
	}
	for _, c := range [...]struct{ col, v string }{{"status", f.Status}, {"priority", f.Priority}, {"execution", f.Execution}} {
		if c.v != "" {
			where = append(where, "tc."+c.col+" = "+arg(c.v))
		}
	}
	if f.LastRunStatus != "" {
		where = append(where, LastRunStatusExpr+" = "+arg(f.LastRunStatus))
	}
	limit, offset := page.SQL()
	sql := summarySelect + summaryFrom + " WHERE " + strings.Join(where, " AND ") +
		" ORDER BY tc.seq LIMIT " + arg(limit) + " OFFSET " + arg(offset)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return httpx.Page[Summary]{}, err
	}
	defer rows.Close()
	var items []Summary
	for rows.Next() {
		it, err := scanSummary(rows, p.Key)
		if err != nil {
			return httpx.Page[Summary]{}, err
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return httpx.Page[Summary]{}, err
	}
	return httpx.NewPage(items, page), nil
}

// Tags counts tag usage over the project's non-deleted test cases, sorted by tag.
func (s *Service) Tags(ctx context.Context, actor *auth.Actor, projectKey string) ([]TagCount, error) {
	p, _, err := authz.ProjectAccess(ctx, s.pool, actor, projectKey, authz.View)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT tag, count(*)::int FROM test_cases tc CROSS JOIN LATERAL unnest(tc.tags) AS tag
		WHERE tc.project_id = $1 AND tc.deleted_at IS NULL
		GROUP BY tag`, p.ID)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (TagCount, error) {
		var t TagCount
		err := r.Scan(&t.Tag, &t.Count)
		return t, err
	})
	if err != nil {
		return nil, err
	}
	sortTags(out)
	return out, nil
}

/* ------------------------------------------------------------------ create / validate */

// Validate runs the editor validation (title + step DSL) without saving.
// Like the mock it only needs view access.
func (s *Service) Validate(ctx context.Context, actor *auth.Actor, projectKey string, in Input) (ValidationResult, error) {
	if _, _, err := authz.ProjectAccess(ctx, s.pool, actor, projectKey, authz.View); err != nil {
		return ValidationResult{}, err
	}
	snap, extra := in.resolve(defaultSnapshot())
	errs, warns := validate(snap, extra...)
	return ValidationResult{Valid: len(errs) == 0, Errors: errs, Warnings: warns}, nil
}

// checkSnapshot validates a resolved snapshot including folder ownership.
func checkSnapshot(ctx context.Context, q db.Querier, projectID uuid.UUID, snap Snapshot, extra []httpx.FieldError) error {
	if snap.FolderID != nil && len(extra) == 0 {
		ok, err := folderInProject(ctx, q, projectID, *snap.FolderID)
		if err != nil {
			return err
		}
		if !ok {
			extra = append(extra, httpx.Field("folder_id", "Folder not found"))
		}
	}
	if errs, _ := validate(snap, extra...); len(errs) > 0 {
		return httpx.Unprocessable("Test case is not valid", errs...)
	}
	return nil
}

func nextCaseSeq(ctx context.Context, q db.Querier, projectID uuid.UUID) (int, error) {
	var seq int
	err := q.QueryRow(ctx, `UPDATE projects SET seq_case = seq_case + 1 WHERE id = $1 RETURNING seq_case`, projectID).Scan(&seq)
	return seq, err
}

// Create validates and inserts a test case with revision 1 ("Created").
func (s *Service) Create(ctx context.Context, actor *auth.Actor, projectKey string, in Input) (TestCase, error) {
	var out TestCase
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, projectKey, authz.EditTests)
		if err != nil {
			return err
		}
		snap, extra := in.resolve(defaultSnapshot())
		if err := checkSnapshot(ctx, tx, p.ID, snap, extra); err != nil {
			return err
		}
		seq, err := nextCaseSeq(ctx, tx, p.ID)
		if err != nil {
			return err
		}
		id := db.NewID()
		_, err = tx.Exec(ctx, `
			INSERT INTO test_cases (id, project_id, seq, folder_id, title, description, preconditions, priority, status,
			                        execution, tags, variables, steps, revision, created_by, updated_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $14)`,
			id, p.ID, seq, snap.FolderID, snap.Title, snap.Description, snap.Preconditions, snap.Priority, snap.Status,
			snap.Execution, snap.Tags, snap.Variables, snap.Steps, actor.User.ID)
		if err != nil {
			return err
		}
		if err := insertRevision(ctx, tx, id, 1, snap, actor.User.ID, "Created"); err != nil {
			return err
		}
		key := Key(p.Key, seq)
		if err := audit.Record(ctx, tx, actor, ActionCreate, "test_case", key, &p.ID, audit.Meta{"title": snap.Title}); err != nil {
			return err
		}
		out, err = load(ctx, tx, p.Key, id)
		return err
	})
	return out, err
}

/* ------------------------------------------------------------------ single test case */

// Get returns one test case.
func (s *Service) Get(ctx context.Context, actor *auth.Actor, caseKey string) (TestCase, error) {
	p, id, err := findCase(ctx, s.pool, actor, caseKey, authz.View, false)
	if err != nil {
		return TestCase{}, err
	}
	return load(ctx, s.pool, p.Key, id)
}

// Update applies a PATCH: the caller's revision must be current (409
// revision_conflict), the merged input must validate (422), and a new
// revision snapshot is written with the change note.
func (s *Service) Update(ctx context.Context, actor *auth.Actor, caseKey string, in UpdateInput) (TestCase, error) {
	var out TestCase
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, id, err := findCase(ctx, tx, actor, caseKey, authz.EditTests, true)
		if err != nil {
			return err
		}
		cur, rev, err := loadSnapshot(ctx, tx, id)
		if err != nil {
			return err
		}
		if in.Revision == nil || *in.Revision != rev {
			return httpx.NewError(409, httpx.CodeRevisionConflict,
				fmt.Sprintf("Test case was changed by someone else (revision %d). Reload to see the latest changes.", rev))
		}
		snap, extra := in.Input.resolve(cur)
		if err := checkSnapshot(ctx, tx, p.ID, snap, extra); err != nil {
			return err
		}
		newRev := rev + 1
		_, err = tx.Exec(ctx, `
			UPDATE test_cases SET folder_id = $2, title = $3, description = $4, preconditions = $5, priority = $6,
			       status = $7, execution = $8, tags = $9, variables = $10, steps = $11, revision = $12,
			       updated_at = now(), updated_by = $13
			WHERE id = $1`,
			id, snap.FolderID, snap.Title, snap.Description, snap.Preconditions, snap.Priority,
			snap.Status, snap.Execution, snap.Tags, snap.Variables, snap.Steps, newRev, actor.User.ID)
		if err != nil {
			return err
		}
		note := "No change note"
		if in.ChangeNote != nil && strings.TrimSpace(*in.ChangeNote) != "" {
			note = strings.TrimSpace(*in.ChangeNote)
		}
		if err := insertRevision(ctx, tx, id, newRev, snap, actor.User.ID, note); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, ActionUpdate, "test_case", caseKey, &p.ID, audit.Meta{"revision": newRev, "change_note": note}); err != nil {
			return err
		}
		out, err = load(ctx, tx, p.Key, id)
		return err
	})
	return out, err
}

// Delete soft-deletes a test case unless a non-deleted flow still uses it (409 in_use).
func (s *Service) Delete(ctx context.Context, actor *auth.Actor, caseKey string) error {
	return db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, id, err := findCase(ctx, tx, actor, caseKey, authz.EditTests, true)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT f.seq FROM flows f
			WHERE f.deleted_at IS NULL AND EXISTS (SELECT 1 FROM flow_items fi WHERE fi.flow_id = f.id AND fi.test_case_id = $1)
			ORDER BY f.seq`, id)
		if err != nil {
			return err
		}
		seqs, err := pgx.CollectRows(rows, pgx.RowTo[int])
		if err != nil {
			return err
		}
		if len(seqs) > 0 {
			keys := make([]string, len(seqs))
			for i, n := range seqs {
				keys[i] = p.Key + "-F" + strconv.Itoa(n)
			}
			return httpx.NewError(409, httpx.CodeInUse, "Still used in flows: "+strings.Join(keys, ", "))
		}
		if _, err := tx.Exec(ctx, `UPDATE test_cases SET deleted_at = now() WHERE id = $1`, id); err != nil {
			return err
		}
		return audit.Record(ctx, tx, actor, ActionDelete, "test_case", caseKey, &p.ID, nil)
	})
}

// Duplicate copies a test case as "<title> (copy)", status draft, revision 1.
func (s *Service) Duplicate(ctx context.Context, actor *auth.Actor, caseKey string) (TestCase, error) {
	var out TestCase
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, srcID, err := findCase(ctx, tx, actor, caseKey, authz.EditTests, false)
		if err != nil {
			return err
		}
		seq, err := nextCaseSeq(ctx, tx, p.ID)
		if err != nil {
			return err
		}
		id := db.NewID()
		_, err = tx.Exec(ctx, `
			INSERT INTO test_cases (id, project_id, seq, folder_id, title, description, preconditions, priority, status,
			                        execution, tags, variables, steps, revision, created_by, updated_by)
			SELECT $1, project_id, $2, folder_id, title || ' (copy)', description, preconditions, priority, 'draft',
			       execution, tags, variables, steps, 1, $3, $3
			FROM test_cases WHERE id = $4`, id, seq, actor.User.ID, srcID)
		if err != nil {
			return err
		}
		snap, _, err := loadSnapshot(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := insertRevision(ctx, tx, id, 1, snap, actor.User.ID, "Duplicated from "+caseKey); err != nil {
			return err
		}
		key := Key(p.Key, seq)
		if err := audit.Record(ctx, tx, actor, ActionCreate, "test_case", key, &p.ID, audit.Meta{"title": snap.Title, "duplicated_from": caseKey}); err != nil {
			return err
		}
		out, err = load(ctx, tx, p.Key, id)
		return err
	})
	return out, err
}

/* ------------------------------------------------------------------ revisions */

// Revisions lists revisions newest first.
func (s *Service) Revisions(ctx context.Context, actor *auth.Actor, caseKey string) ([]RevisionSummary, error) {
	_, id, err := findCase(ctx, s.pool, actor, caseKey, authz.View, false)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT r.revision, r.author_id, u.name, u.email, r.change_note, r.created_at
		FROM test_case_revisions r LEFT JOIN users u ON u.id = r.author_id
		WHERE r.test_case_id = $1 ORDER BY r.revision DESC`, id)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (RevisionSummary, error) {
		rs, _, err := scanRevision(r, false)
		return rs, err
	})
}

func scanRevision(row pgx.Row, withSnapshot bool) (RevisionSummary, json.RawMessage, error) {
	var (
		rs    RevisionSummary
		aID   *uuid.UUID
		aName *string
		aMail *string
		snap  []byte
	)
	dest := []any{&rs.Revision, &aID, &aName, &aMail, &rs.ChangeNote, &rs.CreatedAt}
	if withSnapshot {
		dest = append(dest, &snap)
	}
	if err := row.Scan(dest...); err != nil {
		return rs, nil, err
	}
	rs.Author = auth.NewUserRef(aID, aName, aMail)
	rs.CreatedAt = rs.CreatedAt.UTC()
	return rs, snap, nil
}

// Revision returns one revision with its TestCaseInput snapshot.
func (s *Service) Revision(ctx context.Context, actor *auth.Actor, caseKey, rev string) (Revision, error) {
	_, id, err := findCase(ctx, s.pool, actor, caseKey, authz.View, false)
	if err != nil {
		return Revision{}, err
	}
	notFound := httpx.NotFound("Revision not found")
	n, err := strconv.Atoi(rev)
	if err != nil {
		return Revision{}, notFound
	}
	rs, snap, err := scanRevision(s.pool.QueryRow(ctx, `
		SELECT r.revision, r.author_id, u.name, u.email, r.change_note, r.created_at, r.snapshot
		FROM test_case_revisions r LEFT JOIN users u ON u.id = r.author_id
		WHERE r.test_case_id = $1 AND r.revision = $2`, id, n), true)
	if db.IsNoRows(err) {
		return Revision{}, notFound
	}
	if err != nil {
		return Revision{}, err
	}
	return Revision{RevisionSummary: rs, Snapshot: snap}, nil
}
