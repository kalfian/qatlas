package projects

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/kalfian/qatlas/backend/internal/devices"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Viewport is RunOptions.viewport.
type Viewport struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// RunOptions is the OpenAPI RunOptions schema (projects.default_run_options).
// Devices is always resolved (1–6) and Viewport is always the size of
// Devices[0] (docs/14-responsive-testing.md).
type RunOptions struct {
	Browser       string           `json:"browser"`
	Headless      bool             `json:"headless"`
	Viewport      Viewport         `json:"viewport"`
	Devices       []devices.Device `json:"devices"`
	Screenshot    string           `json:"screenshot"`
	Video         string           `json:"video"`
	StepTimeoutMS int              `json:"step_timeout_ms"`
	Retries       int              `json:"retries"`
}

// DefaultRunOptions mirrors the mock's DEFAULT_RUN_OPTIONS (and the column default).
func DefaultRunOptions() RunOptions {
	return RunOptions{
		Browser:       "chromium",
		Headless:      true,
		Viewport:      Viewport{Width: 1280, Height: 720},
		Devices:       []devices.Device{devices.Default()},
		Screenshot:    "on_failure",
		Video:         "off",
		StepTimeoutMS: 10000,
		Retries:       0,
	}
}

// Equal compares two option sets as the API sees them (RunOptions holds a
// slice, so == is not available; Device.Playwright is internal and ignored).
func (o RunOptions) Equal(other RunOptions) bool {
	a, errA := json.Marshal(o)
	b, errB := json.Marshal(other)
	return errA == nil && errB == nil && bytes.Equal(a, b)
}

// optionsLayer decodes one JSON layer over a RunOptions: every field lands in
// the embedded options except devices and viewport, which are kept raw so the
// caller can tell whether the layer set them.
type optionsLayer struct {
	*RunOptions
	Devices  json.RawMessage `json:"devices"`
	Viewport json.RawMessage `json:"viewport"`
}

func isNull(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return s == "" || s == "null"
}

// layerResult reports what a decoded layer set.
type layerResult struct {
	devices  json.RawMessage // non-null devices value, else nil
	viewport bool            // a non-null viewport was given
}

// applyLayer decodes l onto o. Viewport keys merge individually; type errors
// keep their field path (viewport.width, …).
func applyLayer(o *RunOptions, l json.RawMessage) (layerResult, error) {
	var res layerResult
	ly := optionsLayer{RunOptions: o}
	if err := json.Unmarshal(l, &ly); err != nil {
		return res, err
	}
	if !isNull(ly.Viewport) {
		if err := json.Unmarshal(ly.Viewport, &o.Viewport); err != nil {
			var te *json.UnmarshalTypeError
			if errors.As(err, &te) {
				cp := *te
				cp.Field = "viewport"
				if te.Field != "" {
					cp.Field += "." + te.Field
				}
				return res, &cp
			}
			return res, err
		}
		res.viewport = true
	}
	if !isNull(ly.Devices) {
		res.devices = ly.Devices
	}
	return res, nil
}

// syncViewport sets Viewport to the size of the first device.
func (o *RunOptions) syncViewport() {
	if len(o.Devices) == 0 {
		o.Devices = []devices.Device{devices.FromViewport(o.Viewport.Width, o.Viewport.Height)}
	}
	o.Viewport = Viewport{Width: o.Devices[0].Width, Height: o.Devices[0].Height}
}

// MergeRunOptions applies STORED JSON object layers over DefaultRunOptions,
// later layers winning (mock: {...DEFAULT_RUN_OPTIONS, ...project.default_run_options,
// ...partial}). Absent or null keys keep the previous value; unknown keys are
// ignored. Nested viewport keys merge individually. Stored devices are taken
// as they are; a layer that sets viewport without devices replaces the
// devices, and options without devices (stored before docs/14) get one
// device from the viewport (devices.FromViewport). Input from clients goes
// through ApplyRunOptionsInput instead (validation of DeviceInput values).
func MergeRunOptions(layers ...json.RawMessage) (RunOptions, error) {
	o := DefaultRunOptions()
	for _, l := range layers {
		if isNull(l) {
			continue
		}
		res, err := applyLayer(&o, l)
		if err != nil {
			return RunOptions{}, err
		}
		if res.devices != nil || res.viewport {
			// Stored devices win; unreadable ones or a viewport without
			// devices → one device from the (merged) viewport.
			o.Devices, _ = devices.DecodeStored(res.devices)
		}
		o.syncViewport()
	}
	o.syncViewport()
	return o, nil
}

// ApplyRunOptionsInput applies a client's partial default_run_options
// (OpenAPI RunOptionsInput) over the current options: devices (DeviceInput
// list) win; a lone viewport becomes one device; otherwise the current
// devices stay. Decode problems → 400 (optionsDecodeError), device problems
// → 400 with paths default_run_options.devices[i]…; then Validate.
func ApplyRunOptionsInput(cur RunOptions, input json.RawMessage) (RunOptions, error) {
	o := cur
	o.Devices = slices.Clone(cur.Devices)
	res, err := applyLayer(&o, input)
	if err != nil {
		return RunOptions{}, optionsDecodeError(err)
	}
	switch {
	case res.devices != nil:
		var v any
		if err := json.Unmarshal(res.devices, &v); err != nil {
			return RunOptions{}, optionsDecodeError(err)
		}
		list, errs := devices.ResolveJSON(v, optionsPrefix+"devices")
		if len(errs) > 0 {
			return RunOptions{}, httpx.BadRequest("Invalid run options", append(o.Validate(optionsPrefix), errs...)...)
		}
		o.Devices = list
	case res.viewport:
		// Validate the given size first: an invalid viewport must not turn into a device.
		if errs := o.Validate(optionsPrefix); len(errs) > 0 {
			return RunOptions{}, httpx.BadRequest("Invalid run options", errs...)
		}
		o.Devices = []devices.Device{devices.FromViewport(o.Viewport.Width, o.Viewport.Height)}
	}
	o.syncViewport()
	if errs := o.Validate(optionsPrefix); len(errs) > 0 {
		return RunOptions{}, httpx.BadRequest("Invalid run options", errs...)
	}
	return o, nil
}

const optionsPrefix = "default_run_options."

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
		return httpx.BadRequest("Invalid run options", httpx.Field(optionsPrefix+te.Field, "Invalid type"))
	}
	return httpx.BadRequest("Invalid run options", httpx.Field("default_run_options", "Must be an object"))
}
