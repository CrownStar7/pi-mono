# Tool System：repo_stats 工具契约设计

## 当前焦点

设计一个只读 `repo_stats` 工具契约，不编码。目标是验证是否理解：

```text
ToolDefinition.parameters
  -> ToolCall.arguments
  -> runtime execute input
  -> AgentToolResult
  -> ToolResultMessage
  -> context.messages
  -> next assistant message
```

---

# 1. 初始设计 Review

## 正确点

```text
- 已能按工具契约卡片组织字段。
- Permission boundary: 沙箱文件内，方向正确，说明开始考虑工具权限边界。
- Error path: error message，方向正确。
```

## 需要修正

```text
- Tool name 建议修正为 repo_stats，而不是 read_epo_stats。
- Schema 不能只写 path，需要说明字段类型、是否必填、默认值。
- Runtime execution 不能只写“调取工具”，需要说明 runtime 会统计什么。
- AgentToolResult 需要说明结构化输出形状。
- ToolResultMessage 不是 AI 模型返回的内容；它是 runtime 把工具执行结果包装后放回 context 的 observation。
```

## 关键误解

```text
ToolResultMessage 和 assistant message 不能混淆。

AI 模型返回的是 assistant message。
工具结果回 context 是 toolResult message。
```

---

# 2. repo_stats 工具契约卡片

## Tool name

```text
repo_stats
```

## Description

```text
Collect read-only repository statistics for a path, such as file count, directory count, total size, and top-level extension counts.
```

## Schema

```ts
{
  path: string,        // required; repo path or subdirectory path
  maxDepth?: number    // optional; limit directory traversal depth
}
```

## Permission boundary

```text
Read-only.
Only inspect files under the current workspace/repo root.
Do not modify files.
Do not execute shell commands.
Do not follow paths outside the workspace boundary.
```

## Runtime execution

```text
1. Resolve path within workspace.
2. Reject path outside workspace.
3. Walk directory entries up to maxDepth.
4. Count files and directories.
5. Sum file sizes.
6. Count file extensions.
7. Return structured stats.
```

---

# 3. AgentToolResult

`AgentToolResult` 是工具函数 execute() 直接返回的原始执行结果。

```ts
{
  content: [
    {
      type: "text",
      text: "Repo stats for .: 120 files, 24 directories, 3.2 MB total."
    }
  ],
  details: {
    path: ".",
    files: 120,
    directories: 24,
    totalBytes: 3355443,
    extensions: {
      ".ts": 80,
      ".md": 12,
      ".json": 4
    }
  }
}
```

说明：

```text
AgentToolResult 还不是 context message。
runtime 会把 AgentToolResult 包装成 ToolResultMessage。
```

---

# 4. ToolResultMessage

`ToolResultMessage` 是 runtime 写回 context 的工具 observation。

```ts
{
  role: "toolResult",
  toolName: "repo_stats",
  toolCallId: "call_...",
  content: [
    {
      type: "text",
      text: "Repo stats for .: 120 files, 24 directories, 3.2 MB total."
    }
  ],
  details: {
    path: ".",
    files: 120,
    directories: 24,
    totalBytes: 3355443,
    extensions: {
      ".ts": 80,
      ".md": 12,
      ".json": 4
    }
  },
  isError: false,
  timestamp: Date.now()
}
```

说明：

```text
ToolResultMessage 不是 AI 模型返回的内容。
ToolResultMessage 是 runtime 写回 context 的 observation。
AI 模型看到 ToolResultMessage 后，下一轮才生成 assistant message。
```

---

# 5. Error path

```text
If path is outside workspace, missing, unreadable, or traversal fails:
  -> repo_stats execute() returns or throws an error
  -> runtime creates error AgentToolResult
  -> runtime wraps it as ToolResultMessage(isError: true)
  -> append to context
  -> next assistant explains the failure
```

示例：

```ts
{
  role: "toolResult",
  toolName: "repo_stats",
  toolCallId: "call_...",
  content: [
    {
      type: "text",
      text: "Path is outside workspace: ../outside-workspace"
    }
  ],
  details: {},
  isError: true,
  timestamp: Date.now()
}
```

---

# 6. 最小链路

```text
assistant(toolCall: repo_stats)
  -> runtime finds repo_stats AgentTool
  -> runtime validates arguments
  -> repo_stats.execute()
  -> AgentToolResult
  -> runtime creates ToolResultMessage
  -> append ToolResultMessage to context
  -> second provider call
  -> assistant summary
```

---

# 7. 当前修正答案

