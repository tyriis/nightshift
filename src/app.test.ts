import { describe, expect, it } from 'vitest'
import { buildApp } from '#root/app'

describe('app', () => {
  it('answers ping', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/ping' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ pong: 'it worked!' })
    await app.close()
  })
})
