/**
 * 压缩摘要 —— 交接文档的「一屏就能看懂」层。
 *
 * 目标：不管源会话是 15 轮还是 200 轮，新会话拿到的必然是：
 *   1. 一段**一句话主线**（这活到底在干嘛）
 *   2. 一张**继续干的最小清单**（下一步 / 别碰什么）
 *   3. 一份**可追溯的指针**（归档文件 + 关键事件 seq）
 * 而不是把最近十几轮原样倒一遍。
 *
 * 两条生成路径，优先级明确：
 *   · **模型摘要**（宿主 llm 服务，可选）：把各轮要点交给同一个模型压成
 *     结构化梳理。只在 `summarizer.mode === 'llm'` 时启用，失败/超时一律
 *     安静回退到本地摘要 —— 强制交接发生在 turn/end 里，不能因为摘要失败
 *     把交接撕掉。
 *   · **本地摘要**（默认）：纯确定性打分，从原始要求、待办、关键事实里
 *     挑句子 + 去重 + 控字数。零延迟、零副作用，永远可用。
 *
 * 两种路径的输出形状一致，{@link buildHandoff} 只认这一种形状。
 */

import { cut, squash } from './salient.js'

/** 一句话主线的最大字数。 */
const HEADLINE_MAX = 160
/** 各小节上限：宁可少一行，也不要让交接文档自己变成大会话。 */
const BULLET_MAX = 6
/** 整份摘要的字数上限（不含归档指针）。 */
export const SUMMARY_BUDGET = 1400

/** 「关键结论」需要的动词：没有这些词的句子多半是过程，不是结论。 */
const OUTCOME = /(通过|已改|改成|改为|完成|搞定|实现|修复|新增|删除|迁移|上线|发布|合并|打通|减少|提升|pass|OK|构建成功|验证通过)/i

/** 空泛收尾：这些话不带任何可用信息。 */
const FLUFF = /^(好的|收到|明白|了解|可以|OK|ok|嗯|行|没问题)[。！!.、\s]*$/

