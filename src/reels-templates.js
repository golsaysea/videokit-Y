/**
 * reels-templates.js — 视频模板库 UI + 逻辑
 * 
 * 功能：
 *   - 模板库面板（网格缩略图列表）
 *   - 保存当前工程为模板
 *   - 打开模板 → 独立编辑器窗口
 *   - 删除/重命名模板
 *   - 启动时检测 URL hash 自动加载模板
 */

// ═══════════════════════════════════════════════════════
// 1. 模板库 Modal UI
// ═══════════════════════════════════════════════════════

function _tplEscapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

let _tplSearchTerm = '';
let _tplSearchTimer = null;
function _getTemplateFolderChain(folderId, folders = _tplFolderData.folders || []) {
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

function _buildTemplateFolderPathText(folderId, folders = _tplFolderData.folders || []) {
    const chain = _getTemplateFolderChain(folderId, folders);
    return chain.length ? chain.map(f => f.name).join(' / ') : '主工程库';
}

function _collectTplDescendantFolderIds(rootFolderId, folders = _tplFolderData.folders || []) {
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

function _templateMatchesSearch(template, query, folderPathText = '') {
    const tokens = String(query || '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    if (!tokens.length) return true;
    const searchable = [template?.name, template?.templateType, template?.id, folderPathText].map(value => String(value ?? '').toLocaleLowerCase()).join(' ');
    return tokens.every(token => searchable.includes(token));
}
function _templateSearchChanged(value) {
    _tplSearchTerm = String(value || '');
    const clear = document.getElementById('tpl-search-clear');
    if (clear) clear.style.display = _tplSearchTerm ? '' : 'none';
    clearTimeout(_tplSearchTimer);
    _tplSearchTimer = setTimeout(() => _refreshTemplateList(), 180);
}
function _clearTemplateSearch() {
    _tplSearchTerm = '';
    clearTimeout(_tplSearchTimer);
    const input = document.getElementById('tpl-search-input');
    if (input) { input.value = ''; input.focus(); }
    const clear = document.getElementById('tpl-search-clear');
    if (clear) clear.style.display = 'none';
    _refreshTemplateList();
}
let _tplFolderId = '';
let _tplFolderData = {folders:[],assignments:{},folderOrders:{}};

let _currentTemplateContext = {
    id: '',
    name: '',
};

const TEMPLATE_CARD_SIZE_KEY = 'videokit_template_card_size';

function _getTemplateZoom() {
    const saved=Number(localStorage.getItem('videokit_template_zoom_percent'));
    if(saved>0)return Math.max(10,Math.min(200,Math.round(saved)));
    const pixels=parseInt(localStorage.getItem(TEMPLATE_CARD_SIZE_KEY) || '240',10);
    return Math.max(10,Math.min(200,Math.round((Number.isFinite(pixels)?pixels:240)/240*100)));
}
function _getTemplateCardSize(){return Math.round(240*_getTemplateZoom()/100);}
function _setTemplateCardSize(value){_setTemplateZoom(Number(value)/240*100);}
function _setTemplateZoom(value){
    const zoom=Math.max(10,Math.min(200,Math.round(Number(value)||100)));
    localStorage.setItem('videokit_template_zoom_percent',String(zoom));
    localStorage.setItem(TEMPLATE_CARD_SIZE_KEY,String(Math.round(240*zoom/100)));
    const slider=document.getElementById('tpl-card-size-slider'),label=document.getElementById('tpl-card-size-value'),grid=document.getElementById('tpl-card-grid');
    if(slider)slider.value=String(zoom);if(label)label.textContent=zoom+'%';
    if(grid){grid.style.setProperty('--tpl-card-size',_getTemplateCardSize()+'px');grid.style.setProperty('--tpl-scale',String(zoom/100));grid.style.columnGap=Math.max(2,Math.round(12*zoom/100))+'px';_layoutTemplateMixedGrid(grid);}
}

function _setCurrentTemplateContext(id, name) {
    _currentTemplateContext = {
        id: id || '',
        name: name || '',
    };
    _updateCurrentTemplateButton();
}

function _updateCurrentTemplateButton() {
    const btn = document.getElementById('tpl-update-current-btn');
    const label = document.getElementById('tpl-current-template-label');
    const wsStatus = typeof window.reelsGetWorkspaceLibraryStatus === 'function'
        ? window.reelsGetWorkspaceLibraryStatus()
        : null;
    const modal = document.getElementById('template-library-modal');
    const allIds = modal?._allTemplateSummaries
        ? new Set(modal._allTemplateSummaries.map(t => String(t.id)))
        : null;
    const candInfo = (! _currentTemplateContext.id && !wsStatus?.folderId && typeof window.reelsGetWorkspaceSaveCandidateInfo === 'function')
        ? window.reelsGetWorkspaceSaveCandidateInfo(allIds)
        : null;
    if (btn) {
        btn.disabled = !_currentTemplateContext.id;
        btn.style.opacity = _currentTemplateContext.id ? '1' : '0.45';
        btn.style.cursor = _currentTemplateContext.id ? 'pointer' : 'not-allowed';
        btn.title = _currentTemplateContext.id
            ? `用当前工程覆盖库内工程「${_currentTemplateContext.name || _currentTemplateContext.id}」`
            : '请先载入单个工程卡片以单独更新，或直接用「保存当前工程」整体归档';
    }
    if (label) {
        if (_currentTemplateContext.id) {
            label.textContent = `当前: ${_currentTemplateContext.name || _currentTemplateContext.id}`;
            label.title = _currentTemplateContext.name || _currentTemplateContext.id || '';
        } else if (wsStatus?.folderId) {
            const folderShort = String(wsStatus.folderPath || '已绑定文件夹').split(' / ').pop();
            const countText = wsStatus.folderTotalCount > 0
                ? `${wsStatus.openTabCount}/${wsStatus.folderTotalCount}`
                : `${wsStatus.openTabCount}`;
            label.textContent = `已绑定: ${folderShort} (${countText})`;
            label.title = `${wsStatus.folderPath} · 已打开 ${wsStatus.openTabCount} 个标签`;
        } else if (candInfo && candInfo.totalGroups > 0) {
            label.textContent = `工作区: ${candInfo.totalGroups} 个标签(未归档)`;
            label.title = `工作区当前有 ${candInfo.totalGroups} 个标签（${candInfo.totalTasks} 条任务），可点击上方一键自动保存并管理`;
        } else {
            label.textContent = '当前: 未载入工程';
            label.title = '';
        }
    }
}

function openTemplateLibrary(onSelectCallback = null, opts = {}) {
    const isPicker = !!onSelectCallback;
    let modal = document.getElementById('template-library-modal');
    if (typeof opts?.folderId === 'string') {
        _tplFolderId = opts.folderId;
    } else if (!isPicker && opts?.preserveRoot !== true && !_tplFolderId) {
        const activeFolder = window.reelsGetWorkspaceLibraryStatus?.().folderId || '';
        if (activeFolder) _tplFolderId = activeFolder;
    }

    if (modal && modal._wasPicker === isPicker) {
        modal.style.display = 'flex';
        modal._onSelectCallback = onSelectCallback;
        modal._pickerDisabledIds = new Set(opts.disabledIds || []);
        _updateCurrentTemplateButton();
        _refreshTemplateList();
        if (!isPicker && typeof window.reelsSyncWorkspaceTabsBackToLibraryFolder === 'function') {
            window.reelsSyncWorkspaceTabsBackToLibraryFolder({ silent: true, onlyDirty: true, autoCreateNew: !!window.reelsGetWorkspaceLibraryStatus?.().folderId })
                .then(res => { if (res && (res.updated || res.created)) _refreshTemplateList(); })
                .catch(() => {});
        }
        return;
    }
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'template-library-modal';
    modal._wasPicker = isPicker;
    modal._onSelectCallback = onSelectCallback;
    modal._pickerDisabledIds = new Set(opts.disabledIds || []);
    modal._selectedTemplateIds = new Set();
    modal.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:400000;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';
    
    modal.innerHTML = `
        <div class="modal-content" style="width:90vw;max-width:96vw;min-width:min(640px,96vw);height:80vh;max-height:96vh;min-height:min(360px,96vh);resize:both;display:flex;flex-direction:column;background:var(--bg-secondary,#1a1a2e);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
            <div class="tpl-library-header" style="display:flex;align-items:center;justify-content:space-between;padding:14px 54px 14px 20px;border-bottom:1px solid rgba(255,255,255,0.06);">
                <div style="display:flex;align-items:center;gap:12px;">
                    <span style="font-size:22px;">🗂️</span>
                    <h2 id="tpl-lib-title" style="margin:0;font-size:18px;font-weight:700;color:#fff;">${isPicker ? '选择工程模板' : '工程管理库'}</h2>
                    <span id="tpl-count-badge" style="font-size:11px;padding:2px 8px;background:rgba(110,231,183,0.15);color:#6ee7b7;border-radius:10px;"></span>
                </div>
                <div class="tpl-library-actions" style="display:flex;gap:6px;align-items:center;">
                    ${isPicker ? '' : `
                    <button id="tpl-new-folder-btn" onclick="_newTemplateFolder()" style="padding:5px 11px;font-size:11px;font-weight:600;background:rgba(139,92,246,0.18);color:#ddd6fe;border:1px solid rgba(167,139,250,0.38);border-radius:8px;cursor:pointer;" title="在当前所在文件夹下新建文件夹（支持多级目录）">📁 新建文件夹</button>
                    <button id="tpl-apply-selected-btn" onclick="tplApplySelectedProjects()" style="padding:5px 12px;font-size:11px;font-weight:600;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;border-radius:8px;cursor:pointer;" title="将多选勾选的工程卡片应用为工作区标签（批量表格与工作面板仅同步当前所选）">✅ 应用所选标签</button>
                    <button id="tpl-apply-folder-btn" onclick="tplApplyCurrentFolderProjects()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(99,102,241,0.22);color:#e0e7ff;border:1px solid rgba(129,140,248,0.42);border-radius:8px;cursor:pointer;" title="一键载入当前文件夹直属全部标签到工作面板与批量表格（不识别其他层文件夹）">📂 应用本文件夹</button>
                    <button onclick="saveCurrentAsTemplate()" style="padding:5px 12px;font-size:11px;font-weight:600;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:8px;cursor:pointer;" title="自动识别工作区全部标签页（含后台保留标签与小分组）并保存到工程管理库文件夹">💾 保存当前工程</button>
                    <button id="tpl-update-current-btn" onclick="updateCurrentTemplate()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(245,158,11,0.16);color:#fbbf24;border:1px solid rgba(245,158,11,0.35);border-radius:8px;cursor:pointer;">♻️ 更新当前工程</button>
                    <button id="tpl-repair-thumbnails-btn" onclick="repairDuplicateTemplateThumbnails()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(14,165,233,0.15);color:#7dd3fc;border:1px solid rgba(14,165,233,0.35);border-radius:8px;cursor:pointer;">📸 修复重复封面</button>
                    <button onclick="_importTemplate()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;cursor:pointer;">📥 导入</button>
                    <button onclick="_exportAllTemplates()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.3);border-radius:8px;cursor:pointer;">📤 导出全部</button>
                    <button id="tpl-select-all-btn" onclick="tplSelectAllTemplates()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(59,130,246,0.14);color:#93c5fd;border:1px solid rgba(59,130,246,0.34);border-radius:8px;cursor:pointer;">☑ 全选</button>
                    <button id="tpl-save-selected-presets-btn" onclick="tplSaveSelectedPresets()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(16,185,129,0.16);color:#6ee7b7;border:1px solid rgba(16,185,129,0.36);border-radius:8px;cursor:pointer;">💾 保存所选预设</button>
                    <span id="tpl-selected-count" style="font-size:10px;color:#94a3b8;white-space:nowrap;">未选择</span>
                    <span id="tpl-current-template-label" style="max-width:170px;font-size:10px;color:#777;white-space:normal;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-height:1.45;min-height:2.9em;"></span>
                    `}
                    <button id="tpl-library-close" aria-label="关闭工程管理库" onclick="document.getElementById('template-library-modal').style.display='none'" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:4px 8px;position:absolute;right:12px;top:12px;">✕</button>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 24px;border-bottom:1px solid rgba(255,255,255,.06);">
                <div style="position:relative;flex:1 1 260px;max-width:530px;min-width:180px;">
                    <span aria-hidden="true" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#94a3b8;font-size:15px;">⌕</span>
                    <input id="tpl-search-input" type="search" autocomplete="off" aria-label="搜索工程或文件夹" placeholder="搜索工程/文件夹名称或关键词（支持跨文件夹）" oninput="_templateSearchChanged(this.value)" onkeydown="if(event.key==='Escape'){event.stopPropagation();_clearTemplateSearch();}" style="box-sizing:border-box;width:100%;padding:9px 37px 9px 36px;background:#111827;color:#f8fafc;border:1px solid #475569;border-radius:9px;outline:none;font-size:13px;" />
                    <button id="tpl-search-clear" onclick="_clearTemplateSearch()" title="清空搜索" aria-label="清空工程搜索" style="display:none;position:absolute;right:9px;top:50%;transform:translateY(-50%);border:0;background:transparent;color:#cbd5e1;cursor:pointer;font-size:18px;">×</button>
                </div>
                <span id="tpl-search-result" aria-live="polite" style="font-size:12px;color:#94a3b8;white-space:nowrap;"></span>
                <span style="margin-left:auto;font-size:11px;color:#64748b;">💡 勾选多张工程标签卡片点「应用所选标签」或点「应用本文件夹」，工作面板与批量表格仅同步当前文件夹本级标签</span>
            </div>
            <div style="display:flex;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:6px;padding:10px 24px;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px;color:#bbb;">
                <button id="tpl-folder-home" data-folder-id="" onclick="_openTemplateFolder('')" title="点击返回主工程库，或将工程/文件夹拖到这里" style="background:#ffffff08;border:1px dashed #ffffff35;border-radius:7px;padding:6px 10px;color:#cbd5e1;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">${_templateHomeIcon()}<span>主工程库</span></button>
                <div id="tpl-breadcrumbs" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1;min-width:120px;"></div>
                <span id="tpl-folder-path" style="display:none;"></span>
                <button id="tpl-move-to-root" onclick="_moveSelectedTemplatesToRoot()" style="background:#ffffff0a;color:#ddd;border:1px solid #ffffff20;border-radius:6px;padding:5px 9px;cursor:pointer;">移到上级</button>
            </div>
            <div id="tpl-workspace-banner" style="display:none;padding:10px 24px;border-bottom:1px solid rgba(16,185,129,0.22);background:linear-gradient(90deg,rgba(16,185,129,0.12),rgba(99,102,241,0.12));flex-shrink:0;"></div>
            <div id="tpl-grid-container" style="flex:1;overflow-y:auto;padding:20px 24px;">
                <div style="color:#666;text-align:center;padding:60px 0;">加载中...</div>
            </div>
        </div>
    `;

    // 点击遮罩关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });

    modal.addEventListener('wheel', event => {
        if (!event.ctrlKey || !event.deltaY) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        _setTemplateZoom(_getTemplateZoom() + (event.deltaY < 0 ? 5 : -5));
    }, {passive:false, capture:true});
    document.body.appendChild(modal);
    _initTemplateLibrarySizing(modal);
    _updateCurrentTemplateButton();
    _refreshTemplateList();
    if (!isPicker && typeof window.reelsSyncWorkspaceTabsBackToLibraryFolder === 'function') {
        window.reelsSyncWorkspaceTabsBackToLibraryFolder({ silent: true, onlyDirty: true, autoCreateNew: !!window.reelsGetWorkspaceLibraryStatus?.().folderId })
            .then(res => { if (res && (res.updated || res.created)) _refreshTemplateList(); })
            .catch(() => {});
    }
}
window.openTemplateLibrary = openTemplateLibrary;
window.openProjectLibrary = openTemplateLibrary;
window.reelsRefreshTemplateLibraryIfOpen = function() {
    const modal = document.getElementById('template-library-modal');
    if (modal && getComputedStyle(modal).display !== 'none') {
        _refreshTemplateList();
    }
};

function _toggleTemplateCardSelection(id) {
    const modal = document.getElementById('template-library-modal');
    if (!modal || modal._onSelectCallback || !id) return;
    const selected = modal._selectedTemplateIds || (modal._selectedTemplateIds = new Set());
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    _paintTemplateSelection();
}

async function _fetchLibraryTemplatesFull(ids) {
    const cleanIds = [...new Set((ids || []).map(v => String(v || '').trim()).filter(Boolean))];
    if (!cleanIds.length) return [];
    try {
        const resp = await apiFetch(`${API_BASE}/templates/get-many`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: cleanIds }),
        });
        const parsed = await resp.json();
        const items = parsed.data || parsed;
        if (Array.isArray(items) && items.length) return items;
    } catch (_) {}
    const out = [];
    for (const id of cleanIds) {
        try {
            const resp = await apiFetch(`${API_BASE}/templates/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id }),
            });
            const parsed = await resp.json();
            const item = parsed.data || parsed;
            if (item && item.projectData) out.push(item);
        } catch (err) {
            console.warn('[ProjectLibrary] 读取工程失败:', id, err);
        }
    }
    return out;
}

async function _applyLibraryIdsToWorkspace(ids, options = {}) {
    const cleanIds = [...new Set((ids || []).map(v => String(v || '').trim()).filter(Boolean))];
    if (!cleanIds.length) return false;
    const modal = document.getElementById('template-library-modal');
    const allSummaries = modal?._allTemplateSummaries || [];
    const summaryMap = new Map(allSummaries.map(s => [String(s.id), s]));
    const fullList = await _fetchLibraryTemplatesFull(cleanIds);
    const fullMap = new Map(fullList.map(item => [String(item.id), item]));
    const entries = cleanIds.map(id => {
        const tplData = fullMap.get(id);
        if (!tplData || !tplData.projectData) return null;
        return { tplData, summary: summaryMap.get(id) || { id, name: tplData.name, updatedAt: tplData.updatedAt } };
    }).filter(Boolean);
    if (!entries.length) {
        if (typeof showToast === 'function') showToast('所选工程缺少工程数据，无法载入', 'warning');
        return false;
    }

    const folderId = typeof options.folderId === 'string' ? options.folderId : (_tplFolderId || '');
    const folderPath = options.folderPath || _buildTemplateFolderPathText(folderId);
    const folderDirectCount = Number(options.folderTotalCount) || allSummaries.filter(t => (_tplFolderData.assignments[t.id] || '') === folderId).length || entries.length;
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

    const first = entries[0].tplData;
    if (entries.length === 1) _setCurrentTemplateContext(first.id, first.name);
    else _setCurrentTemplateContext('', '');

    if (modal && options.closeModal !== false) modal.style.display = 'none';
    if (typeof openPanelByName === 'function') openPanelByName('batch-reels');
    if (typeof showToast === 'function') {
        showToast(`✅ 已应用「${folderPath}」中的 ${entries.length} 个工程标签（工作区与表格仅识别当前选定范围）`, 'success', 4500);
    }
    return true;
}

async function tplApplySelectedProjects() {
    const modal = document.getElementById('template-library-modal');
    if (!modal || modal._onSelectCallback) return;
    const selected = modal._selectedTemplateIds || new Set();
    const visibleOrder = (modal._templateSummaries || []).map(t => String(t.id));
    const ids = visibleOrder.filter(id => selected.has(id));
    if (!ids.length) {
        if (typeof showToast === 'function') showToast('请先勾选要应用的工程标签卡片', 'info');
        return;
    }
    const visibleDirectCount = (modal._templateSummaries || []).length;
    const folderId = _tplSearchTerm.trim()
        ? (_tplFolderData.assignments[ids[0]] || '')
        : _tplFolderId;
    const folderTotalCount = _tplSearchTerm.trim()
        ? (modal._allTemplateSummaries || []).filter(t => (_tplFolderData.assignments[t.id] || '') === folderId).length
        : visibleDirectCount;
    const scopeMode = (!_tplSearchTerm.trim() && ids.length >= visibleDirectCount && !!folderId) ? 'folder' : 'selected';
    await _applyLibraryIdsToWorkspace(ids, { folderId, folderTotalCount, scopeMode });
}

async function tplApplyCurrentFolderProjects() {
    await window.reelsApplyFolderById(_tplFolderId);
}

window.reelsApplyFolderById = async function(targetFolderId = '') {
    const folderId = String(targetFolderId || '').trim();
    const listResp = await apiFetch(`${API_BASE}/templates/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const listParsed = await listResp.json();
    const allTemplates = listParsed.data || listParsed || [];
    const foldersData = await _templateFolderRequest('list');
    _tplFolderData = { folders: [], assignments: {}, folderOrders: {}, ...foldersData };

    const directTemplates = _sortTemplateSummaries(allTemplates.filter(t => (_tplFolderData.assignments[t.id] || '') === folderId));
    const keyOrder = _tplFolderData.folderOrders?.[folderId || ''] || (folderId ? [] : _tplFolderData.libraryOrder) || [];
    const orderedTemplates = (localStorage.getItem('videokit_template_sort') || 'manual') === 'manual' && Array.isArray(keyOrder) && keyOrder.length
        ? (() => {
            const rank = new Map(keyOrder.map((k, i) => [k, i]));
            return [...directTemplates].sort((a, b) => (rank.get('t:' + a.id) ?? -1) - (rank.get('t:' + b.id) ?? -1));
        })()
        : directTemplates;

    if (!orderedTemplates.length) {
        if (typeof showToast === 'function') showToast('该文件夹当前没有直属工程标签（仅直属工程会被识别，不跨级拉取子文件夹）', 'info');
        return false;
    }
    const modal = document.getElementById('template-library-modal');
    if (modal) modal._allTemplateSummaries = allTemplates;
    return await _applyLibraryIdsToWorkspace(orderedTemplates.map(t => t.id), {
        folderId,
        folderPath: _buildTemplateFolderPathText(folderId, _tplFolderData.folders),
        folderTotalCount: orderedTemplates.length,
        scopeMode: 'folder',
    });
};

async function _refreshTemplateList() {
    _closeTemplateContextMenu();
    const modal = document.getElementById('template-library-modal');
    const container = document.getElementById('tpl-grid-container');
    const badge = document.getElementById('tpl-count-badge');
    if (!container || !modal) return;
    
    const isPicker = !!modal._onSelectCallback;

    try {
        const resp = await apiFetch(`${API_BASE}/templates/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const parsed = await resp.json();
        const allTemplates = _sortTemplateSummaries(parsed.data || parsed || []);
        const rawFolders = await _templateFolderRequest('list');
        _tplFolderData = { folders: [], assignments: {}, folderOrders: {}, ...(rawFolders || {}) };
        if (typeof window !== 'undefined') {
            if (!window._reelsLibraryThumbCache || typeof window._reelsLibraryThumbCache !== 'object') {
                window._reelsLibraryThumbCache = {};
            }
            for (const tpl of allTemplates) {
                if (tpl?.id && tpl.thumbnail) window._reelsLibraryThumbCache[tpl.id] = tpl.thumbnail;
            }
        }
        if (_tplFolderId && !_tplFolderData.folders.some(f => f.id === _tplFolderId)) _tplFolderId = '';
        const query = _tplSearchTerm.trim();
        const searching = !!query;
        const templates = searching
            ? allTemplates.filter(t => _templateMatchesSearch(t, query, _buildTemplateFolderPathText(_tplFolderData.assignments[t.id] || '')))
            : allTemplates.filter(t => (_tplFolderData.assignments[t.id] || '') === _tplFolderId);
        const childFoldersRaw = searching
            ? []
            : _tplFolderData.folders.filter(f => (f.parentId || '') === _tplFolderId);
        const folders = _sortTemplateSummaries(childFoldersRaw.map(folder => {
            const descIds = _collectTplDescendantFolderIds(folder.id, _tplFolderData.folders);
            return {
                ...folder,
                templateType: '文件夹',
                sizeBytes: allTemplates.filter(t => descIds.has(_tplFolderData.assignments[t.id] || '')).reduce((n, t) => n + (t.sizeBytes || 0), 0),
            };
        }));

        const folderChain = _getTemplateFolderChain(_tplFolderId, _tplFolderData.folders);
        const currentFolder = folderChain[folderChain.length - 1] || null;
        const parentFolderId = currentFolder?.parentId || '';
        const moveOutBtn = document.getElementById('tpl-move-to-root');
        if (moveOutBtn) {
            moveOutBtn.style.display = currentFolder ? '' : 'none';
            moveOutBtn.textContent = parentFolderId ? '移出到上级' : '移出到主库';
        }
        const homeBtn = document.getElementById('tpl-folder-home');
        if (homeBtn) {
            homeBtn.dataset.folderId = '';
            homeBtn.innerHTML = _templateHomeIcon() + '<span>主工程库</span>';
        }
        const bcEl = document.getElementById('tpl-breadcrumbs');
        if (bcEl) {
            bcEl.innerHTML = folderChain.map((f, idx) => {
                const isLast = idx === folderChain.length - 1;
                return `<span style="color:#64748b;">›</span><button class="tpl-breadcrumb-chip ${isLast ? 'is-current' : ''}" data-folder-id="${_tplEscapeHtml(f.id)}" title="${isLast ? '当前文件夹' : '点击进入此文件夹，或将工程/文件夹拖到这里'}">${_tplEscapeHtml(f.name)}</button>`;
            }).join('');
        }
        const legacyPath = document.getElementById('tpl-folder-path');
        if (legacyPath) legacyPath.textContent = folderChain.length ? ' / ' + folderChain.map(f => f.name).join(' / ') : '';

        modal._allTemplateSummaries = allTemplates;
        _syncTemplateSortControls();
        modal._templateSummaries = templates;
        if (!modal._selectedTemplateIds) modal._selectedTemplateIds = new Set();
        const availableIds = new Set(allTemplates.map(tpl => String(tpl.id)));
        [...modal._selectedTemplateIds].forEach(id => { if (!availableIds.has(String(id))) modal._selectedTemplateIds.delete(id); });
        _renderWorkspaceAutoSaveBanner(availableIds, isPicker);
        _updateCurrentTemplateButton();

        badge.textContent = searching
            ? `找到 ${templates.length} / ${allTemplates.length} 个工程`
            : (_tplFolderId ? `本级 ${folders.length ? folders.length + ' 文件夹 · ' : ''}${templates.length} 个工程` : `共 ${allTemplates.length} 个工程`);
        const searchStatus = document.getElementById('tpl-search-result');
        if (searchStatus) searchStatus.textContent = searching ? `全库搜索 · ${templates.length} 个结果` : '';
        const searchInput = document.getElementById('tpl-search-input');
        if (searchInput && searchInput.value !== _tplSearchTerm) searchInput.value = _tplSearchTerm;
        const searchClear = document.getElementById('tpl-search-clear');
        if (searchClear) searchClear.style.display = searching ? '' : 'none';

        const titleEl = document.getElementById('tpl-lib-title');
        if (titleEl) titleEl.textContent = isPicker ? '选择工程模板' : '工程管理库';

        const applyFolderBtn = document.getElementById('tpl-apply-folder-btn');
        if (applyFolderBtn) {
            applyFolderBtn.disabled = searching || templates.length === 0;
            applyFolderBtn.style.opacity = (!searching && templates.length > 0) ? '1' : '0.45';
            applyFolderBtn.style.cursor = (!searching && templates.length > 0) ? 'pointer' : 'not-allowed';
            applyFolderBtn.textContent = _tplFolderId ? `📂 应用本级全部(${templates.length})` : `📂 应用主库直属(${templates.length})`;
        }

        if (!searching && templates.length === 0 && folders.length === 0 && !_tplFolderId) {
            container.innerHTML = `
                <div style="text-align:center;padding:80px 0;color:#555;">
                    <div style="font-size:48px;margin-bottom:16px;opacity:0.4;">🗂️</div>
                    <p style="font-size:14px;margin:0;">工程管理库还没有保存任何工程</p>
                    ${isPicker ? '' : '<p style="font-size:12px;color:#444;margin-top:6px;">点击上方「📁 新建文件夹」建多级目录，或点「💾 保存当前工程」开始</p>'}
                </div>
            `;
            _updateTemplatePresetSelectionUI();
            return;
        }

        if (searching && templates.length === 0) {
            container.innerHTML = `<div style="padding:65px 20px;text-align:center;color:#94a3b8;"><div style="font-size:30px;margin-bottom:12px;">⌕</div><div>没有找到匹配的工程</div><div style="font-size:12px;margin-top:10px;">尝试缩短关键词，或清空搜索查看全部工程</div><button onclick="_clearTemplateSearch()" style="margin-top:18px;padding:8px 16px;background:#334155;color:#fff;border:0;border-radius:8px;cursor:pointer;">清空搜索</button></div>`;
            _updateTemplatePresetSelectionUI();
            return;
        }

        const activeWorkspaceIds = typeof window.reelsGetWorkspaceLibraryTemplateIds === 'function'
            ? window.reelsGetWorkspaceLibraryTemplateIds()
            : new Set();

        let html = `<div id="tpl-card-grid" style="--tpl-card-size:${_getTemplateCardSize()}px;--tpl-scale:${_getTemplateZoom()/100};display:grid;grid-template-columns:repeat(auto-fill,minmax(0,min(max(96px,var(--tpl-card-size)),100%)));grid-auto-rows:1px;grid-auto-flow:row dense;column-gap:${Math.max(2,Math.round(12*_getTemplateZoom()/100))}px;row-gap:0;justify-content:start;align-items:start;">`;
        html += folders.map(folder => _renderTemplateFolderCard(folder, allTemplates)).join('');
        if (!searching && !templates.length && _tplFolderId) {
            html += `<div style="grid-column:1/-1;text-align:center;color:#888;padding:34px;">${folders.length ? '当前文件夹下有子文件夹，暂无直属工程标签。' : '这个文件夹还没有工程标签，可新建子文件夹、保存当前工程或拖入卡片。'}</div>`;
        }
        for (const tpl of templates) {
            const thumbSrc = tpl.thumbnail || '';
            const dateStr = tpl.updatedAt ? new Date(tpl.updatedAt).toLocaleDateString('zh-CN') : '';
            const taskInfo = tpl.taskCount ? `${tpl.taskCount} 个任务` : '';
            const safeId = _tplEscapeHtml(tpl.id);
            const safeName = _tplEscapeHtml(tpl.name || '');
            const safeThumb = _tplEscapeHtml(thumbSrc);
            const safeDate = _tplEscapeHtml(dateStr);
            const safeTaskInfo = _tplEscapeHtml(taskInfo);
            const folderPathBadge = searching
                ? `<span style="color:#a5b4fc;font-size:10px;white-space:normal;overflow-wrap:anywhere;">📂 ${_tplEscapeHtml(_buildTemplateFolderPathText(_tplFolderData.assignments[tpl.id] || ''))}</span>`
                : '';
            const isDisabledPick = isPicker && modal._pickerDisabledIds && modal._pickerDisabledIds.has(tpl.id);
            const isWorkspaceActive = !isPicker && activeWorkspaceIds.has(String(tpl.id));
            const thumbHtml = thumbSrc
                ? `<img draggable="false" src="${safeThumb}" style="width:100%;height:100%;object-fit:cover;" />`
                : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:36px;">🎬</div>`;

            const actionsHtml = isPicker ? `
                <div class="tpl-actions" style="position:absolute;top:8px;right:8px;left:8px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;opacity:0;transition:opacity 0.2s;background:rgba(0,0,0,0.7);padding:6px;border-radius:8px;">
                    <button data-action="pick" ${isDisabledPick ? 'disabled' : ''} style="padding:4px 12px;font-size:12px;font-weight:600;background:${isDisabledPick ? 'rgba(120,120,130,0.35)' : 'linear-gradient(135deg,#7c5cff,#a855f7)'};color:${isDisabledPick ? '#999' : '#fff'};border:none;border-radius:6px;cursor:${isDisabledPick ? 'not-allowed' : 'pointer'};">${isDisabledPick ? '已添加' : '✅ 选用此工程'}</button>
                </div>
            ` : '';

            html += `
                <div class="tpl-card" draggable="true" title="单击选择 / 勾选多选 · 双击载入到工作区 · 右键菜单" data-id="${safeId}" data-name="${safeName}" data-disabled-pick="${isDisabledPick ? 'true' : 'false'}" style="background:rgba(255,255,255,${isDisabledPick ? '0.018' : '0.03'});border:1px solid ${isDisabledPick ? 'rgba(120,120,130,0.28)' : 'rgba(255,255,255,0.06)'};border-radius:12px;overflow:hidden;cursor:${isDisabledPick ? 'not-allowed' : 'pointer'};transition:all 0.2s;position:relative;${isDisabledPick ? 'opacity:0.58;' : ''}"
                     onmouseenter="this.style.borderColor='rgba(99,102,241,0.4)';this.style.transform='translateY(-2px)'"
                     onmouseleave="this.style.borderColor='rgba(255,255,255,0.06)';this.style.transform='none'">
                    <div class="tpl-template-cover" style="width:100%;aspect-ratio:9/16;background:#0a0a1a;overflow:hidden;">
                        ${thumbHtml}
                    </div>
                    ${!isPicker ? `<button type="button" class="tpl-card-check" data-id="${safeId}" title="勾选/取消多选此工程标签" aria-label="多选"></button>` : ''}
                    ${isWorkspaceActive ? '<div style="position:absolute;right:8px;top:8px;z-index:3;background:rgba(16,185,129,0.92);color:#041e13;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;">工作区</div>' : ''}
                    ${isDisabledPick ? '<div style="position:absolute;left:8px;top:8px;background:rgba(16,185,129,0.9);color:#06150f;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;">已添加</div>' : ''}
                    <div class="tpl-card-info" style="padding:10px 8px;background:#242424;">
                        <div class="tpl-name" style="font-size:calc(12px * var(--tpl-scale,1));font-weight:500;color:#eeeeee;text-align:center;white-space:normal;overflow:visible;overflow-wrap:anywhere;word-break:break-word;display:block;line-height:1.5;" title="${safeName}">${safeName}</div>
                        <div class="tpl-meta" style="font-size:calc(10px * var(--tpl-scale,1));color:#888;margin-top:calc(8px * var(--tpl-scale,1));padding-top:calc(7px * var(--tpl-scale,1));border-top:1px solid rgba(255,255,255,0.07);display:flex;flex-direction:column;align-items:center;text-align:center;gap:calc(3px * var(--tpl-scale,1));line-height:1.4;">
                            <span style="white-space:nowrap;">${safeDate}</span>
                            <span style="white-space:nowrap;">${safeTaskInfo}</span>
                            ${folderPathBadge}
                        </div>
                    </div>
                    ${actionsHtml}
                </div>
            `;
        }
        html += '</div>';
        const savedScroll = container._tplRenderedFolder === _tplFolderId && container._tplRenderedSearch === query ? container.scrollTop : 0;
        container.innerHTML = html;
        const folderOrderKey = _tplFolderId || '';
        const manualOrderList = _tplFolderData.folderOrders?.[folderOrderKey] || (!_tplFolderId ? _tplFolderData.libraryOrder : null);
        if (!searching && (localStorage.getItem('videokit_template_sort') || 'manual') === 'manual' && Array.isArray(manualOrderList) && manualOrderList.length) {
            const grid = container.querySelector('#tpl-card-grid');
            const rank = new Map(manualOrderList.map((id, i) => [id, i]));
            if (grid) {
                Array.from(grid.children).filter(el => el.matches('.tpl-card,.tpl-folder-card')).sort((a, b) => (rank.get(_templateLibraryItemKey(a)) ?? -1) - (rank.get(_templateLibraryItemKey(b)) ?? -1)).forEach(card => grid.appendChild(card));
            }
        }

        _bindTemplateFolderCards(container);
        container.oncontextmenu = event => { if (event.target.closest('.tpl-card,.tpl-folder-card,button,input,select,[contenteditable]')) return; event.preventDefault(); event.stopPropagation(); _showTemplateBlankMenu(event); };
        container.querySelectorAll('.tpl-card').forEach(card => {
            if (isPicker) {
                card.addEventListener('mouseenter', () => card.querySelector('.tpl-actions').style.opacity = '1');
                card.addEventListener('mouseleave', () => card.querySelector('.tpl-actions').style.opacity = '0');
            } else {
                card.addEventListener('contextmenu', event => {
                    if (event.target.isContentEditable) return;
                    event.preventDefault(); event.stopPropagation(); _showTemplateContextMenu(event, card);
                });
                card.querySelector('.tpl-card-check')?.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    _toggleTemplateCardSelection(card.dataset.id || '');
                });
            }
            
            card.querySelector('.tpl-actions')?.addEventListener('click', async (e) => {
                const btn = e.target.closest('button[data-action]');
                if (!btn) return;
                e.stopPropagation();
                const id = card.dataset.id || '';
                const name = card.dataset.name || '';
                const action = btn.dataset.action;
                
                if (action === 'pick') {
                    if (btn.disabled || card.dataset.disabledPick === 'true') return;
                    btn.textContent = '加载中...';
                    try {
                        const r = await apiFetch(`${API_BASE}/templates/get`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id}) });
                        const res = await r.json();
                        const tplData = res.data || res;
                        if (modal._onSelectCallback) {
                            modal._onSelectCallback(tplData);
                        }
                        btn.textContent = '✅ 已添加';
                        btn.style.background = 'rgba(16,185,129,0.8)';
                        setTimeout(() => {
                            btn.textContent = '✅ 选用此工程';
                            btn.style.background = 'linear-gradient(135deg,#7c5cff,#a855f7)';
                        }, 1500);
                    } catch(err) {
                        alert('读取工程失败');
                        btn.textContent = '✅ 选用此工程';
                    }
                }
                else if (action === 'load') _loadTemplateInCurrentWindow(id);
                else if (action === 'window') _openTemplateInWindow(id, name);
                else if (action === 'export') _exportTemplate(id, name);
                else if (action === 'export_archive') _exportArchiveTemplate(id, name);
                else if (action === 'move-root') await _moveTemplateIds([id], _getParentFolderId(_tplFolderId));
                else if (action === 'rename') _renameTemplate(id);
                else if (action === 'delete') _deleteTemplate(id, name);
            });
            
            card.querySelector('.tpl-name')?.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); _renameTemplate(card.dataset.id); });
            card.addEventListener('dblclick', async () => {
                const id = card.dataset.id;
                if (isPicker) {
                    if (card.dataset.disabledPick === 'true') return;
                    try {
                        const r = await apiFetch(`${API_BASE}/templates/get`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id}) });
                        const res = await r.json();
                        if (modal._onSelectCallback) modal._onSelectCallback(res.data || res);
                    } catch(err) {}
                } else {
                    await _loadTemplateInCurrentWindow(id);
                }
            });
        });

        if (!searching) _initTemplateReordering(container);
        _initTemplateMarquee(container);
        _bindTemplateMixedGridLayout(container);
        _paintTemplateSelection();
        _updateTemplatePresetSelectionUI();
        container._tplRenderedFolder = _tplFolderId;
        container._tplRenderedSearch = query;
        container.scrollTop = savedScroll;

    } catch (e) {
        container.innerHTML = `<div style="color:#f87171;text-align:center;padding:40px;">加载失败: ${_tplEscapeHtml(e?.message || String(e))}</div>`;
    }
}

