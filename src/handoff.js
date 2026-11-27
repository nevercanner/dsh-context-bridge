/**
 * 交接文档构建 —— 纯函数，无宿主依赖，可单独测试。
 *
 * 输入是已经收集好的「事实」：
 *   · 项目根、当前会话标题
 *   · 未完成/进行中的待办（来自 todo/write 事件；本机 tool-todo 未启用时为空）
 *   · 上下文摘要（宿主 compaction 的 summary；compaction 未启用时为空）
 *   · 关键信息（salient.js 提取的路径/命令/错误/约束/结论）
 *   · 压缩摘要（digest.js 的 headline/bullets/next/guard，本地或模型生成）
 *   · 最近若干轮的「用户要什么 / 助手做了什么」
 *   · **用户最近几条原始要求**（逐字保留 —— 待办和摘要都可能为空，只有这个是必有的）
 *   · 最近调用过的工具（证明「做到哪」而不是只说「做完了」）
 *   · 旧上下文归档文件路径 + 关键事件 seq（新会话可 read 它拿全文）
 *
 * 输出是一份 Markdown。设计目标是 **新会话第一屏就有用**：
 *
 *   ┌ 一句话主线          ← 20 字以内说清这活在干嘛
 *   ├ 已经做到哪 / 下一步  ← 各 ≤6 条，只留有证据的
 *   ├ 关键事实            ← 文件/命令/错误/约束，一行一条带次数
 *   ├ 最近几轮            ← 只有最近 3 轮，且每轮压成一行
 *   ├ 用户原始要求        ← 逐字，防「待办为空 = 任务丢失」
 *   └ 归档指针            ← 路径 + seq，细节全在文件里
 *
 * 字数预算是硬约束：多出来的东西**全部留在归档里**，交接文档不是会话副本。
 *
 * 为什么要在文档里放「原始要求」：真实事件形状是
 *   user/message → { content: [...] }        （**没有** turn 字段）
 *   assistant/message → { turn, step, message }
 *   turn/start|turn/end → { turn }
 * 早先的实现只认 message 事件自带的 data.turn，用户消息因此被整段丢掉，
 * 交接文档每次都只剩一句「源会话没有留下明确的当前任务」——新会话等于从零开始。
 * 现在轮次由 turn/start 推出，消息按当时的轮次归位；再不济也会逐字带上原始要求。
 */

import { factSections, salientFacts } from './salient.js'

const SECTION = {
  headline: '## 一句话',
  state: '## 已经做到哪',
  todo: '## 下一步',
  facts: '## 关键事实',
  requests: '## 用户最近的原始要求',
  recent: '## 最近几轮',
  avoid: '## 注意事项',
}

/** 交接文档的默认字数预算（正文，不含归档指针行）。超出时按节裁剪。 */
export const DEFAULT_DOC_BUDGET = 3000

function clip(text, limit) {
  const value = String(text ?? '').replace(/\r/g, '').trim()
  if (value.length <= limit) return value
  return `${Array.from(value).slice(0, Math.max(0, limit - 1)).join('')}…`
}

