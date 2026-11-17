// Reads Claude Code's transcripts (~/.claude/projects/<project>/<session>.jsonl and
// <session>/subagents/agent-*.jsonl) a few new bytes at a time, and the small file the status line
// tap writes with Claude's five-hour and weekly allowance. It never returns or keeps message text.
//
// Rules (checked against real transcripts on 2026-11-17; see docs/data-sources.md):
// - A reply is an assistant line with message.usage, keyed by message.id + "|" + requestId
//   (23 lines have no requestId; their key ends in "|").
// - Claude repeats a reply's line once per content block, and the early copies can carry a partial
//   output count, so keep the largest of each count. A resumed session copies earlier replies into
//   its own file; the shared key means the store counts them once.
// - Sub-agent replies already carry the parent session's id, so they roll up into it.
// - Lines with no tokens at all (the "<synthetic>" model) are not replies.
import fs from 'node:fs'
import path from 'node:path'
import { readLines } from '../lines.js'

const SOURCE = 'claude'
const MARKERS = ['"usage"']

export function listClaudeFiles(claudeHome) {
  const root = path.join(claudeHome, 'projects')
  const found = []
  const dirents = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
  }
  for (const project of dirents(root)) {
    if (!project.isDirectory()) continue
    const pdir = path.join(root, project.name)
    for (const e of dirents(pdir)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) found.push(path.join(pdir, e.name))
      else if (e.isDirectory()) {
        const subs = path.join(pdir, e.name, 'subagents')
        for (const s of dirents(subs)) if (s.isFile() && s.name.endsWith('.jsonl')) found.push(path.join(subs, s.name))
      }
    }
  }
  return found.sort()
}

const n = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0)
const isSubagentFile = (filePath) => path.basename(path.dirname(filePath)) === 'subagents'

function tokensOf(u) {
  return {
    input: n(u.input_tokens),
    cachedInput: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
    cacheWrite1h: n(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens),
    output: n(u.output_tokens),
    reasoning: n(u.output_tokens_details && u.output_tokens_details.thinking_tokens)
  }
}

const TOKEN_FIELDS = ['input', 'cachedInput', 'cacheWrite', 'cacheWrite1h', 'output', 'reasoning']

// cursor: what an earlier call returned for this file, or null to read from the start.
export function readClaudeFile(filePath, cursor, { chunkBytes } = {}) {
  const size = fs.statSync(filePath).size
  const c = cursor && cursor.offset <= size ? { ...cursor } : { offset: 0, sessionReported: false }
  const byKey = new Map()
  const problems = []
  let session = null
  const subagent = isSubagentFile(filePath)

  c.offset = readLines(filePath, c.offset, (text, lineOffset) => {
    let line
    try {
      line = JSON.parse(text)
    } catch {
      problems.push({ offset: lineOffset, message: 'This line is not valid JSON.' })
      return
    }
    const m = line.message
    if (line.type !== 'assistant' || !m || !m.usage || !m.id) return
    const tokens = tokensOf(m.usage)
    if (TOKEN_FIELDS.every((f) => tokens[f] === 0)) return
    const atMs = Date.parse(line.timestamp)
    if (!Number.isFinite(atMs)) {
      problems.push({ offset: lineOffset, message: 'A reply has no time.' })
      return
    }
    const key = `${m.id}|${line.requestId || ''}`
    const known = byKey.get(key)
    if (known) {
      for (const f of TOKEN_FIELDS) known[f] = Math.max(known[f], tokens[f])
    } else {
      byKey.set(key, { source: SOURCE, turnKey: key, sessionId: line.sessionId || null, model: m.model || null, atMs, ...tokens })
    }
    if (!subagent && !c.sessionReported && line.sessionId) {
      c.sessionReported = true
      session = {
        source: SOURCE,
        sessionId: line.sessionId,
        label: line.cwd ? path.win32.basename(line.cwd) || null : null,
        startedMs: atMs,
        parentId: null
      }
    }
  }, { chunkBytes, markers: MARKERS })

  return { cursor: c, turns: [...byKey.values()], session, problems }
}

// The status line tap (resources/statusline.cjs) writes this file whenever Claude Code passes it
// rate_limits. Claude drops a window once it resets, so either window can be missing.
export function readClaudeLimits(dataDir) {
  let saved
  try {
    saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-limits.json'), 'utf8'))
  } catch {
    return []
  }
  if (!saved || !Number.isFinite(saved.observed_at)) return []
  const out = []
  for (const [window, minutes] of [['five_hour', 300], ['seven_day', 10080]]) {
    const w = saved[window]
    if (!w || !Number.isFinite(w.used_percentage)) continue
    out.push({
      source: SOURCE,
      window,
      usedPercent: w.used_percentage,
      windowMinutes: minutes,
      resetsAtMs: Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null,
      observedMs: saved.observed_at,
      plan: null,
      credits: null
    })
  }
  return out
}
