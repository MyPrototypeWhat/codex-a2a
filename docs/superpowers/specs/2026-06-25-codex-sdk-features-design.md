# 设计文档：codex-a2a 适配 Codex SDK 新能力（线程 resume + 图片输入）

- 日期：2026-06-25
- 状态：待评审
- 关联：`@openai/codex-sdk` 由 `^0.116.0` 升级到 `^0.142.1`

## 1. 背景与目标

`codex-a2a` 是把 OpenAI Codex 包装成 A2A 服务器的薄适配层。核心在
[`src/codex-executor.ts`](../../../src/codex-executor.ts)（把 Codex 流式事件翻译成 A2A 更新）和
[`src/codex-a2a-server.ts`](../../../src/codex-a2a-server.ts)（Express 服务）。

升级 SDK 后对比 `0.116.0` → `0.142.1` 的类型定义，发现 **API 表面几乎没变**（仅新增
`Usage.reasoning_output_tokens` 和 `McpToolCallItem.result._meta`，且均已被现有代码透传）。
真正的价值在于：**适配层一直没有用满 SDK 已有的能力**。本次补两项：

1. **线程 resume + `thread_id` 暴露** —— 当前只用 `startThread`，线程仅存在内存里，
   LRU 淘汰或服务重启后丢失。SDK 早已提供 `resumeThread(id)`（会话持久化在 `~/.codex/sessions`）。
2. **图片 / 多模态输入** —— 当前只读取 `text` part，A2A 消息里的 `file`（图片）part 被丢弃。
   Codex `Input` 支持 `{ type: 'local_image', path }`。

## 2. 范围

### 做（In scope）
- 捕获并暴露 `thread.started` 事件里的 `thread_id`。
- 支持线程 resume，两种触发：
  - **内存映射**：`contextId → thread_id`，自动，扛得住 LRU 淘汰。
  - **客户端回传**：`message.metadata.codexThreadId`，扛得住服务重启。
- 支持图片输入：A2A `FileWithBytes`（base64）写临时文件、本地 / `file://` 路径直接使用。
- 单元测试（TDD）、README、changeset。

### 不做（Out of scope，本次）
- 远程 `http(s)` 图片 URI 的下载（避免外网请求 + SSRF 面）—— 跳过并告警。
- 非图片文件（PDF 等）—— Codex 仅支持 `local_image`，跳过并告警。
- 持久化存储层（把 `contextId→thread_id` 落盘）—— 跨重启 resume 由客户端回传 id 实现。
- A2A SDK 升级到 `1.0.0-alpha`（仍是预发布，保持 `0.3.13` 稳定版）。

## 3. 功能一：线程 resume + `thread_id` 暴露

### 3.1 类型变更
`CodexLike` 增加可选 `resumeThread`（真实 `Codex` 一定有；测试里的 partial mock 仍合法）：

```ts
type CodexLike = {
  startThread: (options?: ThreadOptions) => ThreadLike
  resumeThread?: (id: string, options?: ThreadOptions) => ThreadLike
}
```

### 3.2 新增状态
```ts
private contextThreadIds = new Map<string, string>() // contextId -> 最近已知 thread_id
```
该映射在 **LRU 淘汰和 `clearThreads()` 时都保留**（只清理活动线程，不清理 resume 元数据），
以便后续请求仍可 resume。已知限制：随不同 context 数量增长（仅短字符串，可接受；后续可加上限）。

### 3.3 读取客户端回传的 id
```ts
private readInboundThreadId(message: Message): string | undefined {
  const raw = message.metadata?.codexThreadId
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}
```

### 3.4 线程选择逻辑（替换 `execute()` 中创建线程的分支）
优先级：客户端回传 id > 内存已知 id > 全新 `startThread`。

```ts
const knownThreadId = this.contextThreadIds.get(contextId)
const inboundThreadId = this.readInboundThreadId(userMessage)

// 客户端显式绑定到与活动线程不同的 thread：丢弃活动缓存，改为 resume
if (inboundThreadId && inboundThreadId !== knownThreadId && thread) {
  this.threads.delete(contextId)
  thread = undefined
}
const resumeId = inboundThreadId ?? knownThreadId

// 既有逻辑：工作目录变化时使活动缓存失效
if (thread && cachedThreadKey !== existingThreadKey) {
  this.threads.delete(contextId)
  thread = undefined
}

if (!thread) {
  this.evictThreadsIfNeeded()
  const resolvedThreadOptions: ThreadOptions = { ...threadOptions, skipGitRepoCheck: ..., workingDirectory: ... }
  if (resumeId && this.codex.resumeThread) {
    thread = this.codex.resumeThread(resumeId, resolvedThreadOptions)
    this.contextThreadIds.set(contextId, resumeId)
    this.logger.log('[Codex A2A] Thread resumed', { threadId: resumeId, ... })
  } else {
    thread = this.codex.startThread(resolvedThreadOptions)
    this.logger.log('[Codex A2A] Thread started with config:', { ... })
  }
  this.threads.set(contextId, thread)
  this.threadWorkingDirs.set(contextId, existingThreadKey)
}
```

### 3.5 捕获并暴露 thread_id
`thread.started` 处理分支：
```ts
if (event.type === 'thread.started') {
  if (event.thread_id) this.contextThreadIds.set(contextId, event.thread_id)
  this.publishStatus(
    eventBus, taskId, contextId, 'working', false, undefined,
    'thread-started',
    event.thread_id ? { threadId: event.thread_id } : undefined, // 新增 extraMeta 入参
  )
  continue
}
```
`publishStatus` 新增可选 `extraMeta?: Record<string, unknown>`，合并进 `codexAgent`：
```ts
metadata: codexAgentKind ? { codexAgent: { kind: codexAgentKind, ...extraMeta } } : undefined,
```
客户端从 `status-update.metadata.codexAgent.threadId` 读到 id，持久化后通过
`message.metadata.codexThreadId` 回传即可跨重启 resume。

