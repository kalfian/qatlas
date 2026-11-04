package mcp

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/runs"
	"github.com/kalfian/qatlas/backend/internal/testcases"
)

type noInput struct{}

type projectInput struct {
	Project string `json:"project" jsonschema:"Project key, e.g. SHOP (see list_projects)"`
}

// runBrief is the compact run line used by several tools.
type runBrief struct {
	RunKey      string     `json:"run_key"`
	Status      string     `json:"status"`
	Kind        string     `json:"kind"`
	Target      string     `json:"target"`
	Environment *string    `json:"environment"`
	Trigger     string     `json:"trigger"`
	TriggeredBy string     `json:"triggered_by"`
	Cases       string     `json:"cases"` // "passed/total"
	QueuedAt    time.Time  `json:"queued_at"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`
	DurationMS  *int64     `json:"duration_ms,omitempty"`
}

func briefRun(r runs.RunSummary) runBrief {
	b := runBrief{
		RunKey: r.Key, Status: r.Status, Kind: r.Kind,
		Target:  r.Target.Key + " " + r.Target.Title,
		Trigger: r.Trigger, TriggeredBy: r.TriggeredBy.Name,
		Cases:    itoa(r.Summary.Cases.Passed) + "/" + itoa(r.Summary.Cases.Total) + " passed",
		QueuedAt: r.QueuedAt.UTC(), FinishedAt: auth.UTCPtr(r.FinishedAt), DurationMS: r.DurationMS,
	}
	if r.Environment != nil {
		b.Environment = &r.Environment.Name
	}
	if r.StartedAt == nil {
		b.DurationMS = nil
	}
	return b
}

