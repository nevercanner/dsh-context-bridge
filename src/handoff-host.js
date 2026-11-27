/**
 * 交接执行器 —— host 半的核心，全部依赖从宿主 ctx 解析，没有静态 import。
 *
 * 为什么没有静态 import：本插件以 `link:` 本地包安装，宿主加载器解析
 * `@deepseek-ai/*` 的范围与插件自身不同；静态 import 会在某些 profile 下
 * 直接 import 失败，整个 entry 变 `failed`（dsh-session-send 在 2026-11-08 踩过）。
 * 所以一律走 ctx 上的服务和 `ctx.loader.internal.import`。
 *
 * 流程：
 *   1. 读源会话的事件（sessionQuery.observeSession，只读，不激活）
 *   2. 用 handoff.js 的纯函数拼出交接文档
 *   3. `agents.create({ sessionId, meta })` 建一个**空**会话（不带 seed，见下）
 *   4. （可选）给新会话起一个继承自总线的名字
 *   5. 把交接文档作为**第一轮用户消息**推进去（followup → 宿主写 user/message），唤醒它继续干活
 *
 * 为什么 seed 里不能放 user/message（v0.1.4 修）：
 *   宿主 v4 日志要求 surface 的**首个**节点必须是 `system/message`（受保护头），
 *   dsh-session-format-v3-to-v4 `foldSurface`：surface 非空且没有受保护头时再来一条
 *   `system/message` 就抛 SessionFormatError。把交接文档当 seed 写进 seq 0，等于让
 *   user/message 占了 surface 头，于是这条会话**第一次跑模型就把日志写成读不回来的形状**，
 *   下次打开报 `system/message requires a protected first surface head`。
 *   合规做法只有一条：交接文档交给 followup，宿主会把它排在第一轮 system/message 之后。
 */

import { readNames, nameIndex, nameOf, pickFreeName, writeName } from './bus-names.js'
import {
  buildHandoff,
  digestSummary,
  latestCompactionSummary,
  recentTurns,
  todosFromEvents,
  toolTrail,
  userRequests,
} from './handoff.js'
import { countTurns } from './rounds.js'
import { writeContextArchive } from './archive.js'
import { resolve } from './ctx-services.js'
import { readManualSessionName, titleTextOf } from './session-name.js'

/** 生成一个 session id（与宿主同款前缀，避免 UI 认不出）。 */
export function makeSessionId(randomUUID) {
  return `session-${randomUUID()}`
}

/**
 * 读一个会话的观察（只读）：返回 { events, header }。
 * header 携带项目根（observation.header.cwd）——宿主 api-session-controller 就
 * 是用它拿不回当前激活 agent 的会话 cwd（lib/index.js: 若
 * observation.header.cwd === void 0 判定为会话不存在）。
 * 宿主没有 sessionQuery 时返回 undefined。
 */
export async function readSessionObservation(ctx, sessionId) {
  const query = resolve(ctx, 'sessionQuery')
  if (query === undefined || typeof query.observeSession !== 'function') return undefined
  const observation = await query.observeSession(sessionId)
  if (observation === undefined || observation === null) return undefined
  try {
    const header =
      observation && typeof observation === 'object' && 'header' in observation ? observation.header : undefined
    return {
      events: Array.isArray(observation.events) ? observation.events : undefined,
      header: header && typeof header === 'object' ? header : undefined,
    }
  } finally {
    // observation 是租约，用完必须释放；没有 dispose 就跳过（只读观察不持有资源）
    if (typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose]()
  }
}

/** 读一个会话的完整事件（只读）。宿主没有 sessionQuery 时返回 undefined。 */
export async function readEvents(ctx, sessionId) {
  const observation = await readSessionObservation(ctx, sessionId)
  return observation === undefined ? undefined : observation.events
}

