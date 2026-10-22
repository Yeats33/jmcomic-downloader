<script setup lang="ts">
import { computed, onUnmounted, ref, shallowReactive, watch } from 'vue'
import { NButton } from 'naive-ui'
import { useOnlinePages } from './useOnlinePages.ts'
import type { ReaderMode } from './history.ts'

const props = defineProps<{ mode: ReaderMode; chapterId: number; page: number; pageCount: number; pages: readonly { url: string }[] }>()
const emit = defineEmits<{ navigate: [page: number]; close: [] }>()
const group = ref(Math.floor((props.page - 1) / 8))
const revision = ref(0)
const loading = ref(false)
const urls = shallowReactive(new Map<number, string>())
const errors = shallowReactive(new Map<number, string>())
const ownedUrls = new Set<string>()
const online = useOnlinePages(ref(0))
const firstPage = computed(() => group.value * 8 + 1)
const numbers = computed(() => Array.from({ length: Math.max(0, Math.min(8, props.pageCount - firstPage.value + 1)) }, (_, index) => firstPage.value + index))
let version = 0
function clear() {
  for (const url of ownedUrls) URL.revokeObjectURL(url)
  ownedUrls.clear()
  urls.clear()
  errors.clear()
}
async function smallImage(url: string): Promise<string> {
  const image = new Image()
  image.src = url
  await image.decode()
  const canvas = document.createElement('canvas')
  const ratio = Math.min(160 / image.naturalWidth, 200 / image.naturalHeight, 1)
  canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('无法生成页面预览')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75))
  if (blob === null) throw new Error('无法生成页面预览')
  return URL.createObjectURL(blob)
}
watch([firstPage, () => props.chapterId, () => props.pageCount, revision], async () => {
  const current = ++version
  clear()
  loading.value = true
  if (props.mode === 'online') await online.openChapter(props.chapterId, firstPage.value)
  for (const number of numbers.value) {
    if (current !== version) return
    try {
      if (props.mode === 'local') {
        const url = props.pages[number - 1]?.url
        if (url) urls.set(number, url)
        else errors.set(number, '页面尚未下载')
      } else {
        if (number !== firstPage.value) await online.showPage(number)
        if (current !== version) return
        if (online.error.value || !online.imageUrl.value) throw new Error(online.error.value || '预览加载失败')
        const thumbnail = await smallImage(online.imageUrl.value)
        if (current !== version) { URL.revokeObjectURL(thumbnail); return }
        ownedUrls.add(thumbnail)
        urls.set(number, thumbnail)
      }
    } catch (cause) {
      if (current === version) errors.set(number, cause instanceof Error ? cause.message : String(cause))
    }
  }
  if (current === version) loading.value = false
}, { immediate: true })
onUnmounted(() => { version++; clear() })
</script>

<template>
  <section aria-label="页面总览" class="bg-gray-9 text-white border-b border-gray-7 p-3 shrink-0 max-h-72 overflow-auto">
    <div class="flex flex-wrap items-center gap-2 mb-2">
      <strong class="text-sm">页面总览</strong>
      <span class="text-sm" role="status">{{ firstPage }}–{{ numbers[numbers.length - 1] ?? 0 }} / {{ pageCount }} 页{{ loading ? ' · 正在加载预览' : '' }}</span>
      <n-button class="text-white!" size="small" :disabled="group === 0 || loading" @click="group--">前 8 页</n-button>
      <n-button class="text-white!" size="small" :disabled="firstPage + 8 > pageCount || loading" @click="group++">后 8 页</n-button>
      <n-button v-if="errors.size" class="text-white!" size="small" :disabled="loading" @click="revision++">重试预览</n-button>
      <n-button class="text-white! ml-auto" size="small" @click="emit('close')">关闭总览</n-button>
    </div>
    <div class="grid grid-cols-4 md:grid-cols-8 gap-2">
      <button v-for="number in numbers" :key="number" class="border border-gray-7 rounded p-1 cursor-pointer min-w-0 focus-visible:outline-orange-4"
        :class="number === page ? 'bg-gray-7' : 'bg-gray-8 hover:bg-gray-7'"
        :aria-label="`跳转到第 ${number} 页`" :aria-current="number === page ? 'page' : undefined"
        @click="emit('navigate', number)">
        <img v-if="urls.has(number)" :src="urls.get(number)" :alt="`第 ${number} 页预览`" class="w-full h-24 object-contain"
          @error="urls.delete(number); errors.set(number, '预览不可用，可点击跳转重试')" />
        <span v-else class="h-24 flex items-center justify-center text-xs" :class="errors.has(number) ? 'text-red-3' : 'text-gray-3'">
          {{ errors.get(number) ?? '加载中…' }}
        </span>
        <span class="text-sm">{{ number === page ? '✓ ' : '' }}{{ number }}</span>
      </button>
    </div>
  </section>
</template>
