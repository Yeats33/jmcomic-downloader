<script setup lang="ts">
import { ref, watch } from 'vue'
import { NButton, NInputNumber, NRadioButton, NRadioGroup } from 'naive-ui'
import type { ReaderLayout } from './history.ts'
import { useStore } from '../store.ts'
const store = useStore()

const props = defineProps<{ page: number; pageCount: number; advanceChapter?: boolean }>()
const layout = defineModel<ReaderLayout>('layout', { required: true })
const scale = defineModel<number>('scale', { required: true })
const emit = defineEmits<{ navigate: [page: number] }>()
const targetPage = ref<number | null>(props.page)
watch(
  () => props.page,
  (page) => {
    targetPage.value = page
  },
)
function jump() {
  if (targetPage.value !== null && props.pageCount > 0) {
    emit('navigate', Math.max(1, Math.min(Math.trunc(targetPage.value), props.pageCount)))
  }
}
</script>

<template>
  <footer
    class="flex flex-wrap justify-center items-center gap-2 px-3 py-3 bg-gray-9 text-white border-t border-gray-7 shrink-0">
    <slot />
    <n-button size="small" class="text-white!" :disabled="page <= 1" @click="emit('navigate', page - 1)">
      上一页
    </n-button>
    <n-button
      size="small"
      class="text-white!"
      :disabled="page >= pageCount && !advanceChapter"
      @click="emit('navigate', page + 1)">
      {{ page >= pageCount && advanceChapter ? '接着读下一章' : '下一页' }}
    </n-button>
    <div class="flex items-center gap-1">
      <label for="reader-page-number" class="text-sm">页码</label>
      <n-input-number
        v-model:value="targetPage"
        class="w-24"
        size="small"
        :min="1"
        :max="Math.max(1, pageCount)"
        :precision="0"
        :disabled="pageCount === 0"
        :input-props="{ id: 'reader-page-number', 'aria-label': '跳转页码' }"
        @keydown.enter="jump" />
      <n-button size="small" class="text-white!" :disabled="pageCount === 0" @click="jump">跳转</n-button>
    </div>
    <n-radio-group v-model:value="layout" size="small" aria-label="阅读布局">
      <n-radio-button value="single">单页</n-radio-button>
      <n-radio-button value="scroll">连续滚动</n-radio-button>
    </n-radio-group>
    <n-radio-group v-model:value="store.readerFit" size="small" aria-label="图片适配">
      <n-radio-button value="screen">适屏</n-radio-button>
      <n-radio-button value="width">适宽</n-radio-button>
      <n-radio-button value="height">适高</n-radio-button>
    </n-radio-group>
    <n-button size="small" class="text-white!" @click="store.saveDefaultDisplay">设为默认</n-button>
    <n-button size="small" class="text-white!" @click="store.resetComicDisplay">使用默认</n-button>
    <div class="flex items-center gap-1">
      <n-button
        size="small"
        quaternary
        class="text-white!"
        :disabled="scale <= 25"
        aria-label="缩小"
        @click="scale = Math.max(25, scale - 25)">
        −
      </n-button>
      <n-button size="small" quaternary class="text-white!" aria-label="重置缩放" @click="scale = 100">
        {{ scale }}%
      </n-button>
      <n-button
        size="small"
        quaternary
        class="text-white!"
        :disabled="scale >= 300"
        aria-label="放大"
        @click="scale = Math.min(300, scale + 25)">
        +
      </n-button>
    </div>
  </footer>
</template>
