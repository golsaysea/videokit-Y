# VideoKit 4.4.41

更新仓库：golsaysea/videokit-Y。

## 下载

- Windows x64：Setup.exe 安装版，或 Setup.zip 便携版。
- Mac Apple Silicon（M 系列）：macOS-arm64.dmg。
- Mac Intel：macOS-x64.dmg。
- 同时发布两个平台自动更新元数据和 SHA256 校验清单。

## 本次更新

- 包含最新字幕/队列/微软语音功能及兼容安全修复。
- 导入预设的绑定名称使用纯文本，避免执行导入的 HTML。
- 桌面特权调用校验来源；保留启动预设恢复和滚动绑定行为。
- 更新下载强制 HTTPS，补强解压的符号链接检查。
- 修复兼容依赖告警并固定 CI Action 提交。
- Mac 包含对应架构 Python、Edge TTS、FFmpeg 和 FFprobe。

## 已知限制

Electron/Vite 大版本迁移、解压库替换按维护者决定延期，不能视为所有安全告警已清零。Mac 使用 ad-hoc 签名，未使用 Apple Developer ID 签名或公证；系统可能要求在“隐私与安全性”中允许打开，受签名要求影响的自动安装可改用手动下载安装包。不要全局关闭系统安全保护。

请先备份自己的任务和预设。GitHub 构建验证不替代真实媒体项目在每台设备上的完整使用验证。
