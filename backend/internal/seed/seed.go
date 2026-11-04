// Package seed implements `qatlas seed demo`: it loads the demo data set
// (demo.json, exported from the web mock seed web/src/mocks/seed.ts) through
// the real services, so keys, revisions, validation, audit entries and
// encrypted secrets are exactly what the API would have produced.
//
// Regenerate demo.json after changing the mock seed (from the repository root):
//
//	node scripts/export-demo-seed.mjs > backend/internal/seed/demo.json
//
// Values that differ between mock and real mode (SHOP staging BASE_URL,
// API_URL, MAILPIT_URL and every secret value) are set here from Options.
//
// The seed is idempotent per project: a project whose key already exists is
// skipped (Options.Reset deletes the demo projects first). Users are created
// when missing; existing users are left untouched.
package seed

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/environments"
	"github.com/kalfian/qatlas/backend/internal/flows"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/jobs"
	"github.com/kalfian/qatlas/backend/internal/projects"
	"github.com/kalfian/qatlas/backend/internal/runs"
	"github.com/kalfian/qatlas/backend/internal/testcases"
	"github.com/kalfian/qatlas/backend/internal/users"
)

//go:embed demo.json
var demoJSON []byte

// Defaults of the `qatlas seed demo` flags.
const (
	DefaultPassword   = "password123"
	DefaultTargetURL  = "http://localhost:8099"
	DefaultQAPassword = "Qa-Staging-2026!" // demo-target's DEMO_QA_PASSWORD default
	// DefaultMailpitURL is the Mailpit web/API address (scripts/demo-server.sh runs it there).
	DefaultMailpitURL = "http://localhost:8025"
	// DefaultQATOTPSeed is demo-target's DEMO_TOTP_SEED default: a public,
	// demo-only base32 seed of qa.2fa@tokoku.id. It protects nothing.
	DefaultQATOTPSeed = "TOKOKU2FADEMOSEEDQATLASTOTPDEMOA"
)

// Options configures Demo.
type Options struct {
	// Password of the active demo users (invited users stay invited).
	Password string
	// TargetURL is the demo-target base URL: SHOP "staging" gets
	// BASE_URL=<TargetURL> and API_URL=<TargetURL>/api.
	TargetURL string
	// QAPassword is the value of every QA_PASSWORD secret.
	QAPassword string
	// MailpitURL is SHOP staging's MAILPIT_URL (the Mailpit API the
	// sign-up test cases read the verification email from).
	MailpitURL string
	// QATOTPSeed is the value of the QA_TOTP_SEED secret (demo-target
	// DEMO_TOTP_SEED, used by {{fn.totp secret.QA_TOTP_SEED}}).
	QATOTPSeed string
	// AdminToken is the value of ADMIN_TOKEN secrets; empty = random.
	AdminToken string
	// Reset deletes the demo projects (with their runs) before seeding.
	Reset bool
	// Runs enqueues a few demo runs after seeding (executed by a worker).
	// Requires Enqueuer.
	Runs     bool
	Enqueuer jobs.Enqueuer
	// Stores keep run attachments (only needed with Runs); nil = local store
	// under QATLAS_DATA_DIR/artifacts.
	Stores artifacts.Stores
	// Out receives the progress report (nil = io.Discard).
	Out io.Writer
}

/* ------------------------------------------------------------------ fixture */

type fixture struct {
	Users    []fixtureUser    `json:"users"`
	Projects []fixtureProject `json:"projects"`
}

type fixtureUser struct {
	Email      string `json:"email"`
	Name       string `json:"name"`
	SystemRole string `json:"system_role"`
	Status     string `json:"status"`
}

type fixtureProject struct {
	Key          string          `json:"key"`
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Members      []fixtureMember `json:"members"`
	Environments []fixtureEnv    `json:"environments"`
	Folders      []string        `json:"folders"`
	TestCases    []fixtureCase   `json:"test_cases"`
	Flows        []fixtureFlow   `json:"flows"`
}

type fixtureMember struct {
	Email string     `json:"email"`
	Role  authz.Role `json:"role"`
}

