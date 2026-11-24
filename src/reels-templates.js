/**
 * reels-templates.js — 双轨工程与模板管理系统：
 *   1. 📂 模板库 (openTemplateLibrary): 封存工程快照保存、独立副本载入，不自动覆写原模板；支持多级分类、导入导出与独立窗口编辑
 *   2. 🗂️ 工程项目 (openProjectLibrary): 实时读取与实时自动保存的活工程工作台，支持多级文件夹、新建空白标签、拖拽整理与批量表格双向同步
 */

function _tplEscapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

const TEMPLATE_CARD_SIZE_KEY = 'videokit_template_card_size';

const _LIB_CONFIGS = {
    template: {
        mode: 'template',
        apiBase: 'templates',
        modalId: 'template-library-modal',
        prefix: 'tpl',
        icon: '📂',
        title: '视频模板库',
        pickerTitle: '选择视频模板',
        homeLabel: '主模板库',
        itemNoun: '模板',
        searchPlaceholder: '搜索模板名称或关键词（支持跨文件夹）',
        sortKey: 'videokit_template_sort',
        sortDirKey: 'videokit_template_sort_direction',
        zoomKey: 'videokit_template_zoom_percent',
        sizeKey: TEMPLATE_CARD_SIZE_KEY,
        winSizeKey: 'videokit_template_window_size',
    },
    liveProject: {
        mode: 'liveProject',
        apiBase: 'live-projects',
        modalId: 'live-project-library-modal',
        prefix: 'lpl',
        icon: '🗂️',
        title: '工程项目（实时读取 · 自动保存）',
        pickerTitle: '选择工程项目',
        homeLabel: '主工程区',
        itemNoun: '工程',
        searchPlaceholder: '搜索工程/文件夹名称或关键词（支持跨文件夹）',
        sortKey: 'videokit_live_project_sort',
        sortDirKey: 'videokit_live_project_sort_direction',
        zoomKey: 'videokit_live_project_zoom_percent',
        sizeKey: 'videokit_live_project_card_size',
        winSizeKey: 'videokit_live_project_window_size',
    },
};

function _createLibState(mode) {
    return {
        mode,
        cfg: _LIB_CONFIGS[mode],
        folderId: '',
        folderData: { folders: [], assignments: {}, folderOrders: {} },
        searchTerm: '',
        searchTimer: null,
        folderHistory: [{ id: '', scrollTop: 0 }],
        folderHistoryIndex: 0,
        lastNavigation: { direction: '', time: 0 },
        dismissedBannerSig: '',
        archivingInProgress: false,
    };
}

const _libStates = {
    template: _createLibState('template'),
    liveProject: _createLibState('liveProject'),
};
let _activeLibraryMode = 'liveProject';

function _getLibState(mode = _activeLibraryMode) {
    return mode === 'template' ? _libStates.template : _libStates.liveProject;
}

function _getVisibleLibraryState() {
    for (const mode of ['liveProject', 'template']) {
        const st = _libStates[mode];
        const modal = typeof document !== 'undefined' ? document.getElementById(st.cfg.modalId) : null;
        if (modal && getComputedStyle(modal).display !== 'none') return st;
    }
    return null;
}

let _currentTemplateContext = {
    id: '',
    name: '',
};

function _setCurrentTemplateContext(id, name) {
    _currentTemplateContext = {
        id: id || '',
        name: name || '',
    };
    _updateLibraryHeaderContext(_libStates.template);
}

function _getTemplateFolderChain(folderId, folders = [], homeLabel = '主目录') {
    const map = new Map((folders || []).filter(Boolean).map(f => [String(f.id), f]));
    const chain = [];
    const seen = new Set();
    let curId = String(folderId || '').trim();
    while (curId && map.has(curId) && !seen.has(curId)) {
        seen.add(curId);
        const f = map.get(curId);
        chain.unshift(f);
        curId = String(f.parentId || '').trim();
    }
    return chain;
}

function _buildTemplateFolderPathText(folderId, folders = null, homeLabel = null) {
    const fallbackSt = _getLibState('liveProject');
    const list = Array.isArray(folders) ? folders : (fallbackSt.folderData.folders || []);
    const rootTitle = homeLabel || fallbackSt.cfg.homeLabel;
    const chain = _getTemplateFolderChain(folderId, list, rootTitle);
    return chain.length ? chain.map(f => f.name).join(' / ') : rootTitle;
}

function _collectTplDescendantFolderIds(rootFolderId, folders = []) {
    const root = String(rootFolderId || '').trim();
    const out = new Set();
    if (!root) return out;
    out.add(root);
    let added = true;
    while (added) {
        added = false;
        for (const f of (folders || [])) {
            if (!f || !f.id || out.has(f.id)) continue;
            if (f.parentId && out.has(f.parentId)) {
                out.add(f.id);
                added = true;
            }
        }
    }
    return out;
}

function _templateMatchesSearch(item, query, folderPathText = '') {
    const tokens = String(query || '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    if (!tokens.length) return true;
    const searchable = [item?.name, item?.templateType, item?.id, folderPathText]
        .map(value => String(value ?? '').toLocaleLowerCase())
        .join(' ');
    return tokens.every(token => searchable.includes(token));
}

function _getLibZoom(st) {
    const saved = Number(localStorage.getItem(st.cfg.zoomKey));
    if (saved > 0) return Math.max(10, Math.min(200, Math.round(saved)));
    const pixels = parseInt(localStorage.getItem(st.cfg.sizeKey) || '240', 10);
    return Math.max(10, Math.min(200, Math.round((Number.isFinite(pixels) ? pixels : 240) / 240 * 100)));
}

function _getLibCardSize(st) {
    return Math.round(240 * _getLibZoom(st) / 100);
}

function _setLibZoom(st, value) {
    const zoom = Math.max(10, Math.min(200, Math.round(Number(value) || 100)));
    localStorage.setItem(st.cfg.zoomKey, String(zoom));
    localStorage.setItem(st.cfg.sizeKey, String(Math.round(240 * zoom / 100)));
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal) return;
    const slider = modal.querySelector('[data-role="card-size-slider"]');
    const label = modal.querySelector('[data-role="card-size-value"]');
    const grid = modal.querySelector(`.${st.cfg.prefix}-card-grid`);
    if (slider) slider.value = String(zoom);
    if (label) label.textContent = zoom + '%';
    if (grid) {
        grid.style.setProperty('--tpl-card-size', _getLibCardSize(st) + 'px');
        grid.style.setProperty('--tpl-scale', String(zoom / 100));
        grid.style.columnGap = Math.max(2, Math.round(12 * zoom / 100)) + 'px';
        _layoutLibraryMixedGrid(st, grid);
    }
}

function _updateLibraryHeaderContext(st) {
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal) return;
    if (st.mode === 'template') {
        const btn = modal.querySelector('#tpl-update-current-btn');
        const label = modal.querySelector('[data-role="current-label"]');
        if (btn) {
            btn.disabled = !_currentTemplateContext.id;
            btn.style.opacity = _currentTemplateContext.id ? '1' : '0.45';
            btn.style.cursor = _currentTemplateContext.id ? 'pointer' : 'not-allowed';
            btn.title = _currentTemplateContext.id
                ? `手动覆盖更新封存模板「${_currentTemplateContext.name || _currentTemplateContext.id}」`
                : '请先从模板库载入模板（平时修改工作区不会自动覆盖任何模板）';
        }
        if (label) {
            label.textContent = _currentTemplateContext.id
                ? `已载入模板: ${_currentTemplateContext.name || _currentTemplateContext.id}`
                : '封存模式：不自动覆盖模板';
            label.title = _currentTemplateContext.name || '模板库以封存快照保存，只有点击「保存」或「更新当前模板」才会写入';
        }
        return;
    }

    const label = modal.querySelector('[data-role="current-label"]');
    const wsStatus = typeof window.reelsGetWorkspaceLibraryStatus === 'function'
        ? window.reelsGetWorkspaceLibraryStatus()
        : null;
    if (label) {
        if (wsStatus?.folderId) {
            const folderShort = String(wsStatus.folderPath || '已绑定文件夹').split(' / ').pop();
            const countText = wsStatus.folderTotalCount > 0
                ? `${wsStatus.openTabCount}/${wsStatus.folderTotalCount}`
                : `${wsStatus.openTabCount}`;
            label.textContent = `🟢 同步目录: ${folderShort} (${countText})`;
            label.title = `${wsStatus.folderPath} · 已打开 ${wsStatus.openTabCount} 个标签（实时自动保存）`;
        } else {
            label.textContent = wsStatus?.openTabCount
                ? `🟢 实时工程模式 · 工作区 ${wsStatus.openTabCount} 个打开标签`
                : '🟢 实时读取 · 新建标签即工程';
            label.title = '工作区新建或修改标签会实时保存到「工程项目」磁盘目录';
        }
    }
}

async function _libFolderRequest(st, action, data = {}) {
    const resp = await apiFetch(`${API_BASE}/${st.cfg.apiBase}/folders/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const parsed = await resp.json();
    const result = parsed.data || parsed;
    if (parsed.error || result.error || result.success === false) {
        throw new Error(parsed.error || result.error || '文件夹操作失败');
    }
    return result;
}

async function _libApiRequest(st, action, data = {}) {
    const resp = await apiFetch(`${API_BASE}/${st.cfg.apiBase}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const parsed = await resp.json();
    if (parsed.error) throw new Error(parsed.error);
    const result = parsed.data !== undefined ? parsed.data : parsed;
    if (result && result.error) throw new Error(result.error);
    return result;
}

function _getOtherModal(mode) {
    const otherMode = mode === 'template' ? 'liveProject' : 'template';
    return document.getElementById(_LIB_CONFIGS[otherMode].modalId);
}

// ═══════════════════════════════════════════════════════
// 1. 统一库浏览器弹窗：openTemplateLibrary（📂 模板库） & openProjectLibrary（🗂️ 工程项目）
// ═══════════════════════════════════════════════════════

function _openLibraryModal(mode, onSelectCallback = null, opts = {}) {
    const st = _getLibState(mode);
    _activeLibraryMode = mode;
    const isPicker = !!onSelectCallback;

    // 关闭另一模态框，避免两层遮罩叠加
    const otherModal = _getOtherModal(mode);
    if (otherModal) otherModal.style.display = 'none';

    if (typeof opts?.folderId === 'string') {
        st.folderId = opts.folderId;
    } else if (mode === 'liveProject' && !isPicker && opts?.preserveRoot !== true && !st.folderId) {
        const activeFolder = window.reelsGetWorkspaceLibraryStatus?.().folderId || '';
        if (activeFolder) st.folderId = activeFolder;
    }

    const flushAndRefreshLive = () => {
        _refreshLibraryView(st);
        if (mode === 'liveProject' && !isPicker && typeof window.reelsSyncWorkspaceTabsBackToLibraryFolder === 'function') {
            window.reelsSyncWorkspaceTabsBackToLibraryFolder({ silent: true, onlyDirty: true, autoCreateNew: true, allowEmptyTabs: true, flushWorkspace: true })
                .then(res => { if (res && (res.updated || res.created)) _refreshLibraryView(st); })
                .catch(() => {});
        }
    };

    let modal = document.getElementById(st.cfg.modalId);
    if (modal && modal._wasPicker === isPicker) {
        modal.style.display = 'flex';
        modal._onSelectCallback = onSelectCallback;
        modal._pickerDisabledIds = new Set(opts.disabledIds || []);
        _updateLibraryHeaderContext(st);
        flushAndRefreshLive();
        return;
    }
    if (modal) modal.remove();

    const p = st.cfg.prefix;
    modal = document.createElement('div');
    modal.id = st.cfg.modalId;
    modal._libMode = mode;
    modal._wasPicker = isPicker;
    modal._onSelectCallback = onSelectCallback;
    modal._pickerDisabledIds = new Set(opts.disabledIds || []);
    modal._selectedItemIds = new Set();
    modal._selectedFolderIds = new Set();
    modal._visibleFolderIds = [];
    modal._multiSelectMode = false;
    modal._selectionAnchorKey = '';
    modal.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:400000;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.62);backdrop-filter:blur(4px);';

    const headerActionsHtml = isPicker ? '' : (mode === 'template' ? `
        <button data-act="save-template" style="padding:5px 12px;font-size:11px;font-weight:600;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:8px;cursor:pointer;" title="将当前工程封存保存为独立模板（后续修改工作区不会自动覆盖）">💾 保存当前工程为模板</button>
        <button id="tpl-update-current-btn" data-act="update-template" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(245,158,11,0.16);color:#fbbf24;border:1px solid rgba(245,158,11,0.35);border-radius:8px;cursor:pointer;">♻️ 更新当前模板</button>
        <button data-act="new-folder" style="padding:5px 11px;font-size:11px;font-weight:600;background:rgba(139,92,246,0.18);color:#ddd6fe;border:1px solid rgba(167,139,250,0.38);border-radius:8px;cursor:pointer;">📁 新建文件夹</button>
        <button id="tpl-repair-thumbnails-btn" data-act="repair-thumbs" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(14,165,233,0.15);color:#7dd3fc;border:1px solid rgba(14,165,233,0.35);border-radius:8px;cursor:pointer;">📸 修复重复封面</button>
        <button data-act="import" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;cursor:pointer;">📥 导入</button>
        <button data-act="export-all" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.3);border-radius:8px;cursor:pointer;">📤 导出全部</button>
        <span data-role="current-label" style="max-width:170px;font-size:10px;color:#94a3b8;white-space:normal;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-height:1.45;min-height:2.9em;"></span>
    ` : `
        <button id="lpl-new-folder-btn" data-act="new-folder" style="padding:5px 11px;font-size:11px;font-weight:600;background:rgba(139,92,246,0.18);color:#ddd6fe;border:1px solid rgba(167,139,250,0.38);border-radius:8px;cursor:pointer;" title="在当前目录新建多级工程文件夹">📁 新建文件夹</button>
        <button id="lpl-new-blank-btn" data-act="new-blank-tab" style="padding:5px 12px;font-size:11px;font-weight:700;background:linear-gradient(135deg,#0ea5e9,#2563eb);color:#fff;border:none;border-radius:8px;cursor:pointer;" title="在当前文件夹新建空白工程标签并立即实时保存">📄 新建空白标签</button>
        <button id="tpl-apply-folder-btn" data-act="apply-folder" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(99,102,241,0.22);color:#e0e7ff;border:1px solid rgba(129,140,248,0.42);border-radius:8px;cursor:pointer;" title="打开本文件夹直属全部实时工程到工作区">📂 打开本文件夹</button>
        <button id="lpl-capture-workspace-btn" data-act="archive-workspace" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(245,158,11,0.16);color:#fde68a;border:1px solid rgba(245,158,11,0.36);border-radius:8px;cursor:pointer;" title="把当前工作区未归类标签实时收录到此文件夹">💾 纳入当前工作区</button>
        <button id="lpl-repair-thumbnails-btn" data-act="repair-thumbs" style="padding:5px 11px;font-size:11px;font-weight:600;background:rgba(14,165,233,0.15);color:#7dd3fc;border:1px solid rgba(14,165,233,0.35);border-radius:8px;cursor:pointer;" title="为缺失封面或重复封面的工程自动渲染效果预览图">📸 生成/修复封面</button>
        <button id="lpl-sync-cloud-btn" data-act="sync-cloud-projects" style="padding:5px 11px;font-size:11px;font-weight:600;background:rgba(56,189,248,0.16);color:#bae6fd;border:1px solid rgba(56,189,248,0.38);border-radius:8px;cursor:pointer;" title="从云端中控同步每日工程到此工程库中预览与编辑">☁️ 同步云端工程</button>
        <button id="lpl-import-from-tpl-btn" data-act="import-from-templates" style="padding:5px 11px;font-size:11px;font-weight:600;background:rgba(16,185,129,0.16);color:#6ee7b7;border:1px solid rgba(16,185,129,0.34);border-radius:8px;cursor:pointer;" title="从封存模板库复制文件夹或工程过来（不影响原封存模板）">📥 从模板库导入</button>
        <button id="lpl-import-file-btn" data-act="import" style="padding:5px 10px;font-size:11px;font-weight:600;background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid rgba(255,255,255,0.14);border-radius:8px;cursor:pointer;">📂 导入文件</button>
        <span data-role="current-label" style="max-width:190px;font-size:10px;color:#6ee7b7;white-space:normal;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-height:1.45;min-height:2.9em;"></span>
    `);

    const selectionBarHtml = isPicker ? '' : `
        <div class="vk-selection-bar" data-role="selection-bar" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:8px 24px;border-bottom:1px solid rgba(255,255,255,0.06);background:rgba(15,23,42,0.58);">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <button id="${mode === 'template' ? 'tpl-select-all-btn' : 'lpl-select-all-btn'}" data-act="select-all" class="vk-sel-btn" title="全选/取消全选当前页面（快捷键 Ctrl+A）" style="padding:5px 12px;font-size:11.5px;font-weight:700;background:rgba(59,130,246,0.2);color:#93c5fd;border:1px solid rgba(96,165,250,0.45);border-radius:7px;cursor:pointer;">☑ 全选</button>
                <button data-act="invert-selection" class="vk-sel-btn" title="反选当前页面所有卡片与文件夹" style="padding:5px 10px;font-size:11.5px;font-weight:600;background:rgba(255,255,255,0.06);color:#cbd5e1;border:1px solid rgba(255,255,255,0.16);border-radius:7px;cursor:pointer;">🔁 反选</button>
                <button data-act="clear-selection" class="vk-sel-btn" title="取消所有已选项（Esc）" style="padding:5px 10px;font-size:11.5px;font-weight:600;background:rgba(255,255,255,0.04);color:#94a3b8;border:1px solid rgba(255,255,255,0.12);border-radius:7px;cursor:pointer;">☐ 清空</button>
                <button data-act="toggle-multi-mode" aria-pressed="false" class="vk-sel-btn" title="开启后直接单击任意卡片或文件夹即可连续勾选（无需按住 Ctrl）" style="padding:5px 11px;font-size:11.5px;font-weight:600;background:rgba(16,185,129,0.12);color:#6ee7b7;border:1px solid rgba(16,185,129,0.34);border-radius:7px;cursor:pointer;">☑️ 多选模式: 关</button>
                <span data-role="selected-count" style="font-size:11.5px;color:#94a3b8;margin-left:4px;white-space:nowrap;">未选择（可点左上复选框 / Shift连选 / 框选）</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                ${mode === 'liveProject' ? `
                    <button id="tpl-apply-selected-btn" data-act="apply-selected" style="padding:5px 12px;font-size:11.5px;font-weight:700;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;border-radius:7px;cursor:pointer;" title="打开勾选的实时工程标签到工作区与批量表格">✅ 打开所选工程</button>
                    <button id="lpl-append-selected-btn" data-act="append-selected" style="padding:5px 10px;font-size:11.5px;font-weight:600;background:rgba(14,165,233,0.16);color:#7dd3fc;border:1px solid rgba(14,165,233,0.38);border-radius:7px;cursor:pointer;" title="将所选实时工程追加到当前工作区标签页后面">📥 追加打开</button>
                    <button id="lpl-move-selected-btn" data-act="batch-move" style="padding:5px 10px;font-size:11.5px;font-weight:600;background:rgba(99,102,241,0.18);color:#c7d2fe;border:1px solid rgba(129,140,248,0.38);border-radius:7px;cursor:pointer;" title="把勾选的工程或文件夹批量移动到指定文件夹">📦 批量移动</button>
                    <button id="lpl-seal-to-tpl-btn" data-act="seal-selected" style="padding:5px 10px;font-size:11.5px;font-weight:600;background:rgba(168,85,247,0.16);color:#e9d5ff;border:1px solid rgba(168,85,247,0.38);border-radius:7px;cursor:pointer;" title="把选中的实时工程另存封存一份到「模板库」">🔒 封存到模板库</button>
                    <button id="lpl-delete-selected-btn" data-act="batch-delete" style="padding:5px 10px;font-size:11.5px;font-weight:600;background:rgba(239,68,68,0.16);color:#fca5a5;border:1px solid rgba(239,68,68,0.38);border-radius:7px;cursor:pointer;" title="批量删除所选工程或空文件夹（快捷键 Delete）">🗑️ 批量删除</button>
                ` : `
                    <button id="tpl-copy-selected-to-live-btn" data-act="copy-to-live" style="padding:5px 11px;font-size:11.5px;font-weight:600;background:rgba(14,165,233,0.16);color:#7dd3fc;border:1px solid rgba(14,165,233,0.38);border-radius:7px;cursor:pointer;" title="复制一份所选模板到「🗂️ 工程项目」（不影响原封存模板）">📤 复制到工程项目</button>
                    <button id="tpl-save-selected-presets-btn" data-act="save-presets" style="padding:5px 11px;font-size:11.5px;font-weight:600;background:rgba(16,185,129,0.16);color:#6ee7b7;border:1px solid rgba(16,185,129,0.36);border-radius:7px;cursor:pointer;">💾 保存所选预设</button>
                    <button id="tpl-move-selected-btn" data-act="batch-move" style="padding:5px 10px;font-size:11.5px;font-weight:600;background:rgba(99,102,241,0.18);color:#c7d2fe;border:1px solid rgba(129,140,248,0.38);border-radius:7px;cursor:pointer;" title="把勾选的模板或文件夹批量移动到指定文件夹">📦 批量移动</button>
                    <button id="tpl-delete-selected-btn" data-act="batch-delete" style="padding:5px 10px;font-size:11.5px;font-weight:600;background:rgba(239,68,68,0.16);color:#fca5a5;border:1px solid rgba(239,68,68,0.38);border-radius:7px;cursor:pointer;" title="批量删除所选模板或空文件夹（快捷键 Delete）">🗑️ 批量删除</button>
                `}
            </div>
        </div>
    `;

    const subHint = mode === 'template'
        ? '🔒 封存模板模式：载入工作区后会生成独立副本，编辑工作区不会自动覆盖原模板'
        : '🟢 实时同步模式：每次新建空白标签与修改均实时写入磁盘，拖拽卡片/文件夹即可整理排序与分类';

    modal.innerHTML = `
        <div class="modal-content vk-lib-panel" style="width:90vw;max-width:96vw;min-width:min(640px,96vw);height:80vh;max-height:96vh;min-height:min(360px,96vh);resize:both;display:flex;flex-direction:column;background:var(--bg-secondary,#1a1a2e);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
            <div class="tpl-library-header vk-lib-header" style="display:flex;align-items:center;justify-content:space-between;padding:14px 54px 14px 20px;border-bottom:1px solid rgba(255,255,255,0.06);">
                <div style="display:flex;align-items:center;gap:10px;">
                    <span style="font-size:21px;">${st.cfg.icon}</span>
                    <h2 data-role="lib-title" style="margin:0;font-size:17px;font-weight:700;color:#fff;">${isPicker ? st.cfg.pickerTitle : st.cfg.title}</h2>
                    <span data-role="count-badge" style="font-size:11px;padding:2px 8px;background:rgba(110,231,183,0.15);color:#6ee7b7;border-radius:10px;"></span>
                </div>
                <div class="tpl-library-actions vk-lib-actions" style="display:flex;gap:6px;align-items:center;">
                    ${headerActionsHtml}
                    <button id="${p}-library-close" data-act="close" aria-label="关闭窗口" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:4px 8px;position:absolute;right:12px;top:12px;">✕</button>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 24px;border-bottom:1px solid rgba(255,255,255,.06);">
                <div style="position:relative;flex:1 1 260px;max-width:500px;min-width:180px;">
                    <span aria-hidden="true" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#94a3b8;font-size:15px;">⌕</span>
                    <input data-role="search-input" type="search" autocomplete="off" aria-label="搜索名称" placeholder="${st.cfg.searchPlaceholder}" style="box-sizing:border-box;width:100%;padding:9px 37px 9px 36px;background:#111827;color:#f8fafc;border:1px solid #475569;border-radius:9px;outline:none;font-size:13px;" />
                    <button data-role="search-clear" title="清空搜索" aria-label="清空搜索" style="display:none;position:absolute;right:9px;top:50%;transform:translateY(-50%);border:0;background:transparent;color:#cbd5e1;cursor:pointer;font-size:18px;">×</button>
                </div>
                <span data-role="search-result" aria-live="polite" style="font-size:12px;color:#94a3b8;white-space:nowrap;"></span>
                <div style="display:flex;align-items:center;gap:6px;margin-left:auto;">
                    <select data-role="sort-select" style="padding:4px 8px;font-size:11px;background:#111827;color:#cbd5e1;border:1px solid #334155;border-radius:6px;">
                        <option value="manual">手动排序</option>
                        <option value="name">按名称</option>
                        <option value="modified">按修改时间</option>
                        <option value="type">按类型</option>
                        <option value="size">按大小</option>
                    </select>
                    <button data-role="sort-dir" style="padding:4px 8px;font-size:11px;background:#111827;color:#cbd5e1;border:1px solid #334155;border-radius:6px;cursor:pointer;">升序 ↑</button>
                    <input data-role="card-size-slider" type="range" min="35" max="180" value="${_getLibZoom(st)}" style="width:70px;" title="Ctrl+滚轮也可缩放">
                    <span data-role="card-size-value" style="font-size:11px;color:#94a3b8;min-width:34px;">${_getLibZoom(st)}%</span>
                </div>
            </div>
            ${selectionBarHtml}
            <div style="display:flex;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:6px;padding:8px 24px;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px;color:#bbb;">
                <button data-role="folder-home" data-folder-id="" title="返回根目录，或将项目/文件夹拖到这里" style="background:#ffffff08;border:1px dashed #ffffff35;border-radius:7px;padding:6px 10px;color:#cbd5e1;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">${_templateHomeIcon()}<span>${st.cfg.homeLabel}</span></button>
                <div data-role="breadcrumbs" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1;min-width:120px;"></div>
                <button data-role="move-to-root" style="display:none;background:#ffffff0a;color:#ddd;border:1px solid #ffffff20;border-radius:6px;padding:5px 9px;cursor:pointer;">移到上级</button>
                <span style="font-size:11px;color:#64748b;">${subHint}</span>
            </div>
            <div data-role="workspace-banner" style="display:none;padding:10px 24px;border-bottom:1px solid rgba(16,185,129,0.22);background:linear-gradient(90deg,rgba(16,185,129,0.12),rgba(99,102,241,0.12));flex-shrink:0;"></div>
            <div id="${p}-grid-container" data-role="grid-container" style="flex:1;overflow-y:auto;padding:20px 24px;">
                <div style="color:#666;text-align:center;padding:60px 0;">加载中...</div>
            </div>
        </div>
    `;

    // 绑定头部及选择控制栏事件
    modal.addEventListener('click', async (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
            return;
        }
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'close') modal.style.display = 'none';
        else if (act === 'new-folder') await _newLibraryFolder(st);
        else if (act === 'new-blank-tab') await _createBlankLiveProjectDialog(st);
        else if (act === 'save-template') await saveCurrentAsTemplate();
        else if (act === 'update-template') await updateCurrentTemplate();
        else if (act === 'repair-thumbs') await repairDuplicateTemplateThumbnails(st);
        else if (act === 'sync-cloud-projects') await _syncCloudHubIntoProjectLibrary(st);
        else if (act === 'import') await _importLibraryFiles(st);
        else if (act === 'export-all') await _exportAllTemplates();
        else if (act === 'select-all') _selectAllLibraryItems(st);
        else if (act === 'invert-selection') _invertLibrarySelection(st);
        else if (act === 'clear-selection') _clearLibrarySelection(st);
        else if (act === 'toggle-multi-mode') _toggleMultiSelectMode(st);
        else if (act === 'save-presets') await tplSaveSelectedPresets();
        else if (act === 'apply-selected') await _applySelectedLiveProjects(st);
        else if (act === 'append-selected') await _applySelectedLiveProjects(st, { loadMode: 'append' });
        else if (act === 'apply-folder') await window.reelsApplyFolderById(st.folderId);
        else if (act === 'archive-workspace') await _captureWorkspaceIntoCurrentFolder(st);
        else if (act === 'import-from-templates') await _openImportFromTemplateModal(st);
        else if (act === 'seal-selected') await _sealSelectedLiveProjectsToTemplates(st);
        else if (act === 'copy-to-live') await _batchCopyTemplatesToLive(st);
        else if (act === 'batch-move') await _batchMoveLibrarySelection(st);
        else if (act === 'batch-delete') await _batchDeleteLibrarySelection(st);
    });

    if (!isPicker) {
        modal._keyController?.abort();
        const keyCtrl = new AbortController();
        modal._keyController = keyCtrl;
        window.addEventListener('keydown', (event) => {
            if (!modal.isConnected || getComputedStyle(modal).display === 'none') return;
            if (document.getElementById('tpl-context-menu') || _tplInlineEditing) return;
            if (event.target?.closest?.('input, textarea, select, [contenteditable]')) return;
            const mod = event.ctrlKey || event.metaKey;
            if (mod && String(event.key || '').toLowerCase() === 'a') {
                event.preventDefault();
                _selectAllLibraryItems(st, { forceAll: true });
            } else if (event.key === 'Delete' && ((modal._selectedItemIds?.size || 0) + (modal._selectedFolderIds?.size || 0)) > 0) {
                event.preventDefault();
                _batchDeleteLibrarySelection(st);
            } else if (event.key === 'Escape' && ((modal._selectedItemIds?.size || 0) + (modal._selectedFolderIds?.size || 0)) > 0) {
                event.preventDefault();
                _clearLibrarySelection(st);
            }
        }, { signal: keyCtrl.signal });
    }

    const searchInput = modal.querySelector('[data-role="search-input"]');
    searchInput?.addEventListener('input', () => {
        st.searchTerm = String(searchInput.value || '');
        const clearBtn = modal.querySelector('[data-role="search-clear"]');
        if (clearBtn) clearBtn.style.display = st.searchTerm ? '' : 'none';
        clearTimeout(st.searchTimer);
        st.searchTimer = setTimeout(() => _refreshLibraryView(st), 180);
    });
    searchInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            st.searchTerm = '';
            searchInput.value = '';
            clearTimeout(st.searchTimer);
            _refreshLibraryView(st);
        }
    });
    modal.querySelector('[data-role="search-clear"]')?.addEventListener('click', () => {
        st.searchTerm = '';
        if (searchInput) { searchInput.value = ''; searchInput.focus(); }
        _refreshLibraryView(st);
    });
    modal.querySelector('[data-role="sort-select"]')?.addEventListener('change', (e) => {
        localStorage.setItem(st.cfg.sortKey, e.target.value);
        _refreshLibraryView(st);
    });
    modal.querySelector('[data-role="sort-dir"]')?.addEventListener('click', () => {
        const nextDir = localStorage.getItem(st.cfg.sortDirKey) === 'desc' ? 'asc' : 'desc';
        localStorage.setItem(st.cfg.sortDirKey, nextDir);
        _refreshLibraryView(st);
    });
    modal.querySelector('[data-role="card-size-slider"]')?.addEventListener('input', (e) => {
        _setLibZoom(st, e.target.value);
    });
    modal.querySelector('[data-role="folder-home"]')?.addEventListener('click', () => _openLibraryFolder(st, ''));
    modal.querySelector('[data-role="move-to-root"]')?.addEventListener('click', () => _moveSelectedToParent(st));

    modal.addEventListener('wheel', event => {
        if (!event.ctrlKey || !event.deltaY) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        _setLibZoom(st, _getLibZoom(st) + (event.deltaY < 0 ? 5 : -5));
    }, { passive: false, capture: true });

    document.body.appendChild(modal);
    _initLibraryWindowSizing(st, modal);
    _updateLibraryHeaderContext(st);
    flushAndRefreshLive();
}

