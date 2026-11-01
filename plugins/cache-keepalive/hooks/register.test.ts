import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MIN = 60_000
const task = { id: 'b1', type: 'shell', status: 'running', description: 'build' }
const monitor = { id: 'm1', type: 'monitor', status: 'running', description: 'watch logs' }

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

test('a never-ending task stops at the max wait', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  for (let i = 0; i < 7; i++) await clock.fire(50)
  expect(seen.forks).toBe(7)
  await clock.fire(50)
  expect(seen.forks).toBe(7)
  expect(seen.statuses.at(-1)).toBe('keepalive: max wait reached')
})

test('maxWaitHours sets the cap', { options: { maxWaitHours: 1 } }, async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  await clock.fire(50)
  await clock.fire(50)
  expect(seen.forks).toBe(1)
  expect(seen.statuses.at(-1)).toBe('keepalive: max wait reached')
})

test('a monitor alone does not arm', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [monitor] } as never)
  await clock.fire(50)
  expect(seen.forks).toBe(0)
  expect(seen.statuses).toEqual([])
})

test('a monitor beside a shell task arms and counts only the shell', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [monitor, task] } as never)
  expect(seen.statuses.at(-1)).toContain('armed, 1 task(s)')
  await clock.fire(50)
  expect(seen.forks).toBe(1)
})

test('excludeTaskTypes takes a spaced list and replaces the default', { options: { excludeTaskTypes: ' shell , workflow ' } }, async ($, on) => {
  const { seen } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  expect(seen.statuses).toEqual([])
  await $.classic.Stop({ background_tasks: [monitor] } as never)
  expect(seen.statuses.at(-1)).toContain('armed, 1 task(s)')
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

test('no ping fires into a new session', async ($, on) => {
  const { seen, clock } = engine(on)
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => ({ value: { command: 'keepalive' } }) as never)
  await $.classic.Stop({ background_tasks: [task] } as never)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
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

test('a timer inside the TTL margin does not ping and says expired', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  await clock.fire(57)
  expect(seen.forks).toBe(0)
  expect(seen.statuses.at(-1)).toBe('keepalive: expired, stopped')
})

test('a timer just outside the TTL margin still pings', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  await clock.fire(56)
  expect(seen.forks).toBe(1)
})

test('a timer on schedule pings', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  await clock.fire(50)
  expect(seen.forks).toBe(1)
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

test('/keepalive refuses past the margin of an armed wait', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  clock.advance(57)
  const { text } = await keepalive($)
  expect(seen.forks).toBe(0)
  expect(text).toContain('near expiry')
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
  expect(text).toContain('not counted')
  expect(seen.statuses).toEqual([])
})

test('/keepalive on a warm wait extends it and counts against its budget', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  clock.advance(40)
  const { text } = await keepalive($)
  expect(seen.forks).toBe(1)
  expect(text).toContain('HIT: cache read 1000000/')
  expect(text).toContain('spent 50015 of 2000000')
  expect(seen.statuses.at(-1)).toMatch(/^keepalive: warm until/)
  // 90 min from arming is past the original expiry, so this ping needs the extension and the new timer
  await clock.fire(50)
  expect(seen.forks).toBe(2)
  expect(seen.logs.at(-1)).toContain('spent 100030 of 2000000')
})

test('/keepalive force past the margin extends the wait on a hit', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  clock.advance(58)
  const { text } = await keepalive($, 'force')
  expect(text).toContain('spent 50015 of')
  await clock.fire(50)
  expect(seen.forks).toBe(2)
})

test('a /keepalive miss spends none of the wait and stops it', async ($, on) => {
  const { seen, clock } = engine(on)
  await $.classic.Stop({ background_tasks: [task] } as never)
  clock.advance(40)
  seen.isHit = false
  const { text } = await keepalive($)
  expect(text).toContain('MISS')
  expect(text).toContain('spent 0 of 2000000')
  expect(seen.statuses.at(-1)).toBe('keepalive: missed, stopped')
  await clock.fire(50)
  expect(seen.forks).toBe(1)
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
