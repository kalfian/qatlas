package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/testcases"
)

// List page sizes for AI context budgets.
const (
	defaultListLimit = 25
	maxListLimit     = 100
)

// caseDefinition is the editable part of a test case. Every field is
// optional: on create omitted fields take defaults, on update they keep the
// current value.
type caseDefinition struct {
	Title         *string            `json:"title,omitempty" jsonschema:"Short behaviour-focused title (required on create)"`
	Description   *string            `json:"description,omitempty" jsonschema:"What the test covers and why"`
	Preconditions *string            `json:"preconditions,omitempty" jsonschema:"Required state before the first step (data, user, feature flags)"`
	Priority      *string            `json:"priority,omitempty" jsonschema:"low | medium | high | critical (default medium)"`
	Status        *string            `json:"status,omitempty" jsonschema:"draft | ready | deprecated (default draft)"`
	Execution     *string            `json:"execution,omitempty" jsonschema:"automated (default) or manual. Manual test cases contain only action=manual steps and are executed by a human"`
	Tags          *[]string          `json:"tags,omitempty" jsonschema:"Tags such as smoke, auth, checkout (replaces the whole list on update)"`
	Variables     *map[string]string `json:"variables,omitempty" jsonschema:"Test case variables used as {{vars.name}} (replaces the whole map on update)"`
	Steps         *[]map[string]any  `json:"steps,omitempty" jsonschema:"Ordered steps; each needs a unique id and an action. Schema: get_step_schema. Replaces the whole list on update"`
	FolderID      *string            `json:"folder_id,omitempty" jsonschema:"Folder id from list_folders, or \"root\" for no folder"`
}

func definitionTweak(s *jsonschema.Schema) {
	enum(prop(s, "priority"), testcases.Priorities...)
	enum(prop(s, "status"), testcases.Statuses...)
	enum(prop(s, "execution"), testcases.Executions...)
	// Tolerate extra fields (e.g. a get_test_case result passed back as is).
	s.AdditionalProperties = nil
}

// toInput converts the MCP definition into the service input.
func (d caseDefinition) toInput() (testcases.Input, error) {
	in := testcases.Input{
		Title: d.Title, Description: d.Description, Preconditions: d.Preconditions,
		Priority: d.Priority, Status: d.Status, Execution: d.Execution, Tags: d.Tags, Variables: d.Variables,
	}
	if d.FolderID != nil {
		v := strings.TrimSpace(*d.FolderID)
		if v == "" || strings.EqualFold(v, "root") {
			in.FolderID = httpx.Optional[string]{Set: true, Null: true}
		} else {
			in.FolderID = httpx.Optional[string]{Set: true, Value: v}
		}
	}
	if d.Steps != nil {
		steps := make([]json.RawMessage, len(*d.Steps))
		for i, st := range *d.Steps {
			raw, err := json.Marshal(st)
			if err != nil {
				return in, httpx.Unprocessable("Test case is not valid", httpx.Field(fmt.Sprintf("steps[%d]", i), "Step must be a JSON object"))
			}
			steps[i] = raw
		}
		in.Steps = &steps
	}
	return in, nil
}

func normKey(k string) string { return strings.ToUpper(strings.TrimSpace(k)) }

type listCasesInput struct {
	Project       string   `json:"project" jsonschema:"Project key, e.g. SHOP"`
	Query         string   `json:"query,omitempty" jsonschema:"Substring of the title or key"`
	Tags          []string `json:"tags,omitempty" jsonschema:"Only test cases having ALL of these tags"`
	Folder        string   `json:"folder,omitempty" jsonschema:"Folder id (sub-folders included) or \"root\""`
	Status        string   `json:"status,omitempty" jsonschema:"draft | ready | deprecated"`
	Execution     string   `json:"execution,omitempty" jsonschema:"automated | manual"`
	LastRunStatus string   `json:"last_run_status,omitempty" jsonschema:"Filter by the latest run result, e.g. failed"`
	Limit         int      `json:"limit,omitempty" jsonschema:"Page size, default 25, max 100"`
	Cursor        string   `json:"cursor,omitempty" jsonschema:"next_cursor from the previous page"`
}

type keyInput struct {
	Key string `json:"key" jsonschema:"Test case key, e.g. SHOP-T12"`
}

type validateInput struct {
	Project    string         `json:"project" jsonschema:"Project key, e.g. SHOP"`
	Definition caseDefinition `json:"definition" jsonschema:"The complete test case definition to check (same shape as create_test_case)"`
}

type createCaseInput struct {
	Project    string         `json:"project" jsonschema:"Project key, e.g. SHOP"`
	Definition caseDefinition `json:"definition" jsonschema:"Test case definition; title and steps are expected"`
}