## 4. 功能二：图片 / 多模态输入

### 4.1 新文件 `src/codex-input.ts`（避免 executor 继续膨胀，便于单测）
```ts
import type { Message } from '@a2a-js/sdk'
import type { Input } from '@openai/codex-sdk'

export interface BuiltInput {
  input: Input              // 无图片时为 string（向后兼容）；有图片时为 UserInput[]
  hasContent: boolean       // 有文本或图片
  cleanup: () => Promise<void> // 删除本次创建的临时文件
}

export async function buildCodexInput(
  message: Message,
  logger?: Pick<Console, 'log' | 'error'>,
): Promise<BuiltInput>
```

### 4.2 处理规则
- `text` part → 合并为文本（`\n` 连接），与现状一致。
- `file` part：
  - 判定是否图片：`mimeType?.startsWith('image/')`；缺 `mimeType` 时按 `name`/`uri` 后缀兜底
    （`.png/.jpg/.jpeg/.gif/.webp/.bmp`）。
  - `FileWithBytes`（含 `bytes`）：base64 解码 → 写入 `os.tmpdir()` 临时文件
    （文件名 `randomUUID` + 由 mimeType/扩展名推断的后缀）→ `{ type:'local_image', path }`，记录待清理。
  - `FileWithUri`（含 `uri`）：`file://` → `fileURLToPath`；绝对本地路径 → 直接用；
    `http(s)://` → **跳过并告警**（范围外）。这类路径非本程序创建，不加入清理列表。
  - 非图片 file part → 跳过并告警。
- 组装 `input`：
  - 无图片 → `input = text`（string，向后兼容，现有测试不受影响）。
  - 有图片 → `input = [ ...(text ? [{type:'text', text}] : []), ...images ]`。
- `hasContent = text.length > 0 || images.length > 0`。
- `cleanup`：逐个 `unlink` 临时文件，忽略错误。

### 4.3 `execute()` 变更
```ts
const { input, hasContent, cleanup } = await buildCodexInput(userMessage, this.logger)
if (!hasContent) {
  await cleanup()
  this.publishFailure(eventBus, taskId, contextId, 'No text or image content')
  return
}
// ...创建 abortController、选/建线程...
try {
  const { events } = await thread.runStreamed(input, mergedTurnOptions)
  // ...事件循环不变...
} finally {
  this.abortControllers.delete(taskId)
  await cleanup()
}
```
`ThreadLike = Pick<Thread,'runStreamed'>`，`runStreamed(input: Input)` 接受 `string | UserInput[]`，
类型安全。空内容守卫由 `if (!text)` 改为 `if (!hasContent)`，从而允许「纯图片」消息。

## 5. 向后兼容
- 纯文本消息：`input` 仍是 string，行为与输出完全不变。
- 现有 16 个测试：mock 的 `codex` 只有 `startThread` —— `resumeThread` 为可选且仅在已知 id 时调用，
  纯文本首轮不会触发 resume，故全部保持绿。`thread.started` 测试新增 `threadId` 元数据不破坏既有断言。
- 仅新增能力，无破坏性改动。

## 6. 测试计划（TDD，先红后绿）

### `tests/codex-input.test.ts`（新）
- 纯文本 → `input` 为 string，`hasContent` true，`cleanup` 无副作用。
- 仅 data part / 空 → `hasContent` false。
- 图片 bytes → 临时文件确实写入、`input` 为含 `local_image` 的 `UserInput[]`、含文本时文本在前；
  `cleanup` 后文件被删除。
- 纯图片（无文本）→ `input` 为只含图片的数组，`hasContent` true。
- `file://` 本地图片 → 路径直接透传，不创建临时文件，`cleanup` 无副作用。
- 非图片 file → 跳过；若为唯一 part 则 `hasContent` false。
- 远程 `http(s)` 图片 → 跳过（方案 A）。

### `tests/codex-executor.test.ts`（增）
- **thread_id 暴露**：`thread.started{thread_id:'t1'}` → 某 `status-update.metadata.codexAgent.threadId === 't1'`。
- **缓存丢失后 resume**：首轮 emit `thread.started t1` → `clearThreads()` → 同 context 再次 execute →
  `codex.resumeThread('t1', ...)` 被调用。
- **客户端回传 resume**：全新 context 的消息带 `metadata.codexThreadId:'abc'` → `resumeThread('abc')` 被调用。
- **无 resumeThread 兜底**：codex 不含 `resumeThread` 且有已知 id → 退回 `startThread`，不报错。
- **图片透传**：消息带图片 bytes part → 捕获 `runStreamed` 的入参为数组且含 `local_image`。

## 7. 文档与发布
- README：
  - 「Event mapping」补充 `thread.started` 现会在 metadata 暴露 `threadId`。
  - 新增「Resuming threads」：从 `metadata.codexAgent.threadId` 读取、经 `message.metadata.codexThreadId` 回传。
  - 新增「Image input」：发送带 `image/*` mimeType 的 A2A file part（bytes 或本地路径）。
- changeset：**minor**（新增能力，向后兼容），`0.3.1 → 0.4.0`，并记录 SDK 升级到 `^0.142.1`。

## 8. 待实现文件清单
- 改：`src/codex-executor.ts`（类型、状态、线程选择、thread_id 暴露、input 接入、cleanup）。
- 新：`src/codex-input.ts`。
- 新：`tests/codex-input.test.ts`；改：`tests/codex-executor.test.ts`。
- 改：`README.md`；新：`.changeset/*.md`。
- 已改：`package.json`（SDK `^0.142.1`，已完成）。
