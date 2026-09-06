export interface LeaseTokenRef {
  taskId: string
  generation: number
}

export const formatLeaseToken = (taskId: string, generation: number): string =>
  `${taskId}:${generation}`

export const parseLeaseToken = (raw: unknown): LeaseTokenRef | null => {
  if (typeof raw !== 'string') return null
  const idx = raw.lastIndexOf(':')
  if (idx <= 0) return null
  const taskId = raw.slice(0, idx)
  const gen = raw.slice(idx + 1)
  if (!/^\d+$/.test(gen)) return null
  return { taskId, generation: Number(gen) }
}
