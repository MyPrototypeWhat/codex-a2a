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
