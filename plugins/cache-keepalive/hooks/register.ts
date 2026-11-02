import type { Hook, Register } from 'claude-code'

type Engine = Parameters<Hook<'turn.start'>>[0]

// Assumes the 1h cache TTL. Overage switches to the 5m TTL, so the mod stays off while any
// rate-limit window is at 100%. A 5m TTL it fails to infer makes the first ping miss and stop the pings.
const PING_EVERY_MS = 50 * 60_000
const TTL_MS = 60 * 60_000
const WRITE_MULT = 2
const OUTPUT_MULT = 5
// Above this fill an auto compaction is more likely context pressure than idleness, so it goes ahead
const VETO_BELOW_PERCENT = 80

// Compaction cost per context token and summary size over context, used until a compaction is measured
const COMPACT_COST_GUESS = 0.6
const SUMMARY_RATIO_GUESS = 0.15

let timer: { cancel(): void } | undefined
let generation = 0
let compactOnCap = false
let vetoIdle = false
let compacting = false
let inTurn = false
let spent = 0
let budget = 0
let context = 0
let warmUntil = 0

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
  if (!('usage' in r)) return { ok: false, paid: 0, line: `no ping: ${r.reason}` }

  const u = r.usage
  context = u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
  const hit = u.cache_read_input_tokens / Math.max(context, 1)

  return {
    ok: hit > 0.9,
    paid: cost(u, readMult(await $.session.model())),
    line: `cache read ${u.cache_read_input_tokens}/${context} (${Math.round(hit * 100)}%)`,
  }
}

function ledger() {
  return `spent ${Math.round(spent)} of ${Math.round(budget)} token-equivalents`
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
function posixRestore(cwd: string, id: string, startedAt: string) {
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const at = `jq -r 'select(.subtype == "compact_boundary" and .timestamp >= "${startedAt}") | .logicalParentUuid' `
    + `"\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/${id}.jsonl | head -1`
  return `cd ${quote(cwd)} && claude --resume ${id} --fork-session --resume-session-at "$(${at})"`
}

// Reads in PowerShell 7 and Windows PowerShell 5.1, which has no && or ??. Only boundary rows reach ConvertFrom-Json
// because it refuses the case-colliding keys tool inputs can hold. It parses dates in 7 and not in 5.1, and
// [datetimeoffset] compares either as an instant. PowerShell reads curly quotes as string ends too.
function powershellRestore(cwd: string, id: string, startedAt: string) {
  const quote = (s: string) => `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`
  return `Set-Location -LiteralPath ${quote(cwd)} -ErrorAction Stop; `
    + `$dir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { "$HOME/.claude" }; `
    + `$at = Get-Content "$dir/projects/*/${id}.jsonl" | Where-Object { $_.Contains('"subtype":"compact_boundary"') } | ConvertFrom-Json | `
    + `Where-Object { [datetimeoffset]$_.timestamp -ge [datetimeoffset]'${startedAt}' } | `
    + `Select-Object -First 1 -ExpandProperty logicalParentUuid; `
    + `claude --resume ${id} --fork-session --resume-session-at $at`
}

async function compact($: Engine) {
  compacting = true
  try {
    const startedAt = new Date(await $.clock.now()).toISOString()
    const r = await $.session.compact({ instructions: 'Also keep the background tasks\' IDs, output paths, and what to do when they finish.' })
    if (r.skip !== undefined) return `compaction skipped: ${r.skip}`
    // The mod API names no platform, so both commands go out
    const [cwd, id] = [await $.session.cwd(), await $.session.id()]
    $.ui.log(`keepalive: compacted. To reopen the conversation as it was before, in a new session, run: ${posixRestore(cwd, id, startedAt)}`)
    $.ui.log(`keepalive: or in PowerShell: ${powershellRestore(cwd, id, startedAt)}`)

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

async function refusal($: Engine) {
  const { context: ctx } = await $.session.usage()
  const why = timer ? 'the cache has expired' : 'no wait is armed, so the cache may be cold'
  return `Not pinging: ${why}. A miss re-writes the whole context, about ${WRITE_MULT * (ctx.tokens ?? 0)} token-equivalents. Use /keepalive force to ping anyway.`
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

      const { ok, paid, line } = await ping($)
      if (generation !== armedAt) return
      spent += paid
      $.ui.log(`keepalive: ${line}, ${ledger()}`, { to: 'debug' })
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
  vetoIdle = options.vetoIdleCompaction === true

  on('session.start', async ($, e, next) => {
    stop()
    $.ui.status(undefined)
    await $.command.register({ name: 'keepalive', description: 'Ping the prompt cache now and report the hit rate', argumentHint: '[force]' })
    return next(e)
  })

  // A /clear or /resume keeps the process, so a pending ping would fork into the next session
  on('session.end', async ($, e, next) => {
    stop()
    $.ui.status(undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    inTurn = true
    stop()
    if (!compacting) $.ui.status(undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) inTurn = false
    return next(e)
  })

  // Arm only when background work will wake the session later
  on('classic.Stop', async ($, e, next) => {
    const tasks = e.background_tasks?.length ?? 0
    const crons = e.session_crons?.length ?? 0
    if ((tasks || crons) && !compacting) {
      const { context: ctx, rateLimits } = await $.session.usage()
      if (inOverage(rateLimits)) {
        $.ui.status('keepalive: off in overage')
        return next(e)
      }
      spent = 0
      budget = WRITE_MULT * (ctx.tokens ?? 0)
      warmUntil = await $.clock.now() + TTL_MS
      const work = [tasks && `${tasks} task(s)`, crons && `${crons} wake-up(s)`].filter(Boolean).join(', ')
      $.ui.status(`keepalive: armed, ${work}, warm ${until(warmUntil)}`)
      arm($)
    }
    return next(e)
  })

  // Idle compaction arrives as `auto`, the trigger context-full compaction uses, so this tells them apart by
  // circumstance. A wrong veto mid-turn would end in prompt too long, so anything but the idle case goes ahead,
  // a subagent's own transcript included: the fill read here is the main conversation's, not its.
  on('session.compact', { trigger: 'auto' }, async ($, e, next) => {
    if (!vetoIdle || e.agentId !== undefined || !timer || inTurn) return next(e)
    const { context: ctx } = await $.session.usage()
    if ((ctx.percent ?? 100) >= VETO_BELOW_PERCENT) return next(e)
    return { skip: 'keepalive: background work pending, keeping full context' }
  })

  // Other sessions can push the account into overage during the wait
  on('session.measure', async ($, e, next) => {
    if (timer && e.changed.includes('rateLimits') && inOverage(e.rateLimits)) {
      stop()
      $.ui.status('keepalive: overage, stopped')
    }
    return next(e)
  })

  // A stopped wait's warmUntil is no evidence the cache is warm, so being armed is what counts, not the time alone.
  // A manual ping leaves the wait alone: its timer already fires inside the TTL.
  on('command.run', { command: 'keepalive' }, async ($, e) => {
    if (e.args.trim() !== 'force' && !(timer && await $.clock.now() < warmUntil)) return { text: await refusal($) }
    const { ok, line } = await ping($)
    return { text: `${ok ? 'HIT' : 'MISS'}: ${line}` }
  })
}
