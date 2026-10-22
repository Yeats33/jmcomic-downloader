<script setup lang="ts">
import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { useStore } from '../store.ts'
import { bookmarkKey, useReadingLibrary } from './library.ts'
import ReadingStatusControl from './ReadingStatusControl.vue'
import type { ReaderMode } from './history.ts'
const props = defineProps<{ comicId: number; chapterId: number; page: number; mode: ReaderMode }>()
const store = useStore()
const library = useReadingLibrary()
const current = computed(() => store.readingHistory.find((entry) => entry.comicId === props.comicId &&
  entry.chapterId === props.chapterId && entry.mode === props.mode && entry.page === props.page))
const bookmarked = computed(() => current.value !== undefined && library.bookmarks.some((entry) =>
  current.value !== undefined && bookmarkKey(entry) === bookmarkKey(current.value)))
</script>
<template>
  <n-button size="small" class="text-white!" :disabled="!current" :aria-pressed="bookmarked"
    @click="current && library.toggle(current)">{{ bookmarked ? '移除本页书签' : '收藏本页' }}</n-button>
  <ReadingStatusControl :comic-id="comicId" />
  <span v-if="library.error" class="text-red-3 text-sm" role="alert">{{ library.error }}</span>
</template>