function oneLine(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 取一条消息事件里的纯文本：兼容 data.content（user/message）与 data.message.content（assistant/message）。 */
export function messageText(row) {
  const content = row?.data?.message?.content ?? row?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 从 todo/write 事件的 data 里读待办（宿主形状：{ todos: [{content,status}] }）。 */
export function todosFromEvents(events) {
  let latest
  for (const row of events) {
    if (row?.type !== 'todo/write') continue
    const list = row?.data?.todos
    if (Array.isArray(list)) latest = list
  }
  if (latest === undefined) return []
  return latest
    .filter((item) => item && typeof item.content === 'string')
    .map((item) => ({
      content: oneLine(item.content),
      status: ['completed', 'in_progress', 'pending'].includes(item.status) ? item.status : 'pending',
    }))
}

/** 取最后一条上下文摘要（compaction/summary 的 summary 是一个 content 数组）。 */
export function latestCompactionSummary(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const row = events[i]
    if (row?.type !== 'compaction/summary') continue
    const blocks = row?.data?.summary
    if (!Array.isArray(blocks)) continue
    const text = blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

/** 把一段摘要压成「目的 / 结论」两行，避免整段塞进交接文档。 */
export function digestSummary(summary, limit = 1200) {
  if (typeof summary !== 'string' || summary.trim() === '') return []
  const lines = summary
    .split('\n')
    .map((line) => oneLine(line.replace(/^[-*#>\s]+/, '')))
    .filter((line) => line !== '')
  if (lines.length === 0) return []
  const out = []
  let used = 0
  for (const line of lines) {
    if (used > limit) break
    out.push(line)
    used += line.length
  }
  return out
}

/**
 * 给每条消息定轮次。
 *
 * 真实日志里 user/message 只有 content，**没有 turn**；轮次信息只在
 * turn/start、turn/end、assistant/message、tool/call 上。所以这里用
 * turn/start 推着走：遇到 turn/start 就切轮；消息按「当前轮」归位。
 * 完全没有 turn 标记的日志（老格式/测试桩）退化成「一条用户消息 = 一轮」。
 */
export function turnMap(events) {
  const stamps = new Map()
  let current = 0
  let markers = false
  for (const row of events) {
    const declared = typeof row?.data?.turn === 'number' ? row.data.turn : undefined
    if (row?.type === 'turn/start') {
      markers = true
      current = declared ?? current + 1
      continue
    }
    if (declared !== undefined) {
      markers = true
      current = declared
    }
    const type = row?.type
    if (type !== 'user/message' && type !== 'assistant/message') continue
    if (!markers && type === 'user/message') current += 1
    stamps.set(row, current)
  }
  return { stampOf: (row) => stamps.get(row) ?? current, markers }
}

/**
 * 最近几轮的关键动作：每个 turn 取用户第一条文本 + 助手最后一条有内容的文本。
 * 只保留最后 `turns` 轮，防止交接文档自己变成大会话。
 */
export function recentTurns(events, turns = 3) {
  const { stampOf } = turnMap(events)
  const byTurn = new Map()
  for (const row of events) {
    const type = row?.type
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const turn = stampOf(row)
    const text = messageText(row)
    if (text === '') continue
    const slot = byTurn.get(turn) ?? { turn, ask: '', did: '' }
    if (type === 'user/message') {
      if (slot.ask === '') slot.ask = oneLine(text)
    } else {
      slot.did = oneLine(text)
    }
    byTurn.set(turn, slot)
  }
  return [...byTurn.values()].sort((left, right) => left.turn - right.turn).slice(-turns)
}

/**
 * 用户最近的原始要求（逐字，只压掉换行与多余空白）。
 * 待办（tool-todo 未启用）和摘要（compaction 未启用）都可能为空，
 * 但用户说过的话一定在日志里 —— 这是交接文档不空的最低保障。
 */
export function userRequests(events, { limit = 3, maxChars = 600 } = {}) {
  const { stampOf } = turnMap(events)
  const out = []
  for (const row of events) {
    if (row?.type !== 'user/message') continue
    const text = oneLine(messageText(row))
    if (text === '') continue
    out.push({ turn: stampOf(row), text: clip(text, maxChars) })
  }
  return out.slice(-limit)
}

/** 从 tool/call 的参数里挑一句最能说明「在干什么」的（命令/路径/查询优先）。 */
function toolHint(raw) {
  if (typeof raw !== 'string') return ''
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return clip(oneLine(raw), 100)
  }
  if (parsed === null || typeof parsed !== 'object') return ''
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'prompt', 'url']) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim() !== '') return clip(oneLine(value), 110)
  }
  const first = Object.values(parsed).find((value) => typeof value === 'string' && value.trim() !== '')
  return typeof first === 'string' ? clip(oneLine(first), 110) : ''
}

/** 最近调用的工具：证明「做到哪」，而不是只写一句「做完了」。 */
export function toolTrail(events, { limit = 12 } = {}) {
  const items = []
  let total = 0
  for (const row of events) {
    if (row?.type !== 'tool/call') continue
    total += 1
    const name = typeof row?.data?.name === 'string' ? row.data.name : 'tool'
    items.push({ name, hint: toolHint(row?.data?.arguments) })
  }
  return { total, items: items.slice(-limit) }
}

/** 一条事件在归档里的位置：能直接定位到 JSON 里第几条的 offset。 */
function eventIndexOf(events, predicate) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (predicate(events[i])) return i
  }
  return undefined
}