function _updateTemplatePresetSelectionUI() {
    const modal = document.getElementById('template-library-modal');
    if (!modal || modal._onSelectCallback) return;
    const selected = modal._selectedTemplateIds || new Set();
    const visibleIds = (modal._templateSummaries || []).map(tpl => String(tpl.id));
    const visibleSelectedCount = visibleIds.filter(id => selected.has(id)).length;
    const total = visibleIds.length;
    const count = selected.size;
    const label = document.getElementById('tpl-selected-count');
    const allButton = document.getElementById('tpl-select-all-btn');
    const saveButton = document.getElementById('tpl-save-selected-presets-btn');
    const applySelectedBtn = document.getElementById('tpl-apply-selected-btn');
    if (label) label.textContent = count ? `已选 ${count} / ${total}` : '未选择';
    if (allButton) {
        allButton.textContent = visibleIds.length && visibleIds.every(id => selected.has(id)) ? '☐ 取消全选' : '☑ 全选';
    }
    if (applySelectedBtn) {
        applySelectedBtn.disabled = visibleSelectedCount === 0;
        applySelectedBtn.style.opacity = visibleSelectedCount ? '1' : '.48';
        applySelectedBtn.style.cursor = visibleSelectedCount ? 'pointer' : 'not-allowed';
        applySelectedBtn.textContent = visibleSelectedCount ? `✅ 应用所选标签(${visibleSelectedCount})` : '✅ 应用所选标签';
    }
    if (saveButton) {
        saveButton.disabled = count === 0;
        saveButton.style.opacity = count ? '1' : '.48';
        saveButton.style.cursor = count ? 'pointer' : 'not-allowed';
    }
}

