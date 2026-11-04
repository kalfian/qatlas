package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/minio/minio-go/v7"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/artifacts/s3test"
)

func TestMain(m *testing.M) { s3test.Main(m) }

// The attachment flow (multipart upload, download with RBAC + Range 206 through
// GET /artifacts/{id}, retention purge) against a real S3 server (Garage).
func TestManualAttachmentsAndArtifactsS3(t *testing.T) {
	cfg := s3test.Config(t)
	store, err := artifacts.NewS3Store(cfg)
	if err != nil {
		t.Fatal(err)
	}
	f := rnSetup(t, func(d *Deps) { d.ArtifactStore = store })
	client := s3test.Client(t, cfg)
	testAttachmentsAndArtifacts(t, f, func(a artifacts.Artifact, purged bool) {
		keys := s3test.Keys(t, cfg)
		if purged {
			if len(keys) != 0 {
				t.Fatalf("objects left after purge: %v", keys)
			}
			return
		}
		if len(keys) != 1 || !strings.HasSuffix(keys[0], "/"+a.ID.String()+".txt") || !strings.HasPrefix(keys[0], cfg.Prefix+"/") {
			t.Fatalf("object keys %v", keys)
		}
		oi, err := client.StatObject(context.Background(), cfg.Bucket, keys[0], minio.StatObjectOptions{})
		if err != nil || oi.ContentType != a.MIME || oi.Size != a.SizeBytes {
			t.Fatalf("object %+v (artifact mime %q) %v", oi, a.MIME, err)
		}
	})
}

func TestReadyzStorage(t *testing.T) {
	e := newEnv(t)
	c := e.browser()
	r := c.getRange("/readyz", "")
	var body map[string]string
	_ = json.Unmarshal(r.body, &body)
	if r.status != 200 || body["storage"] != "ok" || body["storage_backend"] != "local" || body["database"] != "ok" {
		t.Fatalf("local readyz: %d %s", r.status, r.body)
	}

	cfg := s3test.Config(t)
	good, err := artifacts.NewS3Store(cfg)
	if err != nil {
		t.Fatal(err)
	}
	e = newEnv(t, func(d *Deps) { d.ArtifactStore = good })
	r = e.browser().getRange("/readyz", "")
	body = nil
	_ = json.Unmarshal(r.body, &body)
	if r.status != 200 || body["storage"] != "ok" || body["storage_backend"] != "s3" {
		t.Fatalf("s3 readyz: %d %s", r.status, r.body)
	}

	cfg.Bucket = "qatlas-readyz-missing"
	bad, err := artifacts.NewS3Store(cfg)
	if err != nil {
		t.Fatal(err)
	}
	e = newEnv(t, func(d *Deps) { d.ArtifactStore = bad })
	r = e.browser().getRange("/readyz", "")
	body = nil
	_ = json.Unmarshal(r.body, &body)
	if r.status != 503 || body["status"] != "unavailable" || body["storage"] != "error" || body["database"] != "ok" ||
		body["error"] != "artifact storage unreachable" || strings.Contains(string(r.body), cfg.Bucket) {
		t.Fatalf("broken s3 readyz: %d %s", r.status, r.body)
	}
}
