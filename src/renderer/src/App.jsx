// The popover: what's left on Claude Code, Codex and Hermes, when each resets, whether it runs out
// first, what each used at API prices for Today / 7 Days / 30 Days, and the top tasks.
import { useEffect, useState } from 'react'
import { ago, leftPercent, money, resetText, runsOutText, tokens } from './format.js'
import switchboardMark from './assets/switchboard-mark.png'

const PERIODS = [
  ['today', 'Today'],
  ['week', '7 Days'],
  ['month', '30 Days']
]

const PROVIDERS = { 'openai-codex': 'OpenAI Codex', 'xai-oauth': 'xAI Grok', nous: 'Nous', openrouter: 'OpenRouter', anthropic: 'Anthropic' }
function providerName(p) {
  if (p.provider === 'openai-codex' && p.mode === 'subscription_included') return 'Your Codex plan'
  return PROVIDERS[p.provider] || p.provider || 'Unknown provider'
}

const EMPTY_NOTES = {
  codex: 'No allowance reading yet. It appears after your next Codex reply.',
  hermes: 'Hermes has no allowance of its own. It uses the providers below.'
}

const NEXT_READING = { claude: 'your next reply in Claude Code in a terminal, or press Refresh' }

// Claude's reading comes only from its status line, which the Claude desktop app's Code tab never runs.
function StaleNote({ engine }) {
  const n = engine.repliesSinceReading
  return (
    <p className="note stale-note" role="status">
      <strong>Out of date:</strong> {n.toLocaleString('en-US')} {engine.name} {n === 1 ? 'reply' : 'replies'} since this
      reading. The Code tab in the Claude desktop app doesn't share your allowance. Press Refresh to read it now, or send
      one message from Claude Code in a terminal.
    </p>
  )
}

// Asks Claude Code itself for the allowance: one short Haiku message, only when pressed.
function ClaudeRefresh({ primary }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  async function refresh() {
    setBusy(true)
    setResult(null)
    const r = await window.ivsb.refreshClaude()
    setBusy(false)
    setResult(r)
  }

  return (
    <>
      <div className="refresh-row">
        <button className={`btn${primary ? ' btn-primary' : ''}`} disabled={busy} onClick={refresh}>
          {busy ? 'Refreshing...' : 'Refresh'}
        </button>
        <span className="note">Asks Claude Code for your allowance. Uses one short Haiku message.</span>
      </div>
      {result && <p className={`message ${result.ok ? '' : 'bad'}`} role="status">{result.message}</p>}
    </>
  )
}

