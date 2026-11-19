// UI check: launches IV Switchboard on made-up demo data (scripts/demo-homes.mjs) in throwaway folders,
// checks the popover, the tray tooltip, scanning, hiding task names and the Connect Claude round trip
// (against the DEMO Claude folder only), and saves screenshots. Never touches real data.
//
//   node scripts/ui-check.mjs <outDir>                       built app (npm.cmd run build first)
//   node scripts/ui-check.mjs <outDir> --exe "<path>.exe"    packaged app (npm.cmd run dist:dir first)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.resolve(process.argv[2] || 'qa/ui-check')
const exeAt = process.argv.indexOf('--exe')
const exe = exeAt > 0 ? process.argv[exeAt + 1] : null
fs.mkdirSync(out, { recursive: true })

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail })
const money = (text) => Number(String(text).replace(/[^0-9.]/g, ''))

function demo(name) {
  return JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts', 'demo-homes.mjs'), path.join(out, name)], { encoding: 'utf8' }))
}

async function launch(env) {
  const launchEnv = { ...process.env, ...env, IV_SWITCHBOARD_OPEN_ON_START: '1', IV_SWITCHBOARD_TEST: '1' }
  delete launchEnv.ELECTRON_RUN_AS_NODE
  const app = await electron.launch(exe ? { executablePath: exe, env: launchEnv } : { args: [root], cwd: root, env: launchEnv })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.waitForSelector('.card', { timeout: 60000 })
  await page.waitForTimeout(500)
  return { app, page, errors }
}

const cardText = (page, name) => page.$eval(`section[aria-label="${name}"]`, (e) => e.innerText)
const taskLabels = (page) => page.$$eval('.task-label', (els) => els.map((e) => e.textContent))

