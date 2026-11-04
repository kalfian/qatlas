package worker

import "sort"

// CaseState is the part of a run_cases row the planner needs.
type CaseState struct {
	ID                string
	Position          int
	Execution         string // automated | manual
	Status            string // pending | running | passed | failed | blocked | skipped | error
	ContinueOnFailure bool
}

// PlanKind is what the worker does next with a run.
type PlanKind int

const (
	// PlanFinalize: nothing left to execute; compute the final status.
	PlanFinalize PlanKind = iota
	// PlanSkipRest: stop_on_failure tripped; mark Skip as skipped, then finalize.
	PlanSkipRest
	// PlanAwaitManual: the next case is manual; park the run at Position.
	PlanAwaitManual
	// PlanSegment: execute Segment (consecutive automated cases) on the runner.
	PlanSegment
)

// Plan is the planner's decision.
type Plan struct {
	Kind     PlanKind
	Segment  []CaseState // PlanSegment
	Skip     []CaseState // PlanSkipRest: every open case
	Position int         // PlanAwaitManual
}

func isOpen(status string) bool { return status == "pending" || status == "running" }

// stops reports whether a finished case trips stop_on_failure (mock simulator prevFailed,
// runner semantics): failed/error/blocked without the case-level continue_on_failure.
func stops(c CaseState) bool {
	return (c.Status == "failed" || c.Status == "error" || c.Status == "blocked") && !c.ContinueOnFailure
}

// NextPlan picks the next action from the run's cases. The next case is the first open
// (pending/running) one by position — that is the case at resume_position after a manual
// case was completed, or position 1 on the first job. A stale "running" case (left by a
// crashed worker) counts as open and is executed again.
func NextPlan(cases []CaseState, stopOnFailure bool) Plan {
	cs := append([]CaseState(nil), cases...)
	sort.Slice(cs, func(i, j int) bool { return cs[i].Position < cs[j].Position })

	first := -1
	for i, c := range cs {
		if isOpen(c.Status) {
			first = i
			break
		}
	}
	if first < 0 {
		return Plan{Kind: PlanFinalize}
	}
	if stopOnFailure {
		for _, c := range cs[:first] {
			if stops(c) {
				var open []CaseState
				for _, x := range cs[first:] {
					if isOpen(x.Status) {
						open = append(open, x)
					}
				}
				return Plan{Kind: PlanSkipRest, Skip: open}
			}
		}
	}
	if cs[first].Execution == "manual" {
		return Plan{Kind: PlanAwaitManual, Position: cs[first].Position}
	}
	var seg []CaseState
	for _, c := range cs[first:] {
		if c.Execution == "manual" || !isOpen(c.Status) {
			break
		}
		seg = append(seg, c)
	}
	return Plan{Kind: PlanSegment, Segment: seg}
}

// FinalRunStatus aggregates case statuses into the run's final status, as the mock's
// finalizeRun: error > failed > blocked > passed (skipped cases do not change it).
func FinalRunStatus(caseStatuses []string) string {
	has := map[string]bool{}
	for _, s := range caseStatuses {
		has[s] = true
	}
	switch {
	case has["error"]:
		return "error"
	case has["failed"]:
		return "failed"
	case has["blocked"]:
		return "blocked"
	default:
		return "passed"
	}
}

// DefaultRunErrorMessage is stored when a run ends in error without a better message.
const DefaultRunErrorMessage = "Infrastructure error during execution"
