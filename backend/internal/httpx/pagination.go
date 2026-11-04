package httpx

import (
	"net/http"
	"strconv"
)

// Pagination defaults (mock: limit default 50, max 200; cursor = opaque offset).
const (
	DefaultLimit = 50
	MaxLimit     = 200
)

// PageRequest is a parsed ?limit=&cursor= pair. The cursor is an opaque
// string to clients; today it is the decimal offset, exactly like the mock.
type PageRequest struct {
	Limit  int
	Offset int
}

// Page is the paginated envelope {"data": [...], "next_cursor": "..."|null}.
type Page[T any] struct {
	Data       []T     `json:"data"`
	NextCursor *string `json:"next_cursor"`
}

// ParsePage reads limit/cursor. Missing values use defaults; limit is clamped
// to MaxLimit; non-numeric or negative values yield 400.
func ParsePage(r *http.Request) (PageRequest, error) {
	p := PageRequest{Limit: DefaultLimit}
	q := r.URL.Query()
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return p, BadRequest("limit must be a positive integer", Field("limit", "Must be a positive integer"))
		}
		p.Limit = min(n, MaxLimit)
	}
	if v := q.Get("cursor"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return p, BadRequest("Invalid cursor", Field("cursor", "Invalid cursor"))
		}
		p.Offset = n
	}
	return p, nil
}

// SQL returns LIMIT and OFFSET arguments; LIMIT fetches one extra row so
// NewPage can tell whether another page exists:
//
//	limit, offset := pr.SQL()
//	rows, _ := q.Query(ctx, "... LIMIT $1 OFFSET $2", limit, offset)
//	return httpx.NewPage(items, pr)
func (p PageRequest) SQL() (limit, offset int) { return p.Limit + 1, p.Offset }

// NewPage builds a page from rows fetched with PageRequest.SQL (at most Limit+1 items).
func NewPage[T any](items []T, p PageRequest) Page[T] {
	var next *string
	if len(items) > p.Limit {
		items = items[:p.Limit]
		s := strconv.Itoa(p.Offset + p.Limit)
		next = &s
	}
	if items == nil {
		items = []T{}
	}
	return Page[T]{Data: items, NextCursor: next}
}

// Paginate slices an in-memory list exactly like the mock's page() helper.
func Paginate[T any](all []T, p PageRequest) Page[T] {
	if p.Offset >= len(all) {
		return Page[T]{Data: []T{}}
	}
	end := min(p.Offset+p.Limit+1, len(all))
	return NewPage(all[p.Offset:end], p)
}
