package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/users"
)

func TestHealthAndRouting(t *testing.T) {
	e := newEnv(t)
	c := e.browser()
	var health map[string]string
	c.expect("GET", "/healthz", nil, 200, &health)
	if health["status"] != "ok" || health["version"] != "dev" { // Deps.Version unset → "dev"
		t.Fatalf("healthz: %v", health)
	}
	c.expect("GET", "/readyz", nil, 200, nil)
	if r := c.expect("GET", "/api/v1/nope", nil, 404, nil); r.errCode(t) != "not_found" {
		t.Fatal("unknown API route must be JSON not_found")
	}
	var cfg auth.AuthConfig
	c.expect("GET", "/api/v1/auth/config", nil, 200, &cfg)
	if cfg.GoogleEnabled || cfg.Mode != "real" {
		t.Fatalf("auth config: %+v", cfg)
	}
	if r := c.expect("GET", "/api/v1/me", nil, 401, nil); r.errCode(t) != "unauthenticated" {
		t.Fatal("anonymous /me must be unauthenticated")
	}
}

func TestLoginSessionAndMe(t *testing.T) {
	e := newEnv(t)
	uid := e.createUser("Alice@Example.com", "Alice", "member", "active", testPassword)
	shop := e.createProject("SHOP", "Shop", false)
	e.createProject("PAY", "Payment", false)
	old := e.createProject("OLD", "Old", true)
	e.addMember(shop, uid, "editor")
	e.addMember(old, uid, "viewer")

	c := e.browser()
	me := c.login("  alice@EXAMPLE.com ", testPassword)
	if me.User.Email != "alice@example.com" || me.User.Status != "active" || !me.User.HasPassword || me.User.LastLoginAt == nil || me.User.Locale != "en" {
		t.Fatalf("me: %+v", me.User)
	}
	if len(me.Projects) != 1 || me.Projects[0] != (auth.MeProject{Key: "SHOP", Name: "Shop", Role: "editor"}) {
		t.Fatalf("member projects (archived excluded): %+v", me.Projects)
	}

	// Session cookie attributes.
	r := e.browser().do("POST", "/api/v1/auth/login", map[string]string{"email": "alice@example.com", "password": testPassword})
	cookie := r.header.Get("Set-Cookie")
	for _, want := range []string{"qatlas_session=", "HttpOnly", "SameSite=Lax", "Path=/"} {
		if !strings.Contains(cookie, want) {
			t.Fatalf("cookie %q missing %q", cookie, want)
		}
	}
	if strings.Contains(cookie, "Secure") {
		t.Fatal("http base URL must not set Secure")
	}

	var got auth.Me
	c.expect("GET", "/api/v1/me", nil, 200, &got)
	if got.User.ID != uid {
		t.Fatal("/me returned wrong user")
	}

	// Raw JSON shape: required nullable fields present.
	raw := c.expect("GET", "/api/v1/me", nil, 200, nil)
	var shape map[string]map[string]any
	_ = json.Unmarshal(raw.body, &shape)
	for _, k := range []string{"id", "email", "name", "system_role", "status", "locale", "has_password", "google_linked", "last_login_at", "created_at"} {
		if _, ok := shape["user"][k]; !ok {
			t.Errorf("User.%s missing", k)
		}
	}

	// Admin sees every non-archived project as maintainer unless a member.
	aid := e.createUser("root@example.com", "Root", "admin", "active", testPassword)
	e.addMember(shop, aid, "viewer")
	adminMe := e.browser().login("root@example.com", testPassword)
	roles := map[string]string{}
	for _, p := range adminMe.Projects {
		roles[p.Key] = p.Role
	}
	if len(roles) != 2 || roles["SHOP"] != "viewer" || roles["PAY"] != "maintainer" {
		t.Fatalf("admin projects: %+v", adminMe.Projects)
	}

	// PATCH /me: name, locale (unknown ignored), validation.
	var patched auth.Me
	c.expect("PATCH", "/api/v1/me", map[string]any{"name": "  Alice B ", "locale": "id"}, 200, &patched)
	if patched.User.Name != "Alice B" || patched.User.Locale != "id" {
		t.Fatalf("patch: %+v", patched.User)
	}
	c.expect("PATCH", "/api/v1/me", map[string]any{"locale": "fr"}, 200, &patched)
	if patched.User.Locale != "id" {
		t.Fatal("unknown locale must be ignored")
	}
	if r := c.expect("PATCH", "/api/v1/me", map[string]any{"name": " "}, 400, nil); r.errCode(t) != "validation_failed" {
		t.Fatal("blank name")
	}
	c.expect("PATCH", "/api/v1/me", map[string]any{"current_password": "wrong", "new_password": "another-password-1"}, 400, nil)
	c.expect("PATCH", "/api/v1/me", map[string]any{"current_password": testPassword, "new_password": "short"}, 400, nil)

	// Password change keeps this session, kills the others.
	other := e.browser()
	other.login("alice@example.com", testPassword)
	c.expect("PATCH", "/api/v1/me", map[string]any{"current_password": testPassword, "new_password": "another-password-1"}, 200, nil)
	c.expect("GET", "/api/v1/me", nil, 200, nil)
	other.expect("GET", "/api/v1/me", nil, 401, nil)
	e.browser().login("alice@example.com", "another-password-1")

	// Logout.
	c.expect("POST", "/api/v1/auth/logout", nil, 204, nil)
	c.expect("GET", "/api/v1/me", nil, 401, nil)
	c.expect("POST", "/api/v1/auth/logout", nil, 204, nil) // idempotent

	if n := e.count(`SELECT count(*) FROM audit_logs WHERE action = 'auth.login' AND actor_user_id = $1`, uid); n < 3 {
		t.Fatalf("expected login audit rows, got %d", n)
	}
}

