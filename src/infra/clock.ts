export class SystemClock {
  now(): Date {
    return new Date()
  }
}

export const isoNow = (clock: { now(): Date } = new SystemClock()): string =>
  clock.now().toISOString()