function tplSelectAllTemplates() {
    const modal = document.getElementById('template-library-modal');
    if (!modal || modal._onSelectCallback) return;
    const templates = modal._templateSummaries || [];
    const selected = modal._selectedTemplateIds || (modal._selectedTemplateIds = new Set());
    const visibleIds = new Set(templates.map(tpl => String(tpl.id)));
    const allVisibleSelected = visibleIds.size > 0 && [...visibleIds].every(id => selected.has(id));
    if (allVisibleSelected) visibleIds.forEach(id => selected.delete(id));
    else visibleIds.forEach(id => selected.add(id));
    _paintTemplateSelection();
    _updateTemplatePresetSelectionUI();
}

async function tplSaveSelectedPresets() {
    const modal = document.getElementById('template-library-modal');
    if (!modal || modal._onSelectCallback) return;
    const selected = [...(modal._selectedTemplateIds || [])];
    if (!selected.length) return;
    const groupName = await (typeof _showInputDialog === 'function'
        ? _showInputDialog('预设保存分组', '例如：九月祷告、金色字幕', '我的预设')
        : Promise.resolve(prompt('输入预设分组名称：', '我的预设')));
    const category = String(groupName || '').trim();
    if (!category) return;
    if (!confirm(`将 ${selected.length} 个模板中的动态字幕和覆层分别保存到分组「${category}」？\n\n同名预设会自动重命名，不会修改原模板或已有预设。`)) return;

    const button = document.getElementById('tpl-save-selected-presets-btn');
    if (button) { button.disabled = true; button.textContent = '保存中…'; }
    let subtitles = 0, overlays = 0, failed = 0;
    for (const id of selected) {
        try {
            const resp = await apiFetch(`${API_BASE}/templates/get`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
            });
            const parsed = await resp.json();
            const template = parsed.data || parsed;
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
    _updateTemplatePresetSelectionUI();
    const message = `已保存到「${category}」：动态字幕 ${subtitles} 个、覆层 ${overlays} 个${failed ? `；${failed} 个失败` : ''}`;
    if (typeof showToast === 'function') showToast(message, failed ? 'warning' : 'success', 5000);
    else alert(message);
}

// ═══════════════════════════════════════════════════════
// 2. 保存当前工程为模板
// ═══════════════════════════════════════════════════════

/** 为队列生成稳定短编号；同一路径/标签在不同日期保存仍保持一致。 */
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

function _templateIdForQueue(baseName, queueIdentity) {
    return `tpl_queue_${_templateQueueShortId(`${baseName}|${queueIdentity}`)}`;
}

function _captureVisibleTemplateThumbnail() {
    let thumbnail = '';
    try {
        // V2 使用独立 Canvas。优先截取当前正在显示的预览，
        // 同时保留旧预览回退，避免已有模板流程受影响。
        const v2 = window.ReelsPreviewV2;
        const canvas = (v2?.isOpen?.() ? v2.getCanvas?.() : null)
            || document.getElementById('reels-preview-canvas');
        if (canvas) {
            // 创建缩略图 canvas（270×480，9:16）
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = 270;
            thumbCanvas.height = 480;
            const ctx = thumbCanvas.getContext('2d');
            ctx.drawImage(canvas, 0, 0, 270, 480);
            thumbnail = thumbCanvas.toDataURL('image/jpeg', 0.65);
        }
    } catch (e) {
        console.warn('[Template] 截图失败:', e);
    }
    return thumbnail;
}

async function _captureTemplateThumbnailForTasks(tasks, fallbackThumbnail = '') {
    const state = window._reelsState;
    if (!state || !Array.isArray(tasks) || tasks.length === 0) return fallbackThumbnail;
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
        // 等待图片/视频元数据和 Canvas 至少完成一次实际绘制。
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

async function _repairTemplateThumbnailsByIds(templateIds, options = {}) {
    const ids = [...new Set((templateIds || []).filter(Boolean))];
    if (!ids.length) return { repaired: 0, failed: 0 };
    const button = document.getElementById('tpl-repair-thumbnails-btn');
    const originalText = button?.textContent || '';
    if (button) button.disabled = true;
    let repaired = 0;
    let failed = 0;
    try {
        for (let i = 0; i < ids.length; i++) {
            if (button) button.textContent = `📸 ${i + 1}/${ids.length}`;
            try {
                const getResp = await apiFetch(`${API_BASE}/templates/get`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ids[i] })
                });
                const getResult = await getResp.json();
                const tpl = getResult.data || getResult;
                const tasks = JSON.parse(JSON.stringify(tpl?.projectData?.tasks || []));
                if (!tasks.length) throw new Error('模板没有任务');
                const thumbnail = await _captureTemplateThumbnailForTasks(tasks, tpl.thumbnail || '');
                if (!thumbnail) throw new Error('未能生成截图');
                const saveResp = await apiFetch(`${API_BASE}/templates/thumbnail`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: tpl.id,
                        name: tpl.name,
                        description: tpl.description || '',
                        tags: tpl.tags || [],
                        thumbnail,
                    }),
                });
                const saveResult = await saveResp.json();
                if (!(saveResult.success || saveResult.data?.success)) throw new Error(saveResult.error || '保存失败');
                repaired++;
            } catch (error) {
                failed++;
                console.warn(`[Template] 修复模板封面失败 ${ids[i]}:`, error);
            }
        }
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText || '📸 修复重复封面';
        }
        if (repaired > 0 && typeof window.reelsOnLibraryFolderChanged === 'function') {
            window.reelsOnLibraryFolderChanged([], { skipWorkspaceSync: true });
        }
        if (document.getElementById('template-library-modal')) _refreshTemplateList();
    }
    if (!options.silent && typeof showToast === 'function') {
        showToast(`已重新生成 ${repaired} 张工程封面${failed ? `，${failed} 张失败` : ''}`, failed ? 'warning' : 'success', 6000);
    }
    return { repaired, failed };
}
window.captureTemplateThumbnailForTasks = _captureTemplateThumbnailForTasks;

async function repairDuplicateTemplateThumbnails() {
    try {
        const resp = await apiFetch(`${API_BASE}/templates/list`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        const parsed = await resp.json();
        const templates = parsed.data || parsed || [];
        const byThumbnail = new Map();
        templates.forEach(tpl => {
            const key = String(tpl.thumbnail || '');
            if (!key) return;
            if (!byThumbnail.has(key)) byThumbnail.set(key, []);
            byThumbnail.get(key).push(tpl.id);
        });
        const duplicateIds = [...byThumbnail.values()].filter(group => group.length > 1).flat();
        if (!duplicateIds.length) {
            if (typeof showToast === 'function') showToast('没有检测到重复模板封面', 'info');
            return;
        }
        if (!confirm(`检测到 ${duplicateIds.length} 个模板共用了重复封面。\n\n是否逐模板重新生成独立截图？`)) return;
        await _repairTemplateThumbnailsByIds(duplicateIds);
    } catch (error) {
        if (typeof showToast === 'function') showToast(`修复模板封面失败：${error.message}`, 'error');
    }
}
window.repairDuplicateTemplateThumbnails = repairDuplicateTemplateThumbnails;
window._repairTemplateThumbnailsByIds = _repairTemplateThumbnailsByIds;

function _captureCurrentTemplatePayload(name) {
    // 截取当前 Canvas 预览作为缩略图
    const thumbnail = _captureVisibleTemplateThumbnail();

    // 用 ReelsProject.collectProjectData 序列化工程
    let projectData = {};
    try {
        if (typeof collectCurrentProjectState === 'function') {
            const state = collectCurrentProjectState();
            projectData = ReelsProject.collectProjectData(state);
        } else if (typeof ReelsProject !== 'undefined') {
            // 尝试直接收集
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

    return {
        name,
        thumbnail,
        projectData,
    };
}

function _makeUniqueTemplatePresetName(baseName, existingNames) {
    const occupied = existingNames instanceof Set ? existingNames : new Set(existingNames || []);
    if (!occupied.has(baseName)) return baseName;
    let index = 2;
    let candidate = `${baseName}（${index}）`;
    while (occupied.has(candidate)) candidate = `${baseName}（${++index}）`;
    return candidate;
}

// 模板工程内的样式/覆层是快照；用户选择同步时，再生成可跨工程调用的独立预设。
// 同名不覆盖已有“我的预设”，而是自动创建带序号的新预设。
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
            const layerTypes = [...new Set(layers.map(layer => ({ text:'纯文本', textcard:'文字卡片', scroll:'滚动字幕', image:'图片媒体', video:'视频媒体', solid_mask:'纯色蒙版' })[layer.type] || '其他覆层'))];
            const presetName = _makeUniqueTemplatePresetName(`${templateName} · 覆层`, new Set(Object.keys(saved)));
            saved[presetName] = { name:presetName, layers, updatedAt:new Date().toISOString(), meta:{ layerCount:layers.length, category, layerTypes, needsBatchText:layers.some(layer => !layer.fixed_text && ['text','textcard','scroll'].includes(layer.type)) } };
            localStorage.setItem(key, JSON.stringify(saved));
            result.overlay = true;
        } catch (error) { console.warn('[Template] 同步覆层预设失败:', error); }
    }
    return result;
}

let _tplDismissedBannerSig = '';
let _tplArchivingInProgress = false;

