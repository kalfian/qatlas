package auth

import (
	"slices"
	"strings"
	"testing"
)

func TestParseGoogleClientJSON(t *testing.T) {
	f, d := parseGoogleClientJSON(`{"web":{"client_id":" unittest.apps.googleusercontent.com ","project_id":"p","client_secret":"unit-test-secret",
		"redirect_uris":["https://q.example.com/api/v1/auth/google/callback","", "https://q.example.com/api/v1/auth/google/callback"],
		"javascript_origins":["https://q.example.com"]}}`)
	if d != nil || f.ClientID != "unittest.apps.googleusercontent.com" || f.ClientSecret != "unit-test-secret" || f.ProjectID != "p" ||
		!slices.Equal(f.RedirectURIs, []string{"https://q.example.com/api/v1/auth/google/callback"}) ||
		!slices.Equal(f.JavascriptOrigins, []string{"https://q.example.com"}) {
		t.Fatalf("web client: %+v %v", f, d)
	}
	for raw, want := range map[string]string{
		`not json`: "Not valid JSON",
		`null`:     "expected an object",
		`{"installed":{"client_id":"unittest.apps.googleusercontent.com","client_secret":"s"}}`: "Desktop app",
		`{"other":{}}`:                  `"web" section is missing`,
		`{"web":"x"}`:                   "malformed",
		`{"web":{"client_secret":"s"}}`: "client_id is missing",
		`{"web":{"client_id":"unittest.apps.googleusercontent.com"}}`:                                 "client_secret is missing",
		`{"web":{"client_id":"evil.apps.googleusercontent.com.attacker.io","client_secret":"s"}}`: ".apps.googleusercontent.com",
		`{"web":{"client_id":"unittest.apps.googleusercontent.com","client_secret":"has space"}}`:     "malformed",
	} {
		f, d := parseGoogleClientJSON(raw)
		if f != nil || len(d) == 0 || d[0].Path != "client_json" || !strings.Contains(d[0].Message, want) {
			t.Errorf("%s: %+v %+v", raw, f, d)
		}
	}
}

func TestNormalizeDomains(t *testing.T) {
	got, d := normalizeDomains([]string{" @Corp.IO", "corp.io.", "", "sub.example.co.uk", "xn--bcher-kva.example"})
	if d != nil || !slices.Equal(got, []string{"corp.io", "sub.example.co.uk", "xn--bcher-kva.example"}) {
		t.Fatalf("normalize: %v %v", got, d)
	}
	_, d = normalizeDomains([]string{"ok.io", "localhost", "-bad.io", "a..b", "1.2.3.4", "a_b.io", "x@y.io"})
	var paths []string
	for _, e := range d {
		paths = append(paths, e.Path)
	}
	if strings.Join(paths, ",") != "allowed_domains[1],allowed_domains[2],allowed_domains[3],allowed_domains[4],allowed_domains[5],allowed_domains[6]" {
		t.Fatalf("invalid domains: %v", paths)
	}
}

func TestBaseURLWarning(t *testing.T) {
	for base, warn := range map[string]bool{
		"https://qatlas.example.com": false,
		"http://localhost:5173":      false,
		"http://127.0.0.1:8090":      false,
		"http://[::1]:8090":          false,
		"http://qatlas.lan":          true,
		"http://localhost:8090":      true, // the default: probably not set
		"":                           true,
	} {
		if got := baseURLWarning(base) != ""; got != warn {
			t.Errorf("%q: warning=%v, want %v", base, got, warn)
		}
	}
}
