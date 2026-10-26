/**
 * reels-video-canvas.js — 交互式视频画布
 * 
 * 移植自 AutoSub_v8 VideoCanvas (PyQt6 QWidget → HTML Canvas)
 * 
 * 功能:
 *   - 视频预览 + 字幕实时渲染
 *   - 覆层交互: 拖拽移动、缩放、旋转
 *   - Hit testing: 点击选中覆层
 *   - 选中框 + 8个缩放手柄
 *   - 双击编辑文本覆层
 *   - 坐标系映射 (widget → video logical)
 */

class ReelsVideoCanvas {
    constructor(containerEl) {
        this.container = containerEl;

        // 视频画布 (底层)
        this.videoCanvas = document.createElement('canvas');
        this.videoCanvas.className = 'rvc-video-layer';
        this.videoCtx = this.videoCanvas.getContext('2d');

        // 叠加画布 (上层 — 覆层 + 选框)
        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.className = 'rvc-overlay-layer';
        this.overlayCtx = this.overlayCanvas.getContext('2d');

        // 视频参数
        this.videoW = 1080;
        this.videoH = 1920;
        this.videoEl = null;

        // 覆层管理器
        this.overlayMgr = new (window.ReelsOverlay?.OverlayManager || class { constructor() { this.overlays = []; } })();

        // 交互状态
        this._selected = null;          // 选中的 overlay id
        this._dragging = false;
        this._resizing = false;
        this._resizeHandle = null;
        this._dragStartMouse = null;
        this._dragStartOv = null;
        this._inlineEditor = null;
        this._currentTime = 0;

        // 渲染器
        this._renderer = null;

        // 回调
        this.onSelect = null;           // (overlay) => {}
        this.onDeselect = null;         // () => {}
        this.onOverlayChange = null;    // (overlay) => {}

        this._init();
    }

    _init() {
        // 样式
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

        Object.assign(this.videoCanvas.style, {
            position: 'absolute', top: '0', left: '0', width: '100%', height: '100%'
        });
        Object.assign(this.overlayCanvas.style, {
            position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', cursor: 'default'
        });

        this.container.appendChild(this.videoCanvas);
        this.container.appendChild(this.overlayCanvas);

        // 事件绑定
        this.overlayCanvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
        this.overlayCanvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
        this.overlayCanvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
        this.overlayCanvas.addEventListener('dblclick', (e) => this._onDoubleClick(e));

        // 尺寸
        this._resize();
        const ro = new ResizeObserver(() => this._resize());
        ro.observe(this.container);
    }

