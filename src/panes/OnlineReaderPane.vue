<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NCheckbox, NInputNumber, NSelect } from 'naive-ui'
import { orderedChapters } from '../reader/chapters.ts'
import { useStore } from '../store.ts'
import { useOnlinePages } from '../reader/useOnlinePages.ts'
import ReaderNavigation from '../reader/ReaderNavigation.vue'
import ReaderViewport from '../reader/ReaderViewport.vue'

const store = useStore()
const prefetchPages = computed(() => store.config?.onlineReaderPrefetchPages ?? 1)
const {
  currentPage,
  pageCount,
  imageUrl,
  pageUrls,
  loading,
  error,
  receivedBytes,
  showPage,
  openChapter,
  invalidatePage,
} = useOnlinePages(prefetchPages)
const pages = computed(() =>
  Array.from({ length: pageCount.value }, (_, index) => ({ key: String(index), url: pageUrls.get(index) ?? '' })),
)
const scale = computed({ get: () => store.readerScale, set: (value: number) => { store.readerScale = value } })
const chapterMenuOpen = ref(false)
const panel = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
const chapters = computed(() => orderedChapters(store.onlineReaderComic?.chapterInfos ?? []))
const chapterOptions = computed(() =>
  chapters.value.map((chapter) => ({ label: chapter.chapterTitle, value: chapter.chapterId })),
)
const chapterId = computed(() => store.onlineReaderChapter?.chapterId ?? null)
const chapterIndex = computed(() => chapters.value.findIndex((chapter) => chapter.chapterId === chapterId.value))
function updatePrefetchPages(value: number | null) {
  if (value !== null && store.config !== undefined) store.config.onlineReaderPrefetchPages = value
}
function selectChapter(id: number) {
  const chapter = chapters.value.find((chapter) => chapter.chapterId === id)
  if (chapter !== undefined && store.onlineReaderComic !== null)
    store.openOnlineReader(store.onlineReaderComic, chapter)
}
function changeChapter(offset: number) {
  const chapter = chapters.value[chapterIndex.value + offset]
  if (chapter !== undefined) selectChapter(chapter.chapterId)
}
function advanceChapter() {
  if (store.autoNextChapter && !loading.value && !error.value) changeChapter(1)
}
function navigate(page: number) {
  if (page > pageCount.value) advanceChapter()
  else void showPage(page)
}
function close() {
  store.onlineReaderChapter = null
  store.onlineReaderComic = null
}
function retry(page = currentPage.value) {
  if (pageCount.value > 0) void showPage(page)
  else if (chapterId.value !== null) void openChapter(chapterId.value, store.onlineReaderStartPage)
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (chapterMenuOpen.value) chapterMenuOpen.value = false
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
  if (!loading.value && event.key === 'ArrowLeft') {
    event.preventDefault()
    void showPage(currentPage.value - 1)
  } else if (!loading.value && event.key === 'ArrowRight') {
    event.preventDefault()
    navigate(currentPage.value + 1)
  }
}
watch(
  chapterId,
  (id) => {
    if (id !== null) void openChapter(id, store.onlineReaderStartPage)
  },
  { immediate: true },
)
function rememberPage(page: number) {
  if (page !== currentPage.value) return
  const comic = store.onlineReaderComic
  const chapter = store.onlineReaderChapter
  if (comic === null || chapter === null || loading.value || imageUrl.value === '' || error.value) return
  store.recordReadingProgress({
    comicId: comic.id,
    comicName: comic.name,
    chapterId: chapter.chapterId,
    chapterTitle: chapter.chapterTitle,
    page: currentPage.value,
    pageCount: pageCount.value,
    filename: null,
    mode: 'online',
    layout: store.readerLayout,
    updatedAt: Date.now(),
  })
}
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  panel.value?.focus()
  window.addEventListener('keydown', keydown, true)
})
onUnmounted(() => {
  window.removeEventListener('keydown', keydown, true)
  previousFocus?.focus()
})
</script>

<template>
  <section
    ref="panel"
    tabindex="-1"
    class="fixed inset-0 z-50 bg-black text-white flex flex-col"
    role="dialog"
    aria-modal="true"
    aria-label="在线阅读">
    <header class="flex flex-wrap items-center gap-2 px-4 py-3 bg-gray-9 border-b border-gray-7">
      <span class="font-semibold text-sm">在线阅读</span>
      <n-select
        v-model:show="chapterMenuOpen"
        class="min-w-0 w-64 max-w-full"
        size="small"
        :value="chapterId"
        :options="chapterOptions"
        aria-label="选择章节"
        @update:value="selectChapter" />
      <span class="text-gray-3 text-sm whitespace-nowrap">{{ currentPage }} / {{ pageCount || '—' }} 页</span>
      <n-checkbox :checked="store.autoNextChapter" @update:checked="store.setAutoNextChapter">
        <span class="text-white">自动下一章</span>
      </n-checkbox>
      <div class="flex items-center gap-1 text-sm whitespace-nowrap" title="提前加载后续页面，0 为关闭；修改后自动保存">
        <label for="online-reader-prefetch">向前缓冲</label>
        <n-input-number
          class="w-24"
          size="small"
          :value="prefetchPages"
          :min="0"
          :max="50"
          :precision="0"
          :input-props="{ id: 'online-reader-prefetch', 'aria-label': '向前缓冲页数' }"
          @update:value="updatePrefetchPages" />
        <span class="text-gray-3">页</span>
      </div>
      <n-button size="small" class="ml-auto text-white!" quaternary aria-label="关闭在线阅读" @click="close">
        关闭
      </n-button>
      <span v-if="loading && receivedBytes > 0" class="text-gray-3 text-sm" role="status">
        已接收 {{ Math.ceil(receivedBytes / 1024) }} KB
      </span>
      <span v-if="store.readingHistoryError" class="w-full text-red-3 text-sm" role="alert">
        {{ store.readingHistoryError }}
      </span>
    </header>
    <ReaderViewport
      :key="chapterId ?? 'closed'"
      :pages="pages"
      :page="currentPage"
      :layout="store.readerLayout"
      :scale="scale"
      :fit="store.readerFit"
      :title="store.onlineReaderChapter?.chapterTitle ?? ''"
      :loading="loading"
      :error="error"
      @visible-page="showPage"
      @page-displayed="rememberPage"
      @chapter-end="advanceChapter"
      @retry="retry"
      @image-error="invalidatePage" />
    <ReaderNavigation
      v-model:layout="store.readerLayout"
      v-model:scale="scale"
      :page="currentPage"
      :page-count="pageCount"
      :advance-chapter="store.autoNextChapter && chapterIndex < chapters.length - 1 && !loading && !error"
      @navigate="navigate">
      <n-button size="small" class="text-white!" :disabled="chapterIndex <= 0" @click="changeChapter(-1)">
        上一章
      </n-button>
      <n-button
        size="small"
        class="text-white!"
        :disabled="chapterIndex >= chapters.length - 1"
        @click="changeChapter(1)">
        下一章
      </n-button>
    </ReaderNavigation>
  </section>
</template>