func TestBadPasswordAndDisabledUser(t *testing.T) {
	e := newEnv(t)
	e.createUser("bob@example.com", "Bob", "member", "active", testPassword)
	e.createUser("gone@example.com", "Gone", "member", "disabled", testPassword)
	e.createUser("new@example.com", "New", "member", "invited", "")
	c := e.browser()
	for _, tc := range []struct{ email, pw string }{
		{"bob@example.com", "wrong-password"},
		{"nobody@example.com", testPassword},
		{"gone@example.com", testPassword},
		{"new@example.com", ""},
	} {
		r := c.do("POST", "/api/v1/auth/login", map[string]string{"email": tc.email, "password": tc.pw})
		if r.status != 401 || r.errCode(t) != "invalid_credentials" {
			t.Fatalf("%s: %d %s", tc.email, r.status, r.body)
		}
	}
	if n := e.count(`SELECT count(*) FROM audit_logs WHERE action = 'auth.login_failed'`); n != 4 {
		t.Fatalf("failed-login audit rows = %d", n)
	}
}

func TestLoginRateLimit(t *testing.T) {
	e := newEnv(t)
	e.createUser("carol@example.com", "Carol", "member", "active", testPassword)
	c := e.browser()
	for i := 0; i < auth.LoginMaxFailures; i++ {
		c.expect("POST", "/api/v1/auth/login", map[string]string{"email": "carol@example.com", "password": "nope-nope-nope"}, 401, nil)
	}
	r := c.do("POST", "/api/v1/auth/login", map[string]string{"email": "carol@example.com", "password": testPassword})
	if r.status != 429 || r.errCode(t) != "rate_limited" {
		t.Fatalf("expected 429 rate_limited even with the right password, got %d %s", r.status, r.body)
	}
	// Another email from the same IP is unaffected.
	e.createUser("dave@example.com", "Dave", "member", "active", testPassword)
	c.login("dave@example.com", testPassword)
	// Window passes → allowed again.
	if _, err := e.pool.Exec(e.ctx, `UPDATE login_attempts SET created_at = created_at - interval '16 minutes'`); err != nil {
		t.Fatal(err)
	}
	c.login("carol@example.com", testPassword)
}

