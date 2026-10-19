/**
 * ffmpeg-rawvideo.js — WYSIWYG 混合导出 FFmpeg 后端
 *
 * 混合架构：
 *   1. prepare-bg: FFmpeg 预处理背景（循环+淡入淡出+缩放）→ 提取帧序列
 *   2. start: 启动 FFmpeg image2pipe 编码器
 *   3. frame: 接收 JPEG 帧写入 stdin
 *   4. finish: 关闭编码 + 混合音频
 *   5. cleanup-bg: 清理临时帧文件
 */

const { spawn, execFileSync } = require('child_process');
const { formatMediaError, formatProcessStartError } = require('./media-error');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const sessions = new Map();

function generateId() {
    return Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

function findFFmpeg() {
    // 优先使用 main.js setupFFmpegPath() 设置的环境变量
    if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
    // 尝试从 ffmpeg.js 获取 resolveCommand
    try {
        const resolved = require('./ffmpeg').resolveCommand('ffmpeg');
        if (resolved !== 'ffmpeg' && fs.existsSync(resolved)) return resolved;
    } catch (_) { }
    // macOS 常见路径
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
        if (fs.existsSync(p)) return p;
    }
    return 'ffmpeg';
}

function findFFprobe() {
    // 优先使用 main.js setupFFmpegPath() 设置的环境变量
    if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) return process.env.FFPROBE_PATH;
    // 尝试从 ffmpeg.js 获取 resolveCommand
    try {
        const resolved = require('./ffmpeg').resolveCommand('ffprobe');
        if (resolved !== 'ffprobe' && fs.existsSync(resolved)) return resolved;
    } catch (_) { }
    // macOS 常见路径
    for (const p of ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']) {
        if (fs.existsSync(p)) return p;
    }
    return 'ffprobe';
}

function isImageMedia(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    // GIF 可能是动画，必须按动态媒体解码，不能只取第一帧。
    return ['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext);
}

function expectedFrameCount(duration, fps) {
    const seconds = Number(duration);
    const rate = Number(fps);
    if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(rate) || rate <= 0) return 0;
    return Math.max(1, Math.ceil(seconds * rate) - 2);
}

async function getMediaDuration(filePath) {
    try {
        const result = execFileSync(findFFprobe(), [
            '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath
        ], { timeout: 15000 }).toString().trim();
        return parseFloat(result) || 0;
    } catch (e) {
        return 0;
    }
}

/** 用 ffprobe 检测文件是否真有音频轨道 */
async function hasAudioTrack(filePath) {
    if (!filePath) return false;
    // 如果是 .wav 文件，我们自己拼接生成的文件肯定有音轨，直接返回 true，防止 ffprobe 路径或权限的额外干扰
    if (filePath.toLowerCase().endsWith('.wav')) return true;
    try {
        const { runCommand } = require('./ffmpeg');
        const { stdout } = await runCommand('ffprobe', [
            '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filePath
        ], { timeout: 10000 });
        return stdout.trim().length > 0;
    } catch (e) {
        console.error(`[hasAudioTrack] ffprobe check failed for ${filePath}: ${e.message}`);
        // 回退到 execFileSync
        try {
            const result = execFileSync(findFFprobe(), [
                '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filePath
            ], { timeout: 10000 }).toString().trim();
            return result.length > 0;
        } catch (innerErr) {
            console.error(`[hasAudioTrack] fallback execFileSync check also failed: ${innerErr.message}`);
            return false;
        }
    }
}


function buildAtempoChainForDurationScale(durationScale = 100) {
    const scale = Number(durationScale) || 100;
    if (Math.abs(scale - 100) < 0.01) return '';
    let targetTempo = 100 / scale;
    const filters = [];
    while (targetTempo < 0.5) {
        filters.push('atempo=0.5');
        targetTempo /= 0.5;
    }
    while (targetTempo > 100.0) {
        filters.push('atempo=100.0');
        targetTempo /= 100.0;
    }
    filters.push(`atempo=${targetTempo.toFixed(6)}`);
    return filters.join(',');
}

function getSessionVideoDuration(session) {
    const explicit = Number(session && session.targetDuration);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const frames = Number(session && session.frameCount);
    const fps = Number(session && session.fps);
    if (Number.isFinite(frames) && frames > 0 && Number.isFinite(fps) && fps > 0) {
        return frames / fps;
    }
    return 0;
}

function outputDurationArgs(session) {
    const duration = getSessionVideoDuration(session);
    return duration > 0 ? ['-t', duration.toFixed(6)] : [];
}

// Windows 上部分 FFmpeg/libx264 构建会在帧级多线程下触发
// encoder/analyse.c 断言或 0xC0000005/0xC0000409 崩溃。只对 Windows
// 使用稳定参数，其他平台保持原有并行速度。
function stableJpegEncoderArgs(platform = process.platform) {
    return [
        '-c:v', 'mjpeg',
        '-pix_fmt', 'yuvj420p',
        ...(platform === 'win32' ? ['-threads', '1'] : []),
        '-q:v', '2',
    ];
}

function h264RateControlArgs(crf = 23, targetBitrateMbps = null, maxBitrateMbps = null) {
    const requestedTarget = Number(targetBitrateMbps);
    const requestedMax = Number(maxBitrateMbps);
    if (Number.isFinite(requestedTarget) && requestedTarget > 0) {
        const target = Math.max(1, Math.min(30, requestedTarget));
        const maxrate = Number.isFinite(requestedMax) && requestedMax > 0
            ? Math.max(target, Math.min(50, requestedMax))
            : Math.min(50, target * 1.4);
        return [
            '-b:v', `${target}M`,
            '-maxrate', `${maxrate}M`,
            '-bufsize', `${target * 2}M`,
        ];
    }

    const numericCrf = Number.isFinite(Number(crf)) ? Number(crf) : 23;
    let bitrate = '2M';
    let maxrate = '3M';
    let bufsize = '4M';

    if (numericCrf <= 15) {
        bitrate = '12M';
        maxrate = '12M';
        bufsize = '24M';
    } else if (numericCrf <= 18) {
        bitrate = '8M';
        maxrate = '11M';
        bufsize = '16M';
    } else if (numericCrf >= 26) {
        bitrate = '2500k';
        maxrate = '3500k';
        bufsize = '5M';
    }

    return ['-b:v', bitrate, '-maxrate', maxrate, '-bufsize', bufsize];
}

function cpuH264EncoderArgs(
    qualityPreset,
    crf,
    platform = process.platform,
    targetBitrateMbps = null,
    maxBitrateMbps = null
) {
    return [
        '-c:v', 'libx264',
        ...(platform === 'win32' ? ['-threads', '1'] : []),
        '-preset', qualityPreset,
        ...h264RateControlArgs(crf, targetBitrateMbps, maxBitrateMbps),
    ];
}

function gpuH264EncoderCandidates(
    platform,
    crf = 23,
    targetBitrateMbps = null,
    maxBitrateMbps = null
) {
    const rateArgs = h264RateControlArgs(crf, targetBitrateMbps, maxBitrateMbps);
    if (platform === 'darwin') {
        return [{
            codec: 'h264_videotoolbox',
            label: 'VideoToolbox',
            args: ['-c:v', 'h264_videotoolbox', ...rateArgs],
        }];
    }
    if (platform === 'win32') {
        return [
            {
                codec: 'h264_nvenc',
                label: 'NVENC',
                args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', ...rateArgs],
            },
            {
                codec: 'h264_amf',
                label: 'AMF',
                args: ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'vbr_peak', ...rateArgs],
            },
            {
                codec: 'h264_qsv',
                label: 'QSV',
                args: ['-c:v', 'h264_qsv', '-preset', 'medium', ...rateArgs],
            },
        ];
    }
    return [];
}

// ═══════════════════════════════════════════════════════
// 辅助: 递归搜索文件（限深度，跳过隐藏目录）
// ═══════════════════════════════════════════════════════

function _findFileRecursive(dir, fileName, maxDepth) {
    if (maxDepth <= 0) return null;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        // 先检查当前目录
        for (const entry of entries) {
            if (entry.isFile() && entry.name === fileName) {
                return path.join(dir, entry.name);
            }
        }
        // 再递归子目录
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                const found = _findFileRecursive(path.join(dir, entry.name), fileName, maxDepth - 1);
                if (found) return found;
            }
        }
    } catch (e) {
        // 权限等问题，跳过
    }
    return null;
}

// ═══════════════════════════════════════════════════════
// 阶段 1: 预处理背景视频 → 提取帧序列
// ═══════════════════════════════════════════════════════

