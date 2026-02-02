export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'

export interface CodexConfig {
  model: string
  maxTokens: number
  autoApprove: boolean
  sandboxMode: CodexSandboxMode
  writableRoots: string[]
  networkAccess: boolean
  approvalPolicy: CodexApprovalPolicy
  webSearchEnabled: boolean
  reasoningEffort: CodexReasoningEffort
  workingDirectory?: string
}

export const DEFAULT_CODEX_CONFIG: CodexConfig = {
  model: 'gpt-5-codex',
  maxTokens: 4096,
  autoApprove: false,
  sandboxMode: 'workspace-write',
  writableRoots: [],
  networkAccess: true,
  approvalPolicy: 'on-failure',
  webSearchEnabled: true,
  reasoningEffort: 'medium',
  workingDirectory: '',
}
