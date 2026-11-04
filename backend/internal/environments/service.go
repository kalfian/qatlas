// Package environments implements project environments: plain variables and
// write-only secrets encrypted with QATLAS_MASTER_KEY (internal/secrets).
// Behaviour: web/src/mocks/handlers.ts "environments".
//
// Secret values are never returned, logged or written to audit meta: the
// API exposes only {name, updated_at}.
package environments

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/secrets"
)

// Audit actions owned by this package.
const (
	ActionEnvironmentCreate = "environment.create"
	ActionEnvironmentUpdate = "environment.update"
	ActionEnvironmentDelete = "environment.delete"
	ActionSecretSet         = "secret.set"
	ActionSecretDelete      = "secret.delete"
)

// Service implements environment operations for REST handlers and MCP tools.
type Service struct {
	pool      *pgxpool.Pool
	masterKey []byte
}

// New builds the service. masterKey is QATLAS_MASTER_KEY (32 bytes); without
// it setting a secret fails with a 500 (the server refuses to start without it).
func New(pool *pgxpool.Pool, masterKey []byte) *Service {
	return &Service{pool: pool, masterKey: masterKey}
}

// SecretMeta is Environment.secrets[] (name only, never the value).
type SecretMeta struct {
	Name      string    `json:"name"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Environment is the OpenAPI Environment schema.
type Environment struct {
	ID        uuid.UUID         `json:"id"`
	Name      string            `json:"name"`
	IsDefault bool              `json:"is_default"`
	Variables map[string]string `json:"variables"`
	Secrets   []SecretMeta      `json:"secrets"`
	UpdatedAt time.Time         `json:"updated_at"`
}

// Input is the EnvironmentInput body (POST and PATCH; every field optional).
// Variables: absent or null = unchanged, {} = clear.
type Input struct {
	Name      *string           `json:"name"`
	IsDefault *bool             `json:"is_default"`
	Variables map[string]string `json:"variables"`
}

var (
	varKeyPattern     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	secretNamePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
)

func errEnvNotFound() error { return httpx.NotFound("Environment not found") }

func errNameTaken() error {
	return httpx.Conflict("Environment name is already taken", httpx.Field("name", "Already taken"))
}

func validateVarKeys(vars map[string]string) error {
	var bad []string
	for k := range vars {
		if !varKeyPattern.MatchString(k) {
			bad = append(bad, k)
		}
	}
	if len(bad) == 0 {
		return nil
	}
	slices.Sort(bad)
	details := make([]httpx.FieldError, len(bad))
	for i, k := range bad {
		details[i] = httpx.Field("variables."+k, "Use letters, digits, and underscores")
	}
	return httpx.BadRequest("Invalid variable names: "+strings.Join(bad, ", "), details...)
}

// ------------------------------------------------------------------ loading

const envColumns = `e.id, e.name, e.is_default, e.variables, e.updated_at`

func scanEnv(row pgx.Row) (Environment, error) {
	var e Environment
	if err := row.Scan(&e.ID, &e.Name, &e.IsDefault, &e.Variables, &e.UpdatedAt); err != nil {
		return Environment{}, err
	}
	if e.Variables == nil {
		e.Variables = map[string]string{}
	}
	e.Secrets = []SecretMeta{}
	e.UpdatedAt = e.UpdatedAt.UTC()
	return e, nil
}

// attachSecrets fills Secrets (names only) for envs.
func attachSecrets(ctx context.Context, q db.Querier, envs []Environment) error {
	if len(envs) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(envs))
	idx := make(map[uuid.UUID]int, len(envs))
	for i, e := range envs {
		ids[i], idx[e.ID] = e.ID, i
	}
	rows, err := q.Query(ctx, `
		SELECT environment_id, name, updated_at FROM environment_secrets
		WHERE environment_id = ANY ($1) ORDER BY created_at, name`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			envID uuid.UUID
			m     SecretMeta
		)
		if err := rows.Scan(&envID, &m.Name, &m.UpdatedAt); err != nil {
			return err
		}
		m.UpdatedAt = m.UpdatedAt.UTC()
		i := idx[envID]
		envs[i].Secrets = append(envs[i].Secrets, m)
	}
	return rows.Err()
}

func loadEnv(ctx context.Context, q db.Querier, projectID uuid.UUID, idParam string, forUpdate bool) (Environment, error) {
	id, err := uuid.Parse(idParam)
	if err != nil {
		return Environment{}, errEnvNotFound()
	}
	sql := `SELECT ` + envColumns + ` FROM environments e WHERE e.id = $1 AND e.project_id = $2`
	if forUpdate {
		sql += ` FOR UPDATE`
	}
	e, err := scanEnv(q.QueryRow(ctx, sql, id, projectID))
	if db.IsNoRows(err) {
		return Environment{}, errEnvNotFound()
	}
	return e, err
}

func reload(ctx context.Context, q db.Querier, projectID, id uuid.UUID) (Environment, error) {
	e, err := loadEnv(ctx, q, projectID, id.String(), false)
	if err != nil {
		return Environment{}, err
	}
	envs := []Environment{e}
	if err := attachSecrets(ctx, q, envs); err != nil {
		return Environment{}, err
	}
	return envs[0], nil
}

// lockProject serialises environment changes of one project (default flag,
// name uniqueness).
func lockProject(ctx context.Context, tx pgx.Tx, id uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT 1 FROM projects WHERE id = $1 FOR UPDATE`, id)
	return err
}

