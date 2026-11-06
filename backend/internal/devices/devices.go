// Package devices is the device catalog of responsive testing
// (docs/14-responsive-testing.md): the embedded presets (devices.json, a copy
// of api/devices.json made by scripts/sync-devices.mjs), resolution of
// DeviceInput values into Device values with field-path validation, and the
// legacy viewport → device mapping for options stored before devices existed.
package devices

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/kalfian/qatlas/backend/internal/httpx"
)

//go:embed devices.json
var catalogJSON []byte

// Device categories (OpenAPI DeviceCategory; Step.only_on values).
const (
	Mobile  = "mobile"
	Tablet  = "tablet"
	Desktop = "desktop"
)

// Categories in display order.
var Categories = []string{Mobile, Tablet, Desktop}

// CustomID is DeviceInput.id of a custom size.
const CustomID = "custom"

// MaxDevices is the most devices one run executes on.
const MaxDevices = 6

// Size limits of a custom device (same as the run options viewport).
const (
	MinWidth  = 320
	MaxWidth  = 3840
	MinHeight = 320
	MaxHeight = 2160
	MaxLabel  = 40
)

// Device is a resolved device (OpenAPI Device). Playwright is the runner's
// descriptor name (presets only); it is never part of the API.
type Device struct {
	ID                string  `json:"id"`
	Label             string  `json:"label"`
	Category          string  `json:"category"`
	Width             int     `json:"width"`
	Height            int     `json:"height"`
	DeviceScaleFactor float64 `json:"device_scale_factor"`
	IsMobile          bool    `json:"is_mobile"`
	HasTouch          bool    `json:"has_touch"`
	Playwright        *string `json:"-"`
}

// SizeLabel is "{w}×{h}".
func (d Device) SizeLabel() string { return SizeLabel(d.Width, d.Height) }

// Display is "iPhone 15 · 393×659" (the label alone when it already is the size).
func (d Device) Display() string {
	if d.Label == d.SizeLabel() {
		return d.Label
	}
	return d.Label + " · " + d.SizeLabel()
}

// PlaywrightName is the runner descriptor of the device: the catalog's for a
// preset id (also for devices decoded from stored options), nil for custom.
func (d Device) PlaywrightName() *string {
	if d.Playwright != nil {
		return d.Playwright
	}
	if p, ok := Preset(d.ID); ok {
		return p.Playwright
	}
	return nil
}

// SizeLabel is the default custom label "{w}×{h}".
func SizeLabel(w, h int) string { return strconv.Itoa(w) + "×" + strconv.Itoa(h) }

// CategoryForWidth is the default category of a custom size:
// < 768 mobile, < 1024 tablet, else desktop.
func CategoryForWidth(w int) string {
	switch {
	case w < 768:
		return Mobile
	case w < 1024:
		return Tablet
	}
	return Desktop
}

type preset struct {
	Device
	Playwright *string `json:"playwright"`
}

var catalog = func() []Device {
	var list []preset
	if err := json.Unmarshal(catalogJSON, &list); err != nil {
		panic("devices: invalid devices.json: " + err.Error())
	}
	out := make([]Device, len(list))
	for i, p := range list {
		d := p.Device
		d.Playwright = p.Playwright
		out[i] = d
	}
	return out
}()

// Presets returns a copy of the catalog in catalog order.
func Presets() []Device { return slices.Clone(catalog) }

// IDs returns the preset ids in catalog order.
func IDs() []string {
	ids := make([]string, len(catalog))
	for i, d := range catalog {
		ids[i] = d.ID
	}
	return ids
}

// Preset looks up a preset by id.
func Preset(id string) (Device, bool) {
	for _, d := range catalog {
		if d.ID == id {
			return d, true
		}
	}
	return Device{}, false
}

// Default is the device of the default run options (desktop, 1280×720).
func Default() Device {
	d, _ := Preset("desktop")
	return d
}

// Custom builds a custom device with the defaults of docs/14 (category from
// the width, label "{w}×{h}", DPR 1, not mobile, no touch).
func Custom(w, h int, category, label string) Device {
	if category == "" {
		category = CategoryForWidth(w)
	}
	if label == "" {
		label = SizeLabel(w, h)
	}
	return Device{ID: CustomID, Label: label, Category: category, Width: w, Height: h, DeviceScaleFactor: 1}
}

