import test from 'node:test'
import assert from 'node:assert/strict'
import { factSections, rankFacts, salientFacts, squash } from '../src/salient.js'

const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { content: [{ type: 'text', text: '修一下 handoff 的文档，不要动 lib/ 目录' }] } },
  { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '决定用本地规则摘要，不引入网络依赖' }] } } },
  {
    type: 'tool/call',
    data: {
      turn: 1,
      name: 'edit',
      arguments: '{"file_path":"src/handoff.js","old_string":"a","new_string":"b"}',
    },
  },
  {
    type: 'tool/call',
    data: { turn: 1, name: 'ops_bash', arguments: '{"description":"跑测试","command":"npm test"}' },
  },
  {
    type: 'tool/result',
    data: {
      turn: 1,
      message: { isError: true, content: [{ type: 'text', text: 'AssertionError: 空的待办数组\n    at x' }] },
    },
  },
  { type: 'turn/start', data: { turn: 2 } },
  {
    type: 'tool/call',
    data: { turn: 2, name: 'edit', arguments: '{"file_path":"src/handoff.js","old_string":"c","new_string":"d"}' },
  },
  { type: 'turn/end', data: { turn: 2 } },
]

test('salientFacts 提取文件路径并按次数合并', () => {
  const facts = salientFacts(events)
  const handoff = facts.files.find((item) => item.value === 'src/handoff.js')
  assert.ok(handoff !== undefined)
  assert.equal(handoff.count, 2)
  assert.equal(handoff.turn, 2)
})

test('salientFacts 提取命令与错误原文', () => {
  const facts = salientFacts(events)
  assert.ok(facts.commands.some((item) => item.value === 'npm test'))
  assert.ok(facts.errors.some((item) => item.value.includes('AssertionError')))
  // 错误只要首行，不要把栈带进交接文档
  assert.ok(facts.errors.every((item) => !item.value.includes('at x')))
})

test('salientFacts 提取用户明说的约束', () => {
  const facts = salientFacts(events)
  assert.ok(facts.constraints.some((item) => item.value.includes('不要动')))
})

test('salientFacts 空事件不抛', () => {
  const facts = salientFacts([])
  assert.deepEqual(facts.files, [])
  assert.deepEqual(facts.commands, [])
})

test('rankFacts 按次数再按最后出现排序', () => {
  const ranked = rankFacts(
    new Map([
      ['a.js', { value: 'a.js', count: 1, turn: 5, extra: '' }],
      ['b.js', { value: 'b.js', count: 3, turn: 1, extra: '' }],
    ]),
    { limit: 2 },
  )
  assert.deepEqual(ranked.map((item) => item.value), ['b.js', 'a.js'])
})

test('factSections 只输出有内容的分组', () => {
  const sections = factSections(salientFacts(events), { perGroup: 6 })
  const titles = sections.map((item) => item.title)
  assert.ok(titles.includes('改动/涉及的文件'))
  assert.ok(titles.includes('跑过的关键命令'))
  assert.ok(titles.includes('踩过的坑（错误原文）'))
  assert.ok(!titles.includes('结论与决定') || sections.find((s) => s.title === '结论与决定').lines.length > 0)
})

test('squash 折掉换行与多余空白', () => {
  assert.equal(squash('  a \n b\t c '), 'a b c')
})
