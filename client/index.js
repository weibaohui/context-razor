/**
 * dsh-plugin-razor — Browser half.
 *
 * Settings-section surface (same embedding as skills-management): pick a live
 * session, see every model-visible context entry with its ≈token estimate,
 * mark oversized ones in red over a threshold, multi-select and razor them
 * away. All colors come from the ui-theme `--dsw-*` token layers; all copy
 * comes from the locale registry (`zh`/`en`). No hardcoded colors, no ad-hoc
 * copy. No class components — render errors land in globalThis.__rzErrors.
 */

let __React = null
try { __React = require('react') } catch {}
if (!__React || typeof __React.createElement !== 'function') {
  __React = {
    createElement(type, props, ...kids) {
      return { type, props: props || {}, kids: kids.flat(9).filter(k => k !== null && k !== undefined && k !== false && k !== true && typeof k !== 'string' || true) }
    },
    useState(init) { const v = [typeof init === 'function' ? init() : init]; return [v[0], x => { v[0] = typeof x === 'function' ? x(v[0]) : x }] },
    useEffect() {}, useMemo(fn) { return fn() }, useRef(v = null) { return { current: v } },
  }
}
const { createElement: h, useState, useEffect, useMemo, useRef } = __React

let P = null
try { P = require('@deepseek-ai/dsh-client-ui-primitives') } catch {}

/** Idempotent stylesheet injection (position-critical classes included). */
function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById('rz-styles')) return
  const holder = document.createElement('div')
  holder.id = 'rz-styles'
  holder.style.display = 'none'
  holder.innerHTML = STYLE
  document.head.appendChild(holder)
}

const prim = (name) => P && P[name]
  ? P[name]
  : function Shim(props) {
      const { children, ...rest } = props
      return h('button', { ...rest, 'data-p-shim': name }, children)
    }

// ── Locale ───────────────────────────────────────────────────────────────

const NS = 'contextRazor'

const ZH = {
  title: '上下文剃刀',
  hint: '逐条列出会话上下文（≈token 为 cl100k_base 估算，与技能市场同词表）。删除 = 从模型视野移除（append-only 日志保留痕迹，不可恢复），不经 LLM 总结。',
  sessionLabel: '会话',
  pickSession: '选择会话…',
  loading: '正在加载…',
  refresh: '刷新',
  busyTag: '运行中',
  idleTag: '空闲',
  thresholdLabel: '标红阈值',
  thresholdUnit: 'token',
  sortLabel: '排序',
  sortOrder: '上下文顺序',
  sortTokens: 'token 高→低',
  overOnly: '只看超阈值',
  selectOver: '选中超阈值',
  clearSelect: '清空选择',
  deleteSelected: '删除选中',
  selectedStats: '已选 {n} 条 / ≈{tokens} token',
  stats: '{nodes} 条 · 合计 ≈{tokens} token{mode}',
  modeHeuristic: '（启发式估算：词表未加载）',
  kindUser: '用户',
  kindAssistant: '助手',
  kindTool: '工具',
  emptyContext: '该会话上下文为空',
  showMore: '显示更多（剩余 {n}）',
  detailTitle: '条目详情',
  detailTokens: '≈{tokens} token · {chars} 字符',
  detailUsage: '真实用量：输入 {input} / 输出 {output}{cache}',
  detailUsageCache: ' / 缓存读 {cache}',
  close: '关闭',
  deleteTitle: '确认裁剪',
  deleteConfirm: '即将把 {n} 条消息（约 {tokens} token）从模型视野中移除，替换为一条标记消息。日志中保留痕迹，此操作不可恢复。继续？',
  deleteBusyHint: '会话正在运行，等当前回合结束后再裁剪',
  deleteOk: '执行',
  cancel: '取消',
  deletedToast: '已删除 {n} 条（约 {tokens} token）',
  operationFailed: '操作失败',
  seqLabel: 'seq {seq}',
}

