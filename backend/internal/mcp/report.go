package mcp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/runs"
)

// Report size limits.
const (
	maxStepsPerCase = 80
	maxErrorChars   = 1500
	maxDetailsChars = 2000
	maxTextChars    = 500
)

type reportInput struct {
	RunKey             string `json:"run_key" jsonschema:"Run key, e.g. SHOP-R210"`
	IncludeScreenshots string `json:"include_screenshots,omitempty" jsonschema:"none | failed (default) | all"`
	Case               string `json:"case,omitempty" jsonschema:"Only report this test case key (useful for long flow runs; every device of it)"`
}

type reportStep struct {
	Position     int      `json:"position"`
	StepID       string   `json:"step_id"`
	Action       string   `json:"action"`
	Summary      string   `json:"summary"`
	Status       string   `json:"status"`
	OnlyOn       []string `json:"only_on,omitempty"` // device categories the step runs on (skipped elsewhere)
	DurationMS   *int64   `json:"duration_ms,omitempty"`
	Description  string   `json:"description,omitempty"`
	Expected     string   `json:"expected,omitempty"`
	Error        *string  `json:"error,omitempty"`
	ActualResult *string  `json:"actual_result,omitempty"`
	// Details are the runner's {expected, actual} (assertions) or
	// {request, response} (http_request), truncated.
	Details    any    `json:"details,omitempty"`
	Screenshot string `json:"screenshot,omitempty"`
}

type reportCase struct {
	Position       int          `json:"position"`
	Device         string       `json:"device"` // "iPhone 15 · 393×659"
	TestCase       string       `json:"test_case"`
	Revision       int          `json:"revision"`
	Title          string       `json:"title"`
	Execution      string       `json:"execution"`
	Status         string       `json:"status"`
	DurationMS     *int64       `json:"duration_ms,omitempty"`
	ExecutedBy     string       `json:"executed_by,omitempty"`
	Video          string       `json:"video,omitempty"`
	Attachments    []string     `json:"attachments,omitempty"`
	Steps          []reportStep `json:"steps"`
	StepsOmitted   int          `json:"steps_omitted,omitempty"`
	StepsTruncated string       `json:"steps_note,omitempty"`
}

func isFailedStep(status string) bool { return status == runs.StepFailed || status == runs.StepError }

