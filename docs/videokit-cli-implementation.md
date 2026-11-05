# VideoKit Headless CLI (`videokit-cli`) 实现说明与验收报告

本文档对应《VideoKit Headless CLI 改造需求书 v1.1》，说明 `videokit-cli` 无界面命令行工具、任务配置 Schema、退出码契约、后端已知 Bug 修复及 A1–A11 自动化验收结果。

---

## 1. 交付物清单

| 交付项 | 路径 | 说明 |
|---|---|---|
| Headless CLI 主程序 | `bin/videokit-cli.cjs` | 纯 Node.js + FFmpeg 无头渲染与校验引擎（无需 X11 / `DISPLAY`） |
| Linux/macOS 可执行入口 | `bin/videokit-cli` | POSIX `#!/usr/bin/env node` 入口脚本 |
| Windows 可执行入口 | `bin/videokit-cli.cmd` | Windows 命令行包装脚本 |
| Electron `--headless` 转发 | `electron/main.js` | 支持 `VideoKit --headless ...` 在创建窗口前直接转发给 CLI |
| ASS 字幕无头渲染适配 | `src/reels-subtitle-processor.js` | 无 DOM 环境下的纯 JS 字宽测量回退、缩放坐标、`credit` 水印与逐词卡拉 OK |
| 内置离线字体 | `resources/fonts/Anton-Regular.ttf`、`assets/fonts/` | 内置 `Anton`、`Arimo` 等字体并通过 `libass` `fontsdir` 离线加载 |
| 最小可运行示例包 | `examples/cli-demo/` | 含 `task-0001.json`、`task-0002-srt.json`、`batch-demo.json`、`heaven-0001.png`、`0001.mp3`、`0001.srt` |
| 自动化验收测试 | `tests/videokit-cli.test.js` | 覆盖 A1–A11 全部验收用例与后端 3 项修复校验 |
| 后端 Bug 修复 | `backend/server.py` | 修复 Waitress `recv_timeout`、`/api/srt/seamless` 500 错误、`/api/media/convert` 输出目录未创建 |

---

## 2. 命令用法与参数

### 2.1 子命令

```bash
# 1. 单条任务合成
videokit-cli reels --task <task.json> [--output <out.mp4>]

# 2. 批量任务合成（支持目录或批量清单 JSON）
videokit-cli reels --batch <tasks-dir-or-manifest.json> [--output-dir <dir>]

# 3. 干跑校验（检查 JSON Schema、素材文件、字体、字幕时间戳、FFmpeg 可用性）
videokit-cli validate --task <task.json>

# 4. 配音合成
videokit-cli tts --task <tts-task.json> [--config ~/.config/videokit/config.json]

# 5. 版本与帮助
videokit-cli --version
videokit-cli --help
```

### 2.2 常用选项

| 参数 | 说明 |
|---|---|
| `--task <file>` | 单任务 JSON 配置文件路径 |
| `--batch <dir-or-file>` | 批量任务目录或批量清单 JSON 文件 |
| `--output, -o <file>` | 单任务输出 MP4 路径（覆盖任务 JSON 内的 `output`） |
| `--output-dir <dir>` | 批量输出目录（默认 `./out`，自动创建） |
| `--config <file>` | 全局配置文件路径（默认 `~/.config/videokit/config.json`） |
| `--quality <high\|medium\|low>` | 渲染画质预设（默认 `medium`） |
| `--dry-run` | 仅做完整校验并向 `stderr` 打印 `ffmpeg` 命令，不实际渲染 |
| `--overwrite` | 覆盖已存在的输出文件 |
| `--skip-existing` | 跳过已存在且非空输出文件的任务（用于批量断点续跑） |
| `--fail-fast` | 批量模式下遇到首个失败任务立即中止后续任务 |
| `--timeout <sec>` | 单任务渲染超时秒数（默认 `600`，超时强制终止 `ffmpeg` 子进程并清理 `.tmp`） |
| `--quiet, -q` | 静默模式，不在 `stdout` 输出 `progress` 行，仅输出最终结果 JSON |
| `--keep-temp` | 保留临时 `.ass` 字幕文件与工作目录，便于排查字幕坐标与样式 |
| `--jobs <N>` | 批量并发数（默认 `1`，推荐串行以保障稳定性） |

### 2.3 退出码与标准输出契约

