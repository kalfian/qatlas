package testcases

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/dsl"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Enum values (OpenAPI Priority / TestCaseStatus / Execution).
var (
	Priorities = []string{"low", "medium", "high", "critical"}
	Statuses   = []string{"draft", "ready", "deprecated"}
	Executions = []string{"automated", "manual"}
)

// defaultSnapshot is the state a new test case starts from (mock create defaults).
func defaultSnapshot() Snapshot {
	return Snapshot{
		Priority:  "medium",
		Status:    "draft",
		Execution: "automated",
		Tags:      []string{},
		Variables: json.RawMessage(`{}`),
		Steps:     json.RawMessage(`[]`),
	}
}

// resolve overlays the fields present in in onto base, like the mock's
// `{...testCaseInput(tc), ...input}` / `input.x ?? default`. The only error it
// can report is a malformed folder_id.
func (in Input) resolve(base Snapshot) (Snapshot, []httpx.FieldError) {
	s := base
	var errs []httpx.FieldError
	if in.FolderID.Set {
		if in.FolderID.Null {
			s.FolderID = nil
		} else if id, err := uuid.Parse(in.FolderID.Value); err != nil {
			errs = append(errs, httpx.Field("folder_id", "Folder not found"))
		} else {
			s.FolderID = &id
		}
	}
	if in.Title != nil {
		s.Title = strings.TrimSpace(*in.Title)
	}
	if in.Description != nil {
		s.Description = *in.Description
	}
	if in.Preconditions != nil {
		s.Preconditions = *in.Preconditions
	}
	if in.Priority != nil {
		s.Priority = *in.Priority
	}
	if in.Status != nil {
		s.Status = *in.Status
	}
	if in.Execution != nil {
		s.Execution = *in.Execution
	}
	if in.Tags != nil {
		s.Tags = nonNilStrings(*in.Tags)
	}
	if in.Variables != nil {
		vars := *in.Variables
		if vars == nil {
			vars = map[string]string{}
		}
		raw, _ := json.Marshal(vars) // map[string]string always marshals
		s.Variables = raw
	}
	if in.Steps != nil {
		s.Steps = joinRaw(*in.Steps)
	}
	return s, errs
}

// joinRaw rebuilds a JSON array from its elements byte for byte, so steps are
// stored exactly as received (unknown fields included).
func joinRaw(items []json.RawMessage) json.RawMessage {
	var b bytes.Buffer
	b.WriteByte('[')
	for i, it := range items {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(it)
	}
	b.WriteByte(']')
	return b.Bytes()
}

// validate checks a resolved snapshot: title (mock validateInput), enum
// values (the DB would otherwise reject them with a 500), extra (e.g. a
// missing folder) and the step DSL (dsl.Validate = validateSteps).
func validate(s Snapshot, extra ...httpx.FieldError) (errs, warnings []httpx.FieldError) {
	errs, warnings = []httpx.FieldError{}, []httpx.FieldError{}
	if strings.TrimSpace(s.Title) == "" {
		errs = append(errs, httpx.Field("title", "Title is required"))
	}
	if !slices.Contains(Priorities, s.Priority) {
		errs = append(errs, httpx.Field("priority", "Priority must be one of "+strings.Join(Priorities, ", ")))
	}
	if !slices.Contains(Statuses, s.Status) {
		errs = append(errs, httpx.Field("status", "Status must be one of "+strings.Join(Statuses, ", ")))
	}
	if !slices.Contains(Executions, s.Execution) {
		errs = append(errs, httpx.Field("execution", "Execution must be one of "+strings.Join(Executions, ", ")))
	}
	errs = append(errs, extra...)

	steps, stepErrs := parseSteps(s.Steps)
	if len(stepErrs) > 0 {
		return append(errs, stepErrs...), warnings
	}
	dErrs, dWarns := dsl.Validate(steps, s.Execution)
	for _, e := range dErrs {
		errs = append(errs, httpx.Field(e.Path, e.Message))
	}
	for _, w := range dWarns {
		warnings = append(warnings, httpx.Field(w.Path, w.Message))
	}
	return errs, warnings
}

// parseSteps decodes the stored/received steps array for validation. Every
// element must be a JSON object; otherwise the DSL check is skipped and only
// the shape errors are reported.
func parseSteps(raw json.RawMessage) ([]dsl.Step, []httpx.FieldError) {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, []httpx.FieldError{httpx.Field("steps", "Steps must be an array")}
	}
	steps := make([]dsl.Step, len(items))
	var errs []httpx.FieldError
	for i, it := range items {
		var st dsl.Step
		trimmed := bytes.TrimSpace(it)
		if len(trimmed) == 0 || trimmed[0] != '{' || json.Unmarshal(trimmed, &st) != nil {
			errs = append(errs, httpx.Field(fmt.Sprintf("steps[%d]", i), "Step must be an object"))
			continue
		}
		steps[i] = st
	}
	return steps, errs
}
