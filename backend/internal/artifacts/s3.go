package artifacts

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/kalfian/qatlas/backend/internal/config"
)

const (
	// s3PartSize is the multipart chunk size (and the per-upload memory buffer
	// when the size is unknown). 16 MiB is minio-go's minimum.
	s3PartSize = 16 << 20
	// s3SmallObject: uploads of unknown size up to this many bytes are buffered
	// and sent with one PUT instead of a multipart upload (tester attachments
	// are at most 25 MB, screenshots far less).
	s3SmallObject = 16 << 20
	// s3ReadChunk bounds one ranged GET of a download. Reads continue with the
	// next chunk, so a client that seeks (video) or disconnects never makes the
	// server pull more than one chunk it does not need.
	s3ReadChunk = 8 << 20
)

// S3Store keeps objects in an S3-compatible bucket (AWS S3, Garage, MinIO…).
// The bucket stays private: downloads stream through GET /artifacts/{id}.
// Object keys are Prefix + "/" + the store key (the same keys LocalStore uses
// as relative paths).
type S3Store struct {
	client    *minio.Client
	bucket    string
	prefix    string
	endpoint  string
	readChunk int64
}

// S3Option tunes NewS3Store.
type S3Option func(*minio.Options)

// WithMaxRetries bounds minio-go's retries of a failing request (default 10).
// Probes use 1 so an unreachable endpoint fails fast.
func WithMaxRetries(n int) S3Option {
	return func(o *minio.Options) { o.MaxRetries = n }
}

// NewS3Store builds the client. It does not contact the server; call Verify
// (or Ping, Probe) to check the bucket.
func NewS3Store(cfg config.S3Config, opts ...S3Option) (*S3Store, error) {
	return newS3Store(cfg, nil, opts...)
}

// newS3Store allows tests to observe requests (transport nil = minio default).
func newS3Store(cfg config.S3Config, transport http.RoundTripper, opts ...S3Option) (*S3Store, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	u, err := url.Parse(cfg.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("QATLAS_S3_ENDPOINT: %w", err)
	}
	lookup := minio.BucketLookupAuto
	if cfg.ForcePathStyle {
		lookup = minio.BucketLookupPath
	}
	mo := &minio.Options{
		Creds:        credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure:       u.Scheme == "https",
		Region:       cfg.Region,
		BucketLookup: lookup,
		Transport:    transport,
	}
	for _, o := range opts {
		o(mo)
	}
	client, err := minio.New(u.Host, mo)
	if err != nil {
		return nil, fmt.Errorf("S3 client: %w", err)
	}
	return &S3Store{client: client, bucket: cfg.Bucket, prefix: cfg.Prefix, endpoint: u.Scheme + "://" + u.Host, readChunk: s3ReadChunk}, nil
}

// String describes the store for logs and errors (no credentials).
func (s *S3Store) String() string {
	d := fmt.Sprintf("s3 bucket %q at %s", s.bucket, s.endpoint)
	if s.prefix != "" {
		d += fmt.Sprintf(" (prefix %q)", s.prefix)
	}
	return d
}

func (s *S3Store) objectKey(key string) (string, error) {
	if err := validateKey(key); err != nil {
		return "", err
	}
	if s.prefix == "" {
		return key, nil
	}
	return s.prefix + "/" + key, nil
}

// Ping checks that the bucket exists and the credentials may access it (HEAD bucket).
func (s *S3Store) Ping(ctx context.Context) error {
	ok, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		return fmt.Errorf("%s: %w", s, describeS3Error(err))
	}
	if !ok {
		return fmt.Errorf("%s: bucket does not exist (create it first, e.g. `garage bucket create %s`)", s, s.bucket)
	}
	return nil
}

// checkBucket separates "cannot talk to the server" (reached=false) from
// "the server answered, but the bucket is missing or not accessible".
func (s *S3Store) checkBucket(ctx context.Context) (reached bool, err error) {
	ok, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		resp := minio.ToErrorResponse(err)
		if resp.StatusCode == 0 && resp.Code == "" {
			return false, fmt.Errorf("cannot reach %s: %w", s.endpoint, err)
		}
		return true, describeS3Error(err)
	}
	if !ok {
		return true, fmt.Errorf("bucket %q does not exist (create it first, e.g. `garage bucket create %s`)", s.bucket, s.bucket)
	}
	return true, nil
}

