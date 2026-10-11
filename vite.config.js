import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, existsSync } from 'fs'

// 手动复制静态 JS 文件的插件
function copyStaticFiles() {
  return {
    name: 'copy-static-files',
    writeBundle() {
      const distDir = resolve(__dirname, 'dist')
      const srcDir = resolve(__dirname, 'src')

      if (!existsSync(distDir)) {
        mkdirSync(distDir, { recursive: true })
      }

      // 复制所有 JS 文件（Vite 不会打包非 module 的 script）
      const { readdirSync } = require('fs')
      const jsFiles = readdirSync(srcDir).filter(f => f.endsWith('.js'))
      jsFiles.forEach(file => {
        const src = resolve(srcDir, file)
        const dest = resolve(distDir, file)
        if (existsSync(src)) {
          copyFileSync(src, dest)
          console.log(`Copied ${file} to dist/`)
        }
      })
      console.log(`✅ Copied ${jsFiles.length} JS files to dist/`)
    }
  }
}

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [copyStaticFiles()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    host: 'localhost',
    cors: false,
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
  },
})