/**
 * 生成交接文档。
 *
 * @param {object} input
 * @param {string} input.projectRoot 项目根（只用于标题，不读盘）
 * @param {string} [input.title] 源会话标题
 * @param {string} [input.sourceSessionId] 源会话 id
 * @param {string} [input.busName] 会话总线注册名
 * @param {Array} [input.todos] 见 {@link todosFromEvents}
 * @param {string[]} [input.summaryLines] 见 {@link digestSummary}
 * @param {object} [input.facts] 见 {@link salientFacts}（不给就当场从 currentEvents 提取）
 * @param {Array} [input.currentEvents] 原始事件（可选，仅用于补提取关键事实与事件锚点）
 * @param {object} [input.digest] 见 {@link localDigest} / {@link parseDigest}
 * @param {Array} [input.recent] 见 {@link recentTurns}
 * @param {Array} [input.requests] 见 {@link userRequests}
 * @param {{total:number, items:Array}} [input.toolTrail] 见 {@link toolTrail}
 * @param {string} [input.archivePath] 旧上下文归档文件
 * @param {number} [input.eventCount] 归档里的事件数
 * @param {number} [input.turnCount] 源会话轮数
 * @param {number} [input.todoLimit] 最多列出几条待办
 * @param {number} [input.budget] 正文字数预算
 * @returns {string}
 */
