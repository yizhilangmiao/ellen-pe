import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

// 产物直接落到 Gradle 模块的 assets/public（Capacitor 的 webDir = public），
// `npm run build` 一次到位，不需要额外拷贝。
export default defineConfig({
  base: './',
  build: {
    outDir: fileURLToPath(new URL('../app/src/main/assets/public', import.meta.url)),
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: true,
    rollupOptions: {
      // 两页：index.html = 正式 app 壳；probe.html = M1/M2 探针页（验收用，不进发布）
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        probe: fileURLToPath(new URL('./probe.html', import.meta.url)),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