const EN = {
  title: 'Context Razor',
  hint: 'Every model-visible context entry with a ≈token estimate (cl100k_base, same ranks as Skills Market). Delete removes entries from the model view (append-only log keeps traces, irreversible) — no LLM summarization involved.',
  sessionLabel: 'Session',
  pickSession: 'Pick a session…',
  loading: 'Loading…',
  refresh: 'Refresh',
  busyTag: 'running',
  idleTag: 'idle',
  thresholdLabel: 'Red threshold',
  thresholdUnit: 'tokens',
  sortLabel: 'Sort',
  sortOrder: 'Context order',
  sortTokens: 'tokens high→low',
  overOnly: 'Over threshold only',
  selectOver: 'Select over threshold',
  clearSelect: 'Clear selection',
  deleteSelected: 'Delete selected',
  selectedStats: '{n} selected / ≈{tokens} tokens',
  stats: '{nodes} entries · total ≈{tokens} tokens{mode}',
  modeHeuristic: ' (heuristic: ranks unavailable)',
  kindUser: 'User',
  kindAssistant: 'Assistant',
  kindTool: 'Tool',
  emptyContext: 'This session has no context entries',
  showMore: 'Show more ({n} left)',
  detailTitle: 'Entry detail',
  detailTokens: '≈{tokens} tokens · {chars} chars',
  detailUsage: 'Actual usage: in {input} / out {output}{cache}',
  detailUsageCache: ' / cache-read {cache}',
  close: 'Close',
  deleteTitle: 'Confirm trim',
  deleteConfirm: 'About to remove {n} messages (≈{tokens} tokens) from the model view, replaced by one marker message. Traces stay in the log; this cannot be undone. Continue?',
  deleteBusyHint: 'Session is running — trim after the current turn finishes',
  deleteOk: 'Delete',
  cancel: 'Cancel',
  deletedToast: 'Deleted {n} entries (≈{tokens} tokens)',
  operationFailed: 'Operation failed',
  seqLabel: 'seq {seq}',
}

// ── Pure helpers ────────────────────────────────────────────────────────

const API = '/context-razor/api'
const PAGE_SIZE = 150
const DEFAULT_THRESHOLD = 500
const THRESHOLD_KEY = 'context-razor-threshold'

const kindI18n = (key) => 'kind' + key[0].toUpperCase() + key.slice(1)

/** 行是否标红（仅 user/assistant/tool 有意义，阈值 <= 0 视为关闭）。 */
function overThreshold(entry, threshold) {
  return threshold > 0 && typeof entry.tokens === 'number' && entry.tokens > threshold
}

/** 排序：order = 投影原序；tokens = 降序（并列按 seq，缺 token 沉底）。 */
function sortEntries(entries, sortBy) {
  if (sortBy !== 'tokens') return entries
  return [...entries].sort((a, b) => {
    const va = a.tokens, vb = b.tokens
    if (va === vb) return a.seq - b.seq
    if (va === undefined || va === null) return 1
    if (vb === undefined || vb === null) return -1
    return vb - va
  })
}

const formatNum = (n) => Number.isFinite(n) ? n.toLocaleString('en-US') : '-'

async function getJson(url) {
  const r = await fetch(url)
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    throw new Error(body.error || 'HTTP ' + r.status)
  }
  return r.json()
}

// ── Token-based stylesheet (light/dark adaptive by construction) ────────

const STYLE = `<style>
.rz-page{position:relative;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:var(--dsw-font-sm-14,14px)}
.rz-hint{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.5}
.rz-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.rz-spacer{flex:1}
.rz-label{color:var(--dsw-alias-label-secondary);font-size:12.5px;white-space:nowrap}
.rz-input{min-height:30px;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-specific-input-major,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-size:13px;font-family:var(--dsw-font-family);outline:none}
.rz-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.rz-select{min-height:30px;padding:4px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-specific-input-major,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-size:13px;font-family:var(--dsw-font-family);outline:none}
.rz-stats{display:flex;gap:12px;align-items:center;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.rz-badge{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}
.rz-badge.over{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);font-weight:600}
.rz-chip{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap;flex:none}
.rz-chip.user{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.rz-chip.assistant{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.rz-list{display:flex;flex-direction:column;gap:6px}
.rz-row{display:flex;gap:10px;align-items:center;padding:8px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);cursor:pointer;text-align:left;width:100%}
.rz-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rz-row.over{border-left-color:var(--dsw-alias-state-error-primary)}
.rz-row.checked{border-color:var(--dsw-alias-state-business-primary)}
.rz-row-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px}
.rz-row.over .rz-row-preview{color:var(--dsw-alias-label-primary)}
.rz-row-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none}
.rz-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:36px 20px;text-align:center;color:var(--dsw-alias-label-secondary)}
.rz-loading{padding:36px;text-align:center;color:var(--dsw-alias-label-secondary)}
.rz-footbtns{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rz-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:5px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;cursor:pointer;font-family:var(--dsw-font-family);white-space:nowrap}
.rz-btn:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
.rz-btn:disabled{opacity:.45;cursor:not-allowed}
.rz-btn-danger{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}
.rz-btn-danger:hover{filter:brightness(1.08);background:var(--dsw-alias-state-error-primary)}
.rz-dlg-backdrop{position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px}
.rz-dlg{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;min-width:360px;max-width:720px;max-width:min(720px,92vw);max-height:82vh;overflow:auto;padding:18px;box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.rz-dlg h3{margin:0 0 12px;font-size:15px}
.rz-dlg-foot{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.rz-dlg-text{white-space:pre-wrap;font-size:12.5px;line-height:1.55;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px;max-height:46vh;overflow:auto}
.rz-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:40;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:8px 18px;font-size:13px;box-shadow:var(--dsw-shadow-lv2)}
</style>`

