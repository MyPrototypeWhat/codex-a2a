import type { ThreadOptions } from '@openai/codex-sdk'

export const DEFAULT_THREAD_OPTIONS: ThreadOptions = {
  sandboxMode: 'workspace-write',
  networkAccessEnabled: true,
  approvalPolicy: 'on-failure',
  webSearchEnabled: true,
  modelReasoningEffort: 'medium',
  workingDirectory: '',
}
