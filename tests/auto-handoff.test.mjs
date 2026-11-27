import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readContextArchive, writeContextArchive, archiveDirFor, archivePayload } from '../src/archive.js'
import { countTurns, shouldAutoHandoff, DEFAULT_HANDOFF_ROUNDS } from '../src/rounds.js'
import { createAutoHandoff, triggerMessage } from '../src/auto-handoff.js'

/** 造 N 轮事件（每轮：turn/start → user/message → assistant/message → turn/end）。 */
function eventsOfRounds(rounds) {
  const events = []
  for (let turn = 1; turn <= rounds; turn += 1) {
    events.push({ type: 'turn/start', data: { turn } })
    events.push({
      type: 'user/message',
      data: { turn, message: { role: 'user', content: [{ type: 'text', text: `第 ${turn} 轮的问题` }] } },
    })
    events.push({
      type: 'assistant/message',
      data: { turn, message: { role: 'assistant', content: [{ type: 'text', text: `第 ${turn} 轮的回答` }] } },
    })
    events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

function liveCtx({ dir, events, onCreate, archiveSession }) {
  const created = []
  const logs = { info: [], warn: [] }
  const services = {
    logger: {
      info: (line) => logs.info.push(String(line)),
      warn: (line) => logs.warn.push(String(line)),
      debug: () => {},
    },
    agents: {
      created,
      async create(options) {
        if (onCreate !== undefined) onCreate(options)
        created.push(options)
        return { agent: { id: options.sessionId } }
      },
      get: () => ({ followup() {} }),
    },
    sessionQuery: {
      async observeSession() {
        const observation = {
          header: { cwd: dir },
          events: [
            { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: '系统提示' }] } } },
            ...events,
            { type: 'tool/result', data: { turn: 1, callId: 'c1', result: 'ok' } },
          ],
        }
        observation[Symbol.dispose] = () => {}
        return observation
      },
    },
    workingDirectory: { get: () => dir },
    workspaceRegistry: {
      list: () => [],
      async archiveSession(id) {
        if (archiveSession !== undefined) return archiveSession(id)
        return undefined
      },
    },
    sessionTitle: { get: () => ({ title: '手动命名', source: { kind: 'user' } }) },
  }
  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
  }
  return { ctx, created, logs, services }
}

async function projectWithConfig(rounds, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-auto-'))
  await writeFile(
    join(dir, '.dsh-bridge.json'),
    JSON.stringify({ enabled: true, autoHandoff: true, handoffRounds: rounds, ...extra }),
    'utf8',
  )
  return dir
}

test('countTurns 按轮的 turn 号算，不按消息条数', () => {
  assert.equal(countTurns(eventsOfRounds(3)), 3)
  assert.equal(countTurns([]), 0)
  // 一轮里 40 条消息，仍然只算 1 轮
  const many = [{ type: 'turn/start', data: { turn: 1 } }]
  for (let i = 0; i < 40; i += 1) many.push({ type: 'user/message', data: { turn: 1 } })
  assert.equal(countTurns(many), 1)
  // 老日志只有 user/message 带 turn 号时的兜底
  assert.equal(countTurns([{ type: 'user/message', data: { turn: 4 } }]), 4)
})

test('shouldAutoHandoff：默认 15 轮，关闭开关/关闭插件都不触发', () => {
  const on = { enabled: true, autoHandoff: true, handoffRounds: DEFAULT_HANDOFF_ROUNDS }
  assert.equal(shouldAutoHandoff({ config: on, rounds: 14 }), false)
  assert.equal(shouldAutoHandoff({ config: on, rounds: 15 }), true)
  assert.equal(shouldAutoHandoff({ config: on, rounds: 16 }), true)
  assert.equal(shouldAutoHandoff({ config: { ...on, autoHandoff: false }, rounds: 99 }), false)
  assert.equal(shouldAutoHandoff({ config: { ...on, enabled: false }, rounds: 99 }), false)
  assert.equal(shouldAutoHandoff({ config: undefined, rounds: 99 }), false)
})

