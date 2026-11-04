package web

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSPAHandler(t *testing.T) {
	dir := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>app</html>"), 0o644))
	must(os.MkdirAll(filepath.Join(dir, "assets"), 0o755))
	must(os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte("console.log(1)"), 0o644))
	must(os.WriteFile(filepath.Join(dir, "favicon.svg"), []byte("<svg/>"), 0o644))

	h, err := Handler(dir)
	must(err)

	cases := []struct {
		path   string
		status int
		body   string
	}{
		{"/", 200, "<html>app</html>"},
		{"/projects/SHOP/test-cases", 200, "<html>app</html>"},
		{"/assets/app.js", 200, "console.log(1)"},
		{"/favicon.svg", 200, "<svg/>"},
		{"/assets/missing.js", 404, ""},
		{"/api/v2/whatever", 404, `"not_found"`},
		{"/../../etc/passwd", 200, "<html>app</html>"},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", c.path, nil))
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.body) {
			t.Errorf("%s: got %d %q", c.path, rec.Code, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/assets/app.js", nil))
	if !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Error("assets should be cached immutably")
	}

	if _, err := Handler(t.TempDir()); err == nil {
		t.Error("expected error for dir without index.html")
	}
}

func TestSPAHandlerCompressesAssets(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	js := strings.Repeat("console.log('qatlas');\n", 400)
	if err := os.WriteFile(filepath.Join(dir, "assets", "app-abc.js"), []byte(js), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html><title>q</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	h, err := Handler(dir)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/assets/app-abc.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("status %d encoding %q", rec.Code, rec.Header().Get("Content-Encoding"))
	}
	if rec.Body.Len() >= len(js) {
		t.Fatalf("not compressed: %d >= %d", rec.Body.Len(), len(js))
	}
	if !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("cache header lost: %q", rec.Header().Get("Cache-Control"))
	}
	// without Accept-Encoding the file is served as-is
	plain := httptest.NewRecorder()
	h.ServeHTTP(plain, httptest.NewRequest("GET", "/assets/app-abc.js", nil))
	if plain.Header().Get("Content-Encoding") != "" || plain.Body.String() != js {
		t.Fatalf("plain response changed")
	}
}
