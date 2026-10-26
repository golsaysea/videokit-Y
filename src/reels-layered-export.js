/**
 * reels-layered-export.js — 分层 PNG 序列导出引擎
 *
 * 输出结构:
 *   output_dir/
 *     {taskName}_layers/
 *       video/          ← 画面层 PNG 序列 (背景+蒙版+覆层，无字幕)
 *         frame_000001.png
 *         frame_000002.png
 *         ...
 *       subtitle/        ← 字幕层 PNG 序列 (透明底+字幕)
 *         frame_000001.png
 *         frame_000002.png
 *         ...
 *       audio.mp3        ← 混合音频（人声+配乐+背景音）
 *       info.json        ← 元信息（帧率、分辨率、时长、帧数）
 *
 * 复用 WYSIWYG 导出引擎的背景帧提取管线。
 */

/**
 * Canvas → Raw RGBA ArrayBuffer
 */
function _layeredCanvasToRGBA(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return imageData.data.buffer.slice(0);
}

/**
 * Canvas → PNG 通过 toBlob (更高效，支持透明度)
 */
function _canvasToPngBlob(canvas) {
    return new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/png');
    });
}

/**
 * Blob → ArrayBuffer
 */
function _blobToArrayBuffer(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
    });
}

/**
 * 加载图片
 */
function _layeredLoadImage(src) {
    return new Promise((resolve, reject) => {
        let normSrc = src;
        const isRemoteOrBrowserUrl = /^(local-media:|https?:|blob:|data:)/i.test(String(normSrc || ''));
        if (normSrc && typeof normSrc === 'string' && !isRemoteOrBrowserUrl
            && window.electronAPI && typeof window.electronAPI.toFileUrl === 'function') {
            normSrc = window.electronAPI.toFileUrl(normSrc);
        }
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`图片加载失败: ${normSrc}`));
        img.src = normSrc;
    });
}

