import type { ApiErrorPayload } from '../types/api'

export const AUTH_TOKEN_KEY = 'flowchain:auth-token'
export const CURRENT_USER_KEY = 'flowchain:current-user'
const LEGACY_AUTH_TOKEN_KEY = 'scm-demo-token'
const LEGACY_CURRENT_USER_KEY = 'scm-demo-user'

export function migrateLegacySessionStorage(storage: Storage = localStorage) {
  const currentToken = storage.getItem(AUTH_TOKEN_KEY)
  const currentUser = storage.getItem(CURRENT_USER_KEY)
  const legacyToken = storage.getItem(LEGACY_AUTH_TOKEN_KEY)
  const legacyUser = storage.getItem(LEGACY_CURRENT_USER_KEY)
  if (!currentToken && legacyToken) storage.setItem(AUTH_TOKEN_KEY, legacyToken)
  if (!currentUser && legacyUser) storage.setItem(CURRENT_USER_KEY, legacyUser)
  try {
    const candidate = JSON.parse(storage.getItem(CURRENT_USER_KEY) || 'null')
    if (candidate?.name === '张磊' && candidate?.email === 'zhanglei@example.com') {
      storage.removeItem(AUTH_TOKEN_KEY)
      storage.removeItem(CURRENT_USER_KEY)
    }
  } catch { /* Ignore malformed legacy session storage. */ }
  storage.removeItem(LEGACY_AUTH_TOKEN_KEY)
  storage.removeItem(LEGACY_CURRENT_USER_KEY)
}

export class ApiError extends Error {
  status: number
  code?: string
  details: Array<Record<string, unknown>>
  entityId?: string
  currentStatus?: string
  currentVersion?: number
  expectedVersion?: number
  payload: ApiErrorPayload

  constructor(status: number, payload: ApiErrorPayload, fallback: string) {
    super(payload.message || payload.error || fallback)
    this.name = 'ApiError'; this.status = status; this.payload = payload; this.code = payload.code
    this.details = Array.isArray(payload.details) ? payload.details : []
    this.entityId = payload.entityId; this.currentStatus = payload.currentStatus
    this.currentVersion = payload.currentVersion; this.expectedVersion = payload.expectedVersion
  }
}

if (typeof window !== 'undefined') migrateLegacySessionStorage(window.localStorage)

// The signed-in request, as apiJson sends it, for a caller that reads the
// response itself (the assistant's progress stream).
export function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const token = typeof window !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_KEY) || '' : ''
  return fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options?.headers ?? {}) } })
}

export async function apiErrorFrom(res: Response): Promise<ApiError> {
  const raw = await res.text(); let payload: ApiErrorPayload = { error: raw }
  try { payload = JSON.parse(raw) as ApiErrorPayload } catch { /* Preserve plain-text server errors. */ }
  return new ApiError(res.status, payload, raw || `API request failed: ${res.status}`)
}

export async function apiJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await apiFetch(url, options)
  if (!res.ok) throw await apiErrorFrom(res)
  if (res.status === 204) return undefined as T
  return res.json()
}
