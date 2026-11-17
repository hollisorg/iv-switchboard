// Reads Hermes' own usage records from a copy of %LOCALAPPDATA%\hermes\state.db (plus its
// write-ahead log, where a running Hermes keeps its newest rows). The live files are only copied,
// never opened, so Hermes is never locked or changed. The copy is deleted afterwards.
//
// Facts (Hermes v0.22.5, 2026-11-17; see docs/data-sources.md):
// - session_model_usage keeps running totals per session, model, billing provider, base URL, billing
//   mode and task (its own title generation is a separate task row), so rows are added together per
//   session, model, provider and mode.
// - first_seen / last_seen / started_at are epoch seconds with a fraction.
// - input_tokens excludes cache reads (cache_read_tokens is often larger).
// - Cost columns are 0 when Hermes didn't price the call (subscription or unknown billing), so only a
//   positive cost counts; otherwise the meter prices it from the model like everything else.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SOURCE = 'hermes'

const USAGE_SQL = `
  SELECT session_id, model, billing_provider, billing_mode,
    SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cached_input, SUM(cache_write_tokens) AS cache_write,
    SUM(output_tokens) AS output, SUM(reasoning_tokens) AS reasoning,
    MAX(COALESCE(last_seen, first_seen)) AS seen,
    COUNT(*) AS rows_,
    SUM(CASE WHEN actual_cost_usd > 0 THEN actual_cost_usd WHEN estimated_cost_usd > 0 THEN estimated_cost_usd ELSE 0 END) AS cost,
    SUM(actual_cost_usd > 0 OR estimated_cost_usd > 0) AS priced
  FROM session_model_usage
  GROUP BY session_id, model, billing_provider, billing_mode
  ORDER BY session_id, model, billing_provider, billing_mode`

const SESSIONS_SQL = `
  SELECT id, title, cwd, started_at, parent_session_id FROM sessions
  WHERE id IN (SELECT DISTINCT session_id FROM session_model_usage)
  ORDER BY id`

const n = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0)
const ms = (seconds) => (Number.isFinite(seconds) ? Math.round(seconds * 1000) : null)

export function readHermes(hermesHome, tmpDir) {
  const result = { found: false, rows: [], sessions: [], problems: [] }
  const live = path.join(hermesHome, 'state.db')
  if (!fs.existsSync(live)) return result
  result.found = true

  fs.mkdirSync(tmpDir, { recursive: true })
  const work = fs.mkdtempSync(path.join(tmpDir, 'hermes-'))
  let db = null
  try {
    const copy = path.join(work, 'state.db')
    fs.copyFileSync(live, copy)
    if (fs.existsSync(`${live}-wal`)) fs.copyFileSync(`${live}-wal`, `${copy}-wal`)
    db = new DatabaseSync(copy, { readOnly: true })

    const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
    if (!hasTable('session_model_usage')) {
      result.problems.push({ message: "Hermes' state.db has no usage table (session_model_usage), so Hermes usage isn't shown." })
      return result
    }

    for (const r of db.prepare(USAGE_SQL).all()) {
      if (!Number.isFinite(r.seen)) {
        result.problems.push({ message: `A Hermes usage row for session ${r.session_id} has no time, so it was skipped.` })
        continue
      }
      result.rows.push({
        sessionId: r.session_id,
        model: r.model,
        billingProvider: r.billing_provider || '',
        billingMode: r.billing_mode || '',
        input: n(r.input),
        cachedInput: n(r.cached_input),
        cacheWrite: n(r.cache_write),
        output: n(r.output),
        reasoning: n(r.reasoning),
        costUsd: Number(r.priced) === Number(r.rows_) && r.cost > 0 ? r.cost : null,
        lastSeenMs: ms(r.seen)
      })
    }

    if (hasTable('sessions')) {
      for (const s of db.prepare(SESSIONS_SQL).all()) {
        const title = typeof s.title === 'string' ? s.title.trim() : ''
        result.sessions.push({
          source: SOURCE,
          sessionId: s.id,
          label: title || (s.cwd ? path.win32.basename(s.cwd) || null : null),
          startedMs: ms(s.started_at),
          parentId: s.parent_session_id || null
        })
      }
    }
    return result
  } catch (e) {
    result.problems.push({ message: `Hermes' usage couldn't be read this time (${e.code || e.message}).` })
    return result
  } finally {
    if (db) db.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
}