type fixtureEnv struct {
	Name      string            `json:"name"`
	IsDefault bool              `json:"is_default"`
	Variables map[string]string `json:"variables"`
	Secrets   []string          `json:"secrets"`
}

type fixtureCase struct {
	Key           string            `json:"key"`
	Folder        *string           `json:"folder"`
	Title         string            `json:"title"`
	Description   string            `json:"description"`
	Preconditions string            `json:"preconditions"`
	Priority      string            `json:"priority"`
	Status        string            `json:"status"`
	Execution     string            `json:"execution"`
	Tags          []string          `json:"tags"`
	Variables     map[string]string `json:"variables"`
	Steps         []json.RawMessage `json:"steps"`
}

type fixtureFlow struct {
	Key           string            `json:"key"`
	Name          string            `json:"name"`
	Description   string            `json:"description"`
	Tags          []string          `json:"tags"`
	SharedSession bool              `json:"shared_session"`
	StopOnFailure bool              `json:"stop_on_failure"`
	Variables     map[string]string `json:"variables"`
	Items         []struct {
		TestCase          string `json:"test_case"`
		ContinueOnFailure bool   `json:"continue_on_failure"`
	} `json:"items"`
}

func loadFixture() (fixture, error) {
	var f fixture
	if err := json.Unmarshal(demoJSON, &f); err != nil {
		return f, fmt.Errorf("seed: parse demo.json: %w", err)
	}
	return f, nil
}

// ProjectKeys returns the keys of the demo projects.
func ProjectKeys() ([]string, error) {
	f, err := loadFixture()
	if err != nil {
		return nil, err
	}
	keys := make([]string, len(f.Projects))
	for i, p := range f.Projects {
		keys[i] = p.Key
	}
	return keys, nil
}

/* ------------------------------------------------------------------ seeding */

type seeder struct {
	pool   *pgxpool.Pool
	cfg    *config.Config
	opts   Options
	out    io.Writer
	actor  *auth.Actor
	userID map[string]string // email → id

	users    *users.Service
	projects *projects.Service
	envs     *environments.Service
	cases    *testcases.Service
	flows    *flows.Service
	runs     *runs.Service

	adminToken string
	created    []string // project keys created by this invocation
}

