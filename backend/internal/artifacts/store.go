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
)

// ErrNotFound is returned by Store.Open / Store.Delete when the object does not exist.
var ErrNotFound = errors.New("artifact object not found")

// Info describes a stored object.
type Info struct {
	Size    int64
	ModTime time.Time
}

// Store is the blob storage behind artifacts. Keys are slash-separated relative
// paths ("<project>/<run>/<artifact>.png").
//
// TODO(phase 5): S3Store (minio-go, QATLAS_S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY/REGION)
// implementing the same interface, plus an optional presigned-URL redirect in the handler.
type Store interface {
	// Put stores r under key. size is the expected byte count, or -1 when unknown;
	// a mismatch is an error and leaves nothing behind.
	Put(ctx context.Context, key string, r io.Reader, size int64, mime string) error
	// Open returns a seekable reader (for http.ServeContent / Range requests).
	Open(ctx context.Context, key string) (io.ReadSeekCloser, Info, error)
	// Delete removes the object; a missing object yields ErrNotFound.
	Delete(ctx context.Context, key string) error
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
	if key == "" || strings.HasPrefix(key, "/") || strings.Contains(key, "\\") {
		return "", fmt.Errorf("invalid artifact key %q", key)
	}
	for _, seg := range strings.Split(key, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", fmt.Errorf("invalid artifact key %q", key)
		}
	}
	return filepath.Join(s.Root, filepath.FromSlash(key)), nil
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
