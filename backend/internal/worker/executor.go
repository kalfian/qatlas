package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/devices"
	"github.com/kalfian/qatlas/backend/internal/events"
	"github.com/kalfian/qatlas/backend/internal/jobs"
	"github.com/kalfian/qatlas/backend/internal/runs"
	"github.com/kalfian/qatlas/backend/internal/secrets"
)

// advisoryClass namespaces the per-run advisory lock (pg_try_advisory_lock(class, key)).
// A worker holds it on a dedicated connection while it executes a run, so duplicate jobs
// for one run never execute concurrently and startup recovery can tell live runs apart.
const advisoryClass int32 = 0x51A7

// SecretsFunc decrypts an environment's secrets (secrets.ForEnvironment).
type SecretsFunc func(ctx context.Context, q db.Querier, envID uuid.UUID, key []byte) (map[string]string, error)

// ExecutorConfig configures run execution.
type ExecutorConfig struct {
	Pool   *pgxpool.Pool
	Runner *Supervisor
	// Stores receive screenshots and videos (the writer at upload time).
	Stores    artifacts.Stores
	MasterKey []byte
	// DataDir is QATLAS_DATA_DIR; runner artifact dirs are DataDir/tmp/<run_id>.
	DataDir string
	// RunTimeout caps one automated execution (QATLAS_RUN_TIMEOUT); a run's own
	// options.run_timeout_ms wins when set and smaller.
	RunTimeout time.Duration
	// CancelPoll is how often cancel_requested is checked (default 1 s).
	CancelPoll time.Duration
	// CancelGrace is how long to wait for run.finished after run.cancel (default 5 s).
	CancelGrace time.Duration
	// LockWait is how long a job waits for a run another job still executes before it
	// snoozes (default 5 s).
	LockWait time.Duration
	// Enqueuer continues a run with a new job when runs.Continue asks for it.
	Enqueuer jobs.Enqueuer
	Secrets  SecretsFunc // default secrets.ForEnvironment
	Logger   *slog.Logger
}

// Executor runs the run_execute job: it executes automated segments of a run on the
// runner and records the results.
type Executor struct {
	cfg ExecutorConfig
	log *slog.Logger
}

