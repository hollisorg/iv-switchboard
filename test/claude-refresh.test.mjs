import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findClaude, parseLimits, refreshClaude, REFRESH_ARGS } from '../src/core/claude-refresh.js'
import { readClaudeLimits } from '../src/core/sources/claude.js'

// The shape Claude Code 2.1.327 printed for a real Max account on 2026-11-19 (ids made up).
const EVENT = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1795114200,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1795114200, status: 'allowed' }, seven_day: { utilization: 0.463, resetsAt: 1795370400, status: 'allowed' } }
  },
  uuid: 'u',
  session_id: 's'
}
const OUTPUT = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } }),
  JSON.stringify(EVENT),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' })
].join('\n')

test('the rate_limit_event gives both windows in the status line tap format', () => {
  assert.deepEqual(parseLimits(OUTPUT), {
    five_hour: { used_percentage: 8, resets_at: 1795114200 },
    seven_day: { used_percentage: 46.3, resets_at: 1795370400 }
  })
})

test('an event without unifiedWindows still gives the window it names; no event gives null', () => {
  const only = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 100 } }
  assert.deepEqual(parseLimits(JSON.stringify(only)), { seven_day: { used_percentage: 50, resets_at: 100 } })
  assert.equal(parseLimits('{"type":"result","result":"OK"}\nnot json'), null)
  assert.equal(parseLimits(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })), null)
})

test('Claude Code is found in ~/.local/bin first, then on the PATH; an override must exist', () => {
  const home = 'C:\\Users\\demo'
  const local = path.join(home, '.local', 'bin', 'claude.exe')
  const onPath = path.join('D:\\tools', 'claude.cmd')
  const has = (...files) => (f) => files.includes(f)
  const env = { PATH: ['D:\\tools', 'E:\\other'].join(path.delimiter) }
  assert.equal(findClaude({ env, home, platform: 'win32', exists: has(local, onPath) }), local)
  assert.equal(findClaude({ env, home, platform: 'win32', exists: has(onPath) }), onPath)
  assert.equal(findClaude({ env, home, platform: 'win32', exists: has() }), null)
  assert.equal(findClaude({ env: { IV_SWITCHBOARD_CLAUDE_BIN: 'X:\\fake.cmd' }, home, platform: 'win32', exists: has(local) }), null)
  assert.equal(findClaude({ env: { IV_SWITCHBOARD_CLAUDE_BIN: 'X:\\fake.cmd' }, home, platform: 'win32', exists: has('X:\\fake.cmd') }), 'X:\\fake.cmd')
})

function fakeSpawn({ stdout = '', stderr = '', code = 0, hang = false, calls = [] } = {}) {
  return (file, args, opts) => {
    calls.push({ file, args, opts })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => setImmediate(() => child.emit('close', null))
    if (!hang) {
      setImmediate(() => {
        child.stdout.end(stdout)
        child.stderr.end(stderr)
        setImmediate(() => child.emit('close', code))
      })
    }
    return child
  }
}

const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-refresh-'))

test('Refresh runs one short Haiku turn with no saved session and saves only the windows', async () => {
  const dir = dataDir()
  const calls = []
  const r = await refreshClaude({ dataDir: dir, bin: 'C:\\x\\claude.exe', spawnImpl: fakeSpawn({ stdout: OUTPUT, calls }), now: () => 1795098000000, env: { CLAUDECODE: '1', KEEP: 'yes' } })
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0].args, REFRESH_ARGS)
  for (const flag of ['--no-session-persistence', 'haiku', 'stream-json']) assert.ok(calls[0].args.includes(flag), flag)
  assert.equal(calls[0].opts.windowsHide, true)
  assert.equal(calls[0].opts.env.CLAUDECODE, undefined, 'not marked as running inside Claude Code')
  assert.equal(calls[0].opts.env.KEEP, 'yes')
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'claude-limits.json'), 'utf8'))
  assert.deepEqual(Object.keys(saved).sort(), ['five_hour', 'observed_at', 'seven_day'], 'nothing from the reply is kept')
  const limits = readClaudeLimits(dir)
  assert.deepEqual(limits.map((l) => [l.window, l.usedPercent, l.resetsAtMs, l.observedMs]), [
    ['five_hour', 8, 1795114200000, 1795098000000],
    ['seven_day', 46.3, 1795370400000, 1795098000000]
  ])
})

test('a .cmd shim runs through cmd.exe with the fixed arguments quoted', async () => {
  const calls = []
  await refreshClaude({ dataDir: dataDir(), bin: 'D:\\npm dir\\claude.cmd', spawnImpl: fakeSpawn({ stdout: OUTPUT, calls }), env: {} })
  const c = calls[0]
  assert.match(c.file, /cmd\.exe$/i)
  assert.equal(c.opts.windowsVerbatimArguments, true)
  assert.deepEqual(c.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(c.args[3], `""D:\\npm dir\\claude.cmd" -p "Reply with the single word OK." --model haiku --output-format stream-json --verbose --no-session-persistence --max-turns 1"`)
})

test('no reading leaves the old one alone and says why', async () => {
  const dir = dataDir()
  fs.writeFileSync(path.join(dir, 'claude-limits.json'), '{"observed_at":1,"seven_day":{"used_percentage":25,"resets_at":2}}')
  const apiKey = await refreshClaude({ dataDir: dir, bin: 'claude.exe', spawnImpl: fakeSpawn({ stdout: '{"type":"result","result":"OK"}' }), env: {} })
  assert.equal(apiKey.ok, false)
  assert.match(apiKey.message, /Pro, Max or Ultra/)
  const signedOut = await refreshClaude({ dataDir: dir, bin: 'claude.exe', spawnImpl: fakeSpawn({ code: 1, stderr: '\nInvalid API key · Please run /login\nmore' }), env: {} })
  assert.match(signedOut.message, /Invalid API key · Please run \/login/)
  const missing = await refreshClaude({ dataDir: dir, bin: null })
  assert.match(missing.message, /wasn't found/)
  const slow = await refreshClaude({ dataDir: dir, bin: 'claude.exe', spawnImpl: fakeSpawn({ hang: true }), timeoutMs: 20, env: {} })
  assert.match(slow.message, /90 seconds/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'claude-limits.json'), 'utf8')).seven_day.used_percentage, 25)
})
