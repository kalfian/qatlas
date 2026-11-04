package testcases

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Folder is the OpenAPI Folder schema. TestCaseCount counts the non-deleted
// test cases directly in the folder (not in sub-folders), like the mock.
type Folder struct {
	ID            uuid.UUID  `json:"id"`
	ParentID      *uuid.UUID `json:"parent_id"`
	Name          string     `json:"name"`
	Position      int        `json:"position"`
	TestCaseCount int        `json:"test_case_count"`
}

// TagCount is one entry of GET /projects/{key}/tags.
type TagCount struct {
	Tag   string `json:"tag"`
	Count int    `json:"count"`
}

// Summary is the OpenAPI TestCaseSummary schema.
type Summary struct {
	ID            uuid.UUID    `json:"id"`
	Key           string       `json:"key"`
	FolderID      *uuid.UUID   `json:"folder_id"`
	Title         string       `json:"title"`
	Priority      string       `json:"priority"`
	Status        string       `json:"status"`
	Execution     string       `json:"execution"`
	Tags          []string     `json:"tags"`
	StepCount     int          `json:"step_count"`
	Revision      int          `json:"revision"`
	LastRunStatus *string      `json:"last_run_status"`
	LastRunAt     *time.Time   `json:"last_run_at"`
	UpdatedAt     time.Time    `json:"updated_at"`
	UpdatedBy     auth.UserRef `json:"updated_by"`
}

// TestCase is the OpenAPI TestCase schema. Variables and Steps are the stored
// jsonb verbatim (unknown step fields survive).
type TestCase struct {
	Summary
	ProjectKey    string          `json:"project_key"`
	Description   string          `json:"description"`
	Preconditions string          `json:"preconditions"`
	Variables     json.RawMessage `json:"variables"`
	Steps         json.RawMessage `json:"steps"`
	CreatedAt     time.Time       `json:"created_at"`
	CreatedBy     auth.UserRef    `json:"created_by"`
}

// Input is the OpenAPI TestCaseInput. Pointers distinguish "absent" from a
// value; JSON null is treated as absent (the mock's `??`), except folder_id
// where null means "root".
type Input struct {
	FolderID      httpx.Optional[string] `json:"folder_id"`
	Title         *string                `json:"title"`
	Description   *string                `json:"description"`
	Preconditions *string                `json:"preconditions"`
	Priority      *string                `json:"priority"`
	Status        *string                `json:"status"`
	Execution     *string                `json:"execution"`
	Tags          *[]string              `json:"tags"`
	Variables     *map[string]string     `json:"variables"`
	Steps         *[]json.RawMessage     `json:"steps"`
}

// UpdateInput is the PATCH /test-cases/{caseKey} body.
type UpdateInput struct {
	Input
	Revision   *int    `json:"revision"`
	ChangeNote *string `json:"change_note"`
}

// ValidationResult is the OpenAPI ValidationResult schema.
type ValidationResult struct {
	Valid    bool               `json:"valid"`
	Errors   []httpx.FieldError `json:"errors"`
	Warnings []httpx.FieldError `json:"warnings"`
}

// BulkInput is the OpenAPI BulkTestCaseAction schema.
type BulkInput struct {
	IDs      []string               `json:"ids"`
	Action   string                 `json:"action"`
	FolderID httpx.Optional[string] `json:"folder_id"`
	Status   *string                `json:"status"`
	Tags     []string               `json:"tags"`
}

// BulkResult is the bulk response {"updated": n}.
type BulkResult struct {
	Updated int `json:"updated"`
}

// RevisionSummary is the OpenAPI RevisionSummary schema.
type RevisionSummary struct {
	Revision   int          `json:"revision"`
	Author     auth.UserRef `json:"author"`
	ChangeNote string       `json:"change_note"`
	CreatedAt  time.Time    `json:"created_at"`
}

// Revision is the OpenAPI Revision schema (snapshot = TestCaseInput).
type Revision struct {
	RevisionSummary
	Snapshot json.RawMessage `json:"snapshot"`
}

// Snapshot is the stored TestCaseInput of a revision (test_case_revisions.snapshot)
// and the resolved state a create/update validates and writes.
type Snapshot struct {
	FolderID      *uuid.UUID      `json:"folder_id"`
	Title         string          `json:"title"`
	Description   string          `json:"description"`
	Preconditions string          `json:"preconditions"`
	Priority      string          `json:"priority"`
	Status        string          `json:"status"`
	Execution     string          `json:"execution"`
	Tags          []string        `json:"tags"`
	Variables     json.RawMessage `json:"variables"`
	Steps         json.RawMessage `json:"steps"`
}

// Key renders a test case key (SHOP-T12).
func Key(projectKey string, seq int) string {
	return projectKey + "-T" + strconv.Itoa(seq)
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
