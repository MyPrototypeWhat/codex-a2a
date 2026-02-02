# codex-a2a

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
  getConfig: () => ({
    workingDirectory: process.cwd(),
    webSearchEnabled: true,
    networkAccess: true,
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
- Type-safe config helpers

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

`getConfig(contextId)` lets you override Codex runtime settings per context. The default values are exported as `DEFAULT_CODEX_CONFIG`.

```ts
import { CodexA2AServer, DEFAULT_CODEX_CONFIG } from 'codex-a2a'

const server = new CodexA2AServer({
  getConfig: () => ({
    ...DEFAULT_CODEX_CONFIG,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    webSearchEnabled: false,
  }),
})
```

`getWorkingDirectory(contextId)` provides a per-context working directory override.

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

- `agent_message` -> `status-update` (text message)
- `reasoning` -> `status-update` (thought payload)
- `command_execution` -> `status-update` + `artifact-update` (stdout/stderr)
- `mcp_tool_call` -> `status-update` + `artifact-update` (tool result)
- `file_change` -> `status-update` + `artifact-update` (changes list)
- `todo_list` -> `status-update` + `artifact-update` (todo items)
- `web_search` -> `status-update`

## Scripts

```bash
npm run build
npm run test
npm run typecheck
```