// ---------- run 1: the demo with readings ----------
{
  const env = demo('demo-run1')
  const { app, page, errors } = await launch(env)

  const trayIcon = await app.evaluate(({ app: electronApp, nativeImage }) => {
    const img = nativeImage.createFromPath(`${electronApp.getAppPath()}/resources/tray.png`)
    return img.isEmpty() ? null : img.getSize()
  })
  check('the tray icon loads (32 x 32)', trayIcon && trayIcon.width === 32 && trayIcon.height === 32, JSON.stringify(trayIcon))
  const size = await page.evaluate(() => [innerWidth, innerHeight])
  check('popover is 380 x 600', size[0] === 380 && size[1] === 600, size.join(' x '))
  const names = await page.$$eval('.card-name', (els) => els.map((e) => e.textContent))
  check('cards in order: Claude Code, Codex, Hermes', names.join('|') === 'Claude Code|Codex|Hermes', names.join(', '))

  const claude = await cardText(page, 'Claude Code')
  check('Claude: 5 hours 66% left, week 52% left, run-out shown', /66%/.test(claude) && /52%/.test(claude) && /RUNS OUT/i.test(claude))
  check('a fresh Claude reading has no out-of-date note', !/Out of date/i.test(claude))
  const codex = await cardText(page, 'Codex')
  check('Codex: 28% left, Pro plan, run-out shown', /28%/.test(codex) && /\bpro\b/i.test(codex) && /RUNS OUT/i.test(codex))
  const hermes = await cardText(page, 'Hermes')
  check('Hermes: lists Your Codex plan and xAI Grok', hermes.includes('Your Codex plan') && hermes.includes('xAI Grok'))

  const tip = await app.evaluate(() => globalThis.ivsbTest.tooltip())
  check('tray tooltip names the tightest windows', tip.includes('Claude Code: 52% of the week left') && tip.includes('Codex: 28% of the week left'), tip.replace(/\n/g, ' / '))

  const today = await taskLabels(page)
  check('top tasks today: biggest first, sub-agent rolled into its parent', today[0] === 'demo-iv-studio' && today.filter((l) => l === 'demo-client-site').length === 1, today.join(', '))
  await page.screenshot({ path: path.join(out, 'today.png') })

  const geometry = await page.evaluate(() => ({
    overflow: [...document.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'hidden' && !e.classList.contains('task-label')).length,
    small: [...document.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent || b.getAttribute('aria-label'))
  }))
  check('nothing overflows sideways', geometry.overflow === 0, `${geometry.overflow} element(s)`)
  check('every button is at least 44 px tall', geometry.small.length === 0, geometry.small.join(', '))

  await page.evaluate(() => document.querySelector('.scroll').scrollTo(0, 99999))
  await page.waitForTimeout(200)
  const footVisible = await page.$eval('.foot', (e) => e.getBoundingClientRect().bottom <= innerHeight)
  check('the panel scrolls to the price note', footVisible)
  const foot = await page.$eval('.foot', (e) => e.textContent.replace(/\s+/g, ' '))
  check('the price note dates come from the price list', /\(read Nov 17 to Nov 18, 2026\)/.test(foot), foot)
  // Unpacked or dev, pointed at a throwaway data folder: never an updater, so the row says why.
  const updateRow = await page.$eval('.update-row', (e) => e.textContent).catch(() => '')
  const expectWords = exe ? 'updates come with the installed app' : 'development build'
  check('the version row shows the version and why it does not update here', /Version \d+\.\d+\.\d+/.test(updateRow) && updateRow.includes(expectWords), updateRow)
  await page.screenshot({ path: path.join(out, 'today-bottom.png') })
  await page.evaluate(() => document.querySelector('.scroll').scrollTo(0, 0))

  const codexToday = money(await page.$eval('section[aria-label="Codex"] .spend-cost', (e) => e.textContent))
  await page.click('text=30 Days')
  await page.waitForTimeout(200)
  const codexMonth = money(await page.$eval('section[aria-label="Codex"] .spend-cost', (e) => e.textContent))
  check('30 days costs more than today for Codex (older demo session)', codexMonth > codexToday, `$${codexToday} today, $${codexMonth} in 30 days`)
  const long = await page.$$eval('.task-label', (els) => els.filter((e) => e.textContent.includes('demo-a-very-long')).map((e) => ({ cut: e.scrollWidth > e.clientWidth, title: e.title })))
  check('a long task name is cut with its full name in the tooltip', long.length === 1 && long[0].cut && long[0].title.includes('needs-truncating'))
  await page.screenshot({ path: path.join(out, '30days.png') })

  await page.click('[aria-label="Hide task names"]')
  await page.waitForTimeout(200)
  const hidden = await taskLabels(page)
  check('the eye button hides task names', hidden.length > 0 && hidden.every((l) => /^Task \d$/.test(l)), hidden.join(', '))
  await page.screenshot({ path: path.join(out, 'hidden-names.png') })
  await page.click('[aria-label="Show task names"]')
  await page.waitForTimeout(200)
  check('and shows them again', (await taskLabels(page)).some((l) => l.startsWith('demo-')))

  // Scan now picks up a new Codex reply.
  await page.click('text=Today')
  const before = await page.$eval('section[aria-label="Codex"] .spend-tokens', (e) => e.textContent)
  const day = new Date()
  const dir = path.join(env.IV_SWITCHBOARD_CODEX_HOME, 'sessions', String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'))
  const file = fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => f.includes('demo-codex-4'))
  fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ordinal: 999, type: 'token_usage_record', payload: { thread_id: 'demo-codex-4', response_id: 'demo-extra', usage: { input_tokens: 5000000, cached_input_tokens: 0, output_tokens: 1000 } } }) + '\n')
  await page.click('[aria-label="Scan now"]')
  let after = before
  for (let i = 0; i < 40 && after === before; i++) {
    await page.waitForTimeout(250)
    after = await page.$eval('section[aria-label="Codex"] .spend-tokens', (e) => e.textContent)
  }
  check('Scan now picks up a new reply', after !== before, `${before} -> ${after}`)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('Escape hides the popover', (await app.evaluate(() => globalThis.ivsbTest.popoverVisible())) === false)
  check('no page errors (run 1)', errors.length === 0, errors.join(' | '))
  await app.close()
}

// ---------- run 2: Claude not connected yet; Connect and Disconnect on the DEMO Claude folder ----------
{
  const env = demo('demo-run2')
  fs.rmSync(path.join(env.IV_SWITCHBOARD_DATA_DIR, 'claude-limits.json'))
  const settings = path.join(env.IV_SWITCHBOARD_CLAUDE_HOME, 'settings.json')
  const original = '{\n  "model": "opus",\n  "env": {\n    "DEMO": "1"\n  }\n}\n'
  fs.writeFileSync(settings, original)
  const { app, page, errors } = await launch(env)
  await page.click('text=Connect Claude')
  const shown = await page.textContent('.confirm .path')
  const isDemo = path.resolve(shown) === path.resolve(settings)
  check('the confirmation names the demo settings file', isDemo, shown)
  await page.screenshot({ path: path.join(out, 'claude-confirm.png') })
  if (isDemo) {
    await page.click('.confirm >> text=Connect')
    await page.waitForSelector('section[aria-label="Claude Code"] >> text=Connected.', { timeout: 15000 })
    const connectedNotes = await page.$$eval('section[aria-label="Claude Code"] p', (ps) => ps.filter((p) => p.textContent.startsWith('Connected.')).length)
    check('the Connected note shows once', connectedNotes === 1, `${connectedNotes} time(s)`)
    const parsed = JSON.parse(fs.readFileSync(settings, 'utf8'))
    check('Connect adds only the status line', parsed.statusLine?.command?.startsWith('node "') && parsed.model === 'opus' && parsed.env?.DEMO === '1')
    check('Connect copied the tap into the data folder', fs.existsSync(path.join(env.IV_SWITCHBOARD_DATA_DIR, 'statusline.cjs')))
    await page.evaluate(() => document.querySelector('.scroll').scrollTo(0, 99999))
    await page.click('.setting >> text=Disconnect')
    await page.waitForTimeout(500)
    check('Disconnect restores the settings file byte for byte', fs.readFileSync(settings, 'utf8') === original)
  }
  check('no page errors (run 2)', errors.length === 0, errors.join(' | '))
  await app.close()
}

