package storage

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/config"
)

// Defaults of Options.
const (
	DefaultProbeTimeout  = 20 * time.Second
	DefaultRetryInterval = time.Minute
)

// Options configures a Registry.
type Options struct {
	Pool   *pgxpool.Pool
	Config *config.Config // DataDir, MasterKey, StorageFromEnv, Storage, S3
	Logger *slog.Logger
	// Local overrides the local store (default QATLAS_DATA_DIR/artifacts).
	Local *artifacts.LocalStore
	// ProbeTimeout bounds one connection probe (default 20 s).
	ProbeTimeout time.Duration
	// RetryInterval re-probes S3 while the database settings select S3 but it
	// was unreachable (default 1 min).
	RetryInterval time.Duration
}

// Registry holds the active artifact stores of this process and swaps them
// atomically when the storage settings change (artifacts.Stores). Writer is
// the store for new artifacts; For serves rows by their recorded backend. The
// local store is always available.
//
// Cross-process reload: the PUT handler installs the new stores in its own
// process and NOTIFYs Channel; Start runs a dedicated LISTEN connection
// (reconnecting with backoff) that reloads the settings from the database on
// every notification and after every reconnect, plus a retry loop that
// re-probes S3 while it is in fallback.
type Registry struct {
	opts   Options
	log    *slog.Logger
	local  *artifacts.LocalStore
	static bool

	cur atomic.Pointer[state]
	mu  sync.Mutex // serialises loads/installs

	lifeMu sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
}

// state is one immutable configuration snapshot.
type state struct {
	set     artifacts.StoreSet
	source  string
	warning string
	// version is system_settings.updated_at of the loaded row (zero: none).
	version time.Time
	// retry: S3 is selected in the database but failed its probe; Writer falls
	// back to local until a re-probe succeeds.
	retry bool
}

var _ artifacts.Stores = (*Registry)(nil)

