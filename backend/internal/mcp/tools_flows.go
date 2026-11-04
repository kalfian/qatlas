package mcp

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/flows"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

type flowItemInput struct {
	TestCase          string `json:"test_case" jsonschema:"Test case key in the same project, e.g. SHOP-T7"`
	ContinueOnFailure bool   `json:"continue_on_failure,omitempty" jsonschema:"Keep running the next items even if this one fails (default false)"`
	Enabled           *bool  `json:"enabled,omitempty" jsonschema:"false = skip this item when the flow runs (default true)"`
}

type listFlowsInput struct {
	Project string `json:"project" jsonschema:"Project key, e.g. SHOP"`
	Query   string `json:"query,omitempty" jsonschema:"Substring of the flow name or key"`
	Limit   int    `json:"limit,omitempty" jsonschema:"Page size, default 25, max 100"`
	Cursor  string `json:"cursor,omitempty" jsonschema:"next_cursor from the previous page"`
}

type flowKeyInput struct {
	Key string `json:"key" jsonschema:"Flow key, e.g. SHOP-F3"`
}

type createFlowInput struct {
	Project       string            `json:"project" jsonschema:"Project key, e.g. SHOP"`
	Name          string            `json:"name" jsonschema:"Flow name, e.g. Checkout happy path"`
	Items         []flowItemInput   `json:"items" jsonschema:"Ordered test cases to run (at least one)"`
	Description   string            `json:"description,omitempty" jsonschema:"What the flow covers"`
	Tags          []string          `json:"tags,omitempty" jsonschema:"Tags such as smoke, regression"`
	SharedSession *bool             `json:"shared_session,omitempty" jsonschema:"true = one browser context for the whole flow (login carries over, runtime vars pass to the next case); manual test cases are not allowed then. Default false"`
	StopOnFailure *bool             `json:"stop_on_failure,omitempty" jsonschema:"true (default) = skip the remaining items after a failure unless that item has continue_on_failure"`
	Variables     map[string]string `json:"variables,omitempty" jsonschema:"Flow variables ({{vars.name}}); test case variables override them"`
}

type updateFlowInput struct {
	Key           string             `json:"key" jsonschema:"Flow key, e.g. SHOP-F3"`
	BaseRevision  int                `json:"base_revision" jsonschema:"The revision you read with get_flow; a stale value is rejected (revision_conflict)"`
	Name          *string            `json:"name,omitempty" jsonschema:"New name (omit to keep)"`
	Items         *[]flowItemInput   `json:"items,omitempty" jsonschema:"New complete item list (omit to keep the current items)"`
	Description   *string            `json:"description,omitempty" jsonschema:"New description (omit to keep)"`
	Tags          *[]string          `json:"tags,omitempty" jsonschema:"New tag list (omit to keep)"`
	SharedSession *bool              `json:"shared_session,omitempty" jsonschema:"Omit to keep"`
	StopOnFailure *bool              `json:"stop_on_failure,omitempty" jsonschema:"Omit to keep"`
	Variables     *map[string]string `json:"variables,omitempty" jsonschema:"New complete variables map (omit to keep)"`
}

