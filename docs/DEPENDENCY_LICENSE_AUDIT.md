# Edge 配音依赖许可核对

核对日期：2026-09-20。本记录仅覆盖本次 VideoKit 新增功能；不改变父目录 Subtitled 的依赖统计或项目许可。

| 新增直接运行依赖 | 版本 | 许可 | 开源 | 核对依据 |
|---|---|---|---|---|
| edge-tts | 7.2.8 | LGPL-3.0（发布元数据标注 LGPLv3） | 是 | PyPI 发布元数据及安装包 LICENSE |

来源：
- https://pypi.org/project/edge-tts/7.2.8/
- https://github.com/rany2/edge-tts
- https://github.com/rany2/edge-tts/blob/master/LICENSE

原始许可证副本：third-party/edge-tts/LICENSE。上游代码未修改。requirements-edge.txt 固定直接依赖版本；安装在 .venv-edge 中，以独立 Python 进程调用，可替换或升级。虚拟环境不提交到 Git。

LGPL 依赖可与父项目的 GPL-3.0-only 使用方式兼容。VideoKit 自身原快照未提供项目级 LICENSE，本说明不为其新增授权。若将 Python 运行环境另行打包发布，需要同时保留依赖许可、版权、对应源代码获取方式及用户替换库的能力；本次仅验证本地源码启动版。

新增直接依赖数：1。aiohttp、certifi、tabulate、typing-extensions 等为传递依赖，未计入直接依赖数量。环境安装保留各包自带 dist-info 许可文件。

## 4.4.40 Windows release

Edge TTS 7.2.8 LGPL-3.0 source: https://pypi.org/project/edge-tts/7.2.8/ . Included as replaceable external Python files with dist-info licenses; bridge is outside app.asar. VIDEOKIT_EDGE_PYTHON can select a replacement interpreter.

Compatible npm security patches retain upstream licenses (Axios and electron-builder/electron-updater: MIT, https://github.com/axios/axios/blob/v1.x/package.json and https://github.com/electron-userland/electron-builder/blob/master/LICENSE). No project-wide relicensing is asserted.

Bundled font license presence checked, including restored Noto Serif italic OFL notice. Personal fonts excluded. Python retains LICENSE.txt and installed package dist-info. FFmpeg is an external GPL build from https://github.com/BtbN/FFmpeg-Builds with original LICENSE.txt; build scripts/source acquisition instructions: https://github.com/BtbN/FFmpeg-Builds .

The original VideoKit snapshot has no top-level LICENSE; this audit records dependency notices only and does not grant additional rights to upstream source.

## 2026-10-11 compatible security maintenance

Direct runtime dependency counts and licenses are unchanged. PyInstaller build declaration is now 6.22.1 (GPL-2.0-or-later with bootloader exception; https://pyinstaller.org/en/stable/license.html). Transitive fixes: urllib3 2.8.0 (MIT), multidict 6.9.1 (Apache-2.0), http-cache-semantics 4.3.0 (BSD-2-Clause), source-map-js 1.2.2 (BSD-3-Clause). Installed dist-info and npm package license metadata were retained; no bundled font/license changes. See the 2026-10-11 security report for remaining major-version risks.

## 4.4.41 macOS release runtime

Mac bundles architecture-matched Python 3.11.17 from astral-sh/python-build-standalone release 20261009, preserving the runtime license files. FFmpeg/FFprobe from eugeneware/ffmpeg-static b6.1.1 preserve each architecture's LICENSE and README, including upstream build/source provenance (https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1). Downloaded artifacts are checked against recorded SHA256 digests in scripts/macos-runtime-assets.json. Edge TTS remains an externally replaceable LGPL Python dependency. No change to the upstream project's license is asserted.
