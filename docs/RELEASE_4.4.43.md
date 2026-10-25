# VideoKit 4.4.47

更新仓库：golsaysea/videokit-Y。

## 下载

- **Windows x64**：`VideoKit-Setup-4.4.47.exe` 安装版，或 `VideoKit-Setup-4.4.47.zip` 便携版。
- **macOS Apple Silicon（M 系列）**：`VideoKit-4.4.47-macOS-arm64.dmg` / `.zip`。
- **macOS Intel**：`VideoKit-4.4.47-macOS-x64.dmg` / `.zip`。
- **Linux x64**：`VideoKit-4.4.47-Linux-x64.AppImage`、`VideoKit-4.4.47-Linux-x64.deb`、`VideoKit-4.4.47-Linux-x64.tar.gz`。
- 同时发布 Windows、macOS、Linux 自动更新元数据和 SHA256 校验清单。

## 本次更新

- **4.4.47 更新后白屏与无法启动全面修复**：
  - 修复自动更新重启（`quitAndInstall`）与窗口关闭保存拦截器的竞态冲突，退出更新前主动保存工程、清理会话代码缓存并释放单实例锁，避免安装程序覆盖被占用文件或新进程因单实例锁残留无法启动。
  - 升级 `CodeCacheGuard`：使用 `original-fs` 精确校验 `app.asar` 包签名；更新或异常重启时同步清理 `Code Cache` 与 `GPUCache` / `DawnGraphiteCache` / `DawnWebGPUCache` 着色器缓存（100% 保留用户工程、预设与模板）；遇到文件锁时支持原位清理字节码且不错误覆盖状态文件。
  - 增强白屏自愈：校验前端核心 JS（`window.switchTab` 与 `_reelsState`）实际挂载状态并内置 10 秒启动看门狗，遇到白屏自动清理缓存重载；优化启动预设加载避免重复全量扫描 LevelDB 阻塞主线程。
- **批量 Reels 与时间轴交互升级**：
  - 支持导入音频与字幕时按自然数字排序，支持将单个或多个视频/图片直接拖拽至指定任务行，修复清空任务后重载恢复旧数据问题。
  - 批量表格视频预览改为静态缩略图缓存 + 单实例悬停动态预览，大幅降低大批量任务时的显存与解码开销。
- **宽色域（HDR / HLG / PQ / BT.2020 / Display P3）自动识别与转码**：
  - 导入预览自动检测 HDR / 宽色域视频并转换为标准 BT.709 预览代理，解决预览偏灰或过曝问题。
- **T 字幕样式与逐字动画扩展**：
  - 新增 T 字幕文字渐变（支持按整行或按每词渐变）、非破坏式一键大写开关、朗读高亮独立开关、自适应连体贴合背景框。
  - 新增 6 种逐字（Per-Character）动画系统（弹跳、波浪、打字机、缩放、旋转、闪烁）及参数调节。
- **字体系统与覆层编辑体验优化**：
  - 统一字体库系统（支持全部英文/多语言分类字体实时搜索与 Google Fonts 按需下载缓存，覆盖 T 字幕、文本覆层、文字卡片、滚动覆层），修复 Windows 本地字体扫描偶发遗漏问题。
  - 修复覆层模板名称输入时失去焦点问题；滚动覆层新增大写转换与字间距实时预览同步。
- **全面应用安全加固**：
  - 加固 `yt-dlp` 参数校验、DaVinci Resolve / FCPXML 导出脚本序列化、`open-external` / `openFolder` 协议与目录校验、`local-media://` 敏感文件隔离、API Key 本地 `safeStorage` 加密存储及前端 DOM XSS 防护。

