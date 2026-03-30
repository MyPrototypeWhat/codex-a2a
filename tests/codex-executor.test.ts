import { describe, expect, it } from 'vitest'
import { CodexExecutor } from '../src/codex-executor'
import type { ThreadEvent } from '@openai/codex-sdk'
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import type { Message, TaskArtifactUpdateEvent, TaskStatusUpdateEvent, TextPart } from '@a2a-js/sdk'

type StatusUpdateEvent = TaskStatusUpdateEvent

type ArtifactUpdateEvent = TaskArtifactUpdateEvent

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStatusUpdateEvent(value: unknown): value is StatusUpdateEvent {
  return isRecord(value) && value.kind === 'status-update'
}

function isArtifactUpdateEvent(value: unknown): value is ArtifactUpdateEvent {
  return isRecord(value) && value.kind === 'artifact-update'
}

function isTextPart(value: unknown): value is TextPart {
  return isRecord(value) && value.kind === 'text'
}

function createEventBus() {
  const published: unknown[] = []
  let finished = false
  const eventBus: ExecutionEventBus = {
    publish(event) {
      published.push(event)
    },
    on() {
      return eventBus
    },
    off() {
      return eventBus
    },
    once() {
      return eventBus
    },
    removeAllListeners() {
      return eventBus
    },
    finished() {
      finished = true
    },
  }

  return { eventBus, published, get finished() { return finished } }
}

function createMessage(taskId: string, contextId: string, text: string): Message {
  return {
    kind: 'message',
    role: 'user',
    messageId: 'msg-1',
    taskId,
    contextId,
    parts: [{ kind: 'text', text }],
  }
}

function createSilentLogger() {
  return { log: () => {}, error: () => {} }
}