export function buildHandoff(input) {
  const {
    projectRoot = '',
    title = '',
    sourceSessionId = '',
    busName = '',
    todos = [],
    summaryLines = [],
    recent = [],
    requests = [],
    toolTrail: trail = undefined,
    archivePath = '',
    eventCount = 0,
    turnCount = 0,
    todoLimit = 8,
    budget = DEFAULT_DOC_BUDGET,
  } = input ?? {}

  const events = Array.isArray(input?.currentEvents) ? input.currentEvents : undefined
  const facts =
    input?.facts !== null && typeof input?.facts === 'object'
      ? input.facts
      : events === undefined
        ? {}
        : salientFacts(events)
  const digest = input?.digest !== null && typeof input?.digest === 'object' ? input.digest : undefined

  const name = String(projectRoot).split(/[\\/]/).filter(Boolean).pop() ?? ''
  const lines = []

  lines.push(`# 交接文档${name === '' ? '' : `：${name}`}`)
  lines.push('')
  const origin = []
  if (title !== '') origin.push(`来自会话「${clip(oneLine(title), 60)}」`)
  if (sourceSessionId !== '') origin.push(`\`${sourceSessionId}\``)
  if (busName !== '') origin.push(`总线名 \`${busName}\``)
  if (origin.length > 0) {
    lines.push(`> ${origin.join(' · ')}`)
    lines.push('')
  }
  const scale = []
  if (turnCount > 0) scale.push(`${turnCount} 轮`)
  if (eventCount > 0) scale.push(`${eventCount} 条事件`)
  if (archivePath !== '') {
    lines.push(`> 旧上下文已完整归档：\`${clip(archivePath, 300)}\`${scale.length > 0 ? `（${scale.join(' / ')}）` : ''}`)
    if (events !== undefined && events.length > 0) {
      const anchors = []
      const lastUser = eventIndexOf(events, (row) => row?.type === 'user/message')
      const lastTool = eventIndexOf(events, (row) => row?.type === 'tool/result' || row?.type === 'tool/call')
      const firstTurn = eventIndexOf(events, (row) => row?.type === 'turn/start')
      if (firstTurn !== undefined) anchors.push(`turn/start=#${firstTurn}`)
      if (lastUser !== undefined) anchors.push(`最后用户消息=#${lastUser}`)
      if (lastTool !== undefined) anchors.push(`最后一个工具事件=#${lastTool}`)
      if (anchors.length > 0) lines.push(`> 定位用：\`context_snapshot.events[序号]\` → ${anchors.join('，')}`)
    }
    lines.push('> 要核对任何细节，直接 read 这个文件——里面有系统提示、全部用户/助手消息和工具调用记录。')
    lines.push('')
  } else if (scale.length > 0) {
    lines.push(`> 源会话规模：${scale.join(' / ')}`)
    lines.push('')
  }

  const pending = todos.filter((item) => item.status !== 'completed')
  const done = todos.filter((item) => item.status === 'completed')
  const inProgress = pending.find((item) => item.status === 'in_progress')
  const head = recent.length > 0 ? recent[recent.length - 1] : undefined
  const lastRequest = requests.length > 0 ? requests[requests.length - 1] : undefined

  // ── 一句话（摘要在最前面：新会话读第一屏就该知道在干嘛）──────────────
  const headline =
    digest !== undefined && typeof digest.headline === 'string' && digest.headline !== ''
      ? digest.headline
      : inProgress !== undefined
        ? clip(inProgress.content, 160)
        : lastRequest !== undefined
          ? clip(lastRequest.text, 160)
          : head !== undefined && head.ask !== ''
            ? clip(head.ask, 160)
            : '（源会话没有留下明确的当前任务，请看下面的关键事实并读归档）'
  lines.push(SECTION.headline)
  lines.push('')
  lines.push(`**${clip(oneLine(headline), 200)}**`)
  if (digest !== undefined && digest.source === 'llm') lines.push('')
  if (digest !== undefined && digest.source === 'llm') lines.push('> 主线由模型压缩生成；所有路径/命令/错误以「关键事实」与归档为准。')
  lines.push('')

  // ── 已经做到哪 ───────────────────────────────────────────────────────
  const didLines = []
  if (digest !== undefined && Array.isArray(digest.bullets) && digest.bullets.length > 0) {
    didLines.push(...digest.bullets)
  } else {
    if (done.length > 0) didLines.push(`已完成 ${done.length} 项：${clip(done.slice(-5).map((item) => item.content).join('；'), 400)}`)
    for (const line of summaryLines.slice(0, 5)) didLines.push(clip(line, 200))
    if (head !== undefined && head.did !== '') didLines.push(clip(head.did, 240))
  }
  lines.push(SECTION.state)
  lines.push('')
  if (didLines.length === 0) {
    lines.push('- （没有可提炼的结论：先读归档里的 assistant 消息，或直接看仓库 git status）')
  } else {
    for (const line of didLines.slice(0, 6)) lines.push(`- ${clip(line, 240)}`)
  }
  lines.push('')

  // ── 下一步 ───────────────────────────────────────────────────────────
  lines.push(SECTION.todo)
  lines.push('')
  const nextLines = []
  if (digest !== undefined && Array.isArray(digest.next) && digest.next.length > 0) nextLines.push(...digest.next)
  for (const item of pending.slice(0, todoLimit)) {
    const mark = item.status === 'in_progress' ? '进行中' : '待办'
    nextLines.push(`[${mark}] ${clip(item.content, 200)}`)
  }
  if (nextLines.length === 0) {
    if (lastRequest !== undefined) nextLines.push(`按「${clip(lastRequest.text, 120)}」继续，动手前先确认仓库当前状态`)
    else nextLines.push('（源会话没有留下待办；先 git status + 读归档，再决定做什么）')
  }
  for (const line of nextLines.slice(0, todoLimit)) lines.push(`- ${clip(line, 240)}`)
  if (pending.length > todoLimit) lines.push(`- ……另有 ${pending.length - todoLimit} 项，见源会话 todo 面板`)
  lines.push('')

  // ── 关键事实（路径/命令/错误/约束/结论，一行一条）────────────────────
  const groups = factSections(facts, { perGroup: 6 })
  if (groups.length === 0) {
    // 没有任何可提取的事实也要留标题 + 一句可操作的话：
    // 空一节会让新会话以为「这活没碰过文件」，其实是提取不到。
    lines.push(SECTION.facts)
    lines.push('')
    lines.push('- （日志里没有可提取的路径/命令/错误；去归档里 read assistant 消息与工具调用）')
    lines.push('')
  } else {
    lines.push(SECTION.facts)
    lines.push('')
    for (const group of groups) {
      lines.push(`**${group.title}**`)
      for (const line of group.lines) lines.push(`- ${clip(line, 220)}`)
    }
    lines.push('')
    if (Array.isArray(facts.constraints) && facts.constraints.length > 0) {
      lines.push('> 上面的「约束」是源会话里用户明说过的红线，新会话照做，不要重新发明。')
      lines.push('')
    }
  }

  // ── 用户原始要求（逐字）──────────────────────────────────────────────
  if (requests.length > 0) {
    lines.push(SECTION.requests)
    lines.push('')
    lines.push('> 逐字保留，防止「待办为空 = 任务丢失」。')
    lines.push('')
    for (const item of requests) {
      lines.push(`- 第 ${item.turn} 轮：${clip(item.text, 400)}`)
    }
    lines.push('')
  }

  // ── 最近几轮（一行一轮，最后才出现）──────────────────────────────────
  if (recent.length > 0) {
    lines.push(SECTION.recent)
    lines.push('')
    for (const slot of recent) {
      const ask = slot.ask === '' ? '（该轮没有用户消息）' : clip(slot.ask, 110)
      const did = slot.did === '' ? '' : ` → ${clip(slot.did, 130)}`
      lines.push(`- 第 ${slot.turn} 轮：${ask}${did}`)
    }
    lines.push('')
  }

  // ── 注意事项 ─────────────────────────────────────────────────────────
  lines.push(SECTION.avoid)
  lines.push('')
  if (digest !== undefined && Array.isArray(digest.guard)) {
    for (const line of digest.guard.slice(0, 3)) lines.push(`- ${clip(line, 180)}`)
  }
  if (trail !== undefined && trail.total > 0) {
    const shown = trail.items.map((item) => (item.hint === '' ? item.name : `${item.name}「${item.hint}」`)).join(' → ')
    lines.push(`- 源会话共 ${trail.total} 次工具调用，最近：${clip(shown, 400)}`)
  }
  lines.push(`- 工作目录：\`${clip(projectRoot, 260)}\``)
  lines.push('- 这是**自动生成的交接文档**，摘要和待办可能为空（取决于宿主是否装并启用了对应插件）；')
  lines.push('  需要原文时读上面的归档文件，那里是完整事件流，不是摘要。')
  lines.push('- 动手前先确认仓库当前状态（`git status` / 测试），不要假设本文件写完就没变化。')

  // ── 字数预算：超了就从「最近几轮 / 原始要求」往前砍，正文不许无限长 ──
  let text = lines.join('\n')
  const max = Number.isFinite(budget) && budget > 400 ? budget : DEFAULT_DOC_BUDGET
  if (text.length > max && recent.length > 0) {
    const start = lines.indexOf(SECTION.recent)
    const stop = lines.indexOf(SECTION.avoid)
    if (start >= 0 && stop > start) {
      lines.splice(start, stop - start)
      text = lines.join('\n')
    }
  }
  if (text.length > max) text = `${text.slice(0, max)}\n\n> （正文已按 ${max} 字预算截断，完整内容见上方归档文件）\n`

  return `${text.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