function _renderWorkspaceAutoSaveBanner(availableIds, isPicker) {
    const banner = document.getElementById('tpl-workspace-banner');
    if (!banner) return;
    if (isPicker || typeof window.reelsGetWorkspaceSaveCandidateInfo !== 'function') {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }
    const info = window.reelsGetWorkspaceSaveCandidateInfo(availableIds);
    const sig = `${info.totalGroups}|${info.unarchivedGroups.length}|${info.unarchivedTasks}|${info.unarchivedGroups.slice(0, 6).map(g => g.key).join(',')}`;
    if (!info.unarchivedGroups.length || _tplDismissedBannerSig === sig) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }

    const previewText = info.previewNames.join(' · ') + (info.unarchivedGroups.length > info.previewNames.length ? ` 等 ${info.unarchivedGroups.length} 个` : '');
    const hasSubGroups = info.groupNames.length > 0;
    const inSubfolder = !!_tplFolderId;

    banner.style.display = 'flex';
    banner.style.alignItems = 'center';
    banner.style.justifyContent = 'space-between';
    banner.style.gap = '10px';
    banner.style.flexWrap = 'wrap';
    banner.innerHTML = `
        <div style="flex:1 1 280px;min-width:220px;">
            <div style="font-size:12.5px;color:#ecfdf5;font-weight:600;line-height:1.4;">
                ⚡ 检测到工作区共有 <b style="color:#6ee7b7;">${info.unarchivedGroups.length}</b> 个未入库工程标签（${info.unarchivedTasks} 条任务${hasSubGroups ? ` · ${info.groupNames.length} 个小分组` : ''}）
            </div>
            <div style="font-size:11px;color:#a5b4fc;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_tplEscapeHtml(previewText)}">
                已识别标签：${_tplEscapeHtml(previewText)}
            </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <input id="tpl-auto-archive-name" type="text" value="${_tplEscapeHtml(info.suggestedName)}" placeholder="目标工程文件夹名..." style="width:170px;padding:5px 9px;background:#0f172a;color:#f8fafc;border:1px solid rgba(129,140,248,0.45);border-radius:7px;font-size:11.5px;outline:none;" />
            ${hasSubGroups ? `<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#ddd6fe;cursor:pointer;white-space:nowrap;" title="把各标签的小分组自动建成二级子文件夹"><input type="checkbox" id="tpl-auto-archive-split-groups" checked style="accent-color:#8b5cf6;">按小分组建子文件夹</label>` : ''}
            <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#cbd5e1;cursor:pointer;white-space:nowrap;" title="自动渲染截取各标签封面图"><input type="checkbox" id="tpl-auto-archive-capture-thumbs" checked style="accent-color:#10b981;">生成封面</label>
            <button type="button" id="tpl-auto-archive-btn" style="padding:6px 13px;font-size:11.5px;font-weight:700;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;border-radius:7px;cursor:pointer;white-space:nowrap;">✨ 一键自动保存并管理</button>
            ${inSubfolder ? '<button type="button" id="tpl-auto-archive-here-btn" style="padding:6px 11px;font-size:11px;font-weight:600;background:rgba(99,102,241,0.22);color:#e0e7ff;border:1px solid rgba(129,140,248,0.45);border-radius:7px;cursor:pointer;white-space:nowrap;" title="不新建外层目录，直接存入当前打开的文件夹">存入当前文件夹</button>' : ''}
            <button type="button" id="tpl-auto-archive-dismiss-btn" style="padding:4px 8px;font-size:11px;background:transparent;color:#94a3b8;border:1px solid rgba(148,163,184,0.28);border-radius:6px;cursor:pointer;">暂不提示</button>
        </div>
    `;

    const runArchive = async (folderMode) => {
        const nameInput = document.getElementById('tpl-auto-archive-name');
        const folderName = String(nameInput?.value || info.suggestedName || '工作区工程').trim() || '工作区工程';
        const splitGroups = !!document.getElementById('tpl-auto-archive-split-groups')?.checked;
        const captureThumbs = document.getElementById('tpl-auto-archive-capture-thumbs')?.checked !== false;
        await reelsAutoArchiveWorkspaceToLibrary({
            folderMode,
            folderName,
            parentFolderId: _tplFolderId || '',
            splitByGroup: splitGroups,
            captureThumbnails: captureThumbs,
            bindWorkspace: true,
        });
    };

    banner.querySelector('#tpl-auto-archive-btn')?.addEventListener('click', () => runArchive('new-folder'));
    banner.querySelector('#tpl-auto-archive-here-btn')?.addEventListener('click', () => runArchive('current-folder'));
    banner.querySelector('#tpl-auto-archive-dismiss-btn')?.addEventListener('click', () => {
        _tplDismissedBannerSig = sig;
        banner.style.display = 'none';
    });
}

async function _ensureLibraryFolder(parentId, desiredName, existingFolders, options = {}) {
    const cleanParent = String(parentId || '').trim();
    const cleanBase = String(desiredName || '新建工程文件夹').trim().slice(0, 180) || '新建工程文件夹';
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
    const res = await _templateFolderRequest('create', { name: candidateName, parentId: cleanParent });
    const created = res.folder || res;
    if (created && created.id && Array.isArray(existingFolders)) {
        existingFolders.push(created);
    }
    return created;
}

async function _reorderLibraryFolderTail(folderId, newlyOrderedCardIds = []) {
    if (!newlyOrderedCardIds.length) return;
    try {
        const [foldersRes, listResp] = await Promise.all([
            _templateFolderRequest('list'),
            apiFetch(`${API_BASE}/templates/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
        ]);
        const foldersParsed = foldersRes || { folders: [], assignments: {}, folderOrders: {} };
        const listParsed = await listResp.json();
        const allTemplates = listParsed.data || listParsed || [];
        const cleanParent = String(folderId || '').trim();
        const childFolders = (foldersParsed.folders || []).filter(f => f && (f.parentId || '') === cleanParent);
        const directTemplates = allTemplates.filter(t => t && (foldersParsed.assignments?.[t.id] || '') === cleanParent);
        const prevOrder = foldersParsed.folderOrders?.[cleanParent] || (!cleanParent ? foldersParsed.libraryOrder : []) || [];
        const prevRank = new Map((Array.isArray(prevOrder) ? prevOrder : []).map((k, idx) => [k, idx]));
        const newRank = new Map(newlyOrderedCardIds.map((id, idx) => [String(id), idx]));

        const folderKeys = [...childFolders]
            .sort((a, b) => (prevRank.get('f:' + a.id) ?? Number.MAX_SAFE_INTEGER) - (prevRank.get('f:' + b.id) ?? Number.MAX_SAFE_INTEGER))
            .map(f => 'f:' + f.id);
        const existingCardKeys = directTemplates
            .filter(t => !newRank.has(String(t.id)))
            .sort((a, b) => (prevRank.get('t:' + a.id) ?? Number.MAX_SAFE_INTEGER) - (prevRank.get('t:' + b.id) ?? Number.MAX_SAFE_INTEGER))
            .map(t => 't:' + t.id);
        const newCardKeys = newlyOrderedCardIds
            .filter(id => directTemplates.some(t => String(t.id) === String(id)))
            .map(id => 't:' + id);
        const fullOrder = [...folderKeys, ...existingCardKeys, ...newCardKeys];
        if (fullOrder.length > 0) {
            await _templateFolderRequest('reorder', { order: fullOrder, parentId: cleanParent });
        }
    } catch (err) {
        console.warn('[ProjectLibrary] 保留标签排序失败（不影响已保存数据）:', err);
    }
}

async function _archiveGroupsToLibrary(groups, options = {}) {
    const validGroups = (Array.isArray(groups) ? groups : []).filter(g => g && Array.isArray(g.tasks) && g.tasks.length > 0);
    if (!validGroups.length) throw new Error('没有可保存的非空工程标签');

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

    const foldersRes = await _templateFolderRequest('list');
    const foldersList = Array.isArray(foldersRes?.folders) ? [...foldersRes.folders] : [];
    const listResp = await apiFetch(`${API_BASE}/templates/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const listParsed = await listResp.json();
    const allTemplates = listParsed.data || listParsed || [];
    const existingById = new Map(allTemplates.map(t => [String(t.id), t]));
    const assignments = foldersRes?.assignments || {};

    let rootFolderId = String(options.parentFolderId ?? (_tplFolderId || '')).trim();
    if (options.folderMode !== 'current-folder') {
        const createdRoot = await _ensureLibraryFolder(rootFolderId, options.folderName || '新建工程', foldersList, { reuseExisting: false });
        rootFolderId = String(createdRoot?.id || '').trim();
    }

    const folderMapByGroup = new Map();
    const hasGroups = options.splitByGroup !== false && validGroups.some(g => String(g.group || '').trim());
    if (hasGroups) {
        for (const g of validGroups) {
            const gName = String(g.group || '').trim();
            if (!gName || folderMapByGroup.has(gName)) continue;
            const sub = await _ensureLibraryFolder(rootFolderId, gName, foldersList, { reuseExisting: true });
            if (sub?.id) folderMapByGroup.set(gName, sub.id);
        }
    }

    const activeSelectedTask = window._reelsState?.tasks?.[window._reelsState?.selectedIdx];
    const activeTabId = typeof _batchTableState !== 'undefined' ? _batchTableState.activeTabId : '';
    const usedNamesPerFolder = new Map();
    const getUsedSet = (fId) => {
        const key = String(fId || '');
        if (!usedNamesPerFolder.has(key)) {
            const existingNames = allTemplates
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

        const projectData = ReelsProject.collectProjectData({
            tasks: group.tasks,
            backgroundLibrary: sharedBgLib,
            style: sharedGlobalStyle,
            exportOpts: sharedExportOpts,
            watermarks: sharedWatermarks,
            selectedIdx: group.tasks.length ? 0 : -1,
        });

        try {
            const saveBody = {
                ...(existingInSameFolder ? { id: existingLibId } : {}),
                name: finalName,
                description: group.group ? `分组：${group.group}` : '',
                folderId: targetFolderId,
                thumbnail: thumb,
                projectData,
            };
            const resp = await apiFetch(`${API_BASE}/templates/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(saveBody),
            });
            const parsed = await resp.json();
            const res = parsed.data || parsed;
            if (!res?.success && !res?.id) throw new Error(res?.error || parsed?.error || '保存失败');
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
        await _reorderLibraryFolderTail(fId, cardIds);
    }

    const folderPaths = {};
    const folderCounts = {};
    const updatedFoldersRes = await _templateFolderRequest('list');
    const latestFolders = updatedFoldersRes?.folders || foldersList;
    const latestAssign = updatedFoldersRes?.assignments || {};
    const touchedFolderIds = new Set([rootFolderId, ...savedResults.map(r => r.libraryFolderId)]);
    for (const fId of touchedFolderIds) {
        folderPaths[fId] = _buildTemplateFolderPathText(fId, latestFolders);
        folderCounts[fId] = Object.values(latestAssign).filter(v => String(v || '') === String(fId || '')).length;
    }

    if (options.bindWorkspace && typeof window.reelsBindSavedGroupsToWorkspace === 'function') {
        window.reelsBindSavedGroupsToWorkspace(savedResults, {
            rootFolderId,
            rootFolderPath: folderPaths[rootFolderId] || '主工程库',
            rootFolderDirectCount: folderCounts[rootFolderId] || savedResults.length,
            folderPaths,
            folderCounts,
        });
    }

    return {
        rootFolderId,
        rootFolderPath: folderPaths[rootFolderId] || '主工程库',
        savedResults,
        failed,
        syncedSubtitle,
        syncedOverlay,
        folderCountCreated: folderMapByGroup.size + (options.folderMode !== 'current-folder' ? 1 : 0),
    };
}

async function reelsAutoArchiveWorkspaceToLibrary(options = {}) {
    if (_tplArchivingInProgress) return false;
    const groups = typeof window.reelsCollectWorkspaceProjectGroups === 'function'
        ? window.reelsCollectWorkspaceProjectGroups()
        : [];
    if (!groups.length) {
        showToast?.('当前工作区没有可保存的非空任务标签', 'info');
        return false;
    }

    _tplArchivingInProgress = true;
    const mainBtn = document.getElementById('tpl-auto-archive-btn');
    const hereBtn = document.getElementById('tpl-auto-archive-here-btn');
    const origMainText = mainBtn?.textContent || '';
    const origHereText = hereBtn?.textContent || '';
    if (mainBtn) mainBtn.disabled = true;
    if (hereBtn) hereBtn.disabled = true;

    try {
        const res = await _archiveGroupsToLibrary(groups, {
            folderMode: options.folderMode || 'new-folder',
            folderName: options.folderName || `工作区工程_${new Date().toISOString().slice(0, 10)}`,
            parentFolderId: options.parentFolderId ?? (_tplFolderId || ''),
            splitByGroup: options.splitByGroup !== false,
            captureThumbnails: options.captureThumbnails !== false,
            bindWorkspace: options.bindWorkspace !== false,
            syncPresetAssets: !!options.syncPresetAssets,
            onProgress: (done, total) => {
                const txt = `⏳ 保存并生成封面 ${done}/${total}...`;
                if (options.folderMode === 'current-folder' && hereBtn) hereBtn.textContent = txt;
                else if (mainBtn) mainBtn.textContent = txt;
            },
        });
        _tplFolderId = res.rootFolderId;
        if (res.savedResults.length === 1) {
            _setCurrentTemplateContext(res.savedResults[0].libraryTemplateId, res.savedResults[0].name);
        } else {
            _setCurrentTemplateContext('', '');
        }
        window.reelsOnLibraryFolderChanged?.([res.rootFolderId].filter(Boolean), { skipWorkspaceSync: true });
        await _refreshTemplateList();
        showToast?.(
            `✅ 已自动识别并保存 ${res.savedResults.length} 个标签到「${res.rootFolderPath}」${res.failed.length ? `（${res.failed.length} 个失败）` : '，可直接勾选或管理应用'}`,
            res.failed.length ? 'warning' : 'success',
            5000
        );
        return true;
    } catch (err) {
        showToast?.(`自动保存失败：${err.message}`, 'error');
        return false;
    } finally {
        _tplArchivingInProgress = false;
        if (mainBtn) { mainBtn.disabled = false; mainBtn.textContent = origMainText || '✨ 一键自动保存并管理'; }
        if (hereBtn) { hereBtn.disabled = false; hereBtn.textContent = origHereText || '存入当前文件夹'; }
    }
}
window.reelsAutoArchiveWorkspaceToLibrary = reelsAutoArchiveWorkspaceToLibrary;

