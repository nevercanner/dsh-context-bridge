import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeRepeats, pickLines } from '../src/digest.js'

test('mergeRepeats: 同一结论逐轮重复时合成一条', () => {
  const merged = mergeRepeats([
    { text: 'module 10 补完，npm test 91 pass' },
    { text: 'module 11 补完，npm test 91 pass' },
    { text: 'module 12 补完，npm test 91 pass' },
  ])
  assert.equal(merged.length, 1)
  assert.match(merged[0].text, /^module 10 补完 等 3 项，npm test 91 pass$/)
  assert.equal(merged[0].count, 4)
})

test('mergeRepeats: 两条重复合并成「A、B，结论」', () => {
  const merged = mergeRepeats([
    { text: '登录页改完，构建成功' },
    { text: '设置页改完，构建成功' },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].text, '登录页改完、设置页改完，构建成功')
})

test('mergeRepeats: 结论不同就不合并', () => {
  const merged = mergeRepeats([
    { text: 'module 10 补完，npm test 91 pass' },
    { text: 'module 11 补完，构建生成失败' },
  ])
  assert.equal(merged.length, 2)
})

test('mergeRepeats: 不含结论词的行原样保留，不参与合并', () => {
  const merged = mergeRepeats([{ text: '先看 README，了解结构' }, { text: '跑了一下 git status，情况正常' }])
  assert.equal(merged.length, 2)
  assert.equal(merged[0].text, '先看 README，了解结构')
})

test('mergeRepeats: 被合并的那条只占一行，挤出别的结论的空间', () => {
  const candidates = [
    { text: 'module 10 补完，npm test 91 pass' },
    { text: 'module 11 补完，npm test 91 pass' },
    { text: 'module 12 补完，npm test 91 pass' },
    { text: '约定用 pnpm 而不是 npm，已写进 AGENTS.md' },
  ]
  const picked = pickLines(mergeRepeats(candidates), { maxLines: 3 })
  assert.equal(picked.length, 2)
  assert.ok(picked.some((line) => line.includes('npm test 91 pass')))
  assert.ok(picked.some((line) => line.includes('AGENTS.md')))
})

test('mergeRepeats: 空输入与脏输入不抛', () => {
  assert.deepEqual(mergeRepeats([]), [])
  assert.deepEqual(mergeRepeats(undefined), [])
  assert.deepEqual(mergeRepeats([null, { text: '   ' }, '纯字符串']), [{ text: '纯字符串', count: undefined, turn: undefined }])
})