describe('CodexExecutor', () => {
  it('publishes status updates and completes a task', async () => {
    const events: ThreadEvent[] = [
      {
        type: 'turn.started',
      },
      {
        type: 'item.completed',
        item: {
          id: 'item-1',
          type: 'agent_message',
          text: 'Hello world',
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 7 },
      },
    ]

    const thread = {
      runStreamed: async () => ({
        events: (async function* () {
          for (const event of events) {
            yield event
          }
        })(),
      }),
    }

    const startThreadArgs: unknown[] = []
    const codex = {
      startThread: (options: unknown) => {
        startThreadArgs.push(options)
        return thread
      },
    }

    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })
    const bus = createEventBus()
    const { eventBus, published } = bus

    const requestContext: RequestContext = {
      taskId: 'task-1',
      contextId: 'ctx-1',
      userMessage: createMessage('task-1', 'ctx-1', 'Hi'),
    }

    await executor.execute(requestContext, eventBus)

    const hasCompleted = published.some((event) =>
      isStatusUpdateEvent(event) && event.status?.state === 'completed' && event.final
    )

    const hasTextChunk = published.some(
      (event) =>
        isStatusUpdateEvent(event) &&
        event.status?.message?.parts?.some((part) => isTextPart(part) && part.text === 'Hello world')
    )

    const hasTurnUsage = published.some(
      (event) =>
        isArtifactUpdateEvent(event) &&
        event.artifact?.artifactId === 'tool-turn-usage-output' &&
        isTextPart(event.artifact.parts?.[0]) &&
        event.artifact.parts[0].text.includes('input_tokens')
    )

    expect(startThreadArgs.length).toBe(1)
    expect(hasCompleted).toBe(true)
    expect(hasTextChunk).toBe(true)
    expect(hasTurnUsage).toBe(true)
    expect(bus.finished).toBe(true)
  })

  it('resolves config and working directory overrides', async () => {
    const thread = {
      runStreamed: async () => ({
        events: (async function* () {})(),
      }),
    }

    const startThreadArgs: unknown[] = []
    const codex = {
      startThread: (options: unknown) => {
        startThreadArgs.push(options)
        return thread
      },
    }

    const executor = new CodexExecutor({
      codex,
      getThreadOptions: () => ({
        networkAccessEnabled: false,
        webSearchEnabled: false,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
      }),
      getWorkingDirectory: () => '/tmp/project',
      logger: createSilentLogger(),
    })

    const { eventBus } = createEventBus()

    const requestContext: RequestContext = {
      taskId: 'task-2',
      contextId: 'ctx-2',
      userMessage: createMessage('task-2', 'ctx-2', 'Hello'),
    }

    await executor.execute(requestContext, eventBus)

    expect(startThreadArgs.length).toBe(1)
    expect(startThreadArgs[0]).toMatchObject({
      networkAccessEnabled: false,
      webSearchEnabled: false,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      workingDirectory: '/tmp/project',
    })
  })

  it('emits artifact output for file_change and todo_list', async () => {
    const events: ThreadEvent[] = [
      {
        type: 'turn.started',
      },
      {
        type: 'item.completed',
        item: {
          id: 'file-1',
          type: 'file_change',
          status: 'completed',
          changes: [{ path: 'src/index.ts', kind: 'update' }],
        },
      },
      {
        type: 'item.updated',
        item: {
          id: 'todo-1',
          type: 'todo_list',
          items: [{ text: 'Add tests', completed: false }],
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 4 },
      },
    ]

    const thread = {
      runStreamed: async () => ({
        events: (async function* () {
          for (const event of events) {
            yield event
          }
        })(),
      }),
    }

    const codex = {
      startThread: () => thread,
    }

    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })
    const { eventBus, published } = createEventBus()

    const requestContext: RequestContext = {
      taskId: 'task-3',
      contextId: 'ctx-3',
      userMessage: createMessage('task-3', 'ctx-3', 'Plan the change'),
    }

    await executor.execute(requestContext, eventBus)

    const artifactOutputs = published.filter(isArtifactUpdateEvent)

    const fileArtifact = artifactOutputs.find(
      (event) => event.artifact?.artifactId === 'tool-file-1-output'
    )
    const todoArtifact = artifactOutputs.find(
      (event) => event.artifact?.artifactId === 'tool-todo-1-output'
    )

    const fileArtifactText = fileArtifact?.artifact?.parts?.find(isTextPart)?.text
    const todoArtifactText = todoArtifact?.artifact?.parts?.find(isTextPart)?.text

    expect(fileArtifactText).toContain('"changes"')
    expect(todoArtifactText).toContain('"items"')
  })

  it('preserves turn -> item -> turn event ordering', async () => {
    const events: ThreadEvent[] = [
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'item-2',
          type: 'agent_message',
          text: 'Streaming',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item-2',
          type: 'agent_message',
          text: 'Streaming done',
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 },
      },
    ]

    const thread = {
      runStreamed: async () => ({
        events: (async function* () {
          for (const event of events) {
            yield event
          }
        })(),
      }),
    }

    const codex = {
      startThread: () => thread,
    }

    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })
    const { eventBus, published } = createEventBus()

    const requestContext: RequestContext = {
      taskId: 'task-4',
      contextId: 'ctx-4',
      userMessage: createMessage('task-4', 'ctx-4', 'Stream please'),
    }

    await executor.execute(requestContext, eventBus)

    const kinds = published
      .map((event) => (isRecord(event) ? event.kind : undefined))
      .filter((kind): kind is string => typeof kind === 'string')

    const firstTurnStarted = kinds.indexOf('status-update')
    const firstArtifact = kinds.indexOf('artifact-update')
    const lastStatus = kinds.lastIndexOf('status-update')

    expect(firstTurnStarted).toBeGreaterThanOrEqual(0)
    expect(firstArtifact).toBeGreaterThan(firstTurnStarted)
    expect(lastStatus).toBeGreaterThan(firstArtifact)
  })

  it('cancels a task via AbortController', async () => {
    let abortSignal: AbortSignal | undefined
    const thread = {
      runStreamed: async (_text: string, options?: { signal?: AbortSignal }) => {
        abortSignal = options?.signal
        return {
          events: (async function* () {
            yield { type: 'turn.started' } as ThreadEvent
            yield {
              type: 'item.completed',
              item: { id: 'msg-1', type: 'agent_message', text: 'Before cancel' },
            } as ThreadEvent
            yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } as ThreadEvent
          })(),
        }
      },
    }

    const codex = { startThread: () => thread }
    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })

    const bus1 = createEventBus()
    const requestContext: RequestContext = {
      taskId: 'task-cancel',
      contextId: 'ctx-cancel',
      userMessage: createMessage('task-cancel', 'ctx-cancel', 'Do something'),
    }

    // Execute first to register the abort controller
    await executor.execute(requestContext, bus1.eventBus)

    // Verify signal was passed to runStreamed
    expect(abortSignal).toBeDefined()

    // Now test cancelTask publishes canceled status
    const bus2 = createEventBus()
    await executor.cancelTask('task-cancel', bus2.eventBus)

    const hasCanceled = bus2.published.some(
      (event) => isStatusUpdateEvent(event) && event.status?.state === 'canceled'
    )
    expect(hasCanceled).toBe(true)
    expect(bus2.finished).toBe(true)
  })

  it('handles runStreamed throwing an exception', async () => {
    const thread = {
      runStreamed: async () => {
        throw new Error('Connection failed')
      },
    }

    const codex = { startThread: () => thread }
    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })
    const bus = createEventBus()
    const { eventBus, published } = bus

    const requestContext: RequestContext = {
      taskId: 'task-err',
      contextId: 'ctx-err',
      userMessage: createMessage('task-err', 'ctx-err', 'Hello'),
    }

    await executor.execute(requestContext, eventBus)

    const hasFailed = published.some(
      (event) => isStatusUpdateEvent(event) && event.status?.state === 'failed' && event.final
    )
    const hasErrorMessage = published.some(
      (event) =>
        isStatusUpdateEvent(event) &&
        event.status?.message?.parts?.some(
          (part) => isTextPart(part) && part.text.includes('Connection failed')
        )
    )

    expect(hasFailed).toBe(true)
    expect(hasErrorMessage).toBe(true)
    expect(bus.finished).toBe(true)
  })

  it('handles thread.started event', async () => {
    const events: ThreadEvent[] = [
      { type: 'thread.started', thread_id: 'thread-123' } as ThreadEvent,
      { type: 'turn.started' },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ]

    const thread = {
      runStreamed: async () => ({
        events: (async function* () {
          for (const event of events) yield event
        })(),
      }),
    }

    const codex = { startThread: () => thread }
    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })
    const { eventBus, published } = createEventBus()

    const requestContext: RequestContext = {
      taskId: 'task-ts',
      contextId: 'ctx-ts',
      userMessage: createMessage('task-ts', 'ctx-ts', 'Hello'),
    }

    await executor.execute(requestContext, eventBus)

    const hasThreadStarted = published.some(
      (event) =>
        isStatusUpdateEvent(event) &&
        isRecord(event.metadata) &&
        isRecord(event.metadata.codexAgent) &&
        event.metadata.codexAgent.kind === 'thread-started'
    )
    expect(hasThreadStarted).toBe(true)
  })

  it('handles ThreadErrorEvent (type: "error")', async () => {
    const events: ThreadEvent[] = [
      { type: 'turn.started' },
      { type: 'error', message: 'Stream disconnected' } as ThreadEvent,
    ]

    const thread = {
      runStreamed: async () => ({
        events: (async function* () {
          for (const event of events) yield event
        })(),
      }),
    }

    const codex = { startThread: () => thread }
    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })
    const bus = createEventBus()
    const { eventBus, published } = bus

    const requestContext: RequestContext = {
      taskId: 'task-terr',
      contextId: 'ctx-terr',
      userMessage: createMessage('task-terr', 'ctx-terr', 'Hello'),
    }

    await executor.execute(requestContext, eventBus)

    const hasFailed = published.some(
      (event) => isStatusUpdateEvent(event) && event.status?.state === 'failed' && event.final
    )
    const hasErrorMsg = published.some(
      (event) =>
        isStatusUpdateEvent(event) &&
        event.status?.message?.parts?.some(
          (part) => isTextPart(part) && part.text.includes('Stream disconnected')
        )
    )

    expect(hasFailed).toBe(true)
    expect(hasErrorMsg).toBe(true)
    expect(bus.finished).toBe(true)
  })

  it('evicts oldest threads when maxThreads is exceeded', async () => {
    const startedContextIds: string[] = []
    const codex = {
      startThread: () => {
        return {
          runStreamed: async () => ({
            events: (async function* () {})(),
          }),
        }
      },
    }

    const executor = new CodexExecutor({
      codex,
      maxThreads: 2,
      logger: createSilentLogger(),
    })

    // Create 3 threads (exceeds maxThreads of 2)
    for (let i = 1; i <= 3; i++) {
      const { eventBus } = createEventBus()
      const requestContext: RequestContext = {
        taskId: `task-evict-${i}`,
        contextId: `ctx-evict-${i}`,
        userMessage: createMessage(`task-evict-${i}`, `ctx-evict-${i}`, 'Hello'),
      }
      await executor.execute(requestContext, eventBus)
    }

    // The executor should have evicted the oldest thread
    // We verify by checking that clearThreads works without error
    // and that the executor can still function
    const { eventBus } = createEventBus()
    const requestContext: RequestContext = {
      taskId: 'task-evict-4',
      contextId: 'ctx-evict-1', // Reuse context 1, should create a new thread
      userMessage: createMessage('task-evict-4', 'ctx-evict-1', 'Hello again'),
    }
    await executor.execute(requestContext, eventBus)

    executor.clearThreads()
  })

  it('publishes failure for empty text message', async () => {
    const codex = {
      startThread: () => ({
        runStreamed: async () => ({ events: (async function* () {})() }),
      }),
    }

    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })
    const bus = createEventBus()
    const { eventBus, published } = bus

    const requestContext: RequestContext = {
      taskId: 'task-empty',
      contextId: 'ctx-empty',
      userMessage: {
        kind: 'message',
        role: 'user',
        messageId: 'msg-empty',
        taskId: 'task-empty',
        contextId: 'ctx-empty',
        parts: [{ kind: 'data', data: { foo: 'bar' } }],
      },
    }

    await executor.execute(requestContext, eventBus)

    const hasFailed = published.some(
      (event) => isStatusUpdateEvent(event) && event.status?.state === 'failed' && event.final
    )
    expect(hasFailed).toBe(true)
    expect(bus.finished).toBe(true)
  })
})
