import { computed, onUnmounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { commands } from '../bindings.ts'
import type { Comic } from '../bindings.ts'

export interface LocalReaderSource {
  readonly comic: Comic
  readonly chapterId: number
  readonly startPage: number
  readonly startFilename: string | null
}

export function useLocalPages(source: Readonly<Ref<LocalReaderSource | null>>) {
  const filenames = ref<string[]>([])
  const directory = ref('')
  const currentPage = ref(1)
  const totalImgCount = ref(0)
  const downloading = ref(false)
  const loading = ref(false)
  const error = ref('')
  let generation = 0
  let restoring = true
  let timer: ReturnType<typeof setInterval> | undefined
  const pages = computed(() =>
    filenames.value.map((filename) => ({ key: filename, url: convertFileSrc(`${directory.value}/${filename}`) })),
  )

  function stop() {
    clearInterval(timer)
    timer = undefined
  }

  async function refresh() {
    const requested = source.value
    if (requested === null || loading.value) return
    const version = generation
    loading.value = true
    error.value = ''
    try {
      const result = await commands.getChapterDownloadedImgs(requested.comic, requested.chapterId)
      if (version !== generation) return
      if (result.status === 'error') {
        error.value = result.error.message
        return
      }
      const previousFilename = restoring ? requested.startFilename : filenames.value[currentPage.value - 1]
      directory.value = result.data.downloadDir
      totalImgCount.value = result.data.totalImgCount
      downloading.value = result.data.isDownloading
      filenames.value = result.data.downloadedImgs
      if (filenames.value.length > 0) {
        const index =
          previousFilename === null || previousFilename === undefined ? -1 : filenames.value.indexOf(previousFilename)
        currentPage.value =
          index >= 0 ? index + 1 : Math.min(restoring ? requested.startPage : currentPage.value, filenames.value.length)
        restoring = false
      }
      if (!downloading.value) stop()
    } catch (cause) {
      if (version === generation) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (version === generation) loading.value = false
    }
  }

  function showPage(page: number) {
    if (Number.isInteger(page) && page >= 1 && page <= filenames.value.length) currentPage.value = page
  }

  watch(
    () => source.value?.chapterId,
    () => {
      generation++
      stop()
      filenames.value = []
      directory.value = ''
      totalImgCount.value = 0
      currentPage.value = 1
      loading.value = false
      error.value = ''
      downloading.value = false
      restoring = true
      if (source.value !== null) {
        timer = setInterval(() => {
          void refresh()
        }, 2000)
        void refresh()
      }
    },
    { immediate: true, flush: 'sync' },
  )

  onUnmounted(() => {
    generation++
    stop()
  })
  return { pages, filenames, directory, currentPage, totalImgCount, downloading, loading, error, refresh, showPage }
}
