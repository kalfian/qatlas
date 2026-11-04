package worker

import (
	"encoding/json"
	"sort"
	"strings"
)

// MaskText replaces secret values (docs/06 "Masking secret").
const MaskText = "••••"

// minSecretLen mirrors the runner: shorter values are not masked because masking one
// or two characters would shred every message (and such secrets are not secret anyway).
const minSecretLen = 3

// Masker hides resolved secret values in strings before they are persisted. It is the
// worker's second layer; the runner already masks its events.
type Masker struct {
	r *strings.Replacer
}

// NewMasker builds a masker for the given secret values (longest first, so a value that
// contains another one is masked whole).
func NewMasker(values []string) *Masker {
	seen := map[string]bool{}
	var vs []string
	for _, v := range values {
		if len(v) >= minSecretLen && !seen[v] {
			seen[v] = true
			vs = append(vs, v)
		}
	}
	if len(vs) == 0 {
		return &Masker{}
	}
	sort.Slice(vs, func(i, j int) bool { return len(vs[i]) > len(vs[j]) })
	pairs := make([]string, 0, 2*len(vs))
	for _, v := range vs {
		pairs = append(pairs, v, MaskText)
	}
	return &Masker{r: strings.NewReplacer(pairs...)}
}

// String masks one string.
func (m *Masker) String(s string) string {
	if m == nil || m.r == nil || s == "" {
		return s
	}
	return m.r.Replace(s)
}

// Ptr masks an optional string.
func (m *Masker) Ptr(s *string) *string {
	if s == nil {
		return nil
	}
	v := m.String(*s)
	return &v
}

// JSON masks every string (values and object keys) inside a JSON document. Invalid JSON
// is masked as raw text so nothing slips through.
func (m *Masker) JSON(raw json.RawMessage) json.RawMessage {
	if m == nil || m.r == nil || len(raw) == 0 {
		return raw
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return json.RawMessage(m.String(string(raw)))
	}
	out, err := json.Marshal(m.value(v))
	if err != nil {
		return json.RawMessage(m.String(string(raw)))
	}
	return out
}

func (m *Masker) value(v any) any {
	switch t := v.(type) {
	case string:
		return m.String(t)
	case []any:
		for i := range t {
			t[i] = m.value(t[i])
		}
		return t
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			out[m.String(k)] = m.value(x)
		}
		return out
	default:
		return v
	}
}
