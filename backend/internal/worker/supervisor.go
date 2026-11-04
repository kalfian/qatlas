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
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ErrRunnerCrashed is reported to every in-flight run when the runner process exits.
var ErrRunnerCrashed = errors.New("runner process exited unexpectedly")

// ErrSupervisorClosed is returned once Close has been called.
var ErrSupervisorClosed = errors.New("runner supervisor is shut down")

// SupervisorConfig configures the runner process.
type SupervisorConfig struct {
	// Command is the runner command line (QATLAS_RUNNER_CMD), split on whitespace.
	Command string
	// Dir is the working directory ("" = current).
	Dir string
	// Env is appended to the worker's environment.
	Env []string
	// ReadyTimeout bounds the wait for the "ready" line (default 60 s).
	ReadyTimeout time.Duration
	// StartWait bounds how long StartRun waits for a ready runner (default 90 s).
	StartWait time.Duration
	// ShutdownGrace is how long Close waits after closing stdin before SIGTERM, and
	// after SIGTERM before SIGKILL (default 10 s each).
	ShutdownGrace time.Duration
	// MinBackoff / MaxBackoff bound the restart delay (defaults 1 s / 30 s).
	MinBackoff, MaxBackoff time.Duration
	Logger                 *slog.Logger
}

// Supervisor owns one long-lived runner process and multiplexes concurrent runs over
// it by run_id. It restarts the process with exponential backoff when it exits; runs
// in flight at that moment fail with ErrRunnerCrashed.
type Supervisor struct {
	cfg  SupervisorConfig
	argv []string
	log  *slog.Logger

	mu       sync.Mutex
	proc     *runnerProc            // nil while (re)starting
	ready    chan struct{}          // closed when proc becomes ready; replaced on restart
	lastErr  error                  // why the last process is gone (for StartRun errors)
	sessions map[string]*RunSession // run_id → session
	closed   bool

	stop     chan struct{}
	loopDone chan struct{}
}

type runnerProc struct {
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	writeMu    sync.Mutex
	exited     chan struct{}
	playwright string
}