function openTemplateLibrary(onSelectCallback = null, opts = {}) {
    _openLibraryModal('template', onSelectCallback, opts);
}
window.openTemplateLibrary = openTemplateLibrary;

function openProjectLibrary(opts = {}) {
    _openLibraryModal('liveProject', null, opts);
}
window.openProjectLibrary = openProjectLibrary;
window.openLiveProjectsLibrary = openProjectLibrary;

window.reelsRefreshTemplateLibraryIfOpen = function(modeOverride = null) {
    const targets = modeOverride ? [_getLibState(modeOverride)] : [_libStates.liveProject, _libStates.template];
    for (const st of targets) {
        const modal = document.getElementById(st.cfg.modalId);
        if (modal && getComputedStyle(modal).display !== 'none') {
            _refreshLibraryView(st);
        }
    }
};

function _toggleCardSelection(st, id, options = {}) {
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal || modal._onSelectCallback || !id) return;
    _applyCardSelectionAction(st, modal, 't:' + String(id), {
        fromCheckbox: true,
        shiftKey: !!options.shiftKey,
        ctrlKey: !!options.ctrlKey,
        metaKey: !!options.metaKey,
    });
}

async function _fetchLibraryItemsFull(st, ids) {
    const cleanIds = [...new Set((ids || []).map(v => String(v || '').trim()).filter(Boolean))];
    if (!cleanIds.length) return [];
    try {
        const items = await _libApiRequest(st, 'get-many', { ids: cleanIds });
        if (Array.isArray(items) && items.length) return items;
    } catch (_) {}
    const out = [];
    for (const id of cleanIds) {
        try {
            const item = await _libApiRequest(st, 'get', { id });
            if (item && item.projectData) out.push(item);
        } catch (err) {
            console.warn(`[${st.cfg.itemNoun}] 读取失败:`, id, err);
        }
    }
    return out;
}

async function _applyLiveProjectIdsToWorkspace(st, ids, options = {}) {
    const cleanIds = [...new Set((ids || []).map(v => String(v || '').trim()).filter(Boolean))];
    if (!cleanIds.length) return false;
    const modal = document.getElementById(st.cfg.modalId);
    const allSummaries = modal?._allSummaries || [];
    const summaryMap = new Map(allSummaries.map(s => [String(s.id), s]));
    const fullList = await _fetchLibraryItemsFull(st, cleanIds);
    const fullMap = new Map(fullList.map(item => [String(item.id), item]));
    const entries = cleanIds.map(id => {
        const tplData = fullMap.get(id);
        if (!tplData || !tplData.projectData) return null;
        return { tplData, summary: summaryMap.get(id) || { id, name: tplData.name, updatedAt: tplData.updatedAt } };
    }).filter(Boolean);
    if (!entries.length) {
        showToast?.('所选工程缺少工程数据，无法打开', 'warning');
        return false;
    }

    const folderId = typeof options.folderId === 'string' ? options.folderId : (st.folderId || '');
    const folderPath = options.folderPath || _buildTemplateFolderPathText(folderId, st.folderData.folders, st.cfg.homeLabel);
    const folderDirectCount = Number(options.folderTotalCount) || allSummaries.filter(t => (st.folderData.assignments[t.id] || '') === folderId).length || entries.length;
    const scopeMode = options.scopeMode || (entries.length >= folderDirectCount ? 'folder' : 'selected');

    if (typeof window.reelsApplyLibraryProjects === 'function') {
        const ok = await window.reelsApplyLibraryProjects(entries, {
            folderId,
            folderPath,
            folderTotalCount: folderDirectCount,
            scopeMode,
            loadMode: options.loadMode || 'replace',
            confirmSwitch: options.confirmSwitch !== false,
        });
        if (!ok) return false;
    }

    if (modal && options.closeModal !== false) modal.style.display = 'none';
    if (typeof openPanelByName === 'function') openPanelByName('batch-reels');
    showToast?.(`✅ 已打开「${folderPath}」中的 ${entries.length} 个实时工程标签`, 'success', 4000);
    return true;
}

async function _applySelectedLiveProjects(st, options = {}) {
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal || modal._onSelectCallback) return;
    const selected = modal._selectedItemIds || new Set();
    const selectedFolders = modal._selectedFolderIds || new Set();
    const visibleOrder = (modal._visibleSummaries || []).map(t => String(t.id));
    let ids = visibleOrder.filter(id => selected.has(id));
    const loadMode = options.loadMode === 'append' ? 'append' : 'replace';
    if (!ids.length && selectedFolders.size > 0) {
        const pickedFolderIds = [...selectedFolders];
        if (pickedFolderIds.length === 1 && loadMode === 'replace') {
            await window.reelsApplyFolderById(pickedFolderIds[0]);
            return;
        }
        const folderSet = new Set(pickedFolderIds);
        ids = (modal._allSummaries || [])
            .filter(t => folderSet.has(st.folderData.assignments[t.id] || ''))
            .map(t => String(t.id));
        if (!ids.length) {
            showToast?.('所选文件夹下暂无直属工程可打开', 'info');
            return;
        }
        await _applyLiveProjectIdsToWorkspace(st, ids, {
            folderId: pickedFolderIds.length === 1 ? pickedFolderIds[0] : (st.folderId || ''),
            folderTotalCount: ids.length,
            scopeMode: pickedFolderIds.length === 1 ? 'folder' : 'selected',
            loadMode,
        });
        return;
    }
    if (!ids.length) {
        showToast?.('请先勾选要打开的工程卡片', 'info');
        return;
    }
    const visibleDirectCount = (modal._visibleSummaries || []).length;
    const folderId = st.searchTerm.trim()
        ? (st.folderData.assignments[ids[0]] || '')
        : st.folderId;
    const folderTotalCount = st.searchTerm.trim()
        ? (modal._allSummaries || []).filter(t => (st.folderData.assignments[t.id] || '') === folderId).length
        : visibleDirectCount;
    const scopeMode = (!st.searchTerm.trim() && ids.length >= visibleDirectCount && !!folderId) ? 'folder' : 'selected';
    await _applyLiveProjectIdsToWorkspace(st, ids, { folderId, folderTotalCount, scopeMode, loadMode });
}

window.reelsApplyFolderById = async function(targetFolderId = '') {
    const st = _getLibState('liveProject');
    const folderId = String(targetFolderId || '').trim();
    const allTemplates = _sortLibraryItems(st, await _libApiRequest(st, 'list') || []);
    const foldersData = await _libFolderRequest(st, 'list');
    st.folderData = { folders: [], assignments: {}, folderOrders: {}, ...foldersData };

    const directTemplates = allTemplates.filter(t => (st.folderData.assignments[t.id] || '') === folderId);
    const keyOrder = st.folderData.folderOrders?.[folderId || ''] || (folderId ? [] : st.folderData.libraryOrder) || [];
    const orderedTemplates = (localStorage.getItem(st.cfg.sortKey) || 'manual') === 'manual' && Array.isArray(keyOrder) && keyOrder.length
        ? (() => {
            const rank = new Map(keyOrder.map((k, i) => [k, i]));
            return [...directTemplates].sort((a, b) => (rank.get('t:' + a.id) ?? -1) - (rank.get('t:' + b.id) ?? -1));
        })()
        : directTemplates;

    if (!orderedTemplates.length) {
        showToast?.('该文件夹当前没有直属工程标签（可先「新建空白标签」或拖入工程）', 'info');
        return false;
    }
    const modal = document.getElementById(st.cfg.modalId);
    if (modal) modal._allSummaries = allTemplates;
    return await _applyLiveProjectIdsToWorkspace(st, orderedTemplates.map(t => t.id), {
        folderId,
        folderPath: _buildTemplateFolderPathText(folderId, st.folderData.folders, st.cfg.homeLabel),
        folderTotalCount: orderedTemplates.length,
        scopeMode: 'folder',
    });
};

// 新建空白标签（实时写入工程项目）
async function _createBlankLiveProjectDialog(st, targetFolderOverride = null) {
    const folderId = typeof targetFolderOverride === 'string' ? targetFolderOverride : (st.folderId || '');
    const modal = document.getElementById(st.cfg.modalId);
    const existingCount = (modal?._visibleSummaries || []).length;
    const defaultName = `空白工程 ${existingCount + 1}`;
    const folderPath = _buildTemplateFolderPathText(folderId, st.folderData.folders, st.cfg.homeLabel);

    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:400200;background:rgba(4,7,18,0.78);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;';
    ov.innerHTML = `
        <div style="background:#14182b;border:1px solid rgba(56,189,248,0.45);border-radius:14px;padding:18px 20px;width:min(440px,94vw);color:#e2e8f0;box-shadow:0 24px 60px rgba(0,0,0,0.75);display:flex;flex-direction:column;gap:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <h3 style="margin:0;font-size:15px;color:#fff;">📄 新建空白工程标签</h3>
                <button type="button" data-close style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;">✕</button>
            </div>
            <div style="font-size:11.5px;color:#94a3b8;">位置：<b style="color:#6ee7b7;">${_tplEscapeHtml(folderPath)}</b>（建立后实时自动保存，随时可增删改任务与样式）</div>
            <input type="text" id="lpl-blank-name-input" value="${_tplEscapeHtml(defaultName)}" placeholder="输入空白工程标签名称..." style="width:100%;box-sizing:border-box;padding:8px 10px;background:#0b1020;color:#fff;border:1px solid #475569;border-radius:8px;font-size:13px;outline:none;" />
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">
                <button type="button" data-close style="padding:7px 12px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;font-size:12px;cursor:pointer;">取消</button>
                <button type="button" id="lpl-create-stay-btn" style="padding:7px 13px;border-radius:8px;border:1px solid rgba(56,189,248,0.45);background:rgba(14,165,233,0.18);color:#7dd3fc;font-size:12px;font-weight:600;cursor:pointer;">仅新建并留在文件夹</button>
                <button type="button" id="lpl-create-open-btn" style="padding:7px 15px;border-radius:8px;border:none;background:linear-gradient(135deg,#0ea5e9,#10b981);color:#fff;font-size:12px;font-weight:700;cursor:pointer;">✨ 新建并打开编辑</button>
            </div>
        </div>
    `;
    document.body.appendChild(ov);
    const input = ov.querySelector('#lpl-blank-name-input');
    input?.focus();
    input?.select();

    const submitCreate = async (openAfter) => {
        const cleanName = String(input?.value || '').trim() || defaultName;
        ov.remove();
        try {
            const globalStyle = window._reelsState?.globalSubtitleStyle || (typeof _readStyleFromUI === 'function' ? _readStyleFromUI() : {});
            const projectData = (typeof ReelsProject !== 'undefined' && ReelsProject.collectProjectData)
                ? ReelsProject.collectProjectData({
                    tasks: [],
                    backgroundLibrary: window._reelsState?.backgroundLibrary || [],
                    style: globalStyle || {},
                    exportOpts: { ...(window._reelsState?.exportOpts || {}), workMode: document.getElementById('reels-work-mode')?.value || 'srt' },
                    watermarks: window._reelsState?.watermarks || [],
                    selectedIdx: -1,
                })
                : { version: '2.0.0', createdAt: new Date().toISOString(), app: 'VideoKit', style: globalStyle || {}, exportOpts: {}, tasks: [], selectedIdx: -1 };
            const saved = await _libApiRequest(st, 'save', {
                name: cleanName,
                folderId,
                thumbnail: '',
                projectData,
            });
            await _refreshLibraryView(st);
            showToast?.(`📄 已新建空白工程「${cleanName}」并实时保存`, 'success');
            if (openAfter && saved?.id) {
                const wsStatus = typeof window.reelsGetWorkspaceLibraryStatus === 'function' ? window.reelsGetWorkspaceLibraryStatus() : null;
                const appendInSameFolder = Boolean(wsStatus?.folderId && wsStatus.folderId === folderId);
                await _applyLiveProjectIdsToWorkspace(st, [saved.id], {
                    folderId,
                    loadMode: appendInSameFolder ? 'append' : 'replace',
                    confirmSwitch: !appendInSameFolder,
                });
            }
        } catch (err) {
            showToast?.(`新建空白标签失败：${err.message}`, 'error');
        }
    };

    ov.querySelectorAll('[data-close]').forEach(el => { el.onclick = () => ov.remove(); });
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    ov.querySelector('#lpl-create-stay-btn').onclick = () => submitCreate(false);
    ov.querySelector('#lpl-create-open-btn').onclick = () => submitCreate(true);
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitCreate(true); }
        else if (e.key === 'Escape') ov.remove();
    });
}

async function _captureWorkspaceIntoCurrentFolder(st) {
    const groups = typeof window.reelsCollectWorkspaceProjectGroups === 'function'
        ? window.reelsCollectWorkspaceProjectGroups()
        : [];
    const targetGroups = groups.filter(g => g && !g.libraryTemplateId);
    if (!targetGroups.length) {
        showToast?.('当前工作区的标签都已经绑定在实时工程项目中啦 ✅', 'info');
        return;
    }
    try {
        const res = await _archiveGroupsToLibrary(targetGroups, {
            folderMode: 'current-folder',
            parentFolderId: st.folderId || '',
            splitByGroup: false,
            bindWorkspace: true,
            captureThumbnails: true,
            syncPresetAssets: false,
        });
        await _refreshLibraryView(st);
        showToast?.(`✅ 已将 ${res.savedResults.length} 个标签实时收录到「${res.rootFolderPath}」`, 'success');
    } catch (err) {
        showToast?.(`收录失败：${err.message}`, 'error');
    }
}

