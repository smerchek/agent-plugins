import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HillsHill, HillsOutlook, HillsPerspective, HillsPoint } from '../types'

// The mod reads no files. After each turn it forks the session's own
// transcript and asks what is being climbed, so any hillclimb counts, however
// its numbers were measured or logged. A second, history-free model call then
// gives the outside read on how much higher there is to go.

const PANE = 'hills'
const MIN_GAP_MS = 60_000
const OUTSIDE_MODEL = 'sonnet'
const CLIMB_WORDS = /hill.?climb|optimi[sz]e|shrink|slim (down|the)|reduce .{0,30}(size|time|latency|cost|memory)|iterate (on|until)|benchmark/i

const hills = atom({ plugin: 'hills', key: 'hills' } as const, [])
const perspectives = atom({ plugin: 'hills', key: 'perspectives' } as const, {})
const isTracking = atom({ plugin: 'hills', key: 'isTracking' } as const, false)
const status = atom({ plugin: 'hills', key: 'status' } as const, null)

type $ = EngineInterface

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const firstJson = (text: string): any => {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    return JSON.parse(match[0])
  } catch {
    return undefined
  }
}

const fmt = (v: number, unit?: string) => {
  const abs = Math.abs(v)
  const n = abs >= 100 ? v.toFixed(0) : abs >= 10 ? v.toFixed(1) : v.toFixed(2)
  return unit === '%' ? `${n}%` : unit ? `${n} ${unit}` : n
}

const best = (hill: HillsHill) => {
  const kept = hill.points.filter(p => p.isKept).map(p => p.value)
  const pool = kept.length ? kept : [hill.baseline]
  return hill.direction === 'lower' ? Math.min(...pool) : Math.max(...pool)
}

// The top of the hill: the stated target, or once that is passed (or absent)
// the outside read's estimate of the ceiling.
const summitOf = (hill: HillsHill, view?: HillsPerspective) => {
  const now = best(hill)
  const isPast = hill.target !== undefined && (hill.direction === 'lower' ? now <= hill.target : now >= hill.target)
  return isPast ? (view?.ceiling ?? hill.target) : (hill.target ?? view?.ceiling)
}

// ---------- reading the climb out of the transcript ----------

const toHill = (raw: any): HillsHill | undefined => {
  const id = str(raw?.id)?.replace(/[^\w-]+/g, '-').toLowerCase()
  const rounds: any[] = Array.isArray(raw?.rounds) ? raw.rounds : []
  const points: HillsPoint[] = rounds.flatMap(r => {
    const value = num(r?.value)
    return value === undefined
      ? []
      : [{ round: String(r.round ?? ''), value, isKept: r.kept !== false, note: str(r.note) }]
  })
  if (!id || points.length === 0) return undefined
  const baseline = num(raw.baseline) ?? points[0]!.value
  return {
    id,
    label: str(raw.label) ?? id,
    unit: str(raw.unit),
    direction: raw.direction === 'lower' ? 'lower' : 'higher',
    baseline,
    target: num(raw.target),
    points,
    context: str(raw.context),
    signature: points.map(p => `${p.round}=${p.value}${p.isKept ? '' : 'x'}`).join(','),
  }
}

const extractPrompt = (prior: HillsHill[]) => `Set the task aside for one reply. A progress panel beside this conversation needs data.

Look back over this whole conversation for hillclimbing: repeated attempts to move a measurable metric (an image size, a build or boot time, a latency, a pass rate, a bundle size, a cost, an error count) where each attempt is measured and kept or reverted.

Reply with JSON only, no prose:
{"climbs": [{
  "id": "short-kebab-id",
  "label": "what the metric is, under 5 words",
  "unit": "MB" | "s" | "%" | null,
  "direction": "lower" | "higher",
  "baseline": <number>,
  "target": <number stated in the conversation, else null>,
  "rounds": [{"round": "baseline" | "1" | "2" | ..., "value": <number>, "kept": true | false, "note": "what changed, under 10 words"}],
  "context": "one sentence: what is being changed and what is off limits"
}]}

Use only numbers actually measured in this conversation; never estimate one. Keep one unit per metric, converting where needed. List rounds in order, the baseline first. A metric measured once is not a climb. ${
  prior.length ? `Reuse these ids for the same metrics: ${prior.map(h => h.id).join(', ')}.` : ''
} No climb at all: {"climbs": []}.`

