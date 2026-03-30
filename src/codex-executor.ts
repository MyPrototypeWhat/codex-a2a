import type { Message, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk'
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import type { Codex, Thread, ThreadOptions, TurnOptions } from '@openai/codex-sdk'
import { DEFAULT_THREAD_OPTIONS } from './config'

type ThreadLike = Pick<Thread, 'runStreamed'>

type CodexLike = {
  startThread: (options?: ThreadOptions) => ThreadLike
}

export interface CodexExecutorOptions {
  codex: CodexLike
  getThreadOptions?: (contextId: string) => Partial<ThreadOptions>
  getTurnOptions?: (contextId: string) => TurnOptions | undefined
  getWorkingDirectory?: (contextId: string) => string | undefined
  /** Maximum number of cached threads before eviction (default: 64) */
  maxThreads?: number
  logger?: Pick<Console, 'log' | 'error'>
}

export class CodexExecutor implements AgentExecutor {
  private threads = new Map<string, ThreadLike>()
  private threadWorkingDirs = new Map<string, string>()
  private threadLastUsed = new Map<string, number>()
  private abortControllers = new Map<string, AbortController>()
  private taskContexts = new Map<string, string>()
  private codex: CodexLike
  private maxThreads: number
  private getThreadOptions: (contextId: string) => Partial<ThreadOptions>
  private getTurnOptions?: (contextId: string) => TurnOptions | undefined
  private getWorkingDirectory?: (contextId: string) => string | undefined
  private logger: Pick<Console, 'log' | 'error'>

  constructor({ codex, getThreadOptions, getTurnOptions, getWorkingDirectory, maxThreads, logger }: CodexExecutorOptions) {
    this.codex = codex
    this.getThreadOptions = getThreadOptions ?? (() => ({}))
    this.getTurnOptions = getTurnOptions
    this.getWorkingDirectory = getWorkingDirectory
    this.maxThreads = maxThreads ?? 64
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

    const text = userMessage.parts
      .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
      .map((part) => part.text)
      .join('\n')

    if (!text) {
      this.publishFailure(eventBus, taskId, contextId, 'No text content')
      return
    }

    const abortController = new AbortController()
    this.abortControllers.set(taskId, abortController)

    try {
      let thread = this.threads.get(contextId)

      const threadOptions = this.resolveThreadOptions(contextId)
      const workingDirOverride = this.getWorkingDirectory?.(contextId)
      const workingDir = workingDirOverride || this.normalizeWorkingDirectory(threadOptions.workingDirectory)

      const currentWorkingDir = workingDir || process.cwd()
      const existingThreadKey = `${contextId}:${currentWorkingDir}`
      const cachedThreadKey = this.threadWorkingDirs.get(contextId)

      if (thread && cachedThreadKey !== existingThreadKey) {
        this.threads.delete(contextId)
        thread = undefined
      }

      if (!thread) {
        this.evictThreadsIfNeeded()

        const resolvedThreadOptions: ThreadOptions = {
          ...threadOptions,
          skipGitRepoCheck: threadOptions.skipGitRepoCheck ?? true,
          workingDirectory: workingDir || undefined,
        }

        thread = this.codex.startThread(resolvedThreadOptions)
        this.threads.set(contextId, thread)
        this.threadWorkingDirs.set(contextId, existingThreadKey)
        this.logger.log('[Codex A2A] Thread started with config:', {
          workingDirectory: workingDir || process.cwd(),
          webSearchEnabled: resolvedThreadOptions.webSearchEnabled,
          networkAccess: resolvedThreadOptions.networkAccessEnabled,
          sandboxMode: resolvedThreadOptions.sandboxMode,
        })
      }

      this.threadLastUsed.set(contextId, Date.now())

      const turnOptions = this.getTurnOptions?.(contextId)
      const mergedTurnOptions: TurnOptions = {
        ...turnOptions,
        signal: abortController.signal,
      }

      const { events } = await thread.runStreamed(text, mergedTurnOptions)
      const sentTextLengths = new Map<string, number>()
      const sentItemStates = new Map<string, string>()

      for await (const event of events) {
        if (abortController.signal.aborted) {
          this.publishCanceled(eventBus, taskId, contextId)
          return
        }
        this.logger.log('[Codex A2A] event', event)

        if (event.type === 'thread.started') {
          this.publishStatus(eventBus, taskId, contextId, 'working', false, undefined, 'thread-started')
          continue
        }
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
        if (event.type === 'error') {
          this.publishFailure(eventBus, taskId, contextId, event.message)
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
    } catch (error) {
      if (abortController.signal.aborted) {
        this.publishCanceled(eventBus, taskId, contextId)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('[Codex A2A] Execution error:', message)
      this.publishFailure(eventBus, taskId, contextId, message)
    } finally {
      this.abortControllers.delete(taskId)
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const controller = this.abortControllers.get(taskId)
    if (controller) {
      controller.abort()
    }
    const contextId = this.taskContexts.get(taskId)
    this.publishCanceled(eventBus, taskId, contextId)
    eventBus.finished()
  }

  /** Remove all cached threads. */
  clearThreads(): void {
    this.threads.clear()
    this.threadWorkingDirs.clear()
    this.threadLastUsed.clear()
  }

  private evictThreadsIfNeeded(): void {
    while (this.threads.size >= this.maxThreads) {
      let oldestKey: string | undefined
      let oldestTime = Infinity
      for (const [key, time] of this.threadLastUsed) {
        if (time < oldestTime) {
          oldestTime = time
          oldestKey = key
        }
      }
      if (!oldestKey) break
      this.threads.delete(oldestKey)
      this.threadWorkingDirs.delete(oldestKey)
      this.threadLastUsed.delete(oldestKey)
    }
  }

  private resolveThreadOptions(contextId: string): ThreadOptions {
    return { ...DEFAULT_THREAD_OPTIONS, ...this.getThreadOptions(contextId) }
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
    this.abortControllers.delete(taskId)
    this.taskContexts.delete(taskId)
  }
}
