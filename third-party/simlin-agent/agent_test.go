package simlinagent

import (
	_ "embed"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

//go:embed testdata/simple_sfd.json
var simpleSFD string

type testFixture struct {
	Prompt string `json:"prompt"`
}

type sdJSONOutput struct {
	Variables     []variable     `json:"variables"`
	Relationships []relationship `json:"relationships"`
	Specs         map[string]any `json:"specs"`
}

type variable struct {
	Name     string   `json:"name"`
	Type     string   `json:"type"`
	Equation string   `json:"equation"`
	Inflows  []string `json:"inflows,omitempty"`
	Outflows []string `json:"outflows,omitempty"`
}

type relationship struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Polarity string `json:"polarity"`
}

// podman's rootless mode remaps UIDs, so volume mounts are inaccessible
// to the non-root container user without --userns=keep-id
func isPodman() bool {
	out, _ := exec.Command("docker", "--version").CombinedOutput()
	return strings.Contains(string(out), "podman")
}

func TestSimlinAgentSimpleSFD(t *testing.T) {
	apiKey := os.Getenv("ANTHROPIC_API_KEY")
	if apiKey == "" {
		t.Skip("Skipping test because ANTHROPIC_API_KEY is not set")
	}

	if err := exec.Command("docker", "image", "inspect", "sd-ai-simlin-agent").Run(); err != nil {
		t.Skip("Skipping test because sd-ai-simlin-agent Docker image is not built")
	}

	var fixture testFixture
	require.NoError(t, json.Unmarshal([]byte(simpleSFD), &fixture))

	tempDir := t.TempDir()

	inputPath := filepath.Join(tempDir, "input.sd.json")
	require.NoError(t, os.WriteFile(inputPath, []byte(`{"variables":[],"relationships":[],"specs":{}}`), 0644))

	dockerArgs := []string{"run", "--rm", "-i"}
	if isPodman() {
		dockerArgs = append(dockerArgs, "--userns=keep-id")
	}
	dockerArgs = append(dockerArgs,
		"-v", tempDir+":/workspace",
		"-e", "ANTHROPIC_API_KEY="+apiKey,
		"sd-ai-simlin-agent",
		"--model", "claude-sonnet-4-6")
	taskPrompt := "## Task\n\n" + fixture.Prompt +
		"\n\n## Input\n\n" +
		"The current model is at /workspace/input.sd.json. " +
		"If it is empty or minimal, build a new model from scratch. " +
		"If it is populated, iterate on or fix it.\n\n" +
		"## Output\n\n" +
		"Write your final model to /workspace/output.json in SD-JSON format.\n\n" +
		"IMPORTANT: if the task asks you to provide an explanation or description, " +
		"write it to /workspace/explanation.txt as plain text."

	cmd := exec.Command("docker", dockerArgs...)
	cmd.Stdin = strings.NewReader(taskPrompt)

	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Logf("Docker output:\n%s", output)
	}
	require.NoError(t, err, "Docker container should exit successfully")

	outputPath := filepath.Join(tempDir, "output.json")
	outputData, err := os.ReadFile(outputPath)
	require.NoError(t, err, "output.json should exist")

	var result sdJSONOutput
	require.NoError(t, json.Unmarshal(outputData, &result), "output.json should be valid JSON")

	hasStock := false
	for _, v := range result.Variables {
		if v.Type == "stock" {
			hasStock = true
			break
		}
	}
	assert.True(t, hasStock, "output should contain at least one stock variable")
	assert.NotEmpty(t, result.Relationships, "output should contain relationships")
	assert.NotEmpty(t, result.Specs, "output should contain specs")
}