async function _sealSelectedLiveProjectsToTemplates(st) {
    const modal = document.getElementById(st.cfg.modalId);
    const selected = [...(modal?._selectedItemIds || [])];
    if (!selected.length) {
        showToast?.('请先勾选要封存的工程项目卡片', 'info');
        return;
    }
    if (!confirm(`将所选 ${selected.length} 个实时工程另存一份为「📂 模板库」封存模板？\n\n原工程项目会继续保持实时编辑，新生成的模板独立封存互不干扰。`)) return;
    try {
        const items = await _fetchLibraryItemsFull(st, selected);
        let saved = 0;
        for (const item of items) {
            if (!item?.projectData) continue;
            await apiFetch(`${API_BASE}/templates/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: item.name,
                    description: item.description || '从工程项目封存',
                    thumbnail: item.thumbnail || '',
                    tags: item.tags || [],
                    projectData: JSON.parse(JSON.stringify(item.projectData)),
                }),
            });
            saved++;
        }
        showToast?.(`🔒 已封存 ${saved} 个模板到「📂 模板库」`, 'success', 4000);
        window.reelsRefreshTemplateLibraryIfOpen?.('template');
    } catch (err) {
        showToast?.(`封存模板失败：${err.message}`, 'error');
    }
}

async function _openImportFromTemplateModal(st) {
    try {
        const [tplList, tplFolders] = await Promise.all([
            _libApiRequest(_getLibState('template'), 'list'),
            _libFolderRequest(_getLibState('template'), 'list'),
        ]);
        if (!Array.isArray(tplList) || !tplList.length) {
            showToast?.('「模板库」当前还没有任何内容可导入', 'info');
            return;
        }
        const assign = tplFolders?.assignments || {};
        const folders = tplFolders?.folders || [];
        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:400200;background:rgba(4,7,18,0.82);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:16px;';
        ov.innerHTML = `
            <div style="background:#14182b;border:1px solid rgba(16,185,129,0.42);border-radius:14px;padding:18px 20px;width:min(540px,95vw);max-height:80vh;display:flex;flex-direction:column;gap:10px;color:#e2e8f0;box-shadow:0 24px 60px rgba(0,0,0,0.8);">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <h3 style="margin:0;font-size:15px;color:#fff;">📥 从「📂 模板库」复制导入到实时工程</h3>
                    <button type="button" data-close style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;">✕</button>
                </div>
                <div style="font-size:12px;color:#94a3b8;">复制过来后可作为实时工程自由修改，<b>原模板库中的封存模板完全保留不变</b>。</div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <button type="button" id="ift-import-all-tree" style="padding:7px 14px;border-radius:8px;border:none;background:linear-gradient(135deg,#059669,#10b981);color:#fff;font-size:12px;font-weight:700;cursor:pointer;">📂 一键按原文件夹树全部复制过来 (${tplList.length} 个)</button>
                    <button type="button" id="ift-select-toggle" style="margin-left:auto;padding:5px 10px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;font-size:11px;cursor:pointer;">全选/取消</button>
                </div>
                <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:8px;max-height:44vh;">
                    ${tplList.map(tpl => {
                        const fPath = _buildTemplateFolderPathText(assign[tpl.id] || '', folders, '主模板库');
                        return `<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.03);cursor:pointer;font-size:12px;">
                            <input type="checkbox" class="ift-item-cb" value="${_tplEscapeHtml(tpl.id)}" style="accent-color:#10b981;">
                            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_tplEscapeHtml(tpl.name)}</span>
                            <span style="font-size:10px;color:#94a3b8;">📁 ${_tplEscapeHtml(fPath)}</span>
                        </label>`;
                    }).join('')}
                </div>
                <div style="display:flex;justify-content:flex-end;gap:8px;">
                    <button type="button" data-close style="padding:7px 14px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;font-size:12px;cursor:pointer;">取消</button>
                    <button type="button" id="ift-import-selected" style="padding:7px 16px;border-radius:8px;border:none;background:#6366f1;color:#fff;font-size:12px;font-weight:700;cursor:pointer;">✅ 复制所选到当前目录</button>
                </div>
            </div>
        `;
        document.body.appendChild(ov);
        ov.querySelectorAll('[data-close]').forEach(el => { el.onclick = () => ov.remove(); });
        ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
        ov.querySelector('#ift-select-toggle').onclick = () => {
            const cbs = [...ov.querySelectorAll('.ift-item-cb')];
            const allChecked = cbs.length > 0 && cbs.every(c => c.checked);
            cbs.forEach(c => { c.checked = !allChecked; });
        };
        const runImport = async (payload) => {
            try {
                const res = await _libApiRequest(st, 'import-from-templates', payload);
                ov.remove();
                await _refreshLibraryView(st);
                showToast?.(`✅ 已复制导入 ${res.importedCount || 0} 个工程（保留原模板库不变）`, 'success', 4000);
            } catch (err) {
                showToast?.(`导入失败：${err.message}`, 'error');
            }
        };
        ov.querySelector('#ift-import-all-tree').onclick = () => runImport({ copyAllFolders: true, targetFolderId: st.folderId || '' });
        ov.querySelector('#ift-import-selected').onclick = () => {
            const ids = [...ov.querySelectorAll('.ift-item-cb:checked')].map(c => c.value);
            if (!ids.length) { showToast?.('请至少勾选一个模板', 'info'); return; }
            runImport({ templateIds: ids, copyAllFolders: false, targetFolderId: st.folderId || '' });
        };
    } catch (err) {
        showToast?.(`读取模板库失败：${err.message}`, 'error');
    }
}

async function _refreshLibraryView(st) {
    _closeTemplateContextMenu();
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal) return;
    const container = modal.querySelector('[data-role="grid-container"]');
    const badge = modal.querySelector('[data-role="count-badge"]');
    if (!container) return;

    const isPicker = !!modal._onSelectCallback;
    const p = st.cfg.prefix;

    try {
        const [rawList, rawFolders] = await Promise.all([
            _libApiRequest(st, 'list'),
            _libFolderRequest(st, 'list'),
        ]);
        const allItems = _sortLibraryItems(st, rawList || []);
        st.folderData = { folders: [], assignments: {}, folderOrders: {}, ...(rawFolders || {}) };

        if (st.mode === 'liveProject' && typeof window !== 'undefined') {
            window._reelsLibraryThumbCache = window._reelsLibraryThumbCache || {};
            for (const item of allItems) {
                if (item?.id && item.thumbnail) window._reelsLibraryThumbCache[item.id] = item.thumbnail;
            }
        }
        if (st.folderId && !st.folderData.folders.some(f => f.id === st.folderId)) st.folderId = '';

        const query = st.searchTerm.trim();
        const searching = !!query;
        const items = searching
            ? allItems.filter(t => _templateMatchesSearch(t, query, _buildTemplateFolderPathText(st.folderData.assignments[t.id] || '', st.folderData.folders, st.cfg.homeLabel)))
            : allItems.filter(t => (st.folderData.assignments[t.id] || '') === st.folderId);
        const childFoldersRaw = searching
            ? []
            : st.folderData.folders.filter(f => (f.parentId || '') === st.folderId);
        const folders = _sortLibraryItems(st, childFoldersRaw.map(folder => {
            const descIds = _collectTplDescendantFolderIds(folder.id, st.folderData.folders);
            return {
                ...folder,
                templateType: '文件夹',
                sizeBytes: allItems.filter(t => descIds.has(st.folderData.assignments[t.id] || '')).reduce((n, t) => n + (t.sizeBytes || 0), 0),
            };
        }));

        const folderChain = _getTemplateFolderChain(st.folderId, st.folderData.folders, st.cfg.homeLabel);
        const currentFolder = folderChain[folderChain.length - 1] || null;
        const moveOutBtn = modal.querySelector('[data-role="move-to-root"]');
        if (moveOutBtn) {
            moveOutBtn.style.display = currentFolder ? '' : 'none';
            moveOutBtn.textContent = currentFolder?.parentId ? '移出到上级' : '移出到根目录';
        }
        const bcEl = modal.querySelector('[data-role="breadcrumbs"]');
        if (bcEl) {
            bcEl.innerHTML = folderChain.map((f, idx) => {
                const isLast = idx === folderChain.length - 1;
                return `<span style="color:#64748b;">›</span><button class="tpl-breadcrumb-chip ${isLast ? 'is-current' : ''}" data-folder-id="${_tplEscapeHtml(f.id)}" title="${isLast ? '当前文件夹' : '点击进入或拖放到此文件夹'}">${_tplEscapeHtml(f.name)}</button>`;
            }).join('');
        }

        modal._allSummaries = allItems;
        modal._visibleSummaries = items;
        modal._visibleFolderIds = searching ? [] : folders.map(f => String(f.id));
        if (!modal._selectedItemIds) modal._selectedItemIds = new Set();
        if (!modal._selectedFolderIds) modal._selectedFolderIds = new Set();
        const availableIds = new Set(allItems.map(item => String(item.id)));
        const availableFolderIds = new Set((st.folderData.folders || []).map(f => String(f.id)));
        [...modal._selectedItemIds].forEach(id => { if (!availableIds.has(String(id))) modal._selectedItemIds.delete(id); });
        [...modal._selectedFolderIds].forEach(fid => { if (!availableFolderIds.has(String(fid))) modal._selectedFolderIds.delete(fid); });

        _syncSortControls(st, modal);
        if (st.mode === 'liveProject') {
            _renderLiveWorkspaceBanner(st, modal, availableIds);
        } else {
            const banner = modal.querySelector('[data-role="workspace-banner"]');
            if (banner) { banner.style.display = 'none'; banner.innerHTML = ''; }
        }
        _updateLibraryHeaderContext(st);

        if (badge) {
            badge.textContent = searching
                ? `找到 ${items.length} / ${allItems.length} 个${st.cfg.itemNoun}`
                : (st.folderId ? `本级 ${folders.length ? folders.length + ' 文件夹 · ' : ''}${items.length} 个${st.cfg.itemNoun}` : `共 ${allItems.length} 个${st.cfg.itemNoun}`);
        }
        const searchStatus = modal.querySelector('[data-role="search-result"]');
        if (searchStatus) searchStatus.textContent = searching ? `全库搜索 · ${items.length} 个结果` : '';
        const applyFolderBtn = modal.querySelector('#tpl-apply-folder-btn');
        if (applyFolderBtn && st.mode === 'liveProject') {
            applyFolderBtn.disabled = searching || items.length === 0;
            applyFolderBtn.style.opacity = (!searching && items.length > 0) ? '1' : '0.45';
            applyFolderBtn.style.cursor = (!searching && items.length > 0) ? 'pointer' : 'not-allowed';
            applyFolderBtn.textContent = st.folderId ? `📂 打开本级全部(${items.length})` : `📂 打开根目录全部(${items.length})`;
        }

        if (!searching && items.length === 0 && folders.length === 0 && !st.folderId) {
            container.innerHTML = st.mode === 'template' ? `
                <div style="text-align:center;padding:70px 0;color:#64748b;">
                    <div style="font-size:48px;margin-bottom:14px;opacity:0.45;">📂</div>
                    <p style="font-size:14px;margin:0;color:#cbd5e1;">视频模板库还没有任何封存模板</p>
                    <p style="font-size:12px;color:#64748b;margin-top:6px;">点击上方「💾 保存当前工程为模板」即可定版封存当前工程，以后随时调用不会自动被修改</p>
                </div>
            ` : `
                <div style="text-align:center;padding:64px 0;color:#64748b;">
                    <div style="font-size:48px;margin-bottom:14px;opacity:0.5;">🗂️</div>
                    <p style="font-size:14px;margin:0;color:#cbd5e1;">实时工程项目区还是空的</p>
                    <p style="font-size:12px;color:#64748b;margin-top:6px;">点「📁 新建文件夹」整理目录，或点「📄 新建空白标签」立即开建实时工程（也支持「📥 从模板库导入」把旧整理内容复制过来）</p>
                </div>
            `;
            _updateLibrarySelectionUI(st);
            return;
        }

        if (searching && items.length === 0) {
            container.innerHTML = `<div style="padding:65px 20px;text-align:center;color:#94a3b8;"><div style="font-size:30px;margin-bottom:12px;">⌕</div><div>没有找到匹配的${st.cfg.itemNoun}</div></div>`;
            _updateLibrarySelectionUI(st);
            return;
        }

        const activeWorkspaceIds = (st.mode === 'liveProject' && typeof window.reelsGetWorkspaceLibraryTemplateIds === 'function')
            ? window.reelsGetWorkspaceLibraryTemplateIds()
            : new Set();

        let html = `<div id="${p}-card-grid" class="${p}-card-grid vk-lib-grid" style="--tpl-card-size:${_getLibCardSize(st)}px;--tpl-scale:${_getLibZoom(st) / 100};display:grid;grid-template-columns:repeat(auto-fill,minmax(0,min(max(96px,var(--tpl-card-size)),100%)));grid-auto-rows:1px;grid-auto-flow:row dense;column-gap:${Math.max(2, Math.round(12 * _getLibZoom(st) / 100))}px;row-gap:0;justify-content:start;align-items:start;">`;
        html += folders.map(folder => _renderFolderCard(st, folder, allItems)).join('');
        if (!searching && !items.length && st.folderId) {
            html += `<div style="grid-column:1/-1;text-align:center;color:#888;padding:34px;">${folders.length ? `此目录暂无直属${st.cfg.itemNoun}` : `此文件夹为空，可点击「📁 新建文件夹」${st.mode === 'liveProject' ? '或「📄 新建空白标签」' : ''}开始`}</div>`;
        }

        for (const item of items) {
            const thumbSrc = item.thumbnail || '';
            const dateStr = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString('zh-CN') : '';
            const taskInfo = item.taskCount ? `${item.taskCount} 条任务` : (st.mode === 'liveProject' ? '空白标签' : '0 条任务');
            const safeId = _tplEscapeHtml(item.id);
            const safeName = _tplEscapeHtml(item.name || '');
            const safeThumb = _tplEscapeHtml(thumbSrc);
            const safeDate = _tplEscapeHtml(dateStr);
            const safeTaskInfo = _tplEscapeHtml(taskInfo);
            const folderPathBadge = searching
                ? `<span style="color:#a5b4fc;font-size:10px;white-space:normal;overflow-wrap:anywhere;">📂 ${_tplEscapeHtml(_buildTemplateFolderPathText(st.folderData.assignments[item.id] || '', st.folderData.folders, st.cfg.homeLabel))}</span>`
                : '';
            const isDisabledPick = isPicker && modal._pickerDisabledIds?.has(item.id);
            const isWorkspaceActive = !isPicker && st.mode === 'liveProject' && activeWorkspaceIds.has(String(item.id));
            const thumbHtml = thumbSrc
                ? `<img draggable="false" src="${safeThumb}" style="width:100%;height:100%;object-fit:cover;" />`
                : `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#64748b;font-size:32px;gap:6px;"><span>${item.taskCount ? '🎬' : '📄'}</span>${!item.taskCount ? '<span style="font-size:10px;">空白工程</span>' : ''}</div>`;

            const actionsHtml = isPicker ? `
                <div class="tpl-actions" style="position:absolute;top:8px;right:8px;left:8px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;opacity:0;transition:opacity 0.2s;background:rgba(0,0,0,0.7);padding:6px;border-radius:8px;">
                    <button data-action="pick" ${isDisabledPick ? 'disabled' : ''} style="padding:4px 12px;font-size:12px;font-weight:600;background:${isDisabledPick ? 'rgba(120,120,130,0.35)' : 'linear-gradient(135deg,#7c5cff,#a855f7)'};color:${isDisabledPick ? '#999' : '#fff'};border:none;border-radius:6px;cursor:${isDisabledPick ? 'not-allowed' : 'pointer'};">${isDisabledPick ? '已添加' : '✅ 选用此模板'}</button>
                </div>
            ` : `
                <button type="button" class="tpl-card-preview-btn" data-id="${safeId}" title="实时预览此${st.cfg.itemNoun}效果（不影响当前工作区）">👁️ 预览</button>
            `;

            html += `
                <div class="tpl-card" draggable="true" title="单击多选 · 双击${st.mode === 'template' ? '载入模板副本' : '打开并实时编辑'} · 右键菜单 / 点右下角预览效果" data-id="${safeId}" data-name="${safeName}" data-disabled-pick="${isDisabledPick ? 'true' : 'false'}" style="background:rgba(255,255,255,${isDisabledPick ? '0.018' : '0.03'});border:1px solid ${isDisabledPick ? 'rgba(120,120,130,0.28)' : 'rgba(255,255,255,0.06)'};border-radius:12px;overflow:hidden;cursor:${isDisabledPick ? 'not-allowed' : 'pointer'};transition:all 0.2s;position:relative;${isDisabledPick ? 'opacity:0.58;' : ''}"
                     onmouseenter="this.style.borderColor='rgba(99,102,241,0.4)';this.style.transform='translateY(-2px)'"
                     onmouseleave="this.style.borderColor='rgba(255,255,255,0.06)';this.style.transform='none'">
                    <div class="tpl-template-cover" style="position:relative;width:100%;aspect-ratio:9/16;background:#0a0a1a;overflow:hidden;">${thumbHtml}${!isPicker ? actionsHtml : ''}</div>
                    ${!isPicker ? `<button type="button" class="tpl-card-check" data-id="${safeId}" title="勾选/取消多选" aria-label="多选"></button>` : ''}
                    ${isWorkspaceActive ? '<div style="position:absolute;right:8px;top:8px;z-index:3;background:rgba(16,185,129,0.92);color:#041e13;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;">实时同步中</div>' : ''}
                    ${isDisabledPick ? '<div style="position:absolute;left:8px;top:8px;background:rgba(16,185,129,0.9);color:#06150f;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;">已添加</div>' : ''}
                    <div class="tpl-card-info" style="padding:10px 8px;background:#242424;">
                        <div class="tpl-name" style="font-size:calc(12px * var(--tpl-scale,1));font-weight:500;color:#eeeeee;text-align:center;white-space:normal;overflow:visible;overflow-wrap:anywhere;word-break:break-word;display:block;line-height:1.5;" title="${safeName}">${safeName}</div>
                        <div class="tpl-meta" style="font-size:calc(10px * var(--tpl-scale,1));color:#888;margin-top:calc(8px * var(--tpl-scale,1));padding-top:calc(7px * var(--tpl-scale,1));border-top:1px solid rgba(255,255,255,0.07);display:flex;flex-direction:column;align-items:center;text-align:center;gap:calc(3px * var(--tpl-scale,1));line-height:1.4;">
                            <span style="white-space:nowrap;">${safeDate}</span>
                            <span style="white-space:nowrap;">${safeTaskInfo}</span>
                            ${folderPathBadge}
                        </div>
                    </div>
                    ${isPicker ? actionsHtml : ''}
                </div>
            `;
        }
        html += '</div>';

        const savedScroll = container._tplRenderedFolder === st.folderId && container._tplRenderedSearch === query ? container.scrollTop : 0;
        container.innerHTML = html;

        const folderOrderKey = st.folderId || '';
        const manualOrderList = st.folderData.folderOrders?.[folderOrderKey] || (!st.folderId ? st.folderData.libraryOrder : null);
        if (!searching && (localStorage.getItem(st.cfg.sortKey) || 'manual') === 'manual' && Array.isArray(manualOrderList) && manualOrderList.length) {
            const grid = container.querySelector(`.${p}-card-grid`);
            const rank = new Map(manualOrderList.map((id, i) => [id, i]));
            if (grid) {
                Array.from(grid.children)
                    .filter(el => el.matches('.tpl-card,.tpl-folder-card'))
                    .sort((a, b) => (rank.get(_libItemKey(a)) ?? -1) - (rank.get(_libItemKey(b)) ?? -1))
                    .forEach(card => grid.appendChild(card));
            }
        }

        _bindFolderCards(st, modal, container);
        container.oncontextmenu = event => {
            if (event.target.closest('.tpl-card,.tpl-folder-card,button,input,select,[contenteditable]')) return;
            event.preventDefault();
            event.stopPropagation();
            _showBlankContextMenu(st, event);
        };

        container.querySelectorAll('.tpl-card').forEach(card => {
            if (isPicker) {
                card.addEventListener('mouseenter', () => { const a = card.querySelector('.tpl-actions'); if (a) a.style.opacity = '1'; });
                card.addEventListener('mouseleave', () => { const a = card.querySelector('.tpl-actions'); if (a) a.style.opacity = '0'; });
            } else {
                card.addEventListener('contextmenu', event => {
                    if (event.target.isContentEditable) return;
                    event.preventDefault();
                    event.stopPropagation();
                    _showItemContextMenu(st, event, card);
                });
                card.querySelector('.tpl-card-check')?.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    _toggleCardSelection(st, card.dataset.id || '', {
                        shiftKey: event.shiftKey,
                        ctrlKey: event.ctrlKey,
                        metaKey: event.metaKey,
                    });
                });
                card.querySelector('.tpl-card-preview-btn')?.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    _openLibraryItemPreviewModal(st, card.dataset.id || '');
                });
            }

            card.querySelector('.tpl-actions')?.addEventListener('click', async (e) => {
                const btn = e.target.closest('button[data-action]');
                if (!btn) return;
                e.stopPropagation();
                const id = card.dataset.id || '';
                if (btn.dataset.action === 'pick') {
                    if (btn.disabled || card.dataset.disabledPick === 'true') return;
                    btn.textContent = '加载中...';
                    try {
                        const tplData = await _libApiRequest(st, 'get', { id });
                        modal._onSelectCallback?.(tplData);
                        btn.textContent = '✅ 已添加';
                    } catch (err) {
                        alert('读取模板失败');
                        btn.textContent = '✅ 选用此模板';
                    }
                }
            });

            card.querySelector('.tpl-name')?.addEventListener('dblclick', event => {
                event.preventDefault();
                event.stopPropagation();
                _renameLibraryItem(st, card.dataset.id);
            });
            card.addEventListener('dblclick', async () => {
                const id = card.dataset.id;
                if (isPicker) {
                    if (card.dataset.disabledPick === 'true') return;
                    try {
                        const tplData = await _libApiRequest(st, 'get', { id });
                        modal._onSelectCallback?.(tplData);
                    } catch (_) {}
                } else if (st.mode === 'template') {
                    await _loadTemplateInCurrentWindow(id);
                } else {
                    await _applyLiveProjectIdsToWorkspace(st, [id], { folderId: st.folderId });
                }
            });
        });

        if (!searching) _initLibraryReordering(st, modal, container);
        _initLibraryMarquee(st, modal, container);
        _bindMixedGridLayout(st, container);
        _paintLibrarySelection(st);
        _updateLibrarySelectionUI(st);
        container._tplRenderedFolder = st.folderId;
        container._tplRenderedSearch = query;
        container.scrollTop = savedScroll;
    } catch (e) {
        container.innerHTML = `<div style="color:#f87171;text-align:center;padding:40px;">加载失败: ${_tplEscapeHtml(e?.message || String(e))}</div>`;
    }
}

function _renderLiveWorkspaceBanner(st, modal, availableIds) {
    const banner = modal.querySelector('[data-role="workspace-banner"]');
    if (!banner) return;
    if (typeof window.reelsGetWorkspaceSaveCandidateInfo !== 'function') {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }
    const info = window.reelsGetWorkspaceSaveCandidateInfo(availableIds);
    const unarchived = (info.unarchivedGroups || []).filter(g => !g._fromSealedTemplate);
    const sig = `${info.totalGroups}|${unarchived.length}|${info.unarchivedTasks}|${unarchived.slice(0, 6).map(g => g.key).join(',')}`;
    if (!unarchived.length || st.dismissedBannerSig === sig) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }
    const previewText = unarchived.slice(0, 5).map(g => g.name).join(' · ') + (unarchived.length > 5 ? ` 等 ${unarchived.length} 个` : '');
    banner.style.display = 'flex';
    banner.style.alignItems = 'center';
    banner.style.justifyContent = 'space-between';
    banner.style.gap = '10px';
    banner.style.flexWrap = 'wrap';
    banner.innerHTML = `
        <div style="flex:1 1 260px;min-width:200px;">
            <div style="font-size:12px;color:#ecfdf5;font-weight:600;">⚡ 工作区有 <b style="color:#6ee7b7;">${unarchived.length}</b> 个待归入目录的标签（${info.unarchivedTasks} 条任务）：<span style="color:#a5b4fc;font-weight:400;">${_tplEscapeHtml(previewText)}</span></div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
            <input data-role="archive-folder-name" type="text" value="${_tplEscapeHtml(info.suggestedName)}" placeholder="新建工程文件夹名..." style="width:160px;padding:4px 8px;background:#0f172a;color:#f8fafc;border:1px solid rgba(129,140,248,0.45);border-radius:7px;font-size:11.5px;outline:none;" />
            <button type="button" data-role="archive-new-btn" style="padding:5px 12px;font-size:11.5px;font-weight:700;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;border-radius:7px;cursor:pointer;">✨ 建文件夹并收入</button>
            <button type="button" data-role="archive-here-btn" style="padding:5px 11px;font-size:11px;font-weight:600;background:rgba(99,102,241,0.22);color:#e0e7ff;border:1px solid rgba(129,140,248,0.45);border-radius:7px;cursor:pointer;">放入当前目录</button>
            <button type="button" data-role="archive-dismiss-btn" style="padding:4px 8px;font-size:11px;background:transparent;color:#94a3b8;border:1px solid rgba(148,163,184,0.28);border-radius:6px;cursor:pointer;">收起</button>
        </div>
    `;
    const runArchive = async (folderMode) => {
        const folderName = String(banner.querySelector('[data-role="archive-folder-name"]')?.value || info.suggestedName || '工作区工程').trim() || '工作区工程';
        await reelsAutoArchiveWorkspaceToLibrary({
            folderMode,
            folderName,
            parentFolderId: st.folderId || '',
            splitByGroup: info.groupNames.length > 0,
            captureThumbnails: true,
            bindWorkspace: true,
        });
    };
    banner.querySelector('[data-role="archive-new-btn"]')?.addEventListener('click', () => runArchive('new-folder'));
    banner.querySelector('[data-role="archive-here-btn"]')?.addEventListener('click', () => runArchive('current-folder'));
    banner.querySelector('[data-role="archive-dismiss-btn"]')?.addEventListener('click', () => {
        st.dismissedBannerSig = sig;
        banner.style.display = 'none';
    });
}

function _getVisibleSelectionKeys(modal) {
    if (!modal) return [];
    const domKeys = Array.from(modal.querySelectorAll('.vk-lib-grid > .tpl-folder-card, .vk-lib-grid > .tpl-card'))
        .map(el => el.classList.contains('tpl-folder-card') ? ('f:' + String(el.dataset.folderId || '')) : ('t:' + String(el.dataset.id || '')))
        .filter(k => k.length > 2);
    if (domKeys.length) return domKeys;
    return [
        ...(modal._visibleFolderIds || []).map(fid => 'f:' + String(fid)),
        ...(modal._visibleSummaries || []).map(t => 't:' + String(t.id)),
    ];
}

function _setKeySelected(modal, key, flag) {
    if (!modal || !key) return;
    if (!modal._selectedItemIds) modal._selectedItemIds = new Set();
    if (!modal._selectedFolderIds) modal._selectedFolderIds = new Set();
    if (key.startsWith('f:')) {
        const fid = key.slice(2);
        if (flag) modal._selectedFolderIds.add(fid); else modal._selectedFolderIds.delete(fid);
    } else if (key.startsWith('t:')) {
        const id = key.slice(2);
        if (flag) modal._selectedItemIds.add(id); else modal._selectedItemIds.delete(id);
    }
}

function _isKeySelected(modal, key) {
    if (!modal || !key) return false;
    if (key.startsWith('f:')) return !!modal._selectedFolderIds?.has(key.slice(2));
    if (key.startsWith('t:')) return !!modal._selectedItemIds?.has(key.slice(2));
    return false;
}

function _applyCardSelectionAction(st, modal, key, options = {}) {
    if (!modal || modal._onSelectCallback || !key) return;
    if (!modal._selectedItemIds) modal._selectedItemIds = new Set();
    if (!modal._selectedFolderIds) modal._selectedFolderIds = new Set();
    const keys = _getVisibleSelectionKeys(modal);
    const additive = !!(options.fromCheckbox || modal._multiSelectMode || options.ctrlKey || options.metaKey);

    if (options.shiftKey && modal._selectionAnchorKey) {
        const a = keys.indexOf(modal._selectionAnchorKey);
        const b = keys.indexOf(key);
        if (a !== -1 && b !== -1) {
            if (!additive) {
                modal._selectedItemIds.clear();
                modal._selectedFolderIds.clear();
            }
            const [lo, hi] = a <= b ? [a, b] : [b, a];
            for (let i = lo; i <= hi; i++) _setKeySelected(modal, keys[i], true);
            _paintLibrarySelection(st);
            return;
        }
    }
    if (additive) {
        _setKeySelected(modal, key, !_isKeySelected(modal, key));
    } else {
        modal._selectedItemIds.clear();
        modal._selectedFolderIds.clear();
        _setKeySelected(modal, key, true);
    }
    modal._selectionAnchorKey = key;
    _paintLibrarySelection(st);
}

function _setButtonEnabledState(btn, enabled, activeLabel = null) {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '1' : '.42';
    btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
    if (activeLabel !== null) btn.textContent = activeLabel;
}

function _updateLibrarySelectionUI(st) {
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal || modal._onSelectCallback) return;
    const selectedItems = modal._selectedItemIds || new Set();
    const selectedFolders = modal._selectedFolderIds || new Set();
    const visibleItemIds = (modal._visibleSummaries || []).map(item => String(item.id));
    const visibleFolderIds = (modal._visibleFolderIds || []).map(fid => String(fid));
    const visibleItemSel = visibleItemIds.filter(id => selectedItems.has(id)).length;
    const visibleFolderSel = visibleFolderIds.filter(fid => selectedFolders.has(fid)).length;
    const totalVisible = visibleItemIds.length + visibleFolderIds.length;
    const visibleSelectedTotal = visibleItemSel + visibleFolderSel;
    const totalItemSel = selectedItems.size;
    const totalFolderSel = selectedFolders.size;
    const totalSel = totalItemSel + totalFolderSel;

    const label = modal.querySelector('[data-role="selected-count"]');
    const allButton = modal.querySelector('[data-act="select-all"]');
    const clearBtn = modal.querySelector('[data-act="clear-selection"]');
    const invertBtn = modal.querySelector('[data-act="invert-selection"]');
    const multiBtn = modal.querySelector('[data-act="toggle-multi-mode"]');
    const savePresetsBtn = modal.querySelector('#tpl-save-selected-presets-btn');
    const applySelectedBtn = modal.querySelector('#tpl-apply-selected-btn');
    const appendSelectedBtn = modal.querySelector('#lpl-append-selected-btn');
    const sealBtn = modal.querySelector('#lpl-seal-to-tpl-btn');
    const copyToLiveBtn = modal.querySelector('#tpl-copy-selected-to-live-btn');
    const moveBtn = modal.querySelector('[data-act="batch-move"]');
    const deleteBtn = modal.querySelector('[data-act="batch-delete"]');

    if (label) {
        if (totalSel === 0) {
            label.textContent = totalVisible ? `未选择（共 ${totalVisible} 项 · 点复选框 / Shift连选 / 框选）` : '当前目录为空';
            label.style.color = '#94a3b8';
        } else {
            const parts = [];
            if (totalItemSel) parts.push(`${totalItemSel} 个${st.cfg.itemNoun}`);
            if (totalFolderSel) parts.push(`${totalFolderSel} 个文件夹`);
            label.textContent = `已选 ${parts.join(' · ')}`;
            label.style.color = '#93c5fd';
        }
    }

    const allVisibleSelected = totalVisible > 0 && visibleSelectedTotal === totalVisible;
    if (allButton) {
        allButton.disabled = totalVisible === 0;
        allButton.style.opacity = totalVisible ? '1' : '.42';
        allButton.style.cursor = totalVisible ? 'pointer' : 'not-allowed';
        if (allVisibleSelected) {
            allButton.textContent = `☐ 取消全选(${visibleSelectedTotal})`;
        } else {
            allButton.textContent = st.mode === 'template'
                ? `☑ 全选${totalVisible ? `(${totalVisible})` : '模板'}`
                : `☑ 全选${totalVisible ? `(${totalVisible})` : ''}`;
        }
    }

    if (multiBtn) {
        const on = !!modal._multiSelectMode;
        multiBtn.setAttribute('aria-pressed', String(on));
        multiBtn.textContent = on ? '☑️ 多选模式: 开（点卡片即选）' : '☑️ 多选模式: 关';
        multiBtn.style.background = on ? 'rgba(16,185,129,0.28)' : 'rgba(16,185,129,0.12)';
        multiBtn.style.borderColor = on ? 'rgba(52,211,153,0.75)' : 'rgba(16,185,129,0.34)';
        multiBtn.style.color = on ? '#ecfdf5' : '#6ee7b7';
        modal.classList.toggle('vk-multi-select-on', on);
    }

    _setButtonEnabledState(invertBtn, totalVisible > 0);
    _setButtonEnabledState(clearBtn, totalSel > 0);
    _setButtonEnabledState(applySelectedBtn, visibleItemSel > 0 || (visibleItemIds.length === 0 && visibleFolderSel > 0),
        visibleItemSel > 0
            ? `✅ 打开所选(${visibleItemSel})`
            : (visibleFolderSel > 0 ? `✅ 打开所选文件夹(${visibleFolderSel})` : '✅ 打开所选工程'));
    _setButtonEnabledState(appendSelectedBtn, visibleItemSel > 0 || visibleFolderSel > 0,
        visibleItemSel ? `📥 追加(${visibleItemSel})` : '📥 追加打开');
    _setButtonEnabledState(sealBtn, totalItemSel > 0, totalItemSel ? `🔒 封存(${totalItemSel})` : '🔒 封存到模板库');
    _setButtonEnabledState(copyToLiveBtn, totalItemSel > 0, totalItemSel ? `📤 复制到工程(${totalItemSel})` : '📤 复制到工程项目');
    _setButtonEnabledState(savePresetsBtn, totalItemSel > 0);
    _setButtonEnabledState(moveBtn, totalSel > 0, totalSel ? `📦 批量移动(${totalSel})` : '📦 批量移动');
    _setButtonEnabledState(deleteBtn, totalSel > 0, totalSel ? `🗑️ 批量删除(${totalSel})` : '🗑️ 批量删除');
}

