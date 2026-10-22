<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import { commands } from '../bindings.ts'
import { useStore } from '../store.ts'
import { useLocalPages } from '../reader/useLocalPages.ts'
import ReaderNavigation from '../reader/ReaderNavigation.vue'
import ReaderViewport from '../reader/ReaderViewport.vue'

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
const scale = ref(100)
const panel = ref<HTMLElement | null>(null)
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
    close()
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
    showPage(currentPage.value + 1)
  } else if (event.key === '+' || event.key === '=') scale.value = Math.min(scale.value + 25, 300)
  else if (event.key === '-') scale.value = Math.max(scale.value - 25, 25)
}

watch([currentPage, filenames, loading, () => store.readerLayout], () => {
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
})
watch(chapterId, async (id, previous) => {
  scale.value = 100
  if (id !== null) {
    if (previous === null) previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    panel.value?.focus()
  }
})
onMounted(() => {
  window.addEventListener('keydown', keydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', keydown)
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
      <span class="font-semibold truncate max-w-full" :title="store.readerChapterTitle">
        {{ store.readerChapterTitle }}
      </span>
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
    <ReaderViewport
      :key="chapterId"
      :pages="pages"
      :page="currentPage"
      :layout="store.readerLayout"
      :scale="scale"
      :title="store.readerChapterTitle"
      :loading="loading"
      :error="error"
      @visible-page="showPage"
      @retry="refresh" />
    <ReaderNavigation
      v-model:layout="store.readerLayout"
      v-model:scale="scale"
      :page="currentPage"
      :page-count="pages.length"
      @navigate="showPage" />
  </section>
</template>