func TestCSRF(t *testing.T) {
	e := newEnv(t)
	e.createUser("erin@example.com", "Erin", "member", "active", testPassword)
	c := e.browser()
	c.login("erin@example.com", testPassword)
	c.noCSRF = true
	c.expect("GET", "/api/v1/me", nil, 200, nil) // safe methods need no header
	if r := c.expect("PATCH", "/api/v1/me", map[string]any{"name": "X"}, 403, nil); r.errCode(t) != "forbidden" {
		t.Fatal("expected forbidden")
	}
	c.expect("POST", "/api/v1/auth/logout", nil, 403, nil)
	c.expect("POST", "/api/v1/auth/login", map[string]string{"email": "erin@example.com", "password": testPassword}, 403, nil)
	c.noCSRF = false
	c.expect("PATCH", "/api/v1/me", map[string]any{"name": "X"}, 200, nil)
}

func TestInviteAcceptFlow(t *testing.T) {
	e := newEnv(t)
	e.createUser("admin@example.com", "Admin", "admin", "active", testPassword)
	admin := e.browser()
	admin.login("admin@example.com", testPassword)

	var inv users.UserInvite
	admin.expect("POST", "/api/v1/admin/users", map[string]string{"email": " Frank@Example.com ", "name": "Frank", "system_role": "member"}, 201, &inv)
	if inv.User.Email != "frank@example.com" || inv.User.Status != "invited" || inv.User.HasPassword {
		t.Fatalf("created: %+v", inv.User)
	}
	if d := time.Until(inv.ExpiresAt); d < 71*time.Hour || d > 73*time.Hour {
		t.Fatalf("invite expiry %v", d)
	}
	token := inviteToken(t, inv.InviteURL)

	anon := e.browser()
	var info auth.InviteInfo
	anon.expect("GET", "/api/v1/auth/invites/"+token, nil, 200, &info)
	if info.Email != "frank@example.com" || info.Name != "Frank" || info.Kind != "invite" {
		t.Fatalf("info: %+v", info)
	}
	anon.expect("GET", "/api/v1/auth/invites/bogus", nil, 404, nil)
	anon.expect("POST", "/api/v1/auth/invites/bogus/accept", map[string]string{"password": "long-enough-pw"}, 410, nil)
	anon.expect("POST", "/api/v1/auth/invites/"+token+"/accept", map[string]string{"password": "short"}, 400, nil)

	var me auth.Me
	anon.expect("POST", "/api/v1/auth/invites/"+token+"/accept", map[string]string{"password": "frank-password-1"}, 200, &me)
	if me.User.Status != "active" || !me.User.HasPassword {
		t.Fatalf("accepted: %+v", me.User)
	}
	anon.expect("GET", "/api/v1/me", nil, 200, nil) // signed in by accept
	if r := anon.expect("GET", "/api/v1/auth/invites/"+token, nil, 410, nil); r.errCode(t) != "expired" {
		t.Fatal("used invite must be expired")
	}
	e.browser().login("frank@example.com", "frank-password-1")

	// Reset-password link for an active user; regenerating invalidates the previous link.
	var reset1, reset2 users.UserInvite
	admin.expect("POST", "/api/v1/admin/users/"+me.User.ID.String()+"/invite-link", nil, 200, &reset1)
	admin.expect("POST", "/api/v1/admin/users/"+me.User.ID.String()+"/invite-link", nil, 200, &reset2)
	anon.expect("GET", "/api/v1/auth/invites/"+inviteToken(t, reset1.InviteURL), nil, 410, nil)
	anon.expect("GET", "/api/v1/auth/invites/"+inviteToken(t, reset2.InviteURL), nil, 200, &info)
	if info.Kind != "reset_password" {
		t.Fatalf("kind %s", info.Kind)
	}
	resetter := e.browser()
	resetter.expect("POST", "/api/v1/auth/invites/"+inviteToken(t, reset2.InviteURL)+"/accept", map[string]string{"password": "frank-password-2"}, 200, nil)
	anon.expect("GET", "/api/v1/me", nil, 401, nil) // reset signs out other sessions
	resetter.expect("GET", "/api/v1/me", nil, 200, nil)
	e.browser().login("frank@example.com", "frank-password-2")

	// Expired link.
	var inv2 users.UserInvite
	admin.expect("POST", "/api/v1/admin/users", map[string]string{"email": "gina@example.com", "name": "Gina", "system_role": "member"}, 201, &inv2)
	if _, err := e.pool.Exec(e.ctx, `UPDATE invites SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL`); err != nil {
		t.Fatal(err)
	}
	anon.expect("GET", "/api/v1/auth/invites/"+inviteToken(t, inv2.InviteURL), nil, 410, nil)
}

