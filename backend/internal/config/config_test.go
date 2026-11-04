package config

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
)

func envMap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := load(envMap(nil))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if c.HTTPAddr != ":8090" || c.BaseURL != DefaultBaseURL || c.WorkerConcurrency != 2 || c.RunnerCmd != DefaultRunnerCmd || c.RunTimeout != DefaultRunTimeout {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	if c.GoogleEnabled() || c.SecureCookies() {
		t.Fatal("google/secure cookies must be off by default")
	}
	if c.RequireDatabase() == nil || c.RequireMasterKey() == nil {
		t.Fatal("require checks must fail when unset")
	}
}

func TestLoadValid(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	c, err := load(envMap(map[string]string{
		"QATLAS_DATABASE_URL":    "postgres://x",
		"QATLAS_BASE_URL":        "https://qa.example.com/",
		"QATLAS_MASTER_KEY":      key,
		"GOOGLE_CLIENT_ID":       "id",
		"GOOGLE_CLIENT_SECRET":   "secret",
		"GOOGLE_ALLOWED_DOMAINS": " Example.com, @corp.io ,",
		"WORKER_CONCURRENCY":     "4",
		"QATLAS_RUN_TIMEOUT":     "30m",
		"QATLAS_LOG_LEVEL":       "debug",
	}))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if c.BaseURL != "https://qa.example.com" || !c.SecureCookies() || !c.GoogleEnabled() {
		t.Fatalf("unexpected: %+v", c)
	}
	if strings.Join(c.GoogleAllowedDomains, ",") != "example.com,corp.io" {
		t.Fatalf("domains: %v", c.GoogleAllowedDomains)
	}
	if len(c.MasterKey) != 32 || c.WorkerConcurrency != 4 || c.RunTimeout.String() != "30m0s" {
		t.Fatalf("unexpected: %+v", c)
	}
}

