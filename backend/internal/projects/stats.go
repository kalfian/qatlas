package projects

import (
	"context"
	"math"
	"slices"
	"time"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
)

// DailyStat is one ProjectStats.daily bucket.
type DailyStat struct {
	Date   string `json:"date"`
	Passed int    `json:"passed"`
	Failed int    `json:"failed"`
	Other  int    `json:"other"`
}

// FailingCase is one ProjectStats.top_failing entry.
type FailingCase struct {
	TestCaseKey string `json:"test_case_key"`
	Title       string `json:"title"`
	Failures    int    `json:"failures"`
	Runs        int    `json:"runs"`
}

// Stats is the OpenAPI ProjectStats schema.
type Stats struct {
	Range          string        `json:"range"`
	TotalRuns      int           `json:"total_runs"`
	PassRate       *float64      `json:"pass_rate"`
	AvgDurationMS  *int64        `json:"avg_duration_ms"`
	AwaitingManual int           `json:"awaiting_manual"`
	Daily          []DailyStat   `json:"daily"`
	TopFailing     []FailingCase `json:"top_failing"`
}

// statsRun is the subset of a run the stats need.
type statsRun struct {
	Status   string
	Queued   time.Time
	Started  *time.Time
	Finished *time.Time
}

// statsCase is one run case of a run inside the range.
type statsCase struct {
	Key    string
	Title  string
	Status string
}

// Stats computes dashboard stats exactly like the mock: runs queued in the
// last 7 / 30 × 24 h; daily buckets keyed by local calendar date (s.loc);
// pass rate and average duration over final, non-cancelled runs; top 5
// failing test cases by failure count; awaiting_manual over all runs.
// An unknown range falls back to 7d.
func (s *Service) Stats(ctx context.Context, actor *auth.Actor, key, rng string) (Stats, error) {
	p, _, err := authz.ProjectAccess(ctx, s.pool, actor, key, authz.View)
	if err != nil {
		return Stats{}, err
	}
	if rng != "30d" {
		rng = "7d"
	}
	now := s.now()
	since := now.Add(-time.Duration(rangeDays(rng)) * 24 * time.Hour)

	rows, err := s.pool.Query(ctx, `
		SELECT status, queued_at, started_at, finished_at FROM runs
		WHERE project_id = $1 AND queued_at >= $2
		ORDER BY queued_at DESC, id DESC`, p.ID, since)
	if err != nil {
		return Stats{}, err
	}
	var runList []statsRun
	for rows.Next() {
		var r statsRun
		if err := rows.Scan(&r.Status, &r.Queued, &r.Started, &r.Finished); err != nil {
			rows.Close()
			return Stats{}, err
		}
		runList = append(runList, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Stats{}, err
	}

	// Cases in mock iteration order: runs newest first, cases by position.
	rows, err = s.pool.Query(ctx, `
		SELECT rc.test_case_key, rc.title, rc.status
		FROM run_cases rc JOIN runs r ON r.id = rc.run_id
		WHERE r.project_id = $1 AND r.queued_at >= $2
		ORDER BY r.queued_at DESC, r.id DESC, rc.position`, p.ID, since)
	if err != nil {
		return Stats{}, err
	}
	var cases []statsCase
	for rows.Next() {
		var c statsCase
		if err := rows.Scan(&c.Key, &c.Title, &c.Status); err != nil {
			rows.Close()
			return Stats{}, err
		}
		cases = append(cases, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Stats{}, err
	}

	var awaiting int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM runs WHERE project_id = $1 AND status = 'awaiting_manual'`, p.ID).Scan(&awaiting); err != nil {
		return Stats{}, err
	}
	return computeStats(rng, now, s.loc, runList, cases, awaiting), nil
}

func rangeDays(rng string) int {
	if rng == "30d" {
		return 30
	}
	return 7
}

func isFinal(status string) bool {
	switch status {
	case "passed", "failed", "blocked", "error", "cancelled":
		return true
	}
	return false
}

// computeStats is the pure part of Stats (unit-testable). runs must be newest
// first and cases in mock iteration order.
func computeStats(rng string, now time.Time, loc *time.Location, runList []statsRun, cases []statsCase, awaiting int) Stats {
	days := rangeDays(rng)
	out := Stats{Range: rng, TotalRuns: len(runList), AwaitingManual: awaiting, Daily: make([]DailyStat, days), TopFailing: []FailingCase{}}

	// date → bucket indexes (a DST shift can repeat a date; the mock's
	// per-bucket filter then counts the run in both buckets).
	index := make(map[string][]int, days)
	for i := range days {
		d := now.Add(-time.Duration(days-1-i) * 24 * time.Hour).In(loc).Format(time.DateOnly)
		out.Daily[i] = DailyStat{Date: d}
		index[d] = append(index[d], i)
	}

	var finals, passed int
	var durSum, durN int64
	for _, r := range runList {
		for _, i := range index[r.Queued.In(loc).Format(time.DateOnly)] {
			switch r.Status {
			case "passed":
				out.Daily[i].Passed++
			case "failed", "error":
				out.Daily[i].Failed++
			default:
				out.Daily[i].Other++
			}
		}
		if isFinal(r.Status) && r.Status != "cancelled" {
			finals++
			if r.Status == "passed" {
				passed++
			}
			if r.Started != nil && r.Finished != nil {
				durSum += r.Finished.Sub(*r.Started).Milliseconds()
				durN++
			}
		}
	}
	if finals > 0 {
		rate := float64(passed) / float64(finals)
		out.PassRate = &rate
	}
	if durN > 0 {
		avg := int64(math.Round(float64(durSum) / float64(durN)))
		out.AvgDurationMS = &avg
	}

	type agg struct {
		key, title     string
		failures, runs int
	}
	var order []*agg
	byKey := map[string]*agg{}
	for _, c := range cases {
		a := byKey[c.Key]
		if a == nil {
			a = &agg{key: c.Key, title: c.Title}
			byKey[c.Key] = a
			order = append(order, a)
		}
		a.runs++
		if c.Status == "failed" || c.Status == "error" {
			a.failures++
		}
	}
	failing := slices.DeleteFunc(order, func(a *agg) bool { return a.failures == 0 })
	slices.SortStableFunc(failing, func(a, b *agg) int { return b.failures - a.failures })
	for _, a := range failing[:min(5, len(failing))] {
		out.TopFailing = append(out.TopFailing, FailingCase{TestCaseKey: a.key, Title: a.title, Failures: a.failures, Runs: a.runs})
	}
	return out
}
