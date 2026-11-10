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

import { readNames, nameIndex, nameOf, pickInheritedName, namesPathFor } from './bus-names.js'
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

/** 读一个会话的完整事件（只读）。宿主没有 sessionQuery 时返回 undefined。 */
export async function readEvents(ctx, sessionId) {
  const query = resolve(ctx, 'sessionQuery')
  if (query === undefined || typeof query.observeSession !== 'function') return undefined
  const observation = await query.observeSession(sessionId)
  if (observation === undefined || observation === null) return undefined
  try {
    return Array.isArray(observation.events) ? observation.events : undefined
  } finally {
    // observation 是租约，用完必须释放；没有 dispose 就跳过（只读观察不持有资源）
    if (typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose]()
  }
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

/** 解析当前会话所属项目根：优先 workingDirectory，再退 agent.session.header.cwd。 */
export function resolveProjectRoot(ctx, agent) {
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
 * 写总线名册（只有总线在场、且它暴露了注册入口时才写）。
 * 找不到入口就返回 { ok:false }，绝不自己写 names.json —— 名册只有一个主人。
 */
export async function registerBaseName(ctx, { projectRoot, sessionId, name }) {
  const bus = resolve(ctx, 'dshSessionSend')
  const register = bus?.registerName?.bind?.(bus)
  if (typeof register === 'function') {
    try {
      await register({ projectRoot, sessionId, name })
      return { ok: true, detail: `已在会话总线登记名「${name}」` }
    } catch (error) {
      return { ok: false, detail: `总线登记失败：${String(error)}` }
    }
  }
  return { ok: false, detail: `会话总线未提供登记入口，名「${name}」未写入（名册：${namesPathFor(projectRoot)}）` }
}

/**
 * 执行一次交接：建会话 → 起名 → 推文档。
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
  const projectRoot = input.projectRoot ?? resolveProjectRoot(ctx, agent)
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
  const id = makeSessionId(randomUUID ?? (() => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}`))
  const event = makeHandoffEvent({ text, name: facts.busName })
  const cwd = facts.projectRoot
  try {
    await agents.create({
      sessionId: id,
      seed: [event],
      inheritedEventCount: 1,
      meta: { cwd, parentSession: sourceSessionId, isSeeded: true },
    })
  } catch (error) {
    return { ok: false, detail: `新建会话失败：${String(error)}` }
  }

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
    detail: [seeded.detail, registerDetail].filter((line) => line !== '').join('；'),
  }
}
