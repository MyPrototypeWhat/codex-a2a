# Codex SDK Features (Thread Resume + Image Input) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface two existing-but-unused Codex SDK capabilities through the A2A adapter — thread resume (`resumeThread` + `thread_id` round-trip) and image/multimodal input (`local_image`).

**Architecture:** A new pure helper `src/codex-input.ts` converts A2A message parts (text + image files) into a Codex `Input`, writing inline bytes to temp files and scoping local image paths to the working directory. `src/codex-executor.ts` captures/exposes `thread_id`, resumes threads (in-memory map + client-supplied metadata), and feeds the built input into `runStreamed`. The agent card declares image input modes via a shared constant in `src/config.ts`.

**Tech Stack:** TypeScript, `@openai/codex-sdk@^0.142.1`, `@a2a-js/sdk@^0.3.13`, Vitest, Node built-ins (`fs/promises`, `os`, `path`, `url`, `crypto`).

**Spec:** [docs/superpowers/specs/2026-06-25-codex-sdk-features-design.md](../specs/2026-06-25-codex-sdk-features-design.md)

---

## File Structure

- `src/config.ts` (modify) — export `SUPPORTED_IMAGE_MIME_TYPES` (single source of truth for image MIME types).
- `src/codex-input.ts` (create) — `buildCodexInput(message, options)`: text+image → `Input`, temp files, path scoping, cleanup.
- `src/codex-a2a-server.ts` (modify) — `buildAgentCard` declares image input modes.
- `src/codex-executor.ts` (modify) — `CodexLike.resumeThread`, `contextThreadIds`, `readInboundThreadId`, resume-aware thread selection, `publishThreadStarted`, input via `buildCodexInput`, temp-file cleanup.
- `tests/codex-input.test.ts` (create), `tests/codex-executor.test.ts` (modify), `tests/codex-a2a-server.test.ts` (modify).
- `README.md` (modify), `.changeset/codex-sdk-features.md` (create).

Dependencies between tasks: Task 1 (config constant) is used by Tasks 2 and 1's own agent-card change. Task 2 (codex-input) is consumed by Task 3. Task 3 (image wiring) and Task 4 (resume) both edit `execute()` in non-overlapping regions — do Task 3 first.

---

## Task 1: Image MIME constant + agent card declares image input

**Files:**
- Modify: `src/config.ts`
- Modify: `src/codex-a2a-server.ts` (import + `defaultInputModes`)
- Test: `tests/codex-a2a-server.test.ts`

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the `describe('CodexA2AServer', ...)` in `tests/codex-a2a-server.test.ts` (after the existing "serves agent card" test):

```ts
  it('declares image input modes in the agent card', async () => {
    server = new CodexA2AServer({
      codex: createMockCodex() as any,
      logger: { log: () => {}, error: () => {} },
    })

    await server.start()

    const url = server.getUrl()!
    const response = await fetch(`${url}/.well-known/agent-card.json`)
    const card = await response.json()

    expect(card.defaultInputModes).toContain('text/plain')
    expect(card.defaultInputModes).toContain('image/png')
    expect(card.defaultInputModes).toContain('image/jpeg')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/codex-a2a-server.test.ts -t "declares image input modes"`
Expected: FAIL — `defaultInputModes` is `['text/plain']`, does not contain `image/png`.

- [ ] **Step 3: Add the constant to `src/config.ts`**

Append to `src/config.ts` (after the existing `DEFAULT_THREAD_OPTIONS` export):

```ts
/** Image MIME types the adapter can forward to Codex as local_image input. */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const
```

- [ ] **Step 4: Use it in the agent card**

In `src/codex-a2a-server.ts`, add the import near the other local imports (it currently imports `./codex-executor` but not `./config`):

```ts
import { SUPPORTED_IMAGE_MIME_TYPES } from './config'
```

Then in `buildAgentCard`, change the `defaultInputModes` line:

```ts
      defaultInputModes: ['text/plain'],
```
to:
```ts
      defaultInputModes: ['text/plain', ...SUPPORTED_IMAGE_MIME_TYPES],
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run tests/codex-a2a-server.test.ts`
Expected: PASS (all server tests, including the new one).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/codex-a2a-server.ts tests/codex-a2a-server.test.ts
git commit -m "feat: declare image input modes in agent card"
```

---

## Task 2: `buildCodexInput` helper (text + image → Codex Input)

**Files:**
- Create: `src/codex-input.ts`
- Test: `tests/codex-input.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/codex-input.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildCodexInput } from '../src/codex-input'
import type { Message } from '@a2a-js/sdk'

