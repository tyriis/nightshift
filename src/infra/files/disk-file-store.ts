import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FileRef, FileStore } from '#root/application/ports'

/** D-s: `<root>/<sha[0:2]>/<sha>` with tmp+rename — no partial reads, content dedupe. */
export class DiskFileStore implements FileStore {
  constructor(readonly dir: string) {}

  async put(content: Uint8Array): Promise<FileRef> {
    const sha256 = createHash('sha256').update(content).digest('hex')
    const target = this.pathFor(sha256)
    const tmp = join(dirname(target), `.${sha256}.${randomUUID()}.tmp`)
    try {
      await readFile(target)
      return { sha256, bytes: content.byteLength } // already stored — idempotent (D-s)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(tmp, content)
    await rename(tmp, target)
    return { sha256, bytes: content.byteLength }
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.pathFor(sha256))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  private pathFor(sha256: string): string {
    // traversal defense: our own address grammar is the ONLY grammar accepted
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`invalid content address '${sha256}' (expected lowercase sha256 hex)`)
    }
    return join(this.dir, sha256.slice(0, 2), sha256)
  }
}
