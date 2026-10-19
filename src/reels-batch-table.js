function _rbtReadOverlayGroupPresetsRaw() {
    return window.electronAPI?.readOverlayGroupPresets?.() || localStorage.getItem('reels_overlay_group_presets') || '{}';
}
function _rbtSaveOverlayGroupPresets(data) {
    if (window._reelsState?.overlayPanel?._setOverlayGroupPresets) return window._reelsState.overlayPanel._setOverlayGroupPresets(data);
    const result = window.electronAPI?.saveOverlayGroupPresets?.(JSON.stringify(data));
    if (result && !result.ok) { alert('覆层预设保存失败：' + result.error); throw new Error(result.error); }
    if (!result) localStorage.setItem('reels_overlay_group_presets', JSON.stringify(data));
}
/**
 * reels-batch-table.js — 批量文字卡片表格管理
 *
 * 表格驱动的批量生产面板：
 *   - 每行 = 一个 Reel 任务
 *   - 列: # | 背景素材 | 音频 | 字幕 | 标题 | 内容 | 模板
 *   - 支持从 Google Sheets 粘贴 标题+内容
 *   - 每行可独立选择卡片模板
 *   - 拖拽/批量分配素材
 */

// ═══════════════════════════════════════════════════════
// 1. Core State & Config
// ═══════════════════════════════════════════════════════

let _dragSrcIdx = null; // 拖拽排序：源行索引（模块级，供 panel drop 判断）

// 批量预设库的就地编辑器：不跳主 Reels。背景只用于此弹窗预览，不写入任务/预设。
window.openBatchOverlayPresetEditor = function(name, preset) {
    if (!window.ReelsOverlayPanel || !window.ReelsOverlay?.OverlayManager) return alert('覆层编辑器尚未加载');
    const layers = JSON.parse(JSON.stringify(Array.isArray(preset) ? preset : (preset.layers || [])));
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:450000;background:#000d;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `<div style="background:#181822;padding:16px;border-radius:10px;display:flex;gap:16px;max-width:96vw;height:92vh;overflow:hidden;color:#ddd;box-sizing:border-box;">
      <div style="display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;">
        <div data-viewport style="width:min(38vw,360px);aspect-ratio:9/16;position:relative;background:#080810;border-radius:8px;overflow:hidden;cursor:grab;user-select:none;border:1px solid rgba(255,255,255,0.15);box-shadow:0 6px 20px rgba(0,0,0,0.5);">
          <div style="position:absolute;top:6px;right:6px;z-index:20;display:flex;gap:4px;background:rgba(0,0,0,0.75);backdrop-filter:blur(6px);padding:3px 6px;border-radius:5px;border:1px solid rgba(255,255,255,0.15);">
            <span data-zoom-label style="font-size:11px;color:#eee;align-self:center;min-width:36px;text-align:center;font-family:monospace;">100%</span>
            <button data-zoom-in style="padding:1px 6px;font-size:11px;background:rgba(255,255,255,0.15);color:#fff;border:0;border-radius:3px;cursor:pointer;" title="放大">➕</button>
            <button data-zoom-out style="padding:1px 6px;font-size:11px;background:rgba(255,255,255,0.15);color:#fff;border:0;border-radius:3px;cursor:pointer;" title="缩小">➖</button>
            <button data-zoom-reset style="padding:1px 6px;font-size:10px;background:rgba(255,255,255,0.15);color:#aaa;border:0;border-radius:3px;cursor:pointer;" title="复位">1:1</button>
          </div>
          <div data-stage style="position:absolute;top:0;left:0;width:100%;height:100%;transform-origin:0 0;will-change:transform;">
            <video data-video muted loop playsinline style="width:100%;height:100%;object-fit:cover;position:absolute;"></video>
            <img data-image style="width:100%;height:100%;object-fit:cover;position:absolute;display:none;">
            <canvas data-canvas width="1080" height="1920" style="width:100%;height:100%;position:absolute;pointer-events:none;"></canvas>
          </div>
        </div>
        <div style="font-size:11px;color:#94a3b8;margin-top:6px">💡 滚轮缩放画面，按住拖拽平移，双击复位。</div>
      </div>
      <div style="width:240px;display:flex;flex-direction:column;gap:8px;font-size:12px;flex-shrink:0;"><strong>✏️ 直接编辑「${String(name).replace(/</g, '&lt;')}」</strong><button data-bg>🖼 选择临时预览背景</button><button data-clear>清除临时背景</button><span data-label style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">未设置（深色底）</span><span style="color:#94a3b8;font-size:11px;">背景仅供预览，不保存到预设、不影响导出。</span><button data-save style="margin-top:auto;background:#2563eb;color:#fff;border:0;border-radius:5px;padding:8px;cursor:pointer;">保存预设</button><button data-close>完成</button></div>
      <div data-panel style="flex:1;min-width:380px;height:100%;overflow-y:auto;border-left:1px solid #444;padding-left:12px;box-sizing:border-box;"></div></div>`;
    document.body.appendChild(modal);
    const get = s => modal.querySelector(s), mgr = new window.ReelsOverlay.OverlayManager(); mgr.overlays = layers;

    // 滚轮缩放与平移
    const vp = get('[data-viewport]'), stg = get('[data-stage]'), zLbl = get('[data-zoom-label]');
    if (vp && stg) {
        let sc = 1.0, px = 0, py = 0, panning = false, sx = 0, sy = 0, ox = 0, oy = 0;
        const update = () => { stg.style.transform = `translate(${px}px, ${py}px) scale(${sc})`; if (zLbl) zLbl.textContent = `${Math.round(sc * 100)}%`; };
        vp.addEventListener('wheel', e => {
            e.preventDefault(); e.stopPropagation();
            const rect = vp.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
            const factor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
            const nsc = Math.min(6.0, Math.max(0.6, sc * factor));
            px = mx - (mx - px) * (nsc / sc); py = my - (my - py) * (nsc / sc);
            sc = nsc;
            if (Math.abs(sc - 1.0) < 0.04) { sc = 1.0; px = 0; py = 0; }
            update();
        }, { passive: false });
        vp.addEventListener('pointerdown', e => {
            if (e.target.closest('button')) return;
            panning = true; sx = e.clientX; sy = e.clientY; ox = px; oy = py;
            vp.style.cursor = 'grabbing';
            try { vp.setPointerCapture(e.pointerId); } catch (_) {}
        });
        vp.addEventListener('pointermove', e => { if (!panning) return; px = ox + (e.clientX - sx); py = oy + (e.clientY - sy); update(); });
        const endP = () => { if (panning) { panning = false; vp.style.cursor = 'grab'; } };
        vp.addEventListener('pointerup', endP); vp.addEventListener('pointercancel', endP);
        get('[data-zoom-in]').onclick = () => { sc = Math.min(6.0, sc * 1.25); update(); };
        get('[data-zoom-out]').onclick = () => { sc = Math.max(0.6, sc * 0.8); update(); };
        get('[data-zoom-reset]').onclick = () => { sc = 1.0; px = 0; py = 0; update(); };
        vp.addEventListener('dblclick', e => { if (e.target.closest('button')) return; sc = Math.abs(sc - 1.0) < 0.1 ? 2.0 : 1.0; px = 0; py = 0; update(); });
    }

    let bgPath = '';
    const draw = () => { const c = get('[data-canvas]'), ctx = c.getContext('2d'); ctx.clearRect(0,0,1080,1920); for (const ov of mgr.overlays) window.ReelsOverlay.drawOverlay(ctx, { ...ov, _exporting:true }, 0, 1080, 1920); };
    const proxy = { overlayMgr:mgr, getCanvasSize:()=>({w:1080,h:1920,cx:540,cy:960}), getDuration:()=>9999, previewEnd:()=>{}, addOverlay:o=>{mgr.addOverlay(o);draw();panel._refreshList();}, removeOverlay:id=>{mgr.removeOverlay(id);draw();panel._refreshList();}, render:draw, getOverlayAboveSubtitle:()=>true, setOverlayAboveSubtitle:()=>{} };
    const panel = new window.ReelsOverlayPanel(get('[data-panel]'), proxy); get('[data-panel]').querySelector('.rop-section')?.remove(); panel._refreshList(); if(mgr.overlays[0]) panel.selectOverlay(mgr.overlays[0]); draw();
    get('[data-bg]').onclick = async () => { const p = await window.electronAPI?.selectFiles?.({title:'选择临时预览背景',filters:[{name:'图片或视频',extensions:['mp4','mov','mkv','webm','jpg','jpeg','png','webp','gif']}]}); bgPath=p?.[0]||''; if(!bgPath)return; const isImg=/\.(jpg|jpeg|png|webp|gif)$/i.test(bgPath), el=isImg?get('[data-image]'):get('[data-video]'); get('[data-image]').style.display=isImg?'':'none';get('[data-video]').style.display=isImg?'none':'';el.src=window.electronAPI?.toFileUrl?window.electronAPI.toFileUrl(bgPath):bgPath;if(!isImg)el.play().catch(()=>{});get('[data-label]').textContent=bgPath.split(/[\\/]/).pop(); };
    get('[data-clear]').onclick=()=>{get('[data-video]').removeAttribute('src');get('[data-image]').removeAttribute('src');get('[data-image]').style.display='none';get('[data-video]').style.display='';get('[data-label]').textContent='未设置（深色底）';};
    get('[data-save]').onclick=()=>{let all={};try{all=JSON.parse(_rbtReadOverlayGroupPresetsRaw()||'{}')}catch(_){};all[name]={...(Array.isArray(preset)?{}:preset),name,layers:JSON.parse(JSON.stringify(mgr.overlays)),updatedAt:new Date().toISOString()};_rbtSaveOverlayGroupPresets(all);if(typeof showToast==='function')showToast(`预设「${name}」已保存`, 'success');};
    get('[data-close]').onclick=()=>modal.remove();
};
const _VOICE_HINT_REGEX = /(^|[\s._-])(voice|audio|dub|dubbing|narration|vo|配音|人声|旁白|解说|口播)([\s._-]|$)/i;
const _VOICE_VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm']);
const _CLIP_POOL_VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm']);

function _looksLikeVoiceTrack(name = '') {
    return _VOICE_HINT_REGEX.test(name || '');
}

function _generateUniqueCardName(tasks, prefix = 'card') {
    let max = 0;
    const list = tasks || [];
    const regex = new RegExp(`^${prefix}_(\\d+)`, 'i');
    for (const t of list) {
        const name = t.baseName || t.fileName || '';
        const match = name.match(regex);
        if (match) {
            const num = parseInt(match[1]);
            if (num > max) max = num;
        }
    }
    return `${prefix}_${String(max + 1).padStart(3, '0')}`;
}

function _ensureTaskId(task) {
    if (!task) return;
    if (!task.id) {
        task.id = 'task_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    }
}

function _resolveDuplicateTaskNames(tasks) {
    if (!tasks) return;
    const seen = new Set();
    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        if (!task.baseName) {
            task.baseName = 'card';
        }
        let base = task.baseName;
        let candidate = base;
        let counter = 1;
        while (seen.has(candidate)) {
            candidate = `${base}_${counter}`;
            counter++;
        }
        if (task.baseName !== candidate) {
            task.baseName = candidate;
            task.fileName = candidate + '.mp4';
        }
        seen.add(candidate);
    }
}


function _naturalSortByName(a, b) {
    const extractName = (item) => {
        if (item && typeof item === 'object') {
            if (item.name) return String(item.name);
            if (item.path) return String(item.path).replace(/\\/g, '/').split('/').pop() || String(item.path);
        }
        const s = String(item || '');
        return s.replace(/\\/g, '/').split('/').pop() || s;
    };
    const nameA = extractName(a);
    const nameB = extractName(b);
    const cmp = nameA.localeCompare(nameB, undefined, {
        numeric: true,
        sensitivity: 'base',
    });
    if (cmp !== 0) return cmp;
    return String(a?.path || a?.name || a || '').localeCompare(String(b?.path || b?.name || b || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
    });
}
window._naturalSortByName = _naturalSortByName;

function _rbtFileExists(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    if (/^(blob:|data:|https?:)/i.test(filePath)) return true;
    if (window.electronAPI && typeof window.electronAPI.fileExists === 'function') {
        return window.electronAPI.fileExists(filePath);
    }
    return true;
}

function _rbtGetNativeFilePath(file) {
    if (file?._nativePath) return String(file._nativePath).trim();
    const filePath = (typeof getFileNativePath === 'function')
        ? getFileNativePath(file)
        : (file?.path || '');
    const value = String(filePath || '').trim();
    // 批量任务需要可跨预览、识别和导出使用的绝对本地路径；单独的文件名
    // 只能在 FileReader 中临时读取，不能存入任务。
    if (!value || (!value.includes('/') && !value.includes('\\'))) return '';
    return value;
}

function _rbtNativePathFile(filePath) {
    const value = String(filePath || '').trim();
    const name = value.split(/[\\/]/).pop() || value;
    // 仅用于背景/音频这类不需要读取浏览器 File 内容的批量素材。
    // 路径来自原生 dialog，避免 macOS 上从 File 对象反查路径不稳定。
    return { name, path: value, _nativePath: value };
}

function _rbtShowNativePathError(files) {
    const names = Array.from(files || []).slice(0, 5).map(f => f?.name).filter(Boolean).join('、');
    alert(`未能取得所选素材的完整本地路径${names ? `：${names}` : ''}。\n\n请关闭后重新打开 VideoKit，再通过“选择文件”重新添加素材。为避免之后对齐或导出错配，本次不会保存只有文件名的素材记录。`);
}

function _rbtMediaUrl(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    if (/^(local-media:|file:|blob:|data:|https?:)/i.test(filePath)) return filePath;
    if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function') {
        const url = window.electronAPI.toFileUrl(filePath);
        if (url) return url;
    }
    return filePath;
}

function _rbtMissingFileLabel(filePath) {
    return `<div style="display:flex;align-items:center;gap:6px;color:#ff9f43;">
                <span style="width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;background:rgba(255,159,67,0.12);border:1px solid rgba(255,159,67,0.25);flex-shrink:0;">!</span>
                <span class="rbt-file-name" style="flex:1;font-size:10px;word-break:break-all;" title="${_escHtml(filePath)}">文件缺失: ${_escHtml(_shortName(filePath))}</span>
            </div>`;
}

const _batchTableState = {
    visible: false,
    container: null,
    // ── 多标签页 ──
    tabs: [
        { id: 'tab_1', name: '默认', materialDir: '', lastRefreshTime: null, tasks: [] }
    ],
    activeTabId: 'tab_1',
    appliedTabIds: [],
    nextTabId: 2,
    // ── 视频分配模式（默认关闭） ──
    videoDropRouteEnabled: false,
    videoDropRouteMode: 'bg', // 'bg' | 'audio'
    // ── 批量选择 ──
    selectedRows: new Set(),
    actionsCollapsed: false,
    mediaPoolOpen: false,
    // ── 当前活跃编辑的覆层卡片状态 ──
    _activeTextcardId: null,
    _activeTextcardName: '',
    _activeTextcardIdx: 0,
    _activeScrollId: null,
    _activeScrollName: '',
    _activeScrollIdx: 0,
    // ── 工程管理 ──
    projectDir: (typeof window !== 'undefined' && window.electronAPI?.getDefaultProjectDir?.()) || '',
    projectName: 'UntitledProject.json',
    openSnapshotTasks: null,
    // 停顿插入的统一规则：只影响之后执行的批量插入，不改已有片段。
    insertDurationRule: { mode: 'fixed', fixedDuration: 3, maxDuration: 3 },
};

// ── 标签页辅助 ──
function _getActiveTab() {
    return _batchTableState.tabs.find(t => t.id === _batchTableState.activeTabId) || _batchTableState.tabs[0];
}

function _normalizeBatchTabState() {
    if (!_batchTableState.tabs.length) return;
    if (!_batchTableState.tabs.some(t => t.id === _batchTableState.activeTabId)) {
        _batchTableState.activeTabId = _batchTableState.tabs[0].id;
    }
    const maxNumericId = _batchTableState.tabs.reduce((max, tab) => {
        const match = String(tab.id || '').match(/^tab_(\d+)$/);
        return match ? Math.max(max, parseInt(match[1], 10) || 0) : max;
    }, 0);
    _batchTableState.nextTabId = Math.max(
        Number(_batchTableState.nextTabId) || 1,
        maxNumericId + 1,
    );
}

function _stripBatchGroupMeta(task) {
    const clean = _cloneBatchTasks([task])[0] || {};
    delete clean._batchTabId;
    delete clean._batchTabName;
    delete clean._batchTabOrder;
    delete clean._batchTaskOrder;
    delete clean._batchProjection;
    return clean;
}

function _isBatchGroupedProjection(tasks = window._reelsState?.tasks || []) {
    if (tasks.length > 0 && tasks.some(t => t && t._batchProjection && t._batchTabId)) return true;
    if (tasks.length === 0 && !_batchTableState.visible && Array.isArray(_batchTableState.appliedTabIds) && _batchTableState.appliedTabIds.length > 0) {
        return true;
    }
    return false;
}

/** 将外部按组任务的修改精确回写到各自标签，避免覆盖当前活动标签。 */
function _syncGroupedProjectionToTabs(activeTasks) {
    const grouped = new Map();
    for (const task of activeTasks) {
        if (!task?._batchTabId){
            const activeTab=_getActiveTab();if(!activeTab)continue;
            _ensureTaskId(task);task._batchTabId=activeTab.id;task._batchTabName=activeTab.name;task._batchProjection=true;
            task._batchTaskOrder=(activeTab.tasks||[]).length+activeTasks.indexOf(task);
        }
        if(!_batchTableState.tabs.some(tab=>tab.id===task._batchTabId)){
            _batchTableState.tabs.push({id:task._batchTabId,name:task._batchTabName||'恢复的任务组',tasks:[]});
            _normalizeBatchTabState();
        }
        if (!grouped.has(task._batchTabId)) grouped.set(task._batchTabId, []);
        grouped.get(task._batchTabId).push(task);
    }
    // A task may have just arrived from another workflow while the external
    // queue is a merged projection.  Include every group present in that queue,
    // not only the groups that were part of the older projection snapshot.
    for (const tabId of new Set([...( _batchTableState.appliedTabIds || []), ...grouped.keys()])) {
        const tab = _batchTableState.tabs.find(t => t.id === tabId);
        if (!tab) continue;
        tab.tasks = (grouped.get(tabId) || [])
            .sort((a, b) => (a._batchTaskOrder || 0) - (b._batchTaskOrder || 0))
            .map(_stripBatchGroupMeta);
    }
}

function reelsSyncTaskRemovalToBatchTabs(removedTasks) {
    const list = Array.isArray(removedTasks) ? removedTasks : (removedTasks ? [removedTasks] : []);
    const removedIds = new Set(list.map(t => t?.id).filter(Boolean));
    if (removedIds.size > 0) {
        for (const tab of _batchTableState.tabs || []) {
            if (Array.isArray(tab.tasks)) {
                tab.tasks = tab.tasks.filter(t => !t || !removedIds.has(t.id));
            }
        }
    }
    _syncTasksToActiveTab();
    _batchAutoSave({ skipSync: true });
}
window.reelsSyncTaskRemovalToBatchTabs = reelsSyncTaskRemovalToBatchTabs;

// Importers (for example 文案自动剪辑) add a task directly to the Reels queue.
// Archive it immediately in the active batch tab as well; otherwise opening the
// batch table can reload the tab and discard this ungrouped in-memory task.
function reelsArchiveTaskToActiveBatchTab(task) {
    if (!task) return null;
    const tab = _getActiveTab();
    if (!tab) return null;
    _ensureTaskId(task);
    const previousTasks = _cloneBatchTasks(tab.tasks || []);
    task._batchTabId = tab.id;
    task._batchTabName = tab.name || '未命名分组';
    if (_isBatchGroupedProjection(window._reelsState?.tasks || [])) {
        task._batchProjection = true;
    }
    const archivedTask = _cloneBatchTasks([task])[0];
    const existingIndex = (tab.tasks || []).findIndex(item => item?.id === task.id);
    if (existingIndex >= 0) tab.tasks.splice(existingIndex, 1, archivedTask);
    else tab.tasks.push(archivedTask);
    return {
        tabId: tab.id,
        rollback: () => { tab.tasks = previousTasks; },
    };
}
window.reelsArchiveTaskToActiveBatchTab = reelsArchiveTaskToActiveBatchTab;

function _syncTasksToActiveTab() {
    const tab = _getActiveTab();
    if (!tab) return;

    // Ensure all active tasks have IDs
    (window._reelsState.tasks || []).forEach(t => _ensureTaskId(t));
    (tab.tasks || []).forEach(t => _ensureTaskId(t));

    const activeTasks = window._reelsState.tasks || [];
    if (_isBatchGroupedProjection(activeTasks)) {
        _syncGroupedProjectionToTabs(activeTasks);
        return;
    }
    const tabTasks = tab.tasks || [];

    const tabTasksMap = new Map();
    tabTasks.forEach((t, i) => {
        if (t.id) tabTasksMap.set(t.id, { task: t, index: i });
    });

    const isExplicitSubsetMode = window._reelsSubsetSyncMode === true;
    let isSubset = isExplicitSubsetMode && activeTasks.length > 0 && activeTasks.every(t => t.id && tabTasksMap.has(t.id));
    if (isSubset && activeTasks.length < tabTasks.length) {
        // Only update the tasks in tabTasks that match activeTasks by ID
        const updatedTabTasks = tabTasks.map(t => {
            const activeMatch = activeTasks.find(at => at.id === t.id);
            if (activeMatch) {
                return _cloneBatchTasks([activeMatch])[0];
            }
            return t;
        });
        tab.tasks = updatedTabTasks;
        console.log(`[BatchTable._syncTasksToActiveTab] 合并子集变化到 tab (仅更新已选中的 ${activeTasks.length} 个任务，保留其他任务)`);
    } else {
        // Full overwrite so deleted tasks are removed from the tab as well
        tab.tasks = _cloneBatchTasks(activeTasks);
        console.log('[BatchTable._syncTasksToActiveTab] 保存全部 tasks 到 tab, 长度:', tab.tasks.length);
    }
}

function _loadTabTasks(tab) {
    window._reelsState.tasks = _cloneBatchTasks(tab ? tab.tasks || [] : []);
    _batchTableState.appliedTabIds = [];
    window._reelsState.tasks.forEach(t => _ensureTaskId(t));
    _resolveDuplicateTaskNames(window._reelsState.tasks);
    window._reelsState.selectedIdx = -1;
}

function _switchToTab(tabId, opts = {}) {
    if (tabId === _batchTableState.activeTabId && !opts.forceLoad) return;
    // Save current tab tasks (apply DOM→state for the OLD tab before saving)
    if (!opts.skipSave) {
        // Apply any pending DOM edits to the CURRENT (old) tab's tasks before saving
        if (!_isRenderingBatchTable) {
            _isRenderingBatchTable = true;
            try { _applyBatchTableChanges(); } catch (e) { console.warn('[switchToTab] applyChanges error:', e); }
            _isRenderingBatchTable = false;
        }
        _syncTasksToActiveTab();
    }
    _batchTableState.activeTabId = tabId;
    const tab = _getActiveTab();
    _loadTabTasks(tab);
    _batchTableState.selectedRows = new Set();
    // ★ 关键：新标签的 tasks 已从 tab.tasks 加载，绝不能让旧 DOM 值覆盖
    _skipNextApply = true;
    if (opts.skipNextAutoSave) _skipNextBatchAutoSave = true;
    if (!opts.noRender) _renderBatchTable();
}

function _addTab(name) {
    const id = 'tab_' + _batchTableState.nextTabId++;
    const tab = { id, name: name || `标签${_batchTableState.tabs.length + 1}`, materialDir: '', lastRefreshTime: null, tasks: [] };
    _batchTableState.tabs.push(tab);
    _switchToTab(id);
    _batchAutoSave();
}

function _removeTab(tabId) {
    if (_batchTableState.tabs.length <= 1) { alert('至少保留一个标签页'); return; }
    const idx = _batchTableState.tabs.findIndex(t => t.id === tabId);
    if (idx < 0) return;
    if (!confirm(`确定删除标签「${_batchTableState.tabs[idx].name}」及其所有任务？`)) return;
    _batchTableState.tabs.splice(idx, 1);
    if (_batchTableState.activeTabId === tabId) {
        _batchTableState.activeTabId = _batchTableState.tabs[Math.min(idx, _batchTableState.tabs.length - 1)].id;
        _loadTabTasks(_getActiveTab());
    }
    _skipNextApply = true;
    _renderBatchTable();
}

async function _renameTab(tabId) {
    const tab = _batchTableState.tabs.find(t => t.id === tabId);
    if (!tab) return;
    const newName = await _showInputDialog('重命名标签', '输入标签名称');
    if (newName && newName.trim()) {
        tab.name = newName.trim();
        _renderBatchTable();
        _batchAutoSave();
    }
}

// ★ 应用标签页：将选中标签页的任务合并到当前任务列表
function _showMergeTabsModal() {
    // 先保存当前标签的 DOM 编辑
    try { _applyBatchTableChanges(); } catch (e) { console.warn('[MergeTabs] apply changes failed:', e); }
    _syncTasksToActiveTab();

    const tabs = _batchTableState.tabs;
    if (tabs.length <= 1) {
        alert('只有一个标签页，无需合并');
        return;
    }

    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

    const totalTasks = tabs.reduce((s, t) => s + (t.tasks?.length || 0), 0);

    ov.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:20px;min-width:420px;max-width:600px;max-height:80vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.6);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h3 style="margin:0;font-size:16px;color:#7b8bef;">📋 应用标签页到任务列表</h3>
                <button id="mt-close" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;">✕</button>
            </div>
            <p style="font-size:12px;color:#888;margin:0 0 12px;">选择要合并的标签页，它们的任务会被合并到当前激活标签中用于渲染输出。</p>
            <div style="margin-bottom:12px;display:flex;gap:8px;">
                <button id="mt-select-all" style="padding:4px 12px;font-size:11px;background:rgba(123,139,239,0.15);border:1px solid rgba(123,139,239,0.3);color:#7b8bef;border-radius:4px;cursor:pointer;">全选</button>
                <button id="mt-deselect-all" style="padding:4px 12px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;border-radius:4px;cursor:pointer;">全不选</button>
                <span style="flex:1;"></span>
                <span style="font-size:11px;color:#666;">共 ${tabs.length} 个标签 / ${totalTasks} 条任务</span>
            </div>
            <div id="mt-tab-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px;">
                ${tabs.map((tab, i) => {
                    const count = tab.tasks?.length || 0;
                    const isActive = tab.id === _batchTableState.activeTabId;
                    const t0 = tab.tasks?.[0];
                    const preview = t0?.overlays?.[0]?.title_text || t0?.ttsText || t0?.baseName || '';
                    return `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:${isActive ? 'rgba(123,139,239,0.1)' : 'rgba(255,255,255,0.03)'};border:1px solid ${isActive ? 'rgba(123,139,239,0.3)' : 'rgba(255,255,255,0.06)'};border-radius:6px;cursor:pointer;transition:background 0.15s;" onmouseenter="this.style.background='rgba(123,139,239,0.12)'" onmouseleave="this.style.background='${isActive ? 'rgba(123,139,239,0.1)' : 'rgba(255,255,255,0.03)'}'" >
                        <input type="checkbox" class="mt-tab-cb" data-tab-id="${tab.id}" checked style="margin:0;transform:scale(1.1);accent-color:#7b8bef;">
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:12px;color:#eee;font-weight:${isActive ? 'bold' : 'normal'};">${_escHtml(tab.name)}${isActive ? ' <span style="font-size:10px;color:#7b8bef;">（当前）</span>' : ''}</div>
                            <div style="font-size:10px;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${count}条任务${preview ? ' · ' + _escHtml(preview.slice(0, 40)) : ''}</div>
                        </div>
                    </label>`;
                }).join('')}
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button id="mt-cancel" style="padding:6px 16px;font-size:12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#aaa;border-radius:4px;cursor:pointer;">取消</button>
                <button id="mt-apply" style="padding:6px 20px;font-size:12px;background:rgba(123,139,239,0.3);border:1px solid rgba(123,139,239,0.5);color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;">✅ 应用选中标签</button>
            </div>
        </div>
    `;

    document.body.appendChild(ov);

    const close = () => ov.remove();
    ov.querySelector('#mt-close').onclick = close;
    ov.querySelector('#mt-cancel').onclick = close;
    ov.addEventListener('click', e => { if (e.target === ov) close(); });

    ov.querySelector('#mt-select-all').onclick = () => {
        ov.querySelectorAll('.mt-tab-cb').forEach(cb => cb.checked = true);
    };
    ov.querySelector('#mt-deselect-all').onclick = () => {
        ov.querySelectorAll('.mt-tab-cb').forEach(cb => cb.checked = false);
    };

    ov.querySelector('#mt-apply').onclick = () => {
        const selectedIds = new Set();
        ov.querySelectorAll('.mt-tab-cb:checked').forEach(cb => selectedIds.add(cb.dataset.tabId));
        if (selectedIds.size === 0) { alert('请至少选择一个标签页'); return; }

        // 如果只选了当前标签，不做任何改变
        if (selectedIds.size === 1 && selectedIds.has(_batchTableState.activeTabId)) {
            alert('已选中的就是当前标签页，无需合并');
            close();
            return;
        }

        // 建立按标签分组的外部任务投影；标签本身仍保持独立。
        const mergedTasks = [];
        _batchTableState.tabs.forEach((tab, tabOrder) => {
            if (!selectedIds.has(tab.id)) return;
            (tab.tasks || []).forEach((t, taskOrder) => {
                const cloned = _cloneBatchTasks([t])[0];
                if (cloned) {
                    cloned._batchProjection = true;
                    cloned._batchTabId = tab.id;
                    cloned._batchTabName = tab.name;
                    cloned._batchTabOrder = tabOrder;
                    cloned._batchTaskOrder = taskOrder;
                    mergedTasks.push(cloned);
                }
            });
        });

        // 写入外部投影，不覆盖任何一个标签页的数据。
        _batchTableState.appliedTabIds = Array.from(selectedIds);
        window._reelsState.tasks = mergedTasks;
        window._reelsState.selectedIdx = -1;
        _skipNextApply = true;

        console.log(`[MergeTabs] 已合并 ${selectedIds.size} 个标签页, 共 ${mergedTasks.length} 条任务`);
        alert(`✅ 已应用 ${selectedIds.size} 个标签页，共 ${mergedTasks.length} 条任务。\n外部列表将按标签分组，修改会回写各自标签。`);
        close();
        _renderBatchTable();
        if (typeof _renderTaskList === 'function') _renderTaskList();
    };
}

// ═══════════════════════════════════════════════════════
// 2. Initialization
// ═══════════════════════════════════════════════════════

function _initBatchTable() {
    // 容器
    let container = document.getElementById('reels-batch-table-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'reels-batch-table-container';
        document.body.appendChild(container);
    }
    container.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:9000;background:rgba(0,0,0,0.85);overflow:hidden;padding:16px;box-sizing:border-box;';
    _batchTableState.container = container;

    if (!_batchTableResizeBound) {
        _batchTableResizeBound = true;
        window.addEventListener('resize', _scheduleFitBatchTableToViewport);
    }
}

// ═══════════════════════════════════════════════════════
// 3. Toggle visibility
// ═══════════════════════════════════════════════════════

function _cloneBatchTasks(tasks) {
    try {
        return _serializeTasks(tasks || []);
    } catch (e) {
        console.warn('[BatchTable] clone tasks failed:', e);
        return Array.isArray(tasks) ? tasks.map(t => _serializeBatchValue(t) || {}) : [];
    }
}

function _batchTasksSnapshot(tasks) {
    try {
        return JSON.stringify(_serializeTasks(tasks || []));
    } catch (e) {
        console.warn('[BatchTable] snapshot failed:', e);
        return '[]';
    }
}

function _restoreGroupedProjectionFromTabs(tabIds) {
    const ids = [...new Set((tabIds || []).filter(id => _batchTableState.tabs.some(tab => tab.id === id)))];
    const mergedTasks = [];
    _batchTableState.tabs.forEach((tab, tabOrder) => {
        if (!ids.includes(tab.id)) return;
        (tab.tasks || []).forEach((task, taskOrder) => {
            const cloned = _cloneBatchTasks([task])[0];
            if (!cloned) return;
            cloned._batchProjection = true;
            cloned._batchTabId = tab.id;
            cloned._batchTabName = tab.name;
            cloned._batchTabOrder = tabOrder;
            cloned._batchTaskOrder = taskOrder;
            mergedTasks.push(cloned);
        });
    });
    _batchTableState.appliedTabIds = ids;
    window._reelsState.tasks = mergedTasks;
    window._reelsState.selectedIdx = -1;
}

function _getProjectedBatchTasksSnapshot() {
    const state = window._reelsState;
    if (!state) return '[]';
    const originalState = window._reelsState;
    const projectedState = {
        ...state,
        tasks: _cloneBatchTasks(state.tasks),
    };
    try {
        window._reelsState = projectedState;
        _applyBatchTableChanges(projectedState, { renderTaskList: false });
        return _batchTasksSnapshot(projectedState.tasks);
    } catch (e) {
        console.warn('[BatchTable] projected snapshot failed:', e);
        return _batchTasksSnapshot(state.tasks);
    } finally {
        window._reelsState = originalState;
    }
}

function _restoreBatchTableOpenSnapshot() {
    const state = window._reelsState;
    if (!state || !_batchTableState.openSnapshotTasks) return;
    try {
        state.tasks = JSON.parse(_batchTableState.openSnapshotTasks);
        if (state.selectedIdx >= state.tasks.length) state.selectedIdx = state.tasks.length - 1;
        if (state.selectedIdx < 0 && state.tasks.length > 0) state.selectedIdx = 0;
        const tab = typeof _getActiveTab === 'function' ? _getActiveTab() : null;
        if (tab) tab.tasks = _cloneBatchTasks(state.tasks);
        if (typeof _renderTaskList === 'function') _renderTaskList();
        _syncSelectedTaskOverlayMgrIfNeeded(state.selectedIdx);
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    } catch (e) {
        console.warn('[BatchTable] restore open snapshot failed:', e);
    }
}

function reelsToggleBatchTable(options = {}) {
    if (!_batchTableState.container) _initBatchTable();
    const saveOnClose = options.saveOnClose !== false;
    _batchTableState.visible = !_batchTableState.visible;
    if (_batchTableState.visible) {
        // 同步当前画布图层到活跃任务
        if (window._reelsState && window._reelsState.selectedIdx >= 0) {
            const curTask = window._reelsState.tasks[window._reelsState.selectedIdx];
            if (curTask && window._reelsState.overlayProxy && window._reelsState.overlayProxy.overlayMgr) {
                if (window._reelsState._coverEditMode && curTask.cover) {
                    curTask.cover.overlays = [...(window._reelsState.overlayProxy.overlayMgr.overlays || [])];
                } else {
                    curTask.overlays = [...(window._reelsState.overlayProxy.overlayMgr.overlays || [])];
                }
            }
        }
        const wasGroupedProjection = _isBatchGroupedProjection(window._reelsState?.tasks || []);
        _batchTableState.openedGroupedProjection = wasGroupedProjection ? {
            tasks: _cloneBatchTasks(window._reelsState.tasks || []),
            appliedTabIds: [...(_batchTableState.appliedTabIds || [])],
            knownTabIds: _batchTableState.tabs.map(tab => tab.id),
            selectedIdx: window._reelsState.selectedIdx,
        } : null;
        // DEBUG
        const _dbg = (window._reelsState?.tasks || []).slice(0, 3).map((t, i) => `[${i}]bgScale=${t.bgScale}`);
        console.log('[BatchTable.toggle] 打开表格，当前 tasks:', _dbg.join(', '));
        // Sync current tasks into active tab on open
        _syncTasksToActiveTab();
        // Snapshot every tab, not just the active tab: switching tabs saves edits eagerly.
        _batchTableState.editSessionSnapshot = {
            tabs: _batchTableState.tabs.map(tab => ({ ...tab, tasks: _cloneBatchTasks(tab.tasks || []) })),
            activeTabId: _batchTableState.activeTabId,
            nextTabId: _batchTableState.nextTabId,
            projectDir: _batchTableState.projectDir,
            projectName: _batchTableState.projectName,
            tasks: _cloneBatchTasks(window._reelsState.tasks || []),
            selectedIdx: window._reelsState.selectedIdx,
            appliedTabIds: [...(_batchTableState.appliedTabIds || [])],
        };
        // Load full tasks list from tab
        const tab = _getActiveTab();
        if (tab) {
            _loadTabTasks(tab);
        }
        _batchTableState.openSnapshotTasks = _batchTasksSnapshot(window._reelsState?.tasks || []);
        _skipNextApply = true;
        _renderBatchTable();
        _batchTableState.container.style.display = 'block';
        _scheduleFitBatchTableToViewport();
    } else {
        if (saveOnClose) {
            _applyBatchTableChanges();
            _syncTasksToActiveTab();
            // 从“外部按组视图”进入表格时，只暂时载入当前标签编辑；
            // 关闭后重新投影全部原分组，不能退化为当前标签的平铺任务。
            if (_batchTableState.openedGroupedProjection) {
                const opened = _batchTableState.openedGroupedProjection;
                const addedIds = _batchTableState.tabs.filter(tab => !(opened.knownTabIds || opened.appliedTabIds).includes(tab.id)).map(tab => tab.id);
                _restoreGroupedProjectionFromTabs([...opened.appliedTabIds, ...addedIds]);
            } else if (_batchTableState.tabs.length > 1) {
                _restoreGroupedProjectionFromTabs(_batchTableState.tabs.map(tab => tab.id));
            }
            if (typeof _renderTaskList === 'function') _renderTaskList();
            _batchTableState.openSnapshotTasks = _batchTasksSnapshot(window._reelsState?.tasks || []);
            console.log('[BatchTable.toggle] 关闭表格，已保存 changes');
            if (window._reelsState?.tasks.length && typeof reelsSelectTask === 'function') {
                const idx = Math.max(0, Math.min(window._reelsState.selectedIdx, window._reelsState.tasks.length - 1));
                window._reelsState.selectedIdx = -1;
                reelsSelectTask(idx);
            }
            _batchAutoSave({ skipSync: true });
        } else {
            const snapshot = _batchTableState.editSessionSnapshot;
            if (snapshot && window._reelsState) {
                _batchTableState.tabs = snapshot.tabs.map(tab => ({ ...tab, tasks: _cloneBatchTasks(tab.tasks || []) }));
                for (const key of ['activeTabId', 'nextTabId', 'projectDir', 'projectName']) _batchTableState[key] = snapshot[key];
                _batchTableState.appliedTabIds = [...snapshot.appliedTabIds];
                _batchTableState.selectedRows = new Set();
                window._reelsState.tasks = _cloneBatchTasks(snapshot.tasks);
                window._reelsState.selectedIdx = snapshot.selectedIdx;
                _skipNextApply = true;
                if (typeof _renderTaskList === 'function') _renderTaskList();
                _syncSelectedTaskOverlayMgrIfNeeded(snapshot.selectedIdx);
                if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                // Replace any interim automatic saves with the opening snapshot.
                _batchAutoSave({ skipSync: true });
            } else {
                _restoreBatchTableOpenSnapshot();
            }
            console.log('[BatchTable.toggle] 关闭表格，已放弃 changes');
        }
        _batchTableState.editSessionSnapshot = null;
        _batchTableState.openedGroupedProjection = null;
        _batchTableState.container.style.display = 'none';
        if (typeof _renderTaskList === 'function') _renderTaskList();
        requestAnimationFrame(() => {
            if (!_batchTableState.visible && window.ReelsPreviewV2?.isOpen()) {
                window.ReelsPreviewV2.recover('batch-table-applied');
            }
        });
    }
}

// ═══════════════════════════════════════════════════════
// 3b. Language list for subtitle alignment
// ═══════════════════════════════════════════════════════

const REELS_LANG_STORAGE_KEY = 'reels_align_language';

const REELS_ALL_LANGUAGES = [
    // ── 常用 ──
    { name: '英语', code: 'en', en: 'English', pinned: true },
    { name: '中文', code: 'zh', en: 'Chinese', pinned: true },
    { name: '日语', code: 'ja', en: 'Japanese', pinned: true },
    { name: '韩语', code: 'ko', en: 'Korean', pinned: true },
    { name: '西班牙语', code: 'es', en: 'Spanish', pinned: true },
    { name: '法语', code: 'fr', en: 'French', pinned: true },
    { name: '德语', code: 'de', en: 'German', pinned: true },
    { name: '葡萄牙语', code: 'pt', en: 'Portuguese', pinned: true },
    { name: '俄语', code: 'ru', en: 'Russian', pinned: true },
    { name: '阿拉伯语', code: 'ar', en: 'Arabic', pinned: true },
    { name: '粤语', code: 'yue', en: 'Cantonese', pinned: true },
    // ── 亚洲 ──
    { name: '印地语', code: 'hi', en: 'Hindi' },
    { name: '泰语', code: 'th', en: 'Thai' },
    { name: '越南语', code: 'vi', en: 'Vietnamese' },
    { name: '印尼语', code: 'id', en: 'Indonesian' },
    { name: '马来语', code: 'ms', en: 'Malay' },
    { name: '泰米尔语', code: 'ta', en: 'Tamil' },
    { name: '泰卢固语', code: 'te', en: 'Telugu' },
    { name: '孟加拉语', code: 'bn', en: 'Bengali' },
    { name: '卡纳达语', code: 'kn', en: 'Kannada' },
    { name: '马拉雅拉姆语', code: 'ml', en: 'Malayalam' },
    { name: '马拉地语', code: 'mr', en: 'Marathi' },
    { name: '古吉拉特语', code: 'gu', en: 'Gujarati' },
    { name: '旁遮普语', code: 'pa', en: 'Punjabi' },
    { name: '僧伽罗语', code: 'si', en: 'Sinhala' },
    { name: '尼泊尔语', code: 'ne', en: 'Nepali' },
    { name: '乌尔都语', code: 'ur', en: 'Urdu' },
    { name: '高棉语', code: 'km', en: 'Khmer' },
    { name: '老挝语', code: 'lo', en: 'Lao' },
    { name: '蒙古语', code: 'mn', en: 'Mongolian' },
    { name: '缅甸语', code: 'my', en: 'Myanmar' },
    { name: '藏语', code: 'bo', en: 'Tibetan' },
    { name: '他加禄语', code: 'tl', en: 'Tagalog' },
    { name: '爪哇语', code: 'jw', en: 'Javanese' },
    { name: '巽他语', code: 'su', en: 'Sundanese' },
    { name: '阿萨姆语', code: 'as', en: 'Assamese' },
    // ── 欧洲 ──
    { name: '意大利语', code: 'it', en: 'Italian' },
    { name: '荷兰语', code: 'nl', en: 'Dutch' },
    { name: '波兰语', code: 'pl', en: 'Polish' },
    { name: '土耳其语', code: 'tr', en: 'Turkish' },
    { name: '瑞典语', code: 'sv', en: 'Swedish' },
    { name: '芬兰语', code: 'fi', en: 'Finnish' },
    { name: '丹麦语', code: 'da', en: 'Danish' },
    { name: '挪威语', code: 'no', en: 'Norwegian' },
    { name: '新挪威语', code: 'nn', en: 'Nynorsk' },
    { name: '捷克语', code: 'cs', en: 'Czech' },
    { name: '斯洛伐克语', code: 'sk', en: 'Slovak' },
    { name: '匈牙利语', code: 'hu', en: 'Hungarian' },
    { name: '罗马尼亚语', code: 'ro', en: 'Romanian' },
    { name: '保加利亚语', code: 'bg', en: 'Bulgarian' },
    { name: '希腊语', code: 'el', en: 'Greek' },
    { name: '乌克兰语', code: 'uk', en: 'Ukrainian' },
    { name: '白俄罗斯语', code: 'be', en: 'Belarusian' },
    { name: '克罗地亚语', code: 'hr', en: 'Croatian' },
    { name: '塞尔维亚语', code: 'sr', en: 'Serbian' },
    { name: '斯洛文尼亚语', code: 'sl', en: 'Slovenian' },
    { name: '立陶宛语', code: 'lt', en: 'Lithuanian' },
    { name: '拉脱维亚语', code: 'lv', en: 'Latvian' },
    { name: '爱沙尼亚语', code: 'et', en: 'Estonian' },
    { name: '马其顿语', code: 'mk', en: 'Macedonian' },
    { name: '波斯尼亚语', code: 'bs', en: 'Bosnian' },
    { name: '阿尔巴尼亚语', code: 'sq', en: 'Albanian' },
    { name: '冰岛语', code: 'is', en: 'Icelandic' },
    { name: '马耳他语', code: 'mt', en: 'Maltese' },
    { name: '卢森堡语', code: 'lb', en: 'Luxembourgish' },
    { name: '法罗语', code: 'fo', en: 'Faroese' },
    { name: '加泰罗尼亚语', code: 'ca', en: 'Catalan' },
    { name: '加利西亚语', code: 'gl', en: 'Galician' },
    { name: '巴斯克语', code: 'eu', en: 'Basque' },
    { name: '奥克语', code: 'oc', en: 'Occitan' },
    { name: '布列塔尼语', code: 'br', en: 'Breton' },
    { name: '威尔士语', code: 'cy', en: 'Welsh' },
    // ── 中东/中亚 ──
    { name: '波斯语', code: 'fa', en: 'Persian' },
    { name: '希伯来语', code: 'he', en: 'Hebrew' },
    { name: '亚美尼亚语', code: 'hy', en: 'Armenian' },
    { name: '格鲁吉亚语', code: 'ka', en: 'Georgian' },
    { name: '阿塞拜疆语', code: 'az', en: 'Azerbaijani' },
    { name: '哈萨克语', code: 'kk', en: 'Kazakh' },
    { name: '乌兹别克语', code: 'uz', en: 'Uzbek' },
    { name: '土库曼语', code: 'tk', en: 'Turkmen' },
    { name: '塔吉克语', code: 'tg', en: 'Tajik' },
    { name: '普什图语', code: 'ps', en: 'Pashto' },
    { name: '信德语', code: 'sd', en: 'Sindhi' },
    { name: '鞑靼语', code: 'tt', en: 'Tatar' },
    { name: '巴什基尔语', code: 'ba', en: 'Bashkir' },
    // ── 非洲 ──
    { name: '南非荷兰语', code: 'af', en: 'Afrikaans' },
    { name: '斯瓦希里语', code: 'sw', en: 'Swahili' },
    { name: '约鲁巴语', code: 'yo', en: 'Yoruba' },
    { name: '豪萨语', code: 'ha', en: 'Hausa' },
    { name: '索马里语', code: 'so', en: 'Somali' },
    { name: '绍纳语', code: 'sn', en: 'Shona' },
    { name: '阿姆哈拉语', code: 'am', en: 'Amharic' },
    { name: '林加拉语', code: 'ln', en: 'Lingala' },
    { name: '马达加斯加语', code: 'mg', en: 'Malagasy' },
    // ── 其他 ──
    { name: '拉丁语', code: 'la', en: 'Latin' },
    { name: '梵语', code: 'sa', en: 'Sanskrit' },
    { name: '毛利语', code: 'mi', en: 'Maori' },
    { name: '夏威夷语', code: 'haw', en: 'Hawaiian' },
    { name: '海地克里奥尔语', code: 'ht', en: 'Haitian Creole' },
    { name: '意第绪语', code: 'yi', en: 'Yiddish' },
];

function _initLangPicker(container) {
    const btn = container.querySelector('#rbt-lang-picker-btn');
    const dropdown = container.querySelector('#rbt-lang-dropdown');
    const searchInput = container.querySelector('#rbt-lang-search');
    const listEl = container.querySelector('#rbt-lang-list');
    const hiddenInput = container.querySelector('#rbt-align-lang');
    if (!btn || !dropdown || !listEl || !hiddenInput) return;

    // Restore saved language
    const savedLang = localStorage.getItem(REELS_LANG_STORAGE_KEY);
    if (savedLang) {
        const found = REELS_ALL_LANGUAGES.find(l => l.name === savedLang);
        if (found) {
            hiddenInput.value = found.name;
            btn.textContent = found.name + ' ▾';
        }
    }

    const renderList = (filter = '') => {
        const q = filter.toLowerCase().trim();
        const filtered = q
            ? REELS_ALL_LANGUAGES.filter(l =>
                l.name.includes(q) || l.en.toLowerCase().includes(q) || l.code.includes(q))
            : REELS_ALL_LANGUAGES;

        // Pinned first, then the rest
        const pinned = filtered.filter(l => l.pinned);
        const rest = filtered.filter(l => !l.pinned);
        const sorted = [...pinned, ...rest];

        listEl.innerHTML = sorted.map(l => `
            <div class="rbt-lang-item" data-name="${l.name}"
                 style="padding:6px 12px;cursor:pointer;font-size:12px;color:#ccc;
                        border-bottom:1px solid rgba(255,255,255,0.04);
                        display:flex;justify-content:space-between;align-items:center;
                        ${hiddenInput.value === l.name ? 'background:rgba(0,212,255,0.12);color:var(--accent);' : ''}
                        ${l.pinned ? 'font-weight:600;' : ''}">
                <span>${l.name}</span>
                <span style="font-size:10px;color:#666;">${l.en}</span>
            </div>
        `).join('');

        if (sorted.length === 0) {
            listEl.innerHTML = '<div style="padding:12px;text-align:center;color:#555;font-size:11px;">未找到匹配语言</div>';
        }
    };

    // Toggle dropdown
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.style.display !== 'none';
        dropdown.style.display = isOpen ? 'none' : 'block';
        if (!isOpen) {
            searchInput.value = '';
            renderList();
            setTimeout(() => searchInput.focus(), 30);
        }
    });

    // Search filter
    searchInput.addEventListener('input', () => {
        renderList(searchInput.value);
    });
    searchInput.addEventListener('click', (e) => e.stopPropagation());

    // Click item
    listEl.addEventListener('click', (e) => {
        const item = e.target.closest('.rbt-lang-item');
        if (!item) return;
        const name = item.dataset.name;
        hiddenInput.value = name;
        btn.textContent = name + ' ▾';
        dropdown.style.display = 'none';
        // Persist
        localStorage.setItem(REELS_LANG_STORAGE_KEY, name);
    });

    // Hover effect
    listEl.addEventListener('mouseover', (e) => {
        const item = e.target.closest('.rbt-lang-item');
        if (item) item.style.background = 'rgba(255,255,255,0.08)';
    });
    listEl.addEventListener('mouseout', (e) => {
        const item = e.target.closest('.rbt-lang-item');
        if (item) item.style.background = hiddenInput.value === item.dataset.name ? 'rgba(0,212,255,0.12)' : '';
    });

    // Click outside to close
    document.addEventListener('click', (e) => {
        if (!container.querySelector('#rbt-lang-picker-wrap')?.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });
}

// ═══════════════════════════════════════════════════════
// 4. Render the batch table
// ═══════════════════════════════════════════════════════

let _isRenderingBatchTable = false; // 防止 _applyBatchTableChanges 与 _renderBatchTable 互相触发
let _skipNextApply = false; // 粘贴等操作已直接写入 state，跳过 DOM→state 同步防止旧值覆盖
let _skipNextBatchAutoSave = false; // 大量制作/切换标签已直接写入 tab，跳过一次渲染期自动同步
let _batchTableResizeBound = false;

function _fitBatchTableToViewport() {
    const container = _batchTableState.container;
    if (!container || container.style.display === 'none') return;

    const panel = container.querySelector('.rbt-panel');
    const tableWrap = container.querySelector('.rbt-table-wrap');
    if (!panel || !tableWrap) return;

    const viewportH = window.innerHeight || document.documentElement.clientHeight || 800;
    const cs = window.getComputedStyle ? getComputedStyle(container) : null;
    const padTop = cs ? parseFloat(cs.paddingTop) || 0 : 16;
    const padBottom = cs ? parseFloat(cs.paddingBottom) || 0 : 16;
    const panelMaxH = Math.max(320, viewportH - padTop - padBottom);
    const actionsPanel = panel.querySelector('.rbt-actions-panel');
    if (actionsPanel && getComputedStyle(actionsPanel).display !== 'none') {
        const actionsMaxH = Math.max(120, Math.min(360, Math.floor(panelMaxH * 0.42)));
        actionsPanel.style.maxHeight = `${actionsMaxH}px`;
    }

    const fixedParts = [
        panel.querySelector('.rbt-tabbar'),
        panel.querySelector('.rbt-header'),
        actionsPanel,
        panel.querySelector('.rbt-footer'),
    ];
    const fixedHeight = fixedParts.reduce((sum, el) => {
        if (!el || getComputedStyle(el).display === 'none') return sum;
        return sum + el.getBoundingClientRect().height;
    }, 0);

    const tableMaxH = Math.max(120, panelMaxH - fixedHeight - 8);
    panel.style.maxHeight = `${panelMaxH}px`;
    tableWrap.style.maxHeight = `${tableMaxH}px`;
}

function _scheduleFitBatchTableToViewport() {
    requestAnimationFrame(() => _fitBatchTableToViewport());
}

function _renderBatchTable() {
  try {
    let container = _batchTableState.container;
    const state = window._reelsState;
    if (!state) return;

    // Ensure IDs and unique names
    (state.tasks || []).forEach(t => _ensureTaskId(t));
    _resolveDuplicateTaskNames(state.tasks);

    // ── 重绘前先保存所有输入框的值到 task 对象，防止未保存内容丢失 ──
    // 但如果是粘贴操作刚直接写过 state，就跳过，避免旧 DOM 值覆盖新数据
    if (_skipNextApply) {
        _skipNextApply = false;
    } else if (!_isRenderingBatchTable) {
        _isRenderingBatchTable = true;
        try { _applyBatchTableChanges(); } catch (e) { console.warn('[BatchTable] applyChanges error:', e); }
        _isRenderingBatchTable = false;
    }

    // ── 保存滚动位置（在 innerHTML 销毁前） ──
    const oldScrollWrap = container.querySelector('.rbt-table-wrap');
    const _savedScrollTop = oldScrollWrap ? oldScrollWrap.scrollTop : 0;
    const _savedScrollLeft = oldScrollWrap ? oldScrollWrap.scrollLeft : 0;

    // _renderBatchTable 会反复重建表格内容，并在 container 上挂委托事件。
    // 重绘前替换为干净节点，避免分段/重绘多次后监听器叠加导致卡死或白屏。
    if (container && container.parentNode) {
        const freshContainer = container.cloneNode(false);
        container.parentNode.replaceChild(freshContainer, container);
        _batchTableState.container = freshContainer;
        container = freshContainer;
    }

    // DEBUG: 追踪 bgScale 持久化
    const _dbgScales = (state.tasks || []).slice(0, 3).map((t, i) => `[${i}] bgScale=${t.bgScale} bgDur=${t.bgDurScale} audioDur=${t.audioDurScale}`);
    console.log('[BatchTable._renderBatchTable] 渲染前 task scales:', _dbgScales.join(', '));

    // 自动保存当前配置到 localStorage
    if (_skipNextBatchAutoSave) {
        _skipNextBatchAutoSave = false;
    } else {
        _batchAutoSave();
    }
    const tasks = state.tasks || [];
    const selectedInsertTasks = [...(_batchTableState.selectedRows || [])].map(index => tasks[index]).filter(Boolean);
    const insertFolderTasks = selectedInsertTasks.length ? selectedInsertTasks : tasks.filter(task => task.insertMediaFolder);
    const insertFolders = [...new Set(insertFolderTasks.map(task => task.insertMediaFolder).filter(Boolean))];
    const insertFolderLabel = insertFolders.length === 0
        ? '未选插入文件夹'
        : insertFolders.length === 1
            ? `📁 ${_escHtml(_shortName(insertFolders[0]))} · ${insertFolderTasks[0]?.insertMediaFiles?.length || 0} 个素材`
            : `⚠️ 已选任务使用 ${insertFolders.length} 个不同文件夹`;

    // ── 自动校验与初始化当前活跃的覆层图层 ──
    const templateTask = state.tasks[state.selectedIdx] || state.tasks[0];
    const textcards = templateTask ? (templateTask.overlays || []).filter(o => o && !o.fixed_text && (o.type === 'textcard' || !o.type || o.type === '')) : [];
    const scrolls = templateTask ? (templateTask.overlays || []).filter(o => o && !o.fixed_text && o.type === 'scroll') : [];

    const activeTextcards = textcards.length > 0 ? textcards : [{ id: 'default', name: '卡片1' }];
    const activeScrolls = scrolls.length > 0 ? scrolls : [{ id: 'default', name: '滚动1' }];

    if (textcards.length > 0) {
        let currentActive = textcards.find(o => o.id === _batchTableState._activeTextcardId);
        if (!currentActive && _batchTableState._activeTextcardName) {
            currentActive = textcards.find(o => o.name === _batchTableState._activeTextcardName);
        }
        if (!currentActive) {
            currentActive = textcards[0];
        }
        _batchTableState._activeTextcardId = currentActive.id || null;
        _batchTableState._activeTextcardName = currentActive.name || '';
        _batchTableState._activeTextcardIdx = textcards.indexOf(currentActive);
    } else {
        _batchTableState._activeTextcardId = null;
        _batchTableState._activeTextcardName = '';
        _batchTableState._activeTextcardIdx = 0;
    }

    if (scrolls.length > 0) {
        let currentActive = scrolls.find(o => o.id === _batchTableState._activeScrollId);
        if (!currentActive && _batchTableState._activeScrollName) {
            currentActive = scrolls.find(o => o.name === _batchTableState._activeScrollName);
        }
        if (!currentActive) {
            currentActive = scrolls[0];
        }
        _batchTableState._activeScrollId = currentActive.id || null;
        _batchTableState._activeScrollName = currentActive.name || '';
        _batchTableState._activeScrollIdx = scrolls.indexOf(currentActive);
    } else {
        _batchTableState._activeScrollId = null;
        _batchTableState._activeScrollName = '';
        _batchTableState._activeScrollIdx = 0;
    }
    const activeTab = _getActiveTab();
    const exportNamingMode = localStorage.getItem('reels_naming_mode') || 'text';

    // 获取已保存的卡片模板列表
    const cardTemplates = _getOverlayGroupPresetList();
    const subtitlePresets = _getSubtitlePresetList();

    // 标签栏 HTML
    const tabsHtml = _batchTableState.tabs.map(tab => {
        const isActive = tab.id === _batchTableState.activeTabId;
        return `<div class="rbt-tab ${isActive ? 'rbt-tab-active' : ''}" data-tab-id="${tab.id}">
            <span class="rbt-tab-name" title="双击重命名">${_escHtml(tab.name)}</span>
            ${_batchTableState.tabs.length > 1 ? `<span class="rbt-tab-close" data-tab-id="${tab.id}" title="关闭标签">×</span>` : ''}
        </div>`;
    }).join('');

    // 素材文件夹信息
    const matDir = activeTab.materialDir || '';
    const matDirShort = matDir ? matDir.split(/[\\/]/).slice(-2).join('/') : '';
    const lastRefresh = activeTab.lastRefreshTime ? new Date(activeTab.lastRefreshTime).toLocaleTimeString() : '';

    // 批量选择子模板选项
    const batchSubOpts = _renderSubtitlePresetOptions(subtitlePresets, '');
    const batchCardOpts = _renderOverlayPresetOptions(cardTemplates, '');

    container.innerHTML = `
        <div class="rbt-panel">
            <!-- ═══ 标签栏与工程管理 ═══ -->
            <div class="rbt-tabbar">
                <div class="rbt-tabs-scroll">
                    ${tabsHtml}
                    <div class="rbt-tab rbt-tab-add" title="新建标签页">＋</div>
                    <div class="rbt-tab rbt-tab-clear-all" title="清空删除所有标签页" style="color:#f66;font-size:11px;margin-left:4px;">🗑 清空</div>
                    <div class="rbt-tab rbt-tab-merge" id="rbt-merge-tabs-btn" title="将多个标签页的任务合并到当前渲染队列" style="color:#7b8bef;font-size:11px;margin-left:4px;cursor:pointer;border:1px solid rgba(123,139,239,0.3);background:rgba(123,139,239,0.1);">📋 应用标签页</div>
                </div>
            </div>

            <!-- ═══ Body Split: Media Sidebar + Main Content ═══ -->
            <div class="rbt-body-row">

            ${_batchTableState.mediaPoolOpen ? `
            <!-- ═══ LEFT: Media Pool Sidebar ═══ -->
            <div class="rbt-media-sidebar" id="rbt-media-sidebar">
                <div class="rbt-ms-header">
                    <span style="font-weight:bold; color:var(--accent-color); font-size:13px;">🗃️ 素材池</span>
                    <button id="rbt-close-media-sidebar" class="rbt-btn" style="padding:1px 6px; font-size:10px; background:#3a2020; border-color:#5a3030; color:#f87171;">✕</button>
                </div>
                <div class="rbt-ms-resize-handle" id="rbt-ms-resize"></div>
                <div class="rbt-ms-actions">
                    <button class="rbt-btn rbt-ms-btn" id="rbt-ms-import-files" title="选择多个文件">📄 文件</button>
                    <button class="rbt-btn rbt-ms-btn" id="rbt-ms-import-folder" title="选择文件夹，拆散其中所有文件">📁 目录</button>
                    <button class="rbt-btn rbt-ms-btn" id="rbt-ms-import-groups" title="选择总文件夹；一级子文件夹各生成一行任务">📦 素材组</button>
                    <button class="rbt-btn rbt-ms-btn" id="rbt-ms-import-seq" title="整个目录作为一个序列帧素材">🎞️ 序列帧</button>
                </div>
                <div class="rbt-ms-linked-dir">
                    <div style="font-size:10px; color:var(--text-muted); font-weight:bold; margin-bottom:4px;">🔗 绑定文件夹</div>
                    <div style="display:flex; gap:4px; align-items:center;">
                        <span id="rbt-ms-dir-path" style="flex:1; font-size:10px; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${_escHtml(matDir)}">${matDirShort || '<i style="color:var(--text-muted)">未绑定</i>'}</span>
                        <button class="rbt-btn" id="rbt-ms-select-dir" style="padding:1px 6px; font-size:9px;">📂</button>
                        <button class="rbt-btn" id="rbt-ms-refresh-dir" style="padding:1px 6px; font-size:9px; background:#1a3a2a; border-color:#2a5a3a; color:#8f8;" ${!matDir ? 'disabled' : ''}>🔄</button>
                    </div>
                    ${lastRefresh ? `<div style="font-size:9px; color:var(--text-muted); margin-top:2px;">上次: ${lastRefresh}</div>` : ''}
                </div>
                <div class="rbt-ms-collapsible-header" id="rbt-ms-toggle-filters" title="点击折叠/展开分类">
                    <span class="rbt-ms-toggle-icon" id="rbt-ms-toggle-icon">▾</span>
                    <span style="font-size:10px;font-weight:bold;color:var(--text-secondary);">分类 & 角色</span>
                    <span style="flex:1;"></span>
                    <span style="font-size:9px;color:var(--text-muted);">点击折叠</span>
                </div>
                <div class="rbt-ms-collapsible-body" id="rbt-ms-filters-body">
                <div class="rbt-ms-filters" id="rbt-ms-filter-list">
                    <div class="rbt-ms-filter active" data-filter="all">📁 全部 <span class="rbt-ms-count">(0)</span></div>
                    <div class="rbt-ms-section">[ 视觉 ]</div>
                    <div class="rbt-ms-filter" data-filter="bg">🖼️ 背景</div>
                    <div class="rbt-ms-filter" data-filter="overlay">🎬 覆层</div>
                    <div class="rbt-ms-filter" data-filter="hook">🪝 钩子</div>
                    <div class="rbt-ms-filter" data-filter="universal">♾️ 通用</div>
                    <div class="rbt-ms-section">[ 音频 ]</div>
                    <div class="rbt-ms-filter" data-filter="voice">🎙 人声</div>
                    <div class="rbt-ms-filter" data-filter="bgm">🎵 配乐</div>
                    <div class="rbt-ms-section">[ 文本 ]</div>
                    <div class="rbt-ms-filter" data-filter="text">📝 字幕</div>
                </div>
                <div class="rbt-ms-bulk">
                    <select class="rbt-select" id="rbt-ms-bulk-role" style="width:100%; height:24px; font-size:11px;">
                        <option value="">-- 批量改角色 --</option>
                        <option value="bg">🖼 背景素材</option>
                        <option value="overlay">🎬 内容视频</option>
                        <option value="hook">🪝 钩子视频</option>
                        <option value="universal">♾️ 通用视觉</option>
                        <option value="voice">🎙 人声配音</option>
                        <option value="bgm">🎵 全局配乐</option>
                    </select>
                    <button class="rbt-btn" id="rbt-ms-apply-bulk" style="width:100%; margin-top:4px; font-size:11px;">应用角色</button>
                </div>
                </div>
                <div class="rbt-ms-pool" id="rbt-ms-pool">
                    <div style="color:var(--text-muted); font-size:12px; text-align:center; padding:20px 8px;">
                        📥 拖拽文件到此处<br>或点击上方按钮导入
                    </div>
                </div>
                <div class="rbt-ms-footer">
                    <button class="rbt-btn" id="rbt-ms-clear" style="width:100%; border-color:rgba(239,68,68,0.3); color:#f87171; font-size:11px;">🧹 清空素材池</button>
                </div>
            </div>
            ` : ''}

            <!-- ═══ RIGHT: Main Task Content ═══ -->
            <div class="rbt-main-col">

            <div class="rbt-header" style="display:flex; align-items:center; padding:4px 12px; gap:8px; height:auto; min-height:auto; max-height:none; flex-direction:row;">
                <button id="rbt-toggle-actions-btn" class="rbt-btn" style="padding:2px 8px;font-size:11px;" title="隐藏/显示操作面板">${_batchTableState.actionsCollapsed ? '🔽 展开操作面板' : '🔼 收起操作面板'}</button>
                <span style="flex:1;"></span>
                ${!_batchTableState.mediaPoolOpen && matDir ? `<span style="font-size:10px; color:var(--text-muted);">📁 ${_escHtml(matDirShort)}</span>` : ''}
                <div style="display:flex; align-items:center; gap:6px; min-width:0;">
                    <span style="font-size:11px;color:#888;">📦 当前工程:</span>
                    <span id="rbt-project-mgr-btn" style="font-size:12px;color:var(--accent);cursor:pointer;text-decoration:underline;font-weight:bold;" title="点击设置保存目录与管理多工程">${_escHtml(_batchTableState.projectName || 'UntitledProject.json')}</span>
                </div>
            </div>

            <div class="rbt-actions-panel" style="display:${_batchTableState.actionsCollapsed ? 'none' : 'flex'};">
                <div id="rbt-actions-wrapper" style="display:flex; flex-direction:column; gap:0;">
                
                    <!-- === 1. 工程管理 / 数据录入 === -->
                    <div class="rbt-actions rbt-group-project" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:6px; margin-bottom:6px;">
                        <span style="font-size:11px;color:var(--text-secondary);font-weight:bold;margin-right:4px;">工程与数据:</span>
                        <span class="rbt-batch-rowbreak"></span>
                        <span class="rbt-batch-subgroup">工程管理</span>
                        <button class="rbt-btn" id="rbt-add-row-btn" style="padding:2px 8px;font-size:11px;background:rgba(40,80,40,0.6);border:1px solid rgba(80,180,80,0.3);color:#a0e0b0;">添加行</button>
                        <button class="rbt-btn" id="rbt-clear-btn" style="padding:2px 8px;font-size:11px;background:rgba(120,40,40,0.6);border:1px solid rgba(220,80,80,0.3);color:#f48484;" title="清空全部">清空</button>
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <button class="rbt-btn rbt-btn-primary" id="rbt-save-queue-btn">保存队列</button>
                        <button class="rbt-btn" id="rbt-load-queue-btn">调用队列</button>
                        <button class="rbt-btn" id="rbt-cloud-settings-btn">转录 API · Groq / Gladia</button>
                        <button class="rbt-btn" id="rbt-save-config-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="只保存当前标签页的工程和任务">保存当前工程</button>
                        <button class="rbt-btn" id="rbt-save-all-config-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="保存所有标签页的工程和任务">保存全部工程</button>
                        <button class="rbt-btn" id="rbt-load-config-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">加载工程</button>
                        <button class="rbt-btn" id="rbt-relocate-btn" style="padding:2px 8px;font-size:11px;background:rgba(60,60,120,0.5);border:1px solid rgba(100,100,200,0.3);color:#a0a0e0;" title="查找并重新关联缺失的素材文件">🔍 查找素材</button>
                        <input type="file" id="rbt-file-config" class="rbt-hidden-input" accept=".json">
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <button class="rbt-btn" id="rbt-col-settings-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">列设置</button>
                        <button class="rbt-btn" id="rbt-close-btn" style="padding:2px 8px;font-size:11px;background:rgba(120,40,40,0.6);border:1px solid rgba(220,80,80,0.3);color:#f48484;" title="放弃本次打开表格后的修改">关闭不保存</button>
                        <span class="rbt-batch-rowbreak"></span>
                        <span class="rbt-batch-subgroup">数据录入</span>
                        <button id="rbt-open-media-pool-btn" class="rbt-btn" style="background:${_batchTableState.mediaPoolOpen ? 'rgba(50,70,160,0.6)' : 'rgba(40,60,120,0.6)'}; color:#9bb0ff; border:1px solid rgba(80,120,220,0.3); font-size:11px; padding:2px 8px;">${_batchTableState.mediaPoolOpen ? '收起素材池' : '打开素材池'}</button>
                        <button class="rbt-btn" id="rbt-cycle-fill-btn" style="background:rgba(255,255,255,0.05); color:#ccc; border:1px solid rgba(255,255,255,0.1); padding:2px 8px; font-size:11px;" title="打开素材循环填充面板">素材使用设置</button>
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <span style="font-size:11px;color:#888;">导出命名规则</span>
                        <select id="reels-naming-mode" class="rbt-select" style="width:150px;height:24px;font-size:11px;padding:0 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="自定义命名使用每行“导出命名”列；该列为空时会继续按默认回退规则生成">
                            <option value="custom" ${exportNamingMode === 'custom' ? 'selected' : ''}>自定义命名</option>
                            <option value="text" ${exportNamingMode === 'text' ? 'selected' : ''}>默认文案</option>
                            <option value="background" ${exportNamingMode === 'background' ? 'selected' : ''}>背景素材名</option>
                            <option value="audio" ${exportNamingMode === 'audio' ? 'selected' : ''}>人声-音频文件名</option>
                            <option value="card" ${exportNamingMode === 'card' ? 'selected' : ''}>默认 Card 名</option>
                            <option value="index" ${exportNamingMode === 'index' ? 'selected' : ''}>纯序号 (1, 2, 3...)</option>
                            <option value="date-auto" ${exportNamingMode === 'date-auto' ? 'selected' : ''}>按日期自动排序</option>
                        </select>
                        <button id="reels-naming-config-btn" style="display:${(exportNamingMode === 'index' || exportNamingMode === 'date-auto') ? 'inline-block' : 'none'};background:none;border:none;color:#aaa;cursor:pointer;font-size:11px;padding:0;margin-left:2px;" title="配置命名规则">⚙️</button>
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <button class="rbt-btn" id="rbt-paste-txtcontent" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="从剪贴板粘贴到人声-断行文案列">粘贴人声-断行文案</button>
                        ${textcards.length > 0 ? textcards.map((ov, oIdx) => `
                            <button class="rbt-btn rbt-paste-card-btn" data-card-id="${ov.id}" data-card-idx="${oIdx}" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="从 Google 表格粘贴文案到该卡片(支持标题/内容/结尾多列格式)">粘贴覆层文案-${_escHtml(ov.name || `卡片${oIdx + 1}`)}</button>
                        `).join('') : `
                            <button class="rbt-btn rbt-paste-card-btn" data-card-id="" data-card-idx="0" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="从 Google 表格粘贴文案并自动创建卡片">粘贴覆层文案</button>
                        `}
                        ${scrolls.length > 0 ? scrolls.map((ov, oIdx) => `
                            <button class="rbt-btn rbt-paste-scroll-btn-tiled" data-scroll-id="${ov.id}" data-scroll-idx="${oIdx}" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="从 Google 表格批量粘贴滚动字幕到该图层">粘贴滚动字幕-${_escHtml(ov.name || `滚动${oIdx + 1}`)}</button>
                        `).join('') : `
                            <button class="rbt-btn rbt-paste-scroll-btn-tiled" data-scroll-id="" data-scroll-idx="0" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="从 Google 表格粘贴滚动字幕并自动创建滚动层">粘贴滚动字幕</button>
                        `}
                        <button class="rbt-btn" id="rbt-paste-clip-ab" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="A/B双版文案">粘贴剪辑文案 (A/B版)</button>
                        <button class="rbt-btn" id="rbt-bulk-create-btn" style="padding:2px 8px;font-size:11px;background:rgba(124,92,255,0.15);border:1px solid rgba(124,92,255,0.3);color:#b8a0ff;font-weight:600;" title="类似Canva大量制作：表格数据 × 覆层模板 = 批量任务">🧩 大量制作</button>
                        <button class="rbt-btn" id="rbt-import-material-groups-btn" style="padding:2px 8px;font-size:11px;background:rgba(76,158,255,0.12);border:1px solid rgba(76,158,255,0.3);color:#8fc7ff;" title="选择总文件夹；一级子文件夹各生成一行：音频 + 多视频拼接循环">📦 导入素材组</button>
                        <button class="rbt-btn" id="rbt-insert-folder-btn" style="padding:2px 8px;font-size:11px;background:rgba(16,185,129,.14);border:1px solid rgba(16,185,129,.35);color:#86efac;" title="给勾选任务设置同一个插入素材文件夹">📁 插入素材文件夹</button>
                        <span style="font-size:11px;color:#fde68a;">插入时长</span>
                        <select id="rbt-insert-duration-mode" style="height:22px;font-size:10px;">
                            <option value="fixed" ${_batchTableState.insertDurationRule?.mode !== 'silence' ? 'selected' : ''}>固定</option>
                            <option value="silence" ${_batchTableState.insertDurationRule?.mode === 'silence' ? 'selected' : ''}>按停顿自动</option>
                        </select>
                        <input id="rbt-insert-duration-fixed" type="number" min="0.05" max="120" step="0.05" value="${_batchTableState.insertDurationRule?.fixedDuration ?? 3}" style="width:43px;height:18px;font-size:10px;">s
                        <span id="rbt-insert-duration-max-wrap" style="display:${_batchTableState.insertDurationRule?.mode === 'silence' ? 'inline-flex' : 'none'};align-items:center;gap:3px;font-size:10px;color:#ccc;">最长 <input id="rbt-insert-duration-max" type="number" min="0.05" max="120" step="0.05" value="${_batchTableState.insertDurationRule?.maxDuration ?? 3}" style="width:43px;height:18px;font-size:10px;">s</span>
                        <button class="rbt-btn" id="rbt-insert-silence-btn" style="padding:2px 8px;font-size:11px;background:rgba(251,191,36,.14);border:1px solid rgba(251,191,36,.35);color:#fde68a;" title="按勾选任务各自的停顿点批量插入素材">⏸ 批量停顿插入</button>
                        <span id="rbt-insert-folder-status" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:${insertFolders.length > 1 ? '#fbbf24' : insertFolders.length ? '#86efac' : '#888'};" title="${insertFolders.length === 1 ? _escHtml(insertFolders[0]) : ''}">${insertFolderLabel}</span>
                    </div>

                    <!-- === 4. 批量参数总设置 (Scaling / Content Video / Blur) === -->
                    <div class="rbt-actions rbt-group-batch-settings" style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:6px; margin-bottom:6px;">
                        <span style="font-size:11px;color:var(--text-secondary);font-weight:bold;margin-right:4px;">批量参数总设置:</span>
                        <span class="rbt-batch-rowbreak"></span>
                        <span class="rbt-batch-subgroup">基础</span>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置选中行的自定义时长；留空表示自动">时长(s)
                            <input type="number" id="rbt-batch-duration" min="0" max="600" step="0.5" placeholder="自动" style="width:52px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;">
                        </label>
                        <button class="rbt-btn" id="rbt-apply-batch-basic" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">应用基础</button>
                        <span style="color:rgba(255,255,255,.2);">|</span><span style="font-size:11px;color:#86efac;">插入音频</span>
                        <select id="rbt-batch-insert-audio-mode" style="height:22px;font-size:10px;"><option value="keep-main">保留主音</option><option value="mix">混入原音</option><option value="mute">静音</option></select>
                        <input id="rbt-batch-insert-audio-volume" type="number" min="0" max="200" value="0" style="width:42px;height:18px;font-size:10px;">%
                        <button class="rbt-btn" id="rbt-apply-batch-insert-audio" style="padding:2px 8px;font-size:11px;">应用插入音频</button>
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <span class="rbt-batch-subgroup">配乐</span>
                        <button class="rbt-btn" id="rbt-set-bgm-btn" style="padding:2px 8px;font-size:11px;background:rgba(155,89,182,0.15);border:1px solid rgba(155,89,182,0.3);color:#b8a0ff;margin-right:4px;" title="批量设置同一个本地配乐文件到勾选配乐框（或全部）的行">批量设置配乐文件</button>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置配乐音量；留空表示不改">配乐音量
                            <input type="number" id="rbt-batch-bgmvol" min="0" max="1000" step="5" placeholder="%" style="width:45px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;">
                        </label>
                        <button class="rbt-btn" id="rbt-apply-batch-bgm" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">应用配乐</button>
                        <span class="rbt-batch-rowbreak"></span>
                        <span class="rbt-batch-subgroup">字幕时间</span>
                        <select id="rbt-batch-subtime-mode" class="rbt-select" style="width:70px;height:20px;font-size:11px;padding:0 2px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="批量设置字幕时间">
                            <option value="keep">保持</option>
                            <option value="full">全时段</option>
                            <option value="split">分段</option>
                        </select>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="字幕时间分段秒数，仅在选择“分段”时生效">切换
                            <input type="number" id="rbt-batch-subtime-split" min="0.1" step="0.5" placeholder="s" style="width:48px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;">
                        </label>
                        <button class="rbt-btn" id="rbt-apply-batch-subtime" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">应用字幕时间</button>
                        <span class="rbt-batch-rowbreak"></span>
                        <span class="rbt-batch-subgroup">背景</span>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置选中行的背景图片缩放">BG
                            <input type="number" id="rbt-batch-bgscale" min="50" max="300" value="100" step="5" style="width:45px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;"> %
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置选中行的背景素材时长缩放">BG时长
                            <input type="number" id="rbt-batch-bgdurscale" min="10" max="500" value="100" step="5" style="width:45px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;"> %
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置背景视频音量；留空表示不改">BG音量
                            <input type="number" id="rbt-batch-bgvol" min="0" max="1000" step="5" placeholder="%" style="width:45px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;">
                        </label>
                        <button class="rbt-btn" id="rbt-apply-batch-bg" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">应用背景</button>
                        <span class="rbt-batch-rowbreak"></span>
                        <span class="rbt-batch-subgroup">人声</span>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置选中行的人声-音频变速/时长缩放">人声变速
                            <input type="number" id="rbt-batch-audiodurscale" min="10" max="500" value="100" step="5" style="width:45px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;"> %
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置人声音量；留空表示不改">人声音量
                            <input type="number" id="rbt-batch-voicevol" min="0" max="1000" step="5" placeholder="%" style="width:45px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;">
                        </label>
                        <button class="rbt-btn" id="rbt-apply-batch-scale" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">应用人声</button>
                        <span class="rbt-batch-rowbreak"></span>
                        <span class="rbt-batch-subgroup">内容视频</span>
                        <button class="rbt-btn" id="rbt-batch-bg-to-cv" style="padding:2px 8px;font-size:11px;background:rgba(0,188,212,0.15);border:1px solid rgba(0,188,212,0.3);color:#80deea;" title="将勾选行的背景素材路径复制到内容视频">背景用于内容视频</button>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置选中行的内容视频缩放">视频缩放
                            <input type="number" id="rbt-batch-cvscale" min="10" max="300" value="100" step="5" style="width:45px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;"> %
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置内容视频时间段起点；留空表示不改，填 0 可从开头开始">起
                            <input type="number" id="rbt-batch-cvtrim-start" min="0" step="0.1" placeholder="s" style="width:48px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;">
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置内容视频时间段终点；留空表示不改">止
                            <input type="number" id="rbt-batch-cvtrim-end" min="0" step="0.1" placeholder="s" style="width:48px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;">
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置内容视频裁切范围：左,上,宽,高，单位百分比；留空表示不改">裁切
                            <input type="text" id="rbt-batch-cvcrop" placeholder="0,0,100,100" style="width:92px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;">
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置内容视频 X 位置；留空表示不改，可填 center 或像素值">X
                            <input type="text" id="rbt-batch-cvx" placeholder="center" style="width:55px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;">
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置内容视频 Y 位置；留空表示不改，可填 center 或像素值">Y
                            <input type="text" id="rbt-batch-cvy" placeholder="center" style="width:55px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;">
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置内容视频音量；留空表示不改">视频音量
                            <input type="number" id="rbt-batch-cvvol" min="0" max="1000" step="5" placeholder="%" style="width:45px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;">
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置背景模式">背景模式
                            <select id="rbt-batch-cvbgmode" class="rbt-select" style="width:75px;height:20px;font-size:11px;padding:0 2px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;">
                                <option value="keep">保持</option>
                                <option value="none">无/常规</option>
                                <option value="blur">毛玻璃</option>
                                <option value="direct">直接背景</option>
                            </select>
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置毛玻璃模糊半径 (px)">模糊
                            <input type="number" id="rbt-batch-cvblur" min="0" max="100" value="40" style="width:40px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;"> px
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置画面亮度百分比 (%)">亮度
                            <input type="number" id="rbt-batch-cvbrightness" min="0" max="200" value="60" style="width:40px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;"> %
                        </label>
                        <button class="rbt-btn" id="rbt-apply-batch-cv" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">应用内容视频</button>
                    </div>

                    <!-- === 5. 人声流水线 / 对齐 / 执行 === -->
                    <div class="rbt-actions rbt-group-voice-flow" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; border-bottom:none; padding-bottom:6px; margin-bottom:6px;">
                        <span style="font-size:11px;color:var(--text-secondary);font-weight:bold;margin-right:4px;">人声工具:</span>
                        <span class="rbt-batch-rowbreak"></span>
                        <span class="rbt-batch-subgroup">人声流水线</span>
                        <button class="rbt-btn" id="rbt-paste-ai-raw-btn" style="font-size:11px;padding:2px 8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">粘贴人声-原文案</button>
                        <button class="rbt-btn" id="rbt-paste-tts-btn" style="font-size:11px;padding:2px 8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">粘贴人声文案/断行/音色</button>
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <label style="font-size:11px;color:#ccc;">配音服务:
                            <select id="rbt-tts-provider" class="rbt-select" style="height:24px;max-width:180px;">
                                <option value="elevenlabs">ElevenLabs</option><option value="edge">微软 Edge（无需 Key）</option>
                            </select></label>
                        <span style="font-size:11px;color:#888;">AI模型:</span>
                        <select id="rbt-tts-model" class="rbt-select" style="width:145px;height:24px;font-size:11px;padding:0 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;">
                            <option value="eleven_v3">v3 (情感标签)</option>
                            <option value="eleven_turbo_v2_5">Eleven Turbo v2.5</option>
                            <option value="eleven_multilingual_v2">Eleven Multilingual v2</option>
                            <option value="eleven_monolingual_v1">Eleven Monolingual v1</option>
                        </select>
                        <span style="font-size:11px;color:#888;">人声-配音音色:</span>
                        <input list="rbt-tts-voices-list" id="rbt-tts-default-voice" class="rbt-select" style="width:180px;height:24px;font-size:11px;padding:0 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;" placeholder="选择音色或手动输入 Voice ID" title="按所选服务加载音色，微软音色以 edge: 开头" />
                        <datalist id="rbt-tts-voices-list"></datalist>
                        <span id="rbt-tts-service-status" role="status" style="font-size:11px;color:#aaa;max-width:460px;"></span>
                        <button class="rbt-btn" id="rbt-refresh-voices-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="刷新列表">刷新</button>
                        <button class="rbt-btn" id="rbt-apply-voice-all-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="应用全部空行">应用全部</button>
                        <span style="font-size:11px;color:#888;">尾部静音:</span>
                        <input type="number" id="rbt-tts-tail-silence" min="0" max="5" step="0.1" value="${localStorage.getItem('rbt_tts_tail_silence') || '0'}" style="width:48px;height:22px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:0 4px;font-size:11px;" title="生成的 MP3 末尾追加静音；0 表示不添加，启用时范围 0.1-5 秒">
                        <span style="font-size:11px;color:#888;">秒</span>
                        <!-- 幽灵事件锚点 -->
                        <div style="display:none;">
                            <button id="rbt-ai-gemini-btn"></button><button id="rbt-ai-tts-all-btn"></button><button id="rbt-ai-auto-all-btn"></button><button id="rbt-export-selected-btn"></button>
                        </div>
                        <span class="rbt-batch-rowbreak"></span>
                        <span class="rbt-batch-subgroup">执行动作</span>
                        <select id="rbt-unified-execute-mode" class="rbt-select" style="width:auto; height:24px; font-size:11px; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1); border-radius:4px; padding:0 8px; color:#ccc; cursor:pointer; outline:none;">
                            <option value="rbt-ai-auto-all-btn">一键: 执行AI大全家桶 (改写+配音合成+对齐生成)</option>
                            <option value="rbt-ai-gemini-btn">分步: 仅执行 AI 改写及处理文案</option>
                            <option value="rbt-ai-tts-all-btn">分步: 仅执行 批量生成配音及本地时间轴提取</option>
                        </select>
                        <select id="rbt-unified-execute-scope" class="rbt-select" title="选择工作流处理范围" style="height:24px;font-size:11px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);border-radius:4px;padding:0 7px;color:#ccc;">
                            <option value="current">当前标签</option>
                            <option value="all-tabs">全部标签（一键）</option>
                        </select>
                        <button class="rbt-btn" id="rbt-unified-execute-btn" title="开始执行左侧选择的工作流和标签范围" style="background:linear-gradient(135deg,#7c5cff,#a855f7);color:#fff;border:1px solid rgba(216,180,254,.9);font-size:11px;font-weight:700;padding:3px 18px;border-radius:5px;cursor:pointer;box-shadow:0 0 12px rgba(168,85,247,.55);">🚀 启动流水线执行</button>
                        <button class="rbt-btn" id="rbt-ai-settings-btn" style="padding:2px 10px;font-size:11px;background:rgba(168,85,247,0.15);border:1px solid rgba(168,85,247,0.3);color:#a78bfa;border-radius:4px;cursor:pointer;" title="配置 Gemini API Key 和自定义 Prompt 指令">⚙️ AI设置</button>
                        <span class="rbt-batch-rowbreak"></span>
                        <span class="rbt-batch-subgroup">对齐设定</span>
                        <select id="rbt-align-source" class="rbt-select" style="width:auto;height:24px;font-size:11px;padding:0 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;">
                            <option value="video">背景视频对齐</option>
                            <option value="audio">人声-音频文件对齐</option>
                        </select>
                        <select id="rbt-align-txt-col" class="rbt-select" style="width:auto;height:24px;font-size:11px;padding:0 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;">
                            <option value="txtContent">选列：[人声-断行文案]</option>
                            <option value="ttsText">选列：[人声-配音文案]</option>
                            <option value="overlay_title">选列：[覆层标题]</option>
                            <option value="overlay_body">选列：[覆层内容]</option>
                            <option value="scroll_body">选列：[滚动字幕正文]</option>
                            <option value="scroll_title">选列：[滚动标题]</option>
                        </select>
                        <div style="position:relative;display:flex;align-items:center;">
                            <button class="rbt-btn" id="rbt-lang-picker-btn" style="padding:2px 8px;font-size:11px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;width:95px;display:flex;justify-content:space-between;align-items:center;height:24px;">英语 ▾</button>
                            <div id="rbt-lang-dropdown" style="display:none;position:absolute;top:100%;left:0;margin-top:4px;width:180px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;z-index:9999;box-shadow:0 8px 32px rgba(0,0,0,0.8);">
                                <div style="padding:4px;border-bottom:1px solid rgba(255,255,255,0.05);background:rgba(0,0,0,0.2);">
                                    <input type="text" id="rbt-lang-search" placeholder="搜索语种..." style="width:100%;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#fff;padding:2px 6px;font-size:11px;border-radius:2px;box-sizing:border-box;">
                                </div>
                                <div id="rbt-lang-list" style="max-height:220px;overflow-y:auto;"></div>
                            </div>
                            <input type="hidden" id="rbt-align-lang" value="英语">
                        </div>
                        <button class="rbt-btn" id="rbt-align-all-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">一键对齐字幕</button>
                        <button class="rbt-btn" id="rbt-align-multikey-btn" style="padding:2px 8px;font-size:11px;background:rgba(34,197,94,0.12);border:1px solid rgba(74,222,128,0.35);color:#86efac;" title="按云端转录设置的并发数并行对齐（Deepgram 支持 20~50 并发）">⚡ 并发对齐字幕</button>
                        <button class="rbt-btn" id="rbt-view-records-btn" style="padding:2px 8px;font-size:11px;background:rgba(59,130,246,0.15);border:1px solid rgba(96,165,250,0.35);color:#93c5fd;" title="查看每个片段发送给 Deepgram/Groq 的请求时间、响应耗时及详细记录">📜 片段发送记录</button>
                        <button class="rbt-btn" id="rbt-clear-all-cache-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,100,100,0.1);border:1px solid rgba(255,100,100,0.3);color:#f88;" title="清除当前表格所有媒体文件的音频识别缓存">全局清缓存</button>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#999;cursor:pointer;" title="即使已有 SRT/已对齐，也重新从候选文案里查找匹配并重新生成 SRT；会复用已有语音识别缓存"><input type="checkbox" id="rbt-force-realign" style="margin:0;transform:scale(0.8);"> 强制重新查找/对齐</label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#999;cursor:pointer;" title="删除该音频的语音识别缓存，重新调用所选服务转录，再重新查找文案并生成 SRT"><input type="checkbox" id="rbt-force-transcribe" style="margin:0;transform:scale(0.8);"> 强制重新转录</label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#999;cursor:pointer;" title="在没有人声文案的情况下，仅根据AI语音识别直接生成字幕"><input type="checkbox" id="rbt-allow-blind" style="margin:0;transform:scale(0.8);"> 允许无文案盲转</label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#999;cursor:pointer;" title="开启后：对齐时若识别到的文字与当前行文本不匹配，会自动在全部任务候选池中进行相似性搜寻。关闭后（默认）：直接强制使用该行文案进行对齐，即使有些许不匹配也强行生成对齐时间轴。"><input type="checkbox" id="rbt-align-auto-detect" style="margin:0;transform:scale(0.8);" ${localStorage.getItem('rbt_align_auto_detect') === '1' ? 'checked' : ''}> 自动查找匹配模式</label>
                    </div>

                </div>

                    <!-- === 8. 批量模板配置 (Select/Preset/Templates) === -->
                    <div class="rbt-actions" id="rbt-batch-bar" style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:0; padding-bottom:0; border-bottom:none;">
                        <span style="font-size:11px;color:var(--text-secondary);font-weight:bold;margin-right:4px;">批量预设:</span>
                        <label style="display:flex;align-items:center;font-size:11px;color:#ccc;cursor:pointer;gap:4px;"><input type="checkbox" id="rbt-select-all" style="margin:0;transform:scale(0.8);"> 全选</label>
                        <button class="rbt-btn" id="rbt-invert-select" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">反选</button>
                        <button class="rbt-btn" id="rbt-deselect-all" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">取消</button>
                        <button class="rbt-btn" id="rbt-delete-selected" disabled style="padding:2px 9px;font-size:11px;background:rgba(239,68,68,0.14);border:1px solid rgba(239,68,68,0.35);color:#f87171;font-weight:600;">🗑 删除选中</button>
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <button class="rbt-btn" id="rbt-ai-preset-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="一键覆盖选中行参数">任务预设设置</button>
                        <button class="rbt-btn" id="rbt-import-task-preset-btn" style="padding:2px 6px;font-size:10px;background:rgba(100,100,255,0.1);border:1px solid rgba(100,100,255,0.2);color:#8b8bfa;" title="导入任务组合预设 JSON 文件">📥</button>
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <select id="rbt-batch-sub-tpl" style="display:none;"><option value="">动态字幕模版...</option>${batchSubOpts}</select>
                        <div id="rbt-sub-tpl-trigger" class="rbt-select rbt-select-trigger" style="width:130px;height:24px;font-size:11px;padding:0 8px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;display:flex;align-items:center;">
                            <span id="rbt-sub-tpl-label" style="flex:1;">动态字幕模版...</span><span style="font-size:8px;">▼</span>
                        </div>
                        <button class="rbt-btn" id="rbt-apply-batch-sub" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">应用</button>
                        <button class="rbt-btn" id="rbt-apply-first-subtitle-style" style="padding:2px 8px;font-size:11px;background:rgba(255,193,7,0.12);border:1px solid rgba(255,193,7,0.28);color:#ffd166;" title="把当前字幕模板只应用到每行第一个动态字幕，作为标题样式">首句标题</button>
                        <label style="display:flex;align-items:center;gap:3px;font-size:10px;color:#999;" title="首句标题 X 位置百分比，留空则使用预设/全局位置">X
                            <input type="number" id="rbt-first-sub-x" min="0" max="100" step="1" placeholder="%" style="width:42px;height:22px;background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:0 3px;font-size:10px;">
                        </label>
                        <label style="display:flex;align-items:center;gap:3px;font-size:10px;color:#999;" title="首句标题 Y 位置百分比，留空则使用预设/全局位置">Y
                            <input type="number" id="rbt-first-sub-y" min="0" max="100" step="1" placeholder="%" style="width:42px;height:22px;background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:0 3px;font-size:10px;">
                        </label>
                        <button class="rbt-btn" id="rbt-import-sub-preset-btn" style="padding:2px 6px;font-size:10px;background:rgba(100,100,255,0.1);border:1px solid rgba(100,100,255,0.2);color:#8b8bfa;" title="导入字幕预设 JSON 文件">📥</button>
                        <select id="rbt-batch-card-tpl" class="rbt-select" style="width:90px;height:24px;font-size:11px;padding:0 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;">
                            <option value="">覆层预设...</option>${batchCardOpts}
                        </select>
                        <button class="rbt-btn" id="rbt-apply-batch-card" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">应用</button>
                        <button class="rbt-btn" id="rbt-gallery-batch-btn" style="padding:2px 8px;font-size:11px;background:rgba(123,139,239,0.2);border:1px solid rgba(123,139,239,0.4);color:#7b8bef;" title="打开预设可视化图库">图库...</button>
                        <button class="rbt-btn" id="rbt-import-card-preset-btn" style="padding:2px 6px;font-size:10px;background:rgba(100,100,255,0.1);border:1px solid rgba(100,100,255,0.2);color:#8b8bfa;" title="导入覆层预设 JSON 文件">📥</button>
                        <span id="rbt-selected-count" style="margin-left:auto;font-size:11px;color:#aaa;"></span>
                    </div>

            </div>

            <!-- hidden file inputs -->
            <input type="file" id="rbt-file-bg" class="rbt-hidden-input" accept=".mp4,.mov,.mkv,.avi,.wmv,.flv,.webm,.jpg,.jpeg,.png,.webp" multiple>
            <input type="file" id="rbt-file-audio" class="rbt-hidden-input" accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.wma,.mp4,.mov,.mkv,.avi,.wmv,.flv,.webm" multiple>
            <input type="file" id="rbt-file-srt" class="rbt-hidden-input" accept=".srt" multiple>
            <input type="file" id="rbt-file-txt" class="rbt-hidden-input" accept=".txt" multiple>
            <input type="file" id="rbt-file-bgm" class="rbt-hidden-input" accept=".mp3,.wav,.m4a,.aac,.flac,.ogg">
            <input type="file" id="rbt-file-single" class="rbt-hidden-input" accept="*/*">
            <input type="file" id="rbt-file-folder" class="rbt-hidden-input" webkitdirectory directory multiple>
            <div class="rbt-table-wrap">
                <table class="rbt-table" id="rbt-table">
                    <thead>
                        <tr>
                            <th class="rbt-col-drag rbt-grp-base" style="width:24px;"></th>
                            <th class="rbt-col-chk rbt-grp-base" style="width:30px;text-align:center;">
                                <input type="checkbox" id="rbt-header-select-all" style="margin:0;transform:scale(0.9);cursor:pointer;" title="全选所有行">
                            </th>
                            <th class="rbt-col-num rbt-grp-base">#</th>

                            <!-- 元数据与配置列 -->
                            <th class="rbt-col-act rbt-grp-base">操作</th>
                            <th class="rbt-col-insert rbt-grp-base">🎬 插入素材</th>
                            <th class="rbt-col-tpl rbt-grp-base">动态字幕模版</th>
                            <th class="rbt-col-tpl rbt-grp-base">覆层预设</th>
                            <th class="rbt-col-dur rbt-grp-base">时长(s)</th>
                            <th class="rbt-col-exportname rbt-grp-base"><div class="rbt-th-wrap"><span>导出命名</span><button class="rbt-th-paste" data-paste-col="exportName" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="exportName" title="清空该列">清</button></div></th>

                            <!-- 🌟 视频封面层 (Gold) -->
                            <th class="rbt-col-cover-media rbt-grp-cover"><div class="rbt-th-wrap"><span>封面素材</span><button class="rbt-th-folder" data-folder-col="cover_media" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="cover_media" title="清空该列">清</button></div></th>
                            <th class="rbt-col-cover-text rbt-grp-cover"><div class="rbt-th-wrap"><span>封面文案</span><button class="rbt-th-paste" data-paste-col="cover_text" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="cover_text" title="清空该列">清</button></div></th>

                            <!-- 🟦 画面基础层 (Blue) -->
                            <th class="rbt-col-hook rbt-grp-video"><div class="rbt-th-wrap"><span>前置Hook</span><button class="rbt-th-clear" data-clear-col="hook" title="清空该列">清</button></div></th>
                            <th class="rbt-col-bg rbt-grp-video"><div class="rbt-th-wrap"><span>背景素材</span><button class="rbt-th-folder" data-folder-col="bg" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="bg" title="清空该列">清</button></div></th>
                            <th class="rbt-col-clippool rbt-grp-video"><div class="rbt-th-wrap"><span>背景片段池</span><button class="rbt-th-clear" data-clear-col="clipPool" title="清空该列">清</button></div></th>
                            <th class="rbt-col-bgclipsettings rbt-grp-video"><div class="rbt-th-wrap"><span>背景池剪辑</span><button class="rbt-th-paste" data-paste-col="bgClipSettings" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="bgClipSettings" title="清空该列">清</button></div></th>
                            <th class="rbt-col-bgscale rbt-grp-video"><div class="rbt-th-wrap"><span>背景缩放</span><button class="rbt-th-clear" data-clear-col="bgScale" title="清空该列">清</button></div></th>
                            <th class="rbt-col-bgdurscale rbt-grp-video"><div class="rbt-th-wrap"><span>背景时长</span><button class="rbt-th-clear" data-clear-col="bgDurScale" title="清空该列">清</button></div></th>
                            <th class="rbt-col-bgvol rbt-grp-video"><div class="rbt-th-wrap"><span>背景音量倍率</span><button class="rbt-th-clear" data-clear-col="bgVideoVolume" title="清除任务倍率，恢复为 100%">清</button></div></th>
                            <th class="rbt-col-bgm rbt-grp-video"><div class="rbt-th-wrap"><input type="checkbox" id="rbt-bgm-select-all" title="全选/取消全选配乐勾选框" style="margin:0;transform:scale(0.85);margin-right:3px;"><span>配乐</span><button class="rbt-th-folder" data-folder-col="bgm" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="bgm" title="清空该列">清</button></div></th>

                            <!-- 🎬 内容视频 (Cyan) -->
                            <th class="rbt-col-contentvideo rbt-grp-cv"><div class="rbt-th-wrap"><span>内容视频</span><button class="rbt-th-folder" data-folder-col="contentvideo" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="contentvideo" title="清空该列">清</button></div></th>
                            <th class="rbt-col-cvtrim rbt-grp-cv"><div class="rbt-th-wrap"><span>内容视频-时间段</span><button class="rbt-th-clear" data-clear-col="cvTrim" title="清空该列">清</button></div></th>
                            <th class="rbt-col-cvcrop rbt-grp-cv"><div class="rbt-th-wrap"><span>内容视频-裁切</span><button class="rbt-th-clear" data-clear-col="cvCrop" title="清空该列">清</button></div></th>
                            <th class="rbt-col-cvblurbg rbt-grp-cv"><div class="rbt-th-wrap"><span>内容视频-毛玻璃背景</span><button class="rbt-th-clear" data-clear-col="cvBlurBg" title="清空该列">清</button></div></th>
                            <th class="rbt-col-cvscale rbt-grp-cv"><div class="rbt-th-wrap"><span>内容视频-缩放</span><button class="rbt-th-clear" data-clear-col="cvScale" title="清空该列">清</button></div></th>
                            <th class="rbt-col-cvpos rbt-grp-cv"><div class="rbt-th-wrap"><span>内容视频-位置</span><button class="rbt-th-clear" data-clear-col="cvPos" title="清空该列">清</button></div></th>
                            <th class="rbt-col-cvvol rbt-grp-cv"><div class="rbt-th-wrap"><span>内容视频-音量</span><button class="rbt-th-clear" data-clear-col="cvVol" title="清空该列">清</button></div></th>

                            <!-- 🟪 人声与音频层 (Purple) -->
                            <th class="rbt-col-ai_script rbt-grp-audio"><div class="rbt-th-wrap"><span>人声-原文案</span><button class="rbt-th-paste" data-paste-col="aiScript" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="ai_script" title="清空该列">清</button></div></th>
                            <th class="rbt-col-tts_text rbt-grp-audio"><div class="rbt-th-wrap"><span>人声-配音文案</span><button class="rbt-th-paste" data-paste-col="ttsText" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="tts_text" title="清空该列">清</button></div></th>
                            <th class="rbt-col-txtcontent rbt-grp-audio"><div class="rbt-th-wrap"><span>人声-断行文案</span><button class="rbt-th-paste" data-paste-col="txtContent" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="txt" title="清空该列">清</button></div></th>
                            <th class="rbt-col-tts_voice rbt-grp-audio"><div class="rbt-th-wrap"><span>人声-配音音色</span><button class="rbt-th-paste" data-paste-col="ttsVoiceId" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="tts_voice" title="清空该列">清</button></div></th>
                            <th class="rbt-col-srt rbt-grp-audio"><div class="rbt-th-wrap"><span>人声-SRT字幕</span><button class="rbt-th-folder" data-folder-col="srt" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="srt" title="清空该列">清</button></div></th>
                            <th class="rbt-col-audio rbt-grp-audio"><div class="rbt-th-wrap"><span>人声-音频文件</span><button class="rbt-th-folder" data-folder-col="audio" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="audio" title="清空该列">清</button></div></th>
                            <th class="rbt-col-voicevol rbt-grp-audio"><div class="rbt-th-wrap"><span>人声-音频音量</span><button class="rbt-th-clear" data-clear-col="voiceVolume" title="重置为全局值">清</button></div></th>
                            <th class="rbt-col-audiodurscale rbt-grp-audio"><div class="rbt-th-wrap"><span>人声-音频变速</span><button class="rbt-th-clear" data-clear-col="audioDurScale" title="清空该列">清</button></div></th>

                            <!-- 🟧 覆层 (Amber) -->
                            <th class="rbt-col-pip rbt-grp-ovl"><div class="rbt-th-wrap"><span>图像覆层</span><button class="rbt-th-folder" data-folder-col="pip" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="pip" title="清空该列">清</button></div></th>
                            ${activeTextcards.map((ov, oIdx) => {
                                const cardName = ov.name || `卡片${oIdx + 1}`;
                                const targetId = ov.id || 'default';
                                return `
                                    <th class="rbt-col-title rbt-grp-ovl" data-card-id="${targetId}"><div class="rbt-th-wrap"><span>覆层标题-${_escHtml(cardName)}</span><button class="rbt-th-paste" data-paste-col="overlay_title_${targetId}" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="overlay_title_${targetId}" title="清空该列">清</button></div></th>
                                    <th class="rbt-col-body rbt-grp-ovl" data-card-id="${targetId}"><div class="rbt-th-wrap"><span>覆层内容-${_escHtml(cardName)}</span><button class="rbt-th-paste" data-paste-col="overlay_body_${targetId}" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="overlay_body_${targetId}" title="清空该列">清</button></div></th>
                                    <th class="rbt-col-footer rbt-grp-ovl" data-card-id="${targetId}"><div class="rbt-th-wrap"><span>覆层结尾-${_escHtml(cardName)}</span><button class="rbt-th-paste" data-paste-col="overlay_footer_${targetId}" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="overlay_footer_${targetId}" title="清空该列">清</button></div></th>
                                    <th class="rbt-col-flipper-enabled rbt-grp-ovl" data-card-id="${targetId}"><div class="rbt-th-wrap"><span>${_escHtml(cardName)}-启用翻转</span><button class="rbt-th-paste" data-paste-col="overlay_flipper_enabled_${targetId}" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="overlay_flipper_enabled_${targetId}" title="清空该列">清</button></div></th>
                                    <th class="rbt-col-flipper-duration rbt-grp-ovl" data-card-id="${targetId}"><div class="rbt-th-wrap"><span>${_escHtml(cardName)}-翻转间隔</span><button class="rbt-th-paste" data-paste-col="overlay_flipper_duration_${targetId}" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="overlay_flipper_duration_${targetId}" title="清空该列">清</button></div></th>
                                    <th class="rbt-col-flipper-lines rbt-grp-ovl" data-card-id="${targetId}"><div class="rbt-th-wrap"><span>${_escHtml(cardName)}-翻转行数</span><button class="rbt-th-paste" data-paste-col="overlay_flipper_lines_${targetId}" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="overlay_flipper_lines_${targetId}" title="清空该列">清</button></div></th>
                                    <th class="rbt-col-flipper-effect rbt-grp-ovl" data-card-id="${targetId}"><div class="rbt-th-wrap"><span>${_escHtml(cardName)}-翻转效果</span><button class="rbt-th-paste" data-paste-col="overlay_flipper_effect_${targetId}" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="overlay_flipper_effect_${targetId}" title="清空该列">清</button></div></th>
                                    <th class="rbt-col-flipper-loop rbt-grp-ovl" data-card-id="${targetId}"><div class="rbt-th-wrap"><span>${_escHtml(cardName)}-翻转循环</span><button class="rbt-th-paste" data-paste-col="overlay_flipper_loop_${targetId}" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="overlay_flipper_loop_${targetId}" title="清空该列">清</button></div></th>
                                    <th class="rbt-col-flipper-transition-duration rbt-grp-ovl" data-card-id="${targetId}"><div class="rbt-th-wrap"><span>${_escHtml(cardName)}-过渡时长</span><button class="rbt-th-paste" data-paste-col="overlay_flipper_transition_duration_${targetId}" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="overlay_flipper_transition_duration_${targetId}" title="清空该列">清</button></div></th>
                                `;
                            }).join('')}
                            ${activeScrolls.map((ov, oIdx) => {
                                const scrollName = ov.name || `滚动${oIdx + 1}`;
                                const targetId = ov.id || 'default';
                                return `
                                    <th class="rbt-col-scroll-title rbt-grp-ovl" data-scroll-id="${targetId}"><div class="rbt-th-wrap"><span>滚动标题-${_escHtml(scrollName)}</span><button class="rbt-th-paste" data-paste-col="scroll_title_${targetId}" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="scroll_title_${targetId}" title="清空该列">清</button></div></th>
                                    <th class="rbt-col-scroll-body rbt-grp-ovl" data-scroll-id="${targetId}"><div class="rbt-th-wrap"><span>滚动内容-${_escHtml(scrollName)}</span><button class="rbt-th-paste" data-paste-col="scroll_body_${targetId}" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="scroll_body_${targetId}" title="清空该列">清</button></div></th>
                                `;
                            }).join('')}
                            <th class="rbt-col-subtime rbt-grp-ovl"><div class="rbt-th-wrap"><span>字幕时间</span><button class="rbt-th-clear" data-clear-col="subtitleTime" title="重置为全时段">清</button></div></th>
                        </tr>
                    </thead>
                    <tbody id="rbt-tbody">
                        ${tasks.map((t, i) => _renderBatchRow(t, i, subtitlePresets, cardTemplates, activeTextcards, activeScrolls)).join('')}
                    </tbody>
                </table>
            </div>
            <div class="rbt-footer">
                <span id="rbt-count">${tasks.length} 个任务</span>
                <span id="rbt-align-progress" style="font-size:12px;color:#a0d0ff;margin-left:12px;"></span>
                <div class="rbt-footer-hint">提示: 先粘贴文案创建行 → 再批量添加素材自动按顺序分配 | 设置素材文件夹后可一键刷新同步最新文件</div>
                <button class="rbt-btn" id="rbt-discard-btn" title="恢复打开表格前的工程内容">关闭不保存</button>
                <button class="rbt-btn rbt-btn-primary" id="rbt-apply-btn">✅ 应用更改并关闭</button>
            </div>

            </div><!-- /rbt-main-col -->
            </div><!-- /rbt-body-row -->
        </div>
            <div id="rbt-hook-modal" style="display:none;position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:99999;align-items:center;justify-content:center;">
                <div style="background:#181818;padding:20px;border-radius:8px;border:1px solid #333;width:400px;display:flex;flex-direction:column;gap:12px;">
                    <h3 style="margin:0;color:#fff;font-size:14px;display:flex;align-items:center;gap:6px;">🪝 前置/Hook 设置</h3>
                    
                    <div style="font-size:12px;color:#ccc;display:flex;align-items:center;gap:8px;">
                        <span>Hook:</span>
                        <input type="text" id="rbt-hook-path" style="flex:1;background:#222;color:#ccc;border:1px solid #333;padding:4px;font-size:11px;" readonly placeholder="未选择 (留空则从正片开始)">
                        <button class="rbt-btn" id="rbt-hook-select-btn" style="padding:4px 8px;">浏览素材</button>
                        <input type="file" id="rbt-hook-file-input" style="display:none;" accept=".mp4,.mov,.mkv,.webm,.avi,.jpg,.jpeg,.png,.webp">
                    </div>

                    <div id="rbt-hook-preview-container" style="display:none;width:100%;height:160px;background:#000;border-radius:4px;overflow:hidden;position:relative;border:1px solid #333;">
                        <video id="rbt-hook-preview-video" style="width:100%;height:100%;object-fit:contain;" controls preload="metadata"></video>
                        <img id="rbt-hook-preview-img" style="width:100%;height:100%;object-fit:contain;display:none;">
                    </div>

                    <div style="background:#222;padding:10px;border-radius:4px;display:flex;flex-direction:column;gap:8px;border:1px solid #333;">
                        <span style="font-size:11px;color:#888;">裁切区间 (秒，留空表示使用原文件长度)</span>
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                            <button class="rbt-btn" id="rbt-hook-mark-start" style="padding:3px 8px;font-size:11px;" title="将当前视频播放位置设为起始点">⏩ 设为起点</button>
                            <input type="number" id="rbt-hook-start" style="width:60px;background:#111;color:#fff;border:1px solid #333;padding:4px;text-align:center;" placeholder="Start" step="0.1" min="0">
                            <span style="color:#666;">至</span>
                            <input type="number" id="rbt-hook-end" style="width:60px;background:#111;color:#fff;border:1px solid #333;padding:4px;text-align:center;" placeholder="End" step="0.1" min="0">
                            <button class="rbt-btn" id="rbt-hook-mark-end" style="padding:3px 8px;font-size:11px;" title="将当前视频播放位置设为结束点">⏪ 设为终点</button>
                            <span style="flex:1;"></span>
                            <span style="font-size:11px;color:#888;">播放变速:</span>
                            <input type="number" id="rbt-hook-speed" list="rbt-hook-speed-presets" value="1" step="0.05" min="0.1" max="10" style="background:#111;color:#fff;border:1px solid #333;padding:4px;width:70px;text-align:center;">
                            <datalist id="rbt-hook-speed-presets">
                                <option value="0.25">0.25x</option>
                                <option value="0.5">0.5x</option>
                                <option value="0.75">0.75x</option>
                                <option value="1">1.0x</option>
                                <option value="1.25">1.25x</option>
                                <option value="1.5">1.5x</option>
                                <option value="2">2.0x</option>
                                <option value="3">3.0x</option>
                            </datalist>
                        </div>
                    </div>

                    <div style="background:#222;padding:10px;border-radius:4px;display:flex;flex-direction:column;gap:8px;border:1px solid #333;">
                        <span style="font-size:11px;color:#888;">正片转场 (Transition)</span>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <select id="rbt-hook-transition" style="flex:1;background:#111;color:#fff;border:1px solid #333;padding:4px;font-size:11px;">
                                <option value="none" selected>⚡ 无转场 (直接硬切)</option>
                                <option value="fade">⚫ Fade 黑场淡入淡出</option>
                                <option value="fadeblack">⚫ FadeBlack 强黑场过渡</option>
                                <option value="fadewhite">⚪ FadeWhite 强白场过渡</option>
                                <option value="dissolve">✨ Dissolve 溶解叠化</option>
                                <option value="wipeleft">⬅️ Wipe Left 向左擦除</option>
                                <option value="wiperight">➡️ Wipe Right 向右擦除</option>
                                <option value="slideleft">🔙 Slide Left 向左推移</option>
                                <option value="slideright">🔜 Slide Right 向右推移</option>
                                <option value="rectcrop">🔲 RectCrop 矩形扩散</option>
                                <option value="circlecrop">⭕ CircleCrop 圆形扩散</option>
                            </select>
                            <span style="font-size:11px;color:#888;">时长(s):</span>
                            <input type="number" id="rbt-hook-trans-dur" value="0.5" step="0.1" min="0.1" max="5.0" style="width:50px;background:#111;color:#fff;border:1px solid #333;padding:4px;text-align:center;">
                        </div>
                    </div>
                    
                    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">
                        <button class="rbt-btn" id="rbt-hook-cancel" style="padding:6px 16px;">取消</button>
                        <button class="rbt-btn rbt-btn-primary" id="rbt-hook-save" style="padding:6px 16px;">保存配置</button>
                    </div>
                </div>
            </div>

            <!-- Cover Modal -->
            <div id="rbt-cover-modal" style="display:none;position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:99999;align-items:center;justify-content:center;">
                <div style="background:#181818;padding:20px;border-radius:8px;border:1px solid #333;width:420px;display:flex;flex-direction:column;gap:12px;">
                    <h3 style="margin:0;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:space-between;">
                        <span>🌟 视频封面设置</span>
                        <div style="display:flex;gap:4px;font-weight:normal;">
                            <select id="rbt-cover-preset-sel" style="width:110px;background:#222;color:#ccc;border:1px solid #444;font-size:11px;padding:2px;border-radius:4px;">
                                <option value="">---预设---</option>
                            </select>
                            <button id="rbt-cover-preset-save" class="rbt-btn" style="padding:2px 6px;font-size:11px;" title="保存当前所有设置到预设库">💾 保存</button>
                            <button id="rbt-cover-preset-del" class="rbt-btn" style="padding:2px 6px;font-size:11px;color:#f66;" title="删除选项">❌</button>
                        </div>
                    </h3>
                    
                    <div style="font-size:12px;color:#ccc;display:flex;align-items:center;gap:8px;">
                        <input type="checkbox" id="rbt-cover-enabled" style="margin:0;transform:scale(1.2);">
                        <label for="rbt-cover-enabled" style="font-weight:bold;color:#ffd700;cursor:pointer;">启用封面</label>
                        <span style="flex:1;"></span>
                        <input type="checkbox" id="rbt-cover-export-separate" style="margin:0;">
                        <label for="rbt-cover-export-separate" style="color:#aaa;cursor:pointer;">同时单独导出(PNG)</label>
                    </div>

                    <div style="background:#222;padding:10px;border-radius:4px;display:flex;flex-direction:column;gap:8px;border:1px solid #333;">
                        <div style="font-size:11px;color:#888;">封面背景图 (留空则使用背景视频第一帧)</div>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <input type="text" id="rbt-cover-bg-path" style="flex:1;background:#111;color:#ccc;border:1px solid #333;padding:4px;font-size:11px;" readonly placeholder="未选择 (使用背景首帧)">
                            <button class="rbt-btn" id="rbt-cover-bg-btn" style="padding:4px 8px;">浏览素材</button>
                            <input type="file" id="rbt-cover-file-input" style="display:none;" accept=".jpg,.jpeg,.png,.webp,.bmp">
                        </div>
                        <div id="rbt-cover-preview-container" style="display:none;width:100%;height:140px;background:#000;border-radius:4px;overflow:hidden;position:relative;border:1px solid #333;align-items:center;justify-content:center;">
                            <img id="rbt-cover-preview-img" style="max-width:100%;max-height:100%;object-fit:contain;display:none;">
                            <span id="rbt-cover-preview-hint" style="color:#666;font-size:12px;">自动提取视频第1帧</span>
                        </div>
                    </div>

                    <div style="background:#222;padding:10px;border-radius:4px;display:flex;flex-direction:column;gap:8px;border:1px solid #333;">
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span style="font-size:11px;color:#888;">与正片合并滞留(秒):</span>
                            <input type="number" id="rbt-cover-duration" value="0" step="0.1" min="0" max="10.0" style="width:50px;background:#111;color:#fff;border:1px solid #333;padding:4px;text-align:center;">
                            <span style="font-size:10px;color:#666;">(仅提取图片设为0)</span>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">
                            <span style="font-size:11px;color:#888;">套用文字卡片模版:</span>
                            <select id="rbt-cover-overlay-sel" style="flex:1;background:#111;color:#ffd700;border:1px solid #544414;padding:4px;font-size:11px;border-radius:4px;outline:none;">
                                <option value="">-- 使用独立卡片配置 --</option>
                            </select>
                        </div>
                        <div style="display:flex;align-items:center;justify-content:center;margin-top:4px;">
                            <button class="rbt-btn" id="rbt-cover-edit-overlay-btn" style="width:100%;padding:6px;background:rgba(255,215,0,0.1);border:1px solid rgba(255,215,0,0.3);color:#ffd700;">✏️ 定制该封面的专属排版</button>
                        </div>
                    </div>
                    
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
                        <button class="rbt-btn" id="rbt-cover-batch-apply" style="padding:6px 12px;background:#321;border:1px solid #643;color:#fc8;">应用到全部行</button>
                        <div style="display:flex;gap:8px;">
                            <button class="rbt-btn" id="rbt-cover-cancel" style="padding:6px 16px;">取消</button>
                            <button class="rbt-btn rbt-btn-primary" id="rbt-cover-save" style="padding:6px 16px;">保存单行配置</button>
                        </div>
                    </div>
                </div>
            </div>

        </div>
    `;

    // CSS
    _injectBatchTableCSS();

    // 事件
    _bindBatchTableEvents();

    // 应用列显示设置
    _applyColVisibility();

    // 更新批量选中计数
    _updateBatchSelectCount();

    // ── 恢复滚动位置 ──
    const newScrollWrap = container.querySelector('.rbt-table-wrap');
    if (newScrollWrap && (_savedScrollTop || _savedScrollLeft)) {
        newScrollWrap.scrollTop = _savedScrollTop;
        newScrollWrap.scrollLeft = _savedScrollLeft;
    }
    _hydrateBatchVideoThumbnails(container);
    _scheduleFitBatchTableToViewport();
  } catch (fatalErr) {
    console.error('[BatchTable] _renderBatchTable FATAL:', fatalErr);
    try {
      const c = _batchTableState.container;
      if (c) c.innerHTML = `<div style="padding:20px;color:#f66;font-size:14px;"><h3>⚠️ 批量表格渲染出错</h3><pre style="white-space:pre-wrap;color:#faa;font-size:12px;">${fatalErr.message}\n\n${fatalErr.stack || ''}</pre><button onclick="_renderBatchTable()" style="margin-top:12px;padding:8px 16px;background:#333;border:1px solid #555;color:#ccc;border-radius:6px;cursor:pointer;">🔄 重试</button></div>`;
    } catch(_) {}
  }
}

const _rbtVideoThumbCache = new Map();
const _rbtVideoThumbInflight = new Map();
const _RBT_THUMB_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const _RBT_MAX_THUMB_CONCURRENCY = 2;
let _rbtActiveThumbTasks = 0;
const _rbtThumbTaskQueue = [];

function _rbtGetCachedVideoThumbUrl(filePath) {
    if (!filePath) return '';
    return _rbtVideoThumbCache.get(String(filePath)) || '';
}

function _rbtRunWithThumbConcurrency(fn) {
    return new Promise((resolve, reject) => {
        const run = () => {
            _rbtActiveThumbTasks++;
            Promise.resolve()
                .then(fn)
                .then(resolve, reject)
                .finally(() => {
                    _rbtActiveThumbTasks = Math.max(0, _rbtActiveThumbTasks - 1);
                    if (_rbtThumbTaskQueue.length > 0) {
                        const next = _rbtThumbTaskQueue.shift();
                        next();
                    }
                });
        };
        if (_rbtActiveThumbTasks < _RBT_MAX_THUMB_CONCURRENCY) {
            run();
        } else {
            _rbtThumbTaskQueue.push(run);
        }
    });
}

function _rbtCaptureVideoFrameFallback(videoSrc, seekTime = 0.5) {
    return new Promise((resolve) => {
        if (!videoSrc || typeof document === 'undefined') return resolve('');
        const v = document.createElement('video');
        let settled = false;
        const cleanup = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                v.pause();
                v.removeAttribute('src');
                v.load();
            } catch (_) {}
            resolve(result || '');
        };
        const timer = setTimeout(() => cleanup(''), 5000);
        v.muted = true;
        v.playsInline = true;
        v.preload = 'metadata';
        v.crossOrigin = 'anonymous';
        v.addEventListener('loadedmetadata', () => {
            const dur = Number.isFinite(v.duration) ? v.duration : 0;
            const target = dur > 0 ? Math.min(Math.max(0.05, seekTime), Math.max(0, dur - 0.05)) : 0.1;
            try { v.currentTime = target; } catch (_) { cleanup(''); }
        }, { once: true });
        v.addEventListener('seeked', () => {
            try {
                const vw = v.videoWidth || 160;
                const vh = v.videoHeight || 160;
                const scale = Math.min(1, 160 / Math.max(vw, vh, 1));
                const cw = Math.max(1, Math.round(vw * scale));
                const ch = Math.max(1, Math.round(vh * scale));
                const c = document.createElement('canvas');
                c.width = cw;
                c.height = ch;
                const ctx = c.getContext('2d');
                ctx.drawImage(v, 0, 0, cw, ch);
                cleanup(c.toDataURL('image/jpeg', 0.72));
            } catch (_) {
                cleanup('');
            }
        }, { once: true });
        v.addEventListener('error', () => cleanup(''), { once: true });
        v.src = String(videoSrc).split('#')[0];
        try { v.load(); } catch (_) { cleanup(''); }
    });
}

function _rbtResolveStaticVideoThumbnail(filePath, videoSrc, seekTime = 1) {
    const cacheKey = String(filePath || videoSrc || '').trim();
    if (!cacheKey) return Promise.resolve('');
    if (_rbtVideoThumbCache.has(cacheKey)) {
        return Promise.resolve(_rbtVideoThumbCache.get(cacheKey));
    }
    if (_rbtVideoThumbInflight.has(cacheKey)) {
        return _rbtVideoThumbInflight.get(cacheKey);
    }
    const promise = _rbtRunWithThumbConcurrency(async () => {
        if (_rbtVideoThumbCache.has(cacheKey)) return _rbtVideoThumbCache.get(cacheKey);
        if (filePath && window.electronAPI?.localFiles?.getVideoThumbnail) {
            try {
                const thumbPath = await window.electronAPI.localFiles.getVideoThumbnail(filePath, 160);
                if (thumbPath) {
                    const thumbUrl = _rbtMediaUrl(thumbPath);
                    if (thumbUrl) {
                        _rbtVideoThumbCache.set(cacheKey, thumbUrl);
                        return thumbUrl;
                    }
                }
            } catch (_) {}
        }
        const fallbackUrl = await _rbtCaptureVideoFrameFallback(videoSrc || _rbtMediaUrl(filePath), seekTime);
        if (fallbackUrl) {
            _rbtVideoThumbCache.set(cacheKey, fallbackUrl);
            return fallbackUrl;
        }
        return '';
    }).finally(() => {
        _rbtVideoThumbInflight.delete(cacheKey);
    });
    _rbtVideoThumbInflight.set(cacheKey, promise);
    return promise;
}
window._rbtResolveStaticVideoThumbnail = _rbtResolveStaticVideoThumbnail;
window._rbtVideoThumbCache = _rbtVideoThumbCache;

function _hydrateBatchVideoThumbnails(container) {
    if (!container) return;
    const thumbEls = container.querySelectorAll('img.rbt-video-thumb, video.rbt-thumb-previewable');
    if (!thumbEls.length) return;

    const hydrateElement = (el) => {
        if (el.dataset.thumbHydrated === 'true') return;
        el.dataset.thumbHydrated = 'true';

        if (el.tagName === 'IMG') {
            const filePath = el.dataset.filePath || '';
            const videoSrc = el.dataset.videoSrc || '';
            const seekTime = parseFloat(el.dataset.seekTime) || 1;
            const cached = _rbtGetCachedVideoThumbUrl(filePath || videoSrc);
            if (cached) {
                el.src = cached;
                return;
            }
            _rbtResolveStaticVideoThumbnail(filePath, videoSrc, seekTime).then((thumbUrl) => {
                if (thumbUrl) {
                    el.src = thumbUrl;
                } else {
                    el.style.background = '#111';
                }
            });
            return;
        }

        // Legacy <video> fallback if any remain
        const video = el;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        const src = video.getAttribute('src') || '';
        const match = src.match(/#t=([0-9.]+)/);
        const requestedTime = match ? parseFloat(match[1]) : 0.1;
        video.addEventListener('loadedmetadata', () => {
            const duration = Number.isFinite(video.duration) ? video.duration : 0;
            const maxTime = duration > 0 ? Math.max(0, duration - 0.05) : requestedTime;
            const targetTime = Math.min(Math.max(0.1, requestedTime), maxTime);
            try { if (Number.isFinite(targetTime)) video.currentTime = targetTime; } catch (_) {}
        }, { once: true });
        video.addEventListener('loadeddata', () => {
            try { video.pause(); } catch (_) {}
        }, { once: true });
        try { video.load(); } catch (_) {}
    };

    if (typeof IntersectionObserver !== 'function') {
        thumbEls.forEach(hydrateElement);
        return;
    }

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                const el = entry.target;
                observer.unobserve(el);
                hydrateElement(el);
            }
        });
    }, {
        root: container.querySelector('.rbt-table-wrap'),
        rootMargin: '120px',
        threshold: 0.01
    });

    thumbEls.forEach((el) => {
        const filePath = el.dataset?.filePath || el.dataset?.videoSrc || '';
        const cached = filePath ? _rbtGetCachedVideoThumbUrl(filePath) : '';
        if (cached && el.tagName === 'IMG') {
            el.src = cached;
            el.dataset.thumbHydrated = 'true';
            return;
        }
        if (el.dataset.thumbHydrated !== 'true') {
            observer.observe(el);
        }
    });
}

function _isBatchWritableOverlay(ov) {
    return !!(ov && !ov.fixed_text);
}

function _findBatchTextCardOverlay(task) {
    return (task.overlays || []).find(o => (
        o && _isBatchWritableOverlay(o) && (o.type === 'textcard' || !o.type || o.type === '')
    ));
}

function _findBatchScrollOverlay(task) {
    return (task.overlays || []).find(o => o && _isBatchWritableOverlay(o) && o.type === 'scroll');
}

function _findBatchOverlayByIdOrIdx(task, id, name, idx, type) {
    const list = (task.overlays || []).filter(o => o && !o.fixed_text && (type === 'scroll' ? o.type === 'scroll' : (o.type === 'textcard' || !o.type || o.type === '')));
    if (list.length === 0) return null;
    if (id && id !== 'default') {
        // 派生任务的实例 ID 必须唯一；_templateOverlayId 用来保持批量表格
        // “同一模板图层”列的稳定定位，不再依赖跨任务重复的运行时 ID。
        const state = window._reelsState;
        const templateTask = state?.tasks?.[state.selectedIdx] || state?.tasks?.[0];
        const derivation = window.ReelsTaskDerivation;
        const found = derivation?.overlayMatchesTemplateSlot
            ? list.find(o => derivation.overlayMatchesTemplateSlot(o, id, templateTask?.overlays || []))
            : list.find(o => o.id === id || o._templateOverlayId === id);
        if (found) return found;
    }
    if (name) {
        const found = list.find(o => o.name === name);
        if (found) return found;
    }
    const targetIdx = idx != null ? parseInt(idx) : -1;
    if (targetIdx >= 0 && targetIdx < list.length) {
        return list[targetIdx];
    }
    return list[0];
}

function _createTaskFromTemplate(state, taskName) {
    const templateTask = state.tasks[state.selectedIdx] || state.tasks[0];
    if (templateTask) {
        const newTask = _cloneBatchTasks([templateTask])[0];
        const derivation = window.ReelsTaskDerivation;
        if (!derivation) throw new Error('任务派生模块未加载，请完全重启 VideoKit 后重试');
        // 此阶段先生成唯一任务 ID 并清空内容来源。覆层需要等调用方填入
        // 新文字卡片/滚动层后统一改 ID，才能完整重映射层间绑定。
        derivation.prepareDerivedTask(newTask, { overlays: false });
        newTask.baseName = taskName;
        newTask.fileName = `${taskName}.mp4`;
        newTask.bgPath = null;
        newTask.bgSrcUrl = null;
        newTask.audioPath = null;
        newTask.srtPath = null;
        newTask.segments = [];
        newTask.videoPath = null;
        newTask.srcUrl = null;
        // Filter out empty textcard and scroll overlays to prevent empty overlay boxes,
        // since they will be auto-created on demand with template styles when user inserts text.
        if (newTask.overlays) {
            newTask.overlays = newTask.overlays.filter(ov => {
                if (!ov) return false;
                // Keep fixed stickers/logos, and media overlays (images, videos)
                if (ov.fixed_text) return true;
                if (ov.type === 'image' || ov.type === 'video' || ov.type === 'pip') return true;
                return false; // Remove template-cloned empty textcard/scroll
            });
        }
        return newTask;
    } else {
        return {
            id: window.ReelsTaskDerivation?.createId?.('task'),
            baseName: taskName,
            fileName: `${taskName}.mp4`,
            bgPath: null, bgSrcUrl: null,
            audioPath: null, srtPath: null,
            segments: [],
            videoPath: null, srcUrl: null,
            overlays: [],
            aligned: false, bgScale: 100, bgDurScale: 100, audioDurScale: 100
        };
    }
}

function _finalizeDerivedTaskInstances(task) {
    const derivation = window.ReelsTaskDerivation;
    if (!derivation || !task) return task;
    derivation.rekeyOverlays(task);
    derivation.resolveOverlayBindings(task);
    return task;
}

function _cloneDerivedOverlay(templateOverlay) {
    const derivation = window.ReelsTaskDerivation;
    return derivation?.cloneOverlay
        ? derivation.cloneOverlay(templateOverlay)
        : JSON.parse(JSON.stringify(templateOverlay));
}

function _collectBatchOverlayTextSlots(overlays) {
    const slots = {
        title: [],
        body: [],
        footer: [],
        plain: [],
        scrollTitle: [],
        scrollBody: [],
    };
    (overlays || []).forEach(ov => {
        if (!ov || ov.fixed_text) return;
        if (ov.type === 'textcard' || !ov.type || ov.type === '') {
            if (ov.title_text != null) slots.title.push(ov.title_text);
            if (ov.body_text != null) slots.body.push(ov.body_text);
            if (ov.footer_text != null) slots.footer.push(ov.footer_text);
        } else if (ov.type === 'scroll') {
            if (ov.scroll_title != null) slots.scrollTitle.push(ov.scroll_title);
            if (ov.content != null) slots.scrollBody.push(ov.content);
        } else if (ov.type === 'text') {
            if (ov.content != null) slots.plain.push(ov.content);
        }
    });
    return slots;
}

function _shiftFirstTextSlot(...lists) {
    for (const list of lists) {
        if (list && list.length > 0) return list.shift();
    }
    return undefined;
}

function _applyOverlayField(task, fieldCategory, str) {
    if (!task.overlays) task.overlays = [];
    
    let targetId = null;
    let baseCategory = fieldCategory;
    const match = fieldCategory.match(/^(overlay_title|overlay_body|overlay_footer|scroll_title|scroll_body|overlay_flipper_enabled|overlay_flipper_duration|overlay_flipper_lines|overlay_flipper_effect|overlay_flipper_loop|overlay_flipper_transition_duration)_(.+)$/);
    if (match) {
        baseCategory = match[1];
        targetId = match[2];
    }
    
    const type = baseCategory.startsWith('scroll_') ? 'scroll' : 'textcard';

    if (baseCategory.startsWith('scroll_')) {
        let ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'scroll');
        if (!ov) {
            // Find template overlay to clone
            const state = window._reelsState;
            const templateTask = state.tasks[state.selectedIdx] || state.tasks[0];
            const templateList = templateTask ? (templateTask.overlays || []).filter(o => o && !o.fixed_text && o.type === 'scroll') : [];
            const templateOv = targetId ? templateList.find(o => o.id === targetId) : templateList[0];
            if (templateOv) {
                ov = _cloneDerivedOverlay(templateOv);
                ov.scroll_title = '';
                ov.content = '';
                ov.fixed_text = false;
                task.overlays.push(ov);
                window.ReelsTaskDerivation?.resolveOverlayBindings?.(task);
            } else {
                ov = window.ReelsOverlay ? window.ReelsOverlay.createScrollOverlay({ start: 0, end: 9999 }) : { scroll_title: '', content: '', type: 'scroll' };
                ov.scroll_title = '';
                ov.content = '';
                ov.fixed_text = false;
                task.overlays.push(ov);
            }
        }
        if (baseCategory === 'scroll_title') ov.scroll_title = str;
        if (baseCategory === 'scroll_body') ov.content = str;
    } else if (baseCategory.startsWith('overlay_')) {
        let ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'textcard');
        if (!ov) {
            // Find template overlay to clone
            const state = window._reelsState;
            const templateTask = state.tasks[state.selectedIdx] || state.tasks[0];
            const templateList = templateTask ? (templateTask.overlays || []).filter(o => o && !o.fixed_text && (o.type === 'textcard' || !o.type || o.type === '')) : [];
            const templateOv = targetId ? templateList.find(o => o.id === targetId) : templateList[0];
            if (templateOv) {
                ov = _cloneDerivedOverlay(templateOv);
                ov.title_text = '';
                ov.body_text = '';
                ov.footer_text = '';
                ov.fixed_text = false;
                task.overlays.push(ov);
                window.ReelsTaskDerivation?.resolveOverlayBindings?.(task);
            } else {
                ov = window.ReelsOverlay ? window.ReelsOverlay.createTextCardOverlay({ start: 0, end: 9999 }) : { title_text: '', body_text: '', footer_text: '', type: 'textcard' };
                ov.title_text = '';
                ov.body_text = '';
                ov.footer_text = '';
                ov.fixed_text = false;
                task.overlays.push(ov);
            }
        }
        if (baseCategory === 'overlay_title') ov.title_text = str;
        if (baseCategory === 'overlay_body') ov.body_text = str;
        if (baseCategory === 'overlay_footer') ov.footer_text = str;
        if (baseCategory === 'overlay_flipper_enabled') {
            const lower = String(str).trim().toLowerCase();
            ov.flipper_enabled = (lower === 'true' || lower === '1' || lower === 'yes' || lower === '启用' || lower === '开启' || lower === 'on');
        }
        if (baseCategory === 'overlay_flipper_duration') {
            ov.flipper_duration = parseFloat(str) || 2.0;
        }
        if (baseCategory === 'overlay_flipper_lines') {
            ov.flipper_lines = parseInt(str, 10) || 2;
        }
        if (baseCategory === 'overlay_flipper_effect') {
            const effect = String(str).trim().toLowerCase();
            if (effect === 'fade' || effect === '淡入' || effect === '淡入淡出') ov.flipper_effect = 'fade';
            else if (effect === 'slide' || effect === '向上滑动' || effect === '滑动') ov.flipper_effect = 'slide';
            else ov.flipper_effect = 'none';
        }
        if (baseCategory === 'overlay_flipper_loop') {
            const lower = String(str).trim().toLowerCase();
            ov.flipper_loop = (lower === 'true' || lower === '1' || lower === 'yes' || lower === '循环' || lower === 'on');
        }
        if (baseCategory === 'overlay_flipper_transition_duration') {
            const parsed = parseFloat(str);
            ov.flipper_transition_duration = isNaN(parsed) ? 0.3 : parsed;
        }
    } else if (baseCategory === 'cover_text') {
        if (!task.cover) task.cover = { enabled: true, overlays: [] };
        let ov = (task.cover.overlays && task.cover.overlays.length > 0) ? task.cover.overlays[0] : null;
        if (!ov) {
            ov = window.ReelsOverlay ? window.ReelsOverlay.createTextCardOverlay({ start: 0, end: 9999 }) : { title_text: '', body_text: '', footer_text: '', type: 'textcard' };
            task.cover.overlays = [ov];
        }
        ov.title_text = str;
    }
}

function _applyOverlayFieldWithTarget(task, fieldCategory, str, id, idx, type) {
    if (!task.overlays) task.overlays = [];
    let ov = _findBatchOverlayByIdOrIdx(task, id, null, idx, type);
    if (!ov) {
        const state = window._reelsState;
        const templateTask = state.tasks[state.selectedIdx] || state.tasks[0];
        const templateList = templateTask ? (templateTask.overlays || []).filter(o => o && !o.fixed_text && (type === 'scroll' ? o.type === 'scroll' : (o.type === 'textcard' || !o.type || o.type === ''))) : [];
        const templateOv = id ? templateList.find(o => o.id === id) : (idx != null ? templateList[idx] : templateList[0]);
        
        if (templateOv) {
            ov = JSON.parse(JSON.stringify(templateOv));
            if (type === 'scroll') {
                ov.scroll_title = '';
                ov.content = '';
            } else {
                ov.title_text = '';
                ov.body_text = '';
                ov.footer_text = '';
            }
            ov.fixed_text = false;
            task.overlays.push(ov);
        } else {
            if (type === 'scroll') {
                ov = window.ReelsOverlay ? window.ReelsOverlay.createScrollOverlay({ start: 0, end: 9999 }) : { scroll_title: '', content: '', type: 'scroll' };
                ov.scroll_title = '';
                ov.content = '';
                ov.fixed_text = false;
                task.overlays.push(ov);
            } else {
                ov = window.ReelsOverlay ? window.ReelsOverlay.createTextCardOverlay({ start: 0, end: 9999 }) : { title_text: '', body_text: '', footer_text: '', type: 'textcard' };
                ov.title_text = '';
                ov.body_text = '';
                ov.footer_text = '';
                ov.fixed_text = false;
                task.overlays.push(ov);
            }
        }
    }

    if (fieldCategory === 'overlay_title') ov.title_text = str;
    if (fieldCategory === 'overlay_body') ov.body_text = str;
    if (fieldCategory === 'overlay_footer') ov.footer_text = str;
    if (fieldCategory === 'scroll_title') ov.scroll_title = str;
    if (fieldCategory === 'scroll_body') ov.content = str;
    if (fieldCategory === 'overlay_flipper_enabled') {
        const lower = String(str).trim().toLowerCase();
        ov.flipper_enabled = (lower === 'true' || lower === '1' || lower === 'yes' || lower === '启用' || lower === '开启' || lower === 'on');
    }
    if (fieldCategory === 'overlay_flipper_duration') {
        ov.flipper_duration = parseFloat(str) || 2.0;
    }
    if (fieldCategory === 'overlay_flipper_lines') {
        ov.flipper_lines = parseInt(str, 10) || 2;
    }
    if (fieldCategory === 'overlay_flipper_effect') {
        const effect = String(str).trim().toLowerCase();
        if (effect === 'fade' || effect === '淡入' || effect === '淡入淡出') ov.flipper_effect = 'fade';
        else if (effect === 'slide' || effect === '向上滑动' || effect === '滑动') ov.flipper_effect = 'slide';
        else ov.flipper_effect = 'none';
    }
    if (fieldCategory === 'overlay_flipper_loop') {
        const lower = String(str).trim().toLowerCase();
        ov.flipper_loop = (lower === 'true' || lower === '1' || lower === 'yes' || lower === '循环' || lower === 'on');
    }
    if (fieldCategory === 'overlay_flipper_transition_duration') {
        const parsed = parseFloat(str);
        ov.flipper_transition_duration = isNaN(parsed) ? 0.3 : parsed;
    }
}

function _syncSelectedTaskOverlayMgrIfNeeded(taskIdx) {
    const state = window._reelsState;
    if (!state || state.selectedIdx !== taskIdx) return;
    const task = state.tasks && state.tasks[taskIdx];
    if (!task || !state.overlayProxy || !state.overlayProxy.overlayMgr) return;
    const mgr = state.overlayProxy.overlayMgr;
    // 同步前确保所有层都有唯一 ID 
    if (task.overlays) {
        task.overlays.forEach(ov => {
            if (!ov.id) {
                ov.id = 'ov_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now().toString(36);
            }
        });
    }
    mgr.overlays = task.overlays ? [...task.overlays] : [];
    if (state.overlayPanel) {
        state.overlayPanel.deselectOverlay();
        state.overlayPanel._refreshList();
    }
}

function _renderSubtitleTimeCell(task, idx) {
    try {
        const mode = task?.subtitleTimeMode || 'full';
        const slices = Array.isArray(task?.subtitleTimeSlices) ? task.subtitleTimeSlices : [];
        if (mode === 'split' && slices.length > 0) {
            const sliceLabels = slices.map((s, si) => {
                const label = s.label || String.fromCharCode(65 + si);
                const endStr = s.endSec != null && !isNaN(s.endSec) ? s.endSec + 's' : '尾';
                return `<div style="font-size:9px;color:#a0d0ff;line-height:1.3;">${_escHtml(label)}: ${s.startSec || 0}s→${endStr}</div>`;
            }).join('');
            return `<div class="rbt-subtime-cell" data-idx="${idx}" style="cursor:pointer;padding:2px 4px;border-radius:4px;background:rgba(76,158,255,0.15);border:1px solid rgba(76,158,255,0.3);" title="双击编辑时间切片">
                <div style="font-size:9px;color:#4c9eff;font-weight:bold;margin-bottom:1px;">⏱ 分段</div>
                ${sliceLabels}
            </div>`;
        }
        return `<div class="rbt-subtime-cell" data-idx="${idx}" style="cursor:pointer;padding:4px;border-radius:4px;color:#666;border:1px dashed #333;text-align:center;font-size:10px;" title="双击设置字幕时间切片">
            全时段
        </div>`;
    } catch (err) {
        console.error('[BatchTable] subtitleTimeSlice render error:', err);
        return `<div class="rbt-subtime-cell" data-idx="${idx}" style="cursor:pointer;padding:4px;border-radius:4px;color:#f66;font-size:10px;text-align:center;">渲染错误</div>`;
    }
}

function _updateSubtitleTimeCell(idx) {
    const task = window._reelsState?.tasks?.[idx];
    const container = _batchTableState.container;
    if (!task || !container) return;
    const td = container.querySelector(`tr[data-idx="${idx}"] .rbt-col-subtime`);
    if (td) td.innerHTML = _renderSubtitleTimeCell(task, idx);
    if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
    if (typeof _batchAutoSave === 'function') _batchAutoSave();
}

function _renderBatchRow(task, idx, subtitlePresets, cardTemplates, textcards, scrolls) {
  try {
    const globalBgVol = parseInt((document.getElementById('reels-bg-volume') || {}).value || '100');
    const globalBgmVol = parseInt((document.getElementById('reels-bgm-volume') || {}).value || '30');
    const bgName = _shortName(task.bgPath || task.videoPath || '');
    const audioName = _shortName(task.audioPath || '');
    const srtName = _shortName(task.srtPath || '');
    const txtName = _shortName(task.txtPath || '');
    const txtStatus = task.txtContent ? ((task.aligned || !!task.srtPath) ? '✅' : '⏳') : '';
    const matchedDifferentRow = Number.isInteger(task.autoMatchedSourceRow)
        && task.autoMatchedSourceRow !== idx;
    const matchBadgeStyle = matchedDifferentRow
        ? 'color:#1c1917;background:#f59e0b;border:1px solid #fcd34d;padding:2px 6px;border-radius:999px;font-size:10px;font-weight:800;box-shadow:0 0 8px rgba(245,158,11,.5);'
        : 'color:#052e16;background:#4ade80;border:1px solid #86efac;padding:2px 6px;border-radius:999px;font-size:10px;font-weight:800;';
    const bgmName = _shortName(task.bgmPath || '');
    const bgmMode = task.bgmMode || 'single';
    const bgmClipPool = task.bgmClipPool || [];
    let bgmContent = bgmName || '<span class="rbt-placeholder">拖拽/双击</span>';
    if (bgmMode === 'multi' && bgmClipPool.length > 0) {
        const activePool = Array.isArray(task.bgmClipActivePool)
            ? task.bgmClipActivePool.filter(p => bgmClipPool.includes(p))
            : [];
        const activeCount = activePool.length > 0 ? activePool.length : bgmClipPool.length;
        const orderLabel = (task.bgmClipOrder || 'random') === 'sequence' ? '顺序' : '随机';
        bgmContent = `<span style="font-size:10px;color:#e0b3ff;font-weight:700;" title="配乐池：${bgmClipPool.length} 首 · 选取方式: ${orderLabel}">🎵 配乐池(${activeCount}/${bgmClipPool.length})</span>`;
    }

    // 缩略图生成
    const bgMode = task.bgMode || 'single';
    const bgClipPool = task.bgClipPool || [];
    const bgClipSettings = task.bgClipSettings || {};
    let bgClipSettingsText = '';
    if (bgMode === 'multi' && bgClipPool.length > 0) {
        const parts = [];
        for (const p of bgClipPool) {
            const settings = bgClipSettings[p] || {};
            if (settings.trimStart != null || settings.trimEnd != null) {
                parts.push(`${settings.trimStart != null ? settings.trimStart : 0}-${settings.trimEnd != null ? settings.trimEnd : '尾'}s`);
            } else {
                parts.push('全段');
            }
        }
        bgClipSettingsText = parts.join(' | ');
    } else {
        bgClipSettingsText = '<span class="rbt-placeholder">-</span>';
    }
    const hasTrimSettings = Object.values(bgClipSettings).some(s => s && (s.trimStart != null || s.trimEnd != null));

    let bgContent = bgName || '<span class="rbt-placeholder">拖拽/双击</span>';
    const bgPath = task.bgPath || task.videoPath;

    if (bgMode === 'multi' && bgClipPool.length > 0) {
        // 多素材模式 — 显示素材池信息
        const transLabel = { none: '硬切', crossfade: '交叉淡化', fade_black: '黑场过渡', fade_white: '白场过渡', slide_left: '左滑', slide_right: '右滑', wipe: '擦除' }[task.bgTransition || 'crossfade'] || '交叉淡化';
        const activePool = Array.isArray(task.bgClipActivePool)
            ? task.bgClipActivePool.filter(p => bgClipPool.includes(p))
            : [];
        const activeCount = activePool.length > 0 ? activePool.length : bgClipPool.length;
        let orderLabel = '随机';
        if (task.bgClipOrder === 'sequence') orderLabel = '顺序';
        else if (task.bgClipOrder === 'random_align') orderLabel = '随机(卡点)';
        else if (task.bgClipOrder === 'sequence_align') orderLabel = '顺序(卡点)';
        const thumbs = bgClipPool.slice(0, 3).map(p => {
            if (!_rbtFileExists(p)) {
                return `<span title="${_escHtml(p)}" style="width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border-radius:3px;border:1px solid rgba(255,159,67,0.35);color:#ff9f43;background:rgba(255,159,67,0.12);font-size:11px;">!</span>`;
            }
            const url = _rbtMediaUrl(p);
            const isImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(p);
            const cachedThumb = !isImg ? (_rbtGetCachedVideoThumbUrl(p) || _RBT_THUMB_PLACEHOLDER) : '';
            return isImg
                ? `<img class="rbt-thumb-previewable" src="${_escHtml(url)}" style="width:24px;height:24px;object-fit:cover;border-radius:3px;border:1px solid #333;cursor:zoom-in;">`
                : `<img class="rbt-thumb-previewable rbt-video-thumb" data-file-path="${_escHtml(p)}" data-video-src="${_escHtml(url)}" data-seek-time="1" src="${_escHtml(cachedThumb)}" style="width:24px;height:24px;object-fit:cover;border-radius:3px;border:1px solid #333;background:#000;cursor:zoom-in;">`;
        }).join('');
        bgContent = `<div style="display:flex;flex-direction:column;gap:3px;">
            <div style="display:flex;align-items:center;gap:4px;">
                <span style="font-size:9px;background:#2a1f5e;color:#b8a0ff;padding:1px 5px;border-radius:3px;font-weight:600;">多素材</span>
                <span style="font-size:10px;color:#aaa;">启用${activeCount}/${bgClipPool.length} · ${orderLabel}</span>
                <button class="rbt-bg-pool-manage" data-idx="${idx}" style="font-size:9px;background:transparent;border:1px solid #444;color:#8af;border-radius:3px;padding:1px 5px;cursor:pointer;" title="管理素材池">管理</button>
            </div>
            <div style="display:flex;gap:2px;align-items:center;">${thumbs}${bgClipPool.length > 3 ? `<span style="font-size:9px;color:#666;">+${bgClipPool.length - 3}</span>` : ''}</div>
            <div style="font-size:9px;color:#888;">✨${transLabel} ${task.bgTransDur || 0.5}s</div>
        </div>`;
    } else if (bgPath) {
        const isImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(bgPath);
        if (!_rbtFileExists(bgPath)) {
            bgContent = _rbtMissingFileLabel(bgPath);
        } else {
            // 缩略图 URL: 跳过过期 blob URL，仅在有完整路径时生成 file:// URL
            let urlObj = '';
            if (task.bgSrcUrl && !String(task.bgSrcUrl).startsWith('blob:')) {
                urlObj = task.bgSrcUrl;
            } else if (bgPath.includes('/') || bgPath.includes('\\')) {
                urlObj = _rbtMediaUrl(bgPath);
            }
            if (isImg) {
                bgContent = `<div style="display:flex;align-items:center;gap:6px;">
                            <img class="rbt-thumb-previewable" src="${_escHtml(urlObj)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0;cursor:zoom-in;">
                            <span class="rbt-file-name" style="flex:1;font-size:10px;word-break:break-all;" title="${_escHtml(bgPath)}">${_escHtml(_shortName(bgPath))}</span>
                         </div>`;
            } else {
                const cachedThumb = _rbtGetCachedVideoThumbUrl(bgPath) || _RBT_THUMB_PLACEHOLDER;
                bgContent = `<div style="display:flex;align-items:center;gap:6px;">
                            <img class="rbt-thumb-previewable rbt-video-thumb" data-file-path="${_escHtml(bgPath)}" data-video-src="${_escHtml(urlObj)}" data-seek-time="1" src="${_escHtml(cachedThumb)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0;background:#000;cursor:zoom-in;">
                            <span class="rbt-file-name" style="flex:1;font-size:10px;word-break:break-all;" title="${_escHtml(bgPath)}">${_escHtml(_shortName(bgPath))}</span>
                         </div>`;
            }
        }
    } else {
        bgContent = `<span class="rbt-file-name" title="">${bgContent}</span>`;
    }

    // Hook缩略图生成
    const hookName = _shortName(task.hookFile || '');
    let hookContent = hookName || '<span class="rbt-placeholder">双击添加/设置</span>';
    if (task.hookFile) {
        const hIsImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(task.hookFile);
        const hUrlObj = _rbtMediaUrl(task.hookFile);
        const hCachedThumb = !hIsImg ? (_rbtGetCachedVideoThumbUrl(task.hookFile) || _RBT_THUMB_PLACEHOLDER) : '';
        hookContent = `<div class="rbt-hook-set" style="display:flex;align-items:center;gap:4px;cursor:pointer;" title="双击重新配置\n${_escHtml(task.hookFile)}">
                            ${hIsImg ?
                `<img class="rbt-thumb-previewable" src="${_escHtml(hUrlObj)}" style="width:28px;height:28px;object-fit:cover;border-radius:3px;flex-shrink:0;cursor:zoom-in;">` :
                `<img class="rbt-thumb-previewable rbt-video-thumb" data-file-path="${_escHtml(task.hookFile)}" data-video-src="${_escHtml(hUrlObj)}" data-seek-time="0.5" src="${_escHtml(hCachedThumb)}" style="width:28px;height:28px;object-fit:cover;border-radius:3px;flex-shrink:0;background:#111;cursor:zoom-in;">`
            }
                            <div style="flex:1;display:flex;flex-direction:column;min-width:0;line-height:1.2;">
                              <span class="rbt-file-name" style="font-size:10px;word-break:break-all;">${_escHtml(hookName)}</span>
                              <span style="font-size:9px;color:#a0d0ff;zoom:0.9;">${task.hookTransition && task.hookTransition !== 'none' ? `✨${task.hookTransition}(${task.hookTransDuration || 0.5}s)` : '⚡硬切'} | ${task.hookSpeed ? task.hookSpeed + 'x' : '1x'} <span style="color:#666;margin-left:2px;">(双击设置)</span></span>
                            </div>
                       </div>`;
    } else {
        hookContent = `<div class="rbt-hook-set" style="cursor:pointer;color:#888;font-size:10px;" title="双击配置Hook属性">➕ 双击设置</div>`;
    }

    // PIP缩略图生成
    const pipPath = task.pipPath || '';
    const pipName = _shortName(pipPath);
    let pipContent = pipName || '<span class="rbt-placeholder">拖拽/双击</span>';
    if (pipPath) {
        const isPipImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(pipPath);
        const pipUrlObj = _rbtMediaUrl(pipPath);
        if (isPipImg) {
            pipContent = `<div style="display:flex;align-items:center;gap:6px;">
                            <img class="rbt-thumb-previewable" src="${_escHtml(pipUrlObj)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0;cursor:zoom-in;">
                            <span class="rbt-file-name" style="flex:1;font-size:10px;word-break:break-all;" title="${_escHtml(pipPath)}">${_escHtml(pipName)}</span>
                         </div>`;
        } else {
            const pipCachedThumb = _rbtGetCachedVideoThumbUrl(pipPath) || _RBT_THUMB_PLACEHOLDER;
            pipContent = `<div style="display:flex;align-items:center;gap:6px;">
                            <img class="rbt-thumb-previewable rbt-video-thumb" data-file-path="${_escHtml(pipPath)}" data-video-src="${_escHtml(pipUrlObj)}" data-seek-time="1" src="${_escHtml(pipCachedThumb)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0;background:#000;cursor:zoom-in;">
                            <span class="rbt-file-name" style="flex:1;font-size:10px;word-break:break-all;" title="${_escHtml(pipPath)}">${_escHtml(pipName)}</span>
                         </div>`;
        }
    } else {
        pipContent = `<span class="rbt-file-name" style="width:100%;" title="">${pipContent}</span>`;
    }

    const subTplOptions = _renderSubtitlePresetOptions(subtitlePresets, task._subtitlePreset || '');
    const cardTplOptions = _renderOverlayPresetOptions(cardTemplates, task._overlayPresetName || '');

    // --- Cover Cover --- 
    const coverEnabled = task.cover && task.cover.enabled;
    const coverBgPath = task.cover && task.cover.bgPath ? task.cover.bgPath : '';
    let coverContent = '';
    if (coverEnabled) {
        if (coverBgPath) {
            const cIsImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(coverBgPath);
            const cUrlObj = _rbtMediaUrl(coverBgPath);
            const cCachedThumb = !cIsImg ? (_rbtGetCachedVideoThumbUrl(coverBgPath) || _RBT_THUMB_PLACEHOLDER) : '';
            coverContent = `<div class="rbt-cover-set" style="display:flex;align-items:center;gap:4px;cursor:pointer;" title="双击配置封面">
                                 ${cIsImg ?
                    `<img class="rbt-thumb-previewable" src="${_escHtml(cUrlObj)}" style="width:28px;height:28px;object-fit:cover;border-radius:3px;flex-shrink:0;">` :
                    `<img class="rbt-thumb-previewable rbt-video-thumb" data-file-path="${_escHtml(coverBgPath)}" data-video-src="${_escHtml(cUrlObj)}" data-seek-time="0.5" src="${_escHtml(cCachedThumb)}" style="width:28px;height:28px;object-fit:cover;border-radius:3px;flex-shrink:0;background:#111;">`
                }
                                 <div style="flex:1;min-width:0;font-size:9px;color:#ffd700;line-height:1.1;">✨封面开启<br>已设底图</div>
                            </div>`;
        } else {
            coverContent = `<div class="rbt-cover-set" style="cursor:pointer;color:#ffd700;font-size:10px;line-height:1.2;" title="双击配置封面"><span style="display:inline-block;background:rgba(255,215,0,0.15);padding:2px 4px;border-radius:2px;border:1px solid rgba(255,215,0,0.3);">✨封面开启<br><span style="font-size:8px;color:#aaa;">(取第1帧)</span></span></div>`;
        }
    } else {
        coverContent = `<div class="rbt-cover-set" style="cursor:pointer;color:#888;font-size:10px;display:flex;align-items:center;" title="双击添加封面"><span class="rbt-file-name" style="width:100%;"><span class="rbt-placeholder">拖拽/双击</span></span></div>`;
    }

    const coverOvl = (task.cover && task.cover.overlays && task.cover.overlays.length > 0) ? task.cover.overlays[0] : null;
    let coverTextStr = '';
    if (coverOvl) {
        coverTextStr = coverOvl.title_text || coverOvl.body_text || '<自定义>';
    }

    return `
        <tr data-idx="${idx}" class="rbt-row ${idx === (window._reelsState?.selectedIdx || -1) ? 'rbt-row-selected' : ''} ${task._justRefreshed ? 'rbt-row-refreshed' : ''}">
            <td class="rbt-col-drag rbt-grp-base"><span class="rbt-drag-handle" draggable="true" title="拖拽调整顺序">☰</span></td>
            <td class="rbt-col-chk rbt-grp-base" style="text-align:center;"><input type="checkbox" class="rbt-row-check" data-idx="${idx}" ${_batchTableState.selectedRows.has(idx) ? 'checked' : ''}></td>
            <td class="rbt-col-num rbt-grp-base">${idx + 1}</td>
            <td class="rbt-col-act rbt-grp-base">
                <button class="rbt-row-btn rbt-select-btn" data-idx="${idx}" title="预览此任务">👁</button>
                <button class="rbt-row-btn rbt-insert-btn" data-idx="${idx}" title="管理本任务插入素材">🎬</button>
                <button class="rbt-row-btn rbt-clone-btn" data-idx="${idx}" title="复制此行">📋</button>
                <button class="rbt-row-btn rbt-delete-btn" data-idx="${idx}" title="删除此行">🗑</button>
            </td>
            <td class="rbt-col-insert rbt-grp-base">
                <div style="display:flex;flex-direction:column;gap:2px;min-width:105px;font-size:9px;line-height:1.2;">
                    <button class="rbt-row-btn rbt-insert-btn" data-idx="${idx}" style="width:max-content;color:#86efac;" title="追加、重生成、清空或打开时间线微调">🎬 ${Array.isArray(task.insertClips) ? task.insertClips.length : 0} 段</button>
                    <span title="${_escHtml(task.insertMediaFolder || '')}" style="max-width:125px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${task.insertMediaFolder ? '#9ca3af' : '#666'};">${task.insertMediaFolder ? `📁 ${_escHtml(_shortName(task.insertMediaFolder))}` : '未设置文件夹'}</span>
                    ${Array.isArray(task.insertClips) && task.insertClips.length ? `<span style="color:#fbbf24;">自动 ${task.insertClips.filter(item => item.generatedBy === 'batch-silence').length} · 手工 ${task.insertClips.filter(item => item.generatedBy !== 'batch-silence').length}</span>` : ''}
                </div>
            </td>
            <td class="rbt-col-tpl rbt-grp-base">
                <div class="rbt-sub-tpl-trigger rbt-select" data-idx="${idx}" style="cursor:pointer;font-size:10px;padding:0 4px;height:22px;display:flex;align-items:center;justify-content:space-between;user-select:none;" title="点击选择字幕模板（含样式预览）">
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${task._subtitlePreset ? _escHtml(task._subtitlePreset) : '默认'}</span>
                    <span style="font-size:8px;margin-left:2px;flex-shrink:0;">▼</span>
                </div>
            </td>
            <td class="rbt-col-tpl rbt-grp-base">
                <select class="rbt-select rbt-card-tpl-select" data-idx="${idx}">
                    <option value="">无预设</option>
                    ${cardTplOptions}
                </select>
            </td>
            <td class="rbt-col-dur rbt-grp-base">
                <input type="number" class="rbt-textarea rbt-dur-input" data-idx="${idx}" min="0" max="600" step="0.5"
                    value="${task.customDuration ? task.customDuration : ''}" placeholder="自动" style="width:55px;text-align:center;" title="留空=自动跟随音频/视频时长，输入数字=自定义秒数">
            </td>
            <td class="rbt-col-exportname rbt-grp-base">
                <input type="text" class="rbt-textarea rbt-exportname-input" data-idx="${idx}" 
                    value="${_escHtml(task.exportName || '')}" placeholder="留空按命名规则" style="width:100px;font-size:11px;" title="手动输入时优先使用；留空则按底部导出设置里的命名规则生成">
            </td>
            <td class="rbt-col-cover-media rbt-grp-cover rbt-droppable" data-field="cover_media">
                <div style="display:flex;align-items:center;gap:2px;">
                    <div style="flex:1;min-width:0;overflow:hidden;">${coverContent}</div>
                    ${coverEnabled ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="cover_media" title="关闭封面功能">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-cover-text rbt-grp-cover rbt-droppable" data-field="cover_text">
                <div style="display:flex;align-items:center;gap:2px;">
                    <textarea class="rbt-textarea rbt-cover-text-input" data-idx="${idx}" rows="1" placeholder="暂无" title="封面主标题文案">${_escHtml(coverTextStr)}</textarea>
                </div>
            </td>
            <td class="rbt-col-hook rbt-grp-video rbt-droppable" data-field="hook">
                <div style="display:flex;align-items:center;gap:2px;">
                    <div style="flex:1;min-width:0;overflow:hidden;">${hookContent}</div>
                    ${task.hookFile ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="hook" title="清除前置Hook">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-bg rbt-grp-video rbt-droppable" data-field="bg">
                <div style="display:flex;align-items:center;gap:2px;">
                    <button class="rbt-bg-pool-manage" data-idx="${idx}" style="flex:0 0 auto;width:20px;height:20px;border-radius:4px;border:1px solid ${bgMode === 'multi' ? '#7c5cff' : '#333'};background:${bgMode === 'multi' ? '#2a1f5e' : 'transparent'};color:${bgMode === 'multi' ? '#b8a0ff' : '#666'};font-size:11px;cursor:pointer;padding:0;line-height:18px;" title="${bgMode === 'multi' ? '多素材模式 - 点击管理' : '单素材模式 - 点击切换到多素材'}">${bgMode === 'multi' ? '🎞' : '🔁'}</button>
                    <div style="flex:1;min-width:0;overflow:hidden;">${bgContent}</div>
                    ${(bgPath || (bgMode === 'multi' && bgClipPool.length > 0)) ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="bg" title="清除背景">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-clippool rbt-grp-video">
                <div style="display:flex;flex-direction:column;gap:3px;font-size:10px;">
                    <div style="display:flex;align-items:center;gap:3px;">
                        <button class="rbt-clip-pool-pick" data-idx="${idx}" style="padding:1px 5px;font-size:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#ccc;border-radius:3px;cursor:pointer;" title="选择片段文件夹">📁</button>
                        <span class="rbt-file-name" style="flex:1;min-width:0;" title="${_escHtml(task.clipPoolDir || '')}">${task.clipPoolDir ? _escHtml(_shortName(task.clipPoolDir)) : '<span class="rbt-placeholder">选择文件夹</span>'}</span>
                        ${task.clipPoolDir ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="clipPool" title="清除背景片段池">✕</button>` : ''}
                    </div>
                    <div style="display:flex;align-items:center;gap:3px;">
                        <select class="rbt-clip-order" data-idx="${idx}" style="flex:1;min-width:0;height:18px;font-size:10px;background:#181818;color:#aaa;border:1px solid #333;border-radius:3px;">
                            <option value="name" ${(task.clipOrder || 'name') === 'name' ? 'selected' : ''}>文件名</option>
                            <option value="mtime" ${task.clipOrder === 'mtime' ? 'selected' : ''}>修改时间</option>
                            <option value="random" ${task.clipOrder === 'random' ? 'selected' : ''}>随机</option>
                        </select>
                        <button class="rbt-clip-concat-btn" data-idx="${idx}" style="padding:1px 5px;font-size:10px;background:#255f85;color:#fff;border:none;border-radius:3px;cursor:pointer;" title="按当前排序拼接片段，并填入背景素材">拼接</button>
                    </div>
                    <div style="color:${task.concatVideoPath ? '#4ade80' : '#777'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_escHtml(task.concatVideoPath || '')}">
                        ${task.concatStatus === 'generating' ? '⏳ 拼接中...' : task.concatVideoPath ? `✅ ${_escHtml(_shortName(task.concatVideoPath))}` : `${Array.isArray(task.clipPool) ? task.clipPool.length : 0} 个片段`}
                    </div>
                </div>
            </td>
            <td class="rbt-col-bgclipsettings rbt-grp-video">
                <div class="rbt-bgclipsettings-cell" data-idx="${idx}" style="cursor:pointer;font-size:10px;padding:2px 4px;border-radius:4px;text-align:center;
                    ${hasTrimSettings ? 'background:rgba(124,92,255,0.15);border:1px dashed rgba(124,92,255,0.4);color:#b8a0ff;' : 'color:#666;'}">
                    ${bgClipSettingsText}
                </div>
            </td>
            <td class="rbt-col-bgscale rbt-grp-video">
                <div class="rbt-clutter-free-scale">
                    <div class="rbt-scale-display">${task.bgScale || 100}%</div>
                    <div class="rbt-scale-controls">
                        <div style="display:flex;align-items:center;gap:2px;">
                            <input type="number" class="rbt-bgscale-input" data-idx="${idx}" min="50" max="300" step="5"
                                   value="${task.bgScale || 100}" style="width:42px;text-align:center;font-size:10px;padding:1px 2px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;">
                            <span style="font-size:10px;color:#666;">%</span>
                        </div>
                        <input type="range" class="rbt-bgscale-slider" data-idx="${idx}" min="50" max="300" value="${task.bgScale || 100}"
                               style="width:60px;height:12px;accent-color:#4fc3f7;" title="背景图片缩放比例">
                    </div>
                </div>
            </td>
            <td class="rbt-col-bgdurscale rbt-grp-video">
                <div class="rbt-clutter-free-scale">
                    <div class="rbt-scale-display">${task.bgDurScale || 100}%</div>
                    <div class="rbt-scale-controls">
                        <div style="display:flex;align-items:center;gap:2px;">
                            <input type="number" class="rbt-bgdurscale-input" data-idx="${idx}" min="10" max="500" step="5"
                                   value="${task.bgDurScale || 100}" style="width:42px;text-align:center;font-size:10px;padding:1px 2px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;">
                            <span style="font-size:10px;color:#666;">%</span>
                        </div>
                        <input type="range" class="rbt-bgdurscale-slider" data-idx="${idx}" min="10" max="500" value="${task.bgDurScale || 100}"
                               style="width:60px;height:12px;accent-color:#81c784;" title="背景素材时长缩放比例">
                    </div>
                </div>
            </td>
            <td class="rbt-col-bgvol rbt-grp-video">
                <div class="rbt-clutter-free-scale">
                    <div class="rbt-scale-display" title="最终音量 = 全局背景音量 × 任务倍率">🔉 ${task.bgVideoVolume != null ? task.bgVideoVolume : '100'}% → ${Math.round((globalBgVol * (task.bgVideoVolume != null ? task.bgVideoVolume : 100) / 100) * 10) / 10}%</div>
                    <div class="rbt-scale-controls" style="flex-direction:row; inset:0;">
                        <span style="font-size:10px;color:#888;white-space:nowrap;">🔉</span>
                        <input type="range" class="rbt-bgvol-slider" data-idx="${idx}" data-is-null="${task.bgVideoVolume == null ? 'true' : 'false'}" min="0" max="1000" value="${task.bgVideoVolume != null ? task.bgVideoVolume : globalBgVol}"
                               style="flex:1; min-width:0; height:12px; accent-color:#4fc3f7;" title="任务背景音量倍率；最终 = 全局 × 倍率">
                        <span class="rbt-bgvol-label" style="font-size:10px;color:#888;min-width:56px;text-align:right;">${task.bgVideoVolume != null ? task.bgVideoVolume + '%倍率' : '100%默认'}</span>
                    </div>
                </div>
            </td>
            <td class="rbt-col-bgm rbt-grp-video rbt-droppable" data-field="bgm">
                <div style="display:flex;align-items:center;gap:4px;">
                    <input type="checkbox" class="rbt-bgm-check" data-idx="${idx}" title="勾选后可批量设置配乐">
                    <button class="rbt-bgm-pool-manage" data-idx="${idx}" style="flex:0 0 auto;width:20px;height:20px;border-radius:4px;border:1px solid ${bgmMode === 'multi' ? '#9b59b6' : '#333'};background:${bgmMode === 'multi' ? '#3e2250' : 'transparent'};color:${bgmMode === 'multi' ? '#e0b3ff' : '#666'};font-size:11px;cursor:pointer;padding:0;line-height:18px;" title="${bgmMode === 'multi' ? '多素材配乐池 - 点击管理' : '单素材配乐 - 点击切换到多素材'}">${bgmMode === 'multi' ? '🎵' : '🔁'}</button>
                    <span class="rbt-file-name rbt-bgm-pick" data-idx="${idx}" title="拖拽/双击 | ${_escHtml(task.bgmPath || '')}"
                          style="cursor:pointer;flex:1;">${bgmContent}</span>
                    ${(task.bgmPath || (bgmMode === 'multi' && bgmClipPool.length > 0)) ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="bgm" title="清除配乐">✕</button>` : ''}
                </div>
                <div class="rbt-clutter-free-scale" style="height:18px; margin-top:2px;">
                    <div class="rbt-scale-display" style="font-size:10px;">🎵 Vol: ${task.bgmVolume != null ? task.bgmVolume : '—'}%</div>
                    <div class="rbt-scale-controls" style="flex-direction:row; inset:0;">
                        <span style="font-size:10px;color:#888;white-space:nowrap;">🔉</span>
                        <input type="range" class="rbt-bgm-vol" data-idx="${idx}" data-is-null="${task.bgmVolume == null ? 'true' : 'false'}" min="0" max="1000" value="${task.bgmVolume != null ? task.bgmVolume : globalBgmVol}"
                               style="flex:1; min-width:0; height:12px; accent-color:#9b59b6;" title="配乐音量（双击滑杆或输入框可清空并跟随全局音量）">
                        <span class="rbt-bgm-vol-label" style="font-size:10px;color:#888;min-width:28px;text-align:right;">${task.bgmVolume != null ? task.bgmVolume + '%' : '全局(' + globalBgmVol + '%)'}</span>
                    </div>
                </div>
                <label style="display:flex;align-items:center;gap:5px;margin-top:3px;font-size:10px;color:#9ca3af;" title="从配乐的这个时间点开始播放，预览和正式导出都会生效">
                    起点 <input type="number" class="rbt-bgm-start" data-idx="${idx}" min="0" step="0.1" value="${Math.max(0, parseFloat(task.bgmStart) || 0).toFixed(1)}" style="width:62px;height:22px;padding:1px 4px;font-size:11px;"> 秒
                </label>
            </td>
            <td class="rbt-col-contentvideo rbt-grp-cv rbt-droppable" data-field="contentvideo">
                ${(() => {
            const cvPath = task.contentVideoPath || '';
            const cvName = _shortName(cvPath);
            let cvContent = cvName || '<span class="rbt-placeholder">拖拽/双击</span>';
            if (cvPath) {
                const isImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(cvPath);
                const cvUrl = _rbtMediaUrl(cvPath);
                const cvCachedThumb = !isImg ? (_rbtGetCachedVideoThumbUrl(cvPath) || _RBT_THUMB_PLACEHOLDER) : '';
                cvContent = `<div style="display:flex;align-items:center;gap:6px;">
                            ${isImg
                        ? `<img class="rbt-thumb-previewable" src="${_escHtml(cvUrl)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0;cursor:zoom-in;">`
                        : `<img class="rbt-thumb-previewable rbt-video-thumb" data-file-path="${_escHtml(cvPath)}" data-video-src="${_escHtml(cvUrl)}" data-seek-time="1" src="${_escHtml(cvCachedThumb)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0;background:#000;cursor:zoom-in;">`}
                            <span class="rbt-file-name" style="flex:1;font-size:10px;word-break:break-all;" title="${_escHtml(cvPath)}">${_escHtml(cvName)}</span>
                        </div>`;
            }
            return `<div style="display:flex;align-items:center;gap:2px;">
                        <div style="flex:1;min-width:0;overflow:hidden;">${cvContent}</div>
                        ${cvPath ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="contentvideo" title="清除内容视频">✕</button>` : ''}
                    </div>`;
        })()}
            </td>
            <td class="rbt-col-cvtrim rbt-grp-cv">
                <div class="rbt-cv-trim-cell" data-idx="${idx}" style="cursor:pointer;font-size:10px;padding:2px 4px;border-radius:4px;text-align:center;
                    ${task.contentVideoTrimStart != null || task.contentVideoTrimEnd != null
            ? 'background:rgba(76,158,255,0.15);color:#4c9eff;border:1px solid rgba(76,158,255,0.3);'
            : 'color:#666;border:1px dashed #333;'}"
                    title="双击设置时段裁切区间">
                    ${task.contentVideoTrimStart != null || task.contentVideoTrimEnd != null
            ? `✂️ ${task.contentVideoTrimStart != null ? Number(task.contentVideoTrimStart).toFixed(1) : '0'}s → ${task.contentVideoTrimEnd != null ? Number(task.contentVideoTrimEnd).toFixed(1) : '尾'}`
            : '全段'}
                </div>
            </td>
            <td class="rbt-col-cvcrop rbt-grp-cv">
                <div class="rbt-cv-crop-cell" data-idx="${idx}" style="cursor:pointer;font-size:10px;padding:2px 4px;border-radius:4px;text-align:center;
                    ${task.contentVideoCrop
            ? 'background:rgba(76,158,255,0.15);color:#4c9eff;border:1px solid rgba(76,158,255,0.3);'
            : 'color:#666;border:1px dashed #333;'}"
                    title="双击设置画面裁切范围 (左,上,宽,高 %)">
                    ${task.contentVideoCrop ? `📐 ${task.contentVideoCrop}%` : '全画面'}
                </div>
            </td>
            <td class="rbt-col-cvblurbg rbt-grp-cv" style="text-align:center; font-size:10px;">
                <div style="display:flex; flex-direction:column; align-items:center; gap:2px;">
                    <select class="rbt-cvbgmode-select" data-idx="${idx}" style="font-size:10px; background:#181818; color:#ccc; border:1px solid #333; border-radius:3px; padding:1px 2px; width:65px;">
                        <option value="none" ${(!task.contentVideoBlurBg && !task.contentVideoDirectBg) ? 'selected' : ''}>常规/无</option>
                        <option value="blur" ${task.contentVideoBlurBg ? 'selected' : ''}>毛玻璃</option>
                        <option value="direct" ${task.contentVideoDirectBg ? 'selected' : ''}>直接背景</option>
                    </select>
                    ${task.contentVideoBlurBg ? `<span style="color:#8af;font-size:9px;scale:0.85;" title="模糊半径, 亮度比例">${task.contentVideoBlur != null ? task.contentVideoBlur : 40}px, ${task.contentVideoBrightness != null ? task.contentVideoBrightness : 60}%</span>` : ''}
                </div>
            </td>
            <td class="rbt-col-cvscale rbt-grp-cv">
                <div class="rbt-clutter-free-scale">
                    <div class="rbt-scale-display">${task.contentVideoScale || 100}%</div>
                    <div class="rbt-scale-controls">
                        <div style="display:flex;align-items:center;gap:2px;">
                            <input type="number" class="rbt-cvscale-input" data-idx="${idx}" min="10" max="300" step="5"
                                   value="${task.contentVideoScale || 100}" style="width:42px;text-align:center;font-size:10px;padding:1px 2px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;">
                            <span style="font-size:10px;color:#666;">%</span>
                        </div>
                        <input type="range" class="rbt-cvscale-slider" data-idx="${idx}" min="10" max="300" value="${task.contentVideoScale || 100}"
                               style="width:60px;height:12px;accent-color:#00bcd4;" title="内容视频缩放比例 (100%=自动适配宽度)">
                    </div>
                </div>
            </td>
            <td class="rbt-col-cvpos rbt-grp-cv">
                <div style="display:flex;flex-direction:column;gap:2px;font-size:10px;">
                    <div style="display:flex;align-items:center;gap:2px;">
                        <span style="color:#666;min-width:12px;">X:</span>
                        <input type="text" class="rbt-cvpos-x" data-idx="${idx}" value="${task.contentVideoX || 'center'}"
                               style="width:50px;font-size:10px;padding:1px 3px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;text-align:center;"
                               placeholder="center" title="center = 水平居中, 或输入像素值">
                    </div>
                    <div style="display:flex;align-items:center;gap:2px;">
                        <span style="color:#666;min-width:12px;">Y:</span>
                        <input type="text" class="rbt-cvpos-y" data-idx="${idx}" value="${task.contentVideoY || 'center'}"
                               style="width:50px;font-size:10px;padding:1px 3px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;text-align:center;"
                               placeholder="center" title="center = 垂直居中, 或输入像素值">
                    </div>
                </div>
            </td>
            <td class="rbt-col-cvvol rbt-grp-cv">
                <div class="rbt-clutter-free-scale">
                    <div class="rbt-scale-display">🔊 ${task.contentVideoVolume != null ? task.contentVideoVolume : 100}%</div>
                    <div class="rbt-scale-controls">
                        <div style="display:flex;align-items:center;gap:2px;">
                            <input type="number" class="rbt-cvvol-input" data-idx="${idx}" min="0" max="1000" step="5"
                                   value="${task.contentVideoVolume != null ? task.contentVideoVolume : 100}" style="width:42px;text-align:center;font-size:10px;padding:1px 2px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;">
                            <span style="font-size:10px;color:#666;">%</span>
                        </div>
                        <input type="range" class="rbt-cvvol-slider" data-idx="${idx}" min="0" max="1000" value="${task.contentVideoVolume != null ? task.contentVideoVolume : 100}"
                               style="width:60px;height:12px;accent-color:#00bcd4;" title="内容视频音量 (0=静音, 100=原始, 1000=放大10倍)">
                    </div>
                </div>
            </td>
            <td class="rbt-col-ai_script rbt-grp-audio">
                <div style="position:relative;">
                    <textarea class="rbt-textarea rbt-ai-script-input" data-idx="${idx}" rows="2" placeholder="粘贴需要被处理的原文案..." title="双击放大编辑">${_escHtml(task.aiScript || '')}</textarea>
                    ${task.aiScript ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="ai_script" title="清除原文案" style="position:absolute;top:2px;right:2px;">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-tts_text rbt-grp-audio">
                <button type="button" class="btn btn-secondary" onclick="event.stopPropagation();reelsEditWritingTask(${idx})" style="font-size:11px;padding:3px 6px;margin-bottom:4px;">✎ 打字机标题 / 正文（SRT匹配）</button>
                <div style="position:relative;">
                    <textarea class="rbt-textarea rbt-tts-text-input" data-idx="${idx}" rows="2" placeholder="粘贴配音文案..." 
                              style="${task.aiTtsDiffWarning ? 'border:1px solid #ef4444; background:rgba(239, 68, 68, 0.1);' : ''}"
                              title="${task.aiTtsDiffWarning ? '⚠️ 警告：检测到配音文案与原文存在字符差异！请检查是否发生了改词！' : '双击放大编辑'}">${_escHtml(task.ttsText || '')}</textarea>
                    ${task.ttsText ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="tts_text" title="清除文案" style="position:absolute;top:2px;right:2px;">✕</button>` : ''}
                </div>
                <div style="display:flex;align-items:center;min-height:14px;margin-top:2px;">
                    ${task.aiTtsDiffWarning ? `<div class="diff-warning-badge" style="margin-top:6px;font-size:12px;color:#ef4444;font-weight:bold;text-align:right;">⚠️词汇变动警告 <span class="diff-modal-btn" data-field="tts" data-idx="${idx}" style="color:#3b82f6;cursor:pointer;margin-left:8px;text-decoration:underline;">[🔍比对]</span></div>` : ''}
                </div>
            </td>
            <td class="rbt-col-txtcontent rbt-grp-audio">
                <div style="position:relative;">
                    <textarea class="rbt-textarea rbt-txtcontent-input" data-idx="${idx}" rows="2" 
                              ${task.srtPath ? 'disabled placeholder="[已使用外部SRT]"' : 'placeholder="粘贴或输入文案..."'} 
                              style="${task.srtPath ? 'opacity:0.3;cursor:not-allowed;' : ''} ${task.aiTextDiffWarning ? 'border:1px solid #ef4444; background:rgba(239, 68, 68, 0.1);' : ''}"
                              title="${task.aiTextDiffWarning ? '⚠️ 警告：AI断行产生的文本与【人声-原文案】存在字符差异。可能发生了改词或删词，请仔细检查比对！\n\n如有错误请直接修改。' : (task.srtPath ? '外部SRT优先级更高，文案处于禁用状态' : '双击放大编辑')}">${_escHtml(task.txtContent || '')}</textarea>
                    ${task.txtContent && !task.srtPath ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="txt" title="清除文案" style="position:absolute;top:2px;right:2px;">✕</button>` : ''}
                </div>
                <div style="display:flex;align-items:center;gap:4px;margin-top:2px;min-height:14px;">
                    ${(() => {
                        const srcDesc = task.alignSource?.includes('deepgram') ? ' (Deepgram 🎙️)'
                            : task.alignSource?.includes('groq') ? ' (Groq 🎙️)'
                            : (task.alignSource === 'gladia_fresh' || task.alignSource === 'gladia') ? ' (Gladia 🎙️)'
                            : task.alignSource?.includes('cache') ? ' (缓存 📦)'
                            : (task.alignSource?.includes('fresh') ? ' (重新转录 🎙️)' : '');
                        const titleText = task.alignedAt ? `对齐时间: ${task.alignedAt}${srcDesc}${task.alignMatchedText ? ' | 匹配: ' + task.alignMatchedText : ''}` : '';
                        const textHtml = (task.aligned || !!task.srtPath)
                            ? `✅ 已对齐${srcDesc}${task.alignMatchedText ? ' <span style="' + matchBadgeStyle + '">' + _escHtml(task.alignMatchedText) + '</span>' : ''}${task.alignedAt ? ' <span style="color:#888;font-size:9px;">' + task.alignedAt + '</span>' : ''}`
                            : task.txtContent && !task.srtPath ? '⏳ 待对齐' : '';
                        const colorStyle = (task.aligned || !!task.srtPath) ? '#4ade80' : task.txtContent && !task.srtPath ? '#facc15' : '#666';
                        return `<span style="font-size:10px;color:${colorStyle};" title="${titleText}">${textHtml}</span>`;
                    })()}
                    <button class="rbt-row-realign-btn" data-idx="${idx}" data-force="0" title="单独重新查找文案并生成SRT" style="padding:1px 4px;font-size:9px;background:#243447;border:1px solid #36506b;color:#9fd0ff;border-radius:3px;cursor:pointer;">重找</button>
                    <button class="rbt-row-realign-btn" data-idx="${idx}" data-force="1" title="单独强制重新转录，然后重新查找文案并生成SRT" style="padding:1px 4px;font-size:9px;background:#3a2d1d;border:1px solid #6b4d22;color:#ffd08a;border-radius:3px;cursor:pointer;">强重找</button>
                    <button class="rbt-row-clear-cache-btn" data-idx="${idx}" title="单独清除该任务的识别缓存" style="padding:1px 4px;font-size:9px;background:#3d2424;border:1px solid #6b3636;color:#fca5a5;border-radius:3px;cursor:pointer;">🧹清缓存</button>
                    ${task.aiTextDiffWarning ? `<div class="diff-warning-badge" style="margin-top:6px;font-size:12px;color:#ef4444;font-weight:bold;text-align:right;">⚠️词汇变动警告 <span class="diff-modal-btn" data-field="txt" data-idx="${idx}" style="color:#3b82f6;cursor:pointer;margin-left:8px;text-decoration:underline;">[🔍比对]</span></div>` : ''}
                </div>
            </td>
            <td class="rbt-col-tts_voice rbt-grp-audio">
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <input type="text" list="rbt-tts-voices-list" class="rbt-input rbt-tts-voice-input" data-idx="${idx}" value="${_escHtml(task.ttsVoiceId || '')}" placeholder="选择或输入 Voice ID" title="选择音色；微软音色以 edge: 开头，其他 ID 使用 ElevenLabs" style="width:150px;font-size:10px;padding:2px;border:1px solid #333;background:#111;color:#fff;">
                    <button class="rbt-btn rbt-tts-gen-btn" data-idx="${idx}" style="font-size:10px;padding:2px;background:#5e5ce6;color:#fff;border:none;">▶ 生成配音</button>
                    ${task.status === 'generating' ? '<span style="font-size:10px;color:#ffd43b;">Generating...</span>' : task.status === 'success' ? '<span style="font-size:10px;color:#4ade80;font-weight:bold;">✅ 最新生成完成</span>' : task.status === 'error' ? '<span style="font-size:10px;color:#ff3333;">❌ 出错</span>' : ''}
                </div>
            </td>
            <td class="rbt-col-srt rbt-grp-audio rbt-droppable" data-field="srt">
                <div style="display:flex;align-items:center;gap:2px;">
                    <span class="rbt-file-name" style="flex:1" title="拖拽/双击 | ${_escHtml(task.srtPath || '')}">${srtName || '<span class="rbt-placeholder">拖拽/双击</span>'}</span>
                    ${srtName ? `<button class="rbt-srt-edit-btn" data-idx="${idx}" title="编辑这套外部SRT文件内容" style="padding:0 4px;font-size:10px;background:#384050;border:1px solid #556;color:#ccc;cursor:pointer;border-radius:3px;">✎ 直接修改</button><button class="rbt-field-clear" data-idx="${idx}" data-field="srt" title="清除字幕">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-audio rbt-grp-audio rbt-droppable" data-field="audio">
                <div style="display:flex;align-items:center;gap:2px;">
                    ${audioName ? `<button class="rbt-table-play-btn" data-src="${_escHtml(task.audioPath)}" style="background:none;border:none;cursor:pointer;font-size:14px;padding:0 4px;" title="点击试听">▶️</button>` : ''}
                     <span class="rbt-file-name" style="flex:1" title="拖拽/双击 | ${_escHtml(task.audioPath || '')}">${audioName || '<span class="rbt-placeholder">拖拽/双击</span>'}</span>
                     ${audioName ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="audio" title="清除人声">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-voicevol rbt-grp-audio">
                <div class="rbt-clutter-free-scale">
                    <div class="rbt-scale-display">🎙 ${task.voiceVolume != null ? task.voiceVolume : '—'}%</div>
                    <div class="rbt-scale-controls" style="flex-direction:row; inset:0;">
                        <span style="font-size:10px;color:#888;white-space:nowrap;">🎙</span>
                        <input type="range" class="rbt-voicevol-slider" data-idx="${idx}" data-is-null="${task.voiceVolume == null ? 'true' : 'false'}" min="0" max="1000" value="${task.voiceVolume != null ? task.voiceVolume : 100}"
                               style="flex:1; min-width:0; height:12px; accent-color:#b388ff;" title="人声-音频音量（留空=跟随全局设置）">
                        <span class="rbt-voicevol-label" style="font-size:10px;color:#888;min-width:28px;text-align:right;">${task.voiceVolume != null ? task.voiceVolume + '%' : '全局'}</span>
                    </div>
                </div>
            </td>
            <td class="rbt-col-audiodurscale rbt-grp-audio">
                <div class="rbt-clutter-free-scale">
                    <div class="rbt-scale-display">${task.audioDurScale || 100}%</div>
                    <div class="rbt-scale-controls">
                        <div style="display:flex;align-items:center;gap:2px;">
                            <input type="number" class="rbt-audiodurscale-input" data-idx="${idx}" min="10" max="500" step="5"
                                   value="${task.audioDurScale || 100}" style="width:42px;text-align:center;font-size:10px;padding:1px 2px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;">
                            <span style="font-size:10px;color:#666;">%</span>
                        </div>
                        <input type="range" class="rbt-audiodurscale-slider" data-idx="${idx}" min="10" max="500" value="${task.audioDurScale || 100}"
                               style="width:60px;height:12px;accent-color:#ffb74d;" title="人声变速比例">
                    </div>
                </div>
            </td>
            <td class="rbt-col-pip rbt-grp-ovl rbt-droppable" data-field="pip">
                <div style="display:flex;align-items:center;gap:2px;">
                    <div style="flex:1;min-width:0;overflow:hidden;display:flex;">${pipContent}</div>
                    ${task.pipPath ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="pip" title="清除图像覆层">✕</button>` : ''}
                </div>
            </td>
            ${textcards.map((templateOv, oIdx) => {
                const ov = _findBatchOverlayByIdOrIdx(task, templateOv.id, templateOv.name, oIdx, 'textcard');
                const title = ov ? (ov.title_text || '') : '';
                const body = ov ? (ov.body_text || '') : '';
                const footer = ov ? (ov.footer_text || '') : '';
                const flipperEnabled = ov ? !!ov.flipper_enabled : !!templateOv.flipper_enabled;
                const flipperDuration = ov ? (ov.flipper_duration ?? 2.0) : (templateOv.flipper_duration ?? 2.0);
                const flipperLines = ov ? (ov.flipper_lines ?? 2) : (templateOv.flipper_lines ?? 2);
                const flipperEffect = ov ? (ov.flipper_effect || 'none') : (templateOv.flipper_effect || 'none');
                const flipperLoop = ov ? !!ov.flipper_loop : !!templateOv.flipper_loop;
                const flipperTransitionDuration = ov ? (ov.flipper_transition_duration ?? 0.3) : (templateOv.flipper_transition_duration ?? 0.3);
                return `
                    <td class="rbt-col-title rbt-grp-ovl" data-card-id="${templateOv.id}">
                        <textarea class="rbt-textarea rbt-title-input" data-idx="${idx}" data-card-id="${templateOv.id}" data-card-idx="${oIdx}" rows="2" title="双击放大编辑" style="${title === '标题文字' ? 'color:#ff5555;' : ''}">${_escHtml(title)}</textarea>
                    </td>
                    <td class="rbt-col-body rbt-grp-ovl" data-card-id="${templateOv.id}">
                        <textarea class="rbt-textarea rbt-body-input" data-idx="${idx}" data-card-id="${templateOv.id}" data-card-idx="${oIdx}" rows="2" title="双击放大编辑" style="${body === '内容文字' ? 'color:#ff5555;' : ''}">${_escHtml(body)}</textarea>
                    </td>
                    <td class="rbt-col-footer rbt-grp-ovl" data-card-id="${templateOv.id}">
                        <textarea class="rbt-textarea rbt-footer-input" data-idx="${idx}" data-card-id="${templateOv.id}" data-card-idx="${oIdx}" rows="2" title="双击放大编辑">${_escHtml(footer)}</textarea>
                    </td>
                    <td class="rbt-col-flipper-enabled rbt-grp-ovl" data-card-id="${templateOv.id}">
                        <input type="text" class="rbt-input rbt-flipper-enabled-input" data-idx="${idx}" data-card-id="${templateOv.id}" data-card-idx="${oIdx}" value="${flipperEnabled ? '启用' : '关闭'}" placeholder="启用/关闭" style="width:100%;text-align:center;font-size:11px;">
                    </td>
                    <td class="rbt-col-flipper-duration rbt-grp-ovl" data-card-id="${templateOv.id}">
                        <input type="text" class="rbt-input rbt-flipper-duration-input" data-idx="${idx}" data-card-id="${templateOv.id}" data-card-idx="${oIdx}" value="${flipperDuration}" placeholder="2.0" style="width:100%;text-align:center;font-size:11px;">
                    </td>
                    <td class="rbt-col-flipper-lines rbt-grp-ovl" data-card-id="${templateOv.id}">
                        <input type="text" class="rbt-input rbt-flipper-lines-input" data-idx="${idx}" data-card-id="${templateOv.id}" data-card-idx="${oIdx}" value="${flipperLines}" placeholder="2" style="width:100%;text-align:center;font-size:11px;">
                    </td>
                    <td class="rbt-col-flipper-effect rbt-grp-ovl" data-card-id="${templateOv.id}">
                        <input type="text" class="rbt-input rbt-flipper-effect-input" data-idx="${idx}" data-card-id="${templateOv.id}" data-card-idx="${oIdx}" value="${flipperEffect}" placeholder="none/fade/slide" style="width:100%;text-align:center;font-size:11px;">
                    </td>
                    <td class="rbt-col-flipper-loop rbt-grp-ovl" data-card-id="${templateOv.id}">
                        <input type="text" class="rbt-input rbt-flipper-loop-input" data-idx="${idx}" data-card-id="${templateOv.id}" data-card-idx="${oIdx}" value="${flipperLoop ? '循环' : '不循环'}" placeholder="循环/不循环" style="width:100%;text-align:center;font-size:11px;">
                    </td>
                    <td class="rbt-col-flipper-transition-duration rbt-grp-ovl" data-card-id="${templateOv.id}">
                        <input type="text" class="rbt-input rbt-flipper-transition-duration-input" data-idx="${idx}" data-card-id="${templateOv.id}" data-card-idx="${oIdx}" value="${flipperTransitionDuration}" placeholder="0.3" style="width:100%;text-align:center;font-size:11px;">
                    </td>
                `;
            }).join('')}
            ${scrolls.map((templateOv, oIdx) => {
                const ov = _findBatchOverlayByIdOrIdx(task, templateOv.id, templateOv.name, oIdx, 'scroll');
                const scrollTitle = ov ? (ov.scroll_title || '') : '';
                const scrollBody = ov ? (ov.content || '') : '';
                return `
                    <td class="rbt-col-scroll-title rbt-grp-ovl" data-scroll-id="${templateOv.id}">
                        <textarea class="rbt-textarea rbt-scroll-title-input" data-idx="${idx}" data-scroll-id="${templateOv.id}" data-scroll-idx="${oIdx}" rows="2" title="双击放大编辑">${_escHtml(scrollTitle)}</textarea>
                    </td>
                    <td class="rbt-col-scroll-body rbt-grp-ovl" data-scroll-id="${templateOv.id}">
                        <textarea class="rbt-textarea rbt-scroll-body-input" data-idx="${idx}" data-scroll-id="${templateOv.id}" data-scroll-idx="${oIdx}" rows="2" title="双击放大编辑">${_escHtml(scrollBody)}</textarea>
                    </td>
                `;
            }).join('')}
            <td class="rbt-col-subtime rbt-grp-ovl">
                ${_renderSubtitleTimeCell(task, idx)}
            </td>
        </tr>
    `;
  } catch (renderErr) {
    console.error(`[BatchTable] _renderBatchRow(${idx}) error:`, renderErr);
    return `<tr data-idx="${idx}"><td colspan="30" style="color:#f66;padding:8px;">⚠️ 行 ${idx+1} 渲染错误: ${renderErr.message}</td></tr>`;
  }
}


// ═══════════════════════════════════════════════════════
// 5. Event Binding
// ═══════════════════════════════════════════════════════

function _bindBatchTableEvents() {
    const container = _batchTableState.container;

    // Toggle actions panel
    const toggleActionsBtn = container.querySelector('#rbt-toggle-actions-btn');
    if (toggleActionsBtn) {
        toggleActionsBtn.addEventListener('click', () => {
            _batchTableState.actionsCollapsed = !_batchTableState.actionsCollapsed;
            _renderBatchTable();
        });
    }

    // Toggle modern UI mode
    const toggleUIModeBtn = container.querySelector('#rbt-toggle-ui-mode-btn');
    if (toggleUIModeBtn) {
        toggleUIModeBtn.addEventListener('click', () => {
            // _batchTableState.useModernUI = !_batchTableState.useModernUI; 废弃
            _renderBatchTable();
        });
    }

    // Toggle "更多操作" dropdown
    container.querySelector('#rbt-more-tools-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const dd = container.querySelector('#rbt-more-tools-dropdown');
        if (dd) dd.classList.toggle('show');
    });

    // Close
    container.querySelector('#rbt-close-btn')?.addEventListener('click', () => reelsToggleBatchTable({ saveOnClose: false }));
    container.querySelector('#rbt-discard-btn')?.addEventListener('click', () => reelsToggleBatchTable({ saveOnClose: false }));
    container.querySelector('#reels-naming-mode')?.addEventListener('change', async (e) => {
        const val = e.target.value || 'text';
        localStorage.setItem('reels_naming_mode', val);
        const outerSelect = document.getElementById('reels-export-naming-mode-outer');
        if (outerSelect) {
            outerSelect.value = val;
        }
        const configBtnOuter = document.getElementById('reels-export-naming-config-btn');
        if (configBtnOuter) {
            configBtnOuter.style.display = (val === 'index' || val === 'date-auto') ? 'inline-block' : 'none';
        }
        const configBtnInner = container.querySelector('#reels-naming-config-btn');
        if (configBtnInner) {
            configBtnInner.style.display = (val === 'index' || val === 'date-auto') ? 'inline-block' : 'none';
        }
        if (val === 'index' || val === 'date-auto') {
            const ok = await showNamingSettingsDialog(val);
            if (!ok) {
                localStorage.setItem('reels_naming_mode', 'text');
                e.target.value = 'text';
                if (outerSelect) outerSelect.value = 'text';
                if (configBtnOuter) configBtnOuter.style.display = 'none';
                if (configBtnInner) configBtnInner.style.display = 'none';
            }
        }
    });
    container.querySelector('#reels-naming-config-btn')?.addEventListener('click', () => {
        const mode = localStorage.getItem('reels_naming_mode') || 'text';
        if (mode === 'index' || mode === 'date-auto') {
            showNamingSettingsDialog(mode);
        }
    });
    container.querySelector('#rbt-apply-btn')?.addEventListener('click', () => {
        reelsToggleBatchTable({ saveOnClose: true });
    });



    // ── Language searchable picker ──
    _initLangPicker(container);


    // ══ Tab bar events ══
    const tabBar = container.querySelector('.rbt-tabs-scroll');
    if (tabBar) {
        tabBar.addEventListener('click', (e) => {
            // Clear all tabs
            if (e.target.closest('.rbt-tab-clear-all')) {
                if (!confirm(`确定清空删除所有 ${_batchTableState.tabs.length} 个标签页及全部任务？\n\n此操作不可撤销！`)) return;
                window.reelsClearPersistedBatchTasks();
                _skipNextApply = true;
                _renderBatchTable();
                return;
            }
            // ★ 应用标签页 → 合并到当前任务列表
            if (e.target.closest('.rbt-tab-merge')) {
                _showMergeTabsModal();
                return;
            }
            // Add new tab
            if (e.target.closest('.rbt-tab-add')) {
                _addTab();
                return;
            }
            // Close tab
            const closeEl = e.target.closest('.rbt-tab-close');
            if (closeEl) {
                e.stopPropagation();
                _removeTab(closeEl.dataset.tabId);
                return;
            }
            // Switch tab
            const tabEl = e.target.closest('.rbt-tab');
            if (tabEl && tabEl.dataset.tabId) {
                _switchToTab(tabEl.dataset.tabId);
            }
        });
        tabBar.addEventListener('dblclick', (e) => {
            const tabEl = e.target.closest('.rbt-tab');
            if (tabEl && tabEl.dataset.tabId && !tabEl.classList.contains('rbt-tab-add')) {
                _renameTab(tabEl.dataset.tabId);
            }
        });
    }

    // ══ Global Hover Preview ══
    let hoverTooltip = container.querySelector('#rbt-hover-preview-tooltip');
    if (!hoverTooltip) {
        hoverTooltip = document.createElement('div');
        hoverTooltip.id = 'rbt-hover-preview-tooltip';
        hoverTooltip.style.cssText = 'position:fixed; z-index:999999; display:none; background:#000; border:1px solid #48548a; border-radius:8px; box-shadow:0 12px 40px rgba(0,0,0,0.8); overflow:hidden; pointer-events:none;';
        document.body.appendChild(hoverTooltip); // attach to body to prevent clipping
    }

    let previewTimeout;
    const stopHoverPreviewVideo = () => {
        if (!hoverTooltip) return;
        const oldVideo = hoverTooltip.querySelector('video');
        if (oldVideo) {
            try {
                oldVideo.pause();
                oldVideo.removeAttribute('src');
                oldVideo.load();
            } catch (_) {}
        }
        hoverTooltip.style.display = 'none';
        hoverTooltip.innerHTML = '';
    };
    container.addEventListener('mouseover', (e) => {
        const target = e.target;
        if (target.classList.contains('rbt-thumb-previewable')) {
            clearTimeout(previewTimeout);
            previewTimeout = setTimeout(() => {
                stopHoverPreviewVideo();
                const videoSrcAttr = target.dataset?.videoSrc || (target.tagName === 'VIDEO' ? target.getAttribute('src') : '');
                const src = videoSrcAttr || target.getAttribute('src');
                if (!src) return;

                const isVideo = Boolean(videoSrcAttr) || target.tagName === 'VIDEO' || target.classList.contains('rbt-video-thumb');
                const pureSrc = src.split('#')[0]; // strip hash

                const rect = target.getBoundingClientRect();

                if (isVideo) {
                    hoverTooltip.innerHTML = `<video src="${_escHtml(pureSrc)}" autoplay loop muted playsinline style="max-width:360px; max-height:360px; display:block; object-fit:contain; background:#000;"></video>`;
                } else {
                    hoverTooltip.innerHTML = `<img src="${_escHtml(pureSrc)}" style="max-width:360px; max-height:360px; display:block; object-fit:contain; background:#111;">`;
                }

                hoverTooltip.style.display = 'block';

                let top = rect.top - 10;
                let left = rect.right + 15;

                // Keep tooltip on screen
                if (top + 360 > window.innerHeight) {
                    top = window.innerHeight - 380;
                }
                if (left + 360 > window.innerWidth) {
                    left = rect.left - 380;
                }

                hoverTooltip.style.top = `${Math.max(10, top)}px`;
                hoverTooltip.style.left = `${Math.max(10, left)}px`;

                if (isVideo) {
                    const v = hoverTooltip.querySelector('video');
                    if (v) {
                        v.playbackRate = 1.5;
                        v.play().catch(() => { });
                    }
                }
            }, 300);
        }
    });

    container.addEventListener('mouseout', (e) => {
        const target = e.target;
        if (target.classList.contains('rbt-thumb-previewable')) {
            clearTimeout(previewTimeout);
            stopHoverPreviewVideo();
        }
    });

    // ══ Material folder selection & refresh (now in sidebar) ══
    container.querySelector('#rbt-select-mat-dir')?.addEventListener('click', async () => {
        if (window.electronAPI && window.electronAPI.selectDirectory) {
            const dir = await window.electronAPI.selectDirectory();
            if (dir) {
                const tab = _getActiveTab();
                tab.materialDir = dir;
                _renderBatchTable();
            }
        } else {
            alert('请在桌面应用中使用此功能');
        }
    });
    container.querySelector('#rbt-refresh-mat')?.addEventListener('click', () => {
        _refreshMaterialFolder();
    });
    // Sidebar versions of the same (rbt-ms-select-dir / rbt-ms-refresh-dir)
    container.querySelector('#rbt-ms-select-dir')?.addEventListener('click', async () => {
        if (window.electronAPI && window.electronAPI.selectDirectory) {
            const dir = await window.electronAPI.selectDirectory();
            if (dir) {
                const tab = _getActiveTab();
                tab.materialDir = dir;
                _renderBatchTable();
            }
        } else {
            alert('请在桌面应用中使用此功能');
        }
    });
    container.querySelector('#rbt-ms-refresh-dir')?.addEventListener('click', () => {
        _refreshMaterialFolder();
    });

    // ══ Hook Batch settings ══
    container.querySelector('#rbt-upload-hook')?.addEventListener('click', () => {
        const indices = _getSelectedIndices();
        if (indices.length === 0) {
            alert('请先在左侧勾选需要批量配置前置Hook的行');
            return;
        }
        _openHookModal(-1);
    });

    const hookModal = container.querySelector('#rbt-hook-modal');
    if (hookModal) {
        container.querySelector('#rbt-hook-select-btn')?.addEventListener('click', () => {
            container.querySelector('#rbt-hook-file-input')?.click();
        });

        container.querySelector('#rbt-hook-file-input')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const filePath = (typeof getFileNativePath === 'function') ? getFileNativePath(file) : (file.path || file.name);
            container.querySelector('#rbt-hook-path').value = filePath;
            _updateHookPreview();
            e.target.value = '';
        });

        container.querySelector('#rbt-hook-start')?.addEventListener('input', () => {
            const videoPreview = container.querySelector('#rbt-hook-preview-video');
            const startInput = container.querySelector('#rbt-hook-start');
            if (videoPreview && startInput && videoPreview.readyState >= 1) {
                const startTime = parseFloat(startInput.value) || 0;
                videoPreview.currentTime = startTime;
            }
        });

        container.querySelector('#rbt-hook-mark-start')?.addEventListener('click', () => {
            const videoPreview = container.querySelector('#rbt-hook-preview-video');
            const startInput = container.querySelector('#rbt-hook-start');
            if (videoPreview && startInput && videoPreview.readyState >= 1) {
                startInput.value = Math.round(videoPreview.currentTime * 10) / 10;
            }
        });

        container.querySelector('#rbt-hook-mark-end')?.addEventListener('click', () => {
            const videoPreview = container.querySelector('#rbt-hook-preview-video');
            const endInput = container.querySelector('#rbt-hook-end');
            if (videoPreview && endInput && videoPreview.readyState >= 1) {
                endInput.value = Math.round(videoPreview.currentTime * 10) / 10;
            }
        });

        container.querySelector('#rbt-hook-cancel')?.addEventListener('click', () => {
            const videoPreview = container.querySelector('#rbt-hook-preview-video');
            if (videoPreview) {
                videoPreview.pause();
                videoPreview.removeAttribute('src');
                videoPreview.load();
            }
            hookModal.style.display = 'none';
        });
        container.querySelector('#rbt-hook-save')?.addEventListener('click', () => {
            const videoPreview = container.querySelector('#rbt-hook-preview-video');
            if (videoPreview) {
                videoPreview.pause();
                videoPreview.removeAttribute('src');
                videoPreview.load();
            }
            const idxStr = hookModal.dataset.editIdx;
            if (!idxStr) return;
            const idx = parseInt(idxStr);
            const hookFile = container.querySelector('#rbt-hook-path').value.trim();
            const startVal = container.querySelector('#rbt-hook-start').value;
            const endVal = container.querySelector('#rbt-hook-end').value;
            const hookSpeed = parseFloat(container.querySelector('#rbt-hook-speed').value) || 1;
            const hookTrans = container.querySelector('#rbt-hook-transition').value || 'none';
            const hookTransDur = parseFloat(container.querySelector('#rbt-hook-trans-dur').value) || 0.5;
            const selectedIdx = window._reelsState ? window._reelsState.selectedIdx : -1;
            const selectedIndices = _getSelectedIndices();
            const shouldRefreshPreview = (
                typeof reelsSelectTask === 'function' &&
                selectedIdx >= 0 &&
                (idx === selectedIdx || (idx < 0 && selectedIndices.includes(selectedIdx)))
            );

            const applyToTask = (task) => {
                task.hookFile = hookFile;
                task.hookTrimStart = startVal !== '' ? parseFloat(startVal) : null;
                task.hookTrimEnd = endVal !== '' ? parseFloat(endVal) : null;
                task.hookSpeed = hookSpeed;
                task.hookTransition = hookTrans;
                task.hookTransDuration = hookTransDur;
                if (!task.hook) task.hook = {};
                task.hook.enabled = !!hookFile;
                task.hook.path = hookFile || '';
            };

            if (idx >= 0) {
                applyToTask(window._reelsState.tasks[idx]);
            } else {
                selectedIndices.forEach(i => {
                    const task = window._reelsState.tasks[i];
                    if (task) applyToTask(task);
                });
            }
            hookModal.style.display = 'none';
            _renderBatchTable();
            if (shouldRefreshPreview) {
                reelsSelectTask(selectedIdx);
            }
            if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
        });
    }

    // ══ Cover modal events ══
    const coverModal = container.querySelector('#rbt-cover-modal');
    if (coverModal) {
        // 关闭及空白区域点击
        coverModal.addEventListener('click', (e) => {
            if (e.target === coverModal) {
                coverModal.style.display = 'none';
            }
        });
        container.querySelector('#rbt-cover-cancel')?.addEventListener('click', () => {
            coverModal.style.display = 'none';
        });

        // 取背景图按钮
        container.querySelector('#rbt-cover-bg-btn')?.addEventListener('click', () => {
            container.querySelector('#rbt-cover-file-input')?.click();
        });
        container.querySelector('#rbt-cover-file-input')?.addEventListener('change', (e) => {
            if (e.target.files && e.target.files.length > 0) {
                let filePath = '';
                if (window.electronAPI && window.electronAPI.getFilePath) {
                    filePath = window.electronAPI.getFilePath(e.target.files[0]) || e.target.files[0].path;
                } else {
                    filePath = e.target.files[0].path;
                }
                container.querySelector('#rbt-cover-bg-path').value = filePath;

                // 更新预览
                const isImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(filePath);
                const url = _rbtMediaUrl(filePath);
                const previewImg = container.querySelector('#rbt-cover-preview-img');
                const hint = container.querySelector('#rbt-cover-preview-hint');
                previewImg.style.display = 'block';
                hint.style.display = 'none';
                previewImg.src = url;
            }
        });

        // 保存配置
        container.querySelector('#rbt-cover-save')?.addEventListener('click', () => {
            const idxStr = coverModal.dataset.editIdx;
            if (!idxStr) return;
            const idx = parseInt(idxStr);
            const coverEnabled = container.querySelector('#rbt-cover-enabled').checked;
            const separateExport = container.querySelector('#rbt-cover-export-separate').checked;
            const coverBgPath = container.querySelector('#rbt-cover-bg-path').value.trim();
            const coverDuration = parseFloat(container.querySelector('#rbt-cover-duration').value) || 0;
            const selectedIdx = window._reelsState ? window._reelsState.selectedIdx : -1;
            const selectedIndices = _getSelectedIndices();
            const shouldRefreshPreview = (
                typeof reelsSelectTask === 'function' &&
                selectedIdx >= 0 &&
                (idx === selectedIdx || (idx < 0 && selectedIndices.includes(selectedIdx)))
            );

            const applyToTask = (task) => {
                if (!task.cover) task.cover = {};
                task.cover.enabled = coverEnabled;
                task.cover.exportSeparate = separateExport;
                task.cover.bgPath = coverBgPath;
                task.cover.duration = coverDuration;
                if (!task.cover.overlays) task.cover.overlays = [];

                const selOvlTpl = container.querySelector('#rbt-cover-overlay-sel')?.value || '';
                if (selOvlTpl && window.ReelsOverlay) {
                    let presets = {};
                    try { presets = JSON.parse(_rbtReadOverlayGroupPresetsRaw() || '{}'); } catch (e) { }
                    if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
                        presets = { ...window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS, ...presets };
                    }
                    const presetData = presets[selOvlTpl];
                    const layers = Array.isArray(presetData) ? presetData : presetData?.layers;
                    if (layers && Array.isArray(layers)) {
                        const newOvls = layers.map(o => JSON.parse(JSON.stringify(o)));
                        const oldTextOvl = task.cover.overlays.find(o => !o.fixed_text && (o.type === 'textcard' || o.type === 'scroll')) || { title_text: task.title || '' };
                        const title = oldTextOvl.title_text || '';
                        for (const ov of newOvls) {
                            if (ov.fixed_text) continue;
                            if (ov.type === 'textcard') { ov.title_text = title; }
                            else if (ov.type === 'scroll') { ov.content = title; }
                        }
                        task.cover.overlays = newOvls;
                    }
                }
                task.cover.overlayTpl = selOvlTpl;
            };

            if (idx >= 0) {
                applyToTask(window._reelsState.tasks[idx]);
            } else {
                selectedIndices.forEach(i => {
                    const task = window._reelsState.tasks[i];
                    if (task) applyToTask(task);
                });
            }
            coverModal.style.display = 'none';
            _renderBatchTable();
            if (shouldRefreshPreview) {
                reelsSelectTask(selectedIdx);
            }
            if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
        });

        // 绑定批量应用按钮
        container.querySelector('#rbt-cover-batch-apply')?.addEventListener('click', () => {
            const idxStr = coverModal.dataset.editIdx;
            if (!idxStr) return;
            // First trigger single save to apply current UI values to the current task
            container.querySelector('#rbt-cover-save').click();

            const idx = parseInt(idxStr);
            const sourceTask = window._reelsState.tasks[idx];
            if (!sourceTask || !sourceTask.cover) return;

            for (let i = 0; i < window._reelsState.tasks.length; i++) {
                if (i === idx) continue;
                const t = window._reelsState.tasks[i];
                t.cover = _serializeBatchValue(sourceTask.cover) || { enabled: true, overlays: [] };
                // Inherit local title logic
                const tTitle = t.title || t.baseName || '';
                const ovs = t.cover.overlays || [];
                for (const ov of ovs) {
                    if (ov.type === 'textcard') { ov.title_text = tTitle; }
                    else if (ov.type === 'scroll') { ov.content = tTitle; }
                }
            }
            if (typeof showToast === 'function') showToast('已将该封面配置应用到全部行！', 'success');
            _renderBatchTable();
        });

        // Cover Preset Handlers
        const presetSel = container.querySelector('#rbt-cover-preset-sel');
        container.querySelector('#rbt-cover-preset-save')?.addEventListener('click', async () => {
            const pname = await _showInputDialog('保存封面预设', '请输入预设名称 (例如: 蓝底黄字模版)');
            if (!pname) return;
            const newP = {
                enabled: container.querySelector('#rbt-cover-enabled').checked,
                exportSeparate: container.querySelector('#rbt-cover-export-separate').checked,
                bgPath: container.querySelector('#rbt-cover-bg-path').value.trim(),
                duration: parseFloat(container.querySelector('#rbt-cover-duration').value) || 0,
                overlayTpl: container.querySelector('#rbt-cover-overlay-sel')?.value || ''
            };
            let pStore = {};
            try { pStore = JSON.parse(localStorage.getItem('videokit_cover_presets') || '{}'); } catch (e) { }
            pStore[pname] = newP;
            localStorage.setItem('videokit_cover_presets', JSON.stringify(pStore));
            if (typeof showToast === 'function') showToast('预设已保存！', 'success');
            if (typeof _openCoverModal === 'function') _openCoverModal(parseInt(coverModal.dataset.editIdx));
            if (presetSel) presetSel.value = pname;
        });

        container.querySelector('#rbt-cover-preset-del')?.addEventListener('click', () => {
            if (!presetSel) return;
            const pname = presetSel.value;
            if (!pname) return alert('请先在下拉框选择一个已有预设名称');
            let pStore = {};
            try { pStore = JSON.parse(localStorage.getItem('videokit_cover_presets') || '{}'); } catch (e) { }
            delete pStore[pname];
            localStorage.setItem('videokit_cover_presets', JSON.stringify(pStore));
            presetSel.value = '';
            if (typeof showToast === 'function') showToast('预设已删除！', 'success');
            if (typeof _openCoverModal === 'function') _openCoverModal(parseInt(coverModal.dataset.editIdx));
        });

        presetSel?.addEventListener('change', () => {
            const pname = presetSel.value;
            if (!pname) return;
            let pStore = {};
            try { pStore = JSON.parse(localStorage.getItem('videokit_cover_presets') || '{}'); } catch (e) { }
            const p = pStore[pname];
            if (p) {
                container.querySelector('#rbt-cover-enabled').checked = p.enabled;
                container.querySelector('#rbt-cover-export-separate').checked = p.exportSeparate;
                container.querySelector('#rbt-cover-bg-path').value = p.bgPath || '';
                container.querySelector('#rbt-cover-duration').value = p.duration || 0;
                if (container.querySelector('#rbt-cover-overlay-sel')) container.querySelector('#rbt-cover-overlay-sel').value = p.overlayTpl || '';

                const prevImg = container.querySelector('#rbt-cover-preview-img');
                const hint = container.querySelector('#rbt-cover-preview-hint');
                if (p.bgPath && prevImg && hint) {
                    const url = _rbtMediaUrl(p.bgPath);
                    prevImg.src = url;
                    prevImg.style.display = 'block';
                    hint.style.display = 'none';
                } else if (prevImg && hint) {
                    prevImg.style.display = 'none';
                    hint.style.display = 'block';
                }
            }
        });

        // 绑定编辑覆层卡的拉起
        container.querySelector('#rbt-cover-edit-overlay-btn')?.addEventListener('click', () => {
            const idxStr = coverModal.dataset.editIdx;
            if (!idxStr) return;
            const idx = parseInt(idxStr);
            const task = window._reelsState.tasks[idx];
            if (!task) return;

            // 先强制把当前的UI设定落盘保存一下
            container.querySelector('#rbt-cover-save').click();

            // 虽然刚才click关掉了modal，但不影响后续开Edit
            if (typeof reelsToggleCoverEditMode === 'function') {
                reelsToggleCoverEditMode(true);
            }
        });
    }

    // ══ Batch selection events ══
    const handleSelectAll = (e) => {
        const checked = e.target.checked;
        const tasks = window._reelsState.tasks || [];
        _batchTableState.selectedRows = new Set(checked ? tasks.map((_, i) => i) : []);
        container.querySelectorAll('.rbt-row-check').forEach(cb => cb.checked = checked);
        const sa = container.querySelector('#rbt-select-all');
        const ha = container.querySelector('#rbt-header-select-all');
        if (sa && sa !== e.target) sa.checked = checked;
        if (ha && ha !== e.target) ha.checked = checked;
        _updateBatchSelectCount();
    };
    container.querySelector('#rbt-select-all')?.addEventListener('change', handleSelectAll);
    container.querySelector('#rbt-header-select-all')?.addEventListener('change', handleSelectAll);
    container.querySelector('#rbt-invert-select')?.addEventListener('click', () => {
        const tasks = window._reelsState.tasks || [];
        const newSet = new Set();
        for (let i = 0; i < tasks.length; i++) {
            if (!_batchTableState.selectedRows.has(i)) newSet.add(i);
        }
        _batchTableState.selectedRows = newSet;
        container.querySelectorAll('.rbt-row-check').forEach(cb => {
            const idx = parseInt(cb.dataset.idx);
            cb.checked = newSet.has(idx);
        });
        _updateBatchSelectCount();
    });
    container.querySelector('#rbt-deselect-all')?.addEventListener('click', () => {
        _batchTableState.selectedRows = new Set();
        container.querySelectorAll('.rbt-row-check').forEach(cb => cb.checked = false);
        const selectAll = container.querySelector('#rbt-select-all');
        if (selectAll) selectAll.checked = false;
        _updateBatchSelectCount();
    });
    container.querySelector('#rbt-delete-selected')?.addEventListener('click', () => {
        const indices = _getSelectedIndices();
        if (indices.length === 0) {
            if (typeof showToast === 'function') showToast('请先勾选需要删除的任务行', 'info');
            return;
        }
        if (!confirm(`确定删除当前标签页中选中的 ${indices.length} 条任务吗？\n\n此操作不会影响其他标签页。`)) return;
        const tasks = window._reelsState?.tasks || [];
        const removedTasks = [];
        [...indices].sort((a, b) => b - a).forEach(idx => {
            if (idx >= 0 && idx < tasks.length) {
                removedTasks.push(...tasks.splice(idx, 1));
            }
        });
        _batchTableState.selectedRows = new Set();
        if (typeof window.reelsSyncTaskRemovalToBatchTabs === 'function') {
            window.reelsSyncTaskRemovalToBatchTabs(removedTasks);
        } else if (typeof _syncTasksToActiveTab === 'function') {
            _syncTasksToActiveTab();
        }
        _skipNextApply = true;
        _renderBatchTable();
        if (typeof _renderTaskList === 'function') _renderTaskList();
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
        if (typeof _batchAutoSave === 'function') _batchAutoSave();
        if (typeof showToast === 'function') showToast(`✅ 已删除 ${indices.length} 条选中任务`, 'success');
    });

    // ══ Batch template apply ══
    container.querySelector('#rbt-apply-batch-sub')?.addEventListener('click', () => {
        const val = container.querySelector('#rbt-batch-sub-tpl')?.value;
        if (!val) { alert('请先选择字幕模板'); return; }
        const indices = _getSelectedIndices();
        if (indices.length === 0) { alert('请先勾选需要批量设置的行'); return; }
        for (const idx of indices) {
            const task = window._reelsState.tasks[idx];
            if (task) task._subtitlePreset = val;
        }
        _renderBatchTable();
        alert(`✅ 已将字幕模板「${val}」应用到 ${indices.length} 行`);
    });

    container.querySelector('#rbt-apply-first-subtitle-style')?.addEventListener('click', () => {
        const val = container.querySelector('#rbt-batch-sub-tpl')?.value || '';
        const xRaw = container.querySelector('#rbt-first-sub-x')?.value;
        const yRaw = container.querySelector('#rbt-first-sub-y')?.value;
        const override = _rbtBuildFirstSubtitleStyleOverride(val, xRaw, yRaw);
        if (!override) {
            alert('请先选择字幕模板，或填写标题 X/Y 位置');
            return;
        }
        const indices = _getSelectedIndices();
        if (indices.length === 0) { alert('请先勾选需要批量设置的行'); return; }
        let applied = 0;
        let pending = 0;
        for (const idx of indices) {
            const task = window._reelsState.tasks[idx];
            if (!task) continue;
            const hasSeg = _rbtApplyFirstSubtitleStyleToTask(task, override);
            if (hasSeg) applied++;
            else pending++;
        }
        _skipNextApply = true;
        _renderBatchTable();
        if (typeof _renderTaskList === 'function') _renderTaskList();
        if (window._reelsState?.selectedIdx >= 0 && typeof reelsSelectTask === 'function') {
            reelsSelectTask(window._reelsState.selectedIdx);
        }
        alert(`✅ 已设置 ${indices.length} 行首句标题样式${applied ? `，已应用 ${applied} 行` : ''}${pending ? `，${pending} 行将在生成/载入字幕后自动应用` : ''}`);
    });

    // ══ 字幕模板自定义下拉框交互 (使用统一选择器) ══
    const subTplTrigger = container.querySelector('#rbt-sub-tpl-trigger');
    const subTplSelect = container.querySelector('#rbt-batch-sub-tpl');
    const subTplLabel = container.querySelector('#rbt-sub-tpl-label');

    if (subTplTrigger) {
        subTplTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const currentVal = subTplSelect?.value || '';
            _openStyledPresetPicker(subTplTrigger, currentVal, (val) => {
                if (subTplSelect) subTplSelect.value = val;
                if (subTplLabel) {
                    subTplLabel.textContent = val || '动态字幕模版...';
                    subTplLabel.style.color = val ? '#fff' : '';
                }
            });
        });
    }
    container.querySelector('#rbt-apply-batch-card')?.addEventListener('click', () => {
        const val = container.querySelector('#rbt-batch-card-tpl')?.value;
        if (!val) { alert('请先选择覆层预设'); return; }
        const indices = _getSelectedIndices();
        if (indices.length === 0) { alert('请先勾选需要批量设置的行'); return; }

        const tasksToApply = indices.map(idx => window._reelsState.tasks[idx]).filter(Boolean);

        _promptOverlayPresetOptions(val, tasksToApply, (opts) => {
            const failedRows = [];
            for (const idx of indices) {
                const task = window._reelsState.tasks[idx];
                if (task) {
                    task._overlayPresetName = val;
                    const result = _applyAndVerifyOverlayGroupPresetToTask(task, val, opts);
                    if (!result.ok) failedRows.push(`${idx + 1}行(${result.reason})`);
                }
            }
            _skipNextApply = true;
            _renderBatchTable();
            if (window._reelsState && window._reelsState.selectedIdx >= 0 && typeof reelsSelectTask === 'function') {
                // 先同步覆层管理器，防止 reelsSelectTask 保存旧面板数据覆盖批量设置
                const curTask = window._reelsState.tasks[window._reelsState.selectedIdx];
                if (curTask && window._reelsState.overlayProxy && window._reelsState.overlayProxy.overlayMgr) {
                    window._reelsState.overlayProxy.overlayMgr.overlays = curTask.overlays ? [...curTask.overlays] : [];
                }
                reelsSelectTask(window._reelsState.selectedIdx);
            }
            if (failedRows.length > 0) {
                alert(`⚠️ 覆层预设「${val}」有 ${failedRows.length}/${indices.length} 行未通过校验：\n${failedRows.slice(0, 8).join('\n')}${failedRows.length > 8 ? '\n...' : ''}`);
            } else {
                alert(`✅ 已校验：覆层预设「${val}」已应用到 ${indices.length} 行`);
            }
        });
    });

    container.querySelector('#rbt-gallery-batch-btn')?.addEventListener('click', () => {
        const indices = _getSelectedIndices();
        if (indices.length === 0) { alert('请先勾选需要批量设置的行'); return; }

        if (!window.ReelsOverlayPanel) { alert('系统未加载预设库面板模块'); return; }
        const panel = new window.ReelsOverlayPanel(document.createElement('div'), null);
        panel._showPresetGallery((presetName, presetData, mode) => {
            const tasksToApply = indices.map(idx => window._reelsState.tasks[idx]).filter(Boolean);
            _promptOverlayPresetOptions(presetName, tasksToApply, (opts) => {
                const failedRows = [];
                for (const idx of indices) {
                    const task = window._reelsState.tasks[idx];
                    if (task) {
                        task._overlayPresetName = presetName;
                        const result = _applyAndVerifyOverlayGroupPresetToTask(task, presetName, opts);
                        if (!result.ok) failedRows.push(`${idx + 1}行(${result.reason})`);
                    }
                }
                _skipNextApply = true;
                _renderBatchTable();
                if (window._reelsState && window._reelsState.selectedIdx >= 0 && typeof reelsSelectTask === 'function') {
                    // 先同步覆层管理器，防止 reelsSelectTask 保存旧面板数据覆盖批量设置
                    const curTask = window._reelsState.tasks[window._reelsState.selectedIdx];
                    if (curTask && window._reelsState.overlayProxy && window._reelsState.overlayProxy.overlayMgr) {
                        window._reelsState.overlayProxy.overlayMgr.overlays = curTask.overlays ? [...curTask.overlays] : [];
                    }
                    reelsSelectTask(window._reelsState.selectedIdx);
                }
                if (failedRows.length > 0) {
                    alert(`⚠️ 覆层预设「${presetName}」有 ${failedRows.length}/${indices.length} 行未通过校验：\n${failedRows.slice(0, 8).join('\n')}${failedRows.length > 8 ? '\n...' : ''}`);
                } else {
                    alert(`✅ 已校验：覆层预设「${presetName}」已应用到 ${indices.length} 行`);
                }
            });
        });
    });

    const _getBatchTargetIndices = () => {
        const indices = _getSelectedIndices();
        if (indices.length === 0) {
            alert('请先勾选需要批量设置的行');
            return null;
        }
        return indices;
    };

    const _finishBatchApply = (indices, message) => {
        _renderBatchTable();
        const currentIdx = window._reelsState.selectedIdx;
        if (indices.includes(currentIdx)) {
            const selectedTask = window._reelsState.tasks[currentIdx];
            if (selectedTask && window.reelsSyncBackgroundTabUI) {
                window.reelsSyncBackgroundTabUI(selectedTask);
            }
            if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
        }
        alert(message);
    };

    // ══ Batch basic apply ══
    container.querySelector('#rbt-apply-batch-basic')?.addEventListener('click', () => {
        const indices = _getBatchTargetIndices();
        if (!indices) return;
        const durationRaw = container.querySelector('#rbt-batch-duration')?.value?.trim();
        const duration = durationRaw !== '' ? parseFloat(durationRaw) : null;
        if (duration == null) {
            alert('基础设置没有填写需要应用的值');
            return;
        }
        if (isNaN(duration) || duration < 0) {
            alert('时长(s) 必须为空或大于等于 0');
            return;
        }
        for (const idx of indices) {
            const task = window._reelsState.tasks[idx];
            if (task) task.customDuration = duration > 0 ? duration : 0;
        }
        _finishBatchApply(indices, `✅ 已将基础设置 (${duration > 0 ? `时长 ${duration}s` : '时长自动'}) 应用到 ${indices.length} 行`);
    });

    // ══ Batch background apply ══
    container.querySelector('#rbt-apply-batch-bg')?.addEventListener('click', () => {
        const indices = _getBatchTargetIndices();
        if (!indices) return;
        const bgScale = parseInt(container.querySelector('#rbt-batch-bgscale')?.value) || 100;
        const bgDurScale = parseInt(container.querySelector('#rbt-batch-bgdurscale')?.value) || 100;
        const bgVolRaw = container.querySelector('#rbt-batch-bgvol')?.value?.trim();
        const bgVol = bgVolRaw !== '' ? parseInt(bgVolRaw, 10) : null;
        const parts = [];
        if (bgVol != null && (isNaN(bgVol) || bgVol < 0)) {
            alert('背景音量必须为空或大于等于 0');
            return;
        }
        for (const idx of indices) {
            const task = window._reelsState.tasks[idx];
            if (!task) continue;
            task.bgScale = bgScale;
            task.bgDurScale = bgDurScale;
            if (bgVol != null && !isNaN(bgVol)) task.bgVideoVolume = bgVol;
        }
        parts.push(`背景缩放${bgScale}%`);
        parts.push(`背景时长${bgDurScale}%`);
        if (bgVol != null && !isNaN(bgVol)) parts.push(`背景音量${bgVol}%`);
        _finishBatchApply(indices, `✅ 已将背景设置 (${parts.join(', ')}) 应用到 ${indices.length} 行`);
    });

    // ══ Batch voice apply ══
    container.querySelector('#rbt-apply-batch-scale')?.addEventListener('click', () => {
        const indices = _getBatchTargetIndices();
        if (!indices) return;
        const audioDurScale = parseInt(container.querySelector('#rbt-batch-audiodurscale')?.value) || 100;
        const voiceVolRaw = container.querySelector('#rbt-batch-voicevol')?.value?.trim();
        const voiceVol = voiceVolRaw !== '' ? parseInt(voiceVolRaw, 10) : null;
        if (voiceVol != null && (isNaN(voiceVol) || voiceVol < 0)) {
            alert('人声音量必须为空或大于等于 0');
            return;
        }
        const parts = [`人声变速${audioDurScale}%`];
        for (const idx of indices) {
            const task = window._reelsState.tasks[idx];
            if (!task) continue;
            task.audioDurScale = audioDurScale;
            if (voiceVol != null && !isNaN(voiceVol)) task.voiceVolume = voiceVol;
        }
        if (voiceVol != null && !isNaN(voiceVol)) parts.push(`人声音量${voiceVol}%`);
        _finishBatchApply(indices, `✅ 已将人声设置 (${parts.join(', ')}) 应用到 ${indices.length} 行`);
    });

    // ══ Batch BGM apply ══
    container.querySelector('#rbt-apply-batch-bgm')?.addEventListener('click', () => {
        const indices = _getBatchTargetIndices();
        if (!indices) return;
        const bgmVolRaw = container.querySelector('#rbt-batch-bgmvol')?.value?.trim();
        const bgmVol = bgmVolRaw !== '' ? parseInt(bgmVolRaw, 10) : null;
        if (bgmVol == null) {
            alert('配乐设置没有填写需要应用的值');
            return;
        }
        if (isNaN(bgmVol) || bgmVol < 0) {
            alert('配乐音量必须为空或大于等于 0');
            return;
        }
        for (const idx of indices) {
            const task = window._reelsState.tasks[idx];
            if (task) task.bgmVolume = bgmVol;
        }
        _finishBatchApply(indices, `✅ 已将配乐设置 (配乐音量 ${bgmVol}%) 应用到 ${indices.length} 行`);
    });

    // ══ Batch subtitle time apply ══
    container.querySelector('#rbt-apply-batch-subtime')?.addEventListener('click', () => {
        const indices = _getBatchTargetIndices();
        if (!indices) return;
        const subtimeMode = container.querySelector('#rbt-batch-subtime-mode')?.value || 'keep';
        const subtimeSplitRaw = container.querySelector('#rbt-batch-subtime-split')?.value?.trim();
        const subtimeSplit = subtimeSplitRaw !== '' ? parseFloat(subtimeSplitRaw) : null;
        if (subtimeMode === 'keep') {
            alert('字幕时间当前为“保持”，没有需要应用的值');
            return;
        }
        if (subtimeMode === 'split' && (subtimeSplit == null || isNaN(subtimeSplit) || subtimeSplit <= 0)) {
            alert('字幕时间选择“分段”时，必须填写大于 0 的切换秒数');
            return;
        }
        for (const idx of indices) {
            const task = window._reelsState.tasks[idx];
            if (!task) continue;
            if (subtimeMode === 'full') {
                task.subtitleTimeMode = 'full';
                task.subtitleTimeSlices = [];
            } else if (subtimeMode === 'split') {
                task.subtitleTimeMode = 'split';
                task.subtitleTimeSlices = [
                    { label: 'A', startSec: 0, endSec: subtimeSplit, source: 'body_part1' },
                    { label: 'B', startSec: subtimeSplit, endSec: null, source: 'body_part2' },
                ];
            }
        }
        const desc = subtimeMode === 'full' ? '全时段' : `${subtimeSplit}s分段`;
        _finishBatchApply(indices, `✅ 已将字幕时间设置 (${desc}) 应用到 ${indices.length} 行`);
    });

    // ══ Batch copy bg to cv ══
    container.querySelector('#rbt-batch-bg-to-cv')?.addEventListener('click', () => {
        const indices = _getSelectedIndices();
        if (indices.length === 0) { alert('请先勾选需要批量设置的行'); return; }
        let count = 0;
        for (const idx of indices) {
            const task = window._reelsState.tasks[idx];
            if (!task) continue;
            if (task.bgPath) {
                task.contentVideoPath = task.bgPath;
                count++;
            }
        }
        _renderBatchTable();
        
        // 如果当前选中任务也被修改了，刷新预览
        const currentIdx = window._reelsState.selectedIdx;
        if (indices.includes(currentIdx)) {
            const selectedTask = window._reelsState.tasks[currentIdx];
            if (selectedTask && window.reelsSyncBackgroundTabUI) {
                window.reelsSyncBackgroundTabUI(selectedTask);
            }
            if (typeof reelsUpdatePreview === 'function') {
                reelsUpdatePreview();
            }
        }

        alert(`✅ 已将 ${count} 行的背景素材复制到内容视频`);
    });

    // ══ Batch content video and blur parameters apply ══
    container.querySelector('#rbt-apply-batch-cv')?.addEventListener('click', () => {
        const indices = _getSelectedIndices();
        if (indices.length === 0) { alert('请先勾选需要批量设置的行'); return; }
        
        const cvScale = parseInt(container.querySelector('#rbt-batch-cvscale')?.value) || 100;
        const cvTrimStartRaw = container.querySelector('#rbt-batch-cvtrim-start')?.value?.trim();
        const cvTrimEndRaw = container.querySelector('#rbt-batch-cvtrim-end')?.value?.trim();
        const cvCropRaw = container.querySelector('#rbt-batch-cvcrop')?.value?.trim();
        const cvX = container.querySelector('#rbt-batch-cvx')?.value?.trim();
        const cvY = container.querySelector('#rbt-batch-cvy')?.value?.trim();
        const cvVolRaw = container.querySelector('#rbt-batch-cvvol')?.value?.trim();
        const cvTrimStart = cvTrimStartRaw !== '' ? parseFloat(cvTrimStartRaw) : null;
        const cvTrimEnd = cvTrimEndRaw !== '' ? parseFloat(cvTrimEndRaw) : null;
        const cvVol = cvVolRaw !== '' ? parseInt(cvVolRaw, 10) : null;
        const cvBgMode = container.querySelector('#rbt-batch-cvbgmode')?.value || 'keep';
        const blurVal = parseInt(container.querySelector('#rbt-batch-cvblur')?.value) ?? 40;
        const brightnessVal = parseInt(container.querySelector('#rbt-batch-cvbrightness')?.value) ?? 60;

        if (cvTrimStart != null && (isNaN(cvTrimStart) || cvTrimStart < 0)) {
            alert('内容视频-时间段起点必须为空或大于等于 0');
            return;
        }
        if (cvTrimEnd != null && (isNaN(cvTrimEnd) || cvTrimEnd < 0)) {
            alert('内容视频-时间段终点必须为空或大于等于 0');
            return;
        }
        if (cvTrimStart != null && cvTrimEnd != null && cvTrimEnd <= cvTrimStart) {
            alert('内容视频-时间段终点必须大于起点');
            return;
        }

        let cvCrop = '';
        if (cvCropRaw) {
            const cropParts = cvCropRaw.split(',').map(p => parseFloat(p.trim()));
            const invalidCrop = cropParts.length !== 4 || cropParts.some(v => !Number.isFinite(v)) ||
                cropParts[0] < 0 || cropParts[1] < 0 || cropParts[2] <= 0 || cropParts[3] <= 0 ||
                cropParts[0] > 100 || cropParts[1] > 100 || cropParts[2] > 100 || cropParts[3] > 100;
            if (invalidCrop) {
                alert('内容视频-裁切格式必须是：左,上,宽,高，数值范围 0-100，宽高必须大于 0');
                return;
            }
            cvCrop = cropParts.join(',');
        }

        const parts = [`视频缩放 ${cvScale}%`];
        if (cvTrimStart != null || cvTrimEnd != null) parts.push(`时间段 ${cvTrimStart != null ? cvTrimStart : 0}s-${cvTrimEnd != null ? cvTrimEnd : '尾'}`);
        if (cvCrop) parts.push(`裁切 ${cvCrop}%`);
        if (cvX) parts.push(`X ${cvX}`);
        if (cvY) parts.push(`Y ${cvY}`);
        if (cvVol != null && !isNaN(cvVol)) parts.push(`视频音量 ${cvVol}%`);
        if (cvBgMode !== 'keep') {
            let modeText = '无/常规';
            if (cvBgMode === 'blur') modeText = '毛玻璃';
            else if (cvBgMode === 'direct') modeText = '直接背景';
            parts.push(`背景模式 ${modeText}`);
        }
        parts.push(`模糊度 ${blurVal}px`);
        parts.push(`亮度 ${brightnessVal}%`);

        for (const idx of indices) {
            const task = window._reelsState.tasks[idx];
            if (!task) continue;
            task.contentVideoScale = cvScale;
            if (cvTrimStart != null) task.contentVideoTrimStart = cvTrimStart;
            if (cvTrimEnd != null) task.contentVideoTrimEnd = cvTrimEnd;
            if (cvCrop) task.contentVideoCrop = cvCrop;
            if (cvX) task.contentVideoX = cvX;
            if (cvY) task.contentVideoY = cvY;
            if (cvVol != null && !isNaN(cvVol)) task.contentVideoVolume = cvVol;
            if (cvBgMode === 'blur') {
                task.contentVideoBlurBg = true;
                task.contentVideoDirectBg = false;
            } else if (cvBgMode === 'direct') {
                task.contentVideoBlurBg = false;
                task.contentVideoDirectBg = true;
            } else if (cvBgMode === 'none') {
                task.contentVideoBlurBg = false;
                task.contentVideoDirectBg = false;
            }
            task.contentVideoBlur = blurVal;
            task.contentVideoBrightness = brightnessVal;
        }

        _finishBatchApply(indices, `✅ 已将内容视频设置 (${parts.join(', ')}) 应用到 ${indices.length} 行`);
    });
    // Toggle Media Pool Sidebar
    container.querySelector('#rbt-open-media-pool-btn')?.addEventListener('click', () => {
        _batchTableState.mediaPoolOpen = !_batchTableState.mediaPoolOpen;
        _renderBatchTable();
    });
    container.querySelector('#rbt-close-media-sidebar')?.addEventListener('click', () => {
        _batchTableState.mediaPoolOpen = false;
        _renderBatchTable();
    });

    // Collapsible filters toggle
    const _msToggle = container.querySelector('#rbt-ms-toggle-filters');
    const _msBody = container.querySelector('#rbt-ms-filters-body');
    const _msIcon = container.querySelector('#rbt-ms-toggle-icon');
    if (_msToggle && _msBody) {
        // Restore collapsed state
        const _msCollapsed = localStorage.getItem('rbt_ms_filters_collapsed') === '1';
        if (_msCollapsed) {
            _msBody.classList.add('collapsed');
            if (_msIcon) _msIcon.textContent = '▸';
        }
        _msToggle.addEventListener('click', () => {
            const nowCollapsed = !_msBody.classList.contains('collapsed');
            _msBody.classList.toggle('collapsed', nowCollapsed);
            if (_msIcon) _msIcon.textContent = nowCollapsed ? '▸' : '▾';
            localStorage.setItem('rbt_ms_filters_collapsed', nowCollapsed ? '1' : '0');
        });
    }

    // Media sidebar import buttons
    _bindMediaSidebarEvents(container);

    // Add row
    container.querySelector('#rbt-add-row-btn')?.addEventListener('click', () => {
        _batchAddEmptyRow();
        _renderBatchTable();
    });

    // Clear
    container.querySelector('#rbt-clear-btn')?.addEventListener('click', () => {
        if (confirm('确定清空所有任务？')) {
            window._reelsState.tasks = [];
            const activeTab = _getActiveTab();
            if (activeTab) activeTab.tasks = [];
            _batchTableState.appliedTabIds = [];
            _batchAutoSave({ skipSync: true });
            _skipNextApply = true;
            _renderBatchTable();
        }
    });

    // AI Processing
    // AI Processing
    container.querySelector('#rbt-ai-gemini-btn')?.addEventListener('click', () => {
        const indices = _getSelectedIndices();
        const tasks = window._reelsState?.tasks || [];
        if (tasks.length === 0) return alert('❌ 当前表格为空，无法执行！');

        const targetIdxs = indices.length > 0 ? indices : tasks.map((_, i) => i);
        const validIdxs = targetIdxs.filter(i => tasks[i].aiScript && tasks[i].aiScript.trim().length > 0);

        let msg = `即将开始【批量 AI 处理文案】操作：\n\n`;
        msg += `【预期处理数据清单】\n`;
        msg += `· 目标范围：${indices.length > 0 ? `已选中的 ${indices.length} 行` : `全部 ${tasks.length} 行`}\n`;
        msg += `· 有效数据：检测到 ${validIdxs.length} 行「人声-原文案」列有内容将被处理\n`;
        if (validIdxs.length > 0) msg += `· 对应行号：[ ${validIdxs.map(i => i + 1).join(', ')} ]\n\n`;
        else msg += `\n⚠️ 警告：当前目标中没有任何行填写了「人声-原文案」，执行将失败！\n\n`;
        msg += `【处理规则】\n1. 读取有效行的「人声-原文案」。\n2. 使用选择的「Prompt指令预设」调用模型。\n3. 结果自动填入「人声-配音文案」列。\n\n是否确认开始执行此操作？`;

        if (!confirm(msg)) return;
        _ensureAIColumnsVisible();
        _runGeminiBatchProcessing();
    });

    container.querySelector('#rbt-ai-tts-all-btn')?.addEventListener('click', () => {
        const indices = _getSelectedIndices();
        const tasks = window._reelsState?.tasks || [];
        if (tasks.length === 0) return alert('❌ 当前表格为空，无法执行！');

        const targetIdxs = indices.length > 0 ? indices : tasks.map((_, i) => i);
        const validIdxs = targetIdxs.filter(i => tasks[i].ttsText && tasks[i].ttsText.trim().length > 0);

        let msg = `即将开始【分步配音字幕】操作：\n\n`;
        msg += `【预期处理数据清单】\n`;
        msg += `· 目标范围：${indices.length > 0 ? `已选中的 ${indices.length} 行` : `全部 ${tasks.length} 行`}\n`;
        msg += `· 有效数据：检测到 ${validIdxs.length} 行「人声-配音文案」将生成配音\n`;
        if (validIdxs.length > 0) msg += `· 对应行号：[ ${validIdxs.map(i => i + 1).join(', ')} ]\n\n`;
        else msg += `\n⚠️ 警告：当前目标中没有任何行填写了「人声-配音文案」，执行将失败！\n\n`;
        msg += `【处理规则】\n1. 读取有效行的「人声-配音文案」。\n2. 依据当前配置的「人声-配音音色」合成人声-音频文件。\n3. 生成完毕后本地持久化保存至该任务。\n\n是否确认开始执行？`;

        if (!confirm(msg)) return;
        _ensureAIColumnsVisible();
        _runTTSBatchProcessing();
    });

    // 绑定新的融合执行大按钮
    container.querySelector('#rbt-unified-execute-btn')?.addEventListener('click', async () => {
        const modeBtnId = container.querySelector('#rbt-unified-execute-mode').value;
        const scope = container.querySelector('#rbt-unified-execute-scope')?.value || 'current';
        if (scope === 'all-tabs') {
            await _runWorkflowAcrossAllTabs(modeBtnId);
            return;
        }
        const targetBtn = container.querySelector('#' + modeBtnId);
        if (targetBtn) {
            targetBtn.click(); // 通过隐藏按钮触发原生绑定事件
        }
    });
    container.querySelector('#rbt-ai-auto-all-btn')?.addEventListener('click', async () => {
        const indices = _getSelectedIndices();
        const tasks = window._reelsState?.tasks || [];
        if (tasks.length === 0) return alert('❌ 当前表格为空，无法执行！');

        const targetIdxs = indices.length > 0 ? indices : tasks.map((_, i) => i);
        const aiValid = targetIdxs.filter(i => tasks[i].aiScript && tasks[i].aiScript.trim().length > 0);
        const hasTxtContent = targetIdxs.some(i => tasks[i].txtContent && tasks[i].txtContent.trim().length > 0);

        let msg = `即将开始【🚀 自动全家桶 (AI改写 + 配音 + 字幕对齐)】操作：\n\n`;
        msg += `【预期处理数据清单】\n`;
        msg += `· 目标范围：${indices.length > 0 ? `已选中的 ${indices.length} 行` : `全部 ${tasks.length} 行`}\n`;
        msg += `· 发动机一：检测到 ${aiValid.length} 行「人声-原文案」作为源头数据将被 AI 改写\n`;
        if (aiValid.length > 0) msg += `· 对应行号：[ ${aiValid.map(i => i + 1).join(', ')} ]\n\n`;
        else msg += `\n⚠️ 警告：当前目标中没有填写「人声-原文案」，第一阶段将失败！\n\n`;
        msg += `【三步流水线】\n`;
        msg += `① 读取「人声-原文案」→ Gemini 改写 → 填入「人声-配音文案」+ 「人声-断行文案」\n`;
        msg += `② 读取「人声-配音文案」→ ElevenLabs 合成配音\n`;
        msg += `③ 配音 + 「人声-断行文案」→ 云端转录对齐 → 生成 SRT 时间轴\n\n`;
        if (!hasTxtContent) msg += `💡 提示：「人声-断行文案」列暂无内容，第③步将跳过（可先在AI Prompt中配置断句输出）\n\n`;
        msg += `是否确认开启一条龙处理流程？`;

        if (!confirm(msg)) return;

        _ensureAIColumnsVisible();
        // Step 1: Run Gemini AI Script processing
        showToast('🚀 全家桶 Step 1/3：AI 文案处理中...', 'info');
        const aiSuccess = await _runGeminiBatchProcessing();
        if (!aiSuccess) return; // Halt if AI step was aborted or failed

        // Wait briefly for UI to render
        await new Promise(resolve => setTimeout(resolve, 500));

        // Step 2: Run TTS Generation
        showToast('🚀 全家桶 Step 2/3：TTS 配音生成中...', 'info');
        await _runTTSBatchProcessing();

        // Wait briefly for TTS results to settle
        await new Promise(resolve => setTimeout(resolve, 500));

        // Step 3: 只对 TTS 阶段没有成功产出 SRT 的任务做补充对齐。
        // TTS 流程本身可能已经逐行生成并对齐 SRT，不能在收尾时强制重跑，
        // 否则会先删除正确的旧 SRT，并在任何一行重跑失败时造成文件丢失。
        const tasksWithTextAndAudio = targetIdxs.filter(idx => {
            const t = tasks[idx];
            return (t.txtContent && t.txtContent.trim()) && t.audioPath && !t.aligned && !t.srtPath;
        });
        if (tasksWithTextAndAudio.length > 0) {
            showToast(`🚀 全家桶 Step 3/3：补充对齐未生成 SRT 的任务 (${tasksWithTextAndAudio.length} 行)...`, 'info');
            await _batchAlignAllTasks({
                targetIndices: tasksWithTextAndAudio,
                forceRealign: false,
                forceTranscribe: false,
            });
            showToast('🎉 全家桶三步流水线全部完成！', 'success', 5000);
        } else {
            const completedCount = targetIdxs.filter(idx => tasks[idx]?.aligned || tasks[idx]?.srtPath).length;
            showToast(`✅ 全家桶完成。${completedCount > 0 ? `已有 ${completedCount} 行 SRT 对齐成功，无需重复对齐。` : '没有需要补充对齐的任务。'}`, 'success', 5000);
        }
    });

    container.querySelector('#rbt-ai-preset-btn')?.addEventListener('click', () => {
        _applyAiPresetBatch();
    });

    // ── AI 设置弹窗 ──
    container.querySelector('#rbt-ai-settings-btn')?.addEventListener('click', () => {
        _openAISettingsModal();
    });

    // ── 导入字幕预设 ──
    container.querySelector('#rbt-import-sub-preset-btn')?.addEventListener('click', () => {
        if (typeof reelsImportPresets === 'function') {
            reelsImportPresets();
        } else {
            alert('字幕预设导入功能未加载');
        }
    });

    // ── 导入覆层预设 ──
    container.querySelector('#rbt-import-card-preset-btn')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    // data 应该是 { presetName: { overlays: [...] }, ... } 格式
                    const key = 'reels_overlay_group_presets';
                    let existing = {};
                    try { existing = JSON.parse(_rbtReadOverlayGroupPresetsRaw() || '{}'); } catch (ex) { }
                    let added = 0, skipped = 0;
                    for (const [name, val] of Object.entries(data)) {
                        if (existing[name]) { skipped++; continue; }
                        existing[name] = val;
                        added++;
                    }
                    _rbtSaveOverlayGroupPresets(existing);
                    _renderBatchTable();
                    if (typeof showToast === 'function') showToast(`覆层预设导入完成：新增 ${added} 个，跳过 ${skipped} 个`, 'success');
                    else alert(`覆层预设导入完成：新增 ${added} 个，跳过 ${skipped} 个`);
                } catch (ex) {
                    alert('文件解析失败: ' + ex.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    });

    // ── 导入任务组合预设 ──
    container.querySelector('#rbt-import-task-preset-btn')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    const key = 'rbt_task_presets';
                    let existing = {};
                    try { existing = JSON.parse(localStorage.getItem(key) || '{}'); } catch (ex) { }
                    let added = 0, skipped = 0;
                    for (const [name, val] of Object.entries(data)) {
                        if (existing[name]) { skipped++; continue; }
                        existing[name] = val;
                        added++;
                    }
                    localStorage.setItem(key, JSON.stringify(existing));
                    if (typeof showToast === 'function') showToast(`任务预设导入完成：新增 ${added} 个，跳过 ${skipped} 个`, 'success');
                    else alert(`任务预设导入完成：新增 ${added} 个，跳过 ${skipped} 个`);
                } catch (ex) {
                    alert('文件解析失败: ' + ex.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    });

    // ══ TTS Model & Voice controls ══
    const providerSelect = container.querySelector('#rbt-tts-provider');
    if (providerSelect) providerSelect.value = _rbtTtsProvider();
    const updateProviderControls = () => {
        const edge = _rbtTtsProvider() === 'edge';
        const model = container.querySelector('#rbt-tts-model');
        if (model) { model.disabled = edge; model.title = edge ? '微软 Edge 按所选音色生成，无需 ElevenLabs 模型' : ''; }
    };
    updateProviderControls();
    providerSelect?.addEventListener('change', () => {
        const input = container.querySelector('#rbt-tts-default-voice');
        if (input) localStorage.setItem(_rbtTtsVoiceStorageKey(), input.value.trim());
        localStorage.setItem('rbt_tts_provider', providerSelect.value);
        if (input) input.value = localStorage.getItem(_rbtTtsVoiceStorageKey()) || (_rbtTtsProvider() === 'edge' ? 'edge:zh-CN-XiaoxiaoNeural' : '');
        _rbtVoiceCache = null;
        const list = document.getElementById('rbt-tts-voices-list');
        if (list) list.replaceChildren();
        updateProviderControls();
        _rbtLoadVoiceList();
    });
    // 恢复已保存的模型选择
    const savedModel = localStorage.getItem('rbt_tts_model') || 'eleven_v3';
    const modelSelect = container.querySelector('#rbt-tts-model');
    if (modelSelect) modelSelect.value = savedModel;
    modelSelect?.addEventListener('change', () => {
        localStorage.setItem('rbt_tts_model', modelSelect.value);
    });

    // 恢复与保存对齐设定与执行动作选择
    const savedAlignSource = localStorage.getItem('rbt_align_source') || 'video';
    const alignSourceSelect = container.querySelector('#rbt-align-source');
    if (alignSourceSelect) alignSourceSelect.value = savedAlignSource;
    alignSourceSelect?.addEventListener('change', () => {
        localStorage.setItem('rbt_align_source', alignSourceSelect.value);
    });

    const savedAlignTxtCol = localStorage.getItem('rbt_align_txt_col') || 'txtContent';
    const alignTxtColSelect = container.querySelector('#rbt-align-txt-col');
    if (alignTxtColSelect) alignTxtColSelect.value = savedAlignTxtCol;
    alignTxtColSelect?.addEventListener('change', () => {
        localStorage.setItem('rbt_align_txt_col', alignTxtColSelect.value);
    });

    const savedExecuteMode = localStorage.getItem('rbt_unified_execute_mode') || 'rbt-ai-auto-all-btn';
    const executeModeSelect = container.querySelector('#rbt-unified-execute-mode');
    if (executeModeSelect) executeModeSelect.value = savedExecuteMode;
    executeModeSelect?.addEventListener('change', () => {
        localStorage.setItem('rbt_unified_execute_mode', executeModeSelect.value);
    });
    const executeScopeSelect = container.querySelector('#rbt-unified-execute-scope');
    if (executeScopeSelect) executeScopeSelect.value = localStorage.getItem('rbt_unified_execute_scope') || 'current';
    executeScopeSelect?.addEventListener('change', () => {
        localStorage.setItem('rbt_unified_execute_scope', executeScopeSelect.value);
    });

    // 刷新音色列表
    container.querySelector('#rbt-refresh-voices-btn')?.addEventListener('click', () => {
        _rbtVoiceCache = null; // 清除缓存，强制重新从API加载
        _rbtLoadVoiceList();
    });
    // 应用音色到全部空行
    container.querySelector('#rbt-apply-voice-all-btn')?.addEventListener('click', () => {
        const voiceSelect = container.querySelector('#rbt-tts-default-voice');
        const voiceId = voiceSelect?.value?.trim() || '';
        // 当前控件是支持手动输入的 input + datalist，不再具有 select.options。
        // 已知 ID 显示音色名称；手动输入的新 ID 则直接显示 ID。
        const matchedVoice = (_rbtVoiceCache || []).find(v => v.voice_id === voiceId);
        const voiceName = matchedVoice?.name || voiceId;
        if (!voiceId) { alert('请先选择一个音色'); return; }
        const tasks = window._reelsState?.tasks || [];
        let applied = 0;
        for (const task of tasks) {
            if (!task.ttsVoiceId || !task.ttsVoiceId.trim()) {
                task.ttsVoiceId = voiceId;
                applied++;
            }
        }
        // 任务状态已在上面直接更新。重绘时不能再把旧表格中的空输入框
        // 同步回 state，否则刚应用的 Voice ID 会立刻被覆盖掉。
        _skipNextApply = true;
        _renderBatchTable();
        showToast(`已将音色「${voiceName}」应用到 ${applied} 个空行`, 'success');
    });
    // 首次自动加载音色列表
    _rbtLoadVoiceList();

    // PIP Batch upload
    container.querySelector('#rbt-upload-pip')?.addEventListener('click', () => {
        // reuse the same file input but redirect variable
        _batchTableState._pipBatchMode = true;
        let fileInput = container.querySelector('#rbt-file-pip');
        if (!fileInput) {
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.id = 'rbt-file-pip';
            fileInput.multiple = true;
            fileInput.style.display = 'none';
            fileInput.accept = 'image/*,video/*';
            container.appendChild(fileInput);
            fileInput.addEventListener('change', (e) => {
                _batchAssignFiles(Array.from(e.target.files), 'pip');
                e.target.value = '';
            });
        }
        fileInput.click();
    });



    // Column visibility settings
    container.querySelector('#rbt-col-settings-btn')?.addEventListener('click', (e) => {
        _showColumnSettingsPopup(e.target);
    });

    // 循环填充素材
    container.querySelector('#rbt-cycle-fill-btn')?.addEventListener('click', () => {
        _showCycleFillDialog();
    });

    // Cycle fill materials
    container.querySelector('#rbt-cycle-fill-btn')?.addEventListener('click', () => {
        _showCycleFillDialog();
    });

    container.querySelector('#rbt-save-queue-btn')?.addEventListener('click', () => _saveNamedQueue());
    container.querySelector('#rbt-load-queue-btn')?.addEventListener('click', () => _openQueueLibrary());
    container.querySelector('#rbt-cloud-settings-btn')?.addEventListener('click', () => _openQueueTranscriptionSettings());

    // Save config (Legacy manual export)
    container.querySelector('#rbt-save-config-btn')?.addEventListener('click', () => {
        _batchExportConfig('current');
    });
    container.querySelector('#rbt-save-all-config-btn')?.addEventListener('click', () => {
        _batchExportConfig('all');
    });

    // Project Manager
    container.querySelector('#rbt-project-mgr-btn')?.addEventListener('click', () => {
        _showProjectManager();
    });

    // Load config (Legacy manual import)
    container.querySelector('#rbt-load-config-btn')?.addEventListener('click', () => {
        container.querySelector('#rbt-file-config').click();
    });
    container.querySelector('#rbt-file-config')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) _batchImportConfig(file);
        e.target.value = '';
    });

    // Relocate missing materials
    container.querySelector('#rbt-relocate-btn')?.addEventListener('click', () => {
        _relocateMissingMaterials();
    });

    container.querySelector('#rbt-import-material-groups-btn')?.addEventListener('click', () => {
        _selectAndImportMaterialGroupFolders({ mode: 'append' });
    });
    container.querySelector('#rbt-insert-folder-btn')?.addEventListener('click', () => {
        const tasks = _getSelectedIndices().map(index => window._reelsState.tasks[index]).filter(Boolean);
        if (!tasks.length) { alert('请先勾选要设置插入素材的任务行'); return; }
        Promise.resolve(window.reelsSetInsertFolderForTasks?.(tasks)).then(() => _renderBatchTable());
    });
    container.querySelector('#rbt-insert-silence-btn')?.addEventListener('click', () => {
        const tasks = _getSelectedIndices();
        if (!tasks.length) { alert('请先勾选要按停顿点插入素材的任务行'); return; }
        const rule = _batchTableState.insertDurationRule || {};
        window.reelsBatchInsertAtSilences?.({ durationRule: rule });
    });
    const syncInsertDurationRule = () => {
        const mode = container.querySelector('#rbt-insert-duration-mode')?.value || 'fixed';
        const fixedDuration = Math.max(.05, Math.min(120, Number(container.querySelector('#rbt-insert-duration-fixed')?.value) || 3));
        const maxDuration = Math.max(.05, Math.min(120, Number(container.querySelector('#rbt-insert-duration-max')?.value) || 3));
        _batchTableState.insertDurationRule = { mode, fixedDuration, maxDuration };
        const maxWrap = container.querySelector('#rbt-insert-duration-max-wrap');
        if (maxWrap) maxWrap.style.display = mode === 'silence' ? 'inline-flex' : 'none';
    };
    container.querySelector('#rbt-insert-duration-mode')?.addEventListener('change', syncInsertDurationRule);
    container.querySelector('#rbt-insert-duration-fixed')?.addEventListener('change', syncInsertDurationRule);
    container.querySelector('#rbt-insert-duration-max')?.addEventListener('change', syncInsertDurationRule);
    container.querySelector('#rbt-apply-batch-insert-audio')?.addEventListener('click', () => {
        const mode = container.querySelector('#rbt-batch-insert-audio-mode')?.value || 'keep-main';
        const configured = Number(container.querySelector('#rbt-batch-insert-audio-volume')?.value);
        const volume = Math.max(0, Math.min(200, Number.isFinite(configured) ? configured : 0));
        const targets = _getSelectedIndices().map(index => window._reelsState.tasks[index]).filter(Boolean);
        if (!targets.length) { alert('请先勾选任务行'); return; }
        targets.forEach(task => (task.insertClips || []).forEach(clip => { clip.audioMode = mode; clip.volume = volume; }));
        _renderBatchTable();
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    });

    // ── 读取文件夹 ──
    container.querySelector('#rbt-upload-folder')?.addEventListener('click', () => {
        container.querySelector('#rbt-file-folder').click();
    });
    container.querySelector('#rbt-file-folder')?.addEventListener('change', (e) => {
        _batchImportFolder(Array.from(e.target.files));
        e.target.value = '';
    });

    // ── 批量上传按钮 ──
    container.querySelector('#rbt-upload-bg')?.addEventListener('click', () => {
        _rbtPickNativeMediaFiles('bg');
    });
    container.querySelector('#rbt-upload-audio')?.addEventListener('click', () => {
        _rbtPickNativeMediaFiles('audio');
    });
    container.querySelector('#rbt-upload-srt')?.addEventListener('click', () => {
        container.querySelector('#rbt-file-srt').click();
    });
    container.querySelector('#rbt-upload-txt')?.addEventListener('click', () => {
        container.querySelector('#rbt-file-txt').click();
    });
    container.querySelector('#rbt-paste-txtcontent')?.addEventListener('click', () => {
        _batchPasteTxtContent();
    });
    // ── Tiled toolbar paste buttons delegation ──
    container.addEventListener('click', (e) => {
        const pasteCardBtn = e.target.closest('.rbt-paste-card-btn');
        if (pasteCardBtn) {
            e.preventDefault();
            const cardId = pasteCardBtn.dataset.cardId || null;
            const cardIdx = pasteCardBtn.dataset.cardIdx != null ? parseInt(pasteCardBtn.dataset.cardIdx) : null;
            _batchPasteFromSheet(cardId, cardIdx);
            return;
        }
        
        const pasteScrollBtn = e.target.closest('.rbt-paste-scroll-btn-tiled');
        if (pasteScrollBtn) {
            e.preventDefault();
            const scrollId = pasteScrollBtn.dataset.scrollId || null;
            const scrollIdx = pasteScrollBtn.dataset.scrollIdx != null ? parseInt(pasteScrollBtn.dataset.scrollIdx) : null;
            _batchPasteScrollFromSheet(scrollId, scrollIdx);
            return;
        }
    });
    container.querySelector('#rbt-paste-ai-raw-btn')?.addEventListener('click', () => {
        _batchPasteAiScript();
    });
    container.querySelector('#rbt-paste-tts-btn')?.addEventListener('click', () => {
        _batchPasteTTSContent();
    });

    // ── 内容视频层相关事件 ──
    container.querySelector('#rbt-upload-content-video')?.addEventListener('click', () => {
        let fileInput = container.querySelector('#rbt-file-contentvideo');
        if (!fileInput) {
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.id = 'rbt-file-contentvideo';
            fileInput.multiple = true;
            fileInput.style.display = 'none';
            fileInput.accept = '.mp4,.mov,.mkv,.avi,.wmv,.flv,.webm';
            container.appendChild(fileInput);
            fileInput.addEventListener('change', (e) => {
                _batchAssignFiles(Array.from(e.target.files), 'contentvideo');
                e.target.value = '';
            });
        }
        fileInput.click();
    });

    // ✂️ 粘贴剪辑文案 (A/B 双版本)
    container.querySelector('#rbt-paste-clip-ab')?.addEventListener('click', () => {
        _showClipAbPasteModal();
    });

    // 🧩 大量制作
    container.querySelector('#rbt-bulk-create-btn')?.addEventListener('click', () => {
        _showBulkCreateModal();
    });

    // 内容视频缩放: input + slider
    container.addEventListener('input', (e) => {
        if (e.target.classList.contains('rbt-cvscale-input') || e.target.classList.contains('rbt-cvscale-slider')) {
            const idx = parseInt(e.target.dataset.idx);
            const task = window._reelsState.tasks[idx];
            if (!task) return;
            const val = parseInt(e.target.value) || 100;
            task.contentVideoScale = val;
            // Sync input <-> slider
            const row = e.target.closest('tr');
            if (row) {
                const sibling = row.querySelector(e.target.classList.contains('rbt-cvscale-input') ? '.rbt-cvscale-slider' : '.rbt-cvscale-input');
                if (sibling) sibling.value = val;
                const display = row.querySelector('.rbt-col-cvscale .rbt-scale-display');
                if (display) display.textContent = val + '%';
            }
            if (window._reelsState && window._reelsState.selectedIdx === idx) {
                if (typeof window.reelsSyncBackgroundTabUI === 'function') {
                    window.reelsSyncBackgroundTabUI(task);
                }
                const scaleVal = document.getElementById('reels-cv-pos-scale-val');
                if (scaleVal) scaleVal.value = val;
                if (typeof reelsUpdatePreview === 'function') {
                    reelsUpdatePreview();
                }
            }
        }
    });

    // 内容视频音量: input + slider
    container.addEventListener('input', (e) => {
        if (e.target.classList.contains('rbt-cvvol-input') || e.target.classList.contains('rbt-cvvol-slider')) {
            const idx = parseInt(e.target.dataset.idx);
            const task = window._reelsState.tasks[idx];
            if (!task) return;
            const val = parseInt(e.target.value) || 0;
            task.contentVideoVolume = val;
            // Sync input <-> slider
            const row = e.target.closest('tr');
            if (row) {
                const sibling = row.querySelector(e.target.classList.contains('rbt-cvvol-input') ? '.rbt-cvvol-slider' : '.rbt-cvvol-input');
                if (sibling) sibling.value = val;
                const display = row.querySelector('.rbt-col-cvvol .rbt-scale-display');
                if (display) display.textContent = '🔊 ' + val + '%';
            }
            // 实时同步预览音量
            if (window._reelsState && window._reelsState.selectedIdx === idx) {
                if (typeof _applyPreviewAudioMix === 'function') {
                    _applyPreviewAudioMix();
                } else {
                    if (window.ReelsPreviewV2?.isOpen?.()) {
                        window.ReelsPreviewV2.syncAudio?.();
                    } else {
                        const cvVideo = document.getElementById('reels-preview-contentvideo');
                        if (cvVideo) {
                            cvVideo.volume = Math.min(1.0, val / 100);
                            cvVideo.muted = val === 0;
                        }
                    }
                }
            }
        }
    });

    // 内容视频位置 X/Y
    container.addEventListener('change', (e) => {
        if (e.target.classList.contains('rbt-cvpos-x') || e.target.classList.contains('rbt-cvpos-y')) {
            const idx = parseInt(e.target.dataset.idx);
            const task = window._reelsState.tasks[idx];
            if (!task) return;
            const val = e.target.value.trim() || 'center';
            if (e.target.classList.contains('rbt-cvpos-x')) task.contentVideoX = val;
            else task.contentVideoY = val;

            if (window._reelsState && window._reelsState.selectedIdx === idx) {
                if (typeof window.reelsSyncBackgroundTabUI === 'function') {
                    window.reelsSyncBackgroundTabUI(task);
                }
                const xVal = document.getElementById('reels-cv-pos-x-val');
                const yVal = document.getElementById('reels-cv-pos-y-val');
                if (xVal) xVal.value = task.contentVideoX || 'center';
                if (yVal) yVal.value = task.contentVideoY || 'center';
                if (typeof reelsUpdatePreview === 'function') {
                    reelsUpdatePreview();
                }
            }
        }
    });

    // 裁切单元格双击 → 打开裁切弹窗
    container.addEventListener('dblclick', (e) => {
        const trimCell = e.target.closest('.rbt-cv-trim-cell');
        if (trimCell) {
            const idx = parseInt(trimCell.dataset.idx);
            _showTrimModal(idx);
            return;
        }
        const cropCell = e.target.closest('.rbt-cv-crop-cell');
        if (cropCell) {
            const idx = parseInt(cropCell.dataset.idx);
            _showCropModal(idx);
            return;
        }
        // ⏱️ 字幕时间切片双击 → 打开切片编辑弹窗
        const subtimeCell = e.target.closest('.rbt-subtime-cell');
        if (subtimeCell) {
            const idx = parseInt(subtimeCell.dataset.idx);
            _showSubtitleTimeSliceEditor(idx);
            return;
        }
    });

    container.querySelector('#rbt-align-all-btn')?.addEventListener('click', () => {
        _batchAlignWithMultipleKeys();
    });
    container.querySelector('#rbt-align-multikey-btn')?.addEventListener('click', () => {
        _batchAlignWithMultipleKeys();
    });
    container.querySelector('#rbt-view-records-btn')?.addEventListener('click', () => {
        if (typeof window.showTranscriptionRecordsModal === 'function') {
            window.showTranscriptionRecordsModal();
        }
    });
    container.querySelector('#rbt-clear-all-cache-btn')?.addEventListener('click', () => {
        _batchClearAllCache();
    });
    container.querySelectorAll('.rbt-row-realign-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            const force = btn.dataset.force === '1';
            _batchAlignSingleTask(idx, force);
        });
    });
    container.querySelectorAll('.rbt-row-clear-cache-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            _batchClearTaskCache(idx);
        });
    });
    container.querySelector('#rbt-align-auto-detect')?.addEventListener('change', (e) => {
        localStorage.setItem('rbt_align_auto_detect', e.target.checked ? '1' : '0');
    });
    container.querySelector('#rbt-video-drop-route-enabled')?.addEventListener('change', (e) => {
        _batchTableState.videoDropRouteEnabled = !!e.target.checked;
        const modeEl = container.querySelector('#rbt-video-drop-route-mode');
        if (modeEl) {
            modeEl.disabled = !_batchTableState.videoDropRouteEnabled;
            modeEl.style.opacity = _batchTableState.videoDropRouteEnabled ? '' : '.6';
        }
    });
    container.querySelector('#rbt-video-drop-route-mode')?.addEventListener('change', (e) => {
        _batchTableState.videoDropRouteMode = e.target.value === 'audio' ? 'audio' : 'bg';
    });

    // ── 批量文件选完后按顺序分配到各行 ──
    container.querySelector('#rbt-file-bg')?.addEventListener('change', (e) => {
        _batchAssignFiles(Array.from(e.target.files), 'bg');
        e.target.value = '';
    });
    container.querySelector('#rbt-file-audio')?.addEventListener('change', (e) => {
        _batchAssignFiles(Array.from(e.target.files), 'audio');
        e.target.value = '';
    });
    container.querySelector('#rbt-file-srt')?.addEventListener('change', (e) => {
        _batchAssignFiles(Array.from(e.target.files), 'srt');
        e.target.value = '';
    });
    container.querySelector('#rbt-file-txt')?.addEventListener('change', (e) => {
        _batchAssignTxtFiles(Array.from(e.target.files));
        e.target.value = '';
    });

    // ── 配乐批量设置 ──
    container.querySelector('#rbt-set-bgm-btn')?.addEventListener('click', () => {
        // 点击“设置配乐”按钮，先选文件，然后应用到勾选的行
        _batchTableState._bgmBatchMode = true;
        container.querySelector('#rbt-file-bgm').click();
    });
    container.querySelector('#rbt-bgm-select-all')?.addEventListener('change', (e) => {
        const checked = e.target.checked;
        container.querySelectorAll('.rbt-bgm-check').forEach(cb => {
            cb.checked = checked;
        });
    });
    container.querySelector('#rbt-file-bgm')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const filePath = (typeof getFileNativePath === 'function') ? getFileNativePath(file) : (file.path || file.name);
        const state = window._reelsState;

        if (_batchTableState._bgmBatchMode) {
            // 批量模式：应用到所有勾选的行
            const checks = container.querySelectorAll('.rbt-bgm-check:checked');
            let targets;
            if (checks.length > 0) {
                targets = Array.from(checks).map(c => state.tasks[parseInt(c.dataset.idx)]).filter(Boolean);
            } else {
                // 没有勾选任何行，应用到全部
                targets = state.tasks;
            }
            for (const t of targets) {
                t.bgmPath = filePath;
            }
            _renderBatchTable();
            if (typeof _renderTaskList === 'function') _renderTaskList();
            alert(`✅ 已将配乐设置到 ${targets.length} 个任务`);
        } else if (_batchTableState._bgmSingleIdx != null) {
            // 单行模式
            const task = state.tasks[_batchTableState._bgmSingleIdx];
            if (task) {
                task.bgmPath = filePath;
                _renderBatchTable();
                if (typeof _renderTaskList === 'function') _renderTaskList();
            }
        }
        _batchTableState._bgmBatchMode = false;
        _batchTableState._bgmSingleIdx = null;
        e.target.value = '';
    });

    // ── 单行文件选择 ──
    container.querySelector('#rbt-file-single')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const { idx, field } = _batchTableState._pendingSingle || {};
        if (idx != null && field) {
            _assignSingleFile(idx, field, file);
        }
        _batchTableState._pendingSingle = null;
        e.target.value = '';
    });

    // ── 表格内输入框快捷批量粘贴 ──
    container.querySelector('#rbt-tbody')?.addEventListener('paste', (e) => {
        const target = e.target;
        if (!target.matches('textarea, input.rbt-input, input.rbt-tts-voice-input')) return;

        const pastedData = (e.clipboardData || window.clipboardData).getData('text');
        if (!pastedData) return;

        // 使用 TSV 引号解析器，正确处理 Google Sheets 单元格内的换行
        const tsvRows = _parseBatchTSV(pastedData);

        const startIdx = parseInt(target.dataset.idx, 10);
        if (isNaN(startIdx)) return;

        let fieldCategory = null;
        if (target.classList.contains('rbt-ai-script-input')) fieldCategory = 'aiScript';
        else if (target.classList.contains('rbt-tts-text-input')) fieldCategory = 'ttsText';
        else if (target.classList.contains('rbt-txtcontent-input')) fieldCategory = 'txtContent';
        else if (target.classList.contains('rbt-title-input')) fieldCategory = 'overlay_title';
        else if (target.classList.contains('rbt-body-input')) fieldCategory = 'overlay_body';
        else if (target.classList.contains('rbt-footer-input')) fieldCategory = 'overlay_footer';
        else if (target.classList.contains('rbt-scroll-title-input')) fieldCategory = 'scroll_title';
        else if (target.classList.contains('rbt-scroll-body-input')) fieldCategory = 'scroll_body';
        else if (target.classList.contains('rbt-tts-voice-input')) fieldCategory = 'ttsVoiceId';
        else if (target.classList.contains('rbt-flipper-enabled-input')) fieldCategory = 'overlay_flipper_enabled';
        else if (target.classList.contains('rbt-flipper-duration-input')) fieldCategory = 'overlay_flipper_duration';
        else if (target.classList.contains('rbt-flipper-lines-input')) fieldCategory = 'overlay_flipper_lines';
        else if (target.classList.contains('rbt-flipper-effect-input')) fieldCategory = 'overlay_flipper_effect';
        else if (target.classList.contains('rbt-flipper-loop-input')) fieldCategory = 'overlay_flipper_loop';
        else if (target.classList.contains('rbt-flipper-transition-duration-input')) fieldCategory = 'overlay_flipper_transition_duration';
        else if (target.dataset.field) fieldCategory = target.dataset.field;

        let maxCols = Math.max(...tsvRows.map(r => r.length));
        while (maxCols > 1) {
            let hasData = false;
            for (let r = 0; r < tsvRows.length; r++) {
                if (tsvRows[r][maxCols - 1] && tsvRows[r][maxCols - 1].trim() !== '') {
                    hasData = true; break;
                }
            }
            if (hasData) break;
            maxCols--;
        }

        if (maxCols > 1) {
            e.preventDefault();
            _showMultiColumnPasteModal(tsvRows, startIdx, fieldCategory);
            return;
        }

        // ── 单列粘贴：不再自动拆分多行到多个任务行 ──
        // 用户如果需要批量填充多行，请使用列标题上的 📋 按钮
        // 直接粘贴到输入框时，保留原始换行，填入当前单元格
        const preservedText = tsvRows.map(row => (row[0] || '')).join('\n');
        if (preservedText.trim()) {
            e.preventDefault();
            target.value = preservedText;
            // 触发 input/change 事件同步 state
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });

    // ── 拖拽文件到批量表格 ──
    const panel = container.querySelector('.rbt-panel') || container;
    let _dropOverlay = null;
    const _showDropOverlay = () => {
        if (_dropOverlay) return;
        _dropOverlay = document.createElement('div');
        _dropOverlay.style.cssText = 'position:absolute;inset:0;z-index:99;background:rgba(80,140,255,0.15);border:3px dashed #4a9eff;border-radius:12px;display:flex;align-items:center;justify-content:center;pointer-events:none;';
        _dropOverlay.innerHTML = '<span style="font-size:24px;color:#4a9eff;font-weight:700;text-shadow:0 2px 8px rgba(0,0,0,0.5);">📂 拖放文件到这里</span>';
        panel.style.position = 'relative';
        panel.appendChild(_dropOverlay);
    };
    const _hideDropOverlay = () => {
        if (_dropOverlay) { _dropOverlay.remove(); _dropOverlay = null; }
    };
    let _dragCounter = 0;
    panel.addEventListener('dragenter', (e) => {
        e.preventDefault();
        // Don't show panel overlay when dragging over sidebar
        if (e.target.closest && e.target.closest('#rbt-media-sidebar')) return;
        _dragCounter++;
        _showDropOverlay();
    });
    panel.addEventListener('dragleave', (e) => {
        e.preventDefault();
        if (e.target.classList && e.target.classList.contains('rbt-droppable')) {
            e.target.classList.remove('rbt-drag-over');
        }
        _dragCounter--;
        if (_dragCounter <= 0) {
            _dragCounter = 0;
            _hideDropOverlay();
            panel.querySelectorAll('.rbt-droppable.rbt-drag-over, .rbt-row.rbt-row-drag-over').forEach(c => {
                c.classList.remove('rbt-drag-over');
                c.classList.remove('rbt-row-drag-over');
            });
        }
    });
    panel.addEventListener('dragover', (e) => {
        e.preventDefault();
        // Let media sidebar handle its own dragover
        if (e.target.closest && e.target.closest('#rbt-media-sidebar')) return;
        // 内部行拖拽时不覆盖 dropEffect
        if (_dragSrcIdx == null) e.dataTransfer.dropEffect = 'copy';

        // Highlight logic for specific droppable columns and target rows
        const cell = e.target.closest('.rbt-droppable');
        const row = e.target.closest('.rbt-row');
        panel.querySelectorAll('.rbt-droppable.rbt-drag-over').forEach(c => {
            if (c !== cell) c.classList.remove('rbt-drag-over');
        });
        panel.querySelectorAll('.rbt-row.rbt-row-drag-over').forEach(r => {
            if (r !== row) r.classList.remove('rbt-row-drag-over');
        });
        if (cell) cell.classList.add('rbt-drag-over');
        if (row && _dragSrcIdx == null) row.classList.add('rbt-row-drag-over');
    });
    panel.addEventListener('drop', async (e) => {
        _dragCounter = 0;
        _hideDropOverlay();
        panel.querySelectorAll('.rbt-droppable.rbt-drag-over, .rbt-row.rbt-row-drag-over').forEach(c => {
            c.classList.remove('rbt-drag-over');
            c.classList.remove('rbt-row-drag-over');
        });
        // If drop lands inside media sidebar, let the sidebar's own handler deal with it
        if (e.target.closest && e.target.closest('#rbt-media-sidebar')) return;

        // Handle Pool Item Drop to Row
        let poolIdxStr = e.dataTransfer.getData('application/x-media-pool-idx');
        if (poolIdxStr) {
            e.preventDefault();
            const poolIdx = parseInt(poolIdxStr);
            const rowEl = e.target.closest('.rbt-row');
            if (!rowEl) return;
            const taskIdx = parseInt(rowEl.dataset.idx);

            const dropCell = e.target.closest('.rbt-droppable');
            const targetField = dropCell ? dropCell.dataset.field : null;

            const item = window._mediaPool.items[poolIdx];
            const task = window._reelsState.tasks[taskIdx];
            if (item && task) {
                if (targetField === 'contentvideo') { task.contentVideoPath = item.path; }
                else if (targetField === 'bg') { _setTaskSingleBackground(task, item.path); }
                else if (targetField === 'hook') {
                    if (!task.hook) task.hook = {};
                    task.hook.enabled = true;
                    task.hook.path = item.path;
                    task.hookFile = item.path;
                }
                else if (targetField === 'audio') { task.audioPath = item.path; }
                else if (targetField === 'bgm') {
                    if (task.bgmMode === 'multi') {
                        if (!task.bgmClipPool) task.bgmClipPool = [];
                        if (!task.bgmClipPool.includes(item.path)) task.bgmClipPool.push(item.path);
                    } else {
                        task.bgmPath = item.path;
                    }
                }
                else if (targetField === 'srt') { task.srtPath = item.path; }
                else if (targetField === 'cover_media') { if (!task.cover) task.cover = {}; task.cover.enabled = true; task.cover.bgPath = item.path; }
                else if (targetField === 'pip') { task.pipPath = item.path; }
                // Default fallback if dropped on non-specific column
                else if (item.type === 'seq') { _setTaskSingleBackground(task, item.path); }
                else if (item.isAudio) { task.audioPath = item.path; }
                else if (item.ext === 'srt') { task.srtPath = item.path; }
                else if (item.ext === 'txt') { task.txtContent = ''; task.txtPath = item.path; }
                else { _setTaskSingleBackground(task, item.path); }

                _renderBatchTable();
                if (typeof showToast === 'function') showToast(`✅ 已将素材 ${item.name} 分配到第 ${taskIdx + 1} 行`, 'success');
            }
            return;
        }

        // 如果是内部行拖拽排序（无文件），不拦截，让 tbody 的 drop 处理
        if (_dragSrcIdx != null) return;

        const files = Array.from(e.dataTransfer.files || []).sort(_naturalSortByName);
        if (!files.length) return;
        e.preventDefault();

        // In Electron with context isolation, a File passed from the renderer
        // to preload may no longer be accepted by webUtils.getPathForFile().
        // Preload captures native paths from the original drop event; attach
        // them to these renderer-side File objects before any routing occurs.
        const droppedPaths = window.electronAPI?.consumeDroppedFilePaths?.() || [];
        files.forEach((file, index) => {
            if (!file._nativePath && droppedPaths[index]) file._nativePath = droppedPaths[index];
        });

        // ── Check if any directory was dropped ──
        const paths = files.map(_rbtGetNativeFilePath).filter(Boolean);
        const dirs = paths.filter(p => _isDirectoryPath(p));
        if (dirs.length > 0) {
            await _importFoldersAsFileTaskTabs(dirs);
            return;
        }

        // ── 精确落到 bgm 单元格时，设为配乐或追加到配乐池 ──
        const dropCell = e.target.closest('.rbt-droppable');
        const targetRow = e.target.closest('.rbt-row');
        if (dropCell && dropCell.dataset.field === 'bgm') {
            const row = dropCell.closest('.rbt-row');
            if (row) {
                const idx = parseInt(row.dataset.idx);
                const task = window._reelsState.tasks[idx];
                if (task) {
                    const audioFiles = files.filter(f => {
                        const ext = (f.name || '').split('.').pop().toLowerCase();
                        return ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'].includes(ext);
                    });
                    if (audioFiles.length > 0) {
                        const paths = [];
                        for (const af of audioFiles) {
                            let fpath = _rbtGetNativeFilePath(af) || af.path || af.name;
                            if (fpath) paths.push(fpath);
                        }
                        if (paths.length > 0) {
                            if (task.bgmMode === 'multi') {
                                if (!task.bgmClipPool) task.bgmClipPool = [];
                                paths.forEach(p => {
                                    if (!task.bgmClipPool.includes(p)) task.bgmClipPool.push(p);
                                });
                            } else {
                                task.bgmPath = paths[0];
                            }
                            _renderBatchTable();
                            if (typeof showToast === 'function') showToast(`✅ 已更新第 ${idx + 1} 行的配乐`, 'success');
                        }
                    } else {
                        if (typeof showToast === 'function') showToast(`⚠️ 仅支持拖入音频文件作为配乐`, 'warning');
                    }
                }
            }
            return;
        }

        // ── 精确落到 hook 单元格时，直接设为前置 Hook ──
        if (dropCell && dropCell.dataset.field === 'hook') {
            const row = dropCell.closest('.rbt-row');
            if (row && files[0]) {
                const idx = parseInt(row.dataset.idx);
                const task = window._reelsState.tasks[idx];
                if (task) {
                    const filePath = _rbtGetNativeFilePath(files[0]) || files[0].path || files[0].name;
                    if (!task.hook) task.hook = {};
                    task.hook.enabled = true;
                    task.hook.path = filePath;
                    task.hookFile = filePath;
                    _renderBatchTable();
                    if (typeof showToast === 'function') showToast(`✅ 已设置第 ${idx + 1} 行前置 Hook`, 'success');
                }
            }
            return;
        }

        // ── 精确落到 audio 单元格时，直接设为人声 ──
        if (dropCell && dropCell.dataset.field === 'audio') {
            const row = dropCell.closest('.rbt-row');
            if (row && files[0]) {
                const idx = parseInt(row.dataset.idx);
                const task = window._reelsState.tasks[idx];
                if (task) {
                    const filePath = _rbtGetNativeFilePath(files[0]) || files[0].path || files[0].name;
                    task.audioPath = filePath;
                    _renderBatchTable();
                    if (typeof showToast === 'function') showToast(`✅ 已设置第 ${idx + 1} 行人声音频`, 'success');
                }
            }
            return;
        }

        // ── 精确落到 srt 单元格时 ──
        if (dropCell && dropCell.dataset.field === 'srt') {
            const row = dropCell.closest('.rbt-row');
            if (row && files[0]) {
                const idx = parseInt(row.dataset.idx);
                const task = window._reelsState.tasks[idx];
                if (task) {
                    const filePath = _rbtGetNativeFilePath(files[0]) || files[0].path || files[0].name;
                    task.srtPath = filePath;
                    _readSrtFileToTask(task, files[0]);
                    _renderBatchTable();
                    if (typeof showToast === 'function') showToast(`✅ 已更新第 ${idx + 1} 行字幕文件`, 'success');
                }
            }
            return;
        }

        // ── 精确落到 contentvideo 单元格时 ──
        if (dropCell && dropCell.dataset.field === 'contentvideo') {
            const row = dropCell.closest('.rbt-row');
            if (row && files[0]) {
                const idx = parseInt(row.dataset.idx);
                const task = window._reelsState.tasks[idx];
                if (task) {
                    const filePath = _rbtGetNativeFilePath(files[0]) || files[0].path || files[0].name;
                    task.contentVideoPath = filePath;
                    if (task.contentVideoScale == null) task.contentVideoScale = 100;
                    if (task.contentVideoX == null) task.contentVideoX = 'center';
                    if (task.contentVideoY == null) task.contentVideoY = 'center';
                    _renderBatchTable();
                    if (typeof showToast === 'function') showToast(`✅ 已设置第 ${idx + 1} 行内容视频`, 'success');
                }
            }
            return;
        }

        // ── 精确落到 pip 单元格时 ──
        if (dropCell && dropCell.dataset.field === 'pip') {
            const row = dropCell.closest('.rbt-row');
            if (row && files[0]) {
                const idx = parseInt(row.dataset.idx);
                const task = window._reelsState.tasks[idx];
                if (task) {
                    const filePath = _rbtGetNativeFilePath(files[0]) || files[0].path || files[0].name;
                    task.pipPath = filePath;
                    _renderBatchTable();
                    if (typeof showToast === 'function') showToast(`✅ 已设置第 ${idx + 1} 行图像覆层`, 'success');
                }
            }
            return;
        }

        // ── 精确落到 cover_media 单元格时，直接设为封面背景 ──
        if (dropCell && dropCell.dataset.field === 'cover_media') {
            const row = dropCell.closest('.rbt-row');
            if (row && files[0]) {
                const idx = parseInt(row.dataset.idx);
                const task = window._reelsState.tasks[idx];
                if (task) {
                    const filePath = _rbtGetNativeFilePath(files[0]) || files[0].path || files[0].name;
                    if (!task.cover) task.cover = {};
                    task.cover.enabled = true;
                    task.cover.bgPath = filePath;
                    if (!task.cover.overlays) task.cover.overlays = [];
                    _renderBatchTable();
                    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
                    if (typeof showToast === 'function') showToast(`✅ 已设置第 ${idx + 1} 行封面背景`, 'success');
                }
            }
            return;
        }

        // 按扩展名分类
        const bgExts = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp']);
        const audioExts = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma']);
        const groups = { hook: [], bg: [], audio: [], srt: [], txt: [] };
        const forcedVideoRoute = _batchTableState.videoDropRouteEnabled
            ? _batchTableState.videoDropRouteMode
            : null;

        // ── 单个或多个视频/图片直接拖入指定任务行（或该行的 bg 单元格）时，直接绑定到该任务行 ──
        const isRowDirectBgDrop = targetRow && (!dropCell || dropCell.dataset.field === 'bg') && forcedVideoRoute !== 'audio' && forcedVideoRoute !== 'hook';
        if (isRowDirectBgDrop) {
            const allBgMedia = files.every(f => {
                const ext = (f.name || '').split('.').pop().toLowerCase();
                return bgExts.has(ext) && !(_VOICE_VIDEO_EXTS.has(ext) && _looksLikeVoiceTrack(f.name || '') && !dropCell);
            });
            if (allBgMedia) {
                const idx = parseInt(targetRow.dataset.idx, 10);
                const task = window._reelsState?.tasks?.[idx];
                if (task) {
                    const bgPaths = files
                        .slice()
                        .sort(_naturalSortByName)
                        .map(f => _rbtGetNativeFilePath(f) || f.path || f.name)
                        .filter(Boolean);
                    if (bgPaths.length === 1) {
                        if (task.bgSrcUrl && task.bgSrcUrl.startsWith('blob:')) {
                            try { URL.revokeObjectURL(task.bgSrcUrl); } catch (_) { }
                        }
                        _setTaskSingleBackground(task, bgPaths[0], { bgSrcUrl: null });
                        task.srcUrl = null;
                    } else if (bgPaths.length > 1) {
                        task.bgMode = 'multi';
                        task.bgClipPool = bgPaths;
                        task.bgClipActivePool = [];
                        task.bgClipOrder = task.bgClipOrder || 'sequence';
                        task.bgTransition = task.bgTransition || 'crossfade';
                        task.bgTransDur = task.bgTransDur ?? 0.5;
                        task.bgPath = bgPaths[0];
                        task.videoPath = bgPaths[0];
                        task.bgSrcUrl = null;
                        task.srcUrl = null;
                    }
                    _skipNextApply = true;
                    _renderBatchTable();
                    if (typeof _renderTaskList === 'function') _renderTaskList();
                    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
                    if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
                    if (typeof _batchAutoSave === 'function') _batchAutoSave();
                    if (typeof showToast === 'function') {
                        showToast(
                            bgPaths.length > 1
                                ? `🎬 已将 ${bgPaths.length} 个素材设为第 ${idx + 1} 行的多素材背景`
                                : `✅ 已设置第 ${idx + 1} 行背景素材`,
                            'success'
                        );
                    }
                    return;
                }
            }
        }

        for (const f of files) {
            const ext = (f.name || '').split('.').pop().toLowerCase();
            if (ext === 'srt') groups.srt.push(f);
            else if (ext === 'txt') groups.txt.push(f);
            else if (audioExts.has(ext)) groups.audio.push(f);
            else if (_VOICE_VIDEO_EXTS.has(ext) && forcedVideoRoute === 'audio') groups.audio.push(f);
            else if (_VOICE_VIDEO_EXTS.has(ext) && forcedVideoRoute === 'bg') groups.bg.push(f);
            else if (_VOICE_VIDEO_EXTS.has(ext) && forcedVideoRoute === 'hook') groups.hook.push(f);
            else if (_VOICE_VIDEO_EXTS.has(ext) && _looksLikeVoiceTrack(f.name || '')) groups.audio.push(f);
            else if (bgExts.has(ext)) {
                if (forcedVideoRoute === 'hook') groups.hook.push(f);
                else groups.bg.push(f);
            }
        }

        // 依次批量分配（异步串行）
        (async () => {
            const assignments = [];
            if (groups.hook.length) assignments.push(['hook', groups.hook]);
            if (groups.bg.length) assignments.push(['bg', groups.bg]);
            
            if (groups.audio.length) {
                const choice = await _showAudioRouteSelectionDialog(groups.audio.length);
                if (choice === 'cancel') return;
                assignments.push([choice, groups.audio]);
            }
            
            if (groups.srt.length) assignments.push(['srt', groups.srt]);
            if (groups.txt.length) assignments.push(['txt', groups.txt]);

            if (assignments.length === 0) {
                alert('未识别到支持的文件类型');
                return;
            }

            for (const [field, fieldFiles] of assignments) {
                await _batchAssignFiles(fieldFiles, field);
            }
        })();
    });

    // ── 批量清空列（勾选优先，未勾选则全部） ──
    const _getClearTargets = () => {
        const state = window._reelsState;
        if (!state || !state.tasks) return { state: null, indices: [], label: '0行' };
        let indices = _getSelectedIndices();
        const label = indices.length > 0 ? `勾选的 ${indices.length} 行` : '所有行';
        if (indices.length === 0) indices = state.tasks.map((_, i) => i);
        return { state, indices, label };
    };

    const _clearTaskField = (task, field) => {
        if (!task) return;
        let targetId = null;
        let baseField = field;
        const match = field.match(/^(overlay_title|overlay_body|overlay_footer|scroll_title|scroll_body|overlay_flipper_enabled|overlay_flipper_duration|overlay_flipper_lines|overlay_flipper_effect|overlay_flipper_loop|overlay_flipper_transition_duration)_(.+)$/);
        if (match) {
            baseField = match[1];
            targetId = match[2];
        }

        switch (baseField) {
            case 'cover_media':
                if (task.cover) {
                    task.cover.enabled = false;
                    task.cover.bgPath = '';
                }
                break;
            case 'cover_text':
                if (task.cover && task.cover.overlays && task.cover.overlays.length > 0) {
                    task.cover.overlays[0].title_text = '';
                    task.cover.overlays[0].body_text = '';
                }
                break;
            case 'hook':
                task.hookFile = '';
                task.hookTrimStart = null;
                task.hookTrimEnd = null;
                task.hookSpeed = 1;
                task.hookTransition = 'none';
                task.hookTransDuration = 0.5;
                if (!task.hook) task.hook = {};
                task.hook.enabled = false;
                task.hook.path = '';
                break;
            case 'bg':
                task.bgPath = '';
                task.videoPath = '';
                task.bgSrcUrl = '';
                task.bgMode = 'single';
                task.bgClipPool = [];
                task.bgClipActivePool = [];
                task.bgClipOrder = 'random';
                task.bgTransition = 'crossfade';
                break;
            case 'clipPool':
                task.clipPoolDir = '';
                task.clipPool = [];
                task.concatVideoPath = '';
                task.concatStatus = '';
                break;
            case 'tts_text':
                task.ttsText = '';
                break;
            case 'tts_voice':
                task.ttsVoiceId = '';
                break;
            case 'pip':
                task.pipPath = '';
                break;
            case 'audio':
                task.audioPath = '';
                break;
            case 'srt':
                task.srtPath = '';
                task.aligned = false;
                task.segments = [];
                break;
            case 'txt':
                task.txtContent = '';
                task.aligned = false;
                task.segments = [];
                break;
            case 'ai_script':
                task.aiScript = '';
                break;
            case 'bgm':
                task.bgmPath = '';
                break;
            case 'contentvideo':
                task.contentVideoPath = '';
                task.contentVideoTrimStart = null;
                task.contentVideoTrimEnd = null;
                task.contentVideoScale = 100;
                task.contentVideoX = 'center';
                task.contentVideoY = 'center';
                task.contentVideoCrop = '';
                task.contentVideoBlurBg = false;
                task.contentVideoDirectBg = false;
                break;
            case 'cvTrim':
            case 'cvtrim':
                task.contentVideoTrimStart = null;
                task.contentVideoTrimEnd = null;
                break;
            case 'cvCrop':
            case 'cvcrop':
                task.contentVideoCrop = '';
                break;
            case 'cvBlurBg':
            case 'cvblurbg':
                task.contentVideoBlurBg = false;
                task.contentVideoDirectBg = false;
                break;
            case 'overlay':
                if (task.overlays && task.overlays.length > 0) {
                    for (const ov of task.overlays) {
                        if (ov.fixed_text) continue;
                        if (ov.type === 'textcard' || !ov.type || ov.type === '') {
                            ov.title_text = '';
                            ov.body_text = '';
                            ov.footer_text = '';
                        } else if (ov.type === 'scroll') {
                            ov.scroll_title = '';
                            ov.content = '';
                        } else if (ov.type === 'text') {
                            ov.content = '';
                        }
                    }
                }
                break;
            case 'overlay_title':
                if (task.overlays && task.overlays.length > 0) {
                    if (targetId) {
                        const ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'textcard');
                        if (ov) ov.title_text = '';
                    } else {
                        for (const ov of task.overlays) if (!ov.fixed_text && (ov.type === 'textcard' || !ov.type || ov.type === '')) ov.title_text = '';
                    }
                }
                break;
            case 'overlay_flipper_enabled':
                if (task.overlays && task.overlays.length > 0) {
                    if (targetId) {
                        const ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'textcard');
                        if (ov) ov.flipper_enabled = false;
                    } else {
                        for (const ov of task.overlays) if (!ov.fixed_text && (ov.type === 'textcard' || !ov.type || ov.type === '')) ov.flipper_enabled = false;
                    }
                }
                break;
            case 'overlay_flipper_duration':
                if (task.overlays && task.overlays.length > 0) {
                    if (targetId) {
                        const ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'textcard');
                        if (ov) ov.flipper_duration = 2.0;
                    } else {
                        for (const ov of task.overlays) if (!ov.fixed_text && (ov.type === 'textcard' || !ov.type || ov.type === '')) ov.flipper_duration = 2.0;
                    }
                }
                break;
            case 'overlay_flipper_lines':
                if (task.overlays && task.overlays.length > 0) {
                    if (targetId) {
                        const ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'textcard');
                        if (ov) ov.flipper_lines = 2;
                    } else {
                        for (const ov of task.overlays) if (!ov.fixed_text && (ov.type === 'textcard' || !ov.type || ov.type === '')) ov.flipper_lines = 2;
                    }
                }
                break;
            case 'overlay_flipper_effect':
                if (task.overlays && task.overlays.length > 0) {
                    if (targetId) {
                        const ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'textcard');
                        if (ov) ov.flipper_effect = 'none';
                    } else {
                        for (const ov of task.overlays) if (!ov.fixed_text && (ov.type === 'textcard' || !ov.type || ov.type === '')) ov.flipper_effect = 'none';
                    }
                }
                break;
            case 'overlay_flipper_loop':
                if (task.overlays && task.overlays.length > 0) {
                    if (targetId) {
                        const ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'textcard');
                        if (ov) ov.flipper_loop = false;
                    } else {
                        for (const ov of task.overlays) if (!ov.fixed_text && (ov.type === 'textcard' || !ov.type || ov.type === '')) ov.flipper_loop = false;
                    }
                }
                break;
            case 'overlay_flipper_transition_duration':
                if (task.overlays && task.overlays.length > 0) {
                    if (targetId) {
                        const ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'textcard');
                        if (ov) ov.flipper_transition_duration = 0.3;
                    } else {
                        for (const ov of task.overlays) if (!ov.fixed_text && (ov.type === 'textcard' || !ov.type || ov.type === '')) ov.flipper_transition_duration = 0.3;
                    }
                }
                break;
            case 'overlay_body':
                if (task.overlays && task.overlays.length > 0) {
                    if (targetId) {
                        const ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'textcard');
                        if (ov) ov.body_text = '';
                    } else {
                        for (const ov of task.overlays) if (!ov.fixed_text && (ov.type === 'textcard' || !ov.type || ov.type === '')) ov.body_text = '';
                    }
                }
                break;
            case 'overlay_footer':
                if (task.overlays && task.overlays.length > 0) {
                    if (targetId) {
                        const ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'textcard');
                        if (ov) ov.footer_text = '';
                    } else {
                        for (const ov of task.overlays) if (!ov.fixed_text && (ov.type === 'textcard' || !ov.type || ov.type === '')) ov.footer_text = '';
                    }
                }
                break;
            case 'scroll_title':
                if (task.overlays && task.overlays.length > 0) {
                    if (targetId) {
                        const ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'scroll');
                        if (ov) ov.scroll_title = '';
                    } else {
                        for (const ov of task.overlays) if (!ov.fixed_text && ov.type === 'scroll') ov.scroll_title = '';
                    }
                }
                break;
            case 'scroll_body':
                if (task.overlays && task.overlays.length > 0) {
                    if (targetId) {
                        const ov = _findBatchOverlayByIdOrIdx(task, targetId, null, null, 'scroll');
                        if (ov) ov.content = '';
                    } else {
                        for (const ov of task.overlays) if (!ov.fixed_text && ov.type === 'scroll') ov.content = '';
                    }
                }
                break;
            case 'exportName':
                task.exportName = '';
                break;
            case 'bgClipSettings':
                task.bgClipSettings = {};
                break;
            case 'bgVideoVolume':
                delete task.bgVideoVolume;
                break;
            case 'voiceVolume':
                delete task.voiceVolume;
                break;
            case 'bgScale':
                task.bgScale = 100;
                break;
            case 'bgDurScale':
                task.bgDurScale = 100;
                break;
            case 'audioDurScale':
                task.audioDurScale = 100;
                break;
            case 'subtitleTime':
                task.subtitleTimeMode = 'full';
                task.subtitleTimeSlices = [];
                break;
            default:
                break;
        }
    };

    // ── 列标题清空按钮 ──
    container.querySelector('#rbt-table thead')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.rbt-th-clear');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const field = btn.dataset.clearCol;
        if (!field) return;

        let baseField = field;
        const match = field.match(/^(overlay_title|overlay_body|overlay_footer|scroll_title|scroll_body|overlay_flipper_enabled|overlay_flipper_duration|overlay_flipper_lines|overlay_flipper_effect|overlay_flipper_loop)_(.+)$/);
        if (match) {
            baseField = match[1];
        }

        const labelMap = {
            hook: 'Hook',
            bg: '背景素材',
            clipPool: '背景片段池',
            bgClipSettings: '背景池剪辑',
            contentvideo: '内容视频',
            cvTrim: '内容视频-时间段',
            cvCrop: '内容视频-裁切',
            cvBlurBg: '内容视频-毛玻璃背景',
            tts_text: '人声-配音文案',
            tts_voice: '人声-配音音色',
            pip: '图像覆层',
            audio: '人声-音频文件',
            srt: '人声-SRT字幕',
            txt: '人声-断行文案',
            ai_script: '人声-原文案',
            bgm: '配乐',
            overlay_title: '覆层标题',
            overlay_body: '覆层内容',
            overlay_footer: '覆层结尾',
            overlay_flipper_enabled: '启用翻转',
            overlay_flipper_duration: '翻转间隔',
            overlay_flipper_lines: '翻转行数',
            overlay_flipper_effect: '翻转效果',
            overlay_flipper_loop: '翻转循环',
            overlay_flipper_transition_duration: '过渡时长',
            scroll_title: '滚动标题',
            scroll_body: '滚动内容',
            cover_media: '封面素材',
            cover_text: '封面文案',
            bgVideoVolume: '背景音量',
            voiceVolume: '人声-音频音量',
            subtitleTime: '字幕时间切片',
        };
        const { state, indices, label } = _getClearTargets();
        if (!state || indices.length === 0) return;
        const fieldLabel = labelMap[baseField] || '该列';
        if (!confirm(`确定清空${label}的${fieldLabel}？`)) return;
        for (const idx of indices) _clearTaskField(state.tasks[idx], field);

        const scrollWrap = container.querySelector('.rbt-table-wrap');
        const scrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
        const scrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;
        _skipNextApply = true; // 清空已直接写入 state
        _renderBatchTable();
        const newScrollWrap = container.querySelector('.rbt-table-wrap');
        if (newScrollWrap) {
            newScrollWrap.scrollTop = scrollTop;
            newScrollWrap.scrollLeft = scrollLeft;
        }

        if (typeof showToast === 'function') showToast(`✅ 已清空${label}的${fieldLabel}`, 'success');
    });

    // ── 列标题粘贴按钮 ──
    container.querySelector('#rbt-table thead')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.rbt-th-paste');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const fieldCategory = btn.dataset.pasteCol;
        if (!fieldCategory) return;

        let raw = '';
        try { raw = await navigator.clipboard.readText(); } catch (ex) {
            showToast('无法读取剪贴板，请使用 Ctrl+V 在输入框中粘贴', 'error');
            return;
        }
        if (!raw || !raw.trim()) { showToast('剪贴板为空', 'error'); return; }

        const tsvRows = _parseBatchTSV(raw);
        let maxCols = Math.max(...tsvRows.map(r => r.length));
        while (maxCols > 1) {
            let hasData = false;
            for (let r = 0; r < tsvRows.length; r++) {
                if (tsvRows[r][maxCols - 1] && tsvRows[r][maxCols - 1].trim() !== '') { hasData = true; break; }
            }
            if (hasData) break;
            maxCols--;
        }
        if (maxCols > 1) {
            _showMultiColumnPasteModal(tsvRows, 0, fieldCategory);
            return;
        }

        const lines = tsvRows.map(row => (row[0] || '').trim()).filter(s => s.length > 0);
        if (!lines.length) { showToast('未检测到有效数据', 'error'); return; }

        const state = window._reelsState;
        if (!state) return;

        let filled = 0, created = 0;
        let dataIdx = 0;

        for (let i = 0; i < state.tasks.length && dataIdx < lines.length; i++) {
            const task = state.tasks[i];
            const str = lines[dataIdx];
            if (fieldCategory === 'aiScript') task.aiScript = str;
            else if (fieldCategory === 'ttsText') task.ttsText = str;
            else if (fieldCategory === 'txtContent') { task.txtContent = str; task.aligned = false; }
            else if (fieldCategory === 'ttsVoiceId') task.ttsVoiceId = str;
            else if (fieldCategory === 'exportName') task.exportName = str;
            else if (fieldCategory === 'bgClipSettings') {
                if (!task.bgClipSettings) task.bgClipSettings = {};
                const parsed = _parseClipSettingsString(str);
                const pool = task.bgClipPool || [];
                for (let j = 0; j < pool.length && j < parsed.length; j++) {
                    const path = pool[j];
                    task.bgClipSettings[path] = {
                        trimStart: parsed[j].trimStart,
                        trimEnd: parsed[j].trimEnd
                    };
                }
            }
            else if (fieldCategory === 'cover_text') {
                if (!task.cover) task.cover = { enabled: true, overlays: [] };
                if (task.cover.overlays && task.cover.overlays.length > 0) task.cover.overlays[0].title_text = str;
                else task.cover.overlays = [{ title_text: str, body_text: '', footer_text: '', type: 'textcard' }];
            }
            else if (fieldCategory.startsWith('overlay_') || fieldCategory.startsWith('scroll_')) {
                _applyOverlayField(task, fieldCategory, str);
            }
            dataIdx++;
            filled++;
        }

        const newRows = lines.slice(dataIdx);
        if (newRows.length > 0) {
            if (confirm(`剪贴板有 ${lines.length} 条数据，当前只有 ${state.tasks.length} 行。\n是否自动创建 ${newRows.length} 行新任务？`)) {
                for (const str of newRows) {
                    const taskName = _generateUniqueCardName(state.tasks, 'card');
                    const newTask = _createTaskFromTemplate(state, taskName);
                    if (fieldCategory === 'aiScript') newTask.aiScript = str;
                    else if (fieldCategory === 'ttsText') newTask.ttsText = str;
                    else if (fieldCategory === 'txtContent') { newTask.txtContent = str; }
                    else if (fieldCategory === 'ttsVoiceId') newTask.ttsVoiceId = str;
                    else if (fieldCategory === 'exportName') newTask.exportName = str;
                    else if (fieldCategory === 'bgClipSettings') {
                        if (!newTask.bgClipSettings) newTask.bgClipSettings = {};
                        const parsed = _parseClipSettingsString(str);
                        const pool = newTask.bgClipPool || [];
                        for (let j = 0; j < pool.length && j < parsed.length; j++) {
                            const path = pool[j];
                            newTask.bgClipSettings[path] = {
                                trimStart: parsed[j].trimStart,
                                trimEnd: parsed[j].trimEnd
                            };
                        }
                    }
                    else if (fieldCategory === 'cover_text') {
                        newTask.cover = { enabled: true, overlays: [{ title_text: str, body_text: '', footer_text: '', type: 'textcard' }] };
                    }
                    else if (fieldCategory.startsWith('overlay_') || fieldCategory.startsWith('scroll_')) {
                        _applyOverlayField(newTask, fieldCategory, str);
                    }
                    _finalizeDerivedTaskInstances(newTask);
                    state.tasks.push(newTask);
                    created++;
                }
            }
        }

        const scrollWrap = container.querySelector('.rbt-table-wrap');
        const scrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
        const scrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;

        _skipNextApply = true; // 粘贴已直接写入 state，跳过 DOM→state 同步
        _renderBatchTable();

        const newScrollWrap = container.querySelector('.rbt-table-wrap');
        if (newScrollWrap) {
            newScrollWrap.scrollTop = scrollTop;
            newScrollWrap.scrollLeft = scrollLeft;
        }

        showToast(`✅ 粘贴到列完成：覆盖 ${filled} 行，新建 ${created} 行`, 'success');
    });

    // ── 列标题文件夹按钮 ──
    container.querySelector('#rbt-table thead')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.rbt-th-folder');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const colType = btn.dataset.folderCol;
        if (!colType) return;

        if (!window.electronAPI || !window.electronAPI.selectDirectory) {
            showToast('请在桌面应用中使用此功能', 'error');
            return;
        }

        const dir = await window.electronAPI.selectDirectory();
        if (!dir) return;

        btn.textContent = '⏳';
        btn.disabled = true;

        try {
            const files = await window.electronAPI.scanDirectory(dir);
            if (!files || files.length === 0) {
                showToast('文件夹为空或无法读取', 'error');
                return;
            }

            // 按列类型过滤匹配的文件扩展名
            const extMap = {
                bg: new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']),
                audio: new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'mp4', 'mov']),
                srt: new Set(['srt']),
                bgm: new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']),
                pip: new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg']),
                contentvideo: new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm']),
            };
            const validExts = extMap[colType] || extMap.bg;

            const matched = files
                .filter(f => {
                    const ext = (f.name || '').split('.').pop().toLowerCase();
                    return validExts.has(ext);
                })
                .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));

            if (matched.length === 0) {
                showToast(`文件夹中没有找到匹配的文件`, 'error');
                return;
            }

            const state = window._reelsState;
            if (!state) return;

            let filled = 0, created = 0;
            let dataIdx = 0;

            // 分配到现有行
            for (let i = 0; i < state.tasks.length && dataIdx < matched.length; i++) {
                const task = state.tasks[i];
                const fpath = matched[dataIdx].path;
                if (colType === 'bg') {
                    _setTaskSingleBackground(task, fpath, { clearBgSrcUrl: true });
                } else if (colType === 'audio') {
                    task.audioPath = fpath;
                } else if (colType === 'srt') {
                    task.srtPath = fpath;
                } else if (colType === 'bgm') {
                    task.bgmPath = fpath;
                } else if (colType === 'pip') {
                    if (!task.overlays) task.overlays = [];
                    const pipOverlay = task.overlays.find(o => o && o.type === 'pip');
                    if (pipOverlay) { pipOverlay.src = fpath; }
                    else { task.overlays.push({ type: 'pip', src: fpath, x: 0, y: 0, w: 200, h: 200, start: 0, end: 9999 }); }
                } else if (colType === 'contentvideo') {
                    task.contentVideoPath = fpath;
                    if (task.contentVideoScale == null) task.contentVideoScale = 100;
                    if (task.contentVideoX == null) task.contentVideoX = 'center';
                    if (task.contentVideoY == null) task.contentVideoY = 'center';
                }
                dataIdx++;
                filled++;
            }

            // 超出部分提示创建新行
            const remaining = matched.length - dataIdx;
            if (remaining > 0) {
                if (confirm(`文件夹有 ${matched.length} 个文件，当前只有 ${state.tasks.length} 行。\n是否自动创建 ${remaining} 行新任务？`)) {
                    for (; dataIdx < matched.length; dataIdx++) {
                        const fpath = matched[dataIdx].path;
                        const fname = matched[dataIdx].name || '';
                        const baseName = fname.replace(/\.[^.]+$/, '');
                        const newTask = {
                            baseName, fileName: `${baseName}.mp4`,
                            bgPath: null, bgSrcUrl: null, audioPath: null, srtPath: null,
                            segments: [], videoPath: null, srcUrl: null, overlays: [],
                            aligned: false, bgScale: 100, bgDurScale: 100, audioDurScale: 100
                        };
                        if (colType === 'bg') { _setTaskSingleBackground(newTask, fpath); }
                        else if (colType === 'audio') newTask.audioPath = fpath;
                        else if (colType === 'srt') newTask.srtPath = fpath;
                        else if (colType === 'bgm') newTask.bgmPath = fpath;
                        else if (colType === 'pip') {
                            newTask.overlays = [{ type: 'pip', src: fpath, x: 0, y: 0, w: 200, h: 200, start: 0, end: 9999 }];
                        } else if (colType === 'contentvideo') {
                            newTask.contentVideoPath = fpath;
                            newTask.contentVideoScale = 100;
                            newTask.contentVideoX = 'center';
                            newTask.contentVideoY = 'center';
                        }
                        state.tasks.push(newTask);
                        created++;
                    }
                }
            }

            _renderBatchTable();
            const colLabels = { bg: '背景素材', audio: '人声-音频文件', srt: '人声-SRT字幕', bgm: '配乐', pip: '图像覆层', contentvideo: '内容视频' };
            showToast(`✅ ${colLabels[colType] || colType}：分配 ${filled} 个文件，新建 ${created} 行`, 'success');
        } finally {
            btn.textContent = '📁';
            btn.disabled = false;
        }
    });

    // 仅导出选中行（表格数据不变）
    container.querySelector('#rbt-export-selected-btn')?.addEventListener('click', () => {
        const selected = _batchTableState.selectedRows;
        if (selected.size === 0) return;
        _applyBatchTableChanges(); // 先同步输入框到 tasks
        const allTasks = window._reelsState.tasks;
        const exported = [...selected].sort((a, b) => a - b).map(i => allTasks[i]).filter(Boolean);
        // 临时替换 tasks 为选中行，关闭表格
        const backup = allTasks.slice();
        window._reelsState.tasks = exported;
        window._reelsState.selectedIdx = 0;
        reelsToggleBatchTable({ saveOnClose: false });
        if (typeof _renderTaskList === 'function') _renderTaskList();
        // 恢复完整 tasks 到 tab（表格下次打开还是全部）
        const tab = _getActiveTab();
        if (tab) tab.tasks = _serializeTasks(backup);
        if (typeof showToast === 'function') showToast(`📤 已导出 ${exported.length} 行到主面板（表格数据不变）`, 'success');
    });

    // ── 拖拽排序 ──
    _dragSrcIdx = null;
    let _dragMouseTarget = null; // 追踪实际点击的元素
    const tbody2 = container.querySelector('#rbt-tbody');
    if (tbody2) {
        // 记录鼠标按下的实际元素，dragstart时用它判断是否从手柄发起
        tbody2.addEventListener('mousedown', (e) => {
            _dragMouseTarget = e.target;
        });
        tbody2.addEventListener('pointerdown', (e) => {
            const input = e.target.closest('.rbt-textarea');
            if (!input) return;
            e.stopPropagation();
            input.draggable = false;
            setTimeout(() => {
                if (document.activeElement !== input && typeof input.focus === 'function') {
                    input.focus({ preventScroll: true });
                }
            }, 0);
        });
        tbody2.addEventListener('mousedown', (e) => {
            const input = e.target.closest('.rbt-textarea');
            if (!input) return;
            e.stopPropagation();
            _dragMouseTarget = null;
        });
        tbody2.addEventListener('click', (e) => {
            const input = e.target.closest('.rbt-textarea');
            if (!input) return;
            e.stopPropagation();
        });
        tbody2.addEventListener('dragstart', (e) => {
            const row = e.target.closest('.rbt-row');
            if (!row) { e.preventDefault(); return; }
            // Only allow drag from the handle
            if (!e.target.closest('.rbt-drag-handle') && (!_dragMouseTarget || !_dragMouseTarget.closest('.rbt-drag-handle'))) { e.preventDefault(); return; }
            _dragSrcIdx = parseInt(row.dataset.idx);
            row.classList.add('rbt-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(_dragSrcIdx));
        });
        tbody2.addEventListener('dragend', (e) => {
            const row = e.target.closest('.rbt-row');
            if (row) row.classList.remove('rbt-dragging');
            tbody2.querySelectorAll('.rbt-drag-over-row').forEach(r => r.classList.remove('rbt-drag-over-row'));
            _dragSrcIdx = null;
        });
        tbody2.addEventListener('dragover', (e) => {
            const hasPoolItem = e.dataTransfer.types.includes('application/x-media-pool-idx');
            // Allow dragover if dragging a row OR dragging a pool item
            if (_dragSrcIdx == null && !hasPoolItem) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = hasPoolItem ? 'copy' : 'move';
            const row = e.target.closest('.rbt-row');
            tbody2.querySelectorAll('.rbt-drag-over-row').forEach(r => r.classList.remove('rbt-drag-over-row'));
            if (row) row.classList.add('rbt-drag-over-row');
        });
        tbody2.addEventListener('dragleave', (e) => {
            const row = e.target.closest('.rbt-row');
            if (row) row.classList.remove('rbt-drag-over-row');
        });
        tbody2.addEventListener('drop', (e) => {
            tbody2.querySelectorAll('.rbt-drag-over-row').forEach(r => r.classList.remove('rbt-drag-over-row'));
            // If dragging from media pool, panel's drop handler will catch it, do not reorder rows here
            if (_dragSrcIdx == null) return;

            e.preventDefault();
            const row = e.target.closest('.rbt-row');
            if (!row || _dragSrcIdx == null) return;
            const dstIdx = parseInt(row.dataset.idx);
            if (dstIdx === _dragSrcIdx) return;
            const tasks = window._reelsState.tasks;
            if (!tasks) return;
            const [moved] = tasks.splice(_dragSrcIdx, 1);
            tasks.splice(dstIdx, 0, moved);
            const newSelected = new Set();
            for (const idx of _batchTableState.selectedRows) {
                if (idx === _dragSrcIdx) {
                    newSelected.add(dstIdx);
                } else if (_dragSrcIdx < dstIdx) {
                    if (idx > _dragSrcIdx && idx <= dstIdx) {
                        newSelected.add(idx - 1);
                    } else {
                        newSelected.add(idx);
                    }
                } else { // _dragSrcIdx > dstIdx
                    if (idx >= dstIdx && idx < _dragSrcIdx) {
                        newSelected.add(idx + 1);
                    } else {
                        newSelected.add(idx);
                    }
                }
            }
            _batchTableState.selectedRows = newSelected;
            _dragSrcIdx = null;
            // 保存滚动位置，渲染后恢复
            const scrollWrap = container.querySelector('.rbt-table-wrap');
            const scrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
            _renderBatchTable();
            const scrollWrap2 = container.querySelector('.rbt-table-wrap');
            if (scrollWrap2) scrollWrap2.scrollTop = scrollTop;
            if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
            if (typeof showToast === 'function') showToast(`已移动到第 ${dstIdx + 1} 行`, 'info');
        });
    }

    // Per-row events (delegated)
    const tbody = container.querySelector('#rbt-tbody');
    if (tbody) {
        // Windows 兼容：点击缩放显示值切换控件可见性（无 hover 时的替代方案）
        tbody.addEventListener('click', async (e) => {
            if (e.target.classList.contains('rbt-scale-display')) {
                const td = e.target.closest('td');
                if (td) {
                    // 移除其他 active
                    document.querySelectorAll('td.rbt-scale-active').forEach(el => {
                        if (el !== td) el.classList.remove('rbt-scale-active');
                    });
                    td.classList.toggle('rbt-scale-active');
                    // 聚焦第一个输入框
                    const firstInput = td.querySelector('input[type="number"], input[type="range"]');
                    if (firstInput && td.classList.contains('rbt-scale-active')) {
                        setTimeout(() => firstInput.focus(), 50);
                    }
                }
            }
        });
        // 音量滑块实时更新标签
        tbody.addEventListener('input', (e) => {
            if (e.target.classList.contains('rbt-bgm-start')) {
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) {
                    task.bgmStart = Math.max(0, parseFloat(e.target.value) || 0);
                    if (idx === window._reelsState.selectedIdx && window.ReelsPreviewV2 && typeof window.ReelsPreviewV2.seek === 'function') {
                        window.ReelsPreviewV2.seek(window._reelsState.timelineEditor?._playheadPos || 0);
                    }
                }
            }
            if (e.target.classList.contains('rbt-bgm-vol')) {
                const label = e.target.parentElement.querySelector('.rbt-bgm-vol-label');
                if (label) label.textContent = e.target.value + '%';
                const display = e.target.closest('td')?.querySelector('.rbt-scale-display');
                if (display) display.textContent = '🎵 Vol: ' + e.target.value + '%';
                e.target.dataset.isNull = 'false'; // USER INTERACTED!
                // Sync volume to task for real-time preview
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) {
                    task.bgmVolume = parseInt(e.target.value) || 0;
                    // If this is the selected task, update preview audio immediately
                    if (idx === window._reelsState.selectedIdx && typeof _applyPreviewAudioMix === 'function') {
                        _applyPreviewAudioMix();
                    }
                }
            }
            // ── 背景视频音量 slider ──
            if (e.target.classList.contains('rbt-bgvol-slider')) {
                const label = e.target.parentElement.querySelector('.rbt-bgvol-label');
                if (label) label.textContent = e.target.value + '%';
                const display = e.target.closest('td')?.querySelector('.rbt-scale-display');
                if (display) display.textContent = '🔉 ' + e.target.value + '%';
                e.target.dataset.isNull = 'false'; // USER INTERACTED!
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) {
                    task.bgVideoVolume = parseInt(e.target.value) || 0;
                    if (typeof _updateBgVolumeConsistencyHint === 'function') _updateBgVolumeConsistencyHint();
                    if (idx === window._reelsState.selectedIdx && typeof _applyPreviewAudioMix === 'function') {
                        _applyPreviewAudioMix();
                    }
                }
            }
            // ── 人声-音频音量 slider ──
            if (e.target.classList.contains('rbt-voicevol-slider')) {
                const label = e.target.parentElement.querySelector('.rbt-voicevol-label');
                if (label) label.textContent = e.target.value + '%';
                const display = e.target.closest('td')?.querySelector('.rbt-scale-display');
                if (display) display.textContent = '🎙 ' + e.target.value + '%';
                e.target.dataset.isNull = 'false';
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) {
                    task.voiceVolume = parseInt(e.target.value) || 0;
                    if (idx === window._reelsState.selectedIdx && typeof _applyPreviewAudioMix === 'function') {
                        _applyPreviewAudioMix();
                    }
                }
            }
            // ── 背景缩放 slider↔input 同步 ──
            if (e.target.classList.contains('rbt-bgscale-slider')) {
                const numInput = e.target.parentElement.querySelector('.rbt-bgscale-input');
                if (numInput) numInput.value = e.target.value;
                const display = e.target.closest('td')?.querySelector('.rbt-scale-display');
                if (display) display.textContent = e.target.value + '%';
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) { task.bgScale = parseInt(e.target.value) || 100; }
            }
            if (e.target.classList.contains('rbt-bgscale-input')) {
                const slider = e.target.closest('td').querySelector('.rbt-bgscale-slider');
                if (slider) slider.value = e.target.value;
                const display = e.target.closest('td')?.querySelector('.rbt-scale-display');
                if (display) display.textContent = e.target.value + '%';
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) { task.bgScale = parseInt(e.target.value) || 100; }
            }
            // ── 背景时长缩放 slider↔input 同步 ──
            if (e.target.classList.contains('rbt-bgdurscale-slider')) {
                const numInput = e.target.parentElement.querySelector('.rbt-bgdurscale-input');
                if (numInput) numInput.value = e.target.value;
                const display = e.target.closest('td')?.querySelector('.rbt-scale-display');
                if (display) display.textContent = e.target.value + '%';
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) { task.bgDurScale = parseInt(e.target.value) || 100; }
            }
            if (e.target.classList.contains('rbt-bgdurscale-input')) {
                const slider = e.target.closest('td').querySelector('.rbt-bgdurscale-slider');
                if (slider) slider.value = e.target.value;
                const display = e.target.closest('td')?.querySelector('.rbt-scale-display');
                if (display) display.textContent = e.target.value + '%';
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) { task.bgDurScale = parseInt(e.target.value) || 100; }
            }
            // ── 人声-音频变速 slider↔input 同步 ──
            if (e.target.classList.contains('rbt-audiodurscale-slider')) {
                const numInput = e.target.parentElement.querySelector('.rbt-audiodurscale-input');
                if (numInput) numInput.value = e.target.value;
                const display = e.target.closest('td')?.querySelector('.rbt-scale-display');
                if (display) display.textContent = e.target.value + '%';
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) { task.audioDurScale = parseInt(e.target.value) || 100; }
            }
            if (e.target.classList.contains('rbt-audiodurscale-input')) {
                const slider = e.target.closest('td').querySelector('.rbt-audiodurscale-slider');
                if (slider) slider.value = e.target.value;
                const display = e.target.closest('td')?.querySelector('.rbt-scale-display');
                if (display) display.textContent = e.target.value + '%';
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) { task.audioDurScale = parseInt(e.target.value) || 100; }
            }
            if (e.target.classList.contains('rbt-tts-text-input')) {
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) task.ttsText = e.target.value;
            }
            if (e.target.classList.contains('rbt-tts-voice-input')) {
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) task.ttsVoiceId = e.target.value;
            }
            if (e.target.classList.contains('rbt-ai-script-input') || e.target.classList.contains('rbt-txtcontent-input') || e.target.classList.contains('rbt-tts-text-input')) {
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) {
                    if (e.target.classList.contains('rbt-ai-script-input')) task.aiScript = e.target.value;
                    if (e.target.classList.contains('rbt-txtcontent-input')) task.txtContent = e.target.value;
                    if (e.target.classList.contains('rbt-tts-text-input')) task.ttsText = e.target.value;

                    const normalizeText = (str) => {
                        let s = (str || '');
                        s = s.replace(/\[.*?\]/g, '');
                        s = s.replace(/<.*?>/g, '');
                        return s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').toLowerCase();
                    };
                    const origNorm = normalizeText(task.aiScript);

                    const isDiffTxt = (origNorm !== normalizeText(task.txtContent)) && (task.txtContent && task.txtContent.trim().length > 0) && (task.aiScript && task.aiScript.trim().length > 0);
                    task.aiTextDiffWarning = !!isDiffTxt;

                    const isDiffTts = (origNorm !== normalizeText(task.ttsText)) && (task.ttsText && task.ttsText.trim().length > 0) && (task.aiScript && task.aiScript.trim().length > 0);
                    task.aiTtsDiffWarning = !!isDiffTts;

                    // 实时更新UI报警状态
                    const row = e.target.closest('tr.rbt-row');
                    if (row) {
                        const txtArea = row.querySelector('.rbt-txtcontent-input');
                        if (txtArea) {
                            if (isDiffTxt) {
                                txtArea.style.border = '1px solid #ef4444';
                                txtArea.style.background = 'rgba(239, 68, 68, 0.1)';
                                txtArea.title = '⚠️ 警告：AI断行产生的文本与【人声-原文案】存在字符差异。可能发生了改词或删词，请仔细检查比对！\n\n如有错误请直接修改。';
                            } else {
                                txtArea.style.border = '';
                                txtArea.style.background = '';
                                txtArea.title = txtArea.disabled ? '外部SRT优先级更高，文案处于禁用状态' : '双击放大编辑';
                            }
                        }
                        const tagSpan = row.querySelector('.rbt-col-txtcontent .diff-warning-badge');
                        if (isDiffTxt && !tagSpan) {
                            const wrapper = row.querySelector('.rbt-col-txtcontent > div');
                            if (wrapper) wrapper.insertAdjacentHTML('beforeend', '<div class="diff-warning-badge" style="margin-top:6px;font-size:12px;color:#ef4444;font-weight:bold;text-align:right;">⚠️词汇变动警告 <span class="diff-modal-btn" data-field="txt" data-idx="' + idx + '" style="color:#3b82f6;cursor:pointer;margin-left:8px;text-decoration:underline;">[🔍比对]</span></div>');
                        } else if (!isDiffTxt && tagSpan) {
                            tagSpan.remove();
                        }

                        const ttsArea = row.querySelector('.rbt-tts-text-input');
                        if (ttsArea) {
                            if (isDiffTts) {
                                ttsArea.style.border = '1px solid #ef4444';
                                ttsArea.style.background = 'rgba(239, 68, 68, 0.1)';
                                ttsArea.title = '⚠️ 警告：检测到配音文案与原文存在字符差异！请检查是否发生了改词！';
                            } else {
                                ttsArea.style.border = '';
                                ttsArea.style.background = '';
                                ttsArea.title = '双击放大编辑';
                            }
                        }

                        const tagSpanTts = row.querySelector('.rbt-col-tts_text .diff-warning-badge');
                        if (isDiffTts && !tagSpanTts) {
                            const wrapperTts = row.querySelector('.rbt-col-tts_text > div');
                            if (wrapperTts) wrapperTts.insertAdjacentHTML('beforeend', '<div class="diff-warning-badge" style="margin-top:6px;font-size:12px;color:#ef4444;font-weight:bold;text-align:right;">⚠️词汇变动警告 <span class="diff-modal-btn" data-field="tts" data-idx="' + idx + '" style="color:#3b82f6;cursor:pointer;margin-left:8px;text-decoration:underline;">[🔍比对]</span></div>');
                        } else if (!isDiffTts && tagSpanTts) {
                            tagSpanTts.remove();
                        }
                    }
                }
            }
        });
        // Row checkbox change handler
        tbody.addEventListener('change', (e) => {
            if (e.target.classList.contains('rbt-row-check')) {
                const idx = parseInt(e.target.dataset.idx);
                if (e.target.checked) {
                    _batchTableState.selectedRows.add(idx);
                } else {
                    _batchTableState.selectedRows.delete(idx);
                }
                _updateBatchSelectCount();
            } else if (e.target.classList.contains('rbt-cvbgmode-select')) {
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState?.tasks?.[idx];
                if (task) {
                    const mode = e.target.value;
                    if (mode === 'blur') {
                        task.contentVideoBlurBg = true;
                        task.contentVideoDirectBg = false;
                    } else if (mode === 'direct') {
                        task.contentVideoBlurBg = false;
                        task.contentVideoDirectBg = true;
                    } else {
                        task.contentVideoBlurBg = false;
                        task.contentVideoDirectBg = false;
                    }
                    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                    if (idx === window._reelsState.selectedIdx && window.reelsSyncBackgroundTabUI) {
                        window.reelsSyncBackgroundTabUI(task);
                    }
                    if (typeof _renderBatchTable === 'function') _renderBatchTable();
                }
            } else if (e.target.classList.contains('rbt-card-tpl-select')) {
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState?.tasks?.[idx];
                const presetName = e.target.value || '';
                const selectEl = e.target;
                if (task) {
                    if (presetName) {
                        _promptOverlayPresetOptions(presetName, [task], (opts) => {
                            const result = _applyAndVerifyOverlayGroupPresetToTask(task, presetName, opts);
                            if (!result.ok) {
                                alert(`⚠️ 第 ${idx + 1} 行覆层预设未通过校验：${result.reason}`);
                            }
                            _syncSelectedTaskOverlayMgrIfNeeded(idx);
                            if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                            _renderBatchTable(); // Force re-render to update inputs
                        });
                    } else {
                        task._overlayPresetName = '';
                        _syncSelectedTaskOverlayMgrIfNeeded(idx);
                        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                        _renderBatchTable();
                    }
                }
            }
        });
        tbody.addEventListener('click', async (e) => {
            const insertBtn = e.target.closest('.rbt-insert-btn');
            if (insertBtn) {
                const idx = parseInt(insertBtn.dataset.idx);
                const task = window._reelsState?.tasks?.[idx];
                if (!task) return;
                const action = await window.reelsShowInputDialog?.('本任务插入素材：1追加 / 2重生成自动 / 3清空重来 / 4时间线微调', '输入 1、2、3 或 4', '1');
                if (action === '4') { _applyBatchTableChanges(); reelsToggleBatchTable(); if (typeof reelsSelectTask === 'function') reelsSelectTask(idx); return; }
                if (!['1', '2', '3'].includes(action)) return;
                window.reelsInsertAtSilences?.({ task, mode: action === '2' ? 'regenerate' : action === '3' ? 'reset' : 'append' });
                return;
            }
            // 预览按钮
            const selectBtn = e.target.closest('.rbt-select-btn');
            if (selectBtn) {
                const idx = parseInt(selectBtn.dataset.idx);
                _applyBatchTableChanges();
                reelsToggleBatchTable();
                if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
                return;
            }
            // 对比差异按钮
            const diffBtn = e.target.closest('.rbt-diff-btn, .diff-modal-btn');
            if (diffBtn) {
                const idx = parseInt(diffBtn.dataset.idx);
                const field = diffBtn.dataset.field;
                const task = window._reelsState.tasks[idx];
                if (task) {
                    if (field === 'txt') {
                        _showDiffModal(task.aiScript, task.txtContent, 'txt', idx);
                    } else if (field === 'tts') {
                        _showDiffModal(task.aiScript, task.ttsText, 'tts', idx);
                    }
                }
                return;
            }
            // 复制行按钮
            const cloneBtn = e.target.closest('.rbt-clone-btn');
            if (cloneBtn) {
                const idx = parseInt(cloneBtn.dataset.idx);
                const src = window._reelsState.tasks[idx];
                if (src) {
                    const copy = _cloneBatchTasks([src])[0] || {};
                    let base = src.baseName || 'copy';
                    base = base.replace(/_copy(_\d+)?$/, '');
                    let newName = base + '_copy';
                    let suffixCounter = 1;
                    while (window._reelsState.tasks.some(t => t.baseName === newName)) {
                        newName = `${base}_copy_${suffixCounter}`;
                        suffixCounter++;
                    }
                    copy.baseName = newName;
                    copy.fileName = newName + '.mp4';
                    copy.id = 'task_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
                    window._reelsState.tasks.splice(idx + 1, 0, copy);
                    _renderBatchTable();
                    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
                }
                return;
            }
            // 删除按钮
            const delBtn = e.target.closest('.rbt-delete-btn');
            if (delBtn) {
                const idx = parseInt(delBtn.dataset.idx);
                const removed = window._reelsState.tasks.splice(idx, 1);
                if (typeof window.reelsSyncTaskRemovalToBatchTabs === 'function') {
                    window.reelsSyncTaskRemovalToBatchTabs(removed);
                } else if (typeof _syncTasksToActiveTab === 'function') {
                    _syncTasksToActiveTab();
                }
                _skipNextApply = true;
                _renderBatchTable();
                if (typeof _renderTaskList === 'function') _renderTaskList();
                if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
                if (typeof _batchAutoSave === 'function') _batchAutoSave();
                return;
            }
            // 模板选择器触发
            const subTplBtn = e.target.closest('.rbt-sub-tpl-trigger');
            if (subTplBtn) {
                e.stopPropagation();
                const idx = parseInt(subTplBtn.dataset.idx);
                const task = window._reelsState.tasks[idx];
                const currentVal = task._subtitlePreset || '';
                _openStyledPresetPicker(subTplBtn, currentVal, (val) => {
                    task._subtitlePreset = val;
                    const span = subTplBtn.querySelector('span');
                    if (span) span.textContent = val || '默认';
                    // 不必全表重新渲染，只做数据记录
                });
                return;
            }
            // 背景池剪辑时间设置单元格点击
            const bgcsCell = e.target.closest('.rbt-bgclipsettings-cell');
            if (bgcsCell) {
                e.stopPropagation();
                const idx = parseInt(bgcsCell.dataset.idx);
                _showBgPoolDialog(idx);
                return;
            }
            // 多素材池管理按钮
            const poolBtn = e.target.closest('.rbt-bg-pool-manage');
            if (poolBtn) {
                e.stopPropagation();
                const idx = parseInt(poolBtn.dataset.idx);
                _showBgPoolDialog(idx);
                return;
            }
            // 多素材配乐池管理按钮
            const bgmPoolBtn = e.target.closest('.rbt-bgm-pool-manage');
            if (bgmPoolBtn) {
                e.stopPropagation();
                const idx = parseInt(bgmPoolBtn.dataset.idx);
                _showBgmPoolDialog(idx);
                return;
            }
            const clipPickBtn = e.target.closest('.rbt-clip-pool-pick');
            if (clipPickBtn) {
                e.stopPropagation();
                const idx = parseInt(clipPickBtn.dataset.idx);
                _rbtPickClipPool(idx);
                return;
            }
            const clipConcatBtn = e.target.closest('.rbt-clip-concat-btn');
            if (clipConcatBtn) {
                e.stopPropagation();
                const idx = parseInt(clipConcatBtn.dataset.idx);
                _rbtConcatTaskClipPool(idx);
                return;
            }
            // 单字段清除按钮
            const clearBtn = e.target.closest('.rbt-field-clear');
            if (clearBtn) {
                e.stopPropagation();
                const idx = parseInt(clearBtn.dataset.idx);
                const field = clearBtn.dataset.field;
                const task = window._reelsState.tasks[idx];
                if (!task) return;
                switch (field) {
                    case 'cover_media':
                        if (task.cover) {
                            task.cover.enabled = false;
                            task.cover.bgPath = '';
                        }
                        break;
                    case 'hook':
                        task.hookFile = '';
                        task.hookTrimStart = null;
                        task.hookTrimEnd = null;
                        task.hookSpeed = 1;
                        task.hookTransition = 'none';
                        task.hookTransDuration = 0.5;
                        if (!task.hook) task.hook = {};
                        task.hook.enabled = false;
                        task.hook.path = '';
                        break;
                    case 'clipPool':
                        task.clipPoolDir = '';
                        task.clipPool = [];
                        task.concatVideoPath = '';
                        task.concatStatus = '';
                        break;
                    case 'bg': task.bgPath = ''; task.videoPath = ''; task.bgSrcUrl = ''; task.bgMode = 'single'; task.bgClipPool = []; task.bgClipActivePool = []; task.bgClipOrder = 'random'; task.bgTransition = 'crossfade'; task.bgTransDur = 0.5; break;
                    case 'bgClipSettings': task.bgClipSettings = {}; break;
                    case 'bgm': task.bgmPath = ''; task.bgmStart = 0; task.bgmMode = 'single'; task.bgmClipPool = []; task.bgmClipActivePool = []; task.bgmClipOrder = 'random'; break;
                    case 'contentvideo': task.contentVideoPath = ''; task.contentVideoTrimStart = null; task.contentVideoTrimEnd = null; task.contentVideoScale = 100; task.contentVideoX = 'center'; task.contentVideoY = 'center'; task.contentVideoCrop = ''; task.contentVideoBlurBg = false; task.contentVideoDirectBg = false; break;
                    case 'tts_text': task.ttsText = ''; break;
                    case 'pip': task.pipPath = ''; break;
                    case 'audio': task.audioPath = ''; break;
                    case 'srt': task.srtPath = ''; task.aligned = false; task.segments = []; break;
                    case 'txt': task.txtContent = ''; task.aligned = false; task.segments = []; break;
                    case 'ai_script': task.aiScript = ''; break;
                }
                _renderBatchTable();
                if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
                return;
            }
            // SRT Edit button
            const srtEditBtn = e.target.closest('.rbt-srt-edit-btn');
            if (srtEditBtn) {
                e.stopPropagation();
                const idx = parseInt(srtEditBtn.dataset.idx);
                _showSrtFileEditorModal(idx);
                return;
            }
            // TTS 生成按钮
            const ttsGenBtn = e.target.closest('.rbt-tts-gen-btn');
            if (ttsGenBtn) {
                e.stopPropagation();
                const idx = parseInt(ttsGenBtn.dataset.idx);
                _runSingleTTS(idx);
                return;
            }
            // 音频播放试听按钮
            const playBtn = e.target.closest('.rbt-table-play-btn');
            if (playBtn) {
                e.stopPropagation();
                const src = playBtn.dataset.src;
                if (!src) return;

                if (!window._rbtGlobalAudio) {
                    window._rbtGlobalAudio = new Audio();
                }

                const isPlayingThis = (playBtn.textContent === '⏸️');
                // 重置所有播放按钮图标
                document.querySelectorAll('.rbt-table-play-btn').forEach(btn => btn.textContent = '▶️');

                if (isPlayingThis) {
                    window._rbtGlobalAudio.pause();
                    window._rbtGlobalAudio.currentTime = 0;
                } else {
                    window._rbtGlobalAudio.src = _rbtMediaUrl(src);
                    window._rbtGlobalAudio.play().catch(err => console.error('Audio play failed:', err));
                    playBtn.textContent = '⏸️';
                    window._rbtGlobalAudio.onended = () => { playBtn.textContent = '▶️'; };
                    window._rbtGlobalAudio.onerror = () => { playBtn.textContent = '▶️'; alert('播放失败！文件可能不存在或路径不合法'); };
                }
                return;
            }
        });
        // 双击放大编辑 及 双击文件单元格
        tbody.addEventListener('dblclick', (e) => {
            if (e.target.tagName === 'TEXTAREA' && e.target.classList.contains('rbt-textarea')) {
                if (e.target.disabled && e.target.classList.contains('rbt-txtcontent-input')) {
                    const idx = parseInt(e.target.dataset.idx);
                    const task = window._reelsState.tasks[idx];
                    if (task && task.srtPath) {
                        _showSrtFileEditorModal(idx);
                        return;
                    }
                }
                _showTextEditorModal(e.target);
                return;
            }
            const hookSet = e.target.closest('.rbt-hook-set');
            if (hookSet) {
                const row = hookSet.closest('.rbt-row');
                if (row) {
                    _openHookModal(parseInt(row.dataset.idx));
                }
                return;
            }
            const coverSet = e.target.closest('.rbt-cover-set');
            if (coverSet) {
                const row = coverSet.closest('.rbt-row');
                if (row) {
                    _openCoverModal(parseInt(row.dataset.idx));
                }
                return;
            }
            // 双击文件单元格 → 选择文件
            const cell = e.target.closest('.rbt-droppable');
            if (cell && cell.dataset.field !== 'hook' && cell.dataset.field !== 'cover_media' && cell.dataset.field !== 'cover_text') {
                const row = cell.closest('.rbt-row');
                if (!row) return;
                const idx = parseInt(row.dataset.idx);
                const field = cell.dataset.field;
                _rbtPickSingleFile(idx, field);
                return;
            }
            // 双击配乐单元格 → 选择配乐文件
            const bgmPick = e.target.closest('.rbt-bgm-pick');
            if (bgmPick) {
                const idx = parseInt(bgmPick.dataset.idx);
                _batchTableState._bgmBatchMode = false;
                _batchTableState._bgmSingleIdx = idx;
                container.querySelector('#rbt-file-bgm').click();
                return;
            }

            // 双击音量滑块 → 恢复为全局默认 (删除自定义覆盖)
            if (e.target.classList.contains('rbt-bgm-vol') || e.target.classList.contains('rbt-bgvol-slider') || e.target.classList.contains('rbt-voicevol-slider')) {
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState.tasks[idx];
                if (task) {
                    if (e.target.classList.contains('rbt-bgm-vol')) {
                        delete task.bgmVolume;
                    } else if (e.target.classList.contains('rbt-bgvol-slider')) {
                        delete task.bgVideoVolume;
                    } else if (e.target.classList.contains('rbt-voicevol-slider')) {
                        delete task.voiceVolume;
                    }
                    _renderBatchTable();
                    if (idx === window._reelsState.selectedIdx) {
                        window.reelsSyncBackgroundTabUI(task);
                        if (typeof _applyPreviewAudioMix === 'function') _applyPreviewAudioMix();
                    }
                    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
                }
                return;
            }
        });
    }
}

async function _rbtPickNativeMediaFiles(field) {
    const isBackground = field === 'bg';
    if (!window.electronAPI?.selectFiles) {
        // 浏览器版仍使用原有输入控件；桌面版必须优先走原生选择器。
        _batchTableState.container?.querySelector(isBackground ? '#rbt-file-bg' : '#rbt-file-audio')?.click();
        return;
    }
    const filePaths = await window.electronAPI.selectFiles({
        title: isBackground ? '选择背景素材文件' : '选择人声音频文件',
        multiple: true,
        filters: isBackground
            ? [{ name: '视频和图片', extensions: ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp'] }]
            : [{ name: '音频和视频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm'] }],
    });
    if (!filePaths?.length) return;
    await _batchAssignFiles(filePaths.map(_rbtNativePathFile), field);
}

// ═══════════════════════════════════════════════════════
// 5.4 Multi-column Paste Modal
// ═══════════════════════════════════════════════════════
function _showMultiColumnPasteModal(tsvRows, startIdx, initialFieldCategory = null) {
    let wrap = document.getElementById('rbt-multicol-paste-modal');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'rbt-multicol-paste-modal';
        wrap.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.85);display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

        const content = document.createElement('div');
        content.style.cssText = 'width:90%;max-width:900px;background:#181818;border:1px solid var(--border-color);border-radius:12px;padding:24px;display:flex;flex-direction:column;gap:16px;box-shadow:0 12px 32px rgba(0,0,0,0.8);max-height:85vh;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;padding-bottom:12px;';
        header.innerHTML = '<h3 style="margin:0;color:var(--accent);font-size:18px;">📊 多列数据粘贴向导</h3>';
        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '✕';
        closeBtn.style.cssText = 'background:transparent;border:none;color:#aaa;font-size:20px;cursor:pointer;padding:4px;';
        closeBtn.onclick = () => { wrap.style.display = 'none'; };
        header.appendChild(closeBtn);

        const bodyContent = document.createElement('div');
        bodyContent.id = 'rbt-multicol-body';
        bodyContent.style.cssText = 'overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:8px;';

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;align-items:center;border-top:1px solid #333;padding-top:16px;margin-top:8px;';

        const hint = document.createElement('span');
        hint.id = 'rbt-multicol-hint';
        hint.style.cssText = 'color:#aaa;font-size:13px;flex:1;';

        const cancelBtn = document.createElement('button');
        cancelBtn.innerText = '取消';
        cancelBtn.style.cssText = 'padding:8px 20px;background:#333;color:#ccc;border:1px solid #444;border-radius:6px;cursor:pointer;font-size:14px;';
        cancelBtn.onclick = () => { wrap.style.display = 'none'; };

        const exeBtn = document.createElement('button');
        exeBtn.innerText = '✅ 确认导入';
        exeBtn.id = 'rbt-multicol-exec';
        exeBtn.style.cssText = 'padding:8px 24px;background:var(--accent);color:#000;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:bold;';

        footer.appendChild(hint);
        footer.appendChild(cancelBtn);
        footer.appendChild(exeBtn);

        content.appendChild(header);
        content.appendChild(bodyContent);
        content.appendChild(footer);
        wrap.appendChild(content);
        document.body.appendChild(wrap);
    }

    const FIELD_OPTS = [
        { v: '', l: '-- 不导入 (忽略) --' },
        { v: 'exportName', l: '📝 导出命名' },
        { v: 'cover_text', l: '🌟 封面文案' },
        { v: 'aiScript', l: '🧠 人声-原文案' },
        { v: 'ttsText', l: '🤖 人声-配音文案' },
        { v: 'ttsVoiceId', l: '🗣️ 人声-配音音色' },
        { v: 'txtContent', l: '📃 人声-断行文案' },
        { v: 'bgClipSettings', l: '🎞️ 背景池剪辑时间' },
        { v: 'overlay_title', l: '🔠 覆层标题' },
        { v: 'overlay_body', l: '🔠 覆层内容' },
        { v: 'overlay_footer', l: '🔠 覆层结尾' },
        { v: 'scroll_title', l: '⏫ 滚动标题' },
        { v: 'scroll_body', l: '⏫ 滚动内容' },
        { v: 'overlay_flipper_enabled', l: '⏱ 启用文字翻转' },
        { v: 'overlay_flipper_duration', l: '⏱ 翻转间隔时长(秒)' },
        { v: 'overlay_flipper_lines', l: '⏱ 翻转行数' },
        { v: 'overlay_flipper_effect', l: '⏱ 翻转效果(none/fade/slide)' },
        { v: 'overlay_flipper_loop', l: '⏱ 翻转循环(循环/不循环)' }
    ];

    let maxCols = Math.max(...tsvRows.map(r => r.length));
    while (maxCols > 1) {
        let hasData = false;
        for (let r = 0; r < tsvRows.length; r++) {
            if (tsvRows[r][maxCols - 1] && tsvRows[r][maxCols - 1].trim() !== '') {
                hasData = true; break;
            }
        }
        if (hasData) break;
        maxCols--;
    }

    const validRowsCount = tsvRows.filter(r => r.some(c => c && c.trim().length > 0)).length;
    document.getElementById('rbt-multicol-hint').innerText = `已检测到 ${maxCols} 列，共包含 ${validRowsCount} 行有效数据。`;

    const bodyStr = [];
    bodyStr.push(`<div style="display:grid;grid-template-columns:80px 180px 1fr;gap:12px;font-weight:bold;color:#888;padding-bottom:8px;border-bottom:1px solid #333;">
        <div>来源列</div>
        <div>目标列选择</div>
        <div>预览该列前3行数据</div>
    </div>`);

    for (let c = 0; c < maxCols; c++) {
        const previewItems = [];
        for (let r = 0; r < Math.min(3, tsvRows.length); r++) {
            const cell = (tsvRows[r][c] || '').trim();
            if (cell) previewItems.push(cell.length > 40 ? _escHtml(cell.substring(0, 40)) + '...' : _escHtml(cell));
        }
        let previewStr = previewItems.join('<br/><span style="color:#555;">---</span><br/>');
        if (!previewStr) previewStr = '<i style="color:#666">（空数据）</i>';

        let selectHtml = `<select class="rbt-multicol-select" data-col="${c}" style="width:100%;padding:8px;background:#222;color:#eee;border:1px solid #444;border-radius:4px;outline:none;font-size:13px;">`;
        for (const opt of FIELD_OPTS) {
            let selected = '';
            if (c === 0 && opt.v === initialFieldCategory) selected = 'selected';
            selectHtml += `<option value="${opt.v}" ${selected}>${opt.l}</option>`;
        }
        selectHtml += `</select>`;

        bodyStr.push(`<div style="display:grid;grid-template-columns:80px 180px 1fr;gap:12px;align-items:start;background:#1e1e1e;padding:12px;border-radius:6px;">
            <div style="font-size:16px;color:#ccc;font-weight:bold;padding-top:6px;">列 ${c + 1}</div>
            <div>${selectHtml}</div>
            <div style="font-size:12px;color:#999;line-height:1.4;background:#111;padding:8px;border-radius:4px;max-height:80px;overflow:hidden;text-overflow:ellipsis;">${previewStr}</div>
        </div>`);
    }

    document.getElementById('rbt-multicol-body').innerHTML = bodyStr.join('');

    const exeBtn = document.getElementById('rbt-multicol-exec');
    exeBtn.onclick = () => {
        const selects = document.querySelectorAll('.rbt-multicol-select');
        const mapping = [];
        selects.forEach(s => mapping.push(s.value));

        _execMultiColumnPaste(tsvRows, startIdx, mapping, maxCols);
        wrap.style.display = 'none';
    };

    wrap.style.display = 'flex';
}

function _execMultiColumnPaste(tsvRows, startIdx, colMappings, maxCols) {
    const state = window._reelsState;
    const container = _batchTableState.container;
    if (!state || !container) return;

    const validRows = tsvRows.filter(r => {
        for (let i = 0; i < maxCols; i++) {
            if (r[i] && r[i].trim().length > 0) return true;
        }
        return false;
    });
    if (validRows.length === 0) return;

    let overflown = validRows.length - (state.tasks.length - startIdx);
    if (overflown > 0) {
        if (!confirm(`剪贴板包含 ${validRows.length} 行数据，当前表格剩余空间不足。\n是否自动创建 ${overflown} 行新任务并继续向下填充？`)) {
            overflown = 0; // proceed with what fits
        } else {
            for (let i = 0; i < overflown; i++) {
                const taskName = _generateUniqueCardName(state.tasks, 'card');
                const newTask = {
                    baseName: taskName,
                    fileName: `${taskName}.mp4`,
                    bgPath: null, bgSrcUrl: null,
                    audioPath: null, srtPath: null,
                    segments: [],
                    videoPath: null, srcUrl: null,
                    overlays: [],
                    aligned: false,
                    bgScale: 100, bgDurScale: 100, audioDurScale: 100
                };
                state.tasks.push(newTask);
            }
        }
    }

    let filled = 0;
    for (let rIdx = 0; rIdx < validRows.length; rIdx++) {
        const rowData = validRows[rIdx];
        const taskIdx = startIdx + rIdx;
        if (taskIdx >= state.tasks.length) break;

        const task = state.tasks[taskIdx];
        let rowModified = false;

        for (let cIdx = 0; cIdx < maxCols; cIdx++) {
            const fieldCategory = colMappings[cIdx];
            if (!fieldCategory) continue;

            let str = (rowData[cIdx] || '').trim();

            if (fieldCategory === 'aiScript') task.aiScript = str;
            else if (fieldCategory === 'ttsText') task.ttsText = str;
            else if (fieldCategory === 'txtContent') { task.txtContent = str; task.aligned = false; }
            else if (fieldCategory === 'ttsVoiceId') task.ttsVoiceId = str;
            else if (fieldCategory === 'exportName') task.exportName = str;
            else if (fieldCategory === 'bgClipSettings') {
                if (!task.bgClipSettings) task.bgClipSettings = {};
                const parsed = _parseClipSettingsString(str);
                const pool = task.bgClipPool || [];
                for (let j = 0; j < pool.length && j < parsed.length; j++) {
                    const path = pool[j];
                    task.bgClipSettings[path] = {
                        trimStart: parsed[j].trimStart,
                        trimEnd: parsed[j].trimEnd
                    };
                }
            }
            else if (fieldCategory === 'cover_text') {
                if (!task.cover) task.cover = { enabled: true, overlays: [] };
                if (task.cover.overlays && task.cover.overlays.length > 0) task.cover.overlays[0].title_text = str;
                else task.cover.overlays = [{ title_text: str, body_text: '', footer_text: '', type: 'textcard' }];
            }
            else if (fieldCategory.startsWith('overlay_') || fieldCategory.startsWith('scroll_')) {
                _applyOverlayField(task, fieldCategory, str);
            }
            rowModified = true;
        }
        if (rowModified) filled++;
    }


    const scrollWrap = container.querySelector('.rbt-table-wrap');
    const scrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
    const scrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;

    _skipNextApply = true; // 粘贴已直接写入 state，跳过 DOM→state 同步
    _renderBatchTable();

    const newScrollWrap = container.querySelector('.rbt-table-wrap');
    if (newScrollWrap) {
        newScrollWrap.scrollTop = scrollTop;
        newScrollWrap.scrollLeft = scrollLeft;
    }

    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();

    if (typeof showToast === 'function') {
        showToast(`✅ 多列粘贴成功：影响了 ${filled} 行。`, 'success');
    }
}

// ═══════════════════════════════════════════════════════
// 5.5 Text Editor Modal
// ═══════════════════════════════════════════════════════

async function _showSrtFileEditorModal(idx) {
    const task = window._reelsState.tasks[idx];
    if (!task || !task.srtPath) return;

    if (!window.electronAPI || !window.electronAPI.readFileText || !window.electronAPI.writeFileText) {
        alert('无法读写本地文件，当前环境不支持。');
        return;
    }

    let srtContent = '';
    try {
        srtContent = await window.electronAPI.readFileText(task.srtPath);
    } catch (e) {
        alert('读取 SRT 文件失败:\n' + e.message);
        return;
    }

    let editorWrap = document.getElementById('rbt-srt-editor-modal');
    if (!editorWrap) {
        editorWrap = document.createElement('div');
        editorWrap.id = 'rbt-srt-editor-modal';
        editorWrap.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

        const modalContent = document.createElement('div');
        modalContent.style.cssText = 'width:80%;max-width:800px;background:#181818;border:1px solid var(--border-color);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:16px;box-shadow:0 12px 32px rgba(0,0,0,0.8);';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';

        const title = document.createElement('h3');
        title.id = 'rbt-srt-editor-title';
        title.style.cssText = 'margin:0;color:#ff9800;font-size:16px;display:flex;align-items:center;gap:8px;';

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '✕';
        closeBtn.style.cssText = 'background:transparent;border:none;color:#aaa;font-size:18px;cursor:pointer;padding:4px;';
        closeBtn.onclick = () => { editorWrap.remove(); };

        header.appendChild(title);
        header.appendChild(closeBtn);

        const ta = document.createElement('textarea');
        ta.id = 'rbt-srt-editor-textarea';
        ta.style.cssText = 'width:100%;height:450px;background:#111;color:#eee;border:1px solid #333;border-radius:6px;padding:12px;font-size:14px;line-height:1.6;box-sizing:border-box;font-family:monospace;resize:vertical;';

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;align-items:center;';

        const hint = document.createElement('span');
        hint.style.cssText = 'color:#666;font-size:12px;flex:1;';
        hint.innerText = '小提示：直接修改文字即可。请不要破坏原有的时间轴格式。按 Esc 键退出，Ctrl+Enter 保存。';

        const cancelBtn = document.createElement('button');
        cancelBtn.innerText = '取消 (Esc)';
        cancelBtn.style.cssText = 'padding:8px 20px;background:#333;color:#ccc;border:1px solid #444;border-radius:6px;cursor:pointer;font-size:13px;';
        cancelBtn.onclick = () => { editorWrap.remove(); };

        const saveBtn = document.createElement('button');
        saveBtn.innerText = '保存到源文件 (Ctrl+Enter)';
        saveBtn.id = 'rbt-srt-editor-save';
        saveBtn.style.cssText = 'padding:8px 24px;background:#ff9800;color:#000;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:bold;';

        footer.appendChild(hint);
        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);

        modalContent.appendChild(header);
        modalContent.appendChild(ta);
        modalContent.appendChild(footer);
        editorWrap.appendChild(modalContent);
        document.body.appendChild(editorWrap);

        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                editorWrap.remove();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                saveBtn.click();
            }
        });

        modalContent.addEventListener('click', (e) => e.stopPropagation());
        editorWrap.addEventListener('click', () => { editorWrap.remove(); });
    } else {
        editorWrap.style.display = 'flex';
    }

    document.getElementById('rbt-srt-editor-title').innerHTML = `📝 修改外部 SRT 字幕 <span style="font-size:11px;color:#aaa;font-weight:400;margin-left:8px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${task.srtPath}</span>`;
    const textarea = document.getElementById('rbt-srt-editor-textarea');
    textarea.value = srtContent;

    document.getElementById('rbt-srt-editor-save').onclick = async () => {
        const newText = textarea.value;
        try {
            await window.electronAPI.writeFileText(task.srtPath, newText);
            editorWrap.remove();

            // Show a tiny success toast
            const toast = document.createElement('div');
            toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2e7d32;color:#fff;padding:8px 16px;border-radius:20px;box-shadow:0 4px 12px rgba(0,0,0,0.5);z-index:999999;font-size:13px;font-weight:bold;animation:rbt-fade-in-out 2s forwards;';
            toast.innerText = '✅ SRT 原文件已保存';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2500);

            _renderBatchTable();
        } catch (e) {
            alert('保存修改失败:\n' + e.message);
        }
    };
}

function _showTextEditorModal(textareaEl) {
    let editorWrap = document.getElementById('rbt-text-editor-modal');
    if (!editorWrap) {
        editorWrap = document.createElement('div');
        editorWrap.id = 'rbt-text-editor-modal';
        editorWrap.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.85);display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

        const modalContent = document.createElement('div');
        modalContent.style.cssText = 'width:80%;max-width:800px;background:#181818;border:1px solid var(--border-color);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:16px;box-shadow:0 12px 32px rgba(0,0,0,0.8);';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';

        const title = document.createElement('h3');
        title.id = 'rbt-text-editor-title';
        title.style.cssText = 'margin:0;color:var(--accent);font-size:16px;';
        title.innerText = '大屏幕文案编辑';

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '✕';
        closeBtn.style.cssText = 'background:transparent;border:none;color:#aaa;font-size:18px;cursor:pointer;padding:4px;';
        closeBtn.onclick = () => { editorWrap.style.display = 'none'; };

        header.appendChild(title);
        header.appendChild(closeBtn);

        const ta = document.createElement('textarea');
        ta.id = 'rbt-text-editor-textarea';
        ta.style.cssText = 'width:100%;height:450px;background:#111;color:#eee;border:1px solid #333;border-radius:6px;padding:12px;font-size:14px;line-height:1.6;box-sizing:border-box;font-family:monospace;resize:vertical;';

        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;align-items:center;';

        const hint = document.createElement('span');
        hint.style.cssText = 'color:#666;font-size:12px;flex:1;';
        hint.innerText = '小提示：按 Esc 键可退出，Ctrl+Enter 可快速保存';

        const cancelBtn = document.createElement('button');
        cancelBtn.innerText = '取消 (Esc)';
        cancelBtn.style.cssText = 'padding:8px 20px;background:#333;color:#ccc;border:1px solid #444;border-radius:6px;cursor:pointer;font-size:13px;';
        cancelBtn.onclick = () => { editorWrap.style.display = 'none'; };

        const saveBtn = document.createElement('button');
        saveBtn.innerText = '保存内容 (Ctrl+Enter)';
        saveBtn.id = 'rbt-text-editor-save';
        saveBtn.style.cssText = 'padding:8px 24px;background:var(--accent);color:#000;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:bold;';

        footer.appendChild(hint);
        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);

        modalContent.appendChild(header);
        modalContent.appendChild(ta);
        modalContent.appendChild(footer);
        editorWrap.appendChild(modalContent);
        document.body.appendChild(editorWrap);

        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                editorWrap.style.display = 'none';
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                saveBtn.click();
            }
        });

        // Block clicks from closing modal if clicking inside model content
        modalContent.addEventListener('click', (e) => e.stopPropagation());
        // Close modal if clicking outside
        editorWrap.addEventListener('click', () => { editorWrap.style.display = 'none'; });
    }

    const modalTitle = document.getElementById('rbt-text-editor-title');
    const modalTa = document.getElementById('rbt-text-editor-textarea');
    const saveBtn = document.getElementById('rbt-text-editor-save');

    let titleStr = "大屏幕文案编辑";
    if (textareaEl.classList.contains('rbt-txtcontent-input')) titleStr = "编辑【人声-断行文案】";
    else if (textareaEl.classList.contains('rbt-title-input')) titleStr = "编辑【覆层标题】";
    else if (textareaEl.classList.contains('rbt-body-input')) titleStr = "编辑【覆层内容】";
    else if (textareaEl.classList.contains('rbt-footer-input')) titleStr = "编辑【覆层结尾】";
    else if (textareaEl.classList.contains('rbt-scroll-title-input')) titleStr = "编辑【滚动标题】";
    else if (textareaEl.classList.contains('rbt-scroll-body-input')) titleStr = "编辑【滚动内容】";
    else if (textareaEl.classList.contains('rbt-ai-script-input')) titleStr = "编辑【人声-原文案】";
    modalTitle.innerText = titleStr;

    modalTa.value = textareaEl.value;
    editorWrap.style.display = 'flex';
    modalTa.focus();
    // highlight text gently
    modalTa.setSelectionRange(modalTa.value.length, modalTa.value.length);

    saveBtn.onclick = () => {
        textareaEl.value = modalTa.value;
        // manually dispatch events so batch system picks it up immediately
        textareaEl.dispatchEvent(new Event('input', { bubbles: true }));
        textareaEl.dispatchEvent(new Event('change', { bubbles: true }));
        editorWrap.style.display = 'none';
    };
}

function _showDiffModal(origText, newText, field, taskIdx) {
    let wrap = document.getElementById('rbt-diff-modal');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'rbt-diff-modal';
        wrap.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:99999;display:flex;justify-content:center;align-items:center;';
        document.body.appendChild(wrap);
    }
    wrap.innerHTML = '';

    // Simple block tokenization
    const tokenize = str => str.split(/([a-zA-Z]+|[\u4e00-\u9fa5]|\s+|\[.*?\]|<.*?>)/).filter(Boolean);
    const a = tokenize(origText || '');
    const b = tokenize(newText || '');

    // To prevent JS out of memory or stack error for giant blocks
    let diffTokens = [];
    if (a.length > 3000 || b.length > 3000) {
        diffTokens = [{ val: '\n⚠️ 文本太长，无法进行高亮对比。请直接肉眼比对以下结果：\n\n【当前文本】\n' + newText + '\n\n【人声-原文案】\n' + origText, type: 'del' }];
    } else {
        const m = a.length, n = b.length;
        const dp = Array(m + 1);
        for (let i = 0; i <= m; i++) dp[i] = new Int32Array(n + 1);

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (a[i - 1].toLowerCase() === b[j - 1].toLowerCase()) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        let i = m, j = n;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && a[i - 1].toLowerCase() === b[j - 1].toLowerCase()) {
                diffTokens.unshift({ val: b[j - 1], type: 'eq' });
                i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                diffTokens.unshift({ val: b[j - 1], type: 'add' });
                j--;
            } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
                diffTokens.unshift({ val: a[i - 1], type: 'del' });
                i--;
            }
        }
    }

    // Initialize interaction state
    diffTokens.forEach(t => {
        if (t.type === 'eq') {
            t.inResult = true;
        } else if (t.type === 'add') {
            // If the user manually added a tag or formatting, WE MUST PRESERVE IT default.
            t.inResult = true;

        } else if (t.type === 'del') {
            // AI deleted this from original text.
            // Punctuation, spaces, and tags from the original MUST be preserved automatically!
            if (/^[^a-zA-Z0-9\u4e00-\u9fa5]+$/.test(t.val)) {
                t.inResult = true;
            } else {
                t.inResult = false; // Real deleted words default to dropped, must click to restore.
            }
        }
    });

    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;line-height:1.6;font-size:15px;white-space:pre-wrap;font-family:monospace;padding:12px;background:#111;border-radius:6px;border:1px solid #333;';

    function renderDiff() {
        let html = '';
        diffTokens.forEach((t, i) => {
            if (t.type === 'eq') {
                html += _escHtml(t.val);
            } else if (t.type === 'add') {
                if (/^\[.*?\]$|^<.*?>$/.test(t.val)) {
                    html += `<span style="color:#aaa;" title="已保留您手动添加的标签">${_escHtml(t.val)}</span>`;
                } else if (/(^\s+$)/.test(t.val)) {
                    html += t.val;
                } else if (/^[^a-zA-Z0-9\u4e00-\u9fa5]+$/.test(t.val)) {
                    html += `<span style="color:#aaa;" title="已保留您手动修改的标点">${_escHtml(t.val)}</span>`;
                } else {
                    if (t.inResult) {
                        html += `<span class="rbt-diff-tok" data-idx="${i}" style="cursor:pointer;background:rgba(74,222,128,0.3);color:#4ade80;text-decoration:underline;" title="点击抛弃该词 (恢复原文)">${_escHtml(t.val)}</span>`;
                    } else {
                        html += `<span class="rbt-diff-tok" data-idx="${i}" style="cursor:pointer;background:rgba(0,0,0,0.5);color:#555;text-decoration:line-through;" title="重新选中此词">${_escHtml(t.val)}</span>`;
                    }
                }
            } else if (t.type === 'del') {
                if (/^\[.*?\]$|^<.*?>$/.test(t.val)) {
                    html += `<span style="color:#aaa;" title="已自动保留该原文标签">${_escHtml(t.val)}</span>`;
                } else if (/(^\s+$)/.test(t.val)) {
                    html += t.val;
                } else if (/^[^a-zA-Z0-9\u4e00-\u9fa5]+$/.test(t.val)) {
                    html += `<span style="color:#aaa;">${_escHtml(t.val)}</span>`;
                } else {
                    if (!t.inResult) {
                        html += `<span class="rbt-diff-tok" data-idx="${i}" style="cursor:pointer;background:rgba(239,68,68,0.3);color:#ef4444;text-decoration:line-through;" title="点击恢复此词">${_escHtml(t.val)}</span>`;
                    } else {
                        html += `<span class="rbt-diff-tok" data-idx="${i}" style="cursor:pointer;background:rgba(234,179,8,0.3);color:#eab308;border-bottom:2px solid #eab308;" title="取消恢复">${_escHtml(t.val)}</span>`;
                    }
                }
            }
        });
        body.innerHTML = html.replace(/\n/g, '<br/>');
    }

    body.addEventListener('click', e => {
        const span = e.target.closest('.rbt-diff-tok');
        if (span) {
            const idx = parseInt(span.dataset.idx);
            const t = diffTokens[idx];
            t.inResult = !t.inResult;
            // auto-restore surrounding whitespace if restoring a deleted word
            if (t.inResult && t.type === 'del') {
                if (idx > 0 && /(^\s+$)/.test(diffTokens[idx - 1].val) && diffTokens[idx - 1].type === 'del') {
                    diffTokens[idx - 1].inResult = true;
                }
                if (idx < diffTokens.length - 1 && /(^\s+$)/.test(diffTokens[idx + 1].val) && diffTokens[idx + 1].type === 'del') {
                    diffTokens[idx + 1].inResult = true;
                }
            }
            // auto-reject surrounding whitespace if rejecting an added word
            if (!t.inResult && t.type === 'add') {
                if (idx > 0 && /(^\s+$)/.test(diffTokens[idx - 1].val) && diffTokens[idx - 1].type === 'add') {
                    diffTokens[idx - 1].inResult = false;
                }
                if (idx < diffTokens.length - 1 && /(^\s+$)/.test(diffTokens[idx + 1].val) && diffTokens[idx + 1].type === 'add') {
                    diffTokens[idx + 1].inResult = false;
                }
            }
            renderDiff();
        }
    });

    renderDiff();

    const modalContent = document.createElement('div');
    modalContent.style.cssText = 'width:80%;max-width:800px;background:#181818;border:1px solid var(--border-color);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:16px;box-shadow:0 12px 32px rgba(0,0,0,0.8);color:#eee;max-height:80vh;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;padding-bottom:10px;';
    header.innerHTML = `<h3 style="margin:0;color:#ffb74d;">🔍 原文比对 (文本篡改高亮)</h3>
                        <button id="rbt-diff-close" style="background:transparent;border:none;color:#aaa;font-size:18px;cursor:pointer;">✕</button>`;

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:#888;display:flex;gap:16px;align-items:center;';
    hint.innerHTML = `
        <span><span style="color:#4ade80;text-decoration:underline;">绿色下划线</span> = 当前多出来的词 (或改错的词)</span>
        <span><span style="color:#ef4444;text-decoration:line-through;">红色删除线</span> = 被悄悄删掉的词 (原文)</span>
        <span style="margin-left:auto;color:#3b82f6;font-weight:bold;">💡 互动提示：直接点击高亮的词即可一键恢复或剔除！</span>
    `;

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;margin-top:10px;';
    footer.innerHTML = `
        <button id="rbt-diff-restore" style="padding:10px 24px;background:#374151;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">🔄 强制还原为原文</button>
        <button id="rbt-diff-apply" style="padding:10px 24px;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;box-shadow:0 4px 12px rgba(59,130,246,0.4);">✅ 应用并覆盖到表格</button>
    `;

    modalContent.appendChild(header);
    modalContent.appendChild(hint);
    modalContent.appendChild(body);
    modalContent.appendChild(footer);
    wrap.appendChild(modalContent);

    wrap.style.display = 'flex';

    wrap.querySelector('#rbt-diff-close').onclick = () => wrap.style.display = 'none';

    wrap.querySelector('#rbt-diff-restore').onclick = () => {
        const task = window._reelsState.tasks[taskIdx];
        if (!task || !task.aiScript) return;
        const finalText = task.aiScript;
        if (field === 'txt') {
            task.txtContent = finalText;
            const tr = document.querySelector(`tr.rbt-row[data-idx="${taskIdx}"]`);
            if (tr) {
                const ta = tr.querySelector('.rbt-txtcontent-input');
                if (ta) {
                    ta.value = finalText;
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                    ta.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        } else if (field === 'tts') {
            task.ttsText = finalText;
            const tr = document.querySelector(`tr.rbt-row[data-idx="${taskIdx}"]`);
            if (tr) {
                const ta = tr.querySelector('.rbt-tts-text-input');
                if (ta) {
                    ta.value = finalText;
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                    ta.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }
        wrap.style.display = 'none';

        // Full reset of table row to ensure absolutely zero weird state bugs
        if (typeof _renderBatchTable === 'function') setTimeout(_renderBatchTable, 50);
    };

    wrap.querySelector('#rbt-diff-apply').onclick = () => {
        const finalText = diffTokens.filter(t => t.inResult).map(t => t.val).join('');
        const task = window._reelsState.tasks[taskIdx];
        if (field === 'txt' && task) {
            task.txtContent = finalText;
            const tr = document.querySelector(`tr.rbt-row[data-idx="${taskIdx}"]`);
            if (tr) {
                const ta = tr.querySelector('.rbt-txtcontent-input');
                if (ta) {
                    ta.value = finalText;
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                    ta.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        } else if (field === 'tts' && task) {
            task.ttsText = finalText;
            const tr = document.querySelector(`tr.rbt-row[data-idx="${taskIdx}"]`);
            if (tr) {
                const ta = tr.querySelector('.rbt-tts-text-input');
                if (ta) {
                    ta.value = finalText;
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                    ta.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }
        wrap.style.display = 'none';

        if (typeof _renderBatchTable === 'function') setTimeout(_renderBatchTable, 50);
    };

    wrap.onclick = (e) => { if (e.target === wrap) wrap.style.display = 'none'; };
}

// ═══════════════════════════════════════════════════════
// 6. Apply changes from table → tasks
// ═══════════════════════════════════════════════════════

function _applyBatchTableChanges(stateOverride = null, options = {}) {
    const container = _batchTableState.container;
    if (!container) return;
    const state = stateOverride || window._reelsState;
    if (!state) return;
    const renderTaskList = options.renderTaskList !== false;

    const titleInputs = container.querySelectorAll('.rbt-title-input');
    const bodyInputs = container.querySelectorAll('.rbt-body-input');
    const footerInputs = container.querySelectorAll('.rbt-footer-input');
    const cardTplSelects = container.querySelectorAll('.rbt-card-tpl-select');
    const flipperEnabledInputs = container.querySelectorAll('.rbt-flipper-enabled-input');
    const flipperDurationInputs = container.querySelectorAll('.rbt-flipper-duration-input');
    const flipperLinesInputs = container.querySelectorAll('.rbt-flipper-lines-input');
    const flipperEffectInputs = container.querySelectorAll('.rbt-flipper-effect-input');
    const flipperLoopInputs = container.querySelectorAll('.rbt-flipper-loop-input');
    const flipperTransitionDurationInputs = container.querySelectorAll('.rbt-flipper-transition-duration-input');

    titleInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (el.value.trim() === '' && !_findBatchOverlayByIdOrIdx(task, el.dataset.cardId, null, el.dataset.cardIdx, 'textcard')) return;
        _applyOverlayFieldWithTarget(task, 'overlay_title', el.value, el.dataset.cardId, el.dataset.cardIdx, 'textcard');
    });

    flipperEnabledInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (!_findBatchOverlayByIdOrIdx(task, el.dataset.cardId, null, el.dataset.cardIdx, 'textcard')) return;
        _applyOverlayFieldWithTarget(task, 'overlay_flipper_enabled', el.value, el.dataset.cardId, el.dataset.cardIdx, 'textcard');
    });

    flipperDurationInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (!_findBatchOverlayByIdOrIdx(task, el.dataset.cardId, null, el.dataset.cardIdx, 'textcard')) return;
        _applyOverlayFieldWithTarget(task, 'overlay_flipper_duration', el.value, el.dataset.cardId, el.dataset.cardIdx, 'textcard');
    });

    flipperLinesInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (!_findBatchOverlayByIdOrIdx(task, el.dataset.cardId, null, el.dataset.cardIdx, 'textcard')) return;
        _applyOverlayFieldWithTarget(task, 'overlay_flipper_lines', el.value, el.dataset.cardId, el.dataset.cardIdx, 'textcard');
    });

    flipperEffectInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (!_findBatchOverlayByIdOrIdx(task, el.dataset.cardId, null, el.dataset.cardIdx, 'textcard')) return;
        _applyOverlayFieldWithTarget(task, 'overlay_flipper_effect', el.value, el.dataset.cardId, el.dataset.cardIdx, 'textcard');
    });

    flipperLoopInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (!_findBatchOverlayByIdOrIdx(task, el.dataset.cardId, null, el.dataset.cardIdx, 'textcard')) return;
        _applyOverlayFieldWithTarget(task, 'overlay_flipper_loop', el.value, el.dataset.cardId, el.dataset.cardIdx, 'textcard');
    });

    flipperTransitionDurationInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (!_findBatchOverlayByIdOrIdx(task, el.dataset.cardId, null, el.dataset.cardIdx, 'textcard')) return;
        _applyOverlayFieldWithTarget(task, 'overlay_flipper_transition_duration', el.value, el.dataset.cardId, el.dataset.cardIdx, 'textcard');
    });

    bodyInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (el.value.trim() === '' && !_findBatchOverlayByIdOrIdx(task, el.dataset.cardId, null, el.dataset.cardIdx, 'textcard')) return;
        _applyOverlayFieldWithTarget(task, 'overlay_body', el.value, el.dataset.cardId, el.dataset.cardIdx, 'textcard');
    });

    footerInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (el.value.trim() === '' && !_findBatchOverlayByIdOrIdx(task, el.dataset.cardId, null, el.dataset.cardIdx, 'textcard')) return;
        _applyOverlayFieldWithTarget(task, 'overlay_footer', el.value, el.dataset.cardId, el.dataset.cardIdx, 'textcard');
    });

    // ── 滚动字幕列 ──
    const scrollTitleInputs = container.querySelectorAll('.rbt-scroll-title-input');
    const scrollBodyInputs = container.querySelectorAll('.rbt-scroll-body-input');

    scrollTitleInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (el.value.trim() === '' && !_findBatchOverlayByIdOrIdx(task, el.dataset.scrollId, null, el.dataset.scrollIdx, 'scroll')) return;
        _applyOverlayFieldWithTarget(task, 'scroll_title', el.value, el.dataset.scrollId, el.dataset.scrollIdx, 'scroll');
    });

    scrollBodyInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (el.value.trim() === '' && !_findBatchOverlayByIdOrIdx(task, el.dataset.scrollId, null, el.dataset.scrollIdx, 'scroll')) return;
        _applyOverlayFieldWithTarget(task, 'scroll_body', el.value, el.dataset.scrollId, el.dataset.scrollIdx, 'scroll');
    });

    // ── 封面卡片文案 ──
    const coverTextInputs = container.querySelectorAll('.rbt-cover-text-input');
    coverTextInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (!task.cover) return; // 只当封面启用或创建时绑定

        const overlays = task.cover.overlays || [];
        if (overlays.length > 0) {
            overlays[0].title_text = el.value;
        } else if (el.value.trim() !== '') {
            const textOvl = window.ReelsOverlay ? window.ReelsOverlay.createTextCardOverlay({ start: 0, end: 9999 }) : { title_text: el.value, body_text: '', footer_text: '', type: 'textcard' };
            textOvl.title_text = el.value;
            task.cover.overlays = [textOvl];
        }
    });


    // 自定义时长
    const durInputs = container.querySelectorAll('.rbt-dur-input');
    durInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        const v = parseFloat(el.value) || 0;
        task.customDuration = v > 0 ? v : 0;
    });

    // 导出命名
    container.querySelectorAll('.rbt-exportname-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        task.exportName = el.value.trim();
    });

    // 背景缩放
    container.querySelectorAll('.rbt-bgscale-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        task.bgScale = parseInt(el.value) || 100;
    });

    // 背景时长缩放
    container.querySelectorAll('.rbt-bgdurscale-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        task.bgDurScale = parseInt(el.value) || 100;
    });

    // 人声-音频变速
    container.querySelectorAll('.rbt-audiodurscale-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        task.audioDurScale = parseInt(el.value) || 100;
    });

    // TTS 文案
    container.querySelectorAll('.rbt-tts-text-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (task) task.ttsText = el.value;
    });

    // TTS 音色 ID
    container.querySelectorAll('.rbt-tts-voice-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (task) task.ttsVoiceId = el.value;
    });

    // 人声-原文案
    container.querySelectorAll('.rbt-ai-script-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (task) task.aiScript = el.value;
    });

    // 人声-断行文案（用于字幕对齐）
    const txtContentInputs = container.querySelectorAll('.rbt-txtcontent-input');
    txtContentInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        const newContent = el.value.trim();
        if (newContent !== (task.txtContent || '').trim()) {
            task.txtContent = newContent;
            task.aligned = false; // 内容变了重置对齐状态
        }
    });

    // 覆盖层组预设 
    // 字幕模板已通过 _openStyledPresetPicker 实时更新到了 task._subtitlePreset

    // 覆盖层组预设
    // 注意：只记录选择值，不在此处重新应用预设——
    // 重新应用会用预设默认文案覆盖用户已编辑的滚动字幕内容。
    // 预设的实际应用仅通过用户主动点击「应用」按钮或下拉框 change 事件触发。
    cardTplSelects.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        const presetName = el.value;
        if (!presetName && task._overlayPresetName) {
            task._overlayPresetName = '';
        }
        // 仅同步选中状态，不重新 apply 预设（保护用户文案）
    });

    // 配乐音量
    const bgmVols = container.querySelectorAll('.rbt-bgm-vol');
    bgmVols.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        task.bgmVolume = parseInt(el.value) || 0;
    });
    container.querySelectorAll('.rbt-bgm-start').forEach(el => {
        const task = state.tasks[parseInt(el.dataset.idx)];
        if (task) task.bgmStart = Math.max(0, parseFloat(el.value) || 0);
    });

    // 背景视频音量
    const bgVols = container.querySelectorAll('.rbt-bgvol-slider');
    bgVols.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (el.dataset.isNull === 'true') {
            delete task.bgVideoVolume;
        } else {
            task.bgVideoVolume = parseInt(el.value);
        }
    });

    // 片段池排序
    container.querySelectorAll('.rbt-clip-order').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (task) task.clipOrder = el.value || 'name';
    });

    // 人声-音频音量
    const voiceVols = container.querySelectorAll('.rbt-voicevol-slider');
    voiceVols.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (el.dataset.isNull === 'true') {
            delete task.voiceVolume;
        } else {
            task.voiceVolume = parseInt(el.value);
        }
    });

    // 刷新任务列表
    if (typeof _renderTaskList === 'function') _renderTaskList();

    // 同步当前选中任务的覆层到 overlayMgr
    const selIdx = state.selectedIdx;
    const selTask = state.tasks[selIdx];
    if (selTask && state.overlayProxy && state.overlayProxy.overlayMgr) {
        _syncSelectedTaskOverlayMgrIfNeeded(selIdx);
    }
}

// ═══════════════════════════════════════════════════════
// 7. Paste from Google Sheets
// ═══════════════════════════════════════════════════════

async function _batchPasteFromSheet(targetId = null, targetIdx = null) {
    // ── 第一步：让用户选模式 ──
    const mode = await _showPasteModeDialog();
    if (!mode) return;

    // ── 第二步：获取文本 ──
    let raw = '';
    try {
        raw = await navigator.clipboard.readText();
    } catch (e) {
        raw = await _showPasteDialog();
    }
    if (!raw || !raw.trim()) return;

    const rows = _parseBatchTSV(raw);
    if (!rows.length) {
        alert('未检测到有效数据');
        return;
    }

    const isSingleColumn = rows.every(r => r.length === 1);
    let splitMode = 0;
    if (isSingleColumn) {
        const modeStr = await _showSplitPromptDialog('检测到您粘贴的内容只有一列。\\n如果这列内容内部自带多行文本，你可以选用以下格式快速智能拆分：', true);
        if (modeStr === '1') splitMode = 1;
        else if (modeStr === '2') splitMode = 2;
        else if (modeStr === '3') splitMode = 3;
        else if (modeStr === '4') splitMode = 4;
        else if (modeStr === '5') splitMode = 5;
    }

    const state = window._reelsState;
    const ReelsOverlay = window.ReelsOverlay;
    if (!state || !ReelsOverlay) return;

    if (splitMode > 0) {
        let hasErrors = true;
        while (hasErrors) {
            let badRows = [];
            for (let i = 0; i < rows.length; i++) {
                const rowText = rows[i][0] || '';
                const lines = rowText.split('\n').map(l => l.trim()).filter(l => l);
                if (lines.length > 0 && ((splitMode === 2 && lines.length < 2) || (splitMode === 3 && lines.length < 3))) {
                    badRows.push({ index: i, text: rowText });
                }
            }
            if (badRows.length === 0) {
                hasErrors = false;
                break;
            }
            const newTexts = await _showBatchEditDialog(badRows, splitMode, rows.length);
            if (!newTexts) return;
            for (const ans of newTexts) {
                if (ans.skip) rows[ans.index][0] = '';
                else rows[ans.index][0] = ans.text;
            }
        }
    }

    // 解析每行数据
    const entries = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        let title = '', body = '', footer = '';
        if (splitMode > 0) {
            let rowText = row[0] || '';
            let lines = rowText.split('\n').map(l => l.trim()).filter(l => l);
            if (lines.length === 0) continue;

            if (splitMode === 1) {
                title = rowText.trim();
            } else if (splitMode === 4) {
                body = rowText.trim();
            } else if (splitMode === 5) {
                footer = rowText.trim();
            } else if (splitMode === 2) {
                if (lines.length >= 1) title = lines[0];
                if (lines.length >= 2) body = lines.slice(1).join('\n');
            } else if (splitMode === 3) {
                if (lines.length >= 1) title = lines[0];
                if (lines.length >= 3) {
                    footer = lines[lines.length - 1];
                    body = lines.slice(1, lines.length - 1).join('\n');
                } else if (lines.length === 2) {
                    body = lines[1];
                }
            }
        } else {
            if (row.length >= 4) {
                // 四列格式：名称 | 标题 | 内容 | 结尾
                title = row[1] || '';
                body = row[2] || '';
                footer = row[3] || '';
            } else if (row.length >= 3) {
                // 三列格式：标题 | 内容 | 结尾
                title = row[0] || '';
                body = row[1] || '';
                footer = row[2] || '';
            } else {
                // 两列/单列格式：标题 | 内容
                title = row[0] || '';
                body = row[1] || '';
            }
        }
        if (!title && !body && !footer) continue;
        entries.push({ title, body, footer });
    }

    if (!entries.length) {
        alert('未检测到有效文案数据');
        return;
    }

    let filled = 0, created = 0;

    if (mode === 'fill') {
        // ═══ 补全模式：只填没有文案的空行 ═══
        let entryIdx = 0;
        for (let i = 0; i < state.tasks.length && entryIdx < entries.length; i++) {
            const task = state.tasks[i];
            const ov = _findBatchOverlayByIdOrIdx(task, targetId, null, targetIdx, 'textcard');
            // 判断是不是空文案（title 和 body 都空，或者是默认占位符）
            const titleVal = ov ? (ov.title_text || '') : '';
            const bodyVal = ov ? (ov.body_text || '') : '';
            const isDefault = (t) => !t || t === '标题文字' || t === '内容文字';
            const isEmpty = isDefault(titleVal) && isDefault(bodyVal);

            if (isEmpty) {
                _setTaskText(task, entries[entryIdx].title, entries[entryIdx].body, ReelsOverlay, entries[entryIdx].footer, targetId, targetIdx);
                entryIdx++;
                filled++;
            }
        }
        // 剩余的追加为新行
        while (entryIdx < entries.length) {
            _createNewTextRow(state, entries[entryIdx].title, entries[entryIdx].body, ReelsOverlay, entries[entryIdx].footer, targetId, targetIdx);
            entryIdx++;
            created++;
        }

    } else if (mode === 'new') {
        // ═══ 添加新行模式：全部新建 ═══
        for (const entry of entries) {
            _createNewTextRow(state, entry.title, entry.body, ReelsOverlay, entry.footer, targetId, targetIdx);
            created++;
        }

    } else if (mode === 'overwrite') {
        // ═══ 覆盖模式：从第1行开始往下覆盖 ═══
        for (let i = 0; i < entries.length; i++) {
            if (i < state.tasks.length) {
                _setTaskText(state.tasks[i], entries[i].title, entries[i].body, ReelsOverlay, entries[i].footer, targetId, targetIdx);
                filled++;
            } else {
                _createNewTextRow(state, entries[i].title, entries[i].body, ReelsOverlay, entries[i].footer, targetId, targetIdx);
                created++;
            }
        }
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();

    const parts = [];
    if (filled) parts.push(`填充 ${filled} 行`);
    if (created) parts.push(`新建 ${created} 行`);
    alert(`✅ 粘贴完成：${parts.join('，')}`);
}

async function _batchPasteScrollFromSheet(targetId = null, targetIdx = null) {
    const mode = await _showPasteModeDialog();
    if (!mode) return;

    let raw = '';
    try {
        raw = await navigator.clipboard.readText();
    } catch (e) {
        raw = await _showPasteDialog();
    }
    if (!raw || !raw.trim()) return;

    const rows = _parseBatchTSV(raw);
    if (!rows.length) {
        alert('未检测到有效数据');
        return;
    }

    const isSingleColumn = rows.every(r => r.length === 1);
    let splitMode = 0;
    if (isSingleColumn) {
        const modeStr = await _showSplitPromptDialog('检测到您粘贴的内容只有一列且支持滚动。\\n如果单列内容有多行文本，你可以套用智能格式提取：', false);
        if (modeStr === '1') splitMode = 1;
        else if (modeStr === '2') splitMode = 2;
        else if (modeStr === '3') splitMode = 3;
        else if (modeStr === '4') splitMode = 4;
    }

    const state = window._reelsState;
    const ReelsOverlay = window.ReelsOverlay;
    if (!state || !ReelsOverlay) return;

    if (splitMode > 0) {
        let hasErrors = true;
        while (hasErrors) {
            let badRows = [];
            for (let i = 0; i < rows.length; i++) {
                const rowText = rows[i][0] || '';
                const lines = rowText.split('\n').map(l => l.trim()).filter(l => l);
                if (lines.length > 0 && ((splitMode === 2 && lines.length < 2) || (splitMode === 3 && lines.length < 3))) {
                    badRows.push({ index: i, text: rowText });
                }
            }
            if (badRows.length === 0) {
                hasErrors = false;
                break;
            }
            const newTexts = await _showBatchEditDialog(badRows, splitMode, rows.length);
            if (!newTexts) return;
            for (const ans of newTexts) {
                if (ans.skip) rows[ans.index][0] = '';
                else rows[ans.index][0] = ans.text;
            }
        }
    }

    // 解析每行数据
    const entries = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        let title = '', body = '';
        if (splitMode > 0) {
            let rowText = row[0] || '';
            let lines = rowText.split('\n').map(l => l.trim()).filter(l => l);
            if (lines.length === 0) continue;

            if (splitMode === 1) {
                title = rowText.trim();
            } else if (splitMode === 4) {
                body = rowText.trim();
            } else if (splitMode === 2) {
                if (lines.length >= 1) title = lines[0];
                if (lines.length >= 2) body = lines.slice(1).join('\n');
            } else if (splitMode === 3) {
                if (lines.length >= 1) title = lines[0];
                if (lines.length >= 3) {
                    body = lines.slice(1, lines.length - 1).join('\n');
                } else if (lines.length === 2) {
                    body = lines[1];
                }
            }
        } else {
            if (row.length >= 3) {
                title = row[1] || '';
                body = row[2] || '';
            } else if (row.length === 2) {
                title = row[0] || '';
                body = row[1] || '';
            } else {
                body = row[0] || ''; // 单列时不提取title，默认全做body
            }
        }
        if (!title && !body) continue;
        entries.push({ title, body });
    }

    if (!entries.length) {
        alert('未检测到有效滚动字幕数据');
        return;
    }

    let filled = 0, created = 0;

    if (mode === 'fill') {
        let entryIdx = 0;
        for (let i = 0; i < state.tasks.length && entryIdx < entries.length; i++) {
            const task = state.tasks[i];
            const scrollOv = _findBatchOverlayByIdOrIdx(task, targetId, null, targetIdx, 'scroll');
            const isEmpty = !scrollOv || (!(scrollOv.scroll_title || '').trim() && !(scrollOv.content || '').trim());
            if (isEmpty) {
                _setTaskScrollText(task, entries[entryIdx].title, entries[entryIdx].body, ReelsOverlay, targetId, targetIdx);
                entryIdx++;
                filled++;
            }
        }
        while (entryIdx < entries.length) {
            _createNewScrollRow(state, entries[entryIdx].title, entries[entryIdx].body, ReelsOverlay, targetId, targetIdx);
            entryIdx++;
            created++;
        }
    } else if (mode === 'new') {
        for (const entry of entries) {
            _createNewScrollRow(state, entry.title, entry.body, ReelsOverlay, targetId, targetIdx);
            created++;
        }
    } else if (mode === 'overwrite') {
        for (let i = 0; i < entries.length; i++) {
            if (i < state.tasks.length) {
                _setTaskScrollText(state.tasks[i], entries[i].title, entries[i].body, ReelsOverlay, targetId, targetIdx);
                filled++;
            } else {
                _createNewScrollRow(state, entries[i].title, entries[i].body, ReelsOverlay, targetId, targetIdx);
                created++;
            }
        }
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();

    const parts = [];
    if (filled) parts.push(`填充 ${filled} 行`);
    if (created) parts.push(`新建 ${created} 行`);
    alert(`✅ 滚动字幕粘贴完成：${parts.join('，')}`);
}

// ═══════════════════════════════════════════════════════
// Column visibility settings (per tab, saved to localStorage)
// ═══════════════════════════════════════════════════════

const _RBT_COLUMNS = [
    { key: 'exportname', label: '导出命名', default: true },
    { key: 'cover-media', label: '封面素材', default: true },
    { key: 'cover-text', label: '封面文案', default: true },
    { key: 'hook', label: '前置Hook', default: true },
    { key: 'bg', label: '背景素材', default: true },
    { key: 'clippool', label: '背景片段池', default: true },
    { key: 'bgclipsettings', label: '背景池剪辑', default: true },
    { key: 'bgscale', label: '背景缩放', default: true },
    { key: 'bgdurscale', label: '背景时长', default: true },
    { key: 'bgvol', label: '背景音量', default: true },
    { key: 'contentvideo', label: '内容视频', default: true },
    { key: 'cvtrim', label: '内容视频-时间段', default: true },
    { key: 'cvcrop', label: '内容视频-裁切', default: true },
    { key: 'cvblurbg', label: '内容视频-毛玻璃背景', default: true },
    { key: 'cvscale', label: '内容视频-缩放', default: true },
    { key: 'cvpos', label: '内容视频-位置', default: true },
    { key: 'cvvol', label: '内容视频-音量', default: true },
    { key: 'pip', label: '图像覆层', default: true },
    { key: 'ai_script', label: '人声-原文案', default: true },
    { key: 'tts_text', label: '人声-配音文案', default: true },
    { key: 'txtcontent', label: '人声-断行文案', default: true },
    { key: 'tts_voice', label: '人声-配音音色', default: true },
    { key: 'srt', label: '人声-SRT字幕', default: true },
    { key: 'audio', label: '人声-音频文件', default: true },
    { key: 'voicevol', label: '人声-音频音量', default: true },
    { key: 'audiodurscale', label: '人声-音频变速', default: true },
    { key: 'bgm', label: '配乐', default: true },
    { key: 'title', label: '覆层标题', default: true },
    { key: 'body', label: '覆层内容', default: true },
    { key: 'footer', label: '覆层结尾', default: true },
    { key: 'flipper-enabled', label: '启用翻转', default: true },
    { key: 'flipper-duration', label: '翻转间隔', default: true },
    { key: 'flipper-lines', label: '翻转行数', default: true },
    { key: 'flipper-effect', label: '翻转效果', default: true },
    { key: 'flipper-loop', label: '翻转循环', default: true },
    { key: 'scroll-title', label: '滚动标题', default: true },
    { key: 'scroll-body', label: '滚动内容', default: true },
    { key: 'subtime', label: '字幕时间', default: true },
    { key: 'dur', label: '时长(s)', default: true },
    { key: 'tpl', label: '动态字幕模版与覆层预设', default: true },
];

function _getColVisStorageKey() {
    const tabId = _batchTableState.activeTabId || 'default';
    return `rbt-col-vis-${tabId}`;
}

function _getColVisibility() {
    const key = _getColVisStorageKey();
    // 一次性迁移：将旧存储的列设置重置为全显示（版本号升级触发）
    const RESET_VERSION = 'v5-column-unification';
    const resetKey = key + '-reset-version';
    if (localStorage.getItem(resetKey) !== RESET_VERSION) {
        localStorage.removeItem(key);
        localStorage.setItem(resetKey, RESET_VERSION);
    }
    const saved = localStorage.getItem(key);
    // 始终以 _RBT_COLUMNS 的 default 为基准，合并已保存的设置
    const vis = {};
    for (const col of _RBT_COLUMNS) vis[col.key] = col.default;
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            for (const col of _RBT_COLUMNS) {
                if (col.key in parsed) vis[col.key] = parsed[col.key];
            }
        } catch (e) { }
    }
    return vis;
}

function _saveColVisibility(vis) {
    const key = _getColVisStorageKey();
    localStorage.setItem(key, JSON.stringify(vis));
}

/** 点击 AI 按钮时自动显示 TTS 相关列 */
function _ensureAIColumnsVisible() {
    const vis = _getColVisibility();
    let changed = false;
    for (const colKey of ['tts_text', 'tts_voice', 'ai_script']) {
        if (!vis[colKey]) {
            vis[colKey] = true;
            changed = true;
        }
    }
    if (changed) {
        _saveColVisibility(vis);
        _applyColVisibility();
    }
}

function _applyColVisibility() {
    const vis = _getColVisibility();
    // Remove old style
    let styleEl = document.getElementById('rbt-col-vis-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'rbt-col-vis-style';
        document.head.appendChild(styleEl);
    }
    const rules = [];
    for (const col of _RBT_COLUMNS) {
        if (col.key === 'tpl') {
            // tpl maps to two columns (字幕模板 + 覆层预设), both share .rbt-col-tpl
            if (!vis[col.key]) rules.push(`.rbt-col-tpl { display: none !important; }`);
        } else {
            if (!vis[col.key]) rules.push(`.rbt-col-${col.key} { display: none !important; }`);
        }
    }
    styleEl.textContent = rules.join('\n');
}

// ═══════════════════════════════════════════════════════
// 统一字幕模板样式预览选择器 (全局复用)
// ═══════════════════════════════════════════════════════

/**
 * 生成单个预设的带样式 HTML
 * @param {string} name - 预设名称
 * @param {object} presetsMap - { name: styleObj, ... }
 * @param {boolean} isUserPreset - 是否为用户自定义预设 (显示管理按钮)
 * @returns {string} HTML
 */
function _buildPresetStyledItemHTML(name, presetsMap, isUserPreset = false) {
    try {
        const style = (presetsMap && presetsMap[name]) || {};
        const m = window.ReelsStyleEngine ? ReelsStyleEngine.mergeStyle(style) : { ...style };
        const tc = m.color_text || m.color || '#FFFFFF';
        const sc = m.color_outline || m.stroke_color || '#000000';
        const bw = m.border_width || m.stroke_width || 3;
        const useStk = m.use_stroke !== false && m.stroke !== false;
        const bgC = m.color_bg || m.bg_color || '#000000';
        const useBg = m.use_box || m.bg_enabled || false;
        const bgR = Math.round((m.box_radius || m.bg_radius || 8) * 0.4);

        let ts = 'none';
        if (useStk && bw > 0) {
            const s = Math.max(1, Math.round(bw * 0.5));
            ts = `${s}px 0 0 ${sc}, -${s}px 0 0 ${sc}, 0 ${s}px 0 ${sc}, 0 -${s}px 0 ${sc}, ${s}px ${s}px 0 ${sc}, -${s}px -${s}px 0 ${sc}`;
        }
        if (m.shadow_blur > 0) {
            const extra = `2px 2px ${m.shadow_blur}px ${m.color_shadow || '#000'}`;
            ts = ts === 'none' ? extra : ts + ', ' + extra;
        }

        let bgCss = '';
        if (useBg) {
            const bgGradCols = m.bg_gradient_colors || [];
            if (m.bg_gradient_enabled && bgGradCols.length >= 2) {
                bgCss = `background:linear-gradient(90deg,${bgGradCols.join(',')});`;
            } else {
                bgCss = `background:${bgC};`;
            }
            // Fix text alignment: apply negative left margin to offset the left padding
            bgCss += `border-radius:${bgR}px;padding:2px 8px;margin-left:-8px;`;
        }

        const fw = m.bold || m.font_weight >= 700 ? 'bold' : 'normal';
        const fsStyle = m.italic ? 'font-style:italic;' : '';
        const ffStyle = m.font_family ? `font-family:"${_escHtml(m.font_family)}",sans-serif;` : '';
        const ttStyle = m.text_transform ? `text-transform:${m.text_transform};` : '';
        const lsStyle = m.letter_spacing ? `letter-spacing:${m.letter_spacing}px;` : '';

        const eName = _escHtml(name);

        // Accurate Preview for Karaoke/Dynamic Box
        let htmlName = '';
        if (m.karaoke_highlight || m.dynamic_box) {
            let splitIdx = eName.lastIndexOf('_');
            if (splitIdx === -1) splitIdx = eName.lastIndexOf('+');
            if (splitIdx === -1) splitIdx = eName.lastIndexOf('-');

            let part1, part2;
            if (splitIdx !== -1 && splitIdx < eName.length - 1) {
                part1 = eName.substring(0, splitIdx + 1); // includes delimiter
                part2 = eName.substring(splitIdx + 1);
            } else {
                const len = eName.length;
                part1 = eName.substring(0, Math.max(0, len - 3));
                part2 = eName.substring(Math.max(0, len - 3));
            }

            let highStyle = `color:${m.color_high || tc};`;
            if (m.dynamic_box) {
                const dynBg = m.color_high_bg || '#FFD700';
                const dynR = Math.round((m.dynamic_radius || 6) * 0.4);
                highStyle += `background:${dynBg};border-radius:${dynR}px;padding:1px 4px;margin:0 1px;`;
            }
            htmlName = `<span style="color:${tc};text-shadow:${ts};">${part1}</span><span style="${highStyle}text-shadow:${ts};">${part2}</span>`;
        } else {
            htmlName = `<span style="color:${tc};text-shadow:${ts};">${eName}</span>`;
        }

        // 用户预设：显示重命名和删除按钮
        const mgmtBtns = isUserPreset ? `
            <span class="rbt-ssp-mgmt" style="margin-left:auto;display:inline-flex;gap:2px;opacity:0;transition:opacity 0.15s;flex-shrink:0;">
                <button class="rbt-ssp-rename-btn" data-preset-name="${eName}" title="重命名" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px 4px;color:#8af;line-height:1;">✏️</button>
                <button class="rbt-ssp-delete-btn" data-preset-name="${eName}" title="删除" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px 4px;color:#f87171;line-height:1;">🗑</button>
            </span>` : '';

        return `<div class="rbt-sub-styled-item" data-val="${eName}" data-user-preset="${isUserPreset ? '1' : ''}" style="padding:5px 18px;cursor:pointer;border-bottom:1px solid #2a2a3e;display:flex;align-items:center;gap:6px;">
            <span style="font-size:15px;font-weight:${fw};line-height:1.5;${bgCss}${fsStyle}${ffStyle}${ttStyle}${lsStyle}display:inline-block;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                ${htmlName}
            </span>
            ${mgmtBtns}
        </div>`;
    } catch (e) {
        return `<div class="rbt-sub-styled-item" data-val="${_escHtml(name)}" style="padding:5px 18px;cursor:pointer;border-bottom:1px solid #2a2a3e;color:#ccc;font-size:13px;">${_escHtml(name)}</div>`;
    }
}

/**
 * 打开统一的字幕模板选择器弹窗（position:fixed 挂到 body，不会被裁切）
 * @param {HTMLElement} anchorEl - 触发元素，用于定位
 * @param {string} currentVal - 当前选中值
 * @param {function} onSelect - 回调 (selectedName) => void
 */
window._openStyledPresetPicker = _openStyledPresetPicker;
function _openStyledPresetPicker(anchorEl, currentVal, onSelect) {
    // 关闭已有弹窗
    const existing = document.getElementById('rbt-styled-preset-picker');
    if (existing) { existing.remove(); return; }

    let presetsMap = {};
    let names = [];
    let categorized = [];
    try {
        if (window.ReelsStyleEngine && ReelsStyleEngine.getPresetsByCategory) {
            const catData = ReelsStyleEngine.getPresetsByCategory();
            presetsMap = catData.presetsMap || {};
            categorized = catData.categorized || [];
            names = Object.keys(presetsMap);
        } else {
            const data = window.ReelsStyleEngine ? ReelsStyleEngine.loadSubtitlePresets() : { presets: {} };
            presetsMap = data.presets || {};
            names = Object.keys(presetsMap);
        }
    } catch (e) { }

    if (names.length === 0) {
        alert('暂无字幕预设。请在字幕面板中保存预设后再使用。');
        return;
    }

    const popup = document.createElement('div');
    popup.id = 'rbt-styled-preset-picker';

    // 定位：基于触发元素
    const rect = anchorEl.getBoundingClientRect();
    const panelW = 340;
    const panelMaxH = Math.min(500, window.innerHeight - 60);
    let left = Math.min(rect.left, window.innerWidth - panelW - 10);
    let top = rect.bottom + 4;
    // 如果下方空间不够，改为上方弹出
    if (top + panelMaxH > window.innerHeight) {
        top = Math.max(10, rect.top - panelMaxH - 4);
    }

    Object.assign(popup.style, {
        position: 'fixed',
        left: left + 'px',
        top: top + 'px',
        width: panelW + 'px',
        maxHeight: panelMaxH + 'px',
        overflowY: 'auto',
        zIndex: '99999',
        background: '#1a1a2e',
        border: '1px solid #444',
        borderRadius: '8px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
        padding: '0',
    });

    // 搜索区
    const searchHtml = `
        <div style="padding:10px; border-bottom:1px solid #2a2a3e; background:rgba(0,0,0,0.2); position:sticky; top:0; z-index:10;">
            <input type="text" id="rbt-ssp-search" placeholder="搜索预设..." style="width:100%; box-sizing:border-box; background:#000; border:1px solid #555; border-radius:4px; color:#eee; font-size:12px; padding:6px; outline:none;" autocomplete="off">
        </div>
    `;

    // 默认项
    const defaultHtml = `
        <div class="rbt-sub-styled-item" data-val="" style="margin:8px 10px; padding:8px 12px; font-size:12px; color:#aaa; border:1px dashed #444; border-radius:6px; cursor:pointer; text-align:center; transition:background 0.2s;">
            -- 不使用/恢复默认 --
        </div>
    `;

    // 列表区 — 按分类折叠
    let listHtml = '<div id="rbt-ssp-list" style="padding-bottom:8px;">';
    if (categorized.length > 0) {
        for (const group of categorized) {
            const isUserPresets = group.category.includes('我的预设');
            listHtml += `<details class="rbt-ssp-category" ${isUserPresets ? 'open' : 'open'} style="margin:0;">
                <summary style="cursor:pointer;padding:8px 14px;font-size:12px;font-weight:700;color:#8af;background:rgba(74,158,255,0.05);border-bottom:1px solid #2a2a3e;user-select:none;position:sticky;top:0;z-index:5;">
                    ${_escHtml(group.category)} <span style="font-size:10px;color:#666;font-weight:400;">(${group.names.length})</span>
                </summary>
                <div class="rbt-ssp-cat-items">
                    ${group.names.map(n => _buildPresetStyledItemHTML(n, presetsMap, isUserPresets)).join('')}
                </div>
            </details>`;
        }
    } else {
        // Fallback: flat list
        listHtml += names.map(n => _buildPresetStyledItemHTML(n, presetsMap)).join('');
    }
    listHtml += '</div>';

    popup.innerHTML = searchHtml + defaultHtml + listHtml;
    document.body.appendChild(popup);

    // 标记当前选中项
    if (currentVal) {
        const activeItem = popup.querySelector(`.rbt-sub-styled-item[data-val="${CSS.escape(currentVal)}"]`);
        if (activeItem) {
            activeItem.style.background = 'rgba(74,158,255,0.15)';
            activeItem.style.borderLeft = '3px solid #4a9eff';
        }
    }

    const searchInput = popup.querySelector('#rbt-ssp-search');
    const listContainer = popup.querySelector('#rbt-ssp-list');

    // 搜索逻辑（支持分类折叠）
    setTimeout(() => searchInput.focus(), 30);
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        // Filter items
        listContainer.querySelectorAll('.rbt-sub-styled-item').forEach(el => {
            const val = (el.dataset.val || '').toLowerCase();
            el.style.display = val.includes(q) ? 'block' : 'none';
        });
        // Show/hide empty categories
        listContainer.querySelectorAll('.rbt-ssp-category').forEach(details => {
            const items = details.querySelectorAll('.rbt-sub-styled-item');
            const hasVisible = Array.from(items).some(el => el.style.display !== 'none');
            details.style.display = hasVisible ? 'block' : 'none';
            if (q && hasVisible) details.open = true;
        });
    });

    // 点击项 → 应用预设但不关闭（方便快速切换对比）
    let _activeItem = null;
    popup.querySelectorAll('.rbt-sub-styled-item').forEach(item => {
        item.addEventListener('click', (e) => {
            // 如果点击的是管理按钮（重命名/删除），不触发选择
            if (e.target.closest('.rbt-ssp-rename-btn') || e.target.closest('.rbt-ssp-delete-btn')) return;
            const val = item.dataset.val;
            // 更新选中高亮
            if (_activeItem) {
                _activeItem.style.background = 'transparent';
                _activeItem.style.borderLeft = '';
            }
            item.style.background = 'rgba(74,158,255,0.15)';
            item.style.borderLeft = '3px solid #4a9eff';
            _activeItem = item;
            if (onSelect) onSelect(val);
        });
        item.addEventListener('mouseenter', () => {
            if (item !== _activeItem) item.style.background = 'rgba(74,158,255,0.1)';
            // 显示管理按钮
            const mgmt = item.querySelector('.rbt-ssp-mgmt');
            if (mgmt) mgmt.style.opacity = '1';
        });
        item.addEventListener('mouseleave', () => {
            if (item !== _activeItem) item.style.background = 'transparent';
            // 隐藏管理按钮
            const mgmt = item.querySelector('.rbt-ssp-mgmt');
            if (mgmt) mgmt.style.opacity = '0';
        });
    });

    // ── 用户预设管理：重命名 ──
    popup.querySelectorAll('.rbt-ssp-rename-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const oldName = btn.dataset.presetName;
            if (!oldName || !window.ReelsStyleEngine) return;
            const newName = await (typeof _showInputDialog === 'function'
                ? _showInputDialog('重命名预设', oldName)
                : prompt('请输入新名称：', oldName));
            if (!newName || !newName.trim() || newName.trim() === oldName) return;
            const success = ReelsStyleEngine.renameSubtitlePreset(oldName, newName.trim());
            if (success) {
                if (typeof showToast === 'function') showToast(`预设已重命名为「${newName.trim()}」`, 'success');
                // 如果当前选中的正是被重命名的预设，更新引用
                if (onSelect) onSelect(newName.trim());
                // 关闭并重新打开以刷新列表
                popup.remove();
                document.removeEventListener('mousedown', outsideHandler);
                _openStyledPresetPicker(anchorEl, newName.trim(), onSelect);
            } else {
                if (typeof showToast === 'function') showToast('重命名失败：目标名称已存在或原预设不存在', 'error');
                else alert('重命名失败：目标名称已存在或原预设不存在');
            }
        });
    });

    // ── 用户预设管理：删除 ──
    popup.querySelectorAll('.rbt-ssp-delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const name = btn.dataset.presetName;
            if (!name || !window.ReelsStyleEngine) return;
            if (!confirm(`确定删除预设「${name}」？`)) return;
            ReelsStyleEngine.deleteSubtitlePreset(name);
            // 清除默认预设引用
            const defaultName = localStorage.getItem('reels_default_preset') || '';
            if (defaultName === name) localStorage.removeItem('reels_default_preset');
            if (typeof showToast === 'function') showToast(`预设「${name}」已删除`, 'success');
            // 关闭并重新打开以刷新列表
            popup.remove();
            document.removeEventListener('mousedown', outsideHandler);
            _openStyledPresetPicker(anchorEl, currentVal === name ? '' : currentVal, onSelect);
        });
    });

    // 鼠标移开弹窗后延迟关闭
    let _closeTimer = null;
    popup.addEventListener('mouseleave', () => {
        _closeTimer = setTimeout(() => {
            popup.remove();
            document.removeEventListener('mousedown', outsideHandler);
        }, 600);
    });
    popup.addEventListener('mouseenter', () => {
        if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
    });

    // 点击外部关闭
    const outsideHandler = (e) => {
        if (!popup.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
            popup.remove();
            document.removeEventListener('mousedown', outsideHandler);
        }
    };
    requestAnimationFrame(() => {
        document.addEventListener('mousedown', outsideHandler);
    });
}

function _showColumnSettingsPopup(anchor) {
    // Remove existing popup
    const existing = document.getElementById('rbt-col-settings-popup');
    if (existing) { existing.remove(); return; }

    const vis = _getColVisibility();
    const ACTIVE_COL_MODE_KEY = 'rbt-col-active-mode';
    let activeColMode = localStorage.getItem(ACTIVE_COL_MODE_KEY) || '';
    const _setActiveColMode = (mode) => {
        activeColMode = mode || 'manual';
        localStorage.setItem(ACTIVE_COL_MODE_KEY, activeColMode);
    };
    const popup = document.createElement('div');
    popup.id = 'rbt-col-settings-popup';
    // Position near anchor
    const rect = anchor.getBoundingClientRect();
    const maxHeight = Math.max(200, window.innerHeight - rect.bottom - 16);

    popup.style.cssText = `position:fixed;z-index:100000;background:#141420;border:1px solid #2a2a4a;border-radius:10px;padding:16px;min-width:320px;max-width:380px;box-shadow:0 12px 40px rgba(0,0,0,0.7);` +
        `top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;max-height:${maxHeight}px;overflow-y:auto;`;

    // ── 预设方案定义 ──
    const presets = [
        {
            name: '🚀 一键工作流',
            desc: '一键工作流常用列：背景视频、原文案、音色、配音与字幕结果、常用调整参数、命名和模板',
            cols: [
                'exportname',
                'bg', 'bgscale', 'bgdurscale', 'bgvol',
                'ai_script', 'tts_text', 'txtcontent', 'tts_voice',
                'audio', 'voicevol', 'audiodurscale', 'srt',
                'bgm', 'dur', 'tpl'
            ]
        },
        {
            name: 'HeyGen匹配字幕',
            desc: '背景视频 + 根据背景素材声音对齐字幕',
            cols: ['bg', 'bgscale', 'bgdurscale', 'srt', 'txtcontent', 'dur', 'tpl', 'exportname']
        },
        {
            name: '无字幕动画Reels',
            desc: '背景素材 + 覆层(标题/内容/结尾) + 图像覆层 + 配乐',
            cols: ['bg', 'bgscale', 'bgdurscale', 'bgm', 'title', 'body', 'footer', 'flipper-enabled', 'flipper-duration', 'flipper-lines', 'flipper-effect', 'flipper-loop', 'dur', 'tpl', 'exportname']
        },
        {
            name: '动态字幕(手动)',
            desc: '背景素材 + 手动提供人声-音频文件/人声-SRT字幕/人声-断行文案 + 配乐',
            cols: ['bg', 'bgscale', 'bgdurscale', 'audio', 'audiodurscale', 'bgm', 'srt', 'txtcontent', 'dur', 'tpl', 'exportname']
        },
        {
            name: '动态字幕(AI自动)',
            desc: '背景素材 + AI文案→TTS→字幕 全自动流水线 + 配乐',
            cols: ['bg', 'bgscale', 'bgdurscale', 'ai_script', 'tts_text', 'tts_voice', 'audio', 'audiodurscale', 'bgm', 'srt', 'txtcontent', 'dur', 'tpl', 'exportname']
        },
        {
            name: '滚动字幕(手动)',
            desc: '背景素材 + 手动提供人声-音频文件 + 滚动标题/内容 + 配乐',
            cols: ['bg', 'bgscale', 'bgdurscale', 'audio', 'audiodurscale', 'bgm', 'scroll-title', 'scroll-body', 'dur', 'tpl', 'exportname']
        },
        {
            name: '滚动字幕(AI自动)',
            desc: '背景素材 + AI文案→TTS→人声 + 滚动标题/内容 + 配乐',
            cols: ['bg', 'bgscale', 'bgdurscale', 'ai_script', 'tts_text', 'tts_voice', 'audio', 'audiodurscale', 'bgm', 'scroll-title', 'scroll-body', 'dur', 'tpl', 'exportname']
        },
        {
            name: '达芬奇剪辑',
            desc: '背景 + 内容视频(裁切/缩放/位置/音量) + 覆层文案 + 配乐',
            cols: ['bg', 'bgscale', 'bgdurscale', 'contentvideo', 'cvtrim', 'cvcrop', 'cvblurbg', 'cvscale', 'cvpos', 'cvvol', 'bgm', 'title', 'body', 'footer', 'flipper-enabled', 'flipper-duration', 'flipper-lines', 'flipper-effect', 'flipper-loop', 'dur', 'tpl', 'exportname']
        },
        {
            name: '加Hook版口播',
            desc: 'Hook + 封面 + 背景 + 全套人声/字幕 + 配乐',
            cols: ['hook', 'cover-media', 'cover-text', 'bg', 'bgscale', 'bgdurscale', 'ai_script', 'tts_text', 'tts_voice', 'audio', 'audiodurscale', 'bgm', 'srt', 'txtcontent', 'dur', 'tpl', 'exportname']
        }
    ];

    // ── 列分类 ──
    const colGroups = [
        { label: '封面控制', keys: ['cover-media', 'cover-text'] },
        { label: '背景控制', keys: ['hook', 'bg', 'clippool', 'bgclipsettings', 'bgscale', 'bgdurscale', 'bgvol', 'bgm'] },
        { label: '内容视频', keys: ['contentvideo', 'cvtrim', 'cvcrop', 'cvblurbg', 'cvscale', 'cvpos', 'cvvol'] },
        { label: '人声音轨', keys: ['ai_script', 'tts_text', 'txtcontent', 'tts_voice', 'srt', 'audio', 'voicevol', 'audiodurscale'] },
        { label: '文字覆层', keys: ['pip', 'title', 'body', 'footer', 'flipper-enabled', 'flipper-duration', 'flipper-lines', 'flipper-effect', 'flipper-loop', 'scroll-title', 'scroll-body', 'subtime'] },
        { label: '基础配置', keys: ['dur', 'tpl', 'exportname'] },
    ];

    // Build column label map
    const colLabelMap = {};
    for (const col of _RBT_COLUMNS) colLabelMap[col.key] = col.label;

    let html = '<div style="font-size:13px;font-weight:600;color:#ddd;margin-bottom:10px;">⚙️ 列显示设置</div>';

    // ── Presets ──
    html += '<div style="margin-bottom:12px;">';
    html += '<div style="font-size:10px;color:#888;font-weight:600;text-transform:uppercase;margin-bottom:6px;">快捷预设（一键配置）</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
    for (let i = 0; i < presets.length; i++) {
        const p = presets[i];
        html += `<button class="rbt-col-preset-btn" data-preset="${i}" title="${p.desc}"
            style="padding:3px 10px;border-radius:4px;border:1px solid #333;background:#1e1e38;color:#ccc;font-size:11px;cursor:pointer;transition:all .15s;white-space:nowrap;"
        >${p.name}</button>`;
    }
    // 显示完整（全部列）按钮
    html += `<button id="rbt-col-preset-showall" title="显示所有列"
        style="padding:3px 10px;border-radius:4px;border:1px solid #333;background:#1e1e38;color:#ccc;font-size:11px;cursor:pointer;transition:all .15s;white-space:nowrap;font-weight:600;"
    >📋 显示完整</button>`;
    html += `<span id="rbt-col-custom-mode" style="display:none;padding:3px 10px;border-radius:4px;border:1px solid #f59e0b;background:rgba(245,158,11,.15);color:#fbbf24;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 0 10px rgba(245,158,11,.25);">✏️ 自定义模式</span>`;
    html += '</div></div>';

    // ── Categorized columns ──
    html += '<div style="border-top:1px solid #2a2a4a;padding-top:10px;">';
    for (const group of colGroups) {
        html += `<div style="margin-bottom:8px;">`;
        html += `<div style="font-size:10px;color:#888;font-weight:600;text-transform:uppercase;margin-bottom:4px;">${group.label}</div>`;
        html += `<div style="display:flex;flex-wrap:wrap;gap:3px 10px;">`;
        for (const key of group.keys) {
            const label = colLabelMap[key] || key;
            const checked = vis[key] !== false ? 'checked' : '';
            html += `<label style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:11px;color:#bbb;cursor:pointer;min-width:120px;">
                <input type="checkbox" class="rbt-col-vis-chk" data-col="${key}" ${checked} style="accent-color:var(--accent);margin:0;">
                ${label}
            </label>`;
        }
        html += `</div></div>`;
    }
    html += '</div>';

    // ── custom presets ──
    const CUSTOM_PRESET_KEY = 'rbt-col-custom-presets';
    const _loadCustomPresets = () => { try { return JSON.parse(localStorage.getItem(CUSTOM_PRESET_KEY) || '{}'); } catch (e) { return {}; } };
    const _saveCustomPresets = (p) => localStorage.setItem(CUSTOM_PRESET_KEY, JSON.stringify(p));

    const customPresets = _loadCustomPresets();
    const customNames = Object.keys(customPresets);
    html += '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #2a2a4a;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
    html += '<div style="font-size:10px;color:#888;font-weight:600;text-transform:uppercase;">我的预设</div>';
    html += '<button id="rbt-col-save-preset" style="font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid #4a9eff;background:transparent;color:#4a9eff;cursor:pointer;" title="保存当前列配置为自定义预设">💾 保存当前</button>';
    html += '</div>';
    if (customNames.length > 0) {
        html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">';
        for (const name of customNames) {
            html += `<div style="display:inline-flex;align-items:center;gap:2px;background:#1e1e38;border:1px solid #333;border-radius:4px;padding:1px 2px 1px 8px;">
                <button class="rbt-col-custom-btn" data-custom-name="${_escHtml(name)}" style="border:none;background:transparent;color:#ccc;font-size:11px;cursor:pointer;padding:2px 4px;" title="加载预设">${_escHtml(name)}</button>
                <button class="rbt-col-custom-del" data-custom-name="${_escHtml(name)}" style="border:none;background:transparent;color:#f87171;font-size:10px;cursor:pointer;padding:2px 4px;line-height:1;" title="删除">✕</button>
            </div>`;
        }
        html += '</div>';
    } else {
        html += '<div style="font-size:10px;color:#555;margin-bottom:6px;padding:4px 0;">暂无自定义预设</div>';
    }
    html += '</div>';

    // ── Footer buttons ──
    html += `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #2a2a4a;display:flex;gap:8px;justify-content:space-between;align-items:center;">
        <div style="display:flex;gap:4px;">
            <button id="rbt-col-export" style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid #555;background:transparent;color:#8af;cursor:pointer;" title="导出列配置为 JSON 文件">📤 导出</button>
            <button id="rbt-col-import" style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid #555;background:transparent;color:#8af;cursor:pointer;" title="从 JSON 文件导入列配置">📥 导入</button>
            <input type="file" id="rbt-col-import-input" accept=".json" style="display:none;">
        </div>
        <div style="display:flex;gap:6px;">
            <button id="rbt-col-vis-all" style="font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;">全选</button>
            <button id="rbt-col-vis-none" style="font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;">全不选</button>
            <button id="rbt-col-vis-reset" style="font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;">恢复默认</button>
            <button id="rbt-col-vis-close" style="font-size:11px;padding:4px 10px;border-radius:4px;border:none;background:var(--accent);color:#000;cursor:pointer;font-weight:600;">完成</button>
        </div>
    </div>`;
    popup.innerHTML = html;
    document.body.appendChild(popup);

    // Helper: sync checkboxes with vis state
    const _syncCheckboxes = () => {
        popup.querySelectorAll('.rbt-col-vis-chk').forEach(chk => {
            chk.checked = vis[chk.dataset.col] !== false;
        });
    };
    const _matchesVisibleColumns = (enabledCols) => {
        const enabled = new Set(enabledCols || []);
        return _RBT_COLUMNS.every(col => (vis[col.key] !== false) === enabled.has(col.key));
    };
    const _refreshPresetHighlight = () => {
        const matchedBuiltinIndex = presets.findIndex(preset => _matchesVisibleColumns(preset.cols));
        const allVisible = _RBT_COLUMNS.every(col => vis[col.key] !== false);
        const matchedCustomName = Object.keys(customPresets).find(name => _matchesVisibleColumns(customPresets[name]));
        if (!activeColMode) {
            if (matchedBuiltinIndex >= 0) _setActiveColMode(`builtin:${matchedBuiltinIndex}`);
            else if (allVisible) _setActiveColMode('showall');
            else if (matchedCustomName) _setActiveColMode(`custom:${matchedCustomName}`);
            else _setActiveColMode('manual');
        } else if (
            (activeColMode.startsWith('builtin:') && matchedBuiltinIndex !== parseInt(activeColMode.split(':')[1]))
            || (activeColMode === 'showall' && !allVisible)
            || (activeColMode.startsWith('custom:')
                && (!Object.prototype.hasOwnProperty.call(customPresets, activeColMode.slice(7))
                    || !_matchesVisibleColumns(customPresets[activeColMode.slice(7)])))
        ) {
            _setActiveColMode('manual');
        }
        popup.querySelectorAll('.rbt-col-preset-btn').forEach(btn => {
            const preset = presets[parseInt(btn.dataset.preset)];
            const active = !!preset
                && activeColMode === `builtin:${btn.dataset.preset}`
                && _matchesVisibleColumns(preset.cols);
            btn.style.background = active ? 'linear-gradient(135deg,#5b4bb7,#7c5cff)' : '#1e1e38';
            btn.style.borderColor = active ? '#b8a7ff' : '#333';
            btn.style.color = active ? '#fff' : '#ccc';
            btn.style.boxShadow = active ? '0 0 0 1px rgba(184,167,255,.35),0 0 12px rgba(124,92,255,.45)' : 'none';
            btn.style.fontWeight = active ? '700' : '400';
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        const showAllBtn = popup.querySelector('#rbt-col-preset-showall');
        if (showAllBtn) {
            const active = activeColMode === 'showall' && allVisible;
            showAllBtn.style.background = active ? 'rgba(80,200,120,0.22)' : '#1e1e38';
            showAllBtn.style.borderColor = active ? '#50c878' : '#333';
            showAllBtn.style.color = active ? '#6fea9d' : '#ccc';
            showAllBtn.style.boxShadow = active ? '0 0 12px rgba(80,200,120,.32)' : 'none';
            showAllBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
        }
        popup.querySelectorAll('.rbt-col-custom-btn').forEach(btn => {
            const cols = customPresets[btn.dataset.customName] || [];
            const active = activeColMode === `custom:${btn.dataset.customName}` && _matchesVisibleColumns(cols);
            const wrapper = btn.parentElement;
            if (wrapper) {
                wrapper.style.background = active ? 'rgba(124,92,255,.28)' : '#1e1e38';
                wrapper.style.borderColor = active ? '#a78bfa' : '#333';
                wrapper.style.boxShadow = active ? '0 0 10px rgba(124,92,255,.35)' : 'none';
            }
            btn.style.color = active ? '#fff' : '#ccc';
            btn.style.fontWeight = active ? '700' : '400';
        });
        const customMode = popup.querySelector('#rbt-col-custom-mode');
        if (customMode) customMode.style.display = activeColMode === 'manual' ? 'inline-flex' : 'none';
    };
    _refreshPresetHighlight();

    // Event: preset buttons
    popup.querySelectorAll('.rbt-col-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const p = presets[parseInt(btn.dataset.preset)];
            // Turn all off first, then turn on only preset cols
            for (const col of _RBT_COLUMNS) vis[col.key] = false;
            for (const k of p.cols) vis[k] = true;
            _setActiveColMode(`builtin:${btn.dataset.preset}`);
            _saveColVisibility(vis);
            _applyColVisibility();
            _syncCheckboxes();
            _refreshPresetHighlight();
        });
    });

    // Event: 显示完整（全部列）
    popup.querySelector('#rbt-col-preset-showall')?.addEventListener('click', () => {
        for (const col of _RBT_COLUMNS) vis[col.key] = true;
        _setActiveColMode('showall');
        _saveColVisibility(vis);
        _applyColVisibility();
        _syncCheckboxes();
        _refreshPresetHighlight();
    });

    // Event: checkbox change
    popup.querySelectorAll('.rbt-col-vis-chk').forEach(chk => {
        chk.addEventListener('change', () => {
            vis[chk.dataset.col] = chk.checked;
            _setActiveColMode('manual');
            _saveColVisibility(vis);
            _applyColVisibility();
            _refreshPresetHighlight();
        });
    });

    // Event: select all
    popup.querySelector('#rbt-col-vis-all').addEventListener('click', () => {
        for (const col of _RBT_COLUMNS) vis[col.key] = true;
        _setActiveColMode('manual');
        _saveColVisibility(vis);
        _applyColVisibility();
        _syncCheckboxes();
        _refreshPresetHighlight();
    });

    // Event: select none
    popup.querySelector('#rbt-col-vis-none').addEventListener('click', () => {
        for (const col of _RBT_COLUMNS) vis[col.key] = false;
        _setActiveColMode('manual');
        _saveColVisibility(vis);
        _applyColVisibility();
        _syncCheckboxes();
        _refreshPresetHighlight();
    });

    // Event: reset
    popup.querySelector('#rbt-col-vis-reset').addEventListener('click', () => {
        for (const col of _RBT_COLUMNS) vis[col.key] = col.default;
        _setActiveColMode('manual');
        _saveColVisibility(vis);
        _applyColVisibility();
        _syncCheckboxes();
        _refreshPresetHighlight();
    });

    // Event: close
    popup.querySelector('#rbt-col-vis-close').addEventListener('click', () => {
        popup.remove();
    });

    // ── 自定义预设事件 ──
    // 保存当前配置
    popup.querySelector('#rbt-col-save-preset')?.addEventListener('click', () => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:9999;border-radius:12px;';
        overlay.innerHTML = `
            <div style="background:#2d2d2d;padding:15px;border-radius:8px;border:1px solid #444;width:80%;max-width:300px;">
                <div style="color:#eee;font-size:13px;margin-bottom:8px;">请输入预设名称：</div>
                <input type="text" id="_col-preset-input" style="width:100%;box-sizing:border-box;background:#111;color:#fff;border:1px solid #555;padding:6px;border-radius:4px;outline:none;margin-bottom:12px;" />
                <div style="display:flex;justify-content:flex-end;gap:8px;">
                    <button id="_col-preset-cancel" style="padding:4px 10px;background:#444;color:#eee;border:none;border-radius:4px;cursor:pointer;font-size:12px;">取消</button>
                    <button id="_col-preset-confirm" style="padding:4px 10px;background:#4a9eff;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">保存</button>
                </div>
            </div>
        `;
        popup.appendChild(overlay);
        const input = overlay.querySelector('#_col-preset-input');
        input.focus();

        const closePrompt = () => overlay.remove();

        const confirmSave = () => {
            const name = input.value;
            if (!name || !name.trim()) {
                closePrompt();
                return;
            }
            const cp = _loadCustomPresets();
            const enabledCols = _RBT_COLUMNS.filter(c => vis[c.key]).map(c => c.key);
            cp[name.trim()] = enabledCols;
            _saveCustomPresets(cp);
            closePrompt();
            popup.remove();
            _showColumnSettingsPopup(document.querySelector('[data-action="col-settings"]') || document.body);
            if (typeof showToast === 'function') showToast(`✅ 预设 "${name.trim()}" 已保存`, 'success');
        };

        overlay.querySelector('#_col-preset-cancel').onclick = closePrompt;
        overlay.querySelector('#_col-preset-confirm').onclick = confirmSave;
        input.onkeydown = (e) => {
            if (e.key === 'Enter') confirmSave();
            if (e.key === 'Escape') closePrompt();
        };
    });

    // 加载自定义预设
    popup.querySelectorAll('.rbt-col-custom-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const cp = _loadCustomPresets();
            const cols = cp[btn.dataset.customName];
            if (!cols) return;
            for (const col of _RBT_COLUMNS) vis[col.key] = false;
            for (const k of cols) vis[k] = true;
            _setActiveColMode(`custom:${btn.dataset.customName}`);
            _saveColVisibility(vis);
            _applyColVisibility();
            _syncCheckboxes();
            _refreshPresetHighlight();
        });
    });

    // 删除自定义预设
    popup.querySelectorAll('.rbt-col-custom-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const name = btn.dataset.customName;
            if (!confirm(`确定删除预设 "${name}"？`)) return;
            const cp = _loadCustomPresets();
            delete cp[name];
            _saveCustomPresets(cp);
            popup.remove();
            _showColumnSettingsPopup(document.querySelector('[data-action="col-settings"]') || document.body);
        });
    });

    // ── JSON 导出/导入 ──
    popup.querySelector('#rbt-col-export')?.addEventListener('click', () => {
        const exportData = {
            version: 1,
            type: 'rbt-col-visibility',
            columns: { ...vis },
            customPresets: _loadCustomPresets(),
            exportedAt: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `列显示预设_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        if (typeof showToast === 'function') showToast('📤 列配置已导出', 'success');
    });

    const importInput = popup.querySelector('#rbt-col-import-input');
    popup.querySelector('#rbt-col-import')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if (data.type !== 'rbt-col-visibility') throw new Error('格式不匹配');
                // 导入列配置
                if (data.columns) {
                    for (const col of _RBT_COLUMNS) {
                        if (col.key in data.columns) vis[col.key] = data.columns[col.key];
                    }
                    _setActiveColMode('manual');
                    _saveColVisibility(vis);
                    _applyColVisibility();
                }
                // 导入自定义预设（合并）
                if (data.customPresets) {
                    const existing = _loadCustomPresets();
                    Object.assign(existing, data.customPresets);
                    _saveCustomPresets(existing);
                }
                popup.remove();
                _showColumnSettingsPopup(document.querySelector('[data-action="col-settings"]') || document.body);
                if (typeof showToast === 'function') showToast('📥 列配置已导入', 'success');
            } catch (err) {
                alert('导入失败: ' + err.message);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    // Click outside to close
    setTimeout(() => {
        const handler = (e) => {
            if (!popup.contains(e.target) && e.target !== anchor) {
                popup.remove();
                document.removeEventListener('mousedown', handler);
            }
        };
        document.addEventListener('mousedown', handler);
    }, 100);
}

function _parseClipSettingsString(str) {
    if (!str || !str.trim()) return [];
    const parts = str.split(/[;,|，]/);
    const result = [];
    for (const part of parts) {
        const p = part.trim();
        if (!p) continue;
        const range = p.split(/[-~]/);
        if (range.length === 2) {
            const start = parseFloat(range[0].trim());
            const end = parseFloat(range[1].trim());
            result.push({
                trimStart: isNaN(start) ? null : start,
                trimEnd: isNaN(end) ? null : end
            });
        } else {
            const val = parseFloat(p);
            if (!isNaN(val)) {
                result.push({ trimStart: null, trimEnd: val });
            }
        }
    }
    return result;
}

window._parseClipSettingsString = _parseClipSettingsString;

// ═══════════════════════════════════════════════════════
// Multi-Clip Background Pool — 多素材随机拼接管理
// ═══════════════════════════════════════════════════════

function _showBgPoolDialog(taskIdx) {
    const state = window._reelsState;
    if (!state || !state.tasks[taskIdx]) return;
    const task = state.tasks[taskIdx];

    // Init fields if missing
    if (!task.bgClipPool) task.bgClipPool = [];
    if (!task.bgTransition) task.bgTransition = 'crossfade';
    if (!task.bgTransDur) task.bgTransDur = 0.5;
    if (!task.bgClipOrder) task.bgClipOrder = 'random';
    if (!Array.isArray(task.bgClipActivePool)) task.bgClipActivePool = [];
    if (!task.bgMode) task.bgMode = task.bgClipPool.length > 0 ? 'multi' : 'single';
    if (task.bgMinClipDur === undefined) task.bgMinClipDur = 5;
    if (task.bgMaxClipDur === undefined) task.bgMaxClipDur = 7;

    const _refreshBgPoolPreview = () => {
        _renderBatchTable();
        const selectedIdx = window._reelsState ? window._reelsState.selectedIdx : -1;
        const selectedTask = selectedIdx >= 0 ? state.tasks[selectedIdx] : null;
        if (selectedTask && window.reelsSyncBackgroundTabUI) {
            window.reelsSyncBackgroundTabUI(selectedTask);
        }
        if (selectedIdx >= 0 && typeof window.reelsSelectTask === 'function') {
            window.reelsSelectTask(selectedIdx);
        } else if (typeof reelsUpdatePreview === 'function') {
            reelsUpdatePreview();
        }
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    };

    document.getElementById('rbt-bgpool-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'rbt-bgpool-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;';

    const box = document.createElement('div');
    box.style.cssText = 'background:#1a1a2e;border:1px solid #2a2a5a;border-radius:14px;padding:24px;width:580px;max-height:80vh;overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,0.7);';

    const _renderPoolUI = () => {
        const pool = task.bgClipPool;
        task.bgClipActivePool = Array.isArray(task.bgClipActivePool)
            ? task.bgClipActivePool.filter(p => pool.includes(p))
            : [];
        const activeSet = new Set(task.bgClipActivePool || []);
        const activeAll = activeSet.size === 0;
        const activeCount = activeAll ? pool.length : activeSet.size;
        const thumbsHtml = pool.map((p, i) => {
            const name = p.replace(/\\/g, '/').split('/').pop();
            const url = _rbtMediaUrl(p);
            const isImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(p);
            const checked = activeAll || activeSet.has(p);
            return `<div class="bgpool-item" data-file-path="${_escHtml(p)}" title="右键打开文件所在位置: ${_escHtml(p)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:#12122e;border:1px solid #2a2a4a;border-radius:6px;cursor:context-menu;">
                <input type="checkbox" class="bgpool-use-check" data-pool-idx="${i}" ${checked ? 'checked' : ''}
                    title="勾选后参与随机/顺序组合" style="accent-color:#7c5cff;flex-shrink:0;">
                ${isImg
                    ? `<img class="rbt-thumb-previewable" src="${_escHtml(url)}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;cursor:zoom-in;">`
                    : `<video class="rbt-thumb-previewable" src="${_escHtml(url)}#t=1" preload="metadata" style="width:40px;height:40px;object-fit:cover;border-radius:4px;background:#000;cursor:zoom-in;"></video>`
                }
                <span style="flex:1;font-size:11px;color:#ccc;word-break:break-all;" title="${_escHtml(p)}">${_escHtml(name)}</span>
                <button class="bgpool-reveal" data-file-path="${_escHtml(p)}" title="打开文件所在位置" style="width:22px;height:20px;border:1px solid #444;border-radius:4px;background:transparent;color:#8af;font-size:11px;cursor:pointer;padding:0;line-height:18px;" onclick="event.stopPropagation();window.electronAPI?.showItemInFolder?.(this.dataset.filePath)">📂</button>
                <button class="bgpool-remove" data-pool-idx="${i}" style="width:20px;height:20px;border:1px solid #444;border-radius:4px;background:transparent;color:#f87171;font-size:12px;cursor:pointer;padding:0;line-height:18px;">✕</button>
            </div>`;
        }).join('');

        box.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <div style="font-size:15px;font-weight:700;color:#ddd;">🎞 多素材背景池 — 第 ${taskIdx + 1} 行</div>
                <button id="bgpool-close" style="width:28px;height:28px;border-radius:6px;border:1px solid #444;background:transparent;color:#aaa;font-size:14px;cursor:pointer;">✕</button>
            </div>

            <!-- 模式切换 -->
            <div style="display:flex;gap:8px;margin-bottom:14px;">
                <button class="bgpool-mode-btn" data-mode="single" style="flex:1;padding:8px;border-radius:6px;border:1px solid ${task.bgMode === 'single' ? 'var(--accent)' : '#333'};background:${task.bgMode === 'single' ? 'rgba(78,205,196,0.15)' : '#12122e'};color:${task.bgMode === 'single' ? 'var(--accent)' : '#888'};font-size:12px;cursor:pointer;font-weight:600;">
                    🔁 单素材循环<br><span style="font-size:10px;font-weight:400;">一个背景视频/图片循环播放</span>
                </button>
                <button class="bgpool-mode-btn" data-mode="multi" style="flex:1;padding:8px;border-radius:6px;border:1px solid ${task.bgMode === 'multi' ? '#b8a0ff' : '#333'};background:${task.bgMode === 'multi' ? 'rgba(100,60,200,0.15)' : '#12122e'};color:${task.bgMode === 'multi' ? '#b8a0ff' : '#888'};font-size:12px;cursor:pointer;font-weight:600;">
                    🎞 多素材拼接<br><span style="font-size:10px;font-weight:400;">从素材池随机组合，自动匹配时长</span>
                </button>
            </div>

            ${task.bgMode === 'multi' ? `
            <!-- 转场设置 -->
            <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;padding:10px;background:#12122e;border:1px solid #2a2a4a;border-radius:8px;flex-wrap:wrap;">
                <span style="font-size:11px;color:#aaa;white-space:nowrap;">组合方式:</span>
                <select id="bgpool-clip-order" style="width:110px;padding:4px 8px;font-size:11px;background:#1e1e38;color:#ccc;border:1px solid #333;border-radius:4px;outline:none;">
                    <option value="random" ${(task.bgClipOrder || 'random') === 'random' ? 'selected' : ''}>🎲 随机组合</option>
                    <option value="sequence" ${task.bgClipOrder === 'sequence' ? 'selected' : ''}>↧ 顺序组合</option>
                    <option value="random_align" ${task.bgClipOrder === 'random_align' ? 'selected' : ''}>⚡ 随机 (台词卡点)</option>
                    <option value="sequence_align" ${task.bgClipOrder === 'sequence_align' ? 'selected' : ''}>🔗 顺序 (台词卡点)</option>
                </select>
                <span style="font-size:11px;color:#aaa;white-space:nowrap;">转场效果:</span>
                <select id="bgpool-transition" style="flex:1;padding:4px 8px;font-size:11px;background:#1e1e38;color:#ccc;border:1px solid #333;border-radius:4px;outline:none;">
                    <option value="none" ${task.bgTransition === 'none' ? 'selected' : ''}>⚡ 无转场（硬切）</option>
                    <option value="crossfade" ${task.bgTransition === 'crossfade' ? 'selected' : ''}>✨ 交叉淡化</option>
                    <option value="fade_black" ${task.bgTransition === 'fade_black' ? 'selected' : ''}>⬛ 黑场过渡</option>
                    <option value="fade_white" ${task.bgTransition === 'fade_white' ? 'selected' : ''}>⬜ 白场过渡</option>
                    <option value="slide_left" ${task.bgTransition === 'slide_left' ? 'selected' : ''}>◀ 左滑入</option>
                    <option value="slide_right" ${task.bgTransition === 'slide_right' ? 'selected' : ''}>▶ 右滑入</option>
                    <option value="wipe" ${task.bgTransition === 'wipe' ? 'selected' : ''}>🔲 擦除</option>
                </select>
                <span style="font-size:11px;color:#aaa;white-space:nowrap;">时长:</span>
                <input type="number" id="bgpool-trans-dur" min="0.1" max="3" step="0.1" value="${task.bgTransDur || 0.5}"
                    style="width:55px;padding:4px;font-size:11px;background:#1e1e38;color:#ccc;border:1px solid #333;border-radius:4px;text-align:center;">
                <span style="font-size:10px;color:#666;">秒</span>
            </div>

            <!-- 卡点片段时长限制 -->
            <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;padding:10px;background:#12122e;border:1px solid #2a2a4a;border-radius:8px;flex-wrap:wrap;">
                <span style="font-size:11px;color:#aaa;white-space:nowrap;">卡点切片限制:</span>
                <span style="font-size:11px;color:#888;">最小时长</span>
                <input type="number" id="bgpool-min-clip-dur" min="0" max="60" step="0.5" value="${task.bgMinClipDur !== undefined ? task.bgMinClipDur : 5}"
                    style="width:50px;padding:4px;font-size:11px;background:#1e1e38;color:#ccc;border:1px solid #333;border-radius:4px;text-align:center;">
                <span style="font-size:10px;color:#666;">秒</span>
                
                <span style="font-size:11px;color:#888;margin-left:8px;">最大时长</span>
                <input type="number" id="bgpool-max-clip-dur" min="0" max="600" step="1" value="${task.bgMaxClipDur !== undefined ? task.bgMaxClipDur : 7}"
                    style="width:50px;padding:4px;font-size:11px;background:#1e1e38;color:#ccc;border:1px solid #333;border-radius:4px;text-align:center;">
                <span style="font-size:10px;color:#666;">秒</span>
                <span style="font-size:10px;color:#555;">(最大设为0代表不限制最大时长)</span>
            </div>

            <!-- 素材池列表 -->
            <div style="margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="font-size:12px;color:#aaa;font-weight:600;">素材池 (${pool.length}个 / 启用 ${activeCount} 个)</span>
                    <div style="display:flex;gap:6px;">
                        <button id="bgpool-use-all" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid #444;background:#1e1e38;color:#ccc;cursor:pointer;">全用</button>
                        <button id="bgpool-add-folder" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid #444;background:#1e1e38;color:#8af;cursor:pointer;">📂 从文件夹导入</button>
                        <button id="bgpool-add-files" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid #444;background:#1e1e38;color:#8af;cursor:pointer;">📄 选择文件</button>
                        <button id="bgpool-clear-all" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid #553333;background:transparent;color:#f87171;cursor:pointer;">🗑 清空</button>
                    </div>
                </div>
                <div id="bgpool-list" style="display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto;padding-right:4px;">
                    ${thumbsHtml || '<div style="text-align:center;padding:24px;color:#555;font-size:12px;">暂无素材，请从文件夹导入或拖拽文件到此处</div>'}
                </div>
            </div>

            <!-- 拖拽区域 -->
            <div id="bgpool-dropzone" style="border:2px dashed #333;border-radius:8px;padding:16px;text-align:center;color:#555;font-size:11px;margin-bottom:14px;transition:border-color .2s,color .2s;">
                🎬 拖拽视频/图片文件到此处添加到素材池
            </div>

            <!-- 批量应用 -->
            <div style="padding:10px;background:#12122e;border:1px solid #2a2a4a;border-radius:8px;margin-bottom:14px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:11px;color:#aaa;">批量应用:</span>
                    <button id="bgpool-current-only" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid #444;background:#1e1e38;color:#ccc;cursor:pointer;">仅当前行使用勾选</button>
                    <button id="bgpool-apply-selected" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid #444;background:#1e1e38;color:#ccc;cursor:pointer;">📋 勾选素材应用到勾选行</button>
                    <button id="bgpool-apply-all" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid #444;background:#1e1e38;color:#ccc;cursor:pointer;">📋 勾选素材应用到所有行</button>
                </div>
            </div>
            ` : ''}

            <div style="display:flex;justify-content:flex-end;gap:8px;">
                <button id="bgpool-done" style="padding:6px 20px;border-radius:6px;border:none;background:var(--accent);color:#000;font-weight:600;font-size:12px;cursor:pointer;">完成</button>
            </div>

            <input type="file" id="bgpool-file-input" multiple accept="video/*,image/*" style="display:none;">
            <input type="file" id="bgpool-folder-input" webkitdirectory style="display:none;">
        `;

        // ── Events ──
        box.querySelector('#bgpool-close')?.addEventListener('click', () => {
            _refreshBgPoolPreview();
            overlay.remove();
        });
        box.querySelector('#bgpool-done')?.addEventListener('click', () => {
            _refreshBgPoolPreview();
            overlay.remove();
        });

        // Mode switch
        box.querySelectorAll('.bgpool-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                task.bgMode = btn.dataset.mode;
                _renderPoolUI();
            });
        });

        // Transition settings
        box.querySelector('#bgpool-clip-order')?.addEventListener('change', (e) => {
            task.bgClipOrder = e.target.value || 'random';
        });
        box.querySelector('#bgpool-transition')?.addEventListener('change', (e) => {
            task.bgTransition = e.target.value;
        });
        box.querySelector('#bgpool-trans-dur')?.addEventListener('change', (e) => {
            task.bgTransDur = Math.max(0.1, Math.min(3, parseFloat(e.target.value) || 0.5));
        });
        box.querySelector('#bgpool-min-clip-dur')?.addEventListener('change', (e) => {
            task.bgMinClipDur = Math.max(0, parseFloat(e.target.value) || 0);
        });
        box.querySelector('#bgpool-max-clip-dur')?.addEventListener('change', (e) => {
            task.bgMaxClipDur = Math.max(0, parseFloat(e.target.value) || 0);
        });

        box.querySelectorAll('.bgpool-use-check').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const checkedPaths = Array.from(box.querySelectorAll('.bgpool-use-check:checked'))
                    .map(el => task.bgClipPool[parseInt(el.dataset.poolIdx)])
                    .filter(Boolean);
                if (checkedPaths.length === 0) {
                    e.target.checked = true;
                    task.bgClipActivePool = [task.bgClipPool[parseInt(e.target.dataset.poolIdx)]].filter(Boolean);
                } else if (checkedPaths.length === task.bgClipPool.length) {
                    task.bgClipActivePool = [];
                } else {
                    task.bgClipActivePool = checkedPaths;
                }
                _renderPoolUI();
            });
        });

        box.querySelector('#bgpool-use-all')?.addEventListener('click', () => {
            task.bgClipActivePool = [];
            _renderPoolUI();
        });

        // Remove clip
        box.querySelectorAll('.bgpool-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const pi = parseInt(btn.dataset.poolIdx);
                const removed = task.bgClipPool[pi];
                task.bgClipPool.splice(pi, 1);
                task.bgClipActivePool = (task.bgClipActivePool || []).filter(p => p !== removed);
                _renderPoolUI();
            });
        });

        // Add files
        const fileInput = box.querySelector('#bgpool-file-input');
        box.querySelector('#bgpool-add-files')?.addEventListener('click', () => fileInput?.click());
        fileInput?.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            for (const f of files) {
                const path = typeof getFileNativePath === 'function' ? getFileNativePath(f) : (f.path || f.name);
                if (path && !task.bgClipPool.includes(path)) task.bgClipPool.push(path);
            }
            e.target.value = '';
            _renderPoolUI();
        });

        // Add folder
        const folderInput = box.querySelector('#bgpool-folder-input');
        box.querySelector('#bgpool-add-folder')?.addEventListener('click', () => folderInput?.click());
        folderInput?.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            const mediaExt = /\.(mp4|mov|avi|mkv|webm|jpg|jpeg|png|webp|gif|bmp)$/i;
            for (const f of files) {
                if (!mediaExt.test(f.name)) continue;
                const path = typeof getFileNativePath === 'function' ? getFileNativePath(f) : (f.path || f.name);
                if (path && !task.bgClipPool.includes(path)) task.bgClipPool.push(path);
            }
            e.target.value = '';
            _renderPoolUI();
        });

        // Clear all
        box.querySelector('#bgpool-clear-all')?.addEventListener('click', () => {
            if (confirm('确定清空所有素材？')) {
                task.bgClipPool = [];
                task.bgClipActivePool = [];
                task.bgClipOrder = 'random';
                _renderPoolUI();
            }
        });

        // Drag & drop zone
        const dropzone = box.querySelector('#bgpool-dropzone');
        if (dropzone) {
            dropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropzone.style.borderColor = '#b8a0ff';
                dropzone.style.color = '#b8a0ff';
            });
            dropzone.addEventListener('dragleave', () => {
                dropzone.style.borderColor = '#333';
                dropzone.style.color = '#555';
            });
            dropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropzone.style.borderColor = '#333';
                dropzone.style.color = '#555';
                const files = Array.from(e.dataTransfer.files);
                const mediaExt = /\.(mp4|mov|avi|mkv|webm|jpg|jpeg|png|webp|gif|bmp)$/i;
                for (const f of files) {
                    if (!mediaExt.test(f.name)) continue;
                    const path = typeof getFileNativePath === 'function' ? getFileNativePath(f) : (f.path || f.name);
                    if (path && !task.bgClipPool.includes(path)) task.bgClipPool.push(path);
                }
                _renderPoolUI();
            });
        }

        // Batch apply
        const _applyPoolToTask = (targetTask) => {
            targetTask.bgMode = task.bgMode;
            targetTask.bgClipPool = [...task.bgClipPool];
            targetTask.bgClipActivePool = [...(task.bgClipActivePool || [])];
            targetTask.bgClipOrder = task.bgClipOrder || 'random';
            targetTask.bgTransition = task.bgTransition;
            targetTask.bgTransDur = task.bgTransDur;
            targetTask.bgClipSettings = JSON.parse(JSON.stringify(task.bgClipSettings || {}));
            targetTask.bgMinClipDur = task.bgMinClipDur;
            targetTask.bgMaxClipDur = task.bgMaxClipDur;
        };

        box.querySelector('#bgpool-current-only')?.addEventListener('click', () => {
            _refreshBgPoolPreview();
            if (typeof showToast === 'function') showToast(`✅ 当前行将仅使用启用的 ${activeCount} 个素材`, 'success');
        });

        box.querySelector('#bgpool-apply-selected')?.addEventListener('click', () => {
            const indices = _getSelectedIndices();
            if (indices.length === 0) { alert('请先勾选要应用的行'); return; }
            for (const i of indices) {
                if (i !== taskIdx && state.tasks[i]) _applyPoolToTask(state.tasks[i]);
            }
            _refreshBgPoolPreview();
            if (typeof showToast === 'function') showToast(`✅ 素材池已应用到 ${indices.length} 行`, 'success');
        });

        box.querySelector('#bgpool-apply-all')?.addEventListener('click', () => {
            for (let i = 0; i < state.tasks.length; i++) {
                if (i !== taskIdx) _applyPoolToTask(state.tasks[i]);
            }
            _refreshBgPoolPreview();
            if (typeof showToast === 'function') showToast(`✅ 素材池已应用到全部 ${state.tasks.length} 行`, 'success');
        });
    };

    _renderPoolUI();
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Click outside to close
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            _refreshBgPoolPreview();
            overlay.remove();
        }
    });
}
window.reelsShowBgPoolDialog = _showBgPoolDialog;

function _showBgmPoolDialog(taskIdx) {
    const state = window._reelsState;
    if (!state || !state.tasks[taskIdx]) return;
    const task = state.tasks[taskIdx];

    // Init fields if missing
    if (!task.bgmClipPool) task.bgmClipPool = [];
    if (!task.bgmClipOrder) task.bgmClipOrder = 'random';
    if (!Array.isArray(task.bgmClipActivePool)) task.bgmClipActivePool = [];
    if (!task.bgmMode) task.bgmMode = task.bgmClipPool.length > 0 ? 'multi' : 'single';

    const _refreshBgmPoolPreview = () => {
        _renderBatchTable();
        const selectedIdx = window._reelsState ? window._reelsState.selectedIdx : -1;
        const selectedTask = selectedIdx >= 0 ? state.tasks[selectedIdx] : null;
        if (selectedTask && window.reelsSyncBackgroundTabUI) {
            window.reelsSyncBackgroundTabUI(selectedTask);
        }
        if (selectedIdx >= 0 && typeof window.reelsSelectTask === 'function') {
            window.reelsSelectTask(selectedIdx);
        } else if (typeof reelsUpdatePreview === 'function') {
            reelsUpdatePreview();
        }
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    };

    // 试听控制
    if (window._activePreviewBgmAudio) {
        window._activePreviewBgmAudio.pause();
        window._activePreviewBgmAudio = null;
    }

    const _togglePlayAudio = (btn, filePath) => {
        const url = _rbtMediaUrl(filePath);
        if (window._activePreviewBgmAudio && window._activePreviewBgmAudio._path === filePath) {
            if (window._activePreviewBgmAudio.paused) {
                window._activePreviewBgmAudio.play().catch(err => console.error(err));
                btn.textContent = '⏸';
                btn.style.color = '#e0b3ff';
            } else {
                window._activePreviewBgmAudio.pause();
                btn.textContent = '▶';
                btn.style.color = '#ccc';
            }
            return;
        }

        // 停止之前的播放
        if (window._activePreviewBgmAudio) {
            const prevBtn = document.querySelector(`.bgmpool-play-btn[data-path="${CSS.escape(window._activePreviewBgmAudio._path)}"]`);
            if (prevBtn) {
                prevBtn.textContent = '▶';
                prevBtn.style.color = '#ccc';
            }
            window._activePreviewBgmAudio.pause();
        }

        const audio = new Audio(url);
        audio._path = filePath;
        audio.play().catch(err => {
            console.error('试听播放失败:', err);
            alert('试听播放失败，可能由于音频格式或文件不存在。');
        });
        btn.textContent = '⏸';
        btn.style.color = '#e0b3ff';
        window._activePreviewBgmAudio = audio;

        audio.onended = () => {
            btn.textContent = '▶';
            btn.style.color = '#ccc';
            window._activePreviewBgmAudio = null;
        };
    };

    document.getElementById('rbt-bgmpool-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'rbt-bgmpool-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;';

    const box = document.createElement('div');
    box.style.cssText = 'background:#19122a;border:1px solid #4a2a6a;border-radius:14px;padding:24px;width:580px;max-height:80vh;overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,0.7);';

    const _renderBgmPoolUI = () => {
        const pool = task.bgmClipPool;
        task.bgmClipActivePool = Array.isArray(task.bgmClipActivePool)
            ? task.bgmClipActivePool.filter(p => pool.includes(p))
            : [];
        const activeSet = new Set(task.bgmClipActivePool || []);
        const activeAll = activeSet.size === 0;
        const activeCount = activeAll ? pool.length : activeSet.size;

        const thumbsHtml = pool.map((p, i) => {
            const name = p.replace(/\\/g, '/').split('/').pop();
            const checked = activeAll || activeSet.has(p);
            const isPlaying = window._activePreviewBgmAudio && window._activePreviewBgmAudio._path === p && !window._activePreviewBgmAudio.paused;
            return `<div class="bgmpool-item" data-file-path="${_escHtml(p)}" title="右键打开文件所在位置: ${_escHtml(p)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:#120e24;border:1px solid #3c2356;border-radius:6px;cursor:context-menu;">
                <input type="checkbox" class="bgmpool-use-check" data-pool-idx="${i}" ${checked ? 'checked' : ''}
                    title="勾选后参与随机/顺序挑选" style="accent-color:#9b59b6;flex-shrink:0;">
                <button class="bgmpool-play-btn" data-path="${_escHtml(p)}" style="width:24px;height:24px;border:1px solid #5a3a7f;border-radius:50%;background:#1e1438;color:${isPlaying ? '#e0b3ff' : '#ccc'};font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:22px;">${isPlaying ? '⏸' : '▶'}</button>
                <span style="flex:1;font-size:11px;color:#ccc;word-break:break-all;" title="${_escHtml(p)}">${_escHtml(name)}</span>
                <button class="bgmpool-reveal" data-file-path="${_escHtml(p)}" title="打开文件所在位置" style="width:22px;height:20px;border:1px solid #555;border-radius:4px;background:transparent;color:#e0b3ff;font-size:11px;cursor:pointer;padding:0;line-height:18px;" onclick="event.stopPropagation();window.electronAPI?.showItemInFolder?.(this.dataset.filePath)">📂</button>
                <button class="bgmpool-remove" data-pool-idx="${i}" style="width:20px;height:20px;border:1px solid #555;border-radius:4px;background:transparent;color:#f87171;font-size:12px;cursor:pointer;padding:0;line-height:18px;">✕</button>
            </div>`;
        }).join('');

        box.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <div style="font-size:15px;font-weight:700;color:#e0b3ff;display:flex;align-items:center;gap:6px;">🎵 多素材配乐池 — 第 ${taskIdx + 1} 行</div>
                <button id="bgmpool-close" style="width:28px;height:28px;border-radius:6px;border:1px solid #555;background:transparent;color:#aaa;font-size:14px;cursor:pointer;">✕</button>
            </div>

            <!-- 模式切换 -->
            <div style="display:flex;gap:8px;margin-bottom:14px;">
                <button class="bgmpool-mode-btn" data-mode="single" style="flex:1;padding:8px;border-radius:6px;border:1px solid ${task.bgmMode === 'single' ? '#9b59b6' : '#333'};background:${task.bgmMode === 'single' ? 'rgba(155,89,182,0.15)' : '#120e24'};color:${task.bgmMode === 'single' ? '#e0b3ff' : '#888'};font-size:12px;cursor:pointer;font-weight:600;">
                    🔁 单首配乐模式<br><span style="font-size:10px;font-weight:400;">此行固定播放所选的单一配乐</span>
                </button>
                <button class="bgmpool-mode-btn" data-mode="multi" style="flex:1;padding:8px;border-radius:6px;border:1px solid ${task.bgmMode === 'multi' ? '#9b59b6' : '#333'};background:${task.bgmMode === 'multi' ? 'rgba(155,89,182,0.2)' : '#120e24'};color:${task.bgmMode === 'multi' ? '#e0b3ff' : '#888'};font-size:12px;cursor:pointer;font-weight:600;">
                    🎵 多首配乐池模式<br><span style="font-size:10px;font-weight:400;">导出多视频时按规则轮流/随机选择配乐</span>
                </button>
            </div>

            ${task.bgmMode === 'multi' ? `
            <!-- 选取方式设置 -->
            <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;padding:10px;background:#120e24;border:1px solid #3c2356;border-radius:8px;">
                <span style="font-size:11px;color:#aaa;white-space:nowrap;">选取规则:</span>
                <select id="bgmpool-clip-order" style="flex:1;padding:4px 8px;font-size:11px;background:#1e1438;color:#ccc;border:1px solid #4a2a6a;border-radius:4px;outline:none;">
                    <option value="random" ${(task.bgmClipOrder || 'random') === 'random' ? 'selected' : ''}>🎲 随机挑选一首（批量多行时错开）</option>
                    <option value="sequence" ${task.bgmClipOrder === 'sequence' ? 'selected' : ''}>↧ 顺序/轮流挑选（按行索引循环分配）</option>
                </select>
            </div>

            <!-- 配乐池列表 -->
            <div style="margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <div style="font-size:12px;font-weight:700;color:#aaa;">配乐列表 (${pool.length} 首，已启用 ${activeCount} 首)：</div>
                    <div style="display:flex;gap:6px;">
                        <button id="bgmpool-add" style="padding:2px 8px;font-size:11px;background:#9b59b6;color:#fff;border:none;border-radius:4px;cursor:pointer;">+ 添加本地配乐</button>
                        <button id="bgmpool-clear" style="padding:2px 8px;font-size:11px;background:transparent;color:#f87171;border:1px solid #5a2e2e;border-radius:4px;cursor:pointer;">清空</button>
                    </div>
                </div>

                <div id="bgmpool-list-container" style="display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto;padding-right:4px;">
                    ${thumbsHtml || '<div style="text-align:center;padding:24px 0;color:#555;font-size:11px;">配乐池暂无素材，请点击上方“添加”或拖入音频</div>'}
                </div>
            </div>

            <!-- 应用规则 -->
            <div style="margin-top:16px;border-top:1px solid #2a1f4a;padding-top:14px;">
                <div style="font-size:11px;color:#888;margin-bottom:8px;">批量操作配乐池：</div>
                <div style="display:flex;gap:6px;justify-content:flex-end;">
                    <button id="bgmpool-current-only" class="btn btn-secondary" style="font-size:11px;padding:5px 10px;" title="仅保存并关闭弹窗">确定</button>
                    <button id="bgmpool-apply-selected" class="btn btn-secondary" style="font-size:11px;padding:5px 10px;background:rgba(155,89,182,0.12);border-color:#5a2e7f;" title="把当前配乐池配置应用到所有勾选的行">应用到勾选行</button>
                    <button id="bgmpool-apply-all" class="btn btn-secondary" style="font-size:11px;padding:5px 10px;background:rgba(155,89,182,0.2);border-color:#5a2e7f;font-weight:600;" title="把当前配乐池配置应用到表格中的所有行">应用到全部行</button>
                </div>
            </div>
            ` : `
            <div style="padding:24px 0;text-align:center;color:#888;font-size:11px;">
                当前已启用单个固定配乐模式。<br>
                您可以在主表上双击或拖拽来为该行设置专属配乐。<br>
                若需使用多配乐随机分配，请点击上方“多首配乐池模式”。
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:14px;border-top:1px solid #2a1f4a;padding-top:14px;">
                <button id="bgmpool-current-only" class="btn btn-secondary" style="font-size:11px;padding:5px 12px;">确定</button>
            </div>
            `}
        `;

        // 重新绑定列表事件
        box.querySelectorAll('.bgmpool-play-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                _togglePlayAudio(btn, btn.dataset.path);
            });
        });

        box.querySelectorAll('.bgmpool-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const pi = parseInt(btn.dataset.poolIdx);
                task.bgmClipPool.splice(pi, 1);
                _renderBgmPoolUI();
            });
        });

        box.querySelectorAll('.bgmpool-use-check').forEach(chk => {
            chk.addEventListener('change', () => {
                const pi = parseInt(chk.dataset.poolIdx);
                const path = task.bgmClipPool[pi];
                if (!Array.isArray(task.bgmClipActivePool)) task.bgmClipActivePool = [];
                if (chk.checked) {
                    if (!task.bgmClipActivePool.includes(path)) task.bgmClipActivePool.push(path);
                } else {
                    task.bgmClipActivePool = task.bgmClipActivePool.filter(p => p !== path);
                }
            });
        });

        // 模式切换
        box.querySelectorAll('.bgmpool-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                task.bgmMode = btn.dataset.mode;
                _renderBgmPoolUI();
            });
        });

        // 选取规则切换
        const orderSel = box.querySelector('#bgmpool-clip-order');
        if (orderSel) {
            orderSel.addEventListener('change', (e) => {
                task.bgmClipOrder = e.target.value;
            });
        }

        // 清空列表
        const clearBtn = box.querySelector('#bgmpool-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (confirm('确认清空当前配乐池吗？')) {
                    task.bgmClipPool = [];
                    task.bgmClipActivePool = [];
                    _renderBgmPoolUI();
                }
            });
        }

        // 添加本地配乐
        const addBtn = box.querySelector('#bgmpool-add');
        if (addBtn) {
            addBtn.addEventListener('click', async () => {
                if (!window.electronAPI || !window.electronAPI.selectFiles) {
                    alert('请在桌面端应用中使用此功能');
                    return;
                }
                const filePaths = await window.electronAPI.selectFiles({
                    title: '添加配乐文件',
                    filters: [
                        { name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }
                    ],
                    properties: ['openFile', 'multiSelections']
                });
                if (filePaths && filePaths.length > 0) {
                    filePaths.forEach(p => {
                        if (!task.bgmClipPool.includes(p)) task.bgmClipPool.push(p);
                    });
                    _renderBgmPoolUI();
                }
            });
        }

        // 批量复制函数
        const _applyBgmPoolToTask = (targetTask) => {
            targetTask.bgmMode = 'multi';
            targetTask.bgmClipPool = [...(task.bgmClipPool || [])];
            targetTask.bgmClipActivePool = [...(task.bgmClipActivePool || [])];
            targetTask.bgmClipOrder = task.bgmClipOrder || 'random';
        };

        box.querySelector('#bgmpool-current-only')?.addEventListener('click', () => {
            if (window._activePreviewBgmAudio) {
                window._activePreviewBgmAudio.pause();
                window._activePreviewBgmAudio = null;
            }
            _refreshBgmPoolPreview();
            overlay.remove();
        });

        box.querySelector('#bgmpool-apply-selected')?.addEventListener('click', () => {
            const indices = _getSelectedIndices();
            if (indices.length === 0) { alert('请先勾选要应用的行'); return; }
            for (const i of indices) {
                if (i !== taskIdx && state.tasks[i]) _applyBgmPoolToTask(state.tasks[i]);
            }
            if (window._activePreviewBgmAudio) {
                window._activePreviewBgmAudio.pause();
                window._activePreviewBgmAudio = null;
            }
            _refreshBgmPoolPreview();
            overlay.remove();
            if (typeof showToast === 'function') showToast(`✅ 配乐池已成功应用到 ${indices.length} 行`, 'success');
        });

        box.querySelector('#bgmpool-apply-all')?.addEventListener('click', () => {
            for (let i = 0; i < state.tasks.length; i++) {
                if (i !== taskIdx) _applyBgmPoolToTask(state.tasks[i]);
            }
            if (window._activePreviewBgmAudio) {
                window._activePreviewBgmAudio.pause();
                window._activePreviewBgmAudio = null;
            }
            _refreshBgmPoolPreview();
            overlay.remove();
            if (typeof showToast === 'function') showToast(`✅ 配乐池已应用到全部 ${state.tasks.length} 行`, 'success');
        });
    };

    _renderBgmPoolUI();
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const closeBtn = box.querySelector('#bgmpool-close') || document.getElementById('bgmpool-close');
    closeBtn?.addEventListener('click', () => {
        if (window._activePreviewBgmAudio) {
            window._activePreviewBgmAudio.pause();
            window._activePreviewBgmAudio = null;
        }
        _refreshBgmPoolPreview();
        overlay.remove();
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            if (window._activePreviewBgmAudio) {
                window._activePreviewBgmAudio.pause();
                window._activePreviewBgmAudio = null;
            }
            _refreshBgmPoolPreview();
            overlay.remove();
        }
    });

    // 拖放添加文件到弹窗配乐池支持
    box.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });
    box.addEventListener('drop', async (e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length > 0) {
            const audioExts = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']);
            const added = [];
            for (const f of files) {
                const ext = (f.name || '').split('.').pop().toLowerCase();
                if (audioExts.has(ext)) {
                    let fpath = f.path;
                    if (!fpath && window.electronAPI && window.electronAPI.getFilePath) {
                        try { fpath = window.electronAPI.getFilePath(f); } catch (_) {}
                    }
                    fpath = fpath || f.name;
                    if (fpath && !task.bgmClipPool.includes(fpath)) {
                        task.bgmClipPool.push(fpath);
                        added.push(fpath);
                    }
                }
            }
            if (added.length > 0) {
                _renderBgmPoolUI();
            }
        }
    });
}
window.reelsShowBgmPoolDialog = _showBgmPoolDialog;
window.reelsPickClipPool = _rbtPickClipPool;
window.reelsConcatTaskClipPool = _rbtConcatTaskClipPool;

function _setTaskSingleBackground(task, filePath, options = {}) {
    if (!task) return;
    const path = filePath || '';
    const detectImage = options.detectImage === true;
    const isImage = detectImage && /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(path);

    task.bgPath = path;
    task.videoPath = isImage ? '' : path;
    if (Object.prototype.hasOwnProperty.call(options, 'bgSrcUrl')) {
        task.bgSrcUrl = options.bgSrcUrl;
    } else if (options.clearBgSrcUrl) {
        task.bgSrcUrl = '';
    }

    task.bgMode = 'single';
    task.bgClipPool = [];
    task.bgClipActivePool = [];
    task.bgClipOrder = 'random';
}

// ═══════════════════════════════════════════════════════
// Cycle Fill — 循环填充素材（加权交错分配）
// ═══════════════════════════════════════════════════════

function _showCycleFillDialog() {
    const state = window._reelsState;
    if (!state) return;
    const tasks = state.tasks || [];

    // 移除已有弹窗
    document.getElementById('rbt-cycle-fill-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'rbt-cycle-fill-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e2e;border:1px solid #333;border-radius:14px;padding:24px;min-width:480px;max-width:600px;max-height:80vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,0.6);';

    // 收集已有素材（去重）
    const existingBg = [...new Set(tasks.map(t => t.bgPath || t.videoPath).filter(Boolean))];
    const existingAudio = [...new Set(tasks.map(t => t.audioPath).filter(Boolean))];
    const existingBgm = [...new Set(tasks.map(t => t.bgmPath).filter(Boolean))];

    // 文件扩展名映射
    const EXT_MAP = {
        bg: new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']),
        audio: new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm']),
        bgm: new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']),
    };

    const fieldOptions = [
        { key: 'bg', label: '🖼 背景素材', items: [...existingBg], origItems: existingBg },
        { key: 'audio', label: '🔊 人声-音频文件', items: [...existingAudio], origItems: existingAudio },
        { key: 'bgm', label: '🎵 配乐', items: [...existingBgm], origItems: existingBgm },
    ];

    // 素材池持久化
    const POOL_STORAGE_KEY = 'rbt-cycle-pool';
    function _loadSavedPool() {
        try { return JSON.parse(localStorage.getItem(POOL_STORAGE_KEY) || '{}'); } catch (e) { return {}; }
    }
    function _savePool(fieldKey, paths) {
        const pools = _loadSavedPool();
        pools[fieldKey] = paths;
        localStorage.setItem(POOL_STORAGE_KEY, JSON.stringify(pools));
    }

    let selectedField = fieldOptions.find(f => f.items.length > 0)?.key || 'bg';
    let sourceMode = 'existing'; // 'existing' | 'folder'

    // 如果有已保存的素材池，自动切换到 folder 模式
    const savedPools = _loadSavedPool();
    if (savedPools[selectedField] && savedPools[selectedField].length > 0) {
        sourceMode = 'folder';
        const field = fieldOptions.find(f => f.key === selectedField);
        if (field) field.items = savedPools[selectedField];
    }

    function _shortN(p) { return (p || '').replace(/\\/g, '/').split('/').pop() || ''; }

    // 隐藏文件选择器
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        const exts = EXT_MAP[selectedField];
        const paths = files
            .filter(f => exts.has((f.name || '').split('.').pop().toLowerCase()))
            .map(f => (typeof getFileNativePath === 'function') ? getFileNativePath(f) : (f.path || f.name))
            .filter(p => {
                // 必须是绝对路径，防止仅存文件名导致 FFmpeg 找不到文件
                if (!p || (!p.startsWith('/') && !/^[A-Z]:\\/i.test(p))) {
                    console.warn('[CycleFill] 跳过无完整路径的文件:', p);
                    return false;
                }
                return true;
            });
        if (paths.length === 0) {
            alert('所选文件中没有匹配该字段类型的文件');
            return;
        }
        const field = fieldOptions.find(f => f.key === selectedField);
        if (field) {
            field.items = paths;
            _savePool(selectedField, paths); // 保存到 localStorage
            renderContent();
        }
        e.target.value = '';
    });
    box.appendChild(fileInput);

    function renderContent() {
        const field = fieldOptions.find(f => f.key === selectedField);
        const items = field ? field.items : [];
        const totalRows = tasks.length || 0;
        const emptyRows = field ? tasks.filter(t => {
            if (field.key === 'bg') {
                const hasMultiBg = t.bgMode === 'multi'
                    && Array.isArray(t.bgClipPool)
                    && t.bgClipPool.some(Boolean);
                return !hasMultiBg && !t.bgPath && !t.videoPath;
            }
            if (field.key === 'audio') return !t.audioPath;
            if (field.key === 'bgm') return !t.bgmPath;
            return true;
        }).length : 0;

        // 保留fileInput
        const existingFileInput = box.querySelector('input[type="file"]');

        box.innerHTML = `
            <div style="font-size:16px;font-weight:700;margin-bottom:16px;color:var(--accent);">🔄 素材使用与分配设置</div>

            <!-- Global Setting Block (Moved from main UI) -->
            <div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:16px; padding:10px; background:rgba(255,255,255,0.05); border-radius:8px; border:1px solid rgba(255,255,255,0.1);">
                <button class="rbt-btn" id="rbt-cf-upload-hook">🪝 设置钩子视频 (Hook)</button>
                <div style="width:1px; height:20px; background:rgba(255,255,255,0.2);"></div>
                <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#ccc;cursor:pointer;">
                    <input type="checkbox" id="rbt-cf-video-drop-route-enabled" ${_batchTableState.videoDropRouteEnabled ? 'checked' : ''} style="accent-color:var(--accent);">
                    视频分配模式：
                </label>
                <select id="rbt-cf-video-drop-route-mode" class="rbt-select" style="height:26px;padding:0 6px;${_batchTableState.videoDropRouteEnabled ? '' : 'opacity:.5;'}" ${_batchTableState.videoDropRouteEnabled ? '' : 'disabled'}>
                    <option value="hook" ${_batchTableState.videoDropRouteMode === 'hook' ? 'selected' : ''}>🪝 分配到前置Hook</option>
                    <option value="bg" ${_batchTableState.videoDropRouteMode === 'bg' ? 'selected' : ''}>🎬 分配到背景层</option>
                    <option value="audio" ${_batchTableState.videoDropRouteMode === 'audio' ? 'selected' : ''}>🎙 分配到人声-音频文件</option>
                </select>
            </div>
            <div style="margin-bottom:12px;">
                <span style="font-size:12px;color:#888;">选择字段：</span>
                ${fieldOptions.map(f => `
                    <label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:13px;color:${f.key === selectedField ? 'var(--accent)' : '#aaa'};cursor:pointer;">
                        <input type="radio" name="rbt-cf-field" value="${f.key}" ${f.key === selectedField ? 'checked' : ''} style="accent-color:var(--accent);">
                        ${f.label} (${f.items.length})
                    </label>
                `).join('')}
            </div>
            <div style="margin-bottom:10px;">
                <span style="font-size:12px;color:#888;">素材来源：</span>
                <label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:13px;color:${sourceMode === 'existing' ? 'var(--accent)' : '#aaa'};cursor:pointer;">
                    <input type="radio" name="rbt-cf-source" value="existing" ${sourceMode === 'existing' ? 'checked' : ''} style="accent-color:var(--accent);">
                    从已有行提取
                </label>
                <label style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;font-size:13px;color:${sourceMode === 'folder' ? 'var(--accent)' : '#aaa'};cursor:pointer;">
                    <input type="radio" name="rbt-cf-source" value="folder" ${sourceMode === 'folder' ? 'checked' : ''} style="accent-color:var(--accent);">
                    从文件选取
                </label>
                ${sourceMode === 'folder' ? `<button id="rbt-cf-pick-files" style="font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid #555;background:#2a2a3a;color:#ccc;cursor:pointer;">📂 选择文件...</button>` : ''}
                ${sourceMode === 'folder' && items.length > 0 ? `<button id="rbt-cf-clear-pool" style="font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid #555;background:#3a2a2a;color:#f88;cursor:pointer;margin-left:4px;">✕ 清空素材池</button>` : ''}
            </div>


            <div style="font-size:11px;color:#666;margin-bottom:8px;">
                共 ${totalRows} 行，其中 ${emptyRows} 行该字段为空 | 素材池: ${items.length} 个
            </div>
            ${field?.key === 'bg' ? `
                <div style="font-size:11px;color:#d8b15f;background:rgba(216,177,95,.08);border:1px solid rgba(216,177,95,.24);border-radius:6px;padding:7px 9px;margin-bottom:10px;">
                    背景素材填充会切换为单素材模式，并清空对应行的多素材背景池。
                </div>
            ` : ''}
            ${items.length === 0 ? `
                <div style="text-align:center;padding:30px;color:#666;">
                    ${sourceMode === 'existing' ? '当前没有该类型的素材。<br>请先通过批量添加素材到表格中。' : '请点击「选择文件」按钮添加素材文件。'}
                </div>
            ` : `
                <div style="border:1px solid #333;border-radius:8px;overflow:hidden;margin-bottom:12px;">
                    <div style="display:flex;padding:6px 12px;background:#141414;font-size:11px;color:#888;border-bottom:1px solid #333;">
                        <span style="flex:1;">素材文件</span>
                        <span style="width:100px;text-align:center;">权重</span>
                        <span style="width:60px;text-align:center;">预计次数</span>
                    </div>
                    <div id="rbt-cf-items" style="max-height:200px;overflow-y:auto;">
                        ${items.map((item, i) => `
                            <div style="display:flex;align-items:center;padding:6px 12px;border-bottom:1px solid #222;font-size:12px;color:#ccc;" data-idx="${i}">
                                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_escHtml(item)}">${_escHtml(_shortN(item))}</span>
                                <span style="width:100px;text-align:center;">
                                    <input type="number" class="rbt-cf-weight" data-idx="${i}" value="1" min="1" max="20"
                                        style="width:50px;text-align:center;background:#1a1a3a;color:#ddd;border:1px solid #444;border-radius:4px;padding:2px 4px;font-size:12px;">
                                </span>
                                <span class="rbt-cf-count" data-idx="${i}" style="width:60px;text-align:center;color:#888;">—</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div id="rbt-cf-preview" style="font-size:11px;color:#666;margin-bottom:12px;max-height:60px;overflow-y:auto;line-height:1.6;"></div>
                ${field?.key === 'bg' ? `
                    <div style="border:1px solid rgba(184,160,255,.28);background:rgba(100,60,200,.08);border-radius:8px;padding:10px;margin-bottom:12px;">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                            <span style="font-size:12px;font-weight:700;color:#b8a0ff;">多素材背景池</span>
                            <span style="font-size:11px;color:#777;">把上方 ${items.length} 个素材作为同一行的背景池使用</span>
                            <select id="rbt-cf-bgpool-order" style="margin-left:auto;height:24px;background:#17172a;border:1px solid #3a345d;color:#ddd;border-radius:4px;font-size:11px;padding:0 6px;">
                                <option value="random">随机组合</option>
                                <option value="sequence">按顺序组合</option>
                            </select>
                        </div>
                        <div style="display:flex;gap:6px;justify-content:flex-end;">
                            <button id="rbt-cf-bgpool-current" style="padding:6px 10px;border-radius:6px;border:1px solid #4c3d87;background:rgba(184,160,255,.12);color:#d7ccff;cursor:pointer;font-size:12px;">仅当前行</button>
                            <button id="rbt-cf-bgpool-selected" style="padding:6px 10px;border-radius:6px;border:1px solid #4c3d87;background:rgba(184,160,255,.12);color:#d7ccff;cursor:pointer;font-size:12px;">应用到勾选行</button>
                            <button id="rbt-cf-bgpool-all" style="padding:6px 10px;border-radius:6px;border:1px solid #4c3d87;background:rgba(184,160,255,.2);color:#fff;cursor:pointer;font-size:12px;font-weight:600;">应用到全部行</button>
                        </div>
                    </div>
                ` : ''}
                ${field?.key === 'bgm' ? `
                    <div style="border:1px solid rgba(155,89,182,.28);background:rgba(100,40,150,.08);border-radius:8px;padding:10px;margin-bottom:12px;">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                            <span style="font-size:12px;font-weight:700;color:#e0b3ff;">多素材配乐池</span>
                            <span style="font-size:11px;color:#777;">把上方 ${items.length} 个素材作为同一行的配乐池使用</span>
                            <select id="rbt-cf-bgmpool-order" style="margin-left:auto;height:24px;background:#17172a;border:1px solid #4a345d;color:#ddd;border-radius:4px;font-size:11px;padding:0 6px;">
                                <option value="random">随机挑选一首</option>
                                <option value="sequence">顺序/轮流挑选</option>
                            </select>
                        </div>
                        <div style="display:flex;gap:6px;justify-content:flex-end;">
                            <button id="rbt-cf-bgmpool-current" style="padding:6px 10px;border-radius:6px;border:1px solid #6c3d87;background:rgba(224,179,255,.12);color:#ecd7ff;cursor:pointer;font-size:12px;">仅当前行</button>
                            <button id="rbt-cf-bgmpool-selected" style="padding:6px 10px;border-radius:6px;border:1px solid #6c3d87;background:rgba(224,179,255,.12);color:#ecd7ff;cursor:pointer;font-size:12px;">应用到勾选行</button>
                            <button id="rbt-cf-bgmpool-all" style="padding:6px 10px;border-radius:6px;border:1px solid #6c3d87;background:rgba(224,179,255,.2);color:#fff;cursor:pointer;font-size:12px;font-weight:600;">应用到全部行</button>
                        </div>
                    </div>
                ` : ''}
            `}
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
                <button id="rbt-cf-cancel" style="padding:8px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;font-size:13px;">取消</button>
                ${items.length > 0 && emptyRows > 0 ? `
                    <button id="rbt-cf-fill-empty" style="padding:8px 16px;border-radius:6px;border:none;background:#2a5a3a;color:#8f8;cursor:pointer;font-size:13px;font-weight:600;">填充空行 (${emptyRows}行)</button>
                ` : ''}
                ${items.length > 0 ? `
                    <button id="rbt-cf-fill-all" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#000;cursor:pointer;font-size:13px;font-weight:600;">覆盖全部 (${totalRows}行)</button>
                ` : ''}
            </div>
        `;

        // 重新挂 fileInput
        box.appendChild(fileInput);

        // Bind events
        box.querySelectorAll('input[name="rbt-cf-field"]').forEach(r => {
            r.addEventListener('change', () => {
                selectedField = r.value;
                const field = fieldOptions.find(f => f.key === selectedField);
                if (sourceMode === 'existing' && field) {
                    field.items = [...field.origItems];
                } else if (sourceMode === 'folder' && field) {
                    // 加载已保存的素材池
                    const saved = _loadSavedPool()[selectedField];
                    field.items = saved && saved.length > 0 ? saved : [];
                }
                renderContent();
            });
        });
        box.querySelectorAll('input[name="rbt-cf-source"]').forEach(r => {
            r.addEventListener('change', () => {
                sourceMode = r.value;
                const field = fieldOptions.find(f => f.key === selectedField);
                if (sourceMode === 'existing' && field) {
                    field.items = [...field.origItems];
                } else if (sourceMode === 'folder' && field) {
                    // 加载已保存的素材池
                    const saved = _loadSavedPool()[selectedField];
                    field.items = saved && saved.length > 0 ? saved : [];
                }
                renderContent();
            });
        });
        box.querySelector('#rbt-cf-pick-files')?.addEventListener('click', () => {
            const exts = [...EXT_MAP[selectedField]].map(e => '.' + e).join(',');
            fileInput.accept = exts;
            fileInput.click();
        });
        box.querySelector('#rbt-cf-clear-pool')?.addEventListener('click', () => {
            const field = fieldOptions.find(f => f.key === selectedField);
            if (field) field.items = [];
            _savePool(selectedField, []);
            renderContent();
        });
        box.querySelectorAll('.rbt-cf-weight').forEach(w => {
            w.addEventListener('input', updatePreview);
        });
        box.querySelector('#rbt-cf-cancel')?.addEventListener('click', () => overlay.remove());
        box.querySelector('#rbt-cf-fill-empty')?.addEventListener('click', () => {
            const field = fieldOptions.find(f => f.key === selectedField);
            _doCycleFill(selectedField, field.items, _getWeights(), 'empty');
            overlay.remove();
        });
        box.querySelector('#rbt-cf-fill-all')?.addEventListener('click', () => {
            const field = fieldOptions.find(f => f.key === selectedField);
            _doCycleFill(selectedField, field.items, _getWeights(), 'all');
            overlay.remove();
        });
        box.querySelector('#rbt-cf-bgpool-current')?.addEventListener('click', () => {
            const field = fieldOptions.find(f => f.key === selectedField);
            const order = box.querySelector('#rbt-cf-bgpool-order')?.value || 'random';
            _applyCycleItemsAsBgPool(field?.items || [], order, 'current');
        });
        box.querySelector('#rbt-cf-bgpool-selected')?.addEventListener('click', () => {
            const field = fieldOptions.find(f => f.key === selectedField);
            const order = box.querySelector('#rbt-cf-bgpool-order')?.value || 'random';
            _applyCycleItemsAsBgPool(field?.items || [], order, 'selected');
        });
        box.querySelector('#rbt-cf-bgpool-all')?.addEventListener('click', () => {
            const field = fieldOptions.find(f => f.key === selectedField);
            const order = box.querySelector('#rbt-cf-bgpool-order')?.value || 'random';
            _applyCycleItemsAsBgPool(field?.items || [], order, 'all');
        });
        box.querySelector('#rbt-cf-bgmpool-current')?.addEventListener('click', () => {
            const field = fieldOptions.find(f => f.key === selectedField);
            const order = box.querySelector('#rbt-cf-bgmpool-order')?.value || 'random';
            _applyCycleItemsAsBgmPool(field?.items || [], order, 'current');
            overlay.remove();
        });
        box.querySelector('#rbt-cf-bgmpool-selected')?.addEventListener('click', () => {
            const field = fieldOptions.find(f => f.key === selectedField);
            const order = box.querySelector('#rbt-cf-bgmpool-order')?.value || 'random';
            _applyCycleItemsAsBgmPool(field?.items || [], order, 'selected');
            overlay.remove();
        });
        box.querySelector('#rbt-cf-bgmpool-all')?.addEventListener('click', () => {
            const field = fieldOptions.find(f => f.key === selectedField);
            const order = box.querySelector('#rbt-cf-bgmpool-order')?.value || 'random';
            _applyCycleItemsAsBgmPool(field?.items || [], order, 'all');
            overlay.remove();
        });

        // ==========================================
        // 绑定“独立素材使用与分配设置”的相关事件
        // ==========================================
        box.querySelector('#rbt-cf-upload-hook')?.addEventListener('click', () => {
            const indices = _getSelectedIndices();
            if (indices.length === 0) {
                alert('请先在左侧勾选需要批量配置前置Hook的行（可先关闭此面板去勾选）');
                return;
            }
            overlay.remove(); // 关掉本面板，打开Hook面板
            _openHookModal(-1);
        });

        box.querySelector('#rbt-cf-video-drop-route-enabled')?.addEventListener('change', (e) => {
            _batchTableState.videoDropRouteEnabled = e.target.checked;
            renderContent(); // 触发重渲染，更新下拉框的禁用状态
        });

        box.querySelector('#rbt-cf-video-drop-route-mode')?.addEventListener('change', (e) => {
            _batchTableState.videoDropRouteMode = e.target.value;
        });
        // ==========================================

        updatePreview();
    }

    function _getWeights() {
        const weights = [];
        box.querySelectorAll('.rbt-cf-weight').forEach(w => {
            weights[parseInt(w.dataset.idx)] = Math.max(1, parseInt(w.value) || 1);
        });
        return weights;
    }

    function updatePreview() {
        const field = fieldOptions.find(f => f.key === selectedField);
        if (!field || !field.items.length) return;
        const weights = _getWeights();
        const totalWeight = weights.reduce((s, w) => s + w, 0);
        const totalRows = tasks.length || 1;

        // 更新各素材预计次数
        box.querySelectorAll('.rbt-cf-count').forEach(span => {
            const i = parseInt(span.dataset.idx);
            const count = Math.round(totalRows * (weights[i] || 1) / totalWeight);
            span.textContent = count + '次';
        });

        // 小预览
        const preview = box.querySelector('#rbt-cf-preview');
        if (preview) {
            const previewCount = Math.min(totalRows, 30);
            const seq = _generateCycleSequence(field.items, weights, previewCount);
            const names = seq.map(idx => _shortN(field.items[idx]));
            const truncated = totalRows > 30 ? ' ...' : '';
            preview.textContent = '预览: ' + names.join(' → ') + truncated;
        }
    }

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    renderContent();
}

/**
 * 加权交错分配算法 — 优先队列法，保证不相邻重复
 * @returns {number[]} 素材索引序列
 */
function _generateCycleSequence(items, weights, count) {
    if (items.length === 0) return [];
    if (items.length === 1) return new Array(count).fill(0);

    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const seq = [];
    // 每个素材的剩余份额
    const remaining = weights.map((w, i) => ({ idx: i, rem: (w / totalWeight) * count }));
    let lastIdx = -1;

    for (let i = 0; i < count; i++) {
        // 找剩余份额最大的（排除上一个用过的）
        let best = -1, bestRem = -Infinity;
        for (const r of remaining) {
            if (r.idx === lastIdx) continue;
            if (r.rem > bestRem) { bestRem = r.rem; best = r.idx; }
        }
        if (best === -1) best = remaining[0].idx; // fallback
        seq.push(best);
        remaining.find(r => r.idx === best).rem -= 1;
        lastIdx = best;
    }

    return seq;
}

/**
 * 执行循环填充
 */
function _doCycleFill(fieldKey, items, weights, mode) {
    const state = window._reelsState;
    if (!state || !items.length) return;

    let targetIndices;
    if (mode === 'empty') {
        targetIndices = state.tasks.map((t, i) => {
            const hasMultiBg = fieldKey === 'bg'
                && t.bgMode === 'multi'
                && Array.isArray(t.bgClipPool)
                && t.bgClipPool.some(Boolean);
            if (fieldKey === 'bg' && !hasMultiBg && !t.bgPath && !t.videoPath) return i;
            if (fieldKey === 'audio' && !t.audioPath) return i;
            if (fieldKey === 'bgm' && !t.bgmPath) return i;
            return -1;
        }).filter(i => i >= 0);
    } else {
        targetIndices = state.tasks.map((_, i) => i);
    }

    if (targetIndices.length === 0) {
        alert('没有需要填充的行');
        return;
    }

    const seq = _generateCycleSequence(items, weights, targetIndices.length);
    const fieldLabel = fieldKey === 'bg' ? '背景素材' : fieldKey === 'audio' ? '人声-音频文件' : '配乐';

    for (let i = 0; i < targetIndices.length; i++) {
        const task = state.tasks[targetIndices[i]];
        const filePath = items[seq[i]];
        if (fieldKey === 'bg') {
            const bgOptions = { detectImage: true };
            if (window.electronAPI && window.electronAPI.toFileUrl) {
                bgOptions.bgSrcUrl = window.electronAPI.toFileUrl(filePath);
            }
            _setTaskSingleBackground(task, filePath, bgOptions);
        } else if (fieldKey === 'audio') {
            task.audioPath = filePath;
        } else if (fieldKey === 'bgm') {
            task.bgmPath = filePath;
        }
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    alert(`✅ 已循环填充 ${targetIndices.length} 行的${fieldLabel}`);
}

function _applyCycleItemsAsBgPool(items, order, scope) {
    const state = window._reelsState;
    if (!state || !Array.isArray(state.tasks)) return;

    const pool = [...new Set((items || []).filter(Boolean))];
    if (pool.length === 0) {
        alert('请先添加背景素材');
        return;
    }

    let targetIndices = [];
    if (scope === 'all') {
        targetIndices = state.tasks.map((_, i) => i);
    } else if (scope === 'selected') {
        targetIndices = _getSelectedIndices();
        if (targetIndices.length === 0) {
            alert('请先勾选要应用的行');
            return;
        }
    } else {
        const selectedIdx = Number.isInteger(state.selectedIdx) && state.selectedIdx >= 0
            ? state.selectedIdx
            : (_getSelectedIndices()[0] ?? 0);
        if (state.tasks[selectedIdx]) targetIndices = [selectedIdx];
    }

    if (targetIndices.length === 0) {
        alert('没有可应用的行');
        return;
    }

    for (const idx of targetIndices) {
        const task = state.tasks[idx];
        if (!task) continue;
        task.bgMode = 'multi';
        task.bgClipPool = [...pool];
        task.bgClipActivePool = [];
        task.bgClipOrder = order === 'sequence' ? 'sequence' : 'random';
        task.bgTransition = task.bgTransition || 'crossfade';
        task.bgTransDur = task.bgTransDur ?? 0.5;
        task.bgPath = '';
        task.videoPath = '';
        task.bgSrcUrl = '';
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    if (state.selectedIdx >= 0 && typeof reelsSelectTask === 'function') {
        reelsSelectTask(state.selectedIdx);
    }
    if (state.selectedIdx >= 0 && typeof window.reelsSyncBackgroundTabUI === 'function') {
        window.reelsSyncBackgroundTabUI(state.tasks[state.selectedIdx]);
    }
    if (typeof showToast === 'function') {
        const label = order === 'sequence' ? '按顺序' : '随机';
        showToast(`✅ 已将 ${pool.length} 个素材作为多素材背景池应用到 ${targetIndices.length} 行（${label}）`, 'success');
    } else {
        alert(`已应用到 ${targetIndices.length} 行`);
    }
}

function _applyCycleItemsAsBgmPool(items, order, scope) {
    const state = window._reelsState;
    if (!state || !Array.isArray(state.tasks)) return;

    const pool = [...new Set((items || []).filter(Boolean))];
    if (pool.length === 0) {
        alert('请先添加配乐素材');
        return;
    }

    let targetIndices = [];
    if (scope === 'all') {
        targetIndices = state.tasks.map((_, i) => i);
    } else if (scope === 'selected') {
        targetIndices = _getSelectedIndices();
        if (targetIndices.length === 0) {
            alert('请先勾选要应用的行');
            return;
        }
    } else {
        const selectedIdx = Number.isInteger(state.selectedIdx) && state.selectedIdx >= 0
            ? state.selectedIdx
            : (_getSelectedIndices()[0] ?? 0);
        if (state.tasks[selectedIdx]) targetIndices = [selectedIdx];
    }

    if (targetIndices.length === 0) {
        alert('没有可应用的行');
        return;
    }

    for (const idx of targetIndices) {
        const task = state.tasks[idx];
        if (!task) continue;
        task.bgmMode = 'multi';
        task.bgmClipPool = [...pool];
        task.bgmClipActivePool = [];
        task.bgmClipOrder = order === 'sequence' ? 'sequence' : 'random';
        task.bgmPath = '';
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    if (state.selectedIdx >= 0 && typeof reelsSelectTask === 'function') {
        reelsSelectTask(state.selectedIdx);
    }
    if (state.selectedIdx >= 0 && typeof window.reelsSyncBackgroundTabUI === 'function') {
        window.reelsSyncBackgroundTabUI(state.tasks[state.selectedIdx]);
    }
    if (typeof showToast === 'function') {
        const label = order === 'sequence' ? '按顺序' : '随机';
        showToast(`✅ 已将 ${pool.length} 个配乐作为多素材配乐池应用到 ${targetIndices.length} 行（${label}）`, 'success');
    } else {
        alert(`已应用到 ${targetIndices.length} 行`);
    }
}

/**
 * 批量粘贴人声文案/断行/音色：1. 人声-配音文案 2. 人声-断行文案 3. 人声-配音音色
 */
async function _batchPasteTTSContent() {
    const mode = await _showPasteModeDialog();
    if (!mode) return;

    let validRows = [];
    try {
        const clipboardItems = await navigator.clipboard.read();
        for (const item of clipboardItems) {
            // 优先解析 HTML
            if (item.types.includes('text/html')) {
                const blob = await item.getType('text/html');
                const html = await blob.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const tableRows = doc.querySelectorAll('tr');

                // 辅助函数：获取单元格文本，保留换行
                const getCellTextWithBreaks = (cell) => {
                    if (!cell) return '';
                    let clone = cell.cloneNode(true);
                    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                    clone.querySelectorAll('p, div').forEach(el => el.insertAdjacentText('beforebegin', '\n'));
                    return clone.textContent.trim();
                };

                tableRows.forEach(tr => {
                    const cells = tr.querySelectorAll('td, th');
                    if (cells.length >= 2) {
                        const ttsText = getCellTextWithBreaks(cells[0]);
                        const subtitleText = getCellTextWithBreaks(cells[1]);
                        const voiceId = cells[2]?.textContent.trim() || '';
                        if (ttsText || subtitleText) {
                            validRows.push([ttsText, subtitleText, voiceId]);
                        }
                    } else if (cells.length === 1) {
                        // 兼容只有一列的情况
                        validRows.push([getCellTextWithBreaks(cells[0]), '', '']);
                    }
                });
            }

            // 如果 HTML 没数据，或者不支持，尝试纯文本
            if (validRows.length === 0 && item.types.includes('text/plain')) {
                const blob = await item.getType('text/plain');
                const raw = await blob.text();
                const rows = typeof _parseBatchTSV === 'function' ? _parseBatchTSV(raw) : raw.split(/\n/).map(line => line.split('\t'));
                validRows = rows.filter(r => r.join('').trim().length > 0);
            }
        }
    } catch (e) {
        // 降级：让用户在弹窗里直接粘贴纯文本
        let raw = await _showPasteDialog('📋 粘贴人声文案/断行/音色 (1.人声-配音文案 2.人声-断行文案 3.人声-配音音色)');
        if (!raw || !raw.trim()) return;
        const rows = typeof _parseBatchTSV === 'function' ? _parseBatchTSV(raw) : raw.split(/\n/).map(line => line.split('\t'));
        validRows = rows.filter(r => r.join('').trim().length > 0);
    }

    if (!validRows.length) {
        alert('未检测到可以导入数据');
        return;
    }

    const maxCols = Math.max(...validRows.map(r => r.length));
    if (maxCols > 1) {
        _showMultiColumnPasteModal(validRows, 0, 'ttsText');
        return;
    }

    _syncTasksToActiveTab();
    const state = window._reelsState;
    const tab = _getActiveTab();
    const tasks = tab.tasks;

    let addedCount = 0;
    let dataIdx = 0;

    if (mode === 'fill') {
        for (let i = 0; i < tasks.length && dataIdx < validRows.length; i++) {
            const task = tasks[i];
            const isTextEmpty = !task.ttsText && !task.txtContent;
            if (isTextEmpty) {
                const row = validRows[dataIdx];
                let ttsText = row[0] || '';
                let txtContent = row.length >= 2 ? row[1] || '' : '';
                let voiceId = row.length >= 3 ? row[2] || '' : '';

                if (ttsText.trim()) task.ttsText = ttsText.trim();
                if (txtContent.trim()) { task.txtContent = txtContent.trim(); task.aligned = false; }
                if (voiceId.trim()) task.ttsVoiceId = voiceId.trim();

                dataIdx++;
                addedCount++;
            }
        }
    } else if (mode === 'overwrite') {
        for (let i = 0; i < tasks.length && dataIdx < validRows.length; i++) {
            const task = tasks[i];
            const row = validRows[dataIdx];
            let ttsText = row[0] || '';
            let txtContent = row.length >= 2 ? row[1] || '' : '';
            let voiceId = row.length >= 3 ? row[2] || '' : '';

            task.ttsText = '';
            task.txtContent = '';

            if (ttsText.trim()) task.ttsText = ttsText.trim();
            if (txtContent.trim()) { task.txtContent = txtContent.trim(); task.aligned = false; }
            if (voiceId.trim()) task.ttsVoiceId = voiceId.trim();

            dataIdx++;
            addedCount++;
        }
    }

    // mode === 'new' or remaining rows
    for (; dataIdx < validRows.length; dataIdx++) {
        const row = validRows[dataIdx];
        const taskName = _generateUniqueCardName(tasks, 'tts_task');
        const ttask = {
            baseName: taskName,
            fileName: `${taskName}.mp4`,
            bgPath: null, bgSrcUrl: null,
            audioPath: null, srtPath: null,
            segments: [],
            videoPath: null, srcUrl: null,
            bgScale: 100, bgDurScale: 100, audioDurScale: 100
        };

        let ttsText = row[0] || '';
        let txtContent = row.length >= 2 ? row[1] || '' : '';
        let voiceId = row.length >= 3 ? row[2] || '' : '';

        if (ttsText.trim()) ttask.ttsText = ttsText.trim();
        if (txtContent.trim()) { ttask.txtContent = txtContent.trim(); ttask.aligned = false; }
        if (voiceId.trim()) ttask.ttsVoiceId = voiceId.trim();

        tasks.push(ttask);
        addedCount++;
    }

    _loadTabTasks(tab);
    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    alert(`✅ 已成功通过【${mode === 'fill' ? '补全' : (mode === 'overwrite' ? '覆盖' : '新行')}】模式导入 ${addedCount} 条人声-TTS记录`);
}

/**
 * 从剪贴板批量粘贴文案到「人声-断行文案」列 (txtContent)
 * 支持：
 * - 单列：每行一条文案
 * - 多列表格：取第一列
 * - Google 表格 / Excel 复制过来的都支持
 */
async function _batchPasteTxtContent() {
    const mode = await _showPasteModeDialog();
    if (!mode) return;

    let raw = '';
    try {
        raw = await navigator.clipboard.readText();
    } catch (e) {
        raw = await _showPasteDialog();
    }
    if (!raw || !raw.trim()) return;

    const tsvRows = _parseBatchTSV(raw);
    if (tsvRows.length === 0) return showToast('未能解析到文本', 'error');

    const maxCols = Math.max(...tsvRows.map(r => r.length));
    if (maxCols > 1) {
        _showMultiColumnPasteModal(tsvRows, 0, 'txtContent');
        return;
    }

    // 解析行 — 支持 TSV 表格格式（取第一列）和纯文本（每行一条）
    const lines = tsvRows.map(row => (row[0] || '').trim()).filter(s => s.length > 0);

    if (!lines.length) {
        alert('未提取到有效文本数据');
        return;
    }

    const state = window._reelsState;
    if (!state) return;

    let filled = 0, created = 0;
    let dataIdx = 0;

    if (mode === 'fill') {
        for (let i = 0; i < state.tasks.length && dataIdx < lines.length; i++) {
            const task = state.tasks[i];
            if (!task.txtContent || !task.txtContent.trim()) {
                task.txtContent = lines[dataIdx];
                task.aligned = false;
                dataIdx++;
                filled++;
            }
        }
    } else if (mode === 'overwrite') {
        for (let i = 0; i < state.tasks.length && dataIdx < lines.length; i++) {
            const task = state.tasks[i];
            task.txtContent = lines[dataIdx];
            task.aligned = false;
            dataIdx++;
            filled++;
        }
    }

    for (; dataIdx < lines.length; dataIdx++) {
        const taskName = _generateUniqueCardName(state.tasks, 'card');
        state.tasks.push({
            baseName: taskName,
            fileName: `${taskName}.mp4`,
            bgPath: null, bgSrcUrl: null,
            audioPath: null, srtPath: null,
            segments: [],
            videoPath: null, srcUrl: null,
            overlays: [],
            txtContent: lines[dataIdx],
            aligned: false,
            bgScale: 100, bgDurScale: 100, audioDurScale: 100
        });
        created++;
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();

    const parts = [];
    if (filled) parts.push(`填充 ${filled} 行`);
    if (created) parts.push(`新建 ${created} 行`);
    alert(`✅ 人声-断行文案粘贴完成通过模式 [${mode}]：${parts.join('，')}`);
}

/**
 * 从剪贴板粘贴数据到「人声-原文案」
 */
async function _batchPasteAiScript() {
    const mode = await _showPasteModeDialog();
    if (!mode) return;

    let raw = '';
    try {
        raw = await navigator.clipboard.readText();
    } catch (e) {
        raw = await _showPasteDialog();
    }
    if (!raw || !raw.trim()) return;

    // 使用 TSV 引号解析器，正确处理 Google Sheets 单元格内的换行
    const tsvRows = _parseBatchTSV(raw);
    const lines = tsvRows.map(row => (row[0] || '').trim()).filter(s => s.length > 0);

    if (!lines.length) {
        alert('未提取到有效文本数据');
        return;
    }

    const state = window._reelsState;
    if (!state) return;

    let filled = 0, created = 0;
    let dataIdx = 0;

    if (mode === 'fill') {
        for (let i = 0; i < state.tasks.length && dataIdx < lines.length; i++) {
            const task = state.tasks[i];
            if (!task.aiScript || !task.aiScript.trim()) {
                task.aiScript = lines[dataIdx];
                dataIdx++;
                filled++;
            }
        }
    } else if (mode === 'overwrite') {
        for (let i = 0; i < state.tasks.length && dataIdx < lines.length; i++) {
            const task = state.tasks[i];
            task.aiScript = lines[dataIdx];
            dataIdx++;
            filled++;
        }
    }

    const newRows = lines.slice(dataIdx);
    if (newRows.length > 0 && confirm(`还有 ${newRows.length} 条数据尚未匹配到任务行。是否自动创建 ${newRows.length} 行新任务并填充？`)) {
        for (const str of newRows) {
            const taskName = _generateUniqueCardName(state.tasks, 'card');
            state.tasks.push({
                baseName: taskName,
                fileName: `${taskName}.mp4`,
                bgPath: null, bgSrcUrl: null,
                audioPath: null, srtPath: null,
                segments: [],
                videoPath: null, srcUrl: null,
                overlays: [],
                aiScript: str,
                aligned: false,
                bgScale: 100, bgDurScale: 100, audioDurScale: 100
            });
            created++;
        }
    }

    _skipNextApply = true;
    _renderBatchTable();
    showToast(`✅ 粘贴人声-原文案成功：覆盖/填充 ${filled} 行，新建 ${created} 行`, 'success');
}

// ── 辅助：设置一行的文案 ──
function _setTaskText(task, title, body, ReelsOverlay, footer, targetId = null, targetIdx = null) {
    if (!task.overlays) task.overlays = [];
    let ov = _findBatchOverlayByIdOrIdx(task, targetId, null, targetIdx, 'textcard');
    if (!ov) {
        // Clone from template overlay with targetId if it exists to preserve styling
        const state = window._reelsState;
        const templateTask = state.tasks[state.selectedIdx] || state.tasks[0];
        const templateList = templateTask ? (templateTask.overlays || []).filter(o => o && !o.fixed_text && (o.type === 'textcard' || !o.type || o.type === '')) : [];
        const templateOv = targetId ? templateList.find(o => o.id === targetId) : (targetIdx != null && targetIdx >= 0 && targetIdx < templateList.length ? templateList[targetIdx] : templateList[0]);
        if (templateOv) {
            ov = _cloneDerivedOverlay(templateOv);
            ov.title_text = '';
            ov.body_text = '';
            ov.footer_text = '';
            ov.fixed_text = false;
            task.overlays.push(ov);
            window.ReelsTaskDerivation?.resolveOverlayBindings?.(task);
        } else {
            ov = ReelsOverlay.createTextCardOverlay({
                title_text: '', body_text: '', footer_text: '',
                start: 0, end: 9999,
            });
            ov.fixed_text = false;
            task.overlays.push(ov);
        }
    }
    ov.title_text = title;
    ov.body_text = body;
    if (footer !== undefined && footer !== '') {
        ov.footer_text = footer;
    }
}

// ── 辅助：新建一行并填入文案 ──
function _createNewTextRow(state, title, body, ReelsOverlay, footer, targetId = null, targetIdx = null) {
    const taskName = _generateUniqueCardName(state.tasks, 'card');
    const newTask = _createTaskFromTemplate(state, taskName);
    _setTaskText(newTask, title, body, ReelsOverlay, footer, targetId, targetIdx);
    _finalizeDerivedTaskInstances(newTask);
    state.tasks.push(newTask);
}

// ── 辅助：设置滚动字幕文案 ──
function _setTaskScrollText(task, title, body, ReelsOverlay, targetId = null, targetIdx = null) {
    if (!task.overlays) task.overlays = [];
    let scrollOv = _findBatchOverlayByIdOrIdx(task, targetId, null, targetIdx, 'scroll');
    if (!scrollOv) {
        // Clone template scroll overlay if available
        const state = window._reelsState;
        const templateTask = state.tasks[state.selectedIdx] || state.tasks[0];
        const templateList = templateTask ? (templateTask.overlays || []).filter(o => o && !o.fixed_text && o.type === 'scroll') : [];
        const templateOv = targetId ? templateList.find(o => o.id === targetId) : (targetIdx != null && targetIdx >= 0 && targetIdx < templateList.length ? templateList[targetIdx] : templateList[0]);
        if (templateOv) {
            scrollOv = _cloneDerivedOverlay(templateOv);
            scrollOv.scroll_title = '';
            scrollOv.content = '';
            scrollOv.fixed_text = false;
            task.overlays.push(scrollOv);
            window.ReelsTaskDerivation?.resolveOverlayBindings?.(task);
        } else {
            scrollOv = ReelsOverlay.createScrollOverlay({
                scroll_title: title, content: body,
                start: 0, end: 9999,
            });
            scrollOv.fixed_text = false;
            task.overlays.push(scrollOv);
        }
    }
    // 无论是刚从模板创建，还是已经存在，都必须写入当前行的新文案。
    scrollOv.scroll_title = title;
    scrollOv.content = body;
}

// ── 辅助：新建一行并填入滚动字幕 ──
function _createNewScrollRow(state, title, body, ReelsOverlay, targetId = null, targetIdx = null) {
    const taskName = _generateUniqueCardName(state.tasks, 'scroll');
    const newTask = _createTaskFromTemplate(state, taskName);
    _setTaskScrollText(newTask, title, body, ReelsOverlay, targetId, targetIdx);
    _finalizeDerivedTaskInstances(newTask);
    state.tasks.push(newTask);
}

// ── 模式选择弹窗 ──
function _showPasteModeDialog() {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

        const box = document.createElement('div');
        box.style.cssText = 'background:#1e1e2e;border:1px solid #333;border-radius:14px;padding:24px;min-width:360px;box-shadow:0 10px 40px rgba(0,0,0,0.6);';
        box.innerHTML = `
            <div style="font-size:16px;font-weight:700;margin-bottom:16px;color:var(--accent);">📋 选择粘贴模式</div>
            <div style="display:flex;flex-direction:column;gap:10px;">
                <button class="rbt-paste-mode-btn" data-mode="fill" style="padding:12px 16px;border-radius:8px;border:1px solid #2a6b3a;background:#1a3a2a;color:#8f8;cursor:pointer;text-align:left;font-size:13px;">
                    <div style="font-weight:700;font-size:14px;margin-bottom:4px;">🔄 补全模式</div>
                    <div style="color:#aaa;font-size:12px;">只填充空行（没有文案的行），已有文案的行保持不动。多出的文案追加为新行。</div>
                </button>
                <button class="rbt-paste-mode-btn" data-mode="overwrite" style="padding:12px 16px;border-radius:8px;border:1px solid #b48b00;background:#3a3020;color:#ffd700;cursor:pointer;text-align:left;font-size:13px;">
                    <div style="font-weight:700;font-size:14px;margin-bottom:4px;">⚡ 覆盖模式</div>
                    <div style="color:#aaa;font-size:12px;">从第1行开始逐行覆盖文案（不改变背景/音频等其它数据）。多出的追加为新行。</div>
                </button>
                <button class="rbt-paste-mode-btn" data-mode="new" style="padding:12px 16px;border-radius:8px;border:1px solid #4466aa;background:#1a2540;color:#88bbff;cursor:pointer;text-align:left;font-size:13px;">
                    <div style="font-weight:700;font-size:14px;margin-bottom:4px;">➕ 新行模式</div>
                    <div style="color:#aaa;font-size:12px;">全部作为新行添加到末尾，不影响任何现有行。</div>
                </button>
            </div>
            <div style="margin-top:14px;text-align:right;">
                <button class="rbt-paste-cancel" style="padding:6px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;font-size:13px;">取消</button>
            </div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const close = (val) => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            resolve(val);
        };

        box.querySelectorAll('.rbt-paste-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => close(btn.dataset.mode));
            btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.85'; btn.style.transform = 'scale(1.01)'; });
            btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; btn.style.transform = 'scale(1)'; });
        });
        box.querySelector('.rbt-paste-cancel').addEventListener('click', () => close(null));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    });
}

function _showPasteDialog(titleStr = '📋 粘贴表格数据') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:10001;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:#1e1e1e;border-radius:12px;padding:24px;width:500px;">
                <h3 style="margin:0 0 12px;color:var(--accent);">${titleStr}</h3>
                <textarea id="rbt-paste-area" style="width:100%;height:200px;background:#141414;border:1px solid var(--border-color);border-radius:8px;color:#ddd;font-size:13px;padding:12px;" placeholder="从 Google 表格粘贴..."></textarea>
                <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">
                    <button id="rbt-paste-cancel" style="padding:8px 16px;background:#333;border:1px solid #555;border-radius:6px;color:#ccc;cursor:pointer;">取消</button>
                    <button id="rbt-paste-ok" style="padding:8px 16px;background:var(--accent);border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;">导入</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const close = v => { document.body.removeChild(overlay); resolve(v); };
        overlay.querySelector('#rbt-paste-cancel').onclick = () => close(null);
        overlay.querySelector('#rbt-paste-ok').onclick = () => close(overlay.querySelector('#rbt-paste-area').value);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
        setTimeout(() => overlay.querySelector('#rbt-paste-area')?.focus(), 100);
    });
}

function _showSplitPromptDialog(messageText, hasFooter = false) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:10001;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);';

        const htmlMessage = messageText.replace(/\\n/g, '<br>');

        overlay.innerHTML = `
            <div style="background:#1e1e1e;border-radius:12px;padding:24px;width:400px;color:#ddd;box-shadow:0 10px 30px rgba(0,0,0,0.5);border:1px solid #333;">
                <h3 style="margin:0 0 16px;color:#a78bfa;font-size:16px;">🪄 智能分段提取</h3>
                <div style="font-size:13px;line-height:1.6;margin-bottom:20px;color:#ccc;">${htmlMessage}</div>
                
                <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:20px;">
                    <button class="rbt-split-btn" data-val="1" style="padding:12px;background:#2a2a3a;border:1px solid #4a4a6a;border-radius:8px;color:#cce;cursor:pointer;text-align:left;transition:all 0.2s;">
                        <div style="font-weight:bold;margin-bottom:4px;color:#a78bfa;font-size:14px;">[ 全部内容用于标题 ]</div>
                        <div style="font-size:12px;color:#aaa;">全文内容作为标题，正文和结尾留空</div>
                    </button>
                    <button class="rbt-split-btn" data-val="4" style="padding:12px;background:#2a2a3a;border:1px solid #4a4a6a;border-radius:8px;color:#cce;cursor:pointer;text-align:left;transition:all 0.2s;">
                        <div style="font-weight:bold;margin-bottom:4px;color:#a78bfa;font-size:14px;">[ 全部内容用于正文 ]</div>
                        <div style="font-size:12px;color:#aaa;">全文内容作为正文，标题 and 结尾留空</div>
                    </button>
                    ${hasFooter ? `
                    <button class="rbt-split-btn" data-val="5" style="padding:12px;background:#2a2a3a;border:1px solid #4a4a6a;border-radius:8px;color:#cce;cursor:pointer;text-align:left;transition:all 0.2s;">
                        <div style="font-weight:bold;margin-bottom:4px;color:#a78bfa;font-size:14px;">[ 全部内容用于结尾 ]</div>
                        <div style="font-size:12px;color:#aaa;">全文内容作为结尾，标题和正文留空</div>
                    </button>
                    ` : ''}
                    <button class="rbt-split-btn" data-val="2" style="padding:12px;background:#2a2a3a;border:1px solid #4a4a6a;border-radius:8px;color:#cce;cursor:pointer;text-align:left;transition:all 0.2s;">
                        <div style="font-weight:bold;margin-bottom:4px;color:#a78bfa;font-size:14px;">[ 拆为两段 ]</div>
                        <div style="font-size:12px;color:#aaa;">首行提取为标题，其余内容合并为正文</div>
                    </button>
                    <button class="rbt-split-btn" data-val="3" style="padding:12px;background:#2a2a3a;border:1px solid #4a4a6a;border-radius:8px;color:#cce;cursor:pointer;text-align:left;transition:all 0.2s;">
                        <div style="font-weight:bold;margin-bottom:4px;color:#a78bfa;font-size:14px;">[ 拆为三段 ]</div>
                        <div style="font-size:12px;color:#aaa;">首行标题，末行做结尾标签，中间所有为正文</div>
                    </button>
                </div>
                
                <div style="display:flex;justify-content:flex-end;">
                    <button id="rbt-split-cancel" style="padding:8px 16px;background:#333;border:1px solid #555;border-radius:6px;color:#aaa;cursor:pointer;">保留全文原文，不提取</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const close = v => { document.body.removeChild(overlay); resolve(v); };

        overlay.querySelector('#rbt-split-cancel').onclick = () => close(null);

        overlay.querySelectorAll('.rbt-split-btn').forEach(btn => {
            btn.onmouseenter = () => btn.style.background = '#32324a';
            btn.onmouseleave = () => btn.style.background = '#2a2a3a';
            btn.onclick = () => close(btn.dataset.val);
        });

        overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
    });
}

function _showBatchEditDialog(badRows, minLines, totalRows) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:10002;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(5px);';

        let boxesHtml = '';
        for (let idx = 0; idx < badRows.length; idx++) {
            const r = badRows[idx];
            boxesHtml += `
            <div style="background:#141414;border:1px solid #444;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:4px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="font-size:11px;color:#a78bfa;font-weight:bold;"># 第 ${r.index + 1} 行</span>
                    <label style="font-size:10px;color:#888;cursor:pointer;"><input type="checkbox" class="rbt-skip-chk" data-i="${idx}" style="vertical-align:middle;margin-right:2px;">彻底放弃此行</label>
                </div>
                <textarea class="rbt-box-display" data-i="${idx}" title="可以直接输入编辑，双击则全屏放大修改" style="flex:1;background:#0d0d0d;border:1px dashed #555;border-radius:4px;padding:6px;font-size:12px;color:#ccc;overflow-y:auto;white-space:pre-wrap;word-break:break-all;transition:all 0.2s;min-height:90px;max-height:140px;resize:none;font-family:system-ui;line-height:1.4;">${typeof _escHtml === 'function' ? _escHtml(r.text) : r.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
            </div>`;
        }

        overlay.innerHTML = `
            <div style="background:#1e1e1e;border-radius:12px;padding:24px;width:960px;max-width:90vw;max-height:90vh;display:flex;flex-direction:column;color:#ddd;box-shadow:0 10px 40px rgba(0,0,0,0.7);border:1px solid #333;">
                <h3 style="margin:0 0 12px;color:#f87171;font-size:18px;display:flex;align-items:center;gap:6px;">
                    ⚠️ 分段提取中断 (${badRows.length}/${totalRows} 行数据不合规)
                </h3>
                <div style="font-size:13px;line-height:1.5;margin-bottom:16px;color:#bbb;">
                    您选择了拆分为 <strong style="color:var(--accent);">${minLines} 段</strong>，但以下贴入的文案<strong style="color:#f87171;">没有按要求换行</strong>导致程序无法智能切割。<br>
                    请 <strong style="color:#d8b4fe;border-bottom:1px solid #d8b4fe;padding-bottom:1px;">双击</strong> 以下卡片进入放大编辑模式，补上回车把文案断开！
                </div>
                
                <div style="flex:1;overflow-y:auto;margin-bottom:20px;padding-right:8px;">
                    <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));gap:12px;">
                        ${boxesHtml}
                    </div>
                </div>
                
                <div style="display:flex;gap:12px;justify-content:flex-end;">
                    <button id="rbt-batch-edit-cancel" style="padding:8px 20px;background:#333;border:1px solid #555;border-radius:6px;color:#ccc;cursor:pointer;">取消整批导入</button>
                    <button id="rbt-batch-edit-ok" style="padding:8px 20px;background:var(--accent);border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;">✅ 修改好了，继续提取验证</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        let activeEditIndex = -1;
        const largeEditOverlay = document.createElement('div');
        largeEditOverlay.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.9);z-index:10;display:none;flex-direction:column;padding:40px;border-radius:12px;';
        largeEditOverlay.innerHTML = `
            <div style="font-size:16px;color:#a78bfa;font-weight:bold;margin-bottom:12px;">✏️ 放大编辑文案</div>
            <textarea id="rbt-large-edit-area" style="flex:1;background:#141414;border:1px solid #5b6abf;border-radius:8px;padding:16px;font-size:16px;color:#fff;resize:none;font-family:system-ui;margin-bottom:20px;line-height:1.5;box-shadow:inset 0 2px 10px rgba(0,0,0,0.5);"></textarea>
            <div style="display:flex;justify-content:flex-end;gap:12px;">
                <button id="rbt-large-edit-cancel" style="padding:8px 24px;border-radius:6px;background:#333;color:#ccc;border:1px solid #555;cursor:pointer;">取消</button>
                <button id="rbt-large-edit-ok" style="padding:8px 24px;border-radius:6px;background:var(--accent);color:#000;font-weight:bold;border:none;cursor:pointer;">✅ 确定应用修改</button>
            </div>
        `;
        overlay.querySelector('div').appendChild(largeEditOverlay);

        const largeArea = largeEditOverlay.querySelector('#rbt-large-edit-area');

        const displays = overlay.querySelectorAll('.rbt-box-display');
        displays.forEach(disp => {
            disp.addEventListener('dblclick', () => {
                activeEditIndex = disp.dataset.i;
                largeArea.value = disp.value;
                largeEditOverlay.style.display = 'flex';
                largeArea.focus();
            });
            disp.addEventListener('input', () => {
                badRows[disp.dataset.i].text = disp.value;
            });
        });

        largeEditOverlay.querySelector('#rbt-large-edit-cancel').onclick = () => {
            largeEditOverlay.style.display = 'none';
        };

        largeEditOverlay.querySelector('#rbt-large-edit-ok').onclick = () => {
            if (activeEditIndex >= 0) {
                badRows[activeEditIndex].text = largeArea.value;
                const disp = overlay.querySelector(`.rbt-box-display[data-i="${activeEditIndex}"]`);
                disp.value = largeArea.value;
                // Add a visual flash to show update success
                disp.style.borderColor = '#a78bfa';
                setTimeout(() => disp.style.borderColor = '#555', 500);
            }
            largeEditOverlay.style.display = 'none';
        };

        const close = (val) => { document.body.removeChild(overlay); resolve(val); };

        overlay.querySelector('#rbt-batch-edit-cancel').onclick = () => close(null);

        overlay.querySelector('#rbt-batch-edit-ok').onclick = () => {
            const skips = overlay.querySelectorAll('.rbt-skip-chk');
            const disps = overlay.querySelectorAll('.rbt-box-display');
            const result = badRows.map((r, i) => ({
                index: r.index,
                text: disps[i].value,
                skip: skips[i].checked
            }));
            close(result);
        };
    });
}

// ═══════════════════════════════════════════════════════
// 8. TSV Parser (same as overlay panel)
// ═══════════════════════════════════════════════════════

function _parseBatchTSV(raw) {
    const rows = [];
    let i = 0;
    const len = raw.length;
    while (i < len) {
        const cells = [];
        while (i < len) {
            let cell = '';
            if (raw[i] === '"') {
                i++;
                while (i < len) {
                    if (raw[i] === '"') {
                        if (i + 1 < len && raw[i + 1] === '"') { cell += '"'; i += 2; }
                        else { i++; break; }
                    } else { cell += raw[i++]; }
                }
            } else {
                while (i < len && raw[i] !== '\t' && raw[i] !== '\n' && raw[i] !== '\r') { cell += raw[i++]; }
            }
            cells.push(cell);
            if (i < len && raw[i] === '\t') { i++; continue; }
            if (i < len && (raw[i] === '\n' || raw[i] === '\r')) {
                if (raw[i] === '\r' && i + 1 < len && raw[i + 1] === '\n') i++;
                i++;
                break;
            }
        }
        if (cells.length > 0 && cells.some(c => c.trim())) {
            rows.push(cells);
        }
    }
    return rows;
}

// ═══════════════════════════════════════════════════════
// 9. Template helpers
// ═══════════════════════════════════════════════════════

function _renderSubtitlePresetOptions(subtitlePresets, selectedValue = '') {
    const builtinNames = window.REELS_BUILTIN_PRESETS ? Object.keys(window.REELS_BUILTIN_PRESETS) : [];
    const builtins = subtitlePresets.filter(t => builtinNames.includes(t));
    const customs = subtitlePresets.filter(t => !builtinNames.includes(t));

    let html = '';
    if (customs.length > 0) {
        html += `<optgroup label="我的预设">` + customs.map(t => `<option value="${_escHtml(t)}" ${selectedValue === t ? 'selected' : ''}>${_escHtml(t)}</option>`).join('') + `</optgroup>`;
    }
    if (builtins.length > 0) {
        html += `<optgroup label="内置预设">` + builtins.map(t => `<option value="${_escHtml(t)}" ${selectedValue === t ? 'selected' : ''}>${_escHtml(t)}</option>`).join('') + `</optgroup>`;
    }
    return html;
}

function _renderOverlayPresetOptions(cardTemplates, selectedValue = '') {
    const builtinNames = window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS ? Object.keys(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) : [];
    const builtins = cardTemplates.filter(t => builtinNames.includes(t.name));
    const customs = cardTemplates.filter(t => !builtinNames.includes(t.name));

    let html = '';
    if (customs.length > 0) {
        html += `<optgroup label="我的预设">` + customs.map(t => `<option value="${_escHtml(t.name)}" ${selectedValue === t.name ? 'selected' : ''}>${_escHtml(t.name)} (${t.count}层)</option>`).join('') + `</optgroup>`;
    }
    if (builtins.length > 0) {
        html += `<optgroup label="内置预设">` + builtins.map(t => `<option value="${_escHtml(t.name)}" ${selectedValue === t.name ? 'selected' : ''}>${_escHtml(t.name)} (${t.count}层)</option>`).join('') + `</optgroup>`;
    }
    return html;
}

function _renderTaskPresetOptions(taskPresetNames, selectedValue = '') {
    if (taskPresetNames.length === 0) return '';
    return `<optgroup label="我的预设">` + taskPresetNames.map(n => `<option value="${_escHtml(n)}" ${selectedValue === n ? 'selected' : ''}>${_escHtml(n)}</option>`).join('') + `</optgroup>`;
}

function _getSubtitlePresetList() {
    try {
        if (window.ReelsStyleEngine && typeof ReelsStyleEngine.loadSubtitlePresets === 'function') {
            const data = ReelsStyleEngine.loadSubtitlePresets();
            const presetsMap = data.presets || {};
            if (window.REELS_BUILTIN_PRESETS) {
                for (const k of Object.keys(window.REELS_BUILTIN_PRESETS)) {
                    if (!presetsMap[k]) presetsMap[k] = window.REELS_BUILTIN_PRESETS[k];
                }
            }
            return Object.keys(presetsMap);
        }
    } catch (e) { }
    return window.REELS_BUILTIN_PRESETS ? Object.keys(window.REELS_BUILTIN_PRESETS) : [];
}

function _rbtClonePlain(value) {
    if (!value || typeof value !== 'object') return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return { ...value };
    }
}

function _rbtPercentInputToStylePos(value) {
    if (value === '' || value == null) return undefined;
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(0, Math.min(100, n)) / 100;
}

function _rbtBuildFirstSubtitleStyleOverride(presetName = '', xValue = '', yValue = '') {
    let style = {};
    if (presetName && window.ReelsStyleEngine && typeof ReelsStyleEngine.applySubtitlePreset === 'function') {
        const presetStyle = ReelsStyleEngine.applySubtitlePreset(presetName);
        if (presetStyle && typeof presetStyle === 'object') {
            style = _rbtClonePlain(presetStyle);
            style._subtitle_preset = presetName;
        }
    }
    const posX = _rbtPercentInputToStylePos(xValue);
    const posY = _rbtPercentInputToStylePos(yValue);
    if (posX !== undefined) style.pos_x = posX;
    if (posY !== undefined) style.pos_y = posY;
    return Object.keys(style).length ? style : null;
}

function _rbtApplyFirstSubtitleStyleToTask(task, styleOverride) {
    if (!task || !styleOverride) return false;
    task.firstSubtitleStyleOverride = _rbtClonePlain(styleOverride);
    if (!Array.isArray(task.segments) || task.segments.length === 0) return false;
    const first = task.segments[0];
    first.style_override = {
        ...(first.style_override || {}),
        ..._rbtClonePlain(styleOverride),
    };
    return true;
}

function _rbtApplyPendingFirstSubtitleStyle(task) {
    if (!task || !task.firstSubtitleStyleOverride) return false;
    return _rbtApplyFirstSubtitleStyleToTask(task, task.firstSubtitleStyleOverride);
}

function _getOverlayGroupPresetList() {
    const list = [];
    const seen = new Set();

    // 1. 获取覆层组预设
    try {
        const stored = _rbtReadOverlayGroupPresetsRaw();
        let obj = stored ? JSON.parse(stored) : {};
        // 确保内置预设始终存在
        if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
            obj = { ...window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS, ...obj };
        }
        for (const name of Object.keys(obj)) {
            const data = obj[name];
            const layers = Array.isArray(data) ? data : data?.layers;
            list.push({ name, count: Array.isArray(layers) ? layers.length : 0 });
            seen.add(name);
        }
    } catch (e) { }

    // 2. 兼容旧的单卡片模板
    try {
        const stored = localStorage.getItem('reels_card_templates');
        if (stored) {
            const obj = JSON.parse(stored);
            for (const name of Object.keys(obj)) {
                if (!seen.has(name)) {
                    list.push({ name, count: 1 });
                    seen.add(name);
                }
            }
        }
    } catch (e) { }

    return list;
}

function _getOverlayPresetDefinition(presetName) {
    try {
        const groupStored = _rbtReadOverlayGroupPresetsRaw();
        let presets = groupStored ? JSON.parse(groupStored) : {};
        if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
            presets = { ...window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS, ...presets };
        }
        if (presets[presetName]) {
            const data = presets[presetName];
            const layers = Array.isArray(data) ? data : data?.layers;
            if (Array.isArray(layers)) {
                return { kind: 'group', layers: layers };
            }
        }
    } catch (e) { }
    try {
        const cardStored = localStorage.getItem('reels_card_templates');
        if (cardStored) {
            const templates = JSON.parse(cardStored);
            if (templates[presetName]) {
                return { kind: 'card', template: templates[presetName] };
            }
        }
    } catch (e) { }
    return null;
}

const RBT_OVERLAY_PRESET_TEXT_KEYS = new Set([
    'title_text', 'body_text', 'footer_text', 'content', 'scroll_title',
    'title_styled_ranges', 'body_styled_ranges', 'footer_styled_ranges',
    'scroll_title_styled_ranges', 'scroll_styled_ranges',
]);

const RBT_OVERLAY_PRESET_RUNTIME_KEYS = new Set([
    'id', '_img', '_imgLoaded', '_templateName', '_selected', '_exporting',
    '_exportDuration', '_renderedW', '_renderedH', '_renderedY',
    '_blobUrl', '_cachedUrl', '_imageEl', '_videoEl', '_dirty',
    'bind_scroll_overlay_id',
    'image_src_blob', 'image_src_original',
]);

// 验证时额外忽略的 key：这些字段在 JSON.parse(JSON.stringify()) 后
// 容易因浮点精度、undefined→null 转换等原因产生"假不一致"
const RBT_OVERLAY_VERIFY_SKIP_KEYS = new Set([
    ...RBT_OVERLAY_PRESET_RUNTIME_KEYS,
    ...RBT_OVERLAY_PRESET_TEXT_KEYS,
    'start', 'end', 'fixed_text',
]);

function _overlayPresetValueEqual(a, b) {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (typeof a === 'number' || typeof b === 'number') {
        const na = Number(a);
        const nb = Number(b);
        return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 0.01;
    }
    // 对于字符串类型的路径/URL，只比较文件名部分（忽略 blob: / local-media: 等前缀差异）
    if (typeof a === 'string' && typeof b === 'string') {
        if (a.includes('/') || b.includes('/') || a.startsWith('blob:') || b.startsWith('blob:')) {
            const nameA = a.split('/').pop().split('?')[0];
            const nameB = b.split('/').pop().split('?')[0];
            if (nameA && nameB && nameA === nameB) return true;
        }
    }
    return JSON.stringify(a) === JSON.stringify(b);
}

function _overlayMatchesPresetLayer(actual, presetLayer) {
    if (!actual || !presetLayer) return false;
    if ((actual.type || '') !== (presetLayer.type || '')) return false;
    // 只检查预设中明确定义的关键样式属性，跳过运行时/文本/路径等易变字段
    for (const [key, expected] of Object.entries(presetLayer)) {
        if (RBT_OVERLAY_VERIFY_SKIP_KEYS.has(key)) continue;
        // 跳过包含路径的字段（image_src 等），clone 后 blob URL 必然不同
        if (typeof key === 'string' && (key.endsWith('_src') || key.endsWith('_path') || key.endsWith('Path'))) continue;
        if (!_overlayPresetValueEqual(actual[key], expected)) return false;
    }
    return true;
}

function _verifyOverlayGroupPresetApplied(task, presetName) {
    const def = _getOverlayPresetDefinition(presetName);
    if (!def) return { ok: false, reason: '找不到预设' };
    if (!task || task._overlayPresetName !== presetName) {
        return { ok: false, reason: '任务未记录目标预设名' };
    }

    const overlays = Array.isArray(task.overlays) ? task.overlays : [];
    if (def.kind === 'group') {
        if (overlays.length < def.layers.length) {
            return { ok: false, reason: `覆层数量不足：${overlays.length}/${def.layers.length}` };
        }
        for (let i = 0; i < def.layers.length; i++) {
            if (!_overlayMatchesPresetLayer(overlays[i], def.layers[i])) {
                return { ok: false, reason: `第 ${i + 1} 层与预设不一致` };
            }
            const linkedIndex = def.layers.findIndex(layer => layer.id && layer.id === def.layers[i].bind_scroll_overlay_id);
            if (linkedIndex >= 0 && overlays[i].bind_scroll_overlay_id !== overlays[linkedIndex].id) {
                return { ok: false, reason: `第 ${i + 1} 层滚动绑定未正确应用` };
            }
        }
        return { ok: true };
    }

    const cardOv = overlays.find(o => o && (o.type === 'textcard' || !o.type || o.type === ''));
    if (!cardOv) return { ok: false, reason: '未找到文字卡片覆层' };
    const keepKeys = new Set(['id', 'type', 'title_text', 'body_text', 'footer_text', 'start', 'end']);
    for (const [key, expected] of Object.entries(def.template)) {
        if (keepKeys.has(key)) continue;
        if (!_overlayPresetValueEqual(cardOv[key], expected)) {
            return { ok: false, reason: `文字卡片字段 ${key} 未应用` };
        }
    }
    return { ok: true };
}

function _promptOverlayPresetOptions(presetName, tasks, callback) {
    let presetHasScroll = false;
    try {
        let presets = {};
        const groupStored = _rbtReadOverlayGroupPresetsRaw();
        if (groupStored) presets = JSON.parse(groupStored);
        if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
            presets = { ...window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS, ...presets };
        }

        const data = presets[presetName];
        if (data) {
            const layers = Array.isArray(data) ? data : data.layers;
            if (Array.isArray(layers)) {
                presetHasScroll = layers.some(o => o.type === 'scroll');
            }
        }
    } catch (e) { }

    let taskHasScrollText = false;
    for (const task of tasks) {
        if (task.overlays) {
            const scrollOv = _findBatchScrollOverlay(task);
            if (scrollOv) {
                if ((scrollOv.scroll_title || '').trim() || (scrollOv.content || '').trim()) {
                    taskHasScrollText = true;
                    break;
                }
            }
        }
    }

    if (!taskHasScrollText) {
        callback({ addScroll: false, clearText: false });
        return;
    }

    const title = '文案冲突确认';
    let msg = '';
    const safePresetName = _escHtml(presetName);
    if (!presetHasScroll) {
        msg = `当前预设【<span style="color:#4fc1ff;">${safePresetName}</span>】不包含滚动字幕，但您已经填写了滚动文案。<br><br>请选择如何处理您现有的表格文案：`;
    } else {
        msg = `当前预设【<span style="color:#4fc1ff;">${safePresetName}</span>】自带了滚动字幕样式和默认文案。<br><br>请选择如何处理您现有的表格文案：`;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);';
    
    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:24px;width:420px;max-width:90%;box-shadow:0 12px 40px rgba(0,0,0,0.5);color:#d4d4d4;font-family:sans-serif;';
    
    dialog.innerHTML = `
        <div style="font-size:16px;font-weight:bold;margin-bottom:16px;color:#fff;display:flex;align-items:center;gap:8px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#eeb211" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            ${title}
        </div>
        <div style="font-size:14px;line-height:1.6;margin-bottom:24px;">${msg}</div>
        <div style="display:flex;flex-direction:column;gap:10px;">
            <button id="btn-keep" style="padding:10px 16px;background:#0e639c;color:#fff;border:1px solid #1177bb;border-radius:6px;cursor:pointer;font-size:14px;font-weight:bold;text-align:left;display:flex;align-items:center;gap:8px;transition:background 0.2s;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                保留我的文案 (推荐)
            </button>
            <button id="btn-clear" style="padding:10px 16px;background:rgba(255,255,255,0.05);color:#aaa;border:1px solid rgba(255,255,255,0.1);border-radius:6px;cursor:pointer;font-size:14px;text-align:left;display:flex;align-items:center;gap:8px;transition:background 0.2s;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                清空并使用预设默认文案
            </button>
        </div>
    `;
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const btnKeep = dialog.querySelector('#btn-keep');
    const btnClear = dialog.querySelector('#btn-clear');

    btnKeep.onmouseover = () => btnKeep.style.background = '#1177bb';
    btnKeep.onmouseout = () => btnKeep.style.background = '#0e639c';
    
    btnClear.onmouseover = () => { btnClear.style.background = 'rgba(255,60,60,0.15)'; btnClear.style.color = '#ff6b6b'; btnClear.style.borderColor = 'rgba(255,60,60,0.3)'; };
    btnClear.onmouseout = () => { btnClear.style.background = 'rgba(255,255,255,0.05)'; btnClear.style.color = '#aaa'; btnClear.style.borderColor = 'rgba(255,255,255,0.1)'; };

    const handleKey = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cleanup();
            callback({ addScroll: false, clearText: false });
        }
    };
    window.addEventListener('keydown', handleKey);

    const cleanup = () => {
        window.removeEventListener('keydown', handleKey);
        if (document.body.contains(overlay)) {
            document.body.removeChild(overlay);
        }
    };

    btnKeep.addEventListener('click', () => {
        cleanup();
        callback({ addScroll: false, clearText: false });
    });

    btnClear.addEventListener('click', () => {
        cleanup();
        callback({ addScroll: false, clearText: true });
    });
}

function _applyAndVerifyOverlayGroupPresetToTask(task, presetName, opts = { addScroll: false, clearText: false }) {
    _applyOverlayGroupPresetToTask(task, presetName, opts);
    let result = _verifyOverlayGroupPresetApplied(task, presetName);
    if (!result.ok) {
        console.warn('[BatchTable] 覆层预设校验失败，重试一次:', presetName, result.reason);
        _applyOverlayGroupPresetToTask(task, presetName, opts);
        result = _verifyOverlayGroupPresetApplied(task, presetName);
    }
    return result;
}

function _applyOverlayGroupPresetToTask(task, presetName, opts = { addScroll: false, clearText: false }) {
    try {
        // Try group presets first
        let presets = {};
        const groupStored = _rbtReadOverlayGroupPresetsRaw();
        if (groupStored) presets = JSON.parse(groupStored);
        if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
            presets = { ...window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS, ...presets };
        }

        const data = presets[presetName];
        if (data) {
            const layers = Array.isArray(data) ? data : data.layers;
            if (Array.isArray(layers)) {
                const oldOverlays = task.overlays || [];
                const textSlots = _collectBatchOverlayTextSlots(oldOverlays); // 仅用于提取批量表格文案

                const idMap = {};
                // 构建预设覆层，仅迁移文本内容并分配新 ID，记录 ID 映射关系以保留绑定
                const newOverlays = layers.map(layerData => {
                    const clone = JSON.parse(JSON.stringify(layerData));
                    const oldId = clone.id;
                    clone.id = 'ov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                    if (oldId) idMap[oldId] = clone.id;

                    // 从旧覆层中按文字槽位迁移批量表格文案。
                    // fixed_text 层使用预设自带文案，不消费表格文案。
                    if (!clone.fixed_text) {
                        if (clone.type === 'scroll') {
                            // ── 滚动字幕：迁移 scroll_title / content ──
                            if (opts.clearText) {
                                clone.scroll_title = '';
                                clone.content = '';
                            } else {
                                const st = _shiftFirstTextSlot(textSlots.scrollTitle, textSlots.title);
                                const sb = _shiftFirstTextSlot(textSlots.scrollBody, textSlots.body, textSlots.plain);
                                if (st !== undefined) {
                                    clone.scroll_title = st;
                                    clone.scroll_title_styled_ranges = null;
                                }
                                if (sb !== undefined) {
                                    clone.content = sb;
                                    clone.scroll_styled_ranges = null;
                                }
                            }
                        } else if (clone.type === 'text') {
                            const txt = _shiftFirstTextSlot(textSlots.plain, textSlots.title, textSlots.body);
                            if (txt !== undefined) {
                                clone.content = txt;
                                clone.styled_ranges = null;
                            }
                        } else if (clone.type === 'textcard' || !clone.type || clone.type === '') {
                            // ── 文字卡片：标题/正文/结尾分槽迁移，避免同一段默认文案同时进入标题和内容 ──
                            const tt = _shiftFirstTextSlot(textSlots.title, textSlots.plain);
                            const bt = _shiftFirstTextSlot(textSlots.body, textSlots.plain, textSlots.scrollBody);
                            const ft = _shiftFirstTextSlot(textSlots.footer);
                            if (tt !== undefined) {
                                clone.title_text = tt;
                                clone.title_styled_ranges = null;
                            }
                            if (bt !== undefined) {
                                clone.body_text = bt;
                                clone.body_styled_ranges = null;
                            }
                            if (ft !== undefined) {
                                clone.footer_text = ft;
                                clone.footer_styled_ranges = null;
                            }
                        }
                    } else if (clone.type === 'scroll' && opts.clearText) {
                        clone.scroll_title = '';
                        clone.content = '';
                    }
                    return clone;
                });

                // ── 保留预设中没有的覆层类型（如用户独立设置的 scroll、image 等）──
                const presetTypes = new Set(newOverlays.map(o => o.type));
                const survivingOverlays = oldOverlays.filter(o => o && o.type && !presetTypes.has(o.type));

                if (opts.clearText) {
                    survivingOverlays.forEach(o => {
                        if (o.type === 'scroll') {
                            o.scroll_title = '';
                            o.content = '';
                        }
                    });
                }

                if (!presetTypes.has('scroll') && opts.addScroll) {
                    const hasScroll = survivingOverlays.some(o => o.type === 'scroll');
                    if (!hasScroll) {
                        const ReelsOverlay = window.ReelsOverlay;
                        if (ReelsOverlay) {
                            survivingOverlays.push(ReelsOverlay.createScrollOverlay({ start: 0, end: 9999 }));
                        } else {
                            survivingOverlays.push({ id: 'ov_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: 'scroll', scroll_title: '', content: '', start: 0, end: 9999 });
                        }
                    }
                }

                task.overlays = [...newOverlays, ...survivingOverlays];

                // 重新映射“跟随滚动字幕”的绑定 ID，若找不到匹配的目标且存在滚动层，则回退绑定到首个滚动层
                const firstScrollOv = task.overlays.find(o => o.type === 'scroll');
                for (const ov of task.overlays) {
                    if (ov.bind_scroll_overlay_id) {
                        if (idMap[ov.bind_scroll_overlay_id]) {
                            ov.bind_scroll_overlay_id = idMap[ov.bind_scroll_overlay_id];
                        } else if (firstScrollOv) {
                            ov.bind_scroll_overlay_id = firstScrollOv.id;
                        }
                    }
                }

                task._overlayPresetName = presetName;
                return true;
            }
        }

        // Fallback: single card template
        const cardStored = localStorage.getItem('reels_card_templates');
        if (cardStored) {
            const templates = JSON.parse(cardStored);
            const tpl = templates[presetName];
            if (tpl) {
                if (!task.overlays) task.overlays = [];
                // 找到现有的 textcard 覆层，或创建一个新的（不覆盖其它类型覆层）
                let cardOv = _findBatchTextCardOverlay(task);
                if (!cardOv) {
                    const ReelsOverlay = window.ReelsOverlay;
                    if (ReelsOverlay) {
                        cardOv = ReelsOverlay.createTextCardOverlay({
                            title_text: '', body_text: '',
                            start: 0, end: 9999,
                        });
                        cardOv.fixed_text = false;
                        task.overlays.unshift(cardOv); // 插入到数组开头，保留后面的 scroll 等覆层
                    }
                }
                if (cardOv) {
                    const keepKeys = ['id', 'type', 'title_text', 'body_text', 'start', 'end'];
                    for (const [k, v] of Object.entries(tpl)) {
                        if (!keepKeys.includes(k)) cardOv[k] = v;
                    }
                }

                if (opts.clearText) {
                    task.overlays.forEach(o => {
                        if (o && !o.fixed_text && o.type === 'scroll') {
                            o.scroll_title = '';
                            o.content = '';
                        }
                    });
                }

                if (opts.addScroll) {
                    const hasScroll = task.overlays.some(o => o && o.type === 'scroll');
                    if (!hasScroll) {
                        const ReelsOverlay = window.ReelsOverlay;
                        if (ReelsOverlay) {
                            task.overlays.push(ReelsOverlay.createScrollOverlay({ start: 0, end: 9999 }));
                        } else {
                            task.overlays.push({ id: 'ov_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: 'scroll', scroll_title: '', content: '', start: 0, end: 9999 });
                        }
                    }
                }

                task._overlayPresetName = presetName;
                return true;
            }
        }
    } catch (e) {
        console.warn('[BatchTable] 应用覆层预设失败:', presetName, e);
    }
    return false;
}

function _batchAddEmptyRow() {
    const state = window._reelsState;
    const ReelsOverlay = window.ReelsOverlay;
    if (!state || !ReelsOverlay) return;
    const taskName = _generateUniqueCardName(state.tasks, 'card');
    const newTask = _createTaskFromTemplate(state, taskName);
    
    newTask.ttsText = '';
    newTask.ttsVoiceId = '';
    newTask.pipPath = '';
    newTask.status = '';

    _finalizeDerivedTaskInstances(newTask);
    state.tasks.push(newTask);
}

// ═══════════════════════════════════════════════════════
// TTS 音色列表加载
// ═══════════════════════════════════════════════════════

let _rbtVoiceCache = null;

function _rbtTtsProvider() { return localStorage.getItem('rbt_tts_provider') === 'edge' ? 'edge' : 'elevenlabs'; }
function _rbtTtsVoiceStorageKey() { return _rbtTtsProvider() === 'edge' ? 'rbt_tts_voice_edge' : 'rbt_tts_voice'; }
let _rbtVoiceRequest = 0;
async function _rbtLoadVoiceList() {
    const inputEl = document.getElementById('rbt-tts-default-voice');
    if (!inputEl) return;
    const requestId = ++_rbtVoiceRequest;
    const provider = _rbtTtsProvider();
    const edge = provider === 'edge';
    const prevValue = inputEl.value || localStorage.getItem(_rbtTtsVoiceStorageKey()) || (edge ? 'edge:zh-CN-XiaoxiaoNeural' : '');
    const status = document.getElementById('rbt-tts-service-status');
    inputEl.placeholder = '加载中…';
    if (status) status.textContent = edge ? '正在加载微软音色…' : '';
    try {
        if (!_rbtVoiceCache?.length) {
            const response = await apiFetch(API_BASE + (edge ? '/edge-tts/voices' : '/elevenlabs/voices'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ include_shared: true, refresh: true }),
            });
            const data = await response.json();
            if (requestId !== _rbtVoiceRequest || !inputEl.isConnected) return;
            if (!response.ok || data.error) throw new Error(data.error || '加载失败');
            const seen = new Set();
            _rbtVoiceCache = (data.voices || []).filter(v => v?.voice_id && !seen.has(v.voice_id) && seen.add(v.voice_id))
                .sort((a,b) => Number(String(b.locale || '').startsWith('zh')) - Number(String(a.locale || '').startsWith('zh')) || String(a.name).localeCompare(String(b.name)));
        }
        _populateVoiceSelect(inputEl, _rbtVoiceCache, prevValue);
        inputEl.placeholder = '选择音色或输入 ID';
        inputEl.title = edge ? '微软音色以 edge: 开头；可输入 zh-CN、en-US 或音色名搜索' : '选择 ElevenLabs 音色或输入 Voice ID';
        if (status) status.textContent = edge
            ? '微软音色 ' + _rbtVoiceCache.length + ' 个 · 字幕跟随实际配音文案；已有行音色保留'
            : 'ElevenLabs 音色 ' + _rbtVoiceCache.length + ' 个';
    } catch (error) {
        if (requestId !== _rbtVoiceRequest || !inputEl.isConnected) return;
        inputEl.value = prevValue;
        inputEl.placeholder = '音色加载失败，可点击刷新';
        if (status) status.textContent = error.message;
    }
}

function _populateVoiceSelect(inputEl, voices, prevValue) {
    let datalist = document.getElementById('rbt-tts-voices-list');
    if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = 'rbt-tts-voices-list';
        inputEl.parentNode.insertBefore(datalist, inputEl.nextSibling);
    }
    datalist.innerHTML = '';
    for (const v of voices) {
        const opt = document.createElement('option');
        opt.value = v.voice_id;
        const category = v.category ? ` · ${v.category}` : '';
        opt.label = `${v.name || v.voice_id}${category}`;
        opt.textContent = opt.label;
        datalist.appendChild(opt);
    }

    // 持久化选择
    inputEl.onchange = () => {
        localStorage.setItem(_rbtTtsVoiceStorageKey(), inputEl.value.trim());
    };

    // 恢复上次选择
    if (prevValue && inputEl.value !== prevValue) {
        inputEl.value = prevValue;
    }
}

// ═══════════════════════════════════════════════════════
// AI 处理与一键配音生成
// ═══════════════════════════════════════════════════════

async function _rbtResolveClipConcatBaseDir() {
    const outputEl = document.getElementById('reels-output-dir');
    const configured = outputEl && outputEl.value ? outputEl.value.trim() : '';
    if (configured) return configured.replace(/[\\/]+$/, '') || configured;
    if (window.electronAPI && window.electronAPI.getDownloadsPath) {
        try {
            const downloads = await window.electronAPI.getDownloadsPath();
            if (downloads) return String(downloads).replace(/[\\/]+$/, '') || String(downloads);
        } catch (_) { }
    }
    return '~/Downloads';
}

function _rbtBuildClipConcatFolderName(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d}_${hh}${mm}_片段拼接`;
}

function _rbtSanitizeFileBaseName(name, fallback = 'concat') {
    const cleaned = String(name || '').replace(/\.[^.\\/]+$/, '').replace(/[<>:"/\\|?*\r\n\t]+/g, '_').replace(/\s+/g, '_').replace(/[. ]+$/g, '').trim();
    return cleaned || fallback;
}

async function _rbtGetClipConcatOutputPath(task, idx) {
    const baseDir = await _rbtResolveClipConcatBaseDir();
    const sep = baseDir.includes('\\') ? '\\' : '/';
    const outputDir = `${baseDir}${sep}${_rbtBuildClipConcatFolderName()}${sep}_拼接素材`;
    const rawName = task.exportName || task.baseName || task.fileName || task.clipPoolDir || `task_${idx + 1}`;
    const baseName = _rbtSanitizeFileBaseName(rawName, `task_${idx + 1}`);
    return `${outputDir}${sep}${String(idx + 1).padStart(3, '0')}_${baseName}_concat.mp4`;
}

function _rbtDeriveConcatTempPath(outputPath, step) {
    const dot = String(outputPath).lastIndexOf('.');
    const suffix = `_tmp_${String(step).padStart(3, '0')}`;
    if (dot > 0) return `${outputPath.slice(0, dot)}${suffix}${outputPath.slice(dot)}`;
    return `${outputPath}${suffix}.mp4`;
}

function _rbtSortClipPool(files, order = 'name') {
    const arr = (files || []).slice();
    if (order === 'mtime') {
        arr.sort((a, b) => (a.mtime || 0) - (b.mtime || 0) || _naturalSortByName(a, b));
    } else if (order === 'random') {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
    } else {
        arr.sort(_naturalSortByName);
    }
    return arr;
}

async function _rbtLoadClipPoolFromDir(dir, order = 'name') {
    if (!window.electronAPI || !window.electronAPI.scanDirectory) {
        throw new Error('请在桌面应用中使用片段池功能');
    }
    const files = await window.electronAPI.scanDirectory(dir);
    const clips = (files || []).filter(f => {
        if (!f || f.isDirectory) return false;
        const ext = String(f.name || '').split('.').pop().toLowerCase();
        return _CLIP_POOL_VIDEO_EXTS.has(ext);
    });
    return _rbtSortClipPool(clips, order);
}

async function _rbtConcatClipsViaLegacyIpc(clipPaths, outputPath) {
    if (!window.electronAPI || !window.electronAPI.concatVideo) {
        throw new Error('当前版本缺少片段拼接接口，请重启应用后再试');
    }
    if (!Array.isArray(clipPaths) || clipPaths.length < 2) {
        throw new Error('至少需要 2 个视频片段');
    }

    let currentPath = clipPaths[0];
    const tempPaths = [];
    for (let i = 1; i < clipPaths.length; i++) {
        const isLast = i === clipPaths.length - 1;
        const nextOutput = isLast ? outputPath : _rbtDeriveConcatTempPath(outputPath, i);
        if (!isLast) tempPaths.push(nextOutput);
        await window.electronAPI.concatVideo({
            introPath: currentPath,
            mainPath: clipPaths[i],
            outputPath: nextOutput,
            transition: 'none',
            transDuration: 0,
            targetWidth: 1080,
            targetHeight: 1920,
            fps: 30,
        });
        currentPath = nextOutput;
    }

    for (const p of tempPaths) {
        try {
            if (window.electronAPI.apiCall) {
                await window.electronAPI.apiCall('file/delete', { path: p });
            }
        } catch (_) { }
    }
    return { output_path: outputPath, outputPath, clip_count: clipPaths.length };
}

async function _rbtPickClipPool(idx) {
    const state = window._reelsState;
    const task = state && state.tasks && state.tasks[idx];
    if (!task) return;
    if (!window.electronAPI || !window.electronAPI.selectDirectory) {
        showToast('请在桌面应用中使用片段池功能', 'error');
        return;
    }
    const dir = await window.electronAPI.selectDirectory();
    if (!dir) return;
    try {
        const order = task.clipOrder || 'name';
        const clips = await _rbtLoadClipPoolFromDir(dir, order);
        if (clips.length < 2) {
            showToast('片段池至少需要 2 个视频文件', 'error');
            return;
        }
        task.clipPoolDir = dir;
        task.clipPool = clips.map(c => ({ name: c.name, path: c.path, mtime: c.mtime || 0, size: c.size || 0 }));
        task.concatStatus = '';
        _skipNextApply = true;
        _renderBatchTable();
        showToast(`已载入 ${clips.length} 个片段，默认按${order === 'mtime' ? '修改时间' : order === 'random' ? '随机' : '文件名'}排序`, 'success');
    } catch (e) {
        showToast('载入片段池失败: ' + e.message, 'error', 6000);
    }
}

async function _rbtConcatTaskClipPool(idx) {
    try { _applyBatchTableChanges(); } catch (_) { }
    const state = window._reelsState;
    const task = state && state.tasks && state.tasks[idx];
    if (!task) return;
    if (!task.clipPoolDir) {
        await _rbtPickClipPool(idx);
    }
    if (!task.clipPoolDir) return;

    try {
        const order = task.clipOrder || 'name';
        const freshClips = await _rbtLoadClipPoolFromDir(task.clipPoolDir, order);
        if (freshClips.length < 2) throw new Error('片段池至少需要 2 个视频文件');
        task.clipPool = freshClips.map(c => ({ name: c.name, path: c.path, mtime: c.mtime || 0, size: c.size || 0 }));
        task.concatStatus = 'generating';
        _skipNextApply = true;
        _renderBatchTable();

        const outputPath = await _rbtGetClipConcatOutputPath(task, idx);
        const clipPaths = task.clipPool.map(c => c.path);
        let outPath = outputPath;
        const result = await window.electronAPI.apiCall('media/concat-clips', {
            clips: clipPaths,
            output_path: outputPath,
            target_width: 1080,
            target_height: 1920,
            fps: 30,
            crf: 18,
            preset: 'fast',
        });
        if (!result || !result.success) {
            const errMsg = result?.error || '拼接失败';
            if (String(errMsg).includes('未知接口: media/concat-clips')) {
                const fallback = await _rbtConcatClipsViaLegacyIpc(clipPaths, outputPath);
                outPath = fallback.output_path || fallback.outputPath || outputPath;
            } else {
                throw new Error(errMsg);
            }
        } else {
            outPath = result.data?.output_path || result.data?.outputPath || outputPath;
        }
        task.concatVideoPath = outPath;
        task.concatStatus = 'done';
        _setTaskSingleBackground(task, outPath, { clearBgSrcUrl: true });
        if (!task.baseName) task.baseName = _rbtSanitizeFileBaseName(task.exportName || task.fileName || `task_${idx + 1}`);
        if (!task.fileName) task.fileName = `${task.baseName}.mp4`;

        _skipNextApply = true;
        _renderBatchTable();
        if (typeof _renderTaskList === 'function') _renderTaskList();
        if (typeof showToast === 'function') showToast(`✅ 已拼接 ${task.clipPool.length} 个片段并设为背景`, 'success', 5000);
    } catch (e) {
        task.concatStatus = 'error';
        _skipNextApply = true;
        _renderBatchTable();
        showToast('片段拼接失败: ' + e.message, 'error', 8000);
    }
}

function _rbtBuildVoiceoverBatchFolderName(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d}_${hh}${mm}_一键配音`;
}

async function _rbtResolveVoiceoverOutputBaseDir() {
    const customDir = localStorage.getItem('vk_default_output_dir');
    if (customDir && customDir.trim()) return customDir.trim().replace(/[\\/]+$/, '') || customDir.trim();
    if (window.electronAPI && window.electronAPI.getDownloadsPath) {
        try {
            const downloads = await window.electronAPI.getDownloadsPath();
            if (downloads) return String(downloads).replace(/[\\/]+$/, '') || String(downloads);
        } catch (_) { }
    }
    return '~/Downloads';
}

async function _rbtCreateVoiceoverBatchOutputDir() {
    const baseDir = await _rbtResolveVoiceoverOutputBaseDir();
    const sep = baseDir.includes('\\') ? '\\' : '/';
    return `${baseDir}${sep}${_rbtBuildVoiceoverBatchFolderName()}`;
}

async function _runSingleTTS(idx, batchOutputDir = '') {
    // 先同步 DOM 输入框的值到 state
    try { _applyBatchTableChanges(); } catch (e) { }
    const state = window._reelsState;
    if (!state || !state.tasks[idx]) return;
    const task = state.tasks[idx];

    if (!task.ttsText) {
        alert(`第 ${idx + 1} 行缺少人声-配音文案，无法生成配音。`);
        return;
    }
    const defaultVoice = document.getElementById('rbt-tts-default-voice')?.value || (_rbtTtsProvider() === 'edge' ? 'edge:zh-CN-XiaoxiaoNeural' : 'pNInz6obpgDQGcFmaJcg');
    const voiceId = (task.ttsVoiceId || defaultVoice).trim(); // 完整音色标识决定后台，旧任务仍使用原服务
    task.ttsVoiceId = voiceId; // 队列快照保存最终音色，避免调用时被全局默认值改变
    const ttsProvider = voiceId.startsWith('edge:') ? 'edge' : 'elevenlabs';
    const modelId = localStorage.getItem('rbt_tts_model') || 'eleven_v3';
    const tailInput = document.getElementById('rbt-tts-tail-silence');
    const rawTailSilence = parseFloat(tailInput?.value || '0');
    const tailSilence = Number.isFinite(rawTailSilence) && rawTailSilence > 0
        ? Math.max(0.1, Math.min(5, rawTailSilence))
        : 0;
    if (tailInput) {
        tailInput.value = String(tailSilence);
        localStorage.setItem('rbt_tts_tail_silence', String(tailSilence));
    }

    task.status = 'generating';
    _skipNextApply = true;
    _renderBatchTable();

    try {
        const gladiaKeysText = document.getElementById('gladia-keys')?.value || '';
        const gladiaKeys = gladiaKeysText.split('\n').map(k => k.trim()).filter(Boolean);
        const language = document.getElementById('rbt-align-lang')?.value || '英语';
        const response = await apiFetch(`${API_BASE}/tts/workflow`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: task.ttsText,
                voice_id: voiceId,
                tts_provider: ttsProvider,
                model_id: modelId,
                task_index: idx,
                need_split: false,
                max_duration: 60,
                subtitle_text: task.txtContent || '', // 「人声-断行文案」列用于 Gladia 转录对齐生成 SRT
                tail_silence: tailSilence,
                export_mp4: false,
                export_fcpxml: false,
                seamless_fcpxml: true,
                output_dir: batchOutputDir || '',
                gladia_keys: gladiaKeys,
                language: language
            })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '生成失败');

        task.audioPath = data.audio_path;
        task.srtPath = ''; task.segments = []; task.aligned = false; // 新音频不能沿用旧字幕
        if (data.subtitle_error) showToast(data.subtitle_error, 'warning', 8000);
        if (data.srt_path) {
            task.srtPath = data.srt_path;
            // 自动加载srt用于对齐预览（只有路径，无File对象，走Electron回退）
            _readSrtFileToTask(task, null);
            task.aligned = true; // 既然同时成功了srt，说明是对齐完的结果
        }
        task.status = 'success';
        _skipNextApply = true;
        _renderBatchTable();

        // 5秒后清除成功状态，恢复原样
        setTimeout(() => {
            if (task.status === 'success') {
                task.status = '';
                _renderBatchTable();
            }
        }, 5000);

        return true;
    } catch (e) {
        task.status = 'error';
        _skipNextApply = true;
        _renderBatchTable();
        showToast('生成报错: ' + e.message, 'error', 8000);
        return false;
    }
}

async function _runTTSBatchProcessing() {
    // 先同步 DOM 输入框的值到 state，确保能读到用户填入的数据
    try { _applyBatchTableChanges(); } catch (e) { }
    const indices = _getSelectedIndices();
    const tasks = window._reelsState?.tasks || [];
    if (tasks.length === 0) {
        alert('❌ 任务拒绝执行\n\n【原因】：当前表格完全为空。\n【操作】：请先新建任务行，或从上方导入媒体/通过链接粘贴数据。');
        return false;
    }

    const targetIdxs = indices.length > 0 ? indices : tasks.map((_, i) => i);

    // Validate if there's actually anything to TTS
    const hasTtsText = targetIdxs.some(idx => tasks[idx].ttsText && tasks[idx].ttsText.trim().length > 0);
    if (!hasTtsText) {
        alert('❌ 任务拒绝执行 (数据缺失)\n\n【缺失数据列】：「人声-配音文案」列内容为空\n【当前需要】    ：生成配音必须依赖该列提供的纯文本内容。\n\n【建议操作】：\n1. 手动双击「人声-配音文案」单元格输入文字；\n2. 或者先在「人声-原文案」列填入长文本，并点击【🪄 AI处理文案】让模型自动填充该列。');
        return false;
    }

    const hasExistingAudio = targetIdxs.some(idx => tasks[idx].ttsText && tasks[idx].ttsText.trim() && tasks[idx].audioPath);
    let forceOverwrite = false;
    if (hasExistingAudio) {
        forceOverwrite = confirm('⚠️ 检测到目标中存在【已经生成过配音】的行。\n\n▶ 点击【确定】则强制重新生成，覆盖它们的原配音和原对齐。\n▶ 点击【取消】则保护它们，仅对还没生成的空白行进行生成。\n\n是否强行覆盖重造已有音频？');
    }

    let success = 0;
    let failed = 0;
    const batchOutputDir = await _rbtCreateVoiceoverBatchOutputDir();
    for (const idx of targetIdxs) {
        const task = tasks[idx];
        const canRun = (forceOverwrite || !task.audioPath) && task.ttsText && task.ttsText.trim().length > 0;
        if (canRun) {
            const isSuccess = await _runSingleTTS(idx, batchOutputDir);
            if (isSuccess) success++;
            else failed++;
        }
    }

    if (failed > 0) {
        showToast(`批量配音结束：处理 ${success} 行，失败 ${failed} 行，请查看具体报错！`, 'error', 5000);
    } else if (success > 0) {
        showToast(`批量配音生成完毕，共成功处理 ${success} 行，输出: ${batchOutputDir}`, 'success');
    } else {
        showToast(`没有可用行需要生成配音`, 'info');
    }
}

async function _runWorkflowAcrossAllTabs(modeBtnId) {
    if (!_batchTableState.tabs.length) return false;
    try { _applyBatchTableChanges(); } catch (_) { }
    _syncTasksToActiveTab();

    const originalTabId = _batchTableState.activeTabId;
    const tabIds = _batchTableState.tabs.map(tab => tab.id);
    let processedTabs = 0;
    let failedTabs = 0;

    for (let tabPos = 0; tabPos < tabIds.length; tabPos++) {
        const tabId = tabIds[tabPos];
        const tab = _batchTableState.tabs.find(t => t.id === tabId);
        if (!tab) continue;
        _switchToTab(tabId, { skipSave: true });
        const tasks = window._reelsState?.tasks || [];
        showToast(`跨标签工作流 ${tabPos + 1}/${tabIds.length}：${tab.name}`, 'info');

        try {
            if (modeBtnId === 'rbt-ai-gemini-btn') {
                if (tasks.some(t => String(t.aiScript || '').trim())) {
                    const ok = await _runGeminiBatchProcessing();
                    if (!ok) failedTabs++;
                    else processedTabs++;
                }
            } else if (modeBtnId === 'rbt-ai-tts-all-btn') {
                if (tasks.some(t => String(t.ttsText || '').trim())) {
                    await _runTTSBatchProcessing();
                    processedTabs++;
                }
            } else {
                let stageOk = true;
                if (tasks.some(t => String(t.aiScript || '').trim())) {
                    stageOk = await _runGeminiBatchProcessing();
                }
                if (stageOk && tasks.some(t => String(t.ttsText || '').trim())) {
                    await _runTTSBatchProcessing();
                    const alignIndices = tasks.map((task, idx) => ({ task, idx }))
                        .filter(({ task }) => String(task.txtContent || '').trim() && task.audioPath && !task.aligned && !task.srtPath)
                        .map(({ idx }) => idx);
                    if (alignIndices.length) {
                        await _batchAlignAllTasks({
                            targetIndices: alignIndices,
                            forceRealign: false,
                            forceTranscribe: false,
                        });
                    }
                }
                if (stageOk) processedTabs++;
                else failedTabs++;
            }
        } catch (error) {
            failedTabs++;
            console.error(`[跨标签工作流] ${tab.name} 失败:`, error);
        }
        _syncTasksToActiveTab();
    }

    if (_batchTableState.tabs.some(tab => tab.id === originalTabId)) {
        _switchToTab(originalTabId, { skipSave: true });
    }
    if (typeof _batchAutoSave === 'function') _batchAutoSave();
    showToast(`跨标签工作流完成：成功 ${processedTabs} 个标签${failedTabs ? `，失败 ${failedTabs} 个` : ''}`, failedTabs ? 'info' : 'success', 6000);
    return failedTabs === 0;
}

async function _runGeminiBatchProcessing() {
    if (typeof window.hasUnsavedGeminiSettings === 'function' && window.hasUnsavedGeminiSettings()) {
        showToast('Gemini 设置有未保存的修改。请先到“设置”点击“保存 Gemini 配置”，否则 AI 会继续使用旧配置。', 'warning', 7000);
        return false;
    }
    // 先同步 DOM 输入框的值到 state，确保能读到用户填入的数据
    try { _applyBatchTableChanges(); } catch (e) { }
    const indices = _getSelectedIndices();
    const tasks = window._reelsState?.tasks || [];
    if (tasks.length === 0) {
        alert('❌ 任务拒绝执行\n\n【原因】：当前表格完全为空。\n【操作】：请先新建任务行并填入数据。');
        return false;
    }
    const targetIdxs = indices.length > 0 ? indices : tasks.map((_, i) => i);

    showToast(`正在使用 AI 处理 ${targetIdxs.length} 行文案...`, 'info');

    try {
        const payload = targetIdxs.map(idx => ({
            idx: idx,
            text: tasks[idx].aiScript || ''
        })).filter(o => o.text.trim().length > 0);

        if (payload.length === 0) {
            alert('❌ 任务拒绝执行 (数据缺失)\n\n【缺失数据列】：「人声-原文案」列内容为空\n【当前需要】    ：大模型需要基于原始参考素材进行改写。\n\n【建议操作】：请先在「人声-原文案」列中双击粘贴您想要改写的长文章、大纲或参考内容，然后再执行此操作。');
            return false;
        }

        let lineBreakMode = 'ai';
        let lbMaxChars = 16;
        try {
            const settingsResp = await apiFetch('settings/gemini-keys');
            const settingsData = await settingsResp.json();
            if (settingsData) {
                if (settingsData.lineBreakMode) lineBreakMode = settingsData.lineBreakMode;
                if (settingsData.lbMaxChars) lbMaxChars = settingsData.lbMaxChars;
            }
        } catch (e) {
            console.warn('获取 Gemini 设置失败，使用默认 AI 断行', e);
        }

        const response = await apiFetch(`${API_BASE}/ai/process-scripts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scripts: payload })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'AI处理请求失败');

        console.log('[AI文案] API 响应数据:', JSON.stringify(data).slice(0, 500));
        console.log('[AI文案] results 类型:', typeof data.results, '长度:', Array.isArray(data.results) ? data.results.length : 'N/A');

        let count = 0;
        if (data.results && Array.isArray(data.results)) {
            for (const res of data.results) {
                console.log(`[AI文案] 结果项 idx=${res.idx}, tts_text=${(res.tts_text || '').slice(0, 50)}...`);
                const task = tasks[res.idx];
                if (task) {
                    if (task.ttsText !== res.tts_text) {
                        task.audioPath = null;
                        task.srtPath = null;
                        task.aligned = false;
                    }
                    task.ttsText = res.tts_text;
                    if (lineBreakMode === 'script') {
                        // 使用系统自带脚本断行，剔除大括号和尖括号标签
                        const cleanText = (res.tts_text || '').replace(/\[.*?\]/g, '').replace(/<.*?>/g, '').trim();
                        task.txtContent = typeof _rbtSmartLineBreak === 'function' ? _rbtSmartLineBreak(cleanText, lbMaxChars) : cleanText;
                    } else {
                        // AI 原生断行
                        task.txtContent = res.display_text;
                    }
                    // --- 自动比对：提取字母/数字/汉字（忽略标点和换行空格），如果不一致则报警 ---
                    const normalizeText = (str) => {
                        let s = (str || '');
                        s = s.replace(/\[.*?\]/g, ''); // 去除方括号标签 e.g. [calm]
                        s = s.replace(/<.*?>/g, ''); // 去除尖括号标签 e.g. <break>
                        return s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').toLowerCase();
                    };
                    const origNorm = normalizeText(task.aiScript);

                    const newNorm = normalizeText(res.display_text);
                    task.aiTextDiffWarning = (origNorm !== newNorm);

                    const ttsNorm = normalizeText(res.tts_text);
                    task.aiTtsDiffWarning = (origNorm !== ttsNorm);

                    if (task.aiTextDiffWarning || task.aiTtsDiffWarning) {
                        console.warn(`[AI文案] 警告！任务 ${res.idx} 存在字符篡改`);
                    }
                    // -------------------------------------------------------------------------

                    count++;
                } else {
                    console.warn(`[AI文案] 找不到 idx=${res.idx} 对应的任务 (tasks.length=${tasks.length})`);
                }
            }
        } else {
            console.warn('[AI文案] data.results 不是数组!', data);
        }
        _skipNextApply = true; // AI 结果已直接写入 state
        _renderBatchTable();

        if (count === 0 && payload.length > 0) {
            alert(`⚠️ AI 处理完成但未能解析出结果\n\n发送了 ${payload.length} 条原文案，但模型返回的内容无法正确解析为 TTS 文案。\n\n可能原因：\n1. 模型输出格式异常（未按 [编号] 格式返回）\n2. API 返回了空内容\n\n请打开开发者工具 (Ctrl+Shift+I) 查看控制台日志，搜索 "[AI文案]" 获取详细信息。`);
            showToast(`⚠️ AI处理完成但解析结果为 0 条 (期望 ${payload.length} 条)`, 'error');
        } else {
            showToast(`✅ AI文案处理完成 (共 ${count}/${payload.length} 行)`, 'success');
        }
        return true;
    } catch (e) {
        showToast('AI处理报错: ' + e.message, 'error');
        return false;
    }
}

function _applyAiPresetBatch() {
    const STORAGE_KEY = 'rbt_task_presets';
    let presets = {};
    try { presets = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem('rbt_ai_presets') || '{}'); } catch (e) { }

    // 动态获取可用的预设列表
    const subtitlePresets = typeof _getSubtitlePresetList === 'function' ? _getSubtitlePresetList() : [];
    const cardTemplates = typeof _getOverlayGroupPresetList === 'function' ? _getOverlayGroupPresetList() : [];

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);';
    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1a1a2e;border:1px solid #444;border-radius:12px;padding:24px;min-width:420px;max-width:520px;color:#eee;font-size:13px;box-shadow:0 12px 40px rgba(0,0,0,0.8);';

    const presetNames = Object.keys(presets);
    const optionsHtml = _renderTaskPresetOptions(presetNames, '');

    const stplOptionsHtml = _renderSubtitlePresetOptions(subtitlePresets, '');
    const ctplOptionsHtml = _renderOverlayPresetOptions(cardTemplates, '');

    dialog.innerHTML = `
        <h3 style="margin:0 0 16px;font-size:16px;color:#a78bfa;">📝 任务预设管理</h3>
        <div style="margin-bottom:12px;">
            <label style="font-size:12px;color:#aaa;">选择已保存的任务完整预设</label>
            <select id="_preset-sel" style="width:100%;padding:8px;background:#222;color:#fff;border:1px solid #555;border-radius:6px;margin-top:4px;font-size:13px;">
                <option value="">-- 选择组合预设 --</option>
                ${optionsHtml}
            </select>
        </div>
        <div style="border-top:1px solid #333;padding-top:12px;margin-bottom:12px;">
            <label style="font-size:12px;color:#aaa;">或单独配置各项参数组合</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px;">
                <div><label style="font-size:11px;color:#888;">Voice ID</label><input id="_p-voice" style="width:100%;padding:5px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:11px;" placeholder="如 pNInz6obpgDQGcFmaJcg"></div>
                <div><label style="font-size:11px;color:#888;">动态字幕模版</label><select id="_p-tpl" style="width:100%;padding:5px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:11px;"><option value="">无</option>${stplOptionsHtml}</select></div>
                <div><label style="font-size:11px;color:#888;">覆层预设</label><select id="_p-overlay" style="width:100%;padding:5px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:11px;"><option value="">无</option>${ctplOptionsHtml}</select></div>
                <div><label style="font-size:11px;color:#888;">背景缩放 %</label><input id="_p-bgscale" type="number" value="100" min="50" max="300" style="width:100%;padding:5px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:11px;"></div>
                <div><label style="font-size:11px;color:#888;">背景变速 %</label><input id="_p-bgdurscale" type="number" value="100" min="10" max="500" style="width:100%;padding:5px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:11px;"></div>
                <div><label style="font-size:11px;color:#888;">音频变速 %</label><input id="_p-audioscale" type="number" value="100" min="10" max="500" style="width:100%;padding:5px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:11px;"></div>
            </div>
        </div>
        <div style="margin-bottom:12px;padding:10px;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.22);border-radius:6px;">
            <label style="font-size:12px;color:#c7d2fe;">应用范围</label>
            <select id="_p-scope" style="width:100%;padding:6px;margin-top:5px;background:#222;color:#fff;border:1px solid #555;border-radius:5px;font-size:12px;">
                <option value="selected">当前标签的选中行（未选则当前标签全部）</option>
                <option value="current">当前标签全部任务</option>
                <option value="tabs">勾选的多个标签页</option>
                <option value="all">全部标签页（一键批量设置）</option>
            </select>
            <div id="_p-tab-list" style="display:none;max-height:120px;overflow:auto;margin-top:7px;padding:6px;background:rgba(0,0,0,.2);border-radius:4px;">
                ${_batchTableState.tabs.map(tab => `
                    <label style="display:flex;align-items:center;gap:6px;padding:3px 2px;font-size:11px;color:#ccc;cursor:pointer;">
                        <input type="checkbox" class="_p-tab-check" value="${_escHtml(tab.id)}" ${tab.id === _batchTableState.activeTabId ? 'checked' : ''}>
                        <span>${_escHtml(tab.name)}</span>
                        <span style="margin-left:auto;color:#777;">${(tab.tasks || []).length} 条</span>
                    </label>`).join('')}
            </div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
            <input id="_p-save-name" style="flex:1;padding:6px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:12px;" placeholder="预设名称（可保存）">
            <button id="_p-save-btn" style="padding:6px 12px;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">💾 保存</button>
            ${presetNames.length > 0 ? '<button id="_p-del-btn" style="padding:6px 10px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">🗑</button>' : ''}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #333;padding-top:12px;">
            <button id="_p-cancel" style="padding:8px 20px;background:#333;color:#aaa;border:1px solid #555;border-radius:6px;cursor:pointer;">取消</button>
            <button id="_p-apply" style="padding:8px 20px;background:linear-gradient(135deg,#a855f7,#6366f1);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">✅ 一键应用设置</button>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    const sel = dialog.querySelector('#_preset-sel');
    const scopeSelect = dialog.querySelector('#_p-scope');
    const tabList = dialog.querySelector('#_p-tab-list');
    scopeSelect.addEventListener('change', () => {
        tabList.style.display = scopeSelect.value === 'tabs' ? 'block' : 'none';
    });
    const fillFields = (p) => {
        dialog.querySelector('#_p-voice').value = p.voiceId || '';
        dialog.querySelector('#_p-tpl').value = p.tpl || '';
        dialog.querySelector('#_p-overlay').value = p.overlayTpl || '';
        dialog.querySelector('#_p-bgscale').value = p.bgScale || 100;
        dialog.querySelector('#_p-bgdurscale').value = p.bgDurScale || 100;
        dialog.querySelector('#_p-audioscale').value = p.audioDurScale || 100;
    };
    sel.addEventListener('change', () => {
        const p = presets[sel.value];
        if (p) fillFields(p);
    });

    dialog.querySelector('#_p-save-btn').addEventListener('click', () => {
        const name = dialog.querySelector('#_p-save-name').value.trim();
        if (!name) { alert('请输入预设名称'); return; }
        presets[name] = _readPresetFields(dialog);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
        showToast(`预设「${name}」已保存`, 'success');
    });

    dialog.querySelector('#_p-del-btn')?.addEventListener('click', () => {
        const name = sel.value;
        if (!name) { alert('请先选择要删除的预设'); return; }
        if (!confirm(`确定删除预设「${name}」？`)) return;
        delete presets[name];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
        sel.querySelector(`option[value="${name}"]`)?.remove();
        showToast(`预设「${name}」已删除`, 'info');
    });

    dialog.querySelector('#_p-cancel').addEventListener('click', () => overlay.remove());

    dialog.querySelector('#_p-apply').addEventListener('click', () => {
        const preset = _readPresetFields(dialog);
        const scope = scopeSelect.value;
        try { _applyBatchTableChanges(); } catch (_) { }
        _syncTasksToActiveTab();

        const applyPreset = (task) => {
            if (!task) return;
            if (preset.voiceId) task.ttsVoiceId = preset.voiceId;
            if (preset.tpl) task._subtitlePreset = preset.tpl;
            if (preset.overlayTpl) {
                task._overlayPresetName = preset.overlayTpl;
                _applyOverlayGroupPresetToTask(task, preset.overlayTpl);
            }
            task.bgScale = preset.bgScale;
            task.bgDurScale = preset.bgDurScale;
            task.audioDurScale = preset.audioDurScale;
        };

        let targets = [];
        const indices = _getSelectedIndices();
        const activeTab = _getActiveTab();
        if (scope === 'selected') {
            const currentTasks = window._reelsState.tasks || [];
            targets = (indices.length > 0 ? indices.map(i => currentTasks[i]) : currentTasks).filter(Boolean);
        } else if (scope === 'current') {
            targets = activeTab?.tasks || [];
        } else {
            const selectedTabIds = scope === 'all'
                ? new Set(_batchTableState.tabs.map(tab => tab.id))
                : new Set(Array.from(dialog.querySelectorAll('._p-tab-check:checked')).map(el => el.value));
            if (selectedTabIds.size === 0) {
                alert('请至少勾选一个标签页');
                return;
            }
            for (const tab of _batchTableState.tabs) {
                if (selectedTabIds.has(tab.id)) targets.push(...(tab.tasks || []));
            }
        }
        targets.forEach(applyPreset);

        // 如果直接修改了标签存储，重新载入当前标签以显示最新结果。
        if (scope !== 'selected' && activeTab) _loadTabTasks(activeTab);
        overlay.remove();
        _skipNextApply = true;
        _renderBatchTable();
        if (typeof _batchAutoSave === 'function') _batchAutoSave();
        showToast(`预设已应用到 ${targets.length} 个任务`, 'success');
    });
}

function _readPresetFields(dialog) {
    return {
        voiceId: dialog.querySelector('#_p-voice').value.trim(),
        tpl: dialog.querySelector('#_p-tpl').value.trim(),
        overlayTpl: dialog.querySelector('#_p-overlay').value.trim(),
        bgScale: parseInt(dialog.querySelector('#_p-bgscale').value) || 100,
        bgDurScale: parseInt(dialog.querySelector('#_p-bgdurscale').value) || 100,
        audioDurScale: parseInt(dialog.querySelector('#_p-audioscale').value) || 100,
    };
}

async function _openAISettingsModal() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(5px);';
    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1a1a2e;border:1px solid #444;border-radius:12px;padding:24px;width:600px;max-width:90vw;color:#eee;font-size:13px;box-shadow:0 12px 40px rgba(0,0,0,0.8);';

    dialog.innerHTML = `
        <h3 style="margin:0 0 16px;font-size:16px;color:#a78bfa;">⚙️ AI 设置 (Gemini)</h3>
        <p style="font-size:12px;color:#aaa;margin-bottom:16px;">配置用于 <b>文案改写流水线</b> 的 Gemini API Keys。支持轮询。</p>
        
        <div style="margin-bottom:12px;">
            <label style="display:block;font-size:12px;color:#ccc;margin-bottom:6px;">API Keys (每行一个)</label>
            <textarea id="_ai-keys" rows="4" style="width:100%;box-sizing:border-box;padding:8px;background:#222;color:#fff;border:1px solid #555;border-radius:6px;font-size:12px;font-family:monospace;resize:vertical;" placeholder="每行一个 API Key&#10;支持 AIzaSy... (旧格式) 和 AQ... (新格式)"></textarea>
        </div>

        <div style="margin-bottom:12px;">
            <label style="display:block;font-size:12px;color:#ccc;margin-bottom:6px;">模型选择</label>
            <select id="_ai-model" style="width:100%;padding:8px;background:#222;color:#fff;border:1px solid #555;border-radius:6px;font-size:13px;cursor:pointer;">
                <option value="gemini-3.5-flash-lite" selected>⚡ gemini-3.5-flash-lite (GA·免费推荐)</option>
                <option value="gemini-3.1-flash-lite">⚡ gemini-3.1-flash-lite (GA·低成本备用)</option>
                <option value="gemini-3.5-flash">🧠 gemini-3.5-flash (GA·高质量)</option>
                <option value="gemini-2.5-flash">⚡ gemini-2.5-flash (GA·快速稳定)</option>
                <option value="gemini-2.5-flash-lite">⚡ gemini-2.5-flash-lite (GA·兼容备用)</option>
                <option value="gemini-2.5-pro">🧠 gemini-2.5-pro (GA·强推理)</option>
                <option value="gemini-3.1-pro-preview">🧠 gemini-3.1-pro-preview (预览·限制较严)</option>
                <option value="gemma-4-31b-it">💎 Gemma 4 31B (Dense·256K·30RPM)</option>
                <option value="gemma-4-26b-a4b-it">💎 Gemma 4 26B A4B (256K·30RPM)</option>
            </select>
        </div>
        
        <div style="margin-bottom:16px;">
            <label style="display:block;font-size:12px;color:#ccc;margin-bottom:6px;">自定义 Prompt (系统指令)</label>
            <textarea id="_ai-prompt" rows="6" style="width:100%;box-sizing:border-box;padding:8px;background:#222;color:#fff;border:1px solid #555;border-radius:6px;font-size:12px;resize:vertical;" placeholder="不填则使用系统默认提示词...\n可以通过改变这个提示词让 AI 写出更符合您要求的短文本。"></textarea>
        </div>
        
        <div style="margin-bottom:16px;">
            <label style="display:block;font-size:12px;color:#ccc;margin-bottom:6px;">字幕断行模式</label>
            <div style="display:block;gap:8px;">
                <label style="display:flex;align-items:center;font-size:12px;color:#eee;cursor:pointer;margin-bottom:6px;">
                    <input type="radio" name="_ai-lb-mode" value="ai" checked style="margin-right:6px;"> 
                    【AI 智能断行】: 完全由 AI 根据 Prompt 语义逻辑自动折行 (使用提示词中要求输出的 ||| 的断句结果)
                </label>
                <label style="display:flex;align-items:center;font-size:12px;color:#eee;cursor:pointer;">
                    <input type="radio" name="_ai-lb-mode" value="script" style="margin-right:6px;"> 
                    【脚本自动断行】: 忽略大模型的排版，使用 VideoKit 工具的 "智能分段 / 格式转换" 脚本强制拆分
                </label>
                <div id="_ai-lb-script-settings" style="margin-top:8px;margin-left:24px;display:none;align-items:center;gap:8px;">
                    <span style="color:#aaa;font-size:12px;">每行最大字符数:</span>
                    <input type="number" id="_ai-lb-max-chars" value="16" min="5" max="50" style="width:50px;background:#222;border:1px solid #555;color:#fff;border-radius:4px;padding:2px 4px;font-size:12px;text-align:center;">
                    <span style="color:#888;font-size:11px;">(中文字符上限，推荐 12-18)</span>
                </div>
            </div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #333;padding-top:12px;">
            <button id="_ai-cancel" style="padding:8px 20px;background:#333;color:#aaa;border:1px solid #555;border-radius:6px;cursor:pointer;">取消</button>
            <button id="_ai-save" style="padding:8px 20px;background:linear-gradient(135deg,#a855f7,#6366f1);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">💾 保存设置</button>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    dialog.querySelector('#_ai-cancel').addEventListener('click', () => overlay.remove());

    try {
        const resp = await apiFetch('settings/gemini-keys', { method: 'GET' });
        const data = await resp.json();
        if (data) {
            dialog.querySelector('#_ai-keys').value = (data.keys || []).join('\n');
            if (data.model) dialog.querySelector('#_ai-model').value = data.model;
            if (data.prompt) dialog.querySelector('#_ai-prompt').value = data.prompt;
            if (data.lineBreakMode === 'script') {
                dialog.querySelector('input[name="_ai-lb-mode"][value="script"]').checked = true;
                dialog.querySelector('#_ai-lb-script-settings').style.display = 'flex';
            } else {
                dialog.querySelector('input[name="_ai-lb-mode"][value="ai"]').checked = true;
            }
            if (data.lbMaxChars) dialog.querySelector('#_ai-lb-max-chars').value = data.lbMaxChars;
        }
    } catch (e) {
        console.warn('获取 Gemini 设置失败', e);
    }

    const lbModeRadios = dialog.querySelectorAll('input[name="_ai-lb-mode"]');
    const scriptSettings = dialog.querySelector('#_ai-lb-script-settings');
    lbModeRadios.forEach(radio => radio.addEventListener('change', () => {
        scriptSettings.style.display = radio.value === 'script' ? 'flex' : 'none';
    }));

    dialog.querySelector('#_ai-save').addEventListener('click', async () => {
        const keyLines = dialog.querySelector('#_ai-keys').value.split(/\r?\n/).map(s => s.trim()).filter(s => s);
        const promptRaw = dialog.querySelector('#_ai-prompt').value; // let it be empty if space only
        const lbMode = dialog.querySelector('input[name="_ai-lb-mode"]:checked')?.value || 'ai';
        const selectedModel = dialog.querySelector('#_ai-model').value;
        const payload = {
            keys: keyLines,
            model: selectedModel,
            prompt: promptRaw || null,
            lineBreakMode: lbMode,
            lbMaxChars: parseInt(dialog.querySelector('#_ai-lb-max-chars').value) || 16
        };
        try {
            dialog.querySelector('#_ai-save').textContent = '保存中...';
            const res = await apiFetch('settings/gemini-keys', { method: 'POST', body: JSON.stringify(payload) });
            if (res.ok) {
                showToast('✅ AI设置保存成功', 'success');
                overlay.remove();
            } else {
                throw new Error('保存失败');
            }
        } catch (e) {
            alert('保存失败: ' + e.message);
            dialog.querySelector('#_ai-save').textContent = '💾 保存设置';
        }
    });
}

const _BG_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);
const _AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma']);
const _SRT_EXTS = new Set(['srt']);
const _TXT_EXTS = new Set(['txt']);

/**
 * 读取文件夹 → 自动按类型分类 → 同名配对 → 创建任务行
 */
function _batchImportFolder(files) {
    if (!files || !files.length) return;
    const state = window._reelsState;
    const ReelsOverlay = window.ReelsOverlay;
    if (!state) return;

    // 按类型分桶
    const bgFiles = [];
    const audioFiles = [];
    const srtFiles = [];
    const txtFiles = [];

    for (const f of files) {
        const name = f.name || '';
        // 跳过隐藏文件和系统文件
        if (name.startsWith('.') || name === 'Thumbs.db' || name === 'desktop.ini') continue;
        const ext = name.split('.').pop().toLowerCase();
        if (_AUDIO_EXTS.has(ext)) audioFiles.push(f);
        else if (_VOICE_VIDEO_EXTS.has(ext) && _looksLikeVoiceTrack(name)) audioFiles.push(f);
        else if (_BG_EXTS.has(ext)) bgFiles.push(f);
        else if (_SRT_EXTS.has(ext)) srtFiles.push(f);
        else if (_TXT_EXTS.has(ext)) txtFiles.push(f);
    }

    if (!bgFiles.length && !audioFiles.length && !srtFiles.length && !txtFiles.length) {
        alert('文件夹中未找到支持的媒体文件');
        return;
    }

    // 提取基础匹配键（去除扩展名并应用 stopwords 过滤）
    function matchKey(f) {
        if (typeof window._buildAudioSubtitleMatchKey === 'function') {
            return window._buildAudioSubtitleMatchKey(f.name || '');
        }
        // 如果外部函数不可用，回退到基础去头尾处理
        const name = f.name || '';
        const dot = name.lastIndexOf('.');
        return (dot > 0 ? name.substring(0, dot) : name).trim().toLowerCase();
    }

    // 建立同名配对映射: matchKey → { bg, audio, srt, txt }
    const groups = new Map();

    function addToGroup(file, field) {
        const key = matchKey(file);
        if (!groups.has(key)) groups.set(key, { bg: null, audio: null, srt: null, txt: null });
        // 如果已经有该字段，优先保留第一个遇到的以稳定排序
        if (!groups.get(key)[field]) {
            groups.get(key)[field] = file;
        }
    }

    bgFiles.sort(_naturalSortByName).forEach(f => addToGroup(f, 'bg'));
    audioFiles.sort(_naturalSortByName).forEach(f => addToGroup(f, 'audio'));
    srtFiles.sort(_naturalSortByName).forEach(f => addToGroup(f, 'srt'));
    txtFiles.sort(_naturalSortByName).forEach(f => addToGroup(f, 'txt'));

    // 按名称自然数字排序
    const sortedKeys = [...groups.keys()].sort(_naturalSortByName);

    let created = 0;
    for (const bn of sortedKeys) {
        const g = groups.get(bn);
        const taskName = bn || _generateUniqueCardName(state.tasks, 'task');
        const task = {
            baseName: taskName,
            fileName: `${taskName}.mp4`,
            bgPath: g.bg ? ((typeof getFileNativePath === 'function') ? getFileNativePath(g.bg) : (g.bg.path || g.bg.name)) : null,
            bgSrcUrl: null,
            audioPath: g.audio ? ((typeof getFileNativePath === 'function') ? getFileNativePath(g.audio) : (g.audio.path || g.audio.name)) : null,
            srtPath: g.srt ? ((typeof getFileNativePath === 'function') ? getFileNativePath(g.srt) : (g.srt.path || g.srt.name)) : null,
            txtPath: g.txt ? ((typeof getFileNativePath === 'function') ? getFileNativePath(g.txt) : (g.txt.path || g.txt.name)) : null,
            txtContent: null,
            aligned: false,
            segments: [],
            videoPath: g.bg ? ((typeof getFileNativePath === 'function') ? getFileNativePath(g.bg) : (g.bg.path || g.bg.name)) : null,
            srcUrl: null,
            overlays: [],
        };

        // 生成预览 URL
        if (g.bg) {
            if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function' && task.bgPath) {
                task.bgSrcUrl = window.electronAPI.toFileUrl(task.bgPath);
            } else {
                try { task.bgSrcUrl = URL.createObjectURL(g.bg); } catch (e) { }
            }
        }

        // 读取 SRT 内容
        if (g.srt) {
            _readSrtFileToTask(task, g.srt);
        }

        // 读取 TXT 内容
        if (g.txt) {
            _readTxtFileToTask(task, g.txt);
        }

        _ensureTaskId(task);
        state.tasks.push(task);
        created++;
    }

    _resolveDuplicateTaskNames(state.tasks);
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();

    const summary = [];
    if (bgFiles.length) summary.push(`${bgFiles.length} 个背景`);
    if (audioFiles.length) summary.push(`${audioFiles.length} 个音频`);
    if (srtFiles.length) summary.push(`${srtFiles.length} 个字幕`);
    if (txtFiles.length) summary.push(`${txtFiles.length} 个TXT文案`);
    alert(`✅ 从文件夹导入 ${created} 个任务\n检测到: ${summary.join(', ')}\n同名文件已自动配对`);
}

function _getPathBaseName(filePath) {
    if (!filePath) return '';
    if (window.electronAPI && typeof window.electronAPI.pathBasename === 'function') {
        return window.electronAPI.pathBasename(filePath);
    }
    if (window.require) {
        try { return window.require('path').basename(filePath); } catch (_) { }
    }
    return String(filePath).replace(/\\/g, '/').split('/').pop() || String(filePath);
}

function _isDirectoryPath(filePath) {
    if (!filePath) return false;
    if (window.electronAPI && typeof window.electronAPI.isDirectory === 'function') {
        return window.electronAPI.isDirectory(filePath);
    }
    if (window.require) {
        try {
            const fs = window.require('fs');
            return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
        } catch (_) { }
    }
    return false;
}

function _scanMaterialGroupFolders(rootDir) {
    if (!rootDir) return { groups: [], skipped: [] };
    let fs = null, pathMod = null;
    if (window.require) {
        try {
            fs = window.require('fs');
            pathMod = window.require('path');
        } catch (_) {}
    }
    if (!fs || !pathMod) {
        if (window.electronAPI && window.electronAPI.fsExists && window.electronAPI.pathJoin) {
            fs = {
                existsSync: (p) => window.electronAPI.fsExists(p),
                statSync: (p) => {
                    const s = window.electronAPI.fsStat(p);
                    if (!s) throw new Error('File not found');
                    return {
                        size: s.size,
                        mtimeMs: s.mtimeMs,
                        isDirectory: () => s.isDirectory,
                        isFile: () => s.isFile
                    };
                },
                readdirSync: (p, options) => {
                    const entries = window.electronAPI.fsReaddir(p);
                    if (options && options.withFileTypes) {
                        return entries.map(e => ({
                            name: e.name,
                            isDirectory: () => e.isDirectory,
                            isFile: () => e.isFile
                        }));
                    }
                    return entries.map(e => e.name);
                },
                readFileSync: (p, encoding) => {
                    if (encoding === 'utf-8' && window.electronAPI.readFileText) {
                        return window.electronAPI.readFileText(p);
                    }
                    throw new Error('Not supported');
                }
            };
            pathMod = {
                join: (...args) => window.electronAPI.pathJoin(...args),
                basename: (p) => window.electronAPI.pathBasename(p)
            };
        }
    }
    if (!fs || !pathMod) return { groups: [], skipped: [] };

    const videoExts = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm']);
    const audioExts = _AUDIO_EXTS || new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma']);
    const groups = [];
    const skipped = [];

    const readGroupDir = (dirPath) => {
        const groupName = _getPathBaseName(dirPath);
        let entries = [];
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true })
                .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
                .map(entry => pathMod.join(dirPath, entry.name));
        } catch (e) {
            return { skipped: { name: groupName, reason: e.message || '无法读取子文件夹' } };
        }

        const audioFiles = [];
        const videoFiles = [];
        const srtFiles = [];
        const txtFiles = [];
        for (const fp of entries) {
            const ext = _getPathBaseName(fp).split('.').pop().toLowerCase();
            if (audioExts.has(ext)) audioFiles.push(fp);
            else if (videoExts.has(ext)) videoFiles.push(fp);
            else if (ext === 'srt') srtFiles.push(fp);
            else if (ext === 'txt') txtFiles.push(fp);
        }
        audioFiles.sort((a, b) => _naturalSortByName(_getPathBaseName(a), _getPathBaseName(b)));
        videoFiles.sort((a, b) => _naturalSortByName(_getPathBaseName(a), _getPathBaseName(b)));
        srtFiles.sort((a, b) => _naturalSortByName(_getPathBaseName(a), _getPathBaseName(b)));
        txtFiles.sort((a, b) => _naturalSortByName(_getPathBaseName(a), _getPathBaseName(b)));

        if (!audioFiles.length || !videoFiles.length) {
            return {
                skipped: {
                    name: groupName,
                    reason: !audioFiles.length && !videoFiles.length ? '缺少音频和视频' : (!audioFiles.length ? '缺少音频' : '缺少视频')
                }
            };
        }
        return {
            group: {
                name: groupName,
                dirPath,
                audioPath: audioFiles[0],
                videoPaths: videoFiles,
                srtPath: srtFiles[0] || null,
                txtPath: txtFiles[0] || null,
                extraAudioCount: Math.max(0, audioFiles.length - 1)
            }
        };
    };

    let subDirs = [];
    try {
        subDirs = fs.readdirSync(rootDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
            .map(entry => pathMod.join(rootDir, entry.name))
            .sort((a, b) => _naturalSortByName(_getPathBaseName(a), _getPathBaseName(b)));
    } catch (e) {
        return { groups, skipped: [{ name: _getPathBaseName(rootDir), reason: e.message || '无法读取目录' }] };
    }

    for (const dirPath of subDirs) {
        const result = readGroupDir(dirPath);
        if (result.group) groups.push(result.group);
        else if (result.skipped) skipped.push(result.skipped);
    }

    if (groups.length === 0) {
        const direct = readGroupDir(rootDir);
        if (direct.group) {
            groups.push(direct.group);
            skipped.length = 0;
        }
    }
    return { groups, skipped };
}

function _importMaterialGroupFolders(rootDir, options = {}) {
    const state = window._reelsState;
    if (!state || !rootDir) return 0;
    if (!window.require && !(window.electronAPI && window.electronAPI.fsExists)) {
        alert('素材组导入需要在桌面应用中使用');
        return 0;
    }

    const { groups, skipped } = _scanMaterialGroupFolders(rootDir);
    if (!groups.length) {
        const skipMsg = skipped.length ? `\n\n跳过:\n${skipped.slice(0, 10).map(s => `${s.name}: ${s.reason}`).join('\n')}` : '';
        if (!options.silent) {
            alert(`没有找到可导入的素材组。\n规则：总文件夹下每个一级子文件夹至少包含 1 个音频和 1 个视频。${skipMsg}`);
        }
        return 0;
    }

    const mode = options.mode || 'append';
    if (mode === 'replace') state.tasks = [];

    const startIndex = state.tasks.length;
    for (const group of groups) {
        const task = _createEmptyTask();
        task.baseName = group.name || _generateUniqueCardName(state.tasks || [], 'group');
        task.fileName = `${task.baseName}.mp4`;
        task.exportName = task.baseName;
        task.audioPath = group.audioPath;
        task.bgMode = 'multi';
        task.bgClipPool = [...group.videoPaths];
        task.bgClipActivePool = [];
        task.bgClipOrder = 'sequence';
        task.bgTransition = task.bgTransition || 'none';
        task.bgTransDur = task.bgTransDur || 0.5;
        task.bgPath = group.videoPaths[0] || null;
        task.videoPath = group.videoPaths[0] || null;
        task.bgSrcUrl = null;
        task.srcUrl = null;
        task._materialGroupDir = group.dirPath;

        // 自动载入关联的字幕 (SRT)
        if (group.srtPath) {
            task.srtPath = group.srtPath;
            _readSrtViaElectronAPI(task, group.srtPath);
        }

        // 自动载入关联的文案 (TXT)
        if (group.txtPath) {
            task.txtPath = group.txtPath;
            if (window.electronAPI && window.electronAPI.readFileText) {
                try {
                    task.txtContent = window.electronAPI.readFileText(group.txtPath) || '';
                    task.aligned = false;
                } catch (e) {
                    console.warn('[MaterialGroup] Failed to read txt file:', e);
                }
            }
        }

        _ensureTaskId(task);
        state.tasks.push(task);
    }

    _resolveDuplicateTaskNames(state.tasks);
    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    if (startIndex >= 0 && typeof reelsSelectTask === 'function') {
        try { reelsSelectTask(startIndex); } catch (_) { }
    }
    if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();
    if (typeof _batchAutoSave === 'function') _batchAutoSave();

    const extraAudioGroups = groups.filter(g => g.extraAudioCount > 0).length;
    const details = [
        `✅ 已导入 ${groups.length} 个素材组任务`,
        `每个任务：1 个音频 + 子文件夹内视频按文件名顺序循环拼接`,
    ];
    if (extraAudioGroups) details.push(`有 ${extraAudioGroups} 个文件夹含多个音频，仅使用第一个音频`);
    if (skipped.length) details.push(`跳过 ${skipped.length} 个子文件夹：\n${skipped.slice(0, 10).map(s => `${s.name}: ${s.reason}`).join('\n')}${skipped.length > 10 ? '\n...' : ''}`);
    if (!options.silent) alert(details.join('\n'));
    return groups.length;
}

function _importFoldersAsIndependentQueues(dirs) {
    const validDirs = [...new Set((dirs || []).filter(Boolean))];
    if (validDirs.length === 0) return { queueCount: 0, taskCount: 0 };

    _syncTasksToActiveTab();
    let queueCount = 0;
    let taskCount = 0;

    for (const dir of validDirs) {
        const scan = _scanMaterialGroupFolders(dir);
        if (!scan.groups.length) continue;

        const baseName = _getPathBaseName(dir) || `文件夹${queueCount + 1}`;
        const existingNames = new Set(_batchTableState.tabs.map(tab => tab.name));
        let tabName = baseName;
        let suffix = 2;
        while (existingNames.has(tabName)) tabName = `${baseName} (${suffix++})`;

        _addTab(tabName);
        const tab = _getActiveTab();
        tab.materialDir = dir;
        const imported = _importMaterialGroupFolders(dir, { mode: 'replace', silent: true }) || 0;
        if (imported > 0) {
            _syncTasksToActiveTab();
            queueCount++;
            taskCount += imported;
        }
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _batchAutoSave === 'function') _batchAutoSave();
    return { queueCount, taskCount };
}

/**
 * 拖入文件夹专用：一个文件夹一个标签页、一个主媒体文件一个任务。
 * 同名音频/SRT/TXT 作为伴随文件挂到视频/图片任务，避免重复任务；
 * 没有同名画面的音频仍独立生成任务。素材组按钮继续使用旧导入器。
 */
async function _importFoldersAsFileTaskTabs(dirs) {
    const validDirs = [...new Set((dirs || []).filter(Boolean))];
    if (validDirs.length === 0) return { tabCount: 0, taskCount: 0, skippedCount: 0 };
    if (!window.electronAPI || !window.electronAPI.scanDirectory) {
        if (typeof showToast === 'function') showToast('请在桌面应用中使用文件夹拖拽', 'error');
        return { tabCount: 0, taskCount: 0, skippedCount: validDirs.length };
    }

    _syncTasksToActiveTab();
    let tabCount = 0;
    let taskCount = 0;
    let skippedCount = 0;

    for (const dir of validDirs) {
        const files = (await window.electronAPI.scanDirectory(dir) || [])
            .filter(f => f && !f.isDirectory && f.path)
            .sort(_naturalSortByName);
        const supported = files.filter(f => {
            const ext = String(f.name || '').split('.').pop().toLowerCase();
            return _MAT_BG_EXTS.has(ext) || _MAT_AUDIO_EXTS.has(ext)
                || _MAT_SRT_EXTS.has(ext) || _MAT_TXT_EXTS.has(ext);
        });
        if (supported.length === 0) {
            skippedCount++;
            continue;
        }

        const byBase = new Map();
        for (const f of supported) {
            const base = _baseFileName(f.name || '');
            if (!byBase.has(base)) byBase.set(base, { visuals: [], audio: null, srt: null, txt: null });
            const group = byBase.get(base);
            const ext = String(f.name || '').split('.').pop().toLowerCase();
            if (_MAT_AUDIO_EXTS.has(ext)) group.audio ||= f;
            else if (_MAT_SRT_EXTS.has(ext)) group.srt ||= f;
            else if (_MAT_TXT_EXTS.has(ext)) group.txt ||= f;
            else if (_MAT_BG_EXTS.has(ext)) group.visuals.push(f);
        }

        // A common folder layout is one voice-over/SRT named after the folder,
        // plus several differently-named background clips.  Exact filename
        // matching cannot pair those companions with the clips, so when there
        // is exactly one *unmatched* audio or SRT, use it for every visual task
        // in this folder.  A companion that already matches a visual keeps the
        // normal per-file pairing behaviour.
        const groups = [...byBase.values()];
        const visualGroups = groups.filter(group => group.visuals.length > 0);
        const unmatchedAudioGroups = groups.filter(group => group.audio && group.visuals.length === 0);
        const unmatchedSrtGroups = groups.filter(group => group.srt && group.visuals.length === 0);
        const sharedAudio = visualGroups.length > 0 && !visualGroups.some(group => group.audio)
            && unmatchedAudioGroups.length === 1
            ? unmatchedAudioGroups[0].audio
            : null;
        const sharedSrt = visualGroups.length > 0 && !visualGroups.some(group => group.srt)
            && unmatchedSrtGroups.length === 1
            ? unmatchedSrtGroups[0].srt
            : null;

        const tasks = [];
        for (const [base, group] of byBase) {
            // Do not create a separate audio-only/SRT-only row for a companion
            // file that was promoted to the folder's shared media.
            if (!group.visuals.length && (group.audio === sharedAudio || group.srt === sharedSrt)) continue;
            const primaries = group.visuals.length ? group.visuals : (group.audio ? [group.audio] : []);
            for (let primaryIndex = 0; primaryIndex < primaries.length; primaryIndex++) {
                const primary = primaries[primaryIndex];
                const task = _createEmptyTask();
                const duplicateSuffix = primaries.length > 1 ? `_${primaryIndex + 1}` : '';
                task.baseName = `${base}${duplicateSuffix}`;
                task.fileName = `${task.baseName}.mp4`;
                if (group.visuals.length) {
                    _setTaskSingleBackground(task, primary.path, { clearBgSrcUrl: true, detectImage: true });
                    if (group.audio || sharedAudio) task.audioPath = (group.audio || sharedAudio).path;
                } else {
                    task.audioPath = primary.path;
                }
                const subtitleFile = group.srt || sharedSrt;
                if (subtitleFile) {
                    task.srtPath = subtitleFile.path;
                    _readSrtViaElectronAPI(task, subtitleFile.path);
                }
                if (group.txt) {
                    task.txtPath = group.txt.path;
                    try {
                        task.txtContent = await window.electronAPI.readFileText(group.txt.path) || '';
                        task.aligned = false;
                    } catch (e) {
                        console.warn('[FolderTaskTabs] TXT read failed:', group.txt.path, e);
                    }
                }
                _ensureTaskId(task);
                tasks.push(task);
            }
        }
        if (tasks.length === 0) {
            skippedCount++;
            continue;
        }

        const baseName = _getPathBaseName(dir) || `文件夹${tabCount + 1}`;
        const existingNames = new Set(_batchTableState.tabs.map(tab => tab.name));
        let tabName = baseName;
        let suffix = 2;
        while (existingNames.has(tabName)) tabName = `${baseName} (${suffix++})`;
        _addTab(tabName);
        const tab = _getActiveTab();
        tab.materialDir = dir;
        tab.tasks = tasks;
        _loadTabTasks(tab);
        tabCount++;
        taskCount += tasks.length;
    }

    _resolveDuplicateTaskNames(window._reelsState.tasks || []);
    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    if (typeof _batchAutoSave === 'function') _batchAutoSave();
    if (typeof showToast === 'function') {
        if (tabCount > 0) {
            const skipped = skippedCount ? `，跳过 ${skippedCount} 个空/不支持的文件夹` : '';
            showToast(`📚 已建立 ${tabCount} 个标签页，共 ${taskCount} 条文件任务${skipped}`, 'success', 6500);
        } else {
            showToast('文件夹中没有可创建任务的视频、图片或音频', 'warning', 6000);
        }
    }
    return { tabCount, taskCount, skippedCount };
}
window.reelsImportFoldersAsTaskTabs = _importFoldersAsFileTaskTabs;

/**
 * 将外部拖入的文件夹任务镜像到一个统一的批量表格标签页。
 * 每条任务仍保留 _folderQueueId/_sourceFolder，导出时可继续按原文件夹归属处理；
 * 统一标签页则让用户可以一次粘贴整列文案并一键对齐全部任务。
 */
function _syncExternalFolderQueuesToTabs() {
    const queueMap = new Map();
    const addTasks = (tasks, replace = false) => {
        const grouped = new Map();
        for (const task of tasks || []) {
            if (!task?._folderQueueId) continue;
            if (!grouped.has(task._folderQueueId)) grouped.set(task._folderQueueId, []);
            grouped.get(task._folderQueueId).push(task);
        }
        for (const [queueId, groupedTasks] of grouped) {
            if (replace || !queueMap.has(queueId)) queueMap.set(queueId, groupedTasks);
        }
    };

    // 兼容已存在的旧版“每文件夹一个标签”数据，并将新拖入任务覆盖同队列旧内容。
    for (const tab of _batchTableState.tabs || []) {
        if (tab?._folderQueueId) addTasks(tab.tasks);
        if (tab?._externalFolderQueuesCombined) addTasks(tab.tasks);
    }
    addTasks(window._reelsState?.tasks, true);
    if (!queueMap.size) return { created: 0, updated: 0 };

    // 统一标签页按来源文件夹名的自然数字顺序排列（1、2、10，而非 1、10、2）。
    // 同一文件夹内的任务顺序由拖入扫描时的自然排序保留。
    const tasks = Array.from(queueMap.entries())
        .sort(([queueIdA, tasksA], [queueIdB, tasksB]) => {
            const nameA = String(tasksA[0]?._folderQueueName || queueIdA);
            const nameB = String(tasksB[0]?._folderQueueName || queueIdB);
            return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
        })
        .flatMap(([, queueTasks]) => queueTasks);
    let tab = _batchTableState.tabs.find(item => item?._externalFolderQueuesCombined);
    const wasCreated = !tab;
    if (!tab) {
        tab = {
            id: 'tab_' + _batchTableState.nextTabId++,
            name: '批量导入任务',
            materialDir: '',
            lastRefreshTime: null,
            _externalFolderQueuesCombined: true,
            tasks: [],
        };
        _batchTableState.tabs.push(tab);
    }
    tab.name = '批量导入任务';
    tab.tasks = _cloneBatchTasks(tasks);

    // 删除旧版自动生成的单文件夹标签，避免用户仍看到几十个重复标签。
    const oldQueueTabIds = new Set((_batchTableState.tabs || [])
        .filter(item => item && item !== tab && item._folderQueueId)
        .map(item => item.id));
    _batchTableState.tabs = _batchTableState.tabs.filter(item => !oldQueueTabIds.has(item.id));
    if (oldQueueTabIds.has(_batchTableState.activeTabId)) {
        _batchTableState.activeTabId = tab.id;
        _loadTabTasks(tab);
    }

    _normalizeBatchTabState();
    _skipNextApply = true;
    _renderBatchTable();
    _batchAutoSave({ skipSync: true });
    return { created: wasCreated ? 1 : 0, updated: wasCreated ? 0 : 1 };
}
window.reelsSyncExternalFolderQueuesToTabs = _syncExternalFolderQueuesToTabs;

async function _selectAndImportMaterialGroupFolders(options = {}) {
    if (!window.require && !(window.electronAPI && window.electronAPI.selectDirectory)) {
        alert('素材组导入需要在桌面应用中使用');
        return;
    }
    try {
        let rootDir = null;
        if (window.electronAPI && window.electronAPI.selectDirectory) {
            rootDir = await window.electronAPI.selectDirectory();
        } else {
            const { dialog, getCurrentWindow } = window.require('@electron/remote');
            const result = await dialog.showOpenDialog(getCurrentWindow(), {
                title: '选择素材组总文件夹（一级子文件夹各生成一行任务）',
                properties: ['openDirectory']
            });
            if (!result.canceled && result.filePaths?.[0]) {
                rootDir = result.filePaths[0];
            }
        }
        if (rootDir) {
            _importMaterialGroupFolders(rootDir, options);
        }
    } catch (e) {
        alert('打开素材组文件夹失败: ' + (e.message || e));
    }
}

// ═══════════════════════════════════════════════════════
// 9b. File assignment helpers
// ═══════════════════════════════════════════════════════

function _openHookModal(idx) {
    const container = _batchTableState.container;
    if (!container) return;
    const hookModal = container.querySelector('#rbt-hook-modal');
    if (!hookModal) return;

    hookModal.dataset.editIdx = String(idx);

    // Initial clear
    const pathInput = container.querySelector('#rbt-hook-path');
    const startInput = container.querySelector('#rbt-hook-start');
    const endInput = container.querySelector('#rbt-hook-end');
    const speedInput = container.querySelector('#rbt-hook-speed');
    const transInput = container.querySelector('#rbt-hook-transition');
    const durInput = container.querySelector('#rbt-hook-trans-dur');

    if (pathInput) pathInput.value = '';
    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';
    if (speedInput) speedInput.value = '1';
    if (transInput) transInput.value = 'none';
    if (durInput) durInput.value = '0.5';

    let targetTask = null;
    if (idx >= 0) {
        targetTask = window._reelsState.tasks[idx];
    } else {
        const indices = _getSelectedIndices();
        if (indices.length > 0) {
            targetTask = window._reelsState.tasks[indices[0]];
        }
    }

    if (targetTask) {
        const resolvedHookPath = targetTask.hookFile || ((targetTask.hook && targetTask.hook.enabled !== false) ? (targetTask.hook.path || '') : '');
        if (pathInput) pathInput.value = resolvedHookPath;
        if (startInput) startInput.value = targetTask.hookTrimStart != null ? targetTask.hookTrimStart : '';
        if (endInput) endInput.value = targetTask.hookTrimEnd != null ? targetTask.hookTrimEnd : '';
        if (speedInput) speedInput.value = targetTask.hookSpeed || '1';
        if (transInput) transInput.value = targetTask.hookTransition || 'none';
        if (durInput) durInput.value = targetTask.hookTransDuration || '0.5';
    }

    _updateHookPreview();
    hookModal.style.display = 'flex';
}

function _updateHookPreview() {
    const container = _batchTableState.container;
    if (!container) return;
    const pathInput = container.querySelector('#rbt-hook-path');
    const previewContainer = container.querySelector('#rbt-hook-preview-container');
    const videoPreview = container.querySelector('#rbt-hook-preview-video');
    const imgPreview = container.querySelector('#rbt-hook-preview-img');
    const startInput = container.querySelector('#rbt-hook-start');

    if (!pathInput || !previewContainer || !videoPreview || !imgPreview) return;

    const filePath = pathInput.value.trim();
    if (!filePath) {
        previewContainer.style.display = 'none';
        videoPreview.src = '';
        imgPreview.src = '';
        return;
    }

    previewContainer.style.display = 'block';
    const fileUrl = _rbtMediaUrl(filePath);
    const ext = filePath.split('.').pop().toLowerCase();

    if (['mp4', 'webm', 'ogg', 'mov', 'mkv'].includes(ext)) {
        imgPreview.style.display = 'none';
        videoPreview.style.display = 'block';
        // Use decodeURIComponent for comparison to handle encoded paths
        const currentSrc = videoPreview.src || '';
        const isSameSrc = currentSrc === fileUrl || decodeURIComponent(currentSrc) === decodeURIComponent(fileUrl);
        if (!isSameSrc) {
            videoPreview.src = fileUrl;
            videoPreview.onloadedmetadata = () => {
                const startTime = parseFloat(startInput?.value) || 0;
                videoPreview.currentTime = startTime;
            };
        } else {
            const startTime = parseFloat(startInput?.value) || 0;
            videoPreview.currentTime = startTime;
        }
    } else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        videoPreview.style.display = 'none';
        imgPreview.style.display = 'block';
        imgPreview.src = fileUrl;
    } else {
        previewContainer.style.display = 'none';
    }
}

function _openCoverModal(idx) {
    const container = _batchTableState.container;
    if (!container) return;
    const coverModal = container.querySelector('#rbt-cover-modal');
    if (!coverModal) return;

    coverModal.dataset.editIdx = String(idx);

    const enabledCb = container.querySelector('#rbt-cover-enabled');
    const separateExportCb = container.querySelector('#rbt-cover-export-separate');
    const bgPathInput = container.querySelector('#rbt-cover-bg-path');
    const durationInput = container.querySelector('#rbt-cover-duration');
    const previewContainer = container.querySelector('#rbt-cover-preview-container');
    const previewImg = container.querySelector('#rbt-cover-preview-img');
    const hintText = container.querySelector('#rbt-cover-preview-hint');

    // Default clear
    if (enabledCb) enabledCb.checked = false;
    if (separateExportCb) separateExportCb.checked = true; // default on
    if (bgPathInput) bgPathInput.value = '';
    if (durationInput) durationInput.value = '0';
    if (previewContainer) previewContainer.style.display = 'flex';
    if (previewImg) { previewImg.src = ''; previewImg.style.display = 'none'; }
    if (hintText) hintText.style.display = 'block';

    let targetTask = null;
    if (idx >= 0) {
        targetTask = window._reelsState.tasks[idx];
    }

    if (targetTask && targetTask.cover) {
        if (enabledCb) enabledCb.checked = !!targetTask.cover.enabled;
        if (separateExportCb) separateExportCb.checked = targetTask.cover.exportSeparate !== false;
        if (durationInput) durationInput.value = targetTask.cover.duration || '0';
        if (bgPathInput && targetTask.cover.bgPath) {
            bgPathInput.value = targetTask.cover.bgPath;
            if (previewImg && hintText) {
                const filePath = targetTask.cover.bgPath;
                const url = _rbtMediaUrl(filePath);
                previewImg.src = url;
                previewImg.style.display = 'block';
                hintText.style.display = 'none';
            }
        }
    }

    const overlaySel = container.querySelector('#rbt-cover-overlay-sel');
    if (overlaySel) {
        let currentVal = overlaySel.value;
        overlaySel.innerHTML = '<option value="">-- 使用独立卡片配置 --</option>';
        if (window.ReelsOverlay) {
            let presets = {};
            try { presets = JSON.parse(_rbtReadOverlayGroupPresetsRaw() || '{}'); } catch (e) { }
            if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
                presets = { ...window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS, ...presets };
            }
            for (const key of Object.keys(presets)) {
                const option = document.createElement('option');
                option.value = key; option.textContent = key;
                overlaySel.appendChild(option);
            }
        }
        if (targetTask && targetTask.cover && targetTask.cover.overlayTpl) currentVal = targetTask.cover.overlayTpl;
        overlaySel.value = currentVal || '';
    }

    const presetSel = container.querySelector('#rbt-cover-preset-sel');
    if (presetSel) {
        let savedPresets = {};
        try { savedPresets = JSON.parse(localStorage.getItem('videokit_cover_presets') || '{}'); } catch (e) { }
        presetSel.innerHTML = '<option value="">---预设---</option>';
        for (const key of Object.keys(savedPresets)) {
            const option = document.createElement('option');
            option.value = key; option.textContent = key;
            presetSel.appendChild(option);
        }
        presetSel.value = '';
    }

    coverModal.style.display = 'flex';
}

/**
 * 显示音频导入选择对话框（分发为人声还是配乐）
 */
function _showAudioRouteSelectionDialog(fileCount) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:#1e1e2e;border:1px solid #444;border-radius:12px;padding:24px;width:340px;color:#eee;font-size:14px;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-family:system-ui, sans-serif;';
        dialog.innerHTML = `
            <h3 style="margin:0 0 14px;font-size:16px;color:#b8a0ff;display:flex;align-items:center;gap:6px;">🎵 导入音频文件 · ${fileCount} 个文件</h3>
            <div style="margin-bottom:16px;color:#bbb;font-size:13px;line-height:1.4;">检测到您拖入了音频文件，请选择它们的用途（分配到哪个角色）：</div>
            <div style="display:flex;flex-direction:column;gap:10px;">
                <button data-type="audio" style="padding:12px;border:1px solid rgba(94,92,230,0.3);border-radius:8px;background:rgba(94,92,230,0.15);color:#b8b7ff;cursor:pointer;text-align:left;font-size:13px;display:flex;align-items:center;gap:8px;">
                    🎙️ <b>导入为人声配音 (Audio)</b>
                </button>
                <button data-type="bgm" style="padding:12px;border:1px solid rgba(155,89,182,0.3);border-radius:8px;background:rgba(155,89,182,0.15);color:#d39bf5;cursor:pointer;text-align:left;font-size:13px;display:flex;align-items:center;gap:8px;">
                    🎵 <b>导入为背景配乐 (BGM)</b>
                </button>
            </div>
            <button data-type="cancel" style="margin-top:16px;padding:6px;border:1px solid #444;border-radius:6px;background:#2a2a35;color:#aaa;cursor:pointer;width:100%;font-size:13px;">取消</button>
        `;
        dialog.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.remove();
                resolve(btn.dataset.type);
            });
        });
        overlay.appendChild(dialog);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve('cancel'); } });
        document.body.appendChild(overlay);
    });
}

/**
 * 显示批量分配模式对话框
 */
function _showBatchModeDialog(fileCount, field) {
    const fieldLabel = { bg: '背景素材', audio: '人声-音频文件', srt: '人声-SRT字幕', txt: '人声-断行文案', hook: '前置Hook', pip: '图像覆层', bgm: '配乐' }[field] || field;
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:#1e1e2e;border:1px solid #444;border-radius:12px;padding:24px;min-width:320px;color:#eee;font-size:14px;';
        const isSingle = fileCount === 1;
        dialog.innerHTML = `
            <h3 style="margin:0 0 14px;font-size:16px;">📂 批量${fieldLabel} · ${fileCount} 个文件</h3>
            <div style="display:flex;flex-direction:column;gap:8px;">
                <button data-mode="fill" style="padding:10px 16px;border:1px solid #555;border-radius:8px;background:#2a3a4a;color:#cce;cursor:pointer;text-align:left;font-size:13px;">
                    📥 <b>补全</b> — 填入空位，多余的添加新行
                </button>
                <button data-mode="overwrite" style="padding:10px 16px;border:1px solid #555;border-radius:8px;background:#4a2a2a;color:#ecc;cursor:pointer;text-align:left;font-size:13px;">
                    ✏️ <b>覆盖</b> — 从第1行开始覆盖
                </button>
                <button data-mode="append" style="padding:10px 16px;border:1px solid #555;border-radius:8px;background:#2a4a2a;color:#cec;cursor:pointer;text-align:left;font-size:13px;">
                    ➕ <b>添加新行</b> — 全部作为新行追加
                </button>
                ${isSingle ? `<button data-mode="applyall" style="padding:10px 16px;border:1px solid #7b5aab;border-radius:8px;background:#3a2a5a;color:#d0b0ff;cursor:pointer;text-align:left;font-size:13px;">
                    🔄 <b>应用到全部行</b> — 所有行都用这个文件
                </button>` : ''}
                ${field === 'bg' && fileCount > 1 ? `<button data-mode="merge_multi" style="padding:10px 16px;border:1px solid #4a8aff;border-radius:8px;background:#1a2a4a;color:#8ac;cursor:pointer;text-align:left;font-size:13px;">
                    🎬 <b>多素材拼接</b> — 合并到当前行，导出时自动拼接切换
                </button>` : ''}
                ${field === 'bg' ? `<button data-mode="fill_hook" style="padding:10px 16px;border:1px solid #7a6a4a;border-radius:8px;background:#3a3a2a;color:#e0d0a0;cursor:pointer;text-align:left;font-size:13px;margin-bottom:8px;">
                    🪝 <b>填充到前置Hook</b> — 将视频/图片填入Hook列
                </button>
                <button data-mode="fill_audio" style="padding:10px 16px;border:1px solid #5a8a5a;border-radius:8px;background:#2a4a3a;color:#a0e0c0;cursor:pointer;text-align:left;font-size:13px;">
                    🎙 <b>填充到音频</b> — 将视频填入音频列
                </button>` : ''}
            </div>
            <button data-mode="cancel" style="margin-top:12px;padding:6px 16px;border:1px solid #555;border-radius:6px;background:#333;color:#aaa;cursor:pointer;width:100%;font-size:13px;">取消</button>
        `;
        dialog.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.remove();
                resolve(btn.dataset.mode);
            });
        });
        overlay.appendChild(dialog);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve('cancel'); } });
        document.body.appendChild(overlay);
    });
}

/** 将文件应用到任务 */
function _assignFileToTask(task, file, field) {
    const filePath = _rbtGetNativeFilePath(file);
    if (!filePath) return false;
    if (field === 'hook') {
        task.hookFile = filePath;
        if (task.hookSpeed == null) task.hookSpeed = 1;
        if (task.hookTransition == null) task.hookTransition = 'none';
        if (task.hookTransDuration == null) task.hookTransDuration = 0.5;
    } else if (field === 'bg') {
        // Revoke old blob URL to free memory and prevent stale references
        if (task.bgSrcUrl && task.bgSrcUrl.startsWith('blob:')) {
            try { URL.revokeObjectURL(task.bgSrcUrl); } catch (_) { }
        }
        _setTaskSingleBackground(task, filePath, { bgSrcUrl: null });
        // Clear stale blob/srcUrl — force preview to use native file path
        task.srcUrl = null;
    } else if (field === 'audio') {
        task.audioPath = filePath;
    } else if (field === 'srt') {
        task.srtPath = filePath;
        _readSrtFileToTask(task, file);
    } else if (field === 'txt') {
        task.txtPath = filePath;
        _readTxtFileToTask(task, file);
    } else if (field === 'pip') {
        task.pipPath = filePath;
    } else if (field === 'contentvideo') {
        task.contentVideoPath = filePath;
        if (task.contentVideoScale == null) task.contentVideoScale = 100;
        if (task.contentVideoX == null) task.contentVideoX = 'center';
        if (task.contentVideoY == null) task.contentVideoY = 'center';
    } else if (field === 'bgm') {
        if (task.bgmMode === 'multi') {
            if (!task.bgmClipPool) task.bgmClipPool = [];
            if (!task.bgmClipPool.includes(filePath)) task.bgmClipPool.push(filePath);
        } else {
            task.bgmPath = filePath;
        }
    }
    return true;
}

/** 创建空行 */
function _createEmptyTask() {
    const state = window._reelsState;
    const ReelsOverlay = window.ReelsOverlay;
    const taskName = _generateUniqueCardName(state.tasks || [], 'card');
    return {
        baseName: taskName,
        fileName: `${taskName}.mp4`,
        bgPath: null, bgSrcUrl: null,
        audioPath: null, srtPath: null,
        segments: [],
        videoPath: null, srcUrl: null,
        overlays: [],
        ttsText: '', ttsVoiceId: '', pipPath: '', status: '',
    };
}

/**
 * 批量分配文件到各行 — 支持多种模式
 */
async function _batchAssignFiles(files, field) {
    const state = window._reelsState;
    if (!state || !files || files.length === 0) return;

    const invalidFiles = files.filter(file => !_rbtGetNativeFilePath(file));
    if (invalidFiles.length > 0) {
        _rbtShowNativePathError(invalidFiles);
        return;
    }

    files.sort(_naturalSortByName);

    const mode = await _showBatchModeDialog(files.length, field);
    if (mode === 'cancel') return;

    if (mode === 'applyall') {
        // 应用单个文件到所有现有行
        const file = files[0];
        for (const task of state.tasks) {
            _assignFileToTask(task, file, field);
        }
    } else if (mode === 'fill') {
        // 补全：填入空位
        let taskIdx = 0;
        for (const file of files) {
            // 找空位
            while (taskIdx < state.tasks.length) {
                const tk = state.tasks[taskIdx];
                let occupied = false;
                if (field === 'hook') occupied = !!tk.hookFile;
                else if (field === 'bg') {
                    const hasMultiBg = tk.bgMode === 'multi'
                        && Array.isArray(tk.bgClipPool)
                        && tk.bgClipPool.some(Boolean);
                    occupied = !!(tk.bgPath || tk.videoPath || hasMultiBg);
                }
                else if (field === 'audio') occupied = !!tk.audioPath;
                else if (field === 'srt') occupied = !!tk.srtPath;
                else if (field === 'txt') occupied = !!tk.txtPath;
                else if (field === 'pip') occupied = !!tk.pipPath;
                else if (field === 'contentvideo') occupied = !!tk.contentVideoPath;
                else if (field === 'bgm') {
                    const hasMultiBgm = tk.bgmMode === 'multi'
                        && Array.isArray(tk.bgmClipPool)
                        && tk.bgmClipPool.some(Boolean);
                    occupied = !!(tk.bgmPath || hasMultiBgm);
                }
                if (!occupied) break;
                taskIdx++;
            }
            if (taskIdx >= state.tasks.length) {
                const newTask = _createEmptyTask();
                state.tasks.push(newTask);
            }
            _assignFileToTask(state.tasks[taskIdx], file, field);
            taskIdx++;
        }
    } else if (mode === 'overwrite') {
        // 覆盖：从第1行开始
        for (let i = 0; i < files.length; i++) {
            if (i >= state.tasks.length) {
                state.tasks.push(_createEmptyTask());
            }
            _assignFileToTask(state.tasks[i], files[i], field);
        }
    } else if (mode === 'append') {
        // 添加新行
        for (const file of files) {
            const newTask = _createEmptyTask();
            _assignFileToTask(newTask, file, field);
            state.tasks.push(newTask);
        }
    } else if (mode === 'fill_audio') {
        // 将视频文件填充到音频列（补全空位）
        let taskIdx = 0;
        for (const file of files) {
            while (taskIdx < state.tasks.length) {
                if (!state.tasks[taskIdx].audioPath) break;
                taskIdx++;
            }
            if (taskIdx >= state.tasks.length) {
                state.tasks.push(_createEmptyTask());
            }
            _assignFileToTask(state.tasks[taskIdx], file, 'audio');
            taskIdx++;
        }
    } else if (mode === 'fill_hook') {
        // 将文件填充到Hook列（补全空位）
        let taskIdx = 0;
        for (const file of files) {
            while (taskIdx < state.tasks.length) {
                if (!state.tasks[taskIdx].hookFile) break;
                taskIdx++;
            }
            if (taskIdx >= state.tasks.length) {
                state.tasks.push(_createEmptyTask());
            }
            _assignFileToTask(state.tasks[taskIdx], file, 'hook');
            taskIdx++;
        }
    } else if (mode === 'merge_multi') {
        // 多素材拼接：合并所有文件到当前选中行（或第一行）的多素材背景池
        let targetIdx = state.selectedIdx >= 0 ? state.selectedIdx : 0;
        if (targetIdx >= state.tasks.length) {
            state.tasks.push(_createEmptyTask());
            targetIdx = state.tasks.length - 1;
        }
        const task = state.tasks[targetIdx];
        const pool = [];
        for (const file of files) {
            const filePath = (typeof getFileNativePath === 'function') ? getFileNativePath(file) : (file.path || file.name);
            if (filePath && !pool.includes(filePath)) pool.push(filePath);
        }
        if (pool.length > 0) {
            task.bgMode = 'multi';
            task.bgClipPool = pool;
            task.bgClipActivePool = [];
            task.bgClipOrder = task.bgClipOrder || 'sequence';
            task.bgTransition = task.bgTransition || 'crossfade';
            task.bgTransDur = task.bgTransDur ?? 0.5;
            task.bgPath = pool[0];
            task.videoPath = pool[0];
            task.bgSrcUrl = '';
            if (typeof showToast === 'function') showToast(`🎬 已将 ${pool.length} 个素材合并为多素材拼接背景`, 'success', 5000);
            if (typeof reelsSelectTask === 'function') reelsSelectTask(targetIdx);
            if (typeof window.reelsSyncBackgroundTabUI === 'function') window.reelsSyncBackgroundTabUI(task);
        }
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    if (window._reelsState && window._reelsState.selectedIdx >= 0 && typeof reelsSelectTask === 'function') {
        reelsSelectTask(window._reelsState.selectedIdx);
    }
}

/**
 * 批量分配 TXT 文件到各行
 * 1. 先按 matchKey 尝试匹配已有行（同名视频/音频）
 * 2. 没匹配到则顺序找「有背景但还没有 txtContent」的行
 * 3. 还没有就新建行
 */
function _batchAssignTxtFiles(files) {
    const state = window._reelsState;
    if (!state) return;
    const ReelsOverlay = window.ReelsOverlay;
    const invalidFiles = files.filter(file => !_rbtGetNativeFilePath(file));
    if (invalidFiles.length > 0) {
        _rbtShowNativePathError(invalidFiles);
        return;
    }

    function getMatchKey(name) {
        if (typeof window._buildAudioSubtitleMatchKey === 'function') {
            return window._buildAudioSubtitleMatchKey(name || '');
        }
        const n = String(name || '');
        const dot = n.lastIndexOf('.');
        return (dot > 0 ? n.substring(0, dot) : n).trim().toLowerCase();
    }

    files.sort(_naturalSortByName);

    let fallbackIdx = 0;
    for (const file of files) {
        const filePath = _rbtGetNativeFilePath(file);
        const key = getMatchKey(file.name);

        // 尝试按名字匹配已有行（用 matchKey 比较）
        let targetTask = state.tasks.find(t => {
            const bgKey = getMatchKey(t.bgPath || t.videoPath || '');
            const audioKey = getMatchKey(t.audioPath || '');
            const baseKey = getMatchKey(t.baseName || '');
            return (bgKey && bgKey === key) || (audioKey && audioKey === key) || (baseKey && baseKey === key);
        });

        // 没匹配到：顺序找「有背景但还没有 txtContent」的行
        if (!targetTask) {
            while (fallbackIdx < state.tasks.length) {
                const tk = state.tasks[fallbackIdx];
                if (!tk.txtContent && !tk.srtPath) {
                    targetTask = tk;
                    break;
                }
                fallbackIdx++;
            }
        }

        // 还没找到则新建行
        if (!targetTask) {
            const baseName = key || _generateUniqueCardName(state.tasks, 'card');
            targetTask = {
                baseName: baseName,
                fileName: `${baseName}.mp4`,
                bgPath: null, bgSrcUrl: null,
                audioPath: null, srtPath: null,
                segments: [],
                videoPath: null, srcUrl: null,
                overlays: [],
            };
            state.tasks.push(targetTask);
            fallbackIdx = state.tasks.length;
        }

        targetTask.txtPath = filePath;
        targetTask.aligned = false;

        // 异步读取文件内容
        _readTxtFileToTask(targetTask, file);

        fallbackIdx++;
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    alert(`✅ 已分配 ${files.length} 个 TXT 文案文件`);
}

/**
 * 点击单元格 → 选择一个文件
 */
function _rbtPickSingleFile(idx, field) {
    const container = _batchTableState.container;
    if (!container) return;
    const fileInput = container.querySelector('#rbt-file-single');
    if (!fileInput) return;

    // 根据字段设置 accept
    if (field === 'bg') {
        fileInput.accept = '.mp4,.mov,.mkv,.avi,.wmv,.flv,.webm,.jpg,.jpeg,.png,.webp';
    } else if (field === 'audio') {
        fileInput.accept = '.mp3,.wav,.m4a,.aac,.flac,.ogg,.wma,.mp4,.mov,.mkv,.avi,.wmv,.flv,.webm';
    } else if (field === 'srt') {
        fileInput.accept = '.srt';
    } else if (field === 'txt') {
        fileInput.accept = '.txt';
    } else if (field === 'pip') {
        fileInput.accept = 'image/*,video/*';
    } else if (field === 'contentvideo') {
        fileInput.accept = '.mp4,.mov,.mkv,.avi,.wmv,.flv,.webm';
    }

    _batchTableState._pendingSingle = { idx, field };
    fileInput.click();
}

/**
 * 分配单个文件到指定行
 */
function _assignSingleFile(idx, field, file) {
    const state = window._reelsState;
    if (!state || !state.tasks[idx]) return;
    const task = state.tasks[idx];
    const filePath = _rbtGetNativeFilePath(file);
    if (!filePath) {
        _rbtShowNativePathError([file]);
        return;
    }

    console.log(`[BatchTable] _assignSingleFile idx=${idx} field=${field} filePath=${filePath} file.name=${file.name}`);

    if (field === 'bg') {
        if (task.bgSrcUrl && task.bgSrcUrl.startsWith('blob:')) {
            try { URL.revokeObjectURL(task.bgSrcUrl); } catch (_) { }
        }
        _setTaskSingleBackground(task, filePath, { bgSrcUrl: null });
        task.srcUrl = null;
    } else if (field === 'audio') {
        task.audioPath = filePath;
    } else if (field === 'srt') {
        task.srtPath = filePath;
        _readSrtFileToTask(task, file);
        console.log(`[BatchTable] After _readSrtFileToTask: segments.length=${(task.segments || []).length}`);
    } else if (field === 'txt') {
        task.txtPath = filePath;
        _readTxtFileToTask(task, file);
    } else if (field === 'pip') {
        task.pipPath = filePath;
    } else if (field === 'contentvideo') {
        task.contentVideoPath = filePath;
        if (task.contentVideoScale == null) task.contentVideoScale = 100;
        if (task.contentVideoX == null) task.contentVideoX = 'center';
        if (task.contentVideoY == null) task.contentVideoY = 'center';
    }

    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    if (window._reelsState && window._reelsState.selectedIdx === idx && typeof reelsSelectTask === 'function') {
        reelsSelectTask(idx);
    }
}

/**
 * 读取 SRT 文件内容到 task.segments
 */
function _readSrtFileToTask(task, file) {
    const filePath = task.srtPath;
    console.log('[SRT] _readSrtFileToTask called, filePath:', filePath, 'hasFile:', !!file);

    // 优先用 FileReader — 直接读 File 对象的 blob 内容，不依赖路径，Electron 和浏览器通用
    if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
            const content = ev.target.result;
            console.log('[SRT] FileReader result, content length:', content?.length);
            if (!content) { console.warn('[SRT] FileReader returned empty'); return; }
            _parseSrtContent(task, content);
            console.log('[SRT] ✅ loaded via FileReader, segments:', task.segments?.length);
            if (_batchTableState.visible) _renderBatchTable();
            if (typeof _renderTaskList === 'function') _renderTaskList();
        };
        reader.onerror = (err) => {
            console.warn('[SRT] FileReader error:', err, '— trying electronAPI fallback');
            _readSrtViaElectronAPI(task, filePath);
        };
        reader.readAsText(file);
        return;
    }

    // 回退：用 Electron 同步 API（当只有路径没有 File 对象时）
    _readSrtViaElectronAPI(task, filePath);
}

function _readSrtViaElectronAPI(task, filePath) {
    if (filePath && window.electronAPI && window.electronAPI.readFileText) {
        try {
            const content = window.electronAPI.readFileText(filePath);
            if (content) {
                _parseSrtContent(task, content);
                console.log('[SRT] ✅ loaded via electronAPI:', filePath, 'segments:', task.segments?.length);
                if (_batchTableState.visible) _renderBatchTable();
                if (typeof _renderTaskList === 'function') _renderTaskList();
                return;
            }
        } catch (e) {
            console.warn('[SRT] electronAPI.readFileText error:', e);
        }
    }
    console.warn('[SRT] ❌ Failed to load SRT:', filePath);
}

function _parseSrtContent(task, content) {
    // parseSRT 定义在 reels-canvas-renderer.js，暴露在 window.parseSRT
    const parser = (typeof parseSRT === 'function') ? parseSRT : window.parseSRT;
    if (parser) {
        const rawSegs = parser(content).map(seg => ({ ...seg, _timeUnit: 'sec' }));
        task.segments = window.ReelsSubtitleProcessor
            ? ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegs)
            : rawSegs;
        _rbtApplyPendingFirstSubtitleStyle(task);
    } else {
        console.error('[SRT] parseSRT function not found!');
        task.segments = [];
    }
}

/**
 * 读取 TXT 文件内容到 task.txtContent
 */
function _readTxtFileToTask(task, file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
        task.txtContent = ev.target.result || '';
        task.aligned = false;
        // 刷新表格显示加载的文案
        if (_batchTableState.visible) _renderBatchTable();
    };
    reader.readAsText(file);
}

/**
 * 智能断行 (批量表格内用)
 * 英文 ~5 词/行，中文 ~16 字/行，已有换行保留
 */
function _rbtSmartLineBreak(text, customMaxChars) {
    if (!text || typeof text !== 'string') return text;
    const defaultMaxChars = customMaxChars || 16;
    // 按行处理，保留已有换行
    const lines = text.split('\n');
    const result = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length <= 10) { result.push(trimmed); continue; }

        const cjkCount = (trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
        const isCJK = cjkCount / trimmed.length > 0.3;

        if (isCJK) {
            const maxChars = defaultMaxChars;
            let pos = 0;
            while (pos < trimmed.length) {
                let end = Math.min(pos + maxChars, trimmed.length);
                if (end < trimmed.length) {
                    const chunk = trimmed.slice(pos, end + 4);
                    const breakAt = chunk.search(/[，。！？；、\s,\.!?;]/g);
                    if (breakAt > maxChars * 0.5) end = pos + breakAt + 1;
                }
                result.push(trimmed.slice(pos, end).trim());
                pos = end;
                while (pos < trimmed.length && trimmed[pos] === ' ') pos++;
            }
        } else {
            const words = trimmed.split(/\s+/);
            if (words.length <= 5) { result.push(trimmed); continue; }
            for (let i = 0; i < words.length; i += 5) {
                result.push(words.slice(i, i + 5).join(' '));
            }
        }
    }
    return result.filter(l => l).join('\n');
}

// ═══════════════════════════════════════════════════════
// 10. Batch Alignment (对齐字幕)
// ═══════════════════════════════════════════════════════

function _showMismatchDialog(taskName, mismatchData, sourceText) {
    return new Promise((resolve) => {
        // Create modal
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:99999;';

        const content = document.createElement('div');
        content.style.cssText = 'background:var(--bg-primary);width:600px;max-width:90%;border-radius:12px;padding:24px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 10px 40px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:16px;';

        const escapeHtml = (str) => {
            return String(str).replace(/[&<>'"]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match]));
        };

        content.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:24px;">⚠️</span>
                <h3 style="margin:0;color:var(--text-primary);">文案匹配度警告 (匹配度: ${mismatchData.similarity}%)</h3>
            </div>
            <div style="font-size:14px;color:var(--text-muted);line-height:1.5;">
                任务 <b style="color:var(--text-primary);">${escapeHtml(taskName)}</b> 提取到的声音与您提供的参考文案差异极大。<br/>
                强行对齐将导致字幕时间轴严重错乱。
            </div>
            <div style="display:flex;gap:12px;margin-top:8px;">
                <div style="flex:1;background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.05);">
                    <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-weight:bold;">📝 您提供的原文案</div>
                    <div style="font-size:13px;color:var(--text-primary);max-height:150px;overflow-y:auto;line-height:1.5;white-space:pre-wrap;">${escapeHtml(sourceText || '')}</div>
                </div>
                <div style="flex:1;background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.05);">
                    <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-weight:bold;">🎙️ AI 实际识别到的声音</div>
                    <div style="font-size:13px;color:var(--text-primary);max-height:150px;overflow-y:auto;line-height:1.5;white-space:pre-wrap;">${escapeHtml(mismatchData.recognized_text || '')}</div>
                </div>
            </div>
            <div style="font-size:13px;color:var(--text-muted);margin-top:10px;">请选择如何处理此任务：</div>
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px;">
                <button id="mismatch-btn-force" class="btn btn-secondary" style="flex:1;">⚠️ 强制使用原文案</button>
                <button id="mismatch-btn-skip" class="btn btn-secondary" style="flex:1;">⏭️ 跳过此任务</button>
                <button id="mismatch-btn-use" class="btn btn-primary" style="flex:1.5;background:var(--accent-color);color:white;border:none;">🚀 使用识别文案 (推荐)</button>
            </div>
        `;

        modal.appendChild(content);
        document.body.appendChild(modal);

        const cleanup = () => document.body.removeChild(modal);

        modal.querySelector('#mismatch-btn-force').addEventListener('click', () => { cleanup(); resolve('FORCE'); });
        modal.querySelector('#mismatch-btn-skip').addEventListener('click', () => { cleanup(); resolve('SKIP'); });
        modal.querySelector('#mismatch-btn-use').addEventListener('click', () => { cleanup(); resolve('USE_RECOGNIZED'); });
    });
}

// ═══════════════════════════════════════════════════════
// 10a-2. Word-level diff & candidate comparison dialog
// ═══════════════════════════════════════════════════════

function _lcsWordDiff(wordsA, wordsB) {
    const m = wordsA.length, n = wordsB.length;
    if (m === 0 && n === 0) return [];
    if (m === 0) return wordsB.map(w => ({ type: 'add', word: w }));
    if (n === 0) return wordsA.map(w => ({ type: 'remove', word: w }));
    const MAX = 600;
    const a = m > MAX ? wordsA.slice(0, MAX) : wordsA;
    const b = n > MAX ? wordsB.slice(0, MAX) : wordsB;
    const ml = a.length, nl = b.length;
    const dp = Array.from({ length: ml + 1 }, () => new Uint16Array(nl + 1));
    for (let i = 1; i <= ml; i++) {
        for (let j = 1; j <= nl; j++) {
            dp[i][j] = a[i - 1].toLowerCase() === b[j - 1].toLowerCase()
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    const result = [];
    let i = ml, j = nl;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1].toLowerCase() === b[j - 1].toLowerCase()) {
            result.unshift({ type: 'same', word: b[j - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.unshift({ type: 'add', word: b[j - 1] });
            j--;
        } else {
            result.unshift({ type: 'remove', word: a[i - 1] });
            i--;
        }
    }
    if (m > MAX || n > MAX) result.push({ type: 'same', word: '…(已截断)' });
    return result;
}

function _renderWordDiffHtml(recognizedText, candidateText) {
    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const wordsA = String(recognizedText || '').split(/\s+/).filter(Boolean);
    const wordsB = String(candidateText || '').split(/\s+/).filter(Boolean);
    const diff = _lcsWordDiff(wordsA, wordsB);
    return diff.map(d => {
        const w = esc(d.word);
        if (d.type === 'same') return w;
        if (d.type === 'remove') return `<span style="background:#fecaca;color:#991b1b;text-decoration:line-through;padding:0 2px;border-radius:2px;">${w}</span>`;
        if (d.type === 'add') return `<span style="background:#bbf7d0;color:#166534;padding:0 2px;border-radius:2px;">${w}</span>`;
        return w;
    }).join(' ');
}

/**
 * Show a modal with word-level diff between recognized text and all candidates.
 * Users can manually pick which candidate to use for alignment.
 * @returns {Promise<{action:'USE_CANDIDATE'|'USE_RECOGNIZED'|'SKIP', candidate?:object}>}
 */
function _showCandidateDiffDialog(taskName, recognizedText, candidates, currentSourceText) {
    // 最终保护：调用方即使因旧流程进入这里，也要先重新执行当前版本的
    // 数字归一化和高置信匹配。可靠候选直接采用，不再打断批量任务。
    const automaticMatch = _findBestBatchAlignCandidate(recognizedText, candidates);
    if (automaticMatch?.candidate) {
        console.log(
            `[BatchAlign] 候选弹窗前自动采用: ${taskName} -> ` +
            `第 ${automaticMatch.candidate.rowIndex + 1} 行 ` +
            `(${(automaticMatch.similarity * 100).toFixed(1)}%)`
        );
        return Promise.resolve({ action: 'USE_CANDIDATE', candidate: automaticMatch.candidate });
    }
    return new Promise((resolve) => {
        const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const scored = (candidates || []).map((c, i) => ({
            candidate: c, originalIndex: i,
            similarity: _textSimilarityForBatchAlign(recognizedText, c.sourceText),
        })).sort((a, b) => b.similarity - a.similarity);
        const maxShow = 12;
        const shown = scored.slice(0, maxShow);

        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px;';
        const panel = document.createElement('div');
        panel.style.cssText = 'background:#13132a;width:min(1100px,96vw);max-height:90vh;border-radius:14px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 20px 60px rgba(0,0,0,0.6);display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

        const candidateRows = shown.map((item, idx) => {
            const c = item.candidate;
            const sim = (item.similarity * 100).toFixed(1);
            const simColor = item.similarity >= 0.9 ? '#4ade80' : item.similarity >= 0.7 ? '#facc15' : item.similarity >= 0.5 ? '#fb923c' : '#f87171';
            const label = c.label || c.field || '文案';
            const rowNo = (c.rowIndex ?? -1) + 1;
            const diffHtml = _renderWordDiffHtml(recognizedText, c.sourceText);
            return `
                <tr data-cidx="${item.originalIndex}" class="cdd-row" style="transition:background 0.15s;">
                    <td style="padding:10px 8px;border-bottom:1px solid #1e1e3a;color:#aab;font-size:12px;text-align:center;width:36px;vertical-align:top;">${idx + 1}</td>
                    <td style="padding:10px 8px;border-bottom:1px solid #1e1e3a;width:110px;vertical-align:top;">
                        <div style="font-size:12px;color:#c8d0ff;font-weight:600;">${esc(label)}</div>
                        <div style="font-size:11px;color:#667;">第 ${rowNo} 行</div>
                    </td>
                    <td style="padding:10px 8px;border-bottom:1px solid #1e1e3a;width:70px;text-align:center;vertical-align:top;">
                        <span style="font-size:14px;font-weight:700;color:${simColor};">${sim}%</span>
                    </td>
                    <td style="padding:10px 8px;border-bottom:1px solid #1e1e3a;vertical-align:top;">
                        <div style="max-height:120px;overflow-y:auto;line-height:1.6;font-size:12px;color:#ccc;word-break:break-word;">${diffHtml}</div>
                    </td>
                    <td style="padding:10px 8px;border-bottom:1px solid #1e1e3a;width:70px;text-align:center;vertical-align:top;">
                        <button class="cdd-select-btn" data-cidx="${item.originalIndex}" style="
                            padding:5px 14px;border-radius:6px;border:1px solid #4f46e5;
                            background:linear-gradient(135deg,#4f46e5,#3730a3);color:#fff;
                            font-size:12px;cursor:pointer;font-weight:600;
                            transition:all 0.15s;white-space:nowrap;
                        ">用第 ${rowNo} 行</button>
                    </td>
                </tr>`;
        }).join('');

        const moreText = scored.length > maxShow
            ? `<div style="padding:8px;color:#667;font-size:12px;text-align:center;">还有 ${scored.length - maxShow} 条候选未显示...</div>` : '';

        panel.innerHTML = `
            <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:10px;flex-shrink:0;">
                <span style="font-size:22px;">🔍</span>
                <div style="flex:1;">
                    <h3 style="margin:0;color:#e8ecff;font-size:16px;font-weight:700;">请选择这条音频对应的正确文案</h3>
                    <div style="font-size:12px;color:#8b95c0;margin-top:4px;">当前任务：${esc(taskName)} · 选择后将使用该行原文重新生成 SRT</div>
                </div>
                <button data-action="SKIP" style="border:none;background:rgba(255,255,255,0.06);color:#999;border-radius:8px;padding:6px 12px;font-size:18px;cursor:pointer;line-height:1;" title="关闭">✕</button>
            </div>
            <div style="padding:12px 20px;background:rgba(59,130,246,0.06);border-bottom:1px solid rgba(255,255,255,0.04);flex-shrink:0;display:flex;gap:20px;">
                <div style="flex:1;">
                    <div style="font-size:12px;color:#60a5fa;font-weight:700;margin-bottom:6px;">🎙️ 这条音频实际说了什么（AI 听写，仅用于查找）</div>
                    <div style="font-size:12px;color:#d0d8ff;line-height:1.55;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;">${esc(recognizedText || '[无识别文案]')}</div>
                </div>
                <div style="width:1px;background:rgba(255,255,255,0.08);"></div>
                <div style="flex:1;">
                    <div style="font-size:12px;color:#a78bfa;font-weight:700;margin-bottom:6px;">📝 当前行原文（顺序混乱时可能不是这条音频）</div>
                    <div style="font-size:12px;color:#e9d5ff;line-height:1.55;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;">${esc(currentSourceText || '[无输入文案]')}</div>
                </div>
            </div>
            <div style="padding:12px 20px 4px;flex:1;overflow:auto;min-height:0;">
                <div style="font-size:12px;color:#8b95c0;font-weight:700;margin-bottom:8px;">
                    📋 从整张批量表格找到的相似文案（最可能的排在最前，共 ${scored.length} 条）
                    <span style="margin-left:12px;font-weight:400;color:#556;">
                        高亮: <span style="background:#fecaca;color:#991b1b;padding:1px 4px;border-radius:2px;font-size:11px;">识别多出</span>
                        <span style="background:#bbf7d0;color:#166534;padding:1px 4px;border-radius:2px;font-size:11px;margin-left:4px;">候选多出</span>
                    </span>
                </div>
                <table style="width:100%;border-collapse:collapse;">
                    <thead>
                        <tr style="background:rgba(255,255,255,0.03);">
                            <th style="padding:8px;color:#778;font-size:11px;text-align:center;border-bottom:1px solid #2a2a4a;width:36px;">#</th>
                            <th style="padding:8px;color:#778;font-size:11px;text-align:left;border-bottom:1px solid #2a2a4a;width:110px;">文案所在行</th>
                            <th style="padding:8px;color:#778;font-size:11px;text-align:center;border-bottom:1px solid #2a2a4a;width:70px;">匹配程度</th>
                            <th style="padding:8px;color:#778;font-size:11px;text-align:left;border-bottom:1px solid #2a2a4a;">该行原文与音频听写的差异</th>
                            <th style="padding:8px;color:#778;font-size:11px;text-align:center;border-bottom:1px solid #2a2a4a;width:100px;">确认使用</th>
                        </tr>
                    </thead>
                    <tbody>${candidateRows}</tbody>
                </table>
                ${moreText}
            </div>
            <div style="font-size:12px;color:#8b95c0;background:rgba(255,255,255,0.02);padding:10px 16px;border-top:1px solid rgba(255,255,255,0.04);line-height:1.45;">
                💡 <b>怎么选：</b>先听当前音频，再在上方候选中找到内容相同的文案，点击“用第 N 行”。系统会把该行原文分配给当前任务并重新生成 SRT。<br/>
                红色表示音频听写中有、候选原文中没有；绿色表示候选原文中有、音频听写中没有。
            </div>
            <div style="padding:12px 20px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:10px;justify-content:flex-end;background:rgba(0,0,0,0.15);flex-shrink:0;">
                <button data-action="SKIP" style="padding:8px 18px;border-radius:8px;border:1px solid #333;background:#1e1e38;color:#aaa;font-size:13px;cursor:pointer;transition:all .15s;">暂时找不到，跳过</button>
                <button data-action="USE_CURRENT_SOURCE" style="padding:8px 22px;border-radius:8px;border:1px solid #4f46e5;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font-size:13px;cursor:pointer;font-weight:600;transition:all .15s;">当前行原文就是正确的</button>
                <button data-action="USE_RECOGNIZED" style="padding:8px 22px;border-radius:8px;border:none;background:linear-gradient(135deg,#059669,#047857);color:#fff;font-size:13px;cursor:pointer;font-weight:600;transition:all .15s;">表格里没有，改用 AI 听写</button>
            </div>
        `;

        modal.appendChild(panel);
        document.body.appendChild(modal);
        const cleanup = () => { modal.remove(); };

        panel.querySelectorAll('.cdd-select-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const cidx = parseInt(btn.dataset.cidx, 10);
                cleanup();
                resolve({ action: 'USE_CANDIDATE', candidate: candidates[cidx] });
            });
            btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.05)'; btn.style.boxShadow = '0 0 12px rgba(79,70,229,0.4)'; });
            btn.addEventListener('mouseleave', () => { btn.style.transform = ''; btn.style.boxShadow = ''; });
        });
        panel.querySelectorAll('.cdd-row').forEach(row => {
            row.addEventListener('mouseenter', () => { row.style.background = 'rgba(79,70,229,0.08)'; });
            row.addEventListener('mouseleave', () => { row.style.background = ''; });
        });
        panel.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', () => { cleanup(); resolve({ action: btn.dataset.action }); });
        });
    });
}

function _formatTimingCalibration(calibration) {
    if (!calibration) return '未检测';
    const start = Number(calibration.start_delta || 0).toFixed(2);
    const end = Number(calibration.end_delta || 0).toFixed(2);
    const scale = Number(calibration.scale || 1).toFixed(4);
    if (calibration.applied) {
        return `已校准 起点${start}s / 终点${end}s / 缩放${scale}`;
    }
    return `未校准 起点${start}s / 终点${end}s / 缩放${scale}`;
}

function _buildBatchAlignSourceTextCandidates(tasks, lbMaxChars) {
    const candidates = [];
    const seen = new Set();
    const stats = {};
    const addCandidate = (rowIndex, field, label, rawText, task = null) => {
        const sourceText = _rbtSmartLineBreak(rawText || '', lbMaxChars);
        if (!sourceText.trim()) return;
        const key = `${rowIndex}:${field}:${sourceText.replace(/\s+/g, ' ').trim()}`;
        if (seen.has(key)) return;
        seen.add(key);
        stats[label] = (stats[label] || 0) + 1;
        candidates.push({
            rowIndex,
            field,
            label,
            id: task?.id || task?.baseName || task?.fileName || '',
            fileName: task?.fileName || task?.baseName || '',
            sourceText,
        });
    };

    // 先扫当前表格 DOM。用户眼睛能看到/刚粘进去的文案，以 DOM 为准进入候选池。
    const container = _batchTableState.container;
    if (container) {
        container.querySelectorAll('tr.rbt-row').forEach(row => {
            const rowIndex = parseInt(row.dataset.idx, 10);
            if (!Number.isFinite(rowIndex)) return;
            const task = tasks?.[rowIndex] || null;
            addCandidate(rowIndex, 'txtContent', '人声-断行文案', row.querySelector('.rbt-txtcontent-input')?.value || '', task);
            addCandidate(rowIndex, 'ttsText', '人声-配音文案', row.querySelector('.rbt-tts-text-input')?.value || '', task);
            addCandidate(rowIndex, 'aiScript', '人声-原文案', row.querySelector('.rbt-ai-script-input')?.value || '', task);
            addCandidate(rowIndex, 'overlay_title', '覆层标题', row.querySelector('.rbt-title-input')?.value || '', task);
            addCandidate(rowIndex, 'overlay_body', '覆层内容', row.querySelector('.rbt-body-input')?.value || '', task);
            const domScrollBody = row.querySelector('.rbt-scroll-body-input')?.value || '';
            addCandidate(rowIndex, 'scroll_body', '滚动字幕正文', domScrollBody === '滚动文字内容\n第二行文字\n第三行文字\n第四行文字\n第五行文字' ? '' : domScrollBody, task);
            addCandidate(rowIndex, 'scroll_title', '滚动标题', row.querySelector('.rbt-scroll-title-input')?.value || '', task);
        });
    }

    const fields = [
        ['txtContent', '人声-断行文案'],
        ['ttsText', '人声-配音文案'],
        ['aiScript', '人声-原文案'],
        ['txtPath', 'TXT文件'],
        ['overlay_title', '覆层标题'],
        ['overlay_body', '覆层内容'],
        ['scroll_body', '滚动字幕正文'],
        ['scroll_title', '滚动标题'],
    ];

    (tasks || []).forEach((task, rowIndex) => {
        fields.forEach(([field, label]) => {
            let rawText = task?.[field] || '';
            if (field === 'txtPath') {
                rawText = '';
                const txtPath = task?.txtPath || '';
                if (txtPath && window.electronAPI?.readFileText) {
                    try { rawText = window.electronAPI.readFileText(txtPath) || ''; } catch (_) { rawText = ''; }
                }
            }
            if (field === 'overlay_title') rawText = _findBatchTextCardOverlay(task)?.title_text || '';
            if (field === 'overlay_body') rawText = _findBatchTextCardOverlay(task)?.body_text || '';
            if (field === 'scroll_body') {
                const sc = _findBatchScrollOverlay(task)?.content || '';
                rawText = sc === '滚动文字内容\n第二行文字\n第三行文字\n第四行文字\n第五行文字' ? '' : sc;
            }
            if (field === 'scroll_title') rawText = _findBatchScrollOverlay(task)?.scroll_title || '';
            addCandidate(rowIndex, field, label, rawText, task);
        });
    });

    candidates.stats = stats;
    return candidates;
}

function _normalizeStrictSubtitleMatch(text) {
    const normalizeEnglishNumbers = (value) => {
        let result = String(value || '');
        const units = {
            one: 1, two: 2, three: 3, four: 4, five: 5,
            six: 6, seven: 7, eight: 8, nine: 9,
        };
        const tens = {
            twenty: 20, thirty: 30, forty: 40, fifty: 50,
            sixty: 60, seventy: 70, eighty: 80, ninety: 90,
        };
        for (const [tensWord, tensValue] of Object.entries(tens)) {
            for (const [unitWord, unitValue] of Object.entries(units)) {
                result = result.replace(
                    new RegExp(`\\b${tensWord}[ -]+${unitWord}\\b`, 'gi'),
                    String(tensValue + unitValue)
                );
            }
        }
        const fixed = {
            eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
            sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
            ...tens, zero: 0, ten: 10, ...units,
        };
        for (const [word, number] of Object.entries(fixed)) {
            result = result.replace(new RegExp(`\\b${word}\\b`, 'gi'), String(number));
        }
        return result;
    };
    try {
        return normalizeEnglishNumbers(text)
            .toLowerCase()
            .normalize('NFKC')
            .replace(/[^\p{L}\p{N}]/gu, '');
    } catch (_) {
        return normalizeEnglishNumbers(text)
            .toLowerCase()
            .replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
    }
}

function _findExactBatchAlignCandidate(recognizedText, candidates) {
    const recognized = _normalizeStrictSubtitleMatch(recognizedText);
    if (!recognized) return null;
    const matches = (candidates || []).filter(c => _normalizeStrictSubtitleMatch(c.sourceText) === recognized);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
        // 相同文案出现在多行时，选哪一行生成的 SRT 内容都一致；把它们视为同一个候选，
        // 避免因为重复粘贴的文案而阻断自动匹配。
        console.warn(`[BatchAlign] 候选池有 ${matches.length} 条完全相同文案，按同一候选处理。`);
    }
    return matches[0];
}

function _levenshteinDistance(a, b) {
    a = String(a || '');
    b = String(b || '');
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                curr[j - 1] + 1,
                prev[j] + 1,
                prev[j - 1] + cost
            );
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

function _textSimilarityForBatchAlign(a, b) {
    const na = _normalizeStrictSubtitleMatch(a);
    const nb = _normalizeStrictSubtitleMatch(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen === 0) return 0;
    return 1 - (_levenshteinDistance(na, nb) / maxLen);
}

function _findBestBatchAlignCandidate(recognizedText, candidates) {
    const exact = _findExactBatchAlignCandidate(recognizedText, candidates);
    if (exact) return { candidate: exact, similarity: 1, exact: true };

    // 表格中同一份文案可能被粘贴到多行。先按规范化文案去重，
    // 否则前两名是同一内容时会被误判成“候选太接近”。
    const uniqueCandidates = [];
    const seenTexts = new Set();
    for (const candidate of candidates || []) {
        const normalized = _normalizeStrictSubtitleMatch(candidate?.sourceText);
        if (!normalized || seenTexts.has(normalized)) continue;
        seenTexts.add(normalized);
        uniqueCandidates.push(candidate);
    }
    const scored = uniqueCandidates
        .map(candidate => ({
            candidate,
            similarity: _textSimilarityForBatchAlign(recognizedText, candidate.sourceText),
        }))
        .filter(item => item.similarity > 0)
        .sort((a, b) => b.similarity - a.similarity);

    const best = scored[0];
    if (!best) return null;
    const second = scored[1];
    const bestNormLen = _normalizeStrictSubtitleMatch(best.candidate.sourceText).length;
    // 长文经常因章节号、开头口播或尾部口号被 ASR 多读/漏读，整体编辑距离会偏低。
    // 对长文允许 80% 的高置信命中，但必须明显领先第二候选，避免相似模板文案误配。
    const threshold = bestNormLen < 40 ? 0.94 : 0.80;
    const margin = second ? best.similarity - second.similarity : 1;
    const requiredMargin = bestNormLen < 40 ? 0.06 : 0.10;
    // 97% 以上通常只剩断行、标点或极少量 ASR 尾词差异，即使相似模板很多，
    // 也不应再要求人工点选。低于 97% 时仍要求明显领先第二名。
    if (best.similarity >= 0.97 || (best.similarity >= threshold && margin >= requiredMargin)) return best;
    return null;
}

function _buildBatchAlignCandidateDebug(recognizedText, candidates, maxItems = 12) {
    const recognized = String(recognizedText || '').replace(/\s+/g, ' ').trim();
    const scored = (candidates || [])
        .map(candidate => ({
            candidate,
            similarity: _textSimilarityForBatchAlign(recognizedText, candidate.sourceText),
        }))
        .sort((a, b) => b.similarity - a.similarity);
    const lines = [];
    lines.push(`识别文案: ${recognized || '[空]'}`);
    lines.push(`候选池(${(candidates || []).length}条):`);
    scored.slice(0, maxItems).forEach((item, i) => {
        const c = item.candidate;
        const text = String(c.sourceText || '').replace(/\s+/g, ' ').trim();
        lines.push(`${i + 1}. ${(item.similarity * 100).toFixed(1)}% 第${(c.rowIndex ?? -1) + 1}行 ${c.label || c.field || '文案'}: ${text}`);
    });
    if (scored.length > maxItems) lines.push(`... 还有 ${scored.length - maxItems} 条`);
    return lines.join('\n');
}

function _compactBatchAlignText(text, maxLen = 220) {
    const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
    return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}...` : oneLine;
}

function _buildBatchAlignMatchReport(taskName, recognizedText, matchedCandidate, matchDesc) {
    const label = matchedCandidate?.label || matchedCandidate?.field || '文案';
    const rowNo = (matchedCandidate?.rowIndex ?? -1) + 1;
    const matchedText = matchedCandidate?.sourceText || '';
    return `${taskName}: 已重新找到正确文案 ${label} 第 ${rowNo} 行（${matchDesc}）\n` +
        `识别文案: ${_compactBatchAlignText(recognizedText)}\n` +
        `匹配文案: ${_compactBatchAlignText(matchedText)}`;
}

function _extractPlainTextFromSrtContent(srtContent) {
    return String(srtContent || '')
        .split(/\r?\n/)
        .filter(line => {
            const t = line.trim();
            if (!t) return false;
            if (/^\d+$/.test(t)) return false;
            if (/-->/i.test(t)) return false;
            return true;
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _buildBatchAlignTripleReport(taskName, recognizedText, matchedCandidate, srtText, matchDesc) {
    const label = matchedCandidate?.label || matchedCandidate?.field || '文案';
    const rowNo = (matchedCandidate?.rowIndex ?? -1) + 1;
    const matchedText = matchedCandidate?.sourceText || '';
    const recognizedNorm = _normalizeStrictSubtitleMatch(recognizedText);
    const matchedNorm = _normalizeStrictSubtitleMatch(matchedText);
    const srtNorm = _normalizeStrictSubtitleMatch(srtText);
    // ASR 识别文案允许有口头词、拼写和标点差异，不能用来否决已按正确原文生成的 SRT。
    // 硬校验只检查“找到的文案”与“SRT 文案”是否一致。
    const allSame = !!matchedNorm && matchedNorm === srtNorm;
    const recognizedExact = !!recognizedNorm && recognizedNorm === matchedNorm;
    return `${taskName}: ${allSame ? '✅ 文案与 SRT 一致' : '⚠️ 文案与 SRT 不一致'}${recognizedExact ? '' : '（识别稿仅供参考）'} ${label} 第 ${rowNo} 行（${matchDesc}）\n` +
        `| 识别文案 | 找到的文案 | SRT 文案 |\n` +
        `| ${_compactBatchAlignText(recognizedText)} | ${_compactBatchAlignText(matchedText)} | ${_compactBatchAlignText(srtText)} |`;
}

function _buildBatchAlignTripleTableRow(taskName, recognizedText, matchedCandidate, srtText, matchDesc, audioPath = '') {
    const label = matchedCandidate?.label || matchedCandidate?.field || '文案';
    const rowNo = (matchedCandidate?.rowIndex ?? -1) + 1;
    const matchedText = matchedCandidate?.sourceText || '';
    const recognizedNorm = _normalizeStrictSubtitleMatch(recognizedText);
    const matchedNorm = _normalizeStrictSubtitleMatch(matchedText);
    const srtNorm = _normalizeStrictSubtitleMatch(srtText);
    // 只有原文和最终 SRT 不一致才是生成失败；ASR 文本差异只做提示。
    const allSame = !!matchedNorm && matchedNorm === srtNorm;
    const recognizedExact = !!recognizedNorm && recognizedNorm === matchedNorm;
    return {
        allSame,
        recognizedExact,
        summary: `${taskName} | ${allSame ? '✅一致' : '⚠️不一致'} | ${label}第${rowNo}行 | ${matchDesc}`,
        taskName,
        label,
        rowNo,
        matchDesc,
        audioPath,
        recognizedText: String(recognizedText || '').replace(/\s+/g, ' ').trim(),
        matchedText: String(matchedText || '').replace(/\s+/g, ' ').trim(),
        srtText: String(srtText || '').replace(/\s+/g, ' ').trim(),
        table: [
            `任务: ${taskName}  ${allSame ? '✅ 文案与 SRT 一致' : '⚠️ 文案与 SRT 不一致'}${recognizedExact ? '' : ' / 识别稿有差异'}  (${label}第${rowNo}行 / ${matchDesc})`,
            `识别源: ${audioPath}`,
            `┌──────────┬────────────────────────────────────────┐`,
            `│ 识别文案 │ ${String(recognizedText || '').replace(/\s+/g, ' ').trim()}`,
            `│ 找到文案 │ ${String(matchedText || '').replace(/\s+/g, ' ').trim()}`,
            `│ SRT文案  │ ${String(srtText || '').replace(/\s+/g, ' ').trim()}`,
            `└──────────┴────────────────────────────────────────┘`,
        ].join('\n'),
        full: _buildBatchAlignTripleReport(taskName, recognizedText, matchedCandidate, srtText, matchDesc),
    };
}

function _showBatchAlignResultModal({ title, sourceInfo, rows, failDetails, footer }) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:24px;';

        const box = document.createElement('div');
        box.style.cssText = 'width:min(1180px,96vw);max-height:90vh;background:#f5f6f8;color:#202124;border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,0.35);display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

        const esc = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
        const textCell = (text) => `<div style="max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;line-height:1.45;font-size:12px;color:#1f2937;">${esc(text)}</div>`;

        const tableRows = (rows || []).map(r => `
            <tr>
                <td style="width:120px;vertical-align:top;padding:10px;border-bottom:1px solid #d8dde6;font-weight:700;color:${r.allSame ? '#15803d' : '#b45309'};">
                    ${esc(r.taskName)}<br>
                    <span style="font-size:11px;font-weight:600;">${r.manualConfirmed ? '人工确认通过' : (r.allSame ? (r.recognizedExact === false ? '已生成，识别稿有差异' : '一致') : '待人工处理')}</span><br>
                    <span style="font-size:11px;color:#6b7280;">${esc(r.label)}第${r.rowNo}行</span>
                </td>
                <td style="vertical-align:top;padding:10px;border-bottom:1px solid #d8dde6;">${textCell(r.recognizedText)}</td>
                <td style="vertical-align:top;padding:10px;border-bottom:1px solid #d8dde6;">${textCell(r.matchedText)}</td>
                <td style="vertical-align:top;padding:10px;border-bottom:1px solid #d8dde6;">${textCell(r.srtText)}</td>
            </tr>
        `).join('');

        // 结果总览不能只写“失败”。把转录和匹配拆开：用户需要知道是平台
        // 没有识别到声音，还是已经识别成功、但无法把文字对应到文案。
        const phaseRows = [];
        (rows || []).forEach(r => {
            phaseRows.push({
                taskName: r.taskName,
                recognition: '✅ 转录成功',
                matching: r.manualConfirmed ? '✅ 文案匹配成功（人工确认）' : '✅ 文案匹配成功',
                detail: r.matchDesc || r.label || '',
            });
        });
        (failDetails || []).forEach(detail => {
            const text = String(detail || '');
            const separator = text.indexOf(':');
            const taskName = separator >= 0 ? text.slice(0, separator) : '未命名任务';
            const reason = separator >= 0 ? text.slice(separator + 1).trim() : text;
            // 收到“字幕对齐失败/长度不同/文案不匹配”说明云端已经返回了
            // 可用的时间词，失败发生在第二步。其他情况才归为转录未完成。
            const recognitionSucceeded = /字幕对齐失败|长度不同|TEXT_MISMATCH|AUTO_SOURCE_MATCH|原文与 SRT 不一致|匹配度/.test(reason);
            phaseRows.push({
                taskName,
                recognition: recognitionSucceeded ? '✅ 转录成功' : '❌ 转录失败',
                matching: recognitionSucceeded ? '❌ 文案匹配/对齐失败' : '— 未执行匹配',
                detail: reason,
            });
        });
        const phaseSummary = phaseRows.length ? `
            <div style="margin-bottom:14px;border:1px solid #d8dde6;border-radius:8px;overflow:hidden;background:#fff;">
                <div style="padding:9px 12px;background:#eef2f7;font-size:13px;font-weight:700;">本次处理结果</div>
                ${phaseRows.map(row => `<div style="display:grid;grid-template-columns:minmax(120px,0.75fr) minmax(130px,0.8fr) minmax(190px,1.15fr) minmax(0,2fr);gap:10px;padding:9px 12px;border-top:1px solid #e5e7eb;font-size:12px;align-items:start;">
                    <b style="color:#374151;word-break:break-word;">${esc(row.taskName)}</b>
                    <span style="color:${row.recognition.startsWith('✅') ? '#15803d' : '#dc2626'};font-weight:600;">${esc(row.recognition)}</span>
                    <span style="color:${row.matching.startsWith('✅') ? '#15803d' : (row.matching.startsWith('❌') ? '#dc2626' : '#6b7280')};font-weight:600;">${esc(row.matching)}</span>
                    <span style="color:#6b7280;word-break:break-word;">${esc(row.detail)}</span>
                </div>`).join('')}
            </div>` : '';

        const failures = (failDetails || []).length
            ? `<div style="margin-top:14px;padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;color:#9a3412;font-size:13px;white-space:pre-wrap;">${esc((failDetails || []).join('\n'))}</div>`
            : '';

        box.innerHTML = `
            <div style="padding:16px 20px;border-bottom:1px solid #d8dde6;display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
                <div>
                    <div style="font-size:20px;font-weight:800;margin-bottom:6px;">${esc(title)}</div>
                    <div style="font-size:13px;color:#4b5563;">${esc(sourceInfo || '')}</div>
                </div>
                <button data-close style="border:none;background:#e5e7eb;color:#111827;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer;">关闭</button>
            </div>
            <div style="padding:16px 20px;overflow:auto;">
                <div style="margin-bottom:14px;padding:10px 12px;background:#eef6ff;border:1px solid #bfdbfe;border-radius:8px;color:#1e3a5f;font-size:12px;line-height:1.6;">
                    <b>处理说明：</b>
                    “一致”表示自动校验通过；
                    “已生成，识别稿有差异”表示 SRT 与选中原文一致，但需听音频确认是语音说错还是识别偏差；
                    “人工确认通过”可继续预览和导出；
                    “待人工处理”表示 SRT 已保留，请核对音频、原文和 SRT 后重新对齐或人工确认。
                </div>
                ${phaseSummary}
                ${(rows || []).length ? `
                    <table style="width:100%;border-collapse:collapse;table-layout:fixed;background:white;border:1px solid #d8dde6;border-radius:8px;overflow:hidden;">
                        <thead>
                            <tr style="background:#eef2f7;">
                                <th style="width:120px;text-align:left;padding:10px;border-bottom:1px solid #d8dde6;">任务</th>
                                <th style="text-align:left;padding:10px;border-bottom:1px solid #d8dde6;">识别文案</th>
                                <th style="text-align:left;padding:10px;border-bottom:1px solid #d8dde6;">找到的文案</th>
                                <th style="text-align:left;padding:10px;border-bottom:1px solid #d8dde6;">SRT 文案</th>
                            </tr>
                        </thead>
                        <tbody>${tableRows}</tbody>
                    </table>
                ` : ''}
                ${failures}
                <div style="margin-top:12px;font-size:13px;color:#4b5563;">${esc(footer || '')}</div>
            </div>
            <div style="padding:12px 20px;border-top:1px solid #d8dde6;display:flex;justify-content:flex-end;background:#f9fafb;">
                <button data-close style="border:none;background:#0b84ff;color:white;border-radius:9px;padding:9px 34px;font-size:15px;cursor:pointer;">OK</button>
            </div>
        `;

        modal.appendChild(box);
        document.body.appendChild(modal);
        modal.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => {
            modal.remove();
            resolve();
        }));
    });
}

async function _discardTaskSrtBeforeRefind(task, taskName) {
    const oldSrtPath = task?.srtPath || '';
    if (!task) return false;

    task.srtPath = '';
    task.segments = [];
    task.aligned = false;
    task.alignedAt = '';
    task.alignSource = '';
    task.alignMatchedText = '';
    task.alignManualConfirmed = false;
    task.alignManualConfirmReason = '';
    task.alignReviewPending = false;
    task.autoMatchedSourceIndex = null;
    task.autoMatchedSourceRow = null;
    task.autoMatchedSourceField = '';
    task.autoMatchedSourceLabel = '';

    if (!oldSrtPath || !/\.srt$/i.test(oldSrtPath) || /^(blob:|data:|https?:)/i.test(oldSrtPath)) {
        return false;
    }

    try {
        const resp = await apiFetch(`${API_BASE}/file/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: oldSrtPath }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            console.warn(`[BatchAlign] 旧 SRT 删除失败: ${taskName || ''}`, oldSrtPath, err.error || '');
        } else {
            console.log(`[BatchAlign] 已删除旧错误 SRT: ${oldSrtPath}`);
        }
    } catch (e) {
        console.warn(`[BatchAlign] 旧 SRT 删除异常: ${taskName || ''}`, oldSrtPath, e);
    }
    return true;
}

async function _deleteGeneratedSubtitleFiles(files, taskName) {
    const subtitleFiles = (files || []).filter(p => typeof p === 'string' && /\.(srt|fcpxml)$/i.test(p));
    for (const filePath of subtitleFiles) {
        try {
            await apiFetch(`${API_BASE}/file/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: filePath }),
            });
            console.log(`[BatchAlign] 已删除未确认匹配生成文件: ${taskName || ''} ${filePath}`);
        } catch (e) {
            console.warn(`[BatchAlign] 删除未确认匹配生成文件失败: ${taskName || ''}`, filePath, e);
        }
    }
}

async function _batchClearTaskCache(idx) {
    const state = window._reelsState;
    if (!state || !state.tasks || !state.tasks[idx]) return;
    const task = state.tasks[idx];
    
    // 收集该任务所有可能的媒体路径，一并清理，防止残留
    const pathsToClear = new Set();
    if (task.audioPath) pathsToClear.add(task.audioPath);
    if (task.bgPath) pathsToClear.add(task.bgPath);
    if (task.videoPath) pathsToClear.add(task.videoPath);

    if (pathsToClear.size === 0) {
        alert('当前任务缺少音频/视频源，无法清除缓存');
        return;
    }
    const language = document.getElementById('rbt-align-lang')?.value || '英语';
    try {
        let deletedJson = false, deletedTxt = false;
        for (const p of pathsToClear) {
            const resp = await apiFetch(`${API_BASE}/subtitle/clear-cache`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audio_path: p, language })
            });
            if (resp.ok) {
                const res = await resp.json();
                if (res.deletedJson) deletedJson = true;
                if (res.deletedTxt) deletedTxt = true;
            }
        }
        alert(`✅ [${task.baseName || '任务'}] 相关所有缓存已清除\n删除JSON: ${deletedJson ? '是' : '否'}\n删除TXT: ${deletedTxt ? '是' : '否'}`);
    } catch (e) {
        console.error(e);
        alert(`❌ 清除缓存出错: ${e.message}`);
    }
}

async function _batchClearAllCache() {
    const state = window._reelsState;
    if (!state || !state.tasks || state.tasks.length === 0) return;
    if (!confirm(`确定要清除当前列表中所有任务的识别缓存吗？`)) return;
    
    const language = document.getElementById('rbt-align-lang')?.value || '英语';
    let successCount = 0;
    
    const btn = _batchTableState.container?.querySelector('#rbt-clear-all-cache-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 清除中...'; }
    
    for (let i = 0; i < state.tasks.length; i++) {
        const task = state.tasks[i];
        const pathsToClear = new Set();
        if (task.audioPath) pathsToClear.add(task.audioPath);
        if (task.bgPath) pathsToClear.add(task.bgPath);
        if (task.videoPath) pathsToClear.add(task.videoPath);

        if (pathsToClear.size === 0) continue;
        
        let taskSuccess = false;
        for (const p of pathsToClear) {
            try {
                const resp = await apiFetch(`${API_BASE}/subtitle/clear-cache`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ audio_path: p, language })
                });
                if (resp.ok) taskSuccess = true;
            } catch (e) {
                console.warn(`[BatchAlign] 路径 ${p} 缓存清除失败`, e);
            }
        }
        if (taskSuccess) successCount++;
    }
    
    if (btn) { btn.disabled = false; btn.textContent = '全局清缓存'; }
    alert(`✅ 批量清除完毕，共尝试清理 ${successCount} 个任务的相关缓存`);
}

async function _batchAlignAllTasks(overrideForce = false) {
    const alignOptions = (overrideForce && typeof overrideForce === 'object') ? overrideForce : {};
    const silent = !!alignOptions.silent;
    const targetIndexSet = Array.isArray(alignOptions.targetIndices) ? new Set(alignOptions.targetIndices) : null;
    const singleTaskMode = !!targetIndexSet;
    const legacyForce = overrideForce === true || alignOptions.force === true;
    // 先同步表格输入到 task
    _applyBatchTableChanges();

    const state = window._reelsState;
    if (!state) return;

    const alignSource = alignOptions.alignSource || document.getElementById('rbt-align-source')?.value || 'video';
    const forceRealign = alignOptions.forceRealign ?? (legacyForce || (document.getElementById('rbt-force-realign')?.checked || false));
    const forceTranscribe = alignOptions.forceTranscribe ?? (document.getElementById('rbt-force-transcribe')?.checked || false);
    const allowBlind = document.getElementById('rbt-allow-blind')?.checked || false;
    const autoDetect = alignOptions.autoDetect ?? (document.getElementById('rbt-align-auto-detect')?.checked || false);

    const textSourceCol = document.getElementById('rbt-align-txt-col')?.value || 'txtContent';
    const allowScrollBlind = (textSourceCol === 'scroll_body' || textSourceCol === 'scroll_title');
    const effectiveAllowBlind = allowBlind || allowScrollBlind;

    const getSourceText = (t) => {
        if (textSourceCol === 'ttsText') return t.ttsText || '';
        if (textSourceCol === 'txtContent') return t.txtContent || '';
        if (textSourceCol === 'overlay_title') {
            const ov = _findBatchTextCardOverlay(t);
            return ov ? ov.title_text || '' : '';
        }
        if (textSourceCol === 'overlay_body') {
            const ov = _findBatchTextCardOverlay(t);
            return ov ? ov.body_text || '' : '';
        }
        if (textSourceCol === 'scroll_body') {
            const sov = _findBatchScrollOverlay(t);
            const raw = sov ? sov.content || '' : '';
            return raw === '滚动文字内容\n第二行文字\n第三行文字\n第四行文字\n第五行文字' ? '' : raw;
        }
        if (textSourceCol === 'scroll_title') {
            const sov = _findBatchScrollOverlay(t);
            return sov ? sov.scroll_title || '' : '';
        }
        return '';
    };

    const setSourceText = (t, val) => {
        if (!t || val == null) return;
        const textVal = String(val);
        if (textSourceCol === 'txtContent') t.txtContent = textVal;
        else if (textSourceCol === 'ttsText') t.ttsText = textVal;
        else if (textSourceCol === 'overlay_title' || textSourceCol === 'overlay_body' || textSourceCol === 'scroll_body' || textSourceCol === 'scroll_title') {
            _applyOverlayField(t, textSourceCol, textVal);
        }
    };

    const getAlignAudioPath = (t) => {
        if (!t) return '';
        let raw = '';
        if (alignOptions.forceAudioSource === true) raw = t.audioPath || '';
        // 严格模式：只使用用户明确选择的源，不做静默 fallback
        else if (alignSource === 'video') raw = t.bgPath || t.videoPath || '';
        // alignSource === 'audio' (默认)：只用人声-音频文件
        else raw = t.audioPath || '';

        if (!raw) return '';
        let p = String(raw).trim();
        if (p.startsWith('file://')) {
            try { p = decodeURIComponent(p.replace(/^file:\/\//i, '')); } catch (_) { p = p.replace(/^file:\/\//i, ''); }
        }
        // 如果是相对文件名且设置了素材文件夹，尝试从素材文件夹补全完整路径
        if (p && !p.startsWith('/') && !/^[A-Z]:\\/i.test(p)) {
            const activeTab = typeof _getActiveTab === 'function' ? _getActiveTab() : null;
            const matDir = activeTab?.materialDir || (typeof _batchTableState !== 'undefined' && _batchTableState?.tabs?.[0]?.materialDir) || '';
            if (matDir) {
                const sep = matDir.includes('\\') ? '\\' : '/';
                const candidate = `${matDir.replace(/[\\/]+$/, '')}${sep}${p}`;
                p = candidate;
            }
        }
        return p;
    };

    const allSourceTextCandidates = _buildBatchAlignSourceTextCandidates(state.tasks || [], 16);

    // ── 预检查：找出有文案但没有音频源的任务，给出明确提示 ──
    const tasksWithTextButNoAudio = [];
    state.tasks.forEach((t, idx) => {
        if (targetIndexSet && !targetIndexSet.has(idx)) return;
        const text = getSourceText(t);
        if (!text || !text.trim()) return;
        if ((t.aligned || t.srtPath) && !forceRealign && !forceTranscribe && !singleTaskMode) return;
        if (!getAlignAudioPath(t)) {
            tasksWithTextButNoAudio.push({ idx, name: t.baseName || t.fileName || `任务${idx + 1}` });
        }
    });
    if (tasksWithTextButNoAudio.length > 0) {
        const names = tasksWithTextButNoAudio.slice(0, 10).map(x => `  第${x.idx + 1}行: ${x.name}`).join('\n');
        const more = tasksWithTextButNoAudio.length > 10 ? `\n  ... 等共 ${tasksWithTextButNoAudio.length} 个` : '';
        const sourceLabel = alignSource === 'video' ? '背景视频' : '人声-音频文件(MP3)';
        alert(`⚠️ 以下 ${tasksWithTextButNoAudio.length} 个任务有文案但缺少${sourceLabel}，无法对齐：\n\n${names}${more}\n\n请先添加${sourceLabel}文件，或切换「识别源」设置。`);
        if (tasksWithTextButNoAudio.length === state.tasks.length ||
            (targetIndexSet && tasksWithTextButNoAudio.length === targetIndexSet.size)) {
            return; // 全部都缺音频，直接返回
        }
    }

    // 筛选需要对齐的任务: 有音频源 + (选定的文本列有内容/候选池有内容/允许盲转或听译滚动字幕) + (未对齐/无 SRT 或 强制)
    const tasksToAlign = state.tasks.filter(t => {
        const idx = state.tasks.indexOf(t);
        if (targetIndexSet && !targetIndexSet.has(idx)) return false;
        const text = getSourceText(t);
        const canFindSourceFromPool = allSourceTextCandidates.length > 0 && (forceRealign || forceTranscribe || singleTaskMode);
        if ((!text || !text.trim()) && !effectiveAllowBlind && !singleTaskMode && !canFindSourceFromPool) return false;
        if ((t.aligned || t.srtPath) && !forceRealign && !forceTranscribe && !singleTaskMode) return false;
        return !!getAlignAudioPath(t);
    });

    if (tasksToAlign.length === 0) {
        const alreadyAligned = state.tasks.filter(t => {
            const text = getSourceText(t);
            return (text && text.trim() && t.aligned) || !!t.srtPath;
        }).length;
        if (alreadyAligned > 0 && !forceRealign && !forceTranscribe && !singleTaskMode) {
            const candidateCount = _buildBatchAlignSourceTextCandidates(state.tasks || [], 16).length;
            const runAgain = confirm(
                `没有未对齐任务。\n\n` +
                `当前有 ${alreadyAligned} 个任务已对齐完成。\n` +
                `自动文案候选池约 ${candidateCount} 条。\n\n` +
                `是否对这些已对齐任务执行「重新查找文案并生成 SRT」？\n` +
                `这会复用已有识别缓存，不会强制重新转录。`
            );
            if (runAgain) {
                return _batchAlignAllTasks({ forceRealign: true, force: false, forceTranscribe: false });
            }
        } else if (alreadyAligned > 0) {
            alert(`没有需要对齐的任务。\n\n📋 当前有 ${alreadyAligned} 个任务已对齐完成。\n\n💡 如需重新生成，请勾选「强制重新查找/对齐」后再点击对齐。`);
        } else {
            alert('没有需要对齐的任务。\n请确认：\n1. 所选文案列有文案（或开启无文本听译/选择滚动字幕正文听译）\n2. 有人声-音频文件或背景视频文件\n3. 尚未对齐');
        }
        return;
    }

    let lbMaxChars = 16;
    try {
        const settingsResp = await apiFetch('settings/gemini-keys');
        const settingsData = await settingsResp.json();
        if (settingsData && settingsData.lbMaxChars) lbMaxChars = settingsData.lbMaxChars;
    } catch (e) { }

    const progressEl = document.getElementById('rbt-align-progress');
    const alignBtn = document.getElementById('rbt-align-all-btn');
    if (!silent && alignBtn) { alignBtn.disabled = true; alignBtn.textContent = '⏳ 对齐中...'; }

    let ok = 0, fail = 0;
    const failDetails = [];
    const calibrationDetails = [];
    const autoMatchDetails = [];
    const tripleReportRows = [];
    let freshCount = 0, cacheCount = 0; // 追踪转录来源统计
    let calibrationCount = 0;
    let autoMatchCount = 0;
    let autoMatchNotFoundCount = 0;
    let autoMatchEmptyPoolCount = 0;
    let discardedSrtCount = 0;
    const language = document.getElementById('rbt-align-lang')?.value || '英语';
    const sourceTextCandidates = _buildBatchAlignSourceTextCandidates(state.tasks || [], lbMaxChars);
    const candidateStatsText = Object.entries(sourceTextCandidates.stats || {})
        .map(([label, count]) => `${label}${count}`)
        .join(' / ') || '无';
    const candidatePreviewText = sourceTextCandidates.slice(0, 5)
        .map(c => `第${c.rowIndex + 1}行${c.label}: ${String(c.sourceText || '').replace(/\s+/g, ' ').slice(0, 40)}`)
        .join(' | ') || '无';
    console.log(`[BatchAlign] 自动文案候选池: ${sourceTextCandidates.length} 条（来自全部 ${state.tasks.length} 个任务行；${candidateStatsText}），待处理任务: ${tasksToAlign.length} 条，重新查找: ${forceRealign || forceTranscribe || singleTaskMode ? '是' : '否'}，重新转录: ${forceTranscribe ? '是' : '否'}`);
    if (progressEl) progressEl.textContent = `🔎 全部任务行候选池 ${sourceTextCandidates.length} 条（${candidateStatsText}）`;

    for (let i = 0; i < tasksToAlign.length; i++) {
        const task = tasksToAlign[i];
        const taskName = task.baseName || task.fileName || `任务${i + 1}`;
        const isRealignRedo = forceRealign || forceTranscribe || singleTaskMode || task.aligned || !!task.srtPath;
        const strictRefind = isRealignRedo;
        if (progressEl) progressEl.textContent = `🔗 对齐 ${i + 1}/${tasksToAlign.length}: ${taskName}${isRealignRedo ? (forceTranscribe ? ' (强制重新转录)' : ' (重新查找)') : ''}`;

        try {
            if (isRealignRedo) {
                if (progressEl) progressEl.textContent = `🗑️ 废弃旧 SRT，准备从全部任务行重找: ${taskName}`;
                if (await _discardTaskSrtBeforeRefind(task, taskName)) discardedSrtCount++;
            }

            // 确定音频路径
            const audioPath = getAlignAudioPath(task);

            if (!audioPath) throw new Error('没有音频文件');
            console.log(`[BatchAlign] 实际送去识别的媒体源: ${taskName} -> ${audioPath}`);
            if (progressEl) progressEl.textContent = `🎙️ 识别源: ${taskName} · ${_shortName(audioPath)}`;

            // 自动断行文案
            const ownText = _rbtSmartLineBreak(getSourceText(task), lbMaxChars);
            // “重新查找”时不能先拿本行文案继续生成。文案顺序可能已经乱了，
            // 必须把本行当作未知来源，只从整张表的候选池中重新命中。
            let sourceText = (strictRefind && autoDetect) ? '' : ownText;

            let ignoreMismatch = !autoDetect;
            let retryAlign = true;
            let resp = null;
            // Phase 1 核心：如果开启自动查找，先传递候选池给后端直接核对匹配
            let useAutoCandidates = autoDetect;
            let requireAutoSourceMatch = !!(strictRefind && autoDetect && sourceTextCandidates.length > 0);
            let triedOwnTextFirst = !autoDetect && !!ownText.trim();
            // 当前行没有文案时，直接走候选池
            if (autoDetect && !ownText.trim() && sourceTextCandidates.length > 0) {
                useAutoCandidates = true;
                requireAutoSourceMatch = strictRefind || singleTaskMode;
                triedOwnTextFirst = false;
            }
            let forceThisRequest = forceTranscribe ? true : false;
            let foundExactSourceThisRun = false;
            let confirmedMatchedCandidate = null;
            let confirmedMatchDesc = '';
            let confirmedRecognizedText = '';

            if (strictRefind && sourceTextCandidates.length === 0 && !ownText.trim()) {
                if (effectiveAllowBlind) {
                    useAutoCandidates = false;
                    requireAutoSourceMatch = false;
                    ignoreMismatch = true;
                } else {
                    throw new Error('重找失败：全部任务行文案候选池为空且当前行无文案，无法找到准确文案。');
                }
            }

            const audioDir = audioPath.replace(/[\\/][^\\/]+$/, '');
            while (retryAlign) {
                retryAlign = false;
                // 调用对齐API（使用 apiFetch + API_BASE）
                if (progressEl) {
                    const modeLabel = triedOwnTextFirst ? '当前行文案' : (useAutoCandidates ? `候选池 ${sourceTextCandidates.length} 条` : '直接对齐');
                    progressEl.textContent = `🔗 对齐 ${i + 1}/${tasksToAlign.length}: ${taskName} · ${modeLabel}${isRealignRedo ? (forceTranscribe ? ' (强制重新转录)' : ' (重新对齐)') : ''}`;
                }
                console.log(`[BatchAlign] 请求字幕生成: task=${taskName}, force=${forceThisRequest ? 'true' : 'false'}, forceTranscribe=${forceTranscribe ? 'true' : 'false'}, audio=${audioPath}`);
                resp = await apiFetch(`${API_BASE}/subtitle/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        audio_path: audioPath,
                        source_text: sourceText,
                        source_text_candidates: useAutoCandidates ? sourceTextCandidates : undefined,
                        require_auto_source_match: requireAutoSourceMatch,
                        language: language,
                        audio_cut_length: 5.0,
                        output_dir: audioDir,
                        // 多 Key 并行时，当前 worker 会把不同 Key 放在首位；后端仍可在失败时轮换备用 Key。
                        gladia_keys: Array.isArray(alignOptions.gladiaKeys) ? alignOptions.gladiaKeys : undefined,
                        force: forceThisRequest,  // 只有“强制重新转录”才删除识别缓存；重试复用缓存
                        ignore_mismatch: ignoreMismatch
                    }),
                });
                forceThisRequest = false;

                if (!resp.ok) {
                    const err = await resp.json();
                    let errMsg = err.error || '对齐失败';

                    // 候选池精确命中失败时后端会返回 AUTO_SOURCE_MATCH_NOT_FOUND，
                    // 之前这里只识别 TEXT_MISMATCH，导致前端的高相似度兜底完全没运行，
                    // 最终错误地直接弹出候选列表。
                    if (errMsg.includes('"code":"TEXT_MISMATCH"') ||
                        errMsg.includes('"code":"AUTO_SOURCE_MATCH_NOT_FOUND"') ||
                        errMsg.includes('"code":"AUTO_SOURCE_MATCH_REQUIRED"')) {
                        try {
                            const mismatchData = JSON.parse(errMsg);
                            // Phase 1: 当前行文案不匹配 → 静默回退到候选池查找
                            if (triedOwnTextFirst && sourceTextCandidates.length > 0) {
                                console.log(`[BatchAlign] 当前行文案不匹配，回退候选池查找: ${taskName}`);
                                if (progressEl) progressEl.textContent = `🔍 ${taskName}: 当前行文案不匹配，尝试候选池 ${sourceTextCandidates.length} 条...`;
                                triedOwnTextFirst = false;
                                useAutoCandidates = true;
                                requireAutoSourceMatch = true;
                                retryAlign = true;
                                continue;
                            }
                            if (useAutoCandidates && mismatchData.recognized_text) {
                                const matched = _findBestBatchAlignCandidate(mismatchData.recognized_text, sourceTextCandidates);
                                const matchedCandidate = matched?.candidate;
                                // _findBest 已保证相似候选既达到阈值又领先第二名，安全时可自动采用。
                                if (matchedCandidate) {
                                    const matchDesc = matched.exact ? '完全匹配' : `高相似匹配 ${(matched.similarity * 100).toFixed(1)}%`;
                                    console.log(`[BatchAlign] 前端兜底匹配成功(${matchDesc}): ${taskName} -> ${matchedCandidate.label || matchedCandidate.field || '文案'} #${matchedCandidate.rowIndex + 1}`);
                                    sourceText = matchedCandidate.sourceText;
                                    setSourceText(task, sourceText);
                                    task.autoMatchedSourceIndex = sourceTextCandidates.indexOf(matchedCandidate);
                                    task.autoMatchedSourceField = matchedCandidate.field || '';
                                    task.autoMatchedSourceLabel = matchedCandidate.label || '';
                                    autoMatchCount++;
                                    foundExactSourceThisRun = true;
                                    confirmedMatchedCandidate = matchedCandidate;
                                    confirmedMatchDesc = matchDesc;
                                    confirmedRecognizedText = mismatchData.recognized_text || '';
                                    console.log(`[BatchAlign] 匹配核对\n${_buildBatchAlignMatchReport(taskName, mismatchData.recognized_text, matchedCandidate, matchDesc)}`);
                                    useAutoCandidates = false;
                                    requireAutoSourceMatch = false;
                                    // 这里已经由候选池确认了高相似来源；第二次请求只负责
                                    // 按选中的文案生成时间轴，不应再落回旧版 TEXT_MISMATCH 弹窗。
                                    ignoreMismatch = true;
                                    retryAlign = true;
                                    continue;
                                }
                                console.log(`[BatchAlign] 前端兜底匹配失败: ${taskName}, 候选池 ${sourceTextCandidates.length} 条`);
                            }
                            // 使用差异对比弹窗（如果有候选池）或旧的简易弹窗
                            let mismatchChoice;
                            if (useAutoCandidates && sourceTextCandidates.length > 0) {
                                const diffResult = await _showCandidateDiffDialog(
                                    `${taskName}（候选池 ${sourceTextCandidates.length} 条，未找到完全匹配文案）`,
                                    mismatchData.recognized_text || '', sourceTextCandidates, getSourceText(task)
                                );
                                if (diffResult.action === 'USE_CANDIDATE') {
                                    const picked = diffResult.candidate;
                                    sourceText = picked.sourceText;
                                    setSourceText(task, sourceText);
                                    task.autoMatchedSourceIndex = sourceTextCandidates.indexOf(picked);
                                    task.autoMatchedSourceField = picked.field || '';
                                    task.autoMatchedSourceLabel = picked.label || '';
                                    autoMatchCount++;
                                    foundExactSourceThisRun = true;
                                    confirmedMatchedCandidate = picked;
                                    confirmedMatchDesc = '手动选择';
                                    confirmedRecognizedText = mismatchData.recognized_text || '';
                                    useAutoCandidates = false;
                                    requireAutoSourceMatch = false;
                                    ignoreMismatch = true;
                                    retryAlign = true;
                                    continue;
                                }
                                if (diffResult.action === 'USE_CURRENT_SOURCE') {
                                    sourceText = getSourceText(task);
                                    useAutoCandidates = false;
                                    requireAutoSourceMatch = false;
                                    ignoreMismatch = true;
                                    retryAlign = true;
                                    foundExactSourceThisRun = true;
                                    continue;
                                }
                                mismatchChoice = diffResult.action === 'USE_RECOGNIZED' ? 'USE_RECOGNIZED' : 'SKIP';
                            } else {
                                mismatchChoice = await _showMismatchDialog(taskName, mismatchData, getSourceText(task));
                            }
                            if (mismatchChoice === 'USE_RECOGNIZED') {
                                const newText = mismatchData.recognized_text;
                                setSourceText(task, newText);
                                // 自动断行以便传入对齐
                                sourceText = _rbtSmartLineBreak(newText, lbMaxChars);
                                useAutoCandidates = false;
                                requireAutoSourceMatch = false;
                                ignoreMismatch = true;
                                retryAlign = true;
                                foundExactSourceThisRun = true;
                                task.alignMatchedText = '强制使用识别文案';
                                continue;
                            } else if (mismatchChoice === 'FORCE') {
                                useAutoCandidates = false;
                                requireAutoSourceMatch = false;
                                ignoreMismatch = true;
                                retryAlign = true;
                                foundExactSourceThisRun = true;
                                task.alignMatchedText = '强制使用原文案';
                                continue;
                            } else {
                                throw new Error('用户跳过对齐 (匹配度过低)');
                            }
                        } catch (e) {
                            if (e.message.includes('跳过')) throw e;
                            if (e.message.includes('重找失败')) throw e;
                            console.error('[BatchAlign] TEXT_MISMATCH 处理异常（可能是弹窗代码错误）:', e);
                            // 弹窗内部错误也应上抛，避免静默吞掉
                            if (e.message.includes('手动选择') || e.message.includes('USE_CANDIDATE')) throw e;
                        }
                    }

                    if (errMsg.includes('"code":"AUTO_SOURCE_MATCH_NOT_FOUND"') || errMsg.includes('"code":"AUTO_SOURCE_MATCH_REQUIRED"')) {
                        try {
                            const mismatchData = JSON.parse(errMsg);
                            mismatchData.similarity = mismatchData.similarity ?? 0;
                            if (mismatchData.recognized_text) {
                                const matched = _findBestBatchAlignCandidate(mismatchData.recognized_text, sourceTextCandidates);
                                const matchedCandidate = matched?.candidate;
                                if (matchedCandidate) {
                                    const matchDesc = matched.exact ? '完全匹配' : `高相似匹配 ${(matched.similarity * 100).toFixed(1)}%`;
                                    console.log(`[BatchAlign] 前端自动匹配兜底成功(${matchDesc}): ${taskName} -> ${matchedCandidate.label || matchedCandidate.field || '文案'} #${matchedCandidate.rowIndex + 1}`);
                                    sourceText = matchedCandidate.sourceText;
                                    setSourceText(task, sourceText);
                                    task.autoMatchedSourceIndex = sourceTextCandidates.indexOf(matchedCandidate);
                                    task.autoMatchedSourceField = matchedCandidate.field || '';
                                    task.autoMatchedSourceLabel = matchedCandidate.label || '';
                                    autoMatchCount++;
                                    foundExactSourceThisRun = true;
                                    confirmedMatchedCandidate = matchedCandidate;
                                    confirmedMatchDesc = matchDesc;
                                    confirmedRecognizedText = mismatchData.recognized_text || '';
                                    console.log(`[BatchAlign] 匹配核对\n${_buildBatchAlignMatchReport(taskName, mismatchData.recognized_text, matchedCandidate, matchDesc)}`);
                                    useAutoCandidates = false;
                                    requireAutoSourceMatch = false;
                                    ignoreMismatch = true;
                                    retryAlign = true;
                                    continue;
                                }
                            }
                            // 使用差异对比弹窗（如果有候选池）或旧的简易弹窗
                            let autoMatchChoice;
                            if (sourceTextCandidates.length > 0) {
                                const diffResult = await _showCandidateDiffDialog(
                                    `${taskName}（候选池 ${sourceTextCandidates.length} 条，未找到完全匹配文案）`,
                                    mismatchData.recognized_text || '', sourceTextCandidates, getSourceText(task)
                                );
                                if (diffResult.action === 'USE_CANDIDATE') {
                                    const picked = diffResult.candidate;
                                    sourceText = picked.sourceText;
                                    setSourceText(task, sourceText);
                                    task.autoMatchedSourceIndex = sourceTextCandidates.indexOf(picked);
                                    task.autoMatchedSourceField = picked.field || '';
                                    task.autoMatchedSourceLabel = picked.label || '';
                                    autoMatchCount++;
                                    foundExactSourceThisRun = true;
                                    confirmedMatchedCandidate = picked;
                                    confirmedMatchDesc = '手动选择';
                                    confirmedRecognizedText = mismatchData.recognized_text || '';
                                    useAutoCandidates = false;
                                    requireAutoSourceMatch = false;
                                    ignoreMismatch = true;
                                    retryAlign = true;
                                    continue;
                                }
                                if (diffResult.action === 'USE_CURRENT_SOURCE') {
                                    sourceText = getSourceText(task);
                                    useAutoCandidates = false;
                                    requireAutoSourceMatch = false;
                                    ignoreMismatch = true;
                                    retryAlign = true;
                                    foundExactSourceThisRun = true;
                                    continue;
                                }
                                autoMatchChoice = diffResult.action === 'USE_RECOGNIZED' ? 'USE_RECOGNIZED' : 'SKIP';
                            } else {
                                const dialogTaskName = `${taskName}（候选池为空，未执行自动匹配）`;
                                autoMatchChoice = await _showMismatchDialog(dialogTaskName, mismatchData, getSourceText(task));
                            }
                            useAutoCandidates = false;
                            if (autoMatchChoice === 'USE_RECOGNIZED') {
                                const newText = mismatchData.recognized_text || '';
                                setSourceText(task, newText);
                                sourceText = _rbtSmartLineBreak(newText, lbMaxChars);
                                requireAutoSourceMatch = false;
                                ignoreMismatch = true;
                                retryAlign = true;
                                foundExactSourceThisRun = true;
                                task.alignMatchedText = '强制使用识别文案';
                                continue;
                            } else if (autoMatchChoice === 'FORCE') {
                                requireAutoSourceMatch = false;
                                ignoreMismatch = true;
                                retryAlign = true;
                                foundExactSourceThisRun = true;
                                task.alignMatchedText = '强制使用原文案';
                                continue;
                            } else {
                                throw new Error('用户跳过对齐 (自动匹配无完全一致文案)');
                            }
                        } catch (e) {
                            if (e.message.includes('跳过')) throw e;
                            if (e.message.includes('重找失败')) throw e;
                            console.error('[BatchAlign] AUTO_SOURCE_MATCH 处理异常（可能是弹窗代码错误）:', e);
                            // 弹窗内部错误也应上抛，避免静默吞掉
                            if (e.message.includes('手动选择') || e.message.includes('USE_CANDIDATE')) throw e;
                        }
                    }
                    throw new Error(errMsg);
                }
            }

            let data = await resp.json();
            foundExactSourceThisRun = true;
            if (data.auto_matched_source) {
                autoMatchCount++;
                foundExactSourceThisRun = true;
                sourceText = _rbtSmartLineBreak(data.auto_matched_source.source_text || sourceText, lbMaxChars);
                setSourceText(task, sourceText);
                task.autoMatchedSourceIndex = data.auto_matched_source.index;
                const matchedCandidate = sourceTextCandidates[data.auto_matched_source.index];
                task.autoMatchedSourceField = matchedCandidate?.field || '';
                task.autoMatchedSourceLabel = matchedCandidate?.label || '';
                const label = task.autoMatchedSourceLabel || task.autoMatchedSourceField || '文案';
                const rowNo = matchedCandidate ? matchedCandidate.rowIndex + 1 : data.auto_matched_source.index + 1;
                const matchedRecognizedText = data.recognized_text || '';
                confirmedMatchedCandidate = matchedCandidate || { rowIndex: rowNo - 1, label, sourceText };
                confirmedMatchDesc = '后端完全匹配';
                confirmedRecognizedText = matchedRecognizedText || '';
                console.log(`[BatchAlign] 匹配核对\n${_buildBatchAlignMatchReport(taskName, matchedRecognizedText, confirmedMatchedCandidate, '后端完全匹配')}`);
                console.log(`[BatchAlign] 后端自动匹配成功: ${taskName} -> ${label} #${rowNo}`);
                task.alignMatchedText = `${label} 第 ${rowNo} 行`;
            }
            if (isRealignRedo && !data.auto_matched_source && confirmedMatchedCandidate) {
                foundExactSourceThisRun = true;
                task.autoMatchedSourceIndex = sourceTextCandidates.indexOf(confirmedMatchedCandidate);
                task.autoMatchedSourceField = confirmedMatchedCandidate.field || '';
                task.autoMatchedSourceLabel = confirmedMatchedCandidate.label || '';
                task.alignMatchedText = `${confirmedMatchedCandidate.label || confirmedMatchedCandidate.field || '文案'} 第 ${confirmedMatchedCandidate.rowIndex + 1} 行`;
                console.log(`[BatchAlign] 使用前端已确认文案重新生成成功${confirmedMatchDesc ? `(${confirmedMatchDesc})` : ''}: ${taskName} -> ${task.alignMatchedText}`);
            }
            if (isRealignRedo && !foundExactSourceThisRun) {
                let finalMatchText = data.recognized_text || '';

                // 后端未返回识别文案时的兜底策略
                if (!finalMatchText) {
                    // 策略 1：候选池只有 1 条，直接使用（无需匹配）
                    if (sourceTextCandidates.length === 1) {
                        const onlyCandidate = sourceTextCandidates[0];
                        sourceText = onlyCandidate.sourceText;
                        setSourceText(task, sourceText);
                        task.autoMatchedSourceIndex = 0;
                        task.autoMatchedSourceField = onlyCandidate.field || '';
                        task.autoMatchedSourceLabel = onlyCandidate.label || '';
                        task.alignMatchedText = `${onlyCandidate.label || onlyCandidate.field || '文案'} 第 ${onlyCandidate.rowIndex + 1} 行`;
                        confirmedMatchedCandidate = onlyCandidate;
                        confirmedMatchDesc = '唯一候选自动使用';
                        confirmedRecognizedText = '';
                        foundExactSourceThisRun = true;
                        autoMatchCount++;
                        console.log(`[BatchAlign] 候选池仅 1 条，直接使用: ${taskName} -> ${task.alignMatchedText}`);
                    }
                    // 策略 2：尝试从已生成的 SRT 文件提取文案进行匹配
                    else if (data.files && data.files.length > 0) {
                        const srtFile = data.files.find(f => f.endsWith('_source.srt')) || data.files[0];
                        if (srtFile && window.electronAPI?.readFileText) {
                            try {
                                const srtContent = await window.electronAPI.readFileText(srtFile);
                                finalMatchText = _extractPlainTextFromSrtContent(srtContent);
                                console.log(`[BatchAlign] 后端未返回识别文案，从 SRT 提取: ${taskName} -> ${finalMatchText.slice(0, 80)}...`);
                            } catch (e) {
                                console.warn(`[BatchAlign] 读取 SRT 提取文案失败: ${taskName}`, e);
                            }
                        }
                    }
                    if (!finalMatchText && !foundExactSourceThisRun) {
                        console.warn(`[BatchAlign] 后端未返回识别文案，也无法从 SRT 提取: ${taskName}`);
                    }
                }

                if (!foundExactSourceThisRun && finalMatchText) {
                    const matched = _findBestBatchAlignCandidate(finalMatchText, sourceTextCandidates);
                    const matchedCandidate = matched?.candidate;
                    if (matchedCandidate) {
                        const matchDesc = matched.exact ? '完全匹配' : `高相似匹配 ${(matched.similarity * 100).toFixed(1)}%`;
                        const currentNorm = _normalizeStrictSubtitleMatch(sourceText);
                        const matchedNorm = _normalizeStrictSubtitleMatch(matchedCandidate.sourceText);
                        sourceText = matchedCandidate.sourceText;
                        setSourceText(task, sourceText);
                        task.autoMatchedSourceIndex = sourceTextCandidates.indexOf(matchedCandidate);
                        task.autoMatchedSourceField = matchedCandidate.field || '';
                        task.autoMatchedSourceLabel = matchedCandidate.label || '';
                        task.alignMatchedText = `${matchedCandidate.label || matchedCandidate.field || '文案'} 第 ${matchedCandidate.rowIndex + 1} 行`;
                        confirmedMatchedCandidate = matchedCandidate;
                        confirmedMatchDesc = matchDesc;
                        confirmedRecognizedText = finalMatchText || '';

                        if (currentNorm !== matchedNorm) {
                            await _deleteGeneratedSubtitleFiles(data.files, taskName);
                            const regenResp = await apiFetch(`${API_BASE}/subtitle/generate`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    audio_path: audioPath,
                                    source_text: sourceText,
                                    language: language,
                                    audio_cut_length: 5.0,
                                    output_dir: audioDir,
                                    force: false,
                                    ignore_mismatch: true
                                }),
                            });
                            if (!regenResp.ok) {
                                const err = await regenResp.json().catch(() => ({}));
                                throw new Error(`重找已找到准确文案，但重新生成 SRT 失败: ${err.error || '未知错误'}`);
                            }
                            data = await regenResp.json();
                            console.log(`[BatchAlign] 最终保护用确认文案重新生成成功(${matchDesc}): ${taskName} -> ${task.alignMatchedText}`);
                        } else {
                            console.log(`[BatchAlign] 最终保护确认当前生成文案正确(${matchDesc}): ${taskName} -> ${task.alignMatchedText}`);
                        }
                        foundExactSourceThisRun = true;
                        autoMatchCount++;
                        console.log(`[BatchAlign] 匹配核对\n${_buildBatchAlignMatchReport(taskName, finalMatchText, matchedCandidate, matchDesc)}`);
                    }
                }
            }
            if (isRealignRedo && !foundExactSourceThisRun) {
                const recognizedText = data.recognized_text || finalMatchText || '';
                const mismatchData = {
                    similarity: 0,
                    recognized_text: recognizedText || '[后端未返回识别文案]',
                };
                const userSourceText = getSourceText(task) || sourceText;
                console.warn(`[BatchAlign] 重找未匹配，弹出对比弹窗: ${taskName}`);

                // 使用差异对比弹窗（如果有候选池）或旧的简易弹窗
                let refindChoice;
                let refindHandled = false;
                if (sourceTextCandidates.length > 0) {
                    const diffResult = await _showCandidateDiffDialog(
                        `${taskName}（候选池 ${sourceTextCandidates.length} 条，未自动匹配到）`,
                        recognizedText || mismatchData.recognized_text || '', sourceTextCandidates, userSourceText
                    );
                    if (diffResult.action === 'USE_CANDIDATE') {
                        const picked = diffResult.candidate;
                        sourceText = _rbtSmartLineBreak(picked.sourceText, lbMaxChars);
                        setSourceText(task, picked.sourceText);
                        task.autoMatchedSourceIndex = sourceTextCandidates.indexOf(picked);
                        task.autoMatchedSourceField = picked.field || '';
                        task.autoMatchedSourceLabel = picked.label || '';
                        confirmedMatchedCandidate = picked;
                        confirmedMatchDesc = '手动选择';
                        confirmedRecognizedText = recognizedText || '';
                        await _deleteGeneratedSubtitleFiles(data.files, taskName);
                        const regenResp = await apiFetch(`${API_BASE}/subtitle/generate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                audio_path: audioPath,
                                source_text: sourceText,
                                language: language,
                                audio_cut_length: 5.0,
                                output_dir: audioDir,
                                force: false,
                                ignore_mismatch: true
                            }),
                        });
                        if (regenResp.ok) {
                            data = await regenResp.json();
                            foundExactSourceThisRun = true;
                            autoMatchCount++;
                        } else {
                            const err = await regenResp.json().catch(() => ({}));
                            throw new Error(`使用选择的文案重新生成 SRT 失败: ${err.error || '未知错误'}`);
                        }
                        refindHandled = true;
                    } else if (diffResult.action === 'USE_CURRENT_SOURCE') {
                        sourceText = _rbtSmartLineBreak(userSourceText, lbMaxChars);
                        setSourceText(task, userSourceText);
                        confirmedMatchDesc = '使用提供文案';
                        confirmedRecognizedText = recognizedText || '';
                        await _deleteGeneratedSubtitleFiles(data.files, taskName);
                        const regenResp = await apiFetch(`${API_BASE}/subtitle/generate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                audio_path: audioPath,
                                source_text: sourceText,
                                language: language,
                                audio_cut_length: 5.0,
                                output_dir: audioDir,
                                force: false,
                                ignore_mismatch: true
                            }),
                        });
                        if (regenResp.ok) {
                            data = await regenResp.json();
                            foundExactSourceThisRun = true;
                            autoMatchCount++;
                        } else {
                            const err = await regenResp.json().catch(() => ({}));
                            throw new Error(`使用提供的文案重新生成 SRT 失败: ${err.error || '未知错误'}`);
                        }
                        refindHandled = true;
                    } else {
                        refindChoice = diffResult.action === 'USE_RECOGNIZED' ? 'USE_RECOGNIZED' : 'SKIP';
                    }
                } else {
                    refindChoice = await _showMismatchDialog(
                        `${taskName}（候选池为空，未自动匹配到）`,
                        mismatchData,
                        userSourceText
                    );
                }

                if (!refindHandled) {
                    if (refindChoice === 'USE_RECOGNIZED' && recognizedText && recognizedText !== '[后端未返回识别文案]') {
                        setSourceText(task, recognizedText);
                        sourceText = _rbtSmartLineBreak(recognizedText, lbMaxChars);
                        // 用识别文案重新生成 SRT
                        await _deleteGeneratedSubtitleFiles(data.files, taskName);
                        const regenResp = await apiFetch(`${API_BASE}/subtitle/generate`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                audio_path: audioPath,
                                source_text: sourceText,
                                language: language,
                                audio_cut_length: 5.0,
                                output_dir: audioDir,
                                force: false,
                                ignore_mismatch: true
                            }),
                        });
                        if (regenResp.ok) {
                            data = await regenResp.json();
                            foundExactSourceThisRun = true;
                        } else {
                            const err = await regenResp.json().catch(() => ({}));
                            throw new Error(`使用识别文案重新生成 SRT 失败: ${err.error || '未知错误'}`);
                        }
                    } else if (refindChoice === 'FORCE') {
                        // 保留当前已生成的 SRT，直接通过
                        foundExactSourceThisRun = true;
                    } else {
                        await _deleteGeneratedSubtitleFiles(data.files, taskName);
                        throw new Error('用户跳过对齐 (重找未匹配)');
                    }
                }
            }

            // 统计转录来源
            if (data.transcription_source === 'gladia_fresh') freshCount++;
            else if (data.transcription_source === 'gladia_cache') cacheCount++;
            if (data.timing_calibration) {
                task.timingCalibration = data.timing_calibration;
                if (data.timing_calibration.applied) calibrationCount++;
                calibrationDetails.push(`${taskName}: ${_formatTimingCalibration(data.timing_calibration)}`);
            }

            // 保存 SRT 路径并解析 segments。不能仅凭接口 200 就标记“已对齐”：
            // 后端偶发未返回生成文件时，旧逻辑会显示成功，却没有把 SRT 链接到任务。
            const generatedSrtFiles = Array.isArray(data.files)
                ? data.files.filter(f => typeof f === 'string' && /\.srt$/i.test(f))
                : [];
            const srtFile = generatedSrtFiles.find(f => /_source\.srt$/i.test(f)) || generatedSrtFiles[0];
            if (!srtFile) {
                throw new Error('对齐未返回可链接的 SRT 文件；本任务未标记为已对齐，请重试。');
            }
            task.srtPath = srtFile;

            if (window.electronAPI && window.electronAPI.readFileText) {
                const srtContent = await window.electronAPI.readFileText(srtFile);
                if (!String(srtContent || '').trim()) {
                    throw new Error(`生成的 SRT 为空或无法读取：${srtFile}`);
                }
                const srtPlainText = _extractPlainTextFromSrtContent(srtContent);
                const rawSegs = (typeof parseSRT === 'function' ? parseSRT(srtContent) : []).map(seg => ({ ...seg, _timeUnit: 'sec' }));
                task.segments = window.ReelsSubtitleProcessor
                    ? ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegs)
                    : rawSegs;
                _rbtApplyPendingFirstSubtitleStyle(task);

                // 当目标列（如滚动字幕正文）为空并走听译对齐时，自动将听译/SRT文案回填到所选列
                if (!getSourceText(task).trim() && (srtPlainText || data.recognized_text)) {
                    const recognizedLines = rawSegs.map(s => String(s.text || '').trim()).filter(Boolean).join('\n')
                        || _rbtSmartLineBreak(data.recognized_text || srtPlainText, lbMaxChars);
                    if (recognizedLines.trim()) {
                        setSourceText(task, recognizedLines);
                        sourceText = recognizedLines;
                        if (!task.alignMatchedText) task.alignMatchedText = '🎙️ 听译自动生成';
                    }
                }

                if (isRealignRedo && confirmedMatchedCandidate) {
                        const recognizedForReport = confirmedRecognizedText || data.recognized_text || sourceText;
                        const triple = _buildBatchAlignTripleTableRow(
                            taskName,
                            recognizedForReport || '[后端未返回识别文案]',
                            confirmedMatchedCandidate,
                            srtPlainText,
                            confirmedMatchDesc || '已确认匹配',
                            audioPath
                        );
                        autoMatchDetails.push(triple.table);
                        tripleReportRows.push(triple);
                        console.log(`[BatchAlign] 三列完整核对\n${triple.full}`);
                        if (!triple.allSame) {
                            const keepSrt = window.confirm(
                                `${taskName}：原文与最终 SRT 文案不一致。\n\n` +
                                `说明：这可能是断行、字符归一化或实际文案差异导致。SRT 已保留，请对照音频检查字幕内容和时间轴。\n\n` +
                                `点击“确定”：确认没问题，保留并继续。\n` +
                                `点击“取消”：保留 SRT，标记为待处理；修改原文或音频后再执行重新对齐。`
                            );
                            if (keepSrt) {
                                triple.allSame = true;
                                triple.manualConfirmed = true;
                                triple.matchDesc = `${triple.matchDesc || ''} / 人工确认`;
                                task.alignManualConfirmed = true;
                                task.alignManualConfirmReason = 'source_srt_difference';
                            } else {
                                task.aligned = false;
                                task.alignReviewPending = true;
                                throw new Error(`原文与 SRT 不一致，SRT 已保留，等待人工处理。\n\n${triple.table}`);
                            }
                        } else if (!triple.recognizedExact) {
                            // “重找”已明确选择/自动匹配到来源文案，且该来源与 SRT 一致时，
                            // ASR 稿的轻微听写差异仅作为报告信息，不应阻断或再次要求确认。
                            task.alignRecognitionDifference = true;
                            console.warn(`[BatchAlign] 识别稿与来源文案存在差异，但 SRT 已按已确认文案生成: ${taskName}`);
                        }
                }
            }

            task.aligned = true;
            task.alignedAt = new Date().toLocaleString('zh-CN');
            task.alignSource = data.transcription_source || 'unknown';
            const matchedCandidate = Number.isInteger(task.autoMatchedSourceIndex)
                ? sourceTextCandidates[task.autoMatchedSourceIndex] : null;
            if (matchedCandidate) {
                task.autoMatchedSourceRow = matchedCandidate.rowIndex;
                task.alignMatchedText = matchedCandidate.rowIndex === state.tasks.indexOf(task)
                    ? '✅ 本行文案匹配'
                    : `🔁 匹配第 ${matchedCandidate.rowIndex + 1} 行文案`;
            } else if (!task.alignMatchedText && ownText.trim()) {
                task.alignMatchedText = '✅ 本行文案匹配';
            }
            // Phase 3: 为所有成功任务构建报告行
            if (!tripleReportRows.find(r => r.taskName === taskName)) {
                const taskIdx = state.tasks.indexOf(task);
                const srtPlain = task.srtPath && window.electronAPI?.readFileText
                    ? _extractPlainTextFromSrtContent(window.electronAPI.readFileText(task.srtPath) || '') : '';
                tripleReportRows.push({
                    allSame: true,
                    taskName,
                    label: task.alignMatchedText || '文案',
                    rowNo: taskIdx + 1,
                    matchDesc: confirmedMatchDesc || (task.alignMatchedText === '当前行文案 ✓' ? '当前行直接匹配' : '自动匹配'),
                    audioPath: audioPath,
                    recognizedText: confirmedRecognizedText || data.recognized_text || '',
                    matchedText: sourceText.replace(/\s+/g, ' ').trim(),
                    srtText: srtPlain,
                });
            }
            ok++;
        } catch (err) {
            console.error('[BatchAlign] Failed:', taskName, err);
            failDetails.push(`${taskName}: ${err.message}`);
            fail++;
        }
    }

    // 完成
    if (!silent && alignBtn) { alignBtn.disabled = false; alignBtn.textContent = '🔗 对齐字幕'; }
    if (!silent && progressEl) {
        progressEl.textContent = fail > 0
            ? `⚠️ 对齐完成 ${ok}/${tasksToAlign.length}，失败 ${fail}`
            : `✅ 全部对齐完成 (${ok}个)`;
        setTimeout(() => { if (progressEl) progressEl.textContent = ''; }, 8000);
    }

    if (!silent) {
        _renderBatchTable();
        if (typeof _renderTaskList === 'function') _renderTaskList();
    }

    // 构建详细报告
    const sourceDesc = [];
    if (discardedSrtCount > 0) sourceDesc.push(`🗑️ 已删除旧错误 SRT ${discardedSrtCount} 个`);
    if (freshCount > 0) sourceDesc.push(`🎙️ 新转录 ${freshCount} 个`);
    if (cacheCount > 0) sourceDesc.push(`📦 使用缓存 ${cacheCount} 个`);
    if (autoMatchCount > 0) sourceDesc.push(`✅ 已重新找到正确文案 ${autoMatchCount} 个`);
    if (autoMatchNotFoundCount > 0) sourceDesc.push(`⚠️ 未找到准确文案 ${autoMatchNotFoundCount} 个`);
    if (autoMatchEmptyPoolCount > 0) sourceDesc.push(`⚠️ 候选池为空 ${autoMatchEmptyPoolCount} 个`);
    if (calibrationCount > 0) sourceDesc.push(`⏱️ 自动校准 ${calibrationCount} 个`);
    const sourceInfo = sourceDesc.length > 0 ? `\n处理统计: ${sourceDesc.join(', ')}` : '';
    const calibrationInfo = calibrationDetails.length > 0
        ? `\n\n校准结果:\n${calibrationDetails.slice(0, 8).join('\n')}${calibrationDetails.length > 8 ? '\n...' : ''}`
        : '';
    const autoMatchInfo = autoMatchDetails.length > 0
        ? `\n\n三列核对表（识别文案 / 找到的文案 / SRT 文案）:\n${autoMatchDetails.join('\n\n')}`
        : '';

    // Phase 3: 始终弹出可视化报告弹窗
    if (silent) {
        return { ok, fail, total: tasksToAlign.length, failDetails };
    }
    if (tripleReportRows.length > 0 || fail > 0) {
        await _showBatchAlignResultModal({
            title: fail > 0 ? `对齐完成 ${ok}/${tasksToAlign.length}，失败 ${fail}` : `✅ 字幕对齐完成 ${ok} 个任务`,
            sourceInfo: sourceDesc.join(', '),
            rows: tripleReportRows,
            failDetails: fail > 0 ? failDetails.slice(0, 10) : [],
            footer: 'SRT 文件已自动保存到音频文件所在目录',
        });
    } else {
        alert(`✅ 字幕对齐完成 ${ok} 个任务${sourceInfo}\nSRT 文件已自动保存到音频文件所在目录`);
    }
}

/** 使用配置的云端转录并发数（如 Deepgram 20 并发，或多 Key）并行处理对齐任务 */
async function _batchAlignWithMultipleKeys() {
    _applyBatchTableChanges();
    const state = window._reelsState;
    if (!state?.tasks?.length) return;

    let concurrency = 1;
    let providerName = 'deepgram';
    try {
        const resp = await apiFetch(`${API_BASE}/settings/transcription-providers`);
        const conf = await resp.json();
        providerName = conf.primary || 'deepgram';
        concurrency = Number(conf.concurrency) || (providerName === 'deepgram' ? 20 : (providerName === 'groq' ? 5 : 1));
        if (concurrency < 1) concurrency = 1;
    } catch (error) {
        console.warn('[BatchAlign] Failed to load transcription config for parallel alignment:', error);
    }

    const alignSource = document.getElementById('rbt-align-source')?.value || 'video';
    const textColumn = document.getElementById('rbt-align-txt-col')?.value || 'txtContent';
    const allowBlind = !!document.getElementById('rbt-allow-blind')?.checked || textColumn === 'scroll_body' || textColumn === 'scroll_title';
    const forceRealign = !!document.getElementById('rbt-force-realign')?.checked;
    const forceTranscribe = !!document.getElementById('rbt-force-transcribe')?.checked;
    const textFor = task => {
        if (textColumn === 'ttsText') return task.ttsText;
        if (textColumn === 'overlay_title') return _findBatchTextCardOverlay(task)?.title_text;
        if (textColumn === 'overlay_body') return _findBatchTextCardOverlay(task)?.body_text;
        if (textColumn === 'scroll_body') {
            const raw = _findBatchScrollOverlay(task)?.content || '';
            return raw === '滚动文字内容\n第二行文字\n第三行文字\n第四行文字\n第五行文字' ? '' : raw;
        }
        if (textColumn === 'scroll_title') return _findBatchScrollOverlay(task)?.scroll_title;
        return task.txtContent;
    };
    const hasAudio = task => alignSource === 'video'
        ? !!(task.bgPath || task.videoPath)
        : !!task.audioPath;
    const targetIndices = state.tasks
        .map((task, index) => ({ task, index }))
        .filter(({ task }) => hasAudio(task) && (allowBlind || String(textFor(task) || '').trim()) &&
            (forceRealign || forceTranscribe || !task.aligned && !task.srtPath))
        .map(({ index }) => index);
    if (!targetIndices.length) return _batchAlignAllTasks();

    if (concurrency < 2) {
        return _batchAlignAllTasks();
    }

    const primaryBtn = document.getElementById('rbt-align-all-btn');
    const parallelBtn = document.getElementById('rbt-align-multikey-btn');
    const progressEl = document.getElementById('rbt-align-progress');
    if (primaryBtn) primaryBtn.disabled = true;
    const workerCount = Math.min(concurrency, targetIndices.length);
    if (parallelBtn) { parallelBtn.disabled = true; parallelBtn.textContent = `⏳ ${workerCount} 路并发中...`; }

    let next = 0;
    let completed = 0;
    let ok = 0;
    let fail = 0;
    const failures = [];
    const activeTasks = new Set();

    const workers = Array.from({ length: workerCount }, (_, workerIndex) => (async () => {
        // 每个 worker 错开 60ms 启动，避免瞬时 20 个 FFmpeg 进程并发读写磁盘造成 I/O 尖峰
        if (workerIndex > 0) {
            await new Promise(r => setTimeout(r, Math.min(workerIndex * 60, 1000)));
        }
        while (true) {
            const queueIndex = next++;
            if (queueIndex >= targetIndices.length) return;
            const taskIndex = targetIndices[queueIndex];
            activeTasks.add(taskIndex + 1);

            if (progressEl) {
                const activeList = Array.from(activeTasks).slice(0, 8).join(', ') + (activeTasks.size > 8 ? '...' : '');
                progressEl.textContent = `⚡ 并发对齐中 (${workerCount} 路并发) | 正在处理行: [${activeList}] | 已完成: ${completed}/${targetIndices.length}（成功 ${ok}，失败 ${fail}）`;
            }

            try {
                const result = await _batchAlignAllTasks({
                    targetIndices: [taskIndex],
                    silent: true,
                });
                ok += result?.ok || 0;
                fail += result?.fail || 0;
                if (result?.failDetails?.length) failures.push(...result.failDetails);
            } finally {
                activeTasks.delete(taskIndex + 1);
                completed++;
                if (progressEl) {
                    const activeList = Array.from(activeTasks).slice(0, 8).join(', ') + (activeTasks.size > 8 ? '...' : '');
                    progressEl.textContent = `⚡ 并发对齐中 (${workerCount} 路并发) | 正在处理行: [${activeList || '收尾'}] | 已完成: ${completed}/${targetIndices.length}（成功 ${ok}，失败 ${fail}）`;
                }
            }
        }
    })());

    try {
        await Promise.all(workers);
    } finally {
        if (primaryBtn) primaryBtn.disabled = false;
        if (parallelBtn) { parallelBtn.disabled = false; parallelBtn.textContent = '⚡ 并发对齐字幕'; }
    }
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    if (progressEl) {
        progressEl.textContent = fail > 0
            ? `⚠️ 并发对齐完成 ${ok}/${targetIndices.length}，失败 ${fail}`
            : `✅ 并发对齐完成（${ok} 个）`;
        setTimeout(() => { if (progressEl) progressEl.textContent = ''; }, 8000);
    }
    if (fail > 0) {
        alert(`并发对齐完成：成功 ${ok}/${targetIndices.length}，失败 ${fail}\n\n${failures.slice(0, 8).join('\n')}`);
    } else {
        alert(`✅ 并发对齐完成：${ok} 个任务\n已按 ${workerCount} 路并发同时处理。`);
    }
}

async function _batchAlignSingleTask(idx, forceTranscribe = false) {
    const state = window._reelsState;
    const task = state?.tasks?.[idx];
    if (!task) return;
    const name = task.baseName || task.fileName || `第 ${idx + 1} 行`;
    const ok = confirm(forceTranscribe
        ? `确定删除当前错误 SRT、强制重新转录，并从全部任务行重新查找正确文案生成 SRT？\n\n任务: ${name}`
        : `确定删除当前错误 SRT，并从全部任务行重新查找正确文案生成 SRT？\n\n任务: ${name}`);
    if (!ok) return;

    await _batchAlignAllTasks({
        targetIndices: [idx],
        forceRealign: true,
        forceTranscribe: forceTranscribe,
    });
}

// ═══════════════════════════════════════════════════════
// 10b. Batch selection helpers
// ═══════════════════════════════════════════════════════

function _getSelectedIndices() {
    return Array.from(_batchTableState.selectedRows).sort((a, b) => a - b);
}

function _updateBatchSelectCount() {
    const container = _batchTableState.container;
    if (!container) return;
    const el = container.querySelector('#rbt-selected-count');
    const exportBtn = container.querySelector('#rbt-export-selected-btn');
    const deleteBtn = container.querySelector('#rbt-delete-selected');
    const count = _batchTableState.selectedRows.size;
    if (el) el.textContent = count > 0 ? `已选 ${count} 行` : '';
    if (exportBtn) exportBtn.style.display = count > 0 ? '' : 'none';
    if (deleteBtn) {
        deleteBtn.disabled = count === 0;
        deleteBtn.style.opacity = count > 0 ? '1' : '0.45';
        deleteBtn.title = count > 0 ? `删除当前标签页中选中的 ${count} 行` : '请先勾选任务行';
    }

    const tasks = window._reelsState?.tasks || [];
    const allSelected = tasks.length > 0 && count === tasks.length;
    const sa = container.querySelector('#rbt-select-all');
    const ha = container.querySelector('#rbt-header-select-all');
    if (sa) sa.checked = allSelected;
    if (ha) ha.checked = allSelected;
}

// ═══════════════════════════════════════════════════════
// 10c. Material folder refresh
// ═══════════════════════════════════════════════════════

const _MAT_BG_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);
const _MAT_AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma']);
const _MAT_SRT_EXTS = new Set(['srt']);
const _MAT_TXT_EXTS = new Set(['txt']);

function _shuffleArray(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function _randomUniqueFirstAssign(targetTasks, poolPaths, applyFn) {
    if (!Array.isArray(targetTasks) || targetTasks.length === 0) return 0;
    const uniquePool = Array.from(new Set((poolPaths || []).filter(Boolean)));
    if (uniquePool.length === 0) return 0;

    // 先使用不重复随机序列；不够时再重复（每轮重洗）
    let deck = _shuffleArray(uniquePool);
    let cursor = 0;
    let filled = 0;
    for (const task of targetTasks) {
        if (!task) continue;
        if (cursor >= deck.length) {
            deck = _shuffleArray(uniquePool);
            cursor = 0;
        }
        const path = deck[cursor++];
        if (!path) continue;
        applyFn(task, path);
        filled++;
    }
    return filled;
}

async function _refreshMaterialFolder() {
    const tab = _getActiveTab();
    if (!tab.materialDir) {
        alert('请先设置素材文件夹');
        return;
    }

    const refreshBtn = _batchTableState.container?.querySelector('#rbt-refresh-mat');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳ 扫描中...';
    }

    try {
        let files;
        if (window.electronAPI && window.electronAPI.scanDirectory) {
            files = await window.electronAPI.scanDirectory(tab.materialDir);
        } else {
            alert('请在桌面应用中使用此功能');
            return;
        }

        if (!files || files.length === 0) {
            alert('文件夹为空或无法读取');
            return;
        }

        // Classify files
        const classified = { bg: [], audio: [], srt: [], txt: [] };
        for (const f of files) {
            const ext = (f.name || '').split('.').pop().toLowerCase();
            if (_MAT_AUDIO_EXTS.has(ext)) classified.audio.push(f);
            else if (_VOICE_VIDEO_EXTS.has(ext) && _looksLikeVoiceTrack(f.name || '')) classified.audio.push(f);
            else if (_MAT_BG_EXTS.has(ext)) classified.bg.push(f);
            else if (_MAT_SRT_EXTS.has(ext)) classified.srt.push(f);
            else if (_MAT_TXT_EXTS.has(ext)) classified.txt.push(f);
        }

        const state = window._reelsState;
        const tasks = state.tasks || [];

        // Build a map: baseName → task index for existing tasks
        const existingMap = new Map();
        tasks.forEach((t, i) => {
            const bgBase = _baseFileName(t.bgPath || t.videoPath || '');
            const audioBase = _baseFileName(t.audioPath || '');
            if (bgBase) existingMap.set(bgBase, i);
            if (audioBase) existingMap.set(audioBase, i);
        });

        let newCount = 0, updateCount = 0, randomFillCount = 0;

        // Match by baseName: group files
        const groups = new Map(); // baseName → { bg, audio, srt, txt }
        const matchedBgPaths = new Set();
        const allFiles = [
            ...classified.bg.map(f => ({ ...f, type: 'bg' })),
            ...classified.audio.map(f => ({ ...f, type: 'audio' })),
            ...classified.srt.map(f => ({ ...f, type: 'srt' })),
            ...classified.txt.map(f => ({ ...f, type: 'txt' })),
        ];
        for (const f of allFiles) {
            const base = _baseFileName(f.name);
            if (!groups.has(base)) groups.set(base, {});
            groups.get(base)[f.type] = f;
        }

        // Process each group
        for (const [base, group] of groups) {
            let taskIdx = existingMap.get(base);
            let task;
            if (group.bg && group.bg.path) matchedBgPaths.add(group.bg.path);

            if (taskIdx != null) {
                task = tasks[taskIdx];
                // Update existing task if files changed
                let changed = false;
                if (group.bg && task.bgPath !== group.bg.path) {
                    _setTaskSingleBackground(task, group.bg.path, { clearBgSrcUrl: true }); changed = true;
                }
                if (group.audio && task.audioPath !== group.audio.path) {
                    task.audioPath = group.audio.path; changed = true;
                }
                if (group.srt && task.srtPath !== group.srt.path) {
                    task.srtPath = group.srt.path; changed = true;
                }
                if (changed) {
                    task._justRefreshed = true;
                    updateCount++;
                }
            } else {
                // Create new task
                task = _createEmptyTask();
                task.baseName = base;
                if (group.bg) {
                    _setTaskSingleBackground(task, group.bg.path);
                }
                if (group.audio) { task.audioPath = group.audio.path; }
                if (group.srt) { task.srtPath = group.srt.path; }
                task._justRefreshed = true;
                tasks.push(task);
                newCount++;
            }
        }

        // 随机补齐背景：
        // 1) 优先使用“未参与同名匹配”的背景素材
        // 2) 素材不足时允许重复随机分配
        const unmatchedTasks = tasks.filter(t => !(t.bgPath || t.videoPath));
        if (unmatchedTasks.length > 0 && classified.bg.length > 0) {
            const bgAllPaths = classified.bg.map(f => f.path).filter(Boolean);
            const bgUnmatchedFirst = bgAllPaths.filter(p => !matchedBgPaths.has(p));
            const primaryPool = bgUnmatchedFirst.length > 0 ? bgUnmatchedFirst : bgAllPaths;

            randomFillCount = _randomUniqueFirstAssign(unmatchedTasks, primaryPool, (task, bgPath) => {
                _setTaskSingleBackground(task, bgPath, { clearBgSrcUrl: true });
                task._justRefreshed = true;
            });
        }

        tab.lastRefreshTime = Date.now();
        state.tasks = tasks;

        _renderBatchTable();

        // Clear _justRefreshed flags after animation
        setTimeout(() => {
            for (const t of state.tasks) delete t._justRefreshed;
        }, 3500);

        const summary = [];
        if (newCount > 0) summary.push(`🆕 新增 ${newCount} 行`);
        if (updateCount > 0) summary.push(`🔄 更新 ${updateCount} 行`);
        if (randomFillCount > 0) summary.push(`🎲 随机补齐背景 ${randomFillCount} 行（未匹配优先）`);
        if (summary.length === 0) summary.push('✅ 没有新变化');
        alert(`刷新完成\n${summary.join('\n')}\n\n文件夹: ${tab.materialDir}\n共 ${files.length} 个文件`);

    } catch (err) {
        console.error('[BatchTable] Refresh error:', err);
        alert(`刷新失败: ${err.message}`);
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄 一键刷新';
        }
    }
}

function _baseFileName(filePath) {
    if (!filePath) return '';
    const name = filePath.replace(/\\/g, '/').split('/').pop() || '';
    return name.replace(/\.[^.]+$/, '').toLowerCase().trim();
}

// ═══════════════════════════════════════════════════════
// 11. Utility
// ═══════════════════════════════════════════════════════

function _shortName(path) {
    if (!path) return '';
    const parts = path.replace(/\\/g, '/').split('/');
    const name = parts[parts.length - 1] || '';
    return name;
}

function _escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════
// 11. CSS injection
// ═══════════════════════════════════════════════════════

let _batchTableCSSInjected = false;
function _injectBatchTableCSS() {
    if (_batchTableCSSInjected) return;
    _batchTableCSSInjected = true;
    const style = document.createElement('style');
    style.textContent = `
        .rbt-panel {
            position:relative;
            display:flex; flex-direction:column; width:100%; max-width:none;
            height:auto; max-height:calc(100vh - 32px);
            background:#0d0d1e; border:1px solid #1a1a3a; border-radius:12px;
            box-shadow:0 30px 80px rgba(0,0,0,0.7); margin:auto; overflow:hidden;
            min-height:0; min-width:0;
        }
        .rbt-body-row {
            display:flex; flex:0 1 auto; overflow:hidden; min-height:0; height:auto;
        }
        .rbt-main-col {
            flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; min-height:0; height:auto;
        }
        /* ═══ Media Pool Sidebar ═══ */
        .rbt-media-sidebar {
            width:240px; min-width:180px; max-width:500px;
            background:#12121e; border-right:none;
            display:flex; flex-direction:column; overflow:hidden;
            position:relative; height:100%; max-height:100%;
        }
        .rbt-ms-resize-handle {
            position:absolute; top:0; right:0; width:5px; height:100%;
            cursor:col-resize; background:transparent; z-index:10;
            border-right:1px solid #2a2a3a;
            transition: background 0.15s;
        }
        .rbt-ms-resize-handle:hover, .rbt-ms-resize-handle.active {
            background:rgba(124,92,255,0.4); border-right-color:#7c5cff;
        }
        .rbt-ms-header {
            display:flex; align-items:center; justify-content:space-between;
            padding:8px 10px; border-bottom:1px solid #2a2a3a; background:#0e0e1a;
        }
        .rbt-ms-actions {
            display:flex; gap:4px; padding:8px 8px 4px 8px; flex-wrap:wrap;
        }
        .rbt-ms-btn {
            font-size:10px !important; padding:2px 6px !important; flex:1; text-align:center;
        }
        .rbt-ms-filters {
            padding:4px 8px; border-bottom:1px solid #1a1a2a;
        }
        .rbt-ms-filter {
            padding:5px 8px; font-size:11px; color:#888; cursor:pointer; border-radius:4px;
            transition: background 0.15s;
        }
        .rbt-ms-filter:hover { background:#1e1e30; color:#ccc; }
        .rbt-ms-filter.active { background:#2a2a3e; color:#fff; font-weight:bold; }
        .rbt-ms-section {
            font-size:9px; color:#444; font-weight:bold; padding:6px 8px 2px 8px; text-transform:uppercase;
        }
        .rbt-ms-bulk { padding:8px; border-bottom:1px solid #1a1a2a; }
        .rbt-ms-pool {
            flex:1; overflow-y:auto; padding:8px;
        }
        .rbt-ms-footer { padding:8px; border-top:1px solid #1a1a2a; }
        .rbt-ms-linked-dir {
            padding:8px; border-bottom:1px solid #1a1a2a; background:rgba(0,0,0,0.15);
        }
        .rbt-ms-collapsible-header {
            display:flex; align-items:center; gap:6px; padding:6px 10px;
            cursor:pointer; user-select:none;
            border-bottom:1px solid var(--border-color, #1a1a2a);
            background:var(--bg-hover, rgba(255,255,255,0.03));
            transition: background 0.15s;
        }
        .rbt-ms-collapsible-header:hover {
            background:var(--bg-hover-strong, rgba(255,255,255,0.06));
        }
        .rbt-ms-toggle-icon {
            font-size:10px; color:var(--text-muted); transition:transform 0.2s;
            width:12px; display:inline-flex; justify-content:center;
        }
        .rbt-ms-collapsible-body {
            overflow:hidden; transition: max-height 0.25s ease;
        }
        .rbt-ms-collapsible-body.collapsed {
            max-height:0 !important; overflow:hidden; border-bottom:none;
        }
        .rbt-header {
            display:flex; justify-content:space-between; align-items:center;
            padding:0 12px; height:36px; min-height:36px; max-height:36px;
            border-bottom:1px solid #1a1a3a; background:#101028;
            gap:8px; flex-shrink:0;
        }
        .rbt-actions-panel {
            background:#101028; border-bottom:1px solid #1a1a3a; padding:8px 12px;
            display:flex; flex-direction:column; gap:6px; align-items:stretch;
            flex:0 1 auto; min-height:0; max-height:32vh; overflow:hidden;
        }
        #rbt-actions-wrapper {
            flex:1 1 auto;
            min-height:0;
            overflow:auto;
        }
        .rbt-batch-subgroup {
            display:inline-flex; align-items:center; height:20px;
            padding:0 7px; border-radius:999px;
            background:rgba(76,158,255,0.12);
            border:1px solid rgba(76,158,255,0.25);
            color:#9fc8ff; font-size:10px; font-weight:800;
            white-space:nowrap;
        }
        .rbt-group-project .rbt-batch-rowbreak,
        .rbt-group-batch-settings .rbt-batch-rowbreak,
        .rbt-group-voice-flow .rbt-batch-rowbreak {
            flex:0 0 100%;
            width:100%;
            height:0;
            margin:0;
            padding:0;
        }
        #rbt-actions-wrapper > .rbt-actions { order:10; }
        #rbt-actions-wrapper > .rbt-group-project { order:1; }
        #rbt-actions-wrapper > .rbt-group-input { order:2; }
        #rbt-actions-wrapper > .rbt-group-batch-settings { order:3; }
        .rbt-actions-panel > #rbt-batch-bar {
            order:99;
            position:relative;
            z-index:20;
            background:#101028 !important;
            box-shadow:none;
            margin:0 -12px -8px -12px !important;
            padding:7px 12px !important;
            border-top:1px solid rgba(123,139,239,0.22) !important;
            border-bottom:0 !important;
            overflow:hidden;
            flex:0 0 auto;
        }
        #rbt-batch-bar > span:first-child {
            flex:0 0 auto !important;
            margin:0 4px 0 0 !important;
            color:var(--text-secondary) !important;
            font-size:11px !important;
        }
        .rbt-header h2 { margin:0; font-size:18px; color:var(--accent); white-space:nowrap; flex-shrink:0; }
        .rbt-actions { display:none; }
        .rbt-btn {
            padding:0 10px; height:26px; line-height:26px;
            border-radius:4px; border:1px solid #333; background:#1e1e38;
            color:#ccc; font-size:11px; cursor:pointer; transition:all .15s;
            white-space:nowrap; box-sizing:border-box;
            display:inline-flex; justify-content:center; align-items:center; text-align:center;
        }
        .rbt-btn:hover { background:#2a2a48; color:#fff; }
        .rbt-btn-accent { background:var(--accent); color:#000; border-color:var(--accent); font-weight:bold; }
        .rbt-btn-accent:hover { background:#00BBDD; }
        .rbt-btn-primary { background:var(--accent); color:#000; border:none; font-weight:bold; padding:0 24px; height:26px; line-height:26px; font-size:14px; }
        .rbt-btn-primary:hover { background:#00BBDD; }
        .rbt-btn-danger { border-color:#f44; color:#f44; }
        .rbt-btn-danger:hover { background:#f44; color:#fff; }
        .rbt-btn-folder { background:#2a6b3a; color:#8f8; border-color:#3a8b4a; font-weight:600; }
        .rbt-btn-folder:hover { background:#3a8b4a; color:#fff; }
        .rbt-btn-voice { background:#182838; border-color:#2a4058; color:#90b8d8; }
        .rbt-btn-voice:hover { background:#2a4058; color:#c0daf0; }
        .rbt-btn-other { background:#2a2038; border-color:#403058; color:#b8a0d0; }
        .rbt-btn-other:hover { background:#403058; color:#d8c8f0; }
        .rbt-table-wrap {
            flex:0 1 auto; overflow:auto; padding:0; min-height:0; height:auto; max-height:min(42vh, 360px);
        }
        .rbt-table {
            width:100%; border-collapse:collapse; font-size:12px;
        }
        .rbt-table thead { position:sticky; top:0; z-index:2; }
        .rbt-table th {
            padding:6px 10px; height:34px; background:#181836; color:#c0c8dd; font-weight:600;
            text-align:left; white-space:nowrap; font-size:11px;
            border-bottom:2px solid #3a3a6a;
            border-right:1px solid #2e2e58;
            box-shadow:inset -1px 0 0 rgba(255,255,255,0.03);
            transition: background 0.2s;
        }
        /* 列分组专属主题色（顶部颜色条 + 极光背景色） */
        .rbt-table th.rbt-grp-base  { background:#1c1e24; box-shadow: inset 0 3px 0 #64748b, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-cover { background:#221e14; box-shadow: inset 0 3px 0 #ffd700, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-video { background:#151c36; box-shadow: inset 0 3px 0 #3b82f6, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-cv    { background:#10212e; box-shadow: inset 0 3px 0 #10b981, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-media { background:#10212e; box-shadow: inset 0 3px 0 #10b981, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-audio { background:#1a1636; box-shadow: inset 0 3px 0 #8b5cf6, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-sub   { background:#101e38; box-shadow: inset 0 3px 0 #0ea5e9, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-ovl   { background:#221d28; box-shadow: inset 0 3px 0 #f59e0b, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-scr   { background:#24162e; box-shadow: inset 0 3px 0 #f43f5e, inset -1px 0 0 rgba(255,255,255,0.03); }

        /* 单元格背景高亮颜色（深色模式 tint 背景色） */
        .rbt-table td.rbt-grp-base  { background: rgba(100, 116, 139, 0.04); }
        .rbt-table td.rbt-grp-cover { background: rgba(255, 215, 0, 0.04); }
        .rbt-table td.rbt-grp-video { background: rgba(59, 130, 246, 0.04); }
        .rbt-table td.rbt-grp-cv    { background: rgba(16, 185, 129, 0.04); }
        .rbt-table td.rbt-grp-audio { background: rgba(139, 92, 246, 0.04); }
        .rbt-table td.rbt-grp-ovl   { background: rgba(245, 158, 11, 0.04); }

        /* Visual separation borders between column groups (Dark Mode) */
        .rbt-table th.rbt-col-exportname, .rbt-table td.rbt-col-exportname,
        .rbt-table th.rbt-col-cover-text, .rbt-table td.rbt-col-cover-text,
        .rbt-table th.rbt-col-bgm, .rbt-table td.rbt-col-bgm,
        .rbt-table th.rbt-col-cvvol, .rbt-table td.rbt-col-cvvol,
        .rbt-table th.rbt-col-audiodurscale, .rbt-table td.rbt-col-audiodurscale {
            border-right: 2px solid rgba(255, 255, 255, 0.16) !important;
        }

        .rbt-table th:last-child { border-right:none; }
        .rbt-col-toggle {
            display:flex; align-items:center; gap:8px; padding:6px 12px; font-size:11px; color:#ccc; cursor:pointer; transition:background .15s;
        }
        .rbt-col-toggle:hover { background:rgba(255,255,255,0.06); }
        .rbt-col-toggle input[type="checkbox"] { margin:0; transform:scale(0.9); cursor:pointer; }
        .rbt-th-wrap {
            display:flex; align-items:center; gap:4px; min-width:0;
        }
        .rbt-th-wrap > span {
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;
        }
        .rbt-th-paste {
            flex:0 0 auto;
            width:20px; height:18px; line-height:16px;
            border-radius:4px; border:1px solid #2a5a3a;
            background:#1a2f24; color:#6fc88a;
            font-size:10px; cursor:pointer;
            padding:0; transition:all .15s;
            opacity:0; pointer-events:none;
        }
        .rbt-th-paste:hover {
            border-color:#4ade80; color:#fff; background:#2a5a3a;
            transform:scale(1.1);
        }
        .rbt-th-folder {
            flex:0 0 auto;
            width:20px; height:18px; line-height:16px;
            border-radius:4px; border:1px solid #5a4a2a;
            background:#2f2a1a; color:#d4a54a;
            font-size:10px; cursor:pointer;
            padding:0; transition:all .15s;
            opacity:0; pointer-events:none;
        }
        .rbt-th-folder:hover {
            border-color:#f0c050; color:#fff; background:#5a4a2a;
            transform:scale(1.1);
        }
        .rbt-th-clear {
            flex:0 0 auto;
            width:18px; height:18px; line-height:16px;
            border-radius:4px; border:1px solid #384078;
            background:#1a1f44; color:#b8c6ff;
            font-size:10px; font-weight:700; cursor:pointer;
            padding:0; transition:all .15s;
            opacity:0; pointer-events:none;
        }
        .rbt-th-clear:hover {
            border-color:#ff6b6b; color:#fff; background:#5a1f2a;
        }
        .rbt-table th:hover .rbt-th-paste,
        .rbt-table th:hover .rbt-th-folder,
        .rbt-table th:hover .rbt-th-clear {
            opacity: 1; pointer-events: auto;
        }
        .rbt-table td {
            padding:3px 6px; vertical-align:middle;
            border-bottom:1px solid #1c1c3a;
            border-right:1px solid #1a1a38;
        }
        .rbt-table td:last-child { border-right:none; }
        .rbt-row { transition: background 0.1s; }
        .rbt-row:nth-child(even) { background:rgba(255,255,255,0.018); }
        .rbt-row:hover { background:rgba(0,212,255,0.06); }
        .rbt-row-selected { background:rgba(0,212,255,0.1) !important; }
        .rbt-col-num { width:36px; text-align:center; color:#556; font-weight:bold; font-size:11px; }

        /* 统一缩放设置列宽 (Scale Settings): 70px */
        .rbt-col-bgscale, .rbt-col-bgdurscale, .rbt-col-audiodurscale, .rbt-col-bgvol, .rbt-col-voicevol { width:70px; text-align:center; }

        /* 统一选择文件列宽 (File Selectors): 140px */
        .rbt-col-hook, .rbt-col-bg, .rbt-col-audio, .rbt-col-srt, .rbt-col-bgm, .rbt-col-pip { width:140px; }
        .rbt-col-clippool { width:170px; min-width:170px; }

        /* 统一输入文本列宽 (Text Inputs): 200px */
        .rbt-col-ai_script, .rbt-col-tts_text, .rbt-col-txtcontent, .rbt-col-title, .rbt-col-body, .rbt-col-footer, .rbt-col-scroll-title, .rbt-col-scroll-body { min-width:200px; width:200px; }

        /* 其他杂项列宽 */
        .rbt-col-tts_voice { width:100px; }
        .rbt-col-dur { width:70px; text-align:center; }
        .rbt-col-subtime { width:100px; min-width:80px; }
        .rbt-col-flipper-enabled, .rbt-col-flipper-duration, .rbt-col-flipper-lines, .rbt-col-flipper-effect, .rbt-col-flipper-loop, .rbt-col-flipper-transition-duration { width:80px; text-align:center; }
        .rbt-col-tpl { width:120px; }
        .rbt-col-act { width:70px; white-space:nowrap; }
        .rbt-file-name {
            display:block; padding:3px 6px; background:#101020; border:1px solid #1e1e3a;
            border-radius:3px; color:#8888cc; font-size:11px; min-height:24px; line-height:18px;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:default;
            transition: all 0.2s;
        }
        /* 方案A2: 极其透明的文字 + 小图标 */
        .rbt-file-name:has(.rbt-placeholder) {
            background: rgba(255,255,255,0.015);
            border-color: transparent;
            text-align: center;
            position: relative; /* 必须加relative才能让伪元素绝对居中 */
        }
        
        /* 默认状态单独居中显示的完美 + 号 */
        .rbt-file-name:has(.rbt-placeholder)::after {
            content: '+';
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #666;
            font-size: 15px;
            font-weight: 300;
            pointer-events: none;
            transition: opacity 0.2s;
        }

        .rbt-file-name:has(.rbt-placeholder) .rbt-placeholder {
            opacity: 0; /* 文本彻底隐形，但仍撑起布局宽度 */
            transition: opacity 0.2s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
        }
        /* 当文字出现时，也给文字前面补一个 + 号，保证排版平滑 */
        .rbt-file-name:has(.rbt-placeholder) .rbt-placeholder::before {
            content: '+';
            color: inherit;
            font-size: 13px;
        }
        
        /* 悬浮状态：绝对居中的十字消失，文本底色现身 */
        .rbt-row:hover .rbt-file-name:has(.rbt-placeholder)::after,
        .rbt-file-name:has(.rbt-placeholder):hover::after {
            opacity: 0;
        }
        .rbt-row:hover .rbt-file-name:has(.rbt-placeholder) .rbt-placeholder,
        .rbt-file-name:has(.rbt-placeholder):hover .rbt-placeholder {
            opacity: 1;
            color: #889;
        }
        
        .rbt-row:hover .rbt-file-name:has(.rbt-placeholder) {
            border-color: transparent;
        }
        .rbt-file-name:has(.rbt-placeholder):hover {
            background: rgba(255,255,255,0.05);
            border-color: #445;
            border-style: dashed;
        }
        .rbt-placeholder { color:#888; font-style:italic; }
        .rbt-textarea {
            width:100%; padding:4px 6px; background:transparent; border:1px solid transparent;
            border-radius:3px; color:#ddd; font-size:12px; resize:none; min-height:28px;
            font-family:inherit; line-height:1.4; transition:all .2s;
        }
        .rbt-textarea:hover {
            background: rgba(255,255,255,0.03); 
            border-color: rgba(255,255,255,0.1);
        }
        .rbt-textarea:focus { 
            background: #0e0e1c;
            border-color:#4a9eff; 
            outline:none; 
            box-shadow:0 0 0 1px rgba(74,158,255,0.3); 
        }
        .rbt-select {
            width:100%; padding:0 4px; height:24px; background:#0e0e1c; border:1px solid #1e1e3a;
            border-radius:3px; color:#ddd; font-size:11px;
        }
        .rbt-row-btn {
            padding:2px 5px; background:none; border:1px solid transparent;
            cursor:pointer; font-size:13px; border-radius:3px;
        }
        .rbt-row-btn:hover { background:rgba(255,255,255,0.1); }
        .rbt-field-clear {
            background:none; border:none; color:#888; cursor:pointer;
            font-size:11px; padding:1px 4px; border-radius:3px; line-height:1;
            flex-shrink:0; opacity:0.6; transition:all 0.15s;
        }
        .rbt-field-clear:hover { color:var(--error); opacity:1; background:rgba(255,107,107,0.15); }
        .rbt-footer {
            display:flex; justify-content:flex-start; align-items:center; gap:12px;
            padding:0 16px; height:40px; min-height:40px; flex-shrink:0;
            border-top:1px solid #1a1a3a; background:#101028;
        }
        #rbt-count { color:#888; font-size:13px; flex:0 0 auto; }
        #rbt-align-progress {
            flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        }
        .rbt-droppable.rbt-drag-over {
            border-color:var(--accent) !important; background:rgba(0,212,255,0.1) !important;
        }
        .rbt-hidden-input { display:none !important; }
        .rbt-sep {
            display:inline-block; width:1px; height:16px; background:#333; margin:0 4px;
            flex-shrink:0;
        }
        .rbt-group-label {
            font-size:10px; color:#888; font-weight:600; white-space:nowrap;
            border-bottom:1px solid #555; padding-bottom:1px; margin-right:2px;
        }
        .rbt-file-name { cursor:pointer !important; }
        .rbt-file-name:hover { border-color:var(--accent) !important; color:var(--accent) !important; }
        .rbt-footer-hint {
            flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
            font-size:11px; color:#555; text-align:center;
        }
        .rbt-footer .rbt-btn-primary { flex:0 0 auto; min-width:150px; }

        /* ══ Tab bar ══ */
        .rbt-tabbar {
            display:flex; align-items:stretch; background:#0a0a1e; border-bottom:1px solid #1a1a3a;
            padding:4px 12px 2px; height:auto !important; min-height:36px; max-height:35vh;
            overflow-x:hidden; overflow-y:auto; flex-shrink:0; flex-wrap:wrap; gap:4px 8px; width:100%; box-sizing:border-box;
        }
        .rbt-tabs-scroll {
            display:flex; flex-wrap:wrap !important; align-items:center; align-content:flex-start;
            gap:4px 4px; flex:1 1 100%; width:100%; min-width:0; overflow:visible;
        }
        .rbt-tab {
            display:flex; align-items:center; gap:6px; padding:0 14px; cursor:pointer;
            font-size:12px; color:#888; border:1px solid transparent; border-bottom:none;
            border-radius:6px 6px 0 0; transition:all .15s; position:relative; white-space:nowrap;
            background:transparent; user-select:none; height:32px;
        }
        .rbt-tabs-scroll > .rbt-tab { flex:0 0 auto; max-width:100%; box-sizing:border-box; }
        .rbt-tab-name { min-width:0; overflow:hidden; text-overflow:ellipsis; }
        .rbt-tab-close { flex-shrink:0; }
        .rbt-tab:hover { color:#ccc; background:rgba(255,255,255,0.05); }
        .rbt-tab-active {
            color:var(--accent) !important; background:#101028 !important;
            border-color:#1a1a3a #1a1a3a transparent; font-weight:600;
        }
        .rbt-tab-active::after {
            content:''; position:absolute; bottom:-1px; left:0; right:0; height:2px; background:var(--accent);
        }
        .rbt-tab-close {
            font-size:14px; line-height:1; opacity:0.4; transition:all .15s; padding:0 2px;
        }
        .rbt-tab-close:hover { opacity:1; color:var(--error); }
        .rbt-tab-add {
            color:#555; font-size:16px; font-weight:700; padding:0 12px;
        }
        .rbt-tab-add:hover { color:var(--accent); }

        /* ══ Material folder bar ══ */
        .rbt-material-bar {
            display:flex; align-items:center; gap:8px; padding:0 12px;
            height:36px; min-height:36px; max-height:36px;
            background:#0e0e24; border-bottom:1px solid #1a1a3a; flex-shrink:0;
        }
        .rbt-mat-path {
            font-size:11px; color:#8b8b8b; background:#141420; padding:0 10px;
            height:26px; line-height:26px;
            border-radius:4px; border:1px solid #2a2a4a; max-width:300px;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        }
        .rbt-btn-refresh {
            background:linear-gradient(135deg, #1a6b3a, #2a8b4a) !important;
            color:#8f8 !important; border-color:#3a8b4a !important; font-weight:600;
            transition:all .2s;
        }
        .rbt-btn-refresh:hover:not(:disabled) {
            background:linear-gradient(135deg, #2a8b4a, #3aab5a) !important;
            box-shadow:0 0 12px rgba(0,255,100,0.3);
        }
        .rbt-btn-refresh:disabled { opacity:0.4; cursor:not-allowed; }
        .rbt-refresh-time { font-size:10px; color:#666; margin-left:4px; }

        /* ══ Batch actions bar ══ */
        .rbt-batch-actions-bar {
            display:flex; align-items:center; gap:8px; padding:8px 12px;
            min-height:44px; height:auto;
            background:transparent;
            border-bottom:none; flex-shrink:0;
            flex-wrap:wrap;
        }
        .rbt-batch-label {
            display:flex; align-items:center; gap:4px; font-size:11px; color:#aaa; cursor:pointer;
        }
        .rbt-batch-label input[type="checkbox"] {
            width:16px; height:16px; margin:0;
            accent-color:#7f8fff;
        }
        .rbt-batch-group {
            display:flex; align-items:center; gap:6px;
            padding:5px 8px;
            background:rgba(18, 21, 54, 0.9);
            border:1px solid rgba(88, 101, 188, 0.45);
            border-radius:10px;
            box-shadow:inset 0 0 0 1px rgba(255,255,255,0.025);
            flex-shrink:0;
        }
        .rbt-batch-group-plain {
            background:rgba(18, 21, 54, 0.6);
            border:1px solid rgba(88, 101, 188, 0.3);
            box-shadow:inset 0 0 0 1px rgba(255,255,255,0.02);
            padding:5px 8px;
            gap:6px;
        }
        .rbt-batch-group-plain .rbt-mini-label {
            color:#c1c8e8;
        }
        .rbt-batch-group-emphasis {
            background:linear-gradient(180deg, rgba(70, 64, 180, 0.18) 0%, rgba(36, 36, 92, 0.78) 100%);
            border-color:rgba(129, 140, 248, 0.55);
            box-shadow:0 0 0 1px rgba(129,140,248,0.18), inset 0 0 0 1px rgba(255,255,255,0.03);
        }
        .rbt-mini-label {
            font-size:11px; color:#c9d4ff; font-weight:600; letter-spacing:.2px; white-space:nowrap;
        }
        .rbt-mini-label-emphasis {
            color:#d6ccff;
            font-weight:700;
        }
        .rbt-batch-actions-bar .rbt-btn,
        .rbt-batch-actions-bar .rbt-select {
            height:26px;
            line-height:26px;
            border-radius:4px;
            font-size:11px;
            padding:0 10px;
            border:1px solid #333;
            background:#1e1e38;
            color:#ccc;
        }
        .rbt-batch-actions-bar .rbt-btn:hover,
        .rbt-batch-actions-bar .rbt-select:hover {
            background:#2a2a48;
            color:#fff;
        }
        .rbt-batch-actions-bar .rbt-btn:active {
            transform:translateY(1px);
        }
        .rbt-batch-actions-bar .rbt-select {
            line-height:normal;
        }
        .rbt-btn-hero {
            font-weight:700;
            color:#f5f7ff;
            border-color:#7f8fff !important;
            background:linear-gradient(135deg, #4f46e5 0%, #4338ca 55%, #3730a3 100%) !important;
            box-shadow:0 10px 20px rgba(67,56,202,0.28), inset 0 0 0 1px rgba(255,255,255,0.16);
        }
        .rbt-btn-hero:hover {
            border-color:#9aa6ff !important;
            background:linear-gradient(135deg, #5f57f0 0%, #4d44dd 55%, #3f39b3 100%) !important;
            box-shadow:0 12px 24px rgba(79,70,229,0.36), inset 0 0 0 1px rgba(255,255,255,0.2);
        }
        .rbt-select-trigger {
            cursor:pointer;
            display:inline-flex;
            align-items:center;
            justify-content:space-between;
            user-select:none;
            gap:8px;
        }
        .rbt-select-trigger-label {
            overflow:hidden;
            text-overflow:ellipsis;
            white-space:nowrap;
        }
        .rbt-select-caret {
            font-size:10px;
            opacity:0.85;
        }
        .rbt-batch-summary {
            font-size:12px;
            color:var(--accent);
            margin-left:auto;
            font-weight:600;
        }
        .rbt-scale-pack {
            display:flex; align-items:center; gap:4px;
            font-size:11px; white-space:nowrap; font-weight:600;
            padding:0 2px;
            color:#c9d4ff;
        }
        .rbt-scale-bg { color:#cfd8ff; }
        .rbt-scale-bgdur { color:#cfd8ff; }
        .rbt-scale-audiodur { color:#cfd8ff; }
        .rbt-scale-pack input {
            width:48px; height:26px;
            font-size:11px; font-weight:600; color:#ddd;
            padding:0 4px; text-align:center;
            background:#0e0e1c;
            border:1px solid #1e1e3a;
            border-radius:4px;
            outline:none;
            box-sizing:border-box;
        }
        .rbt-scale-pack input:hover {
            border-color:#333;
            background:#121228;
        }
        .rbt-scale-pack input:focus {
            border-color:var(--accent);
            box-shadow:0 0 0 1px rgba(0,212,255,0.2);
        }

        /* ══ Row refresh animation ══ */
        .rbt-row-refreshed {
            animation: rbt-refresh-glow 3s ease-out;
        }
        @keyframes rbt-refresh-glow {
            0%   { background:rgba(0,255,100,0.25); box-shadow:inset 0 0 20px rgba(0,255,100,0.15); }
            30%  { background:rgba(0,255,100,0.15); }
            100% { background:transparent; box-shadow:none; }
        }

        /* ══ Drag handle & reorder ══ */
        .rbt-col-drag { width:24px; text-align:center; padding:0 2px !important; }
        .rbt-drag-handle {
            cursor:grab; color:#555; font-size:14px; user-select:none;
            display:inline-block; padding:4px 2px; line-height:1; transition:color .15s;
        }
        .rbt-drag-handle:hover { color:var(--accent); }
        .rbt-drag-handle:active { cursor:grabbing; }
        .rbt-row.rbt-dragging {
            opacity:0.4; background:rgba(0,212,255,0.05) !important;
        }
        .rbt-row.rbt-drag-over-row {
            border-top:2px solid var(--accent) !important;
            background:rgba(0,212,255,0.08) !important;
        }

        /* 解决控件拥挤：隐藏冗余滑块，悬浮显示 */
        .rbt-clutter-free-scale {
            position: relative;
            width: 100%;
            height: 30px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .rbt-clutter-free-scale > .rbt-scale-display {
            font-size: 11px;
            color: #888;
            pointer-events: none;
            transition: opacity 0.15s;
        }
        .rbt-clutter-free-scale > .rbt-scale-controls {
            position: absolute;
            inset: -2px 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 2px;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.15s;
            z-index: 5;
        }
        td:hover .rbt-clutter-free-scale > .rbt-scale-display,
        .rbt-clutter-free-scale:focus-within > .rbt-scale-display,
        td.rbt-scale-active .rbt-clutter-free-scale > .rbt-scale-display {
            opacity: 0;
        }
        td:hover .rbt-clutter-free-scale > .rbt-scale-controls,
        .rbt-clutter-free-scale:focus-within > .rbt-scale-controls,
        td.rbt-scale-active .rbt-clutter-free-scale > .rbt-scale-controls {
            opacity: 1;
            pointer-events: auto;
        }
        /* ═══ 主题兼容层 — 仅在亮色模式下覆盖默认暗黑样式 ═══ */
        body.theme-light .rbt-panel { background:var(--bg-primary) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-header, body.theme-light .rbt-actions-panel, body.theme-light .rbt-footer { background:var(--bg-titlebar) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-tabbar { background:var(--bg-titlebar) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-tab-active { background:var(--bg-secondary) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-material-bar { background:var(--bg-titlebar) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-media-sidebar { background:var(--bg-secondary) !important; }
        body.theme-light .rbt-ms-header { background:var(--bg-titlebar) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-ms-resize-handle { border-color:var(--border-color) !important; }
        body.theme-light .rbt-ms-filters { border-color:var(--border-color) !important; }
        body.theme-light .rbt-ms-bulk, body.theme-light .rbt-ms-footer, body.theme-light .rbt-ms-linked-dir { border-color:var(--border-color) !important; }
        body.theme-light .rbt-table th { background:var(--bg-secondary) !important; color:var(--text-primary) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-table td { border-color:var(--border-color) !important; }
        body.theme-light .rbt-file-name { background:var(--bg-input) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-textarea { color:var(--text-primary) !important; }
        body.theme-light .rbt-textarea:focus { background:var(--bg-input) !important; }
        body.theme-light .rbt-select { background:var(--bg-input) !important; border-color:var(--border-color) !important; color:var(--text-primary) !important; }
        body.theme-light .rbt-scale-pack input { background:var(--bg-input) !important; border-color:var(--border-color) !important; color:var(--text-primary) !important; }
        body.theme-light .rbt-btn { border-color:var(--border-color) !important; }
        body.theme-light .rbt-mat-path { background:var(--bg-input) !important; border-color:var(--border-color) !important; color:var(--text-secondary) !important; }
        body.theme-light .rbt-batch-actions-bar .rbt-btn, body.theme-light .rbt-batch-actions-bar .rbt-select { border-color:var(--border-color) !important; color:var(--text-primary); }
        body.theme-light .rbt-sep { background:var(--border-color) !important; }
        body.theme-light #rbt-count { color:var(--text-secondary) !important; }
        body.theme-light .rbt-footer-hint { color:var(--text-muted) !important; }
        
        /* 操作行 border 和标签文字 */
        body.theme-light .rbt-actions { border-color:var(--border-color) !important; }
        body.theme-light .rbt-col-num { color:var(--text-muted) !important; }
        body.theme-light .rbt-placeholder { color:var(--text-muted) !important; }
        body.theme-light .rbt-tab { color:var(--text-secondary) !important; }
        body.theme-light .rbt-tab:hover { color:var(--text-primary) !important; background:var(--bg-hover) !important; }
        body.theme-light .rbt-tab-active { color:var(--accent) !important; }
        body.theme-light .rbt-tab-add { color:var(--text-muted) !important; }
        body.theme-light .rbt-batch-label { color:var(--text-secondary) !important; }
        body.theme-light .rbt-group-label { color:var(--text-secondary) !important; border-color:var(--text-muted) !important; }
        body.theme-light .rbt-ms-filter { color:var(--text-secondary) !important; }
        body.theme-light .rbt-ms-filter:hover { background:var(--bg-hover-strong) !important; color:var(--text-primary) !important; }
        body.theme-light .rbt-ms-filter.active { background:var(--bg-hover-strong) !important; color:var(--text-primary) !important; }
        body.theme-light .rbt-ms-section { color:var(--text-muted) !important; }
        body.theme-light .rbt-refresh-time { color:var(--text-muted) !important; }
        body.theme-light .rbt-btn:hover { background:var(--bg-hover-strong) !important; color:var(--text-primary) !important; }
        body.theme-light .rbt-scale-display { color:var(--text-secondary) !important; }
        body.theme-light #rbt-lang-dropdown { background:var(--bg-secondary) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-ms-linked-dir { background:var(--bg-hover, rgba(0,0,0,0.04)) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-ms-bulk { border-color:var(--border-color) !important; }
        body.theme-light .rbt-ms-pool { background:var(--bg-primary) !important; }
        body.theme-light .rbt-ms-collapsible-header { border-color:var(--border-color) !important; }
        body.theme-light .rbt-btn { background:var(--bg-card, #2a2a38) !important; color:var(--text-primary) !important; border-color:var(--border-color) !important; }
        
        /* 针对亮色模式下特定颜色按钮的优化 (重新找回彩色但适配亮版) */
        body.theme-light #rbt-add-row-btn { background:rgba(40,160,40,0.15) !important; color:#0d612e !important; border-color:rgba(40,160,40,0.3) !important; font-weight:bold; }
        body.theme-light #rbt-clear-btn, body.theme-light #rbt-close-btn, body.theme-light #rbt-ms-clear { background:rgba(220,40,40,0.1) !important; color:#c51818 !important; border-color:rgba(220,40,40,0.3) !important; font-weight:bold; }
        body.theme-light #rbt-open-media-pool-btn { background:rgba(60,100,220,0.1) !important; color:#2040b0 !important; border-color:rgba(60,100,220,0.3) !important; font-weight:bold; }
        body.theme-light #rbt-ai-settings-btn { background:rgba(140,60,220,0.1) !important; color:#6b21a8 !important; border-color:rgba(140,60,220,0.3) !important; font-weight:bold; }
        body.theme-light #rbt-import-task-preset-btn, body.theme-light #rbt-import-sub-preset-btn, body.theme-light #rbt-import-card-preset-btn { background:rgba(60,100,220,0.08) !important; color:#1a3bb0 !important; border-color:rgba(60,100,220,0.2) !important; }
        
        /* 操作栏内联元素覆盖 — 强制主题色 */
        body.theme-light .rbt-actions label { color:var(--text-primary) !important; }
        body.theme-light .rbt-actions span { color:var(--text-secondary) !important; }
        body.theme-light .rbt-actions input[type="number"],
        body.theme-light .rbt-actions input[type="text"] { background:var(--bg-input) !important; color:var(--text-primary) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-actions select { background:var(--bg-input) !important; color:var(--text-primary) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-btn-primary { color:#fff !important; }
        body.theme-light .rbt-btn-accent { color:#000 !important; }

        /* 亮色模式下的列分组背景 */
        body.theme-light .rbt-table th.rbt-grp-base  { background: #f1f5f9 !important; color: #475569 !important; box-shadow: inset 0 3px 0 #64748b, inset -1px 0 0 rgba(0,0,0,0.05); }
        body.theme-light .rbt-table td.rbt-grp-base  { background: rgba(100, 116, 139, 0.06); }

        body.theme-light .rbt-table th.rbt-grp-cover { background: #fef9c3 !important; color: #854d0e !important; box-shadow: inset 0 3px 0 #eab308, inset -1px 0 0 rgba(0,0,0,0.05); }
        body.theme-light .rbt-table td.rbt-grp-cover { background: rgba(234, 179, 8, 0.07); }

        body.theme-light .rbt-table th.rbt-grp-video { background: #dbeafe !important; color: #1e40af !important; box-shadow: inset 0 3px 0 #3b82f6, inset -1px 0 0 rgba(0,0,0,0.05); }
        body.theme-light .rbt-table td.rbt-grp-video { background: rgba(59, 130, 246, 0.07); }

        body.theme-light .rbt-table th.rbt-grp-cv    { background: #d1fae5 !important; color: #065f46 !important; box-shadow: inset 0 3px 0 #10b981, inset -1px 0 0 rgba(0,0,0,0.05); }
        body.theme-light .rbt-table td.rbt-grp-cv    { background: rgba(16, 185, 129, 0.07); }

        body.theme-light .rbt-table th.rbt-grp-audio { background: #f3e8ff !important; color: #5b21b6 !important; box-shadow: inset 0 3px 0 #8b5cf6, inset -1px 0 0 rgba(0,0,0,0.05); }
        body.theme-light .rbt-table td.rbt-grp-audio { background: rgba(139, 92, 246, 0.07); }

        body.theme-light .rbt-table th.rbt-grp-ovl   { background: #ffedd5 !important; color: #9a3412 !important; box-shadow: inset 0 3px 0 #f59e0b, inset -1px 0 0 rgba(0,0,0,0.05); }
        body.theme-light .rbt-table td.rbt-grp-ovl   { background: rgba(245, 158, 11, 0.07); }

        /* Visual separation borders between column groups (Light Mode) */
        body.theme-light .rbt-table th.rbt-col-exportname, body.theme-light .rbt-table td.rbt-col-exportname,
        body.theme-light .rbt-table th.rbt-col-cover-text, body.theme-light .rbt-table td.rbt-col-cover-text,
        body.theme-light .rbt-table th.rbt-col-bgm, body.theme-light .rbt-table td.rbt-col-bgm,
        body.theme-light .rbt-table th.rbt-col-cvvol, body.theme-light .rbt-table td.rbt-col-cvvol,
        body.theme-light .rbt-table th.rbt-col-audiodurscale, body.theme-light .rbt-table td.rbt-col-audiodurscale {
            border-right: 2px solid rgba(0, 0, 0, 0.15) !important;
        }
    `;
    document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════
// 12. Config Save / Load / Auto-save
// ═══════════════════════════════════════════════════════

const BATCH_CONFIG_KEY = 'reels_batch_config_autosave';

const BATCH_RUNTIME_KEYS = new Set([
    '_video',
    '_bgThumb',
    '_allOverlays',
    '_selectedOv',
    '_overlayMgr',
    'overlayMgr',
    'videoCanvas',
    'canvas',
    'ctx',
    'renderPlan',
]);

function _isBatchDomLikeValue(value) {
    if (!value || typeof value !== 'object') return false;
    if (typeof Element !== 'undefined' && value instanceof Element) return true;
    if (typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement) return true;
    if (typeof HTMLVideoElement !== 'undefined' && value instanceof HTMLVideoElement) return true;
    if (typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement) return true;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
    return false;
}

function _serializeBatchValue(value, seen = new WeakSet()) {
    if (value === undefined) return undefined;
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
        return undefined;
    }
    if (value instanceof Date) return value.toISOString();
    if (_isBatchDomLikeValue(value)) return undefined;
    if (typeof value !== 'object') return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);

    if (typeof value.toJSON === 'function') {
        const jsonVal = value.toJSON();
        if (jsonVal !== value) {
            const res = _serializeBatchValue(jsonVal, seen);
            seen.delete(value);
            return res;
        }
    }

    if (Array.isArray(value)) {
        const arr = [];
        for (const item of value) {
            const cloned = _serializeBatchValue(item, seen);
            if (cloned !== undefined) arr.push(cloned);
        }
        seen.delete(value);
        return arr;
    }

    const out = {};
    for (const [key, val] of Object.entries(value)) {
        if (BATCH_RUNTIME_KEYS.has(key)) continue;
        const cloned = _serializeBatchValue(val, seen);
        if (cloned !== undefined) out[key] = cloned;
    }
    seen.delete(value);
    return out;
}

/** 序列化任务数据（去掉不可序列化的部分） */
function _serializeTasks(tasks) {
    return (tasks || []).map(t => {
        // 确保被保存的所有层在内存中都有 ID
        if (t.overlays && Array.isArray(t.overlays)) {
            t.overlays.forEach(ov => {
                if (!ov.id) {
                    ov.id = 'ov_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now().toString(36);
                }
            });
        }
        const o = _serializeBatchValue(t) || {};
        // 去掉 blob: URL（页面刷新后失效，渲染时会从 bgPath 重新生成 file:// URL）
        if (o.bgSrcUrl && String(o.bgSrcUrl).startsWith('blob:')) o.bgSrcUrl = null;
        if (o.srcUrl && String(o.srcUrl).startsWith('blob:')) o.srcUrl = null;
        return o;
    });
}

/** 自动保存到 localStorage (含所有标签页，如果配置了工程路径则自动写入硬盘) */
function _batchAutoSave(options = {}) {
    // Template viewers share Chromium storage with the editor. They may load
    // an older cached workspace, and must never become workspace writers.
    if(window.location?.hash?.startsWith('#template='))return true;
    try {
        // 模板封面截图会短暂把预览任务切换为单个队列。这段时间严禁
        // 把临时的 6 条任务反写到完整批量工程。
        if (window._templateThumbnailCaptureActive) return;
        // 外部队列刚被拆成多个标签时，外部列表仍是合并视图；此时不能用它覆盖当前标签。
        if (!options.skipSync) _syncTasksToActiveTab();
        const defaultProjDir = window.electronAPI?.getDefaultProjectDir?.() || '';
        if (!_batchTableState.projectDir || String(_batchTableState.projectDir).toLowerCase().includes('portable-data')) {
            if (defaultProjDir) _batchTableState.projectDir = defaultProjDir;
        }
        if (!_batchTableState.projectName) {
            _batchTableState.projectName = 'UntitledProject.json';
        }
        const data = {
            timestamp: new Date().toISOString(),
            version: '2.0',
            uiState:{globalSubtitleStyle:window._reelsState?.globalSubtitleStyle||null,selectedTaskId:window._reelsState?.tasks?.[window._reelsState?.selectedIdx]?.id||'',targetWidth:window._reelsState?.targetWidth,targetHeight:window._reelsState?.targetHeight,styleScope:typeof _getSubtitleStyleScope==='function'?_getSubtitleStyleScope():'folder'},
            activeTabId: _batchTableState.activeTabId,
            nextTabId: _batchTableState.nextTabId,
            projectDir: _batchTableState.projectDir || defaultProjDir || '',
            projectName: _batchTableState.projectName || 'UntitledProject.json',
            tabs: _batchTableState.tabs.map(tab => ({
                id: tab.id,
                name: tab.name,
                materialDir: tab.materialDir || '',
                folderQueueId: tab._folderQueueId || '',
                externalFolderQueuesCombined: !!tab._externalFolderQueuesCombined,
                lastRefreshTime: tab.lastRefreshTime || null,
                tasks: _serializeTasks(tab.tasks),
            })),
        };
        const jsonStr = JSON.stringify(data);
        // Persist the workspace independently of named project saves and browser quota.
        let diskSaved=false,cacheSaved=false;
        if (window.electronAPI?.saveBatchWorkspace)diskSaved=window.electronAPI.saveBatchWorkspace(jsonStr)===true;
        if (window.electronAPI?.saveBatchWorkspace && !diskSaved) {
            console.warn('[BatchTable] Workspace file save failed');
            if (typeof showToast === 'function') showToast('标签自动保存失败，请检查软件目录是否可写', 'warning', 5000);
        }
        try { localStorage.setItem(BATCH_CONFIG_KEY, jsonStr); cacheSaved=true; }
        catch (e) { console.warn('[BatchTable] Browser cache save failed:', e.message); }

        // 统一写入安装目录与共享工程目录 (Electron环境)，确保绿色版与安装版完全互通
        if (_batchTableState.projectName && window.electronAPI?.saveSharedProjectFile) {
            window.electronAPI.saveSharedProjectFile(_batchTableState.projectName, jsonStr, _batchTableState.projectDir || defaultProjDir);
        } else if (_batchTableState.projectDir && _batchTableState.projectName && window.electronAPI && window.electronAPI.writeFileText) {
            const dir = _batchTableState.projectDir.replace(/[/\\]$/, '');
            const sep = dir.includes('\\') ? '\\' : '/';
            const fullPath = dir + sep + _batchTableState.projectName;
            window.electronAPI.writeFileText(fullPath, jsonStr);
        }
        return window.electronAPI?.saveBatchWorkspace ? diskSaved : cacheSaved;
    } catch (e) {
        console.warn('[BatchTable] Auto-save failed:', e.message);
        return false;
    }
}

// Single source of truth for destructive clearing. Both the main Reels “清空”
// button and the batch-table “清空全部标签” action use this, so an older tab or
// localStorage snapshot cannot resurrect deleted tasks after a reload.
function reelsClearPersistedBatchTasks() {
    if (window._reelsState) {
        window._reelsState.tasks = [];
        window._reelsState.selectedIdx = -1;
    }
    const emptyTab = { id: 'tab_1', name: '默认', materialDir: '', lastRefreshTime: null, tasks: [] };
    _batchTableState.tabs = [emptyTab];
    _batchTableState.activeTabId = emptyTab.id;
    _batchTableState.appliedTabIds = [];
    _batchTableState.selectedRows = new Set();
    _batchTableState.nextTabId = 2;
    _batchTableState.openSnapshotTasks = [];
    _batchAutoSave({ skipSync: true });
}
window.reelsClearPersistedBatchTasks = reelsClearPersistedBatchTasks;

/** 自动恢复 */
function _batchAutoRestore() {
    try {
        let raw = '';
        try { raw = localStorage.getItem(BATCH_CONFIG_KEY) || ''; } catch (_) { }
        const diskRaw = window.electronAPI?.readBatchWorkspace?.() || '';
        let data = null;
        if (diskRaw) {
            let cached = null;
            try { if (raw) cached = JSON.parse(raw); } catch (_) { }
            let disk = null;
            try { disk = JSON.parse(diskRaw); } catch (_) { }
            if (disk && disk.version === '2.0' && Array.isArray(disk.tabs) && disk.tabs.length) {
                const countTasks = (obj) => Array.isArray(obj?.tabs)
                    ? obj.tabs.reduce((s, t) => s + (Array.isArray(t?.tasks) ? t.tasks.length : 0), 0)
                    : (Array.isArray(obj?.tasks) ? obj.tasks.length : 0);
                const cachedCount = countTasks(cached);
                const diskCount = countTasks(disk);
                const cachedTime = Date.parse(cached?.timestamp || '') || 0;
                const diskTime = Date.parse(disk?.timestamp || '') || 0;
                if (!cached || (diskTime > 0 && diskTime >= cachedTime) || (diskTime === 0 && cachedTime === 0 && diskCount >= cachedCount)) {
                    raw = diskRaw;
                    data = disk;
                    try { localStorage.setItem(BATCH_CONFIG_KEY, raw); } catch (_) { }
                } else if (raw) {
                    data = cached;
                    try { window.electronAPI?.saveBatchWorkspace?.(raw); } catch (_) { }
                }
            }
        } else if (raw) {
            try { window.electronAPI?.saveBatchWorkspace?.(raw); } catch (_) { }
        }
        if (!raw) return;
        if (!data) data = JSON.parse(raw);

        if (data.version === '2.0' && data.tabs && data.tabs.length > 0) {
            // v2: multi-tab format
            const defaultProjDir = window.electronAPI?.getDefaultProjectDir?.() || '';
            _batchTableState.projectDir = (!data.projectDir || String(data.projectDir).toLowerCase().includes('portable-data'))
                ? (defaultProjDir || data.projectDir || '')
                : data.projectDir;
            _batchTableState.projectName = data.projectName || 'UntitledProject.json';
            _batchTableState.tabs = data.tabs.map(t => ({
                id: t.id,
                name: t.name,
                materialDir: t.materialDir || '',
                _folderQueueId: t.folderQueueId || '',
                // 兼容此前没有持久化该标记的版本。
                _externalFolderQueuesCombined: !!t.externalFolderQueuesCombined || t.name === '批量导入任务',
                lastRefreshTime: t.lastRefreshTime || null,
                tasks: t.tasks || [],
            }));
            if(data.uiState && window._reelsState){
                if(data.uiState.globalSubtitleStyle)window._reelsState.globalSubtitleStyle=_cloneBatchTasks([data.uiState.globalSubtitleStyle])[0];
                for(const key of ['targetWidth','targetHeight'])if(data.uiState[key])window._reelsState[key]=data.uiState[key];
                const scope=document.getElementById('reels-style-scope');if(scope&&data.uiState.styleScope)scope.value=data.uiState.styleScope;
            }
            _batchTableState.activeTabId = data.activeTabId || _batchTableState.tabs[0].id;
            _batchTableState.nextTabId = data.nextTabId || _batchTableState.tabs.length + 1;
            _normalizeBatchTabState();
            // 将所有已保存标签投影回外部任务列表；之前只载入当前标签，
            // 其余账号虽然仍在批量表格里，重启后却不会显示在外部列表。
            const restoredTasks = [];
            const restoredTabIds = [];
            const seenTaskKeys = new Set();
            let migratedLegacyStyleCount = 0;
            const restoreTaskKey = task => {
                const queueId = String(task?._folderQueueId || '');
                const mediaPath = String(task?.audioPath || task?.videoPath || task?.bgPath || '');
                if (queueId && mediaPath) return `queue-media:${queueId}|${mediaPath}`;
                if (task?.id) return `id:${task.id}`;
                return '';
            };

            // 统一批量导入标签是文件夹队列的权威来源，优先恢复它；旧默认标签里
            // 若还残留相同任务，会在后续遍历时被去重。
            const orderedTabs = [..._batchTableState.tabs].sort((a, b) =>
                Number(!!b._externalFolderQueuesCombined) - Number(!!a._externalFolderQueuesCombined)
            );
            let duplicateTaskCount = 0;
            orderedTabs.forEach((tab) => {
                const tabOrder = _batchTableState.tabs.indexOf(tab);
                const tabTasks = tab.tasks || [];
                if (!tabTasks.length) return;
                let contributed = false;
                const uniqueTabTasks = [];
                tabTasks.forEach((task, taskOrder) => {
                    const key = restoreTaskKey(task);
                    if (key && seenTaskKeys.has(key)) {
                        duplicateTaskCount++;
                        return;
                    }
                    if (key) seenTaskKeys.add(key);
                    uniqueTabTasks.push(task);
                    const cloned = _cloneBatchTasks([task])[0] || { ...task };
                    if ((!cloned.subtitleStyle || Object.keys(cloned.subtitleStyle).length === 0)
                        && cloned.style && typeof cloned.style === 'object'
                        && Object.keys(cloned.style).length > 0) {
                        cloned.subtitleStyle = _cloneBatchTasks([cloned.style])[0] || { ...cloned.style };
                        // 同时回写标签中的源任务，下次启动不再重复迁移。
                        task.subtitleStyle = _cloneBatchTasks([cloned.style])[0] || { ...cloned.style };
                        migratedLegacyStyleCount++;
                    }
                    cloned._batchProjection = true;
                    cloned._batchTabId = tab.id;
                    cloned._batchTabName = tab.name;
                    cloned._batchTabOrder = tabOrder;
                    cloned._batchTaskOrder = taskOrder;
                    _ensureTaskId(cloned);
                    restoredTasks.push(cloned);
                    contributed = true;
                });
                if (uniqueTabTasks.length !== tabTasks.length) tab.tasks = uniqueTabTasks;
                if (contributed) restoredTabIds.push(tab.id);
            });
            if (restoredTasks.length > 0) {
                window._reelsState.tasks = restoredTasks;
                window._reelsState.selectedIdx = -1;
                _batchTableState.appliedTabIds = restoredTabIds;
                if (typeof _renderTaskList === 'function') _renderTaskList();
                const selectedId=data.uiState?.selectedTaskId;
                if(selectedId){const index=restoredTasks.findIndex(t=>t.id===selectedId);if(index>=0 && typeof reelsSelectTask==='function')setTimeout(()=>reelsSelectTask(index),0);}
            }
            console.log(`[BatchTable] Auto-restored ${_batchTableState.tabs.length} tabs, ${restoredTasks.length} unique tasks${duplicateTaskCount ? `, skipped ${duplicateTaskCount} duplicates` : ''}${migratedLegacyStyleCount ? `, migrated ${migratedLegacyStyleCount} legacy styles` : ''} from ${data.timestamp}`);
            if (duplicateTaskCount > 0 || migratedLegacyStyleCount > 0) {
                // 延迟回写清理后的标签数据，避免阻塞首屏启动。
                setTimeout(() => _batchAutoSave({ skipSync: true }), 1500);
            }
        } else if (data.tasks && data.tasks.length > 0) {
            // v1: legacy single-list format — migrate to tab
            const existing = window._reelsState.tasks || [];
            if (existing.length === 0) {
                window._reelsState.tasks = data.tasks;
                _batchTableState.tabs[0].tasks = data.tasks;
                console.log(`[BatchTable] Auto-restored ${data.tasks.length} tasks (v1) from ${data.timestamp}`);
            }
        }
    } catch (e) {
        console.warn('[BatchTable] Auto-restore failed:', e.message);
    }
}

/** 获取当前批量工程文件的完整路径 */
function _getCurrentBatchProjectFilePath() {
    const dir = (_batchTableState.projectDir || window.electronAPI?.getDefaultProjectDir?.() || '').replace(/[/\\]$/, '');
    const name = _batchTableState.projectName || 'UntitledProject.json';
    if (!dir) return '';
    const sep = dir.includes('\\') ? '\\' : '/';
    return `${dir}${sep}${name}`;
}
window.reelsGetCurrentBatchProjectFilePath = _getCurrentBatchProjectFilePath;

/** 显示工程管理器 */
async function _showProjectManager() {
    let popup = document.getElementById('rbt-project-mgr-popup');
    if (popup) { popup.remove(); return; }

    const defaultProjDir = window.electronAPI?.getDefaultProjectDir?.() || '';
    if (!_batchTableState.projectDir && defaultProjDir) {
        _batchTableState.projectDir = defaultProjDir;
    }

    const overlay = document.createElement('div');
    overlay.id = 'rbt-project-mgr-popup';
    overlay.style.cssText = `
        position:fixed; top:0; left:0; width:100vw; height:100vh;
        background:rgba(0,0,0,0.75); z-index:100000;
        display:flex; justify-content:center; align-items:center;
    `;

    // Fetch projects (unified across installed & portable directories)
    let projects = [];
    let loadError = null;
    if (window.electronAPI?.listSharedProjectFiles) {
        try {
            projects = window.electronAPI.listSharedProjectFiles(_batchTableState.projectDir) || [];
        } catch (e) {
            loadError = e.message;
        }
    } else if (_batchTableState.projectDir && window.electronAPI && window.electronAPI.scanDirectory) {
        try {
            const files = await window.electronAPI.scanDirectory(_batchTableState.projectDir);
            projects = files.filter(f => f.toLowerCase().endsWith('.json')).map(f => {
                const sep = f.includes('\\') ? '\\' : '/';
                const parts = f.split(sep);
                return { path: f, filename: parts[parts.length - 1] };
            });
            projects.sort((a, b) => a.filename.localeCompare(b.filename));
        } catch (e) {
            loadError = e.message;
        }
    }

    const currentName = _batchTableState.projectName || 'UntitledProject.json';
    const projListHtml = projects.length > 0 ? projects.map(p => {
        const isCurrent = p.filename === currentName;
        return `
            <div class="rbt-proj-mgr-item" data-project-path="${_escHtml(p.path)}" title="右键打开该工程文件所在位置: ${_escHtml(p.path)}" style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:${isCurrent ? 'rgba(0,212,255,0.1)' : 'rgba(255,255,255,0.02)'}; border:1px solid ${isCurrent ? 'var(--accent)' : '#333'}; border-radius:6px; margin-bottom:6px; cursor:context-menu;">
                <span style="font-size:13px; color:${isCurrent ? '#fff' : '#ccc'}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:8px;">${_escHtml(p.filename)}${isCurrent ? ' <span style="color:var(--accent);font-size:10px;">(当前)</span>' : ''}</span>
                <div style="display:flex; gap:6px; flex-shrink:0;">
                    <button class="rbt-btn rbt-proj-reveal-btn" data-project-path="${_escHtml(p.path)}" style="padding:2px 8px; font-size:11px;" title="打开工程文件所在文件夹">📂 位置</button>
                    ${!isCurrent ? `<button class="rbt-btn rbt-proj-load-btn" data-project-path="${_escHtml(p.path)}" style="padding:2px 8px; font-size:11px;">📥 加载</button>` : ''}
                </div>
            </div>
        `;
    }).join('') : `<div style="color:#666; font-size:13px; text-align:center; padding:20px;">没有找到任何 .json 工程文件</div>`;

    overlay.innerHTML = `
        <div style="background:#141420; border:1px solid #2a2a4a; border-radius:10px; width:480px; max-height:85vh; display:flex; flex-direction:column; box-shadow:0 10px 40px rgba(0,0,0,0.8);">
            <div style="padding:12px 16px; border-bottom:1px solid #2a2a4a; display:flex; justify-content:space-between; align-items:center;">
                <h3 style="margin:0; font-size:16px; font-weight:600; color:#eee;">📦 工程管理 (安装版/绿色版统一共享)</h3>
                <span class="rbt-close-btn" style="cursor:pointer; color:#888; font-size:18px;">&times;</span>
            </div>
            <div style="padding:16px; overflow-y:auto; flex:1;">
                
                <div style="margin-bottom:16px;">
                    <label style="display:block; font-size:11px; color:#aaa; margin-bottom:4px;">默认工程保存目录 (实时自动写入安装目录，绿色版与安装版共享)</label>
                    <div style="display:flex; gap:6px;">
                        <input type="text" id="rbt-mgr-dir-input" value="${_escHtml(_batchTableState.projectDir || '')}" class="rbt-input" style="flex:1; cursor:context-menu;" readonly title="右键打开工程保存目录" placeholder="未设置目录，仅在浏览器缓存">
                        <button class="rbt-btn" id="rbt-mgr-open-dir-btn" title="在资源管理器中打开工程目录">📂 打开目录</button>
                        <button class="rbt-btn" id="rbt-mgr-pick-dir-btn">浏览...</button>
                    </div>
                </div>

                <div style="margin-bottom:20px; padding-top:16px; border-top:1px dashed #333;">
                    <label style="display:block; font-size:11px; color:#aaa; margin-bottom:4px;">新建 / 重命名工程</label>
                    <div style="display:flex; gap:8px;">
                        <input type="text" id="rbt-mgr-name-input" value="${_escHtml(currentName)}" class="rbt-input" style="flex:1;" placeholder="例如: 项目一.json">
                        <button class="rbt-btn" id="rbt-mgr-new-btn">应用为新工程</button>
                    </div>
                    <div style="font-size:10px; color:#777; margin-top:4px;">注意：应用后当前界面数据将关联到这个新文件名，并在安装目录内自动同步保存。</div>
                </div>

                <div>
                    <div style="font-size:12px; color:#ccc; margin-bottom:8px; border-bottom:1px solid #333; padding-bottom:4px;">共享工程列表 (${projects.length}) <span style="font-size:10px;color:#888;">(可右键打开工程所在位置)</span>:</div>
                    ${loadError ? `<div style="color:var(--rbt-red); font-size:12px; padding:10px;">读取目录报错: ${_escHtml(loadError)}</div>` : projListHtml}
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('.rbt-close-btn').addEventListener('click', () => overlay.remove());

    const openDirFn = () => {
        const target = _getCurrentBatchProjectFilePath() || _batchTableState.projectDir || defaultProjDir;
        if (target && window.electronAPI?.showItemInFolder) {
            window.electronAPI.showItemInFolder(target);
        }
    };
    overlay.querySelector('#rbt-mgr-open-dir-btn')?.addEventListener('click', openDirFn);
    overlay.querySelector('#rbt-mgr-dir-input')?.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openDirFn();
    });

    overlay.querySelectorAll('.rbt-proj-reveal-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const p = btn.dataset.projectPath;
            if (p && window.electronAPI?.showItemInFolder) window.electronAPI.showItemInFolder(p);
        });
    });

    overlay.querySelectorAll('.rbt-proj-load-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const p = btn.dataset.projectPath;
            if (p) window._extLoadProject(p);
        });
    });

    overlay.querySelectorAll('.rbt-proj-mgr-item').forEach(row => {
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const p = row.dataset.projectPath;
            if (p && window.electronAPI?.showItemInFolder) window.electronAPI.showItemInFolder(p);
        });
    });

    overlay.querySelector('#rbt-mgr-pick-dir-btn').addEventListener('click', async () => {
        if (!window.electronAPI || !window.electronAPI.selectDirectory) {
            alert('环境不支持选择目录 (需Electron)');
            return;
        }
        const dir = await window.electronAPI.selectDirectory();
        if (dir) {
            _batchTableState.projectDir = dir;
            // Immediate save
            _batchAutoSave();
            overlay.remove();
            _showProjectManager(); // reload UI
        }
    });

    overlay.querySelector('#rbt-mgr-new-btn').addEventListener('click', () => {
        let nname = overlay.querySelector('#rbt-mgr-name-input').value.trim();
        if (!nname) return;
        if (!nname.toLowerCase().endsWith('.json')) nname += '.json';
        if (_batchTableState.projectName !== nname) {
            _batchTableState.projectName = nname;
            _batchAutoSave(); // trigger auto save instantly
            _renderBatchTable(); // refresh UI header
            overlay.remove();
            _showProjectManager();
        }
    });
}

// ═══════════════════════════════════════════════════════
// 全局右键菜单：打开背景素材 / 配乐 / 配音 / 工程项目所在位置
// ═══════════════════════════════════════════════════════

function _revealPathInFolder(targetPath) {
    const clean = String(targetPath || '').trim();
    if (!clean) {
        if (typeof showToast === 'function') showToast('当前未设置文件路径', 'warning', 2000);
        return false;
    }
    if (window.electronAPI?.showItemInFolder) {
        window.electronAPI.showItemInFolder(clean);
        return true;
    }
    return false;
}
window.reelsRevealPathInFolder = _revealPathInFolder;

function _showLocationContextMenu(x, y, items) {
    document.getElementById('reels-location-context-menu')?.remove();
    const validItems = (items || []).filter(item => item && (item.path || typeof item.onClick === 'function'));
    if (!validItems.length) return false;

    const menu = document.createElement('div');
    menu.id = 'reels-location-context-menu';
    menu.style.cssText = `
        position:fixed; z-index:999999; min-width:230px; max-width:420px;
        background:#181a24; border:1px solid #383e54; border-radius:8px;
        padding:6px; box-shadow:0 10px 30px rgba(0,0,0,0.75);
        color:#eee; font-size:12px; user-select:none;
    `;

    validItems.forEach((item, idx) => {
        if (item.dividerBefore && idx > 0) {
            const hr = document.createElement('div');
            hr.style.cssText = 'height:1px;background:#2d3246;margin:4px 2px;';
            menu.appendChild(hr);
        }
        const btn = document.createElement('div');
        btn.style.cssText = `
            display:flex; flex-direction:column; gap:2px; padding:7px 10px;
            border-radius:5px; cursor:pointer; transition:background 0.12s;
        `;
        const shortFile = item.path ? String(item.path).split(/[/\\]/).pop() : '';
        btn.innerHTML = `
            <div style="display:flex;align-items:center;gap:6px;font-weight:600;color:#f1f5f9;">
                <span>${_escHtml(item.label || '📂 打开文件所在位置')}</span>
            </div>
            ${item.path ? `<div style="font-size:10px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_escHtml(item.path)}">${_escHtml(shortFile || item.path)}</div>` : ''}
        `;
        btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(0, 212, 255, 0.16)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
        btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            menu.remove();
            if (typeof item.onClick === 'function') item.onClick();
            else if (item.path) _revealPathInFolder(item.path);
        });
        menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;

    const closeMenu = (ev) => {
        if (!menu.contains(ev.target)) {
            menu.remove();
            document.removeEventListener('mousedown', closeMenu, true);
            document.removeEventListener('contextmenu', closeMenu, true);
        }
    };
    setTimeout(() => {
        document.addEventListener('mousedown', closeMenu, true);
        document.addEventListener('contextmenu', closeMenu, true);
    }, 0);
    return true;
}
window.reelsShowLocationContextMenu = _showLocationContextMenu;

function _buildTaskLocationItems(task, preferredField = '') {
    const items = [];
    const seen = new Set();
    const pushItem = (key, label, pathVal, dividerBefore = false) => {
        const clean = String(pathVal || '').trim();
        if (!clean || /^(blob:|data:|https?:)/i.test(clean)) return;
        const dedupKey = `${key}|${clean.toLowerCase()}`;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);
        items.push({ key, label, path: clean, dividerBefore });
    };

    if (task) {
        // Background media
        if (task.bgMode === 'multi' && Array.isArray(task.bgClipPool) && task.bgClipPool.length > 0) {
            pushItem('bg', `🎬 打开背景池首个素材位置 (共${task.bgClipPool.length}个)`, task.bgClipPool[0]);
            task.bgClipPool.slice(1, 5).forEach((p, idx) => {
                pushItem('bg', `🎬 打开背景池素材 #${idx + 2} 位置`, p);
            });
        } else {
            pushItem('bg', '🎬 打开背景素材所在位置', task.bgPath || task.videoPath || (Array.isArray(task.bgClipPool) ? task.bgClipPool[0] : ''));
        }
        // ClipPool folder
        if (task.clipPoolDir || task.concatVideoPath) {
            pushItem('clippool', '🎞️ 打开背景片段池文件夹', task.clipPoolDir || task.concatVideoPath);
        }
        // BGM / Music
        if (task.bgmMode === 'multi' && Array.isArray(task.bgmClipPool) && task.bgmClipPool.length > 0) {
            pushItem('bgm', `🎵 打开配乐池首个文件位置 (共${task.bgmClipPool.length}首)`, task.bgmClipPool[0]);
            task.bgmClipPool.slice(1, 5).forEach((p, idx) => {
                pushItem('bgm', `🎵 打开配乐池 #${idx + 2} 所在位置`, p);
            });
        } else if (task.bgmPath || (Array.isArray(task.bgmClipPool) && task.bgmClipPool[0])) {
            pushItem('bgm', '🎵 打开配乐文件所在位置', task.bgmPath || task.bgmClipPool[0]);
        }
        // Voice / Audio
        if (task.audioPath) {
            pushItem('audio', '🎙️ 打开人声配音所在位置', task.audioPath);
        }
        // Content video
        if (task.contentVideoPath) {
            pushItem('contentvideo', '📹 打开内容视频所在位置', task.contentVideoPath);
        }
        // SRT subtitle
        if (task.srtPath) {
            pushItem('srt', '📝 打开SRT字幕所在位置', task.srtPath);
        }
        // Hook / PiP / Cover
        if (task.hookFile) pushItem('hook', '🪝 打开前置Hook文件位置', task.hookFile);
        if (task.pipPath) pushItem('pip', '🖼️ 打开图像覆层素材位置', task.pipPath);
        if (task.cover?.bgPath) pushItem('cover', '🖼️ 打开封面素材所在位置', task.cover.bgPath);
        if (task.insertMediaFolder) pushItem('insert', '📁 打开停顿插入素材文件夹', task.insertMediaFolder);
        // Auto-edit project
        const autoEditProj = task.autoEditProject?.projectDir || task.autoEditProject?.reelsProjectPath || task.autoEditProject?.analysisProjectPath || '';
        if (autoEditProj) {
            pushItem('project', '📦 打开该任务二剪工程目录', autoEditProj, true);
        }
    }

    // Reorder so preferredField is at the very top
    if (preferredField) {
        items.sort((a, b) => (b.key === preferredField ? 1 : 0) - (a.key === preferredField ? 1 : 0));
    }

    const batchProjPath = _getCurrentBatchProjectFilePath();
    if (batchProjPath) {
        pushItem('batch_project', '📦 打开当前工程存储位置', batchProjPath, items.length > 0);
    }
    return items;
}

window.reelsRevealActiveTaskMedia = function(kind = 'bg') {
    const state = window._reelsState;
    const task = state?.tasks?.[state.selectedIdx] || state?.tasks?.[0] || null;
    if (kind === 'bg') {
        const p = document.getElementById('reels-bg-path-ui')?.value || task?.bgPath || task?.videoPath || task?.bgClipPool?.[0] || '';
        return _revealPathInFolder(p);
    }
    if (kind === 'bgm') {
        const p = document.getElementById('reels-bgm-path-ui')?.value || task?.bgmPath || task?.bgmClipPool?.[0] || '';
        return _revealPathInFolder(p);
    }
    if (kind === 'cv') {
        const p = document.getElementById('reels-cv-path-ui')?.value || task?.contentVideoPath || '';
        return _revealPathInFolder(p);
    }
    if (kind === 'project') {
        return _revealPathInFolder(_getCurrentBatchProjectFilePath());
    }
    return false;
};

if (typeof document !== 'undefined' && !window._reelsGlobalContextMenuBound) {
    window._reelsGlobalContextMenuBound = true;
    document.addEventListener('contextmenu', (e) => {
        const target = e.target;
        if (!target || typeof target.closest !== 'function') return;

        // 1. Multi-BG / Multi-BGM pool items & Media Pool sidebar items
        const poolItem = target.closest('.bgpool-item[data-file-path], .bgmpool-item[data-file-path], .rbt-ms-item[data-path]');
        if (poolItem) {
            const filePath = poolItem.dataset.filePath || poolItem.dataset.path;
            if (filePath) {
                e.preventDefault();
                e.stopPropagation();
                _showLocationContextMenu(e.clientX, e.clientY, [
                    { label: '📂 打开素材文件所在位置', path: filePath },
                ]);
                return;
            }
        }

        // 2. Current project button (`📦 当前工程: ...`)
        const projBtn = target.closest('#rbt-project-mgr-btn');
        if (projBtn) {
            const projPath = _getCurrentBatchProjectFilePath();
            if (projPath) {
                e.preventDefault();
                e.stopPropagation();
                _showLocationContextMenu(e.clientX, e.clientY, [
                    { label: '📦 打开当前工程存储位置', path: projPath },
                    { label: '⚙️ 打开工程管理器', onClick: () => _showProjectManager() },
                ]);
                return;
            }
        }

        // 3. Batch Table Tabs (`.rbt-tab[data-tab-id]`)
        const tabEl = target.closest('.rbt-tab[data-tab-id]');
        if (tabEl) {
            const tabId = tabEl.dataset.tabId;
            const tab = (_batchTableState.tabs || []).find(t => t.id === tabId);
            if (tab) {
                const menuItems = [];
                if (tab.materialDir) {
                    menuItems.push({ label: `📁 打开标签「${tab.name}」素材目录`, path: tab.materialDir });
                }
                const firstTask = (tab.tasks || [])[0] || (tab.id === _batchTableState.activeTabId ? window._reelsState?.tasks?.[0] : null);
                if (firstTask) {
                    const bg = firstTask.bgPath || firstTask.videoPath || firstTask.bgClipPool?.[0] || '';
                    const bgm = firstTask.bgmPath || firstTask.bgmClipPool?.[0] || '';
                    const audio = firstTask.audioPath || '';
                    if (bg) menuItems.push({ label: '🎬 打开该组首个背景素材位置', path: bg });
                    if (bgm) menuItems.push({ label: '🎵 打开该组首个配乐文件位置', path: bgm });
                    if (audio) menuItems.push({ label: '🎙️ 打开该组首个配音文件位置', path: audio });
                }
                const projPath = _getCurrentBatchProjectFilePath();
                if (projPath) {
                    menuItems.push({ label: '📦 打开工程存储位置', path: projPath, dividerBefore: menuItems.length > 0 });
                }
                if (menuItems.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    _showLocationContextMenu(e.clientX, e.clientY, menuItems);
                    return;
                }
            }
        }

        // 4. Batch Table Row / Cell (`tr.rbt-row[data-idx]`)
        const tableRow = target.closest('tr.rbt-row[data-idx]');
        if (tableRow) {
            // Allow native contextmenu inside textareas/text inputs for copy/paste unless it's a readonly path input
            if (target.matches('textarea, input[type="text"]:not([readonly])')) return;
            const idx = parseInt(tableRow.dataset.idx, 10);
            const task = window._reelsState?.tasks?.[idx];
            if (task) {
                let preferred = '';
                if (target.closest('.rbt-col-bg')) preferred = 'bg';
                else if (target.closest('.rbt-col-bgm')) preferred = 'bgm';
                else if (target.closest('.rbt-col-audio')) preferred = 'audio';
                else if (target.closest('.rbt-col-contentvideo')) preferred = 'contentvideo';
                else if (target.closest('.rbt-col-srt')) preferred = 'srt';
                else if (target.closest('.rbt-col-hook')) preferred = 'hook';
                else if (target.closest('.rbt-col-pip')) preferred = 'pip';
                else if (target.closest('.rbt-col-clippool')) preferred = 'clippool';
                else if (target.closest('.rbt-col-cover-media')) preferred = 'cover';

                const items = _buildTaskLocationItems(task, preferred);
                if (items.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    _showLocationContextMenu(e.clientX, e.clientY, items);
                    return;
                }
            }
        }

        // 5. Left Task List in Main Reels View (`.reels-task-item`, `.reels-batch-group-header`, `.reels-folder-queue-header`)
        const taskItemEl = target.closest('.reels-task-item[data-idx]');
        if (taskItemEl) {
            const idx = parseInt(taskItemEl.dataset.idx, 10);
            const task = window._reelsState?.tasks?.[idx];
            if (task) {
                const items = _buildTaskLocationItems(task);
                if (items.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    _showLocationContextMenu(e.clientX, e.clientY, items);
                    return;
                }
            }
        }

        const groupHeaderEl = target.closest('.reels-batch-group-header[data-tab-id], .reels-folder-queue-header[data-queue-id]');
        if (groupHeaderEl) {
            const tabId = groupHeaderEl.dataset.tabId;
            const queueId = groupHeaderEl.dataset.queueId;
            const menuItems = [];
            if (tabId) {
                const tab = (_batchTableState.tabs || []).find(t => t.id === tabId);
                if (tab?.materialDir) menuItems.push({ label: `📁 打开分组「${tab.name}」素材目录`, path: tab.materialDir });
                const firstTask = (window._reelsState?.tasks || []).find(t => t?._batchTabId === tabId) || tab?.tasks?.[0];
                if (firstTask) {
                    menuItems.push(..._buildTaskLocationItems(firstTask));
                }
            } else if (queueId) {
                const queue = (window._reelsState?.folderQueues || []).find(q => q.id === queueId);
                if (queue?.dirPath) menuItems.push({ label: `📁 打开队列「${queue.name}」文件夹`, path: queue.dirPath });
                const firstTask = (window._reelsState?.tasks || []).find(t => t?._folderQueueId === queueId);
                if (firstTask) {
                    menuItems.push(..._buildTaskLocationItems(firstTask));
                }
            }
            if (!menuItems.length) {
                const projPath = _getCurrentBatchProjectFilePath();
                if (projPath) menuItems.push({ label: '📦 打开当前工程存储位置', path: projPath });
            }
            if (menuItems.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                _showLocationContextMenu(e.clientX, e.clientY, menuItems);
                return;
            }
        }

        // 6. Main Reels Right Inspector inputs/containers for Background Media, Content Video, and BGM
        const inspectorMediaEl = target.closest(
            '#reels-bg-path-ui, #reels-bg-single-container, #reels-bg-multi-container, #reels-bg-pool-count, ' +
            '#reels-bg-clippool-dir-ui, #reels-cv-path-ui, ' +
            '#reels-bgm-path-ui, #reels-bgm-single-container, #reels-bgm-multi-container, #reels-bgm-pool-count'
        );
        if (inspectorMediaEl) {
            const state = window._reelsState;
            const task = state?.tasks?.[state.selectedIdx] || state?.tasks?.[0] || null;
            let preferred = 'bg';
            if (target.closest('#reels-bgm-path-ui, #reels-bgm-single-container, #reels-bgm-multi-container, #reels-bgm-pool-count')) {
                preferred = 'bgm';
            } else if (target.closest('#reels-cv-path-ui')) {
                preferred = 'contentvideo';
            } else if (target.closest('#reels-bg-clippool-dir-ui')) {
                preferred = 'clippool';
            }
            const items = _buildTaskLocationItems(task, preferred);
            const uiBg = document.getElementById('reels-bg-path-ui')?.value?.trim();
            const uiBgm = document.getElementById('reels-bgm-path-ui')?.value?.trim();
            const uiCv = document.getElementById('reels-cv-path-ui')?.value?.trim();
            const uiClip = document.getElementById('reels-bg-clippool-dir-ui')?.value?.trim();
            if (preferred === 'bg' && uiBg && !items.some(i => i.path === uiBg)) {
                items.unshift({ key: 'bg', label: '🎬 打开背景素材所在位置', path: uiBg });
            } else if (preferred === 'bgm' && uiBgm && !items.some(i => i.path === uiBgm)) {
                items.unshift({ key: 'bgm', label: '🎵 打开配乐文件所在位置', path: uiBgm });
            } else if (preferred === 'contentvideo' && uiCv && !items.some(i => i.path === uiCv)) {
                items.unshift({ key: 'contentvideo', label: '📹 打开内容视频所在位置', path: uiCv });
            } else if (preferred === 'clippool' && uiClip && !items.some(i => i.path === uiClip)) {
                items.unshift({ key: 'clippool', label: '🎞️ 打开背景片段池文件夹', path: uiClip });
            }
            if (items.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                _showLocationContextMenu(e.clientX, e.clientY, items);
                return;
            }
        }
    }, true);
}


// 全局辅助用于点击加载工程 (只能挂在 window 上因为是在 innerHTML 里生成的 onclick)
window._extLoadProject = async (pathStr) => {
    if (!window.electronAPI || !window.electronAPI.readFileText) return;
    const content = window.electronAPI.readFileText(pathStr);
    if (!content) {
        alert('无法读取或文件为空!');
        return;
    }
    try {
        const file = new File([content], _batchTableState.projectName || 'project.json', { type: 'application/json' });

        // 我们利用现成的导入逻辑，稍微魔改下跳过 input.click
        // 因为现成的 _batchImportConfig 需要传入 file (FileReader)，它会确认。
        const data = JSON.parse(content);
        if (data.version === '2.0' && data.tabs) {
            if (!confirm(`将从硬盘加载 [${pathStr}]\n这将替换当前界面的所有任务数据！\n确定加载？`)) return;
            _batchTableState.tabs = data.tabs.map(t => ({
                id: t.id,
                name: t.name,
                materialDir: t.materialDir || '',
                lastRefreshTime: t.lastRefreshTime || null,
                tasks: t.tasks || [],
            }));
            const parts = pathStr.split(/[/\\]/);
            _batchTableState.projectName = parts[parts.length - 1]; // update current name
            _batchTableState.activeTabId = data.activeTabId || _batchTableState.tabs[0].id;
            _batchTableState.nextTabId = data.nextTabId || _batchTableState.tabs.length + 1;
            _normalizeBatchTabState();
            const activeTab = _getActiveTab();
            _loadTabTasks(activeTab);
            _skipNextApply = true;
            _renderBatchTable();
            _batchAutoSave(); // instantly resync localStorage

            const popup = document.getElementById('rbt-project-mgr-popup');
            if (popup) popup.remove();

            const total = _batchTableState.tabs.reduce((s, t) => s + (t.tasks || []).length, 0);
            alert(`✅ 已成功加载工程！`);
        } else {
            alert('文件格式不正确或版本过旧(仅支持v2.0多标签工程)');
        }
    } catch (e) {
        alert('加载工程解析失败: ' + e.message);
    }
};

// ═══════════════════════════════════════════════════════
// 查找素材 — 重新关联缺失文件
// ═══════════════════════════════════════════════════════

/**
 * 收集所有需要检查的文件路径（同步收集，异步检查）
 */
function _collectPathsToCheck(tasks) {
    const FIELDS = ['bgPath', 'videoPath', 'audioPath', 'srtPath', 'txtPath', 'pipPath',
        'contentVideoPath', 'bgmPath', 'hookFile'];
    const entries = []; // { taskIdx, field, path, fileName }

    const _normalizePath = (val) => {
        if (!val || typeof val !== 'string') return '';
        let p = val.trim();
        if (p.startsWith('file://')) {
            p = p.substring(7);
            if (p.startsWith('/') && p.match(/^\/[a-zA-Z]:/)) {
                p = p.substring(1);
            }
        }
        try { p = decodeURIComponent(p); } catch (_) {}
        return p;
    };

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        for (const field of FIELDS) {
            let val = task[field];
            if (!val || typeof val !== 'string') continue;
            val = _normalizePath(val);
            const fileName = val.split('/').pop().split('\\').pop();
            if (fileName) entries.push({ taskIdx: i, field, path: val, fileName });
        }
        if (task.cover && task.cover.bgPath) {
            let cp = task.cover.bgPath;
            if (cp && typeof cp === 'string') {
                cp = _normalizePath(cp);
                const fn = cp.split('/').pop().split('\\').pop();
                if (fn) entries.push({ taskIdx: i, field: 'cover.bgPath', path: cp, fileName: fn });
            }
        }
        if (Array.isArray(task.bgClipPool)) {
            for (let ci = 0; ci < task.bgClipPool.length; ci++) {
                let cp = task.bgClipPool[ci];
                if (!cp || typeof cp !== 'string') continue;
                cp = _normalizePath(cp);
                const fn = cp.split('/').pop().split('\\').pop();
                if (fn) entries.push({ taskIdx: i, field: `bgClipPool[${ci}]`, path: cp, fileName: fn });
            }
        }
        if (Array.isArray(task.bgmClipPool)) {
            for (let ci = 0; ci < task.bgmClipPool.length; ci++) {
                let cp = task.bgmClipPool[ci];
                if (!cp || typeof cp !== 'string') continue;
                cp = _normalizePath(cp);
                const fn = cp.split('/').pop().split('\\').pop();
                if (fn) entries.push({ taskIdx: i, field: `bgmClipPool[${ci}]`, path: cp, fileName: fn });
            }
        }
        if (Array.isArray(task.overlays)) {
            for (let oi = 0; oi < task.overlays.length; oi++) {
                const ov = task.overlays[oi];
                if (ov && ov.content && (ov.type === 'image' || ov.type === 'video')) {
                    let ovPath = ov.content;
                    if (typeof ovPath !== 'string') continue;
                    ovPath = _normalizePath(ovPath);
                    const fn = ovPath.split('/').pop().split('\\').pop();
                    if (fn) entries.push({ taskIdx: i, field: `overlays[${oi}].content`, path: ovPath, fileName: fn, originalContent: ov.content });
                }
            }
        }
    }
    return entries;
}

/**
 * 主函数：查找并重新关联缺失素材
 */
async function _relocateMissingMaterials() {
    _syncTasksToActiveTab();
    const allTasks = [];
    for (const tab of _batchTableState.tabs) {
        if (tab.tasks) allTasks.push(...tab.tasks);
    }

    if (allTasks.length === 0) {
        alert('没有任何任务。');
        return;
    }

    const statusEl = document.getElementById('reels-export-status');
    if (statusEl) statusEl.textContent = '🔍 正在检查素材路径...';
    await new Promise(r => setTimeout(r, 30));

    // 收集所有路径
    const entries = _collectPathsToCheck(allTasks);
    console.log('[查找素材] 任务数:', allTasks.length, '素材条目:', entries.length);
    if (entries.length > 0) {
        console.log('[查找素材] 前3个条目:', entries.slice(0, 3).map(e => ({ field: e.field, path: e.path, fileName: e.fileName })));
    } else {
        // 打印第一个 task 的关键字段以排查
        const t0 = allTasks[0];
        console.log('[查找素材] 空条目! task[0] 关键字段:', { bgPath: t0?.bgPath, videoPath: t0?.videoPath, audioPath: t0?.audioPath, fileName: t0?.fileName, bgSrcUrl: t0?.bgSrcUrl });
    }
    if (entries.length === 0) {
        alert('没有素材路径需要检查。');
        if (statusEl) statusEl.textContent = '';
        return;
    }

    // 分类: 纯文件名(一定缺失) vs 有路径的(需要检查)
    const missing = [];
    const pathsToCheck = [];

    for (const e of entries) {
        if (!e.path.includes('/') && !e.path.includes('\\')) {
            // 纯文件名 = 一定缺失
            missing.push(e);
        } else {
            pathsToCheck.push(e);
        }
    }

    // 通过 IPC 批量检查文件是否存在
    if (pathsToCheck.length > 0 && window.electronAPI && window.electronAPI.checkFilesExist) {
        const uniquePaths = [...new Set(pathsToCheck.map(e => e.path))];
        const existMap = await window.electronAPI.checkFilesExist(uniquePaths);
        for (const e of pathsToCheck) {
            if (!existMap[e.path]) {
                missing.push(e);
            }
        }
    }

    if (missing.length === 0) {
        alert('✅ 所有素材路径均有效，无需查找。');
        if (statusEl) statusEl.textContent = '✅ 素材路径检查通过';
        return;
    }

    // 去重文件名
    const uniqueNames = [...new Set(missing.map(m => m.fileName))];

    const confirmMsg = `发现 ${missing.length} 个缺失素材（${uniqueNames.length} 个不同文件名）。\n\n缺失文件:\n${uniqueNames.slice(0, 10).join('\n')}${uniqueNames.length > 10 ? '\n...' : ''}\n\n请选择一个文件夹，将在其中递归搜索这些文件。`;
    if (!confirm(confirmMsg)) {
        if (statusEl) statusEl.textContent = '';
        return;
    }

    // 选择搜索目录
    let searchDir = null;
    if (window.electronAPI && window.electronAPI.selectDirectory) {
        searchDir = await window.electronAPI.selectDirectory();
    }
    if (!searchDir) return;

    if (statusEl) statusEl.textContent = `🔍 正在搜索 ${searchDir} ...`;
    await new Promise(r => setTimeout(r, 50));

    // 通过 IPC 递归搜索
    let foundMap = {};
    if (window.electronAPI && window.electronAPI.searchFilesRecursive) {
        foundMap = await window.electronAPI.searchFilesRecursive(searchDir, uniqueNames, 10);
    }

    // 应用找到的路径
    let fixedCount = 0;
    for (const m of missing) {
        const foundPath = foundMap[m.fileName.toLowerCase()];
        if (!foundPath) continue;

        const task = allTasks[m.taskIdx];
        if (!task) continue;

        if (m.field.startsWith('bgClipPool[')) {
            const idx = parseInt(m.field.match(/\d+/)[0]);
            if (Array.isArray(task.bgClipPool) && idx < task.bgClipPool.length) {
                const oldPath = task.bgClipPool[idx];
                task.bgClipPool[idx] = foundPath;
                if (Array.isArray(task.bgClipActivePool)) {
                    task.bgClipActivePool = task.bgClipActivePool.map(p => p === oldPath ? foundPath : p);
                }
                fixedCount++;
            }
        } else if (m.field.startsWith('bgmClipPool[')) {
            const idx = parseInt(m.field.match(/\d+/)[0]);
            if (Array.isArray(task.bgmClipPool) && idx < task.bgmClipPool.length) {
                const oldPath = task.bgmClipPool[idx];
                task.bgmClipPool[idx] = foundPath;
                if (Array.isArray(task.bgmClipActivePool)) {
                    task.bgmClipActivePool = task.bgmClipActivePool.map(p => p === oldPath ? foundPath : p);
                }
                fixedCount++;
            }
        } else if (m.field.startsWith('overlays[')) {
            const match = m.field.match(/overlays\[(\d+)\]\.content/);
            if (match) {
                const idx = parseInt(match[1]);
                if (Array.isArray(task.overlays) && task.overlays[idx]) {
                    task.overlays[idx].content = foundPath;
                    fixedCount++;
                }
            }
        } else if (m.field === 'cover.bgPath') {
            if (!task.cover) task.cover = {};
            task.cover.bgPath = foundPath;
            fixedCount++;
        } else {
            task[m.field] = foundPath;
            if (m.field === 'bgPath') {
                _setTaskSingleBackground(task, foundPath);
                // 重新生成缩略图 URL
                if (window.electronAPI && window.electronAPI.toFileUrl) {
                    task.bgSrcUrl = window.electronAPI.toFileUrl(foundPath);
                } else {
                    task.bgSrcUrl = '';
                }
            }
            if (m.field === 'videoPath') {
                _setTaskSingleBackground(task, foundPath);
                if (window.electronAPI && window.electronAPI.toFileUrl) {
                    task.bgSrcUrl = window.electronAPI.toFileUrl(foundPath);
                } else {
                    task.bgSrcUrl = '';
                }
            }
            fixedCount++;
        }
    }

    // 刷新表格
    if (typeof _renderBatchTable === 'function') _renderBatchTable();

    // 刷新侧边栏 (若修改了当前选中的任务)
    const selectedIdx = window._reelsState.selectedIdx;
    if (selectedIdx >= 0 && allTasks[selectedIdx] && window.reelsSyncBackgroundTabUI) {
        window.reelsSyncBackgroundTabUI(allTasks[selectedIdx]);
    }

    const notFound = missing.length - fixedCount;
    const resultMsg = `✅ 查找完成！\n\n已修复: ${fixedCount} 个路径\n未找到: ${notFound} 个${notFound > 0 ? '\n\n未找到的文件:\n' + [...new Set(missing.filter(m => !foundMap[m.fileName.toLowerCase()]).map(m => m.fileName))].slice(0, 10).join('\n') : ''}`;
    alert(resultMsg);
    if (statusEl) statusEl.textContent = `✅ 素材查找完成: 修复 ${fixedCount}/${missing.length}`;
}

/** 按选择范围导出 JSON 工程；不改变当前标签或其他工程。 */
function _batchExportConfig(scope = 'current') {
    if (_batchTableState.visible) _applyBatchTableChanges();
    _syncTasksToActiveTab();
    const activeTab = _getActiveTab();
    const tabs = scope === 'all' ? _batchTableState.tabs : (activeTab ? [activeTab] : []);
    const totalTasks = tabs.reduce((sum, t) => sum + (t.tasks || []).length, 0);
    if (totalTasks === 0) {
        alert(scope === 'all' ? '没有任务可以保存' : '当前工程没有任务可以保存');
        return;
    }
    const data = {
        version: '2.0',
        timestamp: new Date().toISOString(),
        activeTabId: activeTab?.id || tabs[0]?.id,
        nextTabId: _batchTableState.nextTabId,
        tabs: tabs.map(tab => ({
            id: tab.id,
            name: tab.name,
            materialDir: tab.materialDir || '',
            lastRefreshTime: tab.lastRefreshTime || null,
            tasks: _serializeTasks(tab.tasks),
        })),
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const projectLabel = scope === 'all' ? '全部工程' : String(activeTab?.name || '当前工程');
    const safeLabel = projectLabel.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || '工程';
    a.download = `batch_project_${safeLabel}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    console.log(`[BatchTable] Exported project: ${tabs.length} tabs, ${totalTasks} tasks`);
}

/** 从 JSON 文件导入工程配置 */
function _batchImportConfig(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        if (window._batchImportInProgress) return;
        window._batchImportInProgress = true;
        try {
            let data = JSON.parse(e.target.result);
            if (data.version !== '2.0' && Array.isArray(data.tasks)) {
                data = { version: '2.0', tabs: [{ id: 'legacy', name: (file.name || '导入工程').replace(/\.json$/i, ''), tasks: data.tasks }], activeTabId: 'legacy' };
            }
            if (data.version !== '2.0' || !Array.isArray(data.tabs) || !data.tabs.length) throw new Error('工程文件中没有有效标签页');

            if (data.version === '2.0' && data.tabs && data.tabs.length > 0) {
                // Import into new tabs; loading a file must not replace existing work.
                if (!data.tabs.every(t => t && Array.isArray(t.tasks))) throw new Error('工程标签页数据无效');
                const mode = await window.electronAPI.chooseBatchImportMode({ current: _batchTableState.tabs.length, incoming: data.tabs.length });
                if (mode !== 'append' && mode !== 'replace') return;
                if (_batchTableState.visible) _applyBatchTableChanges();
                _syncTasksToActiveTab();
                _normalizeBatchTabState();
                if (mode === 'replace') {
                    const backupDir = _batchTableState.projectDir || await window.electronAPI.getDownloadsPath();
                    if (!backupDir) throw new Error('无法确定备份目录，已取消覆盖');
                    const backupPath = backupDir.replace(/[\\/]$/, '') + '/覆盖前工程备份_' + Date.now() + '.json';
                    const backup = { version: '2.0', timestamp: new Date().toISOString(), activeTabId: _batchTableState.activeTabId, nextTabId: _batchTableState.nextTabId,
                        tabs: _batchTableState.tabs.map(tab => ({ id: tab.id, name: tab.name, materialDir: tab.materialDir || '', folderQueueId: tab._folderQueueId || '', externalFolderQueuesCombined: !!tab._externalFolderQueuesCombined, lastRefreshTime: tab.lastRefreshTime || null, tasks: _serializeTasks(tab.tasks) })) };
                    if (!await window.electronAPI.writeFileText(backupPath, JSON.stringify(backup, null, 2))) throw new Error('备份失败，原有工程未覆盖');
                }
                const importedTabs = data.tabs.map(t => {
                    const id = 'tab_' + _batchTableState.nextTabId++;
                    const queueIds = new Map();
                    const remapQueue = old => {
                        if (!old) return '';
                        if (!queueIds.has(old)) queueIds.set(old, `${id}_import_${Date.now()}_${queueIds.size}`);
                        return queueIds.get(old);
                    };
                    return {
                        id,
                        name: t.name || '导入工程',
                        materialDir: t.materialDir || '',
                        _folderQueueId: remapQueue(t.folderQueueId || t._folderQueueId),
                        _externalFolderQueuesCombined: !!(t.externalFolderQueuesCombined || t._externalFolderQueuesCombined),
                        lastRefreshTime: t.lastRefreshTime || null,
                        tasks: t.tasks.map(task => {
                            const imported = _stripBatchGroupMeta(task);
                            delete imported.id;
                            _ensureTaskId(imported);
                            if (imported._folderQueueId) imported._folderQueueId = remapQueue(imported._folderQueueId);
                            return imported;
                        }),
                    };
                });
                if (mode === 'replace') _batchTableState.tabs = importedTabs;
                else _batchTableState.tabs.push(...importedTabs);
                const activeIndex = Math.max(0, data.tabs.findIndex(t => t.id === data.activeTabId));
                _batchTableState.activeTabId = importedTabs[activeIndex].id;
                _loadTabTasks(_getActiveTab());
                _skipNextApply = true;
                _renderBatchTable();
                const total = importedTabs.reduce((sum, t) => sum + t.tasks.length, 0);
                alert(mode === 'replace' ? `✅ 已覆盖为 ${importedTabs.length} 个工程、${total} 个任务。原工程已备份到工程保存目录。` : `✅ 已新增 ${importedTabs.length} 个工程标签页、${total} 个任务，原有工程已保留。`);
            }
        } catch (err) {
            alert(`加载工程未完成: ${err.message}`);
        } finally { window._batchImportInProgress = false; }
    };
    reader.readAsText(file);
}

// ═══════════════════════════════════════════════════════
// 13. Auto-initialize
// ═══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
    if(window.location?.hash?.startsWith('#template='))return;
    _batchAutoRestore();

    // 如果未设置工程路径，优先使用设置页自定义目录，否则用"下载"文件夹
    if (!_batchTableState.projectDir) {
        const customDir = localStorage.getItem('vk_default_output_dir');
        if (customDir) {
            _batchTableState.projectDir = customDir;
            _batchAutoSave();
        } else if (window.electronAPI && window.electronAPI.getDownloadsPath) {
            try {
                const dlPath = await window.electronAPI.getDownloadsPath();
                if (dlPath) {
                    _batchTableState.projectDir = dlPath;
                    _batchAutoSave();
                }
            } catch (err) {
                console.warn('Failed to set default project dir:', err);
            }
        }
    }

    _initBatchTable();

    // 每30秒自动保存一次（安全网）
    setInterval(() => {
        if (window._reelsState && _batchTableState.tabs.length > 0) {
            _batchAutoSave();
        }
    }, 30000);
});

window.reelsFlushWorkspaceBeforeClose=function(){
    if(window._skipBatchSaveBeforeUnload || window._templateThumbnailCaptureActive)return {ok:true,skipped:true};
    try{
        document.activeElement?.blur?.();
        if(typeof _syncCurrentOverlayEditorToSelectedTask==='function')_syncCurrentOverlayEditorToSelectedTask();
        if(typeof _getSelectedTask==='function' && _getSelectedTask() && typeof _persistSubtitleStyleByScope==='function')_persistSubtitleStyleByScope(_readStyleFromUI());
        const ok=_batchAutoSave()===true;
        return {ok,error:ok?'':'无法写入自动保存文件，请检查软件目录是否可写。'};
    }catch(error){return {ok:false,error:error.message||String(error)};}
};
let _workspaceEditSaveTimer;
function scheduleWorkspaceEditSave(event){
    if(!event?.isTrusted || !event.target?.closest?.('#batch-reels-panel, .reels-batch-table-container'))return;
    window._workspaceCloseAlreadySaved=false;
    clearTimeout(_workspaceEditSaveTimer);
    _workspaceEditSaveTimer=setTimeout(()=>{_workspaceEditSaveTimer=null;_batchAutoSave();},1800);
}
document.addEventListener('input',scheduleWorkspaceEditSave);
document.addEventListener('change',scheduleWorkspaceEditSave);
window.addEventListener('beforeunload',()=>{
    if(window._workspaceCloseAlreadySaved)return;
    clearTimeout(_workspaceEditSaveTimer);
    window.reelsFlushWorkspaceBeforeClose();
});

// ═══════════════════════════════════════════════════════
// ⏱️ Subtitle Time Slice Editor — 字幕时间切片（极简版）
// ═══════════════════════════════════════════════════════

function _showSubtitleTimeSliceEditor(idx) {
    const state = window._reelsState;
    const task = state.tasks[idx];
    if (!task) return;

    const currentMode = task.subtitleTimeMode || 'full';
    const currentSlices = task.subtitleTimeSlices || [];
    // 如果已有切片，取第一个切片的 endSec 作为切换秒数
    const currentSplitAt = (currentSlices.length > 0 && currentSlices[0].endSec) ? currentSlices[0].endSec : 10;

    // 如果当前是分段模式 → 直接切回全时段（一键切换）
    if (currentMode === 'split') {
        task.subtitleTimeMode = 'full';
        task.subtitleTimeSlices = [];
        _updateSubtitleTimeCell(idx);
        if (typeof showToast === 'function') showToast(`✅ 行 ${idx + 1}: 已切回全时段`, 'success');
        return;
    }

    // 当前是全时段 → 弹出简洁输入框设置切换秒数
    // 移除旧弹窗
    document.querySelectorAll('.rbt-subtime-popover').forEach(el => el.remove());

    const cell = _batchTableState.container.querySelector(`.rbt-subtime-cell[data-idx="${idx}"]`);
    if (!cell) return;

    const rect = cell.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'rbt-subtime-popover';
    // 防止右侧溢出屏幕
    const popWidth = 280;
    let popLeft = rect.left;
    if (popLeft + popWidth > window.innerWidth - 12) {
        popLeft = window.innerWidth - popWidth - 12;
    }
    // 防止底部溢出
    let popTop = rect.bottom + 4;
    if (popTop + 100 > window.innerHeight) {
        popTop = rect.top - 100;
    }
    pop.style.cssText = `position:fixed;z-index:99999;background:#1e1e2e;border:1px solid #4c9eff;border-radius:8px;padding:12px;box-shadow:0 8px 32px rgba(0,0,0,0.6);
        left:${popLeft}px;top:${popTop}px;width:${popWidth}px;`;

    pop.innerHTML = `
        <div style="font-size:11px;color:#999;margin-bottom:8px;">标题始终显示，前 N 秒显示正文上半段，之后显示下半段</div>
        <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:12px;color:#ccc;">在第</span>
            <input type="number" id="rbt-subtime-sec" value="${currentSplitAt}" min="1" max="999" step="0.5"
                   style="width:55px;background:#111;border:1px solid #444;color:#4c9eff;padding:4px 8px;border-radius:4px;font-size:13px;text-align:center;font-weight:bold;">
            <span style="font-size:12px;color:#ccc;">秒切换</span>
            <button id="rbt-subtime-apply" style="padding:4px 12px;background:#4c9eff;border:none;color:#000;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;">✓</button>
        </div>
    `;

    document.body.appendChild(pop);

    // 自动聚焦输入框
    const input = pop.querySelector('#rbt-subtime-sec');
    input.focus();
    input.select();

    let closeHandler = null;
    const closePopover = () => {
        if (closeHandler) {
            document.removeEventListener('mousedown', closeHandler);
            closeHandler = null;
        }
        if (pop.parentNode) pop.remove();
    };

    const applyAndClose = () => {
        try {
            const splitAt = parseFloat(input.value) || 10;
            task.subtitleTimeMode = 'split';
            task.subtitleTimeSlices = [
                { label: 'A', startSec: 0, endSec: splitAt, source: 'body_part1' },
                { label: 'B', startSec: splitAt, endSec: null, source: 'body_part2' },
            ];
            closePopover();
            _updateSubtitleTimeCell(idx);
            if (typeof showToast === 'function') showToast(`✅ 行 ${idx + 1}: 前${splitAt}s上半段 → 之后下半段`, 'success');
        } catch (err) {
            console.error('[SubtitleTimeSlice] error:', err);
            closePopover();
        }
    };

    pop.querySelector('#rbt-subtime-apply').addEventListener('click', applyAndClose);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') applyAndClose();
        if (e.key === 'Escape') closePopover();
    });

    // 点击外部关闭
    setTimeout(() => {
        closeHandler = (e) => {
            if (!pop.contains(e.target)) {
                closePopover();
            }
        };
        document.addEventListener('mousedown', closeHandler);
    }, 100);
}

// ═══════════════════════════════════════════════════════
// ✂️ Trim Modal — 裁切区间编辑弹窗
// ═══════════════════════════════════════════════════════

function _showTrimModal(idx) {
    const state = window._reelsState;
    const task = state.tasks[idx];
    if (!task) return;

    // Remove existing
    const existing = document.getElementById('rbt-trim-modal');
    if (existing) existing.remove();

    const trimStart = task.contentVideoTrimStart != null ? task.contentVideoTrimStart : '';
    const trimEnd = task.contentVideoTrimEnd != null ? task.contentVideoTrimEnd : '';
    const cvPath = task.contentVideoPath || task.bgPath || '';
    const cvName = cvPath ? cvPath.split('/').pop().split('\\').pop() : '(未选择视频)';

    const overlay = document.createElement('div');
    overlay.id = 'rbt-trim-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);';

    overlay.innerHTML = `
    <div style="background:#1a1a2e;border:1px solid #333;border-radius:14px;padding:24px;min-width:400px;max-width:520px;box-shadow:0 20px 60px rgba(0,0,0,0.8);">
        <div style="font-size:15px;font-weight:700;color:#eee;margin-bottom:16px;display:flex;align-items:center;gap:8px;">
            ✂️ 片段裁切设置
            <span style="font-size:11px;color:#666;font-weight:400;margin-left:auto;">#${idx + 1}</span>
        </div>
        <div style="font-size:11px;color:#888;margin-bottom:16px;padding:8px;background:#141420;border-radius:6px;word-break:break-all;">
            🎬 ${_escHtml(cvName)}
        </div>

        <div style="display:flex;gap:12px;margin-bottom:16px;">
            <div style="flex:1;">
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">入点 (秒)</label>
                <input type="number" id="rbt-trim-start" value="${trimStart}" min="0" step="0.1"
                    placeholder="留空=从头"
                    style="width:100%;padding:8px 10px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:14px;font-family:monospace;">
            </div>
            <div style="flex:1;">
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">出点 (秒)</label>
                <input type="number" id="rbt-trim-end" value="${trimEnd}" min="0" step="0.1"
                    placeholder="留空=到结尾"
                    style="width:100%;padding:8px 10px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:14px;font-family:monospace;">
            </div>
        </div>

        <div style="font-size:11px;color:#666;margin-bottom:16px;line-height:1.5;">
            💡 支持秒数 (如 5.2) 或时码格式 (01:30.5)。留空表示不裁切该端点。
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="rbt-trim-clear" style="padding:8px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#f87171;cursor:pointer;font-size:12px;">
                🗑 清除裁切
            </button>
            <button id="rbt-trim-cancel" style="padding:8px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;font-size:12px;">
                取消
            </button>
            <button id="rbt-trim-save" style="padding:8px 20px;border-radius:6px;border:none;background:#4c9eff;color:#000;cursor:pointer;font-size:12px;font-weight:600;">
                ✅ 保存
            </button>
        </div>
    </div>`;

    document.body.appendChild(overlay);

    // Parse time string (supports seconds and MM:SS.s format)
    const parseTime = (str) => {
        if (!str || str.trim() === '') return null;
        str = str.trim();
        // MM:SS.sss
        const parts = str.split(':');
        if (parts.length === 2) {
            return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
        }
        // HH:MM:SS
        if (parts.length === 3) {
            return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        }
        return parseFloat(str);
    };

    overlay.querySelector('#rbt-trim-save').addEventListener('click', () => {
        const s = parseTime(overlay.querySelector('#rbt-trim-start').value);
        const e = parseTime(overlay.querySelector('#rbt-trim-end').value);
        task.contentVideoTrimStart = (s != null && !isNaN(s)) ? s : null;
        task.contentVideoTrimEnd = (e != null && !isNaN(e)) ? e : null;
        overlay.remove();
        _renderBatchTable();
    });

    overlay.querySelector('#rbt-trim-clear').addEventListener('click', () => {
        task.contentVideoTrimStart = null;
        task.contentVideoTrimEnd = null;
        overlay.remove();
        _renderBatchTable();
    });

    overlay.querySelector('#rbt-trim-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // Auto focus
    setTimeout(() => overlay.querySelector('#rbt-trim-start')?.focus(), 100);
}

function _showCropModal(idx) {
    const state = window._reelsState;
    const task = state.tasks[idx];
    if (!task) return;

    // Remove existing
    const existing = document.getElementById('rbt-crop-modal');
    if (existing) existing.remove();

    // Default crop is 0,0,100,100
    const originalCrop = task.contentVideoCrop || '';

    const cvPath = task.contentVideoPath || '';
    const cvName = cvPath ? cvPath.split('/').pop().split('\\').pop() : '(未选择视频)';

    let cropVal = task.contentVideoCrop || '0,0,100,100';
    let parts = cropVal.split(',').map(p => parseFloat(p.trim()));
    if (parts.length !== 4 || parts.some(isNaN)) {
        parts = [0, 0, 100, 100];
    }
    const [cLeft, cTop, cWidth, cHeight] = parts;

    const overlay = document.createElement('div');
    overlay.id = 'rbt-crop-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);';

    overlay.innerHTML = `
    <div style="background:#1a1a2e;border:1px solid #333;border-radius:14px;padding:24px;min-width:400px;max-width:520px;box-shadow:0 20px 60px rgba(0,0,0,0.8);color:#eee;">
        <div style="font-size:15px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:8px;">
            📐 视频画面裁切设置
            <span style="font-size:11px;color:#666;font-weight:400;margin-left:auto;">#${idx + 1}</span>
        </div>
        <div style="font-size:11px;color:#888;margin-bottom:16px;padding:8px;background:#141420;border-radius:6px;word-break:break-all;">
            🎬 ${_escHtml(cvName)}
        </div>

        <!-- 比例快捷键 -->
        <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:16px; align-items:center;">
            <span style="font-size:11px;color:#888;margin-right:4px;">比例快捷键:</span>
            <button class="rbt-crop-preset-btn" data-preset="full" style="padding:2px 6px;font-size:10px;background:#333;border:1px solid #555;color:#eee;border-radius:4px;cursor:pointer;">全画面</button>
            <button class="rbt-crop-preset-btn" data-preset="16_9" style="padding:2px 6px;font-size:10px;background:#333;border:1px solid #555;color:#eee;border-radius:4px;cursor:pointer;">居中 16:9</button>
            <button class="rbt-crop-preset-btn" data-preset="4_5" style="padding:2px 6px;font-size:10px;background:#333;border:1px solid #555;color:#eee;border-radius:4px;cursor:pointer;">居中 4:5</button>
            <button class="rbt-crop-preset-btn" data-preset="1_1" style="padding:2px 6px;font-size:10px;background:#333;border:1px solid #555;color:#eee;border-radius:4px;cursor:pointer;">居中 1:1</button>
            <button class="rbt-crop-preset-btn" data-preset="9_16" style="padding:2px 6px;font-size:10px;background:#333;border:1px solid #555;color:#eee;border-radius:4px;cursor:pointer;">居中 9:16</button>
            <button class="rbt-crop-preset-btn" data-preset="1_2" style="padding:2px 6px;font-size:10px;background:#333;border:1px solid #555;color:#eee;border-radius:4px;cursor:pointer;">居中 1:2</button>
            <button class="rbt-crop-preset-btn" data-preset="half_height" style="padding:2px 6px;font-size:10px;background:#333;border:1px solid #555;color:#eee;border-radius:4px;cursor:pointer;">1/2 高度</button>
        </div>

        <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:16px;">
            <div>
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">左边界 Left (%)</label>
                <div style="display:flex;gap:10px;align-items:center;">
                    <input type="range" id="rbt-crop-left-range" min="0" max="100" value="${cLeft}" style="flex:1;">
                    <input type="number" id="rbt-crop-left" value="${cLeft}" min="0" max="100" step="1"
                        style="width:55px;padding:4px 6px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:12px;font-family:monospace;text-align:center;">
                </div>
            </div>
            <div>
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">上边界 Top (%)</label>
                <div style="display:flex;gap:10px;align-items:center;">
                    <input type="range" id="rbt-crop-top-range" min="0" max="100" value="${cTop}" style="flex:1;">
                    <input type="number" id="rbt-crop-top" value="${cTop}" min="0" max="100" step="1"
                        style="width:55px;padding:4px 6px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:12px;font-family:monospace;text-align:center;">
                </div>
            </div>
            <div>
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">宽度 Width (%)</label>
                <div style="display:flex;gap:10px;align-items:center;">
                    <input type="range" id="rbt-crop-width-range" min="1" max="100" value="${cWidth}" style="flex:1;">
                    <input type="number" id="rbt-crop-width" value="${cWidth}" min="1" max="100" step="1"
                        style="width:55px;padding:4px 6px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:12px;font-family:monospace;text-align:center;">
                </div>
            </div>
            <div>
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">高度 Height (%)</label>
                <div style="display:flex;gap:10px;align-items:center;">
                    <input type="range" id="rbt-crop-height-range" min="1" max="100" value="${cHeight}" style="flex:1;">
                    <input type="number" id="rbt-crop-height" value="${cHeight}" min="1" max="100" step="1"
                        style="width:55px;padding:4px 6px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:12px;font-family:monospace;text-align:center;">
                </div>
            </div>
        </div>

        <div style="font-size:11px;color:#666;margin-bottom:16px;line-height:1.5;">
            💡 画面裁切基于百分比计算（0~100）。<br>
            例如：左=10, 上=10, 宽=80, 高=80，表示裁剪中间 80% 的区域。<br>
            毛玻璃背景和中间清晰层均会基于此裁切后的画面进行渲染。
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="rbt-crop-clear" style="padding:8px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#f87171;cursor:pointer;font-size:12px;">
                🗑 清除裁切
            </button>
            <button id="rbt-crop-cancel" style="padding:8px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;font-size:12px;">
                取消
            </button>
            <button id="rbt-crop-save" style="padding:8px 20px;border-radius:6px;border:none;background:#4c9eff;color:#000;cursor:pointer;font-size:12px;font-weight:600;">
                ✅ 保存
            </button>
        </div>
    </div>`;

    document.body.appendChild(overlay);

    const leftRange = overlay.querySelector('#rbt-crop-left-range');
    const leftNum = overlay.querySelector('#rbt-crop-left');
    const topRange = overlay.querySelector('#rbt-crop-top-range');
    const topNum = overlay.querySelector('#rbt-crop-top');
    const widthRange = overlay.querySelector('#rbt-crop-width-range');
    const widthNum = overlay.querySelector('#rbt-crop-width');
    const heightRange = overlay.querySelector('#rbt-crop-height-range');
    const heightNum = overlay.querySelector('#rbt-crop-height');

    const _syncCropAndPreview = () => {
        const l = parseFloat(leftNum.value) || 0;
        const t = parseFloat(topNum.value) || 0;
        const w = parseFloat(widthNum.value) || 100;
        const h = parseFloat(heightNum.value) || 100;
        task.contentVideoCrop = `${l},${t},${w},${h}`;
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    };

    leftRange.addEventListener('input', (e) => { leftNum.value = e.target.value; _syncCropAndPreview(); });
    leftNum.addEventListener('input', (e) => { leftRange.value = e.target.value; _syncCropAndPreview(); });

    topRange.addEventListener('input', (e) => { topNum.value = e.target.value; _syncCropAndPreview(); });
    topNum.addEventListener('input', (e) => { topRange.value = e.target.value; _syncCropAndPreview(); });

    widthRange.addEventListener('input', (e) => { widthNum.value = e.target.value; _syncCropAndPreview(); });
    widthNum.addEventListener('input', (e) => { widthRange.value = e.target.value; _syncCropAndPreview(); });

    heightRange.addEventListener('input', (e) => { heightNum.value = e.target.value; _syncCropAndPreview(); });
    heightNum.addEventListener('input', (e) => { heightRange.value = e.target.value; _syncCropAndPreview(); });

    overlay.querySelectorAll('.rbt-crop-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const preset = btn.getAttribute('data-preset');
            let left = 0, top = 0, width = 100, height = 100;

            if (preset === 'full') {
                left = 0; top = 0; width = 100; height = 100;
            } else if (preset === 'half_height') {
                left = 0; top = 25; width = 100; height = 50;
            } else {
                let targetRatio = 16/9;
                if (preset === '16_9') targetRatio = 16 / 9;
                else if (preset === '4_5') targetRatio = 4 / 5;
                else if (preset === '1_1') targetRatio = 1 / 1;
                else if (preset === '9_16') targetRatio = 9 / 16;
                else if (preset === '1_2') targetRatio = 1 / 2;

                let srcW = 1080, srcH = 1920;
                const v2Dimensions = window.ReelsPreviewV2?.isOpen?.()
                    ? window.ReelsPreviewV2.getContentDimensions?.()
                    : null;
                const cvVideo = document.getElementById('reels-preview-contentvideo');
                const img = window._reelsState.previewContentImage;
                const seq = window._reelsState.cvSequence;

                if (v2Dimensions?.width > 0 && v2Dimensions?.height > 0) {
                    srcW = v2Dimensions.width;
                    srcH = v2Dimensions.height;
                } else if (cvVideo && cvVideo.videoWidth > 0) {
                    srcW = cvVideo.videoWidth;
                    srcH = cvVideo.videoHeight;
                } else if (img && img.naturalWidth > 0) {
                    srcW = img.naturalWidth;
                    srcH = img.naturalHeight;
                } else if (seq && seq.files && seq.files.length > 0) {
                    const firstFile = seq.files[0];
                    const firstImg = seq.loadedImages?.[firstFile];
                    if (firstImg && firstImg.naturalWidth > 0) {
                        srcW = firstImg.naturalWidth;
                        srcH = firstImg.naturalHeight;
                    }
                } else {
                    const renderer = window._reelsState.renderer;
                    if (renderer && renderer.canvas) {
                        srcW = renderer.canvas.width;
                        srcH = renderer.canvas.height;
                    }
                }

                const srcRatio = srcW / srcH;
                if (targetRatio > srcRatio) {
                    const newH = srcW / targetRatio;
                    const hPct = Math.round((newH / srcH) * 100);
                    left = 0;
                    width = 100;
                    height = Math.max(1, Math.min(100, hPct));
                    top = Math.round((100 - height) / 2);
                } else {
                    const newW = srcH * targetRatio;
                    const wPct = Math.round((newW / srcW) * 100);
                    top = 0;
                    height = 100;
                    width = Math.max(1, Math.min(100, wPct));
                    left = Math.round((100 - width) / 2);
                }
            }

            leftNum.value = left;
            leftRange.value = left;
            topNum.value = top;
            topRange.value = top;
            widthNum.value = width;
            widthRange.value = width;
            heightNum.value = height;
            heightRange.value = height;

            _syncCropAndPreview();
        });
    });

    overlay.querySelector('#rbt-crop-save').addEventListener('click', () => {
        const l = parseFloat(leftNum.value) || 0;
        const t = parseFloat(topNum.value) || 0;
        const w = parseFloat(widthNum.value) || 100;
        const h = parseFloat(heightNum.value) || 100;
        task.contentVideoCrop = `${l},${t},${w},${h}`;
        overlay.remove();
        _renderBatchTable();
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
        if (idx === window._reelsState.selectedIdx && window.reelsSyncBackgroundTabUI) {
            window.reelsSyncBackgroundTabUI(task);
        }
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    });

    overlay.querySelector('#rbt-crop-clear').addEventListener('click', () => {
        task.contentVideoCrop = '';
        overlay.remove();
        _renderBatchTable();
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
        if (idx === window._reelsState.selectedIdx && window.reelsSyncBackgroundTabUI) {
            window.reelsSyncBackgroundTabUI(task);
        }
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    });

    const _restoreAndClose = () => {
        task.contentVideoCrop = originalCrop;
        overlay.remove();
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
        if (idx === window._reelsState.selectedIdx && window.reelsSyncBackgroundTabUI) {
            window.reelsSyncBackgroundTabUI(task);
        }
    };

    overlay.querySelector('#rbt-crop-cancel').addEventListener('click', _restoreAndClose);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) _restoreAndClose(); });

    setTimeout(() => leftNum?.focus(), 100);
}

// ═══════════════════════════════════════════════════════
// ✂️ Clip A/B Paste Modal — 剪辑文案双版本粘贴
// ═══════════════════════════════════════════════════════

function _showClipAbPasteModal() {
    const existing = document.getElementById('rbt-clip-ab-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'rbt-clip-ab-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);';

    const presetBgA = localStorage.getItem('rbt_clip_bg_preset_a') || '';
    const presetBgB = localStorage.getItem('rbt_clip_bg_preset_b') || '';
    const presetCvMode = localStorage.getItem('rbt_clip_cv_mode') || 'single';
    const presetCvPath = localStorage.getItem('rbt_clip_cv_preset') || '';
    const lastPresetA = localStorage.getItem('rbt_clip_overlay_preset_a') || '';
    const lastPresetB = localStorage.getItem('rbt_clip_overlay_preset_b') || '';

    let presetsMap = {};
    try { presetsMap = JSON.parse(_rbtReadOverlayGroupPresetsRaw() || '{}'); } catch (e) {}
    if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) presetsMap = { ...window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS, ...presetsMap };
    let presetOptionsHtmlA = '';
    let presetOptionsHtmlB = '';
    for (const p of Object.keys(presetsMap)) {
        presetOptionsHtmlA += `<option value="${_escHtml(p)}" ${p === lastPresetA ? 'selected' : ''}>${_escHtml(p)}</option>`;
        presetOptionsHtmlB += `<option value="${_escHtml(p)}" ${p === lastPresetB ? 'selected' : ''}>${_escHtml(p)}</option>`;
    }

    overlay.innerHTML = `
    <div style="background:#1a1a2e;border:1px solid #333;border-radius:14px;padding:28px;width:950px;max-height:85vh;box-shadow:0 20px 60px rgba(0,0,0,0.8);display:flex;flex-direction:column;">
        <div style="font-size:16px;font-weight:700;color:#eee;margin-bottom:4px;">✂️ 批量 A/B 混剪模式：智能任务提取</div>
        <div style="font-size:11px;color:#888;margin-bottom:12px;line-height:1.6;">
            直接从谷歌表格复制粘贴，列顺序：<code style="background:#222;padding:2px 6px;border-radius:3px;color:#b8a0ff;">视频名称  片段名称  时间段  A标题  A正文  B标题  B正文(上半段)  B正文(下半段,选填)</code><br>
            • 每行自动衍生 <strong style="color:#4c9eff">A版 + B版</strong> 两个任务。若填写了B正文下半段，B版将自动开启10秒分段模式。
        </div>

        <!-- 全局设定区 -->
        <div style="display:flex;gap:12px;margin-bottom:12px;background:#13131c;padding:12px;border-radius:8px;border:1px solid #2a2a3a;">
            <div style="flex:1;">
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">🎨 A版固定背景 (<span style="color:#a78bfa;cursor:pointer;" title="双击打开文件选择器">双击</span> 或拖拽 选文件)</label>
                <input type="text" id="rbt-clip-bg-a" value="${presetBgA}" placeholder="A版统一背景图片/视频 (可留空)"
                    style="width:100%;padding:6px 10px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:12px;">
                <label style="font-size:11px;color:#888;display:block;margin:8px 0 4px 0;">✨ A版自动套用文字排版预设</label>
                <select id="rbt-clip-preset-a" style="width:100%;padding:6px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:12px;">
                    <option value="">(不使用预设，生成素颜基础字幕)</option>
                    ${presetOptionsHtmlA}
                </select>
            </div>
            <div style="flex:1;">
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">🎨 B版固定背景 (<span style="color:#4c9eff;cursor:pointer;" title="双击打开文件选择器">双击</span> 或拖拽 选文件)</label>
                <input type="text" id="rbt-clip-bg-b" value="${presetBgB}" placeholder="B版统一背景图片/视频 (可留空)"
                    style="width:100%;padding:6px 10px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:12px;">
                <label style="font-size:11px;color:#888;display:block;margin:8px 0 4px 0;">✨ B版自动套用文字排版预设</label>
                <select id="rbt-clip-preset-b" style="width:100%;padding:6px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:12px;">
                    <option value="">(不使用预设，生成素颜基础字幕)</option>
                    ${presetOptionsHtmlB}
                </select>
            </div>
        </div>

        <div style="background:#13131c;padding:12px;border-radius:8px;border:1px dashed #444;margin-bottom:16px;">
            <div style="display:flex;align-items:center;margin-bottom:6px;gap:16px;">
                 <label style="font-size:11px;color:#ccc;font-weight:600;">📹 内容视频素材及裁切/缩放设置：</label>
                 <label style="font-size:11px;color:#aaa;cursor:pointer;display:flex;align-items:center;gap:4px;">
                     <input type="radio" name="clip_cv_mode" value="single" ${presetCvMode === 'single' ? 'checked' : ''} style="accent-color:var(--accent);">
                     单视频使用同一素材 (名称列若填入 '00:10-00:20' 则自动应用为裁切入出点)
                 </label>
                 <label style="font-size:11px;color:#aaa;cursor:pointer;display:flex;align-items:center;gap:4px;">
                     <input type="radio" name="clip_cv_mode" value="multi" ${presetCvMode === 'multi' ? 'checked' : ''} style="accent-color:var(--accent);">
                     多视频素材夹 (每行按顺序指派)
                 </label>
            </div>
            <div style="display:flex;gap:12px;align-items:center;">
                <input type="text" id="rbt-clip-cv-path" value="${presetCvPath}" placeholder="请选择单视频文件 或 包含多个视频的文件夹..."
                    style="flex:1;padding:6px 10px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:12px;">
                <button id="rbt-clip-cv-btn" style="padding:4px 12px;border-radius:6px;border:1px solid #555;background:transparent;color:#bbb;cursor:pointer;font-size:11px;white-space:nowrap;">📁 浏览</button>
                <div style="width:1px;height:14px;background:#444;margin:0 4px;"></div>
                <label style="font-size:11px;color:#bbb;white-space:nowrap;">缩放比例</label>
                <input type="number" id="rbt-clip-cv-scale" value="104" min="10" max="500"
                    style="width:50px;padding:4px;background:#141420;border:1px solid #333;border-radius:4px;color:#eee;font-size:11px;text-align:center;">
                <label style="font-size:11px;color:#bbb;">%</label>
                <div style="width:1px;height:14px;background:#444;margin:0 4px;"></div>
                <label style="font-size:11px;color:#bbb;white-space:nowrap;">Y位置</label>
                <input type="number" id="rbt-clip-cv-y" value="-54" min="-1000" max="1000"
                    style="width:55px;padding:4px;background:#141420;border:1px solid #333;border-radius:4px;color:#eee;font-size:11px;text-align:center;">
                <label style="font-size:11px;color:#bbb;">px</label>
            </div>
        </div>

        <div style="display:flex;gap:16px;flex:1;min-height:300px;margin-bottom:16px;">
            <div style="flex:1.2;display:flex;flex-direction:column;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                    <label style="font-size:11px;color:#888;">📋 1. 从谷歌表格直接粘贴到下方表格</label>
                    <button id="rbt-clip-ab-clear" style="padding:2px 8px;border-radius:4px;border:1px solid #555;background:transparent;color:#888;cursor:pointer;font-size:10px;">清空</button>
                </div>
                <div style="flex:1;overflow-y:auto;background:#0d0d16;border:1px solid #333;border-radius:8px;">
                    <table id="rbt-clip-ab-table" style="width:100%;border-collapse:collapse;font-size:11px;table-layout:fixed;">
                        <thead><tr style="background:#1a1a2e;position:sticky;top:0;z-index:2;">
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#a78bfa;width:80px;">视频名称</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#a78bfa;width:70px;">片段名称</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#a78bfa;width:70px;">时间段</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#e879a8;">A标题</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#e879a8;">A正文</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#4c9eff;">B标题</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#4c9eff;">B正文上</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#4c9eff;">B正文下</th>
                        </tr></thead>
                        <tbody id="rbt-clip-ab-tbody"></tbody>
                    </table>
                </div>
                <textarea id="rbt-clip-ab-area" style="position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;"></textarea>
            </div>
            <div style="flex:0.8;display:flex;flex-direction:column;">
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">👁️ 2. 预览最终生成的A/B任务</label>
                <div id="rbt-clip-ab-preview" style="flex:1;background:#0d0d16;border:1px dashed #444;border-radius:8px;padding:8px;overflow-y:auto;font-size:11px;line-height:1.5;">
                    <div style="color:#666;text-align:center;padding:20px;">等待粘贴数据...</div>
                </div>
            </div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
            <button id="rbt-clip-ab-cancel" style="padding:8px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;font-size:12px;">取消</button>
            <button id="rbt-clip-ab-import" style="padding:8px 30px;border-radius:6px;border:none;background:#7c5cff;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">📥 预览无误，立即生成到任务区</button>
        </div>
    </div>`;

    document.body.appendChild(overlay);

    // ── 表格数据模型 ──
    let _tableData = []; // [{videoName, clipName, timeRange, aTitle, aBody, bTitle, bBody, bBody2}]
    const COL_KEYS = ['videoName', 'clipName', 'timeRange', 'aTitle', 'aBody', 'bTitle', 'bBody', 'bBody2'];

    function _ensureMinRows(n) {
        while (_tableData.length < n) _tableData.push({ videoName: '', clipName: '', timeRange: '', aTitle: '', aBody: '', bTitle: '', bBody: '', bBody2: '' });
    }
    _ensureMinRows(5);

    function _renderTable() {
        const tbody = overlay.querySelector('#rbt-clip-ab-tbody');
        if (!tbody) return;
        _ensureMinRows(Math.max(5, _tableData.length + 2));
        const cellStyle = 'padding:4px 5px;border-bottom:1px solid #222;color:#ddd;outline:none;background:transparent;';
        let html = '';
        for (let r = 0; r < _tableData.length; r++) {
            const row = _tableData[r];
            const hasData = COL_KEYS.some(k => row[k]);
            const rowBg = hasData ? '#141420' : '#0d0d16';
            html += `<tr style="background:${rowBg};">`;
            for (let c = 0; c < COL_KEYS.length; c++) {
                html += `<td contenteditable="true" data-r="${r}" data-c="${c}" style="${cellStyle}">${_escHtml(row[COL_KEYS[c]] || '')}</td>`;
            }
            html += '</tr>';
        }
        tbody.innerHTML = html;
        // 绑定单元格编辑事件
        tbody.querySelectorAll('td[contenteditable]').forEach(td => {
            td.addEventListener('input', () => {
                const r = parseInt(td.dataset.r), c = parseInt(td.dataset.c);
                _tableData[r][COL_KEYS[c]] = td.textContent;
                _syncToHiddenArea();
                _renderAbPreview();
            });
        });
    }

    // 同步表格数据到隐藏 textarea（供导入用）
    function _syncToHiddenArea() {
        const area = overlay.querySelector('#rbt-clip-ab-area');
        if (!area) return;
        area.value = _tableData
            .filter(row => COL_KEYS.some(k => row[k]))
            .map(row => COL_KEYS.map(k => row[k] || '').join('\t'))
            .join('\n');
    }

    // ── 粘贴拦截（支持 Google Sheets 格式，含引号内换行）──
    function _parseTSV(text) {
        // Google Sheets 粘贴：引号内的换行不算行分隔符
        const rows = [];
        let row = [];
        let cell = '';
        let inQuote = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inQuote) {
                if (ch === '"' && text[i + 1] === '"') {
                    cell += '"'; i++; // 转义引号
                } else if (ch === '"') {
                    inQuote = false;
                } else {
                    cell += ch;
                }
            } else {
                if (ch === '"') {
                    inQuote = true;
                } else if (ch === '\t') {
                    row.push(cell.trim()); cell = '';
                } else if (ch === '\n' || ch === '\r') {
                    if (ch === '\r' && text[i + 1] === '\n') i++;
                    row.push(cell.trim()); cell = '';
                    if (row.some(c => c)) rows.push(row);
                    row = [];
                } else {
                    cell += ch;
                }
            }
        }
        row.push(cell.trim());
        if (row.some(c => c)) rows.push(row);
        return rows;
    }

    function _handlePaste(e) {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        if (!text) return;
        const lines = _parseTSV(text);
        // 检测是否含有表头行（跳过）
        let startIdx = 0;
        if (lines.length > 1) {
            const firstLine = lines[0].join(' ').toLowerCase();
            if (firstLine.includes('标题') || firstLine.includes('名称') || firstLine.includes('title') || firstLine.includes('name')) {
                startIdx = 1;
            }
        }
        // 确定是追加还是替换
        const target = e.target;
        let insertRow = 0;
        if (target && target.dataset && target.dataset.r !== undefined) {
            insertRow = parseInt(target.dataset.r);
        }
        // 如果从第0行粘贴且表格是空的，直接替换
        const isTableEmpty = !_tableData.some(row => COL_KEYS.some(k => row[k]));
        if (isTableEmpty) insertRow = 0;

        for (let i = startIdx; i < lines.length; i++) {
            const cols = lines[i]; // 已经是数组
            const rowIdx = insertRow + (i - startIdx);
            _ensureMinRows(rowIdx + 1);
            for (let c = 0; c < Math.min(cols.length, COL_KEYS.length); c++) {
                // 保留单元格内换行，替换为空格显示
                _tableData[rowIdx][COL_KEYS[c]] = (cols[c] || '').replace(/[\r\n]+/g, ' ').trim();
            }
        }
        _ensureMinRows(_tableData.length + 2);
        _renderTable();
        _syncToHiddenArea();
        _renderAbPreview();
    }

    function _renderAbPreview() {
        const previewEl = overlay.querySelector('#rbt-clip-ab-preview');
        const dataRows = _tableData.filter(row => COL_KEYS.some(k => row[k]));

        if (dataRows.length === 0) {
            previewEl.innerHTML = '<div style="color:#666;text-align:center;padding:20px;">等待粘贴数据...</div>';
            return;
        }

        let html = '<table style="width:100%;border-collapse:collapse;color:#ccc;table-layout:fixed;border-radius:4px;overflow:hidden;box-shadow:0 0 0 1px #333;">';
        html += '<tr style="background:#222;position:sticky;top:0;"><th style="padding:4px 6px;border-bottom:1px solid #444;width:35px;">版</th><th style="padding:4px 6px;border-bottom:1px solid #444;width:80px;">名称</th><th style="padding:4px 6px;border-bottom:1px solid #444;width:60px;">时间</th><th style="padding:4px 6px;border-bottom:1px solid #444;text-align:left;">文案内容</th></tr>';

        for (let i = 0; i < Math.min(dataRows.length, 30); i++) {
            const row = dataRows[i];
            const clipName = row.clipName || row.videoName || `clip_${i + 1}`;
            const timeStr = row.timeRange ? `<span style="color:#888;">${_escHtml(row.timeRange)}</span>` : '';

            let aTitle = row.aTitle ? `<strong style="color:#ccc;">${_escHtml(row.aTitle)}</strong>` : '';
            let aBody = row.aBody ? `<span style="color:#aaa;">${_escHtml(row.aBody)}</span>` : '';
            let bTitle = row.bTitle ? `<strong style="color:#ccc;">${_escHtml(row.bTitle)}</strong>` : '';
            let bBody = row.bBody ? `<span style="color:#aaa;">${_escHtml(row.bBody)}</span>` : '';
            let bBody2 = row.bBody2 ? `<span style="color:#f59e0b;font-size:10px;">[10s切换]</span> <span style="color:#aaa;">${_escHtml(row.bBody2)}</span>` : '';

            if (aTitle || aBody) {
                html += `<tr style="background:#1a1a24;"><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;color:#a78bfa;font-weight:bold;text-align:center;">A</td><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;word-break:break-all;color:#ccc;">${_escHtml(clipName)}_A</td><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;">${timeStr}</td><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;word-break:break-word;">${[aTitle, aBody].filter(Boolean).join(' <span style="color:#555">|</span> ')}</td></tr>`;
            }
            if (bTitle || bBody || bBody2) {
                let finalBBody = bBody;
                if (bBody2) finalBBody += ' ' + bBody2;
                html += `<tr style="background:#141a24;"><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;color:#4c9eff;font-weight:bold;text-align:center;">B</td><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;word-break:break-all;color:#ccc;">${_escHtml(clipName)}_B</td><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;">${timeStr}</td><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;word-break:break-word;">${[bTitle, finalBBody].filter(Boolean).join(' <span style="color:#555">|</span> ')}</td></tr>`;
            }
        }
        html += '</table>';
        if (dataRows.length > 30) {
            html += `<div style="text-align:center;padding:8px;color:#888;font-size:11px;">(共 ${dataRows.length} 行，仅展示前 30 行)</div>`;
        }
        previewEl.innerHTML = html;
    }

    // 初始化表格
    _renderTable();
    // 在整个表格容器上拦截粘贴
    const tableContainer = overlay.querySelector('#rbt-clip-ab-table');
    if (tableContainer) tableContainer.addEventListener('paste', _handlePaste);
    // 清空按钮
    overlay.querySelector('#rbt-clip-ab-clear').addEventListener('click', () => {
        _tableData = [];
        _ensureMinRows(5);
        _renderTable();
        _syncToHiddenArea();
        _renderAbPreview();
    });

    function setupFileSelectPath(id) {
        const input = overlay.querySelector('#' + id);

        const triggerNativeDialog = async () => {
            if (window.require) {
                try {
                    const { dialog, getCurrentWindow } = window.require('@electron/remote');
                    const result = await dialog.showOpenDialog(getCurrentWindow(), {
                        title: '选择背景素材 (图片/视频 或 图片序列文件夹)',
                        properties: ['openFile', 'openDirectory']
                    });
                    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                        input.value = result.filePaths[0];
                        return true;
                    }
                    return result.canceled;
                } catch (e) {
                    console.warn('Native dialog failed, falling back', e);
                }
            }
            return false;
        };

        const triggerFallback = () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.mp4,.mov,.mkv,.png,.jpg,.jpeg';
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    const file = e.target.files[0];
                    let localPath = file.path;
                    if (!localPath && window.electronAPI && window.electronAPI.getFilePath) {
                        try { localPath = window.electronAPI.getFilePath(file); } catch (_) { }
                    }
                    input.value = localPath || file.name;
                }
            });
            fileInput.click();
        };

        input.addEventListener('dblclick', async () => {
            const handled = await triggerNativeDialog();
            if (handled === false) {
                triggerFallback();
            }
        });

        input.addEventListener('dragover', e => e.preventDefault());
        input.addEventListener('drop', e => {
            e.preventDefault();
            if (e.dataTransfer.files.length) {
                const file = e.dataTransfer.files[0];
                let localPath = file.path;
                if (!localPath && window.electronAPI && window.electronAPI.getFilePath) {
                    try { localPath = window.electronAPI.getFilePath(file); } catch (_) { }
                }
                input.value = localPath || file.name;
            }
        });
    }
    setupFileSelectPath('rbt-clip-bg-a');
    setupFileSelectPath('rbt-clip-bg-b');

    const cvInput = overlay.querySelector('#rbt-clip-cv-path');
    const cvModeRadios = overlay.querySelectorAll('input[name="clip_cv_mode"]');

    function updateCvBtnLabel() {
        const isMulti = document.querySelector('input[name="clip_cv_mode"]:checked').value === 'multi';
        overlay.querySelector('#rbt-clip-cv-btn').textContent = isMulti ? '📁 选择文件夹' : '🎬 选择视频文件';
    }
    cvModeRadios.forEach(r => r.addEventListener('change', updateCvBtnLabel));
    updateCvBtnLabel();

    overlay.querySelector('#rbt-clip-cv-btn').addEventListener('click', async () => {
        const isMulti = document.querySelector('input[name="clip_cv_mode"]:checked').value === 'multi';

        let handled = false;
        if (window.require) {
            try {
                const { dialog, getCurrentWindow } = window.require('@electron/remote');
                const result = await dialog.showOpenDialog(getCurrentWindow(), {
                    title: isMulti ? '选择需要批量映射的视频所在的文件夹' : '选择包含在每一个视频内容表层的唯一主文件(或图片序列文件夹)',
                    properties: isMulti ? ['openDirectory'] : ['openFile', 'openDirectory']
                });
                if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                    cvInput.value = result.filePaths[0];
                    handled = true;
                } else if (result.canceled) {
                    handled = true;
                }
            } catch (e) {
                console.warn('Native dialog failed for cv btn, falling back', e);
            }
        }

        if (!handled) {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            // standard <input type="file"> fallback requires webkitdirectory to pick a folder.
            // Since we want both in Single mode, we can't do both cleanly in raw HTML. We let desktop app handle it naturally via showOpenDialog.
            if (isMulti) {
                fileInput.webkitdirectory = true;
                fileInput.directory = true;
            } else {
                fileInput.accept = '.mp4,.mov,.mkv,.avi,.webm,.png,.jpg,.jpeg';
            }
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    const file = e.target.files[0];
                    let localPath = file.path;
                    if (!localPath && window.electronAPI && window.electronAPI.getFilePath) {
                        localPath = window.electronAPI.getFilePath(file);
                    }
                    if (isMulti && localPath) {
                        const path = window.require ? window.require('path') : null;
                        cvInput.value = path ? path.dirname(localPath) : localPath;
                    } else {
                        cvInput.value = localPath || file.name;
                    }
                }
            });
            fileInput.click();
        }
    });

    cvInput.addEventListener('dblclick', () => {
        overlay.querySelector('#rbt-clip-cv-btn').click();
    });
    cvInput.addEventListener('dragover', e => e.preventDefault());
    cvInput.addEventListener('drop', e => {
        e.preventDefault();
        if (e.dataTransfer.files.length) {
            const file = e.dataTransfer.files[0];
            let localPath = file.path;
            if (!localPath && window.electronAPI && window.electronAPI.getFilePath) {
                localPath = window.electronAPI.getFilePath(file);
            }
            cvInput.value = localPath || file.name;
        }
    });

    overlay.querySelector('#rbt-clip-ab-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#rbt-clip-ab-import').addEventListener('click', () => {
        const raw = overlay.querySelector('#rbt-clip-ab-area').value.trim();
        if (!raw) {
            if (typeof showToast === 'function') showToast('请粘贴文案数据', 'error');
            return;
        }

        const bgA = overlay.querySelector('#rbt-clip-bg-a').value.trim();
        const bgB = overlay.querySelector('#rbt-clip-bg-b').value.trim();
        const selPresetA = overlay.querySelector('#rbt-clip-preset-a').value;
        const selPresetB = overlay.querySelector('#rbt-clip-preset-b').value;
        const cvMode = document.querySelector('input[name="clip_cv_mode"]:checked').value;
        const cvPath = overlay.querySelector('#rbt-clip-cv-path').value.trim();
        const cvScale = parseInt(overlay.querySelector('#rbt-clip-cv-scale').value, 10) || 104;
        const cvY = overlay.querySelector('#rbt-clip-cv-y')?.value?.trim();
        const cvYValue = (cvY !== '' && cvY != null && !isNaN(parseInt(cvY))) ? parseInt(cvY, 10) : null;

        localStorage.setItem('rbt_clip_bg_preset_a', bgA);
        localStorage.setItem('rbt_clip_bg_preset_b', bgB);
        localStorage.setItem('rbt_clip_cv_mode', cvMode);
        localStorage.setItem('rbt_clip_cv_preset', cvPath);
        localStorage.setItem('rbt_clip_overlay_preset_a', selPresetA);
        localStorage.setItem('rbt_clip_overlay_preset_b', selPresetB);

        const state = window._reelsState;

        // 解析多视频文件夹逻辑
        let cvFiles = [];
        if (cvMode === 'multi' && cvPath && window.require) {
            try {
                const fs = window.require('fs');
                const path = window.require('path');
                if (fs.existsSync(cvPath) && fs.statSync(cvPath).isDirectory()) {
                    cvFiles = fs.readdirSync(cvPath).filter(f => !f.startsWith('.') && /\.(mp4|mov|mkv|wmv|avi|webm)$/i.test(f)).sort();
                    cvFiles = cvFiles.map(f => path.join(cvPath, f));
                }
            } catch (e) {
                console.warn('Failed to read folder for multi-video mode', e);
            }
        }

        const lines = raw.split('\n').filter(l => l.trim());
        let created = 0;

        // Clear trailing totally empty tasks so they are overwritten implicitly
        while (state.tasks.length > 0) {
            const last = state.tasks[state.tasks.length - 1];
            if (!last.videoPath && !last.audioPath && (!last.overlays || last.overlays.length === 0)) {
                state.tasks.pop();
            } else {
                break;
            }
        }

        // 时间解析 Helper
        function _parseTimeStr(str) {
            if (typeof window.parseBatchCutTime === 'function') return window.parseBatchCutTime(str);
            // 简单的回退解析 hh:mm:ss.ff
            const p = String(str).split(':');
            if (p.length === 3) return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
            if (p.length === 2) return parseFloat(p[0]) * 60 + parseFloat(p[1]);
            return parseFloat(p[0]) || null;
        }

        let validRowIndex = 0;
        for (const line of lines) {
            const cols = line.split('\t');
            if (cols.length < 3) continue;

            const rawName = (cols[0] || '').trim();
            let trimStart = null, trimEnd = null;
            let displayBaseName = rawName;

            // 7/8列: 视频名称(0) 片段名称(1) 时间段(2) A标题(3) A正文(4) B标题(5) B正文上(6) B正文下(7)
            const videoName = (cols[0] || '').trim();
            const clipName = (cols[1] || '').trim();
            const timeRange = (cols[2] || '').trim();
            const aTitle = (cols[3] || '').trim();
            const aBody = (cols[4] || '').trim();
            const bTitle = (cols[5] || '').trim();
            const bBody1 = (cols[6] || '').trim();
            const bBody2 = (cols[7] || '').trim();
            const bBodyCombined = bBody2 ? `${bBody1}\n\n${bBody2}` : bBody1;
            const aFooter = '';
            const bFooter = '';

            // 从时间段列提取裁切入出点
            if (timeRange) {
                const tMatch = timeRange.match(/^(.+?)\s*[-—~～]+\s*(.+)$/);
                if (tMatch) {
                    const ps1 = _parseTimeStr(tMatch[1].trim());
                    const ps2 = _parseTimeStr(tMatch[2].trim());
                    if (ps1 !== null && ps2 !== null) {
                        trimStart = ps1;
                        trimEnd = ps2;
                    }
                }
            }
            // 使用片段名称作为任务名，回退到视频名称
            displayBaseName = clipName || videoName || rawName;

            // 获取相应的 Content Video 路径
            let assignCvPath = '';
            if (cvMode === 'single') {
                assignCvPath = cvPath;
            } else if (cvMode === 'multi' && cvFiles.length > 0) {
                assignCvPath = cvFiles[validRowIndex % cvFiles.length];
            }

            // ── A ──
            const taskA = typeof _createEmptyTask === 'function' ? _createEmptyTask() : {};
            taskA.baseName = displayBaseName ? `${displayBaseName}_A` : `clip_${created + 1}_A`;
            taskA.fileName = taskA.baseName + '.mp4';
            taskA._version = 'A';
            if (bgA) { _setTaskSingleBackground(taskA, bgA); }
            if (assignCvPath) {
                taskA.contentVideoPath = assignCvPath;
                taskA.contentVideoScale = cvScale;
                if (cvYValue !== null) taskA.contentVideoY = cvYValue;
                if (trimStart !== null) taskA.contentVideoTrimStart = trimStart;
                if (trimEnd !== null) taskA.contentVideoTrimEnd = trimEnd;
            }

            if (aTitle || aBody || aFooter) {
                if (window.ReelsOverlay && window.ReelsOverlay.createTextCardOverlay) {
                    taskA.overlays = [window.ReelsOverlay.createTextCardOverlay({ title_text: aTitle, body_text: aBody, footer_text: aFooter, start: 0, end: 9999 })];
                } else {
                    taskA.overlays = [{ type: 'textcard', id: 'tc_' + Date.now() + '_a', title_text: aTitle, body_text: aBody, footer_text: aFooter, x: 85, y: 310, w: 910, h: 1300, start: 0, end: 9999 }];
                }
                
                if (selPresetA) {
                    taskA._overlayPresetName = selPresetA;
                    _applyAndVerifyOverlayGroupPresetToTask(taskA, selPresetA, { clearText: false });
                }

                state.tasks.push(taskA);
            }
            created++;

            // ── B ──
            if (bTitle || bBodyCombined || bFooter) {
                const taskB = typeof _createEmptyTask === 'function' ? _createEmptyTask() : {};
                taskB.baseName = displayBaseName ? `${displayBaseName}_B` : `clip_${created + 1}_B`;
                taskB.fileName = taskB.baseName + '.mp4';
                taskB._version = 'B';
                if (bgB) { _setTaskSingleBackground(taskB, bgB); }
                if (assignCvPath) {
                    taskB.contentVideoPath = assignCvPath;
                    taskB.contentVideoScale = cvScale;
                    if (cvYValue !== null) taskB.contentVideoY = cvYValue;
                    if (trimStart !== null) taskB.contentVideoTrimStart = trimStart;
                    if (trimEnd !== null) taskB.contentVideoTrimEnd = trimEnd;
                }

                if (bBody2) {
                    taskB.subtitleTimeMode = 'split';
                    taskB.subtitleTimeSlices = [
                        { label: 'A', startSec: 0, endSec: 10, source: 'body_part1' },
                        { label: 'B', startSec: 10, endSec: null, source: 'body_part2' },
                    ];
                }

                if (window.ReelsOverlay && window.ReelsOverlay.createTextCardOverlay) {
                    taskB.overlays = [window.ReelsOverlay.createTextCardOverlay({ title_text: bTitle, body_text: bBodyCombined, footer_text: bFooter, start: 10, end: 9999 })];
                } else {
                    taskB.overlays = [{ type: 'textcard', id: 'tc_' + Date.now() + '_b', title_text: bTitle, body_text: bBodyCombined, footer_text: bFooter, x: 85, y: 310, w: 910, h: 1300, start: 10, end: 9999 }];
                }

                if (selPresetB) {
                    taskB._overlayPresetName = selPresetB;
                    _applyAndVerifyOverlayGroupPresetToTask(taskB, selPresetB, { clearText: false });
                }

                // B版所有覆层统一从10s开始（导出达芬奇时间线用）
                if (Array.isArray(taskB.overlays)) {
                    taskB.overlays.forEach(ov => { ov.start = 10; });
                }

                taskB._version = 'B'; // 标记为 B 版，导出时自动拆分标题/正文
                state.tasks.push(taskB);
                created++;
            }

            validRowIndex++;
        }

        overlay.remove();
        _renderBatchTable();

        setTimeout(() => {
            const scroller = document.querySelector('#rbt-tbody-wrapper') || document.querySelector('.rbt-table-container');
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
        }, 100);

        if (typeof showToast === 'function') showToast(`✂️ 已生成 ${created} 行任务 (${validRowIndex} 个场景 × A/B 版本)`, 'success');
    });

    // Auto focus
    setTimeout(() => overlay.querySelector('#rbt-clip-ab-area')?.focus(), 100);
}

// Expose
window.reelsToggleBatchTable = reelsToggleBatchTable;

// ═══════════════════════════════════════════════════════
// Media Pool Sidebar — Event Binding (inline sidebar)
// ═══════════════════════════════════════════════════════

window._mediaPool = window._mediaPool || { items: [] };

function _bindMediaSidebarEvents(container) {
    const sidebar = container.querySelector('#rbt-media-sidebar');
    if (!sidebar) return; // sidebar not open

    // ── Active filter state ──
    let _activeFilter = 'all';

    // Hidden file inputs — NOT used anymore in Electron, kept as web fallback
    const hiddenFileInput = document.createElement('input');
    hiddenFileInput.type = 'file';
    hiddenFileInput.multiple = true;
    hiddenFileInput.style.display = 'none';

    const hiddenFolderInput = document.createElement('input');
    hiddenFolderInput.type = 'file';
    hiddenFolderInput.webkitdirectory = true;
    hiddenFolderInput.multiple = true;
    hiddenFolderInput.style.display = 'none';

    sidebar.appendChild(hiddenFileInput);
    sidebar.appendChild(hiddenFolderInput);

    const _renderPoolItems = () => {
        const poolEl = sidebar.querySelector('#rbt-ms-pool');
        if (!poolEl) return;
        const allItems = window._mediaPool.items || [];
        const items = _activeFilter === 'all' ? allItems : allItems.filter(it => {
            switch (_activeFilter) {
                case 'bg': return it.isVideo || it.isImage;
                case 'overlay': return it.isVideo || it.isImage || it.type === 'seq';
                case 'hook': return it.isVideo;
                case 'universal': return it.isVideo || it.isImage;
                case 'voice': return it.isAudio;
                case 'bgm': return it.isAudio;
                case 'text': return it.ext === 'srt' || it.ext === 'txt';
                default: return true;
            }
        });
        if (allItems.length === 0) {
            poolEl.innerHTML = '<div style="color:#555; font-size:12px; text-align:center; padding:20px 8px;">📥 拖拽文件到此处<br>或点击上方按钮导入</div>';
        } else if (items.length === 0) {
            poolEl.innerHTML = '<div style="color:#555; font-size:12px; text-align:center; padding:20px 8px;">当前分类下无素材</div>';
        } else {
            poolEl.innerHTML = items.map((it) => {
                const realIdx = allItems.indexOf(it);
                const urlObj = _rbtMediaUrl(it.path);
                const thumbHtml = it.isImage
                    ? `<img class="rbt-thumb-previewable" src="${_escHtml(urlObj)}" style="width:20px;height:20px;object-fit:cover;border-radius:2px;">`
                    : it.isVideo
                        ? `<video class="rbt-thumb-previewable" src="${_escHtml(urlObj)}#t=1" style="width:20px;height:20px;object-fit:cover;border-radius:2px;background:#000;"></video>`
                        : (it.type === 'seq' ? '🎞️' : it.isAudio ? '🎙' : '📄');

                return `
                <div class="rbt-ms-item" data-idx="${realIdx}" draggable="true" style="display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:4px; background:#1a1a2e; margin-bottom:3px; font-size:11px; color:#ccc; cursor:grab; transition: background 0.2s;" title="${_escHtml(it.path || it.name)}">
                    <span style="flex-shrink:0;">${thumbHtml}</span>
                    <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; pointer-events:none;">${_escHtml(it.name)}</span>
                    <span style="flex-shrink:0; font-size:9px; color:#666; pointer-events:none;">${it.role || ''}</span>
                    <button class="rbt-ms-remove" data-idx="${realIdx}" style="background:none; border:none; color:#666; cursor:pointer; font-size:10px; padding:0 2px;">✕</button>
                </div>`;
            }).join('');
        }
        const countEl = sidebar.querySelector('.rbt-ms-count');
        if (countEl) countEl.textContent = `(${allItems.length})`;
    };

    const _classifyFile = (name) => {
        const ext = (name || '').split('.').pop().toLowerCase();
        const videoExts = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm']);
        const imageExts = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff']);
        const audioExts = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma']);
        return {
            isVideo: videoExts.has(ext),
            isImage: imageExts.has(ext),
            isAudio: audioExts.has(ext),
            ext
        };
    };

    const _addFilesByPath = (filePaths) => {
        if (!filePaths || filePaths.length === 0) return;
        const pathMod = window.require ? window.require('path') : null;
        for (const fp of filePaths) {
            const name = pathMod ? pathMod.basename(fp) : fp.split(/[\\/]/).pop();
            const cls = _classifyFile(name);
            window._mediaPool.items.push({ name, path: fp, size: 0, file: null, type: 'file', role: '', ...cls });
        }
        _renderPoolItems();
        if (typeof showToast === 'function') showToast(`📥 已导入 ${filePaths.length} 个文件到素材池`, 'success');
        console.log(`[MediaPool] Ingested ${filePaths.length} files (abs path), pool size: ${window._mediaPool.items.length}`);
    };

    const handleFiles = (files) => {
        if (!files || files.length === 0) return;
        _addFilesByPath(Array.from(files).map(f => {
            const p = (typeof getFileNativePath === 'function') ? getFileNativePath(f) : (f.path || f.name);
            return p;
        }).filter(p => Boolean(p)));
    };

    hiddenFileInput.onchange = (e) => { handleFiles(Array.from(e.target.files)); e.target.value = ''; };
    hiddenFolderInput.onchange = (e) => { handleFiles(Array.from(e.target.files)); e.target.value = ''; };

    // ━━━ Import Files — native Electron dialog ━━━
    sidebar.querySelector('#rbt-ms-import-files')?.addEventListener('click', async () => {
        if (window.require) {
            try {
                const { dialog, getCurrentWindow } = window.require('@electron/remote');
                const result = await dialog.showOpenDialog(getCurrentWindow(), {
                    title: '选择素材文件',
                    properties: ['openFile', 'multiSelections'],
                    filters: [{ name: '媒体文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'srt', 'txt'] }]
                });
                if (!result.canceled && result.filePaths?.length > 0) _addFilesByPath(result.filePaths);
                return;
            } catch (e) { console.warn('[MediaPool] native dialog failed', e); }
        }
        hiddenFileInput.click();
    });

    // ━━━ Import Folder — native Electron dialog, flatten contents ━━━
    sidebar.querySelector('#rbt-ms-import-folder')?.addEventListener('click', async () => {
        if (window.require) {
            try {
                const { dialog, getCurrentWindow } = window.require('@electron/remote');
                const result = await dialog.showOpenDialog(getCurrentWindow(), {
                    title: '选择素材文件夹（拆散其中所有文件）',
                    properties: ['openDirectory']
                });
                if (!result.canceled && result.filePaths?.length > 0) {
                    const dirPath = result.filePaths[0];
                    const fs = window.require('fs');
                    const pathMod = window.require('path');
                    const allPaths = fs.readdirSync(dirPath)
                        .filter(f => !f.startsWith('.'))
                        .map(f => pathMod.join(dirPath, f))
                        .filter(fp => { try { return fs.statSync(fp).isFile(); } catch { return false; } });
                    if (allPaths.length > 0) _addFilesByPath(allPaths);
                    else if (typeof showToast === 'function') showToast('该文件夹中没有找到文件', 'warning');
                }
                return;
            } catch (e) { console.warn('[MediaPool] native folder dialog failed', e); }
        }
        hiddenFolderInput.click();
    });

    // ━━━ Import Material Groups — root folder contains task subfolders ━━━
    sidebar.querySelector('#rbt-ms-import-groups')?.addEventListener('click', () => {
        _selectAndImportMaterialGroupFolders({ mode: 'append' });
    });

    // ━━━ Sequence frame directory ━━━
    sidebar.querySelector('#rbt-ms-import-seq')?.addEventListener('click', async () => {
        if (window.require) {
            try {
                const { dialog, getCurrentWindow } = window.require('@electron/remote');
                const result = await dialog.showOpenDialog(getCurrentWindow(), {
                    title: '选择图片序列帧文件夹',
                    properties: ['openDirectory']
                });
                if (!result.canceled && result.filePaths?.length > 0) {
                    const dirPath = result.filePaths[0];
                    const dirName = dirPath.split(/[\\/]/).pop() || dirPath;
                    window._mediaPool.items.push({
                        name: dirName, path: dirPath, size: 0, file: null,
                        type: 'seq', role: '', isVideo: false, isImage: false, isAudio: false, ext: 'seq'
                    });
                    _renderPoolItems();
                    if (typeof showToast === 'function') showToast(`🎞️ 序列帧目录已入池: ${dirName}`, 'success');
                }
                return;
            } catch (e) { console.warn('[MediaPool] native seq dialog failed', e); }
        }
        if (typeof showToast === 'function') showToast('需在桌面应用中使用序列帧导入', 'warning');
    });

    // ━━━ Clear pool ━━━
    sidebar.querySelector('#rbt-ms-clear')?.addEventListener('click', () => {
        if (confirm('确定清空素材池？')) {
            window._mediaPool.items = [];
            _renderPoolItems();
        }
    });

    // ━━━ Apply Role button ━━━
    sidebar.querySelector('#rbt-ms-apply-bulk')?.addEventListener('click', () => {
        const roleSelect = sidebar.querySelector('#rbt-ms-bulk-role');
        const role = roleSelect ? roleSelect.value : '';
        if (!role) { if (typeof showToast === 'function') showToast('请先选择一个角色', 'warning'); return; }
        const allItems = window._mediaPool.items || [];
        const items = _activeFilter === 'all' ? allItems : allItems.filter(it => {
            switch (_activeFilter) {
                case 'bg': return it.isVideo || it.isImage;
                case 'overlay': return it.isVideo || it.isImage || it.type === 'seq';
                case 'hook': return it.isVideo;
                case 'voice': return it.isAudio;
                case 'bgm': return it.isAudio;
                case 'text': return it.ext === 'srt' || it.ext === 'txt';
                default: return true;
            }
        });
        if (items.length === 0) { if (typeof showToast === 'function') showToast('素材池为空（或当前分类下无素材）', 'warning'); return; }
        const tasks = window._reelsState?.tasks || [];
        if (tasks.length === 0) { if (typeof showToast === 'function') showToast('请先创建任务（行）', 'warning'); return; }
        let applied = 0;
        for (let i = 0; i < Math.min(items.length, tasks.length); i++) {
            const item = items[i], task = tasks[i];
            switch (role) {
                case 'bg': _setTaskSingleBackground(task, item.path, { clearBgSrcUrl: true }); applied++; break;
                case 'overlay': task.contentVideoPath = item.path; applied++; break;
                case 'hook':
                    if (!task.hook) task.hook = {};
                    task.hook.enabled = true;
                    task.hook.path = item.path;
                    task.hookFile = item.path;
                    applied++;
                    break;
                case 'universal': _setTaskSingleBackground(task, item.path); applied++; break;
                case 'voice': task.audioPath = item.path; applied++; break;
                case 'bgm': task.bgmPath = item.path; applied++; break;
            }
            item.role = role;
        }
        if (applied > 0) {
            _renderBatchTable();
            const roleLabels = { bg: '背景素材', overlay: '内容视频', hook: '前置Hook', universal: '通用', voice: '人声-音频文件', bgm: '配乐' };
            if (typeof showToast === 'function') showToast(`✅ 已将 ${applied} 个素材按「${roleLabels[role] || role}」角色依次分配到前 ${applied} 行`, 'success');
        }
    });

    // Drag & Drop on the pool area
    // 整个左侧素材栏都作为外部文件/文件夹拖放区，避免只有中间文件列表小区域能接收。
    const poolArea = sidebar;
    if (poolArea) {
        // Event delegation for drag events and remove clicks
        poolArea.addEventListener('click', (e) => {
            const btn = e.target.closest('.rbt-ms-remove');
            if (btn) {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.idx);
                window._mediaPool.items.splice(idx, 1);
                _renderPoolItems();
            }
        });
        poolArea.addEventListener('dragstart', (e) => {
            const item = e.target.closest('.rbt-ms-item');
            if (item) {
                e.dataTransfer.setData('application/x-media-pool-idx', item.dataset.idx);
                e.dataTransfer.effectAllowed = 'copy';
                item.style.opacity = '0.5';
            }
        });
        poolArea.addEventListener('dragend', (e) => {
            const item = e.target.closest('.rbt-ms-item');
            if (item) item.style.opacity = '1';
        });

        // Drop handling for pool area
        poolArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            poolArea.style.background = 'rgba(124,92,255,0.1)';
            poolArea.style.boxShadow = 'inset 0 0 0 2px rgba(124,92,255,0.4)';
        });
        poolArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            poolArea.style.background = '';
            poolArea.style.boxShadow = '';
        });
        poolArea.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            poolArea.style.background = '';
            poolArea.style.boxShadow = '';
            const files = Array.from(e.dataTransfer.files || []);
            if (files.length > 0) {
                const paths = files.map(f => {
                    const p = (typeof getFileNativePath === 'function') ? getFileNativePath(f) : (f.path || f.name);
                    return p;
                }).filter(Boolean);
                const dirs = paths.filter(p => _isDirectoryPath(p));
                if (dirs.length > 0) {
                    await _importFoldersAsFileTaskTabs(dirs);
                    const filePaths = paths.filter(p => !_isDirectoryPath(p));
                    if (filePaths.length > 0) _addFilesByPath(filePaths);
                } else {
                    handleFiles(files);
                }
            }
        });
    }

    // Filter clicks
    sidebar.querySelectorAll('.rbt-ms-filter').forEach(el => {
        el.addEventListener('click', () => {
            sidebar.querySelectorAll('.rbt-ms-filter').forEach(f => f.classList.remove('active'));
            el.classList.add('active');
            _activeFilter = el.dataset.filter || 'all';
            _renderPoolItems();
        });
    });
    // Resize handle
    const resizeHandle = sidebar.querySelector('#rbt-ms-resize');
    if (resizeHandle) {
        let startX = 0, startW = 0;
        const onMouseMove = (e) => {
            const newW = Math.min(500, Math.max(180, startW + (e.clientX - startX)));
            sidebar.style.width = newW + 'px';
        };
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            resizeHandle.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        resizeHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            startW = sidebar.offsetWidth;
            resizeHandle.classList.add('active');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    // Render existing items on open
    _renderPoolItems();
}

// 历史记录需要包含所有批量标签页，而不只是当前投影到主编辑器的任务。
window.reelsCaptureBatchTableState = function() {
    return {
        activeTabId: _batchTableState?.activeTabId || '',
        appliedTabIds: [...(_batchTableState?.appliedTabIds || [])],
        nextTabId: _batchTableState?.nextTabId || 1,
        tabs: _cloneBatchTasks((_batchTableState?.tabs || []).map(tab => ({ ...tab, tasks: _cloneBatchTasks(tab.tasks || []) }))),
        selectedRows: [...(_batchTableState?.selectedRows || [])],
    };
};
window.reelsRestoreBatchTableState = function(snapshot) {
    if (!snapshot || !_batchTableState) return;
    _batchTableState.tabs = (snapshot.tabs || []).map(tab => ({ ...tab, tasks: _cloneBatchTasks(tab.tasks || []) }));
    _batchTableState.activeTabId = snapshot.activeTabId || _batchTableState.tabs[0]?.id || '';
    _batchTableState.appliedTabIds = [...(snapshot.appliedTabIds || [])];
    _batchTableState.nextTabId = Math.max(1, Number(snapshot.nextTabId) || _batchTableState.tabs.length + 1);
    _batchTableState.selectedRows = new Set(snapshot.selectedRows || []);
};
window.reelsGetSelectedBatchTasks = function() {
    const tasks = window._reelsState?.tasks || [];
    return [...(_batchTableState?.selectedRows || [])].map(index => tasks[index]).filter(Boolean);
};

// Update every task linked to this preset, including tasks in inactive tabs.
window.reelsRefreshTasksUsingOverlayPreset = function(name, previousPreset = null) {
    if (!window._reelsState) return 0;
    if (_batchTableState.visible) _applyBatchTableChanges();
    _syncTasksToActiveTab();
    const tasks = new Set([...(window._reelsState.tasks || []), ..._batchTableState.tabs.flatMap(tab => tab.tasks || [])]);
    const updatedIds = new Set();
    const previousLayers = Array.isArray(previousPreset) ? previousPreset : previousPreset?.layers;
    const matchesPrevious = task => {
        if (!Array.isArray(previousLayers) || !previousLayers.length) return false;
        const layers = task.overlays || [];
        if (layers.length !== previousLayers.length) return false;
        // Identical layer IDs retain provenance in older project copies.
        if (previousLayers.every((layer, i) => layer.id && layer.id === layers[i]?.id && layer.type === layers[i]?.type)) return true;
        return previousLayers.every((layer, i) => _overlayMatchesPresetLayer(layers[i], layer)
            && (!['image', 'video', 'audio'].includes(layer.type) || layers[i]?.content === layer.content));
    };
    for (const task of tasks) {
        if (task._overlayPresetName !== name) {
            if (task._overlayPresetName || !matchesPrevious(task)) continue;
            task._overlayPresetName = name;
        }
        const result = _applyAndVerifyOverlayGroupPresetToTask(task, name, { addScroll: false, clearText: false });
        if (result.ok) updatedIds.add(task.id || task);
        else console.warn('[PresetSync] Failed:', name, result.reason);
    }
    if (!updatedIds.size) return 0;
    _syncSelectedTaskOverlayMgrIfNeeded(window._reelsState.selectedIdx);
    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    _skipNextApply = true;
    _batchAutoSave({ skipSync: true });
    if (typeof showToast === 'function') showToast('已同步更新 ' + updatedIds.size + ' 个使用此预设的画面', 'success', 4000);
    return updatedIds.size;
};

window.reelsEditWritingTask=function(idx){
    const task=window._reelsState?.tasks?.[idx];if(!task)return;
    if(!task.segments?.length){alert('请先导入或匹配 SRT 字幕，再编辑打字机文案。');return;}
    const style=typeof _resolveSubtitleStyleForTask==='function'?_resolveSubtitleStyleForTask(task):(task.subtitleStyle||{});
    const parts=getSplitWritingParts(task.segments,style,task.ttsText||task.aiScript||'');
    const modal=document.createElement('div');modal.style.cssText='position:fixed;inset:0;background:#0009;z-index:99999;display:flex;align-items:center;justify-content:center';
    const panel=document.createElement('div');panel.style.cssText='background:#1c2030;color:#eee;width:680px;max-width:90vw;max-height:90vh;overflow:auto;padding:20px;border-radius:10px';modal.appendChild(panel);
    const heading=document.createElement('h3');heading.textContent='打字机标题 / 正文 · SRT 时间匹配';panel.appendChild(heading);
    const note=document.createElement('p');note.textContent='标题跨 SRT 段自动识别，正文从标题朗诵结束后开始。编辑下方显示文案会保留原字幕时间；朗诵音频保持原文。';panel.appendChild(note);
    const label=document.createElement('label');label.textContent='标题';panel.appendChild(label);
    const title=document.createElement('textarea');title.value=parts.title[0]?.text||'';title.rows=3;title.className='input';title.style.width='100%';panel.appendChild(title);
    const fields=[];
    for(const seg of parts.body){const l=document.createElement('div');l.textContent=`正文 ${seg.start.toFixed(2)}–${seg.end.toFixed(2)} 秒`;l.style.marginTop='10px';panel.appendChild(l);const input=document.createElement('textarea');input.value=seg.text;input.rows=2;input.className='input';input.style.width='100%';panel.appendChild(input);fields.push({seg,input});}
    const save=document.createElement('button');save.className='btn btn-primary';save.textContent='保存并刷新画面';save.style.marginTop='14px';panel.appendChild(save);
    const close=document.createElement('button');close.className='btn btn-secondary';close.textContent='取消';close.style.marginLeft='10px';panel.appendChild(close);close.onclick=()=>modal.remove();
    save.onclick=()=>{
        task.writingTitle=title.value.trim();task.writingSplit=true;
        for(const {seg,input}of fields){if(input.value!==seg.text){const source=task.segments[seg._writingSourceIndex];source.edited_text=seg._writingPrefix+input.value;}}
        task.subtitleStyle={...style,fullpage_typewriter:true,fullpage_typewriter_split:true,fullpage_typewriter_speech_sync:true,fullpage_typewriter_auto_sequence:true,fullpage_typewriter_title_auto:false,fullpage_typewriter_title_text:task.writingTitle,fullpage_typewriter_title_reveal:'char',fullpage_typewriter_title_delay:0,fullpage_typewriter_body_delay:0};
        if(typeof _batchAutoSave==='function')_batchAutoSave();
        if(typeof _renderBatchTable==='function')_renderBatchTable();
        if(typeof _getSelectedTask==='function'&&_getSelectedTask()===task&&typeof _writeStyleToUI==='function')_writeStyleToUI(task.subtitleStyle);
        if(typeof reelsRefreshSpeechWritingPreview==='function')reelsRefreshSpeechWritingPreview();modal.remove();
    };
    document.body.appendChild(modal);
};
