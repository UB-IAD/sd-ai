package causal

import (
	"encoding/json"
	"os"
	"os/exec"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var testMap1 = &Map{
	Title:       "American Revolution Onset",
	Explanation: "Based on historical context and user input,",
	//Relationships: []Relationship{
	//	{
	//		From:              "Tax Burden",
	//		To:                "Tensions",
	//		Polarity:          "+",
	//		Reasoning:         "The British government imposed various taxes, such as the Stamp Act and Townshend Acts, which increased the financial burden on American colonies.",
	//		PolarityReasoning: "An increase in Tax Burden led to an increase in Tensions.",
	//	},
	//	{
	//		From:              "Tax Burden",
	//		To:                "Resistance",
	//		Polarity:          "+",
	//		Reasoning:         "High taxes fueled protests and boycotts against British goods, demonstrating growing resistance among colonists.",
	//		PolarityReasoning: "An increase in Tax Burden led to an increase in Resistance.",
	//	},
	//	{
	//		From:              "Tensions",
	//		To:                "Clashes",
	//		Polarity:          "+",
	//		Reasoning:         "Escalating tensions between British authorities and American patriots raised the probability of violent confrontations.",
	//		PolarityReasoning: "Rising Tensions increased the likelihood of Clashes.",
	//	},
	//	{
	//		From:              "Resistance",
	//		To:                "Clashes",
	//		Polarity:          "+",
	//		Reasoning:         "Increased resistance through protests, boycotts, and other forms of dissent heightened the risk of physical confrontations with British forces.",
	//		PolarityReasoning: "As Resistance grew, so did the likelihood of Clashes.",
	//	},
	//	{
	//		From:              "Clashes",
	//		To:                "Tensions",
	//		Polarity:          "+",
	//		Reasoning:         "Violent encounters between colonists and British troops intensified feelings of hostility and mistrust, fueling a cycle of escalating violence.",
	//		PolarityReasoning: "An increase in Clashes increased Tensions further.",
	//	},
	//	{
	//		From:              "Clashes",
	//		To:                "Resistance",
	//		Polarity:          "+",
	//		Reasoning:         "Each clash between the British and the colonists served to galvanize support among the population for independence, strengthening the resolve of those resisting British authority.",
	//		PolarityReasoning: "An increase in Clashes also increased Resistance as more colonists became determined to fight against British rule.",
	//	},
	//	{
	//		From:              "Tensions",
	//		To:                "Tax Burden",
	//		Polarity:          "+",
	//		Reasoning:         "As tensions rose, the British government responded with stricter enforcement of its authority and additional taxation measures, aiming to quell dissent and maintain control.",
	//		PolarityReasoning: "Increased Tensions led to increased Tax Burden as Britain attempted to assert its control over the colonies more firmly.",
	//	},
	//},
}

var roadRage1 = `{
  "title": "Societal Factors Fueling Road Rage Cycles",
  "explanation": "This CLD illustrates how various societal factors contribute to road rage incidents, creating a complex web of interconnected influences.  It highlights how stress, aggression, and perceived injustice on roadways can fuel a cycle of escalating anger and violence.",
  "relationships": [
    {
      "from": "Traffic Congestion",
      "to": "Stress Levels",
      "polarity": "+",
      "reasoning": "Trapped drivers experience increased stress and frustration as they encounter heavy traffic.",
      "polarityReasoning": "High traffic lead to frustration and delays"
    },
    {
      "from": "Aggression in Society",
      "to": "Aggressive Driving Behaviors",
      "polarity": "+",
      "reasoning": "When a society embraces aggressive behaviors, it normalizes such tendencies, including on the road.",
      "polarityReasoning": "Greater societal aggression can lead to more aggressive driving behaviors. "
    },
    {
      "from": "Aggressive Driving Behaviors",
      "to": "Road Rage Incidents",
      "polarity": "+",
      "reasoning": "Tailgating, speeding, and rude gestures can incite anger and retaliation from other motorists.",
      "polarityReasoning": "Aggressive driving often provokes responses from other drivers. "
    },
    {
      "from": "Stress Levels",
      "to": "Road Rage Incidents",
      "polarity": "+",
      "reasoning": "When drivers are already stressed, minor incidents on the road can escalate into moments of rage.",
      "polarityReasoning": "High stress levels can exacerbate reactions to triggering events in traffic. "
    },
    {
      "from": "Perceived Injustice",
      "to": "Road Rage Incidents",
      "polarity": "+",
      "reasoning": "An incident like a cut-off or perceived reckless driving can make drivers feel wrongly treated, leading to heightened aggression.",
      "polarityReasoning": "Drivers feeling treated unfairly may react with anger towards other motorists. "
    },
    {
      "from": "Poor Traffic Laws Enforcement",
      "to": "Aggressive Driving Behaviors",
      "polarity": "+",
      "reasoning": "When there are few consequences for reckless or aggressive driving, such behaviors become more prevalent.",
      "polarityReasoning": "Lack of enforcement can lead to more risky driving behaviors that contribute to road rage. "
    },
    {
      "from": "Road Rage Incidents",
      "to": "Aggressive Driving Behaviors",
      "polarity": "+",
      "reasoning": "When drivers witness or experience road rage, it sets a precedent for future aggressive behavior.",
      "polarityReasoning": "Increased incidents can lead to a culture of fear and hostility on the road. "
    },
    {
      "from": "Lack of Driver Education",
      "to": "Aggressive Driving Behaviors",
      "polarity": "+",
      "reasoning": "Drivers lacking proper education may be more prone to mistakes and conflicts on the road.",
      "polarityReasoning": "Inadequate training can contribute to poor driving habits and an increased likelihood of road rage. "
    }
  ]
}`

func TestExtractingResults(t *testing.T) {
	causalMap := testMap1

	vars := causalMap.Variables()
	expectedVars := NewSet(
		"Tax Burden",
		"Resistance",
		"Clashes",
		"Tensions",
	)
	assert.Equal(t, expectedVars, vars)

	loops := causalMap.Loops()
	assert.Contains(t, loops, []string{"Clashes", "Tensions", "Clashes"})
	assert.Contains(t, loops, []string{"Clashes", "Resistance", "Clashes"})
	assert.Contains(t, loops, []string{"Tax Burden", "Tensions", "Tax Burden"})
	assert.Contains(t, loops, []string{"Clashes", "Tensions", "Tax Burden", "Resistance", "Clashes"})
	assert.Equal(t, 4, len(loops))
}

func TestDiagrammerSVG(t *testing.T) {
	var causalMap Map
	err := json.Unmarshal([]byte(roadRage1), &causalMap)
	require.NoError(t, err)

	loops := causalMap.Loops()
	assert.NotEmpty(t, loops)

	svg, err := causalMap.VisualSVG()
	require.NoError(t, err)

	// assert we got something
	assert.Greater(t, len(svg), 0)

	f, err := os.CreateTemp("", "cld-*.svg")
	require.NoError(t, err)

	n, err := f.Write(svg)
	require.NoError(t, err)
	require.Equal(t, len(svg), n)

	path := f.Name()
	require.NoError(t, f.Close())

	err = exec.Command("open", path).Run()
	require.NoError(t, err)
}
