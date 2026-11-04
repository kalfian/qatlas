package testcases

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestResolveKeepsStepsVerbatimAndMerges(t *testing.T) {
	var in Input
	body := `{"title":"  T  ","folder_id":null,"steps":[{"id":"a","action":"goto","url":"/","zz":{"k":[1,2]}} , {"id":"b","action":"click","selector":"#x"}]}`
	if err := json.Unmarshal([]byte(body), &in); err != nil {
		t.Fatal(err)
	}
	base := defaultSnapshot()
	base.Priority = "high"
	s, errs := in.resolve(base)
	if len(errs) != 0 || s.Title != "T" || s.Priority != "high" || s.FolderID != nil {
		t.Fatalf("resolve: %+v %v", s, errs)
	}
	want := `[{"id":"a","action":"goto","url":"/","zz":{"k":[1,2]}},{"id":"b","action":"click","selector":"#x"}]`
	if string(s.Steps) != want {
		t.Fatalf("steps not verbatim:\n got %s\nwant %s", s.Steps, want)
	}
	if e, _ := validate(s); len(e) != 0 {
		t.Fatalf("valid snapshot rejected: %v", e)
	}
}

func TestValidateShapeAndEnums(t *testing.T) {
	var in Input
	_ = json.Unmarshal([]byte(`{"title":"x","execution":"robot","folder_id":"nope","steps":[1,{"id":"a","action":"goto","url":"/"},null]}`), &in)
	s, extra := in.resolve(defaultSnapshot())
	errs, _ := validate(s, extra...)
	var got []string
	for _, e := range errs {
		got = append(got, e.Path)
	}
	for _, p := range []string{"execution", "folder_id", "steps[0]", "steps[2]"} {
		if !slices.Contains(got, p) {
			t.Errorf("missing %s in %v", p, got)
		}
	}
	if slices.Contains(got, "steps[1].id") {
		t.Errorf("DSL check must be skipped when steps are malformed: %v", got)
	}
}
