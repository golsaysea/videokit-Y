/**
 * reels-composite-mask.js — 共享双层前景遮罩、四边独立羽化与混合模式合成引擎
 *
 * 同时运行在主渲染窗口、Preview V2、WYSIWYG 独立导出窗口、并行影子窗口、分层导出、
 * 以及「🧩 双层拼接」独立工作台中，确保预览与最终 MP4 成片像素级完全一致。
 */
(function (root) {
    'use strict';

    const MASK_SHAPES = [
        { id: 'rect', label: '矩形 · 四边独立羽化 (溶图首选)' },
        { id: 'rounded', label: '圆角矩形 · 可配柔边与四向羽化' },
        { id: 'ellipse', label: '椭圆形 · 人物柔和画中画' },
        { id: 'circle', label: '正圆形 · 圆形柔和焦点' },
        { id: 'split_diag_tl', label: '斜切融合 ↘ (左上/右上对角)' },
        { id: 'split_diag_tr', label: '斜切融合 ↙ (右上/左下对角)' },
        { id: 'vignette_inv', label: '中心透出 (反向渐隐遮罩)' },
    ];

    const BLEND_MODES = [
        { id: 'source-over', label: '正常覆盖 (Normal)' },
        { id: 'screen', label: '滤色 Screen (去黑底 · 雾气/光斑/粒子)' },
        { id: 'lighter', label: '线性减淡 Add (高光发光增强)' },
        { id: 'multiply', label: '正片叠底 Multiply (去白底 · 水墨/纸纹)' },
        { id: 'overlay', label: '叠加 Overlay (高对比质感融合)' },
    ];

    const MASK_LAYOUT_PRESETS = [
        {
            id: 'fb_top_right_blend',
            name: '🌟 右上融背景 (FB爆款同款)',
            desc: '人物缩放右上 + 左/下大幅羽化溶入风景',
            config: {
                contentVideoScale: 68,
                contentVideoX: '185',
                contentVideoY: '-390',
                contentVideoRotation: 0,
                contentVideoOpacity: 100,
                contentVideoBlendMode: 'source-over',
                contentVideoMaskShape: 'rect',
                contentVideoMaskFeatherLeft: 48,
                contentVideoMaskFeatherRight: 0,
                contentVideoMaskFeatherTop: 0,
                contentVideoMaskFeatherBottom: 42,
                contentVideoMaskRadius: 0,
                contentVideoMaskSoftness: 0,
                contentVideoMaskInvert: false,
            },
        },
        {
            id: 'top_left_blend',
            name: '↖️ 左上融背景',
            desc: '前景位于左上 + 右/下边缘羽化融合',
            config: {
                contentVideoScale: 68,
                contentVideoX: '-185',
                contentVideoY: '-390',
                contentVideoRotation: 0,
                contentVideoOpacity: 100,
                contentVideoBlendMode: 'source-over',
                contentVideoMaskShape: 'rect',
                contentVideoMaskFeatherLeft: 0,
                contentVideoMaskFeatherRight: 48,
                contentVideoMaskFeatherTop: 0,
                contentVideoMaskFeatherBottom: 42,
                contentVideoMaskRadius: 0,
                contentVideoMaskSoftness: 0,
                contentVideoMaskInvert: false,
            },
        },
        {
            id: 'top_half_soft',
            name: '⬆️ 上人下景融合',
            desc: '前景铺宽居上 + 下半截大范围柔和溶图',
            config: {
                contentVideoScale: 100,
                contentVideoX: 'center',
                contentVideoY: '-360',
                contentVideoRotation: 0,
                contentVideoOpacity: 100,
                contentVideoBlendMode: 'source-over',
                contentVideoMaskShape: 'rect',
                contentVideoMaskFeatherLeft: 0,
                contentVideoMaskFeatherRight: 0,
                contentVideoMaskFeatherTop: 0,
                contentVideoMaskFeatherBottom: 52,
                contentVideoMaskRadius: 0,
                contentVideoMaskSoftness: 0,
                contentVideoMaskInvert: false,
            },
        },
        {
            id: 'bottom_half_soft',
            name: '⬇️ 下前景上风景',
            desc: '前景居下 + 上边缘大范围柔化融入天空',
            config: {
                contentVideoScale: 100,
                contentVideoX: 'center',
                contentVideoY: '360',
                contentVideoRotation: 0,
                contentVideoOpacity: 100,
                contentVideoBlendMode: 'source-over',
                contentVideoMaskShape: 'rect',
                contentVideoMaskFeatherLeft: 0,
                contentVideoMaskFeatherRight: 0,
                contentVideoMaskFeatherTop: 52,
                contentVideoMaskFeatherBottom: 0,
                contentVideoMaskRadius: 0,
                contentVideoMaskSoftness: 0,
                contentVideoMaskInvert: false,
            },
        },
        {
            id: 'ellipse_feather_pip',
            name: '⭕ 椭圆柔焦画中画',
            desc: '椭圆形柔和过渡，无生硬边框',
            config: {
                contentVideoScale: 58,
                contentVideoX: '190',
                contentVideoY: '-380',
                contentVideoRotation: 0,
                contentVideoOpacity: 100,
                contentVideoBlendMode: 'source-over',
                contentVideoMaskShape: 'ellipse',
                contentVideoMaskFeatherLeft: 0,
                contentVideoMaskFeatherRight: 0,
                contentVideoMaskFeatherTop: 0,
                contentVideoMaskFeatherBottom: 0,
                contentVideoMaskRadius: 0,
                contentVideoMaskSoftness: 32,
                contentVideoMaskInvert: false,
            },
        },
        {
            id: 'screen_mist_overlay',
            name: '🌫️ 黑底雾气/粒子滤色',
            desc: 'Screen 滤色自动透黑底 + 四周柔和过渡',
            config: {
                contentVideoScale: 100,
                contentVideoX: 'center',
                contentVideoY: 'center',
                contentVideoRotation: 0,
                contentVideoOpacity: 88,
                contentVideoBlendMode: 'screen',
                contentVideoMaskShape: 'rect',
                contentVideoMaskFeatherLeft: 12,
                contentVideoMaskFeatherRight: 12,
                contentVideoMaskFeatherTop: 12,
                contentVideoMaskFeatherBottom: 12,
                contentVideoMaskRadius: 0,
                contentVideoMaskSoftness: 0,
                contentVideoMaskInvert: false,
            },
        },
        {
            id: 'diag_split_merge',
            name: '📐 斜线双屏融合',
            desc: '斜角渐变分割拼贴两个画面',
            config: {
                contentVideoScale: 100,
                contentVideoX: 'center',
                contentVideoY: 'center',
                contentVideoRotation: 0,
                contentVideoOpacity: 100,
                contentVideoBlendMode: 'source-over',
                contentVideoMaskShape: 'split_diag_tl',
                contentVideoMaskFeatherLeft: 0,
                contentVideoMaskFeatherRight: 0,
                contentVideoMaskFeatherTop: 0,
                contentVideoMaskFeatherBottom: 0,
                contentVideoMaskRadius: 0,
                contentVideoMaskSoftness: 24,
                contentVideoMaskInvert: false,
            },
        },
        {
            id: 'none_reset',
            name: '⬜ 原片无遮罩',
            desc: '重置遮罩与混合模式，直接硬边覆盖',
            config: {
                contentVideoScale: 100,
                contentVideoX: 'center',
                contentVideoY: 'center',
                contentVideoRotation: 0,
                contentVideoOpacity: 100,
                contentVideoBlendMode: 'source-over',
                contentVideoMaskShape: 'rect',
                contentVideoMaskFeatherLeft: 0,
                contentVideoMaskFeatherRight: 0,
                contentVideoMaskFeatherTop: 0,
                contentVideoMaskFeatherBottom: 0,
                contentVideoMaskRadius: 0,
                contentVideoMaskSoftness: 0,
                contentVideoMaskInvert: false,
            },
        },
    ];

    const VALID_BLENDS = new Set(BLEND_MODES.map(b => b.id));
    const VALID_SHAPES = new Set(MASK_SHAPES.map(s => s.id));

    function _clamp(val, min, max, fallback) {
        const n = Number(val);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    function parseCropString(cropStr) {
        let cropX = 0, cropY = 0, cropW = 1, cropH = 1;
        if (cropStr && typeof cropStr === 'string' && cropStr.trim() !== '') {
            const parts = cropStr.split(',').map(p => parseFloat(p.trim()));
            if (parts.length === 4 && parts.every(p => Number.isFinite(p))) {
                cropX = Math.max(0, Math.min(100, parts[0])) / 100;
                cropY = Math.max(0, Math.min(100, parts[1])) / 100;
                cropW = Math.max(1, Math.min(100, parts[2])) / 100;
                cropH = Math.max(1, Math.min(100, parts[3])) / 100;
            }
        }
        return { cropX, cropY, cropW, cropH };
    }

    function extractMaskConfig(src = {}) {
        const s = (src && typeof src === 'object') ? src : {};
        const blendRaw = String(s.contentVideoBlendMode || 'source-over').trim();
        const shapeRaw = String(s.contentVideoMaskShape || 'rect').trim();
        return {
            contentVideoScale: _clamp(s.contentVideoScale, 1, 500, 100),
            contentVideoX: (s.contentVideoX != null && String(s.contentVideoX).trim() !== '') ? String(s.contentVideoX).trim() : 'center',
            contentVideoY: (s.contentVideoY != null && String(s.contentVideoY).trim() !== '') ? String(s.contentVideoY).trim() : 'center',
            contentVideoRotation: _clamp(s.contentVideoRotation, -360, 360, 0),
            contentVideoFlipH: Boolean(s.contentVideoFlipH),
            contentVideoFlipV: Boolean(s.contentVideoFlipV),
            contentVideoCrop: String(s.contentVideoCrop || ''),
            contentVideoOpacity: _clamp(s.contentVideoOpacity, 0, 100, 100),
            contentVideoBlendMode: VALID_BLENDS.has(blendRaw) ? blendRaw : 'source-over',
            contentVideoMaskShape: VALID_SHAPES.has(shapeRaw) ? shapeRaw : 'rect',
            contentVideoMaskFeatherTop: _clamp(s.contentVideoMaskFeatherTop, 0, 100, 0),
            contentVideoMaskFeatherBottom: _clamp(s.contentVideoMaskFeatherBottom, 0, 100, 0),
            contentVideoMaskFeatherLeft: _clamp(s.contentVideoMaskFeatherLeft, 0, 100, 0),
            contentVideoMaskFeatherRight: _clamp(s.contentVideoMaskFeatherRight, 0, 100, 0),
            contentVideoMaskRadius: _clamp(s.contentVideoMaskRadius, 0, 50, 0),
            contentVideoMaskSoftness: _clamp(s.contentVideoMaskSoftness, 0, 100, 0),
            contentVideoMaskInvert: Boolean(s.contentVideoMaskInvert),
        };
    }

    function hasActiveMaskOrBlend(cfg) {
        if (!cfg) return false;
        const c = extractMaskConfig(cfg);
        if (c.contentVideoOpacity < 99.9) return true;
        if (c.contentVideoBlendMode !== 'source-over') return true;
        if (Math.abs(c.contentVideoRotation) > 0.01) return true;
        if (c.contentVideoMaskInvert) return true;
        if (c.contentVideoMaskShape !== 'rect') {
            return !(c.contentVideoMaskShape === 'rounded' && c.contentVideoMaskRadius <= 0 && c.contentVideoMaskSoftness <= 0 &&
                c.contentVideoMaskFeatherTop <= 0 && c.contentVideoMaskFeatherBottom <= 0 &&
                c.contentVideoMaskFeatherLeft <= 0 && c.contentVideoMaskFeatherRight <= 0);
        }
        return (
            c.contentVideoMaskFeatherTop > 0 ||
            c.contentVideoMaskFeatherBottom > 0 ||
            c.contentVideoMaskFeatherLeft > 0 ||
            c.contentVideoMaskFeatherRight > 0 ||
            c.contentVideoMaskSoftness > 0
        );
    }

    function computeContentRect(srcW, srcH, targetW, targetH, rawCfg = {}, designW = 1080, designH = 1920) {
        const cfg = extractMaskConfig(rawCfg);
        const { cropX, cropY, cropW, cropH } = parseCropString(cfg.contentVideoCrop);
        const sx = srcW * cropX;
        const sy = srcH * cropY;
        const sWidth = Math.max(1, srcW * cropW);
        const sHeight = Math.max(1, srcH * cropH);

        const cScale = cfg.contentVideoScale / 100;
        const baseScale = targetW / sWidth;
        const finalScale = baseScale * cScale;
        const drawW = Math.max(1, sWidth * finalScale);
        const drawH = Math.max(1, sHeight * finalScale);

        let drawX = (targetW - drawW) / 2;
        let drawY = (targetH - drawH) / 2;

        if (cfg.contentVideoX && cfg.contentVideoX !== 'center') {
            const relX = parseFloat(cfg.contentVideoX);
            if (Number.isFinite(relX)) {
                drawX += Math.abs(relX) <= 1 ? (targetW * relX) : ((relX / (designW || 1080)) * targetW);
            }
        }
        if (cfg.contentVideoY && cfg.contentVideoY !== 'center') {
            const relY = parseFloat(cfg.contentVideoY);
            if (Number.isFinite(relY)) {
                drawY += Math.abs(relY) <= 1 ? (targetH * relY) : ((relY / (designH || 1920)) * targetH);
            }
        }

        return {
            sx, sy, sWidth, sHeight,
            drawX, drawY, drawW, drawH,
            cx: drawX + drawW / 2,
            cy: drawY + drawH / 2,
            rotation: cfg.contentVideoRotation,
            flipH: cfg.contentVideoFlipH,
            flipV: cfg.contentVideoFlipV,
        };
    }

    // 复用离屏缓冲画布以降低 30fps 预览与导出的内存分配
    let _scratchContent = null;
    let _scratchMask = null;
    function _createCanvas(w, h) {
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            return c;
        }
        if (typeof OffscreenCanvas === 'function') {
            return new OffscreenCanvas(w, h);
        }
        return null;
    }

    function _getScratchBuffers(w, h, factory) {
        const make = typeof factory === 'function' ? factory : _createCanvas;
        if (!_scratchContent) _scratchContent = make(w, h);
        if (!_scratchMask) _scratchMask = make(w, h);
        if (!_scratchContent || !_scratchMask) return null;
        if (_scratchContent.width !== w) _scratchContent.width = w;
        if (_scratchContent.height !== h) _scratchContent.height = h;
        if (_scratchMask.width !== w) _scratchMask.width = w;
        if (_scratchMask.height !== h) _scratchMask.height = h;
        return { contentCanvas: _scratchContent, maskCanvas: _scratchMask };
    }

    function _applyDirectionalEdgeFeather(mCtx, w, h, cfg) {
        const edges = [
            { pct: cfg.contentVideoMaskFeatherTop,    x0: 0, y0: 0, x1: 0, y1: h * (cfg.contentVideoMaskFeatherTop / 100) },
            { pct: cfg.contentVideoMaskFeatherBottom, x0: 0, y0: h, x1: 0, y1: h - h * (cfg.contentVideoMaskFeatherBottom / 100) },
            { pct: cfg.contentVideoMaskFeatherLeft,   x0: 0, y0: 0, x1: w * (cfg.contentVideoMaskFeatherLeft / 100), y1: 0 },
            { pct: cfg.contentVideoMaskFeatherRight,  x0: w, y0: 0, x1: w - w * (cfg.contentVideoMaskFeatherRight / 100), y1: 0 },
        ];
        mCtx.save();
        mCtx.globalCompositeOperation = 'destination-in';
        for (const e of edges) {
            if (!(e.pct > 0.1)) continue;
            const g = mCtx.createLinearGradient(e.x0, e.y0, e.x1, e.y1);
            g.addColorStop(0, 'rgba(255,255,255,0)');
            g.addColorStop(0.55, 'rgba(255,255,255,0.68)');
            g.addColorStop(1, 'rgba(255,255,255,1)');
            mCtx.fillStyle = g;
            mCtx.fillRect(0, 0, w, h);
        }
        mCtx.restore();
    }

    function _buildAlphaMask(maskCanvas, w, h, cfg) {
        const mCtx = maskCanvas.getContext('2d');
        if (!mCtx) return false;
        mCtx.clearRect(0, 0, w, h);

        const shape = cfg.contentVideoMaskShape || 'rect';
        const softPct = cfg.contentVideoMaskSoftness || 0;
        const radPct = cfg.contentVideoMaskRadius || 0;

        if (shape === 'ellipse' || shape === 'circle') {
            const radiusX = shape === 'circle' ? Math.min(w, h) / 2 : w / 2;
            const radiusY = shape === 'circle' ? Math.min(w, h) / 2 : h / 2;
            const maxR = Math.max(1, Math.max(radiusX, radiusY));
            const innerRatio = Math.max(0.02, Math.min(0.995, 1 - (softPct / 100) * 0.92));
            mCtx.save();
            mCtx.translate(w / 2, h / 2);
            mCtx.scale(radiusX / maxR, radiusY / maxR);
            const g = mCtx.createRadialGradient(0, 0, maxR * innerRatio, 0, 0, maxR);
            g.addColorStop(0, 'rgba(255,255,255,1)');
            g.addColorStop(0.65 + 0.35 * innerRatio, 'rgba(255,255,255,0.58)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            mCtx.fillStyle = g;
            mCtx.beginPath();
            mCtx.arc(0, 0, maxR, 0, Math.PI * 2);
            mCtx.fill();
            mCtx.restore();
        } else if (shape === 'vignette_inv') {
            const maxR = Math.max(1, Math.hypot(w / 2, h / 2));
            const holeStop = Math.max(0.05, Math.min(0.85, (radPct > 0 ? radPct / 50 : 0.35)));
            const featherBand = Math.max(0.03, (softPct / 100) * 0.5);
            mCtx.save();
            const g = mCtx.createRadialGradient(w / 2, h / 2, maxR * Math.max(0.01, holeStop - featherBand * 0.5), w / 2, h / 2, maxR * Math.min(0.99, holeStop + featherBand));
            g.addColorStop(0, 'rgba(255,255,255,0)');
            g.addColorStop(1, 'rgba(255,255,255,1)');
            mCtx.fillStyle = g;
            mCtx.fillRect(0, 0, w, h);
            mCtx.restore();
        } else if (shape === 'split_diag_tl' || shape === 'split_diag_tr') {
            const band = Math.max(0.005, Math.min(0.45, (softPct / 100) * 0.45));
            const x0 = shape === 'split_diag_tl' ? 0 : w;
            const x1 = shape === 'split_diag_tl' ? w : 0;
            const g = mCtx.createLinearGradient(x0, 0, x1, h);
            g.addColorStop(Math.max(0, 0.5 - band), 'rgba(255,255,255,1)');
            g.addColorStop(0.5, 'rgba(255,255,255,0.55)');
            g.addColorStop(Math.min(1, 0.5 + band), 'rgba(255,255,255,0)');
            mCtx.fillStyle = g;
            mCtx.fillRect(0, 0, w, h);
        } else if (shape === 'rounded') {
            const blurPx = Math.round(Math.min(w, h) * (softPct / 100) * 0.22);
            const inset = Math.min(Math.min(w, h) * 0.35, blurPx * 1.15);
            const rw = Math.max(2, w - inset * 2);
            const rh = Math.max(2, h - inset * 2);
            const cornerR = Math.min(rw / 2, rh / 2, Math.min(w, h) * (radPct > 0 ? radPct / 100 : 0.14));
            mCtx.save();
            if (blurPx > 0) {
                mCtx.shadowColor = '#ffffff';
                mCtx.shadowBlur = blurPx;
            }
            mCtx.fillStyle = '#ffffff';
            mCtx.beginPath();
            if (typeof mCtx.roundRect === 'function') {
                mCtx.roundRect(inset, inset, rw, rh, cornerR);
            } else {
                mCtx.rect(inset, inset, rw, rh);
            }
            mCtx.fill();
            mCtx.restore();
        } else {
            // 'rect' + optional overall edge softness
            if (softPct > 0.5) {
                const softEdge = Math.min(48, Math.max(4, softPct * 0.45));
                _fillRectWithBase(mCtx, w, h);
                _applyDirectionalEdgeFeather(mCtx, w, h, {
                    contentVideoMaskFeatherTop: Math.max(cfg.contentVideoMaskFeatherTop, softEdge),
                    contentVideoMaskFeatherBottom: Math.max(cfg.contentVideoMaskFeatherBottom, softEdge),
                    contentVideoMaskFeatherLeft: Math.max(cfg.contentVideoMaskFeatherLeft, softEdge),
                    contentVideoMaskFeatherRight: Math.max(cfg.contentVideoMaskFeatherRight, softEdge),
                });
                if (cfg.contentVideoMaskInvert) _invertCanvasAlpha(mCtx, w, h);
                return true;
            }
            _fillRectWithBase(mCtx, w, h);
        }

        _applyDirectionalEdgeFeather(mCtx, w, h, cfg);
        if (cfg.contentVideoMaskInvert) {
            _invertCanvasAlpha(mCtx, w, h);
        }
        return true;
    }

    function _fillRectWithBase(mCtx, w, h) {
        mCtx.fillStyle = '#ffffff';
        mCtx.fillRect(0, 0, w, h);
    }

    function _invertCanvasAlpha(mCtx, w, h) {
        mCtx.save();
        mCtx.globalCompositeOperation = 'source-out';
        mCtx.fillStyle = '#ffffff';
        mCtx.fillRect(0, 0, w, h);
        mCtx.restore();
    }

    function _drawFlippedSource(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh, flipH, flipV) {
        ctx.save();
        if (flipH || flipV) {
            ctx.translate(dx + dw / 2, dy + dh / 2);
            ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
            ctx.drawImage(img, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
        } else {
            ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
        }
        ctx.restore();
    }

    /**
     * 将第二层前景画面按遮罩、四边独立羽化、混合模式与不透明度合成到目标 Canvas 上下文中。
     */
    function drawCompositedContentLayer(ctx, drawSource, srcW, srcH, targetW, targetH, rawCfg = {}, options = {}) {
        if (!ctx || !drawSource || !(srcW > 0) || !(srcH > 0) || !(targetW > 0) || !(targetH > 0)) return null;
        const cfg = extractMaskConfig(rawCfg);
        const designW = Number(options.designW) || 1080;
        const designH = Number(options.designH) || 1920;
        const rect = computeContentRect(srcW, srcH, targetW, targetH, cfg, designW, designH);
        const alpha = _clamp(cfg.contentVideoOpacity / 100, 0, 1, 1);

        if (alpha <= 0.001) return rect;

        const needMaskPipeline = hasActiveMaskOrBlend(cfg);
        if (!needMaskPipeline) {
            _drawFlippedSource(ctx, drawSource, rect.sx, rect.sy, rect.sWidth, rect.sHeight, rect.drawX, rect.drawY, rect.drawW, rect.drawH, rect.flipH, rect.flipV);
        } else {
            const bufW = Math.max(2, Math.min(4096, Math.round(rect.drawW)));
            const bufH = Math.max(2, Math.min(4096, Math.round(rect.drawH)));
            const buffers = _getScratchBuffers(bufW, bufH, options.createCanvas);
            if (!buffers) {
                // 无离屏画布环境下的稳健回退
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.globalCompositeOperation = cfg.contentVideoBlendMode || 'source-over';
                ctx.translate(rect.cx, rect.cy);
                if (Math.abs(rect.rotation) > 0.01) ctx.rotate((rect.rotation * Math.PI) / 180);
                _drawFlippedSource(ctx, drawSource, rect.sx, rect.sy, rect.sWidth, rect.sHeight, -rect.drawW / 2, -rect.drawH / 2, rect.drawW, rect.drawH, rect.flipH, rect.flipV);
                ctx.restore();
            } else {
                const { contentCanvas, maskCanvas } = buffers;
                const cCtx = contentCanvas.getContext('2d');
                cCtx.clearRect(0, 0, bufW, bufH);
                _drawFlippedSource(cCtx, drawSource, rect.sx, rect.sy, rect.sWidth, rect.sHeight, 0, 0, bufW, bufH, rect.flipH, rect.flipV);

                if (cfg.contentVideoMaskShape !== 'rect' || cfg.contentVideoMaskFeatherTop > 0 || cfg.contentVideoMaskFeatherBottom > 0 ||
                    cfg.contentVideoMaskFeatherLeft > 0 || cfg.contentVideoMaskFeatherRight > 0 ||
                    cfg.contentVideoMaskSoftness > 0 || cfg.contentVideoMaskInvert) {
                    if (_buildAlphaMask(maskCanvas, bufW, bufH, cfg)) {
                        cCtx.save();
                        cCtx.globalCompositeOperation = 'destination-in';
                        cCtx.drawImage(maskCanvas, 0, 0, bufW, bufH);
                        cCtx.restore();
                    }
                }

                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.globalCompositeOperation = cfg.contentVideoBlendMode || 'source-over';
                ctx.translate(rect.cx, rect.cy);
                if (Math.abs(rect.rotation) > 0.01) ctx.rotate((rect.rotation * Math.PI) / 180);
                ctx.drawImage(contentCanvas, 0, 0, bufW, bufH, -rect.drawW / 2, -rect.drawH / 2, rect.drawW, rect.drawH);
                ctx.restore();
            }
        }

        if (options.showGuide === true) {
            ctx.save();
            ctx.translate(rect.cx, rect.cy);
            if (Math.abs(rect.rotation) > 0.01) ctx.rotate((rect.rotation * Math.PI) / 180);
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
            ctx.lineWidth = Math.max(2, Math.round(targetW / 360));
            ctx.setLineDash([12, 8]);
            ctx.strokeRect(-rect.drawW / 2, -rect.drawH / 2, rect.drawW, rect.drawH);
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(56, 189, 248, 0.95)';
            const r = Math.max(6, Math.round(targetW / 120));
            for (const [kx, ky] of [
                [-rect.drawW / 2, -rect.drawH / 2],
                [rect.drawW / 2, -rect.drawH / 2],
                [-rect.drawW / 2, rect.drawH / 2],
                [rect.drawW / 2, rect.drawH / 2],
            ]) {
                ctx.beginPath();
                ctx.arc(kx, ky, r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }
        return rect;
    }

    const api = {
        MASK_SHAPES,
        BLEND_MODES,
        MASK_LAYOUT_PRESETS,
        parseCropString,
        extractMaskConfig,
        hasActiveMaskOrBlend,
        computeContentRect,
        drawCompositedContentLayer,
    };

    if (typeof window !== 'undefined') {
        window.ReelsCompositeMask = api;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
