/**
 * 自动交接 —— 「跑到 15 轮就强制交接」的执行器。
 *
 * 监听点只有一个：宿主的 `session/event`，且只认 `turn/end`。
 *   · 为什么不是 `turn/start`：turn 刚开始就把会话掐掉，这一轮用户刚发的消息
 *     会永远得不到回答。等这一轮收尾（turn/end）再交接，语义是「这一轮跑完了，
 *     接着换一个新会话继续」。
 *   · 为什么数 turn 号而不是数消息/数 token：宿主自己维护 turn 序号（AgentLoop
 *     `session.append("turn/start", {turn})`），取最大值就是轮数，
 *     不需要在本插件里维护任何计数器状态 —— 少一个状态就少一种漂移。
 *
 * 「改阈值不用重启」的实现方式：**每次判断前重新 readProjectConfig**，
 * 插件里没有任何配置缓存。所以用户在会话中途把 handoffRounds 从 15 改成 20，
 * 下一轮 turn/end 就按 20 判断。
 *
 * 防重试风暴：同一个会话**同一个轮次只尝试一次**（lastAttempt 记 round）。
 * 归档失败时交接中止、原会话继续跑，不会在每一轮都撞同一个磁盘错误。
 */

import { readProjectConfig } from './project-config.js'
import { resolveProjectRoot, runHandoff } from './handoff-host.js'
import { resolve } from './ctx-services.js'
import { countTurns, shouldAutoHandoff } from './rounds.js'

/** 触发日志里必须出现的字样（验收：日志中可见 handoff triggered at round N）。 */
export function triggerMessage(rounds, threshold, sessionId) {
  return `[dsh-context-bridge] handoff triggered at round ${rounds} (threshold ${threshold}, session ${sessionId})`
}

function eventsOf(session) {
  try {
    const snapshot = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
    if (Array.isArray(snapshot)) return snapshot
  } catch {
    // 拿不到就退到 sessionQuery
  }
  return []
}

/** 项目根：活 agent 优先，其次 session 自带的 header，最后宿主 cwd 兜底。 */
async function projectRootFor(ctx, { sessionId, agent, session }) {
  if (agent !== undefined) {
    try {
      const root = await resolveProjectRoot(ctx, agent, sessionId)
      if (root !== undefined) return root
    } catch {
      // 继续退
    }
  }
  if (session !== undefined) {
    try {
      const root = await resolveProjectRoot(ctx, { session }, sessionId)
      if (root !== undefined) return root
    } catch {
      // 继续退
    }
  }
  for (const key of ['cwd', 'defaultCwd']) {
    const value = resolve(ctx, key)
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/** 当前轮次：内存快照优先，其次从会话日志 fold（后台/刚恢复的会话也能算）。 */
async function roundsFor(ctx, { sessionId, session }) {
  const fromSession = countTurns(eventsOf(session))
  if (fromSession > 0) return fromSession
  const query = resolve(ctx, 'sessionQuery')
  if (query !== undefined && typeof query.readSession === 'function') {
    try {
      const read = await query.readSession(sessionId)
      const rounds = countTurns(read?.events)
      if (rounds > 0) return rounds
    } catch {
      // 继续退
    }
  }
  if (query !== undefined && typeof query.observeSession === 'function') {
    try {
      const observation = await query.observeSession(sessionId)
      try {
        return countTurns(observation?.events)
      } finally {
        if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]()
      }
    } catch {
      return 0
    }
  }
  return 0
}

/**
 * 造一个自动交接执行器。
 *
 * @param {object} input
 * @param {object} input.ctx 宿主 context
 * @param {object} [input.logger]
 * @param {Set<string>} [input.inFlight] 与手动路径共用的「正在交接」集合
 * @param {Function} [input.randomUUID] 测试注入
 */
export function createAutoHandoff({ ctx, logger, inFlight, randomUUID }) {
  /** sessionId → 已经尝试过交接的轮次 */
  const lastAttempt = new Map()

  async function check(session) {
    const sessionId = typeof session?.id === 'string' ? session.id : ''
    if (sessionId === '') return undefined
    if (inFlight !== undefined && inFlight.has(sessionId)) return undefined
    try {
      const agent = resolve(ctx, 'agents')?.get?.(sessionId)
      const projectRoot = await projectRootFor(ctx, { sessionId, agent, session })
      if (projectRoot === undefined) return undefined
      // 每次重读：配置改了下一轮就按新值走（无需重启）
      const config = await readProjectConfig(projectRoot)
      const rounds = await roundsFor(ctx, { sessionId, session })
      if (rounds <= 0) return undefined
      if (!shouldAutoHandoff({ config, rounds })) return undefined
      if (lastAttempt.get(sessionId) === rounds) return undefined
      lastAttempt.set(sessionId, rounds)
      logger?.info?.(triggerMessage(rounds, config.handoffRounds, sessionId))
      if (inFlight !== undefined) inFlight.add(sessionId)
      try {
        const result = await runHandoff(ctx, {
          sourceSessionId: sessionId,
          agent,
          projectRoot,
          config,
          randomUUID,
        })
        if (result.ok) {
          lastAttempt.delete(sessionId)
          logger?.info?.(
            `[dsh-context-bridge] auto handoff done: ${sessionId} -> ${result.sessionId}` +
              (result.name === undefined ? '' : `（总线名「${result.name}」）`) +
              `；归档 ${result.archiveFile}`,
          )
        } else {
          logger?.warn?.(`[dsh-context-bridge] auto handoff aborted: ${result.detail}`)
        }
        return result
      } finally {
        if (inFlight !== undefined) inFlight.delete(sessionId)
      }
    } catch (error) {
      logger?.warn?.(`[dsh-context-bridge] auto handoff error: ${String(error)}`)
      return undefined
    }
  }

  function onSessionEvent(session, event) {
    // 只在一轮收尾时判断：turn 中途交接会把用户刚发的这轮回答丢掉
    if (event?.type !== 'turn/end') return
    // 不 await：宿主事件链是同步派发，这里只负责起头，异常已在 check 内部吞掉
    void check(session)
  }

  /** 挂上 session/event 监听，返回 disposer。 */
  function listen() {
    if (typeof ctx?.on !== 'function') return () => {}
    const dispose = ctx.on('session/event', onSessionEvent)
    return typeof dispose === 'function' ? dispose : () => {}
  }

  return { check, onSessionEvent, listen, lastAttempt }
}
