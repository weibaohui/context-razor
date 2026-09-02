/**
 * dsh-plugin-razor — Host half.
 *
 * 上下文剃刀：把会话上下文的每条消息列出来（角色/预览/≈token），让用户
 * 勾选后精确裁剪。删除不是物理删日志（append-only、深冻结、zstd 校验，
 * 宿主根本不支持），而是走宿主的 surface replace 协议——与官方
 * dsh-compaction-tool-result-pruner 同款：先追加一条 `compaction/prune`
 * 计价事件，再追加一条带 `surfaceOp: {op:'replace'}` 的标记 user/message，
 * `sourceEventSeqs` 覆盖全部被影子化的节点。被删节点从此不进
 * `deriveMessages()`（模型视野消失），web UI 也随 mux fold 同步折叠。
 * 全程不经 LLM 总结——删了什么、删了多少，用户逐条可见。
 */

const { randomUUID } = require('node:crypto')
const { homedir } = require('node:os')
const { join } = require('node:path')

// ── token 计数（js-tiktoken cl100k_base，与 skills-management 同源同值）──
// 降级模式退回宿主 tokenMeter 同款 chars/4 启发式（token 计数是本插件
// 核心功能，不能像 skills-management 那样直接不显示）。
const RAZOR_PLUGIN_NAME = '@weibaohui/context-razor'
let usageEncoder = null
let usageEncoderFailed = false
function usageEncoderLazy() {
  if (usageEncoderFailed) return null
  if (usageEncoder === null) {
    try {
      const { Tiktoken } = require('js-tiktoken/lite')
      usageEncoder = new Tiktoken(require('js-tiktoken/ranks/cl100k_base'))
    } catch { usageEncoderFailed = true }
  }
  return usageEncoder
}
const USAGE_MEMO_CAP = 30000
const usageMemo = new Map()
/** cl100k_base 估算；词表不可用时退回 chars/4 启发式。返回 { tokens, mode }。 */
function countTokens(text) {
  if (typeof text !== 'string' || text === '') return { tokens: 0, mode: 'cl100k' }
  const enc = usageEncoderLazy()
  if (enc !== null) {
    let tokens = usageMemo.get(text)
    if (tokens === undefined) {
      tokens = enc.encode(text).length
      if (usageMemo.size >= USAGE_MEMO_CAP) usageMemo.clear()
      usageMemo.set(text, tokens)
    }
    return { tokens, mode: 'cl100k' }
  }
  return { tokens: Math.ceil(text.length / 4) + 4, mode: 'heuristic' }
}

// ── 事件 → 模型可见文本 ────────────────────────────────────────────────
// surface 上只有三类事件（dsh-session SURFACE_EVENT_TYPES）；ContentBlock
// 是 merge-extensible 联合，已知块取字段，未知块按 JSON 长度保守计价。
function blockText(block) {
  if (block === null || typeof block !== 'object') return ''
  if (block.type === 'text' || block.type === 'reasoning') return typeof block.text === 'string' ? block.text : ''
  if (block.type === 'tool-result') return (Array.isArray(block.content) ? block.content : []).map(blockText).join('\n')
  return ''
}
function blocksText(blocks) {
  return Array.isArray(blocks) ? blocks.map(blockText).filter(Boolean).join('\n') : ''
}
function entryText(event) {
  const data = event.data || {}
  if (event.type === 'user/message') return blocksText(data.content)
  if (event.type === 'assistant/message') return blocksText(data.message && data.message.content)
  if (event.type === 'tool/result') return blocksText(data.message && data.message.content)
  return ''
}
function entryKindOf(type) {
  if (type === 'user/message') return 'user'
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  return type
}

/** 会话是否有未收口的 turn（闲时才允许 surface replace，避免与运行中的 agent 竞态）。 */
function sessionBusy(session) {
  let lastStart = -1
  let lastEnd = -1
  for (const event of session.events) {
    if (event.type === 'turn/start') lastStart = event.seq
    else if (event.type === 'turn/end') lastEnd = event.seq
  }
  return lastStart > lastEnd
}

/**
 * 当前 surface 投影成条目列表：seq 有序（模型可见顺序）、逐条文本、token 估算、
 * 时间、工具名（tool/result 按 callId 关联日志里的 tool/call）与注入来源。
 * 被此前 compaction/prune 影子化的节点本就不在 surface.nodes 里——列表即模型
 * 此刻真实可见的上下文。
 */