/**
 * 读一个会话的**完整快照**（归档用）：{ header, inheritedEventCount, events }。
 *
 * 为什么优先 `sessionQuery.readSession`：
 *   它返回宿主落盘/内存里的完整原始事件流（含 system/message 系统提示、
 *   user/assistant 历史、tool/result 调用记录），也正是 shell 里 `dsh session`
 *   类工具读的那份 —— 归档要「完整」，就不能拿 observeSession 的增量视图凑。
 *   `readSession` 不存在（老宿主 / 测试桩）时退 observeSession，拿到的照样是
 *   原始事件，只是没有 inheritedEventCount。
 */
export async function readSessionSnapshot(ctx, sessionId) {
  const query = resolve(ctx, 'sessionQuery')
  if (query !== undefined && typeof query.readSession === 'function') {
    try {
      const read = await query.readSession(sessionId)
      if (read !== undefined && read !== null && typeof read === 'object') {
        return {
          header: read.session !== null && typeof read.session === 'object' ? read.session : undefined,
          inheritedEventCount: typeof read.inheritedEventCount === 'number' ? read.inheritedEventCount : 0,
          events: Array.isArray(read.events) ? read.events : [],
        }
      }
    } catch {
      // 日志坏/会话不存在 → 退到只读观察，至少留下能留的部分
    }
  }
  const observation = await readSessionObservation(ctx, sessionId)
  return {
    header: observation?.header,
    inheritedEventCount: 0,
    events: observation?.events ?? [],
  }
}

/**
 * 把新会话 attach 进宿主 workspace，让侧栏项目区能列出它。
 * 宿主在常规「新建会话」路径（api-session-controller）里会调
 * workspace.attachSession；但我们走 agents.create 直建，宿主不会自动挂载，
 * 必须自己补这一步。找不到匹配的 workspace 或宿主没暴露该服务时忽略 ——
 * 会话本身已建好，不影响交接，只影响侧栏可见性。
 */
async function attachToWorkspace(ctx, sessionId, projectRoot) {
  try {
    const registry = resolve(ctx, 'workspaceRegistry')
    if (registry === undefined) return
    const workspaces =
      typeof registry.list === 'function'
        ? registry.list()
        : typeof registry.entries === 'function'
          ? Array.from(registry.entries().values())
          : []
    // 优先精确匹配 path === projectRoot 的 workspace；若匹配不上（比如宿主对
    // projectRoot 做了 realpath 展开导致字符串不等），就交给每个 workspace 的
    // attachSession 自己校验 —— attachSession 内部会用 realpathNormalize 对比
    // 会话 cwd 与 workspace.path，能对上才落盘，不会误挂到别的目录。
    const exact = workspaces.find((workspace) => workspace?.path === projectRoot)
    const candidates = exact !== undefined ? [exact] : workspaces
    for (const workspace of candidates) {
      if (typeof workspace?.attachSession !== 'function') continue
      try {
        await workspace.attachSession(sessionId)
        return
      } catch {
        // 该校验失败就试下一个；都不行就静静放弃（会话本身已建好）
      }
    }
  } catch {
    // attach 失败不阻断交接：会话已创建，不影响交接本身，只影响侧栏可见性
  }
}

/** 从某个来源（requestHeader.config / AgentOptions / 部署默认）取出一条可用的模型路由。 */
function routeOf(source) {
  if (source === undefined || source === null) return undefined
  const provider = typeof source.provider === 'string' ? source.provider.trim() : ''
  const model = typeof source.model === 'string' ? source.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const route = { provider, model }
  if (typeof source.reasoningEffort === 'string' && source.reasoningEffort.trim() !== '') {
    route.reasoningEffort = source.reasoningEffort
  }
  return route
}

