package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/db/testutil"
)

const testBaseURL = "http://qatlas.test"

// testMasterKey is QATLAS_MASTER_KEY for tests (32 bytes).
var testMasterKey = []byte("qatlas-test-master-key-32-bytes!")

type testEnv struct {
	t    *testing.T
	pool *pgxpool.Pool
	srv  *Server
	http *httptest.Server
	ctx  context.Context
}

// newEnv starts the API on a fresh database; opts may override Deps (e.g. a
// fake jobs.Enqueuer).
func newEnv(t *testing.T, opts ...func(*Deps)) *testEnv {
	t.Helper()
	pool := testutil.DB(t)
	cfg := &config.Config{HTTPAddr: ":0", BaseURL: testBaseURL, DataDir: t.TempDir(), WorkerConcurrency: 1, MasterKey: testMasterKey}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	deps := Deps{Config: cfg, Pool: pool, Logger: logger}
	for _, o := range opts {
		o(&deps)
	}
	srv, err := New(deps)
	if err != nil {
		t.Fatal(err)
	}
	hs := httptest.NewServer(srv.Handler())
	t.Cleanup(hs.Close)
	t.Cleanup(srv.Close) // runs first (LIFO): ends open SSE streams so hs.Close does not wait on them
	return &testEnv{t: t, pool: pool, srv: srv, http: hs, ctx: context.Background()}
}

// client is a browser-like client (cookie jar + CSRF header) or a Bearer client.
type client struct {
	env    *testEnv
	hc     *http.Client
	bearer string
	noCSRF bool
}

func (e *testEnv) browser() *client {
	jar, _ := cookiejar.New(nil)
	return &client{env: e, hc: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (e *testEnv) bearer(secret string) *client {
	return &client{env: e, hc: &http.Client{}, bearer: secret}
}

type response struct {
	status int
	body   []byte
	header http.Header
}

func (r response) decode(t *testing.T, out any) {
	t.Helper()
	if err := json.Unmarshal(r.body, out); err != nil {
		t.Fatalf("decode %q: %v", r.body, err)
	}
}

func (r response) errCode(t *testing.T) string {
	t.Helper()
	var e struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	r.decode(t, &e)
	return e.Error.Code
}

func (c *client) do(method, path string, body any) response {
	c.env.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			c.env.t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.env.http.URL+path, rdr)
	if err != nil {
		c.env.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if !c.noCSRF {
		req.Header.Set("X-QAtlas-CSRF", "1")
	}
	if c.bearer != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearer)
	}
	res, err := c.hc.Do(req)
	if err != nil {
		c.env.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return response{status: res.StatusCode, body: data, header: res.Header}
}

// expect performs a request, asserts the status and decodes into out (if non-nil).
func (c *client) expect(method, path string, body any, status int, out any) response {
	c.env.t.Helper()
	r := c.do(method, path, body)
	if r.status != status {
		c.env.t.Fatalf("%s %s: status %d, want %d: %s", method, path, r.status, status, r.body)
	}
	if out != nil {
		r.decode(c.env.t, out)
	}
	return r
}

func (c *client) login(email, password string) auth.Me {
	c.env.t.Helper()
	var me auth.Me
	c.expect("POST", "/api/v1/auth/login", map[string]string{"email": email, "password": password}, 200, &me)
	return me
}

// ------------------------------------------------------------------ fixtures

const testPassword = "password-123456"

func (e *testEnv) createUser(email, name, systemRole, status, password string) uuid.UUID {
	e.t.Helper()
	var hash *string
	if password != "" {
		h, err := auth.HashPassword(password)
		if err != nil {
			e.t.Fatal(err)
		}
		hash = &h
	}
	id := db.NewID()
	_, err := e.pool.Exec(e.ctx, `INSERT INTO users (id, email, name, password_hash, system_role, status) VALUES ($1,$2,$3,$4,$5,$6)`,
		id, strings.ToLower(email), name, hash, systemRole, status)
	if err != nil {
		e.t.Fatal(err)
	}
	return id
}

func (e *testEnv) createProject(key, name string, archived bool) uuid.UUID {
	e.t.Helper()
	id := db.NewID()
	_, err := e.pool.Exec(e.ctx, `INSERT INTO projects (id, key, name, archived_at) VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END)`, id, key, name, archived)
	if err != nil {
		e.t.Fatal(err)
	}
	return id
}

func (e *testEnv) addMember(projectID, userID uuid.UUID, role string) {
	e.t.Helper()
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3)`, projectID, userID, role); err != nil {
		e.t.Fatal(err)
	}
}

func (e *testEnv) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(e.ctx, sql, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

// inviteToken extracts the token from an invite_url.
func inviteToken(t *testing.T, url string) string {
	t.Helper()
	prefix := testBaseURL + "/invite/"
	if !strings.HasPrefix(url, prefix) {
		t.Fatalf("invite_url %q does not start with %q", url, prefix)
	}
	return strings.TrimPrefix(url, prefix)
}
