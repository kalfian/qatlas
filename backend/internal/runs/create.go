package runs

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/dsl"
	"github.com/kalfian/qatlas/backend/internal/events"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Snapshot is stored in runs.snapshot: everything the worker needs to execute
// the run as it was defined at creation time. Secret VALUES are never stored —
// the worker decrypts environment_secrets by name.
type Snapshot struct {
	Kind        string          `json:"kind"`
	Target      Target          `json:"target"`
	Flow        *FlowSnapshot   `json:"flow"`
	Environment *EnvSnapshot    `json:"environment"`
	Options     json.RawMessage `json:"options"`
	Cases       []CaseSnapshot  `json:"cases"`
	RerunOf     string          `json:"rerun_of,omitempty"`
}

// FlowSnapshot holds the flow-level options of a flow run.
type FlowSnapshot struct {
	ID            uuid.UUID       `json:"id"`
	Key           string          `json:"key"`
	Name          string          `json:"name"`
	Revision      int             `json:"revision"`
	SharedSession bool            `json:"shared_session"`
	StopOnFailure bool            `json:"stop_on_failure"`
	Variables     json.RawMessage `json:"variables"`
}

// EnvSnapshot holds the environment name, variables and secret names.
type EnvSnapshot struct {
	ID          uuid.UUID         `json:"id"`
	Name        string            `json:"name"`
	Variables   map[string]string `json:"variables"`
	SecretNames []string          `json:"secret_names"`
}

// CaseSnapshot is one run case with its original (uninterpolated) DSL steps;
// run_steps rows map to Steps by position (and step_id = the DSL "id").
type CaseSnapshot struct {
	RunCaseID         uuid.UUID       `json:"run_case_id"`
	Position          int             `json:"position"`
	TestCaseID        uuid.UUID       `json:"test_case_id"`
	TestCaseKey       string          `json:"test_case_key"`
	Revision          int             `json:"revision"`
	Title             string          `json:"title"`
	Execution         string          `json:"execution"`
	ContinueOnFailure bool            `json:"continue_on_failure"`
	Variables         json.RawMessage `json:"variables"`
	Steps             []dsl.Step      `json:"steps"` // run_steps.position = index + 1
}

/* ------------------------------------------------------------------ target loading */

type testCaseRow struct {
	ID        uuid.UUID
	Key       string
	Title     string
	Execution string
	Revision  int
	Steps     []dsl.Step
	Variables json.RawMessage
	Deleted   bool
}

const testCaseSelect = `
SELECT tc.id, p.key || '-T' || tc.seq, tc.title, tc.execution, tc.revision, tc.steps, tc.variables, tc.deleted_at IS NOT NULL
FROM test_cases tc JOIN projects p ON p.id = tc.project_id`

