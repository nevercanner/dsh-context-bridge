import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SUMMARY_TIMEOUT_MS, modelDigest, textOfChunks } from '../src/summarizer.js'

/** 最小 fakeCtx：只提供 llm 服务，形状与宿主一致（prepareCall + stream）。 */
function fakeCtx(streamImpl) {
  const calls = []
  return {
    calls,
    ctx: {
      llm: {
        prepareCall: async (config) => {
          calls.push({ kind: 'prepare', config })
          return {
            config,
            stream: (request) => {
              calls.push({ kind: 'stream', request })
              return streamImpl(request)
            },
          }
        },
      },
    },
  }
}

async function* chunksOf(text) {
  yield { type: 'text-delta', text }
}

const material = {
  title: '优化交接文档',
  requests: [{ turn: 1, text: '把交接文档压短' }],
  todos: [{ content: '压缩摘要', status: 'in_progress' }],
  facts: { files: [{ value: 'src/handoff.js', count: 2, turn: 2, extra: '' }] },
}

test('textOfChunks 认得几种增量形状', () => {
  assert.equal(textOfChunks([{ text: 'a' }, { delta: 'b' }, 'c']), 'abc')
  assert.equal(textOfChunks([{ content: [{ type: 'text', text: 'd' }] }]), 'd')
  assert.equal(textOfChunks(undefined), '')
})

test('modelDigest 走 prepareCall + stream 并解析模型输出', async () => {
  const { ctx, calls } = fakeCtx(() =>
    chunksOf('{"headline":"压缩交接文档","bullets":["改了骨架"],"next":["补测试"],"guard":[]}'),
  )
  const digest = await modelDigest(ctx, { route: { provider: 'p', model: 'm' }, material })
  assert.equal(digest.source, 'llm')
  assert.equal(digest.headline, '压缩交接文档')
  assert.deepEqual(digest.next, ['补测试'])
  assert.equal(calls.filter((item) => item.kind === 'stream').length, 1)
})

test('modelDigest 没有路由或服务时返回 undefined（不抛）', async () => {
  assert.equal(await modelDigest({}, { route: undefined, material }), undefined)
  assert.equal(await modelDigest({}, { route: { provider: 'p', model: 'm' }, material }), undefined)
})

test('modelDigest 材料为空时不发请求', async () => {
  const { ctx, calls } = fakeCtx(() => chunksOf('{}'))
  assert.equal(await modelDigest(ctx, { route: { provider: 'p', model: 'm' }, material: {} }), undefined)
  assert.equal(calls.length, 0)
})

test('modelDigest 超时返回 undefined 且留下 warn', async () => {
  const warns = []
  const { ctx } = fakeCtx(() => ({
    async *[Symbol.asyncIterator]() {
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      yield { text: '{}' }
    },
  }))
  const started = Date.now()
  const digest = await modelDigest(ctx, {
    route: { provider: 'p', model: 'm' },
    material,
    timeoutMs: 50,
    logger: { warn: (line) => warns.push(line) },
  })
  assert.equal(digest, undefined)
  assert.ok(Date.now() - started < 2_000)
  assert.ok(warns.some((line) => line.includes('回退本地摘要')))
})

test('modelDigest 流里抛错也回落成 undefined', async () => {
  const { ctx } = fakeCtx(() => ({
    async *[Symbol.asyncIterator]() {
      throw new Error('provider 500')
    },
  }))
  const digest = await modelDigest(ctx, {
    route: { provider: 'p', model: 'm' },
    material,
    logger: { warn: () => {} },
  })
  assert.equal(digest, undefined)
})

test('modelDigest 默认超时常量合理', () => {
  assert.ok(DEFAULT_SUMMARY_TIMEOUT_MS >= 5_000 && DEFAULT_SUMMARY_TIMEOUT_MS <= 30_000)
})
