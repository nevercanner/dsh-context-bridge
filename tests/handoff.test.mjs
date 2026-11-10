import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHandoff, digestSummary, latestCompactionSummary, recentTurns, todosFromEvents } from '../src/handoff.js'

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

test('buildHandoff 产出包含三个关键小节', () => {
  const text = buildHandoff({
    projectRoot: 'D:\\openclaw-data\\demo',
    title: '修登录',
    sourceSessionId: 'session-abc',
    busName: '管线维护',
    todos: todosFromEvents(events),
    summaryLines: digestSummary(latestCompactionSummary(events)),
    recent: recentTurns(events, 3),
    todoLimit: 12,
  })
  assert.ok(text.includes('# 交接文档：demo'))
  assert.ok(text.includes('## 现在要做什么'))
  assert.ok(text.includes('## 下一步'))
  assert.ok(text.includes('补 token 过期测试'))
  assert.ok(!text.includes('[进行中] 改 auth 中间件'))
  assert.ok(text.includes('管线维护'))
})

test('buildHandoff 空输入也能产出可用骨架', () => {
  const text = buildHandoff({ projectRoot: '', todos: [], summaryLines: [], recent: [] })
  assert.ok(text.includes('## 现在要做什么'))
  assert.ok(text.includes('## 项目事实'))
})
