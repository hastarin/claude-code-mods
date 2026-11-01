import type { Hook, Register } from 'claude-code'

type Engine = Parameters<Hook<'turn.start'>>[0]

// Assumes the 1h cache TTL. Overage switches to the 5m TTL, so the mod stays off while any
// rate-limit window is at 100%. A 5m TTL it fails to infer makes the first ping miss and stop the pings.
const PING_EVERY_MS = 50 * 60_000
const TTL_MS = 60 * 60_000
const WRITE_MULT = 2
const OUTPUT_MULT = 5

// Compaction cost per context token and summary size over context, used until a compaction is measured
const COMPACT_COST_GUESS = 0.6
const SUMMARY_RATIO_GUESS = 0.15

let timer: { cancel(): void } | undefined
let generation = 0
let compactOnCap = false
let maxWaitMs = 0
let excludedTypes: string[] = []
let compacting = false
let spent = 0
let budget = 0
let context = 0
let warmUntil = 0
let waitStart = 0

// The status names the expiry so a line left on screen past it reads as stale
function until(ms: number) {
  const d = new Date(ms)
  return `until ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Cache read price over base input price
function readMult(model: string) {
  const id = model.toLowerCase()
  return /fable|mythos/.test(id) ? 0.025 : /opus[- ]?5[-. ]5/.test(id) ? 0.05 : 0.1
}

// Bumping the generation also stops a ping already in flight from rearming
function stop() {
  generation++
  timer?.cancel()
  timer = undefined
}

// Mods see only the account-wide windows, not model-scoped limits such as Fable's weekly one
function inOverage(limits: { percentUsed: number }[]) {
  return limits.some(l => l.percentUsed >= 100)
}

// Input-token equivalents a call cost, reads priced for the session's model
function cost(u: { input_tokens: number, output_tokens: number, cache_read_input_tokens: number, cache_creation_input_tokens: number }, r: number) {
  return r * u.cache_read_input_tokens + u.input_tokens
    + WRITE_MULT * u.cache_creation_input_tokens + OUTPUT_MULT * u.output_tokens
}

async function ping($: Engine) {
  const r = await $.model.fork({ prompt: 'Keep-alive ping. Reply with only: ok' })
  if (!('usage' in r)) return { ok: false, line: `no ping: ${r.reason}` }

  const u = r.usage
  context = u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
  const hit = u.cache_read_input_tokens / Math.max(context, 1)
  spent += cost(u, readMult(await $.session.model()))

  return {
    ok: hit > 0.9,
    line: `cache read ${u.cache_read_input_tokens}/${context} (${Math.round(hit * 100)}%), spent ${Math.round(spent)} of ${Math.round(budget)} token-equivalents`,
  }
}

// Compacting pays when its own cost plus re-caching the summary is below re-caching the whole context
async function compactPays($: Engine) {
  const perToken = (await $.store.get('compactCost') as number | undefined) ?? COMPACT_COST_GUESS
  const ratio = (await $.store.get('summaryRatio') as number | undefined) ?? SUMMARY_RATIO_GUESS
  return perToken + WRITE_MULT * ratio < WRITE_MULT
}

// Compaction only appends to the transcript, and its boundary row names the last message before it.
// The mod API exposes no message UUIDs, so the command reads that row, picked by when this compaction began.
// --resume-session-at is a hidden CLI flag; --fork-session leaves the compacted session as it is.
async function restoreCommand($: Engine, startedAt: string) {
  const id = await $.session.id()
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const at = `jq -r 'select(.subtype == "compact_boundary" and .timestamp >= "${startedAt}") | .logicalParentUuid' `
    + `"\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${id}.jsonl | head -1`
  return `cd ${quote(await $.session.cwd())} && claude --resume ${id} --fork-session --resume-session-at "$(${at})"`
}