// NewSupervisor validates the command; Start launches the process.
func NewSupervisor(cfg SupervisorConfig) (*Supervisor, error) {
	argv := strings.Fields(cfg.Command)
	if len(argv) == 0 {
		return nil, errors.New("runner command is empty (QATLAS_RUNNER_CMD)")
	}
	if cfg.ReadyTimeout <= 0 {
		cfg.ReadyTimeout = 60 * time.Second
	}
	if cfg.StartWait <= 0 {
		cfg.StartWait = 90 * time.Second
	}
	if cfg.ShutdownGrace <= 0 {
		cfg.ShutdownGrace = 10 * time.Second
	}
	if cfg.MinBackoff <= 0 {
		cfg.MinBackoff = time.Second
	}
	if cfg.MaxBackoff <= 0 {
		cfg.MaxBackoff = 30 * time.Second
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Supervisor{
		cfg:      cfg,
		argv:     argv,
		log:      cfg.Logger.With("component", "runner"),
		ready:    make(chan struct{}),
		sessions: map[string]*RunSession{},
		stop:     make(chan struct{}),
		loopDone: make(chan struct{}),
		lastErr:  errors.New("runner is starting"),
	}, nil
}

// ResolveRunnerCommand makes the default relative command work from the repository root
// and from backend/ (go run): when the script argument is a relative path that does not
// exist, the parent directories of the working directory are searched for it.
func ResolveRunnerCommand(command string) string {
	argv := strings.Fields(command)
	if len(argv) < 2 || filepath.IsAbs(argv[1]) || !strings.HasSuffix(argv[1], ".js") {
		return command
	}
	if _, err := os.Stat(argv[1]); err == nil {
		return command
	}
	wd, err := os.Getwd()
	if err != nil {
		return command
	}
	for dir := filepath.Dir(wd); ; dir = filepath.Dir(dir) {
		cand := filepath.Join(dir, argv[1])
		if _, err := os.Stat(cand); err == nil {
			argv[1] = cand
			return strings.Join(argv, " ")
		}
		if dir == filepath.Dir(dir) {
			return command
		}
	}
}

// Start launches the supervision loop. It returns immediately; StartRun waits for the
// runner to become ready.
func (s *Supervisor) Start() {
	go s.loop()
}

func (s *Supervisor) loop() {
	defer close(s.loopDone)
	backoff := s.cfg.MinBackoff
	for {
		select {
		case <-s.stop:
			return
		default:
		}
		started := time.Now()
		err := s.runOnce()
		s.failAll(err)
		select {
		case <-s.stop:
			return
		default:
		}
		if time.Since(started) > time.Minute {
			backoff = s.cfg.MinBackoff // it ran fine for a while: restart quickly
		}
		s.log.Error("runner exited; restarting", "err", err, "in", backoff.String())
		select {
		case <-s.stop:
			return
		case <-time.After(backoff):
		}
		backoff = min(2*backoff, s.cfg.MaxBackoff)
	}
}

// runOnce starts the process, serves it until it exits and returns why it exited.
func (s *Supervisor) runOnce() error {
	cmd := exec.Command(s.argv[0], s.argv[1:]...)
	cmd.Dir = s.cfg.Dir
	cmd.Env = append(os.Environ(), s.cfg.Env...)
	setProcAttrs(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		s.setLastErr(fmt.Errorf("start runner %q: %w", s.cfg.Command, err))
		return fmt.Errorf("start runner: %w", err)
	}
	p := &runnerProc{cmd: cmd, stdin: stdin, exited: make(chan struct{})}
	s.log.Info("runner started", "pid", cmd.Process.Pid, "cmd", s.cfg.Command)

	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		s.pipeStderr(stderr)
	}()
	readyCh := make(chan string, 1)
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		s.readStdout(stdout, readyCh)
	}()
	waitErr := make(chan error, 1)
	go func() {
		<-readDone // drain both pipes before Wait closes them (os/exec contract)
		<-stderrDone
		err := cmd.Wait()
		close(p.exited)
		waitErr <- err
	}()

	select {
	case v := <-readyCh:
		p.playwright = v
		s.mu.Lock()
		s.proc = p
		close(s.ready)
		s.mu.Unlock()
		s.log.Info("runner ready", "playwright", v)
	case err := <-waitErr:
		err = fmt.Errorf("runner exited before ready: %v", err)
		s.setLastErr(err)
		return err
	case <-time.After(s.cfg.ReadyTimeout):
		killProcess(cmd)
		<-waitErr
		err := fmt.Errorf("runner not ready after %s", s.cfg.ReadyTimeout)
		s.setLastErr(err)
		return err
	case <-s.stop:
		killProcess(cmd)
		<-waitErr
		return ErrSupervisorClosed
	}

	var exitErr error
	select {
	case exitErr = <-waitErr:
	case <-s.stop:
		exitErr = s.shutdownProc(p, waitErr)
	}
	s.mu.Lock()
	s.proc = nil
	s.ready = make(chan struct{})
	if exitErr == nil {
		exitErr = errors.New("runner exited")
	}
	s.lastErr = exitErr
	s.mu.Unlock()
	return exitErr
}

// shutdownProc closes stdin (the runner finishes in-flight runs and exits), then
// escalates to SIGTERM (cancel in-flight runs) and SIGKILL.
func (s *Supervisor) shutdownProc(p *runnerProc, waitErr <-chan error) error {
	_ = p.stdin.Close()
	select {
	case err := <-waitErr:
		return orClosed(err)
	case <-time.After(s.cfg.ShutdownGrace):
	}
	terminateProcess(p.cmd)
	select {
	case err := <-waitErr:
		return orClosed(err)
	case <-time.After(s.cfg.ShutdownGrace):
	}
	killProcess(p.cmd)
	return orClosed(<-waitErr)
}

func orClosed(err error) error {
	if err == nil {
		return ErrSupervisorClosed
	}
	return fmt.Errorf("%w: %v", ErrSupervisorClosed, err)
}

func (s *Supervisor) setLastErr(err error) {
	s.mu.Lock()
	s.lastErr = err
	s.mu.Unlock()
}

func (s *Supervisor) readStdout(r io.Reader, readyCh chan<- string) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	gotReady := false
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		ev, err := DecodeEvent(line)
		if err != nil {
			s.log.Warn("ignoring runner output", "err", s.maskAll(err.Error()))
			continue
		}
		if ev.Type == evReady {
			if !gotReady {
				gotReady = true
				readyCh <- ev.Playwright
			}
			continue
		}
		if ev.Type == evRunnerError && ev.Run() == "" {
			s.log.Error("runner error", "message", s.maskAll(ev.Message))
			continue
		}
		s.mu.Lock()
		sess := s.sessions[ev.Run()]
		s.mu.Unlock()
		if sess == nil {
			s.log.Debug("dropping event for unknown run", "type", ev.Type, "run_id", ev.Run())
			continue
		}
		sess.push(ev)
	}
	if err := sc.Err(); err != nil {
		s.log.Error("reading runner stdout", "err", err)
	}
}

