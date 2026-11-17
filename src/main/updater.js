// IV Switchboard updates itself from GitHub Releases (latest.yml is published next to the installer), the
// same way IV Chat, IV Downloader and IV Studio do: it checks 10 seconds after launch and every six hours,
// downloads a new version in the background, and installs it when the person presses "Restart to update"
// or quits the app.
//
// Only an installed copy updates. An unpacked build (dist\win-unpacked) or a test copy pointed at a
// throwaway data folder reports "portable" and never downloads, so a check can't replace another copy.
// IV_SWITCHBOARD_UPDATE_FEED (a URL with a latest.yml) points a copy at a local feed for testing; such a
// copy checks and downloads but never installs on quit.
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater
const TEST_FEED = process.env.IV_SWITCHBOARD_UPDATE_FEED
const SIX_HOURS = 6 * 60 * 60 * 1000

// The NSIS installer puts its uninstaller next to the app; an unpacked build has none.
function isInstalled() {
  const exeDir = path.dirname(process.execPath)
  return fs.readdirSync(exeDir).some((name) => /^Uninstall .*\.exe$/i.test(name))
}

let current = { status: 'idle', version: app.getVersion(), available: null, percent: null, error: null, checkedAt: null }

export function updateState() {
  return current
}

export function initUpdater(onChange, { borrowedDataDir = false } = {}) {
  const set = (patch) => {
    current = { ...current, ...patch }
    onChange(current)
  }

  // Development builds have no app-update.yml; only packaged builds check.
  if (!app.isPackaged) {
    set({ status: 'dev' })
    return { check: async () => current, install: () => false }
  }
  if (!TEST_FEED && (borrowedDataDir || !isInstalled())) {
    set({ status: 'portable' })
    return { check: async () => current, install: () => false }
  }

  if (TEST_FEED) autoUpdater.setFeedURL({ provider: 'generic', url: TEST_FEED })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = !TEST_FEED

  const now = () => new Date().toISOString()
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }))
  autoUpdater.on('update-not-available', () => set({ status: 'current', available: null, checkedAt: now() }))
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', available: info.version, percent: 0, checkedAt: now() }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: p.percent }))
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', available: info.version, percent: 100 }))
  autoUpdater.on('error', (err) => {
    const message = String(err?.message || err)
    // Before the first release is published (drafts only), GitHub has no "latest" to report.
    if (/Unable to find latest version/i.test(message)) return set({ status: 'current', error: null, checkedAt: now() })
    set({ status: 'error', error: message.split('\n')[0] })
  })

  const check = async () => {
    // A download in progress, or one waiting to install, isn't restarted by another check.
    if (current.status === 'downloading' || current.status === 'ready') return current
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      /* reported through the error event */
    }
    return current
  }

  setTimeout(check, 10_000)
  setInterval(check, SIX_HOURS)

  return {
    check,
    // Silent install, then IV Switchboard starts again on the new version.
    install: () => {
      if (current.status !== 'ready') return false
      autoUpdater.quitAndInstall(true, true)
      return true
    }
  }
}
