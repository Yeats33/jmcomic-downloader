export function imageStrips(height: number, blocks: number) {
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > height) throw new Error('图片分块信息无效')
  const step = Math.floor(height / blocks)
  const remainder = height % blocks
  return Array.from({ length: blocks }, (_, index) => ({
    sourceY: height - step * (index + 1) - remainder,
    targetY: step * index + (index === 0 ? 0 : remainder),
    height: step + (index === 0 ? remainder : 0),
  }))
}

export async function onlineImageUrl(parts: readonly Uint8Array[], mime: string, blocks: number): Promise<string> {
  const blob = new Blob([...parts], { type: mime })
  if (blocks === 0 || mime === 'image/gif') return URL.createObjectURL(blob)
  const image = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('无法还原在线图片')
    for (const strip of imageStrips(image.height, blocks)) {
      context.drawImage(image, 0, strip.sourceY, image.width, strip.height, 0, strip.targetY, image.width, strip.height)
    }
    const restored = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result === null) reject(new Error('图片还原失败'))
        else resolve(result)
      }, 'image/png')
    })
    return URL.createObjectURL(restored)
  } finally {
    image.close()
  }
}
