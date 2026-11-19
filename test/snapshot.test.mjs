import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openStore } from '../src/core/store.js'
import { buildSnapshot } from '../src/core/snapshot.js'
import { costUsd } from '../src/core/prices.js'

const HOUR = 3600000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const store = () => openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-snap-')))

// Noon local time on a fixed day, so the day boundaries are well clear of the test times.
const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime()
const MIDNIGHT = new Date(2026, 10, 17, 0, 0, 0).getTime()

const turn = (over) => ({ source: 'codex', turnKey: 'k', sessionId: 's', model: 'gpt-6.1-sol', atMs: NOW - HOUR, input: 1000, cachedInput: 0, cacheWrite: 0, cacheWrite1h: 0, output: 100, reasoning: 0, ...over })
const engine = (snap, id) => snap.engines.find((e) => e.id === id)
const period = (snap, name, id) => snap.periods[name].byEngine.find((e) => e.id === id)

test('engines come in a fixed order and say plainly when they have no reading', () => {
  const s = store()
  const snap = buildSnapshot(s, NOW)
  s.close()
  assert.deepEqual(snap.engines.map((e) => [e.id, e.name, e.windows.length, e.observedAt]), [
    ['claude', 'Claude Code', 0, null],
    ['codex', 'Codex', 0, null],
    ['hermes', 'Hermes', 0, null]
  ])
  assert.equal(snap.generatedAt, NOW)
})

test('a window shows when it runs out only if that comes before its reset', () => {
  const s = store()
  const observed = NOW - HOUR
  const resetsAt = observed + 3.5 * DAY // half the week has passed at the reading
  s.setLimit({ source: 'codex', window: 'seven_day', usedPercent: 60, windowMinutes: 10080, resetsAtMs: resetsAt, observedMs: observed, plan: 'pro', credits: null })
  s.setLimit({ source: 'claude', window: 'seven_day', usedPercent: 40, windowMinutes: 10080, resetsAtMs: resetsAt, observedMs: observed })
  const snap = buildSnapshot(s, NOW)
  s.close()
  const codex = engine(snap, 'codex').windows[0]
  assert.equal(codex.label, 'Week')
  // 60% in 3.5 days: the last 40% takes 40 / (60 / 3.5) days, measured from the reading.
  assert.equal(codex.runsOutAt, Math.round(observed + (40 * 3.5 * DAY) / 60))
  assert.ok(codex.runsOutAt < resetsAt)
  assert.equal(engine(snap, 'codex').plan, 'pro')
  assert.equal(engine(snap, 'claude').windows[0].runsOutAt, null, '40% at half time lasts past the reset')
})

test('a window past its reset says so and makes no forecast; a full window is out', () => {
  const s = store()
  s.setLimit({ source: 'claude', window: 'five_hour', usedPercent: 90, windowMinutes: 300, resetsAtMs: NOW - 1, observedMs: NOW - 2 * HOUR })
  s.setLimit({ source: 'claude', window: 'seven_day', usedPercent: 100, windowMinutes: 10080, resetsAtMs: NOW + DAY, observedMs: NOW - HOUR })
  const [five, week] = engine(buildSnapshot(s, NOW), 'claude').windows
  s.close()
  assert.deepEqual([five.label, five.isPastReset, five.runsOutAt, five.isOut], ['5 hours', true, null, false])
  assert.deepEqual([week.isPastReset, week.isOut, week.runsOutAt], [false, true, null])
})

test('a Claude reading is out of date once replies keep coming more than 10 minutes after it', () => {
  const s = store()
  const observed = NOW - 2 * DAY
  s.setLimit({ source: 'claude', window: 'seven_day', usedPercent: 60, windowMinutes: 10080, resetsAtMs: NOW + 3 * DAY, observedMs: observed })
  s.setLimit({ source: 'codex', window: 'seven_day', usedPercent: 50, windowMinutes: 10080, resetsAtMs: NOW + 3 * DAY, observedMs: observed })
  const claudeTurn = (key, atMs) => turn({ source: 'claude', turnKey: key, model: 'claude-opus-5-5', atMs })
  s.addTurns([claudeTurn('before', observed - HOUR), claudeTurn('just-after', observed + 5 * 60000)])
  let claude = engine(buildSnapshot(s, NOW), 'claude')
  assert.deepEqual([claude.repliesSinceReading, claude.isStale], [1, false], 'a reply within 10 minutes of the reading')
  assert.ok(claude.windows[0].runsOutAt, '60% two days into the week forecasts a run-out')
  s.addTurns([claudeTurn('code-tab-1', NOW - DAY), claudeTurn('code-tab-2', NOW - HOUR), turn({ turnKey: 'codex-later', atMs: NOW - HOUR })])
  const snap = buildSnapshot(s, NOW)
  s.close()
  claude = engine(snap, 'claude')
  assert.deepEqual([claude.repliesSinceReading, claude.isStale], [3, true])
  assert.equal(claude.windows[0].runsOutAt, null, 'no forecast from an out-of-date pace')
  const codex = engine(snap, 'codex')
  assert.deepEqual([codex.repliesSinceReading, codex.isStale], [0, false], 'Codex logs its reading with every reply')
  assert.deepEqual([engine(snap, 'hermes').isStale, engine(snap, 'hermes').repliesSinceReading], [false, 0])
})

test('too early in a window to forecast', () => {
  const s = store()
  const resetsAt = NOW + WEEK - HOUR // one hour into the week
  s.setLimit({ source: 'codex', window: 'seven_day', usedPercent: 30, windowMinutes: 10080, resetsAtMs: resetsAt, observedMs: NOW })
  assert.equal(engine(buildSnapshot(s, NOW), 'codex').windows[0].runsOutAt, null)
  s.close()
})