func (s *Server) registerFlowTools() {
	addTool(s, &sdk.Tool{
		Name:        "list_flows",
		Title:       "List flows",
		Description: "List a project's flows (ordered groups of test cases run together): key, name, item count, whether it contains manual cases, session/stop options and the latest run status. Paginated.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, auth.ScopeRead, func(sch *jsonschema.Schema) {
		prop(sch, "limit").Minimum, prop(sch, "limit").Maximum = ptr(1.0), ptr(float64(maxListLimit))
	}, s.listFlows)

	addTool(s, &sdk.Tool{
		Name:        "get_flow",
		Title:       "Get a flow",
		Description: "Full flow definition: options, variables, revision and the ordered items (test case key, title, execution, enabled, continue_on_failure). Use the revision as base_revision in update_flow.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, auth.ScopeRead, nil, s.getFlow)

	addTool(s, &sdk.Tool{
		Name:        "create_flow",
		Title:       "Create a flow",
		Description: "Create a flow from test case keys of the same project. Returns the new flow key (e.g. SHOP-F4). Run it with run_flow.",
		Annotations: &sdk.ToolAnnotations{DestructiveHint: ptr(false)},
	}, auth.ScopeWrite, func(sch *jsonschema.Schema) { prop(sch, "items").MinItems = ptr(1) }, s.createFlow)

	addTool(s, &sdk.Tool{
		Name:        "update_flow",
		Title:       "Update a flow",
		Description: "Change a flow. Only the given fields change; items, tags and variables replace the whole value. base_revision must be the current revision (get_flow), otherwise revision_conflict: re-read and retry.",
		Annotations: &sdk.ToolAnnotations{DestructiveHint: ptr(false)},
	}, auth.ScopeWrite, func(sch *jsonschema.Schema) { prop(sch, "base_revision").Minimum = ptr(1.0) }, s.updateFlow)
}

type flowLine struct {
	Key           string   `json:"key"`
	Name          string   `json:"name"`
	ItemCount     int      `json:"item_count"`
	HasManual     bool     `json:"has_manual"`
	SharedSession bool     `json:"shared_session"`
	StopOnFailure bool     `json:"stop_on_failure"`
	Tags          []string `json:"tags"`
	LastRunStatus *string  `json:"last_run_status"`
}

func (s *Server) listFlows(ctx context.Context, actor *auth.Actor, in listFlowsInput) (*sdk.CallToolResult, error) {
	page, err := pageOf(in.Limit, in.Cursor)
	if err != nil {
		return nil, err
	}
	all, err := s.flows.List(ctx, actor, in.Project, strings.TrimSpace(in.Query))
	if err != nil {
		return nil, err
	}
	lines := make([]flowLine, 0, len(all))
	for _, f := range all {
		lines = append(lines, flowLine{Key: f.Key, Name: f.Name, ItemCount: f.ItemCount, HasManual: f.HasManual,
			SharedSession: f.SharedSession, StopOnFailure: f.StopOnFailure, Tags: f.Tags, LastRunStatus: f.LastRunStatus})
	}
	p := httpx.Paginate(lines, page)
	return jsonResult(map[string]any{"flows": p.Data, "next_cursor": p.NextCursor})
}

type flowItemView struct {
	TestCase          string `json:"test_case"`
	Title             string `json:"title"`
	Execution         string `json:"execution"`
	Status            string `json:"status"`
	Enabled           bool   `json:"enabled"`
	ContinueOnFailure bool   `json:"continue_on_failure"`
}

func viewFlow(f flows.Flow) map[string]any {
	items := make([]flowItemView, 0, len(f.Items))
	for _, it := range f.Items {
		items = append(items, flowItemView{TestCase: it.TestCase.Key, Title: it.TestCase.Title, Execution: it.TestCase.Execution,
			Status: it.TestCase.Status, Enabled: it.Enabled, ContinueOnFailure: it.ContinueOnFailure})
	}
	return map[string]any{
		"key": f.Key, "name": f.Name, "description": f.Description, "tags": f.Tags,
		"shared_session": f.SharedSession, "stop_on_failure": f.StopOnFailure, "variables": f.Variables,
		"revision": f.Revision, "has_manual": f.HasManual, "last_run_status": f.LastRunStatus, "items": items,
	}
}

func (s *Server) getFlow(ctx context.Context, actor *auth.Actor, in flowKeyInput) (*sdk.CallToolResult, error) {
	f, err := s.flows.Get(ctx, actor, normKey(in.Key))
	if err != nil {
		return nil, err
	}
	return jsonResult(viewFlow(f))
}

// resolveItems maps test case keys to ids (view access, same project).
func (s *Server) resolveItems(ctx context.Context, actor *auth.Actor, projectKey string, items []flowItemInput) ([]flows.ItemInput, error) {
	projectKey = normKey(projectKey)
	out := make([]flows.ItemInput, len(items))
	var errs []httpx.FieldError
	for i, it := range items {
		key := normKey(it.TestCase)
		out[i] = flows.ItemInput{ContinueOnFailure: it.ContinueOnFailure, Enabled: it.Enabled}
		if authz.ProjectKeyOf(key) != projectKey {
			errs = append(errs, httpx.Field(fmt.Sprintf("items[%d].test_case", i), "Test case "+key+" is not in project "+projectKey))
			continue
		}
		tc, err := s.cases.Get(ctx, actor, key)
		var apiErr *httpx.APIError
		if errors.As(err, &apiErr) && apiErr.Code == httpx.CodeNotFound {
			errs = append(errs, httpx.Field(fmt.Sprintf("items[%d].test_case", i), "Test case "+key+" not found"))
			continue
		}
		if err != nil {
			return nil, err
		}
		out[i].TestCaseID = tc.ID.String()
	}
	if len(errs) > 0 {
		return nil, httpx.Unprocessable("Flow is not valid", errs...)
	}
	return out, nil
}

func (s *Server) createFlow(ctx context.Context, actor *auth.Actor, in createFlowInput) (*sdk.CallToolResult, error) {
	if _, _, err := authz.ProjectAccess(ctx, s.pool, actor, in.Project, authz.EditTests); err != nil {
		return nil, err
	}
	items, err := s.resolveItems(ctx, actor, in.Project, in.Items)
	if err != nil {
		return nil, err
	}
	fin := flows.Input{Name: &in.Name, Description: &in.Description, Tags: &in.Tags,
		SharedSession: in.SharedSession, StopOnFailure: in.StopOnFailure, Items: items}
	if in.Variables != nil {
		fin.Variables = &in.Variables
	}
	f, err := s.flows.Create(ctx, actor, in.Project, fin)
	if err != nil {
		return nil, err
	}
	s.auditCall(ctx, actor, "create_flow", "flow", f.Key)
	return jsonResult(map[string]any{"key": f.Key, "revision": f.Revision, "name": f.Name, "item_count": len(f.Items),
		"next": "Run it with run_flow(key=\"" + f.Key + "\")."})
}

func (s *Server) updateFlow(ctx context.Context, actor *auth.Actor, in updateFlowInput) (*sdk.CallToolResult, error) {
	key := normKey(in.Key)
	// The REST PATCH replaces name and items; fill omitted ones from the current flow.
	cur, err := s.flows.Get(ctx, actor, key)
	if err != nil {
		return nil, err
	}
	fin := flows.Input{Name: in.Name, Description: in.Description, Tags: in.Tags,
		SharedSession: in.SharedSession, StopOnFailure: in.StopOnFailure, Variables: in.Variables}
	if fin.Name == nil {
		fin.Name = &cur.Name
	}
	if in.Items != nil {
		fin.Items, err = s.resolveItems(ctx, actor, authz.ProjectKeyOf(key), *in.Items)
		if err != nil {
			return nil, err
		}
	} else {
		for _, it := range cur.Items {
			fin.Items = append(fin.Items, flows.ItemInput{TestCaseID: it.TestCase.ID.String(), ContinueOnFailure: it.ContinueOnFailure, Enabled: ptr(it.Enabled)})
		}
	}
	rev := in.BaseRevision
	f, err := s.flows.Update(ctx, actor, key, flows.UpdateInput{Input: fin, Revision: &rev})
	var apiErr *httpx.APIError
	if errors.As(err, &apiErr) && apiErr.Code == httpx.CodeRevisionConflict {
		msg := fmt.Sprintf("Flow %s was changed since revision %d", key, in.BaseRevision)
		if latest, gerr := s.flows.Get(ctx, actor, key); gerr == nil {
			msg += fmt.Sprintf(" (current revision %d)", latest.Revision)
		}
		return nil, withHint(httpx.NewError(apiErr.Status, apiErr.Code, msg),
			"Call get_flow(\""+key+"\") to read the latest version, re-apply your change and retry with its revision as base_revision.")
	}
	if err != nil {
		return nil, err
	}
	s.auditCall(ctx, actor, "update_flow", "flow", f.Key)
	return jsonResult(map[string]any{"key": f.Key, "revision": f.Revision, "previous_revision": in.BaseRevision, "item_count": len(f.Items)})
}
