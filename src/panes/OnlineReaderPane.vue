<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NInputNumber, NSelect, NSpin } from 'naive-ui'
import { useStore } from '../store.ts'
import { useOnlinePages } from '../reader/useOnlinePages.ts'

const store = useStore()
const prefetchPages = computed(() => store.config?.onlineReaderPrefetchPages ?? 1)
const { currentPage, pageCount, imageUrl, loading, error, receivedBytes, showPage, openChapter, invalidatePage } = useOnlinePages(prefetchPages)
const scale = ref(100)
const panel = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
const chapters = computed(() => store.onlineReaderComic?.chapterInfos ?? [])
const chapterOptions = computed(() => chapters.value.map((chapter) => ({ label: chapter.chapterTitle, value: chapter.chapterId })))
const chapterId = computed(() => store.onlineReaderChapter?.chapterId ?? null)
const chapterIndex = computed(() => chapters.value.findIndex((chapter) => chapter.chapterId === chapterId.value))
function updatePrefetchPages(value: number | null) {
  if (value !== null && store.config !== undefined) store.config.onlineReaderPrefetchPages = value
}
function selectChapter(id: number) {
  const chapter = chapters.value.find((chapter) => chapter.chapterId === id)
  if (chapter !== undefined) store.onlineReaderChapter = chapter
}
function changeChapter(offset: number) {
  const chapter = chapters.value[chapterIndex.value + offset]
  if (chapter !== undefined) selectChapter(chapter.chapterId)
}
function close() { store.onlineReaderChapter = null; store.onlineReaderComic = null }
function retry() {
  if (pageCount.value > 0) void showPage(currentPage.value)
  else if (chapterId.value !== null) void openChapter(chapterId.value)
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { close(); return }
  if (event.key === 'Tab') {
    const controls = panel.value?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')
    const first = controls?.[0]
    const last = controls?.[controls.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
      event.preventDefault(); last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first?.focus()
    }
    return
  }
  if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="combobox"]') !== null) return
  if (!loading.value && event.key === 'ArrowLeft') { event.preventDefault(); void showPage(currentPage.value - 1) }
  else if (!loading.value && event.key === 'ArrowRight') { event.preventDefault(); void showPage(currentPage.value + 1) }
}
watch(chapterId, (id) => { scale.value = 100; if (id !== null) void openChapter(id) }, { immediate: true })
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  panel.value?.focus()
  window.addEventListener('keydown', keydown)
})
onUnmounted(() => { window.removeEventListener('keydown', keydown); previousFocus?.focus() })
</script>

<template>
  <section ref="panel" tabindex="-1" class="fixed inset-0 z-50 bg-black text-white flex flex-col" role="dialog" aria-modal="true" aria-label="在线阅读">
    <header class="flex flex-wrap items-center gap-2 px-4 py-3 bg-gray-9 border-b border-gray-7">
      <span class="font-semibold text-sm">在线阅读</span>
      <n-select class="min-w-0 w-64 max-w-full" size="small" :value="chapterId" :options="chapterOptions" aria-label="选择章节" @update:value="selectChapter" />
      <span class="text-gray-3 text-sm whitespace-nowrap">{{ currentPage }} / {{ pageCount || '—' }} 页</span>
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
      <n-button size="small" class="ml-auto text-white!" quaternary aria-label="关闭在线阅读" @click="close">关闭</n-button>
    </header>
    <div class="flex-1 min-h-0 overflow-auto p-4 flex" :aria-busy="loading">
      <img v-if="imageUrl" :key="imageUrl" :src="imageUrl" :alt="`${store.onlineReaderChapter?.chapterTitle} 第 ${currentPage} 页`" :style="{ width: `${scale}%`, maxWidth: 'none', maxHeight: `${scale}%` }" class="object-contain shrink-0 self-start m-auto" @error="invalidatePage" />
      <div v-else class="m-auto text-center max-w-100 px-4 py-6" role="status" aria-live="polite">
        <n-spin v-if="loading" size="large" />
        <p v-if="loading" class="mt-4 text-gray-3">正在加载{{ receivedBytes > 0 ? ` · ${Math.ceil(receivedBytes / 1024)} KB` : '章节' }}…</p>
        <p v-else-if="error" class="text-red-3 break-words">{{ error }}</p>
        <p v-else class="text-gray-3">这个章节暂无图片</p>
        <n-button v-if="error && !loading" size="small" class="mt-3 text-white!" @click="retry">重试</n-button>
      </div>
    </div>
    <footer class="flex flex-wrap justify-center items-center gap-2 px-3 py-3 bg-gray-9 border-t border-gray-7">
      <n-button size="small" class="text-white!" :disabled="chapterIndex <= 0" @click="changeChapter(-1)">上一章</n-button>
      <n-button size="small" class="text-white!" :disabled="loading || currentPage <= 1" @click="showPage(currentPage - 1)">上一页</n-button>
      <n-button size="small" class="text-white!" :disabled="loading || currentPage >= pageCount" @click="showPage(currentPage + 1)">下一页</n-button>
      <n-button size="small" class="text-white!" :disabled="chapterIndex >= chapters.length - 1" @click="changeChapter(1)">下一章</n-button>
      <div class="flex items-center gap-1">
        <n-button size="tiny" quaternary class="text-white!" :disabled="scale <= 25" aria-label="缩小" @click="scale = Math.max(25, scale - 25)">−</n-button>
        <n-button size="tiny" quaternary class="text-white!" aria-label="重置缩放" @click="scale = 100">{{ scale }}%</n-button>
        <n-button size="tiny" quaternary class="text-white!" :disabled="scale >= 300" aria-label="放大" @click="scale = Math.min(300, scale + 25)">+</n-button>
      </div>
    </footer>
  </section>
</template>
