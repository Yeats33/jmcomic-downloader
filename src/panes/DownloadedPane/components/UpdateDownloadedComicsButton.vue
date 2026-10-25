<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useStore } from '../../../store.ts'
const store = useStore()
</script>
<template>
  <n-button size="small" @click="store.currentTabName = 'updates'">更新库存</n-button>
</template>
