package artifacts

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
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
