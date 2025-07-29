package claude

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/UB-IAD/sd-ai/go/chat"
)

const (
	ClaudeURL = "https://api.anthropic.com/v1"
)

type client struct {
	apiBaseUrl string
	modelName  string
	apiKey     string
	debug      bool
}

var _ chat.Client = &client{}

type Option func(*client)

func WithModel(modelName string) Option {
	return func(c *client) {
		c.modelName = strings.TrimSpace(modelName)
	}
}

func WithAPIKey(apiKey string) Option {
	return func(c *client) {
		c.apiKey = strings.TrimSpace(apiKey)
	}
}

func WithDebug(debug bool) Option {
	return func(c *client) {
		c.debug = debug
	}
}

// NewClient returns a chat client that can begin chat sessions with Claude's Messages API.
func NewClient(apiBase string, opts ...Option) (chat.Client, error) {
	c := &client{
		apiBaseUrl: apiBase,
	}

	for _, opt := range opts {
		opt(c)
	}

	if c.modelName == "" {
		return nil, fmt.Errorf("WithModel is a required option")
	}

	if c.apiKey == "" {
		return nil, fmt.Errorf("WithAPIKey is a required option for Claude API")
	}

	if c.debug {
		log.Printf("claude.Client: using %q model\n", c.modelName)
	}

	return c, nil
}

// NewChat returns a chat instance.
func (c client) NewChat(systemPrompt string, initialMsgs ...chat.Message) chat.Chat {
	return &chatClient{
		client:       c,
		systemPrompt: systemPrompt,
		msgs:         initialMsgs,
	}
}

type chatClient struct {
	client
	systemPrompt string

	mu   sync.Mutex
	msgs []chat.Message
}

func (c *chatClient) doHttpRequestStream(ctx context.Context, body io.Reader) (*http.Response, error) {
	httpReq, err := http.NewRequest(http.MethodPost, c.apiBaseUrl+"/messages", body)
	if err != nil {
		return nil, fmt.Errorf("http.NewRequest: %w", err)
	}

	// thread through the context, so users can control things like timeouts and cancellation
	httpReq = httpReq.WithContext(ctx)

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", c.apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")
	httpReq.Header.Set("User-Agent", "sd-ai/go/chat/claude")

	const maxRetries = 5
	var lastStatusCode int
	var lastErr error

	delay := 1 * time.Second
	maxDelay := 8 * time.Second

	// same client across attempts, so that any cookies cloudflare sets are threaded appropriately.
	httpClient := &http.Client{
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           http.DefaultTransport.(*http.Transport).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
	}

	// retry on HTTP 5xx errors
	for attempt := 0; attempt < maxRetries; attempt++ {
		jitteredSleep := time.Duration(rand.Float64() * float64(delay))
		delay = min(delay*2, maxDelay)

		resp, err := httpClient.Do(httpReq)
		if err != nil {
			lastErr = err
			log.Printf("claude.Client (sleep: %s): http.Client.Do: %s\n", jitteredSleep, err)
			if resp != nil {
				for k, v := range resp.Header {
					log.Printf("\t%s: %s\n", k, strings.Join(v, ", "))
				}
			}

			// sleep for a few seconds
			time.Sleep(jitteredSleep)
			continue
		}

		lastStatusCode = resp.StatusCode

		switch resp.StatusCode {
		case http.StatusOK:
			return resp, nil
		case http.StatusBadRequest, http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
			bodyBytes, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			log.Printf("claude.Client (sleep: %s): received HTTP %d/%s, retrying\n%s\n", jitteredSleep, resp.StatusCode, resp.Status, string(bodyBytes))
			for k, v := range resp.Header {
				log.Printf("\t%s: %s\n", k, strings.Join(v, ", "))
			}
			time.Sleep(jitteredSleep)
			continue
		default:
			bodyBytes, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			return nil, fmt.Errorf("http status code: %d (%s)", resp.StatusCode, string(bodyBytes))
		}
	}

	if lastErr != nil {
		return nil, fmt.Errorf("http.Client.Do: %w", lastErr)
	}

	return nil, fmt.Errorf("http status code: %d", lastStatusCode)
}