- `0`：全部成功。`stdout` 最后一行为单行 JSON：
  ```json
  {"status":"ok","output":"/abs/path/0001.mp4","duration":3,"width":720,"height":1280}
  ```
- `1`：通用运行时错误（如输出文件已存在且未传 `--overwrite`、批量任务存在部分失败）
- `2`：参数错误或任务 JSON 校验失败（`INVALID_ARGS`、`INVALID_JSON`、`INVALID_DIMENSIONS`、`INVALID_FPS`、`PATH_TRAVERSAL`、`SEGMENT_OVERLAP`、`INVALID_SEGMENT_TIME`、`INVALID_SRT`）
- `3`：素材文件不存在、字体不存在或 `ffmpeg`/`ffprobe` 缺失（`FILE_NOT_FOUND`、`FONT_NOT_FOUND`、`FFMPEG_NOT_FOUND`）
- `4`：`ffmpeg` 渲染失败或渲染超时（`RENDER_FAILED`、`RENDER_TIMEOUT`）
- `5`：API Key 缺失（`API_KEY_MISSING`）

所有非零退出均在 `stderr` 输出单行结构化 JSON：
```json
{"status":"error","code":"FILE_NOT_FOUND","message":"File not found for 'bgPath': ...","task":"0001"}
```

---

## 3. 后端 Bug 修复说明（`backend/server.py`）

1. **Bug 1（Waitress 启动参数崩溃）**：移除 `waitress.serve()` 中不支持的 `recv_timeout=30` 与 `send_timeout=60` 参数，并将 `except ImportError:` 扩展为 `except Exception as waitress_err:`，确保任何异常均可平滑回退至 Flask。
2. **Bug 2（`/api/srt/seamless` 500 错误）**：将 `srt_info.srt_data` 与 `start`/`end` 修正为 `SrtParse` 类的实际属性 `srt_info.srtInfos` 与 `startTime`/`endTime`（同时修复了相邻的 `/api/srt/compute-char-time`）。
3. **Bug 3（`/api/media/convert` 输出目录不存在导致 FFmpeg 退出码 254）**：在 `media_convert()` 计算 `out_dir` 后立即执行 `os.makedirs(out_dir, exist_ok=True)`。

---

## 4. 验收清单（A1–A11）执行结果

| 编号 | 验收项 | 结果 | 验证说明 |
|---|---|---|---|
| **A1** | CLI 基础可用性（`DISPLAY=""` 下 `--help` / `--version`） | PASS | 退出码 `0`，无 X11 / Electron GUI 依赖 |
| **A2** | 单任务合成（静态图背景 + 内联 `segments`） | PASS | 输出 `720×1280`、`h264` + `aac`、`30fps`、时长与音频一致 |
| **A3** | 单任务合成（静态图背景 + 外部 `srtPath`） | PASS | 自动解析 UTF-8/CRLF SRT 并烧录字幕，退出码 `0` |
| **A4** | 批量任务合成（多条任务 + `manifest.json` 汇总） | PASS | 生成全部 MP4 及 `manifest.json`（`total: 2, succeeded: 2, failed: 0`） |
| **A5** | 校验失败（素材路径不存在） | PASS | 退出码 `3`，`stderr` 输出 `"code":"FILE_NOT_FOUND"` |
| **A6** | 校验失败（字体不存在） | PASS | 退出码 `3`，`stderr` 输出 `"code":"FONT_NOT_FOUND"` |
| **A7** | 校验失败（非法宽高 / 字幕时间重叠 / `..` 路径越界） | PASS | 退出码 `2`，分别返回 `INVALID_DIMENSIONS`、`SEGMENT_OVERLAP`、`PATH_TRAVERSAL` |
| **A8** | ASS 字幕文件检查（`--keep-temp`） | PASS | 包含 `PlayResX: 720`、`Style: Default,Anton,49`、`\pos(360,666)`、`{\kf...}`、`Style: Credit` |
| **A9** | 断点续跑（`--skip-existing`） | PASS | 已存在输出文件耗时 `< 0.5s` 跳过，`status: "skipped"` |
| **A10** | 批量单任务失败隔离与 `--fail-fast` | PASS | 默认隔离失败任务并继续其余任务；`--fail-fast` 遇错立即停止 |
| **A11** | 超时保护与原子输出（`--timeout`） | PASS | 超时强杀 `ffmpeg`，退出码 `4`（`RENDER_TIMEOUT`），自动清理 `.tmp` 文件 |
