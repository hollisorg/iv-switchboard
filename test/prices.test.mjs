import test from 'node:test'
import assert from 'node:assert/strict'
import { PRICES, PRICE_SOURCES, costUsd, usageOf } from '../src/core/prices.js'

const close = (actual, expected) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`)
const M = 1e6

test('every price names its source page and the day it was read', () => {
  const sourced = new Set(PRICE_SOURCES.flatMap((s) => s.models))
  for (const model of Object.keys(PRICES)) assert.ok(sourced.has(model), `${model} has a source`)
  for (const s of PRICE_SOURCES) {
    assert.match(s.url, /^https:\/\//)
    assert.match(s.read, /^\d{4}-\d{2}-\d{2}$/)
  }
})

test('Codex input already includes cached input', () => {
  const t = { model: 'gpt-6.1-sol', input: 1000, cachedInput: 400, cacheWrite: 0, cacheWrite1h: 0, output: 50 }
  assert.deepEqual(usageOf('codex', t), { uncached: 600, cacheRead: 400, write5m: 0, write1h: 0, output: 50, tokens: 1050 })
  close(costUsd('codex', t), (600 * 2 + 400 * 0.1 + 50 * 10) / M)
})

test('an OpenAI request over 272k input tokens is priced at the long-context rate', () => {
  close(costUsd('codex', { model: 'gpt-6-astra', input: 300000, cachedInput: 100000, output: 1000 }), (200000 * 20 + 100000 * 2 + 1000 * 75) / M)
  close(costUsd('codex', { model: 'gpt-6-astra', input: 272000, cachedInput: 0, output: 0 }), (272000 * 10) / M)
})

test('GPT-6.2 Astra and Sol are priced, including past 272k input tokens', () => {
  close(costUsd('codex', { model: 'gpt-6.2-sol', input: 1000, cachedInput: 400, cacheWrite: 0, output: 50 }), (600 * 2 + 400 * 0.1 + 50 * 10) / M)
  close(costUsd('codex', { model: 'gpt-6.2-astra', input: 1000, cachedInput: 400, cacheWrite: 0, output: 50 }), (600 * 8 + 400 * 0.4 + 50 * 40) / M)
  close(costUsd('codex', { model: 'gpt-6.2-astra', input: 449862, cachedInput: 448384, cacheWrite: 0, output: 455 }), (1478 * 16 + 448384 * 0.8 + 455 * 60) / M)
  close(costUsd('codex', { model: 'gpt-6.2-sol', input: 300000, cachedInput: 0, cacheWrite: 0, output: 0 }), (300000 * 4) / M)
})

test('Claude prices cache reads, 5-minute and 1-hour cache writes separately', () => {
  const t = { model: 'claude-opus-5-5', input: 2, cachedInput: 1000, cacheWrite: 500, cacheWrite1h: 400, output: 210 }
  assert.deepEqual(usageOf('claude', t), { uncached: 2, cacheRead: 1000, write5m: 100, write1h: 400, output: 210, tokens: 1712 })
  close(costUsd('claude', t), (2 * 4 + 1000 * 0.2 + 100 * 5 + 400 * 8 + 210 * 20) / M)
})

test('Claude Haiku 5.5 over 100k prompt tokens (cache included) uses its higher rates', () => {
  close(costUsd('claude', { model: 'claude-haiku-5-5', input: 50000, cachedInput: 50001, cacheWrite: 0, cacheWrite1h: 0, output: 10 }), (50000 * 0.5 + 50001 * 0.05 + 10 * 2.5) / M)
  close(costUsd('claude', { model: 'claude-haiku-5-5', input: 50000, cachedInput: 50000, cacheWrite: 0, cacheWrite1h: 0, output: 10 }), (50000 * 0.1 + 50000 * 0.01 + 10 * 0.5) / M)
})

test('a model with no published price has no cost', () => {
  assert.equal(costUsd('codex', { model: 'codex-auto-review', input: 10, cachedInput: 0, output: 1 }), null)
  assert.equal(costUsd('claude', { model: 'claude-future-9', input: 10, cachedInput: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1 }), null)
  assert.equal(costUsd('codex', { model: null, input: 10, cachedInput: 0, output: 1 }), null)
})

test('Hermes uses its own cost when it priced the call, otherwise the model price (its input excludes cache reads)', () => {
  close(costUsd('hermes', { model: 'gpt-6.1-sol', input: 1, cachedInput: 0, cacheWrite: 0, output: 1, costUsd: 0.5 }), 0.5)
  const row = { model: 'gpt-6.1-sol', input: 1000, cachedInput: 4000, cacheWrite: 0, output: 58, costUsd: null }
  assert.deepEqual(usageOf('hermes', row), { uncached: 1000, cacheRead: 4000, write5m: 0, write1h: 0, output: 58, tokens: 5058 })
  close(costUsd('hermes', row), (1000 * 2 + 4000 * 0.1 + 58 * 10) / M)
  close(costUsd('hermes', { model: 'grok-4.6', input: 100, cachedInput: 50, cacheWrite: 0, output: 10, costUsd: null }), (100 * 2 + 50 * 0.5 + 10 * 6) / M)
  assert.equal(costUsd('hermes', { model: 'nous/welcome', input: 5, cachedInput: 0, cacheWrite: 0, output: 5, costUsd: null }), null)
})

test('a Codex row with more cached than total input is not priced', () => {
  assert.equal(costUsd('codex', { model: 'gpt-6.1-sol', input: 10, cachedInput: 11, output: 1 }), null)
})
