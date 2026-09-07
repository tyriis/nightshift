import { describe, expect, it } from 'vitest'
import { TASK_STATUSES } from '#root/domain/task'

describe('task statuses', () => {
  it('matches the spec §6.1 set in canonical order', () => {
    expect(TASK_STATUSES).toEqual([
      'backlog',
      'todo',
      'in_progress',
      'in_review',
      'done',
      'canceled',
    ])
  })
})
