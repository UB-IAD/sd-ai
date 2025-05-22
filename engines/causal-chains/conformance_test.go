package main

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path"
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/UB-IAD/sd-ai/go/causal"
	"github.com/UB-IAD/sd-ai/go/chat"
	"github.com/UB-IAD/sd-ai/go/llm/openai"
)

const (
	americanRevolution = "American Revolution"
	roadRage           = "Road Rage"
)

var openAIAPIKey = os.Getenv("OPENAI_API_KEY")

type responseExpectations struct {
	minFeedback  uint
	maxFeedback  uint
	minVariables uint
	maxVariables uint
	variables    []string
}
type conformanceConstraints struct {
	additionalPrompt string
	description      string
	response         responseExpectations
}

type testCase struct {
	name                string
	prompt              string
	backgroundKnowledge string
	conformance         conformanceConstraints
}

var baseTestCases = map[string]testCase{
	americanRevolution: {
		prompt: "Using your knowledge of how the American Revolution started and the additional information I have given you, please give me a feedback based explanation for how the American Revolution came about.",
		backgroundKnowledge: `The American Revolution was caused by a number of factors, including:
* Taxation: The British imposed new taxes on the colonies to raise money, such as the Stamp Act of 1765, which taxed legal documents, newspapers, and playing cards. The colonists were angry because they had no representatives in Parliament.
* The Boston Massacre: In 1770, British soldiers fired on a crowd of colonists in Boston, killing five people. The massacre intensified anti-British sentiment and became a propaganda tool for the colonists.
* The Boston Tea Party: The Boston Tea Party was a major act of defiance against British rule. It showed that Americans would not tolerate tyranny and taxation.
* The Intolerable Acts: The British government passed harsh laws that the colonists called the Intolerable Acts. One of the acts closed the port of Boston until the colonists paid for the tea they had ruined.
* The French and Indian War: The British wanted the colonies to repay them for their defense during the French and Indian War (1754–63).
* Colonial identity: The colonists developed a stronger sense of American identity`,
	},
	roadRage: {
		prompt: "Using your knowledge of how road rage happens and the additional information I have given you, please give me a feedback based explanation for how road rage incidents might change in the future.",
		backgroundKnowledge: `Road rage, defined as aggressive driving behavior caused by anger and frustration, can be triggered by various factors: 
Psychological Factors: 
* Stress and Anxiety: High stress levels can make drivers more irritable and prone to aggressive reactions.
* Personality Traits: Individuals with impulsive, hostile, or competitive personalities may be more likely to engage in road rage.
* Frustration: Feeling frustrated or blocked by other drivers can lead to anger and aggression.

Situational Factors: 
* Traffic Congestion: Heavy traffic, delays, and stop-and-go conditions can increase stress and impatience.
* Perceived Provocations: Being cut off, tailgated, or honked at can provoke anger and retaliatory behavior.
* Impatience: Drivers who are running late or have a low tolerance for delays may become aggressive.

Environmental Factors: 
* Road Design: Poor road design, such as narrow lanes or confusing intersections, can contribute to traffic congestion and frustration.
* Weather Conditions: Adverse weather conditions, such as heavy rain or snow, can increase stress and make driving more challenging.

Other Factors: 
* Learned Behavior: Observing aggressive driving behavior from others can normalize it and increase the likelihood of engaging in road rage.
* Lack of Sleep: Fatigue can impair judgment and make drivers more susceptible to anger.
* Distracted Driving: Using a phone, texting, or eating while driving can increase the risk of accidents and provoke anger.`,
	},
}

var genericConstraints = []conformanceConstraints{
	{
		additionalPrompt: "Your response MUST include at most 5 variables.",
		description:      "include a maximum number of variables",
		response: responseExpectations{
			maxVariables: 5,
		},
	},
	{
		additionalPrompt: "Your response MUST include at least 8 feedback loops.",
		description:      "include a minimum number of feedback loops",
		response: responseExpectations{
			minFeedback: 8,
		},
	},
	{
		additionalPrompt: "Your response MUST include at most 4 feedback loops.",
		description:      "include a maximum number of feedback loops",
		response: responseExpectations{
			maxFeedback: 4,
		},
	},
	{
		additionalPrompt: "Your response MUST include at most 4 feedback loops and at most 5 variables.",
		description:      "include a maximum number of feedback loops and a maximum number of variables",
		response: responseExpectations{
			maxFeedback:  4,
			maxVariables: 5,
		},
	},
	{
		additionalPrompt: "Your response MUST include at least 6 feedback loops and at least 8 variables.",
		description:      "include a minimum number of feedback loops and a minimum number of variables",
		response: responseExpectations{
			minFeedback:  6,
			minVariables: 8,
		},
	},
	{
		additionalPrompt: "Your response MUST include at most 4 feedback loops and at least 5 variables.",
		description:      "include a maximum number of feedback loops and a minimum number of variables",
		response: responseExpectations{
			maxFeedback:  4,
			minVariables: 5,
		},
	},
	{
		additionalPrompt: "Your response MUST include at least 6 feedback loops and at most 15 variables.",
		description:      "include a min number of feedback loops and a maximum number of variables",
		response: responseExpectations{
			minFeedback:  6,
			maxVariables: 15,
		},
	},
	{
		additionalPrompt: "Your response MUST include at least 10 variables.",
		description:      "include a minimum number of variables",
		response: responseExpectations{
			minVariables: 10,
		},
	},
}