// Demo seeds the demo data set. It needs QATLAS_MASTER_KEY (secrets).
func Demo(ctx context.Context, pool *pgxpool.Pool, cfg *config.Config, logger *slog.Logger, opts Options) error {
	if err := cfg.RequireMasterKey(); err != nil {
		return err
	}
	if opts.Password == "" {
		opts.Password = DefaultPassword
	}
	if len(opts.Password) < auth.MinPasswordLength {
		return fmt.Errorf("--password must be at least %d characters", auth.MinPasswordLength)
	}
	if opts.TargetURL == "" {
		opts.TargetURL = DefaultTargetURL
	}
	opts.TargetURL = strings.TrimRight(opts.TargetURL, "/")
	if opts.QAPassword == "" {
		opts.QAPassword = DefaultQAPassword
	}
	if opts.MailpitURL == "" {
		opts.MailpitURL = DefaultMailpitURL
	}
	opts.MailpitURL = strings.TrimRight(opts.MailpitURL, "/")
	if opts.QATOTPSeed == "" {
		opts.QATOTPSeed = DefaultQATOTPSeed
	}
	if opts.Runs && opts.Enqueuer == nil {
		return errors.New("seed: --runs needs a job enqueuer")
	}
	if logger == nil {
		logger = slog.Default()
	}
	out := opts.Out
	if out == nil {
		out = io.Discard
	}
	f, err := loadFixture()
	if err != nil {
		return err
	}

	authSvc := auth.New(pool, cfg, logger)
	s := &seeder{
		pool: pool, cfg: cfg, opts: opts, out: out, userID: map[string]string{},
		users:    users.New(pool, authSvc),
		projects: projects.New(pool),
		envs:     environments.New(pool, cfg.MasterKey),
		cases:    testcases.New(pool),
		flows:    flows.New(pool),
	}
	s.adminToken = opts.AdminToken
	if s.adminToken == "" {
		s.adminToken = "adm_" + randomHex(12)
	}
	if opts.Runs {
		stores := opts.Stores
		if stores == nil {
			ls, err := artifacts.NewLocalStore(filepath.Join(cfg.DataDir, "artifacts"))
			if err != nil {
				return err
			}
			stores = artifacts.Single(ls)
		}
		s.runs = runs.New(pool, opts.Enqueuer, stores, nil, logger)
	}

	if err := s.seedUsers(ctx, f.Users); err != nil {
		return err
	}
	if opts.Reset {
		if err := s.reset(ctx, f.Projects); err != nil {
			return err
		}
	}
	for _, p := range f.Projects {
		if err := s.seedProject(ctx, p); err != nil {
			return fmt.Errorf("seed project %s: %w", p.Key, err)
		}
	}
	if opts.Runs {
		if err := s.enqueueRuns(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (s *seeder) printf(format string, args ...any) { fmt.Fprintf(s.out, format, args...) }

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	return hex.EncodeToString(b)
}

// seedUsers creates missing users. The first admin of the fixture becomes the
// actor of every following service call. Active users are inserted with
// Options.Password (like `qatlas user create-admin`); invited users go
// through the admin "create user" service and get an invite link.
func (s *seeder) seedUsers(ctx context.Context, list []fixtureUser) error {
	ordered := append([]fixtureUser(nil), list...)
	// Admins first: the actor must exist before invites are issued.
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].SystemRole == auth.SystemRoleAdmin && ordered[j].SystemRole != auth.SystemRoleAdmin
	})
	for _, fu := range ordered {
		email := strings.ToLower(fu.Email)
		u, err := auth.ScanUser(s.pool.QueryRow(ctx, `SELECT `+auth.UserColumns+` FROM users u WHERE u.email = $1`, email))
		switch {
		case err == nil:
			s.printf("user %-22s exists (%s, %s), left unchanged\n", email, u.SystemRole, u.Status)
		case !db.IsNoRows(err):
			return err
		case fu.Status == auth.StatusInvited:
			if s.actor == nil {
				return errors.New("seed: the fixture needs an active admin before invited users")
			}
			inv, err := s.users.CreateUser(ctx, s.actor, users.CreateUserInput{Email: email, Name: fu.Name, SystemRole: fu.SystemRole})
			if err != nil {
				return fmt.Errorf("create invited user %s: %w", email, err)
			}
			s.printf("user %-22s invited (%s) — invite link: %s\n", email, fu.SystemRole, inv.InviteURL)
			u, err = auth.LoadUser(ctx, s.pool, inv.User.ID)
			if err != nil {
				return err
			}
		default:
			if u, err = s.insertActiveUser(ctx, email, fu); err != nil {
				return fmt.Errorf("create user %s: %w", email, err)
			}
			s.printf("user %-22s created (%s), password from --password\n", email, fu.SystemRole)
		}
		s.userID[email] = u.ID.String()
		if s.actor == nil && u.IsAdmin() && u.Status == auth.StatusActive {
			s.actor = &auth.Actor{User: u}
		}
	}
	if s.actor == nil {
		return errors.New("seed: no active admin user (the fixture's admin exists but is not an active admin)")
	}
	return nil
}

func (s *seeder) insertActiveUser(ctx context.Context, email string, fu fixtureUser) (auth.User, error) {
	hash, err := auth.HashPassword(s.opts.Password)
	if err != nil {
		return auth.User{}, err
	}
	var u auth.User
	err = db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		u, err = auth.ScanUser(tx.QueryRow(ctx, `
			INSERT INTO users AS u (id, email, name, password_hash, system_role, status)
			VALUES ($1, $2, $3, $4, $5, 'active')
			RETURNING `+auth.UserColumns, db.NewID(), email, fu.Name, hash, fu.SystemRole))
		if err != nil {
			return err
		}
		var actor audit.Principal
		if s.actor != nil {
			actor = s.actor
		}
		return audit.Record(ctx, tx, actor, audit.ActionUserCreate, "user", u.ID.String(), nil,
			audit.Meta{"via": "seed", "email": email, "system_role": fu.SystemRole})
	})
	return u, err
}