function projectContext(session) {
  const bySeq = new Map(session.events.map((event) => [event.seq, event]))
  const toolNames = new Map()
  for (const event of session.events) {
    if (event.type === 'tool/call' && event.data && typeof event.data.callId === 'string') {
      toolNames.set(event.data.callId, typeof event.data.name === 'string' ? event.data.name : undefined)
    }
  }
  const entries = []
  let totalTokens = 0
  let mode = 'cl100k'
  for (const seq of session.surface.nodes) {
    const event = bySeq.get(seq)
    if (event === undefined) continue
    const text = entryText(event)
    const { tokens, mode: m } = countTokens(text)
    mode = m
    const usage = event.type === 'assistant/message' ? event.data.usage : undefined
    const source = event.type === 'user/message' && event.data.source && typeof event.data.source === 'object' ? event.data.source : undefined
    entries.push({
      seq,
      kind: entryKindOf(event.type),
      time: event.time,
      turn: typeof event.data.turn === 'number' ? event.data.turn : undefined,
      tool: event.type === 'tool/result' ? toolNames.get(event.data.message && event.data.message.source && event.data.message.source.callId) : undefined,
      sourceKind: source ? source.kind : undefined,
      sourceForm: source ? source.form : undefined,
      sourcePlugin: source ? source.plugin : undefined,
      chars: text.length,
      tokens,
      preview: text.length > 220 ? text.slice(0, 220) + '…' : text,
      usage: usage && typeof usage === 'object'
        ? { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens }
        : undefined,
    })
    totalTokens += tokens
  }
  return { entries, totalTokens, mode }
}

/** 选中 seq 按当前 surface 顺序分组成连续段（surface 上相邻才可一个 replace 覆盖）。 */
function groupRuns(surfaceNodes, wanted) {
  const index = new Map(surfaceNodes.map((seq, i) => [seq, i]))
  const unknown = wanted.filter((seq) => !index.has(seq))
  if (unknown.length > 0) throw new Error(`seqs not on current surface: ${unknown.join(', ')}`)
  const sorted = [...wanted].sort((a, b) => index.get(a) - index.get(b))
  const runs = []
  for (const seq of sorted) {
    const last = runs[runs.length - 1]
    if (last && index.get(seq) === index.get(last[last.length - 1]) + 1) last.push(seq)
    else runs.push([seq])
  }
  return runs
}

/**
 * 执行一次裁剪：每个连续段一对事件（prune 计价 + notice 替换），协议形状
 * 与官方 dsh-compaction-tool-result-pruner 一致。append 抛错即整段回滚失败
 * 信息（前段已成功的事件保留在日志里——append-only，不追求事务性）。
 */
function deleteEntries(session, wantedSeqs) {
  if (sessionBusy(session)) throw new Error('session is busy: wait for the running turn to finish')
  const nodes = [...session.surface.nodes]
  const runs = groupRuns(nodes, wantedSeqs)
  const bySeq = new Map(session.events.map((event) => [event.seq, event]))
  const done = []
  let removed = 0
  let tokensRemoved = 0
  for (const run of runs) {
    const start = run[0]
    const end = run[run.length - 1]
    let runTokens = 0
    for (const seq of run) {
      const event = bySeq.get(seq)
      if (event !== undefined) runTokens += countTokens(entryText(event)).tokens
    }
    session.append('compaction/prune', {
      shadowedRange: { start, end },
      shadowedSeqs: run,
      shadowedTokenCount: runTokens,
    })
    const summary = `已删除 ${run.length} 条历史（约 ${runTokens} token）`
    const marker = createUserMessage({
      content: [{ type: 'text', text: `[context-razor] 此处原有 ${run.length} 条历史消息（约 ${runTokens} token）已被用户删除以保持上下文聚焦；如后续对话需要被删部分的细节，请向用户确认。` }],
      source: { kind: 'plugin', plugin: RAZOR_PLUGIN_NAME, form: 'notice', summary },
    })
    const replacement = session.append('user/message', marker, {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: run,
    })
    done.push({ start, end, count: run.length, tokens: runTokens, replacement: replacement.seq })
    removed += run.length
    tokensRemoved += runTokens
  }
  return { removed, tokensRemoved, runs: done }
}

// ── 替换消息构造 ────────────────────────────────────────────────────────
// 优先用宿主 dsh-llm 的官方 createUserMessage（id/冻结与宿主一致）。宿主把
// 依赖装在自己 node_modules 里，从插件真实路径未必解析得到（pnpm 软链布局），
// 故先沿 dsh 全局安装探测（skills-management 的 schemastery 同款模式），再退
// 标准 require，最后手搓等价形状——append 侧自会做 JSON 合法性校验。
function loadCreateUserMessage() {
  const { createRequire } = require('node:module')
  for (const prefix of [process.env.DSH_GLOBAL_PREFIX, homedir()].filter(Boolean)) {
    const hostCopy = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')
    try {
      const mod = createRequire(hostCopy)(hostCopy)
      if (typeof mod.createUserMessage === 'function') return mod.createUserMessage
    } catch { /* 下一个来源 */ }
  }
  try {
    const mod = require('@deepseek-ai/dsh-llm')
    if (typeof mod.createUserMessage === 'function') return mod.createUserMessage
  } catch { /* 手搓降级 */ }
  return null
}
const createUserMessage = loadCreateUserMessage() ?? ((input) => ({ ...input, id: randomUUID(), role: 'user' }))

