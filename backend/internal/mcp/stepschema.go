package mcp

import (
	"encoding/json"
	"strings"

	"github.com/kalfian/qatlas/backend/internal/dsl"
)

// Step DSL schema generated from dsl.Catalog (docs/04-test-definition.md).
// dsl.Catalog knows names, groups and required params; the JSON types below
// add what the catalog does not encode. TestStepSchemaCoversCatalog keeps
// both in sync.

type obj = map[string]any

func str(desc string) obj  { return obj{"type": "string", "description": desc} }
func intg(desc string) obj { return obj{"type": "integer", "minimum": 0, "description": desc} }
func enumOf(desc string, vals ...string) obj {
	return obj{"type": "string", "enum": vals, "description": desc}
}

const selectorDesc = "Element selector: role=button[name='Sign in'] | label=Email | placeholder=Search | testid=submit | text=Welcome | CSS (#id, .class) | xpath=… (avoid). Prefer role/label/testid."

var matchSchema = enumOf("How to compare (default contains)", "equals", "contains", "regex")

// paramSchema returns the JSON schema of one action parameter.
func paramSchema(action, param string) obj {
	switch action + "." + param {
	case "expect_count.value":
		return intg("Expected number of matching elements")
	case "expect_count.op":
		return enumOf("Comparison (default eq)", "eq", "gte", "lte")
	case "expect_status.value":
		return obj{"type": "integer", "minimum": 100, "maximum": 599, "description": "Expected HTTP status of the last http_request"}
	case "expect_json.op":
		return enumOf("Comparison", "eq", "neq", "contains", "exists", "gt", "lt", "matches")
	case "expect_json.value":
		return obj{"description": "Expected value (any JSON type); omit for op=exists"}
	case "set_variable.name":
		return str("Variable name, later used as {{vars.name}}")
	case "screenshot.name":
		return str("Screenshot name shown in the report")
	case "expect_header.name":
		return str("Response header name, e.g. content-type")
	case "select_option.value":
		return str("Option value attribute (or use label)")
	case "wait.ms":
		return obj{"type": "integer", "minimum": 0, "maximum": 30000, "description": "Fixed pause in ms (max 30000; prefer wait_for)"}
	}
	switch param {
	case "selector":
		return str(selectorDesc)
	case "url":
		if action == "http_request" {
			return str("Request URL, e.g. {{env.API_URL}}/orders")
		}
		return str("Absolute URL or {{env.BASE_URL}}/path")
	case "value":
		switch action {
		case "expect_url":
			return str("Expected URL or part of it, e.g. /dashboard")
		case "expect_title":
			return str("Expected page title")
		}
		return str("Text value; may contain {{env.X}}, {{secret.X}}, {{vars.x}}, {{fn.uuid}}")
	case "match":
		return matchSchema
	case "delay_ms":
		return intg("Delay between key presses in ms")
	case "key":
		return str("Keyboard key or chord, e.g. Enter, Tab, Control+A")
	case "label":
		return str("Visible option label")
	case "state":
		return enumOf("State to wait for (default visible)", "visible", "hidden", "attached")
	case "full_page":
		return obj{"type": "boolean", "description": "Capture the full scrollable page"}
	case "save_as":
		return obj{"type": "string", "pattern": "^[A-Za-z_][A-Za-z0-9_]*$", "description": "Variable name to store the text in ({{vars.<name>}})"}
	case "method":
		return enumOf("HTTP method", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
	case "headers":
		return obj{"type": "object", "additionalProperties": obj{"type": "string"}, "description": "Request headers; values may use {{secret.X}}"}
	case "query":
		return obj{"type": "object", "additionalProperties": obj{"type": "string"}, "description": "Query string parameters"}
	case "body_type":
		return enumOf("Body encoding (default json)", "json", "text", "form")
	case "body":
		return obj{"description": "Request body: JSON value for body_type=json, string for text, object for form"}
	case "save":
		return obj{"type": "object", "additionalProperties": obj{"type": "string"}, "description": "Save response values to variables: {\"token\": \"$.data.token\"} (name → JSONPath)"}
	case "save_regex":
		return obj{"type": "object", "additionalProperties": obj{"type": "string"}, "description": "Save response values by JavaScript regex: {\"otp\": \"code: (\\\\d{6})\"} (name → pattern, or /pattern/flags). Saves capture group 1 if present, else the whole match. Runs on the body after regex_decode; no match fails the step (or keeps polling)"}
	case "regex_decode":
		return enumOf("Decode the body before save_regex (default none). quoted_printable = soft line breaks + =XX; html = entities like &amp;; auto = quoted-printable if it looks like it, then HTML. With decoding, a JSON body is searched as its string values. Use auto for raw emails (MailHog Content.Body)", dsl.RegexDecodeValues...)
	case "poll_timeout_ms":
		return obj{"type": "integer", "minimum": 0, "maximum": dsl.PollTimeoutMaxMS, "description": "Polling: 0/absent = send once. Otherwise re-send until status 2xx AND poll_until exists AND every save/save_regex resolves (e.g. wait for an email in Mailpit); fails on timeout with the last response and attempts"}
	case "poll_interval_ms":
		return obj{"type": "integer", "minimum": dsl.PollIntervalMinMS, "description": "Pause between polling attempts in ms (default 1000)"}
	case "poll_until":
		return str("Polling: JSONPath that must exist and be non-null / a non-empty array, e.g. $.messages[0]")
	case "path":
		return str("JSONPath into the last response body, e.g. $.data.items[0].id")
	case "max_ms":
		return intg("Maximum response time in ms")
	}
	return nil
}

var commonStepProps = obj{
	"id":                  obj{"type": "string", "description": "Stable id, unique within the test case (e.g. s1, s2 …); keep ids when editing so revisions diff cleanly"},
	"description":         str("Human-readable sentence shown in reports (required for manual steps: the instruction for the tester)"),
	"expected":            str("Expected result in words (manual steps: what the tester should see)"),
	"timeout_ms":          obj{"type": "integer", "minimum": 1, "description": "Override the step timeout (default from run options, 10000)"},
	"continue_on_failure": obj{"type": "boolean", "description": "Continue with the next steps if this one fails (default false: remaining steps are skipped)"},
	"enabled":             obj{"type": "boolean", "description": "false = skip this step (default true)"},
	"screenshot":          obj{"type": "boolean", "description": "Always take a screenshot after this step (UI steps only)"},
}

// StepJSONSchema is the JSON Schema (draft 2020-12) of one step.
func StepJSONSchema() obj {
	props := obj{}
	for k, v := range commonStepProps {
		props[k] = v
	}
	names := make([]string, 0, len(dsl.Catalog))
	var branches []any
	for _, a := range dsl.Catalog {
		names = append(names, a.Name)
		then := obj{"properties": obj{}}
		required := []string{}
		for _, p := range a.Params {
			then["properties"].(obj)[p.Name] = paramSchema(a.Name, p.Name)
			if p.Required {
				required = append(required, p.Name)
			}
		}
		if a.Name == "manual" {
			required = append(required, "description")
		}
		if len(required) > 0 {
			then["required"] = required
		}
		branches = append(branches, obj{
			"if":   obj{"properties": obj{"action": obj{"const": a.Name}}, "required": []string{"action"}},
			"then": then,
		})
	}
	props["action"] = obj{"type": "string", "enum": names, "description": "What the step does; see the per-action parameters in allOf"}
	return obj{
		"$schema":     "https://json-schema.org/draft/2020-12/schema",
		"$id":         "qatlas://docs/step-dsl/step.schema.json",
		"title":       "QAtlas test step",
		"type":        "object",
		"required":    []string{"id", "action"},
		"properties":  props,
		"allOf":       branches,
		"description": "One step of a test case. Common fields plus the parameters of its action.",
	}
}

// actionLine is a compact catalog entry for quick lookup.
type actionLine struct {
	Action   string   `json:"action"`
	Group    string   `json:"group"`
	Required []string `json:"required,omitempty"`
	Optional []string `json:"optional,omitempty"`
}

func actionIndex() []actionLine {
	out := make([]actionLine, 0, len(dsl.Catalog))
	for _, a := range dsl.Catalog {
		l := actionLine{Action: a.Name, Group: a.Group}
		for _, p := range a.Params {
			if p.Required {
				l.Required = append(l.Required, p.Name)
			} else {
				l.Optional = append(l.Optional, p.Name)
			}
		}
		if a.Name == "manual" {
			l.Required = append(l.Required, "description")
			l.Optional = append(l.Optional, "expected")
		}
		out = append(out, l)
	}
	return out
}

var selectorGuidance = []string{
	"Prefer user-facing locators: role=<role>[name='<accessible name>'] (buttons, links, headings, checkboxes), label=<form label>, placeholder=<text>, testid=<data-testid>.",
	"text=<visible text> matches by text content; use it for assertions on messages rather than for clicking generic elements.",
	"CSS (#id, .class, tag[attr=value]) is passed to page.locator(); avoid long chains and generated class names. XPath (//… or xpath=…) is brittle and gets a warning.",
	"Every action auto-waits for the element to be actionable; use wait_for (state visible/hidden/attached) instead of fixed wait pauses.",
	"Assertions: expect_visible/expect_hidden, expect_text (match equals|contains|regex), expect_value (inputs), expect_url, expect_title, expect_count (op eq|gte|lte).",
}

var variableGuidance = []string{
	"{{env.NAME}} environment variable (get_project lists them per environment).",
	"{{secret.NAME}} environment secret — never write secret values into steps; use the placeholder. Values are masked as •••• in reports.",
	"{{vars.name}} test case/flow variables and runtime values from extract_text.save_as, http_request.save and set_variable.",
	"{{fn.uuid}}, {{fn.now}}, {{fn.random_email}}, {{fn.random_int 1 100}} built-ins.",
	"{{fn.totp secret.NAME}} = current RFC 6238 2FA code from a base32 seed (secret./env./vars. reference or a literal); options digits=6..8, period=10..300, algorithm=SHA1|SHA256|SHA512. Generated when the step runs (waits for a fresh period if < 3 s remain) and masked in reports.",
	"Precedence (later wins): environment → flow variables → test case variables → runtime.",
}

var dslRules = []string{
	"Each step needs a unique id and an action from the list.",
	"execution=automated test cases may not contain manual steps; execution=manual test cases contain only action=manual steps, each with a description (instruction) and ideally expected.",
	"HTTP assertions (expect_status, expect_json, expect_header, expect_response_time) apply to the most recent http_request step, which must come before them.",
	"wait is limited to 30000 ms and discouraged; a failing step skips the rest unless continue_on_failure is true.",
	"A test case may mix UI and HTTP steps (e.g. create data via API, verify in the UI); the browser starts only if there is a UI step.",
	"Emails: query a mail catcher with http_request + poll_timeout_ms (Mailpit: GET {{env.MAILPIT_URL}}/api/v1/search with query {\"query\": \"to:{{vars.email}}\"}, save $.messages[0].ID; then GET /api/v1/message/{{vars.id}} → $.Subject, $.Text, $.HTML) and extract codes/links with save_regex (+ regex_decode auto for raw/HTML bodies).",
}

func exampleCases() []obj {
	return []obj{
		{
			"title": "User can sign in with email and password", "priority": "high", "status": "ready",
			"execution": "automated", "tags": []string{"auth", "smoke"}, "variables": obj{"email": "qa@example.com"},
			"steps": []obj{
				{"id": "s1", "action": "goto", "url": "{{env.BASE_URL}}/login", "description": "Open the login page"},
				{"id": "s2", "action": "fill", "selector": "label=Email", "value": "{{vars.email}}"},
				{"id": "s3", "action": "fill", "selector": "label=Password", "value": "{{secret.QA_PASSWORD}}"},
				{"id": "s4", "action": "click", "selector": "role=button[name='Sign in']"},
				{"id": "s5", "action": "expect_url", "value": "/dashboard", "match": "contains", "expected": "Redirected to the dashboard"},
				{"id": "s6", "action": "expect_visible", "selector": "role=heading[name='Welcome']"},
				{"id": "s7", "action": "http_request", "method": "GET", "url": "{{env.BASE_URL}}/api/me", "save": obj{"user_id": "$.id"}},
				{"id": "s8", "action": "expect_status", "value": 200},
				{"id": "s9", "action": "expect_json", "path": "$.email", "op": "eq", "value": "{{vars.email}}"},
			},
		},
		{
			"title": "User signs in with 2FA (TOTP) and gets a sign-in email", "priority": "high", "status": "ready",
			"execution": "automated", "tags": []string{"auth", "2fa", "email"}, "variables": obj{"email": "qa@example.com"},
			"steps": []obj{
				{"id": "s1", "action": "goto", "url": "{{env.BASE_URL}}/login"},
				{"id": "s2", "action": "fill", "selector": "label=Email", "value": "{{vars.email}}"},
				{"id": "s3", "action": "fill", "selector": "label=Password", "value": "{{secret.QA_PASSWORD}}"},
				{"id": "s4", "action": "click", "selector": "role=button[name='Sign in']"},
				{"id": "s5", "action": "fill", "selector": "label=Authentication code", "value": "{{fn.totp secret.QA_TOTP_SEED}}", "description": "Enter the current authenticator code"},
				{"id": "s6", "action": "click", "selector": "role=button[name='Verify']"},
				{"id": "s7", "action": "expect_url", "value": "/dashboard", "match": "contains"},
				{"id": "s8", "action": "http_request", "method": "GET", "url": "{{env.MAILPIT_URL}}/api/v1/search", "query": obj{"query": "to:{{vars.email}}"},
					"save": obj{"mail_id": "$.messages[0].ID"}, "poll_timeout_ms": 15000, "poll_interval_ms": 1000, "description": "Wait for the sign-in email"},
				{"id": "s9", "action": "http_request", "method": "GET", "url": "{{env.MAILPIT_URL}}/api/v1/message/{{vars.mail_id}}",
					"save_regex": obj{"review_link": `href="([^"]+/security[^"]*)"`}, "regex_decode": "auto"},
				{"id": "s10", "action": "expect_json", "path": "$.Subject", "op": "contains", "value": "New sign-in"},
			},
		},
		{
			"title": "Sign in with SMS one-time code", "priority": "medium", "status": "ready",
			"execution": "manual", "tags": []string{"auth"},
			"steps": []obj{
				{"id": "m1", "action": "manual", "description": "Open {{env.BASE_URL}}/login and enter phone number 0812xxxx", "expected": "The OTP form appears and the SMS arrives within 30 seconds"},
				{"id": "m2", "action": "manual", "description": "Enter the code from the SMS", "expected": "You land on the dashboard"},
			},
		},
	}
}

// stepSchemaDoc is the get_step_schema answer.
func stepSchemaDoc() obj {
	return obj{
		"step_schema":       StepJSONSchema(),
		"actions":           actionIndex(),
		"selector_guidance": selectorGuidance,
		"variables":         variableGuidance,
		"rules":             dslRules,
		"test_case_fields": obj{
			"title": "required", "description": "optional", "preconditions": "optional",
			"priority": "low|medium|high|critical", "status": "draft|ready|deprecated", "execution": "automated|manual",
			"tags": "string[]", "variables": "object of strings", "steps": "array of steps (step_schema)", "folder_id": "id from list_folders",
		},
		"examples": exampleCases(),
	}
}

// stepDSLMarkdown is the qatlas://docs/step-dsl resource.
func stepDSLMarkdown() string {
	var b strings.Builder
	b.WriteString("# QAtlas step DSL\n\nTest cases are JSON data: title, priority, status, execution, tags, variables and an ordered list of steps.\n\n")
	b.WriteString("## Actions\n\n| action | group | required | optional |\n|---|---|---|---|\n")
	for _, a := range actionIndex() {
		b.WriteString("| " + a.Action + " | " + a.Group + " | " + strings.Join(a.Required, ", ") + " | " + strings.Join(a.Optional, ", ") + " |\n")
	}
	b.WriteString("\nCommon step fields: id (required, unique), action (required), description, expected, timeout_ms, continue_on_failure, enabled, screenshot.\n")
	section := func(title string, lines []string) {
		b.WriteString("\n## " + title + "\n\n")
		for _, l := range lines {
			b.WriteString("- " + l + "\n")
		}
	}
	section("Selectors", selectorGuidance)
	section("Variables", variableGuidance)
	section("Rules", dslRules)
	b.WriteString("\n## Examples\n\n")
	for _, ex := range exampleCases() {
		raw, _ := json.MarshalIndent(ex, "", "  ")
		b.WriteString("```json\n" + string(raw) + "\n```\n\n")
	}
	raw, _ := json.MarshalIndent(StepJSONSchema(), "", "  ")
	b.WriteString("## JSON Schema of a step\n\n```json\n" + string(raw) + "\n```\n")
	return b.String()
}