func (s *Server) registerContextTools() {
	addTool(s, &sdk.Tool{
		Name:        "list_projects",
		Title:       "List projects",
		Description: "List the QAtlas projects this API token can access: key, name, your role (maintainer/editor/viewer), test case and flow counts and the latest run. Start here to find the project key used by every other tool.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, auth.ScopeRead, nil, s.listProjects)

	addTool(s, &sdk.Tool{
		Name:        "get_project",
		Title:       "Get project overview",
		Description: "Project overview: description, your role, default run options, test case/flow counts, tags in use, environments (non-secret variables and only the NAMES of secrets — reference them as {{env.NAME}} / {{secret.NAME}}) and the 5 most recent runs.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, auth.ScopeRead, nil, s.getProject)

	addTool(s, &sdk.Tool{
		Name:        "get_step_schema",
		Title:       "Get the step DSL schema",
		Description: "JSON Schema of a test case step (every action with its parameters), selector guidance, variable syntax, validation rules and two complete example test cases. Read this before writing or changing steps. Also available as resource qatlas://docs/step-dsl.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true},
	}, auth.ScopeRead, nil, func(context.Context, *auth.Actor, noInput) (*sdk.CallToolResult, error) {
		return jsonResult(stepSchemaDoc())
	})

	addTool(s, &sdk.Tool{
		Name:        "list_folders",
		Title:       "List test case folders",
		Description: "Folder tree of a project as a flat list with full paths (e.g. \"Checkout/Payments\"), ids and direct test case counts. Use a folder id as `folder` in list_test_cases or as `folder_id` when creating a test case.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, auth.ScopeRead, nil, s.listFolders)
}

type projectLine struct {
	Key           string    `json:"key"`
	Name          string    `json:"name"`
	Role          string    `json:"role"`
	TestCaseCount int       `json:"test_case_count"`
	FlowCount     int       `json:"flow_count"`
	PassRate7d    *float64  `json:"pass_rate_7d"`
	LastRun       *runBrief `json:"last_run"`
}

func (s *Server) listProjects(ctx context.Context, actor *auth.Actor, _ noInput) (*sdk.CallToolResult, error) {
	list, err := s.projects.List(ctx, actor, false)
	if err != nil {
		return nil, err
	}
	out := make([]projectLine, 0, len(list))
	for _, p := range list {
		l := projectLine{Key: p.Key, Name: p.Name, Role: string(p.MyRole), TestCaseCount: p.TestCaseCount, FlowCount: p.FlowCount, PassRate7d: p.PassRate7d}
		if p.LastRun != nil {
			b := briefRun(*p.LastRun)
			l.LastRun = &b
		}
		out = append(out, l)
	}
	return jsonResult(map[string]any{"projects": out})
}

type envLine struct {
	Name        string            `json:"name"`
	IsDefault   bool              `json:"is_default"`
	Variables   map[string]string `json:"variables"`
	SecretNames []string          `json:"secret_names"`
}

func (s *Server) getProject(ctx context.Context, actor *auth.Actor, in projectInput) (*sdk.CallToolResult, error) {
	p, err := s.projects.Get(ctx, actor, in.Project)
	if err != nil {
		return nil, err
	}
	out := map[string]any{
		"key": p.Key, "name": p.Name, "description": p.Description, "role": p.MyRole,
		"archived": p.ArchivedAt != nil, "default_run_options": p.DefaultRunOptions,
	}
	list, err := s.projects.List(ctx, actor, true)
	if err != nil {
		return nil, err
	}
	for _, ps := range list {
		if ps.Key == p.Key {
			out["test_case_count"], out["flow_count"], out["pass_rate_7d"] = ps.TestCaseCount, ps.FlowCount, ps.PassRate7d
		}
	}
	envs, err := s.envs.List(ctx, actor, p.Key)
	if err != nil {
		return nil, err
	}
	el := make([]envLine, 0, len(envs))
	for _, e := range envs {
		names := make([]string, 0, len(e.Secrets))
		for _, sec := range e.Secrets {
			names = append(names, sec.Name)
		}
		el = append(el, envLine{Name: e.Name, IsDefault: e.IsDefault, Variables: e.Variables, SecretNames: names})
	}
	out["environments"] = el
	tags, err := s.cases.Tags(ctx, actor, p.Key)
	if err != nil {
		return nil, err
	}
	tl := make([]string, 0, len(tags))
	for _, t := range tags {
		tl = append(tl, t.Tag+" ("+itoa(t.Count)+")")
	}
	out["tags"] = tl
	recent, err := s.runs.List(ctx, actor, p.Key, runs.ListFilter{Page: httpx.PageRequest{Limit: 5}})
	if err != nil {
		return nil, err
	}
	rl := make([]runBrief, 0, len(recent.Data))
	for _, r := range recent.Data {
		rl = append(rl, briefRun(r))
	}
	out["recent_runs"] = rl
	return jsonResult(out)
}

type folderLine struct {
	ID            uuid.UUID `json:"id"`
	Path          string    `json:"path"`
	TestCaseCount int       `json:"test_case_count"`
}

func (s *Server) listFolders(ctx context.Context, actor *auth.Actor, in projectInput) (*sdk.CallToolResult, error) {
	folders, err := s.cases.ListFolders(ctx, actor, in.Project)
	if err != nil {
		return nil, err
	}
	byID := make(map[uuid.UUID]testcases.Folder, len(folders))
	for _, f := range folders {
		byID[f.ID] = f
	}
	pathOf := func(f testcases.Folder) string {
		parts := []string{f.Name}
		seen := map[uuid.UUID]bool{f.ID: true}
		for f.ParentID != nil && !seen[*f.ParentID] {
			parent, ok := byID[*f.ParentID]
			if !ok {
				break
			}
			seen[parent.ID] = true
			parts = append([]string{parent.Name}, parts...)
			f = parent
		}
		return strings.Join(parts, "/")
	}
	out := make([]folderLine, 0, len(folders))
	for _, f := range folders {
		out = append(out, folderLine{ID: f.ID, Path: pathOf(f), TestCaseCount: f.TestCaseCount})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return jsonResult(map[string]any{"folders": out, "note": "Test cases outside any folder: use folder=\"root\" in list_test_cases."})
}
