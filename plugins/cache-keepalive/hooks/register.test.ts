import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MIN = 60_000
const task = { id: 'b1', type: 'shell', status: 'running', description: 'build' }

// Stands in for the engine: a 1M-token context, cache hits on every fork, records statuses and forks.
// The timer fires only on `fire(at)`, so a test sets the wall time it fires at, as a machine that slept would.
function engine(on: On, forkOutput = 1) {
  const seen = { statuses: [] as (string | undefined)[], forks: 0, logs: [] as string[], duringFork: async () => {}, isHit: true, noAnswer: false }
  let now = Date.UTC(2026, 9, 7, 12)
  let resolve = () => {}
  on('clock.now', () => ({ value: now }) as never)
  on('clock.after', () => new Promise(r => { resolve = () => r({ value: undefined }) }) as never)
  const clock = {
    advance(minutes: number) { now += minutes * MIN },
    async fire(minutes: number) { now += minutes * MIN; resolve(); for (let i = 0; i < 1000; i++) await Promise.resolve() },
  }
  on('classic.Stop', () => ({}) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('session.usage', () => ({ value: { context: { tokens: 1_000_000, window: 1_000_000, percent: 100 }, rateLimits: [] } }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('model.fork', async () => {
    seen.forks++
    await seen.duringFork()
    if (seen.noAnswer) return { value: { isAnswered: false, reason: 'api-error' } } as never
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 10, output_tokens: forkOutput, cache_read_input_tokens: seen.isHit ? 1_000_000 : 0, cache_creation_input_tokens: seen.isHit ? 0 : 1_000_000 } } } as never
  })
  on('ui.status', (_, e) => (seen.statuses.push(e.text), { value: undefined }) as never)
  on('ui.log', (_, e) => (seen.logs.push(e.text), { value: undefined }) as never)
  return { seen, clock }
}

test('pings while warm and names the expiry', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  expect(seen.statuses.at(-1)).toContain('armed, 1 task(s), warm until')
  await clock.fire(50)
  expect(seen.forks).toBe(1)
  expect(seen.statuses.at(-1)).toMatch(/^keepalive: warm until \d+:\d\d$/)
})

test('a timer that fires after the TTL does not ping and says expired', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  await clock.fire(80)
  expect(seen.forks).toBe(0)
  expect(seen.statuses.at(-1)).toBe('keepalive: expired, stopped')
})

test('compacting on cap logs a command that restores the pre-compaction conversation', { options: { compactOnCap: true } }, async ($, on) => {
  // 400k output tokens per ping spends the whole 2M budget on the first one
  const { seen, clock } = engine(on, 400_000)
  mock.store(on)
  on('session.id', () => ({ value: 's-1' }) as never)
  on('session.cwd', () => ({ value: "/work/it's" }) as never)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 1_000_000, tokensAfter: 100_000 }) as never)
  await $.classic.Stop({ background_tasks: [task] } as never)
  await clock.fire(50)
  const restore = seen.logs.find(l => l.includes('--resume-session-at'))
  expect(restore).toContain(`cd '/work/it'\\''s' && claude --resume s-1 --fork-session --resume-session-at "$(jq -r`)
  expect(restore).toContain('.timestamp >= "2026-10-07T12:50:00.000Z"')
  expect(restore).toContain('/projects/*/s-1.jsonl | head -1)"')
})

test('no ping fires after the session ends', async ($, on) => {
  const { seen, clock } = engine(on)
  on('session.end', () => ({ sessionId: 's-1' }) as never)
  await $.classic.Stop({ background_tasks: [task] } as never)
  await $.session.end({ reason: 'clear', sessionId: 's-1' } as never)
  await clock.fire(50)
  expect(seen.forks).toBe(0)
  expect(seen.statuses.at(-1)).toBe(undefined)
})

test('a ping in flight when the session ends does not rearm or report', async ($, on) => {
  const { seen, clock } = engine(on)
  on('session.end', () => ({ sessionId: 's-1' }) as never)
  seen.duringFork = async () => { await $.session.end({ reason: 'clear', sessionId: 's-1' } as never) }
  await $.classic.Stop({ background_tasks: [task] } as never)
  await clock.fire(50)
  expect(seen.statuses.at(-1)).toBe(undefined)
  await clock.fire(50)
  expect(seen.statuses.at(-1)).toBe(undefined)
})

const keepalive = ($: Engine, args = '') => $.command.run({ command: 'keepalive', args } as never)

test('/keepalive refuses and names the cost when no wait is armed', async ($, on) => {
  const { seen } = engine(on)
  const { text } = await keepalive($)
  expect(seen.forks).toBe(0)
  expect(text).toContain('no wait is armed')
  expect(text).toContain('2000000 token-equivalents')
  expect(text).toContain('/keepalive force')
})