// Put uploads r with the given content type. With a known size the upload is
// streamed; with size -1 objects up to 16 MiB are buffered and sent with one
// PUT, larger ones as a multipart upload. A size mismatch deletes the object.
func (s *S3Store) Put(ctx context.Context, key string, r io.Reader, size int64, mime string) error {
	k, err := s.objectKey(key)
	if err != nil {
		return err
	}
	if mime == "" {
		mime = DefaultMIME
	}
	body, n := io.Reader(ctxReader{ctx: ctx, r: r}), size
	if size < 0 {
		var buf bytes.Buffer
		m, err := io.CopyN(&buf, body, s3SmallObject+1)
		if err != nil && !errors.Is(err, io.EOF) {
			return fmt.Errorf("read artifact: %w", err)
		}
		if m <= s3SmallObject {
			body, n = bytes.NewReader(buf.Bytes()), m
		} else {
			body = io.MultiReader(&buf, body)
		}
	}
	info, err := s.client.PutObject(ctx, s.bucket, k, body, n, minio.PutObjectOptions{
		ContentType: mime,
		PartSize:    s3PartSize,
	})
	if err != nil {
		return fmt.Errorf("upload artifact to %s: %w", s, describeS3Error(err))
	}
	if size >= 0 {
		// minio-go reads exactly size bytes; a longer source is a mismatch too.
		var one [1]byte
		extra, _ := io.ReadFull(r, one[:])
		if info.Size != size || extra > 0 {
			_ = s.client.RemoveObject(context.WithoutCancel(ctx), s.bucket, k, minio.RemoveObjectOptions{})
			return fmt.Errorf("write artifact: size mismatch, want %d bytes", size)
		}
	}
	return nil
}

// Stat describes the object (HEAD object).
func (s *S3Store) Stat(ctx context.Context, key string) (Info, error) {
	_, info, err := s.stat(ctx, key)
	return info, err
}

func (s *S3Store) stat(ctx context.Context, key string) (minio.ObjectInfo, Info, error) {
	k, err := s.objectKey(key)
	if err != nil {
		return minio.ObjectInfo{}, Info{}, err
	}
	oi, err := s.client.StatObject(ctx, s.bucket, k, minio.StatObjectOptions{})
	if err != nil {
		if isNoSuchKey(err) {
			return minio.ObjectInfo{}, Info{}, ErrNotFound
		}
		return minio.ObjectInfo{}, Info{}, fmt.Errorf("stat artifact in %s: %w", s, describeS3Error(err))
	}
	return oi, Info{Size: oi.Size, ModTime: oi.LastModified}, nil
}

// Open stats the object and returns a lazy seekable reader: nothing is
// downloaded until the first Read, which issues a ranged GET from the current
// offset (at most readChunk bytes; further Reads continue chunk by chunk).
// Seek only moves the offset and drops an open body, so http.ServeContent's
// Range handling (206, multipart/byteranges, If-Range) turns into ranged GETs
// against the bucket and video seeking never downloads the whole file. Every
// GET is pinned to the ETag seen by Stat (If-Match).
func (s *S3Store) Open(ctx context.Context, key string) (io.ReadSeekCloser, Info, error) {
	oi, info, err := s.stat(ctx, key)
	if err != nil {
		return nil, Info{}, err
	}
	return &s3Reader{ctx: ctx, s: s, key: oi.Key, etag: oi.ETag, size: oi.Size}, info, nil
}

// Delete removes the object; ErrNotFound when it does not exist (S3 DELETE is
// idempotent, so this checks with HEAD first).
func (s *S3Store) Delete(ctx context.Context, key string) error {
	k, err := s.objectKey(key)
	if err != nil {
		return err
	}
	if _, _, err := s.stat(ctx, key); err != nil {
		return err
	}
	if err := s.client.RemoveObject(ctx, s.bucket, k, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("delete artifact from %s: %w", s, describeS3Error(err))
	}
	return nil
}

