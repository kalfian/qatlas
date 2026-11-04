// Package secrets encrypts environment secret values at rest with
// AES-256-GCM under QATLAS_MASTER_KEY (docs/13 "Secrets").
//
// Sealed format: nonce (12 bytes) ‖ ciphertext+tag, stored in
// environment_secrets.value_enc. Values are decrypted only by the worker when
// it builds run.start (ForEnvironment); the API never returns them.
//
// Nothing in this package logs, and errors never contain plaintext.
package secrets

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/db"
)

// KeySize is the master key length (AES-256).
const KeySize = 32

var (
	// ErrKeySize is returned when the master key is not exactly KeySize bytes.
	ErrKeySize = errors.New("secrets: master key must be 32 bytes")
	// ErrMalformed is returned when a sealed value is too short to be valid.
	ErrMalformed = errors.New("secrets: sealed value is malformed")
	// ErrDecrypt is returned when authentication fails (wrong key or tampered data).
	ErrDecrypt = errors.New("secrets: decryption failed (wrong master key or corrupted value)")
)

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != KeySize {
		return nil, ErrKeySize
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("secrets: %w", err)
	}
	return cipher.NewGCM(block)
}

// Seal encrypts plaintext with a fresh random nonce and returns nonce‖ciphertext.
func Seal(key, plaintext []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize(), gcm.NonceSize()+len(plaintext)+gcm.Overhead())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("secrets: nonce: %w", err)
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// Open decrypts a value produced by Seal.
func Open(key, sealed []byte) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize()+gcm.Overhead() {
		return nil, ErrMalformed
	}
	nonce, ct := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, ErrDecrypt
	}
	return pt, nil
}

// ForEnvironment decrypts every secret of an environment into name → value.
// An environment without secrets (or an unknown id) yields an empty map.
// Errors name the failing secret but never include a value.
func ForEnvironment(ctx context.Context, q db.Querier, envID uuid.UUID, key []byte) (map[string]string, error) {
	if len(key) != KeySize {
		return nil, ErrKeySize
	}
	rows, err := q.Query(ctx, `SELECT name, value_enc FROM environment_secrets WHERE environment_id = $1 ORDER BY name`, envID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var (
			name   string
			sealed []byte
		)
		if err := rows.Scan(&name, &sealed); err != nil {
			return nil, err
		}
		pt, err := Open(key, sealed)
		if err != nil {
			return nil, fmt.Errorf("secret %s: %w", name, err)
		}
		out[name] = string(pt)
	}
	return out, rows.Err()
}
