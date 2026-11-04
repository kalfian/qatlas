package worker

import (
	"encoding/json"
	"fmt"

	"github.com/kalfian/qatlas/backend/internal/runs"
)

// runSnapshot is the part of runs.Snapshot (runs.snapshot, written by internal/runs at
// run creation) that the worker needs to build run.start.
type runSnapshot struct {
	Env         map[string]any // environment variables (run.start env)
	SecretNames []string
	Vars        map[string]any // flow variables (run.start vars)
	Cases       []snapCase
}

type snapCase struct {
	RunCaseID  string
	Position   int
	TestCaseID string
	Vars       map[string]any
	Steps      []map[string]any // DSL steps; run_steps.position = index + 1
}

func parseSnapshot(raw []byte) (*runSnapshot, error) {
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	var s runs.Snapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("decode run snapshot: %w", err)
	}
	out := &runSnapshot{Env: map[string]any{}, Vars: map[string]any{}}
	if s.Environment != nil {
		for k, v := range s.Environment.Variables {
			out.Env[k] = v
		}
		out.SecretNames = s.Environment.SecretNames
	}
	if s.Flow != nil {
		vars, err := objectOf(s.Flow.Variables)
		if err != nil {
			return nil, fmt.Errorf("flow variables: %w", err)
		}
		out.Vars = vars
	}
	for _, c := range s.Cases {
		vars, err := objectOf(c.Variables)
		if err != nil {
			return nil, fmt.Errorf("variables of %s: %w", c.TestCaseKey, err)
		}
		sc := snapCase{
			RunCaseID:  c.RunCaseID.String(),
			Position:   c.Position,
			TestCaseID: c.TestCaseID.String(),
			Vars:       vars,
		}
		for _, st := range c.Steps {
			sc.Steps = append(sc.Steps, map[string]any(st))
		}
		out.Cases = append(out.Cases, sc)
	}
	return out, nil
}

// objectOf decodes a JSON object (null/empty → {}).
func objectOf(raw json.RawMessage) (map[string]any, error) {
	out := map[string]any{}
	if len(raw) == 0 || string(raw) == "null" {
		return out, nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

// caseFor finds the snapshot case of a run case: by run_case id, then by position and
// test case id.
func (s *runSnapshot) caseFor(runCaseID string, position int, testCaseID string) (*snapCase, bool) {
	for i := range s.Cases {
		if s.Cases[i].RunCaseID == runCaseID {
			return &s.Cases[i], true
		}
	}
	for i := range s.Cases {
		if c := &s.Cases[i]; c.Position == position && c.TestCaseID == testCaseID {
			return c, true
		}
	}
	return nil, false
}

// stepFor finds a DSL step by its 1-based position (run_steps.position), checking that
// the DSL id matches run_steps.step_id; falls back to a search by id.
func (c *snapCase) stepFor(stepID string, position int) (map[string]any, bool) {
	if position >= 1 && position <= len(c.Steps) {
		st := c.Steps[position-1]
		if id, _ := st["id"].(string); id == stepID {
			return st, true
		}
	}
	for _, st := range c.Steps {
		if id, _ := st["id"].(string); id == stepID && stepID != "" {
			return st, true
		}
	}
	return nil, false
}

// wireStep turns a snapshot DSL step into the runner's wire form: the DSL params flat,
// "id" replaced by step_id = the run_steps id, flags taken from the run_steps row.
func wireStep(dslStep map[string]any, runStepID, action string, enabled, continueOnFailure bool) map[string]any {
	out := make(map[string]any, len(dslStep)+2)
	for k, v := range dslStep {
		out[k] = v
	}
	delete(out, "id")
	out["step_id"] = runStepID
	if action != "" {
		out["action"] = action
	}
	out["enabled"] = enabled
	out["continue_on_failure"] = continueOnFailure
	if _, ok := out["timeout_ms"]; !ok {
		out["timeout_ms"] = nil
	}
	if _, ok := out["screenshot"].(bool); !ok {
		out["screenshot"] = false
	}
	return out
}
