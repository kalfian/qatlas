package server

import (
	"bytes"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/environments"
	"github.com/kalfian/qatlas/backend/internal/secrets"
)

type envList struct {
	Data []environments.Environment `json:"data"`
}

func TestEnvironmentsCRUDAndPermissions(t *testing.T) {
	e := newEnv(t)
	mara := e.createUser("mara@x.io", "Mara", "member", "active", testPassword)
	eddy := e.createUser("eddy@x.io", "Eddy", "member", "active", testPassword)
	vic := e.createUser("vic@x.io", "Vic", "member", "active", testPassword)
	shop := e.createProject("SHOP", "Shop", false)
	e.addMember(shop, mara, "maintainer")
	e.addMember(shop, eddy, "editor")
	e.addMember(shop, vic, "viewer")
	m, ed, v := e.browser(), e.browser(), e.browser()
	m.login("mara@x.io", testPassword)
	ed.login("eddy@x.io", testPassword)
	v.login("vic@x.io", testPassword)

	base := "/api/v1/projects/SHOP/environments"
	var list envList
	v.expect("GET", base, nil, 200, &list)
	if len(list.Data) != 0 {
		t.Fatal("fixture project has no environments")
	}
	v.expect("POST", base, map[string]any{"name": "qa"}, 403, nil)
	ed.expect("POST", base, map[string]any{"name": "qa"}, 403, nil)

	var staging, prod environments.Environment
	m.expect("POST", base, map[string]any{"name": " staging ", "variables": map[string]string{"BASE_URL": "https://s.example"}}, 201, &staging)
	if staging.Name != "staging" || !staging.IsDefault || staging.Variables["BASE_URL"] != "https://s.example" || staging.Secrets == nil {
		t.Fatalf("first env must be default: %+v", staging)
	}
	m.expect("POST", base, map[string]any{"name": "prod"}, 201, &prod)
	if prod.IsDefault || prod.Variables == nil {
		t.Fatalf("second env: %+v", prod)
	}
	if r := m.expect("POST", base, map[string]any{"name": "staging"}, 409, nil); r.errCode(t) != "conflict" {
		t.Fatal("duplicate env name must be 409")
	}
	m.expect("POST", base, map[string]any{"name": "  "}, 400, nil)
	r := m.expect("POST", base, map[string]any{"name": "qa", "variables": map[string]string{"bad-key": "x", "9x": "y", "ok_1": "z"}}, 400, nil)
	var body apiErr
	r.decode(t, &body)
	if body.Error.Message != "Invalid variable names: 9x, bad-key" || len(body.Error.Details) != 2 || body.Error.Details[0].Path != "variables.9x" {
		t.Fatalf("variable keys: %s", r.body)
	}

	// Viewer/editor cannot mutate.
	for _, c := range []*client{v, ed} {
		c.expect("PATCH", base+"/"+prod.ID.String(), map[string]any{"name": "x"}, 403, nil)
		c.expect("DELETE", base+"/"+prod.ID.String(), nil, 403, nil)
		c.expect("PUT", base+"/"+prod.ID.String()+"/secrets/TOKEN", map[string]string{"value": "v"}, 403, nil)
		c.expect("DELETE", base+"/"+prod.ID.String()+"/secrets/TOKEN", nil, 403, nil)
	}

	// Default switching, rename rules.
	var got environments.Environment
	m.expect("PATCH", base+"/"+prod.ID.String(), map[string]any{"is_default": true, "variables": map[string]string{"BASE_URL": "https://p.example"}}, 200, &got)
	if !got.IsDefault || got.Variables["BASE_URL"] != "https://p.example" {
		t.Fatalf("patch prod: %+v", got)
	}
	v.expect("GET", base, nil, 200, &list)
	if len(list.Data) != 2 || list.Data[0].Name != "staging" || list.Data[0].IsDefault || !list.Data[1].IsDefault {
		t.Fatalf("exactly one default: %+v", list.Data)
	}
	m.expect("PATCH", base+"/"+prod.ID.String(), map[string]any{"name": "staging"}, 409, nil)
	m.expect("PATCH", base+"/"+prod.ID.String(), map[string]any{"name": "", "is_default": false}, 200, &got)
	if got.Name != "prod" || !got.IsDefault {
		t.Fatalf("empty name keeps name, is_default=false ignored: %+v", got)
	}
	m.expect("PATCH", base+"/"+prod.ID.String(), map[string]any{"variables": map[string]string{"a-b": "1"}}, 400, nil)
	m.expect("PATCH", base+"/"+uuid.NewString(), map[string]any{"name": "x"}, 404, nil)
	m.expect("PATCH", base+"/not-a-uuid", map[string]any{"name": "x"}, 404, nil)

	// Deleting the default promotes the remaining environment.
	m.expect("DELETE", base+"/"+prod.ID.String(), nil, 204, nil)
	m.expect("DELETE", base+"/"+prod.ID.String(), nil, 404, nil)
	v.expect("GET", base, nil, 200, &list)
	if len(list.Data) != 1 || !list.Data[0].IsDefault {
		t.Fatalf("after delete: %+v", list.Data)
	}

	// A read-only token of the maintainer can list but not mutate.
	var tok auth.CreatedToken
	m.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "ro", "scopes": []string{"read"}}, 201, &tok)
	bt := e.bearer(tok.Secret)
	bt.expect("GET", base, nil, 200, nil)
	bt.expect("POST", base, map[string]any{"name": "ci"}, 403, nil)

	if n := e.count(`SELECT count(*) FROM audit_logs WHERE project_id = $1 AND action LIKE 'environment.%'`, shop); n != 4 {
		t.Fatalf("environment audit rows: %d", n) // create×2, update×1 (no-op patch is not audited), delete×1
	}
}