async function compact($: Engine) {
  compacting = true
  try {
    const startedAt = new Date(await $.clock.now()).toISOString()
    const r = await $.session.compact({ instructions: 'Also keep the background tasks\' IDs, output paths, and what to do when they finish.' })
    if (r.skip !== undefined) return `compaction skipped: ${r.skip}`
    $.ui.log(`keepalive: compacted. To reopen the conversation as it was before, in a new session, run: ${await restoreCommand($, startedAt)}`)

    const before = r.tokensBefore ?? context
    if (r.usage && before) {
      await $.store.set('compactCost', cost(r.usage, readMult(await $.session.model())) / before)
      if (r.tokensAfter) await $.store.set('summaryRatio', r.tokensAfter / before)
    }
    const read = r.usage ? `${r.usage.cache_read_input_tokens} read from cache, ${r.usage.output_tokens} output` : 'no usage reported'
    return `compacted ${before} → ${r.tokensAfter ?? '?'} tokens (${read})`
  } catch (err) {
    return `compaction refused: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    compacting = false
  }
}

function arm($: Engine) {
  stop()
  const armedAt = generation
  timer = $.clock.after(PING_EVERY_MS, async () => {
    timer = undefined
    try {
      // A timer that fires late (the machine slept) finds the cache gone, and a ping would only re-write it
      const now = await $.clock.now()
      if (generation !== armedAt) return
      if (now >= warmUntil) return $.ui.status('keepalive: expired, stopped')
      if (now - waitStart > maxWaitMs) return $.ui.status('keepalive: max wait reached')

      const { ok, line } = await ping($)
      if (generation !== armedAt) return
      $.ui.log(`keepalive: ${line}`, { to: 'debug' })
      if (!ok) return $.ui.status('keepalive: missed, stopped')
      warmUntil = now + TTL_MS
      if (spent < budget) {
        $.ui.status(`keepalive: warm ${until(warmUntil)}`)
        return arm($)
      }

      if (!compactOnCap || !(await compactPays($))) return $.ui.status(`keepalive: budget spent, stopped, warm ${until(warmUntil)}`)
      $.ui.status('keepalive: compacting')
      const result = await compact($)
      $.ui.log(`keepalive: ${result}`, { to: 'debug' })
      $.ui.status(`keepalive: ${result.split(' (')[0]}`)
    } catch (err) {
      if (generation !== armedAt) return
      $.ui.log(`keepalive: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
      $.ui.status('keepalive: error, stopped')
    }
  })
}

export const register: Register = (on, options) => {
  compactOnCap = options.compactOnCap === true
  maxWaitMs = Number(options.maxWaitHours) * 60 * 60_000
  excludedTypes = String(options.excludeTaskTypes).split(',').map(t => t.trim())

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'keepalive', description: 'Ping the prompt cache now and report the hit rate' })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    stop()
    if (!compacting) $.ui.status(undefined)
    return next(e)
  })

  // Arm only when background work will wake the session later
  on('classic.Stop', async ($, e, next) => {
    const tasks = (e.background_tasks ?? []).filter(t => !excludedTypes.includes(t.type))
    if (tasks.length && !compacting) {
      const { context: ctx, rateLimits } = await $.session.usage()
      if (inOverage(rateLimits)) {
        $.ui.status('keepalive: off in overage')
        return next(e)
      }
      spent = 0
      budget = WRITE_MULT * (ctx.tokens ?? 0)
      waitStart = await $.clock.now()
      warmUntil = waitStart + TTL_MS
      $.ui.status(`keepalive: armed, ${tasks.length} task(s), warm ${until(warmUntil)}`)
      arm($)
    }
    return next(e)
  })

  // Other sessions can push the account into overage during the wait
  on('session.measure', async ($, e, next) => {
    if (timer && e.changed.includes('rateLimits') && inOverage(e.rateLimits)) {
      stop()
      $.ui.status('keepalive: overage, stopped')
    }
    return next(e)
  })

  on('command.run', { command: 'keepalive' }, async $ => {
    const { context: ctx } = await $.session.usage()
    if (!budget) budget = WRITE_MULT * (ctx.tokens ?? 0)
    const { ok, line } = await ping($)
    return { text: `${ok ? 'HIT' : 'MISS'}: ${line}` }
  })
}
