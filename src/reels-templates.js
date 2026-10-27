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

let _tplFolderId = '';
let _tplFolderData = {folders:[],assignments:{}};

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
    if (btn) {
        btn.disabled = !_currentTemplateContext.id;
        btn.style.opacity = _currentTemplateContext.id ? '1' : '0.45';
        btn.style.cursor = _currentTemplateContext.id ? 'pointer' : 'not-allowed';
        btn.title = _currentTemplateContext.id
            ? `用当前工程覆盖模板「${_currentTemplateContext.name || _currentTemplateContext.id}」`
            : '请先载入一个模板';
    }
    if (label) {
        label.textContent = _currentTemplateContext.id
            ? `当前: ${_currentTemplateContext.name || _currentTemplateContext.id}`
            : '当前: 未载入模板';
        label.title = _currentTemplateContext.name || _currentTemplateContext.id || '';
    }
}

function openTemplateLibrary(onSelectCallback = null, opts = {}) {
    // 如果已存在就显示
    let modal = document.getElementById('template-library-modal');
    if (modal) {
        modal.style.display = 'flex';
        // 绑定回调到全局，方便 _refreshTemplateList 中使用
        modal._onSelectCallback = onSelectCallback;
        modal._pickerDisabledIds = new Set(opts.disabledIds || []);
        _updateCurrentTemplateButton();
        _refreshTemplateList();
        return;
    }

    modal = document.createElement('div');
    modal.id = 'template-library-modal';
    modal._onSelectCallback = onSelectCallback;
    modal._pickerDisabledIds = new Set(opts.disabledIds || []);
    modal._selectedTemplateIds = new Set();
    modal.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:400000;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';
    
    // UI elements hide/show based on mode
    const isPicker = !!onSelectCallback;
    
    modal.innerHTML = `
        <div class="modal-content" style="width:90vw;max-width:96vw;min-width:min(640px,96vw);height:80vh;max-height:96vh;min-height:min(360px,96vh);resize:both;display:flex;flex-direction:column;background:var(--bg-secondary,#1a1a2e);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
            <div class="tpl-library-header" style="display:flex;align-items:center;justify-content:space-between;padding:14px 54px 14px 20px;border-bottom:1px solid rgba(255,255,255,0.06);">
                <div style="display:flex;align-items:center;gap:12px;">
                    <span style="font-size:22px;">📂</span>
                    <h2 id="tpl-lib-title" style="margin:0;font-size:18px;font-weight:700;color:#fff;">${isPicker ? '选择视频模板' : '视频模板库'}</h2>
                    <span id="tpl-count-badge" style="font-size:11px;padding:2px 8px;background:rgba(110,231,183,0.15);color:#6ee7b7;border-radius:10px;"></span>
                </div>
                <div class="tpl-library-actions" style="display:flex;gap:6px;align-items:center;">
                    ${isPicker ? '' : `
                    <button onclick="saveCurrentAsTemplate()" style="padding:5px 12px;font-size:11px;font-weight:600;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:8px;cursor:pointer;">💾 保存当前工程</button>
                    <button id="tpl-update-current-btn" onclick="updateCurrentTemplate()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(245,158,11,0.16);color:#fbbf24;border:1px solid rgba(245,158,11,0.35);border-radius:8px;cursor:pointer;">♻️ 更新当前模板</button>
                    <button id="tpl-repair-thumbnails-btn" onclick="repairDuplicateTemplateThumbnails()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(14,165,233,0.15);color:#7dd3fc;border:1px solid rgba(14,165,233,0.35);border-radius:8px;cursor:pointer;">📸 修复重复封面</button>
                    <button onclick="_importTemplate()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;cursor:pointer;">📥 导入</button>
                    <button onclick="_exportAllTemplates()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.3);border-radius:8px;cursor:pointer;">📤 导出全部</button>
                    <button id="tpl-select-all-btn" onclick="tplSelectAllTemplates()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(59,130,246,0.14);color:#93c5fd;border:1px solid rgba(59,130,246,0.34);border-radius:8px;cursor:pointer;">☑ 全选模板</button>
                    <button id="tpl-save-selected-presets-btn" onclick="tplSaveSelectedPresets()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(16,185,129,0.16);color:#6ee7b7;border:1px solid rgba(16,185,129,0.36);border-radius:8px;cursor:pointer;">💾 保存所选预设</button>
                    <span id="tpl-selected-count" style="font-size:10px;color:#94a3b8;white-space:nowrap;">未选择</span>
                    <span id="tpl-current-template-label" style="max-width:170px;font-size:10px;color:#777;white-space:normal;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-height:1.45;min-height:2.9em;"></span>
                    `}
                    <button id="tpl-library-close" aria-label="关闭模板库" onclick="document.getElementById('template-library-modal').style.display='none'" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:4px 8px;position:absolute;right:12px;top:12px;">✕</button>
                </div>
            </div>
            <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 24px;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px;color:#bbb;">
                <button id="tpl-folder-home" onclick="_openTemplateFolder('')" title="点击返回主模板库，或将模板拖到这里移出文件夹" style="background:#ffffff08;border:1px dashed #ffffff35;border-radius:7px;padding:6px 10px;color:#cbd5e1;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">${_templateHomeIcon()}<span>主模板库</span></button>
                <span id="tpl-folder-path" style="margin-right:auto;color:#ddd;"></span>
                <button id="tpl-move-to-root" onclick="_moveSelectedTemplatesToRoot()" style="background:#ffffff0a;color:#ddd;border:1px solid #ffffff20;border-radius:6px;padding:5px 9px;cursor:pointer;">移出所选模板</button>

            </div>
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
}

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
        _tplFolderData = await _templateFolderRequest('list');
        if (_tplFolderId && !_tplFolderData.folders.some(f=>f.id===_tplFolderId)) _tplFolderId='';
        const templates = allTemplates.filter(t=>(_tplFolderData.assignments[t.id] || '')===_tplFolderId);
        const folders = _tplFolderId ? [] : _sortTemplateSummaries(_tplFolderData.folders.map(folder=>({...folder,templateType:'文件夹',sizeBytes:allTemplates.filter(t=>_tplFolderData.assignments[t.id]===folder.id).reduce((n,t)=>n+(t.sizeBytes||0),0)})));
        const currentFolder=_tplFolderData.folders.find(f=>f.id===_tplFolderId);
        document.getElementById('tpl-folder-path').textContent=currentFolder ? ' / '+currentFolder.name : '';
        document.getElementById('tpl-move-to-root').style.display=currentFolder?'':'none';
        document.getElementById('tpl-folder-home').innerHTML=_templateHomeIcon()+(currentFolder?'<span>主模板库 · 拖到这里移出</span>':'<span>主模板库</span>');
        modal._allTemplateSummaries=allTemplates;
        _syncTemplateSortControls();
        modal._templateSummaries = templates;
        if (!modal._selectedTemplateIds) modal._selectedTemplateIds = new Set();
        const availableIds = new Set(allTemplates.map(tpl => String(tpl.id)));
        [...modal._selectedTemplateIds].forEach(id => { if (!availableIds.has(String(id))) modal._selectedTemplateIds.delete(id); });

        badge.textContent = `${_tplFolderId ? templates.length : allTemplates.length} 个模板`;

        // Also update title in case mode changed via display='flex'
        const titleEl = document.getElementById('tpl-lib-title');
        if (titleEl) titleEl.textContent = isPicker ? '选择视频模板' : '视频模板库';

        if (templates.length === 0 && folders.length === 0 && !_tplFolderId) {
            container.innerHTML = `
                <div style="text-align:center;padding:80px 0;color:#555;">
                    <div style="font-size:48px;margin-bottom:16px;opacity:0.4;">📂</div>
                    <p style="font-size:14px;margin:0;">还没有保存任何模板</p>
                    ${isPicker ? '' : '<p style="font-size:12px;color:#444;margin-top:6px;">点击上方「保存当前工程为模板」开始</p>'}
                </div>
            `;
            return;
        }

        let html = `<div id="tpl-card-grid" style="--tpl-card-size:${_getTemplateCardSize()}px;--tpl-scale:${_getTemplateZoom()/100};display:grid;grid-template-columns:repeat(auto-fill,minmax(0,min(max(96px,var(--tpl-card-size)),100%)));grid-auto-rows:1px;grid-auto-flow:row dense;column-gap:${Math.max(2,Math.round(12*_getTemplateZoom()/100))}px;row-gap:0;justify-content:start;align-items:start;">`;
        html += folders.map(folder=>_renderTemplateFolderCard(folder,allTemplates)).join('');
        if (!templates.length && _tplFolderId) html += '<div style="grid-column:1/-1;text-align:center;color:#888;padding:50px;">这个文件夹还没有模板，可从模板库拖入。</div>';
        for (const tpl of templates) {
            const thumbSrc = tpl.thumbnail || '';
            const dateStr = tpl.updatedAt ? new Date(tpl.updatedAt).toLocaleDateString('zh-CN') : '';
            const taskInfo = tpl.taskCount ? `${tpl.taskCount} 个任务` : '';
            const safeId = _tplEscapeHtml(tpl.id);
            const safeName = _tplEscapeHtml(tpl.name || '');
            const safeThumb = _tplEscapeHtml(thumbSrc);
            const safeDate = _tplEscapeHtml(dateStr);
            const safeTaskInfo = _tplEscapeHtml(taskInfo);
            const isDisabledPick = isPicker && modal._pickerDisabledIds && modal._pickerDisabledIds.has(tpl.id);
            const isSelected = !isPicker && modal._selectedTemplateIds.has(String(tpl.id));
            const thumbHtml = thumbSrc
                ? `<img draggable="false" src="${safeThumb}" style="width:100%;height:100%;object-fit:cover;" />`
                : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:36px;">🎬</div>`;

            const actionsHtml = isPicker ? `
                <div class="tpl-actions" style="position:absolute;top:8px;right:8px;left:8px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;opacity:0;transition:opacity 0.2s;background:rgba(0,0,0,0.7);padding:6px;border-radius:8px;">
                    <button data-action="pick" ${isDisabledPick ? 'disabled' : ''} style="padding:4px 12px;font-size:12px;font-weight:600;background:${isDisabledPick ? 'rgba(120,120,130,0.35)' : 'linear-gradient(135deg,#7c5cff,#a855f7)'};color:${isDisabledPick ? '#999' : '#fff'};border:none;border-radius:6px;cursor:${isDisabledPick ? 'not-allowed' : 'pointer'};">${isDisabledPick ? '已添加' : '✅ 选用此模板'}</button>
                </div>
            ` : '';

            html += `
                <div class="tpl-card" draggable="true" title="拖动卡片可调整模板顺序" data-id="${safeId}" data-name="${safeName}" data-disabled-pick="${isDisabledPick ? 'true' : 'false'}" style="background:rgba(255,255,255,${isDisabledPick ? '0.018' : '0.03'});border:1px solid ${isDisabledPick ? 'rgba(120,120,130,0.28)' : 'rgba(255,255,255,0.06)'};border-radius:12px;overflow:hidden;cursor:${isDisabledPick ? 'not-allowed' : 'pointer'};transition:all 0.2s;position:relative;${isDisabledPick ? 'opacity:0.58;' : ''}"
                     onmouseenter="this.style.borderColor='rgba(99,102,241,0.4)';this.style.transform='translateY(-2px)'"
                     onmouseleave="this.style.borderColor='rgba(255,255,255,0.06)';this.style.transform='none'">
                    <div class="tpl-template-cover" style="width:100%;aspect-ratio:9/16;background:#0a0a1a;overflow:hidden;">
                        ${thumbHtml}
                    </div>
                    ${isDisabledPick ? '<div style="position:absolute;left:8px;top:8px;background:rgba(16,185,129,0.9);color:#06150f;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;">已添加</div>' : ''}
                    <div class="tpl-card-info" style="padding:10px 8px;background:#242424;">
                        <div class="tpl-name" style="font-size:calc(12px * var(--tpl-scale,1));font-weight:500;color:#eeeeee;text-align:center;white-space:normal;overflow:visible;overflow-wrap:anywhere;word-break:break-word;display:block;line-height:1.5;" title="${safeName}">${safeName}</div>
                        <div class="tpl-meta" style="font-size:calc(10px * var(--tpl-scale,1));color:#888;margin-top:calc(8px * var(--tpl-scale,1));padding-top:calc(7px * var(--tpl-scale,1));border-top:1px solid rgba(255,255,255,0.07);display:flex;flex-direction:column;align-items:center;text-align:center;gap:calc(3px * var(--tpl-scale,1));line-height:1.4;">
                            <span style="white-space:nowrap;">${safeDate}</span>
                            <span style="white-space:nowrap;">${safeTaskInfo}</span>
                        </div>
                    </div>
                    ${actionsHtml}
                </div>
            `;
        }
        html += '</div>';
        const savedScroll=container._tplRenderedFolder===_tplFolderId?container.scrollTop:0;
        container.innerHTML = html;
        if(!_tplFolderId&&(localStorage.getItem('videokit_template_sort')||'manual')==='manual'&&Array.isArray(_tplFolderData.libraryOrder)){
            const grid=container.querySelector('#tpl-card-grid'),rank=new Map(_tplFolderData.libraryOrder.map((id,i)=>[id,i]));
            if(grid)Array.from(grid.children).sort((a,b)=>(rank.get(_templateLibraryItemKey(a))??-1)-(rank.get(_templateLibraryItemKey(b))??-1)).forEach(card=>grid.appendChild(card));
        }

        _bindTemplateFolderCards(container);
        container.oncontextmenu=event=>{if(event.target.closest('.tpl-card,.tpl-folder-card,button,input,select,[contenteditable]'))return;event.preventDefault();event.stopPropagation();_showTemplateBlankMenu(event);};
        // 显示操作按钮的 hover 效果
        container.querySelectorAll('.tpl-card').forEach(card => {
            if (isPicker) {
                card.addEventListener('mouseenter', () => card.querySelector('.tpl-actions').style.opacity = '1');
                card.addEventListener('mouseleave', () => card.querySelector('.tpl-actions').style.opacity = '0');
            } else {
                card.addEventListener('contextmenu', event => {
                    if(event.target.isContentEditable)return;
                    event.preventDefault();event.stopPropagation();_showTemplateContextMenu(event,card);
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
                    // Fetch full data and pass to callback
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
                            btn.textContent = '✅ 选用此模板';
                            btn.style.background = 'linear-gradient(135deg,#7c5cff,#a855f7)';
                        }, 1500);
                    } catch(err) {
                        alert('读取模板失败');
                        btn.textContent = '✅ 选用此模板';
                    }
                }
                else if (action === 'load') _loadTemplateInCurrentWindow(id);
                else if (action === 'window') _openTemplateInWindow(id, name);
                else if (action === 'export') _exportTemplate(id, name);
                else if (action === 'export_archive') _exportArchiveTemplate(id, name);
                else if (action === 'move-root') await _moveTemplateIds([id],'');
                else if (action === 'rename') _renameTemplate(id);
                else if (action === 'delete') _deleteTemplate(id, name);
            });
            
            card.querySelector('.tpl-name')?.addEventListener('dblclick', event => {event.preventDefault();event.stopPropagation();_renameTemplate(card.dataset.id);});
            // 双击打开
            card.addEventListener('dblclick', async () => {
                const id = card.dataset.id;
                const name = card.dataset.name || '';
                if (isPicker) {
                    if (card.dataset.disabledPick === 'true') return;
                    try {
                        const r = await apiFetch(`${API_BASE}/templates/get`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id}) });
                        const res = await r.json();
                        if (modal._onSelectCallback) modal._onSelectCallback(res.data || res);
                    } catch(err) {}
                } else {
                    _openTemplateInWindow(id, name);
                }
            });
        });

        _initTemplateReordering(container);
        _initTemplateMarquee(container);
        _bindTemplateMixedGridLayout(container);
        _paintTemplateSelection();
        _updateTemplatePresetSelectionUI();
        container._tplRenderedFolder=_tplFolderId;
        container.scrollTop=savedScroll;

    } catch (e) {
        container.innerHTML = `<div style="color:#f87171;text-align:center;padding:40px;">加载失败: ${e.message}</div>`;
    }
}