async function prepareBg(opts) {
    let {
        backgroundPath,
        bgMode = 'single',
        bgClipPool = [],
        bgClipSettings = {},
        bgMinClipDur = 5,
        bgMaxClipDur = 7,
        segments = [],
        originalScript = '',
        bgClipOrder = 'random',
        bgClipSeed = '',
        bgTransition = 'crossfade',
        bgTransDur = 0.5,
        targetWidth = 1080,
        targetHeight = 1920,
        fps = 30,
        duration,
        loopFade = true,
        loopFadeDur = 1.0,
        bgScale = 100,
        bgRotation = 0,
        bgX = 0,
        bgY = 0,
        bgFlipH = false,
        bgFlipV = false,
        bgDurScale = 100,
    } = opts;
    
    const ptsFactor = (bgDurScale || 100) / 100;
    const ptsFilter = Math.abs(ptsFactor - 1.0) < 0.01 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)*${ptsFactor.toFixed(3)}`;

    const ffmpeg = findFFmpeg();
    const settings = require('./settings');
    const framesDir = path.join(settings.getSecureTmpDir(), `reels_bg_${generateId()}`);
    fs.mkdirSync(framesDir, { recursive: true });

    // 构建缩放+裁切滤镜
    const rotationDeg = Math.max(-180, Math.min(180, Number(bgRotation) || 0));
    const rotationFilter = Math.abs(rotationDeg) < 0.01 ? '' : `,rotate=${(rotationDeg * Math.PI / 180).toFixed(8)}:ow=rotw(iw):oh=roth(ih)`;
    // Rotating a deliberately reduced background must still fill the canvas; otherwise its corners show black.
    const scaleFactor = Math.abs(rotationDeg) < 0.01 ? (bgScale || 100) / 100 : Math.max(1, (bgScale || 100) / 100);
    let scaleCropFilter;
    const scaledW = Math.round(targetWidth * scaleFactor);
    const scaledH = Math.round(targetHeight * scaleFactor);
    if (scaleFactor >= 1.0) {
        scaleCropFilter = `${normalizeDisplayAspectFilter()}${rotationFilter},scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}:'max(0, min(in_w-out_w, ((in_w-out_w)/2)*(1-(${bgX}/100))))':'max(0, min(in_h-out_h, ((in_h-out_h)/2)*(1-(${bgY}/100))))',setsar=1`;
    } else {
        scaleCropFilter = `${normalizeDisplayAspectFilter()}${rotationFilter},scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:'max(0, min(ow-iw, ((ow-iw)/2)*(1+(${bgX}/100))))':'max(0, min(oh-ih, ((oh-ih)/2)*(1+(${bgY}/100))))':color=black,setsar=1`;
    }
    if (bgFlipH) scaleCropFilter += ',hflip';
    if (bgFlipV) scaleCropFilter += ',vflip';
    console.log(`[WYSIWYG-BG] 背景缩放: ${bgScale}%, 旋转: ${rotationDeg}°, flipH: ${bgFlipH}, flipV: ${bgFlipV}, filter: ${scaleCropFilter}`);

    // ═══ 多素材拼接模式 ═══
    if (bgMode === 'multi' && Array.isArray(bgClipPool) && bgClipPool.length > 0) {
        console.log(`[WYSIWYG-BG] 多素材拼接: ${bgClipPool.length} 个素材, 目标时长: ${duration}s, 转场: ${bgTransition} ${bgTransDur}s`);

        // 过滤出实际存在的文件
        const validClips = bgClipPool.filter(p => p && fs.existsSync(p));
        if (validClips.length === 0) {
            throw new Error('素材池中没有有效的文件');
        }

        // 获取每个素材的时长，并考虑 custom trim 属性
        const clipDurations = [];
        for (const clip of validClips) {
            let start = null;
            let end = null;
            if (bgClipSettings && bgClipSettings[clip]) {
                if (bgClipSettings[clip].trimStart != null) start = parseFloat(bgClipSettings[clip].trimStart);
                if (bgClipSettings[clip].trimEnd != null) end = parseFloat(bgClipSettings[clip].trimEnd);
            }
            let rawDur = isImageMedia(clip) ? 5.0 : await getMediaDuration(clip);
            let clipDur = rawDur;
            if (end != null && end > 0) {
                clipDur = end - (start || 0);
            } else if (start != null && start > 0) {
                clipDur = rawDur - start;
            }
            const usableRawDuration = Math.max(clipDur, 0.5);
            clipDurations.push({
                path: clip,
                duration: usableRawDuration * ptsFactor,
                rawDuration: usableRawDuration,
                isImage: isImageMedia(clip),
                trimStart: start,
                trimEnd: end
            });
        }

        const orderedClipDurations = (bgClipOrder === 'random' || bgClipOrder === 'random_align')
            ? _stableShuffleBgClips(clipDurations, `${bgClipSeed || ''}|${validClips.join('|')}`)
            : clipDurations;

        let selectedClips = [];
        const isCardingMode = bgClipOrder === 'random_align' || bgClipOrder === 'sequence_align';

        if (isCardingMode && Array.isArray(segments) && segments.length > 0) {
            // 依据台词卡点时间切分
            const cutPoints = [0];
            const preSwitchOffset = 0.2; // 提前 0.2 秒切换背景，实现无缝预切换

            const getSentenceBoundaries = (segs, originalText) => {
                const strongBoundaries = new Set();
                const weakBoundaries = new Set();
                if (!segs || segs.length === 0) return { strongBoundaries, weakBoundaries };
                
                const lastIdx = segs.length - 1;
                strongBoundaries.add(lastIdx);

                const sentencePunct = new Set([
                    '。', '！', '？', '，', '、', '；', '：', 
                    '.', '!', '?', ',', ';', ':', '\n', '\r', 
                    '…', '—', '“', '”', '‘', '’', '（', '）', 
                    '(', ')', '[', ']', '【', '】'
                ]);
                const strongPunct = new Set(['。', '！', '？', '.', '!', '?', '\n', '\r', '…', '—']);

                segs.forEach((seg, i) => {
                    const txt = String(seg.edited_text || seg.text || '').trim();
                    if (txt && sentencePunct.has(txt[txt.length - 1])) {
                        const char = txt[txt.length - 1];
                        if (strongPunct.has(char)) {
                            strongBoundaries.add(i);
                        } else {
                            weakBoundaries.add(i);
                        }
                    }
                });

                if (!originalText) return { strongBoundaries, weakBoundaries };

                const rawChars = Array.from(originalText);
                const cleanOriginalText = [];
                const cleanToRawMap = [];
                for (let i = 0; i < rawChars.length; i++) {
                    const char = rawChars[i];
                    if (!/\s/.test(char) && !sentencePunct.has(char)) {
                        cleanToRawMap.push(i);
                        cleanOriginalText.push(char);
                    }
                }
                const cleanOrigStr = cleanOriginalText.join('');

                let accumulatedCleanText = "";
                for (let idx = 0; idx < segs.length; idx++) {
                    const segVal = segs[idx].edited_text || segs[idx].text || "";
                    const cleanSegText = String(segVal)
                        .replace(/\s+/g, '')
                        .split('')
                        .filter(c => !sentencePunct.has(c))
                        .join('');

                    accumulatedCleanText += cleanSegText;
                    if (accumulatedCleanText.length === 0) continue;

                    const matchIdx = cleanOrigStr.toLowerCase().indexOf(accumulatedCleanText.toLowerCase());
                    if (matchIdx !== -1) {
                        const endCleanIdx = matchIdx + accumulatedCleanText.length - 1;
                        const endRawIdx = cleanToRawMap[endCleanIdx];
                        if (endRawIdx !== undefined) {
                            let isBoundary = false;
                            let matchedChar = '';
                            let k = endRawIdx + 1;
                            for (; k < rawChars.length; k++) {
                                const nextChar = rawChars[k];
                                if (sentencePunct.has(nextChar)) {
                                    isBoundary = true;
                                    matchedChar = nextChar;
                                    break;
                                }
                                if (!/\s/.test(nextChar)) {
                                    break;
                                }
                            }
                            if (k === rawChars.length) {
                                isBoundary = true;
                            }
                            if (isBoundary) {
                                if (k === rawChars.length || strongPunct.has(matchedChar)) {
                                    strongBoundaries.add(idx);
                                } else {
                                    weakBoundaries.add(idx);
                                }
                            }
                        }
                    }
                }
                return { strongBoundaries, weakBoundaries };
            };

            const { strongBoundaries, weakBoundaries } = getSentenceBoundaries(segments, originalScript);

            const strongCandidates = [];
            const weakCandidates = [];
            const allCandidates = [];

            segments.forEach((seg, idx) => {
                const endVal = parseFloat(seg.end);
                if (!isNaN(endVal) && endVal > 0) {
                    const shiftedPt = Math.max(0.1, endVal - preSwitchOffset);
                    if (shiftedPt < duration) {
                        allCandidates.push(shiftedPt);
                        if (strongBoundaries.has(idx)) {
                            strongCandidates.push(shiftedPt);
                        } else if (weakBoundaries.has(idx)) {
                            weakCandidates.push(shiftedPt);
                        }
                    }
                }
            });

            const sortedStrongCands = Array.from(new Set(strongCandidates)).sort((a, b) => a - b);
            const sortedWeakCands = Array.from(new Set(weakCandidates)).sort((a, b) => a - b);
            const sortedAllCands = Array.from(new Set(allCandidates)).sort((a, b) => a - b);

            const preferredSplit = Math.max(1.0, bgMinClipDur > 0 ? Math.min(bgMaxClipDur, bgMinClipDur + 1) : 5);
            const minOk = Math.max(1.0, bgMinClipDur - 1.0);
            const maxOk = bgMaxClipDur + 1.0;
            let lastCut = 0;
            let candIdx = 0;

            while (candIdx < sortedAllCands.length) {
                const remainingAll = sortedAllCands.filter(pt => pt > lastCut + 0.01);
                if (remainingAll.length === 0) break;

                const remainingStrong = sortedStrongCands.filter(pt => pt > lastCut + 0.01);
                const remainingWeak = sortedWeakCands.filter(pt => pt > lastCut + 0.01);

                let bestPt = null;
                // 1. 优先寻找区间内的强标点
                for (let i = 0; i < remainingStrong.length; i++) {
                    const pt = remainingStrong[i];
                    const dist = pt - lastCut;
                    if (dist >= minOk && dist <= maxOk) {
                        if (bestPt === null || Math.abs(dist - preferredSplit) < Math.abs(bestPt - lastCut - preferredSplit)) {
                            bestPt = pt;
                        }
                    }
                }

                // 2. 如果没有强标点，寻找弱标点
                if (bestPt === null) {
                    for (let i = 0; i < remainingWeak.length; i++) {
                        const pt = remainingWeak[i];
                        const dist = pt - lastCut;
                        if (dist >= minOk && dist <= maxOk) {
                            if (bestPt === null || Math.abs(dist - preferredSplit) < Math.abs(bestPt - lastCut - preferredSplit)) {
                                bestPt = pt;
                            }
                        }
                    }
                }

                if (bestPt !== null) {
                    cutPoints.push(bestPt);
                    lastCut = bestPt;
                    const idx = sortedAllCands.indexOf(bestPt);
                    candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
                } else {
                    const hasExceedingStrong = remainingStrong.some(pt => pt - lastCut > maxOk);
                    const hasExceedingWeak = remainingWeak.some(pt => pt - lastCut > maxOk);
                    
                    if (hasExceedingStrong || hasExceedingWeak) {
                        const smallerStrong = remainingStrong.filter(pt => pt - lastCut < minOk);
                        const smallerWeak = remainingWeak.filter(pt => pt - lastCut < minOk);
                        
                        if (smallerStrong.length > 0) {
                            const latestSmaller = smallerStrong[smallerStrong.length - 1];
                            cutPoints.push(latestSmaller);
                            lastCut = latestSmaller;
                            const idx = sortedAllCands.indexOf(latestSmaller);
                            candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
                        } else if (smallerWeak.length > 0) {
                            const latestSmaller = smallerWeak[smallerWeak.length - 1];
                            cutPoints.push(latestSmaller);
                            lastCut = latestSmaller;
                            const idx = sortedAllCands.indexOf(latestSmaller);
                            candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
                        } else {
                            let bestWordPt = null;
                            for (let i = 0; i < remainingAll.length; i++) {
                                const pt = remainingAll[i];
                                const dist = pt - lastCut;
                                if (dist >= minOk && dist <= maxOk) {
                                    if (bestWordPt === null || Math.abs(dist - preferredSplit) < Math.abs(bestWordPt - lastCut - preferredSplit)) {
                                        bestWordPt = pt;
                                    }
                                }
                            }
                            
                            if (bestWordPt !== null) {
                                cutPoints.push(bestWordPt);
                                lastCut = bestWordPt;
                                const idx = sortedAllCands.indexOf(bestWordPt);
                                candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
                            } else {
                                const nextForcedCut = lastCut + preferredSplit;
                                cutPoints.push(nextForcedCut);
                                lastCut = nextForcedCut;
                            }
                        }
                    } else {
                        break;
                    }
                }
            }

            if (bgMaxClipDur > 0) {
                while ((duration - lastCut) > bgMaxClipDur) {
                    const nextForcedCut = lastCut + preferredSplit;
                    cutPoints.push(nextForcedCut);
                    lastCut = nextForcedCut;
                }
            }
            if (cutPoints.length > 1 && duration - cutPoints[cutPoints.length - 1] < 1.5) {
                cutPoints[cutPoints.length - 1] = duration;
            } else if (cutPoints[cutPoints.length - 1] < duration - 0.01) {
                cutPoints.push(duration);
            } else {
                cutPoints[cutPoints.length - 1] = duration;
            }
            
            console.log(`[WYSIWYG-BG] 台词卡点切片时刻:`, cutPoints.map(p => p.toFixed(2)).join(', '));
            
            // 根据切分点为每个区间分配素材
            const tDur = bgTransition !== 'none' ? bgTransDur : 0;
            
            for (let idx = 0; idx < cutPoints.length - 1; idx++) {
                const segStart = cutPoints[idx];
                const segEnd = cutPoints[idx + 1];
                const d = segEnd - segStart; // 区间纯时长
                
                // 对应 Clip 应该有的播放长度
                const isLast = (idx === cutPoints.length - 2);
                const clipNeededDur = d + (isLast ? 0 : tDur);
                
                // 从打乱/顺序的素材池里轮流挑选一个素材
                const pick = orderedClipDurations[idx % orderedClipDurations.length];
                
                // 复制一份并调整其 duration
                selectedClips.push({
                    ...pick,
                    duration: clipNeededDur
                });
            }
        } else {
            // 没有字幕段，回退到原有的根据素材池自身时长进行拼接
            console.log(`[WYSIWYG-BG] 无字幕信息，回退到按素材自身时长自动拼接`);
            let totalDur = 0;
            const transOverlap = bgTransition !== 'none' ? bgTransDur : 0;
            let attempts = 0;
            while (totalDur < duration && attempts < 200) {
                const pick = orderedClipDurations[selectedClips.length % orderedClipDurations.length];
                const clipInstance = { ...pick };
                selectedClips.push(clipInstance);
                totalDur += clipInstance.duration - (selectedClips.length > 1 ? transOverlap : 0);
                attempts++;
            }
            // 同样，我们需要校准最后一个 clip 的 duration 以免超出总 duration
            if (selectedClips.length > 0) {
                let runningDur = 0;
                for (let i = 0; i < selectedClips.length; i++) {
                    const isLast = (i === selectedClips.length - 1);
                    if (isLast) {
                        selectedClips[i].duration = Math.max(0.5, duration - runningDur);
                    } else {
                        runningDur += selectedClips[i].duration - transOverlap;
                    }
                }
            }
        }

        console.log(`[WYSIWYG-BG] 最终选中 ${selectedClips.length} 个片段`);

        if (selectedClips.length === 1) {
            // 仅一个片段，直接处理
            const clip = selectedClips[0];
            if (clip.isImage) {
                const args = ['-y', '-i', clip.path, '-vf', scaleCropFilter, '-frames:v', '1', `${framesDir}/frame_000001.png`];
                await runFFmpegSync(ffmpeg, args);
                return { framesDir, frameCount: 1 };
            } else {
                const requiredInputDur = duration / Math.max(ptsFactor, 0.0001);
                const rawDur = clip.rawDuration || requiredInputDur;
                const shouldLoop = requiredInputDur > rawDur + 0.1;
                await extractSimpleLoopWithTrim(ffmpeg, clip.path, framesDir, scaleCropFilter, fps, duration, ptsFactor, shouldLoop, clip.trimStart, clip.trimEnd);
            }
        } else {
            // 多片段拼接
            const args = ['-y'];
            for (const clip of selectedClips) {
                if (clip.isImage) {
                    args.push('-loop', '1', '-t', String(clip.duration), '-i', clip.path);
                } else {
                    const requiredInputDur = clip.duration / Math.max(ptsFactor, 0.0001);
                    const rawDur = clip.rawDuration || requiredInputDur;
                    const shouldLoop = requiredInputDur > rawDur + 0.1;
                    if (shouldLoop) {
                        args.push('-stream_loop', '-1');
                    }
                    if (clip.trimStart != null && clip.trimStart > 0) {
                        args.push('-ss', String(clip.trimStart));
                    }
                    args.push('-t', String(clip.duration / ptsFactor));
                    args.push('-i', clip.path);
                }
            }

            // 构建 filter_complex
            // xfade/concat 对输入流参数很敏感：混合手机视频、图片、不同 fps/SAR/pix_fmt
            // 时如果不先归一化，容易报 timebase/SAR 不一致，或输出抖帧/黑帧。
            const filterParts = [];
            
            if (bgTransition !== 'none' && bgTransDur > 0) {
                // 带转场的 xfade 拼接
                const xfadeTransMap = {
                    crossfade: 'fade',
                    fade_black: 'fadeblack',
                    fade_white: 'fadewhite',
                    slide_left: 'slideleft',
                    slide_right: 'slideright',
                    wipe: 'wipeleft',
                };
                const xfadeTrans = xfadeTransMap[bgTransition] || 'fade';
                const tDur = Math.max(0.1, bgTransDur);

                // 预处理每个输入
                for (let i = 0; i < selectedClips.length; i++) {
                    const clip = selectedClips[i];
                    const clipPtsFilter = clip.isImage ? 'setpts=PTS-STARTPTS' : ptsFilter;
                    const normalizeVideoFilter = `${scaleCropFilter},fps=${fps},setsar=1,format=yuv420p,settb=AVTB,${clipPtsFilter}`;
                    filterParts.push(`[${i}:v]${normalizeVideoFilter}[v${i}]`);
                }

                // 链式 xfade
                let prevLabel = 'v0';
                let cumulativeOffset = 0;
                const xfadeZones = []; // 记录所有转场区间
                for (let i = 1; i < selectedClips.length; i++) {
                    cumulativeOffset += selectedClips[i - 1].duration - tDur;
                    const outLabel = i === selectedClips.length - 1 ? 'vout' : `vx${i}`;
                    const offset = Math.max(0, cumulativeOffset);
                    xfadeZones.push({ start: offset, end: offset + tDur });
                    filterParts.push(
                        `[${prevLabel}][v${i}]xfade=transition=${xfadeTrans}:duration=${tDur.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`
                    );
                    prevLabel = outLabel;
                }

                // ── 智能避让：确保不在转场区间内结束 ──
                let bgTrimDuration = duration;
                for (const zone of xfadeZones) {
                    if (bgTrimDuration > zone.start && bgTrimDuration < zone.end) {
                        const extended = zone.end + 0.05;
                        console.log(`[WYSIWYG-BG] ⚠️ 多素材结尾落在转场区间 [${zone.start.toFixed(2)}s, ${zone.end.toFixed(2)}s]，自动延长背景: ${bgTrimDuration.toFixed(2)}s → ${extended.toFixed(2)}s`);
                        bgTrimDuration = extended;
                        break;
                    }
                }

                args.push(
                    '-filter_complex', filterParts.join(';'),
                    '-map', `[${prevLabel}]`,
                    '-t', String(bgTrimDuration),
                    '-r', String(fps),
                    '-an',
                    ...stableJpegEncoderArgs(),
                    `${framesDir}/frame_%06d.jpg`,
                );
            } else {
                // 无转场: concat 硬切
                for (let i = 0; i < selectedClips.length; i++) {
                    const clip = selectedClips[i];
                    const clipPtsFilter = clip.isImage ? 'setpts=PTS-STARTPTS' : ptsFilter;
                    const normalizeVideoFilter = `${scaleCropFilter},fps=${fps},setsar=1,format=yuv420p,settb=AVTB,${clipPtsFilter}`;
                    filterParts.push(`[${i}:v]${normalizeVideoFilter}[v${i}]`);
                }
                const concatLabels = selectedClips.map((_, i) => `[v${i}]`).join('');
                filterParts.push(`${concatLabels}concat=n=${selectedClips.length}:v=1:a=0[vout]`);

                args.push(
                    '-filter_complex', filterParts.join(';'),
                    '-map', '[vout]',
                    '-t', String(duration),
                    '-r', String(fps),
                    '-an',
                    ...stableJpegEncoderArgs(),
                    `${framesDir}/frame_%06d.jpg`,
                );
            }

            console.log(`[WYSIWYG-BG] FFmpeg 多素材命令 (${selectedClips.length} clips)...`);
            await runFFmpegSync(ffmpeg, args);
        }

        // 统计帧数
        const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
        console.log(`[WYSIWYG-BG] 多素材帧提取完成: ${files.length} 帧`);

        // ── 安全检查：0 帧说明 FFmpeg 拼接失败 ──
        if (files.length === 0) {
            console.error(`[WYSIWYG-BG] ❌ 多素材拼接产出 0 帧！selectedClips: ${selectedClips.length}, duration: ${duration}s`);
            for (const clip of selectedClips) {
                console.error(`  - ${clip.path} (dur=${clip.duration.toFixed(2)}s, isImage=${clip.isImage})`);
            }
            return { error: `多素材拼接失败：FFmpeg 产出 0 帧（${selectedClips.length} 个片段, 目标 ${duration}s）`, framesDir, frameCount: 0 };
        }

        // Stitch background audio if any clip has audio
        let bgAudioPath = null;
        try {
            let anyClipHasAudio = false;
            for (const clip of selectedClips) {
                if (!clip.isImage && await hasAudioTrack(clip.path)) {
                    anyClipHasAudio = true;
                    break;
                }
            }
            if (anyClipHasAudio) {
                console.log(`[WYSIWYG-BG] 检测到背景视频包含音轨，开始合并背景音频...`);
                const audioArgs = ['-y'];
                const filterParts = [];
                let inputIdx = 0;
                for (const clip of selectedClips) {
                    const clipHasAudio = !clip.isImage && await hasAudioTrack(clip.path);
                    if (clipHasAudio) {
                        const requiredInputDur = clip.duration / Math.max(ptsFactor, 0.0001);
                        const rawDur = clip.rawDuration || requiredInputDur;
                        const shouldLoop = requiredInputDur > rawDur + 0.1;
                        if (shouldLoop) {
                            audioArgs.push('-stream_loop', '-1');
                        }
                        if (clip.trimStart != null && clip.trimStart > 0) {
                            audioArgs.push('-ss', String(clip.trimStart));
                        }
                        audioArgs.push('-t', String(clip.duration / ptsFactor));
                        audioArgs.push('-i', clip.path);
                        filterParts.push(`[${inputIdx}:a]aformat=sample_fmts=flt:channel_layouts=stereo:sample_rates=44100[a${inputIdx}]`);
                    } else {
                        audioArgs.push('-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${clip.duration / ptsFactor}`);
                        filterParts.push(`[${inputIdx}:a]aformat=sample_fmts=flt:channel_layouts=stereo:sample_rates=44100[a${inputIdx}]`);
                    }
                    inputIdx++;
                }
                const rawTransitionDur = bgTransition !== 'none' && bgTransDur > 0
                    ? bgTransDur / Math.max(ptsFactor, 0.0001)
                    : 0;
                const shortestRawClipDur = selectedClips.reduce((min, clip) => {
                    const rawDur = clip.duration / Math.max(ptsFactor, 0.0001);
                    return Math.min(min, rawDur);
                }, Infinity);
                const audioFadeDur = Number.isFinite(shortestRawClipDur)
                    ? Math.min(rawTransitionDur, Math.max(0, shortestRawClipDur - 0.05))
                    : 0;

                if (selectedClips.length > 1 && audioFadeDur > 0.01) {
                    let prevLabel = '[a0]';
                    for (let i = 1; i < selectedClips.length; i++) {
                        const outLabel = i === selectedClips.length - 1 ? '[aout]' : `[af${i}]`;
                        filterParts.push(`${prevLabel}[a${i}]acrossfade=d=${audioFadeDur.toFixed(3)}:c1=tri:c2=tri${outLabel}`);
                        prevLabel = outLabel;
                    }
                } else {
                    const concatLabels = selectedClips.map((_, i) => `[a${i}]`).join('');
                    filterParts.push(`${concatLabels}concat=n=${selectedClips.length}:v=0:a=1[aout]`);
                }
                
                const outWav = path.join(framesDir, 'bg_audio.wav');
                audioArgs.push(
                    '-filter_complex', filterParts.join(';'),
                    '-map', '[aout]',
                    '-c:a', 'pcm_s16le',
                    outWav
                );
                console.log(`[WYSIWYG-BG] 合并音频命令: ${ffmpeg} ${audioArgs.join(' ')}`);
                await runFFmpegSync(ffmpeg, audioArgs);
                if (fs.existsSync(outWav)) {
                    bgAudioPath = outWav;
                    console.log(`[WYSIWYG-BG] 背景音频合并成功: ${bgAudioPath}`);
                }
            }
        } catch (audioErr) {
            console.error(`[WYSIWYG-BG] 背景音频合并失败:`, audioErr.message);
        }

        return { framesDir, frameCount: files.length, bgAudioPath };
    }

    // ═══ 单素材模式（原有逻辑）═══

    // 路径验证 + 自动搜索修复
    if (!backgroundPath) {
        throw new Error('背景素材路径为空');
    }
    if (!path.isAbsolute(backgroundPath) || !fs.existsSync(backgroundPath)) {
        const bareFileName = path.basename(backgroundPath);
        console.log(`[WYSIWYG-BG] 背景路径无效，尝试搜索文件: "${bareFileName}"`);
        
        const searchDirs = [
            path.join(os.homedir(), 'Downloads'),
            path.join(os.homedir(), 'Desktop'),
            path.join(os.homedir(), 'Documents'),
        ];
        
        let found = null;
        for (const searchDir of searchDirs) {
            if (!fs.existsSync(searchDir)) continue;
            found = _findFileRecursive(searchDir, bareFileName, 4);
            if (found) break;
        }
        
        if (found) {
            console.log(`[WYSIWYG-BG] 自动找到文件: "${bareFileName}" → "${found}"`);
            backgroundPath = found;
        } else {
            throw new Error(`背景素材路径无效且自动搜索未找到文件: "${backgroundPath}"。请重新添加素材。`);
        }
    }

    const isImage = isImageMedia(backgroundPath);

    if (isImage) {
        const args = [
            '-y', '-i', backgroundPath,
            '-vf', scaleCropFilter,
            '-frames:v', '1',
            ...stableJpegEncoderArgs(),
            `${framesDir}/frame_000001.jpg`,
        ];
        await runFFmpegSync(ffmpeg, args);
        return { framesDir, frameCount: 1 };
    }

    // 视频背景
    const rawBgDuration = await getMediaDuration(backgroundPath);
    const bgDuration = rawBgDuration * ptsFactor;
    const fadeEnabled = loopFade && bgDuration > 0;
    const fadeDur = Math.min(loopFadeDur || 1.0, bgDuration * 0.4);

    if (fadeEnabled && bgDuration > 0 && duration > bgDuration) {
        const step = bgDuration - fadeDur;

        // ── 智能避让：确保背景视频不会在转场过渡中结束 ──
        // xfade 发生在 offset = i * step，持续 fadeDur 秒
        // 如果 duration 落在 [offset, offset + fadeDur] 区间内，画面会是半透明重叠
        let bgTrimDuration = duration;
        for (let i = 1; i <= 20; i++) {
            const xfadeStart = i * step;
            const xfadeEnd = xfadeStart + fadeDur;
            if (bgTrimDuration > xfadeStart && bgTrimDuration < xfadeEnd) {
                // 结束点落在转场区间内 → 延长到转场结束
                const extended = xfadeEnd + 0.05; // 多留 50ms 安全余量
                console.log(`[WYSIWYG-BG] ⚠️ 检测到结尾落在第${i}段转场区间 [${xfadeStart.toFixed(2)}s, ${xfadeEnd.toFixed(2)}s]，自动延长背景: ${bgTrimDuration.toFixed(2)}s → ${extended.toFixed(2)}s`);
                bgTrimDuration = extended;
                break;
            }
        }

        const segCount = Math.min(Math.ceil(bgTrimDuration / step) + 1, 20);

        if (segCount >= 2) {
            const args = ['-y'];
            for (let i = 0; i < segCount; i++) {
                args.push('-i', backgroundPath);
            }

            const filterParts = [`[0:v]${scaleCropFilter},${ptsFilter}[v0]`];
            let prevLabel = 'v0';

            for (let i = 1; i < segCount; i++) {
                const inLabel = `v${i}`;
                const outLabel = i === segCount - 1 ? 'vout' : `vx${i}`;
                const offset = Math.max(0, i * step - 0.01).toFixed(3);
                filterParts.push(`[${i}:v]${scaleCropFilter},${ptsFilter}[${inLabel}]`);
                filterParts.push(
                    `[${prevLabel}][${inLabel}]xfade=transition=fade:duration=${fadeDur.toFixed(3)}:offset=${offset}[${outLabel}]`
                );
                prevLabel = outLabel;
            }

            args.push(
                '-filter_complex', filterParts.join(';'),
                '-map', `[${prevLabel}]`,
                '-t', String(bgTrimDuration),
                '-r', String(fps),
                '-an',
                ...stableJpegEncoderArgs(),
                `${framesDir}/frame_%06d.jpg`,
            );

            console.log(`[WYSIWYG-BG] xfade 循环: ${segCount}段, fadeDur=${fadeDur}s, bgTrim=${bgTrimDuration.toFixed(2)}s`);
            await runFFmpegSync(ffmpeg, args);
        } else {
            const shouldLoop = duration > bgDuration + 0.1;
            await extractSimpleLoop(ffmpeg, backgroundPath, framesDir, scaleCropFilter, fps, duration, ptsFactor, shouldLoop);
        }
    } else {
        const shouldLoop = duration > bgDuration + 0.1;
        await extractSimpleLoop(ffmpeg, backgroundPath, framesDir, scaleCropFilter, fps, duration, ptsFactor, shouldLoop);
    }

    // 统计实际帧数。部分 VFR/时间戳异常视频会在首次非循环提取时提前结束，
    // 如果直接让前端钳制到最后一帧，最终成片会表现为“视频背景变成静帧”。
    let files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
    const expectedFrames = Math.max(1, Math.round(Number(duration || 0) * Number(fps || 0)));
    const shortageTolerance = Math.max(2, Math.ceil(Number(fps || 30) * 0.15));
    if (expectedFrames > 1 && files.length < expectedFrames - shortageTolerance) {
        console.warn(`[WYSIWYG-BG] ⚠️ 背景帧不足 ${files.length}/${expectedFrames}，自动按循环模式重新提取`);
        for (const file of files) {
            try { fs.unlinkSync(path.join(framesDir, file)); } catch (_) { }
        }
        await extractSimpleLoop(ffmpeg, backgroundPath, framesDir, scaleCropFilter, fps, duration, ptsFactor, true);
        files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
        console.log(`[WYSIWYG-BG] 循环重提取完成: ${files.length}/${expectedFrames} 帧`);
    }
    if (expectedFrames > 1 && files.length < expectedFrames - shortageTolerance) {
        throw new Error(`背景视频帧提取不完整：${path.basename(backgroundPath)} 仅得到 ${files.length}/${expectedFrames} 帧。请检查视频是否损坏、时间戳异常或编码不受支持。`);
    }
    console.log(`[WYSIWYG-BG] 帧提取完成: ${files.length} 帧`);
    return { framesDir, frameCount: files.length };
}

