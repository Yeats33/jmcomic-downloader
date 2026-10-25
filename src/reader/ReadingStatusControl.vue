<script setup lang="ts">
import { NRadioGroup, NRadioButton } from 'naive-ui'
import { READING_STATUS_OPTIONS, useReadingLibrary } from './library.ts'
defineProps<{ comicId: number }>()
const library = useReadingLibrary()
</script>
<template>
  <label class="flex items-center gap-1 text-sm" @click.stop>
    阅读状态
    <n-radio-group
      size="small"
      aria-label="阅读状态"
      :value="library.statusFor(comicId)"
      @update:value="library.setStatus(comicId, $event)">
      <n-radio-button v-for="option in READING_STATUS_OPTIONS" :key="option.value" :value="option.value">
        {{ option.label }}
      </n-radio-button>
    </n-radio-group>
  </label>
</template>
