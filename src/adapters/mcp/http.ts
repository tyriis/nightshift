// src/adapters/mcp/http.ts — Node http ⇄ Web Request/Response, probed end-to-end (D-hh)
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { FastifyReply, FastifyRequest } from 'fastify'

const HOP_BY_HOP = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'host',
  'expect',
])

// ALL non-hop-by-hop headers forward verbatim — the 2026-07-28 leg enforces the
// Mcp-Method/Mcp-Name header⇄body mirror; allow-lists break it (probed).
export const webRequestFromFastify = (
  req: FastifyRequest,
  rawBody: Uint8Array | undefined
): Request => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }
  const isBodyless = req.method === 'GET' || req.method === 'HEAD'
  // Buffer ⇄ BodyInit gap under @types/node: the cast is a type lie, bytes ride intact.
  const body: BodyInit | undefined = isBodyless
    ? undefined
    : ((rawBody ?? new Uint8Array(0)) as unknown as BodyInit)
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method: req.method,
    headers,
    body,
  })
}

export const writeWebResponseToFastify = async (
  webRes: Response,
  reply: FastifyReply
): Promise<void> => {
  const raw = reply.raw
  const headers: Record<string, string | string[]> = {}
  webRes.headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'set-cookie') headers[name] = value
  })
  const setCookie = webRes.headers.getSetCookie()
  if (setCookie.length > 0) headers['set-cookie'] = setCookie
  raw.writeHead(webRes.status, headers)
  if (!webRes.body) {
    raw.end()
    return
  }
  // pipe honors backpressure — required if a handler ever upgrades to SSE (probed).
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(webRes.body as unknown as NodeReadableStream<Uint8Array>)
      .on('error', reject)
      .on('end', resolve)
      .pipe(raw)
  })
}
