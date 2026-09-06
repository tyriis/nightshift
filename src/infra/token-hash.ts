import { createHash, randomBytes } from 'node:crypto'

export const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex')

export const generateRawToken = (): string => randomBytes(32).toString('base64url')
