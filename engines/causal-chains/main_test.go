package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestIsOpenAIModel(t *testing.T) {
	for _, name := range []string{
		"gpt-3.5-turbo-instruct",
		"GPT-4.1",
		"o4-mini",
		"o3",
	} {
		t.Run(name, func(t *testing.T) {
			assert.True(t, isOpenAIModel(name))
		})
	}

	for _, name := range []string{
		"llama4:scout",
		"qwen3:32b",
		"gemma3:12b",
		"phi4",
		"llama3.3:70b-instruct-q4_K_M",
		"gemma2:latest",
		"qwq",
		"llama3.3:70b-instruct-q5_K_M",
		"phi4:14b-fp16",
	} {
		t.Run(name, func(t *testing.T) {
			assert.False(t, isOpenAIModel(name))
		})
	}
}

func TestIsGeminiModel(t *testing.T) {
	for _, name := range []string{
		"gemini-2.5-flash",
		"gemini-2.5-flash-lite-preview-06-17",
		"gemini-2.5-pro",
		"gemini-2.0-flash",
		"gemini-2.0-flash-lite",
		"gemini-1.5-flash",
		"GEMINI-1.5-PRO",
		"Gemini-Pro",
	} {
		t.Run(name, func(t *testing.T) {
			assert.True(t, isGeminiModel(name))
		})
	}

	for _, name := range []string{
		"gpt-4o",
		"llama4:scout",
		"qwen3:32b",
		"gemma3:12b",
		"phi4",
		"o3-mini",
	} {
		t.Run(name, func(t *testing.T) {
			assert.False(t, isGeminiModel(name))
		})
	}
}