function _updateTemplatePresetSelectionUI() {
    const modal = document.getElementById('template-library-modal');
    if (!modal || modal._onSelectCallback) return;
    const selected = modal._selectedTemplateIds || new Set();
    const total = (modal._templateSummaries || []).length;
    const count = selected.size;
    const label = document.getElementById('tpl-selected-count');
    const allButton = document.getElementById('tpl-select-all-btn');
    const saveButton = document.getElementById('tpl-save-selected-presets-btn');
    if (label) label.textContent = count ? `已选 ${count} / ${total}` : '未选择';
    if (allButton) allButton.textContent = total && count === total ? '☐ 取消全选' : '☑ 全选模板';
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
    const selectAll = selected.size !== templates.length;
    selected.clear();
    if (selectAll) templates.forEach(tpl => selected.add(String(tpl.id)));
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
        if (document.getElementById('template-library-modal')) _refreshTemplateList();
    }
    if (!options.silent && typeof showToast === 'function') {
        showToast(`已重新生成 ${repaired} 张模板封面${failed ? `，${failed} 张失败` : ''}`, failed ? 'warning' : 'success', 6000);
    }
    return { repaired, failed };
}

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

async function _resolveTemplateSaveFolderId() {
    // The last folder explicitly entered in this library is the save target.
    if (_tplFolderId) return _tplFolderId;
    const modal = document.getElementById('template-library-modal');
    if (modal && getComputedStyle(modal).display !== 'none') return '';
    // A separate template editor has its own library state. Inherit the
    // source template's folder until the user chooses another destination.
    if (_currentTemplateContext.id) {
        const folders = await _templateFolderRequest('list');
        return folders.assignments?.[_currentTemplateContext.id] || '';
    }
    return '';
}