// NewExecutor applies defaults.
func NewExecutor(cfg ExecutorConfig) *Executor {
	if cfg.RunTimeout <= 0 {
		cfg.RunTimeout = 15 * time.Minute
	}
	if cfg.CancelPoll <= 0 {
		cfg.CancelPoll = time.Second
	}
	if cfg.CancelGrace <= 0 {
		cfg.CancelGrace = 5 * time.Second
	}
	if cfg.LockWait <= 0 {
		cfg.LockWait = 5 * time.Second
	}
	if cfg.Secrets == nil {
		cfg.Secrets = secrets.ForEnvironment
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Executor{cfg: cfg, log: cfg.Logger.With("component", "executor")}
}

// runInfo is the runs row (+ project key) the executor works with.
type runInfo struct {
	ID              uuid.UUID
	ProjectID       uuid.UUID
	Key             string
	Kind            string
	TestCaseID      *uuid.UUID
	FlowID          *uuid.UUID
	EnvironmentID   *uuid.UUID
	EnvironmentName *string
	Status          string
	SharedSession   bool
	StopOnFailure   bool
	CancelRequested bool
	Options         map[string]any
	OptionsRaw      []byte
	Snapshot        []byte
	QueuedAt        time.Time
}

// runCtx carries per-execution state.
type runCtx struct {
	run      *runInfo
	devices  []devices.Device // options.devices (never empty)
	snap     *runSnapshot
	env      map[string]any
	secrets  map[string]string
	mask     *Masker
	dir      string // artifact_dir
	deadline time.Time
	timeout  time.Duration
	errMsg   string // run.error_message to store if the run ends in error
}

// Execute processes one run_execute job. It returns an error only for infrastructure
// problems; the run itself is always left in a consistent state (final, awaiting_manual
// or untouched when another worker owns it).
func (e *Executor) Execute(ctx context.Context, runID uuid.UUID) (err error) {
	dbctx := context.WithoutCancel(ctx)
	log := e.log.With("run_id", runID)

	// dbctx: even a job started during shutdown must reach a consistent run state.
	conn, err := e.cfg.Pool.Acquire(dbctx)
	if err != nil {
		return fmt.Errorf("acquire lock connection: %w", err)
	}
	defer conn.Release()
	locked, err := waitAdvisoryLock(ctx, conn, runID, e.cfg.LockWait)
	if err != nil {
		return fmt.Errorf("advisory lock: %w", err)
	}
	if !locked {
		// Another job still executes this run (e.g. it is finishing the segment that led
		// to a manual case which a tester already completed). Retry later.
		log.Info("run is being executed by another job; retrying later")
		return ErrRunBusy
	}
	defer func() {
		if _, uerr := conn.Exec(dbctx, `SELECT pg_advisory_unlock($1, hashtext($2))`, advisoryClass, runID.String()); uerr != nil {
			// Drop the connection so the session lock cannot leak back into the pool.
			_ = conn.Conn().Close(dbctx)
		}
	}()

	run, err := e.loadRun(dbctx, runID)
	if db.IsNoRows(err) {
		log.Warn("run_execute for a run that no longer exists")
		return nil
	}
	if err != nil {
		return err
	}
	if run.Status != "queued" && run.Status != "running" {
		log.Info("run is not executable; skipping", "status", run.Status)
		return nil
	}
	rc := &runCtx{run: run, mask: NewMasker(nil), devices: devices.FromOptions(run.OptionsRaw)}

	defer func() {
		if p := recover(); p != nil {
			log.Error("panic while executing run", "panic", p)
			rc.errMsg = "Internal worker error while executing the run"
			if ferr := e.abortRun(dbctx, rc); ferr != nil {
				log.Error("could not mark run as error after panic", "err", ferr)
			}
			err = fmt.Errorf("panic executing run %s: %v", runID, p)
		}
	}()

	if run.CancelRequested {
		return e.finishCancelled(dbctx, rc)
	}

	rc.timeout = e.cfg.RunTimeout
	if ms, ok := run.Options["run_timeout_ms"].(float64); ok && ms > 0 && time.Duration(ms)*time.Millisecond < rc.timeout {
		rc.timeout = time.Duration(ms) * time.Millisecond
	}
	rc.deadline = time.Now().Add(rc.timeout)

	if rc.snap, err = parseSnapshot(run.Snapshot); err != nil {
		rc.errMsg = "The run snapshot is unreadable: " + err.Error()
		return e.abortRun(dbctx, rc)
	}
	rc.env = rc.snap.Env
	rc.secrets = map[string]string{}
	switch {
	case run.EnvironmentID != nil:
		sec, serr := e.cfg.Secrets(dbctx, e.cfg.Pool, *run.EnvironmentID, e.cfg.MasterKey)
		if serr != nil {
			// secrets errors name the secret, never the value.
			rc.errMsg = "Could not decrypt the environment secrets: " + serr.Error()
			return e.abortRun(dbctx, rc)
		}
		rc.secrets = sec
	case run.EnvironmentName != nil || len(rc.snap.SecretNames) > 0:
		log.Warn("the run's environment was deleted; executing without secrets",
			"environment", deref(run.EnvironmentName), "secret_names", rc.snap.SecretNames)
	}
	vals := make([]string, 0, len(rc.secrets))
	for _, v := range rc.secrets {
		vals = append(vals, v)
	}
	rc.mask = NewMasker(vals)

	rc.dir = filepath.Join(e.cfg.DataDir, "tmp", runID.String())
	if abs, aerr := filepath.Abs(rc.dir); aerr == nil {
		rc.dir = abs
	}
	defer func() {
		if rerr := os.RemoveAll(rc.dir); rerr != nil {
			log.Warn("could not remove artifact dir", "dir", rc.dir, "err", rerr)
		}
	}()

	if err := e.markRunning(dbctx, run); err != nil {
		return err
	}

	// fail ends the run in error when recording results itself failed (database error),
	// so a run is never left "running" by a job that will not be retried.
	fail := func(cause error) error {
		log.Error("executing run failed", "err", cause)
		rc.errMsg = "Internal worker error while recording the run results"
		if ferr := e.abortRun(dbctx, rc); ferr != nil {
			log.Error("could not mark run as error", "err", ferr)
		}
		return cause
	}
	lastDevice := -1
	for {
		cases, err := e.loadCaseStates(dbctx, runID)
		if err != nil {
			return fail(err)
		}
		plan := NextPlan(cases, run.Kind == runs.KindFlow && run.StopOnFailure)
		if plan.Kind != PlanSegment {
			// Manual case next, stop_on_failure tripped or nothing left: the shared
			// state machine (also used by complete-manual) decides.
			if err := e.continueRun(dbctx, rc); err != nil {
				return fail(err)
			}
			return nil
		}
		// The run timeout caps the execution on one device: a job that moves on to the
		// next device's segment (docs/14) starts a fresh budget.
		if dev := plan.Segment[0].DeviceIndex; dev != lastDevice {
			if lastDevice >= 0 {
				rc.deadline = time.Now().Add(rc.timeout)
			}
			lastDevice = dev
		}
		out, err := e.runSegment(ctx, rc, plan.Segment)
		if err != nil {
			return fail(err)
		}
		switch out {
		case segCancelled:
			return e.finishCancelled(dbctx, rc)
		case segAborted:
			return e.abortRun(dbctx, rc)
		}
		// segDone: plan again (normally a manual case or the end of the run).
	}
}

// ErrRunBusy means another job holds the run's execution lock; the River worker snoozes.
var ErrRunBusy = errors.New("run is being executed by another job")

// waitAdvisoryLock tries the run's advisory lock for up to wait (polling).
func waitAdvisoryLock(ctx context.Context, conn *pgxpool.Conn, runID uuid.UUID, wait time.Duration) (bool, error) {
	deadline := time.Now().Add(wait)
	for {
		var locked bool
		if err := conn.QueryRow(context.WithoutCancel(ctx), `SELECT pg_try_advisory_lock($1, hashtext($2))`, advisoryClass, runID.String()).Scan(&locked); err != nil {
			return false, err
		}
		if locked || time.Now().After(deadline) {
			return locked, nil
		}
		select {
		case <-ctx.Done():
			return false, nil
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (e *Executor) loadRun(ctx context.Context, id uuid.UUID) (*runInfo, error) {
	r := &runInfo{}
	var opts []byte
	err := e.cfg.Pool.QueryRow(ctx, `
		SELECT r.id, r.project_id, p.key || '-R' || r.seq, r.kind, r.test_case_id, r.flow_id,
			r.environment_id, r.environment_name, r.status, r.shared_session, r.stop_on_failure,
			r.cancel_requested, r.options, r.snapshot, r.queued_at
		FROM runs r JOIN projects p ON p.id = r.project_id
		WHERE r.id = $1`, id).Scan(&r.ID, &r.ProjectID, &r.Key, &r.Kind, &r.TestCaseID, &r.FlowID,
		&r.EnvironmentID, &r.EnvironmentName, &r.Status, &r.SharedSession, &r.StopOnFailure,
		&r.CancelRequested, &opts, &r.Snapshot, &r.QueuedAt)
	if err != nil {
		return nil, err
	}
	r.OptionsRaw = opts
	if err := json.Unmarshal(opts, &r.Options); err != nil || r.Options == nil {
		r.Options = map[string]any{}
	}
	return r, nil
}

func (e *Executor) loadCaseStates(ctx context.Context, runID uuid.UUID) ([]CaseState, error) {
	rows, err := e.cfg.Pool.Query(ctx, `
		SELECT id::text, position, device_index, execution, status, continue_on_failure
		FROM run_cases WHERE run_id = $1 ORDER BY position`, runID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (CaseState, error) {
		var c CaseState
		err := row.Scan(&c.ID, &c.Position, &c.DeviceIndex, &c.Execution, &c.Status, &c.ContinueOnFailure)
		return c, err
	})
}

func (e *Executor) notify(ctx context.Context, q db.Querier, rc *runCtx, typ string, caseID, stepID *uuid.UUID, status string) error {
	ev := events.Event{Type: typ, RunKey: rc.run.Key, Status: status}
	if caseID != nil {
		ev.RunCaseID = caseID.String()
	}
	if stepID != nil {
		ev.RunStepID = stepID.String()
	}
	return events.Notify(ctx, q, ev)
}

func (e *Executor) markRunning(ctx context.Context, r *runInfo) error {
	return db.WithTx(ctx, e.cfg.Pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE runs SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
			WHERE id = $1 AND status IN ('queued', 'running')`, r.ID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		r.Status = runs.StatusRunning
		if err := runs.SyncLastRunStatus(ctx, tx, r.ID); err != nil {
			return err
		}
		return events.Notify(ctx, tx, events.Event{Type: events.RunStarted, RunKey: r.Key, Status: runs.StatusRunning})
	})
}

// continueRun hands the run to runs.Continue (skip after stop_on_failure, park at a
// manual case, finalize) unless a cancel arrived meanwhile.
func (e *Executor) continueRun(ctx context.Context, rc *runCtx) error {
	return db.WithTx(ctx, e.cfg.Pool, func(tx pgx.Tx) error {
		var cancel bool
		if err := tx.QueryRow(ctx, `SELECT cancel_requested FROM runs WHERE id = $1 FOR UPDATE`, rc.run.ID).Scan(&cancel); err != nil {
			return err
		}
		if cancel {
			return runs.FinishCancelled(ctx, tx, rc.run.ID)
		}
		enq := e.cfg.Enqueuer
		if enq == nil {
			enq = jobs.NoopEnqueuer{}
		}
		status, err := runs.Continue(ctx, tx, enq, rc.run.ID)
		if err != nil {
			return err
		}
		rc.run.Status = status
		if status == runs.StatusError && rc.errMsg != "" {
			_, err = tx.Exec(ctx, `UPDATE runs SET error_message = $2 WHERE id = $1`, rc.run.ID, rc.mask.String(rc.errMsg))
		}
		return err
	})
}

// finishCancelled skips everything still open and closes the run as cancelled.
func (e *Executor) finishCancelled(ctx context.Context, rc *runCtx) error {
	return db.WithTx(ctx, e.cfg.Pool, func(tx pgx.Tx) error {
		return runs.FinishCancelled(ctx, tx, rc.run.ID)
	})
}

// finalizeError closes the run with status error whatever its cases say.
func (e *Executor) finalizeError(ctx context.Context, rc *runCtx) error {
	msg := rc.errMsg
	if msg == "" {
		msg = runs.DefaultErrorMessage
	}
	return db.WithTx(ctx, e.cfg.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE runs SET status = 'error', finished_at = now(), resume_position = NULL,
				started_at = COALESCE(started_at, now()), error_message = $2, updated_at = now()
			WHERE id = $1`, rc.run.ID, rc.mask.String(msg)); err != nil {
			return err
		}
		if err := runs.SyncLastRunStatus(ctx, tx, rc.run.ID); err != nil {
			return err
		}
		rc.run.Status = runs.StatusError
		return events.Notify(ctx, tx, events.Event{Type: events.RunFinished, RunKey: rc.run.Key, Status: runs.StatusError})
	})
}

// abortRun ends a run in error (crash, timeout, shutdown, panic): cases interrupted
// mid-execution become error, untouched ones skipped.
func (e *Executor) abortRun(ctx context.Context, rc *runCtx) error {
	if err := e.skipOpen(ctx, rc); err != nil {
		return err
	}
	return e.finalizeError(ctx, rc)
}

// skipOpen closes every open case after an abort: running cases become error, pending
// cases skipped; open steps skipped.
func (e *Executor) skipOpen(ctx context.Context, rc *runCtx) error {
	return db.WithTx(ctx, e.cfg.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE run_steps s SET status = 'skipped'
			FROM run_cases c
			WHERE c.id = s.run_case_id AND c.run_id = $1 AND s.status IN ('pending', 'running')`, rc.run.ID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			UPDATE run_cases SET
				status = CASE WHEN status = 'running' THEN 'error' ELSE 'skipped' END,
				finished_at = CASE WHEN started_at IS NULL THEN finished_at ELSE now() END,
				duration_ms = CASE WHEN started_at IS NULL THEN duration_ms
					ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer END
			WHERE run_id = $1 AND status IN ('pending', 'running')`, rc.run.ID)
		return err
	})
}