func nameTaken(ctx context.Context, tx pgx.Tx, projectID uuid.UUID, name string) (bool, error) {
	var taken bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM environments WHERE project_id = $1 AND name = $2)`, projectID, name).Scan(&taken)
	return taken, err
}

func clearDefault(ctx context.Context, tx pgx.Tx, projectID uuid.UUID) error {
	_, err := tx.Exec(ctx, `UPDATE environments SET is_default = false WHERE project_id = $1 AND is_default`, projectID)
	return err
}

// ------------------------------------------------------------------ CRUD

// List returns the project's environments (any role), oldest first.
func (s *Service) List(ctx context.Context, actor *auth.Actor, key string) ([]Environment, error) {
	p, _, err := authz.ProjectAccess(ctx, s.pool, actor, key, authz.View)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT `+envColumns+` FROM environments e WHERE e.project_id = $1 ORDER BY e.created_at, e.id`, p.ID)
	if err != nil {
		return nil, err
	}
	out := []Environment{}
	for rows.Next() {
		e, err := scanEnv(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := attachSecrets(ctx, s.pool, out); err != nil {
		return nil, err
	}
	return out, nil
}

// Create adds an environment. The project's first environment, or one created
// with is_default, becomes the default (unsetting the previous one).
func (s *Service) Create(ctx context.Context, actor *auth.Actor, key string, in Input) (Environment, error) {
	var out Environment
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, key, authz.ManageEnvironments)
		if err != nil {
			return err
		}
		name := ""
		if in.Name != nil {
			name = strings.TrimSpace(*in.Name)
		}
		if name == "" {
			return httpx.BadRequest("Name is required", httpx.Field("name", "Required"))
		}
		if err := lockProject(ctx, tx, p.ID); err != nil {
			return err
		}
		if taken, err := nameTaken(ctx, tx, p.ID, name); err != nil {
			return err
		} else if taken {
			return errNameTaken()
		}
		if err := validateVarKeys(in.Variables); err != nil {
			return err
		}
		vars := in.Variables
		if vars == nil {
			vars = map[string]string{}
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM environments WHERE project_id = $1`, p.ID).Scan(&count); err != nil {
			return err
		}
		isDefault := (in.IsDefault != nil && *in.IsDefault) || count == 0
		if isDefault {
			if err := clearDefault(ctx, tx, p.ID); err != nil {
				return err
			}
		}
		id := db.NewID()
		_, err = tx.Exec(ctx, `INSERT INTO environments (id, project_id, name, is_default, variables) VALUES ($1, $2, $3, $4, $5)`,
			id, p.ID, name, isDefault, vars)
		if db.IsUniqueViolation(err, "environments_project_name_key") {
			return errNameTaken()
		}
		if err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, ActionEnvironmentCreate, "environment", id.String(), &p.ID,
			audit.Meta{"name": name, "is_default": isDefault, "variables": sortedKeys(vars)}); err != nil {
			return err
		}
		out, err = reload(ctx, tx, p.ID, id)
		return err
	})
	return out, err
}

// Update renames (an empty name keeps the current one), replaces variables
// and/or makes the environment the default. is_default=false is ignored
// (there is always a default while environments exist), like the mock.
func (s *Service) Update(ctx context.Context, actor *auth.Actor, key, id string, in Input) (Environment, error) {
	var out Environment
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, key, authz.ManageEnvironments)
		if err != nil {
			return err
		}
		if err := lockProject(ctx, tx, p.ID); err != nil {
			return err
		}
		env, err := loadEnv(ctx, tx, p.ID, id, true)
		if err != nil {
			return err
		}
		meta := audit.Meta{}
		name, vars := env.Name, env.Variables
		if in.Name != nil {
			n := strings.TrimSpace(*in.Name)
			if n != "" && n != env.Name {
				if taken, err := nameTaken(ctx, tx, p.ID, n); err != nil {
					return err
				} else if taken {
					return errNameTaken()
				}
				name = n
				meta["name"] = map[string]string{"from": env.Name, "to": n}
			}
		}
		if in.Variables != nil {
			if err := validateVarKeys(in.Variables); err != nil {
				return err
			}
			vars = in.Variables
			meta["variables"] = sortedKeys(vars)
		}
		if in.IsDefault != nil && *in.IsDefault && !env.IsDefault {
			if err := clearDefault(ctx, tx, p.ID); err != nil {
				return err
			}
			meta["is_default"] = true
		}
		makeDefault := env.IsDefault || (in.IsDefault != nil && *in.IsDefault)
		_, err = tx.Exec(ctx, `UPDATE environments SET name = $2, variables = $3, is_default = $4, updated_at = now() WHERE id = $1`,
			env.ID, name, vars, makeDefault)
		if db.IsUniqueViolation(err, "environments_project_name_key") {
			return errNameTaken()
		}
		if err != nil {
			return err
		}
		if len(meta) > 0 {
			meta["environment"] = name
			if err := audit.Record(ctx, tx, actor, ActionEnvironmentUpdate, "environment", env.ID.String(), &p.ID, meta); err != nil {
				return err
			}
		}
		out, err = reload(ctx, tx, p.ID, env.ID)
		return err
	})
	return out, err
}

// Delete removes an environment (and its secrets). Deleting the default
// promotes the oldest remaining environment. Runs keep their environment
// name snapshot (environment_id is set NULL).
func (s *Service) Delete(ctx context.Context, actor *auth.Actor, key, id string) error {
	return db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, key, authz.ManageEnvironments)
		if err != nil {
			return err
		}
		if err := lockProject(ctx, tx, p.ID); err != nil {
			return err
		}
		env, err := loadEnv(ctx, tx, p.ID, id, true)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM environments WHERE id = $1`, env.ID); err != nil {
			return err
		}
		if env.IsDefault {
			if _, err := tx.Exec(ctx, `
				UPDATE environments SET is_default = true
				WHERE id = (SELECT id FROM environments WHERE project_id = $1 ORDER BY created_at, id LIMIT 1)`, p.ID); err != nil {
				return err
			}
		}
		return audit.Record(ctx, tx, actor, ActionEnvironmentDelete, "environment", env.ID.String(), &p.ID, audit.Meta{"name": env.Name})
	})
}