async function extractSimpleLoopWithTrim(ffmpeg, backgroundPath, framesDir, scaleCropFilter, fps, duration, ptsFactor = 1.0, shouldLoop = false, trimStart = null, trimEnd = null) {
    let vf = scaleCropFilter;
    if (Math.abs(ptsFactor - 1.0) > 0.01) {
        vf = `${scaleCropFilter},setpts=PTS*${ptsFactor.toFixed(3)}`;
    }
    const args = ['-y'];
    if (shouldLoop) {
        args.push('-stream_loop', '-1');
    }
    if (trimStart != null && trimStart > 0) {
        args.push('-ss', String(trimStart));
    }
    if (trimEnd != null && trimEnd > 0) {
        const dur = trimEnd - (trimStart || 0);
        args.push('-t', String(dur));
    }
    args.push(
        '-i', backgroundPath,
        '-t', String(duration),
        '-vf', vf,
        '-r', String(fps),
        '-an',
        ...stableJpegEncoderArgs(),
        `${framesDir}/frame_%06d.jpg`,
    );
    await runFFmpegSync(ffmpeg, args);
}

async function extractSimpleLoop(ffmpeg, backgroundPath, framesDir, scaleCropFilter, fps, duration, ptsFactor = 1.0, shouldLoop = false) {
    let vf = scaleCropFilter;
    if (Math.abs(ptsFactor - 1.0) > 0.01) {
        vf = `${scaleCropFilter},setpts=PTS*${ptsFactor.toFixed(3)}`;
    }
    const args = ['-y'];
    if (shouldLoop) {
        args.push('-stream_loop', '-1');
    }
    args.push(
        '-i', backgroundPath,
        '-t', String(duration),
        '-vf', vf,
        '-r', String(fps),
        '-an',
        ...stableJpegEncoderArgs(),
        `${framesDir}/frame_%06d.jpg`,
    );
    await runFFmpegSync(ffmpeg, args);
}

function runFFmpegSync(ffmpeg, args, options = {}) {
    return new Promise((resolve, reject) => {
        // 完整命令只写入开发终端，不回显到用户弹窗。多素材导出的滤镜位于
        // 参数末尾，旧版只打印前 15 项会把真正的兼容性问题藏起来。
        console.log(`[WYSIWYG-BG] FFmpeg command: ${JSON.stringify([ffmpeg, ...args])}`);
        const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        let settled = false;
        const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
        const action = options.action || '背景或覆层处理';
        const finish = (callback) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            callback();
        };
        // Animated GIFs can report an invalid duration.  Without a watchdog,
        // a looping FFmpeg decode then leaves the entire batch permanently at
        // the material-preparation progress value.
        const timer = timeoutMs ? setTimeout(() => {
            const msg = `${action}超时（${Math.round(timeoutMs / 1000)} 秒），已停止处理。`;
            console.error(`[WYSIWYG-BG] ${msg}\nCommand: ${JSON.stringify([ffmpeg, ...args])}`);
            try { proc.kill('SIGKILL'); } catch (_) { }
            finish(() => reject(new Error(msg)));
        }, timeoutMs) : null;
        proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-3000); });
        proc.on('close', (code) => {
            if (code === 0) finish(resolve);
            else {
                console.error(`[WYSIWYG-BG] FFmpeg 处理失败 (code=${code}):\n${err}\nCommand: ${JSON.stringify([ffmpeg, ...args])}`);
                finish(() => reject(new Error(formatMediaError(err, {
                    action,
                    code,
                }))));
            }
        });
        proc.on('error', (error) => {
            console.error('[WYSIWYG-BG] FFmpeg 启动失败:', error);
            finish(() => reject(new Error(formatProcessStartError('FFmpeg', ffmpeg, error))));
        });
    });
}