// ---------------------------------------------------------------- segments

type segOutcome int

const (
	segDone      segOutcome = iota // runner finished the segment (passed/failed/error)
	segCancelled                   // user cancel
	segAborted                     // crash, timeout, shutdown → run error (rc.errMsg set)
)

type segCase struct {
	id         uuid.UUID
	key        string // test case key (artifact names)
	position   int
	testCaseID uuid.UUID
	cof        bool
}

type segStep struct {
	id       uuid.UUID
	caseID   uuid.UUID
	position int
	stepID   string
	action   string
	cof      bool
	enabled  bool
}

// runSegment executes consecutive automated cases with one run.start.
func (e *Executor) runSegment(ctx context.Context, rc *runCtx, seg []CaseState) (segOutcome, error) {
	dbctx := context.WithoutCancel(ctx)
	log := e.log.With("run_id", rc.run.ID)

	ids := make([]uuid.UUID, 0, len(seg))
	for _, c := range seg {
		ids = append(ids, uuid.MustParse(c.ID))
	}
	cases, steps, err := e.loadSegment(dbctx, ids)
	if err != nil {
		return segAborted, err
	}

	// A segment never crosses a device boundary (NextPlan): one device per run.start.
	msg := &RunStart{
		RunID:         rc.run.ID.String(),
		ArtifactDir:   rc.dir,
		Options:       runnerOptions(rc.run.Options, rc.deviceFor(seg[0].DeviceIndex)),
		SharedSession: rc.run.SharedSession,
		StopOnFailure: rc.run.StopOnFailure,
		Env:           rc.env,
		Secrets:       map[string]any{},
		Vars:          rc.snap.Vars,
	}
	for k, v := range rc.secrets {
		msg.Secrets[k] = v
	}
	caseByID := map[uuid.UUID]*segCase{}
	stepByID := map[uuid.UUID]*segStep{}
	for i := range cases {
		c := &cases[i]
		caseByID[c.id] = c
		sc, ok := rc.snap.caseFor(c.id.String(), c.position, c.testCaseID.String())
		if !ok {
			rc.errMsg = fmt.Sprintf("The run snapshot has no steps for case %s", c.key)
			return segAborted, nil
		}
		wc := WireCase{CaseID: c.id.String(), ContinueOnFailure: c.cof, Vars: sc.Vars, Steps: []map[string]any{}}
		if wc.Vars == nil {
			wc.Vars = map[string]any{}
		}
		for j := range steps {
			st := &steps[j]
			if st.caseID != c.id {
				continue
			}
			stepByID[st.id] = st
			dslStep, ok := sc.stepFor(st.stepID, st.position)
			if !ok {
				rc.errMsg = fmt.Sprintf("The run snapshot has no step %d for case %s", st.position, c.key)
				return segAborted, nil
			}
			wc.Steps = append(wc.Steps, wireStep(dslStep, st.id.String(), st.action, st.enabled, st.cof))
		}
		msg.Cases = append(msg.Cases, wc)
	}

	if err := os.MkdirAll(rc.dir, 0o750); err != nil {
		rc.errMsg = "Could not create the artifact directory"
		log.Error("create artifact dir", "dir", rc.dir, "err", err)
		return segAborted, nil
	}

	sess, err := e.cfg.Runner.StartRun(ctx, msg, rc.mask)
	if err != nil {
		if ctx.Err() != nil {
			rc.errMsg = "The worker stopped before the run could start"
		} else {
			rc.errMsg = rc.mask.String("The test runner is unavailable: " + err.Error())
		}
		log.Error("start run on runner", "err", err)
		return segAborted, nil
	}
	finished := false // run.finished received or the runner died
	defer func() {
		if !finished {
			// Leaving early (database error): stop the runner from executing the run blind.
			_ = sess.Cancel()
		}
		sess.Close()
	}()

	h := &segHandler{e: e, rc: rc, cases: caseByID, steps: stepByID, tracker: newCaseTracker(), log: log}

	poll := time.NewTicker(e.cfg.CancelPoll)
	defer poll.Stop()
	timeout := time.NewTimer(time.Until(rc.deadline))
	defer timeout.Stop()
	var (
		graceC    <-chan time.Time
		reason    string // "cancel" | "timeout" | "shutdown"
		parentCtx = ctx.Done()
	)
	startCancel := func(why string) {
		if reason != "" {
			return
		}
		reason = why
		if err := sess.Cancel(); err != nil {
			log.Warn("send run.cancel", "err", err)
		}
		graceC = time.After(e.cfg.CancelGrace)
	}
	finish := func(runnerStatus string) segOutcome {
		switch reason {
		case "timeout":
			rc.errMsg = fmt.Sprintf("Run timed out after %s", rc.timeout)
			return segAborted
		case "shutdown":
			rc.errMsg = "The worker stopped while the run was executing"
			return segAborted
		case "cancel":
			return segCancelled
		}
		if runnerStatus == "cancelled" {
			// The runner cancels on its own only when it is being stopped (SIGTERM,
			// broken stdout). Without a user cancel that is an infrastructure error.
			var requested bool
			_ = e.cfg.Pool.QueryRow(context.WithoutCancel(ctx), `SELECT cancel_requested FROM runs WHERE id = $1`, rc.run.ID).Scan(&requested)
			if requested {
				return segCancelled
			}
			rc.errMsg = "The test runner stopped the run unexpectedly"
			return segAborted
		}
		return segDone
	}

	for {
		evs, serr := sess.Drain()
		for _, ev := range evs {
			if ev.Type == evRunFinished {
				finished = true
				if err := h.closeSegment(dbctx, ev.Status); err != nil {
					return segAborted, err
				}
				return finish(ev.Status), nil
			}
			if err := h.handle(dbctx, ev); err != nil {
				return segAborted, err
			}
		}
		if len(evs) == 0 && serr != nil {
			finished = true
			log.Error("runner failed during run", "err", serr)
			switch reason {
			case "cancel":
				return segCancelled, nil
			case "timeout", "shutdown":
				return finish(""), nil
			}
			rc.errMsg = "The test runner crashed during the run"
			if h.lastRunnerErr != "" {
				rc.errMsg += ": " + h.lastRunnerErr
			}
			return segAborted, nil
		}
		if len(evs) > 0 {
			continue // drain everything before waiting again
		}
		select {
		case <-sess.Wait():
		case <-poll.C:
			if reason == "" {
				var cancel bool
				if err := e.cfg.Pool.QueryRow(dbctx, `SELECT cancel_requested FROM runs WHERE id = $1`, rc.run.ID).Scan(&cancel); err != nil {
					log.Warn("poll cancel_requested", "err", err)
				} else if cancel {
					log.Info("cancel requested; sending run.cancel")
					startCancel("cancel")
				}
			}
		case <-timeout.C:
			log.Warn("run timed out; sending run.cancel", "timeout", rc.timeout.String())
			startCancel("timeout")
		case <-parentCtx:
			parentCtx = nil
			log.Warn("worker stopping; cancelling run")
			startCancel("shutdown")
		case <-graceC:
			log.Warn("runner did not finish the run within the cancel grace period", "reason", reason)
			return finish(""), nil
		}
	}
}

