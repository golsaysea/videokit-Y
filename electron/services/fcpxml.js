/**
 * SRT 转 FCPXML 模块 — 完整移植自 core/srt_to_fcpxml.py
 * 生成 Final Cut Pro XML 时间线
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function mediaFileUrl(filePath) {
    if (!filePath) return '';
    if (/^file:\/\//i.test(filePath)) return filePath;
    return pathToFileURL(filePath).href;
}

// ==================== SRT 解析 ====================

/** 解析 SRT 时间码 "HH:MM:SS,mmm" 为毫秒 */
function parseSRTTime(timeStr) {
    const match = timeStr.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!match) return 0;
    const [, h, m, s, ms] = match;
    return parseInt(h) * 3600000 + parseInt(m) * 60000 + parseInt(s) * 1000 + parseInt(ms);
}

/** 解析 SRT 字符串为条目数组 */
function parseSRTString(srtContent) {
    const entries = [];
    const blocks = srtContent.trim().split(/\n\s*\n/);
    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 3) continue;
        const timeLine = lines[1];
        const timeParts = timeLine.split('-->');
        if (timeParts.length !== 2) continue;
        const start = parseSRTTime(timeParts[0]);
        const end = parseSRTTime(timeParts[1]);
        const text = lines.slice(2).join('\n');
        entries.push({
            index: parseInt(lines[0]) || entries.length + 1,
            start,   // 毫秒
            end,     // 毫秒
            text,
            duration: end - start,
        });
    }
    return entries;
}

// ==================== FCPXML 生成 ====================

/** 把 SRT 时间 (ms) 根据帧率转换为分数形式的秒字符串 */
function getFractionTime(timeMs, fps = 30) {
    const frame = Math.floor(timeMs / (1000 / fps));
    // 简化分数
    const num = frame * 100;
    const den = fps * 100;
    const g = gcd(Math.abs(num), Math.abs(den));
    return `${num / g}/${den / g}s`;
}

/** 最大公约数 */
function gcd(a, b) {
    if (b === 0) return a;
    return gcd(b, a % b);
}

