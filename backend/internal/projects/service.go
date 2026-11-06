// Package projects implements projects, members, stats and assignable users
// (behaviour: web/src/mocks/handlers.ts "projects" + "members").
//
// Stats bucket runs per calendar day in the server's local timezone: set
// QATLAS_TZ to an IANA zone (e.g. Asia/Jakarta) to override the system zone
// (TZ / /etc/localtime). tzdata is embedded, so zone names work on minimal images.
package projects

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata" // QATLAS_TZ must resolve on images without /usr/share/zoneinfo

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/runs"
)

// Audit actions owned by this package.
const (
	ActionProjectCreate  = "project.create"
	ActionProjectUpdate  = "project.update"
	ActionProjectArchive = "project.archive"
	ActionMemberAdd      = "member.add"
	ActionMemberUpdate   = "member.update"
	ActionMemberRemove   = "member.remove"
)

// Default environment created with every project (mock behaviour).
const (
	defaultEnvName    = "staging"
	defaultEnvBaseURL = "https://staging.example.com"
)

// Service implements project operations for REST handlers and MCP tools.
type Service struct {
	pool *pgxpool.Pool
	loc  *time.Location
	now  func() time.Time
}

// New builds the projects service. The stats timezone comes from StatsLocation.
func New(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, loc: StatsLocation(), now: time.Now}
}

// StatsLocation returns the zone used for daily stats buckets: QATLAS_TZ when
// set and valid, otherwise the process' local zone (TZ / system setting).
func StatsLocation() *time.Location {
	name := strings.TrimSpace(os.Getenv("QATLAS_TZ"))
	if name == "" {
		return time.Local
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		slog.Warn("invalid QATLAS_TZ, using the system timezone", "tz", name, "err", err)
		return time.Local
	}
	return loc
}

// ------------------------------------------------------------------ DTOs

// Project is the OpenAPI Project schema.
type Project struct {
	ID                    uuid.UUID  `json:"id"`
	Key                   string     `json:"key"`
	Name                  string     `json:"name"`
	Description           string     `json:"description"`
	ArchivedAt            *time.Time `json:"archived_at"`
	MyRole                authz.Role `json:"my_role"`
	DefaultRunOptions     RunOptions `json:"default_run_options"`
	ArtifactRetentionDays int        `json:"artifact_retention_days"`
	CreatedAt             time.Time  `json:"created_at"`
}

// ProjectSummary is the OpenAPI ProjectSummary schema.
type ProjectSummary struct {
	ID            uuid.UUID        `json:"id"`
	Key           string           `json:"key"`
	Name          string           `json:"name"`
	Description   string           `json:"description"`
	ArchivedAt    *time.Time       `json:"archived_at"`
	MyRole        authz.Role       `json:"my_role"`
	TestCaseCount int              `json:"test_case_count"`
	FlowCount     int              `json:"flow_count"`
	PassRate7d    *float64         `json:"pass_rate_7d"`
	LastRun       *runs.RunSummary `json:"last_run"`
}

func toProject(p authz.Project, role authz.Role) (Project, error) {
	opts, err := MergeRunOptions(p.DefaultRunOptions)
	if err != nil {
		return Project{}, err
	}
	return Project{
		ID:                    p.ID,
		Key:                   p.Key,
		Name:                  p.Name,
		Description:           p.Description,
		ArchivedAt:            auth.UTCPtr(p.ArchivedAt),
		MyRole:                role,
		DefaultRunOptions:     opts,
		ArtifactRetentionDays: p.ArtifactRetentionDays,
		CreatedAt:             p.CreatedAt.UTC(),
	}, nil
}

func scanProject(row pgx.Row) (authz.Project, error) {
	var p authz.Project
	err := row.Scan(&p.ID, &p.Key, &p.Name, &p.Description, &p.ArchivedAt, &p.CreatedBy, &p.DefaultRunOptions,
		&p.ArtifactRetentionDays, &p.CreatedAt, &p.UpdatedAt)
	return p, err
}

// ------------------------------------------------------------------ list

