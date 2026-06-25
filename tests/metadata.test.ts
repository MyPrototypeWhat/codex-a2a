import { describe, expect, it } from 'vitest'
import type { Message } from '@a2a-js/sdk'
import { readThreadId, threadIdMetadata } from '../src/metadata'

function msg(metadata?: Message['metadata']): Message {
  return {
    kind: 'message',
    role: 'user',
    messageId: 'm',
    parts: [{ kind: 'text', text: 'hi' }],
    metadata,
  }
}

describe('threadIdMetadata', () => {
  it('builds the codexAgent.threadId namespace', () => {
    expect(threadIdMetadata('t1')).toEqual({ codexAgent: { threadId: 't1' } })
  })
})

describe('readThreadId', () => {
  it('reads metadata.codexAgent.threadId', () => {
    expect(readThreadId(msg({ codexAgent: { threadId: 'abc' } }))).toBe('abc')
  })

  it('reads the legacy metadata.codexThreadId key', () => {
    expect(readThreadId(msg({ codexThreadId: 'legacy' }))).toBe('legacy')
  })

  it('prefers codexAgent.threadId over the legacy key', () => {
    expect(readThreadId(msg({ codexAgent: { threadId: 'new' }, codexThreadId: 'old' }))).toBe('new')
  })

  it('round-trips with threadIdMetadata', () => {
    expect(readThreadId(msg(threadIdMetadata('rt')))).toBe('rt')
  })

  it('returns undefined when there is no metadata', () => {
    expect(readThreadId(msg(undefined))).toBeUndefined()
  })

  it('returns undefined for an empty-string id', () => {
    expect(readThreadId(msg({ codexAgent: { threadId: '' } }))).toBeUndefined()
  })

  it('returns undefined for a non-string id', () => {
    expect(readThreadId(msg({ codexAgent: { threadId: 42 } }))).toBeUndefined()
  })

  it('returns undefined when codexAgent is not an object', () => {
    expect(readThreadId(msg({ codexAgent: 'oops' }))).toBeUndefined()
  })

  it('returns undefined when neither key is present', () => {
    expect(readThreadId(msg({ somethingElse: true }))).toBeUndefined()
  })
})