/**
 * 新会话必须自带模型路由。
 *
 * 宿主 `AgentLoop.prepareRequest()` 用 `AgentOptions.provider/model` 做 `agent/request`
 * waterfall 的种子；两个都空就直接抛
 * `agent "<id>" has no provider/model: set AgentOptions.provider and AgentOptions.model`，
 * 界面上表现为「本轮运行失败」—— 而这一步发生在建会话成功之后，所以只看到红字，
 * 看不到任何交接内容。（2026-11-11 事故：交接出的新会话一点就报这个。）
 *
 * 解析顺序：
 *   1. 源会话最近一次实际请求用的路由（用户在会话里换过模型时，这个才是准的）
 *   2. 源 agent 创建时的 AgentOptions
 *   3. 部署默认模型 —— 界面里「新建会话」走的也是这条（api-session-controller.agentOptions）
 *
 * @returns {{provider:string, model:string, reasoningEffort?:string}|undefined}
 */
export function resolveAgentOptions(ctx, agent) {
  try {
    const config = agent?.session?.requestHeader?.()?.config
    const fromHeader = routeOf(config)
    if (fromHeader !== undefined) return fromHeader
  } catch {
    // requestHeader 抛就继续退
  }
  try {
    const fromOptions = routeOf(agent?.options)
    if (fromOptions !== undefined) return fromOptions
  } catch {
    // 继续退
  }
  try {
    const defaults = resolve(ctx, 'agentDefaultModel')
    const current = typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : undefined
    const fromDefaults = routeOf(current)
    if (fromDefaults !== undefined) return fromDefaults
  } catch {
    // 继续退
  }
  return undefined
}

/** 解析当前会话所属项目根：优先 workingDirectory，再退 agent.session.header.cwd，
 *  最后退会话持久化的 header.cwd（sessionQuery.observeSession —— 与宿主
 *  api-session-controller 同源，后台/非激活会话也能取到）。 */
export async function resolveProjectRoot(ctx, agent, sessionId) {
  try {
    const workingDirectory = resolve(ctx, 'workingDirectory')
    if (typeof workingDirectory?.get === 'function') {
      // 宿主的参数是 session 对象；会话 id 字符串在部分宿主上也接受，两种都试。
      const candidates = [agent?.session, agent?.session?.id, agent?.id].filter((value) => value !== undefined)
      for (const candidate of candidates) {
        const dir = workingDirectory.get(candidate)
        if (typeof dir === 'string' && dir.trim() !== '') return dir
      }
    }
  } catch {
    // 继续退
  }
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') return cwd
  // 会话不在本进程激活时（agent 拿不到或没有 header.cwd），从会话持久化数据兜底：
  // sessionQuery.observeSession 返回的 header.cwd 与激活 session.header.cwd 同源。
  if (typeof sessionId === 'string' && sessionId.trim() !== '') {
    try {
      const observation = await readSessionObservation(ctx, sessionId)
      const persistedCwd = observation?.header?.cwd
      if (typeof persistedCwd === 'string' && persistedCwd.trim() !== '') return persistedCwd
    } catch {
      // 兜底失败就算了，返回 undefined 由上层提示「无法确定项目」
    }
  }
  return undefined
}

/**
 * 源会话标题（有就带进交接文档，便于溯源）。
 *
 * v0.2.0 修：这里以前调 `sessionTitle.current(session)` —— 宿主的 SessionTitleService
 * 根本没有 `current` 方法（它只有 get / rename / refresh），所以标题**永远是
 * undefined**，交接文档里那一行一直是空的。现在走 `get(session)`，返回值可能是
 * 字符串，也可能是 `{ title, source }` 快照（两种都吃）。
 */
export function sessionTitleOf(ctx, agent) {
  try {
    const titles = resolve(ctx, 'sessionTitle')
    const session = agent?.session
    if (session === undefined || typeof titles?.get !== 'function') return undefined
    return titleTextOf(titles.get(session))
  } catch {
    // 没有标题服务就算了
  }
  return undefined
}