func TestAdminUserManagement(t *testing.T) {
	e := newEnv(t)
	adminID := e.createUser("admin@example.com", "Zed Admin", "admin", "active", testPassword)
	e.createUser("viewer@example.com", "Viewer", "member", "active", testPassword)
	admin := e.browser()
	admin.login("admin@example.com", testPassword)

	// Validation and conflicts (mock order: email, name, duplicate).
	admin.expect("POST", "/api/v1/admin/users", map[string]string{"email": "not-an-email", "name": "X"}, 400, nil)
	admin.expect("POST", "/api/v1/admin/users", map[string]string{"email": "x@example.com", "name": " "}, 400, nil)
	admin.expect("POST", "/api/v1/admin/users", map[string]string{"email": "x@example.com", "name": "X", "system_role": "root"}, 400, nil)
	if r := admin.expect("POST", "/api/v1/admin/users", map[string]string{"email": "VIEWER@example.com", "name": "Dup"}, 409, nil); r.errCode(t) != "conflict" {
		t.Fatal("duplicate email must be conflict")
	}

	var inv users.UserInvite
	admin.expect("POST", "/api/v1/admin/users", map[string]string{"email": "hank@example.com", "name": "Hank"}, 201, &inv)
	if inv.User.SystemRole != "member" {
		t.Fatal("system_role defaults to member")
	}
	hankID := inv.User.ID.String()

	var list struct{ Data []auth.UserDTO }
	admin.expect("GET", "/api/v1/admin/users", nil, 200, &list)
	if len(list.Data) != 3 || list.Data[0].Name != "Hank" || list.Data[2].Name != "Zed Admin" {
		t.Fatalf("list sorted by name: %+v", list.Data)
	}

	// Invited → active only via invite.
	admin.expect("PATCH", "/api/v1/admin/users/"+hankID, map[string]string{"status": "active"}, 400, nil)
	// Self protection.
	admin.expect("PATCH", "/api/v1/admin/users/"+adminID.String(), map[string]string{"status": "disabled"}, 400, nil)
	admin.expect("PATCH", "/api/v1/admin/users/"+adminID.String(), map[string]string{"system_role": "member"}, 400, nil)
	admin.expect("PATCH", "/api/v1/admin/users/"+adminID.String(), map[string]string{"name": "Zed"}, 200, nil)
	admin.expect("PATCH", "/api/v1/admin/users/not-a-uuid", map[string]string{"name": "x"}, 404, nil)
	admin.expect("PATCH", "/api/v1/admin/users/"+db.NewID().String(), map[string]string{"name": "x"}, 404, nil)

	// Accept → login → promote.
	e.browser().expect("POST", "/api/v1/auth/invites/"+inviteToken(t, inv.InviteURL)+"/accept", map[string]string{"password": "hank-password-1"}, 200, nil)
	hank := e.browser()
	hank.login("hank@example.com", "hank-password-1")
	var updated auth.UserDTO
	admin.expect("PATCH", "/api/v1/admin/users/"+hankID, map[string]string{"system_role": "admin"}, 200, &updated)
	if updated.SystemRole != "admin" {
		t.Fatal("promote failed")
	}
	hank.expect("GET", "/api/v1/admin/users", nil, 200, nil)

	if n := e.count(`SELECT count(*) FROM audit_logs WHERE action IN ('user.create','user.update') AND actor_user_id = $1`, adminID); n < 3 {
		t.Fatalf("user audit rows = %d", n)
	}
}

