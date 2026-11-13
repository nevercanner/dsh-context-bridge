import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeHandoffEvent, makeSessionId, runHandoff, seedAndWake } from '../src/handoff-host.js'
import { readNames } from '../src/bus-names.js'

/** 一个最小可用的假宿主 ctx：只实现本插件真会用到的那几个服务。 */
function fakeCtx(overrides = {}) {
  const services = {
    logger: { info() {}, warn() {}, debug() {} },
    agents: {
      created: [],
      async create(options) {
        this.created.push(options)
        return { agent: { id: options.sessionId } }
      },
      get() {
        return undefined
      },
    },
    sessionQuery: {
      async observeSession() {
        const observation = {
          events: [
            { type: 'user/message', data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '修一下登录' }] } } },
            {
              type: 'todo/write',
              data: { turn: 1, todos: [{ content: '改 auth', status: 'in_progress' }] },
            },
          ],
        }
        observation[Symbol.dispose] = () => {}
        return observation
      },
    },
    tokenMeter: { measure: () => ({ totalTokens: 1 }) },
    workingDirectory: { get: () => overrides.projectRoot ?? 'D:\\openclaw-data\\demo' },
    sessionTitle: { current: () => '会话标题' },
    ...overrides.services,
  }
  return {
    get(name) {
      return services[name]
    },
    ...overrides.ctx,
  }
}

test('makeSessionId 带 session- 前缀', () => {
  assert.equal(makeSessionId(() => 'abc'), 'session-abc')
})

test('makeHandoffEvent 满足宿主 user/message 校验', () => {
  const event = makeHandoffEvent({ text: '交接正文', name: '管线维护' })
  assert.equal(event.type, 'user/message')
  assert.equal(event.seq, 0)
  assert.equal(event.data.role, 'user')
  assert.ok(typeof event.data.id === 'string' && event.data.id !== '')
  assert.ok(Array.isArray(event.data.content))
  assert.equal(event.data.content[0].text, '交接正文')
  assert.ok(typeof event.data.source.kind === 'string' && event.data.source.kind !== '')
  assert.equal(event.data.source.fromName, '管线维护')
})

test('seedAndWake 目标不存在时返回 ok:false 而不是抛', async () => {
  const ctx = fakeCtx()
  const result = await seedAndWake(ctx, { sessionId: 'session-x', text: 't' })
  assert.equal(result.ok, false)
  assert.ok(result.detail.includes('未在本进程激活'))
})

test('seedAndWake 走 followup 并带 source', async () => {
  const pushed = []
  const ctx = fakeCtx({
    services: {
      agents: {
        get: () => ({
          followup(message) {
            pushed.push(message)
          },
        }),
      },
    },
  })
  const result = await seedAndWake(ctx, { sessionId: 'session-x', text: '交接正文', name: '管线维护' })
  assert.equal(result.ok, true)
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].role, 'user')
  assert.equal(pushed[0].source.origin, 'dsh-context-bridge')
  assert.equal(pushed[0].source.fromName, '管线维护')
})