function _selectAllLibraryItems(st, options = {}) {
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal || modal._onSelectCallback) return;
    const itemIds = (modal._visibleSummaries || []).map(t => String(t.id));
    const folderIds = (modal._visibleFolderIds || []).map(fid => String(fid));
    const selectedItems = modal._selectedItemIds || (modal._selectedItemIds = new Set());
    const selectedFolders = modal._selectedFolderIds || (modal._selectedFolderIds = new Set());
    const totalVisible = itemIds.length + folderIds.length;
    const allVisibleSelected = totalVisible > 0
        && itemIds.every(id => selectedItems.has(id))
        && folderIds.every(fid => selectedFolders.has(fid));
    if (allVisibleSelected && !options.forceAll) {
        itemIds.forEach(id => selectedItems.delete(id));
        folderIds.forEach(fid => selectedFolders.delete(fid));
    } else {
        itemIds.forEach(id => selectedItems.add(id));
        folderIds.forEach(fid => selectedFolders.add(fid));
    }
    _paintLibrarySelection(st);
}

function _invertLibrarySelection(st) {
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal || modal._onSelectCallback) return;
    const keys = _getVisibleSelectionKeys(modal);
    for (const key of keys) _setKeySelected(modal, key, !_isKeySelected(modal, key));
    _paintLibrarySelection(st);
}

function _clearLibrarySelection(st) {
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal || modal._onSelectCallback) return;
    modal._selectedItemIds?.clear();
    modal._selectedFolderIds?.clear();
    modal._selectionAnchorKey = '';
    _paintLibrarySelection(st);
}

function _toggleMultiSelectMode(st) {
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal || modal._onSelectCallback) return;
    modal._multiSelectMode = !modal._multiSelectMode;
    _updateLibrarySelectionUI(st);
    showToast?.(modal._multiSelectMode ? '☑️ 多选模式已开启：直接点击卡片或文件夹即可连续勾选' : '多选模式已关闭', 'info', 2200);
}

async function _batchCopyTemplatesToLive(st) {
    const modal = document.getElementById(st.cfg.modalId);
    const ids = [...(modal?._selectedItemIds || [])];
    if (!ids.length) { showToast?.('请先勾选要复制到工程项目的模板', 'info'); return; }
    try {
        const res = await _libApiRequest(_getLibState('liveProject'), 'import-from-templates', {
            templateIds: ids,
            copyAllFolders: false,
        });
        showToast?.(`✅ 已复制 ${res.importedCount || ids.length} 份到「🗂️ 工程项目」（原模板保留不变）`, 'success', 4000);
        window.reelsRefreshTemplateLibraryIfOpen?.('liveProject');
    } catch (err) {
        showToast?.(`复制失败：${err.message}`, 'error');
    }
}

async function _batchMoveLibrarySelection(st) {
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal || modal._onSelectCallback) return;
    const itemIds = [...(modal._selectedItemIds || [])];
    const folderIds = [...(modal._selectedFolderIds || [])];
    const total = itemIds.length + folderIds.length;
    if (!total) { showToast?.(`请先勾选要移动的${st.cfg.itemNoun}或文件夹`, 'info'); return; }

    const excludeSet = new Set();
    for (const fid of folderIds) {
        for (const d of _collectTplDescendantFolderIds(fid, st.folderData.folders || [])) excludeSet.add(d);
    }
    const target = await _pickTargetFolder(st, {
        title: `批量移动所选 ${total} 项到...`,
        excludeFolderIds: [...excludeSet],
    });
    if (target === null) return;

    const prevFolderId = st.folderId;
    try {
        if (itemIds.length) {
            await _libFolderRequest(st, 'move', { ids: itemIds, folderId: target });
            itemIds.forEach(id => modal._selectedItemIds.delete(id));
        }
        if (folderIds.length) {
            await _libFolderRequest(st, 'move-folders', { folderIds, targetParentId: target });
            folderIds.forEach(fid => modal._selectedFolderIds.delete(fid));
        }
        await _refreshLibraryView(st);
        if (st.mode === 'liveProject') {
            window.reelsOnLibraryFolderChanged?.([prevFolderId, target, ...folderIds].filter(Boolean));
        }
        const targetLabel = _buildTemplateFolderPathText(target, st.folderData.folders, st.cfg.homeLabel);
        showToast?.(`📦 已将 ${total} 项移动到「${targetLabel}」`, 'success');
    } catch (err) {
        showToast?.(`批量移动失败：${err.message}`, 'error');
    }
}

async function _batchDeleteLibrarySelection(st) {
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal || modal._onSelectCallback) return;
    const itemIds = [...(modal._selectedItemIds || [])];
    const folderIds = [...(modal._selectedFolderIds || [])];
    const total = itemIds.length + folderIds.length;
    if (!total) { showToast?.(`请先勾选要删除的${st.cfg.itemNoun}或文件夹`, 'info'); return; }

    const descParts = [];
    if (itemIds.length) descParts.push(`${itemIds.length} 个${st.cfg.itemNoun}`);
    if (folderIds.length) descParts.push(`${folderIds.length} 个文件夹（仅删除空文件夹）`);
    if (!confirm(`确定彻底删除所选 ${descParts.join(' 和 ')}？此操作不可恢复。`)) return;

    const affectedFolders = new Set();
    let deletedItems = 0, deletedFolders = 0, skippedFolders = 0, itemFailures = 0;

    for (const id of itemIds) {
        const prevFolder = st.folderData?.assignments?.[id] || st.folderId || '';
        if (prevFolder) affectedFolders.add(prevFolder);
        try {
            await _libApiRequest(st, 'delete', { id });
            if (st.mode === 'template' && _currentTemplateContext.id === id) _setCurrentTemplateContext('', '');
            modal._selectedItemIds.delete(id);
            deletedItems++;
        } catch (err) {
            itemFailures++;
            console.warn('[LibraryBatchDelete] item failed:', id, err);
        }
    }

    if (folderIds.length) {
        const folderMap = new Map((st.folderData.folders || []).map(f => [f.id, f]));
        const getDepth = (fid) => {
            let d = 0, cur = fid, seen = new Set();
            while (cur && folderMap.has(cur) && !seen.has(cur)) {
                seen.add(cur);
                cur = folderMap.get(cur).parentId || '';
                d++;
            }
            return d;
        };
        const orderedFolders = [...folderIds].sort((a, b) => getDepth(b) - getDepth(a));
        for (const fid of orderedFolders) {
            try {
                await _libFolderRequest(st, 'delete', { id: fid });
                if (st.folderId === fid) st.folderId = folderMap.get(fid)?.parentId || '';
                modal._selectedFolderIds.delete(fid);
                affectedFolders.add(fid);
                deletedFolders++;
            } catch (_) {
                skippedFolders++;
            }
        }
    }

    if (st.mode === 'liveProject' && affectedFolders.size) {
        window.reelsOnLibraryFolderChanged?.([...affectedFolders]);
    }
    await _refreshLibraryView(st);

    const summary = [];
    if (deletedItems) summary.push(`${deletedItems} 个${st.cfg.itemNoun}`);
    if (deletedFolders) summary.push(`${deletedFolders} 个文件夹`);
    const notes = [];
    if (itemFailures) notes.push(`${itemFailures} 项删除失败`);
    if (skippedFolders) notes.push(`${skippedFolders} 个非空文件夹已跳过（请先清空其内子项）`);
    showToast?.(
        (summary.length ? `🗑️ 已删除 ${summary.join('、')}` : '未删除任何项目') + (notes.length ? `（${notes.join('；')}）` : ''),
        (itemFailures || skippedFolders) ? 'warning' : 'success',
        4500
    );
}

function tplSelectAllTemplates() { _selectAllLibraryItems(_getLibState('template')); }

async function tplSaveSelectedPresets() {
    const st = _getLibState('template');
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal || modal._onSelectCallback) return;
    const selected = [...(modal._selectedItemIds || [])];
    if (!selected.length) return;
    const groupName = await (typeof _showInputDialog === 'function'
        ? _showInputDialog('预设保存分组', '例如：九月祷告、金色字幕', '我的预设')
        : Promise.resolve(prompt('输入预设分组名称：', '我的预设')));
    const category = String(groupName || '').trim();
    if (!category) return;
    if (!confirm(`将 ${selected.length} 个模板中的动态字幕和覆层分别保存到分组「${category}」？\n\n同名预设会自动重命名，不会修改原模板或已有预设。`)) return;

    const button = modal.querySelector('#tpl-save-selected-presets-btn');
    if (button) { button.disabled = true; button.textContent = '保存中…'; }
    let subtitles = 0, overlays = 0, failed = 0;
    for (const id of selected) {
        try {
            const template = await _libApiRequest(st, 'get', { id });
            if (!template?.projectData) throw new Error('模板工程数据不存在');
            const synced = _syncTemplatePresetAssets(template.name || id, template.projectData, category);
            if (synced.subtitle) subtitles++;
            if (synced.overlay) overlays++;
        } catch (error) {
            failed++;
            console.warn('[Template] 保存所选预设失败:', id, error);
        }
    }
    if (button) button.textContent = '💾 保存所选预设';
    _updateLibrarySelectionUI(st);
    showToast?.(`已保存到「${category}」：动态字幕 ${subtitles} 个、覆层 ${overlays} 个${failed ? `；${failed} 个失败` : ''}`, failed ? 'warning' : 'success', 5000);
}

// ═══════════════════════════════════════════════════════
// 2. 保存为封存模板 (📂 模板库) & 实时工程批量收录 (🗂️ 工程项目)
// ═══════════════════════════════════════════════════════

function _templateQueueShortId(value) {
    const input = String(value || 'queue').trim().toLowerCase().replace(/\\/g, '/');
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36).toUpperCase().padStart(7, '0').slice(-7);
}

function _templateQueueIdentityFromTasks(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const folderIds = [...new Set(list.map(t => t?._folderQueueId).filter(Boolean))];
    if (folderIds.length === 1) return `folder:${folderIds[0]}`;
    const tabIds = [...new Set(list.map(t => t?._batchTabId).filter(Boolean))];
    if (tabIds.length === 1) return `tab:${tabIds[0]}`;
    return '';
}

function _isCanvasBlankSampled(canvas) {
    try {
        const ctx = canvas?.getContext?.('2d');
        if (!ctx || !canvas.width || !canvas.height) return true;
        const w = canvas.width, h = canvas.height;
        const stepX = Math.max(1, Math.floor(w / 10));
        const stepY = Math.max(1, Math.floor(h / 10));
        let first = null;
        for (let y = Math.floor(stepY / 2); y < h; y += stepY) {
            for (let x = Math.floor(stepX / 2); x < w; x += stepX) {
                const px = ctx.getImageData(x, y, 1, 1).data;
                if (px[3] === 0 && !first) continue;
                const sig = `${px[0] >> 3},${px[1] >> 3},${px[2] >> 3},${px[3] >> 3}`;
                if (!first) first = sig;
                else if (sig !== first) return false;
            }
        }
        return !first || first === '0,0,0,31' || first === '0,0,0,0';
    } catch (_) {
        return false;
    }
}

function _resolveLibraryMediaUrl(rawPath) {
    const s = String(rawPath || '').trim();
    if (!s) return '';
    if (/^(local-media:|file:|blob:|data:|https?:)/i.test(s)) return s;
    if (typeof window !== 'undefined' && typeof window.electronAPI?.toFileUrl === 'function') {
        try { return window.electronAPI.toFileUrl(s) || s; } catch (_) {}
    }
    return s;
}

function _pickTaskBackgroundPath(task) {
    if (!task || typeof task !== 'object') return '';
    if (task.cover?.enabled && task.cover?.bgPath) return task.cover.bgPath;
    if (task.bgPath) return task.bgPath;
    if (task.videoPath) return task.videoPath;
    if (Array.isArray(task.bgClipPool) && task.bgClipPool.length) return String(task.bgClipPool[0] || '');
    if (Array.isArray(task.bgSegments) && task.bgSegments[0]?.path) return task.bgSegments[0].path;
    if (task.contentVideoPath) return task.contentVideoPath;
    if (task.hookFile) return task.hookFile;
    return '';
}

function _computeTaskPreviewDuration(task) {
    if (!task || typeof task !== 'object') return 6;
    let dur = 0;
    const dNum = Number(task.duration);
    if (Number.isFinite(dNum) && dNum > 0.2) dur = dNum;
    if (Array.isArray(task.segments) && task.segments.length) {
        const lastEnd = task.segments.reduce((mx, s) => Math.max(mx, Number(s?.end) || 0), 0);
        if (lastEnd > dur) dur = lastEnd;
    }
    if (Array.isArray(task.overlays) && task.overlays.length) {
        const ovEnd = task.overlays.reduce((mx, o) => Math.max(mx, Number(o?.end) || 0), 0);
        if (ovEnd > dur && ovEnd < 600) dur = Math.max(dur, ovEnd);
    }
    return Math.max(3, Math.min(300, dur || 6));
}

function _pickRepresentativeTaskTime(task, dur) {
    if (!task || typeof task !== 'object') return 1.0;
    if (Array.isArray(task.segments) && task.segments.length) {
        const firstSeg = task.segments.find(s => String(s?.edited_text || s?.text || '').trim()) || task.segments[0];
        if (firstSeg) {
            const s = Number(firstSeg.start) || 0;
            const e = Number(firstSeg.end) || (s + 2);
            return Math.min(Math.max(0.25, s + (e - s) * 0.45), Math.max(0.4, dur - 0.1));
        }
    }
    return Math.min(1.2, Math.max(0.4, dur * 0.3));
}

function _loadPreviewMediaElement(mediaPath, timeSec = 0.8, timeoutMs = 1500) {
    return new Promise((resolve) => {
        if (!mediaPath || typeof document === 'undefined' || typeof document.createElement !== 'function') {
            resolve({ element: null, kind: 'none', missing: !!mediaPath });
            return;
        }
        try {
            if (typeof window.reelsGetBackgroundPoster === 'function') {
                const cached = window.reelsGetBackgroundPoster(mediaPath);
                if (cached && cached.complete && (cached.naturalWidth || cached.width) > 0) {
                    resolve({ element: cached, kind: 'image', missing: false });
                    return;
                }
            }
        } catch (_) {}

        const url = _resolveLibraryMediaUrl(mediaPath);
        if (!url) {
            resolve({ element: null, kind: 'none', missing: true });
            return;
        }
        const isVideo = /\.(mp4|mov|mkv|avi|wmv|flv|webm)(?:[?#]|$)/i.test(mediaPath);
        let settled = false;
        const done = (res) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(res);
        };
        const timer = setTimeout(() => done({ element: null, kind: isVideo ? 'video' : 'image', missing: true }), timeoutMs);

        if (!isVideo) {
            const img = typeof Image === 'function' ? new Image() : document.createElement('img');
            img.crossOrigin = 'anonymous';
            img.onload = () => done({ element: img, kind: 'image', missing: false });
            img.onerror = () => done({ element: null, kind: 'image', missing: true });
            img.src = url;
            return;
        }

        const video = document.createElement('video');
        if (!video || typeof video.addEventListener !== 'function') {
            done({ element: null, kind: 'video', missing: true });
            return;
        }
        video.muted = true;
        video.playsInline = true;
        video.crossOrigin = 'anonymous';
        video.preload = 'auto';
        const trySeekAndFinish = () => {
            const target = Math.max(0.05, Math.min(timeSec, (Number.isFinite(video.duration) && video.duration > 0.2) ? video.duration - 0.05 : timeSec));
            if (Math.abs((video.currentTime || 0) - target) > 0.08 && Number.isFinite(video.duration) && video.duration > 0.1) {
                const onSeeked = () => {
                    video.removeEventListener('seeked', onSeeked);
                    done({ element: video, kind: 'video', missing: false });
                };
                video.addEventListener('seeked', onSeeked, { once: true });
                try { video.currentTime = target; } catch (_) { done({ element: video, kind: 'video', missing: false }); }
            } else {
                done({ element: video, kind: 'video', missing: false });
            }
        };
        video.addEventListener('loadeddata', trySeekAndFinish, { once: true });
        video.addEventListener('error', () => done({ element: null, kind: 'video', missing: true }), { once: true });
        video.src = url;
    });
}

function _drawCoverMediaToCanvas(ctx, mediaEl, targetW, targetH, bgScalePct = 100, bgXPct = 0, bgYPct = 0) {
    const sw = mediaEl?.videoWidth || mediaEl?.naturalWidth || mediaEl?.width || 0;
    const sh = mediaEl?.videoHeight || mediaEl?.naturalHeight || mediaEl?.height || 0;
    if (!sw || !sh) return false;
    const baseScale = Math.max(targetW / sw, targetH / sh);
    const mult = Math.max(0.1, (Number(bgScalePct) || 100) / 100);
    const dw = sw * baseScale * mult;
    const dh = sh * baseScale * mult;
    const dx = (targetW - dw) / 2 + (Number(bgXPct) || 0) / 100 * targetW;
    const dy = (targetH - dh) / 2 + (Number(bgYPct) || 0) / 100 * targetH;
    ctx.drawImage(mediaEl, dx, dy, dw, dh);
    return true;
}

function _renderProjectTaskFrameToCanvas(canvas, task, projectMeta = {}, timeSec = 1.0, mediaInfo = null, rendererRef = null) {
    if (!canvas) return false;
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return false;
    const w = canvas.width || 1080;
    const h = canvas.height || 1920;

    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(0.55, '#131b31');
    grad.addColorStop(1, '#080c17');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    if (mediaInfo?.element) {
        try {
            _drawCoverMediaToCanvas(ctx, mediaInfo.element, w, h, task?.bgScale ?? 100, task?.bgX ?? 0, task?.bgY ?? 0);
        } catch (_) {}
    }

    const baseStyle = {
        ...(projectMeta?.style || {}),
        ...(task?.style || {}),
        ...(task?.subtitleStyle || {}),
    };
    const style = typeof getWritingVisualStyle === 'function' ? getWritingVisualStyle(baseStyle) : baseStyle;

    const renderer = rendererRef || (typeof ReelsCanvasRenderer === 'function' ? new ReelsCanvasRenderer(canvas) : null);
    if (renderer) {
        try { renderer.renderAmbientLightingBase?.(style, w, h); } catch (_) {}
    }

    const rawOverlays = Array.isArray(task?.overlays) ? task.overlays : [];
    const activeOverlays = rawOverlays
        .filter(o => o && !o.disabled)
        .slice()
        .sort((a, b) => (Number(a.z_index) || 0) - (Number(b.z_index) || 0));

    const drawOverlayPass = (passMode) => {
        if (typeof ReelsOverlay === 'undefined' || typeof ReelsOverlay.drawOverlay !== 'function') return;
        for (const ov of activeOverlays) {
            const isIntroUnderSub = Boolean((ov.is_intro_countdown || ov.type === 'intro_countdown') && ov.intro_delay_body === false);
            const isMiddle = Boolean(ov._insertClip || ov.type === 'decor' || isIntroUnderSub);
            if (passMode === 'middle' && !isMiddle) continue;
            if (passMode === 'overlay' && isMiddle) continue;
            const ovCopy = {
                ...ov,
                _exporting: true,
                _allOverlays: activeOverlays,
                _previewPlaying: false,
                ...(ov.type === 'scroll' || ov.type === 'intro_countdown' || ov.is_intro_countdown
                    ? { _taskSegments: task?.segments || null }
                    : {}),
            };
            try {
                ReelsOverlay.drawOverlay(ctx, ovCopy, timeSec, w, h);
            } catch (_) {}
        }
    };

    drawOverlayPass('middle');
    const overlayAbove = Boolean(projectMeta?.exportOpts?.overlayAboveSubtitle ?? projectMeta?.exportOpts?.overlay_above_subtitle);
    if (!overlayAbove) drawOverlayPass('overlay');

    const segs = Array.isArray(task?.segments) ? task.segments : [];
    let activeSeg = segs.find(s => s && timeSec >= (Number(s.start) || 0) && timeSec <= (Number(s.end) || 0));
    if (!activeSeg && segs.length > 0) {
        activeSeg = segs.find(s => String(s?.edited_text || s?.text || '').trim()) || segs[0];
    }
    if (!activeSeg && task) {
        const fallbackTxt = String(task.ttsText || task.txtContent || task.aiScript || '').split(/\r?\n/).find(l => l.trim()) || '';
        if (fallbackTxt.trim()) activeSeg = { start: 0, end: 4, text: fallbackTxt.trim() };
    }

    if (renderer && activeSeg) {
        try {
            renderer.setContextSegments?.(segs.length ? segs : [activeSeg], task?.ttsText || task?.aiScript || '');
            const hasKinetic = style.anim_in_type === 'kinetic_glow_stack' && typeof renderer.renderKineticGlowBackdrop === 'function';
            if (hasKinetic) renderer.renderKineticGlowBackdrop(style, w, h);
            const segStart = Number(activeSeg.start) || 0;
            const segEnd = Math.max(segStart + 0.1, Number(activeSeg.end) || (segStart + 2.5));
            const subTime = Math.max(segStart, Math.min(segEnd - 0.02, timeSec || (segStart + (segEnd - segStart) * 0.45)));
            renderer.renderSubtitle(style, activeSeg, subTime, w, h, false, hasKinetic);
        } catch (_) {}
    }

    if (overlayAbove) drawOverlayPass('overlay');
    return true;
}

async function _captureProjectThumbnailOffscreen(projectData, fallbackThumbnail = '') {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return fallbackThumbnail;
    const tasks = Array.isArray(projectData?.tasks) ? projectData.tasks : [];
    if (!tasks.length) return fallbackThumbnail;
    if (typeof ReelsCanvasRenderer !== 'function' && typeof ReelsOverlay === 'undefined') return fallbackThumbnail;

    try {
        const task0 = tasks[0];
        const dur = _computeTaskPreviewDuration(task0);
        const repTime = _pickRepresentativeTaskTime(task0, dur);
        const bgPath = _pickTaskBackgroundPath(task0);
        const mediaInfo = await _loadPreviewMediaElement(bgPath, repTime, 1200);

        const stageCanvas = document.createElement('canvas');
        stageCanvas.width = 1080;
        stageCanvas.height = 1920;
        const ok = _renderProjectTaskFrameToCanvas(stageCanvas, task0, {
            style: projectData?.style || {},
            exportOpts: projectData?.exportOpts || {},
            watermarks: projectData?.watermarks || [],
        }, repTime, mediaInfo);

        if (mediaInfo?.kind === 'video' && mediaInfo.element) {
            try { mediaInfo.element.pause?.(); mediaInfo.element.removeAttribute?.('src'); mediaInfo.element.load?.(); } catch (_) {}
        }
        if (!ok || !stageCanvas.getContext) return fallbackThumbnail;

        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = 270;
        thumbCanvas.height = 480;
        const tCtx = thumbCanvas.getContext('2d');
        tCtx?.drawImage?.(stageCanvas, 0, 0, 270, 480);
        if (_isCanvasBlankSampled(thumbCanvas)) return fallbackThumbnail;
        const url = thumbCanvas.toDataURL('image/jpeg', 0.72);
        return url && url.length > 100 ? url : fallbackThumbnail;
    } catch (err) {
        console.warn('[Template] 离屏封面渲染失败:', err);
        return fallbackThumbnail;
    }
}

function _captureVisibleTemplateThumbnail() {
    let thumbnail = '';
    try {
        const v2 = window.ReelsPreviewV2;
        const canvas = (v2?.isOpen?.() ? v2.getCanvas?.() : null)
            || document.getElementById('reels-preview-canvas');
        if (canvas) {
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = 270;
            thumbCanvas.height = 480;
            const ctx = thumbCanvas.getContext('2d');
            ctx.drawImage(canvas, 0, 0, 270, 480);
            if (!_isCanvasBlankSampled(thumbCanvas)) {
                thumbnail = thumbCanvas.toDataURL('image/jpeg', 0.65);
            }
        }
    } catch (e) {
        console.warn('[Template] 截图失败:', e);
    }
    return thumbnail;
}
window._captureVisibleTemplateThumbnail = _captureVisibleTemplateThumbnail;

async function _captureTemplateThumbnailForTasks(tasks, fallbackThumbnail = '', projectMeta = null) {
    if (!Array.isArray(tasks) || tasks.length === 0) return fallbackThumbnail;
    const offscreenThumb = await _captureProjectThumbnailOffscreen({
        tasks,
        style: projectMeta?.style || window._reelsState?.globalSubtitleStyle || {},
        exportOpts: projectMeta?.exportOpts || window._reelsState?.exportOpts || {},
        watermarks: projectMeta?.watermarks || window._reelsState?.watermarks || [],
    }, '');
    if (offscreenThumb) return offscreenThumb;

    const state = window._reelsState;
    if (!state) return fallbackThumbnail;
    const originalTasks = state.tasks;
    const originalSelectedIdx = state.selectedIdx;
    tasks = JSON.parse(JSON.stringify(tasks));
    window._templateThumbnailCaptureActive = true;
    try {
        state.tasks = tasks;
        state.selectedIdx = -1;
        if (typeof reelsSelectTask === 'function') reelsSelectTask(0);
        else {
            state.selectedIdx = 0;
            if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
        }
        await new Promise(resolve => setTimeout(resolve, 450));
        return _captureVisibleTemplateThumbnail() || fallbackThumbnail;
    } catch (error) {
        console.warn('[Template] 队列独立截图失败:', error);
        return fallbackThumbnail;
    } finally {
        state.tasks = originalTasks;
        state.selectedIdx = -1;
        if (originalSelectedIdx >= 0 && originalSelectedIdx < originalTasks.length && typeof reelsSelectTask === 'function') {
            reelsSelectTask(originalSelectedIdx);
        } else {
            state.selectedIdx = originalSelectedIdx;
            if (typeof _renderTaskList === 'function') _renderTaskList();
        }
        window._templateThumbnailCaptureActive = false;
    }
}
window.captureTemplateThumbnailForTasks = _captureTemplateThumbnailForTasks;
window.reelsCaptureProjectThumbnailFromData = _captureProjectThumbnailOffscreen;

function _updateCardThumbnailInDom(st, id, thumbnail) {
    if (!id || !thumbnail) return;
    if (typeof window !== 'undefined') {
        window._reelsLibraryThumbCache = window._reelsLibraryThumbCache || {};
        window._reelsLibraryThumbCache[id] = thumbnail;
    }
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal) return;
    for (const list of [modal._allSummaries, modal._visibleSummaries]) {
        const hit = list?.find?.(t => String(t?.id) === String(id));
        if (hit) hit.thumbnail = thumbnail;
    }
    const cards = Array.from(modal.querySelectorAll('.tpl-card') || []);
    const card = cards.find(c => String(c.dataset?.id) === String(id));
    const cover = card?.querySelector?.('.tpl-template-cover');
    if (cover) {
        let img = cover.querySelector('img');
        if (!img) {
            const previewBtn = cover.querySelector('.tpl-card-preview-btn');
            cover.innerHTML = `<img draggable="false" src="${_tplEscapeHtml(thumbnail)}" style="width:100%;height:100%;object-fit:cover;" />`;
            if (previewBtn) cover.appendChild(previewBtn);
        } else {
            img.src = thumbnail;
        }
    }
}

