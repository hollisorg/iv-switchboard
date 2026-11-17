// Builds the one object the tray and popover render: each agent app's allowance windows with a
// run-out forecast, and Today / 7 Days / 30 Days tokens and API-equivalent cost per agent app, with
// the top tasks. Pure: it reads the store and the clock it is given, and changes nothing.
import { costUsd, usageOf } from './prices.js'

const ENGINES = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'hermes', name: 'Hermes' }
]

const TOP_TASKS = 5
const MIN_ELAPSED_SHARE = 0.05 // too early in a window to forecast before 5% of it has passed

function windowLabel(key, minutes) {
  const base = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key
  if (base === 'five_hour') return '5 hours'
  if (base === 'seven_day') return 'Week'
  if (Number.isFinite(minutes)) return minutes % 1440 === 0 ? `${minutes / 1440} days` : `${Math.round(minutes / 60)} hours`
  return base
}

// When the window runs out at the pace seen so far, measured at the reading, if that is before it resets.
function runsOutAt(l, isPastReset) {
  const used = l.usedPercent
  if (isPastReset || !(used > 0) || used >= 100 || !Number.isFinite(l.windowMinutes) || !Number.isFinite(l.resetsAtMs)) return null
  const length = l.windowMinutes * 60000
  const elapsed = l.observedMs - (l.resetsAtMs - length)
  if (elapsed <= length * MIN_ELAPSED_SHARE) return null
  const at = Math.round(l.observedMs + ((100 - used) * elapsed) / used)
  return at < l.resetsAtMs ? at : null
}

function engineReadings(limits, id, now) {
  const mine = limits.filter((l) => l.source === id).sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity))
  const latest = mine.reduce((best, l) => (!best || l.observedMs > best.observedMs ? l : best), null)
  return {
    plan: mine.find((l) => l.plan)?.plan ?? null,
    credits: latest?.credits ?? null,
    observedAt: latest?.observedMs ?? null,
    windows: mine.map((l) => {
      const isPastReset = Number.isFinite(l.resetsAtMs) && now >= l.resetsAtMs
      return {
        key: l.window,
        label: windowLabel(l.window, l.windowMinutes),
        usedPercent: l.usedPercent,
        windowMinutes: l.windowMinutes,
        resetsAt: l.resetsAtMs,
        observedAt: l.observedMs,
        isPastReset,
        isOut: !isPastReset && l.usedPercent >= 100,
        runsOutAt: runsOutAt(l, isPastReset)
      }
    })
  }
}

function periodStarts(now) {
  const d = new Date(now)
  const day = (back) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime()
  return { today: day(0), week: day(6), month: day(29) }
}

// Every reply and Hermes row as { engine, sessionId, at, tokens, cost, provider, mode }.
function items(turns, hermes) {
  const out = []
  for (const t of turns) out.push({ engine: t.source, sessionId: t.sessionId, at: t.atMs, tokens: usageOf(t.source, t).tokens, cost: costUsd(t.source, t) })
  for (const h of hermes) {
    out.push({ engine: 'hermes', sessionId: h.sessionId, at: h.lastSeenMs, tokens: usageOf('hermes', h).tokens, cost: costUsd('hermes', h), provider: h.billingProvider, mode: h.billingMode })
  }
  return out
}

function total(list) {
  let tokens = 0
  let cost = 0
  let priced = false
  let unpricedTokens = 0
  for (const x of list) {
    tokens += x.tokens
    if (x.cost === null) unpricedTokens += x.tokens
    else {
      cost += x.cost
      priced = true
    }
  }
  return { tokens, costUsd: priced ? cost : null, unpricedTokens }
}

function rootOf(sessions, engine, sessionId) {
  let id = sessionId
  for (let hops = 0; id && hops < 20; hops++) {
    const parent = sessions.get(`${engine}|${id}`)?.parentId
    if (!parent) break
    id = parent
  }
  return id
}

function topTasks(list, sessions) {
  const groups = new Map()
  for (const x of list) {
    const root = rootOf(sessions, x.engine, x.sessionId)
    const key = `${x.engine}|${root ?? ''}`
    if (!groups.has(key)) groups.set(key, { engine: x.engine, label: root ? sessions.get(`${x.engine}|${root}`)?.label ?? null : null, list: [] })
    groups.get(key).list.push(x)
  }
  return [...groups.values()]
    .map((g) => {
      const t = total(g.list)
      return { engine: g.engine, label: g.label, tokens: t.tokens, costUsd: t.costUsd }
    })
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.tokens - a.tokens)
    .slice(0, TOP_TASKS)
}

function providers(list) {
  const by = new Map()
  for (const x of list) {
    const key = `${x.provider}|${x.mode}`
    if (!by.has(key)) by.set(key, { provider: x.provider, mode: x.mode, list: [] })
    by.get(key).list.push(x)
  }
  return [...by.values()]
    .map((p) => {
      const t = total(p.list)
      return { provider: p.provider, mode: p.mode, tokens: t.tokens, costUsd: t.costUsd }
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.mode.localeCompare(b.mode))
}

export function buildSnapshot(store, now = Date.now()) {
  const limits = store.listLimits()
  const starts = periodStarts(now)
  const all = items(store.turnsSince(starts.month), store.hermesSince(starts.month))
  const sessions = new Map(store.listSessions().map((s) => [`${s.source}|${s.sessionId}`, s]))

  const periods = {}
  for (const [name, start] of Object.entries(starts)) {
    const inPeriod = all.filter((x) => x.at >= start)
    periods[name] = {
      startsAt: start,
      byEngine: ENGINES.map(({ id }) => {
        const mine = inPeriod.filter((x) => x.engine === id)
        return { id, ...total(mine), ...(id === 'hermes' ? { providers: providers(mine) } : {}) }
      }),
      topTasks: topTasks(inPeriod, sessions)
    }
  }

  return {
    generatedAt: now,
    engines: ENGINES.map(({ id, name }) => ({ id, name, ...engineReadings(limits, id, now) })),
    periods
  }
}
