package auth

import (
	"strings"
	"testing"
)

func TestHashAndVerifyPassword(t *testing.T) {
	h, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=65536,t=3,p=2$") {
		t.Fatalf("unexpected PHC header: %s", h)
	}
	ok, err := VerifyPassword("correct horse battery", h)
	if err != nil || !ok {
		t.Fatalf("verify correct: ok=%v err=%v", ok, err)
	}
	ok, err = VerifyPassword("wrong horse battery", h)
	if err != nil || ok {
		t.Fatalf("verify wrong: ok=%v err=%v", ok, err)
	}
	h2, _ := HashPassword("correct horse battery")
	if h == h2 {
		t.Fatal("hashes must be salted")
	}
}

func TestVerifyUsesEncodedParams(t *testing.T) {
	// A hash produced with cheaper parameters must still verify (upgradeable params).
	h, err := hashWith("pw-0123456789", Argon2Params{Memory: 8 * 1024, Time: 1, Threads: 1, SaltLen: 16, KeyLen: 32})
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := VerifyPassword("pw-0123456789", h); err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
}

func TestVerifyMalformed(t *testing.T) {
	for _, h := range []string{
		"",
		"plain",
		"$argon2i$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=18$m=65536,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=x,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=2$!!$aGFzaA",
		"$argon2id$v=19$m=999999999,t=3,p=2$c2FsdA$aGFzaA",
	} {
		if ok, err := VerifyPassword("x", h); ok || err == nil {
			t.Errorf("%q: expected error, got ok=%v err=%v", h, ok, err)
		}
	}
}

func TestAPITokenFormat(t *testing.T) {
	prefix, secret := newAPIToken()
	if !apiTokenPattern.MatchString(secret) || !strings.HasPrefix(secret, prefix+"_") || len(prefix) != 12 {
		t.Fatalf("bad token %q / %q", prefix, secret)
	}
	if apiTokenPattern.MatchString("qat_xyz_123") {
		t.Fatal("pattern too lax")
	}
}

func TestActorScopes(t *testing.T) {
	var nilActor *Actor
	if nilActor.HasScope(ScopeRead) {
		t.Fatal("nil actor has no scopes")
	}
	session := &Actor{}
	for _, s := range AllScopes {
		if !session.HasScope(s) {
			t.Fatalf("session must have scope %s", s)
		}
	}
	id := session.User.ID
	tok := &Actor{TokenID: &id, Scopes: []string{ScopeRead}}
	if !tok.HasScope(ScopeRead) || tok.HasScope(ScopeWrite) || tok.RequireScope(ScopeRun) == nil {
		t.Fatal("token scope check wrong")
	}
	if u, tk := nilActor.AuditIdentity(); u != nil || tk != nil {
		t.Fatal("nil actor audit identity must be empty")
	}
}