    _resize() {
        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.floor(rect.width);
        const h = Math.floor(rect.height);

        for (const canvas of [this.videoCanvas, this.overlayCanvas]) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
        }
    }

    /**
     * 设置视频源。
     */
    setVideo(videoEl, videoW = 1080, videoH = 1920) {
        this.videoEl = videoEl;
        this.videoW = videoW;
        this.videoH = videoH;
    }

    /**
     * 设置当前播放时间。
     */
    setTime(t) {
        this._currentTime = t;
    }

    // ═══════════════════════════════════════════════
    // 坐标转换
    // ═══════════════════════════════════════════════

    _widgetToVideo(wx, wy) {
        const rect = this.overlayCanvas.getBoundingClientRect();
        const sx = this.videoW / rect.width;
        const sy = this.videoH / rect.height;
        return { x: (wx - rect.left) * sx, y: (wy - rect.top) * sy };
    }

    _videoToWidget(vx, vy) {
        const rect = this.overlayCanvas.getBoundingClientRect();
        const sx = rect.width / this.videoW;
        const sy = rect.height / this.videoH;
        return { x: vx * sx, y: vy * sy };
    }

    // ═══════════════════════════════════════════════
    // 渲染
    // ═══════════════════════════════════════════════

    /**
     * 渲染一帧 — 被外部 rAF 循环调用。
     */
    render(style, segment) {
        const vctx = this.videoCtx;
        const octx = this.overlayCtx;
        const cw = this.videoCanvas.width / (window.devicePixelRatio || 1);
        const ch = this.videoCanvas.height / (window.devicePixelRatio || 1);

        // 1. 清除
        vctx.clearRect(0, 0, cw, ch);
        octx.clearRect(0, 0, cw, ch);

        // 2. 视频帧
        if (this.videoEl && this.videoEl.readyState >= 2) {
            vctx.drawImage(this.videoEl, 0, 0, cw, ch);
        } else {
            // 占位渐变
            const grad = vctx.createLinearGradient(0, 0, 0, ch);
            grad.addColorStop(0, '#181818');
            grad.addColorStop(0.5, '#1e1e1e');
            grad.addColorStop(1, '#2a2a2a');
            vctx.fillStyle = grad;
            vctx.fillRect(0, 0, cw, ch);
        }

        // 3. 字幕渲染
        if (this._renderer && style) {
            // 使用 videoCanvas 的 ctx，这样字幕画在视频之上
            this._renderer.ctx = vctx;
            const hasKineticBackdrop = style.anim_in_type === 'kinetic_glow_stack' &&
                typeof this._renderer.renderKineticGlowBackdrop === 'function';
            if (hasKineticBackdrop) {
                this._renderer.renderKineticGlowBackdrop(style, cw, ch);
            }
            if (segment) {
                this._renderer.renderSubtitle(style, segment, this._currentTime, cw, ch, false, hasKineticBackdrop);
            }
        }

        // 4. 覆层渲染 (在视频 canvas 上)
        const scaleX = cw / this.videoW;
        const scaleY = ch / this.videoH;
        vctx.save();
        vctx.scale(scaleX, scaleY);
        this.overlayMgr.renderAll(vctx, this._currentTime, this.videoW, this.videoH);
        vctx.restore();

        // 5. 选中框 (在 overlay canvas 上)
        this._drawSelectionUI(octx, cw, ch);
    }

    /**
     * 绘制选中覆层的选择框和缩放手柄。
     */
    _drawSelectionUI(ctx, cw, ch) {
        if (!this._selected) return;
        const ov = this.overlayMgr.getOverlay(this._selected);
        if (!ov) { this._selected = null; return; }

        const scaleX = cw / this.videoW;
        const scaleY = ch / this.videoH;

        const x = ov.x * scaleX;
        const y = ov.y * scaleY;
        const w = ov.w * scaleX;
        const h = ov.h * scaleY;

        // 虚线选框
        ctx.save();
        ctx.strokeStyle = '#4c9eff';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);

        // 8 个缩放手柄
        const handles = this._getHandleRects(x, y, w, h);
        ctx.fillStyle = '#4c9eff';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        for (const handle of handles) {
            ctx.beginPath();
            ctx.arc(handle.cx, handle.cy, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        // 尺寸标签
        ctx.font = '11px monospace';
        ctx.fillStyle = '#4c9eff';
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.round(ov.w)}×${Math.round(ov.h)}`, x + w / 2, y - 8);

        ctx.restore();
    }

    _getHandleRects(x, y, w, h) {
        return [
            { cx: x, cy: y, cursor: 'nw-resize', name: 'tl' },
            { cx: x + w / 2, cy: y, cursor: 'n-resize', name: 'tc' },
            { cx: x + w, cy: y, cursor: 'ne-resize', name: 'tr' },
            { cx: x + w, cy: y + h / 2, cursor: 'e-resize', name: 'mr' },
            { cx: x + w, cy: y + h, cursor: 'se-resize', name: 'br' },
            { cx: x + w / 2, cy: y + h, cursor: 's-resize', name: 'bc' },
            { cx: x, cy: y + h, cursor: 'sw-resize', name: 'bl' },
            { cx: x, cy: y + h / 2, cursor: 'w-resize', name: 'ml' },
        ];
    }

    // ═══════════════════════════════════════════════
    // 鼠标交互
    // ═══════════════════════════════════════════════

    _onMouseDown(e) {
        const vp = this._widgetToVideo(e.clientX, e.clientY);

        // 先检测是否点在选中覆层的缩放手柄上
        if (this._selected) {
            const handle = this._hitHandle(e.clientX, e.clientY);
            if (handle) {
                this._resizing = true;
                this._resizeHandle = handle;
                const ov = this.overlayMgr.getOverlay(this._selected);
                this._dragStartMouse = { x: e.clientX, y: e.clientY };
                this._dragStartOv = { x: ov.x, y: ov.y, w: ov.w, h: ov.h };
                return;
            }
        }

        // Hit test 覆层
        const hit = this.overlayMgr.hitTest(vp.x, vp.y, this._currentTime);
        if (hit) {
            this._selected = hit.id;
            this._dragging = true;
            this._dragStartMouse = { x: e.clientX, y: e.clientY };
            this._dragStartOv = { x: hit.x, y: hit.y, w: hit.w, h: hit.h };
            this.overlayCanvas.style.cursor = 'move';
            if (this.onSelect) this.onSelect(hit);
        } else {
            this._selected = null;
            this._dragging = false;
            if (this.onDeselect) this.onDeselect();
        }
    }

    _onMouseMove(e) {
        if (this._dragging && this._selected) {
            const dx = e.clientX - this._dragStartMouse.x;
            const dy = e.clientY - this._dragStartMouse.y;
            const rect = this.overlayCanvas.getBoundingClientRect();
            const sx = this.videoW / rect.width;
            const sy = this.videoH / rect.height;

            const ov = this.overlayMgr.getOverlay(this._selected);
            if (ov) {
                ov.x = this._dragStartOv.x + dx * sx;
                ov.y = this._dragStartOv.y + dy * sy;
                if (this.onOverlayChange) this.onOverlayChange(ov);
            }
            return;
        }

        if (this._resizing && this._selected) {
            const dx = e.clientX - this._dragStartMouse.x;
            const dy = e.clientY - this._dragStartMouse.y;
            const rect = this.overlayCanvas.getBoundingClientRect();
            const sx = this.videoW / rect.width;
            const sy = this.videoH / rect.height;
            this._applyResize(dx * sx, dy * sy);
            return;
        }

        // 光标提示
        if (this._selected) {
            const handle = this._hitHandle(e.clientX, e.clientY);
            if (handle) {
                this.overlayCanvas.style.cursor = handle.cursor;
                return;
            }
        }

        const vp = this._widgetToVideo(e.clientX, e.clientY);
        const hit = this.overlayMgr.hitTest(vp.x, vp.y, this._currentTime);
        this.overlayCanvas.style.cursor = hit ? 'move' : 'default';
    }

    _onMouseUp(e) {
        this._dragging = false;
        this._resizing = false;
        this._resizeHandle = null;
    }

    _onDoubleClick(e) {
        const vp = this._widgetToVideo(e.clientX, e.clientY);
        const hit = this.overlayMgr.hitTest(vp.x, vp.y, this._currentTime);
        if (hit && hit.type === 'text') {
            this._startInlineEdit(hit, e.clientX, e.clientY);
        }
    }

    _hitHandle(clientX, clientY) {
        if (!this._selected) return null;
        const ov = this.overlayMgr.getOverlay(this._selected);
        if (!ov) return null;

        const rect = this.overlayCanvas.getBoundingClientRect();
        const scaleX = rect.width / this.videoW;
        const scaleY = rect.height / this.videoH;
        const x = ov.x * scaleX;
        const y = ov.y * scaleY;
        const w = ov.w * scaleX;
        const h = ov.h * scaleY;

        const handles = this._getHandleRects(x, y, w, h);
        const mx = clientX - rect.left;
        const my = clientY - rect.top;

        for (const handle of handles) {
            const dist = Math.hypot(mx - handle.cx, my - handle.cy);
            if (dist < 8) return handle;
        }
        return null;
    }

    _applyResize(dvx, dvy) {
        const ov = this.overlayMgr.getOverlay(this._selected);
        if (!ov) return;
        const so = this._dragStartOv;
        const h = this._resizeHandle?.name;
        if (!h) return;

        let nx = so.x, ny = so.y, nw = so.w, nh = so.h;

        if (h.includes('r')) { nw = Math.max(20, so.w + dvx); }
        if (h.includes('l')) { nx = so.x + dvx; nw = Math.max(20, so.w - dvx); }
        if (h.includes('b')) { nh = Math.max(20, so.h + dvy); }
        if (h.includes('t')) { ny = so.y + dvy; nh = Math.max(20, so.h - dvy); }

        ov.x = nx; ov.y = ny; ov.w = nw; ov.h = nh;
        if (this.onOverlayChange) this.onOverlayChange(ov);
    }

    // ═══════════════════════════════════════════════
    // 内联文本编辑
    // ═══════════════════════════════════════════════

    _startInlineEdit(ov, clientX, clientY) {
        this._cancelInlineEdit();

        const rect = this.overlayCanvas.getBoundingClientRect();
        const scaleX = rect.width / this.videoW;
        const scaleY = rect.height / this.videoH;

        const editor = document.createElement('textarea');
        editor.className = 'rvc-inline-editor';
        editor.value = ov.content || '';
        Object.assign(editor.style, {
            position: 'absolute',
            left: `${rect.left + ov.x * scaleX}px`,
            top: `${rect.top + ov.y * scaleY}px`,
            width: `${ov.w * scaleX}px`,
            height: `${ov.h * scaleY}px`,
            fontSize: `${(ov.fontsize || 40) * scaleY}px`,
            fontFamily: ov.font_family || 'Arial',
            fontWeight: String(Math.max(100, Math.min(900, parseInt(ov.font_weight || (ov.bold ? 700 : 400), 10) || 400))),
            color: ov.color || '#fff',
            background: 'rgba(0,0,0,0.6)',
            border: '2px solid #4c9eff',
            borderRadius: '4px',
            padding: '4px',
            resize: 'none',
            zIndex: '9999',
            outline: 'none',
        });

        editor.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._commitInlineEdit(ov, editor);
            }
            if (e.key === 'Escape') {
                this._cancelInlineEdit();
            }
        });

        editor.addEventListener('blur', () => {
            this._commitInlineEdit(ov, editor);
        });

        document.body.appendChild(editor);
        this._inlineEditor = editor;
        editor.focus();
        editor.select();
    }

    _commitInlineEdit(ov, editor) {
        if (!editor || !editor.parentNode) return;
        ov.content = editor.value;
        editor.parentNode.removeChild(editor);
        this._inlineEditor = null;
        if (this.onOverlayChange) this.onOverlayChange(ov);
    }

    _cancelInlineEdit() {
        if (this._inlineEditor && this._inlineEditor.parentNode) {
            this._inlineEditor.parentNode.removeChild(this._inlineEditor);
        }
        this._inlineEditor = null;
    }

    // ═══════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════

    addOverlay(ov) {
        this.overlayMgr.addOverlay(ov);
        this._selected = ov.id;
        if (this.onSelect) this.onSelect(ov);
        return ov;
    }

    removeOverlay(id) {
        this.overlayMgr.removeOverlay(id);
        if (this._selected === id) { this._selected = null; if (this.onDeselect) this.onDeselect(); }
    }

    getSelected() {
        return this._selected ? this.overlayMgr.getOverlay(this._selected) : null;
    }

    setRenderer(renderer) {
        this._renderer = renderer;
    }
}

// ═══════════════════════════════════════════════════════
// CSS 样式注入
// ═══════════════════════════════════════════════════════

(function injectVideoCanvasStyles() {
    if (document.getElementById('rvc-styles')) return;
    const style = document.createElement('style');
    style.id = 'rvc-styles';
    style.textContent = `
        .rvc-video-layer, .rvc-overlay-layer {
            position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            pointer-events: none;
        }
        .rvc-overlay-layer { pointer-events: auto; }
        .rvc-inline-editor {
            font-weight: bold;
            line-height: 1.3;
            overflow: hidden;
            white-space: pre-wrap;
            word-break: break-word;
        }
    `;
    document.head.appendChild(style);
})();

// Export
if (typeof window !== 'undefined') window.ReelsVideoCanvas = ReelsVideoCanvas;
