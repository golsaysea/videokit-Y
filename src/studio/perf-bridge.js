/**
 * perf-bridge.js — Layout Containment & Animation Frame Coalescing Bridge
 * 性能优化桥接：长列表渲染节流 + 滚动画布合成层隔离 + UI 微交互平滑增强
 */

export function createFrameCoalescer(win = typeof window !== 'undefined' ? window : null) {
    const pending = new Map();
    const raf = win?.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(fn, 16);
    const caf = win?.cancelAnimationFrame ? win.cancelAnimationFrame.bind(win) : clearTimeout;

    return {
        schedule(key, callback) {
            if (pending.has(key)) {
                caf(pending.get(key));
            }
            const id = raf(() => {
                pending.delete(key);
                callback();
            });
            pending.set(key, id);
            return id;
        },
        cancelAll() {
            for (const id of pending.values()) caf(id);
            pending.clear();
        },
    };
}

export function applySmoothWorkspaceHints(doc = typeof document !== 'undefined' ? document : null) {
    if (!doc) return;

    // Ensure scrollable heavy containers keep independent layout boundaries
    const isolatedIds = ['reels-task-list', 'inspector-tab-subtitle', 'reels-preview-viewport'];
    for (const id of isolatedIds) {
        const el = doc.getElementById(id);
        if (el) {
            el.style.contain = 'layout style';
        }
    }
}
