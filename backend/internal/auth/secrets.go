package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"regexp"
)

// randomToken returns n random bytes encoded as unpadded base64url.
func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b) // crypto/rand.Read never returns an error on supported platforms
	return base64.RawURLEncoding.EncodeToString(b)
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// hashToken is the at-rest form of session, invite and API token secrets.
func hashToken(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// API token format: qat_<8 hex prefix>_<32 hex secret>.
var apiTokenPattern = regexp.MustCompile(`^qat_[0-9a-f]{8}_[0-9a-f]{32}$`)

// newAPIToken returns (prefix "qat_xxxxxxxx", full secret).
func newAPIToken() (prefix, secret string) {
	prefix = "qat_" + randomHex(4)
	return prefix, prefix + "_" + randomHex(16)
}
