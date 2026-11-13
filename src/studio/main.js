/**
 * studio/main.js — Modular Vite ESM Studio Kernel for VideoKit
 * 静夜星空 · 中国花灯 现代模块化工作台内核
 */
import './starry-theme.css';
import { createStarryBackdrop } from './starry-canvas.js';
import { LANTERN_MODES, mountChineseLanternStage, buildChineseLanternSvg } from './chinese-lantern.js';
import { createCommandPalette, buildCommandItems, escapeHtml } from './command-palette.js';
import { createFrameCoalescer, applySmoothWorkspaceHints } from './perf-bridge.js';

const LANTERN_STORAGE_KEY = 'vk_lantern_mode_v1';
const ATMOSPHERIC_THEME_IDS = new Set([
    'starry-lantern',
    'starry-ink',
    'autumn-night',
    'snow-night',
    'christmas-eve',
]);
const QUICK_THEME_OPTIONS = [
    { id: 'christmas-eve', pill: '🎄 圣诞', title: '🎄 圣诞 · 圣诞暖夜', desc: '深松绿雪夜与暖金圣诞灯饰（默认）' },
    { id: 'autumn-night', pill: '🍁 秋景', title: '🍁 秋景 · 暮秋枫夜', desc: '11月深秋红枫与暖琥珀夜色' },
    { id: 'starry-lantern', pill: '🏮 夜景', title: '🏮 夜景 · 静夜花灯', desc: '深邃静夜星空与暖意中国花灯' },
    { id: 'snow-night', pill: '❄️ 雪景', title: '❄️ 雪景 · 静冬雪夜', desc: '深蓝冬夜冰晶飘雪，静谧护眼' },
    { id: 'starry-ink', pill: '🌌 深空', title: '🌌 夜景 · 静谧深空', desc: '纯净星空深蓝，零干扰专注' },
    { id: 'dark', pill: '🌙 暗灰', title: '🌙 经典暗灰', desc: '沉稳深灰色调' },
    { id: 'light', pill: '☀️ 亮色', title: '☀️ 亮色 · 清新薄荷', desc: '白天清晰浅色工作台' },
];

function resolveCurrentThemeId(doc, win) {
    for (const id of ATMOSPHERIC_THEME_IDS) {
        if (doc.body?.classList?.contains(`theme-${id}`)) return id;
    }
    try {
        const saved = win.localStorage?.getItem('videokit-theme');
        if (saved) return saved;
    } catch (_) {}
    return 'christmas-eve';
}

