---
"codex-a2a": minor
---

### Breaking Changes

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
