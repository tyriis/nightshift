const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export class RandomIdGen {
  newId(prefix: string): string {
    // Plan said `globalThis.crypto.randomBytes(16)`; that WebCrypto method does not
    // exist on Node's global `crypto` (verified undefined on the runtime executing the
    // tests). `getRandomValues` is the standard WebCrypto CSPRNG and keeps the plan's
    // intent (WebCrypto for ids) identical in distribution and output format.
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    let out = ''
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
    return `${prefix}_${out}`
  }
}
