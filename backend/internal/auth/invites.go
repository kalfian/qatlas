package auth

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Invite kinds.
const (
	InviteKindInvite = "invite"
	InviteKindReset  = "reset_password"
)

// CreateInvite invalidates the user's open invites and issues a new one-time
// link valid for InviteTTL. It returns the raw token (only ever shown once).
func CreateInvite(ctx context.Context, q db.Querier, userID uuid.UUID, kind string, createdBy *uuid.UUID) (token string, expiresAt time.Time, err error) {
	if err := InvalidateInvites(ctx, q, userID); err != nil {
		return "", time.Time{}, err
	}
	token = randomToken(32)
	err = q.QueryRow(ctx, `
		INSERT INTO invites (id, user_id, kind, token_hash, expires_at, created_by)
		VALUES ($1, $2, $3, $4, now() + $5 * interval '1 second', $6)
		RETURNING expires_at`,
		db.NewID(), userID, kind, hashToken(token), seconds(InviteTTL), createdBy).Scan(&expiresAt)
	return token, expiresAt.UTC(), err
}

// InvalidateInvites marks every open invite/reset link of the user as used.
func InvalidateInvites(ctx context.Context, q db.Querier, userID uuid.UUID) error {
	_, err := q.Exec(ctx, `UPDATE invites SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, userID)
	return err
}

// InviteURL is the link handed to the user: QATLAS_BASE_URL/invite/<token>.
func (s *Service) InviteURL(token string) string {
	return s.cfg.BaseURL + "/invite/" + token
}

// InviteInfo is the OpenAPI InviteInfo schema.
type InviteInfo struct {
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Kind      string    `json:"kind"`
	ExpiresAt time.Time `json:"expires_at"`
}

func errInviteExpired() *httpx.APIError {
	return httpx.Expired("This invite link has already been used or has expired")
}

type inviteRow struct {
	id      uuid.UUID
	kind    string
	expires time.Time
	usable  bool
	user    User
}

func loadInvite(ctx context.Context, q db.Querier, token string, forUpdate bool) (inviteRow, error) {
	lock := ""
	if forUpdate {
		lock = " FOR UPDATE OF i, u"
	}
	var row inviteRow
	u, err := ScanUser(q.QueryRow(ctx, `
		SELECT `+UserColumns+`, i.id, i.kind, i.expires_at, (i.used_at IS NULL AND i.expires_at > now())
		FROM invites i JOIN users u ON u.id = i.user_id
		WHERE i.token_hash = $1`+lock, hashToken(token)),
		&row.id, &row.kind, &row.expires, &row.usable)
	row.user = u
	return row, err
}

// GetInvite returns invite info: 404 for unknown tokens, 410 when used,
// expired or the user is disabled.
func (s *Service) GetInvite(ctx context.Context, token string) (InviteInfo, error) {
	row, err := loadInvite(ctx, s.pool, token, false)
	if db.IsNoRows(err) {
		return InviteInfo{}, httpx.NotFound("Invite link is invalid")
	}
	if err != nil {
		return InviteInfo{}, err
	}
	if !row.usable || row.user.Status == StatusDisabled {
		return InviteInfo{}, errInviteExpired()
	}
	return InviteInfo{Email: row.user.Email, Name: row.user.Name, Kind: row.kind, ExpiresAt: row.expires.UTC()}, nil
}

// AcceptInviteInput is the accept body.
type AcceptInviteInput struct {
	Password string `json:"password"`
}

// AcceptInvite sets the password, activates the user, consumes every open
// link of the user, signs them in (cookie) and returns Me. Like the mock,
// an unknown token is 410 here (not 404).
func (s *Service) AcceptInvite(ctx context.Context, w http.ResponseWriter, r *http.Request, token string, in AcceptInviteInput) (Me, error) {
	var me Me
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		row, err := loadInvite(ctx, tx, token, true)
		if db.IsNoRows(err) {
			return errInviteExpired()
		}
		if err != nil {
			return err
		}
		if !row.usable || row.user.Status == StatusDisabled {
			return errInviteExpired()
		}
		if err := CheckPasswordLength("password", in.Password); err != nil {
			return err
		}
		hash, err := HashPassword(in.Password)
		if err != nil {
			return err
		}
		u, err := ScanUser(tx.QueryRow(ctx, `
			UPDATE users u SET password_hash = $2, status = 'active', last_login_at = now(), updated_at = now()
			WHERE u.id = $1 RETURNING `+UserColumns, row.user.ID, hash))
		if err != nil {
			return err
		}
		if err := InvalidateInvites(ctx, tx, u.ID); err != nil {
			return err
		}
		if row.kind == InviteKindReset {
			// A password reset signs out every other device.
			if err := DeleteUserSessions(ctx, tx, u.ID, nil); err != nil {
				return err
			}
		}
		if err := s.startSession(ctx, tx, w, r, u.ID); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, &Actor{User: u}, audit.ActionInviteAccepted, "user", u.ID.String(), nil,
			audit.Meta{"kind": row.kind, "ip": httpx.ClientIPFrom(ctx)}); err != nil {
			return err
		}
		me, err = LoadMe(ctx, tx, u)
		return err
	})
	return me, err
}
