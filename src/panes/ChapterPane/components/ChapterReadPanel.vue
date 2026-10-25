<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NRadioButton, NRadioGroup, NEmpty } from 'naive-ui'
import { useStore } from '../../../store.ts'
import type { ChapterInfo } from '../../../bindings.ts'
import type { ChapterPaneMode } from '../ChapterPane.vue'

const store = useStore()
const mode = defineModel<ChapterPaneMode>('chapterPaneMode', { required: true })
const chapters = computed(() => store.pickedComic?.chapterInfos ?? [])
function read(chapter: ChapterInfo) {
  if (store.pickedComic === undefined) return
  store.openOnlineReader(store.pickedComic, chapter)
}
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0">
    <div class="flex items-center flex-wrap gap-2 px-2 pt-2">
      <n-radio-group v-model:value="mode" size="small">
        <n-radio-button value="download">下载</n-radio-button>
        <n-radio-button value="export">导出</n-radio-button>
        <n-radio-button value="read">在线阅读</n-radio-button>
      </n-radio-group>
    </div>
    <p class="text-sm text-gray-6 px-2 my-3">无需下载，选择章节开始阅读。</p>
    <n-empty v-if="chapters.length === 0" description="暂无可阅读的章节" class="my-6" />
    <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2 overflow-auto content-start">
      <n-button
        v-for="chapter in chapters"
        :key="chapter.chapterId"
        size="small"
        class="min-w-0 justify-start!"
        :title="chapter.chapterTitle"
        @click="read(chapter)">
        <span class="truncate">{{ chapter.chapterTitle }}</span>
      </n-button>
    </div>
  </div>
</template>
