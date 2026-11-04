// Package config loads and validates QAtlas settings from environment variables.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the process configuration. Fields map 1:1 to the environment
// variables documented in backend/.env.example.
type Config struct {
	DatabaseURL string // QATLAS_DATABASE_URL
	HTTPAddr    string // QATLAS_HTTP_ADDR (default :8090)
	BaseURL     string // QATLAS_BASE_URL, no trailing slash (invite links, OAuth redirect)
	MasterKey   []byte // QATLAS_MASTER_KEY, base64 of exactly 32 bytes (nil when unset)
	DataDir     string // QATLAS_DATA_DIR (default ./data)
	WebDir      string // QATLAS_WEB_DIR, optional: serve the built SPA from here

	GoogleClientID       string   // GOOGLE_CLIENT_ID
	GoogleClientSecret   string   // GOOGLE_CLIENT_SECRET
	GoogleAllowedDomains []string // GOOGLE_ALLOWED_DOMAINS, comma separated, lowercased

	WorkerConcurrency int    // WORKER_CONCURRENCY (default 2)
	RunnerCmd         string // QATLAS_RUNNER_CMD (default "node runner/dist/main.js")
	// RunTimeout caps one automated execution of a run (QATLAS_RUN_TIMEOUT, Go
	// duration, default 15m, 1m..24h). Waiting for a manual case does not count.
	RunTimeout time.Duration

	// TrustProxy makes the server take the client IP from X-Forwarded-For /
	// X-Real-IP (QATLAS_TRUST_PROXY=true). Only enable behind a reverse proxy
	// that overwrites these headers, otherwise login rate limiting can be bypassed.
	TrustProxy bool
	LogLevel   slog.Level // QATLAS_LOG_LEVEL debug|info|warn|error (default info)

	// Storage selects the artifact store: "local" (QATLAS_DATA_DIR/artifacts, the
	// default) or "s3" (QATLAS_STORAGE).
	Storage string
	// StorageFromEnv is true when QATLAS_STORAGE is set in the environment: the
	// environment then overrides the storage settings stored in the database
	// (Admin → Storage becomes read-only). Unset, the database settings apply.
	StorageFromEnv bool
	// S3 configures the S3-compatible artifact store (QATLAS_S3_*). Required when
	// Storage is "s3"; also used by `qatlas artifacts migrate --to s3`.
	S3 S3Config
}

// S3Config is the S3-compatible artifact store (AWS S3, Garage, MinIO, …).
type S3Config struct {
	Endpoint       string // QATLAS_S3_ENDPOINT, absolute http(s) URL without path (e.g. https://garage.example.com)
	Region         string // QATLAS_S3_REGION (default us-east-1; Garage: the s3_region of garage.toml, usually "garage")
	Bucket         string // QATLAS_S3_BUCKET
	AccessKey      string // QATLAS_S3_ACCESS_KEY
	SecretKey      string // QATLAS_S3_SECRET_KEY — never logged
	ForcePathStyle bool   // QATLAS_S3_FORCE_PATH_STYLE (default true): https://host/bucket/key instead of https://bucket.host/key
	Prefix         string // QATLAS_S3_PREFIX, optional key prefix without leading/trailing slash (e.g. "qatlas")
}

// String renders the configuration without the secret key.
func (s S3Config) String() string {
	secret := ""
	if s.SecretKey != "" {
		secret = "[redacted]"
	}
	return fmt.Sprintf("{Endpoint:%s Region:%s Bucket:%s AccessKey:%s SecretKey:%s ForcePathStyle:%t Prefix:%s}",
		s.Endpoint, s.Region, s.Bucket, s.AccessKey, secret, s.ForcePathStyle, s.Prefix)
}

// GoString keeps %#v from printing the secret key too.
func (s S3Config) GoString() string { return "config.S3Config" + s.String() }

// Storage backends (QATLAS_STORAGE).
const (
	StorageLocal = "local"
	StorageS3    = "s3"
)

// Defaults.
const (
	DefaultHTTPAddr          = ":8090"
	DefaultBaseURL           = "http://localhost:8090"
	DefaultDataDir           = "./data"
	DefaultWorkerConcurrency = 2
	DefaultRunnerCmd         = "node runner/dist/main.js"
	DefaultRunTimeout        = 15 * time.Minute
	DefaultS3Region          = "us-east-1"
)

