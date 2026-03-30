import { describe, expect, it, afterEach } from 'vitest'
import { CodexA2AServer } from '../src/codex-a2a-server'
import http from 'node:http'

function createMockCodex() {
  return {
    startThread: () => ({
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: 'turn.started' as const }
          yield {
            type: 'item.completed' as const,
            item: { id: 'msg-1', type: 'agent_message' as const, text: 'Hello' },
          }
          yield {
            type: 'turn.completed' as const,
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          }
        })(),
      }),
    }),
  }
}

describe('CodexA2AServer', () => {
  let server: CodexA2AServer | null = null

  afterEach(async () => {
    if (server?.isRunning()) {
      await server.stop()
    }
    server = null
  })

  it('starts and stops correctly', async () => {
    server = new CodexA2AServer({
      codex: createMockCodex() as any,
      logger: { log: () => {}, error: () => {} },
    })

    expect(server.isRunning()).toBe(false)
    expect(server.getUrl()).toBeNull()

    await server.start()

    expect(server.isRunning()).toBe(true)
    expect(server.getUrl()).toMatch(/^http:\/\/localhost:\d+$/)

    await server.stop()

    expect(server.isRunning()).toBe(false)
    expect(server.getUrl()).toBeNull()
  })

  it('auto-increments port when occupied', async () => {
    // Occupy a port
    const blockingServer = http.createServer()
    const port = 50100
    await new Promise<void>((resolve) => {
      blockingServer.listen(port, () => resolve())
    })

    try {
      server = new CodexA2AServer({
        port,
        codex: createMockCodex() as any,
        logger: { log: () => {}, error: () => {} },
      })

      await server.start()

      const url = server.getUrl()!
      const assignedPort = parseInt(url.split(':').pop()!, 10)
      expect(assignedPort).toBeGreaterThan(port)
    } finally {
      await new Promise<void>((resolve) => blockingServer.close(() => resolve()))
    }
  })

  it('serves agent card at well-known path', async () => {
    server = new CodexA2AServer({
      codex: createMockCodex() as any,
      logger: { log: () => {}, error: () => {} },
    })

    await server.start()

    const url = server.getUrl()!
    const response = await fetch(`${url}/.well-known/agent-card.json`)

    expect(response.status).toBe(200)

    const card = await response.json()
    expect(card.name).toBe('Codex')
    expect(card.protocolVersion).toBe('0.3.0')
  })

  it('applies custom CORS origin', async () => {
    server = new CodexA2AServer({
      codex: createMockCodex() as any,
      cors: { origin: 'https://example.com' },
      logger: { log: () => {}, error: () => {} },
    })

    await server.start()

    const url = server.getUrl()!
    const response = await fetch(`${url}/.well-known/agent-card.json`)

    expect(response.headers.get('access-control-allow-origin')).toBe('https://example.com')
  })

  it('does not start twice', async () => {
    server = new CodexA2AServer({
      codex: createMockCodex() as any,
      logger: { log: () => {}, error: () => {} },
    })

    await server.start()
    const url1 = server.getUrl()

    await server.start() // Should be a no-op
    const url2 = server.getUrl()

    expect(url1).toBe(url2)
  })

  it('applies configureApp for custom routes', async () => {
    server = new CodexA2AServer({
      codex: createMockCodex() as any,
      logger: { log: () => {}, error: () => {} },
      configureApp: (app) => {
        app.get('/health', (_req, res) => {
          res.json({ ok: true })
        })
      },
    })

    await server.start()

    const url = server.getUrl()!
    const response = await fetch(`${url}/health`)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true })
  })
})
