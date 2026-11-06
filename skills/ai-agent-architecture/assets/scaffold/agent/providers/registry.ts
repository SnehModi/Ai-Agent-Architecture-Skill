// SCAFFOLD TEMPLATE (ai-agent-architecture skill) — adapt placeholders marked TODO to the target app.

import { AnthropicChatProvider } from './anthropic'
import { OpenAIChatProvider } from './openai'
import type { ChatProvider } from './types'

/**
 * Resolves a "provider:model" string (e.g. "openai:gpt-5-mini" or "anthropic:claude-sonnet-5-5", read from an env var such
 * as AGENT_MODEL) to a ChatProvider. An unrecognised provider prefix is a config/programming
 * error (bad env var), not a per-request business outcome, so it throws a plain Error, not
 * an app-level HTTP error — see references/architecture.md §2 "Provider seam".
 *
 * openai.ts and anthropic.ts are two adapters behind the same ChatProvider interface; the
 * loop can't tell them apart. TODO: add a `case` for each additional provider you support
 * (Gemini, ...) — each one is a new adapter file implementing the same interface. That is
 * the entire point of the seam: this switch is the only place that grows.
 */
export function resolveProvider(modelString: string, apiKey: string): ChatProvider {
  const separatorIndex = modelString.indexOf(':')
  if (separatorIndex === -1) {
    throw new Error(`resolveProvider: invalid model string "${modelString}", expected "provider:model"`)
  }

  const provider = modelString.slice(0, separatorIndex)
  const model = modelString.slice(separatorIndex + 1)

  switch (provider) {
    case 'openai':
      return new OpenAIChatProvider({ apiKey, model })
    case 'anthropic':
      return new AnthropicChatProvider({ apiKey, model })
    default:
      throw new Error(`resolveProvider: unknown provider "${provider}" in model string "${modelString}"`)
  }
}
