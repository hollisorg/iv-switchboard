import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from '../src/core/store.js'
import { scanOnce } from '../src/core/scan.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')
const NOW = new Date(2026, 10, 17, 23, 0, 0).getTime()

function setup({ copyHomes = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-scan-'))
  const p = {
    dataDir: path.join(root, 'data'),
    codexHome: path.join(fixtures, 'codex'),
    claudeHome: path.join(fixtures, 'claude'),
    hermesHome: path.join(root, 'no-hermes')
  }
  if (copyHomes) {
    for (const k of ['codexHome', 'claudeHome']) {
      const to = path.join(root, k)
      fs.cpSync(p[k], to, { recursive: true })
      p[k] = to
    }
  }
  fs.mkdirSync(p.dataDir, { recursive: true })
  return { p, store: openStore(p.dataDir) }
}

const month = (snap, id) => snap.periods.month.byEngine.find((e) => e.id === id)

test('the first pass reads every file; an unchanged second pass reads none and gives the same totals', () => {
  const { p, store } = setup()
  const first = scanOnce({ paths: p, store, now: NOW })
  assert.equal(first.filesRead, 7) // 4 Codex + 3 Claude
  assert.deepEqual(first.problems, [])
  assert.equal(first.snapshot.engines.find((e) => e.id === 'codex').windows[0].usedPercent, 42)
  const second = scanOnce({ paths: p, store, now: NOW })
  assert.equal(second.filesRead, 0)
  assert.deepEqual(month(second.snapshot, 'codex'), month(first.snapshot, 'codex'))
  assert.deepEqual(month(second.snapshot, 'claude'), month(first.snapshot, 'claude'))
  store.close()
})

test('only a file that grew is read again, from where the last pass stopped', () => {
  const { p, store } = setup({ copyHomes: true })
  scanOnce({ paths: p, store, now: NOW })
  const before = month(scanOnce({ paths: p, store, now: NOW }).snapshot, 'claude').tokens
  const file = path.join(p.claudeHome, 'projects', 'C--work-iv-studio', 'sess-2.jsonl')
  const extra = {
    type: 'assistant', sessionId: 'sess-2', timestamp: '2026-11-17T10:30:00.000Z', requestId: 'req_9', cwd: 'C:\\work\\iv-studio',
    message: { id: 'msg_9', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } }
  }
  fs.appendFileSync(file, JSON.stringify(extra) + '\n')
  const after = scanOnce({ paths: p, store, now: NOW })
  assert.equal(after.filesRead, 1)
  assert.equal(month(after.snapshot, 'claude').tokens, before + 15)
  store.close()
})

test("the status line tap's file gives Claude its allowance", () => {
  const { p, store } = setup()
  fs.writeFileSync(path.join(p.dataDir, 'claude-limits.json'), JSON.stringify({ observed_at: NOW - 60000, seven_day: { used_percentage: 41.2, resets_at: Math.round((NOW + 86400000) / 1000) } }))
  const snap = scanOnce({ paths: p, store, now: NOW }).snapshot
  store.close()
  assert.deepEqual(snap.engines.find((e) => e.id === 'claude').windows.map((w) => [w.label, w.usedPercent]), [['Week', 41.2]])
})

test('a damaged line is reported with its file and offset, never its content', () => {
  const { p, store } = setup({ copyHomes: true })
  const file = path.join(p.claudeHome, 'projects', 'C--work-iv-studio', 'sess-2.jsonl')
  const size = fs.statSync(file).size
  fs.appendFileSync(file, '{"usage": private words\n')
  const r = scanOnce({ paths: p, store, now: NOW })
  store.close()
  assert.deepEqual(r.problems, [{ source: 'claude', file, offset: size, message: 'This line is not valid JSON.' }])
  assert.ok(!JSON.stringify(r.problems).includes('private'))
})

test('missing folders give an empty meter, not an error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-scan-'))
  const p = { dataDir: path.join(root, 'data'), codexHome: path.join(root, 'x'), claudeHome: path.join(root, 'y'), hermesHome: path.join(root, 'z') }
  const store = openStore(p.dataDir)
  const r = scanOnce({ paths: p, store, now: NOW })
  store.close()
  assert.equal(r.filesRead, 0)
  assert.deepEqual(r.snapshot.engines.map((e) => e.windows.length), [0, 0, 0])
  assert.equal(r.found.hermes, false)
})