// List returns the projects visible to the actor (members, or every project
// for admins; API tokens limited to their projects). Archived projects are
// only included when includeArchived is set.
func (s *Service) List(ctx context.Context, actor *auth.Actor, includeArchived bool) ([]ProjectSummary, error) {
	weekAgo := s.now().Add(-7 * 24 * time.Hour)
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.key, p.name, p.description, p.archived_at, pm.role,
			(SELECT count(*) FROM test_cases t WHERE t.project_id = p.id AND t.deleted_at IS NULL)::int,
			(SELECT count(*) FROM flows f WHERE f.project_id = p.id AND f.deleted_at IS NULL)::int,
			pr.finals, pr.passed
		FROM projects p
		LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
		LEFT JOIN LATERAL (
			SELECT count(*) FILTER (WHERE r.status IN ('passed', 'failed', 'blocked', 'error'))::int AS finals,
				count(*) FILTER (WHERE r.status = 'passed')::int AS passed
			FROM runs r WHERE r.project_id = p.id AND r.queued_at >= $4
		) pr ON true
		WHERE (pm.user_id IS NOT NULL OR $2)
		  AND ($3::uuid[] IS NULL OR p.id = ANY ($3))
		  AND ($5 OR p.archived_at IS NULL)
		ORDER BY p.created_at, p.key`,
		actor.User.ID, actor.IsAdmin(), actor.ProjectIDs, weekAgo, includeArchived)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProjectSummary{}
	ids := []uuid.UUID{}
	for rows.Next() {
		var (
			ps             ProjectSummary
			member         *string
			finals, passed int
		)
		if err := rows.Scan(&ps.ID, &ps.Key, &ps.Name, &ps.Description, &ps.ArchivedAt, &member,
			&ps.TestCaseCount, &ps.FlowCount, &finals, &passed); err != nil {
			return nil, err
		}
		ps.ArchivedAt = auth.UTCPtr(ps.ArchivedAt)
		ps.MyRole = authz.EffectiveRole(member, actor.User.SystemRole)
		if finals > 0 {
			rate := float64(passed) / float64(finals)
			ps.PassRate7d = &rate
		}
		out = append(out, ps)
		ids = append(ids, ps.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return out, nil
	}
	last, err := runs.QuerySummaries(ctx, s.pool, `
		WHERE r.id IN (
			SELECT DISTINCT ON (x.project_id) x.id FROM runs x
			WHERE x.project_id = ANY ($1)
			ORDER BY x.project_id, x.queued_at DESC, x.id DESC
		)`, ids)
	if err != nil {
		return nil, err
	}
	byKey := make(map[string]*runs.RunSummary, len(last))
	for i := range last {
		byKey[last[i].ProjectKey] = &last[i]
	}
	for i := range out {
		out[i].LastRun = byKey[out[i].Key]
	}
	return out, nil
}

// ------------------------------------------------------------------ create

// CreateInput is the POST /projects body.
type CreateInput struct {
	Key         string  `json:"key"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
}

