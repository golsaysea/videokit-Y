/* Per-task scroll timing: no shared style, no global selected DOM for other tasks. */
(function (global) {
    'use strict';
    const valid = v => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0;
    const r = v => Math.round(v * 1000) / 1000;
    function duration(task, context = {}) {
        const explicit = valid(context.bodyDuration);
        if (explicit) return r(explicit);
        if (!task) return 0;
        const overlays = Array.isArray(task.overlays) ? task.overlays : [];
        let flipper = 0;
        for (const ov of overlays) {
            if (!ov || ov.disabled || !ov.flipper_enabled) continue;
            const words = String(ov.type === 'textcard' ? ov.body_text || '' : ov.content || '').split('\n').filter(x => x.trim());
            const chunks = Math.ceil(words.length / Math.max(1, Number(ov.flipper_lines) || 2));
            flipper = Math.max(flipper, (Number(ov.start) || 0) + chunks * (Number(ov.flipper_duration) || 2));
        }
        if (flipper) return r(flipper);
        const custom = valid(task.customDuration) || valid(task.durationOverride);
        if (custom) return r(custom);

        const cache = context.mediaDurations || {};
        const audio = valid(cache[task.audioPath]);
        const scale = valid(task.audioDurScale) / 100 || 1;
        if (audio) return r(audio * scale);
        const cv = task.contentVideoPath ? valid(cache[task.contentVideoPath]) : 0;
        const trimStart = Math.max(0, Number(task.contentVideoTrimStart) || 0);
        const trimEnd = Math.max(0, Number(task.contentVideoTrimEnd) || 0);
        const clip = cv ? Math.max(0, trimEnd > trimStart ? Math.min(cv, trimEnd) - trimStart : cv - trimStart) : 0;
        const seg = Array.isArray(task.segments) ? Math.max(0, ...task.segments.map(x => Number(x.end) || 0)) : 0;
        if (clip) return r(Math.max(clip, seg));
        const background = task.bgPath || task.videoPath || '';
        const bg = valid(cache[background]) * (valid(task.bgDurScale) / 100 || 1);
        const fallback = Math.max(bg, seg, valid(task.duration));
        return fallback ? r(fallback) : 0;
    }
    function end(overlay, task, context = {}) {
        if (!overlay || overlay.type !== 'scroll') return Number(overlay?.end) || 0;
        if (overlay.scroll_end_auto === false || (Array.isArray(overlay.display_ranges) && overlay.display_ranges.length)) return Number(overlay.end) || 0;
        return duration(task, context) || 9999;
    }
    function renderingOverlay(overlay, task, context = {}) {
        if (!overlay || overlay.type !== 'scroll' || overlay.scroll_end_auto === false || overlay.display_ranges?.length) return overlay;
        const resolved = duration(task, context);
        if (!resolved) return overlay;
        const clone = { ...overlay, end: resolved };
        const segs = overlay._taskSegments || (task && Array.isArray(task.segments) ? task.segments : null);
        if (segs) {
            Object.defineProperty(clone, '_taskSegments', {
                value: segs,
                writable: true,
                configurable: true,
                enumerable: false,
            });
        }
        return clone;
    }
    function reset(overlay) {
        if (!overlay || overlay.type !== 'scroll') return false;
        overlay.scroll_end_auto = true;
        overlay.end = 9999;
        delete overlay.display_ranges;
        return true;
    }
    global.ReelsScrollTiming = { duration, end, renderingOverlay, reset };
})(window);
