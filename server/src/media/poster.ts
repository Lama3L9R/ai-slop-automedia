import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { DATA_DIR } from '../env'
import { badRequest } from '../errors'

/**
 * 本地保存的封面（上传的，或者从漫画页面里选的）。
 * 文件名是 128 位随机数，地址本身就是访问凭证，所以 /api/posters/<名字> 不需要带密码 ——
 * 这样页面上能直接用 <img> 显示，浏览器也能缓存。
 */
const NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
export const POSTER_MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

export const postersDir = () => path.join(DATA_DIR, 'posters')

/** posterUrl 指向本地封面时返回它的文件名，否则 null（比如是 TMDB 的网址） */
export function localPosterName(url: string): string | null {
  const m = /^\/api\/posters\/([^/?#]+)$/.exec(url.trim())
  return m && NAME.test(m[1]) ? m[1] : null
}

export function posterPathOf(name: string): string | null {
  return NAME.test(name) ? path.join(postersDir(), name) : null
}

export function localPosterPath(url: string): string | null {
  const name = localPosterName(url)
  return name ? path.join(postersDir(), name) : null
}

/** 存一张封面，返回可以直接填进 posterUrl 的地址 */
export async function savePoster(stream: NodeJS.ReadableStream & { truncated?: boolean }, mimetype: string): Promise<string> {
  const ext = TYPES[mimetype]
  if (!ext) throw badRequest('封面只支持 JPEG / PNG / WebP')
  await fs.mkdir(postersDir(), { recursive: true })
  const name = `${randomBytes(16).toString('hex')}.${ext}`
  const file = path.join(postersDir(), name)
  await pipeline(stream, createWriteStream(file))
  if (stream.truncated) {
    await fs.rm(file, { force: true })
    throw badRequest('封面图片太大了')
  }
  return `/api/posters/${name}`
}

export async function removeLocalPoster(url: string): Promise<void> {
  const file = localPosterPath(url)
  if (file) await fs.rm(file, { force: true })
}