async function _repairTemplateThumbnailsByIds(itemIds, options = {}) {
    const mode = options.mode === 'liveProject' ? 'liveProject' : 'template';
    const st = _getLibState(mode);
    const ids = [...new Set((itemIds || []).filter(Boolean))];
    if (!ids.length) return { repaired: 0, failed: 0 };
    const btnId = mode === 'liveProject' ? 'lpl-repair-thumbnails-btn' : 'tpl-repair-thumbnails-btn';
    const defaultBtnText = mode === 'liveProject' ? '📸 生成/修复封面' : '📸 修复重复封面';
    const button = document.getElementById(btnId);
    const originalText = button?.textContent || '';
    if (button) button.disabled = true;
    let repaired = 0, failed = 0;
    try {
        for (let i = 0; i < ids.length; i++) {
            if (button) button.textContent = `📸 ${i + 1}/${ids.length}`;
            try {
                const tpl = await _libApiRequest(st, 'get', { id: ids[i] });
                const tasks = JSON.parse(JSON.stringify(tpl?.projectData?.tasks || []));
                if (!tasks.length) throw new Error(`${st.cfg.itemNoun}没有任务`);
                const thumbnail = await _captureTemplateThumbnailForTasks(tasks, '', tpl?.projectData || null);
                if (!thumbnail) throw new Error('未能生成截图');
                await _libApiRequest(st, 'thumbnail', {
                    id: tpl.id,
                    name: tpl.name,
                    description: tpl.description || '',
                    tags: tpl.tags || [],
                    thumbnail,
                });
                _updateCardThumbnailInDom(st, tpl.id, thumbnail);
                repaired++;
            } catch (error) {
                failed++;
                console.warn(`[${st.cfg.itemNoun}] 修复封面失败 ${ids[i]}:`, error);
            }
        }
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText || defaultBtnText;
        }
        if (document.getElementById(st.cfg.modalId)) _refreshLibraryView(st);
    }
    if (!options.silent) {
        showToast?.(`已生成/更新 ${repaired} 张${st.cfg.itemNoun}封面${failed ? `，${failed} 张失败` : ''}`, failed ? 'warning' : 'success', 6000);
    }
    return { repaired, failed };
}

async function repairDuplicateTemplateThumbnails(stOrMode = 'template') {
    const mode = typeof stOrMode === 'string' ? stOrMode : (stOrMode?.mode || 'template');
    const st = _getLibState(mode);
    try {
        const items = await _libApiRequest(st, 'list') || [];
        const byThumbnail = new Map();
        const missingIds = [];
        items.forEach(item => {
            const key = String(item.thumbnail || '');
            if (!key) {
                if ((Number(item.taskCount) || 0) > 0) missingIds.push(item.id);
                return;
            }
            if (!byThumbnail.has(key)) byThumbnail.set(key, []);
            byThumbnail.get(key).push(item.id);
        });
        const duplicateIds = [...byThumbnail.values()].filter(group => group.length > 1).flat();
        const targetIds = [...new Set([...missingIds, ...duplicateIds])];
        if (!targetIds.length) {
            showToast?.(`所有${st.cfg.itemNoun}封面均已完整且无重复`, 'info');
            return;
        }
        const desc = [
            missingIds.length ? `${missingIds.length} 个缺少封面` : '',
            duplicateIds.length ? `${duplicateIds.length} 个共用重复封面` : '',
        ].filter(Boolean).join('、');
        if (!confirm(`检测到 ${desc}。\n\n是否逐${st.cfg.itemNoun}自动渲染生成效果封面？`)) return;
        await _repairTemplateThumbnailsByIds(targetIds, { mode });
    } catch (error) {
        showToast?.(`修复${st.cfg.itemNoun}封面失败：${error.message}`, 'error');
    }
}
window.repairDuplicateTemplateThumbnails = repairDuplicateTemplateThumbnails;
window._repairTemplateThumbnailsByIds = _repairTemplateThumbnailsByIds;

async function _openLibraryItemPreviewModal(st, itemId) {
    if (!itemId) return;
    document.getElementById('vk-lib-item-preview-modal')?.remove();

    let tplData = null;
    try {
        tplData = await _libApiRequest(st, 'get', { id: itemId });
    } catch (err) {
        showToast?.(`读取${st.cfg.itemNoun}详情失败: ${err.message}`, 'error');
        return;
    }
    const pData = tplData?.projectData || {};
    const restored = (typeof ReelsProject !== 'undefined' && ReelsProject.applyProjectData)
        ? ReelsProject.applyProjectData(pData)
        : { tasks: pData.tasks || [], style: pData.style || {}, exportOpts: pData.exportOpts || {}, watermarks: pData.watermarks || [] };
    const tasks = Array.isArray(restored.tasks) ? restored.tasks : [];

    const ov = document.createElement('div');
    ov.id = 'vk-lib-item-preview-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:400500;background:rgba(4,7,18,0.86);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;';

    let taskIdx = 0;
    let curTime = 0.8;
    let duration = 6;
    let isPlaying = false;
    let speed = 1;
    let rafId = 0;
    let lastTs = 0;
    let activeMedia = { element: null, kind: 'none', missing: false, path: '' };
    let renderer = null;
    let disposed = false;

    const cleanupMedia = () => {
        if (activeMedia?.kind === 'video' && activeMedia.element) {
            try { activeMedia.element.pause?.(); activeMedia.element.removeAttribute?.('src'); activeMedia.element.load?.(); } catch (_) {}
        }
        activeMedia = { element: null, kind: 'none', missing: false, path: '' };
    };
    const closePreview = () => {
        disposed = true;
        cancelAnimationFrame(rafId);
        cleanupMedia();
        document.removeEventListener('keydown', onKeyDown, true);
        ov.remove();
    };
    const onKeyDown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePreview(); } };
    document.addEventListener('keydown', onKeyDown, true);

    ov.innerHTML = `
        <div style="background:#0f172a;border:1px solid rgba(56,189,248,0.42);border-radius:16px;padding:16px 20px;width:min(640px,96vw);max-height:94vh;display:flex;flex-direction:column;gap:12px;color:#e2e8f0;box-shadow:0 28px 72px rgba(0,0,0,0.88);">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                <div style="min-width:0;">
                    <div style="font-size:15px;font-weight:800;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🎬 ${_tplEscapeHtml(st.cfg.itemNoun)}效果预览 — ${_tplEscapeHtml(tplData?.name || '未命名')}</div>
                    <div id="vklp-subinfo" style="font-size:11px;color:#94a3b8;margin-top:2px;"></div>
                </div>
                <button type="button" id="vklp-close" style="background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;">✕</button>
            </div>

            <div style="display:flex;justify-content:center;align-items:center;gap:12px;background:#070b14;border:1px solid rgba(148,163,184,0.16);border-radius:12px;padding:12px;position:relative;">
                ${tasks.length > 0 ? `<canvas id="vklp-canvas" width="1080" height="1920" style="height:min(54vh,480px);width:auto;aspect-ratio:9/16;border-radius:10px;background:#0a0f1d;box-shadow:0 12px 32px rgba(0,0,0,0.7);"></canvas>` : `<div style="padding:70px 20px;color:#94a3b8;font-size:13px;">📄 该空白${st.cfg.itemNoun}当前暂无任务（打开后可立即添加素材并编辑）</div>`}
                <div id="vklp-media-warn" style="display:none;position:absolute;bottom:18px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.88);border:1px solid rgba(251,191,36,0.45);color:#fde68a;font-size:11px;padding:4px 10px;border-radius:999px;white-space:nowrap;"></div>
            </div>

            ${tasks.length > 0 ? `
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:rgba(15,23,42,0.8);border:1px solid rgba(148,163,184,0.18);border-radius:8px;padding:8px 10px;">
                    <button type="button" id="vklp-play" style="padding:5px 12px;font-size:11.5px;font-weight:700;border-radius:6px;border:1px solid #38bdf8;background:rgba(14,165,233,0.22);color:#bae6fd;cursor:pointer;">▶ 播放</button>
                    <input type="range" id="vklp-scrub" min="0" max="6" step="0.05" value="0.8" style="flex:1;min-width:120px;">
                    <span id="vklp-time" style="font-size:11px;color:#cbd5e1;font-family:monospace;min-width:86px;text-align:right;">0.8s / 6.0s</span>
                    <select id="vklp-speed" style="padding:3px 6px;background:#090d16;border:1px solid #334155;border-radius:6px;color:#f8fafc;font-size:11px;">
                        <option value="0.5">0.5x</option>
                        <option value="1" selected>1.0x</option>
                        <option value="1.5">1.5x</option>
                    </select>
                </div>
                ${tasks.length > 1 ? `
                    <div style="display:flex;align-items:center;justify-content:center;gap:10px;font-size:12px;">
                        <button type="button" id="vklp-prev-task" style="padding:4px 10px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">◀ 上一条</button>
                        <span id="vklp-task-label" style="color:#a5b4fc;font-weight:600;"></span>
                        <button type="button" id="vklp-next-task" style="padding:4px 10px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">下一条 ▶</button>
                    </div>
                ` : ''}
            ` : ''}

            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding-top:4px;border-top:1px solid rgba(148,163,184,0.16);">
                <div style="display:flex;gap:8px;">
                    ${tasks.length > 0 ? `<button type="button" id="vklp-set-thumb" style="padding:6px 12px;font-size:12px;font-weight:600;border-radius:7px;border:1px solid rgba(14,165,233,0.45);background:rgba(14,165,233,0.16);color:#7dd3fc;cursor:pointer;">📸 将当前帧设为封面</button>` : ''}
                    ${st.mode === 'template' ? `<button type="button" id="vklp-new-win" style="padding:6px 12px;font-size:12px;font-weight:600;border-radius:7px;border:1px solid rgba(167,139,250,0.45);background:rgba(139,92,246,0.16);color:#ddd6fe;cursor:pointer;">🪟 在新窗口打开</button>` : ''}
                </div>
                <div style="display:flex;gap:8px;margin-left:auto;">
                    <button type="button" id="vklp-close-btn" style="padding:6px 14px;font-size:12px;border-radius:7px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">关闭</button>
                    <button type="button" id="vklp-open-edit" style="padding:6px 16px;font-size:12px;font-weight:700;border-radius:7px;border:none;background:linear-gradient(135deg,#10b981,#059669);color:#fff;cursor:pointer;">${st.mode === 'liveProject' ? '⚡ 打开并编辑此工程' : '📂 载入模板副本'}</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(ov);
    ov.querySelector('#vklp-close')?.addEventListener('click', closePreview);
    ov.querySelector('#vklp-close-btn')?.addEventListener('click', closePreview);
    ov.addEventListener('click', (e) => { if (e.target === ov) closePreview(); });

    const canvas = ov.querySelector('#vklp-canvas');
    if (canvas && typeof ReelsCanvasRenderer === 'function') renderer = new ReelsCanvasRenderer(canvas);

    const drawFrameNow = () => {
        if (disposed || !canvas || !tasks.length) return;
        const task = tasks[taskIdx];
        if (!task) return;
        if (activeMedia?.kind === 'video' && activeMedia.element && Number.isFinite(activeMedia.element.duration) && activeMedia.element.duration > 0.1) {
            const targetT = curTime % activeMedia.element.duration;
            if (!isPlaying && Math.abs((activeMedia.element.currentTime || 0) - targetT) > 0.08) {
                try { activeMedia.element.currentTime = targetT; } catch (_) {}
            }
        }
        _renderProjectTaskFrameToCanvas(canvas, task, restored, curTime, activeMedia, renderer);
        const scrub = ov.querySelector('#vklp-scrub');
        const tLabel = ov.querySelector('#vklp-time');
        if (scrub) scrub.value = String(Math.min(duration, curTime));
        if (tLabel) tLabel.textContent = `${curTime.toFixed(1)}s / ${duration.toFixed(1)}s`;
    };

    const loadTaskIntoStage = async (newIdx) => {
        if (!tasks.length) return;
        taskIdx = ((newIdx % tasks.length) + tasks.length) % tasks.length;
        const task = tasks[taskIdx];
        duration = _computeTaskPreviewDuration(task);
        curTime = _pickRepresentativeTaskTime(task, duration);

        const scrub = ov.querySelector('#vklp-scrub');
        if (scrub) { scrub.max = String(duration); scrub.value = String(curTime); }
        const subInfo = ov.querySelector('#vklp-subinfo');
        if (subInfo) {
            const ovCount = Array.isArray(task.overlays) ? task.overlays.filter(o => o && !o.disabled).length : 0;
            const segCount = Array.isArray(task.segments) ? task.segments.length : 0;
            subInfo.textContent = `共 ${tasks.length} 条任务 · 字幕 ${segCount} 段 · 覆层/特效 ${ovCount} 层 · 时长 ${duration.toFixed(1)}s`;
        }
        const taskLabel = ov.querySelector('#vklp-task-label');
        if (taskLabel) {
            const tTitle = task.exportName || task.baseName || task.name || `任务 ${taskIdx + 1}`;
            taskLabel.textContent = `第 ${taskIdx + 1} / ${tasks.length} 条：${tTitle}`;
        }

        const bgPath = _pickTaskBackgroundPath(task);
        cleanupMedia();
        activeMedia = await _loadPreviewMediaElement(bgPath, curTime, 1600);
        activeMedia.path = bgPath;
        const warnEl = ov.querySelector('#vklp-media-warn');
        if (warnEl) {
            if (bgPath && activeMedia.missing) {
                warnEl.style.display = 'block';
                warnEl.textContent = '⚠️ 本地背景素材暂未找到（已按原样渲染全部字幕、覆层与特效）';
            } else {
                warnEl.style.display = 'none';
            }
        }
        drawFrameNow();
    };

    const tick = (ts) => {
        if (disposed || !isPlaying) return;
        if (!lastTs) lastTs = ts;
        const dt = Math.min(0.1, (ts - lastTs) / 1000) * speed;
        lastTs = ts;
        curTime += dt;
        if (curTime > duration) {
            curTime = 0;
            if (activeMedia?.kind === 'video' && activeMedia.element) {
                try { activeMedia.element.currentTime = 0; } catch (_) {}
            }
        }
        drawFrameNow();
        rafId = requestAnimationFrame(tick);
    };

    ov.querySelector('#vklp-play')?.addEventListener('click', () => {
        const playBtn = ov.querySelector('#vklp-play');
        isPlaying = !isPlaying;
        if (playBtn) playBtn.textContent = isPlaying ? '⏸ 暂停' : '▶ 播放';
        if (isPlaying) {
            if (activeMedia?.kind === 'video' && activeMedia.element) {
                try { activeMedia.element.playbackRate = speed; activeMedia.element.play?.().catch?.(() => {}); } catch (_) {}
            }
            lastTs = 0;
            rafId = requestAnimationFrame(tick);
        } else {
            cancelAnimationFrame(rafId);
            if (activeMedia?.kind === 'video' && activeMedia.element) {
                try { activeMedia.element.pause?.(); } catch (_) {}
            }
        }
    });
    ov.querySelector('#vklp-scrub')?.addEventListener('input', (e) => {
        curTime = parseFloat(e.target.value) || 0;
        drawFrameNow();
    });
    ov.querySelector('#vklp-speed')?.addEventListener('change', (e) => {
        speed = parseFloat(e.target.value) || 1;
        if (activeMedia?.kind === 'video' && activeMedia.element) {
            try { activeMedia.element.playbackRate = speed; } catch (_) {}
        }
    });
    ov.querySelector('#vklp-prev-task')?.addEventListener('click', () => loadTaskIntoStage(taskIdx - 1));
    ov.querySelector('#vklp-next-task')?.addEventListener('click', () => loadTaskIntoStage(taskIdx + 1));

    ov.querySelector('#vklp-set-thumb')?.addEventListener('click', async () => {
        if (!canvas) return;
        try {
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = 270;
            thumbCanvas.height = 480;
            thumbCanvas.getContext('2d').drawImage(canvas, 0, 0, 270, 480);
            const thumbnail = thumbCanvas.toDataURL('image/jpeg', 0.72);
            await _libApiRequest(st, 'thumbnail', {
                id: tplData.id, name: tplData.name, description: tplData.description || '', tags: tplData.tags || [], thumbnail,
            });
            _updateCardThumbnailInDom(st, tplData.id, thumbnail);
            showToast?.(`📸 已将当前预览画面设为「${tplData.name}」封面`, 'success');
        } catch (err) {
            showToast?.(`设置封面失败: ${err.message}`, 'error');
        }
    });
    ov.querySelector('#vklp-new-win')?.addEventListener('click', () => {
        closePreview();
        _openTemplateInWindow(tplData.id, tplData.name || '');
    });
    ov.querySelector('#vklp-open-edit')?.addEventListener('click', async () => {
        closePreview();
        if (st.mode === 'liveProject') {
            await _applyLiveProjectIdsToWorkspace(st, [itemId], { folderId: st.folderId });
        } else {
            await _loadTemplateInCurrentWindow(itemId);
        }
    });

    if (tasks.length > 0) await loadTaskIntoStage(0);
}
window.openLibraryItemPreview = (mode, itemId) => _openLibraryItemPreviewModal(_getLibState(mode), itemId);

async function _syncCloudHubIntoProjectLibrary(st) {
    if (typeof window.reelsBatchSyncCloudProjectsToLibrary === 'function') {
        const res = await window.reelsBatchSyncCloudProjectsToLibrary({ openFolderInLibrary: true });
        if (res?.targetFolderId && st.mode === 'liveProject') {
            st.folderId = res.targetFolderId;
        }
        await _refreshLibraryView(st);
        return res;
    }
    if (typeof window.openCloudHubDialog === 'function') {
        window.openCloudHubDialog();
    } else {
        showToast?.('云端同步模块尚未就绪', 'warning');
    }
    return null;
}

function _captureCurrentTemplatePayload(name) {
    const thumbnail = _captureVisibleTemplateThumbnail();
    let projectData = {};
    try {
        if (typeof collectCurrentProjectState === 'function') {
            projectData = ReelsProject.collectProjectData(collectCurrentProjectState());
        } else if (typeof ReelsProject !== 'undefined') {
            projectData = ReelsProject.collectProjectData({
                tasks: window.reelsTasks || [],
                style: window.reelsGlobalStyle || {},
                exportOpts: window.reelsExportOpts || {},
                selectedIdx: window.reelsSelectedIdx || 0,
            });
        }
    } catch (e) {
        console.error('[Template] 工程序列化失败:', e);
        throw new Error('序列化工程失败: ' + e.message);
    }
    return { name, thumbnail, projectData };
}

function _makeUniqueTemplatePresetName(baseName, existingNames) {
    const occupied = existingNames instanceof Set ? existingNames : new Set(existingNames || []);
    if (!occupied.has(baseName)) return baseName;
    let index = 2;
    let candidate = `${baseName}（${index}）`;
    while (occupied.has(candidate)) candidate = `${baseName}（${++index}）`;
    return candidate;
}

function _syncTemplatePresetAssets(templateName, projectData, category = '模板同步') {
    const tasks = Array.isArray(projectData?.tasks) ? projectData.tasks : [];
    const result = { subtitle: false, overlay: false };
    const subtitleStyle = tasks.find(task => task?.subtitleStyle && Object.keys(task.subtitleStyle).length)?.subtitleStyle
        || projectData?.style || null;
    if (subtitleStyle && window.ReelsStyleEngine?.saveNamedSubtitlePreset) {
        const subtitleData = window.ReelsStyleEngine.loadSubtitlePresets?.() || {};
        const subtitleNames = new Set(Object.keys(subtitleData.presets || {}));
        const presetName = _makeUniqueTemplatePresetName(`${templateName} · 动态字幕`, subtitleNames);
        result.subtitle = window.ReelsStyleEngine.saveNamedSubtitlePreset(presetName, subtitleStyle, category);
    }
    const sourceLayers = tasks.find(task => Array.isArray(task?.overlays) && task.overlays.length)?.overlays;
    if (sourceLayers) {
        const layers = JSON.parse(JSON.stringify(sourceLayers)).map(layer => {
            delete layer._img; delete layer._imgLoaded; delete layer._allOverlays;
            if (!layer.fixed_text) {
                delete layer.title_text; delete layer.body_text; delete layer.footer_text;
                delete layer.scroll_title; delete layer.content;
            }
            return layer;
        });
        try {
            const key = 'reels_overlay_group_presets';
            const saved = JSON.parse(localStorage.getItem(key) || '{}');
            const layerTypes = [...new Set(layers.map(layer => ({ text: '纯文本', textcard: '文字卡片', scroll: '滚动字幕', image: '图片媒体', video: '视频媒体', solid_mask: '纯色蒙版' })[layer.type] || '其他覆层'))];
            const presetName = _makeUniqueTemplatePresetName(`${templateName} · 覆层`, new Set(Object.keys(saved)));
            saved[presetName] = { name: presetName, layers, updatedAt: new Date().toISOString(), meta: { layerCount: layers.length, category, layerTypes, needsBatchText: layers.some(layer => !layer.fixed_text && ['text', 'textcard', 'scroll'].includes(layer.type)) } };
            localStorage.setItem(key, JSON.stringify(saved));
            result.overlay = true;
        } catch (error) { console.warn('[Template] 同步覆层预设失败:', error); }
    }
    return result;
}

async function _ensureLibraryFolder(st, parentId, desiredName, existingFolders, options = {}) {
    const cleanParent = String(parentId || '').trim();
    const cleanBase = String(desiredName || '新建文件夹').trim().slice(0, 180) || '新建文件夹';
    const siblings = (existingFolders || []).filter(f => f && (f.parentId || '') === cleanParent);
    if (options.reuseExisting) {
        const hit = siblings.find(f => f.name === cleanBase);
        if (hit) return hit;
    }
    const existingNames = new Set(siblings.map(f => f.name));
    let candidateName = cleanBase;
    let suffix = 2;
    while (existingNames.has(candidateName)) {
        candidateName = `${cleanBase} (${suffix++})`;
    }
    const res = await _libFolderRequest(st, 'create', { name: candidateName, parentId: cleanParent });
    const created = res.folder || res;
    if (created && created.id && Array.isArray(existingFolders)) {
        existingFolders.push(created);
    }
    return created;
}

async function _reorderLibraryFolderTail(st, folderId, newlyOrderedCardIds = []) {
    if (!newlyOrderedCardIds.length) return;
    try {
        const [foldersRes, allItems] = await Promise.all([
            _libFolderRequest(st, 'list'),
            _libApiRequest(st, 'list'),
        ]);
        const foldersParsed = foldersRes || { folders: [], assignments: {}, folderOrders: {} };
        const list = Array.isArray(allItems) ? allItems : [];
        const cleanParent = String(folderId || '').trim();
        const childFolders = (foldersParsed.folders || []).filter(f => f && (f.parentId || '') === cleanParent);
        const directItems = list.filter(t => t && (foldersParsed.assignments?.[t.id] || '') === cleanParent);
        const prevOrder = foldersParsed.folderOrders?.[cleanParent] || (!cleanParent ? foldersParsed.libraryOrder : []) || [];
        const prevRank = new Map((Array.isArray(prevOrder) ? prevOrder : []).map((k, idx) => [k, idx]));
        const newRank = new Map(newlyOrderedCardIds.map((id, idx) => [String(id), idx]));

        const folderKeys = [...childFolders]
            .sort((a, b) => (prevRank.get('f:' + a.id) ?? Number.MAX_SAFE_INTEGER) - (prevRank.get('f:' + b.id) ?? Number.MAX_SAFE_INTEGER))
            .map(f => 'f:' + f.id);
        const existingCardKeys = directItems
            .filter(t => !newRank.has(String(t.id)))
            .sort((a, b) => (prevRank.get('t:' + a.id) ?? Number.MAX_SAFE_INTEGER) - (prevRank.get('t:' + b.id) ?? Number.MAX_SAFE_INTEGER))
            .map(t => 't:' + t.id);
        const newCardKeys = newlyOrderedCardIds
            .filter(id => directItems.some(t => String(t.id) === String(id)))
            .map(id => 't:' + id);
        const fullOrder = [...folderKeys, ...existingCardKeys, ...newCardKeys];
        if (fullOrder.length > 0) {
            await _libFolderRequest(st, 'reorder', { order: fullOrder, parentId: cleanParent });
        }
    } catch (err) {
        console.warn('[ProjectLibrary] 保留排序失败（不影响已保存数据）:', err);
    }
}

async function _archiveGroupsToLibrary(groups, options = {}) {
    const st = _getLibState('liveProject');
    const validGroups = (Array.isArray(groups) ? groups : []).filter(g => g && Array.isArray(g.tasks) && (g.tasks.length > 0 || options.allowEmpty));
    if (!validGroups.length) throw new Error('没有可保存的工程标签');

    window.reelsSyncWatermarkFromUI?.();
    const sharedStyle = options.style
        || (typeof _readStyleFromUI === 'function' ? _readStyleFromUI() : null)
        || window._reelsState?.globalSubtitleStyle
        || {};
    const sharedGlobalStyle = options.globalStyle || window._reelsState?.globalSubtitleStyle || sharedStyle;
    const sharedExportOpts = options.exportOpts || (() => {
        try { return _captureCurrentTemplatePayload('').projectData?.exportOpts || {}; } catch (_) { return {}; }
    })();
    const sharedWatermarks = Array.isArray(options.watermarks)
        ? options.watermarks
        : (Array.isArray(window._reelsState?.watermarks) ? window._reelsState.watermarks : []);
    const sharedBgLib = Array.isArray(options.backgroundLibrary)
        ? options.backgroundLibrary
        : (Array.isArray(window._reelsState?.backgroundLibrary) ? window._reelsState.backgroundLibrary : []);

    const [foldersRes, allItems] = await Promise.all([
        _libFolderRequest(st, 'list'),
        _libApiRequest(st, 'list'),
    ]);
    const foldersList = Array.isArray(foldersRes?.folders) ? [...foldersRes.folders] : [];
    const existingById = new Map((allItems || []).map(t => [String(t.id), t]));
    const assignments = foldersRes?.assignments || {};

    let rootFolderId = String(options.parentFolderId ?? (st.folderId || '')).trim();
    if (options.folderMode !== 'current-folder') {
        const createdRoot = await _ensureLibraryFolder(st, rootFolderId, options.folderName || '新建工程文件夹', foldersList, { reuseExisting: false });
        rootFolderId = String(createdRoot?.id || '').trim();
    }

    const folderMapByGroup = new Map();
    const hasGroups = options.splitByGroup !== false && validGroups.some(g => String(g.group || '').trim());
    if (hasGroups) {
        for (const g of validGroups) {
            const gName = String(g.group || '').trim();
            if (!gName || folderMapByGroup.has(gName)) continue;
            const sub = await _ensureLibraryFolder(st, rootFolderId, gName, foldersList, { reuseExisting: true });
            if (sub?.id) folderMapByGroup.set(gName, sub.id);
        }
    }

    const activeSelectedTask = window._reelsState?.tasks?.[window._reelsState?.selectedIdx];
    const activeTabId = typeof _batchTableState !== 'undefined' ? _batchTableState.activeTabId : '';
    const usedNamesPerFolder = new Map();
    const getUsedSet = (fId) => {
        const key = String(fId || '');
        if (!usedNamesPerFolder.has(key)) {
            const existingNames = (allItems || [])
                .filter(t => String(assignments[t.id] || '') === key)
                .map(t => t.name);
            usedNamesPerFolder.set(key, new Set(existingNames));
        }
        return usedNamesPerFolder.get(key);
    };

    const savedResults = [];
    const savedIdsByFolder = new Map();
    const failed = [];
    let syncedSubtitle = 0;
    let syncedOverlay = 0;

    for (let i = 0; i < validGroups.length; i++) {
        const group = validGroups[i];
        const targetFolderId = (hasGroups && group.group && folderMapByGroup.get(group.group))
            ? folderMapByGroup.get(group.group)
            : rootFolderId;

        const existingLibId = group.libraryTemplateId && existingById.has(group.libraryTemplateId)
            ? group.libraryTemplateId
            : '';
        const existingInSameFolder = existingLibId && String(assignments[existingLibId] || '') === String(targetFolderId || '');

        const rawName = String(group.name || `标签${i + 1}`).trim() || `标签${i + 1}`;
        let finalName = rawName;
        if (!existingInSameFolder) {
            const usedSet = getUsedSet(targetFolderId);
            if (usedSet.has(finalName)) {
                let n = 2;
                while (usedSet.has(`${rawName} (${n})`)) n++;
                finalName = `${rawName} (${n})`;
            }
            usedSet.add(finalName);
        }

        if (typeof options.onProgress === 'function') {
            options.onProgress(i + 1, validGroups.length, finalName);
        }

        let thumb = String(group.thumbnail || (existingLibId ? window._reelsLibraryThumbCache?.[existingLibId] : '') || '').trim();
        if (!thumb && activeSelectedTask && ((group.tabId && activeTabId === group.tabId) || group.tasks.some(t => t?.id && t.id === activeSelectedTask.id))) {
            thumb = _captureVisibleTemplateThumbnail() || '';
        }
        if (!thumb && options.captureThumbnails !== false) {
            thumb = await _captureTemplateThumbnailForTasks(group.tasks, '');
        }

        const groupTabObj = group.tabId && typeof _batchTableState !== 'undefined' && Array.isArray(_batchTableState?.tabs)
            ? (_batchTableState.tabs.find(t => t && t.id === group.tabId) || null)
            : null;
        const groupWatermarks = Array.isArray(options.watermarks)
            ? options.watermarks
            : (Array.isArray(groupTabObj?.watermarks)
                ? groupTabObj.watermarks
                : (typeof window._resolveReelsWatermarksForTask === 'function'
                    ? window._resolveReelsWatermarksForTask(group.tasks?.[0], groupTabObj)
                    : sharedWatermarks));
        const projectData = ReelsProject.collectProjectData({
            tasks: group.tasks,
            backgroundLibrary: sharedBgLib,
            style: sharedGlobalStyle,
            exportOpts: sharedExportOpts,
            watermarks: groupWatermarks,
            selectedIdx: group.tasks.length ? 0 : -1,
        });

        try {
            const res = await _libApiRequest(st, 'save', {
                ...(existingInSameFolder ? { id: existingLibId } : {}),
                name: finalName,
                description: group.group ? `分组：${group.group}` : '',
                folderId: targetFolderId,
                thumbnail: thumb,
                projectData,
            });
            const savedId = res.id || (existingInSameFolder ? existingLibId : '');
            if (options.syncPresetAssets) {
                const synced = _syncTemplatePresetAssets(finalName, projectData);
                if (synced.subtitle) syncedSubtitle++;
                if (synced.overlay) syncedOverlay++;
            }
            savedResults.push({
                ...group,
                name: finalName,
                libraryTemplateId: savedId,
                libraryFolderId: targetFolderId,
                thumbnail: thumb,
                updatedAt: new Date().toISOString(),
            });
            if (savedId) {
                if (!savedIdsByFolder.has(targetFolderId)) savedIdsByFolder.set(targetFolderId, []);
                savedIdsByFolder.get(targetFolderId).push(savedId);
            }
        } catch (err) {
            failed.push(`${finalName}: ${err.message}`);
        }
    }

    if (!savedResults.length) {
        throw new Error(failed.join('；') || '所有标签保存失败');
    }

    for (const [fId, cardIds] of savedIdsByFolder.entries()) {
        await _reorderLibraryFolderTail(st, fId, cardIds);
    }

    const folderPaths = {};
    const folderCounts = {};
    const updatedFoldersRes = await _libFolderRequest(st, 'list');
    const latestFolders = updatedFoldersRes?.folders || foldersList;
    const latestAssign = updatedFoldersRes?.assignments || {};
    const touchedFolderIds = new Set([rootFolderId, ...savedResults.map(r => r.libraryFolderId)]);
    for (const fId of touchedFolderIds) {
        folderPaths[fId] = _buildTemplateFolderPathText(fId, latestFolders, st.cfg.homeLabel);
        folderCounts[fId] = Object.values(latestAssign).filter(v => String(v || '') === String(fId || '')).length;
    }

    if (options.bindWorkspace && typeof window.reelsBindSavedGroupsToWorkspace === 'function') {
        window.reelsBindSavedGroupsToWorkspace(savedResults, {
            rootFolderId,
            rootFolderPath: folderPaths[rootFolderId] || st.cfg.homeLabel,
            rootFolderDirectCount: folderCounts[rootFolderId] || savedResults.length,
            folderPaths,
            folderCounts,
        });
    }

    return {
        rootFolderId,
        rootFolderPath: folderPaths[rootFolderId] || st.cfg.homeLabel,
        savedResults,
        failed,
        syncedSubtitle,
        syncedOverlay,
        folderCountCreated: folderMapByGroup.size + (options.folderMode !== 'current-folder' ? 1 : 0),
    };
}

async function reelsAutoArchiveWorkspaceToLibrary(options = {}) {
    const st = _getLibState('liveProject');
    if (st.archivingInProgress) return false;
    const groups = typeof window.reelsCollectWorkspaceProjectGroups === 'function'
        ? window.reelsCollectWorkspaceProjectGroups()
        : [];
    if (!groups.length) {
        showToast?.('当前工作区没有可收录的非空任务标签', 'info');
        return false;
    }

    st.archivingInProgress = true;
    try {
        const res = await _archiveGroupsToLibrary(groups, {
            folderMode: options.folderMode || 'new-folder',
            folderName: options.folderName || `工作区工程_${new Date().toISOString().slice(0, 10)}`,
            parentFolderId: options.parentFolderId ?? (st.folderId || ''),
            splitByGroup: options.splitByGroup !== false,
            captureThumbnails: options.captureThumbnails !== false,
            bindWorkspace: options.bindWorkspace !== false,
            syncPresetAssets: !!options.syncPresetAssets,
        });
        st.folderId = res.rootFolderId;
        window.reelsOnLibraryFolderChanged?.([res.rootFolderId].filter(Boolean), { skipWorkspaceSync: true });
        await _refreshLibraryView(st);
        showToast?.(
            `✅ 已收录 ${res.savedResults.length} 个实时工程到「${res.rootFolderPath}」${res.failed.length ? `（${res.failed.length} 个失败）` : ''}`,
            res.failed.length ? 'warning' : 'success',
            5000
        );
        return true;
    } catch (err) {
        showToast?.(`收录失败：${err.message}`, 'error');
        return false;
    } finally {
        st.archivingInProgress = false;
    }
}
window.reelsAutoArchiveWorkspaceToLibrary = reelsAutoArchiveWorkspaceToLibrary;

// 封存模式保存当前工程为模板（完全还原早期“保存当前工程为模板”体验：绝不绑定或自动覆盖！）
async function saveCurrentAsTemplate() {
    const st = _getLibState('template');
    const saveFolderId = st.folderId || (_currentTemplateContext.id ? (await _libFolderRequest(st, 'list')).assignments?.[_currentTemplateContext.id] || '' : '');
    const defaultName = `模板_${new Date().toLocaleDateString('zh-CN')}`;
    const name = await (typeof _showInputDialog === 'function'
        ? _showInputDialog('保存当前工程为封存模板', '输入模板名称', defaultName)
        : Promise.resolve(prompt('请输入模板名称：', defaultName)));
    if (!name || !name.trim()) return;
    const syncPresetAssets = typeof confirm === 'function'
        ? confirm('是否同时同步保存独立预设？\n\n“确定”：把模板内的动态字幕样式和覆层分别保存为同名独立预设。\n“取消”：仅封存保存模板工程。')
        : false;

    try {
        const baseName = name.trim();
        const basePayload = _captureCurrentTemplatePayload(baseName);

        let groups = [];
        if (typeof _batchTableState !== 'undefined' && Array.isArray(_batchTableState.tabs)) {
            if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
            const visibleGroups = new Map();
            const visibleTasks = window._reelsState?.tasks || [];
            visibleTasks.forEach(task => {
                let id = 'legacy';
                let gName = '已有任务';
                if (task._batchTabId) {
                    id = `tab:${task._batchTabId}`;
                    gName = task._batchTabName || '未命名分组';
                } else if (task._folderQueueId) {
                    id = `folder:${task._folderQueueId}`;
                    gName = task._folderQueueName || '文件夹队列';
                }
                if (!visibleGroups.has(id)) visibleGroups.set(id, { id, name: gName, tasks: [] });
                visibleGroups.get(id).tasks.push(task);
            });
            if (visibleGroups.size > 1) {
                groups = Array.from(visibleGroups.values());
            } else {
                groups = _batchTableState.tabs
                    .filter(tab => Array.isArray(tab.tasks) && tab.tasks.length > 0)
                    .map(tab => ({ id: tab.id, name: tab.name, tasks: tab.tasks }));
            }
        }

        if (groups.length > 1) {
            let saved = 0, syncedSubtitle = 0, syncedOverlay = 0;
            const failed = [];
            const usedNames = new Map();
            for (let index = 0; index < groups.length; index++) {
                const group = groups[index];
                const rawGroupName = String(group.name || `分组${index + 1}`).trim() || `分组${index + 1}`;
                const seenCount = (usedNames.get(rawGroupName) || 0) + 1;
                usedNames.set(rawGroupName, seenCount);
                const groupName = seenCount > 1 ? `${rawGroupName}_${seenCount}` : rawGroupName;
                const queueIdentity = group.id || _templateQueueIdentityFromTasks(group.tasks) || `group:${index}`;
                const queueShortId = _templateQueueShortId(queueIdentity);
                const templateName = `${baseName}_${groupName} [Q-${queueShortId}]`;
                const stableTemplateId = `tpl_queue_${_templateQueueShortId(`${baseName}|${queueIdentity}`)}`;
                const projectData = ReelsProject.collectProjectData({
                    tasks: group.tasks,
                    backgroundLibrary: basePayload.projectData.backgroundLibrary || [],
                    style: basePayload.projectData.style || {},
                    exportOpts: basePayload.projectData.exportOpts || {},
                    watermarks: basePayload.projectData.watermarks || [],
                    selectedIdx: group.tasks.length ? 0 : -1,
                });
                try {
                    const groupThumbnail = await _captureTemplateThumbnailForTasks(group.tasks, basePayload.thumbnail);
                    await _libApiRequest(st, 'save', {
                        id: stableTemplateId,
                        name: templateName,
                        folderId: saveFolderId,
                        thumbnail: groupThumbnail,
                        projectData,
                    });
                    if (syncPresetAssets) {
                        const synced = _syncTemplatePresetAssets(templateName, projectData);
                        if (synced.subtitle) syncedSubtitle++;
                        if (synced.overlay) syncedOverlay++;
                    }
                    saved++;
                } catch (err) {
                    failed.push(`${templateName}: ${err.message}`);
                }
            }
            if (saved === 0) throw new Error(failed.join('；') || '保存模板失败');
            _refreshLibraryView(st);
            showToast?.(`🔒 已封存保存 ${saved} 个模板${syncPresetAssets ? `（预设：字幕 ${syncedSubtitle}、覆层 ${syncedOverlay}）` : ''}${failed.length ? `，${failed.length} 个失败` : ''}`, failed.length ? 'warning' : 'success', 4500);
            return;
        }

        const res = await _libApiRequest(st, 'save', {
            name: baseName,
            folderId: saveFolderId,
            thumbnail: basePayload.thumbnail,
            projectData: basePayload.projectData,
        });
        if (syncPresetAssets) _syncTemplatePresetAssets(baseName, basePayload.projectData);
        if (res?.id) _setCurrentTemplateContext(res.id, baseName);
        showToast?.(`🔒 模板「${baseName}」已封存保存 ✅（工作区后续修改不会自动覆盖它）`, 'success', 4000);
        _refreshLibraryView(st);
    } catch (e) {
        showToast?.('保存模板失败: ' + e.message, 'error');
    }
}

async function updateCurrentTemplate() {
    const st = _getLibState('template');
    if (!_currentTemplateContext.id) {
        showToast?.('请先从「📂 模板库」载入过某个模板，再手动点更新覆盖它', 'warning');
        return;
    }
    const name = _currentTemplateContext.name || _currentTemplateContext.id;
    if (!confirm(`确定用当前工作区覆盖更新封存模板「${name}」？`)) return;
    try {
        const payload = _captureCurrentTemplatePayload(name);
        await _libApiRequest(st, 'save', { ...payload, id: _currentTemplateContext.id });
        showToast?.(`♻️ 封存模板「${name}」已更新 ✅`, 'success');
        _refreshLibraryView(st);
    } catch (e) {
        showToast?.('更新模板失败: ' + e.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════
// 3. 载入封存模板（独立副本，不改原模板）/ 独立窗口
// ═══════════════════════════════════════════════════════

async function _openTemplateInWindow(templateId, templateName) {
    if (window.electronAPI?.openTemplateWindow) {
        try {
            const result = await window.electronAPI.openTemplateWindow(templateId, templateName);
            if (result?.reused) showToast?.(`模板「${templateName}」窗口已聚焦`, 'info');
        } catch (e) {
            console.error('[Template] 打开窗口失败:', e);
            _loadTemplateInCurrentWindow(templateId);
        }
    } else {
        _loadTemplateInCurrentWindow(templateId);
    }
}

async function _loadTemplateInCurrentWindow(templateId, options = {}) {
    const st = _getLibState('template');
    try {
        const tplData = await _libApiRequest(st, 'get', { id: templateId });
        if (!tplData || !tplData.projectData) throw new Error('模板缺少工程数据');

        if (typeof window.reelsApplySealedTemplate === 'function' && !window.location?.hash?.startsWith('#template=')) {
            const ok = await window.reelsApplySealedTemplate(tplData, {
                loadMode: options.append ? 'append' : 'replace',
                confirmSwitch: options.confirmSwitch !== false,
            });
            if (!ok) return;
            _setCurrentTemplateContext(tplData.id || templateId, tplData.name || '');
            const modal = document.getElementById(st.cfg.modalId);
            if (modal) modal.style.display = 'none';
            if (typeof openPanelByName === 'function') openPanelByName('batch-reels');
            showToast?.(`🔒 已载入模板「${tplData.name}」副本到工作区（修改副本不会影响原模板）`, 'success', 4000);
            return;
        }

        if (typeof ReelsProject !== 'undefined') {
            const restored = ReelsProject.applyProjectData(tplData.projectData);
            if (typeof _batchTableState !== 'undefined') {
                const tabId = 'tab_template_' + Date.now();
                _batchTableState.tabs = [{ id: tabId, name: tplData.name || '模板', _fromSealedTemplate: true, tasks: [], materialDir: '' }];
                _batchTableState.activeTabId = tabId;
                _batchTableState.appliedTabIds = [tabId];
                _batchTableState.openSnapshotTasks = null;
                _batchTableState.selectedRows = new Set();
                for (const task of restored.tasks) {
                    task._batchTabId = tabId;
                    task._batchTabName = tplData.name || '模板';
                }
            }
            if (window._reelsState) {
                _reelsState.batchGroupCollapsed = { '__reels_existing_tasks__': false };
                _reelsState.folderQueueCollapsed = {};
                for (const task of restored.tasks) {
                    if (task._batchTabId) _reelsState.batchGroupCollapsed[task._batchTabId] = false;
                    if (task._folderQueueId) _reelsState.folderQueueCollapsed[task._folderQueueId] = false;
                }
            }
            if (restored.exportOpts?.subtitleStyleScopeVersion !== 2) {
                restored.exportOpts = { ...restored.exportOpts, subtitleStyleScopeVersion: 2, subtitleStyleScope: 'task', subtitleStyleApplyAll: false };
            }
            if (typeof applyRestoredProject === 'function') applyRestoredProject(restored);
            _setCurrentTemplateContext(tplData.id || templateId, tplData.name || '');
            showToast?.(`模板「${tplData.name}」已加载`, 'success');
            const modal = document.getElementById(st.cfg.modalId);
            if (modal) modal.style.display = 'none';
            if (typeof openPanelByName === 'function') openPanelByName('batch-reels');
        }
    } catch (e) {
        showToast?.('加载模板失败: ' + e.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════
// 4. 删除 / 重命名 / 导入导出
// ═══════════════════════════════════════════════════════

async function _deleteLibraryItem(st, id, name) {
    if (!confirm(`确定彻底删除${st.cfg.itemNoun}「${name}」？此操作不可恢复。`)) return;
    const prevFolder = st.folderData?.assignments?.[id] || st.folderId || '';
    try {
        await _libApiRequest(st, 'delete', { id });
        if (st.mode === 'template' && _currentTemplateContext.id === id) {
            _setCurrentTemplateContext('', '');
        }
        showToast?.(`${st.cfg.itemNoun}「${name}」已删除`, 'success');
        if (st.mode === 'liveProject') {
            window.reelsOnLibraryFolderChanged?.(prevFolder ? [prevFolder] : []);
        }
        _refreshLibraryView(st);
    } catch (e) {
        showToast?.('删除失败: ' + e.message, 'error');
    }
}

async function _renameLibraryItem(st, id) {
    const modal = document.getElementById(st.cfg.modalId);
    const card = Array.from(modal?.querySelectorAll('.tpl-card') || []).find(c => c.dataset.id === id);
    const title = card?.querySelector('.tpl-name');
    if (!title) return;
    _editNameInPlace(title, async name => {
        await _libApiRequest(st, 'rename', { id, name });
        if (st.mode === 'template' && _currentTemplateContext.id === id) _setCurrentTemplateContext(id, name);
        _updateRenamedCard(st, st.mode === 'template' ? 'template' : 'project', id, name);
        if (st.mode === 'liveProject') {
            const fId = st.folderData?.assignments?.[id] || st.folderId || '';
            window.reelsOnLibraryFolderChanged?.(fId ? [fId] : []);
        }
    });
}

async function _exportLibraryItem(st, id, name) {
    try {
        const tplData = await _libApiRequest(st, 'get', { id });
        const exportObj = {
            _format: 'videokit-template',
            _version: 1,
            name: tplData.name,
            description: tplData.description || '',
            thumbnail: tplData.thumbnail || '',
            tags: tplData.tags || [],
            createdAt: tplData.createdAt,
            projectData: tplData.projectData,
        };
        const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name || 'project'}.vktpl`;
        a.click();
        URL.revokeObjectURL(url);
        showToast?.(`「${name}」已导出`, 'success');
    } catch (e) {
        showToast?.('导出失败: ' + e.message, 'error');
    }
}

