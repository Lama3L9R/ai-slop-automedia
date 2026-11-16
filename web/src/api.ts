import { createSignal } from 'solid-js'

const KEY = 'automedia.password'

function stored(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

/** 访问密码：存在浏览器本地，每个请求作为 Bearer token 带上 */
export const [password, setPasswordSignal] = createSignal(stored())

export function setPassword(pw: string) {
  try {
    if (pw) localStorage.setItem(KEY, pw)
    else localStorage.removeItem(KEY)
  } catch {
    /* 无痕模式等：只保留在内存里 */
  }
  setPasswordSignal(pw)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | undefined>
  /** 用指定密码而不是已保存的（登录校验时用） */
  auth?: string
}

function buildUrl(path: string, query?: Options['query']): string {
  const url = new URL('/api' + path, location.origin)
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
  return url.toString()
}

async function handle<T>(res: Response, isLogin: boolean): Promise<T> {
  const data = await res.json().catch(() => null)
  if (res.status === 401) {
    if (!isLogin) setPassword('')
    throw new ApiError(401, '密码不正确')
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `请求失败（HTTP ${res.status}）`)
  return data as T
}

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: {
      authorization: `Bearer ${opts.auth ?? password()}`,
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return handle<T>(res, opts.auth !== undefined)
}

/** 带着访问密码取一个文件（<img> 没法带请求头，所以页面预览走这里再转成 blob URL） */
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(buildUrl(path), { headers: { authorization: `Bearer ${password()}` } })
  if (res.status === 401) {
    setPassword('')
    throw new ApiError(401, '密码不正确')
  }
  if (!res.ok) throw new ApiError(res.status, `请求失败（HTTP ${res.status}）`)
  return res.blob()
}

export async function upload<T>(path: string, files: File[], query?: Options['query']): Promise<T> {
  const form = new FormData()
  for (const f of files) form.append('files', f, f.name)
  const res = await fetch(buildUrl(path, query), {
    method: 'POST',
    headers: { authorization: `Bearer ${password()}` },
    body: form,
  })
  return handle<T>(res, false)
}