function msg(parts: Message['parts']): Message {
  return { kind: 'message', role: 'user', messageId: 'm', parts }
}

const silent = { log: () => {}, error: () => {} }
// Minimal PNG signature bytes, base64-encoded — content is irrelevant to the helper.
const PNG_B64 = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')

type ImgPart = { type: string; text?: string; path?: string }

describe('buildCodexInput', () => {
  it('returns a plain string for text-only messages', async () => {
    const r = await buildCodexInput(msg([{ kind: 'text', text: 'hello' }]), {
      workingDirectory: process.cwd(),
      logger: silent,
    })
    expect(typeof r.input).toBe('string')
    expect(r.input).toBe('hello')
    expect(r.hasContent).toBe(true)
    await r.cleanup()
  })

  it('reports no content for messages without text or images', async () => {
    const r = await buildCodexInput(msg([{ kind: 'data', data: { a: 1 } }]), {
      workingDirectory: process.cwd(),
      logger: silent,
    })
    expect(r.hasContent).toBe(false)
  })

  it('writes inline image bytes to a temp file and returns UserInput[]', async () => {
    const r = await buildCodexInput(
      msg([
        { kind: 'text', text: 'look' },
        { kind: 'file', file: { bytes: PNG_B64, mimeType: 'image/png', name: 'a.png' } },
      ]),
      { workingDirectory: process.cwd(), logger: silent },
    )
    expect(Array.isArray(r.input)).toBe(true)
    const arr = r.input as ImgPart[]
    expect(arr[0]).toEqual({ type: 'text', text: 'look' })
    const img = arr.find((i) => i.type === 'local_image')!
    expect(img.path).toBeDefined()
    expect(existsSync(img.path!)).toBe(true)
    await r.cleanup()
    expect(existsSync(img.path!)).toBe(false)
  })

  it('allows image-only messages (no text)', async () => {
    const r = await buildCodexInput(
      msg([{ kind: 'file', file: { bytes: PNG_B64, mimeType: 'image/png' } }]),
      { workingDirectory: process.cwd(), logger: silent },
    )
    expect(Array.isArray(r.input)).toBe(true)
    expect((r.input as unknown[]).length).toBe(1)
    expect(r.hasContent).toBe(true)
    await r.cleanup()
  })

  it('passes through a file:// image inside the working directory without copying', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-a2a-in-'))
    const imgPath = join(dir, 'pic.png')
    writeFileSync(imgPath, Buffer.from(PNG_B64, 'base64'))
    const r = await buildCodexInput(
      msg([{ kind: 'file', file: { uri: pathToFileURL(imgPath).href, mimeType: 'image/png' } }]),
      { workingDirectory: dir, logger: silent },
    )
    const arr = r.input as ImgPart[]
    expect(arr[0].path).toBe(imgPath)
    await r.cleanup()
    expect(existsSync(imgPath)).toBe(true) // not deleted — we did not create it
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips local image paths outside the working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-a2a-in-'))
    const outside = mkdtempSync(join(tmpdir(), 'codex-a2a-out-'))
    const imgPath = join(outside, 'pic.png')
    writeFileSync(imgPath, Buffer.from(PNG_B64, 'base64'))
    const r = await buildCodexInput(
      msg([
        { kind: 'text', text: 'hi' },
        { kind: 'file', file: { uri: pathToFileURL(imgPath).href, mimeType: 'image/png' } },
      ]),
      { workingDirectory: dir, logger: silent },
    )
    expect(typeof r.input).toBe('string') // no image accepted → falls back to string
    expect(r.input).toBe('hi')
    await r.cleanup()
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('skips non-image file parts', async () => {
    const r = await buildCodexInput(
      msg([{ kind: 'file', file: { bytes: 'AAAA', mimeType: 'application/pdf', name: 'a.pdf' } }]),
      { workingDirectory: process.cwd(), logger: silent },
    )
    expect(r.hasContent).toBe(false)
  })

  it('skips remote http(s) image URIs', async () => {
    const r = await buildCodexInput(
      msg([
        { kind: 'text', text: 'hi' },
        { kind: 'file', file: { uri: 'https://example.com/a.png', mimeType: 'image/png' } },
      ]),
      { workingDirectory: process.cwd(), logger: silent },
    )
    expect(typeof r.input).toBe('string')
    expect(r.input).toBe('hi')
    await r.cleanup()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/codex-input.test.ts`
Expected: FAIL — cannot resolve `../src/codex-input`.

- [ ] **Step 3: Implement `src/codex-input.ts`**

Create `src/codex-input.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Message } from '@a2a-js/sdk'
import type { Input, UserInput } from '@openai/codex-sdk'

export interface BuildInputOptions {
  /** Resolved working directory for this turn; local image paths must live inside it. */
  workingDirectory: string
  /** Extra directories that are also allowed to contain local images. */
  additionalDirectories?: string[]
  logger?: Pick<Console, 'log' | 'error'>
}

export interface BuiltInput {
  /** Plain string when there are no images (backward compatible); UserInput[] otherwise. */
  input: Input
  /** True when the message contributed any text or image. */
  hasContent: boolean
  /** Removes any temp files created for inline image bytes. Safe to call once. */
  cleanup: () => Promise<void>
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

function extensionOf(name?: string): string | undefined {
  if (!name) return undefined
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot >= 0 ? lower.slice(dot) : undefined
}

function isImage(mimeType?: string, name?: string): boolean {
  if (typeof mimeType === 'string') return mimeType.startsWith('image/')
  const ext = extensionOf(name)
  return ext ? IMAGE_EXTENSIONS.has(ext) : false
}

function isWithin(child: string, parent: string): boolean {
  const c = resolve(child)
  const p = resolve(parent)
  if (c === p) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

export async function buildCodexInput(
  message: Message,
  options: BuildInputOptions,
): Promise<BuiltInput> {
  const { workingDirectory, additionalDirectories = [], logger } = options
  const allowedDirs = [workingDirectory, ...additionalDirectories].filter(Boolean)

  const textParts: string[] = []
  const images: UserInput[] = []
  const tempPaths: string[] = []

  for (const part of message.parts) {
    if (part.kind === 'text') {
      if (part.text) textParts.push(part.text)
      continue
    }
    if (part.kind !== 'file') continue

    const file = part.file
    const mimeType = file.mimeType
    const name = file.name ?? ('uri' in file ? file.uri : undefined)
    if (!isImage(mimeType, name)) {
      logger?.log('[Codex A2A] Skipping non-image file part', { mimeType, name })
      continue
    }

    if ('bytes' in file) {
      try {
        const ext = (mimeType && MIME_TO_EXT[mimeType]) || extensionOf(name) || '.png'
        const path = join(tmpdir(), `codex-a2a-${randomUUID()}${ext}`)
        await writeFile(path, Buffer.from(file.bytes, 'base64'))
        tempPaths.push(path)
        images.push({ type: 'local_image', path })
      } catch (error) {
        logger?.error('[Codex A2A] Failed to write image temp file', error)
      }
      continue
    }

    // FileWithUri
    const uri = file.uri
    let localPath: string | undefined
    if (uri.startsWith('file://')) {
      localPath = fileURLToPath(uri)
    } else if (uri.startsWith('/')) {
      localPath = uri
    } else {
      logger?.log('[Codex A2A] Skipping non-local image URI', { uri })
      continue
    }

    if (!allowedDirs.some((dir) => isWithin(localPath!, dir))) {
      logger?.error('[Codex A2A] Skipping image path outside working directory', { path: localPath })
      continue
    }
    images.push({ type: 'local_image', path: localPath })
  }

  const text = textParts.join('\n')
  const hasContent = text.length > 0 || images.length > 0

  let input: Input
  if (images.length === 0) {
    input = text
  } else {
    input = [
      ...(text.length > 0 ? [{ type: 'text', text } as UserInput] : []),
      ...images,
    ]
  }

  const cleanup = async () => {
    await Promise.all(tempPaths.map((path) => unlink(path).catch(() => {})))
  }

  return { input, hasContent, cleanup }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/codex-input.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/codex-input.ts tests/codex-input.test.ts
git commit -m "feat: add buildCodexInput for text + image message parts"
```

---

## Task 3: Wire image input into the executor

**Files:**
- Modify: `src/codex-executor.ts` (`execute()`)
- Test: `tests/codex-executor.test.ts`

- [ ] **Step 1: Write the failing test**

Add `vi` to the vitest import at the top of `tests/codex-executor.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
```

Add this helper right after the existing `createSilentLogger` function:

```ts
function reqCtx(taskId: string, contextId: string, text: string): RequestContext {
  return { taskId, contextId, userMessage: createMessage(taskId, contextId, text) }
}
```

Add this test inside the `describe('CodexExecutor', ...)` block:

```ts
  it('passes image input to runStreamed as a UserInput array', async () => {
    let captured: unknown
    const codex = {
      startThread: () => ({
        runStreamed: async (input: unknown) => {
          captured = input
          return { events: (async function* () {})() }
        },
      }),
    }
    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    const message: Message = {
      kind: 'message',
      role: 'user',
      messageId: 'm',
      taskId: 'task-img',
      contextId: 'ctx-img',
      parts: [
        { kind: 'text', text: 'describe' },
        { kind: 'file', file: { bytes: png, mimeType: 'image/png', name: 'x.png' } },
      ],
    }
    const { eventBus } = createEventBus()

    await executor.execute(
      { taskId: 'task-img', contextId: 'ctx-img', userMessage: message },
      eventBus,
    )

    expect(Array.isArray(captured)).toBe(true)
    expect((captured as Array<{ type: string }>).some((i) => i.type === 'local_image')).toBe(true)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/codex-executor.test.ts -t "passes image input"`
Expected: FAIL — current executor only forwards joined text (a string), so `captured` is a string, not an array.

- [ ] **Step 3: Add the import**

At the top of `src/codex-executor.ts`, add after the existing `import { DEFAULT_THREAD_OPTIONS } from './config'` line:

```ts
import { buildCodexInput } from './codex-input'
```

- [ ] **Step 4: Replace the text-extraction + working-dir setup block**

In `execute()`, find this block (it spans the text extraction, the empty-text guard, the AbortController creation, and the first lines inside `try`):

```ts
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
```

Replace it with:

```ts
    const threadOptions = this.resolveThreadOptions(contextId)
    const workingDirOverride = this.getWorkingDirectory?.(contextId)
    const workingDir = workingDirOverride || this.normalizeWorkingDirectory(threadOptions.workingDirectory)
    const currentWorkingDir = workingDir || process.cwd()

    const { input, hasContent, cleanup } = await buildCodexInput(userMessage, {
      workingDirectory: currentWorkingDir,
      additionalDirectories: threadOptions.additionalDirectories,
      logger: this.logger,
    })

    if (!hasContent) {
      await cleanup()
      this.publishFailure(eventBus, taskId, contextId, 'No text or image content')
      return
    }

    const abortController = new AbortController()
    this.abortControllers.set(taskId, abortController)

    try {
      let thread = this.threads.get(contextId)

      const existingThreadKey = `${contextId}:${currentWorkingDir}`
      const cachedThreadKey = this.threadWorkingDirs.get(contextId)
```

- [ ] **Step 5: Forward the built input to `runStreamed`**

Find:

```ts
      const { events } = await thread.runStreamed(text, mergedTurnOptions)
```

Replace with:

```ts
      const { events } = await thread.runStreamed(input, mergedTurnOptions)
```

- [ ] **Step 6: Clean up temp files in `finally`**

Find the `finally` block at the end of `execute()`:

```ts
    } finally {
      this.abortControllers.delete(taskId)
    }
```

Replace with:

```ts
    } finally {
      this.abortControllers.delete(taskId)
      await cleanup()
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/codex-executor.test.ts`
Expected: PASS — the new image test passes and all pre-existing executor tests stay green (text-only messages still produce a string input; the empty-`data`-part test now hits the `No text or image content` failure path).

- [ ] **Step 8: Typecheck**

Run: `pnpm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/codex-executor.ts tests/codex-executor.test.ts
git commit -m "feat: forward image message parts to Codex via local_image input"
```

---

## Task 4: Thread resume + `thread_id` surfacing

**Files:**
- Modify: `src/codex-executor.ts` (`CodexLike` type, new field, thread selection, `thread.started` handler, new methods)
- Test: `tests/codex-executor.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests inside `describe('CodexExecutor', ...)` in `tests/codex-executor.test.ts`:

```ts
  it('surfaces thread_id in status metadata', async () => {
    const events: ThreadEvent[] = [
      { type: 'thread.started', thread_id: 't1' } as ThreadEvent,
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ]
    const codex = {
      startThread: () => ({
        runStreamed: async () => ({
          events: (async function* () {
            for (const e of events) yield e
          })(),
        }),
      }),
    }
    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })
    const { eventBus, published } = createEventBus()

    await executor.execute(reqCtx('task-tid', 'ctx-tid', 'hi'), eventBus)

    const surfaced = published.some(
      (e) =>
        isStatusUpdateEvent(e) &&
        isRecord(e.metadata) &&
        isRecord(e.metadata.codexAgent) &&
        e.metadata.codexAgent.threadId === 't1',
    )
    expect(surfaced).toBe(true)
  })

  it('resumes a thread after the live cache is cleared', async () => {
    const startThread = vi.fn(() => ({
      runStreamed: async () => ({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 't1' } as ThreadEvent
          yield {
            type: 'turn.completed',
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          } as ThreadEvent
        })(),
      }),
    }))
    const resumeThread = vi.fn(() => ({
      runStreamed: async () => ({ events: (async function* () {})() }),
    }))
    const codex = { startThread, resumeThread }
    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })

    await executor.execute(reqCtx('task-r1', 'ctx-r', 'first'), createEventBus().eventBus)
    expect(startThread).toHaveBeenCalledTimes(1)

    executor.clearThreads() // drops the live thread but keeps the thread-id map

    await executor.execute(reqCtx('task-r2', 'ctx-r', 'second'), createEventBus().eventBus)
    expect(resumeThread).toHaveBeenCalledTimes(1)
    expect(resumeThread).toHaveBeenCalledWith('t1', expect.anything())
  })

  it('resumes a thread from inbound metadata.codexAgent.threadId', async () => {
    const startThread = vi.fn(() => ({ runStreamed: async () => ({ events: (async function* () {})() }) }))
    const resumeThread = vi.fn(() => ({ runStreamed: async () => ({ events: (async function* () {})() }) }))
    const codex = { startThread, resumeThread }
    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })
    const message: Message = {
      kind: 'message',
      role: 'user',
      messageId: 'm',
      taskId: 'task-im',
      contextId: 'ctx-im',
      parts: [{ kind: 'text', text: 'hi' }],
      metadata: { codexAgent: { threadId: 'abc' } },
    }

    await executor.execute({ taskId: 'task-im', contextId: 'ctx-im', userMessage: message }, createEventBus().eventBus)

    expect(resumeThread).toHaveBeenCalledWith('abc', expect.anything())
    expect(startThread).not.toHaveBeenCalled()
  })

  it('resumes from the legacy metadata.codexThreadId key', async () => {
    const resumeThread = vi.fn(() => ({ runStreamed: async () => ({ events: (async function* () {})() }) }))
    const codex = {
      startThread: vi.fn(() => ({ runStreamed: async () => ({ events: (async function* () {})() }) })),
      resumeThread,
    }
    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })
    const message: Message = {
      kind: 'message',
      role: 'user',
      messageId: 'm',
      taskId: 'task-lg',
      contextId: 'ctx-lg',
      parts: [{ kind: 'text', text: 'hi' }],
      metadata: { codexThreadId: 'abc' },
    }

    await executor.execute({ taskId: 'task-lg', contextId: 'ctx-lg', userMessage: message }, createEventBus().eventBus)

    expect(resumeThread).toHaveBeenCalledWith('abc', expect.anything())
  })

  it('falls back to startThread when resumeThread is unavailable', async () => {
    const startThread = vi.fn(() => ({ runStreamed: async () => ({ events: (async function* () {})() }) }))
    const codex = { startThread } // no resumeThread
    const executor = new CodexExecutor({ codex, logger: createSilentLogger() })
    const message: Message = {
      kind: 'message',
      role: 'user',
      messageId: 'm',
      taskId: 'task-nf',
      contextId: 'ctx-nf',
      parts: [{ kind: 'text', text: 'hi' }],
      metadata: { codexAgent: { threadId: 'abc' } },
    }

    await executor.execute({ taskId: 'task-nf', contextId: 'ctx-nf', userMessage: message }, createEventBus().eventBus)

    expect(startThread).toHaveBeenCalledTimes(1)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/codex-executor.test.ts -t "resume"`
Run: `pnpm exec vitest run tests/codex-executor.test.ts -t "thread_id"`
Expected: FAIL — `thread_id` not surfaced, `resumeThread` never called.

- [ ] **Step 3: Extend the `CodexLike` type**

In `src/codex-executor.ts`, find:

```ts
type CodexLike = {
  startThread: (options?: ThreadOptions) => ThreadLike
}
```

Replace with:

```ts
type CodexLike = {
  startThread: (options?: ThreadOptions) => ThreadLike
  resumeThread?: (id: string, options?: ThreadOptions) => ThreadLike
}
```

- [ ] **Step 4: Add the `contextThreadIds` field**

Find:

```ts
  private taskContexts = new Map<string, string>()
```

Add immediately after it:

```ts
  private contextThreadIds = new Map<string, string>()
```

- [ ] **Step 5: Make thread selection resume-aware**

In `execute()`, find this block (as it stands after Task 3):

```ts
      let thread = this.threads.get(contextId)

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
```

Replace it with:

```ts
      let thread = this.threads.get(contextId)

      const existingThreadKey = `${contextId}:${currentWorkingDir}`
      const cachedThreadKey = this.threadWorkingDirs.get(contextId)

      const knownThreadId = this.contextThreadIds.get(contextId)
      const inboundThreadId = this.readInboundThreadId(userMessage)
      // Client explicitly asked to bind this context to a different thread → resume it.
      if (inboundThreadId && inboundThreadId !== knownThreadId && thread) {
        this.threads.delete(contextId)
        thread = undefined
      }
      const resumeId = inboundThreadId ?? knownThreadId

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

        if (resumeId && this.codex.resumeThread) {
          thread = this.codex.resumeThread(resumeId, resolvedThreadOptions)
          this.contextThreadIds.set(contextId, resumeId)
          this.logger.log('[Codex A2A] Thread resumed with config:', {
            threadId: resumeId,
            workingDirectory: workingDir || process.cwd(),
            sandboxMode: resolvedThreadOptions.sandboxMode,
          })
        } else {
          thread = this.codex.startThread(resolvedThreadOptions)
          this.logger.log('[Codex A2A] Thread started with config:', {
            workingDirectory: workingDir || process.cwd(),
            webSearchEnabled: resolvedThreadOptions.webSearchEnabled,
            networkAccess: resolvedThreadOptions.networkAccessEnabled,
            sandboxMode: resolvedThreadOptions.sandboxMode,
          })
        }
        this.threads.set(contextId, thread)
        this.threadWorkingDirs.set(contextId, existingThreadKey)
      }
```

- [ ] **Step 6: Capture + surface `thread_id` on `thread.started`**

Find:

```ts
        if (event.type === 'thread.started') {
          this.publishStatus(eventBus, taskId, contextId, 'working', false, undefined, 'thread-started')
          continue
        }
```

Replace with:

```ts
        if (event.type === 'thread.started') {
          if (event.thread_id) this.contextThreadIds.set(contextId, event.thread_id)
          this.publishThreadStarted(eventBus, taskId, contextId, event.thread_id)
          continue
        }
```

- [ ] **Step 7: Add the two new private methods**

Add these methods to the `CodexExecutor` class (e.g. right before `private publishStatus(`):

```ts
  private readInboundThreadId(message: Message): string | undefined {
    const meta = message.metadata
    if (!meta) return undefined
    const codexAgent = meta.codexAgent as { threadId?: unknown } | undefined
    const fromAgent = codexAgent?.threadId
    const raw = typeof fromAgent === 'string' ? fromAgent : meta.codexThreadId
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined
  }

  private publishThreadStarted(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    threadId?: string
  ) {
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state: 'working',
        timestamp: new Date().toISOString(),
      },
      final: false,
      metadata: {
        codexAgent: { kind: 'thread-started', ...(threadId ? { threadId } : {}) },
      },
    } satisfies TaskStatusUpdateEvent)
  }
```

> Note: do NOT clear `contextThreadIds` inside `clearThreads()` or `evictThreadsIfNeeded()` — keeping it is what enables resume after eviction/clear (spec §3.2).

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/codex-executor.test.ts`
Expected: PASS — the 5 new tests plus all pre-existing executor tests (the existing `handles thread.started event` test still sees `metadata.codexAgent.kind === 'thread-started'`).

- [ ] **Step 9: Typecheck**

Run: `pnpm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/codex-executor.ts tests/codex-executor.test.ts
git commit -m "feat: resume Codex threads and surface thread_id over A2A"
```

---

## Task 5: Docs + changeset

**Files:**
- Modify: `README.md`
- Create: `.changeset/codex-sdk-features.md`

- [ ] **Step 1: Update the README event-mapping note**

In `README.md`, under `## Event mapping`, change the `thread.started` line:

```
- `thread.started` -> `status-update`
```
to:
```
- `thread.started` -> `status-update` (exposes `metadata.codexAgent.threadId`)
```

- [ ] **Step 2: Add "Resuming threads" and "Image input" sections**

In `README.md`, immediately before `## API`, insert:

```markdown
### Resuming threads

Each context's Codex thread is cached in memory and survives LRU eviction. To resume
a thread across a server restart, capture the id the server surfaces on `thread.started`
(`status-update.metadata.codexAgent.threadId`) and send it back on a later message:

```ts
const message = {
  kind: 'message',
  role: 'user',
  messageId: crypto.randomUUID(),
  parts: [{ kind: 'text', text: 'continue' }],
  metadata: { codexAgent: { threadId: savedThreadId } },
}
```

The legacy key `metadata.codexThreadId` is also accepted. Resumed sessions are read
from `~/.codex/sessions`.

### Image input

Send A2A `file` parts with an `image/*` MIME type alongside (or instead of) text.
Inline base64 bytes are written to a temp file and removed after the turn; local
`file://` paths are passed through only when they resolve inside the working directory
(or a configured `additionalDirectories` entry). Remote `http(s)` URIs and non-image
files are ignored.

```ts
const message = {
  kind: 'message',
  role: 'user',
  messageId: crypto.randomUUID(),
  parts: [
    { kind: 'text', text: 'What is in this screenshot?' },
    { kind: 'file', file: { bytes: base64Png, mimeType: 'image/png', name: 'shot.png' } },
  ],
}
```
```

- [ ] **Step 3: Create the changeset**

Create `.changeset/codex-sdk-features.md`:

```markdown
---
"codex-a2a": minor
---

Upgrade `@openai/codex-sdk` to `^0.142.1` and surface two existing SDK capabilities:

- **Thread resume**: capture and expose the Codex `thread_id` on `thread.started`
  (`metadata.codexAgent.threadId`); resume a context's thread after LRU eviction or via a
  client-supplied `metadata.codexAgent.threadId` (legacy `metadata.codexThreadId` accepted).
- **Image input**: forward A2A `image/*` file parts to Codex as `local_image` (inline bytes →
  temp file; local `file://` paths scoped to the working directory). Agent card now declares
  image input modes.
```

- [ ] **Step 4: Full verification**

Run: `pnpm run typecheck && pnpm run test && pnpm run build`
Expected: typecheck clean, all tests pass, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add README.md .changeset/codex-sdk-features.md
git commit -m "docs: document thread resume + image input; add changeset"
```

---

## Self-Review

**Spec coverage:**
- §3 thread resume + thread_id → Task 4 (type, field, selection, surfacing, inbound read) + Task 5 (changeset/README). ✓
- §4 image input → Task 2 (helper) + Task 3 (executor wiring). ✓
- §4.2 path scoping → Task 2 `isWithin` + "outside working directory" test. ✓
- §5 agent card image modes → Task 1. ✓
- §6 backward compat → text-only stays a string (Task 3), existing tests unchanged. ✓
- §7 tests → Tasks 1–4 each add the spec's named tests. ✓
- §8 docs/changeset → Task 5. ✓
- package.json SDK bump → already done before planning.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `buildCodexInput(message, BuildInputOptions) → BuiltInput {input, hasContent, cleanup}` used identically in Task 2 and Task 3. `CodexLike.resumeThread?(id, options)` defined in Task 4 Step 3 and called in Step 5. `readInboundThreadId`/`publishThreadStarted` defined in Step 7, referenced in Steps 5–6. `SUPPORTED_IMAGE_MIME_TYPES` defined in Task 1, consumed by the agent card (Task 1). ✓

**Note on codex-input vs SUPPORTED_IMAGE_MIME_TYPES:** the helper detects images by the `image/` MIME prefix (broader than the constant) plus an extension fallback; the constant drives only what the agent card advertises and the temp-file extension map. This is intentional — accept any `image/*`, advertise the common four.
