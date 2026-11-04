package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/events"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/runs"
)

type viewportInput struct {
	Width  int `json:"width" jsonschema:"Viewport width in px"`
	Height int `json:"height" jsonschema:"Viewport height in px"`
}

// runOptionsInput overrides the project's default run options for one run.
type runOptionsInput struct {
	Browser       string         `json:"browser,omitempty" jsonschema:"chromium | firefox | webkit"`
	Headless      *bool          `json:"headless,omitempty" jsonschema:"Run the browser headless (default true)"`
	Screenshot    string         `json:"screenshot,omitempty" jsonschema:"off | on_failure | every_step (default on_failure)"`
	Video         string         `json:"video,omitempty" jsonschema:"off | on_failure | always (default off)"`
	StepTimeoutMS int            `json:"step_timeout_ms,omitempty" jsonschema:"Default timeout per step in ms (default 10000)"`
	Retries       *int           `json:"retries,omitempty" jsonschema:"Retries of a failed case, 0-2 (default 0)"`
	Viewport      *viewportInput `json:"viewport,omitempty" jsonschema:"Browser viewport (default 1280x720)"`
}

func (o *runOptionsInput) raw() (json.RawMessage, error) {
	if o == nil {
		return nil, nil
	}
	m := map[string]any{}
	if o.Browser != "" {
		m["browser"] = o.Browser
	}
	if o.Headless != nil {
		m["headless"] = *o.Headless
	}
	if o.Screenshot != "" {
		m["screenshot"] = o.Screenshot
	}
	if o.Video != "" {
		m["video"] = o.Video
	}
	if o.StepTimeoutMS != 0 {
		m["step_timeout_ms"] = o.StepTimeoutMS
	}
	if o.Retries != nil {
		m["retries"] = *o.Retries
	}
	if o.Viewport != nil {
		m["viewport"] = map[string]int{"width": o.Viewport.Width, "height": o.Viewport.Height}
	}
	if len(m) == 0 {
		return nil, nil
	}
	return json.Marshal(m)
}

func optionsTweak(s *jsonschema.Schema) {
	enum(prop(s, "browser"), "chromium", "firefox", "webkit")
	enum(prop(s, "screenshot"), "off", "on_failure", "every_step")
	enum(prop(s, "video"), "off", "on_failure", "always")
	prop(s, "retries").Minimum, prop(s, "retries").Maximum = ptr(0.0), ptr(2.0)
	prop(s, "step_timeout_ms").Minimum = ptr(1.0)
}

type runTestCaseInput struct {
	Key         string           `json:"key" jsonschema:"Test case key, e.g. SHOP-T31"`
	Environment string           `json:"environment,omitempty" jsonschema:"Environment name (see get_project), e.g. staging; default = the project's default environment"`
	Options     *runOptionsInput `json:"options,omitempty" jsonschema:"Overrides of the project's default run options"`
}

type runFlowInput struct {
	Key         string           `json:"key" jsonschema:"Flow key, e.g. SHOP-F3"`
	Environment string           `json:"environment,omitempty" jsonschema:"Environment name (see get_project); default = the project's default environment"`
	Options     *runOptionsInput `json:"options,omitempty" jsonschema:"Overrides of the project's default run options"`
}

type waitInput struct {
	RunKey   string `json:"run_key" jsonschema:"Run key, e.g. SHOP-R210"`
	TimeoutS int    `json:"timeout_s,omitempty" jsonschema:"Seconds to wait for the run to finish, 1-120 (default 60). If it is still running, call wait_for_run again"`
}

type runKeyInput struct {
	RunKey string `json:"run_key" jsonschema:"Run key, e.g. SHOP-R210"`
}

type listRunsInput struct {
	Project string `json:"project" jsonschema:"Project key, e.g. SHOP"`
	Status  string `json:"status,omitempty" jsonschema:"queued | running | awaiting_manual | passed | failed | blocked | error | cancelled"`
	Target  string `json:"target,omitempty" jsonschema:"Test case or flow key/title (partial match), e.g. SHOP-T12"`
	Kind    string `json:"kind,omitempty" jsonschema:"test_case | flow"`
	Trigger string `json:"trigger,omitempty" jsonschema:"manual | api | mcp | schedule"`
	Limit   int    `json:"limit,omitempty" jsonschema:"Page size, default 25, max 100"`
	Cursor  string `json:"cursor,omitempty" jsonschema:"next_cursor from the previous page"`
}

