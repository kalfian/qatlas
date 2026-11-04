package auth

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// APIToken is the OpenAPI ApiToken schema.
type APIToken struct {
	ID          uuid.UUID  `json:"id"`
	Name        string     `json:"name"`
	Prefix      string     `json:"prefix"`
	Scopes      []string   `json:"scopes"`
	ProjectKeys []string   `json:"project_keys"`
	ExpiresAt   *time.Time `json:"expires_at"`
	LastUsedAt  *time.Time `json:"last_used_at"`
	CreatedAt   time.Time  `json:"created_at"`
	RevokedAt   *time.Time `json:"revoked_at"`
}

// CreateTokenInput is the OpenAPI ApiTokenCreate schema.
type CreateTokenInput struct {
	Name          string   `json:"name"`
	Scopes        []string `json:"scopes"`
	ProjectKeys   []string `json:"project_keys"`
	ExpiresInDays *int     `json:"expires_in_days"`
}

// CreatedToken is the 201 body: the secret is returned exactly once.
type CreatedToken struct {
	Token  APIToken `json:"token"`
	Secret string   `json:"secret"`
}

const tokenSelect = `
	SELECT t.id, t.name, t.prefix, t.scopes,
		CASE WHEN t.project_ids IS NULL THEN NULL ELSE
			COALESCE((SELECT array_agg(p.key ORDER BY array_position(t.project_ids, p.id))
			          FROM projects p WHERE p.id = ANY (t.project_ids)), '{}') END,
		t.expires_at, t.last_used_at, t.created_at, t.revoked_at
	FROM api_tokens t`

func scanToken(row pgx.Row) (APIToken, error) {
	var t APIToken
	err := row.Scan(&t.ID, &t.Name, &t.Prefix, &t.Scopes, &t.ProjectKeys, &t.ExpiresAt, &t.LastUsedAt, &t.CreatedAt, &t.RevokedAt)
	t.ExpiresAt, t.LastUsedAt, t.RevokedAt = UTCPtr(t.ExpiresAt), UTCPtr(t.LastUsedAt), UTCPtr(t.RevokedAt)
	t.CreatedAt = t.CreatedAt.UTC()
	return t, err
}

