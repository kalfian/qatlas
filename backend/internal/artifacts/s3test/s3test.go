// Package s3test provides a real S3 server for integration tests: a
// single-node Garage (dxflrs/garage) container started once per test binary,
// or an external bucket given by QATLAS_TEST_S3_* variables.
//
// Usage:
//
//	func TestMain(m *testing.M) { s3test.Main(m) } // removes the container afterwards
//
//	func TestSomething(t *testing.T) {
//		cfg := s3test.Config(t) // skips when neither Docker nor QATLAS_TEST_S3_ENDPOINT is available
//		store, _ := artifacts.NewS3Store(cfg)
//		...
//	}
//
// Every Config call gets its own key prefix, and the objects under it are
// removed when the test ends, so tests never see each other's objects.
package s3test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/kalfian/qatlas/backend/internal/config"
)

// Image is the Garage image used when no external S3 is configured.
const Image = "dxflrs/garage:v2.5.0"

// Bucket is the bucket created in the Garage container.
const Bucket = "qatlas-test"

// Region is the s3_region of the Garage container.
const Region = "garage"

var (
	once      sync.Once
	base      config.S3Config
	container string
	skipMsg   string
	setupErr  error
)

// Main runs the tests and removes the Garage container (if one was started).
func Main(m *testing.M) {
	code := m.Run()
	Cleanup()
	os.Exit(code)
}

// Cleanup removes the Garage container; safe to call more than once.
func Cleanup() {
	if container != "" {
		_ = exec.Command("docker", "rm", "-f", "-v", container).Run()
		container = ""
	}
}

// Config returns S3 settings with a fresh key prefix ("t-<random>"); objects
// under it are deleted when t ends. It skips t when no S3 server is available.
func Config(t testing.TB) config.S3Config {
	t.Helper()
	once.Do(setup)
	if skipMsg != "" {
		t.Skip(skipMsg)
	}
	if setupErr != nil {
		t.Fatalf("S3 test server: %v", setupErr)
	}
	cfg := base
	prefix := "t-" + randomHex(6)
	if cfg.Prefix != "" {
		prefix = cfg.Prefix + "/" + prefix
	}
	cfg.Prefix = prefix
	t.Cleanup(func() { removePrefix(t, cfg) })
	return cfg
}

func setup() {
	if ep := strings.TrimSpace(os.Getenv("QATLAS_TEST_S3_ENDPOINT")); ep != "" {
		base = config.S3Config{
			Endpoint:       strings.TrimRight(ep, "/"),
			Region:         envOr("QATLAS_TEST_S3_REGION", config.DefaultS3Region),
			Bucket:         os.Getenv("QATLAS_TEST_S3_BUCKET"),
			AccessKey:      os.Getenv("QATLAS_TEST_S3_ACCESS_KEY"),
			SecretKey:      os.Getenv("QATLAS_TEST_S3_SECRET_KEY"),
			ForcePathStyle: true,
			Prefix:         strings.Trim(envOr("QATLAS_TEST_S3_PREFIX", "qatlas-test"), "/"),
		}
		if v := os.Getenv("QATLAS_TEST_S3_FORCE_PATH_STYLE"); v != "" {
			base.ForcePathStyle, _ = strconv.ParseBool(v)
		}
		if err := base.Validate(); err != nil {
			setupErr = fmt.Errorf("QATLAS_TEST_S3_* incomplete: %w", err)
		}
		return
	}
	if _, err := exec.LookPath("docker"); err != nil {
		skipMsg = "S3 integration test skipped: docker not found (or set QATLAS_TEST_S3_ENDPOINT, _BUCKET, _ACCESS_KEY, _SECRET_KEY)"
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "docker", "info", "--format", "{{.ServerVersion}}").CombinedOutput(); err != nil {
		skipMsg = fmt.Sprintf("S3 integration test skipped: docker daemon not available (%s)", strings.TrimSpace(string(out)))
		return
	}
	setupErr = startGarage()
	if setupErr != nil {
		Cleanup()
	}
}

