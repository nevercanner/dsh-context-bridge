/**
 * host 半 —— 自动 + 手动交接。
 *
 * v0.2.0 起有两条触发路径：
 *   · **自动**：监听 `session/event`，会话跑到 `handoffRounds` 轮（默认 15）的
 *     `turn/end` 上强制交接一次（见 auto-handoff.js）。阈值每次判断前重读
 *     `.dsh-bridge.json`，中途改值下一轮就生效，不用重启。
 *   · **手动**：会话行菜单 / 面板按钮 → HTTP /run（人的即时判断，永远保留）。
 *
 * 交接的动作固定为五步：归档旧上下文 → 建新会话 → 登记总线（侧边栏手动名，
 * 没有则回退 UUID）→ 投递交接文档 → 把旧会话从活跃列表归档。
 * 归档写盘失败时整体中止，不建会话、不登记总线，原会话继续跑。
 *
 * 设计约束（来自 2026-11-09 的真实事故，仍然有效）：
 *   1. **不注册任何 DOM 兜底**。dsh-session-send 曾用 DOM 变更观察器扫描
 *      所有 role="menu"，再把自建节点塞进 React 管理的容器 —— React 下一次
 *      渲染抹掉它，观察器再插一次，打开模型菜单就把渲染进程主线程锁死。
 *   2. Client 半只用官方 slot，改动需整机重启才生效（运行中改会 rev 失配）。
 *   3. 宿主服务一律 ctx.get() + try 兜底读取，不做静态 import，
 *      也绝不裸读 ctx.xxx（未声明 inject 时会抛）。
 *   4. 监听只挂在 `session/event` 上，且只在 `turn/end` 之后动作 —— 不在
 *      turn 中途打断，不动宿主的 LLM 流。
 */

import { CONFIG_DEFAULTS, describeConfig, normalizeRoot, readProjectConfig } from './project-config.js'
import { runHandoff, resolveProjectRoot } from './handoff-host.js'
import { readNames, nameOf, namesPathFor } from './bus-names.js'
import { createAutoHandoff } from './auto-handoff.js'
import { archiveDirFor } from './archive.js'
import { countTurns } from './rounds.js'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-context-bridge'
export const description =
  '会话交接：会话跑到 15 轮（可配）自动强制交接 —— 旧上下文完整归档、新会话接续、' +
  '并用侧边栏手动名注册到会话总线；也可在会话行菜单里手动触发。'

/** 不需要任何必需服务；其余全部 ctx.get 兜底。 */
export const inject = []

function get(ctx, key) {
  try {
    const value = typeof ctx?.get === 'function' ? ctx.get(key) : undefined
    if (value !== undefined) return value
  } catch {
    // 继续
  }
  try {
    return ctx?.[key]
  } catch {
    return undefined
  }
}

/** 正在交接的会话，防重复点击。 */
const inFlight = new Set()

async function projectRootOf(ctx, agent, sessionId) {
  if (agent !== undefined) {
    const fromAgent = await resolveProjectRoot(ctx, agent, sessionId)
    if (fromAgent !== undefined) return fromAgent
  }
  // 会话不在本进程激活时（只给了 id），退到宿主 cwd 服务；仍取不到就返回 undefined。
  for (const key of ['cwd', 'defaultCwd']) {
    try {
      const value = get(ctx, key)
      if (typeof value === 'string' && value.trim() !== '') return value
    } catch {
      // 继续
    }
  }
  return undefined
}

/**
 * 手工触发（侧栏菜单 / 面板按钮走这里）。
 * 只有人被点的那一下才调用；没有别的地方会调用它。
 */
async function manualHandoff(ctx, logger, { sessionId, projectRoot }) {
  if (inFlight.has(sessionId)) {
    return { ok: false, detail: '这个会话的交接正在进行中，请稍候' }
  }
  inFlight.add(sessionId)
  try {
    const agents = get(ctx, 'agents')
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    const root = projectRoot ?? (await projectRootOf(ctx, agent, sessionId))
    if (root === undefined) {
      return { ok: false, detail: '无法确定该会话所属项目，交接已取消（没有创建任何东西）' }
    }
    const config = await readProjectConfig(root)
    if (config.enabled !== true) {
      return {
        ok: false,
        detail: `本项目已关闭交接：把 ${root} 下的 .dsh-bridge.json 改成 {"enabled": true}，或直接删掉该文件（删除后默认开启）`,
      }
    }
    const result = await runHandoff(ctx, { sourceSessionId: sessionId, agent, projectRoot: root, config, randomUUID })
    if (result.ok) {
      logger?.info?.(
        `[dsh-context-bridge] 手动交接完成：${sessionId} → ${result.sessionId}` +
          (result.name === undefined ? '' : `（名「${result.name}」）`),
      )
    }
    return result
  } catch (error) {
    logger?.warn?.(`[dsh-context-bridge] 手动交接异常：${String(error)}`)
    return { ok: false, detail: String(error) }
  } finally {
    inFlight.delete(sessionId)
  }
}

// ───────────────────────────── HTTP 路由 ─────────────────────────────

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function sendJson(res, status, body) {
  try {
    res.statusCode = status
    for (const [key, value] of Object.entries(JSON_HEADERS)) res.setHeader(key, value)
    res.end(JSON.stringify(body))
  } catch {
    // 连接已断
  }
}