async function _exportArchiveLibraryItem(st, id) {
    try {
        showToast?.('正在收集素材并打包，请稍候...', 'info');
        const result = await _libApiRequest(st, 'export-archive', { id });
        const zipPath = result?.zip_path;
        if (zipPath && window.electronAPI?.showItemInFolder) {
            window.electronAPI.showItemInFolder(zipPath);
            showToast?.('打包完成！已在文件夹中显示。', 'success');
        } else if (zipPath) {
            showToast?.(`打包完成: ${zipPath}`, 'success');
        } else {
            throw new Error('打包失败');
        }
    } catch (e) {
        showToast?.('打包失败: ' + e.message, 'error');
    }
}

function _extractTabsFromProjectPayload(data, fallbackName = '导入工程') {
    if (!data || typeof data !== 'object') return null;
    if (data._format === 'videokit-template-collection' && Array.isArray(data.templates)) {
        const items = data.templates.filter(t => t && t.projectData);
        return items.length ? { mode: 'collection', items } : null;
    }
    const inner = (data.projectData && typeof data.projectData === 'object') ? data.projectData : data;
    const sharedStyle = inner.style || data.style || inner.uiState?.globalSubtitleStyle || data.uiState?.globalSubtitleStyle || {};
    const sharedExportOpts = inner.exportOpts || data.exportOpts || {};
    const sharedWatermarks = Array.isArray(inner.watermarks) ? inner.watermarks : (Array.isArray(data.watermarks) ? data.watermarks : []);
    const sharedBgLib = Array.isArray(inner.backgroundLibrary) ? inner.backgroundLibrary : (Array.isArray(data.backgroundLibrary) ? data.backgroundLibrary : []);

    const splitTasksHelper = typeof window.reelsSplitTasksIntoTabs === 'function'
        ? window.reelsSplitTasksIntoTabs
        : (rawTasks, fb) => {
            const groups = new Map();
            let grouped = false;
            for (const raw of (Array.isArray(rawTasks) ? rawTasks : [])) {
                if (!raw || typeof raw !== 'object') continue;
                const qId = String(raw._folderQueueId || '').trim();
                const qName = String(raw._folderQueueName || '').trim();
                const tId = String(raw._batchTabId || '').trim();
                const tName = String(raw._batchTabName || '').trim();
                const tGroup = String(raw._batchTabGroup || '').trim();
                const key = qId ? `q:${qId}` : (tId ? `t:${tId}` : '__default__');
                const name = qName || tName || fb;
                if (qId || tId || qName || tName) grouped = true;
                if (!groups.has(key)) groups.set(key, { name, group: tGroup, queueId: qId, tasks: [] });
                groups.get(key).tasks.push(raw);
            }
            const tabs = [...groups.values()];
            return { tabs: tabs.length ? tabs : [{ name: fb, group: '', queueId: '', tasks: rawTasks || [] }], grouped: grouped && tabs.length > 1 };
        };

    if (Array.isArray(inner.tabs) && inner.tabs.length > 0 && typeof ReelsProject !== 'undefined') {
        const nonEmptyTabs = inner.tabs.filter(tab => tab && Array.isArray(tab.tasks) && tab.tasks.length > 0);
        if (nonEmptyTabs.length > 0) {
            if (nonEmptyTabs.length === 1 && data.projectData) {
                const only = nonEmptyTabs[0];
                return {
                    mode: 'single',
                    style: sharedStyle, exportOpts: sharedExportOpts, watermarks: sharedWatermarks, backgroundLibrary: sharedBgLib,
                    items: [{
                        name: data.name || only.name || fallbackName,
                        description: data.description || (only.group ? `分组：${only.group}` : ''),
                        thumbnail: data.thumbnail || only.thumbnail || '',
                        tags: data.tags || [],
                        projectData: ReelsProject.collectProjectData({
                            tasks: only.tasks, backgroundLibrary: sharedBgLib, style: sharedStyle, exportOpts: sharedExportOpts, watermarks: sharedWatermarks, selectedIdx: 0,
                        }),
                    }],
                };
            }
            return {
                mode: nonEmptyTabs.length > 1 ? 'multi-tab' : 'single',
                style: sharedStyle, exportOpts: sharedExportOpts, watermarks: sharedWatermarks, backgroundLibrary: sharedBgLib,
                items: nonEmptyTabs.map((tab, idx) => ({
                    key: `import_tab_${idx}`,
                    name: String(tab.name || `${fallbackName}_${idx + 1}`).trim(),
                    group: String(tab.group || '').trim(),
                    thumbnail: tab.thumbnail || (nonEmptyTabs.length === 1 ? (data.thumbnail || '') : ''),
                    description: tab.group ? `分组：${tab.group}` : '',
                    tasks: tab.tasks,
                })),
            };
        }
    }

    if (Array.isArray(inner.tasks) && inner.tasks.length > 0) {
        const split = splitTasksHelper(inner.tasks, fallbackName);
        if (split.grouped && split.tabs.length > 1) {
            return {
                mode: 'multi-tab',
                style: sharedStyle, exportOpts: sharedExportOpts, watermarks: sharedWatermarks, backgroundLibrary: sharedBgLib,
                items: split.tabs.map((tab, idx) => ({
                    key: `import_split_${idx}`,
                    name: String(tab.name || `${fallbackName}_${idx + 1}`).trim(),
                    group: String(tab.group || '').trim(),
                    thumbnail: '',
                    description: tab.group ? `分组：${tab.group}` : '',
                    tasks: tab.tasks,
                })),
            };
        }
        if (data.projectData) {
            return { mode: 'single', style: sharedStyle, exportOpts: sharedExportOpts, watermarks: sharedWatermarks, backgroundLibrary: sharedBgLib, items: [data] };
        }
        if (typeof ReelsProject !== 'undefined') {
            return {
                mode: 'single',
                style: sharedStyle, exportOpts: sharedExportOpts, watermarks: sharedWatermarks, backgroundLibrary: sharedBgLib,
                items: [{
                    name: data.name || (split.grouped ? split.tabs[0]?.name : fallbackName) || fallbackName,
                    description: data.description || '',
                    thumbnail: data.thumbnail || '',
                    tags: data.tags || [],
                    projectData: ReelsProject.collectProjectData({
                        tasks: inner.tasks, backgroundLibrary: sharedBgLib, style: sharedStyle, exportOpts: sharedExportOpts, watermarks: sharedWatermarks, selectedIdx: 0,
                    }),
                }],
            };
        }
    }
    if (data.projectData) return { mode: 'single', items: [data] };
    return null;
}
window.reelsExtractTabsFromProjectPayload = _extractTabsFromProjectPayload;

