// The one local database (switchboard.db in the data folder). Everything the meter knows lives here:
// read positions in each transcript, one row per completed reply, sessions, the latest allowance
// readings and Hermes' per-session usage. No prompt or reply text is ever stored.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 1

// Never edit a shipped migration; add the next one.
const MIGRATIONS = [
  `
  CREATE TABLE files (
    path TEXT PRIMARY KEY NOT NULL,
    source TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    state TEXT
  );
  CREATE TABLE turns (
    source TEXT NOT NULL,
    turn_key TEXT NOT NULL,
    session_id TEXT,
    model TEXT,
    at_ms INTEGER NOT NULL,
    input INTEGER NOT NULL DEFAULT 0,
    cached_input INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cache_write_1h INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    reasoning INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, turn_key)
  );
  CREATE INDEX turns_at ON turns (at_ms);
  CREATE TABLE sessions (
    source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    label TEXT,
    started_ms INTEGER,
    parent_id TEXT,
    PRIMARY KEY (source, session_id)
  );
  CREATE TABLE limits (
    source TEXT NOT NULL,
    window TEXT NOT NULL,
    used_percent REAL NOT NULL,
    window_minutes INTEGER,
    resets_at_ms INTEGER,
    observed_ms INTEGER NOT NULL,
    plan TEXT,
    credits_json TEXT,
    PRIMARY KEY (source, window)
  );
  CREATE TABLE hermes_usage (
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    billing_provider TEXT NOT NULL DEFAULT '',
    billing_mode TEXT NOT NULL DEFAULT '',
    input INTEGER NOT NULL DEFAULT 0,
    cached_input INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    reasoning INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    last_seen_ms INTEGER NOT NULL,
    PRIMARY KEY (session_id, model, billing_provider, billing_mode)
  );
  CREATE INDEX hermes_last_seen ON hermes_usage (last_seen_ms);
  `
]

const count = (n) => (Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : 0)
const orNull = (v) => (v === undefined ? null : v)

function need(value, name, what) {
  if (value === null || value === undefined || value === '') throw new Error(`${what} is missing ${name}.`)
}

function transaction(db, fn) {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version > SCHEMA_VERSION) {
    throw new Error(`This data was written by a newer version of IV Switchboard (schema ${version}). Update IV Switchboard to read it.`)
  }
  for (let v = version; v < SCHEMA_VERSION; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
    })
  }
}

const toTurn = (r) => ({
  source: r.source,
  turnKey: r.turn_key,
  sessionId: r.session_id,
  model: r.model,
  atMs: r.at_ms,
  input: r.input,
  cachedInput: r.cached_input,
  cacheWrite: r.cache_write,
  cacheWrite1h: r.cache_write_1h,
  output: r.output,
  reasoning: r.reasoning
})

const toSession = (r) => ({ source: r.source, sessionId: r.session_id, label: r.label, startedMs: r.started_ms, parentId: r.parent_id })

const toLimit = (r) => ({
  source: r.source,
  window: r.window,
  usedPercent: r.used_percent,
  windowMinutes: r.window_minutes,
  resetsAtMs: r.resets_at_ms,
  observedMs: r.observed_ms,
  plan: r.plan,
  credits: r.credits_json ? JSON.parse(r.credits_json) : null
})

const toHermes = (r) => ({
  sessionId: r.session_id,
  model: r.model,
  billingProvider: r.billing_provider,
  billingMode: r.billing_mode,
  input: r.input,
  cachedInput: r.cached_input,
  cacheWrite: r.cache_write,
  output: r.output,
  reasoning: r.reasoning,
  costUsd: r.cost_usd,
  lastSeenMs: r.last_seen_ms
})

