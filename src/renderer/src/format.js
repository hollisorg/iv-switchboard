// Words and numbers for the popover and the tray tooltip. Pure functions, tested in test/format.test.mjs.

const LOCALE = 'en-US'

export function money(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'No price'
  if (v > 0 && v < 0.01) return 'under $0.01'
  if (v >= 1000) return `$${Math.round(v).toLocaleString(LOCALE)}`
  return `$${v.toFixed(2)}`
}

export function tokens(n) {
  const v = Number(n) || 0
  const short = (x, unit) => `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10}${unit}`
  if (v >= 1e9) return short(v / 1e9, 'B')
  if (v >= 1e6) return short(v / 1e6, 'M')
  if (v >= 1e3) return short(v / 1e3, 'K')
  return String(Math.round(v))
}

export function leftPercent(usedPercent) {
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)))
}

const clock = (ms) => new Date(ms).toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' }).replace(/ /g, ' ')
const midnight = (ms) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function when(ms, now) {
  const days = Math.round((midnight(ms) - midnight(now)) / 86400000)
  if (days === 0) return `today ${clock(ms)}`
  if (days === 1) return `tomorrow ${clock(ms)}`
  if (days > 1 && days < 7) return `${new Date(ms).toLocaleDateString(LOCALE, { weekday: 'short' })} ${clock(ms)}`
  return new Date(ms).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' })
}

export function resetText(resetsAt, now = Date.now()) {
  return Number.isFinite(resetsAt) ? `Resets ${when(resetsAt, now)}` : 'Reset time unknown'
}

export function runsOutText(at, now = Date.now()) {
  return `Runs out ${when(at, now)}`
}

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, now - ms) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

const windowWords = (label) => (label === 'Week' ? 'the week' : label === '5 hours' ? 'the 5-hour window' : `the ${label} window`)

// The tray tooltip: each agent app with a reading, by its tightest window. Windows caps it at 127 characters.
export function tooltip(snapshot) {
  if (!snapshot) return 'IV Switchboard\nReading your usage...'
  const lines = ['IV Switchboard']
  for (const e of snapshot.engines) {
    if (e.id === 'hermes' && !e.windows.length) continue // Hermes has no allowance of its own
    const live = e.windows.filter((w) => !w.isPastReset)
    if (!e.windows.length) lines.push(`${e.name}: no reading yet`)
    else if (!live.length) lines.push(`${e.name}: reset, ${e.isStale ? 'refresh from a terminal' : 'new reading on next use'}`)
    else {
      const tight = live.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
      lines.push(`${e.name}: ${leftPercent(tight.usedPercent)}% of ${windowWords(tight.label)} left${e.isStale ? ' (out of date)' : ''}`)
    }
  }
  return lines.join('\n').slice(0, 127)
}
