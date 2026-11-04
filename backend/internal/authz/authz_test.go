package authz

import (
	"testing"

	"github.com/kalfian/qatlas/backend/internal/auth"
)

// expected mirrors web/src/lib/permissions.ts MATRIX; keep both in sync.
var expected = map[Action]map[Role]bool{
	View:               {RoleViewer: true, RoleEditor: true, RoleMaintainer: true},
	EditTests:          {RoleEditor: true, RoleMaintainer: true},
	Run:                {RoleEditor: true, RoleMaintainer: true},
	CancelOwnRun:       {RoleEditor: true, RoleMaintainer: true},
	CancelAnyRun:       {RoleMaintainer: true},
	ExecuteManual:      {RoleEditor: true, RoleMaintainer: true},
	ReassignManual:     {RoleMaintainer: true},
	ManageEnvironments: {RoleMaintainer: true},
	ManageMembers:      {RoleMaintainer: true},
	ManageSettings:     {RoleMaintainer: true},
}

func TestCanMatrix(t *testing.T) {
	if len(Actions()) != len(expected) {
		t.Fatalf("matrix has %d actions, test expects %d", len(Actions()), len(expected))
	}
	for _, action := range Actions() {
		want, ok := expected[action]
		if !ok {
			t.Fatalf("action %s missing from test matrix", action)
		}
		for _, role := range Roles {
			if got := Can(role, action, auth.SystemRoleMember); got != want[role] {
				t.Errorf("Can(%s, %s, member) = %v, want %v", role, action, got, want[role])
			}
			if !Can(role, action, auth.SystemRoleAdmin) {
				t.Errorf("admin must be allowed %s as %s", action, role)
			}
		}
		if Can("", action, auth.SystemRoleMember) {
			t.Errorf("no role must not allow %s", action)
		}
		if !Can("", action, auth.SystemRoleAdmin) {
			t.Errorf("admin without role must be allowed %s", action)
		}
	}
}

func TestScope(t *testing.T) {
	want := map[Action]string{
		View: auth.ScopeRead, EditTests: auth.ScopeWrite, Run: auth.ScopeRun, CancelOwnRun: auth.ScopeRun,
		CancelAnyRun: auth.ScopeRun, ExecuteManual: auth.ScopeRun, ReassignManual: auth.ScopeWrite,
		ManageEnvironments: auth.ScopeWrite, ManageMembers: auth.ScopeWrite, ManageSettings: auth.ScopeWrite,
	}
	for a, s := range want {
		if Scope(a) != s {
			t.Errorf("Scope(%s) = %s, want %s", a, Scope(a), s)
		}
	}
}

func TestEffectiveRole(t *testing.T) {
	editor := "editor"
	if EffectiveRole(&editor, auth.SystemRoleAdmin) != RoleEditor {
		t.Error("membership role wins for admins")
	}
	if EffectiveRole(nil, auth.SystemRoleAdmin) != RoleMaintainer {
		t.Error("admin without membership is maintainer")
	}
	if EffectiveRole(nil, auth.SystemRoleMember) != "" {
		t.Error("member without membership has no role")
	}
}

func TestEntityKeys(t *testing.T) {
	if ProjectKeyOf("SHOP-T12") != "SHOP" || ProjectKeyOf("shop") != "SHOP" {
		t.Error("ProjectKeyOf")
	}
	cases := []struct {
		key  string
		kind byte
		p    string
		n    int
		ok   bool
	}{
		{"SHOP-T12", 'T', "SHOP", 12, true},
		{"shop-r105", 'R', "SHOP", 105, true},
		{"SHOP-F3", 'T', "", 0, false},
		{"SHOP-T", 'T', "", 0, false},
		{"SHOP-T0", 'T', "", 0, false},
		{"SHOP-Tx", 'T', "", 0, false},
		{"SHOP", 'T', "", 0, false},
		{"-T1", 'T', "", 0, false},
	}
	for _, c := range cases {
		p, n, ok := ParseEntityKey(c.key, c.kind)
		if p != c.p || n != c.n || ok != c.ok {
			t.Errorf("ParseEntityKey(%q,%c) = %q,%d,%v", c.key, c.kind, p, n, ok)
		}
	}
}