func scanTestCases(rows pgx.Rows) ([]testCaseRow, error) {
	defer rows.Close()
	var out []testCaseRow
	for rows.Next() {
		var (
			t     testCaseRow
			steps []byte
		)
		if err := rows.Scan(&t.ID, &t.Key, &t.Title, &t.Execution, &t.Revision, &steps, &t.Variables, &t.Deleted); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(steps, &t.Steps); err != nil {
			return nil, fmt.Errorf("test case %s steps: %w", t.Key, err)
		}
		if t.Steps == nil {
			t.Steps = []dsl.Step{}
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func loadTestCase(ctx context.Context, q db.Querier, where string, args ...any) (*testCaseRow, error) {
	rows, err := q.Query(ctx, testCaseSelect+" "+where, args...)
	if err != nil {
		return nil, err
	}
	list, err := scanTestCases(rows)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return &list[0], nil
}

type flowRow struct {
	ID            uuid.UUID
	Key           string
	Name          string
	Revision      int
	SharedSession bool
	StopOnFailure bool
	Variables     json.RawMessage
	Deleted       bool
	Items         []flowItem
}

type flowItem struct {
	TestCaseID        uuid.UUID
	ContinueOnFailure bool
	Enabled           bool
	TestCase          *testCaseRow // nil when the test case row is gone
}

func loadFlow(ctx context.Context, q db.Querier, where string, args ...any) (*flowRow, error) {
	var f flowRow
	err := q.QueryRow(ctx, `
		SELECT f.id, p.key || '-F' || f.seq, f.name, f.revision, f.shared_session, f.stop_on_failure, f.variables, f.deleted_at IS NOT NULL
		FROM flows f JOIN projects p ON p.id = f.project_id `+where, args...).
		Scan(&f.ID, &f.Key, &f.Name, &f.Revision, &f.SharedSession, &f.StopOnFailure, &f.Variables, &f.Deleted)
	if db.IsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rows, err := q.Query(ctx, `SELECT test_case_id, continue_on_failure, enabled FROM flow_items WHERE flow_id = $1 ORDER BY position`, f.ID)
	if err != nil {
		return nil, err
	}
	var ids []uuid.UUID
	for rows.Next() {
		var it flowItem
		if err := rows.Scan(&it.TestCaseID, &it.ContinueOnFailure, &it.Enabled); err != nil {
			rows.Close()
			return nil, err
		}
		f.Items = append(f.Items, it)
		ids = append(ids, it.TestCaseID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) > 0 {
		rows, err := q.Query(ctx, testCaseSelect+" WHERE tc.id = ANY ($1)", ids)
		if err != nil {
			return nil, err
		}
		tcs, err := scanTestCases(rows)
		if err != nil {
			return nil, err
		}
		byID := map[uuid.UUID]*testCaseRow{}
		for i := range tcs {
			byID[tcs[i].ID] = &tcs[i]
		}
		for i := range f.Items {
			f.Items[i].TestCase = byID[f.Items[i].TestCaseID]
		}
	}
	return &f, nil
}

// validateTestCase mirrors the mock: DSL errors first, then "no steps".
func validateTestCase(tc *testCaseRow) error {
	errs, _ := dsl.Validate(tc.Steps, tc.Execution)
	if len(errs) > 0 {
		details := make([]httpx.FieldError, len(errs))
		for i, e := range errs {
			details[i] = httpx.Field(e.Path, e.Message)
		}
		return httpx.Unprocessable("Test case is not valid; fix it before running", details...)
	}
	if len(tc.Steps) == 0 {
		return httpx.Unprocessable("Test case has no steps")
	}
	return nil
}

// validateFlow mirrors the mock's flowValidation over every item (enabled or not).
func validateFlow(f *flowRow) error {
	var errs []httpx.FieldError
	if strings.TrimSpace(f.Name) == "" {
		errs = append(errs, httpx.Field("name", "Flow name is required"))
	}
	if len(f.Items) == 0 {
		errs = append(errs, httpx.Field("items", "A flow needs at least 1 test case"))
	}
	for i, it := range f.Items {
		path := "items[" + strconv.Itoa(i) + "]"
		switch {
		case it.TestCase == nil || it.TestCase.Deleted:
			errs = append(errs, httpx.Field(path, "Test case not found"))
		case f.SharedSession && it.TestCase.Execution == ExecutionManual:
			errs = append(errs, httpx.Field(path, "Manual test case "+it.TestCase.Key+" can't be in a flow with a shared session"))
		}
	}
	if len(errs) > 0 {
		return httpx.Unprocessable("Flow is not valid", errs...)
	}
	return nil
}

type envRow struct {
	ID          uuid.UUID
	Name        string
	Variables   map[string]string
	SecretNames []string
}

// loadEnv loads an environment of the project; where selects it (alias e).
func loadEnv(ctx context.Context, q db.Querier, where string, args ...any) (*envRow, error) {
	var (
		e   envRow
		raw []byte
	)
	err := q.QueryRow(ctx, `SELECT e.id, e.name, e.variables FROM environments e `+where, args...).Scan(&e.ID, &e.Name, &raw)
	if db.IsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var vars map[string]any
	if err := json.Unmarshal(raw, &vars); err != nil {
		return nil, fmt.Errorf("environment variables: %w", err)
	}
	e.Variables = make(map[string]string, len(vars))
	for k, v := range vars {
		switch t := v.(type) {
		case string:
			e.Variables[k] = t
		case nil:
			e.Variables[k] = ""
		default:
			b, _ := json.Marshal(t)
			e.Variables[k] = string(b)
		}
	}
	rows, err := q.Query(ctx, `SELECT name FROM environment_secrets WHERE environment_id = $1 ORDER BY name`, e.ID)
	if err != nil {
		return nil, err
	}
	e.SecretNames, err = pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	if e.SecretNames == nil {
		e.SecretNames = []string{}
	}
	return &e, nil
}

/* ------------------------------------------------------------------ options */

// DefaultRunOptions mirrors the projects.default_run_options column default
// and the mock's DEFAULT_RUN_OPTIONS.
var DefaultRunOptions = map[string]any{
	"browser":         "chromium",
	"headless":        true,
	"viewport":        map[string]any{"width": float64(1280), "height": float64(720)},
	"screenshot":      "on_failure",
	"video":           "off",
	"step_timeout_ms": float64(10000),
	"retries":         float64(0),
}

// mergeOptions = {...defaults, ...projectDefaults, ...partial} (shallow, like
// the mock) followed by validation. Unknown keys are kept.
func mergeOptions(projectDefaults, partial json.RawMessage) (json.RawMessage, error) {
	m := maps.Clone(DefaultRunOptions)
	var pd map[string]any
	if len(projectDefaults) > 0 && json.Unmarshal(projectDefaults, &pd) == nil {
		maps.Copy(m, pd)
	}
	if p := strings.TrimSpace(string(partial)); p != "" && p != "null" {
		var po map[string]any
		if err := json.Unmarshal(partial, &po); err != nil {
			return nil, httpx.Unprocessable("Invalid run options", httpx.Field("options", "Must be an object"))
		}
		maps.Copy(m, po)
	}
	if errs := validateOptions(m); len(errs) > 0 {
		return nil, httpx.Unprocessable("Invalid run options", errs...)
	}
	return json.Marshal(m)
}

func validateOptions(m map[string]any) []httpx.FieldError {
	var errs []httpx.FieldError
	oneOf := func(key string, allowed ...string) {
		if s, ok := m[key].(string); !ok || !slices.Contains(allowed, s) {
			errs = append(errs, httpx.Field("options."+key, "Must be one of: "+strings.Join(allowed, ", ")))
		}
	}
	intIn := func(v any, lo, hi float64) bool {
		f, ok := v.(float64)
		return ok && f == float64(int64(f)) && f >= lo && f <= hi
	}
	oneOf("browser", "chromium", "firefox", "webkit")
	oneOf("screenshot", "off", "on_failure", "every_step")
	oneOf("video", "off", "on_failure", "always")
	if _, ok := m["headless"].(bool); !ok {
		errs = append(errs, httpx.Field("options.headless", "Must be true or false"))
	}
	vp, ok := m["viewport"].(map[string]any)
	if !ok || !intIn(vp["width"], 1, 10000) || !intIn(vp["height"], 1, 10000) {
		errs = append(errs, httpx.Field("options.viewport", "Width and height must be positive integers"))
	}
	if !intIn(m["step_timeout_ms"], 1, 3_600_000) {
		errs = append(errs, httpx.Field("options.step_timeout_ms", "Must be a positive integer (ms)"))
	}
	if !intIn(m["retries"], 0, 2) {
		errs = append(errs, httpx.Field("options.retries", "Must be between 0 and 2"))
	}
	if v, ok := m["run_timeout_ms"]; ok && v != nil && !intIn(v, 1, 86_400_000) {
		errs = append(errs, httpx.Field("options.run_timeout_ms", "Must be a positive integer (ms)"))
	}
	return errs
}

/* ------------------------------------------------------------------ assignee */

// checkAssignee: the user must exist, not be disabled and be allowed to
// execute_manual in the project (editor / maintainer / admin).
func checkAssignee(ctx context.Context, q db.Querier, projectID uuid.UUID, userID string) (uuid.UUID, error) {
	invalid := httpx.Unprocessable("Assignee must be an editor or maintainer of the project", httpx.Field("assignee_id", "Choose an editor or maintainer"))
	id, err := uuid.Parse(strings.TrimSpace(userID))
	if err != nil {
		return uuid.Nil, invalid
	}
	var (
		sysRole, status string
		member          *string
	)
	err = q.QueryRow(ctx, `
		SELECT u.system_role, u.status, pm.role
		FROM users u LEFT JOIN project_members pm ON pm.project_id = $1 AND pm.user_id = u.id
		WHERE u.id = $2`, projectID, id).Scan(&sysRole, &status, &member)
	if db.IsNoRows(err) {
		return uuid.Nil, invalid
	}
	if err != nil {
		return uuid.Nil, err
	}
	if status == auth.StatusDisabled || !authz.Can(authz.EffectiveRole(member, sysRole), authz.ExecuteManual, sysRole) {
		return uuid.Nil, invalid
	}
	return id, nil
}

/* ------------------------------------------------------------------ insert */

// runSpec is a fully resolved and validated run to create.
type runSpec struct {
	project    authz.Project
	kind       string
	testCase   *testCaseRow
	flow       *flowRow
	env        *envRow
	options    json.RawMessage
	assigneeID *uuid.UUID // nil = the triggering user (only used when a manual case exists)
	trigger    string
	onlyCases  map[uuid.UUID]bool // rerun only_failed: test case ids to keep
	rerunOf    string
}

type plannedCase struct {
	snap  CaseSnapshot
	steps []dsl.Step
}

func (s *Service) insertRun(ctx context.Context, tx pgx.Tx, actor *auth.Actor, sp runSpec) (uuid.UUID, error) {
	envVars := map[string]string{}
	if sp.env != nil {
		envVars = sp.env.Variables
	}

	// Plan cases.
	var (
		cases       []plannedCase
		targetID    uuid.UUID
		targetKey   string
		targetTitle string
		shared      bool
		stop        = true
	)
	addCase := func(tc *testCaseRow, cont bool) {
		pc := plannedCase{steps: tc.Steps, snap: CaseSnapshot{
			RunCaseID: db.NewID(), Position: len(cases) + 1, TestCaseID: tc.ID, TestCaseKey: tc.Key,
			Revision: tc.Revision, Title: tc.Title, Execution: tc.Execution, ContinueOnFailure: cont,
			Variables: tc.Variables, Steps: tc.Steps,
		}}
		cases = append(cases, pc)
	}
	snap := Snapshot{Kind: sp.kind, Options: sp.options, RerunOf: sp.rerunOf}
	switch sp.kind {
	case KindTestCase:
		targetID, targetKey, targetTitle = sp.testCase.ID, sp.testCase.Key, sp.testCase.Title
		addCase(sp.testCase, false)
	case KindFlow:
		f := sp.flow
		targetID, targetKey, targetTitle = f.ID, f.Key, f.Name
		shared, stop = f.SharedSession, f.StopOnFailure
		snap.Flow = &FlowSnapshot{ID: f.ID, Key: f.Key, Name: f.Name, Revision: f.Revision,
			SharedSession: f.SharedSession, StopOnFailure: f.StopOnFailure, Variables: f.Variables}
		for _, it := range f.Items {
			if !it.Enabled || it.TestCase == nil || it.TestCase.Deleted {
				continue
			}
			if sp.onlyCases != nil && !sp.onlyCases[it.TestCaseID] {
				continue
			}
			addCase(it.TestCase, it.ContinueOnFailure)
		}
	default:
		return uuid.Nil, fmt.Errorf("unknown run kind %q", sp.kind)
	}
	snap.Target = Target{ID: targetID.String(), Key: targetKey, Title: targetTitle}
	snap.Cases = make([]CaseSnapshot, len(cases))
	hasManual := false
	for i, c := range cases {
		snap.Cases[i] = c.snap
		hasManual = hasManual || c.snap.Execution == ExecutionManual
	}
	var envID *uuid.UUID
	var envName *string
	if sp.env != nil {
		snap.Environment = &EnvSnapshot{ID: sp.env.ID, Name: sp.env.Name, Variables: sp.env.Variables, SecretNames: sp.env.SecretNames}
		envID, envName = &sp.env.ID, &sp.env.Name
	}
	snapJSON, err := json.Marshal(snap)
	if err != nil {
		return uuid.Nil, err
	}

	status := StatusQueued
	var errMsg *string
	firstManual := len(cases) > 0 && cases[0].snap.Execution == ExecutionManual
	switch {
	case len(cases) == 0:
		status = StatusError
		m := "No enabled test cases to run"
		errMsg = &m
	case firstManual:
		status = StatusAwaitingManual
	}
	var assignee *uuid.UUID
	if hasManual {
		if sp.assigneeID != nil {
			assignee = sp.assigneeID
		} else {
			id := actor.User.ID
			assignee = &id
		}
	}
	var resume *int
	if firstManual {
		one := 1
		resume = &one
	}

	var seq int
	if err := tx.QueryRow(ctx, `UPDATE projects SET seq_run = seq_run + 1 WHERE id = $1 RETURNING seq_run`, sp.project.ID).Scan(&seq); err != nil {
		return uuid.Nil, err
	}
	runID := db.NewID()
	runKey := sp.project.Key + "-R" + strconv.Itoa(seq)
	var tcID, flowID *uuid.UUID
	if sp.kind == KindTestCase {
		tcID = &targetID
	} else {
		flowID = &targetID
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO runs (id, project_id, seq, kind, test_case_id, flow_id, target_key, target_title,
			environment_id, environment_name, status, trigger, triggered_by, api_token_id, assignee_id,
			shared_session, stop_on_failure, resume_position, options, snapshot, error_message,
			started_at, finished_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
			CASE WHEN $22 THEN now() END, CASE WHEN $23 THEN now() END)`,
		runID, sp.project.ID, seq, sp.kind, tcID, flowID, targetKey, targetTitle,
		envID, envName, status, sp.trigger, actor.User.ID, actor.TokenID, assignee,
		shared, stop, resume, sp.options, snapJSON, errMsg,
		firstManual, len(cases) == 0)
	if err != nil {
		return uuid.Nil, err
	}

	batch := &pgx.Batch{}
	for _, c := range cases {
		cs := c.snap
		batch.Queue(`INSERT INTO run_cases (id, run_id, position, test_case_id, test_case_key, test_case_revision, title, execution, continue_on_failure)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			cs.RunCaseID, runID, cs.Position, cs.TestCaseID, cs.TestCaseKey, cs.Revision, cs.Title, cs.Execution, cs.ContinueOnFailure)
		for i, st := range c.steps {
			disp := dsl.DisplayStep(st, envVars)
			batch.Queue(`INSERT INTO run_steps (id, run_case_id, position, step_id, action, summary, description, expected, continue_on_failure, enabled)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
				db.NewID(), cs.RunCaseID, i+1, st.ID(), st.Action(), dsl.Summarize(disp),
				disp.Str("description"), disp.Str("expected"), st.Bool("continue_on_failure"), st.Enabled())
		}
	}
	if batch.Len() > 0 {
		if err := tx.SendBatch(ctx, batch).Close(); err != nil {
			return uuid.Nil, err
		}
	}

	if status == StatusQueued {
		if err := s.enq.EnqueueRun(ctx, tx, runID); err != nil {
			return uuid.Nil, fmt.Errorf("enqueue run: %w", err)
		}
	}
	meta := audit.Meta{"kind": sp.kind, "target": targetKey, "trigger": sp.trigger, "status": status}
	if sp.env != nil {
		meta["environment"] = sp.env.Name
	}
	if sp.rerunOf != "" {
		meta["rerun_of"] = sp.rerunOf
	}
	if err := audit.Record(ctx, tx, actor, "run.create", "run", runKey, &sp.project.ID, meta); err != nil {
		return uuid.Nil, err
	}
	if err := SyncLastRunStatus(ctx, tx, runID); err != nil {
		return uuid.Nil, err
	}
	evType := events.RunUpdated
	if status == StatusAwaitingManual {
		evType = events.AwaitingManual
	} else if status == StatusError {
		evType = events.RunFinished
	}
	// Delivered on commit.
	if err := events.Notify(ctx, tx, events.Event{Type: evType, RunKey: runKey, Status: status}); err != nil {
		return uuid.Nil, err
	}
	return runID, nil
}

// triggerFor picks the run trigger: explicit (MCP) wins, tokens are "api",
// browser sessions "manual".
func triggerFor(actor *auth.Actor, explicit string) (string, error) {
	switch explicit {
	case "":
		if actor.ViaToken() {
			return TriggerAPI, nil
		}
		return TriggerManual, nil
	case TriggerManual, TriggerAPI, TriggerMCP, TriggerSchedule:
		return explicit, nil
	}
	return "", fmt.Errorf("invalid run trigger %q", explicit)
}
