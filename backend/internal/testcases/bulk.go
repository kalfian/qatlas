package testcases

import (
	"context"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Bulk actions (BulkTestCaseAction.action).
var BulkActions = []string{"move", "set_status", "add_tags", "remove_tags", "delete"}

// Bulk applies one action to the project's non-deleted test cases among
// in.IDs (unknown ids are ignored, like the mock) and returns how many rows
// changed. As in the mock, bulk changes do not bump revisions. Bulk delete is
// refused (409 in_use, one detail per test case listing its flows) when any
// selected test case is still used by a non-deleted flow — the same rule as
// the single delete; nothing is deleted then.
func (s *Service) Bulk(ctx context.Context, actor *auth.Actor, projectKey string, in BulkInput) (BulkResult, error) {
	var out BulkResult
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, projectKey, authz.EditTests)
		if err != nil {
			return err
		}
		if len(in.IDs) == 0 {
			return httpx.BadRequest("Select at least one test case", httpx.Field("ids", "Required"))
		}
		if !slices.Contains(BulkActions, in.Action) {
			return httpx.BadRequest("Unknown bulk action", httpx.Field("action", "Must be one of "+strings.Join(BulkActions, ", ")))
		}
		ids := make([]uuid.UUID, 0, len(in.IDs))
		for _, raw := range in.IDs {
			if id, err := uuid.Parse(raw); err == nil {
				ids = append(ids, id)
			}
		}
		tags := nonNilStrings(in.Tags)

		set := ""
		args := []any{p.ID, ids, actor.User.ID}
		meta := audit.Meta{"action": in.Action}
		switch in.Action {
		case "move":
			var folder *uuid.UUID
			if v := in.FolderID.Ptr(); v != nil {
				id, perr := uuid.Parse(*v)
				ok := perr == nil
				if ok {
					if ok, err = folderInProject(ctx, tx, p.ID, id); err != nil {
						return err
					}
				}
				if !ok {
					return httpx.BadRequest("Folder not found", httpx.Field("folder_id", "Folder not found"))
				}
				folder = &id
			}
			set = "folder_id = $4"
			args = append(args, folder)
			meta["folder_id"] = folder
		case "set_status":
			if in.Status == nil || !slices.Contains(Statuses, *in.Status) {
				return httpx.BadRequest("Invalid status", httpx.Field("status", "Status must be one of "+strings.Join(Statuses, ", ")))
			}
			set = "status = $4"
			args = append(args, *in.Status)
			meta["status"] = *in.Status
		case "add_tags":
			// Union keeping first-occurrence order (mock: [...new Set([...t.tags, ...tags])]).
			set = `tags = ARRAY(SELECT x FROM unnest(tags || $4::text[]) WITH ORDINALITY AS u(x, n) GROUP BY x ORDER BY min(n))`
			args = append(args, tags)
			meta["tags"] = tags
		case "remove_tags":
			set = `tags = ARRAY(SELECT x FROM unnest(tags) WITH ORDINALITY AS u(x, n) WHERE NOT (x = ANY($4::text[])) ORDER BY n)`
			args = append(args, tags)
			meta["tags"] = tags
		case "delete":
			if err := checkNotInFlows(ctx, tx, p, ids); err != nil {
				return err
			}
			set = "deleted_at = now()"
		}
		rows, err := tx.Query(ctx, `
			UPDATE test_cases SET `+set+`, updated_at = now(), updated_by = $3
			WHERE project_id = $1 AND id = ANY($2) AND deleted_at IS NULL
			RETURNING seq`, args...)
		if err != nil {
			return err
		}
		seqs, err := pgx.CollectRows(rows, pgx.RowTo[int])
		if err != nil {
			return err
		}
		slices.Sort(seqs)
		keys := make([]string, len(seqs))
		for i, n := range seqs {
			keys[i] = Key(p.Key, n)
		}
		meta["keys"] = keys
		out.Updated = len(seqs)
		return audit.Record(ctx, tx, actor, ActionBulk, "test_case", "", &p.ID, meta)
	})
	return out, err
}

// checkNotInFlows returns 409 in_use when a non-deleted flow uses one of the
// project's non-deleted test cases ids. Details: path = test case key,
// message = the flow keys. The test cases are locked first so a concurrent
// flow save (which locks its items FOR SHARE) cannot slip in between.
func checkNotInFlows(ctx context.Context, tx pgx.Tx, p authz.Project, ids []uuid.UUID) error {
	if _, err := tx.Exec(ctx, `
		SELECT 1 FROM test_cases WHERE project_id = $1 AND id = ANY($2) AND deleted_at IS NULL
		ORDER BY id FOR UPDATE`, p.ID, ids); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
		SELECT t.seq, array_agg(f.seq ORDER BY f.seq)
		FROM test_cases t
		JOIN flow_items fi ON fi.test_case_id = t.id
		JOIN flows f ON f.id = fi.flow_id AND f.deleted_at IS NULL
		WHERE t.project_id = $1 AND t.id = ANY($2) AND t.deleted_at IS NULL
		GROUP BY t.seq
		ORDER BY t.seq`, p.ID, ids)
	if err != nil {
		return err
	}
	type usage struct {
		Case  int
		Flows []int
	}
	used, err := pgx.CollectRows(rows, pgx.RowToStructByPos[usage])
	if err != nil {
		return err
	}
	if len(used) == 0 {
		return nil
	}
	details := make([]httpx.FieldError, len(used))
	summary := make([]string, len(used))
	for i, u := range used {
		flowKeys := make([]string, 0, len(u.Flows))
		for _, n := range slices.Compact(u.Flows) {
			flowKeys = append(flowKeys, p.Key+"-F"+strconv.Itoa(n))
		}
		caseKey := Key(p.Key, u.Case)
		details[i] = httpx.Field(caseKey, "Still used in flows: "+strings.Join(flowKeys, ", "))
		summary[i] = caseKey + " (" + strings.Join(flowKeys, ", ") + ")"
	}
	return httpx.NewError(409, httpx.CodeInUse, "Still used in flows: "+strings.Join(summary, "; "), details...)
}

// sortTags orders tags case-insensitively (approximating the mock's
// localeCompare), ties broken by byte order.
func sortTags(tags []TagCount) {
	sort.SliceStable(tags, func(i, j int) bool {
		a, b := strings.ToLower(tags[i].Tag), strings.ToLower(tags[j].Tag)
		if a != b {
			return a < b
		}
		return tags[i].Tag < tags[j].Tag
	})
}