async function _importLibraryFiles(st) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vktpl,.json,.vkpkg';
    input.multiple = true;
    input.onchange = async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        let imported = 0;
        for (const file of files) {
            if (file.name.endsWith('.vkpkg')) {
                const filePath = window.electronAPI ? window.electronAPI.getFilePath(file) : '';
                if (!filePath) {
                    showToast?.(`跳过 ${file.name}: 无法获取本地路径`, 'warning');
                    continue;
                }
                try {
                    showToast?.(`正在导入归档包 ${file.name}...`, 'info');
                    const result = await _libApiRequest(st, 'import-archive', { zip_path: filePath, folderId: st.folderId || '' });
                    if (result?.id) imported++;
                } catch (err) {
                    showToast?.(`导入失败 ${file.name}: ` + err.message, 'error');
                }
                continue;
            }
            try {
                const data = JSON.parse(await file.text());
                const fileBaseName = file.name.replace(/\.(vktpl|json)$/i, '').trim() || `导入${st.cfg.itemNoun}`;
                const extracted = _extractTabsFromProjectPayload(data, fileBaseName);
                if (!extracted || !extracted.items.length) {
                    showToast?.(`跳过 ${file.name}: 不是有效工程/模板文件`, 'warning');
                    continue;
                }
                if (st.mode === 'liveProject' && extracted.mode === 'multi-tab' && extracted.items.length > 1) {
                    const res = await _archiveGroupsToLibrary(extracted.items, {
                        folderMode: 'new-folder', folderName: fileBaseName, parentFolderId: st.folderId || '',
                        splitByGroup: true, bindWorkspace: false, captureThumbnails: true, syncPresetAssets: false,
                        style: extracted.style, exportOpts: extracted.exportOpts, watermarks: extracted.watermarks, backgroundLibrary: extracted.backgroundLibrary,
                    });
                    imported += res.savedResults.length;
                    st.folderId = res.rootFolderId;
                } else {
                    for (const tpl of extracted.items) {
                        const pData = tpl.projectData || ReelsProject.collectProjectData({
                            tasks: tpl.tasks || [], backgroundLibrary: extracted.backgroundLibrary || [], style: extracted.style || {}, exportOpts: extracted.exportOpts || {}, watermarks: extracted.watermarks || [], selectedIdx: 0,
                        });
                        const autoThumb = tpl.thumbnail || (pData?.tasks?.length ? await _captureProjectThumbnailOffscreen(pData, '') : '');
                        const res = await _libApiRequest(st, 'save', {
                            name: tpl.name || fileBaseName,
                            description: tpl.description || '',
                            thumbnail: autoThumb || '',
                            tags: tpl.tags || [],
                            folderId: st.folderId || '',
                            projectData: pData,
                        });
                        if (res?.success || res?.id) imported++;
                    }
                }
            } catch (err) {
                showToast?.(`导入 ${file.name} 失败: ` + err.message, 'error');
            }
        }
        if (imported > 0) {
            if (st.mode === 'liveProject') window.reelsOnLibraryFolderChanged?.(st.folderId ? [st.folderId] : []);
            showToast?.(`成功导入 ${imported} 个${st.cfg.itemNoun} ✅`, 'success');
            _refreshLibraryView(st);
        }
    };
    input.click();
}

async function _exportAllTemplates() {
    const st = _getLibState('template');
    try {
        showToast?.('正在准备导出，请稍候...', 'info');
        const templatesList = await _libApiRequest(st, 'list') || [];
        if (!templatesList.length) { showToast?.('没有可导出的模板', 'warning'); return; }
        const fullTemplates = [];
        for (const tpl of templatesList) {
            const tplData = await _libApiRequest(st, 'get', { id: tpl.id });
            fullTemplates.push({
                name: tplData.name, description: tplData.description || '', thumbnail: tplData.thumbnail || '',
                tags: tplData.tags || [], createdAt: tplData.createdAt, projectData: tplData.projectData,
            });
        }
        const exportObj = { _format: 'videokit-template-collection', _version: 1, exportedAt: Date.now(), count: fullTemplates.length, templates: fullTemplates };
        const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `所有模板_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_(${fullTemplates.length}个).vktpl`;
        a.click();
        URL.revokeObjectURL(url);
        showToast?.(`成功导出 ${fullTemplates.length} 个模板`, 'success');
    } catch (e) {
        showToast?.('全部导出失败: ' + e.message, 'error');
    }
}

function _checkHashForTemplate() {
    const match = window.location.hash.match(/template=([^&]+)/);
    if (!match) return;
    const templateId = match[1];
    const tryLoad = () => {
        if (typeof ReelsProject === 'undefined' || typeof apiFetch === 'undefined') {
            setTimeout(tryLoad, 200);
            return;
        }
        _loadTemplateInCurrentWindow(templateId);
    };
    setTimeout(tryLoad, 500);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _checkHashForTemplate);
else _checkHashForTemplate();

// ═══════════════════════════════════════════════════════
// 5. 文件夹导航、排序、拖拽与框选（通用复用）
// ═══════════════════════════════════════════════════════

function _libItemKey(card) {
    return card.classList.contains('tpl-folder-card') ? 'f:' + card.dataset.folderId : 't:' + card.dataset.id;
}

function _initLibraryReordering(st, modal, container) {
    const grid = container.querySelector(`.${st.cfg.prefix}-card-grid`);
    if (!grid) return;
    let dragged = null, original = [], moving = [], movingSet = new Set(), kind = '', saving = false;
    const cards = () => Array.from(grid.children).filter(c => c.matches('.tpl-card,.tpl-folder-card'));
    const restore = () => original.forEach(card => grid.appendChild(card));
    const resetOpacity = () => cards().forEach(card => card.style.opacity = '');
    grid.addEventListener('dragstart', event => {
        const card = event.target.closest('.tpl-card,.tpl-folder-card');
        if (!card || saving || event.target.closest('button,input,label,[contenteditable]')) { event.preventDefault(); return; }
        dragged = card; original = cards(); kind = card.classList.contains('tpl-folder-card') ? 'folder' : 'item';
        event.dataTransfer.effectAllowed = 'move';
        if (kind === 'folder') {
            moving = [card];
            event.dataTransfer.setData('application/x-videokit-folder', card.dataset.folderId);
        } else {
            if (!modal._selectedItemIds.has(card.dataset.id)) {
                modal._selectedItemIds = new Set([card.dataset.id]);
                _paintLibrarySelection(st);
            }
            moving = original.filter(c => c.classList.contains('tpl-card') && modal._selectedItemIds.has(c.dataset.id));
            event.dataTransfer.setData('application/x-videokit-items', JSON.stringify(moving.map(c => c.dataset.id)));
            event.dataTransfer.setData('text/plain', card.dataset.id);
        }
        movingSet = new Set(moving);
        for (const c of moving) c.style.opacity = '.45';
    });
    grid.addEventListener('dragover', event => {
        if (!dragged) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const target = event.target.closest('.tpl-card,.tpl-folder-card');
        if (kind === 'item' && target?.classList.contains('tpl-folder-card')) return;
        if (target && !movingSet.has(target)) {
            const box = target.getBoundingClientRect();
            const after = event.clientY > box.bottom || (event.clientY >= box.top && event.clientX > box.left + box.width / 2);
            let ref = after ? target.nextSibling : target;
            while (ref && movingSet.has(ref)) ref = ref.nextSibling;
            for (const c of moving) grid.insertBefore(c, ref);
        } else if (!target && event.target === grid) {
            const box = grid.lastElementChild?.getBoundingClientRect();
            if (box && (event.clientY > box.bottom || (event.clientY >= box.top && event.clientX > box.right))) {
                for (const c of moving) grid.appendChild(c);
            }
        }
        const bounds = container.getBoundingClientRect();
        if (event.clientY < bounds.top + 60) container.scrollTop -= 24;
        if (event.clientY > bounds.bottom - 60) container.scrollTop += 24;
    });
    grid.addEventListener('drop', async event => {
        if (!dragged) return;
        event.preventDefault();
        event.stopPropagation();
        const folderTarget = event.target.closest('.tpl-folder-card');
        if (kind === 'item' && folderTarget) {
            const ids = moving.map(c => c.dataset.id);
            resetOpacity(); restore(); dragged = null;
            await _moveLibraryItemIds(st, ids, folderTarget.dataset.folderId);
            return;
        }
        resetOpacity(); dragged = null;
        const current = cards();
        if (current.every((c, i) => c === original[i])) return;
        saving = true;
        try {
            const order = current.map(_libItemKey);
            await _libFolderRequest(st, 'reorder', { order, parentId: st.folderId });
            if (!st.folderData.folderOrders || typeof st.folderData.folderOrders !== 'object') st.folderData.folderOrders = {};
            st.folderData.folderOrders[st.folderId || ''] = order;
            if (!st.folderId) st.folderData.libraryOrder = order;
            localStorage.setItem(st.cfg.sortKey, 'manual');
            _syncSortControls(st, modal);
            if (st.mode === 'liveProject') window.reelsOnLibraryFolderChanged?.(st.folderId ? [st.folderId] : []);
        } catch (error) {
            restore();
            showToast?.(error.message, 'error');
        } finally {
            saving = false;
        }
    });
    grid.addEventListener('dragend', () => { if (dragged) { resetOpacity(); restore(); dragged = null; } });
}

function _sortLibraryItems(st, items) {
    const mode = localStorage.getItem(st.cfg.sortKey) || 'manual';
    if (mode === 'manual') return [...items];
    const dir = localStorage.getItem(st.cfg.sortDirKey) === 'desc' ? -1 : 1;
    const compare = (a, b) => String(a || '').localeCompare(String(b || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
    return [...items].sort((a, b) => dir * (
        mode === 'name' ? compare(a.name, b.name) :
        mode === 'type' ? compare(a.templateType, b.templateType) :
        mode === 'size' ? (Number(a.sizeBytes) || 0) - (Number(b.sizeBytes) || 0) :
        (Date.parse(a.updatedAt || a.createdAt) || 0) - (Date.parse(b.updatedAt || b.createdAt) || 0)
    ));
}

function _syncSortControls(st, modal) {
    const mode = localStorage.getItem(st.cfg.sortKey) || 'manual';
    const select = modal.querySelector('[data-role="sort-select"]');
    if (select) select.value = mode;
    const button = modal.querySelector('[data-role="sort-dir"]');
    if (button) {
        button.disabled = mode === 'manual';
        button.style.opacity = mode === 'manual' ? '0.4' : '1';
        button.textContent = localStorage.getItem(st.cfg.sortDirKey) === 'desc' ? '降序 ↓' : '升序 ↑';
    }
}

function _getParentFolder(st, folderId) {
    return (st.folderData.folders || []).find(item => item.id === folderId)?.parentId || '';
}

async function _newLibraryFolder(st, parentOverride) {
    const parentId = typeof parentOverride === 'string' ? parentOverride : st.folderId;
    const parentLabel = parentId ? `（位于「${_buildTemplateFolderPathText(parentId, st.folderData.folders, st.cfg.homeLabel)}」）` : `（位于${st.cfg.homeLabel}）`;
    const name = typeof _showInputDialog === 'function'
        ? await _showInputDialog(`新建文件夹 ${parentLabel}`, '输入文件夹名称', '新建文件夹')
        : prompt(`文件夹名称 ${parentLabel}`, '新建文件夹');
    if (!name?.trim()) return;
    try {
        await _libFolderRequest(st, 'create', { name: name.trim(), parentId });
        await _refreshLibraryView(st);
    } catch (e) {
        showToast?.(e.message, 'error');
    }
}

async function _renameLibraryFolder(st, id) {
    const modal = document.getElementById(st.cfg.modalId);
    const card = Array.from(modal?.querySelectorAll('.tpl-folder-card') || []).find(c => c.dataset.folderId === id);
    const title = card?.querySelector('.tpl-folder-name');
    if (!title) return;
    _editNameInPlace(title, async name => {
        await _libFolderRequest(st, 'rename', { id, name });
        _updateRenamedCard(st, 'folder', id, name);
        if (st.mode === 'liveProject') window.reelsOnLibraryFolderChanged?.([id], { skipWorkspaceSync: false });
    });
}

async function _deleteLibraryFolder(st, id) {
    const folder = (st.folderData.folders || []).find(f => f.id === id);
    const name = folder?.name || '该文件夹';
    if (!confirm(`确定删除空文件夹「${name}」？`)) return;
    try {
        await _libFolderRequest(st, 'delete', { id });
        if (st.folderId === id) st.folderId = folder?.parentId || '';
        await _refreshLibraryView(st);
        showToast?.(`文件夹「${name}」已删除`, 'success');
    } catch (e) {
        showToast?.(e.message, 'error');
    }
}

async function _moveLibraryFolderIds(st, folderIds, targetParentId) {
    try {
        await _libFolderRequest(st, 'move-folders', { folderIds, targetParentId });
        await _refreshLibraryView(st);
        showToast?.('文件夹已移动 ✅', 'success');
    } catch (e) {
        showToast?.(e.message, 'error');
    }
}

async function _openLibraryFolder(st, id, options = {}) {
    if (id && !st.folderData.folders.some(f => f.id === id)) id = '';
    const modal = document.getElementById(st.cfg.modalId);
    const container = modal?.querySelector('[data-role="grid-container"]');
    if (!options.fromHistory && id !== st.folderId) {
        st.folderHistory[st.folderHistoryIndex] = { id: st.folderId, scrollTop: container?.scrollTop || 0 };
        st.folderHistory = st.folderHistory.slice(0, st.folderHistoryIndex + 1);
        st.folderHistory.push({ id, scrollTop: 0 });
        st.folderHistoryIndex++;
    }
    st.folderId = id;
    modal?._selectedItemIds?.clear();
    modal?._selectedFolderIds?.clear();
    if (modal) modal._selectionAnchorKey = '';
    await _refreshLibraryView(st);
    if (container && Number.isFinite(options.scrollTop)) container.scrollTop = options.scrollTop;
}

async function _navigateLibraryFolder(direction) {
    const st = _getVisibleLibraryState();
    if (!st) return false;
    const modal = document.getElementById(st.cfg.modalId);
    const now = Date.now();
    if (st.lastNavigation.direction === direction && now - st.lastNavigation.time < 100) return false;
    const next = st.folderHistoryIndex + (direction === 'back' ? -1 : 1);
    if (next < 0 || next >= st.folderHistory.length) return false;
    st.lastNavigation = { direction, time: now };
    const container = modal.querySelector('[data-role="grid-container"]');
    st.folderHistory[st.folderHistoryIndex] = { id: st.folderId, scrollTop: container?.scrollTop || 0 };
    st.folderHistoryIndex = next;
    const entry = st.folderHistory[next];
    await _openLibraryFolder(st, entry.id, { fromHistory: true, scrollTop: entry.scrollTop });
    return true;
}
window.addEventListener('videokit-template-navigation', event => { _navigateLibraryFolder(event.detail); });
window.addEventListener('mouseup', event => {
    if (event.button === 3 || event.button === 4) {
        if (_getVisibleLibraryState()) {
            event.preventDefault();
            _navigateLibraryFolder(event.button === 3 ? 'back' : 'forward');
        }
    }
}, { capture: true });
window.addEventListener('auxclick', event => {
    if ((event.button === 3 || event.button === 4) && _getVisibleLibraryState()) event.preventDefault();
}, { capture: true });

async function _moveLibraryItemIds(st, ids, folderId) {
    const prevFolderId = st.folderId;
    try {
        await _libFolderRequest(st, 'move', { ids, folderId });
        const modal = document.getElementById(st.cfg.modalId);
        for (const id of ids) modal?._selectedItemIds?.delete(id);
        await _refreshLibraryView(st);
        if (st.mode === 'liveProject') {
            window.reelsOnLibraryFolderChanged?.([prevFolderId, folderId].filter(Boolean));
        }
    } catch (e) {
        showToast?.(e.message, 'error');
    }
}

async function _moveSelectedToParent(st) {
    const modal = document.getElementById(st.cfg.modalId);
    const ids = (modal?._visibleSummaries || []).filter(t => modal._selectedItemIds?.has(t.id)).map(t => t.id);
    if (!ids.length) { showToast?.(`请先勾选要移出的${st.cfg.itemNoun}`, 'info'); return; }
    await _moveLibraryItemIds(st, ids, _getParentFolder(st, st.folderId));
}

function _pickTargetFolder(st, options = {}) {
    return new Promise(resolve => {
        const excludeIds = new Set(options.excludeFolderIds || []);
        const folders = st.folderData.folders || [];
        const byParent = new Map();
        for (const f of folders) {
            if (!f || !f.id || excludeIds.has(f.id)) continue;
            const p = f.parentId || '';
            if (!byParent.has(p)) byParent.set(p, []);
            byParent.get(p).push(f);
        }
        const flattened = [{ id: '', label: `🏠 ${st.cfg.homeLabel}（根目录）`, depth: 0 }];
        const walk = (parentId, depth) => {
            const list = _sortLibraryItems(st, byParent.get(parentId) || []);
            for (const f of list) {
                flattened.push({ id: f.id, label: `📁 ${f.name}`, depth });
                walk(f.id, depth + 1);
            }
        };
        walk('', 1);

        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.72);display:flex;align-items:center;justify-content:center;';
        ov.innerHTML = `
            <div style="width:420px;max-width:92vw;max-height:76vh;background:#161626;border:1px solid rgba(255,255,255,0.14);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,0.65);">
                <div style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;justify-content:space-between;align-items:center;">
                    <span style="font-size:14px;font-weight:700;color:#fff;">${_tplEscapeHtml(options.title || '选择目标文件夹')}</span>
                    <button data-close style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;">✕</button>
                </div>
                <div style="flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:4px;">
                    ${flattened.map(item => `
                        <button type="button" class="tpl-pick-folder-row" data-folder-id="${_tplEscapeHtml(item.id)}" style="text-align:left;padding:7px 10px 7px ${10 + item.depth * 18}px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:6px;color:#e2e8f0;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px;"
                                onmouseenter="this.style.background='rgba(99,102,241,0.22)'" onmouseleave="this.style.background='rgba(255,255,255,0.03)'">
                            <span>${_tplEscapeHtml(item.label)}</span>
                            ${item.id === (st.folderId || '') ? '<span style="margin-left:auto;font-size:10px;color:#94a3b8;">当前位置</span>' : ''}
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
        document.body.appendChild(ov);
        const done = (val) => { ov.remove(); resolve(val); };
        ov.querySelector('[data-close]').onclick = () => done(null);
        ov.addEventListener('click', e => { if (e.target === ov) done(null); });
        ov.querySelectorAll('.tpl-pick-folder-row').forEach(btn => {
            btn.onclick = () => done(btn.dataset.folderId ?? '');
        });
    });
}

function _renderFolderCard(st, folder, all) {
    const directMembers = all.filter(t => st.folderData.assignments[t.id] === folder.id);
    const childFolders = (st.folderData.folders || []).filter(f => f && f.parentId === folder.id);
    const descIds = _collectTplDescendantFolderIds(folder.id, st.folderData.folders);
    const previewMembers = directMembers.length > 0
        ? directMembers
        : all.filter(t => descIds.has(st.folderData.assignments[t.id] || ''));
    const recent = [...previewMembers].sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0));
    const images = Array.from({ length: 4 }, (_, i) => `<div class="tpl-folder-preview" style="aspect-ratio:9/16;width:100%;min-height:0;overflow:hidden;border-radius:7px;background:#ffffff08;display:flex;align-items:center;justify-content:center;color:#8a6da055;">${recent[i]?.thumbnail ? `<img draggable="false" loading="lazy" decoding="async" src="${_tplEscapeHtml(recent[i].thumbnail)}" style="display:block;width:100%;height:100%;object-fit:contain;">` : '🎬'}</div>`).join('');
    const date = new Date(Math.max(Date.parse(folder.updatedAt || folder.createdAt) || 0, ...previewMembers.map(t => Date.parse(t.updatedAt || t.createdAt) || 0))).toLocaleDateString('zh-CN');
    const countLabel = childFolders.length > 0 && directMembers.length > 0
        ? `${childFolders.length} 子文件夹 · ${directMembers.length} ${st.cfg.itemNoun}`
        : (childFolders.length > 0 ? `${childFolders.length} 个子文件夹` : `${directMembers.length} 个${st.cfg.itemNoun}`);
    const modal = document.getElementById(st.cfg.modalId);
    const showCheck = !modal?._onSelectCallback;
    const safeFid = _tplEscapeHtml(folder.id);
    return `<div class="tpl-folder-card" draggable="true" tabindex="0" role="button" aria-label="${_tplEscapeHtml(folder.name)}，${countLabel}" title="单击多选 · 双击打开文件夹 · 右键菜单 · F2 改名" data-folder-id="${safeFid}" style="position:relative;cursor:pointer;min-width:0;border-radius:18px;border:1px solid #ffffff12;overflow:hidden;background:#08080c;transition:box-shadow .16s,border-color .16s;">
        <div class="tpl-folder-cover" style="aspect-ratio:9/16;position:relative;padding:calc(8px * var(--tpl-scale,1)) calc(12px * var(--tpl-scale,1)) calc(12px * var(--tpl-scale,1));box-sizing:border-box;background:#08080c;">
            <div class="tpl-folder-mark" style="position:absolute;top:0;left:0;right:0;height:8px;background:linear-gradient(90deg,${st.mode === 'liveProject' ? '#10b981,#0f766e' : '#8152b8,#39234f'});"></div>
            ${showCheck ? `<button type="button" class="tpl-card-check tpl-folder-check" data-folder-id="${safeFid}" title="勾选/取消多选文件夹" aria-label="多选文件夹"></button>` : ''}
            <div style="position:relative;height:100%;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:calc(8px * var(--tpl-scale,1));align-content:start;max-width:100%;margin:0 auto;">${images}</div>
        </div>
        <div class="tpl-card-info tpl-folder-info" style="padding:calc(12px * var(--tpl-scale,1)) calc(10px * var(--tpl-scale,1));background:#242424;"><div class="tpl-folder-name" title="双击修改名称" style="font-size:calc(12px * var(--tpl-scale,1));font-weight:500;line-height:1.5;text-align:center;color:#eee;overflow-wrap:anywhere;">${_tplEscapeHtml(folder.name)}</div>
        <div class="tpl-meta" style="font-size:calc(10px * var(--tpl-scale,1));color:#999;margin-top:calc(9px * var(--tpl-scale,1));padding-top:calc(7px * var(--tpl-scale,1));border-top:1px solid #ffffff12;text-align:center;line-height:1.6;"><div>${_tplEscapeHtml(date)}</div><div>${_tplEscapeHtml(countLabel)}</div></div></div></div>`;
}

function _dragIdsFromEvent(event) {
    try {
        const ids = JSON.parse(event.dataTransfer.getData('application/x-videokit-items') || event.dataTransfer.getData('application/x-videokit-templates'));
        if (Array.isArray(ids) && ids.length && ids.every(id => typeof id === 'string')) return [...new Set(ids)];
    } catch (_) {}
    const id = event.dataTransfer.getData('text/plain');
    return id ? [id] : [];
}

function _bindFolderCards(st, modal, container) {
    for (const card of container.querySelectorAll('.tpl-folder-card')) {
        card.querySelector('.tpl-folder-check')?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            _applyCardSelectionAction(st, modal, 'f:' + (card.dataset.folderId || ''), {
                fromCheckbox: true,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
            });
        });
        card.addEventListener('dblclick', () => _openLibraryFolder(st, card.dataset.folderId));
        card.addEventListener('keydown', event => {
            if (event.target.isContentEditable) return;
            if (event.key === 'Enter') { event.preventDefault(); _openLibraryFolder(st, card.dataset.folderId); }
            else if (event.key === 'F2') { event.preventDefault(); _renameLibraryFolder(st, card.dataset.folderId); }
        });
        card.querySelector('.tpl-folder-name')?.addEventListener('dblclick', event => {
            event.stopPropagation();
            _renameLibraryFolder(st, card.dataset.folderId);
        });
        card.addEventListener('contextmenu', event => {
            if (event.target.isContentEditable) return;
            event.preventDefault();
            event.stopPropagation();
            _showFolderContextMenu(st, event, card);
        });
        card.addEventListener('dragover', event => {
            if (Array.from(event.dataTransfer.types).includes('application/x-videokit-folder')) return;
            event.preventDefault();
            card.style.outline = '2px solid #8b9cff';
        });
        card.addEventListener('dragleave', () => card.style.outline = '');
        card.addEventListener('drop', event => {
            if (Array.from(event.dataTransfer.types).includes('application/x-videokit-folder')) return;
            event.preventDefault();
            event.stopPropagation();
            card.style.outline = '';
            const ids = _dragIdsFromEvent(event);
            if (ids.length) _moveLibraryItemIds(st, ids, card.dataset.folderId);
        });
    }
    const bindDropTarget = (el, targetFolderId) => {
        if (!el) return;
        if (!el.classList.contains('is-current') && el.dataset.role !== 'folder-home') {
            el.onclick = () => _openLibraryFolder(st, targetFolderId);
        }
        el.ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; el.style.background = '#6366f144'; };
        el.ondragleave = () => { el.style.background = el.dataset.role === 'folder-home' ? '#ffffff08' : ''; };
        el.ondrop = async event => {
            event.preventDefault();
            event.stopPropagation();
            el.style.background = el.dataset.role === 'folder-home' ? '#ffffff08' : '';
            const folderDragId = event.dataTransfer.getData('application/x-videokit-folder');
            if (folderDragId) {
                if (folderDragId !== targetFolderId) await _moveLibraryFolderIds(st, [folderDragId], targetFolderId);
                return;
            }
            const ids = _dragIdsFromEvent(event);
            if (ids.length) await _moveLibraryItemIds(st, ids, targetFolderId);
        };
    };
    bindDropTarget(modal.querySelector('[data-role="folder-home"]'), '');
    for (const chip of modal.querySelectorAll('[data-role="breadcrumbs"] .tpl-breadcrumb-chip')) {
        bindDropTarget(chip, chip.dataset.folderId || '');
    }
}

