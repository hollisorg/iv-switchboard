#!/usr/bin/env node
// IV Switchboard's status line tap. Claude Code runs it after each reply and passes the session's
// status as JSON on stdin; for Pro, Max and Ultra plans that includes rate_limits.five_hour and
// rate_limits.seven_day (used_percentage, resets_at). The tap saves only those two windows and the
// time to <data>/claude-limits.json for the meter, then either runs the person's own earlier status
// line with the same input (so theirs still shows) or prints a short IV line. It always exits 0 and
// never keeps anything else from the session. Connect copies this file into the data folder.
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : null
}

function save(dataDir, windows) {
  const file = path.join(dataDir, 'claude-limits.json')
  const temp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(temp, JSON.stringify({ observed_at: Date.now(), ...windows }))
  fs.renameSync(temp, file)
}

// Run the earlier status line the way Claude Code would: Git Bash when we're inside it, PowerShell
// on Windows otherwise, the normal shell elsewhere.
function runPrevious(command, input) {
  const opts = { input, encoding: 'utf8', timeout: 5000, windowsHide: true }
  let r
  if (process.platform !== 'win32') r = spawnSync(command, { ...opts, shell: true })
  else if (process.env.MSYSTEM || /bash/i.test(process.env.SHELL || '')) r = spawnSync('bash', ['-c', command], opts)
  else r = spawnSync('powershell', ['-NoProfile', '-Command', command], opts)
  return (r && r.stdout) || ''
}

function main(input) {
  let status
  try {
    status = JSON.parse(input)
  } catch {
    return
  }
  const dataDir = arg('--data')
  const limits = (status && status.rate_limits) || {}
  const windows = {}
  for (const key of ['five_hour', 'seven_day']) {
    const w = limits[key]
    if (w && Number.isFinite(w.used_percentage)) windows[key] = { used_percentage: w.used_percentage, resets_at: w.resets_at }
  }
  if (dataDir && Object.keys(windows).length) {
    try {
      save(dataDir, windows)
    } catch {
      // A failed save must never break Claude Code's status line.
    }
  }

  let previous = null
  try {
    previous = JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-connect.json'), 'utf8')).previous
  } catch {
    previous = null
  }
  if (previous && typeof previous.command === 'string' && previous.command.trim()) {
    process.stdout.write(runPrevious(previous.command, input))
    return
  }

  const parts = []
  if (windows.five_hour) parts.push(`5h ${Math.round(windows.five_hour.used_percentage)}%`)
  if (windows.seven_day) parts.push(`week ${Math.round(windows.seven_day.used_percentage)}%`)
  if (parts.length) process.stdout.write(`IV  ${parts.join(' · ')}\n`)
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  input += d
})
process.stdin.on('end', () => {
  try {
    main(input)
  } catch {
    // Never fail the status line.
  }
  process.exitCode = 0
})