/** 把一行切成句子（中英文标点都切，避免整段被当成一句）。 */
export function sentences(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .split(/(?<=[。！？；;!?])|\n/)
    .map((line) => squash(line.replace(/^[-*+>#\d.\s]+/, '')))
    .filter((line) => line !== '')
}

/**
 * 从候选句子池里挑「最该被带走」的几句：去重 → 去空话 → 按打分排序 →
 * 截断到字数预算。
 *
 * 打分（越大越留）：
 *   +3 带出现次数（重复提到 = 主线）
 *   +2 命中 OUTCOME / 判定词（结论而非过程）
 *   +1 带路径或反引号（可定位）
 *   -2 超过 200 字（长句子通常在复述日志）
 */
export function pickLines(candidates, { maxLines = BULLET_MAX, budget = 900 } = {}) {
  const scored = []
  const seen = new Set()
  for (const item of Array.isArray(candidates) ? candidates : []) {
    const text = squash(typeof item === 'string' ? item : item?.text)
    if (text === '' || FLUFF.test(text)) continue
    const key = text.toLowerCase().replace(/[，。；、,.!?！？\s]/g, '')
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    const count = typeof item === 'object' && Number.isFinite(item?.count) ? item.count : 1
    let score = 0
    if (count > 1) score += 3
    if (OUTCOME.test(text) || /(结论|决定|根因|原因|注意|必须|不要)/.test(text)) score += 2
    if (/[\\/`]/.test(text)) score += 1
    if (text.length > 200) score -= 2
    scored.push({ text, score, order: scored.length })
  }
  scored.sort((left, right) => right.score - left.score || left.order - right.order)
  const out = []
  let used = 0
  for (const item of scored) {
    if (out.length >= maxLines) break
    if (used + item.text.length > budget && out.length > 0) break
    out.push(cut(item.text, 220))
    used += item.text.length
  }
  return out
}

/**
 * 本地摘要：完全确定性的「压缩」。输入就是 collect 阶段已经解析好的事实，
 * 不读盘、不联网。
 *
 * @param {object} input
 * @param {string} [input.title] 源会话标题
 * @param {Array<{turn:number,text:string}>} [input.requests] 用户原始要求
 * @param {Array<{content:string,status:string}>} [input.todos] 待办
 * @param {string[]} [input.summaryLines] 宿主 compaction 摘要行
 * @param {object} [input.facts] {@link salientFacts} 的输出
 * @param {Array<{turn:number,ask:string,did:string}>} [input.recent] 最近几轮
 * @returns {{headline:string, bullets:string[], next:string[], guard:string[], source:'local'|'llm'}}
 */
export function localDigest(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const requests = Array.isArray(source.requests) ? source.requests : []
  const todos = Array.isArray(source.todos) ? source.todos : []
  const recent = Array.isArray(source.recent) ? source.recent : []
  const facts = source.facts !== null && typeof source.facts === 'object' ? source.facts : {}
  const title = squash(source.title)
  const lastRequest = requests.length > 0 ? squash(requests[requests.length - 1].text) : ''
  const head = recent.length > 0 ? recent[recent.length - 1] : undefined
  const inProgress = todos.find((item) => item && item.status === 'in_progress')
  // 工具轨迹：证「做到哪」比助手自述更硬（它说做完了，但最后一次调用失败过）
  const trail = source.toolTrail !== null && typeof source.toolTrail === 'object' ? source.toolTrail : undefined

  // ── 一句话主线：正在做的待办 > 最后一条要求 > 上一轮提问 > 标题 ──
  // 主线必须是「这一轮在干什么」。把标题排在最后，是因为侧栏标题常常是
  // 会话刚开始时起的泛化名字，十几轮后早就不是主线了。
  let headline = ''
  if (inProgress !== undefined && typeof inProgress.content === 'string') headline = squash(inProgress.content)
  if (headline === '' && lastRequest !== '') headline = sentences(lastRequest)[0] ?? lastRequest
  if (headline === '' && head !== undefined && squash(head.ask) !== '') headline = squash(head.ask)
  if (headline === '' && title !== '') headline = title
  if (headline === '') headline = '（源会话没有留下明确的当前任务，请看下面的关键事实并读归档）'
  headline = cut(headline, HEADLINE_MAX)

  // ── 已经做到哪：只把**结论**留下，过程话术（"我来看看"）一律丢 ──
  // 排序靠 pickLines 的打分：命中 OUTCOME 的、重复出现的、带路径的优先。
  const outcomeCandidates = [
    ...todos
      .filter((item) => item && item.status === 'completed' && typeof item.content === 'string')
      .map((item) => ({ text: item.content })),
    ...(Array.isArray(source.summaryLines) ? source.summaryLines.map((line) => ({ text: line })) : []),
    ...(Array.isArray(facts.decisions) ? facts.decisions.map((item) => ({ text: item.value, count: item.count })) : []),
    ...recent.map((slot) => ({ text: squash(slot?.did) })),
    // 「改动集中在 X」只留**最高频的三个文件**一条：文件清单在「关键事实」里
    // 已经全列了，这里再说三遍只是把真正有价值的结论挤出前 6 行。
    ...(Array.isArray(facts.files) && facts.files.length > 0
      ? [{
          text: `改动集中在 ${facts.files.slice(0, 3).map((item) => item.value).join('、')}`,
          count: 2,
        }]
      : []),
  ]
  const bullets = pickLines(outcomeCandidates, { maxLines: BULLET_MAX, budget: 700 })
  if (bullets.length === 0 && trail !== undefined && trail.total > 0) {
    bullets.push(`源会话共 ${trail.total} 次工具调用（最近 ${trail.items.length} 条见「注意事项」）`)
  }

  // ── 下一步：未完成待办优先，其次「按最后要求继续」 ──
  const next = []
  const inProgressFirst = todos.filter((item) => item && item.status === 'in_progress')
  const pending = todos.filter((item) => item && item.status !== 'completed')
  for (const item of [...inProgressFirst, ...pending]) {
    if (item === null || typeof item !== 'object' || typeof item.content !== 'string') continue
    const line = cut(squash(item.content), 200)
    if (line === '' || next.includes(line)) continue
    next.push(line)
    if (next.length >= BULLET_MAX) break
  }
  if (next.length === 0 && lastRequest !== '') next.push(`按最后要求继续：${cut(lastRequest, 200)}`)
  if (next.length === 0) next.push('源会话没有留下待办：先 git status + 读归档，再决定做什么')

  // ── 别碰 / 必须遵守：约束 + 错误原文里最痛的那一条 ──
  // 约束必须去重后**合并成一条**：源会话里同一句红线每轮都可能复述一遍，
  // 原样列出来会把「注意事项」撑成一堵墙，新会话反而看不见真正的那条。
  const guard = []
  const constraintSet = new Set()
  for (const item of Array.isArray(facts.constraints) ? facts.constraints : []) {
    const text = squash(item.value)
    if (text === '' || constraintSet.has(text)) continue
    constraintSet.add(text)
    guard.push(cut(text, 160))
    if (guard.length >= 4) break
  }
  const errors = Array.isArray(facts.errors) ? facts.errors : []
  if (errors.length > 0) {
    const worst = errors[0]
    const line = `上次踩的坑：${squash(worst.value)}${worst.count > 1 ? `（出现 ${worst.count} 次）` : ''}`
    if (!guard.includes(line)) guard.push(cut(line, 200))
  }
  if (guard.length === 0 && trail !== undefined && trail.total === 0) {
    guard.push('源会话没有任何工具调用：这段上下文可能只有讨论，动手前先确认仓库现状')
  }

  const total = headline.length + bullets.join('').length + next.join('').length + guard.join('').length
  if (total > SUMMARY_BUDGET) {
    while (bullets.length > 2 && headline.length + bullets.join('').length + next.join('').length > SUMMARY_BUDGET) {
      bullets.pop()
    }
  }

  return { headline: cut(headline, HEADLINE_MAX), bullets, next, guard, source: 'local' }
}

/**
 * 把交接所需的原始事实压成一段**给模型看的**提示词素材（不超预算）。
 * 只送提炼过的行，不送整个会话日志 —— 摘要调用本身也不该吃满上下文。
 */
export function promptMaterial(input, { budget = 9000 } = {}) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const facts = source.facts !== null && typeof source.facts === 'object' ? source.facts : {}
  const lines = []
  const push = (label, value) => {
    const text = squash(value)
    if (text !== '') lines.push(`${label}${cut(text, 400)}`)
  }
  push('会话标题：', source.title)
  for (const item of Array.isArray(source.requests) ? source.requests.slice(-6) : []) {
    push(`第${item.turn}轮用户要求：`, item.text)
  }
  for (const item of Array.isArray(source.todos) ? source.todos : []) {
    push(`待办[${item.status}]：`, item.content)
  }
  for (const item of Array.isArray(source.recent) ? source.recent : []) {
    push(`第${item.turn}轮助手结论：`, item.did)
  }
  const group = (label, key, limit = 8) => {
    for (const item of Array.isArray(facts[key]) ? facts[key].slice(0, limit) : []) {
      push(label, item.count > 1 ? `${item.value}（出现 ${item.count} 次）` : item.value)
    }
  }
  group('文件：', 'files')
  group('命令：', 'commands')
  group('错误：', 'errors')
  group('约束：', 'constraints')
  group('结论：', 'decisions')

  const text = lines.join('\n')
  return text.length <= budget ? text : cut(text, budget)
}

/** 交给模型的固定指令：输出格式必须与 localDigest 一致，宿主才能无差别消费。 */
export const DIGEST_PROMPT = [
  '你在给一个新会话写交接摘要。它看不到旧对话，只能看到你写的这几行。',
  '把下面这份会话要点压成 JSON，只输出 JSON，不要解释：',
  '{"headline":"一句话说明这活现在在干什么（≤120字）",',
  '"bullets":["已经做到哪：只写有证据的结论，≤6条"],',
  '"next":["下一步：可执行动作，≤5条"],',
  '"guard":["别踩的坑/必须遵守的约束，≤3条"]}',
  '硬要求：原文里的文件路径、命令、错误信息必须原样保留；不要写“继续推进”“按计划进行”这类空话；',
  '如果某节确实没有内容，给空数组。',
].join('\n')

/** 把模型返回的文本解析成摘要结构；格式不对就返回 undefined（调用方回退本地摘要）。 */
export function parseDigest(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return undefined
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const strings = (value, limit) =>
    Array.isArray(value)
      ? value
          .filter((item) => typeof item === 'string')
          .map((item) => cut(squash(item), 220))
          .filter((item) => item !== '')
          .slice(0, limit)
      : []
  const headline = cut(squash(parsed.headline), HEADLINE_MAX)
  const bullets = strings(parsed.bullets, BULLET_MAX)
  const next = strings(parsed.next, BULLET_MAX)
  const guard = strings(parsed.guard, 3)
  if (headline === '' && bullets.length === 0 && next.length === 0) return undefined
  return {
    headline: headline === '' ? '（模型摘要未给出主线，见下面的关键事实）' : headline,
    bullets,
    next,
    guard,
    source: 'llm',
  }
}