let _tplInlineEditing = null;
function _editNameInPlace(title, save) {
    if (_tplInlineEditing) { _tplInlineEditing.focus(); return; }
    _tplInlineEditing = title;
    const original = title.textContent, oldStyle = title.getAttribute('style');
    const card = title.closest('.tpl-card,.tpl-folder-card'), wasDraggable = card?.getAttribute('draggable');
    if (card) card.draggable = false;
    title.contentEditable = 'plaintext-only'; title.spellcheck = false;
    title.setAttribute('role', 'textbox'); title.setAttribute('aria-label', '修改名称');
    Object.assign(title.style, { cursor: 'text', outline: '1px solid #8999e8', borderRadius: '4px', background: '#6366f11a', minHeight: '1.5em', userSelect: 'text' });
    let done = false;
    const stop = event => event.stopPropagation();
    const clean = () => {
        title.removeAttribute('contenteditable'); title.removeAttribute('role'); title.removeAttribute('aria-label');
        if (oldStyle === null) title.removeAttribute('style'); else title.setAttribute('style', oldStyle);
        if (card) { if (wasDraggable === null) card.removeAttribute('draggable'); else card.setAttribute('draggable', wasDraggable); }
        title.removeEventListener('blur', blur); title.removeEventListener('keydown', key);
        for (const type of ['click', 'dblclick', 'mousedown', 'dragstart']) title.removeEventListener(type, stop);
        _tplInlineEditing = null;
    };
    const finish = async cancel => {
        if (done) return;
        done = true;
        const name = title.textContent.replace(/[\r\n]+/g, ' ').trim();
        clean();
        if (cancel || !name || name === original) { title.textContent = original; return; }
        if (name.length > 200) { title.textContent = original; showToast?.('名称最多200字', 'warning'); return; }
        title.textContent = name;
        try { await save(name); } catch (error) { title.textContent = original; showToast?.('重命名失败：' + error.message, 'error'); }
    };
    const blur = () => finish(false);
    const key = event => {
        event.stopPropagation();
        if (event.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); finish(false); }
        else if (event.key === 'Escape') { event.preventDefault(); finish(true); }
    };
    title.addEventListener('blur', blur);
    title.addEventListener('keydown', key);
    for (const type of ['click', 'dblclick', 'mousedown', 'dragstart']) title.addEventListener(type, stop);
    title.focus();
    const range = document.createRange(); range.selectNodeContents(title); range.collapse(false);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
}

function _paintLibrarySelection(st) {
    const modal = document.getElementById(st.cfg.modalId);
    if (!modal || modal._onSelectCallback) return;
    for (const card of modal.querySelectorAll('.tpl-card')) {
        const selected = modal._selectedItemIds?.has(card.dataset.id);
        card.classList.toggle('tpl-selected', !!selected);
        card.setAttribute('aria-selected', String(!!selected));
        card.style.boxShadow = selected ? 'inset 0 0 0 2px #8b9cff,0 0 0 1px #8b9cff' : '';
        card.style.background = selected ? 'rgba(99,102,241,.18)' : 'rgba(255,255,255,.03)';
        const cb = card.querySelector('.tpl-card-check');
        if (cb) cb.textContent = selected ? '✓' : '';
    }
    for (const card of modal.querySelectorAll('.tpl-folder-card')) {
        const selected = modal._selectedFolderIds?.has(card.dataset.folderId);
        card.classList.toggle('tpl-selected', !!selected);
        card.setAttribute('aria-selected', String(!!selected));
        card.style.boxShadow = selected ? 'inset 0 0 0 2px #8b9cff,0 0 0 1px #8b9cff' : '';
        const cb = card.querySelector('.tpl-folder-check');
        if (cb) cb.textContent = selected ? '✓' : '';
    }
    _updateLibrarySelectionUI(st);
}

function _initLibraryMarquee(st, modal, container) {
    if (modal._onSelectCallback) return;
    container._marqueeController?.abort();
    const controller = new AbortController();
    container._marqueeController = controller;
    const signal = controller.signal;
    for (const card of container.querySelectorAll('.tpl-card, .tpl-folder-card')) {
        card.addEventListener('click', event => {
            if (event.target.closest('button,input,label,[contenteditable]') || container._marqueeActive) return;
            const key = card.classList.contains('tpl-folder-card')
                ? ('f:' + (card.dataset.folderId || ''))
                : ('t:' + (card.dataset.id || ''));
            _applyCardSelectionAction(st, modal, key, {
                fromCheckbox: false,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
            });
        }, { signal });
    }
    container.addEventListener('mousedown', event => {
        if (event.button !== 0 || event.target.closest('.tpl-card,.tpl-folder-card,button,input,select,[contenteditable]')) return;
        if (_tplInlineEditing) { event.preventDefault(); _tplInlineEditing.blur(); return; }
        event.preventDefault();
        const rect = container.getBoundingClientRect(), startX = event.clientX, startY = event.clientY - rect.top + container.scrollTop;
        const preserve = event.ctrlKey || event.metaKey || event.shiftKey;
        const keepItems = preserve ? new Set(modal._selectedItemIds) : new Set();
        const keepFolders = preserve ? new Set(modal._selectedFolderIds) : new Set();
        const box = document.createElement('div');
        Object.assign(box.style, { position: 'fixed', pointerEvents: 'none', zIndex: '999998', background: 'rgba(99,102,241,.16)', border: '1px solid #a5b4fc', display: 'none' });
        document.body.appendChild(box);
        container._marqueeActive = true;
        let x = startX, y = event.clientY, raf = 0, active = true;
        const oldSelect = document.body.style.userSelect;
        document.body.style.userSelect = 'none';
        const update = () => {
            const bounds = container.getBoundingClientRect(), anchorY = bounds.top + startY - container.scrollTop;
            const left = Math.max(bounds.left, Math.min(startX, x)), right = Math.min(bounds.right, Math.max(startX, x));
            const top = Math.max(bounds.top, Math.min(anchorY, y)), bottom = Math.min(bounds.bottom, Math.max(anchorY, y));
            Object.assign(box.style, { display: 'block', left: left + 'px', top: top + 'px', width: Math.max(0, right - left) + 'px', height: Math.max(0, bottom - top) + 'px' });
            modal._selectedItemIds = new Set(keepItems);
            modal._selectedFolderIds = new Set(keepFolders);
            const contentY = y - bounds.top + container.scrollTop;
            const sTop = Math.min(startY, contentY), sBot = Math.max(startY, contentY), sLeft = Math.min(startX, x), sRight = Math.max(startX, x);
            for (const card of container.querySelectorAll('.tpl-card, .tpl-folder-card')) {
                const r = card.getBoundingClientRect(), cTop = r.top - bounds.top + container.scrollTop, cBot = r.bottom - bounds.top + container.scrollTop;
                if (sRight > sLeft && sBot > sTop && r.right > sLeft && r.left < sRight && cBot > sTop && cTop < sBot) {
                    if (card.classList.contains('tpl-folder-card')) modal._selectedFolderIds.add(card.dataset.folderId);
                    else modal._selectedItemIds.add(card.dataset.id);
                }
            }
            _paintLibrarySelection(st);
        };
        const move = ev => { x = ev.clientX; y = ev.clientY; update(); };
        const tick = () => {
            if (!active) return;
            const bounds = container.getBoundingClientRect();
            if (y < bounds.top + 35) container.scrollTop -= 14;
            else if (y > bounds.bottom - 35) container.scrollTop += 14;
            update();
            raf = requestAnimationFrame(tick);
        };
        const finish = () => {
            if (!active) return;
            active = false; cancelAnimationFrame(raf); box.remove();
            document.body.style.userSelect = oldSelect;
            document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', finish);
            setTimeout(() => container._marqueeActive = false, 0);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', finish, { once: true });
        signal.addEventListener('abort', finish, { once: true });
        update();
        raf = requestAnimationFrame(tick);
    }, { signal });
}

let _tplContextMenuCleanup = null;
function _closeTemplateContextMenu() { if (_tplContextMenuCleanup) _tplContextMenuCleanup(); }

function _showFolderContextMenu(st, event, card) {
    _closeTemplateContextMenu();
    const modal = document.getElementById(st.cfg.modalId);
    const folderId = card.dataset.folderId || '';
    if (modal && !modal._selectedFolderIds?.has(folderId)) {
        modal._selectedItemIds?.clear();
        modal._selectedFolderIds = new Set([folderId]);
        _paintLibrarySelection(st);
    }
    const selFolders = [...(modal?._selectedFolderIds || [folderId])];
    const selTotal = (modal?._selectedItemIds?.size || 0) + selFolders.length;
    const descIds = _collectTplDescendantFolderIds(folderId, st.folderData.folders);
    const items = [
        ['📂 进入文件夹', () => _openLibraryFolder(st, folderId)],
        ...(st.mode === 'liveProject' ? [
            ['⚡ 打开本文件夹全部工程', () => window.reelsApplyFolderById(folderId)],
            ['📄 在此新建空白标签', () => _createBlankLiveProjectDialog(st, folderId)],
        ] : []),
        ['📁 在此新建子文件夹', () => _newLibraryFolder(st, folderId)],
        ['', null],
        ['✏️ 重命名文件夹', () => _renameLibraryFolder(st, folderId)],
        selTotal > 1
            ? [`📦 批量移动所选 ${selTotal} 项到...`, () => _batchMoveLibrarySelection(st)]
            : ['📦 移动到其他文件夹...', async () => {
                const target = await _pickTargetFolder(st, { title: '移动文件夹到...', excludeFolderIds: [...descIds] });
                if (target !== null) await _moveLibraryFolderIds(st, [folderId], target);
            }],
        selTotal > 1
            ? [`🗑️ 批量删除所选 (${selTotal} 项)`, () => _batchDeleteLibrarySelection(st)]
            : ['🗑️ 删除空文件夹', () => _deleteLibraryFolder(st, folderId)],
    ];
    _showContextMenu(event, items, card, st);
}

function _showItemContextMenu(st, event, card) {
    _closeTemplateContextMenu();
    const modal = document.getElementById(st.cfg.modalId);
    const id = card.dataset.id, name = card.dataset.name || '';
    if (!modal._selectedItemIds.has(id)) {
        modal._selectedItemIds = new Set([id]);
        modal._selectedFolderIds?.clear();
        _paintLibrarySelection(st);
    }
    const selectedIds = (modal._visibleSummaries || []).filter(t => modal._selectedItemIds.has(t.id)).map(t => t.id);
    const activeIds = selectedIds.length ? selectedIds : [id];

    const items = st.mode === 'template' ? [
        ['🎬 预览效果', () => _openLibraryItemPreviewModal(st, id)],
        ['📂 载入副本到工作区（不修改原模板）', () => _loadTemplateInCurrentWindow(id)],
        ['📥 追加副本到当前工作区', () => _loadTemplateInCurrentWindow(id, { append: true })],
        ['🪟 在新窗口打开', () => _openTemplateInWindow(id, name)],
        ['📸 刷新此模板封面', () => _repairTemplateThumbnailsByIds(activeIds, { mode: 'template' })],
        ['📤 另存一份到「🗂️ 工程项目」', async () => {
            const res = await _libApiRequest(_getLibState('liveProject'), 'import-from-templates', { templateIds: activeIds, copyAllFolders: false });
            showToast?.(`✅ 已复制 ${res.importedCount || 1} 份到实时工程项目`, 'success');
            window.reelsRefreshTemplateLibraryIfOpen?.('liveProject');
        }],
        ['', null],
        ['📦 移动到模板文件夹...', async () => {
            const target = await _pickTargetFolder(st, { title: `移动 ${activeIds.length} 个模板到...` });
            if (target !== null) await _moveLibraryItemIds(st, activeIds, target);
        }],
        ...(st.folderId ? [['↩ 移出到上级', () => _moveLibraryItemIds(st, activeIds, _getParentFolder(st, st.folderId))]] : []),
        ['导出模板 (.vktpl)', () => _exportLibraryItem(st, id, name)],
        ['打包导出模板和素材 (.vkpkg)', () => _exportArchiveLibraryItem(st, id)],
        ['✏️ 重命名', () => _renameLibraryItem(st, id)],
        activeIds.length > 1
            ? [`🗑️ 批量删除所选 ${activeIds.length} 个模板`, () => _batchDeleteLibrarySelection(st)]
            : ['🗑️ 删除模板', () => _deleteLibraryItem(st, id, name)],
    ] : [
        ['🎬 预览效果', () => _openLibraryItemPreviewModal(st, id)],
        ['⚡ 打开并编辑此工程', () => _applyLiveProjectIdsToWorkspace(st, [id], { folderId: st.folderId })],
        ['📥 追加打开到当前工作区', () => _applyLiveProjectIdsToWorkspace(st, [id], { folderId: st.folderId, loadMode: 'append' })],
        ...(activeIds.length > 1 ? [[`✅ 打开所选 ${activeIds.length} 个工程`, () => _applySelectedLiveProjects(st)]] : []),
        ['📸 刷新此工程封面', () => _repairTemplateThumbnailsByIds(activeIds, { mode: 'liveProject' })],
        ['📄 同级新建空白标签', () => _createBlankLiveProjectDialog(st, st.folderId)],
        ['📑 复制一份新工程', async () => {
            const src = await _libApiRequest(st, 'get', { id });
            await _libApiRequest(st, 'save', { name: `${src.name || name} (副本)`, folderId: st.folderId || '', thumbnail: src.thumbnail || '', projectData: JSON.parse(JSON.stringify(src.projectData)) });
            await _refreshLibraryView(st);
            showToast?.('📑 已复制生成新实时工程', 'success');
        }],
        ['🔒 另存为封存模板（存入模板库）', async () => {
            await _sealSelectedLiveProjectsToTemplates(st);
        }],
        ['', null],
        ['📦 移动到文件夹...', async () => {
            const target = await _pickTargetFolder(st, { title: `移动 ${activeIds.length} 个工程到...` });
            if (target !== null) await _moveLibraryItemIds(st, activeIds, target);
        }],
        ...(st.folderId ? [['↩ 移出到上级', () => _moveLibraryItemIds(st, activeIds, _getParentFolder(st, st.folderId))]] : []),
        ['导出工程文件 (.vktpl)', () => _exportLibraryItem(st, id, name)],
        ['打包导出工程和素材 (.vkpkg)', () => _exportArchiveLibraryItem(st, id)],
        ['✏️ 重命名', () => _renameLibraryItem(st, id)],
        activeIds.length > 1
            ? [`🗑️ 批量删除所选 ${activeIds.length} 个工程`, () => _batchDeleteLibrarySelection(st)]
            : ['🗑️ 彻底删除工程', () => _deleteLibraryItem(st, id, name)],
    ];
    _showContextMenu(event, items, card, st);
}

function _showContextMenu(event, items, focusTarget, st = null) {
    _closeTemplateContextMenu();
    const menu = document.createElement('div');
    menu.id = 'tpl-context-menu';
    menu.setAttribute('role', 'menu');
    Object.assign(menu.style, { position: 'fixed', zIndex: '999999', minWidth: '210px', padding: '5px', borderRadius: '8px', background: '#17171e', border: '1px solid #ffffff24', boxShadow: '0 6px 20px #0007', color: '#eee', fontSize: '12px' });
    const controller = new AbortController(), signal = controller.signal;
    const close = () => { controller.abort(); menu.remove(); _tplContextMenuCleanup = null; };
    _tplContextMenuCleanup = close;
    for (const [label, run] of items) {
        if (!run) {
            const divider = document.createElement('div');
            divider.style.cssText = 'height:1px;background:#ffffff12;margin:5px 3px;';
            menu.appendChild(divider);
            continue;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('role', 'menuitem');
        const isDanger = label.includes('删除');
        Object.assign(button.style, { display: 'block', width: '100%', padding: '8px 12px', textAlign: 'left', border: 0, borderRadius: '4px', background: 'transparent', color: isDanger ? '#f59b9b' : '#eee', font: 'inherit', cursor: 'pointer' });
        button.onmouseenter = () => button.style.background = '#ffffff0c';
        button.onmouseleave = () => button.style.background = 'transparent';
        button.onclick = async e => { e.stopPropagation(); close(); try { await run(); } catch (error) { showToast?.(error.message, 'error'); } };
        menu.appendChild(button);
    }
    menu.addEventListener('mousedown', e => e.stopPropagation());
    menu.addEventListener('contextmenu', e => e.preventDefault());
    document.body.appendChild(menu);
    const box = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(event.clientX, window.innerWidth - box.width - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(event.clientY, window.innerHeight - box.height - 6)) + 'px';
    document.addEventListener('mousedown', e => { if (!menu.contains(e.target)) close(); }, { capture: true, signal });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); focusTarget?.focus?.(); }
    }, { capture: true, signal });
    window.addEventListener('resize', close, { once: true, signal });
    if (st) document.getElementById(st.cfg.modalId)?.querySelector('[data-role="grid-container"]')?.addEventListener('scroll', close, { once: true, signal });
    menu.firstElementChild?.focus?.();
}

function _templateHomeIcon() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex-shrink:0"><path d="M12 3 2 11h3v10h5v-6h4v6h5V11h3L12 3Z"/></svg>';
}

function _showBlankContextMenu(st, event) {
    const mode = localStorage.getItem(st.cfg.sortKey) || 'manual';
    const direction = localStorage.getItem(st.cfg.sortDirKey) || 'asc';
    const modal = document.getElementById(st.cfg.modalId);
    const hasSelection = ((modal?._selectedItemIds?.size || 0) + (modal?._selectedFolderIds?.size || 0)) > 0;
    const items = [
        ...(st.mode === 'liveProject' ? [['📄 新建空白标签', () => _createBlankLiveProjectDialog(st)]] : []),
        ['📁 新建文件夹', () => _newLibraryFolder(st)],
        ['', null],
        ['☑ 全选当前页 (Ctrl+A)', () => _selectAllLibraryItems(st, { forceAll: true })],
        ['🔁 反选当前页', () => _invertLibrarySelection(st)],
        ...(hasSelection ? [['☐ 清空选择 (Esc)', () => _clearLibrarySelection(st)]] : []),
        [modal?._multiSelectMode ? '✓ 多选模式：点击卡片即勾选' : '☑️ 开启多选模式', () => _toggleMultiSelectMode(st)],
        ['', null],
    ];
    for (const [key, label] of [['manual', '手动排序'], ['name', '按名称排序'], ['type', '按类型排序'], ['modified', '按修改日期排序'], ['size', '按大小排序']]) {
        items.push([(mode === key ? '✓ ' : '') + label, () => { localStorage.setItem(st.cfg.sortKey, key); _refreshLibraryView(st); }]);
    }
    items.push(['', null]);
    for (const [key, label] of [['asc', '升序'], ['desc', '降序']]) {
        items.push([(direction === key ? '✓ ' : '') + label, () => { localStorage.setItem(st.cfg.sortDirKey, key); _refreshLibraryView(st); }]);
    }
    _showContextMenu(event, items, null, st);
}

function _layoutLibraryMixedGrid(st, grid) {
    if (!grid?.isConnected) return;
    const gap = Math.max(2, Math.round(12 * _getLibZoom(st) / 100));
    const infos = Array.from(grid.querySelectorAll(':scope > .tpl-card > .tpl-card-info,:scope > .tpl-folder-card > .tpl-card-info'));
    let infoHeight = 0;
    for (const info of infos) {
        let height = 20;
        for (const child of info.children) {
            const css = getComputedStyle(child);
            height += child.getBoundingClientRect().height + (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0);
        }
        infoHeight = Math.max(infoHeight, Math.ceil(height));
    }
    for (const info of infos) if (info.style.minHeight !== infoHeight + 'px') info.style.minHeight = infoHeight + 'px';
    const rows = Array.from(grid.children).map(card => [card, Math.max(1, Math.ceil(card.getBoundingClientRect().height + gap))]);
    for (const [card, span] of rows) {
        const value = 'span ' + span;
        if (card.style.gridRowEnd !== value) card.style.gridRowEnd = value;
    }
}

function _bindMixedGridLayout(st, container) {
    container._tplLayoutObserver?.disconnect();
    if (container._tplLayoutFrame) cancelAnimationFrame(container._tplLayoutFrame);
    const grid = container.querySelector(`.${st.cfg.prefix}-card-grid`);
    if (!grid) return;
    const observer = new ResizeObserver(() => {
        if (container._tplLayoutFrame) return;
        container._tplLayoutFrame = requestAnimationFrame(() => {
            container._tplLayoutFrame = 0;
            _layoutLibraryMixedGrid(st, grid);
        });
    });
    container._tplLayoutObserver = observer;
    observer.observe(grid);
    for (const card of grid.children) observer.observe(card);
    _layoutLibraryMixedGrid(st, grid);
}

function _initLibraryWindowSizing(st, modal) {
    if (!document.getElementById('vk-library-fixed-text-style')) {
        const style = document.createElement('style');
        style.id = 'vk-library-fixed-text-style';
        style.textContent = `
        .vk-lib-grid>.tpl-card,.vk-lib-grid>.tpl-folder-card{display:flex;flex-direction:column;}
        .vk-lib-grid .tpl-template-cover,.vk-lib-grid .tpl-folder-cover{width:min(100%,var(--tpl-card-size))!important;aspect-ratio:9/16;margin-inline:auto;flex-shrink:0;min-height:0;box-sizing:border-box;}
        .vk-lib-grid .tpl-folder-cover{padding:6px 4px 4px!important;}
        .vk-lib-grid .tpl-folder-cover>div:not(.tpl-folder-mark){gap:4px!important;align-items:center;}
        .vk-lib-grid .tpl-card-info{padding:10px 8px!important;box-sizing:border-box;width:100%;}
        .vk-lib-grid .tpl-name,.vk-lib-grid .tpl-folder-name{font-size:12px!important;line-height:1.5!important;}
        .vk-lib-grid .tpl-meta{font-size:10px!important;line-height:1.4!important;margin-top:8px!important;padding-top:7px!important;gap:3px!important;}
        .vk-lib-grid .tpl-meta>span,.vk-lib-grid .tpl-meta>div{white-space:nowrap;}
        .vk-lib-header{position:relative;flex-wrap:nowrap;gap:12px;flex-shrink:0;min-width:0;}
        .vk-lib-header>div:first-child{flex-shrink:0;white-space:nowrap;}
        .vk-lib-actions{flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;flex-wrap:nowrap;scrollbar-width:thin;}
        .vk-lib-actions>button,.vk-lib-actions>span{flex-shrink:0;white-space:nowrap;}
        .vk-selection-bar .vk-sel-btn:hover:not(:disabled){filter:brightness(1.14);}
        .tpl-card-check{position:absolute;left:8px;top:8px;z-index:4;width:24px;height:24px;border-radius:7px;border:1.5px solid rgba(226,232,240,0.68);background:rgba(15,23,42,0.82);color:#fff;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.45);transition:transform .12s,border-color .15s,background .15s;}
        .tpl-card-check:hover{transform:scale(1.08);border-color:#93c5fd;background:rgba(30,41,59,0.95);}
        .vk-multi-select-on .tpl-card-check{border-color:rgba(110,231,183,0.9);box-shadow:0 0 0 2px rgba(16,185,129,0.28);}
        .tpl-card.tpl-selected .tpl-card-check,.tpl-folder-card.tpl-selected .tpl-card-check{background:#6366f1;border-color:#c7d2fe;}
        .tpl-folder-card.tpl-selected{background:rgba(99,102,241,0.14)!important;}
        .tpl-card-preview-btn{position:absolute;right:8px;bottom:8px;z-index:4;padding:4px 9px;border-radius:999px;border:1px solid rgba(56,189,248,0.65);background:rgba(15,23,42,0.86);color:#e0f2fe;font-size:11px;font-weight:700;cursor:pointer;opacity:0;transition:opacity .15s,transform .12s,background .15s;box-shadow:0 3px 10px rgba(0,0,0,0.5);backdrop-filter:blur(4px);}
        .tpl-card:hover .tpl-card-preview-btn,.tpl-card:focus-within .tpl-card-preview-btn{opacity:1;}
        .tpl-card-preview-btn:hover{transform:scale(1.06);background:rgba(2,132,199,0.92);color:#fff;}
        `;
        document.head.appendChild(style);
    }
    const panel = modal.querySelector('.vk-lib-panel');
    const closeButton = modal.querySelector('[data-act="close"]');
    if (closeButton && panel) panel.querySelector('.vk-lib-header')?.appendChild(closeButton);
    let widthRatio = .90, heightRatio = .88;
    try {
        const saved = JSON.parse(localStorage.getItem(st.cfg.winSizeKey) || 'null');
        if (saved?.widthRatio && saved?.heightRatio) {
            widthRatio = Math.max(.4, Math.min(.96, saved.widthRatio));
            heightRatio = Math.max(.4, Math.min(.96, saved.heightRatio));
        }
    } catch (_) {}
    const fit = () => { if (panel) { panel.style.width = (innerWidth * widthRatio) + 'px'; panel.style.height = (innerHeight * heightRatio) + 'px'; } };
    fit();
    if (modal._windowSizeObserver || !panel) return;
    window.addEventListener('resize', fit);
    let timer = 0;
    modal._windowSizeObserver = new ResizeObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (!panel.isConnected || modal.style.display === 'none') return;
            const rect = panel.getBoundingClientRect();
            widthRatio = rect.width / innerWidth;
            heightRatio = rect.height / innerHeight;
            localStorage.setItem(st.cfg.winSizeKey, JSON.stringify({ widthRatio, heightRatio }));
        }, 200);
    });
    modal._windowSizeObserver.observe(panel);
}

function _updateRenamedCard(st, kind, id, name) {
    const modal = document.getElementById(st.cfg.modalId);
    const container = modal?.querySelector('[data-role="grid-container"]');
    if (!modal || !container) return;
    const scrollTop = container.scrollTop, now = new Date().toISOString();
    if (kind !== 'folder') {
        for (const list of [modal._allSummaries, modal._visibleSummaries]) {
            const item = list?.find(t => t.id === id);
            if (item) { item.name = name; item.updatedAt = now; }
        }
        const card = Array.from(container.querySelectorAll('.tpl-card')).find(c => c.dataset.id === id);
        if (card) {
            card.dataset.name = name;
            const title = card.querySelector('.tpl-name');
            if (title) { title.textContent = name; title.title = name; }
            const date = card.querySelector('.tpl-meta')?.firstElementChild;
            if (date) date.textContent = new Date(now).toLocaleDateString('zh-CN');
        }
    } else {
        const folder = st.folderData.folders.find(f => f.id === id);
        if (folder) { folder.name = name; folder.updatedAt = now; }
        const card = Array.from(container.querySelectorAll('.tpl-folder-card')).find(c => c.dataset.folderId === id);
        if (card) {
            const nameEl = card.querySelector('.tpl-folder-name');
            if (nameEl) nameEl.textContent = name;
            card.setAttribute('aria-label', name);
            const date = card.querySelector('.tpl-meta')?.firstElementChild;
            if (date) date.textContent = new Date(now).toLocaleDateString('zh-CN');
        }
    }
    _layoutLibraryMixedGrid(st, container.querySelector(`.${st.cfg.prefix}-card-grid`));
    container.scrollTop = scrollTop;
}
