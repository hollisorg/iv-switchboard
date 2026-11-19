import test from 'node:test'
import assert from 'node:assert/strict'
import { ago, leftPercent, money, priceReadText, resetText, runsOutText, tokens, tooltip } from '../src/renderer/src/format.js'
import { PRICE_SOURCES } from '../src/core/prices.js'

test('the price note gives the day the price pages were read, or the first and last day', () => {
  assert.equal(priceReadText([{ read: '2026-11-17' }, { read: '2026-11-17' }]), 'Nov 17, 2026')
  assert.equal(priceReadText([{ read: '2026-11-18' }, { read: '2026-11-17' }]), 'Nov 17 to Nov 18, 2026')
  assert.equal(priceReadText([{ read: '2026-12-30' }, { read: '2027-01-02' }]), 'Dec 30, 2026 to Jan 2, 2027')
  assert.equal(priceReadText([]), null)
  assert.equal(priceReadText(PRICE_SOURCES), 'Nov 17 to Nov 18, 2026', 'the shipped price list')
})

const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime() // Tuesday 17 Nov, noon local
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m, 0).getTime()

test('money: no price is said plainly; small, normal and large amounts', () => {
  assert.equal(money(null), 'No price')
  assert.equal(money(0), '$0.00')
  assert.equal(money(0.004), 'under $0.01')
  assert.equal(money(137.6), '$137.60')
  assert.equal(money(4774.39), '$4,774')
})

test('tokens: short and readable', () => {
  assert.deepEqual([0, 850, 12345, 1_500_000, 426_200_000, 16_578_000_000].map(tokens), ['0', '850', '12.3K', '1.5M', '426M', '16.6B'])
})

test('allowance left, never below 0 or above 100', () => {
  assert.deepEqual([56, 0, 100, 104.2, 41.2].map(leftPercent), [44, 100, 0, 0, 59])
})

test('reset times read naturally', () => {
  assert.equal(resetText(at(17, 17, 56), NOW), 'Resets today 5:56 PM')
  assert.equal(resetText(at(18, 9), NOW), 'Resets tomorrow 9:00 AM')
  assert.equal(resetText(at(20, 5, 56), NOW), 'Resets Fri 5:56 AM')
  assert.equal(resetText(at(30, 8), NOW), 'Resets Nov 30')
  assert.equal(resetText(null, NOW), 'Reset time unknown')
})

test('run-out times use the same words', () => {
  assert.equal(runsOutText(at(19, 14, 10), NOW), 'Runs out Thu 2:10 PM')
  assert.equal(runsOutText(at(17, 15), NOW), 'Runs out today 3:00 PM')
})

test('how long ago', () => {
  assert.equal(ago(NOW - 20 * 1000, NOW), 'just now')
  assert.equal(ago(NOW - 5 * 60000, NOW), '5 min ago')
  assert.equal(ago(NOW - 2 * 3600000, NOW), '2 h ago')
  assert.equal(ago(NOW - 3 * 86400000, NOW), '3 days ago')
  assert.equal(ago(NOW - 86400000, NOW), '1 day ago')
})

test('the tray tooltip names each agent app and its tightest window, and fits Windows\' 127 characters', () => {
  const snap = {
    engines: [
      { id: 'claude', name: 'Claude Code', windows: [] },
      { id: 'codex', name: 'Codex', windows: [{ label: 'Week', usedPercent: 56, isPastReset: false }] },
      { id: 'hermes', name: 'Hermes', windows: [] }
    ]
  }
  assert.equal(tooltip(snap), 'IV Switchboard\nClaude Code: no reading yet\nCodex: 44% of the week left')
  snap.engines[0].windows = [{ label: '5 hours', usedPercent: 10, isPastReset: false }, { label: 'Week', usedPercent: 80, isPastReset: false }]
  assert.equal(tooltip(snap).split('\n')[1], 'Claude Code: 20% of the week left')
  snap.engines[0].isStale = true
  assert.equal(tooltip(snap).split('\n')[1], 'Claude Code: 20% of the week left (out of date)')
  snap.engines[0].windows = [{ label: 'Week', usedPercent: 80, isPastReset: true }]
  assert.equal(tooltip(snap).split('\n')[1], 'Claude Code: reset, refresh from a terminal')
  assert.equal(tooltip(null), 'IV Switchboard\nReading your usage...')
  assert.ok(tooltip(snap).length <= 127)
})
