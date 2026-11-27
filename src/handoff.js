/**
 * 交接文档构建 —— 纯函数，无宿主依赖，可单独测试。
 *
 * 输入是已经收集好的「事实」：
 *   · 项目根、当前会话标题
 *   · 未完成/进行中的待办（来自 todo/write 事件；本机 tool-todo 未启用时为空）
 *   · 上下文摘要（宿主 compaction 的 summary；compaction 未启用时为空）
 *   · 最近若干轮的「用户要什么 / 助手做了什么」
 *   · **用户最近几条原始要求**（逐字保留 —— 待办和摘要都可能为空，只有这个是必有的）
 *   · 最近调用过的工具（证明「做到哪」而不是只说「做完了」）
 *   · 旧上下文归档文件路径（新会话可 read 它拿全文）
 *
 * 输出是一份 Markdown。设计目标：**新会话第一屏就有用**，而不是一大段复述。
 *
 * 为什么要在文档里放「原始要求」：真实事件形状是
 *   user/message → { content: [...] }        （**没有** turn 字段）
 *   assistant/message → { turn, step, message }
 *   turn/start|turn/end → { turn }
 * 早先的实现只认 message 事件自带的 data.turn，用户消息因此被整段丢掉，
 * 交接文档每次都只剩一句「源会话没有留下明确的当前任务」——新会话等于从零开始。
 * 现在轮次由 turn/start 推出，消息按当时的轮次归位；再不济也会逐字带上原始要求。
 */

const SECTION = {
  goal: '## 现在要做什么',
  requests: '## 用户最近的原始要求',
  state: '## 已经做到哪',
  todo: '## 下一步',
  facts: '## 项目事实',
  avoid: '## 注意',
}

function clip(text, limit) {
  const value = String(text ?? '').replace(/\r/g, '').trim()
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
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
 * @param {Array} [input.recent] 见 {@link recentTurns}
 * @param {Array} [input.requests] 见 {@link userRequests}
 * @param {{total:number, items:Array}} [input.toolTrail] 见 {@link toolTrail}
 * @param {string} [input.archivePath] 旧上下文归档文件
 * @param {number} [input.eventCount] 归档里的事件数
 * @param {number} [input.turnCount] 源会话轮数
 * @param {number} [input.todoLimit] 最多列出几条待办
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
    todoLimit = 12,
  } = input ?? {}

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
    lines.push('> 要核对任何细节，直接 read 这个文件——里面有系统提示、全部用户/助手消息和工具调用记录。')
    lines.push('')
  } else if (scale.length > 0) {
    lines.push(`> 源会话规模：${scale.join(' / ')}`)
    lines.push('')
  }

  const pending = todos.filter((item) => item.status !== 'completed')
  const done = todos.filter((item) => item.status === 'completed')

  lines.push(SECTION.goal)
  lines.push('')
  const inProgress = pending.find((item) => item.status === 'in_progress')
  const head = recent.length > 0 ? recent[recent.length - 1] : undefined
  const lastRequest = requests.length > 0 ? requests[requests.length - 1] : undefined
  if (inProgress !== undefined) lines.push(`- 正在做：${clip(inProgress.content, 200)}`)
  else if (lastRequest !== undefined) lines.push(`- 用户最后的要求：${clip(lastRequest.text, 400)}`)
  else if (head !== undefined && head.ask !== '') lines.push(`- 上一轮的要求：${clip(head.ask, 200)}`)
  else lines.push('- （源会话没有留下明确的当前任务，请看下面的项目事实；完整上下文见归档文件）')
  if (head !== undefined && head.did !== '') lines.push(`- 上一轮的结论：${clip(head.did, 300)}`)
  lines.push('')

  if (requests.length > 0) {
    lines.push(SECTION.requests)
    lines.push('')
    lines.push('> 逐字保留，防止「待办为空 = 任务丢失」。')
    lines.push('')
    for (const item of requests) {
      lines.push(`- 第 ${item.turn} 轮：${clip(item.text, 600)}`)
    }
    lines.push('')
  }

  lines.push(SECTION.state)
  lines.push('')
  if (done.length > 0) lines.push(`- 已完成 ${done.length} 项：${clip(done.slice(-5).map((item) => item.content).join('；'), 400)}`)
  if (summaryLines.length > 0) {
    for (const line of summaryLines.slice(0, 8)) lines.push(`- ${clip(line, 220)}`)
  } else if (done.length === 0 && requests.length === 0) {
    lines.push('- （没有可提炼的摘要，建议先读一遍项目里的 README / 变更记录）')
  }
  if (trail !== undefined && trail.total > 0) {
    const shown = trail.items
      .map((item) => (item.hint === '' ? item.name : `${item.name}「${item.hint}」`))
      .join(' → ')
    lines.push(`- 共 ${trail.total} 次工具调用，最近：${clip(shown, 700)}`)
  }
  lines.push('')

  lines.push(SECTION.todo)
  lines.push('')
  if (pending.length === 0) {
    lines.push('- （源会话没有留下待办清单：这个宿主上 tool-todo 可能未启用，交接前没有调用过它）')
    if (lastRequest !== undefined) lines.push('- 按上面「用户最后的要求」继续，先确认仓库当前状态再动手')
  } else {
    for (const item of pending.slice(0, todoLimit)) {
      lines.push(`- [${item.status === 'in_progress' ? '进行中' : '待办'}] ${clip(item.content, 200)}`)
    }
    if (pending.length > todoLimit) lines.push(`- ……另有 ${pending.length - todoLimit} 项，见源会话 todo 面板`)
  }
  lines.push('')

  lines.push(SECTION.facts)
  lines.push('')
  lines.push(`- 工作目录：\`${clip(projectRoot, 260)}\``)
  if (recent.length > 0) {
    lines.push('- 最近几轮：')
    for (const slot of recent) {
      const ask = slot.ask === '' ? '（该轮没有用户消息）' : clip(slot.ask, 140)
      const did = slot.did === '' ? '' : ` → ${clip(slot.did, 160)}`
      lines.push(`  - 第 ${slot.turn} 轮：${ask}${did}`)
    }
  }
  lines.push('')

  lines.push(SECTION.avoid)
  lines.push('')
  lines.push('- 这是**自动生成的交接文档**，摘要和待办可能为空（取决于宿主是否装并启用了对应插件）；')
  lines.push('  需要原文时读上面的归档文件，那里是完整事件流，不是摘要。')
  lines.push('- 动手前先确认仓库当前状态（`git status` / 测试），不要假设本文件写完就没变化。')
  lines.push('- 本文件由 dsh-context-bridge 生成，不需要回写给用户。')

  return `${lines.join('\n')}\n`
}
