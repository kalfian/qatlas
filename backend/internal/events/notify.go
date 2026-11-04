// Package events publishes run progress over Postgres LISTEN/NOTIFY and (in hub.go, built by the
// runs/SSE owner) fans it out to SSE subscribers. Payloads stay small: clients re-fetch the run.
package events

import (
	"context"
	"encoding/json"

	"github.com/kalfian/qatlas/backend/internal/db"
)

// Channel is the NOTIFY channel for run events.
const Channel = "qatlas_run_events"

// Event types (docs/13, openapi RunEvent).
const (
	RunStarted     = "run_started"
	CaseStarted    = "case_started"
	StepStarted    = "step_started"
	StepFinished   = "step_finished"
	CaseFinished   = "case_finished"
	AwaitingManual = "awaiting_manual"
	RunFinished    = "run_finished"
	RunUpdated     = "run_updated" // manual result saved, assignee changed, cancel requested…
)

// Event is the NOTIFY payload and the SSE data.
type Event struct {
	Type      string `json:"type"`
	RunKey    string `json:"run_key"`
	RunCaseID string `json:"run_case_id,omitempty"`
	RunStepID string `json:"run_step_id,omitempty"`
	Status    string `json:"status,omitempty"`
}

// Notify publishes an event. Inside a transaction it is delivered on commit (Postgres semantics).
func Notify(ctx context.Context, q db.Querier, ev Event) error {
	payload, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, "SELECT pg_notify($1, $2)", Channel, string(payload))
	return err
}