let isReading = false
let lastReadAt = 0

async function readClimbs($: $, isForced = false) {
  const now = await $.clock.now()
  if (isReading || (!isForced && now - lastReadAt < MIN_GAP_MS)) return
  isReading = true
  lastReadAt = now
  try {
    await update($, status, () => 'Reading the climb from this session…')
    const prior = await read($, hills)
    const reply = await $.model.fork({ prompt: extractPrompt(prior) })
    if (!reply.isAnswered) {
      await update($, status, () => (reply.reason === 'nothing-to-fork' ? null : `Could not read the climb (${reply.reason}).`))
      return
    }
    const parsed = firstJson(reply.text)
    const found: HillsHill[] = (Array.isArray(parsed?.climbs) ? parsed.climbs : [])
      .map(toHill)
      .filter((h: HillsHill | undefined): h is HillsHill => h !== undefined && h.points.length >= 2)
    await update($, status, () => null)
    if (found.length === 0) return
    const sig = (list: HillsHill[]) => list.map(h => `${h.id}:${h.signature}:${h.target}`).join('|')
    if (sig(prior) !== sig(found)) await update($, hills, () => found)
    if (prior.length === 0) void $.ui.open({ id: PANE, title: 'Hills' })
    await assessStale($, found)
  } finally {
    isReading = false
  }
}

// ---------- the outside read ----------

const OUTLOOKS: HillsOutlook[] = ['climbing', 'slowing', 'summit', 'more-hills']

const assessPrompt = (hill: HillsHill) => {
  const rounds = hill.points
    .map(p => `- ${p.round}: ${fmt(p.value, hill.unit)}${p.isKept ? '' : ' (reverted)'}${p.note ? ` — ${p.note}` : ''}`)
    .join('\n')
  return `You are an outside reviewer looking at a hillclimb: someone changes one thing at a time, measures a metric, keeps what helps and reverts what does not.

Metric: ${hill.label} (${hill.direction} is better${hill.unit ? `, unit ${hill.unit}` : ''})
Baseline: ${fmt(hill.baseline, hill.unit)}
${hill.target !== undefined ? `Stated target: ${fmt(hill.target, hill.unit)}` : 'No stated target.'}
Rounds:
${rounds}
${hill.context ? `\nContext: ${hill.context}\n` : ''}
From the shape of the curve, what was tried, and what you know about this kind of problem, judge how close this effort is to its ceiling.
Reply with JSON only:
{"outlook": "climbing" | "slowing" | "summit" | "more-hills",
 "ceiling": <best value you think this approach can reach, in the metric's unit, or null>,
 "line": "<one or two plain sentences, at most 40 words>",
 "nextHills": ["<a different approach that could go further, under 8 words>"]}
climbing: still gaining steadily. slowing: gains shrinking toward this approach's ceiling. summit: this approach is done. more-hills: this approach is near done, but a different one could go much further. nextHills: at most 3, empty when none.`
}

async function assessStale($: $, list: HillsHill[], isForced = false) {
  for (const hill of list) {
    const have = (await read($, perspectives))[hill.id]
    if (!isForced && have?.signature === hill.signature) continue
    await update($, status, () => `Getting an outside read on ${hill.label}…`)
    const reply = await $.model.complete({ model: OUTSIDE_MODEL, prompt: assessPrompt(hill), maxTokens: 400, effort: 'low' })
    const raw = reply.isAnswered ? firstJson(reply.text) : undefined
    if (!raw) continue
    const view: HillsPerspective = {
      outlook: OUTLOOKS.includes(raw.outlook) ? raw.outlook : 'climbing',
      ceiling: num(raw.ceiling),
      line: String(raw.line ?? '').slice(0, 300),
      nextHills: Array.isArray(raw.nextHills) ? raw.nextHills.map(String).slice(0, 3) : [],
      signature: hill.signature,
    }
    await update($, perspectives, all => ({ ...all, [hill.id]: view }))
  }
  await update($, status, () => null)
}