// ═══════════════════════════════════════════════════════
// 阶段 1.5: 预处理视频/GIF覆层 → 提取原分辨率PNG帧序列 (保留Alpha透明度)
// ═══════════════════════════════════════════════════════

/**
 * PNG/JPEG frames do not retain a video's sample-aspect-ratio metadata.
 * Convert coded pixels to their display geometry before extracting frames so
 * anamorphic footage (common in camera exports) cannot be stretched later by
 * the Canvas renderer.
 */
function normalizeDisplayAspectFilter() {
    return 'scale=trunc(iw*sar/2)*2:ih:flags=lanczos,setsar=1';
}

function normalizedDirectBackgroundFilter(inputIndex, scaleCropFilter, ptsFilter, fps, outputLabel) {
    const safeFps = Math.max(1, Number(fps) || 30);
    return `[${inputIndex}:v]${scaleCropFilter},${ptsFilter},fps=${safeFps},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[${outputLabel}]`;
}

async function prepareOverlay(opts) {
    let {
        overlayPath,
        fps = 30,
        duration = 10,  // 需要提取的总时长（跟随背景或者设定视频时长）
        trimStart = null,
        trimEnd = null,
    } = opts;

    if (!overlayPath || !fs.existsSync(overlayPath)) {
        throw new Error(`覆层视频不存在: ${overlayPath}`);
    }

    duration = Number(duration);
    fps = Number(fps);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`覆层目标时长无效: ${opts.duration}`);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error(`覆层帧率无效: ${opts.fps}`);

    // 起止点必须在缓存检查前折算，否则可能误用以前只提取了一小段的残缺缓存。
    if (trimStart != null && trimStart !== '' && trimEnd != null && trimEnd !== '') {
        const start = Number(trimStart);
        const end = Number(trimEnd);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            throw new Error(`内容视频裁剪范围无效: ${trimStart} ～ ${trimEnd}`);
        }
        duration = Math.min(duration, end - start);
    }
    const requiredFrames = expectedFrameCount(duration, fps);
    const isAnimatedGif = /\.gif$/i.test(overlayPath);

    const ffmpeg = findFFmpeg();
    const settings = require('./settings');
    const crypto = require('crypto');
    
    // 生成基于文件内容元特征和提取参数的唯一哈希值
    let cacheHash = `overlay_${generateId()}`;
    try {
        const stat = fs.statSync(overlayPath);
        // Version the cache because older extractions lost SAR metadata when
        // video frames were written as PNG files.
        cacheHash = crypto.createHash('md5').update(`${overlayPath}_${stat.size}_${stat.mtimeMs}_${fps}_${duration}_${trimStart}_${trimEnd}_display-aspect-v2`).digest('hex');
    } catch(e) { /* fallback generates unique id */ }

    const cacheBase = path.join(settings.getSecureTmpDir(), 'videokit_overlay_cache');
    if (!fs.existsSync(cacheBase)) fs.mkdirSync(cacheBase, { recursive: true });
    
    const framesDir = path.join(cacheBase, cacheHash);

    // [缓存击中逻辑]
    if (fs.existsSync(framesDir)) {
        const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.png'));
        if (files.length >= requiredFrames) {
            console.log(`[WYSIWYG-OVERLAY] 覆层缓存命中: ${files.length} 帧 (${framesDir})`);
            return { framesDir, frameCount: files.length };
        }
        console.warn(`[WYSIWYG-OVERLAY] 缓存不完整，重新提取: ${files.length}/${requiredFrames} 帧`);
        for (const file of files) {
            try { fs.unlinkSync(path.join(framesDir, file)); } catch (_) { }
        }
    } else {
        fs.mkdirSync(framesDir, { recursive: true });
    }

    // 动图/视频原分辨率提取，带流循环，输出为 PNG 保留 Alpha 透明度
    // 只有动图和视频需要提取。对于单张图片不需要走到这一步。
    const args = ['-y'];

    // 如果指定了起止点，则不使用无限循环，而是精确截取
    if (trimStart != null && trimStart !== '') {
        args.push('-ss', String(trimStart));
        let actualTrimDur = parseFloat(duration);
        if (trimEnd != null && trimEnd !== '') {
            actualTrimDur = Math.max(0, parseFloat(trimEnd) - parseFloat(trimStart));
            duration = Math.min(parseFloat(duration), actualTrimDur);
        }
    } else {
        // 智能控流：只有当目标时长明显大于素材时长时才进行循环，避免1帧浮点舍入误差导致的末帧闪烁第一帧Bug
        let shouldLoop = true;
        try {
            const mediaDur = await getMediaDuration(overlayPath);
            if (mediaDur > 0 && parseFloat(duration) <= mediaDur + 0.1) {
                shouldLoop = false;
            }
        } catch (e) {
            console.warn(`[WYSIWYG-OVERLAY] 获取素材时长失败，默认开启循环: ${e.message}`);
        }
        if (shouldLoop) {
            args.push('-stream_loop', '-1');  // 无 trim 且确实需要时无限循环
        }
    }

    args.push(
        '-i', overlayPath,
        '-t', String(duration),
        '-r', String(fps),
        // Decode GIF through RGBA before scaling so palette transparency is
        // retained in the PNG sequence rather than composited onto black.
        '-vf', isAnimatedGif ? `format=rgba,${normalizeDisplayAspectFilter()}` : normalizeDisplayAspectFilter(),
        // `-t` limits elapsed timestamps, but malformed GIF timing metadata
        // can prevent it from terminating under `-stream_loop`.  Bound the
        // output count as well, so the requested timeline duration is exact.
        '-frames:v', String(Math.max(1, Math.ceil(duration * fps))),
        '-an',
        `${framesDir}/frame_%06d.png`
    );

    await runFFmpegSync(ffmpeg, args, isAnimatedGif ? {
        // A normal 20–30s GIF finishes far below this.  The cap prevents one
        // damaged GIF from blocking every remaining batch task forever.
        timeoutMs: Math.max(120000, Math.min(300000, Math.ceil(duration * 10000))),
        action: `透明 GIF 覆层解码（${path.basename(overlayPath)}）`,
    } : {});

    const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.png'));
    if (files.length < requiredFrames) {
        throw new Error(
            `内容视频解码不完整：需要约 ${requiredFrames} 帧，实际只得到 ${files.length} 帧。` +
            `请检查素材是否损坏、裁剪范围是否超出视频，或重新导入该素材。文件: ${overlayPath}`
        );
    }
    console.log(`[WYSIWYG-OVERLAY] 覆层提取完成: ${files.length} 帧 (${framesDir})`);
    return { framesDir, frameCount: files.length };
}

// ═══════════════════════════════════════════════════════
// 阶段 2: FFmpeg 编码器会话管理
// ═══════════════════════════════════════════════════════

let _cachedGPUProbeResults = {};

/**
 * 探测 GPU 编码器是否可用：试编码 3 帧纯色测试帧
 * 如果 GPU 编码器初始化失败（驱动/硬件不支持），快速返回 false
 */