/** XML 特殊字符转义 */
function xmlEscape(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * 把多个 SRT 字符串转换到一个 FCPXML 文件中
 * 完整移植自 SrtsToFcpxml
 *
 * @param {string}   sourceSrt       原文 SRT 字符串
 * @param {string[]} transSrts       翻译 SRT 字符串数组
 * @param {string}   savePath        输出 FCPXML 文件路径
 * @param {boolean}  seamlessFcpxml  是否无缝模式
 */
function SrtsToFcpxml(sourceSrt, transSrts, savePath, seamlessFcpxml) {
    const sourceSubs = parseSRTString(sourceSrt);
    const count = sourceSubs.length;
    if (count === 0) {
        console.log('Srt 字幕长度为0');
        return;
    }

    // 读取字幕样式设置
    let subtitleSetting = {};
    const settingPath = path.join(process.cwd(), 'subtitle_pref.json');
    if (fs.existsSync(settingPath)) {
        try {
            subtitleSetting = JSON.parse(fs.readFileSync(settingPath, 'utf-8'));
        } catch { /* 忽略读取错误 */ }
    }
    // 也尝试从 backend 目录读取
    const { getBackendDir } = require('./settings');
    const backendSettingPath = path.join(getBackendDir(), 'subtitle_pref.json');
    if (!Object.keys(subtitleSetting).length && fs.existsSync(backendSettingPath)) {
        try {
            subtitleSetting = JSON.parse(fs.readFileSync(backendSettingPath, 'utf-8'));
        } catch { /* 忽略 */ }
    }

    // 项目名称（从文件名提取）
    const projectName = path.basename(savePath, path.extname(savePath));

    // ---- 构建 XML 字符串（手写 XML，避免引入 XML 库） ----
    let xml = '';
    xml += '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<fcpxml version="1.9">\n';
    xml += '\t<resources>\n';
    xml += '\t\t<format name="FFVideoFormat1080p30" frameDuration="1/30s" width="1920" height="1080" id="r0"/>\n';
    xml += '\t\t<effect name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti" id="r1"/>\n';
    xml += '\t</resources>\n';
    xml += '\t<library>\n';
    xml += `\t\t<event name="${xmlEscape(projectName)}">\n`;
    xml += `\t\t\t<project name="${xmlEscape(projectName)}">\n`;

    const duration = getFractionTime(sourceSubs[count - 1].end);
    xml += `\t\t\t\t<sequence tcFormat="NDF" tcStart="0/1s" duration="${duration}" format="r0">\n`;
    xml += '\t\t\t\t\t<spine>\n';

    // 保存每个 title 节点的子 title（翻译层）位置
    const titlePositions = [];
    let totalIndex = 0;
    let preSubEnd = 0;

    for (let i = 0; i < count; i++) {
        const sub = sourceSubs[i];

        // 非无缝模式：插入 gap
        if (!seamlessFcpxml) {
            if (preSubEnd < sub.start) {
                const gapOffset = getFractionTime(preSubEnd);
                const gapDuration = getFractionTime(sub.start - preSubEnd);
                xml += `\t\t\t\t\t\t<gap name="Gap" start="3600/1s" offset="${gapOffset}" duration="${gapDuration}"/>\n`;
            }
        }

        let start = sub.start;
        if (seamlessFcpxml && sub.start > 34) {
            start = sub.start - 34;
        }
        const startStr = getFractionTime(start);

        let dur = sub.duration;
        if (seamlessFcpxml && i < count - 1) {
            dur = sourceSubs[i + 1].start - start;
        }
        const durationStr = getFractionTime(dur);

        // 源文本 title
        const srcAlignment = subtitleSetting.source_alignment || 'center';
        const srcFontColor = subtitleSetting.source_fontColor || '1 1 1 1';
        const srcBold = subtitleSetting.source_bold || '0';
        const srcStrokeColor = subtitleSetting.source_strokeColor || '1 1 1 1';
        const srcFont = subtitleSetting.source_font || 'Arial';
        const srcFontSize = subtitleSetting.source_fontSize || '50';
        const srcItalic = subtitleSetting.source_italic || '0';
        const srcStrokeWidth = subtitleSetting.source_strokeWidth || '0';
        const srcLineSpacing = subtitleSetting.source_lineSpacing || '0';
        const srcPosY = subtitleSetting.source_pos || '-45';

        const titleText = sub.text.trim().replace(/@/g, '\n');

        // 记录 title 在 XML 中的位置（用于后续插入翻译层）
        const titleStart = xml.length;

        xml += `\t\t\t\t\t\t<title name="Subtitle" ref="r1" enabled="1" start="${startStr}" offset="${startStr}" duration="${durationStr}">\n`;
        xml += `\t\t\t\t\t\t\t<text roll-up-height="0">\n`;
        xml += `\t\t\t\t\t\t\t\t<text-style ref="ts${totalIndex}">${xmlEscape(titleText)}</text-style>\n`;
        xml += `\t\t\t\t\t\t\t</text>\n`;
        xml += `\t\t\t\t\t\t\t<text-style-def id="ts${totalIndex}">\n`;
        xml += `\t\t\t\t\t\t\t\t<text-style alignment="${srcAlignment}" fontColor="${srcFontColor}" bold="${srcBold}" strokeColor="${srcStrokeColor}" font="${srcFont}" fontSize="${srcFontSize}" italic="${srcItalic}" strokeWidth="${srcStrokeWidth}" lineSpacing="${srcLineSpacing}"/>\n`;
        xml += `\t\t\t\t\t\t\t</text-style-def>\n`;
        xml += `\t\t\t\t\t\t\t<adjust-conform type="fit"/>\n`;
        xml += `\t\t\t\t\t\t\t<adjust-transform scale="1 1" position="0 ${srcPosY}" anchor="0 0"/>\n`;

        titlePositions.push(xml.length); // 记录 </title> 前的位置

        xml += `\t\t\t\t\t\t</title>\n`;

        totalIndex++;
        preSubEnd = sub.end;
    }

    // ---- 添加翻译层 ----
    // 由于需要在每个 title 内部插入子 title，我们需要重新构建
    // 为简化，我们先闭合之前的内容，然后用字符串插入的方式添加翻译层
    // 这里采用重新生成的方式

    if (transSrts && transSrts.length > 0) {
        // 重新生成完整 XML（包含翻译层）
        xml = '';
        xml += '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<fcpxml version="1.9">\n';
        xml += '\t<resources>\n';
        xml += '\t\t<format name="FFVideoFormat1080p30" frameDuration="1/30s" width="1920" height="1080" id="r0"/>\n';
        xml += '\t\t<effect name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti" id="r1"/>\n';
        xml += '\t</resources>\n';
        xml += '\t<library>\n';
        xml += `\t\t<event name="${xmlEscape(projectName)}">\n`;
        xml += `\t\t\t<project name="${xmlEscape(projectName)}">\n`;
        xml += `\t\t\t\t<sequence tcFormat="NDF" tcStart="0/1s" duration="${duration}" format="r0">\n`;
        xml += '\t\t\t\t\t<spine>\n';

        totalIndex = 0;
        preSubEnd = 0;

        const parsedTransSubs = transSrts.map(s => parseSRTString(s));

        for (let i = 0; i < count; i++) {
            const sub = sourceSubs[i];

            if (!seamlessFcpxml && preSubEnd < sub.start) {
                const gapOffset = getFractionTime(preSubEnd);
                const gapDuration = getFractionTime(sub.start - preSubEnd);
                xml += `\t\t\t\t\t\t<gap name="Gap" start="3600/1s" offset="${gapOffset}" duration="${gapDuration}"/>\n`;
            }

            let start = sub.start;
            if (seamlessFcpxml && sub.start > 34) start = sub.start - 34;
            const startStr = getFractionTime(start);

            let dur = sub.duration;
            if (seamlessFcpxml && i < count - 1) dur = sourceSubs[i + 1].start - start;
            const durationStr = getFractionTime(dur);

            const srcAlignment = subtitleSetting.source_alignment || 'center';
            const srcFontColor = subtitleSetting.source_fontColor || '1 1 1 1';
            const srcBold = subtitleSetting.source_bold || '0';
            const srcStrokeColor = subtitleSetting.source_strokeColor || '1 1 1 1';
            const srcFont = subtitleSetting.source_font || 'Arial';
            const srcFontSize = subtitleSetting.source_fontSize || '50';
            const srcItalic = subtitleSetting.source_italic || '0';
            const srcStrokeWidth = subtitleSetting.source_strokeWidth || '0';
            const srcLineSpacing = subtitleSetting.source_lineSpacing || '0';
            const srcPosY = subtitleSetting.source_pos || '-45';

            const titleText = sub.text.trim().replace(/@/g, '\n');

            xml += `\t\t\t\t\t\t<title name="Subtitle" ref="r1" enabled="1" start="${startStr}" offset="${startStr}" duration="${durationStr}">\n`;
            xml += `\t\t\t\t\t\t\t<text roll-up-height="0">\n`;
            xml += `\t\t\t\t\t\t\t\t<text-style ref="ts${totalIndex}">${xmlEscape(titleText)}</text-style>\n`;
            xml += `\t\t\t\t\t\t\t</text>\n`;
            xml += `\t\t\t\t\t\t\t<text-style-def id="ts${totalIndex}">\n`;
            xml += `\t\t\t\t\t\t\t\t<text-style alignment="${srcAlignment}" fontColor="${srcFontColor}" bold="${srcBold}" strokeColor="${srcStrokeColor}" font="${srcFont}" fontSize="${srcFontSize}" italic="${srcItalic}" strokeWidth="${srcStrokeWidth}" lineSpacing="${srcLineSpacing}"/>\n`;
            xml += `\t\t\t\t\t\t\t</text-style-def>\n`;
            xml += `\t\t\t\t\t\t\t<adjust-conform type="fit"/>\n`;
            xml += `\t\t\t\t\t\t\t<adjust-transform scale="1 1" position="0 ${srcPosY}" anchor="0 0"/>\n`;

            totalIndex++;

            // 翻译层
            let lane = 1;
            for (const transSubs of parsedTransSubs) {
                if (i >= transSubs.length) { lane++; continue; }
                const transSub = transSubs[i];

                let tStart = transSub.start;
                if (seamlessFcpxml && transSub.start > 34) tStart = transSub.start - 34;
                const tStartStr = getFractionTime(tStart);

                let tDur = transSub.duration;
                if (seamlessFcpxml && i < transSubs.length - 1) {
                    tDur = transSubs[i + 1].start - tStart;
                }
                const tDurationStr = getFractionTime(tDur);

                const tAlignment = subtitleSetting.trans_alignment || 'center';
                const tFontColor = subtitleSetting.trans_fontColor || '1 1 1 1';
                const tBold = subtitleSetting.trans_bold || '0';
                const tStrokeColor = subtitleSetting.trans_strokeColor || '1 1 1 1';
                const tFont = subtitleSetting.trans_font || 'Arial';
                const tFontSize = subtitleSetting.trans_fontSize || '50';
                const tItalic = subtitleSetting.trans_italic || '0';
                const tStrokeWidth = subtitleSetting.trans_strokeWidth || '0';
                const tLineSpacing = subtitleSetting.trans_lineSpacing || '0';
                const tPosY = subtitleSetting.trans_pos || '-38';

                const tText = transSub.text.trim().replace(/@/g, '\n');

                xml += `\t\t\t\t\t\t\t<title name="Subtitle" lane="${lane}" ref="r1" enabled="1" start="${tStartStr}" offset="${tStartStr}" duration="${tDurationStr}">\n`;
                xml += `\t\t\t\t\t\t\t\t<text roll-up-height="0">\n`;
                xml += `\t\t\t\t\t\t\t\t\t<text-style ref="ts${totalIndex}">${xmlEscape(tText)}</text-style>\n`;
                xml += `\t\t\t\t\t\t\t\t</text>\n`;
                xml += `\t\t\t\t\t\t\t\t<text-style-def id="ts${totalIndex}">\n`;
                xml += `\t\t\t\t\t\t\t\t\t<text-style alignment="${tAlignment}" fontColor="${tFontColor}" bold="${tBold}" strokeColor="${tStrokeColor}" font="${tFont}" fontSize="${tFontSize}" italic="${tItalic}" strokeWidth="${tStrokeWidth}" lineSpacing="${tLineSpacing}"/>\n`;
                xml += `\t\t\t\t\t\t\t\t</text-style-def>\n`;
                xml += `\t\t\t\t\t\t\t\t<adjust-conform type="fit"/>\n`;
                xml += `\t\t\t\t\t\t\t\t<adjust-transform scale="1 1" position="0 ${tPosY}" anchor="0 0"/>\n`;
                xml += `\t\t\t\t\t\t\t</title>\n`;

                totalIndex++;
                lane++;
            }

            xml += `\t\t\t\t\t\t</title>\n`;
            preSubEnd = sub.end;
        }
    }

    // 闭合标签
    xml += '\t\t\t\t\t</spine>\n';
    xml += '\t\t\t\t</sequence>\n';
    xml += '\t\t\t</project>\n';
    xml += '\t\t</event>\n';
    xml += '\t</library>\n';
    xml += '</fcpxml>\n';

    // 写入文件
    const dir = path.dirname(savePath);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(savePath, xml, 'utf-8');
    console.log(`FCPXML 已写入: ${savePath}`);
}

/**
 * 批量剪辑片段 → FCPXML 时间线
 * 每个片段生成 asset-clip + 动态字幕 title 叠加
 */
function segmentsToFcpxml(videoPath, segments, videoDuration, fps, resolution, savePath, subtitleStyle, compoundMode = false) {
    fps = fps || 30;
    const [width, height] = (resolution || '1080x1920').split('x').map(Number);

    // 秒 → 帧分数字符串（标准 FCPXML 格式：totalFrames/fps）
    function secToFrac(sec) {
        const fpsInt = Math.round(fps);
        const totalFrames = Math.round(sec * fpsInt);
        return `${totalFrames}/${fpsInt}s`;
    }

    const projectName = path.basename(savePath, path.extname(savePath));
    const videoSrc = mediaFileUrl(videoPath);
    // 多视频模式：每个 segment 可以有自己的 videoPath 和 videoDuration
    const isMultiVideo = segments.some(s => s.videoPath);

    // 默认字幕样式：Playfair Display SemiBold, 32pt, 黄色, 字距0, 位置 X=720 Y=800
    const defaultCol = { font: 'Playfair Display', fontFace: 'SemiBold', fontSize: 32, color: '1.0000 0.8980 0.0000 1', posX: 720, posY: 800, bold: '1', tracking: '0', lineSpacing: '0' };

    // 处理字幕列
    let columns = [defaultCol, { ...defaultCol }];
    if (subtitleStyle && subtitleStyle.columns) {
        columns = subtitleStyle.columns.map(col => {
            const c = { ...defaultCol };
            if (col.font) c.font = col.font;
            if (col.fontFace) c.fontFace = col.fontFace;
            if (col.fontSize) c.fontSize = col.fontSize;
            if (col.color) {
                // hex → FCPXML rgba
                const hex = col.color.replace('#', '');
                if (hex.length === 6) {
                    c.color = `${parseInt(hex.substr(0, 2), 16) / 255} ${parseInt(hex.substr(2, 2), 16) / 255} ${parseInt(hex.substr(4, 2), 16) / 255} 1`;
                }
            }
            if (col.bold !== undefined) c.bold = col.bold ? '1' : '0';
            if (col.tracking !== undefined) c.tracking = String(col.tracking);
            if (col.lineSpacing !== undefined) c.lineSpacing = String(col.lineSpacing);
            return c;
        });
    }

    // 计算总时间线长度
    let totalDuration = 0;
    for (const seg of segments) {
        const hasTrim = (seg.start > 0) || (seg.end != null && seg.end > 0);
        if (hasTrim) {
            // 有显式裁剪点：用裁剪范围
            const s = seg.start || 0;
            const e = seg.end || (seg.videoDuration || videoDuration);
            totalDuration += e - s;
        } else if (seg.videoPath && seg.videoDuration) {
            // 多视频模式无裁剪：整段视频
            totalDuration += seg.videoDuration;
        } else {
            const segEnd = seg.end != null ? seg.end : videoDuration;
            totalDuration += segEnd - (seg.start || 0);
        }
    }
    const totalDurStr = secToFrac(videoDuration || totalDuration);
    const timelineDurStr = secToFrac(totalDuration);

    // 预处理分配唯一名称，防止达芬奇通过 name 自动合并
    const usedNames = new Set();
    segments.forEach((seg, i) => {
        let baseName = seg.name || `片段${i + 1}`;
        let uniqueName = baseName;
        let counter = 1;
        while (usedNames.has(uniqueName)) {
            uniqueName = `${baseName}_${counter}`;
            counter++;
        }
        usedNames.add(uniqueName);
        seg._fcpxmlName = uniqueName;
    });

    // XML 头部
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<!DOCTYPE fcpxml>\n';
    xml += '<fcpxml version="1.9">\n';
    xml += '\t<resources>\n';
    xml += `\t\t<format id="r0" name="FFVideoFormat${height}p${Math.round(fps)}" frameDuration="${secToFrac(1 / fps)}" width="${width}" height="${height}"/>\n`;

    // 每个片段一个 asset
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const clipName = seg._fcpxmlName;
        const assetSrc = seg.videoPath ? mediaFileUrl(seg.videoPath) : videoSrc;
        const assetDurStr = (seg.videoPath && seg.videoDuration) ? secToFrac(seg.videoDuration) : totalDurStr;
        xml += `\t\t<asset name="${xmlEscape(clipName)}" src="${xmlEscape(assetSrc)}" start="0/${Math.round(fps)}s" duration="${assetDurStr}" hasVideo="1" hasAudio="1" format="r0" id="r${i + 1}"/>\n`;
    }
    // PNG 覆层 assets (r200+)
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.overlayPngSlices && seg.overlayPngSlices.length > 0) {
            // 时间切片模式：每个切片一个 PNG asset
            for (let si = 0; si < seg.overlayPngSlices.length; si++) {
                const slice = seg.overlayPngSlices[si];
                const pngSrc = mediaFileUrl(slice.path);
                const assetId = 200 + i * 10 + si;
                xml += `\t\t<asset name="overlay_${i + 1}_${slice.label || si}" src="${xmlEscape(pngSrc)}" start="0/${Math.round(fps)}s" duration="0/${Math.round(fps)}s" hasVideo="1" hasAudio="0" format="r0" id="r${assetId}"/>\n`;
            }
        } else if (seg.overlayPngPath) {
            const pngSrc = mediaFileUrl(seg.overlayPngPath);
            xml += `\t\t<asset name="overlay_${i + 1}" src="${xmlEscape(pngSrc)}" start="0/${Math.round(fps)}s" duration="0/${Math.round(fps)}s" hasVideo="1" hasAudio="0" format="r0" id="r${200 + i * 10}"/>\n`;
        }
    }
    // 注册背景视频 assets (r300+)
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.bgPath) {
            const bgSrc = mediaFileUrl(seg.bgPath);
            const bgDurStr = seg.bgDuration > 0 ? secToFrac(seg.bgDuration) : secToFrac(10);
            xml += `\t\t<asset name="bg_${i + 1}" src="${xmlEscape(bgSrc)}" start="0/${Math.round(fps)}s" duration="${bgDurStr}" hasVideo="1" hasAudio="1" format="r0" id="r${2000 + i}"/>\n`;
        }
    }
    // Effects
    xml += `\t\t<effect name="Basic Title" uid=".../Titles.localized/Build In:Out.localized/Basic Title.localized/Basic Title.moti" id="r100"/>\n`;
    xml += `\t\t<effect name="Cross Dissolve" uid=".../Transitions.localized/Dissolve.localized/Cross Dissolve.localized/Cross Dissolve.motr" id="r101"/>\n`;

    // ═══ 复合片段模式: 每个 segment → compound clip (<media>) ═══
    if (compoundMode) {
        // 在 resources 中为每个 segment 生成 <media> (compound clip)
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const hasExplicitTrim = (seg.start > 0) || (seg.end != null && seg.end > 0);
            const segStart = hasExplicitTrim ? (seg.start || 0) : ((seg.videoPath && seg.videoDuration) ? 0 : (seg.start || 0));
            const segEnd = hasExplicitTrim ? (seg.end || (seg.videoDuration || videoDuration)) : ((seg.videoPath && seg.videoDuration) ? seg.videoDuration : (seg.end != null ? seg.end : videoDuration));
            const segDuration = segEnd - segStart;
            const clipName = seg._fcpxmlName;
            // B版覆层默认从10s开始（clipName 以 _B 结尾）
            const effectiveOvOffset = seg.overlayStartOffset || (clipName && clipName.endsWith('_B') ? 10 : 0);
            const durationStr = secToFrac(segDuration);
            const startStr = secToFrac(segStart);

            xml += `\t\t<media name="${xmlEscape(clipName)}" uid="compound_${i}" id="r${500 + i}">\n`;
            xml += `\t\t\t<sequence format="r0" duration="${durationStr}" tcStart="0/${Math.round(fps)}s" tcFormat="NDF">\n`;
            xml += '\t\t\t\t<spine>\n';

            // 多轨道: bg spine + content lane 1 + overlay lane 2
            if (seg.bgPath && seg.bgDuration > 0) {
                const bgDur = seg.bgDuration;
                const fadeDur = Math.min(seg.loopFadeDur || 1.0, bgDur * 0.3);
                const fadeDurStr = secToFrac(fadeDur);
                const loopCount = Math.ceil(segDuration / bgDur);
                let bgOff = 0;
                for (let loop = 0; loop < loopCount; loop++) {
                    const clipDur = Math.min(bgDur, segDuration - (bgDur * loop));
                    if (clipDur <= 0) break;
                    if (loop > 0) {
                        xml += `\t\t\t\t\t<transition name="Cross Dissolve" offset="${secToFrac(bgOff - fadeDur)}" duration="${fadeDurStr}">\n`;
                        xml += `\t\t\t\t\t\t<filter-video ref="r101" name="Cross Dissolve"/>\n`;
                        xml += `\t\t\t\t\t</transition>\n`;
                    }
                    xml += `\t\t\t\t\t<asset-clip name="bg_${loop + 1}" ref="r${2000 + i}" offset="${secToFrac(bgOff)}" start="0/${Math.round(fps)}s" duration="${secToFrac(clipDur)}" format="r0" tcFormat="NDF">\n`;
                    if (loop === 0) {
                        xml += `\t\t\t\t\t\t<asset-clip name="${xmlEscape(clipName)}" ref="r${i + 1}" lane="1" offset="0/${Math.round(fps)}s" start="${startStr}" duration="${durationStr}" format="r0" tcFormat="NDF"/>\n`;
                        if (seg.overlayPngSlices && seg.overlayPngSlices.length > 0) {
                            for (let si = 0; si < seg.overlayPngSlices.length; si++) {
                                const slice = seg.overlayPngSlices[si];
                                const assetId = 200 + i * 10 + si;
                                const sliceStart = slice.startSec || 0;
                                const sliceEnd = slice.endSec != null ? slice.endSec : segDuration;
                                const sliceDur = Math.min(sliceEnd, segDuration) - sliceStart;
                                if (sliceDur > 0) {
                                    xml += `\t\t\t\t\t\t<asset-clip name="overlay_${slice.label || si}" ref="r${assetId}" lane="2" offset="${secToFrac(sliceStart)}" duration="${secToFrac(sliceDur)}" format="r0" tcFormat="NDF"/>\n`;
                                }
                            }
                        } else if (seg.overlayPngPath) {
                            const ovOff = effectiveOvOffset;
                            const ovDur = Math.max(0.1, segDuration - ovOff);
                            xml += `\t\t\t\t\t\t<asset-clip name="overlay" ref="r${200 + i * 10}" lane="2" offset="${secToFrac(ovOff)}" duration="${secToFrac(ovDur)}" format="r0" tcFormat="NDF"/>\n`;
                        }
                    }
                    xml += `\t\t\t\t\t</asset-clip>\n`;
                    bgOff += clipDur;
                }
            } else {
                // 无独立背景: 内容视频为 spine + overlay lane 1
                xml += `\t\t\t\t\t<asset-clip name="${xmlEscape(clipName)}" ref="r${i + 1}" offset="0/${Math.round(fps)}s" start="${startStr}" duration="${durationStr}" format="r0" tcFormat="NDF">\n`;
                if (seg.overlayPngSlices && seg.overlayPngSlices.length > 0) {
                    for (let si = 0; si < seg.overlayPngSlices.length; si++) {
                        const slice = seg.overlayPngSlices[si];
                        const assetId = 200 + i * 10 + si;
                        const sliceStart = slice.startSec || 0;
                        const sliceEnd = slice.endSec != null ? slice.endSec : segDuration;
                        const sliceDur = Math.min(sliceEnd, segDuration) - sliceStart;
                        if (sliceDur > 0) {
                            xml += `\t\t\t\t\t\t<asset-clip name="overlay_${slice.label || si}" ref="r${assetId}" lane="1" offset="${startStr}" duration="${secToFrac(sliceDur)}" format="r0" tcFormat="NDF"/>\n`;
                        }
                    }
                } else if (seg.overlayPngPath) {
                    const ovOff = effectiveOvOffset;
                    const ovDur = Math.max(0.1, segDuration - ovOff);
                    xml += `\t\t\t\t\t\t<asset-clip name="overlay" ref="r${200 + i * 10}" lane="1" offset="${secToFrac(segStart + ovOff)}" duration="${secToFrac(ovDur)}" format="r0" tcFormat="NDF"/>\n`;
                }
                xml += `\t\t\t\t\t</asset-clip>\n`;
            }

            xml += '\t\t\t\t</spine>\n';
            xml += '\t\t\t</sequence>\n';
            xml += '\t\t</media>\n';
        }
    }

    xml += '\t</resources>\n';
    xml += '\t<library>\n';
    xml += `\t\t<event name="${xmlEscape(projectName)}">\n`;
    xml += `\t\t\t<project name="${xmlEscape(projectName)}">\n`;
    xml += `\t\t\t\t<sequence tcFormat="NDF" tcStart="0/${Math.round(fps)}s" duration="${timelineDurStr}" format="r0">\n`;
    xml += '\t\t\t\t\t<spine>\n';

    // ═══ 主 spine 生成 ═══
    if (compoundMode) {
        // 复合片段模式: spine 中只放 ref-clip 引用
        let timelineOffset = 0;
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const hasExplicitTrim = (seg.start > 0) || (seg.end != null && seg.end > 0);
            const segStart = hasExplicitTrim ? (seg.start || 0) : ((seg.videoPath && seg.videoDuration) ? 0 : (seg.start || 0));
            const segEnd = hasExplicitTrim ? (seg.end || (seg.videoDuration || videoDuration)) : ((seg.videoPath && seg.videoDuration) ? seg.videoDuration : (seg.end != null ? seg.end : videoDuration));
            const segDuration = segEnd - segStart;
            const clipName = seg._fcpxmlName;

            xml += `\t\t\t\t\t\t<ref-clip name="${xmlEscape(clipName)}" ref="r${500 + i}" offset="${secToFrac(timelineOffset)}" duration="${secToFrac(segDuration)}" srcEnable="all"/>\n`;
            timelineOffset += segDuration;
        }
    } else {
    // 平铺模式: 每个片段 → 多轨道结构
    let timelineOffset = 0;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const hasExplicitTrim = (seg.start > 0) || (seg.end != null && seg.end > 0);
        const segStart = hasExplicitTrim ? (seg.start || 0) : ((seg.videoPath && seg.videoDuration) ? 0 : (seg.start || 0));
        const segEnd = hasExplicitTrim ? (seg.end || (seg.videoDuration || videoDuration)) : ((seg.videoPath && seg.videoDuration) ? seg.videoDuration : (seg.end != null ? seg.end : videoDuration));
        const segDuration = segEnd - segStart;

        const clipName = seg._fcpxmlName;
        const effectiveOvOffset = seg.overlayStartOffset || (clipName && clipName.endsWith('_B') ? 10 : 0);
        const subtitles = seg.subtitles || [clipName, seg.subtitle || ''];
        const offsetStr = secToFrac(timelineOffset);
        const startStr = secToFrac(segStart);
        const durationStr = secToFrac(segDuration);

        // ═══ 多轨道模式: 背景 (spine V1) + 内容 (lane 1) + 覆层 (lane 2) ═══
        if (seg.bgPath && seg.bgDuration > 0) {
            const bgDur = seg.bgDuration;
            const fadeDur = Math.min(seg.loopFadeDur || 1.0, bgDur * 0.3);
            const fadeDurStr = secToFrac(fadeDur);

            const loopCount = Math.ceil(segDuration / bgDur);
            let bgOffset = timelineOffset;

            for (let loop = 0; loop < loopCount; loop++) {
                const clipDur = Math.min(bgDur, segDuration - (bgDur * loop));
                if (clipDur <= 0) break;

                if (loop > 0) {
                    xml += `\t\t\t\t\t\t<transition name="Cross Dissolve" offset="${secToFrac(bgOffset - fadeDur)}" duration="${fadeDurStr}">\n`;
                    xml += `\t\t\t\t\t\t\t<filter-video ref="r101" name="Cross Dissolve"/>\n`;
                    xml += `\t\t\t\t\t\t</transition>\n`;
                }

                xml += `\t\t\t\t\t\t<asset-clip name="bg_${clipName}_${loop + 1}" ref="r${2000 + i}" offset="${secToFrac(bgOffset)}" start="0/${Math.round(fps)}s" duration="${secToFrac(clipDur)}" format="r0" tcFormat="NDF">\n`;

                if (loop === 0) {
                    xml += `\t\t\t\t\t\t\t<asset-clip name="${xmlEscape(clipName)}" ref="r${i + 1}" lane="1" offset="${secToFrac(bgOffset)}" start="${startStr}" duration="${durationStr}" format="r0" tcFormat="NDF"/>\n`;
                    if (seg.overlayPngSlices && seg.overlayPngSlices.length > 0) {
                        for (let si = 0; si < seg.overlayPngSlices.length; si++) {
                            const slice = seg.overlayPngSlices[si];
                            const assetId = 200 + i * 10 + si;
                            const sliceStart = slice.startSec || 0;
                            const sliceEnd = slice.endSec != null ? slice.endSec : segDuration;
                            const sliceDur = Math.min(sliceEnd, segDuration) - sliceStart;
                            if (sliceDur > 0) {
                                xml += `\t\t\t\t\t\t\t<asset-clip name="overlay_${slice.label || si}" ref="r${assetId}" lane="2" offset="${secToFrac(bgOffset + sliceStart)}" duration="${secToFrac(sliceDur)}" format="r0" tcFormat="NDF"/>\n`;
                            }
                        }
                    } else if (seg.overlayPngPath) {
                        const ovOff = effectiveOvOffset;
                        const ovDur = Math.max(0.1, segDuration - ovOff);
                        xml += `\t\t\t\t\t\t\t<asset-clip name="overlay_${xmlEscape(clipName)}" ref="r${200 + i * 10}" lane="2" offset="${secToFrac(bgOffset + ovOff)}" duration="${secToFrac(ovDur)}" format="r0" tcFormat="NDF"/>\n`;
                    }
                }

                xml += `\t\t\t\t\t\t</asset-clip>\n`;
                bgOffset += clipDur;
            }

        } else {
            xml += `\t\t\t\t\t\t<asset-clip name="${xmlEscape(clipName)}" ref="r${i + 1}" offset="${offsetStr}" start="${startStr}" duration="${durationStr}" format="r0" tcFormat="NDF">\n`;

            if (seg.clipColor) {
                xml += `\t\t\t\t\t\t\t<note>[ClipColor:${xmlEscape(seg.clipColor)}] ${xmlEscape(clipName)}</note>\n`;
            }

            if (seg.overlayPngSlices && seg.overlayPngSlices.length > 0) {
                for (let si = 0; si < seg.overlayPngSlices.length; si++) {
                    const slice = seg.overlayPngSlices[si];
                    const assetId = 200 + i * 10 + si;
                    const sliceStart = slice.startSec || 0;
                    const sliceEnd = slice.endSec != null ? slice.endSec : segDuration;
                    const sliceDur = Math.min(sliceEnd, segDuration) - sliceStart;
                    if (sliceDur > 0) {
                        xml += `\t\t\t\t\t\t\t<asset-clip name="overlay_${slice.label || si}" ref="r${assetId}" lane="1" offset="${secToFrac(timelineOffset + sliceStart)}" duration="${secToFrac(sliceDur)}" format="r0" tcFormat="NDF"/>\n`;
                    }
                }
            } else if (seg.overlayPngPath) {
                const ovOff = effectiveOvOffset;
                const ovDur = Math.max(0.1, segDuration - ovOff);
                xml += `\t\t\t\t\t\t\t<asset-clip name="overlay_${xmlEscape(clipName)}" ref="r${200 + i * 10}" lane="1" offset="${secToFrac(timelineOffset + ovOff)}" duration="${secToFrac(ovDur)}" format="r0" tcFormat="NDF"/>\n`;
            } else {
            for (let ci = 0; ci < subtitles.length; ci++) {
                const subEntry = subtitles[ci];
                const isObj = subEntry && typeof subEntry === 'object';
                const text = isObj ? (subEntry.text || '').trim() : (subEntry || '').trim();
                if (!text) continue;

                const col = columns[ci] || columns[0] || defaultCol;
                const lane = subtitles.length - ci;
                const styleId = `ts_${i}_${ci}`;
                const posX = isObj && subEntry.posX != null ? subEntry.posX : col.posX;
                const posY = isObj && subEntry.posY != null ? subEntry.posY : col.posY;
                const subFont = isObj && subEntry.font ? subEntry.font : (col.font || 'Playfair Display');
                const subFontSize = isObj && subEntry.fontSize ? subEntry.fontSize : col.fontSize;
                const subBold = isObj && subEntry.bold != null ? (subEntry.bold ? '1' : '0') : col.bold;
                let subFontColor = col.color;
                if (isObj && subEntry.fontColor) {
                    const hex = subEntry.fontColor.replace('#', '');
                    if (hex.length >= 6) {
                        subFontColor = `${parseInt(hex.substring(0, 2), 16) / 255} ${parseInt(hex.substring(2, 4), 16) / 255} ${parseInt(hex.substring(4, 6), 16) / 255} 1`;
                    }
                }

                // ⏱️ 时间切片支持：如果字幕条目有 timeStart/timeEnd，使用切片的 offset/duration
                let titleOffsetStr = offsetStr;
                let titleDurationStr = durationStr;
                if (isObj && subEntry.timeStart != null) {
                    const sliceStart = subEntry.timeStart || 0;
                    const sliceEnd = subEntry.timeEnd != null ? subEntry.timeEnd : segDuration;
                    titleOffsetStr = secToFrac(timelineOffset + sliceStart);
                    titleDurationStr = secToFrac(Math.max(0.1, sliceEnd - sliceStart));
                }

                xml += `\t\t\t\t\t\t\t<title name="${xmlEscape(text.slice(0, 40))}" lane="${lane}" offset="${titleOffsetStr}" ref="r100" duration="${titleDurationStr}" start="3600/1s">\n`;
                xml += `\t\t\t\t\t\t\t\t<param name="Position" key="9999/999166631/999166633/2/100/101" value="${posX} ${posY}"/>\n`;
                xml += `\t\t\t\t\t\t\t\t<text>\n`;
                xml += `\t\t\t\t\t\t\t\t\t<text-style ref="${styleId}">${xmlEscape(text)}</text-style>\n`;
                xml += `\t\t\t\t\t\t\t\t</text>\n`;
                xml += `\t\t\t\t\t\t\t\t<text-style-def id="${styleId}">\n`;
                xml += `\t\t\t\t\t\t\t\t\t<text-style font="${xmlEscape(subFont)}" fontFace="SemiBold" fontSize="${subFontSize}" fontColor="${subFontColor}" bold="${subBold}" tracking="${col.tracking || '0'}" lineSpacing="${col.lineSpacing || '0'}" alignment="center" verticalAlignment="top"/>\n`;
                xml += `\t\t\t\t\t\t\t\t</text-style-def>\n`;
                xml += `\t\t\t\t\t\t\t</title>\n`;
            }
            } // end Basic Title fallback

            xml += `\t\t\t\t\t\t</asset-clip>\n`;
        }

        timelineOffset += segDuration;
    }
    } // end flat mode

    // 闭合标签
    xml += '\t\t\t\t\t</spine>\n';
    xml += '\t\t\t\t</sequence>\n';
    xml += '\t\t\t</project>\n';
    xml += '\t\t</event>\n';
    xml += '\t</library>\n';
    xml += '</fcpxml>\n';

    // 写入文件
    const dir = path.dirname(savePath);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(savePath, xml, 'utf-8');
    console.log(`FCPXML 时间线已写入: ${savePath}`);

    // ===== 生成达芬奇 Clip Color 脚本 =====
    let colorScriptPath = null;
    const hasAnyColor = segments.some(s => s.clipColor);
    if (hasAnyColor) {
        colorScriptPath = savePath.replace(/\.fcpxml$/i, '_clip_colors.py');
        const colorScript = generateDaVinciColorScript(segments, projectName);
        fs.writeFileSync(colorScriptPath, colorScript, 'utf-8');
        console.log(`达芬奇 Clip Color 脚本已写入: ${colorScriptPath}`);
    }

    return {
        success: true,
        path: savePath,
        segments_count: segments.length,
        color_script_path: colorScriptPath
    };
}