```text
AgentToolResult:
  工具 execute() 返回的结果，包含 content 和 details。

ToolResultMessage:
  runtime 写回 context 的 message，role 是 toolResult，包含 toolName、toolCallId、content、details、isError、timestamp。
```

---

# 8. repo_stats 到 ToolDefinition 的映射

## 目标

把 `repo_stats` 工具契约映射到仓库真实接口 `ToolDefinition`。

位置：

```text
packages/coding-agent/src/core/extensions/types.ts
```

数据路径：

```text
repo_stats contract
  -> ToolDefinition
  -> wrapToolDefinition()
  -> AgentTool
  -> AgentContext.tools
  -> agent-loop execute
```

---

## ToolDefinition fields

### name

```ts
name: "repo_stats"
```

用途：

```text
模型调用工具时使用。
```

设计原则：

```text
短
稳定
唯一
不要包含拼写错误
不要混入具体实现方式
```

---

### label

```ts
label: "repo stats"
```

用途：

```text
UI 展示名称。
```

---

### description

```ts
description:
  "Collect read-only repository statistics for a path, including file count, directory count, total size, and extension counts."
```

用途：

```text
模型用它判断何时调用工具。
```

设计原则：

```text
说明能力
说明只读
说明输入对象
不要承诺不能保证的结果
```

---

### promptSnippet

```ts
promptSnippet: "Collect read-only repository statistics"
```

用途：

```text
默认系统提示里的简短工具说明。
```

---

### promptGuidelines

```ts
promptGuidelines: [
  "Use repo_stats when the user asks for repository size, file counts, directory counts, or extension distribution.",
  "Use read or grep instead when the user asks for specific file contents."
]
```

用途：

```text
额外引导模型何时使用该工具。
```

---

### parameters

TypeBox schema：

```ts
const repoStatsSchema = Type.Object({
  path: Type.String({
    description: "Repository path or subdirectory path to inspect, relative or absolute"
  }),
  maxDepth: Type.Optional(
    Type.Number({
      description: "Maximum directory traversal depth"
    })
  )
});
```

设计原则：

```text
模型可见 schema 要小
参数要明确
避免一次暴露太多选项
默认行为由 runtime 决定
```

---

### execute

runtime 执行入口。

伪代码：

```ts
async execute(_toolCallId, { path, maxDepth }, signal) {
  const absolutePath = resolve path within cwd;
  reject if outside workspace;
  walk directory up to maxDepth;
  count files;
  count directories;
  sum bytes;
  count extensions;

  return {
    content: [
      {
        type: "text",
        text: `Repo stats for ${path}: ${files} files, ${directories} directories, ${formatSize(totalBytes)} total.`
      }
    ],
    details: {
      path,
      files,
      directories,
      totalBytes,
      extensions
    }
  };
}
```

返回：

```ts
AgentToolResult<RepoStatsDetails>
```

---

### renderCall

UI 显示调用。

示例：

```text
repo_stats .
```

用途：

```text
告诉用户模型正在统计哪个路径。
```

---

### renderResult

UI 显示结果。

示例：

```text
120 files, 24 directories, 3.2 MB
```

用途：

```text
给用户简洁展示工具结果。
```

---

# 9. 字段归属

## 模型主要使用

```text
name
description
parameters
promptSnippet
promptGuidelines
```

## runtime 主要使用

```text
name
parameters
execute
prepareArguments
executionMode
```

## UI 主要使用

```text
label
renderCall
renderResult
```

## wrapper 转换

```text
ToolDefinition
  -> wrapToolDefinition()
  -> AgentTool
```

`wrapToolDefinition()` 保留 runtime 需要的字段：

```text
name
label
description
parameters
prepareArguments
executionMode
execute
```

UI/prompt metadata 不属于 agent runtime 核心状态。

---

# 10. repo_stats 实现前检查

## 系统位置

`repo_stats` 是一个 coding-agent 内置工具，和 `read`、`grep`、`find`、`ls` 同一类。

所以它应该属于：

```text
packages/coding-agent/src/core/tools/
```

不应该属于：

```text
packages/agent
packages/ai
packages/tui
```

原因：

```text
packages/ai:
  只定义 provider/tool protocol，不实现 repo 统计。

packages/agent:
  只执行抽象 AgentTool，不知道 repo_stats 的文件系统逻辑。

packages/tui:
  只渲染 UI，不负责工具执行。

packages/coding-agent:
  提供 coding agent 的具体工具能力。
```

---

## 最小实现文件规划

如果真的实现，最小需要这些文件：

