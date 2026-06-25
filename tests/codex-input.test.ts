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
