import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HillsHill, HillsOutlook, HillsPerspective, HillsPoint } from '../types'

// The mod reads no files. After each turn it forks the session's own
// transcript and asks what is being climbed, so any hillclimb counts, however
// its numbers were measured or logged. A second, history-free model call then
// gives the outside read on how much higher there is to go.

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
    short: (str(raw.short) ?? str(raw.label) ?? id).slice(0, 5),
    unit: str(raw.unit),
    direction: raw.direction === 'lower' ? 'lower' : 'higher',
    baseline,
    target: num(raw.target),
    points,
    context: str(raw.context),
    signature: points.map(p => `${p.round}=${p.value}${p.isKept ? '' : 'x'}`).join(','),
  }
}

const extractPrompt = (prior: HillsHill[]) => `Set the task aside for one reply. A progress display above the prompt needs data.

Look back over this whole conversation for hillclimbing: repeated attempts to move a measurable metric (an image size, a build or boot time, a latency, a pass rate, a bundle size, a cost, an error count) where each attempt is measured and kept or reverted.

Reply with JSON only, no prose:
{"climbs": [{
  "id": "short-kebab-id",
  "label": "what the metric is, under 5 words",
  "short": "one word or acronym of at most 5 characters the person would recognize, unique among the climbs (img, web, boot, cov)",
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

type Seg = { text: string; color?: string; dim?: boolean }

const HILL_CELLS = 7 // each cell is 2 dots wide, so 14 dot columns
const HILL_DOTS = 8 // two rows of 4 dots
const PEAK = 10 // dot column of the summit
const GAP = 2
const CARD_WIDTH = 46

const smooth = (t: number) => t * t * (3 - 2 * t)

// Dot height of the hill at dot column x: a gradual climb to the summit, then a short drop.
const dotsAt = (x: number) =>
  x <= PEAK
    ? Math.round(1 + (HILL_DOTS - 1) * smooth(x / PEAK))
    : Math.round(HILL_DOTS - 2.5 * smooth((x - PEAK) / (HILL_CELLS * 2 - 1 - PEAK)))

// Braille bits for dot row 0-3 (top to bottom) in the left and right column of a cell.
const LEFT = [0x01, 0x02, 0x04, 0x40]
const RIGHT = [0x08, 0x10, 0x20, 0x80]

const progressOf = (hill: HillsHill, view?: HillsPerspective) => {
  const summit = summitOf(hill, view)
  if (summit === undefined) return undefined
  const span = summit - hill.baseline
  return span === 0 ? 1 : Math.min(1, Math.max(0, (best(hill) - hill.baseline) / span))
}

// Two rows of braille cells. Climbed dot columns are solid; the rest of the hill is
// only its outline, so the climber moves one dot column at a time though a cell has one color.
const drawMini = (hill: HillsHill, view?: HillsPerspective): Seg[][] => {
  const progress = progressOf(hill, view) ?? 0.5
  const climbed = Math.round(progress * PEAK)
  const rows: Seg[][] = [[], []]
  for (let row = 0; row < 2; row++) {
    for (let cell = 0; cell < HILL_CELLS; cell++) {
      let bits = 0
      for (const [side, x] of [[LEFT, cell * 2], [RIGHT, cell * 2 + 1]] as const) {
        const height = dotsAt(x)
        for (let dot = 0; dot < 4; dot++) {
          const fromBottom = (1 - row) * 4 + (3 - dot)
          const isShown = x <= climbed ? fromBottom < height : fromBottom === height - 1
          if (isShown) bits |= side[dot]!
        }
      }
      const isClimbed = cell * 2 <= climbed
      rows[row]!.push({ text: String.fromCharCode(0x2800 + bits), color: isClimbed ? 'green' : 'gray', dim: !isClimbed })
    }
  }
  // A faint next hill when the outside read sees more to climb past this one.
  if (view?.outlook === 'more-hills') {
    rows[0]!.push({ text: ' ' })
    rows[1]!.push({ text: '⣠⣴', color: 'blue', dim: true })
  }
  return rows
}

// Kept rounds green, reverted red, one sparkline cell each.
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const drawRounds = (hill: HillsHill, view?: HillsPerspective): Seg[] => {
  const summit = summitOf(hill, view) ?? best(hill)
  const span = summit - hill.baseline || 1
  return hill.points.map(p => {
    const t = Math.min(1, Math.max(0, (p.value - hill.baseline) / span))
    return { text: SPARK[Math.round(t * 7)]!, color: p.isKept ? 'green' : 'red' }
  })
}

const wrap = (text: string, width: number) => {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

const OUTLOOK_TEXT: Record<HillsOutlook, string> = {
  climbing: 'Still climbing',
  slowing: 'Leveling off',
  summit: 'At the top of this hill',
  'more-hills': 'Higher hills past this one',
}

// The hover card's lines, so its height is known before it is placed.
const cardLines = (hill: HillsHill, view?: HillsPerspective): Seg[][] => {
  const inner = CARD_WIDTH - 4
  const now = best(hill)
  const summit = summitOf(hill, view)
  const progress = progressOf(hill, view)
  const tried = hill.points.length - 1
  const reverted = hill.points.filter(p => !p.isKept).length
  const lines: Seg[][] = [
    [{ text: hill.label }],
    [
      { text: `${fmt(hill.baseline, hill.unit)} → ` },
      { text: fmt(now, hill.unit), color: 'green' },
      ...(progress !== undefined ? [{ text: `  ${Math.round(progress * 100)}% up`, color: 'yellow' }] : []),
    ],
    ...(summit !== undefined
      ? [[{ text: `${summit === hill.target ? 'target' : 'est. ceiling'} ${fmt(summit, hill.unit)}`, dim: true }]]
      : []),
    [
      { text: 'rounds ', dim: true },
      ...drawRounds(hill, view),
      { text: ` ${tried} tried${reverted ? `, ${reverted} reverted` : ''}`, dim: true },
    ],
  ]
  if (view) {
    lines.push([{ text: OUTLOOK_TEXT[view.outlook], color: view.outlook === 'more-hills' ? 'cyan' : 'yellow' }])
    for (const l of wrap(view.line, inner)) lines.push([{ text: l, dim: true }])
    for (const idea of view.nextHills) lines.push([{ text: `⛰ ${idea}`.slice(0, inner), dim: true }])
  }
  return lines
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hills',
      description: 'Read the hillclimb now (/hills assess for a fresh outside read, /hills off to stop)',
    })
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
      return { text: 'Hills hidden and stopped reading this session.' }
    }
    await update($, isTracking, () => true)
    if (arg === 'assess') {
      $.clock.after(0, () => void read($, hills).then(list => assessStale($, list, true)).catch(() => undefined))
      return { text: 'Asking for a fresh outside read.' }
    }
    $.clock.after(0, () => void readClimbs($, true).catch(() => undefined))
    return { text: 'Reading the climb from this session.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, hills)
    if (e.props.hasSurvey || list.length === 0 || !(await read($, isTracking))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const views = await read($, perspectives)
    const note = await read($, status)
    const width = HILL_CELLS + 2 + GAP
    const fits = Math.max(1, Math.floor((e.props.bodyColumns - 2) / width))

    const row = (segs: Seg[]) => (
      <Box flexDirection="row">
        {segs.map(s => (
          <Text color={s.color} dimColor={s.dim}>
            {s.text}
          </Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="row" columnGap={GAP}>
        {list.slice(0, fits).map((hill, i) => {
          const view = views[hill.id]
          const card = cardLines(hill, view)
          const x = i * width
          return (
            <Box key={`hill-${hill.id}`} flexDirection="column" width={width - GAP}>
              {drawMini(hill, view).map(row)}
              <Text dimColor wrap="truncate">
                {hill.short}
              </Text>
              <Box
                position="absolute"
                top={-(card.length + 2)}
                left={Math.min(0, e.props.bodyColumns - x - CARD_WIDTH)}
                width={CARD_WIDTH}
                display="none"
                hover={{ display: 'flex' }}
                flexDirection="column"
                borderStyle="round"
                borderColor="gray"
                paddingX={1}
              >
                {card.map(row)}
              </Box>
            </Box>
          )
        })}
        {note && (
          <Text dimColor wrap="truncate">
            {note}
          </Text>
        )}
      </Box>
    )
  })
}
