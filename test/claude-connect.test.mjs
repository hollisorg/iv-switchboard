import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeConnection, connectClaude, disconnectClaude, statusLineCommand } from '../src/core/claude-connect.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const scriptSource = path.join(here, '..', 'resources', 'statusline.cjs')

function setup(settingsText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsb-connect-'))
  const claudeHome = path.join(root, 'claude home')
  const dataDir = path.join(root, 'IV Switchboard')
  fs.mkdirSync(claudeHome)
  const settings = path.join(claudeHome, 'settings.json')
  if (settingsText !== null) fs.writeFileSync(settings, settingsText)
  return { claudeHome, dataDir, settings }
}

const ORIGINAL = '{\n  "model": "opus",\n  "env": {\n    "FOO": "1"\n  },\n  "permissions": { "allow": ["Bash(ls:*)"] }\n}\n'

test('the command starts with a bare node and uses quoted forward-slash paths (Git Bash and PowerShell both run it)', () => {
  assert.equal(
    statusLineCommand({ scriptPath: 'C:\\Users\\A B\\AppData\\Roaming\\IV Switchboard\\statusline.cjs', dataDir: 'C:\\Users\\A B\\AppData\\Roaming\\IV Switchboard' }),
    'node "C:/Users/A B/AppData/Roaming/IV Switchboard/statusline.cjs" --data "C:/Users/A B/AppData/Roaming/IV Switchboard"'
  )
})

test('Connect adds only the statusLine key, backs up first, and Disconnect restores the file byte for byte', () => {
  const { claudeHome, dataDir, settings } = setup(ORIGINAL)
  const result = connectClaude({ claudeHome, dataDir, scriptSource })
  assert.equal(result.mode, 'inserted')
  const text = fs.readFileSync(settings, 'utf8')
  const parsed = JSON.parse(text)
  assert.deepEqual(parsed.statusLine, { type: 'command', command: statusLineCommand({ scriptPath: path.join(dataDir, 'statusline.cjs'), dataDir }) })
  assert.deepEqual({ ...parsed, statusLine: undefined }, { ...JSON.parse(ORIGINAL), statusLine: undefined })
  assert.ok(text.includes('"permissions": { "allow": ["Bash(ls:*)"] }'), 'the rest keeps its own formatting')
  assert.equal(fs.readFileSync(result.backup, 'utf8'), ORIGINAL)
  assert.equal(fs.readFileSync(path.join(dataDir, 'statusline.cjs'), 'utf8'), fs.readFileSync(scriptSource, 'utf8'))
  assert.deepEqual(claudeConnection({ claudeHome, dataDir }), { connected: true })

  disconnectClaude({ claudeHome, dataDir })
  assert.equal(fs.readFileSync(settings, 'utf8'), ORIGINAL)
  assert.deepEqual(claudeConnection({ claudeHome, dataDir }), { connected: false })
  assert.ok(!fs.existsSync(path.join(dataDir, 'claude-connect.json')))
})

test('an existing status line is kept for the tap to run, and comes back on Disconnect', () => {
  const mine = '{\n  "statusLine": {"type": "command", "command": "~/.claude/statusline.sh", "padding": 1},\n  "model": "opus"\n}\n'
  const { claudeHome, dataDir, settings } = setup(mine)
  const result = connectClaude({ claudeHome, dataDir, scriptSource })
  assert.equal(result.mode, 'replaced')
  assert.ok(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command.startsWith('node "'))
  const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-connect.json'), 'utf8'))
  assert.deepEqual(record.previous, { type: 'command', command: '~/.claude/statusline.sh', padding: 1 })
  disconnectClaude({ claudeHome, dataDir })
  assert.equal(fs.readFileSync(settings, 'utf8'), mine)
})

test('with no settings file, Connect creates one and Disconnect removes it again', () => {
  const { claudeHome, dataDir, settings } = setup(null)
  const result = connectClaude({ claudeHome, dataDir, scriptSource })
  assert.equal(result.mode, 'created')
  assert.equal(result.backup, null)
  assert.ok(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine)
  disconnectClaude({ claudeHome, dataDir })
  assert.ok(!fs.existsSync(settings))
})

test('an empty object and a file with a byte order mark both work', () => {
  for (const text of ['{}\n', '\ufeff{\n  "model": "opus"\n}\n']) {
    const { claudeHome, dataDir, settings } = setup(text)
    connectClaude({ claudeHome, dataDir, scriptSource })
    assert.ok(JSON.parse(fs.readFileSync(settings, 'utf8').replace(/^\ufeff/, '')).statusLine)
    disconnectClaude({ claudeHome, dataDir })
    assert.equal(fs.readFileSync(settings, 'utf8'), text)
  }
})

test('settings that are not valid JSON are left alone, with no backup', () => {
  const broken = '{ "model": "opus", }'
  const { claudeHome, dataDir, settings } = setup(broken)
  assert.throws(() => connectClaude({ claudeHome, dataDir, scriptSource }), /isn't valid JSON/)
  assert.equal(fs.readFileSync(settings, 'utf8'), broken)
  assert.deepEqual(fs.readdirSync(claudeHome), ['settings.json'])
})

test('connecting twice changes nothing the second time', () => {
  const { claudeHome, dataDir, settings } = setup(ORIGINAL)
  connectClaude({ claudeHome, dataDir, scriptSource })
  const after = fs.readFileSync(settings, 'utf8')
  const backups = fs.readdirSync(claudeHome).length
  assert.equal(connectClaude({ claudeHome, dataDir, scriptSource }).already, true)
  assert.equal(fs.readFileSync(settings, 'utf8'), after)
  assert.equal(fs.readdirSync(claudeHome).length, backups)
})

test('if the person changed the status line after connecting, Disconnect leaves it alone and says so', () => {
  const { claudeHome, dataDir, settings } = setup(ORIGINAL)
  connectClaude({ claudeHome, dataDir, scriptSource })
  const connected = fs.readFileSync(settings, 'utf8')
  const edited = connected.replace(/"statusLine": \{[^\n]*\}/, '"statusLine": {"type":"command","command":"my own thing"}')
  assert.notEqual(edited, connected, 'the test really changed the status line')
  fs.writeFileSync(settings, edited)
  assert.throws(() => disconnectClaude({ claudeHome, dataDir }), /changed after it was connected/)
  assert.equal(fs.readFileSync(settings, 'utf8'), edited)
})

test('other edits made while connected are kept on Disconnect', () => {
  const { claudeHome, dataDir, settings } = setup(ORIGINAL)
  connectClaude({ claudeHome, dataDir, scriptSource })
  fs.writeFileSync(settings, fs.readFileSync(settings, 'utf8').replace('"model": "opus"', '"model": "sonnet"'))
  disconnectClaude({ claudeHome, dataDir })
  assert.equal(fs.readFileSync(settings, 'utf8'), ORIGINAL.replace('"model": "opus"', '"model": "sonnet"'))
})