/** 组装交接文档所需的事实。 */
export async function collectHandoffInput(ctx, { sessionId, agent, projectRoot, recentTurnCount = 3 }) {
  const events = (await readEvents(ctx, sessionId)) ?? []
  const names = projectRoot === undefined ? {} : await readNames(projectRoot)
  return {
    projectRoot: projectRoot ?? '',
    title: sessionTitleOf(ctx, agent) ?? '',
    sourceSessionId: sessionId,
    busName: nameOf(names, sessionId) ?? '',
    todos: todosFromEvents(events),
    summaryLines: digestSummary(latestCompactionSummary(events)),
    recent: recentTurns(events, recentTurnCount),
    // 下面三项是「文档不空」的保险：待办（tool-todo）和摘要（compaction）
    // 在本机默认都没启用，只有原始要求与工具轨迹一定存在。
    requests: userRequests(events, { limit: 3 }),
    toolTrail: toolTrail(events),
    turnCount: countTurns(events),
    eventCount: events.length,
  }
}

/**
 * 把交接文档推进新会话并唤醒它。
 * 失败不抛：返回 { ok, detail }，由调用方决定怎么提示。
 */
export async function seedAndWake(ctx, { sessionId, text, name }) {
  const agents = resolve(ctx, 'agents')
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  if (agent === undefined) return { ok: false, detail: '新会话未在本进程激活，文档已写入但未唤醒' }
  try {
    const message = {
      id: `bridge-${Date.now().toString(36)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', origin: 'dsh-context-bridge', ...(name === undefined ? {} : { fromName: name }) },
    }
    if (typeof agent.followup === 'function') agent.followup(message)
    else if (typeof agent.send === 'function') agent.send(message, 'next-turn', true)
    else return { ok: false, detail: '目标 agent 没有 followup/send，无法投递交接文档' }
    return { ok: true, detail: '交接文档已作为下一轮投入，目标会话已被唤醒' }
  } catch (error) {
    return { ok: false, detail: `投递交接文档失败：${String(error)}` }
  }
}

/**
 * 把新会话登记进项目名册（会话总线）。
 *
 * 走的是与总线 dsh_bus_register 工具同一份写入（registry/names.js 的
 * writeName：写 `<project>/.dsh-bus/names.json`，原子 tmp+rename）。
 *
 * 命名规则（验收要求）：
 *   1. 源会话在侧边栏被**手动命名**过 → 新会话直接用**这个名字本身**注册：
 *      先把源会话的登记摘掉（名称转移，避免同名双 owner 让 `dsh_bus_send` 歧义），
 *      再登记给新会话；
 *   2. 没有手动名字 → 回退成**新会话自己的 id（UUID）**，注册照常；
 *   3. 手动名字已被**别的**会话占用（用户给两个会话起了同名）→ 退让成 `<名>-2`，
 *      绝不覆盖别人的登记。
 *
 * @returns {Promise<{ok:boolean, name?:string, detail:string}>}
 */
export async function registerBusName({ projectRoot, oldSessionId, newSessionId, manualName }) {
  const manual = typeof manualName === 'string' ? manualName.trim() : ''
  try {
    let names = await readNames(projectRoot)
    const oldName = nameOf(names, oldSessionId)
    if (manual !== '' && oldName !== undefined && oldName === manual) {
      // 名称转移：先摘掉旧会话，让这个名字空出来（否则 pickFreeName 会加 -2）
      names = await writeName(projectRoot, oldSessionId, '')
    }
    const name = pickFreeName({
      index: nameIndex(names),
      base: manual !== '' ? manual : newSessionId,
      sessionId: newSessionId,
    })
    if (name === '') throw new Error('无法为新会话生成注册名')
    await writeName(projectRoot, newSessionId, name)
    return {
      ok: true,
      name,
      detail: manual !== ''
        ? `已在会话总线用侧边栏名「${name}」登记新会话`
        : `侧边栏未手动命名，已在会话总线用会话 id「${name}」登记`,
    }
  } catch (error) {
    return { ok: false, detail: `总线登记失败：${String(error)}` }
  }
}

/**
 * 把旧会话从活跃列表里摘掉（宿主侧「归档」= 隐藏，不是删文件）。
 *
 * 宿主 `workspaceRegistry.archiveSession(id)`：写入 archivedSessionIds，
 * 侧栏所有分组表面都不再列出它（侧栏「全部会话 — 显示已归档」里还能找回）。
 * 会话还有活（正在跑一轮）时它会抛 WorkspaceActiveSessionError —— 交接本来
 * 就该让旧会话停下来，所以第二次带 `{ stopActivity: true }` 重试，由宿主
 * 通知各 provider（agent 取消本轮、jobs 杀子进程）停掉它。
 *
 * 为什么要 archive 而不是只写归档文件：会话文件仍在磁盘、仍会被 resume，
 * 光有 JSON 归档并不能让「旧会话不出现在活跃列表」成立。
 */
export async function archiveOldSession(ctx, sessionId) {
  const registry = resolve(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.archiveSession !== 'function') {
    return { ok: false, detail: '宿主未提供 workspaceRegistry.archiveSession，旧会话未从活跃列表移除' }
  }
  try {
    await registry.archiveSession(sessionId)
    return { ok: true, detail: '旧会话已从活跃列表归档' }
  } catch {
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
      return { ok: true, detail: '旧会话已归档，并已通知各 provider 停止它的活动' }
    } catch (error) {
      return { ok: false, detail: `旧会话归档失败（归档文件仍在，可用它恢复）：${String(error)}` }
    }
  }
}

/**
 * 执行一次交接：**归档旧上下文 → 建会话 → 登记总线 → 推文档 → 藏起旧会话**。
 *
 * 顺序为什么是这个顺序（每步的失败处理都由它决定）：
 *   1. **归档先做**。归档是这次交接唯一的不可逆副作用里最便宜、最可验证的一步；
 *      它失败（磁盘拒写、目录不可用、上下文不可序列化）就整体中止 ——
 *      不建新会话、不登记总线、旧会话原样继续跑（验收要求 4）。
 *   2. 归档成功后建新会话。建会话失败时归档文件保留（旧上下文没丢，可以人工恢复）。
 *   3. 总线登记用**侧边栏手动名**，没有就回退新会话 id（UUID）。
 *   4. 交接文档走 followup 投递（不能当 seed：surface 首家必须留给 system/message）。
 *   5. 最后把旧会话从活跃列表归档（workspaceRegistry.archiveSession），
 *      失败只记 detail，不回滚 —— 新会话已经带着交接文档跑起来了，
 *      为了「侧栏少一行」把它回滚掉才是真正的数据损失。
 *
 * @param {object} ctx 宿主 context
 * @param {object} input
 * @param {string} input.sourceSessionId 源会话
 * @param {object} [input.agent] 源 agent（拿标题/项目根/模型路由用）
 * @param {string} [input.projectRoot] 已解析好的项目根
 * @param {object} [input.config] 项目配置
 * @param {Function} [input.randomUUID] 便于测试注入
 * @returns {Promise<{ok:boolean, sessionId?:string, name?:string, text?:string, detail:string,
 *   aborted?:boolean, abortReason?:string, archiveFile?:string, archivedOldSession?:boolean}>}
 */
export async function runHandoff(ctx, input) {
  const { sourceSessionId, agent, config = {}, randomUUID } = input
  const projectRoot = input.projectRoot ?? (await resolveProjectRoot(ctx, agent, sourceSessionId))
  if (projectRoot === undefined) {
    return { ok: false, detail: '无法确定源会话所属项目，交接中止' }
  }

  const facts = await collectHandoffInput(ctx, {
    sessionId: sourceSessionId,
    agent,
    projectRoot,
    recentTurnCount: config.recentTurns ?? 3,
  })

  // ── 1) 归档旧上下文（失败 = 整体中止）──────────────────────────────
  const snapshot = await readSessionSnapshot(ctx, sourceSessionId)
  let archive
  try {
    archive = await writeContextArchive({
      projectRoot,
      archiveDir: config.archiveDir,
      sessionId: sourceSessionId,
      title: facts.title,
      context: snapshot,
    })
  } catch (error) {
    return {
      ok: false,
      aborted: true,
      abortReason: 'archive',
      detail: `旧上下文归档失败，交接已中止（未建新会话、未登记总线，原会话继续运行）：${String(error)}`,
    }
  }

  // 文档必须带着归档路径一起生成：没有这句，归档文件对新会话就是不可见的
  // （它只看得到 followup 投进来的这一段文字）。所以 buildHandoff 排在归档之后。
  const text = buildHandoff({
    ...facts,
    todoLimit: config.todoLimit ?? 12,
    archivePath: archive.file,
    eventCount: archive.eventCount,
  })

  const agents = resolve(ctx, 'agents')
  if (agents === undefined || typeof agents.create !== 'function') {
    return { ok: false, archiveFile: archive.file, detail: '宿主未提供 agents.create，无法新建会话（旧上下文已归档）' }
  }

  // 会话文件同步落盘（持久化在 create 内部完成）；
  // 这里再套一层 try，任何宿主侧异常都转成可读的失败结果，不让插件把宿主事件链带崩。
  // 新会话必须自带模型路由，否则第一轮开跑就报 has no provider/model（详见 resolveAgentOptions）。
  const route = resolveAgentOptions(ctx, agent)
  const id = makeSessionId(randomUUID ?? (() => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}`))
  const cwd = facts.projectRoot
  try {
    // 不带 seed：seed 里的 user/message 会占据 surface 首家（见文件头说明），
    // 建出来的会话第一次跑模型就变成读不回来的日志。交接文档一律走下面的 followup。
    await agents.create({
      sessionId: id,
      ...(route === undefined ? {} : { agentOptions: route }),
      meta: { cwd, parentSession: sourceSessionId },
    })
  } catch (error) {
    return {
      ok: false,
      archiveFile: archive.file,
      detail: `新建会话失败：${String(error)}（旧上下文已归档：${archive.file}）`,
    }
  }

  // 新会话建好了，但宿主只在「走 session-controller 的常规创建路径」时才会把会话
  // attach 进 workspace（侧栏项目区据此显示）。我们走的是 agents.create，宿主不会
  // 自动挂载，所以这里手动 attach —— 否则会话在磁盘上存在、也有内容，侧栏却找不到。
  await attachToWorkspace(ctx, id, projectRoot)

  // ── 2) 总线登记：侧边栏手动名（没有就回退 UUID）──────────────────────
  const manualName = await readManualSessionName(ctx, { sessionId: sourceSessionId, agent })
  const registered = await registerBusName({
    projectRoot,
    oldSessionId: sourceSessionId,
    newSessionId: id,
    manualName,
  })

  // ── 3) 投递交接文档 ────────────────────────────────────────────────
  const seeded = await seedAndWake(ctx, { sessionId: id, text, name: registered.name ?? manualName })

  // ── 4) 旧会话不再出现在活跃列表 ────────────────────────────────────
  const hidden = await archiveOldSession(ctx, sourceSessionId)

  return {
    ok: true,
    sessionId: id,
    ...(registered.name === undefined ? {} : { name: registered.name }),
    ...(manualName === undefined ? {} : { manualName }),
    archiveFile: archive.file,
    archiveBytes: archive.bytes,
    archivedOldSession: hidden.ok,
    text,
    detail: [
      seeded.detail,
      registered.detail,
      hidden.detail,
      `旧上下文已归档：${archive.file}（${archive.bytes} 字节，${archive.eventCount} 条事件）`,
      route === undefined
        ? '⚠ 没有解析到模型路由：新会话需要先在界面里选一个模型再发消息，否则宿主会报 has no provider/model'
        : `模型：${route.provider}/${route.model}`,
    ]
      .filter((line) => line !== '')
      .join('；'),
  }
}
