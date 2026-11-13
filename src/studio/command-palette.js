/**
 * command-palette.js — Modern Raycast/Linear Style ⌘K Command Palette
 * 全局快速搜索与指令面板：切换页面 / 调用工具 / 切换花灯氛围 / 一键搜用 260+ 字幕效果
 */

export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function buildCommandItems(ctx = {}) {
    const win = ctx.window || (typeof window !== 'undefined' ? window : {});
    const doc = ctx.document || (typeof document !== 'undefined' ? document : null);
    const onSwitchLantern = typeof ctx.onSwitchLantern === 'function' ? ctx.onSwitchLantern : () => {};

    const items = [];

    // 1. 工具与工作台快捷操作
    const studioActions = [
        {
            id: 'act-preset-studio',
            group: '常用动作',
            title: '打开字幕效果独立预览窗（动态网格 + 免费/爆款库）',
            keywords: 'preview studio 效果 预览 字幕 爆款 免费 ass',
            badge: '工作台',
            run: () => typeof win.reelsOpenSubtitlePresetLibrary === 'function' && win.reelsOpenSubtitlePresetLibrary(),
        },
        {
            id: 'act-batch-table',
            group: '常用动作',
            title: '切换批量文案表格管理',
            keywords: 'batch table 批量 表格 文案',
            badge: '快捷键',
            run: () => typeof win.reelsToggleBatchTable === 'function' && win.reelsToggleBatchTable(),
        },
        {
            id: 'act-bulk-create',
            group: '常用动作',
            title: '打开大量制作 (表格 × 覆层批量组)',
            keywords: 'bulk create canva 大量制作 覆层',
            badge: '批量',
            run: () => typeof win._showBulkCreateModal === 'function' && win._showBulkCreateModal(),
        },
        {
            id: 'act-template-lib',
            group: '常用动作',
            title: '打开工程模板库',
            keywords: 'template library 模板库',
            badge: '模板',
            run: () => typeof win.openTemplateLibrary === 'function' && win.openTemplateLibrary(),
        },
        {
            id: 'act-cloud-hub',
            group: '常用动作',
            title: '打开云端中控 · 日期贴',
            keywords: 'cloud hub gdrive 云端 日期贴',
            badge: '云端',
            run: () => typeof win.openCloudHubDialog === 'function' && win.openCloudHubDialog(),
        },
    ];
    items.push(...studioActions);

    // 2. 主题与季节氛围（夜景 / 秋景 / 雪景 / 圣诞）
    items.push(
        {
            id: 'theme-starry-lantern',
            group: '季节与夜景主题',
            title: '切换主题：🏮 夜景 · 静夜星空 · 花灯 (推荐)',
            keywords: 'theme starry lantern 夜景 星空 花灯 夜色 主题 暖灯',
            badge: '夜景',
            run: () => typeof win.applyTheme === 'function' && win.applyTheme('starry-lantern'),
        },
        {
            id: 'theme-autumn-night',
            group: '季节与夜景主题',
            title: '切换主题：🍁 秋景 · 暮秋枫夜 (11月深秋)',
            keywords: 'theme autumn maple 11月 秋景 枫叶 秋夜 暖琥珀 主题',
            badge: '秋景',
            run: () => typeof win.applyTheme === 'function' && win.applyTheme('autumn-night'),
        },
        {
            id: 'theme-snow-night',
            group: '季节与夜景主题',
            title: '切换主题：❄️ 雪景 · 静冬雪夜',
            keywords: 'theme snow winter 雪景 冬天 飘雪 冰蓝 静夜 主题',
            badge: '雪景',
            run: () => typeof win.applyTheme === 'function' && win.applyTheme('snow-night'),
        },
        {
            id: 'theme-christmas-eve',
            group: '季节与夜景主题',
            title: '切换主题：🎄 圣诞 · 圣诞暖夜',
            keywords: 'theme christmas xmas 圣诞 圣诞节 礼物 暖灯 松绿 主题',
            badge: '圣诞',
            run: () => typeof win.applyTheme === 'function' && win.applyTheme('christmas-eve'),
        },
        {
            id: 'theme-starry-ink',
            group: '季节与夜景主题',
            title: '切换主题：🌌 夜景 · 静谧深空 (纯净星空蓝黑)',
            keywords: 'theme starry ink 夜景 静谧 深空 星空',
            badge: '夜景',
            run: () => typeof win.applyTheme === 'function' && win.applyTheme('starry-ink'),
        },
        {
            id: 'lantern-lit',
            group: '季节与夜景主题',
            title: '氛围模式：🏮 暖光轻摇 / 飘雪枫叶微动',
            keywords: 'lantern lit 花灯 暖光 微动 飘雪 枫叶',
            badge: '氛围',
            run: () => onSwitchLantern('lit'),
        },
        {
            id: 'lantern-calm',
            group: '季节与夜景主题',
            title: '氛围模式：🕯️ 静止常亮 (零摆动更护眼)',
            keywords: 'lantern calm 静止 常亮 专注',
            badge: '氛围',
            run: () => onSwitchLantern('calm'),
        },
        {
            id: 'lantern-off',
            group: '季节与夜景主题',
            title: '氛围模式：✨ 隐藏角饰（极简纯星空）',
            keywords: 'lantern off 隐藏 纯净星空',
            badge: '氛围',
            run: () => onSwitchLantern('off'),
        }
    );

    // 3. 顶部导航标签页 + 侧边栏子模块
    if (doc) {
        doc.querySelectorAll('.titlebar .tab[data-tab]').forEach(btn => {
            const tabId = btn.getAttribute('data-tab');
            const label = (btn.textContent || '').trim();
            if (!tabId || !label) return;
            items.push({
                id: `tab-${tabId}`,
                group: '切换页面',
                title: `前往：${label}`,
                keywords: `tab ${tabId} ${label}`,
                badge: '页面',
                run: () => btn.click(),
            });
        });
        doc.querySelectorAll('.vk-suite-sidebar[data-suite] .sidebar-item[data-suite-tab]').forEach(btn => {
            const subId = btn.getAttribute('data-suite-tab');
            const suiteId = btn.closest('.vk-suite-sidebar')?.getAttribute('data-suite');
            const suiteBtn = suiteId ? doc.querySelector(`.titlebar .tab[data-tab="${suiteId}"]`) : null;
            const suiteLabel = (suiteBtn?.textContent || '').trim();
            const label = (btn.textContent || '').trim();
            if (!subId || !suiteId || !label) return;
            items.push({
                id: `suite-${subId}`,
                group: '切换页面',
                title: `前往：${suiteLabel ? `${suiteLabel} › ` : ''}${label}`,
                keywords: `tab ${suiteId} ${subId} ${suiteLabel} ${label}`,
                badge: suiteLabel || '工具',
                run: () => {
                    if (typeof win.openPanelByName === 'function') {
                        win.openPanelByName(subId);
                    } else {
                        suiteBtn?.click();
                        btn.click();
                    }
                },
            });
        });
    }

    // 4. 所有字幕效果预设（含编号检索）
    const engine = win.ReelsStyleEngine;
    if (engine && typeof engine.getPresetsByCategory === 'function') {
        const { categorized, presetsMap } = engine.getPresetsByCategory();
        for (const cat of categorized) {
            for (const name of cat.names) {
                const style = presetsMap[name] || {};
                const code = typeof win.getSubtitlePresetCode === 'function' ? win.getSubtitlePresetCode(name) : '';
                const label = code ? `[${code}] ${name}` : name;
                items.push({
                    id: `preset-${name}`,
                    group: '字幕效果（回车直接选用）',
                    title: label,
                    keywords: `${code} ${name} ${style.font_family || ''} ${style.anim_in_type || ''} ${cat.category}`,
                    badge: code || cat.category.slice(0, 6),
                    run: () => {
                        if (typeof win.reelsApplyNamedSubtitlePreset === 'function') {
                            win.reelsApplyNamedSubtitlePreset(name);
                        } else {
                            const sel = doc?.getElementById('reels-preset-select');
                            if (sel) {
                                sel.value = name;
                                sel.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                            if (typeof win.reelsOnPresetChange === 'function') win.reelsOnPresetChange();
                        }
                    },
                });
            }
        }
    }

    return items;
}

export function createCommandPalette(options = {}) {
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const win = options.window || (typeof window !== 'undefined' ? window : null);
    if (!doc || !doc.body) {
        return { open() {}, close() {}, destroy() {} };
    }
    let overlay = null;
    let activeIdx = 0;
    let filtered = [];
    let allItems = [];

    function close() {
        if (overlay) {
            overlay.remove();
            overlay = null;
        }
    }

    function renderList() {
        if (!overlay) return;
        const listEl = overlay.querySelector('.vk-cmdk-list');
        if (!listEl) return;

        if (!filtered.length) {
            listEl.innerHTML = `<div style="padding:24px;text-align:center;color:#7c8ca8;font-size:12px;">未找到匹配的指令或字幕效果</div>`;
            return;
        }

        const groups = new Map();
        filtered.slice(0, 60).forEach((item, idx) => {
            if (!groups.has(item.group)) groups.set(item.group, []);
            groups.get(item.group).push({ item, idx });
        });

        let html = '';
        for (const [groupName, rows] of groups.entries()) {
            html += `<div class="vk-cmdk-group-title">${escapeHtml(groupName)}</div>`;
            for (const { item, idx } of rows) {
                html += `<button type="button" class="vk-cmdk-item${idx === activeIdx ? ' is-active' : ''}" data-cmd-idx="${idx}">
                    <span class="vk-cmdk-item-left">
                        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.title)}</span>
                    </span>
                    <span class="vk-cmdk-badge">${escapeHtml(item.badge)}</span>
                </button>`;
            }
        }
        listEl.innerHTML = html;

        const activeBtn = listEl.querySelector('.vk-cmdk-item.is-active');
        activeBtn?.scrollIntoView({ block: 'nearest' });
    }

    function executeIndex(idx) {
        const chosen = filtered[idx];
        if (!chosen) return;
        close();
        try {
            chosen.run();
        } catch (err) {
            console.error('[CommandPalette] 执行失败:', err);
        }
    }

    function open() {
        if (overlay) {
            close();
            return;
        }
        allItems = buildCommandItems({
            document: doc,
            window: win,
            onSwitchLantern: options.onSwitchLantern,
        });
        filtered = allItems;
        activeIdx = 0;

        overlay = doc.createElement('div');
        overlay.className = 'vk-cmdk-overlay';
        overlay.innerHTML = `
            <div class="vk-cmdk-card" role="dialog" aria-label="快速命令与字幕效果搜索">
                <div class="vk-cmdk-input-wrap">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f6b24b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    <input type="text" class="vk-cmdk-input" placeholder="输入命令、页面名、主题或字幕预设（如 sub-128 / 辉光 / 预览窗）..." />
                    <button type="button" class="vk-pill-btn vk-cmdk-close-btn">ESC</button>
                </div>
                <div class="vk-cmdk-list"></div>
                <div class="vk-cmdk-footer">
                    <span>↑ ↓ 选择 · Enter 立即执行 · ESC 关闭</span>
                    <span>共索引 ${allItems.length} 项能力与字幕预设</span>
                </div>
            </div>
        `;

        doc.body.appendChild(overlay);
        const input = overlay.querySelector('.vk-cmdk-input');
        const listEl = overlay.querySelector('.vk-cmdk-list');

        renderList();
        requestAnimationFrame(() => input?.focus());

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('.vk-cmdk-close-btn')) close();
        });

        listEl.addEventListener('click', (e) => {
            const btn = e.target.closest('.vk-cmdk-item');
            if (!btn) return;
            executeIndex(Number(btn.dataset.cmdIdx));
        });

        input.addEventListener('input', () => {
            const q = input.value.trim().toLowerCase();
            if (!q) {
                filtered = allItems;
            } else {
                const terms = q.split(/\s+/).filter(Boolean);
                filtered = allItems.filter(it => {
                    const hay = `${it.title} ${it.keywords} ${it.group}`.toLowerCase();
                    return terms.every(t => hay.includes(t));
                });
            }
            activeIdx = 0;
            renderList();
        });

        input.addEventListener('keydown', (e) => {
            const maxVisible = Math.min(filtered.length, 60);
            if (e.key === 'Escape') {
                e.preventDefault();
                close();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (maxVisible > 0) {
                    activeIdx = (activeIdx + 1) % maxVisible;
                    renderList();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (maxVisible > 0) {
                    activeIdx = (activeIdx - 1 + maxVisible) % maxVisible;
                    renderList();
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                executeIndex(activeIdx);
            }
        });
    }

    const onGlobalKeyDown = (e) => {
        if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'k') {
            e.preventDefault();
            open();
        }
    };

    doc.addEventListener('keydown', onGlobalKeyDown);

    return {
        open,
        close,
        destroy() {
            close();
            doc.removeEventListener('keydown', onGlobalKeyDown);
        },
    };
}
