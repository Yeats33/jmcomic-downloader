<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NCheckbox, NSelect } from 'naive-ui'
import { adjacentChapter, orderedChapters } from '../reader/chapters.ts'
import type { ChapterInfo } from '../bindings.ts'
import { commands } from '../bindings.ts'
import { useStore } from '../store.ts'
import { useLocalPages } from '../reader/useLocalPages.ts'
import ReaderNavigation from '../reader/ReaderNavigation.vue'
import ReaderViewport from '../reader/ReaderViewport.vue'
import ReaderBookmarks from '../reader/ReaderBookmarks.vue'
import ReaderThumbnails from '../reader/ReaderThumbnails.vue'

const store = useStore()
const chapterId = computed(() => store.readerChapterId)
const source = computed(() =>
  store.readerComic === null || chapterId.value === null
    ? null
    : {
        comic: store.readerComic,
        chapterId: chapterId.value,
        startPage: store.readerStartPage,
        startFilename: store.readerStartFilename,
      },
)
const { pages, filenames, directory, currentPage, totalImgCount, downloading, loading, error, refresh, showPage } =
  useLocalPages(source)
const scale = computed({ get: () => store.readerScale, set: (value: number) => { store.readerScale = value } })
const panel = ref<HTMLElement | null>(null)
const chapterMenuOpen = ref(false)
const thumbnailsOpen = ref(false)
const chapters = computed(() => orderedChapters(store.readerComic?.chapterInfos ?? []))
const previousChapter = computed(() => adjacentChapter(chapters.value, chapterId.value, -1))
const nextChapter = computed(() => adjacentChapter(chapters.value, chapterId.value, 1))
const readable = (chapter: ChapterInfo | undefined) =>
  chapter !== undefined && (chapter.isDownloaded === true || store.progresses.has(chapter.chapterId))
const chapterOptions = computed(() => chapters.value.map((chapter) => ({
  label: `${chapter.chapterTitle}${readable(chapter) ? '' : '（未下载）'}`,
  value: chapter.chapterId,
  disabled: !readable(chapter),
})))
function selectChapter(id: number) {
  const chapter = chapters.value.find((item) => item.chapterId === id)
  if (chapter !== undefined && readable(chapter) && store.readerComic !== null) {
    store.openLocalReader(store.readerComic, chapter)
  }
}
function advanceChapter() {
  if (store.autoNextChapter && !loading.value && !error.value && !downloading.value && readable(nextChapter.value) && nextChapter.value !== undefined) {
    selectChapter(nextChapter.value.chapterId)
  }
}
function navigate(page: number) {
  if (page > pages.value.length && !loading.value) advanceChapter()
  else showPage(page)
}
let previousFocus: HTMLElement | null = null

function close() {
  store.readerComic = null
  store.readerChapterId = null
  store.readerChapterTitle = ''
  previousFocus?.focus()
}

async function openDirectory() {
  const result = await commands.showPathInFileManager(directory.value)
  if (result.status === 'error') error.value = result.error.message
}

function keydown(event: KeyboardEvent) {
  if (chapterId.value === null) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (chapterMenuOpen.value) chapterMenuOpen.value = false
    else if (thumbnailsOpen.value) thumbnailsOpen.value = false
    else close()
    return
  }
  if (event.key === 'Tab') {
    const controls = panel.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
    )
    const first = controls?.[0]
    const last = controls?.[controls.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
    return
  }
  if (
    event.target instanceof HTMLElement &&
    event.target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"]') !== null
  )
    return
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    showPage(currentPage.value - 1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    navigate(currentPage.value + 1)
  } else if (event.key === '+' || event.key === '=') scale.value = Math.min(scale.value + 25, 300)
  else if (event.key === '-') scale.value = Math.max(scale.value - 25, 25)
}