export function initVideoKitStudio(opts = {}) {
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const win = opts.window || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win) return null;
    if (win.__vkStudioInitialized) return win.VideoKitStudio;

    const getSavedLanternMode = () => {
        try {
            const v = win.localStorage?.getItem(LANTERN_STORAGE_KEY);
            return LANTERN_MODES[v] ? v : 'lit';
        } catch {
            return 'lit';
        }
    };

    let currentMode = getSavedLanternMode();
    let themePopover = null;
    const starryBackdrop = createStarryBackdrop({ document: doc, window: win, mode: currentMode });
    const lanternStage = mountChineseLanternStage(doc);
    const coalescer = createFrameCoalescer(win);

    function detectPlatform() {
        const raw = win.electronAPI?.platform || win.navigator?.platform || win.navigator?.userAgent || '';
        const low = String(raw).toLowerCase();
        if (low.includes('win')) return 'win32';
        if (low.includes('mac') || low.includes('darwin')) return 'darwin';
        return 'linux';
    }

    function applyPlatformChromeHints() {
        const plat = detectPlatform();
        doc.body.classList.remove('platform-win32', 'platform-darwin', 'platform-linux');
        doc.body.classList.add(`platform-${plat}`);

        let syncRaf = 0;
        const syncControlsRect = () => {
            if (plat !== 'win32') return;
            try {
                const wco = win.navigator?.windowControlsOverlay;
                const vw = doc.documentElement?.clientWidth || win.innerWidth;
                if (wco && typeof wco.getTitlebarAreaRect === 'function' && vw > 0) {
                    const rect = wco.getTitlebarAreaRect();
                    if (rect && rect.width > 0 && vw > rect.width) {
                        const rawInset = Math.ceil(vw - (rect.x + rect.width)) + 10;
                        // 忽略 resize 与 geometrychange 不同步导致的瞬态虚高差值
                        if (rawInset >= 100 && rawInset <= 240) {
                            const rightInset = Math.max(142, rawInset);
                            doc.documentElement.style.setProperty('--vk-win-controls-inset', `${rightInset}px`);
                        }
                    }
                }
            } catch (_) {}
        };
        const scheduleSyncControlsRect = () => {
            if (syncRaf && typeof win.cancelAnimationFrame === 'function') {
                win.cancelAnimationFrame(syncRaf);
            }
            if (typeof win.requestAnimationFrame === 'function') {
                syncRaf = win.requestAnimationFrame(() => {
                    syncRaf = 0;
                    syncControlsRect();
                });
            } else {
                syncControlsRect();
            }
        };
        syncControlsRect();
        try {
            win.navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', scheduleSyncControlsRect);
            win.addEventListener?.('resize', scheduleSyncControlsRect);
        } catch (_) {}
    }

    function updateThemePickerPill(themeId) {
        const btn = doc.getElementById('vk-theme-picker-btn');
        if (!btn) return;
        const activeId = themeId || resolveCurrentThemeId(doc, win);
        const found = QUICK_THEME_OPTIONS.find(t => t.id === activeId);
        const pillText = found ? found.pill : '🎨 主题';
        btn.innerHTML = `<span>${escapeHtml(pillText)}</span><span style="font-size:9px;opacity:0.75;">▾</span>`;
        if (themePopover) {
            themePopover.querySelectorAll('.vk-theme-opt').forEach(el => {
                el.classList.toggle('is-active', el.dataset.themeId === activeId);
            });
        }
    }

    function closeThemePopover() {
        if (themePopover) {
            themePopover.remove();
            themePopover = null;
        }
    }

    function toggleThemePopover(anchorBtn) {
        if (themePopover) {
            closeThemePopover();
            return;
        }
        const activeId = resolveCurrentThemeId(doc, win);
        themePopover = doc.createElement('div');
        themePopover.className = 'vk-theme-popover';
        themePopover.setAttribute('role', 'menu');
        themePopover.innerHTML = `
            <div class="vk-theme-popover-title">🎨 十一月季节与夜色主题</div>
            ${QUICK_THEME_OPTIONS.map(opt => `
                <button type="button" class="vk-theme-opt${opt.id === activeId ? ' is-active' : ''}" data-theme-id="${escapeHtml(opt.id)}">
                    <span class="vk-theme-opt-name">${escapeHtml(opt.title)}</span>
                    <span class="vk-theme-opt-desc">${escapeHtml(opt.desc)}</span>
                </button>
            `).join('')}
        `;
        doc.body.appendChild(themePopover);
        if (anchorBtn?.getBoundingClientRect) {
            const r = anchorBtn.getBoundingClientRect();
            const top = Math.max(42, Math.round(r.bottom + 6));
            const right = Math.max(12, Math.round((win.innerWidth || 1200) - r.right));
            themePopover.style.top = `${top}px`;
            themePopover.style.right = `${right}px`;
        }
        themePopover.addEventListener('click', (e) => {
            const btn = e.target.closest('.vk-theme-opt');
            if (!btn) return;
            const targetTheme = btn.dataset.themeId;
            if (targetTheme && typeof win.applyTheme === 'function') {
                win.applyTheme(targetTheme);
            }
            closeThemePopover();
        });
    }

    function updateTitlebarLanternPill() {
        const pill = doc.getElementById('vk-lantern-mode-btn');
        if (!pill) return;
        const themeId = resolveCurrentThemeId(doc, win);
        const info = LANTERN_MODES[currentMode] || LANTERN_MODES.lit;
        const themeLabelMap = {
            'autumn-night': currentMode === 'lit' ? '🍁 枫叶微动' : (currentMode === 'calm' ? '🕯️ 秋夜常亮' : '🌑 纯净秋夜'),
            'snow-night': currentMode === 'lit' ? '❄️ 轻雪飘落' : (currentMode === 'calm' ? '💎 静夜冰星' : '🌑 纯净雪夜'),
            'christmas-eve': currentMode === 'lit' ? '🎄 圣诞暖灯' : (currentMode === 'calm' ? '🕯️ 平安静夜' : '🌑 纯净松夜'),
        };
        const label = themeLabelMap[themeId] || info.label;
        pill.title = `${info.desc}（点击切换动静/隐藏模式）`;
        pill.classList.toggle('is-lit', currentMode !== 'off');
        const txt = pill.querySelector('.vk-lantern-pill-text');
        if (txt) txt.textContent = label;
    }

    function setLanternMode(nextMode) {
        currentMode = LANTERN_MODES[nextMode] ? nextMode : 'lit';
        try {
            win.localStorage?.setItem(LANTERN_STORAGE_KEY, currentMode);
        } catch (_) {}
        lanternStage.setMode(currentMode);
        starryBackdrop.setMode(currentMode);
        updateTitlebarLanternPill();
    }

    function cycleLanternMode() {
        const order = ['lit', 'calm', 'off'];
        const nextIdx = (order.indexOf(currentMode) + 1) % order.length;
        const activeTheme = resolveCurrentThemeId(doc, win);
        // If user turns ambient effects back on while on a non-atmospheric theme, switch to christmas-eve
        if (order[nextIdx] !== 'off' && !ATMOSPHERIC_THEME_IDS.has(activeTheme) && typeof win.applyTheme === 'function') {
            win.applyTheme('christmas-eve');
        }
        setLanternMode(order[nextIdx]);
    }

    const commandPalette = createCommandPalette({
        document: doc,
        window: win,
        onSwitchLantern: setLanternMode,
    });

    function mountTitlebarControls() {
        const titlebar = doc.querySelector('.titlebar');
        if (!titlebar || doc.getElementById('vk-titlebar-studio-actions')) return;

        const wrap = doc.createElement('div');
        wrap.id = 'vk-titlebar-studio-actions';
        wrap.className = 'vk-titlebar-actions';

        const cmdBtn = doc.createElement('button');
        cmdBtn.type = 'button';
        cmdBtn.id = 'vk-cmdk-trigger-btn';
        cmdBtn.className = 'vk-pill-btn';
        cmdBtn.title = '打开快速命令与字幕预设搜索（Ctrl+K / ⌘K）';
        cmdBtn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <span>快捷搜索</span>
            <kbd>Ctrl+K</kbd>
        `;
        cmdBtn.addEventListener('click', () => commandPalette.open());

        const themeBtn = doc.createElement('button');
        themeBtn.type = 'button';
        themeBtn.id = 'vk-theme-picker-btn';
        themeBtn.className = 'vk-pill-btn vk-theme-picker-btn';
        themeBtn.title = '快速切换十一月主题：秋景 / 夜景 / 雪景 / 圣诞';
        themeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleThemePopover(themeBtn);
        });

        const lanternBtn = doc.createElement('button');
        lanternBtn.type = 'button';
        lanternBtn.id = 'vk-lantern-mode-btn';
        lanternBtn.className = 'vk-pill-btn vk-lantern-toggle';
        lanternBtn.innerHTML = `<span class="vk-lantern-pill-text"></span>`;
        lanternBtn.addEventListener('click', cycleLanternMode);

        wrap.appendChild(cmdBtn);
        wrap.appendChild(themeBtn);
        wrap.appendChild(lanternBtn);
        titlebar.appendChild(wrap);

        doc.addEventListener('click', (e) => {
            if (themePopover && !themePopover.contains(e.target) && e.target !== themeBtn && !themeBtn.contains(e.target)) {
                closeThemePopover();
            }
        });
        doc.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && themePopover) closeThemePopover();
        });
    }

    function syncTitlebarOverlayFromDom(themeId, themeMeta) {
        if (!win.electronAPI || typeof win.electronAPI.setTitlebarTheme !== 'function') return;
        const isLight = Boolean(themeMeta?.isLight ?? doc.body?.classList?.contains('theme-light'));
        const colors = themeMeta?.colors || win.THEME_PRESETS?.[themeId]?.colors;
        const computedBg = colors?.['--bg-titlebar'] || doc.documentElement?.style?.getPropertyValue('--bg-titlebar') || '';
        const computedText = colors?.['--text-primary'] || doc.documentElement?.style?.getPropertyValue('--text-primary') || '';
        const color = /^#[0-9a-fA-F]{6}$/.test(computedBg.trim()) ? computedBg.trim() : (isLight ? '#e2ebe0' : '#050b08');
        const symbolColor = /^#[0-9a-fA-F]{6}$/.test(computedText.trim()) ? computedText.trim() : (isLight ? '#1b2e1b' : '#f6f3ea');
        try {
            Promise.resolve(win.electronAPI.setTitlebarTheme({ isLight, color, symbolColor })).catch(() => {});
        } catch (_) {}
    }

    function boot() {
        applyPlatformChromeHints();
        mountTitlebarControls();
        applySmoothWorkspaceHints(doc);
        const activeTheme = resolveCurrentThemeId(doc, win);
        lanternStage.setSceneTheme?.(activeTheme);
        setLanternMode(currentMode);
        updateThemePickerPill(activeTheme);
        syncTitlebarOverlayFromDom(activeTheme);
        starryBackdrop.refreshVisibility?.();
        if (ATMOSPHERIC_THEME_IDS.has(activeTheme)) {
            starryBackdrop.renderOnce();
        }
    }

    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    const studioApi = {
        LANTERN_MODES,
        QUICK_THEME_OPTIONS,
        getLanternMode: () => currentMode,
        setLanternMode,
        cycleLanternMode,
        openCommandPalette: () => commandPalette.open(),
        onThemeChange(themeId, themeMeta) {
            lanternStage.setSceneTheme?.(themeId);
            starryBackdrop.refreshVisibility?.();
            if (ATMOSPHERIC_THEME_IDS.has(themeId)) {
                starryBackdrop.renderOnce();
            }
            updateTitlebarLanternPill();
            updateThemePickerPill(themeId);
            syncTitlebarOverlayFromDom(themeId, themeMeta);
        },
        coalesceFrame: coalescer.schedule,
        buildChineseLanternSvg,
        buildCommandItems,
        escapeHtml,
        destroy() {
            closeThemePopover();
            coalescer.cancelAll();
            commandPalette.destroy();
            lanternStage.destroy();
            starryBackdrop.destroy();
            win.__vkStudioInitialized = false;
        },
    };

    win.VideoKitStudio = studioApi;
    win.__vkStudioInitialized = true;
    return studioApi;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    initVideoKitStudio();
}
