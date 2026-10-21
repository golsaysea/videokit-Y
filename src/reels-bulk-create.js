/**
 * reels-bulk-create.js — 大量制作模块 v2
 * 工程模版 × 数据表格 = 批量任务
 * - 模板来源: 当前工程 tasks（含背景/覆层/音频）
 * - 每个模板独立绑定列
 * - 素材自动循环，填写则覆盖
 */

const _bulkState = {
    columns: [
        { name: '原始完整文案', type: 'text' },
        { name: '标题', type: 'text' },
        { name: '正文', type: 'text' },
    ],
    rows: [],
    // templates: [{ task: {...}, label: '', bindings: { title_text: colIdx, ... } }]
    templates: [],
    backgroundFolders: [],
    musicFiles: [],
    groupAssignments: null,
    allowTemplateReuse: false,
    allowBackgroundReuse: false,
    allowMusicReuse: false,
    filterUnassignedTemplates: false,
    filterUnassignedBackgrounds: false,
    filterUnassignedMusic: false,
    filterUnassignedGroups: false,
    collapsedSections: {
        templates: false,
        backgrounds: false,
        music: false,
        groups: false,
    },
};

const BC_DRAFT_KEY = 'reels_bulk_create_last_state';
let _bcDraftLoaded = false;
let _bcDraftSaveTimer = null;

let _bcSelection = null;
let _bcIsSelecting = false;
let _bcModalAbort = null;

function _bcNormalizeStateShape() {
    if (!Array.isArray(_bulkState.columns) || _bulkState.columns.length === 0) {
        _bulkState.columns = [
            { name: '原始完整文案', type: 'text' },
            { name: '标题', type: 'text' },
            { name: '正文', type: 'text' },
        ];
    }
    if (!Array.isArray(_bulkState.rows)) _bulkState.rows = [];
    if (!Array.isArray(_bulkState.templates)) _bulkState.templates = [];
    if (!Array.isArray(_bulkState.backgroundFolders)) _bulkState.backgroundFolders = [];
    if (!Array.isArray(_bulkState.musicFiles)) _bulkState.musicFiles = [];
    if (typeof _bulkState.allowTemplateReuse !== 'boolean') _bulkState.allowTemplateReuse = false;
    if (typeof _bulkState.allowBackgroundReuse !== 'boolean') _bulkState.allowBackgroundReuse = false;
    if (typeof _bulkState.allowMusicReuse !== 'boolean') _bulkState.allowMusicReuse = false;
    if (typeof _bulkState.filterUnassignedTemplates !== 'boolean') _bulkState.filterUnassignedTemplates = false;
    if (typeof _bulkState.filterUnassignedBackgrounds !== 'boolean') _bulkState.filterUnassignedBackgrounds = false;
    if (typeof _bulkState.filterUnassignedMusic !== 'boolean') _bulkState.filterUnassignedMusic = false;
    if (typeof _bulkState.filterUnassignedGroups !== 'boolean') _bulkState.filterUnassignedGroups = false;
    if (!_bulkState.collapsedSections || typeof _bulkState.collapsedSections !== 'object') {
        _bulkState.collapsedSections = {
            templates: false,
            backgrounds: false,
            music: false,
            groups: false,
        };
    }

    _bulkState.rows = _bulkState.rows.map(row => Array.isArray(row) ? row : []);
    _bulkState.rows.forEach(row => {
        while (row.length < _bulkState.columns.length) row.push('');
        if (row.length > _bulkState.columns.length) row.length = _bulkState.columns.length;
    });
}

function _bcLoadDraftOnce() {
    if (_bcDraftLoaded) return;
    _bcDraftLoaded = true;

    try {
        const raw = localStorage.getItem(BC_DRAFT_KEY);
        if (!raw) return;
        const draft = JSON.parse(raw);
        if (!draft || draft.type !== 'bulk_create_draft') return;
        if (!Array.isArray(draft.columns)) return;

        _bulkState.backgroundFolders = draft.backgroundFolders || [];
        _bulkState.musicFiles = draft.musicFiles || [];
        _bulkState.groupAssignments = draft.groupAssignments || null;
        _bulkState.allowTemplateReuse = !!draft.allowTemplateReuse;
        _bulkState.allowBackgroundReuse = !!draft.allowBackgroundReuse;
        _bulkState.allowMusicReuse = !!draft.allowMusicReuse;
        _bulkState.filterUnassignedTemplates = !!draft.filterUnassignedTemplates;
        _bulkState.filterUnassignedBackgrounds = !!draft.filterUnassignedBackgrounds;
        _bulkState.filterUnassignedMusic = !!draft.filterUnassignedMusic;
        _bulkState.filterUnassignedGroups = !!draft.filterUnassignedGroups;
        if (draft.collapsedSections && typeof draft.collapsedSections === 'object') {
            _bulkState.collapsedSections = {
                templates: !!draft.collapsedSections.templates,
                backgrounds: !!draft.collapsedSections.backgrounds,
                music: !!draft.collapsedSections.music,
                groups: !!draft.collapsedSections.groups,
            };
        }
        _bulkState.columns = JSON.parse(JSON.stringify(draft.columns));
        _bulkState.rows = Array.isArray(draft.rows) ? JSON.parse(JSON.stringify(draft.rows)) : [];
        _bulkState.templates = Array.isArray(draft.templates)
            ? draft.templates.map(t => ({
                task: t.task || {},
                label: t.label || '模板',
                bindings: { ...(t.bindings || {}) },
                bgCycle: t.bgCycle || null,
                source: t.source || null,
                materialFolder: t.materialFolder || null,
            }))
            : [];

        // ★ 修复旧草稿：检测并清除错误的跨模板共享 bgCycle
        // 如果多个模板有完全相同的 bgCycle，说明是旧 bug 造成的，需要清除
        if (_bulkState.templates.length > 1) {
            const bgCycleStrs = _bulkState.templates
                .filter(t => t.bgCycle && t.bgCycle.length > 0)
                .map(t => JSON.stringify(t.bgCycle));
            const uniqueCycles = new Set(bgCycleStrs);
            if (bgCycleStrs.length > 1 && uniqueCycles.size === 1) {
                // 所有模板共享同一个 bgCycle → 是旧 bug，清除
                console.warn('[BulkCreate] 检测到旧草稿的错误 bgCycle（跨模板共享），已自动清除');
                _bulkState.templates.forEach(t => t.bgCycle = null);
            }
        }

        _bcNormalizeStateShape();
    } catch (e) {
        console.warn('[BulkCreate] 恢复上次草稿失败:', e);
    }
}

function _bcRestoreDraft() {
    _bcDraftLoaded = false;
    _bcLoadDraftOnce();
}

function _bcSanitizeTaskForDraft(task) {
    if (!task || typeof task !== 'object') return {};
    const clone = JSON.parse(JSON.stringify(task));
    delete clone._video;
    delete clone._bgThumb;
    Object.keys(clone).forEach(k => {
        if (k.startsWith('_dom') || k.startsWith('_el') || k.startsWith('_canvas')) {
            delete clone[k];
        }
    });
    if (clone.bgSrcUrl && String(clone.bgSrcUrl).startsWith('blob:')) clone.bgSrcUrl = null;
    if (clone.srcUrl && String(clone.srcUrl).startsWith('blob:')) clone.srcUrl = null;
    if (clone.cover?.previewUrl && String(clone.cover.previewUrl).startsWith('data:')) {
        clone.cover = { ...clone.cover };
        delete clone.cover.previewUrl;
    }
    if (clone._thumbUrl && String(clone._thumbUrl).startsWith('data:')) {
        delete clone._thumbUrl;
    }
    if (Array.isArray(clone.overlays)) {
        clone.overlays.forEach(ov => {
            if (ov && typeof ov === 'object') {
                delete ov._thumb;
                delete ov._thumbUrl;
                Object.keys(ov).forEach(k => {
                    if (k.startsWith('_dom') || k.startsWith('_el') || k.startsWith('_canvas')) {
                        delete ov[k];
                    }
                });
            }
        });
    }
    return clone;
}

function _bcSaveDraftNow() {
    try {
        _bcNormalizeStateShape();
        const draft = {
            type: 'bulk_create_draft',
            backgroundFolders: _bulkState.backgroundFolders,
            musicFiles: _bulkState.musicFiles,
            groupAssignments: _bulkState.groupAssignments,
            allowTemplateReuse: _bulkState.allowTemplateReuse,
            allowBackgroundReuse: _bulkState.allowBackgroundReuse,
            allowMusicReuse: _bulkState.allowMusicReuse,
            filterUnassignedTemplates: _bulkState.filterUnassignedTemplates,
            filterUnassignedBackgrounds: _bulkState.filterUnassignedBackgrounds,
            filterUnassignedMusic: _bulkState.filterUnassignedMusic,
            filterUnassignedGroups: _bulkState.filterUnassignedGroups,
            collapsedSections: _bulkState.collapsedSections || {},
            version: 5,
            columns: JSON.parse(JSON.stringify(_bulkState.columns)),
            rows: JSON.parse(JSON.stringify(_bulkState.rows)),
            templates: _bulkState.templates.map(t => ({
                task: _bcSanitizeTaskForDraft(t.task || {}),
                label: t.label || '',
                bindings: { ...(t.bindings || {}) },
                bgCycle: t.bgCycle || null,
                source: t.source || null,
                materialFolder: t.materialFolder || null,
            })),
            savedAt: new Date().toISOString(),
        };
        try {
            localStorage.setItem(BC_DRAFT_KEY, JSON.stringify(draft));
        } catch (storageErr) {
            console.warn('[BulkCreate] 完整草稿保存超出配额，尝试降级精简保存:', storageErr);
            draft.templates.forEach(t => {
                if (t.task) {
                    delete t.task.segments;
                    delete t.task.words;
                    delete t.task.history;
                }
            });
            localStorage.setItem(BC_DRAFT_KEY, JSON.stringify(draft));
        }
    } catch (e) {
        console.warn('[BulkCreate] 保存上次草稿失败:', e);
    }
}

function _bcScheduleDraftSave() {
    if (_bcDraftSaveTimer) clearTimeout(_bcDraftSaveTimer);
    _bcDraftSaveTimer = setTimeout(() => {
        _bcDraftSaveTimer = null;
        _bcSaveDraftNow();
    }, 250);
}

// ★ bgCycle 只在「统一模式」或手动设置时生效，不跨模板自动合并
function _bcAutoPopulateBgCycle() {
    // 不再自动跨模板合并背景 — 每个模板保留自己的 bgPath
    // bgCycle 仅通过「统一模式导入」或「手动设置背景循环」按钮设置
}

function _bcNormalizeMediaPathForCycle(path) {
    let p = String(path || '').trim();
    if (!p) return '';
    if (/^local-media:\/\//i.test(p)) p = p.replace(/^local-media:\/\//i, '');
    if (/^file:\/\//i.test(p)) {
        try { p = decodeURIComponent(new URL(p).pathname); } catch (_) { p = p.replace(/^file:\/\//i, ''); }
    }
    return p;
}

function _bcAddUniqueCyclePath(list, path) {
    const p = _bcNormalizeMediaPathForCycle(path);
    if (p && !list.includes(p)) list.push(p);
}

function _bcCollectTaskBackgroundCycle(task) {
    const out = [];
    if (!task) return out;
    if (Array.isArray(task.bgClipPool)) {
        task.bgClipPool.forEach(p => _bcAddUniqueCyclePath(out, p));
    }
    _bcAddUniqueCyclePath(out, task.bgPath);
    _bcAddUniqueCyclePath(out, task.videoPath);
    _bcAddUniqueCyclePath(out, task.backgroundPath);
    _bcAddUniqueCyclePath(out, task.cover?.bgPath);
    return out;
}

function _bcTemplateBgCycle(task) {
    const cycle = _bcCollectTaskBackgroundCycle(task);
    return cycle.length > 1 ? cycle : null;
}

function _bcCollectProjectBackgroundCycle(projectData) {
    const out = [];
    const library = Array.isArray(projectData?.backgroundLibrary) ? projectData.backgroundLibrary : [];
    library.forEach(item => {
        if (typeof item === 'string') _bcAddUniqueCyclePath(out, item);
        else _bcAddUniqueCyclePath(out, item?.path || item?.filePath || item?.videoPath || item?.bgPath);
    });
    return out;
}

function _bcResolveTemplateBgCycle(task, projectCycle = null) {
    const scoped = _bcTemplateBgCycle(task);
    if (scoped && scoped.length > 1) return scoped;
    return projectCycle && projectCycle.length > 1 ? projectCycle : null;
}

function _bcDeserializeProjectTasks(projectData) {
    let safeTasks = projectData?.tasks || [];
    if (typeof ReelsProject !== 'undefined' && ReelsProject.applyProjectData) {
        try {
            const restored = ReelsProject.applyProjectData(projectData || { version: '2.0.0', tasks: safeTasks });
            if (restored && Array.isArray(restored.tasks)) safeTasks = restored.tasks;
        } catch(e) {
            console.error('[BulkCreate] Error safely deserializing tasks:', e);
        }
    }
    return safeTasks;
}

function _bcCloneTemplateTask(task) {
    const clone = JSON.parse(JSON.stringify(task || {}));
    delete clone._video; delete clone._bgThumb;
    if (clone.bgSrcUrl && String(clone.bgSrcUrl).startsWith('blob:')) clone.bgSrcUrl = null;
    if (clone.srcUrl && String(clone.srcUrl).startsWith('blob:')) clone.srcUrl = null;
    return clone;
}

function _bcApplySingleBackground(task, path) {
    const p = _bcNormalizeMediaPathForCycle(path);
    if (!task || !p) return;
    task.bgPath = p;
    task.videoPath = p;
    task.bgSrcUrl = null;
    task.srcUrl = null;
    task.bgMode = 'single';
    task.bgClipPool = [];
    delete task.timeline;
    delete task.renderPlan;
    delete task.timelineBackgroundTrim;
}

// 选择背景循环文件
function _bcPickBgCycleFiles(tpl, ti) {
    if (window.electronAPI && window.electronAPI.showOpenDialog) {
        window.electronAPI.showOpenDialog({
            title: '选择背景素材文件（可多选）',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: '视频/图片', extensions: ['mp4','mov','avi','mkv','webm','jpg','jpeg','png','webp','gif'] }
            ]
        }).then(result => {
            if (result && result.filePaths && result.filePaths.length > 0) {
                if (!tpl.bgCycle) tpl.bgCycle = [];
                result.filePaths.forEach(p => { if (!tpl.bgCycle.includes(p)) tpl.bgCycle.push(p); });
                console.log(`[BulkCreate] 模板「${tpl.label}」设置背景循环: ${tpl.bgCycle.length} 个素材`);
                _bcRenderBindings();
                _bcScheduleDraftSave();
            }
        });
    } else {
        alert('请在桌面版中使用此功能');
    }
}

const BC_FOLDER_BG_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

async function _bcImportBackgroundFolders(paths) {
    if (!window.electronAPI?.scanDirectoryRecursive) { alert('请在桌面版中导入背景文件夹'); return; }
    const errors = [];
    for (const path of [...new Set(paths)]) {
        try {
            // 背景库按文件夹递归读取；子目录只是组织方式，不会漏掉其中素材。
            const entries = await window.electronAPI.scanDirectoryRecursive(path, { maxDepth: 20 });
            const files = (entries || []).filter(item => !item.isDirectory && item.path && BC_FOLDER_BG_EXTS.has(_bcFileExt(item.name || item.path)))
                .sort((a, b) => String(a.name || a.path).localeCompare(String(b.name || b.path), undefined, { numeric: true })).map(item => item.path);
            const folder = { path, name: _bcFileName(path), files, recursive: true };
            const index = _bulkState.backgroundFolders.findIndex(item => item.path === path);
            if (index < 0) _bulkState.backgroundFolders.push(folder);
            else _bulkState.backgroundFolders[index] = folder;
        } catch (error) { errors.push(`${_bcFileName(path)}：${error.message || error}`); }
    }
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (errors.length) alert(`部分文件夹读取失败：\n${errors.join('\n')}`);
}

function _bcClearBackgroundFolders() {
    const oldPaths = (_bulkState.backgroundFolders || []).flatMap(f => Array.isArray(f?.files) ? f.files : []).filter(Boolean);
    _bulkState.backgroundFolders = [];
    (_bulkState.groupAssignments || []).forEach(entry => {
        entry.backgroundFolder = '';
        entry.selectedBackgroundFiles = [];
    });
    if (typeof window.reelsPurgeMediaCaches === 'function' && oldPaths.length) {
        window.reelsPurgeMediaCaches(oldPaths);
    }
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') showToast('✅ 已清空背景库及素材缓存', 'success');
}

function _bcApplyAssignedBackground(task, tpl, index) {
    if (!tpl.assignedBackgroundFolder) return;
    const folder = _bulkState.backgroundFolders.find(item => item.path === tpl.assignedBackgroundFolder);
    if (!folder?.files?.length) throw new Error('所选背景分类为空或已移除，请重新分配');
    // 指定素材循环只使用用户在该编号组勾选的素材；未勾选时仍安全回退到整个文件夹。
    const selected = Array.isArray(tpl.assignedBackgroundFiles) ? tpl.assignedBackgroundFiles : [];
    const files = tpl.assignedBackgroundMode === 'selected-cycle'
        ? selected.filter(path => folder.files.includes(path))
        : folder.files;
    if (!files.length) throw new Error('“指定素材循环”尚未选择素材，请点击“选择素材”至少勾选一个');
    const mode = tpl.assignedBackgroundMode || 'cycle';
    let hash = ((tpl.assignedBackgroundSeed || 0) + Math.imul(index + 1, 0x9e3779b9)) | 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    const random = tpl.assignedBackgroundSeed == null ? Math.random() : ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
    const path = files[mode === 'random' ? Math.floor(random * files.length) : index % files.length];
    _bcApplySingleBackground(task, path);
    task.bgClipActivePool = [];
    if (mode === 'concat') {
        task.bgMode = 'multi';
        task.bgPath = task.videoPath = files[0];
        task.bgClipPool = files.slice();
        task.bgClipActivePool = files.slice();
        task.bgClipOrder = 'sequence';
    }
}

function _bcOpenSelectedBackgroundPicker(groupKey) {
    const entry = (_bulkState.groupAssignments || []).find(item => item.key === groupKey);
    const folder = _bulkState.backgroundFolders.find(item => item.path === entry?.backgroundFolder);
    if (!entry?.backgroundFolder || !folder?.files?.length) { alert('请先选择一个背景文件夹'); return; }
    const selected = new Set((entry.selectedBackgroundFiles || []).filter(path => folder.files.includes(path)));
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,.76);display:flex;align-items:center;justify-content:center;padding:24px;';
    const render = () => {
        const cards = folder.files.map((path, index) => {
            const kind = _bcMediaKind(path);
            const checked = selected.has(path);
            const url = _bcFileUrl(path);
            const preview = kind === 'video'
                ? `<video src="${_bcEsc(url)}#t=1" muted preload="metadata" playsinline style="width:100%;height:auto;max-height:260px;object-fit:contain;display:block;background:#070710;"></video><span style="position:absolute;left:5px;bottom:29px;padding:1px 4px;border-radius:3px;background:rgba(0,0,0,.72);font-size:10px;">▶ 预览</span>`
                : `<img src="${_bcEsc(url)}" loading="lazy" style="width:100%;height:auto;max-height:260px;object-fit:contain;display:block;background:#070710;">`;
            return `<label data-path="${_bcEsc(path)}" style="position:relative;display:block;cursor:pointer;border:2px solid ${checked ? '#8b5cf6' : '#303145'};border-radius:6px;overflow:hidden;background:#141525;box-shadow:${checked ? '0 0 0 1px rgba(139,92,246,.35)' : 'none'};">
                ${preview}<input type="checkbox" ${checked ? 'checked' : ''} style="position:absolute;top:5px;right:5px;accent-color:#8b5cf6;width:16px;height:16px;"><div style="padding:4px 5px;font-size:10px;color:#d5d7e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_bcEsc(path)}">${index + 1}. ${_bcEsc(_bcFileName(path))}</div>
            </label>`;
        }).join('');
        ov.innerHTML = `<div style="width:min(920px,96vw);max-height:88vh;display:flex;flex-direction:column;background:#151622;border:1px solid #464765;border-radius:10px;overflow:hidden;box-shadow:0 18px 70px #000;">
            <div style="padding:12px 15px;border-bottom:1px solid #303145;display:flex;align-items:center;gap:10px;"><div style="flex:1;"><b style="color:#f3f4ff;">指定素材循环 · ${_bcEsc(groupKey)}</b><div style="font-size:10px;color:#9b9db8;margin-top:3px;">${_bcEsc(folder.name)}（含子文件夹）· 按原始比例显示；勾选 1 个或多个素材，视频可点击预览</div></div><button data-action="all" class="bc-btn bc-btn-default bc-btn-xs">全选</button><button data-action="none" class="bc-btn bc-btn-default bc-btn-xs">全不选</button></div>
            <div data-grid style="padding:12px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(135px,1fr));gap:9px;">${cards}</div>
            <div style="padding:10px 15px;border-top:1px solid #303145;display:flex;align-items:center;justify-content:space-between;"><span data-count style="font-size:11px;color:#c4b5fd;">已选 ${selected.size} 个</span><div style="display:flex;gap:7px;"><button data-action="cancel" class="bc-btn bc-btn-default bc-btn-sm">取消</button><button data-action="save" class="bc-btn bc-btn-purple bc-btn-sm">保存选择</button></div></div>
        </div>`;
        ov.querySelectorAll('video').forEach(video => video.addEventListener('click', e => { e.preventDefault(); video.paused ? video.play().catch(() => {}) : video.pause(); }));
    };
    const updateCount = () => { const el = ov.querySelector('[data-count]'); if (el) el.textContent = `已选 ${selected.size} 个`; };
    ov.addEventListener('change', e => { const card = e.target.closest('[data-path]'); if (!card) return; const path = card.dataset.path; e.target.checked ? selected.add(path) : selected.delete(path); card.style.borderColor = e.target.checked ? '#8b5cf6' : '#303145'; updateCount(); });
    ov.addEventListener('click', e => { const action = e.target.dataset.action; if (!action) return; if (action === 'cancel') ov.remove(); else if (action === 'all') { folder.files.forEach(path => selected.add(path)); render(); } else if (action === 'none') { selected.clear(); render(); } else if (action === 'save') { if (!selected.size) { alert('至少选择 1 个素材'); return; } entry.selectedBackgroundFiles = folder.files.filter(path => selected.has(path)); entry.backgroundMode = 'selected-cycle'; ov.remove(); _bcRenderBindings(); _bcScheduleDraftSave(); } });
    render(); document.body.appendChild(ov);
}

function _bcImportMusicFiles(paths) {
    const allowed = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma']);
    const existing = new Set(_bulkState.musicFiles.map(item => item.path));
    (paths || []).forEach(path => {
        if (!path || !allowed.has(_bcFileExt(path)) || existing.has(path)) return;
        _bulkState.musicFiles.push({ path, name: _bcFileName(path) });
        existing.add(path);
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
}

function _bcClearMusicFiles() {
    _bulkState.musicFiles = [];
    (_bulkState.groupAssignments || []).forEach(entry => {
        entry.musicPath = '';
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
}

function _bcCreateEmptyProject() {
    const hasCurrentWork = _bulkState.columns.length > 0 || _bulkState.rows.length > 0 || _bulkState.templates.length > 0
        || _bulkState.backgroundFolders.length > 0 || _bulkState.musicFiles.length > 0 || (_bulkState.groupAssignments || []).length > 0;
    if (hasCurrentWork && !confirm('新建空工程会清空当前大量制作页面的表格、模板、背景、配乐和编号任务组。\n\n不会删除已保存的爆帖工程组合库、工程模板或覆层预设。是否继续？')) return;
    _bulkState.columns = [
        { name: '原始完整文案', type: 'text' },
        { name: '标题', type: 'text' },
        { name: '正文', type: 'text' },
    ];
    _bulkState.rows = [];
    _bulkState.templates = [];
    _bulkState.backgroundFolders = [];
    _bulkState.musicFiles = [];
    _bulkState.groupAssignments = null;
    _bulkState.allowTemplateReuse = false;
    _bulkState.allowBackgroundReuse = false;
    _bulkState.allowMusicReuse = false;
    _bulkState.filterUnassignedTemplates = false;
    _bulkState.filterUnassignedBackgrounds = false;
    _bulkState.filterUnassignedMusic = false;
    _bulkState.filterUnassignedGroups = false;
    _bulkState.collapsedSections = { templates: false, backgrounds: false, music: false, groups: false };
    _bcSelection = null;
    _bcNormalizeStateShape();
    _bcRenderTable();
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') showToast('已新建空工程；可在“爆帖工程组合库 / 添加”中加入组合', 'success', 5000);
}

function _bcApplyAssignedMusic(task, tpl, taskIndex = 0) {
    const path = tpl.assignedMusicMode === 'cycle'
        ? _bulkState.musicFiles[taskIndex % Math.max(1, _bulkState.musicFiles.length)]?.path
        : tpl.assignedMusicPath;
    if (path) {
        task.bgmPath = path;
        task.bgmMode = 'single';
        task.bgmClipPool = [];
        task.bgmClipActivePool = [];
    }
}

function _bcEnsureFolderBackgroundColumn(tpl, ti) {
    let ci = Number(tpl?.bindings?.__bg__);
    const name = `组${ti + 1}-背景视频`;
    const usedByOtherTemplate = Number.isInteger(ci) && _bulkState.templates.some((other, otherTi) =>
        otherTi !== ti && Number(other?.bindings?.__bg__) === ci
    );
    if (Number.isInteger(ci) && ci >= 0 && ci < _bulkState.columns.length && !usedByOtherTemplate) return ci;
    ci = _bulkState.columns.findIndex(col => col?.name === name);
    if (ci < 0) {
        _bulkState.columns.push({ name, type: 'media', kind: 'video' });
        ci = _bulkState.columns.length - 1;
        _bulkState.rows.forEach(row => {
            while (row.length < _bulkState.columns.length) row.push('');
        });
    }
    if (!tpl.bindings) tpl.bindings = {};
    tpl.bindings.__bg__ = ci;
    return ci;
}

async function _bcRefreshTemplateMaterialFolder(tpl, ti, options = {}) {
    const folder = tpl?.materialFolder;
    if (!folder?.path) {
        if (!options.silent) alert('请先为该模板选择素材文件夹');
        return 0;
    }
    if (!window.electronAPI?.scanDirectoryRecursive) {
        alert('请在桌面版中使用文件夹刷新');
        return 0;
    }
    const entries = await window.electronAPI.scanDirectoryRecursive(folder.path, { maxDepth: 20 });
    const files = (entries || [])
        .filter(item => !item?.isDirectory && item.path && BC_FOLDER_BG_EXTS.has(_bcFileExt(item.name || item.path)))
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }))
        .map(item => item.path);
    tpl.materialFolder = {
        path: folder.path,
        mode: folder.mode === 'concat' ? 'concat' : 'rows',
        files,
        refreshedAt: Date.now(),
        columnIndex: Number.isInteger(folder.columnIndex) ? folder.columnIndex : null,
    };
    tpl.bgCycle = files.slice();

    if (tpl.materialFolder.mode === 'rows') {
        const ci = _bcEnsureFolderBackgroundColumn(tpl, ti);
        tpl.materialFolder.columnIndex = ci;
        const neededRows = Math.max(20, files.length);
        _bcEnsureRows(neededRows);
        _bulkState.rows.forEach(row => { row[ci] = ''; });
        files.forEach((path, ri) => { _bulkState.rows[ri][ci] = path; });
    }
    _bcRenderTable();
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (!options.silent && typeof showToast === 'function') {
        showToast(`✅ 「${tpl.label}」已读取 ${files.length} 个背景素材`, 'success');
    }
    return files.length;
}

async function _bcPickTemplateMaterialFolder(tpl, ti) {
    if (!window.electronAPI?.selectDirectory) {
        alert('请在桌面版中选择素材文件夹');
        return;
    }
    const path = await window.electronAPI.selectDirectory();
    if (!path) return;
    tpl.materialFolder = {
        path,
        mode: tpl.materialFolder?.mode === 'concat' ? 'concat' : 'rows',
        files: [],
        refreshedAt: 0,
    };
    await _bcRefreshTemplateMaterialFolder(tpl, ti);
}

// 显示背景循环详情弹窗
function _bcShowBgCycleDetail(tpl, ti) {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000001;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

    const renderList = () => {
        const list = tpl.bgCycle || [];
        return list.map((p, i) => {
            const name = p.split(/[/\\]/).pop();
            const ext = (name.split('.').pop() || '').toLowerCase();
            const isVideo = ['mp4','mov','avi','mkv','webm','m4v'].includes(ext);
            const isImage = ['jpg','jpeg','png','webp','gif','bmp'].includes(ext);
            const mediaUrl = _bcFileUrl(p);
            let thumbHtml;
            if (isVideo) {
                thumbHtml = `<video class="bgc-vid-thumb" src="${_bcEsc(mediaUrl)}#t=1" style="width:48px;height:48px;object-fit:cover;border-radius:4px;background:#111;" muted preload="metadata" playsinline></video>`;
            } else if (isImage) {
                thumbHtml = `<img src="${_bcEsc(mediaUrl)}" style="width:48px;height:48px;object-fit:cover;border-radius:4px;background:#000;" loading="lazy" />`;
            } else {
                thumbHtml = `<div style="width:48px;height:48px;border-radius:4px;background:#111;display:flex;align-items:center;justify-content:center;font-size:18px;">📄</div>`;
            }
            return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:5px;" data-idx="${i}">
                <span style="color:#666;font-size:10px;font-weight:bold;min-width:20px;">#${i + 1}</span>
                <div style="flex-shrink:0;">${thumbHtml}</div>
                <span style="flex:1;font-size:11px;color:#ccc;word-break:break-all;min-width:0;" title="${_bcEsc(p)}">${_bcEsc(name)}</span>
                <span class="bgc-del-item" data-idx="${i}" style="cursor:pointer;color:#f66;font-size:10px;padding:2px 6px;border-radius:3px;background:rgba(255,68,68,0.08);border:1px solid rgba(255,68,68,0.15);flex-shrink:0;" title="移除此素材">✕</span>
            </div>`;
        }).join('');
    };

    const rebuild = () => {
        const listEl = ov.querySelector('#bgc-list');
        const countEl = ov.querySelector('#bgc-count');
        if (listEl) listEl.innerHTML = renderList();
        if (countEl) countEl.textContent = `${(tpl.bgCycle || []).length} 个素材`;
        _bgcSeekAllThumbs();
    };

    // 主动对所有视频缩略图 seek 到视频 25% 位置抓帧（避免黑场开头）
    const _bgcSeekAllThumbs = () => {
        setTimeout(() => {
            ov.querySelectorAll('.bgc-vid-thumb').forEach(v => {
                if (v._seeked) return;
                const doSeek = () => {
                    const t = v.duration && isFinite(v.duration) ? v.duration * 0.25 : 3;
                    v.currentTime = Math.max(0.5, t);
                    v._seeked = true;
                };
                v.addEventListener('error', () => {
                    const box = v.parentElement;
                    if (box) box.innerHTML = '<div style="width:48px;height:48px;border-radius:4px;background:#111;color:#f66;display:flex;align-items:center;justify-content:center;font-size:10px;">加载失败</div>';
                }, { once: true });
                if (v.readyState >= 1 && v.duration) doSeek();
                else v.addEventListener('loadedmetadata', doSeek, { once: true });
            });
        }, 100);
    };

    ov.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:20px;width:560px;max-height:75vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,0.6);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <h3 style="margin:0;font-size:14px;color:#10b981;">🔄 背景循环素材 — ${_bcEsc(tpl.label)}</h3>
                <button id="bgc-close" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;">✕</button>
            </div>
            <div style="display:flex;gap:6px;margin-bottom:10px;align-items:center;">
                <span id="bgc-count" style="font-size:11px;color:#888;">${(tpl.bgCycle || []).length} 个素材</span>
                <span style="flex:1;"></span>
                <button id="bgc-add" style="padding:4px 10px;font-size:10px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#10b981;border-radius:4px;cursor:pointer;">📂 添加素材</button>
                <button id="bgc-clear" style="padding:4px 10px;font-size:10px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171;border-radius:4px;cursor:pointer;">🗑 清空全部</button>
            </div>
            <div id="bgc-list" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px;min-height:60px;max-height:50vh;">
                ${renderList()}
            </div>
            <div style="margin-top:12px;text-align:right;">
                <button id="bgc-done" style="padding:6px 20px;font-size:12px;background:rgba(16,185,129,0.25);border:1px solid rgba(16,185,129,0.4);color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;">确定</button>
            </div>
        </div>
    `;

    document.body.appendChild(ov);
    _bgcSeekAllThumbs();

    const close = () => { ov.remove(); _bcRenderBindings(); _bcScheduleDraftSave(); };
    ov.querySelector('#bgc-close').onclick = close;
    ov.querySelector('#bgc-done').onclick = close;
    ov.addEventListener('click', e => { if (e.target === ov) close(); });

    // 删除单个
    ov.querySelector('#bgc-list').addEventListener('click', e => {
        const del = e.target.closest('.bgc-del-item');
        if (!del) return;
        const idx = parseInt(del.dataset.idx);
        if (tpl.bgCycle && idx >= 0 && idx < tpl.bgCycle.length) {
            tpl.bgCycle.splice(idx, 1);
            if (tpl.bgCycle.length === 0) tpl.bgCycle = null;
            rebuild();
            _bcScheduleDraftSave();
        }
    });

    // 添加
    ov.querySelector('#bgc-add').onclick = () => {
        _bcPickBgCycleFiles(tpl, ti);
        // 文件选择是异步的，选完后刷新列表
        setTimeout(rebuild, 500);
    };

    // 清空
    ov.querySelector('#bgc-clear').onclick = () => {
        if (confirm('清空全部背景循环素材？')) {
            const oldCycle = Array.isArray(tpl.bgCycle) ? [...tpl.bgCycle] : [];
            tpl.bgCycle = null;
            if (typeof window.reelsPurgeMediaCaches === 'function' && oldCycle.length) {
                window.reelsPurgeMediaCaches(oldCycle);
            }
            close();
        }
    };
}

function _bcSelectionBounds() {
    if (!_bcSelection) return null;
    return {
        minR: Math.min(_bcSelection.r1, _bcSelection.r2),
        maxR: Math.max(_bcSelection.r1, _bcSelection.r2),
        minC: Math.min(_bcSelection.c1, _bcSelection.c2),
        maxC: Math.max(_bcSelection.c1, _bcSelection.c2),
    };
}

function _bcUpdateSelectionUI() {
    document.querySelectorAll('.bc-grid-td, .bc-cell').forEach(el => el.classList.remove('bc-selected-cell', 'bc-anchor-cell'));
    if (!_bcSelection) return;
    const { minR, maxR, minC, maxC } = _bcSelectionBounds();

    for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
            const cell = document.querySelector(`.bc-cell[data-ri="${r}"][data-ci="${c}"]`);
            const td = document.querySelector(`.bc-grid-td[data-ri="${r}"][data-ci="${c}"]`);
            if (cell) cell.classList.add('bc-selected-cell');
            if (td) td.classList.add('bc-selected-cell');
        }
    }
    const anchor = document.querySelector(`.bc-grid-td[data-ri="${_bcSelection.r1}"][data-ci="${_bcSelection.c1}"]`);
    if (anchor) anchor.classList.add('bc-anchor-cell');
}

function _bcCellPreview(value) {
    const text = String(value || '').replace(/\r?\n/g, ' ↵ ');
    return _bcEsc(text);
}

function _bcFileName(filePath) {
    return String(filePath || '').split(/[\\/]/).pop() || String(filePath || '');
}

function _bcFileExt(filePath) {
    const name = _bcFileName(filePath);
    const idx = name.lastIndexOf('.');
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function _bcFileUrl(filePath) {
    if (!filePath) return '';
    if (/^(blob:|data:|https?:|file:)/i.test(filePath)) return filePath;
    if (window.electronAPI?.toFileUrl) {
        const url = window.electronAPI.toFileUrl(filePath);
        if (url) return url;
    }
    return filePath;
}

function _bcMediaKind(filePath) {
    const ext = _bcFileExt(filePath);
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'].includes(ext)) return 'audio';
    if (['srt', 'vtt', 'ass'].includes(ext)) return 'subtitle';
    return 'file';
}

function _bcMediaIconForKind(kind) {
    return { image: '🖼', video: '🎬', audio: '🎵', subtitle: '💬', file: '📄' }[kind] || '📄';
}

function _bcGuessColumnKind(col) {
    if (!col || col.type !== 'media') return 'text';
    const name = String(col.name || '').toLowerCase();
    if (/srt|vtt|ass|字幕|subtitle|caption/.test(name)) return 'subtitle';
    if (/音频|audio|voice|tts|配音|人声|旁白|bgm|music/.test(name)) return 'audio';
    if (/图片|图像|image|photo|pic|封面|cover|png|jpg|jpeg|webp/.test(name)) return 'image';
    if (/视频|video|movie|clip|背景|bg|素材|media/.test(name)) return 'video';
    return 'video';
}

function _bcColumnKind(col) {
    if (!col || col.type !== 'media') return 'text';
    return col.kind || _bcGuessColumnKind(col);
}

function _bcSetColumnKind(col, kind) {
    if (!col) return;
    if (kind === 'text') {
        col.type = 'text';
        delete col.kind;
    } else {
        col.type = 'media';
        col.kind = kind || 'video';
    }
}

function _bcMediaCellHtml(value) {
    if (!value) return '<span class="bc-cell-placeholder"> </span>';
    const kind = _bcMediaKind(value);
    const url = _bcFileUrl(value);
    const name = _bcFileName(value);
    let thumb = `<span class="bc-media-icon">${_bcMediaIconForKind(kind)}</span>`;
    if (kind === 'image') {
        thumb = `<img class="bc-media-thumb" src="${_bcEsc(url)}" loading="lazy" alt="">`;
    } else if (kind === 'video') {
        thumb = `<video class="bc-media-thumb" src="${_bcEsc(url)}#t=0.1" muted preload="metadata" playsinline></video>`;
    }
    return `${thumb}<span class="bc-media-name">${_bcEsc(name)}</span>`;
}

function _bcIsMediaColumn(ci) {
    return _bulkState.columns[ci]?.type === 'media';
}

function _bcPathMatchesColumnKind(path, ci) {
    const kind = _bcColumnKind(_bulkState.columns[ci]);
    if (!kind || kind === 'video') return ['video', 'file'].includes(_bcMediaKind(path));
    return _bcMediaKind(path) === kind || _bcMediaKind(path) === 'file';
}

function _bcColumnKindOptions(col) {
    const selected = _bcColumnKind(col);
    const opts = [
        ['text', '📝 文字'],
        ['image', '🖼 图片'],
        ['video', '🎬 视频'],
        ['audio', '🎵 音频'],
        ['subtitle', '💬 SRT'],
    ];
    return opts.map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
}

function _bcColumnKindOptionsLabel(col) {
    return {
        text: '📝',
        image: '🖼',
        video: '🎬',
        audio: '🎵',
        subtitle: '💬',
    }[_bcColumnKind(col)] || '📎';
}

function _bcRenderTemplateThumb(overlays, timeoutMs = 2000) {
    if (!Array.isArray(overlays) || overlays.length === 0) return Promise.resolve('');
    if (typeof PresetThumbRenderer === 'undefined') return Promise.resolve('');

    const renderer = new PresetThumbRenderer();
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    return Promise.race([renderer.renderThumbAsync(overlays), timeoutPromise]);
}

function _bcColumnFromName(name) {
    const col = { name, type: 'text' };
    const lowerName = String(name || '').toLowerCase();
    if (/文案|文本|正文|内容|标题|结尾|尾标|断行|ai源|ai原|tts/.test(lowerName)) return col;
    const media = /背景|素材|bg|media|图片|图像|视频|video|image|path|音频|audio|srt|vtt|ass|字幕|subtitle|caption/i.test(name);
    if (media) _bcSetColumnKind(col, _bcGuessColumnKind({ ...col, type: 'media' }));
    return col;
}

const BC_QUICK_COLUMN_PRESETS = {
    default: {
        label: '默认配置',
        columns: ['原始完整文案', '标题', '正文'],
    },
    overlay: {
        label: '覆层模板表',
        columns: ['覆层标题', '覆层正文', '覆层结尾', '背景视频', '导出命名'],
    },
    voice_workflow: {
        label: '人声工作流表',
        columns: ['人声-原文案', '人声-断行文案', '人声-配音文案', '人声ID', '背景视频', '导出命名'],
    },
};

function _bcCurrentQuickColumnPresetId() {
    const currentNames = (_bulkState.columns || []).map(col => String(col?.name || '').trim());
    for (const [presetId, preset] of Object.entries(BC_QUICK_COLUMN_PRESETS)) {
        if (preset.columns.length === currentNames.length
            && preset.columns.every((name, index) => name === currentNames[index])) {
            return presetId;
        }
    }
    return '';
}

function _bcApplyQuickColumnPreset(presetId, groupCount = 1) {
    const preset = BC_QUICK_COLUMN_PRESETS[presetId];
    if (!preset) return false;
    const safeGroupCount = Math.max(1, Math.min(500, parseInt(groupCount) || 1));
    if (safeGroupCount > 100 && !confirm(`将建立 ${safeGroupCount} 组、共 ${safeGroupCount * preset.columns.length} 列。\n表格首次渲染可能需要一些时间，是否继续？`)) {
        return false;
    }
    const hasData = _bulkState.rows.some(row => row.some(cell => String(cell || '').trim()));
    if (hasData && !confirm(`应用「${preset.label}」${safeGroupCount > 1 ? ` × ${safeGroupCount} 组` : ''}会更换表格列。\n同名列的数据会保留，其他列数据将清空。是否继续？`)) {
        return false;
    }

    const oldColumns = _bulkState.columns || [];
    const oldRows = _bulkState.rows || [];
    const oldIndexByName = new Map(oldColumns.map((col, index) => [String(col?.name || '').trim(), index]));
    const columnNames = [];
    for (let groupIndex = 0; groupIndex < safeGroupCount; groupIndex++) {
        const prefix = safeGroupCount > 1 ? `组${groupIndex + 1}-` : '';
        preset.columns.forEach(name => columnNames.push(`${prefix}${name}`));
    }
    const newColumns = columnNames.map(_bcColumnFromName);
    const newRows = oldRows.map(oldRow => newColumns.map(col => {
        const oldIndex = oldIndexByName.get(col.name);
        return oldIndex == null ? '' : (oldRow[oldIndex] || '');
    }));

    _bulkState.columns = newColumns;
    _bulkState.rows = newRows.length ? newRows : Array.from({ length: 20 }, () => new Array(newColumns.length).fill(''));
    _bcSelection = null;
    _bcAutoRebindAllTemplates();
    _bcRenderTable();
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        showToast(`✅ 已应用「${preset.label}」${safeGroupCount > 1 ? `，共 ${safeGroupCount} 组` : ''}`, 'success');
    }
    return true;
}

const BC_STANDARD_COLUMN_NAMES = [...new Set([
    ...Object.values(BC_QUICK_COLUMN_PRESETS).flatMap(preset => preset.columns),
    '人声-音频文件', '人声-SRT字幕', '内容视频', '背景图片',
    '滚动字幕标题', '滚动字幕正文', '普通文本',
])];

function _bcTsvCell(value) {
    const text = String(value ?? '');
    return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function _bcCopyWholeTable() {
    const lines = [
        (_bulkState.columns || []).map(col => _bcTsvCell(col?.name || '')).join('\t'),
        ...(_bulkState.rows || []).map(row =>
            (_bulkState.columns || []).map((_, ci) => _bcTsvCell(row?.[ci] || '')).join('\t')
        ),
    ];
    const text = lines.join('\n');
    const button = document.getElementById('bc-copy-table');
    const originalLabel = button?.textContent || '📄 复制整表';
    try {
        if (window.electronAPI?.writeClipboardText) {
            window.electronAPI.writeClipboardText(text);
        } else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.cssText = 'position:fixed;left:-99999px;top:-99999px;';
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand('copy');
            textarea.remove();
            if (!copied) throw new Error('copy command rejected');
        }
        if (button) {
            button.textContent = '✅ 已复制';
            setTimeout(() => {
                if (button.isConnected) button.textContent = originalLabel;
            }, 1500);
        }
        if (typeof showToast === 'function') showToast('✅ 已复制整张表格（包含表头）', 'success');
        return true;
    } catch (e) {
        console.warn('[BulkCreate] Copy whole table failed:', e);
        if (button) {
            button.textContent = '❌ 复制失败';
            setTimeout(() => {
                if (button.isConnected) button.textContent = originalLabel;
            }, 1800);
        }
        if (typeof showToast === 'function') showToast('复制失败，请检查剪贴板权限', 'error');
        return false;
    }
}

function _bcNativeFilePath(file) {
    if (!file) return '';
    if (typeof getFileNativePath === 'function') return getFileNativePath(file);
    if (window.electronAPI?.getFilePath) {
        try {
            const p = window.electronAPI.getFilePath(file);
            if (p) return p;
        } catch (_) {}
    }
    return file.path || file.name || '';
}

function _bcEnsureRows(count) {
    while (_bulkState.rows.length < count) {
        _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
    }
}

function _bcFillMediaColumn(paths, startRi, ci) {
    const cleanPaths = (paths || []).filter(Boolean).filter(p => _bcPathMatchesColumnKind(p, ci));
    if (!cleanPaths.length || !_bcIsMediaColumn(ci)) return 0;
    const safeStart = Math.max(0, startRi || 0);
    _bcEnsureRows(safeStart + cleanPaths.length);
    cleanPaths.forEach((p, offset) => {
        const row = _bulkState.rows[safeStart + offset];
        while (row.length < _bulkState.columns.length) row.push('');
        row[ci] = p;
    });
    _bcSelection = {
        r1: safeStart,
        c1: ci,
        r2: safeStart + cleanPaths.length - 1,
        c2: ci,
    };
    _bcRenderTable();
    _bcScheduleDraftSave();
    return cleanPaths.length;
}

function _bcEsc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Electron-safe prompt replacement
function _bcPrompt(title, placeholder) {
    return new Promise(resolve => {
        const m = document.createElement('div');
        m.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:400000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
        m.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:400px;padding:20px;">
            <div style="color:#fff;font-size:13px;font-weight:600;margin-bottom:10px;">${_bcEsc(title)}</div>
            <textarea id="bc-prompt-input" rows="3" placeholder="${_bcEsc(placeholder||'')}" style="width:100%;background:#0a0a14;border:1px solid #333;border-radius:6px;color:#ccc;font-size:12px;padding:8px;resize:vertical;box-sizing:border-box;"></textarea>
            <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:10px;">
                <button id="bc-prompt-cancel" style="padding:4px 14px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
                <button id="bc-prompt-ok" style="padding:4px 14px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">确定</button>
            </div>
        </div>`;
        document.body.appendChild(m);
        const inp = m.querySelector('#bc-prompt-input');
        setTimeout(() => inp.focus(), 50);
        m.querySelector('#bc-prompt-cancel').onclick = () => { m.remove(); resolve(null); };
        m.querySelector('#bc-prompt-ok').onclick = () => { const v = inp.value; m.remove(); resolve(v); };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = inp.value; m.remove(); resolve(v); } });
    });
}
window._bcPrompt = _bcPrompt;
window.reelsPrompt = _bcPrompt;

async function _bcPromptRowDuplication(indices) {
    if (!indices || !indices.length) return;
    const res = await _bcPrompt('请输入副本版本说明（例如 Hook-B、短版、变体A）', '副本');
    if (res === null) return;
    const tag = res.trim() || '副本';
    _bcDuplicateRows(indices, tag);
}
window._bcPromptRowDuplication = _bcPromptRowDuplication;

function _bcDuplicateRows(indices, versionTag = '副本') {
    if (!indices || !indices.length || !_bulkState?.rows) return [];
    const uniqueSorted = Array.from(new Set(indices.map(Number))).filter(i => !isNaN(i) && i >= 0 && i < _bulkState.rows.length).sort((a, b) => a - b);
    if (!uniqueSorted.length) return [];
    const tag = String(versionTag || '副本').trim() || '副本';

    const cols = _bulkState.columns || [];
    let nameColIdx = cols.findIndex(c => {
        const n = String(c?.name || '').toLowerCase();
        return /导出|命名|文件名|export|filename/.test(n);
    });
    if (nameColIdx < 0) {
        nameColIdx = cols.findIndex(c => {
            const n = String(c?.name || '').toLowerCase();
            return /标题|title|hook|文案/.test(n);
        });
    }

    const newRows = [];
    uniqueSorted.forEach(ri => {
        const srcRow = _bulkState.rows[ri];
        if (!srcRow) return;
        const clonedRow = srcRow.slice();
        clonedRow._versionTag = tag;
        if (nameColIdx >= 0 && nameColIdx < clonedRow.length) {
            const val = clonedRow[nameColIdx] || '';
            clonedRow[nameColIdx] = val ? `${val}_${tag}` : tag;
        } else {
            let modified = false;
            for (let ci = 0; ci < clonedRow.length; ci++) {
                if (cols[ci]?.type !== 'media' && clonedRow[ci]) {
                    clonedRow[ci] = `${clonedRow[ci]}_${tag}`;
                    modified = true;
                    break;
                }
            }
            if (!modified && clonedRow.length > 0) {
                clonedRow[0] = clonedRow[0] ? `${clonedRow[0]}_${tag}` : tag;
            }
        }
        newRows.push(clonedRow);
    });

    if (!newRows.length) return [];
    const insertAfter = uniqueSorted[uniqueSorted.length - 1];
    _bulkState.rows.splice(insertAfter + 1, 0, ...newRows);

    const startRi = insertAfter + 1;
    const endRi = startRi + newRows.length - 1;
    _bcSelection = {
        r1: startRi,
        c1: 0,
        r2: endRi,
        c2: Math.max(0, cols.length - 1)
    };

    if (typeof _bcRenderTable === 'function') _bcRenderTable();
    if (typeof _bcRenderBindings === 'function') _bcRenderBindings();
    if (typeof _bcScheduleDraftSave === 'function') _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        showToast(`已复制 ${newRows.length} 行副本（版本: ${tag}）`, 'success');
    }
    return newRows;
}
window._bcDuplicateRows = _bcDuplicateRows;

// ── Bindable fields from a task's overlays ──
function _bcFieldsFromTask(task) {
    const fields = [];
    const hasBackgroundColumn = (_bulkState.columns || []).some(col =>
        col?.type === 'media'
        && ['image', 'video'].includes(_bcColumnKind(col))
        && /背景|素材|bg|background/i.test(String(col.name || ''))
    );
    if (task.bgPath || task.videoPath || hasBackgroundColumn) {
        fields.push({ key: '__bg__', label: '🎨 背景素材', type: 'media', kinds: ['image', 'video'] });
    }
    if (task.audioPath) {
        fields.push({ key: '__audio__', label: '🎵 人声-音频文件', type: 'media', kinds: ['audio'] });
    }
    if (task.srtPath) {
        fields.push({ key: '__srt__', label: '💬 人声-SRT字幕', type: 'media', kinds: ['subtitle'] });
    }
    if (task.contentVideoPath) {
        fields.push({ key: '__cv__', label: '📹 内容视频', type: 'media', kinds: ['video'] });
    }
    if (_bcTextColumnCandidatesForCategory('ai_source').length > 0 || task.aiScript) {
        fields.push({ key: '__ai__', label: '🧠 人声-原文案', type: 'text', category: 'ai_source' });
    }
    if (_bcTextColumnCandidatesForCategory('dynamic_subtitle').length > 0 || task.txtContent) {
        fields.push({ key: '__txt__', label: '💬 人声-断行文案', type: 'text', category: 'dynamic_subtitle' });
    }
    if (_bcTextColumnCandidatesForCategory('tts_text').length > 0 || task.ttsText) {
        fields.push({ key: '__tts__', label: '🎙️ 人声-配音文案', type: 'text', category: 'tts_text' });
    }
    if (_bcTextColumnCandidatesForCategory('voice_id').length > 0 || task.ttsVoiceId) {
        fields.push({ key: '__voice_id__', label: '🗣️ 人声ID', type: 'text', category: 'voice_id' });
    }
    const overlays = task.overlays || [];
    overlays.forEach((ov, li) => {
        if (ov.fixed_text) return;
        if (ov.type === 'textcard' || !ov.type) {
            fields.push({ key: `L${li}_title_text`, label: `📝 层${li+1} 覆层标题`, type: 'text', category: 'card_title' });
            fields.push({ key: `L${li}_body_text`, label: `📝 层${li+1} 覆层内容`, type: 'text', category: 'card_body' });
            fields.push({ key: `L${li}_footer_text`, label: `📝 层${li+1} 覆层结尾`, type: 'text', category: 'card_footer' });
        } else if (ov.type === 'scroll') {
            fields.push({ key: `L${li}_scroll_title`, label: `📜 层${li+1} 滚动字幕标题`, type: 'text', category: 'scroll_title' });
            fields.push({ key: `L${li}_content`, label: `📜 层${li+1} 滚动字幕正文`, type: 'text', category: 'scroll_body' });
        } else if (ov.type === 'text') {
            fields.push({ key: `L${li}_content`, label: `📝 层${li+1} 普通文本`, type: 'text', category: 'plain_text' });
        }
    });
    fields.push({ key: '__export_name__', label: '📝 导出命名', type: 'text', category: 'export_name' });
    return fields;
}

function _bcFieldAcceptsColumn(field, col) {
    if (!field || !col || col.type !== field.type) return false;
    if (field.type !== 'media' || !field.kinds) return true;
    return field.kinds.includes(_bcColumnKind(col));
}

function _bcClearInvalidBindingsForColumn(ci) {
    const col = _bulkState.columns[ci];
    _bulkState.templates.forEach(tpl => {
        const fields = _bcFieldsFromTask(tpl.task);
        fields.forEach(f => {
            if (tpl.bindings[f.key] === ci && !_bcFieldAcceptsColumn(f, col)) {
                delete tpl.bindings[f.key];
            }
        });
    });
}

function _bcUniqueIndices(indices) {
    const out = [];
    const seen = new Set();
    indices.forEach(i => {
        if (i >= 0 && !seen.has(i)) {
            seen.add(i);
            out.push(i);
        }
    });
    return out;
}

function _bcTextColumnCandidates(names) {
    const hits = [];
    for (const name of names) {
        _bulkState.columns.forEach((c, ci) => {
            if (!c || c.type !== 'text') return;
            if (String(c.name || '').toLowerCase().includes(name)) hits.push(ci);
        });
    }
    return _bcUniqueIndices(hits);
}

function _bcPickCandidateForTemplate(candidates, templateIndex = 0) {
    if (!candidates || candidates.length === 0) return -1;
    return candidates[Math.min(Math.max(templateIndex, 0), candidates.length - 1)];
}

const BC_FIELD_CATEGORY_COLUMN_NAMES = {
    ai_source: ['原始文案', '原始完整文案', '人声-原文案', 'ai源文案', 'ai源', 'ai原文', '原文案', '源文案', 'ai_script', 'aiscript'],
    dynamic_subtitle: ['人声-断行文案', '断行文案', '动态字幕断行后', '断行后', '字幕断行', '字幕文本', '字幕文案', 'txtcontent', 'txt_content'],
    tts_text: ['人声-配音文案', '配音文案', 'tts文案', 'tts_text', 'ttstext', 'voice text'],
    voice_id: ['人声id', '音色id', 'voice id', 'voice_id', 'voiceid', 'ttsvoiceid'],
    card_title: ['文字卡片标题', '卡片标题', '覆层标题', '标题', 'title', 'headline'],
    card_body: ['文字卡片正文', '卡片正文', '覆层内容', '覆层正文', '正文', 'body'],
    card_footer: ['文字卡片结尾', '卡片结尾', '覆层结尾', '结尾', '尾标', 'footer', 'ending'],
    scroll_title: ['滚动字幕标题', '滚动标题', 'scroll_title', 'scroll title'],
    scroll_body: ['滚动字幕正文', '滚动字幕内容', '滚动正文', '滚动内容', 'scroll_body', 'scroll body'],
    plain_text: ['普通文本', '文本', 'text'],
    export_name: ['导出命名', '视频命名', '命名', '文件名', 'exportname', 'export_name', 'filename'],
};

function _bcTextColumnCandidatesForCategory(category) {
    return _bcTextColumnCandidates(BC_FIELD_CATEGORY_COLUMN_NAMES[category] || []);
}

function _bcCandidatesForField(field) {
    return _bcTextColumnCandidatesForCategory(field.category);
}

// ── Auto-bind columns by name matching ──
function _bcAutoBind(task, templateIndex = 0) {
    const bindings = {};
    const fields = _bcFieldsFromTask(task);
    const cols = _bulkState.columns;
    let plainTextOrder = 0;

    fields.forEach(f => {
        if (f.type === 'text') {
            if (['ai_source', 'dynamic_subtitle', 'tts_text'].includes(f.category)) return;
            let fallback = _bcPickCandidateForTemplate(_bcCandidatesForField(f), templateIndex);
            if (fallback < 0 && f.category === 'plain_text') {
                fallback = _bcPickCandidateForTemplate(
                    plainTextOrder++ === 0
                        ? _bcTextColumnCandidates(['标题', 'title', 'headline'])
                        : _bcTextColumnCandidates(['正文', 'body']),
                    templateIndex
                );
            }
            if (fallback >= 0 && _bcFieldAcceptsColumn(f, cols[fallback])) bindings[f.key] = fallback;
        } else {
            const ci = cols.findIndex(c => {
                if (!_bcFieldAcceptsColumn(f, c)) return false;
                const n = c.name.toLowerCase();
                const fk = f.key.replace(/^L\d+_/, '');
                return n.includes(fk) || f.label.toLowerCase().includes(n);
            });
            if (ci >= 0) bindings[f.key] = ci;
        }
    });
    return bindings;
}

function _bcEnsureTemplateBindings(tpl) {
    if (!tpl) return;
    if (!tpl.bindings || typeof tpl.bindings !== 'object') tpl.bindings = {};
    const auto = _bcAutoBind(tpl.task || {}, Math.max(0, _bulkState.templates.indexOf(tpl)));
    for (const [key, value] of Object.entries(auto)) {
        if (tpl.bindings[key] == null) tpl.bindings[key] = value;
    }
}

function _bcFindTextColumnByNames(names) {
    for (const name of names) {
        const ci = _bulkState.columns.findIndex(c => {
            if (!c || c.type !== 'text') return false;
            return String(c.name || '').toLowerCase().includes(name);
        });
        if (ci >= 0) return ci;
    }
    return -1;
}

function _bcAutoRebindTemplate(tpl) {
    if (!tpl) return;
    tpl.bindings = _bcAutoBind(tpl.task || {}, Math.max(0, _bulkState.templates.indexOf(tpl)));
}

function _bcAutoRebindAllTemplates() {
    _bulkState.templates.forEach(_bcAutoRebindTemplate);
    _bcRenderBindings();
    _bcScheduleDraftSave();
}

// Match the complete numbered group, never fall back to another group's text.
function _bcNumberedColumnGroups() {
    const value = (id, fallback) => document.getElementById(id)?.value ?? fallback;
    const prefix = value('bc-header-prefix', 'reels').trim() + value('bc-header-before', '-');
    const after = value('bc-header-after', '-');
    const groups = new Map();
    const namedGroups = (_bulkState.groupAssignments || []).filter(entry => entry.comboName)
        .map(entry => entry.key).sort((a, b) => b.length - a.length);
    _bulkState.columns.forEach((col, ci) => {
        const name = String(col.name || '');
        const namedKey = namedGroups.find(key => name.startsWith(key + after));
        if (namedKey) {
            const fieldName = name.slice(namedKey.length + after.length).trim();
            if (!fieldName) return;
            if (!groups.has(namedKey)) groups.set(namedKey, { key: namedKey, number: groups.size + 1, columns: [] });
            groups.get(namedKey).columns.push({ ci, name: fieldName.toLowerCase() });
            return;
        }
        if (!name.startsWith(prefix)) return;
        const rest = name.slice(prefix.length);
        const match = rest.match(/^-?\d+/);
        if (!match || !rest.slice(match[0].length).startsWith(after)) return;
        const fieldName = rest.slice(match[0].length + after.length).trim();
        if (!fieldName) return;
        const key = prefix + match[0];
        if (!groups.has(key)) groups.set(key, { key, number: Number(match[0]), columns: [] });
        groups.get(key).columns.push({ ci, name: fieldName.toLowerCase() });
    });
    return [...groups.values()].sort((a, b) => a.number - b.number);
}

function _bcBindNumberedGroup(tpl, group) {
    const aliases = {
        ai_source: ['原始文案', '原始完整文案'],
        card_body: ['正文', '内容'],
        scroll_title: ['标题'],
        scroll_body: ['正文', '内容'],
        plain_text: ['内容', '正文'],
    };
    const bindings = { ...(tpl.bindings || {}) };
    _bcFieldsFromTask(tpl.task).forEach(field => {
        const candidates = [...(BC_FIELD_CATEGORY_COLUMN_NAMES[field.category] || []), ...(aliases[field.category] || [])];
        const hit = candidates.map(name => group.columns.find(col => col.name === name.toLowerCase()
            && _bcFieldAcceptsColumn(field, _bulkState.columns[col.ci]))).find(Boolean);
        if (hit) bindings[field.key] = hit.ci;
        else if (field.type === 'text') delete bindings[field.key];
    });
    tpl.bindings = bindings;
}

function _bcAssignNumberedGroups(random = false) {
    const groups = _bcNumberedColumnGroups();
    if (!groups.length) { alert('未找到编号组，请检查表头与上方前缀、连接符设置是否一致。'); return; }
    if (!_bulkState.templates.length) { alert("请先添加模板"); return; }
    // Copy groups drive the assignment count; unused templates remain in the library.
    if (groups.length > _bulkState.templates.length) _bulkState.allowTemplateReuse = true;
    const templateIndices = _bulkState.templates.map((_, index) => index);
    let pool = [];
    if (random) {
        if (_bulkState.allowTemplateReuse) {
            pool = groups.map(() => Math.floor(Math.random() * _bulkState.templates.length));
        } else {
            let shuffled = [];
            while (pool.length < groups.length) {
                if (!shuffled.length) {
                    shuffled = [...templateIndices];
                    for (let i = shuffled.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                    }
                }
                pool.push(shuffled.shift());
            }
        }
    } else {
        if (_bulkState.allowTemplateReuse) {
            pool = groups.map((_, i) => i % _bulkState.templates.length);
        } else {
            pool = groups.map((_, i) => i < templateIndices.length ? templateIndices[i] : -1);
        }
    }
    const previousAssignments = _bulkState.groupAssignments || [];
    _bulkState.groupAssignments = groups.map((group, index) => {
        const rawIdx = pool[index];
        const templateIndex = rawIdx != null ? rawIdx : -1;
        if (templateIndex >= 0 && _bulkState.templates[templateIndex]) {
            _bcBindNumberedGroup(_bulkState.templates[templateIndex], group);
        }
        const previous = previousAssignments.find(entry => entry.key === group.key);
        return {
            key: group.key,
            templateIndex,
            bindings: {},
            backgroundFolder: previous?.backgroundFolder || '',
            backgroundMode: previous?.backgroundMode || 'cycle',
            backgroundSeed: previous?.backgroundSeed,
            musicPath: previous?.musicPath || '',
            musicMode: previous?.musicMode || 'suite'
        };
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const desc = _bulkState.allowTemplateReuse ? '（可重复）' : '（一一配对）';
        showToast(`🎲 已${random ? '随机分配' : '按顺序分配'} ${groups.length} 个编号组的模板${desc}`, 'success');
    }
}

function _bcClearAllTemplateBindings() {
    _bulkState.groupAssignments = null;
    _bulkState.templates.forEach(tpl => { tpl.bindings = {}; });
    _bcRenderBindings();
    _bcScheduleDraftSave();
}

function _bcClearTemplateAssignments() {
    if (!Array.isArray(_bulkState.groupAssignments) || !_bulkState.groupAssignments.length) {
        if (typeof showToast === 'function') showToast('当前没有模板分配', 'info');
        return;
    }
    _bulkState.groupAssignments.forEach(entry => {
        entry.templateIndex = -1;
        entry.bindings = {};
        delete entry.overlayOverrides;
        delete entry.overlayAboveSubtitle;
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') showToast('已清空全部编号组的模板分配', 'info');
}

function _bcClearTemplateLibrary() {
    if (!_bulkState.templates?.length) {
        if (typeof showToast === 'function') showToast('模版库已经是空的', 'info');
        else alert('模版库已经是空的');
        return;
    }
    if (confirm('确定清空模版库中的所有模板？')) {
        _bulkState.templates = [];
        (_bulkState.groupAssignments || []).forEach(entry => {
            entry.templateIndex = -1;
            entry.bindings = {};
            delete entry.overlayOverrides;
            delete entry.overlayAboveSubtitle;
        });
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') showToast('已清空模版库', 'info');
    }
}

function _bcChangeTemplateGroupAssignment(ti, oldGroupKey, newGroupKey) {
    ti = Number(ti);
    if (!Array.isArray(_bulkState.groupAssignments)) _bulkState.groupAssignments = [];
    if (oldGroupKey && oldGroupKey !== newGroupKey) {
        const oldEntry = _bulkState.groupAssignments.find(item => item.key === oldGroupKey);
        if (oldEntry && oldEntry.templateIndex === ti) {
            oldEntry.templateIndex = -1;
            oldEntry.bindings = {};
            delete oldEntry.overlayOverrides;
            delete oldEntry.overlayAboveSubtitle;
        }
    }
    if (newGroupKey) {
        const groups = _bcNumberedColumnGroups();
        const group = groups.find(g => g.key === newGroupKey);
        let newEntry = _bulkState.groupAssignments.find(item => item.key === newGroupKey);
        if (!newEntry) {
            newEntry = { key: newGroupKey, templateIndex: ti, bindings: {}, backgroundMode: 'cycle', musicMode: 'suite' };
            _bulkState.groupAssignments.push(newEntry);
        } else {
            newEntry.templateIndex = ti;
            newEntry.bindings = {};
            delete newEntry.overlayOverrides;
            delete newEntry.overlayAboveSubtitle;
        }
        if (_bulkState.templates[ti] && group) {
            _bcBindNumberedGroup(_bulkState.templates[ti], group);
        }
    }
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const tplLabel = _bulkState.templates[ti]?.label || `模板${ti + 1}`;
        if (newGroupKey) showToast(`✅ 已将「${tplLabel}」分配给 ${newGroupKey}`, 'success');
        else if (oldGroupKey) showToast(`已取消 ${oldGroupKey} 的模板分配，该组已空出`, 'info');
    }
}

function _bcUnassignTemplateFromGroup(groupKey) {
    if (!Array.isArray(_bulkState.groupAssignments)) return;
    const entry = _bulkState.groupAssignments.find(item => item.key === groupKey);
    if (entry && entry.templateIndex >= 0) {
        entry.templateIndex = -1;
        entry.bindings = {};
        delete entry.overlayOverrides;
        delete entry.overlayAboveSubtitle;
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') {
            showToast(`已取消 ${groupKey} 的模板分配，该组已空出`, 'info');
        }
    }
}

function _bcUnassignAllGroupsForTemplate(ti) {
    ti = Number(ti);
    if (!Array.isArray(_bulkState.groupAssignments)) return;
    let changed = false;
    _bulkState.groupAssignments.forEach(entry => {
        if (entry.templateIndex === ti) {
            entry.templateIndex = -1;
            entry.bindings = {};
            delete entry.overlayOverrides;
            delete entry.overlayAboveSubtitle;
            changed = true;
        }
    });
    if (changed) {
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') {
            showToast(`已取消该模板的全部组分配`, 'info');
        }
    }
}

function _bcAssignedTemplate(assignment, group) {
    const source = _bulkState.templates[assignment.templateIndex];
    if (!source || !group) return null;
    if (assignment.backgroundSeed == null) assignment.backgroundSeed = Math.floor(Math.random() * 4294967296);
    const tpl = { ...source, bindings: { ...source.bindings }, assignedBackgroundFolder: assignment.backgroundFolder, assignedBackgroundMode: assignment.backgroundMode, assignedBackgroundFiles: assignment.selectedBackgroundFiles || [], assignedBackgroundSeed: assignment.backgroundSeed };
    tpl.assignedMusicPath = assignment.musicPath || '';
    tpl.assignedMusicMode = assignment.musicMode || 'suite';
    if (Array.isArray(assignment.overlayOverrides)) tpl.task = { ...source.task, overlays: JSON.parse(JSON.stringify(assignment.overlayOverrides)) };
    if (assignment.overlayAboveSubtitle != null) tpl.task = { ...tpl.task, overlayAboveSubtitle: assignment.overlayAboveSubtitle };
    _bcBindNumberedGroup(tpl, group);
    Object.entries(assignment.bindings || {}).forEach(([field, name]) => {
        const ci = _bulkState.columns.findIndex(col => col.name === name);
        if (name != null && ci >= 0) tpl.bindings[field] = ci;
        else delete tpl.bindings[field];
    });
    return tpl;
}

function _bcSetGroupTemplate(key, templateIndex) {
    if (!_bulkState.groupAssignments) _bulkState.groupAssignments = [];
    const entries = _bulkState.groupAssignments;
    let entry = entries.find(item => item.key === key);
    if (!_bulkState.allowTemplateReuse && templateIndex >= 0) {
        const other = entries.find(item => item.key !== key && item.templateIndex === templateIndex);
        if (other) { other.templateIndex = entry?.templateIndex ?? -1; other.bindings = {}; delete other.overlayOverrides; delete other.overlayAboveSubtitle; }
    }
    if (!entry) { entry = { key }; entries.push(entry); }
    entry.templateIndex = templateIndex;
    entry.bindings = {};
    delete entry.overlayOverrides;
    delete entry.overlayAboveSubtitle;
    _bcRenderBindings();
    _bcScheduleDraftSave();
}

function _bcSaveSuiteOverlays(entry, overlays) {
    const old = entry.overlayOverrides || _bulkState.templates[entry.templateIndex]?.task?.overlays || [];
    const bindings = {};
    Object.entries(entry.bindings || {}).forEach(([field, value]) => {
        const match = field.match(/^L(\d+)_(.+)$/);
        if (!match) { bindings[field] = value; return; }
        const id = old[Number(match[1])]?.id;
        const index = overlays.findIndex(overlay => id != null && overlay.id === id);
        if (index >= 0) bindings[`L${index}_${match[2]}`] = value;
    });
    entry.bindings = bindings;
    entry.overlayOverrides = JSON.parse(JSON.stringify(overlays));
}

function _bcAssignBackgroundGroups(random = false) {
    const folders = _bulkState.backgroundFolders.filter(folder => folder.files?.length);
    if (!folders.length) { alert('请先添加含有视频或图片的背景文件夹'); return; }
    const groups = _bcNumberedColumnGroups();
    if (!groups.length) { alert('未找到编号组，请检查表头与上方前缀、连接符设置是否一致。'); return; }
    if (!_bulkState.groupAssignments || !_bulkState.groupAssignments.length) {
        _bcAssignNumberedGroups();
    }
    let pool = [];
    if (random) {
        if (_bulkState.allowBackgroundReuse) {
            pool = groups.map(() => folders[Math.floor(Math.random() * folders.length)].path);
        } else {
            let shuffled = [];
            while (pool.length < groups.length) {
                if (!shuffled.length) {
                    shuffled = [...folders.map(f => f.path)];
                    for (let i = shuffled.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                    }
                }
                pool.push(shuffled.shift());
            }
        }
    } else {
        if (_bulkState.allowBackgroundReuse) {
            pool = groups.map((_, i) => folders[i % folders.length].path);
        } else {
            pool = groups.map((_, i) => i < folders.length ? folders[i].path : '');
        }
    }
    groups.forEach((group, index) => {
        let entry = _bulkState.groupAssignments.find(item => item.key === group.key);
        if (!entry) {
            const templateIndex = _bulkState.templates.length ? (index % _bulkState.templates.length) : -1;
            entry = { key: group.key, templateIndex, bindings: {}, backgroundMode: 'cycle', musicMode: 'suite' };
            _bulkState.groupAssignments.push(entry);
        }
        if (entry.templateIndex < 0 && _bulkState.templates.length) {
            entry.templateIndex = index % _bulkState.templates.length;
        }
        entry.backgroundFolder = pool[index] || '';
        entry.backgroundSeed = Math.floor(Math.random() * 4294967296);
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const desc = _bulkState.allowBackgroundReuse ? '（可重复）' : (folders.length >= groups.length ? '（不重复）' : '（循环轮次不重复）');
        showToast(`已为 ${groups.length} 个编号组${random ? '🎲 随机分配' : '按顺序分配'}背景素材${desc}`, 'success');
    }
}

function _bcRandomizeBackgroundGroups() {
    _bcAssignBackgroundGroups(true);
}

function _bcClearBackgroundAssignments() {
    if (!Array.isArray(_bulkState.groupAssignments) || !_bulkState.groupAssignments.length) {
        if (typeof showToast === 'function') showToast('当前没有背景素材分配', 'info');
        return;
    }
    _bulkState.groupAssignments.forEach(entry => {
        entry.backgroundFolder = '';
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') showToast('已清空全部编号组的背景素材分配', 'info');
}

function _bcAssignMusicGroups(random = false) {
    if (!_bulkState.musicFiles.length) { alert('请先添加配乐文件'); return; }
    const groups = _bcNumberedColumnGroups();
    if (!groups.length) { alert('未找到编号组，请检查表头与上方前缀、连接符设置是否一致。'); return; }
    if (!_bulkState.groupAssignments || !_bulkState.groupAssignments.length) {
        _bcAssignNumberedGroups();
    }
    let pool = [];
    if (random) {
        if (_bulkState.allowMusicReuse) {
            pool = groups.map(() => _bulkState.musicFiles[Math.floor(Math.random() * _bulkState.musicFiles.length)].path);
        } else {
            let shuffled = [];
            while (pool.length < groups.length) {
                if (!shuffled.length) {
                    shuffled = [..._bulkState.musicFiles.map(f => f.path)];
                    for (let i = shuffled.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                    }
                }
                pool.push(shuffled.shift());
            }
        }
    } else {
        if (_bulkState.allowMusicReuse) {
            pool = groups.map((_, i) => _bulkState.musicFiles[i % _bulkState.musicFiles.length].path);
        } else {
            pool = groups.map((_, i) => i < _bulkState.musicFiles.length ? _bulkState.musicFiles[i].path : '');
        }
    }
    groups.forEach((group, index) => {
        let entry = _bulkState.groupAssignments.find(item => item.key === group.key);
        if (!entry) {
            const templateIndex = _bulkState.templates.length ? (index % _bulkState.templates.length) : -1;
            entry = { key: group.key, templateIndex, bindings: {}, backgroundMode: 'cycle', musicMode: 'suite' };
            _bulkState.groupAssignments.push(entry);
        }
        if (entry.templateIndex < 0 && _bulkState.templates.length) {
            entry.templateIndex = index % _bulkState.templates.length;
        }
        entry.musicPath = pool[index] || '';
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const desc = _bulkState.allowMusicReuse ? '（可重复）' : '（不重复）';
        showToast(`已为 ${groups.length} 个编号组${random ? '🎲 随机分配' : '按顺序分配'}配乐${desc}`, 'success');
    }
}

function _bcRandomizeMusicGroups() {
    if (!_bulkState.musicFiles.length) { alert('请先添加配乐文件'); return; }
    const groups = _bcNumberedColumnGroups();
    if (!groups.length) { alert('未找到编号组，请检查表头与上方前缀、连接符设置是否一致。'); return; }
    if (!_bulkState.groupAssignments || !_bulkState.groupAssignments.length) {
        _bcAssignNumberedGroups();
    }
    groups.forEach((group, index) => {
        let entry = _bulkState.groupAssignments.find(item => item.key === group.key);
        if (!entry) {
            const templateIndex = _bulkState.templates.length ? (index % _bulkState.templates.length) : -1;
            entry = { key: group.key, templateIndex, bindings: {}, backgroundMode: 'cycle', musicMode: 'suite' };
            _bulkState.groupAssignments.push(entry);
        }
        const song = _bulkState.musicFiles[Math.floor(Math.random() * _bulkState.musicFiles.length)];
        entry.musicPath = song.path;
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        showToast(`已为 ${groups.length} 个编号组🎲 随机分配配乐`, 'success');
    }
}

function _bcClearMusicAssignments() {
    if (!Array.isArray(_bulkState.groupAssignments) || !_bulkState.groupAssignments.length) {
        if (typeof showToast === 'function') showToast('当前没有配乐分配', 'info');
        return;
    }
    _bulkState.groupAssignments.forEach(entry => {
        entry.musicPath = '';
    });
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') showToast('已清空全部编号组的配乐分配', 'info');
}

function _bcChangeFolderGroupAssignment(folderPath, oldGroupKey, newGroupKey) {
    if (!Array.isArray(_bulkState.groupAssignments)) _bulkState.groupAssignments = [];
    if (oldGroupKey && oldGroupKey !== newGroupKey) {
        const oldEntry = _bulkState.groupAssignments.find(item => item.key === oldGroupKey);
        if (oldEntry && oldEntry.backgroundFolder === folderPath) {
            oldEntry.backgroundFolder = '';
        }
    }
    if (newGroupKey) {
        const groups = _bcNumberedColumnGroups();
        const groupIndex = groups.findIndex(g => g.key === newGroupKey);
        let newEntry = _bulkState.groupAssignments.find(item => item.key === newGroupKey);
        if (!newEntry) {
            const templateIndex = _bulkState.templates.length ? (Math.max(0, groupIndex) % _bulkState.templates.length) : -1;
            newEntry = { key: newGroupKey, templateIndex, bindings: {}, backgroundMode: 'cycle', musicMode: 'suite' };
            _bulkState.groupAssignments.push(newEntry);
        }
        if (newEntry.templateIndex < 0 && _bulkState.templates.length) {
            newEntry.templateIndex = Math.max(0, groupIndex) % _bulkState.templates.length;
        }
        newEntry.backgroundFolder = folderPath;
        newEntry.backgroundSeed = Math.floor(Math.random() * 4294967296);
    }
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const folderName = _bcFileName(folderPath);
        if (newGroupKey) {
            showToast(`✅ 已将「${folderName}」分配给 ${newGroupKey}`, 'success');
        } else if (oldGroupKey) {
            showToast(`已取消 ${oldGroupKey} 的背景素材分配，该组已空出`, 'info');
        }
    }
}

function _bcUnassignFolderFromGroup(groupKey) {
    if (!Array.isArray(_bulkState.groupAssignments)) return;
    const entry = _bulkState.groupAssignments.find(item => item.key === groupKey);
    if (entry && entry.backgroundFolder) {
        entry.backgroundFolder = '';
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') {
            showToast(`已取消 ${groupKey} 的背景素材分配，该组已空出`, 'info');
        }
    }
}

function _bcUnassignAllFoldersForPath(folderPath) {
    if (!Array.isArray(_bulkState.groupAssignments)) return;
    let changed = false;
    _bulkState.groupAssignments.forEach(entry => {
        if (entry.backgroundFolder === folderPath) {
            entry.backgroundFolder = '';
            changed = true;
        }
    });
    if (changed) {
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') {
            showToast(`已取消该素材分类的全部组分配`, 'info');
        }
    }
}

function _bcChangeMusicGroupAssignment(musicPath, oldGroupKey, newGroupKey) {
    if (!Array.isArray(_bulkState.groupAssignments)) _bulkState.groupAssignments = [];
    if (oldGroupKey && oldGroupKey !== newGroupKey) {
        const oldEntry = _bulkState.groupAssignments.find(item => item.key === oldGroupKey);
        if (oldEntry && oldEntry.musicPath === musicPath) {
            oldEntry.musicPath = '';
        }
    }
    if (newGroupKey) {
        const groups = _bcNumberedColumnGroups();
        const groupIndex = groups.findIndex(g => g.key === newGroupKey);
        let newEntry = _bulkState.groupAssignments.find(item => item.key === newGroupKey);
        if (!newEntry) {
            const templateIndex = _bulkState.templates.length ? (Math.max(0, groupIndex) % _bulkState.templates.length) : -1;
            newEntry = { key: newGroupKey, templateIndex, bindings: {}, backgroundMode: 'cycle', musicMode: 'suite' };
            _bulkState.groupAssignments.push(newEntry);
        }
        newEntry.musicPath = musicPath;
    }
    _bcRenderBindings();
    _bcScheduleDraftSave();
    if (typeof showToast === 'function') {
        const musicName = _bcFileName(musicPath);
        if (newGroupKey) showToast(`✅ 已将配乐「${musicName}」分配给 ${newGroupKey}`, 'success');
        else if (oldGroupKey) showToast(`已取消 ${oldGroupKey} 的配乐分配，该组已空出`, 'info');
    }
}

function _bcUnassignMusicFromGroup(groupKey) {
    if (!Array.isArray(_bulkState.groupAssignments)) return;
    const entry = _bulkState.groupAssignments.find(item => item.key === groupKey);
    if (entry && entry.musicPath) {
        entry.musicPath = '';
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') {
            showToast(`已取消 ${groupKey} 的配乐分配，该组已空出`, 'info');
        }
    }
}

function _bcUnassignAllMusicForPath(musicPath) {
    if (!Array.isArray(_bulkState.groupAssignments)) return;
    let changed = false;
    _bulkState.groupAssignments.forEach(entry => {
        if (entry.musicPath === musicPath) {
            entry.musicPath = '';
            changed = true;
        }
    });
    if (changed) {
        _bcRenderBindings();
        _bcScheduleDraftSave();
        if (typeof showToast === 'function') {
            showToast(`已取消该配乐的全部组分配`, 'info');
        }
    }
}

let _bcAudioPreview = null;
let _bcCurrentPlayingMusic = null;

function _bcToggleMusicPreview(audioPath) {
    if (_bcAudioPreview && _bcCurrentPlayingMusic === audioPath) {
        _bcAudioPreview.pause();
        _bcAudioPreview = null;
        _bcCurrentPlayingMusic = null;
        _bcRenderBindings();
        return;
    }
    if (_bcAudioPreview) {
        _bcAudioPreview.pause();
        _bcAudioPreview = null;
        _bcCurrentPlayingMusic = null;
    }
    try {
        const url = _bcFileUrl(audioPath);
        _bcAudioPreview = new Audio(url);
        _bcCurrentPlayingMusic = audioPath;
        _bcAudioPreview.onended = () => {
            _bcAudioPreview = null;
            _bcCurrentPlayingMusic = null;
            _bcRenderBindings();
        };
        _bcAudioPreview.onerror = () => {
            _bcAudioPreview = null;
            _bcCurrentPlayingMusic = null;
            _bcRenderBindings();
        };
        _bcAudioPreview.play().catch(err => {
            console.warn('[BulkCreate] Audio play error:', err);
        });
        _bcRenderBindings();
    } catch (e) {
        console.warn('[BulkCreate] Audio error:', e);
    }
}

function _bcRenderItemAssignControls(options) {
    const { kind, itemVal, assignedKeys, freeGroups, allGroups } = options;
    const count = assignedKeys.length;
    if (!allGroups.length) {
        return `<select disabled style="flex:1;min-width:0;padding:2px 6px;background:#12121c;color:#666;border:1px solid #333;border-radius:4px;font-size:10px;"><option>未检测到编号组</option></select>`;
    }
    if (count === 1) {
        const currentKey = assignedKeys[0];
        return `<select class="bc-${kind}-assign-group" data-${kind}="${_bcEsc(itemVal)}" data-current-group="${_bcEsc(currentKey)}" style="flex:1;min-width:0;padding:2px 6px;background:#16162a;color:#d8cfff;border:1px solid #7c5cff;border-radius:4px;font-size:10px;cursor:pointer;" title="当前分配给 ${currentKey}；可切换到其他空闲组或取消分配">
            <option value="">⚪ 取消分配（空出该组）</option>
            <option value="${_bcEsc(currentKey)}" selected>🎯 ${_bcEsc(currentKey)}（当前组）</option>
            ${freeGroups.map(g => `<option value="${_bcEsc(g.key)}">${_bcEsc(g.key)}（可分配）</option>`).join('')}
        </select>
        <button class="bc-${kind}-unassign" data-group="${_bcEsc(currentKey)}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.3);border-radius:4px;color:#ff8888;flex-shrink:0;" title="取消分配给 ${currentKey}，释放该组">取消分配</button>`;
    }
    if (count === 0) {
        return `<select class="bc-${kind}-assign-group" data-${kind}="${_bcEsc(itemVal)}" data-current-group="" style="flex:1;min-width:0;padding:2px 6px;background:#12121c;color:#8e8ea8;border:1px dashed #44445c;border-radius:4px;font-size:10px;cursor:pointer;" title="选择要分配的编号组（仅显示尚未分配的空闲组）">
            <option value="" selected>⚪ 未分配（点击选择分配组）</option>
            ${freeGroups.length
                ? freeGroups.map(g => `<option value="${_bcEsc(g.key)}">${_bcEsc(g.key)}</option>`).join('')
                : '<option value="" disabled>全部编号组均已有分配</option>'}
        </select>`;
    }
    return `<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;flex:1;min-width:0;">
        ${assignedKeys.map(k => `<span style="display:inline-flex;align-items:center;gap:3px;background:rgba(124,92,255,0.22);border:1px solid rgba(124,92,255,0.5);border-radius:3px;padding:1px 5px;color:#d8cfff;font-size:10px;">${_bcEsc(k)} <span class="bc-${kind}-unassign" data-group="${_bcEsc(k)}" style="cursor:pointer;color:#ff8888;font-weight:bold;margin-left:2px;" title="取消分配给 ${k}">✕</span></span>`).join('')}
        <select class="bc-${kind}-assign-group" data-${kind}="${_bcEsc(itemVal)}" data-current-group="" style="padding:2px 6px;background:#181828;color:#b9aaff;border:1px solid #554488;border-radius:4px;font-size:10px;cursor:pointer;" title="追加分配给其他空闲组">
            <option value="" selected>+ 追加组...</option>
            ${freeGroups.map(g => `<option value="${_bcEsc(g.key)}">${_bcEsc(g.key)}</option>`).join('')}
        </select>
    </div>
    <button class="bc-${kind}-unassign-all" data-${kind}="${_bcEsc(itemVal)}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.3);border-radius:4px;color:#ff8888;flex-shrink:0;" title="全部取消分配">全部取消</button>`;
}

function _bcVisualPicker(kind, selected, choose) {
    const isPicker = typeof choose === 'function';
    const templates = kind === 'template';
    const music = kind === 'music';
    const items = templates ? _bulkState.templates : (music ? _bulkState.musicFiles : _bulkState.backgroundFolders);
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;inset:0;z-index:410000;background:#101018;color:#ddd;padding:20px;display:flex;flex-direction:column;gap:12px;';
    const label = templates ? (isPicker ? '看图选模板' : '模版库') : (music ? (isPicker ? '试听选配乐' : '配乐库') : (isPicker ? '看图选背景' : '背景库浏览'));
    const suffix = templates ? '个模板' : (music ? '首配乐' : '组背景');
    const action = templates ? '模板' : (music ? '配乐' : '背景');
    panel.innerHTML = `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;"><strong>${label}</strong><span>共 ${items.length} ${suffix}${isPicker ? `，向下滚动浏览；点击卡片替换整套${action}` : '；可向下滚动并左右滑动查看各背景素材'}</span>${!isPicker || templates ? '' : `<button data-default>${music ? '不使用指定配乐' : '沿用模板背景'}</button>`}<button data-close>返回</button></div><div data-cards style="overflow:auto;flex:1;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;align-content:start;"></div>`;
    document.body.appendChild(panel);
    ['click', 'mousedown', 'keydown'].forEach(type => panel.addEventListener(type, event => event.stopPropagation()));
    const get = selector => panel.querySelector(selector);
    let revision = 0;
    const cleanup = () => {
        revision++;
        panel.querySelectorAll('video').forEach(video => { video.pause(); video.removeAttribute('src'); video.load(); });
    };
    const close = () => { cleanup(); panel.remove(); };
    const select = value => { close(); if (isPicker) choose(value); };
    const render = () => {
        cleanup();
        const token = revision;
        const grid = get('[data-cards]'); grid.innerHTML = '';
        items.forEach((item, index) => {
            const value = templates ? index : item.path;
            const active = value === selected;
            const card = document.createElement('button');
            card.style.cssText = `background:#20202c;color:#ddd;border:2px solid ${active ? '#a78bfa' : '#444'};border-radius:8px;padding:10px;text-align:left;cursor:${isPicker ? 'pointer' : 'default'};min-width:0;`;
            card.innerHTML = `<div data-images style="display:flex;gap:6px;overflow-x:auto;"></div><div style="margin-top:8px;font-weight:bold;">${active ? '✓ 当前 · ' : ''}${_bcEsc(templates ? item.label : item.name)}</div><div data-status style="font-size:12px;color:#aaa;"></div>`;
            grid.appendChild(card);
            if (isPicker) card.onclick = () => select(value);
            const images = card.querySelector('[data-images]');
            const status = card.querySelector('[data-status]');
            if (templates) {
                const img = document.createElement('img');
                img.style.cssText = 'width:100%;height:300px;object-fit:contain;background:#14141e;';
                images.appendChild(img); status.textContent = '正在加载模板样式…';
                _bcRenderTemplateThumb(item.task?.overlays || []).then(url => {
                    if (!panel.isConnected || revision !== token) return;
                    if (url) { img.src = url; status.textContent = '样式示意；选中后左侧显示本组实际文案'; }
                    else status.textContent = '此模板暂无覆层缩略图，点击查看实际效果';
                }).catch(() => { if (panel.isConnected && revision === token) status.textContent = '缩略图加载失败，可点击查看实际效果'; });
            } else if (music) {
                const audio = document.createElement('audio');
                audio.controls = true;
                audio.preload = 'metadata';
                audio.src = _bcFileUrl(item.path);
                audio.addEventListener('click', event => event.stopPropagation());
                images.appendChild(audio);
                status.textContent = '点击播放试听；点击卡片即选用。';
            } else {
                status.textContent = `${item.files.length} 个素材 · 左右滚动查看素材缩略图`;
                // Browser lazy images and metadata-only videos avoid starting playback for the library.
                item.files.forEach(path => {
                    const media = document.createElement(_bcMediaKind(path) === 'image' ? 'img' : 'video');
                    media.style.cssText = 'flex:0 0 130px;width:130px;height:220px;object-fit:cover;background:#111;border-radius:4px;';
                    media.title = `${_bcFileName(path)}${media.tagName === 'VIDEO' ? '（点击播放/暂停）' : ''}`;
                    if (media.tagName === 'VIDEO') {
                        media.muted = true;
                        media.preload = 'none';
                        media.playsInline = true;
                        media.style.cursor = 'pointer';
                        media.onclick = e => {
                            e.stopPropagation();
                            if (media.paused) media.play().catch(() => {});
                            else media.pause();
                        };
                    } else {
                        media.loading = 'lazy';
                    }
                    media.dataset.path = path;
                    images.appendChild(media);
                });
                const loadVisible = () => {
                    const bounds = images.getBoundingClientRect();
                    images.querySelectorAll('[data-path]').forEach(media => {
                        const rect = media.getBoundingClientRect();
                        if (rect.right >= bounds.left && rect.left <= bounds.right && !media.getAttribute('src')) {
                            if (media.tagName === 'VIDEO') media.preload = 'auto';
                            media.src = _bcFileUrl(media.dataset.path);
                        } else if ((rect.right < bounds.left || rect.left > bounds.right) && media.tagName === 'VIDEO' && media.getAttribute('src')) {
                            media.pause(); media.removeAttribute('src'); media.load();
                        }
                    });
                };
                images.addEventListener('scroll', loadVisible); loadVisible();
            }
            if (active) {
                setTimeout(() => card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
            }
        });
    };
    get('[data-close]').onclick = close;
    if (!templates && isPicker && get('[data-default]')) get('[data-default]').onclick = () => select('');
    render();
}

function _bcEditTemplateOverlays(ti) {
    const tpl = _bulkState.templates[ti];
    if (!tpl) return;
    if (typeof ReelsOverlayPanel === 'undefined' || !window.ReelsOverlay?.OverlayManager) {
        alert('覆层编辑器尚未加载');
        return;
    }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:450000;background:#000d;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `<div style="background:#181822;padding:16px;border-radius:10px;display:flex;gap:16px;max-height:94vh;max-width:96vw;overflow:auto;color:#ddd;">
        <div style="position:relative;width:min(40vw,360px);aspect-ratio:9/16;background:#000;align-self:flex-start;">
            <video data-bg-video muted loop playsinline style="position:absolute;width:100%;height:100%;object-fit:cover;"></video>
            <img data-bg-image style="position:absolute;width:100%;height:100%;object-fit:cover;display:none;">
            <canvas width="1080" height="1920" style="position:absolute;width:100%;height:100%;pointer-events:none;"></canvas>
        </div>
        <div style="width:280px;display:flex;flex-direction:column;gap:10px;font-size:13px;">
            <strong>✏️ 编辑模板「<span data-tpl-label>${_bcEsc(tpl.label)}</span>」</strong>
            <label>模板名称 <input data-tpl-name value="${_bcEsc(tpl.label)}" style="width:100%;background:#10101b;color:#ddd;border:1px solid #444;border-radius:4px;padding:3px 6px;"></label>
            <label>预览秒数 <input data-time type="number" min="0" value="0" step="0.5" style="width:80px;"></label>
            <button data-play>播放 / 暂停背景</button>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
                <button data-save-preset style="padding:4px 10px;background:rgba(245,158,11,0.2);border:1px solid #f59e0b;border-radius:4px;color:#fcd34d;cursor:pointer;font-size:11px;">💾 存为预设</button>
            </div>
            <div data-status style="color:#b9aaff;">修改立即同步并保存草稿</div>
            <div style="color:#999;font-size:11px;">右侧修改覆层参数后，将自动作为该模板的基础样式，使用该模板的编号组将自动应用。</div>
            <button data-close style="margin-top:auto;padding:6px;background:linear-gradient(135deg,#7c5cff,#a855f7);color:#fff;border:none;border-radius:5px;cursor:pointer;font-weight:600;">完成并保存</button>
        </div>
        <div data-host style="width:460px;min-width:380px;max-height:85vh;overflow:auto;border-left:1px solid #444;padding-left:12px;">
            <div style="color:#b9aaff;padding:8px;font-size:11px;">可以直接添加、删除、调整覆层。修改将直接更新此模板。</div>
            <div data-panel></div>
        </div>
    </div>`;
    document.body.appendChild(modal);
    ['click', 'mousedown', 'keydown'].forEach(type => modal.addEventListener(type, event => event.stopPropagation()));

    const get = selector => modal.querySelector(selector);
    const video = get('[data-bg-video]'), img = get('[data-bg-image]'), canvas = get('canvas');
    const localTask = JSON.parse(JSON.stringify(tpl.task || {}));
    if (!Array.isArray(localTask.overlays)) localTask.overlays = [];
    const mgr = new window.ReelsOverlay.OverlayManager();
    mgr.overlays = localTask.overlays;

    const path = localTask.bgPath || localTask.videoPath || '';
    const isImage = _bcMediaKind(path) === 'image';
    img.style.display = isImage ? 'block' : 'none'; video.style.display = isImage ? 'none' : 'block';
    if (path) (isImage ? img : video).src = _bcFileUrl(path);

    const draw = () => {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, 1080, 1920);
        const time = Math.max(0, Number(get('[data-time]').value) || 0);
        (mgr.overlays || []).forEach(overlay => ReelsOverlay.drawOverlay(ctx, { ...overlay, _exporting: true }, time, 1080, 1920));
    };

    const saveChanges = () => {
        localTask.overlays = mgr.overlays;
        tpl.task.overlays = JSON.parse(JSON.stringify(mgr.overlays));
        if (localTask.overlayAboveSubtitle != null) {
            tpl.task.overlayAboveSubtitle = localTask.overlayAboveSubtitle;
        }
        tpl.bindings = typeof _bcAutoBind === 'function' ? _bcAutoBind(tpl.task, ti) : (tpl.bindings || {});
        _bcScheduleDraftSave();
        draw();
    };

    let suitePanel = null;
    const proxy = {
        overlayMgr: mgr, scopedTask: localTask,
        getOverlayAboveSubtitle: () => localTask.overlayAboveSubtitle !== false,
        setOverlayAboveSubtitle(value) { localTask.overlayAboveSubtitle = value; tpl.task.overlayAboveSubtitle = value; saveChanges(); },
        getCanvasSize: () => ({ w: 1080, h: 1920, cx: 540, cy: 960 }),
        getDuration: () => Number.isFinite(video.duration) ? video.duration : 9999,
        previewEnd(active) { get('[data-time]').value = active ? String(Number.isFinite(video.duration) ? video.duration : 10) : '0'; draw(); },
        addOverlay(overlay) { mgr.addOverlay(overlay); saveChanges(); suitePanel?._refreshList(); },
        removeOverlay(id) { mgr.removeOverlay(id); saveChanges(); suitePanel?._refreshList(); },
        render: saveChanges,
    };
    suitePanel = new ReelsOverlayPanel(get('[data-panel]'), proxy);
    modal.querySelectorAll('#rop-group-preset-update,#rop-group-preset-del,#rop-group-preset-rename,#rop-batch-import').forEach(el => { el.style.display = 'none'; });
    suitePanel._refreshList();
    if (mgr.overlays[0]) suitePanel.selectOverlay(mgr.overlays[0]);
    draw();

    get('[data-time]').oninput = () => { video.currentTime = Math.max(0, Number(get('[data-time]').value) || 0); draw(); };
    get('[data-play]').onclick = () => video.paused ? video.play().catch(() => {}) : video.pause();
    const tplNameInput = get('[data-tpl-name]');
    if (tplNameInput) {
        const syncTplName = (e) => {
            const rawVal = e.target.value || '';
            const val = rawVal.trim();
            if (val) {
                tpl.label = val;
                const lbl = get('[data-tpl-label]');
                if (lbl) lbl.textContent = val;
                _bcScheduleDraftSave();
            }
        };
        tplNameInput.oninput = syncTplName;
        tplNameInput.onchange = syncTplName;
        tplNameInput.addEventListener('keydown', e => e.stopPropagation());
    }
    get('[data-save-preset]').onclick = () => {
        const name = prompt('输入预设名称：', tpl.label);
        if (!name || !name.trim()) return;
        let presets = {};
        try { presets = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}'); } catch(e) {}
        presets[name.trim()] = {
            name: name.trim(),
            createdAt: new Date().toISOString(),
            layers: JSON.parse(JSON.stringify(mgr.overlays)),
            overlayAboveSubtitle: localTask.overlayAboveSubtitle !== false,
        };
        localStorage.setItem('reels_overlay_group_presets', JSON.stringify(presets));
        alert(`✅ 已保存到覆层预设「${name.trim()}」`);
    };

    get('[data-close]').onclick = () => {
        const nameInput = get('[data-tpl-name]');
        if (nameInput && nameInput.value.trim()) tpl.label = nameInput.value.trim();
        saveChanges();
        _bcSaveDraftNow();
        if (suitePanel?._renderRaf) cancelAnimationFrame(suitePanel._renderRaf);
        suitePanel = null;
        video.pause(); video.removeAttribute('src'); video.load();
        modal.remove();
        _bcRenderBindings();
    };
}

function _bcPreviewGroup(key, initialRow = null, onClose = null) {
    const group = _bcNumberedColumnGroups().find(item => item.key === key);
    const entry = _bulkState.groupAssignments?.find(item => item.key === key);
    if (!group || !entry || entry.templateIndex < 0) { alert('请先为本组分配模板'); return; }
    if (typeof ReelsOverlay === 'undefined') { alert('预览渲染器尚未加载'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:400000;background:#000d;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `<div style="background:#181822;padding:16px;border-radius:10px;display:flex;gap:16px;max-height:94vh;max-width:96vw;overflow:auto;color:#ddd;">
        <div style="position:relative;width:min(40vw,360px);aspect-ratio:9/16;background:#000;align-self:flex-start;flex-shrink:0;">
            <video data-bg-video muted loop playsinline style="position:absolute;width:100%;height:100%;object-fit:cover;"></video>
            <img data-bg-image style="position:absolute;width:100%;height:100%;object-fit:cover;display:none;">
            <canvas width="1080" height="1920" style="position:absolute;width:100%;height:100%;pointer-events:none;"></canvas>
        </div>
        <div style="width:330px;min-width:300px;display:flex;flex-direction:column;gap:10px;font-size:12.5px;max-height:90vh;overflow-y:auto;padding-right:4px;">
            <strong style="font-size:14px;color:#fff;">${_bcEsc(key)} · 文案与背景预览</strong>
            <div style="display:flex;align-items:center;gap:6px;">
                <label style="font-weight:600;color:#c4b5fd;font-size:11.5px;flex-shrink:0;">数据行</label>
                <select data-row style="flex:1;min-width:0;background:#141525;color:#e2e8f0;border:1px solid #363852;border-radius:4px;height:26px;font-size:11px;padding:0 6px;"></select>
            </div>

            <!-- ✏️ 实时编辑文案区块 -->
            <div data-edit-copy-section style="background:rgba(124,92,255,0.06);border:1px solid rgba(124,92,255,0.22);border-radius:8px;padding:9px;display:flex;flex-direction:column;gap:7px;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
                    <span style="font-weight:700;color:#c4b5fd;font-size:11.5px;display:inline-flex;align-items:center;gap:4px;">✏️ 实时修改文案（同步表格）</span>
                    <span data-copy-sync-tip style="font-size:10px;color:#34d399;font-weight:600;display:none;background:rgba(52,211,153,0.12);padding:1px 5px;border-radius:3px;border:1px solid rgba(52,211,153,0.3);">✓ 已同步</span>
                </div>
                <div data-copy-fields-container style="display:flex;flex-direction:column;gap:7px;"></div>
            </div>

            <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#94a3b8;">模板
                <div style="display:flex;gap:4px;">
                    <select data-template style="flex:1;min-width:0;background:#141525;color:#e2e8f0;border:1px solid #363852;border-radius:4px;height:24px;font-size:11px;padding:0 6px;"></select>
                    <button data-pick-template class="bc-btn bc-btn-purple bc-btn-xs" style="flex-shrink:0;">🖼 看图换模板</button>
                </div>
            </label>
            <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#94a3b8;">背景分类
                <div style="display:flex;gap:4px;">
                    <select data-folder style="flex:1;min-width:0;background:#141525;color:#e2e8f0;border:1px solid #363852;border-radius:4px;height:24px;font-size:11px;padding:0 6px;"></select>
                    <button data-pick-folder class="bc-btn bc-btn-purple bc-btn-xs" style="flex-shrink:0;">🖼 看图换分类</button>
                </div>
            </label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
                <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#94a3b8;">配乐模式
                    <select data-music-mode style="background:#141525;color:#e2e8f0;border:1px solid #363852;border-radius:4px;height:24px;font-size:11px;padding:0 4px;"><option value="suite">整套共用一首</option><option value="cycle">每条轮流配乐</option></select>
                </label>
                <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#94a3b8;">预览秒数
                    <input data-time type="number" min="0" value="0" step="0.5" style="width:100%;box-sizing:border-box;background:#141525;color:#e2e8f0;border:1px solid #363852;border-radius:4px;height:24px;font-size:11px;padding:0 6px;">
                </label>
            </div>
            <label style="display:flex;flex-direction:column;gap:3px;font-size:11px;color:#94a3b8;">整套配乐
                <div style="display:flex;gap:4px;">
                    <select data-music style="flex:1;min-width:0;background:#141525;color:#e2e8f0;border:1px solid #363852;border-radius:4px;height:24px;font-size:11px;padding:0 6px;"></select>
                    <button data-pick-music class="bc-btn bc-btn-emerald bc-btn-xs" style="flex-shrink:0;">🎵 试听</button>
                </div>
            </label>
            <audio data-music-player controls style="width:100%;display:none;margin-top:2px;"></audio>
            <div style="display:flex;gap:6px;margin-top:2px;">
                <button data-play class="bc-btn bc-btn-default bc-btn-sm" style="flex:1;">播放 / 暂停背景</button>
                <button data-edit-overlays class="bc-btn bc-btn-purple bc-btn-sm" style="flex:1;">⚙ 覆层排版参数</button>
            </div>
            <div data-status style="color:#b9aaff;font-size:10.5px;margin-top:2px;"></div>
            <div style="color:#717496;font-size:10px;line-height:1.35;">修改文案会立即同步到外层表格；拼接模式展示首个素材，完整效果生成任务后检查。</div>
            <button data-close class="bc-btn bc-btn-primary" style="margin-top:4px;height:30px;font-size:12px;">完成预览</button>
        </div></div>`;
    document.body.appendChild(modal);
    const get = selector => modal.querySelector(selector);
    const video = get('[data-bg-video]'), img = get('[data-bg-image]'), canvas = get('canvas');
    const rows = _bulkState.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.some(cell => String(cell || '').trim()));
    get('[data-row]').innerHTML = rows.map(({ index }, i) => `<option value="${i}">第 ${index + 1} 行</option>`).join('');
    if (initialRow != null) get('[data-row]').value = String(Math.max(0, rows.findIndex(item => item.index === initialRow)));
    const syncOptions = () => {
        get('[data-template]').innerHTML = _bulkState.templates.map((tpl, i) => `<option value="${i}" ${entry.templateIndex === i ? 'selected' : ''}>${_bcEsc(tpl.label)}</option>`).join('');
        get('[data-folder]').innerHTML = '<option value="">沿用模板背景</option>' + _bulkState.backgroundFolders.map(folder => `<option value="${_bcEsc(folder.path)}" ${entry.backgroundFolder === folder.path ? 'selected' : ''}>${_bcEsc(folder.name)}</option>`).join('');
        get('[data-music]').innerHTML = '<option value="">沿用模板 / 不指定配乐</option>' + _bulkState.musicFiles.map(music => `<option value="${_bcEsc(music.path)}" ${entry.musicPath === music.path ? 'selected' : ''}>${_bcEsc(music.name)}</option>`).join('');
        get('[data-music-mode]').value = entry.musicMode || 'suite';
        get('[data-music]').disabled = entry.musicMode === 'cycle';
        get('[data-pick-music]').disabled = entry.musicMode === 'cycle';
    };
    let task = null, timer = null, suitePanel = null, suiteHost = null;
    const closeSuitePanel = () => {
        if (suitePanel?._renderRaf) cancelAnimationFrame(suitePanel._renderRaf);
        if (suitePanel) suitePanel.videoCanvas = null;
        suitePanel = null; suiteHost?.remove(); suiteHost = null;
    };
    const draw = () => {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, 1080, 1920);
        if (!task) return;
        const time = Math.max(0, Number(get('[data-time]').value) || 0);
        (task.overlays || []).forEach(overlay => ReelsOverlay.drawOverlay(ctx, { ...overlay, _exporting: true }, time, 1080, 1920));
    };
    const renderBoundTextEditors = () => {
        const container = get('[data-copy-fields-container]');
        if (!container) return;
        const tpl = _bcAssignedTemplate(entry, group);
        const ri = Number(get('[data-row]').value) || 0;
        if (!tpl || !rows[ri]) {
            container.innerHTML = '<div style="color:#717496;font-size:11px;">本组暂无可编辑的文案</div>';
            return;
        }
        const actualRowIndex = rows[ri].index;
        const currentRow = _bulkState.rows[actualRowIndex] || [];
        const fields = _bcFieldsFromTask(tpl.task || {});
        const boundTextFields = fields.filter(f => {
            if (f.type !== 'text') return false;
            const ci = tpl.bindings?.[f.key];
            return ci != null && ci >= 0 && ci < _bulkState.columns.length;
        });

        if (boundTextFields.length === 0) {
            container.innerHTML = '<div style="color:#717496;font-size:10.5px;line-height:1.4;">当前模板暂未绑定文本列<br><span style="color:#94a3b8;font-size:10px;">可在编号组卡片中指定绑定的表格列。</span></div>';
            return;
        }

        container.innerHTML = boundTextFields.map(f => {
            const ci = tpl.bindings[f.key];
            const colName = _bulkState.columns[ci]?.name || `列 ${ci + 1}`;
            const val = currentRow[ci] || '';
            const isMultiline = f.key.includes('body') || f.key.includes('content') || f.key === '__ai__' || f.key === '__txt__' || f.key === '__tts__';
            return `<div style="display:flex;flex-direction:column;gap:3px;" data-field-row="${_bcEsc(f.key)}">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;font-size:10.5px;">
                    <span style="color:#e2e8f0;font-weight:600;">${_bcEsc(f.label)}</span>
                    <span style="color:#a78bfa;font-size:10px;background:rgba(124,92,255,0.15);border:1px solid rgba(124,92,255,0.3);padding:1px 5px;border-radius:3px;font-family:monospace;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="已绑定表格列: ${_bcEsc(colName)}">${_bcEsc(colName)}</span>
                </div>
                ${isMultiline ? `
                    <textarea data-bound-input data-ci="${ci}" data-fk="${_bcEsc(f.key)}" rows="3" placeholder="输入${_bcEsc(f.label)}..." style="width:100%;box-sizing:border-box;background:#10111d;border:1px solid #363852;border-radius:4px;color:#f1f5f9;padding:6px 8px;font-size:11.5px;line-height:1.45;resize:vertical;font-family:inherit;outline:none;">${_bcEsc(val)}</textarea>
                ` : `
                    <input data-bound-input data-ci="${ci}" data-fk="${_bcEsc(f.key)}" type="text" value="${_bcEsc(val)}" placeholder="输入${_bcEsc(f.label)}..." style="width:100%;box-sizing:border-box;background:#10111d;border:1px solid #363852;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:11.5px;height:26px;outline:none;">
                `}
            </div>`;
        }).join('');
    };
    const copyContainer = get('[data-copy-fields-container]');
    if (copyContainer) {
        copyContainer.addEventListener('input', e => {
            const target = e.target;
            if (!target || !target.hasAttribute('data-bound-input')) return;
            const ci = Number(target.dataset.ci);
            const ri = Number(get('[data-row]').value) || 0;
            if (!rows[ri]) return;
            const actualRowIndex = rows[ri].index;
            const newVal = target.value;

            // 1. Synchronize to _bulkState.rows and active row
            if (!_bulkState.rows[actualRowIndex]) _bulkState.rows[actualRowIndex] = [];
            while (_bulkState.rows[actualRowIndex].length <= ci) _bulkState.rows[actualRowIndex].push('');
            _bulkState.rows[actualRowIndex][ci] = newVal;
            rows[ri].row[ci] = newVal;

            // 2. Synchronize any other inputs bound to the same column
            copyContainer.querySelectorAll(`[data-bound-input][data-ci="${ci}"]`).forEach(inp => {
                if (inp !== target && inp.value !== newVal) inp.value = newVal;
            });

            // 3. Immediately re-render canvas
            const tpl = _bcAssignedTemplate(entry, group);
            const localIndex = rows.slice(0, ri).filter(({row}) => _bcRowHasBoundData(tpl, row)).length;
            task = _bcBuildTask(tpl, rows[ri].row, localIndex, ri + 1, _bulkState.columns);
            _bcApplyAssignedBackground(task, tpl, localIndex);
            _bcApplyAssignedMusic(task, tpl, localIndex);
            draw();

            // 4. Synchronize back to outer table and draft save
            _bcRenderTable();
            _bcScheduleDraftSave();

            // 5. Visual sync tip
            const tip = get('[data-copy-sync-tip]');
            if (tip) {
                tip.textContent = `✓ 第 ${actualRowIndex + 1} 行已同步`;
                tip.style.display = 'inline-block';
                clearTimeout(tip._timer);
                tip._timer = setTimeout(() => { tip.style.display = 'none'; }, 2200);
            }
        });
    }
    const refresh = (skipEditorRebuild = false) => {
        try {
            video.pause(); video.removeAttribute('src'); img.removeAttribute('src');
            const tpl = _bcAssignedTemplate(entry, group);
            const ri = Number(get('[data-row]').value) || 0;
            if (!tpl || !rows[ri]) throw new Error('本组暂无可预览文案');
            const localIndex = rows.slice(0, ri).filter(({row}) => _bcRowHasBoundData(tpl, row)).length;
            task = _bcBuildTask(tpl, rows[ri].row, localIndex, ri + 1, _bulkState.columns);
            _bcApplyAssignedBackground(task, tpl, localIndex);
            _bcApplyAssignedMusic(task, tpl, localIndex);
            const path = task.bgPath || task.videoPath || '';
            const isImage = _bcMediaKind(path) === 'image';
            img.style.display = isImage ? 'block' : 'none'; video.style.display = isImage ? 'none' : 'block';
            if (path) (isImage ? img : video).src = _bcFileUrl(path);
            get('[data-status]').textContent = path ? `背景：${_bcFileName(path)}` : '当前无背景素材';
            const music = get('[data-music-player]');
            music.pause(); music.removeAttribute('src');
            if (task.bgmPath) { music.src = _bcFileUrl(task.bgmPath); music.style.display = 'block'; }
            else music.style.display = 'none';
            draw(); clearTimeout(timer); timer = setTimeout(draw, 600);
            if (!skipEditorRebuild) renderBoundTextEditors();
            _bcScheduleDraftSave();
        } catch (error) { task = null; draw(); get('[data-status]').textContent = error.message; }
    };
    ['click', 'mousedown', 'keydown'].forEach(type => modal.addEventListener(type, event => event.stopPropagation()));
    syncOptions(); refresh();
    get('[data-edit-overlays]').onclick = () => {
        if (suiteHost) { closeSuitePanel(); return; }
        if (typeof ReelsOverlayPanel === 'undefined' || !window.ReelsOverlay?.OverlayManager) { alert('覆层编辑器尚未加载'); return; }
        const tpl = _bcAssignedTemplate(entry, group);
        const localTask = { ...tpl.task, overlays: JSON.parse(JSON.stringify(tpl.task.overlays || [])) };
        const mgr = new window.ReelsOverlay.OverlayManager();
        mgr.overlays = localTask.overlays;
        suiteHost = document.createElement('div');
        suiteHost.style.cssText = 'width:460px;min-width:380px;max-height:85vh;overflow:auto;border-left:1px solid #444;padding-left:12px;';
        suiteHost.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px;padding:8px;background:rgba(255,255,255,0.03);border-radius:6px;margin-bottom:8px;font-size:11px;">
            <div style="color:#b9aaff;line-height:1.4;">
                💡 正在编辑本组覆层。已绑定文案仍从表格实时读取。
            </div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;">
                <button id="bc-suite-sync-source" style="padding:3px 8px;background:rgba(124,92,255,0.25);border:1px solid #7c5cff;border-radius:4px;color:#c4b5fd;cursor:pointer;font-size:10px;" title="把当前修改后的覆层样式直接保存回该模板本身，后续使用该模板的组也会继承">💾 同步保存到源模板</button>
                <button id="bc-suite-save-as-new" style="padding:3px 8px;background:rgba(16,185,129,0.2);border:1px solid #10b981;border-radius:4px;color:#6ee7b7;cursor:pointer;font-size:10px;" title="将当前修改另存为一个全新的独立模板，并自动分配给当前组">✨ 另存为新模板</button>
                <button id="bc-suite-save-as-preset" style="padding:3px 8px;background:rgba(245,158,11,0.2);border:1px solid #f59e0b;border-radius:4px;color:#fcd34d;cursor:pointer;font-size:10px;" title="存入全局覆层预设库，可在任意工程直接选用">🎨 存为覆层预设</button>
            </div>
        </div>
        <div data-panel></div>`;
        modal.firstElementChild.appendChild(suiteHost);
        const save = () => {
            if (!suiteHost) return;
            localTask.overlays = mgr.overlays;
            _bcSaveSuiteOverlays(entry, mgr.overlays);
            _bcScheduleDraftSave(); refresh();
        };
        const proxy = {
            overlayMgr: mgr, scopedTask: localTask,
            getOverlayAboveSubtitle: () => localTask.overlayAboveSubtitle !== false,
            setOverlayAboveSubtitle(value) { localTask.overlayAboveSubtitle = value; entry.overlayAboveSubtitle = value; save(); },
            getCanvasSize: () => ({ w: 1080, h: 1920, cx: 540, cy: 960 }),
            getDuration: () => Number.isFinite(video.duration) ? video.duration : 9999,
            previewEnd(active) { get('[data-time]').value = active ? String(Number.isFinite(video.duration) ? video.duration : 10) : '0'; draw(); },
            addOverlay(overlay) { mgr.addOverlay(overlay); save(); suitePanel?._refreshList(); },
            removeOverlay(id) { mgr.removeOverlay(id); save(); suitePanel?._refreshList(); },
            render: save,
        };
        suitePanel = new ReelsOverlayPanel(suiteHost.querySelector('[data-panel]'), proxy);
        // Library management and batch task import are separate from editing this suite's parameters.
        suiteHost.querySelectorAll('#rop-group-preset-update,#rop-group-preset-del,#rop-group-preset-rename,#rop-batch-import').forEach(el => { el.style.display = 'none'; });
        suitePanel._refreshList();
        if (mgr.overlays[0]) suitePanel.selectOverlay(mgr.overlays[0]);

        suiteHost.querySelector('#bc-suite-sync-source').onclick = () => {
            const sourceTpl = _bulkState.templates[entry.templateIndex];
            if (sourceTpl) {
                sourceTpl.task.overlays = JSON.parse(JSON.stringify(mgr.overlays));
                if (localTask.overlayAboveSubtitle != null) {
                    sourceTpl.task.overlayAboveSubtitle = localTask.overlayAboveSubtitle;
                }
                delete entry.overlayOverrides;
                delete entry.overlayAboveSubtitle;
                _bcScheduleDraftSave();
                _bcRenderBindings();
                refresh();
                alert(`✅ 已同步更新到源模板「${sourceTpl.label}」`);
            }
        };
        suiteHost.querySelector('#bc-suite-save-as-new').onclick = () => {
            const sourceTpl = _bulkState.templates[entry.templateIndex];
            const defaultName = (sourceTpl?.label || '新模板') + '_已修改';
            const newName = prompt('输入新模板名称：', defaultName);
            if (newName && newName.trim()) {
                const newTplTask = JSON.parse(JSON.stringify(sourceTpl ? sourceTpl.task : localTask));
                newTplTask.overlays = JSON.parse(JSON.stringify(mgr.overlays));
                if (localTask.overlayAboveSubtitle != null) {
                    newTplTask.overlayAboveSubtitle = localTask.overlayAboveSubtitle;
                }
                const newIndex = _bulkState.templates.length;
                const newTpl = {
                    task: newTplTask,
                    label: newName.trim(),
                    bindings: typeof _bcAutoBind === 'function' ? _bcAutoBind(newTplTask, newIndex) : {},
                    bgCycle: sourceTpl?.bgCycle ? [...sourceTpl.bgCycle] : null,
                    source: null,
                };
                _bulkState.templates.push(newTpl);
                entry.templateIndex = newIndex;
                delete entry.overlayOverrides;
                delete entry.overlayAboveSubtitle;
                _bcScheduleDraftSave();
                _bcRenderBindings();
                syncOptions();
                refresh();
                alert(`✅ 已另存为新模板「${newName.trim()}」并分配给本组`);
            }
        };
        suiteHost.querySelector('#bc-suite-save-as-preset').onclick = () => {
            const sourceTpl = _bulkState.templates[entry.templateIndex];
            const defaultName = (sourceTpl?.label || '自定义覆层') + '_预设';
            const presetName = prompt('输入要保存的覆层预设名称：', defaultName);
            if (presetName && presetName.trim()) {
                let presets = {};
                try { presets = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}'); } catch(e) {}
                presets[presetName.trim()] = {
                    name: presetName.trim(),
                    createdAt: new Date().toISOString(),
                    layers: JSON.parse(JSON.stringify(mgr.overlays)),
                    overlayAboveSubtitle: localTask.overlayAboveSubtitle !== false,
                };
                localStorage.setItem('reels_overlay_group_presets', JSON.stringify(presets));
                alert(`✅ 已成功保存到全局覆层预设「${presetName.trim()}」`);
            }
        };
    };
    get('[data-pick-template]').onclick = () => _bcVisualPicker('template', entry.templateIndex, value => { closeSuitePanel(); _bcSetGroupTemplate(key, value); syncOptions(); refresh(); });
    get('[data-pick-folder]').onclick = () => _bcVisualPicker('folder', entry.backgroundFolder || '', value => { entry.backgroundFolder = value; _bcRenderBindings(); syncOptions(); refresh(); });
    get('[data-pick-music]').onclick = () => _bcVisualPicker('music', entry.musicPath || '', value => { entry.musicPath = value; _bcRenderBindings(); syncOptions(); refresh(); });
    get('[data-template]').onchange = event => { closeSuitePanel(); _bcSetGroupTemplate(key, Number(event.target.value)); syncOptions(); refresh(); };
    get('[data-folder]').onchange = event => { entry.backgroundFolder = event.target.value; _bcRenderBindings(); refresh(); };
    get('[data-music]').onchange = event => { entry.musicPath = event.target.value; _bcRenderBindings(); refresh(); };
    get('[data-music-mode]').onchange = event => { entry.musicMode = event.target.value; _bcRenderBindings(); syncOptions(); refresh(); };
    get('[data-row]').onchange = refresh;
    get('[data-time]').oninput = () => { video.currentTime = Math.max(0, Number(get('[data-time]').value) || 0); draw(); };
    get('[data-play]').onclick = () => video.paused ? video.play().catch(() => {}) : video.pause();
    video.onerror = img.onerror = () => { get('[data-status]').textContent = '背景加载失败，请检查文件路径或刷新素材分类。'; };
    get('[data-close]').onclick = () => { closeSuitePanel(); clearTimeout(timer); video.pause(); video.removeAttribute('src'); video.load(); get('[data-music-player]').pause(); get('[data-music-player]').removeAttribute('src'); _bcSaveDraftNow(); modal.remove(); _bcRenderTable(); _bcRenderBindings(); if (onClose) onClose(); };
}

function _bcAllPreviewItems() {
    const groups = _bcNumberedColumnGroups();
    const items = [];
    (_bulkState.groupAssignments || []).forEach(entry => {
        const group = groups.find(group => group.key === entry.key);
        const tpl = _bcAssignedTemplate(entry, group);
        if (!tpl) return;
        let localIndex = 0;
        _bulkState.rows.forEach((row, rowIndex) => {
            if (!row.some(cell => String(cell || '').trim()) || !_bcRowHasBoundData(tpl, row)) return;
            items.push({ key: entry.key, tpl, row, rowIndex, localIndex: localIndex++ });
        });
    });
    return items;
}

function _bcPreviewAll() {
    if (typeof ReelsOverlay === 'undefined') { alert('预览渲染器尚未加载'); return; }
    if (!_bcAllPreviewItems().length) { alert('请先分配模板并填入文案，再批量预览'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:400000;background:#101018;color:#ddd;padding:18px;display:flex;flex-direction:column;gap:12px;';
    modal.innerHTML = `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <strong>全部文案 · 批量预览</strong><span data-count></span>

        <button data-refresh>刷新预览</button><button data-close>关闭</button>
        <span style="font-size:12px;color:#999;">每套一行，左右滚动对比；上下滚动切换套组。点击卡片放大、换模板或背景。更换模板会应用到该编号组的所有文案。此处检查排版与背景组合。</span>
        </div><div data-grid style="overflow:auto;flex:1;min-height:0;display:flex;flex-direction:column;gap:20px;"></div>`;
    document.body.appendChild(modal);
    ['click', 'mousedown', 'keydown'].forEach(type => modal.addEventListener(type, event => event.stopPropagation()));
    const get = selector => modal.querySelector(selector);
    let timers = [], observer = null;
    const cleanup = () => {
        observer?.disconnect();
        timers.forEach(clearTimeout); timers = [];
        modal.querySelectorAll('video').forEach(video => { video.pause(); video.removeAttribute('src'); video.load(); });
    };
    const render = () => {
        cleanup();
        const items = _bcAllPreviewItems();
        const grid = get('[data-grid]');
        const scrollTop = grid.scrollTop;
        const positions = new Map(Array.from(grid.querySelectorAll('[data-suite]')).map(row => [row.dataset.suite, row.scrollLeft]));
        const suites = new Map();
        items.forEach(item => { if (!suites.has(item.key)) suites.set(item.key, []); suites.get(item.key).push(item); });
        get('[data-count]').textContent = `共 ${suites.size} 套 · ${items.length} 项`;
        grid.innerHTML = '';
        observer = new IntersectionObserver(entries => entries.forEach(entry => {
            if (entry.isIntersecting) entry.target._loadPreview?.();
            else entry.target._unloadPreview?.();
        }), { root: grid, rootMargin: '100px' });
        suites.forEach((suiteItems, key) => {
            const section = document.createElement('section');
            section.style.cssText = 'flex:none;min-width:0;border-bottom:1px solid #444;padding-bottom:16px;';
            section.innerHTML = `<div style="margin-bottom:8px;color:#b9aaff;font-weight:600;">${_bcEsc(key)} · ${_bcEsc(suiteItems[0].tpl.label)} · ${suiteItems.length} 条</div>`;
            const row = document.createElement('div');
            row.dataset.suite = key;
            row.style.cssText = 'display:flex;gap:12px;overflow-x:auto;padding-bottom:10px;scrollbar-width:auto;';
            section.appendChild(row); grid.appendChild(section);
            suiteItems.forEach(item => {
            const card = document.createElement('button');
            card.style.cssText = 'flex:0 0 220px;width:220px;padding:8px;background:#20202c;color:#ddd;border:1px solid #444;border-radius:8px;text-align:left;cursor:pointer;';
            card.innerHTML = `<div style="position:relative;aspect-ratio:9/16;background:#000;">
                <video muted playsinline preload="auto" style="position:absolute;width:100%;height:100%;object-fit:cover;"></video>
                <img style="position:absolute;width:100%;height:100%;object-fit:cover;display:none;">
                <canvas width="270" height="480" style="position:absolute;width:100%;height:100%;"></canvas>
                </div><div style="margin-top:6px;">${_bcEsc(item.key)} · 第 ${item.rowIndex + 1} 行</div>
                <div style="font-size:11px;color:#b9aaff;">${_bcEsc(item.tpl.label)}</div><div data-status style="font-size:11px;"></div>`;
            row.appendChild(card);
            card.onclick = () => _bcPreviewGroup(item.key, item.rowIndex, render);
            let loaded = false;
            card._unloadPreview = () => {
                loaded = false;
                const video = card.querySelector('video');
                video.pause(); video.removeAttribute('src'); video.load();
                card.querySelector('img').removeAttribute('src');
                card.querySelector('canvas').width = 270;
            };
            card._loadPreview = () => {
            if (loaded) return;
            loaded = true;
            try {
                const task = _bcBuildTask(item.tpl, item.row, item.localIndex, item.rowIndex + 1, _bulkState.columns);
                _bcApplyAssignedBackground(task, item.tpl, item.localIndex);
                _bcApplyAssignedMusic(task, item.tpl, item.localIndex);
                const path = task.bgPath || task.videoPath || '';
                const video = card.querySelector('video'), img = card.querySelector('img');
                const isImage = _bcMediaKind(path) === 'image';
                video.style.display = isImage ? 'none' : 'block'; img.style.display = isImage ? 'block' : 'none';
                const status = card.querySelector('[data-status]');
                status.textContent = path ? _bcFileName(path) : '无背景素材';
                video.onerror = img.onerror = () => { status.textContent = '背景加载失败，请检查素材路径'; };
                if (path) (isImage ? img : video).src = _bcFileUrl(path);
                const draw = () => {
                    if (!card.isConnected || !loaded) return;
                    const ctx = card.querySelector('canvas').getContext('2d');
                    ctx.clearRect(0, 0, 270, 480); ctx.save(); ctx.scale(0.25, 0.25);
                    try {
                        (task.overlays || []).forEach(overlay => ReelsOverlay.drawOverlay(ctx, { ...overlay, _exporting: true }, Math.max(0, Number(overlay.start) || 0), 1080, 1920));
                    } finally { ctx.restore(); }
                };
                draw(); timers.push(setTimeout(() => { try { draw(); } catch (error) { status.textContent = error.message; } }, 600));
            } catch (error) { card.querySelector('[data-status]').textContent = error.message; }
            };
            observer.observe(card);
            });
            row.scrollLeft = positions.get(key) || 0;
        });
        grid.scrollTop = scrollTop;
        _bcScheduleDraftSave();
    };
    get('[data-refresh]').onclick = render;
    get('[data-close]').onclick = () => { cleanup(); modal.remove(); };
    render();
}

function _bcTemplateProjectIdsInUse() {
    return new Set(_bulkState.templates
        .map(tpl => tpl?.source?.templateId)
        .filter(Boolean));
}

function _bcIsTemplateProjectInUse(templateId) {
    return !!templateId && _bcTemplateProjectIdsInUse().has(templateId);
}

async function _bcFetchTemplateProject(templateId) {
    if (!templateId) throw new Error('缺少模板来源 ID');
    const resp = await apiFetch(`${API_BASE}/templates/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: templateId }),
    });
    const result = await resp.json();
    const tplData = result.data || result;
    if (!tplData?.projectData?.tasks?.length) throw new Error('最新模板工程没有任务');
    return tplData;
}

function _bcRefreshTemplateFromProject(tpl, tplData) {
    const source = tpl.source || {};
    const projectData = tplData.projectData || {};
    const safeTasks = _bcDeserializeProjectTasks(projectData);
    if (!safeTasks.length) throw new Error('最新模板工程没有可用任务');

    const projectCycle = _bcCollectProjectBackgroundCycle(projectData);
    let nextTask = null;
    let nextCycle = null;
    if (source.mode === 'unified') {
        nextTask = safeTasks[0];
        const cycle = [];
        (projectCycle || []).forEach(p => _bcAddUniqueCyclePath(cycle, p));
        if (cycle.length === 0) {
            safeTasks.forEach(t => _bcCollectTaskBackgroundCycle(t).forEach(p => _bcAddUniqueCyclePath(cycle, p)));
        }
        nextCycle = cycle.length > 1 ? cycle : null;
    } else {
        const idx = Number.isInteger(source.taskIndex) ? source.taskIndex : 0;
        nextTask = safeTasks[idx];
        if (!nextTask) throw new Error(`最新模板工程没有第 ${idx + 1} 个任务`);
        nextCycle = _bcResolveTemplateBgCycle(nextTask, projectCycle);
    }

    tpl.task = _bcCloneTemplateTask(nextTask);
    tpl.bgCycle = nextCycle;
    tpl.label = source.mode === 'unified'
        ? `${tplData.name || source.templateName || tpl.label}_统一模式`
        : (tpl.task.baseName || tpl.task.fileName || tpl.label);
    tpl.source = {
        ...source,
        templateName: tplData.name || source.templateName || '',
        refreshedAt: new Date().toISOString(),
    };
}

async function _bcReloadLoadedTemplates() {
    const sourced = _bulkState.templates
        .map((tpl, index) => ({ tpl, index }))
        .filter(x => x.tpl?.source?.type === 'template_project' && x.tpl.source.templateId);
    if (sourced.length === 0) {
        alert('当前没有可刷新的模板工程来源。请从「模版工程库」添加模板后再刷新。');
        return;
    }
    if (!confirm(`从模板库重新加载 ${sourced.length} 个已添加模板？\n\n会更新模板工程内容和自动循环素材，保留当前列绑定。`)) return;

    const cache = new Map();
    let ok = 0;
    const errors = [];
    for (const { tpl, index } of sourced) {
        const id = tpl.source.templateId;
        try {
            if (!cache.has(id)) cache.set(id, await _bcFetchTemplateProject(id));
            _bcRefreshTemplateFromProject(tpl, cache.get(id));
            ok++;
        } catch (e) {
            errors.push(`模板${index + 1}「${tpl.label || id}」: ${e.message}`);
        }
    }
    _bcRenderBindings();
    _bcScheduleDraftSave();
    const msg = `已刷新 ${ok} 个模板${errors.length ? `\n\n失败：\n${errors.join('\n')}` : ''}`;
    alert(msg);
}

function _bcBindingDebugLabel(tpl, field) {
    const ci = tpl?.bindings?.[field.key];
    if (ci == null || ci < 0) return '未绑定';
    const col = _bulkState.columns[ci];
    const sampleRow = _bulkState.rows.find(r => r && String(r[ci] || '').trim());
    const sample = sampleRow ? String(sampleRow[ci] || '').trim().slice(0, 24) : '';
    return `列${ci + 1}: ${col?.name || ''}${sample ? ` | ${sample}` : ''}`;
}

function _bcWarnDuplicateTextBindings(tpl) {
    const fields = _bcFieldsFromTask(tpl.task || {}).filter(f => f.type === 'text');
    const seen = new Map();
    const duplicates = [];
    fields.forEach(f => {
        const ci = tpl.bindings?.[f.key];
        if (ci == null || ci < 0) return;
        if (seen.has(ci)) duplicates.push([seen.get(ci), f, ci]);
        else seen.set(ci, f);
    });
    if (duplicates.length > 0) {
        console.warn('[BulkCreate] 文本字段绑定到同一列，请确认是否有意:', tpl.label, duplicates.map(([a, b, ci]) => ({
            column: `${ci + 1}:${_bulkState.columns[ci]?.name || ''}`,
            fields: [a.label, b.label],
        })));
    }
}

function _bcEnsureAllTemplateBindings() {
    _bulkState.templates.forEach(tpl => {
        _bcEnsureTemplateBindings(tpl);
        _bcWarnDuplicateTextBindings(tpl);
    });
}

function _bcWarnAllDuplicateTextBindings() {
    _bulkState.templates.forEach(_bcWarnDuplicateTextBindings);
}

// ── Render data table ──
function _bcRenderTable() {
    const el = document.getElementById('bc-table-body');
    if (!el) return;
    _bcNormalizeStateShape();
    const cols = _bulkState.columns;
    let hdr = '<tr><th style="width:28px;text-align:center;color:#555;">#</th>';
    cols.forEach((c, ci) => {
        hdr += `<th class="bc-col-header ${c.type === 'media' ? 'bc-media-col-header' : ''}" data-ci="${ci}" style="min-width:110px;padding:3px 5px;position:relative;">
            <div style="display:flex;align-items:center;gap:4px;">
                <select class="bc-col-kind" data-ci="${ci}" title="选择列类型" style="width:74px;background:#0a0a14;border:1px solid #333;border-radius:3px;color:#ddd;font-size:10px;padding:1px;">${_bcColumnKindOptions(c)}</select>
                <input class="bc-col-name" data-ci="${ci}" list="bc-standard-column-names" value="${_bcEsc(c.name)}" style="flex:1;background:transparent;border:none;border-bottom:1px solid #333;color:#ddd;font-size:11px;padding:1px;min-width:0;" title="可手写，也可从下拉列表选择标准表头">
            </div>
        </th>`;
    });
    hdr += '<th style="width:46px;text-align:center;"><button id="bc-add-col" style="background:none;border:none;color:#7c5cff;cursor:pointer;font-size:13px;" title="末尾添加列">+</button></th></tr>';
    let body = '';
    _bulkState.rows.forEach((row, ri) => {
        body += `<tr><td style="text-align:center;color:#555;font-size:10px;">${ri+1}</td>`;
        cols.forEach((c, ci) => {
            const v = row[ci] || '';
            const cls = c.type === 'media' ? 'bc-cell bc-cell-media' : 'bc-cell bc-cell-text';
            body += `<td class="bc-grid-td" data-ri="${ri}" data-ci="${ci}">
                <div class="${cls}" data-ri="${ri}" data-ci="${ci}" title="${_bcEsc(v)}">${c.type === 'media' ? _bcMediaCellHtml(v) : (v ? _bcCellPreview(v) : '<span class="bc-cell-placeholder"> </span>')}</div>
            </td>`;
        });
        body += `<td style="text-align:center;white-space:nowrap;"><span class="bc-row-copy" data-ri="${ri}" title="复制此行副本（做新版本）" style="cursor:pointer;color:#a78bfa;font-size:11px;margin-right:5px;">📋</span><span class="bc-row-del" data-ri="${ri}" title="删除此行" style="cursor:pointer;color:#f44;font-size:9px;">✕</span></td></tr>`;
    });
    const columnNameOptions = BC_STANDARD_COLUMN_NAMES.map(name => `<option value="${_bcEsc(name)}"></option>`).join('');
    el.innerHTML = `<datalist id="bc-standard-column-names">${columnNameOptions}</datalist><table class="bc-data-table"><thead>${hdr}</thead><tbody>${body}</tbody></table>`;
    _bcUpdateSelectionUI();
    _bcScheduleDraftSave();
}

// ── Render template binding panel ──
function _bcRenderBindings() {
    const el = document.getElementById('bc-bind-panel');
    if (!el) return;
    const prevScroll = el.scrollTop;
    _bcNormalizeStateShape();
    const cols = _bulkState.columns;
    const assignments = _bulkState.groupAssignments;
    const numberedGroups = _bcNumberedColumnGroups();
    const templateGroupKeys = _bulkState.templates.map(tpl => {
        const textIndices = Object.values(tpl.bindings || {}).filter(ci => ci >= 0 && cols[ci]?.type === 'text');
        return numberedGroups.find(group => textIndices.length && textIndices.every(ci => group.columns.some(col => col.ci === ci)))?.key;
    });
    const usage = _bulkState.templates.map((_, ti) => (assignments || []).filter(item => item.templateIndex === ti && numberedGroups.some(group => group.key === item.key)).length);
    const globalUsedFieldByCol = new Map();
    _bulkState.templates.forEach((tpl, ti) => {
        const fields = _bcFieldsFromTask(tpl.task || {});
        fields.forEach(f => {
            const ci = tpl.bindings?.[f.key];
            if (ci == null || ci < 0) return;
            if (!globalUsedFieldByCol.has(ci)) {
                globalUsedFieldByCol.set(ci, {
                    ti,
                    fk: f.key,
                    fieldLabel: f.label,
                    templateLabel: tpl.label || `模板${ti + 1}`,
                });
            }
        });
    });
    const unassignedGroupCount = numberedGroups.filter(g => {
        const entry = (assignments || []).find(e => e.key === g.key);
        return !entry || !entry.backgroundFolder;
    }).length;

    const isTplCollapsed = !!_bulkState.collapsedSections?.templates;
    const isBgCollapsed = !!_bulkState.collapsedSections?.backgrounds;
    const isMusicCollapsed = !!_bulkState.collapsedSections?.music;
    const isGroupsCollapsed = !!_bulkState.collapsedSections?.groups;
    const allCollapsed = isTplCollapsed && isBgCollapsed && isMusicCollapsed && isGroupsCollapsed;

    // 🔝 1. 最顶层：总览与全局操作栏（总预览放最醒目位置）
    let html = `<div class="bc-global-toolbar" style="background:linear-gradient(180deg, #18192c 0%, #121322 100%);border:1px solid #2e3150;border-radius:8px;padding:8px 10px;margin-bottom:10px;box-shadow:0 2px 8px rgba(0,0,0,0.25);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <div style="display:flex;align-items:center;gap:6px;">
                <span style="font-weight:700;color:#c4b5fd;font-size:13px;display:inline-flex;align-items:center;gap:5px;">🧩 模板与素材分配</span>
                <span style="font-size:10px;color:#94a3b8;background:rgba(255,255,255,0.04);padding:1px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.06);">
                    ${numberedGroups.length} 组 · ${_bulkState.templates.length} 模板 · ${_bulkState.backgroundFolders.length} 背景 · ${_bulkState.musicFiles.length} 配乐
                </span>
            </div>
            <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
                <button id="bc-preview-all" class="bc-btn bc-btn-blue" style="height:25px;padding:0 12px;font-size:11.5px;font-weight:600;box-shadow:0 2px 6px rgba(59,130,246,0.35);" title="横向批量对比并全屏预览所有编号组的排版与素材">👁 批量预览全部</button>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:${_bulkState.filterUnassignedGroups ? '#c4b5fd' : '#cbd5e1'};font-size:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;" title="仅显示尚未分配背景素材的编号组">
                    <input id="bc-filter-unassigned-groups" type="checkbox" ${_bulkState.filterUnassignedGroups ? 'checked' : ''} style="accent-color:#7c5cff;">仅未分配组${numberedGroups.length ? ` (${unassignedGroupCount})` : ''}
                </label>
                <button id="bc-toggle-all-sections" class="bc-btn bc-btn-default bc-btn-xs" title="一键折叠或展开下方全部四个模块">${allCollapsed ? '展开全部模块' : '折叠全部模块'}</button>
                <button id="bc-manual-bindings" class="bc-btn bc-btn-default bc-btn-xs" title="切换视图模式">${assignments ? '原逐列绑定' : '启用编号组模式'}</button>
                <button id="bc-clear-bindings" class="bc-btn bc-btn-danger bc-btn-xs" title="清空全部编号组与模板的列绑定">清空绑定</button>
            </div>
        </div>
        <div style="font-size:10px;color:#717496;margin-top:4px;line-height:1.35;">
            ${assignments ? '下方分别管理模版库、背景库和配乐库（支持独立折叠收起）；配置完成后在编号组卡片中检查或微调。' : '当前为原逐列绑定模式；可点击上方按钮启用编号组模式，或在下方直接对模板进行字段绑定。'}
        </div>
    </div>`;

    // 🎨 2. 模块一：模版库（可折叠）
    const unassignedTemplates = _bulkState.templates.filter((tpl, ti) => {
        const assignedEntries = (assignments || []).filter(entry => entry.templateIndex === ti && numberedGroups.some(group => group.key === entry.key));
        return assignedEntries.length === 0;
    });
    const unassignedTplCount = unassignedTemplates.length;
    const visibleTemplates = _bulkState.templates
        .map((tpl, ti) => ({ tpl, ti }))
        .filter(({ ti }) => {
            if (!_bulkState.filterUnassignedTemplates) return true;
            const assignedEntries = (assignments || []).filter(entry => entry.templateIndex === ti && numberedGroups.some(group => group.key === entry.key));
            return assignedEntries.length === 0;
        });

    html += `<div id="bc-template-library" class="bc-library-box bc-tpl-library-box" style="background:rgba(124,92,255,0.03);border:1px solid rgba(124,92,255,0.22);border-radius:8px;padding:9px 10px;margin-bottom:10px;">
        <div data-toggle-section="templates" style="display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;user-select:none;flex-wrap:wrap;" title="点击折叠 / 展开模版库">
            <div style="display:flex;align-items:center;gap:6px;">
                <span class="bc-toggle-arrow" style="color:#a78bfa;font-size:10px;width:12px;text-align:center;display:inline-block;">${isTplCollapsed ? '▶' : '▼'}</span>
                <span style="font-weight:700;font-size:11.5px;color:#d8cfff;display:inline-flex;align-items:center;gap:4px;">🎨 模版库</span>
                <span style="font-size:10px;color:#8a8ab0;">(${_bulkState.templates.length} 个模板)</span>
                ${isTplCollapsed ? '<span style="font-size:9.5px;color:#717496;background:rgba(255,255,255,0.04);padding:1px 5px;border-radius:3px;border:1px solid rgba(255,255,255,0.06);">已收起</span>' : ''}
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                <button id="bc-add-tpl" class="bc-btn bc-btn-purple bc-btn-xs" style="font-weight:600;">+ 添加模板</button>
                <button id="bc-match-groups" class="bc-btn bc-btn-default bc-btn-xs" title="按顺序为每个编号组分配一个模板">顺序分配</button>
                <button id="bc-random-groups" class="bc-btn bc-btn-purple bc-btn-xs" title="为每个编号组随机分配一个模板">🎲 随机分配${_bulkState.allowTemplateReuse ? '（可重复）' : '（不重复）'}</button>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#9b9db8;font-size:10px;" title="允许将同一个模板重复分配给多个编号组"><input id="bc-allow-reuse" type="checkbox" ${_bulkState.allowTemplateReuse ? 'checked' : ''} style="accent-color:#7c5cff;">允许重复</label>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:${_bulkState.filterUnassignedTemplates ? '#c4b5fd' : '#9b9db8'};font-size:10px;" title="仅查看尚未分配给任何编号组的模板"><input id="bc-filter-unassigned-tpls" type="checkbox" ${_bulkState.filterUnassignedTemplates ? 'checked' : ''} style="accent-color:#7c5cff;">仅未分配${_bulkState.templates.length ? ` (${unassignedTplCount})` : ''}</label>
                <button id="bc-clear-tpl-assignments" class="bc-btn bc-btn-default bc-btn-xs" title="清空全部编号组的模板分配">清空分配</button>
                <button id="bc-clear-templates" class="bc-btn bc-btn-danger bc-btn-xs" title="清空模版库中的所有模板">清空库</button>
                <button id="bc-rebind-tpl" class="bc-btn bc-btn-amber bc-btn-xs" title="按当前列名重新自动绑定全部模板字段">重绑</button>
            </div>
        </div>
        ${!isTplCollapsed ? `
            <div style="color:#8e92b2;font-size:10px;margin:6px 0;">为各编号组配对套用模板；可直接指定分配给哪个组或点击取消分配。</div>
            ${_bulkState.templates.length === 0 ? `
                <div style="padding:10px;text-align:center;color:#717496;font-size:10.5px;background:rgba(255,255,255,0.02);border:1px dashed #33334a;border-radius:6px;">
                    暂无模板，点击右上方「+ 添加模板」导入模板工程
                </div>
            ` : (_bulkState.templates.length > 0 && visibleTemplates.length === 0 ? `
                <div style="padding:14px 8px;text-align:center;color:#8a8ab0;font-size:11px;background:rgba(255,255,255,0.02);border:1px dashed #33334a;border-radius:6px;margin-top:6px;">🎉 全部模板均已分配到编号组</div>
            ` : `
                ${visibleTemplates.map(({ tpl, ti }) => {
                    const assignedEntries = (assignments || []).filter(entry => entry.templateIndex === ti && numberedGroups.some(group => group.key === entry.key));
                    const assignedKeys = assignedEntries.map(entry => entry.key);
                    const count = assignedKeys.length;
                    const task = tpl.task || {};
                    const bgName = (task.bgPath || task.videoPath || '').split(/[/\\]/).pop() || '无背景';
                    const overlaysCount = task.overlays?.length || 0;
                    const cycleBadge = tpl.bgCycle && tpl.bgCycle.length > 0
                        ? `<span class="bc-tpl-bgcycle" data-ti="${ti}" style="cursor:pointer;font-size:9px;background:rgba(16,185,129,0.2);color:#10b981;border:1px solid rgba(16,185,129,0.3);padding:1px 4px;border-radius:4px;" title="已自动读取当前预设的 ${tpl.bgCycle.length} 个循环素材，点击查看">🔄 自动循环(${tpl.bgCycle.length})</span>`
                        : `<span class="bc-tpl-bgcycle" data-ti="${ti}" style="cursor:pointer;font-size:9px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#777;padding:1px 4px;border-radius:4px;" title="没有从该模板工程读取到多个背景素材，点击可手动补充">单背景</span>`;
                    const materialFolderName = tpl.materialFolder?.path
                        ? _bcFileName(tpl.materialFolder.path)
                        : '未绑定文件夹';
                    const materialFolderCount = tpl.materialFolder?.files?.length || 0;
                    const freeGroups = numberedGroups.filter(g => {
                        const entry = (assignments || []).find(e => e.key === g.key);
                        return !entry || entry.templateIndex == null || entry.templateIndex < 0;
                    });
                    const assignControlHtml = _bcRenderItemAssignControls({
                        kind: 'template',
                        itemVal: ti,
                        assignedKeys,
                        freeGroups,
                        allGroups: numberedGroups,
                    });
                    const fields = _bcFieldsFromTask(task);
                    return `<div class="bc-tpl-card-row ${count > 0 ? 'is-assigned' : ''}" style="display:flex;flex-direction:row;align-items:stretch;gap:10px;padding:8px;margin-top:6px;background:${count > 0 ? 'rgba(124,92,255,0.07)' : 'rgba(255,255,255,0.02)'};border:1px solid ${count > 0 ? 'rgba(124,92,255,0.35)' : 'rgba(124,92,255,0.14)'};border-radius:6px;transition:border-color 0.15s, background 0.15s;" title="${_bcEsc(tpl.label)}">
                        <div class="bc-tpl-thumb" style="width:48px;height:66px;flex:0 0 48px;border-radius:5px;overflow:hidden;background:#0c0c16;border:1px solid #36364e;display:flex;align-items:center;justify-content:center;position:relative;flex-shrink:0;">
                            <div id="bc-bind-thumb-loader-${ti}" style="font-size:10px;color:#666;text-align:center;">...</div>
                            <img id="bc-bind-thumb-${ti}" src="" style="width:100%;height:100%;object-fit:cover;display:none;position:absolute;top:0;left:0;" />
                        </div>
                        <div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:space-between;gap:4px;">
                            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                                <div style="font-weight:600;color:#eee;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_bcEsc(tpl.label)}">
                                    <span style="color:#a78bfa;margin-right:4px;">${ti + 1}.</span>${_bcEsc(tpl.label)}
                                </div>
                                <div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">
                                    <button class="bc-tpl-edit-overlays bc-btn bc-btn-purple bc-btn-xs" data-ti="${ti}" title="可视化编辑该模板的覆层样式与排版">✏️ 覆层</button>
                                    <button class="bc-tpl-save-preset bc-btn bc-btn-amber bc-btn-xs" data-ti="${ti}" title="将此模板覆层样式存入全局预设库">💾 存为预设</button>
                                    <button class="bc-tpl-rename bc-btn bc-btn-default bc-btn-xs" data-ti="${ti}" title="修改模板显示名称">重命名</button>
                                    <button class="bc-tpl-del" data-ti="${ti}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.25);border-radius:4px;color:#f88;" title="移出模版库">移出库</button>
                                </div>
                            </div>
                            <div style="color:#8a8ab0;font-size:10px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                                <span>${overlaysCount} 个覆层</span>
                                <span>·</span>
                                <span title="${_bcEsc(task.bgPath || task.videoPath || '')}">bg: ${_bcEsc(bgName)}</span>
                                ${cycleBadge}
                                <span>·</span>
                                <span>已选 <span style="${count > 0 ? 'color:#a78bfa;font-weight:600;' : ''}">${count}</span> 次</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:3px;margin-top:2px;">
                                <button class="bc-tpl-folder-pick bc-btn bc-btn-blue bc-btn-xs" data-ti="${ti}" title="${_bcEsc(tpl.materialFolder?.path || '选择固定素材文件夹')}">📁 ${_bcEsc(materialFolderName)}</button>
                                <select class="bc-tpl-folder-mode bc-select" data-ti="${ti}" title="文件夹素材使用方式" style="height:20px;font-size:9.5px;padding:0 3px;">
                                    <option value="rows" ${tpl.materialFolder?.mode !== 'concat' ? 'selected' : ''}>一个素材一行</option>
                                    <option value="concat" ${tpl.materialFolder?.mode === 'concat' ? 'selected' : ''}>顺序拼接</option>
                                </select>
                                <button class="bc-tpl-folder-refresh bc-btn bc-btn-emerald bc-btn-xs" data-ti="${ti}">刷新${materialFolderCount ? `(${materialFolderCount})` : ''}</button>
                            </div>
                            ${assignments ? `
                            <div style="display:flex;align-items:center;gap:6px;font-size:10px;margin-top:2px;">
                                <span style="color:#a78bfa;font-weight:600;flex-shrink:0;">分配组:</span>
                                ${assignControlHtml}
                            </div>
                            ` : ''}
                            ${!assignments ? `
                            <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
                                <label style="display:flex;gap:6px;align-items:center;color:#c4b5fd;font-size:10px;margin:0;">编号组快速绑定
                                    <select class="bc-tpl-group bc-select" data-ti="${ti}" style="height:22px;font-size:10px;">
                                        <option value="">选择编号组（自动绑定整组字段）</option>
                                        ${numberedGroups.map(group => `<option value="${_bcEsc(group.key)}" ${templateGroupKeys[ti] === group.key ? 'selected' : ''}>${_bcEsc(group.key)}</option>`).join('')}
                                    </select>
                                </label>
                            </div>
                            <div style="display:grid;grid-template-columns:1fr;gap:3px;margin-top:4px;">
                                ${fields.map(f => {
                                    const bound = tpl.bindings[f.key];
                                    let unboundLabel = '(不绑定)';
                                    if (f.key === '__bg__') {
                                        const bg = (task.bgPath || task.videoPath || '').split(/[/\\]/).pop();
                                        unboundLabel = bg ? `✅ 模板原始: ${bg.slice(0, 20)}` : '(不绑定 · 无背景)';
                                    } else if (f.key === '__audio__') {
                                        const au = (task.audioPath || '').split(/[/\\]/).pop();
                                        unboundLabel = au ? `✅ 模板原始: ${au.slice(0, 20)}` : '(不绑定)';
                                    } else if (f.key.startsWith('L') || ['title_text','body_text','footer_text'].includes(f.key)) {
                                        unboundLabel = '(不绑定 · 用模板默认)';
                                    }
                                    return `<div style="display:flex;align-items:center;gap:6px;font-size:10px;color:#94a3b8;padding:2px 4px;border-radius:4px;background:rgba(255,255,255,0.02);margin-bottom:2px;">
                                        <span style="white-space:nowrap;width:115px;min-width:115px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;color:#cbd5e1;font-weight:500;" title="${_bcEsc(f.label)}">${_bcEsc(f.label)}</span>
                                        <select class="bc-bind-sel bc-select" data-ti="${ti}" data-fk="${f.key}" title="${_bcEsc(_bcBindingDebugLabel(tpl, f))}" style="flex:1;min-width:0;height:24px;font-size:10.5px;padding:0 4px;">
                                            <option value="-1">${_bcEsc(unboundLabel)}</option>
                                            ${cols.map((c, ci) => {
                                                if (!_bcFieldAcceptsColumn(f, c)) return '';
                                                const usedBy = globalUsedFieldByCol.get(ci);
                                                const usedByOther = usedBy && !(usedBy.ti === ti && usedBy.fk === f.key) && bound !== ci;
                                                const usedLabel = usedByOther ? ` · 已绑定：${usedBy.templateLabel} / ${usedBy.fieldLabel}` : '';
                                                return `<option value="${ci}" ${bound === ci ? 'selected' : ''} ${usedByOther ? 'disabled' : ''}>${_bcEsc(_bcColumnKindOptionsLabel(c))} ${_bcEsc(c.name)}${_bcEsc(usedLabel)}</option>`;
                                            }).join('')}
                                        </select>
                                    </div>`;
                                }).join('')}
                            </div>
                            ` : ''}
                        </div>
                    </div>`;
                }).join('')}
            `)}
        ` : ''}
    </div>`;
    const unassignedBgFolders = _bulkState.backgroundFolders.filter(folder => {
        const assignedEntries = (assignments || []).filter(entry => entry.backgroundFolder === folder.path && numberedGroups.some(group => group.key === entry.key));
        return assignedEntries.length === 0;
    });
    const unassignedBgCount = unassignedBgFolders.length;
    const visibleFolders = _bulkState.backgroundFolders
        .map((folder, fi) => ({ folder, fi }))
        .filter(({ folder }) => {
            if (!_bulkState.filterUnassignedBackgrounds) return true;
            const assignedEntries = (assignments || []).filter(entry => entry.backgroundFolder === folder.path && numberedGroups.some(group => group.key === entry.key));
            return assignedEntries.length === 0;
        });

    // 📁 3. 模块二：背景库（可折叠）
    html += `<div id="bc-background-library" class="bc-library-box bc-bg-library-box" style="background:rgba(124,92,255,0.02);border:1px solid rgba(124,92,255,0.2);border-radius:8px;padding:9px 10px;margin-bottom:10px;">
        <div data-toggle-section="backgrounds" style="display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;user-select:none;flex-wrap:wrap;" title="点击折叠 / 展开背景库">
            <div style="display:flex;align-items:center;gap:6px;">
                <span class="bc-toggle-arrow" style="color:#a78bfa;font-size:10px;width:12px;text-align:center;display:inline-block;">${isBgCollapsed ? '▶' : '▼'}</span>
                <span style="font-weight:700;font-size:11.5px;color:#d8cfff;display:inline-flex;align-items:center;gap:4px;">📁 背景库</span>
                <span style="font-size:10px;color:#8a8ab0;">(${_bulkState.backgroundFolders.length} 个背景)</span>
                ${isBgCollapsed ? '<span style="font-size:9.5px;color:#717496;background:rgba(255,255,255,0.04);padding:1px 5px;border-radius:3px;border:1px solid rgba(255,255,255,0.06);">已收起</span>' : ''}
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                <button id="bc-add-background-folders" class="bc-btn bc-btn-purple bc-btn-xs">+ 添加文件夹</button>
                <button id="bc-seq-backgrounds" class="bc-btn bc-btn-default bc-btn-xs" title="按顺序为每个编号组分配背景素材">顺序分配</button>
                <button id="bc-random-backgrounds" class="bc-btn bc-btn-purple bc-btn-xs">🎲 ${_bulkState.allowBackgroundReuse ? '随机分配（可重复）' : '随机分配（不重复）'}</button>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#9b9db8;font-size:10px;"><input id="bc-allow-bg-reuse" type="checkbox" ${_bulkState.allowBackgroundReuse ? 'checked' : ''} style="accent-color:#7c5cff;">允许重复</label>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:${_bulkState.filterUnassignedBackgrounds ? '#c4b5fd' : '#9b9db8'};font-size:10px;" title="仅查看尚未分配给任何编号组的背景素材"><input id="bc-filter-unassigned-bgs" type="checkbox" ${_bulkState.filterUnassignedBackgrounds ? 'checked' : ''} style="accent-color:#7c5cff;">仅未分配背景${_bulkState.backgroundFolders.length ? ` (${unassignedBgCount})` : ''}</label>
                <button id="bc-clear-bg-assignments" class="bc-btn bc-btn-default bc-btn-xs" title="清空全部编号组的背景素材分配">清空分配</button>
                <button id="bc-clear-backgrounds" class="bc-btn bc-btn-danger bc-btn-xs" title="清空全部背景素材">清空库</button>
            </div>
        </div>
        ${!isBgCollapsed ? `
            <div style="color:#8e92b2;font-size:10px;margin:6px 0;">拖入多个文件夹到此处，每夹为一组背景。可重复分配给编号组；只读取文件夹内的视频和图片。</div>
            ${_bulkState.backgroundFolders.length > 0 && visibleFolders.length === 0 ? '<div style="padding:14px 8px;text-align:center;color:#8a8ab0;font-size:11px;background:rgba(255,255,255,0.02);border:1px dashed #33334a;border-radius:6px;margin-top:6px;">🎉 全部背景均已分配到编号组</div>' : ''}
            ${visibleFolders.map(({ folder, fi }) => {
                const assignedEntries = (assignments || []).filter(entry => entry.backgroundFolder === folder.path && numberedGroups.some(group => group.key === entry.key));
                const assignedKeys = assignedEntries.map(entry => entry.key);
                const count = assignedKeys.length;
                const files = folder.files || [];
                const folderName = folder.name || _bcFileName(folder.path);
                const firstFile = files[0];
                const kind = firstFile ? _bcMediaKind(firstFile) : '';
                const url = firstFile ? _bcFileUrl(firstFile) : '';
                let thumbInner = '';
                if (firstFile) {
                    if (kind === 'image') {
                        thumbInner = `<img src="${_bcEsc(url)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;" alt="">`;
                    } else if (kind === 'video') {
                        thumbInner = `<video src="${_bcEsc(url)}#t=0.1" muted preload="metadata" playsinline style="width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;"></video>`;
                    } else {
                        thumbInner = `<span style="font-size:16px;pointer-events:none;">${_bcMediaIconForKind(kind)}</span>`;
                    }
                } else {
                    thumbInner = `<span style="font-size:14px;opacity:0.35;pointer-events:none;">📁</span>`;
                }

                const freeGroups = numberedGroups.filter(g => {
                    const entry = (assignments || []).find(e => e.key === g.key);
                    return !entry || !entry.backgroundFolder;
                });
                const assignControlHtml = _bcRenderItemAssignControls({
                    kind: 'folder',
                    itemVal: folder.path,
                    assignedKeys,
                    freeGroups,
                    allGroups: numberedGroups,
                });

                return `<div class="bc-bg-folder-row ${count > 0 ? 'is-assigned' : ''}" style="display:flex;flex-direction:row;align-items:stretch;gap:10px;padding:8px;margin-top:6px;background:${count > 0 ? 'rgba(124,92,255,0.07)' : 'rgba(255,255,255,0.02)'};border:1px solid ${count > 0 ? 'rgba(124,92,255,0.35)' : 'rgba(124,92,255,0.14)'};border-radius:6px;transition:border-color 0.15s, background 0.15s;" title="${_bcEsc(folder.path)}">
                    <div class="bc-bg-folder-thumb" data-fi="${fi}" title="点击浏览此背景全部素材${firstFile ? `（首个: ${_bcEsc(_bcFileName(firstFile))}）` : ''}">
                        ${thumbInner}
                        ${firstFile && (kind === 'video' || kind === 'image') ? `<span style="position:absolute;bottom:2px;right:2px;font-size:9px;background:rgba(0,0,0,0.78);padding:1px 3px;border-radius:3px;line-height:1.1;color:#ddd;pointer-events:none;">${kind === 'video' ? '🎬' : '🖼'}</span>` : ''}
                    </div>
                    <div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:space-between;gap:4px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                            <div style="font-weight:600;color:#eee;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_bcEsc(folderName)}">${_bcEsc(folderName)}</div>
                            <div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">
                                <button class="bc-background-open-folder" data-fi="${fi}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:#20202e;border:1px solid #3c3c52;border-radius:4px;color:#c4b5fd;" title="在 Finder 中打开此背景文件夹">打开文件夹</button>
                                <button class="bc-background-refresh" data-fi="${fi}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:#20202e;border:1px solid #3c3c52;border-radius:4px;color:#aaa;" title="重新扫描此文件夹">刷新</button>
                                <button class="bc-background-remove" data-fi="${fi}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.25);border-radius:4px;color:#f88;" title="移出背景库">移出库</button>
                            </div>
                        </div>
                        <div style="color:#8a8ab0;font-size:10px;display:flex;align-items:center;gap:6px;">
                            <span>${files.length} 个素材</span>
                            <span>·</span>
                            <span>已选 <span style="${count > 0 ? 'color:#a78bfa;font-weight:600;' : ''}">${count}</span> 次</span>
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;font-size:10px;">
                            <span style="color:#a78bfa;font-weight:600;flex-shrink:0;">分配组:</span>
                            ${assignControlHtml}
                        </div>
                    </div>
                </div>`;
            }).join('')}
        ` : ''}
    </div>`;

    const unassignedMusic = _bulkState.musicFiles.filter(music => {
        const assignedEntries = (assignments || []).filter(entry => entry.musicPath === music.path && numberedGroups.some(group => group.key === entry.key));
        return assignedEntries.length === 0;
    });
    const unassignedMusicCount = unassignedMusic.length;
    const visibleMusic = _bulkState.musicFiles
        .map((music, mi) => ({ music, mi }))
        .filter(({ music }) => {
            if (!_bulkState.filterUnassignedMusic) return true;
            const assignedEntries = (assignments || []).filter(entry => entry.musicPath === music.path && numberedGroups.some(group => group.key === entry.key));
            return assignedEntries.length === 0;
        });

    // 🎵 4. 模块三：配乐库（可折叠）
    html += `<div id="bc-music-library" class="bc-library-box bc-music-library-box" style="background:rgba(16,185,129,0.02);border:1px solid rgba(16,185,129,0.2);border-radius:8px;padding:9px 10px;margin-bottom:10px;">
        <div data-toggle-section="music" style="display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;user-select:none;flex-wrap:wrap;" title="点击折叠 / 展开配乐库">
            <div style="display:flex;align-items:center;gap:6px;">
                <span class="bc-toggle-arrow" style="color:#34d399;font-size:10px;width:12px;text-align:center;display:inline-block;">${isMusicCollapsed ? '▶' : '▼'}</span>
                <span style="font-weight:700;font-size:11.5px;color:#a7f3d0;display:inline-flex;align-items:center;gap:4px;">🎵 配乐库</span>
                <span style="font-size:10px;color:#7ab89b;">(${_bulkState.musicFiles.length} 首配乐)</span>
                ${isMusicCollapsed ? '<span style="font-size:9.5px;color:#717496;background:rgba(255,255,255,0.04);padding:1px 5px;border-radius:3px;border:1px solid rgba(255,255,255,0.06);">已收起</span>' : ''}
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                <button id="bc-add-music" class="bc-btn bc-btn-emerald bc-btn-xs">+ 添加配乐</button>
                <button id="bc-seq-music" class="bc-btn bc-btn-default bc-btn-xs" title="按顺序为每个编号组分配配乐">顺序分配</button>
                <button id="bc-random-music" class="bc-btn bc-btn-emerald bc-btn-xs">🎲 ${_bulkState.allowMusicReuse ? '随机分配（可重复）' : '随机分配（不重复）'}</button>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:#7ab89b;font-size:10px;"><input id="bc-allow-music-reuse" type="checkbox" ${_bulkState.allowMusicReuse ? 'checked' : ''} style="accent-color:#10b981;">允许重复</label>
                <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;color:${_bulkState.filterUnassignedMusic ? '#a7f3d0' : '#7ab89b'};font-size:10px;" title="仅查看尚未分配给任何编号组的配乐"><input id="bc-filter-unassigned-music" type="checkbox" ${_bulkState.filterUnassignedMusic ? 'checked' : ''} style="accent-color:#10b981;">仅未分配${_bulkState.musicFiles.length ? ` (${unassignedMusicCount})` : ''}</label>
                <button id="bc-clear-music-assignments" class="bc-btn bc-btn-default bc-btn-xs" title="清空全部编号组的配乐分配">清空分配</button>
                <button id="bc-clear-music" class="bc-btn bc-btn-danger bc-btn-xs" title="清空全部配乐文件">清空库</button>
            </div>
        </div>
        ${!isMusicCollapsed ? `
            <div style="color:#7ab89b;font-size:10px;margin:6px 0;">可直接拖入多首音频，或点击添加配乐；点击试听按钮可实时播放或停止。</div>
            ${_bulkState.musicFiles.length > 0 && visibleMusic.length === 0 ? '<div style="padding:14px 8px;text-align:center;color:#8a8ab0;font-size:11px;background:rgba(255,255,255,0.02);border:1px dashed #33334a;border-radius:6px;margin-top:6px;">🎉 全部配乐均已分配到编号组</div>' : ''}
            ${visibleMusic.map(({ music, mi }) => {
                const assignedEntries = (assignments || []).filter(entry => entry.musicPath === music.path && numberedGroups.some(group => group.key === entry.key));
                const assignedKeys = assignedEntries.map(entry => entry.key);
                const count = assignedKeys.length;
                const isPlaying = _bcCurrentPlayingMusic === music.path;
                const freeGroups = numberedGroups.filter(g => {
                    const entry = (assignments || []).find(e => e.key === g.key);
                    return !entry || !entry.musicPath;
                });
                const assignControlHtml = _bcRenderItemAssignControls({
                    kind: 'music',
                    itemVal: music.path,
                    assignedKeys,
                    freeGroups,
                    allGroups: numberedGroups,
                });
                return `<div class="bc-music-row${count > 0 ? ' is-assigned' : ''}" style="display:flex;flex-direction:row;align-items:stretch;gap:10px;padding:8px;margin-top:6px;background:${count > 0 ? 'rgba(16,185,129,0.07)' : 'rgba(255,255,255,0.02)'};border:1px solid ${count > 0 ? 'rgba(16,185,129,0.35)' : 'rgba(16,185,129,0.14)'};border-radius:6px;transition:border-color 0.15s, background 0.15s;" title="${_bcEsc(music.path || music.name)}">
                    <div style="width:48px;height:48px;flex:0 0 48px;border-radius:5px;background:#0c1612;border:1px solid #224e3c;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;flex-shrink:0;gap:2px;">
                        <span style="font-size:13px;pointer-events:none;">🎵</span>
                        <button class="bc-music-play" data-path="${_bcEsc(music.path)}" style="width:22px;height:20px;line-height:18px;font-size:10px;padding:0;background:${isPlaying ? '#10b981' : 'rgba(255,255,255,0.06)'};color:${isPlaying ? '#000' : '#a7f3d0'};border:1px solid #10b981;border-radius:3px;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="${isPlaying ? '暂停试听' : '试听播放'}">${isPlaying ? '⏹' : '▶'}</button>
                    </div>
                    <div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:space-between;gap:4px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                            <div style="font-weight:600;color:#e2e8f0;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_bcEsc(music.name)}">${_bcEsc(music.name)}</div>
                            <button class="bc-music-remove" data-mi="${mi}" style="padding:2px 6px;font-size:10px;cursor:pointer;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.25);border-radius:4px;color:#f88;" title="从配乐库移除">移出库</button>
                        </div>
                        <div style="color:#7ab89b;font-size:10px;">已选 <span style="${count > 0 ? 'color:#34d399;font-weight:600;' : ''}">${count}</span> 次</div>
                        <div style="display:flex;align-items:center;gap:6px;font-size:10px;">
                            <span style="color:#34d399;font-weight:600;flex-shrink:0;">分配组:</span>
                            ${assignControlHtml}
                        </div>
                    </div>
                </div>`;
            }).join('')}
        ` : ''}
    </div>`;
    const visibleGroups = numberedGroups.filter(group => {
        if (!_bulkState.filterUnassignedGroups) return true;
        const entry = assignments?.find(item => item.key === group.key);
        return !entry || !entry.backgroundFolder;
    });

    // 📋 5. 模块四：编号组详细配置与微调（可折叠）
    html += `<div id="bc-groups-section" class="bc-library-box" style="background:rgba(255,255,255,0.015);border:1px solid #272942;border-radius:8px;padding:9px 10px;margin-bottom:10px;">
        <div data-toggle-section="groups" style="display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;user-select:none;flex-wrap:wrap;" title="点击折叠 / 展开编号组详细配置">
            <div style="display:flex;align-items:center;gap:6px;">
                <span class="bc-toggle-arrow" style="color:#a78bfa;font-size:10px;width:12px;text-align:center;display:inline-block;">${isGroupsCollapsed ? '▶' : '▼'}</span>
                <span style="font-weight:700;font-size:12px;color:#c4b5fd;display:inline-flex;align-items:center;gap:5px;">📋 编号组详细配置与微调</span>
                <span style="font-size:10px;color:#8a8ab0;">(${visibleGroups.length} / ${numberedGroups.length} 组)</span>
                ${isGroupsCollapsed ? '<span style="font-size:9.5px;color:#717496;background:rgba(255,255,255,0.04);padding:1px 5px;border-radius:3px;border:1px solid rgba(255,255,255,0.06);">已收起</span>' : ''}
            </div>
            <div style="font-size:10px;color:#717496;">
                ${isGroupsCollapsed ? '展开明细 ▶' : '收起明细 ▼'}
            </div>
            <button id="bc-add-viral-groups" class="bc-btn bc-btn-amber bc-btn-xs" title="查看全部爆帖工程组合，可多选加入当前批量任务">🔥 爆帖工程组合库 / 添加</button>
            <button id="bc-export-viral-groups" class="bc-btn bc-btn-default bc-btn-xs" title="导出爆帖工程组合库，可带到另一台电脑或备份">⬆ 导出组合</button>
            <button id="bc-import-viral-groups" class="bc-btn bc-btn-default bc-btn-xs" title="导入之前导出的爆帖工程组合文件">⬇ 导入组合</button>
        </div>
        ${!isGroupsCollapsed ? `
            <div style="font-size:10px;color:#8e92b2;margin:6px 0 8px 0;">${assignments ? '每个编号组独立生成一条任务；点击组内「👁 预览」可查看排版并实时修改覆层标题与正文。' : '当前使用原逐列绑定；点击上方模板卡片或启用编号组分配。'}</div>
            ${numberedGroups.length > 0 && visibleGroups.length === 0 ? '<div style="padding:14px 8px;text-align:center;color:#8a8ab0;font-size:11px;background:rgba(255,255,255,0.02);border:1px dashed #33334a;border-radius:6px;margin-bottom:8px;">🎉 全部编号组均已分配背景素材</div>' : ''}
            ${(() => {
                let gHtml = '';
                visibleGroups.forEach(group => {
                    const entry = assignments?.find(item => item.key === group.key);
                    const assigned = entry ? _bcAssignedTemplate(entry, group) : null;
                    gHtml += `<div class="bc-group-card" data-bc-group-card="${_bcEsc(group.key)}">
            <div style="display:flex;align-items:center;gap:6px;">
                <span class="bc-group-badge" title="内部编号：${_bcEsc(group.key)}">${_bcEsc(group.key)}</span>
                ${entry?.comboName && entry.comboName !== group.key ? `<span style="font-size:11px;color:#fbbf24;" title="来自组合库：${_bcEsc(entry.comboName)}">🔥 ${_bcEsc(entry.comboName)}</span>` : ''}
                <span style="color:#6b7280;font-size:11px;">→</span>
                <select class="bc-group-template" data-group="${_bcEsc(group.key)}" style="flex:1;min-width:0;">
                    <option value="-1">未分配（不生成）</option>
                    ${_bulkState.templates.map((tpl, ti) => `<option value="${ti}" ${entry?.templateIndex === ti ? 'selected' : ''}>${ti + 1}. ${_bcEsc(tpl.label)} · 已选 ${usage[ti]} 次</option>`).join('')}
                </select>
            </div>
            <div class="bc-group-grid">
                <div class="bc-group-field-item">
                    <label style="display:flex;align-items:center;justify-content:space-between;gap:6px;">📁 背景 <button type="button" class="bc-group-open-background-folder bc-btn bc-btn-default bc-btn-xs" data-group="${_bcEsc(group.key)}" ${entry?.backgroundFolder ? '' : 'disabled'} title="在 Finder 中打开当前任务组选择的背景文件夹" style="padding:1px 6px;font-size:10px;">打开文件夹</button></label>
                    <select class="bc-group-background" data-group="${_bcEsc(group.key)}" style="width:100%;">
                        <option value="">沿用模板 / 字段绑定背景</option>
                        ${_bulkState.backgroundFolders.map(folder => `<option value="${_bcEsc(folder.path)}" ${entry?.backgroundFolder === folder.path ? 'selected' : ''}>${_bcEsc(folder.name)}（${folder.files.length} 个素材）</option>`).join('')}
                    </select>
                </div>
                <div class="bc-group-field-item">
                    <label>🔁 背景抽取方式</label>
                    <select class="bc-group-background-mode" data-group="${_bcEsc(group.key)}" style="width:100%;">
                        <option value="cycle" ${!entry?.backgroundMode || entry.backgroundMode === 'cycle' ? 'selected' : ''}>按任务顺序循环</option>
                        <option value="random" ${entry?.backgroundMode === 'random' ? 'selected' : ''}>每条任务随机取一个</option>
                        <option value="concat" ${entry?.backgroundMode === 'concat' ? 'selected' : ''}>全部顺序拼接</option>
                        <option value="selected-cycle" ${entry?.backgroundMode === 'selected-cycle' ? 'selected' : ''}>选择指定素材循环</option>
                    </select>
                </div>
                <div class="bc-group-field-item">
                    <label>🎶 配乐模式</label>
                    <select class="bc-group-music-mode" data-group="${_bcEsc(group.key)}" style="width:100%;">
                        <option value="suite" ${!entry?.musicMode || entry.musicMode === 'suite' ? 'selected' : ''}>整套共用一首</option>
                        <option value="cycle" ${entry?.musicMode === 'cycle' ? 'selected' : ''}>每条任务轮流配乐（配乐库循环）</option>
                    </select>
                </div>
                <div class="bc-group-field-item">
                    <label>🎵 整套配乐</label>
                    <select class="bc-group-music" data-group="${_bcEsc(group.key)}" style="width:100%;" ${entry?.musicMode === 'cycle' ? 'disabled' : ''}>
                        <option value="">沿用模板 / 不指定配乐</option>
                        ${_bulkState.musicFiles.map(music => `<option value="${_bcEsc(music.path)}" ${entry?.musicPath === music.path ? 'selected' : ''}>${_bcEsc(music.name)}</option>`).join('')}
                    </select>
                </div>
            </div>
            ${entry?.backgroundMode === 'selected-cycle' ? `<div style="margin-top:6px;display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:5px;background:rgba(124,92,255,.07);border:1px solid rgba(124,92,255,.22);"><button class="bc-select-background-files bc-btn bc-btn-purple bc-btn-xs" data-group="${_bcEsc(group.key)}">🖼 选择素材 / 预览</button><span style="font-size:10px;color:#c4b5fd;">已选 ${(entry.selectedBackgroundFiles || []).length} 个；仅使用这些素材循环</span></div>` : ''}
            ${assigned ? `
            <div style="margin-top:7px;">
                <button class="bc-preview-group" data-group="${_bcEsc(group.key)}">👁 预览 / 换模板、背景与配乐</button>
                <button class="bc-viral-group-save bc-btn bc-btn-amber bc-btn-xs" data-group="${_bcEsc(group.key)}" title="把当前这个任务组完整保存为独立的爆帖工程组合，不影响原有预设">🔥 保存为爆帖工程组合</button>
                <details class="bc-group-details">
                    <summary class="bc-group-summary">⚙️ 自定义字段匹配</summary>
                    <div style="display:flex;flex-direction:column;gap:4px;margin-top:5px;">
                    ${_bcFieldsFromTask(assigned.task).map(field => {
                        const boundColIndex = assigned.bindings[field.key];
                        const boundColName = boundColIndex != null && boundColIndex >= 0 ? cols[boundColIndex]?.name : '';
                        return `<div style="display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:5px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);">
                            <span style="color:#cbd5e1;width:115px;min-width:115px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;font-weight:500;" title="${_bcEsc(field.label)}">${_bcEsc(field.label)}</span>
                            <select class="bc-group-field" data-group="${_bcEsc(group.key)}" data-field="${_bcEsc(field.key)}" style="min-width:0;flex:1;height:24px;font-size:10.5px;" title="${_bcEsc(boundColName ? `${field.label} → ${boundColName}` : `${field.label}：不绑定`)}">
                                <option value="-1">不绑定 · 用模板默认</option>
                                ${cols.map((col, ci) => _bcFieldAcceptsColumn(field, col) ? `<option value="${ci}" ${boundColIndex === ci ? 'selected' : ''}>${_bcEsc(col.name)}</option>` : '').join('')}
                            </select>
                        </div>`;
                    }).join('')}
                    </div>
                </details>
            </div>` : ''}
        </div>`;
                });
                return gHtml;
            })()}
        ` : ''}
    </div>`;

    // Stats
    const rc = _bulkState.rows.filter(r=>r.some(c=>(c||'').trim())).length;
    const tc = assignments ? usage.reduce((sum, count) => sum + count, 0) : _bulkState.templates.length;
    html += `<div style="margin-top:8px;padding:8px;background:rgba(124,92,255,0.08);border:1px solid rgba(124,92,255,0.2);border-radius:6px;font-size:11px;color:#c4b5fd;text-align:center;">
        ${rc} 行 × ${tc} ${assignments ? '个已分配编号组' : '模板'} = <strong style="color:#fff;font-size:12px;">最多 ${rc*tc} 个任务</strong></div>`;
    el.innerHTML = html;
    if (prevScroll != null) el.scrollTop = prevScroll;

    // Asynchronously render thumbnails
    _bulkState.templates.forEach((tpl, ti) => {
        const task = tpl.task;
        if (typeof PresetThumbRenderer !== 'undefined' && task.overlays && task.overlays.length > 0) {
            _bcRenderTemplateThumb(task.overlays).then(dataUrl => {
                const img = document.getElementById(`bc-bind-thumb-${ti}`);
                const loader = document.getElementById(`bc-bind-thumb-loader-${ti}`);
                if (img && loader && dataUrl) {
                    img.src = dataUrl;
                    img.style.display = 'block';
                    loader.style.display = 'none';
                } else if (loader) {
                    loader.innerText = '暂无';
                }
            }).catch(e => {
                const loader = document.getElementById(`bc-bind-thumb-loader-${ti}`);
                if (loader) loader.innerText = '错误';
            });
        } else {
            const loader = document.getElementById(`bc-bind-thumb-loader-${ti}`);
            if (loader) loader.innerText = '无覆层';
        }
    });
    _bcScheduleDraftSave();
}

// ── Pick templates: show source chooser ──
function _bcPickTemplates() {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;width:380px;padding:24px;text-align:center;">
        <div style="font-size:14px;font-weight:600;color:#fff;margin-bottom:16px;">选择模板来源</div>
        <div style="display:flex;flex-direction:column;gap:10px;">
            <button id="bc-src-project" style="padding:12px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:8px;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">📦 模版工程库<br><span style="font-size:10px;font-weight:normal;opacity:0.8;">从已保存的 .json 工程文件读取完整任务</span></button>
            <button id="bc-src-preset" style="padding:12px;background:rgba(255,255,255,0.08);border:1px solid #444;border-radius:8px;color:#ccc;cursor:pointer;font-size:13px;">🎨 覆层预设库<br><span style="font-size:10px;opacity:0.6;">从覆层样式预设中选取（仅覆层）</span></button>
            <button id="bc-src-tasks" style="padding:12px;background:rgba(255,255,255,0.08);border:1px solid #333;border-radius:8px;color:#ccc;cursor:pointer;font-size:13px;">📋 当前任务<br><span style="font-size:10px;opacity:0.6;">使用当前标签页的任务作为模板</span></button>
            <button id="bc-src-cancel" style="padding:8px;background:transparent;border:1px solid #333;border-radius:8px;color:#888;cursor:pointer;font-size:11px;">取消</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#bc-src-cancel').onclick = () => modal.remove();
    modal.querySelector('#bc-src-project').onclick = () => { modal.remove(); _bcPickFromProjectLib(); };
    modal.querySelector('#bc-src-preset').onclick = () => { modal.remove(); _bcPickFromOverlayPresets(); };
    modal.querySelector('#bc-src-tasks').onclick = () => { modal.remove(); _bcPickFromCurrentTasks(); };
}

// ══════════ 1. 模版工程库 — 从磁盘 .json 工程文件读取 ══════════
// ══════════ 1. 模版工程库 — 直接调用完整的视频模板库 ══════════
async function _bcPickFromProjectLib() {
    if (typeof openTemplateLibrary === 'function') {
        const disabledIds = Array.from(_bcTemplateProjectIdsInUse());
        openTemplateLibrary((tplData) => {
            const tplId = tplData.id || tplData.templateId || '';
            if (_bcIsTemplateProjectInUse(tplId)) {
                alert(`模板工程「${tplData.name || tplId}」已经添加过，不能重复添加。`);
                return;
            }
            const projectData = tplData.projectData;
            if (!projectData || !projectData.tasks || projectData.tasks.length === 0) {
                alert('该模板不包含任何任务，无法导入为批量模板。');
                return;
            }
            
            // 不关闭模态框，允许用户继续选择其他模板
            // const modal = document.getElementById('template-library-modal');
            // if (modal) modal.style.display = 'none';

            // 把这个模板里的任务交给 _bcShowProjectTaskPicker 去选择
            // 或者，如果只有一个任务，直接添加？
            // 默认让用户选择哪个任务作为模版，保持和之前一样的灵活度
            const projName = tplData.name || '已选模板';
            const projectCycle = _bcCollectProjectBackgroundCycle(projectData);
            const projectSource = {
                type: 'template_project',
                templateId: tplId,
                templateName: projName,
            };
            
            if (projectData.tasks.length === 1) {
                // 如果只有一个任务，直接添加，跳过选择界面
                _bcAppendTemplates(projectData.tasks, projName, projectCycle, projectSource);
            } else {
                _bcShowProjectTaskPicker(projName, projectData.tasks, projectCycle, projectSource);
            }
        }, { disabledIds });
    } else {
        alert('未加载模板库模块 (openTemplateLibrary 未定义)');
    }
}

// Helper to append templates
function _bcAppendTemplates(tasksList, projName, projectCycle = null, projectSource = null) {
    if (!tasksList || tasksList.length === 0) return;
    
    // Safely deserialize tasks first if applyProjectData is available
    let safeTasks = _bcDeserializeProjectTasks({ version: '2.0.0', tasks: tasksList });

    safeTasks.forEach((t, idx) => {
        const clone = _bcCloneTemplateTask(t);
        const templateIndex = _bulkState.templates.length;
        const bgCycle = _bcResolveTemplateBgCycle(clone, projectCycle);
        _bulkState.templates.push({
            task: clone,
            label: clone.baseName || clone.fileName || `${projName}_模板${_bulkState.templates.length + 1}`,
            bindings: typeof _bcAutoBind === 'function' ? _bcAutoBind(clone, templateIndex) : {},
            bgCycle,
            source: projectSource?.templateId ? { ...projectSource, mode: 'task', taskIndex: idx } : null,
        });
    });
    
    if (typeof _bcRenderBindings === 'function') _bcRenderBindings();
    if (typeof _bcUpdateStats === 'function') _bcUpdateStats();
    if (typeof _bcScheduleDraftSave === 'function') _bcScheduleDraftSave();
}

function _bcShowProjectTaskPicker(projName, tasks, projectCycle = null, projectSource = null) {
    // Safely deserialize tasks first if applyProjectData is available (so thumbnails work and we save real objects)
    let safeTasks = _bcDeserializeProjectTasks({ version: '2.0.0', tasks });

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';

    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;width:85%;max-width:900px;height:80vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.8);overflow:hidden;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
            <span style="color:#fff;font-weight:600;font-size:14px;">📦 ${_bcEsc(projName)} — 选择任务作为模板</span>
            <div style="display:flex;gap:6px;">
                <button id="bc-proj-unified" style="padding:4px 12px;background:rgba(16,185,129,0.2);border:1px solid rgba(16,185,129,0.3);border-radius:5px;color:#10b981;cursor:pointer;font-size:11px;" title="仅使用该工程的第一个任务作为统一模版导入，忽略多任务拆分">✨ 作为统一模板导入</button>
                <div style="width:1px;background:#333;margin:0 4px;"></div>
                <button id="bc-proj-all" style="padding:4px 12px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:5px;color:#b8a0ff;cursor:pointer;font-size:11px;">全选</button>
                <button id="bc-proj-none" style="padding:4px 12px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">全不选</button>
                <button id="bc-proj-ok" style="padding:4px 16px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">✓ 确定所选</button>
                <button id="bc-proj-cancel" style="padding:4px 12px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
            </div>
        </div>
        <div id="bc-proj-grid" style="overflow:auto;flex:1;padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;align-content:start;"></div>
    </div>`;
    document.body.appendChild(modal);

    const grid = modal.querySelector('#bc-proj-grid');

    // Unified mode
    modal.querySelector('#bc-proj-unified').onclick = () => {
        modal.remove();
        
        // 统一模板代表整个工程，因此使用该工程素材库；没有素材库时再从工程任务中收集。
        const bgCycle = [];
        (projectCycle || []).forEach(p => _bcAddUniqueCyclePath(bgCycle, p));
        if (bgCycle.length === 0) {
            safeTasks.forEach(t => {
                _bcCollectTaskBackgroundCycle(t).forEach(p => _bcAddUniqueCyclePath(bgCycle, p));
            });
        }

        const t0 = safeTasks[0];
        if (!t0) return;
        const clone = _bcCloneTemplateTask(t0);
        const templateIndex = _bulkState.templates.length;
        
        _bulkState.templates.push({
            task: clone,
            label: `${projName}_统一模式`,
            bindings: typeof _bcAutoBind === 'function' ? _bcAutoBind(clone, templateIndex) : {},
            bgCycle: bgCycle.length > 1 ? bgCycle : null,
            source: projectSource?.templateId ? { ...projectSource, mode: 'unified' } : null,
        });
        
        if (typeof _bcRenderBindings === 'function') _bcRenderBindings();
        if (typeof _bcUpdateStats === 'function') _bcUpdateStats();
        if (typeof _bcScheduleDraftSave === 'function') _bcScheduleDraftSave();
    };

    // Build cards
    safeTasks.forEach((t, i) => {
        const bg = (t.bgPath || t.videoPath || '').split(/[/\\]/).pop() || '';
        const ovCount = (t.overlays || []).length;
        const name = t.baseName || t.fileName || `task_${i + 1}`;

        const card = document.createElement('div');
        card.style.cssText = 'background:#0d0d1a;border:2px solid #333;border-radius:8px;overflow:hidden;cursor:pointer;transition:border-color 0.2s,box-shadow 0.2s;';
        card.dataset.idx = i;
        card.dataset.selected = 'true';
        card.classList.add('bc-proj-card');

        card.innerHTML = `
            <div class="bc-proj-thumb" style="width:100%;aspect-ratio:9/16;background:#141424;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;">
                <div style="color:#555;font-size:10px;">加载中...</div>
                <div style="position:absolute;top:6px;right:6px;width:18px;height:18px;border-radius:4px;background:rgba(124,92,255,0.9);display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;">✓</div>
            </div>
            <div style="padding:8px;">
                <div style="color:#eee;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_bcEsc(name)}">${_bcEsc(name)}</div>
                <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;">
                    <span style="font-size:9px;padding:1px 5px;background:rgba(124,92,255,0.15);border-radius:3px;color:#b8a0ff;">${ovCount} 层</span>
                    ${bg ? `<span style="font-size:9px;padding:1px 5px;background:rgba(0,212,255,0.1);border-radius:3px;color:#7dd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100px;" title="${_bcEsc(bg)}">${_bcEsc(bg)}</span>` : ''}
                </div>
            </div>`;

        // Toggle selection
        card.onclick = () => {
            const sel = card.dataset.selected === 'true';
            card.dataset.selected = sel ? 'false' : 'true';
            card.style.borderColor = sel ? '#333' : '#7c5cff';
            card.style.boxShadow = sel ? 'none' : '0 0 0 1px rgba(124,92,255,0.4)';
            const check = card.querySelector('div[style*="position:absolute"]');
            if (check) check.style.display = sel ? 'none' : 'flex';
        };
        // Init as selected
        card.style.borderColor = '#7c5cff';
        card.style.boxShadow = '0 0 0 1px rgba(124,92,255,0.4)';

        grid.appendChild(card);

        // Render thumbnail async
        if (ovCount > 0 && typeof PresetThumbRenderer !== 'undefined') {
            try {
                _bcRenderTemplateThumb(t.overlays).then(url => {
                    const thumbEl = card.querySelector('.bc-proj-thumb');
                    if (url && thumbEl) {
                        thumbEl.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;">
                            <div style="position:absolute;top:6px;right:6px;width:18px;height:18px;border-radius:4px;background:rgba(124,92,255,0.9);display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;">✓</div>`;
                    } else if (thumbEl) {
                        thumbEl.querySelector('div').textContent = '预览生成失败';
                    }
                }).catch(e => {
                    console.error('[BulkCreate] Thumbnail render error:', e);
                    const thumbEl = card.querySelector('.bc-proj-thumb');
                    if (thumbEl) thumbEl.querySelector('div').textContent = '渲染错误';
                });
            } catch(e) {
                console.error('[BulkCreate] Thumbnail init error:', e);
                const thumbEl = card.querySelector('.bc-proj-thumb');
                if (thumbEl) thumbEl.querySelector('div').textContent = '组件错误';
            }
        } else {
            const thumbEl = card.querySelector('.bc-proj-thumb');
            if (thumbEl) thumbEl.querySelector('div').textContent = bg ? `🎬 ${bg}` : '无覆层';
        }
    });

    // Buttons
    modal.querySelector('#bc-proj-cancel').onclick = () => modal.remove();
    modal.querySelector('#bc-proj-all').onclick = () => {
        modal.querySelectorAll('.bc-proj-card').forEach(c => {
            c.dataset.selected = 'true';
            c.style.borderColor = '#7c5cff';
            c.style.boxShadow = '0 0 0 1px rgba(124,92,255,0.4)';
            const check = c.querySelector('div[style*="position:absolute"]');
            if (check) check.style.display = 'flex';
        });
    };
    modal.querySelector('#bc-proj-none').onclick = () => {
        modal.querySelectorAll('.bc-proj-card').forEach(c => {
            c.dataset.selected = 'false';
            c.style.borderColor = '#333';
            c.style.boxShadow = 'none';
            const check = c.querySelector('div[style*="position:absolute"]');
            if (check) check.style.display = 'none';
        });
    };
    modal.querySelector('#bc-proj-ok').onclick = () => {
        const selected = Array.from(modal.querySelectorAll('.bc-proj-card[data-selected="true"]'));
        if (selected.length === 0) { alert('请至少选择一个任务'); return; }

        selected.forEach(card => {
            const t = safeTasks[parseInt(card.dataset.idx)];
            if (!t) return;
            const taskIndex = parseInt(card.dataset.idx);
            const clone = _bcCloneTemplateTask(t);
            const templateIndex = _bulkState.templates.length;
            const bgCycle = _bcResolveTemplateBgCycle(clone, projectCycle);
            _bulkState.templates.push({
                task: clone,
                label: clone.baseName || clone.fileName || `${projName}_模板${_bulkState.templates.length + 1}`,
                bindings: _bcAutoBind(clone, templateIndex),
                bgCycle,
                source: projectSource?.templateId ? { ...projectSource, mode: 'task', taskIndex } : null,
            });
        });
        modal.remove();
        _bcRenderBindings();
        if (typeof _bcScheduleDraftSave === 'function') _bcScheduleDraftSave();
    };
}


// ══════════ 2. 覆层预设库 ══════════
function _bcPickFromOverlayPresets() {
    const state = window._reelsState;
    const panel = state?.overlayPanel;
    if (panel && typeof panel._showPresetGallery === 'function') {
        panel._showPresetGallery((name, data, mode) => {
            _bcAddPresetAsTemplate(name, data);
        }, true);
    } else {
        _bcPickFromPresetsDirectly();
    }
}

function _bcPickFromPresetsDirectly() {
    let presets = {};
    try { presets = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}'); } catch(e) {}
    if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
        for (const [k, v] of Object.entries(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS)) {
            if (!presets[k]) presets[k] = v;
        }
    }
    const names = Object.keys(presets);
    if (names.length === 0) { alert('覆层预设库为空'); return; }

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    let list = names.map(n => {
        const d = presets[n];
        const layers = Array.isArray(d) ? d : (d.layers || []);
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #222;">
            <div style="flex:1;"><div style="color:#eee;font-size:12px;font-weight:600;">${_bcEsc(n)}</div>
            <div style="color:#666;font-size:10px;">${layers.length} 层</div></div>
            <button class="bc-gallery-pick" data-name="${_bcEsc(n)}" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:4px;color:#b8a0ff;cursor:pointer;font-size:10px;">选用</button>
        </div>`;
    }).join('');
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:420px;max-height:60vh;display:flex;flex-direction:column;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-weight:600;">🎨 覆层预设库</span>
            <button class="bc-gallery-close" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">关闭</button>
        </div>
        <div style="overflow:auto;flex:1;">${list}</div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.bc-gallery-close').onclick = () => modal.remove();
    modal.addEventListener('click', e => {
        if (e.target.classList.contains('bc-gallery-pick')) {
            const name = e.target.dataset.name;
            _bcAddPresetAsTemplate(name, presets[name]);
            modal.remove();
        }
    });
}

function _bcAddPresetAsTemplate(name, data) {
    const layers = Array.isArray(data) ? data : (data.layers || []);
    const task = {
        baseName: name,
        fileName: `${name}.mp4`,
        bgPath: null, bgSrcUrl: null,
        audioPath: null, srtPath: null,
        segments: [],
        videoPath: null, srcUrl: null,
        overlays: JSON.parse(JSON.stringify(layers)),
        ttsText: '', ttsVoiceId: '', pipPath: '', status: '',
    };
    _bulkState.templates.push({
        task,
        label: name,
        bindings: _bcAutoBind(task, _bulkState.templates.length),
    });
    _bcRenderBindings();
    if (typeof _bcScheduleDraftSave === 'function') _bcScheduleDraftSave();
}

// ── Pick from current tasks ──
function _bcPickFromCurrentTasks() {
    const state = window._reelsState;
    if (!state || !state.tasks || state.tasks.length === 0) { alert('当前没有任务可作为模板'); return; }
    const tasks = state.tasks;
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    let list = '';
    tasks.forEach((t,i) => {
        const bg = (t.bgPath||t.videoPath||'').split(/[/\\]/).pop()||'无';
        const ovCount = (t.overlays||[]).length;
        list += `<label style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #222;cursor:pointer;">
            <input type="checkbox" class="bc-pick-cb" data-idx="${i}">
            <span style="color:#ccc;font-size:12px;">${i+1}. ${_bcEsc(t.baseName||t.fileName||'task')}</span>
            <span style="color:#666;font-size:10px;">bg:${_bcEsc(bg)} | ${ovCount}层</span>
        </label>`;
    });
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:500px;max-height:70vh;display:flex;flex-direction:column;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-weight:600;">选择工程任务作为模板</span>
            <div style="display:flex;gap:6px;">
                <button id="bc-pick-all" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:5px;color:#b8a0ff;cursor:pointer;font-size:11px;">全选</button>
                <button id="bc-pick-ok" style="padding:3px 14px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">确定</button>
                <button id="bc-pick-cancel" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
            </div>
        </div>
        <div style="overflow:auto;flex:1;">${list}</div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#bc-pick-cancel').onclick = () => modal.remove();
    modal.querySelector('#bc-pick-all').onclick = () => modal.querySelectorAll('.bc-pick-cb').forEach(cb => cb.checked = true);
    modal.querySelector('#bc-pick-ok').onclick = () => {
        const checked = Array.from(modal.querySelectorAll('.bc-pick-cb:checked'));
        checked.forEach(cb => {
            const idx = parseInt(cb.dataset.idx);
            const t = tasks[idx];
            if (!t) return;
            const clone = JSON.parse(JSON.stringify(t));
            delete clone._video; delete clone._bgThumb;
            if (clone.bgSrcUrl && String(clone.bgSrcUrl).startsWith('blob:')) clone.bgSrcUrl = null;
            if (clone.srcUrl && String(clone.srcUrl).startsWith('blob:')) clone.srcUrl = null;
            const templateIndex = _bulkState.templates.length;
            _bulkState.templates.push({
                task: clone,
                label: clone.baseName || clone.fileName || `模板${_bulkState.templates.length+1}`,
                bindings: _bcAutoBind(clone, templateIndex),
            });
        });
        modal.remove();
        _bcRenderBindings();
        if (typeof _bcScheduleDraftSave === 'function') _bcScheduleDraftSave();
    };
}

function _bcRowHasBoundData(tpl, row) {
    let hasData = false;
    let hasBindings = false;
    for (const key of Object.keys(tpl.bindings || {})) {
        const ci = tpl.bindings[key];
        if (ci != null && ci >= 0) {
            hasBindings = true;
            if ((row[ci] || '').trim() !== '') {
                hasData = true;
                break;
            }
        }
    }
    return !hasBindings || hasData;
}

function _bcBuildTasksForTemplate(tpl, rows, cols, startTaskNum) {
    const tasks = [];
    rows.forEach((row, ri) => {
        if (!_bcRowHasBoundData(tpl, row)) return;
        const task = _bcBuildTask(tpl, row, ri, startTaskNum + tasks.length, cols);
        tasks.push(task);
    });
    return tasks;
}

// ── Generate tasks ──
function _bcGenerateTasks() {
    const state = window._reelsState;
    if (!state) { alert('系统未初始化'); return 0; }
    const cols = _bulkState.columns;
    const rows = _bulkState.rows.filter(r => r.some(c => (c||'').trim()));
    if (rows.length === 0) { alert('数据表格为空'); return 0; }
    if (_bulkState.templates.length === 0) { alert('请先添加模板'); return 0; }

    const total = rows.length * _bulkState.templates.length;

    // 明确的生成方式：group_apply (生成任务组并合并应用到外面分组显示)、separate (仅分标签页保存)、current (全部平铺放入当前标签)
    const outputMode = document.getElementById('bc-output-mode')?.value || 'group_apply';

    _bcWarnAllDuplicateTextBindings();

    // ═══ 生成前绑定摘要 ═══
    console.log('═══ [BulkCreate] 生成前绑定摘要 ═══');
    const bindingSummaries = _bulkState.templates.map((tpl, ti) => {
        const fields = _bcFieldsFromTask(tpl.task);
        const summary = {};
        fields.forEach(f => {
            const ci = tpl.bindings[f.key];
            if (ci != null && ci >= 0 && ci < cols.length) {
                summary[f.label] = `col[${ci}]「${cols[ci]?.name}」`;
            }
        });
        console.log(`  模板[${ti}]「${tpl.label}」:`, JSON.stringify(summary, null, 2));
        return JSON.stringify(tpl.bindings);
    });
    // 检测是否有模板共享相同绑定
    const uniqueBindings = new Set(bindingSummaries);
    if (uniqueBindings.size < _bulkState.templates.length) {
        console.warn('[BulkCreate] ⚠️ 有多个模板使用了完全相同的列绑定！这将导致各标签页文案一致。');
    }

    // ═══ 统一生成循环：row × unit (编号组或模板) ═══
    const groups = _bcNumberedColumnGroups();
    const isGroupMode = !!(_bulkState.groupAssignments && _bulkState.groupAssignments.length > 0);
    let generationUnits = [];
    if (isGroupMode) {
        generationUnits = _bulkState.groupAssignments.map(entry => {
            const group = groups.find(g => g.key === entry.key);
            const tpl = _bcAssignedTemplate(entry, group);
            if (!tpl) return null;
            return {
                key: entry.key,
                // 任务组按文案编号识别；覆层模板仍保存在每个任务的配置中。
                name: entry.key,
                tpl,
                ti: entry.templateIndex,
                tasks: [],
            };
        }).filter(Boolean);
    } else {
        generationUnits = _bulkState.templates.map((tpl, ti) => ({
            key: `tpl_${ti + 1}`,
            name: tpl.label || `模板${ti + 1}`,
            tpl,
            ti,
            tasks: [],
        }));
    }

    const missingFolder = generationUnits.find(({ tpl }) => tpl.assignedBackgroundFolder
        && !_bulkState.backgroundFolders.find(folder => folder.path === tpl.assignedBackgroundFolder)?.files?.length);
    if (missingFolder) { alert('所选背景分类为空或已移除，请刷新文件夹或重新分配背景分类。'); return 0; }

    const backgroundIndices = new Map();
    const tasksByTemplate = _bulkState.templates.map(() => []);
    rows.forEach((row, ri) => {
        generationUnits.forEach(unit => {
            const { tpl, ti } = unit;
            if (!_bcRowHasBoundData(tpl, row)) return;
            const presetRowIdx = unit.tasks.length;
            // 编号组内独立计数，避免第 9 组显示 009、025、041 这类全局跳号。
            const task = _bcBuildTask(tpl, row, presetRowIdx, presetRowIdx + 1, cols, isGroupMode ? unit.key : '');
            const backgroundIndex = backgroundIndices.get(tpl) || 0;
            _bcApplyAssignedBackground(task, tpl, backgroundIndex);
            _bcApplyAssignedMusic(task, tpl, presetRowIdx);
            backgroundIndices.set(tpl, backgroundIndex + 1);
            unit.tasks.push(task);
            if (tasksByTemplate[ti]) tasksByTemplate[ti].push(task);
        });
    });

    const activeUnits = generationUnits.filter(u => u.tasks.length > 0);
    const created = activeUnits.reduce((s, u) => s + u.tasks.length, 0);
    if (created === 0) return 0;

    const srtErrors = activeUnits.flatMap(u => u.tasks).filter(task => task?._bulkCreateSrtError);
    if (srtErrors.length > 0) {
        const preview = srtErrors.slice(0, 5).map(task => `${task.fileName}: ${task._bulkCreateSrtError}`).join('\n');
        const remaining = srtErrors.length > 5 ? `\n另有 ${srtErrors.length - 5} 条` : '';
        alert(`有 ${srtErrors.length} 条任务的 SRT 无法读取或解析，已自动取消这些任务的导出勾选：\n\n${preview}${remaining}`);
    }

    // ═══ 输出：根据模式放到不同容器 ═══
    if (outputMode === 'group_apply' && typeof _batchTableState !== 'undefined') {
        // ★ 生成任务组并合并应用到外部分组显示（推荐模式）
        if (typeof _syncTasksToActiveTab === 'function' && typeof _isBatchGroupedProjection === 'function' && !_isBatchGroupedProjection(state.tasks)) {
            _syncTasksToActiveTab();
        }

        const newTabs = [];
        activeUnits.forEach(unit => {
            const tabId = 'tab_' + _batchTableState.nextTabId++;
            const tabName = `批量-${unit.name}`;
            const clonedTasks = typeof _cloneBatchTasks === 'function'
                ? _cloneBatchTasks(unit.tasks)
                : JSON.parse(JSON.stringify(unit.tasks));
            const newTab = {
                id: tabId,
                name: tabName,
                materialDir: '',
                lastRefreshTime: null,
                tasks: clonedTasks,
            };
            _batchTableState.tabs.push(newTab);
            newTabs.push(newTab);
        });

        // 建立按任务组投影到外部队列：使外部列表直接按任务组分组折叠显示
        // 若生成前主队列中已有非投影任务，自动保留在最顶部作为「已有任务」，避免旧任务被清空覆盖
        const existingNonBatchTasks = (Array.isArray(state.tasks) ? state.tasks : []).filter(t => !t._batchProjection);
        const mergedTasks = existingNonBatchTasks.length > 0 ? [...existingNonBatchTasks] : [];
        const appliedTabIds = [];
        newTabs.forEach((tab, tabOrder) => {
            appliedTabIds.push(tab.id);
            (tab.tasks || []).forEach((t, taskOrder) => {
                const cloned = typeof _cloneBatchTasks === 'function'
                    ? _cloneBatchTasks([t])[0]
                    : JSON.parse(JSON.stringify(t));
                if (cloned) {
                    if (typeof _ensureTaskId === 'function') _ensureTaskId(cloned);
                    cloned._batchProjection = true;
                    cloned._batchTabId = tab.id;
                    cloned._batchTabName = tab.name;
                    cloned._batchTabOrder = tabOrder;
                    cloned._batchTaskOrder = taskOrder;
                    mergedTasks.push(cloned);
                }
            });
        });

        _batchTableState.appliedTabIds = appliedTabIds;
        state.tasks = mergedTasks;
        state.selectedIdx = -1;
        if (newTabs[0]) {
            _batchTableState.activeTabId = newTabs[0].id;
        }

        console.log(`[BulkCreate] ✅ 已生成 ${newTabs.length} 个任务组，共 ${mergedTasks.length} 条任务，已合并应用到外部队列`);
    } else if (outputMode === 'separate' && typeof _batchTableState !== 'undefined') {
        // 分标签页模式：仅存入独立标签，外部默认切换至第1个标签
        if (typeof _syncTasksToActiveTab === 'function' && typeof _isBatchGroupedProjection === 'function' && !_isBatchGroupedProjection(state.tasks)) {
            _syncTasksToActiveTab();
        }

        const newTabs = [];
        activeUnits.forEach(unit => {
            const tabId = 'tab_' + _batchTableState.nextTabId++;
            const tabName = `批量-${unit.name}`;
            const clonedTasks = typeof _cloneBatchTasks === 'function'
                ? _cloneBatchTasks(unit.tasks)
                : JSON.parse(JSON.stringify(unit.tasks));
            const newTab = {
                id: tabId,
                name: tabName,
                materialDir: '',
                lastRefreshTime: null,
                tasks: clonedTasks,
            };
            _batchTableState.tabs.push(newTab);
            newTabs.push(newTab);
        });

        const firstNewTab = newTabs[0];
        if (firstNewTab) {
            if (typeof _switchToTab === 'function') {
                _switchToTab(firstNewTab.id, { skipSave: true, skipNextApply: true, skipNextAutoSave: true });
            } else {
                _batchTableState.activeTabId = firstNewTab.id;
                state.tasks = typeof _cloneBatchTasks === 'function'
                    ? _cloneBatchTasks(firstNewTab.tasks || [])
                    : JSON.parse(JSON.stringify(firstNewTab.tasks || []));
                state.selectedIdx = -1;
            }
        }
    } else {
        // 单标签模式或无 _batchTableState 环境
        state.tasks.length = 0;
        const allTasks = typeof _batchTableState === 'undefined'
            ? tasksByTemplate.flat()
            : activeUnits.flatMap(u => u.tasks);
        allTasks.forEach(task => state.tasks.push(task));
    }

    return created;
}

function _bcBuildTask(tpl, row, rowIdx, taskNum, cols, groupKey = '') {
    const task = JSON.parse(JSON.stringify(tpl.task));
    const derivation = window.ReelsTaskDerivation;
    if (!derivation) throw new Error('任务派生模块未加载，请完全重启 VideoKit 后重试');
    // 新任务只继承模板的样式、素材设置与覆层结构。字幕片段、来源文案、
    // 对齐状态和所有实例 ID 都必须重新建立，不能携带模板任务的运行数据。
    derivation.prepareDerivedTask(task);
    // 编号组模式用列组名命名；其他模式保留原来的模板名称规则。
    const prefix = groupKey ? `${groupKey}_` : (_bulkState.templates.length > 1 ? `${tpl.label}_` : 'bulk_');
    task.baseName = `${prefix}${String(taskNum).padStart(3, '0')}`;
    task.fileName = task.baseName + '.mp4';
    task.status = ''; task.bgSrcUrl = null; task.srcUrl = null;

    // Automatic Background Cycling (Unified Mode)
    // If we have a bgCycle array and the user hasn't explicitly mapped a background column
    let hasBgColumnBound = false;
    if (tpl.bindings['__bg__'] != null && tpl.bindings['__bg__'] >= 0 && row[tpl.bindings['__bg__']]) {
        hasBgColumnBound = true;
    }
    
    if (!hasBgColumnBound && tpl.bgCycle && tpl.bgCycle.length > 0) {
        const cycleBg = tpl.bgCycle[rowIdx % tpl.bgCycle.length];
        _bcApplySingleBackground(task, cycleBg);
    }

    // 诊断：确认背景路径
    if (rowIdx === 0) {
        console.log(`[BulkCreate] 模板「${tpl.label}」背景诊断: bgPath="${(task.bgPath||'').split(/[/\\]/).pop()}", videoPath="${(task.videoPath||'').split(/[/\\]/).pop()}", bgCycle=${tpl.bgCycle ? tpl.bgCycle.length + '个' : '无'}, bgBound=${hasBgColumnBound}`);
    }

    const fields = _bcFieldsFromTask(tpl.task);
    console.log(`[BulkCreate] 模板「${tpl.label}」row#${rowIdx} bindings:`, JSON.stringify(tpl.bindings));
    const setOverlayText = (ov, key, value) => {
        if (!ov) return;
        ov[key] = value;
        if (key === 'title_text') ov.title_styled_ranges = null;
        else if (key === 'body_text') ov.body_styled_ranges = null;
        else if (key === 'footer_text') ov.footer_styled_ranges = null;
        else if (key === 'scroll_title') ov.scroll_title_styled_ranges = null;
        else if (key === 'content') {
            ov.scroll_styled_ranges = null;
            ov.styled_ranges = null;
        }
    };

    for (const f of fields) {
        const ci = tpl.bindings[f.key];
        if (ci == null || ci < 0 || ci >= cols.length) continue;
        if (!_bcFieldAcceptsColumn(f, cols[ci])) continue;
        const val = (row[ci] || '').trim();
        console.log(`  [${f.key}] → col[${ci}]「${cols[ci]?.name}」= "${val.slice(0, 30)}"`);
        if (!val) continue;

        if (f.key === '__bg__') { _bcApplySingleBackground(task, val); }
        else if (f.key === '__audio__') { task.audioPath = val; }
        else if (f.key === '__srt__') {
            derivation.bindSrt(task, val, {
                readFileText: path => window.electronAPI?.readFileText?.(path) || '',
                parseSrt: content => {
                    const parser = typeof parseSRT === 'function' ? parseSRT : window.parseSRT;
                    return parser ? parser(content) : [];
                },
                toWordSegments: rawSegments => window.ReelsSubtitleProcessor
                    ? window.ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegments)
                    : rawSegments,
            });
        }
        else if (f.key === '__cv__') { task.contentVideoPath = val; }
        else if (f.key === '__ai__') { task.aiScript = val; }
        else if (f.key === '__txt__') { task.txtContent = val; }
        else if (f.key === '__tts__') { task.ttsText = val; }
        else if (f.key === '__voice_id__') { task.ttsVoiceId = val; }
        else if (f.key === '__export_name__') { task.exportName = val; }
        else if (f.key.startsWith('L')) {
            const m = f.key.match(/^L(\d+)_(.+)$/);
            if (m && task.overlays && task.overlays[parseInt(m[1])]) {
                setOverlayText(task.overlays[parseInt(m[1])], m[2], val);
            }
        } else if (['title_text', 'body_text', 'footer_text'].includes(f.key)) {
            if (task.overlays && task.overlays[0]) setOverlayText(task.overlays[0], f.key, val);
        }
    }
    if (tpl.materialFolder?.mode === 'concat' && Array.isArray(tpl.materialFolder.files) && tpl.materialFolder.files.length > 0) {
        const pool = tpl.materialFolder.files.filter(Boolean);
        task.bgMode = 'multi';
        task.bgClipPool = pool.slice();
        task.bgClipActivePool = pool.slice();
        task.bgClipOrder = 'sequence';
        task.bgPath = pool[0];
        task.videoPath = pool[0];
        task.bgSrcUrl = null;
        task.srcUrl = null;
    }
    if (row._versionTag) {
        task.versionTag = row._versionTag;
    }
    return task;
}
window._bcBuildTask = _bcBuildTask;

// ── Preset save/load ──
const BC_PRESETS_KEY = 'reels_bulk_create_presets';
const BC_VIRAL_GROUP_PRESETS_KEY = 'reels_bulk_create_viral_group_presets';
const BC_VIRAL_PROJECTS_KEY = 'reels_bulk_create_viral_projects';

function _bcGetSavedPresets() {
    try { return JSON.parse(localStorage.getItem(BC_PRESETS_KEY) || '{}'); } catch(e) { return {}; }
}

function _bcGetViralGroupPresets() {
    try { return JSON.parse(localStorage.getItem(BC_VIRAL_GROUP_PRESETS_KEY) || '{}'); } catch (_) { return {}; }
}

function _bcGetViralProjects() {
    let projects = {};
    try { projects = JSON.parse(localStorage.getItem(BC_VIRAL_PROJECTS_KEY) || '{}') || {}; } catch (_) {}
    // 把刚才旧入口保存的“整体爆帖组合”自动迁入工程库，避免用户找不到或丢失。
    const legacy = _bcGetSavedPresets();
    let migrated = false;
    Object.entries(legacy).forEach(([name, item]) => {
        if (item?.category === 'viral' && !projects[name]) {
            projects[name] = { ...item, type: 'viral_project_combo', migratedFromLegacy: true };
            migrated = true;
        }
    });
    if (migrated) localStorage.setItem(BC_VIRAL_PROJECTS_KEY, JSON.stringify(projects));
    return projects;
}

function _bcProjectSnapshot() {
    return {
        type: 'viral_project_combo',
        // 保存的是可复开的“工程工作台”，不是套用到别组的预设。
        columns: JSON.parse(JSON.stringify(_bulkState.columns)),
        templates: _bulkState.templates.map(t => ({
            task: _bcSanitizeTaskForDraft(t.task || {}), label: t.label || '', bindings: { ...(t.bindings || {}) },
            bgCycle: t.bgCycle || null, source: t.source || null, materialFolder: t.materialFolder || null,
        })),
        backgroundFolders: JSON.parse(JSON.stringify(_bulkState.backgroundFolders)),
        musicFiles: JSON.parse(JSON.stringify(_bulkState.musicFiles)),
        groupAssignments: JSON.parse(JSON.stringify(_bulkState.groupAssignments || [])),
        allowTemplateReuse: !!_bulkState.allowTemplateReuse,
        allowBackgroundReuse: !!_bulkState.allowBackgroundReuse,
        allowMusicReuse: !!_bulkState.allowMusicReuse,
        savedAt: new Date().toISOString(),
    };
}

async function _bcSaveViralProject() {
    const name = await _bcPrompt('保存爆帖工程组合', '例如：人声-19-爆帖工程');
    if (!name?.trim()) return;
    const projects = _bcGetViralProjects();
    projects[name.trim()] = _bcProjectSnapshot();
    localStorage.setItem(BC_VIRAL_PROJECTS_KEY, JSON.stringify(projects));
    alert(`✅ 爆帖工程「${name.trim()}」已保存。下次打开即可填新文案、选新视频后生成任务。`);
}

function _bcOpenViralProjectLibrary() {
    const projects = _bcGetViralProjects();
    const names = Object.keys(projects);
    if (!names.length) { alert('暂无爆帖工程。请先点击“保存爆帖工程”。'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:1000004;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `<div style="width:min(560px,95vw);max-height:74vh;display:flex;flex-direction:column;background:#171825;border:1px solid #5b3c81;border-radius:10px;overflow:hidden;"><div style="padding:14px 16px;border-bottom:1px solid #35364d;"><b style="color:#f4ecff;">🔥 爆帖工程库</b><div style="font-size:10px;color:#aaa5be;margin-top:4px;">打开后保留工程结构、编号组和全部设置；文案与素材输入从空白开始，直接制作下一批。</div></div><div style="overflow:auto;flex:1;">${names.map(name => { const p = projects[name]; return `<div style="padding:11px 14px;border-bottom:1px solid #2e2f44;display:flex;gap:10px;align-items:center;"><div style="flex:1;min-width:0;"><div style="font-size:12px;color:#fff;font-weight:600;">🔥 ${_bcEsc(name)}</div><div style="font-size:10px;color:#9e9ab4;margin-top:3px;">${(p.columns || []).length} 列 · ${(p.templates || []).length} 个模板 · ${(p.groupAssignments || []).length} 个编号组 · ${p.savedAt ? new Date(p.savedAt).toLocaleDateString() : ''}</div></div><button class="bc-viral-project-open bc-btn bc-btn-purple bc-btn-xs" data-name="${_bcEsc(name)}">打开工程</button><button class="bc-viral-project-delete bc-btn bc-btn-danger bc-btn-xs" data-name="${_bcEsc(name)}">删除</button></div>`; }).join('')}</div><div style="padding:10px 14px;text-align:right;border-top:1px solid #35364d;"><button class="bc-viral-project-close bc-btn bc-btn-default bc-btn-xs">关闭</button></div></div>`;
    modal.addEventListener('click', e => {
        const t = e.target;
        if (t.classList.contains('bc-viral-project-close')) { modal.remove(); return; }
        const name = t.dataset.name;
        if (t.classList.contains('bc-viral-project-delete')) { if (confirm(`删除爆帖工程「${name}」？`)) { delete projects[name]; localStorage.setItem(BC_VIRAL_PROJECTS_KEY, JSON.stringify(projects)); modal.remove(); _bcOpenViralProjectLibrary(); } return; }
        if (!t.classList.contains('bc-viral-project-open')) return;
        const p = projects[name]; if (!p) return;
        _bulkState.columns = JSON.parse(JSON.stringify(p.columns || []));
        _bulkState.templates = (p.templates || []).map(item => ({ task: item.task || {}, label: item.label || '', bindings: { ...(item.bindings || {}) }, bgCycle: item.bgCycle || null, source: item.source || null, materialFolder: item.materialFolder || null }));
        _bulkState.backgroundFolders = JSON.parse(JSON.stringify(p.backgroundFolders || []));
        _bulkState.musicFiles = JSON.parse(JSON.stringify(p.musicFiles || []));
        _bulkState.groupAssignments = JSON.parse(JSON.stringify(p.groupAssignments || []));
        _bulkState.allowTemplateReuse = !!p.allowTemplateReuse; _bulkState.allowBackgroundReuse = !!p.allowBackgroundReuse; _bulkState.allowMusicReuse = !!p.allowMusicReuse;
        // 新开一批：不带入旧文案、旧选材或已经生成过的任务行。
        _bulkState.rows = Array.from({ length: 20 }, () => new Array(_bulkState.columns.length).fill(''));
        _bcNormalizeStateShape(); modal.remove(); _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave();
        if (typeof showToast === 'function') showToast(`已打开爆帖工程「${name}」，可开始添加新文案和素材`, 'success');
    });
    document.body.appendChild(modal);
}

async function _bcSaveViralGroupPreset(groupKey) {
    const entry = (_bulkState.groupAssignments || []).find(item => item.key === groupKey);
    const template = _bulkState.templates[entry?.templateIndex];
    if (!entry || !template) { alert('请先为该任务组分配模板，再保存为爆帖工程组合'); return null; }
    // 一键保存：默认直接使用当前任务组名，不再打断用户填写名称。
    // 如需自定义名称，可在组合库中进行重命名。
    const presets = _bcGetViralGroupPresets();
    const baseName = groupKey;
    let name = baseName;
    let copyNumber = 2;
    while (presets[name]) name = `${baseName} (${copyNumber++})`;
    const backgroundFolder = _bulkState.backgroundFolders.find(item => item.path === entry.backgroundFolder);
    const music = _bulkState.musicFiles.find(item => item.path === entry.musicPath);
    const sourceGroup = _bcNumberedColumnGroups().find(group => group.key === groupKey);
    presets[name] = {
        type: 'viral_group_combo',
        sourceGroupKey: groupKey, // 仅用于追溯来源；加载到其他组时绝不改写其编号。
        template: {
            task: _bcSanitizeTaskForDraft(template.task || {}), label: template.label || '爆帖模板',
            bindings: { ...(template.bindings || {}) }, bgCycle: template.bgCycle || null,
            source: template.source || null, materialFolder: template.materialFolder || null,
        },
        assignment: JSON.parse(JSON.stringify({ ...entry, key: undefined })),
        // 只存本组的列结构，加载多个爆帖组时会自动生成新的编号列，不会覆盖原组。
        columnSchema: (sourceGroup?.columns || []).map(col => ({
            fieldName: col.name,
            column: JSON.parse(JSON.stringify(_bulkState.columns[col.ci] || {})),
        })),
        backgroundFolder: backgroundFolder ? JSON.parse(JSON.stringify(backgroundFolder)) : null,
        music: music ? JSON.parse(JSON.stringify(music)) : null,
        savedAt: new Date().toISOString(),
    };
    localStorage.setItem(BC_VIRAL_GROUP_PRESETS_KEY, JSON.stringify(presets));
    if (typeof showToast === 'function') showToast(`已保存爆帖工程组合「${name}」`, 'success');
    else alert(`✅ 已保存爆帖工程组合「${name}」`);
    return name;
}

function _bcAddViralGroupsFromLibrary() {
    const presets = _bcGetViralGroupPresets();
    const names = Object.keys(presets);
    if (!names.length) { alert('爆帖工程组合库还是空的。先在一个任务组点“保存为爆帖工程组合”。'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:1000003;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `<div style="width:min(580px,95vw);max-height:74vh;display:flex;flex-direction:column;background:#171825;border:1px solid #4a3b69;border-radius:10px;overflow:hidden;"><div style="padding:13px 15px;border-bottom:1px solid #33344b;color:#f4efff;"><b>🔥 爆帖工程组合库</b><div style="margin-top:4px;font-size:10px;color:#aaa5be;">可多选。每个组合都会新增一个编号任务组，原有任务组与预设均不改动。</div></div><div style="overflow:auto;flex:1;">${names.map(name => { const p = presets[name]; return `<label style="padding:10px 13px;border-bottom:1px solid #2d2e42;display:flex;align-items:center;gap:9px;cursor:pointer;"><input class="bc-viral-add-check" type="checkbox" data-name="${_bcEsc(name)}" style="accent-color:#a855f7;"><div style="flex:1;min-width:0;"><div style="font-size:12px;color:#f2e8ff;font-weight:600;">🔥 ${_bcEsc(name)}</div><div style="font-size:10px;color:#9994b2;margin-top:3px;">来源任务组：${_bcEsc(p.sourceGroupKey || '未记录')} · ${p.template?.label ? _bcEsc(p.template.label) : '模板'} · ${p.savedAt ? new Date(p.savedAt).toLocaleDateString() : ''}</div></div><button type="button" class="bc-viral-group-delete bc-btn bc-btn-danger bc-btn-xs" data-name="${_bcEsc(name)}" title="删除这个保存的组合；不会删除来源任务组" style="flex-shrink:0;">删除</button></label>`; }).join('')}</div><div style="padding:10px 13px;border-top:1px solid #33344b;display:flex;justify-content:space-between;align-items:center;"><span style="font-size:10px;color:#9994b2;">加载后在新编号组中填文案/选择视频，随后统一批量生成。</span><div style="display:flex;gap:6px;"><button class="bc-viral-add-cancel bc-btn bc-btn-default bc-btn-xs">取消</button><button class="bc-viral-add-confirm bc-btn bc-btn-purple bc-btn-xs">加入已选组合</button></div></div></div>`;
    modal.addEventListener('click', e => {
        const deleteButton = e.target.closest?.('.bc-viral-group-delete');
        if (deleteButton) {
            e.preventDefault();
            e.stopPropagation();
            const name = deleteButton.dataset.name;
            if (!name || !presets[name]) return;
            if (!confirm(`删除爆帖工程组合「${name}」？\n\n只会删除组合库中的这一项，不会删除来源任务组、模板或预设。`)) return;
            delete presets[name];
            localStorage.setItem(BC_VIRAL_GROUP_PRESETS_KEY, JSON.stringify(presets));
            modal.remove();
            _bcAddViralGroupsFromLibrary();
            return;
        }
        if (e.target.classList.contains('bc-viral-add-cancel')) { modal.remove(); return; }
        if (!e.target.classList.contains('bc-viral-add-confirm')) return;
        const selected = [...modal.querySelectorAll('.bc-viral-add-check:checked')]
            .map(item => ({ name: item.dataset.name, preset: presets[item.dataset.name] }))
            .filter(item => Boolean(item.preset));
        if (!selected.length) { alert('请至少选择一个爆帖工程组'); return; }
        const value = id => document.getElementById(id)?.value ?? (id === 'bc-header-prefix' ? 'reels' : id === 'bc-header-before' || id === 'bc-header-after' ? '-' : '');
        const after = value('bc-header-after');
        const usedKeys = new Set(_bcNumberedColumnGroups().map(group => group.key));
        if (!_bulkState.groupAssignments) _bulkState.groupAssignments = [];
        const addedGroupKeys = [];
        selected.forEach(({ name: presetName, preset }, index) => {
            if (!preset.template || !preset.assignment) return;
            if (preset.backgroundFolder && !_bulkState.backgroundFolders.some(item => item.path === preset.backgroundFolder.path)) _bulkState.backgroundFolders.push(JSON.parse(JSON.stringify(preset.backgroundFolder)));
            if (preset.music && !_bulkState.musicFiles.some(item => item.path === preset.music.path)) _bulkState.musicFiles.push(JSON.parse(JSON.stringify(preset.music)));
            let key = presetName;
            let copyNumber = 2;
            while (usedKeys.has(key)) key = `${presetName} (${copyNumber++})`;
            usedKeys.add(key);
            addedGroupKeys.push(key);
            const schema = preset.columnSchema || [];
            schema.forEach((item, schemaIndex) => {
                const column = JSON.parse(JSON.stringify(item.column || { type: 'text' }));
                column.name = `${key}${after}${item.fieldName || `字段${schemaIndex + 1}`}`;
                _bulkState.columns.push(column);
                _bulkState.rows.forEach(row => row.push(''));
            });
            const copiedTemplate = { task: JSON.parse(JSON.stringify(preset.template.task || {})), label: preset.template.label || `爆帖工程${index + 1}`, bindings: { ...(preset.template.bindings || {}) }, bgCycle: preset.template.bgCycle || null, source: preset.template.source || null, materialFolder: preset.template.materialFolder || null };
            _bulkState.templates.push(copiedTemplate);
            // 新编号组的列名已改号，旧组的绝对列名不能直接复用；由字段类别重新绑定到新建列。
            _bulkState.groupAssignments.push({ ...JSON.parse(JSON.stringify(preset.assignment)), key, comboName: presetName, bindings: {}, templateIndex: _bulkState.templates.length - 1 });
        });
        _bulkState.collapsedSections.groups = false;
        _bulkState.filterUnassignedGroups = false;
        _bcNormalizeStateShape(); modal.remove(); _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave();
        const addedCount = addedGroupKeys.length;
        if (typeof showToast === 'function') showToast(`已加入 ${addedCount} 个组合：${addedGroupKeys.join('、')}，表头和任务组已沿用组合名称。`, 'success', 7000);
        // 组合已经写入状态和列，但此前没有把用户带到右侧的新任务组，容易误以为没有生效。
        setTimeout(() => {
            const newest = addedGroupKeys.at(-1);
            const card = newest ? document.querySelector(`[data-bc-group-card="${CSS.escape(newest)}"]`) : null;
            const section = document.getElementById('bc-groups-section');
            (card || section)?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
            (card || section)?.classList?.add('bc-quick-locate-target');
            setTimeout(() => (card || section)?.classList?.remove('bc-quick-locate-target'), 2500);
        }, 80);
    });
    document.body.appendChild(modal);
}

function _bcExportViralGroups() {
    const groups = _bcGetViralGroupPresets();
    const names = Object.keys(groups);
    if (!names.length) { alert('爆帖工程库还是空的，没有可导出的工程组。'); return; }
    const payload = { type: 'videokit_viral_engineering_groups', version: 1, exportedAt: new Date().toISOString(), groups };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `爆帖工程组_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function _bcImportViralGroups() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = () => {
        const file = input.files?.[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                if (data?.type !== 'videokit_viral_engineering_groups' || !data.groups || typeof data.groups !== 'object') {
                    alert('不是有效的爆帖工程组导入文件'); return;
                }
                const current = _bcGetViralGroupPresets();
                const duplicate = Object.keys(data.groups).filter(name => current[name]);
                const apply = () => {
                    let added = 0, overwritten = 0;
                    Object.entries(data.groups).forEach(([name, group]) => {
                        if (!group?.template || !group?.assignment) return;
                        if (current[name]) overwritten++; else added++;
                        current[name] = group;
                    });
                    localStorage.setItem(BC_VIRAL_GROUP_PRESETS_KEY, JSON.stringify(current));
                    alert(`✅ 已导入爆帖工程组：新增 ${added} 个${overwritten ? `，覆盖 ${overwritten} 个同名工程组` : ''}`);
                };
                if (duplicate.length && !confirm(`发现 ${duplicate.length} 个同名爆帖工程组，导入将覆盖它们。是否继续？`)) return;
                apply();
            } catch (_) { alert('读取失败：文件不是有效 JSON'); }
        };
        reader.readAsText(file);
    };
    input.click();
}

function _bcLoadViralGroupPreset(targetGroupKey) {
    const presets = _bcGetViralGroupPresets();
    const names = Object.keys(presets);
    if (!names.length) { alert('爆帖组合库还是空的。先在任意编号组点击“存为爆帖组合”。'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:1000003;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML = `<div style="width:min(520px,95vw);max-height:72vh;display:flex;flex-direction:column;background:#171825;border:1px solid #4a3b69;border-radius:10px;overflow:hidden;"><div style="padding:13px 15px;border-bottom:1px solid #33344b;color:#f4efff;"><b>🔥 套用爆帖组合到「${_bcEsc(targetGroupKey)}」</b><div style="margin-top:4px;font-size:10px;color:#aaa5be;">只替换当前编号组的模板、字段绑定、背景和配乐；其他编号组完全不变。</div></div><div style="overflow:auto;flex:1;">${names.map(name => { const p = presets[name]; return `<div style="padding:10px 13px;border-bottom:1px solid #2d2e42;display:flex;align-items:center;gap:8px;"><div style="flex:1;min-width:0;"><div style="font-size:12px;color:#f2e8ff;font-weight:600;">🔥 ${_bcEsc(name)}</div><div style="font-size:10px;color:#9994b2;margin-top:3px;">来源：${_bcEsc(p.sourceGroupKey || '未记录')} · ${p.savedAt ? new Date(p.savedAt).toLocaleDateString() : ''}</div></div><button class="bc-viral-group-load bc-btn bc-btn-purple bc-btn-xs" data-name="${_bcEsc(name)}">套用到此组</button><button class="bc-viral-group-del bc-btn bc-btn-danger bc-btn-xs" data-name="${_bcEsc(name)}">删除</button></div>`; }).join('')}</div><div style="padding:9px 13px;text-align:right;border-top:1px solid #33344b;"><button class="bc-viral-close bc-btn bc-btn-default bc-btn-xs">关闭</button></div></div>`;
    modal.addEventListener('click', e => {
        const button = e.target;
        if (button.classList.contains('bc-viral-close')) { modal.remove(); return; }
        const name = button.dataset.name;
        if (button.classList.contains('bc-viral-group-del')) { if (confirm(`删除爆帖组合「${name}」？`)) { delete presets[name]; localStorage.setItem(BC_VIRAL_GROUP_PRESETS_KEY, JSON.stringify(presets)); modal.remove(); _bcLoadViralGroupPreset(targetGroupKey); } return; }
        if (!button.classList.contains('bc-viral-group-load')) return;
        const preset = presets[name]; if (!preset?.template || !preset.assignment) return;
        if (preset.backgroundFolder && !_bulkState.backgroundFolders.some(item => item.path === preset.backgroundFolder.path)) _bulkState.backgroundFolders.push(preset.backgroundFolder);
        if (preset.music && !_bulkState.musicFiles.some(item => item.path === preset.music.path)) _bulkState.musicFiles.push(preset.music);
        const copiedTemplate = { task: preset.template.task || {}, label: preset.template.label || name, bindings: { ...(preset.template.bindings || {}) }, bgCycle: preset.template.bgCycle || null, source: preset.template.source || null, materialFolder: preset.template.materialFolder || null };
        _bulkState.templates.push(copiedTemplate);
        if (!_bulkState.groupAssignments) _bulkState.groupAssignments = [];
        const assignment = { ...JSON.parse(JSON.stringify(preset.assignment)), key: targetGroupKey, templateIndex: _bulkState.templates.length - 1 };
        const oldIndex = _bulkState.groupAssignments.findIndex(item => item.key === targetGroupKey);
        if (oldIndex >= 0) _bulkState.groupAssignments[oldIndex] = assignment;
        else _bulkState.groupAssignments.push(assignment);
        modal.remove(); _bcRenderBindings(); _bcScheduleDraftSave();
        if (typeof showToast === 'function') showToast(`已将爆帖组合「${name}」套用到 ${targetGroupKey}`, 'success');
    });
    document.body.appendChild(modal);
}

async function _bcSavePreset(category = 'regular') {
    const isViral = category === 'viral';
    const name = await _bcPrompt(isViral ? '给爆帖组合命名' : '输入大量制作模版名称', isViral ? '例如：爆帖-人声19-21.4' : '例如：FB批量配置');
    if (!name || !name.trim()) return;
    const presets = _bcGetSavedPresets();
    presets[name.trim()] = {
        // 保存的是当前组合的完整快照；编号组与原始绑定不会被移动或重写。
        category: isViral ? 'viral' : 'regular',
        backgroundFolders: _bulkState.backgroundFolders,
        musicFiles: _bulkState.musicFiles,
        groupAssignments: _bulkState.groupAssignments,
        allowTemplateReuse: _bulkState.allowTemplateReuse,
        columns: JSON.parse(JSON.stringify(_bulkState.columns)),
        templates: _bulkState.templates.map(t => ({
            task: _bcSanitizeTaskForDraft(t.task || {}),
            label: t.label,
            bindings: { ...t.bindings },
            bgCycle: t.bgCycle || null,
            source: t.source || null,
            materialFolder: t.materialFolder || null,
        })),
        savedAt: new Date().toISOString(),
    };
    localStorage.setItem(BC_PRESETS_KEY, JSON.stringify(presets));
    alert(`✅ ${isViral ? '爆帖组合' : '大量制作模版'}「${name.trim()}」已保存`);
}

function _bcLoadPreset() {
    const presets = _bcGetSavedPresets();
    const names = Object.keys(presets);
    if (names.length === 0) { alert('暂无保存的大量制作模版'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    let list = '';
    names.forEach(n => {
        const p = presets[n];
        const colCount = (p.columns||[]).length;
        const tplCount = (p.templates||[]).length;
        const date = p.savedAt ? new Date(p.savedAt).toLocaleDateString() : '';
        const isViral = p.category === 'viral';
        list += `<div class="bc-preset-row" data-category="${isViral ? 'viral' : 'regular'}" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #222;">
            <div style="flex:1;">
                <div style="color:#eee;font-size:12px;font-weight:600;">${isViral ? '🔥 ' : ''}${_bcEsc(n)}</div>
                <div style="color:#666;font-size:10px;">${isViral ? '爆帖组合 · ' : ''}${colCount}列 · ${tplCount}模板 · ${date}</div>
            </div>
            <div style="display:flex;gap:4px;">
                <button class="bc-preset-load" data-name="${_bcEsc(n)}" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:4px;color:#b8a0ff;cursor:pointer;font-size:10px;">加载</button>
                <button class="bc-preset-del" data-name="${_bcEsc(n)}" style="padding:3px 8px;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);border-radius:4px;color:#f88;cursor:pointer;font-size:10px;">删除</button>
            </div>
        </div>`;
    });
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:420px;max-height:60vh;display:flex;flex-direction:column;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-weight:600;">📂 组合库</span>
            <button class="bc-preset-close" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">关闭</button>
        </div>
        <div style="padding:8px 12px;border-bottom:1px solid #2b2c40;display:flex;gap:6px;"><button class="bc-preset-filter" data-filter="all">全部 (${names.length})</button><button class="bc-preset-filter" data-filter="viral">🔥 爆帖组合 (${names.filter(n => presets[n].category === 'viral').length})</button><button class="bc-preset-filter" data-filter="regular">常规组合</button></div>
        <div style="overflow:auto;flex:1;">${list}</div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.bc-preset-close').onclick = () => modal.remove();
    modal.addEventListener('click', e => {
        const t = e.target;
        if (t.classList.contains('bc-preset-filter')) {
            const filter = t.dataset.filter;
            modal.querySelectorAll('.bc-preset-row').forEach(row => row.style.display = filter === 'all' || row.dataset.category === filter ? 'flex' : 'none');
            return;
        }
        if (t.classList.contains('bc-preset-load')) {
            const name = t.dataset.name;
            const p = presets[name];
            if (!p) return;
            _bulkState.columns = JSON.parse(JSON.stringify(p.columns || []));
            _bulkState.backgroundFolders = p.backgroundFolders || [];
            _bulkState.musicFiles = p.musicFiles || [];
            _bulkState.groupAssignments = p.groupAssignments || null;
            _bulkState.allowTemplateReuse = !!p.allowTemplateReuse;
            _bulkState.templates = (p.templates || []).map(t => ({ task: t.task, label: t.label, bindings: { ...t.bindings }, bgCycle: t.bgCycle || null, source: t.source || null, materialFolder: t.materialFolder || null }));
            // Keep existing rows but pad/trim to match new column count
            _bulkState.rows.forEach(r => {
                while (r.length < _bulkState.columns.length) r.push('');
                if (r.length > _bulkState.columns.length) r.length = _bulkState.columns.length;
            });
            if (_bulkState.rows.length === 0) {
                for (let i = 0; i < 20; i++) _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
            }
            modal.remove();
            _bcRenderTable(); _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-preset-del')) {
            const name = t.dataset.name;
            if (!confirm(`删除模版「${name}」？`)) return;
            delete presets[name];
            localStorage.setItem(BC_PRESETS_KEY, JSON.stringify(presets));
            t.closest('div[style*="border-bottom"]').remove();
            return;
        }
    });
}

function _bcExportPreset() {
    const presets = _bcGetSavedPresets();
    const names = Object.keys(presets);
    if (names.length === 0) { alert('暂无保存的大量制作模版可导出'); return; }

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    let list = '';
    names.forEach(n => {
        const p = presets[n];
        const tplCount = (p.templates || []).length;
        const colCount = (p.columns || []).length;
        const date = p.savedAt ? new Date(p.savedAt).toLocaleDateString() : '';
        list += `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #222;cursor:pointer;">
            <input type="checkbox" class="bc-export-cb" data-name="${_bcEsc(n)}" checked>
            <div style="flex:1;">
                <div style="color:#eee;font-size:12px;font-weight:600;">${_bcEsc(n)}</div>
                <div style="color:#666;font-size:10px;">${colCount}列 · ${tplCount}模板 · ${date}</div>
            </div>
        </label>`;
    });
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:440px;max-height:65vh;display:flex;flex-direction:column;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-weight:600;">⬆ 选择要导出的模版</span>
            <div style="display:flex;gap:6px;">
                <button class="bc-export-all" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:5px;color:#b8a0ff;cursor:pointer;font-size:11px;">全选</button>
                <button class="bc-export-none" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">全不选</button>
            </div>
        </div>
        <div style="overflow:auto;flex:1;">${list}</div>
        <div style="padding:10px 16px;border-top:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span class="bc-export-count" style="color:#888;font-size:11px;">已选 ${names.length}/${names.length}</span>
            <div style="display:flex;gap:6px;">
                <button class="bc-export-ok" style="padding:5px 18px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">导出</button>
                <button class="bc-export-cancel" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
            </div>
        </div>
    </div>`;
    document.body.appendChild(modal);

    const updateCount = () => {
        const checked = modal.querySelectorAll('.bc-export-cb:checked').length;
        const total = modal.querySelectorAll('.bc-export-cb').length;
        const countEl = modal.querySelector('.bc-export-count');
        if (countEl) countEl.textContent = `已选 ${checked}/${total}`;
    };
    modal.addEventListener('change', updateCount);
    modal.querySelector('.bc-export-all').onclick = () => { modal.querySelectorAll('.bc-export-cb').forEach(cb => cb.checked = true); updateCount(); };
    modal.querySelector('.bc-export-none').onclick = () => { modal.querySelectorAll('.bc-export-cb').forEach(cb => cb.checked = false); updateCount(); };
    modal.querySelector('.bc-export-cancel').onclick = () => modal.remove();
    modal.querySelector('.bc-export-ok').onclick = () => {
        const selected = Array.from(modal.querySelectorAll('.bc-export-cb:checked')).map(cb => cb.dataset.name);
        if (selected.length === 0) { alert('请至少选择一个模版'); return; }
        const exportData = {};
        selected.forEach(name => { if (presets[name]) exportData[name] = presets[name]; });
        const data = {
            type: 'bulk_create_preset',
            version: 1,
            presets: exportData,
            exportedAt: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `bulk_presets_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        modal.remove();
    };
}

function _bcImportPreset() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try {
                const data = JSON.parse(ev.target.result);
                if (data.type !== 'bulk_create_preset') { alert('不是有效的大量制作模版文件'); return; }

                // New multi-preset format: merge into preset library
                if (data.presets && typeof data.presets === 'object') {
                    const existing = _bcGetSavedPresets();
                    const importNames = Object.keys(data.presets);
                    let added = 0, updated = 0;
                    for (const [name, preset] of Object.entries(data.presets)) {
                        if (existing[name]) updated++;
                        else added++;
                        existing[name] = preset;
                    }
                    localStorage.setItem(BC_PRESETS_KEY, JSON.stringify(existing));
                    alert(`✅ 已导入 ${importNames.length} 个模版到库中（新增 ${added}，覆盖 ${updated}）`);
                    return;
                }

                // Legacy single-preset format: load directly into current state
                if (!data.columns) { alert('不是有效的大量制作模版文件'); return; }
                _bulkState.columns = data.columns;
                _bulkState.backgroundFolders = data.backgroundFolders || [];
                _bulkState.musicFiles = data.musicFiles || [];
                _bulkState.groupAssignments = data.groupAssignments || null;
                _bulkState.allowTemplateReuse = !!data.allowTemplateReuse;
                _bulkState.templates = (data.templates || []).map(t => ({ task: t.task, label: t.label, bindings: { ...t.bindings }, bgCycle: t.bgCycle || null, source: t.source || null, materialFolder: t.materialFolder || null }));
                _bulkState.rows.forEach(r => {
                    while (r.length < _bulkState.columns.length) r.push('');
                    if (r.length > _bulkState.columns.length) r.length = _bulkState.columns.length;
                });
                if (_bulkState.rows.length === 0) {
                    for (let i = 0; i < 20; i++) _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
                }
                _bcRenderTable(); _bcRenderBindings();
                alert(`✅ 已导入：${_bulkState.columns.length}列 · ${_bulkState.templates.length}模板`);
            } catch(err) { alert('导入失败：' + err.message); }
        };
        reader.readAsText(file);
    };
    input.click();
}

// ── Main Modal ──
function _showBulkCreateModal() {
    const existing = document.getElementById('bc-modal');
    if (_bcModalAbort) {
        _bcModalAbort.abort();
        _bcModalAbort = null;
    }
    if (existing) existing.remove();
    _bcLoadDraftOnce();
    if (_bulkState.rows.length === 0) {
        for (let i = 0; i < 20; i++) _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
    }
    _bcNormalizeStateShape();
    _bcModalAbort = new AbortController();
    const bcModalSignal = _bcModalAbort.signal;
    const ov = document.createElement('div');
    ov.id = 'bc-modal';
    ov.style.cssText = 'position:fixed;top:32px;left:0;right:0;bottom:0;z-index:200000;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;font-family:system-ui,-apple-system,sans-serif;isolation:isolate;border-top:1px solid #333;';
    
    let style = document.getElementById('bc-styles');
    if (!style) {
        style = document.createElement('style');
        style.id = 'bc-styles';
        document.head.appendChild(style);
    }
    style.innerHTML = `
            .bc-data-table {
                width: max-content;
                min-width: 100%;
                border-collapse: separate;
                border-spacing: 0;
                table-layout: fixed;
                background: #0a0a14;
            }
            .bc-data-table th {
                position: sticky;
                top: 0;
                z-index: 2;
                background: #121222;
                border: 1px solid #252535;
                border-left: 0;
                height: 26px;
            }
            .bc-data-table td {
                border: 1px solid #222235;
                border-left: 0;
                border-top: 0;
                height: 34px;
                padding: 0;
                background: #0a0a14;
            }
            .bc-grid-td {
                min-width: 140px;
                max-width: 240px;
                position: relative;
                cursor: cell;
                user-select: none;
            }
            .bc-cell {
                height: 34px;
                line-height: 34px;
                padding: 0 6px;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
                color: #cfd0dc;
                font-size: 11px;
                box-sizing: border-box;
            }
            .bc-cell-media {
                color: #aab2c4;
                font-size: 10px;
                display: flex;
                align-items: center;
                gap: 6px;
                line-height: 1.2;
            }
            .bc-media-thumb {
                width: 26px;
                height: 26px;
                flex: 0 0 26px;
                object-fit: cover;
                border-radius: 3px;
                background: #05050a;
                border: 1px solid #333348;
                display: block;
            }
            .bc-media-icon {
                width: 26px;
                height: 26px;
                flex: 0 0 26px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
                background: #151526;
                border: 1px solid #333348;
                font-size: 13px;
            }
            .bc-media-name {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .bc-cell-placeholder {
                display: inline-block;
                width: 1px;
            }
            .bc-grid-td.bc-selected-cell {
                background-color: rgba(124,92,255,0.2) !important;
                box-shadow: inset 0 0 0 1px rgba(124,92,255,0.95) !important;
                outline: none !important;
            }
            .bc-grid-td.bc-selected-cell .bc-cell {
                background-color: rgba(124,92,255,0.18) !important;
                color: #fff !important;
            }
            .bc-grid-td.bc-anchor-cell {
                box-shadow: inset 0 0 0 2px #7c5cff !important;
                background-color: rgba(124,92,255,0.28) !important;
                z-index: 1;
            }
            .bc-grid-td.bc-anchor-cell .bc-cell {
                background-color: rgba(124,92,255,0.24) !important;
            }
            .bc-grid-td.bc-media-drop-target,
            .bc-media-col-header.bc-media-drop-target {
                background: rgba(46,213,115,0.18) !important;
                box-shadow: inset 0 0 0 2px #2ed573 !important;
            }
            .bc-grid-td.bc-media-drop-target .bc-cell {
                background: rgba(46,213,115,0.16) !important;
                color: #eafff2 !important;
            }
            .bc-media-col-header {
                cursor: copy;
            }
            .bc-bg-folder-row {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 6px 8px;
                margin-top: 5px;
                background: rgba(255,255,255,0.02);
                border: 1px solid rgba(124,92,255,0.18);
                border-radius: 6px;
                transition: border-color 0.15s, background 0.15s;
            }
            .bc-bg-folder-row:hover {
                border-color: rgba(124,92,255,0.45);
                background: rgba(255,255,255,0.05);
            }
            .bc-bg-folder-thumb {
                width: 48px;
                height: 66px;
                flex: 0 0 48px;
                border-radius: 5px;
                overflow: hidden;
                background: #0c0c16;
                border: 1px solid #36364e;
                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
                cursor: pointer;
                transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
            }
            .bc-bg-folder-thumb:hover {
                border-color: #a78bfa;
                box-shadow: 0 0 8px rgba(124,92,255,0.45);
                transform: scale(1.04);
            }
            .bc-music-row {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 5px 8px;
                margin-top: 5px;
                background: rgba(255,255,255,0.02);
                border: 1px solid rgba(52,211,153,0.18);
                border-radius: 6px;
                transition: border-color 0.15s, background 0.15s;
            }
            .bc-music-row:hover {
                border-color: rgba(52,211,153,0.45);
                background: rgba(255,255,255,0.05);
            }

            /* Custom sleek scrollbars */
            #bc-table-body::-webkit-scrollbar,
            #bc-bind-panel::-webkit-scrollbar {
                width: 6px;
                height: 6px;
            }
            #bc-table-body::-webkit-scrollbar-track,
            #bc-bind-panel::-webkit-scrollbar-track {
                background: #0b0c16;
            }
            #bc-table-body::-webkit-scrollbar-thumb,
            #bc-bind-panel::-webkit-scrollbar-thumb {
                background: #25273c;
                border-radius: 3px;
            }
            #bc-table-body::-webkit-scrollbar-thumb:hover,
            #bc-bind-panel::-webkit-scrollbar-thumb:hover {
                background: #3e4268;
            }

            /* Buttons */
            .bc-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                height: 24px;
                padding: 0 8px;
                font-size: 11px;
                font-weight: 500;
                border-radius: 5px;
                border: 1px solid transparent;
                cursor: pointer;
                transition: all 0.15s ease;
                user-select: none;
                white-space: nowrap;
                box-sizing: border-box;
            }
            .bc-btn:hover {
                filter: brightness(1.12);
            }
            .bc-btn:active {
                transform: translateY(1px);
            }
            .bc-btn-default {
                background: rgba(255,255,255,0.06);
                border-color: rgba(255,255,255,0.12);
                color: #cbd5e1;
            }
            .bc-btn-default:hover {
                background: rgba(255,255,255,0.12);
                border-color: rgba(255,255,255,0.24);
                color: #fff;
            }
            .bc-btn-purple {
                background: rgba(124,92,255,0.15);
                border-color: rgba(124,92,255,0.38);
                color: #c4b5fd;
            }
            .bc-btn-purple:hover {
                background: rgba(124,92,255,0.28);
                border-color: rgba(124,92,255,0.65);
                color: #fff;
            }
            .bc-btn-emerald {
                background: rgba(16,185,129,0.14);
                border-color: rgba(16,185,129,0.35);
                color: #6ee7b7;
            }
            .bc-btn-emerald:hover {
                background: rgba(16,185,129,0.26);
                border-color: rgba(16,185,129,0.65);
                color: #fff;
            }
            .bc-btn-blue {
                background: rgba(59,130,246,0.14);
                border-color: rgba(59,130,246,0.35);
                color: #93c5fd;
            }
            .bc-btn-blue:hover {
                background: rgba(59,130,246,0.26);
                border-color: rgba(59,130,246,0.65);
                color: #fff;
            }
            .bc-btn-amber {
                background: rgba(245,158,11,0.14);
                border-color: rgba(245,158,11,0.35);
                color: #fcd34d;
            }
            .bc-btn-amber:hover {
                background: rgba(245,158,11,0.26);
                border-color: rgba(245,158,11,0.65);
                color: #fff;
            }
            .bc-btn-danger {
                background: rgba(244,63,94,0.12);
                border-color: rgba(244,63,94,0.32);
                color: #fda4af;
            }
            .bc-btn-danger:hover {
                background: rgba(244,63,94,0.25);
                border-color: rgba(244,63,94,0.65);
                color: #ffe4e6;
            }
            .bc-btn-primary {
                background: linear-gradient(135deg, #7c5cff 0%, #9333ea 100%);
                border: none;
                color: #fff;
                font-weight: 600;
                box-shadow: 0 2px 8px rgba(124,92,255,0.35);
            }
            .bc-btn-primary:hover {
                box-shadow: 0 4px 14px rgba(124,92,255,0.55);
            }
            .bc-btn-sm {
                height: 22px;
                padding: 0 6px;
                font-size: 10px;
                border-radius: 4px;
            }
            .bc-btn-xs {
                height: 20px;
                padding: 0 5px;
                font-size: 10px;
                border-radius: 3px;
            }

            /* Unified Form Controls */
            .bc-input,
            #bc-header-prefix,
            #bc-header-before,
            #bc-header-start,
            #bc-header-after,
            #bc-header-names {
                background: #141525;
                border: 1px solid #2e3048;
                color: #e2e8f0;
                border-radius: 4px;
                height: 24px;
                padding: 0 6px;
                font-size: 11px;
                box-sizing: border-box;
                transition: all 0.15s ease;
            }
            .bc-input:focus,
            #bc-header-prefix:focus,
            #bc-header-before:focus,
            #bc-header-start:focus,
            #bc-header-after:focus,
            #bc-header-names:focus {
                border-color: #7c5cff;
                outline: none;
                box-shadow: 0 0 0 2px rgba(124,92,255,0.22);
                background: #181a30;
            }

            .bc-select,
            .bc-group-template,
            .bc-group-background,
            .bc-group-background-mode,
            .bc-group-music-mode,
            .bc-group-music,
            .bc-group-field,
            .bc-folder-assign-group,
            .bc-tpl-group,
            .bc-bind-sel {
                background: #141525;
                border: 1px solid #2e3048;
                color: #e2e8f0;
                border-radius: 4px;
                height: 24px;
                padding: 0 6px;
                font-size: 11px;
                box-sizing: border-box;
                transition: all 0.15s ease;
                cursor: pointer;
            }
            .bc-select:focus,
            .bc-group-template:focus,
            .bc-group-background:focus,
            .bc-group-background-mode:focus,
            .bc-group-music-mode:focus,
            .bc-group-music:focus,
            .bc-group-field:focus,
            .bc-folder-assign-group:focus,
            .bc-tpl-group:focus,
            .bc-bind-sel:focus {
                border-color: #7c5cff;
                outline: none;
                box-shadow: 0 0 0 2px rgba(124,92,255,0.22);
                background: #181a30;
            }
            .bc-select option,
            .bc-group-template option,
            .bc-group-background option,
            .bc-group-background-mode option,
            .bc-group-music-mode option,
            .bc-group-music option,
            .bc-group-field option,
            .bc-folder-assign-group option,
            .bc-tpl-group option,
            .bc-bind-sel option {
                background: #161726;
                color: #e2e8f0;
            }

            /* Folder row unassign buttons & action buttons */
            .bc-folder-unassign,
            .bc-folder-unassign-all,
            .bc-background-remove,
            .bc-music-remove {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 0 6px;
                height: 22px;
                font-size: 10px;
                cursor: pointer;
                background: rgba(244,63,94,0.12);
                border: 1px solid rgba(244,63,94,0.3);
                border-radius: 4px;
                color: #fda4af;
                flex-shrink: 0;
                transition: all 0.15s ease;
            }
            .bc-folder-unassign:hover,
            .bc-folder-unassign-all:hover,
            .bc-background-remove:hover,
            .bc-music-remove:hover {
                background: rgba(244,63,94,0.25);
                border-color: rgba(244,63,94,0.6);
                color: #fff;
            }

            .bc-background-refresh {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 0 6px;
                height: 22px;
                font-size: 10px;
                cursor: pointer;
                background: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.15);
                border-radius: 4px;
                color: #cbd5e1;
                flex-shrink: 0;
                transition: all 0.15s ease;
            }
            .bc-background-refresh:hover {
                background: rgba(255,255,255,0.12);
                border-color: rgba(255,255,255,0.25);
                color: #fff;
            }

            .bc-preview-group {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                width: 100%;
                height: 24px;
                padding: 0 8px;
                font-size: 10.5px;
                font-weight: 500;
                border-radius: 4px;
                cursor: pointer;
                background: rgba(124,92,255,0.14);
                border: 1px solid rgba(124,92,255,0.35);
                color: #c4b5fd;
                transition: all 0.15s ease;
            }
            .bc-library-box {
                background: rgba(255,255,255,0.02);
                border: 1px solid #272942;
                border-radius: 8px;
                padding: 9px 10px;
                margin-bottom: 10px;
                transition: border-color 0.15s ease;
            }
            .bc-library-box:hover {
                border-color: #3e4268;
            }
            .bc-toggle-arrow {
                display: inline-block;
                transition: transform 0.18s ease, color 0.15s ease;
                user-select: none;
            }
            [data-toggle-section]:hover .bc-toggle-arrow {
                transform: scale(1.22);
            }

            /* Group card layout */
            .bc-group-card {
                background: #141524;
                border: 1px solid #272942;
                border-radius: 7px;
                padding: 8px 10px;
                margin-bottom: 7px;
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            .bc-group-card:hover {
                border-color: #3f4268;
                box-shadow: 0 3px 10px rgba(0,0,0,0.25);
            }
            .bc-group-badge {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 2px 7px;
                background: rgba(124,92,255,0.18);
                border: 1px solid rgba(124,92,255,0.4);
                border-radius: 4px;
                color: #d8cfff;
                font-family: monospace;
                font-weight: 700;
                font-size: 11px;
                letter-spacing: 0.3px;
                flex-shrink: 0;
            }
            .bc-group-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px 8px;
                margin-top: 6px;
            }
            .bc-group-field-item {
                display: flex;
                flex-direction: column;
                gap: 2px;
                min-width: 0;
            }
            .bc-group-field-item label {
                font-size: 10px;
                color: #8b8ea8;
                font-weight: 500;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .bc-group-details {
                margin-top: 6px;
                padding-top: 4px;
                border-top: 1px dashed rgba(255,255,255,0.06);
            }
            .bc-group-summary {
                cursor: pointer;
                font-size: 10px;
                color: #8b8ea8;
                user-select: none;
                transition: color 0.15s;
            }
            .bc-group-summary:hover {
                color: #c4b5fd;
            }
        `;
    ov.innerHTML = `
        <div style="padding:10px 18px;border-bottom:1px solid #23243a;background:#11121e;flex-shrink:0;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:10px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:18px;">🧩</span>
                    <span style="font-size:15px;font-weight:700;color:#fff;letter-spacing:0.5px;">大量制作</span>
                    <span style="font-size:11px;color:#717496;background:rgba(255,255,255,0.04);padding:2px 8px;border-radius:4px;">工程模板 × 数据表格 = 批量任务</span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;">
                    <select id="bc-output-mode" class="bc-select" title="大量制作生成方式" style="height:28px;font-size:11px;">
                        <option value="group_apply" selected>📦 生成任务组并应用到外部分组显示（推荐）</option>
                        <option value="separate">📑 仅多标签页保存（保留在批量表格中）</option>
                        <option value="current">📄 全部平铺放入当前标签页</option>
                    </select>
                    <button id="bc-generate" class="bc-btn bc-btn-primary" style="height:28px;padding:0 18px;font-size:12px;">🚀 生成任务</button>
                    <button id="bc-close" class="bc-btn bc-btn-default" style="height:28px;padding:0 12px;font-size:11px;">关闭</button>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
                <span style="color:#717496;font-size:10px;font-weight:600;margin-right:2px;">数据:</span>
                <select id="bc-quick-columns" class="bc-select" title="一键建立常用表格列" style="height:24px;font-size:10.5px;color:#c4b5fd;border-color:rgba(124,92,255,0.45);">
                    <option value="" ${_bcCurrentQuickColumnPresetId() ? '' : 'selected'}>⚡ 快捷列模板</option>
                    <option value="default" ${_bcCurrentQuickColumnPresetId() === 'default' ? 'selected' : ''}>⚙️ 默认配置</option>
                    <option value="overlay" ${_bcCurrentQuickColumnPresetId() === 'overlay' ? 'selected' : ''}>🧱 覆层模板表</option>
                    <option value="voice_workflow" ${_bcCurrentQuickColumnPresetId() === 'voice_workflow' ? 'selected' : ''}>🎙️ 人声工作流表</option>
                </select>
                <input id="bc-quick-group-count" class="bc-input" type="number" min="1" max="500" value="1" title="一次建立多少组相同结构的列，最多500组" style="width:50px;height:24px;text-align:center;">
                <button id="bc-build-column-groups" class="bc-btn bc-btn-purple bc-btn-sm" title="按左侧选择的快捷列模板批量建立多组列">批量建组</button>
                <button id="bc-paste-tsv" class="bc-btn bc-btn-default bc-btn-sm">📋 粘贴TSV</button>
                <button id="bc-copy-table" class="bc-btn bc-btn-blue bc-btn-sm">📄 复制整表</button>
                <button id="bc-duplicate-rows" class="bc-btn bc-btn-purple bc-btn-sm" title="复制选中的行生成新版本副本">📋 复制副本行</button>
                <button id="bc-add-row" class="bc-btn bc-btn-default bc-btn-sm">+ 添加行</button>
                <button id="bc-clear" class="bc-btn bc-btn-danger bc-btn-sm">清空</button>
                <span style="color:rgba(255,255,255,0.15);margin:0 4px;">|</span>
                <span style="color:#717496;font-size:10px;font-weight:600;margin-right:2px;">模版:</span>
                <button id="bc-save-preset" class="bc-btn bc-btn-emerald bc-btn-sm">💾 保存</button>
                <button id="bc-load-preset" class="bc-btn bc-btn-amber bc-btn-sm">📂 加载</button>
                <button id="bc-new-empty-project" class="bc-btn bc-btn-default bc-btn-sm" title="清空当前大量制作工程；不会删除爆帖工程组合库或预设">＋ 新建空工程</button>
                <button id="bc-reload-source" class="bc-btn bc-btn-blue bc-btn-sm" title="重新读取已添加模板对应的最新模板工程，保留当前列绑定">🔄 刷新工程</button>
                <button id="bc-export-preset" class="bc-btn bc-btn-default bc-btn-sm">⬆ 导出</button>
                <button id="bc-import-preset" class="bc-btn bc-btn-default bc-btn-sm">⬇ 导入</button>
                <span id="bc-folder-drop" style="margin-left:auto;display:inline-flex;align-items:center;height:24px;padding:0 10px;border:1px dashed rgba(124,92,255,.55);border-radius:5px;background:rgba(124,92,255,0.06);color:#c4b5fd;font-size:10.5px;">📁 可拖入多个文件夹：每夹一标签、每文件一任务</span>
            </div>
        </div>
        <div style="padding:7px 18px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #23243a;background:#0d0e19;font-size:11.5px;color:#cbd5e1;">
            <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-weight:500;"><input id="bc-auto-headers" type="checkbox" checked style="accent-color:#7c5cff;cursor:pointer;"> 粘贴TSV时自动生成表头</label>
            <label style="display:inline-flex;align-items:center;gap:4px;color:#94a3b8;">前缀 <input id="bc-header-prefix" class="bc-input" value="reels" placeholder="例如 FB" style="width:68px;text-align:center;"></label>
            <label style="display:inline-flex;align-items:center;gap:4px;color:#94a3b8;">编号前连接符 <input id="bc-header-before" class="bc-input" value="-" placeholder="如 -" style="width:48px;text-align:center;"></label>
            <label style="display:inline-flex;align-items:center;gap:4px;color:#94a3b8;">起始编号 <input id="bc-header-start" class="bc-input" type="number" step="1" value="1" style="width:54px;text-align:center;"></label>
            <label style="display:inline-flex;align-items:center;gap:4px;color:#94a3b8;">编号后连接符 <input id="bc-header-after" class="bc-input" value="-" placeholder="如 -" style="width:48px;text-align:center;"></label>
            <label style="display:inline-flex;align-items:center;gap:4px;color:#94a3b8;">循环列名 <input id="bc-header-names" class="bc-input" value="原始文案、标题、内容" placeholder="用逗号或顿号分隔" style="width:200px;"></label>
            <span id="bc-header-preview" style="display:inline-flex;align-items:center;background:rgba(124,92,255,0.1);border:1px solid rgba(124,92,255,0.28);border-radius:4px;padding:2px 8px;font-size:10.5px;color:#c4b5fd;font-family:monospace;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
            <span style="color:#64748b;font-size:10.5px;margin-left:auto;">整表导入保留第一行文案；每组编号加1</span>
        </div>
        <div style="display:flex;flex:1;overflow:hidden;background:#0b0c15;">
            <div style="flex:1.8;min-width:0;overflow:auto;padding:10px;border-right:1px solid #23243a;outline:none;" id="bc-table-body" tabindex="0"></div>
            <div style="flex:1.2;min-width:360px;overflow:auto;padding:10px;" id="bc-bind-panel"></div>
        </div>`;
    document.body.appendChild(ov);
    function readHeaderRule() {
        const prefix = ov.querySelector('#bc-header-prefix').value.trim();
        const before = ov.querySelector('#bc-header-before').value;
        const after = ov.querySelector('#bc-header-after').value;
        const startText = ov.querySelector('#bc-header-start').value.trim();
        const start = Number(startText);
        const names = ov.querySelector('#bc-header-names').value.split(/[,，、\n]+/).map(name => name.trim()).filter(Boolean);
        if (!startText || !Number.isSafeInteger(start) || !names.length) return null;
        return { prefix, before, after, start, names };
    }
    function headerName(rule, index) {
        return `${rule.prefix}${rule.before || ''}${rule.start + Math.floor(index / rule.names.length)}${rule.after || ''}${rule.names[index % rule.names.length]}`;
    }
    function previewHeaders() {
        const rule = readHeaderRule();
        ov.querySelector('#bc-header-preview').textContent = rule
            ? Array.from({ length: Math.min(rule.names.length * 2, 8) }, (_, index) => headerName(rule, index)).join(' ｜ ') + ' …'
            : '请填写整数起始编号和循环列名';
    }
    ['#bc-header-prefix', '#bc-header-before', '#bc-header-start', '#bc-header-after', '#bc-header-names'].forEach(selector => {
        ov.querySelector(selector).addEventListener('input', () => {
            previewHeaders();
            _bcRenderBindings();
        });
    });
    previewHeaders();
    _bcRenderTable();
    _bcRenderBindings();
    const _bcCloseModal = () => {
        if (_bcAudioPreview) {
            _bcAudioPreview.pause();
            _bcAudioPreview = null;
            _bcCurrentPlayingMusic = null;
        }
        _bcSaveDraftNow();
        if (_bcModalAbort) {
            _bcModalAbort.abort();
            _bcModalAbort = null;
        }
        _bcIsSelecting = false;
        ov.remove();
    };

    // Block events from leaking to app-level handlers after modal controls handle them.
    ov.addEventListener('mousedown', e => e.stopPropagation());
    ov.addEventListener('pointerdown', e => e.stopPropagation());
    ov.addEventListener('dragover', e => {
        const hasFiles = Array.from(e.dataTransfer?.types || []).includes('Files');
        if (!hasFiles) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        const hint = ov.querySelector('#bc-folder-drop');
        if (hint) hint.style.background = 'rgba(124,92,255,.22)';
    });
    ov.addEventListener('dragleave', e => {
        if (e.relatedTarget && ov.contains(e.relatedTarget)) return;
        const hint = ov.querySelector('#bc-folder-drop');
        if (hint) hint.style.background = '';
    });
    ov.addEventListener('drop', async e => {
        const files = Array.from(e.dataTransfer?.files || []);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        const hint = ov.querySelector('#bc-folder-drop');
        if (hint) hint.style.background = '';
        const paths = files.map(f => typeof getFileNativePath === 'function'
            ? getFileNativePath(f) : (f.path || '')).filter(Boolean);
        if (e.target.closest?.('#bc-music-library')) {
            _bcImportMusicFiles(paths);
            return;
        }
        const dirs = paths.filter(p => typeof _isDirectoryPath === 'function' && _isDirectoryPath(p));
        if (!dirs.length) {
            if (typeof showToast === 'function') showToast('这里请拖入一个或多个文件夹', 'warning');
            return;
        }
        if (e.target.closest?.('#bc-background-library')) {
            await _bcImportBackgroundFolders(dirs);
            return;
        }
        if (typeof window.reelsImportFoldersAsTaskTabs !== 'function') {
            if (typeof showToast === 'function') showToast('文件夹任务导入器尚未加载，请重启应用', 'error');
            return;
        }
        const result = await window.reelsImportFoldersAsTaskTabs(dirs);
        if (result?.tabCount > 0) _bcCloseModal();
    });

    // ── Click events ──
    ov.addEventListener('click', e => {
        const t = e.target;
        if (t.id === 'bc-close') { _bcCloseModal(); return; }
        if (t.id === 'bc-preview-all') { _bcPreviewAll(); return; }
        if (t.id === 'bc-toggle-all-sections') {
            const nextState = !['templates', 'backgrounds', 'music', 'groups'].every(k => _bulkState.collapsedSections?.[k]);
            _bulkState.collapsedSections = {
                templates: nextState,
                backgrounds: nextState,
                music: nextState,
                groups: nextState,
            };
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        // 这些按钮位于可折叠标题内，必须在标题的折叠逻辑之前处理。
        if (t.id === 'bc-add-viral-groups') { e.stopPropagation(); _bcAddViralGroupsFromLibrary(); return; }
        if (t.id === 'bc-export-viral-groups') { e.stopPropagation(); _bcExportViralGroups(); return; }
        if (t.id === 'bc-import-viral-groups') { e.stopPropagation(); _bcImportViralGroups(); return; }
        const toggleHeader = t.closest?.('[data-toggle-section]');
        if (toggleHeader) {
            if (t.closest('button, input, select, label, .bc-btn, a')) return;
            const sec = toggleHeader.dataset.toggleSection;
            if (!_bulkState.collapsedSections) _bulkState.collapsedSections = {};
            _bulkState.collapsedSections[sec] = !_bulkState.collapsedSections[sec];
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-random-backgrounds') { _bcRandomizeBackgroundGroups(); return; }
        if (t.id === 'bc-random-music') { _bcRandomizeMusicGroups(); return; }
        if (t.classList.contains('bc-preview-group')) { _bcPreviewGroup(t.dataset.group); return; }
        if (t.id === 'bc-add-background-folders') {
            if (!window.electronAPI?.showOpenDialog) { alert('请在桌面版中选择文件夹'); return; }
            window.electronAPI.showOpenDialog({ title: '添加背景素材（每个文件夹为一组背景）', properties: ['openDirectory', 'multiSelections'] })
                .then(result => _bcImportBackgroundFolders(result?.filePaths || [])).catch(error => alert(error.message));
            return;
        }
        if (t.id === 'bc-add-music') {
            if (!window.electronAPI?.showOpenDialog) { alert('请在桌面版中选择配乐文件'); return; }
            window.electronAPI.showOpenDialog({
                title: '添加配乐（可多选）', properties: ['openFile', 'multiSelections'],
                filters: [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'] }],
            }).then(result => _bcImportMusicFiles(result?.filePaths || [])).catch(error => alert(error.message));
            return;
        }
        if (t.id === 'bc-clear-tpl-assignments') { _bcClearTemplateAssignments(); return; }
        if (t.id === 'bc-clear-templates') { _bcClearTemplateLibrary(); return; }
        if (t.id === 'bc-seq-backgrounds') { _bcAssignBackgroundGroups(false); return; }
        if (t.id === 'bc-clear-bg-assignments') { _bcClearBackgroundAssignments(); return; }
        if (t.id === 'bc-seq-music') { _bcAssignMusicGroups(false); return; }
        if (t.id === 'bc-clear-music-assignments') { _bcClearMusicAssignments(); return; }

        const playBtn = t.closest?.('.bc-music-play');
        if (playBtn) {
            const audioPath = playBtn.dataset.path;
            if (audioPath) _bcToggleMusicPreview(audioPath);
            return;
        }

        const unassignTplBtn = t.closest?.('.bc-template-unassign');
        if (unassignTplBtn) {
            const groupKey = unassignTplBtn.dataset.group;
            if (groupKey) _bcUnassignTemplateFromGroup(groupKey);
            return;
        }
        const unassignAllTplBtn = t.closest?.('.bc-template-unassign-all');
        if (unassignAllTplBtn) {
            const ti = Number(unassignAllTplBtn.dataset.template);
            if (!isNaN(ti)) _bcUnassignAllGroupsForTemplate(ti);
            return;
        }

        const unassignMusicBtn = t.closest?.('.bc-music-unassign');
        if (unassignMusicBtn) {
            const groupKey = unassignMusicBtn.dataset.group;
            if (groupKey) _bcUnassignMusicFromGroup(groupKey);
            return;
        }
        const unassignAllMusicBtn = t.closest?.('.bc-music-unassign-all');
        if (unassignAllMusicBtn) {
            const musicPath = unassignAllMusicBtn.dataset.music;
            if (musicPath) _bcUnassignAllMusicForPath(musicPath);
            return;
        }

        if (t.id === 'bc-clear-backgrounds') {
            if (!_bulkState.backgroundFolders?.length) {
                if (typeof showToast === 'function') showToast('背景库已经是空的', 'info');
                else alert('背景库已经是空的');
                return;
            }
            if (confirm('确定清空背景库中的所有素材？')) {
                _bcClearBackgroundFolders();
            }
            return;
        }
        if (t.id === 'bc-clear-music') {
            if (!_bulkState.musicFiles?.length) {
                if (typeof showToast === 'function') showToast('配乐库已经是空的', 'info');
                else alert('配乐库已经是空的');
                return;
            }
            if (confirm('确定清空所有配乐文件？')) {
                _bcClearMusicFiles();
            }
            return;
        }
        if (t.classList.contains('bc-music-remove')) {
            const [music] = _bulkState.musicFiles.splice(Number(t.dataset.mi), 1);
            (_bulkState.groupAssignments || []).forEach(entry => {
                if (entry.musicPath === music?.path) entry.musicPath = '';
            });
            _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
        if (t.classList.contains('bc-background-refresh')) {
            const folder = _bulkState.backgroundFolders[Number(t.dataset.fi)];
            if (folder) _bcImportBackgroundFolders([folder.path]);
            return;
        }
        if (t.classList.contains('bc-background-open-folder')) {
            const folder = _bulkState.backgroundFolders[Number(t.dataset.fi)];
            if (!folder?.path) return;
            const openFolder = window.bridge?.openPath;
            if (typeof openFolder !== 'function') { alert('当前环境不支持打开文件夹'); return; }
            openFolder(folder.path).then(result => {
                if (result?.success === false) alert(`无法打开背景文件夹：${result.error || '路径不存在'}`);
            }).catch(error => alert(`无法打开背景文件夹：${error.message}`));
            return;
        }
        const openGroupBackgroundFolder = t.closest?.('.bc-group-open-background-folder');
        if (openGroupBackgroundFolder) {
            const groupKey = openGroupBackgroundFolder.dataset.group;
            const entry = (_bulkState.groupAssignments || []).find(item => item.key === groupKey);
            const folderPath = entry?.backgroundFolder || '';
            if (!folderPath) {
                if (typeof showToast === 'function') showToast('请先为该任务组选择背景文件夹', 'info');
                else alert('请先选择背景文件夹');
                return;
            }
            const openFolder = window.bridge?.openPath;
            if (typeof openFolder !== 'function') {
                alert('当前环境不支持打开文件夹');
                return;
            }
            openFolder(folderPath).then(result => {
                if (result?.success === false) alert(`无法打开背景文件夹：${result.error || '路径不存在'}`);
            }).catch(error => alert(`无法打开背景文件夹：${error.message}`));
            return;
        }
        const thumbBtn = t.closest?.('.bc-bg-folder-thumb');
        if (thumbBtn) {
            const folder = _bulkState.backgroundFolders[Number(thumbBtn.dataset.fi)];
            if (folder) _bcVisualPicker('folder', folder.path, null);
            return;
        }
        const unassignBtn = t.closest?.('.bc-folder-unassign');
        if (unassignBtn) {
            const groupKey = unassignBtn.dataset.group;
            if (groupKey) _bcUnassignFolderFromGroup(groupKey);
            return;
        }
        const unassignAllBtn = t.closest?.('.bc-folder-unassign-all');
        if (unassignAllBtn) {
            const folderPath = unassignAllBtn.dataset.folder;
            if (folderPath) _bcUnassignAllFoldersForPath(folderPath);
            return;
        }
        if (t.classList.contains('bc-background-remove')) {
            const [folder] = _bulkState.backgroundFolders.splice(Number(t.dataset.fi), 1);
            (_bulkState.groupAssignments || []).forEach(entry => {
                if (entry.backgroundFolder === folder?.path) entry.backgroundFolder = '';
            });
            _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
        if (t.id === 'bc-add-row') { _bulkState.rows.push(new Array(_bulkState.columns.length).fill('')); _bcRenderTable(); return; }
        if (t.id === 'bc-duplicate-rows') {
            const bounds = _bcSelectionBounds();
            let indices = [];
            if (bounds) {
                for (let r = bounds.minR; r <= bounds.maxR; r++) {
                    if (r >= 0 && r < _bulkState.rows.length) indices.push(r);
                }
            }
            if (!indices.length) {
                if (_bulkState.rows.length === 1) {
                    indices = [0];
                } else if (_bulkState.rows.length > 1) {
                    alert('请先在表格中点击选中要复制的行或单元格');
                    return;
                } else {
                    return;
                }
            }
            _bcPromptRowDuplication(indices);
            return;
        }
        if (t.id === 'bc-copy-table') { _bcCopyWholeTable(); return; }
        if (t.id === 'bc-build-column-groups') {
            const presetId = ov.querySelector('#bc-quick-columns')?.value || 'default';
            const groupCount = ov.querySelector('#bc-quick-group-count')?.value || 1;
            _bcApplyQuickColumnPreset(presetId, groupCount);
            return;
        }
        if (t.id === 'bc-add-col') {
            _bcPrompt('输入列名（多列用逗号分隔）', 'FB标题, FB正文, FB尾标, TK标题, TK正文').then(input => {
                if (!input || !input.trim()) return;
                const names = input.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean);
                names.forEach(name => {
                    _bulkState.columns.push(_bcColumnFromName(name));
                    _bulkState.rows.forEach(r => r.push(''));
                });
                _bcRenderTable(); _bcRenderBindings();
                _bcScheduleDraftSave();
            });
            return;
        }
        if (t.id === 'bc-clear') { if(confirm('清空所有数据？')){ _bulkState.rows=[]; for(let i=0;i<20;i++) _bulkState.rows.push(new Array(_bulkState.columns.length).fill('')); _bcRenderTable(); _bcScheduleDraftSave(); } return; }
        if (t.id === 'bc-add-tpl') { _bcPickTemplates(); return; }
        if (t.classList.contains('bc-select-background-files')) { _bcOpenSelectedBackgroundPicker(t.dataset.group); return; }
        if (t.id === 'bc-match-groups') { _bcAssignNumberedGroups(); return; }
        if (t.id === 'bc-random-groups') { _bcAssignNumberedGroups(true); return; }
        if (t.id === 'bc-manual-bindings') {
            if (_bulkState.groupAssignments) {
                _bulkState.groupAssignments = null;
            } else {
                _bcAssignNumberedGroups();
            }
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-clear-bindings') { if (confirm('清空所有模板的列绑定？')) _bcClearAllTemplateBindings(); return; }
        if (t.id === 'bc-rebind-tpl') { if (confirm('按当前列名重新自动绑定所有模板字段？')) _bcAutoRebindAllTemplates(); return; }
        if (t.id === 'bc-save-preset') { _bcSavePreset(); return; }
        if (t.id === 'bc-load-preset') { _bcLoadPreset(); return; }
        if (t.id === 'bc-new-empty-project') { _bcCreateEmptyProject(); return; }
        if (t.classList.contains('bc-viral-group-save')) {
            const button = t;
            if (button.disabled) return;
            const originalText = button.textContent;
            button.disabled = true;
            button.textContent = '⏳ 保存中…';
            _bcSaveViralGroupPreset(button.dataset.group).then(name => {
                if (!name) { button.textContent = originalText; button.disabled = false; return; }
                button.textContent = '✓ 已保存';
                button.title = `已保存为爆帖工程组合「${name}」`;
                button.style.background = 'rgba(34,197,94,.18)';
                button.style.borderColor = 'rgba(74,222,128,.65)';
                button.style.color = '#bbf7d0';
                setTimeout(() => {
                    if (!button.isConnected) return;
                    button.textContent = originalText;
                    button.title = '把当前这个任务组完整保存为独立的爆帖工程组合，不影响原有预设';
                    button.style.background = '';
                    button.style.borderColor = '';
                    button.style.color = '';
                    button.disabled = false;
                }, 3000);
            }).catch(error => {
                button.textContent = originalText;
                button.disabled = false;
                alert(`保存爆帖工程组合失败：${error.message}`);
            });
            return;
        }
        if (t.id === 'bc-reload-source') { _bcReloadLoadedTemplates(); return; }
        if (t.id === 'bc-export-preset') { _bcExportPreset(); return; }
        if (t.id === 'bc-import-preset') { _bcImportPreset(); return; }
        if (t.id === 'bc-generate') {
            const count = _bcGenerateTasks();
            if (count > 0) {
                // 大量制作是一次结构性操作。必须先保存“生成后”快照，
                // 否则用户第一次撤销会直接回到生成前，整批任务组都会消失。
                window.reelsSaveHistory?.();
                alert(`✅ 已生成 ${count} 个任务`);
                _bcCloseModal();
                if(typeof _renderBatchTable==='function') _renderBatchTable();
                if(typeof _renderTaskList==='function') _renderTaskList();
            }
            return;
        }
        if (t.classList.contains('bc-tpl-edit-overlays')) {
            const ti = parseInt(t.dataset.ti);
            if (_bulkState.templates[ti]) _bcEditTemplateOverlays(ti);
            return;
        }
        if (t.classList.contains('bc-tpl-save-preset')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (tpl) {
                _bcPrompt('请输入覆层预设名称', `${tpl.label} 覆层预设`).then(name => {
                    if (!name || !name.trim()) return;
                    const customPresets = JSON.parse(localStorage.getItem('reels_custom_presets') || '[]');
                    const p = {
                        id: 'custom_' + Date.now(),
                        name: name.trim(),
                        desc: `由批量模板「${tpl.label}」导出`,
                        overlays: JSON.parse(JSON.stringify(tpl.task?.overlays || tpl.overlays || []))
                    };
                    customPresets.push(p);
                    localStorage.setItem('reels_custom_presets', JSON.stringify(customPresets));
                    alert(`✅ 已保存为覆层预设「${p.name}」`);
                });
            }
            return;
        }
        if (t.classList.contains('bc-tpl-rename')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (tpl) {
                _bcPrompt('请输入新的模板名称', tpl.label || `模板 ${ti + 1}`).then(name => {
                    if (!name || !name.trim()) return;
                    tpl.label = name.trim();
                    if (tpl.task) tpl.task.name = tpl.label;
                    _bcRenderBindings();
                    _bcScheduleDraftSave();
                });
            }
            return;
        }
        if (t.classList.contains('bc-col-del')) { const ci=parseInt(t.dataset.ci); if(_bulkState.columns.length<=1)return; _bulkState.columns.splice(ci,1); _bulkState.rows.forEach(r=>r.splice(ci,1)); _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave(); return; }
        if (t.classList.contains('bc-row-copy')) { const ri = parseInt(t.dataset.ri); if (!isNaN(ri) && _bulkState.rows[ri]) { _bcPromptRowDuplication([ri]); } return; }
        if (t.classList.contains('bc-row-del')) { _bulkState.rows.splice(parseInt(t.dataset.ri),1); _bcRenderTable(); _bcScheduleDraftSave(); return; }
        if (t.classList.contains('bc-tpl-bgcycle')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (!tpl) return;
            if (tpl.bgCycle && tpl.bgCycle.length > 0) {
                // 显示背景循环详情
                _bcShowBgCycleDetail(tpl, ti);
            } else {
                // 选择文件
                _bcPickBgCycleFiles(tpl, ti);
            }
            return;
        }
        if (t.classList.contains('bc-tpl-folder-pick')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (tpl) _bcPickTemplateMaterialFolder(tpl, ti);
            return;
        }
        if (t.classList.contains('bc-tpl-folder-refresh')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (tpl) _bcRefreshTemplateMaterialFolder(tpl, ti);
            return;
        }
        if (t.classList.contains('bc-tpl-del')) {
            const ti = Number(t.dataset.ti);
            _bulkState.templates.splice(ti, 1);
            (_bulkState.groupAssignments || []).forEach(entry => {
                if (entry.templateIndex === ti) { entry.templateIndex = -1; entry.bindings = {}; }
                else if (entry.templateIndex > ti) entry.templateIndex--;
            });
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-col-insert')) {
            const ci = parseInt(t.dataset.ci);
            _bulkState.columns.splice(ci + 1, 0, { name: `列${_bulkState.columns.length+1}`, type: 'text' });
            _bulkState.rows.forEach(r => r.splice(ci + 1, 0, ''));
            // Update bindings: shift column indices >= ci+1
            _bulkState.templates.forEach(tpl => {
                for (const [k, v] of Object.entries(tpl.bindings)) { if (v > ci) tpl.bindings[k] = v + 1; }
            });
            _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
        if (t.classList.contains('bc-col-left')) {
            const ci = parseInt(t.dataset.ci); if (ci <= 0) return;
            [_bulkState.columns[ci-1], _bulkState.columns[ci]] = [_bulkState.columns[ci], _bulkState.columns[ci-1]];
            _bulkState.rows.forEach(r => { [r[ci-1], r[ci]] = [r[ci], r[ci-1]]; });
            // Swap binding references
            _bulkState.templates.forEach(tpl => {
                for (const [k, v] of Object.entries(tpl.bindings)) {
                    if (v === ci) tpl.bindings[k] = ci - 1;
                    else if (v === ci - 1) tpl.bindings[k] = ci;
                }
            });
            _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
        if (t.classList.contains('bc-col-right')) {
            const ci = parseInt(t.dataset.ci); if (ci >= _bulkState.columns.length - 1) return;
            [_bulkState.columns[ci], _bulkState.columns[ci+1]] = [_bulkState.columns[ci+1], _bulkState.columns[ci]];
            _bulkState.rows.forEach(r => { [r[ci], r[ci+1]] = [r[ci+1], r[ci]]; });
            _bulkState.templates.forEach(tpl => {
                for (const [k, v] of Object.entries(tpl.bindings)) {
                    if (v === ci) tpl.bindings[k] = ci + 1;
                    else if (v === ci + 1) tpl.bindings[k] = ci;
                }
            });
            _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave(); return;
        }
    });
    ov.querySelector('#bc-quick-columns')?.addEventListener('change', e => {
        const presetId = e.target.value;
        if (presetId && !_bcApplyQuickColumnPreset(presetId)) {
            e.target.value = _bcCurrentQuickColumnPresetId();
        }
    });

    // ── Change events ──
    ov.addEventListener('change', e => {
        const t = e.target;
        if (t.classList.contains('bc-folder-assign-group')) {
            const folderPath = t.dataset.folder;
            const oldGroupKey = t.dataset.currentGroup || '';
            const newGroupKey = t.value || '';
            _bcChangeFolderGroupAssignment(folderPath, oldGroupKey, newGroupKey);
            return;
        }
        if (t.classList.contains('bc-group-background') || t.classList.contains('bc-group-background-mode') || t.classList.contains('bc-group-music') || t.classList.contains('bc-group-music-mode')) {
            if (!_bulkState.groupAssignments) _bulkState.groupAssignments = [];
            let entry = _bulkState.groupAssignments.find(item => item.key === t.dataset.group);
            if (!entry) { entry = { key: t.dataset.group, templateIndex: -1, bindings: {} }; _bulkState.groupAssignments.push(entry); }
            if (t.classList.contains('bc-group-background')) { entry.backgroundFolder = t.value; entry.selectedBackgroundFiles = []; }
            else if (t.classList.contains('bc-group-background-mode')) entry.backgroundMode = t.value;
            else if (t.classList.contains('bc-group-music-mode')) entry.musicMode = t.value;
            else entry.musicPath = t.value;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-allow-reuse') {
            if (!t.checked) {
                const used = new Set();
                const repeated = (_bulkState.groupAssignments || []).some(entry => {
                    if (entry.templateIndex < 0) return false;
                    if (used.has(entry.templateIndex)) return true;
                    used.add(entry.templateIndex);
                    return false;
                });
                if (repeated) {
                    alert('当前有模板被重复选用，请先调整重复的匹配或设为未分配，再关闭重复使用。');
                    t.checked = true;
                    return;
                }
            }
            _bulkState.allowTemplateReuse = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-allow-bg-reuse') {
            _bulkState.allowBackgroundReuse = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-template-assign-group')) {
            const ti = Number(t.dataset.template);
            const oldGroupKey = t.dataset.currentGroup || '';
            const newGroupKey = t.value || '';
            _bcChangeTemplateGroupAssignment(ti, oldGroupKey, newGroupKey);
            return;
        }
        if (t.classList.contains('bc-music-assign-group')) {
            const musicPath = t.dataset.music;
            const oldGroupKey = t.dataset.currentGroup || '';
            const newGroupKey = t.value || '';
            _bcChangeMusicGroupAssignment(musicPath, oldGroupKey, newGroupKey);
            return;
        }
        if (t.id === 'bc-filter-unassigned-tpls') {
            _bulkState.filterUnassignedTemplates = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-filter-unassigned-bgs') {
            _bulkState.filterUnassignedBackgrounds = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-allow-music-reuse') {
            _bulkState.allowMusicReuse = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-filter-unassigned-music') {
            _bulkState.filterUnassignedMusic = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.id === 'bc-filter-unassigned-groups') {
            _bulkState.filterUnassignedGroups = t.checked;
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-group-template')) {
            _bcSetGroupTemplate(t.dataset.group, Number(t.value));
            return;
        }
        if (t.classList.contains('bc-group-field')) {
            const entry = _bulkState.groupAssignments?.find(item => item.key === t.dataset.group);
            if (entry) {
                if (!entry.bindings) entry.bindings = {};
                entry.bindings[t.dataset.field] = _bulkState.columns[Number(t.value)]?.name ?? null;
                _bcScheduleDraftSave();
            }
            return;
        }
        if (t.classList.contains('bc-tpl-folder-mode')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (!tpl) return;
            tpl.materialFolder = {
                path: tpl.materialFolder?.path || '',
                files: Array.isArray(tpl.materialFolder?.files) ? tpl.materialFolder.files : [],
                refreshedAt: tpl.materialFolder?.refreshedAt || 0,
                columnIndex: Number.isInteger(tpl.materialFolder?.columnIndex) ? tpl.materialFolder.columnIndex : null,
                mode: t.value === 'concat' ? 'concat' : 'rows',
            };
            if (tpl.materialFolder.mode === 'concat' && Number.isInteger(tpl.materialFolder.columnIndex)) {
                const oldFiles = new Set(tpl.materialFolder.files || []);
                const ci = tpl.materialFolder.columnIndex;
                _bulkState.rows.forEach(row => {
                    if (oldFiles.has(row?.[ci])) row[ci] = '';
                });
                _bcRenderTable();
            }
            if (tpl.materialFolder.path) _bcRefreshTemplateMaterialFolder(tpl, ti);
            else _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-col-name')) { _bulkState.columns[parseInt(t.dataset.ci)].name=t.value; _bcRenderBindings(); _bcScheduleDraftSave(); return; }
        if (t.classList.contains('bc-col-kind')) {
            const ci = parseInt(t.dataset.ci);
            _bcSetColumnKind(_bulkState.columns[ci], t.value);
            _bcClearInvalidBindingsForColumn(ci);
            _bcRenderTable();
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-tpl-group')) {
            const tpl = _bulkState.templates[Number(t.dataset.ti)];
            const group = _bcNumberedColumnGroups().find(group => group.key === t.value);
            if (tpl && group) _bcBindNumberedGroup(tpl, group);
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-bind-sel')) {
            const ti = parseInt(t.dataset.ti);
            const fk = t.dataset.fk;
            const newVal = parseInt(t.value);
            const colName = newVal >= 0 ? (_bulkState.columns[newVal]?.name || '') : '不绑定';
            console.log(`[BulkCreate] ✅ 绑定变更: 模板[${ti}]「${_bulkState.templates[ti]?.label}」字段[${fk}] → col[${newVal}]「${colName}」`);
            _bulkState.templates[ti].bindings[fk] = newVal;
            // 视觉反馈：闪烁
            t.style.border = '1px solid #4ade80';
            t.style.background = 'rgba(74,222,128,0.15)';
            setTimeout(() => { t.style.border = ''; t.style.background = ''; }, 600);
            _bcScheduleDraftSave();
            return;
        }
    });

    // ── Video thumbnail hover preview ──
    ov.addEventListener('mouseover', e => {
        const thumb = e.target.closest?.('.bc-bg-folder-thumb');
        if (thumb) {
            const vid = thumb.querySelector('video');
            if (vid && vid.paused) vid.play().catch(() => {});
        }
    });
    ov.addEventListener('mouseout', e => {
        const thumb = e.target.closest?.('.bc-bg-folder-thumb');
        if (thumb && (!e.relatedTarget || !thumb.contains(e.relatedTarget))) {
            const vid = thumb.querySelector('video');
            if (vid) {
                vid.pause();
                try { vid.currentTime = 0.1; } catch (_) {}
            }
        }
    });

    // ── Input events (live cell editing) ──
    const tableBody = ov.querySelector('#bc-table-body');
    tableBody.addEventListener('input', e => {
        const t = e.target;
        if (t.classList.contains('bc-cell')) {
            const ri=parseInt(t.dataset.ri), ci=parseInt(t.dataset.ci);
            if (_bulkState.rows[ri]) _bulkState.rows[ri][ci] = t.value;
            _bcScheduleDraftSave();
        }
    });

    // ── Text Processing Utilities ──
    function _bcCleanBreaks(text) {
        return (text || '').replace(/\r?\n+/g, ' ').replace(/ {2,}/g, ' ').trim();
    }
    function _bcCleanBlankLines(text) {
        const lines = text.split(/\r?\n/);
        const newLines = [];
        let blank = false;
        for (const line of lines) {
            if (line.trim() === '') {
                if (!blank) { newLines.push(''); blank = true; }
            } else { newLines.push(line); blank = false; }
        }
        return newLines.join('\n');
    }
    function _bcAutoWrapText(text, width = 18) {
        const paragraphs = (text || '').trim().split(/\n\s*\n/);
        const wrappedResult = [];
        for (const para of paragraphs) {
            const words = para.trim().split(/\s+/);
            if (!words || (words.length === 1 && words[0] === '')) continue;
            let line = '';
            for (const word of words) {
                if (!line) { line = word; }
                else if (line.length + 1 + word.length <= width) { line += ' ' + word; }
                else { wrappedResult.push(line); line = word; }
                const lastChar = line.slice(-1);
                if (line && [':', '.', '?', '!', '：', '。', '？', '！'].includes(lastChar)) {
                    wrappedResult.push(line);
                    line = '';
                }
            }
            if (line) wrappedResult.push(line);
            wrappedResult.push('');
        }
        while (wrappedResult.length > 0 && wrappedResult[wrappedResult.length - 1] === '') wrappedResult.pop();
        return _bcCleanBlankLines(wrappedResult.join('\n'));
    }
    function _bcSplitTwoParts(text) {
        text = (text || '').toString().trim();
        if (!text) return { title: '', content: '' };
        let lines = text.split(/\r?\n/);
        while (lines.length > 0 && lines[0].trim() === '') lines.shift();
        if (lines.length > 1) {
            const contentLines = lines.slice(1);
            while (contentLines.length > 0 && contentLines[0].trim() === '') contentLines.shift();
            return { title: lines[0].trim(), content: contentLines.join('\n').trim() };
        } else {
            const sentences = text.match(/[^。！？?!]+[。！？?!]?/g);
            if (sentences && sentences.length > 1) {
                return { title: sentences[0].trim(), content: sentences.slice(1).join('').trim() };
            } else {
                return { title: text.trim(), content: '' };
            }
        }
    }
    function _bcSplitThreeParts(text) {
        text = (text || '').toString().trim();
        if (!text) return { title: '', content: '', ending: '' };
        let lines = text.split(/\r?\n/);
        while (lines.length > 0 && lines[0].trim() === '') lines.shift();
        if (lines.length > 1) {
            const contentLines = lines.slice(1, -1);
            while (contentLines.length > 0 && contentLines[0].trim() === '') contentLines.shift();
            return { title: lines[0].trim(), content: contentLines.join('\n').trim(), ending: lines[lines.length - 1].trim() };
        } else {
            const sentences = text.match(/[^。！？?!]+[。！？?!]?/g);
            if (sentences && sentences.length > 1) {
                return { title: sentences[0].trim(), content: sentences.slice(1, -1).join('').trim(), ending: sentences[sentences.length - 1].trim() };
            } else {
                return { title: text.trim(), content: '', ending: '' };
            }
        }
    }

    // ── Context menu for text processing ──
    tableBody.addEventListener('contextmenu', e => {
        const t = e.target;
        const cellEl = t.closest('.bc-cell, .bc-grid-td');
        let isCell = !!cellEl;
        let isColHeader = t.closest('th') && !t.classList.contains('bc-col-insert') && !t.classList.contains('bc-col-del') && !t.classList.contains('bc-col-kind');
        
        if (!isCell && !isColHeader) return;
        e.preventDefault();
        
        document.querySelectorAll('.bc-context-menu').forEach(el => el.remove());
        const menu = document.createElement('div');
        menu.className = 'bc-context-menu';
        menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px;background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:4px;box-shadow:0 4px 12px rgba(0,0,0,0.5);z-index:500000;display:flex;flex-direction:column;min-width:160px;`;
        
        let targetCi = -1, targetRi = -1;
        if (isCell) {
            targetCi = parseInt(cellEl.dataset.ci);
            targetRi = parseInt(cellEl.dataset.ri);
        } else {
            const input = t.closest('th').querySelector('.bc-col-name');
            if (input) targetCi = parseInt(input.dataset.ci);
        }
        if (targetCi < 0) return;

        const createItem = (label, icon, onClick) => {
            const btn = document.createElement('button');
            btn.style.cssText = 'padding:8px 12px;background:transparent;border:none;color:#ddd;font-size:12px;text-align:left;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:8px;';
            btn.innerHTML = `<span>${icon}</span> <span>${label} ${isCell ? '(单格)' : '(整列)'}</span>`;
            btn.onmouseenter = () => btn.style.background = 'rgba(255,255,255,0.1)';
            btn.onmouseleave = () => btn.style.background = 'transparent';
            btn.onclick = () => { 
                onClick(); 
                menu.remove(); 
                _bcRenderTable(); 
                if (isCell) _bcUpdateSelectionUI(); // Keep selection after process
                _bcScheduleDraftSave();
            };
            return btn;
        };

        const processItems = (processor, needsExtraCols) => {
            let selectedRows = [targetRi];
            let processTargetCi = targetCi;

            if (isCell && _bcSelection) {
                const minR = Math.min(_bcSelection.r1, _bcSelection.r2);
                const maxR = Math.max(_bcSelection.r1, _bcSelection.r2);
                const minC = Math.min(_bcSelection.c1, _bcSelection.c2);
                const maxC = Math.max(_bcSelection.c1, _bcSelection.c2);
                // Check if the clicked cell is within the selection grid
                if (targetRi >= minR && targetRi <= maxR && targetCi >= minC && targetCi <= maxC) {
                    selectedRows = [];
                    for (let r = minR; r <= maxR; r++) selectedRows.push(r);
                    processTargetCi = minC; // Default to leftmost column of selection for processing outputs
                }
            } else if (!isCell) {
                selectedRows = _bulkState.rows.map((_, i) => i);
            }

            if (needsExtraCols > 0) {
                // Safely insert new columns immediately to the right instead of overwriting
                for (let i = 0; i < needsExtraCols; i++) {
                    _bulkState.columns.splice(processTargetCi + 1 + i, 0, { name: '拆分列', type: 'text' });
                    _bulkState.rows.forEach(r => r.splice(processTargetCi + 1 + i, 0, ''));
                }
                // Shift bindings for any columns that moved
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) {
                        if (v > processTargetCi) tpl.bindings[k] = v + needsExtraCols;
                    }
                });
            }
            selectedRows.forEach(ri => {
                if (!_bulkState.rows[ri]) return;
                const val = _bulkState.rows[ri][processTargetCi] || '';
                if (!val.trim()) return;
                const res = processor(val);
                if (typeof res === 'string') {
                    _bulkState.rows[ri][processTargetCi] = res;
                } else if (res.title !== undefined) {
                    _bulkState.rows[ri][processTargetCi] = res.title;
                    if (res.content !== undefined) _bulkState.rows[ri][processTargetCi + 1] = res.content;
                    if (res.ending !== undefined) _bulkState.rows[ri][processTargetCi + 2] = res.ending;
                }
            });
        };

        if (isColHeader) {
            menu.appendChild(createItem('向左插入一列', '⬅️', () => {
                _bulkState.columns.splice(targetCi, 0, { name: `新列`, type: 'text' });
                _bulkState.rows.forEach(r => r.splice(targetCi, 0, ''));
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) { if (v >= targetCi) tpl.bindings[k] = v + 1; }
                });
            }));
            menu.appendChild(createItem('向右插入一列', '➡️', () => {
                _bulkState.columns.splice(targetCi + 1, 0, { name: `新列`, type: 'text' });
                _bulkState.rows.forEach(r => r.splice(targetCi + 1, 0, ''));
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) { if (v > targetCi) tpl.bindings[k] = v + 1; }
                });
            }));
            menu.appendChild(createItem('清空整列内容', '🧽', () => {
                _bulkState.rows.forEach(r => { if (r) r[targetCi] = ''; });
            }));
            menu.appendChild(createItem('删除该列', '🗑️', () => {
                if (_bulkState.columns.length <= 1) return;
                _bulkState.columns.splice(targetCi, 1);
                _bulkState.rows.forEach(r => r.splice(targetCi, 1));
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) {
                        if (v === targetCi) delete tpl.bindings[k];
                        else if (v > targetCi) tpl.bindings[k] = v - 1;
                    }
                });
                _bcRenderBindings();
            }));
            const div2 = document.createElement('div'); div2.style.cssText = 'height:1px;background:#333;margin:4px 0;';
            menu.appendChild(div2);
            menu.appendChild(createItem('向左移动列', '⏪', () => {
                if (targetCi <= 0) return;
                const ci = targetCi;
                [_bulkState.columns[ci-1], _bulkState.columns[ci]] = [_bulkState.columns[ci], _bulkState.columns[ci-1]];
                _bulkState.rows.forEach(r => { [r[ci-1], r[ci]] = [r[ci], r[ci-1]]; });
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) {
                        if (v === ci) tpl.bindings[k] = ci - 1;
                        else if (v === ci - 1) tpl.bindings[k] = ci;
                    }
                });
                _bcRenderBindings();
            }));
            menu.appendChild(createItem('向右移动列', '⏩', () => {
                if (targetCi >= _bulkState.columns.length - 1) return;
                const ci = targetCi;
                [_bulkState.columns[ci], _bulkState.columns[ci+1]] = [_bulkState.columns[ci+1], _bulkState.columns[ci]];
                _bulkState.rows.forEach(r => { [r[ci], r[ci+1]] = [r[ci+1], r[ci]]; });
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) {
                        if (v === ci) tpl.bindings[k] = ci + 1;
                        else if (v === ci + 1) tpl.bindings[k] = ci;
                    }
                });
                _bcRenderBindings();
            }));
            const div3 = document.createElement('div'); div3.style.cssText = 'height:1px;background:#333;margin:4px 0;';
            menu.appendChild(div3);
        }

        menu.appendChild(createItem('清理换行', '🧹', () => processItems(v => _bcCleanBreaks(v), 0)));
        const savedWrapWidth = parseInt(localStorage.getItem('bc_auto_wrap_width') || '18', 10) || 18;
        menu.appendChild(createItem(`自动断行 (${savedWrapWidth}字)`, '↩️', () => processItems(v => _bcAutoWrapText(v, savedWrapWidth), 0)));
        menu.appendChild(createItem('设置断行字数...', '⚙️', async () => {
            const input = await _bcPrompt('设置自动断行字数', '当前字数: ' + savedWrapWidth);
            if (input !== null) {
                const newWidth = parseInt(input.trim(), 10);
                if (!isNaN(newWidth) && newWidth > 0) {
                    localStorage.setItem('bc_auto_wrap_width', newWidth);
                    if (typeof showToast === 'function') showToast(`自动断行字数已设置为 ${newWidth}，再次右键生效`, 'success');
                } else {
                    if (typeof showToast === 'function') showToast('请输入有效的正整数', 'error');
                }
            }
        }));
        const div = document.createElement('div'); div.style.cssText = 'height:1px;background:#333;margin:4px 0;';
        menu.appendChild(div);
        menu.appendChild(createItem('拆分两段 (标/内)', '✂️', () => processItems(v => _bcSplitTwoParts(v), 1)));
        menu.appendChild(createItem('拆分三段 (标/内/尾)', '📑', () => processItems(v => _bcSplitThreeParts(v), 2)));
        
        document.body.appendChild(menu);
        
        // Auto-close on click outside. Use capture because the modal stops bubbling events.
        const closeMenu = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.remove();
                document.removeEventListener('mousedown', closeMenu, true);
                document.removeEventListener('contextmenu', closeMenu, true);
                document.removeEventListener('scroll', closeMenu, true);
                document.removeEventListener('keydown', closeMenuKey, true);
            }
        };
        const closeMenuKey = (ev) => {
            if (ev.key === 'Escape') closeMenu(ev);
        };
        setTimeout(() => {
            document.addEventListener('mousedown', closeMenu, true);
            document.addEventListener('contextmenu', closeMenu, true);
            document.addEventListener('scroll', closeMenu, true);
            document.addEventListener('keydown', closeMenuKey, true);
        }, 10);
    });

    function _bcOpenExpandedEditor(ri, ci, initialValue) {
        if (ri < 0 || ci < 0 || !_bulkState.rows[ri]) return;
        const colName = _bulkState.columns[ci]?.name || `列${ci + 1}`;
        const val = initialValue !== undefined ? initialValue : (_bulkState.rows[ri]?.[ci] || '');

        const m = document.createElement('div');
        m.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:400000;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;';
        m.innerHTML = `<div style="background:#1a1a2e;border:1px solid #444;border-radius:12px;width:600px;max-width:90vw;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.8);">
            <div style="padding:10px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
                <span style="color:#fff;font-size:13px;font-weight:600;">✏️ ${_bcEsc(colName)} — 第 ${ri + 1} 行</span>
                <div style="display:flex;gap:6px;">
                    <button id="bc-exp-ok" style="padding:4px 16px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">保存</button>
                    <button id="bc-exp-cancel" style="padding:4px 12px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
                </div>
            </div>
            <div style="padding:12px;flex:1;overflow:auto;">
                <textarea id="bc-exp-textarea" style="width:100%;min-height:300px;max-height:60vh;background:#0a0a14;border:1px solid #333;border-radius:8px;color:#ddd;font-size:13px;line-height:1.6;padding:12px;resize:vertical;box-sizing:border-box;font-family:inherit;">${_bcEsc(val)}</textarea>
                <div style="margin-top:6px;font-size:10px;color:#555;text-align:right;">Ctrl+Enter 保存 · Esc 取消</div>
            </div>
        </div>`;
        document.body.appendChild(m);

        const ta = m.querySelector('#bc-exp-textarea');
        setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 50);

        const save = () => {
            if (_bulkState.rows[ri]) _bulkState.rows[ri][ci] = ta.value;
            m.remove();
            _bcRenderTable();
            _bcScheduleDraftSave();
        };
        m.querySelector('#bc-exp-ok').onclick = save;
        m.querySelector('#bc-exp-cancel').onclick = () => m.remove();
        ta.addEventListener('keydown', ev => {
            if (ev.key === 'Escape') { ev.preventDefault(); m.remove(); }
            if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); }
        });
        m.addEventListener('click', ev => { if (ev.target === m) m.remove(); });
    }

    async function _bcPickMediaFiles(ri, ci) {
        if (!_bcIsMediaColumn(ci)) return;
        let paths = null;
        const kind = _bcColumnKind(_bulkState.columns[ci]);
        const filterByKind = {
            image: { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] },
            video: { name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm'] },
            audio: { name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'] },
            subtitle: { name: '字幕文件', extensions: ['srt', 'vtt', 'ass'] },
        };
        if (window.electronAPI?.selectFiles) {
            paths = await window.electronAPI.selectFiles({
                title: `选择${_bulkState.columns[ci]?.name || '素材'}文件`,
                multiple: true,
                filters: [
                    filterByKind[kind] || { name: '媒体与字幕文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'srt', 'vtt', 'ass'] },
                    { name: '所有文件', extensions: ['*'] },
                ],
            });
        } else {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = 'video/*,image/*,audio/*';
            paths = await new Promise(resolve => {
                input.onchange = () => resolve(Array.from(input.files || []).map(_bcNativeFilePath));
                input.click();
            });
        }
        const count = _bcFillMediaColumn(paths || [], ri, ci);
        if (count && typeof showToast === 'function') showToast(`已添加 ${count} 个素材到「${_bulkState.columns[ci]?.name || '素材'}」列`, 'success');
    }

    // ── Double-click to expand cell editor ──
    tableBody.addEventListener('dblclick', e => {
        const cell = e.target.closest('.bc-cell, .bc-grid-td');
        if (!cell) return;
        e.preventDefault(); e.stopPropagation();
        const ri = parseInt(cell.dataset.ri);
        const ci = parseInt(cell.dataset.ci);
        if (_bcIsMediaColumn(ci)) {
            _bcPickMediaFiles(ri, ci);
            return;
        }
        _bcOpenExpandedEditor(ri, ci);
    });

    // ── Mouse Selection Events ──
    const bcCellFromPoint = (clientX, clientY) => {
        const el = document.elementFromPoint(clientX, clientY);
        return el ? el.closest('.bc-cell, .bc-grid-td') : null;
    };
    const bcExtendSelectionTo = (cell) => {
        if (!cell || !_bcSelection) return;
        const ri = parseInt(cell.dataset.ri);
        const ci = parseInt(cell.dataset.ci);
        if (Number.isNaN(ri) || Number.isNaN(ci)) return;
        if (_bcSelection.r2 === ri && _bcSelection.c2 === ci) return;
        _bcSelection.r2 = ri;
        _bcSelection.c2 = ci;
        _bcUpdateSelectionUI();
    };

    tableBody.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        const cell = e.target.closest('.bc-cell, .bc-grid-td');
        if (!cell) {
            _bcSelection = null;
            _bcUpdateSelectionUI();
            return;
        }
        e.preventDefault();
        tableBody.focus();

        const ri = parseInt(cell.dataset.ri);
        const ci = parseInt(cell.dataset.ci);
        _bcIsSelecting = true;
        if (e.shiftKey && _bcSelection) {
            _bcSelection.r2 = ri;
            _bcSelection.c2 = ci;
        } else {
            _bcSelection = { r1: ri, c1: ci, r2: ri, c2: ci };
        }
        _bcUpdateSelectionUI();
    });

    document.addEventListener('mousemove', e => {
        if (!_bcIsSelecting) return;
        e.preventDefault();
        bcExtendSelectionTo(bcCellFromPoint(e.clientX, e.clientY));
    }, { signal: bcModalSignal });

    document.addEventListener('mouseup', () => {
        if (_bcIsSelecting) {
            _bcIsSelecting = false;
            _bcUpdateSelectionUI();
        }
    }, { signal: bcModalSignal });

    const _bcClearMediaDropTargets = () => {
        tableBody.querySelectorAll('.bc-media-drop-target').forEach(el => el.classList.remove('bc-media-drop-target'));
    };
    const _bcMediaDropTarget = (target) => {
        const cell = target.closest?.('.bc-grid-td, .bc-cell');
        if (cell) {
            const ci = parseInt(cell.dataset.ci);
            if (_bcIsMediaColumn(ci)) {
                return {
                    ci,
                    ri: parseInt(cell.dataset.ri),
                    el: cell.classList.contains('bc-grid-td') ? cell : cell.closest('.bc-grid-td'),
                };
            }
        }
        const th = target.closest?.('.bc-col-header');
        if (th) {
            const ci = parseInt(th.dataset.ci);
            if (_bcIsMediaColumn(ci)) return { ci, ri: 0, el: th };
        }
        return null;
    };

    tableBody.addEventListener('dragover', e => {
        const target = _bcMediaDropTarget(e.target);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        _bcClearMediaDropTargets();
        if (target.el) target.el.classList.add('bc-media-drop-target');
    });

    tableBody.addEventListener('dragleave', e => {
        if (!tableBody.contains(e.relatedTarget)) _bcClearMediaDropTargets();
    });

    tableBody.addEventListener('drop', e => {
        const target = _bcMediaDropTarget(e.target);
        _bcClearMediaDropTargets();
        if (!target) return;
        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        const paths = files.map(_bcNativeFilePath).filter(Boolean);
        const count = _bcFillMediaColumn(paths, target.ri, target.ci);
        if (count && typeof showToast === 'function') showToast(`已拖入 ${count} 个素材到「${_bulkState.columns[target.ci]?.name || '素材'}」列`, 'success');
    });

    // ── Keyboard Navigation & Bulk Operations ──
    tableBody.addEventListener('keydown', e => {
        const t = e.target;
        const isTable = t === tableBody;
        if (!isTable) return;
        if (!_bcSelection && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Backspace', 'Delete'].includes(e.key)) {
            _bcSelection = { r1: 0, c1: 0, r2: 0, c2: 0 };
            _bcUpdateSelectionUI();
        }
        if (!_bcSelection) return;

        const bounds = _bcSelectionBounds();
        const isMulti = bounds && (bounds.minR !== bounds.maxR || bounds.minC !== bounds.maxC);

        // Copy (Ctrl+C / Cmd+C)
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            e.preventDefault();
            let clip = '';
            for (let r = bounds.minR; r <= bounds.maxR; r++) {
                let rowClip = [];
                for (let c = bounds.minC; c <= bounds.maxC; c++) {
                    let val = _bulkState.rows[r]?.[c] || '';
                    if (val.includes('\n') || val.includes('\t') || val.includes('"')) {
                        val = '"' + val.replace(/"/g, '""') + '"';
                    }
                    rowClip.push(val);
                }
                clip += rowClip.join('\t') + '\n';
            }
            navigator.clipboard.writeText(clip);
            return;
        }

        // Delete Bulk Content
        if ((e.key === 'Backspace' || e.key === 'Delete') && _bcSelection) {
            e.preventDefault();
            for (let r = bounds.minR; r <= bounds.maxR; r++) {
                for (let c = bounds.minC; c <= bounds.maxC; c++) {
                    if (_bulkState.rows[r]) _bulkState.rows[r][c] = '';
                }
            }
            _bcRenderTable();
            _bcScheduleDraftSave();
            return;
        }

        let ri = _bcSelection.r1;
        let ci = _bcSelection.c1;
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            _bcOpenExpandedEditor(ri, ci, e.key);
            return;
        }
        if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || e.key === 'F2') {
            e.preventDefault();
            _bcOpenExpandedEditor(ri, ci);
            return;
        }

        let nextRi = ri, nextCi = ci;
        if (e.key === 'Tab') {
            e.preventDefault();
            if (e.shiftKey) { nextCi = ci - 1; if (nextCi < 0) { nextCi = _bulkState.columns.length - 1; nextRi = ri - 1; } }
            else { nextCi = ci + 1; if (nextCi >= _bulkState.columns.length) { nextCi = 0; nextRi = ri + 1; } }
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (isMulti) {
                _bcOpenExpandedEditor(ri, ci);
                return;
            }
            nextRi = ri + 1;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault(); nextRi = ri - 1;
        } else if (e.key === 'ArrowDown') {
            e.preventDefault(); nextRi = ri + 1;
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault(); nextCi = ci - 1;
        } else if (e.key === 'ArrowRight') {
            e.preventDefault(); nextCi = ci + 1;
        } else { return; }
        // Auto-add row if needed
        if (nextRi >= _bulkState.rows.length) {
            _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
            _bcRenderTable();
        }
        if (nextRi < 0) return;
        if (nextCi < 0 || nextCi >= _bulkState.columns.length) return;
        if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            _bcSelection.r2 = nextRi;
            _bcSelection.c2 = nextCi;
        } else {
            _bcSelection = { r1: nextRi, c1: nextCi, r2: nextRi, c2: nextCi };
        }
        _bcUpdateSelectionUI();
    });

    // ── RFC 4180 TSV parser: correctly handles cells with embedded newlines ──
    // Google Sheets wraps cells containing \n in double quotes: "line1\nline2"
    // Internal quotes are doubled: "He said ""hello"""
    function _bcParseTSV(text) {
        const rows = [];
        let row = [];
        let cell = '';
        let inQuote = false;
        let i = 0;
        const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        while (i < src.length) {
            const ch = src[i];

            if (inQuote) {
                if (ch === '"') {
                    // Peek next char
                    if (i + 1 < src.length && src[i + 1] === '"') {
                        // Escaped quote "" → literal "
                        cell += '"';
                        i += 2;
                    } else {
                        // End of quoted field
                        inQuote = false;
                        i++;
                    }
                } else {
                    cell += ch;
                    i++;
                }
            } else {
                if (ch === '"' && cell === '') {
                    // Start of quoted field (only at beginning of cell)
                    inQuote = true;
                    i++;
                } else if (ch === '\t') {
                    row.push(cell);
                    cell = '';
                    i++;
                } else if (ch === '\n') {
                    row.push(cell);
                    cell = '';
                    // Skip trailing empty rows
                    if (row.some(c => c.trim())) rows.push(row);
                    row = [];
                    i++;
                } else {
                    cell += ch;
                    i++;
                }
            }
        }
        // Flush last cell/row
        row.push(cell);
        if (row.some(c => c.trim())) rows.push(row);
        return rows;
    }

    // ── Smart paste: handles both TSV button and direct Ctrl+V ──
    function _bcHandlePaste(text, anchorRi, anchorCi) {
        if (!text || !text.trim()) return;
        const lines = _bcParseTSV(text);
        if (lines.length === 0) return;

        // If pasting into a specific cell (not full-table mode)
        if (anchorRi >= 0 && anchorCi >= 0) {
            // Auto-add columns if pasted data exceeds current table width
            const maxPastedCols = Math.max(...lines.map(l => l.length));
            const neededCols = anchorCi + maxPastedCols;
            while (_bulkState.columns.length < neededCols) {
                _bulkState.columns.push({ name: `列${_bulkState.columns.length + 1}`, type: 'text' });
                // Pad all existing rows to match new column count
                _bulkState.rows.forEach(r => r.push(''));
            }
            // Paste starting from anchor cell, expand grid as needed
            lines.forEach((cols, li) => {
                const targetRi = anchorRi + li;
                while (targetRi >= _bulkState.rows.length)
                    _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
                cols.forEach((val, colOff) => {
                    const targetCi = anchorCi + colOff;
                    if (targetCi < _bulkState.columns.length && _bulkState.rows[targetRi])
                        _bulkState.rows[targetRi][targetCi] = val;
                });
            });
            _bcSelection = {
                r1: anchorRi,
                c1: anchorCi,
                r2: anchorRi + lines.length - 1,
                c2: anchorCi + maxPastedCols - 1,
            };
            _bcRenderTable();
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }

        // Full-table paste mode (button or empty table)
        const first = lines[0];
        const colCount = Math.max(...lines.map(l => l.length));

        if (ov.querySelector('#bc-auto-headers').checked) {
            const rule = readHeaderRule();
            if (!rule || !Number.isSafeInteger(rule.start + Math.floor((colCount - 1) / rule.names.length))) {
                alert('请填写有效的整数起始编号和循环列名（逗号或顿号分隔）。');
                return;
            }
            _bulkState.columns = Array.from({ length: colCount }, (_, index) => _bcColumnFromName(headerName(rule, index)));
            _bulkState.rows = lines.map(line => Array.from({ length: colCount }, (_, index) => line[index] || ''));
            _bcSelection = null;
            _bcAutoRebindAllTemplates();
            _bcRenderTable();
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }

        // Ask user about header row
        let hasHdr = false;
        if (lines.length > 1) {
            hasHdr = confirm(`粘贴了 ${lines.length} 行 × ${colCount} 列数据\n\n第一行是否为标题行？\n\n"${first.slice(0, 4).join(' | ')}${first.length > 4 ? ' ...' : ''}"\n\n确定 = 第一行作为列标题\n取消 = 全部作为数据`);
        }

        if (hasHdr) {
            _bulkState.columns = first.map(h => _bcColumnFromName(h.trim() || '列'));
            _bulkState.rows = lines.slice(1).map(l => {
                const r = new Array(_bulkState.columns.length).fill('');
                l.forEach((v, i) => { if (i < r.length) r[i] = v; });
                return r;
            });
        } else {
            // Expand columns if needed
            while (_bulkState.columns.length < colCount)
                _bulkState.columns.push({ name: `列${_bulkState.columns.length + 1}`, type: 'text' });
            _bulkState.rows = lines.map(l => {
                const r = new Array(_bulkState.columns.length).fill('');
                l.forEach((v, i) => { if (i < r.length) r[i] = v; });
                return r;
            });
        }
        _bcRenderTable(); _bcRenderBindings(); _bcScheduleDraftSave();
    }

    function _bcPasteIntoSelection(e) {
        const active = document.activeElement;
        if (active && active !== tableBody && /^(INPUT|TEXTAREA|SELECT)$/i.test(active.tagName)) return false;
        if (active && active.isContentEditable) return false;

        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (!text) return false;

        e.preventDefault();
        e.stopPropagation();
        const cell = e.target.closest?.('.bc-cell, .bc-grid-td');
        if (_bcSelection || cell) {
            const startRi = _bcSelection ? Math.min(_bcSelection.r1, _bcSelection.r2) : parseInt(cell.dataset.ri);
            const startCi = _bcSelection ? Math.min(_bcSelection.c1, _bcSelection.c2) : parseInt(cell.dataset.ci);
            _bcHandlePaste(text, startRi, startCi);
        } else {
            _bcHandlePaste(text, -1, -1);
        }
        return true;
    }

    // Direct Ctrl+V anywhere in the modal as long as a grid cell is selected.
    document.addEventListener('paste', e => {
        const modal = document.getElementById('bc-modal');
        if (!modal) return;
        const active = document.activeElement;
        const eventInsideModal = modal.contains(e.target);
        const focusInsideModal = active && modal.contains(active);
        if (!eventInsideModal && !focusInsideModal) return;
        _bcPasteIntoSelection(e);
    }, { capture: true, signal: bcModalSignal });

    // Paste TSV button (full-table replace mode)
    ov.querySelector('#bc-paste-tsv').addEventListener('click', async () => {
        let text = '';
        try { text = await navigator.clipboard.readText(); } catch(e) { text = await _bcPrompt('粘贴 TSV 数据', '从 Google Sheets 复制的内容'); }
        _bcHandlePaste(text, -1, -1);
    });
}

window._showBulkCreateModal = _showBulkCreateModal;
