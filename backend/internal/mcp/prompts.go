package mcp

import (
	"context"
	"encoding/json"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kalfian/qatlas/backend/internal/auth"
)

const (
	stepDSLURI       = "qatlas://docs/step-dsl"
	testCaseTemplate = "qatlas://projects/{key}/test-cases/{case}"
)

func (s *Server) registerResources() {
	s.srv.AddResource(&sdk.Resource{
		URI:         stepDSLURI,
		Name:        "step-dsl",
		Title:       "QAtlas step DSL",
		Description: "How to write QAtlas test steps: actions, selectors, variables, rules, examples and the JSON Schema of a step.",
		MIMEType:    "text/markdown",
	}, func(_ context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
		if _, err := actorOf(req.Extra); err != nil {
			return nil, err
		}
		return &sdk.ReadResourceResult{Contents: []*sdk.ResourceContents{{URI: stepDSLURI, MIMEType: "text/markdown", Text: stepDSLMarkdown()}}}, nil
	})

	s.srv.AddResourceTemplate(&sdk.ResourceTemplate{
		URITemplate: testCaseTemplate,
		Name:        "test-case",
		Title:       "Test case definition",
		Description: "Full definition of a test case, e.g. qatlas://projects/SHOP/test-cases/SHOP-T12 (same as get_test_case).",
		MIMEType:    "application/json",
	}, s.readTestCaseResource)
}

func (s *Server) readTestCaseResource(ctx context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
	uri := req.Params.URI
	actor, err := actorOf(req.Extra)
	if err != nil {
		return nil, err
	}
	if err := actor.RequireScope(auth.ScopeRead); err != nil {
		return nil, err
	}
	rest, ok := strings.CutPrefix(uri, "qatlas://projects/")
	if !ok {
		return nil, sdk.ResourceNotFoundError(uri)
	}
	project, caseKey, ok := strings.Cut(rest, "/test-cases/")
	if !ok || project == "" || caseKey == "" || !strings.HasPrefix(normKey(caseKey), normKey(project)+"-") {
		return nil, sdk.ResourceNotFoundError(uri)
	}
	tc, err := s.cases.Get(ctx, actor, normKey(caseKey))
	if err != nil {
		return nil, sdk.ResourceNotFoundError(uri) // 403/404 alike: do not leak existence
	}
	raw, err := json.Marshal(viewCase(tc))
	if err != nil {
		return nil, err
	}
	return &sdk.ReadResourceResult{Contents: []*sdk.ResourceContents{{URI: uri, MIMEType: "application/json", Text: string(raw)}}}, nil
}

func (s *Server) registerPrompts() {
	s.srv.AddPrompt(&sdk.Prompt{
		Name:        "write_test_case",
		Title:       "Write a test case from a requirement",
		Description: "Turn a requirement or user story into a validated QAtlas test case (optionally run it).",
		Arguments: []*sdk.PromptArgument{
			{Name: "project", Description: "Project key, e.g. SHOP", Required: true},
			{Name: "requirement", Description: "The requirement, user story or bug to cover", Required: true},
			{Name: "execution", Description: "automated (default) or manual"},
		},
	}, func(_ context.Context, req *sdk.GetPromptRequest) (*sdk.GetPromptResult, error) {
		if _, err := actorOf(req.Extra); err != nil {
			return nil, err
		}
		a := req.Params.Arguments
		execution := strings.TrimSpace(a["execution"])
		if execution == "" {
			execution = "automated"
		}
		text := "Write a QAtlas test case in project " + a["project"] + " (execution: " + execution + ") for this requirement:\n\n" +
			a["requirement"] + "\n\n" + `Work like this:
1. Call get_step_schema (actions, selector guidance, examples) and get_project to learn the environments, their variable names and secret NAMES.
2. Call list_test_cases (filter by relevant tags or a query) and get_test_case on one or two similar cases to follow the project's existing style, tags and step ids.
3. Draft the definition: a behaviour-focused title, priority, tags, preconditions if needed, and steps that each do one thing with a short description; end with assertions that prove the requirement (not just that a page loaded).
   - Use {{env.BASE_URL}}-style URLs and {{secret.NAME}} for credentials; never put real secret values in steps.
   - Prefer role=/label=/testid= selectors; use wait_for instead of fixed waits.
   - For manual test cases use only action=manual steps with clear instructions and expected results.
4. Call validate_test_case and fix every error (paths like steps[2].selector) until valid=true; consider the warnings.
5. Call create_test_case and report the new key. If I ask you to, run it with run_test_case, poll wait_for_run until done, read get_run_report(include_screenshots="failed") and fix the test with update_test_case (using the revision you read) when the failure is caused by the test itself.
Ask me before guessing about unclear behaviour, test data or credentials.`
		return &sdk.GetPromptResult{
			Description: "Write a test case for " + a["project"],
			Messages:    []*sdk.PromptMessage{{Role: "user", Content: &sdk.TextContent{Text: text}}},
		}, nil
	})

	s.srv.AddPrompt(&sdk.Prompt{
		Name:        "triage_failed_run",
		Title:       "Triage a failed run",
		Description: "Read a failed run's report and screenshots, decide whether it is an application bug or a brittle test, and propose a fix.",
		Arguments: []*sdk.PromptArgument{
			{Name: "run_key", Description: "Run key, e.g. SHOP-R210", Required: true},
		},
	}, func(_ context.Context, req *sdk.GetPromptRequest) (*sdk.GetPromptResult, error) {
		if _, err := actorOf(req.Extra); err != nil {
			return nil, err
		}
		key := normKey(req.Params.Arguments["run_key"])
		text := "Triage QAtlas run " + key + `.

1. Call get_run_report(run_key="` + key + `", include_screenshots="failed") and look at every failed or errored step: the error message, expected vs actual details and the screenshot.
2. Call get_test_case for the failing test case(s) to see the steps as written. If useful, compare with earlier runs of the same target via list_runs(target=…).
3. Classify the failure:
   - Application bug: the app behaves differently from the requirement (wrong text, missing element, error page, wrong HTTP status/body).
   - Brittle or outdated test: selector no longer matches a still-correct UI, timing/race, test data dependency, wrong expected value, environment/configuration problem (missing variable or secret, service down).
   State your confidence and the evidence for it.
4. Propose the fix:
   - For a test problem: show the exact step changes, apply them with update_test_case using the revision from get_test_case (never overwrite someone else's newer revision), then re-run with run_test_case and wait_for_run.
   - For an application bug: do not change the test to make it pass; write a short bug report (title, environment, steps to reproduce, expected vs actual, run key and screenshot reference).
5. If the run is awaiting_manual, a human has to finish it in the QAtlas UI — tell me instead of waiting.`
		return &sdk.GetPromptResult{
			Description: "Triage run " + key,
			Messages:    []*sdk.PromptMessage{{Role: "user", Content: &sdk.TextContent{Text: text}}},
		}, nil
	})
}
