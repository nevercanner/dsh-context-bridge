[English](./README.md) · **简体中文**

# dsh-context-bridge

DSH 会话**自动交接**。会话跑到 **15 轮**（`handoffRounds`，可改）时，插件在那一轮的 `turn/end` 上强制交接一次：把旧会话的**完整上下文**（系统提示、user/assistant 历史、tool/result）序列化归档成一份 JSON，把「当前目标 / 已做到哪 / 下一步 / 项目事实」压成一份交接文档投给新会话，用**侧边栏里的会话名**把新会话注册到会话总线，最后把旧会话从活跃列表里归档。手动触发（菜单 / 面板按钮）仍然保留。

**为什么按轮次而不是按 token**：token 用量随工具输出剧烈抖动，同一个阈值在两个会话上意味着完全不同的工作量；轮次是宿主自己维护的序号（`turn/start` 的 `turn`），语义稳定、可复现、不需要插件维护任何计数器状态。

**阈值热改**：每次判断前都重读 `<项目>/.dsh-bridge.json`，插件里没有任何配置缓存 —— 会话中途把 `handoffRounds` 从 15 改成 20，下一轮就按 20 走，不用重启。

默认**开启**：没有配置文件也能用（15 轮 + `.dsh-archive` 归档）。要关掉某个项目的自动交接，写 `{"autoHandoff": false}`；要关掉整个插件，写 `{"enabled": false}`。

---

## 什么时候触发

| 路径 | 触发点 | 说明 |
|---|---|---|
| 自动 | `session/event` 的 `turn/end`，且当前轮次 ≥ `handoffRounds` | 只在**一轮收尾**后动手，不在 turn 中途打断（否则用户刚发的这一轮永远得不到回答）。日志里会出现 `handoff triggered at round 15` |
| 手动 | 会话行 `…` 菜单的 **上下文交接：生成并续接** / 面板里的 **立即交接** | 人的判断永远优先：想提前换会话就点 |

同一会话的**同一轮只尝试一次**。归档失败时交接整体中止（不建会话、不登记总线、原会话继续跑），并且不会在后续每一轮重撞同一个磁盘错误。

## 交接做了五件事

1. **归档旧上下文**（最先做，失败即整体中止）：`<项目>/.dsh-archive/<session_id>-<时间戳>.json`，字段 `session_id` / `archive_time` / `context_snapshot`（含系统提示、user/assistant 历史、tool/result 的全部原始事件）。tmp + rename 原子写，不留半个 JSON。
2. **建新会话**：`agents.create({ sessionId, agentOptions, meta: { cwd, parentSession } })`，**不带 seed**（seed 里的 `user/message` 会占住 surface 首家，把日志写成读不回来的形状）。
3. **登记会话总线**：注册名 = **侧边栏手动命名的会话名**（`session/title` 事件且 `source.kind === 'user'`），先把旧会话的同名登记摘掉（名称转移，避免同名双 owner）；没手动命名则回退成新会话 id（UUID）。
4. **投递交接文档**：走 `agent.followup()`，让它真的开始干活，而不是挂着一份文档不动。
5. **藏起旧会话**：`workspaceRegistry.archiveSession()`（活动时报错则重试 `{ stopActivity: true }`）。旧会话不再出现在活跃列表，但仍可从归档文件恢复。

这几步的失败处理都在 `src/handoff-host.js` 的 `runHandoff` 里写成了显式分支，顺序不可调换。

## 产出长什么样

一份 Markdown，刻意写短 —— 把整段对话复述一遍的交接文档，自己又会撞上同一堵墙。**只在归档路径那一行之外不引用原文**，细节靠归档文件兜底。