function _showSaveWorkspaceProjectModal(info, groups) {
    return new Promise(resolve => {
        const inFolderLabel = _tplFolderId ? _buildTemplateFolderPathText(_tplFolderId) : '主工程库';
        const hasSubGroups = info.groupNames.length > 0;
        const ov = document.createElement('div');
        ov.id = 'tpl-save-workspace-modal';
        ov.style.cssText = 'position:fixed;inset:0;z-index:400100;background:rgba(4,7,18,0.82);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:16px;';
        ov.innerHTML = `
            <div style="background:#14182b;border:1px solid rgba(129,140,248,0.42);border-radius:14px;padding:18px 20px;width:min(490px,94vw);color:#e2e8f0;box-shadow:0 24px 60px rgba(0,0,0,0.75);display:flex;flex-direction:column;gap:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <h3 style="margin:0;font-size:15.5px;color:#fff;">💾 保存当前工作区工程到管理库</h3>
                    <button type="button" id="tsw-close" style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;">✕</button>
                </div>
                <div style="font-size:12px;color:#cbd5e1;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.28);border-radius:8px;padding:9px 11px;line-height:1.55;">
                    已自动识别工作区 <b>${groups.length}</b> 个标签页（共 <b>${info.totalTasks}</b> 条任务${hasSubGroups ? ` · 含 <b>${info.groupNames.length}</b> 个小分组` : ''}）：<br>
                    <span style="color:#a5b4fc;font-size:11px;">${_tplEscapeHtml(groups.slice(0, 6).map(g => g.name).join(' · ') + (groups.length > 6 ? ` 等 ${groups.length} 个` : ''))}</span>
                </div>
                <div>
                    <div style="font-size:11.5px;color:#94a3b8;margin-bottom:5px;">工程文件夹 / 名称（将保存于「${_tplEscapeHtml(inFolderLabel)}」）：</div>
                    <input type="text" id="tsw-folder-name" value="${_tplEscapeHtml(info.suggestedName)}" style="width:100%;box-sizing:border-box;padding:8px 10px;background:#0b1020;color:#fff;border:1px solid #475569;border-radius:8px;font-size:13px;outline:none;" />
                </div>
                <div style="display:flex;flex-direction:column;gap:7px;font-size:12px;color:#cbd5e1;">
                    <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
                        <input type="radio" name="tsw-mode" value="new-folder" checked style="accent-color:#8b5cf6;">
                        <span>在「${_tplEscapeHtml(inFolderLabel)}」下新建同名工程文件夹并归档</span>
                    </label>
                    <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
                        <input type="radio" name="tsw-mode" value="current-folder" style="accent-color:#8b5cf6;">
                        <span>直接保存到「${_tplEscapeHtml(inFolderLabel)}」当前目录</span>
                    </label>
                    ${hasSubGroups ? `<label style="display:flex;align-items:center;gap:7px;cursor:pointer;margin-top:2px;">
                        <input type="checkbox" id="tsw-split-groups" checked style="accent-color:#10b981;">
                        <span>按小分组（${_tplEscapeHtml(info.groupNames.slice(0, 3).join('、'))}${info.groupNames.length > 3 ? '…' : ''}）自动建二级子文件夹</span>
                    </label>` : ''}
                    <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
                        <input type="checkbox" id="tsw-bind-ws" checked style="accent-color:#10b981;">
                        <span>保存后自动绑定当前工作区，直接在工程库管理与应用</span>
                    </label>
                    <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
                        <input type="checkbox" id="tsw-capture-thumbs" checked style="accent-color:#10b981;">
                        <span>自动截取并生成各标签封面缩略图</span>
                    </label>
                    <label style="display:flex;align-items:center;gap:7px;cursor:pointer;color:#94a3b8;">
                        <input type="checkbox" id="tsw-sync-presets" style="accent-color:#6366f1;">
                        <span>同时把字幕样式与覆层导出为独立“我的预设”</span>
                    </label>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">
                    <button type="button" id="tsw-cancel" style="padding:7px 14px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;font-size:12px;cursor:pointer;">取消</button>
                    <button type="button" id="tsw-confirm" style="padding:7px 18px;border-radius:8px;border:none;background:linear-gradient(135deg,#6366f1,#10b981);color:#fff;font-size:12px;font-weight:700;cursor:pointer;">✨ 确认保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(ov);
        const input = ov.querySelector('#tsw-folder-name');
        input?.focus();
        input?.select();
        const done = (val) => { ov.remove(); resolve(val); };
        ov.querySelector('#tsw-close').onclick = () => done(null);
        ov.querySelector('#tsw-cancel').onclick = () => done(null);
        ov.addEventListener('click', e => { if (e.target === ov) done(null); });
        ov.querySelector('#tsw-confirm').onclick = () => {
            const folderMode = ov.querySelector('input[name="tsw-mode"]:checked')?.value || 'new-folder';
            const folderName = String(input?.value || '').trim();
            if (folderMode === 'new-folder' && !folderName) {
                input?.focus();
                return;
            }
            done({
                folderMode,
                folderName: folderName || info.suggestedName || '新建工程',
                splitByGroup: !!ov.querySelector('#tsw-split-groups')?.checked,
                bindWorkspace: ov.querySelector('#tsw-bind-ws')?.checked !== false,
                captureThumbnails: ov.querySelector('#tsw-capture-thumbs')?.checked !== false,
                syncPresetAssets: !!ov.querySelector('#tsw-sync-presets')?.checked,
            });
        };
    });
}

async function _resolveTemplateSaveFolderId() {
    if (_tplFolderId) return _tplFolderId;
    const modal = document.getElementById('template-library-modal');
    if (modal && getComputedStyle(modal).display !== 'none') return '';
    const activeWorkspaceFolder = typeof window.reelsGetWorkspaceLibraryStatus === 'function'
        ? (window.reelsGetWorkspaceLibraryStatus().folderId || '')
        : '';
    if (activeWorkspaceFolder) return activeWorkspaceFolder;
    if (_currentTemplateContext.id) {
        const folders = await _templateFolderRequest('list');
        return folders.assignments?.[_currentTemplateContext.id] || '';
    }
    return '';
}

async function saveCurrentAsTemplate() {
    if (_tplArchivingInProgress) return;
    const groups = typeof window.reelsCollectWorkspaceProjectGroups === 'function'
        ? window.reelsCollectWorkspaceProjectGroups()
        : [];
    const info = typeof window.reelsGetWorkspaceSaveCandidateInfo === 'function'
        ? window.reelsGetWorkspaceSaveCandidateInfo()
        : { totalGroups: groups.length, totalTasks: groups.reduce((s, g) => s + (g.tasks?.length || 0), 0), groupNames: [], suggestedName: `工作区工程_${new Date().toISOString().slice(0, 10)}` };

    if (groups.length > 1) {
        const opts = await _showSaveWorkspaceProjectModal(info, groups);
        if (!opts) return;
        _tplArchivingInProgress = true;
        try {
            showToast?.(`正在识别并保存 ${groups.length} 个标签页，请稍候...`, 'info');
            const res = await _archiveGroupsToLibrary(groups, {
                folderMode: opts.folderMode,
                folderName: opts.folderName,
                parentFolderId: _tplFolderId || '',
                splitByGroup: opts.splitByGroup,
                bindWorkspace: opts.bindWorkspace,
                captureThumbnails: opts.captureThumbnails,
                syncPresetAssets: opts.syncPresetAssets,
            });
            _tplFolderId = res.rootFolderId;
            _setCurrentTemplateContext('', '');
            window.reelsOnLibraryFolderChanged?.([res.rootFolderId].filter(Boolean), { skipWorkspaceSync: true });
            await _refreshTemplateList();
            showToast?.(
                `✅ 已保存 ${res.savedResults.length} 个工程标签到「${res.rootFolderPath}」${opts.syncPresetAssets ? `；同步字幕 ${res.syncedSubtitle}、覆层 ${res.syncedOverlay}` : ''}${res.failed.length ? `（${res.failed.length} 个失败）` : ''}`,
                res.failed.length ? 'warning' : 'success',
                5000
            );
        } catch (e) {
            showToast?.('保存工程失败: ' + e.message, 'error');
        } finally {
            _tplArchivingInProgress = false;
        }
        return;
    }

    const saveFolderId = await _resolveTemplateSaveFolderId();
    const defaultSingleName = (groups[0]?.name && groups[0].name !== '默认' && groups[0].name !== '未命名标签')
        ? groups[0].name
        : `工程_${new Date().toLocaleDateString('zh-CN')}`;
    const name = await (typeof _showInputDialog === 'function'
        ? _showInputDialog('保存当前工程', '请输入工程卡片名称', defaultSingleName)
        : prompt('请输入工程卡片名称：', defaultSingleName));
    if (!name || !name.trim()) return;

    try {
        const baseName = name.trim();
        const basePayload = _captureCurrentTemplatePayload(baseName);
        basePayload.folderId = saveFolderId;
        const singleGroup = groups[0]
            ? [{ ...groups[0], name: baseName, thumbnail: basePayload.thumbnail }]
            : [{ key: 'single', tabId: '', name: baseName, group: '', hidden: false, tasks: basePayload.projectData?.tasks || [], thumbnail: basePayload.thumbnail }];
        const res = await _archiveGroupsToLibrary(singleGroup, {
            folderMode: 'current-folder',
            parentFolderId: saveFolderId,
            splitByGroup: false,
            bindWorkspace: true,
            captureThumbnails: true,
            syncPresetAssets: false,
            style: basePayload.projectData?.style,
            exportOpts: basePayload.projectData?.exportOpts,
            backgroundLibrary: basePayload.projectData?.backgroundLibrary,
            watermarks: basePayload.projectData?.watermarks,
        });
        const saved = res.savedResults[0];
        if (saved?.libraryTemplateId) {
            _setCurrentTemplateContext(saved.libraryTemplateId, saved.name);
        }
        window.reelsOnLibraryFolderChanged?.(saveFolderId ? [saveFolderId] : [], { skipWorkspaceSync: true });
        showToast?.(`工程「${saved?.name || baseName}」已保存并绑定 ✅`, 'success');
        _refreshTemplateList();
    } catch (e) {
        showToast?.('保存工程失败: ' + e.message, 'error');
    }
}

async function updateCurrentTemplate() {
    if (!_currentTemplateContext.id) {
        if (typeof showToast === 'function') showToast('请先从模板库载入一个模板，再更新当前模板', 'warning');
        else alert('请先从模板库载入一个模板，再更新当前模板');
        return;
    }

    const name = _currentTemplateContext.name || _currentTemplateContext.id;
    if (!confirm(`确定用当前工程覆盖模板「${name}」？`)) return;

    try {
        const payload = _captureCurrentTemplatePayload(name);
        delete payload.folderId; // Updating content must never move an existing template.
        const resp = await apiFetch(`${API_BASE}/templates/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...payload,
                id: _currentTemplateContext.id,
            }),
        });
        const result = await resp.json();
        if (result.success || result.data?.success) {
            if (payload.thumbnail) {
                window._reelsLibraryThumbCache = window._reelsLibraryThumbCache || {};
                window._reelsLibraryThumbCache[_currentTemplateContext.id] = payload.thumbnail;
            }
            window.reelsOnLibraryFolderChanged?.([], { skipWorkspaceSync: true });
            if (typeof showToast === 'function') showToast(`工程「${name}」已更新 ✅`, 'success');
            _refreshTemplateList();
        } else {
            throw new Error(result.error || '更新失败');
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('更新模板失败: ' + e.message, 'error');
        else alert('更新模板失败: ' + e.message);
    }
}

// ═══════════════════════════════════════════════════════
// 3. 打开模板（新窗口 / 当前窗口）
// ═══════════════════════════════════════════════════════

async function _openTemplateInWindow(templateId, templateName) {
    if (window.electronAPI?.openTemplateWindow) {
        try {
            const result = await window.electronAPI.openTemplateWindow(templateId, templateName);
            if (result?.reused) {
                if (typeof showToast === 'function') showToast(`模板「${templateName}」窗口已聚焦`, 'info');
            }
        } catch (e) {
            console.error('[Template] 打开窗口失败:', e);
            // Fallback: 当前窗口加载
            _loadTemplateInCurrentWindow(templateId);
        }
    } else {
        // 浏览器模式：当前窗口加载
        _loadTemplateInCurrentWindow(templateId);
    }
}

async function _loadTemplateInCurrentWindow(templateId, options = {}) {
    try {
        if (typeof window.reelsApplyLibraryProjects === 'function' && !window.location?.hash?.startsWith('#template=')) {
            const modal = document.getElementById('template-library-modal');
            const summary = (modal?._allTemplateSummaries || []).find(t => String(t.id) === String(templateId));
            const assignedFolder = _tplFolderData?.assignments?.[templateId];
            const targetFolderId = typeof options.folderId === 'string'
                ? options.folderId
                : (assignedFolder !== undefined ? assignedFolder : (_tplFolderId || ''));
            const folderTotalCount = (modal?._allTemplateSummaries || []).filter(t => (_tplFolderData.assignments[t.id] || '') === targetFolderId).length || 1;
            const resp = await apiFetch(`${API_BASE}/templates/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: templateId }),
            });
            const result = await resp.json();
            const tplData = result.data || result;
            if (result.error || !tplData.projectData) throw new Error(result.error || '工程缺少数据');
            const ok = await window.reelsApplyLibraryProjects([{ tplData, summary: summary || { id: tplData.id, name: tplData.name, updatedAt: tplData.updatedAt } }], {
                folderId: targetFolderId,
                folderPath: _buildTemplateFolderPathText(targetFolderId),
                folderTotalCount,
                scopeMode: folderTotalCount <= 1 && targetFolderId ? 'folder' : (targetFolderId ? 'selected' : 'selected'),
                loadMode: options.append ? 'append' : 'replace',
            });
            if (!ok) return;
            _setCurrentTemplateContext(tplData.id || templateId, tplData.name || '');
            if (modal) modal.style.display = 'none';
            if (typeof openPanelByName === 'function') openPanelByName('batch-reels');
            if (typeof showToast === 'function') showToast(`工程「${tplData.name}」已载入到工作区`, 'success');
            return;
        }

        const resp = await apiFetch(`${API_BASE}/templates/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: templateId }),
        });
        const result = await resp.json();
        const tplData = result.data || result;
        if(result.error || !tplData.projectData)throw new Error(result.error || '工程缺少数据');

        if (tplData.projectData && typeof ReelsProject !== 'undefined') {
            const restored = ReelsProject.applyProjectData(tplData.projectData);
            if (typeof _batchTableState !== 'undefined') {
                const tabId = 'tab_template_' + Date.now();
                _batchTableState.tabs = [{id:tabId,name:tplData.name || '工程',libraryTemplateId:tplData.id || templateId,tasks:[],materialDir:''}];
                _batchTableState.activeTabId = tabId;
                _batchTableState.appliedTabIds = [tabId];
                _batchTableState.openSnapshotTasks = null;
                _batchTableState.selectedRows = new Set();
                for(const task of restored.tasks){task._batchTabId=tabId;task._batchTabName=tplData.name || '工程';task._libraryTemplateId=tplData.id || templateId;}
            }
            if(window._reelsState){
                _reelsState.batchGroupCollapsed={'__reels_existing_tasks__':false};
                _reelsState.folderQueueCollapsed={};
                for(const task of restored.tasks){if(task._batchTabId)_reelsState.batchGroupCollapsed[task._batchTabId]=false;if(task._folderQueueId)_reelsState.folderQueueCollapsed[task._folderQueueId]=false;}
            }
            if (restored.exportOpts?.subtitleStyleScopeVersion !== 2) {
                restored.exportOpts = {...restored.exportOpts, subtitleStyleScopeVersion:2, subtitleStyleScope:'task', subtitleStyleApplyAll:false};
            }
            if (typeof applyRestoredProject === 'function') applyRestoredProject(restored);
            _setCurrentTemplateContext(tplData.id || templateId, tplData.name || '');
            if (typeof showToast === 'function') showToast(`工程「${tplData.name}」已加载`, 'success');
            const modal = document.getElementById('template-library-modal');
            if (modal) modal.style.display = 'none';
            if (typeof openPanelByName === 'function') openPanelByName('batch-reels');
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('加载工程失败: ' + e.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════
// 4. 删除 / 重命名
// ═══════════════════════════════════════════════════════

async function _deleteTemplate(id, name) {
    if (!confirm(`确定删除工程「${name}」？此操作不可恢复。`)) return;
    const prevFolder = _tplFolderData?.assignments?.[id] || _tplFolderId || '';
    try {
        await apiFetch(`${API_BASE}/templates/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        if (_currentTemplateContext.id === id) {
            _setCurrentTemplateContext('', '');
        }
        if (typeof showToast === 'function') showToast(`工程「${name}」已删除`, 'success');
        window.reelsOnLibraryFolderChanged?.(prevFolder ? [prevFolder] : []);
        _refreshTemplateList();
    } catch (e) {
        if (typeof showToast === 'function') showToast('删除失败: ' + e.message, 'error');
    }
}

async function _renameTemplate(id) {
    const card = Array.from(document.querySelectorAll('.tpl-card')).find(card => card.dataset.id === id);
    const title = card?.querySelector('.tpl-name');
    if (!title) return;
    _editTemplateNameInPlace(title, async name => {
        const response = await apiFetch(`${API_BASE}/templates/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name }) });
        const parsed = await response.json(), result = parsed.data || parsed;
        if (parsed.error || result.error || result.success === false) throw new Error(parsed.error || result.error || '重命名失败');
        if (_currentTemplateContext.id === id) _setCurrentTemplateContext(id, name);
        _updateRenamedLibraryCard('template', id, name);
        const fId = _tplFolderData?.assignments?.[id] || _tplFolderId || '';
        window.reelsOnLibraryFolderChanged?.(fId ? [fId] : []);
    });
}

// ═══════════════════════════════════════════════════════
// 4b. 导入 / 导出模板文件
// ═══════════════════════════════════════════════════════

/**
 * 导出模板为 .vktpl 文件
 */
