# VideoKit 4.6.9-beta (测试版)

## 本次测试版更新内容

1. **完整恢复滚动字幕预设库（214 款预设 + 14 款一键特效）**：
   - 全量恢复 `sc-01` ~ `sc-214` / `scroll-01` ~ `scroll-214` 共 **214** 款滚动字幕风格预设（`428` 条 ID 映射），保留 Facebook 热门款直出效果，同时继续兼容 `ov-16..ov-35` 与 `sub-245..sub-250`。
   - 恢复一键打字机/特效风格面板全部 **14** 款按钮（含退伍军人勋章、复古旧报纸、撕纸手账、玫瑰情书），并在样式选择弹窗中恢复 `✨ 新增100款祷告风` 导航分页与 `🍔 美食/节日/旅途/音乐` 筛选分类。

2. **新增 VideoKit × Canva 插件桥接后端与 App 脚手架**：
   - 新增 [canva-bridge.js](../electron/services/canva-bridge.js) 与 Web 服务接口：
     - `GET /api/canva/presets`：导出可直接在 Canva App 侧边栏展示的逐句与滚动字幕预设目录。
     - `POST /api/canva/render`：校验安全的 Canva/HTTPS 媒体 URL，支持自动切句与 SRT 时间轴，在本地异步渲染带字幕视频与首帧缩略图。
     - `GET /api/canva/jobs/:jobId`、`GET|HEAD /api/canva/files/:jobId/:fileToken/(render.mp4|thumb.jpg)`：提供任务状态轮询及带 Token 校验和 `Range` 断点续传的成品访问接口。
   - 新增 `canva-app/` Canva Apps SDK v2 客户端脚手架与 [CANVA_APP_SETUP.md](./CANVA_APP_SETUP.md) 接入说明文档（本地开发测试版本）。

## 安装包（Pre-release 测试版）
- **Windows**：`VideoKit-Setup-4.6.9-beta.exe` / `VideoKit-Setup-4.6.9-beta.zip`
- **macOS**：`VideoKit-4.6.9-beta-arm64.dmg` / `VideoKit-4.6.9-beta-x64.dmg`（以及对应 `-mac.zip`）
- **Linux**：`VideoKit-4.6.9-beta.AppImage`