| 小节 | 内容 | 源数据 |
|---|---|---|
| 头部 | 源会话标题/id、总线名、**旧上下文归档文件路径**、规模（几轮 / 几条事件）、**事件定位锚点**（`events[#68]` 这种，直接照着去归档里看） | 归档结果 |
| 一句话 | 20 字以内说清这活在干嘛：进行中的待办 → 最后一条要求 → 上一轮提问 → 会话标题（模型摘要开启时用模型给的主线） | `todo/write` / `user/message` / 本地或模型摘要 |
| 已经做到哪 | 只留**结论**：已完成待办、助手收尾结论、改动面（最高频 3 个文件）。过程话术（"我来看看"）一律丢 | `todo/write` / `assistant/message` / `tool/call` |
| 下一步 | 进行中优先，然后剩余待办；没有待办时按最后一条要求继续，并提示先 `git status` | `todo/write` → `user/message` |
| 关键事实 | 五组，一行一条带次数：**改动/涉及的文件**、**跑过的关键命令**、**踩过的坑（错误原文首行）**、**约束（新会话必须遵守）**、结论与决定 | `tool/call` / `tool/result`（只看 `isError`）/ `user/message` |
| 用户最近的原始要求 | 最近 3 条用户消息逐字保留（各截 600 字），防「待办为空 = 任务丢失」 | `user/message` |
| 最近几轮 | 一行一轮：要求 → 结论 | `turn/start` 划分轮次 |
| 注意事项 | 约束条款（去重后合并）+ 上次踩的坑 + 工具轨迹 + 工作目录 + 自查提醒 | 摘要 / `tool/call` |

**字数预算**：默认 `docBudget: 3000`。超了先整节删掉「最近几轮」，还不够就硬截断并注明「完整内容见归档」—— 交接文档是路线图，不是会话副本。

**约束只留条款，不留整句**：用户原话「把 3 号模块补上，别动 lib/」在「注意事项」里只出现 `别动 lib/（×12）` 一条，原句仍然逐字留在「原始要求」里。

默认全部从源会话自己的事件日志生成（`sessionQuery`，只读），**不调模型**：不花 token、不拖慢 `turn/end`，也不会编造没给它的东西。想让模型把「改了 A + 加了 B + 测试全绿」合成一句人话，见下面的 `summarizer` 配置（默认关闭，失败/超时静默回落本地摘要）。

### 为什么以前是空的（v0.2.0 的真实缺陷）

三个结构性原因，都跟归档无关：

1. **用户消息被整段丢掉**。宿主真实事件形状是 `user/message → { content: [...] }`（**没有** `turn` 字段），轮次只出现在 `turn/start` / `turn/end` / `assistant/message` / `tool/call` 上。早先的提取器只认消息自带的 `data.turn`，于是所有用户消息都被过滤掉 —— 在一份真实的 8900 条事件日志里，**169 条 user/message，带 `data.turn` 的是 0 条**，`ask` 因此恒为空，文档只剩「（源会话没有留下明确的当前任务）」。
2. **待办永远是空的**。待办只来自 `todo/write` 事件，而这个宿主上 `tool-todo` 插件是 disabled 的 → 同一份日志里 `todo/write` 计数为 0。
3. **摘要基本没有**。同理 `compaction-basic` 常被关掉，`compaction/summary` 可能一次都没有。

v0.3.0 起：轮次由 `turn/start` 推出（`turnMap`），用户消息按当时的轮次归位；再加两条**一定存在**的材料 —— 逐字原始要求、工具调用轨迹 —— 以及文档头里的归档路径（新会话要原文就 `read` 那个文件）。归档本身从来不解决「文档为空」：归档只写不读，不写进文档头，新会话根本不知道它存在。

## 新会话是怎么起的

1. `agents.create({ sessionId, agentOptions, meta })` 建一个**空**会话，由宿主自己持久化；
2. 把新会话 attach 进 workspace（走 `agents.create` 时宿主不会自动挂，不 attach 侧栏项目区就找不到它）；
3. 再把交接文档通过 `agent.followup()` 投进去，**让它真的开始干活**。

宿主没有 `agents.create` 时，明确报原因，不建任何东西（旧上下文已经归档，归档路径会写在 detail 里）。

## 会话总线注册名：侧边栏手动名，否则 UUID

字段是 **`session.title`** —— 扫宿主源码确认的：`@deepseek-ai/dsh-client-ui-workspace/lib/client.js:999` 渲染会话行用的是 `session.title?.trim()`；宿主里**没有** `displayName` / `customName`。手动改名走 `sessionTitle.rename()`，它 append 一条 `session/title` 事件、`source: { kind: 'user' }`；自动生成的标题是 `provider` / `fallback`。

所以「用户手动命名过」的判定只有一条可靠依据：**最新 title 快照的 `source.kind === 'user'`**。自动标题不算（否则每个会话都会用一个用户根本不认识的名字去注册总线）。