// Load reads the environment and validates every value that is set.
// Requirements that depend on the subcommand (database URL, master key) are
// checked separately with Require*.
func Load() (*Config, error) {
	return load(os.Getenv)
}

func load(getenv func(string) string) (*Config, error) {
	var errs []error
	get := func(k string) string { return strings.TrimSpace(getenv(k)) }

	c := &Config{
		DatabaseURL:        get("QATLAS_DATABASE_URL"),
		HTTPAddr:           orDefault(get("QATLAS_HTTP_ADDR"), DefaultHTTPAddr),
		BaseURL:            strings.TrimRight(orDefault(get("QATLAS_BASE_URL"), DefaultBaseURL), "/"),
		DataDir:            orDefault(get("QATLAS_DATA_DIR"), DefaultDataDir),
		WebDir:             get("QATLAS_WEB_DIR"),
		GoogleClientID:     get("GOOGLE_CLIENT_ID"),
		GoogleClientSecret: get("GOOGLE_CLIENT_SECRET"),
		WorkerConcurrency:  DefaultWorkerConcurrency,
		RunnerCmd:          orDefault(get("QATLAS_RUNNER_CMD"), DefaultRunnerCmd),
		RunTimeout:         DefaultRunTimeout,
		Storage:            strings.ToLower(orDefault(get("QATLAS_STORAGE"), StorageLocal)),
		StorageFromEnv:     get("QATLAS_STORAGE") != "",
		S3: S3Config{
			Endpoint:       strings.TrimRight(get("QATLAS_S3_ENDPOINT"), "/"),
			Region:         orDefault(get("QATLAS_S3_REGION"), DefaultS3Region),
			Bucket:         get("QATLAS_S3_BUCKET"),
			AccessKey:      get("QATLAS_S3_ACCESS_KEY"),
			SecretKey:      get("QATLAS_S3_SECRET_KEY"),
			ForcePathStyle: true,
			Prefix:         strings.Trim(get("QATLAS_S3_PREFIX"), "/"),
		},
	}

	if u, err := url.Parse(c.BaseURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		errs = append(errs, fmt.Errorf("QATLAS_BASE_URL must be an absolute http(s) URL, got %q", c.BaseURL))
	}

	if v := get("QATLAS_MASTER_KEY"); v != "" {
		key, err := base64.StdEncoding.DecodeString(v)
		if err != nil {
			errs = append(errs, errors.New("QATLAS_MASTER_KEY must be standard base64"))
		} else if len(key) != 32 {
			errs = append(errs, fmt.Errorf("QATLAS_MASTER_KEY must decode to 32 bytes, got %d", len(key)))
		} else {
			c.MasterKey = key
		}
	}

	if c.WebDir != "" {
		if st, err := os.Stat(c.WebDir); err != nil || !st.IsDir() {
			errs = append(errs, fmt.Errorf("QATLAS_WEB_DIR %q is not a directory", c.WebDir))
		}
	}

	if (c.GoogleClientID == "") != (c.GoogleClientSecret == "") {
		errs = append(errs, errors.New("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together"))
	}
	for _, d := range strings.Split(get("GOOGLE_ALLOWED_DOMAINS"), ",") {
		d = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(d), "@"))
		if d != "" {
			c.GoogleAllowedDomains = append(c.GoogleAllowedDomains, d)
		}
	}

	if v := get("WORKER_CONCURRENCY"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 64 {
			errs = append(errs, fmt.Errorf("WORKER_CONCURRENCY must be an integer 1..64, got %q", v))
		} else {
			c.WorkerConcurrency = n
		}
	}

	if v := get("QATLAS_RUN_TIMEOUT"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d < time.Minute || d > 24*time.Hour {
			errs = append(errs, fmt.Errorf("QATLAS_RUN_TIMEOUT must be a duration between 1m and 24h (e.g. 15m), got %q", v))
		} else {
			c.RunTimeout = d
		}
	}

	if v := get("QATLAS_TRUST_PROXY"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("QATLAS_TRUST_PROXY must be a boolean, got %q", v))
		}
		c.TrustProxy = b
	}

	if v := get("QATLAS_LOG_LEVEL"); v != "" {
		if err := c.LogLevel.UnmarshalText([]byte(v)); err != nil {
			errs = append(errs, fmt.Errorf("QATLAS_LOG_LEVEL must be debug|info|warn|error, got %q", v))
		}
	}

	if v := get("QATLAS_S3_FORCE_PATH_STYLE"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("QATLAS_S3_FORCE_PATH_STYLE must be a boolean, got %q", v))
		} else {
			c.S3.ForcePathStyle = b
		}
	}
	switch c.Storage {
	case StorageLocal:
		// S3 settings may be present (e.g. for `qatlas artifacts migrate`): check
		// the ones that are set, completeness only when they are needed.
		errs = append(errs, c.S3.formatErrors()...)
	case StorageS3:
		if err := c.S3.Validate(); err != nil {
			errs = append(errs, err)
		}
	default:
		errs = append(errs, fmt.Errorf("QATLAS_STORAGE must be local or s3, got %q", c.Storage))
	}

	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return c, nil
}

