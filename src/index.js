/**
 * host 半 —— 挂载点、HTTP 路由、自动触发。
 *
 * 设计约束（来自 2026-11-09 的真实事故）：
 *   1. **不注册任何 DOM 兜底**。上一版 dsh-session-send 之所以把「切换模型」
 *      搞成主线程死锁，是因为它用 MutationObserver 扫描所有 role="menu"，
 *      然后把自建节点 appendChild 进 React 管理的容器 —— React 下一次渲染
 *      抹掉它，observer 再插一次，形成插入/渲染自激。本插件的 Client 半
 *      只用官方 slot，零 MutationObserver、零 appendChild 到 React 容器。
 *   2. **不在运行中改 client 文件**。Client 半的改动必须整机重启才生效，
 *      否则分块 rev 失配 → web boot failed。
 *   3. 所有宿主服务都用 ctx.get() + try 兜底读取，不做静态 import，
 *      也绝不裸读 ctx.xxx（未声明 inject 时会抛）。
 */

import { describeConfig, normalizeRoot, readProjectConfig } from './project-config.js'
import { runHandoff, resolveProjectRoot } from './handoff-host.js'
import { readNames, nameOf, namesPathFor } from './bus-names.js'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-context-bridge'
export const description =
  '会话交接：把项目事实、上下文摘要与待办压成一份交接文档，自动开新会话并把文档作为第一轮投入，' +
  '新会话可继承会话总线的注册名。默认关闭，按项目在 .dsh-bridge.json 里开启。'

/** 只需要 tools 与 webServer 可选；其余全部 ctx.get 兜底。 */
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

/** 每个会话的自动交接节流状态：最后触发时间。 */
const lastRunAt = new Map()
/** 正在交接的会话，防重入。 */
const inFlight = new Set()

function limitOf(ctx) {
  const limit = get(ctx, 'tokenMeter')
  return typeof limit?.measure === 'function' ? limit : undefined
}

function totalTokens(ctx, agent) {
  const meter = limitOf(ctx)
  if (meter === undefined) return 0
  try {
    const measured = meter.measure(agent.session)
    return typeof measured?.totalTokens === 'number' ? measured.totalTokens : 0
  } catch {
    return 0
  }
}

async function projectRootOf(ctx, agent) {
  if (agent !== undefined) {
    const fromAgent = resolveProjectRoot(ctx, agent)
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
 * 自动触发：在 `agent/turn-stopping` 时看一次上下文用量。
 *
 * 为什么是 turn-stopping 而不是 pre-step：交接要在**一轮结束后**做，
 * 否则会把半截工作当成结论写进文档，而且新会话会被同一轮的后续 step 干扰。
 */
async function maybeAutoHandoff(ctx, agent, logger) {
  const sessionId = agent?.session?.id ?? agent?.id
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (inFlight.has(sessionId)) return

  const projectRoot = await projectRootOf(ctx, agent)
  if (projectRoot === undefined) return
  const config = await readProjectConfig(projectRoot)
  if (config.enabled !== true) return

  const total = totalTokens(ctx, agent)
  if (total < config.thresholdTokens) return

  const previous = lastRunAt.get(sessionId) ?? 0
  if (Date.now() - previous < config.minIntervalMs) {
    logger?.info?.(`[dsh-context-bridge] ${sessionId} 到达阈值但仍在节流窗口内，跳过`)
    return
  }

  inFlight.add(sessionId)
  try {
    const result = await runHandoff(ctx, { sourceSessionId: sessionId, agent, projectRoot, config, randomUUID })
    lastRunAt.set(sessionId, Date.now())
    if (result.ok) {
      logger?.info?.(
        `[dsh-context-bridge] 已为 ${sessionId} 建立交接会话 ${result.sessionId}` +
          (result.name === undefined ? '' : `（名「${result.name}」）`) +
          `：${result.detail}`,
      )
    } else {
      logger?.warn?.(`[dsh-context-bridge] 自动交接失败：${result.detail}`)
    }
  } catch (error) {
    logger?.warn?.(`[dsh-context-bridge] 自动交接异常：${String(error)}`)
  } finally {
    inFlight.delete(sessionId)
  }
}

/** 手工触发（侧栏开关走这里）。 */
async function manualHandoff(ctx, { sessionId, projectRoot }) {
  const agents = get(ctx, 'agents')
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  const root = projectRoot ?? (await projectRootOf(ctx, agent))
  if (root === undefined) throw new Error('无法确定项目根')
  const config = await readProjectConfig(root)
  const result = await runHandoff(ctx, { sourceSessionId: sessionId, agent, projectRoot: root, config, randomUUID })
  return { ...result, ...(result.ok ? {} : { error: result.detail }) }
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
          projectRoot = (agent === undefined ? undefined : await projectRootOf(ctx, agent)) ?? ''
        }
        if (projectRoot === '') {
          const fallback = await projectRootOf(ctx, undefined)
          if (fallback !== undefined) projectRoot = fallback
        }
        if (projectRoot === '') return sendJson(res, 200, { enabled: false, status: '无法确定项目根', sessionId })
        const config = await readProjectConfig(projectRoot)
        const names = await readNames(projectRoot)
        const busName = sessionId === '' ? undefined : nameOf(names, sessionId)
        return sendJson(res, 200, {
          enabled: config.enabled === true,
          status: describeConfig(config),
          projectRoot,
          projectName: projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? '',
          thresholdTokens: config.thresholdTokens,
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
        try {
          const result = await manualHandoff(ctx, { sessionId, projectRoot: root })
          return sendJson(res, result.ok ? 200 : 500, result)
        } catch (error) {
          logger?.warn?.(`[dsh-context-bridge] /run 失败：${String(error)}`)
          return sendJson(res, 500, { ok: false, error: String(error) })
        }
      },
    },
  ]
}

/**
 * 插件入口。
 *
 * @param ctx 宿主 context
 * @param rawConfig 组合文件里的 config（enabled 等；项目级开关以 .dsh-bridge.json 为准）
 */
export function apply(ctx, rawConfig = {}) {
  const logger = get(ctx, 'logger')
  const config = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  if (config.enabled === false) {
    logger?.debug?.('[dsh-context-bridge] 组合层 enabled=false，插件只装载不工作（要工作时在 .dsh-bridge.json 打开）')
  }

  // 自动触发
  const disposers = []
  try {
    const off = ctx.on?.('agent/turn-stopping', (payload) => {
      const agent = payload?.agent
      if (agent === undefined) return
      void maybeAutoHandoff(ctx, agent, logger)
    })
    if (typeof off === 'function') disposers.push(off)
  } catch (error) {
    logger?.warn?.(`[dsh-context-bridge] 注册 turn-stopping 失败：${String(error)}`)
  }

  // HTTP 路由（Client 半用它读写开关/触发）
  let injected = false
  try {
    ctx.inject?.(['webServer'], () => {
      injected = true
      const webServer = get(ctx, 'webServer') ?? get(ctx, 'httpServer')
      if (webServer === undefined || typeof webServer.register !== 'function') return
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

  ctx.effect?.(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 忽略卸载异常
      }
    }
    lastRunAt.clear()
    inFlight.clear()
  }, 'dsh-context-bridge: lifetime')

  logger?.info?.(
    `[dsh-context-bridge] 已装载（routes=${injected ? 'on' : 'off'}；开关以各项目 .dsh-bridge.json 为准）`,
  )
}
