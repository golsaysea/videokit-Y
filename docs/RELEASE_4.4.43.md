# VideoKit 4.5.3

更新仓库：golsaysea/videokit-Y。

## 下载

- **Windows x64**：`VideoKit-Setup-4.5.3.exe` 安装版，或 `VideoKit-Setup-4.5.3.zip` 便携版。
- **macOS Apple Silicon（M 系列）**：`VideoKit-4.5.3-macOS-arm64.dmg` / `.zip`。
- **macOS Intel**：`VideoKit-4.5.3-macOS-x64.dmg` / `.zip`。
- **Linux x64**：`VideoKit-4.5.3-Linux-x64.AppImage`、`VideoKit-4.5.3-Linux-x64.deb`、`VideoKit-4.5.3-Linux-x64.tar.gz`。
- 同时发布 Windows、macOS、Linux 自动更新元数据和 SHA256 校验清单。

## 本次更新（v4.5.3 退伍军人节专题部件与滚动字幕样式库）

- **🇺🇸 美国退伍军人节（Veterans Day）全套专题部件更新**：
  - **5 款退伍军人节专属矢量出字笔尖图标**：
    - `🇺🇸 美国星条旗荣耀盾徽` (`us_flag_shield`)
    - `🎖️ 紫心英勇勋章笔` (`purple_heart_medal`)
    - `🦅 美国白头海雕金章` (`bald_eagle_crest`)
    - `🌺 阵亡将士纪念红罂粟花` (`veteran_poppy`)
    - `🏷️ 美军银色纪念狗牌` (`military_dog_tag`)
  - **4 款退伍军人节文字底衬 + 4 款整卡大画板**：
    - 文字底衬：`🇺🇸 美国星条旗荣耀绶带` (`vet_stars_stripes_ribbon`)、`🎖️ 退伍军人金章深蓝横幅` (`vet_honor_medal_banner`)、`🏷️ 美军拉丝钢印铭牌底衬` (`vet_dogtag_steel`)、`🌺 纪念虞美人花宣纸贴条` (`vet_poppy_parchment`)。
    - 整卡画板：`🇺🇸 美国星条旗荣耀画框板` (`vet_stars_stripes_board`)、`🎖️ 退伍军人金章礼服画板` (`vet_honor_medal_board`)、`🏷️ 美军拉丝钢印铭牌画板` (`vet_dogtag_steel_board`)、`🌺 纪念虞美人花羊皮信纸板` (`vet_poppy_memorial_board`)。
  - **4 款退伍军人节全屏装饰覆层（新增 `🇺🇸 退伍军人` 分类）**：
    - `🇺🇸 星条旗三角彩旗与金星边框` (`vet_stars_stripes_bunting`)
    - `🎖️ 荣耀紫心勋章与烫金军礼框` (`vet_golden_eagles_medals`)
    - `🌺 致敬老兵纪念虞美人花框` (`vet_remembrance_poppies`)
    - `🎆 爱国红白蓝星芒礼花点缀` (`vet_salute_fireworks_stars`)
  - **4 款退伍军人节 T字幕预设（`sub-68` ~ `sub-71`）**：
    - `sub-68`：`🇺🇸 星条旗荣耀绶带_星盾出字 (退伍军人节)`
    - `sub-69`：`🎖️ 老兵金章礼服带_勋章跟读 (退伍军人节)`
    - `sub-70`：`🏷️ 美军金属狗牌铭牌_钢印逐词 (退伍军人节)`
    - `sub-71`：`🌺 纪念虞美人花信纸_敬礼跟读 (退伍军人节)`
  - **4 款退伍军人节滚动字幕预设（`sc-35` ~ `sc-38` / `scroll-35` ~ `scroll-38`）**：
    - `sc-35`：`🇺🇸 星条旗荣耀连体底带+星盾笔尖出字`
    - `sc-36`：`🎖️ 老兵金章深蓝绶带+紫心勋章逐词跟读`
    - `sc-37`：`🏷️ 美军拉丝钢印铭牌底带+军牌笔尖写出`
    - `sc-38`：`🌺 纪念虞美人花宣纸贴条+红罂粟花逐词出字`
- **📜 滚动字幕覆层可视化样式库（`sc-01` ~ `sc-38`）**：
  - 滚动字幕覆层面板新增与 T字幕一致的分类可视化样式选择器，内置 38 款分类滚动字幕样式（经典描边、渐变流光、半透底框、固定标题+滚动、贴字底衬与节日画板、语音出字与跟读高亮）。
  - 支持在 CLI 与云端渲染任务中直接通过 `sc-01` ~ `sc-38`（或 `scroll-01` ~ `scroll-38`）编号一键调取。
- **🌐 原生 Web 网页版与云端 CLI 1:1 渲染对齐**：
  - 支持 `videokit-web` 独立 Web 服务与浏览器桥接层（`web-bridge.js`），以及全部 156 个内置预设编号（`se-*`、`sub-*`、`ov-*`、`sc-*`）的 WYSIWYG 无头渲染。


