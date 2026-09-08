import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskFileStore } from '#root/infra/files/disk-file-store'

const setup = async () => new DiskFileStore(await mkdtemp(join(tmpdir(), 'ns-store-')))

describe('DiskFileStore (D-s)', () => {
  it('content-addressed put is idempotent and round-trips', async () => {
    const store = await setup()
    const data = new TextEncoder().encode('spec body')
    const a = await store.put(data)
    const b = await store.put(data)
    expect(b).toEqual(a)
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    const back = await store.get(a.sha256)
    expect(new TextDecoder().decode(back!)).toBe('spec body')
    // two-hex shard dir only, single blob despite two puts
    const shards = await readdir(store.dir)
    expect(shards).toEqual([a.sha256.slice(0, 2)])
    // tmp hygiene: the shard dir holds ONLY the final blob (rename, no .tmp residue)
    expect(await readdir(join(store.dir, a.sha256.slice(0, 2)))).toEqual([a.sha256])
  })

  it('different bytes → distinct addresses, both blobs present', async () => {
    const store = await setup()
    const a = await store.put(new TextEncoder().encode('one'))
    const b = await store.put(new TextEncoder().encode('two'))
    expect(a.sha256).not.toBe(b.sha256)
    expect(a.bytes).toBe(3)
    expect(new TextDecoder().decode((await store.get(a.sha256))!)).toBe('one')
    expect(new TextDecoder().decode((await store.get(b.sha256))!)).toBe('two')
  })

  it('get of an unknown address → null (ENOENT), never a throw', async () => {
    const store = await setup()
    expect(await store.get('ab'.repeat(32))).toBeNull()
  })

  it('a corrupted store (address path is a directory) surfaces the fs error, never a null lie', async () => {
    const store = await setup()
    const sha = 'ab'.repeat(32)
    await mkdir(join(store.dir, sha.slice(0, 2), sha), { recursive: true }) // blob slot is a dir
    await expect(store.get(sha)).rejects.toThrow() // EISDIR — not ENOENT, so get rethrows
    // put takes the same re-throw path when the exists-probe hits a non-ENOENT error
    const probe = new TextEncoder().encode('probe')
    const probeSha = createHash('sha256').update(probe).digest('hex')
    await mkdir(join(store.dir, probeSha.slice(0, 2), probeSha), { recursive: true })
    await expect(store.put(probe)).rejects.toThrow()
  })

  it('rejects malformed content addresses (path traversal defense)', async () => {
    const store = await setup()
    await expect(store.get('../../etc/passwd')).rejects.toThrow(/content address/i)
    await expect(store.get('A'.repeat(64))).rejects.toThrow(/content address/i) // uppercase not our alphabet
  })
})
