package artifacts

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
)

// Probe check names (OpenAPI StorageTestResult.checks[].name).
const (
	CheckConnect = "connect"
	CheckBucket  = "bucket"
	CheckWrite   = "write"
	CheckRead    = "read"
	CheckDelete  = "delete"
)

// ProbeCheck is one step of Probe.
type ProbeCheck struct {
	Name     string
	OK       bool
	Message  string
	Duration time.Duration
}

// probeContent is written, read back and deleted by Probe.
var probeContent = []byte("qatlas storage probe")

// Probe checks a store step by step — connect, bucket, write, read, delete —
// with a probe object ".qatlas-probe-<uuid>" that is always removed again.
// It returns one result per check, in that order; checks that cannot run after
// an earlier failure are reported as not ok ("skipped …"). Messages never
// contain credentials.
func Probe(ctx context.Context, s Store) []ProbeCheck {
	var out []ProbeCheck
	failed := false
	run := func(name string, fn func() (string, error)) {
		if failed {
			out = append(out, ProbeCheck{Name: name, Message: "Skipped: an earlier check failed"})
			return
		}
		start := time.Now()
		msg, err := fn()
		r := ProbeCheck{Name: name, OK: err == nil, Message: msg, Duration: time.Since(start)}
		if err != nil {
			r.Message = err.Error()
			failed = true
		}
		out = append(out, r)
	}

	var bucketErr error
	switch st := s.(type) {
	case *S3Store:
		run(CheckConnect, func() (string, error) {
			reached, err := st.checkBucket(ctx)
			if !reached {
				return "", err
			}
			bucketErr = err
			return "Reached " + st.endpoint, nil
		})
		run(CheckBucket, func() (string, error) {
			if bucketErr != nil {
				return "", bucketErr
			}
			return fmt.Sprintf("Bucket %q is accessible", st.bucket), nil
		})
	default:
		run(CheckConnect, func() (string, error) {
			if p, ok := s.(Pinger); ok {
				if err := p.Ping(ctx); err != nil {
					return "", err
				}
			}
			return "Local data directory is available", nil
		})
		run(CheckBucket, func() (string, error) { return "Not needed for local storage", nil })
	}

	key := ".qatlas-probe-" + uuid.NewString()
	written := false
	run(CheckWrite, func() (string, error) {
		if err := s.Put(ctx, key, bytes.NewReader(probeContent), int64(len(probeContent)), "text/plain"); err != nil {
			return "", fmt.Errorf("write probe object: %w", err)
		}
		written = true
		return "Probe object written", nil
	})
	run(CheckRead, func() (string, error) {
		f, _, err := s.Open(ctx, key)
		if err != nil {
			return "", fmt.Errorf("read probe object: %w", err)
		}
		defer f.Close()
		got, err := io.ReadAll(io.LimitReader(f, int64(len(probeContent))+1))
		if err != nil {
			return "", fmt.Errorf("read probe object: %w", err)
		}
		if !bytes.Equal(got, probeContent) {
			return "", errors.New("read probe object: content differs from what was written")
		}
		return "Probe object read back", nil
	})
	if written && failed {
		// The read failed: still try to clean up, but keep reporting the read failure.
		_ = s.Delete(context.WithoutCancel(ctx), key)
	}
	run(CheckDelete, func() (string, error) {
		if err := s.Delete(ctx, key); err != nil {
			return "", fmt.Errorf("delete probe object: %w", err)
		}
		return "Probe object deleted", nil
	})
	return out
}

// ProbeError is the first failed check of results as an error (nil when all passed).
func ProbeError(results []ProbeCheck) error {
	for _, r := range results {
		if !r.OK {
			return fmt.Errorf("%s: %s", r.Name, r.Message)
		}
	}
	return nil
}