async function _exportTemplate(id, name) {
    try {
        const resp = await apiFetch(`${API_BASE}/templates/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        const result = await resp.json();
        const tplData = result.data || result;

        // 导出完整数据（含缩略图）
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

        const jsonStr = JSON.stringify(exportObj, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name || 'template'}.vktpl`;
        a.click();
        URL.revokeObjectURL(url);

        if (typeof showToast === 'function') showToast(`模板「${name}」已导出`, 'success');
    } catch (e) {
        if (typeof showToast === 'function') showToast('导出失败: ' + e.message, 'error');
        else alert('导出失败: ' + e.message);
    }
}

/**
 * 打包导出模板及关联的本地素材 (归档)
 */
async function _exportArchiveTemplate(id, name) {
    try {
        if (typeof showToast === 'function') showToast(`正在收集素材并打包，请稍候...`, 'info');
        const resp = await apiFetch(`${API_BASE}/templates/export-archive`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        const result = await resp.json();
        const zipPath = result.data ? result.data.zip_path : result.zip_path;
        if (zipPath && window.electronAPI && window.electronAPI.showItemInFolder) {
            window.electronAPI.showItemInFolder(zipPath);
            if (typeof showToast === 'function') showToast(`打包完成！已在文件夹中显示。`, 'success');
        } else if (zipPath) {
            if (typeof showToast === 'function') showToast(`打包完成: ${zipPath}`, 'success');
        } else {
            throw new Error(result.error || '打包失败');
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('打包失败: ' + e.message, 'error');
        else alert('打包失败: ' + e.message);
    }
}

/**
 * 导入 .vktpl 或 .vkpkg 模板文件
 */
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
                    style: sharedStyle,
                    exportOpts: sharedExportOpts,
                    watermarks: sharedWatermarks,
                    backgroundLibrary: sharedBgLib,
                    items: [{
                        name: data.name || only.name || fallbackName,
                        description: data.description || (only.group ? `分组：${only.group}` : ''),
                        thumbnail: data.thumbnail || only.thumbnail || '',
                        tags: data.tags || [],
                        projectData: ReelsProject.collectProjectData({
                            tasks: only.tasks,
                            backgroundLibrary: sharedBgLib,
                            style: sharedStyle,
                            exportOpts: sharedExportOpts,
                            watermarks: sharedWatermarks,
                            selectedIdx: 0,
                        }),
                    }],
                };
            }
            return {
                mode: nonEmptyTabs.length > 1 ? 'multi-tab' : 'single',
                style: sharedStyle,
                exportOpts: sharedExportOpts,
                watermarks: sharedWatermarks,
                backgroundLibrary: sharedBgLib,
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
                style: sharedStyle,
                exportOpts: sharedExportOpts,
                watermarks: sharedWatermarks,
                backgroundLibrary: sharedBgLib,
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
            return {
                mode: 'single',
                style: sharedStyle,
                exportOpts: sharedExportOpts,
                watermarks: sharedWatermarks,
                backgroundLibrary: sharedBgLib,
                items: [data],
            };
        }
        if (typeof ReelsProject !== 'undefined') {
            return {
                mode: 'single',
                style: sharedStyle,
                exportOpts: sharedExportOpts,
                watermarks: sharedWatermarks,
                backgroundLibrary: sharedBgLib,
                items: [{
                    name: data.name || (split.grouped ? split.tabs[0]?.name : fallbackName) || fallbackName,
                    description: data.description || '',
                    thumbnail: data.thumbnail || '',
                    tags: data.tags || [],
                    projectData: ReelsProject.collectProjectData({
                        tasks: inner.tasks,
                        backgroundLibrary: sharedBgLib,
                        style: sharedStyle,
                        exportOpts: sharedExportOpts,
                        watermarks: sharedWatermarks,
                        selectedIdx: 0,
                    }),
                }],
            };
        }
    }

    if (data.projectData) {
        return { mode: 'single', items: [data] };
    }
    return null;
}
window.reelsExtractTabsFromProjectPayload = _extractTabsFromProjectPayload;

async function _importTemplate() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vktpl,.json,.vkpkg';
    input.multiple = true;
    input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        let imported = 0;
        for (const file of files) {
            if (file.name.endsWith('.vkpkg')) {
                const filePath = window.electronAPI ? window.electronAPI.getFilePath(file) : '';
                if (!filePath) {
                    if (typeof showToast === 'function') showToast(`跳过 ${file.name}: 无法获取本地路径`, 'warning');
                    continue;
                }
                try {
                    if (typeof showToast === 'function') showToast(`正在导入归档包 ${file.name}...`, 'info');
                    const resp = await apiFetch(`${API_BASE}/templates/import-archive`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ zip_path: filePath }),
                    });
                    const result = await resp.json();
                    if (result.id || (result.data && result.data.id)) {
                        imported++;
                    }
                } catch (err) {
                    if (typeof showToast === 'function') showToast(`导入失败 ${file.name}: ` + err.message, 'error');
                }
                continue;
            }

            try {
                const text = await file.text();
                const data = JSON.parse(text);

                const fileBaseName = file.name.replace(/\.(vktpl|json)$/i, '').trim() || '导入工程';
                const extracted = _extractTabsFromProjectPayload(data, fileBaseName);
                if (!extracted || !extracted.items.length) {
                    if (typeof showToast === 'function') showToast(`跳过 ${file.name}: 不是有效的工程/模板文件`, 'warning');
                    else alert(`跳过 ${file.name}: 不是有效的工程/模板文件`);
                    continue;
                }

                if (extracted.mode === 'multi-tab' && extracted.items.length > 1) {
                    const res = await _archiveGroupsToLibrary(extracted.items, {
                        folderMode: 'new-folder',
                        folderName: fileBaseName,
                        parentFolderId: _tplFolderId || '',
                        splitByGroup: true,
                        bindWorkspace: false,
                        captureThumbnails: false,
                        syncPresetAssets: false,
                        style: extracted.style,
                        exportOpts: extracted.exportOpts,
                        watermarks: extracted.watermarks,
                        backgroundLibrary: extracted.backgroundLibrary,
                    });
                    imported += res.savedResults.length;
                    _tplFolderId = res.rootFolderId;
                } else {
                    for (const tpl of extracted.items) {
                        const saveBody = {
                            name: tpl.name || fileBaseName,
                            description: tpl.description || '',
                            thumbnail: tpl.thumbnail || '',
                            tags: tpl.tags || [],
                            folderId: _tplFolderId || '',
                            projectData: tpl.projectData || ReelsProject.collectProjectData({
                                tasks: tpl.tasks || [],
                                backgroundLibrary: extracted.backgroundLibrary || [],
                                style: extracted.style || {},
                                exportOpts: extracted.exportOpts || {},
                                watermarks: extracted.watermarks || [],
                                selectedIdx: 0,
                            }),
                        };
                        const resp = await apiFetch(`${API_BASE}/templates/save`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(saveBody),
                        });
                        const result = await resp.json();
                        if (result.success || result.data?.success) {
                            imported++;
                        }
                    }
                }
            } catch (err) {
                console.error(`[Template] 导入 ${file.name} 失败:`, err);
                if (typeof showToast === 'function') showToast(`导入 ${file.name} 失败: ${err.message}`, 'error');
                else alert(`导入 ${file.name} 失败: ${err.message}`);
            }
        }

        if (imported > 0) {
            window.reelsOnLibraryFolderChanged?.(_tplFolderId ? [_tplFolderId] : []);
            if (typeof showToast === 'function') showToast(`成功导入 ${imported} 个工程 ✅`, 'success');
            else alert(`成功导入 ${imported} 个工程 ✅`);
            _refreshTemplateList();
        }
    };
    input.click();
}

/**
 * 一键导出所有模板
 */
async function _exportAllTemplates() {
    try {
        if (typeof showToast === 'function') showToast('正在准备导出，请稍候...', 'info');
        
        // 1. 获取列表
        const listResp = await apiFetch(`${API_BASE}/templates/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const listParsed = await listResp.json();
        const templatesList = listParsed.data || listParsed || [];
        
        if (templatesList.length === 0) {
            if (typeof showToast === 'function') showToast('没有可导出的模板', 'warning');
            return;
        }

        const fullTemplates = [];
        // 2. 循环获取详情
        for (const tpl of templatesList) {
            const resp = await apiFetch(`${API_BASE}/templates/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: tpl.id }),
            });
            const result = await resp.json();
            const tplData = result.data || result;
            
            fullTemplates.push({
                name: tplData.name,
                description: tplData.description || '',
                thumbnail: tplData.thumbnail || '',
                tags: tplData.tags || [],
                createdAt: tplData.createdAt,
                projectData: tplData.projectData,
            });
        }

        // 3. 构建合集并导出
        const exportObj = {
            _format: 'videokit-template-collection',
            _version: 1,
            exportedAt: Date.now(),
            count: fullTemplates.length,
            templates: fullTemplates
        };

        const jsonStr = JSON.stringify(exportObj, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        a.download = `所有模板_${dateStr}_(${fullTemplates.length}个).vktpl`;
        a.click();
        URL.revokeObjectURL(url);

        if (typeof showToast === 'function') showToast(`成功导出 ${fullTemplates.length} 个模板`, 'success');
    } catch (e) {
        if (typeof showToast === 'function') showToast('全部导出失败: ' + e.message, 'error');
        else alert('全部导出失败: ' + e.message);
    }
}

// ═══════════════════════════════════════════════════════
// 5. 启动时自动检测 hash 参数加载模板
// ═══════════════════════════════════════════════════════

function _checkHashForTemplate() {
    const hash = window.location.hash; // e.g. #template=tpl_xxxxx
    const match = hash.match(/template=([^&]+)/);
    if (!match) {
        // 默认启动不自动弹出视频模板库（由用户点击“模板库”按钮再按需打开）
        return;
    }

    const templateId = match[1];
    console.log('[Template] 检测到 URL hash 模板参数:', templateId);

    // 等 DOM 和 app 初始化完成后加载
    const tryLoad = () => {
        if (typeof ReelsProject === 'undefined' || typeof apiFetch === 'undefined') {
            setTimeout(tryLoad, 200);
            return;
        }
        _loadTemplateInCurrentWindow(templateId);
    };

    // 延迟执行，确保 app.js 已经初始化
    setTimeout(tryLoad, 500);
}

// DOM 加载后检测
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _checkHashForTemplate);
} else {
    _checkHashForTemplate();
}

function _templateLibraryItemKey(card){return card.classList.contains('tpl-folder-card')?'f:'+card.dataset.folderId:'t:'+card.dataset.id;}
function _initTemplateReordering(container){
    const grid=container.querySelector('#tpl-card-grid');if(!grid)return;
    let dragged=null,original=[],moving=[],movingSet=new Set(),kind='',saving=false;
    const cards=()=>Array.from(grid.children).filter(c=>c.matches('.tpl-card,.tpl-folder-card'));
    const restore=()=>original.forEach(card=>grid.appendChild(card));
    const resetOpacity=()=>cards().forEach(card=>card.style.opacity='');
    grid.addEventListener('dragstart',event=>{
        const card=event.target.closest('.tpl-card,.tpl-folder-card');
        if(!card||saving||event.target.closest('button,input,label,[contenteditable]')){event.preventDefault();return;}
        dragged=card;original=cards();kind=card.classList.contains('tpl-folder-card')?'folder':'template';event.dataTransfer.effectAllowed='move';
        if(kind==='folder'){moving=[card];event.dataTransfer.setData('application/x-videokit-folder',card.dataset.folderId);}
        else{
            const modal=document.getElementById('template-library-modal');if(!modal._selectedTemplateIds.has(card.dataset.id)){modal._selectedTemplateIds=new Set([card.dataset.id]);_paintTemplateSelection();}
            moving=original.filter(c=>c.classList.contains('tpl-card')&&modal._selectedTemplateIds.has(c.dataset.id));
            event.dataTransfer.setData('application/x-videokit-templates',JSON.stringify(moving.map(c=>c.dataset.id)));event.dataTransfer.setData('text/plain',card.dataset.id);
        }
        movingSet=new Set(moving);for(const card of moving)card.style.opacity='.45';
    });
    grid.addEventListener('dragover',event=>{
        if(!dragged)return;event.preventDefault();event.dataTransfer.dropEffect='move';
        const target=event.target.closest('.tpl-card,.tpl-folder-card');
        if(kind==='template'&&target?.classList.contains('tpl-folder-card'))return;
        if(target&&!movingSet.has(target)){
            const box=target.getBoundingClientRect(),after=event.clientY>box.bottom||(event.clientY>=box.top&&event.clientX>box.left+box.width/2);
            let reference=after?target.nextSibling:target;while(reference&&movingSet.has(reference))reference=reference.nextSibling;
            for(const card of moving)grid.insertBefore(card,reference);
        }else if(!target&&event.target===grid){const box=grid.lastElementChild?.getBoundingClientRect();if(box&&(event.clientY>box.bottom||(event.clientY>=box.top&&event.clientX>box.right)))for(const card of moving)grid.appendChild(card);}
        const bounds=container.getBoundingClientRect();if(event.clientY<bounds.top+60)container.scrollTop-=24;if(event.clientY>bounds.bottom-60)container.scrollTop+=24;
    });
    grid.addEventListener('drop',async event=>{
        if(!dragged)return;event.preventDefault();event.stopPropagation();
        const folderTarget=event.target.closest('.tpl-folder-card');
        if(kind==='template'&&folderTarget){const ids=moving.map(c=>c.dataset.id);resetOpacity();restore();dragged=null;await _moveTemplateIds(ids,folderTarget.dataset.folderId);return;}
        resetOpacity();dragged=null;const current=cards();if(current.every((card,i)=>card===original[i]))return;saving=true;
        try{
            const order=current.map(_templateLibraryItemKey);
            await _templateFolderRequest('reorder',{order,parentId:_tplFolderId});
            if(!_tplFolderData.folderOrders || typeof _tplFolderData.folderOrders!=='object') _tplFolderData.folderOrders={};
            _tplFolderData.folderOrders[_tplFolderId || '']=order;
            if(!_tplFolderId) _tplFolderData.libraryOrder=order;
            localStorage.setItem('videokit_template_sort','manual');_syncTemplateSortControls();
            window.reelsOnLibraryFolderChanged?.(_tplFolderId ? [_tplFolderId] : []);
        }catch(error){restore();if(typeof showToast==='function')showToast(error.message,'error');}finally{saving=false;}
    });
    grid.addEventListener('dragend',()=>{if(dragged){resetOpacity();restore();dragged=null;}});
}

function _sortTemplateSummaries(items) {
    const mode = localStorage.getItem('videokit_template_sort') || 'manual';
    if (mode === 'manual') return [...items];
    const direction = localStorage.getItem('videokit_template_sort_direction') === 'desc' ? -1 : 1;
    const compare = (a,b) => String(a || '').localeCompare(String(b || ''),'zh-CN',{numeric:true,sensitivity:'base'});
    return [...items].sort((a,b) => direction * (mode === 'name' ? compare(a.name,b.name) : mode === 'type' ? compare(a.templateType,b.templateType) : mode === 'size' ? (Number(a.sizeBytes)||0)-(Number(b.sizeBytes)||0) : (Date.parse(a.updatedAt || a.createdAt)||0)-(Date.parse(b.updatedAt || b.createdAt)||0)));
}
function _syncTemplateSortControls() {
    const mode = localStorage.getItem('videokit_template_sort') || 'manual';
    const select = document.getElementById('tpl-sort-select'); if(select) select.value=mode;
    const button=document.getElementById('tpl-sort-direction');
    if(button) {button.disabled=mode==='manual';button.style.opacity=mode==='manual'?'0.4':'1';button.textContent=localStorage.getItem('videokit_template_sort_direction')==='desc'?'降序 ↓':'升序 ↑';}
}
function _setTemplateSort(mode) {
    localStorage.setItem('videokit_template_sort',mode);
    _refreshTemplateList();
}
function _toggleTemplateSortDirection() {
    localStorage.setItem('videokit_template_sort_direction',localStorage.getItem('videokit_template_sort_direction')==='desc'?'asc':'desc');
    _refreshTemplateList();
}

