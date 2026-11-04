package auth

import "context"

// AuthenticateAPIToken resolves a raw API token secret ("qat_<prefix>_<secret>",
// without the "Bearer " prefix) to an Actor. Invalid, expired or revoked tokens
// and disabled users yield a 401 *httpx.APIError. Used by surfaces that accept
// only API tokens (the MCP endpoint), never cookies.
func (s *Service) AuthenticateAPIToken(ctx context.Context, secret string) (*Actor, error) {
	return s.authenticateToken(ctx, secret)
}
