// Package flows owns flows: ordered lists of test cases run together
// (behaviour: web/src/mocks/handlers.ts; shapes: api/openapi.yaml).
//
// last_run_status / last_run_at come from the denormalised flows columns the
// worker maintains, falling back to the latest run of the flow
// (runs.flow_id, ordered by queued_at) while they are NULL — the same rule as
// internal/testcases.
package flows

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

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
	ActionCreate = "flow.create"
	ActionUpdate = "flow.update"
	ActionDelete = "flow.delete"
)

// Summary is the OpenAPI FlowSummary schema.
type Summary struct {
	ID            uuid.UUID  `json:"id"`
	Key           string     `json:"key"`
	Name          string     `json:"name"`
	Description   string     `json:"description"`
	Tags          []string   `json:"tags"`
	SharedSession bool       `json:"shared_session"`
	StopOnFailure bool       `json:"stop_on_failure"`
	ItemCount     int        `json:"item_count"`
	HasManual     bool       `json:"has_manual"`
	LastRunStatus *string    `json:"last_run_status"`
	LastRunAt     *time.Time `json:"last_run_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// ItemTestCase is FlowItem.test_case.
type ItemTestCase struct {
	ID        uuid.UUID `json:"id"`
	Key       string    `json:"key"`
	Title     string    `json:"title"`
	Execution string    `json:"execution"`
	Status    string    `json:"status"`
	StepCount int       `json:"step_count"`
}

// Item is the OpenAPI FlowItem schema.
type Item struct {
	ID                uuid.UUID    `json:"id"`
	TestCase          ItemTestCase `json:"test_case"`
	ContinueOnFailure bool         `json:"continue_on_failure"`
	Enabled           bool         `json:"enabled"`
}

// Flow is the OpenAPI Flow schema.
type Flow struct {
	Summary
	ProjectKey string          `json:"project_key"`
	Variables  json.RawMessage `json:"variables"`
	Items      []Item          `json:"items"`
	Revision   int             `json:"revision"`
}

// ItemInput is one FlowInput.items entry.
type ItemInput struct {
	TestCaseID        string `json:"test_case_id"`
	ContinueOnFailure bool   `json:"continue_on_failure"`
	Enabled           *bool  `json:"enabled"`
}

// Input is the OpenAPI FlowInput (null = absent).
type Input struct {
	Name          *string            `json:"name"`
	Description   *string            `json:"description"`
	Tags          *[]string          `json:"tags"`
	SharedSession *bool              `json:"shared_session"`
	StopOnFailure *bool              `json:"stop_on_failure"`
	Variables     *map[string]string `json:"variables"`
	Items         []ItemInput        `json:"items"`
}

// UpdateInput is the PATCH /flows/{flowKey} body.
type UpdateInput struct {
	Input
	Revision *int `json:"revision"`
}

// Service implements the flow endpoints.
type Service struct {
	pool *pgxpool.Pool
}

// New builds the service.
func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// Key renders a flow key (SHOP-F3).
func Key(projectKey string, seq int) string { return projectKey + "-F" + strconv.Itoa(seq) }

/* ------------------------------------------------------------------ read model */

const summaryCols = `
	SELECT f.id, f.seq, f.name, f.description, f.tags, f.shared_session, f.stop_on_failure,
	       (SELECT count(*)::int FROM flow_items fi WHERE fi.flow_id = f.id),
	       EXISTS (SELECT 1 FROM flow_items fi JOIN test_cases t ON t.id = fi.test_case_id
	               WHERE fi.flow_id = f.id AND t.execution = 'manual'),
	       CASE WHEN f.last_run_status IS NOT NULL THEN f.last_run_status ELSE lr.status END,
	       CASE WHEN f.last_run_status IS NOT NULL THEN f.last_run_at ELSE lr.queued_at END,
	       f.updated_at`

const summaryFrom = `
	FROM flows f
	LEFT JOIN LATERAL (
		SELECT r.status, r.queued_at FROM runs r
		WHERE r.flow_id = f.id
		ORDER BY r.queued_at DESC, r.seq DESC LIMIT 1
	) lr ON f.last_run_status IS NULL`

const summarySelect = summaryCols + summaryFrom

func scanSummary(row pgx.Row, projectKey string, extra ...any) (Summary, error) {
	var (
		s   Summary
		seq int
	)
	dest := append([]any{&s.ID, &seq, &s.Name, &s.Description, &s.Tags, &s.SharedSession, &s.StopOnFailure,
		&s.ItemCount, &s.HasManual, &s.LastRunStatus, &s.LastRunAt, &s.UpdatedAt}, extra...)
	if err := row.Scan(dest...); err != nil {
		return Summary{}, err
	}
	s.Key = Key(projectKey, seq)
	if s.Tags == nil {
		s.Tags = []string{}
	}
	s.LastRunAt = auth.UTCPtr(s.LastRunAt)
	s.UpdatedAt = s.UpdatedAt.UTC()
	return s, nil
}

func load(ctx context.Context, q db.Querier, projectKey string, id uuid.UUID) (Flow, error) {
	var (
		fl   Flow
		vars []byte
	)
	sum, err := scanSummary(q.QueryRow(ctx, summaryCols+`, f.variables, f.revision`+summaryFrom+`
		WHERE f.id = $1`, id), projectKey, &vars, &fl.Revision)
	if err != nil {
		return Flow{}, err
	}
	fl.Summary = sum
	fl.ProjectKey = projectKey
	fl.Variables = vars
	rows, err := q.Query(ctx, `
		SELECT fi.id, fi.continue_on_failure, fi.enabled,
		       t.id, tp.key, t.seq, t.title, t.execution, t.status, jsonb_array_length(t.steps)
		FROM flow_items fi
		JOIN test_cases t ON t.id = fi.test_case_id
		JOIN projects tp ON tp.id = t.project_id
		WHERE fi.flow_id = $1 ORDER BY fi.position`, id)
	if err != nil {
		return Flow{}, err
	}
	fl.Items, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (Item, error) {
		var (
			it  Item
			pk  string
			seq int
		)
		err := r.Scan(&it.ID, &it.ContinueOnFailure, &it.Enabled, &it.TestCase.ID, &pk, &seq,
			&it.TestCase.Title, &it.TestCase.Execution, &it.TestCase.Status, &it.TestCase.StepCount)
		it.TestCase.Key = pk + "-T" + strconv.Itoa(seq)
		return it, err
	})
	if err != nil {
		return Flow{}, err
	}
	if fl.Items == nil {
		fl.Items = []Item{}
	}
	return fl, nil
}

// findFlow resolves flowKey exactly (mock: `f.key === flowKey`) after the
// project check. lock adds FOR UPDATE.
func findFlow(ctx context.Context, q db.Querier, actor *auth.Actor, flowKey string, action authz.Action, lock bool) (authz.Project, uuid.UUID, error) {
	p, _, err := authz.ProjectAccess(ctx, q, actor, authz.ProjectKeyOf(flowKey), action)
	if err != nil {
		return p, uuid.Nil, err
	}
	notFound := httpx.NotFound("Flow " + flowKey + " not found")
	_, seq, ok := authz.ParseEntityKey(flowKey, 'F')
	if !ok || Key(p.Key, seq) != flowKey {
		return p, uuid.Nil, notFound
	}
	sql := `SELECT id FROM flows WHERE project_id = $1 AND seq = $2 AND deleted_at IS NULL`
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

/* ------------------------------------------------------------------ validation */

// validateItems ports the mock's flowValidation: name, ≥1 item, every item a
// non-deleted test case of the same project, no manual case in a shared
// session. The referenced test cases are locked FOR SHARE so a concurrent
// test case delete cannot slip past its in_use check.
func validateItems(ctx context.Context, q db.Querier, projectID uuid.UUID, name string, items []ItemInput, shared bool) ([]uuid.UUID, error) {
	var errs []httpx.FieldError
	if strings.TrimSpace(name) == "" {
		errs = append(errs, httpx.Field("name", "Flow name is required"))
	}
	if len(items) == 0 {
		errs = append(errs, httpx.Field("items", "A flow needs at least 1 test case"))
	}
	ids := make([]uuid.UUID, len(items))
	var valid []uuid.UUID
	for i, it := range items {
		if id, err := uuid.Parse(it.TestCaseID); err == nil {
			ids[i] = id
			valid = append(valid, id)
		}
	}
	type tcInfo struct {
		key       string
		execution string
	}
	found := map[uuid.UUID]tcInfo{}
	if len(valid) > 0 {
		rows, err := q.Query(ctx, `
			SELECT t.id, p.key, t.seq, t.execution FROM test_cases t JOIN projects p ON p.id = t.project_id
			WHERE t.id = ANY($1) AND t.project_id = $2 AND t.deleted_at IS NULL
			FOR SHARE OF t`, valid, projectID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var (
				id       uuid.UUID
				pk, exec string
				seq      int
			)
			if err := rows.Scan(&id, &pk, &seq, &exec); err != nil {
				rows.Close()
				return nil, err
			}
			found[id] = tcInfo{key: pk + "-T" + strconv.Itoa(seq), execution: exec}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	for i, id := range ids {
		tc, ok := found[id]
		switch {
		case id == uuid.Nil || !ok:
			errs = append(errs, httpx.Field(fmt.Sprintf("items[%d]", i), "Test case not found"))
		case shared && tc.execution == "manual":
			errs = append(errs, httpx.Field(fmt.Sprintf("items[%d]", i), fmt.Sprintf("Manual test case %s can't be in a flow with a shared session", tc.key)))
		}
	}
	if len(errs) > 0 {
		return nil, httpx.Unprocessable("Flow is not valid", errs...)
	}
	return ids, nil
}

func insertItems(ctx context.Context, q db.Querier, flowID uuid.UUID, items []ItemInput, ids []uuid.UUID) error {
	for i, it := range items {
		enabled := it.Enabled == nil || *it.Enabled
		if _, err := q.Exec(ctx, `
			INSERT INTO flow_items (id, flow_id, position, test_case_id, continue_on_failure, enabled)
			VALUES ($1, $2, $3, $4, $5, $6)`, db.NewID(), flowID, i+1, ids[i], it.ContinueOnFailure, enabled); err != nil {
			return err
		}
	}
	return nil
}

func varsJSON(v *map[string]string) json.RawMessage {
	if v == nil || *v == nil {
		return json.RawMessage(`{}`)
	}
	raw, _ := json.Marshal(*v)
	return raw
}

func tagsOf(t *[]string) []string {
	if t == nil || *t == nil {
		return []string{}
	}
	return *t
}

/* ------------------------------------------------------------------ endpoints */

// List returns the project's flows (q matches name or key), ordered by key number.
func (s *Service) List(ctx context.Context, actor *auth.Actor, projectKey, q string) ([]Summary, error) {
	p, _, err := authz.ProjectAccess(ctx, s.pool, actor, projectKey, authz.View)
	if err != nil {
		return nil, err
	}
	sql := summarySelect + ` WHERE f.project_id = $1 AND f.deleted_at IS NULL`
	args := []any{p.ID}
	if q != "" {
		sql += ` AND (strpos(lower(f.name), lower($2)) > 0 OR strpos(lower($3 || '-F' || f.seq), lower($2)) > 0)`
		args = append(args, q, p.Key)
	}
	rows, err := s.pool.Query(ctx, sql+` ORDER BY f.seq`, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Summary, error) { return scanSummary(r, p.Key) })
}

// Create validates and inserts a flow.
func (s *Service) Create(ctx context.Context, actor *auth.Actor, projectKey string, in Input) (Flow, error) {
	var out Flow
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, projectKey, authz.EditTests)
		if err != nil {
			return err
		}
		name := ""
		if in.Name != nil {
			name = strings.TrimSpace(*in.Name)
		}
		shared := in.SharedSession != nil && *in.SharedSession
		ids, err := validateItems(ctx, tx, p.ID, name, in.Items, shared)
		if err != nil {
			return err
		}
		stop := in.StopOnFailure == nil || *in.StopOnFailure
		description := ""
		if in.Description != nil {
			description = *in.Description
		}
		var seq int
		if err := tx.QueryRow(ctx, `UPDATE projects SET seq_flow = seq_flow + 1 WHERE id = $1 RETURNING seq_flow`, p.ID).Scan(&seq); err != nil {
			return err
		}
		id := db.NewID()
		_, err = tx.Exec(ctx, `
			INSERT INTO flows (id, project_id, seq, name, description, tags, shared_session, stop_on_failure, variables,
			                   revision, created_by, updated_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $10)`,
			id, p.ID, seq, name, description, tagsOf(in.Tags), shared, stop, varsJSON(in.Variables), actor.User.ID)
		if err != nil {
			return err
		}
		if err := insertItems(ctx, tx, id, in.Items, ids); err != nil {
			return err
		}
		key := Key(p.Key, seq)
		if err := audit.Record(ctx, tx, actor, ActionCreate, "flow", key, &p.ID, audit.Meta{"name": name, "items": len(ids)}); err != nil {
			return err
		}
		out, err = load(ctx, tx, p.Key, id)
		return err
	})
	return out, err
}

// Get returns one flow with its items.
func (s *Service) Get(ctx context.Context, actor *auth.Actor, flowKey string) (Flow, error) {
	p, id, err := findFlow(ctx, s.pool, actor, flowKey, authz.View, false)
	if err != nil {
		return Flow{}, err
	}
	return load(ctx, s.pool, p.Key, id)
}

// Update replaces a flow's definition (items wholesale). The revision must be
// current (409 revision_conflict). Name and items are required like on create;
// other fields keep their value when absent.
func (s *Service) Update(ctx context.Context, actor *auth.Actor, flowKey string, in UpdateInput) (Flow, error) {
	var out Flow
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, id, err := findFlow(ctx, tx, actor, flowKey, authz.EditTests, true)
		if err != nil {
			return err
		}
		var (
			rev         int
			description string
			tags        []string
			shared      bool
			stop        bool
			vars        []byte
		)
		err = tx.QueryRow(ctx, `SELECT revision, description, tags, shared_session, stop_on_failure, variables FROM flows WHERE id = $1`, id).
			Scan(&rev, &description, &tags, &shared, &stop, &vars)
		if err != nil {
			return err
		}
		if in.Revision == nil || *in.Revision != rev {
			return httpx.NewError(409, httpx.CodeRevisionConflict, "Flow was changed by someone else. Reload to see the latest changes.")
		}
		if in.SharedSession != nil {
			shared = *in.SharedSession
		}
		name := ""
		if in.Name != nil {
			name = strings.TrimSpace(*in.Name)
		}
		ids, err := validateItems(ctx, tx, p.ID, name, in.Items, shared)
		if err != nil {
			return err
		}
		if in.Description != nil {
			description = *in.Description
		}
		if in.Tags != nil {
			tags = tagsOf(in.Tags)
		}
		if in.StopOnFailure != nil {
			stop = *in.StopOnFailure
		}
		if in.Variables != nil {
			vars = varsJSON(in.Variables)
		}
		_, err = tx.Exec(ctx, `
			UPDATE flows SET name = $2, description = $3, tags = $4, shared_session = $5, stop_on_failure = $6,
			       variables = $7, revision = revision + 1, updated_at = now(), updated_by = $8
			WHERE id = $1`, id, name, description, tagsOf(&tags), shared, stop, json.RawMessage(vars), actor.User.ID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM flow_items WHERE flow_id = $1`, id); err != nil {
			return err
		}
		if err := insertItems(ctx, tx, id, in.Items, ids); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, ActionUpdate, "flow", flowKey, &p.ID, audit.Meta{"revision": rev + 1, "items": len(ids)}); err != nil {
			return err
		}
		out, err = load(ctx, tx, p.Key, id)
		return err
	})
	return out, err
}

// Delete soft-deletes a flow.
func (s *Service) Delete(ctx context.Context, actor *auth.Actor, flowKey string) error {
	return db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, id, err := findFlow(ctx, tx, actor, flowKey, authz.EditTests, true)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE flows SET deleted_at = now() WHERE id = $1`, id); err != nil {
			return err
		}
		return audit.Record(ctx, tx, actor, ActionDelete, "flow", flowKey, &p.ID, nil)
	})
}