async function _templateFolderRequest(action,data={}) {
    const response=await apiFetch(`${API_BASE}/templates/folders/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const parsed=await response.json(),result=parsed.data || parsed;
    if(parsed.error || result.error || result.success===false)throw new Error(parsed.error || result.error || '文件夹操作失败');
    return result;
}
function _getParentFolderId(folderId) {
    const f = (_tplFolderData.folders || []).find(item => item.id === folderId);
    return f?.parentId || '';
}

async function _newTemplateFolder(parentOverride) {
    const parentId = typeof parentOverride === 'string' ? parentOverride : _tplFolderId;
    const parentLabel = parentId ? `（位于「${_buildTemplateFolderPathText(parentId)}」）` : '（位于主工程库）';
    const name = typeof _showInputDialog === 'function'
        ? await _showInputDialog(`新建文件夹 ${parentLabel}`, '文件夹名称', '新建文件夹')
        : prompt(`文件夹名称 ${parentLabel}`, '新建文件夹');
    if (!name?.trim()) return;
    try {
        await _templateFolderRequest('create', { name: name.trim(), parentId });
        await _refreshTemplateList();
    } catch (e) {
        showToast?.(e.message, 'error');
    }
}

async function _renameTemplateFolder(id) {
    const card = Array.from(document.querySelectorAll('.tpl-folder-card')).find(card => card.dataset.folderId === id);
    const title = card?.querySelector('.tpl-folder-name');
    if (!title) return;
    _editTemplateNameInPlace(title, async name => {
        await _templateFolderRequest('rename', { id, name });
        _updateRenamedLibraryCard('folder', id, name);
        window.reelsOnLibraryFolderChanged?.([id], { skipWorkspaceSync: false });
    });
}

async function _deleteTemplateFolder(id) {
    const folder = (_tplFolderData.folders || []).find(f => f.id === id);
    const name = folder?.name || '该文件夹';
    if (!confirm(`确定删除空文件夹「${name}」？`)) return;
    try {
        await _templateFolderRequest('delete', { id });
        if (_tplFolderId === id) {
            _tplFolderId = folder?.parentId || '';
        }
        await _refreshTemplateList();
        showToast?.(`文件夹「${name}」已删除`, 'success');
    } catch (e) {
        showToast?.(e.message, 'error');
    }
}

async function _moveFolderIds(folderIds, targetParentId) {
    try {
        await _templateFolderRequest('move-folders', { folderIds, targetParentId });
        await _refreshTemplateList();
        showToast?.('文件夹已移动 ✅', 'success');
    } catch (e) {
        showToast?.(e.message, 'error');
    }
}

function _pickLibraryTargetFolder(options = {}) {
    return new Promise(resolve => {
        const excludeIds = new Set(options.excludeFolderIds || []);
        const folders = _tplFolderData.folders || [];
        const byParent = new Map();
        for (const f of folders) {
            if (!f || !f.id || excludeIds.has(f.id)) continue;
            const p = f.parentId || '';
            if (!byParent.has(p)) byParent.set(p, []);
            byParent.get(p).push(f);
        }
        const flattened = [{ id: '', label: '🏠 主工程库（根目录）', depth: 0 }];
        const walk = (parentId, depth) => {
            const list = _sortTemplateSummaries(byParent.get(parentId) || []);
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
                    <button id="tpl-pick-close" style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;">✕</button>
                </div>
                <div style="flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:4px;">
                    ${flattened.map(item => `
                        <button type="button" class="tpl-pick-folder-row" data-folder-id="${_tplEscapeHtml(item.id)}" style="text-align:left;padding:7px 10px 7px ${10 + item.depth * 18}px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:6px;color:#e2e8f0;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px;"
                                onmouseenter="this.style.background='rgba(99,102,241,0.22)'" onmouseleave="this.style.background='rgba(255,255,255,0.03)'">
                            <span>${_tplEscapeHtml(item.label)}</span>
                            ${item.id === (_tplFolderId || '') ? '<span style="margin-left:auto;font-size:10px;color:#94a3b8;">当前位置</span>' : ''}
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
        document.body.appendChild(ov);
        const done = (val) => { ov.remove(); resolve(val); };
        ov.querySelector('#tpl-pick-close').onclick = () => done(null);
        ov.addEventListener('click', e => { if (e.target === ov) done(null); });
        ov.querySelectorAll('.tpl-pick-folder-row').forEach(btn => {
            btn.onclick = () => done(btn.dataset.folderId ?? '');
        });
    });
}

let _tplFolderHistory=[{id:'',scrollTop:0}],_tplFolderHistoryIndex=0,_tplLastNavigation={direction:'',time:0};
async function _openTemplateFolder(id,options={}){
    if(id&&!_tplFolderData.folders.some(folder=>folder.id===id))id='';
    const container=document.getElementById('tpl-grid-container');
    if(!options.fromHistory&&id!==_tplFolderId){
        _tplFolderHistory[_tplFolderHistoryIndex]={id:_tplFolderId,scrollTop:container?.scrollTop||0};
        _tplFolderHistory=_tplFolderHistory.slice(0,_tplFolderHistoryIndex+1);_tplFolderHistory.push({id,scrollTop:0});_tplFolderHistoryIndex++;
    }
    _tplFolderId=id;document.getElementById('template-library-modal')?._selectedTemplateIds?.clear();
    await _refreshTemplateList();if(container&&Number.isFinite(options.scrollTop))container.scrollTop=options.scrollTop;
}
async function _navigateTemplateFolder(direction){
    const modal=document.getElementById('template-library-modal');if(!modal||getComputedStyle(modal).display==='none')return false;
    const now=Date.now();if(_tplLastNavigation.direction===direction&&now-_tplLastNavigation.time<100)return false;
    const next=_tplFolderHistoryIndex+(direction==='back'?-1:1);if(next<0||next>=_tplFolderHistory.length)return false;
    _tplLastNavigation={direction,time:now};const container=document.getElementById('tpl-grid-container');
    _tplFolderHistory[_tplFolderHistoryIndex]={id:_tplFolderId,scrollTop:container?.scrollTop||0};_tplFolderHistoryIndex=next;
    const entry=_tplFolderHistory[next];await _openTemplateFolder(entry.id,{fromHistory:true,scrollTop:entry.scrollTop});return true;
}
window.addEventListener('videokit-template-navigation',event=>{_navigateTemplateFolder(event.detail);});
window.addEventListener('mouseup',event=>{if(event.button===3||event.button===4){const modal=document.getElementById('template-library-modal');if(modal&&getComputedStyle(modal).display!=='none'){event.preventDefault();_navigateTemplateFolder(event.button===3?'back':'forward');}}},{capture:true});
window.addEventListener('auxclick',event=>{if(event.button===3||event.button===4){const modal=document.getElementById('template-library-modal');if(modal&&getComputedStyle(modal).display!=='none')event.preventDefault();}},{capture:true});

async function _moveTemplateIds(ids, folderId) {
    const prevFolderId = _tplFolderId;
    try {
        await _templateFolderRequest('move', { ids, folderId });
        for (const id of ids) document.getElementById('template-library-modal')?._selectedTemplateIds?.delete(id);
        await _refreshTemplateList();
        window.reelsOnLibraryFolderChanged?.([prevFolderId, folderId].filter(Boolean));
    } catch (e) {
        showToast?.(e.message, 'error');
    }
}
async function _moveSelectedTemplatesToRoot() {
    const modal = document.getElementById('template-library-modal');
    const ids = (modal?._templateSummaries || []).filter(t => modal._selectedTemplateIds?.has(t.id)).map(t => t.id);
    if (!ids.length) { showToast?.('请先勾选要移出的工程', 'info'); return; }
    await _moveTemplateIds(ids, _getParentFolderId(_tplFolderId));
}
function _renderTemplateFolderCard(folder, all) {
    const directMembers = all.filter(t => _tplFolderData.assignments[t.id] === folder.id);
    const childFolders = (_tplFolderData.folders || []).filter(f => f && f.parentId === folder.id);
    const descIds = _collectTplDescendantFolderIds(folder.id, _tplFolderData.folders);
    const previewMembers = directMembers.length > 0
        ? directMembers
        : all.filter(t => descIds.has(_tplFolderData.assignments[t.id] || ''));
    const recent = [...previewMembers].sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0));
    const images = Array.from({ length: 4 }, (_, i) => `<div class="tpl-folder-preview" style="aspect-ratio:9/16;width:100%;min-height:0;overflow:hidden;border-radius:7px;background:#ffffff08;display:flex;align-items:center;justify-content:center;color:#8a6da055;">${recent[i]?.thumbnail ? `<img draggable="false" loading="lazy" decoding="async" src="${_tplEscapeHtml(recent[i].thumbnail)}" style="display:block;width:100%;height:100%;object-fit:contain;">` : '🎬'}</div>`).join('');
    const date = new Date(Math.max(Date.parse(folder.updatedAt || folder.createdAt) || 0, ...previewMembers.map(t => Date.parse(t.updatedAt || t.createdAt) || 0))).toLocaleDateString('zh-CN');
    const countLabel = childFolders.length > 0 && directMembers.length > 0
        ? `${childFolders.length} 子文件夹 · ${directMembers.length} 工程`
        : (childFolders.length > 0 ? `${childFolders.length} 个子文件夹` : `${directMembers.length} 个工程`);
    return `<div class="tpl-folder-card" draggable="true" tabindex="0" role="button" aria-label="${_tplEscapeHtml(folder.name)}，${countLabel}" title="双击打开文件夹 · 右键菜单 · F2 修改名称" data-folder-id="${_tplEscapeHtml(folder.id)}" style="cursor:pointer;min-width:0;border-radius:18px;border:1px solid #ffffff12;overflow:hidden;background:#08080c;">
        <div class="tpl-folder-cover" style="aspect-ratio:9/16;position:relative;padding:calc(8px * var(--tpl-scale,1)) calc(12px * var(--tpl-scale,1)) calc(12px * var(--tpl-scale,1));box-sizing:border-box;background:#08080c;">
            <div class="tpl-folder-mark" style="position:absolute;top:0;left:0;right:0;height:8px;background:linear-gradient(90deg,#8152b8,#39234f);"></div>
            <div style="position:relative;height:100%;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:calc(8px * var(--tpl-scale,1));align-content:start;max-width:100%;margin:0 auto;">${images}</div>
        </div>
        <div class="tpl-card-info tpl-folder-info" style="padding:calc(12px * var(--tpl-scale,1)) calc(10px * var(--tpl-scale,1));background:#242424;"><div class="tpl-folder-name" title="双击修改名称" style="font-size:calc(12px * var(--tpl-scale,1));font-weight:500;line-height:1.5;text-align:center;color:#eee;overflow-wrap:anywhere;">${_tplEscapeHtml(folder.name)}</div>
        <div class="tpl-meta" style="font-size:calc(10px * var(--tpl-scale,1));color:#999;margin-top:calc(9px * var(--tpl-scale,1));padding-top:calc(7px * var(--tpl-scale,1));border-top:1px solid #ffffff12;text-align:center;line-height:1.6;"><div>${_tplEscapeHtml(date)}</div><div>${_tplEscapeHtml(countLabel)}</div></div></div></div>`;
}
function _bindTemplateFolderCards(container) {
    for (const card of container.querySelectorAll('.tpl-folder-card')) {
        card.addEventListener('dblclick', () => _openTemplateFolder(card.dataset.folderId));
        card.addEventListener('keydown', event => {
            if (event.target.isContentEditable) return;
            if (event.key === 'Enter') { event.preventDefault(); _openTemplateFolder(card.dataset.folderId); }
            else if (event.key === 'F2') { event.preventDefault(); _renameTemplateFolder(card.dataset.folderId); }
        });
        card.querySelector('.tpl-folder-name')?.addEventListener('dblclick', event => { event.stopPropagation(); _renameTemplateFolder(card.dataset.folderId); });
        card.addEventListener('contextmenu', event => {
            if (event.target.isContentEditable) return;
            event.preventDefault(); event.stopPropagation();
            _showTemplateFolderContextMenu(event, card);
        });
        card.addEventListener('dragover', event => {
            if (Array.from(event.dataTransfer.types).includes('application/x-videokit-folder')) return;
            event.preventDefault();
            card.style.outline = '2px solid #8b9cff';
        });
        card.addEventListener('dragleave', () => card.style.outline = '');
        card.addEventListener('drop', event => {
            if (Array.from(event.dataTransfer.types).includes('application/x-videokit-folder')) return;
            event.preventDefault(); event.stopPropagation(); card.style.outline = '';
            const ids = _templateDragIds(event);
            if (ids.length) _moveTemplateIds(ids, card.dataset.folderId);
        });
    }
    const bindBreadcrumbDropTarget = (el, targetFolderId) => {
        if (!el) return;
        if (!el.classList.contains('is-current') && el.id !== 'tpl-folder-home') {
            el.onclick = () => _openTemplateFolder(targetFolderId);
        }
        el.ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; el.style.background = '#6366f144'; };
        el.ondragleave = () => { el.style.background = el.id === 'tpl-folder-home' ? '#ffffff08' : ''; };
        el.ondrop = async event => {
            event.preventDefault(); event.stopPropagation();
            el.style.background = el.id === 'tpl-folder-home' ? '#ffffff08' : '';
            const folderDragId = event.dataTransfer.getData('application/x-videokit-folder');
            if (folderDragId) {
                if (folderDragId !== targetFolderId) await _moveFolderIds([folderDragId], targetFolderId);
                return;
            }
            const ids = _templateDragIds(event);
            if (ids.length) await _moveTemplateIds(ids, targetFolderId);
        };
    };
    bindBreadcrumbDropTarget(document.getElementById('tpl-folder-home'), '');
    for (const chip of document.querySelectorAll('#tpl-breadcrumbs .tpl-breadcrumb-chip')) {
        bindBreadcrumbDropTarget(chip, chip.dataset.folderId || '');
    }
}

let _tplInlineEditing = null;
function _editTemplateNameInPlace(title,save) {
    if(_tplInlineEditing){_tplInlineEditing.focus();return;}
    _tplInlineEditing=title;
    const original=title.textContent,oldStyle=title.getAttribute('style');
    const card=title.closest('.tpl-card,.tpl-folder-card'),wasDraggable=card?.getAttribute('draggable');
    if(card)card.draggable=false;
    title.contentEditable='plaintext-only';title.spellcheck=false;title.setAttribute('role','textbox');title.setAttribute('aria-label','修改名称');
    Object.assign(title.style,{cursor:'text',outline:'1px solid #8999e8',borderRadius:'4px',background:'#6366f11a',minHeight:'1.5em',userSelect:'text'});
    let done=false;
    const stop=event=>event.stopPropagation();
    const clean=()=>{title.removeAttribute('contenteditable');title.removeAttribute('role');title.removeAttribute('aria-label');if(oldStyle===null)title.removeAttribute('style');else title.setAttribute('style',oldStyle);if(card){if(wasDraggable===null)card.removeAttribute('draggable');else card.setAttribute('draggable',wasDraggable);}title.removeEventListener('blur',blur);title.removeEventListener('keydown',key);for(const type of ['click','dblclick','mousedown','dragstart'])title.removeEventListener(type,stop);_tplInlineEditing=null;};
    const finish=async cancel=>{if(done)return;done=true;const name=title.textContent.replace(/[\r\n]+/g,' ').trim();clean();if(cancel || !name || name===original){title.textContent=original;return;}if(name.length>200){title.textContent=original;if(typeof showToast==='function')showToast('名称最多200字','warning');return;}title.textContent=name;try{await save(name);}catch(error){title.textContent=original;if(typeof showToast==='function')showToast('重命名失败：'+error.message,'error');}};
    const blur=()=>finish(false);
    const key=event=>{event.stopPropagation();if(event.isComposing)return;if(event.key==='Enter'){event.preventDefault();finish(false);}else if(event.key==='Escape'){event.preventDefault();finish(true);}};
    title.addEventListener('blur',blur);title.addEventListener('keydown',key);
    for(const type of ['click','dblclick','mousedown','dragstart'])title.addEventListener(type,stop);
    title.focus();const range=document.createRange();range.selectNodeContents(title);range.collapse(false);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
}