test('/keepalive refuses once an armed wait has expired', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  clock.advance(60)
  const { text } = await keepalive($)
  expect(seen.forks).toBe(0)
  expect(text).toContain('has expired')
  expect(text).toContain('/keepalive force')
})

test('/keepalive refuses after a wait stopped, though warmUntil is still ahead', async ($, on) => {
  const { seen } = engine(on)
  on('session.end', () => ({ sessionId: 's-1' }) as never)
  await $.classic.Stop({ background_tasks: [task] } as never)
  await $.session.end({ reason: 'clear', sessionId: 's-1' } as never)
  const { text } = await keepalive($)
  expect(seen.forks).toBe(0)
  expect(text).toContain('no wait is armed')
})

test('/keepalive force pings a cold cache and leaves any wait alone', async ($, on) => {
  const { seen } = engine(on)
  seen.isHit = false
  const { text } = await keepalive($, ' force ')
  expect(seen.forks).toBe(1)
  expect(text).toContain('MISS: cache read 0/')
  expect(seen.statuses).toEqual([])
})

test('/keepalive on a warm wait reports the hit and leaves the wait alone', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  clock.advance(40)
  const { text } = await keepalive($)
  expect(text).toContain('HIT: cache read 1000000/')
  await clock.fire(10)
  expect(seen.forks).toBe(2)
  expect(seen.logs.at(-1)).toContain('spent 50015 of 2000000')
})

test('a /keepalive miss leaves the wait running', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  clock.advance(40)
  seen.isHit = false
  expect((await keepalive($)).text).toContain('MISS')
  seen.isHit = true
  await clock.fire(10)
  expect(seen.forks).toBe(2)
  expect(seen.statuses.at(-1)).toMatch(/^keepalive: warm until/)
})

test('a /keepalive that gets no answer leaves the wait running and unspent', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  seen.noAnswer = true
  const { text } = await keepalive($)
  expect(text).toContain('no ping: api-error')
  seen.noAnswer = false
  await clock.fire(50)
  expect(seen.forks).toBe(2)
  expect(seen.logs.at(-1)).toContain('spent 50015 of 2000000')
})

const cron = { id: 'c1', schedule: '*/30 * * * *', recurring: true, prompt: 'check the build' }

test('a scheduled wake-up alone arms', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [], session_crons: [cron] } as never)
  expect(seen.statuses.at(-1)).toContain('armed, 1 wake-up(s), warm until')
  await clock.fire(50)
  expect(seen.forks).toBe(1)
})

test('a wake-up with no task list at all arms', async ($, on) => {
  const { seen } = engine(on)
  await $.classic.Stop({ session_crons: [cron] } as never)
  expect(seen.statuses.at(-1)).toContain('armed, 1 wake-up(s)')
})

test('the status counts both kinds of work', async ($, on) => {
  const { seen } = engine(on)
  await $.classic.Stop({ background_tasks: [task], session_crons: [cron, cron] } as never)
  expect(seen.statuses.at(-1)).toContain('armed, 1 task(s), 2 wake-up(s), warm until')
})

test('a Stop with neither tasks nor wake-ups does not arm', async ($, on) => {
  const { seen } = engine(on)
  await $.classic.Stop({ background_tasks: [], session_crons: [] } as never)
  expect(seen.statuses).toEqual([])
})

test('the compaction instructions cover tasks and scheduled wake-ups', { options: { compactOnCap: true } }, async ($, on) => {
  const { clock } = engine(on, 400_000)
  mock.store(on)
  on('session.id', () => ({ value: 's-1' }) as never)
  on('session.cwd', () => ({ value: '/work' }) as never)
  let instructions: string | undefined
  on('session.compact', (_, e) => (instructions = e.instructions, { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 1_000_000, tokensAfter: 100_000 }) as never)
  await $.classic.Stop({ session_crons: [cron] } as never)
  await clock.fire(50)
  expect(instructions).toContain('background tasks')
  expect(instructions).toContain('scheduled wake-up')
})

test('a subagent turn neither cancels the wait nor clears the status', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  const armed = seen.statuses.at(-1)
  await $.turn.start({ text: '', turnId: 't-1', agentId: 'a-1' } as never)
  expect(seen.statuses.at(-1)).toBe(armed)
  await clock.fire(50)
  expect(seen.forks).toBe(1)
})

test('a main-loop turn cancels the wait', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  await $.turn.start({ text: 'hi', turnId: 't-1' } as never)
  await clock.fire(50)
  expect(seen.forks).toBe(0)
})
