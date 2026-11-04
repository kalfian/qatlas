package secrets

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/db/testutil"
)

func testKey(b byte) []byte { return bytes.Repeat([]byte{b}, KeySize) }

func TestSealOpenRoundTrip(t *testing.T) {
	key := testKey(7)
	for _, pt := range []string{"", "s3cr3t", strings.Repeat("x", 4096), "ünïcødé ✓"} {
		sealed, err := Seal(key, []byte(pt))
		if err != nil {
			t.Fatal(err)
		}
		if pt != "" && bytes.Contains(sealed, []byte(pt)) {
			t.Fatal("sealed value contains the plaintext")
		}
		got, err := Open(key, sealed)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != pt {
			t.Fatalf("round trip: got %q want %q", got, pt)
		}
	}
}

func TestSealUsesFreshNonce(t *testing.T) {
	key := testKey(1)
	a, _ := Seal(key, []byte("same"))
	b, _ := Seal(key, []byte("same"))
	if bytes.Equal(a, b) {
		t.Fatal("two seals of the same plaintext must differ")
	}
	if len(a) != 12+4+16 {
		t.Fatalf("sealed length %d, want nonce(12)+ct(4)+tag(16)", len(a))
	}
}

func TestOpenRejects(t *testing.T) {
	key := testKey(2)
	sealed, _ := Seal(key, []byte("value"))

	if _, err := Open(testKey(3), sealed); !errors.Is(err, ErrDecrypt) {
		t.Fatalf("wrong key: %v", err)
	}
	tampered := bytes.Clone(sealed)
	tampered[len(tampered)-1] ^= 0xff
	if _, err := Open(key, tampered); !errors.Is(err, ErrDecrypt) {
		t.Fatalf("tampered: %v", err)
	}
	if _, err := Open(key, sealed[:10]); !errors.Is(err, ErrMalformed) {
		t.Fatalf("short: %v", err)
	}
	if _, err := Seal([]byte("short"), []byte("x")); !errors.Is(err, ErrKeySize) {
		t.Fatalf("bad key size seal: %v", err)
	}
	if _, err := Open(nil, sealed); !errors.Is(err, ErrKeySize) {
		t.Fatalf("bad key size open: %v", err)
	}
}

func TestForEnvironment(t *testing.T) {
	pool := testutil.DB(t)
	ctx := context.Background()
	key := testKey(9)

	pid, envID, otherEnv := db.NewID(), db.NewID(), db.NewID()
	mustExec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	mustExec(`INSERT INTO projects (id, key, name) VALUES ($1, 'SHOP', 'Shop')`, pid)
	mustExec(`INSERT INTO environments (id, project_id, name) VALUES ($1, $2, 'staging'), ($3, $2, 'prod')`, envID, pid, otherEnv)
	put := func(env any, name, value string) {
		sealed, err := Seal(key, []byte(value))
		if err != nil {
			t.Fatal(err)
		}
		mustExec(`INSERT INTO environment_secrets (environment_id, name, value_enc) VALUES ($1, $2, $3)`, env, name, sealed)
	}
	put(envID, "QA_PASSWORD", "hunter2")
	put(envID, "API_KEY", "k-123")
	put(otherEnv, "QA_PASSWORD", "prod-pass")

	got, err := ForEnvironment(ctx, pool, envID, key)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["QA_PASSWORD"] != "hunter2" || got["API_KEY"] != "k-123" {
		t.Fatalf("secrets: %v", got)
	}
	empty, err := ForEnvironment(ctx, pool, db.NewID(), key)
	if err != nil || len(empty) != 0 {
		t.Fatalf("unknown env: %v %v", empty, err)
	}
	_, err = ForEnvironment(ctx, pool, envID, testKey(10))
	if !errors.Is(err, ErrDecrypt) || strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("wrong key: %v", err)
	}
}