// FromViewport maps a legacy viewport to one device: the non-mobile preset of
// exactly that size (desktop / laptop / desktop-fhd) or a custom device.
func FromViewport(w, h int) Device {
	for _, d := range catalog {
		if !d.IsMobile && d.Width == w && d.Height == h {
			return d
		}
	}
	return Custom(w, h, "", "")
}

// Input is OpenAPI DeviceInput: a preset {id} or {id:"custom", width, height,
// category?, label?}. Size, category and label are ignored for presets.
type Input struct {
	ID       string  `json:"id"`
	Width    *int    `json:"width,omitempty"`
	Height   *int    `json:"height,omitempty"`
	Category *string `json:"category,omitempty"`
	Label    *string `json:"label,omitempty"`
}

func idList() string { return strings.Join(IDs(), ", ") }

// Resolve validates inputs and returns the resolved devices in input order.
// path is the field path of the list (e.g. "options.devices"); errors use
// path, path[i], path[i].id|width|height|category|label.
func Resolve(inputs []Input, path string) ([]Device, []httpx.FieldError) {
	var errs []httpx.FieldError
	switch {
	case len(inputs) == 0:
		return nil, []httpx.FieldError{httpx.Field(path, "Choose at least one device")}
	case len(inputs) > MaxDevices:
		return nil, []httpx.FieldError{httpx.Field(path, fmt.Sprintf("Choose at most %d devices", MaxDevices))}
	}
	out := make([]Device, 0, len(inputs))
	seen := map[string]int{}
	for i, in := range inputs {
		p := fmt.Sprintf("%s[%d]", path, i)
		id := strings.ToLower(strings.TrimSpace(in.ID))
		var (
			d   Device
			key string
		)
		switch {
		case id == "":
			errs = append(errs, httpx.Field(p+".id", "Device id is required"))
			continue
		case id == CustomID:
			var ok bool
			d, ok = resolveCustom(in, p, &errs)
			if !ok {
				continue
			}
			key = fmt.Sprintf("custom:%dx%d:%s", d.Width, d.Height, d.Category)
		default:
			pr, ok := Preset(id)
			if !ok {
				errs = append(errs, httpx.Field(p+".id", fmt.Sprintf("Unknown device %q. Use one of: %s, or custom", in.ID, idList())))
				continue
			}
			d, key = pr, "preset:"+id
		}
		if j, dup := seen[key]; dup {
			errs = append(errs, httpx.Field(p, fmt.Sprintf("Device %s is already selected (devices[%d])", d.Display(), j)))
			continue
		}
		seen[key] = i
		out = append(out, d)
	}
	if len(errs) > 0 {
		return nil, errs
	}
	return out, nil
}

func resolveCustom(in Input, p string, errs *[]httpx.FieldError) (Device, bool) {
	ok := true
	bad := func(field, msg string) {
		*errs = append(*errs, httpx.Field(p+"."+field, msg))
		ok = false
	}
	var w, h int
	switch {
	case in.Width == nil:
		bad("width", "Width is required for a custom device")
	case *in.Width < MinWidth || *in.Width > MaxWidth:
		bad("width", fmt.Sprintf("Must be between %d and %d", MinWidth, MaxWidth))
	default:
		w = *in.Width
	}
	switch {
	case in.Height == nil:
		bad("height", "Height is required for a custom device")
	case *in.Height < MinHeight || *in.Height > MaxHeight:
		bad("height", fmt.Sprintf("Must be between %d and %d", MinHeight, MaxHeight))
	default:
		h = *in.Height
	}
	category := ""
	if in.Category != nil {
		category = strings.TrimSpace(*in.Category)
		if category != "" && !slices.Contains(Categories, category) {
			bad("category", "Use mobile, tablet or desktop")
		}
	}
	label := ""
	if in.Label != nil {
		label = strings.TrimSpace(*in.Label)
		if utf8.RuneCountInString(label) > MaxLabel {
			bad("label", fmt.Sprintf("Must be at most %d characters", MaxLabel))
		}
	}
	if !ok {
		return Device{}, false
	}
	return Custom(w, h, category, label), true
}

