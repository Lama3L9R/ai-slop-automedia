import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'

/**
 * 打一个 cbz：图片按给定顺序、用补零的序号命名，最后放 ComicInfo.xml。
 * 图片本身已经是压缩格式，所以只存储不再压缩（快，而且体积几乎一样）。
 * 先写到临时文件再改名，读的人（Emby）不会看到写了一半的包。
 */
export async function buildCbz(dest: string, comicInfo: string, pages: { source: string; name: string }[]): Promise<void> {
  // 先确认源文件都在：yazl 遇到缺文件是异步报错，提前查能给出明确的信息
  for (const p of pages)
    await fs.access(p.source).catch(() => {
      throw new Error(`源文件不存在：${p.source}`)
    })
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.building`
  const zip = new yazl.ZipFile()
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject)
      pipeline(zip.outputStream, createWriteStream(tmp)).then(resolve, reject)
      for (const p of pages) zip.addFile(p.source, p.name, { compress: false })
      zip.addBuffer(Buffer.from(comicInfo, 'utf8'), 'ComicInfo.xml')
      zip.end()
    })
    await fs.rename(tmp, dest)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}
