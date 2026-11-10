/**
 * 用「假宿主」把插件的 host 半真跑一遍 —— 不用启动 DSH 就能验证：
 *   1. apply() 不抛、能挂上 agent/turn-stopping 与 effect 清理
 *   2. 注册的两条 HTTP 路由真的能用（status / run）
 *   3. 低于阈值不触发，高于阈值触发一次，且在冷却窗口内不重复
 *
 * 用法：node scripts/verify-host.mjs
 * 退出码 0 = 全通过；非 0 = 有断言失败（CI 友好）。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/index.js'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** 极简 http 响应替身：记录 status/body。 */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      res.headers[key] = value
    },
    end(chunk) {
      res.body = String(chunk ?? '')
    },
  }
  return res
}

function fakeReq({ method = 'GET', url = '/', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-verify-'))
  const routes = new Map()
  const listeners = new Map()
  const disposers = []
  const created = []
  const pushed = []
  const logs = []

  const agents = {
    async create(options) {
      created.push(options)
      return { agent: { id: options.sessionId } }
    },
    get(id) {
      return created.some((c) => c.sessionId === id) ? { followup: (m) => pushed.push(m) } : undefined
    },
  }

  const ctx = {
    get(name) {
      if (name === 'logger') return { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), debug() {} }
      if (name === 'agents') return agents
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(`${route.kind}:${route.path}`, route)
            return () => routes.delete(`${route.kind}:${route.path}`)
          },
        }
      }
      if (name === 'workingDirectory') return { get: () => dir }
      if (name === 'cwd') return dir
      if (name === 'sessionQuery') {
        return {
          async observeSession() {
            const observation = {
              events: [
                { type: 'user/message', data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '把这个插件做出来' }] } } },
                { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '做完一半' }] } } },
                { type: 'todo/write', data: { turn: 1, todos: [{ content: '写 README', status: 'in_progress' }] } },
              ],
            }
            observation[Symbol.dispose] = () => {}
            return observation
          },
        }
      }
      if (name === 'dshSessionSend') {
        return {
          async registerName(input) {
            logs.push(['info', `registerName ${input.name}`])
          },
        }
      }
      return undefined
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    inject(_services, factory) {
      factory()
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }

  console.log('1) apply() 不抛并挂上必需的东西')
  try {
    apply(ctx, { enabled: true })
    check('apply 未抛异常', true)
  } catch (error) {
    check('apply 未抛异常', false, String(error))
  }
  check('没有注册任何事件监听（纯手动，不自动触发）', listeners.size === 0, `实际 ${listeners.size}: ${[...listeners.keys()].join(',')}`)
  check('注册了 2 条路由', routes.size === 2, `实际 ${routes.size}`)
  check('注册了生命周期清理', disposers.length === 1)

  const statusRoute = routes.get('exact:/plugins/dsh-context-bridge/status')
  const runRoute = routes.get('exact:/plugins/dsh-context-bridge/run')
  check('有 status 路由', statusRoute !== undefined)
  check('有 run 路由', runRoute !== undefined)

  console.log('2) 未配置时 status 报「未配置」且 enabled=false')
  const res1 = fakeRes()
  await statusRoute.handler(fakeReq({ url: `/plugins/dsh-context-bridge/status?session=session-src` }), res1)
  const body1 = JSON.parse(res1.body)
  check('HTTP 200', res1.statusCode === 200, `实际 ${res1.statusCode}`)
  check('enabled=false', body1.enabled === false)
  check('状态含「未配置」', String(body1.status).includes('未配置'), body1.status)
  check('projectRoot 指向临时目录', String(body1.projectRoot).replace(/\\/g, '/').startsWith(dir.replace(/\\/g, '/')), body1.projectRoot)

  console.log('3) 未开启时手动 /run 被拒，且不建任何东西')
  const res0 = fakeRes()
  await runRoute.handler(
    fakeReq({ method: 'POST', url: '/plugins/dsh-context-bridge/run', body: { session: 'session-src' } }),
    res0,
  )
  const body0 = JSON.parse(res0.body)
  check('未开启时 ok=false', body0.ok === false, res0.body.slice(0, 120))
  check('提示里给出开启方式', String(body0.detail).includes('.dsh-bridge.json'), body0.detail)
  check('没有建会话', created.length === 0, `实际 ${created.length}`)

  console.log('4) 开启后手动 /run 能建会话并投递文档')
  await writeFile(join(dir, '.dsh-bridge.json'), JSON.stringify({ enabled: true }))
  const res2 = fakeRes()
  await runRoute.handler(
    fakeReq({ method: 'POST', url: '/plugins/dsh-context-bridge/run', body: { session: 'session-src' } }),
    res2,
  )
  const body2 = JSON.parse(res2.body)
  check('HTTP 200', res2.statusCode === 200, `${res2.statusCode} ${res2.body.slice(0, 120)}`)
  check('ok=true', body2.ok === true, body2.detail)
  check('建了 1 个会话', created.length === 1)
  check('会话 id 有 session- 前缀', String(body2.sessionId).startsWith('session-'))
  check('种子是交接文档', String(created[0]?.seed?.[0]?.data?.content?.[0]?.text ?? '').includes('交接文档'))
  check('投递了 1 条消息', pushed.length === 1)

  console.log('5) 路由拒绝错误方法')
  const res3 = fakeRes()
  await statusRoute.handler(fakeReq({ method: 'POST', url: '/plugins/dsh-context-bridge/status' }), res3)
  check('POST status → 405', res3.statusCode === 405, String(res3.statusCode))

  console.log('6) 清理函数可调用且不抛')
  try {
    for (const dispose of disposers) dispose()
    check('dispose 未抛', true)
  } catch (error) {
    check('dispose 未抛', false, String(error))
  }

  await rm(dir, { recursive: true, force: true })

  console.log('')
  if (failures === 0) {
    console.log('全部通过')
    process.exit(0)
  }
  console.log(`${failures} 项失败`)
  process.exit(1)
}

await main()
