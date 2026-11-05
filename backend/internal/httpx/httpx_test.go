package httpx

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) errorPayload {
	t.Helper()
	var body errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body %q: %v", rec.Body.String(), err)
	}
	return body.Error
}

func TestCSRF(t *testing.T) {
	h := CSRF(okHandler())
	cases := []struct {
		name   string
		method string
		header map[string]string
		want   int
	}{
		{"GET without header", http.MethodGet, nil, 204},
		{"HEAD without header", http.MethodHead, nil, 204},
		{"POST without header", http.MethodPost, nil, 403},
		{"PATCH wrong value", http.MethodPatch, map[string]string{CSRFHeader: "true"}, 403},
		{"DELETE with header", http.MethodDelete, map[string]string{CSRFHeader: "1"}, 204},
		{"POST bearer exempt", http.MethodPost, map[string]string{"Authorization": "Bearer qat_x"}, 204},
		{"POST basic auth not exempt", http.MethodPost, map[string]string{"Authorization": "Basic eDp5"}, 403},
	}
	for _, c := range cases {
		req := httptest.NewRequest(c.method, "/api/v1/me", nil)
		for k, v := range c.header {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("%s: got %d want %d", c.name, rec.Code, c.want)
		}
		if c.want == 403 && decodeError(t, rec).Code != CodeForbidden {
			t.Errorf("%s: wrong error code", c.name)
		}
	}
}

func TestWriteErrorHidesInternalErrors(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteError(rec, httptest.NewRequest("GET", "/", nil), errors.New("pq: secret detail"))
	if rec.Code != 500 || strings.Contains(rec.Body.String(), "secret") {
		t.Fatalf("leaked: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	WriteError(rec, httptest.NewRequest("GET", "/", nil), BadRequest("Name is required", Field("name", "Required")))
	e := decodeError(t, rec)
	if rec.Code != 400 || e.Code != CodeValidationFailed || len(e.Details) != 1 || e.Details[0].Path != "name" {
		t.Fatalf("unexpected: %d %+v", rec.Code, e)
	}
	// details omitted when empty
	rec = httptest.NewRecorder()
	WriteError(rec, httptest.NewRequest("GET", "/", nil), NotFound("x"))
	if strings.Contains(rec.Body.String(), "details") {
		t.Fatalf("details should be omitted: %s", rec.Body.String())
	}
}

func TestRecover(t *testing.T) {
	h := Recover(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 500 || decodeError(t, rec).Code != CodeInternal {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestRequestIDAndClientIP(t *testing.T) {
	var gotID, gotIP string
	h := RequestID(ClientIP(true)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		gotID, gotIP = RequestIDFrom(r.Context()), ClientIPFrom(r.Context())
	})))
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set(RequestIDHeader, "abc-123")
	req.Header.Set("X-Forwarded-For", "1.1.1.1, 10.0.0.9")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if gotID != "abc-123" || rec.Header().Get(RequestIDHeader) != "abc-123" || gotIP != "10.0.0.9" {
		t.Fatalf("id=%q ip=%q", gotID, gotIP)
	}
	// A client-sent X-Real-IP does not beat the proxy's X-Forwarded-For entry;
	// it is the fallback when there is no (valid) X-Forwarded-For.
	for _, tc := range []struct {
		xff  []string
		real string
		want string
	}{
		{[]string{"10.0.0.9"}, "1.2.3.4", "10.0.0.9"},
		{[]string{"9.9.9.9", "5.6.7.8, 10.0.0.7"}, "1.2.3.4", "10.0.0.7"},
		{nil, "1.2.3.4", "1.2.3.4"},
		{[]string{"garbage"}, "1.2.3.4", "1.2.3.4"},
		{[]string{"garbage"}, "", "192.0.2.1"},
	} {
		req = httptest.NewRequest("GET", "/", nil)
		for _, v := range tc.xff {
			req.Header.Add("X-Forwarded-For", v)
		}
		if tc.real != "" {
			req.Header.Set("X-Real-IP", tc.real)
		}
		h.ServeHTTP(httptest.NewRecorder(), req)
		if gotIP != tc.want {
			t.Errorf("xff=%v real=%q: ip=%q, want %q", tc.xff, tc.real, gotIP, tc.want)
		}
	}
	req = httptest.NewRequest("GET", "/", nil)
	req.Header.Set(RequestIDHeader, "bad id with spaces")
	req.Header.Set("X-Forwarded-For", "1.1.1.1")
	ClientIP(false)(RequestID(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		gotID, gotIP = RequestIDFrom(r.Context()), ClientIPFrom(r.Context())
	}))).ServeHTTP(httptest.NewRecorder(), req)
	if gotID == "bad id with spaces" || len(gotID) != 16 || gotIP != "192.0.2.1" {
		t.Fatalf("id=%q ip=%q", gotID, gotIP)
	}
}

