// Package httpx contains HTTP plumbing shared by every API package: JSON
// encoding, the error envelope, middleware (request id, access log, recover,
// CSRF) and pagination. It has no dependency on other QAtlas packages.
package httpx

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
)

// FieldError points at an invalid input field (OpenAPI FieldError).
type FieldError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// APIError is the error type returned by services and handlers. It renders as
// {"error":{"code","message","details"?}} with HTTP status Status.
type APIError struct {
	Status  int
	Code    string
	Message string
	Details []FieldError
}

func (e *APIError) Error() string {
	return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message)
}

// Error codes (docs/13-implementation-guide.md).
const (
	CodeUnauthenticated    = "unauthenticated"
	CodeInvalidCredentials = "invalid_credentials"
	CodeForbidden          = "forbidden"
	CodeNotRegistered      = "not_registered"
	CodeNotFound           = "not_found"
	CodeConflict           = "conflict"
	CodeRevisionConflict   = "revision_conflict"
	CodeInUse              = "in_use"
	CodeValidationFailed   = "validation_failed"
	CodeExpired            = "expired"
	CodeTooLarge           = "too_large"
	CodeRateLimited        = "rate_limited"
	CodeMethodNotAllowed   = "method_not_allowed"
	CodeInternal           = "internal"
)

// NewError builds an APIError.
func NewError(status int, code, message string, details ...FieldError) *APIError {
	return &APIError{Status: status, Code: code, Message: message, Details: details}
}

// Unauthenticated → 401 unauthenticated.
func Unauthenticated(msg string) *APIError {
	return NewError(http.StatusUnauthorized, CodeUnauthenticated, msg)
}

// Forbidden → 403 forbidden.
func Forbidden(msg string) *APIError { return NewError(http.StatusForbidden, CodeForbidden, msg) }

// NotFound → 404 not_found.
func NotFound(msg string) *APIError { return NewError(http.StatusNotFound, CodeNotFound, msg) }

// Conflict → 409 conflict.
func Conflict(msg string, details ...FieldError) *APIError {
	return NewError(http.StatusConflict, CodeConflict, msg, details...)
}

// BadRequest → 400 validation_failed (simple field/rule errors, as the mock does).
func BadRequest(msg string, details ...FieldError) *APIError {
	return NewError(http.StatusBadRequest, CodeValidationFailed, msg, details...)
}

// Unprocessable → 422 validation_failed (semantic validation such as step DSL).
func Unprocessable(msg string, details ...FieldError) *APIError {
	return NewError(http.StatusUnprocessableEntity, CodeValidationFailed, msg, details...)
}

// Expired → 410 expired.
func Expired(msg string) *APIError { return NewError(http.StatusGone, CodeExpired, msg) }

// Field is a shorthand for a single FieldError.
func Field(path, message string) FieldError { return FieldError{Path: path, Message: message} }

type errorBody struct {
	Error errorPayload `json:"error"`
}

type errorPayload struct {
	Code    string       `json:"code"`
	Message string       `json:"message"`
	Details []FieldError `json:"details,omitempty"`
}

// WriteError renders err. *APIError values are written as-is; anything else is
// logged and rendered as a generic 500 so internals never leak to clients.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		slog.ErrorContext(r.Context(), "internal error", "err", err, "method", r.Method, "path", r.URL.Path, "request_id", RequestIDFrom(r.Context()))
		apiErr = NewError(http.StatusInternalServerError, CodeInternal, "Internal server error")
	}
	WriteJSON(w, apiErr.Status, errorBody{Error: errorPayload{Code: apiErr.Code, Message: apiErr.Message, Details: apiErr.Details}})
}