function _probeGPUEncoder(ffmpegPath, vcodec, encoderArgs, width, height, fps) {
    // 同一个编码器可能支持基础参数，却不支持某种码率控制模式。
    // 缓存必须包含完整参数，避免 UI 的轻量探测掩盖正式导出参数不兼容。
    const probeKey = `${vcodec}\u0000${encoderArgs.join('\u0000')}`;
    if (_cachedGPUProbeResults[probeKey] !== undefined) {
        return _cachedGPUProbeResults[probeKey];
    }
    try {
        const settings = require('./settings');
        const testOut = settings.secureTmpFile('gpu_probe', '.mp4');
        const testArgs = [
            '-y',
            '-f', 'rawvideo', '-pix_fmt', 'rgba',
            '-s', `${width}x${height}`,
            '-framerate', String(fps),
            '-i', 'pipe:0',
            '-an',
            ...encoderArgs,
            '-pix_fmt', 'yuv420p',
            '-frames:v', '3',
            testOut,
        ];
        console.log(`[WYSIWYG] 探测 GPU 编码器 (${vcodec})...`);
        const testProc = require('child_process').spawnSync(ffmpegPath, testArgs, {
            input: Buffer.alloc(width * height * 4 * 3), // 3 帧纯黑 RGBA
            timeout: 15000,
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        // 清理测试文件
        try { fs.unlinkSync(testOut); } catch (_) { }

        if (testProc.status === 0) {
            console.log(`[WYSIWYG] GPU 编码器 ${vcodec} 可用 ✓`);
            _cachedGPUProbeResults[probeKey] = true;
            return true;
        } else {
            const stderr = (testProc.stderr || '').toString().slice(-500);
            console.warn(`[WYSIWYG] GPU 编码器 ${vcodec} 不可用 (code=${testProc.status}): ${stderr}`);
            _cachedGPUProbeResults[probeKey] = false;
            return false;
        }
    } catch (e) {
        console.warn(`[WYSIWYG] GPU 编码器探测异常: ${e.message}`);
        return false;
    }
}

async function startSession(opts) {
    let {
        width = 1080, height = 1920, fps = 30,
        outputPath, voicePath, voiceVolume = 1.0,
        bgVolume = 0.1, backgroundPath, bgHasAudio = false,
        bgmPath = '', bgmVolume = 0, bgmStart = 0,
        contentVideoPath = '', contentVideoVolume = 1.0,
        bgScale = 100,
        bgRotation = 0,
        bgX = 0,
        bgY = 0,
        bgDurScale = 100,
        audioDurScale = 100,
        reverbEnabled = false, reverbPreset = 'hall', reverbMix = 30, stereoWidth = 100, audioFxTarget = 'all',
        insertAudioClips = [],
        renderedAudioPath = null,
        targetDuration = 0,
        totalFrames = 0,
        useGPU = false,
    } = opts;

    // 路径自动修复（与 prepareBg 相同逻辑）
    if (backgroundPath && (!path.isAbsolute(backgroundPath) || !fs.existsSync(backgroundPath))) {
        const bareFileName = path.basename(backgroundPath);
        console.log(`[WYSIWYG-START] 背景路径无效，尝试搜索: "${bareFileName}"`);
        const searchDirs = [
            path.join(os.homedir(), 'Downloads'),
            path.join(os.homedir(), 'Desktop'),
            path.join(os.homedir(), 'Documents'),
        ];
        for (const searchDir of searchDirs) {
            if (!fs.existsSync(searchDir)) continue;
            const found = _findFileRecursive(searchDir, bareFileName, 4);
            if (found) {
                console.log(`[WYSIWYG-START] 自动找到: "${found}"`);
                backgroundPath = found;
                break;
            }
        }
    }

    const sessionId = generateId();
    const ffmpeg = findFFmpeg();
    const settings = require('./settings');
    const tempVideo = path.join(settings.getSecureTmpDir(), `reels_wysiwyg_${sessionId}.mp4`);

    // 编码器选择：GPU 硬件加速 vs CPU（带自动回退）
    let encoderArgs;
    const platform = process.platform;
    const qualityPreset = opts.qualityPreset || 'faster';
    const crf = opts.crf || 23;
    const targetBitrateMbps = opts.targetBitrateMbps;
    const maxBitrateMbps = opts.maxBitrateMbps;
    const cpuFallbackArgs = cpuH264EncoderArgs(
        qualityPreset,
        crf,
        platform,
        targetBitrateMbps,
        maxBitrateMbps
    );
    let gpuFailed = false;

    if (useGPU) {
        const gpuCandidates = gpuH264EncoderCandidates(
            platform,
            crf,
            targetBitrateMbps,
            maxBitrateMbps
        );
        for (const candidate of gpuCandidates) {
            if (_probeGPUEncoder(ffmpeg, candidate.codec, candidate.args, width, height, fps)) {
                encoderArgs = candidate.args;
                const bitrate = h264RateControlArgs(crf, targetBitrateMbps, maxBitrateMbps)[1];
                console.log(`[WYSIWYG] 使用 GPU 编码 (${candidate.label}, 目标码率 ${bitrate})`);
                break;
            }
        }

        if (!encoderArgs) {
            gpuFailed = true;
            console.log(`[WYSIWYG] ⚠️ GPU 编码器不可用，自动回退到 CPU (libx264) 编码`);
            encoderArgs = cpuFallbackArgs;
        }
    } else {
        encoderArgs = cpuFallbackArgs;
    }

    let args = ['-y'];

    if (opts.alphaOverlayBgPath) {
        // Fast Alpha Overlay 模式：直接由 FFmpeg 解码背景图像/视频
        const bgExt = require('path').extname(opts.alphaOverlayBgPath).toLowerCase();
        const isAlphaBgImage = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(bgExt);
        const rawBgDuration = Math.max(0, Number(opts.alphaBgDuration) || 0);
        const scaledBgDuration = rawBgDuration * Math.max(0.01, (bgDurScale || 100) / 100);
        const fadeDur = Math.min(Math.max(0.05, Number(opts.loopFadeDur) || 1), scaledBgDuration * 0.4);
        const useDirectLoopFade = !isAlphaBgImage && opts.loopFade && scaledBgDuration > fadeDur + 0.05
            && targetDuration > scaledBgDuration + 0.01;
        let bgInputCount = 1;
        if (useDirectLoopFade) {
            const step = scaledBgDuration - fadeDur;
            bgInputCount = Math.max(2, Math.ceil((targetDuration - scaledBgDuration) / step) + 1);
            for (let i = 0; i < bgInputCount; i++) args.push('-i', opts.alphaOverlayBgPath);
            console.log(`[WYSIWYG] 背景直通 xfade 循环: ${bgInputCount} 段, fade=${fadeDur.toFixed(3)}s`);
        } else if (isAlphaBgImage) {
            args.push('-loop', '1', '-i', opts.alphaOverlayBgPath);
        } else {
            args.push('-stream_loop', '-1', '-i', opts.alphaOverlayBgPath);
        }
        
        args.push(
            '-f', 'rawvideo',
            '-pix_fmt', 'rgba',
            '-s', `${width}x${height}`,
            '-framerate', String(fps),
            '-color_range', 'pc',
            '-i', 'pipe:0',
            '-an'
        );

        // Build scaling filter for alpha overlay background
        const rotationDeg = Math.max(-180, Math.min(180, Number(bgRotation) || 0));
        const rotationFilter = Math.abs(rotationDeg) < 0.01 ? '' : `,rotate=${(rotationDeg * Math.PI / 180).toFixed(8)}:ow=rotw(iw):oh=roth(ih)`;
        const scaleFactor = Math.abs(rotationDeg) < 0.01 ? (bgScale || 100) / 100 : Math.max(1, (bgScale || 100) / 100);
        let scaleCropFilter;
        const scaledW = Math.round(width * scaleFactor);
        const scaledH = Math.round(height * scaleFactor);
        if (scaleFactor >= 1.0) {
            scaleCropFilter = `${normalizeDisplayAspectFilter()}${rotationFilter},scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,crop=${width}:${height}:'max(0, min(in_w-out_w, ((in_w-out_w)/2)*(1-(${bgX}/100))))':'max(0, min(in_h-out_h, ((in_h-out_h)/2)*(1-(${bgY}/100))))',setsar=1`;
        } else {
            scaleCropFilter = `${normalizeDisplayAspectFilter()}${rotationFilter},scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease,pad=${width}:${height}:'max(0, min(ow-iw, ((ow-iw)/2)*(1+(${bgX}/100))))':'max(0, min(oh-ih, ((oh-ih)/2)*(1+(${bgY}/100))))':color=black,setsar=1`;
        }
        if (opts.bgFlipH) scaleCropFilter += ',hflip';
        if (opts.bgFlipV) scaleCropFilter += ',vflip';

        // Build speed filter for background video (only if not an image)
        let ptsFilter = 'setpts=PTS-STARTPTS';
        if (!isAlphaBgImage) {
            const ptsFactor = (bgDurScale || 100) / 100;
            if (Math.abs(ptsFactor - 1.0) > 0.01) {
                ptsFilter = `setpts=(PTS-STARTPTS)*${ptsFactor.toFixed(3)}`;
            }
        }

        // 背景素材可能是 50/60fps，而 Canvas 前景通常按 25/30fps 写入。
        // overlay 默认可继承高帧率背景的时间基，导致 FFmpeg 输出帧数约为写入帧数的 2 倍，
        // 提前达到 -frames:v 后以 code=0 正常退出，随后的管道写入却会被上层误报为失败。
        // 在最终输出端固定任务帧率，保证一个 Canvas 帧对应一个输出帧。
        let bgFilter;
        if (useDirectLoopFade) {
            const parts = [];
            for (let i = 0; i < bgInputCount; i++) {
                parts.push(normalizedDirectBackgroundFilter(i, scaleCropFilter, ptsFilter, fps, `bg${i}`));
            }
            let previous = 'bg0';
            const step = scaledBgDuration - fadeDur;
            for (let i = 1; i < bgInputCount; i++) {
                const out = i === bgInputCount - 1 ? 'bg' : `bgx${i}`;
                parts.push(`[${previous}][bg${i}]xfade=transition=fade:duration=${fadeDur.toFixed(3)}:offset=${(i * step).toFixed(3)}[${out}]`);
                previous = out;
            }
            bgFilter = parts.join(';');
        } else {
            // Single/stream-loop backgrounds used to reach overlay with their
            // source frame cadence and pixel format intact. A 10-bit VFR clip
            // could therefore feed tens of thousands of surplus frames into
            // the graph (drop=... in FFmpeg), then miss the finalization wait.
            // Normalize before overlay just like the xfade branch already did.
            bgFilter = normalizedDirectBackgroundFilter(0, scaleCropFilter, ptsFilter, fps, 'bg');
        }
        const fgInput = bgInputCount;
        const filterComplex = `${bgFilter};[${fgInput}:v]scale=in_range=full:in_color_matrix=bt709:out_range=limited:out_color_matrix=bt709,format=yuva420p[fg];[bg][fg]overlay=0:0:format=auto:shortest=1,fps=${fps}[outv]`;
        args.push('-filter_complex', filterComplex, '-map', '[outv]');

    } else {
        // 传统模式：从管道读取已合成好的全尺寸帧
        args.push(
            '-f', 'rawvideo',
            '-pix_fmt', 'rgba',
            '-s', `${width}x${height}`,
            '-framerate', String(fps),
            '-color_range', 'pc',
            '-i', 'pipe:0',
            '-an',
            '-vf', 'scale=in_range=full:in_color_matrix=bt709:out_range=limited:out_color_matrix=bt709'
        );
    }

    args.push(
        ...encoderArgs,
        '-pix_fmt', 'yuv420p',
        '-color_range', 'tv',
        '-colorspace', 'bt709',
        '-color_primaries', 'bt709',
        '-color_trc', 'bt709',
        ...(totalFrames > 0 ? ['-frames:v', String(totalFrames)] : []),
        '-movflags', '+faststart',
        tempVideo
    );

    console.log(`[WYSIWYG] 启动编码: ${ffmpeg} ${args.join(' ')}`);
    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });

    const session = {
        id: sessionId, proc, tempVideo, outputPath,
        voicePath, voiceVolume, bgVolume, backgroundPath, bgHasAudio,
        bgmPath, bgmVolume, bgmStart: Math.max(0, Number(bgmStart) || 0),
        contentVideoPath, contentVideoVolume,
        bgDurScale,
        audioDurScale,
        reverbEnabled, reverbPreset, reverbMix, stereoWidth, audioFxTarget,
        insertAudioClips,
        renderedAudioPath,
        targetDuration,
        totalFrames,
        width, height, fps,
        stderr: '', frameCount: 0, bytesWritten: 0,
        closed: false, encoderExited: false, encoderExitCode: null, encoderExitSignal: null,
        gpuFallback: gpuFailed,  // 记录是否发生了 GPU 回退
    };

    if (renderedAudioPath) {
        console.log(`[WYSIWYG] 使用预渲染音频 (Web Audio WYSIWYG): ${renderedAudioPath}`);
    }

    // 防止 FFmpeg 意外退出时 stdin.write 触发 EPIPE 崩溃
    proc.stdin.on('error', (err) => {
        if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
            console.warn(`[WYSIWYG] stdin 管道断开 (${err.code})，FFmpeg 可能已退出`);
        } else {
            console.error(`[WYSIWYG] stdin 错误: ${err.message}`);
        }
    });

    proc.stderr.on('data', (chunk) => {
        session.stderr = (session.stderr + chunk.toString()).slice(-4000);
    });
    proc.on('error', (err) => {
        console.error(`[WYSIWYG] FFmpeg 错误: ${err.message}`);
        session.encoderExited = true;
        session.encoderExitCode = -1;
    });
    proc.on('close', (code, signal) => {
        session.encoderExited = true;
        session.encoderExitCode = code;
        session.encoderExitSignal = signal || null;
        console.log(`[WYSIWYG] FFmpeg 编码退出 (code=${code}, signal=${signal || 'none'}), 帧: ${session.frameCount}`);
        if (code !== 0) {
            console.error(`[WYSIWYG] FFmpeg stderr: ${session.stderr.slice(-800)}`);
        }
    });

    sessions.set(sessionId, session);

    // 等待 FFmpeg 进程启动就绪（rawvideo 模式下管道初始化需要时间）
    await new Promise(r => setTimeout(r, 300));
    if (session.encoderExited) {
        console.error(`[WYSIWYG] FFmpeg 启动失败! stderr: ${session.stderr}`);
        sessions.delete(sessionId);
        return null;
    }

    return sessionId;
}

function validateRawFrameSize(width, height, actualSize) {
    const expectedSize = Number(width) * Number(height) * 4;
    if (!Number.isFinite(expectedSize) || expectedSize <= 0) return '视频帧尺寸配置无效';
    if (actualSize !== expectedSize) {
        return `帧数据不完整：实际 ${actualSize} 字节，期望 ${expectedSize} 字节`;
    }
    return '';
}

function validateFrameCompletion(totalFrames, frameCount) {
    const expected = Number(totalFrames) || 0;
    if (expected > 0 && frameCount !== expected) {
        return `导出帧数不完整：实际写入 ${frameCount} 帧，计划 ${expected} 帧`;
    }
    return '';
}

async function writeFrame(sessionId, rawData) {
    const session = sessions.get(sessionId);
    if (!session || session.closed) {
        console.error(`[WYSIWYG] writeFrame: 会话无效 (id=${sessionId})`);
        return { ok: false, error: '编码会话无效或已关闭' };
    }
    if (session.encoderExited) {
        const detail = session.stderr.slice(-500);
        console.error(`[WYSIWYG] writeFrame: FFmpeg 已退出 (code=${session.encoderExitCode}), stderr: ${detail}`);
        return {
            ok: false,
            error: formatMediaError(session.stderr, {
                action: '视频编码',
                code: session.encoderExitCode,
            }),
        };
    }

    try {
        // IPC 传来的数据可能是 ArrayBuffer、Buffer、Uint8Array 或序列化对象
        let buf;
        if (Buffer.isBuffer(rawData)) {
            buf = rawData;
        } else if (rawData instanceof ArrayBuffer || ArrayBuffer.isView(rawData)) {
            buf = Buffer.from(rawData);
        } else if (rawData && rawData.type === 'Buffer' && Array.isArray(rawData.data)) {
            buf = Buffer.from(rawData.data);
        } else if (rawData && typeof rawData === 'object') {
            // Electron IPC 有时将 ArrayBuffer 序列化为普通 object
            buf = Buffer.from(new Uint8Array(Object.values(rawData)));
        } else {
            console.error(`[WYSIWYG] writeFrame: 无法识别的数据类型: ${typeof rawData}`);
            return { ok: false, error: `帧数据格式无法识别 (${typeof rawData})` };
        }

        // 每一帧都必须是完整 RGBA 数据；禁止静默跳过损坏帧并生成问题成片。
        const expectedSize = session.width * session.height * 4;
        const sizeError = validateRawFrameSize(session.width, session.height, buf.length);
        if (sizeError) {
            console.error(`[WYSIWYG] writeFrame: ${sizeError}`);
            return { ok: false, error: sizeError };
        }

        if (session.frameCount === 0) {
            console.log(`[WYSIWYG] 首帧大小: ${(buf.length / 1024 / 1024).toFixed(2)} MB (期望 ${(expectedSize / 1024 / 1024).toFixed(2)} MB)`);
        }

        // 检查 FFmpeg 是否在写入前已退出
        if (session.encoderExited) {
            const detail = session.stderr.slice(-500);
            console.error(`[WYSIWYG] FFmpeg 在写帧前退出! stderr: ${detail}`);
            return {
                ok: false,
                error: formatMediaError(session.stderr, {
                    action: '视频编码',
                    code: session.encoderExitCode,
                }),
            };
        }

        const written = session.proc.stdin.write(buf);
        session.frameCount++;
        session.bytesWritten += buf.length;
        if (!written) {
            await new Promise((r) => {
                session.proc.stdin.once('drain', r);
                setTimeout(r, 5000);
            });
        }

        // 写入后检查 FFmpeg 是否还活着（尤其是前几帧，编码器可能延迟初始化失败）
        if (session.frameCount <= 5) {
            await new Promise(r => setTimeout(r, 50)); // 给 FFmpeg 一点处理时间
            if (session.encoderExited && session.encoderExitCode !== 0) {
                const detail = session.stderr.slice(-500);
                console.error(`[WYSIWYG] FFmpeg 在第 ${session.frameCount} 帧后退出! stderr: ${detail}`);
                return {
                    ok: false,
                    error: formatMediaError(session.stderr, {
                        action: `视频编码（第 ${session.frameCount} 帧）`,
                        code: session.encoderExitCode,
                    }),
                };
            }
        }

        return { ok: true };
    } catch (e) {
        console.error(`[WYSIWYG] 写帧失败 (#${session.frameCount}): ${e.message}`);
        if (session.stderr) {
            console.error(`[WYSIWYG] FFmpeg stderr: ${session.stderr.slice(-500)}`);
        }
        return {
            ok: false,
            error: session.stderr
                ? formatMediaError(session.stderr, { action: '写入视频帧', code: session.encoderExitCode })
                : `写入视频帧失败：${e.message}`,
        };
    }
}

// 持久帧通道：避免每一帧都走一次 ipcRenderer.invoke 的往返等待。
// Canvas 像素仍由同一个 FFmpeg/rawvideo 编码器处理，因而不会改变画面效果。
function attachFramePipeline(sessionId, port) {
    const session = sessions.get(sessionId);
    if (!session || session.closed || !port) {
        return { ok: false, error: '编码会话无效，无法建立帧流水线' };
    }
    if (session.framePipeline) {
        try { session.framePipeline.port.close(); } catch (_) { }
    }
    const pipeline = { port, pending: Promise.resolve(), failed: null, closed: false, expectedSeq: 0 };
    session.framePipeline = pipeline;
    port.on('message', (event) => {
        const data = event && event.data ? event.data : event;
        if (!data || data.type !== 'frame' || pipeline.closed) return;
        pipeline.pending = pipeline.pending.then(async () => {
            if (!pipeline.failed && (!Number.isInteger(data.seq) || data.seq !== pipeline.expectedSeq)) {
                pipeline.failed = `帧序号不连续：收到 ${data.seq}，期望 ${pipeline.expectedSeq}`;
            }
            if (!pipeline.failed) {
                pipeline.expectedSeq++;
                const result = await writeFrame(sessionId, data.raw);
                if (!result || !result.ok) pipeline.failed = (result && result.error) || '帧流水线写入失败';
            }
            try {
                port.postMessage({ type: 'ack', seq: data.seq, ok: !pipeline.failed, error: pipeline.failed || '' });
            } catch (_) { }
        }).catch((err) => {
            pipeline.failed = err.message || '帧流水线异常';
            try { port.postMessage({ type: 'ack', seq: data.seq, ok: false, error: pipeline.failed }); } catch (_) { }
        });
    });
    try { port.start(); } catch (_) { }
    return { ok: true };
}

async function flushFramePipeline(session) {
    if (!session || !session.framePipeline) return;
    await session.framePipeline.pending;
    const pipeline = session.framePipeline;
    pipeline.closed = true;
    try { pipeline.port.close(); } catch (_) { }
    session.framePipeline = null;
    if (pipeline.failed) throw new Error(pipeline.failed);
}