// ------------------------------------------------------------------ secrets

// SetSecret creates or replaces a secret value (AES-256-GCM). The response
// and the audit entry carry the name only.
func (s *Service) SetSecret(ctx context.Context, actor *auth.Actor, key, id, name, value string) (Environment, error) {
	var out Environment
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, key, authz.ManageEnvironments)
		if err != nil {
			return err
		}
		env, err := loadEnv(ctx, tx, p.ID, id, true)
		if err != nil {
			return err
		}
		if !secretNamePattern.MatchString(name) {
			return httpx.BadRequest("Secret name must be UPPER_SNAKE_CASE", httpx.Field("name", "Use UPPER_SNAKE_CASE"))
		}
		if value == "" {
			return httpx.BadRequest("Value is required", httpx.Field("value", "Required"))
		}
		sealed, err := secrets.Seal(s.masterKey, []byte(value))
		if errors.Is(err, secrets.ErrKeySize) {
			return errors.New("environments: QATLAS_MASTER_KEY is not configured")
		}
		if err != nil {
			return fmt.Errorf("environments: seal secret %s: %w", name, err)
		}
		var created bool
		err = tx.QueryRow(ctx, `
			INSERT INTO environment_secrets (environment_id, name, value_enc) VALUES ($1, $2, $3)
			ON CONFLICT (environment_id, name) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()
			RETURNING (xmax = 0)`, env.ID, name, sealed).Scan(&created)
		if err != nil {
			return fmt.Errorf("environments: store secret %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, `UPDATE environments SET updated_at = now() WHERE id = $1`, env.ID); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, ActionSecretSet, "environment", env.ID.String(), &p.ID,
			audit.Meta{"environment": env.Name, "secret": name, "created": created}); err != nil {
			return err
		}
		out, err = reload(ctx, tx, p.ID, env.ID)
		return err
	})
	return out, err
}

// DeleteSecret removes a secret (no error when it does not exist, like the mock).
func (s *Service) DeleteSecret(ctx context.Context, actor *auth.Actor, key, id, name string) (Environment, error) {
	var out Environment
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, key, authz.ManageEnvironments)
		if err != nil {
			return err
		}
		env, err := loadEnv(ctx, tx, p.ID, id, true)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM environment_secrets WHERE environment_id = $1 AND name = $2`, env.ID, name)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			if err := audit.Record(ctx, tx, actor, ActionSecretDelete, "environment", env.ID.String(), &p.ID,
				audit.Meta{"environment": env.Name, "secret": name}); err != nil {
				return err
			}
		}
		out, err = reload(ctx, tx, p.ID, env.ID)
		return err
	})
	return out, err
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}