func (s *Supervisor) pipeStderr(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		s.log.Info("runner log", "line", s.maskAll(sc.Text()))
	}
}

// maskAll masks a log line with the secrets of every active run.
func (s *Supervisor) maskAll(line string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sess := range s.sessions {
		line = sess.mask.String(line)
	}
	return line
}

func (s *Supervisor) failAll(err error) {
	if err == nil {
		err = ErrRunnerCrashed
	}
	s.mu.Lock()
	sessions := make([]*RunSession, 0, len(s.sessions))
	for _, sess := range s.sessions {
		sessions = append(sessions, sess)
	}
	s.mu.Unlock()
	for _, sess := range sessions {
		sess.fail(fmt.Errorf("%w: %w", ErrRunnerCrashed, err))
	}
}

// Playwright reports the version announced by the ready line ("" when not ready).
func (s *Supervisor) Playwright() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc == nil {
		return ""
	}
	return s.proc.playwright
}

// StartRun waits for a ready runner, registers the run and sends run.start. Events for
// the run are read with the returned session, which must be closed.
func (s *Supervisor) StartRun(ctx context.Context, msg *RunStart, mask *Masker) (*RunSession, error) {
	msg.Type = "run.start"
	wait := time.NewTimer(s.cfg.StartWait)
	defer wait.Stop()
	for {
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return nil, ErrSupervisorClosed
		}
		p, ready, lastErr := s.proc, s.ready, s.lastErr
		if p != nil {
			if _, dup := s.sessions[msg.RunID]; dup {
				s.mu.Unlock()
				return nil, fmt.Errorf("run %s is already executing in this worker", msg.RunID)
			}
			sess := newRunSession(s, p, msg.RunID, mask)
			s.sessions[msg.RunID] = sess
			s.mu.Unlock()
			if err := p.send(msg); err != nil {
				sess.Close()
				return nil, fmt.Errorf("send run.start: %w", err)
			}
			return sess, nil
		}
		s.mu.Unlock()
		select {
		case <-ready:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-wait.C:
			return nil, fmt.Errorf("runner unavailable: %v", lastErr)
		}
	}
}

// Close stops supervising: closes the runner's stdin, waits for it to exit (escalating
// to signals) and fails remaining sessions.
func (s *Supervisor) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.mu.Unlock()
	close(s.stop)
	<-s.loopDone
	s.failAll(ErrSupervisorClosed)
}

func (p *runnerProc) send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	select {
	case <-p.exited:
		return ErrRunnerCrashed
	default:
	}
	_, err = p.stdin.Write(b)
	return err
}

// RunSession receives the events of one run. Events are queued without bound so a slow
// database never blocks the runner's stdout reader (which serves every run).
type RunSession struct {
	sup   *Supervisor
	proc  *runnerProc
	runID string
	mask  *Masker

	mu     sync.Mutex
	queue  []Event
	err    error
	notify chan struct{}
	closed bool
}

func newRunSession(s *Supervisor, p *runnerProc, runID string, mask *Masker) *RunSession {
	return &RunSession{sup: s, proc: p, runID: runID, mask: mask, notify: make(chan struct{}, 1)}
}

func (r *RunSession) push(ev Event) {
	r.mu.Lock()
	r.queue = append(r.queue, ev)
	r.mu.Unlock()
	r.signal()
}

func (r *RunSession) fail(err error) {
	r.mu.Lock()
	if r.err == nil {
		r.err = err
	}
	r.mu.Unlock()
	r.signal()
}

func (r *RunSession) signal() {
	select {
	case r.notify <- struct{}{}:
	default:
	}
}

// Wait is signalled whenever events or a terminal error are available.
func (r *RunSession) Wait() <-chan struct{} { return r.notify }

// Drain returns the queued events and the terminal error, if any (crash/shutdown).
// Queued events are always delivered before the error.
func (r *RunSession) Drain() ([]Event, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	evs := r.queue
	r.queue = nil
	if len(evs) > 0 {
		return evs, nil
	}
	return nil, r.err
}

// Cancel sends run.cancel.
func (r *RunSession) Cancel() error {
	return r.proc.send(runCancel{Type: "run.cancel", RunID: r.runID})
}

// Close unregisters the run; later events for it are dropped.
func (r *RunSession) Close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	r.mu.Unlock()
	r.sup.mu.Lock()
	if r.sup.sessions[r.runID] == r {
		delete(r.sup.sessions, r.runID)
	}
	r.sup.mu.Unlock()
}