var keyPattern = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,9}$`)

// Create creates a project (admins only). The creator becomes maintainer and
// a default "staging" environment is created, like the mock.
func (s *Service) Create(ctx context.Context, actor *auth.Actor, in CreateInput) (Project, error) {
	if !actor.IsAdmin() {
		return Project{}, httpx.Forbidden("Only admins can do this")
	}
	if err := actor.RequireScope(auth.ScopeWrite); err != nil {
		return Project{}, err
	}
	key := strings.ToUpper(in.Key)
	if !keyPattern.MatchString(key) {
		return Project{}, httpx.BadRequest("Key must be 2–10 uppercase letters or digits, starting with a letter", httpx.Field("key", "Invalid key format"))
	}
	taken := func() error {
		return httpx.Conflict("Key "+key+" is already taken", httpx.Field("key", "Key is already taken"))
	}
	description := ""
	if in.Description != nil {
		description = *in.Description
	}

	var out Project
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM projects WHERE key = $1)`, key).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return taken()
		}
		name := strings.TrimSpace(in.Name)
		if name == "" {
			return httpx.BadRequest("Name is required", httpx.Field("name", "Required"))
		}
		p, err := scanProject(tx.QueryRow(ctx, `
			INSERT INTO projects AS p (id, key, name, description, created_by) VALUES ($1, $2, $3, $4, $5)
			RETURNING `+authz.ProjectColumns, db.NewID(), key, name, description, actor.User.ID))
		if db.IsUniqueViolation(err, "projects_key_key") {
			return taken()
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'maintainer')`, p.ID, actor.User.ID); err != nil {
			return err
		}
		vars, _ := json.Marshal(map[string]string{"BASE_URL": defaultEnvBaseURL})
		if _, err := tx.Exec(ctx, `INSERT INTO environments (id, project_id, name, is_default, variables) VALUES ($1, $2, $3, true, $4)`,
			db.NewID(), p.ID, defaultEnvName, vars); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, ActionProjectCreate, "project", p.Key, &p.ID, audit.Meta{"name": p.Name}); err != nil {
			return err
		}
		out, err = toProject(p, authz.RoleMaintainer)
		return err
	})
	return out, err
}

// ------------------------------------------------------------------ get / update / archive

// Get returns one project (any role).
func (s *Service) Get(ctx context.Context, actor *auth.Actor, key string) (Project, error) {
	p, role, err := authz.ProjectAccess(ctx, s.pool, actor, key, authz.View)
	if err != nil {
		return Project{}, err
	}
	return toProject(p, role)
}

// UpdateInput is the PATCH /projects/{key} body (all fields optional).
type UpdateInput struct {
	Name                  *string         `json:"name"`
	Description           *string         `json:"description"`
	DefaultRunOptions     json.RawMessage `json:"default_run_options"`
	ArtifactRetentionDays *int            `json:"artifact_retention_days"`
}

// Update changes name / description / run defaults (merged into the current
// ones) / artifact retention (1–365 days). Maintainers only.
func (s *Service) Update(ctx context.Context, actor *auth.Actor, key string, in UpdateInput) (Project, error) {
	var out Project
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, role, err := authz.ProjectAccess(ctx, tx, actor, key, authz.ManageSettings)
		if err != nil {
			return err
		}
		fields := []string{}
		name, description, retention := p.Name, p.Description, p.ArtifactRetentionDays
		if in.Name != nil {
			n := strings.TrimSpace(*in.Name)
			if n == "" {
				return httpx.BadRequest("Name is required", httpx.Field("name", "Required"))
			}
			if n != p.Name {
				name = n
				fields = append(fields, "name")
			}
		}
		if in.Description != nil && *in.Description != p.Description {
			description = *in.Description
			fields = append(fields, "description")
		}
		opts, err := MergeRunOptions(p.DefaultRunOptions)
		if err != nil {
			return err
		}
		if len(in.DefaultRunOptions) > 0 && string(in.DefaultRunOptions) != "null" {
			merged, err := ApplyRunOptionsInput(opts, in.DefaultRunOptions)
			if err != nil {
				return err
			}
			if !merged.Equal(opts) {
				opts = merged
				fields = append(fields, "default_run_options")
			}
		}
		if in.ArtifactRetentionDays != nil {
			d := *in.ArtifactRetentionDays
			if d < 1 || d > 365 {
				return httpx.BadRequest("Artifact retention must be between 1 and 365 days", httpx.Field("artifact_retention_days", "Must be between 1 and 365"))
			}
			if d != p.ArtifactRetentionDays {
				retention = d
				fields = append(fields, "artifact_retention_days")
			}
		}
		if len(fields) > 0 {
			raw, err := json.Marshal(opts)
			if err != nil {
				return err
			}
			p, err = scanProject(tx.QueryRow(ctx, `
				UPDATE projects AS p SET name = $2, description = $3, default_run_options = $4, artifact_retention_days = $5, updated_at = now()
				WHERE p.id = $1 RETURNING `+authz.ProjectColumns, p.ID, name, description, raw, retention))
			if err != nil {
				return err
			}
			if err := audit.Record(ctx, tx, actor, ActionProjectUpdate, "project", p.Key, &p.ID, audit.Meta{"fields": fields}); err != nil {
				return err
			}
		}
		out, err = toProject(p, role)
		return err
	})
	return out, err
}

// Archive marks the project archived (mock: archived_at = now, also when
// already archived). Archived projects disappear from /me and from
// GET /projects unless include_archived=true, but stay reachable by key.
func (s *Service) Archive(ctx context.Context, actor *auth.Actor, key string) (Project, error) {
	var out Project
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, role, err := authz.ProjectAccess(ctx, tx, actor, key, authz.ManageSettings)
		if err != nil {
			return err
		}
		p, err = scanProject(tx.QueryRow(ctx, `
			UPDATE projects AS p SET archived_at = now(), updated_at = now()
			WHERE p.id = $1 RETURNING `+authz.ProjectColumns, p.ID))
		if err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, ActionProjectArchive, "project", p.Key, &p.ID, nil); err != nil {
			return err
		}
		out, err = toProject(p, role)
		return err
	})
	return out, err
}
