// Package mcp is the QAtlas MCP server (docs/07-mcp.md): Streamable HTTP at
// /mcp, authenticated only by API tokens (Authorization: Bearer qat_…). Every
// tool runs as the token's user and calls the same service methods as the REST
// API, so RBAC (authz.ProjectAccess), the token's scopes and its project list
// apply unchanged. There are deliberately no delete tools.
//
// stdio.go adds `qatlas mcp-stdio`, a proxy for clients that only speak stdio.
package mcp

import (
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/environments"
	"github.com/kalfian/qatlas/backend/internal/flows"
	"github.com/kalfian/qatlas/backend/internal/projects"
	"github.com/kalfian/qatlas/backend/internal/runs"
	"github.com/kalfian/qatlas/backend/internal/testcases"
)

// Version is reported as serverInfo.version (override with -ldflags -X).
var Version = "dev"

// Limits that keep tool output small enough for an AI context window.
const (
	// DefaultMaxConcurrentRuns is the per-token cap on MCP-created runs that
	// are queued or running at the same time.
	DefaultMaxConcurrentRuns = 3
	// MaxWaitSeconds caps wait_for_run's timeout_s.
	MaxWaitSeconds = 120
	// MaxScreenshots is the number of images get_run_report attaches at most.
	MaxScreenshots = 5
	// MaxScreenshotBytes skips larger screenshots (they are linked instead).
	MaxScreenshotBytes = 1 << 20
)

// Deps are the services the tools call. Runs and Artifacts are shared with the
// REST API (same events hub / artifact store); the rest are stateless and
// built here when nil.
type Deps struct {
	Pool         *pgxpool.Pool
	Logger       *slog.Logger
	Auth         *auth.Service
	Runs         *runs.Service
	Artifacts    *artifacts.Service
	Projects     *projects.Service
	Environments *environments.Service
	TestCases    *testcases.Service
	Flows        *flows.Service
	// BaseURL (no trailing slash) turns artifact paths into absolute links.
	BaseURL string
	// MaxConcurrentRuns per token; 0 → DefaultMaxConcurrentRuns.
	MaxConcurrentRuns int
}

// Server is the MCP server plus its HTTP handler.
type Server struct {
	pool      *pgxpool.Pool
	log       *slog.Logger
	auth      *auth.Service
	runs      *runs.Service
	artifacts *artifacts.Service
	projects  *projects.Service
	envs      *environments.Service
	cases     *testcases.Service
	flows     *flows.Service
	baseURL   string
	maxRuns   int

	srv     *sdk.Server
	handler http.Handler

	runLocksMu sync.Mutex
	runLocks   map[uuid.UUID]*sync.Mutex // per token: serialises the concurrent-run check + create
}

// New registers every tool, resource and prompt and builds the /mcp handler.
func New(d Deps) *Server {
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	if d.Projects == nil {
		d.Projects = projects.New(d.Pool)
	}
	if d.Environments == nil {
		d.Environments = environments.New(d.Pool, nil) // read-only use: no master key needed
	}
	if d.TestCases == nil {
		d.TestCases = testcases.New(d.Pool)
	}
	if d.Flows == nil {
		d.Flows = flows.New(d.Pool)
	}
	if d.MaxConcurrentRuns <= 0 {
		d.MaxConcurrentRuns = DefaultMaxConcurrentRuns
	}
	s := &Server{
		pool: d.Pool, log: d.Logger, auth: d.Auth, runs: d.Runs, artifacts: d.Artifacts,
		projects: d.Projects, envs: d.Environments, cases: d.TestCases, flows: d.Flows,
		baseURL: d.BaseURL, maxRuns: d.MaxConcurrentRuns,
		runLocks: map[uuid.UUID]*sync.Mutex{},
	}
	s.srv = sdk.NewServer(&sdk.Implementation{Name: "qatlas", Title: "QAtlas", Version: Version}, &sdk.ServerOptions{
		Instructions: serverInstructions,
		Logger:       d.Logger,
	})
	s.registerContextTools()
	s.registerTestCaseTools()
	s.registerFlowTools()
	s.registerRunTools()
	s.registerResources()
	s.registerPrompts()

	streamable := sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return s.srv }, &sdk.StreamableHTTPOptions{
		// Stateless: every POST is self-contained (no Mcp-Session-Id), so API
		// restarts and multiple instances need no session affinity and no idle
		// sessions pile up. QAtlas never sends server→client requests.
		Stateless: true,
		Logger:    d.Logger,
		// DNS-rebinding protection rejects localhost connections whose Host is
		// not localhost — i.e. every request behind a local reverse proxy. It
		// guards cookie/ambient-auth servers; /mcp accepts only explicit Bearer
		// tokens, which a rebinding page cannot obtain.
		DisableLocalhostProtection: true,
	})
	// authenticate (ours: JSON 401, Bearer only) → SDK middleware that exposes
	// the actor to tool handlers as req.Extra.TokenInfo.
	s.handler = s.authenticate(sdkauth.RequireBearerToken(tokenInfoFromActor, &sdkauth.RequireBearerTokenOptions{
		AllowMissingExpiration: true, // expiry is enforced by auth.AuthenticateAPIToken
	})(streamable))
	return s
}

// Handler serves the Streamable HTTP endpoint (mount at /mcp).
func (s *Server) Handler() http.Handler { return s.handler }

// SDK exposes the underlying MCP server (tests, in-process transports).
func (s *Server) SDK() *sdk.Server { return s.srv }

// runLock returns the mutex serialising run creation for one token.
func (s *Server) runLock(tokenID uuid.UUID) *sync.Mutex {
	s.runLocksMu.Lock()
	defer s.runLocksMu.Unlock()
	m, ok := s.runLocks[tokenID]
	if !ok {
		m = &sync.Mutex{}
		s.runLocks[tokenID] = m
	}
	return m
}

func ptr[T any](v T) *T { return &v }

func durationMS(d time.Duration) int64 { return d.Milliseconds() }

const serverInstructions = `QAtlas is a test management and execution service. Typical loop:
1. list_projects → pick a project key (e.g. SHOP); get_project shows environments (variables and secret NAMES only) and recent runs.
2. get_step_schema once, then list_test_cases / get_test_case to copy the existing style.
3. validate_test_case until valid → create_test_case (or update_test_case with the base_revision you read).
4. run_test_case / run_flow → wait_for_run (repeat while done=false) → get_run_report(include_screenshots="failed").
5. Fix the test (update_test_case) or report an application bug, then run again.
Rules: there are no delete tools; secrets are never returned (use {{secret.NAME}} placeholders); when a run is awaiting_manual a human must execute it in the QAtlas UI — stop waiting and tell the user; never overwrite a human's edit: on revision_conflict re-read with get_test_case/get_flow first.`