// New builds the registry and loads the active configuration.
//
// With QATLAS_STORAGE in the environment the environment config is used and
// probed; a failing probe is an error (the process refuses to start, as
// before). Otherwise the database settings are loaded; a broken S3
// configuration there is logged loudly and new artifacts fall back to local
// storage (the admin fixes it in the UI) — New never fails because of it.
func New(ctx context.Context, opts Options) (*Registry, error) {
	if opts.Config == nil {
		return nil, errors.New("storage: config is required")
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.ProbeTimeout <= 0 {
		opts.ProbeTimeout = DefaultProbeTimeout
	}
	if opts.RetryInterval <= 0 {
		opts.RetryInterval = DefaultRetryInterval
	}
	local := opts.Local
	if local == nil {
		ls, err := artifacts.NewLocalStore(filepath.Join(opts.Config.DataDir, "artifacts"))
		if err != nil {
			return nil, err
		}
		local = ls
	}
	r := &Registry{opts: opts, log: opts.Logger.With("component", "storage"), local: local}
	var st *state
	if opts.Config.StorageFromEnv {
		var err error
		if st, err = r.loadEnv(ctx, true); err != nil {
			return nil, err
		}
	} else {
		if opts.Pool == nil {
			return nil, errors.New("storage: pool is required")
		}
		st = r.loadDB(ctx, nil)
	}
	r.cur.Store(st)
	r.logState(st, "artifact storage ready")
	return r, nil
}

// NewStatic is a registry with fixed stores (tests, tools): active is the
// writer, local serves "local" rows. It behaves like an environment override
// (source "env"): the settings cannot be changed through the API.
func NewStatic(local *artifacts.LocalStore, active artifacts.Store) *Registry {
	set := artifacts.StoreSet{Active: config.StorageLocal, Local: local}
	if active != nil && artifacts.Backend(active) == config.StorageS3 {
		set.Active, set.S3 = config.StorageS3, active
	} else if active != nil {
		set.Local = active
	}
	r := &Registry{local: local, static: true, log: slog.Default()}
	r.cur.Store(&state{set: set, source: SourceEnv})
	return r
}

// Writer implements artifacts.Stores.
func (r *Registry) Writer() (string, artifacts.Store) { return r.cur.Load().set.Writer() }

// For implements artifacts.Stores.
func (r *Registry) For(backend string) (artifacts.Store, error) { return r.cur.Load().set.For(backend) }

// Local is the local store (always available).
func (r *Registry) Local() *artifacts.LocalStore { return r.local }

// EnvOverride reports whether QATLAS_STORAGE (or a static registry) fixes the configuration.
func (r *Registry) EnvOverride() bool { return r.cur.Load().source == SourceEnv }

// Status is a snapshot of the active configuration.
type Status struct {
	Active  string // backend of new artifacts
	Source  string // default | database | env
	Warning string // non-empty while the configured storage cannot be used
	// Fallback: S3 is selected in the database but unreachable; new artifacts go to local.
	Fallback bool
}

// Status returns the current snapshot.
func (r *Registry) Status() Status {
	st := r.cur.Load()
	return Status{Active: st.set.Active, Source: st.source, Warning: st.warning, Fallback: st.retry}
}

func (r *Registry) logState(st *state, msg string) {
	_, w := st.set.Writer()
	attrs := []any{"active", st.set.Active, "source", st.source, "store", describe(w)}
	if st.set.S3 != nil && st.set.Active != config.StorageS3 {
		attrs = append(attrs, "s3_reads", describe(st.set.S3))
	}
	if st.warning != "" {
		r.log.Error(msg+" with a problem: "+st.warning, attrs...)
		return
	}
	r.log.Info(msg, attrs...)
}

func describe(s artifacts.Store) string {
	switch st := s.(type) {
	case *artifacts.LocalStore:
		return "local " + st.Root
	case fmt.Stringer:
		return st.String()
	case nil:
		return "none"
	}
	return artifacts.Backend(s)
}

// probe runs the connection probe with ProbeTimeout.
func (r *Registry) probe(ctx context.Context, s artifacts.Store) error {
	pctx, cancel := context.WithTimeout(ctx, r.opts.ProbeTimeout)
	defer cancel()
	return artifacts.ProbeError(artifacts.Probe(pctx, s))
}

// buildS3 builds the S3 store and a fast-failing twin for probes.
func buildS3(cfg config.S3Config) (store, probe *artifacts.S3Store, err error) {
	if store, err = artifacts.NewS3Store(cfg); err != nil {
		return nil, nil, err
	}
	if probe, err = artifacts.NewS3Store(cfg, artifacts.WithMaxRetries(1)); err != nil {
		return nil, nil, err
	}
	return store, probe, nil
}

// loadEnv builds the environment configuration. S3 reads use the environment
// S3 settings when complete, else the database ones (so artifacts written to
// S3 stay readable). With probe, the active store must pass the probe.
func (r *Registry) loadEnv(ctx context.Context, probe bool) (*state, error) {
	cfg := r.opts.Config
	st := &state{source: SourceEnv, set: artifacts.StoreSet{Active: cfg.Storage, Local: r.local}}
	var probeStore artifacts.Store = r.local
	if cfg.S3.Validate() == nil {
		s3, p, err := buildS3(cfg.S3)
		if err != nil {
			return nil, err
		}
		st.set.S3 = s3
		if cfg.Storage == config.StorageS3 {
			probeStore = p
		}
	} else if cfg.Storage == config.StorageS3 {
		return nil, fmt.Errorf("S3 artifact storage is not configured:\n%w", cfg.S3.Validate())
	} else if r.opts.Pool != nil {
		if row, err := loadStored(ctx, r.opts.Pool, false); err == nil && row != nil && row.Value.S3 != nil {
			if s3cfg, err := row.s3Config(cfg.MasterKey); err == nil {
				if s3, _, err := buildS3(s3cfg); err == nil {
					st.set.S3 = s3
				}
			}
		}
	}
	if probe {
		if err := r.probe(ctx, probeStore); err != nil {
			return nil, fmt.Errorf("artifact storage check failed (QATLAS_STORAGE=%s): %w", cfg.Storage, err)
		}
	}
	return st, nil
}

// loadDB builds the configuration from the database settings. It never fails:
// problems become the state's warning (and local fallback for writes). prev
// (may be nil) is kept when the settings cannot be read at all.
func (r *Registry) loadDB(ctx context.Context, prev *state) *state {
	row, err := loadStored(ctx, r.opts.Pool, false)
	if err != nil {
		if prev != nil {
			r.log.Warn("could not reload the storage settings; keeping the current ones", "err", err)
			return prev
		}
		st := &state{source: SourceDefault, set: artifacts.StoreSet{Active: config.StorageLocal, Local: r.local}}
		if isUndefinedTable(err) {
			st.warning = "The storage settings table is missing; run `qatlas migrate up`. Artifacts are stored locally."
		} else {
			st.warning = "Could not read the storage settings (" + err.Error() + "). Artifacts are stored locally."
		}
		return st
	}
	return r.stateFromRow(ctx, row)
}

// stateFromRow builds (and probes, when S3 is selected) the stores of row.
func (r *Registry) stateFromRow(ctx context.Context, row *stored) *state {
	st := &state{source: SourceDefault, set: artifacts.StoreSet{Active: config.StorageLocal, Local: r.local}}
	if row == nil {
		return st
	}
	st.source, st.version = SourceDatabase, row.UpdatedAt
	var probeStore artifacts.Store
	if row.Value.S3 != nil {
		s3cfg, err := row.s3Config(r.opts.Config.MasterKey)
		var s3, p *artifacts.S3Store
		if err == nil {
			s3, p, err = buildS3(s3cfg)
		}
		if err != nil {
			st.warning = "The stored S3 settings cannot be used: " + err.Error() + "."
		} else {
			st.set.S3, probeStore = s3, p
		}
	}
	if row.Value.Backend != config.StorageS3 {
		return st
	}
	if st.set.S3 == nil {
		st.warning += " S3 storage is selected, so new artifacts are stored locally until the S3 settings are fixed in Admin → Storage."
		return st
	}
	if err := r.probe(ctx, probeStore); err != nil {
		st.retry = true
		st.warning = "S3 storage is selected but failed its connection check (" + err.Error() +
			"). New artifacts are stored locally until it works again; QAtlas re-checks every " +
			r.opts.RetryInterval.String() + "."
		return st
	}
	st.set.Active = config.StorageS3
	return st
}

// Reload re-reads the settings when they changed (or S3 is in fallback) and
// swaps the stores. Environment-configured registries only refresh their S3
// reader. Safe for concurrent use.
func (r *Registry) Reload(ctx context.Context) error {
	if r.static {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	cur := r.cur.Load()
	if cur.source == SourceEnv {
		st, err := r.loadEnv(ctx, false)
		if err != nil {
			return err
		}
		st.set.Active = cur.set.Active
		r.cur.Store(st)
		return nil
	}
	version, exists, err := storedVersion(ctx, r.opts.Pool)
	if err != nil {
		if isUndefinedTable(err) {
			return nil
		}
		return err
	}
	if !cur.retry && exists == (cur.source == SourceDatabase) && version.Equal(cur.version) {
		return nil // unchanged (e.g. our own update, already installed)
	}
	st := r.loadDB(ctx, cur)
	if st == cur {
		return nil
	}
	r.cur.Store(st)
	if cur.retry && st.retry && st.version.Equal(cur.version) {
		return nil // still unreachable: logged when it started
	}
	r.logState(st, "artifact storage reloaded")
	return nil
}

// install activates stores that were built and probed by an update (PUT) in
// this process, without probing again.
func (r *Registry) install(st *state) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if cur := r.cur.Load(); cur.version.After(st.version) {
		return // a newer configuration is already active
	}
	r.cur.Store(st)
	r.logState(st, "artifact storage switched")
}

// Start runs the LISTEN loop and the S3 retry loop until Close. No-op for
// static registries; safe to call more than once.
func (r *Registry) Start() {
	if r.static {
		return
	}
	r.lifeMu.Lock()
	defer r.lifeMu.Unlock()
	if r.cancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	r.done = make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); r.listen(ctx) }()
	go func() { defer wg.Done(); r.retryLoop(ctx) }()
	go func() { wg.Wait(); close(r.done) }()
}

