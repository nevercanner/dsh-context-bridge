/**
 * 用「假宿主」把插件的 host 半真跑一遍 —— 不用启动 DSH 就能验证：
 *   1. apply() 不抛、只挂一个 session/event 监听 + 生命周期清理
 *   2. 注册的两条 HTTP 路由真的能用（status / run）
 *   3. 手动 /run 能建会话、投递文档
 *   4. 会话跑到 15 轮（turn/end）时自动交接：日志有 handoff triggered at round 15、
 *      归档文件落盘、新会话建出来、旧会话被归档
 *
 * 用法：node scripts/verify-host.mjs
 * 退出码 0 = 全通过；非 0 = 有断言失败（CI 友好）。
 */
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
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
                // 真实形状：user/message 只有 content，没有 turn；轮次在 turn/start 上。
                // 这个桩故意用真实形状，否则「文档为空」那个 bug 在自检里测不出来。
                { type: 'turn/start', data: { turn: 1 } },
                { type: 'user/message', data: { content: [{ type: 'text', text: '把这个插件做出来' }] } },
                { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{"file_path":"src/index.js"}' } },
                { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '做完一半' }] } } },
                { type: 'todo/write', data: { turn: 1, todos: [{ content: '写 README', status: 'in_progress' }] } },
              ],
            }
            observation[Symbol.dispose] = () => {}
            return observation
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
  check('只注册了 1 个事件监听，且是 session/event', listeners.size === 1 && listeners.has('session/event'),
    `实际 ${listeners.size}: ${[...listeners.keys()].join(',')}`)
  check('注册了 2 条路由', routes.size === 2, `实际 ${routes.size}`)
  check('注册了生命周期清理', disposers.length === 1)

  const statusRoute = routes.get('exact:/plugins/dsh-context-bridge/status')
  const runRoute = routes.get('exact:/plugins/dsh-context-bridge/run')
  check('有 status 路由', statusRoute !== undefined)
  check('有 run 路由', runRoute !== undefined)

  console.log('2) 未配置时默认开启（新项目装上就能用）')
  const res1 = fakeRes()
  await statusRoute.handler(fakeReq({ url: `/plugins/dsh-context-bridge/status?session=session-src` }), res1)
  const body1 = JSON.parse(res1.body)
  check('HTTP 200', res1.statusCode === 200, `实际 ${res1.statusCode}`)
  check('enabled=true（默认开）', body1.enabled === true, String(body1.enabled))
  check('状态说明是默认开启', String(body1.status).includes('默认'), body1.status)
  check('mode 是 auto+manual', body1.mode === 'auto+manual', String(body1.mode))
  check('handoffRounds 默认 15', body1.handoffRounds === 15, String(body1.handoffRounds))
  check('archiveDirPath 指向 <项目>/.dsh-archive',
    String(body1.archiveDirPath).replace(/\\/g, '/').endsWith('/.dsh-archive'), String(body1.archiveDirPath))
  check('projectRoot 指向临时目录', String(body1.projectRoot).replace(/\\/g, '/').startsWith(dir.replace(/\\/g, '/')), body1.projectRoot)

  console.log('3) 项目显式关掉时手动 /run 被拒，且不建任何东西')
  await writeFile(join(dir, '.dsh-bridge.json'), JSON.stringify({ enabled: false }))
  const res0 = fakeRes()
  await runRoute.handler(
    fakeReq({ method: 'POST', url: '/plugins/dsh-context-bridge/run', body: { session: 'session-src' } }),
    res0,
  )
  const body0 = JSON.parse(res0.body)
  check('关闭时 ok=false', body0.ok === false, res0.body.slice(0, 120))
  check('提示里给出恢复方式', String(body0.detail).includes('.dsh-bridge.json'), body0.detail)
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
  check('不带 seed（surface 首家必须留给 system/message）', created[0]?.seed === undefined,
    `实际 seed=${JSON.stringify(created[0]?.seed)?.slice(0, 120)}`)
  check('投递了 1 条消息', pushed.length === 1)
  const doc = String(pushed[0]?.content?.[0]?.text ?? '')
  check('文档带上了用户原始要求（真实形状下也不丢）', doc.includes('把这个插件做出来'), doc.slice(0, 400))
  check('文档带上了工具轨迹', doc.includes('edit「src/index.js」'), doc.slice(0, 600))
  check('文档头写了归档文件路径（新会话能 read 到全文）',
    doc.includes('旧上下文已完整归档') && doc.includes('.dsh-archive'), doc.slice(0, 300))

  console.log('5) 自动交接：跑到第 15 轮的 turn/end 就强制交接（不手动点）')
  const autoEvents = []
  for (let turn = 1; turn <= 15; turn += 1) {
    autoEvents.push({ type: 'turn/start', data: { turn } })
    autoEvents.push({
      type: 'user/message',
      data: { turn, message: { role: 'user', content: [{ type: 'text', text: `第 ${turn} 轮` }] } },
    })
    autoEvents.push({
      type: 'assistant/message',
      data: { turn, message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] } },
    })
    autoEvents.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  const autoSession = { id: 'session-auto', snapshotEvents: () => autoEvents }
  listeners.get('session/event')(autoSession, { type: 'turn/end', data: { turn: 15 } })
  await new Promise((resolve) => setTimeout(resolve, 200))
  check('日志里有 handoff triggered at round 15',
    logs.some(([level, line]) => level === 'info' && String(line).includes('handoff triggered at round 15')),
    JSON.stringify(logs.slice(-4)))
  check('自动交接建了第 2 个会话', created.length === 2, `实际 ${created.length}`)
  check('新会话的父会话是 session-auto', created[1]?.meta?.parentSession === 'session-auto',
    JSON.stringify(created[1]?.meta))
  let archiveFiles = []
  try {
    archiveFiles = await readdir(join(dir, '.dsh-archive'))
  } catch {
    archiveFiles = []
  }
  const autoArchives = archiveFiles.filter((name) => String(name).startsWith('session-auto-'))
  check('归档目录生成了本次交接的 JSON', autoArchives.length === 1, `实际 ${JSON.stringify(archiveFiles)}`)
  check('归档文件名带源会话 id', autoArchives.length === 1, String(archiveFiles[0]))

  console.log('6) 路由拒绝错误方法')
  const res3 = fakeRes()
  await statusRoute.handler(fakeReq({ method: 'POST', url: '/plugins/dsh-context-bridge/status' }), res3)
  check('POST status → 405', res3.statusCode === 405, String(res3.statusCode))

  console.log('7) 清理函数可调用且不抛')
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
