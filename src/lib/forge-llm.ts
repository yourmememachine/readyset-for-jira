/**
 * Production {@link LlmClient} backed by the Forge LLMs API
 * (`chat()` from `@forge/llm`, GA 2026 — DESIGN.md §1).
 *
 * This is the ONLY module that imports `@forge/llm`, mirroring how
 * `forge-jira.ts` is the only module that calls `requestJira`. It is
 * deliberately thin: prompt in, reply text out; all decisions
 * (parsing, caching, fallback) live in the tested improver. Nothing
 * in the test suite imports this file, so no test makes a real call.
 *
 * Billing note (DESIGN.md Risks): Forge LLM calls are billed to the
 * app developer. Haiku is the cheapest tier, drafts are capped at
 * ~600 output tokens, and the improver caches by content hash, so a
 * given issue content costs at most one call.
 */
import { chat } from '@forge/llm';
import { buildDraftPrompt, type DraftRequest, type LlmClient } from './llm';

/**
 * The Haiku-tier model id. Phase 2b verifies the exact enabled id
 * against the live model list (`list()` from `@forge/llm`) and the
 * manifest's `llm` enablement before the first deploy — this constant
 * is the single place to adjust.
 */
export const IMPROVER_MODEL = 'claude-haiku-4-5';

/** Per-draft output cap from the design (≤ ~600 tokens). */
const MAX_COMPLETION_TOKENS = 600;

export class ForgeLlmClient implements LlmClient {
  async draftDescription(request: DraftRequest): Promise<string> {
    const prompt = buildDraftPrompt(request);
    const response = await chat({
      model: IMPROVER_MODEL,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      max_completion_tokens: MAX_COMPLETION_TOKENS,
    });
    const content = response.choices[0]?.message.content;
    const text =
      typeof content === 'string'
        ? content
        : (content ?? [])
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('');
    if (text.trim().length === 0) {
      throw new Error('ReadySet: Forge LLM returned an empty reply');
    }
    return text;
  }
}
