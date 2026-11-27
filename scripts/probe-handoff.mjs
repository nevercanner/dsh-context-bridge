/**
 * 端到端探针：用假宿主跑一遍 runHandoff，把生成的交接文档打印出来。
 * 只在本地体检用，不进测试集（tests/ 只放断言）。
 *
 *   node scripts/probe-handoff.mjs
 */
import { runHandoff } from '../src/handoff-host.js'
import { normalizeConfig } from '../src/project-config.js'

const turns = []
let turn = 0
const push = (row) => turns.push(row)

/** 造一段 12 轮的真实形状事件流：用户消息没有 turn，轮次在 turn/start 上。 */
for (let i = 1; i <= 12; i += 1) {
  turn = i
  push({ type: 'turn/start', data: { turn } })
  push({ type: 'user/message', data: { content: [{ type: 'text', text: `第 ${turn} 轮：把 ${turn} 号模块的导出补上，别动 lib/` }] } })
  push({ type: 'tool/call', data: { turn, name: 'ops_read_files', arguments: JSON.stringify({ files: [{ path: `src/mod${turn}.js`, offset: 1, limit: 40 }] }) } })
  push({ type: 'tool/call', data: { turn, name: 'edit', arguments: JSON.stringify({ file_path: `src/mod${turn}.js`, old_string: 'a', new_string: 'b' }) } })
  if (turn % 4 === 0) {
    push({
      type: 'tool/result',
      data: { turn, message: { isError: true, content: [{ type: 'text', text: 'AssertionError: 期望 3 实际 2\n    at tests/x.test.mjs:12' }] } },
    })
  }
  push({ type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `module ${turn} 补完，npm test 91 pass` }] } } })
  push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

const sessionId = 'session-probe'
const projectRoot = process.cwd()

const events = [...turns]
const ctx = {
  get(name) {
    if (name === 'sessionQuery') {
      return {
        observeSession: async () => ({
          header: { cwd: projectRoot },
          events,
          [Symbol.dispose]() {},
        }),
        readSession: async () => ({ session: { cwd: projectRoot }, events, inheritedEventCount: 0 }),
      }
    }
    if (name === 'agents') {
      return {
        create: async (options) => {
          created = options
        },
        get: (id) => ({ followup: (message) => { seeded = message } }),
      }
    }
    if (name === 'workingDirectory') return { get: () => projectRoot }
    if (name === 'sessionTitle') return { get: () => '探针会话' }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'probe', model: 'probe-1' }) }
    if (name === 'workspaceRegistry') return { archiveSession: async () => {}, attachSession: () => {} }
    return undefined
  },
}

let created
let seeded

const result = await runHandoff(ctx, {
  sourceSessionId: sessionId,
  projectRoot,
  config: normalizeConfig({}),
})

console.log('=== runHandoff 结果 ===')
console.log('ok:', result.ok)
console.log('detail:', result.detail)
console.log('archiveFile:', result.archiveFile)
console.log('种子消息投递:', seeded === undefined ? '否' : `是（${seeded.content[0].text.length} 字）`)
console.log('')
console.log('=== 交接文档正文 ===')
console.log(result.text ?? result.detail)
