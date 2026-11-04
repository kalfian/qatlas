package artifacts

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/db/testutil"
)

func TestLocalStore(t *testing.T) {
	ctx := context.Background()
	s, err := NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	key := "p/r/a.png"
	if err := s.Put(ctx, key, strings.NewReader("hello"), 5, "image/png"); err != nil {
		t.Fatal(err)
	}
	f, info, err := s.Open(ctx, key)
	if err != nil || info.Size != 5 {
		t.Fatalf("open: %v %+v", err, info)
	}
	if _, err := f.Seek(1, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(f)
	f.Close()
	if string(b) != "ello" {
		t.Fatalf("seek read %q", b)
	}

	// Size mismatch leaves nothing behind.
	if err := s.Put(ctx, "p/r/b.png", strings.NewReader("abc"), 10, ""); err == nil {
		t.Fatal("size mismatch accepted")
	}
	if _, _, err := s.Open(ctx, "p/r/b.png"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("partial file kept: %v", err)
	}
	entries, _ := os.ReadDir(s.Root + "/p/r")
	if len(entries) != 1 {
		t.Fatalf("temp files left: %v", entries)
	}

	for _, bad := range []string{"", "/etc/passwd", "../x", "a/../../x", "a//b", `a\b`} {
		if err := s.Put(ctx, bad, strings.NewReader("x"), -1, ""); err == nil {
			t.Errorf("key %q accepted", bad)
		}
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("double delete: %v", err)
	}
}

func TestStorageKeyAndInline(t *testing.T) {
	p, r, a := uuid.New(), uuid.New(), uuid.New()
	if k := StorageKey(p, r, a, "Shot 1.PNG"); k != p.String()+"/"+r.String()+"/"+a.String()+".png" {
		t.Fatalf("key %q", k)
	}
	if k := StorageKey(p, r, a, "evil.p/../hp"); strings.Contains(k, "..") {
		t.Fatalf("unsafe key %q", k)
	}
	if k := StorageKey(p, r, a, "noext"); strings.Contains(k[len(k)-37:], ".") {
		t.Fatalf("unexpected ext %q", k)
	}
	for ct, want := range map[string]bool{"image/png": true, "video/webm": true, "text/html": false, "application/octet-stream": false, "text/plain; charset=utf-8": true} {
		if inlineSafe(ct) != want {
			t.Errorf("inlineSafe(%q) != %v", ct, want)
		}
	}
}

// switchingStores flips its writer to "s3" while an upload to "local" is in flight.
type switchingStores struct {
	active string
	local  Store
	s3     Store
}

func (s *switchingStores) Writer() (string, Store) {
	if s.active == "s3" {
		return "s3", s.s3
	}
	return "local", s.local
}

func (s *switchingStores) For(b string) (Store, error) {
	return StoreSet{Active: s.active, Local: s.local, S3: s.s3}.For(b)
}

type hookStore struct {
	Store
	beforePut func()
}

func (h hookStore) Put(ctx context.Context, key string, r io.Reader, size int64, mime string) error {
	h.beforePut()
	return h.Store.Put(ctx, key, r, size, mime)
}

// An upload finishes (and is recorded) on the store it started with, even when
// the active backend changes meanwhile.
func TestSaveKeepsWriterOfUploadStart(t *testing.T) {
	pool := testutil.DB(t)
	ctx := context.Background()
	projectID, runID := artifactFixture(t, ctx, pool)
	a, _ := NewLocalStore(t.TempDir())
	b, _ := NewLocalStore(t.TempDir()) // stands in for S3
	stores := &switchingStores{active: "local", s3: b}
	stores.local = hookStore{Store: a, beforePut: func() { stores.active = "s3" }}
	art, err := SaveWith(ctx, pool, stores, Meta{ProjectID: projectID, RunID: runID, Kind: KindLog, Name: "x.log"}, strings.NewReader("abc"), 3)
	if err != nil || art.Storage != "local" {
		t.Fatalf("save: %+v %v", art, err)
	}
	var backend string
	if err := pool.QueryRow(ctx, `SELECT storage FROM artifacts WHERE id = $1`, art.ID).Scan(&backend); err != nil || backend != "local" {
		t.Fatalf("row backend %q %v", backend, err)
	}
	if _, err := a.Stat(ctx, StorageKey(projectID, runID, art.ID, art.Name)); err != nil {
		t.Fatalf("object not in the starting store: %v", err)
	}
	if w, _ := stores.Writer(); w != "s3" {
		t.Fatal("writer did not switch")
	}
	// Unavailable backends are reported, not panicking.
	if _, err := (StoreSet{Local: a}).For("s3"); !errors.Is(err, ErrBackendUnavailable) {
		t.Fatalf("For(s3): %v", err)
	}
}
