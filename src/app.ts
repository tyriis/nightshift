import Fastify, { FastifyInstance } from 'fastify'

export const buildApp = (opts: { logger?: boolean } = {}): FastifyInstance => {
  const server: FastifyInstance = Fastify({ logger: opts.logger ?? false })

  server.get('/ping', () => {
    return { pong: 'it worked!' }
  })

  return server
}