export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'switchboard.db'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    migrate(db)
  } catch (e) {
    db.close()
    throw e
  }

  const q = {
    getFile: db.prepare('SELECT * FROM files WHERE path = ?'),
    setFile: db.prepare(`
      INSERT INTO files (path, source, size, mtime_ms, offset, state) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET source = excluded.source, size = excluded.size, mtime_ms = excluded.mtime_ms,
        offset = excluded.offset, state = excluded.state`),
    addTurn: db.prepare(`
      INSERT OR IGNORE INTO turns (source, turn_key, session_id, model, at_ms, input, cached_input, cache_write, cache_write_1h, output, reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    raiseTurn: db.prepare(`
      UPDATE turns SET input = MAX(input, ?), cached_input = MAX(cached_input, ?), cache_write = MAX(cache_write, ?),
        cache_write_1h = MAX(cache_write_1h, ?), output = MAX(output, ?), reasoning = MAX(reasoning, ?)
      WHERE source = ? AND turn_key = ?`),
    turnsSince: db.prepare('SELECT * FROM turns WHERE at_ms >= ? ORDER BY at_ms, source, turn_key'),
    upsertSession: db.prepare(`
      INSERT INTO sessions (source, session_id, label, started_ms, parent_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (source, session_id) DO UPDATE SET label = COALESCE(excluded.label, sessions.label),
        started_ms = COALESCE(excluded.started_ms, sessions.started_ms), parent_id = COALESCE(excluded.parent_id, sessions.parent_id)`),
    listSessions: db.prepare('SELECT * FROM sessions ORDER BY source, session_id'),
    setLimit: db.prepare(`
      INSERT INTO limits (source, window, used_percent, window_minutes, resets_at_ms, observed_ms, plan, credits_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, window) DO UPDATE SET used_percent = excluded.used_percent, window_minutes = excluded.window_minutes,
        resets_at_ms = excluded.resets_at_ms, observed_ms = excluded.observed_ms, plan = excluded.plan, credits_json = excluded.credits_json
      WHERE excluded.observed_ms >= limits.observed_ms`),
    listLimits: db.prepare('SELECT * FROM limits ORDER BY source, window'),
    clearHermes: db.prepare('DELETE FROM hermes_usage'),
    addHermes: db.prepare(`
      INSERT INTO hermes_usage (session_id, model, billing_provider, billing_mode, input, cached_input, cache_write, output, reasoning, cost_usd, last_seen_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    hermesSince: db.prepare('SELECT * FROM hermes_usage WHERE last_seen_ms >= ? ORDER BY last_seen_ms, session_id, model')
  }

  return {
    getFile(filePath) {
      const r = q.getFile.get(filePath)
      if (!r) return null
      return { path: r.path, source: r.source, size: r.size, mtimeMs: r.mtime_ms, offset: r.offset, state: r.state ? JSON.parse(r.state) : null }
    },

    setFile({ path: filePath, source, size, mtimeMs, offset, state = null }) {
      need(filePath, 'path', 'A file cursor')
      need(source, 'source', 'A file cursor')
      q.setFile.run(filePath, source, count(size), count(mtimeMs), count(offset), state === null ? null : JSON.stringify(state))
    },

    // Returns how many turns were new. A turn already stored (same source and key) is never counted
    // twice; its token counts only rise to the larger of old and new, because Claude logs a reply
    // before it finishes streaming and repeats it with the final count. A bad turn fails the batch.
    addTurns(turns) {
      for (const t of turns) {
        need(t.source, 'source', 'A turn')
        need(t.turnKey, 'turnKey', 'A turn')
        if (!Number.isFinite(t.atMs)) throw new Error(`Turn ${t.turnKey} has no time.`)
      }
      return transaction(db, () => {
        let added = 0
        for (const t of turns) {
          const tokens = [count(t.input), count(t.cachedInput), count(t.cacheWrite), count(t.cacheWrite1h), count(t.output), count(t.reasoning)]
          const { changes } = q.addTurn.run(t.source, String(t.turnKey), orNull(t.sessionId), orNull(t.model), Math.trunc(t.atMs), ...tokens)
          if (Number(changes)) added++
          else q.raiseTurn.run(...tokens, t.source, String(t.turnKey))
        }
        return added
      })
    },

    turnsSince(sinceMs) {
      return q.turnsSince.all(Math.trunc(sinceMs)).map(toTurn)
    },

    upsertSession({ source, sessionId, label = null, startedMs = null, parentId = null }) {
      need(source, 'source', 'A session')
      need(sessionId, 'sessionId', 'A session')
      q.upsertSession.run(source, sessionId, orNull(label), startedMs === null ? null : Math.trunc(startedMs), orNull(parentId))
    },

    listSessions() {
      return q.listSessions.all().map(toSession)
    },

    // Keeps whichever reading was observed last, so an old transcript read late can't roll a window back.
    setLimit({ source, window, usedPercent, windowMinutes = null, resetsAtMs = null, observedMs, plan = null, credits = null }) {
      need(source, 'source', 'A limit reading')
      need(window, 'window', 'A limit reading')
      if (!Number.isFinite(usedPercent)) throw new Error(`The ${source} ${window} reading has no percentage.`)
      if (!Number.isFinite(observedMs)) throw new Error(`The ${source} ${window} reading has no time.`)
      q.setLimit.run(source, window, usedPercent, windowMinutes === null ? null : count(windowMinutes),
        resetsAtMs === null ? null : Math.trunc(resetsAtMs), Math.trunc(observedMs), orNull(plan), credits === null ? null : JSON.stringify(credits))
    },

    listLimits() {
      return q.listLimits.all().map(toLimit)
    },

    // Hermes keeps running totals per session and model, so each scan replaces the whole set.
    replaceHermesUsage(rows) {
      for (const r of rows) {
        need(r.sessionId, 'sessionId', 'A Hermes usage row')
        need(r.model, 'model', 'A Hermes usage row')
        if (!Number.isFinite(r.lastSeenMs)) throw new Error(`Hermes session ${r.sessionId} has no last-seen time.`)
      }
      transaction(db, () => {
        q.clearHermes.run()
        for (const r of rows) {
          q.addHermes.run(r.sessionId, r.model, r.billingProvider || '', r.billingMode || '', count(r.input), count(r.cachedInput), count(r.cacheWrite),
            count(r.output), count(r.reasoning), Number.isFinite(r.costUsd) ? r.costUsd : null, Math.trunc(r.lastSeenMs))
        }
      })
    },

    hermesSince(sinceMs) {
      return q.hermesSince.all(Math.trunc(sinceMs)).map(toHermes)
    },

    close() {
      db.close()
    }
  }
}
