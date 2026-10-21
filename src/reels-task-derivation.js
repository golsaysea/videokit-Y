(function (root, factory) {
    const api = factory(root || globalThis);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.ReelsTaskDerivation = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    let idSequence = 0;

    function createId(prefix) {
        idSequence += 1;
        const safePrefix = String(prefix || 'id').replace(/[^a-z0-9_-]/gi, '') || 'id';
        const stamp = Date.now().toString(36);
        const random = Math.random().toString(36).slice(2, 10);
        return `${safePrefix}_${stamp}_${idSequence.toString(36)}_${random}`;
    }

    function resetContent(task) {
        if (!task || typeof task !== 'object') return task;
        task.srtPath = null;
        task.txtPath = null;
        task.segments = [];
        task.txtContent = '';
        task.ttsText = '';
        task.aiScript = '';
        task.manualText = '';
        task.aligned = false;
        task.alignSource = '';
        task.alignedAt = null;
        task.alignMatchedText = '';
        task.alignRecognitionDifference = false;
        task.alignManualConfirmed = false;
        task.alignManualConfirmReason = '';
        task.alignReviewPending = false;
        delete task.timeline;
        delete task.renderPlan;
        delete task.timelineBackgroundTrim;
        delete task.autoMatchedSourceIndex;
        delete task.autoMatchedSourceRow;
        delete task.autoMatchedSourceField;
        delete task.autoMatchedSourceLabel;
        delete task.timingCalibration;
        delete task._bulkCreateSrtError;
        return task;
    }

    function rekeyOverlays(task) {
        if (!task || !Array.isArray(task.overlays)) return new Map();
        const idMap = new Map();
        const templateIdByOldId = new Map();
        const nextIdByTemplateId = new Map();

        task.overlays.forEach((overlay, index) => {
            if (!overlay || typeof overlay !== 'object') return;
            const oldId = String(overlay.id || `overlay-index-${index}`);
            const templateId = String(overlay._templateOverlayId || overlay.id || `overlay-index-${index}`);
            const nextId = createId('ov');
            if (!idMap.has(oldId)) idMap.set(oldId, nextId);
            templateIdByOldId.set(oldId, templateId);
            // 批量覆层组的顺序表有时保存的是模板 ID，而不是上一实例 ID。
            // 两种 ID 都要映射到同一个新实例，否则顺序表留下失效键，渲染时会退回数组顺序。
            if (!nextIdByTemplateId.has(templateId)) nextIdByTemplateId.set(templateId, nextId);
            overlay._templateOverlayId = templateId;
            overlay.id = nextId;
            delete overlay._compositeOrderKey;
        });

        task.overlays.forEach((overlay) => {
            if (!overlay || typeof overlay !== 'object') return;
            const boundId = overlay.bind_scroll_overlay_id;
            if (!boundId) return;
            const oldBoundId = String(boundId);
            overlay._bindScrollTemplateOverlayId = templateIdByOldId.get(oldBoundId) || oldBoundId;
            overlay.bind_scroll_overlay_id = idMap.get(oldBoundId) || null;
        });

        if (Array.isArray(task.visualOverlayOrder)) {
            const mappedOrder = task.visualOverlayOrder.map((key) => {
                const value = String(key || '');
                if (!value.startsWith('overlay:')) return value;
                const oldId = value.slice('overlay:'.length);
                const nextId = idMap.get(oldId) || nextIdByTemplateId.get(oldId);
                return nextId ? `overlay:${nextId}` : value;
            });
            // 去掉重建后可能重复的键，但保留组内原有相对顺序。
            task.visualOverlayOrder = [...new Set(mappedOrder)];
        }
        return idMap;
    }

    function resolveOverlayBindings(task) {
        if (!task || !Array.isArray(task.overlays)) return task;
        const byTemplateId = new Map();
        for (const overlay of task.overlays) {
            if (!overlay) continue;
            const templateId = overlay._templateOverlayId || overlay.id;
            if (templateId && !byTemplateId.has(String(templateId))) {
                byTemplateId.set(String(templateId), overlay);
            }
        }
        for (const overlay of task.overlays) {
            if (!overlay || !overlay._bindScrollTemplateOverlayId) continue;
            const target = byTemplateId.get(String(overlay._bindScrollTemplateOverlayId));
            overlay.bind_scroll_overlay_id = target && target.type === 'scroll' ? target.id : null;
        }
        return task;
    }

    function cloneOverlay(templateOverlay) {
        if (!templateOverlay || typeof templateOverlay !== 'object') return null;
        const overlay = JSON.parse(JSON.stringify(templateOverlay));
        const oldId = String(overlay.id || createId('template-overlay'));
        overlay._templateOverlayId = String(overlay._templateOverlayId || oldId);
        if (overlay.bind_scroll_overlay_id) {
            overlay._bindScrollTemplateOverlayId = String(
                overlay._bindScrollTemplateOverlayId || overlay.bind_scroll_overlay_id
            );
            overlay.bind_scroll_overlay_id = null;
        }
        overlay.id = createId('ov');
        delete overlay._compositeOrderKey;
        return overlay;
    }

    function templateSlotId(requestedId, templateOverlays = []) {
        const value = String(requestedId || '');
        const source = (templateOverlays || []).find(overlay => overlay && (
            String(overlay.id || '') === value || String(overlay._templateOverlayId || '') === value
        ));
        return String(source?._templateOverlayId || value);
    }

    function overlayMatchesTemplateSlot(overlay, requestedId, templateOverlays = []) {
        if (!overlay) return false;
        const value = String(requestedId || '');
        const stableId = templateSlotId(value, templateOverlays);
        return String(overlay.id || '') === value
            || String(overlay._templateOverlayId || '') === value
            || String(overlay._templateOverlayId || '') === stableId;
    }

    function rekeyTask(task, options = {}) {
        if (!task || typeof task !== 'object') return task;
        task.id = createId('task');
        if (options.overlays !== false) {
            rekeyOverlays(task);
            resolveOverlayBindings(task);
            if (task.cover && Array.isArray(task.cover.overlays)) {
                const coverTask = { overlays: task.cover.overlays };
                rekeyOverlays(coverTask);
                resolveOverlayBindings(coverTask);
            }
        }
        return task;
    }

    function prepareDerivedTask(task, options = {}) {
        if (options.clearContent !== false) resetContent(task);
        return rekeyTask(task, options);
    }

    function bindSrt(task, srtPath, dependencies = {}) {
        if (!task || typeof task !== 'object') return { ok: false, error: '任务无效' };
        task.srtPath = srtPath || null;
        task.segments = [];
        task.aligned = false;
        delete task._bulkCreateSrtError;
        if (!srtPath) return { ok: false, error: 'SRT 路径为空' };

        try {
            const readFileText = dependencies.readFileText;
            const parseSrt = dependencies.parseSrt;
            if (typeof readFileText !== 'function') throw new Error('当前环境不支持读取 SRT 文件');
            if (typeof parseSrt !== 'function') throw new Error('SRT 解析器未加载');
            const content = readFileText(srtPath);
            if (content && typeof content.then === 'function') throw new Error('SRT 读取接口必须同步返回文本');
            if (!String(content || '').trim()) throw new Error('SRT 文件为空或无法读取');
            const rawSegments = (parseSrt(String(content)) || []).map(segment => ({ ...segment, _timeUnit: 'sec' }));
            if (rawSegments.length === 0) throw new Error('SRT 中没有可用字幕片段');
            task.segments = typeof dependencies.toWordSegments === 'function'
                ? dependencies.toWordSegments(rawSegments)
                : rawSegments;
            task.aligned = true;
            return { ok: true, count: task.segments.length };
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            task._bulkCreateSrtError = `${srtPath}: ${message}`;
            task.status = `❌ SRT读取失败: ${message}`;
            task._exportSelected = false;
            return { ok: false, error: message };
        }
    }

    return {
        createId,
        resetContent,
        rekeyOverlays,
        resolveOverlayBindings,
        cloneOverlay,
        templateSlotId,
        overlayMatchesTemplateSlot,
        rekeyTask,
        prepareDerivedTask,
        bindSrt,
    };
});
