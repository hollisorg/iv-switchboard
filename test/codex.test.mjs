import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listCodexFiles, readCodexFile } from '../src/core/sources/codex.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = path.join(here, 'fixtures', 'codex')
const A = path.join(home, 'sessions', '2026', '11', '17', 'rollout-2026-11-17T09-00-00-aaaa.jsonl')
const B = path.join(home, 'sessions', '2026', '11', '17', 'rollout-2026-11-17T10-00-00-bbbb.jsonl')
const C = path.join(home, 'archived_sessions', '2026', '11', '16', 'rollout-2026-11-16T08-00-00-cccc.jsonl')
const D = path.join(home, 'sessions', '2026', '11', '17', 'rollout-2026-11-17T11-00-00-dddd.jsonl')

const keys = (turns) => turns.map((t) => t.turnKey)

test('lists live and archived rollout files, sorted', () => {
  assert.deepEqual(listCodexFiles(home), [C, A, B, D].sort())
  assert.deepEqual(listCodexFiles(path.join(home, 'no-such-folder')), [])
})

test('(a) one turn per response id, with the model in force and the newest allowance', () => {
  const r = readCodexFile(A, null)
  assert.deepEqual(keys(r.turns), ['resp_a1', 'resp_a2'])
  assert.deepEqual(r.turns[0], {
    source: 'codex', turnKey: 'resp_a1', sessionId: 'thread-a', model: 'gpt-6.1-sol', atMs: Date.parse('2026-11-17T09:00:10.000Z'),
    input: 1000, cachedInput: 400, cacheWrite: 0, cacheWrite1h: 0, output: 50, reasoning: 10
  })
  assert.equal(r.turns[1].model, 'gpt-6-astra')
  assert.deepEqual(r.session, { source: 'codex', sessionId: 'thread-a', label: 'iv-studio', startedMs: Date.parse('2026-11-17T09:00:00.000Z'), parentId: null })
  assert.deepEqual(r.limits, [{
    source: 'codex', window: 'seven_day', usedPercent: 42, windowMinutes: 10080, resetsAtMs: 1795165200000,
    observedMs: Date.parse('2026-11-17T09:05:20.100Z'), plan: 'pro', credits: { has_credits: true, unlimited: false, balance: '120.0000000000' }
  }])
  assert.deepEqual(r.problems, [])
  assert.equal(r.cursor.offset, fs.statSync(A).size)
})

test('(b) a sub-agent skips its copied history and other threads', () => {
  const r = readCodexFile(B, null)
  assert.deepEqual(keys(r.turns), ['resp_b1'])
  assert.deepEqual(r.limits, [])
  assert.equal(r.session.parentId, 'thread-a')
})

test('(c) older logs without usage records count token_count lines whose totals changed', () => {
  const r = readCodexFile(C, null)
  assert.deepEqual(keys(r.turns), ['tc:thread-c:2', 'tc:thread-c:4'])
  assert.deepEqual(r.turns.map((t) => [t.input, t.cachedInput, t.output, t.reasoning]), [[100, 0, 10, 0], [200, 80, 20, 4]])
  assert.equal(r.session.label, 'old-project')
})

test('(c2) a sub-agent with no history marker starts counting at its own first task', () => {
  const r = readCodexFile(D, null)
  assert.deepEqual(keys(r.turns), ['tc:thread-d:6'])
  assert.deepEqual([r.turns[0].input, r.turns[0].cachedInput, r.turns[0].output], [300, 200, 30])
})

test('(c3) a first task logged in whole seconds just before the sub-agent was created still counts', () => {
  // Real Codex logs: created at 12:00:00.426, first task_started at 12:00:00 (whole seconds).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-codex-'))
  const file = path.join(dir, 'rollout-same-second.jsonl')
  const created = '2026-11-17T12:00:00.426Z'
  const startedAt = Math.floor(Date.parse(created) / 1000)
  const usage = { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 12 }
  const lines = [
    { timestamp: created, ordinal: 0, type: 'session_meta', payload: { id: 'thread-e', parent_thread_id: 'thread-a', timestamp: created, cwd: 'C:\\work\\x' } },
    { timestamp: '2026-11-17T12:00:00.500Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', started_at: startedAt } },
    { timestamp: '2026-11-17T12:00:05.000Z', ordinal: 2, type: 'token_usage_record', payload: { thread_id: 'thread-e', response_id: 'resp_e1', usage } }
  ]
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  assert.deepEqual(keys(readCodexFile(file, null).turns), ['resp_e1'])
})