func TestAdminEndpointsForbiddenForMembers(t *testing.T) {
	e := newEnv(t)
	uid := e.createUser("member@example.com", "Member", "member", "active", testPassword)
	p := e.createProject("SHOP", "Shop", false)
	e.addMember(p, uid, "maintainer") // even a project maintainer is not a system admin
	e.createUser("viewer@example.com", "Viewer", "member", "active", testPassword)

	for _, email := range []string{"member@example.com", "viewer@example.com"} {
		c := e.browser()
		c.login(email, testPassword)
		for _, req := range []struct{ method, path string }{
			{"GET", "/api/v1/admin/users"},
			{"POST", "/api/v1/admin/users"},
			{"PATCH", "/api/v1/admin/users/" + uid.String()},
			{"POST", "/api/v1/admin/users/" + uid.String() + "/invite-link"},
		} {
			r := c.do(req.method, req.path, map[string]string{"email": "x@example.com", "name": "X"})
			if r.status != 403 || r.errCode(t) != "forbidden" {
				t.Fatalf("%s %s %s: %d %s", email, req.method, req.path, r.status, r.body)
			}
		}
	}
	anon := e.browser()
	anon.expect("GET", "/api/v1/admin/users", nil, 401, nil)
}

func TestDisableUserRevokesAccess(t *testing.T) {
	e := newEnv(t)
	e.createUser("admin@example.com", "Admin", "admin", "active", testPassword)
	ivyID := e.createUser("ivy@example.com", "Ivy", "member", "active", testPassword)
	admin := e.browser()
	admin.login("admin@example.com", testPassword)

	ivy := e.browser()
	ivy.login("ivy@example.com", testPassword)
	var created auth.CreatedToken
	ivy.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "ci", "scopes": []string{"read"}}, 201, &created)
	e.bearer(created.Secret).expect("GET", "/api/v1/me", nil, 200, nil)

	admin.expect("PATCH", "/api/v1/admin/users/"+ivyID.String(), map[string]string{"status": "disabled"}, 200, nil)
	ivy.expect("GET", "/api/v1/me", nil, 401, nil)
	e.bearer(created.Secret).expect("GET", "/api/v1/me", nil, 401, nil)
	if r := e.browser().do("POST", "/api/v1/auth/login", map[string]string{"email": "ivy@example.com", "password": testPassword}); r.status != 401 {
		t.Fatalf("disabled login: %d", r.status)
	}
	if n := e.count(`SELECT count(*) FROM sessions WHERE user_id = $1`, ivyID); n != 0 {
		t.Fatalf("sessions left: %d", n)
	}
	if n := e.count(`SELECT count(*) FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL`, ivyID); n != 0 {
		t.Fatalf("tokens left: %d", n)
	}
	admin.expect("POST", "/api/v1/admin/users/"+ivyID.String()+"/invite-link", nil, 400, nil)

	// Re-enable: can log in again, tokens stay revoked.
	admin.expect("PATCH", "/api/v1/admin/users/"+ivyID.String(), map[string]string{"status": "active"}, 200, nil)
	ivy.login("ivy@example.com", testPassword)
	e.bearer(created.Secret).expect("GET", "/api/v1/me", nil, 401, nil)
}