// ---------- drawing ----------

type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean }

const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

const smooth = (t: number) => t * t * (3 - 2 * t)

// Height of the main hill at x, in [0,1] of the drawing's rows.
const hillAt = (x: number, peakX: number, cols: number, rows: number) => {
  const peak = (rows - 1) / rows
  if (x <= peakX) return 0.06 + (peak - 0.06) * smooth(x / Math.max(1, peakX))
  const t = (x - peakX) / Math.max(1, cols - 1 - peakX)
  return peak - 0.35 * smooth(t)
}

// A farther ridge behind the hill on the right: how much more there is past this summit.
const ridgeAt = (x: number, cols: number, outlook?: HillsOutlook) => {
  const top = outlook === 'more-hills' ? 1 : outlook === 'slowing' ? 0.7 : 0
  if (!top) return 0
  const t = Math.max(0, (x - cols * 0.55) / (cols * 0.45))
  return top * smooth(Math.min(1, t))
}

const merge = (segs: Seg[]): Seg[] =>
  segs.reduce<Seg[]>((out, s) => {
    const last = out[out.length - 1]
    if (last && last.color === s.color && last.dim === s.dim && last.bold === s.bold) last.text += s.text
    else out.push({ ...s })
    return out
  }, [])

const drawHill = (hill: HillsHill, view: HillsPerspective | undefined, cols: number, rows: number): Seg[][] => {
  const start = hill.baseline
  const now = best(hill)
  const summit = summitOf(hill, view)
  // No target and no outside estimate yet: the top is unknown, so stand halfway.
  const span = summit === undefined ? 0 : summit - start
  const progress = summit === undefined ? 0.5 : span === 0 ? 1 : Math.min(1, Math.max(0, (now - start) / span))
  const peakX = Math.round((cols - 1) * 0.7)
  const climberX = Math.round(progress * peakX)
  const heights = Array.from({ length: cols }, (_, x) => hillAt(x, peakX, cols, rows) * rows * 8)
  const ridges = Array.from({ length: cols }, (_, x) => ridgeAt(x, cols, view?.outlook) * rows * 8)
  const topRow = (x: number) => rows - 1 - Math.floor(Math.max(0, heights[x]! - 1) / 8)

  const lines: Seg[][] = []
  for (let r = 0; r < rows; r++) {
    const floor = (rows - 1 - r) * 8
    const segs: Seg[] = []
    for (let x = 0; x < cols; x++) {
      const fill = Math.round(Math.min(8, Math.max(0, heights[x]! - floor)))
      const ridgeFill = Math.round(Math.min(8, Math.max(0, ridges[x]! - floor)))
      const isClimber = x === climberX && r === topRow(x) - 1
      const isFlag = x === peakX && r === topRow(x) - 1
      if (isClimber) segs.push({ text: '●', color: 'yellow', bold: true })
      else if (isFlag) segs.push({ text: summit === undefined ? '?' : summit === hill.target ? '⚑' : '⚐', color: 'white' })
      else if (fill > 0) segs.push({ text: EIGHTHS[fill]!, color: x <= climberX ? 'green' : 'gray' })
      else if (ridgeFill > 0) segs.push({ text: EIGHTHS[ridgeFill]!, color: 'blue', dim: true })
      else segs.push({ text: ' ' })
    }
    lines.push(merge(segs))
  }
  return lines
}

// One cell per round: kept rounds green, reverted red, scaled baseline→summit.
const drawRounds = (hill: HillsHill, view: HillsPerspective | undefined): Seg[] => {
  const summit = summitOf(hill, view) ?? best(hill)
  const span = summit - hill.baseline || 1
  return merge(
    hill.points.map(p => {
      const t = Math.min(1, Math.max(0, (p.value - hill.baseline) / span))
      return { text: EIGHTHS[Math.max(1, Math.round(t * 8))]!, color: p.isKept ? 'green' : 'red' }
    }),
  )
}

const OUTLOOK_TEXT: Record<HillsOutlook, string> = {
  climbing: 'still climbing',
  slowing: 'leveling off',
  summit: 'at the top of this hill',
  'more-hills': 'higher hills past this one',
}


// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hills',
      description: 'Show hillclimb progress as hills (/hills assess for a fresh outside read, /hills off to stop)',
    })
    if ((await read($, hills)).length > 0) void $.ui.open({ id: PANE, title: 'Hills' })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (CLIMB_WORDS.test(e.text) && !(await read($, isTracking))) await update($, isTracking, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && !e.isAborted && (await read($, isTracking))) {
      $.clock.after(0, () => void readClimbs($).catch(() => undefined))
    }
    return done
  })

  on('command.run', { command: 'hills' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      await update($, isTracking, () => false)
      return { text: 'Hills stopped reading this session.' }
    }
    await update($, isTracking, () => true)
    await $.ui.open({ id: PANE, title: 'Hills' })
    if (arg === 'assess') {
      $.clock.after(0, () => void read($, hills).then(list => assessStale($, list, true)).catch(() => undefined))
      return { text: 'Asking for a fresh outside read.' }
    }
    $.clock.after(0, () => void readClimbs($, true).catch(() => undefined))
    return { text: 'Hills pane opened; reading the climb from this session.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, hills)
    const views = await read($, perspectives)
    const note = await read($, status)
    const cols = Math.max(24, Math.min(72, (e.props.bodyColumns ?? 48) - 2))
    const rows = list.length > 3 ? 4 : list.length > 1 ? 5 : 7

    const line = (segs: Seg[]) => (
      <Box flexDirection="row">
        {segs.map(s => (
          <Text color={s.color} dimColor={s.dim} bold={s.bold}>
            {s.text}
          </Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {list.length === 0 && !note && <Text dimColor>No climb found in this session yet.</Text>}
        {list.map(hill => {
          const view = views[hill.id]
          const now = best(hill)
          const change = hill.baseline === 0 ? 0 : ((now - hill.baseline) / Math.abs(hill.baseline)) * 100
          const summit = summitOf(hill, view)
          const span = summit === undefined ? 0 : summit - hill.baseline
          const pct = span ? Math.round(Math.min(1, Math.max(0, (now - hill.baseline) / span)) * 100) : undefined
          const reverted = hill.points.filter(p => !p.isKept).length
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>{hill.label}</Text>
              {drawHill(hill, view, cols, rows).map(line)}
              <Text>
                {fmt(hill.baseline, hill.unit)} → <Text bold color="green">{fmt(now, hill.unit)}</Text>{' '}
                <Text dimColor>
                  ({change >= 0 ? '+' : ''}
                  {change.toFixed(0)}%)
                </Text>
                {summit !== undefined && (
                  <Text dimColor>
                    {'  '}
                    {summit === hill.target ? 'target' : 'est. ceiling'} {fmt(summit, hill.unit)}
                  </Text>
                )}
                {pct !== undefined && <Text color="yellow"> · {pct}% of the way</Text>}
              </Text>
              <Box flexDirection="row">
                <Text dimColor>rounds </Text>
                {line(drawRounds(hill, view))}
                <Text dimColor>
                  {' '}
                  {hill.points.length - 1} tried{reverted ? `, ${reverted} reverted` : ''}
                </Text>
              </Box>
              {view && (
                <Box flexDirection="column">
                  <Text>
                    <Text bold color={view.outlook === 'more-hills' ? 'cyan' : view.outlook === 'summit' ? 'white' : 'yellow'}>
                      {OUTLOOK_TEXT[view.outlook]}
                    </Text>
                    <Text dimColor>: {view.line}</Text>
                  </Text>
                  {view.nextHills.map(idea => (
                    <Text dimColor>  ⛰ {idea}</Text>
                  ))}
                </Box>
              )}
            </Box>
          )
        })}
        {note && <Text dimColor>{note}</Text>}
        <Box flexDirection="row">
          <Button key="read" label="Re-read climb" onPress={() => void readClimbs($, true)} />
          <Text> </Text>
          <Button key="assess" label="Fresh outside read" onPress={() => void assessStale($, list, true)} />
        </Box>
      </Box>
    )
  })
}