func TestParsePage(t *testing.T) {
	cases := []struct {
		query   string
		limit   int
		offset  int
		wantErr bool
	}{
		{"", 50, 0, false},
		{"limit=10&cursor=20", 10, 20, false},
		{"limit=1000", 200, 0, false},
		{"limit=0", 0, 0, true},
		{"limit=abc", 0, 0, true},
		{"cursor=-1", 0, 0, true},
		{"cursor=x", 0, 0, true},
	}
	for _, c := range cases {
		p, err := ParsePage(httptest.NewRequest("GET", "/?"+c.query, nil))
		if c.wantErr {
			if err == nil {
				t.Errorf("%q: expected error", c.query)
			}
			continue
		}
		if err != nil || p.Limit != c.limit || p.Offset != c.offset {
			t.Errorf("%q: got %+v err=%v", c.query, p, err)
		}
	}
}

func TestPaginate(t *testing.T) {
	items := []int{1, 2, 3, 4, 5}
	p := Paginate(items, PageRequest{Limit: 2, Offset: 0})
	if len(p.Data) != 2 || p.NextCursor == nil || *p.NextCursor != "2" {
		t.Fatalf("first page: %+v", p)
	}
	p = Paginate(items, PageRequest{Limit: 2, Offset: 4})
	if len(p.Data) != 1 || p.Data[0] != 5 || p.NextCursor != nil {
		t.Fatalf("last page: %+v", p)
	}
	p = Paginate(items, PageRequest{Limit: 5, Offset: 0})
	if len(p.Data) != 5 || p.NextCursor != nil {
		t.Fatalf("exact page: %+v", p)
	}
	p = Paginate(items, PageRequest{Limit: 2, Offset: 10})
	if p.Data == nil || len(p.Data) != 0 || p.NextCursor != nil {
		t.Fatalf("beyond end: %+v", p)
	}
	b, _ := json.Marshal(Paginate([]int(nil), PageRequest{Limit: 2}))
	if string(b) != `{"data":[],"next_cursor":null}` {
		t.Fatalf("json: %s", b)
	}
	// SQL style: Limit+1 rows fetched
	limit, offset := PageRequest{Limit: 3, Offset: 6}.SQL()
	if limit != 4 || offset != 6 {
		t.Fatal("SQL args")
	}
	p = NewPage([]int{7, 8, 9, 10}, PageRequest{Limit: 3, Offset: 6})
	if len(p.Data) != 3 || *p.NextCursor != "9" {
		t.Fatalf("NewPage: %+v", p)
	}
}

func TestDecodeJSONAndOptional(t *testing.T) {
	type in struct {
		Name     Optional[string] `json:"name"`
		FolderID Optional[string] `json:"folder_id"`
		Other    Optional[int]    `json:"other"`
	}
	var v in
	req := httptest.NewRequest("PATCH", "/", strings.NewReader(`{"name":"x","folder_id":null}`))
	if err := DecodeJSON(httptest.NewRecorder(), req, &v); err != nil {
		t.Fatal(err)
	}
	if !v.Name.Set || v.Name.Null || v.Name.Value != "x" || *v.Name.Ptr() != "x" {
		t.Fatalf("name: %+v", v.Name)
	}
	if !v.FolderID.Set || !v.FolderID.Null || v.FolderID.Ptr() != nil {
		t.Fatalf("folder: %+v", v.FolderID)
	}
	if v.Other.Set {
		t.Fatalf("other should be unset")
	}

	var empty in
	if err := DecodeJSON(httptest.NewRecorder(), httptest.NewRequest("POST", "/", nil), &empty); err != nil {
		t.Fatalf("empty body should be accepted: %v", err)
	}
	err := DecodeJSON(httptest.NewRecorder(), httptest.NewRequest("POST", "/", strings.NewReader("{bad")), &empty)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 400 {
		t.Fatalf("malformed: %v", err)
	}
	big := `{"name":"` + strings.Repeat("a", MaxJSONBody) + `"}`
	err = DecodeJSON(httptest.NewRecorder(), httptest.NewRequest("POST", "/", strings.NewReader(big)), &empty)
	if !errors.As(err, &apiErr) || apiErr.Status != 413 {
		t.Fatalf("too large: %v", err)
	}
}
