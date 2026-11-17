// Where IV Switchboard keeps its own data, and where it reads Codex, Claude Code and Hermes from.
// Each IV_SWITCHBOARD_* variable wins, so tests and checks can point everything at throwaway folders.
import os from 'node:os'
import path from 'node:path'

const set = (value) => (typeof value === 'string' && value.trim() ? value : null)

export function paths({ env = process.env, home = os.homedir(), appData, localAppData } = {}) {
  const roaming = appData || set(env.APPDATA) || path.join(home, 'AppData', 'Roaming')
  const local = localAppData || set(env.LOCALAPPDATA) || path.join(home, 'AppData', 'Local')
  return {
    dataDir: set(env.IV_SWITCHBOARD_DATA_DIR) || path.join(roaming, 'IV Switchboard'),
    codexHome: set(env.IV_SWITCHBOARD_CODEX_HOME) || set(env.CODEX_HOME) || path.join(home, '.codex'),
    claudeHome: set(env.IV_SWITCHBOARD_CLAUDE_HOME) || set(env.CLAUDE_CONFIG_DIR) || path.join(home, '.claude'),
    hermesHome: set(env.IV_SWITCHBOARD_HERMES_HOME) || path.join(local, 'hermes')
  }
}