function rejectionOf(ctx, req) {
  try {
    const connection = get(ctx, 'connection')
    if (connection === undefined) return undefined
    return typeof connection.requestRejection === 'function' ? connection.requestRejection(req) : undefined
  } catch {
    return undefined
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function routesFor(ctx, logger) {
  return [
    {
      method: 'GET',
      path: '/plugins/dsh-context-bridge/status',
      async handler(req, res) {
        const url = new URL(String(req.url ?? '/'), 'http://x')
        const sessionId = url.searchParams.get('session')?.trim() ?? ''
        const rawRoot = url.searchParams.get('project')?.trim() ?? ''
        let projectRoot = rawRoot
        if (projectRoot === '') {
          const agents = get(ctx, 'agents')
          const agent = sessionId === '' ? undefined : agents?.get?.(sessionId)
          projectRoot = (await projectRootOf(ctx, agent, sessionId)) ?? ''
        }
        if (projectRoot === '') {
          const fallback = await projectRootOf(ctx, undefined, sessionId)
          if (fallback !== undefined) projectRoot = fallback
        }
        if (projectRoot === '') return sendJson(res, 200, { enabled: false, status: '无法确定项目根', sessionId })
        const config = await readProjectConfig(projectRoot)
        const names = await readNames(projectRoot)
        const busName = sessionId === '' ? undefined : nameOf(names, sessionId)
        // 当前轮次：读活会话的内存快照；读不到就给 null（界面显示「—」，别拿假的 0 骗人）
        let rounds = null
        if (sessionId !== '') {
          try {
            const liveAgent = get(ctx, 'agents')?.get?.(sessionId)
            const snapshot =
              typeof liveAgent?.session?.snapshotEvents === 'function' ? liveAgent.session.snapshotEvents() : undefined
            const counted = countTurns(Array.isArray(snapshot) ? snapshot : [])
            if (counted > 0) rounds = counted
          } catch {
            // 状态面板不该因为这个 500
          }
        }
        return sendJson(res, 200, {
          enabled: config.enabled === true,
          status: describeConfig(config),
          mode: config.autoHandoff === true ? 'auto+manual' : 'manual',
          projectRoot,
          projectName: projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? '',
          todoLimit: config.todoLimit,
          recentTurns: config.recentTurns,
          autoHandoff: config.autoHandoff === true,
          handoffRounds: config.handoffRounds,
          archiveDir: config.archiveDir,
          archiveDirPath: archiveDirFor(projectRoot, config.archiveDir),
          rounds,
          busName: busName ?? null,
          namesPath: namesPathFor(projectRoot),
          sessionId,
        })
      },
    },
    {
      method: 'POST',
      path: '/plugins/dsh-context-bridge/run',
      async handler(req, res) {
        const body = await readBody(req)
        const sessionId = typeof body.session === 'string' ? body.session.trim() : ''
        if (sessionId === '') return sendJson(res, 400, { error: { code: 'E_SESSION', message: '缺少 session' } })
        let root
        if (typeof body.project === 'string' && body.project.trim() !== '') {
          try {
            root = normalizeRoot(body.project)
          } catch (error) {
            return sendJson(res, 400, { error: { code: 'E_PROJECT', message: String(error) } })
          }
        }
        const result = await manualHandoff(ctx, logger, { sessionId, projectRoot: root })
        return sendJson(res, result.ok ? 200 : 500, result)
      },
    },
  ]
}

/**
 * 插件入口。挂两条 HTTP 路由，别的什么都不做 —— 没有事件监听。
 *
 * @param ctx 宿主 context
 * @param rawConfig 组合文件里的 config
 */
export function apply(ctx, rawConfig = {}) {
  const logger = get(ctx, 'logger')
  const config = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  if (config.enabled === false) {
    logger?.debug?.('[dsh-context-bridge] 组合层 enabled=false（项目开关以 .dsh-bridge.json 为准）')
  }

  const disposers = []
  try {
    ctx.inject?.(['webServer'], () => {
      const webServer = get(ctx, 'webServer') ?? get(ctx, 'httpServer')
      if (webServer === undefined || typeof webServer.register !== 'function') {
        logger?.warn?.('[dsh-context-bridge] 宿主没有 webServer，侧栏入口将无法读取状态')
        return
      }
      for (const route of routesFor(ctx, logger)) {
        try {
          const dispose = webServer.register({
            kind: 'exact',
            path: route.path,
            handler: async (req, res) => {
              const rejection = rejectionOf(ctx, req)
              if (rejection !== undefined) {
                return sendJson(res, rejection, { error: { code: 'E_AUTH', message: 'unauthorized' } })
              }
              if (String(req.method ?? 'GET').toUpperCase() !== route.method) {
                return sendJson(res, 405, { error: { code: 'E_METHOD', message: `${route.method} only` } })
              }
              try {
                await route.handler(req, res)
              } catch (error) {
                sendJson(res, 500, { error: { code: 'E_INTERNAL', message: String(error) } })
              }
            },
          })
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (error) {
          logger?.warn?.(`[dsh-context-bridge] 注册路由 ${route.path} 失败：${String(error)}`)
        }
      }
    })
  } catch (error) {
    logger?.warn?.(`[dsh-context-bridge] webServer 注入失败：${String(error)}`)
  }

  // 自动交接：唯一一个事件监听，只认 session/event 的 turn/end
  const auto = createAutoHandoff({ ctx, logger, inFlight, randomUUID })
  try {
    const dispose = auto.listen()
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (error) {
    logger?.warn?.(`[dsh-context-bridge] 自动交接监听注册失败：${String(error)}`)
  }

  ctx.effect?.(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 忽略卸载异常
      }
    }
    auto.lastAttempt.clear()
    inFlight.clear()
  }, 'dsh-context-bridge: lifetime')

  logger?.info?.(
    `[dsh-context-bridge] 已装载（自动交接阈值 ${CONFIG_DEFAULTS.handoffRounds} 轮，以 .dsh-bridge.json 的 handoffRounds 为准；手动触发保留）`,
  )
}