test('Today starts at local midnight; 7 and 30 days are calendar days including today (clock changes too)', () => {
  const s = store()
  // Calendar midnights, not multiples of 24 hours: the 30 days back cross the 1 November clock change.
  const weekEdge = new Date(2026, 10, 11).getTime()
  const monthEdge = new Date(2026, 9, 19).getTime()
  s.addTurns([
    turn({ turnKey: 'today', atMs: MIDNIGHT }),
    turn({ turnKey: 'yesterday', atMs: MIDNIGHT - 1 }),
    turn({ turnKey: 'week-edge', atMs: weekEdge }),
    turn({ turnKey: 'too-old-for-week', atMs: weekEdge - 1 }),
    turn({ turnKey: 'month-edge', atMs: monthEdge }),
    turn({ turnKey: 'too-old', atMs: monthEdge - 1 })
  ])
  const snap = buildSnapshot(s, NOW)
  s.close()
  const each = 1100
  assert.equal(period(snap, 'today', 'codex').tokens, each)
  assert.equal(period(snap, 'week', 'codex').tokens, 3 * each)
  assert.equal(period(snap, 'month', 'codex').tokens, 5 * each)
})

test('cost adds up per engine; an unknown model counts as unpriced tokens, not as free', () => {
  const s = store()
  s.addTurns([
    turn({ turnKey: 'priced' }),
    turn({ turnKey: 'unknown', model: 'codex-auto-review', input: 500, output: 20 })
  ])
  const today = period(buildSnapshot(s, NOW), 'today', 'codex')
  s.close()
  assert.equal(today.tokens, 1100 + 520)
  assert.equal(today.unpricedTokens, 520)
  assert.ok(Math.abs(today.costUsd - costUsd('codex', turn({}))) < 1e-12)
})

test('an engine with only unpriced use has no cost rather than zero', () => {
  const s = store()
  s.addTurns([turn({ turnKey: 'u', model: 'codex-auto-review' })])
  assert.equal(period(buildSnapshot(s, NOW), 'today', 'codex').costUsd, null)
  s.close()
})

test('a sub-agent rolls into its parent task, labelled by the parent', () => {
  const s = store()
  s.upsertSession({ source: 'codex', sessionId: 'parent', label: 'iv-studio', startedMs: NOW - 2 * HOUR })
  s.upsertSession({ source: 'codex', sessionId: 'child', label: 'iv-studio', startedMs: NOW - HOUR, parentId: 'parent' })
  s.upsertSession({ source: 'codex', sessionId: 'grandchild', startedMs: NOW - HOUR, parentId: 'child' })
  s.addTurns([turn({ turnKey: 'a', sessionId: 'parent' }), turn({ turnKey: 'b', sessionId: 'child' }), turn({ turnKey: 'c', sessionId: 'grandchild' })])
  const tasks = buildSnapshot(s, NOW).periods.today.topTasks
  s.close()
  assert.equal(tasks.length, 1)
  assert.deepEqual([tasks[0].engine, tasks[0].label, tasks[0].tokens], ['codex', 'iv-studio', 3300])
})

test('top tasks: at most five, biggest cost first, then tokens; a task with no session is untitled', () => {
  const s = store()
  const turns = []
  for (let i = 1; i <= 7; i++) {
    s.upsertSession({ source: 'claude', sessionId: `s${i}`, label: `task ${i}` })
    turns.push(turn({ source: 'claude', model: 'claude-opus-5-5', turnKey: `t${i}`, sessionId: `s${i}`, input: i * 100, output: 0 }))
  }
  turns.push(turn({ source: 'claude', model: 'claude-opus-5-5', turnKey: 'loose', sessionId: null, input: 100000, output: 0 }))
  s.addTurns(turns)
  const tasks = buildSnapshot(s, NOW).periods.today.topTasks
  s.close()
  assert.deepEqual(tasks.map((t) => t.label), [null, 'task 7', 'task 6', 'task 5', 'task 4'])
})

test('Hermes is priced from the model unless Hermes priced it, and its providers are listed', () => {
  const s = store()
  s.upsertSession({ source: 'hermes', sessionId: 'h1', label: 'Plan the launch' })
  s.replaceHermesUsage([
    { sessionId: 'h1', model: 'gpt-6.1-sol', billingProvider: 'openai-codex', billingMode: 'subscription_included', input: 1000, cachedInput: 4000, cacheWrite: 0, output: 58, reasoning: 0, costUsd: null, lastSeenMs: NOW - HOUR },
    { sessionId: 'h1', model: 'grok-4.6', billingProvider: 'xai-oauth', billingMode: '', input: 100, cachedInput: 0, cacheWrite: 0, output: 10, reasoning: 0, costUsd: 0.25, lastSeenMs: NOW - HOUR }
  ])
  const snap = buildSnapshot(s, NOW)
  s.close()
  const h = period(snap, 'today', 'hermes')
  assert.equal(h.tokens, 5058 + 110)
  assert.ok(Math.abs(h.costUsd - ((1000 * 2 + 4000 * 0.1 + 58 * 10) / 1e6 + 0.25)) < 1e-12)
  assert.deepEqual(h.providers.map((p) => [p.provider, p.mode, p.tokens]), [['openai-codex', 'subscription_included', 5058], ['xai-oauth', '', 110]])
  assert.deepEqual(snap.periods.today.topTasks.map((t) => [t.engine, t.label]), [['hermes', 'Plan the launch']])
})
