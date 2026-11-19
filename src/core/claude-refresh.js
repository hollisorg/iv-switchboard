// Refresh reads Claude's allowance on request, without a terminal: it runs Claude Code once in print mode
// (Haiku, one turn, no saved session) and keeps only the two windows from the rate_limit_event Claude Code
// reports, in the same claude-limits.json the status line tap writes. The reply itself is thrown away.
// Claude Code uses its own sign-in; IV Switchboard never reads it. Each press costs one short Haiku message,
// so this runs only when the person presses Refresh, never on a timer.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const REFRESH_PROMPT = 'Reply with the single word OK.'
export const REFRESH_ARGS = ['-p', REFRESH_PROMPT, '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-turns', '1']
const TIMEOUT_MS = 90000
const MAX_OUTPUT = 4 * 1024 * 1024

// Claude Code's Windows installer puts claude.exe in ~/.local/bin; an npm install leaves claude.cmd on the
// PATH. IV_SWITCHBOARD_CLAUDE_BIN points tests at a stand-in.
export function findClaude({ env = process.env, home = os.homedir(), platform = process.platform, exists = fs.existsSync } = {}) {
  const override = env.IV_SWITCHBOARD_CLAUDE_BIN?.trim()
  if (override) return exists(override) ? override : null
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  const dirs = [path.join(home, '.local', 'bin'), ...String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)]
  for (const name of names) {
    for (const dir of dirs) {
      const file = path.join(dir, name)
      if (exists(file)) return file
    }
  }
  return null
}

const percent = (utilization) => Math.round(utilization * 1000) / 10

// The last rate_limit_event's five-hour and weekly windows, in the tap's format, or null when there is none
// (an API-key sign-in, for example, has no plan allowance to report).
export function parseLimits(text) {
  let info = null
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.includes('rate_limit_event')) continue
    try {
      const m = JSON.parse(line)
      if (m?.type === 'rate_limit_event' && m.rate_limit_info) info = m.rate_limit_info
    } catch {
      // not a whole JSON line; skip it
    }
  }
  if (!info) return null
  const windows = {}
  for (const key of ['five_hour', 'seven_day']) {
    const w = info.unifiedWindows?.[key] ?? (info.rateLimitType === key ? info : null)
    if (w && Number.isFinite(w.utilization)) windows[key] = { used_percentage: percent(w.utilization), resets_at: Number.isFinite(w.resetsAt) ? w.resetsAt : null }
  }
  return Object.keys(windows).length ? windows : null
}

export function saveLimits(dataDir, windows, now = Date.now()) {
  const file = path.join(dataDir, 'claude-limits.json')
  const temp = `${file}.${process.pid}.refresh.tmp`
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(temp, JSON.stringify({ observed_at: now, ...windows }))
  fs.renameSync(temp, file)
}

// A .cmd shim can only run through cmd.exe. The arguments are this file's own constants, so quoting them
// is enough; nothing from outside reaches the command line.
function command(bin, args) {
  if (/\.cmd$/i.test(bin)) {
    const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a}"` : a)
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[bin, ...args].map(quote).join(' ')}"`], verbatim: true }
  }
  return { file: bin, args, verbatim: false }
}

function firstLine(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200) || ''
}

export function refreshClaude({ dataDir, bin, spawnImpl = spawn, timeoutMs = TIMEOUT_MS, now = () => Date.now(), env = process.env } = {}) {
  if (!bin) return Promise.resolve({ ok: false, message: "Claude Code wasn't found on this PC. Install it, or send one message from it in a terminal." })
  // An empty folder of its own, so no project's CLAUDE.md or settings come along.
  const cwd = path.join(os.tmpdir(), 'iv-switchboard-claude-refresh')
  fs.mkdirSync(cwd, { recursive: true })
  const childEnv = { ...env }
  delete childEnv.CLAUDECODE
  delete childEnv.ELECTRON_RUN_AS_NODE
  const { file, args, verbatim } = command(bin, REFRESH_ARGS)

  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    let child
    try {
      child = spawnImpl(file, args, { cwd, env: childEnv, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      finish({ ok: false, message: `Couldn't start Claude Code: ${e.message}` })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, message: "Claude Code didn't answer within 90 seconds. Try again, or send one message from it in a terminal." })
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      if (out.length < MAX_OUTPUT) out += d
    })
    child.stderr.on('data', (d) => {
      if (err.length < 64 * 1024) err += d
    })
    child.on('error', (e) => finish({ ok: false, message: `Couldn't start Claude Code: ${e.message}` }))
    child.on('close', (code) => {
      const windows = parseLimits(out)
      if (windows) {
        try {
          saveLimits(dataDir, windows, now())
          finish({ ok: true, message: 'Updated from Claude Code.', windows })
        } catch (e) {
          finish({ ok: false, message: `Couldn't save the reading: ${e.message}` })
        }
        return
      }
      const why = firstLine(err)
      finish({
        ok: false,
        message:
          code === 0
            ? "Claude Code answered but didn't report an allowance. Refresh needs a Claude Pro, Max or Ultra sign-in."
            : `Claude Code stopped without a reading${why ? `: ${why}` : '.'} Check that it's signed in by opening it in a terminal.`
      })
    })
  })
}
