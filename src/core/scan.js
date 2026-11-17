// One scan pass: read what changed in each source since the last pass, store it, and build the
// snapshot. A file whose size and modified time are unchanged is skipped; a changed file is read
// from where the last pass stopped. Problems carry the file and byte offset, never line content.
import fs from 'node:fs'
import path from 'node:path'
import { listCodexFiles, readCodexFile } from './sources/codex.js'
import { listClaudeFiles, readClaudeFile, readClaudeLimits } from './sources/claude.js'
import { readHermes } from './sources/hermes.js'
import { buildSnapshot } from './snapshot.js'

const READERS = [
  { source: 'codex', list: (p) => listCodexFiles(p.codexHome), read: readCodexFile, hasLimits: true },
  { source: 'claude', list: (p) => listClaudeFiles(p.claudeHome), read: readClaudeFile, hasLimits: false }
]

export function scanOnce({ paths, store, now = Date.now() }) {
  const problems = []
  let filesRead = 0

  for (const reader of READERS) {
    for (const file of reader.list(paths)) {
      let stat
      try {
        stat = fs.statSync(file)
      } catch {
        continue // removed between listing and reading
      }
      const known = store.getFile(file)
      if (known && known.size === stat.size && known.mtimeMs === Math.trunc(stat.mtimeMs)) continue
      const cursor = known ? { ...(known.state || {}), offset: known.offset } : null
      let r
      try {
        r = reader.read(file, cursor)
      } catch (e) {
        problems.push({ source: reader.source, file, offset: null, message: `This file couldn't be read (${e.code || 'error'}).` })
        continue
      }
      filesRead++
      store.addTurns(r.turns)
      if (r.session) store.upsertSession(r.session)
      if (reader.hasLimits) for (const l of r.limits) store.setLimit(l)
      for (const pr of r.problems) problems.push({ source: reader.source, file, offset: pr.offset, message: pr.message })
      const { offset, ...state } = r.cursor
      store.setFile({ path: file, source: reader.source, size: stat.size, mtimeMs: stat.mtimeMs, offset, state })
    }
  }

  for (const l of readClaudeLimits(paths.dataDir)) store.setLimit(l)

  const hermes = readHermes(paths.hermesHome, path.join(paths.dataDir, 'tmp'))
  if (hermes.found && !hermes.problems.some((p) => /couldn't be read/.test(p.message))) {
    store.replaceHermesUsage(hermes.rows)
    for (const s of hermes.sessions) store.upsertSession(s)
  }
  for (const pr of hermes.problems) problems.push({ source: 'hermes', file: path.join(paths.hermesHome, 'state.db'), offset: null, message: pr.message })

  return { snapshot: buildSnapshot(store, now), filesRead, problems, found: { hermes: hermes.found } }
}
