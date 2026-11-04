package mcp

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// RunStdio implements `qatlas mcp-stdio --url <server> --token <token>`: a
// thin proxy for MCP clients that only speak stdio. It connects to the
// server's Streamable HTTP endpoint with the API token, mirrors its tools,
// resources, resource templates and prompts, and serves them on
// stdin/stdout. Every call is forwarded, so authorisation stays on the server.
//
// Flags fall back to QATLAS_URL / QATLAS_TOKEN (keeps the token out of the
// process list). Nothing but MCP messages is written to stdout.
//
// Wire it in cmd/qatlas with: case "mcp-stdio": return mcp.RunStdio(ctx, args[1:])
func RunStdio(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("mcp-stdio", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	url := fs.String("url", os.Getenv("QATLAS_URL"), "QAtlas server URL, e.g. https://qatlas.example.com (or QATLAS_URL)")
	token := fs.String("token", os.Getenv("QATLAS_TOKEN"), "API token qat_… (or QATLAS_TOKEN)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*url) == "" || strings.TrimSpace(*token) == "" {
		return errors.New("usage: qatlas mcp-stdio --url https://qatlas.example.com --token qat_… (or set QATLAS_URL / QATLAS_TOKEN)")
	}
	return ServeStdioProxy(ctx, Endpoint(*url), strings.TrimSpace(*token), &sdk.StdioTransport{})
}

// Endpoint normalises a server URL to its /mcp endpoint.
func Endpoint(serverURL string) string {
	u := strings.TrimRight(strings.TrimSpace(serverURL), "/")
	if !strings.HasSuffix(u, "/mcp") {
		u += "/mcp"
	}
	return u
}

// bearerTransport adds the API token to every request.
type bearerTransport struct {
	token string
	base  http.RoundTripper
}

func (t bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+t.token)
	return t.base.RoundTrip(r)
}

// BearerClient is an http.Client that authenticates with an API token.
func BearerClient(token string) *http.Client {
	return &http.Client{Transport: bearerTransport{token: token, base: http.DefaultTransport}}
}

// ServeStdioProxy connects to endpoint and serves a mirror of the remote MCP
// server on local (stdio in production, in-memory in tests) until ctx ends or
// the local client disconnects.
func ServeStdioProxy(ctx context.Context, endpoint, token string, local sdk.Transport) error {
	client := sdk.NewClient(&sdk.Implementation{Name: "qatlas-mcp-stdio", Version: Version}, nil)
	remote, err := client.Connect(ctx, &sdk.StreamableClientTransport{
		Endpoint:             endpoint,
		HTTPClient:           BearerClient(token),
		DisableStandaloneSSE: true, // the server is stateless and never pushes
	}, nil)
	if err != nil {
		return fmt.Errorf("connect to %s (check the URL and that the token is valid): %w", endpoint, err)
	}
	defer remote.Close()

	info := &sdk.Implementation{Name: "qatlas", Version: Version}
	var instructions string
	if ir := remote.InitializeResult(); ir != nil {
		if ir.ServerInfo != nil {
			info = ir.ServerInfo
		}
		instructions = ir.Instructions
	}
	srv := sdk.NewServer(info, &sdk.ServerOptions{Instructions: instructions})
	if err := mirror(ctx, remote, srv); err != nil {
		return err
	}
	err = srv.Run(ctx, local)
	if errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

// mirror registers forwarding handlers for everything the remote server lists.
func mirror(ctx context.Context, remote *sdk.ClientSession, srv *sdk.Server) error {
	caps := remote.InitializeResult()
	hasTools, hasResources, hasPrompts := true, true, true
	if caps != nil && caps.Capabilities != nil {
		hasTools = caps.Capabilities.Tools != nil
		hasResources = caps.Capabilities.Resources != nil
		hasPrompts = caps.Capabilities.Prompts != nil
	}
	if hasTools {
		for tool, err := range remote.Tools(ctx, nil) {
			if err != nil {
				return fmt.Errorf("list tools: %w", err)
			}
			name := tool.Name
			srv.AddTool(tool, func(ctx context.Context, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
				params := &sdk.CallToolParams{Name: name, Meta: req.Params.Meta}
				if len(req.Params.Arguments) > 0 {
					params.Arguments = req.Params.Arguments
				}
				return remote.CallTool(ctx, params)
			})
		}
	}
	if hasResources {
		for res, err := range remote.Resources(ctx, nil) {
			if err != nil {
				return fmt.Errorf("list resources: %w", err)
			}
			srv.AddResource(res, func(ctx context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
				return remote.ReadResource(ctx, req.Params)
			})
		}
		for tmpl, err := range remote.ResourceTemplates(ctx, nil) {
			if err != nil {
				return fmt.Errorf("list resource templates: %w", err)
			}
			srv.AddResourceTemplate(tmpl, func(ctx context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
				return remote.ReadResource(ctx, req.Params)
			})
		}
	}
	if hasPrompts {
		for p, err := range remote.Prompts(ctx, nil) {
			if err != nil {
				return fmt.Errorf("list prompts: %w", err)
			}
			srv.AddPrompt(p, func(ctx context.Context, req *sdk.GetPromptRequest) (*sdk.GetPromptResult, error) {
				return remote.GetPrompt(ctx, req.Params)
			})
		}
	}
	return nil
}