async function finishSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return { error: '会话不存在' };
    if (session.closed) return { error: '会话已关闭' };
    try {
        await flushFramePipeline(session);
    } catch (e) {
        abortSession(sessionId);
        return { error: `帧流水线失败：${e.message}` };
    }
    const completionError = validateFrameCompletion(session.totalFrames, session.frameCount);
    if (completionError) {
        abortSession(sessionId);
        return { error: completionError };
    }
    session.closed = true;

    const mb = (session.bytesWritten / 1024 / 1024).toFixed(1);
    console.log(`[WYSIWYG] 完成编码... 帧: ${session.frameCount}, 数据: ${mb}MB`);

    // 等待编码器完成
    let finalizeTimedOut = false;
    if (!session.encoderExited) {
        await new Promise((resolve) => {
            let settled = false;
            const finishWait = (timedOut = false) => {
                if (settled) return;
                settled = true;
                finalizeTimedOut = timedOut;
                clearTimeout(timer);
                session.proc.removeListener('close', onClose);
                resolve();
            };
            const onClose = () => finishWait(false);
            const timer = setTimeout(() => finishWait(true), 120000);
            session.proc.once('close', onClose);
            try { session.proc.stdin.end(); } catch (_) { }
            if (session.encoderExited) finishWait(false);
        });
    }

    if (finalizeTimedOut && !session.encoderExited) {
        console.error(`[WYSIWYG] 编码收尾超时，正在终止 FFmpeg。帧: ${session.frameCount}/${session.totalFrames}`);
        try { session.proc.kill('SIGKILL'); } catch (_) { }
        await new Promise(resolve => {
            if (session.encoderExited) { resolve(); return; }
            const timer = setTimeout(resolve, 5000);
            session.proc.once('close', () => { clearTimeout(timer); resolve(); });
        });
        cleanup(session);
        return {
            error: '视频编码收尾超时：源素材的帧率或时间戳异常。建议先转为固定帧率 8-bit MP4 后重试',
        };
    }

    if (session.encoderExitCode !== 0) {
        console.error(`[WYSIWYG] 编码失败 (code=${session.encoderExitCode}):\n${session.stderr}`);
        const error = formatMediaError(session.stderr, {
            action: '视频编码',
            code: session.encoderExitCode,
        });
        cleanup(session);
        return { error };
    }

    if (!fs.existsSync(session.tempVideo) || fs.statSync(session.tempVideo).size < 1024) {
        cleanup(session);
        return { error: '临时视频无效' };
    }

    try {
        await mixAudio(session);
        cleanup(session);
        return { output_path: session.outputPath };
    } catch (e) {
        cleanup(session);
        return { error: `音频混合失败: ${e.message}` };
    }
}

// ═══ 脉冲响应预设 — 与预览 batch-reels.js 中 _REVERB_PRESETS 完全相同 ═══
const _IMPULSE_PRESETS = {
    room:   { decay: 0.8, duration: 0.6 },
    hall:   { decay: 2.0, duration: 1.5 },
    church: { decay: 4.0, duration: 3.0 },
    plate:  { decay: 1.2, duration: 1.0 },
    echo:   { decay: 1.5, duration: 0.8 },
};

// 确定性伪随机数（mulberry32）— 与预览 batch-reels.js 完全相同
function _mulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function _stableShuffleBgClips(clips, seedText) {
    let seed = 2166136261;
    const text = String(seedText || '');
    for (let i = 0; i < text.length; i++) {
        seed ^= text.charCodeAt(i);
        seed = Math.imul(seed, 16777619);
    }
    const rng = _mulberry32(seed >>> 0);
    const shuffled = clips.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function _presetSeed(preset) {
    let h = 0x811c9dc5;
    for (let i = 0; i < preset.length; i++) {
        h ^= preset.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * 在 Node.js 中生成脉冲响应 WAV 文件
 * 使用与预览完全相同的 seeded PRNG + 算法，保证 IR 一致
 */
function _generateImpulseWav(preset, sampleRate = 44100) {
    const p = _IMPULSE_PRESETS[preset] || _IMPULSE_PRESETS.hall;
    const presetKey = preset || 'hall';
    const length = Math.ceil(sampleRate * p.duration);
    const numChannels = 2;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = length * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const buffer = Buffer.alloc(totalSize);

    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(totalSize - 8, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * blockAlign, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // 逐声道生成 — 与预览完全相同的种子和算法
    // 注意：预览的 Web Audio createBuffer 按声道填充
    // 所以这里也按声道交替写入 WAV 的交错格式
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
        const rng = _mulberry32(_presetSeed(presetKey) + ch * 0xDEAD);
        const chData = new Float64Array(length);
        for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const envelope = Math.exp(-t / (p.decay * 0.3));
            chData[i] = (rng() * 2 - 1) * envelope;
        }
        channels.push(chData);
    }

    // 写入交错 PCM 数据
    let offset = headerSize;
    for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const int16 = Math.max(-32768, Math.min(32767, Math.round(channels[ch][i] * 32767)));
            buffer.writeInt16LE(int16, offset);
            offset += bytesPerSample;
        }
    }

    const settings = require('./settings');
    const irPath = settings.secureTmpFile('ir_reverb', '.wav');
    fs.writeFileSync(irPath, buffer);
    return irPath;
}

/**
 * 构建 FFmpeg afir 卷积混响 filter（等价于 Web Audio ConvolverNode）
 * 使用干/湿声混合，与预览的 dryGain/wetGain 逻辑一致
 */
function _buildReverbFilter(session, inputLabel, outputLabel) {
    if (!session.reverbEnabled) return null;
    const mix = Math.max(0, Math.min(100, session.reverbMix || 30)) / 100;
    const dryLevel = (1 - mix * 0.5).toFixed(3);
    const wetLevel = mix.toFixed(3);

    // 生成脉冲响应 WAV
    const irPath = _generateImpulseWav(session.reverbPreset);
    session._irCleanup = irPath;

    // afir 滤镜：干/湿混合
    // 关键：normalize=0 防止 amix 除以输入数（Web Audio 是直接相加）
    const filter = `${inputLabel}asplit=2[dry___][wet___];` +
        `[dry___]volume=${dryLevel}[dryo___];` +
        `[wet___][ir___]afir=dry=0:wet=1[weto___];` +
        `[weto___]volume=${wetLevel}[wetv___];` +
        `[dryo___][wetv___]amix=inputs=2:duration=first:dropout_transition=0:normalize=0${outputLabel}`;

    return { filter, irPath };
}

/**
 * 构建立体声增强 filter（等价于预览的 ChannelSplitter + DelayNode）
 */
function _buildStereoFilter(session, inputLabel, outputLabel) {
    const stereoW = (session.stereoWidth || 100) / 100;
    if (stereoW <= 1.05) return null;

    const widthFactor = Math.max(0, (stereoW - 1)) * 0.015;
    const delayL = Math.round(widthFactor * 0.3 * 1000); // ms
    const delayR = Math.round(widthFactor * 0.7 * 1000); // ms

    return `${inputLabel}channelsplit[l___][r___];` +
        `[l___]adelay=${delayL}|0[ld___];` +
        `[r___]adelay=0|${delayR}[rd___];` +
        `[ld___][rd___]amerge=inputs=2${outputLabel}`;
}

