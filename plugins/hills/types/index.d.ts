export type HillsPoint = {
  round: string
  value: number
  isKept: boolean
  note?: string
}

export type HillsHill = {
  id: string
  label: string
  unit?: string
  direction: 'higher' | 'lower'
  baseline: number
  target?: number
  points: HillsPoint[]
  context?: string
  signature: string
}

export type HillsOutlook = 'climbing' | 'slowing' | 'summit' | 'more-hills'

export type HillsPerspective = {
  outlook: HillsOutlook
  ceiling?: number
  line: string
  nextHills: string[]
  signature: string
}

declare module 'claude-code' {
  interface PluginState {
    hills: {
      hills: HillsHill[]
      perspectives: Record<string, HillsPerspective>
      isTracking: boolean
      status: string | null
    }
  }
}
