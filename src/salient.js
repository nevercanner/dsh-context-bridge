/**
 * 关键信息提取 —— 纯函数，无宿主依赖，可单独测试。
 *
 * 交接文档的价值不在「多」，而在「对的少」。会话日志里 95% 的文本是过程
 * （读了哪个文件、跑了什么命令、工具返回了什么），真正会被新会话用到的只有
 * 一小撮**指针型事实**：改了哪些路径、跑过哪些命令、踩过哪些错误、要守哪些约束。
 *
 * 这里做的就是从全部事件里把这些东西捞出来、去重、按出现次数与新鲜度排序，
 * 各截一小段。全部是确定性的正则/扫描，不调用模型 —— 强制交接发生在 turn/end
 * 里，任何网络等待都会把宿主的这一轮收尾拖住。
 *
 * 每条提取出来的事实都带 `count`（出现次数）与 `turn`（最后一次出现的轮次），
 * 供 {@link rankFacts} 排序：反复出现的路径比一笔带过的更可能是主线。
 */

/** Windows 盘符路径：D:\a\b 或 D:/a/b。 */
const WIN_PATH = /\b[A-Za-z]:[\\/][^\s"'`()<>|，。；、）】》]*/g

/** 项目内相对路径：以常见源码/配置目录或已知扩展名结尾的 a/b/c 形态。 */
const REL_PATH =
  /\b(?:\.{1,2}\/)?(?:[\w.@-]+\/)+(?:[\w.@-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|css|scss|html|py|rs|go|java|kt|cs|php|rb|sh|ps1|yml|yaml|toml|ini|sql|svg|vue|svelte)|[\w.@-]+\/?)\b/g

/** 带反引号包起来的，优先当路径/命令/标识符（作者自己标出来的重点）。 */
const TICKED = /`([^`\n]{2,120})`/g

/** 错误行：只要是这些词开头/包含，就认为值得带进交接文档。 */
const ERROR_WORDS = /(Error|error:|ENOENT|EACCES|EPERM|EBUSY|EADDRINUSE|ETIMEDOUT|ECONNREFUSED|FAIL|failed|failing|throws?|rejected|Cannot|cannot|not defined|undefined is not|TypeError|SyntaxError|panic|✘|✗|❌)/

/** 「不许 / 必须 / 注意」类约束句：新会话最容易违反的东西。 */
const CONSTRAINT_WORDS = /(不要|别|禁止|必须|务必|一定|只能|严禁|never|always|must not|do not|don't|avoid|required|forbidden)/i

/** 明确表示「做完了」的收尾话术：不进「关键结论」，没信息量。 */
const NOISE_ENDS = /(好的|已完成|已经完成|都做完了|以上|谢谢|收到|明白|完成了|搞定|完成)$/

function asText(value) {
  return typeof value === 'string' ? value : ''
}

/** 压成一行并去掉多余空白。 */
export function squash(text) {
  return asText(text)
    .replace(/\r/g, '')
    .replace(/[ \t]*\n[ \t]*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 按字符截断（不切断代理对）。 */
export function cut(text, limit) {
  const value = asText(text)
  if (value.length <= limit) return value
  return `${Array.from(value).slice(0, Math.max(0, limit - 1)).join('')}…`
}

function push(map, key, turn, extra = '') {
  const value = squash(key)
  if (value === '') return
  const slot = map.get(value) ?? { value, count: 0, turn: 0, extra: '' }
  slot.count += 1
  if (turn > slot.turn) slot.turn = turn
  if (extra !== '' && slot.extra === '') slot.extra = squash(extra)
  map.set(value, slot)
}

/** 从一条消息里抽文本块（user/message 用 data.content，assistant/message 用 data.message.content）。 */
function blocksOf(row) {
  const content = row?.data?.message?.content ?? row?.data?.content
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out.push(block.text)
  }
  return out
}

/**
 * 从会话事件里提取「关键信息」。
 *
 * @param {Array<object>} events 会话事件（升序）
 * @returns {{
 *   paths: Array<{value:string,count:number,turn:number,extra:string}>,
 *   files: Array<{value:string,count:number,turn:number,extra:string}>,
 *   commands: Array<{value:string,count:number,turn:number,extra:string}>,
 *   errors: Array<{value:string,count:number,turn:number,extra:string}>,
 *   constraints: Array<{value:string,count:number,turn:number,extra:string}>,
 *   decisions: Array<{value:string,count:number,turn:number,extra:string}>,
 *   touchedFiles: Array<{value:string,count:number,turn:number,extra:string}>,
 * }}
 */
export function salientFacts(events) {
  const paths = new Map()
  const commands = new Map()
  const errors = new Map()
  const constraints = new Map()
  const decisions = new Map()
  const list = Array.isArray(events) ? events : []
  let turn = 0

  /** 工具调用参数里的路径：最可信的「改了什么」来源。 */
  const toolCalls = new Map()

  for (const row of list) {
    const type = row?.type
    const declared = typeof row?.data?.turn === 'number' ? row.data.turn : undefined
    if (type === 'turn/start') {
      turn = declared ?? turn + 1
      continue
    }
    if (declared !== undefined) turn = declared

    if (type === 'tool/call') {
      const name = asText(row?.data?.name) || 'tool'
      let parsed
      try {
        parsed = typeof row?.data?.arguments === 'string' ? JSON.parse(row.data.arguments) : row?.data?.arguments
      } catch {
        parsed = undefined
      }
      const callId = asText(row?.data?.callId)
      const filePath = asText(parsed?.file_path ?? parsed?.path)
      if (filePath !== '') push(paths, filePath, turn)
      if (callId !== '') toolCalls.set(callId, { name, filePath })
      const command = asText(parsed?.command)
      if (command !== '') push(commands, command, turn)
      const description = asText(parsed?.description ?? parsed?.query ?? parsed?.pattern ?? parsed?.url)
      if (command === '' && description !== '') push(commands, `${name}: ${description}`, turn)
      continue
    }

    if (type === 'tool/result') {
      // 只认错误结果：成功结果的正文是噪音（日志、大段输出），错误那一行才是下次要绕的坑
      const isError = row?.data?.message?.isError === true || row?.data?.isError === true
      const callId = asText(row?.data?.message?.source?.callId ?? row?.data?.callId)
      const call = toolCalls.get(callId)
      const blocks = blocksOf(row)
      if (!isError) continue
      const line = blocks
        .join('\n')
        .split('\n')
        .map(squash)
        .find((item) => item !== '' && ERROR_WORDS.test(item))
      const where = call === undefined ? '' : call.filePath === '' ? call.name : `${call.name} ${call.filePath}`
      push(errors, `${where === '' ? '' : `${where} → `}${line ?? '调用失败（无错误正文）'}`, turn)
      continue
    }

    if (type !== 'user/message' && type !== 'assistant/message') continue
    const text = blocksOf(row).join('\n')
    if (text === '') continue

    // 1) 反引号里的内容：路径 / 命令 / 标识符，作者自己标的重点
    for (const match of text.matchAll(TICKED)) {
      const inner = squash(match[1])
      if (inner === '') continue
      if (/[\\/]/.test(inner)) push(paths, inner, turn)
      else if (/^(npm|pnpm|yarn|node|git|npx|python|pip|cargo|go|dotnet|gh|bash|pwsh)\b/.test(inner)) push(commands, inner, turn)
      else if (/\w\(.*\)|^\w+\.\w+$|^[A-Za-z_$][\w$]*$/.test(inner)) push(decisions, inner, turn)
    }

    // 2) 裸路径（绝对 + 看起来像项目内相对路径）
    for (const match of text.matchAll(WIN_PATH)) push(paths, match[0], turn)
    for (const match of text.matchAll(REL_PATH)) push(paths, match[0], turn)

    // 3) 逐行找错误与约束
    //    约束不在这里取整行：用户原话常常是「把 X 补上，别动 lib/」，
    //    整行进「注意事项」既啰嗦又会每轮重复一遍。整行的约束句只在
    //    **没有逗号分句可切**时兜底（见下面的 4）。
    for (const rawLine of text.split('\n')) {
      const line = squash(rawLine.replace(/^[-*+>#\d.\s]+/, ''))
      if (line === '' || line.length < 6) continue
      if (ERROR_WORDS.test(line)) push(errors, line, turn)
    }

    // 4) 抽**约束条款**而不是整句用户要求：只把分句里带约束词的那一小段
    //    拎出来（「别动 lib/」），原句仍然逐字留在「用户最近的原始要求」里。
    if (type === 'user/message') {
      const clauses = text.split(/[，,。；;！!\n]/).map(squash).filter((item) => item !== '')
      let kept = 0
      for (const line of clauses) {
        if (line.length < 3 || line.length > 120) continue
        if (!CONSTRAINT_WORDS.test(line)) continue
        push(constraints, line, turn)
        kept += 1
      }
      // 一整句没有任何逗号可分（"不要动 lib 目录下的任何文件"）→ 整句就是条款
      if (kept === 0) {
        const whole = squash(text)
        if (whole.length >= 3 && whole.length <= 120 && CONSTRAINT_WORDS.test(whole)) {
          push(constraints, whole, turn)
        }
      }
    }

    // 4) assistant 的「结论句」：只有 user 消息里没有的、带判断的短句才留
    if (type === 'assistant/message') {
      for (const rawLine of text.split('\n')) {
        const line = squash(rawLine.replace(/^[-*+>#\d.\s]+/, ''))
        if (line.length < 12 || line.length > 180) continue
        if (NOISE_ENDS.test(line)) continue
        if (!/(结论|定为|决定|改成|改为|选了|采用|因为|根因|原因|所以|不建议|建议)/.test(line)) continue
        push(decisions, line, turn)
      }
    }
  }

  // 碰过的文件 = 工具参数里出现的路径条目，**保留原次数**（反复改同一个文件
  // 是最强的「这是主线」信号，重建一遍会把 count 压成 1，排序就废了）。
  const touched = new Map()
  for (const [key, slot] of paths) {
    if (!/[\\/]/.test(key) || !/\.\w{1,8}$/.test(key)) continue
    const target = touched.get(key)
    if (target === undefined) touched.set(key, { ...slot })
    else if (slot.turn > target.turn) target.turn = slot.turn
  }

  return {
    paths: rankFacts(paths),
    files: rankFacts(touched),
    commands: rankFacts(commands),
    errors: rankFacts(errors),
    constraints: rankFacts(constraints),
    decisions: rankFacts(decisions),
    touchedFiles: rankFacts(touched),
  }
}

/**
 * 排序：先按出现次数，再按最后出现的轮次。同一批事实里，反复被提到、
 * 最近还提到的东西，才是交接真正要带走的。返回定长截断后的数组。
 *
 * @param {Map<string,{value:string,count:number,turn:number,extra:string}>} map
 * @param {{limit?:number, maxChars?:number}} [options]
 */
export function rankFacts(map, { limit = 10, maxChars = 220 } = {}) {
  if (!(map instanceof Map)) return []
  return [...map.values()]
    .filter((slot) => slot && typeof slot.value === 'string' && slot.value !== '')
    .sort((left, right) => right.count - left.count || right.turn - left.turn)
    .slice(0, limit)
    .map((slot) => ({
      value: cut(slot.value, maxChars),
      count: slot.count,
      turn: slot.turn,
      extra: slot.extra,
    }))
}

/**
 * 把关键信息压成「一行一条」的紧凑事实区。
 * 每行都自带归属，便于新会话直接照做，而不是再去读一遍归档。
 *
 * @param {object} facts {@link salientFacts} 的返回值
 * @param {{perGroup?:number}} [options]
 * @returns {Array<{title:string, lines:string[]}>}
 */
export function factSections(facts, { perGroup = 6 } = {}) {
  const source = facts !== null && typeof facts === 'object' ? facts : {}
  const pick = (key) =>
    Array.isArray(source[key])
      ? source[key]
          .slice(0, perGroup)
          .map((item) => (item.count > 1 ? `${item.value}（×${item.count}）` : item.value))
      : []
  const groups = [
    { title: '改动/涉及的文件', lines: pick('files') },
    { title: '跑过的关键命令', lines: pick('commands') },
    { title: '踩过的坑（错误原文）', lines: pick('errors') },
    { title: '约束（新会话必须遵守）', lines: pick('constraints') },
    { title: '结论与决定', lines: pick('decisions') },
  ]
  return groups.filter((group) => group.lines.length > 0)
}
