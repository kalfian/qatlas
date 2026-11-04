package projects

import (
	"encoding/json"
	"errors"
	"slices"

	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Viewport is RunOptions.viewport.
type Viewport struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// RunOptions is the OpenAPI RunOptions schema (projects.default_run_options).
type RunOptions struct {
	Browser       string   `json:"browser"`
	Headless      bool     `json:"headless"`
	Viewport      Viewport `json:"viewport"`
	Screenshot    string   `json:"screenshot"`
	Video         string   `json:"video"`
	StepTimeoutMS int      `json:"step_timeout_ms"`
	Retries       int      `json:"retries"`
}

// DefaultRunOptions mirrors the mock's DEFAULT_RUN_OPTIONS (and the column default).
func DefaultRunOptions() RunOptions {
	return RunOptions{
		Browser:       "chromium",
		Headless:      true,
		Viewport:      Viewport{Width: 1280, Height: 720},
		Screenshot:    "on_failure",
		Video:         "off",
		StepTimeoutMS: 10000,
		Retries:       0,
	}
}

// MergeRunOptions applies JSON object layers over DefaultRunOptions, later
// layers winning (mock: {...DEFAULT_RUN_OPTIONS, ...project.default_run_options,
// ...partial}). Absent or null keys keep the previous value; unknown keys are
// ignored. Nested viewport keys merge individually.
func MergeRunOptions(layers ...json.RawMessage) (RunOptions, error) {
	o := DefaultRunOptions()
	for _, l := range layers {
		if len(l) == 0 || string(l) == "null" {
			continue
		}
		if err := json.Unmarshal(l, &o); err != nil {
			return RunOptions{}, err
		}
	}
	return o, nil
}

// Validation limits (same as the web settings form; retries per OpenAPI).
var (
	browsers    = []string{"chromium", "firefox", "webkit"}
	screenshots = []string{"off", "on_failure", "every_step"}
	videos      = []string{"off", "on_failure", "always"}
)

// Validate checks enums and ranges; field paths are prefixed with prefix
// (e.g. "default_run_options.").
func (o RunOptions) Validate(prefix string) []httpx.FieldError {
	var errs []httpx.FieldError
	add := func(path, msg string) { errs = append(errs, httpx.Field(prefix+path, msg)) }
	if !slices.Contains(browsers, o.Browser) {
		add("browser", "Use chromium, firefox or webkit")
	}
	if o.Viewport.Width < 320 || o.Viewport.Width > 3840 {
		add("viewport.width", "Must be between 320 and 3840")
	}
	if o.Viewport.Height < 320 || o.Viewport.Height > 2160 {
		add("viewport.height", "Must be between 320 and 2160")
	}
	if !slices.Contains(screenshots, o.Screenshot) {
		add("screenshot", "Use off, on_failure or every_step")
	}
	if !slices.Contains(videos, o.Video) {
		add("video", "Use off, on_failure or always")
	}
	if o.StepTimeoutMS < 1000 || o.StepTimeoutMS > 600000 {
		add("step_timeout_ms", "Must be between 1000 and 600000")
	}
	if o.Retries < 0 || o.Retries > 2 {
		add("retries", "Must be between 0 and 2")
	}
	return errs
}

// optionsDecodeError turns a JSON type error inside default_run_options into a
// 400 with a field path.
func optionsDecodeError(err error) error {
	var te *json.UnmarshalTypeError
	if errors.As(err, &te) && te.Field != "" {
		return httpx.BadRequest("Invalid run options", httpx.Field("default_run_options."+te.Field, "Invalid type"))
	}
	return httpx.BadRequest("Invalid run options", httpx.Field("default_run_options", "Must be an object"))
}
