// IV Switchboard main process: one instance, a tray icon whose tooltip shows what's left, a popover
// that opens from the tray, and the background scanner. Connect and Disconnect Claude run only from
// the popover's own buttons (after its confirmation), never on their own.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { paths } from '../core/paths.js'
import { claudeConnection, connectClaude, disconnectClaude } from '../core/claude-connect.js'
import { tooltip } from '../renderer/src/format.js'
import { startScanner } from './scanner.js'
import { initUpdater, updateState } from './updater.js'

const APP_ID = 'ai.infinitevariance.switchboard'
const PRODUCT = 'IV Switchboard'
const WIDTH = 380
const HEIGHT = 600

const where = paths()
// A test copy pointed at a throwaway data folder must not touch Windows' startup list or update itself.
const borrowedDataDir = Boolean(process.env.IV_SWITCHBOARD_DATA_DIR?.trim())
fs.mkdirSync(where.dataDir, { recursive: true })
app.setPath('userData', where.dataDir)
app.setAppUserModelId(APP_ID)

const settingsFile = path.join(where.dataDir, 'settings.json')
const DEFAULT_SETTINGS = { launchAtLogin: false, hideLabels: false }
function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}
function writeSettings(s) {
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2))
}

function nodeAvailable() {
  const r = spawnSync('node', ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000 })
  return r.status === 0
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let tray = null
  let popover = null
  let scanner = null
  let updater = null
  let snapshot = null
  let settings = readSettings()
  let lastTooltip = tooltip(null)
  const openOnStart = process.env.IV_SWITCHBOARD_OPEN_ON_START === '1'
  // Read-only hooks for scripts/ui-check.mjs; only present when IV_SWITCHBOARD_TEST=1.
  if (process.env.IV_SWITCHBOARD_TEST === '1') {
    globalThis.ivsbTest = { tooltip: () => lastTooltip, popoverVisible: () => Boolean(popover?.isVisible()) }
  }

  const fromPopover = (event) => popover && event.sender === popover.webContents

  function placePopover() {
    const t = tray.getBounds()
    const display = screen.getDisplayNearestPoint({ x: t.x, y: t.y })
    const area = display.workArea
    // Taskbar at the bottom (the usual case): sit above the tray icon, right-aligned to it.
    let x = Math.round(t.x + t.width / 2 - WIDTH / 2)
    let y = t.y > area.y + area.height / 2 ? area.y + area.height - HEIGHT - 8 : area.y + 8
    x = Math.min(Math.max(x, area.x + 8), area.x + area.width - WIDTH - 8)
    if (!t.width) {
      x = area.x + area.width - WIDTH - 8
      y = area.y + area.height - HEIGHT - 8
    }
    popover.setBounds({ x, y, width: WIDTH, height: HEIGHT })
  }

  function createPopover() {
    popover = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      backgroundColor: '#100c0e',
      title: PRODUCT,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    popover.on('blur', () => {
      if (!openOnStart) popover.hide()
    })
    popover.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    popover.webContents.on('will-navigate', (e) => e.preventDefault())
    if (process.env.ELECTRON_RENDERER_URL) popover.loadURL(process.env.ELECTRON_RENDERER_URL)
    else popover.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  function togglePopover() {
    if (popover.isVisible()) {
      popover.hide()
      return
    }
    placePopover()
    popover.show()
    popover.focus()
    scanner?.scanNow()
  }

  function setLaunchAtLogin(on) {
    if (app.isPackaged && !borrowedDataDir) app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
  }

  function buildMenu() {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open IV Switchboard', click: togglePopover },
        { label: 'Scan now', click: () => scanner?.scanNow() },
        {
          label: 'Launch at login',
          type: 'checkbox',
          checked: settings.launchAtLogin,
          click: (item) => {
            settings = { ...settings, launchAtLogin: item.checked }
            writeSettings(settings)
            setLaunchAtLogin(item.checked)
          }
        },
        { label: 'Open data folder', click: () => shell.openPath(where.dataDir) },
        { type: 'separator' },
        { label: `Quit ${PRODUCT}`, click: () => app.quit() }
      ])
    )
  }

  function state() {
    return { settings, update: updateState(), claude: claudeConnection({ claudeHome: where.claudeHome, dataDir: where.dataDir }), claudeSettingsFile: path.join(where.claudeHome, 'settings.json') }
  }

  ipcMain.handle('ivsb:snapshot', (e) => (fromPopover(e) ? snapshot : null))
  ipcMain.handle('ivsb:state', (e) => (fromPopover(e) ? state() : null))
  ipcMain.handle('ivsb:scan-now', (e) => {
    if (fromPopover(e)) scanner?.scanNow()
  })
  ipcMain.handle('ivsb:hide', (e) => {
    if (fromPopover(e)) popover.hide()
  })
  ipcMain.handle('ivsb:set-setting', (e, key, value) => {
    if (!fromPopover(e) || !(key in DEFAULT_SETTINGS) || typeof value !== 'boolean') return state()
    settings = { ...settings, [key]: value }
    writeSettings(settings)
    if (key === 'launchAtLogin') setLaunchAtLogin(value)
    buildMenu()
    return state()
  })
  ipcMain.handle('ivsb:check-update', async (e) => (fromPopover(e) && updater ? updater.check() : updateState()))
  ipcMain.handle('ivsb:install-update', (e) => (fromPopover(e) && updater ? updater.install() : false))
  ipcMain.handle('ivsb:connect-claude', (e) => {
    if (!fromPopover(e)) return { ok: false, message: 'Refused.' }
    if (!nodeAvailable()) {
      return { ok: false, message: "Connect needs Node.js on this PC, and it wasn't found. Install Node.js, then try again." }
    }
    try {
      const r = connectClaude({ claudeHome: where.claudeHome, dataDir: where.dataDir, scriptSource: path.join(app.getAppPath(), 'resources', 'statusline.cjs') })
      return { ok: true, message: r.already ? 'Already connected.' : 'Connected. Your Claude allowance appears after your next Claude Code reply.', state: state() }
    } catch (err) {
      return { ok: false, message: err.message, state: state() }
    }
  })
  ipcMain.handle('ivsb:disconnect-claude', (e) => {
    if (!fromPopover(e)) return { ok: false, message: 'Refused.' }
    try {
      const r = disconnectClaude({ claudeHome: where.claudeHome, dataDir: where.dataDir })
      return { ok: true, message: r.notConnected ? 'Claude was not connected.' : 'Disconnected. Your Claude settings are back as they were.', state: state() }
    } catch (err) {
      return { ok: false, message: err.message, state: state() }
    }
  })

  app.on('second-instance', () => {
    if (popover && !popover.isVisible()) togglePopover()
  })
  app.on('window-all-closed', () => {}) // lives in the tray

  app.whenReady().then(() => {
    tray = new Tray(nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'tray.png')))
    tray.setToolTip(tooltip(null))
    tray.on('click', togglePopover)
    buildMenu()
    createPopover()
    // Open at login is stored with the exe's path, so re-register it each start: after installing or
    // moving the app, Windows starts this copy, not the old one. Only when it's on, so a copy with it
    // off never removes another copy's entry.
    if (settings.launchAtLogin) setLaunchAtLogin(true)
    updater = initUpdater(
      (u) => {
        if (popover && !popover.isDestroyed()) popover.webContents.send('ivsb:update-changed', u)
      },
      { borrowedDataDir }
    )
    console.log(`[ivsb] tray ready: ${PRODUCT} (data ${where.dataDir})`)

    let firstSnapshot = true
    scanner = startScanner({
      paths: where,
      intervalMs: Number(process.env.IV_SWITCHBOARD_SCAN_MS) || 60000,
      onSnapshot: (s) => {
        snapshot = s
        lastTooltip = tooltip(s)
        tray.setToolTip(lastTooltip)
        if (popover && !popover.isDestroyed()) popover.webContents.send('ivsb:snapshot-changed', s)
        if (firstSnapshot) {
          firstSnapshot = false
          console.log('[ivsb] first snapshot ready')
          if (openOnStart) togglePopover()
        }
      },
      onError: (message) => console.error(`[ivsb] scan problem: ${message}`)
    })
  })

  app.on('before-quit', () => scanner?.stop())
}
