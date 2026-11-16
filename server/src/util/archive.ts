import { execFile } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { extOf } from '@automedia/shared'
import yauzl from 'yauzl'
import { badRequest, errMsg } from '../errors'
import { isInside } from './fs'

const execFileP = promisify(execFile)

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

/** 遍历 zip 的每个文件条目；onEntry 返回后才读下一个 */
function eachZipEntry(
  file: string,
  onEntry: (rel: string, open: () => Promise<NodeJS.ReadableStream>) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: false }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('无法打开 zip'))
      zip.on('error', reject)
      zip.on('end', resolve)
      zip.on('entry', (entry: yauzl.Entry) => {
        const raw = entry.fileName as unknown as Buffer
        const rel = safeRel(decodeName(raw, (entry.generalPurposeBitFlag & 0x800) !== 0))
        if (!rel) return zip.readEntry()
        const open = () =>
          new Promise<NodeJS.ReadableStream>((res, rej) =>
            zip.openReadStream(entry, (e, stream) => (e || !stream ? rej(e ?? new Error('无法读取 zip 条目')) : res(stream))),
          )
        onEntry(rel, open).then(() => zip.readEntry(), reject)
      })
      zip.readEntry()
    })
  })
}

function extractZip(file: string, dest: string): Promise<void> {
  return eachZipEntry(file, async (rel, open) => {
    const out = path.join(dest, rel)
    if (!isInside(out, dest)) return
    await fs.mkdir(path.dirname(out), { recursive: true })
    await pipeline(await open(), createWriteStream(out))
  })
}

/** 不解压，只列出 zip 里的文件（相对路径，/ 分隔） */
export async function zipEntryNames(file: string): Promise<string[]> {
  const names: string[] = []
  await eachZipEntry(file, async (rel) => void names.push(rel))
  return names
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
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

const ZIP_LIKE = new Set(['zip', 'cbz'])
export const isZipLike = (name: string) => ZIP_LIKE.has(extOf(name))

/** 解压到 dest。zip / cbz 自己解（能处理 GBK 文件名），其余交给 bsdtar。name 只用于报错信息。 */
export async function extractArchive(file: string, name: string, dest: string): Promise<void> {
  if (isZipLike(name)) {
    try {
      await extractZip(file, dest)
    } catch (e) {
      throw badRequest(`解压 ${name} 失败：${errMsg(e)}`)
    }
  } else await extractWithTar(file, name, dest)
}
