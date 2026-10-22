<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowReactive, watch } from 'vue'
import { NButton, NSpin } from 'naive-ui'
import type { ReaderLayout } from './history.ts'

const props = defineProps<{
  pages: readonly { readonly key: string; readonly url: string }[]
  page: number
  layout: ReaderLayout
  scale: number
  title: string
  loading: boolean
  error: string
}>()
const emit = defineEmits<{
  visiblePage: [page: number]
  pageDisplayed: [page: number]
  retry: [page: number]
  imageError: [page: number]
}>()
const viewport = ref<HTMLElement | null>(null)
const ratios = shallowReactive(new Map<string, number>())
const failed = shallowReactive(new Set<string>())
const visiblePages = computed(() =>
  props.pages
    .map((item, index) => ({ ...item, number: index + 1 }))
    .filter((item) => props.layout === 'scroll' || item.number === props.page),
)
let lastReported = 0
let frame = 0
let lastDisplayed: { page: number; url: string; layout: ReaderLayout } | undefined

function reportDisplayedPage() {
  const item = props.pages[props.page - 1]
  if (item === undefined || !item.url || props.loading || props.error || failed.has(item.key)) return
  const image = viewport.value?.querySelector<HTMLImageElement>(`[data-reader-page="${props.page}"] img`)
  if (!image?.complete || image.naturalWidth === 0 || image.getAttribute('src') !== item.url) return
  if (lastDisplayed?.page === props.page && lastDisplayed.url === item.url && lastDisplayed.layout === props.layout)
    return
  lastDisplayed = { page: props.page, url: item.url, layout: props.layout }
  emit('pageDisplayed', props.page)
}

function onScroll() {
  if (props.layout !== 'scroll' || frame !== 0) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const root = viewport.value
    if (root === null) return
    const target = root.getBoundingClientRect().top + root.clientHeight / 3
    const item = [...root.querySelectorAll<HTMLElement>('[data-reader-page]')].find(
      (element) => element.getBoundingClientRect().bottom > target,
    )
    if (item === undefined) return
    const page = Number(item.dataset.readerPage)
    if (page !== props.page) {
      lastReported = page
      emit('visiblePage', page)
    }
  })
}

async function alignPage() {
  await nextTick()
  const root = viewport.value
  if (root === null) return
  if (props.layout === 'single') {
    root.scrollTo(0, 0)
    return
  }
  if (lastReported === props.page) return
  const target = root.querySelector<HTMLElement>(`[data-reader-page="${props.page}"]`)
  if (target !== null) {
    lastReported = props.page
    root.scrollTo({
      top: root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top,
      behavior: 'instant',
    })
  }
}

function loaded(key: string, event: Event) {
  const image = event.target
  if (image instanceof HTMLImageElement && image.naturalHeight > 0)
    ratios.set(key, image.naturalWidth / image.naturalHeight)
  void nextTick(reportDisplayedPage)
}
function failedImage(key: string, page: number) {
  failed.add(key)
  emit('imageError', page)
}
function retry(key: string, page: number) {
  failed.delete(key)
  emit('retry', page)
}
watch([() => props.page, () => props.layout, () => props.loading, () => props.pages[props.page - 1]?.url], () => {
  void nextTick(reportDisplayedPage)
})
watch(
  () => [props.page, props.pages.length],
  () => {
    void alignPage()
  },
  { immediate: true },
)
watch(
  () => props.layout,
  () => {
    lastReported = 0
    void alignPage()
  },
)
onUnmounted(() => {
  cancelAnimationFrame(frame)
})
</script>

<template>
  <div
    ref="viewport"
    class="reader-viewport flex-1 min-h-0 overflow-auto bg-black p-4"
    :class="{ flex: layout === 'single' }"
    @scroll.passive="onScroll">
    <div v-if="pages.length === 0" class="m-auto text-center text-gray-3 py-6" role="status">
      <n-spin v-if="loading" size="large" />
      <p :class="{ 'text-red-3': error && !loading }">
        {{ loading ? '正在加载章节…' : error || '这个章节暂无可阅读的图片' }}
      </p>
      <n-button v-if="error" size="small" class="text-white!" @click="emit('retry', page)">重试</n-button>
    </div>
    <div
      v-for="item in visiblePages"
      :key="item.key"
      :data-reader-page="item.number"
      class="reader-page"
      :class="layout === 'scroll' ? 'mx-auto mb-4' : 'flex flex-1 min-h-0 min-w-0'"
      :style="
        layout === 'scroll'
          ? {
              width: `${scale}%`,
              aspectRatio: ratios.get(item.key) ?? 0.75,
            }
          : undefined
      ">
      <img
        v-if="item.url && !failed.has(item.key)"
        :src="item.url"
        :alt="`${title} 第 ${item.number} 页`"
        :loading="item.number === page ? 'eager' : 'lazy'"
        :style="
          layout === 'scroll'
            ? { width: '100%', display: 'block' }
            : { width: `${scale}%`, maxWidth: 'none', maxHeight: `${scale}%` }
        "
        class="object-contain shrink-0 m-auto"
        @load="loaded(item.key, $event)"
        @error="failedImage(item.key, item.number)" />
      <div
        v-else
        class="h-full min-h-48 flex flex-col items-center justify-center gap-3 text-gray-3 p-4 box-border text-center"
        role="status">
        <n-spin v-if="loading && item.number === page" />
        <span :class="{ 'text-red-3': failed.has(item.key) || (item.number === page && error) }">
          {{
            failed.has(item.key)
              ? '图片显示失败，请重试'
              : item.number === page && error
                ? error
                : `第 ${item.number} 页${loading && item.number === page ? '正在加载…' : ''}`
          }}
        </span>
        <n-button
          v-if="failed.has(item.key) || (item.number === page && error)"
          size="small"
          class="text-white!"
          @click="retry(item.key, item.number)">
          重试
        </n-button>
      </div>
    </div>
  </div>
</template>
