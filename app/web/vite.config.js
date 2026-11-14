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
        // bench.html = 召回体检页（合成记忆 + 查询集跑 hit@1/hit@3）。
        // 默认不入包：要跑就把下一行解注再 build 到 _临时，跑完记得注释回来，
        // 别把内部体检页跟着正式包发出去。
        // bench: fileURLToPath(new URL('./bench.html', import.meta.url)),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
