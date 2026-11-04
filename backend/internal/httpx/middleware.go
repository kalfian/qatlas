package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

type ctxKey int

const (
	requestIDKey ctxKey = iota
	clientIPKey
)

// RequestIDHeader is echoed on every response.
const RequestIDHeader = "X-Request-ID"

var validRequestID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// RequestID assigns a request id (honouring a sane incoming X-Request-ID).
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(RequestIDHeader)
		if !validRequestID.MatchString(id) {
			var b [8]byte
			_, _ = rand.Read(b[:])
			id = hex.EncodeToString(b[:])
		}
		w.Header().Set(RequestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

// RequestIDFrom returns the request id stored by RequestID.
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// ClientIP stores the client IP in the context. With trustProxy it prefers
// X-Real-IP, then the right-most X-Forwarded-For entry (the one appended by
// our own proxy); otherwise it uses the TCP peer address.
func ClientIP(trustProxy bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := peerIP(r.RemoteAddr)
			if trustProxy {
				if v := strings.TrimSpace(r.Header.Get("X-Real-IP")); net.ParseIP(v) != nil {
					ip = v
				} else if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
					parts := strings.Split(xff, ",")
					if v := strings.TrimSpace(parts[len(parts)-1]); net.ParseIP(v) != nil {
						ip = v
					}
				}
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), clientIPKey, ip)))
		})
	}
}

// ClientIPFrom returns the IP stored by ClientIP (or "" when absent).
func ClientIPFrom(ctx context.Context) string {
	ip, _ := ctx.Value(clientIPKey).(string)
	return ip
}

func peerIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}

// AccessLog logs one line per request with slog.
func AccessLog(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)
			status := ww.Status()
			if status == 0 {
				status = http.StatusOK
			}
			level := slog.LevelInfo
			switch {
			case status >= 500:
				level = slog.LevelError
			case r.URL.Path == "/healthz" || r.URL.Path == "/readyz":
				level = slog.LevelDebug
			}
			logger.LogAttrs(r.Context(), level, "http request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", status),
				slog.Int("bytes", ww.BytesWritten()),
				slog.Duration("duration", time.Since(start)),
				slog.String("ip", ClientIPFrom(r.Context())),
				slog.String("request_id", RequestIDFrom(r.Context())),
			)
		})
	}
}

// Recover turns panics into a logged 500 JSON error.
func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if p := recover(); p != nil {
				if p == http.ErrAbortHandler {
					panic(p)
				}
				slog.ErrorContext(r.Context(), "panic", "panic", p, "stack", string(debug.Stack()), "request_id", RequestIDFrom(r.Context()))
				WriteJSON(w, http.StatusInternalServerError, errorBody{Error: errorPayload{Code: CodeInternal, Message: "Internal server error"}})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// CSRFHeader must be "1" on mutating requests that are not Bearer-authenticated.
const CSRFHeader = "X-QAtlas-CSRF"

// IsSafeMethod reports GET/HEAD/OPTIONS.
func IsSafeMethod(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions
}

// HasBearer reports whether the request carries an Authorization: Bearer header.
func HasBearer(r *http.Request) bool {
	h := r.Header.Get("Authorization")
	return len(h) > 7 && strings.EqualFold(h[:7], "bearer ")
}

// CSRF rejects mutating requests without "X-QAtlas-CSRF: 1" unless they are
// Bearer-authenticated. A custom header cannot be sent cross-site without a
// CORS preflight, which QAtlas never grants. The check applies to every
// non-Bearer mutation (including login / invite accept, which set cookies),
// not only to requests that already carry a session cookie.
func CSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !IsSafeMethod(r.Method) && !HasBearer(r) && r.Header.Get(CSRFHeader) != "1" {
			WriteError(w, r, Forbidden("Missing "+CSRFHeader+" header"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// NotFoundHandler renders a JSON 404 (mount on API routers).
func NotFoundHandler(w http.ResponseWriter, r *http.Request) {
	WriteError(w, r, NotFound("Route not found"))
}

// MethodNotAllowedHandler renders a JSON 405.
func MethodNotAllowedHandler(w http.ResponseWriter, r *http.Request) {
	WriteError(w, r, NewError(http.StatusMethodNotAllowed, CodeMethodNotAllowed, "Method not allowed"))
}