func TestEnvironmentSecrets(t *testing.T) {
	e := newEnv(t)
	mara := e.createUser("mara@x.io", "Mara", "member", "active", testPassword)
	vic := e.createUser("vic@x.io", "Vic", "member", "active", testPassword)
	shop := e.createProject("SHOP", "Shop", false)
	e.addMember(shop, mara, "maintainer")
	e.addMember(shop, vic, "viewer")
	m, v := e.browser(), e.browser()
	m.login("mara@x.io", testPassword)
	v.login("vic@x.io", testPassword)

	base := "/api/v1/projects/SHOP/environments"
	var env environments.Environment
	m.expect("POST", base, map[string]any{"name": "staging"}, 201, &env)
	sec := base + "/" + env.ID.String() + "/secrets/"

	const value = "hunter2-very-secret-value"
	r := m.expect("PUT", sec+"QA_PASSWORD", map[string]string{"value": value}, 200, &env)
	if strings.Contains(string(r.body), value) {
		t.Fatal("PUT response contains the secret value")
	}
	if len(env.Secrets) != 1 || env.Secrets[0].Name != "QA_PASSWORD" || env.Secrets[0].UpdatedAt.IsZero() {
		t.Fatalf("secret meta: %+v", env.Secrets)
	}
	m.expect("PUT", sec+"API_KEY", map[string]string{"value": "k-1"}, 200, nil)
	m.expect("PUT", sec+"QA_PASSWORD", map[string]string{"value": value + "-2"}, 200, &env) // replace
	if len(env.Secrets) != 2 {
		t.Fatalf("secrets after replace: %+v", env.Secrets)
	}

	// Validation.
	for _, name := range []string{"qa_password", "_X", "1ABC", "A-B"} {
		m.expect("PUT", sec+name, map[string]string{"value": "x"}, 400, nil)
	}
	m.expect("PUT", sec+"EMPTY", map[string]string{"value": ""}, 400, nil)
	m.expect("PUT", sec+"EMPTY", nil, 400, nil)
	m.expect("PUT", base+"/"+uuid.NewString()+"/secrets/X", map[string]string{"value": "x"}, 404, nil)

	// Nothing the API returns or audits contains a value.
	for _, c := range []*client{m, v} {
		raw := c.expect("GET", base, nil, 200, nil)
		if strings.Contains(string(raw.body), "hunter2") || strings.Contains(string(raw.body), "k-1") {
			t.Fatalf("list leaks a secret: %s", raw.body)
		}
	}
	if n := e.count(`SELECT count(*) FROM audit_logs WHERE meta::text LIKE '%hunter2%' OR meta::text LIKE '%k-1%'`); n != 0 {
		t.Fatal("audit meta contains a secret value")
	}
	if n := e.count(`SELECT count(*) FROM audit_logs WHERE project_id = $1 AND action = 'secret.set'`, shop); n != 3 {
		t.Fatalf("secret.set audit rows: %d", n)
	}

	// Stored encrypted; decrypts with the master key.
	var sealed []byte
	if err := e.pool.QueryRow(e.ctx, `SELECT value_enc FROM environment_secrets WHERE environment_id = $1 AND name = 'QA_PASSWORD'`, env.ID).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("hunter2")) {
		t.Fatal("secret stored in plaintext")
	}
	pt, err := secrets.Open(testMasterKey, sealed)
	if err != nil || string(pt) != value+"-2" {
		t.Fatalf("open: %q %v", pt, err)
	}
	all, err := secrets.ForEnvironment(e.ctx, e.pool, env.ID, testMasterKey)
	if err != nil || len(all) != 2 || all["API_KEY"] != "k-1" || all["QA_PASSWORD"] != value+"-2" {
		t.Fatalf("ForEnvironment: %v %v", all, err)
	}

	// Delete (idempotent, like the mock).
	m.expect("DELETE", sec+"API_KEY", nil, 200, &env)
	if len(env.Secrets) != 1 || env.Secrets[0].Name != "QA_PASSWORD" {
		t.Fatalf("after delete: %+v", env.Secrets)
	}
	m.expect("DELETE", sec+"API_KEY", nil, 200, nil)
	if n := e.count(`SELECT count(*) FROM audit_logs WHERE project_id = $1 AND action = 'secret.delete'`, shop); n != 1 {
		t.Fatalf("secret.delete audit rows: %d", n)
	}

	// Deleting the environment removes its secrets.
	m.expect("DELETE", base+"/"+env.ID.String(), nil, 204, nil)
	if n := e.count(`SELECT count(*) FROM environment_secrets WHERE environment_id = $1`, env.ID); n != 0 {
		t.Fatal("secrets survived environment deletion")
	}
}