test('seedAndWake 没有 followup 时退回 send 并唤醒', async () => {
  const calls = []
  const ctx = fakeCtx({
    services: {
      agents: {
        get: () => ({
          send(message, target, wake) {
            calls.push([message.role, target, wake])
          },
        }),
      },
    },
  })
  const result = await seedAndWake(ctx, { sessionId: 'session-x', text: 't' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [['user', 'next-turn', true]])
})

test('runHandoff 建会话、带种子、并投递交接文档', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-run-'))
  const pushed = []
  const created = []
  try {
    const agents = {
      async create(options) {
        created.push(options)
        return { agent: { id: options.sessionId } }
      },
      get: (id) => {
        if (!created.some((c) => c.sessionId === id)) return undefined
        return {
          followup(message) {
            pushed.push(message)
          },
        }
      },
    }
    const ctx = fakeCtx({
      projectRoot: dir,
      services: { agents, workingDirectory: { get: () => dir } },
    })
    const result = await runHandoff(ctx, {
      sourceSessionId: 'session-src',
      agent: { session: { id: 'session-src' } },
      config: { todoLimit: 12, recentTurns: 3 },
      randomUUID: () => 'fixed',
    })
    assert.equal(created.length, 1, '应创建恰好一个新会话')
    const made = created[0]
    assert.equal(made.sessionId, 'session-fixed')
    assert.equal(made.inheritedEventCount, 1)
    assert.equal(made.meta.parentSession, 'session-src')
    assert.ok(made.seed[0].data.content[0].text.includes('交接文档'))
    assert.equal(result.ok, true)
    assert.equal(result.sessionId, 'session-fixed')
    assert.equal(pushed.length, 1, '交接文档应被投递给新会话')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runHandoff 建会话后把新会话 attach 进 workspace（否则侧栏项目区不显示）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-attach-'))
  const attached = []
  try {
    const agents = {
      async create(options) {
        return { agent: { id: options.sessionId } }
      },
      get: () => undefined,
    }
    const workspace = {
      path: dir,
      async attachSession(sessionId) {
        attached.push(sessionId)
      },
    }
    const registry = {
      list: () => [workspace],
    }
    const ctx = fakeCtx({
      projectRoot: dir,
      services: { agents, workingDirectory: { get: () => dir }, workspaceRegistry: registry },
    })
    const result = await runHandoff(ctx, {
      sourceSessionId: 'session-src',
      agent: { session: { id: 'session-src' } },
      config: { todoLimit: 12, recentTurns: 3 },
      randomUUID: () => 'attached-id',
    })
    assert.equal(result.ok, true)
    assert.equal(result.sessionId, 'session-attached-id')
    assert.deepEqual(attached, ['session-attached-id'], '新会话应被 attach 进 workspace')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runHandoff 源会话有总线名时继承名字', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-name-'))
  try {
    await mkdir(join(dir, '.dsh-bus'), { recursive: true })
    await writeFile(
      join(dir, '.dsh-bus', 'names.json'),
      JSON.stringify({ 'session-src': { name: '管线维护', at: 1 } }),
    )
    const registered = []
    const ctx = fakeCtx({
      projectRoot: dir,
      services: {
        agents: {
          created: [],
          async create(options) {
            this.created.push(options)
            return { agent: { id: options.sessionId } }
          },
          get: () => ({ followup() {} }),
        },
        workingDirectory: { get: () => dir },
      },
    })
    const result = await runHandoff(ctx, {
      sourceSessionId: 'session-src',
      agent: { session: { id: 'session-src' } },
      config: {},
      randomUUID: () => 'n1',
    })
    assert.equal(result.ok, true)
    assert.equal(result.name, '管线维护-handoff')
    // 新会话应被真实写进 .dsh-bus/names.json（走总线 dsh_bus_register 同款写盘）
    const finalNames = await readNames(dir)
    assert.equal(finalNames['session-src'].name, '管线维护', '源会话登记仍在')
    assert.equal(finalNames['session-n1'].name, '管线维护-handoff', '新会话已接续总线注册')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runHandoff 找不到项目根时明确失败，不建会话', async () => {
  const ctx = fakeCtx({ services: { workingDirectory: undefined } })
  const result = await runHandoff(ctx, { sourceSessionId: 'session-src', agent: {}, config: {} })
  assert.equal(result.ok, false)
  assert.ok(result.detail.includes('项目'))
})

test('runHandoff agents.create 抛错时返回失败而不是崩', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-fail-'))
  try {
    const ctx = fakeCtx({
      projectRoot: dir,
      services: {
        agents: {
          async create() {
            throw new Error('boom')
          },
        },
        workingDirectory: { get: () => dir },
      },
    })
    const result = await runHandoff(ctx, {
      sourceSessionId: 's',
      agent: { session: { id: 's' } },
      projectRoot: dir,
      config: {},
    })
    assert.equal(result.ok, false)
    assert.ok(result.detail.includes('boom'), `detail 应包含原始错误，实际：${result.detail}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runHandoff: agent 未激活 + workingDirectory 拿不到时，从会话持久化 header.cwd 兜底解析项目根', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-persist-cwd-'))
  const created = []
  try {
    const agents = {
      async create(options) {
        created.push(options)
        return { agent: { id: options.sessionId } }
      },
      // agent 未激活：get 永远返回 undefined —— 这正是「后台/历史会话交接失败」的场景
      get: () => undefined,
    }
    const ctx = fakeCtx({
      services: {
        agents,
        // workingDirectory 拿不到（返回 undefined），逼出会话持久化兜底
        workingDirectory: { get: () => undefined },
        sessionQuery: {
          async observeSession(sessionId) {
            const observation = {
              header: { cwd: dir },
              events: [
                { type: 'user/message', data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '修复交接' }] } } },
              ],
            }
            observation[Symbol.dispose] = () => {}
            return observation
          },
        },
      },
    })
    const result = await runHandoff(ctx, {
      sourceSessionId: 'session-bg',
      agent: undefined,
      config: { todoLimit: 12, recentTurns: 3 },
      randomUUID: () => 'bg1',
    })
    assert.equal(result.ok, true, `应能兜底解析项目根并完成交接，实际：${result.detail}`)
    assert.equal(created.length, 1, '应创建新会话')
    assert.equal(created[0].meta.parentSession, 'session-bg')
    assert.equal(created[0].meta.cwd, dir, '新会话 meta.cwd 应来自会话持久化 header.cwd')
    assert.equal(result.sessionId, 'session-bg1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
