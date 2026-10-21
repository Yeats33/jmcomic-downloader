import { Channel } from '@tauri-apps/api/core'
import { onUnmounted, ref } from 'vue'
import { commands } from '../bindings.ts'
import type { OnlinePageEvent } from '../bindings.ts'
import { onlineImageUrl } from './onlineImages.ts'

export function useOnlinePages() {
  const currentPage = ref(1)
  const pageCount = ref(0)
  const imageUrl = ref('')
  const loading = ref(false)
  const error = ref('')
  const receivedBytes = ref(0)
  const cache = new Map<number, string>()
  const pending = new Map<number, Promise<string>>()
  let generation = 0
  let sessionId: string | null = null

  function clear() {
    generation++
    const id = sessionId
    sessionId = null
    if (id !== null) void commands.closeOnlineReader(id).catch((cause: unknown) => console.error('关闭在线阅读失败', cause))
    for (const url of cache.values()) URL.revokeObjectURL(url)
    cache.clear()
    pending.clear()
    imageUrl.value = ''
  }

  function fetchPage(index: number): Promise<string> {
    const cached = cache.get(index)
    if (cached !== undefined) return Promise.resolve(cached)
    const existing = pending.get(index)
    if (existing !== undefined) return existing
    const id = sessionId
    const version = generation
    if (id === null) return Promise.reject(new Error('在线阅读已关闭'))
    const channel = new Channel<OnlinePageEvent>()
    const chunks: Uint8Array[] = []
    const transfer = new Promise<string>((resolve, reject) => {
      channel.onmessage = (event) => {
        switch (event.event) {
          case 'Chunk':
            if (version !== generation) return
            chunks.push(new Uint8Array(event.data))
            if (index === currentPage.value - 1) receivedBytes.value += event.data.length
            break
          case 'Complete':
            channel.onmessage = () => {}
            if (version !== generation) { chunks.length = 0; resolve(''); return }
            void onlineImageUrl(chunks, event.data.mime, event.data.blocks).then(resolve, reject)
            chunks.length = 0
            break
        }
      }
      void commands.streamOnlinePage(id, index, channel).then((result) => {
        if (result.status === 'error') reject(new Error(result.error.message))
      }, reject)
    }).then((url) => {
      if (version === generation && Math.abs(index - (currentPage.value - 1)) <= 1) {
        cache.set(index, url)
        return url
      }
      if (url !== '') URL.revokeObjectURL(url)
      return ''
    }).finally(() => {
      chunks.length = 0
      channel.onmessage = () => {}
      if (pending.get(index) === transfer) pending.delete(index)
    })
    pending.set(index, transfer)
    return transfer
  }

  async function showPage(page: number) {
    if (page < 1 || page > pageCount.value) return
    currentPage.value = page
    loading.value = true
    error.value = ''
    imageUrl.value = ''
    receivedBytes.value = 0
    const version = generation
    try {
      const url = await fetchPage(page - 1)
      if (version !== generation || currentPage.value !== page) return
      imageUrl.value = url
      for (const [index, cached] of cache) {
        if (Math.abs(index - (page - 1)) > 1) { URL.revokeObjectURL(cached); cache.delete(index) }
      }
      if (page < pageCount.value) void fetchPage(page).catch((cause: unknown) => console.debug('下一页预加载失败', cause))
    } catch (cause) {
      if (version === generation) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (version === generation && currentPage.value === page) loading.value = false
    }
  }

  async function openChapter(chapterId: number) {
    clear()
    currentPage.value = 1
    pageCount.value = 0
    loading.value = true
    error.value = ''
    receivedBytes.value = 0
    const version = generation
    try {
      const id = await commands.startOnlineReader()
      if (version !== generation) { await commands.closeOnlineReader(id); return }
      sessionId = id
      const result = await commands.openOnlineChapter(id, chapterId)
      if (result.status === 'error') throw new Error(result.error.message)
      if (version !== generation) { await commands.closeOnlineReader(result.data.sessionId); return }
      sessionId = result.data.sessionId
      pageCount.value = result.data.pageCount
      await showPage(1)
    } catch (cause) {
      if (version === generation) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (version === generation) loading.value = false
    }
  }

  function invalidatePage() {
    const url = cache.get(currentPage.value - 1)
    if (url !== undefined) URL.revokeObjectURL(url)
    cache.delete(currentPage.value - 1)
    imageUrl.value = ''
    error.value = '图片显示失败，请重试'
  }

  onUnmounted(clear)
  return { currentPage, pageCount, imageUrl, loading, error, receivedBytes, showPage, openChapter, invalidatePage }
}
