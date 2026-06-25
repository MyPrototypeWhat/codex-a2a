import type { ThreadOptions } from '@openai/codex-sdk'

export const DEFAULT_THREAD_OPTIONS: ThreadOptions = {
  sandboxMode: 'workspace-write',
  networkAccessEnabled: true,
  approvalPolicy: 'on-failure',
  webSearchEnabled: true,
  modelReasoningEffort: 'medium',
  workingDirectory: '',
}

/** Image MIME types the adapter can forward to Codex as local_image input. */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const