async function mixAudio(session) {
    const ffmpeg = findFFmpeg();

    const outDir = path.dirname(session.outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    let { tempVideo, outputPath, voicePath, voiceVolume, bgVolume, backgroundPath, bgHasAudio, bgmPath, bgmVolume } = session;
    const bgmStart = Math.max(0, Number(session.bgmStart) || 0);

    // Fail before launching FFmpeg (or the slower Web Audio effects renderer) so
    // the UI can show the actual missing asset instead of a long stderr tail.
    if (voicePath && !fs.existsSync(voicePath)) {
        throw new Error(`配音文件不存在，请重新选择或生成配音：${voicePath}`);
    }
    if (bgmPath && bgmVolume > 0.001 && !fs.existsSync(bgmPath)) {
        throw new Error(`背景音乐文件不存在，请重新选择：${bgmPath}`);
    }

    // ═══ Chromium Web Audio 离线渲染（隐藏窗口 — 与预览 100% 同引擎）═══
    let targetPathToRender = null;
    let targetKey = null; // 'voice', 'bg', 'bgm'

    if (session.reverbEnabled || (session.stereoWidth && session.stereoWidth !== 100)) {
       const fxT = session.audioFxTarget || 'all';
       if ((fxT === 'voice' || fxT === 'all') && voicePath) {
           targetPathToRender = voicePath; targetKey = 'voice';
       } else if ((fxT === 'bg' || fxT === 'all') && backgroundPath) {
           targetPathToRender = backgroundPath; targetKey = 'bg';
       } else if ((fxT === 'bgm' || fxT === 'all') && bgmPath) {
           targetPathToRender = bgmPath; targetKey = 'bgm';
       }
    }

    if (targetPathToRender) {
        try {
            const wavResult = await renderChromiumAudioWav({
                filePath: targetPathToRender,
                reverbEnabled: session.reverbEnabled,
                reverbPreset: session.reverbPreset,
                reverbMix: session.reverbMix,
                stereoWidth: session.stereoWidth
            });

            if (wavResult) {
                if (targetKey === 'voice') {
                    voicePath = wavResult;
                    voiceVolume = 1.0;
                    session._renderedVoiceCleanup = wavResult;
                } else if (targetKey === 'bg') {
                    // 重要: backgroundPath 同时是视频源，不能替换为 WAV！
                    // 将渲染后的背景音频存到独立变量，后面作为额外输入混入
                    session._renderedBgAudioPath = wavResult;
                    session._renderedBgCleanup = wavResult;
                    // 标记原始背景音频不再需要（已经被渲染过了）
                    bgHasAudio = false;
                    console.log(`[WYSIWYG] bg 音频已渲染为 WAV: ${wavResult}`);
                } else if (targetKey === 'bgm') {
                    bgmPath = wavResult;
                    session._renderedBgmCleanup = wavResult;
                }

                session.reverbEnabled = false;
                session.stereoWidth = 100;
            } else {
                throw new Error('Chromium render returned null/false');
            }
        } catch (e) {
            console.error(`[WYSIWYG] Chromium Web Audio 渲染失败，回退到 FFmpeg afir:`, e.message);
        }
    }

    // 检测 BGM 是否有效
    const hasBgm = bgmPath && fs.existsSync(bgmPath) && bgmVolume > 0.001;
    // 检测覆层视频音频是否有效
    const cvPath = session.contentVideoPath;
    const cvVol = session.contentVideoVolume ?? 1.0;
    const hasContentVideoAudio = cvPath && fs.existsSync(cvPath) && !isImageMedia(cvPath) && await hasAudioTrack(cvPath);
    if (hasContentVideoAudio) console.log(`[WYSIWYG] 覆层视频含音频轨: ${cvPath}`);
    // 检测是否有渲染后的背景音频（bg 层特效渲染产物）
    const renderedBgAudio = session._renderedBgAudioPath && fs.existsSync(session._renderedBgAudioPath)
        ? session._renderedBgAudioPath : null;

    let args;

    if (!voicePath) {
        // 无配音
        const bgVolumeVal = typeof bgVolume === 'number' ? bgVolume : 0.1;
        const wantBgAudio = bgVolumeVal > 0.001;
        const bgReallyHasAudio = wantBgAudio && backgroundPath && fs.existsSync(backgroundPath) && await hasAudioTrack(backgroundPath);

        // 收集所有音频源
        let audioInputs = []; // [{path, volume, loop, durationScale}]
        if (renderedBgAudio) {
            // 渲染后的背景音频（已含特效），不需要 loop
            audioInputs.push({ path: renderedBgAudio, volume: bgVolumeVal, loop: false, durationScale: session.bgDurScale });
        } else if (bgReallyHasAudio) {
            audioInputs.push({ path: backgroundPath, volume: bgVolumeVal, loop: true, durationScale: session.bgDurScale });
        }
        if (hasBgm) {
            audioInputs.push({ path: bgmPath, volume: bgmVolume, loop: true, startTime: bgmStart });
        }
        if (hasContentVideoAudio) {
            audioInputs.push({ path: cvPath, volume: cvVol, loop: true });
        }

        if (audioInputs.length === 0) {
            console.log('[WYSIWYG] 无配音且无音频源，直接拷贝视频');
            args = ['-y', '-i', tempVideo, '-c:v', 'copy', '-an', ...outputDurationArgs(session), '-movflags', '+faststart', outputPath];
        } else {
            console.log(`[WYSIWYG] 无配音，混合 ${audioInputs.length} 个音频源`);
            args = ['-y', '-i', tempVideo];
            let nextIdx = 1;
            for (const ai of audioInputs) {
                if (Number(ai.startTime) > 0) args.push('-ss', Number(ai.startTime).toFixed(3));
                if (ai.loop) args.push('-stream_loop', '-1');
                args.push('-i', ai.path);
                nextIdx++;
            }
            let filterParts = [];
            let labels = [];
            audioInputs.forEach((ai, i) => {
                const idx = i + 1;
                const label = `[a${i}]`;
                const atempoChain = buildAtempoChainForDurationScale(ai.durationScale || 100);
                const filter = atempoChain
                    ? `volume=${ai.volume.toFixed(3)},${atempoChain}`
                    : `volume=${ai.volume.toFixed(3)}`;
                filterParts.push(`[${idx}:a]${filter}${label}`);
                labels.push(label);
            });
            if (labels.length > 1) {
                filterParts.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0[aout]`);
            } else {
                filterParts.push(`${labels[0]}acopy[aout]`);
            }
            args.push('-filter_complex', filterParts.join(';'),
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', ...outputDurationArgs(session), '-movflags', '+faststart', outputPath);
        }
    } else {
        args = ['-y', '-i', tempVideo, '-i', voicePath];

        let nextInputIdx = 2;
        const bgVolumeVal2 = typeof bgVolume === 'number' ? bgVolume : 0.1;

        // 渲染后的背景音频（优先于原始背景音轨）
        let renderedBgInputIdx = -1;
        if (renderedBgAudio) {
            args.push('-i', renderedBgAudio);
            renderedBgInputIdx = nextInputIdx;
            nextInputIdx++;
        }

        // 二次验证：即使前端标记 bgHasAudio=true，也用 ffprobe 实际检测是否真有音频轨
        const bgWanted = !renderedBgAudio && bgHasAudio && bgVolumeVal2 > 0.001 && backgroundPath && fs.existsSync(backgroundPath);
        const bgReallyHasAudio = bgWanted ? await hasAudioTrack(backgroundPath) : false;
        if (bgWanted && !bgReallyHasAudio) {
            console.log(`[WYSIWYG] 背景视频无音频轨道，跳过背景音频混合: ${backgroundPath}`);
        }
        const bgInputIdx = bgReallyHasAudio ? nextInputIdx : -1;
        if (bgInputIdx >= 0) {
            args.push('-stream_loop', '-1', '-i', backgroundPath);
            nextInputIdx++;
        }
        const bgmInputIdx = hasBgm ? nextInputIdx : -1;
        if (bgmInputIdx >= 0) {
            if (bgmStart > 0) args.push('-ss', bgmStart.toFixed(3));
            args.push('-stream_loop', '-1', '-i', bgmPath);
            nextInputIdx++;
        }
        const cvInputIdx = hasContentVideoAudio ? nextInputIdx : -1;
        if (cvInputIdx >= 0) {
            args.push('-stream_loop', '-1', '-i', cvPath);
            nextInputIdx++;
        }
        const insertInputs = [];
        for (const item of (session.insertAudioClips || [])) {
            if (!item?.sourcePath || !fs.existsSync(item.sourcePath) || item.audioMode === 'keep-main' || item.audioMode === 'mute') continue;
            if (!(await hasAudioTrack(item.sourcePath))) continue;
            const inputIdx = nextInputIdx++;
            args.push('-i', item.sourcePath);
            insertInputs.push({ ...item, inputIdx });
        }

        // 混响需要额外的 IR 文件输入
        let irInputIdx = -1;
        let reverbResult = null;
        if (session.reverbEnabled) {
            reverbResult = _buildReverbFilter(session, '[vpre]', '[vfx]');
            if (reverbResult) {
                args.push('-i', reverbResult.irPath);
                irInputIdx = nextInputIdx;
                nextInputIdx++;
            }
        }

        // 构建音频 filter chain
        let filterParts = [];
        let voiceOutLabel;

        // “仅素材原声”不是简单地额外加一轨：在插入片段覆盖的时间段，主音轨
        // 必须静音，否则听起来仍会有配音/BGM 混入。音量表达式按帧求值，片段
        // 之外保持原来的主音量。
        const sourceOnlyWindows = (session.insertAudioClips || [])
            .filter(item => item?.audioMode === 'source-only')
            .map(item => {
                const start = Math.max(0, Number(item.timelineStart) || 0);
                const end = start + Math.max(.05, Number(item.duration) || 1.5);
                // 逗号属于 FFmpeg filtergraph 分隔符，必须在表达式内转义。
                return `between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})`;
            });
        const mainAudioGate = sourceOnlyWindows.length
            ? `*if(${sourceOnlyWindows.join('+')}\\,0\\,1):eval=frame`
            : '';

        // 人声音量
        filterParts.push(`[1:a]volume=${voiceVolume.toFixed(3)}${mainAudioGate}[vpre]`);

        // 音频变速（atempo）：audioDurScale=150% → 减速为 0.667x（拉长1.5倍）
        const aDurScale = session.audioDurScale || 100;
        if (aDurScale !== 100) {
            let targetTempo = 100 / aDurScale;
            const tempoFilters = [];
            while (targetTempo < 0.5) {
                tempoFilters.push('atempo=0.5');
                targetTempo /= 0.5;
            }
            while (targetTempo > 100.0) {
                tempoFilters.push('atempo=100.0');
                targetTempo /= 100.0;
            }
            tempoFilters.push(`atempo=${targetTempo.toFixed(6)}`);
            filterParts.push(`[vpre]${tempoFilters.join(',')}[vpre]`);
            console.log(`[WYSIWYG] 音频变速: audioDurScale=${aDurScale}%, atempo chain: ${tempoFilters.join(',')}`);
        }

        // 混响
        if (reverbResult) {
            filterParts.push(`[${irInputIdx}:a]aformat=sample_fmts=flt:channel_layouts=stereo[ir___]`);
            filterParts.push(reverbResult.filter);
            voiceOutLabel = '[vfx]';
        } else {
            filterParts.push('[vpre]acopy[vfx]');
            voiceOutLabel = '[vfx]';
        }

        // 立体声增强
        const stereoFilter = _buildStereoFilter(session, voiceOutLabel, '[vstereo]');
        if (stereoFilter) {
            filterParts.push(stereoFilter);
            voiceOutLabel = '[vstereo]';
        }

        // 重命名为 [voice]
        if (voiceOutLabel !== '[voice]') {
            filterParts.push(`${voiceOutLabel}acopy[voice]`);
        }

        let mixLabels = ['[voice]'];

        // 渲染后的背景音频（已含特效）
        if (renderedBgInputIdx >= 0) {
            const bgTempo = buildAtempoChainForDurationScale(session.bgDurScale || 100);
            const bgBaseFilter = `volume=${bgVolume.toFixed(3)}${mainAudioGate}`;
            const bgFilter = bgTempo ? `${bgBaseFilter},${bgTempo}` : bgBaseFilter;
            filterParts.push(`[${renderedBgInputIdx}:a]${bgFilter}[rbg]`);
            mixLabels.push('[rbg]');
        }

        // 背景音频（原始，无特效）
        if (bgInputIdx >= 0) {
            const bgTempo = buildAtempoChainForDurationScale(session.bgDurScale || 100);
            const bgBaseFilter = `volume=${bgVolume.toFixed(3)}${mainAudioGate}`;
            const bgFilter = bgTempo ? `${bgBaseFilter},${bgTempo}` : bgBaseFilter;
            filterParts.push(`[${bgInputIdx}:a]${bgFilter}[bg]`);
            mixLabels.push('[bg]');
        }

        // BGM
        if (bgmInputIdx >= 0) {
            filterParts.push(`[${bgmInputIdx}:a]volume=${bgmVolume.toFixed(3)}${mainAudioGate}[bgm]`);
            mixLabels.push('[bgm]');
        }

        // 覆层视频音频
        if (cvInputIdx >= 0) {
            filterParts.push(`[${cvInputIdx}:a]volume=${cvVol.toFixed(3)}${mainAudioGate}[cva]`);
            mixLabels.push('[cva]');
        }
        insertInputs.forEach((item, index) => {
            const gain = Math.max(0, Math.min(2, Number(item.volume ?? 100) / 100));
            const trimStart = Math.max(0, Number(item.sourceTrimStart) || 0);
            const duration = Math.max(.05, Number(item.duration) || 1.5);
            const delay = Math.max(0, Math.round((Number(item.timelineStart) || 0) * 1000));
            const label = `[insa${index}]`;
            filterParts.push(`[${item.inputIdx}:a]atrim=start=${trimStart.toFixed(3)}:duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(3)},adelay=${delay}|${delay}${label}`);
            mixLabels.push(label);
        });

        // 最终混合
        if (mixLabels.length > 1) {
            filterParts.push(
                `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=shortest:dropout_transition=0:normalize=0[aout]`
            );
        } else {
            filterParts.push('[voice]acopy[aout]');
        }

        args.push(
            '-filter_complex', filterParts.join(';'),
            '-map', '0:v', '-map', '[aout]',
        );

        args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', ...outputDurationArgs(session), '-movflags', '+faststart', outputPath);
    }

    if (session.reverbEnabled) {
        console.log(`[WYSIWYG] afir 卷积混响: ${session.reverbPreset}, mix=${session.reverbMix}%`);
    }
    if (session.stereoWidth > 100) {
        console.log(`[WYSIWYG] 立体声增强: ${session.stereoWidth}%`);
    }

    console.log(`[WYSIWYG] 混合音频... ${hasBgm ? '(含 BGM)' : ''}`);
    return _runMixFFmpeg(ffmpeg, args, session);
}

function _runMixFFmpeg(ffmpeg, args, session) {
    return new Promise((resolve, reject) => {
        // 打印完整 filter_complex
        const fcIdx = args.indexOf('-filter_complex');
        if (fcIdx >= 0 && args[fcIdx + 1]) {
            console.log(`[WYSIWYG] filter_complex: ${args[fcIdx + 1]}`);
        }
        console.log(`[WYSIWYG] FFmpeg 混音命令: ${args.join(' ').substring(0, 800)}`);
        const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-3000); });
        proc.on('close', (code) => {
            // 打印 FFmpeg stderr 用于调试
            console.log(`[WYSIWYG] FFmpeg mix stderr (last 500): ${err.slice(-500)}`);
            // 清理临时 IR 文件
            if (session._irCleanup) {
                try { fs.unlinkSync(session._irCleanup); } catch (_) { }
            }
            // 清理临时渲染人声 WAV
            if (session._renderedVoiceCleanup) {
                try { fs.unlinkSync(session._renderedVoiceCleanup); } catch (_) { }
            }
            // 清理临时渲染背景层音频 WAV
            if (session._renderedBgCleanup) {
                try { fs.unlinkSync(session._renderedBgCleanup); } catch (_) { }
            }
            // 清理临时渲染配乐层 WAV
            if (session._renderedBgmCleanup) {
                try { fs.unlinkSync(session._renderedBgmCleanup); } catch (_) { }
            }
            if (code === 0 && fs.existsSync(session.outputPath)) {
                console.log(`[WYSIWYG] 输出: ${session.outputPath} (${(fs.statSync(session.outputPath).size / 1024 / 1024).toFixed(1)}MB)`);
                resolve();
            } else {
                reject(new Error(formatMixFailure(err, code)));
            }
        });
        proc.on('error', reject);
    });
}

function formatMixFailure(stderr, code) {
    return formatMediaError(stderr, {
        action: '音频混合',
        code,
        missingLabel: '音频文件',
    });
}

function abortSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.closed = true;
    if (session.framePipeline) {
        session.framePipeline.closed = true;
        try { session.framePipeline.port.close(); } catch (_) { }
        session.framePipeline = null;
    }
    try { session.proc.stdin.destroy(); } catch (_) { }
    try { session.proc.kill('SIGKILL'); } catch (_) { }
    cleanup(session);
}

function cleanup(session) {
    sessions.delete(session.id);
    try {
        if (session.tempVideo && fs.existsSync(session.tempVideo)) fs.unlinkSync(session.tempVideo);
    } catch (_) { }
}

function cleanupBg(framesDir) {
    if (!framesDir || typeof framesDir !== 'string' || !fs.existsSync(framesDir)) return;
    
    // 覆层的 PNG 序列作为长期重复使用的资源，不在这里直接随临时目录清理（依赖外部应用清理或用户手动清理临时区）
    if (framesDir.includes('videokit_overlay_cache')) {
        return;
    }

    const baseName = path.basename(path.resolve(framesDir));
    if (!baseName.startsWith('reels_bg_')) {
        console.warn(`[WYSIWYG] 拒绝清理非临时背景帧目录: ${framesDir}`);
        return;
    }

    try {
        const files = fs.readdirSync(framesDir);
        for (const f of files) {
            try { fs.unlinkSync(path.join(framesDir, f)); } catch (_) { }
        }
        fs.rmdirSync(framesDir);
        console.log(`[WYSIWYG] 清理帧目录: ${framesDir}`);
    } catch (e) {
        console.warn(`[WYSIWYG] 清理帧目录失败: ${e.message}`);
    }
}

// ═══════════════════════════════════════════════════════
// 阶段 finish-video-only: 仅关闭编码器，不混音（并行切片用）
// ═══════════════════════════════════════════════════════

async function finishVideoOnly(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return { error: '会话不存在' };
    if (session.closed) return { error: '会话已关闭' };
    try {
        await flushFramePipeline(session);
    } catch (e) {
        abortSession(sessionId);
        return { error: `帧流水线失败：${e.message}` };
    }
    const completionError = validateFrameCompletion(session.totalFrames, session.frameCount);
    if (completionError) {
        abortSession(sessionId);
        return { error: completionError };
    }
    session.closed = true;

    const mb = (session.bytesWritten / 1024 / 1024).toFixed(1);
    console.log(`[WYSIWYG-VO] 完成纯视频编码... 帧: ${session.frameCount}, 数据: ${mb}MB`);

    // 等待编码器完成
    if (!session.encoderExited) {
        await new Promise((resolve) => {
            try { session.proc.stdin.end(); } catch (_) { }
            const check = () => {
                if (session.encoderExited) { resolve(); return; }
                setTimeout(check, 200);
            };
            check();
            setTimeout(resolve, 120000);
        });
    }

    if (session.encoderExitCode !== 0) {
        console.error(`[WYSIWYG-VO] 编码失败 (code=${session.encoderExitCode}):\n${session.stderr}`);
        sessions.delete(sessionId);
        return {
            error: formatMediaError(session.stderr, {
                action: '视频编码',
                code: session.encoderExitCode,
            }),
        };
    }

    if (!fs.existsSync(session.tempVideo) || fs.statSync(session.tempVideo).size < 1024) {
        sessions.delete(sessionId);
        return { error: '临时视频无效' };
    }

    // 不删除 tempVideo! 返回路径供拼接使用
    const videoPath = session.tempVideo;
    sessions.delete(sessionId);
    console.log(`[WYSIWYG-VO] 纯视频输出: ${videoPath} (${(fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)}MB)`);
    return { videoPath };
}

// ═══════════════════════════════════════════════════════
// 并行影子窗口编排器
// ═══════════════════════════════════════════════════════

async function parallelExport(opts, mainWindow) {
    const {
        params,        // 原始导出参数
        outputPath,    // 最终输出路径
        concurrency,   // 并行度
        totalFrames,   // 总帧数
        duration,      // 总时长
    } = opts;

    const { BrowserWindow, ipcMain } = require('electron');
    const settings = require('./settings');
    const ffmpeg = findFFmpeg();

    const fps = params.fps || 30;
    const targetWidth = params.targetWidth || 1080;
    const targetHeight = params.targetHeight || 1920;

    // 计算脚本路径
    const { app } = require('electron');
    let scriptBase;
    if (app.isPackaged) {
        scriptBase = path.join(process.resourcesPath, 'app.asar', 'dist');
        // 如果 asar 里没有，尝试 dist 外部
        if (!fs.existsSync(path.join(scriptBase, 'reels-canvas-renderer.js'))) {
            scriptBase = path.join(path.dirname(process.resourcesPath), 'dist');
        }
    } else {
        scriptBase = path.join(__dirname, '..', '..', 'src');
    }

    // Apply audioDurScale to subtitle segments to keep sync
    const _audioDurFactor = (params.audioDurScale || 100) / 100;
    let _segments = params.segments || [];
    if (_audioDurFactor !== 1.0 && _segments.length > 0) {
        console.log(`[Parallel] 字幕时间戳同步缩放 ×${_audioDurFactor.toFixed(2)}`);
        _segments = _segments.map(seg => ({
            ...seg,
            start: (seg.start || 0) * _audioDurFactor,
            end:   (seg.end   || 0) * _audioDurFactor,
            words: seg.words ? seg.words.map(w => ({
                ...w,
                start: (w.start || 0) * _audioDurFactor,
                end:   (w.end   || 0) * _audioDurFactor,
            })) : undefined
        }));
    }

    const scriptPaths = {
        textDirection: path.join(scriptBase, 'reels-text-direction.js'),
        animEngine: path.join(scriptBase, 'reels-anim-engine.js'),
        richText: path.join(scriptBase, 'reels-rich-text.js'),
        canvasRenderer: path.join(scriptBase, 'reels-canvas-renderer.js'),
        overlay: path.join(scriptBase, 'reels-overlay.js'),
        fontMetadata: path.join(scriptBase, 'fonts-metadata.js'),
        fontManager: path.join(scriptBase, 'reels-font-manager.js'),
    };
    console.log(`[Parallel] 脚本基础路径: ${scriptBase}`);
    console.log(`[Parallel] canvas-renderer 存在: ${fs.existsSync(scriptPaths.canvasRenderer)}`);

    // 切分帧范围
    const framesPerChunk = Math.ceil(totalFrames / concurrency);
    const chunks = [];
    for (let i = 0; i < concurrency; i++) {
        const start = i * framesPerChunk;
        const end = Math.min(start + framesPerChunk, totalFrames);
        if (start >= totalFrames) break;
        chunks.push({ chunkId: i, startFrame: start, endFrame: end });
    }
    console.log(`[Parallel] 切片方案: ${chunks.length} 个切片, ${framesPerChunk} 帧/切片`);

    // 为每个 chunk 创建 FFmpeg 启动参数（纯视频，不含音频）
    const qualityPreset = params.qualityPreset || 'faster';
    const crf = params.crf || 23;

    const chunkResults = new Array(chunks.length).fill(null);
    const progressMap = new Array(chunks.length).fill(0);

    // 创建影子窗口并发渲染
    const htmlPath = path.join(__dirname, '..', 'shadow-renderer.html');

    const shadowPromises = chunks.map((chunk) => {
        return new Promise(async (resolve, reject) => {
            const chunkOutputPath = settings.secureTmpFile(`parallel_chunk_${chunk.chunkId}`, '.mp4');

            // 影子窗口 FFmpeg session params
            const sessionParams = {
                width: targetWidth,
                height: targetHeight,
                fps,
                outputPath: chunkOutputPath,
                // 并行切片模式：强制 CPU 编码，避免 GPU 并发限制
                useGPU: false,
                qualityPreset,
                crf,
            };

            const win = new BrowserWindow({
                show: false, width: 200, height: 200,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                    backgroundThrottling: false,
                    webSecurity: false,
                },
            });

            const cleanupListeners = () => {
                ipcMain.removeListener('chunk-result', onResult);
                ipcMain.removeListener('chunk-progress', onProgress);
                ipcMain.removeListener('shadow-renderer-ready', onReady);
            };

            const timeout = setTimeout(() => {
                console.error(`[Parallel] Chunk ${chunk.chunkId} 超时 (5min)`);
                try { win.close(); } catch(_) {}
                cleanupListeners();
                reject(new Error(`Chunk ${chunk.chunkId} 渲染超时`));
            }, 5 * 60 * 1000);

            const onResult = (event, result) => {
                if (event.sender !== win.webContents) return;
                if (!result || result.chunkId !== chunk.chunkId) return;
                clearTimeout(timeout);
                cleanupListeners();
                try { win.close(); } catch(_) {}

                if (result.success) {
                    chunkResults[chunk.chunkId] = result.videoPath;
                    resolve(result.videoPath);
                } else {
                    reject(new Error(`Chunk ${chunk.chunkId}: ${result.error}`));
                }
            };

            const onProgress = (event, data) => {
                if (event.sender !== win.webContents) return;
                if (!data || data.chunkId !== chunk.chunkId) return;
                progressMap[chunk.chunkId] = data.pct || 0;
                // 聚合进度发回主窗口
                const avgPct = Math.round(progressMap.reduce((a, b) => a + b, 0) / chunks.length);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('parallel-export-progress', {
                        pct: 20 + Math.round(avgPct * 0.65),
                        chunkId: data.chunkId,
                        chunkPct: data.pct,
                        fpsActual: data.fpsActual,
                    });
                }
            };

            const onReady = (event) => {
                // 每个影子窗口都会发就绪事件；不过滤 sender 会让第一个窗口
                // 强行触发所有切片，造成其他窗口丢任务或开始时帧不稳。
                if (event.sender !== win.webContents) return;
                ipcMain.removeListener('shadow-renderer-ready', onReady);
                win.webContents.send('render-chunk', {
                    chunkId: chunk.chunkId,
                    scriptPaths,
                    startFrame: chunk.startFrame,
                    endFrame: chunk.endFrame,
                    totalDuration: duration,
                    fps,
                    targetWidth,
                    targetHeight,
                    backgroundPath: params.backgroundPath,
                    bgScale: params.bgScale || 100,
                    bgRotation: params.bgRotation || 0,
                    bgX: params.bgX || 0,
                    bgY: params.bgY || 0,
                    bgDurScale: params.bgDurScale || 100,
                    loopFade: params.loopFade,
                    loopFadeDur: params.loopFadeDur,
                    style: params.style,
                    segments: _segments,
                    overlays: params.overlays || [],
                    contentVideoPath: params.contentVideoPath,
                    contentVideoTrimStart: params.contentVideoTrimStart,
                    contentVideoTrimEnd: params.contentVideoTrimEnd,
                    contentVideoScale: params.contentVideoScale,
                    contentVideoX: params.contentVideoX,
                    contentVideoY: params.contentVideoY,
                    contentVideoCrop: params.contentVideoCrop,
                    contentVideoBlurBg: params.contentVideoBlurBg,
                    contentVideoDirectBg: params.contentVideoDirectBg,
                    sessionParams,
                });
            };

            ipcMain.on('chunk-result', onResult);
            ipcMain.on('chunk-progress', onProgress);
            // 必须用 on 而不是 once：第一个窗口的 ready 事件对其他窗口而言是不匹配的，
            // 不匹配时仍需保留它们的监听器，直至各自真正就绪。
            ipcMain.on('shadow-renderer-ready', onReady);

            win.loadFile(htmlPath).catch(reject);
        });
    });

    // 等待所有切片完成
    console.log(`[Parallel] 启动 ${chunks.length} 个影子窗口...`);
    let chunkVideos;
    try {
        chunkVideos = await Promise.all(shadowPromises);
    } catch (e) {
        // 清理已完成的临时文件
        for (const vp of chunkResults) {
            if (vp) try { fs.unlinkSync(vp); } catch(_) {}
        }
        throw e;
    }
    console.log(`[Parallel] 所有切片完成: ${chunkVideos.join(', ')}`);

    // 通知进度
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('parallel-export-progress', { pct: 88, phase: 'concat' });
    }

    // 无损拼接所有切片
    const concatListPath = settings.secureTmpFile('parallel_concat', '.txt');
    const concatContent = chunkVideos.map(v => `file '${v.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent, 'utf-8');

    const concatTempVideo = settings.secureTmpFile('parallel_merged', '.mp4');
    const concatArgs = [
        '-y', '-f', 'concat', '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        concatTempVideo,
    ];
    console.log(`[Parallel] 拼接: ${ffmpeg} ${concatArgs.join(' ')}`);
    await runFFmpegSync(ffmpeg, concatArgs);

    // 清理切片文件
    for (const vp of chunkVideos) {
        try { fs.unlinkSync(vp); } catch(_) {}
    }
    try { fs.unlinkSync(concatListPath); } catch(_) {}

    // 混合音频
    console.log(`[Parallel] 混合音频到最终输出: ${outputPath}`);
    const pseudoSession = {
        id: 'parallel_final',
        tempVideo: concatTempVideo,
        outputPath,
        voicePath: params.voicePath,
        voiceVolume: params.voiceVolume ?? 1.0,
        bgVolume: params.bgVolume ?? 0.1,
        backgroundPath: params.backgroundPath,
        bgHasAudio: params.bgHasAudio !== false && !_isImageFile_node(params.backgroundPath),
        bgmPath: params.bgmPath || '',
        bgmVolume: params.bgmVolume ?? 0,
        bgmStart: Math.max(0, Number(params.bgmStart) || 0),
        bgDurScale: params.bgDurScale || 100,
        audioDurScale: params.audioDurScale || 100,
        reverbEnabled: params.reverbEnabled || false,
        reverbPreset: params.reverbPreset || 'hall',
        reverbMix: params.reverbMix || 30,
        stereoWidth: params.stereoWidth || 100,
        audioFxTarget: params.audioFxTarget || 'all',
        contentVideoPath: params.contentVideoPath || '',
        contentVideoVolume: params.contentVideoVolume ?? 1.0,
        width: targetWidth,
        height: targetHeight,
        fps,
        targetDuration: totalFrames > 0 ? totalFrames / fps : duration,
        frameCount: totalFrames,
        stderr: '',
    };

    await mixAudio(pseudoSession);

    // 清理拼接临时文件
    try { fs.unlinkSync(concatTempVideo); } catch(_) {}

    console.log(`[Parallel] ✅ 导出完成: ${outputPath}`);
    return { output_path: outputPath };
}

function _isImageFile_node(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    return ['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext);
}

// ═══════════════════════════════════════════════════════
// IPC 入口
// ═══════════════════════════════════════════════════════

async function handleWysiwygIPC(action, data) {
    switch (action) {
        case 'probe-gpu': {
            const ffmpeg = findFFmpeg();
            const platform = process.platform;
            if (platform === 'darwin') {
                const ok = _probeGPUEncoder(ffmpeg, 'h264_videotoolbox', ['-c:v', 'h264_videotoolbox', '-b:v', '1M'], 256, 256, 30);
                let chipName = 'Apple VT';
                try {
                    const cpuModel = require('os').cpus()[0].model;
                    if (cpuModel.toLowerCase().includes('apple')) {
                        chipName = cpuModel + ' (VT)';
                    }
                } catch(e) {}
                return { available: ok, name: ok ? chipName : 'CPU' };
            } else if (platform === 'win32') {
                if (_probeGPUEncoder(ffmpeg, 'h264_nvenc', ['-c:v', 'h264_nvenc', '-b:v', '1M'], 256, 256, 30)) return { available: true, name: 'Nvidia NVENC' };
                if (_probeGPUEncoder(ffmpeg, 'h264_amf', ['-c:v', 'h264_amf'], 256, 256, 30)) return { available: true, name: 'AMD AMF' };
                if (_probeGPUEncoder(ffmpeg, 'h264_qsv', ['-c:v', 'h264_qsv'], 256, 256, 30)) return { available: true, name: 'Intel QSV' };
                return { available: false, name: 'CPU' };
            }
            return { available: false, name: 'CPU' };
        }
        case 'prepare-overlay':
            return prepareOverlay(data);
        case 'prepare-bg':
            return prepareBg(data);
        case 'start':
            return startSession(data);
        case 'frame':
            return writeFrame(data.sessionId, data.raw);
        case 'frames': {
            let result = { ok: true };
            for (const f of (data.frames || [])) {
                result = await writeFrame(data.sessionId, f);
                if (!result || !result.ok) break;
            }
            return result;
        }
        case 'finish':
            return finishSession(data.sessionId);
        case 'finish-video-only':
            return finishVideoOnly(data.sessionId);
        case 'abort':
            abortSession(data.sessionId);
            return true;
        case 'cleanup-bg':
            cleanupBg(data.framesDir);
            return true;
        default:
            return { error: `未知动作: ${action}` };
    }
}

async function renderChromiumAudioWav(opts) {
    const { filePath, reverbEnabled, reverbPreset, reverbMix, stereoWidth } = opts;
    const settings = require('./settings');
    const { BrowserWindow, ipcMain } = require('electron');

    const ext = path.extname(filePath).toLowerCase();
    const isVideo = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.flv', '.ts'].includes(ext);

    let audioInputPath = filePath;
    let tmpExtractedWav = null;

    if (isVideo) {
        tmpExtractedWav = settings.secureTmpFile('audiofx_extracted', '.wav');
        console.log('[WYSIWYG] 视频文件，先用 FFmpeg 提取音频:', tmpExtractedWav);
        try {
            execFileSync(findFFmpeg(), [
                '-y', '-i', filePath,
                '-vn', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2',
                tmpExtractedWav
            ], { timeout: 30000 });
            audioInputPath = tmpExtractedWav;
        } catch (e) {
            console.error('[WYSIWYG] 视频音频提取失败:', e.message);
        }
    }

    console.log('[WYSIWYG] 启动 Chromium Web Audio 隐藏窗口渲染...');
    const renderedWavPath = settings.secureTmpFile('voice_rendered', '.wav');

    const renderWin = new BrowserWindow({
        show: false, width: 100, height: 100,
        webPreferences: {
            nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
        },
    });

    try {
        const wavResult = await new Promise((resolve, reject) => {
            let settled = false;
            let timeout = null;

            // 音频效果渲染会在批量导出时并发启动多个隐藏窗口。IPC 通道名是
            // 全局的，因此必须只接受本窗口发出的 ready/result；否则 A 任务
            // 可能先收到 B 任务的人声结果，进而将错误的人声混入 A 的成片。
            const isThisRenderer = event => event && event.sender === renderWin.webContents;
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                ipcMain.removeListener('render-audio-result', onResult);
                ipcMain.removeListener('audio-renderer-ready', onReady);
                if (!renderWin.isDestroyed()) renderWin.close();
                if (error) reject(error);
                else resolve(result);
            };

            const onResult = (event, result) => {
                if (!isThisRenderer(event)) return;
                finish(null, result);
            };

            const onReady = event => {
                if (!isThisRenderer(event)) return;
                renderWin.webContents.send('render-audio', {
                    filePath: audioInputPath, reverbEnabled,
                    reverbPreset: reverbPreset || 'hall',
                    reverbMix: reverbMix || 30,
                    stereoWidth: stereoWidth || 100,
                });
            };

            ipcMain.on('render-audio-result', onResult);
            ipcMain.on('audio-renderer-ready', onReady);
            timeout = setTimeout(() => finish(new Error('Audio render timeout (60s)')), 60000);

            const htmlPath = path.join(__dirname, '..', 'audio-renderer.html');
            renderWin.loadFile(htmlPath).catch(error => finish(error));
        });

        if (wavResult.success && wavResult.wavBuffer) {
            fs.writeFileSync(renderedWavPath, wavResult.wavBuffer);
            console.log(`[WYSIWYG] Chromium Web Audio 渲染完成: ${renderedWavPath} (${(wavResult.wavBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
            return renderedWavPath;
        } else {
            throw new Error(wavResult.error || 'Unknown render error');
        }
    } finally {
        if (tmpExtractedWav && fs.existsSync(tmpExtractedWav)) {
            try { fs.unlinkSync(tmpExtractedWav); } catch (_) {}
        }
    }
}

module.exports = {
    handleWysiwygIPC,
    attachFramePipeline,
    renderChromiumAudioWav,
    parallelExport,
    _test: {
        stableJpegEncoderArgs,
        h264RateControlArgs,
        cpuH264EncoderArgs,
        gpuH264EncoderCandidates,
        formatMixFailure,
        formatMediaError,
        expectedFrameCount,
        validateRawFrameSize,
        validateFrameCompletion,
        normalizeDisplayAspectFilter,
        normalizedDirectBackgroundFilter,
    },
};
