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
 * The Haiku-tier model id. Verified live in phase 2b (2026-11-17):
 * the undated `claude-haiku-4-5` is rejected by the API with
 * FORGE_LLMS_MODEL_NOT_FOUND; the supported Haiku id is the dated
 * variant below (Forge LLMs models reference, status ACTIVE). This
 * constant is the single place to adjust when the model list changes.
 */
export const IMPROVER_MODEL = 'claude-haiku-4-5-20251001';

/** Per-draft output cap from the design (≤ ~600 tokens). */
const MAX_COMPLETION_TOKENS = 600;

/**
 * Hard ceiling on one LLM call (war-room B23): a hung `chat()` would
 * otherwise ride out the whole 25 s UI invocation budget and die with
 * it, taking the template fallback down too. Racing the call against
 * this timeout turns a hang into an ordinary LLM failure, which the
 * improver already falls back from.
 */
const LLM_TIMEOUT_MS = 20_000;

export class ForgeLlmClient implements LlmClient {
  async draftDescription(request: DraftRequest): Promise<string> {
    const prompt = buildDraftPrompt(request);
    const response = await Promise.race([
      chat({
        model: IMPROVER_MODEL,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        max_completion_tokens: MAX_COMPLETION_TOKENS,
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error(`ReadySet: Forge LLM call timed out after ${LLM_TIMEOUT_MS} ms`)),
          LLM_TIMEOUT_MS,
        );
      }),
    ]);
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