// ResolveJSON resolves a decoded JSON value (any as produced by
// encoding/json) of options.devices. Shape problems (not an array, an element
// that is not an object, a non-integer size, a non-string id/category/label)
// are field errors on the same paths as Resolve.
func ResolveJSON(v any, path string) ([]Device, []httpx.FieldError) {
	arr, ok := v.([]any)
	if !ok {
		return nil, []httpx.FieldError{httpx.Field(path, "Must be a list of devices")}
	}
	inputs := make([]Input, len(arr))
	var errs []httpx.FieldError
	for i, el := range arr {
		p := fmt.Sprintf("%s[%d]", path, i)
		m, ok := el.(map[string]any)
		if !ok {
			errs = append(errs, httpx.Field(p, `Must be an object such as {"id": "iphone-15"}`))
			continue
		}
		id, ok := m["id"].(string)
		if !ok && m["id"] != nil {
			errs = append(errs, httpx.Field(p+".id", "Must be a string"))
			continue
		}
		inputs[i].ID = id
		if strings.ToLower(strings.TrimSpace(id)) != CustomID {
			continue // a preset: the other fields are ignored
		}
		for _, f := range []struct {
			name string
			dst  **int
		}{{"width", &inputs[i].Width}, {"height", &inputs[i].Height}} {
			switch n, present, valid := intField(m, f.name); {
			case !present:
			case !valid:
				errs = append(errs, httpx.Field(p+"."+f.name, "Must be an integer"))
			default:
				*f.dst = &n
			}
		}
		for _, f := range []struct {
			name string
			dst  **string
		}{{"category", &inputs[i].Category}, {"label", &inputs[i].Label}} {
			switch s, present := m[f.name]; {
			case !present || s == nil:
			default:
				str, ok := s.(string)
				if !ok {
					errs = append(errs, httpx.Field(p+"."+f.name, "Must be a string"))
					continue
				}
				*f.dst = &str
			}
		}
	}
	if len(errs) > 0 {
		return nil, errs
	}
	return Resolve(inputs, path)
}

// intField reads an integer JSON number (float64 or json.Number).
func intField(m map[string]any, key string) (n int, present, valid bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return 0, false, false
	}
	var f float64
	switch t := v.(type) {
	case float64:
		f = t
	case json.Number:
		x, err := t.Float64()
		if err != nil {
			return 0, true, false
		}
		f = x
	case int:
		return t, true, true
	default:
		return 0, true, false
	}
	if f != math.Trunc(f) || math.Abs(f) > 1e9 {
		return 0, true, false
	}
	return int(f), true, true
}

// FromOptions returns the devices of stored run options (runs.options or
// projects.default_run_options): options.devices when present and readable,
// otherwise one device from options.viewport (FromViewport), otherwise the
// default desktop device. Never empty.
func FromOptions(raw json.RawMessage) []Device {
	var o struct {
		Devices  []Device `json:"devices"`
		Viewport *struct {
			Width  *float64 `json:"width"`
			Height *float64 `json:"height"`
		} `json:"viewport"`
	}
	if len(raw) > 0 && json.Unmarshal(raw, &o) == nil {
		if validStored(o.Devices) {
			return o.Devices
		}
		if o.Viewport != nil && o.Viewport.Width != nil && o.Viewport.Height != nil {
			return []Device{FromViewport(int(*o.Viewport.Width), int(*o.Viewport.Height))}
		}
	} else if len(raw) > 0 {
		// Fall back field by field: a malformed devices value must not hide the viewport.
		var v struct {
			Viewport struct {
				Width  float64 `json:"width"`
				Height float64 `json:"height"`
			} `json:"viewport"`
		}
		if json.Unmarshal(raw, &v) == nil && v.Viewport.Width > 0 && v.Viewport.Height > 0 {
			return []Device{FromViewport(int(v.Viewport.Width), int(v.Viewport.Height))}
		}
	}
	return []Device{Default()}
}

// DecodeStored decodes a stored (already resolved) devices value; ok=false
// when it is absent, null or not 1–6 readable devices.
func DecodeStored(raw json.RawMessage) ([]Device, bool) {
	var list []Device
	if len(raw) == 0 || json.Unmarshal(raw, &list) != nil || !validStored(list) {
		return nil, false
	}
	return list, true
}

func validStored(list []Device) bool {
	if len(list) == 0 || len(list) > MaxDevices {
		return false
	}
	for _, d := range list {
		if d.ID == "" || d.Width <= 0 || d.Height <= 0 || !slices.Contains(Categories, d.Category) {
			return false
		}
	}
	return true
}
