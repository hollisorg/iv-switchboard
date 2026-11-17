// Connect Claude: points Claude Code's status line at IV Switchboard's tap so the meter can see the
// five-hour and weekly allowance. Only the "statusLine" key in ~/.claude/settings.json changes, the
// rest of the file keeps its exact bytes, a backup is made next to it first, and Disconnect puts the
// file back byte for byte. settings.json can hold keys in "env", so its text is never copied into
// IV Switchboard's own folder: the record keeps fingerprints, and the restore comes from the backup.
// The JSON scanning follows IV Chat's connectors.js.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const RECORD = 'claude-connect.json'
const SCRIPT = 'statusline.cjs'
const KEY = 'statusLine'

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
const slash = (p) => p.replace(/\\/g, '/')

// Claude Code runs the command through Git Bash, or PowerShell when Git Bash is absent. A bare first
// word with quoted forward-slash paths after it runs the same in both.
export function statusLineCommand({ scriptPath, dataDir }) {
  return `node "${slash(scriptPath)}" --data "${slash(dataDir)}"`
}

function scanValueEnd(text, i) {
  const open = text[i]
  if (open === '"') {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++
      else if (text[j] === '"') return j + 1
    }
    throw new Error('unterminated string')
  }
  if (open === '{' || open === '[') {
    let depth = 0
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (c === '"') j = scanValueEnd(text, j) - 1
      else if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') {
        depth--
        if (depth === 0) return j + 1
      }
    }
    throw new Error('unbalanced')
  }
  const m = /^[^,}\]\s]+/.exec(text.slice(i))
  return i + (m ? m[0].length : 0)
}

function objectEntries(text, start) {
  const entries = []
  let i = start + 1
  const skip = () => {
    while (/\s/.test(text[i] || '')) i++
  }
  skip()
  if (text[i] === '}') return entries
  for (;;) {
    skip()
    const keyEnd = scanValueEnd(text, i)
    const key = JSON.parse(text.slice(i, keyEnd))
    i = keyEnd
    skip()
    i++ // the colon
    skip()
    const valueStart = i
    i = scanValueEnd(text, i)
    entries.push({ key, valueStart, valueEnd: i })
    skip()
    if (text[i] === ',') i++
    else break
  }
  return entries
}

const stripBom = (text) => text.replace(/^﻿/, '')

function parseSettings(text) {
  try {
    const value = JSON.parse(stripBom(text))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw new Error("Your Claude settings.json isn't valid JSON, so IV Switchboard left it alone.")
  }
}

const paths = (claudeHome, dataDir) => ({
  settings: path.join(claudeHome, 'settings.json'),
  record: path.join(dataDir, RECORD),
  script: path.join(dataDir, SCRIPT)
})

function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function claudeConnection({ claudeHome, dataDir }) {
  const p = paths(claudeHome, dataDir)
  const record = readRecord(p.record)
  if (!record || !fs.existsSync(p.settings)) return { connected: false }
  try {
    return { connected: parseSettings(fs.readFileSync(p.settings, 'utf8'))[KEY]?.command === record.command }
  } catch {
    return { connected: false }
  }
}

export function connectClaude({ claudeHome, dataDir, scriptSource, now = new Date() }) {
  const p = paths(claudeHome, dataDir)
  const command = statusLineCommand({ scriptPath: p.script, dataDir })
  const ours = JSON.stringify({ type: 'command', command })
  const exists = fs.existsSync(p.settings)
  const text = exists ? fs.readFileSync(p.settings, 'utf8') : ''
  const blank = !text.trim()
  if (!blank) {
    const current = parseSettings(text)
    if (current[KEY]?.command === command && readRecord(p.record)) return { already: true, command }
  }

  let next
  let mode
  let inserted = null
  let originalValue = null
  let previous = null
  if (blank) {
    mode = exists ? 'filled' : 'created'
    next = `{\n  "${KEY}": ${ours}\n}\n`
  } else {
    const top = text.indexOf('{')
    const entries = objectEntries(text, top)
    const existing = entries.find((e) => e.key === KEY)
    if (existing) {
      mode = 'replaced'
      originalValue = text.slice(existing.valueStart, existing.valueEnd)
      previous = JSON.parse(originalValue)
      next = text.slice(0, existing.valueStart) + ours + text.slice(existing.valueEnd)
    } else {
      mode = 'inserted'
      inserted = entries.length ? `\n  "${KEY}": ${ours},` : `\n  "${KEY}": ${ours}\n`
      next = text.slice(0, top + 1) + inserted + text.slice(top + 1)
    }
  }
  if (parseSettings(next)[KEY]?.command !== command) throw new Error('IV Switchboard could not add its status line safely, so it left settings.json alone.')

  fs.mkdirSync(dataDir, { recursive: true })
  fs.copyFileSync(scriptSource, p.script)
  let backup = null
  if (exists) {
    backup = `${p.settings}.ivsb-backup-${now.toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(p.settings, backup)
  }
  fs.writeFileSync(p.record, JSON.stringify({
    mode, command, ours, inserted, originalValue, previous, backup,
    originalSha: exists ? sha(text) : null,
    connectedSha: sha(next),
    at: now.toISOString()
  }, null, 2))
  fs.writeFileSync(p.settings, next)
  return { mode, backup, command }
}

const CHANGED = 'Your Claude status line was changed after it was connected, so IV Switchboard left settings.json alone. Remove "statusLine" by hand if you no longer want it.'

export function disconnectClaude({ claudeHome, dataDir }) {
  const p = paths(claudeHome, dataDir)
  const record = readRecord(p.record)
  if (!record) return { notConnected: true }
  const exists = fs.existsSync(p.settings)
  const current = exists ? fs.readFileSync(p.settings, 'utf8') : ''

  let restored
  if (exists && sha(current) === record.connectedSha) {
    // Nothing else changed since Connect: put back the exact original.
    if (record.mode === 'created') {
      fs.rmSync(p.settings)
      restored = 'removed'
    } else {
      const original = record.backup && fs.existsSync(record.backup) ? fs.readFileSync(record.backup, 'utf8') : null
      if (original === null || sha(original) !== record.originalSha) throw new Error('The settings.json backup is missing or changed, so IV Switchboard left settings.json alone.')
      fs.writeFileSync(p.settings, original)
      restored = 'exact'
    }
  } else {
    // Other settings changed meanwhile: undo only IV Switchboard's own change, if it's still there.
    if (!exists) throw new Error(CHANGED)
    let next
    if (record.mode === 'inserted' && current.includes(record.inserted)) {
      next = current.replace(record.inserted, '')
    } else if (record.mode === 'replaced') {
      const top = current.indexOf('{')
      const entry = objectEntries(current, top).find((e) => e.key === KEY)
      if (!entry || current.slice(entry.valueStart, entry.valueEnd) !== record.ours) throw new Error(CHANGED)
      next = current.slice(0, entry.valueStart) + record.originalValue + current.slice(entry.valueEnd)
    } else {
      throw new Error(CHANGED)
    }
    parseSettings(next)
    fs.writeFileSync(p.settings, next)
    restored = 'own-change-only'
  }
  fs.rmSync(p.record, { force: true })
  fs.rmSync(p.script, { force: true })
  return { restored }
}
