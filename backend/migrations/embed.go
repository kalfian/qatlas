// Package migrations embeds the goose SQL migrations (0001_*.sql, 0002_*.sql …).
//
// Add a new file with the next number; never edit a migration that has shipped.
// River's own tables are migrated separately by the worker (rivermigrate).
package migrations

import "embed"

// FS holds every *.sql migration in this directory.
//
//go:embed *.sql
var FS embed.FS
