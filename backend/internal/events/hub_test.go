package events_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/db/testutil"
	"github.com/kalfian/qatlas/backend/internal/events"
)

func recv(t *testing.T, s *events.Subscription) events.Event {
	t.Helper()
	select {
	case ev, ok := <-s.C:
		if !ok {
			t.Fatal("subscription closed")
		}
		return ev
	case <-time.After(10 * time.Second):
		t.Fatal("timeout waiting for event")
	}
	return events.Event{}
}

func TestHubFanOutAndReconnect(t *testing.T) {
	pool := testutil.DB(t)
	ctx := context.Background()
	cfg := pool.Config().ConnConfig
	appName := "qatlas-events-test-" + uuid.NewString()[:8]
	cfg.RuntimeParams["application_name"] = appName
	hub := events.NewHub(cfg, nil)
	defer hub.Close()

	// Unique keys: NOTIFY is database-wide and other packages test in parallel.
	keyA, keyB := "T"+uuid.NewString()[:6]+"-R1", "T"+uuid.NewString()[:6]+"-R2"
	a1, err := hub.Subscribe(ctx, keyA)
	if err != nil {
		t.Fatal(err)
	}
	a2, _ := hub.Subscribe(ctx, keyA)
	b, _ := hub.Subscribe(ctx, keyB)

	if err := events.Notify(ctx, pool, events.Event{Type: events.StepStarted, RunKey: keyA, RunStepID: "s1"}); err != nil {
		t.Fatal(err)
	}
	for _, s := range []*events.Subscription{a1, a2} {
		if ev := recv(t, s); ev.Type != events.StepStarted || ev.RunStepID != "s1" {
			t.Fatalf("event: %+v", ev)
		}
	}
	select {
	case ev := <-b.C:
		t.Fatalf("subscriber of another run got %+v", ev)
	case <-time.After(200 * time.Millisecond):
	}

	// Kill the LISTEN connection: the hub reconnects and asks clients to resync.
	var killed bool
	if err := pool.QueryRow(ctx, `SELECT bool_or(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name = $1`, appName).Scan(&killed); err != nil || !killed {
		t.Fatalf("terminate listener: %v %v", killed, err)
	}
	if ev := recv(t, b); ev.Type != events.RunUpdated || ev.RunKey != keyB {
		t.Fatalf("resync event: %+v", ev)
	}
	recv(t, a1) // resync
	if err := events.Notify(ctx, pool, events.Event{Type: events.RunFinished, RunKey: keyA, Status: "passed"}); err != nil {
		t.Fatal(err)
	}
	if ev := recv(t, a1); ev.Type != events.RunFinished || ev.Status != "passed" {
		t.Fatalf("after reconnect: %+v", ev)
	}

	// Close ends subscriptions; Subscribe after Close fails.
	a2.Close()
	a2.Close() // idempotent
	hub.Close()
	for range b.C { // drains buffered events; ends because Close closed the channel
	}
	if _, err := hub.Subscribe(ctx, keyA); err != events.ErrClosed {
		t.Fatalf("subscribe after close: %v", err)
	}
	a1.Close()
}
