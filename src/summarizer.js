/**
 * 可选：用宿主自己的模型服务给交接文档做一次「真压缩」。
 *
 * 为什么要有这一层：本地摘要（digest.js）只能挑句子、去重、截断，它不会
 * 把「改了 auth 中间件 + 加了 token 过期测试 + 测试 61 pass」合成一句
 * 「登录已从 session cookie 换成 JWT，测试全绿」。模型会。
 *
 * 为什么默认关着：强制交接发生在 `turn/end` 里，宿主正把这一轮收尾。
 * 在这里插一次网络调用，等于让每 15 轮的一轮收尾多等几秒；模型服务挂了、
 * 限流了、key 过期了，都会变成交接的失败原因。所以：
 *   · 默认 `summarizer.mode = 'local'`，只用本地摘要；
 *   · 只有项目配置显式写 `"summarizer": {"mode": "llm"}` 才走模型；
 *   · 走模型时也**绝不让失败冒出来**：超时、报错、格式不对 → 返回 undefined，
 *     调用方无声回退本地摘要。交接永远有产物。
 *
 * 这一层没有静态 import（与 handoff-host.js 同理）：llm 服务的形状随宿主版本
 * 漂移，静态 import `@deepseek-ai/*` 会让整个 entry 变 failed。
 */

import { resolve } from './ctx-services.js'
import { DIGEST_PROMPT, parseDigest, promptMaterial } from './digest.js'

/** 默认超时：超过这个时间就当模型不可用，走本地摘要。 */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 12_000

/**
 * 从 llm 服务流式结果里拼出文本。
 * 宿主的 chunk 形状是 `{ type: 'text-delta' | 'text', text }` 一类的增量对象，
 * 这里对几种常见形状都认，认不出就拼不出来 —— 由调用方回退。
 */
export function textOfChunks(chunks) {
  const parts = []
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (typeof chunk === 'string') {
      parts.push(chunk)
      continue
    }
    if (chunk === null || typeof chunk !== 'object') continue
    for (const key of ['text', 'delta', 'textDelta']) {
      if (typeof chunk[key] === 'string') {
        parts.push(chunk[key])
        break
      }
    }
    const content = chunk.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
    }
  }
  return parts.join('')
}

/** 一条最小的用户消息（宿主 llm.stream 只要求 messages 是消息对象数组）。 */
function userMessage(text) {
  return {
    id: `bridge-summary-${Date.now().toString(36)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * 调一次模型，拿结构化摘要。
 *
 * @param {object} ctx 宿主 context
 * @param {object} input
 * @param {object} input.route { provider, model, reasoningEffort? }
 * @param {object} input.material 交给 {@link promptMaterial} 的那份事实
 * @param {number} [input.timeoutMs]
 * @param {Function} [input.logger] logger.warn 用于失败留痕
 * @returns {Promise<{headline:string,bullets:string[],next:string[],guard:string[],source:'llm'}|undefined>}
 */
export async function modelDigest(ctx, input) {
  const route = input?.route
  if (route === undefined || route === null || route.provider === '' || route.model === '') return undefined
  const llm = resolve(ctx, 'llm')
  // prepareCall 与 stream 二者有其一就能用：有的宿主把「准备 + 开流」合并进
  // prepareCall 的返回值，llm 本体上反而没有 stream。只要求 stream 会误判成
  // 「没有 llm 服务」，静默丢掉整层模型摘要。
  if (llm === undefined || (typeof llm.stream !== 'function' && typeof llm.prepareCall !== 'function')) {
    return undefined
  }

  const material = promptMaterial(input.material)
  if (material.trim() === '') return undefined
  const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? input.timeoutMs
    : DEFAULT_SUMMARY_TIMEOUT_MS
  const controller = new AbortController()
  let timer
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`摘要超时（${timeoutMs}ms）`))
      }, timeoutMs)
      timer.unref?.()
    })
    const run = (async () => {
      const config = {
        provider: route.provider,
        model: route.model,
        ...(typeof route.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
      }
      let prepared
      if (typeof llm.prepareCall === 'function') {
        prepared = await llm.prepareCall(config, controller.signal)
      }
      const request = {
        ...(prepared === undefined ? config : prepared.config),
        messages: [userMessage(`${DIGEST_PROMPT}\n\n${material}`)],
        sessionId: 'dsh-context-bridge-summary',
        signal: controller.signal,
      }
      const stream = prepared !== undefined && typeof prepared.stream === 'function'
        ? prepared.stream(request)
        : llm.stream(request)
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      return textOfChunks(chunks)
    })()
    const text = await Promise.race([run, timeout])

    // race 超时后 run 仍在跑：补一个 catch，避免它后来的 rejection 变成
    // unhandledRejection 把宿主进程记一笔（abort 之后它基本都会 reject）
    run.catch(() => {})
    return parseDigest(text)
  } catch (error) {
    input?.logger?.warn?.(`[dsh-context-bridge] 模型摘要失败，回退本地摘要：${String(error)}`)
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
