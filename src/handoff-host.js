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
 *   3. 用宿主自己的 user/message 形状做种子（session 只要求 id/role/source/content）
 *   4. `agents.create({ sessionId, seed, inheritedEventCount, meta })` 建新会话
 *   5. （可选）给新会话起一个继承自总线的名字
 *   6. 把交接文档作为**第一轮用户消息**推进去，唤醒它继续干活
 */

import { readNames, nameIndex, nameOf, pickInheritedName, writeName } from './bus-names.js'
import { buildHandoff, digestSummary, latestCompactionSummary, recentTurns, todosFromEvents } from './handoff.js'

const SESSION_SEQ_BASE = 0

/** 生成一个 session id（与宿主同款前缀，避免 UI 认不出）。 */
export function makeSessionId(randomUUID) {
  return `session-${randomUUID()}`
}

/**
 * 构造一条最小的 `user/message` 事件。
 * 宿主的校验只要：id 非空、role "user"、source.kind 非空、content 是数组。
 */
export function makeHandoffEvent({ text, seq = SESSION_SEQ_BASE, time = Date.now(), name }) {
  const id = `handoff-${time.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'user',
        origin: 'dsh-context-bridge',
        from: 'dsh-context-bridge',
        ...(typeof name === 'string' && name !== '' ? { fromName: name } : {}),
      },
    },
    surfaceOp: 'append',
  }
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

function resolve(ctx, name) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== undefined) return viaGet
  } catch {
    // ctx.get 在个别宿主上会抛，继续走属性兜底
  }
  try {
    return ctx?.[name]
  } catch {
    return undefined
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

/** 源会话标题（有就带进交接文档，便于溯源）。 */
export function sessionTitleOf(ctx, agent) {
  try {
    const titles = resolve(ctx, 'sessionTitle')
    const value = typeof titles?.current === 'function' ? titles.current(agent.session) : undefined
    if (typeof value === 'string') return value
    if (value !== null && typeof value === 'object' && typeof value.title === 'string') return value.title
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
 * 把新会话登记进项目名册。
 *
 * 走的是与总线 dsh_bus_register 工具同一份写入（registry/names.js 的
 * writeName：写 `<project>/.dsh-bus/names.json`，原子 tmp+rename）。
 * 之前从这里 resolve('dshSessionSend').registerName —— 但总线插件从不暴露
 * 那个服务/方法（它只把 dsh_bus_register 注册成模型工具，底层就是写文件），
 * 所以那条链路永远是断的。现在直接读/写同一份名册，总线和交接互相可见。
 */
export async function registerBaseName(ctx, { projectRoot, sessionId, name }) {
  try {
    await writeName(projectRoot, sessionId, name)
    return { ok: true, detail: `已在会话总线登记名「${name}」` }
  } catch (error) {
    return { ok: false, detail: `总线登记失败：${String(error)}` }
  }
}

/**
 * 执行一次交接：建会话 → 起名 → 推文档。
 *
 * 只由「人点了按钮」那条路径调用（HTTP /run），没有别的调用者。
 *
 * @param {object} ctx 宿主 context
 * @param {object} input
 * @param {string} input.sourceSessionId 源会话
 * @param {object} [input.agent] 源 agent（拿标题/项目根用）
 * @param {string} [input.projectRoot] 已解析好的项目根
 * @param {object} [input.config] 项目配置
 * @param {Function} [input.randomUUID] 便于测试注入
 * @returns {Promise<{ok:boolean, sessionId?:string, name?:string, text?:string, detail:string}>}
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
  const text = buildHandoff({ ...facts, todoLimit: config.todoLimit ?? 12 })

  const agents = resolve(ctx, 'agents')
  if (agents === undefined || typeof agents.create !== 'function') {
    return { ok: false, detail: '宿主未提供 agents.create，无法新建会话' }
  }

  // 会话文件同步落盘（宿主的 seed 走的是 append，持久化在 create 内部完成）；
  // 这里再套一层 try，任何宿主侧异常都转成可读的失败结果，不让插件把宿主事件链带崩。
  // 新会话必须自带模型路由，否则第一轮开跑就报 has no provider/model（详见 resolveAgentOptions）。
  const route = resolveAgentOptions(ctx, agent)
  const id = makeSessionId(randomUUID ?? (() => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}`))
  const event = makeHandoffEvent({ text, name: facts.busName })
  const cwd = facts.projectRoot
  try {
    await agents.create({
      sessionId: id,
      ...(route === undefined ? {} : { agentOptions: route }),
      seed: [event],
      inheritedEventCount: 1,
      meta: { cwd, parentSession: sourceSessionId, isSeeded: true },
    })
  } catch (error) {
    return { ok: false, detail: `新建会话失败：${String(error)}` }
  }

  // 新会话建好了，但宿主只在「走 session-controller 的常规创建路径」时才会把会话
  // attach 进 workspace（侧栏项目区据此显示）。我们走的是 agents.create，宿主不会
  // 自动挂载，所以这里手动 attach —— 否则会话在磁盘上存在、也有内容，侧栏却找不到
  //（feature 复现：交接成功但项目区看不到新会话）。
  await attachToWorkspace(ctx, id, projectRoot)

  // 继承总线名（只在源会话本来就有名字时才继承）
  let picked
  let registerDetail = ''
  if (facts.busName !== '') {
    const names = await readNames(facts.projectRoot)
    picked = pickInheritedName({ index: nameIndex(names), base: facts.busName, sessionId: id })
    const registered = await registerBaseName(ctx, { projectRoot: facts.projectRoot, sessionId: id, name: picked })
    registerDetail = registered.detail
  }

  const seeded = await seedAndWake(ctx, { sessionId: id, text, name: picked ?? facts.busName })
  return {
    ok: true,
    sessionId: id,
    ...(picked === undefined ? {} : { name: picked }),
    text,
    detail: [
      seeded.detail,
      registerDetail,
      route === undefined
        ? '⚠ 没有解析到模型路由：新会话需要先在界面里选一个模型再发消息，否则宿主会报 has no provider/model'
        : `模型：${route.provider}/${route.model}`,
    ]
      .filter((line) => line !== '')
      .join('；'),
  }
}
