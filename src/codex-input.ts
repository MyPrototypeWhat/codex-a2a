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
