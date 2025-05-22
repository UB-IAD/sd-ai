package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"strings"
	"sync"
	"testing"

	"github.com/gertd/go-pluralize"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/UB-IAD/sd-ai/go/causal"
	"github.com/UB-IAD/sd-ai/go/chat"
	"github.com/UB-IAD/sd-ai/go/llm/openai"
)

const (
	// prompt is generic and used for all tests
	prompt = "Please find all causal relationships in the background information."
)

// nouns are random variable names to pick from
var nouns = []string{
	"frimbulator",
	"whatajig",
	"balack",
	"whoziewhat",
	"funkado",
	"maxabizer",
	"marticatene",
	"reflupper",
	"exeminte",
	"oc",
	"proptimatire",
	"priary",
	"houtal",
	"poval",
	"auspong",
	"dominitoxing",
	"outrance",
	"illigent",
	"yelb",
	"traze",
	"pablanksill",
	"posistorather",
	"crypteral",
	"oclate",
	"reveforly",
	"yoffa",
	"buwheal",
	"geyflorrin",
	"ih",
	"aferraron",
	"paffling",
	"pershipfulty",
	"copyring",
	"dickstonyx",
	"bellignorance",
	"hashtockle",
	"succupserva",
	"relity",
	"hazmick",
	"ku",
	"obvia",
	"unliescatice",
	"gissorm",
	"phildiscals",
	"loopnova",
	"hoza",
	"arinterpord",
	"burgination",
	"perstablintome",
	"memostorer",
	"baxtoy",
	"hensologic",
	"estintant",
	"perfecton",
	"raez",
	"younjuring",
}

var (
	pluralizeClient = pluralize.NewClient()
	pluralizeMu     = sync.Mutex{}
)

func plural(s string) string {
	pluralizeMu.Lock()
	defer pluralizeMu.Unlock()

	return pluralizeClient.Plural(s)
}

func generateFeedbackLoop(vars []string, loopPolarity causal.Polarity) (string, []causal.Relationship) {
	var causalText strings.Builder
	relationships := make([]causal.Relationship, 0, len(vars))

	for i, v := range vars {
		relationshipPolarity := causal.PositivePolarity
		if i == 0 && loopPolarity.IsPositive() {
			relationshipPolarity = causal.NegativePolarity
		}

		j := (i + 1) % len(vars)

		from := v
		to := vars[j]

		// TODO: I don't understand this
		startingPolarityIsPositive := i%2 > 0

		english, relationship := generateCausalRelationship(from, to, relationshipPolarity, startingPolarityIsPositive)
		causalText.WriteString(english)
		causalText.WriteByte('\n')

		relationships = append(relationships, relationship)
	}

	return strings.TrimSpace(causalText.String()), relationships
}

func generateCausalRelationship(from, to string, relationshipPolarity causal.Polarity, startingPolarityIsPositive bool) (string, causal.Relationship) {
	from, to = plural(from), plural(to)

	var fromModifier, toModifier string

	if relationshipPolarity.IsPositive() {
		if startingPolarityIsPositive {
			fromModifier = "more"
			toModifier = "more"
		} else {
			fromModifier = "less"
			toModifier = "fewer"
		}
	} else {
		if startingPolarityIsPositive {
			fromModifier = "more"
			toModifier = "fewer"
		} else {
			fromModifier = "less"
			toModifier = "more"
		}
	}

	english := fmt.Sprintf("The %s %s there are, the %s %s there are.", fromModifier, from, toModifier, to)
	relationship := causal.Relationship{
		From: from,
		To:   to,
	}

	return english, relationship
}

type LoopDef struct {
	Polarity   causal.Polarity `json:"polarity"`
	LoopLength int             `json:"loop_length"`
}

func (ld LoopDef) String() string {
	return fmt.Sprintf("{%s len:%d}", ld.Polarity.String(), ld.LoopLength)
}

func TestMultipleFeedbackLoops(t *testing.T) {
	testCases := []struct {
		Loops []LoopDef `json:"loops"`
	}{
		{
			Loops: []LoopDef{
				{causal.PositivePolarity, 3},
				{causal.PositivePolarity, 6},
			},
		},
		{
			Loops: []LoopDef{
				{causal.NegativePolarity, 3},
				{causal.PositivePolarity, 6},
			},
		},
		{
			Loops: []LoopDef{
				{causal.PositivePolarity, 5},
				{causal.PositivePolarity, 2},
				{causal.NegativePolarity, 4},
			},
		},
		{
			Loops: []LoopDef{
				{causal.NegativePolarity, 5},
				{causal.NegativePolarity, 2},
				{causal.PositivePolarity, 4},
			},
		},
		{
			Loops: []LoopDef{
				{causal.NegativePolarity, 3},
				{causal.PositivePolarity, 5},
				{causal.PositivePolarity, 6},
				{causal.PositivePolarity, 2},
				{causal.NegativePolarity, 6},
			},
		},
		{
			Loops: []LoopDef{
				{causal.NegativePolarity, 3},
				{causal.PositivePolarity, 5},
				{causal.PositivePolarity, 6},
				{causal.NegativePolarity, 2},
				{causal.NegativePolarity, 6},
			},
		},
	}

	for _, llm := range llmModels {
		for _, test := range testCases {

			name := fmt.Sprintf("%v", test.Loops)
			t.Run(name, func(t *testing.T) {
				var relationships []causal.Relationship
				var causalText strings.Builder
				n := 0
				for _, l := range test.Loops {
					varNames := nouns[n : n+l.LoopLength]
					// FIXME: is this right?
					n += len(varNames) - 1

					english, additionalRelationships := generateFeedbackLoop(varNames, l.Polarity)
					causalText.WriteString(english)
					causalText.WriteByte('\n')

					relationships = append(relationships, additionalRelationships...)
				}

				c, err := openai.NewClient(openai.OpenAIURL,
					openai.WithModel(llm),
					openai.WithAPIKey(openAIAPIKey),
				)
				require.NoError(t, err)

				d := causal.NewDiagrammer(c)

				debugDir := path.Join(".", "testdata", "translation", "multiple_loop", name)
				err = os.RemoveAll(debugDir)
				require.NoError(t, err)
				err = os.MkdirAll(debugDir, 0o755)
				require.NoError(t, err)

				testBytes, err := json.MarshalIndent(&test, "", "  ")
				require.NoError(t, err)
				testBytes = append(testBytes, '\n')
				err = os.WriteFile(path.Join(debugDir, "testcase.json"), testBytes, 0o644)
				require.NoError(t, err)

				ctx := chat.WithDebugDir(context.Background(), debugDir)

				result, err := d.Generate(ctx, prompt, strings.TrimSpace(causalText.String()))
				require.NoError(t, err)
				require.NotNil(t, result)

				resultJson, err := json.MarshalIndent(result, "", "  ")
				require.NoError(t, err)

				err = os.WriteFile(path.Join(debugDir, "result.json"), resultJson, 0o644)
				require.NoError(t, err)

				expectedMap := causal.NewMap(relationships)
				require.Equal(t, len(test.Loops), len(expectedMap.Loops()))

				expectedVars := expectedMap.Variables().Slice()
				for i, v := range expectedVars {
					expectedVars[i] = causal.Canonicalize(v)
				}
				actualVars := expectedMap.Variables().Slice()
				for i, v := range actualVars {
					actualVars[i] = causal.Canonicalize(v)
				}

				assert.Equal(t, expectedVars, actualVars)
				assert.Equal(t, expectedMap.Loops(), result.Loops())
			})
		}
	}
}
