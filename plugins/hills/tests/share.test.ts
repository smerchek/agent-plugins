import { expect, mock, test } from 'claude-code/testing'

const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const climbs = JSON.stringify({
  climbs: [{
    id: 'img', label: 'API image size', short: 'img', unit: 'MB', direction: 'lower', baseline: 3025,
    rounds: [{ round: 'r1', value: 900, kept: true }, { round: 'r2', value: 431, kept: true, note: 'distroless base' }],
  }],
})

const reply = (line: string) =>
  JSON.stringify({ outlook: 'more-hills', ceiling: 300, line, nextHills: ['Split worker image'] })

// Beneath the plugin: the session's prompt, the transcript read and the outside read.
const engine = (on: any, lines: string[]) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
  on('model.fork', () => ({ value: { isAnswered: true, text: climbs, usage } }))
  on('model.complete', () => ({ value: { isAnswered: true, text: reply(lines.shift() ?? 'Same read.'), usage } }))
  on('command.run', () => ({ text: '' }))
  return mock.clock(on)
}

// The engine stamps origin and presentation on a typed command.
const hills = ($: any, args: string) => $.command.run({ command: 'hills', args })

const contextOf = async ($: any, text: string) =>
  ((await $.prompt.submit({ text })).context ?? []).join('\n') as string

test('hands a new outside read to the agent once', async ($, on) => {
  const clock = engine(on, ['Distroless base is near done.', 'Now at the top.'])
  await hills($, '')
  await clock.settle()

  const first = await contextOf($, 'next round')
  expect(first).toContain('Distroless base is near done.')
  expect(first).toContain('Split worker image')
  expect(await contextOf($, 'another round')).toBe('')

  await hills($, 'assess')
  await clock.settle()
  expect(await contextOf($, 'again')).toContain('Now at the top.')
})

test('keeps reads on hover only after /hills private', async ($, on) => {
  const clock = engine(on, ['Distroless base is near done.'])
  await hills($, '')
  await clock.settle()
  await hills($, 'private')
  expect(await contextOf($, 'next round')).toBe('')
})

test('/hills prints the details as text', async ($, on) => {
  const clock = engine(on, ['Distroless base is near done.'])
  await hills($, '')
  await clock.settle()
  const { text } = await hills($, '')
  expect(text).toContain('API image size')
  expect(text).toContain('Distroless base is near done.')
})