// Close stops Start's goroutines and waits for them.
func (r *Registry) Close() {
	r.lifeMu.Lock()
	cancel, done := r.cancel, r.done
	r.lifeMu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
}

func (r *Registry) retryLoop(ctx context.Context) {
	t := time.NewTicker(r.opts.RetryInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if r.cur.Load().retry {
				if err := r.Reload(ctx); err != nil && ctx.Err() == nil {
					r.log.Warn("storage settings re-check failed", "err", err)
				}
			}
		}
	}
}

func (r *Registry) listen(ctx context.Context) {
	const minBackoff, maxBackoff = 500 * time.Millisecond, 30 * time.Second
	backoff := minBackoff
	for ctx.Err() == nil {
		err := r.listenOnce(ctx, func() { backoff = minBackoff })
		if ctx.Err() != nil {
			return
		}
		r.log.Warn("storage settings listener disconnected, reconnecting", "err", err, "backoff", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

func (r *Registry) listenOnce(ctx context.Context, onListening func()) error {
	cfg := r.opts.Pool.Config().ConnConfig.Copy()
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = map[string]string{}
	}
	cfg.RuntimeParams["application_name"] = "qatlas-settings"
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, "LISTEN "+pgx.Identifier{Channel}.Sanitize()); err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	onListening()
	// Changes made while we were not listening (startup, reconnect).
	if err := r.Reload(ctx); err != nil && ctx.Err() == nil {
		r.log.Warn("storage settings reload failed", "err", err)
	}
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		if n.Payload != PayloadStorage {
			continue
		}
		if err := r.Reload(ctx); err != nil && ctx.Err() == nil {
			r.log.Warn("storage settings reload failed", "err", err)
		}
	}
}
