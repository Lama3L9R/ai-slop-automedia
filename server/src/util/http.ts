import { ProxyAgent, fetch as undiciFetch, type RequestInit, type Response } from 'undici'
import { getSettings } from '../settings'

let cached: { url: string; agent: ProxyAgent } | undefined

/** 访问外网（TMDB / AI / 图片）用的 fetch：按设置走代理，默认 30 秒超时 */
export async function extFetch(url: string | URL, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init
  const proxy = getSettings().proxyUrl.trim()
  let dispatcher: ProxyAgent | undefined
  if (proxy) {
    if (cached?.url !== proxy) cached = { url: proxy, agent: new ProxyAgent(proxy) }
    dispatcher = cached.agent
  }
  return undiciFetch(url, { ...rest, dispatcher, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) })
}
