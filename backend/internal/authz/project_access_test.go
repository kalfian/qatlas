package authz

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/db/testutil"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

func statusOf(err error) int {
	var apiErr *httpx.APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status
	}
	if err == nil {
		return 200
	}
	return 500
}

func TestProjectAccess(t *testing.T) {
	pool := testutil.DB(t)
	ctx := context.Background()
	mkUser := func(email, role string) auth.User {
		id := db.NewID()
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, name, system_role, status) VALUES ($1, $2, $2, $3, 'active')`, id, email, role); err != nil {
			t.Fatal(err)
		}
		u, err := auth.LoadUser(ctx, pool, id)
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	mkProject := func(key string) uuid.UUID {
		id := db.NewID()
		if _, err := pool.Exec(ctx, `INSERT INTO projects (id, key, name) VALUES ($1, $2, $2)`, id, key); err != nil {
			t.Fatal(err)
		}
		return id
	}
	shop, pay := mkProject("SHOP"), mkProject("PAY")
	viewer, editor, outsider, admin := mkUser("v@x.io", "member"), mkUser("e@x.io", "member"), mkUser("o@x.io", "member"), mkUser("a@x.io", "admin")
	for _, m := range []struct {
		u    auth.User
		role string
	}{{viewer, "viewer"}, {editor, "editor"}} {
		if _, err := pool.Exec(ctx, `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)`, shop, m.u.ID, m.role); err != nil {
			t.Fatal(err)
		}
	}
	tokID := db.NewID()
	cases := []struct {
		name   string
		actor  *auth.Actor
		key    string
		action Action
		status int
		role   Role
	}{
		{"viewer view", &auth.Actor{User: viewer}, "shop", View, 200, RoleViewer},
		{"viewer edit", &auth.Actor{User: viewer}, "SHOP", EditTests, 403, ""},
		{"editor run", &auth.Actor{User: editor}, "SHOP", Run, 200, RoleEditor},
		{"editor manage env", &auth.Actor{User: editor}, "SHOP", ManageEnvironments, 403, ""},
		{"outsider", &auth.Actor{User: outsider}, "SHOP", View, 404, ""},
		{"unknown project", &auth.Actor{User: admin}, "NOPE", View, 404, ""},
		{"admin no membership", &auth.Actor{User: admin}, "PAY", ManageSettings, 200, RoleMaintainer},
		{"anonymous", nil, "SHOP", View, 401, ""},
		{"read token view", &auth.Actor{User: editor, TokenID: &tokID, Scopes: []string{"read"}}, "SHOP", View, 200, RoleEditor},
		{"read token run", &auth.Actor{User: editor, TokenID: &tokID, Scopes: []string{"read"}}, "SHOP", Run, 403, ""},
		{"run token run", &auth.Actor{User: editor, TokenID: &tokID, Scopes: []string{"run"}}, "SHOP", Run, 200, RoleEditor},
		{"run token edit", &auth.Actor{User: editor, TokenID: &tokID, Scopes: []string{"run"}}, "SHOP", EditTests, 403, ""},
		{"token exceeds role", &auth.Actor{User: viewer, TokenID: &tokID, Scopes: []string{"read", "write", "run"}}, "SHOP", EditTests, 403, ""},
		{"token restricted to other project", &auth.Actor{User: admin, TokenID: &tokID, Scopes: []string{"read"}, ProjectIDs: []uuid.UUID{shop}}, "PAY", View, 404, ""},
		{"token restricted ok", &auth.Actor{User: admin, TokenID: &tokID, Scopes: []string{"read"}, ProjectIDs: []uuid.UUID{pay}}, "PAY", View, 200, RoleMaintainer},
	}
	for _, c := range cases {
		p, role, err := ProjectAccess(ctx, pool, c.actor, c.key, c.action)
		if got := statusOf(err); got != c.status {
			t.Errorf("%s: status %d want %d (%v)", c.name, got, c.status, err)
			continue
		}
		if c.status == 200 && (role != c.role || p.Key != strings.ToUpper(c.key) || len(p.DefaultRunOptions) == 0 || p.ArtifactRetentionDays != 30) {
			t.Errorf("%s: role=%s project=%+v", c.name, role, p)
		}
	}
}
