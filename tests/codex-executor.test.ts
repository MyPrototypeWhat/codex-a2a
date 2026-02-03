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

    const executor = new CodexExecutor({ codex })
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

    const executor = new CodexExecutor({ codex })
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

    const executor = new CodexExecutor({ codex })
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
})
