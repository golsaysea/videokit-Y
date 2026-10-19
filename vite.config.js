import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'

// 手动复制静态 JS 文件并为 dist/index.html 注入内容哈希参数（防止版本更新后命中旧 V8 Code Cache 导致白屏）
function copyStaticFiles() {
  return {
    name: 'copy-static-files',
    writeBundle() {
      const distDir = resolve(__dirname, 'dist')
      const srcDir = resolve(__dirname, 'src')

      if (!existsSync(distDir)) {
        mkdirSync(distDir, { recursive: true })
      }

      let pkgVersion = '0.0.0'
      try {
        const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'))
        if (pkg.version) pkgVersion = String(pkg.version)
      } catch (_) {}

      // 复制所有 JS 文件（Vite 不会打包非 module 的 script）并计算内容哈希
      const jsFiles = readdirSync(srcDir).filter(f => f.endsWith('.js'))
      const fileHashes = new Map()
      jsFiles.forEach(file => {
        const src = resolve(srcDir, file)
        const dest = resolve(distDir, file)
        if (existsSync(src)) {
          copyFileSync(src, dest)
          const hash = createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 10)
          fileHashes.set(file, `${pkgVersion}-${hash}`)
          console.log(`Copied ${file} to dist/ (v=${pkgVersion}-${hash})`)
        }
      })

      // 将 dist/index.html 中的静态脚本引用附加 ?v=<version>-<hash>，确保更新后 V8 Code Cache 自动失效重建
      const distHtmlPath = resolve(distDir, 'index.html')
      if (existsSync(distHtmlPath)) {
        let html = readFileSync(distHtmlPath, 'utf8')
        html = html.replace(
          /(<script\b[^>]*\bsrc=["'])(?:\.\/)?([a-zA-Z0-9._-]+\.js)(?:\?[^"']*)?(["'][^>]*>)/g,
          (full, prefix, fileName, suffix) => {
            const ver = fileHashes.get(fileName)
            if (!ver) return full
            return `${prefix}${fileName}?v=${ver}${suffix}`
          }
        )
        writeFileSync(distHtmlPath, html, 'utf8')
      }
      console.log(`✅ Copied ${jsFiles.length} JS files to dist/ with V8 Code Cache busting`)
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
