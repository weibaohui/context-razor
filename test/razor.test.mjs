import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const plugin = require('../src/index.js')
const { countTokens, entryText, groupRuns, projectContext, sessionBusy, deleteEntries, usageMemo } = plugin.__internals

// ── 纯函数 ───────────────────────────────────────────────────────────────

test('countTokens golden values on the cl100k_base ranks', () => {
  assert.deepEqual(countTokens('hello world'), { tokens: 2, mode: 'cl100k' })
  assert.deepEqual(countTokens('自动续跑：会话结束后自动继续执行'), { tokens: 18, mode: 'cl100k' })
  assert.deepEqual(countTokens(''), { tokens: 0, mode: 'cl100k' })
  assert.deepEqual(countTokens(undefined), { tokens: 0, mode: 'cl100k' })
})

test('countTokens memoizes repeated text', () => {
  const text = 'memo probe for the razor token counter'
  usageMemo.delete(text)
  const before = usageMemo.size
  countTokens(text)
  assert.equal(usageMemo.size, before + 1)
  countTokens(text)
  assert.equal(usageMemo.size, before + 1)
})

test('entryText extracts model-facing text from the three surface types', () => {
  assert.equal(entryText({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] } }), 'hello\nworld')
  assert.equal(entryText({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }] } } }), 'think\nanswer')
  assert.equal(entryText({
    type: 'tool/result',
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'tool output' }] }] } },
  }), 'tool output')
  // 未知块保守跳过、缺字段不炸
  assert.equal(entryText({ type: 'user/message', data: { content: [{ type: 'image', url: 'x' }] } }), '')
  assert.equal(entryText({ type: 'tool/call', data: { name: 'x' } }), '')
})

test('groupRuns groups by surface adjacency and rejects unknown seqs', () => {
  const nodes = [10, 11, 12, 20, 25, 30, 31]
  assert.deepEqual(groupRuns(nodes, [10, 12, 11]), [[10, 11, 12]])
  assert.deepEqual(groupRuns(nodes, [20, 10, 31, 30]), [[10], [20], [30, 31]])
  assert.deepEqual(groupRuns(nodes, [12]), [[12]])
  assert.throws(() => groupRuns(nodes, [99]), /not on current surface/)
})

test('sessionBusy detects an open turn bracket', () => {
  const idle = { events: [{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 5 }] }
  const busy = { events: [{ type: 'turn/start', seq: 0 }, { type: 'turn/end', seq: 5 }, { type: 'turn/start', seq: 9 }] }
  assert.equal(sessionBusy(idle), false)
  assert.equal(sessionBusy(busy), true)
})

// ── fake session / HTTP harness ─────────────────────────────────────────

