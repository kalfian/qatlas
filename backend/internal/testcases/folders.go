package testcases

import (
	"context"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// FolderInput is the POST /projects/{key}/folders body.
type FolderInput struct {
	Name     string  `json:"name"`
	ParentID *string `json:"parent_id"`
}

// FolderPatch is the PATCH /projects/{key}/folders/{id} body.
type FolderPatch struct {
	Name     *string                `json:"name"`
	ParentID httpx.Optional[string] `json:"parent_id"`
	Position *int                   `json:"position"`
}

const folderSelect = `
	SELECT f.id, f.parent_id, f.name, f.position,
	       (SELECT count(*)::int FROM test_cases t WHERE t.folder_id = f.id AND t.deleted_at IS NULL)
	FROM folders f`

func scanFolder(row pgx.Row) (Folder, error) {
	var f Folder
	err := row.Scan(&f.ID, &f.ParentID, &f.Name, &f.Position, &f.TestCaseCount)
	return f, err
}

func loadFolder(ctx context.Context, q db.Querier, id uuid.UUID) (Folder, error) {
	return scanFolder(q.QueryRow(ctx, folderSelect+` WHERE f.id = $1`, id))
}

// lockFolderTree serialises folder-tree mutations of one project (cycle
// checks and re-parenting must not interleave).
func lockFolderTree(ctx context.Context, q db.Querier, projectID uuid.UUID) error {
	_, err := q.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('qatlas.folders:' || $1::text, 0))`, projectID)
	return err
}

// parentFolder parses and checks an optional parent folder id (nil = root).
func parentFolder(ctx context.Context, q db.Querier, projectID uuid.UUID, raw *string) (*uuid.UUID, error) {
	if raw == nil {
		return nil, nil
	}
	bad := httpx.BadRequest("Parent folder not found", httpx.Field("parent_id", "Folder not found"))
	id, err := uuid.Parse(*raw)
	if err != nil {
		return nil, bad
	}
	ok, err := folderInProject(ctx, q, projectID, id)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, bad
	}
	return &id, nil
}

// findFolder locks and returns a folder id of the project (404 otherwise).
func findFolder(ctx context.Context, q db.Querier, projectID uuid.UUID, rawID string) (uuid.UUID, *uuid.UUID, error) {
	notFound := httpx.NotFound("Folder not found")
	id, err := uuid.Parse(rawID)
	if err != nil {
		return uuid.Nil, nil, notFound
	}
	var parent *uuid.UUID
	err = q.QueryRow(ctx, `SELECT parent_id FROM folders WHERE id = $1 AND project_id = $2 FOR UPDATE`, id, projectID).Scan(&parent)
	if db.IsNoRows(err) {
		return uuid.Nil, nil, notFound
	}
	return id, parent, err
}

// ListFolders returns the project's folders ordered by position.
func (s *Service) ListFolders(ctx context.Context, actor *auth.Actor, projectKey string) ([]Folder, error) {
	p, _, err := authz.ProjectAccess(ctx, s.pool, actor, projectKey, authz.View)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, folderSelect+` WHERE f.project_id = $1 ORDER BY f.position, f.id`, p.ID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Folder, error) { return scanFolder(r) })
}

// CreateFolder appends a folder at the end of its siblings.
func (s *Service) CreateFolder(ctx context.Context, actor *auth.Actor, projectKey string, in FolderInput) (Folder, error) {
	var out Folder
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, projectKey, authz.EditTests)
		if err != nil {
			return err
		}
		name := strings.TrimSpace(in.Name)
		if name == "" {
			return httpx.BadRequest("Folder name is required", httpx.Field("name", "Required"))
		}
		if err := lockFolderTree(ctx, tx, p.ID); err != nil {
			return err
		}
		parent, err := parentFolder(ctx, tx, p.ID, in.ParentID)
		if err != nil {
			return err
		}
		id := db.NewID()
		_, err = tx.Exec(ctx, `
			INSERT INTO folders (id, project_id, parent_id, name, position)
			VALUES ($1, $2, $3, $4, (SELECT count(*) FROM folders WHERE project_id = $2 AND parent_id IS NOT DISTINCT FROM $3))`,
			id, p.ID, parent, name)
		if err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, ActionFolderCreate, "folder", id.String(), &p.ID, audit.Meta{"name": name}); err != nil {
			return err
		}
		out, err = loadFolder(ctx, tx, id)
		return err
	})
	return out, err
}

// UpdateFolder renames (blank names are ignored, as in the mock), moves (no
// cycles) and/or repositions a folder.
func (s *Service) UpdateFolder(ctx context.Context, actor *auth.Actor, projectKey, folderID string, in FolderPatch) (Folder, error) {
	var out Folder
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, projectKey, authz.EditTests)
		if err != nil {
			return err
		}
		if err := lockFolderTree(ctx, tx, p.ID); err != nil {
			return err
		}
		id, _, err := findFolder(ctx, tx, p.ID, folderID)
		if err != nil {
			return err
		}
		meta := audit.Meta{}
		if in.Name != nil {
			if name := strings.TrimSpace(*in.Name); name != "" {
				if _, err := tx.Exec(ctx, `UPDATE folders SET name = $2 WHERE id = $1`, id, name); err != nil {
					return err
				}
				meta["name"] = name
			}
		}
		if in.ParentID.Set {
			parent, err := parentFolder(ctx, tx, p.ID, in.ParentID.Ptr())
			if err != nil {
				return err
			}
			if parent != nil {
				// Walk up from the new parent; reaching the folder itself means a cycle.
				rows, err := tx.Query(ctx, `
					WITH RECURSIVE up AS (
						SELECT id, parent_id FROM folders WHERE id = $1
						UNION SELECT f.id, f.parent_id FROM folders f JOIN up ON f.id = up.parent_id
					) SELECT id FROM up`, *parent)
				if err != nil {
					return err
				}
				ancestors, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
				if err != nil {
					return err
				}
				if slices.Contains(ancestors, id) {
					return httpx.BadRequest("A folder can't be moved into itself")
				}
			}
			if _, err := tx.Exec(ctx, `UPDATE folders SET parent_id = $2 WHERE id = $1`, id, parent); err != nil {
				return err
			}
			meta["parent_id"] = parent
		}
		if in.Position != nil {
			if _, err := tx.Exec(ctx, `UPDATE folders SET position = $2 WHERE id = $1`, id, *in.Position); err != nil {
				return err
			}
			meta["position"] = *in.Position
		}
		if _, err := tx.Exec(ctx, `UPDATE folders SET updated_at = now() WHERE id = $1`, id); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, ActionFolderUpdate, "folder", id.String(), &p.ID, meta); err != nil {
			return err
		}
		out, err = loadFolder(ctx, tx, id)
		return err
	})
	return out, err
}

// DeleteFolder removes a folder; its sub-folders and test cases (deleted ones
// included, like the mock) move to the folder's parent.
func (s *Service) DeleteFolder(ctx context.Context, actor *auth.Actor, projectKey, folderID string) error {
	return db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, projectKey, authz.EditTests)
		if err != nil {
			return err
		}
		if err := lockFolderTree(ctx, tx, p.ID); err != nil {
			return err
		}
		id, parent, err := findFolder(ctx, tx, p.ID, folderID)
		if err != nil {
			return err
		}
		var name string
		if err := tx.QueryRow(ctx, `SELECT name FROM folders WHERE id = $1`, id).Scan(&name); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE folders SET parent_id = $2, updated_at = now() WHERE parent_id = $1`, id, parent); err != nil {
			return err
		}
		moved, err := tx.Exec(ctx, `UPDATE test_cases SET folder_id = $2 WHERE folder_id = $1`, id, parent)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM folders WHERE id = $1`, id); err != nil {
			return err
		}
		return audit.Record(ctx, tx, actor, ActionFolderDelete, "folder", id.String(), &p.ID,
			audit.Meta{"name": name, "parent_id": parent, "test_cases_moved": moved.RowsAffected()})
	})
}
