import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { extOf, naturalCompare } from '@automedia/shared'
import { badRequest } from '../errors'
import { sanitizeName } from '../media/layout'
import { getMedia } from '../media/store'
import { getSettings } from '../settings'
import { extractArchive } from '../util/archive'
import { exists } from '../util/fs'

const UNSORTED = '_未分类'

function subtitleRoot(): string {
  const dir = getSettings().subtitleDir.trim()
  if (!dir) throw badRequest('还没有配置字幕存放目录（设置 → 基本）')
  return path.resolve(dir)
}

const ARCHIVE_EXT = new Set(['zip', '7z', 'rar'])

// ───────────────────────── 上传 ─────────────────────────

async function uniqueDir(base: string): Promise<string> {
  let dir = base
  for (let i = 2; await exists(dir); i++) dir = `${base} (${i})`
  return dir
}

export interface UploadPart {
  filename: string
  file: NodeJS.ReadableStream & { truncated?: boolean }
}

/**
 * 接收上传的压缩包 / 零散字幕文件，存到 <字幕目录>/<Media 标题>/<批次名>/ 下。
 * 返回批次目录，前端拿它当作一个「目录来源」打开导入向导。
 */
export async function saveUpload(parts: AsyncIterable<UploadPart>, mediaId?: number): Promise<{ path: string }> {
  const root = subtitleRoot()
  const mediaName = mediaId ? sanitizeName(getMedia(mediaId).title) : UNSORTED
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'automedia-upload-'))
  try {
    const received: { name: string; tmpPath: string }[] = []
    for await (const part of parts) {
      const name = sanitizeName(path.basename(part.filename.replace(/\\/g, '/')))
      const tmpPath = path.join(tmp, String(received.length))
      await pipeline(part.file, createWriteStream(tmpPath))
      if (part.file.truncated) throw badRequest(`${name} 超过了大小上限`)
      received.push({ name, tmpPath })
    }
    if (!received.length) throw badRequest('没有收到文件')

    const batchName = received[0].name.replace(/\.[^.]+$/, '') || 'upload'
    const batchDir = await uniqueDir(path.join(root, mediaName, batchName))
    await fs.mkdir(batchDir, { recursive: true })
    const archives = received.filter((r) => ARCHIVE_EXT.has(extOf(r.name)))
    try {
      for (const r of received) {
        if (ARCHIVE_EXT.has(extOf(r.name))) {
          // 只有一个压缩包时直接解到批次目录，多个时各解到自己的子目录
          const dest =
            archives.length === 1 && received.length === 1
              ? batchDir
              : path.join(batchDir, r.name.replace(/\.[^.]+$/, ''))
          await extractArchive(r.tmpPath, r.name, dest)
        } else await fs.copyFile(r.tmpPath, path.join(batchDir, r.name))
      }
    } catch (e) {
      await fs.rm(batchDir, { recursive: true, force: true })
      throw e
    }
    return { path: batchDir }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

export interface UploadBatch {
  media: string
  name: string
  path: string
  mtime: number
}

/** 列出字幕目录下已有的批次（两层目录：Media / 批次） */
export async function listUploads(): Promise<UploadBatch[]> {
  const dir = getSettings().subtitleDir.trim()
  if (!dir) return []
  const root = path.resolve(dir)
  const out: UploadBatch[] = []
  const subdirs = async (p: string) =>
    (await fs.readdir(p, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  for (const m of await subdirs(root)) {
    for (const b of await subdirs(path.join(root, m.name))) {
      const full = path.join(root, m.name, b.name)
      const st = await fs.stat(full).catch(() => null)
      out.push({ media: m.name, name: b.name, path: full, mtime: st?.mtimeMs ?? 0 })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime || naturalCompare(a.name, b.name))
}