func TestLoadInvalid(t *testing.T) {
	cases := map[string]map[string]string{
		"short key":       {"QATLAS_MASTER_KEY": base64.StdEncoding.EncodeToString(make([]byte, 16))},
		"bad base64":      {"QATLAS_MASTER_KEY": "%%%"},
		"google half":     {"GOOGLE_CLIENT_ID": "id"},
		"bad base url":    {"QATLAS_BASE_URL": "qa.example.com"},
		"bad run timeout": {"QATLAS_RUN_TIMEOUT": "10s"},
		"bad concurrency": {"WORKER_CONCURRENCY": "0"},
		"bad web dir":     {"QATLAS_WEB_DIR": "/definitely/not/here"},
		"bad log level":   {"QATLAS_LOG_LEVEL": "loud"},
	}
	for name, env := range cases {
		if _, err := load(envMap(env)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func s3Env(extra map[string]string) map[string]string {
	m := map[string]string{
		"QATLAS_STORAGE":       "s3",
		"QATLAS_S3_ENDPOINT":   "https://garage.example.com/",
		"QATLAS_S3_REGION":     "garage",
		"QATLAS_S3_BUCKET":     "qatlas-artifacts",
		"QATLAS_S3_ACCESS_KEY": "GK0123456789abcdef01234567",
		"QATLAS_S3_SECRET_KEY": "topsecretvalue",
	}
	for k, v := range extra {
		if v == "" {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	return m
}

func TestLoadStorage(t *testing.T) {
	c, err := load(envMap(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Storage != StorageLocal || c.StorageFromEnv || c.S3.Region != DefaultS3Region || !c.S3.ForcePathStyle {
		t.Fatalf("storage defaults: %q %v %+v", c.Storage, c.StorageFromEnv, c.S3)
	}
	// Empty (docker-compose renders unset variables as "") is not an override.
	if c, err := load(envMap(map[string]string{"QATLAS_STORAGE": "  "})); err != nil || c.StorageFromEnv {
		t.Fatalf("empty QATLAS_STORAGE: %+v %v", c, err)
	}
	// An explicit QATLAS_STORAGE (even "local") is an environment override.
	if c, err := load(envMap(map[string]string{"QATLAS_STORAGE": "local"})); err != nil || !c.StorageFromEnv || c.Storage != StorageLocal {
		t.Fatalf("explicit local: %+v %v", c, err)
	}

	c, err = load(envMap(s3Env(map[string]string{"QATLAS_S3_PREFIX": "/qatlas/prod/", "QATLAS_STORAGE": "S3"})))
	if err != nil {
		t.Fatalf("s3: %v", err)
	}
	want := S3Config{Endpoint: "https://garage.example.com", Region: "garage", Bucket: "qatlas-artifacts",
		AccessKey: "GK0123456789abcdef01234567", SecretKey: "topsecretvalue", ForcePathStyle: true, Prefix: "qatlas/prod"}
	if c.Storage != StorageS3 || !c.StorageFromEnv || c.S3 != want {
		t.Fatalf("s3 config: %q %+v", c.Storage, c.S3)
	}
	if err := c.S3.Validate(); err != nil {
		t.Fatal(err)
	}
	c, err = load(envMap(s3Env(map[string]string{"QATLAS_S3_FORCE_PATH_STYLE": "false", "QATLAS_S3_REGION": ""})))
	if err != nil || c.S3.ForcePathStyle || c.S3.Region != DefaultS3Region {
		t.Fatalf("path style off / default region: %+v %v", c, err)
	}

	// The secret never shows up in formatted output.
	for _, s := range []string{fmt.Sprint(c.S3), fmt.Sprintf("%v %+v %#v %s", c, c.S3, c.S3, c.S3)} {
		if strings.Contains(s, "topsecretvalue") {
			t.Fatalf("secret printed: %s", s)
		}
	}

	// local storage with partial S3 settings is fine (migrate checks completeness later).
	c, err = load(envMap(map[string]string{"QATLAS_S3_ENDPOINT": "http://127.0.0.1:3900", "QATLAS_S3_BUCKET": "qatlas"}))
	if err != nil || c.Storage != StorageLocal {
		t.Fatalf("local + partial s3: %v", err)
	}
	if err := c.S3.Validate(); err == nil || !strings.Contains(err.Error(), "QATLAS_S3_ACCESS_KEY") || !strings.Contains(err.Error(), "QATLAS_S3_SECRET_KEY") {
		t.Fatalf("validate partial: %v", err)
	}
}

func TestLoadStorageInvalid(t *testing.T) {
	cases := map[string]struct {
		env  map[string]string
		want []string
	}{
		"unknown backend":    {map[string]string{"QATLAS_STORAGE": "gcs"}, []string{"QATLAS_STORAGE"}},
		"missing everything": {map[string]string{"QATLAS_STORAGE": "s3"}, []string{"QATLAS_S3_ENDPOINT", "QATLAS_S3_BUCKET", "QATLAS_S3_ACCESS_KEY", "QATLAS_S3_SECRET_KEY"}},
		"missing secret":     {s3Env(map[string]string{"QATLAS_S3_SECRET_KEY": ""}), []string{"QATLAS_S3_SECRET_KEY is required"}},
		"no scheme":          {s3Env(map[string]string{"QATLAS_S3_ENDPOINT": "garage.example.com"}), []string{"QATLAS_S3_ENDPOINT"}},
		"ftp scheme":         {s3Env(map[string]string{"QATLAS_S3_ENDPOINT": "ftp://garage.example.com"}), []string{"QATLAS_S3_ENDPOINT"}},
		"endpoint path":      {s3Env(map[string]string{"QATLAS_S3_ENDPOINT": "https://garage.example.com/qatlas"}), []string{"QATLAS_S3_ENDPOINT"}},
		"bad bucket":         {s3Env(map[string]string{"QATLAS_S3_BUCKET": "Bad_Bucket"}), []string{"QATLAS_S3_BUCKET"}},
		"short bucket":       {s3Env(map[string]string{"QATLAS_S3_BUCKET": "ab"}), []string{"QATLAS_S3_BUCKET"}},
		"bad path style":     {s3Env(map[string]string{"QATLAS_S3_FORCE_PATH_STYLE": "maybe"}), []string{"QATLAS_S3_FORCE_PATH_STYLE"}},
		"bad prefix":         {s3Env(map[string]string{"QATLAS_S3_PREFIX": "a/../b"}), []string{"QATLAS_S3_PREFIX"}},
		"local, bad s3 url":  {map[string]string{"QATLAS_S3_ENDPOINT": "nope"}, []string{"QATLAS_S3_ENDPOINT"}},
	}
	for name, tc := range cases {
		_, err := load(envMap(tc.env))
		if err == nil {
			t.Errorf("%s: expected error", name)
			continue
		}
		for _, w := range tc.want {
			if !strings.Contains(err.Error(), w) {
				t.Errorf("%s: error %q does not mention %q", name, err, w)
			}
		}
		if strings.Contains(err.Error(), "topsecretvalue") {
			t.Errorf("%s: secret in error: %v", name, err)
		}
	}
}
