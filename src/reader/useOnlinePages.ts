import { Channel } from '@tauri-apps/api/core'
import { onUnmounted, ref, shallowReactive, watch } from 'vue'
import type { Ref } from 'vue'
import { commands } from '../bindings.ts'
import type { OnlinePageEvent } from '../bindings.ts'
import { onlineImageUrl } from './onlineImages.ts'

export function useOnlinePages(prefetchPages: Readonly<Ref<number>>) {
  const currentPage = ref(1)
  const pageCount = ref(0)
  const imageUrl = ref('')
  const loading = ref(false)
  const error = ref('')
  const receivedBytes = ref(0)
  const cache = shallowReactive(new Map<number, string>())
  const pending = new Map<number, Promise<string>>()
  let generation = 0
  let sessionId: string | null = null

  function shouldCachePage(index: number) {
    const currentIndex = currentPage.value - 1
    return index >= currentIndex - 1 && index <= currentIndex + prefetchPages.value
  }

  function trimCache() {
    for (const [index, url] of cache) {
      if (!shouldCachePage(index)) {
        URL.revokeObjectURL(url)
        cache.delete(index)
      }
    }
  }

  function clear() {
    generation++
    const id = sessionId
    sessionId = null
    if (id !== null)
      void commands.closeOnlineReader(id).catch((cause: unknown) => console.error('关闭在线阅读失败', cause))
    for (const url of cache.values()) URL.revokeObjectURL(url)
    cache.clear()
    pending.clear()
    imageUrl.value = ''
  }

  function transferPage(index: number, trackProgress = true): Promise<string> {
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
            if (trackProgress && index === currentPage.value - 1) receivedBytes.value += event.data.length
            break
          case 'Complete':
            channel.onmessage = () => {}
            if (version !== generation) {
              chunks.length = 0
              resolve('')
              return
            }
            void onlineImageUrl(chunks, event.data.mime, event.data.blocks).then(resolve, reject)
            chunks.length = 0
            break
        }
      }
      void commands.streamOnlinePage(id, index, channel).then((result) => {
        if (result.status === 'error') reject(new Error(result.error.message))
      }, reject)
    })
      .then((url) => {
        if (version === generation) return url
        if (url !== '') URL.revokeObjectURL(url)
        return ''
      })
      .finally(() => {
        chunks.length = 0
        channel.onmessage = () => {}
      })
    return transfer
  }

  function fetchPage(index: number): Promise<string> {
    const cached = cache.get(index)
    if (cached !== undefined) return Promise.resolve(cached)
    const existing = pending.get(index)
    if (existing !== undefined) return existing
    const transfer = transferPage(index)
      .then((url) => {
        if (url && shouldCachePage(index)) {
          cache.set(index, url)
          return url
        }
        if (url) URL.revokeObjectURL(url)
        return ''
      })
      .finally(() => {
        if (pending.get(index) === transfer) pending.delete(index)
      })
    pending.set(index, transfer)
    return transfer
  }

  async function prefetch() {
    const version = generation
    const page = currentPage.value
    for (let index = page; index < Math.min(pageCount.value, page + prefetchPages.value); index++) {
      if (version !== generation || currentPage.value !== page) return
      try {
        await fetchPage(index)
      } catch (cause) {
        console.debug('页面预加载失败', cause)
      }
    }
  }

  async function showPage(page: number) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount.value) return
    currentPage.value = page
    loading.value = true
    error.value = ''
    imageUrl.value = ''
    receivedBytes.value = 0
    trimCache()
    const version = generation
    try {
      const url = await fetchPage(page - 1)
      if (version !== generation || currentPage.value !== page) return
      imageUrl.value = url
      void prefetch()
    } catch (cause) {
      if (version === generation && currentPage.value === page)
        error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (version === generation && currentPage.value === page) loading.value = false
    }
  }

  async function openChapter(chapterId: number, startPage = 1) {
    clear()
    currentPage.value = 1
    pageCount.value = 0
    loading.value = true
    error.value = ''
    receivedBytes.value = 0
    const version = generation
    try {
      const id = await commands.startOnlineReader()
      if (version !== generation) {
        await commands.closeOnlineReader(id)
        return
      }
      sessionId = id
      const result = await commands.openOnlineChapter(id, chapterId)
      if (result.status === 'error') throw new Error(result.error.message)
      if (version !== generation) {
        await commands.closeOnlineReader(result.data.sessionId)
        return
      }
      sessionId = result.data.sessionId
      pageCount.value = result.data.pageCount
      await showPage(Math.max(1, Math.min(startPage, pageCount.value)))
    } catch (cause) {
      if (version === generation) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (version === generation) loading.value = false
    }
  }

  function invalidatePage(page = currentPage.value) {
    const url = cache.get(page - 1)
    if (url !== undefined) URL.revokeObjectURL(url)
    cache.delete(page - 1)
    if (page === currentPage.value) {
      imageUrl.value = ''
      error.value = '图片显示失败，请重试'
    }
  }

  watch(prefetchPages, () => {
    trimCache()
    if (imageUrl.value !== '') void prefetch()
  })

  onUnmounted(clear)
  return {
    currentPage,
    pageCount,
    imageUrl,
    pageUrls: cache,
    loading,
    error,
    receivedBytes,
    showPage,
    openChapter,
    invalidatePage,
    previewPage: (page: number) => transferPage(page - 1, false),
  }
}
