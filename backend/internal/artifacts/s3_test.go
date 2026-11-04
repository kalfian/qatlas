package artifacts

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	"github.com/kalfian/qatlas/backend/internal/artifacts/s3test"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/db/testutil"
)

func TestMain(m *testing.M) { s3test.Main(m) }

func newS3(t *testing.T) (*S3Store, func() []string) {
	t.Helper()
	cfg := s3test.Config(t)
	s, err := NewS3Store(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return s, func() []string { return s3test.Keys(t, cfg) }
}

func TestS3Store(t *testing.T) {
	ctx := context.Background()
	s, keys := newS3(t)
	if err := Verify(ctx, s); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if Backend(s) != "s3" || strings.Contains(s.String(), "GK") {
		t.Fatalf("backend %q / %s", Backend(s), s)
	}

	// Put with known size + content type; keys get the prefix.
	content := []byte("0123456789abcdefghij")
	key := "p/r/a.png"
	if err := s.Put(ctx, key, bytes.NewReader(content), int64(len(content)), "image/png"); err != nil {
		t.Fatal(err)
	}
	if got := keys(); len(got) != 1 || !strings.HasSuffix(got[0], "/p/r/a.png") || !strings.HasPrefix(got[0], s.prefix+"/") {
		t.Fatalf("object keys %v (prefix %q)", got, s.prefix)
	}
	oi, err := s.client.StatObject(ctx, s.bucket, s.prefix+"/"+key, minio.StatObjectOptions{})
	if err != nil || oi.ContentType != "image/png" {
		t.Fatalf("content type %q %v", oi.ContentType, err)
	}
	info, err := s.Stat(ctx, key)
	if err != nil || info.Size != 20 || info.ModTime.IsZero() {
		t.Fatalf("stat %+v %v", info, err)
	}

	// Open: full read, seek + read (ranged GET), seek back, SeekEnd.
	f, info, err := s.Open(ctx, key)
	if err != nil || info.Size != 20 {
		t.Fatalf("open %+v %v", info, err)
	}
	b, err := io.ReadAll(f)
	if err != nil || !bytes.Equal(b, content) {
		t.Fatalf("full read %q %v", b, err)
	}
	if n, err := f.Seek(-5, io.SeekEnd); err != nil || n != 15 {
		t.Fatalf("seek end %d %v", n, err)
	}
	b, _ = io.ReadAll(f)
	if string(b) != "fghij" {
		t.Fatalf("tail %q", b)
	}
	if _, err := f.Seek(3, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(f, buf); err != nil || string(buf) != "3456" {
		t.Fatalf("range read %q %v", buf, err)
	}
	if _, err := f.Seek(2, io.SeekCurrent); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(f, buf); err != nil || string(buf) != "9abc" {
		t.Fatalf("seek current read %q %v", buf, err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	// http.ServeContent over the S3 reader: single range, suffix range, multi-range.
	hs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f, info, err := s.Open(r.Context(), key)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer f.Close()
		http.ServeContent(w, r, "a.png", info.ModTime, f)
	}))
	defer hs.Close()
	for rng, want := range map[string]struct {
		status int
		body   string
		cr     string
	}{
		"":           {200, string(content), ""},
		"bytes=5-9":  {206, "56789", "bytes 5-9/20"},
		"bytes=-3":   {206, "hij", "bytes 17-19/20"},
		"bytes=18-":  {206, "ij", "bytes 18-19/20"},
		"bytes=30-":  {416, "", "bytes */20"},
		"bytes=0-0,": {206, "0", "bytes 0-0/20"},
	} {
		req, _ := http.NewRequest("GET", hs.URL, nil)
		if rng != "" {
			req.Header.Set("Range", rng)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != want.status || (want.status != 416 && string(body) != want.body) || res.Header.Get("Content-Range") != want.cr {
			t.Errorf("range %q: %d %q %q", rng, res.StatusCode, body, res.Header.Get("Content-Range"))
		}
	}
	req, _ := http.NewRequest("GET", hs.URL, nil)
	req.Header.Set("Range", "bytes=0-1,10-11")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 206 || !strings.HasPrefix(res.Header.Get("Content-Type"), "multipart/byteranges") ||
		!strings.Contains(string(body), "\r\n\r\n01\r\n") || !strings.Contains(string(body), "\r\n\r\nab\r\n") {
		t.Fatalf("multi-range: %d %s %q", res.StatusCode, res.Header.Get("Content-Type"), body)
	}

	// Unknown size: small (one PUT) and > 16 MiB (multipart).
	if err := s.Put(ctx, "p/r/small.txt", strings.NewReader("tiny"), -1, ""); err != nil {
		t.Fatal(err)
	}
	if oi, err := s.client.StatObject(ctx, s.bucket, s.prefix+"/p/r/small.txt", minio.StatObjectOptions{}); err != nil || oi.Size != 4 || oi.ContentType != DefaultMIME {
		t.Fatalf("small: %+v %v", oi, err)
	}
	big := bytes.Repeat([]byte("0123456789abcdef"), (s3SmallObject+3<<20)/16) // 19 MiB
	if err := s.Put(ctx, "p/r/big.webm", bytes.NewReader(big), -1, "video/webm"); err != nil {
		t.Fatal(err)
	}
	f, info, err = s.Open(ctx, "p/r/big.webm")
	if err != nil || info.Size != int64(len(big)) {
		t.Fatalf("big: %+v %v", info, err)
	}
	if _, err := f.Seek(int64(len(big))-16-5, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	tail, _ := io.ReadAll(f)
	f.Close()
	if string(tail) != "bcdef0123456789abcdef" {
		t.Fatalf("big tail %q", tail)
	}

	// Size mismatch (short and long source) leaves nothing behind.
	if err := s.Put(ctx, "p/r/short.png", strings.NewReader("abc"), 10, ""); err == nil {
		t.Fatal("short source accepted")
	}
	if err := s.Put(ctx, "p/r/long.png", strings.NewReader("abcdef"), 3, ""); err == nil {
		t.Fatal("long source accepted")
	}
	for _, k := range []string{"p/r/short.png", "p/r/long.png"} {
		if _, err := s.Stat(ctx, k); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s left behind: %v", k, err)
		}
	}

	// Invalid keys are rejected before any request.
	for _, bad := range []string{"", "/etc/passwd", "../x", "a/../../x", "a//b", `a\b`} {
		if err := s.Put(ctx, bad, strings.NewReader("x"), -1, ""); err == nil {
			t.Errorf("key %q accepted", bad)
		}
	}

	// Missing objects and delete.
	if _, _, err := s.Open(ctx, "p/r/nope.png"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("open missing: %v", err)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("double delete: %v", err)
	}
	if _, err := s.Stat(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stat deleted: %v", err)
	}
	// No probe objects left by Verify.
	for _, k := range keys() {
		if strings.Contains(k, ".qatlas-probe") {
			t.Fatalf("probe object left: %s", k)
		}
	}
}

// rangeRecorder records the Range header of every GET sent to S3.
type rangeRecorder struct {
	mu     sync.Mutex
	ranges []string
}

func (rr *rangeRecorder) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method == http.MethodGet && req.URL.RawQuery == "" {
		rr.mu.Lock()
		rr.ranges = append(rr.ranges, req.Header.Get("Range"))
		rr.mu.Unlock()
	}
	return http.DefaultTransport.RoundTrip(req)
}

func (rr *rangeRecorder) take() []string {
	rr.mu.Lock()
	defer rr.mu.Unlock()
	r := rr.ranges
	rr.ranges = nil
	return r
}

// Downloads are ranged GETs of at most readChunk bytes from the requested offset.
func TestS3RangedGets(t *testing.T) {
	ctx := context.Background()
	rec := &rangeRecorder{}
	s, err := newS3Store(s3test.Config(t), rec)
	if err != nil {
		t.Fatal(err)
	}
	s.readChunk = 7
	content := "0123456789abcdefghij"
	if err := s.Put(ctx, "p/r/v.webm", strings.NewReader(content), 20, "video/webm"); err != nil {
		t.Fatal(err)
	}
	hs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f, info, err := s.Open(r.Context(), "p/r/v.webm")
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer f.Close()
		http.ServeContent(w, r, "v.webm", info.ModTime, f)
	}))
	defer hs.Close()
	get := func(rng string) (int, string) {
		req, _ := http.NewRequest("GET", hs.URL, nil)
		if rng != "" {
			req.Header.Set("Range", rng)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	rec.take()
	if st, body := get(""); st != 200 || body != content {
		t.Fatalf("full: %d %q", st, body)
	}
	if got := strings.Join(rec.take(), ","); got != "bytes=0-6,bytes=7-13,bytes=14-19" {
		t.Fatalf("full download GETs: %s", got)
	}
	if st, body := get("bytes=5-9"); st != 206 || body != "56789" {
		t.Fatalf("range: %d %q", st, body)
	}
	if got := strings.Join(rec.take(), ","); got != "bytes=5-11" {
		t.Fatalf("range GETs: %s", got)
	}
	if st, _ := get("bytes=30-"); st != 416 {
		t.Fatalf("unsatisfiable: %d", st)
	}
	if got := rec.take(); len(got) != 0 {
		t.Fatalf("416 issued GETs: %v", got)
	}
	req, _ := http.NewRequest("HEAD", hs.URL, nil)
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != 200 || res.ContentLength != 20 {
		t.Fatalf("HEAD: %v %v", res, err)
	}
	if got := rec.take(); len(got) != 0 {
		t.Fatalf("HEAD issued GETs: %v", got)
	}
}

func TestS3VerifyFailures(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cfg := s3test.Config(t)

	missing := cfg
	missing.Bucket = "qatlas-no-such-bucket"
	s, err := NewS3Store(missing)
	if err != nil {
		t.Fatal(err)
	}
	err = Verify(ctx, s)
	t.Logf("missing bucket: %v", err)
	if err == nil || !strings.Contains(err.Error(), "bucket does not exist") || !strings.Contains(err.Error(), missing.Bucket) {
		t.Fatalf("missing bucket: %v", err)
	}

	wrong := cfg
	wrong.SecretKey = strings.Repeat("0", 64)
	s, err = NewS3Store(wrong)
	if err != nil {
		t.Fatal(err)
	}
	err = Verify(ctx, s)
	t.Logf("wrong secret: %v", err)
	if err == nil || strings.Contains(err.Error(), wrong.SecretKey) || strings.Contains(err.Error(), cfg.SecretKey) {
		t.Fatalf("wrong secret: %v", err)
	}

	bad := cfg
	bad.Bucket = ""
	if _, err := NewS3Store(bad); err == nil || !strings.Contains(err.Error(), "QATLAS_S3_BUCKET") {
		t.Fatalf("incomplete config: %v", err)
	}
}

// fixture inserts a user, project and run for artifact rows.
func artifactFixture(t *testing.T, ctx context.Context, q db.Querier) (projectID, runID uuid.UUID) {
	t.Helper()
	user, tc := db.NewID(), db.NewID()
	projectID, runID = db.NewID(), db.NewID()
	for _, stmt := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, email, name) VALUES ($1, 'a@example.com', 'A')`, []any{user}},
		{`INSERT INTO projects (id, key, name, artifact_retention_days) VALUES ($1, 'SHOP', 'Shop', 30)`, []any{projectID}},
		{`INSERT INTO test_cases (id, project_id, seq, title) VALUES ($1, $2, 1, 'T')`, []any{tc, projectID}},
		{`INSERT INTO runs (id, project_id, seq, kind, test_case_id, target_key, target_title, triggered_by, options)
		  VALUES ($1, $2, 1, 'test_case', $3, 'SHOP-T1', 'T', $4, '{}')`, []any{runID, projectID, tc, user}},
	} {
		if _, err := q.Exec(ctx, stmt.sql, stmt.args...); err != nil {
			t.Fatalf("fixture: %v", err)
		}
	}
	return projectID, runID
}

func TestS3MigrateCheckAndPurge(t *testing.T) {
	pool := testutil.DB(t)
	ctx := context.Background()
	s3s, keys := newS3(t)
	local, err := NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	set := StoreSet{Active: "local", Local: local, S3: s3s}
	projectID, runID := artifactFixture(t, ctx, pool)

	save := func(name, mime, body string) Artifact {
		a, err := SaveWith(ctx, pool, set, Meta{ProjectID: projectID, RunID: runID, Kind: KindScreenshot, Name: name, MIME: mime},
			strings.NewReader(body), int64(len(body)))
		if err != nil || a.Storage != "local" {
			t.Fatalf("save: %+v %v", a, err)
		}
		return a
	}
	backendOf := func(a Artifact) string {
		var b string
		if err := pool.QueryRow(ctx, `SELECT storage FROM artifacts WHERE id = $1`, a.ID).Scan(&b); err != nil {
			t.Fatal(err)
		}
		return b
	}
	shot := save("shot.png", "image/png", "png-bytes")
	video := save("run.webm", "video/webm", strings.Repeat("v", 5000))
	gone := save("gone.txt", "text/plain", "lost")
	expired := save("old.png", "image/png", "old")
	if _, err := pool.Exec(ctx, `UPDATE artifacts SET purged_at = now() WHERE id = $1`, expired.ID); err != nil {
		t.Fatal(err)
	}
	keyOf := func(a Artifact) string { return StorageKey(projectID, runID, a.ID, a.Name) }
	if err := local.Delete(ctx, keyOf(gone)); err != nil {
		t.Fatal(err)
	}

	// Dry run writes nothing and switches no row.
	var out bytes.Buffer
	res, err := Migrate(ctx, pool, local, s3s, MigrateOptions{DryRun: true, Out: &out})
	if err != nil || res.Total != 3 || res.Copied != 2 || res.Missing != 1 || res.Bytes != 5009 || len(keys()) != 0 || backendOf(shot) != "local" {
		t.Fatalf("dry run: %+v %v keys=%v\n%s", res, err, keys(), out.String())
	}
	if !strings.Contains(out.String(), "would copy "+keyOf(shot)) || !strings.Contains(out.String(), "MISSING "+keyOf(gone)) {
		t.Fatalf("dry run output:\n%s", out.String())
	}

	// Check visits every row in its own store: only the lost file is missing.
	out.Reset()
	cres, err := Check(ctx, pool, set, "", &out)
	if err != nil || cres.Total != 3 || cres.OK != 2 || cres.Missing != 1 || !strings.Contains(out.String(), gone.ID.String()) {
		t.Fatalf("check before: %+v %v\n%s", cres, err, out.String())
	}
	if cres, err := Check(ctx, pool, set, "s3", nil); err != nil || cres.Total != 0 {
		t.Fatalf("check s3 before: %+v %v", cres, err)
	}

	// Real run copies with content type and switches the copied rows; local files stay.
	out.Reset()
	var progress []MigrateResult
	res, err = Migrate(ctx, pool, local, s3s, MigrateOptions{Out: &out, Progress: func(r MigrateResult) { progress = append(progress, r) }})
	if err != nil || res.Copied != 2 || res.Skipped != 0 || res.Missing != 1 || res.Deleted != 0 || len(progress) != 3 || progress[2].Moved() != 2 {
		t.Fatalf("migrate: %+v %v %+v\n%s", res, err, progress, out.String())
	}
	if !strings.Contains(out.String(), "[3/3] progress: 2 copied, 0 skipped, 1 missing, 0 failed") {
		t.Fatalf("progress output:\n%s", out.String())
	}
	if backendOf(shot) != "s3" || backendOf(video) != "s3" || backendOf(gone) != "local" || backendOf(expired) != "local" {
		t.Fatalf("rows: %s %s %s %s", backendOf(shot), backendOf(video), backendOf(gone), backendOf(expired))
	}
	oi, err := s3s.client.StatObject(ctx, s3s.bucket, s3s.prefix+"/"+keyOf(video), minio.StatObjectOptions{})
	if err != nil || oi.ContentType != "video/webm" || oi.Size != 5000 {
		t.Fatalf("migrated video: %+v %v", oi, err)
	}
	if _, err := local.Stat(ctx, keyOf(shot)); err != nil {
		t.Fatalf("local file removed without --delete-local: %v", err)
	}

	// Re-run: only the lost row is still on local; --delete-local also removes
	// the sources left behind by the first run.
	res, err = Migrate(ctx, pool, local, s3s, MigrateOptions{DeleteSource: true})
	if err != nil || res.Total != 1 || res.Copied != 0 || res.Missing != 1 || res.Deleted != 2 {
		t.Fatalf("re-run: %+v %v", res, err)
	}
	if _, err := local.Stat(ctx, keyOf(shot)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("local file kept with --delete-local: %v", err)
	}
	if res, err = Migrate(ctx, pool, local, s3s, MigrateOptions{DeleteSource: true}); err != nil || res.Deleted != 0 || res.Missing != 1 {
		t.Fatalf("after delete: %+v %v", res, err)
	}

	// A different-size object in the destination is replaced.
	if _, err := pool.Exec(ctx, `UPDATE artifacts SET storage = 'local' WHERE id = $1`, shot.ID); err != nil {
		t.Fatal(err)
	}
	if err := s3s.Put(ctx, keyOf(shot), strings.NewReader("stale"), 5, "image/png"); err != nil {
		t.Fatal(err)
	}
	if err := local.Put(ctx, keyOf(shot), strings.NewReader("png-bytes"), 9, ""); err != nil {
		t.Fatal(err)
	}
	if res, err := Migrate(ctx, pool, local, s3s, MigrateOptions{}); err != nil || res.Copied != 1 || backendOf(shot) != "s3" {
		t.Fatalf("replace: %+v %v", res, err)
	}
	if info, _ := s3s.Stat(ctx, keyOf(shot)); info.Size != 9 {
		t.Fatalf("not replaced: %+v", info)
	}

	// Already in the destination but missing in the source: the row is just switched.
	if _, err := pool.Exec(ctx, `UPDATE artifacts SET storage = 'local' WHERE id = $1`, video.ID); err != nil {
		t.Fatal(err)
	}
	if res, err := Migrate(ctx, pool, local, s3s, MigrateOptions{}); err != nil || res.Skipped != 1 || backendOf(video) != "s3" {
		t.Fatalf("already moved: %+v %v", res, err)
	}

	// Check: size mismatches and rows on an unconfigured backend are reported.
	if _, err := pool.Exec(ctx, `UPDATE artifacts SET size_bytes = 1 WHERE id = $1`, shot.ID); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if cres, _ = Check(ctx, pool, set, "", &out); cres.Mismatch != 1 || cres.OK != 1 || cres.Missing != 1 {
		t.Fatalf("mismatch not reported: %+v\n%s", cres, out.String())
	}
	if cres, _ = Check(ctx, pool, Single(local), "", nil); cres.Unavailable != 2 {
		t.Fatalf("unconfigured backend not reported: %+v", cres)
	}
	if _, err := pool.Exec(ctx, `UPDATE artifacts SET size_bytes = 9 WHERE id = $1`, shot.ID); err != nil {
		t.Fatal(err)
	}

	// Reverse direction works too (s3 → local), rows follow.
	local2, _ := NewLocalStore(t.TempDir())
	if res, err := Migrate(ctx, pool, s3s, local2, MigrateOptions{}); err != nil || res.Copied != 2 || backendOf(video) != "local" {
		t.Fatalf("s3 → local: %+v %v", res, err)
	}
	if f, _, err := local2.Open(ctx, keyOf(video)); err != nil {
		t.Fatal(err)
	} else {
		b, _ := io.ReadAll(f)
		f.Close()
		if len(b) != 5000 {
			t.Fatalf("s3 → local content %d bytes", len(b))
		}
	}
	if _, err := Migrate(ctx, pool, local2, local, MigrateOptions{}); err == nil {
		t.Fatal("local → local accepted")
	}

	// Purge deletes each object from its row's store; rows on a backend that is
	// not configured are left alone.
	set2 := StoreSet{Active: "local", Local: local2, S3: s3s}
	stray := save("stray.png", "image/png", "x")
	if _, err := pool.Exec(ctx, `UPDATE artifacts SET storage = 's3' WHERE id = $1`, stray.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE artifacts SET created_at = now() - interval '31 days'`); err != nil {
		t.Fatal(err)
	}
	n, err := Purge(ctx, pool, Single(local2), time.Now(), nil)
	if err != nil || n != 3 {
		t.Fatalf("purge local rows: %d %v", n, err)
	}
	if _, err := local2.Stat(ctx, keyOf(video)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("local object left after purge: %v", err)
	}
	if n, err := Purge(ctx, pool, set2, time.Now(), nil); err != nil || n != 1 {
		t.Fatalf("purge s3 row: %d %v", n, err)
	}
	var left int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM artifacts WHERE purged_at IS NULL`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("unpurged rows %d %v", left, err)
	}
	if res, err := Migrate(ctx, pool, local, s3s, MigrateOptions{}); err != nil || res.Total != 0 {
		t.Fatalf("migrate after purge: %+v %v", res, err)
	}
}

// SaveWith uploads with the right content type and records the size for unknown-size bodies.
func TestS3SaveWithUnknownSize(t *testing.T) {
	pool := testutil.DB(t)
	ctx := context.Background()
	s, keys := newS3(t)
	projectID, runID := artifactFixture(t, ctx, pool)
	body := strings.Repeat("x", 1234)
	a, err := SaveWith(ctx, pool, Single(s), Meta{ProjectID: projectID, RunID: runID, Kind: KindAttachment, Name: "notes.txt", MIME: "text/plain"}, strings.NewReader(body), -1)
	if err != nil || a.SizeBytes != 1234 || a.Storage != "s3" {
		t.Fatalf("save: %+v %v", a, err)
	}
	oi, err := s.client.StatObject(ctx, s.bucket, s.prefix+"/"+StorageKey(projectID, runID, a.ID, a.Name), minio.StatObjectOptions{})
	if err != nil || oi.ContentType != "text/plain" || oi.Size != 1234 {
		t.Fatalf("object: %+v %v", oi, err)
	}
	// A failing INSERT removes the uploaded object again.
	_, err = SaveWith(ctx, pool, Single(s), Meta{ProjectID: db.NewID(), RunID: runID, Kind: KindAttachment, Name: "x.txt"}, strings.NewReader("x"), -1)
	if err == nil {
		t.Fatal("insert for unknown project succeeded")
	}
	if got := keys(); len(got) != 1 {
		t.Fatalf("orphan object kept: %v", got)
	}
}

// Probe reports connect / bucket / write / read / delete separately and never
// leaves its probe object behind.
func TestProbe(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	names := func(cs []ProbeCheck) string {
		var b strings.Builder
		for _, c := range cs {
			fmt.Fprintf(&b, "%s=%v ", c.Name, c.OK)
		}
		return strings.TrimSpace(b.String())
	}

	local, _ := NewLocalStore(t.TempDir())
	if cs := Probe(ctx, local); names(cs) != "connect=true bucket=true write=true read=true delete=true" || ProbeError(cs) != nil {
		t.Fatalf("local: %+v", cs)
	}

	cfg := s3test.Config(t)
	good, err := NewS3Store(cfg, WithMaxRetries(1))
	if err != nil {
		t.Fatal(err)
	}
	if cs := Probe(ctx, good); names(cs) != "connect=true bucket=true write=true read=true delete=true" {
		t.Fatalf("s3: %+v", cs)
	}
	if keys := s3test.Keys(t, cfg); len(keys) != 0 {
		t.Fatalf("probe object left: %v", keys)
	}

	missing := cfg
	missing.Bucket = "qatlas-probe-missing"
	s, _ := NewS3Store(missing, WithMaxRetries(1))
	cs := Probe(ctx, s)
	if names(cs) != "connect=true bucket=false write=false read=false delete=false" ||
		!strings.Contains(cs[1].Message, "does not exist") || !strings.Contains(cs[2].Message, "Skipped") {
		t.Fatalf("missing bucket: %+v", cs)
	}
	if err := ProbeError(cs); err == nil || !strings.HasPrefix(err.Error(), "bucket: ") {
		t.Fatalf("probe error: %v", err)
	}

	wrong := cfg
	wrong.SecretKey = strings.Repeat("0", 64)
	s, _ = NewS3Store(wrong, WithMaxRetries(1))
	cs = Probe(ctx, s)
	if names(cs) != "connect=true bucket=false write=false read=false delete=false" || strings.Contains(fmt.Sprint(cs), wrong.SecretKey) {
		t.Fatalf("wrong secret: %+v", cs)
	}

	down := cfg
	down.Endpoint = "http://127.0.0.1:1"
	s, _ = NewS3Store(down, WithMaxRetries(1))
	start := time.Now()
	cs = Probe(ctx, s)
	if names(cs) != "connect=false bucket=false write=false read=false delete=false" || !strings.Contains(cs[0].Message, "cannot reach") {
		t.Fatalf("unreachable: %+v", cs)
	}
	if d := time.Since(start); d > 15*time.Second {
		t.Fatalf("unreachable endpoint took %s", d)
	}
}
