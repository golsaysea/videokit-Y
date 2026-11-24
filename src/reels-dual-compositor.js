/**
 * reels-dual-compositor.js — 独立「🧩 双层拼接」工作台
 *
 * 专用于双层视频/图片遮罩溶图、黑底雾气滤色叠加、四边独立渐变羽化与批量配对导出，
 * 并支持一键将配好遮罩的任务送入「🎬 批量Reels」继续制作字幕/祷告词/配音。
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'vk_dual_compositor_state_v1';
    const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.flv', '.wmv']);
    const MEDIA_EXTS = new Set([...VIDEO_EXTS, '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);

    function _esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[ch]));
    }

    function _shortName(p) {
        if (!p) return '';
        const parts = String(p).split(/[/\\]/);
        return parts[parts.length - 1] || p;
    }

    function _isVideoFile(p) {
        if (!p) return false;
        const m = String(p).toLowerCase().match(/(\.[a-z0-9]+)(?:[?#]|$)/);
        return m ? VIDEO_EXTS.has(m[1]) : false;
    }

    function _toUrl(p) {
        if (!p) return '';
        if (window.electronAPI?.toFileUrl) return window.electronAPI.toFileUrl(p);
        return p;
    }

    function _maskApi() {
        return (typeof window !== 'undefined' && window.ReelsCompositeMask) || null;
    }

    function _defaultRow(overrides = {}) {
        const maskDef = _maskApi()?.extractMaskConfig(overrides) || {
            contentVideoScale: 68,
            contentVideoX: '185',
            contentVideoY: '-390',
            contentVideoRotation: 0,
            contentVideoFlipH: false,
            contentVideoFlipV: false,
            contentVideoCrop: '',
            contentVideoOpacity: 100,
            contentVideoBlendMode: 'source-over',
            contentVideoMaskShape: 'rect',
            contentVideoMaskFeatherTop: 0,
            contentVideoMaskFeatherBottom: 42,
            contentVideoMaskFeatherLeft: 48,
            contentVideoMaskFeatherRight: 0,
            contentVideoMaskRadius: 0,
            contentVideoMaskSoftness: 0,
            contentVideoMaskInvert: false,
        };
        const bgPath = String(overrides.bgPath || '');
        const cvPath = String(overrides.contentVideoPath || '');
        const fallbackName = _shortName(cvPath || bgPath).replace(/\.[^.]+$/, '') || `拼接_${Date.now().toString(36).slice(-4)}`;
        return {
            id: overrides.id || `dc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            checked: overrides.checked !== false,
            name: String(overrides.name || fallbackName),
            bgPath,
            contentVideoPath: cvPath,
            bgScale: Number(overrides.bgScale) || 100,
            bgVideoVolume: overrides.bgVideoVolume != null ? Number(overrides.bgVideoVolume) : 100,
            contentVideoVolume: overrides.contentVideoVolume != null ? Number(overrides.contentVideoVolume) : 100,
            contentVideoTrimStart: overrides.contentVideoTrimStart != null ? overrides.contentVideoTrimStart : null,
            contentVideoTrimEnd: overrides.contentVideoTrimEnd != null ? overrides.contentVideoTrimEnd : null,
            customDuration: Number(overrides.customDuration) || 0,
            status: 'idle',
            statusText: '',
            ...maskDef,
        };
    }

    const _dcState = {
        initialized: false,
        items: [],
        selectedIdx: -1,
        isPlaying: false,
        currentTime: 0,
        duration: 8,
        showGuide: true,
        previewMuted: true,
        isExporting: false,
        outputDir: '',
        rafId: 0,
        lastTickTs: 0,
        dragging: null,
        bgEl: null,
        cvEl: null,
        bgLoadedPath: '',
        cvLoadedPath: '',
    };

    function _loadSavedState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed?.items)) {
                _dcState.items = parsed.items.map(it => _defaultRow(it));
            }
            if (Number.isInteger(parsed?.selectedIdx) && parsed.selectedIdx >= 0 && parsed.selectedIdx < _dcState.items.length) {
                _dcState.selectedIdx = parsed.selectedIdx;
            } else {
                _dcState.selectedIdx = _dcState.items.length > 0 ? 0 : -1;
            }
            if (parsed?.outputDir) _dcState.outputDir = String(parsed.outputDir);
            if (typeof parsed?.showGuide === 'boolean') _dcState.showGuide = parsed.showGuide;
        } catch (_) {}
    }

    function _persistState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                items: _dcState.items.map(it => ({ ...it, status: 'idle', statusText: '' })),
                selectedIdx: _dcState.selectedIdx,
                outputDir: _dcState.outputDir,
                showGuide: _dcState.showGuide,
            }));
        } catch (_) {}
    }

    function _getActiveItem() {
        if (_dcState.selectedIdx >= 0 && _dcState.selectedIdx < _dcState.items.length) {
            return _dcState.items[_dcState.selectedIdx];
        }
        return null;
    }

    function _notify(msg, type = 'info', ms = 3600) {
        if (typeof window.showToast === 'function') {
            window.showToast(msg, type, ms);
        } else {
            console.log(`[DualCompositor] ${msg}`);
        }
    }

    async function _pickMediaFiles({ title = '选择视频或图片素材', multiple = false } = {}) {
        if (window.electronAPI?.selectFiles) {
            const res = await window.electronAPI.selectFiles({
                title,
                multiple,
                properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
                filters: [
                    { name: '视频与图片素材', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'webp'] },
                    { name: '所有文件', extensions: ['*'] },
                ],
            });
            return Array.isArray(res) ? res.filter(Boolean) : [];
        }
        return await new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = !!multiple;
            input.accept = 'video/*,image/*';
            input.onchange = () => {
                const files = Array.from(input.files || []);
                const paths = files.map(f => (typeof window.getFileNativePath === 'function' ? window.getFileNativePath(f) : f.path) || '').filter(Boolean);
                resolve(paths);
            };
            input.click();
        });
    }

    async function _pickMediaFolderFiles() {
        if (!window.electronAPI?.selectDirectory || !window.electronAPI?.scanDirectory) {
            return await _pickMediaFiles({ title: '多选素材文件', multiple: true });
        }
        const dir = await window.electronAPI.selectDirectory();
        if (!dir) return [];
        const entries = await window.electronAPI.scanDirectory(dir);
        const list = Array.isArray(entries) ? entries : [];
        return list
            .map(e => (typeof e === 'string' ? e : e?.path || ''))
            .filter(p => {
                if (!p) return false;
                const m = p.toLowerCase().match(/(\.[a-z0-9]+)$/);
                return m ? MEDIA_EXTS.has(m[1]) : false;
            })
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    }

    function _releaseMediaEl(el) {
        if (!el) return;
        if (el.tagName === 'VIDEO') {
            try { el.pause?.(); el.removeAttribute('src'); el.load?.(); } catch (_) {}
        }
    }

    function _loadPreviewElement(filePath) {
        if (!filePath) return null;
        const url = _toUrl(filePath);
        if (_isVideoFile(filePath)) {
            const v = document.createElement('video');
            v.crossOrigin = 'anonymous';
            v.playsInline = true;
            v.loop = true;
            v.preload = 'auto';
            v.muted = _dcState.previewMuted;
            v.src = url;
            v.addEventListener('loadedmetadata', () => {
                _recomputePreviewDuration();
                if (!_dcState.isPlaying) {
                    _seekVideoSafe(v, _computeLayerSourceTime(_dcState.currentTime, v, null));
                }
                _drawStageFrame();
            });
            v.addEventListener('seeked', () => {
                if (!_dcState.isPlaying) _drawStageFrame();
            });
            return v;
        }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => _drawStageFrame();
        img.src = url;
        return img;
    }

    function _computeLayerSourceTime(t, videoEl, item, isContentLayer = false) {
        if (!videoEl || !Number.isFinite(videoEl.duration) || videoEl.duration <= 0) return 0;
        const rawDur = videoEl.duration;
        if (isContentLayer && item) {
            const ts = Number.isFinite(parseFloat(item.contentVideoTrimStart)) ? Math.max(0, parseFloat(item.contentVideoTrimStart)) : 0;
            const teRaw = parseFloat(item.contentVideoTrimEnd);
            const te = (Number.isFinite(teRaw) && teRaw > ts) ? Math.min(rawDur, teRaw) : rawDur;
            const segDur = Math.max(0.1, te - ts);
            return ts + (t % segDur);
        }
        return t % Math.max(0.1, rawDur);
    }

    function _seekVideoSafe(v, targetSec) {
        if (!v || v.tagName !== 'VIDEO' || v.readyState < 1) return;
        const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
        const clamped = Math.max(0, Math.min(dur - 0.02, targetSec));
        if (Math.abs((v.currentTime || 0) - clamped) > 0.03) {
            try { v.currentTime = clamped; } catch (_) {}
        }
    }

    function _syncMediaVolumeAndMute() {
        const item = _getActiveItem();
        if (_dcState.bgEl?.tagName === 'VIDEO') {
            _dcState.bgEl.muted = _dcState.previewMuted;
            const bgVol = Math.max(0, Math.min(1, ((item?.bgVideoVolume ?? 100) / 100)));
            _dcState.bgEl.volume = bgVol;
        }
        if (_dcState.cvEl?.tagName === 'VIDEO') {
            _dcState.cvEl.muted = _dcState.previewMuted;
            const cvVol = Math.max(0, Math.min(1, ((item?.contentVideoVolume ?? 100) / 100)));
            _dcState.cvEl.volume = cvVol;
        }
    }

    function _recomputePreviewDuration() {
        const item = _getActiveItem();
        let bgDur = (_dcState.bgEl?.tagName === 'VIDEO' && Number.isFinite(_dcState.bgEl.duration)) ? _dcState.bgEl.duration : 0;
        let cvDur = (_dcState.cvEl?.tagName === 'VIDEO' && Number.isFinite(_dcState.cvEl.duration)) ? _dcState.cvEl.duration : 0;
        if (item && cvDur > 0) {
            const ts = parseFloat(item.contentVideoTrimStart);
            const te = parseFloat(item.contentVideoTrimEnd);
            if (Number.isFinite(ts) && Number.isFinite(te) && te > ts) {
                cvDur = Math.min(cvDur, te) - Math.max(0, ts);
            } else if (Number.isFinite(ts) && ts > 0 && ts < cvDur) {
                cvDur = cvDur - ts;
            } else if (Number.isFinite(te) && te > 0 && te < cvDur) {
                cvDur = te;
            }
        }
        const customDur = Number(item?.customDuration) || 0;
        _dcState.duration = customDur > 0 ? customDur : Math.max(bgDur, cvDur, 6);
        const scrub = document.getElementById('dc-scrub');
        if (scrub) scrub.max = String(_dcState.duration.toFixed(2));
        _updateTimeReadout();
    }

    function _syncMediaElementsForSelection() {
        const item = _getActiveItem();
        const nextBg = item?.bgPath || '';
        const nextCv = item?.contentVideoPath || '';
        if (nextBg !== _dcState.bgLoadedPath) {
            _releaseMediaEl(_dcState.bgEl);
            _dcState.bgLoadedPath = nextBg;
            _dcState.bgEl = nextBg ? _loadPreviewElement(nextBg) : null;
        }
        if (nextCv !== _dcState.cvLoadedPath) {
            _releaseMediaEl(_dcState.cvEl);
            _dcState.cvLoadedPath = nextCv;
            _dcState.cvEl = nextCv ? _loadPreviewElement(nextCv) : null;
        }
        _syncMediaVolumeAndMute();
        _recomputePreviewDuration();
    }

    function _updateTimeReadout() {
        const lbl = document.getElementById('dc-time-label');
        const scrub = document.getElementById('dc-scrub');
        if (lbl) lbl.textContent = `${_dcState.currentTime.toFixed(1)}s / ${_dcState.duration.toFixed(1)}s`;
        if (scrub && document.activeElement !== scrub) scrub.value = String(_dcState.currentTime);
    }

    function _drawStageFrame() {
        const canvas = document.getElementById('dc-preview-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#070b14';
        ctx.fillRect(0, 0, w, h);

        const item = _getActiveItem();
        if (!item) {
            ctx.fillStyle = '#64748b';
            ctx.font = 'bold 34px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('请先在左侧添加或导入「背景 + 前景」配对任务', w / 2, h / 2 - 20);
            ctx.font = '26px sans-serif';
            ctx.fillStyle = '#475569';
            ctx.fillText('支持 1对N 批量配对 / N对N 配对 / 四边独立羽化遮罩', w / 2, h / 2 + 34);
            return;
        }

        // 1. 绘制底层背景素材 (Cover 9:16 + 背景缩放)
        const bgSrc = _dcState.bgEl;
        const bgReady = bgSrc && (bgSrc.tagName === 'VIDEO' ? bgSrc.readyState >= 1 && bgSrc.videoWidth > 0 : bgSrc.complete && bgSrc.naturalWidth > 0);
        if (bgReady) {
            const bw = bgSrc.videoWidth || bgSrc.naturalWidth;
            const bh = bgSrc.videoHeight || bgSrc.naturalHeight;
            const scale = Math.max(w / bw, h / bh) * ((item.bgScale || 100) / 100);
            const dw = bw * scale;
            const dh = bh * scale;
            ctx.drawImage(bgSrc, (w - dw) / 2, (h - dh) / 2, dw, dh);
        } else {
            // 棋盘透明占位提示
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#475569';
            ctx.font = 'bold 28px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(item.bgPath ? '⏳ 正在载入底层背景素材...' : '底层背景未选择 (请在左侧挑选背景)', w / 2, h * 0.78);
        }

        // 2. 绘制第二层前景素材（带四边独立羽化遮罩 + 混合模式 + 不透明度 + 旋转）
        const cvSrc = _dcState.cvEl;
        const cvReady = cvSrc && (cvSrc.tagName === 'VIDEO' ? cvSrc.readyState >= 1 && cvSrc.videoWidth > 0 : cvSrc.complete && cvSrc.naturalWidth > 0);
        if (cvReady) {
            const cw = cvSrc.videoWidth || cvSrc.naturalWidth;
            const ch = cvSrc.videoHeight || cvSrc.naturalHeight;
            const api = _maskApi();
            if (api?.drawCompositedContentLayer) {
                api.drawCompositedContentLayer(ctx, cvSrc, cw, ch, w, h, item, {
                    designW: 1080,
                    designH: 1920,
                    showGuide: _dcState.showGuide,
                });
            } else {
                ctx.drawImage(cvSrc, 0, 0, w, h);
            }
        }
    }

    function _playLoop(ts) {
        if (!_dcState.isPlaying) return;
        if (!_dcState.lastTickTs) _dcState.lastTickTs = ts;
        const dt = Math.min(0.1, (ts - _dcState.lastTickTs) / 1000);
        _dcState.lastTickTs = ts;
        _dcState.currentTime += dt;
        if (_dcState.currentTime >= _dcState.duration) {
            _dcState.currentTime = 0;
            const item = _getActiveItem();
            if (_dcState.bgEl?.tagName === 'VIDEO') _seekVideoSafe(_dcState.bgEl, 0);
            if (_dcState.cvEl?.tagName === 'VIDEO') _seekVideoSafe(_dcState.cvEl, _computeLayerSourceTime(0, _dcState.cvEl, item, true));
        }
        _updateTimeReadout();
        _drawStageFrame();
        _dcState.rafId = requestAnimationFrame(_playLoop);
    }

    function _setPlaying(play) {
        _dcState.isPlaying = Boolean(play);
        const btn = document.getElementById('dc-play-btn');
        if (btn) btn.textContent = _dcState.isPlaying ? '⏸ 暂停' : '▶ 播放';
        if (_dcState.isPlaying) {
            const item = _getActiveItem();
            if (_dcState.bgEl?.tagName === 'VIDEO') {
                _seekVideoSafe(_dcState.bgEl, _computeLayerSourceTime(_dcState.currentTime, _dcState.bgEl, item, false));
                _dcState.bgEl.play?.().catch(() => {});
            }
            if (_dcState.cvEl?.tagName === 'VIDEO') {
                _seekVideoSafe(_dcState.cvEl, _computeLayerSourceTime(_dcState.currentTime, _dcState.cvEl, item, true));
                _dcState.cvEl.play?.().catch(() => {});
            }
            _dcState.lastTickTs = 0;
            cancelAnimationFrame(_dcState.rafId);
            _dcState.rafId = requestAnimationFrame(_playLoop);
        } else {
            cancelAnimationFrame(_dcState.rafId);
            if (_dcState.bgEl?.tagName === 'VIDEO') _dcState.bgEl.pause?.();
            if (_dcState.cvEl?.tagName === 'VIDEO') _dcState.cvEl.pause?.();
        }
    }

    const _INSPECTOR_NUMERIC_FIELDS = [
        ['dc-in-feather-left', 'contentVideoMaskFeatherLeft', 0],
        ['dc-in-feather-right', 'contentVideoMaskFeatherRight', 0],
        ['dc-in-feather-top', 'contentVideoMaskFeatherTop', 0],
        ['dc-in-feather-bottom', 'contentVideoMaskFeatherBottom', 0],
        ['dc-in-softness', 'contentVideoMaskSoftness', 0],
        ['dc-in-radius', 'contentVideoMaskRadius', 0],
        ['dc-in-opacity', 'contentVideoOpacity', 100],
        ['dc-in-scale', 'contentVideoScale', 100],
        ['dc-in-rotate', 'contentVideoRotation', 0],
        ['dc-in-cv-vol', 'contentVideoVolume', 100],
        ['dc-in-bg-vol', 'bgVideoVolume', 100],
        ['dc-in-bg-scale', 'bgScale', 100],
    ];

    function _syncInspectorFromItem() {
        const item = _getActiveItem();
        const disabled = !item;
        const shapeEl = document.getElementById('dc-in-shape');
        const blendEl = document.getElementById('dc-in-blend');
        const invEl = document.getElementById('dc-in-invert');
        const flipHEl = document.getElementById('dc-in-fliph');
        const flipVEl = document.getElementById('dc-in-flipv');
        const xNumEl = document.getElementById('dc-in-x-num');
        const xRangeEl = document.getElementById('dc-in-x-range');
        const yNumEl = document.getElementById('dc-in-y-num');
        const yRangeEl = document.getElementById('dc-in-y-range');
        const tsEl = document.getElementById('dc-in-trim-start');
        const teEl = document.getElementById('dc-in-trim-end');
        const durEl = document.getElementById('dc-in-duration');

        if (shapeEl) { shapeEl.disabled = disabled; shapeEl.value = item?.contentVideoMaskShape || 'rect'; }
        if (blendEl) { blendEl.disabled = disabled; blendEl.value = item?.contentVideoBlendMode || 'source-over'; }
        if (invEl) { invEl.disabled = disabled; invEl.checked = !!item?.contentVideoMaskInvert; }
        if (flipHEl) { flipHEl.disabled = disabled; flipHEl.checked = !!item?.contentVideoFlipH; }
        if (flipVEl) { flipVEl.disabled = disabled; flipVEl.checked = !!item?.contentVideoFlipV; }

        const vx = item?.contentVideoX && item.contentVideoX !== 'center' ? (parseFloat(item.contentVideoX) || 0) : 0;
        const vy = item?.contentVideoY && item.contentVideoY !== 'center' ? (parseFloat(item.contentVideoY) || 0) : 0;
        if (xNumEl) { xNumEl.disabled = disabled; xNumEl.value = vx; }
        if (xRangeEl) { xRangeEl.disabled = disabled; xRangeEl.value = Math.max(-540, Math.min(540, vx)); }
        if (yNumEl) { yNumEl.disabled = disabled; yNumEl.value = vy; }
        if (yRangeEl) { yRangeEl.disabled = disabled; yRangeEl.value = Math.max(-960, Math.min(960, vy)); }

        if (tsEl) { tsEl.disabled = disabled; tsEl.value = item?.contentVideoTrimStart != null ? item.contentVideoTrimStart : ''; }
        if (teEl) { teEl.disabled = disabled; teEl.value = item?.contentVideoTrimEnd != null ? item.contentVideoTrimEnd : ''; }
        if (durEl) { durEl.disabled = disabled; durEl.value = item?.customDuration > 0 ? item.customDuration : ''; }

        for (const [idPrefix, field, defVal] of _INSPECTOR_NUMERIC_FIELDS) {
            const val = item?.[field] != null ? item[field] : defVal;
            const r = document.getElementById(`${idPrefix}-range`);
            const n = document.getElementById(`${idPrefix}-num`);
            if (r) { r.disabled = disabled; r.value = val; }
            if (n) { n.disabled = disabled; n.value = val; }
        }

        const cropParts = String(item?.contentVideoCrop || '0,0,100,100').split(',').map(v => parseFloat(v.trim()));
        const [cl, ct, cw, ch] = cropParts.length === 4 && cropParts.every(Number.isFinite) ? cropParts : [0, 0, 100, 100];
        for (const [cid, val] of [['dc-in-crop-l', cl], ['dc-in-crop-t', ct], ['dc-in-crop-w', cw], ['dc-in-crop-h', ch]]) {
            const el = document.getElementById(cid);
            if (el) { el.disabled = disabled; el.value = val; }
        }
    }

    function _renderQueueList() {
        const listEl = document.getElementById('dc-queue-list');
        const countEl = document.getElementById('dc-queue-count');
        const checkedCount = _dcState.items.filter(i => i.checked).length;
        if (countEl) countEl.textContent = `共 ${_dcState.items.length} 条 · 已勾选 ${checkedCount} 条`;
        if (!listEl) return;

        if (_dcState.items.length === 0) {
            listEl.innerHTML = `<div style="padding:36px 14px;text-align:center;color:#94a3b8;border:1px dashed rgba(148,163,184,0.28);border-radius:10px;font-size:12px;line-height:1.7;">
                暂无拼接任务<br>
                点击上方 <b style="color:#7dd3fc;">🔗 1对N</b>、<b style="color:#a78bfa;">🎞️ N对N</b> 或 <b style="color:#6ee7b7;">➕ 加行</b><br>快速构建双层蒙版合成队列
            </div>`;
            return;
        }

        listEl.innerHTML = _dcState.items.map((item, idx) => {
            const active = idx === _dcState.selectedIdx;
            const maskInfo = item.contentVideoBlendMode !== 'source-over'
                ? `混合:${item.contentVideoBlendMode}`
                : (item.contentVideoMaskShape !== 'rect'
                    ? `遮罩:${item.contentVideoMaskShape}`
                    : `羽化 L${Math.round(item.contentVideoMaskFeatherLeft || 0)} B${Math.round(item.contentVideoMaskFeatherBottom || 0)} T${Math.round(item.contentVideoMaskFeatherTop || 0)} R${Math.round(item.contentVideoMaskFeatherRight || 0)}`);
            const statusColor = item.status === 'done' ? '#4ade80' : item.status === 'error' ? '#f87171' : '#38bdf8';
            return `
                <div class="dc-row-card" data-idx="${idx}" style="padding:8px 10px;border-radius:9px;cursor:pointer;border:1px solid ${active ? 'rgba(56,189,248,0.75)' : 'rgba(148,163,184,0.18)'};background:${active ? 'rgba(14,165,233,0.14)' : 'rgba(15,23,42,0.7)'};display:flex;flex-direction:column;gap:5px;">
                    <div style="display:flex;align-items:center;gap:6px;">
                        <input type="checkbox" class="dc-row-check" data-idx="${idx}" ${item.checked ? 'checked' : ''} style="accent-color:#38bdf8;margin:0;">
                        <span style="font-size:11px;font-weight:700;color:#7dd3fc;">#${idx + 1}</span>
                        <input type="text" class="dc-row-name" data-idx="${idx}" value="${_esc(item.name)}" style="flex:1;min-width:0;background:transparent;border:none;border-bottom:1px dashed rgba(148,163,184,0.25);color:#f8fafc;font-size:12px;font-weight:600;padding:1px 2px;">
                        <button type="button" class="dc-row-del" data-idx="${idx}" title="删除该行" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;padding:0 3px;">✕</button>
                    </div>
                    <div style="display:flex;align-items:center;gap:4px;font-size:11px;">
                        <span style="color:#94a3b8;min-width:34px;">底图:</span>
                        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${item.bgPath ? '#e2e8f0' : '#f59e0b'};" title="${_esc(item.bgPath)}">${_esc(item.bgPath ? _shortName(item.bgPath) : '未选背景')}</span>
                        <button type="button" class="dc-pick-bg" data-idx="${idx}" style="padding:1px 6px;font-size:10px;border-radius:4px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">选</button>
                    </div>
                    <div style="display:flex;align-items:center;gap:4px;font-size:11px;">
                        <span style="color:#94a3b8;min-width:34px;">前景:</span>
                        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${item.contentVideoPath ? '#a5f3fc' : '#f59e0b'};" title="${_esc(item.contentVideoPath)}">${_esc(item.contentVideoPath ? _shortName(item.contentVideoPath) : '未选前景')}</span>
                        <button type="button" class="dc-pick-cv" data-idx="${idx}" style="padding:1px 6px;font-size:10px;border-radius:4px;border:1px solid #0284c7;background:rgba(14,165,233,0.18);color:#7dd3fc;cursor:pointer;">选</button>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:space-between;font-size:10px;color:#94a3b8;">
                        <span>${_esc(maskInfo)} · 缩放${Math.round(item.contentVideoScale)}%</span>
                        ${item.statusText ? `<span style="color:${statusColor};font-weight:600;">${_esc(item.statusText)}</span>` : ''}
                    </div>
                </div>
            `;
        }).join('');

        listEl.querySelectorAll('.dc-row-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('button, input')) return;
                const i = parseInt(card.dataset.idx, 10);
                _selectRow(i);
            });
        });
        listEl.querySelectorAll('.dc-row-check').forEach(cb => {
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                const i = parseInt(cb.dataset.idx, 10);
                if (_dcState.items[i]) _dcState.items[i].checked = !!cb.checked;
                _persistState();
                const cntEl = document.getElementById('dc-queue-count');
                if (cntEl) cntEl.textContent = `共 ${_dcState.items.length} 条 · 已勾选 ${_dcState.items.filter(x => x.checked).length} 条`;
            });
        });
        listEl.querySelectorAll('.dc-row-name').forEach(inp => {
            inp.addEventListener('change', () => {
                const i = parseInt(inp.dataset.idx, 10);
                if (_dcState.items[i]) _dcState.items[i].name = inp.value.trim() || `拼接_${i + 1}`;
                _persistState();
            });
        });
        listEl.querySelectorAll('.dc-row-del').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const i = parseInt(btn.dataset.idx, 10);
                _dcState.items.splice(i, 1);
                if (_dcState.selectedIdx >= _dcState.items.length) _dcState.selectedIdx = _dcState.items.length - 1;
                _persistState();
                _renderQueueList();
                _syncMediaElementsForSelection();
                _syncInspectorFromItem();
                _drawStageFrame();
            });
        });
        listEl.querySelectorAll('.dc-pick-bg').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const i = parseInt(btn.dataset.idx, 10);
                const files = await _pickMediaFiles({ title: `为第 ${i + 1} 行选择底层背景素材`, multiple: false });
                if (files[0] && _dcState.items[i]) {
                    _dcState.items[i].bgPath = files[0];
                    _selectRow(i);
                }
            });
        });
        listEl.querySelectorAll('.dc-pick-cv').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const i = parseInt(btn.dataset.idx, 10);
                const files = await _pickMediaFiles({ title: `为第 ${i + 1} 行选择第二层前景素材`, multiple: false });
                if (files[0] && _dcState.items[i]) {
                    _dcState.items[i].contentVideoPath = files[0];
                    _selectRow(i);
                }
            });
        });
    }

    function _selectRow(idx) {
        if (idx < 0 || idx >= _dcState.items.length) {
            _dcState.selectedIdx = -1;
        } else {
            _dcState.selectedIdx = idx;
        }
        _setPlaying(false);
        _dcState.currentTime = 0;
        _persistState();
        _renderQueueList();
        _syncMediaElementsForSelection();
        _syncInspectorFromItem();
        _drawStageFrame();
    }

    function _updateActiveItemField(updater, { refreshList = false } = {}) {
        const item = _getActiveItem();
        if (!item) return;
        updater(item);
        _persistState();
        _syncMediaVolumeAndMute();
        if (refreshList) _renderQueueList();
        _drawStageFrame();
    }

    function _applyMaskPresetToSelected(presetId) {
        const preset = _maskApi()?.MASK_LAYOUT_PRESETS?.find(p => p.id === presetId);
        const item = _getActiveItem();
        if (!preset?.config || !item) return;
        Object.assign(item, preset.config);
        _persistState();
        _syncInspectorFromItem();
        _renderQueueList();
        _drawStageFrame();
        _notify(`✨ 已应用版式预设：${preset.name}`, 'success', 2600);
    }

    async function _buildOneToManyBatch(useFolder = false) {
        const existingCv = _getActiveItem()?.contentVideoPath || '';
        const cvChoice = await _pickMediaFiles({
            title: existingCv ? '步骤1/2：选择共用第二层前景素材（取消则沿用当前前景）' : '步骤1/2：选择 1 个共用的第二层前景素材 (视频或图片)',
            multiple: false,
        });
        const sharedCv = cvChoice[0] || existingCv;
        if (!sharedCv) {
            _notify('已取消：请先挑选 1 个前景素材', 'info');
            return;
        }
        const bgs = useFolder
            ? await _pickMediaFolderFiles()
            : await _pickMediaFiles({ title: '步骤2/2：多选底层背景素材 (将分别与该前景合成)', multiple: true });
        if (!bgs.length) return;

        const templateMask = _maskApi()?.extractMaskConfig(_getActiveItem() || {}) || {};
        for (const bg of bgs) {
            const name = `${_shortName(bg).replace(/\.[^.]+$/, '')}_${_shortName(sharedCv).replace(/\.[^.]+$/, '').slice(0, 14)}`;
            _dcState.items.push(_defaultRow({ ...templateMask, bgPath: bg, contentVideoPath: sharedCv, name }));
        }
        _selectRow(Math.max(0, _dcState.items.length - bgs.length));
        _notify(`✅ 已生成 ${bgs.length} 条「1对N」双层合成任务`, 'success');
    }

    async function _buildManyToManyBatch() {
        const bgs = await _pickMediaFiles({ title: '步骤1/2：多选底层背景素材列表', multiple: true });
        if (!bgs.length) return;
        const cvs = await _pickMediaFiles({ title: '步骤2/2：多选前景素材列表 (按序号一一配对)', multiple: true });
        if (!cvs.length) return;
        const count = Math.max(bgs.length, cvs.length);
        const templateMask = _maskApi()?.extractMaskConfig(_getActiveItem() || {}) || {};
        for (let i = 0; i < count; i++) {
            const bg = bgs[i % bgs.length];
            const cv = cvs[i % cvs.length];
            const name = `${_shortName(bg).replace(/\.[^.]+$/, '')}+${_shortName(cv).replace(/\.[^.]+$/, '').slice(0, 14)}`;
            _dcState.items.push(_defaultRow({ ...templateMask, bgPath: bg, contentVideoPath: cv, name }));
        }
        _selectRow(Math.max(0, _dcState.items.length - count));
        _notify(`✅ 已生成 ${count} 条「N对N」顺序配对任务`, 'success');
    }

    async function _resolveMediaDurationSec(filePath) {
        if (!filePath || _isVideoFile(filePath) === false) return 0;
        if (window.electronAPI?.getMediaDuration) {
            try {
                const d = await window.electronAPI.getMediaDuration(filePath);
                if (Number.isFinite(d) && d > 0) return d;
            } catch (_) {}
        }
        return 0;
    }

    async function _chooseOutputDirectory() {
        if (!window.electronAPI?.selectDirectory) return _dcState.outputDir || '';
        const dir = await window.electronAPI.selectDirectory();
        if (dir) {
            _dcState.outputDir = dir;
            _persistState();
            const lbl = document.getElementById('dc-export-dir-label');
            if (lbl) lbl.textContent = dir;
        }
        return _dcState.outputDir || '';
    }

    async function _exportSelectedToMp4() {
        if (_dcState.isExporting) return;
        const targets = _dcState.items.filter(it => it.checked && (it.bgPath || it.contentVideoPath));
        if (!targets.length) {
            _notify('请先勾选至少 1 条已选定素材的任务', 'warning');
            return;
        }

        let outDir = _dcState.outputDir || window.electronAPI?.readReelsOutputDirectory?.() || (await window.electronAPI?.getDownloadsPath?.()) || '';
        if (!outDir) outDir = await _chooseOutputDirectory();
        if (!outDir) {
            _notify('请选择导出输出文件夹', 'warning');
            return;
        }
        _dcState.outputDir = outDir;
        _persistState();

        const btn = document.getElementById('dc-export-mp4-btn');
        const statusEl = document.getElementById('dc-export-status');
        const openFolderBtn = document.getElementById('dc-open-outdir-btn');
        _dcState.isExporting = true;
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 正在导出...'; }

        const sep = outDir.includes('\\') ? '\\' : '/';
        const cleanOutDir = outDir.replace(/[\\/]$/, '');
        let okCount = 0;
        let failCount = 0;

        try {
            for (let idx = 0; idx < targets.length; idx++) {
                const item = targets[idx];
                item.status = 'running';
                item.statusText = '准备中...';
                _renderQueueList();

                try {
                    const bgDur = await _resolveMediaDurationSec(item.bgPath);
                    let cvDur = await _resolveMediaDurationSec(item.contentVideoPath);
                    if (cvDur > 0) {
                        const ts = parseFloat(item.contentVideoTrimStart);
                        const te = parseFloat(item.contentVideoTrimEnd);
                        if (Number.isFinite(ts) && Number.isFinite(te) && te > ts) cvDur = Math.min(cvDur, te) - Math.max(0, ts);
                        else if (Number.isFinite(ts) && ts > 0 && ts < cvDur) cvDur = cvDur - ts;
                        else if (Number.isFinite(te) && te > 0 && te < cvDur) cvDur = te;
                    }
                    const duration = (Number(item.customDuration) > 0)
                        ? Number(item.customDuration)
                        : Math.max(bgDur, cvDur, 6);

                    const safeName = (item.name || `dual_${idx + 1}`).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || `dual_${idx + 1}`;
                    const outputPath = `${cleanOutDir}${sep}${safeName}_dual.mp4`;
                    const maskCfg = _maskApi()?.extractMaskConfig(item) || {};
                    const params = {
                        style: {},
                        segments: [],
                        originalScript: '',
                        showSubtitle: false,
                        overlays: [],
                        overlayAboveSubtitle: true,
                        backgroundPath: item.bgPath || item.contentVideoPath,
                        bgMode: 'single',
                        bgScale: Number(item.bgScale) || 100,
                        bgVolume: (item.bgVideoVolume != null ? Number(item.bgVideoVolume) : 100) / 100,
                        bgHasAudio: Boolean(item.bgPath && _isVideoFile(item.bgPath)),
                        contentVideoPath: item.bgPath ? (item.contentVideoPath || null) : null,
                        contentVideoTrimStart: item.contentVideoTrimStart != null ? item.contentVideoTrimStart : null,
                        contentVideoTrimEnd: item.contentVideoTrimEnd != null ? item.contentVideoTrimEnd : null,
                        contentVideoVolume: (item.contentVideoVolume != null ? Number(item.contentVideoVolume) : 100) / 100,
                        contentVideoBlurBg: false,
                        contentVideoDirectBg: !item.bgPath && !!item.contentVideoPath,
                        ...maskCfg,
                        voicePath: null,
                        voiceVolume: 1.0,
                        bgmPath: '',
                        bgmVolume: 0,
                        outputPath,
                        targetWidth: 1080,
                        targetHeight: 1920,
                        fps: 30,
                        customDuration: duration,
                        qualityPreset: 'faster',
                        crf: 20,
                    };

                    const updatePct = (pct) => {
                        item.statusText = `${Math.round(pct || 0)}%`;
                        if (statusEl) statusEl.textContent = `正在导出 ${idx + 1}/${targets.length}: ${safeName} (${Math.round(pct || 0)}%)`;
                    };

                    if (window.electronAPI?.isolatedWysiwygExport) {
                        const requestId = `dc-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`;
                        const unsub = window.electronAPI.onIsolatedWysiwygProgress?.(requestId, data => updatePct(data?.pct));
                        try {
                            await window.electronAPI.isolatedWysiwygExport({ requestId, params });
                        } finally {
                            unsub?.();
                        }
                    } else if (typeof window.reelsWysiwygExport === 'function') {
                        const off = document.createElement('canvas');
                        off.width = 1080;
                        off.height = 1920;
                        await window.reelsWysiwygExport({ ...params, canvas: off, onProgress: updatePct, onLog: () => {} });
                    } else {
                        throw new Error('未找到可用的渲染导出引擎');
                    }

                    item.status = 'done';
                    item.statusText = '✅ 已导出';
                    okCount++;
                } catch (err) {
                    item.status = 'error';
                    item.statusText = `❌ ${err?.message || '失败'}`;
                    failCount++;
                    console.error('[DualCompositor] Export error:', err);
                }
                _renderQueueList();
            }

            if (openFolderBtn) openFolderBtn.style.display = okCount > 0 ? 'inline-flex' : 'none';
            if (statusEl) {
                statusEl.style.color = failCount ? '#fbbf24' : '#4ade80';
                statusEl.textContent = `导出完成：成功 ${okCount} 个${failCount ? `，失败 ${failCount} 个` : ''}（输出到 ${cleanOutDir}）`;
            }
            _notify(`🎬 双层拼接导出完成：成功 ${okCount} 个`, failCount ? 'warning' : 'success', 5000);
        } finally {
            _dcState.isExporting = false;
            if (btn) { btn.disabled = false; btn.textContent = '🚀 直接批量导出 MP4'; }
        }
    }

    function _sendSelectedToBatchReels() {
        const targets = _dcState.items.filter(it => it.checked && (it.bgPath || it.contentVideoPath));
        if (!targets.length) {
            _notify('请先勾选至少 1 条包含素材的拼接任务', 'warning');
            return;
        }
        if (typeof window.reelsReceiveDualCompositorTasks === 'function') {
            window.reelsReceiveDualCompositorTasks(targets);
        } else {
            _notify('批量 Reels 模块尚未初始化', 'error');
        }
    }

    function _buildRangeSliderRow(idPrefix, label, min, max, step, defVal) {
        return `
            <div style="display:flex;flex-direction:column;gap:3px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <label style="margin:0;font-size:11.5px;color:#cbd5e1;">${_esc(label)}</label>
                    <button type="button" class="dc-reset-field" data-prefix="${idPrefix}" data-def="${defVal}" title="重置" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:11px;padding:0 3px;">↺</button>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <input type="range" id="${idPrefix}-range" min="${min}" max="${max}" step="${step}" value="${defVal}" style="flex:1;accent-color:#38bdf8;">
                    <input type="number" id="${idPrefix}-num" min="${min}" max="${max}" step="${step}" value="${defVal}" style="width:54px;height:22px;padding:1px 4px;background:#090d16;border:1px solid #334155;border-radius:5px;color:#f8fafc;font-size:11px;">
                </div>
            </div>
        `;
    }

    function _bindCanvasGestures(canvas) {
        if (!canvas || canvas._dcGesturesBound) return;
        canvas._dcGesturesBound = true;

        canvas.addEventListener('pointerdown', (e) => {
            const item = _getActiveItem();
            if (!item || !item.contentVideoPath) return;
            const rect = canvas.getBoundingClientRect();
            const startX = item.contentVideoX && item.contentVideoX !== 'center' ? (parseFloat(item.contentVideoX) || 0) : 0;
            const startY = item.contentVideoY && item.contentVideoY !== 'center' ? (parseFloat(item.contentVideoY) || 0) : 0;
            _dcState.dragging = {
                pointerId: e.pointerId,
                clientX: e.clientX,
                clientY: e.clientY,
                startX,
                startY,
                scaleX: canvas.width / Math.max(1, rect.width),
                scaleY: canvas.height / Math.max(1, rect.height),
            };
            canvas.setPointerCapture?.(e.pointerId);
        });

        canvas.addEventListener('pointermove', (e) => {
            if (!_dcState.dragging) return;
            const item = _getActiveItem();
            if (!item) return;
            const d = _dcState.dragging;
            const dx = (e.clientX - d.clientX) * d.scaleX;
            const dy = (e.clientY - d.clientY) * d.scaleY;
            const nextX = Math.round(d.startX + dx);
            const nextY = Math.round(d.startY + dy);
            item.contentVideoX = nextX === 0 ? 'center' : String(nextX);
            item.contentVideoY = nextY === 0 ? 'center' : String(nextY);
            _syncInspectorFromItem();
            _drawStageFrame();
        });

        const endDrag = () => {
            if (!_dcState.dragging) return;
            _dcState.dragging = null;
            _persistState();
            _renderQueueList();
        };
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);

        canvas.addEventListener('wheel', (e) => {
            const item = _getActiveItem();
            if (!item || !item.contentVideoPath) return;
            e.preventDefault();
            const step = e.deltaY < 0 ? 4 : -4;
            item.contentVideoScale = Math.max(10, Math.min(350, Math.round((item.contentVideoScale || 100) + step)));
            _syncInspectorFromItem();
            _persistState();
            _drawStageFrame();
        }, { passive: false });

        canvas.addEventListener('dblclick', () => {
            const item = _getActiveItem();
            if (!item) return;
            item.contentVideoX = 'center';
            item.contentVideoY = 'center';
            _syncInspectorFromItem();
            _persistState();
            _renderQueueList();
            _drawStageFrame();
        });
    }

    function renderDualCompositorPanel() {
        const panel = document.getElementById('dual-composite-panel');
        if (!panel) return;
        const api = _maskApi();
        const shapesHtml = (api?.MASK_SHAPES || []).map(s => `<option value="${_esc(s.id)}">${_esc(s.label)}</option>`).join('');
        const blendsHtml = (api?.BLEND_MODES || []).map(b => `<option value="${_esc(b.id)}">${_esc(b.label)}</option>`).join('');
        const presetsHtml = (api?.MASK_LAYOUT_PRESETS || []).map(p =>
            `<button type="button" class="dc-preset-btn" data-preset="${_esc(p.id)}" title="${_esc(p.desc)}" style="padding:5px 7px;font-size:11px;border-radius:6px;border:1px solid rgba(148,163,184,0.28);background:rgba(30,41,59,0.75);color:#e2e8f0;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(p.name)}</button>`
        ).join('');

        panel.innerHTML = `
            <div style="display:flex;height:100%;width:100%;overflow:hidden;background:var(--bg-primary,#090d16);color:#e2e8f0;">
                <!-- 左栏：批量配对列表 -->
                <aside style="width:310px;min-width:280px;display:flex;flex-direction:column;border-right:1px solid var(--border-color);background:var(--bg-secondary,#0f172a);">
                    <div style="padding:10px 12px;border-bottom:1px solid var(--border-color);display:flex;flex-direction:column;gap:8px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                            <span style="font-size:14px;font-weight:800;color:#f8fafc;">🧩 双层拼接队列</span>
                            <span id="dc-queue-count" style="font-size:11px;color:#94a3b8;">共 0 条</span>
                        </div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                            <button type="button" id="dc-pair-1vn-btn" title="选 1 个前景 + 多选背景，一键生成 1对N 批量任务" style="padding:6px 8px;font-size:11.5px;font-weight:700;border-radius:6px;border:1px solid #38bdf8;background:rgba(14,165,233,0.2);color:#bae6fd;cursor:pointer;">🔗 1 对 N (多背景)</button>
                            <button type="button" id="dc-pair-nvn-btn" title="多选背景 + 多选前景，按顺序一一配对" style="padding:6px 8px;font-size:11.5px;font-weight:700;border-radius:6px;border:1px solid #a78bfa;background:rgba(139,92,246,0.2);color:#ddd6fe;cursor:pointer;">🎞️ N 对 N 配对</button>
                            <button type="button" id="dc-pair-folder-btn" title="选一个背景文件夹 × 当前前景一键配对" style="padding:5px 8px;font-size:11px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">📁 文件夹配前景</button>
                            <button type="button" id="dc-add-row-btn" style="padding:5px 8px;font-size:11px;border-radius:6px;border:1px solid #10b981;background:rgba(16,185,129,0.16);color:#6ee7b7;font-weight:600;cursor:pointer;">➕ 加空白行</button>
                        </div>
                        <div style="display:flex;gap:6px;">
                            <button type="button" id="dc-apply-mask-all-btn" style="flex:1;padding:4px 8px;font-size:11px;border-radius:6px;border:1px solid rgba(251,191,36,0.45);background:rgba(245,158,11,0.14);color:#fde68a;cursor:pointer;">📋 遮罩同步到全部勾选</button>
                            <button type="button" id="dc-clear-all-btn" style="padding:4px 8px;font-size:11px;border-radius:6px;border:1px solid rgba(239,68,68,0.38);background:rgba(239,68,68,0.12);color:#fca5a5;cursor:pointer;">🗑 清空</button>
                        </div>
                    </div>
                    <div id="dc-queue-list" style="flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;"></div>
                </aside>

                <!-- 中栏：9:16 交互预览画布 + 导出与送入 Reels -->
                <main style="flex:1;min-width:340px;display:flex;flex-direction:column;overflow:hidden;">
                    <div style="padding:10px 14px;border-bottom:1px solid var(--border-color);background:rgba(15,23,42,0.8);display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
                        <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                            <button type="button" id="dc-pick-outdir-btn" style="padding:5px 10px;font-size:11px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">📂 导出目录</button>
                            <span id="dc-export-dir-label" style="font-size:11px;color:#94a3b8;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(_dcState.outputDir || '未选目录（导出时提示选择）')}</span>
                            <button type="button" id="dc-open-outdir-btn" style="display:none;padding:5px 10px;font-size:11px;border-radius:6px;border:1px solid #10b981;background:rgba(16,185,129,0.2);color:#6ee7b7;cursor:pointer;">📂 打开成品目录</button>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                            <button type="button" id="dc-send-reels-btn" style="padding:7px 14px;font-size:12px;font-weight:700;border-radius:7px;border:none;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;cursor:pointer;">🎬 送入「批量Reels」加字幕</button>
                            <button type="button" id="dc-export-mp4-btn" style="padding:7px 14px;font-size:12px;font-weight:700;border-radius:7px;border:none;background:linear-gradient(135deg,#10b981,#059669);color:#fff;cursor:pointer;">🚀 直接批量导出 MP4</button>
                        </div>
                    </div>

                    <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:12px;background:radial-gradient(circle at center,#111827 0%,#050811 100%);position:relative;">
                        <canvas id="dc-preview-canvas" width="1080" height="1920" title="左键拖动前景位置 · 滚轮放大缩小 · 双击恢复居中" style="height:100%;max-height:100%;width:auto;max-width:100%;aspect-ratio:9/16;border-radius:12px;background:#070b14;box-shadow:0 20px 60px rgba(0,0,0,0.85);cursor:grab;"></canvas>
                    </div>

                    <div style="padding:8px 14px;border-top:1px solid var(--border-color);background:#0b1120;display:flex;flex-direction:column;gap:6px;">
                        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                            <button type="button" id="dc-play-btn" style="padding:5px 14px;font-size:12px;font-weight:700;border-radius:6px;border:1px solid #38bdf8;background:rgba(14,165,233,0.22);color:#bae6fd;cursor:pointer;">▶ 播放</button>
                            <input type="range" id="dc-scrub" min="0" max="8" step="0.04" value="0" style="flex:1;min-width:140px;accent-color:#38bdf8;">
                            <span id="dc-time-label" style="font-size:11px;font-family:monospace;color:#cbd5e1;min-width:86px;text-align:right;">0.0s / 8.0s</span>
                            <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#cbd5e1;cursor:pointer;">
                                <input type="checkbox" id="dc-guide-toggle" ${_dcState.showGuide ? 'checked' : ''} style="accent-color:#38bdf8;"> 虚线位置框
                            </label>
                            <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#cbd5e1;cursor:pointer;">
                                <input type="checkbox" id="dc-audio-toggle" ${!_dcState.previewMuted ? 'checked' : ''} style="accent-color:#10b981;"> 试听声音
                            </label>
                        </div>
                        <div id="dc-export-status" style="font-size:11px;color:#94a3b8;">💡 在画布中左键拖动可微调第二层前景位置，滚轮可放大缩小，双击恢复居中。</div>
                    </div>
                </main>

                <!-- 右栏：遮罩、羽化、混合模式与变换参数 -->
                <aside style="width:360px;min-width:320px;overflow-y:auto;padding:12px 14px;border-left:1px solid var(--border-color);background:var(--bg-secondary,#0f172a);display:flex;flex-direction:column;gap:12px;">
                    <div>
                        <div style="font-size:12.5px;font-weight:800;color:#fbbf24;margin-bottom:6px;">⚡ 一键溶图版式预设</div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">${presetsHtml}</div>
                    </div>

                    <details open style="border:1px solid rgba(56,189,248,0.3);border-radius:8px;padding:8px 10px;background:rgba(15,23,42,0.65);">
                        <summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:#7dd3fc;">🎭 1. 遮罩形状与四边羽化</summary>
                        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
                            <div style="display:flex;flex-direction:column;gap:3px;">
                                <label style="margin:0;font-size:11.5px;color:#cbd5e1;">遮罩形状:</label>
                                <select id="dc-in-shape" style="height:28px;background:#090d16;border:1px solid #334155;border-radius:6px;color:#f8fafc;font-size:11.5px;padding:2px 6px;">${shapesHtml}</select>
                            </div>
                            ${_buildRangeSliderRow('dc-in-feather-left', '左边缘羽化 (%)', 0, 100, 1, 0)}
                            ${_buildRangeSliderRow('dc-in-feather-right', '右边缘羽化 (%)', 0, 100, 1, 0)}
                            ${_buildRangeSliderRow('dc-in-feather-top', '上边缘羽化 (%)', 0, 100, 1, 0)}
                            ${_buildRangeSliderRow('dc-in-feather-bottom', '下边缘羽化 (%)', 0, 100, 1, 0)}
                            ${_buildRangeSliderRow('dc-in-softness', '形状整体边缘柔度 (%)', 0, 100, 1, 0)}
                            ${_buildRangeSliderRow('dc-in-radius', '圆角 / 中心镂空半径 (%)', 0, 50, 1, 0)}
                            <label style="display:flex;align-items:center;gap:6px;font-size:11.5px;color:#e2e8f0;cursor:pointer;margin-top:2px;">
                                <input type="checkbox" id="dc-in-invert" style="accent-color:#38bdf8;"> 🔄 反转遮罩 (镂空前景中间透出底图)
                            </label>
                        </div>
                    </details>

                    <details open style="border:1px solid rgba(167,139,250,0.3);border-radius:8px;padding:8px 10px;background:rgba(15,23,42,0.65);">
                        <summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:#ddd6fe;">✨ 2. 混合模式与透明度 (去黑底/雾气/叠加)</summary>
                        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
                            <div style="display:flex;flex-direction:column;gap:3px;">
                                <label style="margin:0;font-size:11.5px;color:#cbd5e1;">混合模式:</label>
                                <select id="dc-in-blend" style="height:28px;background:#090d16;border:1px solid #334155;border-radius:6px;color:#f8fafc;font-size:11.5px;padding:2px 6px;">${blendsHtml}</select>
                            </div>
                            ${_buildRangeSliderRow('dc-in-opacity', '前景不透明度 (%)', 0, 100, 1, 100)}
                        </div>
                    </details>

                    <details open style="border:1px solid rgba(148,163,184,0.22);border-radius:8px;padding:8px 10px;background:rgba(15,23,42,0.65);">
                        <summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:#e2e8f0;">📐 3. 前景位置、缩放、裁剪与音量</summary>
                        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
                            ${_buildRangeSliderRow('dc-in-scale', '前景大小缩放 (%)', 10, 350, 1, 100)}
                            <div style="display:flex;flex-direction:column;gap:3px;">
                                <label style="margin:0;font-size:11.5px;color:#cbd5e1;">X / Y 偏移 (px) & 快捷停靠:</label>
                                <div style="display:grid;grid-template-columns:1fr 60px;gap:6px;align-items:center;">
                                    <input type="range" id="dc-in-x-range" min="-540" max="540" step="1" value="0" style="accent-color:#38bdf8;">
                                    <input type="number" id="dc-in-x-num" min="-1080" max="1080" step="1" value="0" style="height:22px;padding:1px 4px;background:#090d16;border:1px solid #334155;border-radius:5px;color:#f8fafc;font-size:11px;">
                                    <input type="range" id="dc-in-y-range" min="-960" max="960" step="1" value="0" style="accent-color:#38bdf8;">
                                    <input type="number" id="dc-in-y-num" min="-1920" max="1920" step="1" value="0" style="height:22px;padding:1px 4px;background:#090d16;border:1px solid #334155;border-radius:5px;color:#f8fafc;font-size:11px;">
                                </div>
                                <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:2px;">
                                    <button type="button" class="dc-pos-quick" data-x="-185" data-y="-390" style="padding:2px 6px;font-size:10px;border-radius:4px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">↖️ 左上</button>
                                    <button type="button" class="dc-pos-quick" data-x="0" data-y="-390" style="padding:2px 6px;font-size:10px;border-radius:4px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">⬆️ 上半</button>
                                    <button type="button" class="dc-pos-quick" data-x="185" data-y="-390" style="padding:2px 6px;font-size:10px;border-radius:4px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">↗️ 右上</button>
                                    <button type="button" class="dc-pos-quick" data-x="0" data-y="0" style="padding:2px 6px;font-size:10px;border-radius:4px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">⏺ 居中</button>
                                    <button type="button" class="dc-pos-quick" data-x="0" data-y="390" style="padding:2px 6px;font-size:10px;border-radius:4px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">⬇️ 下半</button>
                                </div>
                            </div>
                            ${_buildRangeSliderRow('dc-in-rotate', '前景旋转角度 (°)', -180, 180, 1, 0)}
                            <div style="display:flex;gap:14px;font-size:11.5px;">
                                <label style="display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" id="dc-in-fliph"> 左右翻转</label>
                                <label style="display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" id="dc-in-flipv"> 上下翻转</label>
                            </div>
                            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
                                <label style="font-size:10.5px;color:#94a3b8;">起(s)<input type="number" id="dc-in-trim-start" min="0" step="0.1" placeholder="0" style="width:100%;height:22px;margin-top:2px;background:#090d16;border:1px solid #334155;border-radius:4px;color:#f8fafc;font-size:11px;padding:1px 4px;"></label>
                                <label style="font-size:10.5px;color:#94a3b8;">止(s)<input type="number" id="dc-in-trim-end" min="0" step="0.1" placeholder="自动" style="width:100%;height:22px;margin-top:2px;background:#090d16;border:1px solid #334155;border-radius:4px;color:#f8fafc;font-size:11px;padding:1px 4px;"></label>
                                <label style="font-size:10.5px;color:#94a3b8;">时长(s)<input type="number" id="dc-in-duration" min="1" step="0.5" placeholder="自动" style="width:100%;height:22px;margin-top:2px;background:#090d16;border:1px solid #334155;border-radius:4px;color:#f8fafc;font-size:11px;padding:1px 4px;"></label>
                            </div>
                            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;">
                                <label style="font-size:10px;color:#94a3b8;">裁左%<input type="number" id="dc-in-crop-l" min="0" max="99" value="0" style="width:100%;height:21px;background:#090d16;border:1px solid #334155;border-radius:4px;color:#f8fafc;font-size:10.5px;padding:1px 3px;"></label>
                                <label style="font-size:10px;color:#94a3b8;">裁上%<input type="number" id="dc-in-crop-t" min="0" max="99" value="0" style="width:100%;height:21px;background:#090d16;border:1px solid #334155;border-radius:4px;color:#f8fafc;font-size:10.5px;padding:1px 3px;"></label>
                                <label style="font-size:10px;color:#94a3b8;">宽%<input type="number" id="dc-in-crop-w" min="1" max="100" value="100" style="width:100%;height:21px;background:#090d16;border:1px solid #334155;border-radius:4px;color:#f8fafc;font-size:10.5px;padding:1px 3px;"></label>
                                <label style="font-size:10px;color:#94a3b8;">高%<input type="number" id="dc-in-crop-h" min="1" max="100" value="100" style="width:100%;height:21px;background:#090d16;border:1px solid #334155;border-radius:4px;color:#f8fafc;font-size:10.5px;padding:1px 3px;"></label>
                            </div>
                            ${_buildRangeSliderRow('dc-in-cv-vol', '前景视频音量 (%)', 0, 200, 1, 100)}
                            ${_buildRangeSliderRow('dc-in-bg-vol', '底层背景音量 (%)', 0, 200, 1, 100)}
                            ${_buildRangeSliderRow('dc-in-bg-scale', '底层背景缩放 (%)', 50, 300, 1, 100)}
                        </div>
                    </details>
                </aside>
            </div>
        `;

        // ── Bind Left Queue Controls ──
        panel.querySelector('#dc-pair-1vn-btn')?.addEventListener('click', () => _buildOneToManyBatch(false));
        panel.querySelector('#dc-pair-folder-btn')?.addEventListener('click', () => _buildOneToManyBatch(true));
        panel.querySelector('#dc-pair-nvn-btn')?.addEventListener('click', () => _buildManyToManyBatch());
        panel.querySelector('#dc-add-row-btn')?.addEventListener('click', () => {
            const tpl = _maskApi()?.extractMaskConfig(_getActiveItem() || {}) || {};
            _dcState.items.push(_defaultRow({ ...tpl, name: `拼接_${_dcState.items.length + 1}` }));
            _selectRow(_dcState.items.length - 1);
        });
        panel.querySelector('#dc-clear-all-btn')?.addEventListener('click', () => {
            if (_dcState.items.length > 0 && !confirm('确定清空双层拼接队列吗？')) return;
            _dcState.items = [];
            _selectRow(-1);
        });
        panel.querySelector('#dc-apply-mask-all-btn')?.addEventListener('click', () => {
            const active = _getActiveItem();
            if (!active) return;
            const cfg = _maskApi()?.extractMaskConfig(active) || {};
            let n = 0;
            for (const it of _dcState.items) {
                if (it && it.checked && it !== active) {
                    Object.assign(it, cfg, { bgScale: active.bgScale, bgVideoVolume: active.bgVideoVolume, contentVideoVolume: active.contentVideoVolume });
                    n++;
                }
            }
            _persistState();
            _renderQueueList();
            _notify(`📋 已将当前遮罩与混合参数同步到其余 ${n} 条勾选任务`, 'success');
        });

        // ── Bind Stage & Export Controls ──
        _bindCanvasGestures(panel.querySelector('#dc-preview-canvas'));
        panel.querySelector('#dc-play-btn')?.addEventListener('click', () => _setPlaying(!_dcState.isPlaying));
        panel.querySelector('#dc-scrub')?.addEventListener('input', (e) => {
            _setPlaying(false);
            _dcState.currentTime = parseFloat(e.target.value) || 0;
            const item = _getActiveItem();
            if (_dcState.bgEl?.tagName === 'VIDEO') _seekVideoSafe(_dcState.bgEl, _computeLayerSourceTime(_dcState.currentTime, _dcState.bgEl, item, false));
            if (_dcState.cvEl?.tagName === 'VIDEO') _seekVideoSafe(_dcState.cvEl, _computeLayerSourceTime(_dcState.currentTime, _dcState.cvEl, item, true));
            _updateTimeReadout();
            _drawStageFrame();
        });
        panel.querySelector('#dc-guide-toggle')?.addEventListener('change', (e) => {
            _dcState.showGuide = !!e.target.checked;
            _persistState();
            _drawStageFrame();
        });
        panel.querySelector('#dc-audio-toggle')?.addEventListener('change', (e) => {
            _dcState.previewMuted = !e.target.checked;
            _syncMediaVolumeAndMute();
        });
        panel.querySelector('#dc-pick-outdir-btn')?.addEventListener('click', () => _chooseOutputDirectory());
        panel.querySelector('#dc-open-outdir-btn')?.addEventListener('click', () => {
            if (_dcState.outputDir && window.electronAPI?.openFolder) {
                window.electronAPI.openFolder(_dcState.outputDir);
            }
        });
        panel.querySelector('#dc-export-mp4-btn')?.addEventListener('click', () => _exportSelectedToMp4());
        panel.querySelector('#dc-send-reels-btn')?.addEventListener('click', () => _sendSelectedToBatchReels());

        // ── Bind Right Inspector ──
        panel.querySelectorAll('.dc-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => _applyMaskPresetToSelected(btn.dataset.preset));
        });
        panel.querySelector('#dc-in-shape')?.addEventListener('change', (e) => {
            _updateActiveItemField(it => { it.contentVideoMaskShape = e.target.value; }, { refreshList: true });
        });
        panel.querySelector('#dc-in-blend')?.addEventListener('change', (e) => {
            _updateActiveItemField(it => { it.contentVideoBlendMode = e.target.value; }, { refreshList: true });
        });
        panel.querySelector('#dc-in-invert')?.addEventListener('change', (e) => {
            _updateActiveItemField(it => { it.contentVideoMaskInvert = !!e.target.checked; });
        });
        panel.querySelector('#dc-in-fliph')?.addEventListener('change', (e) => {
            _updateActiveItemField(it => { it.contentVideoFlipH = !!e.target.checked; });
        });
        panel.querySelector('#dc-in-flipv')?.addEventListener('change', (e) => {
            _updateActiveItemField(it => { it.contentVideoFlipV = !!e.target.checked; });
        });
        panel.querySelector('#dc-in-x-range')?.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value) || 0;
            const num = panel.querySelector('#dc-in-x-num');
            if (num) num.value = v;
            _updateActiveItemField(it => { it.contentVideoX = v === 0 ? 'center' : String(v); });
        });
        panel.querySelector('#dc-in-x-num')?.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value) || 0;
            const r = panel.querySelector('#dc-in-x-range');
            if (r) r.value = Math.max(-540, Math.min(540, v));
            _updateActiveItemField(it => { it.contentVideoX = v === 0 ? 'center' : String(v); });
        });
        panel.querySelector('#dc-in-y-range')?.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value) || 0;
            const num = panel.querySelector('#dc-in-y-num');
            if (num) num.value = v;
            _updateActiveItemField(it => { it.contentVideoY = v === 0 ? 'center' : String(v); });
        });
        panel.querySelector('#dc-in-y-num')?.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value) || 0;
            const r = panel.querySelector('#dc-in-y-range');
            if (r) r.value = Math.max(-960, Math.min(960, v));
            _updateActiveItemField(it => { it.contentVideoY = v === 0 ? 'center' : String(v); });
        });
        panel.querySelectorAll('.dc-pos-quick').forEach(btn => {
            btn.addEventListener('click', () => {
                const vx = parseFloat(btn.dataset.x) || 0;
                const vy = parseFloat(btn.dataset.y) || 0;
                _updateActiveItemField(it => {
                    it.contentVideoX = vx === 0 ? 'center' : String(vx);
                    it.contentVideoY = vy === 0 ? 'center' : String(vy);
                }, { refreshList: true });
                _syncInspectorFromItem();
            });
        });

        for (const [idPrefix, field, defVal] of _INSPECTOR_NUMERIC_FIELDS) {
            const r = panel.querySelector(`#${idPrefix}-range`);
            const n = panel.querySelector(`#${idPrefix}-num`);
            r?.addEventListener('input', () => {
                const v = parseFloat(r.value);
                if (n) n.value = r.value;
                _updateActiveItemField(it => { it[field] = Number.isFinite(v) ? v : defVal; }, { refreshList: field === 'contentVideoScale' || field.startsWith('contentVideoMaskFeather') });
            });
            n?.addEventListener('input', () => {
                const v = parseFloat(n.value);
                if (r) r.value = n.value;
                _updateActiveItemField(it => { it[field] = Number.isFinite(v) ? v : defVal; }, { refreshList: field === 'contentVideoScale' || field.startsWith('contentVideoMaskFeather') });
            });
        }
        panel.querySelectorAll('.dc-reset-field').forEach(btn => {
            btn.addEventListener('click', () => {
                const pfx = btn.dataset.prefix;
                const def = parseFloat(btn.dataset.def) || 0;
                const spec = _INSPECTOR_NUMERIC_FIELDS.find(s => s[0] === pfx);
                if (!spec) return;
                const r = panel.querySelector(`#${pfx}-range`);
                const n = panel.querySelector(`#${pfx}-num`);
                if (r) r.value = def;
                if (n) n.value = def;
                _updateActiveItemField(it => { it[spec[1]] = def; }, { refreshList: true });
            });
        });

        const onTrimOrDurChange = () => {
            const ts = panel.querySelector('#dc-in-trim-start')?.value.trim();
            const te = panel.querySelector('#dc-in-trim-end')?.value.trim();
            const dur = panel.querySelector('#dc-in-duration')?.value.trim();
            _updateActiveItemField(it => {
                it.contentVideoTrimStart = ts === '' ? null : parseFloat(ts);
                it.contentVideoTrimEnd = te === '' ? null : parseFloat(te);
                it.customDuration = dur === '' ? 0 : (parseFloat(dur) || 0);
            });
            _recomputePreviewDuration();
        };
        panel.querySelector('#dc-in-trim-start')?.addEventListener('input', onTrimOrDurChange);
        panel.querySelector('#dc-in-trim-end')?.addEventListener('input', onTrimOrDurChange);
        panel.querySelector('#dc-in-duration')?.addEventListener('input', onTrimOrDurChange);

        const onCropChange = () => {
            const cl = parseFloat(panel.querySelector('#dc-in-crop-l')?.value) || 0;
            const ct = parseFloat(panel.querySelector('#dc-in-crop-t')?.value) || 0;
            const cw = parseFloat(panel.querySelector('#dc-in-crop-w')?.value) || 100;
            const ch = parseFloat(panel.querySelector('#dc-in-crop-h')?.value) || 100;
            _updateActiveItemField(it => {
                it.contentVideoCrop = (cl !== 0 || ct !== 0 || cw !== 100 || ch !== 100) ? `${cl},${ct},${cw},${ch}` : '';
            });
        };
        for (const cid of ['dc-in-crop-l', 'dc-in-crop-t', 'dc-in-crop-w', 'dc-in-crop-h']) {
            panel.querySelector(`#${cid}`)?.addEventListener('input', onCropChange);
        }

        _renderQueueList();
        _syncMediaElementsForSelection();
        _syncInspectorFromItem();
        _drawStageFrame();
    }

    function openWithTask(task) {
        initDualCompositorPanel();
        if (task && typeof task === 'object') {
            const row = _defaultRow({
                ...task,
                name: task.exportName || task.baseName || task.fileName || 'Reels双层任务',
            });
            _dcState.items.push(row);
            _selectRow(_dcState.items.length - 1);
        }
        if (typeof window.openPanelByName === 'function') {
            window.openPanelByName('dual-composite');
        }
    }

    function initDualCompositorPanel() {
        if (!_dcState.initialized) {
            _dcState.initialized = true;
            _loadSavedState();
            renderDualCompositorPanel();
        }
    }

    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => {
            initDualCompositorPanel();
        });
        document.addEventListener('click', (e) => {
            if (e.target.closest?.('.tab[data-tab="dual-composite"]')) {
                initDualCompositorPanel();
                _syncMediaElementsForSelection();
                _drawStageFrame();
            } else if (e.target.closest?.('.tab[data-tab]') && !e.target.closest?.('.tab[data-tab="dual-composite"]')) {
                _setPlaying(false);
            }
        });
    }

    const api = {
        init: initDualCompositorPanel,
        openWithTask,
        getState: () => _dcState,
        selectRow: _selectRow,
        applyPreset: _applyMaskPresetToSelected,
        sendToBatchReels: _sendSelectedToBatchReels,
        exportSelected: _exportSelectedToMp4,
    };

    if (typeof window !== 'undefined') {
        window.ReelsDualCompositor = api;
        window.reelsEditActiveTaskInDualCompositor = () => {
            const idx = window._reelsState?.selectedIdx;
            const task = (idx >= 0 && window._reelsState?.tasks?.[idx]) ? window._reelsState.tasks[idx] : null;
            openWithTask(task);
        };
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
