import type { Message, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk'
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import type { Codex, Thread, ThreadOptions } from '@openai/codex-sdk'
import { DEFAULT_CODEX_CONFIG, type CodexConfig } from './config'

type ThreadLike = Pick<Thread, 'runStreamed'>

type CodexLike = {
  startThread: (options?: ThreadOptions) => ThreadLike
}

export interface CodexExecutorOptions {
  codex: CodexLike
  getConfig?: (contextId: string) => Partial<CodexConfig>
  getWorkingDirectory?: (contextId: string) => string | undefined
  logger?: Pick<Console, 'log' | 'error'>
}

export class CodexExecutor implements AgentExecutor {
  private threads = new Map<string, ThreadLike>()
  private threadWorkingDirs = new Map<string, string>()
  private canceledTasks = new Set<string>()
  private taskContexts = new Map<string, string>()
  private codex: CodexLike
  private getConfig: (contextId: string) => Partial<CodexConfig>
  private getWorkingDirectory?: (contextId: string) => string | undefined
  private logger: Pick<Console, 'log' | 'error'>

  constructor({ codex, getConfig, getWorkingDirectory, logger }: CodexExecutorOptions) {
    this.codex = codex
    this.getConfig = getConfig ?? (() => ({}))
    this.getWorkingDirectory = getWorkingDirectory
    this.logger = logger ?? console
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = requestContext
    const timestamp = new Date().toISOString()
    this.taskContexts.set(taskId, contextId)

    if (!task) {
      const initialTask: Task = {
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'submitted', timestamp },
        history: [userMessage],
      }
      eventBus.publish(initialTask)
    }

    this.publishStatus(eventBus, taskId, contextId, 'working', false, undefined, 'state-change')

    if (this.canceledTasks.has(taskId)) {
      this.publishCanceled(eventBus, taskId, contextId)
      return
    }

    const text = userMessage.parts
      .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
      .map((part) => part.text)
      .join('\n')

    if (!text) {
      this.publishFailure(eventBus, taskId, contextId, 'No text content')
      return
    }

    let thread = this.threads.get(contextId)

    const config = this.resolveConfig(contextId)
    const workingDirOverride = this.getWorkingDirectory?.(contextId)
    const workingDir = workingDirOverride || this.normalizeWorkingDirectory(config.workingDirectory)

    const currentWorkingDir = workingDir || process.cwd()
    const existingThreadKey = `${contextId}:${currentWorkingDir}`
    const cachedThreadKey = this.threadWorkingDirs.get(contextId)

    if (thread && cachedThreadKey !== existingThreadKey) {
      this.threads.delete(contextId)
      thread = undefined
    }

    if (!thread) {
      thread = this.codex.startThread({
        skipGitRepoCheck: true,
        webSearchEnabled: config.webSearchEnabled,
        networkAccessEnabled: config.networkAccess,
        webSearchMode: 'live',
        workingDirectory: workingDir || undefined,
        sandboxMode: config.sandboxMode,
        approvalPolicy: config.approvalPolicy === 'never' ? 'never' : config.approvalPolicy,
      })
      this.threads.set(contextId, thread)
      this.threadWorkingDirs.set(contextId, existingThreadKey)
      this.logger.log('[Codex A2A] Thread started with config:', {
        workingDirectory: workingDir || process.cwd(),
        webSearchEnabled: config.webSearchEnabled,
        networkAccess: config.networkAccess,
        sandboxMode: config.sandboxMode,
      })
    }

    const { events } = await thread.runStreamed(text)
    const sentTextLengths = new Map<string, number>()
    const sentItemStates = new Map<string, string>()

    for await (const event of events) {
      if (this.canceledTasks.has(taskId)) {
        this.publishCanceled(eventBus, taskId, contextId)
        return
      }
      this.logger.log('[Codex A2A] event', event)
      if (event.type === 'turn.started') {
        this.publishStatus(eventBus, taskId, contextId, 'working', false, undefined, 'turn-started')
        continue
      }
      if (event.type === 'turn.completed') {
        this.publishToolOutput(
          eventBus,
          taskId,
          contextId,
          'turn-usage',
          this.stringifyToolOutput({ usage: event.usage }),
          false,
          true
        )
        this.publishStatus(
          eventBus,
          taskId,
          contextId,
          'working',
          false,
          undefined,
          'turn-completed'
        )
        continue
      }
      if (event.type === 'turn.failed') {
        this.publishFailure(eventBus, taskId, contextId, event.error.message)
        return
      }
      if (
        event.type === 'item.started' ||
        event.type === 'item.updated' ||
        event.type === 'item.completed'
      ) {
        const item = event.item
        const isCompleted = event.type === 'item.completed'

        switch (item.type) {
          case 'agent_message':
          case 'reasoning': {
            if (item.text) {
              const prevLength = sentTextLengths.get(item.id) || 0
              const deltaText = item.text.slice(prevLength)
              if (deltaText.length > 0) {
                sentTextLengths.set(item.id, item.text.length)
                if (item.type === 'reasoning') {
                  this.publishThought(eventBus, taskId, contextId, deltaText)
                } else {
                  this.publishTextContent(eventBus, taskId, contextId, deltaText)
                }
              }
            }
            break
          }
          case 'command_execution': {
            const stateKey = `${item.id}:state`
            const outputKey = `${item.id}:output`
            const lastState = sentItemStates.get(stateKey)

            if (!lastState) {
              sentItemStates.set(stateKey, 'started')
              this.publishToolUpdate(eventBus, taskId, contextId, {
                request: { callId: item.id, name: 'command_execution' },
                status: item.status,
                command: item.command,
              })
            }

            if (item.aggregated_output) {
              const prevLength = sentTextLengths.get(outputKey) || 0
              const deltaOutput = item.aggregated_output.slice(prevLength)
              if (deltaOutput.length > 0) {
                sentTextLengths.set(outputKey, item.aggregated_output.length)
                this.publishToolOutput(
                  eventBus,
                  taskId,
                  contextId,
                  item.id,
                  deltaOutput,
                  true,
                  isCompleted
                )
              }
            }

            if (isCompleted && lastState !== 'completed') {
              sentItemStates.set(stateKey, 'completed')
              this.publishToolUpdate(eventBus, taskId, contextId, {
                request: { callId: item.id, name: 'command_execution' },
                status: item.status,
                command: item.command,
                exitCode: item.exit_code,
              })
            }
            break
          }
          case 'file_change': {
            if (isCompleted) {
              this.publishToolOutput(
                eventBus,
                taskId,
                contextId,
                item.id,
                this.stringifyToolOutput({ changes: item.changes }),
                false,
                true
              )
              this.publishToolUpdate(eventBus, taskId, contextId, {
                request: { callId: item.id, name: 'file_change' },
                status: item.status,
                changes: item.changes,
              })
            }
            break
          }
          case 'mcp_tool_call': {
            const stateKey = `${item.id}:state`
            const lastState = sentItemStates.get(stateKey)

            if (!lastState) {
              sentItemStates.set(stateKey, 'started')
              this.publishToolUpdate(eventBus, taskId, contextId, {
                request: { callId: item.id, name: 'mcp_tool_call' },
                status: item.status,
                server: item.server,
                tool: item.tool,
                arguments: item.arguments,
              })
            }

            if (isCompleted && lastState !== 'completed') {
              sentItemStates.set(stateKey, 'completed')
              if (item.error) {
                this.publishToolUpdate(eventBus, taskId, contextId, {
                  request: { callId: item.id, name: 'mcp_tool_call' },
                  status: 'failed',
                  error: item.error,
                })
              } else if (item.result) {
                this.publishToolOutput(
                  eventBus,
                  taskId,
                  contextId,
                  item.id,
                  this.stringifyToolOutput(item.result),
                  false,
                  true
                )
                this.publishToolUpdate(eventBus, taskId, contextId, {
                  request: { callId: item.id, name: 'mcp_tool_call' },
                  status: 'completed',
                  result: item.result,
                  output: item.result,
                })
              }
            }
            break
          }
          case 'web_search': {
            this.publishToolUpdate(eventBus, taskId, contextId, {
              request: { callId: item.id, name: 'web_search' },
              status: 'completed',
              query: item.query,
            })
            break
          }
          case 'todo_list': {
            this.publishToolOutput(
              eventBus,
              taskId,
              contextId,
              item.id,
              this.stringifyToolOutput({ items: item.items }),
              false,
              true
            )
            this.publishToolUpdate(eventBus, taskId, contextId, {
              request: { callId: item.id, name: 'todo_list' },
              status: 'updated',
              items: item.items,
            })
            break
          }
          case 'error': {
            this.publishTextContent(eventBus, taskId, contextId, `Error: ${item.message}`)
            break
          }
          default: {
            break
          }
        }
      }
    }

    this.publishStatus(eventBus, taskId, contextId, 'completed', true, undefined, 'state-change')
    eventBus.finished()
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.canceledTasks.add(taskId)
    const contextId = this.taskContexts.get(taskId)
    this.publishCanceled(eventBus, taskId, contextId)
    eventBus.finished()
  }

  private resolveConfig(contextId: string): CodexConfig {
    return { ...DEFAULT_CODEX_CONFIG, ...this.getConfig(contextId) }
  }

  private normalizeWorkingDirectory(workingDirectory?: string): string | undefined {
    if (!workingDirectory) return undefined
    const trimmed = workingDirectory.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }

  private publishStatus(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    state: TaskStatusUpdateEvent['status']['state'],
    final = false,
    message?: Message,
    codexAgentKind?: string
  ) {
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state,
        message,
        timestamp: new Date().toISOString(),
      },
      final,
      metadata: codexAgentKind ? { codexAgent: { kind: codexAgentKind } } : undefined,
    } satisfies TaskStatusUpdateEvent)
  }

  private publishTextContent(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    text: string
  ) {
    const message: Message = {
      kind: 'message',
      role: 'agent',
      messageId: crypto.randomUUID(),
      taskId,
      contextId,
      parts: [{ kind: 'text', text }],
    }
    this.publishStatus(eventBus, taskId, contextId, 'working', false, message, 'text-content')
  }

  private publishThought(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    text: string
  ) {
    const message: Message = {
      kind: 'message',
      role: 'agent',
      messageId: crypto.randomUUID(),
      taskId,
      contextId,
      parts: [{ kind: 'data', data: { text } }],
    }
    this.publishStatus(eventBus, taskId, contextId, 'working', false, message, 'thought')
  }

  private publishToolUpdate(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    data: Record<string, unknown>
  ) {
    const message: Message = {
      kind: 'message',
      role: 'agent',
      messageId: crypto.randomUUID(),
      taskId,
      contextId,
      parts: [{ kind: 'data', data }],
    }
    this.publishStatus(eventBus, taskId, contextId, 'working', false, message, 'tool-call-update')
  }

  private publishToolOutput(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    callId: string,
    output: string,
    append: boolean,
    lastChunk: boolean
  ) {
    eventBus.publish({
      kind: 'artifact-update',
      taskId,
      contextId,
      artifact: {
        artifactId: `tool-${callId}-output`,
        parts: [{ kind: 'text', text: output }],
      },
      append,
      lastChunk,
    })
  }

  private stringifyToolOutput(value: unknown): string {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  private publishFailure(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    errorMessage: string
  ) {
    const message: Message = {
      kind: 'message',
      role: 'agent',
      messageId: crypto.randomUUID(),
      taskId,
      contextId,
      parts: [{ kind: 'text', text: `Error: ${errorMessage}` }],
    }
    this.publishStatus(eventBus, taskId, contextId, 'failed', true, message, 'state-change')
    eventBus.finished()
  }

  private publishCanceled(eventBus: ExecutionEventBus, taskId: string, contextId?: string) {
    const message: Message = {
      kind: 'message',
      role: 'agent',
      messageId: crypto.randomUUID(),
      taskId,
      contextId: contextId ?? crypto.randomUUID(),
      parts: [{ kind: 'text', text: 'Task canceled.' }],
    }
    this.publishStatus(
      eventBus,
      taskId,
      message.contextId!,
      'canceled',
      true,
      message,
      'state-change'
    )
    this.canceledTasks.delete(taskId)
    this.taskContexts.delete(taskId)
  }
}
