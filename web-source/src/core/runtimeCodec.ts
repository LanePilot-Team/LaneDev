/** JSON cannot preserve Map/Set (Lane Base movement policies use both). */
export const runtimeReplacer = (_key: string, value: unknown): unknown =>
  value instanceof Map ? { $runtime: 'Map', entries: [...value] }
    : value instanceof Set ? { $runtime: 'Set', entries: [...value] } : value

export const runtimeReviver = (_key: string, value: any): unknown => {
  if (value?.$runtime === 'Map') return new Map(value.entries)
  if (value?.$runtime === 'Set') return new Set(value.entries)
  return value
}

export const RUNTIME_FORMAT = 'lanedev-precomputed-v1'
