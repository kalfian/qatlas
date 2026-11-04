package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"unicode/utf8"

	"github.com/google/jsonschema-go/jsonschema"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// handlerFunc is a tool body: it runs as actor and returns the result content.
type handlerFunc[In any] func(ctx context.Context, actor *auth.Actor, in In) (*sdk.CallToolResult, error)

// addTool registers a tool whose input schema is inferred from In (then
// adjusted by tweak, e.g. enums and bounds). The wrapper resolves the actor,
// enforces the token scope and renders errors as tool errors (isError=true)
// with the API's {"error":{code,message,details}} shape plus a hint.
func addTool[In any](s *Server, t *sdk.Tool, scope string, tweak func(*jsonschema.Schema), h handlerFunc[In]) {
	sch, err := jsonschema.For[In](nil)
	if err != nil {
		panic(fmt.Sprintf("mcp tool %s: input schema: %v", t.Name, err))
	}
	if tweak != nil {
		tweak(sch)
	}
	t.InputSchema = sch
	name := t.Name
	sdk.AddTool(s.srv, t, func(ctx context.Context, req *sdk.CallToolRequest, in In) (*sdk.CallToolResult, any, error) {
		actor, err := actorOf(req.Extra)
		if err == nil {
			err = actor.RequireScope(scope)
		}
		if err != nil {
			return s.toolError(ctx, name, err), nil, nil
		}
		res, err := h(ctx, actor, in)
		if err != nil {
			return s.toolError(ctx, name, err), nil, nil
		}
		return res, nil, nil
	})
}

// prop returns a (possibly nested) property schema: prop(s, "definition", "priority").
func prop(s *jsonschema.Schema, path ...string) *jsonschema.Schema {
	for _, p := range path {
		next, ok := s.Properties[p]
		if !ok {
			panic("mcp: schema has no property " + p)
		}
		s = next
	}
	return s
}

func enum(s *jsonschema.Schema, values ...string) {
	s.Enum = make([]any, len(values))
	for i, v := range values {
		s.Enum[i] = v
	}
}

/* ------------------------------------------------------------------ results */

// jsonResult renders v as compact JSON text content.
func jsonResult(v any) (*sdk.CallToolResult, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: string(b)}}}, nil
}

// hintedError attaches advice for the AI to an API error.
type hintedError struct {
	err  *httpx.APIError
	hint string
}

func (h *hintedError) Error() string { return h.err.Error() }
func (h *hintedError) Unwrap() error { return h.err }

func withHint(err *httpx.APIError, hint string) error { return &hintedError{err: err, hint: hint} }

type toolErrorBody struct {
	Error struct {
		Code    string             `json:"code"`
		Message string             `json:"message"`
		Details []httpx.FieldError `json:"details,omitempty"`
	} `json:"error"`
	Hint string `json:"hint,omitempty"`
}

// toolError converts err into an isError tool result. Non-API errors are
// logged and reported generically so internals never leak.
func (s *Server) toolError(ctx context.Context, tool string, err error) *sdk.CallToolResult {
	var body toolErrorBody
	var apiErr *httpx.APIError
	switch {
	case errors.As(err, &apiErr):
		body.Error.Code, body.Error.Message, body.Error.Details = apiErr.Code, apiErr.Message, apiErr.Details
		var h *hintedError
		if errors.As(err, &h) {
			body.Hint = h.hint
		} else {
			body.Hint = defaultHint(apiErr)
		}
	case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded):
		body.Error.Code, body.Error.Message = "cancelled", "The request was cancelled"
	default:
		s.log.ErrorContext(ctx, "mcp tool failed", "tool", tool, "err", err)
		body.Error.Code, body.Error.Message = httpx.CodeInternal, "Internal server error"
		body.Hint = "Retry later; if it keeps failing, tell the user to check the QAtlas server logs."
	}
	b, _ := json.Marshal(body)
	return &sdk.CallToolResult{IsError: true, Content: []sdk.Content{&sdk.TextContent{Text: string(b)}}}
}

func defaultHint(e *httpx.APIError) string {
	switch {
	case e.Status == http.StatusNotFound:
		return "Check the key/name: use list_projects, list_test_cases, list_flows or list_runs. Keys look like SHOP, SHOP-T12, SHOP-F3, SHOP-R210."
	case e.Status == http.StatusForbidden:
		return "The API token's user or scopes do not allow this (scopes: read = list/get, write = create/update, run = run/cancel). Ask the user for a token or role with the needed permission."
	case e.Code == httpx.CodeValidationFailed:
		return "Fix every listed path (step DSL: get_step_schema) and call validate_test_case before retrying."
	case e.Status == http.StatusConflict:
		return "Re-read the current state (get_* tool) before retrying."
	case e.Status == http.StatusUnauthorized:
		return "The API token is invalid, expired or revoked; ask the user for a new token."
	}
	return ""
}

/* ------------------------------------------------------------------ truncation */

// truncate shortens s to at most n runes, marking the cut.
func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + fmt.Sprintf("… [truncated, %d more chars]", len(r)-n)
}

func truncatePtr(s *string, n int) *string {
	if s == nil {
		return nil
	}
	t := truncate(*s, n)
	return &t
}

// truncateJSON keeps small JSON values verbatim and turns large ones into a
// truncated string (nil for JSON null / empty).
func truncateJSON(raw json.RawMessage, n int) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	if len(raw) <= n {
		return raw
	}
	return truncate(string(raw), n)
}

func itoa(n int) string { return strconv.Itoa(n) }
