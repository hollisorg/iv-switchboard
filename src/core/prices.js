// API-equivalent prices: what each reply would have cost at the provider's own published API price.
// USD per million tokens, Standard speed, global region, read from the providers' pages on the day in
// PRICE_SOURCES. Only models seen in recent Claude Code, Codex and Hermes use are listed; anything else shows tokens and
// "no price on file" rather than a guess. codex-auto-review and nous/welcome have no published price.
//
// Per request, a long prompt switches some models to higher rates (`long.from` = the first prompt size
// that pays them; the prompt counts uncached input, cache reads and cache writes). Hermes keeps
// running totals per session, not per request, so its rows always use the base rate.
//
// Checked in real logs (2026-11-17): every Claude reply ran at standard speed in the global
// region with no web searches, and Codex logs carry no speed tier, so fast mode (2x), Ultrafast (6x),
// US-only processing (1.1x) and web search ($10 per 1,000) are not applied.

export const PRICES = {
  // Anthropic. Cache writes: 5-minute 1.25x input, 1-hour 2x input.
  'claude-opus-5-5': { input: 4, cachedInput: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, output: 20 },
  'claude-opus-5': { input: 5, cachedInput: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  'claude-fable-5-2': { input: 8, cachedInput: 0.2, cacheWrite5m: 10, cacheWrite1h: 16, output: 40 },
  'claude-haiku-5-5': {
    input: 0.1, cachedInput: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2, output: 0.5,
    long: { from: 100001, input: 0.5, cachedInput: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1, output: 2.5 }
  },
  // OpenAI, Standard tier. Equal to the Codex credit rates at 25 credits per dollar. No cache-write charge.
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, output: 10, long: { from: 272001, input: 4, cachedInput: 0.2, output: 15 } },
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50, long: { from: 272001, input: 20, cachedInput: 2, output: 75 } },
  'gpt-6-sol': { input: 2, cachedInput: 0.2, output: 10, long: { from: 272001, input: 4, cachedInput: 0.4, output: 15 } },
  'gpt-6.1-terra': { input: 1, cachedInput: 0.05, output: 5, long: { from: 272001, input: 2, cachedInput: 0.1, output: 7.5 } },
  // xAI.
  'grok-4.6': { input: 2, cachedInput: 0.5, output: 6, long: { from: 200000, input: 4, cachedInput: 1, output: 12 } }
}

export const PRICE_SOURCES = [
  { url: 'https://platform.claude.com/docs/en/about-claude/pricing', read: '2026-11-17', models: ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-haiku-5-5'] },
  { url: 'https://developers.openai.com/api/docs/pricing', read: '2026-11-17', models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-terra'] },
  { url: 'https://docs.x.ai/docs/models', read: '2026-11-17', models: ['grok-4.6'] }
]

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

// The same reply in one shape for every source. Codex counts cached input inside input; Claude and
// Hermes count cache reads separately. Claude splits cache writes into 5-minute and 1-hour.
export function usageOf(source, t) {
  const cacheRead = n(t.cachedInput)
  const uncached = source === 'codex' ? n(t.input) - cacheRead : n(t.input)
  const write1h = source === 'claude' ? n(t.cacheWrite1h) : 0
  const write5m = n(t.cacheWrite) - write1h
  const output = n(t.output)
  return { uncached, cacheRead, write5m, write1h, output, tokens: uncached + cacheRead + write5m + write1h + output }
}

// USD, or null when the model has no published price or the counts don't add up.
export function costUsd(source, t) {
  if (source === 'hermes' && Number.isFinite(t.costUsd) && t.costUsd > 0) return t.costUsd
  const base = t.model ? PRICES[t.model] : null
  if (!base) return null
  const u = usageOf(source, t)
  if (u.uncached < 0 || u.write5m < 0) return null
  const prompt = u.uncached + u.cacheRead + u.write5m + u.write1h
  const rate = base.long && source !== 'hermes' && prompt >= base.long.from ? base.long : base
  return (
    u.uncached * rate.input +
    u.cacheRead * rate.cachedInput +
    u.write5m * (rate.cacheWrite5m ?? rate.input) +
    u.write1h * (rate.cacheWrite1h ?? rate.input) +
    u.output * rate.output
  ) / 1e6
}