/**
 * 生成达芬奇 Python 脚本，用于批量设置片段颜色
 * 用户导入 FCPXML 后，在达芬奇控制台运行此脚本即可自动着色
 *
 * 支持的颜色名称（DaVinci Resolve SetClipColor API）:
 * Orange, Apricot, Yellow, Lime, Olive, Green, Teal, Navy,
 * Blue, Purple, Violet, Pink, Tan, Beige, Brown, Chocolate
 */
function generateDaVinciColorScript(segments, projectName) {
    const colorEntries = segments
        .map((seg, i) => ({ index: i, name: seg.name || `片段${i + 1}`, color: seg.clipColor || '' }))
        .filter(e => e.color);

    let script = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
达芬奇 Clip Color 自动着色脚本
由 VideoKit 批量剪辑模块自动生成

使用方法：
  1. 先将 FCPXML 导入达芬奇 (File > Import > Timeline)
  2. 确保目标时间线已打开
  3. 在达芬奇中运行此脚本:
     - Workspace > Scripts > 选择此脚本
     - 或在控制台中: exec(open(r'${colorScriptPath_placeholder()}').read())
"""
import sys

try:
    import DaVinciResolveScript as dvr
except ImportError:
    # 尝试内部环境
    try:
        import fusionscript as dvr
    except ImportError:
        print("[错误] 无法导入 DaVinci Resolve 脚本模块")
        print("请确保在达芬奇环境中运行此脚本")
        sys.exit(1)

def main():
    resolve = dvr.scriptapp("Resolve")
    if not resolve:
        print("[错误] 无法连接到达芬奇")
        return

    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if not project:
        print("[错误] 没有打开的项目")
        return

    timeline = project.GetCurrentTimeline()
    if not timeline:
        print("[错误] 没有打开的时间线")
        return

    print(f"[ClipColor] 当前时间线: {timeline.GetName()}")
    print(f"[ClipColor] 需要着色的片段: ${colorEntries.length} 个")

    # 获取视频轨道 1 的所有片段
    items = timeline.GetItemListInTrack("video", 1)
    if not items:
        print("[错误] 视频轨道 1 没有片段")
        return

    print(f"[ClipColor] 时间线中共有 {len(items)} 个片段")

    # 按顺序着色
    color_map = {
`;

    for (const entry of colorEntries) {
        script += `        ${Number(entry.index) || 0}: (${JSON.stringify(String(entry.color || ''))}, ${JSON.stringify(String(entry.name || ''))}),\n`;
    }

    script += `    }

    success = 0
    for idx, (color, name) in color_map.items():
        if idx < len(items):
            result = items[idx].SetClipColor(color)
            status = "✅" if result else "❌"
            print(f"  {status} 片段 {idx+1} [{name}] → {color}")
            if result:
                success += 1
        else:
            print(f"  ⚠️ 片段 {idx+1} [{name}] 超出时间线范围")

    print(f"\n[ClipColor] 完成: {success}/${colorEntries.length} 个片段已着色")

if __name__ == "__main__":
    main()
`;

    // 替换占位符
    return script;
}

/** 内部辅助：生成脚本时的路径占位 */
function colorScriptPath_placeholder() {
    return '此脚本路径';
}

module.exports = {
    parseSRTString,
    parseSRTTime,
    getFractionTime,
    SrtsToFcpxml,
    segmentsToFcpxml,
};
