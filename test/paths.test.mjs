import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { paths } from '../src/core/paths.js'

const home = path.join('C:', 'Users', 'Someone')
const appData = path.join(home, 'AppData', 'Roaming')
const localAppData = path.join(home, 'AppData', 'Local')

test('defaults point at the usual Windows folders', () => {
  const p = paths({ env: {}, home, appData, localAppData })
  assert.deepEqual(p, {
    dataDir: path.join(appData, 'IV Switchboard'),
    codexHome: path.join(home, '.codex'),
    claudeHome: path.join(home, '.claude'),
    hermesHome: path.join(localAppData, 'hermes')
  })
})

test('APPDATA and LOCALAPPDATA from the environment are used when not passed', () => {
  const env = { APPDATA: path.join('D:', 'Roam'), LOCALAPPDATA: path.join('D:', 'Loc') }
  const p = paths({ env, home })
  assert.equal(p.dataDir, path.join('D:', 'Roam', 'IV Switchboard'))
  assert.equal(p.hermesHome, path.join('D:', 'Loc', 'hermes'))
})

test('the clients own folder variables are honoured', () => {
  const env = { CODEX_HOME: path.join('E:', 'codex'), CLAUDE_CONFIG_DIR: path.join('E:', 'claude') }
  const p = paths({ env, home, appData, localAppData })
  assert.equal(p.codexHome, path.join('E:', 'codex'))
  assert.equal(p.claudeHome, path.join('E:', 'claude'))
})

test('IV_SWITCHBOARD_* overrides win over everything else', () => {
  const env = {
    CODEX_HOME: path.join('E:', 'codex'),
    CLAUDE_CONFIG_DIR: path.join('E:', 'claude'),
    IV_SWITCHBOARD_DATA_DIR: path.join('T:', 'data'),
    IV_SWITCHBOARD_CODEX_HOME: path.join('T:', 'codex'),
    IV_SWITCHBOARD_CLAUDE_HOME: path.join('T:', 'claude'),
    IV_SWITCHBOARD_HERMES_HOME: path.join('T:', 'hermes')
  }
  assert.deepEqual(paths({ env, home, appData, localAppData }), {
    dataDir: path.join('T:', 'data'),
    codexHome: path.join('T:', 'codex'),
    claudeHome: path.join('T:', 'claude'),
    hermesHome: path.join('T:', 'hermes')
  })
})

test('blank variables are treated as unset', () => {
  const env = { IV_SWITCHBOARD_DATA_DIR: '  ', CODEX_HOME: '' }
  const p = paths({ env, home, appData, localAppData })
  assert.equal(p.dataDir, path.join(appData, 'IV Switchboard'))
  assert.equal(p.codexHome, path.join(home, '.codex'))
})