// Validate reports every missing or malformed S3 setting (one error per
// variable; values of secrets are never included).
func (s S3Config) Validate() error {
	var errs []error
	for _, req := range []struct{ name, value string }{
		{"QATLAS_S3_ENDPOINT", s.Endpoint},
		{"QATLAS_S3_BUCKET", s.Bucket},
		{"QATLAS_S3_ACCESS_KEY", s.AccessKey},
		{"QATLAS_S3_SECRET_KEY", s.SecretKey},
	} {
		if req.value == "" {
			errs = append(errs, fmt.Errorf("%s is required for S3 artifact storage", req.name))
		}
	}
	errs = append(errs, s.formatErrors()...)
	return errors.Join(errs...)
}

// formatErrors checks the S3 settings that are set.
func (s S3Config) formatErrors() []error {
	var errs []error
	if s.Endpoint != "" {
		u, err := url.Parse(s.Endpoint)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
			(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.User != nil {
			errs = append(errs, fmt.Errorf("QATLAS_S3_ENDPOINT must be an http(s) URL with scheme and host only (e.g. https://garage.example.com), got %q", s.Endpoint))
		}
	}
	if s.Bucket != "" && !validBucket(s.Bucket) {
		errs = append(errs, fmt.Errorf("QATLAS_S3_BUCKET %q is not a valid bucket name (3-63 characters: a-z, 0-9, '.', '-')", s.Bucket))
	}
	if s.Prefix != "" {
		for _, seg := range strings.Split(s.Prefix, "/") {
			if seg == "" || seg == "." || seg == ".." || strings.ContainsAny(seg, "\\\x00") {
				errs = append(errs, fmt.Errorf("QATLAS_S3_PREFIX %q must be slash-separated names without empty, '.' or '..' segments", s.Prefix))
				break
			}
		}
	}
	return errs
}

// ValidBucketName applies the S3 bucket naming rules (3-63 characters: a-z,
// 0-9, '.', '-'; no leading/trailing '.'/'-', no "..").
func ValidBucketName(b string) bool { return validBucket(b) }

// validBucket applies the S3 bucket naming rules.
func validBucket(b string) bool {
	if len(b) < 3 || len(b) > 63 {
		return false
	}
	for i, r := range b {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || ((r == '.' || r == '-') && i > 0 && i < len(b)-1)
		if !ok {
			return false
		}
	}
	return !strings.Contains(b, "..")
}

// RequireDatabase reports an error when QATLAS_DATABASE_URL is missing.
func (c *Config) RequireDatabase() error {
	if c.DatabaseURL == "" {
		return errors.New("QATLAS_DATABASE_URL is required")
	}
	return nil
}

// RequireMasterKey reports an error when QATLAS_MASTER_KEY is missing.
func (c *Config) RequireMasterKey() error {
	if c.MasterKey == nil {
		return errors.New("QATLAS_MASTER_KEY is required (base64 of 32 random bytes: openssl rand -base64 32)")
	}
	return nil
}

// GoogleEnabled reports whether Google sign-in is configured.
func (c *Config) GoogleEnabled() bool {
	return c.GoogleClientID != "" && c.GoogleClientSecret != ""
}

// SecureCookies reports whether cookies must carry the Secure attribute.
func (c *Config) SecureCookies() bool {
	return strings.HasPrefix(c.BaseURL, "https://")
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}