module.exports = {
  name: 'context-razor',
  inject: ['sessions', 'webServer'],
  __internals: { countTokens, entryText, groupRuns, projectContext, sessionBusy, deleteEntries, usageMemo },

  apply(ctx) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/context-razor/api',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://dsh.local')
          const apiPath = url.pathname.replace(/\/+$/, '')
          const query = url.searchParams

          const sendJson = (status, payload) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(payload))
          }
          const readJsonBody = () => new Promise((resolve, reject) => {
            const chunks = []
            req.on('data', (chunk) => chunks.push(chunk))
            req.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8')
              try { resolve(raw === '' ? {} : JSON.parse(raw)) } catch (e) { reject(e) }
            })
            req.on('error', reject)
          })
          const fail = (status, error) => sendJson(status, { error })

          // GET /context-razor/api/sessions → 会话清单（轻量，不算 token）
          if (req.method === 'GET' && apiPath.endsWith('/context-razor/api/sessions')) {
            const sessions = (ctx.sessions.list() || [])
              .map((session) => ({
                id: session.id,
                cwd: session.header && session.header.cwd,
                createdAt: session.header && session.header.createdAt,
                lastTime: session.events.length > 0 ? session.events[session.events.length - 1].time : undefined,
                nodes: session.surface.nodes.length,
                busy: sessionBusy(session),
              }))
              .sort((a, b) => String(b.lastTime || '').localeCompare(String(a.lastTime || '')))
            sendJson(200, { sessions })
            return
          }

          // GET /context-razor/api/context?session= → 逐条投影
          if (req.method === 'GET' && apiPath.endsWith('/context-razor/api/context')) {
            const session = ctx.sessions.get(query.get('session') || '')
            if (session === undefined) { fail(404, 'session not found'); return }
            const { entries, totalTokens, mode } = projectContext(session)
            sendJson(200, {
              id: session.id,
              cwd: session.header && session.header.cwd,
              busy: sessionBusy(session),
              encoder: mode,
              totalTokens,
              nodes: session.surface.nodes.length,
              entries,
            })
            return
          }

          // GET /context-razor/api/entry?session=&seq= → 单条全文
          if (req.method === 'GET' && apiPath.endsWith('/context-razor/api/entry')) {
            const session = ctx.sessions.get(query.get('session') || '')
            if (session === undefined) { fail(404, 'session not found'); return }
            const seq = Number(query.get('seq'))
            const event = session.events.find((candidate) => candidate.seq === seq)
            if (event === undefined) { fail(404, 'entry not found'); return }
            const text = entryText(event)
            const toolName = event.type === 'tool/result' && event.data.message
              ? session.events.find((candidate) => candidate.type === 'tool/call' && candidate.data.callId === event.data.message.source.callId)
              : undefined
            const source = event.type === 'user/message' && event.data.source && typeof event.data.source === 'object' ? event.data.source : undefined
            sendJson(200, {
              seq,
              kind: entryKindOf(event.type),
              time: event.time,
              tokens: countTokens(text).tokens,
              text,
              tool: toolName && typeof toolName.data.name === 'string' ? toolName.data.name : undefined,
              sourceKind: source ? source.kind : undefined,
              sourceForm: source ? source.form : undefined,
              sourcePlugin: source ? source.plugin : undefined,
            })
            return
          }

          // POST /context-razor/api/delete { session, seqs } → 精确裁剪
          if (req.method === 'POST' && apiPath.endsWith('/context-razor/api/delete')) {
            const body = await readJsonBody()
            const session = ctx.sessions.get(typeof body.session === 'string' ? body.session : '')
            if (session === undefined) { fail(404, 'session not found'); return }
            if (!Array.isArray(body.seqs) || body.seqs.length === 0 || !body.seqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0)) {
              fail(400, 'body must provide seqs: non-empty safe-integer array'); return
            }
            try {
              const result = deleteEntries(session, body.seqs)
              sendJson(200, result)
            } catch (e) {
              fail(409, (e && e.message) || 'delete failed')
            }
            return
          }

          fail(404, `no route for ${req.method} ${apiPath}`)
        } catch (e) {
          const payload = JSON.stringify({ error: (e && e.message) || 'internal error' })
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(payload)
        }
      },
    }), 'context-razor: web api')
  },
}
