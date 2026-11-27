import test from 'node:test'
import assert from 'node:assert/strict'
import { DIGEST_PROMPT, localDigest, parseDigest, pickLines, promptMaterial, sentences } from '../src/digest.js'

const facts = {
  files: [{ value: 'src/handoff.js', count: 3, turn: 4, extra: '' }],
  commands: [{ value: 'npm test', count: 2, turn: 4, extra: '' }],
  errors: [{ value: 'AssertionError: 待办为空', count: 1, turn: 3, extra: '' }],
  constraints: [{ value: '不要动 lib/ 目录', count: 1, turn: 1, extra: '' }],
  decisions: [{ value: '决定走本地规则摘要', count: 1, turn: 2, extra: '' }],
}

const input = {
  title: '优化交接文档',
  requests: [{ turn: 1, text: '把交接文档压短一点' }],
  todos: [
    { content: '压缩摘要', status: 'in_progress' },
    { content: '写测试', status: 'pending' },
  ],
  summaryLines: ['改了 handoff.js 的骨架'],
  facts,
  recent: [{ turn: 1, ask: '把交接文档压短一点', did: '改完骨架，测试 67 pass' }],
}

test('localDigest 产出四块且 source 为 local', () => {
  const digest = localDigest(input)
  assert.equal(digest.source, 'local')
  assert.equal(digest.headline, '压缩摘要')
  assert.ok(digest.next.some((line) => line.includes('压缩摘要')))
  assert.ok(digest.next.some((line) => line.includes('写测试')))
  assert.ok(digest.guard.some((line) => line.includes('不要动')))
})

test('localDigest 无待办时用最后一条要求当主线', () => {
  const digest = localDigest({ ...input, todos: [] })
  assert.ok(digest.headline.includes('把交接文档压短一点'))
})

test('localDigest 完全空输入不抛且四块都是数组', () => {
  const digest = localDigest({})
  for (const key of ['bullets', 'next', 'guard']) assert.ok(Array.isArray(digest[key]))
  assert.equal(typeof digest.headline, 'string')
})

test('pickLines 去重并优先高频行', () => {
  const lines = pickLines(
    [
      { text: '一次性的话', count: 1 },
      { text: '反复出现的话', count: 3 },
      { text: '反复出现的话', count: 3 },
    ],
    { maxLines: 2 },
  )
  assert.equal(lines[0], '反复出现的话')
  assert.ok(lines.includes('一次性的话'))
  // 重复项只出现一次
  assert.equal(lines.filter((line) => line === '反复出现的话').length, 1)
})

test('pickLines 丢掉纯收尾空话', () => {
  assert.deepEqual(pickLines(['好的', '收到！', '改完 handoff.js 的骨架']), ['改完 handoff.js 的骨架'])
})

test('sentences 按中英句末切句', () => {
  const list = sentences('第一句。第二句！第三句？')
  assert.ok(list.length >= 2)
})

test('promptMaterial 带上预算内的事实且不含未定义字样', () => {
  const material = promptMaterial(input, { budget: 4000 })
  assert.ok(material.includes('src/handoff.js'))
  assert.ok(material.includes('npm test'))
  assert.ok(!material.includes('undefined'))
})

test('parseDigest 解析模型 JSON（含代码围栏）', () => {
  const raw = '```json\n{"headline":"压缩交接文档","bullets":["改了骨架"],"next":["补测试"],"guard":["别动 lib/"]}\n```'
  const digest = parseDigest(raw)
  assert.equal(digest.source, 'llm')
  assert.equal(digest.headline, '压缩交接文档')
  assert.deepEqual(digest.next, ['补测试'])
})

test('parseDigest 遇到坏 JSON 返回 undefined（静默回落本地摘要）', () => {
  assert.equal(parseDigest('这不是 JSON'), undefined)
  assert.equal(parseDigest(''), undefined)
  assert.equal(parseDigest(undefined), undefined)
})

test('DIGEST_PROMPT 明确要求只输出 JSON 并保留原文细节', () => {
  assert.ok(DIGEST_PROMPT.includes('JSON'))
  assert.ok(DIGEST_PROMPT.includes('路径'))
})
