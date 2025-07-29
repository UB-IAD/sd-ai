package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path"
	"strings"

	"github.com/UB-IAD/sd-ai/go/causal"
	"github.com/UB-IAD/sd-ai/go/chat"
	"github.com/UB-IAD/sd-ai/go/llm/claude"
	"github.com/UB-IAD/sd-ai/go/llm/openai"
	"github.com/UB-IAD/sd-ai/go/sdjson"
)

type parameters struct {
	ApiKey              string `json:"apiKey"`
	GoogleKey           string `json:"googleKey"`
	ClaudeKey           string `json:"claudeKey"`
	UnderlyingModel     string `json:"underlyingModel"`
	ProblemStatement    string `json:"problemStatement"`
	BackgroundKnowledge string `json:"backgroundKnowledge"`
}

type input struct {
	Prompt       string         `json:"prompt"`
	CurrentModel map[string]any `json:"currentModel"`
	Parameters   parameters     `json:"parameters"`
}

type supportingInfo struct {
	Title       string `json:"title"`
	Explanation string `json:"explanation"`
}

type output struct {
	SupportingInfo supportingInfo `json:"supportingInfo"`
	Model          sdjson.Model   `json:"model"`
}

// isOpenAIModel returns true if the given model is an OpenAI model.
// It is approximate, and focuses on models we might care about.
func isOpenAIModel(model string) bool {
	model = strings.ToLower(model)
	if strings.HasPrefix(model, "gpt") || strings.HasPrefix(model, "chatgpt") {
		return true
	}

	if strings.HasPrefix(model, "o1") || strings.HasPrefix(model, "o3") || strings.HasPrefix(model, "o4") {
		return true
	}

	return false
}

// isGeminiModel returns true if the given model is a Google Gemini model.
func isGeminiModel(model string) bool {
	model = strings.ToLower(model)
	return strings.Contains(model, "gemini")
}

// isClaudeModel returns true if the given model is an Anthropic Claude model.
func isClaudeModel(model string) bool {
	model = strings.ToLower(model)
	return strings.HasPrefix(model, "claude-")
}

func main() {
	argv := os.Args
	if len(argv) < 2 {
		log.Fatalf("usage: %s input_path", argv[0])
	}
	inputPath := argv[1]
	inputBytes, err := os.ReadFile(inputPath)
	if err != nil {
		log.Fatalf("os.ReadFile(%q): %s", inputPath, err)
	}

	input := new(input)
	if err := json.Unmarshal(inputBytes, &input); err != nil {
		log.Fatalf("json.Unmarshal: %s", err)
	}

	if input.Parameters.ApiKey == "" {
		input.Parameters.ApiKey = os.Getenv("OPENAI_API_KEY")
	}
	if input.Parameters.GoogleKey == "" {
		input.Parameters.GoogleKey = os.Getenv("GOOGLE_API_KEY")
	}
	if input.Parameters.ClaudeKey == "" {
		input.Parameters.ClaudeKey = os.Getenv("ANTHROPIC_API_KEY")
	}

	var c chat.Client

	if isClaudeModel(input.Parameters.UnderlyingModel) {
		apiKey := input.Parameters.ClaudeKey
		if apiKey == "" {
			log.Fatalf("Anthropic API key is required for Claude models")
		}
		c, err = claude.NewClient(claude.ClaudeURL,
			claude.WithModel(input.Parameters.UnderlyingModel),
			claude.WithAPIKey(apiKey),
		)
		if err != nil {
			log.Fatalf("claude.NewClient: %s", err)
		}
	} else if isGeminiModel(input.Parameters.UnderlyingModel) {
		url := openai.GeminiURL
		apiKey := input.Parameters.GoogleKey
		if apiKey == "" {
			log.Fatalf("Google API key is required for Gemini models")
		}
		c, err = openai.NewClient(url,
			openai.WithModel(input.Parameters.UnderlyingModel),
			openai.WithAPIKey(apiKey),
		)
		if err != nil {
			log.Fatalf("openai.NewClient: %s", err)
		}
	} else if isOpenAIModel(input.Parameters.UnderlyingModel) {
		url := openai.OpenAIURL
		apiKey := input.Parameters.ApiKey
		if apiKey == "" {
			log.Fatalf("OpenAI API key is required for OpenAI models")
		}
		c, err = openai.NewClient(url,
			openai.WithModel(input.Parameters.UnderlyingModel),
			openai.WithAPIKey(apiKey),
		)
		if err != nil {
			log.Fatalf("openai.NewClient: %s", err)
		}
	} else {
		// Default to Ollama for local models
		url := openai.OllamaURL
		apiKey := "" // Ollama doesn't need an API key
		c, err = openai.NewClient(url,
			openai.WithModel(input.Parameters.UnderlyingModel),
			openai.WithAPIKey(apiKey),
		)
		if err != nil {
			log.Fatalf("openai.NewClient: %s", err)
		}
	}

	d := causal.NewDiagrammer(c)

	debugDir := path.Dir(inputPath)

	ctx := chat.WithDebugDir(context.Background(), debugDir)

	result, err := d.Generate(ctx, input.Prompt, input.Parameters.BackgroundKnowledge)
	if err != nil {
		log.Fatalf("d.Generate: %s", err)
	}

	output := new(output)
	output.SupportingInfo.Title = result.Title
	output.SupportingInfo.Explanation = result.Explanation
	output.Model = result.Compat()

	outputBytes, err := json.MarshalIndent(output, "", "    ")
	if err != nil {
		log.Fatalf("json.MarshalIndent: %s", err)
	}

	fmt.Printf("%s\n", string(outputBytes))
}
