/**
 * reels-timeline-editor.js — NLE 时间线编辑器 UI
 * 
 * 移植自 AutoSub_v8 TimelineWidget (PyQt6 QWidget → HTML Canvas)
 * 
 * 功能:
 *   - 多轨道显示 (视频/字幕/音频/图片/文本)
 *   - 时间刻度尺 + 播放头
 *   - 片段 (Clip) 拖拽、缩放、分割
 *   - 缩放/平移 (Ctrl+滚轮 / 水平滚动)
 *   - 轨道操作 (锁定/可见/批量开关)
 *   - 域分离线 (Visual ↕ Audio)
 */

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

const TL_TRACK_HEIGHT = 38;
const TL_HEADER_W = 140;
const TL_RULER_H = 26;
const TL_HANDLE_W = 6;
const TL_MIN_CLIP_W = 4;
const TL_COLORS = {
    bg: '#181818',
    ruler: '#0f0f1e',
    rulerText: '#8899aa',
    playhead: '#FF4444',
    gridMajor: 'rgba(255,255,255,0.08)',
    gridMinor: 'rgba(255,255,255,0.03)',
    headerBg: '#141414',
    headerBorder: 'rgba(255,255,255,0.08)',
    domainSep: '#FF6B6B',
    trackTypes: {
        video: '#3366FF',
        asr: '#06b6d4',
        script: '#8b5cf6',
        subs: '#f59e0b',
        text: '#FF66CC',
        image: '#44CC88',
        audio: '#38bdf8',
        overlay: '#a855f7',
    },
    selected: '#4c9eff',
    clipBg: 'rgba(255,255,255,0.1)',
};

/**
 * 智能分词与折行排版（西文按空格/标点单词分词，中文按字符分词），最大化在有限宽度内展示完整字幕
 */
function _layoutClipLines(ctx, text, maxW, maxLines = 2) {
    if (!text || maxW < 10) return [];
    if (ctx.measureText(text).width <= maxW) return [text];

    const isCJK = /[\u4e00-\u9fff]/.test(text);
    const tokens = isCJK ? text.split('') : text.split(/(\s+)/).filter(Boolean);
    const lines = [];
    let curLine = '';

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const testLine = curLine + token;
        if (ctx.measureText(testLine).width > maxW && curLine.trim()) {
            lines.push(curLine.trim());
            curLine = token.trim();
            if (lines.length >= maxLines - 1) {
                const remaining = tokens.slice(i).join('').trim();
                let lastLine = remaining;
                while (lastLine && ctx.measureText(lastLine + '…').width > maxW) {
                    lastLine = lastLine.slice(0, -1);
                }
                lines.push((lastLine ? lastLine : '') + '…');
                return lines;
            }
        } else {
            curLine = testLine;
        }
    }
    if (curLine.trim()) lines.push(curLine.trim());
    return lines;
}

class ReelsTimelineEditor {
    constructor(containerEl) {
        this.container = containerEl;

        // Canvas
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'rte-canvas';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');

        // 浮动全文字幕气泡卡片
        this._tooltipEl = null;

        // 数据
        this._duration = 10;          // 总时长 (秒)
        // 时间线使用导出器相同的帧率。把鼠标坐标收敛到帧边界，避免预览媒体
        // 实际只能落在某一帧、而红色播放头停在相邻小数位置的错位感。
        this._frameRate = 30;
        this._tracks = [];             // [{type, name, clips:[], locked, visible, ...}]
        this._playheadPos = 0;        // 播放头位置 (秒)

        // 视图状态
        this._scrollX = 0;
        this._scrollY = 0;
        this._pxPerSec = 80;          // 缩放
        this._autoFitDuration = true; // 任务加载时默认显示完整时长
        this._hasManualTimelineView = false; // 拖动片段后固定当前时间尺比例
        this._timelineTaskKey = null;
        this._selectedClip = null;    // {trackIdx, clipIdx}
        this._selectedClips = new Set(); // 多选键: "trackIdx:clipIdx"
        this._selectionAnchor = null; // Shift 连选起点
        this._hoveredClip = null;
        this._hoveredZone = null;

        // 拖拽状态
        this._drag = null;            // {type: 'move'|'trim_start'|'trim_end'|'cut_in'|'cut_out'|'playhead', ...}
        this._bladeTool = false;      // 达芬奇式切刀：点片段的任意位置即可切分
        this._bladeHoverX = null;

        // 回调
        this.onSeek = null;           // (timeSec) => {}
        this.onClipSelect = null;     // (trackIdx, clipIdx, clip) => {}
        this.onClipChange = null;     // (trackIdx, clipIdx, clip) => {}
        this.onClipDblClick = null;   // (trackIdx, clipIdx, clip, rect) => {}
        // 可由业务层为不同类型片段追加右键操作；返回菜单项数组。
        this.onClipContextMenu = null; // (trackIdx, clipIdx, clip) => [{icon,text,action,danger?}]
        this.onClipSplit = null;       // (trackIdx, clipIdx, clip, timeSec) => boolean（业务自行处理）
        this.onClipDelete = null;      // (trackIdx, clipIdx, clip) => boolean（业务自行处理）
        this.onTrackOrderChange = null; // (trackIdx, direction, track) => {}
        // 一个鼠标拖动是一笔编辑事务，而不是数百条 mousemove 历史。
        this.onEditStart = null;      // ({ type, trackIdx, clipIdx, clip }) => {}
        this.onEditEnd = null;        // ({ type, trackIdx, clipIdx, clip }) => {}

        // 浮动编辑器
        this._editingPopup = null;
        this._lastClickTime = 0;
        this._lastClickClip = null;

        this._init();
    }

