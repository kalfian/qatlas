package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"

	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Argon2Params are the argon2id cost parameters. They are encoded into every
// hash (PHC string), so raising them later only affects new hashes.
type Argon2Params struct {
	Memory  uint32 // KiB
	Time    uint32
	Threads uint8
	SaltLen uint32
	KeyLen  uint32
}

// DefaultArgon2 matches docs/13: m=64MiB, t=3, p=2.
var DefaultArgon2 = Argon2Params{Memory: 64 * 1024, Time: 3, Threads: 2, SaltLen: 16, KeyLen: 32}

// MinPasswordLength is enforced on invite accept, password change and
// `qatlas user create-admin` (bytes, like the web's length hint for ASCII).
const MinPasswordLength = 8

// CheckPasswordLength returns 400 validation_failed (detail path field) when
// password is shorter than MinPasswordLength.
func CheckPasswordLength(field, password string) error {
	if len(password) >= MinPasswordLength {
		return nil
	}
	return httpx.BadRequest(fmt.Sprintf("Password must be at least %d characters", MinPasswordLength),
		httpx.Field(field, fmt.Sprintf("At least %d characters", MinPasswordLength)))
}

var b64 = base64.RawStdEncoding

// HashPassword returns a PHC-encoded argon2id hash:
// $argon2id$v=19$m=65536,t=3,p=2$<salt>$<hash>
func HashPassword(password string) (string, error) {
	return hashWith(password, DefaultArgon2)
}

func hashWith(password string, p Argon2Params) (string, error) {
	salt := make([]byte, p.SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, p.Time, p.Memory, p.Threads, p.KeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.Memory, p.Time, p.Threads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

var errBadHash = errors.New("malformed argon2id hash")

// VerifyPassword reports whether password matches the encoded hash. A
// malformed hash returns an error (and false).
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errBadHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errBadHash
	}
	var p Argon2Params
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.Memory, &p.Time, &p.Threads); err != nil {
		return false, errBadHash
	}
	if p.Memory == 0 || p.Time == 0 || p.Threads == 0 || p.Memory > 1<<22 || p.Time > 64 {
		return false, errBadHash
	}
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, errBadHash
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false, errBadHash
	}
	got := argon2.IDKey([]byte(password), salt, p.Time, p.Memory, p.Threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// dummyHash is verified against when the user does not exist, so login
// timing does not reveal whether an account exists.
var dummyHash = sync.OnceValue(func() string {
	h, err := HashPassword("qatlas-timing-equaliser")
	if err != nil {
		panic(err)
	}
	return h
})
