// Writes made-up Codex, Claude Code and Hermes folders (and a data folder with a Claude status line
// reading) into <outDir>, timed relative to now, for screenshots and the UI check. Every name says
// "demo"; none of it is real usage. Usage: node scripts/demo-homes.mjs <outDir>
// Prints the four IV_SWITCHBOARD_* paths as JSON.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = path.resolve(process.argv[2] || 'qa/demo')
fs.rmSync(out, { recursive: true, force: true })
const NOW = Date.now()
const H = 3600000
const D = 24 * H
const iso = (ms) => new Date(ms).toISOString()
const dirs = { dataDir: path.join(out, 'data'), codexHome: path.join(out, 'codex'), claudeHome: path.join(out, 'claude'), hermesHome: path.join(out, 'hermes') }
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })

// ---------- Codex ----------
let ord = 0
function codexSession({ id, cwd, start, parent = null, replies, model = 'gpt-6.1-sol', limit = null }) {
  ord = 0
  const day = new Date(start)
  const dir = path.join(dirs.codexHome, 'sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'))
  fs.mkdirSync(dir, { recursive: true })
  const line = (ts, type, payload) => JSON.stringify({ timestamp: iso(ts), ordinal: ord++, type, payload })
  const lines = [line(start, 'session_meta', { id, timestamp: iso(start), cwd, originator: 'demo', ...(parent ? { parent_thread_id: parent, subagent_history_start_ordinal: 1 } : {}) })]
  lines.push(line(start + 1000, 'turn_context', { model }))
  let total = 0
  replies.forEach(([at, input, cached, output], i) => {
    total += input + output
    lines.push(line(at, 'token_usage_record', { thread_id: id, response_id: `${id}-r${i}`, usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } }))
    const rl = limit && i === replies.length - 1 ? limit : null
    lines.push(line(at + 100, 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input } }, rate_limits: rl }))
  })
  fs.writeFileSync(path.join(dir, `rollout-demo-${id}.jsonl`), lines.join('\n') + '\n')
}
const many = (from, count, step, input, cached, output) => Array.from({ length: count }, (_, i) => [from + i * step, input, cached, output])
codexSession({ id: 'demo-codex-1', cwd: 'C:\\work\\demo-client-site', start: NOW - 3 * H, replies: many(NOW - 3 * H + 60000, 40, 4 * 60000, 180000, 160000, 2500) })
codexSession({ id: 'demo-codex-2', cwd: 'C:\\work\\demo-client-site', start: NOW - 2 * H, parent: 'demo-codex-1', replies: many(NOW - 2 * H + 60000, 15, 3 * 60000, 90000, 70000, 1200) })
codexSession({ id: 'demo-codex-3', cwd: 'C:\\work\\demo-api-refactor', start: NOW - 3 * D, model: 'gpt-6-astra', replies: many(NOW - 3 * D + 60000, 30, 5 * 60000, 120000, 100000, 3000) })
codexSession({
  id: 'demo-codex-4', cwd: 'C:\\work\\demo-data-cleanup', start: NOW - 20 * 60000,
  replies: many(NOW - 15 * 60000, 5, 60000, 60000, 50000, 800),
  limit: { limit_id: 'codex', primary: { used_percent: 72, window_minutes: 10080, resets_at: Math.round((NOW + 2.2 * D) / 1000) }, secondary: null, credits: null, plan_type: 'pro' }
})

// ---------- Claude Code ----------
function claudeSession({ id, project, cwd, replies, model = 'claude-opus-5-5' }) {
  const dir = path.join(dirs.claudeHome, 'projects', project)
  fs.mkdirSync(dir, { recursive: true })
  const lines = replies.map(([at, input, read, write, output], i) => JSON.stringify({
    type: 'assistant', sessionId: id, timestamp: iso(at), requestId: `${id}-q${i}`, cwd,
    message: { id: `${id}-m${i}`, model, usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output, cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 } } }
  }))
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n')
}
claudeSession({ id: 'demo-claude-1', project: 'C--work-demo-iv-studio', cwd: 'C:\\work\\demo-iv-studio', replies: many(NOW - 5 * H, 120, 2 * 60000, 6, 220000, 4000, 900) })
claudeSession({ id: 'demo-claude-2', project: 'C--work-demo-skills-pack', cwd: 'C:\\work\\demo-skills-pack', replies: many(NOW - 26 * H, 60, 3 * 60000, 4, 150000, 3000, 700) })
claudeSession({ id: 'demo-claude-3', project: 'C--work-demo-a-very-long-client-project-name-that-needs-truncating', cwd: 'C:\\work\\demo-a-very-long-client-project-name-that-needs-truncating', replies: many(NOW - 8 * D, 80, 3 * 60000, 4, 180000, 2000, 600) })
fs.writeFileSync(path.join(dirs.dataDir, 'claude-limits.json'), JSON.stringify({
  observed_at: NOW - 5 * 60000,
  five_hour: { used_percentage: 34, resets_at: Math.round((NOW + 2.5 * H) / 1000) },
  seven_day: { used_percentage: 48, resets_at: Math.round((NOW + 4 * D) / 1000) }
}))

// ---------- Hermes ----------
const db = new DatabaseSync(path.join(dirs.hermesHome, 'state.db'))
db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, started_at REAL, parent_session_id TEXT);
CREATE TABLE session_model_usage (session_id TEXT NOT NULL, model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '', billing_base_url TEXT NOT NULL DEFAULT '',
  billing_mode TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '', api_call_count INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0, actual_cost_usd REAL NOT NULL DEFAULT 0, cost_status TEXT,
  cost_source TEXT, first_seen REAL, last_seen REAL, PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task))`)
db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('demo-h1', 'Demo: plan the launch week', 'C:\\work\\demo', (NOW - 4 * H) / 1000, null)
const u = db.prepare(`INSERT INTO session_model_usage (session_id, model, billing_provider, billing_mode, input_tokens, output_tokens, cache_read_tokens, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
u.run('demo-h1', 'gpt-6.1-sol', 'openai-codex', 'subscription_included', 900000, 40000, 6000000, (NOW - 4 * H) / 1000, (NOW - 2 * H) / 1000)
u.run('demo-h1', 'grok-4.6', 'xai-oauth', '', 300000, 20000, 900000, (NOW - 4 * H) / 1000, (NOW - 3 * H) / 1000)
db.close()

console.log(JSON.stringify({
  IV_SWITCHBOARD_DATA_DIR: dirs.dataDir,
  IV_SWITCHBOARD_CODEX_HOME: dirs.codexHome,
  IV_SWITCHBOARD_CLAUDE_HOME: dirs.claudeHome,
  IV_SWITCHBOARD_HERMES_HOME: dirs.hermesHome
}))
