import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHandoff,
  digestSummary,
  latestCompactionSummary,
  recentTurns,
  todosFromEvents,
  toolTrail,
  userRequests,
} from '../src/handoff.js'

const events = [
  {
    type: 'user/message',
    data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '把登录改成 token 方式' }] } },
  },
  {
    type: 'assistant/message',
    data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已改完 auth 中间件，测试通过' }] } },
  },
  {
    type: 'todo/write',
    data: {
      turn: 1,
      todos: [
        { content: '改 auth 中间件', status: 'completed' },
        { content: '补 token 过期测试', status: 'in_progress' },
        { content: '更新 README', status: 'pending' },
      ],
    },
  },
  {
    type: 'compaction/summary',
    data: { summary: [{ type: 'text', text: '## 主线\n- 用 JWT 替换 session cookie\n- 影响 3 个中间件' }] },
  },
]

test('todosFromEvents 取最后一条 todo/write', () => {
  const todos = todosFromEvents(events)
  assert.equal(todos.length, 3)
  assert.equal(todos[1].status, 'in_progress')
})

test('todosFromEvents 无 todo 时返回空数组', () => {
  assert.deepEqual(todosFromEvents([{ type: 'user/message', data: {} }]), [])
})

test('latestCompactionSummary 取最后一条并拼接文本块', () => {
  const summary = latestCompactionSummary(events)
  assert.ok(summary.includes('JWT'))
})

test('latestCompactionSummary 没有摘要时返回 undefined', () => {
  assert.equal(latestCompactionSummary([{ type: 'user/message', data: {} }]), undefined)
})

test('digestSummary 去掉 markdown 前缀并限制长度', () => {
  const lines = digestSummary('## 标题\n- 第一条\n- 第二条')
  assert.deepEqual(lines, ['标题', '第一条', '第二条'])
  assert.deepEqual(digestSummary(''), [])
})

test('recentTurns 合并同一轮的提问与结论', () => {
  const turns = recentTurns(events, 3)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].ask, '把登录改成 token 方式')
  assert.ok(turns[0].did.includes('auth'))
})

test('recentTurns 只保留最后 N 轮', () => {
  const many = []
  for (let turn = 1; turn <= 6; turn += 1) {
    many.push({ type: 'user/message', data: { turn, message: { role: 'user', content: [{ type: 'text', text: `要求${turn}` }] } } })
  }
  const turns = recentTurns(many, 2)
  assert.deepEqual(turns.map((t) => t.turn), [5, 6])
})

test('buildHandoff 产出包含关键小节且摘要排在事实之前', () => {
  const text = buildHandoff({
    projectRoot: 'D:\\openclaw-data\\demo',
    title: '修登录',
    sourceSessionId: 'session-abc',
    busName: '管线维护',
    todos: todosFromEvents(events),
    summaryLines: digestSummary(latestCompactionSummary(events)),
    recent: recentTurns(events, 3),
    currentEvents: events,
    todoLimit: 8,
  })
  assert.ok(text.includes('# 交接文档：demo'))
  // 新的骨架：一句话主线在最前，事实/要求在后（新会话读第一屏就该知道在干嘛）
  assert.ok(text.includes('## 一句话'))
  assert.ok(text.includes('## 下一步'))
  assert.ok(text.includes('## 关键事实'))
  assert.ok(text.indexOf('## 一句话') < text.indexOf('## 关键事实'))
  assert.ok(text.includes('补 token 过期测试'))
  assert.ok(!text.includes('[进行中] 改 auth 中间件'))
  assert.ok(text.includes('管线维护'))
})

test('buildHandoff 空输入也能产出可用骨架', () => {
  const text = buildHandoff({ projectRoot: '', todos: [], summaryLines: [], recent: [] })
  assert.ok(text.includes('## 一句话'))
  assert.ok(text.includes('## 下一步'))
  assert.ok(text.includes('## 注意事项'))
})

