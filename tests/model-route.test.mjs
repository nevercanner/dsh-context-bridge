import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgentOptions, runHandoff } from '../src/handoff-host.js'

/**
 * 回归：交接出的新会话必须带模型路由。
 *
 * 宿主 AgentLoop.prepareRequest() 只认 AgentOptions.provider/model（或 agent/request
 * waterfall 的返回）；两个都空就抛
 * `agent "..." has no provider/model: set AgentOptions.provider and AgentOptions.model`，
 * 用户看到的是「本轮运行失败」——建会话成功、第一轮开跑就死。
 * 所以 agents.create 必须收到 agentOptions。
 */

function agentsSpy() {
  const created = []
  return {
    created,
    async create(options) {
      created.push(options)
      return { agent: { id: options.sessionId } }
    },
    get: () => ({ followup() {} }),
  }
}

function ctxOf({ projectRoot, agents, agentDefaultModel }) {
  const services = {
    logger: { info() {}, warn() {}, debug() {} },
    agents,
    sessionQuery: {
      async observeSession() {
        const observation = { events: [{ type: 'user/message', data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: '继续' }] } } }] }
        observation[Symbol.dispose] = () => {}
        return observation
      },
    },
    workingDirectory: { get: () => projectRoot },
    sessionTitle: { current: () => '标题' },
    ...(agentDefaultModel === undefined ? {} : { agentDefaultModel }),
  }
  return {
    get: (name) => services[name],
  }
}

test('resolveAgentOptions: 优先取源会话最近一次实际请求的路由', () => {
  const agent = {
    options: { provider: 'old', model: 'old-model' },
    session: { requestHeader: () => ({ config: { provider: 'pi-ai', model: 'gpt-4.1', reasoningEffort: 'high' } }) },
  }
  assert.deepEqual(resolveAgentOptions(ctxOf({ agents: agentsSpy() }), agent), {
    provider: 'pi-ai',
    model: 'gpt-4.1',
    reasoningEffort: 'high',
  })
})

test('resolveAgentOptions: 没有请求头时退到 AgentOptions', () => {
  const agent = { options: { provider: 'deepseek', model: 'deepseek-chat' }, session: { requestHeader: () => undefined } }
  assert.deepEqual(resolveAgentOptions(ctxOf({ agents: agentsSpy() }), agent), {
    provider: 'deepseek',
    model: 'deepseek-chat',
  })
})

test('resolveAgentOptions: 两处都空时退到部署默认模型', () => {
  const ctx = ctxOf({
    agents: agentsSpy(),
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-reasoner' }) },
  })
  assert.deepEqual(resolveAgentOptions(ctx, { session: {} }), {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
  })
})

test('resolveAgentOptions: 全部拿不到时返回 undefined，不编造路由', () => {
  assert.equal(resolveAgentOptions(ctxOf({ agents: agentsSpy() }), { session: {} }), undefined)
  assert.equal(resolveAgentOptions(ctxOf({ agents: agentsSpy() }), undefined), undefined)
})

test('resolveAgentOptions: requestHeader 抛异常也不崩', () => {
  const agent = {
    session: {
      requestHeader() {
        throw new Error('boom')
      },
    },
    options: { provider: 'p', model: 'm' },
  }
  assert.deepEqual(resolveAgentOptions(ctxOf({ agents: agentsSpy() }), agent), { provider: 'p', model: 'm' })
})

test('runHandoff: agents.create 收到 agentOptions（这就是那个报错的根因）', async () => {
  const agents = agentsSpy()
  const ctx = ctxOf({
    projectRoot: 'D:\\openclaw-data\\demo',
    agents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
  })
  const result = await runHandoff(ctx, {
    sourceSessionId: 'session-src',
    agent: {
      session: {
        id: 'session-src',
        requestHeader: () => ({ config: { provider: 'pi-ai', model: 'gpt-4.1' } }),
      },
    },
    config: {},
    randomUUID: () => 'fix1',
  })
  assert.equal(result.ok, true)
  assert.equal(agents.created.length, 1)
  assert.deepEqual(agents.created[0].agentOptions, { provider: 'pi-ai', model: 'gpt-4.1' })
  assert.ok(result.detail.includes('pi-ai/gpt-4.1'), `detail 应回显模型路由，实际：${result.detail}`)
})

test('runHandoff: 拿不到路由时仍建会话，但在 detail 里显式告警', async () => {
  const agents = agentsSpy()
  const ctx = ctxOf({ projectRoot: 'D:\\openclaw-data\\demo', agents })
  const result = await runHandoff(ctx, {
    sourceSessionId: 'session-src',
    agent: { session: { id: 'session-src' } },
    config: {},
    randomUUID: () => 'fix2',
  })
  assert.equal(result.ok, true)
  assert.equal(agents.created[0].agentOptions, undefined)
  assert.ok(result.detail.includes('has no provider/model'), `detail 应提前告警，实际：${result.detail}`)
})