// ── Small building blocks ────────────────────────────────────────────────

const Chip = ({ kind, label }) => h('span', { className: 'rz-chip ' + kind }, label)

const TokenBadge = ({ entry, threshold }) => {
  const over = overThreshold(entry, threshold)
  return h('span', { className: 'rz-badge' + (over ? ' over' : ''), title: over ? '≥ 阈值 ' + threshold : undefined },
    '≈' + formatNum(entry.tokens))
}

/** 分页列表：先渲染 pageSize 行，按需增长（大会话一次挂几千行会卡）。 */
function PagedList({ items, render, t }) {
  const [shown, setShown] = useState(PAGE_SIZE)
  useEffect(() => { setShown(PAGE_SIZE) }, [items])
  return [
    ...items.slice(0, shown).map(render),
    items.length > shown && h('div', { style: { textAlign: 'center', margin: '10px 0' } },
      h('button', { className: 'rz-btn', onClick: () => setShown(n => n + PAGE_SIZE) }, t('showMore', { n: items.length - shown }))),
  ]
}

/** 单条全文弹窗（正文经 /entry 异步补全）。 */
function DetailModal({ detail, threshold, t, onClose }) {
  if (!detail) return null
  return h('div', { className: 'rz-dlg-backdrop', onClick: onClose },
    h('div', { className: 'rz-dlg', onClick: e => e.stopPropagation() },
      h('h3', null, t('detailTitle') + ' · ' + t('seqLabel', { seq: detail.seq })),
      h('div', { className: 'rz-stats', style: { marginBottom: 10 } },
        h(Chip, { kind: detail.kind, label: t(kindI18n(detail.kind)) }),
        h(TokenBadge, { entry: detail, threshold }),
        h('span', { className: 'rz-label' }, t('detailTokens', { tokens: formatNum(detail.tokens), chars: formatNum(detail.chars) })),
        detail.usage && h('span', { className: 'rz-label' }, t('detailUsage', {
          input: formatNum(detail.usage.input), output: formatNum(detail.usage.output),
          cache: detail.usage.cacheRead ? t('detailUsageCache', { cache: formatNum(detail.usage.cacheRead) }) : '' }))),
      h('div', { className: 'rz-dlg-text' }, detail.text || ' '),
      h('div', { className: 'rz-dlg-foot' },
        h('button', { className: 'rz-btn', onClick: onClose }, t('close')))))
}

/** 裁剪确认弹窗。 */
function ConfirmDialog({ n, tokens, deleting, t, onCancel, onOk }) {
  return h('div', { className: 'rz-dlg-backdrop', onClick: onCancel },
    h('div', { className: 'rz-dlg', onClick: e => e.stopPropagation() },
      h('h3', null, t('deleteTitle')),
      h('div', { className: 'rz-hint' }, t('deleteConfirm', { n, tokens })),
      h('div', { className: 'rz-dlg-foot' },
        h('button', { className: 'rz-btn', onClick: onCancel }, t('cancel')),
        h('button', { className: 'rz-btn rz-btn-danger', disabled: deleting, onClick: onOk }, t('deleteOk')))))
}

// ── Page ────────────────────────────────────────────────────────────────