// runnerOptions passes the RunOptions the runner understands, with viewport = the
// segment's device size and device = its emulation (docs/14: playwright is the
// descriptor name supplying the user agent, null for custom devices).
func runnerOptions(o map[string]any, dev devices.Device) map[string]any {
	out := map[string]any{}
	for _, k := range []string{"browser", "headless", "screenshot", "video", "step_timeout_ms", "retries"} {
		if v, ok := o[k]; ok && v != nil {
			out[k] = v
		}
	}
	out["viewport"] = map[string]any{"width": dev.Width, "height": dev.Height}
	out["device"] = map[string]any{
		"id": dev.ID, "label": dev.Label, "category": dev.Category,
		"width": dev.Width, "height": dev.Height, "device_scale_factor": dev.DeviceScaleFactor,
		"is_mobile": dev.IsMobile, "has_touch": dev.HasTouch, "playwright": dev.PlaywrightName(),
	}
	return out
}

// deviceFor returns the run's device at index (the first device when the index is
// out of range, which only a corrupted run could produce).
func (rc *runCtx) deviceFor(index int) devices.Device {
	if index >= 0 && index < len(rc.devices) {
		return rc.devices[index]
	}
	return rc.devices[0]
}

func (e *Executor) loadSegment(ctx context.Context, caseIDs []uuid.UUID) ([]segCase, []segStep, error) {
	rows, err := e.cfg.Pool.Query(ctx, `
		SELECT id, test_case_key, position, test_case_id, continue_on_failure
		FROM run_cases WHERE id = ANY ($1) ORDER BY position`, caseIDs)
	if err != nil {
		return nil, nil, err
	}
	cases, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (segCase, error) {
		var c segCase
		err := row.Scan(&c.id, &c.key, &c.position, &c.testCaseID, &c.cof)
		return c, err
	})
	if err != nil {
		return nil, nil, err
	}
	rows, err = e.cfg.Pool.Query(ctx, `
		SELECT s.id, s.run_case_id, s.position, s.step_id, s.action, s.continue_on_failure, s.enabled
		FROM run_steps s JOIN run_cases c ON c.id = s.run_case_id
		WHERE s.run_case_id = ANY ($1) ORDER BY c.position, s.position`, caseIDs)
	if err != nil {
		return nil, nil, err
	}
	steps, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (segStep, error) {
		var s segStep
		err := row.Scan(&s.id, &s.caseID, &s.position, &s.stepID, &s.action, &s.cof, &s.enabled)
		return s, err
	})
	return cases, steps, err
}

