package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
)

// MaxJSONBody caps request bodies decoded by DecodeJSON.
const MaxJSONBody = 1 << 20 // 1 MiB

// HandlerFunc is an http handler that returns an error; see Handle.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// Handle adapts a HandlerFunc: a returned error is rendered with WriteError.
//
//	r.Get("/me", httpx.Handle(s.getMe))
func Handle(fn HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			WriteError(w, r, err)
		}
	}
}

// WriteJSON writes v as JSON with the given status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		slog.Error("encode json response", "err", err)
		http.Error(w, `{"error":{"code":"internal","message":"Internal server error"}}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

// OK writes v with 200.
func OK(w http.ResponseWriter, v any) error { WriteJSON(w, http.StatusOK, v); return nil }

// Created writes v with 201.
func Created(w http.ResponseWriter, v any) error { WriteJSON(w, http.StatusCreated, v); return nil }

// NoContent writes 204.
func NoContent(w http.ResponseWriter) error { w.WriteHeader(http.StatusNoContent); return nil }

// List is the {"data": [...]} envelope used by non-paginated list endpoints.
type List[T any] struct {
	Data []T `json:"data"`
}

// NewList wraps items, never rendering null.
func NewList[T any](items []T) List[T] {
	if items == nil {
		items = []T{}
	}
	return List[T]{Data: items}
}

// DecodeJSON decodes the request body into dst. An empty body leaves dst
// untouched (the mock treats a missing body as {}); malformed JSON or a body
// over MaxJSONBody yields 400 validation_failed.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	body := http.MaxBytesReader(w, r.Body, MaxJSONBody)
	data, err := io.ReadAll(body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return NewError(http.StatusRequestEntityTooLarge, CodeTooLarge, "Request body is too large")
		}
		return BadRequest("Could not read request body")
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, dst); err != nil {
		var te *json.UnmarshalTypeError
		if errors.As(err, &te) && te.Field != "" {
			return BadRequest("Invalid request body", Field(te.Field, "Invalid type"))
		}
		return BadRequest("Invalid JSON body")
	}
	return nil
}

// Optional distinguishes an absent JSON field from an explicit null in PATCH
// bodies:
//
//	FolderID httpx.Optional[string] `json:"folder_id"`
//	// absent → Set=false; null → Set=true, Null=true; "x" → Set=true, Value="x"
type Optional[T any] struct {
	Set   bool
	Null  bool
	Value T
}

// UnmarshalJSON implements json.Unmarshaler.
func (o *Optional[T]) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(bytes.TrimSpace(b)) == "null" {
		o.Null = true
		return nil
	}
	return json.Unmarshal(b, &o.Value)
}

// Ptr returns nil when unset or null, else a pointer to the value.
func (o Optional[T]) Ptr() *T {
	if !o.Set || o.Null {
		return nil
	}
	v := o.Value
	return &v
}