func TestAPITokens(t *testing.T) {
	e := newEnv(t)
	uid := e.createUser("jo@example.com", "Jo", "member", "active", testPassword)
	shop := e.createProject("SHOP", "Shop", false)
	e.createProject("PAY", "Pay", false)
	e.addMember(shop, uid, "editor")
	c := e.browser()
	c.login("jo@example.com", testPassword)

	c.expect("POST", "/api/v1/me/tokens", map[string]any{"name": " ", "scopes": []string{"read"}}, 400, nil)
	c.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "x", "scopes": []string{}}, 400, nil)
	c.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "x", "scopes": []string{"admin"}}, 400, nil)
	c.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "x", "scopes": []string{"read"}, "expires_in_days": 0}, 400, nil)
	c.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "x", "scopes": []string{"read"}, "project_keys": []string{"PAY"}}, 400, nil)

	var created auth.CreatedToken
	c.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "CI", "scopes": []string{"run", "read", "read"}, "project_keys": []string{"shop"}, "expires_in_days": 30}, 201, &created)
	tok := created.Token
	if !strings.HasPrefix(created.Secret, tok.Prefix+"_") || len(tok.Prefix) != 12 {
		t.Fatalf("secret/prefix: %q %q", created.Secret, tok.Prefix)
	}
	if strings.Join(tok.Scopes, ",") != "read,run" || len(tok.ProjectKeys) != 1 || tok.ProjectKeys[0] != "SHOP" || tok.ExpiresAt == nil || tok.LastUsedAt != nil || tok.RevokedAt != nil {
		t.Fatalf("token: %+v", tok)
	}

	b := e.bearer(created.Secret)
	var me auth.Me
	b.expect("GET", "/api/v1/me", nil, 200, &me)
	if me.User.ID != uid {
		t.Fatal("bearer resolved wrong user")
	}
	// Bearer requests need no CSRF header but do need scopes; write is missing.
	b.noCSRF = true
	if r := b.expect("PATCH", "/api/v1/me", map[string]any{"name": "Nope"}, 403, nil); r.errCode(t) != "forbidden" {
		t.Fatal("missing write scope")
	}
	// Tokens can never manage tokens or admin endpoints.
	b.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "x", "scopes": []string{"write"}}, 403, nil)
	b.expect("DELETE", "/api/v1/me/tokens/"+tok.ID.String(), nil, 403, nil)

	var list struct{ Data []auth.APIToken }
	c.expect("GET", "/api/v1/me/tokens", nil, 200, &list)
	if len(list.Data) != 1 || list.Data[0].LastUsedAt == nil {
		t.Fatalf("last_used_at not set: %+v", list.Data)
	}
	raw := c.expect("GET", "/api/v1/me/tokens", nil, 200, nil)
	if !strings.Contains(string(raw.body), `"revoked_at":null`) || strings.Contains(string(raw.body), "token_hash") {
		t.Fatalf("token JSON: %s", raw.body)
	}

	// Unrestricted token → project_keys null.
	var open auth.CreatedToken
	c.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "all", "scopes": []string{"read", "write"}}, 201, &open)
	if open.Token.ProjectKeys != nil || open.Token.ExpiresAt != nil {
		t.Fatalf("open token: %+v", open.Token)
	}
	var patched auth.Me
	e.bearer(open.Secret).expect("PATCH", "/api/v1/me", map[string]any{"name": "Jo Token"}, 200, &patched)
	// Password changes are session-only.
	e.bearer(open.Secret).expect("PATCH", "/api/v1/me", map[string]any{"current_password": testPassword, "new_password": "new-password-123"}, 403, nil)

	// Revoke → 401; idempotent; foreign / unknown ids → 404.
	c.expect("DELETE", "/api/v1/me/tokens/"+tok.ID.String(), nil, 204, nil)
	c.expect("DELETE", "/api/v1/me/tokens/"+tok.ID.String(), nil, 204, nil)
	if r := e.bearer(created.Secret).expect("GET", "/api/v1/me", nil, 401, nil); r.errCode(t) != "unauthenticated" {
		t.Fatal("revoked token")
	}
	c.expect("DELETE", "/api/v1/me/tokens/"+db.NewID().String(), nil, 404, nil)
	c.expect("DELETE", "/api/v1/me/tokens/xyz", nil, 404, nil)
	e.createUser("other@example.com", "Other", "member", "active", testPassword)
	o := e.browser()
	o.login("other@example.com", testPassword)
	o.expect("DELETE", "/api/v1/me/tokens/"+open.Token.ID.String(), nil, 404, nil)

	// Malformed / unknown / expired tokens.
	e.bearer("qat_nope").expect("GET", "/api/v1/me", nil, 401, nil)
	e.bearer("qat_00000000_00000000000000000000000000000000").expect("GET", "/api/v1/me", nil, 401, nil)
	if _, err := e.pool.Exec(e.ctx, `UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1`, open.Token.ID); err != nil {
		t.Fatal(err)
	}
	e.bearer(open.Secret).expect("GET", "/api/v1/me", nil, 401, nil)

	if n := e.count(`SELECT count(*) FROM audit_logs WHERE action IN ('api_token.create', 'api_token.revoke')`); n < 3 {
		t.Fatalf("token audit rows = %d", n)
	}
}

