/**
 * host 半 —— 纯手动交接。
 *
 * 这里**没有**任何自动触发：不监听任何 agent 生命周期事件，不看 token 用量，
 * 没有阈值、没有冷却、没有定时器。交接只在你点菜单里的那一行时发生。
 *
 * 为什么这样设计：上下文快满时，第一件事应该是压缩（`/compact` 或自动压缩），
 * 压缩多轮后仍然压不动，交接才是最后一步 —— 这个判断只有人能做，
 * 一个阈值猜不出来，猜错的结果是「还能压一压的会话被提前抛弃」。
 *
 * 设计约束（来自 2026-11-09 的真实事故）：
 *   1. **不注册任何 DOM 兜底**。dsh-session-send 曾用 DOM 变更观察器扫描
 *      所有 role="menu"，再把自建节点塞进 React 管理的容器 —— React 下一次
 *      渲染抹掉它，观察器再插一次，打开模型菜单就把渲染进程主线程锁死。
 *   2. Client 半只用官方 slot，改动需整机重启才生效（运行中改会 rev 失配）。
 *   3. 宿主服务一律 ctx.get() + try 兜底读取，不做静态 import，
 *      也绝不裸读 ctx.xxx（未声明 inject 时会抛）。
 */

import { describeConfig, normalizeRoot, readProjectConfig } from './project-config.js'
import { runHandoff, resolveProjectRoot } from './handoff-host.js'
import { readNames, nameOf, namesPathFor } from './bus-names.js'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-context-bridge'
export const description =
  '会话交接（手动）：在你点「上下文交接」的那一刻，把项目事实、上下文摘要与待办压成一份交接文档，' +
  '新建会话并把文档作为第一轮投入，让它接着干；新会话可继承会话总线的注册名。不按阈值自动触发。'

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
    const root = projectRoot ?? (await projectRootOf(ctx, agent))
    if (root === undefined) {
      return { ok: false, detail: '无法确定该会话所属项目，交接已取消（没有创建任何东西）' }
    }
    const config = await readProjectConfig(root)
    if (config.enabled !== true) {
      return {
        ok: false,
        detail: `本项目未开启交接：在 ${root} 下建 ${config.path ?? '.dsh-bridge.json'} 并写 {"enabled": true}`,
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
          mode: 'manual',
          projectRoot,
          projectName: projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? '',
          todoLimit: config.todoLimit,
          recentTurns: config.recentTurns,
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

  ctx.effect?.(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 忽略卸载异常
      }
    }
    inFlight.clear()
  }, 'dsh-context-bridge: lifetime')

  logger?.info?.('[dsh-context-bridge] 已装载（手动触发：不注册任何自动监听）')
}
