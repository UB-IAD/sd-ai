package causal

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/UB-IAD/sd-ai/go/chat"
)

type Diagrammer interface {
	Generate(ctx context.Context, prompt, backgroundKnowledge string) (*Map, error)
}

type diagrammer struct {
	client chat.Client
}

var _ Diagrammer = &diagrammer{}

func NewDiagrammer(client chat.Client) Diagrammer {
	return diagrammer{
		client: client,
	}
}

var (
	//go:embed system_prompt.txt
	baseSystemPrompt string

	//go:embed background_prompt.txt
	backgroundPrompt string
)

func (d diagrammer) Generate(ctx context.Context, prompt, backgroundKnowledge string) (*Map, error) {
	schema, err := json.MarshalIndent(RelationshipsResponseSchema, "", "    ")
	if err != nil {
		return nil, fmt.Errorf("json.MarshalIndent: %w", err)
	}

	systemPrompt := strings.ReplaceAll(baseSystemPrompt, "{schema}", string(schema))

	msg := chat.Message{
		Role: chat.UserRole,
		Content: fmt.Sprintf("%s\n\n%s",
			strings.ReplaceAll(backgroundPrompt, "{backgroundKnowledge}", backgroundKnowledge),
			prompt,
		),
	}

	c := d.client.NewChat(systemPrompt)

	resp, err := c.Message(ctx, msg,
		chat.WithResponseFormat("relationships_response", true, RelationshipsResponseSchema),
		chat.WithMaxTokens(64*1024),
	)
	if err != nil {
		return nil, fmt.Errorf("c.ChatCompletion: %w", err)
	}

	var rr Map
	if err := json.Unmarshal([]byte(resp.Content), &rr); err != nil {
		return nil, fmt.Errorf("json.Unmarshal: %w", err)
	}

	return &rr, nil
}
