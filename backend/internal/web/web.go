// Package web serves the built SPA (web/dist) when QATLAS_WEB_DIR is set.
package web

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// compressible lists the static asset types worth gzip-compressing (the SPA's JS/CSS/HTML/SVG/JSON).
// Fonts (woff2) and images are already compressed; API, SSE and artifacts are not served here.
var compressible = []string{"text/html", "text/css", "text/javascript", "application/javascript", "application/json", "image/svg+xml"}

// Handler serves files from dir. Unknown paths fall back to index.html (SPA
// routing), except /api/* (JSON 404) and /assets/* (plain 404, so a missing
// hashed bundle never returns HTML). Access is confined to dir via os.Root,
// so symlinks / ".." cannot escape it.
func Handler(dir string) (http.Handler, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	fsys := root.FS()
	if _, err := fs.Stat(fsys, "index.html"); err != nil {
		return nil, errors.New("QATLAS_WEB_DIR has no index.html: " + dir)
	}
	files := http.FileServerFS(fsys)

	return middleware.Compress(5, compressible...)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == "/api" || strings.HasPrefix(p, "/api/") {
			httpx.NotFoundHandler(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+p), "/")
		if name != "" && name != "index.html" {
			if st, err := fs.Stat(fsys, name); err == nil && !st.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
			if strings.HasPrefix(name, "assets/") {
				http.NotFound(w, r)
				return
			}
		}
		serveIndex(w, r, fsys)
	})), nil
}

func serveIndex(w http.ResponseWriter, r *http.Request, fsys fs.FS) {
	data, err := fs.ReadFile(fsys, "index.html")
	if err != nil {
		http.Error(w, "index.html missing", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}