let uid = 0
const userMessage = (text) => ({ id: 'm' + (++uid), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const toolResult = (callId, text) => ({
  id: 'm' + (++uid), role: 'user',
  content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
  source: { kind: 'tool', callId },
})

/** 内存版 Session：append 复刻 surface fold 的最小语义（replace 影子化 + 追加）。 */
function fakeSession({ id = 's-1', cwd = '/tmp/demo', events = [], nodes = null } = {}) {
  const log = events.map((e, i) => ({ seq: i, time: '2026-09-02T00:00:0' + (i % 10) + 'Z', ...e }))
  const surface = { nodes: nodes ?? log.filter((e) => ['user/message', 'assistant/message', 'tool/result'].includes(e.type)).map((e) => e.seq) }
  return {
    id,
    header: { id, createdAt: 1700000000000, cwd },
    events: log,
    surface,
    append(type, data, opts = {}) {
      const seq = log.length
      const eligible = type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
      const op = opts.surfaceOp
      if (eligible && op === undefined) throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`)
      if (eligible && op && op.op === 'replace') {
        const idxStart = surface.nodes.indexOf(op.start)
        const idxEnd = surface.nodes.indexOf(op.end)
        if (idxStart === -1 || idxEnd === -1 || idxStart > idxEnd) throw new Error('surface replace: invalid range')
        const shadowed = surface.nodes.slice(idxStart, idxEnd + 1)
        for (const need of shadowed) if (!opts.sourceEventSeqs.includes(need)) throw new Error('sourceEventSeqs must include every shadowed surface node')
        surface.nodes = [...surface.nodes.slice(0, idxStart), seq, ...surface.nodes.slice(idxEnd + 1)]
      } else if (eligible) {
        surface.nodes = [...surface.nodes, seq]
      }
      log.push({ type, data, seq, time: '2026-09-02T00:09:59Z', ...(op === 'append' ? { surfaceOp: 'append' } : {}), ...(op && op.op === 'replace' ? { surfaceOp: op, sourceEventSeqs: opts.sourceEventSeqs } : {}) })
      return { seq }
    },
  }
}

function setupPlugin({ sessions } = {}) {
  let handler
  const ctx = {
    sessions: {
      get: (id) => sessions.get(id),
      list: () => [...sessions.values()],
    },
    webServer: { register: (route) => { handler = route.handler } },
    effect: (fn) => fn(),
    logger: { warn: () => {} },
  }
  plugin.apply(ctx, {})
  const call = async (method, url, body) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    const chunks = []
    const res = {
      writeHead(status, headers) { chunks.status = status },
      end(chunk) { chunks.body = chunk === undefined ? '' : String(chunk) },
    }
    setTimeout(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    }, 5)
    await handler(req, res)
    return { status: chunks.status, payload: chunks.body ? JSON.parse(chunks.body) : undefined }
  }
  return { call }
}

const demoEvents = () => [
  { type: 'turn/start', data: { turn: 0 } },
  { type: 'user/message', data: userMessage('please help me refactor the parser module') },
  { type: 'assistant/message', data: { turn: 0, step: 0, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'I will read the parser sources first.' }], source: { kind: 'model', provider: 'deepseek', model: 'v4' } }, usage: { inputTokens: 1200, outputTokens: 40 } } },
  { type: 'tool/result', data: { turn: 0, step: 1, message: toolResult('c1', 'search results: parser.ts line 12 referenced everywhere') } },
  { type: 'turn/end', data: { turn: 0 } },
]

test('GET /sessions lists sessions with light metadata', async () => {
  const s = fakeSession({ id: 's-abc', events: demoEvents() })
  const { call } = setupPlugin({ sessions: new Map([[s.id, s]]) })
  const res = await call('GET', '/dsh-razor/api/sessions')
  assert.equal(res.status, 200)
  assert.equal(res.payload.sessions.length, 1)
  const row = res.payload.sessions[0]
  assert.equal(row.id, 's-abc')
  assert.equal(row.cwd, '/tmp/demo')
  assert.equal(row.nodes, 3)
  assert.equal(row.busy, false)
})

test('GET /context projects every surface entry with tokens', async () => {
  const s = fakeSession({ id: 's-ctx', events: demoEvents() })
  const { call } = setupPlugin({ sessions: new Map([[s.id, s]]) })
  const res = await call('GET', '/dsh-razor/api/context?session=s-ctx')
  assert.equal(res.status, 200)
  assert.equal(res.payload.entries.length, 3)
  assert.equal(res.payload.encoder, 'cl100k')
  assert.ok(res.payload.totalTokens > 0)
  const [user, assistant, tool] = res.payload.entries
  assert.deepEqual([user.kind, assistant.kind, tool.kind], ['user', 'assistant', 'tool'])
  assert.equal(user.preview, 'please help me refactor the parser module')
  assert.equal(assistant.usage.input, 1200)
  assert.equal(assistant.usage.output, 40)
  assert.ok(assistant.tokens > 0 && tool.tokens > 0)
  const unknown = await call('GET', '/dsh-razor/api/context?session=nope')
  assert.equal(unknown.status, 404)
})

test('POST /delete shadows one contiguous run via prune + replace', async () => {
  const s = fakeSession({ id: 's-del', events: demoEvents() })
  const { call } = setupPlugin({ sessions: new Map([[s.id, s]]) })
  const res = await call('POST', '/dsh-razor/api/delete', { session: 's-del', seqs: [2, 3] })
  assert.equal(res.status, 200)
  assert.equal(res.payload.removed, 2)
  assert.equal(res.payload.runs.length, 1)
  const run = res.payload.runs[0]
  assert.deepEqual([run.start, run.end, run.count], [2, 3, 2])
  assert.ok(run.tokens > 0)
  // 日志：prune 先行，replace 随后且 sourceEventSeqs 覆盖被影子节点
  const prune = s.events[5]
  const replace = s.events[6]
  assert.equal(prune.type, 'compaction/prune')
  assert.deepEqual(prune.data.shadowedSeqs, [2, 3])
  assert.deepEqual(prune.data.shadowedRange, { start: 2, end: 3 })
  assert.equal(prune.data.shadowedTokenCount, run.tokens)
  assert.equal(replace.type, 'user/message')
  assert.deepEqual(replace.surfaceOp, { op: 'replace', start: 2, end: 3 })
  assert.deepEqual(replace.sourceEventSeqs, [2, 3])
  assert.equal(replace.data.source.kind, 'plugin')
  assert.equal(replace.data.source.plugin, '@weibaohui/dsh-razor')
  assert.equal(replace.data.source.form, 'notice')
  assert.match(replace.data.source.summary, /已删除 2 条/)
  assert.match(replace.data.content[0].text, /已被用户删除/)
  // surface：被影子节点移除，标记节点补位（turn/end 本就不在 surface 上）
  assert.deepEqual(s.surface.nodes, [1, 6])
})

test('POST /delete splits non-contiguous selection into one replace per run', async () => {
  const events = demoEvents().concat([
    { type: 'user/message', data: userMessage('second prompt') },
  ])
  const s = fakeSession({ id: 's-multi', events })
  const { call } = setupPlugin({ sessions: new Map([[s.id, s]]) })
  const res = await call('POST', '/dsh-razor/api/delete', { session: 's-multi', seqs: [1, 2, 5] })
  assert.equal(res.status, 200)
  assert.equal(res.payload.runs.length, 2)
  assert.equal(res.payload.removed, 3)
  // prune/replace 交替出现，共 4 个新事件
  assert.deepEqual(s.events.slice(6).map((e) => e.type), ['compaction/prune', 'user/message', 'compaction/prune', 'user/message'])
})

test('POST /delete refuses busy sessions and unknown seqs', async () => {
  const busy = fakeSession({ id: 's-busy', events: demoEvents().concat([{ type: 'turn/start', data: { turn: 1 } }]) })
  const ok = fakeSession({ id: 's-ok', events: demoEvents() })
  const { call } = setupPlugin({ sessions: new Map([[busy.id, busy], [ok.id, ok]]) })
  const busyRes = await call('POST', '/dsh-razor/api/delete', { session: 's-busy', seqs: [1] })
  assert.equal(busyRes.status, 409)
  assert.match(busyRes.payload.error, /busy/)
  const badSeq = await call('POST', '/dsh-razor/api/delete', { session: 's-ok', seqs: [999] })
  assert.equal(badSeq.status, 409)
  assert.match(badSeq.payload.error, /not on current surface/)
  const badBody = await call('POST', '/dsh-razor/api/delete', { session: 's-ok', seqs: [] })
  assert.equal(badBody.status, 400)
})

test('deleteEntries through the exported helper matches the route behavior', () => {
  const s = fakeSession({ id: 's-helper', events: demoEvents() })
  const result = deleteEntries(s, [1])
  assert.equal(result.removed, 1)
  assert.deepEqual(s.surface.nodes, [6, 2, 3])
})
