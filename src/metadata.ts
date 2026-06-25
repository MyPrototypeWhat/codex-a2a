import type { Message } from '@a2a-js/sdk'

/** The metadata key under which Codex-specific fields are namespaced (per A2A's extension-metadata convention). */
export const CODEX_AGENT_METADATA_KEY = 'codexAgent'

/** Legacy inbound key for the thread id, still accepted by {@link readThreadId}. */
export const LEGACY_THREAD_ID_KEY = 'codexThreadId'

/**
 * Discriminator on `status-update.metadata.codexAgent.kind`, identifying which kind of Codex
 * stream event a status update represents. Useful for clients rendering the event stream.
 */
export type CodexAgentEventKind =
  | 'state-change'
  | 'thread-started'
  | 'turn-started'
  | 'turn-completed'
  | 'text-content'
  | 'thought'
  | 'tool-call-update'

/** Shape of the `codexAgent` namespace the server attaches to outbound A2A status-update metadata. */
export interface CodexAgentMetadata {
  kind: CodexAgentEventKind
  /** Present on `thread-started`: the Codex thread id. Echo it back to resume the thread. */
  threadId?: string
}

/**
 * Build the message metadata that binds a request to an existing Codex thread. Spread the result
 * into a message's `metadata` to resume a prior conversation across a server restart:
 *
 * ```ts
 * const message = {
 *   kind: 'message',
 *   role: 'user',
 *   messageId: crypto.randomUUID(),
 *   parts: [{ kind: 'text', text: 'continue' }],
 *   metadata: threadIdMetadata(savedThreadId),
 * }
 * ```
 */
export function threadIdMetadata(threadId: string): { codexAgent: { threadId: string } } {
  return { [CODEX_AGENT_METADATA_KEY]: { threadId } } as { codexAgent: { threadId: string } }
}

/**
 * Read a Codex thread id from an inbound A2A message's metadata. Accepts the canonical
 * `metadata.codexAgent.threadId` and the legacy `metadata.codexThreadId`. Returns `undefined`
 * when absent or not a non-empty string.
 */
export function readThreadId(message: Message): string | undefined {
  const meta = message.metadata
  if (!meta) return undefined
  const codexAgent = meta[CODEX_AGENT_METADATA_KEY] as { threadId?: unknown } | undefined
  const fromAgent = codexAgent?.threadId
  const raw = typeof fromAgent === 'string' ? fromAgent : meta[LEGACY_THREAD_ID_KEY]
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}
