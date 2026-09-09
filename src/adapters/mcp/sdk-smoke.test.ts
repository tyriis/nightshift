import { describe, expect, it } from 'vitest'

describe('mcp sdk v2 import surface', () => {
  it('serves the server symbols from the root barrel (D-hh: v2 root works; v1 did not)', async () => {
    const server = await import('@modelcontextprotocol/server')
    expect(typeof server.McpServer).toBe('function')
    expect(typeof server.createMcpHandler).toBe('function')
  })

  it('serves the client + transports from the client root', async () => {
    const client = await import('@modelcontextprotocol/client')
    expect(typeof client.Client).toBe('function')
    expect(typeof client.StreamableHTTPClientTransport).toBe('function')
    expect(typeof client.InMemoryTransport.createLinkedPair).toBe('function')
  })
})
