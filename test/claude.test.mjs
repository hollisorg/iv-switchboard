import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listClaudeFiles, readClaudeFile, readClaudeLimits } from '../src/core/sources/claude.js'
import { openStore } from '../src/core/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = path.join(here, 'fixtures', 'claude')
const proj = path.join(home, 'projects', 'C--work-iv-studio')
const S1 = path.join(proj, 'sess-1.jsonl')
const S2 = path.join(proj, 'sess-2.jsonl')
const SUB = path.join(proj, 'sess-1', 'subagents', 'agent-a1.jsonl')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-claude-'))

test('lists session transcripts and sub-agent transcripts only', () => {
  assert.deepEqual(listClaudeFiles(home), [S1, SUB, S2].sort())
  assert.deepEqual(listClaudeFiles(path.join(home, 'missing')), [])
})

test('one turn per reply, keeping the largest counts from its repeated lines', () => {
  const r = readClaudeFile(S1, null)
  assert.deepEqual(r.turns.map((t) => t.turnKey), ['msg_1|req_1', 'msg_2|req_2', 'msg_4|'])
  assert.deepEqual(r.turns[0], {
    source: 'claude', turnKey: 'msg_1|req_1', sessionId: 'sess-1', model: 'claude-opus-5-5', atMs: Date.parse('2026-11-17T09:00:05.000Z'),
    input: 2, cachedInput: 0, cacheWrite: 500, cacheWrite1h: 500, output: 210, reasoning: 12
  })
  assert.deepEqual([r.turns[1].input, r.turns[1].cachedInput, r.turns[1].output], [4, 1200, 40])
  assert.deepEqual(r.session, { source: 'claude', sessionId: 'sess-1', label: 'iv-studio', startedMs: Date.parse('2026-11-17T09:00:05.000Z'), parentId: null })
  assert.deepEqual(r.problems, [])
})

test('a synthetic line with no tokens is not a reply', () => {
  assert.ok(!readClaudeFile(S1, null).turns.some((t) => t.turnKey.startsWith('msg_3')))
})

test('a sub-agent reply belongs to its parent session and reports no session of its own', () => {
  const r = readClaudeFile(SUB, null)
  assert.deepEqual(r.turns.map((t) => [t.turnKey, t.sessionId]), [['msg_s1|req_s1', 'sess-1']])
  assert.equal(r.session, null)
})

test('a reply copied into a resumed session is stored once', () => {
  const store = openStore(tmp())
  for (const f of [S1, S2, SUB]) store.addTurns(readClaudeFile(f, null).turns)
  const keys = store.turnsSince(0).map((t) => t.turnKey).sort()
  store.close()
  assert.deepEqual(keys, ['msg_1|req_1', 'msg_2|req_2', 'msg_4|', 'msg_5|req_5', 'msg_s1|req_s1'])
})

test('a reply split across two reads ends with its final count', () => {
  const lines = fs.readFileSync(S1, 'utf8').split('\n')
  const dir = tmp()
  const file = path.join(dir, 'growing.jsonl')
  fs.writeFileSync(file, lines.slice(0, 2).join('\n') + '\n')
  const store = openStore(dir)
  const one = readClaudeFile(file, null)
  store.addTurns(one.turns)
  assert.equal(one.turns[0].output, 3)
  fs.writeFileSync(file, lines.join('\n'))
  const two = readClaudeFile(file, one.cursor)
  assert.equal(two.session, null, 'the session was already reported')
  store.addTurns(two.turns)
  const msg1 = store.turnsSince(0).find((t) => t.turnKey === 'msg_1|req_1')
  store.close()
  assert.equal(msg1.output, 210)
})

test('tiny read chunks give exactly the same result', () => {
  for (const f of [S1, S2, SUB]) assert.deepEqual(readClaudeFile(f, null, { chunkBytes: 5 }), readClaudeFile(f, null))
})

test('a damaged usage line is reported by offset without its content', () => {
  const lines = fs.readFileSync(S1, 'utf8').split('\n')
  const dir = tmp()
  const file = path.join(dir, 'damaged.jsonl')
  fs.writeFileSync(file, [lines[0], '{"usage": secret', lines[5], ''].join('\n'))
  const r = readClaudeFile(file, null)
  assert.deepEqual(r.turns.map((t) => t.turnKey), ['msg_2|req_2'])
  assert.deepEqual(r.problems, [{ offset: Buffer.byteLength(lines[0] + '\n'), message: 'This line is not valid JSON.' }])
})

test('the status line file becomes five-hour and weekly readings', () => {
  const dir = tmp()
  assert.deepEqual(readClaudeLimits(dir), [])
  const observed = Date.parse('2026-11-17T09:00:00.000Z')
  fs.writeFileSync(path.join(dir, 'claude-limits.json'), JSON.stringify({
    observed_at: observed,
    five_hour: { used_percentage: 23.5, resets_at: 1794920000 },
    seven_day: { used_percentage: 41.2, resets_at: 1795165200 }
  }))
  assert.deepEqual(readClaudeLimits(dir), [
    { source: 'claude', window: 'five_hour', usedPercent: 23.5, windowMinutes: 300, resetsAtMs: 1794920000000, observedMs: observed, plan: null, credits: null },
    { source: 'claude', window: 'seven_day', usedPercent: 41.2, windowMinutes: 10080, resetsAtMs: 1795165200000, observedMs: observed, plan: null, credits: null }
  ])
})

test('a missing window or a damaged status line file gives what it can', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'claude-limits.json'), JSON.stringify({ observed_at: 5, seven_day: { used_percentage: 10, resets_at: 100 } }))
  assert.deepEqual(readClaudeLimits(dir).map((l) => l.window), ['seven_day'])
  fs.writeFileSync(path.join(dir, 'claude-limits.json'), '{not json')
  assert.deepEqual(readClaudeLimits(dir), [])
})