// s3Reader is an io.ReadSeekCloser over ranged GETs.
type s3Reader struct {
	ctx  context.Context
	s    *S3Store
	key  string // full object key (with prefix)
	etag string
	size int64

	off    int64         // current position
	end    int64         // exclusive end of the open body's range
	body   io.ReadCloser // nil until the next Read
	closed bool
}

func (r *s3Reader) Read(p []byte) (int, error) {
	if r.closed {
		return 0, errors.New("artifact reader closed")
	}
	if r.off >= r.size {
		return 0, io.EOF
	}
	if len(p) == 0 {
		return 0, nil
	}
	if r.body == nil {
		chunk := r.s.readChunk
		if chunk <= 0 {
			chunk = s3ReadChunk
		}
		end := min(r.off+chunk, r.size)
		opts := minio.GetObjectOptions{}
		if r.etag != "" {
			if err := opts.SetMatchETag(r.etag); err != nil {
				return 0, err
			}
		}
		if err := opts.SetRange(r.off, end-1); err != nil {
			return 0, err
		}
		// Core.GetObject is one plain GET whose body we can drop on Seek
		// (the high-level *minio.Object issues extra requests of its own).
		body, _, _, err := minio.Core{Client: r.s.client}.GetObject(r.ctx, r.s.bucket, r.key, opts)
		if err != nil {
			return 0, fmt.Errorf("download artifact from %s: %w", r.s, describeS3Error(err))
		}
		r.body, r.end = body, end
	}
	if left := r.end - r.off; int64(len(p)) > left {
		p = p[:left]
	}
	n, err := r.body.Read(p)
	r.off += int64(n)
	if r.off >= r.end || errors.Is(err, io.EOF) {
		_ = r.body.Close()
		r.body = nil
		if r.off < r.end {
			return n, io.ErrUnexpectedEOF
		}
		return n, nil // next Read opens the following chunk or reports EOF
	}
	return n, err
}

func (r *s3Reader) Seek(offset int64, whence int) (int64, error) {
	if r.closed {
		return 0, errors.New("artifact reader closed")
	}
	var abs int64
	switch whence {
	case io.SeekStart:
		abs = offset
	case io.SeekCurrent:
		abs = r.off + offset
	case io.SeekEnd:
		abs = r.size + offset
	default:
		return 0, errors.New("seek: invalid whence")
	}
	if abs < 0 {
		return 0, errors.New("seek: negative position")
	}
	if abs != r.off && r.body != nil {
		_ = r.body.Close()
		r.body = nil
	}
	r.off = abs
	return abs, nil
}

func (r *s3Reader) Close() error {
	r.closed = true
	if r.body != nil {
		err := r.body.Close()
		r.body = nil
		return err
	}
	return nil
}

func isNoSuchKey(err error) bool {
	resp := minio.ToErrorResponse(err)
	return resp.Code == minio.NoSuchKey || (resp.StatusCode == http.StatusNotFound && resp.Code != minio.NoSuchBucket)
}

// describeS3Error adds a hint for the common setup mistakes.
func describeS3Error(err error) error {
	resp := minio.ToErrorResponse(err)
	switch {
	case resp.Code == minio.NoSuchBucket:
		return fmt.Errorf("%w (bucket does not exist)", err)
	case resp.StatusCode == http.StatusForbidden || resp.Code == "AccessDenied" || resp.Code == "InvalidAccessKeyId" || resp.Code == "SignatureDoesNotMatch":
		return fmt.Errorf("%w (check QATLAS_S3_ACCESS_KEY / QATLAS_S3_SECRET_KEY and that the key may read and write the bucket)", err)
	case resp.Code == "AuthorizationHeaderMalformed" || resp.Code == "InvalidRegion":
		return fmt.Errorf("%w (check QATLAS_S3_REGION; Garage uses the s3_region of garage.toml, usually \"garage\")", err)
	}
	return err
}
