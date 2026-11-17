import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tap = path.join(here, '..', 'resources', 'statusline.cjs')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-tap-'))

const sample = (rateLimits) => JSON.stringify({
  session_id: 'made-up', model: { id: 'claude-opus-5-5', display_name: 'Opus' }, cwd: 'C:/work/x',
  ...(rateLimits ? { rate_limits: rateLimits } : {})
})

function run(dataDir, input) {
  return spawnSync(process.execPath, [tap, '--data', dataDir], { input, encoding: 'utf8', timeout: 10000 })
}

test('saves both windows and prints a short line', () => {
  const dir = tmp()
  const before = Date.now()
  const r = run(dir, sample({ five_hour: { used_percentage: 23.5, resets_at: 1794920000 }, seven_day: { used_percentage: 41.2, resets_at: 1795165200 } }))
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim(), 'IV  5h 24% \u00b7 week 41%')
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'claude-limits.json'), 'utf8'))
  assert.deepEqual(saved.five_hour, { used_percentage: 23.5, resets_at: 1794920000 })
  assert.deepEqual(saved.seven_day, { used_percentage: 41.2, resets_at: 1795165200 })
  assert.ok(saved.observed_at >= before && saved.observed_at <= Date.now())
  assert.deepEqual(Object.keys(saved).sort(), ['five_hour', 'observed_at', 'seven_day'], 'nothing else from the session is kept')
  assert.deepEqual(fs.readdirSync(dir), ['claude-limits.json'], 'no temp file is left behind')
})

test('one window alone is saved and shown', () => {
  const dir = tmp()
  const r = run(dir, sample({ seven_day: { used_percentage: 7, resets_at: 1795165200 } }))
  assert.equal(r.stdout.trim(), 'IV  week 7%')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'claude-limits.json'), 'utf8')).five_hour, undefined)
})

test('no rate limits: nothing saved, nothing printed, exit 0', () => {
  const dir = tmp()
  const r = run(dir, sample(null))
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('unreadable input: nothing saved, nothing printed, exit 0', () => {
  const dir = tmp()
  const r = run(dir, '{not json')
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('a status line the person already had still runs with the same input, and its output is shown', () => {
  const dir = tmp()
  const previousScript = path.join(dir, 'prev.cjs')
  fs.writeFileSync(previousScript, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('mine: '+JSON.parse(s).model.display_name))")
  const command = `node "${previousScript.replace(/\\/g, '/')}"`
  fs.writeFileSync(path.join(dir, 'claude-connect.json'), JSON.stringify({ previous: { type: 'command', command } }))
  const r = run(dir, sample({ seven_day: { used_percentage: 7, resets_at: 1795165200 } }))
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim(), 'mine: Opus')
  assert.ok(fs.existsSync(path.join(dir, 'claude-limits.json')), 'the reading is still saved')
})
