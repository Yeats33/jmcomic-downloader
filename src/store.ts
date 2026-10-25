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
import { ref, watch } from 'vue'
import { DISPLAY_KEY, EMPTY_DISPLAYS, displayFor, loadDisplays } from './reader/preferences.ts'
import type { ReaderDisplays, ReaderFit } from './reader/preferences.ts'
import { loadReadingHistory, READING_HISTORY_KEY, rememberProgress } from './reader/history.ts'
import type { ReaderLayout, ReaderMode, ReadingProgress } from './reader/history.ts'
import { useReadingLibrary } from './reader/library.ts'

export const useStore = defineStore('store', () => {
  const config = ref<Config>()
  const startupReady = ref(false)
  const userProfile = ref<GetUserProfileRespData>()
  const pickedComic = ref<Comic>()
  const currentTabName = ref<CurrentTabName>('search')
  const progresses = ref<Map<number, ProgressData>>(new Map())
  const downloadOrder = ref<number[]>([])
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
  const readerScale = ref(100)
  const readerFit = ref<ReaderFit>('screen')
  const readerDisplays = ref<ReaderDisplays>(EMPTY_DISPLAYS)
  let applyingDisplay = false

  function saveDisplays() {
    try {
      window.localStorage.setItem(DISPLAY_KEY, JSON.stringify(readerDisplays.value))
      readingHistoryError.value = ''
    } catch (error) {
      readingHistoryError.value = `显示设置保存失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
  function applyDisplay(comicId: number, fallback: ReaderLayout) {
    const display = displayFor(readerDisplays.value, comicId, fallback)
    applyingDisplay = true
    readerLayout.value = display.layout
    readerScale.value = display.scale
    readerFit.value = display.fit
    applyingDisplay = false
  }
  watch(
    [readerLayout, readerScale, readerFit],
    ([layout, scale, fit]) => {
      const comic = readerComic.value ?? onlineReaderComic.value
      if (applyingDisplay || comic === null) return
      readerDisplays.value = {
        ...readerDisplays.value,
        comics: { ...readerDisplays.value.comics, [comic.id]: { layout, scale, fit } },
      }
      saveDisplays()
    },
    { flush: 'sync' },
  )
  function saveDefaultDisplay() {
    readerDisplays.value = {
      ...readerDisplays.value,
      defaults: { layout: readerLayout.value, scale: readerScale.value, fit: readerFit.value },
    }
    saveDisplays()
  }
  function resetComicDisplay() {
    const comic = readerComic.value ?? onlineReaderComic.value
    if (comic === null) return
    const comics = { ...readerDisplays.value.comics }
    delete comics[String(comic.id)]
    readerDisplays.value = { ...readerDisplays.value, comics }
    applyDisplay(comic.id, 'single')
    saveDisplays()
  }
  const readerStartPage = ref(1)
  const readerStartFilename = ref<string | null>(null)
  const onlineReaderStartPage = ref(1)
  const autoNextChapter = ref(false)

  function setAutoNextChapter(value: boolean) {
    autoNextChapter.value = value
    try {
      window.localStorage.setItem('jmcomic.auto-next-chapter', String(value))
    } catch (error) {
      readingHistoryError.value = `自动连读设置保存失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  function initializeReadingHistory() {
    try {
      autoNextChapter.value = window.localStorage.getItem('jmcomic.auto-next-chapter') === 'true'
      readingHistory.value = loadReadingHistory(window.localStorage)
      readerDisplays.value = loadDisplays(window.localStorage)
      readerLayout.value = readingHistory.value[0]?.layout ?? 'single'
    } catch (error) {
      readingHistoryError.value = error instanceof Error ? error.message : String(error)
    }
  }

  function recordReadingProgress(progress: ReadingProgress) {
    const library = useReadingLibrary()
    if (library.statusFor(progress.comicId) === 'unread') library.setStatus(progress.comicId, 'reading')
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

  function openLocalReader(comic: Comic, chapter: ChapterInfo, position?: ReadingProgress) {
    const progress = position ?? readingProgress(comic.id, chapter.chapterId, 'local')
    onlineReaderChapter.value = null
    onlineReaderComic.value = null
    readerStartPage.value = progress?.page ?? 1
    readerStartFilename.value = progress?.filename ?? null
    applyDisplay(comic.id, progress?.layout ?? readerLayout.value)
    readerComic.value = comic
    readerChapterTitle.value = chapter.chapterTitle
    readerChapterId.value = chapter.chapterId
  }

  function openOnlineReader(comic: Comic, chapter: ChapterInfo, position?: ReadingProgress) {
    const progress = position ?? readingProgress(comic.id, chapter.chapterId, 'online')
    readerChapterId.value = null
    readerComic.value = null
    onlineReaderStartPage.value = progress?.page ?? 1
    applyDisplay(comic.id, progress?.layout ?? readerLayout.value)
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
    downloadOrder,
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
    readerScale,
    readerFit,
    saveDefaultDisplay,
    resetComicDisplay,
    readerStartPage,
    readerStartFilename,
    onlineReaderStartPage,
    autoNextChapter,
    setAutoNextChapter,
    initializeReadingHistory,
    recordReadingProgress,
    readingProgress,
    openLocalReader,
    openOnlineReader,
  }
})