function RazorPage({ t }) {
  const [sessions, setSessions] = useState(null)
  const [sessionId, setSessionId] = useState('')
  const [context, setContext] = useState(null)
  const [ctxLoading, setCtxLoading] = useState(false)
  const [error, setError] = useState(null)
  const [threshold, setThreshold] = useState(() => {
    try { const v = Number(localStorage.getItem(THRESHOLD_KEY)); return Number.isFinite(v) && v > 0 ? v : DEFAULT_THRESHOLD } catch { return DEFAULT_THRESHOLD }
  })
  const [sortBy, setSortBy] = useState('order')
  const [overOnly, setOverOnly] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [detail, setDetail] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [toast, setToast] = useState(null)
  const sessionRef = useRef('')

  const showToast = (text) => { setToast(text); setTimeout(() => setToast(null), 3000) }

  const loadSessions = () => getJson(API + '/sessions').then(d => setSessions(d.sessions || [])).catch(e => setError(e.message))
  useEffect(() => { loadSessions() }, [])

  const loadContext = (id) => {
    if (!id) { setContext(null); return }
    setCtxLoading(true)
    setError(null)
    getJson(API + '/context?session=' + encodeURIComponent(id))
      .then(d => { setContext(d); setSelected(new Set()) })
      .catch(e => setError(e.message))
      .finally(() => setCtxLoading(false))
  }
  useEffect(() => { if (sessionId) loadContext(sessionId) }, [sessionId])

  const refreshAll = () => {
    loadSessions()
    if (sessionRef.current) loadContext(sessionRef.current)
  }

  const pickSession = (id) => { sessionRef.current = id; setSessionId(id) }
  const changeThreshold = (v) => {
    const n = Number(v)
    setThreshold(Number.isFinite(n) && n > 0 ? n : 0)
    try { localStorage.setItem(THRESHOLD_KEY, String(n)) } catch {}
  }

  const visible = useMemo(() => {
    if (!context) return []
    let rows = context.entries
    if (overOnly && threshold > 0) rows = rows.filter(e => overThreshold(e, threshold))
    return sortEntries(rows, sortBy)
  }, [context, overOnly, threshold, sortBy])

  const overList = useMemo(() => (context ? context.entries.filter(e => overThreshold(e, threshold)) : []), [context, threshold])
  const selectedTokens = useMemo(() => {
    if (!context) return 0
    const bySeq = new Map(context.entries.map(e => [e.seq, e]))
    let sum = 0
    for (const seq of selected) { const e = bySeq.get(seq); if (e) sum += e.tokens }
    return sum
  }, [context, selected])

  const toggleRow = (seq) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(seq)) next.delete(seq)
    else next.add(seq)
    return next
  })
  const selectOver = () => setSelected(new Set(overList.map(e => e.seq)))

  const openDetail = (entry) => {
    setDetail(entry)
    getJson(`${API}/entry?session=${encodeURIComponent(sessionId)}&seq=${entry.seq}`)
      .then(d => setDetail(cur => (cur && cur.seq === entry.seq) ? { ...cur, text: d.text, tokens: d.tokens } : cur))
      .catch(() => {})
  }

  const doDelete = async () => {
    setDeleting(true)
    try {
      const r = await fetch(API + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: sessionId, seqs: [...selected] }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
      setConfirming(false)
      setSelected(new Set())
      showToast(t('deletedToast', { n: d.removed, tokens: formatNum(d.tokensRemoved) }))
      refreshAll()
    } catch (e) {
      setConfirming(false)
      setError(e.message)
    } finally { setDeleting(false) }
  }

  const busy = !!(context && context.busy)
  const canDelete = selected.size > 0 && !busy && !deleting

  return h('div', { className: 'rz-page' },
    h('div', { className: 'rz-hint' }, t('hint')),
    h('div', { className: 'rz-toolbar' },
      h('span', { className: 'rz-label' }, t('sessionLabel')),
      h('select', { className: 'rz-select', value: sessionId, onChange: e => pickSession(e.target.value), style: { maxWidth: 380 } },
        h('option', { value: '' }, t('pickSession')),
        (sessions || []).map(s => h('option', { key: s.id, value: s.id },
          (s.cwd ? s.cwd.split('/').pop() + ' · ' : '') + s.id.slice(0, 8) + ' · ' + s.nodes))),
      h('button', { className: 'rz-btn', onClick: refreshAll, title: t('refresh') }, t('refresh')),
      context && h('span', { className: 'rz-badge' }, context.busy ? t('busyTag') : t('idleTag'))),
    error && h('div', { className: 'rz-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } }, t('operationFailed') + ': ' + error),
    !sessionId && (sessions === null
      ? h('div', { className: 'rz-loading' }, t('loading'))
      : h('div', { className: 'rz-empty' }, t('pickSession'))),
    sessionId && ctxLoading && h('div', { className: 'rz-loading' }, t('loading')),
    sessionId && !ctxLoading && context && [
      h('div', { key: 'stats', className: 'rz-stats' },
        h('span', null, t('stats', { nodes: context.nodes, tokens: formatNum(context.totalTokens), mode: context.encoder === 'heuristic' ? t('modeHeuristic') : '' })),
        h('span', { className: 'rz-spacer' }),
        h('label', { className: 'rz-label', style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
          t('thresholdLabel'),
          h('input', { className: 'rz-input', type: 'number', min: 0, step: 50, value: threshold, onChange: e => changeThreshold(e.target.value), style: { width: 90 } }),
          t('thresholdUnit')),
        h('select', { className: 'rz-select', value: sortBy, onChange: e => setSortBy(e.target.value), title: t('sortLabel'), 'aria-label': t('sortLabel') },
          h('option', { value: 'order' }, t('sortOrder')),
          h('option', { value: 'tokens' }, t('sortTokens'))),
        h('label', { className: 'rz-label', style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
          h('input', { type: 'checkbox', checked: overOnly, onChange: e => setOverOnly(e.target.checked) }), t('overOnly'))),
      h('div', { key: 'sel', className: 'rz-stats' },
        h('span', null, selected.size > 0 ? t('selectedStats', { n: selected.size, tokens: formatNum(selectedTokens) }) : ' '),
        h('span', { className: 'rz-spacer' }),
        h('div', { className: 'rz-footbtns' },
          h('button', { className: 'rz-btn', onClick: selectOver, disabled: overList.length === 0 || busy }, t('selectOver') + (overList.length ? ` (${overList.length})` : '')),
          h('button', { className: 'rz-btn', onClick: () => setSelected(new Set()), disabled: selected.size === 0 }, t('clearSelect')),
          h('button', { className: 'rz-btn rz-btn-danger', disabled: !canDelete,
            title: busy ? t('deleteBusyHint') : undefined,
            onClick: () => setConfirming(true) },
            t('deleteSelected') + (selected.size ? ` (${selected.size})` : '')))),
      visible.length === 0
        ? h('div', { key: 'empty', className: 'rz-empty' }, overOnly ? t('overOnly') + ' · ' + t('emptyContext') : t('emptyContext'))
        : h('div', { key: 'list', className: 'rz-list' },
            h(PagedList, { items: visible, t, render: entry => {
              const over = overThreshold(entry, threshold)
              return h('div', { key: entry.seq, className: 'rz-row' + (over ? ' over' : '') + (selected.has(entry.seq) ? ' checked' : ''),
                  role: 'button', tabIndex: 0, onClick: () => toggleRow(entry.seq),
                  onKeyDown: e => e.key === 'Enter' && toggleRow(entry.seq) },
                h('input', { type: 'checkbox', checked: selected.has(entry.seq), onClick: e => e.stopPropagation(), onChange: () => toggleRow(entry.seq) }),
                h(Chip, { kind: entry.kind, label: t(kindI18n(entry.kind)) }),
                h('span', { className: 'rz-row-preview', title: entry.preview }, entry.preview || ' '),
                h(TokenBadge, { entry, threshold }),
                h('button', { className: 'rz-btn', style: { minHeight: 24, padding: '2px 8px' },
                    onClick: e => { e.stopPropagation(); openDetail(entry) } }, '⋯'),
                h('span', { className: 'rz-row-meta' }, 'seq ' + entry.seq))
            } })),
      detail && h(DetailModal, { detail, threshold, t, onClose: () => setDetail(null) }),
      confirming && h(ConfirmDialog, { n: selected.size, tokens: formatNum(selectedTokens), deleting, t,
        onCancel: () => setConfirming(false), onOk: doDelete }),
    ],
    toast && h('div', { className: 'rz-toast' }, toast))
}

// ── Plugin plane contract ────────────────────────────────────────────────

const CLIENT_NAME = '@weibaohui/context-razor'

module.exports = {
  name: CLIENT_NAME,
  inject: ['slots', 'locale'],
  __internals: { NS, ZH, EN, overThreshold, sortEntries },
  __boot(container, opts = {}) {
    ensureStyles()
    const t = opts.t || ((key, vars) => {
      let out = EN[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
      return out
    })
    const root = require('react-dom/client').createRoot(container)
    root.render(h(RazorPage, { t }))
    return root
  },
  apply(ctx) {
    let t = (key, vars) => {
      let out = EN[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
      return out
    }
    try {
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.locale.register(NS, 'zh', ZH)
        ctx.locale.register(NS, 'en', EN)
        const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
        if (bound) t = (key, vars) => {
          let out = bound(key) || key
          if (vars) for (const [k, v] of Object.entries(vars)) out = out.split('{' + k + '}').join(String(v))
          return out
        }
      }
    } catch (e) { try { console.error('[context-razor] locale init:', e) } catch {} }
    ctx.effect(() => {
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: CLIENT_NAME,
          order: 91,
          locale: NS,
          label: () => t('title'),
          inject: () => ({}),
        }, function RazorSectionSlot() {
          useEffect(ensureStyles, [])
          return h(RazorPage, { t })
        }))
      } catch (e) { (globalThis.__rzErrors = globalThis.__rzErrors || []).push('settings:' + (e && e.message)); throw e }
    }, 'context-razor: settings section')
  },
}
