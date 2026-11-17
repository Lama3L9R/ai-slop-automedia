import { upload } from './api'

/**
 * 把任意图片缩成封面大小的 JPEG（最大 1200×1800，不放大）。
 * 在浏览器里做，服务端就不需要图像处理库；漫画页动辄几 MB，直接当封面列表会很卡。
 */
export async function toPosterBlob(src: Blob, maxW = 1200, maxH = 1800): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(src)
  } catch {
    throw new Error('浏览器读不了这张图片（格式不支持？）')
  }
  const scale = Math.min(1, maxW / bitmap.width, maxH / bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('无法处理这张图片'))), 'image/jpeg', 0.9),
  )
}

/** 缩小后上传为某个媒体的封面，返回新的 posterUrl */
export async function uploadCover(mediaId: number, src: Blob): Promise<string> {
  const blob = await toPosterBlob(src)
  const res = await upload<{ posterUrl: string }>(`/media/${mediaId}/poster`, [
    new File([blob], 'cover.jpg', { type: 'image/jpeg' }),
  ])
  return res.posterUrl
}