// ── 真实事件形状回归 ────────────────────────────────────────────────
// 宿主真实日志：user/message 只有 data.content（没有 turn、没有 message 包装），
// 轮次在 turn/start 上。旧实现只认 data.turn，用户消息被整段丢掉，交接文档
// 于是永远只剩「源会话没有留下明确的当前任务」。
const realEvents = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { content: [{ type: 'text', text: '把登录改成 token 方式' }] } },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已改完 auth 中间件' }] } } },
  { type: 'tool/call', data: { turn: 1, name: 'edit', arguments: '{"file_path":"src/auth.js","old_string":"a","new_string":"b"}' } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', data: { turn: 2 } },
  { type: 'user/message', data: { content: [{ type: 'text', text: '补上 token 过期测试，再跑一遍 npm test' }] } },
  { type: 'tool/call', data: { turn: 2, name: 'ops_bash', arguments: '{"description":"跑测试","command":"npm test"}' } },
  { type: 'assistant/message', data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '61 pass' }] } } },
  { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
]

test('recentTurns 认得真实形状：用户消息没有 turn，靠 turn/start 归位', () => {
  const turns = recentTurns(realEvents, 3)
  assert.deepEqual(turns.map((item) => item.turn), [1, 2])
  assert.equal(turns[1].ask, '补上 token 过期测试，再跑一遍 npm test')
  assert.ok(turns[0].did.includes('auth'))
})

test('recentTurns 在完全没有 turn 标记时退化成「一条用户消息一轮」', () => {
  const bare = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '第一件事' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '第二件事' }] } },
  ]
  const turns = recentTurns(bare, 5)
  assert.deepEqual(turns.map((item) => item.ask), ['第一件事', '第二件事'])
  assert.deepEqual(turns.map((item) => item.turn), [1, 2])
})

test('userRequests 逐字带上最近几条要求（待办为空时的唯一保障）', () => {
  const requests = userRequests(realEvents, { limit: 1 })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].turn, 2)
  assert.ok(requests[0].text.includes('npm test'))
})

test('toolTrail 统计调用次数并挑出能说明动作的参数', () => {
  const trail = toolTrail(realEvents)
  assert.equal(trail.total, 2)
  assert.equal(trail.items[0].name, 'edit')
  assert.ok(trail.items[0].hint.includes('src/auth.js'))
  assert.equal(trail.items[1].name, 'ops_bash')
  assert.equal(trail.items[1].hint, '跑测试')
})

test('buildHandoff 在待办为空时用最后一条用户要求当「下一步」', () => {
  const text = buildHandoff({
    projectRoot: 'D:\proj',
    todos: [],
    recent: recentTurns(realEvents, 3),
    requests: userRequests(realEvents, { limit: 3 }),
    toolTrail: toolTrail(realEvents),
    currentEvents: realEvents,
  })
  // 待办为空 → 下一步退化成「按最后一条要求继续」，不出现「没有明确当前任务」
  assert.ok(text.includes('按「补上 token 过期测试'))
  assert.ok(text.includes('## 用户最近的原始要求'))
  assert.ok(text.includes('ops_bash「跑测试」'))
  assert.ok(!text.includes('（源会话没有留下明确的当前任务'))
  // 关键事实从原始事件里提取：改过的文件与跑过的命令
  assert.ok(text.includes('## 关键事实'))
  assert.ok(text.includes('src/auth.js') || text.includes('npm test'))
})

test('buildHandoff 把归档路径写进文档头（否则新会话看不到归档）', () => {
  const text = buildHandoff({
    projectRoot: 'D:\proj',
    archivePath: 'D:\proj\.dsh-archive\session-abc-2026.json',
    eventCount: 4,
    turnCount: 2,
    requests: userRequests(realEvents, { limit: 1 }),
  })
  assert.ok(text.includes('旧上下文已完整归档'))
  assert.ok(text.includes('session-abc-2026.json'))
  assert.ok(text.includes('4 条事件'))
  assert.match(text, /read 这个文件/)
})
