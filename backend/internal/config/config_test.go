package config

import (
	"encoding/base64"
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
