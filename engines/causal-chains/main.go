package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path"
	"strings"

	"github.com/UB-IAD/sd-ai/go/chat"

	"github.com/UB-IAD/sd-ai/go/causal"

	"github.com/UB-IAD/sd-ai/go/llm/openai"
)

type parameters struct {
	ApiKey              string `json:"apiKey"`
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
	Model          causal.SdJson  `json:"model"`
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
	if err = json.Unmarshal(inputBytes, &input); err != nil {
		log.Fatalf("json.Unmarshal: %s", err)
	}

	if input.Parameters.ApiKey == "" {
		input.Parameters.ApiKey = os.Getenv("OPENAI_API_KEY")
	}

	url := openai.OpenAIURL
	if !isOpenAIModel(input.Parameters.UnderlyingModel) {
		url = openai.OllamaURL
	}

	c, err := openai.NewClient(url,
		openai.WithModel(input.Parameters.UnderlyingModel),
		openai.WithAPIKey(input.Parameters.ApiKey),
	)
	if err != nil {
		log.Fatalf("openai.NewClient: %s", err)
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
