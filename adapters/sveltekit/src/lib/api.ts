// api.ts — the single UI⇄API seam: cookies ride same-origin; session-bound CSRF
// companion mirrors into the header (D-rr); 401 bounces to the login view.
import { browser } from '$app/environment'

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(`${code}: ${detail}`)
  }
}

const cookieValue = (name: string): string | null => {
  if (!browser) return null
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null
}

export const csrfToken = (): string | null => cookieValue('__Host-ns_csrf')

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  if (!['GET', 'HEAD'].includes(method)) {
    const token = csrfToken()
    if (token) headers.set('x-csrf-token', token) // D-rr mirror
  }
  headers.set('accept', 'application/json')
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers })
  if (res.status === 401 && browser) {
    location.assign(`/ui/login?returnTo=${encodeURIComponent(location.pathname)}`)
    throw new ApiError('unauthenticated', 401, 'session expired — signing in again')
  }
  const body = (
    res.status === 204 ? null : ((await res.json()) as T & { code?: string; detail?: string })
  ) as T
  if (!res.ok) {
    const b = (body ?? {}) as { code?: string; detail?: string }
    throw new ApiError(b.code ?? 'internal_error', res.status, b.detail ?? res.statusText)
  }
  return body as T
}

// JSON mutation helper: callers pass plain objects; identity stays server-side
// (the hook knows who you are — bodies never carry actor fields).
export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
