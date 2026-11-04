package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Hub fans out run events received via LISTEN on Channel to in-process
// subscribers, keyed by run key.
//
// The LISTEN connection is dedicated (not from the pool) and opened lazily on
// the first Subscribe; it reconnects with exponential backoff (0.5 s … 30 s).
// After a reconnect every subscriber receives a synthetic RunUpdated event so
// clients re-fetch whatever they may have missed.
type Hub struct {
	cfg    *pgx.ConnConfig
	logger *slog.Logger

	mu      sync.Mutex
	subs    map[string]map[*Subscription]struct{}
	started bool
	closed  bool
	cancel  context.CancelFunc
	done    chan struct{}
	ready   chan struct{} // closed once the first LISTEN succeeded
}

// SubscriberBuffer is the per-subscriber channel capacity. When a slow
// subscriber's buffer is full further events are dropped for it (clients
// re-fetch the whole run on every event, so the latest one is enough).
const SubscriberBuffer = 16

// readyWait bounds how long Subscribe waits for the first LISTEN.
const readyWait = 5 * time.Second

// NewHub creates a hub listening with a copy of cfg (typically
// pool.Config().ConnConfig). application_name defaults to "qatlas-events".
func NewHub(cfg *pgx.ConnConfig, logger *slog.Logger) *Hub {
	if logger == nil {
		logger = slog.Default()
	}
	c := cfg.Copy()
	if c.RuntimeParams == nil {
		c.RuntimeParams = map[string]string{}
	}
	if c.RuntimeParams["application_name"] == "" {
		c.RuntimeParams["application_name"] = "qatlas-events"
	}
	return &Hub{
		cfg:    c,
		logger: logger,
		subs:   map[string]map[*Subscription]struct{}{},
		ready:  make(chan struct{}),
	}
}

// Subscription receives events for one run key. C is closed when the hub closes.
type Subscription struct {
	C      <-chan Event
	ch     chan Event
	hub    *Hub
	runKey string
	once   sync.Once
}

// ErrClosed is returned by Subscribe after Close.
var ErrClosed = errors.New("events hub closed")

// Subscribe registers interest in runKey. It starts the listener if needed and
// waits (up to 5 s or ctx) until LISTEN is active, so events notified after
// Subscribe returns are delivered. Always Close the subscription.
func (h *Hub) Subscribe(ctx context.Context, runKey string) (*Subscription, error) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, ErrClosed
	}
	ch := make(chan Event, SubscriberBuffer)
	s := &Subscription{C: ch, ch: ch, hub: h, runKey: runKey}
	if h.subs[runKey] == nil {
		h.subs[runKey] = map[*Subscription]struct{}{}
	}
	h.subs[runKey][s] = struct{}{}
	if !h.started {
		h.started = true
		lctx, cancel := context.WithCancel(context.Background())
		h.cancel = cancel
		h.done = make(chan struct{})
		go h.listen(lctx)
	}
	ready := h.ready
	h.mu.Unlock()

	t := time.NewTimer(readyWait)
	defer t.Stop()
	select {
	case <-ready:
	case <-t.C:
		h.logger.Warn("events hub: LISTEN not ready yet, subscribing anyway", "run_key", runKey)
	case <-ctx.Done():
		s.Close()
		return nil, ctx.Err()
	}
	return s, nil
}

// Close unregisters the subscription (idempotent).
func (s *Subscription) Close() {
	s.once.Do(func() {
		h := s.hub
		h.mu.Lock()
		defer h.mu.Unlock()
		if set, ok := h.subs[s.runKey]; ok {
			if _, ok := set[s]; ok {
				delete(set, s)
				close(s.ch)
			}
			if len(set) == 0 {
				delete(h.subs, s.runKey)
			}
		}
	})
}

// Publish delivers ev to the subscribers of ev.RunKey (non-blocking). The
// listener calls it for every notification; an in-process bus (qatlas all)
// may call it directly.
func (h *Hub) Publish(ev Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs[ev.RunKey] {
		select {
		case s.ch <- ev:
		default:
		}
	}
}

func (h *Hub) broadcastResync() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, set := range h.subs {
		for s := range set {
			select {
			case s.ch <- Event{Type: RunUpdated, RunKey: key}:
			default:
			}
		}
	}
}

// Close stops the listener and closes every subscription channel (so SSE
// handlers return). Wire it to http.Server.RegisterOnShutdown.
func (h *Hub) Close() {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	cancel, done := h.cancel, h.done
	for key, set := range h.subs {
		for s := range set {
			close(s.ch)
		}
		delete(h.subs, key)
	}
	h.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
}

func (h *Hub) listen(ctx context.Context) {
	defer close(h.done)
	const minBackoff, maxBackoff = 500 * time.Millisecond, 30 * time.Second
	backoff := minBackoff
	connectedBefore := false
	var readyOnce sync.Once
	for ctx.Err() == nil {
		err := h.listenOnce(ctx, func() {
			backoff = minBackoff
			readyOnce.Do(func() { close(h.ready) })
			if connectedBefore {
				h.broadcastResync()
			}
			connectedBefore = true
		})
		if ctx.Err() != nil {
			return
		}
		h.logger.Warn("events hub: listener disconnected, reconnecting", "err", err, "backoff", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

func (h *Hub) listenOnce(ctx context.Context, onListening func()) error {
	conn, err := pgx.ConnectConfig(ctx, h.cfg.Copy())
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, "LISTEN "+pgx.Identifier{Channel}.Sanitize()); err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	onListening()
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		var ev Event
		if err := json.Unmarshal([]byte(n.Payload), &ev); err != nil || ev.RunKey == "" {
			h.logger.Warn("events hub: ignoring malformed payload", "payload", n.Payload)
			continue
		}
		h.Publish(ev)
	}
}

// HeartbeatInterval is the SSE keep-alive comment interval.
var HeartbeatInterval = 15 * time.Second

// ServeSSE streams the events of runKey as text/event-stream until the client
// disconnects or the hub closes. Authorisation is the caller's job. Frames:
//
//	: connected            (once, after the subscription is active)
//	event: <type>
//	data: <Event JSON>
//	: ping                 (every HeartbeatInterval)
func ServeSSE(w http.ResponseWriter, r *http.Request, h *Hub, runKey string) error {
	sub, err := h.Subscribe(r.Context(), runKey)
	if err != nil {
		return err
	}
	defer sub.Close()

	rc := http.NewResponseController(w)
	hd := w.Header()
	hd.Set("Content-Type", "text/event-stream")
	hd.Set("Cache-Control", "no-cache, no-transform")
	hd.Set("Connection", "keep-alive")
	hd.Set("X-Accel-Buffering", "no") // nginx: don't buffer the stream
	w.WriteHeader(http.StatusOK)
	if _, err := fmt.Fprint(w, "retry: 3000\n: connected\n\n"); err != nil {
		return nil
	}
	if err := rc.Flush(); err != nil {
		return nil
	}

	tick := time.NewTicker(HeartbeatInterval)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return nil
		case ev, ok := <-sub.C:
			if !ok {
				return nil // hub closed (shutdown)
			}
			data, err := json.Marshal(ev)
			if err != nil {
				return nil
			}
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Type, data); err != nil {
				return nil
			}
		case <-tick.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return nil
			}
		}
		if err := rc.Flush(); err != nil {
			return nil
		}
	}
}
