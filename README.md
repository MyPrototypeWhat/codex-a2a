# codex-a2a

[![CI](https://github.com/MyPrototypeWhat/codex-a2a/actions/workflows/ci.yml/badge.svg)](https://github.com/MyPrototypeWhat/codex-a2a/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/codex-a2a)](https://www.npmjs.com/package/codex-a2a)

Expose OpenAI Codex as an A2A server with a thin, configurable wrapper.

## Install

```bash
npm install codex-a2a
```

## Usage

```ts
import { CodexA2AServer } from 'codex-a2a'

const server = new CodexA2AServer({
  port: 50002,
  getThreadOptions: () => ({
    workingDirectory: process.cwd(),
    webSearchEnabled: true,
    networkAccessEnabled: true,
  }),
  getTurnOptions: () => ({
    outputSchema: undefined,
  }),
})

await server.start()
console.log('A2A server running at', server.getUrl())
```

## Features

- JSON-RPC and REST A2A endpoints
- Streaming updates for Codex events (messages, tools, file changes)
- Per-context configuration hooks
- Optional agent card overrides
- Configurable CORS policy
- Graceful shutdown with connection draining
- Thread cache with LRU eviction
- Task cancellation via AbortController

## Customizing the agent card

```ts
import { CodexA2AServer } from 'codex-a2a'

const server = new CodexA2AServer({
  agentCard: {
    name: 'Codex Local',
    provider: { organization: 'My Org', url: 'https://example.com' },
  },
})

await server.start()
```

## Adding custom routes

Use `configureApp` to attach your own Express routes while keeping the built-in A2A endpoints.

```ts
import { CodexA2AServer } from 'codex-a2a'

const server = new CodexA2AServer({
  configureApp: (app, { requestHandler }) => {
    app.get('/health', (_req, res) => {
      res.json({ ok: true })
    })

    app.get('/agent-card', async (_req, res) => {
      res.json(await requestHandler.getAgentCard())
    })
  },
})

await server.start()
```

## Configuration

`getThreadOptions(contextId)` lets you override Codex thread options per context. The default values are exported as `DEFAULT_THREAD_OPTIONS`.

```ts
import { CodexA2AServer, DEFAULT_THREAD_OPTIONS } from 'codex-a2a'

const server = new CodexA2AServer({
  getThreadOptions: () => ({
    ...DEFAULT_THREAD_OPTIONS,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    webSearchEnabled: false,
  }),
})
```

`getWorkingDirectory(contextId)` provides a per-context working directory override.

`getTurnOptions(contextId)` lets you override per-turn options for `runStreamed`, such as `outputSchema` or `signal`.

### CORS

By default, the server allows all origins. You can restrict it:

```ts
const server = new CodexA2AServer({
  cors: {
    origin: 'https://example.com',
    methods: ['GET', 'POST'],
    headers: ['Content-Type'],
  },
})
```

### Thread cache

Threads are cached per context. Set `maxThreads` to control the cache size (default 64). The least-recently-used thread is evicted when the limit is reached.

```ts
const server = new CodexA2AServer({
  maxThreads: 32,
})
```

### Graceful shutdown

`stop()` waits for active connections to drain before closing. Set `shutdownTimeout` to control the max wait time in milliseconds (default 5000).

```ts
await server.stop()
```

## API

```ts
new CodexA2AServer(options)
server.start()
server.stop()
server.getUrl()
server.isRunning()
server.cancelTask(taskId)
```

## Event mapping

When connected to the A2A server, the following Codex items are surfaced as A2A updates:

- `thread.started` -> `status-update`
- `agent_message` -> `status-update` (text message)
- `reasoning` -> `status-update` (thought payload)
- `command_execution` -> `status-update` + `artifact-update` (stdout/stderr)
- `mcp_tool_call` -> `status-update` + `artifact-update` (tool result)
- `file_change` -> `status-update` + `artifact-update` (changes list)
- `todo_list` -> `status-update` + `artifact-update` (todo items)
- `web_search` -> `status-update`
- `error` -> `status-update` (failure)

## Scripts

```bash
pnpm run build
pnpm run test
pnpm run typecheck
pnpm changeset       # create a changeset before submitting a PR
```

## License

[MIT](LICENSE)
