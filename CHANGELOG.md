# codex-a2a

## 0.4.0

### Minor Changes

- 9543747: Upgrade `@openai/codex-sdk` to `^0.142.1` and surface two existing SDK capabilities:

  - **Thread resume**: capture and expose the Codex `thread_id` on `thread.started`
    (`metadata.codexAgent.threadId`); resume a context's thread after LRU eviction or via a
    client-supplied `metadata.codexAgent.threadId` (legacy `metadata.codexThreadId` accepted).
  - **Image input**: forward A2A `image/*` file parts to Codex as `local_image` (inline bytes →
    temp file; local `file://` paths scoped to the working directory). Agent card now declares
    image input modes.

  Also exports a typed metadata contract so consumers don't hand-write magic keys:
  `threadIdMetadata()`, `readThreadId()`, `CodexAgentEventKind`, `CodexAgentMetadata`,
  `CODEX_AGENT_METADATA_KEY`, `LEGACY_THREAD_ID_KEY`, and `SUPPORTED_IMAGE_MIME_TYPES`.
  `getWorkingDirectory` is deprecated in favor of `getThreadOptions().workingDirectory`.

## 0.3.1

### Patch Changes

- ade51ff: update readme

  - Add CI and npm badges
  - Document new configuration options (CORS, maxThreads, shutdownTimeout)
  - Add thread.started and error to event mapping table
  - Switch script examples from npm to pnpm
  - Add license section

## 0.3.0

### Minor Changes

- 820a927: ### Breaking Changes

  - `cancelTask` now uses `AbortController` to truly abort running Codex streams instead of soft polling. Custom `getTurnOptions` that return a `signal` will be merged with the internal abort signal.
  - Minimum `@openai/codex-sdk` version bumped to `^0.116.0`.
  - Minimum `@a2a-js/sdk` version bumped to `^0.3.13`.
  - License changed from Apache-2.0 to MIT.

  ### Features

  - **AbortController cancellation** — tasks are now cancelled immediately via `AbortSignal` passed to `runStreamed`, replacing the previous poll-based approach.
  - **Thread cache LRU eviction** — new `maxThreads` option (default 64) with automatic eviction of least-recently-used threads to prevent memory leaks. Added `clearThreads()` public method.
  - **Configurable CORS** — new `cors` option on `CodexA2AServer` to customize `origin`, `methods`, and `headers` (defaults unchanged).
  - **Graceful shutdown** — `stop()` now waits for active connections to drain (configurable via `shutdownTimeout`, default 5s) and cleans up cached threads.
  - **New Codex event support** — handles `thread.started` and `ThreadErrorEvent` (`type: "error"`) from codex-sdk 0.116.
  - **Robust error handling** — `execute()` is wrapped in try-catch; `resolveCodex()` provides a clear error message when `@openai/codex-sdk` is missing.
  - **Safe port scanning** — `findAvailablePort` uses iteration instead of recursion, with a 100-port scan limit.
  - **Changeset + CI** — added `@changesets/cli` for version management and GitHub Actions workflows for CI and automated npm publishing.

  ### Bug Fixes

  - Fixed potential stack overflow in recursive `findAvailablePort` when many ports are occupied.
  - Fixed `publishFailure` not calling `eventBus.finished()` when `runStreamed` throws synchronously.
