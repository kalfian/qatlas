package devices

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// TestCatalogMatchesAPI: devices.json is a byte-for-byte copy of api/devices.json
// (node scripts/sync-devices.mjs).
func TestCatalogMatchesAPI(t *testing.T) {
	want, err := os.ReadFile(filepath.Join("..", "..", "..", "api", "devices.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(catalogJSON, want) {
		t.Fatal("backend/internal/devices/devices.json differs from api/devices.json; run `node scripts/sync-devices.mjs`")
	}
}

func TestCatalog(t *testing.T) {
	ids := IDs()
	if len(ids) != 10 || ids[0] != "desktop" || ids[6] != "iphone-15" {
		t.Fatalf("ids: %v", ids)
	}
	d, ok := Preset("iphone-15")
	if !ok || d.Label != "iPhone 15" || d.Category != Mobile || d.Width != 393 || d.Height != 659 || d.DeviceScaleFactor != 3 ||
		!d.IsMobile || !d.HasTouch || d.Playwright == nil || *d.Playwright != "iPhone 15" {
		t.Fatalf("iphone-15: %+v", d)
	}
	if d := Default(); d.ID != "desktop" || d.Width != 1280 || d.Height != 720 || d.Playwright != nil {
		t.Fatalf("default: %+v", d)
	}
	// Playwright never reaches the API.
	raw, _ := json.Marshal(d)
	if strings.Contains(string(raw), "playwright") {
		t.Fatalf("playwright serialized: %s", raw)
	}
	var back Device
	_ = json.Unmarshal(raw, &back)
	if back.Playwright != nil || back.PlaywrightName() == nil || *back.PlaywrightName() != "iPhone 15" {
		t.Fatal("PlaywrightName must come from the catalog for a stored preset")
	}
	if Custom(390, 844, "", "").PlaywrightName() != nil {
		t.Fatal("custom devices have no descriptor")
	}
}

func ip(n int) *int       { return &n }
func sp(s string) *string { return &s }
func pathsOf(errs []httpx.FieldError) []string {
	out := make([]string, len(errs))
	for i, e := range errs {
		out[i] = e.Path
	}
	return out
}

func TestResolve(t *testing.T) {
	got, errs := Resolve([]Input{
		{ID: "desktop"},
		{ID: " iPhone-15 ", Width: ip(1), Label: sp("ignored for presets")},
		{ID: "custom", Width: ip(390), Height: ip(844)},
		{ID: "custom", Width: ip(800), Height: ip(1280), Label: sp("  Kiosk  ")},
		{ID: "custom", Width: ip(1100), Height: ip(700), Category: sp("tablet")},
		{ID: "custom", Width: ip(1024), Height: ip(768)},
	}, "options.devices")
	if len(errs) != 0 {
		t.Fatalf("errors: %v", errs)
	}
	want := []Device{
		Default(),
		func() Device { d, _ := Preset("iphone-15"); return d }(),
		{ID: "custom", Label: "390×844", Category: Mobile, Width: 390, Height: 844, DeviceScaleFactor: 1},
		{ID: "custom", Label: "Kiosk", Category: Tablet, Width: 800, Height: 1280, DeviceScaleFactor: 1},
		{ID: "custom", Label: "1100×700", Category: Tablet, Width: 1100, Height: 700, DeviceScaleFactor: 1},
		{ID: "custom", Label: "1024×768", Category: Desktop, Width: 1024, Height: 768, DeviceScaleFactor: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("resolved:\n%+v\nwant\n%+v", got, want)
	}
	if CategoryForWidth(767) != Mobile || CategoryForWidth(768) != Tablet || CategoryForWidth(1023) != Tablet || CategoryForWidth(1024) != Desktop {
		t.Fatal("category boundaries")
	}
}

func TestResolveErrors(t *testing.T) {
	seven := make([]Input, 7)
	for i := range seven {
		seven[i] = Input{ID: "desktop"}
	}
	tests := []struct {
		name  string
		in    []Input
		paths []string
	}{
		{"empty", []Input{}, []string{"options.devices"}},
		{"too many", seven, []string{"options.devices"}},
		{"unknown id", []Input{{ID: "nokia-3310"}}, []string{"options.devices[0].id"}},
		{"missing id", []Input{{ID: " "}}, []string{"options.devices[0].id"}},
		{"custom without size", []Input{{ID: "custom"}}, []string{"options.devices[0].width", "options.devices[0].height"}},
		{"custom out of range", []Input{{ID: "custom", Width: ip(319), Height: ip(2161)}}, []string{"options.devices[0].width", "options.devices[0].height"}},
		{"custom max ok, bad category", []Input{{ID: "custom", Width: ip(3840), Height: ip(2160), Category: sp("watch")}}, []string{"options.devices[0].category"}},
		{"label too long", []Input{{ID: "custom", Width: ip(400), Height: ip(800), Label: sp(strings.Repeat("é", 41))}}, []string{"options.devices[0].label"}},
		{"duplicate preset", []Input{{ID: "pixel-7"}, {ID: "desktop"}, {ID: "PIXEL-7"}}, []string{"options.devices[2]"}},
		{"duplicate custom", []Input{{ID: "custom", Width: ip(390), Height: ip(844)}, {ID: "custom", Width: ip(390), Height: ip(844), Label: sp("Other")}}, []string{"options.devices[1]"}},
		{"same size other category is fine, then unknown", []Input{{ID: "custom", Width: ip(390), Height: ip(844)}, {ID: "custom", Width: ip(390), Height: ip(844), Category: sp("tablet")}, {ID: "x"}}, []string{"options.devices[2].id"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, errs := Resolve(tt.in, "options.devices")
			if got != nil || !reflect.DeepEqual(pathsOf(errs), tt.paths) {
				t.Fatalf("got %v / %v, want paths %v", got, errs, tt.paths)
			}
		})
	}
	// 6 is the limit.
	six := []Input{{ID: "desktop"}, {ID: "laptop"}, {ID: "desktop-fhd"}, {ID: "ipad-mini"}, {ID: "iphone-15"}, {ID: "pixel-7"}}
	if got, errs := Resolve(six, "x"); len(got) != 6 || errs != nil {
		t.Fatalf("six devices: %v %v", got, errs)
	}
}

func TestResolveJSON(t *testing.T) {
	var v any
	_ = json.Unmarshal([]byte(`[{"id":"ipad-mini"},{"id":"custom","width":390,"height":844,"label":null},
		{"id":"iphone-15","label":"Resolved Device objects round-trip","device_scale_factor":3}]`), &v)
	got, errs := ResolveJSON(v, "default_run_options.devices")
	if len(errs) != 0 || len(got) != 3 || got[0].ID != "ipad-mini" || got[1].Label != "390×844" || got[2].Label != "iPhone 15" {
		t.Fatalf("resolve json: %+v %v", got, errs)
	}
	// A resolved custom device (from a response) is valid input again.
	raw, _ := json.Marshal([]Device{Custom(800, 1280, Tablet, "Kiosk")})
	_ = json.Unmarshal(raw, &v)
	if got, errs := ResolveJSON(v, "d"); len(errs) != 0 || got[0] != Custom(800, 1280, Tablet, "Kiosk") {
		t.Fatalf("round trip: %+v %v", got, errs)
	}
	for _, c := range []struct {
		raw   string
		paths []string
	}{
		{`"iphone-15"`, []string{"o.devices"}},
		{`[]`, []string{"o.devices"}},
		{`["iphone-15"]`, []string{"o.devices[0]"}},
		{`[{"id":5}]`, []string{"o.devices[0].id"}},
		{`[{}]`, []string{"o.devices[0].id"}},
		{`[{"id":"custom","width":"390","height":844.5,"category":1,"label":2}]`, []string{"o.devices[0].width", "o.devices[0].height", "o.devices[0].category", "o.devices[0].label"}},
	} {
		_ = json.Unmarshal([]byte(c.raw), &v)
		if _, errs := ResolveJSON(v, "o.devices"); !reflect.DeepEqual(pathsOf(errs), c.paths) {
			t.Errorf("%s: %v, want %v", c.raw, errs, c.paths)
		}
	}
}

func TestFromViewport(t *testing.T) {
	for _, c := range []struct {
		w, h int
		id   string
	}{{1280, 720, "desktop"}, {1440, 900, "laptop"}, {1920, 1080, "desktop-fhd"}, {768, 1024, "custom"}, {393, 659, "custom"}, {1440, 1080, "custom"}} {
		d := FromViewport(c.w, c.h)
		if d.ID != c.id || d.Width != c.w || d.Height != c.h {
			t.Errorf("%dx%d → %+v, want %s", c.w, c.h, d, c.id)
		}
	}
	if d := FromViewport(768, 1024); d.Category != Tablet || d.Label != "768×1024" || d.IsMobile || d.DeviceScaleFactor != 1 {
		t.Fatalf("custom from viewport: %+v", d)
	}
}

func TestFromOptions(t *testing.T) {
	for _, c := range []struct {
		raw  string
		want []string // display
	}{
		{``, []string{"Desktop · 1280×720"}},
		{`{}`, []string{"Desktop · 1280×720"}},
		{`{"viewport":{"width":1440,"height":900}}`, []string{"Laptop · 1440×900"}},
		{`{"viewport":{"width":500,"height":900}}`, []string{"500×900"}},
		{`{"viewport":{"width":1280,"height":720},"devices":[{"id":"iphone-15","label":"iPhone 15","category":"mobile","width":393,"height":659,"device_scale_factor":3,"is_mobile":true,"has_touch":true},{"id":"custom","label":"Kiosk","category":"tablet","width":800,"height":1280,"device_scale_factor":1,"is_mobile":false,"has_touch":false}]}`,
			[]string{"iPhone 15 · 393×659", "Kiosk · 800×1280"}},
		{`{"viewport":{"width":1920,"height":1080},"devices":"broken"}`, []string{"Desktop Full HD · 1920×1080"}},
		{`{"viewport":{"width":1920,"height":1080},"devices":[]}`, []string{"Desktop Full HD · 1920×1080"}},
	} {
		var got []string
		for _, d := range FromOptions(json.RawMessage(c.raw)) {
			got = append(got, d.Display())
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s → %v, want %v", c.raw, got, c.want)
		}
	}
}