func (s *Server) getRunReport(ctx context.Context, actor *auth.Actor, in reportInput) (*sdk.CallToolResult, error) {
	mode := strings.ToLower(strings.TrimSpace(in.IncludeScreenshots))
	switch mode {
	case "":
		mode = "failed"
	case "none", "failed", "all":
	default:
		return nil, httpx.BadRequest("include_screenshots must be none, failed or all", httpx.Field("include_screenshots", "none | failed | all"))
	}
	run, err := s.runs.Get(ctx, actor, normKey(in.RunKey))
	if err != nil {
		return nil, err
	}
	onlyCase := normKey(in.Case)

	report := map[string]any{
		"run_key": run.Key, "status": run.Status, "kind": run.Kind,
		"target": run.Target.Key + " " + run.Target.Title, "trigger": run.Trigger,
		"triggered_by": run.TriggeredBy.Name, "queued_at": run.QueuedAt.UTC(),
		"summary": run.Summary, "url": s.runURL(run),
	}
	if run.Environment != nil {
		report["environment"] = run.Environment.Name
	}
	if run.StartedAt != nil {
		report["started_at"], report["duration_ms"] = run.StartedAt.UTC(), run.DurationMS
	}
	if run.FinishedAt != nil {
		report["finished_at"] = run.FinishedAt.UTC()
	}
	if run.ErrorMessage != nil {
		report["error_message"] = truncate(*run.ErrorMessage, maxErrorChars)
	}
	if run.Assignee != nil {
		report["manual_assignee"] = run.Assignee.Name + " <" + run.Assignee.Email + ">"
	}
	if !runs.IsFinal(run.Status) {
		report["note"] = "The run is not finished (" + run.Status + "); results are partial."
	}
	report["devices"] = deviceNames(run)
	if pd := perDevice(run); pd != nil {
		report["device_summary"] = pd
	}

	var (
		images   []sdk.Content
		imgNotes []string
	)
	attach := func(c runs.RunCase, st runs.RunStep) string {
		a := st.Screenshot
		switch {
		case a.Expired:
			return "expired (artifact retention)"
		case len(images)/2 >= MaxScreenshots:
			return "not attached (limit " + itoa(MaxScreenshots) + " images): " + s.baseURL + a.URL
		case !strings.HasPrefix(a.MIME, "image/"):
			return "not an image: " + s.baseURL + a.URL
		case a.SizeBytes > MaxScreenshotBytes:
			return fmt.Sprintf("not attached (%d KB > 1 MB): %s%s", a.SizeBytes/1024, s.baseURL, a.URL)
		}
		data, err := s.readArtifact(ctx, actor, a)
		if err != nil {
			s.log.WarnContext(ctx, "mcp report: screenshot unavailable", "artifact_id", a.ID, "err", err)
			return "unavailable: " + s.baseURL + a.URL
		}
		n := len(images)/2 + 1
		caption := fmt.Sprintf("Screenshot %d: %s step %s (%s) — %s", n, c.TestCaseKey, st.StepID, st.Status, st.Summary)
		if len(run.Devices()) > 1 {
			caption = fmt.Sprintf("Screenshot %d: %s on %s, step %s (%s) — %s", n, c.TestCaseKey, run.DeviceOf(c).Display(), st.StepID, st.Status, st.Summary)
		}
		images = append(images, &sdk.TextContent{Text: caption}, &sdk.ImageContent{Data: data, MIMEType: a.MIME})
		imgNotes = append(imgNotes, caption)
		return fmt.Sprintf("attached as image %d", n)
	}

	cases := make([]reportCase, 0, len(run.Cases))
	for _, c := range run.Cases {
		if onlyCase != "" && c.TestCaseKey != onlyCase {
			continue
		}
		rc := reportCase{Position: c.Position, Device: run.DeviceOf(c).Display(), TestCase: c.TestCaseKey, Revision: c.TestCaseRevision, Title: c.Title,
			Execution: c.Execution, Status: c.Status, DurationMS: c.DurationMS, Steps: []reportStep{}}
		if c.ExecutedBy != nil {
			rc.ExecutedBy = c.ExecutedBy.Name
		}
		if c.Video != nil {
			rc.Video = artifactLink(s.baseURL, c.Video)
		}
		for _, a := range c.Attachments {
			rc.Attachments = append(rc.Attachments, a.Name+": "+artifactLink(s.baseURL, &a))
		}
		for _, st := range c.Steps {
			failed := isFailedStep(st.Status)
			if len(rc.Steps) >= maxStepsPerCase && !failed {
				rc.StepsOmitted++
				continue
			}
			rs := reportStep{Position: st.Position, StepID: st.StepID, Action: st.Action, Summary: st.Summary, Status: st.Status, OnlyOn: st.OnlyOn, DurationMS: st.DurationMS}
			if failed || c.Execution == runs.ExecutionManual {
				rs.Description = truncate(st.Description, maxTextChars)
				rs.Expected = truncate(st.Expected, maxTextChars)
				rs.Error = truncatePtr(st.ErrorMessage, maxErrorChars)
				rs.ActualResult = truncatePtr(st.ActualResult, maxTextChars)
				rs.Details = truncateJSON(st.Details, maxDetailsChars)
			} else if st.ErrorMessage != nil { // e.g. a continue_on_failure warning
				rs.Error = truncatePtr(st.ErrorMessage, 300)
			}
			if st.Screenshot != nil {
				if mode == "all" || (mode == "failed" && failed) {
					rs.Screenshot = attach(c, st)
				} else {
					rs.Screenshot = artifactLink(s.baseURL, st.Screenshot)
				}
			}
			rc.Steps = append(rc.Steps, rs)
		}
		if rc.StepsOmitted > 0 {
			rc.StepsTruncated = fmt.Sprintf("%d passed/skipped steps omitted to save space", rc.StepsOmitted)
		}
		cases = append(cases, rc)
	}
	if onlyCase != "" && len(cases) == 0 {
		return nil, httpx.NotFound("Run " + run.Key + " has no case " + onlyCase)
	}
	report["cases"] = cases
	if len(imgNotes) > 0 {
		report["screenshots"] = imgNotes
	}

	res, err := jsonResult(report)
	if err != nil {
		return nil, err
	}
	res.Content = append(res.Content, images...)
	return res, nil
}

func artifactLink(baseURL string, a *artifacts.Artifact) string {
	if a.Expired {
		return "expired"
	}
	return baseURL + a.URL
}

// readArtifact reads a screenshot through the artifact service (same RBAC as
// GET /artifacts/{id}), capped at MaxScreenshotBytes.
func (s *Server) readArtifact(ctx context.Context, actor *auth.Actor, a *artifacts.Artifact) ([]byte, error) {
	if s.artifacts == nil {
		return nil, errors.New("artifact service not configured")
	}
	_, rc, _, err := s.artifacts.Open(ctx, actor, a.ID.String())
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, MaxScreenshotBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxScreenshotBytes {
		return nil, fmt.Errorf("screenshot larger than %d bytes", MaxScreenshotBytes)
	}
	return data, nil
}