async function saveCurrentAsTemplate() {
    const saveFolderId = await _resolveTemplateSaveFolderId();
    const name = await (typeof _showInputDialog === 'function' ? _showInputDialog('请输入模板名称', `模板_${new Date().toLocaleDateString('zh-CN')}`) : prompt('请输入模板名称：', `模板_${new Date().toLocaleDateString('zh-CN')}`));
    if (!name || !name.trim()) return;
    const syncPresetAssets = confirm('是否同时同步保存独立预设？\n\n“是”：把模板内的动态字幕样式和覆层分别保存为同名独立预设。\n“否”：仅保存模板工程。');

    try {
        const baseName = name.trim();
        const basePayload = _captureCurrentTemplatePayload(baseName);
        basePayload.folderId = saveFolderId;

        // 按任务列表实际显示的分组分别保存：批量标签页、文件夹/账号队列、
        // 以及未归档的已有任务，都是独立模板。不能只看批量表格标签页，
        // 因为文件夹导入的账号队列没有标签页时，也应当分开保存。
        let groups = [];
        if (typeof _batchTableState !== 'undefined' && Array.isArray(_batchTableState.tabs)) {
            if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();

            const visibleGroups = new Map();
            const visibleTasks = window._reelsState?.tasks || [];
            visibleTasks.forEach(task => {
                let id = 'legacy';
                let name = '已有任务（未归档）';
                if (task._batchTabId) {
                    id = `tab:${task._batchTabId}`;
                    name = task._batchTabName || '未命名分组';
                } else if (task._folderQueueId) {
                    id = `folder:${task._folderQueueId}`;
                    name = task._folderQueueName || '文件夹队列';
                }
                if (!visibleGroups.has(id)) {
                    visibleGroups.set(id, { id, name, tasks: [], isActive: false });
                }
                visibleGroups.get(id).tasks.push(task);
            });

            // 当前任务列表已经汇总显示多个组时，以它为准；否则回退到批量表格标签页。
            if (visibleGroups.size > 1) {
                groups = Array.from(visibleGroups.values());
            } else {
                groups = _batchTableState.tabs
                    .filter(tab => Array.isArray(tab.tasks) && tab.tasks.length > 0)
                    .map(tab => ({ ...tab, isActive: tab.id === _batchTableState.activeTabId }));
            }
        }

        if (groups.length > 1) {
            let saved = 0;
            let syncedSubtitle = 0, syncedOverlay = 0;
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
                const stableTemplateId = _templateIdForQueue(baseName, queueIdentity);
                const projectData = ReelsProject.collectProjectData({
                    tasks: group.tasks,
                    backgroundLibrary: basePayload.projectData.backgroundLibrary || [],
                    style: basePayload.projectData.style || {},
                    exportOpts: basePayload.projectData.exportOpts || {},
                    selectedIdx: group.tasks.length ? 0 : -1,
                });

                try {
                    const groupThumbnail = await _captureTemplateThumbnailForTasks(group.tasks, basePayload.thumbnail);
                    const resp = await apiFetch(`${API_BASE}/templates/save`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            id: stableTemplateId,
                            name: templateName,
                            folderId: saveFolderId,
                            // 账号队列拆分保存时，当前预览画面可作为本次保存的可见缩略图。
                            // 之前只给“激活标签”写缩略图，队列分组 ID 与标签 ID 不同，
                            // 导致所有新模板都显示为空白场记板。
                            thumbnail: groupThumbnail,
                            projectData,
                        }),
                    });
                    const result = await resp.json();
                    if (!(result.success || result.data?.success)) {
                        throw new Error(result.error || '保存失败');
                    }
                    if (syncPresetAssets) {
                        const synced = _syncTemplatePresetAssets(templateName, projectData);
                        if (synced.subtitle) syncedSubtitle++;
                        if (synced.overlay) syncedOverlay++;
                    }
                    saved++;
                } catch (e) {
                    failed.push(`${groupName}: ${e.message}`);
                }
            }

            if (!saved) throw new Error(failed.join('；') || '所有分组保存失败');
            _setCurrentTemplateContext('', '');
            if (typeof showToast === 'function') {
                showToast(
                    `已按分组保存 ${saved} 个模板${syncPresetAssets ? `；同步字幕 ${syncedSubtitle} 个、覆层 ${syncedOverlay} 个` : ''}${failed.length ? `，${failed.length} 个失败` : ''} ✅`,
                    failed.length ? 'warning' : 'success'
                );
            }
            if (failed.length) console.warn('[Template] 分组模板保存失败:', failed);
            _refreshTemplateList();
            return;
        }

        const payload = basePayload;
        const singleQueueIdentity = _templateQueueIdentityFromTasks(window._reelsState?.tasks || []);
        if (singleQueueIdentity) {
            const queueShortId = _templateQueueShortId(singleQueueIdentity);
            payload.name = `${baseName} [Q-${queueShortId}]`;
            payload.id = _templateIdForQueue(baseName, singleQueueIdentity);
        }
        const resp = await apiFetch(`${API_BASE}/templates/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await resp.json();
        if (!(result.success || result.data?.success)) throw new Error(result.error || '保存失败');
        const synced = syncPresetAssets ? _syncTemplatePresetAssets(payload.name || baseName, payload.projectData) : { subtitle:false, overlay:false };

        const savedId = result.id || result.data?.id || '';
        if (savedId) _setCurrentTemplateContext(savedId, payload.name || baseName);
        if (typeof showToast === 'function') showToast(`模板「${payload.name || baseName}」已保存${syncPresetAssets ? `；已同步${synced.subtitle ? '动态字幕' : ''}${synced.subtitle && synced.overlay ? '、' : ''}${synced.overlay ? '覆层预设' : ''}` : ''} ✅`, 'success');
        _refreshTemplateList();
    } catch (e) {
        if (typeof showToast === 'function') showToast('保存模板失败: ' + e.message, 'error');
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
            if (typeof showToast === 'function') showToast(`模板「${name}」已更新 ✅`, 'success');
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

async function _loadTemplateInCurrentWindow(templateId) {
    try {
        const resp = await apiFetch(`${API_BASE}/templates/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: templateId }),
        });
        const result = await resp.json();
        const tplData = result.data || result;
        if(result.error || !tplData.projectData)throw new Error(result.error || '模板缺少工程数据');

        if (tplData.projectData && typeof ReelsProject !== 'undefined') {
            // ── 诊断日志：模板加载数据追踪 ──
            const rawTasks = tplData.projectData.tasks || [];
            console.log(`[Template] 📦 原始模板数据: ${rawTasks.length} 个任务`);
            rawTasks.forEach((t, i) => {
                const ovCount = (t.overlays || []).length;
                const segCount = (t.segments || []).length;
                const coverOvCount = (t.cover?.overlays || []).length;
                console.log(`  [${i}] overlays=${ovCount}, segments=${segCount}, cover.overlays=${coverOvCount}, txtContent=${(t.txtContent || '').slice(0, 30)}`);
            });

            const restored = ReelsProject.applyProjectData(tplData.projectData);
            // A template owns its saved tasks, not the previously opened workspace tabs.
            if (typeof _batchTableState !== 'undefined') {
                const tabId = 'tab_template_' + Date.now();
                _batchTableState.tabs = [{id:tabId,name:tplData.name || '模板',tasks:[],materialDir:''}];
                _batchTableState.activeTabId = tabId;
                _batchTableState.appliedTabIds = [tabId];
                _batchTableState.openSnapshotTasks = null;
                _batchTableState.selectedRows = new Set();
                for(const task of restored.tasks){task._batchTabId=tabId;task._batchTabName=tplData.name || '模板';}
            }
            // Newly loaded template tasks must be visible instead of inheriting a collapsed workspace.
            if(window._reelsState){
                _reelsState.batchGroupCollapsed={'__reels_existing_tasks__':false};
                _reelsState.folderQueueCollapsed={};
                for(const task of restored.tasks){if(task._batchTabId)_reelsState.batchGroupCollapsed[task._batchTabId]=false;if(task._folderQueueId)_reelsState.folderQueueCollapsed[task._folderQueueId]=false;}
            }
            // Older templates have no style-scope metadata; their per-task snapshots remain authoritative.
            if (restored.exportOpts?.subtitleStyleScopeVersion !== 2) {
                restored.exportOpts = {...restored.exportOpts, subtitleStyleScopeVersion:2, subtitleStyleScope:'task', subtitleStyleApplyAll:false};
            }

            console.log(`[Template] 🔄 反序列化后: ${restored.tasks.length} 个任务`);
            restored.tasks.forEach((t, i) => {
                const ovCount = (t.overlays || []).length;
                const segCount = (t.segments || []).length;
                const coverOvCount = (t.cover?.overlays || []).length;
                console.log(`  [${i}] overlays=${ovCount}, segments=${segCount}, cover.overlays=${coverOvCount}`);
            });

            if (typeof applyRestoredProject === 'function') {
                applyRestoredProject(restored);
            }

            console.log(`[Template] ✅ applyRestoredProject 完成后:`);
            (_reelsState?.tasks || []).forEach((t, i) => {
                const ovCount = (t.overlays || []).length;
                const segCount = (t.segments || []).length;
                const coverOvCount = (t.cover?.overlays || []).length;
                console.log(`  [${i}] overlays=${ovCount}, segments=${segCount}, cover.overlays=${coverOvCount}`);
            });
            _setCurrentTemplateContext(tplData.id || templateId, tplData.name || '');
            if (typeof showToast === 'function') showToast(`模板「${tplData.name}」已加载`, 'success');

            // 关闭模板库面板
            const modal = document.getElementById('template-library-modal');
            if (modal) modal.style.display = 'none';

            // 自动切换到批量 Reels 标签页
            if (typeof openPanelByName === 'function') {
                openPanelByName('batch-reels');
            }
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('加载模板失败: ' + e.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════
// 4. 删除 / 重命名
// ═══════════════════════════════════════════════════════

async function _deleteTemplate(id, name) {
    if (!confirm(`确定删除模板「${name}」？此操作不可恢复。`)) return;

    try {
        await apiFetch(`${API_BASE}/templates/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        if (_currentTemplateContext.id === id) {
            _setCurrentTemplateContext('', '');
        }
        if (typeof showToast === 'function') showToast(`模板「${name}」已删除`, 'success');
        _refreshTemplateList();
    } catch (e) {
        if (typeof showToast === 'function') showToast('删除失败: ' + e.message, 'error');
    }
}

async function _renameTemplate(id) {
    const card=Array.from(document.querySelectorAll('.tpl-card')).find(card=>card.dataset.id===id);
    const title=card?.querySelector('.tpl-name');
    if(!title)return;
    _editTemplateNameInPlace(title,async name=>{
        const response=await apiFetch(`${API_BASE}/templates/rename`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name})});
        const parsed=await response.json(),result=parsed.data || parsed;
        if(parsed.error || result.error || result.success===false)throw new Error(parsed.error || result.error || '重命名失败');
        if(_currentTemplateContext.id===id)_setCurrentTemplateContext(id,name);
        _updateRenamedLibraryCard('template',id,name);
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

                // 校验是否为合集
                const templatesToImport = [];
                if (data._format === 'videokit-template-collection' && Array.isArray(data.templates)) {
                    templatesToImport.push(...data.templates);
                } else if (data.projectData) {
                    templatesToImport.push(data);
                } else {
                    if (typeof showToast === 'function') showToast(`跳过 ${file.name}: 不是有效的模板文件`, 'warning');
                    else alert(`跳过 ${file.name}: 不是有效的模板文件`);
                    continue;
                }

                for (const tpl of templatesToImport) {
                    const resp = await apiFetch(`${API_BASE}/templates/save`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: tpl.name || file.name.replace(/\.(vktpl|json)$/i, ''),
                            description: tpl.description || '',
                            thumbnail: tpl.thumbnail || '',
                            tags: tpl.tags || [],
                            }),
                    });
                    const result = await resp.json();
                    if (result.success || result.data?.success) {
                        imported++;
                    }
                }
            } catch (err) {
                console.error(`[Template] 导入 ${file.name} 失败:`, err);
                if (typeof showToast === 'function') showToast(`导入 ${file.name} 失败: ${err.message}`, 'error');
                else alert(`导入 ${file.name} 失败: ${err.message}`);
            }
        }

        if (imported > 0) {
            if (typeof showToast === 'function') showToast(`成功导入 ${imported} 个模板 ✅`, 'success');
            else alert(`成功导入 ${imported} 个模板 ✅`);
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
        openTemplateLibrary();
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
            if(!_tplFolderId){const order=current.map(_templateLibraryItemKey);await _templateFolderRequest('reorder',{order});_tplFolderData.libraryOrder=order;}
            else{
                const visible=current.filter(c=>c.classList.contains('tpl-card')).map(c=>c.dataset.id),visibleSet=new Set(visible);let next=0;
                const all=document.getElementById('template-library-modal')._allTemplateSummaries||[],ids=all.map(t=>visibleSet.has(t.id)?visible[next++]:t.id);
                const response=await apiFetch(`${API_BASE}/templates/reorder`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});const parsed=await response.json(),result=parsed.data||parsed;if(!result.success)throw Error(result.error||'排序保存失败');
            }
            localStorage.setItem('videokit_template_sort','manual');_syncTemplateSortControls();
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
async function _newTemplateFolder() {
    const name=typeof _showInputDialog==='function'?await _showInputDialog('新建文件夹','文件夹名称','新建文件夹'):prompt('文件夹名称','新建文件夹');
    if(!name?.trim())return;
    try{await _templateFolderRequest('create',{name:name.trim()});await _refreshTemplateList();}catch(e){showToast?.(e.message,'error');}
}
async function _renameTemplateFolder(id) {
    const card=Array.from(document.querySelectorAll('.tpl-folder-card')).find(card=>card.dataset.folderId===id);
    const title=card?.querySelector('.tpl-folder-name');
    if(!title)return;
    _editTemplateNameInPlace(title,async name=>{await _templateFolderRequest('rename',{id,name});_updateRenamedLibraryCard('folder',id,name);});
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

async function _moveTemplateIds(ids,folderId) {
    try {await _templateFolderRequest('move',{ids,folderId});for(const id of ids)document.getElementById('template-library-modal')?._selectedTemplateIds?.delete(id);await _refreshTemplateList();}
    catch(e){showToast?.(e.message,'error');}
}
async function _moveSelectedTemplatesToRoot() {
    const modal=document.getElementById('template-library-modal');const ids=(modal?._templateSummaries||[]).filter(t=>modal._selectedTemplateIds?.has(t.id)).map(t=>t.id);
    if(!ids.length){showToast?.('请先勾选要移出的模板','info');return;}
    await _moveTemplateIds(ids,'');
}
function _renderTemplateFolderCard(folder,all) {
    const members=all.filter(t=>_tplFolderData.assignments[t.id]===folder.id);
    const recent=[...members].sort((a,b)=>(Date.parse(b.updatedAt||b.createdAt)||0)-(Date.parse(a.updatedAt||a.createdAt)||0));
    const images=Array.from({length:4},(_,i)=>`<div class="tpl-folder-preview" style="aspect-ratio:9/16;width:100%;min-height:0;overflow:hidden;border-radius:7px;background:#ffffff08;display:flex;align-items:center;justify-content:center;color:#8a6da055;">${recent[i]?.thumbnail?`<img draggable="false" loading="lazy" decoding="async" src="${_tplEscapeHtml(recent[i].thumbnail)}" style="display:block;width:100%;height:100%;object-fit:contain;">`:'🎬'}</div>`).join('');
    const date=new Date(Math.max(Date.parse(folder.updatedAt||folder.createdAt)||0,...members.map(t=>Date.parse(t.updatedAt||t.createdAt)||0))).toLocaleDateString('zh-CN');
    return `<div class="tpl-folder-card" draggable="true" tabindex="0" role="button" aria-label="${_tplEscapeHtml(folder.name)}，${members.length} 个模板" title="双击打开文件夹；F2 修改名称" data-folder-id="${_tplEscapeHtml(folder.id)}" style="cursor:pointer;min-width:0;border-radius:18px;border:1px solid #ffffff12;overflow:hidden;background:#08080c;">
        <div class="tpl-folder-cover" style="aspect-ratio:9/16;position:relative;padding:calc(8px * var(--tpl-scale,1)) calc(12px * var(--tpl-scale,1)) calc(12px * var(--tpl-scale,1));box-sizing:border-box;background:#08080c;">
            <div class="tpl-folder-mark" style="position:absolute;top:0;left:0;right:0;height:8px;background:linear-gradient(90deg,#8152b8,#39234f);"></div>
            <div style="position:relative;height:100%;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:calc(8px * var(--tpl-scale,1));align-content:start;max-width:100%;margin:0 auto;">${images}</div>
        </div>
        <div class="tpl-card-info tpl-folder-info" style="padding:calc(12px * var(--tpl-scale,1)) calc(10px * var(--tpl-scale,1));background:#242424;"><div class="tpl-folder-name" title="双击修改名称" style="font-size:calc(12px * var(--tpl-scale,1));font-weight:500;line-height:1.5;text-align:center;color:#eee;overflow-wrap:anywhere;">${_tplEscapeHtml(folder.name)}</div>
        <div class="tpl-meta" style="font-size:calc(10px * var(--tpl-scale,1));color:#999;margin-top:calc(9px * var(--tpl-scale,1));padding-top:calc(7px * var(--tpl-scale,1));border-top:1px solid #ffffff12;text-align:center;line-height:1.6;"><div>${_tplEscapeHtml(date)}</div><div>${members.length} 个模板</div></div></div></div>`;
}
function _bindTemplateFolderCards(container) {
    for(const card of container.querySelectorAll('.tpl-folder-card')) {
        card.addEventListener('dblclick',()=>_openTemplateFolder(card.dataset.folderId));
        card.addEventListener('keydown',event=>{if(event.target.isContentEditable)return;if(event.key==='Enter'){event.preventDefault();_openTemplateFolder(card.dataset.folderId);}else if(event.key==='F2'){event.preventDefault();_renameTemplateFolder(card.dataset.folderId);}});
        card.querySelector('.tpl-folder-name').addEventListener('dblclick',event=>{event.stopPropagation();_renameTemplateFolder(card.dataset.folderId);});
        card.addEventListener('dragover',event=>{if(Array.from(event.dataTransfer.types).includes('application/x-videokit-folder'))return;event.preventDefault();card.style.outline='2px solid #8b9cff';});
        card.addEventListener('dragleave',()=>card.style.outline='');
        card.addEventListener('drop',event=>{if(Array.from(event.dataTransfer.types).includes('application/x-videokit-folder'))return;event.preventDefault();event.stopPropagation();card.style.outline='';const ids=_templateDragIds(event);if(ids.length)_moveTemplateIds(ids,card.dataset.folderId);});
    }
    const home=document.getElementById('tpl-folder-home');
    home.ondragover=event=>{event.preventDefault();event.dataTransfer.dropEffect='move';home.style.background='#6366f144';};
    home.ondragleave=()=>home.style.background='#ffffff08';
    home.ondrop=event=>{event.preventDefault();event.stopPropagation();home.style.background='#ffffff08';if(Array.from(event.dataTransfer.types).includes('application/x-videokit-folder'))return;const ids=_templateDragIds(event);if(ids.length)_moveTemplateIds(ids,'');};
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
function _showTemplateContextMenu(event,card){
    _closeTemplateContextMenu();
    const modal=document.getElementById('template-library-modal'),id=card.dataset.id,name=card.dataset.name || '';
    if(!modal._selectedTemplateIds.has(id)){modal._selectedTemplateIds=new Set([id]);_paintTemplateSelection();}
    const items=[['载入当前工程',()=>_loadTemplateInCurrentWindow(id)],['在新窗口打开',()=>_openTemplateInWindow(id,name)],['导出模板配置',()=>_exportTemplate(id,name)],['打包导出模板和素材',()=>_exportArchiveTemplate(id,name)],['重命名',()=>_renameTemplate(id)],['删除模板',()=>_deleteTemplate(id,name)]];
    if(_tplFolderId)items.splice(4,0,['移出文件夹',()=>{const ids=(modal._templateSummaries||[]).filter(t=>modal._selectedTemplateIds.has(t.id)).map(t=>t.id);return _moveTemplateIds(ids,'');}]);
    _showTemplateTextMenu(event,items,card);
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
