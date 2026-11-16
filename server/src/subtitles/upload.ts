import { execFile } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { extOf, naturalCompare } from '@automedia/shared'
import yauzl from 'yauzl'
import { badRequest, errMsg } from '../errors'
import { sanitizeName } from '../media/layout'
import { getMedia } from '../media/store'
import { getSettings } from '../settings'
import { exists, isInside } from '../util/fs'

const execFileP = promisify(execFile)
const UNSORTED = '_未分类'

function subtitleRoot(): string {
  const dir = getSettings().subtitleDir.trim()
  if (!dir) throw badRequest('还没有配置字幕存放目录（设置 → 基本）')
  return path.resolve(dir)
}

// ───────────────────────── 解压 ─────────────────────────

/** 中文 Windows 打的 zip 文件名常是 GBK 且不带 UTF-8 标记，这里按「标记 → 严格 UTF-8 → GBK」依次尝试 */
function decodeName(raw: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return raw.toString('utf8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    try {
      return new TextDecoder('gbk').decode(raw)
    } catch {
      return raw.toString('latin1')
    }
  }
}

/** 压缩包内路径 → 安全的相对路径；目录项、垃圾文件、越界路径返回 null */
function safeRel(name: string): string | null {
  const parts = name.replace(/\\/g, '/').split('/').filter(Boolean)
  if (name.endsWith('/') || !parts.length) return null
  if (parts.some((p) => p === '..' || p === '.' || /^[a-zA-Z]:$/.test(p))) return null
  if (parts[0] === '__MACOSX' || parts.at(-1) === '.DS_Store' || parts.at(-1)!.startsWith('._')) return null
  return parts.map((p) => p.replace(/[:*?"<>|\u0000-\u001f]/g, '_')).join('/')
}

function extractZip(file: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: false }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('无法打开 zip'))
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', (entry: yauzl.Entry) => {
        const raw = entry.fileName as unknown as Buffer
        const rel = safeRel(decodeName(raw, (entry.generalPurposeBitFlag & 0x800) !== 0))
        if (!rel) return zip.readEntry()
        const out = path.join(dest, rel)
        if (!isInside(out, dest)) return zip.readEntry()
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error('无法读取 zip 条目'))
          fs.mkdir(path.dirname(out), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(out)))
            .then(() => zip.readEntry(), reject)
        })
      })
      zip.readEntry()
    })
  })
}

/** 7z / rar 交给系统自带的 bsdtar（macOS 的 /usr/bin/tar、Windows 的 System32\tar.exe 都是） */
async function extractWithTar(file: string, name: string, dest: string): Promise<void> {
  const candidates =
    process.platform === 'win32'
      ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')]
      : ['/usr/bin/bsdtar', '/usr/bin/tar', 'tar']
  const bin = candidates.find((c) => !path.isAbsolute(c) || existsSync(c)) ?? 'tar'
  // 先解到压缩包旁边的临时目录，再由 Node 搬到目标位置：
  // 命令行参数里只出现相对路径，避开 Windows 版 bsdtar 处理不了非 ASCII 路径的问题。
  const staging = `${file}.extract`
  await fs.mkdir(staging, { recursive: true })
  try {
    await execFileP(bin, ['-xf', path.join('..', path.basename(file))], { cwd: staging })
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim()
    throw badRequest(`解压 ${name} 失败（7z / rar 依赖系统自带的 bsdtar）：${stderr || errMsg(e)}`)
  }
  await fs.mkdir(dest, { recursive: true })
  await fs.cp(staging, dest, {
    recursive: true,
    // 压缩包里的符号链接可能指向任何地方，一律不要
    filter: async (src) => !(await fs.lstat(src)).isSymbolicLink() && path.basename(src) !== '__MACOSX',
  })
}

const ARCHIVE_EXT = new Set(['zip', '7z', 'rar'])

async function extract(file: string, name: string, dest: string): Promise<void> {
  if (extOf(name) === 'zip') {
    try {
      await extractZip(file, dest)
    } catch (e) {
      throw badRequest(`解压 ${name} 失败：${errMsg(e)}`)
    }
  } else await extractWithTar(file, name, dest)
}

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
          await extract(r.tmpPath, r.name, dest)
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