test('(d) a null reading changes nothing and readings report the latest per window', () => {
  const lines = fs.readFileSync(A, 'utf8').split('\n')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-codex-'))
  const file = path.join(dir, 'rollout-x.jsonl')
  fs.writeFileSync(file, [lines[0], lines[4], lines[9], ''].join('\n'))
  const r = readCodexFile(file, null)
  assert.equal(r.limits.length, 1)
  assert.equal(r.limits[0].usedPercent, 40)
})

test('(e) a half-written last line waits for the next read, and nothing is read twice', () => {
  const text = fs.readFileSync(A, 'utf8')
  const lines = text.split('\n')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-codex-'))
  const file = path.join(dir, 'rollout-growing.jsonl')
  const firstPart = lines.slice(0, 7).join('\n') + '\n' + lines[7].slice(0, 40)
  fs.writeFileSync(file, firstPart)

  const one = readCodexFile(file, null)
  assert.deepEqual(keys(one.turns), ['resp_a1'])
  assert.equal(one.cursor.offset, Buffer.byteLength(lines.slice(0, 7).join('\n') + '\n'))
  assert.equal(one.session.sessionId, 'thread-a')

  fs.writeFileSync(file, text)
  const two = readCodexFile(file, one.cursor)
  assert.deepEqual(keys(two.turns), ['resp_a2'])
  assert.equal(two.turns[0].model, 'gpt-6-astra', 'the model from before the cut is remembered')
  assert.equal(two.session, null, 'the session was already reported')
  assert.equal(two.limits[0].usedPercent, 42)

  const three = readCodexFile(file, two.cursor)
  assert.deepEqual(three.turns, [])
  assert.deepEqual(three.limits, [])
  assert.equal(three.cursor.offset, Buffer.byteLength(text))
})

test('a damaged line is reported by offset and the rest is still read', () => {
  const lines = fs.readFileSync(A, 'utf8').split('\n')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-codex-'))
  const file = path.join(dir, 'rollout-damaged.jsonl')
  const broken = '{"type":"token_usage_record", "oops'
  fs.writeFileSync(file, [lines[0], lines[1], broken, lines[3], ''].join('\n'))
  const r = readCodexFile(file, null)
  assert.deepEqual(keys(r.turns), ['resp_a1'])
  assert.equal(r.problems.length, 1)
  assert.equal(r.problems[0].offset, Buffer.byteLength(lines[0] + '\n' + lines[1] + '\n'))
  assert.ok(!JSON.stringify(r.problems).includes('oops'), 'problems never carry line content')
})

test('tiny read chunks give exactly the same result', () => {
  for (const f of [A, B, C, D]) {
    const whole = readCodexFile(f, null)
    const tiny = readCodexFile(f, null, { chunkBytes: 7 })
    assert.deepEqual(tiny, whole, path.basename(f))
  }
})

test('Windows line endings are read the same', () => {
  const text = fs.readFileSync(A, 'utf8').replace(/\n/g, '\r\n')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-codex-'))
  const file = path.join(dir, 'rollout-crlf.jsonl')
  fs.writeFileSync(file, text)
  const r = readCodexFile(file, null)
  assert.deepEqual(keys(r.turns), ['resp_a1', 'resp_a2'])
  assert.deepEqual(r.problems, [])
})

test('a file that shrank is read again from the start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-codex-'))
  const file = path.join(dir, 'rollout-replaced.jsonl')
  fs.copyFileSync(A, file)
  const first = readCodexFile(file, null)
  fs.copyFileSync(C, file)
  const again = readCodexFile(file, first.cursor)
  assert.deepEqual(keys(again.turns), ['tc:thread-c:2', 'tc:thread-c:4'])
})