function Icon({ name }) {
  const paths = {
    eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    eyeOff: 'M3 3l18 18M10.6 6.1A10.6 10.6 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.3 3.9M6.6 6.6C3.8 8.3 2 12 2 12s3.5 6 10 6c1.6 0 3-.4 4.2-.9M9.9 9.9a3 3 0 0 0 4.2 4.2',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7'
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Window({ w, now, nextReading }) {
  const left = leftPercent(w.usedPercent)
  // The bar shows what's left, like the number next to it: it shrinks as the window is used.
  const level = w.isOut || w.runsOutAt ? 'out' : left <= 20 ? 'warn' : ''
  if (w.isPastReset) {
    return (
      <div className="window">
        <div className="window-row">
          <span className="mono">{w.label}</span>
          <span className="mono dim">reset</span>
        </div>
        <p className="note">
          Reset {resetText(w.resetsAt, now).replace(/^Resets /, '')}. The new reading comes with {nextReading}.
        </p>
      </div>
    )
  }
  return (
    <div className="window">
      <div className="window-row">
        <span className="mono">{w.label}</span>
        <span>
          <span className="window-left">{left}%</span> <span className="mono dim">left</span>
        </span>
      </div>
      <div className={`bar ${level}`} role="meter" aria-label={`${w.label}: ${left}% left`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left}>
        <span style={{ width: `${left}%` }} />
      </div>
      <div className="window-row">
        <span className="mono dim">{resetText(w.resetsAt, now)}</span>
        {w.isOut ? <span className="mono alert">Out until the reset</span> : w.runsOutAt ? <span className="mono alert">{runsOutText(w.runsOutAt, now)}</span> : null}
      </div>
    </div>
  )
}

function ClaudeConnect({ state, onChange }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const connected = state?.claude?.connected

  async function run(action) {
    setBusy(true)
    const r = await (action === 'connect' ? window.ivsb.connectClaude() : window.ivsb.disconnectClaude())
    setBusy(false)
    setConfirming(false)
    setMessage(r)
    if (r.state) onChange(r.state)
  }

  if (connected) {
    return (
      <>
        <p className="note">Connected. Your Claude allowance appears after your next reply in Claude Code in a terminal.</p>
        {message && !message.ok && <p className="message bad">{message.message}</p>}
      </>
    )
  }
  return (
    <>
      <p className="note">
        Claude Code only shares its allowance with a status line. Connect adds one to your Claude settings. A backup is
        made first, only that one setting changes, and Disconnect puts the file back exactly.
      </p>
      {confirming ? (
        <div className="confirm" role="dialog" aria-label="Connect Claude">
          <p>This changes the status line setting in:</p>
          <p className="path">{state?.claudeSettingsFile}</p>
          <p>If you already have a status line, it keeps showing: IV Switchboard runs it for you.</p>
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy} onClick={() => run('connect')}>
              Connect
            </button>
            <button className="btn" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="btn-row">
          <button className="btn" onClick={() => setConfirming(true)}>
            Connect Claude
          </button>
        </div>
      )}
      {message && <p className={`message ${message.ok ? '' : 'bad'}`}>{message.message}</p>}
    </>
  )
}

function EngineCard({ engine, usage, now, state, onState }) {
  return (
    <section className="card" aria-label={engine.name}>
      <div className="card-head">
        <div>
          <div className="card-name">{engine.name}</div>
          {engine.plan && <span className="mono pill">{engine.plan}</span>}
        </div>
        <div className="spend">
          <div className="spend-cost">{usage.tokens ? money(usage.costUsd) : '$0.00'}</div>
          <div className="mono dim spend-tokens">{tokens(usage.tokens)} tokens</div>
        </div>
      </div>
      {usage.unpricedTokens > 0 && usage.costUsd !== null && (
        <p className="note">{tokens(usage.unpricedTokens)} more tokens on models with no published price.</p>
      )}
      {engine.windows.length > 0 && (
        <div className={`windows${engine.isStale ? ' stale' : ''}`}>
          {engine.windows.map((w) => (
            <Window key={w.key} w={w} now={now} nextReading={NEXT_READING[engine.id] || 'your next reply'} />
          ))}
        </div>
      )}
      {engine.windows.length > 0 && engine.observedAt && <span className="mono dim">Reading {ago(engine.observedAt, now)}</span>}
      {engine.isStale && <StaleNote engine={engine} />}
      {engine.id === 'claude' && <ClaudeRefresh primary={engine.isStale} />}
      {!engine.windows.length && engine.id === 'claude' && <ClaudeConnect state={state} onChange={onState} />}
      {!engine.windows.length && engine.id !== 'claude' && <p className="note">{EMPTY_NOTES[engine.id]}</p>}
      {engine.id === 'hermes' && usage.providers?.length > 0 && (
        <ul className="providers">
          {usage.providers.map((p) => (
            <li key={`${p.provider}|${p.mode}`}>
              <span>{providerName(p)}</span>
              <span className="mono dim">
                {tokens(p.tokens)} · {money(p.costUsd)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// Version and self-update, like IV Chat's: an installed copy checks GitHub Releases on its own, downloads
// in the background and installs on "Restart to update" or when it quits.
function UpdateRow({ update }) {
  const [u, setU] = useState(update)
  useEffect(() => setU(update), [update])
  useEffect(() => window.ivsb.onUpdate(setU), [])
  if (!u) return null
  const version = `Version ${u.version}`
  const words = {
    dev: `${version} · development build`,
    portable: `${version} · updates come with the installed app`,
    idle: `${version} · checking for updates soon`,
    checking: `${version} · checking for updates...`,
    current: `${version} · up to date`,
    downloading: `Downloading ${u.available}${u.percent != null ? ` (${Math.round(u.percent)}%)` : ''}`,
    ready: `Version ${u.available} is ready`,
    error: `${version} · couldn't check for updates`
  }
  const canCheck = u.status === 'current' || u.status === 'error'
  return (
    <div className="setting update-row" title={u.status === 'error' ? u.error || '' : ''}>
      <span>{words[u.status] || version}</span>
      {canCheck && (
        <button className="btn" onClick={() => window.ivsb.checkUpdate().then(setU)}>
          Check
        </button>
      )}
      {u.status === 'ready' && (
        <button className="btn btn-primary" onClick={() => window.ivsb.installUpdate()}>
          Restart to update
        </button>
      )}
    </div>
  )
}

export default function App() {
  const [snapshot, setSnapshot] = useState(null)
  const [state, setState] = useState(null)
  const [period, setPeriod] = useState('today')
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    window.ivsb.getSnapshot().then((s) => s && setSnapshot(s))
    window.ivsb.getState().then(setState)
    const off = window.ivsb.onSnapshot((s) => {
      setSnapshot(s)
      window.ivsb.getState().then(setState)
    })
    const tick = setInterval(() => setNow(Date.now()), 30000)
    const onKey = (e) => {
      if (e.key === 'Escape') window.ivsb.hide()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      clearInterval(tick)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const hideLabels = Boolean(state?.settings?.hideLabels)
  const setSetting = (key, value) => window.ivsb.setSetting(key, value).then(setState)
  const p = snapshot?.periods?.[period]
  const periodName = PERIODS.find(([k]) => k === period)[1]

  return (
    <div className="app">
      {/* IV Chat's titlebar: the app's own mark, then "Infinite Variance / <app>". */}
      <header className="titlebar">
        <img className="brand-logo" src={switchboardMark} alt="IV Switchboard" />
        <span className="mono">Infinite Variance</span>
        <span className="mono dim">/ Switchboard</span>
      </header>
      <div className="top">
        <div className="mono dim updated">{snapshot ? `Updated ${ago(snapshot.generatedAt, now)}` : 'Reading your usage...'}</div>
        <button
          className="icon-btn"
          aria-label={hideLabels ? 'Show task names' : 'Hide task names'}
          title={hideLabels ? 'Show task names' : 'Hide task names for screenshots'}
          onClick={() => setSetting('hideLabels', !hideLabels)}
        >
          <Icon name={hideLabels ? 'eyeOff' : 'eye'} />
        </button>
        <button className="icon-btn" aria-label="Scan now" title="Scan now" onClick={() => window.ivsb.scanNow()}>
          <Icon name="refresh" />
        </button>
      </div>

      <main className="scroll">
        <div className="periods" role="group" aria-label="Period">
          {PERIODS.map(([key, label]) => (
            <button key={key} aria-pressed={period === key} onClick={() => setPeriod(key)}>
              {label}
            </button>
          ))}
        </div>

        {!snapshot && <p className="note">Reading your Claude Code, Codex and Hermes history. The first time takes a few seconds.</p>}

        {snapshot &&
          snapshot.engines.map((engine) => (
            <EngineCard key={engine.id} engine={engine} usage={p.byEngine.find((b) => b.id === engine.id)} now={now} state={state} onState={setState} />
          ))}

        {snapshot && (
          <>
            <div className="mono dim section-title">Top tasks · {periodName}</div>
            {p.topTasks.length ? (
              <ul className="tasks">
                {p.topTasks.map((t, i) => {
                  const label = hideLabels ? `Task ${i + 1}` : t.label || 'Untitled session'
                  return (
                    <li key={`${t.engine}-${i}`}>
                      <span className="mono dim">{t.engine}</span>
                      <span className="task-label" title={label}>
                        {label}
                      </span>
                      <span className="task-cost" title={`${tokens(t.tokens)} tokens`}>
                        {money(t.costUsd)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="note">No use in this period.</p>
            )}

            <div className="mono dim section-title">Settings</div>
            <button
              className="setting setting-toggle"
              role="switch"
              aria-checked={Boolean(state?.settings?.launchAtLogin)}
              onClick={() => setSetting('launchAtLogin', !state?.settings?.launchAtLogin)}
            >
              <span>Open at login</span>
              <span className="switch" aria-hidden="true" data-on={Boolean(state?.settings?.launchAtLogin)} />
            </button>
            {state?.claude?.connected && (
              <div className="setting">
                <span>Claude status line connected</span>
                <button
                  className="btn"
                  onClick={async () => {
                    const r = await window.ivsb.disconnectClaude()
                    if (r.state) setState(r.state)
                  }}
                >
                  Disconnect
                </button>
              </div>
            )}
            <UpdateRow update={state?.update} />

            <p className="note foot">
              Costs are what the same use would cost at Anthropic, OpenAI and xAI API prices (read Nov 17, 2026), not what
              your plans charge.
            </p>
          </>
        )}
      </main>
    </div>
  )
}
