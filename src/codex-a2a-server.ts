import { EventEmitter } from 'node:events'
import http from 'node:http'
import { AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk'
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from '@a2a-js/sdk/server/express'
import type { Codex } from '@openai/codex-sdk'
import express, { type Express } from 'express'
import { CodexExecutor } from './codex-executor'
import type { ThreadOptions, TurnOptions } from '@openai/codex-sdk'

export interface CorsOptions {
  origin?: string | string[]
  methods?: string[]
  headers?: string[]
}

export interface CodexA2AServerOptions {
  port?: number
  agentCard?: Partial<AgentCard>
  codex?: Codex
  codexFactory?: () => Codex | Promise<Codex>
  getThreadOptions?: (contextId: string) => Partial<ThreadOptions>
  getTurnOptions?: (contextId: string) => TurnOptions | undefined
  getWorkingDirectory?: (contextId: string) => string | undefined
  /** Maximum cached threads before LRU eviction (default: 64) */
  maxThreads?: number
  logger?: Pick<Console, 'log' | 'error'>
  /** CORS configuration. Defaults to allow all origins. */
  cors?: CorsOptions
  /** Timeout in ms for graceful shutdown (default: 5000) */
  shutdownTimeout?: number
  configureApp?: (
    app: Express,
    context: {
      agentCard: AgentCard
      requestHandler: DefaultRequestHandler
      executor: CodexExecutor
    }
  ) => void
}

const DEFAULT_PORT = 50002
const MAX_PORT_SCAN = 100

export class CodexA2AServer extends EventEmitter {
  private server: http.Server | null = null
  private serverUrl: string | null = null
  private requestHandler: DefaultRequestHandler | null = null
  private executor: CodexExecutor | null = null
  private running = false
  private options: CodexA2AServerOptions

  constructor(options: CodexA2AServerOptions = {}) {
    super()
    this.options = options
  }

  getUrl(): string | null {
    return this.serverUrl
  }

  isRunning(): boolean {
    return this.running
  }

  async start(): Promise<void> {
    if (this.running) return

    const logger = this.options.logger ?? console
    const codex = await this.resolveCodex(logger)
    const port = await this.findAvailablePort(this.options.port ?? DEFAULT_PORT)

    const app = express()
    this.applyCors(app)

    const agentCard = this.buildAgentCard(port, this.options.agentCard)
    const executor = new CodexExecutor({
      codex,
      getThreadOptions: this.options.getThreadOptions,
      getTurnOptions: this.options.getTurnOptions,
      getWorkingDirectory: this.options.getWorkingDirectory,
      maxThreads: this.options.maxThreads,
      logger,
    })
    this.executor = executor
    this.requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), executor)

    app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: this.requestHandler }))
    app.use(
      '/a2a/jsonrpc',
      jsonRpcHandler({
        requestHandler: this.requestHandler,
        userBuilder: UserBuilder.noAuthentication,
      })
    )
    app.use(
      '/a2a/rest',
      restHandler({
        requestHandler: this.requestHandler,
        userBuilder: UserBuilder.noAuthentication,
      })
    )

    this.options.configureApp?.(app, {
      agentCard,
      requestHandler: this.requestHandler,
      executor,
    })

    this.server = http.createServer(app)

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, () => {
        this.serverUrl = `http://localhost:${port}`
        this.running = true
        logger.log('[Codex A2A] Server started on', this.serverUrl)
        this.emit('status', { status: 'connected', serverUrl: this.serverUrl })
        resolve()
      })

      this.server!.on('error', (err) => {
        logger.error('[Codex A2A] Server error:', err)
        this.running = false
        this.emit('status', { status: 'error', error: err.message })
        reject(err)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return

    const timeout = this.options.shutdownTimeout ?? 5000

    // Stop accepting new connections
    this.server.close()

    // Wait for existing connections to finish with timeout
    await Promise.race([
      new Promise<void>((resolve) => {
        this.server!.on('close', () => resolve())
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          this.server!.closeAllConnections?.()
          resolve()
        }, timeout)
      }),
    ])

    // Clean up executor thread cache
    this.executor?.clearThreads()

    this.server = null
    this.serverUrl = null
    this.running = false
    this.requestHandler = null
    this.executor = null
    this.emit('status', { status: 'disconnected' })
  }

  async cancelTask(taskId: string): Promise<void> {
    if (!this.requestHandler) return
    await this.requestHandler.cancelTask({ id: taskId })
  }

  private applyCors(app: Express): void {
    const cors = this.options.cors
    const origin = cors?.origin ?? '*'
    const methods = cors?.methods ?? ['GET', 'POST', 'OPTIONS']
    const headers = cors?.headers ?? ['Content-Type', 'Accept']

    app.use((req, res, next) => {
      const originHeader = typeof origin === 'string'
        ? origin
        : (Array.isArray(origin) && origin.includes(req.headers.origin ?? '')
          ? req.headers.origin!
          : origin[0] ?? '*')

      res.setHeader('Access-Control-Allow-Origin', originHeader)
      res.setHeader('Access-Control-Allow-Methods', methods.join(', '))
      res.setHeader('Access-Control-Allow-Headers', headers.join(', '))
      if (req.method === 'OPTIONS') {
        res.status(204).end()
        return
      }
      next()
    })
  }

  private async resolveCodex(logger: Pick<Console, 'error'>): Promise<Codex> {
    if (this.options.codex) return this.options.codex
    if (this.options.codexFactory) return await this.options.codexFactory()
    try {
      const { Codex } = await import('@openai/codex-sdk')
      return new Codex({
        env: {
          ...process.env,
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('[Codex A2A] Failed to load @openai/codex-sdk:', message)
      throw new Error(
        'Failed to load @openai/codex-sdk. Make sure it is installed: npm install @openai/codex-sdk'
      )
    }
  }

  private buildAgentCard(port: number, overrides?: Partial<AgentCard>): AgentCard {
    const baseCard: AgentCard = {
      name: 'Codex',
      description: 'OpenAI coding agent powered by Codex SDK',
      protocolVersion: '0.3.0',
      version: '0.2.0',
      url: `http://localhost:${port}/a2a/jsonrpc`,
      provider: {
        organization: 'OpenAI',
        url: 'https://openai.com',
      },
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      supportsAuthenticatedExtendedCard: false,
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      additionalInterfaces: [
        { url: `http://localhost:${port}/a2a/jsonrpc`, transport: 'JSONRPC' },
        { url: `http://localhost:${port}/a2a/rest`, transport: 'HTTP+JSON' },
      ],
      skills: [
        {
          id: 'code_generation',
          name: 'Code Generation',
          description: 'Generate, modify, and explain code',
          tags: ['code', 'programming', 'refactor'],
          examples: ['Refactor this function to be more readable', 'Explain what this code does'],
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
        },
        {
          id: 'file_operations',
          name: 'File Operations',
          description: 'Create or modify files based on instructions',
          tags: ['files', 'edit', 'patch'],
          examples: [
            'Update the API client to add retries',
            'Create a new config file for the service',
          ],
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
        },
        {
          id: 'shell_commands',
          name: 'Shell Commands',
          description: 'Run shell commands and report outputs',
          tags: ['shell', 'cli', 'build'],
          examples: ['Run tests and summarize failures', 'Build the project and report errors'],
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
        },
        {
          id: 'web_search',
          name: 'Web Search',
          description: 'Search the web for relevant technical information',
          tags: ['search', 'web', 'docs'],
          examples: ['Find the latest guidance on a library', 'Look up an error message'],
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
        },
        {
          id: 'mcp_tooling',
          name: 'MCP Tool Calls',
          description: 'Invoke MCP tools for specialized tasks',
          tags: ['mcp', 'tools', 'integration'],
          examples: ['Use an MCP tool to query internal data', 'Call a custom tool to format code'],
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
        },
      ],
    }

    if (!overrides) return baseCard

    return {
      ...baseCard,
      ...overrides,
      provider: {
        organization: overrides.provider?.organization ?? baseCard.provider?.organization ?? '',
        url: overrides.provider?.url ?? baseCard.provider?.url ?? '',
      },
      capabilities: { ...baseCard.capabilities, ...overrides.capabilities },
      additionalInterfaces: overrides.additionalInterfaces ?? baseCard.additionalInterfaces,
      skills: overrides.skills ?? baseCard.skills,
      defaultInputModes: overrides.defaultInputModes ?? baseCard.defaultInputModes,
      defaultOutputModes: overrides.defaultOutputModes ?? baseCard.defaultOutputModes,
    }
  }

  private async findAvailablePort(startPort: number): Promise<number> {
    for (let port = startPort; port < startPort + MAX_PORT_SCAN; port++) {
      if (await this.isPortAvailable(port)) return port
    }
    throw new Error(`No available port found in range ${startPort}-${startPort + MAX_PORT_SCAN - 1}`)
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = http.createServer()
      server.listen(port, () => {
        server.close(() => resolve(true))
      })
      server.on('error', () => {
        resolve(false)
      })
    })
  }
}
