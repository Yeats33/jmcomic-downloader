import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import vueJsx from '@vitejs/plugin-vue-jsx'

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST

// https://vitejs.dev/config/
export default defineConfig(async ({ command }) => {
  // 动态加载devtools插件，加载失败时不阻塞本地开发
  const vueDevTools =
    command === 'serve'
      ? await import('vite-plugin-vue-devtools')
          .then(({ default: plugin }) => plugin())
          .catch((error) => {
            console.warn('Skipping vite-plugin-vue-devtools because it failed to load:', error)
            return undefined
          })
      : undefined

  return {
    plugins: [vue(), UnoCSS(), vueJsx(), vueDevTools],

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 5005,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: 'ws',
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell vite to ignore watching `src-tauri`
        ignored: ['**/src-tauri/**'],
      },
    },
  }
})
