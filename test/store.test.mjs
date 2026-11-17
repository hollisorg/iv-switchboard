import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStore, SCHEMA_VERSION } from '../src/core/store.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-store-'))
}

const turn = (over = {}) => ({
  source: 'codex',
  turnKey: 'resp_1',
  sessionId: 'thread-a',
  model: 'gpt-6.1-sol',
  atMs: Date.UTC(2026, 10, 17, 9, 0, 0),
  input: 1000,
  cachedInput: 400,
  cacheWrite: 0,
  cacheWrite1h: 0,
  output: 50,
  reasoning: 10,
  ...over
})

const limit = (over = {}) => ({
  source: 'codex',
  window: 'seven_day',
  usedPercent: 50,
  windowMinutes: 10080,
  resetsAtMs: Date.UTC(2026, 10, 20, 9, 0, 0),
  observedMs: Date.UTC(2026, 10, 17, 9, 0, 0),
  plan: 'pro',
  credits: { has_credits: true, unlimited: false, balance: '10.5' },
  ...over
})

test('a new store creates switchboard.db at the current schema version', () => {
  const dir = tempDir()
  const store = openStore(dir)
  store.close()
  assert.ok(fs.existsSync(path.join(dir, 'switchboard.db')))
  const db = new DatabaseSync(path.join(dir, 'switchboard.db'), { readOnly: true })
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name)
  db.close()
  assert.deepEqual(tables, ['files', 'hermes_usage', 'limits', 'sessions', 'turns'])
})

test('adding the same turn twice stores one row', () => {
  const store = openStore(tempDir())
  assert.equal(store.addTurns([turn()]), 1)
  assert.equal(store.addTurns([turn(), turn({ turnKey: 'resp_2', output: 70 })]), 1)
  const rows = store.turnsSince(0)
  store.close()
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.turnKey).sort(), ['resp_1', 'resp_2'])
  assert.deepEqual(rows.find((r) => r.turnKey === 'resp_1'), turn())
})

test('a repeat of a reply raises its counts and never lowers them (Claude logs a reply before it finishes)', () => {
  const store = openStore(tempDir())
  store.addTurns([turn({ source: 'claude', turnKey: 'msg_1|req_1', output: 3, cacheWrite: 500, cacheWrite1h: 500 })])
  assert.equal(store.addTurns([turn({ source: 'claude', turnKey: 'msg_1|req_1', output: 210, cacheWrite: 500, cacheWrite1h: 500, atMs: 1 })]), 0)
  store.addTurns([turn({ source: 'claude', turnKey: 'msg_1|req_1', output: 40 })])
  const [only] = store.turnsSince(0)
  store.close()
  assert.equal(only.output, 210)
  assert.equal(only.cacheWrite1h, 500)
  assert.equal(only.atMs, turn().atMs, 'the first time seen is kept')
})

test('the same turn key from different sources are different turns', () => {
  const store = openStore(tempDir())
  store.addTurns([turn(), turn({ source: 'claude' })])
  assert.equal(store.turnsSince(0).length, 2)
  store.close()
})

test('turnsSince returns turns at or after the time only', () => {
  const store = openStore(tempDir())
  const t = Date.UTC(2026, 10, 17, 0, 0, 0)
  store.addTurns([turn({ turnKey: 'old', atMs: t - 1 }), turn({ turnKey: 'edge', atMs: t }), turn({ turnKey: 'new', atMs: t + 1 })])
  assert.deepEqual(store.turnsSince(t).map((r) => r.turnKey).sort(), ['edge', 'new'])
  store.close()
})

test('an older limit reading never replaces a newer one', () => {
  const store = openStore(tempDir())
  const t = Date.UTC(2026, 10, 17, 9, 0, 0)
  store.setLimit(limit({ usedPercent: 60, observedMs: t }))
  store.setLimit(limit({ usedPercent: 40, observedMs: t - 60000 }))
  assert.equal(store.listLimits()[0].usedPercent, 60)
  store.setLimit(limit({ usedPercent: 65, observedMs: t + 60000 }))
  const [only] = store.listLimits()
  store.close()
  assert.equal(only.usedPercent, 65)
  assert.equal(only.observedMs, t + 60000)
  assert.deepEqual(only.credits, { has_credits: true, unlimited: false, balance: '10.5' })
})

test('limits are kept per source and window', () => {
  const store = openStore(tempDir())
  store.setLimit(limit())
  store.setLimit(limit({ window: 'five_hour', windowMinutes: 300 }))
  store.setLimit(limit({ source: 'claude', credits: null, plan: null }))
  const keys = store.listLimits().map((l) => `${l.source}/${l.window}`).sort()
  store.close()
  assert.deepEqual(keys, ['claude/seven_day', 'codex/five_hour', 'codex/seven_day'])
})

