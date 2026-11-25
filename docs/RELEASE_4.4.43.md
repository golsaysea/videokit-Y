# VideoKit 4.6.22 (正式版)

## 本次 4.6.22 正式版核心更新（整合 4.6.9-beta ~ 4.6.22-beta 全量新特性与修复）

### 1. 🧩 独立「双层拼接」合成工作台与 Batch Reels / WYSIWYG 无缝打通
- **全新独立 `🧩 双层拼接` 页面**（[reels-dual-compositor.js](../src/reels-dual-compositor.js)、[reels-composite-mask.js](../src/reels-composite-mask.js)）：支持背景底层与前景叠加层多模式混合、**四向边缘羽化（上/下/左/右独立渐变遮罩）**、实时缩放/位置调整、底部播放控制条完整防裁切适配，并可一键推送至 **Batch Reels 队列** 参与无损 WYSIWYG 导出。

### 2. 💬 Facebook 爆款 T 字幕、3D 旋转金十字架与滚动字幕库全量升级
- **新增多款爆款 T 字幕预设（`sub-251` ~ `sub-255`）**：
  - `sub-255`：**🟢 三词上推递进_白绿递增**（3 行逐词上推递进白绿高亮堆叠，完整打通实时预览与批量导出）。
  - `sub-254`：**🎬 马库斯_黄橙渐变3行逐字弹出**（搭配动态混合排版与 `Nerko One` / `DynaPuff` 等圆润展示字体）。
  - `sub-251` ~ `sub-253`：Daily Prayers 橙白黑边首尾大字堆叠、白黄斜体逐词堆叠、白粉立体祈祷逐词堆叠。
- **全新 `ov-36` 爆款滚动卡片（`36-FB爆款_3D旋转金十字架+奶油条祈祷滚词`）**：支持顶部 **3D 旋转金色十字架** 与 `#FDE9CE` 四向羽化奶油行内胶囊滚动正文同步呈现。
- **全量滚动字幕预设库转正（`sc-01` ~ `sc-214`）**：`214` 款滚动字幕风格预设（`428` 条 ID 映射）、`14` 款一键特效、`31` 块底板与 `78` 枚徽章完整上线；支持 **逐行追踪高亮（`speech_or_progress` 默认 + `keep_read_color` 保持已读色与光标/下划线同步）**，以及纯色块背景 **4 向羽化同步与更大内边距调节**。

### 3. 🎬 88 款工作室片头特效与贴纸系统跨端全打通
- **新增高颜值片头与视觉材质**：`curtain_red_reveal`（红丝绒对开帘幕拉开 + 窗帘上沿遮幅）、`fb_yellow_stack_hook`（白黄斜体逐词开场钩子），以及实拍质感木门/谷仓门、白头鹰与红雀水墨特效、美国/加拿大国旗、Morandi 水彩/羊皮纸/复古报纸等 **88** 款片头（含 **50+** 款北美爆款开场），通过 `CLI`、`Web`、`Flask` 与 `Canva API` 全端统一曝光并自动路由至 WYSIWYG 渲染管线。
- **贴纸与分面板解耦架构**：`ReelsIntroPanel`、`ReelsStickerPanel` 与 `ReelsDecorPanel` 独立解耦，修复贴纸全时长播放、`sway_bell`/`twinkle` 动画及多页面同步问题；`Preview V2`/`V1` 新增开场后人声时间轴精准对齐修复与 `Ctrl+F` 全屏预览切换。

### 4. ☁️ 云端工程管理中心、个人字体扩展包与时间轴稳定性增强
- **云端工程库与 9:16 实时预览**：支持 `.vktpl`/文件夹链接一键拆解同步至本地工程库与云端缓存，新增 Google Drive 媒体自动下载器（自动避免 `标签3`/`标签25` 通用目录冲突并回填 `bgSrcUrl`/`audioSrcUrl`）、工程项目列表 **9:16 无损实时预览弹窗** 及可选启动自动同步最新版本策略。
- **个人字体扩展包导入**：支持 `.zip` 压缩包与多字体批量持久化导入，内置扩展字体（含 `Nerko One` / `DynaPuff` 等）自动入库，一键应用至预览与导出。
- **时间轴与多轨配音防误报优化**：时间轴编辑器忽略音频轨道空白告警并防止头部徽章重叠；新增超时残留配音自动清理流程。

### 5. 🎨 VideoKit × Canva 插件桥接与服务端热更新支持
- 新增 [canva-bridge.js](../electron/services/canva-bridge.js) 与 `canva-app/` Canva Apps SDK v2 客户端脚手架，提供 `/api/canva/presets`、`/api/canva/render`（带 SSRF 安全校验）与 `/api/canva/jobs/:jobId` Token 化媒体分发接口。

---

### 安装包说明
- Windows 安装版: `VideoKit-Setup-4.6.22.exe`（自动检测覆盖升级并保留全部本地设置与工程数据）
- Windows 压缩包: `VideoKit-Setup-4.6.22.zip`
- macOS Apple Silicon (M系列): `VideoKit-4.6.22-macOS-arm64.dmg` / `VideoKit-4.6.22-macOS-arm64.zip`
- macOS Intel (x64): `VideoKit-4.6.22-macOS-x64.dmg` / `VideoKit-4.6.22-macOS-x64.zip`
- Linux: `VideoKit-4.6.22-Linux-*.AppImage` / `.deb` / `.tar.gz`
