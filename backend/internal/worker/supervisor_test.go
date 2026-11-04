package worker

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// The test binary doubles as a fake runner (QATLAS_FAKE_RUNNER=1): it speaks the NDJSON
// protocol without Node/Playwright. run_id prefixes select behaviour:
//
//	crash…  emit case.started, then exit 3
//	hang…   emit case.started and wait for run.cancel → run.finished cancelled
//	other   every step passed, case passed, run passed (concurrently, interleaved)
func TestMain(m *testing.M) {
	if os.Getenv("QATLAS_FAKE_RUNNER") == "1" {
		fakeRunner()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func fakeRunner() {
	out := json.NewEncoder(os.Stdout)
	var mu sync.Mutex
	emit := func(v map[string]any) {
		mu.Lock()
		defer mu.Unlock()
		_ = out.Encode(v)
	}
	emit(map[string]any{"type": "ready", "playwright": "fake"})
	cancels := map[string]chan struct{}{}
	var wg sync.WaitGroup
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for sc.Scan() {
		var msg RunStart
		if err := json.Unmarshal(sc.Bytes(), &msg); err != nil {
			emit(map[string]any{"type": "runner.error", "run_id": nil, "message": "bad line"})
			continue
		}
		switch msg.Type {
		case "run.cancel":
			mu.Lock()
			ch := cancels[msg.RunID]
			mu.Unlock()
			if ch != nil {
				close(ch)
			}
		case "run.start":
			ch := make(chan struct{})
			mu.Lock()
			cancels[msg.RunID] = ch
			mu.Unlock()
			wg.Add(1)
			go func(msg RunStart) {
				defer wg.Done()
				id := msg.RunID
				switch {
				case strings.HasPrefix(id, "crash"):
					emit(map[string]any{"type": "case.started", "run_id": id, "case_id": msg.Cases[0].CaseID})
					time.Sleep(50 * time.Millisecond)
					os.Exit(3)
				case strings.HasPrefix(id, "hang"):
					emit(map[string]any{"type": "case.started", "run_id": id, "case_id": msg.Cases[0].CaseID})
					<-ch
					emit(map[string]any{"type": "case.finished", "run_id": id, "case_id": msg.Cases[0].CaseID, "status": "skipped", "video": nil})
					emit(map[string]any{"type": "run.finished", "run_id": id, "status": "cancelled"})
				default:
					for _, c := range msg.Cases {
						emit(map[string]any{"type": "case.started", "run_id": id, "case_id": c.CaseID})
						for _, st := range c.Steps {
							emit(map[string]any{"type": "step.started", "run_id": id, "case_id": c.CaseID, "step_id": st["step_id"]})
							time.Sleep(5 * time.Millisecond)
							emit(map[string]any{"type": "step.finished", "run_id": id, "case_id": c.CaseID, "step_id": st["step_id"],
								"status": "passed", "duration_ms": 5, "error": nil, "screenshot": nil, "details": nil})
						}
						emit(map[string]any{"type": "case.finished", "run_id": id, "case_id": c.CaseID, "status": "passed", "video": nil})
					}
					emit(map[string]any{"type": "run.finished", "run_id": id, "status": "passed"})
				}
			}(msg)
		}
	}
	wg.Wait() // stdin EOF: finish in-flight runs, then exit 0 (like the real runner)
}

func fakeSupervisor(t *testing.T) *Supervisor {
	t.Helper()
	sup, err := NewSupervisor(SupervisorConfig{
		Command:       os.Args[0] + " -test.run=^$",
		Env:           []string{"QATLAS_FAKE_RUNNER=1"},
		MinBackoff:    50 * time.Millisecond,
		MaxBackoff:    200 * time.Millisecond,
		ShutdownGrace: 2 * time.Second,
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	sup.Start()
	t.Cleanup(sup.Close)
	return sup
}

// collect drains a session until run.finished or a terminal error.
func collect(t *testing.T, sess *RunSession, timeout time.Duration) ([]Event, error) {
	t.Helper()
	deadline := time.After(timeout)
	var all []Event
	for {
		evs, err := sess.Drain()
		for _, ev := range evs {
			all = append(all, ev)
			if ev.Type == evRunFinished {
				return all, nil
			}
		}
		if len(evs) == 0 && err != nil {
			return all, err
		}
		if len(evs) > 0 {
			continue
		}
		select {
		case <-sess.Wait():
		case <-deadline:
			return all, fmt.Errorf("timeout; events so far: %+v", all)
		}
	}
}

func startMsg(runID string, cases, steps int) *RunStart {
	msg := &RunStart{RunID: runID}
	for c := range cases {
		wc := WireCase{CaseID: fmt.Sprintf("%s-c%d", runID, c)}
		for s := range steps {
			wc.Steps = append(wc.Steps, map[string]any{"step_id": fmt.Sprintf("%s-c%d-s%d", runID, c, s), "action": "wait"})
		}
		msg.Cases = append(msg.Cases, wc)
	}
	return msg
}

func TestSupervisorMultiplexesRuns(t *testing.T) {
	sup := fakeSupervisor(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := fmt.Sprintf("run%d", i)
			sess, err := sup.StartRun(ctx, startMsg(id, 2, 3), NewMasker(nil))
			if err != nil {
				t.Error(err)
				return
			}
			defer sess.Close()
			evs, err := collect(t, sess, 10*time.Second)
			if err != nil {
				t.Error(err)
				return
			}
			// 2 cases × (started + 3×2 step events + finished) + run.finished
			if len(evs) != 2*(1+6+1)+1 {
				t.Errorf("%s: %d events", id, len(evs))
			}
			for _, ev := range evs {
				if ev.Run() != id {
					t.Errorf("%s received an event of %s", id, ev.Run())
				}
			}
			if last := evs[len(evs)-1]; last.Status != "passed" {
				t.Errorf("%s: final %+v", id, last)
			}
		}()
	}
	wg.Wait()
	if sup.Playwright() != "fake" {
		t.Fatalf("playwright = %q", sup.Playwright())
	}
	if _, err := sup.StartRun(ctx, startMsg("dup", 1, 1), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := sup.StartRun(ctx, startMsg("dup", 1, 1), nil); err == nil {
		t.Fatal("a run_id already in flight must be refused")
	}
}

func TestSupervisorCrashRestartAndCancel(t *testing.T) {
	sup := fakeSupervisor(t)
	ctx := context.Background()

	bystander, err := sup.StartRun(ctx, startMsg("hang-bystander", 1, 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bystander.Close()
	crash, err := sup.StartRun(ctx, startMsg("crash-1", 1, 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer crash.Close()
	evs, err := collect(t, crash, 10*time.Second)
	if !errors.Is(err, ErrRunnerCrashed) {
		t.Fatalf("crash: err=%v events=%+v", err, evs)
	}
	if len(evs) != 1 || evs[0].Type != evCaseStarted {
		t.Fatalf("events before the crash must still be delivered: %+v", evs)
	}
	// Every run in flight on the dead process fails, not just the one that crashed it.
	if _, err := collect(t, bystander, 10*time.Second); !errors.Is(err, ErrRunnerCrashed) {
		t.Fatalf("bystander: %v", err)
	}

	// The supervisor restarts the runner; StartRun waits for it to be ready.
	ok, err := sup.StartRun(ctx, startMsg("after-crash", 1, 2), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ok.Close()
	if evs, err := collect(t, ok, 10*time.Second); err != nil || evs[len(evs)-1].Status != "passed" {
		t.Fatalf("after restart: %v %+v", err, evs)
	}

	hang, err := sup.StartRun(ctx, startMsg("hang-2", 1, 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hang.Close()
	time.Sleep(50 * time.Millisecond)
	if err := hang.Cancel(); err != nil {
		t.Fatal(err)
	}
	evs, err = collect(t, hang, 10*time.Second)
	if err != nil || evs[len(evs)-1].Status != "cancelled" {
		t.Fatalf("cancel: %v %+v", err, evs)
	}
}

func TestSupervisorUnavailableRunner(t *testing.T) {
	sup, err := NewSupervisor(SupervisorConfig{
		Command:    "/definitely/not/a/runner main.js",
		StartWait:  300 * time.Millisecond,
		MinBackoff: 50 * time.Millisecond,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	sup.Start()
	defer sup.Close()
	_, err = sup.StartRun(context.Background(), startMsg("x", 1, 1), nil)
	if err == nil || !strings.Contains(err.Error(), "runner unavailable") {
		t.Fatalf("err = %v", err)
	}
	if _, err := NewSupervisor(SupervisorConfig{Command: "  "}); err == nil {
		t.Fatal("empty command must be rejected")
	}
}