func TestManualRuns(t *testing.T) {
	e := newEnv(t)
	uid := e.createUser("tess@example.com", "Tess", "member", "active", testPassword)
	shop := e.createProject("SHOP", "Shop", false)
	e.addMember(shop, uid, "editor")
	tc := db.NewID()
	runID := db.NewID()
	rc := db.NewID()
	stmts := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO test_cases (id, project_id, seq, title, execution) VALUES ($1, $2, 1, 'Manual check', 'manual')`, []any{tc, shop}},
		{`INSERT INTO runs (id, project_id, seq, kind, test_case_id, target_key, target_title, status, triggered_by, assignee_id, options, started_at, resume_position)
		  VALUES ($1, $2, 7, 'test_case', $3, 'SHOP-T1', 'Manual check', 'awaiting_manual', $4, $4, '{}', now() - interval '5 seconds', 1)`, []any{runID, shop, tc, uid}},
		{`INSERT INTO run_cases (id, run_id, position, test_case_id, test_case_key, test_case_revision, title, execution, status)
		  VALUES ($1, $2, 1, $3, 'SHOP-T1', 1, 'Manual check', 'manual', 'running')`, []any{rc, runID, tc}},
		{`INSERT INTO run_steps (id, run_case_id, position, step_id, action, status) VALUES ($1, $2, 1, 's1', 'manual', 'passed'), ($3, $2, 2, 's2', 'manual', 'pending')`, []any{db.NewID(), rc, db.NewID()}},
	}
	for _, s := range stmts {
		if _, err := e.pool.Exec(e.ctx, s.sql, s.args...); err != nil {
			t.Fatal(err)
		}
	}
	c := e.browser()
	c.login("tess@example.com", testPassword)
	raw := c.expect("GET", "/api/v1/me/manual-runs", nil, 200, nil)
	var out struct {
		Data []map[string]any `json:"data"`
	}
	raw.decode(t, &out)
	if len(out.Data) != 1 {
		t.Fatalf("manual runs: %s", raw.body)
	}
	r := out.Data[0]
	for _, k := range []string{"id", "key", "project_key", "kind", "target", "environment", "status", "trigger", "triggered_by", "assignee", "has_manual", "summary", "queued_at", "started_at", "finished_at", "duration_ms"} {
		if _, ok := r[k]; !ok {
			t.Errorf("RunSummary.%s missing", k)
		}
	}
	if r["key"] != "SHOP-R7" || r["has_manual"] != true || r["environment"] != nil || r["status"] != "awaiting_manual" {
		t.Fatalf("summary: %v", r)
	}
	steps := r["summary"].(map[string]any)["steps"].(map[string]any)
	if steps["total"].(float64) != 2 || steps["passed"].(float64) != 1 || steps["other"].(float64) != 1 {
		t.Fatalf("step counts: %v", steps)
	}
	if d, ok := r["duration_ms"].(float64); !ok || d < 4000 {
		t.Fatalf("duration_ms: %v", r["duration_ms"])
	}

	// Losing project access hides the run.
	if _, err := e.pool.Exec(e.ctx, `DELETE FROM project_members WHERE user_id = $1`, uid); err != nil {
		t.Fatal(err)
	}
	c.expect("GET", "/api/v1/me/manual-runs", nil, 200, &out)
	if len(out.Data) != 0 {
		t.Fatal("run in inaccessible project listed")
	}
}

func TestGoogleLoginRules(t *testing.T) {
	e := newEnv(t)
	invitedID := e.createUser("ken@corp.io", "Ken", "member", "invited", "")
	e.createUser("lea@corp.io", "Lea", "member", "disabled", "")
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO invites (id, user_id, kind, token_hash, expires_at) VALUES ($1, $2, 'invite', '\x01', now() + interval '1 day')`, db.NewID(), invitedID); err != nil {
		t.Fatal(err)
	}
	svc := e.srv.Auth
	login := func(id auth.GoogleIdentity) (string, *httptest.ResponseRecorder) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/v1/auth/google/callback", nil)
		return svc.CompleteGoogleLogin(e.ctx, rec, req, id), rec
	}

	if to, _ := login(auth.GoogleIdentity{Subject: "s1", Email: "ken@corp.io", EmailVerified: false}); to != "/login?error=not_registered" {
		t.Fatalf("unverified: %s", to)
	}
	if to, _ := login(auth.GoogleIdentity{Subject: "s1", Email: "stranger@corp.io", EmailVerified: true}); to != "/login?error=not_registered" {
		t.Fatalf("unknown: %s", to)
	}
	if to, _ := login(auth.GoogleIdentity{Subject: "s9", Email: "lea@corp.io", EmailVerified: true}); to != "/login?error=not_registered" {
		t.Fatalf("disabled: %s", to)
	}
	to, rec := login(auth.GoogleIdentity{Subject: "s1", Email: "KEN@corp.io", EmailVerified: true})
	if to != "/" || !strings.Contains(rec.Header().Get("Set-Cookie"), "qatlas_session=") {
		t.Fatalf("invited user: %s %v", to, rec.Header())
	}
	u, err := auth.LoadUser(e.ctx, e.pool, invitedID)
	if err != nil || u.Status != "active" || u.GoogleSub == nil || *u.GoogleSub != "s1" {
		t.Fatalf("user after google: %+v %v", u, err)
	}
	if n := e.count(`SELECT count(*) FROM invites WHERE user_id = $1 AND used_at IS NULL`, invitedID); n != 0 {
		t.Fatal("open invites must be consumed")
	}
	if to, _ := login(auth.GoogleIdentity{Subject: "other-sub", Email: "ken@corp.io", EmailVerified: true}); to != "/login?error=not_registered" {
		t.Fatalf("sub mismatch: %s", to)
	}

	// Session cookie from Google login works on the API.
	c := e.browser()
	cookie := rec.Result().Cookies()[0]
	req, _ := http.NewRequest("GET", e.http.URL+"/api/v1/me", nil)
	req.AddCookie(cookie)
	res, err := c.hc.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("google session: %v %v", res.StatusCode, err)
	}
	res.Body.Close()
}

func TestGoogleAllowedDomains(t *testing.T) {
	e := newEnv(t)
	e.createUser("max@other.com", "Max", "member", "active", "")
	e.srv.deps.Config.GoogleAllowedDomains = []string{"corp.io"}
	defer func() { e.srv.deps.Config.GoogleAllowedDomains = nil }()
	rec := httptest.NewRecorder()
	to := e.srv.Auth.CompleteGoogleLogin(e.ctx, rec, httptest.NewRequest("GET", "/", nil), auth.GoogleIdentity{Subject: "m", Email: "max@other.com", EmailVerified: true})
	if to != "/login?error=not_registered" {
		t.Fatalf("domain filter: %s", to)
	}
}

func TestGoogleDisabledRedirects(t *testing.T) {
	e := newEnv(t)
	r := e.browser().do("GET", "/api/v1/auth/google/start", nil)
	if r.status != http.StatusFound || r.header.Get("Location") != "/login?error=google_failed" {
		t.Fatalf("start without config: %d %s", r.status, r.header.Get("Location"))
	}
}