// ListTokens returns every token of the actor (including revoked), newest first.
func (s *Service) ListTokens(ctx context.Context, actor *Actor) ([]APIToken, error) {
	rows, err := s.pool.Query(ctx, tokenSelect+` WHERE t.user_id = $1 ORDER BY t.created_at DESC, t.id DESC`, actor.User.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIToken{}
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// CreateToken validates the input and issues a new token for the actor.
func (s *Service) CreateToken(ctx context.Context, actor *Actor, in CreateTokenInput) (CreatedToken, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return CreatedToken{}, httpx.BadRequest("Token name is required", httpx.Field("name", "Required"))
	}
	if len(in.Scopes) == 0 {
		return CreatedToken{}, httpx.BadRequest("Select at least one scope", httpx.Field("scopes", "Select at least one"))
	}
	var scopes []string
	for _, sc := range AllScopes { // canonical order, de-duplicated
		if slices.Contains(in.Scopes, sc) {
			scopes = append(scopes, sc)
		}
	}
	for _, sc := range in.Scopes {
		if !slices.Contains(AllScopes, sc) {
			return CreatedToken{}, httpx.BadRequest("Unknown scope "+sc, httpx.Field("scopes", "Allowed: read, write, run"))
		}
	}
	if in.ExpiresInDays != nil && (*in.ExpiresInDays < 1 || *in.ExpiresInDays > 365) {
		return CreatedToken{}, httpx.BadRequest("Expiry must be between 1 and 365 days", httpx.Field("expires_in_days", "1–365"))
	}

	var created CreatedToken
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		projectIDs, err := resolveProjectKeys(ctx, tx, actor.User, in.ProjectKeys)
		if err != nil {
			return err
		}
		prefix, secret := newAPIToken()
		var expires *time.Time
		if in.ExpiresInDays != nil {
			e := time.Now().Add(time.Duration(*in.ExpiresInDays) * 24 * time.Hour)
			expires = &e
		}
		id := db.NewID()
		if _, err := tx.Exec(ctx, `
			INSERT INTO api_tokens (id, user_id, name, prefix, token_hash, scopes, project_ids, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			id, actor.User.ID, name, prefix, hashToken(secret), scopes, projectIDs, expires); err != nil {
			return err
		}
		tok, err := scanToken(tx.QueryRow(ctx, tokenSelect+` WHERE t.id = $1`, id))
		if err != nil {
			return err
		}
		created = CreatedToken{Token: tok, Secret: secret}
		return audit.Record(ctx, tx, actor, audit.ActionTokenCreate, "api_token", id.String(), nil,
			audit.Meta{"name": name, "prefix": prefix, "scopes": scopes, "project_keys": tok.ProjectKeys})
	})
	return created, err
}

// resolveProjectKeys maps keys to ids the user can access; nil/empty = unrestricted.
func resolveProjectKeys(ctx context.Context, q db.Querier, u User, keys []string) ([]uuid.UUID, error) {
	var want []string
	for _, k := range keys {
		k = strings.ToUpper(strings.TrimSpace(k))
		if k != "" && !slices.Contains(want, k) {
			want = append(want, k)
		}
	}
	if len(want) == 0 {
		return nil, nil
	}
	rows, err := q.Query(ctx, `
		SELECT p.id, p.key FROM projects p
		WHERE p.key = ANY ($1)
		  AND ($3 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2))`,
		want, u.ID, u.IsAdmin())
	if err != nil {
		return nil, err
	}
	found := map[string]uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		var key string
		if err := rows.Scan(&id, &key); err != nil {
			rows.Close()
			return nil, err
		}
		found[key] = id
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, 0, len(want))
	for _, k := range want {
		id, ok := found[k]
		if !ok {
			return nil, httpx.BadRequest("Project "+k+" not found", httpx.Field("project_keys", "Unknown project "+k))
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// RevokeToken revokes one of the actor's tokens (idempotent; 404 if not theirs).
func (s *Service) RevokeToken(ctx context.Context, actor *Actor, id string) error {
	tokenID, err := uuid.Parse(id)
	if err != nil {
		return httpx.NotFound("Token not found")
	}
	return db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		var prefix string
		err := tx.QueryRow(ctx, `
			UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, now())
			WHERE id = $1 AND user_id = $2 RETURNING prefix`, tokenID, actor.User.ID).Scan(&prefix)
		if db.IsNoRows(err) {
			return httpx.NotFound("Token not found")
		}
		if err != nil {
			return err
		}
		return audit.Record(ctx, tx, actor, audit.ActionTokenRevoke, "api_token", tokenID.String(), nil, audit.Meta{"prefix": prefix})
	})
}

// RevokeUserTokens revokes every active token of a user (used when disabling).
func RevokeUserTokens(ctx context.Context, q db.Querier, userID uuid.UUID) error {
	_, err := q.Exec(ctx, `UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, userID)
	return err
}

func errInvalidToken() *httpx.APIError {
	return httpx.Unauthenticated("Invalid, expired or revoked API token")
}

// authenticateToken resolves a Bearer secret to an Actor.
func (s *Service) authenticateToken(ctx context.Context, secret string) (*Actor, error) {
	if !apiTokenPattern.MatchString(secret) {
		return nil, errInvalidToken()
	}
	var (
		tokenID    uuid.UUID
		scopes     []string
		projectIDs []uuid.UUID
		valid      bool
		touch      bool
	)
	u, err := ScanUser(s.pool.QueryRow(ctx, `
		SELECT `+UserColumns+`, t.id, t.scopes, t.project_ids,
			(t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())),
			(t.last_used_at IS NULL OR t.last_used_at < now() - $2 * interval '1 second')
		FROM api_tokens t JOIN users u ON u.id = t.user_id
		WHERE t.token_hash = $1`, hashToken(secret), seconds(tokenTouchEvery)),
		&tokenID, &scopes, &projectIDs, &valid, &touch)
	if db.IsNoRows(err) {
		return nil, errInvalidToken()
	}
	if err != nil {
		return nil, err
	}
	if !valid || u.Status != StatusActive {
		return nil, errInvalidToken()
	}
	if touch {
		if _, err := s.pool.Exec(ctx, `UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, tokenID); err != nil {
			return nil, err
		}
	}
	if scopes == nil {
		scopes = []string{}
	}
	return &Actor{User: u, TokenID: &tokenID, Scopes: scopes, ProjectIDs: projectIDs}, nil
}