// segHandler applies runner events of one segment to the database.
type segHandler struct {
	e             *Executor
	rc            *runCtx
	cases         map[uuid.UUID]*segCase
	steps         map[uuid.UUID]*segStep
	tracker       *caseTracker
	lastRunnerErr string
	log           *slog.Logger
}

func (h *segHandler) handle(ctx context.Context, ev Event) error {
	if ev.Type == evRunnerError {
		h.lastRunnerErr = h.rc.mask.String(ev.Message)
		h.log.Error("runner error", "message", h.lastRunnerErr)
		return nil
	}
	caseID, err := uuid.Parse(ev.CaseID)
	if err != nil || h.cases[caseID] == nil {
		h.log.Warn("ignoring event for a case outside the segment", "type", ev.Type, "case_id", ev.CaseID)
		return nil
	}
	c := h.cases[caseID]
	var st *segStep
	if ev.Type == evStepStarted || ev.Type == evStepFinished {
		stepID, err := uuid.Parse(ev.StepID)
		if err != nil || h.steps[stepID] == nil || h.steps[stepID].caseID != caseID {
			h.log.Warn("ignoring event for an unknown step", "type", ev.Type, "step_id", ev.StepID)
			return nil
		}
		st = h.steps[stepID]
	}
	pool := h.e.cfg.Pool
	switch ev.Type {
	case evCaseStarted:
		if h.tracker.isFinished(ev.CaseID) {
			return nil
		}
		return db.WithTx(ctx, pool, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `
				UPDATE run_cases SET status = 'running', started_at = COALESCE(started_at, now())
				WHERE id = $1 AND status IN ('pending', 'running')`, caseID); err != nil {
				return err
			}
			return h.e.notify(ctx, tx, h.rc, events.CaseStarted, &caseID, nil, "running")
		})
	case evStepStarted:
		return db.WithTx(ctx, pool, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `
				UPDATE run_steps SET status = 'running', started_at = now(), finished_at = NULL,
					duration_ms = NULL, error_message = NULL, details = NULL
				WHERE id = $1`, st.id); err != nil {
				return err
			}
			return h.e.notify(ctx, tx, h.rc, events.StepStarted, &caseID, &st.id, "running")
		})
	case evStepFinished:
		return h.stepFinished(ctx, ev, c, st)
	case evCaseFinished:
		return h.caseFinished(ctx, ev, c)
	}
	return nil
}