// startGarage runs a single-node Garage with one bucket and one key.
func startGarage() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute) // includes a first image pull
	defer cancel()

	dir, err := os.MkdirTemp("", "qatlas-garage-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	toml := filepath.Join(dir, "garage.toml")
	if err := os.WriteFile(toml, []byte(garageTOML(randomHex(32))), 0o600); err != nil {
		return err
	}

	name := "qatlas-test-garage-" + randomHex(5)
	if _, err := docker(ctx, "create", "--name", name, "--label", "qatlas-test=garage",
		"-p", "127.0.0.1::3900", Image); err != nil {
		return err
	}
	container = name
	if _, err := docker(ctx, "cp", toml, name+":/etc/garage.toml"); err != nil {
		return err
	}
	if _, err := docker(ctx, "start", name); err != nil {
		return err
	}

	// Node id (first 16 hex chars are enough for `layout assign`).
	var nodeID string
	if err := retry(ctx, 30*time.Second, func() error {
		out, err := docker(ctx, "exec", name, "/garage", "node", "id", "-q")
		if err != nil {
			return err
		}
		id, _, _ := strings.Cut(lastLine(out), "@")
		if len(id) < 16 {
			return fmt.Errorf("unexpected node id %q", out)
		}
		nodeID = id[:16]
		return nil
	}); err != nil {
		return fmt.Errorf("garage did not start: %w", err)
	}

	accessKey := "GK" + randomHex(12)
	secretKey := randomHex(32)
	for _, args := range [][]string{
		{"layout", "assign", "-z", "dc1", "-c", "1G", nodeID},
		{"layout", "apply", "--version", "1"},
		{"bucket", "create", Bucket},
		{"key", "import", "--yes", "-n", "qatlas-test", accessKey, secretKey},
		{"bucket", "allow", "--read", "--write", "--owner", Bucket, "--key", "qatlas-test"},
	} {
		if _, err := docker(ctx, append([]string{"exec", name, "/garage"}, args...)...); err != nil {
			return err
		}
	}

	out, err := docker(ctx, "port", name, "3900/tcp")
	if err != nil {
		return err
	}
	hostPort := strings.TrimSpace(strings.SplitN(out, "\n", 2)[0])
	base = config.S3Config{
		Endpoint:       "http://" + hostPort,
		Region:         Region,
		Bucket:         Bucket,
		AccessKey:      accessKey,
		SecretKey:      secretKey,
		ForcePathStyle: true,
	}
	client, err := newClient(base)
	if err != nil {
		return err
	}
	return retry(ctx, 30*time.Second, func() error {
		ok, err := client.BucketExists(ctx, Bucket)
		if err == nil && !ok {
			err = errors.New("bucket not visible yet")
		}
		return err
	})
}

func garageTOML(rpcSecret string) string {
	return `metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "` + rpcSecret + `"

[s3_api]
s3_region = "` + Region + `"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"
`
}

func docker(ctx context.Context, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("docker %s: %w: %s", args[0], err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func retry(ctx context.Context, max time.Duration, fn func() error) error {
	deadline := time.Now().Add(max)
	for {
		err := fn()
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return err
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func newClient(cfg config.S3Config) (*minio.Client, error) {
	host := strings.TrimPrefix(strings.TrimPrefix(cfg.Endpoint, "https://"), "http://")
	return minio.New(host, &minio.Options{
		Creds:        credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure:       strings.HasPrefix(cfg.Endpoint, "https://"),
		Region:       cfg.Region,
		BucketLookup: minio.BucketLookupPath,
	})
}

// Client returns a raw minio client for cfg (for assertions on the bucket).
func Client(t testing.TB, cfg config.S3Config) *minio.Client {
	t.Helper()
	c, err := newClient(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// Keys lists the object keys under cfg.Prefix (prefix included).
func Keys(t testing.TB, cfg config.S3Config) []string {
	t.Helper()
	var keys []string
	for obj := range Client(t, cfg).ListObjects(context.Background(), cfg.Bucket, minio.ListObjectsOptions{Prefix: cfg.Prefix + "/", Recursive: true}) {
		if obj.Err != nil {
			t.Fatalf("list objects: %v", obj.Err)
		}
		keys = append(keys, obj.Key)
	}
	return keys
}

func removePrefix(t testing.TB, cfg config.S3Config) {
	c, err := newClient(cfg)
	if err != nil {
		return
	}
	ctx := context.Background()
	for obj := range c.ListObjects(ctx, cfg.Bucket, minio.ListObjectsOptions{Prefix: cfg.Prefix + "/", Recursive: true}) {
		if obj.Err != nil {
			t.Logf("s3test cleanup: %v", obj.Err)
			return
		}
		_ = c.RemoveObject(ctx, cfg.Bucket, obj.Key, minio.RemoveObjectOptions{})
	}
}

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