```text
packages/coding-agent/src/core/tools/repo-stats.ts
packages/coding-agent/src/core/tools/index.ts
packages/coding-agent/test/repo-stats-tool.test.ts
```

### repo-stats.ts

包含：

```text
repoStatsSchema
RepoStatsToolInput
RepoStatsToolDetails
createRepoStatsToolDefinition()
createRepoStatsTool()
```

结构应参考：

```text
packages/coding-agent/src/core/tools/read.ts
packages/coding-agent/src/core/tools/find.ts
packages/coding-agent/src/core/tools/grep.ts
packages/coding-agent/src/core/tools/ls.ts
```

### tools/index.ts

导出并注册：

```text
createRepoStatsToolDefinition
createRepoStatsTool
RepoStatsToolInput
RepoStatsToolDetails
```

如果要成为内置工具，还需要加入：

```text
ToolName union
allToolNames
createToolDefinition()
createTool()
createAllToolDefinitions()
```

是否加入默认工具集合需要谨慎，因为会影响模型可见工具列表。

### repo-stats-tool.test.ts

测试工具本身，不走真实 provider。

---

## 最小实现边界

### 必须做

```text
读取目录
统计文件数
统计目录数
统计总字节数
统计扩展名数量
限制在 cwd/workspace 下
支持 AbortSignal
返回 AgentToolResult
```

### 暂时不做

```text
不执行 shell
不读取文件内容
不改文件
不追踪 gitignore
不做复杂 ignore 规则
不做 UI 高级渲染
不自动注册成默认工具
不处理 symlink 递归复杂语义，除非明确设计
```

---

## 权限边界

更精确的权限边界：

```text
只允许统计 cwd 下的路径。
```

需要避免：

```text
../outside
绝对路径指向 workspace 外
symlink escape
```

最小策略：

```text
resolve path
realpath workspace root
realpath target path
确认 target realpath 在 workspace realpath 内
```

如果超出边界：

```text
throw new Error("Path is outside workspace")
```

runtime 会转成：

```text
ToolResultMessage(isError: true)
```

---

## 测试规划

只测工具，不测模型。

### 测试 1：统计基础目录

fixture：

```text
tmp/
  package.json
  README.md
  src/index.ts
```

断言：

```text
files = 3
directories = 1
extensions[".json"] = 1
extensions[".md"] = 1
extensions[".ts"] = 1
totalBytes > 0
content[0].text includes "3 files"
```

### 测试 2：maxDepth

fixture：

```text
tmp/
  a.txt
  nested/b.txt
```

调用：

```ts
repo_stats({ path: ".", maxDepth: 0 })
```

断言需要基于已定义的 `maxDepth = 0` 语义。

### 测试 3：路径越界

调用：

```ts
repo_stats({ path: "../outside" })
```

预期：

```text
execute throws
```

如果经过 agent-loop，则预期：

```text
ToolResultMessage(isError: true)
```

### 测试 4：missing path

调用：

```ts
repo_stats({ path: "missing" })
```

预期：

```text
execute throws readable error
```

### 测试 5：AbortSignal

构造 aborted signal：

```ts
const controller = new AbortController();
controller.abort();
```

预期：

```text
execute rejects/throws Operation aborted
```

---

## 测试边界

不要直接测 provider。

正确测试边界：

```text
repo_stats tool test:
  toolCall args -> AgentToolResult

agent-loop test:
  ToolCall -> ToolResultMessage

provider test:
  provider-specific stream -> ToolCall
```

不要把三层混在一个测试里。

---

## 实现前 checklist

```text
1. 工具名是否稳定？
2. schema 是否小且明确？
3. 是否只读？
4. 是否限制 workspace 边界？
5. 是否支持 abort？
6. AgentToolResult.content 是否给模型足够摘要？
7. AgentToolResult.details 是否结构化？
8. 错误是否 throw，由 runtime 统一包装？
9. 是否有最小单测？
10. 是否真的需要加入默认工具集？
```

---

# 11. 当前理解回答

```text
repo_stats 是一个 coding-agent 内置工具，和 read/grep/find/ls 同一类。

所以它应该属于：
  packages/coding-agent/src/core/tools/

不是：
  packages/agent
  packages/ai
  packages/tui

原因：
  packages/ai:
    只定义 provider/tool protocol，不实现 repo 统计。

  packages/agent:
    只执行抽象 AgentTool，不知道 repo_stats 的文件系统逻辑。

  packages/tui:
    只渲染 UI，不负责工具执行。

  packages/coding-agent:
    提供 coding agent 的具体工具能力。
```
