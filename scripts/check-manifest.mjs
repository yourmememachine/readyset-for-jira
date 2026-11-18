#!/usr/bin/env node
/**
 * Static manifest assertions (cross-review B17).
 *
 * The old `lint:manifest` script only grepped for two strings and
 * passed while `label:` was missing — the exact defect that would have
 * hidden the issue panel in production (B2). These checks pin every
 * manifest property the cross-review established:
 *
 * - jira:issueContext carries BOTH `title:` and `label:` (B2)
 * - jira:projectPage carries a `title:`
 * - the trigger subscribes to the deleted-issue event (B9)
 * - `app.id` is present (placeholder until `forge register`, B3)
 * - there is NO `license:` key (link sharing is the distribution path)
 * - write:jira-work is present (phase 2a: the Improve Apply flow's
 *   writes use it — in phase 1 its ABSENCE was pinned by B17, when
 *   nothing wrote to Jira)
 * - phase 2a modules: the `llm` enablement names the Haiku tier; the
 *   three Coach actions exist and are GET; `rovo:agent` wires exactly
 *   those actions and the agent-prompt resource, which is declared.
 *
 * This is a text-level check, not a YAML parse — the manifest is small
 * and hand-maintained; `forge lint` (phase 2b) remains the real schema
 * validation.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.yml');
const text = readFileSync(manifestPath, 'utf8');

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

function moduleBlock(name) {
  const start = text.indexOf(`  ${name}:`);
  if (start < 0) return '';
  const rest = text.slice(start + name.length + 3);
  const nextModule = rest.search(/\n  [a-z][a-zA-Z]*:/);
  return nextModule < 0 ? rest : rest.slice(0, nextModule);
}

const issueContext = moduleBlock('jira:issueContext');
check(/title:\s*\S/.test(issueContext), 'jira:issueContext is missing a title');
check(/label:\s*\S/.test(issueContext), 'jira:issueContext is missing the required label (B2)');

const projectPage = moduleBlock('jira:projectPage');
check(/title:\s*\S/.test(projectPage), 'jira:projectPage is missing a title');

check(
  text.includes('avi:jira:deleted:issue'),
  'trigger does not subscribe to avi:jira:deleted:issue (B9)',
);
check(/^\s+id:\s*ari:cloud:ecosystem::app\//m.test(text), 'app.id is missing');
check(!/^\s*license:/m.test(text), 'manifest must not contain a license: key');
// Scope check runs over non-comment lines only — prose may mention the
// scope while explaining why it is absent.
const codeOnly = text
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');
check(
  codeOnly.includes('write:jira-work'),
  'write:jira-work scope missing but the phase-2a Apply flow writes to Jira',
);

const ACTION_KEYS = ['fetch-issue-readiness', 'fetch-project-readiness', 'fetch-fix-first'];
const actionBlock = moduleBlock('action');
for (const key of ACTION_KEYS) {
  check(actionBlock.includes(`key: ${key}`), `action module is missing ${key}`);
}
const getVerbs = actionBlock.match(/actionVerb:\s*GET/g) ?? [];
check(
  getVerbs.length === ACTION_KEYS.length,
  `Coach actions must all be actionVerb: GET (found ${getVerbs.length})`,
);

const agentBlock = moduleBlock('rovo:agent');
check(agentBlock.includes('key: readyset-coach'), 'rovo:agent readyset-coach is missing');
for (const key of ACTION_KEYS) {
  check(agentBlock.includes(`- ${key}`), `rovo:agent does not wire action ${key}`);
}
check(
  agentBlock.includes('resource: agent-prompt'),
  'rovo:agent does not use the agent-prompt resource',
);
check(
  text.includes('key: agent-prompt') && text.includes('path: static/agent/prompt.md'),
  'agent-prompt resource (static/agent/prompt.md) is not declared',
);

const llmBlock = moduleBlock('llm');
check(/haiku/i.test(llmBlock), 'llm module does not enable the Haiku tier');

if (failures.length > 0) {
  console.error('manifest check FAILED:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('manifest check OK');
