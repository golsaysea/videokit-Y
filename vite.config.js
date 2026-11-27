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

      // 同步复制核心样式表到 dist/ 并显式保留在 <head> 中同步加载。
      // Rollup IIFE 打包会把 CSS 内联到 defer 的 JS 包内，导致软件打开时先渲染未样式化 HTML；
      // 在 <head> 中保留真实 <link rel="stylesheet"> 可确保首帧 0ms 即呈完整深色主题界面。
      const staticCssEntries = [
        { src: resolve(srcDir, 'styles.css'), outName: 'styles.css' },
        { src: resolve(srcDir, 'sort-upload.css'), outName: 'sort-upload.css' },
        { src: resolve(srcDir, 'studio', 'starry-theme.css'), outName: 'starry-theme.css' },
      ]
      const cssHashes = new Map()
      staticCssEntries.forEach(({ src, outName }) => {
        if (!existsSync(src)) return
        const dest = resolve(distDir, outName)
        copyFileSync(src, dest)
        const hash = createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 10)
        cssHashes.set(outName, `${pkgVersion}-${hash}`)
        console.log(`Copied ${outName} to dist/ (v=${pkgVersion}-${hash})`)
      })

      // 同步复制开场效果配乐 assets/intro-audio/*.mp3 到 dist/assets/intro-audio/（Web / Vite 预览 & file:// 兜底）
      const introAudioSrcDir = resolve(__dirname, 'assets', 'intro-audio')
      const introAudioDestDir = resolve(distDir, 'assets', 'intro-audio')
      if (existsSync(introAudioSrcDir)) {
        const audioFiles = readdirSync(introAudioSrcDir).filter(f => /\.(mp3|wav|m4a|ogg)$/i.test(f))
        if (audioFiles.length > 0) {
          mkdirSync(introAudioDestDir, { recursive: true })
          audioFiles.forEach(file => {
            copyFileSync(resolve(introAudioSrcDir, file), resolve(introAudioDestDir, file))
          })
          console.log(`Copied ${audioFiles.length} intro audio tracks to dist/assets/intro-audio/`)
        }
      }

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
        // Packaged Electron loads dist/index.html over file:// with webSecurity: true.
        // Convert Vite's built IIFE bundle & stylesheet tags so Chromium file:// loads without CORS blocks.
        html = html
          .replace(/<script\b([^>]*?)\btype=["']module["']([^>]*?)\bsrc=(["']\.\/assets\/[^"']+["'])([^>]*)><\/script>/g,
            (_m, pre, mid, src, post) => {
              const attrs = `${pre}${mid}${post}`.replace(/\s*\bcrossorigin\b(?:=["'][^"']*["'])?/gi, '').trim()
              return `<script defer src=${src}${attrs ? ' ' + attrs : ''}></script>`
            })
          .replace(/(<link\b[^>]*?)\s+\bcrossorigin\b(?:=["'][^"']*["'])?([^>]*>)/gi, '$1$2')

        const injectedLinks = []
        for (const [cssName, ver] of cssHashes.entries()) {
          const re = new RegExp(`<link\\b[^>]*href=["'](?:\\.\\/)?${cssName.replace('.', '\\.')}(?:\\?[^"']*)?["'][^>]*>`, 'i')
          const tag = `  <link rel="stylesheet" href="${cssName}?v=${ver}">`
          if (re.test(html)) {
            html = html.replace(re, tag.trim())
          } else {
            injectedLinks.push(tag)
          }
        }
        if (injectedLinks.length > 0 && /<\/head>/i.test(html)) {
          html = html.replace(/<\/head>/i, `${injectedLinks.join('\n')}\n</head>`)
        }
        writeFileSync(distHtmlPath, html, 'utf8')
      }
      console.log(`✅ Copied ${jsFiles.length} JS files to dist/ with V8 Code Cache busting`)
    },
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        try {
          const urlPath = (req.url || '').split('?')[0].replace(/^\/+/, '')
          if (!urlPath || urlPath.includes('..')) return next()
          const target = resolve(__dirname, 'assets', urlPath)
          if (!existsSync(target)) return next()
          if (target.endsWith('.mp3')) res.setHeader('Content-Type', 'audio/mpeg')
          else if (target.endsWith('.wav')) res.setHeader('Content-Type', 'audio/wav')
          else if (target.endsWith('.m4a')) res.setHeader('Content-Type', 'audio/mp4')
          res.setHeader('Accept-Ranges', 'bytes')
          res.end(readFileSync(target))
        } catch (_) {
          next()
        }
      })
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
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    host: 'localhost',
    cors: false,
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
  },
})
