package openai

import (
	"bufio"
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
	OpenAIURL = "https://api.openai.com/v1"
	OllamaURL = "http://localhost:11434/v1"
	GeminiURL = "https://generativelanguage.googleapis.com/v1beta/openai"
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

// NewClient returns a chat client that can begin chat sessions with an LLM service that speaks
// the OpenAI chat completion API.
func NewClient(apiBase string, opts ...Option) (chat.Client, error) {
	c := &client{
		apiBaseUrl: apiBase,
	}

	for _, opt := range opts {
		opt(c)
	}

	if c.modelName == "" {
		return nil, fmt.Errorf("WithModelName is a required option")
	}

	if c.debug {
		log.Printf("openai.Client: using %q model (URL: %s)\n", c.modelName, c.apiBaseUrl)
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
	httpReq, err := http.NewRequest(http.MethodPost, c.apiBaseUrl+"/chat/completions", body)
	if err != nil {
		return nil, fmt.Errorf("http.NewRequest: %w", err)
	}

	// thread through the context, so users can control things like timeouts and cancellation
	httpReq = httpReq.WithContext(ctx)

	httpReq.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		httpReq.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.apiKey))
	}
	httpReq.Header.Set("User-Agent", "sd-ai/go/chat/openai")

	const maxRetries = 5
	var lastStatusCode int
	var lastErr error

	delay := 1 * time.Second
	maxDelay := 8 * time.Second

	// same client across attempts, so that any cookies cloudflare sets are threaded appropriately.
	httpClient := &http.Client{
		Transport: &http.Transport{
			Proxy:       http.ProxyFromEnvironment,
			DialContext: http.DefaultTransport.(*http.Transport).DialContext,
			// TLSNextProto:          make(map[string]func(authority string, c *tls.Conn) http.RoundTripper),
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
	}

	// retry on HTTP 5xx errors, which we seem to get regularly from the OpenAI API
	for attempt := 0; attempt < maxRetries; attempt++ {
		jitteredSleep := time.Duration(rand.Float64() * float64(delay))
		delay = min(delay*2, maxDelay)

		resp, err := httpClient.Do(httpReq)
		if err != nil {
			lastErr = err
			log.Printf("openai.Client (sleep: %s): http.Client.Do: %s\n", jitteredSleep, err)
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
			log.Printf("openai.Client (sleep: %s): received HTTP %d/%s, retrying\n%s\n", jitteredSleep, resp.StatusCode, resp.Status, string(bodyBytes))
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

	msgs := make([]chat.Message, 0, 16)

	// for OpenAI models, the system prompt is the first message in the list of messages
	if c.systemPrompt != "" {
		msgs = append(msgs, chat.Message{
			Role:    "system",
			Content: c.systemPrompt,
		})
	}

	// add our history
	msgs = append(msgs, c.msgs...)
	// next add the current message
	msgs = append(msgs, msg)

	req := &chatCompletionRequest{
		Messages:        msgs,
		Model:           c.client.modelName,
		Temperature:     reqOpts.Temperature,
		ReasoningEffort: reqOpts.ReasoningEffort,
		Stream:          true, // Enable streaming
	}

	if reqOpts.ResponseFormat != nil {
		req.ResponseFormat = &responseFormat{
			Type:       "json_schema",
			JsonSchema: reqOpts.ResponseFormat,
		}
	}

	bodyBytes, err := json.MarshalIndent(req, "", "  ")
	if err != nil {
		return chat.Message{}, fmt.Errorf("json.Marshal: %w", err)
	}
	body := strings.NewReader(string(bodyBytes))

	if debugDir := chat.DebugDir(ctx); debugDir != "" {
		outputPath := path.Join(debugDir, "request.json")
		if err = os.WriteFile(outputPath, bodyBytes, 0o644); err != nil {
			return chat.Message{}, fmt.Errorf("os.WriteFile(%s): %w", outputPath, err)
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

		var chunk streamChunk
		if err = json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}

		responseBytes = append(responseBytes, []byte(data)...)
		responseBytes = append(responseBytes, '\n')

		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			respContent += chunk.Choices[0].Delta.Content

			// Debug log incremental content to stderr if enabled
			if c.client.debug {
				fmt.Fprint(os.Stderr, chunk.Choices[0].Delta.Content)
			}
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

	respMsg := chat.Message{
		Role:    chat.AssistantRole,
		Content: respContent,
	}

	// add them to the history only at the end, when we have both and know that we'll
	// leave history in a consistent state
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

type responseFormat struct {
	Type       string           `json:"type"`
	JsonSchema *chat.JsonSchema `json:"json_schema,omitzero"`
}

type chatCompletionRequest struct {
	Messages        []chat.Message  `json:"messages"`
	Model           string          `json:"model,omitzero"`
	ResponseFormat  *responseFormat `json:"response_format,omitzero"`
	Temperature     *float64        `json:"temperature,omitzero"`
	ReasoningEffort string          `json:"reasoning_effort,omitzero"`
	MaxTokens       int             `json:"max_tokens,omitzero"`
	Stream          bool            `json:"stream,omitzero"`
}

type chatCompletionChoice struct {
	Index   int          `json:"index"`
	Message chat.Message `json:"message"`
}

type chatCompletionResponse struct {
	Id      string                 `json:"id"`
	Object  string                 `json:"object"`
	Created int                    `json:"created"`
	Model   string                 `json:"model"`
	Choices []chatCompletionChoice `json:"choices"`
}

type streamChunk struct {
	Id      string `json:"id"`
	Object  string `json:"object"`
	Created int    `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index int `json:"index"`
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
}