function _normalizeLocalPath(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    if (/^local-media:\/\//i.test(filePath)) {
        try {
            let p = decodeURIComponent(filePath.replace(/^local-media:\/\//i, ''));
            if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
            return p || filePath;
        } catch (_) {
            return filePath.replace(/^local-media:\/\//i, '');
        }
    }
    if (!/^file:\/\//i.test(filePath)) return filePath;
    try {
        const u = new URL(filePath);
        let p = decodeURIComponent(u.pathname || '');
        if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
        return p || filePath;
    } catch (_) {
        try {
            return decodeURIComponent(filePath.replace(/^file:\/\//i, ''));
        } catch (_) {
            return filePath.replace(/^file:\/\//i, '');
        }
    }
}

function _isLayeredImageFile(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    return ['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext);
}

function _parseCropString(cropStr) {
    let cropX = 0, cropY = 0, cropW = 1, cropH = 1;
    if (cropStr && typeof cropStr === 'string' && cropStr.trim() !== '') {
        const parts = cropStr.split(',').map(p => parseFloat(p.trim()));
        if (parts.length === 4 && parts.every(p => !isNaN(p))) {
            cropX = Math.max(0, Math.min(100, parts[0])) / 100;
            cropY = Math.max(0, Math.min(100, parts[1])) / 100;
            cropW = Math.max(1, Math.min(100, parts[2])) / 100;
            cropH = Math.max(1, Math.min(100, parts[3])) / 100;
        }
    }
    return { cropX, cropY, cropW, cropH };
}

function _drawImageFlipped(ctx, img, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, flipH, flipV) {
    if (!flipH && !flipV) {
        if (arg5 !== undefined) {
            ctx.drawImage(img, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
        } else if (arg3 !== undefined) {
            ctx.drawImage(img, arg1, arg2, arg3, arg4);
        } else {
            ctx.drawImage(img, arg1, arg2);
        }
        return;
    }
    
    ctx.save();
    let dx, dy, dw, dh;
    if (arg5 !== undefined) {
        // 9 arguments: img, sx, sy, sw, sh, dx, dy, dw, dh
        dx = arg5; dy = arg6; dw = arg7; dh = arg8;
        ctx.translate(dx + dw / 2, dy + dh / 2);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, arg1, arg2, arg3, arg4, -dw / 2, -dh / 2, dw, dh);
    } else if (arg3 !== undefined) {
        // 5 arguments: img, dx, dy, dw, dh
        dx = arg1; dy = arg2; dw = arg3; dh = arg4;
        ctx.translate(dx + dw / 2, dy + dh / 2);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    } else {
        // 3 arguments: img, dx, dy
        dx = arg1; dy = arg2; dw = img.naturalWidth || img.width || 0; dh = img.naturalHeight || img.height || 0;
        ctx.translate(dx + dw / 2, dy + dh / 2);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    }
    ctx.restore();
}

function _drawCroppedVideoCover(ctx, videoEl, cropX, cropY, cropW, cropH, targetW, targetH, scalePct, offsetX = 0, offsetY = 0, flipH = false, flipV = false) {
    if (!ctx || !videoEl || !(targetW > 0) || !(targetH > 0)) return;
    const srcW = videoEl.videoWidth || videoEl.naturalWidth || targetW;
    const srcH = videoEl.videoHeight || videoEl.naturalHeight || targetH;
    if (!(srcW > 0) || !(srcH > 0)) {
        _drawImageFlipped(ctx, videoEl, 0, 0, targetW, targetH, undefined, undefined, undefined, undefined, flipH, flipV);
        return;
    }
    const sx = srcW * cropX;
    const sy = srcH * cropY;
    const sWidth = srcW * cropW;
    const sHeight = srcH * cropH;

    const userScale = (scalePct || 100) / 100;
    const scale = Math.max(targetW / sWidth, targetH / sHeight) * userScale;
    const drawW = sWidth * scale;
    const drawH = sHeight * scale;
    const maxShiftX = Math.abs(targetW - drawW) / 2;
    const maxShiftY = Math.abs(targetH - drawH) / 2;
    const drawX = (targetW - drawW) / 2 + maxShiftX * (offsetX / 100);
    const drawY = (targetH - drawH) / 2 + maxShiftY * (offsetY / 100);
    _drawImageFlipped(ctx, videoEl, sx, sy, sWidth, sHeight, drawX, drawY, drawW, drawH, flipH, flipV);
}


/**
 * 主导出函数：分层 PNG 序列导出
 */
async function reelsLayeredExport(params) {
    params={...params,style:getWritingVisualStyle(params.style)};
    let {
        canvas,
        style,
        segments,
        originalScript = '',
        overlays: taskOverlays,
        backgroundPath,
        bgMode = 'single',
        bgClipPool = [],
        bgClipSettings = {},
        bgMinClipDur = 5,
        bgMaxClipDur = 7,
        bgClipOrder = 'random',
        bgClipSeed = '',
        bgTransition = 'crossfade',
        bgTransDur = 0.5,
        showSubtitle = true,
        voicePath,
        outputDir,        // 输出基础目录
        taskName,         // 任务名（用于文件夹命名）
        targetWidth = 1080,
        targetHeight = 1920,
        fps = 30,
        voiceVolume = 1.0,
        bgVolume = 0.1,
        loopFade = true,
        loopFadeDur = 1.0,
        customDuration = 0,
        bgmPath = '',
        bgmVolume = 0.3,
        bgmStart = 0,
        contentVideoPath = null,
        contentVideoTrimStart = null,
        contentVideoTrimEnd = null,
        contentVideoScale = 100,
        contentVideoX = 'center',
        contentVideoY = 'center',
        contentVideoCrop = '',
        contentVideoBlurBg = false,
        contentVideoDirectBg = false,
        contentVideoBlur = 40,
        contentVideoBrightness = 60,
        bgScale = 100,
        bgRotation = 0,
        bgX = 0,
        bgY = 0,
        bgFlipH = false,
        bgFlipV = false,
        contentVideoFlipH = false,
        contentVideoFlipV = false,
        bgDurScale = 100,
        audioDurScale = 100,
        onProgress,
        onLog,
        isCancelled,
    } = params;

    const isMultiClip = bgMode === 'multi' && Array.isArray(bgClipPool) && bgClipPool.length > 0;

    if (!canvas) throw new Error('需要提供 canvas');
    if (!backgroundPath && !isMultiClip && !contentVideoBlurBg && !contentVideoDirectBg) throw new Error('缺少背景素材');
    if (!outputDir) throw new Error('缺少输出目录');
    if (!window.electronAPI) throw new Error('需要 Electron API');

    // 允许无字幕（纯覆层模式）
    if (!segments) segments = [];

    const log = (msg) => { if (onLog) onLog(msg); console.log(`[LayeredExport] ${msg}`); };
    const progress = (v) => { if (onProgress) onProgress(v); };

    // ── 确保所有覆层与字幕使用的字体全部预加载完成 ──
    if (window.getFontManager) {
        const fm = window.getFontManager();
        const fontsToLoad = fm.collectFonts({
            style,
            segments,
            overlays: taskOverlays
        });
        if (fontsToLoad.length > 0) {
            log(`正在预加载字体: ${fontsToLoad.join(', ')}`);
        }
        await fm.ensureFontsLoaded(fontsToLoad);
        log('字体全部预加载就绪');
    }

    // ── 创建输出目录结构 ──
    const safeName = (taskName || 'task').replace(/[\\/:*?"<>|]/g, '_');
    const layersDir = `${outputDir.replace(/[/\\]$/, '')}/${safeName}_layers`;
    const videoDir = `${layersDir}/video`;
    const subtitleDir = `${layersDir}/subtitle`;

    await window.electronAPI.ensureDirectory(videoDir);
    await window.electronAPI.ensureDirectory(subtitleDir);
    log(`输出目录: ${layersDir}`);

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const renderer = new ReelsCanvasRenderer(canvas);

    // ── 获取时长 ──
    const _audioDurFactor = (audioDurScale || 100) / 100;
    const _bgDurFactor = (bgDurScale || 100) / 100;
    const rawSubDuration = Array.isArray(segments) && segments.length > 0
        ? (parseFloat(segments[segments.length - 1].end) || 0)
        : 0;
    const effectiveSubDuration = voicePath ? rawSubDuration * _audioDurFactor : rawSubDuration;
    const requireMediaDuration = async (label, mediaPath) => {
        const fileName = String(mediaPath || '').split(/[/\\]/).pop() || '未知文件';
        if (window.electronAPI.getMediaDurationDetail) {
            const detail = await window.electronAPI.getMediaDurationDetail(mediaPath);
            if (detail?.ok && Number(detail.duration) > 0) return Number(detail.duration);
            throw new Error(`${label}无法读取时长：${fileName}。原因：${detail?.reason || '未知读取错误'}。路径：${detail?.path || mediaPath || '(空)'}`);
        }
        const numeric = Number(await window.electronAPI.getMediaDuration(mediaPath));
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
        throw new Error(`${label}无法读取时长：${fileName}。原因：媒体未返回有效时长。路径：${mediaPath || '(空)'}`);
    };
    let duration = 0;

    if (customDuration > 0) {
        duration = customDuration;
        log(`自定义时长: ${duration}s`);
    } else {
        if (voicePath) {
            let rawAudioDur = await requireMediaDuration('配音/音频', voicePath);
            if (rawAudioDur > 0 && _audioDurFactor !== 1.0) {
                duration = rawAudioDur * _audioDurFactor;
            } else {
                duration = rawAudioDur;
            }
        }
        if (!duration || duration <= 0) {
            if (isMultiClip) {
                // 多素材模式：按实际拼接后的有效时长计算，扣掉转场重叠。
                log(`正在获取多素材池时长 (${bgClipPool.length} 个)...`);
                let poolTotalDur = 0;
                let poolClipCount = 0;
                for (const clipPath of bgClipPool) {
                    if (_isLayeredImageFile(clipPath)) {
                        poolTotalDur += 5.0; // 图片默认 5 秒
                        poolClipCount++;
                    } else {
                        const clipDur = await requireMediaDuration('背景素材池视频', clipPath);
                        poolTotalDur += clipDur;
                        poolClipCount++;
                    }
                }
                const scaledPoolDur = poolTotalDur * _bgDurFactor;
                const transOverlap = bgTransition !== 'none' ? Math.max(0, bgTransDur || 0) : 0;
                const overlapTotal = transOverlap > 0 ? transOverlap * Math.max(0, poolClipCount - 1) : 0;
                duration = Math.max(0.5, scaledPoolDur - overlapTotal, effectiveSubDuration);
                log(`多素材池有效时长: ${duration.toFixed(2)}s`);
            } else if (backgroundPath) {
                let rawBgDur = _isLayeredImageFile(backgroundPath)
                    ? 5
                    : await requireMediaDuration('背景视频', backgroundPath);
                if (rawBgDur > 0 && _bgDurFactor !== 1.0) {
                    duration = Math.max(rawBgDur * _bgDurFactor, effectiveSubDuration);
                } else {
                    duration = Math.max(rawBgDur, effectiveSubDuration);
                }
            } else if (contentVideoPath) {
                let rawCvDur = await requireMediaDuration('覆层视频', contentVideoPath);
                if (rawCvDur > 0) {
                    const trimS = (contentVideoTrimStart != null) ? parseFloat(contentVideoTrimStart) : 0;
                    const trimE = (contentVideoTrimEnd != null) ? parseFloat(contentVideoTrimEnd) : 0;
                    if (trimE > trimS) {
                        rawCvDur = trimE - trimS;
                    } else if (trimS > 0) {
                        rawCvDur = Math.max(0, rawCvDur - trimS);
                    }
                    duration = Math.max(rawCvDur, effectiveSubDuration);
                }
            }
        }
        if (!duration || duration <= 0) {
            duration = 5;
        }
    }

    const totalFrames = Math.ceil(duration * fps);
    log(`时长: ${duration.toFixed(2)}s, 帧数: ${totalFrames}, FPS: ${fps}`);
    progress(2);

    // ── 缩放字幕时间戳 ──
    if (_audioDurFactor !== 1.0 && segments && segments.length > 0) {
        segments = segments.map(seg => ({
            ...seg,
            start: (seg.start || 0) * _audioDurFactor,
            end: (seg.end || 0) * _audioDurFactor,
            words: seg.words ? seg.words.map(w => ({
                ...w,
                start: (w.start || 0) * _audioDurFactor,
                end: (w.end || 0) * _audioDurFactor,
            })) : undefined
        }));
    }

    let framesDir = null;
    let totalBgFrames = 0;
    let bgAudioPath = null;

    if (!contentVideoBlurBg && !contentVideoDirectBg) {
        log('阶段1: FFmpeg 预处理背景视频...');
        progress(5);

        const prepResult = await window.electronAPI.reelsComposeWysiwyg('prepare-bg', {
            backgroundPath: isMultiClip ? null : backgroundPath,
            bgMode: isMultiClip ? 'multi' : 'single',
            bgClipPool: isMultiClip ? bgClipPool : [],
            bgClipSettings: isMultiClip ? bgClipSettings : {},
            bgMinClipDur: isMultiClip ? bgMinClipDur : 0,
            bgMaxClipDur: isMultiClip ? bgMaxClipDur : 0,
            segments: isMultiClip ? (segments || []) : [],
            originalScript: isMultiClip ? (originalScript || '') : '',
            bgClipOrder: isMultiClip ? bgClipOrder : 'random',
            bgClipSeed: isMultiClip ? bgClipSeed : '',
            bgTransition: isMultiClip ? bgTransition : 'none',
            bgTransDur: isMultiClip ? bgTransDur : 0,
            voicePath,
            targetWidth,
            targetHeight,
            fps,
            duration,
            loopFade: isMultiClip ? false : loopFade,
            loopFadeDur,
            bgScale: bgScale || 100,
            bgRotation: bgRotation || 0,
            bgX: bgX || 0,
            bgY: bgY || 0,
            bgFlipH: bgFlipH || false,
            bgFlipV: bgFlipV || false,
            bgDurScale: bgDurScale || 100,
        });

        if (!prepResult || prepResult.error) {
            throw new Error(prepResult?.error || '背景预处理失败');
        }
        framesDir = prepResult.framesDir;
        totalBgFrames = prepResult.frameCount;
        bgAudioPath = prepResult.bgAudioPath || null;
        log(`背景帧: ${totalBgFrames} 帧`);
    } else {
        log('使用内容视频作为高斯模糊背景，跳过背景视频预处理');
    }
    progress(15);

    // ── 预处理视频覆层帧 ──
    const videoOverlays = (taskOverlays || []).filter(ov => ov.type === 'video' && !ov.disabled);
    if (videoOverlays.length > 0) {
        log(`预处理 ${videoOverlays.length} 个视频/动图覆层...`);
        for (const ov of videoOverlays) {
            if (!ov.content) continue;
            const opath = _normalizeLocalPath(ov.content);
            const videoOffset = Math.max(0, parseFloat(ov.video_start_offset || 0));
            const overlayPlayDur = Math.max(0.1, parseFloat(ov.end || duration) - parseFloat(ov.start || 0));
            const oPrep = await window.electronAPI.reelsComposeWysiwyg('prepare-overlay', {
                overlayPath: opath,
                fps,
                duration: videoOffset + overlayPlayDur + 1,
            });
            if (oPrep && oPrep.framesDir) {
                ov._framesDir = oPrep.framesDir;
                ov._frameCount = oPrep.frameCount;
            }
        }
    }

    let cvFramesDir = null;
    let cvFrameCount = 0;
    if (contentVideoPath) {
        log(`预处理内容视频源...`);
        const cvPathRaw = _normalizeLocalPath(contentVideoPath);
        const cvPrep = await window.electronAPI.reelsComposeWysiwyg('prepare-overlay', {
            overlayPath: cvPathRaw,
            fps,
            duration,
            trimStart: contentVideoTrimStart,
            trimEnd: contentVideoTrimEnd,
        });
        if (cvPrep && cvPrep.framesDir) {
            cvFramesDir = cvPrep.framesDir;
            cvFrameCount = cvPrep.frameCount;
        }
        if (contentVideoBlurBg || contentVideoDirectBg) {
            let requiredDuration = Number(duration);
            const trimStart = Number(contentVideoTrimStart);
            const trimEnd = Number(contentVideoTrimEnd);
            if (Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd > trimStart) {
                requiredDuration = Math.min(requiredDuration, trimEnd - trimStart);
            }
            const requiredFrames = Math.max(1, Math.ceil(requiredDuration * fps) - 2);
            if (!cvFramesDir || cvFrameCount < requiredFrames) {
                throw new Error(
                    `内容背景帧数不足：需要约 ${requiredFrames} 帧，实际 ${cvFrameCount} 帧。` +
                    `为避免导出静帧，已停止导出，请检查内容视频是否完整。`
                );
            }
        }
    }
    progress(20);

    // 全局蒙版
    const hasMask = !!style.global_mask_enabled;
    const maskColor = style.global_mask_color || '#000000';
    const maskOpacity = style.global_mask_opacity ?? 0.5;

    // ═══ 阶段 2: 逐帧分层渲染 ═══
    log('阶段2: 逐帧分层渲染...');
    const t0 = Date.now();

    let currentBgImg = null;
    let currentBgIdx = -1;
    let currentCvImg = null;
    let currentCvIdx = -1;

    // 创建独立的字幕 Canvas（透明底）
    const subtitleCanvas = document.createElement('canvas');
    subtitleCanvas.width = targetWidth;
    subtitleCanvas.height = targetHeight;
    const subtitleCtx = subtitleCanvas.getContext('2d', { willReadFrequently: true });
    const subtitleRenderer = new ReelsCanvasRenderer(subtitleCanvas);

    try {
        await subtitleRenderer.prepareWritingCursorImage(style);
        if (Array.isArray(taskOverlays) && window.ReelsOverlay?.prepareScrollWritingCursorImage) {
            for (const ov of taskOverlays) {
                if (ov && !ov.disabled && ov.type === 'scroll') {
                    await window.ReelsOverlay.prepareScrollWritingCursorImage(ov);
                }
            }
        }
        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
            if (isCancelled && isCancelled()) {
                log('用户取消导出');
                throw new Error('__CANCELLED__');
            }
            const t = frameIdx / fps;
            const frameName = `frame_${String(frameIdx + 1).padStart(6, '0')}.png`;

            // ── 预加载内容视频帧 ──
            if (contentVideoPath && cvFramesDir) {
                let frameIdxCv = frameIdx;
                if (cvFrameCount > 0) frameIdxCv = Math.min(frameIdxCv, cvFrameCount - 1);
                if (frameIdxCv !== currentCvIdx) {
                    const cvFrameName = `frame_${String(frameIdxCv + 1).padStart(6, '0')}.png`;
                    try {
                        currentCvImg = await _layeredLoadImage(`${cvFramesDir}/${cvFrameName}`);
                        currentCvIdx = frameIdxCv;
                    } catch (e) { currentCvImg = null; }
                }
            }

            // ── 加载背景帧 ──
            if (!contentVideoBlurBg && !contentVideoDirectBg) {
                const bgFrameIdx = Math.min(frameIdx, totalBgFrames - 1);
                if (bgFrameIdx !== currentBgIdx) {
                    const padRef = String(bgFrameIdx + 1).padStart(6, '0');
                    try {
                        currentBgImg = await _layeredLoadImage(`${framesDir}/frame_${padRef}.jpg`);
                        currentBgIdx = bgFrameIdx;
                    } catch (e) {
                        try {
                            currentBgImg = await _layeredLoadImage(`${framesDir}/frame_${padRef}.png`);
                            currentBgIdx = bgFrameIdx;
                        } catch (e2) {
                            if (!currentBgImg) {
                                ctx.fillStyle = '#000000';
                                ctx.fillRect(0, 0, targetWidth, targetHeight);
                            }
                        }
                    }
                }
            }

            // ── 预加载视频覆层帧 ──
            if (taskOverlays && taskOverlays.length > 0) {
                for (const ov of taskOverlays) {
                    if (ov.type === 'video' && !ov.disabled) {
                        const ovStart = parseFloat(ov.start || 0);
                        let relTime = Math.max(0, t - ovStart);
                        let frameIdxOv = Math.floor(relTime * fps);

                        let fPath = null;
                        if (ov.is_img_sequence && ov.sequence_frames && ov.sequence_frames.length > 0) {
                            if (frameIdxOv >= ov.sequence_frames.length) {
                                frameIdxOv = frameIdxOv % Math.max(1, ov.sequence_frames.length);
                            }
                            fPath = ov.sequence_frames[frameIdxOv];
                        } else if (ov._framesDir) {
                            if (frameIdxOv >= ov._frameCount) {
                                frameIdxOv = frameIdxOv % Math.max(1, ov._frameCount);
                            }
                            const ovFrameName = `frame_${String(frameIdxOv + 1).padStart(6, '0')}.png`;
                            fPath = `${ov._framesDir}/${ovFrameName}`;
                        }

                        if (fPath) {
                            try {
                                ov._currentFrameImage = await _layeredLoadImage(fPath);
                            } catch (e) {
                                ov._currentFrameImage = null;
                            }
                        }
                    }
                }
            }

            // ══════════════════════════════════════
            // 画面层: 背景 + 蒙版 + 覆层 (无字幕)
            // ══════════════════════════════════════
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, targetWidth, targetHeight);

            if (contentVideoBlurBg && currentCvImg) {
                const { cropX, cropY, cropW, cropH } = _parseCropString(contentVideoCrop);
                const blurVal = contentVideoBlur != null ? contentVideoBlur : 40;
                const brightnessVal = (contentVideoBrightness != null ? contentVideoBrightness : 60) / 100;
                ctx.save();
                ctx.filter = `blur(${blurVal}px) brightness(${brightnessVal})`;
                _drawCroppedVideoCover(ctx, currentCvImg, cropX, cropY, cropW, cropH, targetWidth, targetHeight, bgScale, bgX, bgY, bgFlipH, bgFlipV);
                ctx.restore();
            } else if (contentVideoDirectBg && currentCvImg) {
                const { cropX, cropY, cropW, cropH } = _parseCropString(contentVideoCrop);
                _drawCroppedVideoCover(ctx, currentCvImg, cropX, cropY, cropW, cropH, targetWidth, targetHeight, bgScale, bgX, bgY, bgFlipH, bgFlipV);
            } else if (currentBgImg) {
                // 直接绘制（FFmpeg 预处理时已完成缩放、裁切与翻转）
                ctx.drawImage(currentBgImg, 0, 0, targetWidth, targetHeight);
            }

            // 内容视频
            if (contentVideoPath && currentCvImg && !contentVideoDirectBg) {
                const imgW = currentCvImg.naturalWidth || targetWidth;
                const imgH = currentCvImg.naturalHeight || targetHeight;
                const { cropX, cropY, cropW, cropH } = _parseCropString(contentVideoCrop);
                const sx = imgW * cropX;
                const sy = imgH * cropY;
                const sWidth = imgW * cropW;
                const sHeight = imgH * cropH;

                const cScale = (contentVideoScale || 100) / 100;
                const baseScale = targetWidth / sWidth;
                const finalScale = baseScale * cScale;
                const drawW = sWidth * finalScale;
                const drawH = sHeight * finalScale;
                let drawX = (targetWidth - drawW) / 2;
                let drawY = (targetHeight - drawH) / 2;
                if (contentVideoX && contentVideoX !== 'center') {
                    const relX = parseFloat(contentVideoX);
                    if (!isNaN(relX)) Math.abs(relX) <= 1 ? drawX += targetWidth * relX : drawX += relX;
                }
                if (contentVideoY && contentVideoY !== 'center') {
                    const relY = parseFloat(contentVideoY);
                    if (!isNaN(relY)) Math.abs(relY) <= 1 ? drawY += targetHeight * relY : drawY += relY;
                }
                _drawImageFlipped(ctx, currentCvImg, sx, sy, sWidth, sHeight, drawX, drawY, drawW, drawH, contentVideoFlipH, contentVideoFlipV);
            }

            // 全局蒙版
            if (hasMask) {
                ctx.save();
                ctx.globalAlpha = maskOpacity;
                ctx.fillStyle = maskColor;
                ctx.fillRect(0, 0, targetWidth, targetHeight);
                ctx.restore();
            }

            // 覆盖层（文字卡片等，属于画面层）
            if (taskOverlays && taskOverlays.length > 0 && window.ReelsOverlay) {
                const sortedOvs = taskOverlays.filter(ov => !ov.disabled).slice().sort((a, b) => {
                    return (a.type === 'scroll' ? 0 : 1) - (b.type === 'scroll' ? 0 : 1);
                });
                for (const ov of sortedOvs) {
                    ov._allOverlays = taskOverlays;
                    const ovStart = parseFloat(ov.start || 0);
                    const ovEnd = parseFloat(ov.end || 9999);
                    if (t >= ovStart && (ov.type === 'scroll' || t <= ovEnd)) {
                        const origSelected = ov._selected;
                        ov._selected = false;
                        ov._exporting = true;
                        ov._exportDuration = duration;
                        ov._taskSegments = segments;
                        ReelsOverlay.drawOverlay(ctx, ov, t, targetWidth, targetHeight);
                        ov._selected = origSelected;
                        ov._exporting = false;
                        delete ov._taskSegments;
                    }
                }
            }

            // AI 水印
            if (typeof _drawWatermarks === 'function') {
                _drawWatermarks(ctx, targetWidth, targetHeight);
            }

            // 保存画面层 PNG
            const videoBlob = await _canvasToPngBlob(canvas);
            const videoArrayBuf = await _blobToArrayBuffer(videoBlob);
            await window.electronAPI.savePngFrame({
                outputPath: `${videoDir}/${frameName}`,
                rawRGBA: videoArrayBuf,
                width: targetWidth,
                height: targetHeight,
                isPng: true, // 表示传入的已经是 PNG buffer
            });

            // ══════════════════════════════════════
            // 字幕层: 透明底 + 字幕
            // ══════════════════════════════════════
            subtitleCtx.clearRect(0, 0, targetWidth, targetHeight);
            subtitleRenderer.renderAmbientLightingBase?.(style, targetWidth, targetHeight);
            const hasKineticBackdrop = showSubtitle &&
                style.anim_in_type === 'kinetic_glow_stack' &&
                typeof subtitleRenderer.renderKineticGlowBackdrop === 'function';
            if (hasKineticBackdrop) {
                subtitleRenderer.renderKineticGlowBackdrop(style, targetWidth, targetHeight);
            }

            if (showSubtitle && segments && segments.length > 0) {
                let activeSeg = segments.find(seg => t >= (seg.start || 0) && t <= (seg.end || 0));
                // Scrolling/typewriter mode: find nearest segment during gaps
                if (!activeSeg && (style.scrolling_mode || style.fullpage_typewriter) && segments.length > 0) {
                    let best = segments[0];
                    for (const seg of segments) {
                        if ((seg.start || 0) <= t) best = seg;
                    }
                    activeSeg = best;
                }
                if (activeSeg) {
                    subtitleRenderer.setContextSegments(segments, originalScript);
                    subtitleRenderer.renderSubtitle(style, activeSeg, t, targetWidth, targetHeight, false, hasKineticBackdrop);
                }
            }

            // 保存字幕层 PNG（透明底）
            const subBlob = await _canvasToPngBlob(subtitleCanvas);
            const subArrayBuf = await _blobToArrayBuffer(subBlob);
            await window.electronAPI.savePngFrame({
                outputPath: `${subtitleDir}/${frameName}`,
                rawRGBA: subArrayBuf,
                width: targetWidth,
                height: targetHeight,
                isPng: true,
            });

            // ── 进度 ──
            if (frameIdx % Math.max(1, Math.floor(fps / 2)) === 0) {
                const pct = 20 + Math.round((frameIdx / totalFrames) * 65);
                progress(pct);
                const elapsed = (Date.now() - t0) / 1000;
                const fpsActual = (frameIdx + 1) / Math.max(0.1, elapsed);
                const eta = (totalFrames - frameIdx) / Math.max(0.1, fpsActual);
                log(`帧 ${frameIdx + 1}/${totalFrames} (${pct}%) | ${fpsActual.toFixed(1)} fps | 剩余 ~${Math.ceil(eta)}s`);
                await new Promise(r => setTimeout(r, 0)); // yield
            }
        }

        // ═══ 阶段 3: 导出音频 MP3 ═══
        log('阶段3: 导出音频 MP3...');
        progress(88);

        if (voicePath) {
            const mp3Result = await window.electronAPI.exportAudioMp3({
                inputPath: voicePath,
                outputPath: `${layersDir}/audio.mp3`,
                volume: voiceVolume,
            });
            if (mp3Result.ok) {
                log(`音频导出完成: audio.mp3`);
            } else {
                log(`⚠️ 音频导出失败: ${mp3Result.error}`);
            }
        }

        // 导出配乐 MP3
        if (bgmPath) {
            const bgmResult = await window.electronAPI.exportAudioMp3({
                inputPath: bgmPath,
                outputPath: `${layersDir}/bgm.mp3`,
                volume: bgmVolume,
                startTime: Math.max(0, parseFloat(bgmStart) || 0),
            });
            if (bgmResult.ok) {
                log(`配乐导出完成: bgm.mp3`);
            }
        }

        // 导出背景音 MP3（如果背景是视频且有音轨）
        const layeredBgPath = isMultiClip ? bgAudioPath : backgroundPath;
        if (layeredBgPath && !_isLayeredImageFile(layeredBgPath) && bgVolume > 0) {
            const bgAudioResult = await window.electronAPI.exportAudioMp3({
                inputPath: layeredBgPath,
                outputPath: `${layersDir}/bg_audio.mp3`,
                volume: bgVolume,
            });
            if (bgAudioResult.ok) {
                log(`背景音导出完成: bg_audio.mp3`);
            }
        }

        // ═══ 阶段 4: 写入元信息 ═══
        progress(95);
        const infoJson = JSON.stringify({
            format: 'png-layers',
            version: 1,
            width: targetWidth,
            height: targetHeight,
            fps,
            duration: parseFloat(duration.toFixed(3)),
            totalFrames,
            layers: {
                video: { dir: 'video', description: '画面层 (背景+蒙版+覆层)' },
                subtitle: { dir: 'subtitle', description: '字幕层 (透明底)' },
            },
            audio: {
                voice: voicePath ? 'audio.mp3' : null,
                bgm: bgmPath ? 'bgm.mp3' : null,
                bgAudio: (layeredBgPath && !_isLayeredImageFile(layeredBgPath) && bgVolume > 0) ? 'bg_audio.mp3' : null,
            },
            createdAt: new Date().toISOString(),
        }, null, 2);

        window.electronAPI.writeFileText(`${layersDir}/info.json`, infoJson);
        log(`元信息已写入: info.json`);

        // ── 清理缓存 ──
        if (framesDir) {
            await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir });
        }
        for (const ov of videoOverlays) {
            if (ov._framesDir) {
                try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: ov._framesDir }); } catch (_) { }
            }
        }
        if (cvFramesDir) {
            try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: cvFramesDir }); } catch (_) { }
        }

        progress(100);
        const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
        log(`✅ 分层导出完成 (${totalTime}s): ${layersDir}`);
        return { output_path: layersDir, layersDir };

    } catch (e) {
        // 清理
        if (framesDir) {
            try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir }); } catch (_) { }
        }
        for (const ov of videoOverlays) {
            if (ov._framesDir) {
                try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: ov._framesDir }); } catch (_) { }
            }
        }
        if (cvFramesDir) {
            try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: cvFramesDir }); } catch (_) { }
        }
        if (e && e.message === '__CANCELLED__') {
            log('导出已取消，资源已清理');
            return { cancelled: true };
        }
        throw e;
    }
}

if (typeof window !== 'undefined') {
    window.reelsLayeredExport = reelsLayeredExport;
}
