package mcp

import (
	"context"
	"errors"
	"net/http"
	"strings"

	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

const actorExtraKey = "qatlas_actor"

// authenticate accepts only "Authorization: Bearer qat_…". Cookies are ignored
// (so CSRF does not apply); a missing or invalid token is a 401 with the API's
// JSON error envelope and a WWW-Authenticate challenge.
func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !httpx.HasBearer(r) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="qatlas"`)
			httpx.WriteError(w, r, httpx.Unauthenticated("The MCP endpoint requires an API token: Authorization: Bearer qat_…"))
			return
		}
		secret := strings.TrimSpace(r.Header.Get("Authorization")[7:])
		actor, err := s.auth.AuthenticateAPIToken(r.Context(), secret)
		if err != nil {
			var apiErr *httpx.APIError
			if errors.As(err, &apiErr) && apiErr.Status == http.StatusUnauthorized {
				w.Header().Set("WWW-Authenticate", `Bearer realm="qatlas", error="invalid_token"`)
			}
			httpx.WriteError(w, r, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(auth.WithActor(r.Context(), actor)))
	})
}

// tokenInfoFromActor is the SDK TokenVerifier: the token was already verified
// by authenticate, so it only wraps the actor. UserID lets the SDK reject a
// session reused by another user (relevant only if sessions are ever enabled).
func tokenInfoFromActor(ctx context.Context, _ string, _ *http.Request) (*sdkauth.TokenInfo, error) {
	a := auth.ActorFrom(ctx)
	if a == nil || a.TokenID == nil {
		return nil, sdkauth.ErrInvalidToken
	}
	return &sdkauth.TokenInfo{
		UserID: a.User.ID.String(),
		Scopes: a.Scopes,
		Extra:  map[string]any{actorExtraKey: a},
	}, nil
}

// actorOf returns the authenticated actor of an MCP request.
func actorOf(extra *sdk.RequestExtra) (*auth.Actor, error) {
	if extra != nil && extra.TokenInfo != nil {
		if a, ok := extra.TokenInfo.Extra[actorExtraKey].(*auth.Actor); ok && a != nil {
			return a, nil
		}
	}
	return nil, httpx.Unauthenticated("Missing API token")
}