func (h *segHandler) stepFinished(ctx context.Context, ev Event, c *segCase, st *segStep) error {
	var details []byte
	if len(ev.Details) > 0 {
		details = h.rc.mask.JSON(ev.Details)
	}
	errMsg := h.rc.mask.Ptr(ev.Error)
	var dur *int64
	if ev.DurationMS != nil {
		d := max(*ev.DurationMS, 0)
		dur = &d
	}
	return db.WithTx(ctx, h.e.cfg.Pool, func(tx pgx.Tx) error {
		var shot *uuid.UUID
		if ev.Screenshot != nil && *ev.Screenshot != "" {
			name := fmt.Sprintf("%s-step-%d", c.key, st.position)
			if ev.Status == "failed" || ev.Status == "error" {
				name += "-failed"
			}
			if id, ok := h.saveArtifact(ctx, tx, c, &st.id, artifacts.KindScreenshot, name+".png", "image/png", *ev.Screenshot); ok {
				shot = &id
			}
		}
		if _, err := tx.Exec(ctx, `
			UPDATE run_steps SET status = $2, duration_ms = $3, error_message = $4, details = $5,
				screenshot_artifact_id = $6,
				started_at = CASE WHEN $2 = 'skipped' THEN started_at
					ELSE COALESCE(started_at, now() - make_interval(secs => COALESCE($3, 0)::double precision / 1000)) END,
				finished_at = CASE WHEN $2 = 'skipped' AND started_at IS NULL THEN NULL ELSE now() END
			WHERE id = $1`, st.id, ev.Status, dur, errMsg, details, shot); err != nil {
			return err
		}
		return h.e.notify(ctx, tx, h.rc, events.StepFinished, &c.id, &st.id, ev.Status)
	})
}

