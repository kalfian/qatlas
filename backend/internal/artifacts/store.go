// Package artifacts stores run files (screenshots, videos, traces, logs, tester
// attachments) behind the Store interface, records them in the artifacts table
// (Save), serves them with RBAC + HTTP Range (GET /artifacts/{id}) and purges
// expired files (Purge, scheduled by the worker).
package artifacts

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ErrNotFound is returned by Store.Open / Store.Delete when the object does not exist.
var ErrNotFound = errors.New("artifact object not found")

// Info describes a stored object.
type Info struct {
	Size    int64
	ModTime time.Time
}

// Store is the blob storage behind artifacts: LocalStore (QATLAS_STORAGE=local)
// or S3Store (QATLAS_STORAGE=s3). Keys are slash-separated relative paths
// ("<project>/<run>/<artifact>.png") and identical in every store, so
// `qatlas artifacts migrate` copies objects without touching the database.
type Store interface {
	// Put stores r under key. size is the expected byte count, or -1 when unknown;
	// a mismatch is an error and leaves nothing behind.
	Put(ctx context.Context, key string, r io.Reader, size int64, mime string) error
	// Open returns a seekable reader (for http.ServeContent / Range requests).
	Open(ctx context.Context, key string) (io.ReadSeekCloser, Info, error)
	// Stat describes the object; a missing object yields ErrNotFound.
	Stat(ctx context.Context, key string) (Info, error)
	// Delete removes the object; a missing object yields ErrNotFound.
	Delete(ctx context.Context, key string) error
}

// Pinger is implemented by stores with a cheap reachability check (/readyz).
type Pinger interface {
	Ping(ctx context.Context) error
}

// Backend names the store kind ("local", "s3") for /readyz and CLI output.
func Backend(s Store) string {
	switch s.(type) {
	case *LocalStore:
		return "local"
	case *S3Store:
		return "s3"
	default:
		return "custom"
	}
}

// Verify checks that the store is reachable and writable: Ping (if supported),
// then a probe object is written and deleted. `qatlas server|worker|all` refuse
// to start when it fails.
func Verify(ctx context.Context, s Store) error {
	if p, ok := s.(Pinger); ok {
		if err := p.Ping(ctx); err != nil {
			return err
		}
	}
	key := ".qatlas-probe-" + uuid.NewString()
	if err := s.Put(ctx, key, strings.NewReader("ok"), 2, "text/plain"); err != nil {
		return fmt.Errorf("write probe object: %w", err)
	}
	if err := s.Delete(ctx, key); err != nil {
		return fmt.Errorf("delete probe object: %w", err)
	}
	return nil
}

// validateKey rejects keys that could escape the store root or are ambiguous.
func validateKey(key string) error {
	if key == "" || strings.HasPrefix(key, "/") || strings.ContainsAny(key, "\\\x00") {
		return fmt.Errorf("invalid artifact key %q", key)
	}
	for _, seg := range strings.Split(key, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return fmt.Errorf("invalid artifact key %q", key)
		}
	}
	return nil
}

// LocalStore keeps objects on the local filesystem under Root
// (QATLAS_DATA_DIR/artifacts by default).
type LocalStore struct {
	Root string
}

// NewLocalStore creates root if needed.
func NewLocalStore(root string) (*LocalStore, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o750); err != nil {
		return nil, fmt.Errorf("create artifact dir: %w", err)
	}
	return &LocalStore{Root: abs}, nil
}

func (s *LocalStore) path(key string) (string, error) {
	if err := validateKey(key); err != nil {
		return "", err
	}
	return filepath.Join(s.Root, filepath.FromSlash(key)), nil
}

// Ping checks that the root directory exists.
func (s *LocalStore) Ping(context.Context) error {
	st, err := os.Stat(s.Root)
	if err != nil {
		return fmt.Errorf("artifact dir: %w", err)
	}
	if !st.IsDir() {
		return fmt.Errorf("artifact dir %s is not a directory", s.Root)
	}
	return nil
}

// Stat describes the object.
func (s *LocalStore) Stat(_ context.Context, key string) (Info, error) {
	p, err := s.path(key)
	if err != nil {
		return Info{}, err
	}
	st, err := os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return Info{}, ErrNotFound
	}
	if err != nil {
		return Info{}, err
	}
	if !st.Mode().IsRegular() {
		return Info{}, fmt.Errorf("artifact %q is not a regular file", key)
	}
	return Info{Size: st.Size(), ModTime: st.ModTime()}, nil
}

// Put writes to a temp file in the target directory and renames it into place.
func (s *LocalStore) Put(ctx context.Context, key string, r io.Reader, size int64, _ string) error {
	dst, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".upload-*")
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	n, err := io.Copy(tmp, ctxReader{ctx: ctx, r: r})
	if err != nil {
		return fmt.Errorf("write artifact: %w", err)
	}
	if size >= 0 && n != size {
		return fmt.Errorf("write artifact: got %d bytes, want %d", n, size)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), dst); err != nil {
		return err
	}
	ok = true
	return nil
}

// Open opens the object for reading.
func (s *LocalStore) Open(_ context.Context, key string) (io.ReadSeekCloser, Info, error) {
	p, err := s.path(key)
	if err != nil {
		return nil, Info{}, err
	}
	f, err := os.Open(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, Info{}, ErrNotFound
	}
	if err != nil {
		return nil, Info{}, err
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, Info{}, err
	}
	return f, Info{Size: st.Size(), ModTime: st.ModTime()}, nil
}

// Delete removes the object.
func (s *LocalStore) Delete(_ context.Context, key string) error {
	p, err := s.path(key)
	if err != nil {
		return err
	}
	err = os.Remove(p)
	if errors.Is(err, os.ErrNotExist) {
		return ErrNotFound
	}
	return err
}

// ctxReader aborts long copies when ctx is cancelled.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