// ---------- run 3: a Claude reading from two days ago, with replies since (the Code tab case) ----------
{
  const env = demo('demo-run3')
  const file = path.join(env.IV_SWITCHBOARD_DATA_DIR, 'claude-limits.json')
  const reading = JSON.parse(fs.readFileSync(file, 'utf8'))
  reading.observed_at -= 2 * 86400000
  reading.five_hour.resets_at = Math.round((reading.observed_at + 2.5 * 3600000) / 1000)
  fs.writeFileSync(file, JSON.stringify(reading))
  // A stand-in for Claude Code that prints a made-up rate_limit_event and records how it was called.
  const fakeDir = path.join(out, 'demo-run3', 'fake-claude')
  fs.mkdirSync(fakeDir, { recursive: true })
  const fakeScript = [
    "import fs from 'node:fs'",
    "fs.writeFileSync(new URL('./args.json', import.meta.url), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))",
    'const resets = (h) => Math.round(Date.now() / 1000 + h * 3600)',
    "console.log(JSON.stringify({ type: 'system', subtype: 'init' }))",
    "console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: resets(3) }, seven_day: { utilization: 0.61, resetsAt: resets(60) } } } }))",
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK' }))"
  ].join('\n')
  fs.writeFileSync(path.join(fakeDir, 'fake-claude.mjs'), fakeScript)
  fs.writeFileSync(path.join(fakeDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0fake-claude.mjs" %*\r\n')
  env.IV_SWITCHBOARD_CLAUDE_BIN = path.join(fakeDir, 'claude.cmd')
  const { app, page, errors } = await launch(env)
  const claude = await cardText(page, 'Claude Code')
  check('an old Claude reading says it is out of date and how to refresh it', /Out of date/i.test(claude) && /replies since this\s+reading/.test(claude) && /terminal/.test(claude), claude.replace(/\n/g, ' / '))
  check('the reset 5-hour window points to a terminal for the next reading', /next reply in Claude Code in a terminal/.test(claude))
  const faded = await page.$eval('section[aria-label="Claude Code"] .windows', (e) => getComputedStyle(e).opacity)
  check('the out-of-date bars are faded', Number(faded) < 0.6, `opacity ${faded}`)
  const codex = await cardText(page, 'Codex')
  check('Codex is not marked out of date', !/Out of date/i.test(codex))
  const tip = await app.evaluate(() => globalThis.ivsbTest.tooltip())
  check('the tray tooltip marks Claude out of date', tip.includes('Claude Code: 52% of the week left (out of date)'), tip.replace(/\n/g, ' / '))
  await page.screenshot({ path: path.join(out, 'claude-out-of-date.png') })

  // Refresh asks the stand-in Claude Code and the card takes its reading.
  await page.click('section[aria-label="Claude Code"] >> button:has-text("Refresh")')
  await page.waitForSelector('section[aria-label="Claude Code"] >> text=Updated from Claude Code.', { timeout: 30000 })
  await page.waitForFunction(() => !/Out of date/.test(document.querySelector('section[aria-label="Claude Code"]').innerText), null, { timeout: 15000 })
  const after = await cardText(page, 'Claude Code')
  check('Refresh brings in the new reading and clears the warning', /88%/.test(after) && /39%/.test(after) && !/Out of date/i.test(after), after.replace(/\n/g, ' / '))
  const called = JSON.parse(fs.readFileSync(path.join(fakeDir, 'args.json'), 'utf8'))
  check('Refresh runs one Haiku turn with no saved session', called.args.join(' ') === '-p Reply with the single word OK. --model haiku --output-format stream-json --verbose --no-session-persistence --max-turns 1', called.args.join(' '))
  check('Refresh runs in its own empty folder', /iv-switchboard-claude-refresh$/.test(called.cwd), called.cwd)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  check('Refresh saves only the two windows and the time', Object.keys(saved).sort().join(',') === 'five_hour,observed_at,seven_day')
  await page.screenshot({ path: path.join(out, 'claude-refreshed.png') })
  check('no page errors (run 3)', errors.length === 0, errors.join(' | '))
  await app.close()
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} passed${exe ? ' (packaged app)' : ''}. Screenshots in ${out}`)
process.exit(failed.length ? 1 : 0)