// caseFinished is an idempotent upsert: the first case.finished sets the result, a repeat
// (shared-session video) only attaches the video.
func (h *segHandler) caseFinished(ctx context.Context, ev Event, c *segCase) error {
	first := h.tracker.finish(ev.CaseID, ev.Status)
	return db.WithTx(ctx, h.e.cfg.Pool, func(tx pgx.Tx) error {
		var video *uuid.UUID
		if ev.Video != nil && *ev.Video != "" {
			if id, ok := h.saveArtifact(ctx, tx, c, nil, artifacts.KindVideo, c.key+".webm", "video/webm", *ev.Video); ok {
				video = &id
			}
		}
		if first {
			if _, err := tx.Exec(ctx, `
				UPDATE run_steps SET status = 'skipped'
				WHERE run_case_id = $1 AND status IN ('pending', 'running')`, c.id); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE run_cases SET status = $2,
					finished_at = CASE WHEN started_at IS NULL THEN NULL ELSE now() END,
					duration_ms = CASE WHEN started_at IS NULL THEN NULL
						ELSE (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer END,
					video_artifact_id = COALESCE($3, video_artifact_id)
				WHERE id = $1`, c.id, ev.Status, video); err != nil {
				return err
			}
		} else if video != nil {
			if _, err := tx.Exec(ctx, `UPDATE run_cases SET video_artifact_id = $2 WHERE id = $1`, c.id, video); err != nil {
				return err
			}
		} else {
			return nil
		}
		return h.e.notify(ctx, tx, h.rc, events.CaseFinished, &c.id, nil, ev.Status)
	})
}

// saveArtifact stores a runner file. Paths outside artifact_dir are refused (the runner
// must never make the worker read arbitrary files). Failures are logged, not fatal.
func (h *segHandler) saveArtifact(ctx context.Context, q db.Querier, c *segCase, stepID *uuid.UUID, kind, name, mime, path string) (uuid.UUID, bool) {
	clean := filepath.Clean(path)
	rel, err := filepath.Rel(h.rc.dir, clean)
	if err != nil || !filepath.IsAbs(clean) || rel == "." || strings.HasPrefix(rel, "..") {
		h.log.Warn("refusing artifact outside the artifact dir", "path", path)
		return uuid.Nil, false
	}
	if h.e.cfg.Stores == nil {
		return uuid.Nil, false
	}
	caseID := c.id
	a, err := artifacts.SaveFile(ctx, q, h.e.cfg.Stores, h.rc.run.ProjectID, h.rc.run.ID, &caseID, stepID, kind, name, mime, clean)
	if err != nil {
		h.log.Warn("could not save artifact", "kind", kind, "path", path, "err", err)
		return uuid.Nil, false
	}
	return a.ID, true
}

// closeSegment runs after run.finished: cases the runner never reported (e.g. invalid
// run.start → run.finished error) become error so the planner does not run them again.
func (h *segHandler) closeSegment(ctx context.Context, runnerStatus string) error {
	if runnerStatus == "error" && h.lastRunnerErr != "" {
		h.rc.errMsg = h.lastRunnerErr
	}
	var open []uuid.UUID
	for id := range h.cases {
		if !h.tracker.isFinished(id.String()) {
			open = append(open, id)
		}
	}
	if len(open) == 0 || runnerStatus == "cancelled" {
		return nil
	}
	return db.WithTx(ctx, h.e.cfg.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE run_steps SET status = 'skipped'
			WHERE run_case_id = ANY ($1) AND status IN ('pending', 'running')`, open); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE run_cases SET status = 'error',
				finished_at = CASE WHEN started_at IS NULL THEN NULL ELSE now() END
			WHERE id = ANY ($1) AND status IN ('pending', 'running')`, open); err != nil {
			return err
		}
		for _, id := range open {
			if err := h.e.notify(ctx, tx, h.rc, events.CaseFinished, &id, nil, "error"); err != nil {
				return err
			}
		}
		if h.rc.errMsg == "" {
			h.rc.errMsg = "The test runner did not report every case"
		}
		return nil
	})
}