var specificConstraints = map[string]conformanceConstraints{
	"American Revolution": {
		additionalPrompt: `Your response MUST include the variables "Taxation", "Anti-British Sentiment" and "Colonial Identity".`,
		description:      "include requested variables",
		response: responseExpectations{
			variables: []string{
				"Taxation",
				"Anti-British Sentiment",
				"Colonial Identity",
			},
		},
	},
	"Road Rage": {
		additionalPrompt: `Your response MUST include the variables "Traffic Congestion", "Driver Stress" and "Accidents".`,
		description:      "include requested variables",
		response: responseExpectations{
			variables: []string{
				"Traffic Congestion",
				"Driver Stress",
				"Accidents",
			},
		},
	},
}

var llmModels = []string{
	"o4-mini",
	//"llama4:scout",
	//"gemma3:27b",
	//"gemma2",
	//"phi4",
	//"llama3.3:70b-instruct-q4_K_M",
	//"qwq",
}

func TestConformance(t *testing.T) {
	var allTests []testCase
	for _, name := range slices.Sorted(maps.Keys(specificConstraints)) {
		testCase := baseTestCases[name]
		testCase.name = name
		testCase.conformance = specificConstraints[name]

		allTests = append(allTests, testCase)
	}
	for _, test := range genericConstraints {
		for _, name := range slices.Sorted(maps.Keys(baseTestCases)) {
			testCase := baseTestCases[name]
			testCase.name = name
			testCase.conformance = test
			allTests = append(allTests, testCase)
		}
	}

	for _, llm := range llmModels {
		for _, testCase := range allTests {
			name := fmt.Sprintf("%s_(%s):_%s", llm, testCase.name, testCase.conformance.additionalPrompt)
			t.Run(name, func(t *testing.T) {
				var c chat.Client
				var err error
				if openAIAPIKey != "" {
					c, err = openai.NewClient(openai.OpenAIURL,
						openai.WithModel(llm),
						openai.WithAPIKey(openAIAPIKey),
					)
				} else {
					c, err = openai.NewClient(openai.OllamaURL, openai.WithModel(llm))
				}
				require.NoError(t, err)

				d := causal.NewDiagrammer(c)

				prompt := testCase.prompt + "\n\n" + testCase.conformance.additionalPrompt

				debugDir := path.Join(".", "testdata", "conformance", name)
				err = os.RemoveAll(debugDir)
				require.NoError(t, err)
				err = os.MkdirAll(debugDir, 0o755)
				require.NoError(t, err)

				ctx := chat.WithDebugDir(context.Background(), debugDir)

				result, err := d.Generate(ctx, prompt, testCase.backgroundKnowledge)
				require.NoError(t, err)
				require.NotNil(t, result)

				resultJson, err := json.MarshalIndent(result, "", "  ")
				require.NoError(t, err)

				err = os.WriteFile(path.Join(debugDir, "result.json"), resultJson, 0o644)
				require.NoError(t, err)

				vars := causal.NewSet[string]()
				for _, v := range result.Variables().Slice() {
					vars.Add(causal.Canonicalize(v))
				}

				loops := result.Loops()

				requirements := testCase.conformance.response
				for _, v := range requirements.variables {
					v = causal.Canonicalize(v)
					assert.Contains(t, vars, v)
				}

				if requirements.minVariables > 0 {
					assert.GreaterOrEqualf(t, len(vars), int(requirements.minVariables), "expected at least %d variables, got %v", requirements.minVariables, vars.Slice())
				}
				if requirements.maxVariables > 0 {
					assert.LessOrEqualf(t, len(vars), int(requirements.maxVariables), "expected at most %d variables, got %v", requirements.maxVariables, vars.Slice())
				}
				if requirements.minFeedback > 0 {
					assert.GreaterOrEqualf(t, len(loops), int(requirements.minFeedback), "expected at least %d loops, got %v", requirements.minFeedback, loops)
				}
				if requirements.maxFeedback > 0 {
					assert.LessOrEqualf(t, len(loops), int(requirements.maxFeedback), "expected at most %d loops, got %v", requirements.maxFeedback, loops)
				}

				require.NoError(t, err)
				_ = result
			})
		}
	}
}
