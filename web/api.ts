async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) }, ...options })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message || '请求失败')
  return body as T
}
export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  delete: <T = unknown>(path: string) => request<T>(path, { method: 'DELETE' }),
}