test('归档文件含 session_id / archive_time / context_snapshot，且完整保留系统提示与工具结果', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-archive-'))
  try {
    const written = await writeContextArchive({
      projectRoot: dir,
      sessionId: 'session-arch',
      title: '归档用例',
      context: {
        session: { id: 'session-arch' },
        inheritedEventCount: 0,
        events: [
          { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: '系统提示' }] } } },
          { type: 'user/message', data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '问题' }] } } },
          { type: 'tool/result', data: { callId: 'c1', result: 'ok' } },
        ],
      },
    })
    assert.ok(written.file.startsWith(archiveDirFor(dir, undefined)))
    const files = await readdir(archiveDirFor(dir, undefined))
    assert.equal(files.length, 1, '归档目录里应恰好一份文件')
    const parsed = await readContextArchive(written.file)
    assert.equal(parsed.session_id, 'session-arch')
    assert.match(parsed.archive_time, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(parsed.context_snapshot.event_count, 3)
    const types = parsed.context_snapshot.events.map((event) => event.type)
    assert.deepEqual(types, ['system/message', 'user/message', 'tool/result'])
    assert.equal(parsed.title, '归档用例')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('archivePayload 三字段在前，archive_time 用注入时钟', () => {
  const payload = archivePayload({
    sessionId: 'session-x',
    context: { events: [{ type: 'user/message' }] },
    now: new Date('2026-11-27T00:00:00.000Z'),
  })
  assert.deepEqual(Object.keys(payload).slice(0, 3), ['session_id', 'archive_time', 'context_snapshot'])
  assert.equal(payload.archive_time, '2026-11-27T00:00:00.000Z')
})

test('归档失败（项目目录不存在）直接抛，绝不悄悄写到别处', async () => {
  await assert.rejects(
    () => writeContextArchive({ projectRoot: join(tmpdir(), 'bridge-definitely-missing-xyz'), sessionId: 's' }),
    /项目目录不存在/,
  )
})

test('自动交接：跑到第 15 轮触发，日志含 handoff triggered at round 15，并落一份归档', async () => {
  const dir = await projectWithConfig(15)
  try {
    const events = eventsOfRounds(15)
    const { ctx, created, logs } = liveCtx({ dir, events })
    const auto = createAutoHandoff({ ctx, logger: ctx.get('logger'), inFlight: new Set(), randomUUID: () => 'auto1' })
    const session = { id: 'session-live', snapshotEvents: () => events }

    const result = await auto.check(session)
    assert.equal(result?.ok, true, result?.detail)
    assert.ok(
      logs.info.includes(triggerMessage(15, 15, 'session-live')),
      `日志里必须有触发记录，实际：${JSON.stringify(logs.info)}`,
    )
    assert.ok(logs.info.some((line) => line.includes('handoff triggered at round 15')))
    assert.equal(created.length, 1, '应恰好建一个新会话')
    assert.equal(created[0].meta.parentSession, 'session-live')
    const files = await readdir(archiveDirFor(dir, undefined))
    assert.equal(files.length, 1, '应生成一份归档')
    const parsed = await readContextArchive(join(archiveDirFor(dir, undefined), files[0]))
    assert.equal(parsed.session_id, 'session-live')
    assert.ok(parsed.context_snapshot.event_count >= 15)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('自动交接：第 14 轮不动', async () => {
  const dir = await projectWithConfig(15)
  try {
    const events = eventsOfRounds(14)
    const { ctx, created, logs } = liveCtx({ dir, events })
    const auto = createAutoHandoff({ ctx, logger: ctx.get('logger'), inFlight: new Set(), randomUUID: () => 'auto2' })
    const result = await auto.check({ id: 'session-live', snapshotEvents: () => events })
    assert.equal(result, undefined)
    assert.equal(created.length, 0)
    assert.equal(logs.info.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('阈值中途改配置，下一轮按最新值（同一个执行器，不重启）', async () => {
  const dir = await projectWithConfig(16)
  try {
    const events = eventsOfRounds(15)
    const { ctx, created } = liveCtx({ dir, events })
    const auto = createAutoHandoff({ ctx, logger: ctx.get('logger'), inFlight: new Set(), randomUUID: () => 'auto3' })
    const session = { id: 'session-live', snapshotEvents: () => events }

    assert.equal(await auto.check(session), undefined, '阈值 16 时第 15 轮不交接')
    assert.equal(created.length, 0)

    await writeFile(join(dir, '.dsh-bridge.json'), JSON.stringify({ enabled: true, handoffRounds: 15 }), 'utf8')
    const result = await auto.check(session)
    assert.equal(result?.ok, true, result?.detail)
    assert.equal(created.length, 1, '改配置后同一轮再次判断就该触发')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('同一轮只尝试一次：交接失败不会每轮重撞同一个错误', async () => {
  const dir = await projectWithConfig(15)
  try {
    const events = eventsOfRounds(15)
    let attempts = 0
    const { ctx, logs } = liveCtx({
      dir,
      events,
      onCreate: () => {
        attempts += 1
        throw new Error('boom')
      },
    })
    const auto = createAutoHandoff({ ctx, logger: ctx.get('logger'), inFlight: new Set(), randomUUID: () => 'auto4' })
    const session = { id: 'session-live', snapshotEvents: () => events }

    const first = await auto.check(session)
    assert.equal(first?.ok, false)
    const second = await auto.check(session)
    assert.equal(second, undefined, '同一轮第二次调用不再尝试')
    assert.equal(attempts, 1, 'agents.create 只被调用一次')
    assert.ok(logs.warn.some((line) => line.includes('auto handoff')), `失败要有 warn：${JSON.stringify(logs.warn)}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('turn/end 之外的事件不触发（turn 中途不打断）', async () => {
  const dir = await projectWithConfig(15)
  try {
    const events = eventsOfRounds(15)
    const { ctx, created } = liveCtx({ dir, events })
    const auto = createAutoHandoff({ ctx, logger: ctx.get('logger'), inFlight: new Set(), randomUUID: () => 'auto5' })
    auto.onSessionEvent({ id: 'session-live', snapshotEvents: () => events }, { type: 'assistant/message', data: { turn: 15 } })
    auto.onSessionEvent({ id: 'session-live', snapshotEvents: () => events }, { type: 'turn/start', data: { turn: 16 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(created.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('跳过原因记进 lastSkip：低于阈值时给得出「为什么没交」', async () => {
  const dir = await projectWithConfig(30)
  try {
    const events = eventsOfRounds(20)
    const { ctx } = liveCtx({ dir, events })
    const auto = createAutoHandoff({ ctx, logger: ctx.get('logger'), inFlight: new Set(), randomUUID: () => 'skip1' })
    await auto.check({ id: 'session-skip', snapshotEvents: () => events })
    const skip = auto.lastSkip.get('session-skip')
    assert.ok(skip !== undefined, '没记录跳过原因')
    assert.match(skip.reason, /rounds 20 < threshold 30/)
    assert.equal(skip.rounds, 20)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('lastSkip 在成功交接后被清掉', async () => {
  const dir = await projectWithConfig(15)
  try {
    const events = eventsOfRounds(20)
    const { ctx } = liveCtx({ dir, events })
    const auto = createAutoHandoff({ ctx, logger: ctx.get('logger'), inFlight: new Set(), randomUUID: () => 'skip2' })
    await auto.check({ id: 'session-ok', snapshotEvents: () => events })
    assert.equal(auto.lastSkip.has('session-ok'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('过了阈值每一轮都是候选，不会因为某一轮失败就永久哑掉', async () => {
  const dir = await projectWithConfig(15)
  try {
    const events = eventsOfRounds(22)
    const { ctx, created } = liveCtx({ dir, events })
    const auto = createAutoHandoff({ ctx, logger: ctx.get('logger'), inFlight: new Set(), randomUUID: () => 'many' })
    // 先跑 21 轮这一轮
    const session21 = { id: 'session-many', snapshotEvents: () => events.slice(0, eventsOfRounds(21).length) }
    await auto.check(session21)
    assert.equal(created.length, 1)
    // 同一会话继续到 22 轮（lastAttempt 记录的是 21）
    const session22 = { id: 'session-many', snapshotEvents: () => events }
    await auto.check(session22)
    assert.equal(created.length, 2, '22 轮应该再交一次，而不是因为「已经交过」哑掉')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