func (c *chatClient) doHttpRequest(ctx context.Context, body io.Reader) ([]byte, error) {
	resp, err := c.doHttpRequestStream(ctx, body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	return io.ReadAll(resp.Body)
}

func (c *chatClient) Message(ctx context.Context, msg chat.Message, opts ...chat.Option) (chat.Message, error) {
	reqMsg := msg
	reqOpts := chat.ApplyOptions(opts...)

	c.mu.Lock()
	defer c.mu.Unlock()

	// Convert messages to Claude format
	claudeMsgs := make([]claudeMessage, 0, len(c.msgs)+1)

	// Add history messages
	for _, m := range c.msgs {
		claudeMsgs = append(claudeMsgs, claudeMessage{
			Role:    string(m.Role),
			Content: m.Content,
		})
	}

	// Add current message
	claudeMsgs = append(claudeMsgs, claudeMessage{
		Role:    string(msg.Role),
		Content: msg.Content,
	})

	req := &claudeRequest{
		Model:       c.client.modelName,
		Messages:    claudeMsgs,
		MaxTokens:   4096, // Claude requires this field
		Temperature: reqOpts.Temperature,
		Stream:      true, // Enable streaming
	}

	// Add system prompt if provided
	if c.systemPrompt != "" {
		req.System = c.systemPrompt
	}

	// Handle response format if provided
	if reqOpts.ResponseFormat != nil {
		// Claude doesn't support response_format like OpenAI, but we can use tools
		// For now, we'll add a note in the system prompt
		if req.System != "" {
			req.System += "\n\n"
		}
		req.System += fmt.Sprintf("You must respond with valid JSON that conforms to the following schema: %s", reqOpts.ResponseFormat.Name)
	}

	// Override max tokens if specified
	if reqOpts.MaxTokens > 0 {
		req.MaxTokens = reqOpts.MaxTokens
	}

	bodyBytes, err := json.MarshalIndent(req, "", "  ")
	if err != nil {
		return chat.Message{}, fmt.Errorf("json.Marshal: %w", err)
	}
	body := bytes.NewReader(bodyBytes)

	if debugDir := chat.DebugDir(ctx); debugDir != "" {
		outputPath := path.Join(debugDir, "request.json")
		if writeErr := os.WriteFile(outputPath, bodyBytes, 0o644); writeErr != nil {
			return chat.Message{}, fmt.Errorf("os.WriteFile(%s): %w", outputPath, writeErr)
		}
	}

	// Get streaming response
	resp, err := c.doHttpRequestStream(ctx, body)
	if err != nil {
		return chat.Message{}, fmt.Errorf("c.doHttpRequestStream: %w", err)
	}
	defer resp.Body.Close()

	// Process SSE stream
	var respContent string
	scanner := bufio.NewScanner(resp.Body)
	var responseBytes []byte

	for scanner.Scan() {
		line := scanner.Text()

		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			break
		}

		var event claudeStreamEvent
		if err = json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}

		responseBytes = append(responseBytes, []byte(data)...)
		responseBytes = append(responseBytes, '\n')

		switch event.Type {
		case "content_block_delta":
			if event.Delta.Type == "text_delta" {
				respContent += event.Delta.Text

				// Debug log incremental content to stderr if enabled
				if c.client.debug {
					fmt.Fprint(os.Stderr, event.Delta.Text)
				}
			}
		case "message_stop":
			break
		}
	}

	if err := scanner.Err(); err != nil {
		return chat.Message{}, fmt.Errorf("scanner error: %w", err)
	}

	// Print trailing newline after streaming completes if debug is enabled
	if c.client.debug && respContent != "" {
		fmt.Fprintln(os.Stderr)
	}

	if debugDir := chat.DebugDir(ctx); debugDir != "" {
		outputPath := path.Join(debugDir, "response.json")
		if writeErr := os.WriteFile(outputPath, responseBytes, 0o644); writeErr != nil {
			return chat.Message{}, fmt.Errorf("os.WriteFile(%s): %w", outputPath, writeErr)
		}
	}

	respContent = strings.TrimPrefix(respContent, "```json")
	respContent = strings.TrimSuffix(respContent, "```")

	respMsg := chat.Message{
		Role:    chat.AssistantRole,
		Content: respContent,
	}

	// Add messages to history
	c.msgs = append(c.msgs, reqMsg)
	c.msgs = append(c.msgs, respMsg)

	return respMsg, nil
}

func (c *chatClient) History() (systemPrompt string, msgs []chat.Message) {
	c.mu.Lock()
	defer c.mu.Unlock()

	msgs = make([]chat.Message, len(c.msgs))
	copy(msgs, c.msgs)

	return c.systemPrompt, msgs
}

// Claude-specific types

type claudeMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type claudeRequest struct {
	Model       string          `json:"model"`
	Messages    []claudeMessage `json:"messages"`
	System      string          `json:"system,omitempty"`
	MaxTokens   int             `json:"max_tokens"`
	Temperature *float64        `json:"temperature,omitempty"`
	Stream      bool            `json:"stream,omitempty"`
}

type claudeContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type claudeResponse struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Content []claudeContent `json:"content"`
	Model   string          `json:"model"`
	Usage   struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage"`
}

type claudeStreamEvent struct {
	Type  string `json:"type"`
	Index int    `json:"index,omitempty"`
	Delta struct {
		Type string `json:"type"`
		Text string `json:"text,omitempty"`
	} `json:"delta,omitempty"`
}
