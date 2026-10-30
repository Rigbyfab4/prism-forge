// What `prism-forge status` last reported; 'unknown' until it has run
export type PrismState = 'on' | 'off' | 'missing' | 'unknown'

// A switch made this session that the model hasn't been told about yet
export type PrismNotice = 'on' | 'off' | null

declare module 'claude-code' {
  interface PluginState {
    'prism-toggle': {
      state: PrismState
      isBusy: boolean
      pending: PrismNotice
      // Whether PRISM was switched in this session, so the loaded CLAUDE.md may be stale
      hasSwitched: boolean
    }
  }
}