var runStatuses = []string{runs.StatusQueued, runs.StatusRunning, runs.StatusAwaitingManual, runs.StatusPassed,
	runs.StatusFailed, runs.StatusBlocked, runs.StatusError, runs.StatusCancelled}

func (s *Server) registerRunTools() {
	addTool(s, &sdk.Tool{
		Name:        "run_test_case",
		Title:       "Run a test case",
		Description: "Queue a run of one test case. Returns run_key and status (queued, or awaiting_manual for a manual test case — a human executes those in the QAtlas UI). Then call wait_for_run. At most 3 runs started through MCP per token may be queued/running at once.",
		Annotations: &sdk.ToolAnnotations{DestructiveHint: ptr(false), OpenWorldHint: ptr(true)},
	}, auth.ScopeRun, func(sch *jsonschema.Schema) { optionsTweak(prop(sch, "options")) }, func(ctx context.Context, a *auth.Actor, in runTestCaseInput) (*sdk.CallToolResult, error) {
		return s.startRun(ctx, a, "run_test_case", runs.KindTestCase, in.Key, in.Environment, in.Options)
	})

	addTool(s, &sdk.Tool{
		Name:        "run_flow",
		Title:       "Run a flow",
		Description: "Queue a run of a flow (its enabled test cases in order). Returns run_key. Then call wait_for_run. The same per-token limit as run_test_case applies.",
		Annotations: &sdk.ToolAnnotations{DestructiveHint: ptr(false), OpenWorldHint: ptr(true)},
	}, auth.ScopeRun, func(sch *jsonschema.Schema) { optionsTweak(prop(sch, "options")) }, func(ctx context.Context, a *auth.Actor, in runFlowInput) (*sdk.CallToolResult, error) {
		return s.startRun(ctx, a, "run_flow", runs.KindFlow, in.Key, in.Environment, in.Options)
	})

	addTool(s, &sdk.Tool{
		Name:  "wait_for_run",
		Title: "Wait for a run",
		Description: "Block until the run finishes or timeout_s (max 120) elapses, then return its status and progress. done=false → call wait_for_run again. " +
			"status=awaiting_manual → a human (the assignee) must execute manual steps in the QAtlas UI: stop waiting and tell the user. When done, use get_run_report for step details and screenshots.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, auth.ScopeRead, func(sch *jsonschema.Schema) {
		prop(sch, "timeout_s").Minimum, prop(sch, "timeout_s").Maximum = ptr(1.0), ptr(float64(MaxWaitSeconds))
	}, s.waitForRun)

	addTool(s, &sdk.Tool{
		Name:  "get_run_report",
		Title: "Get a run report",
		Description: "Detailed result of a run: summary, every case with its steps (status, duration, error message, expected vs actual details). Failed steps are shown in full, passed steps briefly. " +
			"include_screenshots: none | failed (default; screenshots of failed steps) | all — screenshots are returned as images (max 5, ≤1 MB each). Secret values never appear (masked as ••••).",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, auth.ScopeRead, func(sch *jsonschema.Schema) {
		enum(prop(sch, "include_screenshots"), "none", "failed", "all")
	}, s.getRunReport)

	addTool(s, &sdk.Tool{
		Name:        "list_runs",
		Title:       "List runs",
		Description: "Recent runs of a project, newest first, with status, target, environment, trigger and pass counts. Filter by status, target (test case/flow key), kind or trigger. Paginated.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, auth.ScopeRead, func(sch *jsonschema.Schema) {
		enum(prop(sch, "status"), runStatuses...)
		enum(prop(sch, "kind"), runs.KindTestCase, runs.KindFlow)
		enum(prop(sch, "trigger"), runs.TriggerManual, runs.TriggerAPI, runs.TriggerMCP, runs.TriggerSchedule)
		prop(sch, "limit").Minimum, prop(sch, "limit").Maximum = ptr(1.0), ptr(float64(maxListLimit))
	}, s.listRuns)

	addTool(s, &sdk.Tool{
		Name:        "cancel_run",
		Title:       "Cancel a run",
		Description: "Cancel a queued, running or awaiting_manual run. Editors can cancel their own runs, maintainers any run. A running run stops after the current step (status cancel_requested until then).",
		Annotations: &sdk.ToolAnnotations{DestructiveHint: ptr(true), IdempotentHint: true},
	}, auth.ScopeRun, nil, s.cancelRun)
}

// resolveEnv maps an environment name (case-insensitive) or id to its id.
func (s *Server) resolveEnv(ctx context.Context, actor *auth.Actor, projectKey, name string) (*string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, nil
	}
	envs, err := s.envs.List(ctx, actor, projectKey)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(envs))
	for _, e := range envs {
		if strings.EqualFold(e.Name, name) || e.ID.String() == name {
			id := e.ID.String()
			return &id, nil
		}
		names = append(names, e.Name)
	}
	avail := "none"
	if len(names) > 0 {
		avail = strings.Join(names, ", ")
	}
	return nil, httpx.Unprocessable("Environment "+name+" not found", httpx.Field("environment", "Available environments: "+avail))
}

