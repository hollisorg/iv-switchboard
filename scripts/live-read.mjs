// Live read: runs the same scan IV Switchboard runs, on this PC's real Codex, Claude Code and Hermes
// folders, into a THROWAWAY data folder that is deleted afterwards. Read-only: it never writes to those
// folders or to Claude's settings. It prints numbers only: no task names, paths or text.
//   node scripts/live-read.mjs
// Uses the real Claude status line reading if IV Switchboard's own data folder has one (read only).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { paths } from '../src/core/paths.js'
import { openStore } from '../src/core/store.js'
import { scanOnce } from '../src/core/scan.js'

const real = paths()
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-live-'))
const realLimits = path.join(real.dataDir, 'claude-limits.json')
if (fs.existsSync(realLimits)) fs.copyFileSync(realLimits, path.join(scratch, 'claude-limits.json'))
const store = openStore(scratch)
const p = { ...real, dataDir: scratch }

const when = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'none')
const usd = (v) => (v === null ? 'no price' : `$${v.toFixed(2)}`)
const tok = (n) => `${(n / 1e6).toFixed(1)}M`

try {
  const t0 = Date.now()
  const first = scanOnce({ paths: p, store })
  const firstMs = Date.now() - t0
  const t1 = Date.now()
  const second = scanOnce({ paths: p, store })
  const secondMs = Date.now() - t1
  const counts = store.turnsSince(0).reduce((a, t) => ((a[t.source] = (a[t.source] || 0) + 1), a), {})

  console.log(`First scan: ${first.filesRead} files in ${(firstMs / 1000).toFixed(1)} s. Next scan: ${second.filesRead} changed files in ${secondMs} ms.`)
  console.log(`Replies stored: Codex ${counts.codex || 0}, Claude Code ${counts.claude || 0}. Hermes rows: ${store.hermesSince(0).length}. Problems: ${first.problems.length + second.problems.length}.`)
  for (const e of second.snapshot.engines) {
    const ws = e.windows.map((w) => `${w.label} ${Math.round(100 - w.usedPercent)}% left, resets ${when(w.resetsAt)}${w.runsOutAt ? `, runs out ${when(w.runsOutAt)}` : ''}${w.isPastReset ? ' (past reset)' : ''}`)
    console.log(`${e.name}${e.plan ? ` (${e.plan})` : ''}: ${ws.join('; ') || 'no allowance reading'}${e.observedAt ? `; reading ${when(e.observedAt)}` : ''}`)
  }
  for (const [name, label] of [['today', 'Today'], ['week', '7 days'], ['month', '30 days']]) {
    const b = second.snapshot.periods[name].byEngine
    console.log(`${label}: ${b.map((x) => `${x.id} ${tok(x.tokens)} ${usd(x.costUsd)}${x.unpricedTokens ? ` (+${tok(x.unpricedTokens)} unpriced)` : ''}`).join(' | ')}`)
  }
} finally {
  store.close()
  fs.rmSync(scratch, { recursive: true, force: true })
}
