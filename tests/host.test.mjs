import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeSessionId, runHandoff, seedAndWake } from '../src/handoff-host.js'
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

// 回归：agents.create 绝不能带 surface 事件当种子。
// 宿主 v4 要求 surface 首家是 system/message；seed 里塞 user/message 会让新会话
// 第一次跑模型就写出「读不回来」的日志（system/message requires a protected first
// surface head），下次打开直接报会话损坏。
const SURFACE_TYPES = ['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result']

test('runHandoff 建会话时 seed 里不放任何 surface 事件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-seed-'))
  const created = []
  const realCtx = fakeCtx({
    projectRoot: dir,
    services: { workingDirectory: { get: () => dir }, agents: {
      async create(options) {
        created.push(options)
        return { agent: { id: options.sessionId } }
      },
      get: () => undefined,
    } },
  })
  try {
    const result = await runHandoff(realCtx, {
      sourceSessionId: 'session-src',
      projectRoot: dir,
      randomUUID: () => 'new',
      config: {},
    })
  assert.equal(created.length, 1, '应当恰好建一个新会话')
  const options = created[0]
  const seed = options.seed
  if (Array.isArray(seed)) {
    for (const event of seed) {
      assert.ok(
        !SURFACE_TYPES.includes(event && event.type),
        `seed 里不许出现 surface 事件，实际出现 ${String(event && event.type)}`,
      )
    }
  } else {
    assert.equal(seed, undefined, '不带 seed 最好')
  }
  assert.ok(!('inheritedEventCount' in options) || options.inheritedEventCount === 0,
    '没有继承事件时 inheritedEventCount 必须是 0')
  assert.notEqual(options.meta && options.meta.isSeeded, true, '空会话不是 seeded 会话')
    assert.equal(result.ok, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

test('runHandoff 建空会话并投递交接文档', async () => {
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
    assert.equal(made.seed, undefined, '不带 seed')
    assert.equal(made.meta.parentSession, 'session-src')
    assert.notEqual(made.meta.isSeeded, true, '空会话不是 seeded 会话')
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

test('runHandoff 用侧边栏手动名登记总线，并把旧会话的登记摘掉（名称转移）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-name-'))
  try {
    await mkdir(join(dir, '.dsh-bus'), { recursive: true })
    await writeFile(
      join(dir, '.dsh-bus', 'names.json'),
      JSON.stringify({ 'session-src': { name: '管线维护', at: 1 } }),
    )
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
        // 侧边栏手动命名 = session/title 事件，source.kind === 'user'
        sessionQuery: {
          async observeSession() {
            const observation = {
              events: [
                {
                  type: 'user/message',
                  data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '修一下登录' }] } },
                },
              ],
            }
            observation[Symbol.dispose] = () => {}
            return observation
          },
          async readTitleSnapshot() {
            return { session: { id: 'session-src' }, title: { title: '管线维护', source: { kind: 'user' } } }
          },
        },
      },
    })
    const result = await runHandoff(ctx, {
      sourceSessionId: 'session-src',
      agent: { session: { id: 'session-src' } },
      config: {},
      randomUUID: () => 'n1',
    })
    assert.equal(result.ok, true)
    assert.equal(result.name, '管线维护', '注册名 = 侧边栏手动名本身（不加 -handoff 后缀）')
    const finalNames = await readNames(dir)
    assert.equal(finalNames['session-src'], undefined, '旧会话的登记被摘掉（名称转移，避免同名双 owner）')
    assert.equal(finalNames['session-n1'].name, '管线维护', '新会话已接续总线注册')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runHandoff 侧边栏未手动命名时注册名回退为新会话 id（UUID），不编造名字', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-noname-'))
  try {
    await mkdir(join(dir, '.dsh-bus'), { recursive: true })
    await writeFile(
      join(dir, '.dsh-bus', 'names.json'),
      JSON.stringify({ 'session-src': { name: '管线维护', at: 1 } }),
    )
    const ctx = fakeCtx({
      projectRoot: dir,
      services: {
        agents: {
          async create(options) {
            return { agent: { id: options.sessionId } }
          },
          get: () => ({ followup() {} }),
        },
        workingDirectory: { get: () => dir },
        sessionQuery: {
          async observeSession() {
            const observation = {
              events: [
                {
                  type: 'user/message',
                  data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '修一下登录' }] } },
                },
              ],
            }
            observation[Symbol.dispose] = () => {}
            return observation
          },
          // 自动标题（provider 生成）不算手动命名
          async readTitleSnapshot() {
            return { session: { id: 'session-src' }, title: { title: '修复登录接口', source: { kind: 'provider' } } }
          },
        },
      },
    })
    const result = await runHandoff(ctx, {
      sourceSessionId: 'session-src',
      agent: { session: { id: 'session-src' } },
      config: {},
      randomUUID: () => 'n2',
    })
    assert.equal(result.ok, true)
    assert.equal(result.name, 'session-n2', '没有手动名时用新会话 id 注册')
    const finalNames = await readNames(dir)
    assert.equal(finalNames['session-n2'].name, 'session-n2')
    assert.equal(finalNames['session-src'].name, '管线维护', '不手动命名时旧会话的登记保持不动')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runHandoff 归档写盘失败时整体中止：不建会话、不登记总线、旧会话继续跑', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-abort-'))
  try {
    const created = []
    // 先用一个**文件**占住归档目录名 → mkdir(recursive) 必然 ENOTDIR
    await writeFile(join(dir, 'not-a-dir'), 'x', 'utf8')
    const ctx = fakeCtx({
      projectRoot: dir,
      services: {
        agents: {
          async create(options) {
            created.push(options)
            return { agent: { id: options.sessionId } }
          },
          get: () => ({ followup() {} }),
        },
        workingDirectory: { get: () => dir },
        workspaceRegistry: { list: () => [] },
      },
    })
    const result = await runHandoff(ctx, {
      sourceSessionId: 'session-src',
      agent: { session: { id: 'session-src' } },
      // 合法的项目根，但归档目录是一个已存在的**文件** → mkdir 必然 ENOTDIR
      config: { archiveDir: 'not-a-dir' },
      randomUUID: () => 'abort1',
    })
    assert.equal(result.ok, false)
    assert.equal(result.aborted, true)
    assert.equal(result.abortReason, 'archive')
    assert.equal(created.length, 0, '归档失败绝不允许建新会话')
    assert.ok(result.detail.includes('未建新会话'), `detail 要讲清没建：${result.detail}`)
    const names = await readNames(dir)
    assert.deepEqual(names, {}, '归档失败绝不允许登记总线')
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
