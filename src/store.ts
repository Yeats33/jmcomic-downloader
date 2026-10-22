import { defineStore } from 'pinia'
import { CurrentTabName, ProgressData, ProgressesPaneTabName } from './types.ts'
import {
  ChapterInfo,
  Comic,
  Config,
  GetFavoriteResult,
  GetUserProfileRespData,
  GetWeeklyResult,
  SearchResult,
} from './bindings.ts'
import { ref } from 'vue'
import { loadReadingHistory, READING_HISTORY_KEY, rememberProgress } from './reader/history.ts'
import type { ReaderLayout, ReaderMode, ReadingProgress } from './reader/history.ts'

export const useStore = defineStore('store', () => {
  const config = ref<Config>()
  const startupReady = ref(false)
  const userProfile = ref<GetUserProfileRespData>()
  const pickedComic = ref<Comic>()
  const currentTabName = ref<CurrentTabName>('search')
  const progresses = ref<Map<number, ProgressData>>(new Map())
  const getFavoriteResult = ref<GetFavoriteResult>()
  const searchResult = ref<SearchResult>()
  const progressesPaneTabName = ref<ProgressesPaneTabName>('uncompleted')
  const getWeeklyResult = ref<GetWeeklyResult>()
  const readerComic = ref<Comic | null>(null)
  const readerChapterId = ref<number | null>(null)
  const readerChapterTitle = ref('')
  const downloadedComics = ref<Comic[]>([])
  const onlineReaderComic = ref<Comic | null>(null)
  const onlineReaderChapter = ref<ChapterInfo | null>(null)
  const readingHistory = ref<ReadingProgress[]>([])
  const readingHistoryError = ref('')
  const readerLayout = ref<ReaderLayout>('single')
  const readerStartPage = ref(1)
  const readerStartFilename = ref<string | null>(null)
  const onlineReaderStartPage = ref(1)

  function initializeReadingHistory() {
    try {
      readingHistory.value = loadReadingHistory(window.localStorage)
      readerLayout.value = readingHistory.value[0]?.layout ?? 'single'
    } catch (error) {
      readingHistoryError.value = error instanceof Error ? error.message : String(error)
    }
  }

  function recordReadingProgress(progress: ReadingProgress) {
    readingHistory.value = rememberProgress(readingHistory.value, progress)
    try {
      window.localStorage.setItem(READING_HISTORY_KEY, JSON.stringify(readingHistory.value))
      readingHistoryError.value = ''
    } catch (error) {
      readingHistoryError.value = `阅读进度保存失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  function readingProgress(comicId: number, chapterId: number, mode: ReaderMode) {
    return readingHistory.value.find(
      (entry) => entry.comicId === comicId && entry.chapterId === chapterId && entry.mode === mode,
    )
  }

  function openLocalReader(comic: Comic, chapter: ChapterInfo) {
    const progress = readingProgress(comic.id, chapter.chapterId, 'local')
    onlineReaderChapter.value = null
    onlineReaderComic.value = null
    readerStartPage.value = progress?.page ?? 1
    readerStartFilename.value = progress?.filename ?? null
    readerLayout.value = progress?.layout ?? readerLayout.value
    readerComic.value = comic
    readerChapterTitle.value = chapter.chapterTitle
    readerChapterId.value = chapter.chapterId
  }

  function openOnlineReader(comic: Comic, chapter: ChapterInfo) {
    const progress = readingProgress(comic.id, chapter.chapterId, 'online')
    readerChapterId.value = null
    readerComic.value = null
    onlineReaderStartPage.value = progress?.page ?? 1
    readerLayout.value = progress?.layout ?? readerLayout.value
    onlineReaderComic.value = comic
    onlineReaderChapter.value = chapter
  }

  return {
    config,
    startupReady,
    userProfile,
    pickedComic,
    currentTabName,
    progresses,
    getFavoriteResult,
    searchResult,
    progressesPaneTabName,
    getWeeklyResult,
    readerComic,
    readerChapterId,
    readerChapterTitle,
    downloadedComics,
    onlineReaderComic,
    onlineReaderChapter,
    readingHistory,
    readingHistoryError,
    readerLayout,
    readerStartPage,
    readerStartFilename,
    onlineReaderStartPage,
    initializeReadingHistory,
    recordReadingProgress,
    readingProgress,
    openLocalReader,
    openOnlineReader,
  }
})
