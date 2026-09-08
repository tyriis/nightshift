import { createHash, randomBytes } from 'node:crypto'

export const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex')

export const generateRawToken = (): string => randomBytes(32).toString('base64url')

/**
 * Webhook HMAC signing key (D-ff). Same 256-bit strength as agent tokens, but
 * stored PLAINTEXT by design: it is a signing key the delivery loop must re-read,
 * not a lookup secret that could be hashed. generate === raw-token form on purpose.
 */
export const generateWebhookSecret = (): string => randomBytes(32).toString('base64url')