    _init() {
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

        Object.assign(this.canvas.style, {
            width: '100%', height: '100%', display: 'block', cursor: 'default'
        });
        this.canvas.tabIndex = 0;

        // 浮动全文字幕气泡卡片 (Hover Popover Card)
        this._tooltipEl = document.createElement('div');
        this._tooltipEl.className = 'rte-floating-tooltip';
        Object.assign(this._tooltipEl.style, {
            position: 'absolute',
            pointerEvents: 'none',
            zIndex: '99999',
            opacity: '0',
            background: 'rgba(15, 23, 42, 0.96)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid rgba(255, 255, 255, 0.18)',
            boxShadow: '0 12px 30px -4px rgba(0, 0, 0, 0.65), 0 4px 12px rgba(0,0,0,0.4)',
            borderRadius: '8px',
            padding: '10px 14px',
            color: '#f8fafc',
            fontSize: '12px',
            maxWidth: '380px',
            minWidth: '200px',
            lineHeight: '1.5',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            transition: 'opacity 0.12s ease',
        });
        this.container.appendChild(this._tooltipEl);

        // 事件
        this.canvas.addEventListener('mousedown', (e) => {
            this.canvas.focus({ preventScroll: true });
            this._onMouseDown(e);
        });
        this.canvas.addEventListener('keydown', (e) => this._onKeyDown(e));
        
        // 绑定到 window 以防止鼠标移出画布后拖拽断开/卡住
        this._boundMouseMove = (e) => this._onMouseMove(e);
        this._boundMouseUp = (e) => this._onMouseUp(e);
        window.addEventListener('mousemove', this._boundMouseMove);
        window.addEventListener('mouseup', this._boundMouseUp);
        
        this.canvas.addEventListener('mouseleave', () => {
            this._hoveredClip = null;
            this._hoveredZone = null;
            this._hideTooltip();
            this._render();
        });

        this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this._onContextMenu(e);
        });

        // 点击画布其他区域时关闭编辑器
        this._boundDocMouseDown = (e) => {
            if (this._rtEditor && this._rtEditor.popup && !this._rtEditor.popup.contains(e.target) && e.target !== this.canvas) {
                this._rtEditor.close(true);
            }
        };
        document.addEventListener('mousedown', this._boundDocMouseDown);

        // 尺寸
        this._resize();
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(this.container);

        this._renderLoop();
    }

    destroy() {
        this._destroyed = true;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this._boundMouseMove) window.removeEventListener('mousemove', this._boundMouseMove);
        if (this._boundMouseUp) window.removeEventListener('mouseup', this._boundMouseUp);
        if (this._boundDocMouseDown) document.removeEventListener('mousedown', this._boundDocMouseDown);
        if (this._ro) {
            this._ro.disconnect();
            this._ro = null;
        }
        if (this._tooltipEl && this._tooltipEl.parentNode) {
            this._tooltipEl.parentNode.removeChild(this._tooltipEl);
            this._tooltipEl = null;
        }
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this._tracks = [];
    }

    _resize() {
        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.floor(rect.width) * dpr;
        this.canvas.height = Math.floor(rect.height) * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._canvasW = Math.floor(rect.width);
        this._canvasH = Math.floor(rect.height);
        if (this._autoFitDuration) this._fitDurationToViewport();
    }

    // ═══════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════

    setDuration(dur, options = {}) {
        const fit = options.fit === true;
        this._duration = Math.max(1, dur);
        // 只有切换任务或用户主动要求时才重新适应窗口。
        // 字幕拖动会让预览重新上报时长，不能因此反复改变刻度尺缩放。
        if (fit) {
            this._autoFitDuration = true;
            this._hasManualTimelineView = false;
            this._scrollX = 0;
            this._fitDurationToViewport();
        } else if (this._autoFitDuration && !this._hasManualTimelineView) {
            this._fitDurationToViewport();
        }
    }

    setFrameRate(fps) {
        const next = Number(fps);
        if (Number.isFinite(next) && next >= 1 && next <= 240) this._frameRate = next;
    }

    _snapToFrame(timeSec) {
        const frameRate = this._frameRate || 30;
        return Math.round(timeSec * frameRate) / frameRate;
    }

    _fitDurationToViewport() {
        if (!this._canvasW || !this._duration) return;
        // 右侧留出少量余量，避免最后一个刻度文字和播放头被裁切。
        const availableWidth = Math.max(1, this._canvasW - TL_HEADER_W - 24);
        this._pxPerSec = Math.max(0.1, Math.min(1000, availableWidth / this._duration));
    }

    setPlayhead(timeSec, options = {}) {
        if (this._drag && this._drag.type === 'playhead') return;
        this._playheadPos = Math.max(0, Math.min(timeSec, this._duration));
        if (options.autoScroll !== false) {
            this.ensureTimeVisible(this._playheadPos);
        }
        if (options.render !== false) {
            this._render();
        }
    }

    ensureTimeVisible(timeSec) {
        if (!this._canvasW || !Number.isFinite(timeSec)) return;
        const availableW = Math.max(10, this._canvasW - TL_HEADER_W - 40);
        const x = TL_HEADER_W + timeSec * this._pxPerSec - this._scrollX;
        if (x < TL_HEADER_W + 10) {
            this._scrollX = Math.max(0, timeSec * this._pxPerSec - 20);
        } else if (x > this._canvasW - 20) {
            this._scrollX = Math.max(0, timeSec * this._pxPerSec - (availableW * 0.8));
        }
    }

    ensureClipVisible(clip) {
        if (!clip || !this._canvasW) return;
        const start = Number(clip.start) || 0;
        const end = Number(clip.end) || start;
        const availableW = Math.max(10, this._canvasW - TL_HEADER_W - 40);
        const startX = TL_HEADER_W + start * this._pxPerSec - this._scrollX;
        const endX = TL_HEADER_W + end * this._pxPerSec - this._scrollX;
        if (startX < TL_HEADER_W + 10 || endX > this._canvasW - 20) {
            const clipMidTime = start + (end - start) / 2;
            this._scrollX = Math.max(0, clipMidTime * this._pxPerSec - (availableW / 2));
            this._render();
        }
    }

    setTracks(tracks) {
        this._tracks = tracks;
        this._clearClipSelection();
        this._autoAdjustContainerHeight();
        this._resize();
        this._render();
    }

    moveTrack(trackIdx, direction) {
        const track = this._tracks[trackIdx];
        if (!track) return;
        const peers = this._tracks.map((item, index) => ({ item, index })).filter(item => item.item.domain === track.domain);
        const position = peers.findIndex(item => item.index === trackIdx);
        const target = peers[position + (direction === 'up' ? -1 : 1)];
        if (!target) return;
        [this._tracks[trackIdx], this._tracks[target.index]] = [this._tracks[target.index], this._tracks[trackIdx]];
        if (this.onTrackOrderChange) this.onTrackOrderChange(trackIdx, direction, track, target.item);
        this._render();
    }

    selectClip(trackIdx, clipIdx, options = {}) {
        if (!this._tracks[trackIdx]?.clips?.[clipIdx]) return;
        if (!options.keepExisting) {
            this._clearClipSelection();
        }
        const key = this._clipKey(trackIdx, clipIdx);
        this._selectedClips.add(key);
        this._selectedClip = { trackIdx, clipIdx };
        this._selectionAnchor = { trackIdx, clipIdx };
        if (options.render !== false) {
            this._render();
        }
    }

    _autoAdjustContainerHeight() {
        if (!this.container) return;
        const bodyEl = this.container.closest('.reels-timeline-body');
        if (!bodyEl || bodyEl.classList.contains('collapsed')) return;
        const trackCount = Array.isArray(this._tracks) ? this._tracks.length : 0;
        if (trackCount <= 0) return;
        const needed = TL_RULER_H + trackCount * (TL_TRACK_HEIGHT + 1) + 12;
        const targetHeight = Math.max(160, Math.min(500, needed));
        bodyEl.style.height = `${targetHeight}px`;
    }

    /**
     * 从 Timeline 数据模型设置轨道数据。
     */
    loadFromTimeline(timeline) {
        if (!timeline) return;
        const tracks = [];
        const allTracks = timeline.tracks || [];
        for (const t of allTracks) {
            const clips = (t.clips || []).map(c => ({
                start: c.start || 0,
                end: (c.start || 0) + (c.duration || c.effectiveDuration || 2),
                name: c.sourceId || c.label || '',
                color: TL_COLORS.trackTypes[t.type] || '#888',
            }));
            tracks.push({
                type: t.type || 'video',
                name: t.label || t.type || 'Track',
                clips,
                locked: t.locked || false,
                visible: t.visible !== false,
                domain: t.domain || 'visual',
            });
        }
        this._tracks = tracks;
        this._duration = Math.max(1, ...tracks.flatMap(t => t.clips.map(c => c.end)));
    }

    /**
     * 从 SRT segments 设置字幕轨道。
     */
    loadSubtitleTrack(segments) {
        if (!segments || !segments.length) {
            const existIdx = this._tracks.findIndex(t => t.type === 'subs');
            const track = { type: 'subs', name: '字幕', clips: [], locked: false, visible: true, domain: 'visual' };
            if (existIdx >= 0) this._tracks[existIdx] = track;
            else this._tracks.push(track);
            return;
        }
        const clips = segments.map((seg, i) => {
            const fullText = seg.edited_text || seg.text || seg.content || '';
            return {
                start: seg.start || 0,
                end: seg.end || 0,
                name: fullText.slice(0, 20) + (fullText.length > 20 ? '…' : ''),
                _fullText: fullText,
                color: TL_COLORS.trackTypes.subs,
                _segIdx: i,
                styled_ranges: seg.styled_ranges || null,
                style_override: seg.style_override || null,
            };
        });
        // 检查是否已有字幕轨
        const existIdx = this._tracks.findIndex(t => t.type === 'subs');
        const track = { type: 'subs', name: '字幕', clips, locked: false, visible: true, domain: 'visual' };
        if (existIdx >= 0) {
            this._tracks[existIdx] = track;
        } else {
            this._tracks.push(track);
        }
        this._duration = Math.max(this._duration, ...clips.map(c => c.end));
    }

    /**
     * 设置/更新背景轨道片段（用于预览时长与可视化）。
     */
    loadBackgroundTrack(durationSec, name = '背景') {
        const dur = Math.max(0, Number(durationSec) || 0);
        const clips = dur > 0 ? [{
            start: 0,
            end: dur,
            name,
            color: TL_COLORS.trackTypes.video,
        }] : [];
        const existIdx = this._tracks.findIndex(t => t.type === 'video');
        const track = { type: 'video', name: '视频', clips, locked: false, visible: true, domain: 'visual' };
        if (existIdx >= 0) this._tracks[existIdx] = track;
        else this._tracks.unshift(track);
        if (dur > 0) this._duration = Math.max(this._duration, dur);
    }

    /**
     * 设置/更新配音轨道片段。
     */
    loadAudioTrack(durationSec, name = '配音') {
        const dur = Math.max(0, Number(durationSec) || 0);
        const clips = dur > 0 ? [{
            start: 0,
            end: dur,
            name,
            color: TL_COLORS.trackTypes.audio,
        }] : [];
        const existIdx = this._tracks.findIndex(t => t.type === 'audio');
        const track = { type: 'audio', name: '音频', clips, locked: false, visible: true, domain: 'audio' };
        if (existIdx >= 0) this._tracks[existIdx] = track;
        else this._tracks.push(track);
        if (dur > 0) this._duration = Math.max(this._duration, dur);
    }

    // ═══════════════════════════════════════════════
    // 渲染
    // ═══════════════════════════════════════════════

    _renderLoop() {
        if (this._destroyed) return;
        this._render();
        this._rafId = requestAnimationFrame(() => this._renderLoop());
    }

    _render() {
        const ctx = this.ctx;
        const W = this._canvasW;
        const H = this._canvasH;
        if (!W || !H) return;

        ctx.clearRect(0, 0, W, H);

        // 背景
        ctx.fillStyle = TL_COLORS.bg;
        ctx.fillRect(0, 0, W, H);

        // 时间刻度尺
        this._drawRuler(ctx, W);

        // 轨道区域
        this._drawTracks(ctx, W, H);

        // 序列终点是一个独立的编辑边界，不等同于红色播放头。它让用户一眼
        // 看出最后一个片段/循环背景真正在哪结束。
        this._drawEndMarker(ctx, W, H);

        // 播放头
        this._drawPlayhead(ctx, W, H);

        // 切刀工具的跟随指示：不能只改变鼠标光标，否则用户不知道点下去会切在哪。
        this._drawBladeGuide(ctx, W, H);

        // 框选区域
        this._drawMarquee(ctx);
    }

    _drawRuler(ctx, W) {
        ctx.fillStyle = TL_COLORS.ruler;
        ctx.fillRect(0, 0, W, TL_RULER_H);

        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, TL_RULER_H);
        ctx.lineTo(W, TL_RULER_H);
        ctx.stroke();

        // 刻度
        const step = this._calcRulerStep();
        const startTime = Math.floor(this._scrollX / this._pxPerSec / step) * step;
        const endTime = (this._scrollX + W - TL_HEADER_W) / this._pxPerSec;

        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = TL_COLORS.rulerText;

        for (let t = startTime; t <= endTime + step; t += step) {
            const x = TL_HEADER_W + (t * this._pxPerSec) - this._scrollX;
            if (x < TL_HEADER_W || x > W) continue;

            // 主刻度
            ctx.strokeStyle = TL_COLORS.gridMajor;
            ctx.beginPath();
            ctx.moveTo(x, TL_RULER_H - 10);
            ctx.lineTo(x, TL_RULER_H);
            ctx.stroke();

            ctx.fillText(this._formatTime(t), x, TL_RULER_H - 13);

            // 次刻度
            const subStep = step / 4;
            for (let s = 1; s < 4; s++) {
                const sx = TL_HEADER_W + ((t + s * subStep) * this._pxPerSec) - this._scrollX;
                if (sx < TL_HEADER_W || sx > W) continue;
                ctx.strokeStyle = TL_COLORS.gridMinor;
                ctx.beginPath();
                ctx.moveTo(sx, TL_RULER_H - 5);
                ctx.lineTo(sx, TL_RULER_H);
                ctx.stroke();
            }
        }
    }

    _drawBladeGuide(ctx, W, H) {
        if (!this._bladeTool || !Number.isFinite(this._bladeHoverX)) return;
        const x = this._bladeHoverX;
        if (x < TL_HEADER_W || x > W) return;
        ctx.save();
        ctx.strokeStyle = '#fb7185';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(x, TL_RULER_H);
        ctx.lineTo(x, H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#fb7185';
        ctx.beginPath();
        ctx.moveTo(x - 7, TL_RULER_H + 1);
        ctx.lineTo(x + 7, TL_RULER_H + 1);
        ctx.lineTo(x, TL_RULER_H + 10);
        ctx.closePath();
        ctx.fill();
        ctx.font = 'bold 18px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = '#ffe4e6';
        ctx.fillText('✂', x, TL_RULER_H - 2);
        ctx.restore();
    }

    _drawTracks(ctx, W, H) {
        let y = TL_RULER_H - this._scrollY;
        let lastDomain = null;

        for (let ti = 0; ti < this._tracks.length; ti++) {
            const track = this._tracks[ti];

            // 域分离线
            if (lastDomain === 'visual' && track.domain === 'audio') {
                ctx.strokeStyle = TL_COLORS.domainSep;
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 3]);
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(W, y);
                ctx.stroke();
                ctx.setLineDash([]);
                y += 4;
            }
            lastDomain = track.domain;

            // 轨道可见范围检查
            if (y + TL_TRACK_HEIGHT < 0 || y > H) { y += TL_TRACK_HEIGHT + 1; continue; }

            // 轨道头部
            this._drawTrackHeader(ctx, track, y, ti);

            // 轨道内容背景
            ctx.fillStyle = ti % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.1)';
            ctx.fillRect(TL_HEADER_W, y, W - TL_HEADER_W, TL_TRACK_HEIGHT);

            // 网格线 (对齐刻度)
            const step = this._calcRulerStep();
            for (let t = 0; t <= this._duration; t += step) {
                const gx = TL_HEADER_W + t * this._pxPerSec - this._scrollX;
                if (gx < TL_HEADER_W || gx > W) continue;
                ctx.strokeStyle = TL_COLORS.gridMinor;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(gx, y);
                ctx.lineTo(gx, y + TL_TRACK_HEIGHT);
                ctx.stroke();
            }

            // 片段只能画在右侧时间区域内。没有这个裁切时，横向滚动的片段
            // 会越过 0 秒边界盖住左侧轨道名称，看上去像“滚动穿帮”。
            ctx.save();
            ctx.beginPath();
            ctx.rect(TL_HEADER_W, y, Math.max(0, W - TL_HEADER_W), TL_TRACK_HEIGHT);
            ctx.clip();
            for (let ci = 0; ci < track.clips.length; ci++) {
                this._drawClip(ctx, track, ti, ci, y);
            }

            // 检查主背景画面覆盖范围，若末尾存在空白缺口（黑屏风险），绘制醒目的红色警示区域（插入素材/覆层轨不需要填满全片，不触发警示）
            const isInsertOrOverlay = (track.name && (track.name.includes('插入') || track.name.includes('覆层') || track.name.includes('画中画'))) || track.role === 'insert_video' || track.clips?.some(c => c._timelineRole === 'insert_video');
            const isBackgroundTrack = !isInsertOrOverlay && (track.name?.includes('背景') || (track.type === 'video' && !track.name?.includes('插入')));
            if (isBackgroundTrack && track.clips.length > 0) {
                const maxEnd = Math.max(0, ...track.clips.map(c => c.end || 0));
                if (this._duration > maxEnd + 0.1) {
                    const gapStartPx = TL_HEADER_W + maxEnd * this._pxPerSec - this._scrollX;
                    const gapEndPx = TL_HEADER_W + this._duration * this._pxPerSec - this._scrollX;
                    const drawX0 = Math.max(TL_HEADER_W, gapStartPx);
                    const drawX1 = Math.min(W, gapEndPx);
                    if (drawX1 > drawX0) {
                        // 红色半透明背景
                        ctx.fillStyle = 'rgba(239, 68, 68, 0.18)';
                        ctx.fillRect(drawX0, y + 2, drawX1 - drawX0, TL_TRACK_HEIGHT - 4);

                        // 红色对角斜条纹
                        ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
                        ctx.lineWidth = 2;
                        const stripeGap = 14;
                        for (let sx = drawX0 - TL_TRACK_HEIGHT; sx < drawX1 + TL_TRACK_HEIGHT; sx += stripeGap) {
                            ctx.beginPath();
                            ctx.moveTo(sx, y + TL_TRACK_HEIGHT - 2);
                            ctx.lineTo(sx + TL_TRACK_HEIGHT, y + 2);
                            ctx.stroke();
                        }

                        // 红色虚线边框
                        ctx.strokeStyle = '#ef4444';
                        ctx.lineWidth = 1.5;
                        ctx.setLineDash([5, 3]);
                        ctx.strokeRect(drawX0 + 0.5, y + 2.5, drawX1 - drawX0 - 1, TL_TRACK_HEIGHT - 5);
                        ctx.setLineDash([]);

                        // 警示文字与补充提示
                        const missingSec = (this._duration - maxEnd).toFixed(1);
                        const label = `⚠️ 画面不足 (缺 ${missingSec}s · 右键补充循环)`;
                        ctx.font = 'bold 10px system-ui, sans-serif';
                        ctx.fillStyle = '#fca5a5';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        const textX = (drawX0 + drawX1) / 2;
                        const textY = y + TL_TRACK_HEIGHT / 2;
                        if (drawX1 - drawX0 > 60) {
                            ctx.fillText(label, textX, textY);
                        }
                    }
                }
            }
            ctx.restore();

            y += TL_TRACK_HEIGHT + 1;
        }
    }

    _drawTrackHeader(ctx, track, y, idx) {
        ctx.fillStyle = TL_COLORS.headerBg;
        ctx.fillRect(0, y, TL_HEADER_W, TL_TRACK_HEIGHT);

        // 边框
        ctx.strokeStyle = TL_COLORS.headerBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(0, y, TL_HEADER_W, TL_TRACK_HEIGHT);

        // 类型色条
        const typeColor = TL_COLORS.trackTypes[track.type] || '#888';
        ctx.fillStyle = typeColor;
        ctx.fillRect(0, y, 4, TL_TRACK_HEIGHT);

        // 眼睛按钮 (显隐控制)
        const isVisible = track.visible !== false;
        const eyeX = TL_HEADER_W - 24;
        const eyeY = y + (TL_TRACK_HEIGHT - 18) / 2;
        const eyeSize = 18;

        // 眼睛按钮底色与边框
        ctx.fillStyle = isVisible ? 'rgba(255, 255, 255, 0.08)' : 'rgba(239, 68, 68, 0.22)';
        ctx.strokeStyle = isVisible ? 'rgba(255, 255, 255, 0.15)' : 'rgba(239, 68, 68, 0.5)';
        ctx.lineWidth = 1;
        if (typeof ctx.roundRect === 'function') {
            ctx.beginPath();
            ctx.roundRect(eyeX, eyeY, eyeSize, eyeSize, 4);
            ctx.fill();
            ctx.stroke();
        } else {
            ctx.fillRect(eyeX, eyeY, eyeSize, eyeSize);
            ctx.strokeRect(eyeX, eyeY, eyeSize, eyeSize);
        }

        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = isVisible ? '#e2e8f0' : '#f87171';
        ctx.fillText(isVisible ? '👁' : '🚫', eyeX + eyeSize / 2, eyeY + eyeSize / 2 + 1);

        // 头部警示徽章
        let rightBadgeOffset = eyeX - 6;
        // 视觉轨的层级不能只靠隐藏的右键菜单操作。把上/下移和更多菜单
        // 固定放在轨道名右侧，符合“越上层越靠前”的 NLE 直觉。
        const canReorder = track.domain === 'visual' && typeof this.onTrackOrderChange === 'function';
        if (canReorder) {
            const controls = [
                { x: eyeX - 60, icon: '↑', title: '上移（更高层）' },
                { x: eyeX - 40, icon: '↓', title: '下移（更低层）' },
                { x: eyeX - 20, icon: '⋯', title: '更多轨道操作' },
            ];
            controls.forEach(control => {
                ctx.fillStyle = 'rgba(255,255,255,0.06)';
                ctx.strokeStyle = 'rgba(255,255,255,0.16)';
                ctx.lineWidth = 1;
                if (typeof ctx.roundRect === 'function') {
                    ctx.beginPath(); ctx.roundRect(control.x, eyeY, 16, eyeSize, 3); ctx.fill(); ctx.stroke();
                } else {
                    ctx.fillRect(control.x, eyeY, 16, eyeSize); ctx.strokeRect(control.x, eyeY, 16, eyeSize);
                }
                ctx.font = control.icon === '⋯' ? 'bold 14px system-ui' : 'bold 13px system-ui';
                ctx.fillStyle = '#cbd5e1';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(control.icon, control.x + 8, eyeY + eyeSize / 2 - (control.icon === '⋯' ? 2 : 0));
            });
            rightBadgeOffset = eyeX - 66;
        }
        const isInsert = track.role === 'insert_video' || (track.name && track.name.includes('插入')) || track.clips?.some(c => c._timelineRole === 'insert_video');
        const isBg = !isInsert && (track.role === 'background' || (track.name && track.name.includes('背景')) || (track.type === 'video' && !track.name?.includes('插入')));
        if (isBg && track.clips && track.clips.length > 0) {
            const maxEnd = Math.max(0, ...track.clips.map(c => c.end || 0));
            if (this._duration > maxEnd + 0.1) {
                const missingSec = (this._duration - maxEnd).toFixed(1);
                ctx.fillStyle = '#ef4444';
                ctx.font = 'bold 9px system-ui, sans-serif';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'alphabetic';
                ctx.fillText(`⚠️缺${missingSec}s`, rightBadgeOffset, y + TL_TRACK_HEIGHT / 2 + 4);
                rightBadgeOffset -= 45;
            }
        }

        // 状态图标 (如锁定)
        if (track.locked) {
            ctx.font = '10px system-ui';
            ctx.fillStyle = '#888';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText('🔒', rightBadgeOffset, y + TL_TRACK_HEIGHT / 2 + 4);
            rightBadgeOffset -= 16;
        }

        // 名称 (截断以防超出)
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.fillStyle = isVisible ? '#ccc' : '#6b7280';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        let displayName = track.name || '';
        const maxTextW = Math.max(20, rightBadgeOffset - 12);
        if (ctx.measureText(displayName).width > maxTextW) {
            while (displayName.length > 1 && ctx.measureText(displayName + '…').width > maxTextW) {
                displayName = displayName.slice(0, -1);
            }
            displayName += '…';
        }
        ctx.fillText(displayName, 10, y + TL_TRACK_HEIGHT / 2 + 4);
    }

    _drawClip(ctx, track, trackIdx, clipIdx, trackY) {
        const clip = track.clips[clipIdx];
        const x = TL_HEADER_W + clip.start * this._pxPerSec - this._scrollX;
        const w = Math.max(TL_MIN_CLIP_W, (clip.end - clip.start) * this._pxPerSec);
        const y = trackY + 3;
        const h = TL_TRACK_HEIGHT - 6;
        // 循环素材不是一个长块：保留少量视觉间隙，让每一轮都能一眼看见。
        // 命中/拖拽仍使用原始时间范围，不会在时间线上制造真实空白。
        const isLoopInstance = clip._isLoopInstance === true;
        const isOverlayRange = clip._timelineRole === 'overlay' && track.clips.length > 1;
        const seam = (isLoopInstance || isOverlayRange) && w > 12 ? 4 : Math.max(1.5, Math.min(3, w * 0.04));
        const drawX = x + seam;
        const drawW = Math.max(2, w - seam * 2);
        const drawY = y + 1;
        const drawH = h - 2;

        // 可见范围检查
        if (x + w < TL_HEADER_W || x > this._canvasW) return;

        const isSelected = this._selectedClips.has(this._clipKey(trackIdx, clipIdx));
        const isHovered = this._hoveredClip?.trackIdx === trackIdx && this._hoveredClip?.clipIdx === clipIdx;

        const prevGlobalAlpha = ctx.globalAlpha;
        if (track.visible === false) {
            ctx.globalAlpha = 0.38;
        }

        // 片段卡片背景（支持交替色相与现代渐变）
        const isSubLike = track.type === 'subs' || track.type === 'asr' || track.type === 'script';
        const isTrimmedSub = isSubLike && (clip._isTrimmed === true || clip.isTrimmed === true);
        const baseColor = clip.color || TL_COLORS.trackTypes[track.type] || '#3b82f6';
        let bgGradient = ctx.createLinearGradient(drawX, drawY, drawX, drawY + drawH);

        if (track.type === 'video') {
            const isAlt = clipIdx % 2 === 1;
            if (isSelected) {
                bgGradient.addColorStop(0, '#3b82f6');
                bgGradient.addColorStop(1, '#1d4ed8');
            } else if (isHovered) {
                bgGradient.addColorStop(0, '#2563eb');
                bgGradient.addColorStop(1, '#1e40af');
            } else {
                bgGradient.addColorStop(0, isAlt ? '#1d4ed8' : '#1e40af');
                bgGradient.addColorStop(1, isAlt ? '#1e3a8a' : '#172554');
            }
        } else if (isTrimmedSub) {
            if (isSelected) {
                bgGradient.addColorStop(0, '#ef4444');
                bgGradient.addColorStop(1, '#b91c1c');
            } else if (isHovered) {
                bgGradient.addColorStop(0, '#dc2626');
                bgGradient.addColorStop(1, '#991b1b');
            } else {
                bgGradient.addColorStop(0, 'rgba(239, 68, 68, 0.45)');
                bgGradient.addColorStop(1, 'rgba(185, 28, 28, 0.55)');
            }
        } else if (track.type === 'asr') {
            const isAlt = clipIdx % 2 === 1;
            if (isSelected) {
                bgGradient.addColorStop(0, '#06b6d4');
                bgGradient.addColorStop(1, '#0891b2');
            } else if (isHovered) {
                bgGradient.addColorStop(0, '#0ea5e9');
                bgGradient.addColorStop(1, '#0284c7');
            } else {
                bgGradient.addColorStop(0, isAlt ? '#0891b2' : '#0e7490');
                bgGradient.addColorStop(1, isAlt ? '#155e75' : '#164e63');
            }
        } else if (track.type === 'script') {
            const isAlt = clipIdx % 2 === 1;
            if (isSelected) {
                bgGradient.addColorStop(0, '#a855f7');
                bgGradient.addColorStop(1, '#7e22ce');
            } else if (isHovered) {
                bgGradient.addColorStop(0, '#c084fc');
                bgGradient.addColorStop(1, '#9333ea');
            } else {
                bgGradient.addColorStop(0, isAlt ? '#7e22ce' : '#6b21a8');
                bgGradient.addColorStop(1, isAlt ? '#581c87' : '#3b0764');
            }
        } else if (track.type === 'subs') {
            const isAlt = clipIdx % 2 === 1;
            if (isSelected) {
                bgGradient.addColorStop(0, '#f59e0b');
                bgGradient.addColorStop(1, '#b45309');
            } else {
                bgGradient.addColorStop(0, isAlt ? '#d97706' : '#b45309');
                bgGradient.addColorStop(1, isAlt ? '#92400e' : '#78350f');
            }
        } else {
            if (isSelected) {
                bgGradient.addColorStop(0, this._lighten(baseColor, 0.2));
                bgGradient.addColorStop(1, baseColor);
            } else {
                bgGradient.addColorStop(0, this._darken(baseColor, 0.15));
                bgGradient.addColorStop(1, this._darken(baseColor, 0.4));
            }
        }

        // 绘制独立卡片圆角矩形
        const r = Math.min(5, drawW / 2, drawH / 2);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(drawX + r, drawY);
        ctx.lineTo(drawX + drawW - r, drawY);
        ctx.quadraticCurveTo(drawX + drawW, drawY, drawX + drawW, drawY + r);
        ctx.lineTo(drawX + drawW, drawY + drawH - r);
        ctx.quadraticCurveTo(drawX + drawW, drawY + drawH, drawX + drawW - r, drawY + drawH);
        ctx.lineTo(drawX + r, drawY + drawH);
        ctx.quadraticCurveTo(drawX, drawY + drawH, drawX, drawY + drawH - r);
        ctx.lineTo(drawX, drawY + r);
        ctx.quadraticCurveTo(drawX, drawY, drawX + r, drawY);
        ctx.closePath();

        ctx.fillStyle = bgGradient;
        ctx.fill();

        // 独立卡片描边（使相邻片段边界泾渭分明）
        if (isTrimmedSub) {
            ctx.strokeStyle = isSelected ? '#fca5a5' : (isHovered ? 'rgba(239, 68, 68, 0.95)' : 'rgba(239, 68, 68, 0.55)');
            ctx.lineWidth = isSelected ? 2 : 1;
        } else if (track.type === 'asr') {
            ctx.strokeStyle = isSelected ? '#a5f3fc' : (isHovered ? 'rgba(103, 232, 249, 0.8)' : 'rgba(6, 182, 212, 0.35)');
            ctx.lineWidth = isSelected ? 2 : 1;
        } else if (track.type === 'script') {
            ctx.strokeStyle = isSelected ? '#e9d5ff' : (isHovered ? 'rgba(216, 180, 254, 0.8)' : 'rgba(168, 85, 247, 0.35)');
            ctx.lineWidth = isSelected ? 2 : 1;
        } else {
            ctx.strokeStyle = isSelected ? '#93c5fd' : (isHovered ? 'rgba(255, 255, 255, 0.6)' : 'rgba(255, 255, 255, 0.25)');
            ctx.lineWidth = isSelected ? 2 : 1;
        }
        ctx.stroke();

        // 覆层被切分后的边界要比普通卡片边框更醒目：留出明显缝隙，并在
        // 两端画红色“切刀刻痕”。这样即使两个区间紧挨着，也能一眼看出切口。
        if (isOverlayRange) {
            ctx.save();
            ctx.strokeStyle = '#fb7185';
            ctx.fillStyle = '#fecdd3';
            ctx.lineWidth = 2;
            [drawX, drawX + drawW].forEach(edgeX => {
                ctx.beginPath();
                ctx.moveTo(edgeX, drawY + 2);
                ctx.lineTo(edgeX, drawY + drawH - 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(edgeX - 3, drawY + 2);
                ctx.lineTo(edgeX + 3, drawY + 2);
                ctx.lineTo(edgeX, drawY + 7);
                ctx.closePath();
                ctx.fill();
            });
            ctx.restore();
        }

        // 渲染裁掉的空档部分 (Trimmed Head / Tail) 与 中间有效保留区域
        const inT = clip.inT !== undefined ? clip.inT : (clip._trimHead || 0);
        const sourceDur = clip.sourceDuration || (clip.end - clip.start);
        const outT = clip.outT !== undefined ? clip.outT : (clip.sourceDuration && clip._trimTail !== undefined ? clip.sourceDuration - clip._trimTail : sourceDur);
        const trimHead = inT;
        const trimTail = Math.max(0, sourceDur - outT);

        const inW = Math.max(0, Math.min(drawW, inT * this._pxPerSec));
        const outW = Math.max(inW, Math.min(drawW, outT * this._pxPerSec));
        const hasTrimHead = trimHead > 0.02 && inW > 1;
        const hasTrimTail = trimTail > 0.02 && outW < drawW - 1;

        // 1. 中间有效保留区域 (Active Kept Content Gradient)
        const activeX = drawX + inW;
        const activeW = Math.max(1, outW - inW);
        ctx.fillStyle = bgGradient;
        ctx.fillRect(activeX, drawY, activeW, drawH);

        // 2. 左侧前段被裁掉的空档（鲜明红色背景 + 入点红线 + 时间标识）
        if (hasTrimHead) {
            ctx.fillStyle = isSelected ? 'rgba(239, 68, 68, 0.45)' : 'rgba(239, 68, 68, 0.32)';
            ctx.fillRect(drawX, drawY, inW, drawH);

            // 标注裁切时间
            if (inW > 24 && drawH > 24) {
                ctx.font = 'bold 9px system-ui, sans-serif';
                ctx.fillStyle = '#fca5a5';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(`前-${inT.toFixed(1)}s`, drawX + inW / 2, drawY + drawH / 2);
            }
        }

        // 3. 右侧后段被裁掉的空档（鲜明红色背景 + 出点红线 + 时间标识）
        if (hasTrimTail) {
            const tailW = drawW - outW;
            ctx.fillStyle = isSelected ? 'rgba(239, 68, 68, 0.45)' : 'rgba(239, 68, 68, 0.32)';
            ctx.fillRect(drawX + outW, drawY, tailW, drawH);

            // 标注裁切时间
            if (tailW > 24 && drawH > 24) {
                ctx.font = 'bold 9px system-ui, sans-serif';
                ctx.fillStyle = '#fca5a5';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(`后-${trimTail.toFixed(1)}s`, drawX + outW + tailW / 2, drawY + drawH / 2);
            }
        }

        // 片段文本与序号徽章（清晰标识片段边界与裁切信息）
        if (drawW > 16) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(drawX + 2, drawY, drawW - 4, drawH);
            ctx.clip();

            const hasTrim = hasTrimHead || hasTrimTail;
            let textLeft = activeX + 6;

            if (isSubLike) {
                // 字幕类轨道（ASR/提供的文案/最终字幕）双行排版与自适应折行，最大化展示完整字幕
                const fontSz = drawH >= 34 ? 10 : 9;
                ctx.font = isTrimmedSub ? `italic ${fontSz}px system-ui, -apple-system, sans-serif` : `bold ${fontSz}px system-ui, -apple-system, sans-serif`;
                if (isTrimmedSub) {
                    ctx.fillStyle = '#fecaca';
                } else if (track.type === 'asr') {
                    ctx.fillStyle = '#e0f2fe';
                } else if (track.type === 'script') {
                    ctx.fillStyle = '#fae8ff';
                } else {
                    ctx.fillStyle = '#fffbeb';
                }
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';

                const maxTextW = Math.max(10, drawW - 10);
                const lines = _layoutClipLines(ctx, clip.name || '', maxTextW, drawH >= 30 ? 2 : 1);

                if (lines.length <= 1) {
                    ctx.fillText(lines[0] || clip.name || '', drawX + 5, drawY + drawH / 2);
                } else {
                    const lineH = fontSz + 2.5;
                    const totalH = lines.length * lineH;
                    const startY = drawY + (drawH - totalH) / 2 + fontSz / 2;
                    lines.forEach((line, lIdx) => {
                        ctx.fillText(line, drawX + 5, startY + lIdx * lineH);
                    });
                }
            } else {
                // 绘制序号徽章 [#1]
                if (activeW > 38) {
                    const badgeText = `#${clipIdx + 1}`;
                    ctx.font = 'bold 9px system-ui, sans-serif';
                    const badgeW = ctx.measureText(badgeText).width + 6;
                    const badgeH = 13;
                    const badgeY = drawY + 4;
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
                    ctx.beginPath();
                    ctx.roundRect ? ctx.roundRect(textLeft, badgeY, badgeW, badgeH, 3) : ctx.rect(textLeft, badgeY, badgeW, badgeH);
                    ctx.fill();
                    ctx.fillStyle = '#f8fafc';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(badgeText, textLeft + badgeW / 2, badgeY + badgeH / 2);
                    textLeft += badgeW + 5;
                }

                // 片段文件名 / 文本
                ctx.font = 'bold 10px system-ui, sans-serif';
                ctx.fillStyle = '#fff';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(clip.name || '', textLeft, drawY + (hasTrim && drawH > 32 ? 10 : drawH / 2));

                // 第二行：裁切与时长信息
                if (activeW > 50 && drawH > 32) {
                    ctx.font = '9px system-ui, sans-serif';
                    ctx.fillStyle = isSelected ? '#bfdbfe' : '#93c5fd';
                    let info = `保留 ${(outT - inT).toFixed(2)}s`;
                    if (hasTrimTail) info += ` [后-${trimTail.toFixed(1)}s]`;
                    if (hasTrimHead) info = `[前-${trimHead.toFixed(1)}s] ` + info;
                    ctx.fillText(info.trim(), activeX + 6, drawY + drawH - 7);
                }
            }
            ctx.restore();
        }

        const isHoveredIn = isHovered && this._hoveredZone === 'cut_in';
        const isHoveredOut = isHovered && this._hoveredZone === 'cut_out';
        const isDraggingIn = this._drag?.trackIdx === trackIdx && this._drag?.clipIdx === clipIdx && this._drag?.type === 'cut_in';
        const isDraggingOut = this._drag?.trackIdx === trackIdx && this._drag?.clipIdx === clipIdx && this._drag?.type === 'cut_out';

        // 4. 入点切线及可拖拽把手 (In-point Cut Line & Handle)
        const hasInCut = (track.type === 'video' || track.type === 'audio') && (clip.inT !== undefined || clip._trimHead !== undefined);
        if (hasInCut) {
            const cutLineX = Math.round(drawX + inW);
            const activeIn = isHoveredIn || isDraggingIn;
            ctx.save();
            ctx.strokeStyle = activeIn ? '#38bdf8' : (isSelected ? '#60a5fa' : (hasTrimHead ? '#ef4444' : 'rgba(56, 189, 248, 0.8)'));
            ctx.lineWidth = activeIn ? 3 : 2;
            if (activeIn) {
                ctx.shadowColor = '#38bdf8';
                ctx.shadowBlur = 8;
            }
            ctx.beginPath();
            ctx.moveTo(cutLineX, drawY);
            ctx.lineTo(cutLineX, drawY + drawH);
            ctx.stroke();

            // 绘制入点把手 (Pill Handle Grip)
            const handleW = 6;
            const handleH = Math.min(12, Math.max(8, drawH / 3));
            ctx.fillStyle = activeIn ? '#38bdf8' : (hasTrimHead ? '#f87171' : '#38bdf8');
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(cutLineX - handleW / 2, drawY, handleW, handleH, 2) : ctx.rect(cutLineX - handleW / 2, drawY, handleW, handleH);
            ctx.roundRect ? ctx.roundRect(cutLineX - handleW / 2, drawY + drawH - handleH, handleW, handleH, 2) : ctx.rect(cutLineX - handleW / 2, drawY + drawH - handleH, handleW, handleH);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(cutLineX - 1, drawY + 2, 2, handleH - 4);
            ctx.fillRect(cutLineX - 1, drawY + drawH - handleH + 2, 2, handleH - 4);
            ctx.restore();
        }

        // 5. 出点切线及可拖拽把手 (Out-point Cut Line & Handle)
        const hasOutCut = (track.type === 'video' || track.type === 'audio') && (clip.outT !== undefined || clip._trimTail !== undefined);
        if (hasOutCut) {
            const cutLineX = Math.round(drawX + outW);
            const activeOut = isHoveredOut || isDraggingOut;
            ctx.save();
            ctx.strokeStyle = activeOut ? '#fbbf24' : (isSelected ? '#f59e0b' : (hasTrimTail ? '#ef4444' : 'rgba(251, 191, 36, 0.8)'));
            ctx.lineWidth = activeOut ? 3 : 2;
            if (activeOut) {
                ctx.shadowColor = '#fbbf24';
                ctx.shadowBlur = 8;
            }
            ctx.beginPath();
            ctx.moveTo(cutLineX, drawY);
            ctx.lineTo(cutLineX, drawY + drawH);
            ctx.stroke();

            // 绘制出点把手 (Pill Handle Grip)
            const handleW = 6;
            const handleH = Math.min(12, Math.max(8, drawH / 3));
            ctx.fillStyle = activeOut ? '#fbbf24' : (hasTrimTail ? '#f87171' : '#fbbf24');
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(cutLineX - handleW / 2, drawY, handleW, handleH, 2) : ctx.rect(cutLineX - handleW / 2, drawY, handleW, handleH);
            ctx.roundRect ? ctx.roundRect(cutLineX - handleW / 2, drawY + drawH - handleH, handleW, handleH, 2) : ctx.rect(cutLineX - handleW / 2, drawY + drawH - handleH, handleW, handleH);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(cutLineX - 1, drawY + 2, 2, handleH - 4);
            ctx.fillRect(cutLineX - 1, drawY + drawH - handleH + 2, 2, handleH - 4);
            ctx.restore();
        }
        ctx.restore();
        ctx.globalAlpha = prevGlobalAlpha;
    }

    _drawPlayhead(ctx, W, H) {
        const x = TL_HEADER_W + this._playheadPos * this._pxPerSec - this._scrollX;
        if (x < TL_HEADER_W - 20 || x > W + 20) return;

        ctx.save();

        // 1. 发光外晕竖线 (Glow Aura)
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.35)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x, TL_RULER_H);
        ctx.lineTo(x, H);
        ctx.stroke();

        // 2. 鲜红核心竖线 (Red Core Line)
        ctx.strokeStyle = '#ff3344';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, TL_RULER_H);
        ctx.lineTo(x, H);
        ctx.stroke();

        // 3. 顶部红宝石播放头游标 (Header Pin Badge)
        ctx.shadowColor = 'rgba(255, 42, 68, 0.6)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 1;

        const headW = 7;
        const headH = TL_RULER_H - 2;
        ctx.fillStyle = '#ff2a44';
        ctx.beginPath();
        ctx.moveTo(x - headW, 0);
        ctx.lineTo(x + headW, 0);
        ctx.lineTo(x + headW, headH - 7);
        ctx.lineTo(x, headH);
        ctx.lineTo(x - headW, headH - 7);
        ctx.closePath();
        ctx.fill();

        // 边框与内部白色高光点
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = '#ffaab4';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, 7, 1.8, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    _drawEndMarker(ctx, W, H) {
        const x = TL_HEADER_W + this._duration * this._pxPerSec - this._scrollX;
        if (x < TL_HEADER_W || x > W) return;
        ctx.save();
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(x, TL_RULER_H);
        ctx.lineTo(x, H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#cbd5e1';
        ctx.font = 'bold 9px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('结束', x - 4, TL_RULER_H + 12);
        ctx.restore();
    }

    // ═══════════════════════════════════════════════
    // 鼠标交互
    // ═══════════════════════════════════════════════

    _findLinkedClipRefs(linkGroupId) {
        if (!linkGroupId) return [];
        const result = [];
        this._tracks.forEach((track, trackIdx) => {
            (track.clips || []).forEach((clip, clipIdx) => {
                if (clip && clip._linkGroupId === linkGroupId) {
                    result.push({
                        trackIdx, clipIdx, clip,
                        origStart: clip.start,
                        origEnd: clip.end,
                    });
                }
            });
        });
        return result;
    }

    _onMouseDown(e) {
        this._hideTooltip();
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // 1. 点击刻度尺 → seek
        if (my < TL_RULER_H) {
            this._drag = { type: 'playhead' };
            this._seekToX(mx, 'mousedown');
            return;
        }

        // 2. 点击轨道头部
        if (mx < TL_HEADER_W) {
            const trackIdx = this._trackIndexAtY(my);
            if (trackIdx >= 0 && trackIdx < this._tracks.length) {
                const track = this._tracks[trackIdx];
                if (mx >= TL_HEADER_W - 28 && mx <= TL_HEADER_W - 2) {
                    track.visible = (track.visible === false ? true : false);
                    if (this.onTrackVisibilityChange) {
                        this.onTrackVisibilityChange(trackIdx, track.visible, track);
                    }
                    this._render();
                    return;
                }
                if (track.domain === 'visual' && typeof this.onTrackOrderChange === 'function') {
                    const controlY = y => y + (TL_TRACK_HEIGHT - 18) / 2;
                    let trackY = TL_RULER_H - this._scrollY;
                    for (let ti = 0; ti < trackIdx; ti++) {
                        if (this._tracks[ti].domain === 'visual' && this._tracks[ti + 1]?.domain === 'audio') trackY += 4;
                        trackY += TL_TRACK_HEIGHT + 1;
                    }
                    const cy = controlY(trackY);
                    const inControlY = my >= cy && my <= cy + 18;
                    const eyeX = TL_HEADER_W - 24;
                    if (inControlY && mx >= eyeX - 60 && mx < eyeX - 44) {
                        this.moveTrack(trackIdx, 'up');
                        return;
                    }
                    if (inControlY && mx >= eyeX - 40 && mx < eyeX - 24) {
                        this.moveTrack(trackIdx, 'down');
                        return;
                    }
                    if (inControlY && mx >= eyeX - 20 && mx < eyeX - 4) {
                        this._onContextMenu({ clientX: e.clientX, clientY: e.clientY });
                        return;
                    }
                }
            }
            return;
        }

        // 3. 检测是否点击了 Trim 手柄
        const hitInfo = this._hitTestClip(mx, my);
        if (this._bladeTool && hitInfo) {
            const cutTime = this._snapToFrame(Math.max(0, (mx - TL_HEADER_W + this._scrollX) / this._pxPerSec));
            this._splitClipAt(hitInfo.trackIdx, hitInfo.clipIdx, cutTime);
            return;
        }
        if (hitInfo) {
            const key = this._clipKey(hitInfo.trackIdx, hitInfo.clipIdx);
            const toggleSelection = e.ctrlKey || e.metaKey;
            const rangeSelection = e.shiftKey;

            if (rangeSelection && this._selectionAnchor?.trackIdx === hitInfo.trackIdx) {
                if (!toggleSelection) this._selectedClips.clear();
                const from = Math.min(this._selectionAnchor.clipIdx, hitInfo.clipIdx);
                const to = Math.max(this._selectionAnchor.clipIdx, hitInfo.clipIdx);
                for (let ci = from; ci <= to; ci++) {
                    this._selectedClips.add(this._clipKey(hitInfo.trackIdx, ci));
                }
            } else if (toggleSelection) {
                if (this._selectedClips.has(key)) this._selectedClips.delete(key);
                else this._selectedClips.add(key);
                this._selectionAnchor = { trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx };
            } else if (!this._selectedClips.has(key)) {
                this._selectedClips.clear();
                this._selectedClips.add(key);
                this._selectionAnchor = { trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx };
            }

            this._selectedClip = this._selectedClips.has(key)
                ? { trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx }
                : this._firstSelectedClip();
            const clip = this._tracks[hitInfo.trackIdx].clips[hitInfo.clipIdx];
            const track = this._tracks[hitInfo.trackIdx];

            // ── 双击检测 ──
            const now = Date.now();
            const clipKey = `${hitInfo.trackIdx}_${hitInfo.clipIdx}`;
            if (now - this._lastClickTime < 400 && this._lastClickClip === clipKey) {
                // 双击 → 打开字幕编辑
                this._lastClickTime = 0;
                this._lastClickClip = null;
                if (track.type === 'subs') {
                    const clipRect = this._getClipScreenRect(hitInfo.trackIdx, hitInfo.clipIdx);
                    if (this.onClipDblClick) {
                        this.onClipDblClick(hitInfo.trackIdx, hitInfo.clipIdx, clip, clipRect);
                    } else {
                        this._openSubtitleEditor(hitInfo.trackIdx, hitInfo.clipIdx, clip, clipRect);
                    }
                }
                return;
            }
            this._lastClickTime = now;
            this._lastClickClip = clipKey;

            if (!this._selectedClips.has(key)) {
                this._drag = null;
            } else if (hitInfo.zone === 'cut_in') {
                const origInT = clip.inT !== undefined ? clip.inT : (clip._trimHead || 0);
                const sourceDur = clip.sourceDuration || (clip.end - clip.start);
                const origOutT = clip.outT !== undefined ? clip.outT : (clip.sourceDuration && clip._trimTail !== undefined ? clip.sourceDuration - clip._trimTail : sourceDur);
                this._drag = {
                    type: 'cut_in',
                    trackIdx: hitInfo.trackIdx,
                    clipIdx: hitInfo.clipIdx,
                    origInT,
                    origOutT,
                    origStart: clip.start,
                    origEnd: clip.end,
                    sourceDuration: sourceDur,
                    mx0: mx,
                };
            } else if (hitInfo.zone === 'cut_out') {
                const origInT = clip.inT !== undefined ? clip.inT : (clip._trimHead || 0);
                const sourceDur = clip.sourceDuration || (clip.end - clip.start);
                const origOutT = clip.outT !== undefined ? clip.outT : (clip.sourceDuration && clip._trimTail !== undefined ? clip.sourceDuration - clip._trimTail : sourceDur);
                this._drag = {
                    type: 'cut_out',
                    trackIdx: hitInfo.trackIdx,
                    clipIdx: hitInfo.clipIdx,
                    origInT,
                    origOutT,
                    origStart: clip.start,
                    origEnd: clip.end,
                    sourceDuration: sourceDur,
                    mx0: mx,
                };
            } else if (hitInfo.zone === 'start') {
                const linked = clip._linkGroupId ? this._findLinkedClipRefs(clip._linkGroupId) : [{ trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx, clip, origStart: clip.start, origEnd: clip.end }];
                const followingClips = [];
                const origEnd = clip.end;
                const isSequenced = clip._isLoopInstance || clip._timelineRole === 'background' || clip._timelineRole === 'source_audio';
                if (isSequenced) {
                    this._tracks.forEach((track, ti) => {
                        if (track.type === 'video' || track.type === 'audio') {
                            (track.clips || []).forEach((c, ci) => {
                                if (c && c.start >= origEnd - 0.05 && !linked.some(l => l.trackIdx === ti && l.clipIdx === ci)) {
                                    followingClips.push({ trackIdx: ti, clipIdx: ci, clip: c, origStart: c.start, origEnd: c.end });
                                }
                            });
                        }
                    });
                }
                this._drag = { type: 'trim_start', trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx, origStart: clip.start, origEnd: clip.end, isSequenced, mx0: mx, linked, followingClips };
            } else if (hitInfo.zone === 'end') {
                const linked = clip._linkGroupId ? this._findLinkedClipRefs(clip._linkGroupId) : [{ trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx, clip, origStart: clip.start, origEnd: clip.end }];
                const followingClips = [];
                const origEnd = clip.end;
                const isSequenced = clip._isLoopInstance || clip._timelineRole === 'background' || clip._timelineRole === 'source_audio';
                if (isSequenced) {
                    this._tracks.forEach((track, ti) => {
                        if (track.type === 'video' || track.type === 'audio') {
                            (track.clips || []).forEach((c, ci) => {
                                if (c && c.start >= origEnd - 0.05 && !linked.some(l => l.trackIdx === ti && l.clipIdx === ci)) {
                                    followingClips.push({ trackIdx: ti, clipIdx: ci, clip: c, origStart: c.start, origEnd: c.end });
                                }
                            });
                        }
                    });
                }
                this._drag = { type: 'trim_end', trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx, origStart: clip.start, origEnd: clip.end, isSequenced, mx0: mx, linked, followingClips };
            } else {
                const groupMap = new Map();
                this._selectedClipRefs().forEach(item => {
                    groupMap.set(`${item.trackIdx}_${item.clipIdx}`, { ...item, origStart: item.clip.start, origEnd: item.clip.end });
                });
                if (clip._linkGroupId) {
                    this._findLinkedClipRefs(clip._linkGroupId).forEach(item => {
                        groupMap.set(`${item.trackIdx}_${item.clipIdx}`, item);
                    });
                }
                const group = Array.from(groupMap.values());
                this._drag = {
                    type: 'move', trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx,
                    origStart: clip.start, origEnd: clip.end, mx0: mx, group,
                };
            }

            // 编辑片段后保持当前尺子比例；预览时长的后续刷新不能把视图拉伸/压缩。
            if (this._drag && this._drag.type !== 'playhead') {
                this._autoFitDuration = false;
                this._hasManualTimelineView = true;
                if (this.onEditStart) {
                    this.onEditStart({
                        type: this._drag.type,
                        trackIdx: hitInfo.trackIdx,
                        clipIdx: hitInfo.clipIdx,
                        clip,
                    });
                }
            }

            if (this.onClipSelect) this.onClipSelect(hitInfo.trackIdx, hitInfo.clipIdx, clip);
        } else {
            const keepExisting = e.ctrlKey || e.metaKey || e.shiftKey;
            const baseSelection = keepExisting ? new Set(this._selectedClips) : new Set();
            if (!keepExisting) this._clearClipSelection();
            // 空白拖动执行框选；未发生拖动时 mouseup 仍按普通点击执行 seek。
            this._drag = {
                type: 'marquee', mx0: mx, my0: my, mx1: mx, my1: my,
                moved: false, baseSelection,
            };
        }
    }

    _onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (this._bladeTool) {
            this._bladeHoverX = (mx >= TL_HEADER_W && my >= TL_RULER_H && mx <= rect.width) ? mx : null;
            this._render();
        }

        // Drag
        if (this._drag) {
            const dxPx = mx - this._drag.mx0;
            const dyPx = my - (this._drag.my0 || 0);
            if (Math.abs(dxPx) >= 2 || Math.abs(dyPx) >= 2) {
                this._drag.moved = true;
            }
            const dt = dxPx / this._pxPerSec;

            if (this._drag.type === 'playhead') {
                this._seekToX(mx, 'mousemove');
                return;
            }

            if (this._drag.type === 'marquee') {
                this._drag.mx1 = mx;
                this._drag.my1 = my;
                if (this._drag.moved) this._updateMarqueeSelection(this._drag);
                return;
            }

            const clip = this._tracks[this._drag.trackIdx]?.clips[this._drag.clipIdx];
            if (!clip) return;

            const snapThresholdSec = Math.max(0.02, 6 / this._pxPerSec);

            if (this._drag.type === 'cut_in') {
                const dt = (mx - this._drag.mx0) / this._pxPerSec;
                let newInT = Math.max(0, Math.min(this._drag.origOutT - 0.05, this._drag.origInT + dt));
                newInT = this._snapToFrame(newInT);
                clip.inT = newInT;
                clip._trimHead = newInT;

                this._tracks.forEach(track => {
                    const comp = track.clips?.[this._drag.clipIdx];
                    if (comp && comp !== clip && (comp._reviewRow === clip._reviewRow || comp._linkGroupId === clip._linkGroupId)) {
                        comp.inT = newInT;
                        comp._trimHead = newInT;
                    }
                });

                if (this.onClipChange) {
                    this.onClipChange(this._drag.trackIdx, this._drag.clipIdx, clip, {
                        editMode: 'cut_in',
                        inT: newInT,
                        outT: clip.outT !== undefined ? clip.outT : this._drag.origOutT,
                    });
                }
                this._render();
                return;
            } else if (this._drag.type === 'cut_out') {
                const dt = (mx - this._drag.mx0) / this._pxPerSec;
                const maxDur = this._drag.sourceDuration || (clip.end - clip.start);
                let newOutT = Math.max(this._drag.origInT + 0.05, Math.min(maxDur, this._drag.origOutT + dt));
                newOutT = this._snapToFrame(newOutT);
                clip.outT = newOutT;
                clip._trimTail = Math.max(0, maxDur - newOutT);

                this._tracks.forEach(track => {
                    const comp = track.clips?.[this._drag.clipIdx];
                    if (comp && comp !== clip && (comp._reviewRow === clip._reviewRow || comp._linkGroupId === clip._linkGroupId)) {
                        comp.outT = newOutT;
                        comp._trimTail = Math.max(0, maxDur - newOutT);
                    }
                });

                if (this.onClipChange) {
                    this.onClipChange(this._drag.trackIdx, this._drag.clipIdx, clip, {
                        editMode: 'cut_out',
                        inT: clip.inT !== undefined ? clip.inT : this._drag.origInT,
                        outT: newOutT,
                    });
                }
                this._render();
                return;
            } else if (this._drag.type === 'trim_start') {
                const maxTrim = (this._drag.origEnd - this._drag.origStart) - 0.05;
                
                if (this._drag.isSequenced) {
                    // 连续背景轨的左手柄只表示从开头裁短；向左扩展会破坏
                    // 无缝序列，因此仍限制为非负裁切量。
                    const dtTrim = Math.max(0, Math.min(dt, maxTrim));
                    this._drag.lastTrimOffset = dtTrim;
                    const newEnd = Math.max(this._drag.origStart + 0.05, this._drag.origEnd - dtTrim);
                    clip.start = this._drag.origStart;
                    clip.end = newEnd;
                    if (Array.isArray(this._drag.linked)) {
                        for (const item of this._drag.linked) {
                            item.clip.start = this._drag.origStart;
                            item.clip.end = newEnd;
                        }
                    }
                    if (Array.isArray(this._drag.followingClips)) {
                        for (const item of this._drag.followingClips) {
                            item.clip.start = Math.max(newEnd, item.origStart - dtTrim);
                            item.clip.end = Math.max(item.clip.start + 0.05, item.origEnd - dtTrim);
                        }
                    }
                    this._render();
                    return;
                } else {
                    // 独立片段（尤其是字幕）需要能把入点向前延长到 0 秒。
                    // 之前复用了背景裁切的 dtTrim（被锁为 >= 0），使左手柄
                    // 完全无法往左拖。
                    const newStart = Math.max(0, Math.min(this._drag.origEnd - 0.05, this._drag.origStart + dt));
                    this._drag.lastTrimOffset = newStart - this._drag.origStart;
                    clip.start = newStart;
                    clip.end = this._drag.origEnd;
                    if (Array.isArray(this._drag.linked)) {
                        for (const item of this._drag.linked) {
                            item.clip.start = newStart;
                            item.clip.end = this._drag.origEnd;
                        }
                    }
                    if (this._tracks[this._drag.trackIdx]?.type === 'subs' && this.onClipChange) {
                        this.onClipChange(this._drag.trackIdx, this._drag.clipIdx, clip, {
                            editMode: 'trim_start',
                            origStart: this._drag.origStart,
                            origEnd: this._drag.origEnd,
                            isEnd: false,
                        });
                    }
                    this._render();
                    return;
                }
            } else if (this._drag.type === 'trim_end') {
                let newEnd = Math.max(this._drag.origStart + 0.05, this._drag.origEnd + dt);
                const delta = newEnd - this._drag.origEnd;
                clip.end = newEnd;
                if (Array.isArray(this._drag.linked)) {
                    for (const item of this._drag.linked) {
                        item.clip.end = newEnd;
                    }
                }
                if (Array.isArray(this._drag.followingClips)) {
                    for (const item of this._drag.followingClips) {
                        item.clip.start = Math.max(newEnd, item.origStart + delta);
                        item.clip.end = Math.max(item.clip.start + 0.05, item.origEnd + delta);
                    }
                }
                if (this._tracks[this._drag.trackIdx]?.type === 'subs' && this.onClipChange) {
                    this.onClipChange(this._drag.trackIdx, this._drag.clipIdx, clip, {
                        editMode: 'trim_end',
                        origStart: this._drag.origStart,
                        origEnd: this._drag.origEnd,
                        isEnd: false,
                    });
                }
                this._render();
                return;
            } else if (this._drag.type === 'move') {
                const group = this._drag.group || [];
                const minStart = group.length > 0
                    ? Math.min(...group.map(item => item.origStart))
                    : this._drag.origStart;
                let safeDt = dt;
                // 磁吸到 0.0s 边界
                if (minStart + dt < snapThresholdSec && minStart + dt > -snapThresholdSec) {
                    safeDt = -minStart;
                } else {
                    safeDt = Math.max(dt, -minStart);
                }
                for (const item of group) {
                    item.clip.start = item.origStart + safeDt;
                    item.clip.end = item.origEnd + safeDt;
                    if (this._tracks[item.trackIdx]?.type === 'subs' && this.onClipChange) {
                        this.onClipChange(item.trackIdx, item.clipIdx, item.clip, {
                            editMode: 'move',
                            origStart: item.origStart,
                            origEnd: item.origEnd,
                            isEnd: false,
                        });
                    }
                }
                this._render();
                return;
            }
            return;
        }

        // Hover
        if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) {
            this._hoveredClip = null;
            this._hoveredZone = null;
            this._hideTooltip();
            return;
        }

        const hitInfo = this._hitTestClip(mx, my);
        this._hoveredClip = hitInfo ? { trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx } : null;
        this._hoveredZone = hitInfo ? hitInfo.zone : null;

        if (hitInfo) {
            if (hitInfo.zone === 'cut_in') {
                this.canvas.style.cursor = 'col-resize';
            } else if (hitInfo.zone === 'cut_out') {
                this.canvas.style.cursor = 'col-resize';
            } else if (hitInfo.zone === 'start' || hitInfo.zone === 'end') {
                this.canvas.style.cursor = 'col-resize';
            } else {
                this.canvas.style.cursor = 'grab';
            }
            this.canvas.removeAttribute('title');
            this._showTooltip(hitInfo, mx, my);
            this._render();
        } else {
            this._hideTooltip();
            if (mx < TL_HEADER_W && my >= TL_RULER_H) {
                const trackIdx = this._trackIndexAtY(my);
                if (trackIdx >= 0 && trackIdx < this._tracks.length && mx >= TL_HEADER_W - 28 && mx <= TL_HEADER_W - 2) {
                    this.canvas.style.cursor = 'pointer';
                    const track = this._tracks[trackIdx];
                    this.canvas.title = track.visible === false ? '点击显示此轨道 (取消静默)' : '点击隐藏此轨道 (临时静默)';
                } else {
                    this.canvas.style.cursor = 'default';
                    this.canvas.title = '';
                }
            } else if (this._hitTestGap(mx, my)) {
                this.canvas.style.cursor = 'default';
                this.canvas.title = '右键菜单可补充背景循环至结尾';
            } else if (my < TL_RULER_H && mx >= TL_HEADER_W) {
                this.canvas.style.cursor = 'pointer';
                this.canvas.title = '';
            } else {
                this.canvas.style.cursor = 'default';
                this.canvas.title = '';
            }
        }
    }

    _onMouseUp(e) {
        const marquee = this._drag && this._drag.type === 'marquee' ? this._drag : null;
        const wasRealMove = this._drag && this._drag.moved;
        const edit = this._drag && wasRealMove && !['playhead', 'marquee'].includes(this._drag.type)
            ? {
                type: this._drag.type,
                trackIdx: this._drag.trackIdx,
                clipIdx: this._drag.clipIdx,
                clip: this._tracks[this._drag.trackIdx]?.clips[this._drag.clipIdx],
                trimOffset: this._drag.lastTrimOffset || 0,
                origStart: this._drag.origStart,
                origEnd: this._drag.origEnd,
                origInT: this._drag.origInT,
                origOutT: this._drag.origOutT,
                inT: this._tracks[this._drag.trackIdx]?.clips[this._drag.clipIdx]?.inT,
                outT: this._tracks[this._drag.trackIdx]?.clips[this._drag.clipIdx]?.outT,
                group: Array.isArray(this._drag.group) ? this._drag.group.slice() : null,
                isEnd: true,
            }
            : null;
        this._drag = null;
        if (edit && edit.clip && this.onClipChange) {
            if (edit.type === 'move' && Array.isArray(edit.group) && edit.group.length > 1) {
                for (const item of edit.group) {
                    if (!item || !item.clip) continue;
                    this.onClipChange(item.trackIdx, item.clipIdx, item.clip, {
                        editMode: edit.type,
                        trimOffset: edit.trimOffset,
                        origStart: item.origStart,
                        origEnd: item.origEnd,
                        isEnd: true,
                    });
                }
            } else {
                this.onClipChange(edit.trackIdx, edit.clipIdx, edit.clip, {
                    editMode: edit.type,
                    trimOffset: edit.trimOffset,
                    origStart: edit.origStart,
                    origEnd: edit.origEnd,
                    origInT: edit.origInT,
                    origOutT: edit.origOutT,
                    inT: edit.inT,
                    outT: edit.outT,
                    isEnd: true,
                });
            }
        }
        if (edit && edit.clip && this.onEditEnd) this.onEditEnd(edit);
        // mousedown/mousemove 已经把最终位置同步到预览；这里不要再发一个完全
        // 相同的 seek。旧逻辑会令异步视频 seek 互相取消，表现为播放头闪跳。
        if (marquee && !marquee.moved) {
            this._seekToX(marquee.mx0, 'mousedown');
        }
    }

    zoom(factor, centerTimeSec = null) {
        this._autoFitDuration = false;
        this._hasManualTimelineView = true;
        const availableW = Math.max(10, (this._canvasW || 800) - TL_HEADER_W - 24);
        const centerTime = (centerTimeSec !== null && Number.isFinite(centerTimeSec))
            ? centerTimeSec
            : (this._playheadPos || 0);

        const currentCenterX = centerTime * this._pxPerSec - this._scrollX;
        const newPxPerSec = Math.max(2, Math.min(2000, this._pxPerSec * factor));

        const targetScreenX = (currentCenterX >= 0 && currentCenterX <= availableW)
            ? currentCenterX
            : (availableW / 2);

        this._pxPerSec = newPxPerSec;
        this._scrollX = Math.max(0, centerTime * newPxPerSec - targetScreenX);
        this._render();
    }

    zoomIn(centerTime = null) {
        this.zoom(1.35, centerTime);
    }

    zoomOut(centerTime = null) {
        this.zoom(0.74, centerTime);
    }

    zoomFit() {
        this._autoFitDuration = true;
        this._hasManualTimelineView = false;
        this._scrollX = 0;
        this._fitDurationToViewport();
        this._render();
    }

    zoomToClip(clip) {
        if (!clip) return;
        const start = Number(clip.start) || 0;
        const end = Number(clip.end) || (start + 1);
        const dur = Math.max(0.1, end - start);
        const availableW = Math.max(10, (this._canvasW || 800) - TL_HEADER_W - 40);
        // 让当前片段占据可视区域约 65% 的宽度，方便超精细裁剪入出点
        const targetPxPerSec = Math.max(5, Math.min(2000, (availableW * 0.65) / dur));
        this._autoFitDuration = false;
        this._hasManualTimelineView = true;
        this._pxPerSec = targetPxPerSec;
        const clipMidTime = start + dur / 2;
        this._scrollX = Math.max(0, clipMidTime * targetPxPerSec - (availableW / 2));
        this._render();
    }

    _onWheel(e) {
        e.preventDefault();

        if (e.ctrlKey || e.metaKey) {
            // 围绕鼠标指针平滑缩放
            this._autoFitDuration = false;
            this._hasManualTimelineView = true;
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = Math.max(0, e.clientX - rect.left - TL_HEADER_W);
            const timeAtMouse = Math.max(0, (mouseX + this._scrollX) / this._pxPerSec);
            const factor = e.deltaY > 0 ? 0.82 : 1.22;
            const newPxPerSec = Math.max(2, Math.min(2000, this._pxPerSec * factor));
            this._scrollX = Math.max(0, timeAtMouse * newPxPerSec - mouseX);
            this._pxPerSec = newPxPerSec;
            this._render();
        } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
            // 触控板水平平移
            this._hasManualTimelineView = true;
            this._scrollX = Math.max(0, this._scrollX + e.deltaX);
            this._render();
        } else if (e.shiftKey) {
            // Shift + 滚轮水平平移
            this._hasManualTimelineView = true;
            this._scrollX = Math.max(0, this._scrollX + e.deltaY);
            this._render();
        } else {
            // 普通滚轮：若轨道高度超出视口则优先纵向平滑滚动，否则水平滚动
            const totalContentH = TL_RULER_H + this._tracks.length * (TL_TRACK_HEIGHT + 1) + 12;
            const rect = this.canvas.getBoundingClientRect();
            if (totalContentH > rect.height && rect.height > 0) {
                const maxScrollY = Math.max(0, totalContentH - rect.height);
                this._scrollY = Math.max(0, Math.min(maxScrollY, this._scrollY + e.deltaY));
            } else {
                this._hasManualTimelineView = true;
                this._scrollX = Math.max(0, this._scrollX + e.deltaY);
            }
            this._render();
        }
    }

    _onKeyDown(e) {
        if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'a') {
            e.preventDefault();
            const preferredTrack = this._selectedClip?.trackIdx
                ?? this._hoveredClip?.trackIdx
                ?? this._tracks.findIndex(track => track.type === 'subs');
            const trackIdx = preferredTrack >= 0 ? preferredTrack : 0;
            const track = this._tracks[trackIdx];
            this._selectedClips.clear();
            if (track && !track.locked) {
                for (let ci = 0; ci < track.clips.length; ci++) {
                    this._selectedClips.add(this._clipKey(trackIdx, ci));
                }
            }
            this._selectedClip = this._firstSelectedClip();
            if (this._selectedClip) this._selectionAnchor = { ...this._selectedClip };
        } else if (e.key === 'Escape') {
            if (this._bladeTool) this.setBladeTool(false);
            this._clearClipSelection();
        }
    }

    // ═══════════════════════════════════════════════
    // Hit Testing
    // ═══════════════════════════════════════════════

    _hitTestClip(mx, my) {
        let y = TL_RULER_H - this._scrollY;

        for (let ti = 0; ti < this._tracks.length; ti++) {
            const track = this._tracks[ti];

            if (my >= y && my < y + TL_TRACK_HEIGHT) {
                for (let ci = 0; ci < track.clips.length; ci++) {
                    const clip = track.clips[ci];
                    const cx = TL_HEADER_W + clip.start * this._pxPerSec - this._scrollX;
                    const cw = Math.max(TL_MIN_CLIP_W, (clip.end - clip.start) * this._pxPerSec);

                    if (mx >= cx - 8 && mx <= cx + cw + 8) {
                        const HANDLE_HIT_PX = 8;
                        const hasInternalCuts = (track.type === 'video' || track.type === 'audio') && (clip.inT !== undefined || clip._trimHead !== undefined || clip.outT !== undefined || clip._trimTail !== undefined);
                        
                        if (hasInternalCuts) {
                            const inT = clip.inT !== undefined ? clip.inT : (clip._trimHead || 0);
                            const sourceDur = clip.sourceDuration || (clip.end - clip.start);
                            const outT = clip.outT !== undefined ? clip.outT : (clip.sourceDuration && clip._trimTail !== undefined ? clip.sourceDuration - clip._trimTail : sourceDur);
                            
                            const inW = Math.max(0, Math.min(cw, inT * this._pxPerSec));
                            const outW = Math.max(inW, Math.min(cw, outT * this._pxPerSec));
                            
                            const cutInX = cx + inW;
                            const cutOutX = cx + outW;
                            const distIn = Math.abs(mx - cutInX);
                            const distOut = Math.abs(mx - cutOutX);

                            if (distIn <= HANDLE_HIT_PX && distIn <= distOut) {
                                return { trackIdx: ti, clipIdx: ci, zone: 'cut_in' };
                            }
                            if (distOut <= HANDLE_HIT_PX) {
                                return { trackIdx: ti, clipIdx: ci, zone: 'cut_out' };
                            }
                        }

                        let zone = 'body';
                        if (Math.abs(mx - cx) <= TL_HANDLE_W) zone = 'start';
                        if (Math.abs(mx - (cx + cw)) <= TL_HANDLE_W) zone = 'end';
                        return { trackIdx: ti, clipIdx: ci, zone };
                    }
                }
            }
            y += TL_TRACK_HEIGHT + 1;
            // 域分离间隔
            if (ti < this._tracks.length - 1 &&
                track.domain === 'visual' && this._tracks[ti + 1]?.domain === 'audio') {
                y += 4;
            }
        }
        return null;
    }

    _hitTestGap(mx, my) {
        let y = TL_RULER_H - this._scrollY;
        for (let ti = 0; ti < this._tracks.length; ti++) {
            const track = this._tracks[ti];
            const isBackgroundTrack = track.type === 'video' || (track.name && track.name.includes('背景'));
            if (isBackgroundTrack && track.clips && track.clips.length > 0) {
                if (my >= y && my < y + TL_TRACK_HEIGHT) {
                    const maxEnd = Math.max(0, ...track.clips.map(c => c.end || 0));
                    if (this._duration > maxEnd + 0.1) {
                        const gx0 = TL_HEADER_W + maxEnd * this._pxPerSec - this._scrollX;
                        const gx1 = TL_HEADER_W + this._duration * this._pxPerSec - this._scrollX;
                        if (mx >= Math.max(TL_HEADER_W, gx0) && mx <= gx1) {
                            return { trackIdx: ti, gapStart: maxEnd, gapEnd: this._duration };
                        }
                    }
                }
            }
            y += TL_TRACK_HEIGHT + 1;
            if (ti < this._tracks.length - 1 && track.domain === 'visual' && this._tracks[ti + 1]?.domain === 'audio') {
                y += 4;
            }
        }
        return null;
    }

    _onContextMenu(e) {
        const oldMenu = document.getElementById('reels-timeline-ctx-menu');
        if (oldMenu) oldMenu.remove();

        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const hitInfo = this._hitTestClip(mx, my);
        const headerTrackIdx = mx < TL_HEADER_W ? this._trackIndexAtY(my) : -1;
        if (hitInfo) {
            if (this._bladeTool) {
                this.canvas.style.cursor = 'crosshair';
                this.canvas.title = '切刀：单击片段即可在该位置切开；Esc 退出切刀';
                return;
            }
            const key = this._clipKey(hitInfo.trackIdx, hitInfo.clipIdx);
            if (!this._selectedClips.has(key)) {
                this._selectedClips.clear();
                this._selectedClips.add(key);
                this._selectedClip = { trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx };
            }
        }

        const menu = document.createElement('div');
        menu.id = 'reels-timeline-ctx-menu';
        Object.assign(menu.style, {
            position: 'fixed',
            left: `${Math.min(window.innerWidth - 200, e.clientX)}px`,
            top: `${Math.min(window.innerHeight - 180, e.clientY)}px`,
            zIndex: '999999',
            background: 'rgba(23, 23, 28, 0.96)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            borderRadius: '8px',
            padding: '6px',
            boxShadow: '0 10px 28px rgba(0, 0, 0, 0.6)',
            color: '#eee',
            fontSize: '12px',
            minWidth: '190px',
            userSelect: 'none',
        });

        const items = [
            {
                icon: '🔄',
                text: '补充背景循环至结尾',
                shortcut: 'Auto-Fill',
                action: () => { if (this.onFillGap) this.onFillGap(); },
            },
            {
                icon: '⏮️',
                text: '磁吸对齐到 0.0s 开头',
                action: () => {
                    const selected = this._selectedClipRefs();
                    if (selected.length > 0) {
                        const minStart = Math.min(...selected.map(s => s.clip.start));
                        selected.forEach(s => {
                            const dur = s.clip.end - s.clip.start;
                            s.clip.start -= minStart;
                            s.clip.end = s.clip.start + dur;
                            if (this.onClipChange) this.onClipChange(s.trackIdx, s.clipIdx, s.clip, { editMode: 'move' });
                        });
                        if (this.onEditEnd) this.onEditEnd();
                    }
                },
            },
            {
                icon: '✂️',
                text: '在播放头处切分 (Split)',
                shortcut: 'S',
                action: () => {
                    this._splitClipAtPlayhead();
                },
            },
            {
                icon: '🗑️',
                text: '删除选中片段 (Delete)',
                shortcut: 'Del',
                danger: true,
                action: () => {
                    this._deleteSelectedClips();
                },
            },
        ];
        if (headerTrackIdx >= 0) {
            items.unshift(
                { icon: '⬆️', text: '轨道上移（更高层）', action: () => this.moveTrack(headerTrackIdx, 'up') },
                { icon: '⬇️', text: '轨道下移（更低层）', action: () => this.moveTrack(headerTrackIdx, 'down') },
            );
        }
        let finalItems = items;
        if (hitInfo && typeof this.onClipContextMenu === 'function') {
            const extra = this.onClipContextMenu(hitInfo.trackIdx, hitInfo.clipIdx, this._tracks[hitInfo.trackIdx]?.clips?.[hitInfo.clipIdx]);
            if (Array.isArray(extra)) {
                finalItems = [...extra, ...items];
            } else if (extra && Array.isArray(extra.items)) {
                finalItems = extra.override ? extra.items : [...extra.items, ...items];
            }
        }

        finalItems.forEach(item => {
            const btn = document.createElement('div');
            Object.assign(btn.style, {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                borderRadius: '5px',
                cursor: 'pointer',
                transition: 'background 0.1s ease',
                color: item.danger ? '#f87171' : '#ddd',
            });
            btn.innerHTML = `
                <div style="display:flex;align-items:center;gap:6px;">
                    <span style="font-size:13px;">${item.icon}</span>
                    <span>${item.text}</span>
                </div>
                ${item.shortcut ? `<span style="font-size:10px;color:rgba(255,255,255,0.4);">${item.shortcut}</span>` : ''}
            `;
            btn.onmouseenter = () => { btn.style.background = item.danger ? 'rgba(239, 68, 68, 0.25)' : 'rgba(255, 255, 255, 0.08)'; };
            btn.onmouseleave = () => { btn.style.background = 'transparent'; };
            btn.onclick = (ev) => {
                ev.stopPropagation();
                menu.remove();
                item.action();
            };
            menu.appendChild(btn);
        });

        document.body.appendChild(menu);

        const closeMenu = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.remove();
                document.removeEventListener('mousedown', closeMenu, true);
                document.removeEventListener('keydown', handleEsc, true);
            }
        };
        const handleEsc = (ev) => {
            if (ev.key === 'Escape') {
                menu.remove();
                document.removeEventListener('mousedown', closeMenu, true);
                document.removeEventListener('keydown', handleEsc, true);
            }
        };
        setTimeout(() => {
            document.addEventListener('mousedown', closeMenu, true);
            document.addEventListener('keydown', handleEsc, true);
        }, 10);
    }

    _trackIndexAtY(my) {
        let y = TL_RULER_H - this._scrollY;
        for (let index = 0; index < this._tracks.length; index++) {
            if (my >= y && my < y + TL_TRACK_HEIGHT) return index;
            y += TL_TRACK_HEIGHT + 1;
            if (index < this._tracks.length - 1 && this._tracks[index].domain === 'visual' && this._tracks[index + 1]?.domain === 'audio') y += 4;
        }
        return -1;
    }

    setBladeTool(active) {
        this._bladeTool = Boolean(active);
        if (!this._bladeTool) this._bladeHoverX = null;
        this.canvas.style.cursor = this._bladeTool ? 'crosshair' : 'default';
        this.canvas.title = this._bladeTool ? '切刀已启用：单击片段切开；Esc 退出' : '';
        const bladeButton = document.getElementById('reels-timeline-blade');
        if (bladeButton) {
            bladeButton.style.background = this._bladeTool ? 'rgba(239,68,68,.48)' : 'rgba(239,68,68,.18)';
            bladeButton.style.color = this._bladeTool ? '#fff' : '#fecaca';
            bladeButton.textContent = this._bladeTool ? '✂️ 切刀已开启' : '✂️ 切刀';
        }
        this._render();
    }

    _splitClipAtPlayhead() {
        const selected = this._selectedClipRefs();
        if (!selected.length) return;
        const first = selected[0];
        this._splitClipAt(first.trackIdx, first.clipIdx, this._currentTime);
    }

    _splitClipAt(trackIdx, clipIdx, t) {
        const first = { trackIdx, clipIdx, clip: this._tracks[trackIdx]?.clips?.[clipIdx] };
        const clip = first.clip;
        if (!clip) return;
        if (this.onClipSplit && this.onClipSplit(first.trackIdx, first.clipIdx, clip, t)) return;
        if (t > clip.start + 0.05 && t < clip.end - 0.05) {
            const oldEnd = clip.end;
            clip.end = t;
            const newClip = {
                ...clip,
                start: t,
                end: oldEnd,
                _timelineClipId: undefined,
            };
            const track = this._tracks[first.trackIdx];
            if (track) {
                track.clips.splice(first.clipIdx + 1, 0, newClip);
                if (this.onClipChange) this.onClipChange(first.trackIdx, first.clipIdx, clip, { editMode: 'trim_end' });
                if (this.onEditEnd) this.onEditEnd();
            }
        }
    }

    _deleteSelectedClips() {
        const selected = this._selectedClipRefs();
        if (!selected.length) return;
        selected.sort((a, b) => b.clipIdx - a.clipIdx);
        for (const item of selected) {
            const track = this._tracks[item.trackIdx];
            if (track && !track.locked) {
                if (this.onClipDelete && this.onClipDelete(item.trackIdx, item.clipIdx, item.clip)) continue;
                track.clips.splice(item.clipIdx, 1);
            }
        }
        this._clearClipSelection();
        if (this.onEditEnd) this.onEditEnd();
    }

    // ═══════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════

    _clipKey(trackIdx, clipIdx) {
        return `${trackIdx}:${clipIdx}`;
    }

    _clearClipSelection() {
        this._selectedClips.clear();
        this._selectedClip = null;
        this._selectionAnchor = null;
    }

    _firstSelectedClip() {
        const first = this._selectedClips.values().next().value;
        if (!first) return null;
        const [trackIdx, clipIdx] = first.split(':').map(Number);
        return { trackIdx, clipIdx };
    }

    _selectedClipRefs() {
        const refs = [];
        for (const key of this._selectedClips) {
            const [trackIdx, clipIdx] = key.split(':').map(Number);
            const clip = this._tracks[trackIdx]?.clips[clipIdx];
            if (clip) refs.push({ trackIdx, clipIdx, clip });
        }
        return refs;
    }

    _updateMarqueeSelection(drag) {
        const left = Math.min(drag.mx0, drag.mx1);
        const right = Math.max(drag.mx0, drag.mx1);
        const top = Math.min(drag.my0, drag.my1);
        const bottom = Math.max(drag.my0, drag.my1);
        const selected = new Set(drag.baseSelection || []);

        for (let ti = 0; ti < this._tracks.length; ti++) {
            const track = this._tracks[ti];
            for (let ci = 0; ci < track.clips.length; ci++) {
                const rect = this._getClipCanvasRect(ti, ci);
                if (rect.x < right && rect.x + rect.w > left && rect.y < bottom && rect.y + rect.h > top) {
                    selected.add(this._clipKey(ti, ci));
                }
            }
        }
        this._selectedClips = selected;
        this._selectedClip = this._firstSelectedClip();
    }

    _drawMarquee(ctx) {
        if (!this._drag || this._drag.type !== 'marquee' || !this._drag.moved) return;
        const x = Math.min(this._drag.mx0, this._drag.mx1);
        const y = Math.min(this._drag.my0, this._drag.my1);
        const w = Math.abs(this._drag.mx1 - this._drag.mx0);
        const h = Math.abs(this._drag.my1 - this._drag.my0);
        ctx.save();
        ctx.fillStyle = 'rgba(76,158,255,0.16)';
        ctx.strokeStyle = TL_COLORS.selected;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 3]);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
    }

    _getClipCanvasRect(trackIdx, clipIdx) {
        const clip = this._tracks[trackIdx]?.clips[clipIdx];
        if (!clip) return { x: 0, y: 0, w: 0, h: 0 };
        let trackY = TL_RULER_H - this._scrollY;
        for (let ti = 0; ti < trackIdx; ti++) {
            trackY += TL_TRACK_HEIGHT + 1;
            if (ti < this._tracks.length - 1 &&
                (this._tracks[ti].domain || 'visual') === 'visual' &&
                (this._tracks[ti + 1]?.domain || 'visual') === 'audio') trackY += 4;
        }
        return {
            x: TL_HEADER_W + clip.start * this._pxPerSec - this._scrollX,
            y: trackY + 3,
            w: Math.max(TL_MIN_CLIP_W, (clip.end - clip.start) * this._pxPerSec),
            h: TL_TRACK_HEIGHT - 6,
        };
    }

    _seekToX(mx, type) {
        const t = (mx - TL_HEADER_W + this._scrollX) / this._pxPerSec;
        this._playheadPos = Math.max(0, Math.min(this._duration, this._snapToFrame(t)));
        if (this.onSeek) this.onSeek(this._playheadPos, type);
    }

    /** 获取片段在屏幕上的绝对像素矩形 */
    _getClipScreenRect(trackIdx, clipIdx) {
        const canvasRect = this.canvas.getBoundingClientRect();
        const clip = this._tracks[trackIdx]?.clips[clipIdx];
        if (!clip) return { x: 0, y: 0, w: 100, h: TL_TRACK_HEIGHT };

        let trackY = TL_RULER_H - this._scrollY;
        for (let ti = 0; ti < trackIdx; ti++) {
            trackY += TL_TRACK_HEIGHT + 1;
            if (ti < this._tracks.length - 1 &&
                (this._tracks[ti].domain || 'visual') === 'visual' &&
                (this._tracks[ti + 1]?.domain || 'visual') === 'audio') {
                trackY += 4;
            }
        }
        const clipX = TL_HEADER_W + clip.start * this._pxPerSec - this._scrollX;
        const clipW = Math.max(TL_MIN_CLIP_W, (clip.end - clip.start) * this._pxPerSec);
        return {
            x: canvasRect.left + clipX,
            y: canvasRect.top + trackY,
            w: clipW,
            h: TL_TRACK_HEIGHT,
        };
    }

    // ═══════════════════════════════════════════════
    // 浮动字幕编辑器
    // ═══════════════════════════════════════════════

    _openSubtitleEditor(trackIdx, clipIdx, clip, rect) {
        if (this._rtEditor) {
            this._rtEditor.close(false);
        }

        const rtEditor = new ReelsRichTextEditor();
        this._rtEditor = rtEditor;

        rtEditor.onSave = (newText, newRanges, styleOverride) => {
            const track = this._tracks[trackIdx];
            if (track && track.clips[clipIdx]) {
                const oldText = track.clips[clipIdx]._fullText || track.clips[clipIdx].name;
                track.clips[clipIdx]._fullText = newText;
                track.clips[clipIdx].name = newText.slice(0, 20) + (newText.length > 20 ? '…' : '');
                track.clips[clipIdx].styled_ranges = newRanges || null;
                track.clips[clipIdx].style_override = styleOverride || null;
                if (this.onSubtitleEdit) {
                    this.onSubtitleEdit(trackIdx, clipIdx, newText, oldText, newRanges, styleOverride);
                }
            }
            this._rtEditor = null;
        };

        // 实时预览：编辑中实时同步到 segment 并刷新画布
        rtEditor.onChange = (newText, newRanges, styleOverride) => {
            const track = this._tracks[trackIdx];
            if (track && track.clips[clipIdx]) {
                track.clips[clipIdx]._fullText = newText;
                track.clips[clipIdx].styled_ranges = newRanges || null;
                track.clips[clipIdx].style_override = styleOverride || null;
                if (this.onSubtitleEdit) {
                    this.onSubtitleEdit(trackIdx, clipIdx, newText, 
                        track.clips[clipIdx]._fullText, newRanges, styleOverride);
                }
            }
        };

        rtEditor.onCancel = () => {
            this._rtEditor = null;
        };

        rtEditor.open({
            title: `✎ 编辑字幕 #${clipIdx + 1}`,
            text: clip._fullText || clip.name || '',
            styled_ranges: clip.styled_ranges || [],
            style_override: clip.style_override || {},
            baseStyle: this.subtitleBaseStyle || {},
            rect: rect,
            trackIdx,
            clipIdx
        });
    }

    _closeSubtitleEditor(save) {
        if (this._rtEditor) {
            this._rtEditor.close(save);
        }
    }



    _calcRulerStep() {
        const minStepPx = 60;
        const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
        for (const s of steps) {
            if (s * this._pxPerSec >= minStepPx) return s;
        }
        return 300;
    }

    _formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 10);
        if (seconds < 60) return `${s}.${ms}s`;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    _lighten(hex, amount) {
        return this._adjustColor(hex, amount);
    }
    _darken(hex, amount) {
        return this._adjustColor(hex, -amount);
    }
    _adjustColor(hex, amount) {
        hex = hex.replace('#', '');
        let r = parseInt(hex.slice(0, 2), 16);
        let g = parseInt(hex.slice(2, 4), 16);
        let b = parseInt(hex.slice(4, 6), 16);
        r = Math.max(0, Math.min(255, r + Math.round(255 * amount)));
        g = Math.max(0, Math.min(255, g + Math.round(255 * amount)));
        b = Math.max(0, Math.min(255, b + Math.round(255 * amount)));
        return `rgb(${r},${g},${b})`;
    }

    _showTooltip(hitInfo, mx, my) {
        if (!this._tooltipEl || this._drag) {
            this._hideTooltip();
            return;
        }
        const track = this._tracks[hitInfo.trackIdx];
        const clip = track?.clips?.[hitInfo.clipIdx];
        if (!track || !clip) {
            this._hideTooltip();
            return;
        }

        const isSubLike = track.type === 'subs' || track.type === 'asr' || track.type === 'script';
        const isTrimmed = clip._isTrimmed === true || clip.isTrimmed === true;
        const dur = (clip.end - clip.start);

        let badgeTitle = track.name || '片段';
        let badgeColor = '#94a3b8';
        let badgeBg = 'rgba(148, 163, 184, 0.15)';
        let badgeIcon = '📄';

        if (track.type === 'asr') {
            badgeTitle = 'AI 语音识别原文';
            badgeColor = '#38bdf8';
            badgeBg = 'rgba(56, 189, 248, 0.18)';
            badgeIcon = '🎙️';
        } else if (track.type === 'script') {
            badgeTitle = '我提供的参考文案';
            badgeColor = '#c084fc';
            badgeBg = 'rgba(192, 132, 252, 0.18)';
            badgeIcon = '📝';
        } else if (track.type === 'subs') {
            badgeTitle = '最终导出字幕';
            badgeColor = '#fbbf24';
            badgeBg = 'rgba(251, 191, 36, 0.18)';
            badgeIcon = '✨';
        } else if (track.type === 'video') {
            badgeTitle = '视频片段 (裁剪序列)';
            badgeColor = '#60a5fa';
            badgeBg = 'rgba(96, 165, 250, 0.18)';
            badgeIcon = '🎬';
        } else if (track.type === 'audio') {
            badgeTitle = '原声伴音轨';
            badgeColor = '#38bdf8';
            badgeBg = 'rgba(56, 189, 248, 0.18)';
            badgeIcon = '🔊';
        }

        const escapeHtml = str => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const contentText = clip._fullText || clip.name || '（无文字内容）';

        let statusBadge = '';
        if (isSubLike) {
            if (isTrimmed) {
                statusBadge = `<span style="display:inline-flex;align-items:center;gap:3px;color:#fca5a5;background:rgba(239,68,68,0.22);padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600;">❌ 已剪掉 (超出保留范围)</span>`;
            } else {
                statusBadge = `<span style="display:inline-flex;align-items:center;gap:3px;color:#86efac;background:rgba(34,197,94,0.2);padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600;">✅ 保留导出</span>`;
            }
        }

        let actionHint = '';
        if (hitInfo.zone === 'cut_in') {
            actionHint = `<div style="font-size:11px;color:#38bdf8;background:rgba(56,189,248,0.12);padding:4px 8px;border-radius:5px;display:flex;align-items:center;gap:4px;">↔️ <strong>正在悬停入点切线</strong>：按住左键拖动可调整片段开始时间</div>`;
        } else if (hitInfo.zone === 'cut_out') {
            actionHint = `<div style="font-size:11px;color:#fbbf24;background:rgba(251,191,36,0.12);padding:4px 8px;border-radius:5px;display:flex;align-items:center;gap:4px;">↔️ <strong>正在悬停出点切线</strong>：按住左键拖动可调整片段结束时间</div>`;
        }

        this._tooltipEl.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:6px;">
                <div style="display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:${badgeColor};background:${badgeBg};padding:2px 8px;border-radius:4px;">
                    <span>${badgeIcon}</span>
                    <span>${badgeTitle}</span>
                </div>
                ${statusBadge}
            </div>
            <div style="font-size:13px;font-weight:600;color:#ffffff;line-height:1.55;word-break:break-word;white-space:pre-wrap;max-height:140px;overflow-y:auto;user-select:none;">
                ${escapeHtml(contentText)}
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:11px;color:#94a3b8;border-top:1px solid rgba(255,255,255,0.06);padding-top:5px;">
                <span>⏱️ 时间：<strong style="color:#e2e8f0;">${clip.start.toFixed(2)}s ~ ${clip.end.toFixed(2)}s</strong></span>
                <span>时长：<strong style="color:#e2e8f0;">${dur.toFixed(2)}s</strong></span>
            </div>
            ${actionHint}
        `;

        // 位置计算 (确保不超出容器边缘)
        const containerRect = this.container.getBoundingClientRect();
        const tooltipW = Math.min(360, Math.max(220, this._tooltipEl.offsetWidth || 280));
        const tooltipH = Math.max(70, this._tooltipEl.offsetHeight || 90);

        let left = mx + 16;
        let top = my - tooltipH - 12;

        if (top < 8) {
            top = my + 22;
        }
        if (left + tooltipW > containerRect.width - 12) {
            left = mx - tooltipW - 16;
        }
        if (left < 10) left = 10;
        if (top + tooltipH > containerRect.height - 8) {
            top = containerRect.height - tooltipH - 8;
        }

        this._tooltipEl.style.left = `${left}px`;
        this._tooltipEl.style.top = `${top}px`;
        this._tooltipEl.style.opacity = '1';
    }

    _hideTooltip() {
        if (this._tooltipEl && this._tooltipEl.style.opacity !== '0') {
            this._tooltipEl.style.opacity = '0';
        }
    }
}

// ═══════════════════════════════════════════════════════
// CSS 注入
// ═══════════════════════════════════════════════════════

(function injectTimelineStyles() {
    if (document.getElementById('rte-styles')) return;
    const style = document.createElement('style');
    style.id = 'rte-styles';
    style.textContent = `
        .rte-canvas {
            display: block;
            width: 100%;
            height: 100%;
            background: ${TL_COLORS.bg};
            border-radius: 8px;
        }

        /* ── 浮动字幕编辑器 ── */
        .rte-subtitle-editor {
            position: fixed;
            z-index: 99999;
            background: linear-gradient(135deg, #1e2233, #232740);
            border: 1px solid rgba(100, 140, 255, 0.35);
            border-radius: 10px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05) inset;
            overflow: hidden;
            animation: rte-se-appear 0.15s ease-out;
            backdrop-filter: blur(12px);
        }
        @keyframes rte-se-appear {
            from { opacity: 0; transform: translateY(6px) scale(0.97); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .rte-subtitle-editor.rte-se-closing {
            animation: rte-se-disappear 0.15s ease-in forwards;
        }
        @keyframes rte-se-disappear {
            from { opacity: 1; transform: scale(1); }
            to   { opacity: 0; transform: scale(0.95); }
        }
        .rte-se-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 7px 10px;
            background: rgba(255,255,255,0.04);
            border-bottom: 1px solid rgba(255,255,255,0.07);
            cursor: default;
        }
        .rte-se-title {
            font-size: 12px;
            font-weight: 600;
            color: #c8d0e0;
        }
        .rte-se-time {
            font-size: 10px;
            color: #7a8ba8;
            font-family: monospace;
            margin-left: auto;
        }
        .rte-se-close {
            width: 20px; height: 20px;
            border: none; background: transparent;
            color: #8899aa; font-size: 12px;
            cursor: pointer; border-radius: 4px;
            display: flex; align-items: center; justify-content: center;
            transition: all 0.15s;
        }
        .rte-se-close:hover {
            background: rgba(255,80,80,0.2); color: #ff6b6b;
        }
        .rte-se-toolbar {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            background: rgba(0,0,0,0.2);
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .rt-btn {
            background: transparent; border: 1px solid rgba(255,255,255,0.1);
            color: #ddd; padding: 2px 6px; border-radius: 4px; font-size: 12px;
            cursor: pointer; transition: 0.1s;
            display: flex; align-items: center; justify-content: center; min-width: 24px;
        }
        .rt-btn:hover { background: rgba(255,255,255,0.1); }
        .rt-btn.active { background: rgba(76,158,255,0.4); border-color: #4c9eff; color: #fff; }
        .rt-divider { width: 1px; height: 14px; background: rgba(255,255,255,0.15); margin: 0 2px; }
        .rt-select {
            background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #ddd;
            padding: 2px 4px; border-radius: 4px; font-size: 11px; outline: none;
        }
        .rt-color-picker {
            width: 24px; height: 24px; border: none; background: transparent; padding: 0; cursor: pointer;
        }
        /* 取代原来的 textarea，使用 contenteditable */
        .rte-se-contenteditable {
            display: block;
            width: 100%; box-sizing: border-box;
            padding: 10px 12px;
            border: none; outline: none;
            min-height: 52px; max-height: 240px;
            overflow-y: auto;
            line-height: 1.5;
            background: rgba(0,0,0,0.25);
            caret-color: #4c9eff;
        }
        .rte-se-contenteditable::selection, .rte-se-contenteditable *::selection {
            background: rgba(76,158,255,0.4);
        }
        .rte-se-contenteditable:focus {
            background: rgba(0,0,0,0.35);
        }
        .rte-se-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 5px 10px;
            background: rgba(255,255,255,0.02);
            border-top: 1px solid rgba(255,255,255,0.06);
        }
        .rte-se-hint {
            font-size: 10px;
            color: #5a6a80;
        }
        .rte-se-save {
            padding: 3px 12px;
            border: none; border-radius: 5px;
            background: linear-gradient(135deg, #3a6ef0, #4c9eff);
            color: #fff; font-size: 11px; font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }
        .rte-se-save:hover {
            background: linear-gradient(135deg, #4a7eff, #5cafff);
            box-shadow: 0 2px 10px rgba(76,158,255,0.4);
        }
    `;
    document.head.appendChild(style);
})();

// Export
if (typeof window !== 'undefined') window.ReelsTimelineEditor = ReelsTimelineEditor;