function rememberPage(page: number) {
  if (page !== currentPage.value) return
  const comic = store.readerComic
  const id = chapterId.value
  const filename = filenames.value[currentPage.value - 1]
  if (comic === null || id === null || filename === undefined || loading.value || error.value) return
  store.recordReadingProgress({
    comicId: comic.id,
    comicName: comic.name,
    chapterId: id,
    chapterTitle: store.readerChapterTitle,
    page: currentPage.value,
    pageCount: pages.value.length,
    filename,
    mode: 'local',
    layout: store.readerLayout,
    updatedAt: Date.now(),
  })
}
watch(chapterId, async (id, previous) => {
  thumbnailsOpen.value = false
  if (id !== null) {
    if (previous === null) previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    panel.value?.focus()
  }
})
onMounted(() => {
  window.addEventListener('keydown', keydown, true)
})
onUnmounted(() => {
  window.removeEventListener('keydown', keydown, true)
})
</script>

<template>
  <section
    v-if="chapterId !== null"
    ref="panel"
    tabindex="-1"
    class="fixed inset-0 z-50 bg-black text-white flex flex-col"
    role="dialog"
    aria-modal="true"
    aria-label="本地阅读">
    <header class="flex flex-wrap items-center gap-2 px-4 py-3 bg-gray-9 border-b border-gray-7 shrink-0">
      <n-select v-model:show="chapterMenuOpen" class="w-64 max-w-full" size="small" :value="chapterId"
        :options="chapterOptions" aria-label="选择章节" @update:value="selectChapter" />
      <n-checkbox :checked="store.autoNextChapter" @update:checked="store.setAutoNextChapter">
        <span class="text-white">自动下一章</span>
      </n-checkbox>
      <n-button size="small" class="text-white!" :aria-expanded="thumbnailsOpen" @click="thumbnailsOpen = !thumbnailsOpen">页面总览</n-button>
      <span class="text-gray-3 text-sm whitespace-nowrap">第 {{ currentPage }} / {{ pages.length || '—' }} 页</span>
      <span class="text-gray-3 text-sm whitespace-nowrap">已下载 {{ pages.length }} / {{ totalImgCount }}</span>
      <span v-if="downloading" class="text-sm text-yellow-3">下载中</span>
      <n-button size="small" quaternary class="ml-auto text-white!" :disabled="!directory" @click="openDirectory">
        打开目录
      </n-button>
      <n-button size="small" quaternary class="text-white!" aria-label="关闭本地阅读" @click="close">关闭</n-button>
      <span v-if="store.readingHistoryError" class="w-full text-red-3 text-sm" role="alert">
        {{ store.readingHistoryError }}
      </span>
    </header>
    <ReaderThumbnails v-if="thumbnailsOpen && chapterId !== null" mode="local" :chapter-id="chapterId"
      :page="currentPage" :page-count="pages.length" :pages="pages" @close="thumbnailsOpen = false"
      @navigate="showPage($event); thumbnailsOpen = false" />
    <ReaderViewport
      :key="chapterId"
      :pages="pages"
      :page="currentPage"
      :layout="store.readerLayout"
      :scale="scale"
      :fit="store.readerFit"
      :title="store.readerChapterTitle"
      :loading="loading"
      :error="error"
      @visible-page="showPage"
      @page-displayed="rememberPage"
      @chapter-end="advanceChapter"
      @retry="refresh" />
    <ReaderNavigation
      v-model:layout="store.readerLayout"
      v-model:scale="scale"
      :page="currentPage"
      :page-count="pages.length"
      :advance-chapter="store.autoNextChapter && !downloading && readable(nextChapter)"
      @navigate="navigate">
      <ReaderBookmarks v-if="store.readerComic && chapterId !== null" :comic-id="store.readerComic.id"
        :chapter-id="chapterId" :page="currentPage" mode="local" />
      <n-button size="small" class="text-white!" :disabled="!readable(previousChapter)"
        @click="previousChapter && selectChapter(previousChapter.chapterId)">上一章</n-button>
      <n-button size="small" class="text-white!" :disabled="!readable(nextChapter)"
        :title="nextChapter && !readable(nextChapter) ? '下一章尚未下载' : undefined"
        @click="nextChapter && selectChapter(nextChapter.chapterId)">下一章</n-button>
    </ReaderNavigation>
  </section>
</template>