func (s *Server) startRun(ctx context.Context, actor *auth.Actor, tool, kind, key, env string, opts *runOptionsInput) (*sdk.CallToolResult, error) {
	key = normKey(key)
	projectKey := authz.ProjectKeyOf(key)
	envID, err := s.resolveEnv(ctx, actor, projectKey, env)
	if err != nil {
		return nil, err
	}
	raw, err := opts.raw()
	if err != nil {
		return nil, err
	}
	in := runs.CreateInput{EnvironmentID: envID, Options: raw, Trigger: runs.TriggerMCP}
	if kind == runs.KindTestCase {
		in.TestCase = key
	} else {
		in.Flow = key
	}

	var run runs.Run
	err = func() error {
		if actor.TokenID != nil {
			mu := s.runLock(*actor.TokenID)
			mu.Lock()
			defer mu.Unlock()
			if err := s.checkRunLimit(ctx, actor); err != nil {
				return err
			}
		}
		var err error
		run, err = s.runs.Create(ctx, actor, projectKey, in)
		return err
	}()
	if err != nil {
		return nil, err
	}
	s.auditCall(ctx, actor, tool, "run", run.Key)

	out := map[string]any{
		"run_key": run.Key, "status": run.Status, "kind": run.Kind,
		"target": run.Target.Key + " " + run.Target.Title, "has_manual": run.HasManual,
		"cases": len(run.Cases), "url": s.runURL(run),
	}
	if run.Environment != nil {
		out["environment"] = run.Environment.Name
	} else {
		out["environment"] = nil
	}
	if run.Assignee != nil {
		out["manual_assignee"] = run.Assignee.Name + " <" + run.Assignee.Email + ">"
	}
	switch run.Status {
	case runs.StatusAwaitingManual:
		out["next"] = "The first case is manual: a human must execute it in the QAtlas UI. Tell the user; you cannot record manual results."
	case runs.StatusError:
		out["error_message"] = run.ErrorMessage
		out["next"] = "The run could not start; see error_message."
	default:
		out["next"] = "Call wait_for_run(run_key=\"" + run.Key + "\")."
	}
	return jsonResult(out)
}

func (s *Server) runURL(r runs.Run) string {
	return s.baseURL + "/p/" + r.ProjectKey + "/runs/" + r.Key
}

func (s *Server) waitForRun(ctx context.Context, actor *auth.Actor, in waitInput) (*sdk.CallToolResult, error) {
	key := normKey(in.RunKey)
	timeout := 60
	if in.TimeoutS > 0 {
		timeout = min(in.TimeoutS, MaxWaitSeconds)
	}
	deadline := time.Now().Add(time.Duration(timeout) * time.Second)
	run, err := s.runs.Get(ctx, actor, key)
	for err == nil && !runs.IsFinal(run.Status) && run.Status != runs.StatusAwaitingManual {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		// WaitForChange returns on any run event (each step emits one), so loop
		// until the run settles or the deadline passes.
		next, _, werr := s.runs.WaitForChange(ctx, actor, key, remaining)
		if errors.Is(werr, events.ErrClosed) {
			break // server shutting down: report the last known state, the AI polls again
		}
		run, err = next, werr
	}
	if err != nil {
		return nil, err
	}
	return jsonResult(s.statusView(run))
}

