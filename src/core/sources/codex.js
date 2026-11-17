// Reads Codex's own session logs (~/.codex/sessions and archived_sessions, rollout-*.jsonl) a few new
// bytes at a time. It returns completed replies (tokens only), the session's label and parent, and the
// newest allowance readings. It never returns or keeps message text.
//
// Rules (checked against real logs on 2026-11-17; see docs/data-sources.md):
// - One reply per `token_usage_record` for this session's own thread, keyed by `response_id`.
// - A sub-agent's log starts with a copy of its parent's history. Skip lines before
//   `subagent_history_start_ordinal`; without that marker, skip until a `task_started` that began
//   in or after the second the sub-agent was created (codex-switch's rule).
// - Older logs without usage records: a `token_count` line is a reply when its running total changed.
// - Allowance comes from `token_count` lines whose `rate_limits` is not null.
import fs from 'node:fs'
import path from 'node:path'
import { readLines } from '../lines.js'

const SOURCE = 'codex'
// Only lines naming one of these are decoded; everything else (messages, tool output) is skipped.
const MARKERS = ['"session_meta"', '"turn_context"', '"token_count"', '"token_usage_record"', '"task_started"']

export function listCodexFiles(codexHome) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) found.push(full)
    }
  }
  walk(path.join(codexHome, 'sessions'))
  walk(path.join(codexHome, 'archived_sessions'))
  return found.sort()
}

function freshCursor() {
  return {
    offset: 0,
    sessionId: null,
    createdMs: null,
    isSubagent: false,
    historyOrdinal: null,
    historyEnded: false,
    model: null,
    prevTotals: null,
    sawUsageRecords: false
  }
}

const n = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0)

function usageOf(u = {}) {
  return {
    input: n(u.input_tokens),
    cachedInput: n(u.cached_input_tokens),
    cacheWrite: n(u.cache_write_input_tokens),
    cacheWrite1h: 0,
    output: n(u.output_tokens),
    reasoning: n(u.reasoning_output_tokens)
  }
}

const isEmpty = (u) => u.input === 0 && u.cachedInput === 0 && u.cacheWrite === 0 && u.output === 0 && u.reasoning === 0

function windowName(limitId, minutes) {
  const base = minutes === 300 ? 'five_hour' : minutes === 10080 ? 'seven_day' : `m${minutes}`
  return limitId && limitId !== 'codex' ? `${limitId}:${base}` : base
}

// cursor: what an earlier call returned for this file, or null to read from the start.
export function readCodexFile(filePath, cursor, { chunkBytes } = {}) {
  const size = fs.statSync(filePath).size
  const c = cursor && cursor.offset <= size ? { ...cursor } : freshCursor()
  const turns = []
  const seen = new Set()
  const limits = new Map()
  const problems = []
  let session = null

  c.offset = readLines(filePath, c.offset, (text, lineOffset) => {
    let line
    try {
      line = JSON.parse(text)
    } catch {
      problems.push({ offset: lineOffset, message: 'This line is not valid JSON.' })
      return
    }
    const p = line.payload || {}
    const atMs = Date.parse(line.timestamp)

    if (line.type === 'session_meta' && !c.sessionId && p.id) {
      c.sessionId = p.id
      c.createdMs = Date.parse(p.timestamp || line.timestamp)
      c.isSubagent = Boolean(p.parent_thread_id)
      c.historyOrdinal = Number.isFinite(p.subagent_history_start_ordinal) ? p.subagent_history_start_ordinal : null
      c.historyEnded = !c.isSubagent
      session = {
        source: SOURCE,
        sessionId: p.id,
        label: p.cwd ? path.win32.basename(p.cwd) || null : null,
        startedMs: Number.isFinite(c.createdMs) ? c.createdMs : null,
        parentId: p.parent_thread_id || null
      }
      return
    }

    if (!c.historyEnded) {
      if (c.historyOrdinal !== null) {
        c.historyEnded = Number.isFinite(line.ordinal) && line.ordinal >= c.historyOrdinal
      } else if (p.type === 'task_started' && Number.isFinite(p.started_at) && Number.isFinite(c.createdMs)) {
        // started_at is whole seconds, so compare in whole seconds: the first task can be logged
        // up to a second "before" the sub-agent's own creation time.
        c.historyEnded = p.started_at >= Math.floor(c.createdMs / 1000)
      }
    }

    if (line.type === 'turn_context' && p.model) {
      c.model = p.model
      return
    }

    if (line.type === 'token_usage_record') {
      if (!c.historyEnded || p.thread_id !== c.sessionId || !p.response_id || !p.usage) return
      c.sawUsageRecords = true
      if (seen.has(p.response_id)) return
      if (!Number.isFinite(atMs)) {
        problems.push({ offset: lineOffset, message: 'A usage record has no time.' })
        return
      }
      seen.add(p.response_id)
      turns.push({ source: SOURCE, turnKey: p.response_id, sessionId: c.sessionId, model: c.model, atMs, ...usageOf(p.usage) })
      return
    }

    if (line.type === 'event_msg' && p.type === 'token_count') {
      if (p.info && p.info.total_token_usage) {
        const totals = JSON.stringify(p.info.total_token_usage)
        const changed = totals !== c.prevTotals
        c.prevTotals = totals
        if (changed && c.historyEnded && !c.sawUsageRecords && Number.isFinite(atMs)) {
          const usage = usageOf(p.info.last_token_usage)
          const key = `tc:${c.sessionId}:${Number.isFinite(line.ordinal) ? line.ordinal : `@${lineOffset}`}`
          if (!isEmpty(usage) && !seen.has(key)) {
            seen.add(key)
            turns.push({ source: SOURCE, turnKey: key, sessionId: c.sessionId, model: c.model, atMs, ...usage })
          }
        }
      }
      const rl = p.rate_limits
      if (rl && c.historyEnded && Number.isFinite(atMs)) {
        for (const w of [rl.primary, rl.secondary]) {
          if (!w || !Number.isFinite(w.used_percent) || !Number.isFinite(w.window_minutes)) continue
          const window = windowName(rl.limit_id, w.window_minutes)
          const prev = limits.get(window)
          if (prev && prev.observedMs > atMs) continue
          limits.set(window, {
            source: SOURCE,
            window,
            usedPercent: w.used_percent,
            windowMinutes: w.window_minutes,
            resetsAtMs: Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null,
            observedMs: atMs,
            plan: rl.plan_type || null,
            credits: rl.credits || null
          })
        }
      }
    }
  }, { chunkBytes, markers: MARKERS })

  return { cursor: c, turns, session, limits: [...limits.values()], problems }
}
