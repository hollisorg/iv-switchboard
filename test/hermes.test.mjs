import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readHermes } from '../src/core/sources/hermes.js'

// Hermes v0.22.5's own table definition (read from a real state.db schema, 2026-11-17); the data is made up.
const USAGE_TABLE = `CREATE TABLE session_model_usage (
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    billing_provider TEXT NOT NULL DEFAULT '',
    billing_base_url TEXT NOT NULL DEFAULT '',
    billing_mode TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '',
    api_call_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    actual_cost_usd REAL NOT NULL DEFAULT 0,
    cost_status TEXT,
    cost_source TEXT,
    first_seen REAL,
    last_seen REAL,
    PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
)`
const SESSIONS_TABLE = 'CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL, parent_session_id TEXT)'

function makeHermes({ rows = [], sessions = [], withTables = true, keepOpen = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-hermes-'))
  const home = path.join(root, 'hermes')
  fs.mkdirSync(home)
  const db = new DatabaseSync(path.join(home, 'state.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA wal_autocheckpoint = 0') // keep new rows in the WAL file, like a running Hermes
  if (withTables) {
    db.exec(USAGE_TABLE)
    db.exec(SESSIONS_TABLE)
    const s = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
    for (const x of sessions) s.run(x.id, x.title ?? null, x.cwd ?? null, x.started_at ?? null, x.parent ?? null)
    const u = db.prepare(`INSERT INTO session_model_usage (session_id, model, billing_provider, billing_mode, task, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd, cost_status, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const r of rows) {
      u.run(r.session, r.model, r.provider ?? '', r.mode ?? '', r.task ?? '', r.input ?? 0, r.output ?? 0, r.read ?? 0, r.write ?? 0,
        r.reasoning ?? 0, r.est ?? 0, r.actual ?? 0, r.status ?? null, r.first ?? null, r.last ?? null)
    }
  }
  if (!keepOpen) db.close()
  return { root, home, tmp: path.join(root, 'tmp'), db }
}

const T = 1794500000.25 // epoch seconds, with a fraction, as Hermes stores them

test('task rows for the same session, model and provider are added together', () => {
  const { home, tmp } = makeHermes({
    sessions: [{ id: 'h1', title: 'Plan the launch', cwd: 'C:\\work\\iv-studio', started_at: T - 100 }],
    rows: [
      { session: 'h1', model: 'gpt-6.1-sol', provider: 'openai-codex', mode: 'subscription_included', input: 1000, output: 50, read: 4000, write: 10, reasoning: 5, first: T - 90, last: T },
      { session: 'h1', model: 'gpt-6.1-sol', provider: 'openai-codex', mode: 'subscription_included', task: 'title_generation', input: 20, output: 8, first: T - 89, last: T - 80 }
    ]
  })
  const r = readHermes(home, tmp)
  assert.equal(r.found, true)
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.rows, [{
    sessionId: 'h1', model: 'gpt-6.1-sol', billingProvider: 'openai-codex', billingMode: 'subscription_included',
    input: 1020, cachedInput: 4000, cacheWrite: 10, output: 58, reasoning: 5, costUsd: null, lastSeenMs: Math.round(T * 1000)
  }])
  assert.deepEqual(r.sessions, [{ source: 'hermes', sessionId: 'h1', label: 'Plan the launch', startedMs: Math.round((T - 100) * 1000), parentId: null }])
})

test('different providers for the same model stay separate rows', () => {
  const { home, tmp } = makeHermes({
    sessions: [{ id: 'h1' }],
    rows: [
      { session: 'h1', model: 'm', provider: 'openai-codex', input: 1, last: T },
      { session: 'h1', model: 'm', provider: 'openrouter', input: 2, last: T }
    ]
  })
  assert.deepEqual(readHermes(home, tmp).rows.map((r) => [r.billingProvider, r.input]), [['openai-codex', 1], ['openrouter', 2]])
})

test('a zero cost means not priced; a positive actual or estimated cost is kept', () => {
  const { home, tmp } = makeHermes({
    sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    rows: [
      { session: 'a', model: 'grok-4.6', provider: 'xai-oauth', input: 5, status: 'unknown', last: T },
      { session: 'b', model: 'x', input: 5, actual: 0.42, est: 0.4, last: T },
      { session: 'c', model: 'x', input: 5, est: 0.31, last: T }
    ]
  })
  assert.deepEqual(readHermes(home, tmp).rows.map((r) => [r.sessionId, r.costUsd]), [['a', null], ['b', 0.42], ['c', 0.31]])
})

test('labels fall back from the title to the working folder name', () => {
  const { home, tmp } = makeHermes({
    sessions: [{ id: 'a', title: 'Named' }, { id: 'b', title: '', cwd: 'D:\\clients\\fran-growth' }, { id: 'c' }],
    rows: ['a', 'b', 'c'].map((s) => ({ session: s, model: 'm', input: 1, last: T }))
  })
  assert.deepEqual(readHermes(home, tmp).sessions.map((s) => [s.sessionId, s.label]), [['a', 'Named'], ['b', 'fran-growth'], ['c', null]])
})

test('rows still in the write-ahead log of a running Hermes are read', () => {
  const { home, tmp, db } = makeHermes({ sessions: [{ id: 'live' }], rows: [{ session: 'live', model: 'm', input: 7, last: T }], keepOpen: true })
  try {
    assert.ok(fs.statSync(path.join(home, 'state.db-wal')).size > 0, 'the test really left data in the WAL')
    assert.deepEqual(readHermes(home, tmp).rows.map((r) => r.input), [7])
  } finally {
    db.close()
  }
})

test('the temporary copy is removed and Hermes files are left as they were', () => {
  const { home, tmp } = makeHermes({ sessions: [{ id: 'a' }], rows: [{ session: 'a', model: 'm', input: 1, last: T }] })
  const before = fs.readdirSync(home).sort().map((f) => [f, fs.statSync(path.join(home, f)).size])
  readHermes(home, tmp)
  assert.deepEqual(fs.existsSync(tmp) ? fs.readdirSync(tmp) : [], [])
  assert.deepEqual(fs.readdirSync(home).sort().map((f) => [f, fs.statSync(path.join(home, f)).size]), before)
})

test('no Hermes folder means nothing found and no error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-hermes-'))
  assert.deepEqual(readHermes(path.join(root, 'missing'), path.join(root, 'tmp')), { found: false, rows: [], sessions: [], problems: [] })
})

test('a Hermes database without the usage table is reported, not thrown', () => {
  const { home, tmp } = makeHermes({ withTables: false })
  const r = readHermes(home, tmp)
  assert.equal(r.found, true)
  assert.deepEqual(r.rows, [])
  assert.match(r.problems[0].message, /no usage table/)
})

test('a missing last-seen time falls back to first-seen; with neither the row is skipped and reported', () => {
  const { home, tmp } = makeHermes({
    sessions: [{ id: 'a' }, { id: 'b' }],
    rows: [{ session: 'a', model: 'm', input: 1, first: T }, { session: 'b', model: 'm', input: 1 }]
  })
  const r = readHermes(home, tmp)
  assert.deepEqual(r.rows.map((x) => [x.sessionId, x.lastSeenMs]), [['a', Math.round(T * 1000)]])
  assert.equal(r.problems.length, 1)
  assert.match(r.problems[0].message, /no time/)
})
