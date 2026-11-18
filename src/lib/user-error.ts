/**
 * Map a resolver/backend failure to a sentence a user can act on.
 *
 * Backend errors are thrown with short status-coded messages
 * (`ReadySet: … failed with HTTP 403`) and raw REST bodies are never
 * forwarded (cross-review B14) — this mapper is the only place those
 * codes become UI copy.
 */
export function toUserMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Only project administrators')) {
    return message;
  }
  const http = message.match(/HTTP (\d{3})/);
  if (http) {
    switch (http[1]) {
      case '410':
        return 'This Jira site no longer supports an API ReadySet used. Please update ReadySet to the latest version.';
      case '403':
        return 'ReadySet does not have permission to read this data. Ask a Jira admin to check the app’s permissions.';
      case '404':
        return 'ReadySet could not find that issue or project in Jira.';
      case '429':
        return 'Jira is rate-limiting ReadySet right now. Wait a moment and try again.';
      default:
        return `Jira returned an error (HTTP ${http[1]}). Try again in a moment; if it persists, contact your Jira admin.`;
    }
  }
  return 'Something went wrong loading ReadySet data. Try again in a moment.';
}
