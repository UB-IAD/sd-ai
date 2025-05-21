package causal

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCanonicalize(t *testing.T) {
	cases := []struct {
		name     string
		expected string
	}{
		{
			name:     "\"a.b\"",
			expected: "a.b",
		},
		{
			name:     "\"a/d\".\"b \\\"c\\\"\"",
			expected: "a/d·b_\\\"c\\\"",
		},
		{
			name:     "\"a/d\".\"b c\"",
			expected: "a/d·b_c",
		},
		{
			name:     "a.\"b c\"",
			expected: "a·b_c",
		},
		{
			name:     "\"a/d\".b",
			expected: "a/d·b",
		},
		{
			name:     "\"quoted\"",
			expected: "quoted",
		},
		{
			name:     "   a b",
			expected: "a_b",
		},
		{
			name:     "Å\nb",
			expected: "å_b",
		},
		{
			name:     "a \n b",
			expected: "a_b",
		},
		{
			name:     "a.b",
			expected: "a·b",
		},
	}

	for _, testcase := range cases {
		t.Run(fmt.Sprintf("%q -> %q", testcase.name, testcase.expected), func(t *testing.T) {
			assert.Equal(t, testcase.expected, Canonicalize(testcase.name))
		})
	}
}

func TestCanonicalizeRoundtrip(t *testing.T) {
	cases := []string{
		"Traffic Congestion",
		"Driver Stress",
		"Accidents",
		"Taxation",
		"Anti-British Sentiment",
		"Colonial Identity",
	}

	for _, in := range cases {
		t.Run(in, func(t *testing.T) {
			canonicalized := Canonicalize(in)
			actual := Prettyize(canonicalized)
			assert.Equal(t, in, actual)
		})
	}
}

func TestJsonRoundtrip(t *testing.T) {
	type testStruct struct {
		Var *Variable `json:"var"`
	}

	s := new(testStruct)
	err := json.Unmarshal([]byte(`{"var": "abc"}`), &s)
	require.NoError(t, err)
	assert.Equal(t, "abc", s.Var.Name())
}

var (
	//go:embed testdata/compat_in1.json
	compatIn1 string
	//go:embed testdata/compat_out1.json
	compatOut1 string
)

func TestCompatTransformation(t *testing.T) {
	var in Map
	err := json.Unmarshal([]byte(compatIn1), &in)
	require.NoError(t, err)

	actual := in.Compat()
	var expected SdJson
	err = json.Unmarshal([]byte(compatOut1), &expected)
	require.NoError(t, err)

	assert.Equal(t, expected, actual)
}