- 读法：`sessionQuery.readTitleSnapshot(sessionId)`（活会话/历史会话都能读）→ 退回 `sessionTitle.get(session)` → 都没有就回退新会话 id（UUID）；
- 有手动名：<名> 直接注册，旧会话的同名条目摘掉（名称转移）；
- 名字被**别的**会话占用：退让成 `<名>-2`、`-3`……，绝不覆盖别人的登记；最长 64 字符。

## 怎么开

```json
// <项目>/.dsh-bridge.json
{
  "enabled": true,
  "autoHandoff": true,
  "handoffRounds": 15,
  "archiveDir": ".dsh-archive",
  "todoLimit": 8,
  "recentTurns": 3,
  "docBudget": 3000,
  "summarizer": { "mode": "local", "timeoutMs": 12000 },
  "openNewSession": true
}
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 文件不存在也算开启；`false` = 自动交接与手动触发都停 |
| `autoHandoff` | `true` | `false` = 只保留手动触发 |
| `handoffRounds` | `15` | 跑到第几轮强制交接（1–500）；**每次判断前重读，改完下一轮生效** |
| `archiveDir` | `.dsh-archive` | 归档目录，相对项目根；也可给绝对路径 |
| `todoLimit` | `8` | 文档里最多列几条待办 |
| `recentTurns` | `3` | 总结最近几轮 |
| `docBudget` | `3000` | 交接文档正文字数预算（400–30000）；超了先砍「最近几轮」整节 |
| `summarizer` | `{mode:"local"}` | `local` = 纯本地规则压缩；`llm` = 额外调一次模型做真人话压缩，**有 `timeoutMs` 上限，失败静默回落 local** |
| `openNewSession` | `true` | 交接后把界面切到新会话 |

改配置不需要重启：每次 `turn/end` 判断前都会重新读这个文件。

## 界面

- 会话行 `…` 菜单里的一行，加侧栏一个面板图标；面板显示 项目 / 开关 / 触发方式 / 当前轮次 / 归档目录 / 总线名；
- 都走官方 slot 注册。Client 半**没有 DOM 变更观察器、不手动操纵宿主容器、不测量布局、不跑定时器** —— 由 `tests/client-safety.test.mjs` 静态扫描把关，任何一条重新出现，测试就失败。（姊妹插件 dsh-session-send 的菜单兜底曾造成「插入 → 重渲染」自激，打开模型菜单时锁死渲染主线程；本插件的结构让那个 bug 无法在这里复现。）

## 已知边界

- 只覆盖**会话日志里存在的事实**。只在人脑子里、没落盘的东西不在里面。
- `agents.create` / `workspaceRegistry.archiveSession` 是宿主 API；不提供的宿主上，插件会说明原因，不会假装成功（归档文件仍然会写）。
- 新会话继承的是 cwd 和 `parentSession` 指向，不是完整父历史 —— 完整历史在归档 JSON 里。
- 自动交接是「一轮收尾就换会话」，不做压缩判断。要「先压缩、压不动才换」，把 `autoHandoff` 关掉、只在需要时手动点。

## 会话日志修复工具

`scripts/` 里另有两个独立的日志修复脚本（纯 Python + `zstandard`，不依赖宿主），
用来修「已经写坏、打开就报 corrupt」的 `session.v4.jsonl.zstd`：

| 脚本 | 修的病灶 | 宿主报错 |
|---|---|---|
| `fix-surface-head.py` | `user/message` 占了 surface 首家，system 之后才到 | `system/message requires a protected first surface head` |
| `fix-step-coords.py` | 同一 turn 里 `step/start` 的编号重复/跳号 | `step/start does not match the open turn and next step` |

用法都一样：先不加参数干跑看它打算改哪几段，确认后加 `--apply` 落盘（自动备份
`session.v4.jsonl.zstd.bak-*`）。两个脚本都只改结构坐标，不动任何消息内容。

```bash
python scripts/fix-step-coords.py "C:/Users/<你>/.dsh/sessions/<项目>/<会话>" --apply
```

修复后如何自证：用宿主自己的校验器跑一遍（`@deepseek-ai/dsh-session` 的
`adoptSessionEvent`、`@deepseek-ai/dsh-session-format-v3-to-v4` 的
`restoreReleasedV4Artifact`、`Session.fromRestore`），三关全过再重开会话。

## 许可

MIT