// reset deletes the demo projects. Every project-scoped row (members,
// environments, test cases, flows, runs, artifact rows) cascades; artifact
// files of deleted runs stay on disk.
func (s *seeder) reset(ctx context.Context, list []fixtureProject) error {
	keys := make([]string, len(list))
	for i, p := range list {
		keys[i] = p.Key
	}
	return db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		// Children first: flow_items/runs/run_cases reference test cases and
		// folders reference their parent without ON DELETE CASCADE, so a single
		// cascading DELETE FROM projects would trip those foreign keys.
		for _, stmt := range []string{
			`DELETE FROM runs WHERE project_id IN (SELECT id FROM projects WHERE key = ANY($1))`,
			`DELETE FROM flows WHERE project_id IN (SELECT id FROM projects WHERE key = ANY($1))`,
			`DELETE FROM test_cases WHERE project_id IN (SELECT id FROM projects WHERE key = ANY($1))`,
			`UPDATE folders SET parent_id = NULL WHERE project_id IN (SELECT id FROM projects WHERE key = ANY($1))`,
			`DELETE FROM folders WHERE project_id IN (SELECT id FROM projects WHERE key = ANY($1))`,
		} {
			if _, err := tx.Exec(ctx, stmt, keys); err != nil {
				return err
			}
		}
		rows, err := tx.Query(ctx, `DELETE FROM projects WHERE key = ANY($1) RETURNING key`, keys)
		if err != nil {
			return err
		}
		deleted, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		for _, k := range deleted {
			s.printf("project %s deleted (--reset)\n", k)
			if err := audit.Record(ctx, tx, s.actor, "project.delete", "project", k, nil, audit.Meta{"via": "seed --reset"}); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *seeder) projectExists(ctx context.Context, key string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM projects WHERE key = $1)`, key).Scan(&exists)
	return exists, err
}

func (s *seeder) seedProject(ctx context.Context, fp fixtureProject) error {
	exists, err := s.projectExists(ctx, fp.Key)
	if err != nil {
		return err
	}
	if exists {
		s.printf("project %s exists, skipped (use --reset to recreate it)\n", fp.Key)
		return nil
	}
	desc := fp.Description
	p, err := s.projects.Create(ctx, s.actor, projects.CreateInput{Key: fp.Key, Name: fp.Name, Description: &desc})
	if err != nil {
		return err
	}
	if err := s.seedMembers(ctx, fp); err != nil {
		return err
	}
	if err := s.seedEnvironments(ctx, fp); err != nil {
		return err
	}
	folders, err := s.seedFolders(ctx, fp)
	if err != nil {
		return err
	}
	caseIDs, err := s.seedTestCases(ctx, fp, folders)
	if err != nil {
		return err
	}
	if err := s.seedFlows(ctx, fp, caseIDs); err != nil {
		return err
	}
	s.created = append(s.created, p.Key)
	s.printf("project %s created: %d members, %d environments, %d folders, %d test cases, %d flows\n",
		p.Key, len(fp.Members), len(fp.Environments), len(fp.Folders), len(fp.TestCases), len(fp.Flows))
	return nil
}

// seedMembers adds the fixture members. The creator (the admin actor) became
// maintainer on create; it is removed again when the fixture does not list it
// (admins keep maintainer access without a membership).
func (s *seeder) seedMembers(ctx context.Context, fp fixtureProject) error {
	actorListed := false
	for _, m := range fp.Members {
		id, ok := s.userID[strings.ToLower(m.Email)]
		if !ok {
			return fmt.Errorf("member %s is not a fixture user", m.Email)
		}
		if id == s.actor.User.ID.String() {
			actorListed = true
			if m.Role != authz.RoleMaintainer {
				if _, err := s.projects.UpdateMember(ctx, s.actor, fp.Key, id, projects.UpdateMemberInput{Role: m.Role}); err != nil {
					return err
				}
			}
			continue
		}
		if _, err := s.projects.AddMember(ctx, s.actor, fp.Key, projects.AddMemberInput{UserID: id, Role: m.Role}); err != nil {
			return fmt.Errorf("add member %s: %w", m.Email, err)
		}
	}
	if !actorListed {
		if err := s.projects.RemoveMember(ctx, s.actor, fp.Key, s.actor.User.ID.String()); err != nil {
			return fmt.Errorf("remove creator membership: %w", err)
		}
	}
	return nil
}

// seedEnvironments turns the environment created with the project into the
// fixture's first environment and creates the others, then sets secrets.
func (s *seeder) seedEnvironments(ctx context.Context, fp fixtureProject) error {
	existing, err := s.envs.List(ctx, s.actor, fp.Key)
	if err != nil {
		return err
	}
	for i, fe := range fp.Environments {
		vars := map[string]string{}
		for k, v := range fe.Variables {
			vars[k] = v
		}
		if fp.Key == "SHOP" && fe.Name == "staging" {
			vars["BASE_URL"] = s.opts.TargetURL
			vars["API_URL"] = s.opts.TargetURL + "/api"
			vars["MAILPIT_URL"] = s.opts.MailpitURL
		}
		name, isDefault := fe.Name, fe.IsDefault
		in := environments.Input{Name: &name, IsDefault: &isDefault, Variables: vars}
		var env environments.Environment
		if i == 0 && len(existing) > 0 {
			env, err = s.envs.Update(ctx, s.actor, fp.Key, existing[0].ID.String(), in)
		} else {
			env, err = s.envs.Create(ctx, s.actor, fp.Key, in)
		}
		if err != nil {
			return fmt.Errorf("environment %s: %w", fe.Name, err)
		}
		for _, secret := range fe.Secrets {
			if _, err := s.envs.SetSecret(ctx, s.actor, fp.Key, env.ID.String(), secret, s.secretValue(secret)); err != nil {
				return fmt.Errorf("secret %s/%s: %w", fe.Name, secret, err)
			}
		}
	}
	return nil
}

func (s *seeder) secretValue(name string) string {
	switch name {
	case "QA_PASSWORD":
		return s.opts.QAPassword
	case "ADMIN_TOKEN":
		return s.adminToken
	case "QA_TOTP_SEED":
		return s.opts.QATOTPSeed
	case "API_KEY":
		return "sk_sandbox_" + randomHex(16)
	default:
		return randomHex(16)
	}
}

// seedFolders creates the folder paths ("Checkout/Payment" = Payment inside
// Checkout), parents first; it returns path → folder id.
func (s *seeder) seedFolders(ctx context.Context, fp fixtureProject) (map[string]string, error) {
	ids := map[string]string{}
	var ensure func(path string) (string, error)
	ensure = func(path string) (string, error) {
		if id, ok := ids[path]; ok {
			return id, nil
		}
		in := testcases.FolderInput{Name: path}
		if i := strings.LastIndex(path, "/"); i >= 0 {
			parent, err := ensure(path[:i])
			if err != nil {
				return "", err
			}
			in = testcases.FolderInput{Name: path[i+1:], ParentID: &parent}
		}
		f, err := s.cases.CreateFolder(ctx, s.actor, fp.Key, in)
		if err != nil {
			return "", fmt.Errorf("folder %s: %w", path, err)
		}
		ids[path] = f.ID.String()
		return ids[path], nil
	}
	for _, path := range fp.Folders {
		if _, err := ensure(path); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

// seedTestCases creates the cases in fixture order (so keys match the
// fixture's); it returns fixture key → test case id.
func (s *seeder) seedTestCases(ctx context.Context, fp fixtureProject, folders map[string]string) (map[string]string, error) {
	ids := map[string]string{}
	for _, fc := range fp.TestCases {
		in := testcases.Input{
			Title: &fc.Title, Description: &fc.Description, Preconditions: &fc.Preconditions,
			Priority: &fc.Priority, Status: &fc.Status, Execution: &fc.Execution,
		}
		tags := fc.Tags
		if tags == nil {
			tags = []string{}
		}
		in.Tags = &tags
		vars := fc.Variables
		if vars == nil {
			vars = map[string]string{}
		}
		in.Variables = &vars
		steps := fc.Steps
		if steps == nil {
			steps = []json.RawMessage{}
		}
		in.Steps = &steps
		if fc.Folder != nil {
			id, ok := folders[*fc.Folder]
			if !ok {
				return nil, fmt.Errorf("test case %s: unknown folder %q", fc.Key, *fc.Folder)
			}
			in.FolderID = httpx.Optional[string]{Set: true, Value: id}
		}
		tc, err := s.cases.Create(ctx, s.actor, fp.Key, in)
		if err != nil {
			return nil, fmt.Errorf("test case %s: %w", fc.Key, describe(err))
		}
		if tc.Key != fc.Key {
			s.printf("  note: %s was created as %s\n", fc.Key, tc.Key)
		}
		ids[fc.Key] = tc.ID.String()
	}
	return ids, nil
}

func (s *seeder) seedFlows(ctx context.Context, fp fixtureProject, caseIDs map[string]string) error {
	for _, ff := range fp.Flows {
		items := make([]flows.ItemInput, len(ff.Items))
		for i, it := range ff.Items {
			id, ok := caseIDs[it.TestCase]
			if !ok {
				return fmt.Errorf("flow %s: unknown test case %s", ff.Key, it.TestCase)
			}
			items[i] = flows.ItemInput{TestCaseID: id, ContinueOnFailure: it.ContinueOnFailure}
		}
		tags := ff.Tags
		if tags == nil {
			tags = []string{}
		}
		vars := ff.Variables
		if vars == nil {
			vars = map[string]string{}
		}
		in := flows.Input{
			Name: &ff.Name, Description: &ff.Description, Tags: &tags,
			SharedSession: &ff.SharedSession, StopOnFailure: &ff.StopOnFailure, Variables: &vars, Items: items,
		}
		fl, err := s.flows.Create(ctx, s.actor, fp.Key, in)
		if err != nil {
			return fmt.Errorf("flow %s: %w", ff.Key, describe(err))
		}
		if fl.Key != ff.Key {
			s.printf("  note: %s was created as %s\n", ff.Key, fl.Key)
		}
	}
	return nil
}

// demoRuns are enqueued by --runs (only for projects created in this call):
// a passing smoke flow, the voucher case that fails on demo-target's
// intentional bug, and the mixed flow that stops at its manual case
// (assigned to the seeding admin).
var demoRuns = []struct {
	project, testCase, flow string
}{
	{project: "SHOP", flow: "SHOP-F2"},
	{project: "SHOP", testCase: "SHOP-T12"},
	{project: "SHOP", flow: "SHOP-F3"},
}

func (s *seeder) enqueueRuns(ctx context.Context) error {
	for _, r := range demoRuns {
		if !slices.Contains(s.created, r.project) {
			continue
		}
		run, err := s.runs.Create(ctx, s.actor, r.project, runs.CreateInput{TestCase: r.testCase, Flow: r.flow})
		if err != nil {
			return fmt.Errorf("enqueue run of %s%s: %w", r.testCase, r.flow, describe(err))
		}
		s.printf("run %s queued (%s%s) — executed by a running `qatlas worker`/`qatlas all`\n", run.Key, r.testCase, r.flow)
	}
	return nil
}

// describe appends API error details (field paths) to the message.
func describe(err error) error {
	var apiErr *httpx.APIError
	if !errors.As(err, &apiErr) || len(apiErr.Details) == 0 {
		return err
	}
	parts := make([]string, len(apiErr.Details))
	for i, d := range apiErr.Details {
		parts[i] = d.Path + ": " + d.Message
	}
	return fmt.Errorf("%w (%s)", err, strings.Join(parts, "; "))
}