type updateCaseInput struct {
	Key          string         `json:"key" jsonschema:"Test case key, e.g. SHOP-T12"`
	BaseRevision int            `json:"base_revision" jsonschema:"The revision you read with get_test_case. If someone changed the test case since, the update is rejected so their edit is not overwritten"`
	Definition   caseDefinition `json:"definition" jsonschema:"Only the fields to change; omitted fields keep their value. steps/tags/variables replace the whole value"`
	ChangeNote   string         `json:"change_note,omitempty" jsonschema:"Short reason shown in the revision history (default: Updated via MCP)"`
}

func pageOf(limit int, cursor string) (httpx.PageRequest, error) {
	p := httpx.PageRequest{Limit: defaultListLimit}
	if limit > 0 {
		p.Limit = min(limit, maxListLimit)
	}
	if cursor != "" {
		n, err := strconv.Atoi(strings.TrimSpace(cursor))
		if err != nil || n < 0 {
			return p, httpx.BadRequest("Invalid cursor", httpx.Field("cursor", "Use next_cursor from the previous page"))
		}
		p.Offset = n
	}
	return p, nil
}

func (s *Server) registerTestCaseTools() {
	addTool(s, &sdk.Tool{
		Name:        "list_test_cases",
		Title:       "List test cases",
		Description: "Search a project's test cases (newest key last). Returns key, title, status, execution, priority, tags, step count, revision and the latest run status. Paginated: pass next_cursor as cursor.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, auth.ScopeRead, func(sch *jsonschema.Schema) {
		enum(prop(sch, "status"), testcases.Statuses...)
		enum(prop(sch, "execution"), testcases.Executions...)
		prop(sch, "limit").Minimum, prop(sch, "limit").Maximum = ptr(1.0), ptr(float64(maxListLimit))
	}, s.listTestCases)

	addTool(s, &sdk.Tool{
		Name:        "get_test_case",
		Title:       "Get a test case",
		Description: "Full definition of one test case (steps, variables, tags, folder, status) plus its current revision. Use the revision as base_revision in update_test_case.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, auth.ScopeRead, nil, s.getTestCase)

	addTool(s, &sdk.Tool{
		Name:        "validate_test_case",
		Title:       "Validate a test case",
		Description: "Check a test case definition without saving it. Returns valid plus errors and warnings, each with a path such as steps[2].selector and a message. Fix all errors before create_test_case / update_test_case.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true},
	}, auth.ScopeRead, func(sch *jsonschema.Schema) { definitionTweak(prop(sch, "definition")) }, s.validateTestCase)

	addTool(s, &sdk.Tool{
		Name:        "create_test_case",
		Title:       "Create a test case",
		Description: "Create a test case in a project (revision 1). Returns the new key (e.g. SHOP-T31). Invalid definitions are rejected with per-path errors (same as validate_test_case).",
		Annotations: &sdk.ToolAnnotations{DestructiveHint: ptr(false)},
	}, auth.ScopeWrite, func(sch *jsonschema.Schema) { definitionTweak(prop(sch, "definition")) }, s.createTestCase)

	addTool(s, &sdk.Tool{
		Name:        "update_test_case",
		Title:       "Update a test case",
		Description: "Change a test case and record a new revision. base_revision must equal the current revision (read it with get_test_case); otherwise the call fails with revision_conflict and you must re-read the test case, re-apply your change on top of the latest version and retry.",
		Annotations: &sdk.ToolAnnotations{DestructiveHint: ptr(false)},
	}, auth.ScopeWrite, func(sch *jsonschema.Schema) {
		definitionTweak(prop(sch, "definition"))
		prop(sch, "base_revision").Minimum = ptr(1.0)
	}, s.updateTestCase)
}

type caseLine struct {
	Key           string   `json:"key"`
	Title         string   `json:"title"`
	Status        string   `json:"status"`
	Execution     string   `json:"execution"`
	Priority      string   `json:"priority"`
	Tags          []string `json:"tags"`
	StepCount     int      `json:"step_count"`
	Revision      int      `json:"revision"`
	LastRunStatus *string  `json:"last_run_status"`
}

func (s *Server) listTestCases(ctx context.Context, actor *auth.Actor, in listCasesInput) (*sdk.CallToolResult, error) {
	page, err := pageOf(in.Limit, in.Cursor)
	if err != nil {
		return nil, err
	}
	res, err := s.cases.List(ctx, actor, in.Project, testcases.ListFilter{
		Folder: strings.TrimSpace(in.Folder), Q: in.Query, Tags: in.Tags, Status: in.Status,
		Execution: in.Execution, LastRunStatus: in.LastRunStatus,
	}, page)
	if err != nil {
		return nil, err
	}
	items := make([]caseLine, 0, len(res.Data))
	for _, c := range res.Data {
		items = append(items, caseLine{Key: c.Key, Title: c.Title, Status: c.Status, Execution: c.Execution, Priority: c.Priority,
			Tags: c.Tags, StepCount: c.StepCount, Revision: c.Revision, LastRunStatus: c.LastRunStatus})
	}
	return jsonResult(map[string]any{"test_cases": items, "next_cursor": res.NextCursor})
}

type caseView struct {
	Key           string          `json:"key"`
	Title         string          `json:"title"`
	Description   string          `json:"description"`
	Preconditions string          `json:"preconditions"`
	Priority      string          `json:"priority"`
	Status        string          `json:"status"`
	Execution     string          `json:"execution"`
	Tags          []string        `json:"tags"`
	FolderID      *uuid.UUID      `json:"folder_id"`
	Variables     json.RawMessage `json:"variables"`
	Steps         json.RawMessage `json:"steps"`
	Revision      int             `json:"revision"`
	LastRunStatus *string         `json:"last_run_status"`
	UpdatedAt     time.Time       `json:"updated_at"`
	UpdatedBy     string          `json:"updated_by"`
}

func viewCase(tc testcases.TestCase) caseView {
	return caseView{
		Key: tc.Key, Title: tc.Title, Description: tc.Description, Preconditions: tc.Preconditions,
		Priority: tc.Priority, Status: tc.Status, Execution: tc.Execution, Tags: tc.Tags, FolderID: tc.FolderID,
		Variables: tc.Variables, Steps: tc.Steps, Revision: tc.Revision, LastRunStatus: tc.LastRunStatus,
		UpdatedAt: tc.UpdatedAt, UpdatedBy: tc.UpdatedBy.Name,
	}
}

func (s *Server) getTestCase(ctx context.Context, actor *auth.Actor, in keyInput) (*sdk.CallToolResult, error) {
	tc, err := s.cases.Get(ctx, actor, normKey(in.Key))
	if err != nil {
		return nil, err
	}
	return jsonResult(viewCase(tc))
}

func (s *Server) validateTestCase(ctx context.Context, actor *auth.Actor, in validateInput) (*sdk.CallToolResult, error) {
	input, err := in.Definition.toInput()
	if err != nil {
		return nil, err
	}
	res, err := s.cases.Validate(ctx, actor, in.Project, input)
	if err != nil {
		return nil, err
	}
	return jsonResult(res)
}

func (s *Server) createTestCase(ctx context.Context, actor *auth.Actor, in createCaseInput) (*sdk.CallToolResult, error) {
	input, err := in.Definition.toInput()
	if err != nil {
		return nil, err
	}
	tc, err := s.cases.Create(ctx, actor, in.Project, input)
	if err != nil {
		return nil, err
	}
	s.auditCall(ctx, actor, "create_test_case", "test_case", tc.Key)
	out := map[string]any{"key": tc.Key, "revision": tc.Revision, "title": tc.Title, "execution": tc.Execution, "status": tc.Status}
	if v, err := s.cases.Validate(ctx, actor, in.Project, input); err == nil && len(v.Warnings) > 0 {
		out["warnings"] = v.Warnings
	}
	out["next"] = "Run it with run_test_case(key=\"" + tc.Key + "\")."
	return jsonResult(out)
}

func (s *Server) updateTestCase(ctx context.Context, actor *auth.Actor, in updateCaseInput) (*sdk.CallToolResult, error) {
	key := normKey(in.Key)
	input, err := in.Definition.toInput()
	if err != nil {
		return nil, err
	}
	note := strings.TrimSpace(in.ChangeNote)
	if note == "" {
		note = "Updated via MCP"
	}
	rev := in.BaseRevision
	tc, err := s.cases.Update(ctx, actor, key, testcases.UpdateInput{Input: input, Revision: &rev, ChangeNote: &note})
	var apiErr *httpx.APIError
	if errors.As(err, &apiErr) && apiErr.Code == httpx.CodeRevisionConflict {
		msg := fmt.Sprintf("Test case %s was changed since revision %d", key, in.BaseRevision)
		if cur, gerr := s.cases.Get(ctx, actor, key); gerr == nil {
			msg += fmt.Sprintf(" (current revision %d, last updated by %s)", cur.Revision, cur.UpdatedBy.Name)
		}
		return nil, withHint(httpx.NewError(apiErr.Status, apiErr.Code, msg),
			"Do not retry blindly: call get_test_case(\""+key+"\") to read the latest definition, re-apply your change on top of it and call update_test_case with the new revision as base_revision.")
	}
	if err != nil {
		return nil, err
	}
	s.auditCall(ctx, actor, "update_test_case", "test_case", tc.Key)
	return jsonResult(map[string]any{"key": tc.Key, "revision": tc.Revision, "previous_revision": in.BaseRevision, "title": tc.Title, "status": tc.Status})
}