type failureLine struct {
	Case    string  `json:"case"`
	StepID  string  `json:"step_id,omitempty"`
	Summary string  `json:"summary,omitempty"`
	Status  string  `json:"status"`
	Error   *string `json:"error,omitempty"`
}

// statusView is wait_for_run's compact answer.
func (s *Server) statusView(run runs.Run) map[string]any {
	done := runs.IsFinal(run.Status)
	out := map[string]any{
		"run_key": run.Key, "status": run.Status, "done": done,
		"target":   run.Target.Key + " " + run.Target.Title,
		"progress": map[string]any{"cases": run.Summary.Cases, "steps": run.Summary.Steps},
		"url":      s.runURL(run),
	}
	if run.Environment != nil {
		out["environment"] = run.Environment.Name
	}
	if run.StartedAt != nil {
		out["duration_ms"] = run.DurationMS
	}
	if run.ErrorMessage != nil {
		out["error_message"] = truncate(*run.ErrorMessage, 1000)
	}
	if run.CancelRequested && !done {
		out["cancel_requested"] = true
	}
	switch {
	case run.Status == runs.StatusAwaitingManual:
		am := map[string]any{"message": "A human must execute the manual test case in the QAtlas UI. Stop waiting and tell the user (the run continues automatically afterwards)."}
		if run.Assignee != nil {
			am["assignee"] = run.Assignee.Name + " <" + run.Assignee.Email + ">"
		}
		if run.ResumePosition != nil {
			for _, c := range run.Cases {
				if c.Position == *run.ResumePosition {
					am["case"] = c.TestCaseKey + " " + c.Title
				}
			}
		}
		out["awaiting_manual"] = am
		out["next"] = "Stop polling; tell the user who must execute the manual part."
	case done:
		var fails []failureLine
		for _, c := range run.Cases {
			caseFailed := c.Status == runs.StepFailed || c.Status == runs.StepError
			stepFound := false
			for _, st := range c.Steps {
				if st.Status == runs.StepFailed || st.Status == runs.StepError {
					stepFound = true
					if len(fails) < 5 {
						fails = append(fails, failureLine{Case: c.TestCaseKey, StepID: st.StepID, Summary: st.Summary, Status: st.Status, Error: truncatePtr(st.ErrorMessage, 300)})
					}
				}
			}
			if caseFailed && !stepFound && len(fails) < 5 {
				fails = append(fails, failureLine{Case: c.TestCaseKey, Status: c.Status})
			}
		}
		if len(fails) > 0 {
			out["failures"] = fails
		}
		out["next"] = "Call get_run_report(run_key=\"" + run.Key + "\", include_screenshots=\"failed\") for details."
	default:
		out["next"] = "Still " + run.Status + ": call wait_for_run again."
	}
	return out
}

func (s *Server) listRuns(ctx context.Context, actor *auth.Actor, in listRunsInput) (*sdk.CallToolResult, error) {
	page, err := pageOf(in.Limit, in.Cursor)
	if err != nil {
		return nil, err
	}
	res, err := s.runs.List(ctx, actor, in.Project, runs.ListFilter{Status: in.Status, Target: in.Target, Kind: in.Kind, Trigger: in.Trigger, Page: page})
	if err != nil {
		return nil, err
	}
	items := make([]runBrief, 0, len(res.Data))
	for _, r := range res.Data {
		items = append(items, briefRun(r))
	}
	return jsonResult(map[string]any{"runs": items, "next_cursor": res.NextCursor})
}

func (s *Server) cancelRun(ctx context.Context, actor *auth.Actor, in runKeyInput) (*sdk.CallToolResult, error) {
	run, err := s.runs.Cancel(ctx, actor, normKey(in.RunKey))
	if err != nil {
		return nil, err
	}
	s.auditCall(ctx, actor, "cancel_run", "run", run.Key)
	out := map[string]any{"run_key": run.Key, "status": run.Status, "cancel_requested": run.CancelRequested}
	if !runs.IsFinal(run.Status) {
		out["next"] = "The worker stops the run shortly; wait_for_run reports status cancelled."
	}
	return jsonResult(out)
}