function _templateDragIds(event) {
    try {const ids=JSON.parse(event.dataTransfer.getData('application/x-videokit-templates'));if(Array.isArray(ids)&&ids.length&&ids.every(id=>typeof id==='string'))return [...new Set(ids)];}catch(_){}
    const id=event.dataTransfer.getData('text/plain');return id?[id]:[];
}
function _paintTemplateSelection() {
    const modal=document.getElementById('template-library-modal');if(!modal || modal._onSelectCallback)return;
    for(const card of modal.querySelectorAll('.tpl-card')) {
        const selected=modal._selectedTemplateIds?.has(card.dataset.id);
        card.classList.toggle('tpl-selected',!!selected);card.setAttribute('aria-selected',String(!!selected));
        card.style.boxShadow=selected?'inset 0 0 0 2px #8b9cff,0 0 0 1px #8b9cff':'';
        card.style.background=selected?'rgba(99,102,241,.18)':'rgba(255,255,255,.03)';
        const cb=card.querySelector('.tpl-card-check');
        if(cb){cb.textContent=selected?'✓':'';}
    }
    _updateTemplatePresetSelectionUI();
}
function _initTemplateMarquee(container) {
    const modal=document.getElementById('template-library-modal');if(modal._onSelectCallback)return;
    container._marqueeController?.abort();const controller=new AbortController();container._marqueeController=controller;
    const signal=controller.signal;
    for(const card of container.querySelectorAll('.tpl-card'))card.addEventListener('click',event=>{
        if(event.target.closest('button,input,label,[contenteditable]') || container._marqueeActive)return;
        const selected=modal._selectedTemplateIds;
        if(event.ctrlKey || event.metaKey){if(selected.has(card.dataset.id))selected.delete(card.dataset.id);else selected.add(card.dataset.id);}
        else if(event.shiftKey)selected.add(card.dataset.id);
        else{selected.clear();selected.add(card.dataset.id);}
        _paintTemplateSelection();
    },{signal});
    container.addEventListener('mousedown',event=>{
        if(event.button!==0 || event.target.closest('.tpl-card,.tpl-folder-card,button,input,select,[contenteditable]'))return;
        if(_tplInlineEditing){event.preventDefault();_tplInlineEditing.blur();return;}
        event.preventDefault();
        const rect=container.getBoundingClientRect(),startX=event.clientX,startY=event.clientY-rect.top+container.scrollTop;
        const keep=event.ctrlKey||event.metaKey||event.shiftKey?new Set(modal._selectedTemplateIds):new Set();
        const box=document.createElement('div');Object.assign(box.style,{position:'fixed',pointerEvents:'none',zIndex:'999998',background:'rgba(99,102,241,.16)',border:'1px solid #a5b4fc',display:'none'});document.body.appendChild(box);
        container._marqueeActive=true;let x=startX,y=event.clientY,raf=0,active=true;
        const oldSelect=document.body.style.userSelect;document.body.style.userSelect='none';
        const update=()=>{
            const bounds=container.getBoundingClientRect(),anchorY=bounds.top+startY-container.scrollTop;
            const left=Math.max(bounds.left,Math.min(startX,x)),right=Math.min(bounds.right,Math.max(startX,x));
            const top=Math.max(bounds.top,Math.min(anchorY,y)),bottom=Math.min(bounds.bottom,Math.max(anchorY,y));
            Object.assign(box.style,{display:'block',left:left+'px',top:top+'px',width:Math.max(0,right-left)+'px',height:Math.max(0,bottom-top)+'px'});
            modal._selectedTemplateIds=new Set(keep);
            const contentY=y-bounds.top+container.scrollTop,selectionTop=Math.min(startY,contentY),selectionBottom=Math.max(startY,contentY),selectionLeft=Math.min(startX,x),selectionRight=Math.max(startX,x);
            for(const card of container.querySelectorAll('.tpl-card')){const r=card.getBoundingClientRect(),cardTop=r.top-bounds.top+container.scrollTop,cardBottom=r.bottom-bounds.top+container.scrollTop;if(selectionRight>selectionLeft&&selectionBottom>selectionTop&&r.right>selectionLeft&&r.left<selectionRight&&cardBottom>selectionTop&&cardTop<selectionBottom)modal._selectedTemplateIds.add(card.dataset.id);}
            _paintTemplateSelection();
        };
        const move=event=>{x=event.clientX;y=event.clientY;update();};
        const tick=()=>{if(!active)return;const bounds=container.getBoundingClientRect();if(y<bounds.top+35)container.scrollTop-=14;else if(y>bounds.bottom-35)container.scrollTop+=14;update();raf=requestAnimationFrame(tick);};
        const finish=()=>{if(!active)return;active=false;cancelAnimationFrame(raf);box.remove();document.body.style.userSelect=oldSelect;document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',finish);setTimeout(()=>container._marqueeActive=false,0);};
        document.addEventListener('mousemove',move);document.addEventListener('mouseup',finish,{once:true});signal.addEventListener('abort',finish,{once:true});
        update();raf=requestAnimationFrame(tick);
    },{signal});
}

let _tplContextMenuCleanup=null;
function _closeTemplateContextMenu(){if(_tplContextMenuCleanup)_tplContextMenuCleanup();}
function _showTemplateFolderContextMenu(event, card) {
    _closeTemplateContextMenu();
    const folderId = card.dataset.folderId || '';
    const descIds = _collectTplDescendantFolderIds(folderId, _tplFolderData.folders);
    const items = [
        ['📂 打开文件夹', () => _openTemplateFolder(folderId)],
        ['📑 应用本文件夹全部标签', () => window.reelsApplyFolderById(folderId)],
        ['📁 在此新建子文件夹', () => _newTemplateFolder(folderId)],
        ['', null],
        ['✏️ 重命名文件夹', () => _renameTemplateFolder(folderId)],
        ['📦 移动到其他文件夹...', async () => {
            const target = await _pickLibraryTargetFolder({ title: '移动文件夹到...', excludeFolderIds: [...descIds] });
            if (target !== null) await _moveFolderIds([folderId], target);
        }],
        ['🗑️ 删除空文件夹', () => _deleteTemplateFolder(folderId)],
    ];
    _showTemplateTextMenu(event, items, card);
}

async function _splitSavedTemplateIntoFolder(id, fallbackName = '') {
    try {
        const resp = await apiFetch(`${API_BASE}/templates/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        const parsed = await resp.json();
        const tplData = parsed.data || parsed;
        if (!tplData || !tplData.projectData) throw new Error(parsed.error || '工程缺少数据');
        const folderBaseName = String(tplData.name || fallbackName || '拆分工程').trim() || '拆分工程';
        const extracted = _extractTabsFromProjectPayload(tplData, folderBaseName);
        if (!extracted || extracted.mode !== 'multi-tab' || extracted.items.length <= 1) {
            showToast?.('该工程内部只有 1 个标签页，无需拆分', 'info');
            return false;
        }
        const parentFolderId = _tplFolderData?.assignments?.[id] ?? _tplFolderId ?? '';
        showToast?.(`已识别内部 ${extracted.items.length} 个标签页，正在拆分存入文件夹...`, 'info');
        const res = await _archiveGroupsToLibrary(extracted.items, {
            folderMode: 'new-folder',
            folderName: folderBaseName,
            parentFolderId,
            splitByGroup: true,
            bindWorkspace: false,
            captureThumbnails: true,
            syncPresetAssets: false,
            style: extracted.style,
            exportOpts: extracted.exportOpts,
            watermarks: extracted.watermarks,
            backgroundLibrary: extracted.backgroundLibrary,
        });
        _tplFolderId = res.rootFolderId;
        await _refreshTemplateList();
        showToast?.(`✅ 已拆分出 ${res.savedResults.length} 个独立标签卡片到「${res.rootFolderPath}」`, 'success', 5000);
        return true;
    } catch (err) {
        showToast?.(`拆分工程标签失败：${err.message}`, 'error');
        return false;
    }
}

function _showTemplateContextMenu(event, card) {
    _closeTemplateContextMenu();
    const modal = document.getElementById('template-library-modal'), id = card.dataset.id, name = card.dataset.name || '';
    if (!modal._selectedTemplateIds.has(id)) { modal._selectedTemplateIds = new Set([id]); _paintTemplateSelection(); }
    const selectedIds = (modal._templateSummaries || []).filter(t => modal._selectedTemplateIds.has(t.id)).map(t => t.id);
    const activeIds = selectedIds.length ? selectedIds : [id];
    const items = [
        ['✅ 载入到工作区', () => _loadTemplateInCurrentWindow(id)],
        ['📥 追加到当前工作区', () => _loadTemplateInCurrentWindow(id, { append: true })],
        ...(activeIds.length > 1 ? [[`📑 应用所选 ${activeIds.length} 个标签到工作区`, () => tplApplySelectedProjects()]] : []),
        ['🪄 识别并拆分内部标签页', () => _splitSavedTemplateIntoFolder(id, name)],
        ['🪟 在新窗口打开', () => _openTemplateInWindow(id, name)],
        ['', null],
        ['📦 移动到文件夹...', async () => {
            const target = await _pickLibraryTargetFolder({ title: `移动 ${activeIds.length} 个工程到...` });
            if (target !== null) await _moveTemplateIds(activeIds, target);
        }],
        ...(_tplFolderId ? [[`↩ 移出到${_getParentFolderId(_tplFolderId) ? '上级文件夹' : '主工程库'}`, () => _moveTemplateIds(activeIds, _getParentFolderId(_tplFolderId))]] : []),
        ['导出工程配置', () => _exportTemplate(id, name)],
        ['打包导出工程和素材', () => _exportArchiveTemplate(id, name)],
        ['重命名', () => _renameTemplate(id)],
        ['删除模板', () => _deleteTemplate(id, name)],
    ];
    _showTemplateTextMenu(event, items, card);
}
function _showTemplateTextMenu(event,items,focusTarget){
    _closeTemplateContextMenu();
    const menu=document.createElement('div');menu.id='tpl-context-menu';menu.setAttribute('role','menu');
    Object.assign(menu.style,{position:'fixed',zIndex:'999999',minWidth:'190px',padding:'5px',borderRadius:'8px',background:'#17171e',border:'1px solid #ffffff24',boxShadow:'0 6px 20px #0007',color:'#eee',fontSize:'12px'});
    const controller=new AbortController(),signal=controller.signal;
    const close=()=>{controller.abort();menu.remove();_tplContextMenuCleanup=null;};_tplContextMenuCleanup=close;
    for(const [label,run] of items){if(!run){const divider=document.createElement('div');divider.style.cssText='height:1px;background:#ffffff12;margin:5px 3px;';menu.appendChild(divider);continue;}const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('role','menuitem');Object.assign(button.style,{display:'block',width:'100%',padding:'8px 12px',textAlign:'left',border:0,borderRadius:'4px',background:'transparent',color:label==='删除模板'?'#f59b9b':'#eee',font:'inherit',cursor:'pointer'});button.onmouseenter=()=>button.style.background='#ffffff0c';button.onmouseleave=()=>button.style.background='transparent';button.onclick=async e=>{e.stopPropagation();close();try{await run();}catch(error){if(typeof showToast==='function')showToast(error.message,'error');}};menu.appendChild(button);}
    menu.addEventListener('mousedown',e=>e.stopPropagation());menu.addEventListener('contextmenu',e=>e.preventDefault());document.body.appendChild(menu);
    const box=menu.getBoundingClientRect();menu.style.left=Math.max(6,Math.min(event.clientX,window.innerWidth-box.width-6))+'px';menu.style.top=Math.max(6,Math.min(event.clientY,window.innerHeight-box.height-6))+'px';
    document.addEventListener('mousedown',e=>{if(!menu.contains(e.target))close();},{capture:true,signal});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();focusTarget?.focus?.();}else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const buttons=[...menu.querySelectorAll('button')],index=buttons.indexOf(document.activeElement),next=e.key==='ArrowDown'?index+1:index-1;buttons[(next+buttons.length)%buttons.length].focus();}},{capture:true,signal});
    window.addEventListener('resize',close,{once:true,signal});document.getElementById('tpl-grid-container')?.addEventListener('scroll',close,{once:true,signal});
    menu.firstElementChild.focus();
}

function _templateHomeIcon(){return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex-shrink:0"><path d="M12 3 2 11h3v10h5v-6h4v6h5V11h3L12 3Z"/></svg>';}
function _showTemplateBlankMenu(event){
    const mode=localStorage.getItem('videokit_template_sort') || 'manual';
    const direction=localStorage.getItem('videokit_template_sort_direction') || 'asc';
    const items=[['新建文件夹',()=>_newTemplateFolder()],['',null]];
    for(const [key,label] of [['manual','手动排序'],['name','按名称排序'],['type','按类型排序'],['modified','按修改日期排序'],['size','按大小排序']])items.push([(mode===key?'✓ ':'')+label,()=>_setTemplateSort(key)]);
    items.push(['',null]);
    for(const [key,label] of [['asc','升序'],['desc','降序']])items.push([(direction===key?'✓ ':'')+label,()=>{localStorage.setItem('videokit_template_sort_direction',key);_refreshTemplateList();}]);
    _showTemplateTextMenu(event,items);
}

function _layoutTemplateMixedGrid(grid){
    if(!grid?.isConnected)return;
    const gap=Math.max(2,Math.round(12*_getTemplateZoom()/100));
    const infos=Array.from(grid.querySelectorAll(':scope > .tpl-card > .tpl-card-info,:scope > .tpl-folder-card > .tpl-card-info'));
    let infoHeight=0;
    for(const info of infos){let height=20;for(const child of info.children){const css=getComputedStyle(child);height+=child.getBoundingClientRect().height+(parseFloat(css.marginTop)||0)+(parseFloat(css.marginBottom)||0);}infoHeight=Math.max(infoHeight,Math.ceil(height));}
    for(const info of infos)if(info.style.minHeight!==infoHeight+'px')info.style.minHeight=infoHeight+'px';
    const rows=Array.from(grid.children).map(card=>[card,Math.max(1,Math.ceil(card.getBoundingClientRect().height+gap))]);
    for(const [card,span] of rows){const value='span '+span;if(card.style.gridRowEnd!==value)card.style.gridRowEnd=value;}
}
function _bindTemplateMixedGridLayout(container){
    container._tplLayoutObserver?.disconnect();if(container._tplLayoutFrame)cancelAnimationFrame(container._tplLayoutFrame);
    const grid=container.querySelector('#tpl-card-grid');if(!grid)return;
    const observer=new ResizeObserver(()=>{if(container._tplLayoutFrame)return;container._tplLayoutFrame=requestAnimationFrame(()=>{container._tplLayoutFrame=0;_layoutTemplateMixedGrid(grid);});});
    container._tplLayoutObserver=observer;observer.observe(grid);for(const card of grid.children)observer.observe(card);
    _layoutTemplateMixedGrid(grid);
}

function _initTemplateLibrarySizing(modal){
    if(!document.getElementById('tpl-library-fixed-text-style')){
        const style=document.createElement('style');style.id='tpl-library-fixed-text-style';style.textContent=`
        #tpl-card-grid>.tpl-card,#tpl-card-grid>.tpl-folder-card{display:flex;flex-direction:column;}
        #tpl-card-grid .tpl-template-cover,#tpl-card-grid .tpl-folder-cover{width:min(100%,var(--tpl-card-size))!important;aspect-ratio:9/16;margin-inline:auto;flex-shrink:0;min-height:0;box-sizing:border-box;}
        #tpl-card-grid .tpl-folder-cover{padding:6px 4px 4px!important;}
        #tpl-card-grid .tpl-folder-cover>div:not(.tpl-folder-mark){gap:4px!important;align-items:center;}
        #tpl-card-grid .tpl-card-info{padding:10px 8px!important;box-sizing:border-box;width:100%;}
        #tpl-card-grid .tpl-name,#tpl-card-grid .tpl-folder-name{font-size:12px!important;line-height:1.5!important;}
        #tpl-card-grid .tpl-meta{font-size:10px!important;line-height:1.4!important;margin-top:8px!important;padding-top:7px!important;gap:3px!important;}
        #tpl-card-grid .tpl-meta>span,#tpl-card-grid .tpl-meta>div{white-space:nowrap;}
        #template-library-modal .tpl-library-header{position:relative;flex-wrap:nowrap;gap:12px;flex-shrink:0;min-width:0;}
        #template-library-modal .tpl-library-header>div:first-child{flex-shrink:0;white-space:nowrap;}
        #template-library-modal .tpl-library-actions{flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;flex-wrap:nowrap;scrollbar-width:thin;}
        #template-library-modal .tpl-library-actions>button,#template-library-modal .tpl-library-actions>span{flex-shrink:0;white-space:nowrap;}
        #template-library-modal #tpl-library-close{z-index:2;}
        #tpl-grid-container{min-height:0;}
        `;document.head.appendChild(style);
    }
    const panel=modal.querySelector('.modal-content');
    const closeButton=panel.querySelector('#tpl-library-close');if(closeButton)panel.querySelector('.tpl-library-header').appendChild(closeButton);
    let widthRatio=.90,heightRatio=.88;
    try{const saved=JSON.parse(localStorage.getItem('videokit_template_window_size')||'null');if(saved?.widthRatio&&saved?.heightRatio){widthRatio=Math.max(.4,Math.min(.96,saved.widthRatio));heightRatio=Math.max(.4,Math.min(.96,saved.heightRatio));}}catch(_){}
    const fit=()=>{panel.style.width=(innerWidth*widthRatio)+'px';panel.style.height=(innerHeight*heightRatio)+'px';};fit();
    if(modal._windowSizeObserver)return;
    window.addEventListener('resize',fit);
    let timer=0;modal._windowSizeObserver=new ResizeObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!panel.isConnected||modal.style.display==='none')return;const rect=panel.getBoundingClientRect();widthRatio=rect.width/innerWidth;heightRatio=rect.height/innerHeight;localStorage.setItem('videokit_template_window_size',JSON.stringify({widthRatio,heightRatio}));},200);});modal._windowSizeObserver.observe(panel);
}

function _updateRenamedLibraryCard(kind,id,name){
    const modal=document.getElementById('template-library-modal'),container=document.getElementById('tpl-grid-container');
    if(!modal || !container)return;
    const scrollTop=container.scrollTop,now=new Date().toISOString();
    if(kind==='template'){
        for(const list of [modal._allTemplateSummaries,modal._templateSummaries]){const item=list?.find(t=>t.id===id);if(item){item.name=name;item.updatedAt=now;}}
        const card=Array.from(container.querySelectorAll('.tpl-card')).find(c=>c.dataset.id===id);
        if(card){card.dataset.name=name;const title=card.querySelector('.tpl-name');title.textContent=name;title.title=name;const date=card.querySelector('.tpl-meta')?.firstElementChild;if(date)date.textContent=new Date(now).toLocaleDateString('zh-CN');}
    }else{
        const folder=_tplFolderData.folders.find(f=>f.id===id);if(folder){folder.name=name;folder.updatedAt=now;}
        const card=Array.from(container.querySelectorAll('.tpl-folder-card')).find(c=>c.dataset.folderId===id);
        if(card){card.querySelector('.tpl-folder-name').textContent=name;card.setAttribute('aria-label',name);const date=card.querySelector('.tpl-meta')?.firstElementChild;if(date)date.textContent=new Date(now).toLocaleDateString('zh-CN');}
    }
    _layoutTemplateMixedGrid(container.querySelector('#tpl-card-grid'));
    container.scrollTop=scrollTop;
}