test('file cursors round-trip, including the JSON state', () => {
  const store = openStore(tempDir())
  assert.equal(store.getFile('C:/x/rollout-1.jsonl'), null)
  const file = { path: 'C:/x/rollout-1.jsonl', source: 'codex', size: 2048, mtimeMs: 1795000000000, offset: 1990, state: { model: 'gpt-6.1-sol', historyEnded: true } }
  store.setFile(file)
  assert.deepEqual(store.getFile(file.path), file)
  store.setFile({ ...file, size: 4096, offset: 4096 })
  assert.equal(store.getFile(file.path).offset, 4096)
  store.close()
})

test('sessions keep known fields when a later upsert leaves them out', () => {
  const store = openStore(tempDir())
  store.upsertSession({ source: 'claude', sessionId: 's1', label: 'iv-studio', startedMs: 100, parentId: null })
  store.upsertSession({ source: 'claude', sessionId: 's1', label: null, startedMs: null, parentId: null })
  store.upsertSession({ source: 'claude', sessionId: 'sub1', label: 'iv-studio', startedMs: 200, parentId: 's1' })
  const sessions = store.listSessions().sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  store.close()
  assert.deepEqual(sessions, [
    { source: 'claude', sessionId: 's1', label: 'iv-studio', startedMs: 100, parentId: null },
    { source: 'claude', sessionId: 'sub1', label: 'iv-studio', startedMs: 200, parentId: 's1' }
  ])
})

test('replaceHermesUsage swaps the whole set, and hermesSince filters by last seen', () => {
  const store = openStore(tempDir())
  const row = (over) => ({ sessionId: 'h1', model: 'gpt-6.1-sol', billingProvider: 'openai-codex', billingMode: 'subscription_included', input: 10, cachedInput: 2, cacheWrite: 0, output: 5, reasoning: 1, costUsd: 0.25, lastSeenMs: 1000, ...over })
  store.replaceHermesUsage([row(), row({ sessionId: 'h2', lastSeenMs: 3000 })])
  store.replaceHermesUsage([row({ sessionId: 'h3', lastSeenMs: 5000, costUsd: null })])
  const all = store.hermesSince(0)
  assert.deepEqual(all, [row({ sessionId: 'h3', lastSeenMs: 5000, costUsd: null })])
  assert.deepEqual(store.hermesSince(5001), [])
  store.close()
})

test('Hermes rows for one session and model through two providers are both kept', () => {
  const store = openStore(tempDir())
  const row = (billingProvider, input) => ({ sessionId: 'h1', model: 'm', billingProvider, billingMode: '', input, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: null, lastSeenMs: 1 })
  store.replaceHermesUsage([row('openai-codex', 1), row('openrouter', 2)])
  assert.deepEqual(store.hermesSince(0).map((r) => [r.billingProvider, r.input]).sort(), [['openai-codex', 1], ['openrouter', 2]])
  store.close()
})

test('Hermes rows for one session, model and provider under two billing modes are both kept (seen in real data)', () => {
  const store = openStore(tempDir())
  const row = (billingMode, input) => ({ sessionId: 'h1', model: 'gpt-6.1-sol', billingProvider: 'openai-codex', billingMode, input, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: null, lastSeenMs: 1 })
  store.replaceHermesUsage([row('', 1), row('subscription_included', 2)])
  assert.deepEqual(store.hermesSince(0).map((r) => [r.billingMode, r.input]).sort(), [['', 1], ['subscription_included', 2]])
  store.close()
})

test('reopening keeps the data and does not run the migration again', () => {
  const dir = tempDir()
  const first = openStore(dir)
  first.addTurns([turn()])
  first.close()
  const second = openStore(dir)
  assert.equal(second.turnsSince(0).length, 1)
  second.close()
})

test('a database from a newer IV Switchboard is refused with a clear message', () => {
  const dir = tempDir()
  const db = new DatabaseSync(path.join(dir, 'switchboard.db'))
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
  db.close()
  assert.throws(() => openStore(dir), /newer version of IV Switchboard/)
})

test('a failed batch adds nothing', () => {
  const store = openStore(tempDir())
  assert.throws(() => store.addTurns([turn({ turnKey: 'ok' }), turn({ turnKey: null })]))
  assert.equal(store.turnsSince(0).length, 0)
  store.close()
})
