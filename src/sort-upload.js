/**
 * 分拣上传模式 (Sort Upload) — 独立模块
 * 依赖：renderer.js 中的 state.slots, addSlot, handleUpload, getSlotReadableName 等
 */
(function () {
  'use strict';

  const COLORS = ['#27ae60','#2980b9','#e67e22','#e74c3c','#9b59b6','#1abc9c','#f39c12','#3498db','#e91e63','#00bcd4'];
  const SLOT_MODES_MAP = { LIBRARY: 'library', CUSTOM_LINK: 'custom-link' };
  let initialized = false;
  const BATCH_RENAME_DRAFT_KEY = 'su-batch-rename-draft-v1';
  const BATCH_DEFAULT_SORT_KEY = 'su-batch-default-sort-v1';

  function batchDraftSignature(files) {
    return files.map(file => file.path || file.id).sort().join('\n');
  }

  function loadBatchRenameDraft(files) {
    try {
      const draft = JSON.parse(localStorage.getItem(BATCH_RENAME_DRAFT_KEY) || 'null');
      return draft?.signature === batchDraftSignature(files) ? draft : null;
    } catch (_) {
      return null;
    }
  }

  function saveBatchRenameDraft(draft) {
    try { localStorage.setItem(BATCH_RENAME_DRAFT_KEY, JSON.stringify(draft)); } catch (_) {}
  }

  function clearBatchRenameDraft() {
    try { localStorage.removeItem(BATCH_RENAME_DRAFT_KEY); } catch (_) {}
  }

  function toSafeFileUrl(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    if (/^(https?|data|blob):/i.test(filePath)) return filePath;
    if (window.electronAPI?.toFileUrl) return window.electronAPI.toFileUrl(filePath);
    if (window.bridge?.toFileUrl) return window.bridge.toFileUrl(filePath);
    let clean = filePath;
    let suffix = '';
    const hashIdx = clean.indexOf('#');
    if (hashIdx !== -1) {
      suffix = clean.slice(hashIdx);
      clean = clean.slice(0, hashIdx);
    }
    if (/^local-media:\/\//i.test(clean)) return clean + suffix;
    if (/^file:\/\//i.test(clean)) {
      try { clean = decodeURIComponent(clean.replace(/^file:\/\//i, '')); } catch (_) {}
    }
    clean = clean.replace(/\\/g, '/');
    if (!clean.startsWith('/')) clean = '/' + clean;
    return 'local-media://' + encodeURI(clean).replace(/#/g, '%23') + suffix;
  }

  // ── Custom prompt (Electron blocks window.prompt) ──
  function showPrompt(message, defaultValue = '', options = []) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:99999;display:flex;align-items:center;justify-content:center;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:12px;padding:20px 24px;min-width:340px;max-width:460px;box-shadow:0 8px 32px rgba(0,0,0,0.25);font-family:system-ui;';
      const label = document.createElement('div');
      label.style.cssText = 'font-size:13px;color:#333;margin-bottom:12px;white-space:pre-wrap;line-height:1.5;';
      label.textContent = message;
      
      const input = document.createElement('input');
      input.type = 'text'; input.value = defaultValue;
      input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d0d5dd;border-radius:8px;font-size:13px;outline:none;margin-bottom:14px;';
      input.addEventListener('focus', () => { input.style.borderColor = '#4285f4'; });
      input.addEventListener('blur', () => { input.style.borderColor = '#d0d5dd'; });

      // Handle datalist suggestions
      if (options && options.length) {
        const listId = 'prompt-datalist-' + Date.now();
        input.setAttribute('list', listId);
        const datalist = document.createElement('datalist');
        datalist.id = listId;
        options.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt;
          datalist.appendChild(o);
        });
        box.appendChild(datalist);
      }

      // Handle clickable suggestion tags
      let optContainer = null;
      if (options && options.length) {
        optContainer = document.createElement('div');
        optContainer.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;max-height:80px;overflow-y:auto;padding:2px 0;';
        options.forEach(opt => {
          const tag = document.createElement('span');
          tag.textContent = opt;
          tag.style.cssText = 'font-size:11px;background:#f3f4f6;color:#374151;padding:4px 8px;border-radius:6px;cursor:pointer;border:1px solid #e5e7eb;transition:all 0.15s;font-weight:500;';
          tag.addEventListener('mouseenter', () => {
            tag.style.background = '#e5e7eb';
            tag.style.borderColor = '#d1d5db';
          });
          tag.addEventListener('mouseleave', () => {
            tag.style.background = '#f3f4f6';
            tag.style.borderColor = '#e5e7eb';
          });
          tag.style.userSelect = 'none';
          tag.addEventListener('click', () => {
            input.value = opt;
            input.focus();
          });
          optContainer.appendChild(tag);
        });
      }

      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '取消';
      cancelBtn.style.cssText = 'padding:6px 16px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;cursor:pointer;font-size:13px;color:#555;';
      const okBtn = document.createElement('button');
      okBtn.textContent = '确定';
      okBtn.style.cssText = 'padding:6px 16px;border:none;border-radius:8px;background:#4285f4;color:#fff;cursor:pointer;font-size:13px;';
      cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
      okBtn.onclick = () => { overlay.remove(); resolve(input.value); };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') okBtn.click(); if (e.key === 'Escape') cancelBtn.click(); });
      btns.append(cancelBtn, okBtn);
      
      box.append(label);
      if (optContainer) box.append(optContainer);
      box.append(input, btns);
      overlay.append(box);
      document.body.append(overlay);
      setTimeout(() => input.focus(), 50);
    });
  }

  function showBatchRenameDialog(sortedFiles, selectionFiles) {
    return new Promise(resolve => {
      const restoredDraft = loadBatchRenameDraft(sortedFiles);
      const fileByPath = new Map(sortedFiles.map(file => [file.path || file.id, file]));
      const restoredFiles = (restoredDraft?.orderPaths || []).map(filePath => fileByPath.get(filePath)).filter(Boolean);
      const restoredIds = new Set(restoredFiles.map(file => file.id));
      let files = restoredFiles.length
        ? [...restoredFiles, ...sortedFiles.filter(file => !restoredIds.has(file.id))]
        : [...sortedFiles];
      let draggedIndex = -1;
      let clickPickMode = Boolean(restoredDraft?.clickPickMode);
      let clickOrderIds = (restoredDraft?.clickOrderPaths || []).map(filePath => fileByPath.get(filePath)?.id).filter(Boolean);
      let pickBaseFiles = (restoredDraft?.pickBasePaths || []).map(filePath => fileByPath.get(filePath)).filter(Boolean);
      if (!pickBaseFiles.length) pickBaseFiles = [...files];
      const groupById = new Map();
      Object.entries(restoredDraft?.groupsByPath || {}).forEach(([filePath, groupName]) => {
        const file = fileByPath.get(filePath);
        if (file && groupName) groupById.set(file.id, groupName);
      });
      let operationMode = restoredDraft?.operationMode || (restoredDraft?.onlyGroupMode ? 'group' : 'both');
      let orderGridView = restoredDraft?.orderGridView !== false;
      let batchDefaultSort = restoredDraft?.defaultSort || (() => {
        try { return localStorage.getItem(BATCH_DEFAULT_SORT_KEY) || 'main'; } catch (_) { return 'main'; }
      })();
      let nameRule = restoredDraft?.nameRule || { trimStart: 0, trimEnd: 0, find: '', replace: '' };
      let draftSaveTimer = null;
      let orderMediaObserver = null;
      let queueMediaObserver = null;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:99999;display:flex;align-items:center;justify-content:center;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:12px;padding:18px 22px;width:96vw;height:94vh;box-sizing:border-box;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.25);font-family:system-ui;';
      box.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px;">
          <div style="font-size:16px;font-weight:650;color:#1f2937;">排序、分组与批量重命名</div>
          <label style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid #86efac;border-radius:8px;background:#f0fdf4;color:#166534;font-size:11px;font-weight:650;">
            执行方式
            <select class="su-batch-operation-mode" style="border:0;background:transparent;color:#166534;font-size:11px;font-weight:700;outline:0;cursor:pointer;">
              <option value="both">重命名 + 分文件夹</option>
              <option value="rename">仅重命名</option>
              <option value="group">仅分文件夹</option>
            </select>
          </label>
          <span class="su-batch-draft-badge" style="display:none;padding:4px 8px;border-radius:999px;background:#fff7ed;color:#c2410c;font-size:10px;">已恢复上次草稿</span>
        </div>
        <div style="font-size:12px;color:#64748b;line-height:1.6;margin-bottom:12px;">
          已选 ${files.length} 个文件。顺序、分组和名称会自动保存；重复名称自动添加 (2)、(3)…
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
          <span style="font-size:12px;font-weight:600;color:#475569;">快捷排序：</span>
          <button class="su-batch-order-current" style="padding:5px 10px;border:1px solid #4285f4;border-radius:7px;background:#e8f0fe;color:#2563eb;cursor:pointer;font-size:11px;">应用默认排序</button>
          <select class="su-batch-default-sort" title="默认排序规则" style="padding:5px 7px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#475569;font-size:11px;outline:none;">
            <option value="main">跟随顶部排序</option>
            <option value="date-desc">时间：新 → 旧</option>
            <option value="date-asc">时间：旧 → 新</option>
            <option value="name-asc">名称：A → Z</option>
            <option value="name-desc">名称：Z → A</option>
            <option value="size-desc">大小：大 → 小</option>
            <option value="size-asc">大小：小 → 大</option>
          </select>
          <button class="su-batch-order-selection" style="padding:5px 10px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#475569;cursor:pointer;font-size:11px;">选择先后顺序</button>
          <button class="su-batch-order-click" style="padding:5px 10px;border:1px solid #f59e0b;border-radius:7px;background:#fffbeb;color:#b45309;cursor:pointer;font-size:11px;">⚡ 点选编号</button>
          <button class="su-batch-order-layout-toggle" type="button" style="padding:5px 10px;border:1px solid #8b5cf6;border-radius:7px;background:#f5f3ff;color:#6d28d9;cursor:pointer;font-size:11px;">☷ 列表</button>
          <button class="su-batch-order-clear" style="display:none;padding:5px 10px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#475569;cursor:pointer;font-size:11px;">清空编号</button>
          <span class="su-batch-order-hint" style="font-size:11px;color:#94a3b8;">直接填排序号、点 ↑↓、拖拽或点选编号</span>
        </div>
        <div class="su-batch-order-queue-wrap" style="display:none;margin-bottom:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
            <strong style="font-size:12px;color:#475569;">最终顺序队列</strong>
            <span class="su-batch-order-queue-count" style="font-size:11px;color:#64748b;">0 项</span>
          </div>
          <div class="su-batch-order-queue" style="height:112px;display:flex;gap:7px;overflow-x:auto;overflow-y:hidden;padding:7px;border:1px solid #bfdbfe;border-radius:9px;background:#eff6ff;"></div>
        </div>
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:10px;padding:7px 9px;border:1px solid #d1fae5;border-radius:8px;background:#f0fdf4;">
          <strong style="font-size:12px;color:#166534;white-space:nowrap;">📁 快捷分组</strong>
          <input class="su-batch-group-name" type="text" placeholder="输入组名/文件夹名" style="width:180px;padding:6px 8px;border:1px solid #86efac;border-radius:6px;font-size:11px;box-sizing:border-box;">
          <button class="su-batch-group-queue" type="button" style="padding:6px 9px;border:1px solid #22c55e;border-radius:6px;background:#fff;color:#15803d;cursor:pointer;font-size:11px;">应用到队列未分组项</button>
          <button class="su-batch-group-all" type="button" style="padding:6px 9px;border:1px solid #86efac;border-radius:6px;background:#fff;color:#15803d;cursor:pointer;font-size:11px;">应用到全部</button>
          <button class="su-batch-group-clear" type="button" style="padding:6px 9px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#64748b;cursor:pointer;font-size:11px;">清除全部分组</button>
          <span class="su-batch-group-status" style="font-size:11px;color:#64748b;"></span>
        </div>
        <div class="su-batch-name-rule" style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:10px;padding:7px 9px;border:1px solid #bfdbfe;border-radius:8px;background:#eff6ff;">
          <strong style="font-size:12px;color:#1d4ed8;white-space:nowrap;">🏷️ 名称规则</strong>
          <label style="font-size:11px;color:#475569;">删除前 <input class="su-batch-trim-start" type="number" min="0" value="${Number(nameRule.trimStart) || 0}" style="width:48px;padding:4px;border:1px solid #93c5fd;border-radius:5px;"> 个字符</label>
          <label style="font-size:11px;color:#475569;">删除后 <input class="su-batch-trim-end" type="number" min="0" value="${Number(nameRule.trimEnd) || 0}" style="width:48px;padding:4px;border:1px solid #93c5fd;border-radius:5px;"> 个字符</label>
          <label style="font-size:11px;color:#475569;">查找 <input class="su-batch-find-name" value="${String(nameRule.find || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="可留空" style="width:104px;padding:4px;border:1px solid #93c5fd;border-radius:5px;"></label>
          <label style="font-size:11px;color:#475569;">替换为 <input class="su-batch-replace-name" value="${String(nameRule.replace || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" placeholder="可留空" style="width:104px;padding:4px;border:1px solid #93c5fd;border-radius:5px;"></label>
          <button class="su-batch-apply-name-rule" type="button" style="padding:5px 10px;border:1px solid #2563eb;border-radius:6px;background:#fff;color:#1d4ed8;cursor:pointer;font-size:11px;font-weight:650;">生成到右侧名称</button>
          <span class="su-batch-name-rule-status" style="font-size:10px;color:#64748b;">保留扩展名；生成后仍可逐行修改</span>
        </div>
        <div class="su-batch-main-grid" style="display:grid;grid-template-columns:minmax(0,1.25fr) minmax(280px,0.75fr);gap:12px;margin-bottom:14px;">
          <div>
            <div style="font-size:11px;font-weight:600;color:#475569;margin-bottom:5px;">图片顺序（平铺、拖拽调整）</div>
            <div class="su-batch-rename-order" style="height:calc(94vh - 210px);min-height:420px;overflow:auto;border:1px solid #e2e8f0;border-radius:8px;padding:8px;background:#f8fafc;font-size:11px;line-height:1.65;"></div>
          </div>
          <div class="su-batch-names-panel">
            <div class="su-batch-names-title" style="font-size:11px;font-weight:600;color:#475569;margin-bottom:5px;">粘贴新名称（每行一个）</div>
            <textarea class="su-batch-rename-input" spellcheck="false" style="width:100%;height:calc(94vh - 210px);min-height:420px;resize:none;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font:12px/1.65 ui-monospace,monospace;outline:none;" placeholder="产品主图&#10;产品侧面&#10;产品侧面"></textarea>
          </div>
        </div>
        <div class="su-batch-rename-status" style="font-size:12px;color:#64748b;min-height:18px;margin-bottom:8px;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="su-batch-rename-cancel" style="padding:7px 18px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;cursor:pointer;">取消</button>
          <button class="su-batch-rename-confirm" style="padding:7px 18px;border:0;border-radius:8px;background:#4285f4;color:#fff;cursor:pointer;">重命名</button>
        </div>`;
      const order = box.querySelector('.su-batch-rename-order');
      const currentBtn = box.querySelector('.su-batch-order-current');
      const defaultSortInput = box.querySelector('.su-batch-default-sort');
      const selectionBtn = box.querySelector('.su-batch-order-selection');
      const clickBtn = box.querySelector('.su-batch-order-click');
      const layoutToggleBtn = box.querySelector('.su-batch-order-layout-toggle');
      const clearOrderBtn = box.querySelector('.su-batch-order-clear');
      const orderHint = box.querySelector('.su-batch-order-hint');
      const queueWrap = box.querySelector('.su-batch-order-queue-wrap');
      const queue = box.querySelector('.su-batch-order-queue');
      const queueCount = box.querySelector('.su-batch-order-queue-count');
      const groupNameInput = box.querySelector('.su-batch-group-name');
      const groupQueueBtn = box.querySelector('.su-batch-group-queue');
      const groupAllBtn = box.querySelector('.su-batch-group-all');
      const groupClearBtn = box.querySelector('.su-batch-group-clear');
      const groupStatus = box.querySelector('.su-batch-group-status');
      const operationModeInput = box.querySelector('.su-batch-operation-mode');
      const mainGrid = box.querySelector('.su-batch-main-grid');
      const namesPanel = box.querySelector('.su-batch-names-panel');
      const draftBadge = box.querySelector('.su-batch-draft-badge');
      const textarea = box.querySelector('.su-batch-rename-input');
      const status = box.querySelector('.su-batch-rename-status');
      const confirmBtn = box.querySelector('.su-batch-rename-confirm');
      const trimStartInput = box.querySelector('.su-batch-trim-start');
      const trimEndInput = box.querySelector('.su-batch-trim-end');
      const findNameInput = box.querySelector('.su-batch-find-name');
      const replaceNameInput = box.querySelector('.su-batch-replace-name');
      const applyNameRuleBtn = box.querySelector('.su-batch-apply-name-rule');
      const nameRuleStatus = box.querySelector('.su-batch-name-rule-status');
      operationModeInput.value = operationMode;
      defaultSortInput.value = batchDefaultSort;
      if (restoredDraft) draftBadge.style.display = '';

      const persistDraft = (immediate = false) => {
        const write = () => {
          draftSaveTimer = null;
          const groupsByPath = {};
          files.forEach(file => {
            const groupName = groupById.get(file.id);
            if (groupName) groupsByPath[file.path || file.id] = groupName;
          });
          saveBatchRenameDraft({
            signature: batchDraftSignature(sortedFiles),
            orderPaths: files.map(file => file.path || file.id),
            pickBasePaths: pickBaseFiles.map(file => file.path || file.id),
            clickOrderPaths: clickOrderIds
              .map(id => pickBaseFiles.find(file => file.id === id))
              .filter(Boolean)
              .map(file => file.path || file.id),
            groupsByPath,
            namesText: textarea.value,
            clickPickMode,
            operationMode,
            orderGridView,
            defaultSort: batchDefaultSort,
            nameRule,
            updatedAt: Date.now()
          });
        };
        if (draftSaveTimer) clearTimeout(draftSaveTimer);
        if (immediate) write();
        else draftSaveTimer = setTimeout(write, 120);
      };

      const syncNameRule = () => {
        nameRule = {
          trimStart: Math.max(0, Number.parseInt(trimStartInput.value, 10) || 0),
          trimEnd: Math.max(0, Number.parseInt(trimEndInput.value, 10) || 0),
          find: findNameInput.value || '',
          replace: replaceNameInput.value || ''
        };
        persistDraft();
      };
      [trimStartInput, trimEndInput, findNameInput, replaceNameInput].forEach(input => input?.addEventListener('input', syncNameRule));
      applyNameRuleBtn?.addEventListener('click', () => {
        syncNameRule();
        const names = files.map(file => {
          const dot = String(file.name || '').lastIndexOf('.');
          let base = dot > 0 ? String(file.name).slice(0, dot) : String(file.name || '');
          const chars = Array.from(base);
          const end = Math.max(nameRule.trimStart, chars.length - nameRule.trimEnd);
          base = chars.slice(nameRule.trimStart, end).join('');
          if (nameRule.find) base = base.split(nameRule.find).join(nameRule.replace);
          return base.trim() || '未命名';
        });
        textarea.value = names.join('\n');
        nameRuleStatus.textContent = `已按规则生成 ${names.length} 个名称；可继续在右侧逐行修改`;
        nameRuleStatus.style.color = '#166534';
        persistDraft(true);
      });

      const updateOperationModeUi = () => {
        operationMode = operationModeInput.value;
        const groupOnly = operationMode === 'group';
        const renameOnly = operationMode === 'rename';
        namesPanel.style.display = groupOnly ? 'none' : '';
        groupNameInput.parentElement.style.display = renameOnly ? 'none' : '';
        mainGrid.style.gridTemplateColumns = groupOnly ? 'minmax(0,1fr)' : 'minmax(0,1.25fr) minmax(280px,0.75fr)';
        confirmBtn.textContent = groupOnly ? '仅分文件夹' : renameOnly ? '仅重命名' : '重命名并分组';
        status.textContent = groupOnly
          ? '将保留原文件名，只把已填写分组的文件移入对应文件夹'
          : renameOnly ? '将只按顺序重命名，分组信息不会执行' : '';
        status.style.color = '#64748b';
        persistDraft();
      };
      const applyOrderLayout = () => {
        order.classList.toggle('su-batch-order-grid', orderGridView);
        layoutToggleBtn.textContent = orderGridView ? '☷ 列表' : '▦ 平铺';
        layoutToggleBtn.title = orderGridView ? '切换为列表显示' : '切换为缩略图平铺';
      };
      const sortFilesForDialog = (sourceFiles, rule) => {
        const effectiveRule = rule === 'main' ? sortOrder : rule;
        return [...sourceFiles].sort((a, b) => {
          const aTime = a.updatedAt || (a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0);
          const bTime = b.updatedAt || (b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0);
          switch (effectiveRule) {
            case 'name-asc': return a.name.localeCompare(b.name, 'zh-CN');
            case 'name-desc': return b.name.localeCompare(a.name, 'zh-CN');
            case 'date-asc': return aTime - bTime;
            case 'date-desc': return bTime - aTime;
            case 'size-asc': return (a.size || 0) - (b.size || 0);
            case 'size-desc': return (b.size || 0) - (a.size || 0);
            default: return 0;
          }
        });
      };
      if (!restoredDraft) {
        files = sortFilesForDialog(sortedFiles, batchDefaultSort);
        pickBaseFiles = [...files];
      }
      const setActiveOrderButton = active => {
        [[currentBtn, 'current'], [selectionBtn, 'selection']].forEach(([btn, type]) => {
          const on = active === type;
          btn.style.background = on ? '#e8f0fe' : '#fff';
          btn.style.color = on ? '#2563eb' : '#475569';
          btn.style.borderColor = on ? '#4285f4' : '#cbd5e1';
        });
      };
      const renderQueue = () => {
        queueMediaObserver?.disconnect();
        queue.replaceChildren();
        queueCount.textContent = `${clickOrderIds.length} / ${pickBaseFiles.length} 项`;
        if (!clickOrderIds.length) {
          const empty = document.createElement('div');
          empty.textContent = '依次点击下方图片，它们会按点击顺序加入这里';
          empty.style.cssText = 'margin:auto;color:#94a3b8;font-size:12px;';
          queue.appendChild(empty);
          return;
        }
        clickOrderIds.forEach((id, index) => {
          const file = pickBaseFiles.find(item => item.id === id);
          if (!file) return;
          const card = document.createElement('div');
          card.style.cssText = 'position:relative;width:104px;min-width:104px;height:96px;border:2px solid #3b82f6;border-radius:8px;background:#fff;overflow:hidden;cursor:pointer;box-sizing:border-box;';
          const fileSrc = file.path ? toSafeFileUrl(file.path) : '';
          const category = fileCategory(file.mimeType);
          if (fileSrc && category === 'image') {
            const img = document.createElement('img');
            img.dataset.src = fileSrc;
            img.loading = 'lazy';
            img.draggable = false;
            img.className = 'su-batch-lazy-media';
            img.style.cssText = 'width:100%;height:68px;object-fit:contain;display:block;background:#f8fafc;';
            card.appendChild(img);
          } else if (fileSrc && category === 'video') {
            const video = document.createElement('video');
            video.dataset.src = fileSrc;
            video.muted = true;
            video.preload = 'none';
            video.className = 'su-batch-lazy-media';
            video.style.cssText = 'width:100%;height:68px;object-fit:contain;display:block;background:#0f172a;';
            card.appendChild(video);
          } else {
            const icon = document.createElement('div');
            icon.textContent = fileIcon(file.mimeType);
            icon.style.cssText = 'height:68px;display:flex;align-items:center;justify-content:center;font-size:28px;background:#e2e8f0;';
            card.appendChild(icon);
          }
          const badge = document.createElement('span');
          badge.textContent = String(index + 1);
          badge.style.cssText = 'position:absolute;left:4px;top:4px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:#2563eb;color:#fff;font-size:12px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.25);';
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = '×';
          remove.title = '从顺序队列中取消';
          remove.style.cssText = 'position:absolute;right:4px;top:4px;width:24px;height:24px;border:0;border-radius:50%;background:#ef4444;color:#fff;font-size:17px;line-height:22px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.25);';
          const label = document.createElement('div');
          const assignedGroup = groupById.get(file.id) || '';
          label.textContent = assignedGroup ? `📁 ${assignedGroup}` : file.name;
          label.title = file.name;
          label.style.cssText = `height:24px;padding:4px 5px;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:9px;color:${assignedGroup ? '#15803d' : '#334155'};font-weight:${assignedGroup ? '700' : '400'};`;
          remove.addEventListener('click', event => {
            event.stopPropagation();
            clickOrderIds.splice(index, 1);
            orderHint.textContent = `已取消，继续点选：${clickOrderIds.length} / ${pickBaseFiles.length}`;
            persistDraft();
            renderQueue();
            updateClickPickUi();
          });
          card.addEventListener('click', () => remove.click());
          card.append(badge, remove, label);
          queue.appendChild(card);
        });
        queueMediaObserver = new IntersectionObserver(entries => {
          entries.forEach(entry => {
            const media = entry.target;
            if (entry.isIntersecting) {
              if (media.tagName === 'VIDEO') {
                media.dataset.thumbVisible = '1';
                queueVideoThumbnail(media);
              } else {
                if (!media.src && media.dataset.src) media.src = media.dataset.src;
                queueMediaObserver.unobserve(media);
              }
            } else if (media.tagName === 'VIDEO') {
              unloadVideoThumbnail(media);
            }
          });
        }, { root: queue, rootMargin: '80px' });
        queue.querySelectorAll('.su-batch-lazy-media').forEach(media => queueMediaObserver.observe(media));
        queue.scrollLeft = queue.scrollWidth;
      };
      const updateClickPickUi = () => {
        order.querySelectorAll('.su-batch-order-row').forEach(row => {
          const pickedIndex = clickOrderIds.indexOf(row.dataset.fileId);
          const selected = pickedIndex >= 0;
          row.style.borderColor = selected ? '#3b82f6' : '#e2e8f0';
          row.style.background = selected ? '#eff6ff' : '#fff';
          const number = row.querySelector('.su-batch-order-number');
          if (number) {
            number.textContent = selected ? String(pickedIndex + 1) : '·';
            number.style.background = selected ? '#4285f4' : '#cbd5e1';
          }
          const hint = row.querySelector('.su-batch-order-row-hint');
          if (hint) {
            hint.textContent = selected
              ? `已编号 ${pickedIndex + 1}，再次点击取消`
              : '点击加入最终顺序';
          }
        });
      };
      const renderOrder = () => {
        orderMediaObserver?.disconnect();
        applyOrderLayout();
        order.innerHTML = '';
        const displayFiles = clickPickMode ? pickBaseFiles : files;
        displayFiles.forEach((file, index) => {
          const pickedIndex = clickOrderIds.indexOf(file.id);
          const row = document.createElement('div');
          row.className = 'su-batch-order-row';
          row.draggable = !clickPickMode;
          row.dataset.index = String(index);
          row.dataset.fileId = file.id;
          row.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px;margin-bottom:6px;min-height:76px;border:2px solid ${pickedIndex >= 0 ? '#3b82f6' : '#e2e8f0'};border-radius:8px;background:${pickedIndex >= 0 ? '#eff6ff' : '#fff'};cursor:${clickPickMode ? 'pointer' : 'grab'};`;
          const handle = document.createElement('span');
          handle.textContent = '☰';
          handle.style.cssText = 'color:#94a3b8;font-size:12px;flex:0 0 auto;';
          const number = document.createElement('span');
          number.className = 'su-batch-order-number';
          number.textContent = clickPickMode ? (pickedIndex >= 0 ? String(pickedIndex + 1) : '·') : String(index + 1);
          number.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:${pickedIndex >= 0 || !clickPickMode ? '#4285f4' : '#cbd5e1'};color:#fff;font-weight:700;flex:0 0 auto;`;
          const preview = document.createElement('div');
          preview.style.cssText = 'width:92px;height:68px;flex:0 0 92px;border-radius:7px;overflow:hidden;background:#e2e8f0;display:flex;align-items:center;justify-content:center;color:#64748b;font-size:24px;';
          const fileSrc = file.path ? toSafeFileUrl(file.path) : '';
          const category = fileCategory(file.mimeType);
          if (fileSrc && category === 'image') {
            const img = document.createElement('img');
            img.dataset.src = fileSrc;
            img.loading = 'lazy';
            img.decoding = 'async';
            img.alt = file.name;
            img.draggable = false;
            img.className = 'su-batch-lazy-media';
            img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#f8fafc;';
            img.addEventListener('dblclick', event => {
              event.stopPropagation();
              showImageLightbox(fileSrc);
            });
            img.onerror = () => { preview.textContent = '🖼️'; };
            preview.appendChild(img);
          } else if (fileSrc && category === 'video') {
            const video = document.createElement('video');
            video.dataset.src = fileSrc;
            video.muted = true;
            video.preload = 'none';
            video.draggable = false;
            video.className = 'su-batch-lazy-media';
            video.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#0f172a;';
            video.onerror = () => { preview.textContent = '🎬'; };
            preview.appendChild(video);
          } else {
            preview.textContent = fileIcon(file.mimeType);
          }
          const meta = document.createElement('div');
          meta.style.cssText = 'min-width:0;display:flex;flex-direction:column;gap:3px;flex:1;';
          const name = document.createElement('span');
          name.textContent = file.name;
          name.title = file.path || file.name;
          name.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:#1f2937;font-weight:600;';
          const hint = document.createElement('span');
          hint.className = 'su-batch-order-row-hint';
          hint.textContent = clickPickMode
            ? (pickedIndex >= 0 ? `已编号 ${pickedIndex + 1}，再次点击取消` : '点击加入最终顺序')
            : (category === 'image' ? '双击缩略图可放大查看' : fileIcon(file.mimeType));
          hint.style.cssText = 'font-size:10px;color:#94a3b8;';
          const groupInput = document.createElement('input');
          groupInput.type = 'text';
          groupInput.placeholder = '分组/文件夹（可选）';
          groupInput.value = groupById.get(file.id) || '';
          groupInput.style.cssText = `width:150px;flex:0 0 150px;padding:5px 7px;border:1px solid #cbd5e1;border-radius:6px;font-size:11px;box-sizing:border-box;${operationMode === 'rename' ? 'display:none;' : ''}`;
          groupInput.addEventListener('click', event => event.stopPropagation());
          groupInput.addEventListener('input', () => {
            groupById.set(file.id, groupInput.value.trim());
            persistDraft();
          });
          const positionInput = document.createElement('input');
          positionInput.type = 'number';
          positionInput.min = '1';
          positionInput.max = String(files.length);
          positionInput.value = String(index + 1);
          positionInput.title = '直接输入目标顺序位置';
          positionInput.style.cssText = `width:54px;flex:0 0 54px;padding:5px;border:1px solid #cbd5e1;border-radius:6px;text-align:center;font-size:11px;${clickPickMode ? 'display:none;' : ''}`;
          positionInput.addEventListener('click', event => event.stopPropagation());
          positionInput.addEventListener('change', () => {
            const target = Math.max(1, Math.min(files.length, Number(positionInput.value) || index + 1)) - 1;
            if (target === index) return;
            const [moved] = files.splice(index, 1);
            files.splice(target, 0, moved);
            setActiveOrderButton('custom');
            persistDraft();
            renderOrder();
          });
          const moveControls = document.createElement('span');
          moveControls.title = '自定义顺序：逐项上移或下移';
          moveControls.style.cssText = `display:flex;gap:3px;flex:0 0 auto;${clickPickMode ? 'display:none;' : ''}`;
          const moveBy = (delta) => {
            const target = index + delta;
            if (target < 0 || target >= files.length) return;
            const [moved] = files.splice(index, 1);
            files.splice(target, 0, moved);
            setActiveOrderButton('custom');
            persistDraft();
            renderOrder();
          };
          [['↑', -1, '上移一位'], ['↓', 1, '下移一位']].forEach(([text, delta, title]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            button.title = title;
            button.disabled = (delta < 0 && index === 0) || (delta > 0 && index === files.length - 1);
            button.style.cssText = 'width:24px;height:27px;padding:0;border:1px solid #93c5fd;border-radius:5px;background:#fff;color:#1d4ed8;cursor:pointer;font-size:14px;line-height:1;';
            button.addEventListener('click', event => { event.stopPropagation(); moveBy(delta); });
            moveControls.appendChild(button);
          });
          meta.append(name, hint);
          row.append(handle, number, preview, meta, groupInput, positionInput, moveControls);
          row.addEventListener('click', event => {
            if (!clickPickMode || event.target.closest('input')) return;
            const existing = clickOrderIds.indexOf(file.id);
            if (existing >= 0) clickOrderIds.splice(existing, 1);
            else clickOrderIds.push(file.id);
            if (clickOrderIds.length === pickBaseFiles.length) {
              files = clickOrderIds.map(id => pickBaseFiles.find(item => item.id === id));
              orderHint.textContent = '✅ 点选完成，这就是最终顺序；可继续取消或调整';
            } else {
              orderHint.textContent = `点选图片依次编号：${clickOrderIds.length} / ${pickBaseFiles.length}`;
            }
            persistDraft();
            renderQueue();
            updateClickPickUi();
          });
          row.addEventListener('dragstart', e => {
            draggedIndex = index;
            row.style.opacity = '0.45';
            e.dataTransfer.effectAllowed = 'move';
          });
          row.addEventListener('dragend', () => {
            draggedIndex = -1;
            row.style.opacity = '';
          });
          row.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          });
          row.addEventListener('drop', e => {
            e.preventDefault();
            const targetIndex = Number(row.dataset.index);
            if (draggedIndex < 0 || draggedIndex === targetIndex) return;
            const [moved] = files.splice(draggedIndex, 1);
            files.splice(targetIndex, 0, moved);
            setActiveOrderButton('custom');
            persistDraft();
            renderOrder();
          });
          order.appendChild(row);
        });
        orderMediaObserver = new IntersectionObserver(entries => {
          entries.forEach(entry => {
            const media = entry.target;
            if (entry.isIntersecting) {
              if (media.tagName === 'VIDEO') {
                media.dataset.thumbVisible = '1';
                queueVideoThumbnail(media);
              } else if (!media.src && media.dataset.src) {
                media.src = media.dataset.src;
              }
            } else if (media.tagName === 'VIDEO') {
              unloadVideoThumbnail(media);
            }
          });
        }, { root: order, rootMargin: '160px 0px' });
        order.querySelectorAll('.su-batch-lazy-media').forEach(media => orderMediaObserver.observe(media));
      };
      const applyGroupToIds = ids => {
        const groupName = groupNameInput.value.trim();
        if (!groupName) {
          groupStatus.textContent = '请先输入组名';
          groupStatus.style.color = '#dc2626';
          groupNameInput.focus();
          return;
        }
        if (groupName === '.' || groupName === '..' || /[/\\]/.test(groupName)) {
          groupStatus.textContent = '组名不能包含 / 或 \\';
          groupStatus.style.color = '#dc2626';
          return;
        }
        ids.forEach(id => groupById.set(id, groupName));
        groupStatus.textContent = `已将 ${ids.length} 个文件设为「${groupName}」`;
        groupStatus.style.color = '#15803d';
        persistDraft();
        renderQueue();
        renderOrder();
      };
      groupQueueBtn.onclick = () => {
        const ungroupedIds = clickOrderIds.filter(id => !groupById.get(id));
        if (!ungroupedIds.length) {
          groupStatus.textContent = clickOrderIds.length ? '队列中没有未分组项' : '队列为空，请先点选图片';
          groupStatus.style.color = '#dc2626';
          return;
        }
        applyGroupToIds(ungroupedIds);
      };
      groupAllBtn.onclick = () => applyGroupToIds(files.map(file => file.id));
      groupClearBtn.onclick = () => {
        groupById.clear();
        groupStatus.textContent = '已清除全部分组';
        groupStatus.style.color = '#64748b';
        persistDraft();
        renderQueue();
        renderOrder();
      };
      currentBtn.onclick = () => {
        clickPickMode = false;
        queueWrap.style.display = 'none';
        order.style.height = 'calc(94vh - 210px)';
        order.style.minHeight = '420px';
        box.querySelector('.su-batch-rename-input').style.height = 'calc(94vh - 210px)';
        box.querySelector('.su-batch-rename-input').style.minHeight = '420px';
        files = sortFilesForDialog(sortedFiles, batchDefaultSort);
        setActiveOrderButton('current');
        persistDraft();
        renderOrder();
      };
      defaultSortInput.onchange = () => {
        batchDefaultSort = defaultSortInput.value;
        try { localStorage.setItem(BATCH_DEFAULT_SORT_KEY, batchDefaultSort); } catch (_) {}
        if (!clickPickMode) {
          files = sortFilesForDialog(sortedFiles, batchDefaultSort);
          setActiveOrderButton('current');
          renderOrder();
        }
        persistDraft();
      };
      selectionBtn.onclick = () => {
        clickPickMode = false;
        queueWrap.style.display = 'none';
        order.style.height = 'calc(94vh - 210px)';
        order.style.minHeight = '420px';
        box.querySelector('.su-batch-rename-input').style.height = 'calc(94vh - 210px)';
        box.querySelector('.su-batch-rename-input').style.minHeight = '420px';
        files = [...selectionFiles];
        setActiveOrderButton('selection');
        persistDraft();
        renderOrder();
      };
      clickBtn.onclick = () => {
        if (!clickPickMode) {
          clickOrderIds = [];
          pickBaseFiles = [...files];
        }
        clickPickMode = !clickPickMode;
        clickBtn.textContent = clickPickMode ? '退出点选编号' : '⚡ 点选编号';
        clearOrderBtn.style.display = clickPickMode ? '' : 'none';
        queueWrap.style.display = clickPickMode ? '' : 'none';
        const contentHeight = clickPickMode ? 'calc(94vh - 350px)' : 'calc(94vh - 210px)';
        order.style.height = contentHeight;
        order.style.minHeight = clickPickMode ? '280px' : '420px';
        const renameInput = box.querySelector('.su-batch-rename-input');
        renameInput.style.height = contentHeight;
        renameInput.style.minHeight = clickPickMode ? '280px' : '420px';
        orderHint.textContent = clickPickMode
          ? `按最终顺序逐个点击图片：0 / ${pickBaseFiles.length}`
          : '拖拽、点选编号或直接填写位置';
        setActiveOrderButton(clickPickMode ? 'custom' : 'current');
        persistDraft();
        renderQueue();
        renderOrder();
      };
      clearOrderBtn.onclick = () => {
        clickOrderIds = [];
        orderHint.textContent = `已清空，请重新点选：0 / ${pickBaseFiles.length}`;
        persistDraft();
        renderQueue();
        updateClickPickUi();
      };
      layoutToggleBtn.onclick = () => {
        orderGridView = !orderGridView;
        persistDraft();
        renderOrder();
      };
      textarea.value = restoredDraft?.namesText || '';
      if (clickPickMode) {
        clickBtn.textContent = '退出点选编号';
        clearOrderBtn.style.display = '';
        queueWrap.style.display = '';
        const restoredHeight = 'calc(94vh - 350px)';
        order.style.height = restoredHeight;
        order.style.minHeight = '280px';
        textarea.style.height = restoredHeight;
        textarea.style.minHeight = '280px';
        orderHint.textContent = `已恢复点选顺序：${clickOrderIds.length} / ${pickBaseFiles.length}`;
      }
      updateOperationModeUi();
      renderQueue();
      renderOrder();
      const close = value => {
        orderMediaObserver?.disconnect();
        queueMediaObserver?.disconnect();
        if (draftSaveTimer) clearTimeout(draftSaveTimer);
        if (value) clearBatchRenameDraft();
        else persistDraft(true);
        overlay.remove();
        resolve(value);
      };
      box.querySelector('.su-batch-rename-cancel').onclick = () => close(null);
      overlay.addEventListener('click', e => {
        if (e.target !== overlay) return;
        status.textContent = '为防止顺序丢失，请使用下方“取消”或“执行”按钮';
        status.style.color = '#b45309';
      });
      textarea.addEventListener('input', () => {
        const count = textarea.value.split(/\r?\n/).filter(line => line.trim()).length;
        status.textContent = `已输入 ${count} 个名称 / 已选 ${files.length} 个文件`;
        status.style.color = count === files.length ? '#15803d' : '#b45309';
        persistDraft();
      });
      operationModeInput.addEventListener('change', updateOperationModeUi);
      confirmBtn.onclick = () => {
        if (clickPickMode && clickOrderIds.length !== pickBaseFiles.length) {
          status.textContent = `请先完成全部图片编号（当前 ${clickOrderIds.length} / ${pickBaseFiles.length}）`;
          status.style.color = '#dc2626';
          return;
        }
        const names = textarea.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const renameEnabled = operationMode !== 'group';
        const groupEnabled = operationMode !== 'rename';
        if (renameEnabled && names.length !== files.length) {
          status.textContent = `名称数量必须与已选文件一致（当前 ${names.length} / ${files.length}）`;
          status.style.color = '#dc2626';
          textarea.focus();
          return;
        }
        const assignedGroupCount = files.filter(file => groupById.get(file.id)).length;
        if (operationMode === 'group' && !assignedGroupCount) {
          status.textContent = '请先给至少一个文件填写分组/文件夹名';
          status.style.color = '#dc2626';
          groupNameInput.focus();
          return;
        }
        close({
          files: [...files],
          names,
          groups: Object.fromEntries(groupById),
          renameEnabled,
          groupEnabled
        });
      };
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      setTimeout(() => textarea.focus(), 0);
    });
  }

  async function batchRenameSelectedFiles() {
    if (selectedFolderPaths.size) {
      await batchRenameSelectedFolders();
      return;
    }
    const sortedFiles = filteredFiles().filter(file => selectedIds.has(file.id) && file.path);
    const selectionFiles = Array.from(selectedIds)
      .map(id => localFiles.find(file => file.id === id))
      .filter(file => file?.path && sortedFiles.some(sorted => sorted.id === file.id));
    if (!sortedFiles.length) {
      if (typeof showToast === 'function') showToast('请先选择要排序或分组的文件', 'error');
      return;
    }
    const dialogResult = await showBatchRenameDialog(sortedFiles, selectionFiles);
    if (!dialogResult) return;
    const { files, names, groups = {}, renameEnabled = true, groupEnabled = true } = dialogResult;
    let result = { renamed: [], errors: [] };
    if (renameEnabled) {
      const requests = files.map((file, index) => {
        const originalExt = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
        const pastedName = names[index];
        const pastedHasExt = /\.[^./\\]+$/.test(pastedName);
        return {
          id: file.id,
          source: file.path,
          newName: pastedHasExt ? pastedName : pastedName + originalExt,
          conflictStyle: 'number'
        };
      });
      result = await window.bridge?.renameLocalFiles?.(requests) || result;
    }
    const renamedById = new Map((result?.renamed || []).map(entry => [entry.id, entry]));
    files.forEach(file => {
      const renamed = renamedById.get(file.id);
      if (!renamed) return;
      file.name = renamed.name;
      file.path = renamed.path;
    });
    let groupedCount = 0;
    let groupErrorCount = 0;
    for (const file of (groupEnabled ? files : [])) {
      const groupName = (groups[file.id] || '').trim();
      if (!groupName) continue;
      if (groupName === '.' || groupName === '..' || /[/\\]/.test(groupName)) {
        groupErrorCount += 1;
        continue;
      }
      const sourcePath = file.path;
      const separator = sourcePath.includes('\\') ? '\\' : '/';
      const parentDir = sourcePath.replace(/[/\\][^/\\]+$/, '');
      const targetDir = parentDir + separator + groupName;
      const moveResult = await window.bridge?.localFiles?.moveToFolder?.(
        sourcePath,
        targetDir,
        { conflict: 'rename' }
      );
      if (moveResult?.success && moveResult.status !== 'skip') {
        file.path = moveResult.destPath || file.path;
        file.name = file.path.split(/[/\\]/).pop() || file.name;
        groupedCount += 1;
      } else {
        groupErrorCount += 1;
      }
    }
    // 此次参与排序的文件放到文件列表顶部；没有参与排序的文件继续按默认排序显示在下面。
    customDisplayOrderPaths = files.map(file => file.path).filter(Boolean);
    saveCurrentTab();
    saveTabs();
    renderFileGrid();
    updateActionBar();
    const successCount = result?.renamed?.length || 0;
    const errorCount = result?.errors?.length || 0;
    if (typeof showToast === 'function') {
      showToast(
        errorCount || groupErrorCount
          ? `${renameEnabled ? `已重命名 ${successCount} 个、` : ''}${groupEnabled ? `分组 ${groupedCount} 个；` : ''}失败 ${errorCount + groupErrorCount} 个`
          : (renameEnabled
              ? `✅ 已重命名 ${successCount} 个${groupEnabled && groupedCount ? `，并分组移动 ${groupedCount} 个` : ''}`
              : `✅ 已按原文件名分组移动 ${groupedCount} 个`),
        errorCount || groupErrorCount ? 'error' : 'success'
      );
    }
  }

  function selectedTopLevelFolders() {
    const selected = [...selectedFolderPaths];
    return selected
      .filter(folderPath => !selected.some(parent => parent !== folderPath && folderPath.startsWith(parent + '/')))
      .map(relPath => ({ relPath, diskPath: resolveRelPathToDisk(relPath), name: relPath.split('/').pop() || relPath }))
      .filter(folder => folder.diskPath);
  }

  function showBatchFolderOrderDialog(sourceFolders) {
    return new Promise(resolve => {
      let folders = [...sourceFolders];
      let dragIndex = -1;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:99999;display:flex;align-items:center;justify-content:center;padding:3vh 3vw;';
      const box = document.createElement('div');
      box.style.cssText = 'width:min(1120px,94vw);height:min(760px,92vh);display:flex;flex-direction:column;background:#fff;border-radius:14px;padding:18px 20px;box-sizing:border-box;box-shadow:0 12px 40px rgba(0,0,0,.26);font-family:system-ui;';
      box.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:7px;">
          <strong style="font-size:16px;color:#1f2937;">文件夹排序与批量重命名</strong>
          <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#475569;cursor:pointer;"><input class="su-folder-order-only" type="checkbox"> 只排序，不改名</label>
        </div>
        <div style="font-size:12px;color:#64748b;line-height:1.55;margin-bottom:10px;">拖拽卡片设定文件夹顺序。确认后，已排序文件夹会置顶，未排序文件夹按名称显示在下面；同名自动添加编号。</div>
        <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.62fr);gap:12px;flex:1;min-height:0;">
          <div class="su-folder-order-grid" style="overflow:auto;padding:8px;border:1px solid #dbeafe;border-radius:10px;background:#f8fbff;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));align-content:start;gap:9px;"></div>
          <div class="su-folder-order-names-panel" style="min-width:0;display:flex;flex-direction:column;">
            <div style="font-size:12px;font-weight:650;color:#475569;margin-bottom:6px;">新文件夹名（每行一个）</div>
            <textarea class="su-folder-order-names" spellcheck="false" style="width:100%;flex:1;min-height:0;resize:none;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:9px;padding:9px;font:12px/1.7 ui-monospace,monospace;" placeholder="产品素材\n产品视频\n产品图片"></textarea>
          </div>
        </div>
        <div class="su-folder-order-status" style="min-height:20px;margin-top:9px;font-size:12px;color:#64748b;"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;"><button class="su-folder-order-cancel" style="padding:7px 18px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;cursor:pointer;">取消</button><button class="su-folder-order-confirm" style="padding:7px 18px;border:0;border-radius:8px;background:#4285f4;color:#fff;cursor:pointer;">重命名并排序</button></div>`;
      const grid = box.querySelector('.su-folder-order-grid');
      const textarea = box.querySelector('.su-folder-order-names');
      const onlyOrder = box.querySelector('.su-folder-order-only');
      const status = box.querySelector('.su-folder-order-status');
      const namesPanel = box.querySelector('.su-folder-order-names-panel');
      const confirmBtn = box.querySelector('.su-folder-order-confirm');
      const render = () => {
        grid.replaceChildren();
        folders.forEach((folder, index) => {
          const card = document.createElement('div');
          card.draggable = true;
          card.style.cssText = 'position:relative;min-height:136px;padding:9px;border:2px solid #dbeafe;border-radius:10px;background:#fff;cursor:grab;box-sizing:border-box;display:flex;flex-direction:column;gap:7px;';
          card.innerHTML = `<span style="position:absolute;top:7px;right:7px;width:25px;height:25px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#4285f4;color:#fff;font-size:12px;font-weight:700;">${index + 1}</span><span style="font-size:34px;line-height:44px;">📁</span><strong style="font-size:12px;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${folder.name}</strong><span style="font-size:10px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">☰ 拖拽调整</span>`;
          card.addEventListener('dragstart', event => { dragIndex = index; card.style.opacity = '.45'; event.dataTransfer.effectAllowed = 'move'; });
          card.addEventListener('dragend', () => { dragIndex = -1; card.style.opacity = ''; });
          card.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
          card.addEventListener('drop', event => { event.preventDefault(); if (dragIndex < 0 || dragIndex === index) return; const [moved] = folders.splice(dragIndex, 1); folders.splice(index, 0, moved); render(); });
          grid.append(card);
        });
      };
      const updateMode = () => {
        namesPanel.style.display = onlyOrder.checked ? 'none' : '';
        confirmBtn.textContent = onlyOrder.checked ? '仅排序' : '重命名并排序';
      };
      onlyOrder.addEventListener('change', updateMode);
      textarea.addEventListener('input', () => {
        const count = textarea.value.split(/\r?\n/).filter(line => line.trim()).length;
        status.textContent = `已输入 ${count} 个名称 / 已选 ${folders.length} 个文件夹`;
        status.style.color = count === folders.length ? '#15803d' : '#b45309';
      });
      const close = value => { overlay.remove(); resolve(value); };
      box.querySelector('.su-folder-order-cancel').onclick = () => close(null);
      confirmBtn.onclick = () => {
        const names = textarea.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (!onlyOrder.checked && names.length !== folders.length) {
          status.textContent = `名称数量必须与文件夹数量一致（${names.length} / ${folders.length}）`;
          status.style.color = '#dc2626';
          textarea.focus();
          return;
        }
        close({ folders: [...folders], names, renameEnabled: !onlyOrder.checked });
      };
      overlay.append(box);
      document.body.append(overlay);
      render();
      setTimeout(() => textarea.focus(), 0);
    });
  }

  async function batchRenameSelectedFolders() {
    const folders = selectedTopLevelFolders();
    if (!folders.length) return;
    const result = await showBatchFolderOrderDialog(folders);
    if (!result) return;
    const orderedRelPaths = [];
    let renamedCount = 0;
    let failureCount = 0;
    for (let index = 0; index < result.folders.length; index++) {
      const folder = result.folders[index];
      let finalDiskPath = folder.diskPath;
      let finalRelPath = folder.relPath;
      if (result.renameEnabled) {
        const renameResult = await window.bridge?.renameLocalFiles?.([{ source: folder.diskPath, newName: result.names[index], conflictStyle: 'number' }]);
        const renamed = renameResult?.renamed?.[0];
        if (!renamed) { failureCount++; continue; }
        finalDiskPath = renamed.path;
        const parentRel = folder.relPath.includes('/') ? folder.relPath.slice(0, folder.relPath.lastIndexOf('/')) : '';
        finalRelPath = parentRel ? parentRel + '/' + renamed.name : renamed.name;
        updateLocalPathsAfterRename(folder.diskPath, finalDiskPath, folder.relPath, renamed.name);
        renamedCount++;
      }
      orderedRelPaths.push(finalRelPath);
    }
    customFolderOrderPaths = orderedRelPaths;
    selectedFolderPaths.clear();
    saveCurrentTab();
    saveTabs();
    renderFileGrid();
    updateActionBar();
    if (typeof showToast === 'function') showToast(failureCount ? `已处理 ${orderedRelPaths.length} 个文件夹，失败 ${failureCount} 个` : `✅ 已${result.renameEnabled ? `重命名 ${renamedCount} 个并` : ''}排序 ${orderedRelPaths.length} 个文件夹`, failureCount ? 'error' : 'success');
  }

  function showLocalTargetPicker(fileId) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.35);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;';
    const box = document.createElement('div');
    box.style.cssText = 'width:min(440px,92vw);max-height:min(620px,88vh);display:flex;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 16px 48px rgba(15,23,42,0.28);padding:16px;font-family:system-ui;';
    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <strong style="font-size:15px;color:#1f2937;">📌 分配到目标</strong>
        <button class="su-target-picker-close" style="border:0;background:transparent;font-size:20px;color:#64748b;cursor:pointer;line-height:1;">×</button>
      </div>
      <input class="su-target-picker-search" type="search" placeholder="搜索目标名称…" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;outline:none;margin-bottom:10px;">
      <div class="su-target-picker-count" style="font-size:11px;color:#64748b;margin-bottom:6px;"></div>
      <div class="su-target-picker-list" style="min-height:120px;max-height:440px;overflow:auto;border:1px solid #e2e8f0;border-radius:8px;padding:4px;"></div>`;
    const input = box.querySelector('.su-target-picker-search');
    const list = box.querySelector('.su-target-picker-list');
    const count = box.querySelector('.su-target-picker-count');
    const close = () => overlay.remove();
    const assign = folder => {
      assignMap[fileId] = folder.id;
      recentSlotIds = recentSlotIds.filter(id => id !== folder.id);
      recentSlotIds.unshift(folder.id);
      if (recentSlotIds.length > 5) recentSlotIds.length = 5;
      updateFileCardsInPlace();
      renderRecentSlots();
      updateActionBar();
      close();
    };
    const render = () => {
      const query = input.value.trim().toLowerCase();
      const matches = (query
        ? localTargetFolders.filter(folder =>
            folder.name.toLowerCase().includes(query) ||
            (folder.group || '').toLowerCase().includes(query))
        : localTargetFolders).filter(folder => !folder.archived);
      count.textContent = `显示 ${matches.length} / ${localTargetFolders.length} 个目标`;
      list.replaceChildren();
      const fragment = document.createDocumentFragment();
      matches.forEach((folder, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.style.cssText = 'width:100%;display:flex;align-items:center;gap:8px;padding:8px 9px;border:0;border-radius:6px;background:transparent;color:#1f2937;text-align:left;cursor:pointer;font-size:13px;';
        const pin = document.createElement('span');
        pin.textContent = '📌';
        const name = document.createElement('span');
        name.textContent = folder.name;
        name.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;';
        const badge = document.createElement('span');
        badge.textContent = String(localTargetFolders.indexOf(folder) + 1);
        badge.style.cssText = 'color:#94a3b8;font-size:11px;';
        row.append(pin, name, badge);
        row.addEventListener('mouseenter', () => { row.style.background = '#eff6ff'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });
        row.addEventListener('click', () => assign(folder));
        if (index < 80) fragment.appendChild(row);
      });
      list.appendChild(fragment);
      if (matches.length > 80) {
        const hint = document.createElement('div');
        hint.textContent = `结果较多，仅显示前 80 个；输入名称可快速查找。`;
        hint.style.cssText = 'padding:8px;text-align:center;color:#94a3b8;font-size:11px;';
        list.appendChild(hint);
      }
      if (!matches.length) {
        const empty = document.createElement('div');
        empty.textContent = '没有匹配的目标';
        empty.style.cssText = 'padding:28px;text-align:center;color:#94a3b8;font-size:12px;';
        list.appendChild(empty);
      }
    };
    box.querySelector('.su-target-picker-close').onclick = close;
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    input.addEventListener('input', render);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    render();
    setTimeout(() => input.focus(), 0);
  }

  function showMultilinePrompt(message, defaultValue = '') {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:99999;display:flex;align-items:center;justify-content:center;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:12px;padding:20px 24px;min-width:380px;max-width:480px;box-shadow:0 8px 32px rgba(0,0,0,0.25);font-family:system-ui;';
      const label = document.createElement('div');
      label.style.cssText = 'font-size:13px;color:#333;margin-bottom:12px;white-space:pre-wrap;line-height:1.5;font-weight:600;';
      label.textContent = message;
      
      const textarea = document.createElement('textarea');
      textarea.value = defaultValue;
      textarea.rows = 8;
      textarea.placeholder = '每行一个文件夹名称\n例如：\n文件夹A\n文件夹B\n文件夹C';
      textarea.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d0d5dd;border-radius:8px;font-size:13px;outline:none;margin-bottom:14px;resize:vertical;font-family:inherit;';
      textarea.addEventListener('focus', () => { textarea.style.borderColor = '#4285f4'; });
      textarea.addEventListener('blur', () => { textarea.style.borderColor = '#d0d5dd'; });

      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '取消';
      cancelBtn.style.cssText = 'padding:6px 16px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;cursor:pointer;font-size:13px;color:#555;';
      const okBtn = document.createElement('button');
      okBtn.textContent = '确定';
      okBtn.style.cssText = 'padding:6px 16px;border:none;border-radius:8px;background:#4285f4;color:#fff;cursor:pointer;font-size:13px;';
      cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
      okBtn.onclick = () => { overlay.remove(); resolve(textarea.value); };
      btns.append(cancelBtn, okBtn);
      
      box.append(label, textarea, btns);
      overlay.append(box);
      document.body.append(overlay);
      setTimeout(() => textarea.focus(), 50);
    });
  }


  // ── Custom toast ──
  function showToast(msg, type = 'success') {
    let el = document.querySelector('.su-toast-notification');
    if (!el) {
      el = document.createElement('div');
      el.className = 'su-toast-notification';
      el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(100px);color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:500;z-index:100001;opacity:0;pointer-events:none;transition:transform 0.3s cubic-bezier(0.18, 0.89, 0.32, 1.28), opacity 0.3s ease;';
      document.body.appendChild(el);
    }

    // Set background color based on type
    if (msg.includes('❌') || type === 'error') {
      el.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)'; // Red
      el.style.boxShadow = '0 4px 20px rgba(239, 68, 68, 0.4)';
    } else if (msg.includes('⚠️') || type === 'warning') {
      el.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)'; // Orange
      el.style.boxShadow = '0 4px 20px rgba(245, 158, 11, 0.4)';
    } else {
      el.style.background = 'linear-gradient(135deg, #10b981, #059669)'; // Green
      el.style.boxShadow = '0 4px 20px rgba(16, 185, 129, 0.4)';
    }
    
    el.textContent = msg;
    
    // Trigger show class/styles
    setTimeout(() => {
      el.style.transform = 'translateX(-50%) translateY(0)';
      el.style.opacity = '1';
    }, 10);
    
    // Clear any previous timeout
    if (window.suToastTimer) clearTimeout(window.suToastTimer);
    window.suToastTimer = setTimeout(() => {
      el.style.transform = 'translateX(-50%) translateY(100px)';
      el.style.opacity = '0';
    }, 3000);
  }

  function esc(s) {
    if (!s) return '';
    return s.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showDuplicateReviewModal(duplicateGroups, onComplete) {
    const overlay = document.createElement('div');
    overlay.className = 'su-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
    
    const selectedPaths = new Set();
    duplicateGroups.forEach(group => {
      // Keep the first file (index 0) in group.paths, check the rest (index >= 1)
      for (let i = 1; i < group.paths.length; i++) {
        selectedPaths.add(group.paths[i]);
      }
    });

    const updateSelectionSummary = () => {
      let totalBytes = 0;
      duplicateGroups.forEach(group => {
        group.paths.forEach(p => {
          if (selectedPaths.has(p)) {
            totalBytes += group.size || 0;
          }
        });
      });
      const confirmBtn = overlay.querySelector('.su-dup-confirm-btn');
      if (confirmBtn) {
        confirmBtn.textContent = `确认移入回收站 (已选 ${selectedPaths.size} 个文件，可释放 ${formatSize(totalBytes)})`;
        confirmBtn.disabled = selectedPaths.size === 0;
      }
    };

    let groupsHtml = '';
    duplicateGroups.forEach((group, groupIdx) => {
      let filesHtml = '';
      group.paths.forEach((p, fileIdx) => {
        const isTrash = selectedPaths.has(p);
        const fileName = p.split(/[/\\]/).pop();
        const folderDir = p.substring(0, p.length - fileName.length - 1);
        
        const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
        const isImg = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext);
        let previewHtml = '';
        if (isImg) {
          previewHtml = `<img src="${toSafeFileUrl(p)}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;border:1px solid #ddd;flex-shrink:0;" />`;
        } else {
          previewHtml = `<div style="width:40px;height:40px;background:#f1f5f9;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:18px;border:1px solid #ddd;flex-shrink:0;">🎬</div>`;
        }

        filesHtml += `
          <div class="su-dup-file-row" style="display:flex;align-items:center;gap:12px;padding:8px 12px;border-bottom:1px solid #f1f5f9;background:${fileIdx === 0 ? '#f8fafc' : '#fff'};">
            <input type="checkbox" class="su-dup-file-check" data-path="${esc(p)}" ${isTrash ? 'checked' : ''} style="cursor:pointer;width:16px;height:16px;flex-shrink:0;" />
            ${previewHtml}
            <div style="flex:1;min-width:0;line-height:1.4;">
              <div style="font-size:12px;font-weight:600;color:#1e293b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(fileName)}">${esc(fileName)} ${fileIdx === 0 ? '<span style="font-size:10px;background:#e2e8f0;color:#64748b;padding:1px 6px;border-radius:10px;font-weight:normal;margin-left:6px;">建议保留</span>' : '<span style="font-size:10px;background:#fef2f2;color:#ef4444;padding:1px 6px;border-radius:10px;font-weight:normal;margin-left:6px;">重复文件</span>'}</div>
              <div style="font-size:10px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(folderDir)}">路径: ${esc(folderDir)}</div>
            </div>
          </div>
        `;
      });

      groupsHtml += `
        <div style="border:1px solid #e2e8f0;border-radius:10px;margin-bottom:16px;overflow:hidden;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
          <div style="background:#f1f5f9;padding:8px 16px;font-size:11px;font-weight:bold;color:#475569;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
            <span>👥 重复组 ${groupIdx + 1}</span>
            <span>大小: ${formatSize(group.size)}</span>
          </div>
          <div>${filesHtml}</div>
        </div>
      `;
    });

    const boxHtml = `
      <div style="background:#fff;border-radius:16px;padding:24px;width:680px;max-width:90vw;height:80vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,0.3);font-family:system-ui;-webkit-font-smoothing:antialiased;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-shrink:0;">
          <h3 style="margin:0;font-size:16px;font-weight:bold;color:#0f172a;display:flex;align-items:center;gap:8px;">🧹 查重结果确认</h3>
          <button class="su-dup-close-btn" title="关闭查重结果，不删除任何文件" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8;padding:4px;">✕</button>
        </div>
        <div style="font-size:12px;color:#64748b;margin-bottom:16px;line-height:1.5;flex-shrink:0;background:#f8fafc;padding:10px 14px;border-radius:8px;border-left:4px solid #3b82f6;">
          发现 <strong>${duplicateGroups.length}</strong> 组完全重复的文件（大小和内容均一致）。我们已为您<strong>默认勾选了每组中的副本文件</strong>，您可以手动核对并调整勾选，最后点击确认移入回收站。
        </div>
        <div style="flex:1;overflow-y:auto;min-height:0;margin-bottom:18px;padding-right:4px;">
          ${groupsHtml}
        </div>
        <div style="display:flex;gap:12px;justify-content:flex-end;flex-shrink:0;border-top:1px solid #f1f5f9;padding-top:16px;">
          <button class="su-dup-cancel-btn" title="取消本次去重，不删除任何文件" style="padding:8px 20px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;cursor:pointer;font-size:13px;color:#334155;font-weight:500;">取消</button>
          <button class="su-dup-confirm-btn" title="仅将列表中已勾选的重复文件移入系统废纸篓" style="padding:8px 20px;border:none;border-radius:8px;background:#ef4444;color:#fff;cursor:pointer;font-size:13px;font-weight:500;box-shadow:0 2px 4px rgba(239,68,68,0.2);">确认移入回收站</button>
        </div>
      </div>
    `;

    overlay.innerHTML = boxHtml;
    document.body.appendChild(overlay);

    const closeBtn = overlay.querySelector('.su-dup-close-btn');
    const cancelBtn = overlay.querySelector('.su-dup-cancel-btn');
    const confirmBtn = overlay.querySelector('.su-dup-confirm-btn');

    const close = () => { overlay.remove(); };
    closeBtn.onclick = close;
    cancelBtn.onclick = close;
    overlay.onclick = e => { if (e.target === overlay) close(); };

    const checkBoxes = overlay.querySelectorAll('.su-dup-file-check');
    checkBoxes.forEach(cb => {
      cb.onchange = (e) => {
        const path = cb.dataset.path;
        if (e.target.checked) {
          selectedPaths.add(path);
        } else {
          selectedPaths.delete(path);
        }
        updateSelectionSummary();
      };
    });

    updateSelectionSummary();

    confirmBtn.onclick = async () => {
      if (selectedPaths.size === 0) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = '⏳ 正在清理...';
      try {
        const pathsToTrash = Array.from(selectedPaths);
        const res = await window.bridge?.localFiles?.trashFiles(pathsToTrash);
        if (res && res.success) {
          showToast(`✅ 成功清理 ${res.trashedCount} 个重复文件！`, 'success');
          
          const trashedSet = new Set(res.trashedFiles);
          localFiles = localFiles.filter(f => !trashedSet.has(f.path));
          renderFileGrid();
          updateActionBar();
          close();
          onComplete?.(res);
        } else {
          alert('清理失败: ' + (res?.error || '未知错误'));
          confirmBtn.disabled = false;
          updateSelectionSummary();
        }
      } catch (e) {
        console.error(e);
        alert('清理出错: ' + e.message);
        confirmBtn.disabled = false;
        updateSelectionSummary();
      }
    };
  }

  // ── Avatar Crop/Position Modal ──
  function showAvatarCropModal(folder, imgPath) {
    const fileSrc = toSafeFileUrl(imgPath);
    const prevPos = folder.avatarPos || { x: 50, y: 50 };
    let posX = prevPos.x, posY = prevPos.y;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:14px;padding:20px 24px;width:320px;box-shadow:0 8px 32px rgba(0,0,0,0.3);font-family:system-ui;';

    const title = document.createElement('div');
    title.textContent = '调整头像显示位置';
    title.style.cssText = 'font-size:14px;font-weight:600;color:#333;margin-bottom:12px;text-align:center;';

    const hint = document.createElement('div');
    hint.textContent = '拖拽图片调整显示区域';
    hint.style.cssText = 'font-size:11px;color:#999;text-align:center;margin-bottom:10px;';

    // Preview container (square, clipped)
    const preview = document.createElement('div');
    preview.style.cssText = 'width:200px;height:200px;margin:0 auto 16px;border-radius:12px;overflow:hidden;border:2px solid #e0e0e0;position:relative;cursor:grab;background:#f5f5f5;';
    const img = document.createElement('img');
    img.src = fileSrc;
    img.style.cssText = `position:absolute;min-width:100%;min-height:100%;object-fit:cover;object-position:${posX}% ${posY}%;width:100%;height:100%;pointer-events:none;user-select:none;`;
    preview.appendChild(img);

    // Drag logic
    let dragging = false, startMX, startMY, startPX, startPY;
    preview.addEventListener('mousedown', (e) => {
      dragging = true; startMX = e.clientX; startMY = e.clientY;
      startPX = posX; startPY = posY;
      preview.style.cursor = 'grabbing';
      e.preventDefault();
    });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    function onMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startMX;
      const dy = e.clientY - startMY;
      posX = Math.max(0, Math.min(100, startPX - dx * 0.5));
      posY = Math.max(0, Math.min(100, startPY - dy * 0.5));
      img.style.objectPosition = `${posX}% ${posY}%`;
    }
    function onUp() {
      dragging = false;
      preview.style.cursor = 'grab';
    }

    // Buttons
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;justify-content:center;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = 'padding:8px 20px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;cursor:pointer;font-size:13px;color:#555;';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '清除头像';
    clearBtn.style.cssText = 'padding:8px 20px;border:1px solid #f87171;border-radius:8px;background:#fff;cursor:pointer;font-size:13px;color:#f87171;';
    const okBtn = document.createElement('button');
    okBtn.textContent = '确定';
    okBtn.style.cssText = 'padding:8px 20px;border:none;border-radius:8px;background:#4285f4;color:#fff;cursor:pointer;font-size:13px;';

    function cleanup() { overlay.remove(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    cancelBtn.onclick = cleanup;
    clearBtn.onclick = () => { folder.avatar = ''; folder.avatarPos = null; delete autoAvatarThumbnailCache[folder.id]; saveLocalTargetFolders(); renderSlotList(); cleanup(); };
    okBtn.onclick = () => { folder.avatar = imgPath; folder.avatarPos = { x: Math.round(posX), y: Math.round(posY) }; delete autoAvatarThumbnailCache[folder.id]; saveLocalTargetFolders(); renderSlotList(); cleanup(); };

    btns.append(cancelBtn, clearBtn, okBtn);
    box.append(title, hint, preview, btns);
    overlay.append(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
    document.body.append(overlay);
  }

  // ── Video Player Modal ──
  function showVideoPlayer(src) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;';
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;max-width:90vw;max-height:85vh;';
    const video = document.createElement('video');
    video.src = toSafeFileUrl(src);
    video.controls = true;
    video.autoplay = true;
    video.style.cssText = 'max-width:90vw;max-height:85vh;border-radius:8px;outline:none;';
    const closeBtn = document.createElement('div');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:-12px;right:-12px;width:28px;height:28px;border-radius:50%;background:#fff;color:#333;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);z-index:1;';
    closeBtn.onclick = close;
    wrap.append(video, closeBtn);
    overlay.append(wrap);
    document.body.append(overlay);
  }

  // ── State ──
  let localFiles = [];        // { id, name, path, size, mimeType, relPath }
  let selectedIds = new Set();
  let selectedFolderPaths = new Set(); // tree folder relPaths selected for move/copy
  let assignMap = {};          // filePath → slotId (also 'folder:relPath' → slotId for folders)
  let suppressNextFileCardClick = false;
  let recentSlotIds = [];
  let localFolderPath = '';
  let localFolderPaths = [];    // 多文件夹模式：所有已添加的源文件夹路径
  let currentPage = 1;
  let pageSize = 100;
  let typeFilter = 'all';
  let searchQuery = '';
  let nameFilterMode = 'all';
  let nameFilterQuery = '';
  let slotSearchQuery = '';
  let collapsedGroups = new Set();
  let dateFilter = 'today';
  let customStart = '';
  let customEnd = '';
  let customMonth = '';
  let sortOrder = 'date-desc';
  // 最近一次确认的自定义顺序：这些文件始终排在前面，其他文件按默认排序跟在下面。
  let customDisplayOrderPaths = [];
  // 文件夹排序独立保存，避免影响文件的默认排序。
  let customFolderOrderPaths = [];
  let uploadedMap = {};        // fileId → { slotId, slotName, status: 'done'|'fail' }
  let cloudSubfolderEnabled = true; // 云端是否自动建子文件夹（默认开）
  let fileViewMode = 'tree';   // 'flat' | 'tree'
  let currentTreePath = '';    // 当前浏览的子路径（层级模式）

  // ── Work Mode ──
  let workMode = 'local-dual';           // 'upload' | 'local-organize' | 'local-dual'
  const LOCAL_FOLDER_VIEW_KEY = 'su-local-folder-view';
  const LOCAL_FOLDER_SORT_KEY = 'su-local-folder-sort';
  let localFolderViewMode = (() => {
    try { return localStorage.getItem(LOCAL_FOLDER_VIEW_KEY) || 'grid'; } catch (_) { return 'grid'; }
  })();
  let localFolderSortMode = (() => {
    try {
      const saved = localStorage.getItem(LOCAL_FOLDER_SORT_KEY);
      return ['added-asc', 'added-desc', 'name-asc', 'name-desc'].includes(saved) ? saved : 'added-asc';
    } catch (_) {
      return 'added-asc';
    }
  })();
  let localTargetFolders = [];       // [{ id, name, path, group? }]
  // 归档仅从本页面和分配列表中隐藏目标，不会删除或移动本地磁盘文件夹。
  let showArchivedLocalFolders = false;
  const DUAL_SIDEBAR_VISIBLE_KEY = 'su_dual_sidebar_visible';
  let dualSidebarVisible = false;
  try {
    dualSidebarVisible = localStorage.getItem(DUAL_SIDEBAR_VISIBLE_KEY) === 'true';
  } catch (_) {}
  let dualTargetRoot = '';
  let dualTargetPath = '';
  let dualTargetItems = [];
  const DUAL_PANES_KEY = 'su-dual-panes-v2';
  let dualPaneRatio = 0.5;
  let dualColRatios = [0.5, 0.5];
  let dualRowRatios = [1];
  let dualRowHeights = [];
  let dualPaneCounter = 0;
  let dualLayoutCount = 2;
  let dualLayoutColumns = 2;
  let activeDualTarget = 'right';
  let dualPaneOrder = ['left', 'right'];
  const dualFolderThumbnailCache = new Map();
  const dualFolderThumbnailPending = new Map();
  const dualVideoThumbnailCache = new Map();
  const dualVideoThumbnailPending = new Map();
  const dualAssignments = new Map();
  let dualGlobalShortcuts = [];
  const dualPanes = {
    left: { tabs: [], activeId: null, role: 'source', shortcuts: [] },
    right: { tabs: [], activeId: null, role: 'target', shortcuts: [] }
  };
  let localTargetCounter = 0;
  let localOrgDone = {};             // fileId → { folderId, folderName, status: 'done'|'fail' }
  const LOCAL_ORG_FOLDERS_KEY = 'su-local-org-folders';
  const LOCAL_ORG_MODE_KEY = 'su-work-mode';
  let localOrgDateSub = false;
  let subfolderRule = 'date'; // date | date-cn | yearmonth | custom
  let subfolderCustom = '';
  let collapsedLocalGroups = new Set();
  const autoAvatarCache = {}; // folderId -> latestImageFilepath or null
  const autoCloudAvatarCache = {}; // folderId -> thumbnailLink or null
  const AUTO_AVATAR_STORAGE_KEY = 'su-local-auto-avatar-cache-v1';
  const autoAvatarCacheMeta = {};
  const autoAvatarThumbnailCache = {};
  const autoAvatarScanQueue = [];
  let autoAvatarScanActive = 0;
  let autoAvatarCacheDirty = false;
  const MAX_AUTO_AVATAR_SCANS = 2;
  const autoAvatarThumbnailQueue = [];
  const autoAvatarThumbnailQueued = new Set();
  let autoAvatarThumbnailActive = 0;
  const MAX_AUTO_AVATAR_THUMBNAILS = 2;

  function loadPersistentAutoAvatarCache() {
    try {
      const saved = JSON.parse(localStorage.getItem(AUTO_AVATAR_STORAGE_KEY) || '{}');
      localTargetFolders.forEach(folder => {
        const entry = saved[folder.id];
        if (!entry || entry.folderPath !== folder.path) return;
        autoAvatarCache[folder.id] = entry.mediaPath || null;
        if (entry.thumbnailPath) autoAvatarThumbnailCache[folder.id] = entry.thumbnailPath;
        autoAvatarCacheMeta[folder.id] = Number(entry.updatedAt) || 0;
      });
    } catch (_) {}
  }

  function savePersistentAutoAvatarCache() {
    if (!autoAvatarCacheDirty) return;
    const saved = {};
    localTargetFolders.forEach(folder => {
      if (!Object.prototype.hasOwnProperty.call(autoAvatarCache, folder.id)) return;
      saved[folder.id] = {
        folderPath: folder.path,
        mediaPath: autoAvatarCache[folder.id] || null,
        thumbnailPath: autoAvatarThumbnailCache[folder.id] || null,
        updatedAt: autoAvatarCacheMeta[folder.id] || Date.now()
      };
    });
    try {
      localStorage.setItem(AUTO_AVATAR_STORAGE_KEY, JSON.stringify(saved));
      autoAvatarCacheDirty = false;
    } catch (_) {}
  }

  // ── Conflict resolution rule ──
  const LOCAL_ORG_CONFLICT_KEY = 'su-local-org-conflict';
  let localOrgConflictRule = 'rename'; // 'rename' | 'overwrite' | 'skip'
  function loadLocalOrgConflict() {
    try { localOrgConflictRule = localStorage.getItem(LOCAL_ORG_CONFLICT_KEY) || 'rename'; } catch (e) {}
  }
  function saveLocalOrgConflict() {
    try { localStorage.setItem(LOCAL_ORG_CONFLICT_KEY, localOrgConflictRule); } catch (e) {}
  }

  // ── Waste / Reject folder (废品箱) ──
  const WASTE_FOLDER_KEY = 'su-waste-folder-path';
  let wasteFolderPath = '';  // user-designated waste folder; empty = auto-create '_废品' next to file
  function loadWasteFolder() {
    try { wasteFolderPath = localStorage.getItem(WASTE_FOLDER_KEY) || ''; } catch (e) {}
  }
  function saveWasteFolder() {
    try { localStorage.setItem(WASTE_FOLDER_KEY, wasteFolderPath); } catch (e) {}
  }

  // ── Default target root folder (默认目标总文件夹) ──
  const DEFAULT_TARGET_ROOT_KEY = 'su-default-target-root';
  let defaultTargetRoot = '';
  function loadDefaultTargetRoot() {
    try { defaultTargetRoot = localStorage.getItem(DEFAULT_TARGET_ROOT_KEY) || ''; } catch (e) {}
  }
  function saveDefaultTargetRoot() {
    try { localStorage.setItem(DEFAULT_TARGET_ROOT_KEY, defaultTargetRoot); } catch (e) {}
  }

  // ── Default cloud target root folder (默认云端目标总文件夹) ──
  const DEFAULT_CLOUD_ROOT_KEY = 'su-default-cloud-root';
  const DEFAULT_CLOUD_ROOT_NAME_KEY = 'su-default-cloud-root-name';
  const DEFAULT_CLOUD_ROOT_LINK_KEY = 'su-default-cloud-root-link';
  let defaultCloudRoot = '';
  let defaultCloudRootName = '';
  let defaultCloudRootLink = '';

  function loadDefaultCloudRoot() {
    try {
      defaultCloudRoot = localStorage.getItem(DEFAULT_CLOUD_ROOT_KEY) || '';
      defaultCloudRootName = localStorage.getItem(DEFAULT_CLOUD_ROOT_NAME_KEY) || '';
      defaultCloudRootLink = localStorage.getItem(DEFAULT_CLOUD_ROOT_LINK_KEY) || '';
    } catch (e) {}
  }
  function saveDefaultCloudRoot() {
    try {
      localStorage.setItem(DEFAULT_CLOUD_ROOT_KEY, defaultCloudRoot);
      localStorage.setItem(DEFAULT_CLOUD_ROOT_NAME_KEY, defaultCloudRootName);
      localStorage.setItem(DEFAULT_CLOUD_ROOT_LINK_KEY, defaultCloudRootLink);
    } catch (e) {}
  }

  async function getCloudAccessToken() {
    if (window.bridge?.getAccessToken) {
      try {
        const r = await window.bridge.getAccessToken();
        return r?.token || null;
      } catch (e) {}
    }
    return null;
  }

  async function fetchCloudFolderInfo(folderId) {
    const token = await getCloudAccessToken();
    if (!token) throw new Error('请先在顶栏登录 Google 账号！');
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=name`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const err = await res.json().catch(()=>({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }
    return await res.json();
  }

  async function createCloudFolder(parentFolderId, folderName) {
    const token = await getCloudAccessToken();
    if (!token) return { success: false, error: '请先在顶栏登录 Google 账号！' };
    try {
      const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,parents,webViewLink', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentFolderId]
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(()=>({}));
        return { success: false, error: err?.error?.message || `HTTP ${res.status}` };
      }
      const data = await res.json();
      return {
        success: true,
        folder: {
          id: data.id,
          name: data.name,
          link: data.webViewLink || `https://drive.google.com/drive/folders/${data.id}`
        }
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }


  function saveLocalTargetFolders() {
    try { localStorage.setItem(LOCAL_ORG_FOLDERS_KEY, JSON.stringify(localTargetFolders)); } catch (e) {}
    if (window.bridge?.localFiles?.watchFolders) {
      window.bridge.localFiles.watchFolders(localTargetFolders);
    }
  }
  function loadLocalTargetFolders() {
    try {
      const raw = localStorage.getItem(LOCAL_ORG_FOLDERS_KEY);
      if (raw) {
        localTargetFolders = JSON.parse(raw);
        // Extract max numeric suffix from existing IDs to avoid ID collisions
        let maxId = 0;
        localTargetFolders.forEach(f => {
          const m = (f.id || '').match(/^lf-(\d+)/);
          if (m) maxId = Math.max(maxId, parseInt(m[1]));
        });
        localTargetCounter = maxId;
      }
    } catch (e) {}
    loadPersistentAutoAvatarCache();
    if (window.bridge?.localFiles?.watchFolders) {
      window.bridge.localFiles.watchFolders(localTargetFolders);
    }
  }
  const GROUP_PARENTS_KEY = 'su-group-parents';
  let groupParents = {};
  function saveGroupParents() {
    try { localStorage.setItem(GROUP_PARENTS_KEY, JSON.stringify(groupParents)); } catch (e) {}
  }
  function loadGroupParents() {
    try {
      const raw = localStorage.getItem(GROUP_PARENTS_KEY);
      groupParents = raw ? JSON.parse(raw) : {};
    } catch (e) {
      groupParents = {};
    }
  }
  function saveWorkMode() {
    try { localStorage.setItem(LOCAL_ORG_MODE_KEY, workMode); } catch (e) {}
  }
  function loadWorkMode() {
    try {
      const v = localStorage.getItem(LOCAL_ORG_MODE_KEY);
      if (v === 'local-organize' || v === 'local-dual') workMode = v;
      else workMode = 'local-dual';
    } catch (e) {
      workMode = 'local-dual';
    }
  }

  // ── Tab management ──
  let tabs = [];               // [{ id, folderPath, folderName, localFiles, selectedIds, assignMap, uploadedMap, currentTreePath }]
  let activeTabId = null;
  let tabCounter = 0;
  const TABS_KEY = 'su-tabs';

  function saveTabs() {
    try {
      const data = tabs.map(t => ({
        id: t.id,
        name: t.name || t.folderName || '',
        folderPath: t.folderPath || '',
        folderPaths: t.folderPaths || (t.folderPath ? [t.folderPath] : []),
        customDisplayOrderPaths: t.customDisplayOrderPaths || [],
        customFolderOrderPaths: t.customFolderOrderPaths || [],
      }));
      localStorage.setItem(TABS_KEY, JSON.stringify(data));
    } catch (e) {}
  }
  function loadTabs() {
    try {
      const raw = localStorage.getItem(TABS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (Array.isArray(saved) && saved.length) {
          tabs = saved.map(t => ({
            id: t.id || 'tab-' + (++tabCounter),
            name: t.name || '',
            folderPath: t.folderPath || '',
            folderPaths: t.folderPaths || (t.folderPath ? [t.folderPath] : []),
            folderName: t.name || '',
            localFiles: [],
            assignMap: {},
            selectedIds: [],
            uploadedMap: {},
            currentTreePath: '',
            currentPage: 1,
            customDisplayOrderPaths: Array.isArray(t.customDisplayOrderPaths) ? t.customDisplayOrderPaths : [],
            customFolderOrderPaths: Array.isArray(t.customFolderOrderPaths) ? t.customFolderOrderPaths : [],
          }));
          tabCounter = tabs.length;
          activeTabId = tabs[0].id;
        }
      }
    } catch (e) {}
  }

  function createTab(folderPath, folderName) {
    const id = 'tab-' + (++tabCounter);
    const tab = {
      id,
      folderPath: folderPath || '',
      folderPaths: folderPath ? [folderPath] : [],
      folderName: folderName || '新标签',
      localFiles: [],
      selectedIds: new Set(),
      assignMap: {},
      uploadedMap: {},
      currentTreePath: '',
      currentPage: 1,
      customStart: '',
      customEnd: '',
      customMonth: '',
      customDisplayOrderPaths: [],
      customFolderOrderPaths: [],
    };
    tabs.push(tab);
    return tab;
  }

  function saveCurrentTab() {
    if (!activeTabId) return;
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;
    tab.folderPath = localFolderPath;
    tab.folderPaths = [...localFolderPaths];
    tab.localFiles = localFiles;
    tab.selectedIds = new Set(selectedIds);
    tab.assignMap = { ...assignMap };
    tab.uploadedMap = { ...uploadedMap };
    tab.currentTreePath = currentTreePath;
    tab.currentPage = currentPage;
    // Per-tab filters
    tab.typeFilter = typeFilter;
    tab.searchQuery = searchQuery;
    tab.nameFilterMode = nameFilterMode;
    tab.nameFilterQuery = nameFilterQuery;
    tab.dateFilter = dateFilter;
    tab.customStart = customStart;
    tab.customEnd = customEnd;
    tab.customMonth = customMonth;
    tab.sortOrder = sortOrder;
    tab.fileViewMode = fileViewMode;
    tab.customDisplayOrderPaths = [...customDisplayOrderPaths];
    tab.customFolderOrderPaths = [...customFolderOrderPaths];
  }

  function loadTab(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    activeTabId = tabId;
    localFolderPath = tab.folderPath;
    localFolderPaths = tab.folderPaths ? [...tab.folderPaths] : (tab.folderPath ? [tab.folderPath] : []);
    localFiles = tab.localFiles;
    selectedIds = new Set(tab.selectedIds);
    assignMap = { ...tab.assignMap };
    uploadedMap = { ...tab.uploadedMap };
    currentTreePath = tab.currentTreePath;
    currentPage = tab.currentPage || 1;
    // Restore per-tab filters (fallback to defaults for old tabs)
    typeFilter = tab.typeFilter || 'all';
    searchQuery = tab.searchQuery || '';
    nameFilterMode = tab.nameFilterMode || 'all';
    nameFilterQuery = tab.nameFilterQuery || '';
    dateFilter = tab.dateFilter || 'today';
    customStart = tab.customStart || '';
    customEnd = tab.customEnd || '';
    customMonth = tab.customMonth || '';
    sortOrder = tab.sortOrder || 'date-desc';
    fileViewMode = tab.fileViewMode || 'tree';
    customDisplayOrderPaths = Array.isArray(tab.customDisplayOrderPaths) ? [...tab.customDisplayOrderPaths] : [];
    customFolderOrderPaths = Array.isArray(tab.customFolderOrderPaths) ? [...tab.customFolderOrderPaths] : [];
    // Sync filter UI controls
    syncFilterUI();
    // Update path display and refresh button state
    updateFolderPathDisplay();
    renderSourceFoldersBar();
  }

  function switchTab(tabId) {
    if (tabId === activeTabId) return;
    saveCurrentTab();
    loadTab(tabId);
    renderTabBar();
    renderFileGrid();
    updateActionBar();
    // Update folder path display
    updateFolderPathDisplay();
  }

  function closeTab(tabId) {
    if (tabs.length <= 1) return; // Keep at least one tab
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    tabs.splice(idx, 1);
    if (activeTabId === tabId) {
      // Switch to nearest tab
      const newIdx = Math.min(idx, tabs.length - 1);
      loadTab(tabs[newIdx].id);
    }
    saveTabs();
    renderTabBar();
    renderFileGrid();
    updateActionBar();
  }

  function renderTabBar() {
    const bar = $('su-tab-bar');
    if (!bar) return;
    bar.innerHTML = tabs.map(t => {
      const active = t.id === activeTabId ? ' active' : '';
      const name = t.name || t.folderName || '空';
      const fileCount = t.localFiles?.length || 0;
      return `<div class="su-tab${active}" data-tab="${t.id}" title="双击重命名 · ${t.folderPath || '未选择文件夹'}">
        <span class="su-tab-name">${name}</span>
        ${fileCount ? `<span class="su-tab-count">${fileCount}</span>` : ''}
        ${tabs.length > 1 ? `<span class="su-tab-close" data-close="${t.id}">✕</span>` : ''}
      </div>`;
    }).join('') + `<div class="su-tab su-tab-add" title="新建标签页">+</div>`;

    // Tab click
    bar.querySelectorAll('.su-tab[data-tab]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.su-tab-close')) return;
        switchTab(el.dataset.tab);
      });
      // Double-click to rename
      el.addEventListener('dblclick', async (e) => {
        e.preventDefault();
        const tab = tabs.find(t => t.id === el.dataset.tab);
        if (!tab) return;
        const newName = await showPrompt('标签页名称：', tab.name || tab.folderName || '');
        if (newName !== null && newName.trim()) {
          tab.name = newName.trim();
          tab.folderName = newName.trim();
          saveTabs();
          renderTabBar();
        }
      });
    });
    // Close
    bar.querySelectorAll('.su-tab-close').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(el.dataset.close);
      });
    });
    // Add tab
    bar.querySelector('.su-tab-add')?.addEventListener('click', async () => {
      const newTab = createTab('', '新标签');
      saveCurrentTab();
      loadTab(newTab.id);
      renderTabBar();
      renderFileGrid();
      updateActionBar();
      // Auto-trigger folder picker
      pickFolder();
    });
  }

  // ── DOM refs ──
  const $ = s => document.getElementById(s);

  function getSlots() {
    return (typeof state !== 'undefined' && Array.isArray(state.slots)) ? state.slots : [];
  }

  function getSlotName(slot) {
    if (typeof getSlotReadableName === 'function') return getSlotReadableName(slot);
    return slot.displayName || `${slot.mainCategory || ''}/${slot.subCategory || ''}`;
  }

  function importUploadSlotPresets(slotsToImport, replaceExisting) {
    const slots = getSlots();
    if (replaceExisting) {
      slots.splice(0, slots.length);
    }

    slotsToImport.forEach(presetSlot => {
      if (typeof addSlot === 'function') {
        addSlot(presetSlot);
        return;
      }

      slots.push({
        id: `slot-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        subject: presetSlot.subject || '',
        pageName: presetSlot.pageName || '',
        admin: presetSlot.admin || '',
        distribution: presetSlot.distribution || '',
        taskType: presetSlot.taskType || '',
        mainCategory: presetSlot.mainCategory || '',
        subCategory: presetSlot.subCategory || '',
        folderPath: '',
        folderSources: [],
        files: [],
        referenceFiles: [],
        previewMap: new Map(),
        fileStatuses: new Map(),
        referenceFileStatuses: new Map(),
        lastFolderLink: presetSlot.lastFolderLink || '',
        mode: presetSlot.mode || 'library',
        customLink: presetSlot.customLink || '',
        customFolderId: presetSlot.customFolderId || '',
        displayName: presetSlot.displayName || '',
        customTexts: presetSlot.customTexts || {},
        eventName: presetSlot.eventName || '',
        namingPresetId: presetSlot.namingPresetId || '',
        folderNamingPresetId: presetSlot.folderNamingPresetId || '',
        skipCreateSubfolder: Boolean(presetSlot.skipCreateSubfolder),
        groupLabel: presetSlot.groupLabel || '',
        avatar: presetSlot.avatar || '',
        extraLink: presetSlot.extraLink || '',
        settingsOpen: Boolean(presetSlot.settingsOpen),
        viewMode: presetSlot.viewMode || 'upload',
        reviewEnabled: Boolean(presetSlot.reviewEnabled),
        reviewFolderLink: presetSlot.reviewFolderLink || '',
        reviewReferenceLink: presetSlot.reviewReferenceLink || '',
        referenceFolderPath: '',
        referenceFolderSources: [],
        collapsed: Boolean(presetSlot.collapsed),
        selectedFiles: new Set(),
        selectedReferenceFiles: new Set()
      });
    });
  }

  // ── File type helpers ──
  function fileCategory(mime) {
    if (!mime) return 'other';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (/pdf|document|sheet|presentation|word|excel|powerpoint|subrip|subtitle|text\//.test(mime)) return 'document';
    return 'other';
  }

  function fileIcon(mime) {
    const cat = fileCategory(mime);
    return { image: '🖼️', video: '🎬', audio: '🎵', document: '📄', other: '📦' }[cat] || '📦';
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  // ── Filtering & Sorting ──
  function filteredFiles() {
    let result = localFiles.filter(f => {
      // Type
      if (typeFilter !== 'all' && fileCategory(f.mimeType) !== typeFilter) return false;
      // Search
      if (searchQuery && !f.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      // Name filter: multiple keywords are separated by commas or new lines.
      const nameKeywords = nameFilterQuery.split(/[,，\n]/).map(keyword => keyword.trim().toLowerCase()).filter(Boolean);
      if (nameFilterMode === 'include' && nameKeywords.length && !nameKeywords.some(keyword => f.name.toLowerCase().includes(keyword))) return false;
      if (nameFilterMode === 'exclude' && nameKeywords.some(keyword => f.name.toLowerCase().includes(keyword))) return false;
      // Date Filter
      if (dateFilter !== 'all') {
        const fTime = f.updatedAt || (f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0);
        if (!fTime) return false; // 无日期信息时排除
        const now = Date.now();
        if (dateFilter === 'today') {
          if (new Date(fTime).toDateString() !== new Date().toDateString()) return false;
        } else if (dateFilter === '1d') {
          if (now - fTime > 86400000) return false;
        } else if (dateFilter === '3d') {
          if (now - fTime > 86400000 * 3) return false;
        } else if (dateFilter === '7d') {
          if (now - fTime > 86400000 * 7) return false;
        } else if (dateFilter === '30d') {
          if (now - fTime > 86400000 * 30) return false;
        } else if (dateFilter === '60d') {
          if (now - fTime > 86400000 * 60) return false;
        } else if (dateFilter === '180d') {
          if (now - fTime > 86400000 * 180) return false;
        } else if (dateFilter === 'custom') {
          if (customStart) {
            const startTime = new Date(customStart + 'T00:00:00').getTime();
            if (fTime < startTime) return false;
          }
          if (customEnd) {
            const endTime = new Date(customEnd + 'T23:59:59').getTime();
            if (fTime > endTime) return false;
          }
        } else if (dateFilter === 'custom-month') {
          if (!customMonth) return false;
          const parts = customMonth.split('-');
          if (parts.length === 2) {
            const yr = parseInt(parts[0], 10);
            const mo = parseInt(parts[1], 10);
            const fd = new Date(fTime);
            if (fd.getFullYear() !== yr || (fd.getMonth() + 1) !== mo) return false;
          } else {
            return false;
          }
        }
      }
      return true;
    });

    // Sort
    result.sort((a, b) => {
      switch (sortOrder) {
        case 'name-asc': return a.name.localeCompare(b.name);
        case 'name-desc': return b.name.localeCompare(a.name);
        case 'date-asc': return (a.updatedAt || 0) - (b.updatedAt || 0);
        case 'date-desc': return (b.updatedAt || 0) - (a.updatedAt || 0);
        case 'size-asc': return (a.size || 0) - (b.size || 0);
        case 'size-desc': return (b.size || 0) - (a.size || 0);
        default: return 0;
      }
    });

    // 已确认自定义顺序的文件固定置顶；未参与排序的文件保留上面的默认规则并排在后面。
    if (customDisplayOrderPaths.length) {
      const byPath = new Map(result.map(file => [file.path, file]));
      const pinned = customDisplayOrderPaths.map(filePath => byPath.get(filePath)).filter(Boolean);
      const pinnedPaths = new Set(pinned.map(file => file.path));
      result = [...pinned, ...result.filter(file => !pinnedPaths.has(file.path))];
    }

    return result;
  }

  // ── Render file grid ──
  function renderFileCard(f) {
    const sel = selectedIds.has(f.id) ? ' selected' : '';
    const aSlot = assignMap[f.id];
    let slot, assigned, tagColor, tagName;
    if (workMode === 'local-organize' || workMode === 'local-dual') {
      const folder = aSlot ? localTargetFolders.find(lf => lf.id === aSlot) : null;
      assigned = folder ? ' assigned' : '';
      tagColor = folder ? (COLORS[localTargetFolders.indexOf(folder) % COLORS.length]) : '#ccc';
      tagName = folder ? folder.name : '';
    } else {
      slot = aSlot ? getSlots().find(s => s.id === aSlot) : null;
      assigned = slot ? ' assigned' : '';
      tagColor = slot ? (COLORS[getSlots().indexOf(slot) % COLORS.length]) : '#ccc';
      tagName = slot ? getSlotName(slot) : '';
    }
    const isImg = f.mimeType && f.mimeType.startsWith('image/');
    const isVideo = f.mimeType && f.mimeType.startsWith('video/');
    const fileSrc = toSafeFileUrl(f.path);
    const thumbSrc = isImg ? fileSrc : '';
    const doneInfo = workMode === 'local-organize' ? localOrgDone[f.id] : uploadedMap[f.id];
    const upClass = doneInfo ? (doneInfo.status === 'done' ? ' upload-done' : ' upload-fail') : '';
    let upLabel = '';
    if (doneInfo) {
      const actionLabel = workMode === 'local-organize' ? (doneInfo.action === 'move' ? '移动' : '复制') : '上传';
      if (doneInfo.status === 'done') {
        upLabel = `<div class="su-file-upload-status su-file-upload-done">✅ ${actionLabel}成功 → ${doneInfo.folderName || ''}</div>`;
      } else {
        upLabel = `<div class="su-file-upload-status su-file-upload-fail">❌ ${actionLabel}失败</div>`;
      }
    }
    const fDate = f.updatedAt ? new Date(f.updatedAt).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
    let thumbHtml;
    if (isImg) {
      thumbHtml = `<img class="su-file-thumb su-lazy" data-src="${thumbSrc}" draggable="false" />`;
    } else if (isVideo) {
      thumbHtml = `<video class="su-file-thumb su-video-thumb su-lazy" data-src="${fileSrc}" muted preload="none" draggable="false"></video><div class="su-video-badge" data-video-src="${fileSrc}">▶</div>`;
    } else {
      thumbHtml = `<div class="su-file-icon">${fileIcon(f.mimeType)}</div>`;
    }
    const safeId = (f.id || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<div class="su-file-card${sel}${assigned}${upClass}" data-id="${safeId}">
      <div class="su-file-check">✓</div>
      <button class="su-file-delete" data-file-id="${safeId}" title="移入废品箱">✕</button>
      ${thumbHtml}
      <div class="su-file-info">
        <div class="su-file-name" title="${f.name}">${f.name}</div>
        <div class="su-file-size">${formatSize(f.size)}${fDate ? ' · ' + fDate : ''}</div>
        ${tagName ? `<div class="su-file-tag" style="display:block;background:#fef3e2;color:#e67e22;border:1px solid #f5c78440">→ ${tagName}</div>` : ''}
        ${upLabel}
      </div>
    </div>`;
  }

  function getTreeItems(files, prefix) {
    // Files & folders at the current prefix level
    const folders = new Map(); // folderName → { count, totalSize, firstMedia: { type, src } }
    const currentFiles = [];
    files.forEach(f => {
      const rel = f.relPath || f.name;
      const isImg = f.mimeType && f.mimeType.startsWith('image/');
      const isVideo = f.mimeType && f.mimeType.startsWith('video/');
      const fileSrc = f.path ? toSafeFileUrl(f.path) : '';

      const processFolder = (parts) => {
        const folder = parts[0];
        if (!folders.has(folder)) folders.set(folder, { count: 0, totalSize: 0, firstMedia: null });
        const info = folders.get(folder);
        info.count++;
        info.totalSize += f.size || 0;
        if (!info.firstMedia && fileSrc) {
          if (isImg) info.firstMedia = { type: 'image', src: fileSrc };
          else if (isVideo) info.firstMedia = { type: 'video', src: fileSrc };
        }
      };

      if (!prefix) {
        const parts = rel.split('/');
        if (parts.length > 1) {
          processFolder(parts);
        } else {
          currentFiles.push(f);
        }
      } else {
        if (!rel.startsWith(prefix + '/')) return;
        const rest = rel.slice(prefix.length + 1);
        const parts = rest.split('/');
        if (parts.length > 1) {
          processFolder(parts);
        } else {
          currentFiles.push(f);
        }
      }
    });
    return { folders, currentFiles };
  }

  function getFileIdsUnderTreeFolder(folderPath) {
    if (!folderPath) return [];
    const prefix = folderPath + '/';
    return filteredFiles()
      .filter(f => {
        const rel = f.relPath || f.name || '';
        return rel === folderPath || rel.startsWith(prefix);
      })
      .map(f => f.id)
      .filter(Boolean);
  }

  function updateFolderCardSelectionState(root = document) {
    root.querySelectorAll('.su-folder-card[data-folder]').forEach(card => {
      const ids = getFileIdsUnderTreeFolder(card.dataset.folder);
      card.classList.toggle('selected', ids.length > 0 && ids.every(id => selectedIds.has(id)));
    });
  }

  function renderSourceFoldersBar() {
    const bar = $('su-source-folders-bar');
    if (!bar) return;
    if (localFolderPaths.length < 1) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    bar.innerHTML = `<span style="font-size:11px;color:#888;margin-right:4px;">📂 源文件夹:</span>` +
      localFolderPaths.map(dir => {
        const name = dir.split('/').pop() || dir.split('\\').pop() || dir;
        return `<span class="su-source-tag" title="${dir}">
          ${name}
          <span class="su-source-tag-remove" data-dir="${dir}" title="移除此文件夹">✕</span>
        </span>`;
      }).join('');
    bar.querySelectorAll('.su-source-tag-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSourceFolder(btn.dataset.dir);
        renderSourceFoldersBar();
      });
    });
  }

  function renderBreadcrumb() {
    const bc = $('su-breadcrumb');
    if (!bc) return;
    const fp = $('su-folder-path');
    if (fileViewMode !== 'tree') {
      bc.style.display = 'none';
      if (fp) fp.style.display = '';
      return;
    }
    bc.style.display = 'flex';
    if (fp) fp.style.display = 'none';
    const parts = currentTreePath ? currentTreePath.split('/') : [];
    let html = `<span class="su-bc-item${!currentTreePath ? ' su-bc-active' : ''}" data-path="">📁 根目录</span>`;
    let pathAcc = '';
    parts.forEach((p, i) => {
      pathAcc += (i > 0 ? '/' : '') + p;
      const isLast = i === parts.length - 1;
      html += `<span class="su-bc-sep">›</span><span class="su-bc-item${isLast ? ' su-bc-active' : ''}" data-path="${pathAcc}">${p}</span>`;
    });
    html += `<span style="flex:1"></span>`;
    if (localFolderPaths.length) {
      html += `<button class="su-btn su-btn-sm su-bc-open-folder" title="在 Finder 中打开当前文件夹">📂 打开</button>`;
      html += `<button class="su-btn su-btn-sm su-bc-new-folder" title="在当前目录新建文件夹">📁+ 新建</button>`;
    }
    bc.innerHTML = html;
    bc.querySelectorAll('.su-bc-item').forEach(item => {
      item.addEventListener('click', () => {
        currentTreePath = item.dataset.path;
        renderFileGrid();
        renderBreadcrumb();
      });
    });
    bc.querySelector('.su-bc-new-folder')?.addEventListener('click', createFolderInSource);
    bc.querySelector('.su-bc-open-folder')?.addEventListener('click', openSourceFolderInFinder);
  }

  function openSourceFolderInFinder() {
    let diskPath = '';
    if (localFolderPaths.length === 1) {
      diskPath = localFolderPaths[0];
      if (currentTreePath) diskPath += '/' + currentTreePath;
    } else if (localFolderPaths.length > 1 && currentTreePath) {
      const topFolder = currentTreePath.split('/')[0];
      const matched = localFolderPaths.find(p => {
        const name = p.split('/').pop() || p.split('\\').pop() || p;
        return name === topFolder;
      });
      if (matched) {
        const rest = currentTreePath.split('/').slice(1).join('/');
        diskPath = matched + (rest ? '/' + rest : '');
      }
    }
    if (!diskPath && localFolderPaths.length) diskPath = localFolderPaths[0];
    if (diskPath && window.bridge?.openPath) window.bridge.openPath(diskPath);
  }

  async function createFolderInSource() {
    // Determine the actual disk directory to create the folder in
    // If only one source folder, use that; if multiple, need to determine which one based on currentTreePath
    let parentDiskPath = '';
    if (localFolderPaths.length === 1) {
      parentDiskPath = localFolderPaths[0];
      if (currentTreePath) parentDiskPath += '/' + currentTreePath;
    } else if (localFolderPaths.length > 1) {
      // In multi-folder mode, the first part of currentTreePath is the folder name
      if (currentTreePath) {
        const topFolder = currentTreePath.split('/')[0];
        const matched = localFolderPaths.find(p => {
          const name = p.split('/').pop() || p.split('\\').pop() || p;
          return name === topFolder;
        });
        if (matched) {
          const rest = currentTreePath.split('/').slice(1).join('/');
          parentDiskPath = matched + (rest ? '/' + rest : '');
        }
      }
      if (!parentDiskPath) {
        // At root level with multiple sources — let user pick
        const choices = localFolderPaths.map(p => p.split('/').pop() || p).join('\n');
        alert('多个源文件夹，请先进入某个文件夹后再新建子文件夹。\n\n当前源文件夹:\n' + choices);
        return;
      }
    }
    if (!parentDiskPath) { alert('没有可用的源文件夹'); return; }

    const folderName = await showPrompt('新建文件夹名称：', '');
    if (!folderName || !folderName.trim()) return;

    const result = await window.bridge?.localFiles?.createFolder?.(parentDiskPath, folderName.trim());
    if (result?.success) {
      // Re-scan to pick up new folder and refresh view
      await refreshAllFolders();
    } else {
      alert('新建文件夹失败: ' + (result?.error || '未知错误'));
    }
  }

  function renderFileGrid() {
    const grid = $('su-file-grid');
    const empty = $('su-empty');
    if (!grid) return;
    const allFiltered = filteredFiles();

    // Get or create pagination container
    let pagBar = grid.parentElement.querySelector('.su-pagination-bar');
    if (!pagBar) {
      pagBar = document.createElement('div');
      pagBar.className = 'su-pagination-bar';
      grid.parentElement.appendChild(pagBar);
    }

    if (fileViewMode === 'tree') {
      // Tree mode: folders always shown, only paginate files
      const { folders, currentFiles } = getTreeItems(allFiltered, currentTreePath);
      const hasContent = folders.size > 0 || currentFiles.length > 0;
      empty.style.display = hasContent ? 'none' : 'flex';

      const totalFiles = currentFiles.length;
      const totalPages = Math.max(1, Math.ceil(totalFiles / pageSize));
      if (currentPage > totalPages) currentPage = totalPages;
      const startIdx = (currentPage - 1) * pageSize;
      const pagedFiles = currentFiles.slice(startIdx, startIdx + pageSize);

      let html = '';
      // Render folder cards (not paginated). Confirmed custom order stays on top; the rest remains name-sorted.
      const folderEntries = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
      const folderByRelPath = new Map(folderEntries.map(([name, info]) => [currentTreePath ? currentTreePath + '/' + name : name, [name, info]]));
      const pinnedFolderEntries = customFolderOrderPaths
        .map(relPath => folderByRelPath.get(relPath))
        .filter(Boolean);
      const pinnedFolderPaths = new Set(pinnedFolderEntries.map(([name]) => currentTreePath ? currentTreePath + '/' + name : name));
      [...pinnedFolderEntries, ...folderEntries.filter(([name]) => !pinnedFolderPaths.has(currentTreePath ? currentTreePath + '/' + name : name))].forEach(([name, info]) => {
        const folderRelPath = currentTreePath ? currentTreePath + '/' + name : name;
        let previewHtml = '';
        if (info.firstMedia) {
          if (info.firstMedia.type === 'image') {
            previewHtml = `<img class="su-folder-preview su-lazy" data-src="${info.firstMedia.src}" draggable="false" onerror="this.style.display='none'" />`;
          } else if (info.firstMedia.type === 'video') {
            previewHtml = `<video class="su-folder-preview su-lazy" data-src="${info.firstMedia.src}" muted preload="none" draggable="false" style="background:#1a1a1a;"></video>`;
          }
        }
        // Check if this folder is assigned (local-organize mode)
        const folderAssignKey = 'folder:' + folderRelPath;
        const folderSlotId = assignMap[folderAssignKey];
        const folderTarget = folderSlotId ? localTargetFolders.find(lf => lf.id === folderSlotId) : null;
        const folderAssignTag = folderTarget ? `<div class="su-file-tag" style="display:block;background:#e8f4fd;color:#2980b9;border:1px solid #2980b940">📁→ ${folderTarget.name}</div>` : '';
        const folderSelectedClass = selectedFolderPaths.has(folderRelPath) ? ' folder-selected' : '';
        const folderAssignedClass = folderTarget ? ' folder-assigned' : '';
        html += `<div class="su-file-card su-folder-card${folderSelectedClass}${folderAssignedClass}" data-folder="${folderRelPath}">
          <div class="su-file-check">✓</div>
          <div class="su-file-icon su-folder-icon">📁</div>
          ${previewHtml}
          <div class="su-file-info">
            <div class="su-file-name" title="${name}">${name}</div>
            <div class="su-file-size">${info.count} 个文件 · ${formatSize(info.totalSize)}</div>
            ${folderAssignTag}
          </div>
        </div>`;
      });
      // Render paginated file cards
      pagedFiles.forEach(f => { html += renderFileCard(f); });
      grid.innerHTML = html;

      // Folder click → local-organize: select folder as unit; upload: select files inside; double-click → navigate
      grid.querySelectorAll('.su-folder-card').forEach(card => {
        let clickTimer = null;
        card.addEventListener('click', (e) => {
          if (suppressNextFileCardClick) {
            suppressNextFileCardClick = false;
            return;
          }
          if (clickTimer) return;

          const folderPath = card.dataset.folder;

          if (workMode === 'local-organize') {
            // Toggle folder-level selection (move/copy the folder itself)
            if (selectedFolderPaths.has(folderPath)) {
              selectedFolderPaths.delete(folderPath);
              card.classList.remove('folder-selected');
            } else {
              selectedFolderPaths.add(folderPath);
              card.classList.add('folder-selected');
            }
            updateActionBar();
            clickTimer = setTimeout(() => { clickTimer = null; }, 250);
          } else {
            // Upload mode: select all files inside
            const ids = getFileIdsUnderTreeFolder(folderPath);
            if (!ids.length) return;
            const allSelected = ids.every(id => selectedIds.has(id));
            if (allSelected) {
              ids.forEach(id => selectedIds.delete(id));
              card.classList.remove('selected');
            } else {
              ids.forEach(id => selectedIds.add(id));
              card.classList.add('selected');
            }
            updateActionBar();
            clickTimer = setTimeout(() => {
              clickTimer = null;
              updateFileCardsInPlace();
              updateFolderCardSelectionState(grid);
            }, 250);
          }
        });
        card.addEventListener('dblclick', () => {
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
          // Revert any instant selection
          const folderPath = card.dataset.folder;
          if (workMode === 'local-organize') {
            selectedFolderPaths.delete(folderPath);
            card.classList.remove('folder-selected');
          } else {
            const ids = getFileIdsUnderTreeFolder(folderPath);
            ids.forEach(id => selectedIds.delete(id));
            card.classList.remove('selected');
          }
          currentTreePath = folderPath;
          currentPage = 1;
          renderFileGrid();
          renderBreadcrumb();
        });
        // 右键菜单
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const folderPath = card.dataset.folder;
          const diskPath = resolveRelPathToDisk(folderPath);
          const folderName = folderPath.split('/').pop() || folderPath;
          showLocalContextMenu(e.clientX, e.clientY, [
            // 设为目标文件夹（仅 local-organize 模式）
            ...(workMode === 'local-organize' && diskPath ? [{
              icon: '🎯', label: '设为目标文件夹',
              hidden: localTargetFolders.some(f => f.path === diskPath),
              action: () => {
                if (localTargetFolders.some(f => f.path === diskPath)) return;
                localTargetFolders.push({ id: 'lf-' + (++localTargetCounter) + '-' + Date.now(), name: folderName, path: diskPath, group: '' });
                saveLocalTargetFolders();
                renderSlotList();
              }
            }] : []),
            // 取消目标文件夹
            ...(workMode === 'local-organize' && diskPath && localTargetFolders.some(f => f.path === diskPath) ? [{
              icon: '🚫', label: '取消目标文件夹',
              action: () => {
                const target = localTargetFolders.find(f => f.path === diskPath);
                if (target) removeLocalFolder(target.id);
              }
            }] : []),
            // 重命名
            ...(diskPath ? [{ icon: '✏️', label: '重命名', action: async () => {
              const newName = await showPrompt('重命名文件夹：', folderName);
              if (!newName || !newName.trim() || newName.trim() === folderName) return;
              const result = await window.bridge?.renameLocalFiles?.([{ source: diskPath, newName: newName.trim() }]);
              if (result?.renamed?.length) {
                const oldPath = diskPath;
                const parentDir = oldPath.replace(/[/\\][^/\\]+$/, '');
                const separator = oldPath.includes('\\') ? '\\' : '/';
                const newPath = parentDir + separator + newName.trim();
                
                // Update all local paths, tabs, target folders, and assign maps
                updateLocalPathsAfterRename(oldPath, newPath, folderPath, newName.trim());
                
                // Adjust currentTreePath for the active tab if needed
                const tab = tabs.find(t => t.id === activeTabId);
                if (tab) {
                  const oldRelPath = folderPath;
                  const parentRel = oldRelPath.includes('/') ? oldRelPath.slice(0, oldRelPath.lastIndexOf('/')) : '';
                  const newRelPath = parentRel ? parentRel + '/' + newName.trim() : newName.trim();
                  
                  if (currentTreePath === oldRelPath) {
                    currentTreePath = newRelPath;
                  } else if (currentTreePath.startsWith(oldRelPath + '/')) {
                    currentTreePath = newRelPath + currentTreePath.slice(oldRelPath.length);
                  }
                  tab.currentTreePath = currentTreePath;
                }
                
                await refreshAllFolders();
              } else if (result?.errors?.length) {
                alert('重命名失败: ' + result.errors[0].message);
              }
            } }] : []),
            // 进入文件夹
            { icon: '📂', label: '进入文件夹', action: () => { currentTreePath = folderPath; currentPage = 1; renderFileGrid(); renderBreadcrumb(); } },
            // 在新标签页打开
            ...(diskPath ? [{ icon: '📑', label: '在新标签页打开', action: () => {
              const newTab = createTab(diskPath, folderName);
              saveTabs();
              switchTab(newTab.id);
              scanFolder(diskPath);
            }}] : []),
            // 新建子文件夹
            ...(diskPath ? [
              { icon: '📁', label: '新建子文件夹', action: () => promptCreateFolder(diskPath, folderName) },
              { icon: '🗂️', label: '批量新建子文件夹', action: () => promptCreateFolders(diskPath, folderName) }
            ] : []),
            // 在 Finder 中打开
            ...(diskPath ? [{ icon: '🔍', label: '在 Finder 中打开', action: () => { if (window.bridge?.openPath) window.bridge.openPath(diskPath); } }] : [])
          ]);
        });
      });

      renderPagination(pagBar, totalFiles, totalPages);
    } else {
      // Flat mode with pagination
      const totalFiles = allFiltered.length;
      const totalPages = Math.max(1, Math.ceil(totalFiles / pageSize));
      if (currentPage > totalPages) currentPage = totalPages;
      const startIdx = (currentPage - 1) * pageSize;
      const pagedFiles = allFiltered.slice(startIdx, startIdx + pageSize);

      empty.style.display = allFiltered.length ? 'none' : 'flex';
      grid.innerHTML = pagedFiles.map(f => renderFileCard(f)).join('');

      renderPagination(pagBar, totalFiles, totalPages);
    }

    // File click → select (preserved across pages via ID)
    grid.querySelectorAll('.su-file-card:not(.su-folder-card)').forEach(card => {
      card.addEventListener('click', (e) => {
        if (suppressNextFileCardClick) {
          suppressNextFileCardClick = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.target.closest('.su-video-badge') || e.target.closest('.su-file-delete')) return;
        const id = card.dataset.id;
        if (selectedIds.has(id)) {
          selectedIds.delete(id);
          card.classList.remove('selected');
        } else {
          selectedIds.add(id);
          card.classList.add('selected');
        }
        updateActionBar();
      });
      // 文件卡片右键菜单
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = card.dataset.id;
        const file = localFiles.find(f => f.id === id);
        if (!file) return;
        const items = [];
        // 重命名
        if (file.path) {
          items.push({ icon: '✏️', label: '重命名', action: async () => {
            const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
            const baseName = ext ? file.name.slice(0, -ext.length) : file.name;
            const newBase = await showPrompt('重命名文件：', baseName);
            if (!newBase || !newBase.trim() || newBase.trim() === baseName) return;
            const newFullName = newBase.trim() + ext;
            const result = await window.bridge?.renameLocalFiles?.([{ id: file.id, source: file.path, newName: newFullName }]);
            if (result?.renamed?.length) {
              file.name = result.renamed[0].name;
              file.path = result.renamed[0].path;
              renderFileGrid();
            } else if (result?.errors?.length) {
              alert('重命名失败: ' + result.errors[0].message);
            }
          } });
        }
        // 分配到目标（local-organize 模式）
        if (workMode === 'local-organize' && localTargetFolders.length > 0) {
          items.push({
            icon: '📌',
            label: `分配到目标… (${localTargetFolders.length})`,
            action: () => showLocalTargetPicker(id)
          });
          // 取消分配
          if (assignMap[id]) {
            items.push({ icon: '✕', label: '取消分配', action: () => {
              delete assignMap[id];
              updateFileCardsInPlace();
              updateActionBar();
            } });
          }
        }
        // 在 Finder 中打开
        if (file.path) {
          items.push({ icon: '🔍', label: '在 Finder 中打开', action: () => {
            // Open the parent directory
            const dir = file.path.replace(/[/\\][^/\\]+$/, '');
            if (window.bridge?.openPath) window.bridge.openPath(dir);
          } });

          items.push({ icon: '📋', label: '复制到剪贴板', action: async () => {
            const res = await window.bridge?.localFiles?.copyToClipboard([file.path]);
            if (res && res.success) {
              if (typeof showToast === 'function') showToast('✅ 已复制到剪贴板', 'success');
            } else {
              if (typeof showToast === 'function') showToast('❌ 复制失败', 'error');
            }
          } });
        }
        if (items.length) showLocalContextMenu(e.clientX, e.clientY, items);
      });
    });
    // Video play button
    grid.querySelectorAll('.su-video-badge').forEach(badge => {
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        const src = badge.dataset.videoSrc;
        if (src) showVideoPlayer(src);
      });
    });
    // File delete button → move to waste folder (废品箱)
    grid.querySelectorAll('.su-file-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const fid = btn.dataset.fileId;
        const file = localFiles.find(f => f.id === fid);
        if (!file || !file.path) {
          // No path → just remove from list
          localFiles = localFiles.filter(f => f.id !== fid);
          selectedIds.delete(fid);
          delete assignMap[fid];
          delete localOrgDone[fid];
          btn.closest('.su-file-card')?.remove();
          updateActionBar();
          return;
        }

        // Determine waste target directory
        let targetDir = wasteFolderPath;
        if (!targetDir) {
          // Auto-create '_废品' folder next to the file
          const fileDirParts = file.path.replace(/\\/g, '/').split('/');
          fileDirParts.pop(); // remove filename
          const fileDir = fileDirParts.join('/');
          targetDir = fileDir + '/_废品';
        }

        // Move via bridge
        try {
          const card = btn.closest('.su-file-card');
          if (card) card.style.opacity = '0.4';
          const result = await window.bridge?.localFiles?.moveToFolder?.(file.path, targetDir);
          if (result?.success) {
            localFiles = localFiles.filter(f => f.id !== fid);
            selectedIds.delete(fid);
            delete assignMap[fid];
            delete localOrgDone[fid];
            card?.remove();
            updateActionBar();
          } else {
            if (card) card.style.opacity = '';
            console.warn('Move to waste failed:', result?.error);
            alert('移入废品箱失败: ' + (result?.error || '未知错误'));
          }
        } catch (err) {
          console.error('Waste move error:', err);
          alert('移入废品箱出错: ' + err.message);
        }
      });
    });

    // Image hover preview and double-click lightbox
    grid.querySelectorAll('img.su-file-thumb').forEach(img => {
      // 1. Hover preview (悬浮放大)
      let popup = null;
      img.addEventListener('mouseenter', (e) => {
        if (!window.hoverMagnifyEnabled) return;

        popup = document.createElement('div');
        popup.className = 'su-image-preview-popup';
        const previewImg = document.createElement('img');
        previewImg.src = img.src || img.dataset.src;
        popup.appendChild(previewImg);
        document.body.appendChild(popup);

        // Initial position
        let w = popup.offsetWidth || 100;
        let h = popup.offsetHeight || 100;
        let left = e.clientX + 15;
        let top = Math.max(10, e.clientY - h / 2);
        if (left + w > window.innerWidth) left = e.clientX - w - 15;
        if (top + h > window.innerHeight) top = window.innerHeight - h - 10;
        popup.style.transform = `translate(${left}px, ${top}px)`;
      });

      img.addEventListener('mousemove', (e) => {
        if (popup) {
          let w = popup.offsetWidth;
          let h = popup.offsetHeight;
          let left = e.clientX + 15;
          let top = Math.max(10, e.clientY - h / 2);
          if (left + w > window.innerWidth) left = e.clientX - w - 15;
          if (top + h > window.innerHeight) top = window.innerHeight - h - 10;
          popup.style.transform = `translate(${left}px, ${top}px)`;
        }
      });
      img.addEventListener('mouseleave', () => {
        if (popup) { popup.remove(); popup = null; }
      });

      // 2. Double-Click to open Lightbox for zoom & pan
      img.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (popup) { popup.remove(); popup = null; popupRect = null; }
        showImageLightbox(img.src || img.dataset.src);
      });
    });

    // Lazy load thumbnails via IntersectionObserver
    setupLazyLoad(grid);
    updateFolderCardSelectionState(grid);

    renderBreadcrumb();
    renderSourceFoldersBar();
  }

  function showImageLightbox(src) {
    const overlay = document.createElement('div');
    overlay.className = 'su-lightbox-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:999999;display:flex;align-items:center;justify-content:center;overflow:hidden;user-select:none;';

    const img = document.createElement('img');
    img.src = toSafeFileUrl(src);
    img.style.cssText = 'max-width:90vw;max-height:90vh;object-fit:contain;transition:transform 0.1s;cursor:grab;transform-origin:center;';
    img.draggable = false;

    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let isDragging = false;
    let startX, startY;

    const updateTransform = () => {
      img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    };

    // Zoom to mouse position
    const onWheel = (e) => {
      e.preventDefault();
      const zoomSensitivity = 0.05;
      const delta = e.deltaY < 0 ? 1 : -1;
      let newScale = scale + delta * zoomSensitivity * scale;
      newScale = Math.min(Math.max(0.1, newScale), 20);

      // Calculate mouse position relative to center of screen
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;

      translateX -= (e.clientX - cx - translateX) * (newScale / scale - 1);
      translateY -= (e.clientY - cy - translateY) * (newScale / scale - 1);

      scale = newScale;
      updateTransform();
    };
    overlay.addEventListener('wheel', onWheel, { passive: false });

    // Pan
    const onMouseDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      isDragging = true;
      startX = e.clientX - translateX;
      startY = e.clientY - translateY;
      img.style.cursor = 'grabbing';
      img.style.transition = 'none';
    };
    img.addEventListener('mousedown', onMouseDown);

    const onMouseMove = (e) => {
      if (!isDragging) return;
      translateX = e.clientX - startX;
      translateY = e.clientY - startY;
      updateTransform();
    };
    window.addEventListener('mousemove', onMouseMove);

    const onMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        img.style.cursor = 'grab';
        img.style.transition = 'transform 0.1s';
      }
    };
    window.addEventListener('mouseup', onMouseUp);

    // Close
    const onClick = (e) => {
      if (!isDragging && e.target === overlay) close();
    };
    overlay.addEventListener('click', onClick);

    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);

    const close = () => {
      overlay.remove();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKey);
    };

    overlay.appendChild(img);
    document.body.appendChild(overlay);
  }

  let _lazyObserver = null;
  let _videoThumbActive = 0;
  const _videoThumbQueue = [];
  const MAX_VIDEO_THUMB_LOADS = 3;

  function pumpVideoThumbQueue() {
    while (_videoThumbActive < MAX_VIDEO_THUMB_LOADS && _videoThumbQueue.length) {
      const el = _videoThumbQueue.shift();
      if (!el?.isConnected || el.dataset.thumbVisible !== '1' || el.dataset.thumbLoading === '1' || el.src) {
        continue;
      }
      const src = el.dataset.src;
      if (!src) continue;
      _videoThumbActive += 1;
      el.dataset.thumbLoading = '1';
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        delete el.dataset.thumbLoading;
        delete el._suCancelThumbLoad;
        _videoThumbActive = Math.max(0, _videoThumbActive - 1);
        pumpVideoThumbQueue();
      };
      el._suCancelThumbLoad = finish;
      el.preload = 'metadata';
      el.addEventListener('loadeddata', () => {
        try {
          const targetTime = Number.isFinite(el.duration) && el.duration > 0
            ? Math.min(1, el.duration / 3)
            : 0;
          if (targetTime > 0) {
            el.addEventListener('seeked', finish, { once: true });
            el.currentTime = targetTime;
            setTimeout(finish, 1500);
          } else {
            finish();
          }
        } catch (_) {
          finish();
        }
      }, { once: true });
      el.addEventListener('error', finish, { once: true });
      el.src = src;
    }
  }

  function queueVideoThumbnail(el) {
    if (el.dataset.thumbQueued === '1' || el.dataset.thumbLoading === '1' || el.src) return;
    el.dataset.thumbQueued = '1';
    _videoThumbQueue.push(el);
    requestAnimationFrame(() => {
      delete el.dataset.thumbQueued;
      pumpVideoThumbQueue();
    });
  }

  function unloadVideoThumbnail(el) {
    el.dataset.thumbVisible = '0';
    el._suCancelThumbLoad?.();
    if (el.src) {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch (_) {}
    }
  }

  function loadLazyMediaElement(el) {
    const src = el.dataset.src;
    if (!src) return;
    if (el.tagName === 'VIDEO') {
      el.dataset.thumbVisible = '1';
      queueVideoThumbnail(el);
      return;
    }
    el.src = src;
    el.removeAttribute('data-src');
    el.classList.remove('su-lazy');
  }

  function setupLazyLoad(container) {
    // Cleanup previous observer
    if (_lazyObserver) _lazyObserver.disconnect();
    _lazyObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const el = entry.target;
        if (entry.isIntersecting) {
          loadLazyMediaElement(el);
          if (el.tagName !== 'VIDEO') _lazyObserver.unobserve(el);
        } else if (el.tagName === 'VIDEO') {
          unloadVideoThumbnail(el);
        }
      });
    }, { root: container.closest('.su-file-area'), rootMargin: '120px 0px', threshold: 0.01 });
    const lazyEls = container.querySelectorAll('.su-lazy[data-src]');
    lazyEls.forEach(el => _lazyObserver.observe(el));
    // Force re-check: IntersectionObserver may miss elements already in viewport on first observe
    requestAnimationFrame(() => {
      lazyEls.forEach(el => {
        if (!el.dataset.src) return; // already loaded
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight + 120 && rect.bottom > -120) {
          loadLazyMediaElement(el);
          if (el.tagName !== 'VIDEO') _lazyObserver.unobserve(el);
        }
      });
    });
  }

  /** Lightweight in-place update: patches selection, assignment tags, and upload status on existing cards without re-rendering thumbnails. */
  function updateFileCardsInPlace() {
    const grid = $('su-file-grid');
    if (!grid) return;
    grid.querySelectorAll('.su-file-card:not(.su-folder-card)').forEach(card => {
      const id = card.dataset.id;
      if (!id) return;

      // Update selected state
      card.classList.toggle('selected', selectedIds.has(id));

      // Update assigned state & tag
      const aSlot = assignMap[id];
      let tagName = '', tagColor = '';
      if (workMode === 'local-organize') {
        const folder = aSlot ? localTargetFolders.find(lf => lf.id === aSlot) : null;
        card.classList.toggle('assigned', !!folder);
        tagName = folder ? folder.name : '';
      } else {
        const slot = aSlot ? getSlots().find(s => s.id === aSlot) : null;
        card.classList.toggle('assigned', !!slot);
        tagName = slot ? getSlotName(slot) : '';
      }
      // Update or create tag element
      let tagEl = card.querySelector('.su-file-tag');
      if (tagName) {
        if (!tagEl) {
          tagEl = document.createElement('div');
          tagEl.className = 'su-file-tag';
          tagEl.style.cssText = 'display:block;background:#fef3e2;color:#e67e22;border:1px solid #f5c78440';
          card.querySelector('.su-file-info')?.appendChild(tagEl);
        }
        tagEl.textContent = '→ ' + tagName;
        tagEl.style.display = 'block';
      } else if (tagEl) {
        tagEl.style.display = 'none';
      }

      // Update upload/move status
      const doneInfo = workMode === 'local-organize' ? localOrgDone[id] : uploadedMap[id];
      card.classList.toggle('upload-done', doneInfo?.status === 'done');
      card.classList.toggle('upload-fail', doneInfo?.status === 'fail');
      let statusEl = card.querySelector('.su-file-upload-status');
      if (doneInfo) {
        const actionLabel = workMode === 'local-organize' ? (doneInfo.action === 'move' ? '移动' : '复制') : '上传';
        if (!statusEl) {
          statusEl = document.createElement('div');
          statusEl.className = 'su-file-upload-status';
          card.querySelector('.su-file-info')?.appendChild(statusEl);
        }
        if (doneInfo.status === 'done') {
          statusEl.className = 'su-file-upload-status su-file-upload-done';
          statusEl.textContent = `✅ ${actionLabel}成功 → ${doneInfo.folderName || ''}`;
        } else {
          statusEl.className = 'su-file-upload-status su-file-upload-fail';
          statusEl.textContent = `❌ ${actionLabel}失败`;
        }
      } else if (statusEl) {
        statusEl.remove();
      }
    });

    // Folder cards use a folder-prefixed assignment key, so update their target
    // labels here as well. Previously they were only correct after a full render.
    grid.querySelectorAll('.su-folder-card[data-folder]').forEach(card => {
      const targetId = assignMap['folder:' + card.dataset.folder];
      const target = targetId ? localTargetFolders.find(folder => folder.id === targetId) : null;
      card.classList.toggle('folder-assigned', Boolean(target));
      let tagEl = card.querySelector('.su-file-tag');
      if (target) {
        if (!tagEl) {
          tagEl = document.createElement('div');
          tagEl.className = 'su-file-tag';
          card.querySelector('.su-file-info')?.appendChild(tagEl);
        }
        tagEl.style.cssText = 'display:block;background:#e8f4fd;color:#2980b9;border:1px solid #2980b940';
        tagEl.textContent = '📁→ ' + target.name;
      } else if (tagEl) {
        tagEl.remove();
      }
    });
    updateFolderCardSelectionState(grid);
  }

  function renderPagination(container, totalFiles, totalPages) {
    if (totalPages <= 1) {
      container.innerHTML = totalFiles > 0
        ? `<span class="su-pag-info">共 ${totalFiles} 个文件</span>`
        : '';
      return;
    }
    // Generate page buttons
    let pages = [];
    const MAX_VISIBLE = 7;
    if (totalPages <= MAX_VISIBLE) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      let start = Math.max(2, currentPage - 2);
      let end = Math.min(totalPages - 1, currentPage + 2);
      if (start > 2) pages.push('...');
      for (let i = start; i <= end; i++) pages.push(i);
      if (end < totalPages - 1) pages.push('...');
      pages.push(totalPages);
    }

    const startFile = (currentPage - 1) * pageSize + 1;
    const endFile = Math.min(currentPage * pageSize, totalFiles);

    let html = `<span class="su-pag-info">${startFile}-${endFile} / ${totalFiles}</span>`;
    html += `<button class="su-pag-btn${currentPage <= 1 ? ' disabled' : ''}" data-page="prev" ${currentPage <= 1 ? 'disabled' : ''}>‹</button>`;
    pages.forEach(p => {
      if (p === '...') {
        html += `<span class="su-pag-dots">…</span>`;
      } else {
        html += `<button class="su-pag-btn${p === currentPage ? ' active' : ''}" data-page="${p}">${p}</button>`;
      }
    });
    html += `<button class="su-pag-btn${currentPage >= totalPages ? ' disabled' : ''}" data-page="next" ${currentPage >= totalPages ? 'disabled' : ''}>›</button>`;
    html += `<span class="su-pag-jump"><input type="number" class="su-pag-jump-input" min="1" max="${totalPages}" value="${currentPage}" title="输入页码后按回车跳转" /><span class="su-pag-jump-total">/ ${totalPages}</span><button class="su-pag-jump-btn">跳转</button></span>`;
    html += `<select class="su-pag-size" title="每页显示数量">
      ${[50, 100, 200, 500].map(n => `<option value="${n}"${n === pageSize ? ' selected' : ''}>${n}/页</option>`).join('')}
    </select>`;
    container.innerHTML = html;

    // Bind events
    container.querySelectorAll('.su-pag-btn:not(.disabled)').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.page;
        if (p === 'prev') currentPage = Math.max(1, currentPage - 1);
        else if (p === 'next') currentPage = Math.min(totalPages, currentPage + 1);
        else currentPage = parseInt(p);
        renderFileGrid();
      });
    });
    // Page jump
    const jumpInput = container.querySelector('.su-pag-jump-input');
    const jumpBtn = container.querySelector('.su-pag-jump-btn');
    const doJump = () => {
      const val = parseInt(jumpInput?.value);
      if (val && val >= 1 && val <= totalPages) {
        currentPage = val;
        renderFileGrid();
      }
    };
    jumpBtn?.addEventListener('click', doJump);
    jumpInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doJump(); } });
    const sizeSelect = container.querySelector('.su-pag-size');
    if (sizeSelect) {
      sizeSelect.addEventListener('change', () => {
        pageSize = parseInt(sizeSelect.value);
        currentPage = 1;
        renderFileGrid();
      });
    }
  }

  // ── Sync filter toolbar UI to match in-memory state (for tab switches) ──
  function syncFilterUI() {
    const searchEl = $('su-search');
    if (searchEl) searchEl.value = searchQuery;
    const fileSearchBtn = $('su-file-search-toggle-btn');
    if (fileSearchBtn) {
      if (searchQuery) {
        fileSearchBtn.style.background = '#e8f0fe';
        fileSearchBtn.style.color = '#3b82f6';
        fileSearchBtn.style.borderColor = '#3b82f6';
      } else {
        fileSearchBtn.style.background = '';
        fileSearchBtn.style.color = '';
        fileSearchBtn.style.borderColor = '';
      }
    }
    const dateEl = $('su-date-filter');
    if (dateEl) dateEl.value = dateFilter;
    const nameFilterEl = $('su-name-filter');
    if (nameFilterEl) nameFilterEl.value = nameFilterMode;
    const nameFilterInput = $('su-name-filter-input');
    if (nameFilterInput) {
      nameFilterInput.value = nameFilterQuery;
      nameFilterInput.style.display = nameFilterMode === 'all' ? 'none' : 'inline-block';
    }
    const sortEl = $('su-sort-order');
    if (sortEl) sortEl.value = sortOrder;

    // Sync custom date inputs
    const customStartEl = $('su-date-custom-start');
    if (customStartEl) customStartEl.value = customStart;
    const customEndEl = $('su-date-custom-end');
    if (customEndEl) customEndEl.value = customEnd;
    const customMonthEl = $('su-month-custom-val');
    if (customMonthEl) customMonthEl.value = customMonth;

    // Toggle custom date wrapper visibility
    const customWrap = $('su-date-custom-wrap');
    const monthWrap = $('su-month-custom-wrap');
    if (customWrap) {
      customWrap.style.display = (dateFilter === 'custom') ? 'inline-flex' : 'none';
    }
    if (monthWrap) {
      monthWrap.style.display = (dateFilter === 'custom-month') ? 'inline-flex' : 'none';
    }

    // Type chips
    document.querySelectorAll('.su-type-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.type === typeFilter);
    });
    // View mode buttons
    document.querySelectorAll('.su-view-mode').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === fileViewMode);
    });
  }

  // ── Render slot sidebar ──
  function renderSlotList() {
    if (workMode === 'local-organize' || workMode === 'local-dual') {
      renderLocalFolderList();
      if (workMode === 'local-dual') renderSymmetricDualWorkspace();
      return;
    }
    const container = $('su-slot-list');
    if (!container) return;
    const slots = getSlots();
    const q = slotSearchQuery.toLowerCase();
    const filtered = slots.filter(s => {
      if (!q) return true;
      const name = getSlotName(s).toLowerCase();
      const group = (s.groupLabel || '').toLowerCase();
      return name.includes(q) || group.includes(q);
    });

    // Group by groupLabel
    const groups = {};
    const ungrouped = [];
    filtered.forEach(s => {
      const g = s.groupLabel || '';
      if (g) { (groups[g] = groups[g] || []).push(s); } else { ungrouped.push(s); }
    });

    let html = '';
    // Grouped
    Object.keys(groups).sort().forEach(gName => {
      const collapsed = collapsedGroups.has(gName);
      html += `<div class="su-slot-group-label${collapsed ? ' collapsed' : ''}" data-group="${gName}">
        <span class="su-group-arrow">▾</span> ${gName} (${groups[gName].length})
      </div>`;
      html += `<div class="su-slot-group-items${collapsed ? ' collapsed' : ''}">`;
      groups[gName].forEach(s => { html += slotCardHTML(s, slots); });
      html += `</div>`;
    });
    // Ungrouped
    if (ungrouped.length) {
      if (Object.keys(groups).length) {
        html += `<div class="su-slot-group-label" style="cursor:default"><span class="su-group-arrow">▾</span> 未分组 (${ungrouped.length})</div>`;
      }
      ungrouped.forEach(s => { html += slotCardHTML(s, slots); });
    }
    container.innerHTML = html;

    // Group toggle
    container.querySelectorAll('.su-slot-group-label[data-group]').forEach(el => {
      el.addEventListener('click', () => {
        const g = el.dataset.group;
        if (collapsedGroups.has(g)) collapsedGroups.delete(g); else collapsedGroups.add(g);
        renderSlotList();
      });
    });
    // Slot click → assign
    container.querySelectorAll('.su-slot-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.su-slot-extra-link')) return;
        if (e.target.closest('.su-slot-target-link')) return;
        if (e.target.closest('.su-slot-settings-btn')) return;
        assignSelectedToSlot(card.dataset.slotId);
      });
    });
    // Settings button → open per-slot editor
    container.querySelectorAll('.su-slot-settings-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSlotSettings(btn.dataset.slotId);
      });
    });
    // Avatar click → open preview modal
    container.querySelectorAll('.su-slot-avatar').forEach(img => {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        const modal = $('su-avatar-preview-modal');
        const previewImg = $('su-avatar-preview-img');
        if (modal && previewImg) {
          previewImg.src = img.src;
          modal.hidden = false;
        }
      });
    });
    // Extra link → open in Chrome
    container.querySelectorAll('.su-slot-extra-link').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const url = a.dataset.url;
        if (url) window.bridge?.openExternal?.(url);
      });
    });
    // Target link → open target folder
    container.querySelectorAll('.su-slot-target-link').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const url = a.dataset.url;
        if (url) window.bridge?.openExternal?.(url);
      });
    });
  }

  async function openDualTarget(folderPath) {
    if (!folderPath) return;
    dualTargetPath = folderPath;
    if (!dualTargetRoot) dualTargetRoot = folderPath;
    renderDualTargetBrowser(true);
    const result = await window.bridge?.localFiles?.listDirectory?.(folderPath);
    if (!result?.exists) {
      dualTargetItems = [];
      if (typeof showToast === 'function') showToast('目标文件夹不存在或无法访问', 'error');
    } else {
      dualTargetItems = result.items || [];
    }
    renderDualTargetBrowser();
  }

  function renderDualTargetBrowser(loading = false) {
    const container = $('su-slot-list');
    if (!container) return;
    const targets = localTargetFolders.filter(folder => !folder.archived);
    const title = dualTargetPath ? esc(dualTargetPath) : '请先从下方选择一个目标文件夹';
    const itemHtml = loading
      ? '<div class="su-dual-empty">正在读取目标目录…</div>'
      : dualTargetPath
        ? (dualTargetItems.length ? dualTargetItems.map(item => `<button class="su-dual-entry" data-path="${esc(item.path)}" data-dir="${item.isDirectory ? '1' : ''}" title="${esc(item.path)}"><span>${item.isDirectory ? '📁' : '📄'}</span><span>${esc(item.name)}</span></button>`).join('') : '<div class="su-dual-empty">此文件夹为空</div>')
        : '<div class="su-dual-empty">选择一个目标文件夹后，内容会显示在这里</div>';
    const canUp = dualTargetPath && dualTargetRoot && dualTargetPath !== dualTargetRoot;
    container.innerHTML = `<div class="su-dual-browser">
      <div class="su-dual-head"><strong>📁 右侧目标目录</strong><div><button class="su-dual-btn" data-action="up" ${canUp ? '' : 'disabled'}>↑ 上级</button><button class="su-dual-btn" data-action="open" ${dualTargetPath ? '' : 'disabled'}>↗ 打开</button><button class="su-dual-btn" data-action="refresh" ${dualTargetPath ? '' : 'disabled'}>🔄</button></div></div>
      <div class="su-dual-path" title="${title}">${title}</div>
      <div class="su-dual-shortcuts">${targets.map(folder => `<button class="su-dual-shortcut${folder.path === dualTargetRoot ? ' active' : ''}" data-target-path="${esc(folder.path)}">📌 ${esc(folder.name)}</button>`).join('') || '<span>尚未添加目标文件夹</span>'}</div>
      <div class="su-dual-entries">${itemHtml}</div>
    </div>`;
    container.querySelectorAll('[data-target-path]').forEach(btn => btn.addEventListener('click', () => { dualTargetRoot = btn.dataset.targetPath; openDualTarget(btn.dataset.targetPath); }));
    container.querySelectorAll('.su-dual-entry[data-dir="1"]').forEach(btn => btn.addEventListener('dblclick', () => openDualTarget(btn.dataset.path)));
    container.querySelector('[data-action="up"]')?.addEventListener('click', () => {
      const parent = dualTargetPath.replace(/[/\\][^/\\]+$/, '');
      if (parent && parent.startsWith(dualTargetRoot)) openDualTarget(parent);
    });
    container.querySelector('[data-action="open"]')?.addEventListener('click', () => window.bridge?.openPath?.(dualTargetPath));
    container.querySelector('[data-action="refresh"]')?.addEventListener('click', () => openDualTarget(dualTargetPath));
  }

  // Parse =IMAGE("url") formula to extract URL
  function parseImageFormula(val) {
    if (!val) return '';
    const m = val.match(/=IMAGE\s*\(\s*"([^"]+)"\s*/i);
    if (m) return m[1];
    if (/^(https?|data|blob|local-media):/i.test(val)) {
      const gyazoMatch = val.match(/^https?:\/\/gyazo\.com\/([a-zA-Z0-9]+)/i);
      if (gyazoMatch) return `https://i.gyazo.com/${gyazoMatch[1]}.png`;
      return val;
    }
    return toSafeFileUrl(val);
  }

  function slotCardHTML(s, allSlots) {
    const idx = allSlots.indexOf(s);
    const color = COLORS[idx % COLORS.length];
    const count = Object.values(assignMap).filter(id => id === s.id).length;
    const name = getSlotName(s);
    const mode = s.mode === 'custom-link' ? '自定义' : '入库';
    let avatar = parseImageFormula(s.avatar || '');
    const extraLink = s.extraLink || '';
    const targetLink = s.customLink || s.lastFolderLink || '';

    let isAuto = false;
    if (!avatar && targetLink) {
      const folderId = parseDriveLink(targetLink);
      if (folderId) {
        const cached = autoCloudAvatarCache[folderId];
        if (typeof cached === 'string') {
          avatar = cached;
          isAuto = true;
        } else if (cached === undefined) {
          autoCloudAvatarCache[folderId] = null;
          loadCloudAutoAvatar(folderId);
        }
      }
    }

    return `<div class="su-slot-card" data-slot-id="${s.id}">
      <div class="su-slot-card-inner">
        ${avatar ? `<img class="su-slot-avatar${isAuto ? ' auto-avatar' : ''}" src="${avatar}" onerror="this.style.display='none';this.nextElementSibling.style.display=''" title="${isAuto ? '自动获取的最近云端素材头像' : ''}" /><span class="su-slot-avatar-placeholder" style="background:${color};display:none">${(name || '?')[0]}</span>` : `<span class="su-slot-avatar-placeholder" style="background:${color}">${(name || '?')[0]}</span>`}
        <div class="su-slot-card-body">
          <div class="su-slot-name">${name}</div>
          <div class="su-slot-meta">${mode}${s.groupLabel ? ' · ' + s.groupLabel : ''}${s.admin ? ' · ' + s.admin : ''}</div>
          ${extraLink ? `<a class="su-slot-extra-link" href="#" data-url="${extraLink}" title="${extraLink}">🔗 账号链接</a>` : ''}
          ${targetLink ? `<a class="su-slot-target-link" href="#" data-url="${targetLink}" title="${targetLink}">📂 打开目标</a>` : ''}
        </div>
        <button class="su-slot-settings-btn" data-slot-id="${s.id}" title="设置">⚙</button>
      </div>
      ${count ? `<div class="su-slot-count">${count}</div>` : ''}
    </div>`;
  }

  // ── Per-slot settings modal ──
  function openSlotSettings(slotId) {
    const slots = getSlots();
    const s = slots.find(x => x.id === slotId);
    if (!s) return;

    let modal = $('su-slot-settings-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'su-slot-settings-modal';
      modal.className = 'su-modal-overlay';
      document.body.appendChild(modal);
    }
    modal.hidden = false;

    const isCustom = s.mode === 'custom-link';
    const name = getSlotName(s);

    modal.innerHTML = `
      <div class="su-modal su-slot-settings-dialog" style="max-width:520px;">
        <div class="su-modal-header">
          <h3>⚙ 设置 - ${name}</h3>
          <button class="su-close-btn" id="su-slot-settings-close">✕</button>
        </div>
        <div class="su-modal-body" style="max-height:70vh;overflow-y:auto;">
          <div class="su-settings-grid">
            <label>卡片名称</label>
            <input type="text" data-field="displayName" value="${s.displayName || ''}" placeholder="输入卡片名称" />

            <label>头像</label>
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" data-field="avatar" value="${s.avatar || ''}" placeholder="图片URL或本地路径" style="flex:1" />
              <button class="su-btn su-ss-pick-avatar" type="button" style="white-space:nowrap">选择</button>
            </div>

            <label>分组</label>
            <input type="text" data-field="groupLabel" value="${s.groupLabel || ''}" placeholder="分组名" />

            <label>模式</label>
            <select data-field="mode" class="su-ss-mode-sel">
              <option value="library"${!isCustom ? ' selected' : ''}>入库</option>
              <option value="custom-link"${isCustom ? ' selected' : ''}>自定义</option>
            </select>

            <div class="su-ss-lib-fields" ${isCustom ? 'style="display:none"' : ''}>
              <label>分类</label>
              <select data-field="mainCategory" class="su-ss-main-cat">${getMainOptions(s.mainCategory)}</select>
              <label>子分类</label>
              <select data-field="subCategory" class="su-ss-sub-cat">${getSubOptions(s.mainCategory, s.subCategory)}</select>
              <label>主题</label>
              <input type="text" data-field="subject" value="${s.subject || ''}" placeholder="图片描述/主题" />
              <label>专页名称</label>
              <input type="text" data-field="pageName" value="${s.pageName || ''}" />
              <label>管理员</label>
              <input type="text" data-field="admin" value="${s.admin || ''}" />
              <label>分发方式</label>
              <input type="text" data-field="distribution" value="${s.distribution || ''}" />
              <label>事件名称</label>
              <input type="text" data-field="eventName" value="${s.eventName || ''}" />
            </div>

            <div class="su-ss-custom-fields" ${!isCustom ? 'style="display:none"' : ''}>
              <label>目标链接</label>
              <input type="text" data-field="customLink" value="${s.customLink || ''}" placeholder="Drive文件夹链接或ID" />
            </div>

            <label>任务类型 <span style="color:#e53935">*</span></label>
            <select data-field="taskType" class="su-ss-task-type">${getTaskTypeOptions(s.taskType || '')}</select>

            <label>命名规则</label>
            <select data-field="namingPresetId">${getNamingOptions(s.namingPresetId || '')}</select>

            <label>文件夹命名</label>
            <select data-field="folderNamingPresetId">${getNamingOptions(s.folderNamingPresetId || '')}</select>

            <label>跳过子文件夹</label>
            <input type="checkbox" data-field="skipCreateSubfolder" ${s.skipCreateSubfolder ? 'checked' : ''} />

            <label>账号链接</label>
            <input type="text" data-field="extraLink" value="${s.extraLink || ''}" placeholder="账号/专页链接" />

            <div style="grid-column:1/-1;border-top:1px solid #eee;padding-top:10px;display:grid;grid-template-columns:90px 1fr;gap:8px 12px;align-items:center;">
              <label>启用审核</label>
              <input type="checkbox" data-field="reviewEnabled" class="su-ss-review-toggle" ${s.reviewEnabled ? 'checked' : ''} />
              <label>审核目录</label>
              <input type="text" data-field="reviewFolderLink" value="${s.reviewFolderLink || ''}" placeholder="审核临时目录链接（可选）" ${!s.reviewEnabled ? 'disabled' : ''} />
            </div>
          </div>
        </div>
        <div class="su-modal-footer" style="display:flex;justify-content:space-between;gap:8px;padding:12px 16px;border-top:1px solid #eee;">
          <button class="su-btn" id="su-slot-settings-delete" style="color:#d32f2f;border-color:#d32f2f;">🗑️ 删除卡片</button>
          <div style="display:flex;gap:8px;">
            <button class="su-btn" id="su-slot-settings-cancel">取消</button>
            <button class="su-btn su-btn-primary" id="su-slot-settings-save">保存</button>
          </div>
        </div>
      </div>`;

    // Mode toggle
    const modeSel = modal.querySelector('.su-ss-mode-sel');
    modeSel?.addEventListener('change', () => {
      const isCust = modeSel.value === 'custom-link';
      const libFields = modal.querySelector('.su-ss-lib-fields');
      const custFields = modal.querySelector('.su-ss-custom-fields');
      if (libFields) libFields.style.display = isCust ? 'none' : '';
      if (custFields) custFields.style.display = isCust ? '' : 'none';
    });

    // Main → Sub cascade
    const mainSel = modal.querySelector('.su-ss-main-cat');
    mainSel?.addEventListener('change', () => {
      const subSel = modal.querySelector('.su-ss-sub-cat');
      if (subSel) subSel.innerHTML = getSubOptions(mainSel.value, '');
    });

    // Review toggle → enable/disable review folder input
    const reviewToggle = modal.querySelector('.su-ss-review-toggle');
    reviewToggle?.addEventListener('change', () => {
      const folderInput = modal.querySelector('[data-field="reviewFolderLink"]');
      if (folderInput) folderInput.disabled = !reviewToggle.checked;
    });

    // Avatar file picker (use IPC for native dialog)
    modal.querySelector('.su-ss-pick-avatar')?.addEventListener('click', async () => {
      const imgPath = await window.bridge?.localFiles?.pickImage?.();
      if (imgPath) modal.querySelector('[data-field="avatar"]').value = imgPath;
    });

    // Close / Cancel
    const closeModal = () => { modal.hidden = true; };
    modal.querySelector('#su-slot-settings-close')?.addEventListener('click', closeModal);
    modal.querySelector('#su-slot-settings-cancel')?.addEventListener('click', closeModal);

    // Delete
    modal.querySelector('#su-slot-settings-delete')?.addEventListener('click', () => {
      if (confirm('确定要删除此卡片吗？该操作不可恢复。')) {
        if (typeof removeSlot === 'function') {
          removeSlot(s.id);
        } else {
          const slots = getSlots();
          const idx = slots.findIndex(x => x.id === s.id);
          if (idx !== -1) slots.splice(idx, 1);
        }
        if (typeof persistSlotPresets === 'function') persistSlotPresets();
        if (typeof renderSlots === 'function') renderSlots();
        renderSlotList();
        closeModal();
      }
    });

    // Save
    modal.querySelector('#su-slot-settings-save')?.addEventListener('click', () => {
      modal.querySelectorAll('[data-field]').forEach(el => {
        const field = el.dataset.field;
        if (field === 'skipCreateSubfolder' || field === 'reviewEnabled') {
          s[field] = el.checked;
          return;
        }
        const val = el.value;
        if (field === 'mode') { s.mode = val; }
        else { s[field] = val; }
        if (field === 'customLink' && val) {
          s.customFolderId = (typeof extractDriveFolderId === 'function') ? extractDriveFolderId(val) : val;
        }
      });
      if (typeof persistSlotPresets === 'function') persistSlotPresets();
      if (typeof renderSlots === 'function') renderSlots();
      renderSlotList();
      closeModal();
    });
  }

  // ── Assign files to slot ──
  function assignSelectedToSlot(slotId) {
    if (workMode === 'local-dual') {
      const folder = localTargetFolders.find(f => f.id === slotId);
      if (!folder?.path) return;
      const targetPath = folder.path;
      let assigned = 0;
      dualPaneOrder.slice(0, dualLayoutCount).forEach(sourceSide => {
        if (dualPanes[sourceSide]?.role !== 'source') return;
        const sourceTab = activeDualTab(sourceSide);
        if (!sourceTab?.selected?.size) return;
        sourceTab.selected.forEach(sourcePath => {
          dualAssignments.set(sourcePath, targetPath);
          assigned += 1;
        });
        sourceTab.selected.clear();
        sourceTab._lastClickedPath = null;
      });
      if (assigned) {
        updateDualTransferBar();
        renderSymmetricDualWorkspace();
        renderLocalFolderList();
        if (typeof showToast === 'function') {
          showToast(`已将 ${assigned} 个项目分配到「${folder.name}」`, 'success');
        }
      } else {
        if (typeof showToast === 'function') {
          showToast('请先在原文件窗口中选择要分配的文件或文件夹', 'info');
        }
      }
      return;
    }
    if (!selectedIds.size && !selectedFolderPaths.size) return;
    selectedIds.forEach(id => { assignMap[id] = slotId; });
    // Also assign selected folders (local-organize mode)
    if (workMode === 'local-organize') {
      selectedFolderPaths.forEach(fp => { assignMap['folder:' + fp] = slotId; });
    }
    // Track recent
    recentSlotIds = recentSlotIds.filter(r => r !== slotId);
    recentSlotIds.unshift(slotId);
    if (recentSlotIds.length > 5) recentSlotIds.length = 5;
    selectedIds.clear();
    selectedFolderPaths.clear();
    updateFileCardsInPlace();
    updateFolderCardSelectionState();
    renderSlotList();
    renderRecentSlots();
    updateActionBar();
  }

  // ── Recent slots bar ──
  function renderRecentSlots() {
    const container = $('su-recent-slots');
    if (!container) return;
    if (workMode === 'local-organize' || workMode === 'local-dual') {
      container.innerHTML = recentSlotIds.map((rid, i) => {
        const f = localTargetFolders.find(x => x.id === rid);
        if (!f) return '';
        const color = COLORS[localTargetFolders.indexOf(f) % COLORS.length];
        return `<button class="su-recent-slot-btn" data-slot-id="${rid}" style="border-color:${color};color:${color};background:${color}10" title="最近使用">${f.name}</button>`;
      }).join('');
    } else {
      const slots = getSlots();
      container.innerHTML = recentSlotIds.map((rid, i) => {
        const s = slots.find(x => x.id === rid);
        if (!s) return '';
        const color = COLORS[slots.indexOf(s) % COLORS.length];
        return `<button class="su-recent-slot-btn" data-slot-id="${rid}" style="border-color:${color};color:${color};background:${color}10" title="最近使用">${getSlotName(s)}</button>`;
      }).join('');
    }
    container.querySelectorAll('.su-recent-slot-btn').forEach(btn => {
      btn.addEventListener('click', () => assignSelectedToSlot(btn.dataset.slotId));
    });
  }

  // ── Action bar ──
  function updateActionBar() {
    const total = localFiles.length;
    const fileAssigned = Object.keys(assignMap).filter(k => !k.startsWith('folder:')).length;
    const folderAssigned = Object.keys(assignMap).filter(k => k.startsWith('folder:')).length;
    const assigned = fileAssigned + folderAssigned;
    const selCount = selectedIds.size + selectedFolderPaths.size;
    const selInfo = $('su-sel-info');
    const assInfo = $('su-assign-info');
    const unInfo = $('su-unassign-info');
    const uploadBtn = $('su-start-upload');
    const copyBtn = $('su-local-copy');
    const moveBtn = $('su-local-move');
    const batchRenameBtn = $('su-batch-rename-btn');
    const unassignSelectedBtn = $('su-unassign-selected');
    const clearCustomOrderBtn = $('su-clear-custom-order');
    const selLabel = selectedFolderPaths.size > 0 ? `${selectedIds.size} 文件 + ${selectedFolderPaths.size} 文件夹` : `${selectedIds.size} 个`;
    if (selInfo) selInfo.textContent = selLabel;
    const assLabel = folderAssigned > 0 ? `${fileAssigned} 文件 + ${folderAssigned} 文件夹` : `${fileAssigned}`;
    if (assInfo) assInfo.textContent = assLabel;
    if (unInfo) unInfo.textContent = `${total - fileAssigned}`;
    if (unassignSelectedBtn) {
      const selectedAssignedCount = [...selectedIds].filter(id => Boolean(assignMap[id])).length
        + [...selectedFolderPaths].filter(path => Boolean(assignMap['folder:' + path])).length;
      unassignSelectedBtn.disabled = selectedAssignedCount === 0;
      unassignSelectedBtn.textContent = selectedAssignedCount ? `取消所选分配 (${selectedAssignedCount})` : '取消所选分配';
    }
    if (batchRenameBtn) {
      const batchCount = selectedIds.size + selectedFolderPaths.size;
      batchRenameBtn.disabled = batchCount === 0;
      batchRenameBtn.textContent = batchCount
        ? `↕️ 排序 / 分组 (${batchCount})`
        : '↕️ 排序 / 分组';
    }
    if (clearCustomOrderBtn) {
      const hasCustomOrder = customDisplayOrderPaths.length || customFolderOrderPaths.length;
      clearCustomOrderBtn.disabled = !hasCustomOrder;
      clearCustomOrderBtn.style.opacity = hasCustomOrder ? '1' : '0.55';
    }
    const folderUpBtn = $('su-folder-upload');
    if (workMode === 'local-organize' || workMode === 'local-dual') {
      if (uploadBtn) uploadBtn.style.display = 'none';
      if (folderUpBtn) folderUpBtn.style.display = 'none';
      const dual = workMode === 'local-dual';
      const actionCount = dual ? selCount : assigned;
      const enabled = dual ? Boolean(dualTargetPath && actionCount) : actionCount > 0;
      if (copyBtn) { copyBtn.style.display = ''; copyBtn.textContent = dual ? `📋 复制到右侧 (${actionCount})` : `📋 复制到目标 (${actionCount})`; copyBtn.disabled = !enabled; }
      if (moveBtn) { moveBtn.style.display = ''; moveBtn.textContent = dual ? `📦 移动到右侧 (${actionCount})` : `📦 移动到目标 (${actionCount})`; moveBtn.disabled = !enabled; }
    } else {
      if (uploadBtn) { uploadBtn.style.display = ''; uploadBtn.textContent = `⬆️ 开始上传 (${fileAssigned})`; uploadBtn.disabled = fileAssigned === 0; }
      if (folderUpBtn) folderUpBtn.style.display = '';
      if (copyBtn) copyBtn.style.display = 'none';
      if (moveBtn) moveBtn.style.display = 'none';
    }
  }

  // ── Pick folder & scan (multi-folder) ──
  async function pickFolder() {
    const dirs = await window.bridge?.localFiles?.pickFolder?.({ multi: true, title: '选择源文件夹（可多选）' });
    if (!dirs) return;
    const dirList = Array.isArray(dirs) ? dirs : [dirs];
    for (const dir of dirList) {
      if (localFolderPaths.includes(dir)) continue;
      localFolderPaths.push(dir);
      localFolderPath = dir;
      $('su-refresh-folder').disabled = false;
      await scanAndMergeFolder(dir, false);
    }
  }

  async function scanAndMergeFolder(dir, isRefresh) {
    $('su-folder-path').textContent = dir + ' (扫描中...)';
    const files = await window.bridge?.localFiles?.scanFolder?.(dir, { force: Boolean(isRefresh) });
    const newFiles = Array.isArray(files) ? files : [];
    if (isRefresh) {
      // Remove old files from this folder, then add fresh scan
      localFiles = localFiles.filter(f => !f.path.startsWith(dir));
    }
    // Merge: add only files not already present
    const existingIds = new Set(localFiles.map(lf => lf.id));
    newFiles.forEach(f => {
      if (!existingIds.has(f.id)) {
        localFiles.push(f);
        existingIds.add(f.id);
      }
    });
    currentTreePath = '';
    currentPage = 1;
    updateFolderPathDisplay();
    // Update active tab
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab) {
      tab.folderPath = localFolderPath;
      tab.folderPaths = [...localFolderPaths];
      tab.folderName = localFolderPaths.length > 1
        ? `${localFolderPaths.length}个文件夹`
        : (localFolderPath.split('/').pop() || localFolderPath.split('\\').pop() || localFolderPath);
      tab.localFiles = localFiles;
      tab.currentTreePath = '';
      tab.currentPage = 1;
    }
    saveTabs();
    renderTabBar();
    renderFileGrid();
    updateActionBar();
  }

  async function refreshAllFolders(options = {}) {
    if (!localFolderPaths.length) return;
    const preservedTreePath = options.preserveTreePath ? currentTreePath : '';
    localFiles = [];
    const existingIds = new Set();
    for (const dir of localFolderPaths) {
      $('su-folder-path').textContent = `刷新中: ${dir}...`;
      const files = await window.bridge?.localFiles?.scanFolder?.(dir, { force: true });
      if (Array.isArray(files)) {
        files.forEach(f => {
          if (!existingIds.has(f.id)) {
            localFiles.push(f);
            existingIds.add(f.id);
          }
        });
      }
    }
    currentTreePath = preservedTreePath;
    currentPage = 1;
    updateFolderPathDisplay();
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab) { tab.localFiles = localFiles; tab.currentTreePath = preservedTreePath; tab.currentPage = 1; }
    renderTabBar();
    renderFileGrid();
    renderBreadcrumb();
    updateActionBar();
  }

  function removeSourceFolder(dir) {
    localFolderPaths = localFolderPaths.filter(p => p !== dir);
    localFiles = localFiles.filter(f => !f.path.startsWith(dir));
    // Clean selections and assignments for removed files
    const remainingIds = new Set(localFiles.map(f => f.id));
    selectedIds = new Set([...selectedIds].filter(id => remainingIds.has(id)));
    Object.keys(assignMap).forEach(k => { if (!remainingIds.has(k)) delete assignMap[k]; });
    localFolderPath = localFolderPaths[localFolderPaths.length - 1] || '';
    currentPage = 1;
    updateFolderPathDisplay();
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab) {
      tab.folderPath = localFolderPath;
      tab.folderPaths = [...localFolderPaths];
      tab.localFiles = localFiles;
      tab.folderName = localFolderPaths.length > 1
        ? `${localFolderPaths.length}个文件夹`
        : (localFolderPath.split('/').pop() || '新标签');
    }
    saveTabs();
    renderTabBar();
    renderFileGrid();
    updateActionBar();
  }

  function updateFolderPathDisplay() {
    const el = $('su-folder-path');
    if (!el) return;
    const btn = $('su-refresh-folder');
    if (btn) {
      btn.disabled = !localFolderPaths.length;
    }
    if (!localFolderPaths.length) {
      el.textContent = '未选择';
      el.title = '';
      return;
    }
    const total = localFiles.length;
    if (localFolderPaths.length === 1) {
      el.textContent = `${localFolderPaths[0]} (${total} 个文件)`;
      el.title = localFolderPaths[0];
    } else {
      el.textContent = `${localFolderPaths.length} 个文件夹 (共 ${total} 个文件)`;
      el.title = localFolderPaths.join('\n');
    }
  }

  // For backwards compat — old single-scan
  // ── 预设导入导出 ──
  async function exportPresetHandler() {
    saveCurrentTab();
    const slots = getSlots();

    if (!localTargetFolders.length && !tabs.length && (!slots || !slots.length)) {
      alert('没有可导出的数据');
      return;
    }

    const preset = {
      version: 3,
      type: 'unified-preset',
      exportDate: new Date().toISOString(),
      targetFolders: localTargetFolders.map(f => ({ name: f.name, path: f.path, group: f.group || '', avatar: f.avatar || '', avatarPos: f.avatarPos || null, subfolderRule: f.subfolderRule || '', subfolderCustom: f.subfolderCustom || '' })),
      tabs: tabs.map(t => ({
        name: t.name || t.folderName || '',
        folderPaths: t.folderPaths || (t.folderPath ? [t.folderPath] : []),
      })),
      slots: slots
    };

    const jsonStr = JSON.stringify(preset, null, 2);
    const result = await window.bridge?.localFiles?.exportPreset?.(jsonStr);

    if (result?.success) {
      alert(`✅ 统一预设已导出\n${result.filePath}\n本地目标文件夹: ${preset.targetFolders.length} 个\n上传卡片: ${(preset.slots || []).length} 个`);
    } else if (!result?.canceled) {
      alert('导出失败: ' + (result?.error || '未知错误'));
    }
  }

  async function importPresetHandler() {
    const result = await window.bridge?.localFiles?.importPreset?.();
    if (!result?.success) { if (!result?.canceled) alert('导入失败: ' + (result?.error || '未知错误')); return; }
    try {
      const preset = JSON.parse(result.content);

      const folders = preset.targetFolders || preset.folders || (preset.type === 'local-organize' ? preset : []);
      const presetTabs = preset.tabs || [];
      const slotsToImport = preset.slots || (preset.type === 'upload-cards' ? preset : (Array.isArray(preset) && preset[0]?.id && preset[0]?.mode ? preset : []));

      if ((!Array.isArray(folders) || !folders.length) && (!Array.isArray(slotsToImport) || !slotsToImport.length)) {
         alert('预设文件格式不正确或为空');
         return;
      }

      const info = [];
      if (Array.isArray(folders) && folders.length) info.push(`本地目标文件夹: ${folders.length} 个`);
      if (presetTabs.length) info.push(`本地标签页: ${presetTabs.length} 个`);
      if (Array.isArray(slotsToImport) && slotsToImport.length) info.push(`上传卡片: ${slotsToImport.length} 个`);

      const action = confirm(
        `即将导入预设数据:\n${info.join('\n')}\n来源: ${result.filePath.split('/').pop()}\n\n` +
        `点击「确定」= 替换当前所有配置\n` +
        `点击「取消」= 追加到现有列表`
      );

      // Handle local-organize part
      if (Array.isArray(folders) && folders.length > 0) {
        if (action) {
          localTargetCounter = 0; // Reset counter for clean replace
          localTargetFolders = folders.map((f, i) => ({
            id: 'lf-' + (++localTargetCounter) + '-' + Date.now(),
            name: f.name || f.path?.split('/').pop() || `文件夹${i + 1}`,
            path: f.path || '',
            group: f.group || '',
            avatar: f.avatar || '',
            avatarPos: f.avatarPos || null,
            subfolderRule: f.subfolderRule || '',
            subfolderCustom: f.subfolderCustom || '',
          }));
        } else {
          folders.forEach(f => {
            if (f.path && localTargetFolders.some(lf => lf.path === f.path)) return;
            localTargetFolders.push({
              id: 'lf-' + (++localTargetCounter) + '-' + Date.now(),
              name: f.name || f.path?.split('/').pop() || '未命名',
              path: f.path || '',
              group: f.group || '',
              avatar: f.avatar || '',
              avatarPos: f.avatarPos || null,
              subfolderRule: f.subfolderRule || '',
              subfolderCustom: f.subfolderCustom || '',
            });
          });
        }
        saveLocalTargetFolders();
        if (workMode === 'local-organize') renderSlotList();

        // Import tabs (source folders)
        if (presetTabs.length && action) {
          tabs.length = 0;
          presetTabs.forEach((pt, i) => {
            tabs.push({
              id: 'tab-' + Date.now() + '-' + i,
              name: pt.name || `标签${i + 1}`,
              folderName: pt.name || `标签${i + 1}`,
              folderPaths: pt.folderPaths || [],
              folderPath: (pt.folderPaths || [])[0] || '',
              localFiles: [],
              assignMap: {},
              selectedIds: [],
              uploadedMap: {},
              currentTreePath: '',
              currentPage: 1,
            });
          });
          if (tabs.length) {
            activeTabId = tabs[0].id;
            loadTab(tabs[0].id);
            // Auto-scan restored source folders
            for (const dir of localFolderPaths) {
              await scanAndMergeFolder(dir, false);
            }
          }
          saveTabs();
          if (workMode === 'local-organize') renderTabBar();
        }
      }

      // Handle upload slots part
      if (Array.isArray(slotsToImport) && slotsToImport.length > 0) {
        importUploadSlotPresets(slotsToImport, action);
        if (typeof persistSlotPresets === 'function') persistSlotPresets();
        if (workMode !== 'local-organize') {
          if (typeof renderSlots === 'function') renderSlots();
          renderSlotList();
        }
      }

      alert(`✅ 导入成功\n${info.join('\n')}`);

    } catch (e) {
      alert('预设文件解析失败: ' + e.message);
    }
  }

  // ── 合并多个预设 ──
  async function mergePresetsHandler() {
    const result = await window.bridge?.localFiles?.importPresetsMulti?.();
    if (!result?.success) { if (!result?.canceled) alert('选择文件失败: ' + (result?.error || '未知错误')); return; }
    const fileResults = result.files || [];
    if (!fileResults.length) return;

    let totalLocalFolders = 0;
    let totalUploadSlots = 0;
    let skippedDuplicates = 0;
    let errorFiles = [];

    for (const fr of fileResults) {
      if (fr.error || !fr.content) {
        errorFiles.push(fr.filePath?.split('/').pop() || '未知文件');
        continue;
      }
      let preset;
      try {
        preset = JSON.parse(fr.content);
      } catch (e) {
        errorFiles.push((fr.filePath?.split('/').pop() || '未知文件') + ' (JSON解析失败)');
        continue;
      }

      const folders = preset.targetFolders || preset.folders || (preset.type === 'local-organize' ? preset : []);
      if (Array.isArray(folders) && folders.length > 0) {
        folders.forEach(f => {
          // 去重：如果已存在相同路径则跳过
          if (f.path && localTargetFolders.some(lf => lf.path === f.path)) {
            skippedDuplicates++;
            return;
          }
          // 去重：如果没有路径，按名称去重
          if (!f.path && f.name && localTargetFolders.some(lf => lf.name === f.name && !lf.path)) {
            skippedDuplicates++;
            return;
          }
          localTargetFolders.push({
            id: 'lf-' + (++localTargetCounter) + '-' + Date.now(),
            name: f.name || f.path?.split('/').pop() || '未命名',
            path: f.path || '',
            group: f.group || '',
            avatar: f.avatar || '',
            avatarPos: f.avatarPos || null,
            subfolderRule: f.subfolderRule || '',
            subfolderCustom: f.subfolderCustom || '',
          });
          totalLocalFolders++;
        });
      }

      const slotsToMerge = preset.slots || (preset.type === 'upload-cards' ? preset : (Array.isArray(preset) && preset[0]?.id && preset[0]?.mode ? preset : []));
      if (Array.isArray(slotsToMerge) && slotsToMerge.length > 0) {
        importUploadSlotPresets(slotsToMerge, false);
        totalUploadSlots += slotsToMerge.length;
      }
    }

    // 保存并刷新
    saveLocalTargetFolders();
    if (typeof persistSlotPresets === 'function') persistSlotPresets();

    if (workMode === 'local-organize') {
      renderSlotList();
    } else {
      if (typeof renderSlots === 'function') renderSlots();
      renderSlotList();
    }

    // 汇报结果
    const lines = [`📊 合并完成 (${fileResults.length} 个文件)`];
    if (totalLocalFolders > 0) lines.push(`✅ 新增目标文件夹: ${totalLocalFolders} 个`);
    if (totalUploadSlots > 0) lines.push(`✅ 新增上传卡片: ${totalUploadSlots} 个`);
    if (skippedDuplicates) lines.push(`⏭ 跳过重复文件夹: ${skippedDuplicates} 个`);
    if (errorFiles.length) lines.push(`⚠️ 跳过/失败:\n  ${errorFiles.join('\n  ')}`);
    lines.push(`\n当前总计:\n- ${localTargetFolders.length} 个目标文件夹\n- ${getSlots().length} 个上传卡片`);
    alert(lines.join('\n'));
  }

  // For backwards compat — old single-scan
  async function scanFolder(dir) {
    localFolderPaths = [dir];
    localFolderPath = dir;
    localFiles = [];
    selectedIds.clear();
    assignMap = {};
    currentTreePath = '';
    currentPage = 1;
    await scanAndMergeFolder(dir, false);
  }

  function buildSortUploadFile(file, slotId) {
    const id = file.id || file.path;
    return {
      ...file,
      id,
      slotId,
      path: file.path,
      name: file.name || (file.path ? file.path.split('/').pop() : ''),
      size: file.size || 0,
      mimeType: file.mimeType || guessMimeType(file.name || file.path || ''),
      relativePath: file.relativePath || file.relPath || '',
      relPath: file.relPath || file.relativePath || '',
      isLocal: file.isLocal !== false
    };
  }

  function cloneMap(value) {
    return value instanceof Map ? new Map(value) : new Map();
  }

  function getSortUploadResult(slot, file, uploadResults = null) {
    if (Array.isArray(uploadResults)) {
      const result = uploadResults.find(item => item?.fileId === file.id);
      if (result?.status === 'success' || result?.status === 'skipped') {
        return { status: 'done', message: result.message || '上传完成' };
      }
      if (result?.status === 'error') {
        return { status: 'fail', message: result.message || '上传失败' };
      }
    }
    const statusInfo = slot.fileStatuses instanceof Map ? slot.fileStatuses.get(file.id) : null;
    if (statusInfo?.status === 'success' || statusInfo?.status === 'skipped') {
      return { status: 'done', message: statusInfo.message || '上传完成' };
    }
    if (statusInfo?.status === 'error') {
      return { status: 'fail', message: statusInfo.message || '上传失败' };
    }
    return { status: 'fail', message: statusInfo?.message || '上传未完成，请查看上传日志' };
  }

  // ── Start upload (uses existing engine) ──
  async function startSortUpload() {
    const assigned = Object.entries(assignMap);
    if (!assigned.length) return;
    if (typeof state !== 'undefined' && !state.authorized) {
      alert('上传终止：您的谷歌授权已失效或尚未登录，请先在顶栏登录 Google 账号！');
      return;
    }
    if (typeof state !== 'undefined' && state.uploadState && state.uploadState !== 'idle') {
      alert('当前已有上传任务在进行中，请等待完成或停止后再开始分拣上传。');
      return;
    }
    if (typeof handleUpload !== 'function') {
      alert('上传模块尚未初始化，无法开始上传。');
      return;
    }

    // Group by slotId
    const groups = {};
    assigned.forEach(([fileId, slotId]) => {
      (groups[slotId] = groups[slotId] || []).push(fileId);
    });

    const slots = getSlots();
    const totalFiles = assigned.length;
    let doneCount = 0;

    // Show progress
    const progressBar = $('su-progress-bar');
    const progressFill = $('su-progress-fill');
    const progressText = $('su-progress-text');
    if (progressBar) progressBar.hidden = false;
    if (progressText) progressText.hidden = false;

    for (const [slotId, fileIds] of Object.entries(groups)) {
      const slot = slots.find(s => s.id === slotId);
      if (!slot) continue;
      const slotName = getSlotName(slot);

      const sourceFiles = fileIds.map(id => localFiles.find(f => f.id === id)).filter(Boolean);
      const tempFiles = sourceFiles.map(f => buildSortUploadFile(f, slotId));
      const tempIds = new Set(tempFiles.map(f => f.id));
      const originalFiles = Array.isArray(slot.files) ? [...slot.files] : [];
      const originalFileStatuses = cloneMap(slot.fileStatuses);
      const originalSelectedFiles = slot.selectedFiles instanceof Set ? new Set(slot.selectedFiles) : new Set();
      const originalSkip = slot.skipCreateSubfolder;

      try {
        slot.files = tempFiles;
        slot.fileStatuses = new Map();
        slot.selectedFiles = new Set(tempFiles.map(f => f.id));
        if (!cloudSubfolderEnabled) {
          slot.skipCreateSubfolder = true;
        }

        const uploadResults = await handleUpload(slotId);

        tempFiles.forEach(file => {
          const result = getSortUploadResult(slot, file, uploadResults);
          uploadedMap[file.id] = { slotId, slotName, status: result.status, message: result.message };
          doneCount++;
          if (progressFill) progressFill.style.width = (doneCount / totalFiles * 100) + '%';
          if (progressText) progressText.textContent = `上传中... ${doneCount}/${totalFiles} - ${slotName}`;
        });

        fileIds.filter(id => !tempIds.has(id)).forEach(id => {
          uploadedMap[id] = { slotId, slotName, status: 'fail', message: '文件不存在或已被移除' };
          doneCount++;
          if (progressFill) progressFill.style.width = (doneCount / totalFiles * 100) + '%';
        });

      } catch (err) {
        fileIds.forEach(id => {
          uploadedMap[id] = { slotId, slotName, status: 'fail', message: err.message || '上传失败' };
          doneCount++;
          if (progressFill) progressFill.style.width = (doneCount / totalFiles * 100) + '%';
        });
        console.error('Upload failed for slot', slotName, err);
      } finally {
        slot.files = originalFiles;
        slot.fileStatuses = originalFileStatuses;
        slot.selectedFiles = originalSelectedFiles;
        slot.skipCreateSubfolder = originalSkip;
        updateFileCardsInPlace();
      }
    }

    if (progressText) progressText.textContent = `上传完成 ✅ 成功 ${Object.values(uploadedMap).filter(u=>u.status==='done').length} / 失败 ${Object.values(uploadedMap).filter(u=>u.status==='fail').length}`;
    updateFileCardsInPlace();
    updateActionBar();
  }

  // ── Folder Upload to Drive ──
  async function folderUploadToDrive() {
    // 1. Pick folder
    const folderPath = await window.bridge?.localFiles?.pickFolder?.();
    if (!folderPath) return;

    // 2. Scan files
    const scanResult = await window.bridge?.localFiles?.scanFolder?.(folderPath);
    const allFiles = scanResult?.files || scanResult || [];
    if (!allFiles.length) { alert('选择的文件夹中没有文件'); return; }

    // 3. Show target selection modal
    const slots = getSlots();
    const slotsWithDriveTarget = slots.filter(s => s.customFolderId || s.customLink);
    if (!slotsWithDriveTarget.length) {
      alert('没有配置 Drive 目标链接的上传卡片。\n请先在卡片设置中配置「目标链接」。');
      return;
    }

    // Build selection UI
    const overlay = document.createElement('div');
    overlay.className = 'su-modal-overlay';
    overlay.innerHTML = `
      <div class="su-modal" style="max-width:520px;">
        <div class="su-modal-header">
          <h3>📂 文件夹上传到 Drive</h3>
          <button class="su-btn su-btn-sm su-folder-upload-close">✕</button>
        </div>
        <div class="su-modal-body" style="max-height:60vh;overflow-y:auto;">
          <p style="margin:0 0 8px;font-size:13px;color:#555;">
            📁 <strong>${folderPath.split('/').pop()}</strong> — 共 ${allFiles.length} 个文件
          </p>
          <p style="margin:0 0 12px;font-size:12px;color:#888;">选择上传目标 (Drive 文件夹)：</p>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${slotsWithDriveTarget.map((s, i) => {
              const name = getSlotName(s);
              const link = s.customLink || '';
              return `<label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #e0e0e0;border-radius:8px;cursor:pointer;font-size:13px;transition:background .15s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='#fff'">
                <input type="radio" name="su-folder-upload-target" value="${i}" ${i === 0 ? 'checked' : ''} />
                <span style="font-weight:600;">${name}</span>
                <span style="color:#999;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;">${link}</span>
              </label>`;
            }).join('')}
          </div>
        </div>
        <div class="su-modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #eee;">
          <button class="su-btn su-folder-upload-cancel">取消</button>
          <button class="su-btn su-btn-primary su-folder-upload-confirm">⬆️ 开始上传 (${allFiles.length} 个文件)</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.su-folder-upload-close')?.addEventListener('click', close);
    overlay.querySelector('.su-folder-upload-cancel')?.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('.su-folder-upload-confirm')?.addEventListener('click', async () => {
      const selectedIdx = parseInt(overlay.querySelector('input[name="su-folder-upload-target"]:checked')?.value || '0');
      const targetSlot = slotsWithDriveTarget[selectedIdx];
      if (!targetSlot) { alert('请选择目标'); return; }

      const folderId = targetSlot.customFolderId || (typeof extractDriveFolderId === 'function' ? extractDriveFolderId(targetSlot.customLink) : targetSlot.customLink);
      if (!folderId) { alert('目标卡片没有有效的 Drive 文件夹 ID'); return; }

      close();

      // Show progress
      const progressBar = $('su-progress-bar');
      const progressFill = $('su-progress-fill');
      const progressText = $('su-progress-text');
      if (progressBar) progressBar.hidden = false;
      if (progressText) progressText.hidden = false;
      if (progressText) progressText.textContent = `准备上传 ${allFiles.length} 个文件到 ${getSlotName(targetSlot)}...`;
      if (progressFill) progressFill.style.width = '0%';

      // Listen for progress events
      const progressHandler = (_e, data) => {
        if (data?.status === 'uploading') {
          const pct = (data.current / data.total * 100).toFixed(0);
          if (progressFill) progressFill.style.width = pct + '%';
          if (progressText) progressText.textContent = `上传中 ${data.current}/${data.total} — ${data.fileName}`;
        }
      };
      window.bridge?.on?.('upload-organizer:progress', progressHandler);

      try {
        // Build file payloads
        const filesToUpload = allFiles.map(f => ({
          path: f.path || f,
          name: f.name || (typeof f === 'string' ? f.split('/').pop() : ''),
          mimeType: guessMimeType(f.name || f.path || f)
        }));

        // 将分拣器所选卡片的元数据传给主进程，使“文件夹直传”与普通上传
        // 一样在上传完成后自动登记到普通入库表或文件审核表。
        const metadata = typeof buildSlotMetadata === 'function'
          ? buildSlotMetadata(targetSlot)
          : {
              mainCategory: targetSlot.mainCategory || '',
              subCategory: targetSlot.subCategory || '',
              taskType: targetSlot.taskType || '',
              admin: targetSlot.admin || '',
              reviewEnabled: Boolean(targetSlot.reviewEnabled)
            };
        metadata.subFolderId = folderId;
        metadata.subFolderLink = typeof ensureDriveFolderLink === 'function'
          ? ensureDriveFolderLink(targetSlot.customLink || folderId)
          : (targetSlot.customLink || `https://drive.google.com/drive/folders/${folderId}`);

        const result = await window.bridge?.uploadToDrive?.({
          files: filesToUpload,
          folderId,
          registration: { metadata }
        });
        window.bridge?.removeListener?.('upload-organizer:progress', progressHandler);

        if (result?.success) {
          const successCount = result.results?.filter(r => r.success).length || 0;
          const failCount = result.results?.filter(r => !r.success).length || 0;
          if (progressText) progressText.textContent = `✅ 文件夹上传完成 — 成功 ${successCount} / 失败 ${failCount}`;
          if (progressFill) progressFill.style.width = '100%';

          if (failCount > 0) {
            const failedNames = result.results.filter(r => !r.success).map(r => `${r.name}: ${r.error}`).join('\n');
            alert(`上传完成\n成功: ${successCount}\n失败: ${failCount}\n\n失败文件:\n${failedNames}`);
          }
        } else {
          if (progressText) progressText.textContent = `❌ 上传失败: ${result?.error || '未知错误'}`;
          alert('上传失败: ' + (result?.error || '未知错误'));
        }
      } catch (err) {
        window.bridge?.removeListener?.('upload-organizer:progress', progressHandler);
        if (progressText) progressText.textContent = `❌ 上传出错: ${err.message}`;
        alert('上传出错: ' + err.message);
      }
    });
  }

  function guessMimeType(fileName) {
    const ext = (fileName || '').split('.').pop()?.toLowerCase();
    const mimeMap = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
      mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska', webm: 'video/webm',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
      pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      psd: 'image/vnd.adobe.photoshop', ai: 'application/postscript',
      srt: 'application/x-subrip', vtt: 'text/vtt',
      zip: 'application/zip', rar: 'application/x-rar-compressed',
    };
    return mimeMap[ext] || 'application/octet-stream';
  }

  // ── Local Organize Mode ──

  function makeDualTab(folderPath = '') {
    const normalized = String(folderPath || '').replace(/[\\/]+$/, '');
    return {
      id: 'dual-' + Date.now() + '-' + (++dualPaneCounter),
      name: normalized.split(/[/\\]/).pop() || '新标签',
      path: normalized,
      items: [],
      selected: new Set(),
      filter: 'all',
      search: '',
      searchMode: 'include',
      dateFilter: 'all',
      groupBy: 'none',
      view: 'grid',
      sort: 'name-asc',
      cardSize: 130,
      history: normalized ? [normalized] : [],
      historyIndex: normalized ? 0 : -1,
      loading: false,
      loadToken: 0
    };
  }

  function navigateDualTab(side, tab, folderPath, options = {}) {
    const normalized = String(folderPath || '').replace(/[\\/]+$/, '');
    if (!normalized || normalized === tab.path) return;
    tab._savedScrollTop = 0;
    if (!options.fromHistory) {
      const history = Array.isArray(tab.history) ? tab.history.slice(0, (Number(tab.historyIndex) || 0) + 1) : [];
      if (history[history.length - 1] !== normalized) history.push(normalized);
      tab.history = history;
      tab.historyIndex = history.length - 1;
    }
    tab.path = normalized;
    tab.name = normalized.split(/[/\\]/).pop() || tab.name;
    tab.selected.clear();
    loadDualTab(side, tab, true);
  }

  function travelDualHistory(side, tab, offset) {
    const nextIndex = (Number(tab.historyIndex) || 0) + offset;
    if (!Array.isArray(tab.history) || nextIndex < 0 || nextIndex >= tab.history.length) return;
    tab.historyIndex = nextIndex;
    navigateDualTab(side, tab, tab.history[nextIndex], { fromHistory: true });
  }

  function activeDualTab(side) {
    const pane = dualPanes[side];
    return pane.tabs.find(tab => tab.id === pane.activeId) || pane.tabs[0] || null;
  }

  function dualTargetDestination(side) {
    const tab = activeDualTab(side);
    if (!tab?.path) return '';
    const selectedFolder = tab.items.find(item => item.isDirectory && tab.selected.has(item.path));
    return selectedFolder?.path || tab.path;
  }

  function saveDualPanes() {
    try {
      const serializable = {
        version: 4,
        ratio: dualPaneRatio,
        colRatios: dualColRatios,
        rowRatios: dualRowRatios,
        rowHeights: dualRowHeights,
        layoutCount: dualLayoutCount,
        layoutColumns: dualLayoutColumns,
        activeTarget: activeDualTarget,
        paneOrder: dualPaneOrder,
        shortcuts: dualGlobalShortcuts,
        panes: {}
      };
      dualPaneOrder.forEach(side => {
        serializable.panes[side] = {
          role: dualPanes[side].role,
          activeId: dualPanes[side].activeId,
          tabs: dualPanes[side].tabs.map(tab => ({ id: tab.id, name: tab.name, path: tab.path, filter: tab.filter, search: tab.search, searchMode: tab.searchMode, dateFilter: tab.dateFilter, groupBy: tab.groupBy, view: tab.view, sort: tab.sort, cardSize: tab.cardSize }))
        };
      });
      localStorage.setItem(DUAL_PANES_KEY, JSON.stringify(serializable));
    } catch (_) {}
  }

  function buildDualWorkspaceConfig() {
    return {
      type: 'iten-multi-window-workspace',
      version: 2,
      exportedAt: new Date().toISOString(),
      layout: {
        count: dualLayoutCount,
        columns: dualLayoutColumns,
        ratio: dualPaneRatio,
        colRatios: dualColRatios,
        rowRatios: dualRowRatios,
        rowHeights: dualRowHeights
      },
      shortcuts: dualGlobalShortcuts.map(item => ({ name: item.name, path: item.path })),
      activeTargetIndex: Math.max(0, dualPaneOrder.indexOf(activeDualTarget)),
      panes: dualPaneOrder.slice(0, dualLayoutCount).map(side => ({
        role: dualPanes[side].role,
        activeTabIndex: Math.max(0, dualPanes[side].tabs.findIndex(tab => tab.id === dualPanes[side].activeId)),
        tabs: dualPanes[side].tabs.map(tab => ({
          name: tab.name, path: tab.path, filter: tab.filter, search: tab.search,
          searchMode: tab.searchMode, dateFilter: tab.dateFilter, groupBy: tab.groupBy, view: tab.view,
          sort: tab.sort, cardSize: tab.cardSize
        }))
      }))
    };
  }

  function applyDualWorkspaceConfig(config) {
    if (!config || config.type !== 'iten-multi-window-workspace' || !Array.isArray(config.panes)) throw new Error('不是有效的多窗口整理配置文件');
    const count = Math.min(12, Math.max(2, Number(config.layout?.count) || config.panes.length || 2));
    const columns = Math.min(4, Math.max(1, Number(config.layout?.columns) || (count === 2 ? 2 : 2)));
    dualLayoutCount = count;
    dualLayoutColumns = columns;
    dualPaneRatio = Math.min(.78, Math.max(.22, Number(config.layout?.ratio) || .5));
    if (Array.isArray(config.layout?.colRatios) && config.layout.colRatios.length === columns) {
      dualColRatios = config.layout.colRatios;
    } else {
      dualColRatios = columns === 2 && count === 2 ? [dualPaneRatio, 1 - dualPaneRatio] : Array(columns).fill(1 / columns);
    }
    const rows = Math.ceil(count / columns);
    if (Array.isArray(config.layout?.rowRatios) && config.layout.rowRatios.length === rows) {
      dualRowRatios = config.layout.rowRatios;
    } else {
      dualRowRatios = Array(rows).fill(1 / rows);
    }
    if (Array.isArray(config.layout?.rowHeights) && config.layout.rowHeights.length === rows) {
      dualRowHeights = config.layout.rowHeights;
    } else {
      dualRowHeights = [];
    }
    dualGlobalShortcuts = Array.isArray(config.shortcuts) ? config.shortcuts.filter(item => typeof item?.path === 'string' && item.path).map(item => ({ name: String(item.name || item.path.split(/[/\\]/).pop() || '常用路径'), path: item.path })) : [];
    dualPaneOrder = [];
    for (let index = 0; index < count; index++) {
      const side = index === 0 ? 'left' : (index === 1 ? 'right' : 'pane-import-' + Date.now() + '-' + index);
      const source = config.panes[index] || {};
      const importedTabs = Array.isArray(source.tabs) && source.tabs.length ? source.tabs : [{}];
      const tabs = importedTabs.map(data => ({
        ...makeDualTab(data.path || ''), ...data,
        path: String(data.path || ''), name: String(data.name || (data.path || '').split(/[/\\]/).pop() || '新标签'),
        filter: ['all','folder','image','video','audio','document','other'].includes(data.filter) ? data.filter : 'all',
        searchMode: data.searchMode === 'exclude' ? 'exclude' : 'include',
        dateFilter: ['all','today','3d','7d','30d'].includes(data.dateFilter) ? data.dateFilter : 'all',
        groupBy: ['none','date','type'].includes(data.groupBy) ? data.groupBy : 'none',
        view: data.view === 'list' ? 'list' : 'grid',
        sort: ['name-asc','name-desc','date-desc','date-asc'].includes(data.sort) ? data.sort : 'name-asc',
        cardSize: Math.min(320, Math.max(80, Number(data.cardSize) === 118 ? 130 : (Number(data.cardSize) || 130))),
        items: [], selected: new Set(), loading: false,
        history: data.path ? [data.path] : [], historyIndex: data.path ? 0 : -1
      }));
      const activeIndex = Math.min(tabs.length - 1, Math.max(0, Number(source.activeTabIndex) || 0));
      dualPanes[side] = { role: source.role === 'target' ? 'target' : 'source', tabs, activeId: tabs[activeIndex].id, shortcuts: [] };
      dualPaneOrder.push(side);
    }
    if (!dualPaneOrder.some(side => dualPanes[side].role === 'target')) dualPanes[dualPaneOrder[dualPaneOrder.length - 1]].role = 'target';
    const targetIndex = Math.min(dualPaneOrder.length - 1, Math.max(0, Number(config.activeTargetIndex) || 0));
    activeDualTarget = dualPanes[dualPaneOrder[targetIndex]].role === 'target' ? dualPaneOrder[targetIndex] : dualPaneOrder.find(side => dualPanes[side].role === 'target');
    dualAssignments.clear();
    saveDualPanes();
    renderSymmetricDualWorkspace();
  }

  function loadDualPanes() {
    if (dualPanes.left.tabs.length || dualPanes.right.tabs.length) return;
    try {
      const saved = JSON.parse(localStorage.getItem(DUAL_PANES_KEY) || 'null');
      if (saved) {
        dualPaneRatio = Math.min(.78, Math.max(.22, Number(saved.ratio) || .5));
        const savedPanes = saved.panes || saved;
        dualGlobalShortcuts = Array.isArray(saved.shortcuts) ? saved.shortcuts.filter(item => item?.path).map(item => ({ name: item.name || item.path.split(/[/\\]/).pop() || '常用路径', path: item.path })) : [];
        dualLayoutCount = Math.min(12, Math.max(2, Number(saved.layoutCount) || 2));
        dualLayoutColumns = Math.min(4, Math.max(1, Number(saved.layoutColumns) || (dualLayoutCount === 2 ? 2 : 2)));
        if (Array.isArray(saved.colRatios) && saved.colRatios.length === dualLayoutColumns) {
          dualColRatios = saved.colRatios;
        } else {
          dualColRatios = dualLayoutColumns === 2 && dualLayoutCount === 2 ? [dualPaneRatio, 1 - dualPaneRatio] : Array(dualLayoutColumns).fill(1 / dualLayoutColumns);
        }
        const rows = Math.ceil(dualLayoutCount / dualLayoutColumns);
        if (Array.isArray(saved.rowRatios) && saved.rowRatios.length === rows) {
          dualRowRatios = saved.rowRatios;
        } else {
          dualRowRatios = Array(rows).fill(1 / rows);
        }
        if (Array.isArray(saved.rowHeights) && saved.rowHeights.length === rows) {
          dualRowHeights = saved.rowHeights;
        } else {
          dualRowHeights = [];
        }
        dualPaneOrder = Array.isArray(saved.paneOrder) && saved.paneOrder.length ? saved.paneOrder.slice(0, dualLayoutCount) : ['left', 'right'];
        while (dualPaneOrder.length < dualLayoutCount) dualPaneOrder.push('pane-' + (++dualPaneCounter));
        dualPaneOrder.forEach((side, index) => {
          const storedPane = savedPanes[side] || {};
          if (!dualPanes[side]) dualPanes[side] = { tabs: [], activeId: null, role: index ? 'target' : 'source', shortcuts: [] };
          const restored = Array.isArray(storedPane.tabs) ? storedPane.tabs : [];
          dualPanes[side].tabs = restored.map(data => ({ ...makeDualTab(data.path), ...data, history: data.path ? [data.path] : [], historyIndex: data.path ? 0 : -1, items: [], selected: new Set(), loading: false }));
          dualPanes[side].activeId = storedPane.activeId || dualPanes[side].tabs[0]?.id || null;
          dualPanes[side].role = storedPane.role === 'source' ? 'source' : (storedPane.role === 'target' ? 'target' : (index ? 'target' : 'source'));
          if (Array.isArray(storedPane.shortcuts)) {
            storedPane.shortcuts.filter(item => item?.path).forEach(item => {
              if (!dualGlobalShortcuts.some(shortcut => shortcut.path === item.path)) dualGlobalShortcuts.push({ name: item.name || item.path.split(/[/\\]/).pop() || '常用路径', path: item.path });
            });
          }
        });
        activeDualTarget = dualPanes[saved.activeTarget]?.role === 'target' ? saved.activeTarget : (dualPaneOrder.find(id => dualPanes[id].role === 'target') || 'right');
      }
    } catch (_) {}
    const leftStart = localFolderPath || localFolderPaths[0] || '';
    const rightStart = localTargetFolders.find(folder => !folder.archived)?.path || '';
    if (!dualPanes.left.tabs.length) {
      const tab = makeDualTab(leftStart);
      dualPanes.left.tabs.push(tab); dualPanes.left.activeId = tab.id;
    }
    if (!dualPanes.right.tabs.length) {
      const tab = makeDualTab(rightStart);
      dualPanes.right.tabs.push(tab); dualPanes.right.activeId = tab.id;
    }
  }

  function ensureDualPaneCount(count, columns) {
    dualLayoutCount = Math.min(12, Math.max(2, Number(count) || 2));
    dualLayoutColumns = Math.min(4, Math.max(1, Number(columns) || (dualLayoutCount === 2 ? 2 : 2)));
    while (dualPaneOrder.length < dualLayoutCount) {
      const side = 'pane-' + (++dualPaneCounter);
      const tab = makeDualTab('');
      dualPanes[side] = { tabs: [tab], activeId: tab.id, role: 'source', shortcuts: [] };
      dualPaneOrder.push(side);
    }
    if (dualPaneOrder.length > dualLayoutCount) dualPaneOrder = dualPaneOrder.slice(0, dualLayoutCount);
    if (!dualPaneOrder.some(id => dualPanes[id]?.role === 'target')) {
      const id = dualPaneOrder[dualPaneOrder.length - 1];
      dualPanes[id].role = 'target'; activeDualTarget = id;
    }
    if (!Array.isArray(dualColRatios) || dualColRatios.length !== dualLayoutColumns) {
      dualColRatios = dualLayoutColumns === 2 && dualLayoutCount === 2 ? [dualPaneRatio, 1 - dualPaneRatio] : Array(dualLayoutColumns).fill(1 / dualLayoutColumns);
    }
    const rows = Math.ceil(dualLayoutCount / dualLayoutColumns);
    if (!Array.isArray(dualRowRatios) || dualRowRatios.length !== rows) {
      dualRowRatios = Array(rows).fill(1 / rows);
    }
  }

  async function loadDualTab(side, tab, force = false) {
    if (!tab?.path) { tab.items = []; renderSymmetricDualPane(side); return; }
    const requestedPath = tab.path;
    const loadToken = (Number(tab.loadToken) || 0) + 1;
    tab.loadToken = loadToken;
    if (!tab.items || !tab.items.length) {
      tab.loading = true;
      renderSymmetricDualPane(side);
    }
    const result = await window.bridge?.localFiles?.listDirectory?.(requestedPath, { force });
    // A slower response for an old path must never overwrite the folder the
    // user has already navigated to.
    if (tab.loadToken !== loadToken || tab.path !== requestedPath) return;
    tab.loading = false;
    if (!result?.exists) {
      tab.items = [];
      if (typeof showToast === 'function') showToast(`文件夹不存在：${tab.path}`, 'error');
    } else {
      tab.items = result.items || [];
      if (force) tab.items.filter(item => item.isDirectory).forEach(item => dualFolderThumbnailCache.delete(item.path));
      tab.name = tab.path.replace(/[\\/]+$/, '').split(/[/\\]/).pop() || tab.name;
      const itemPaths = new Set(tab.items.map(item => item.path));
      tab.selected = new Set([...tab.selected].filter(itemPath => itemPaths.has(itemPath)));
    }
    saveDualPanes();
    renderSymmetricDualPane(side);
    updateDualTransferBar();
  }

  function sortedDualItems(tab) {
    const keywords = String(tab.search || '').split(/[,，\n]/).map(keyword => keyword.trim().toLowerCase()).filter(Boolean);
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    let items = tab.items.filter(item => {
      const lowerName = item.name.toLowerCase();
      const anyNameMatches = keywords.some(keyword => lowerName.includes(keyword));
      if (keywords.length && tab.searchMode !== 'exclude' && !anyNameMatches) return false;
      if (keywords.length && tab.searchMode === 'exclude' && anyNameMatches) return false;
      // 类型筛选时保留文件夹用于导航，但文件夹仍必须通过下方的时间筛选。
      if (!item.isDirectory) {
        if (tab.filter === 'folder') return false;
        if (tab.filter !== 'all' && fileCategory(item.mimeType || '') !== tab.filter) return false;
      }
      const dateChoice = tab.dateFilter || 'all';
      if (dateChoice !== 'all') {
        const modified = new Date(item.modifiedTime || 0).getTime();
        if (!modified) return false;
        if (dateChoice === 'today') {
          if (modified < todayStart.getTime()) return false;
        } else {
          const days = { '3d': 3, '7d': 7, '30d': 30 }[dateChoice];
          if (!days || modified < now - days * 86400000) return false;
        }
      }
      return true;
    });
    items.sort((a, b) => {
      const nameCompare = a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      // Name browsing keeps folders together. Time sorting must compare every
      // item globally; otherwise an older folder incorrectly precedes a newer file.
      if (!String(tab.sort || '').startsWith('date-') && a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      if (tab.sort === 'name-desc') return -nameCompare;
      if (tab.sort === 'date-desc') return (new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0)) || nameCompare;
      if (tab.sort === 'date-asc') return (new Date(a.modifiedTime || 0) - new Date(b.modifiedTime || 0)) || nameCompare;
      return nameCompare;
    });
    return items;
  }

  function generateHtml5VideoThumbnail(videoSrc, targetTime = 0.5) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      let resolved = false;
      const cleanup = () => {
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
        } catch (_) {}
      };
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve('');
        }
      }, 4000);

      video.onloadedmetadata = () => {
        try {
          const seekTime = (Number.isFinite(video.duration) && video.duration > 0)
            ? Math.min(Math.max(0.1, video.duration / 3), 2)
            : targetTime;
          video.currentTime = seekTime;
        } catch (_) {}
      };

      const capture = () => {
        if (resolved) return;
        try {
          const width = video.videoWidth || 320;
          const height = video.videoHeight || 180;
          if (width === 0 || height === 0) {
            resolved = true;
            clearTimeout(timer);
            cleanup();
            resolve('');
            return;
          }
          const canvas = document.createElement('canvas');
          const maxDim = 420;
          const scale = Math.min(1, maxDim / Math.max(width, height));
          canvas.width = Math.round(width * scale);
          canvas.height = Math.round(height * scale);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          resolved = true;
          clearTimeout(timer);
          cleanup();
          resolve(dataUrl);
        } catch (_) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          resolve('');
        }
      };

      video.onseeked = capture;
      video.onloadeddata = () => {
        if (!resolved && (video.currentTime === 0 || isNaN(video.currentTime))) {
          setTimeout(capture, 120);
        }
      };

      video.onerror = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          resolve('');
        }
      };

      video.src = toSafeFileUrl(videoSrc);
    });
  }

  function dualItemThumb(item) {
    if (item.isDirectory) {
      const cached = dualFolderThumbnailCache.get(item.path);
      return `<span class="su-dual-folder-main">📁</span>${cached ? `<img class="su-dual-folder-preview" src="${cached}" loading="lazy" draggable="false">` : ''}`;
    }
    if (item.mimeType?.startsWith('image/')) return `<img src="${localFileUrl(item.path)}" loading="lazy" draggable="false">`;
    if (item.mimeType?.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm|m4v|ogg)$/i.test(item.name || '')) {
      const cached = dualVideoThumbnailCache.get(item.path);
      if (cached) {
        return `<img class="su-dual-video-preview" src="${cached}" loading="lazy" draggable="false"><span class="su-dual-video-play" data-video-src="${localFileUrl(item.path)}" title="播放视频">▶</span>`;
      }
      return `<video class="su-dual-video-preview su-dual-video-tag" src="${localFileUrl(item.path)}#t=0.5" muted preload="metadata" draggable="false" style="object-fit:contain;background:transparent;"></video><span class="su-dual-video-play" data-video-src="${localFileUrl(item.path)}" title="播放视频">▶</span>`;
    }
    return `<span>${dualFileIcon(item)}</span>`;
  }

  function dualFileIcon(item) {
    const name = String(item.name || '').toLowerCase();
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return '📦';
    if (ext === 'pdf') return '📕';
    if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return '📝';
    if (['xls', 'xlsx', 'csv', 'numbers'].includes(ext)) return '📊';
    if (['ppt', 'pptx', 'key'].includes(ext)) return '📽️';
    if (['json', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'scss', 'xml', 'yaml', 'yml', 'py', 'java', 'go', 'rs', 'php', 'sql', 'sh'].includes(ext)) return '💻';
    if (['txt', 'log', 'srt', 'vtt'].includes(ext)) return '📃';
    if (item.mimeType?.startsWith('audio/')) return '🎵';
    return '❓';
  }

  function formatDualModifiedTime(value) {
    const date = new Date(value || 0);
    if (!Number.isFinite(date.getTime())) return '时间未知';
    return date.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).replace(/\//g, '-');
  }

  function dualFileFormat(item) {
    const name = String(item.name || '');
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).trim() : '';
    if (extension) return extension.toUpperCase();
    return fileCategory(item.mimeType || '') === 'other' ? '文件' : fileCategory(item.mimeType || '').toUpperCase();
  }

  function dualItemCardHtml(item, tab) {
    const isVideo = item.mimeType?.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm|m4v|ogg)$/i.test(item.name || '');
    const isImage = item.mimeType?.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(item.name || '');
    const meta = item.isDirectory
      ? `${Number(item.count) || 0} 个文件 · ${formatSize(Number(item.totalSize) || 0)}`
      : `${dualFileFormat(item)} · ${formatSize(item.size)}`;
    return `<div class="su-dual-item${tab.selected.has(item.path) ? ' selected' : ''}" data-item-path="${esc(item.path)}" data-item-dir="${item.isDirectory ? '1' : '0'}" data-item-video="${isVideo ? '1' : '0'}" data-item-image="${isImage ? '1' : '0'}" title="${esc(item.path)}"><div class="su-dual-item-thumb">${dualItemThumb(item)}</div><div class="su-dual-item-name">${esc(item.name)}</div><div class="su-dual-item-time" title="本地最后修改时间">${formatDualModifiedTime(item.modifiedTime)}</div><div class="su-dual-item-meta" title="${esc(meta)}">${esc(meta)}</div></div>`;
  }

  function dualGroupInfo(item, groupBy) {
    if (groupBy === 'type') {
      if (item.isDirectory) return { key: 'folder', label: '文件夹' };
      const category = fileCategory(item.mimeType);
      return { key: category, label: ({ image:'图片', video:'视频', audio:'音频', document:'文档', other:'其他' })[category] || '其他' };
    }
    const time = new Date(item.modifiedTime || 0).getTime();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const age = today.getTime() - time;
    if (time >= today.getTime()) return { key:'today', label:'今天' };
    if (age < 2 * 86400000) return { key:'yesterday', label:'昨天' };
    if (age < 7 * 86400000) return { key:'week', label:'过去 7 天' };
    if (age < 30 * 86400000) return { key:'month', label:'过去 30 天' };
    return { key:'earlier', label:'更早' };
  }

  function renderDualGroupedItems(items, tab) {
    if (!['date','type'].includes(tab.groupBy)) return items.map(item => dualItemCardHtml(item, tab)).join('');
    const groups = new Map();
    items.forEach(item => {
      const group = dualGroupInfo(item, tab.groupBy);
      if (!groups.has(group.key)) groups.set(group.key, { label:group.label, items:[] });
      groups.get(group.key).items.push(item);
    });
    const order = tab.groupBy === 'date'
      ? ['today','yesterday','week','month','earlier']
      : ['folder','image','video','audio','document','other'];
    return order.filter(key => groups.has(key)).map(key => {
      const group = groups.get(key);
      return `<div class="su-dual-group-title"><strong>${group.label}</strong><span>${group.items.length} 项</span></div>${group.items.map(item => dualItemCardHtml(item, tab)).join('')}`;
    }).join('');
  }

  async function loadDualFolderThumbnail(folderPath) {
    if (dualFolderThumbnailCache.has(folderPath)) return dualFolderThumbnailCache.get(folderPath);
    if (dualFolderThumbnailPending.has(folderPath)) return dualFolderThumbnailPending.get(folderPath);
    const pending = Promise.resolve(window.bridge?.localFiles?.getFolderAvatarMedia?.(folderPath))
      .then(async mediaPath => {
        if (!mediaPath) return '';
        if (/\.(mp4|mov|avi|mkv|webm|m4v|ogg)$/i.test(mediaPath)) {
          const videoThumb = await loadDualVideoThumbnail(mediaPath);
          return videoThumb || '';
        }
        return localFileUrl(mediaPath);
      })
      .catch(() => '')
      .then(url => {
        dualFolderThumbnailCache.set(folderPath, url);
        dualFolderThumbnailPending.delete(folderPath);
        return url;
      });
    dualFolderThumbnailPending.set(folderPath, pending);
    return pending;
  }

  async function loadDualVideoThumbnail(videoPath) {
    if (dualVideoThumbnailCache.has(videoPath)) return dualVideoThumbnailCache.get(videoPath);
    if (dualVideoThumbnailPending.has(videoPath)) return dualVideoThumbnailPending.get(videoPath);
    const pending = (async () => {
      let url = '';
      try {
        const thumbnailPath = await window.bridge?.localFiles?.getVideoThumbnail?.(videoPath, 480);
        if (thumbnailPath) url = localFileUrl(thumbnailPath);
      } catch (_) {}
      if (!url) {
        try {
          url = await generateHtml5VideoThumbnail(localFileUrl(videoPath));
        } catch (_) {}
      }
      if (url) dualVideoThumbnailCache.set(videoPath, url);
      dualVideoThumbnailPending.delete(videoPath);
      return url;
    })();
    dualVideoThumbnailPending.set(videoPath, pending);
    return pending;
  }

  function observeDualFolderThumbnails(host) {
    const previewCards = [...host.querySelectorAll('.su-dual-item[data-item-dir="1"], .su-dual-item[data-item-video="1"]')];
    if (!previewCards.length) return;
    const loadCard = card => {
      const itemPath = card.dataset.itemPath;
      const isVideo = card.dataset.itemVideo === '1';
      (isVideo ? loadDualVideoThumbnail(itemPath) : loadDualFolderThumbnail(itemPath)).then(url => {
        if (!url || !card.isConnected || card.dataset.itemPath !== itemPath) return;
        const thumb = card.querySelector('.su-dual-item-thumb');
        if (thumb) thumb.innerHTML = isVideo
          ? `<img class="su-dual-video-preview" src="${url}" loading="lazy" draggable="false"><span class="su-dual-video-play" data-video-src="${localFileUrl(itemPath)}" title="播放视频">▶</span>`
          : `<span class="su-dual-folder-main">📁</span><img class="su-dual-folder-preview" src="${url}" loading="lazy" draggable="false">`;
      });
    };
    if (!('IntersectionObserver' in window)) { previewCards.forEach(loadCard); return; }
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        loadCard(entry.target);
      });
    }, { root: host.querySelector('.su-dual-pane-content'), rootMargin: '180px' });
    previewCards.forEach(card => observer.observe(card));
  }

  function initDualPaneMarquee(host, side, tab) {
    const content = host.querySelector('.su-dual-pane-content');
    if (!content) return;

    // Prevent native image/link drag from cancelling marquee selection
    content.addEventListener('dragstart', e => e.preventDefault());

    let isSelecting = false;
    let isPending = false;
    let startX = 0, startY = 0;
    let selectionBox = null;
    let initialSelected = new Set();
    let startedOnCard = false;
    const DRAG_THRESHOLD = 5;
    const CARD_DRAG_THRESHOLD = 15;

    function beginSelection(e) {
      isSelecting = true;
      isPending = false;

      if (e.shiftKey || e.ctrlKey || e.metaKey || startedOnCard) {
        initialSelected = new Set(tab.selected);
      } else {
        tab.selected.clear();
        initialSelected = new Set();
        host.querySelectorAll('.su-dual-item.selected').forEach(c => c.classList.remove('selected'));
        updateDualTransferBar();
      }

      if (selectionBox) selectionBox.remove();
      selectionBox = document.createElement('div');
      selectionBox.className = 'su-selection-box';
      selectionBox.style.left = startX + 'px';
      selectionBox.style.top = startY + 'px';
      selectionBox.style.width = '0px';
      selectionBox.style.height = '0px';
      document.body.appendChild(selectionBox);
    }

    content.onmousedown = e => {
      if (e.button !== 0) return;
      if (e.target.closest('button, select, input, a, .su-dual-video-play, .su-dual-binding-hint button')) return;

      startedOnCard = Boolean(e.target.closest('.su-dual-item'));
      isPending = true;
      startX = e.clientX;
      startY = e.clientY;

      const onPointerMove = moveEvent => {
        if (!isPending && !isSelecting) return;
        if (moveEvent.buttons !== 1) {
          onPointerUp();
          return;
        }

        const currentX = moveEvent.clientX;
        const currentY = moveEvent.clientY;
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);

        if (isPending) {
          const threshold = startedOnCard ? CARD_DRAG_THRESHOLD : DRAG_THRESHOLD;
          if (width < threshold && height < threshold) return;
          beginSelection(moveEvent);
        }

        if (!selectionBox) return;

        const left = Math.min(startX, currentX);
        const top = Math.min(startY, currentY);
        selectionBox.style.left = left + 'px';
        selectionBox.style.top = top + 'px';
        selectionBox.style.width = width + 'px';
        selectionBox.style.height = height + 'px';

        const boxRect = { left, top, right: left + width, bottom: top + height };
        const cards = content.querySelectorAll('.su-dual-item');
        const newSelected = new Set(initialSelected);

        cards.forEach(card => {
          const cardRect = card.getBoundingClientRect();
          const isIntersecting = !(
            cardRect.right < boxRect.left ||
            cardRect.left > boxRect.right ||
            cardRect.bottom < boxRect.top ||
            cardRect.top > boxRect.bottom
          );
          const itemPath = card.dataset.itemPath;
          if (isIntersecting && itemPath) {
            newSelected.add(itemPath);
            card.classList.add('selected');
          } else if (!initialSelected.has(itemPath)) {
            card.classList.remove('selected');
          }
        });

        tab.selected = newSelected;
        updateDualTransferBar();
      };

      const onPointerUp = () => {
        isPending = false;
        if (isSelecting) {
          isSelecting = false;
          if (selectionBox) {
            selectionBox.remove();
            selectionBox = null;
          }
          tab._justMarqueeSelected = Date.now();
          updateDualTransferBar();
        }
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    };
  }

  async function directTransferToPane(targetSide, action = 'move') {
    const targetTab = activeDualTab(targetSide);
    if (!targetTab?.path) {
      if (typeof showToast === 'function') showToast('目标窗口未打开任何文件夹', 'info');
      return;
    }
    const targetPath = targetTab.path;
    const sourceSides = dualPaneOrder.slice(0, dualLayoutCount).filter(id => dualPanes[id]?.role === 'source');
    let itemsToTransfer = [];

    sourceSides.forEach(side => {
      const sourceTab = activeDualTab(side);
      if (!sourceTab) return;
      if (sourceTab.selected && sourceTab.selected.size > 0) {
        sourceTab.items.forEach(item => {
          if (sourceTab.selected.has(item.path)) {
            itemsToTransfer.push(item);
          }
        });
      } else if (sourceSides.length === 1 && sourceTab.items.length > 0) {
        itemsToTransfer = [...sortedDualItems(sourceTab)];
      }
    });

    if (!itemsToTransfer.length) {
      if (typeof showToast === 'function') showToast('原文件窗口中没有可移动的文件，请先选择文件或在原窗口打开文件夹', 'info');
      return;
    }

    const actionText = action === 'move' ? '移动' : '复制';
    const targetName = targetTab.name || targetPath.split(/[/\\]/).pop();

    let success = 0;
    for (const item of itemsToTransfer) {
      const result = item.isDirectory
        ? (action === 'move' ? await window.bridge?.localFiles?.moveFolderToFolder?.(item.path, targetPath, { conflict: 'rename' }) : await window.bridge?.localFiles?.copyFolderToFolder?.(item.path, targetPath, { conflict: 'rename' }))
        : (action === 'move' ? await window.bridge?.localFiles?.moveToFolder?.(item.path, targetPath, { conflict: 'rename' }) : await window.bridge?.localFiles?.copyToFolder?.(item.path, targetPath, { conflict: 'rename' }));
      if (result?.success) {
        success++;
        dualAssignments.delete(item.path);
      }
    }

    sourceSides.forEach(side => activeDualTab(side)?.selected.clear());
    await Promise.all(dualPaneOrder.slice(0, dualLayoutCount).map(side => loadDualTab(side, activeDualTab(side), true)));

    if (workMode === 'local-dual') renderLocalFolderList();
    updateDualTransferBar();
    if (typeof showToast === 'function') showToast(`已成功将 ${success} / ${itemsToTransfer.length} 个项目${actionText}到「${targetName}」`, success === itemsToTransfer.length ? 'success' : 'info');
  }

  function renderSymmetricDualPane(side) {
    const host = document.querySelector(`.su-dual-pane[data-dual-side="${side}"]`);
    if (!host) return;
    const pane = dualPanes[side];
    const tab = activeDualTab(side);
    if (!tab) return;

    const oldContent = host.querySelector('.su-dual-pane-content');
    if (oldContent && oldContent.scrollTop > 0) {
      tab._savedScrollTop = oldContent.scrollTop;
    }
    const savedScroll = tab._savedScrollTop || 0;

    // Migrate the former multi-pane-only default to the original browser default.
    if (Number(tab.cardSize) === 118) tab.cardSize = 130;
    const items = sortedDualItems(tab);
    const pathLabel = tab.path || '未选择文件夹';
    const hasActiveFilter = tab.filter !== 'all' || (tab.dateFilter || 'all') !== 'all' || Boolean(String(tab.search || '').trim());

    const sourceSides = dualPaneOrder.slice(0, dualLayoutCount).filter(id => dualPanes[id]?.role === 'source');
    const sourceSelectedCount = sourceSides.reduce((sum, id) => sum + (activeDualTab(id)?.selected.size || 0), 0);
    const sourceTotalCount = sourceSides.reduce((sum, id) => sum + (activeDualTab(id)?.items.length || 0), 0);
    const hasSourceFiles = sourceSelectedCount > 0 || sourceTotalCount > 0;
    const countLabel = sourceSelectedCount > 0 ? `选中的 ${sourceSelectedCount} 项` : (sourceTotalCount > 0 ? `全部 ${sourceTotalCount} 项` : '');

    let emptyHtml = '';
    if (pane.role === 'target' && tab.path) {
      emptyHtml = `<div class="su-dual-pane-empty su-dual-target-empty-dropzone" style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:32px 16px; background:#f8fafc; border:2px dashed #93c5fd; border-radius:10px; margin:14px;">
        <div style="font-size:36px;opacity:0.85;">📂</div>
        <div style="font-weight:700;color:#1e293b;font-size:14px;">当前目标文件夹为空</div>
        <div style="font-size:12px;color:#64748b;">${sourceSelectedCount > 0 ? `左侧原窗口已勾选 ${sourceSelectedCount} 个文件` : (sourceTotalCount > 0 ? `左侧原窗口共有 ${sourceTotalCount} 个待整理文件` : '请在左侧原窗口中选择或打开文件')}</div>
        <div style="display:flex; gap:8px; margin-top:4px; flex-wrap:wrap; justify-content:center;">
          <button class="su-btn su-btn-primary" data-action="assign-to-this-folder" style="font-size:12px; padding:7px 15px; font-weight:700; background:#10b981; border-color:#059669; cursor:pointer;" ${sourceSelectedCount > 0 ? '' : 'disabled'}>
            📥 仅分配（稍后统一移动）
          </button>
          <button class="su-btn su-btn-primary su-btn-warning" data-action="direct-move-to-pane" style="font-size:12px; padding:7px 15px; font-weight:700; cursor:pointer;" ${hasSourceFiles ? '' : 'disabled'}>
            📦 立即移动${countLabel}到这里
          </button>
          <button class="su-btn su-btn-primary" data-action="direct-copy-to-pane" style="font-size:12px; padding:7px 15px; font-weight:700; background:#3b82f6; border-color:#2563eb; cursor:pointer;" ${hasSourceFiles ? '' : 'disabled'}>
            📋 立即复制${countLabel}到这里
          </button>
        </div>
        <div style="font-size:11px;color:#94a3b8;margin-top:2px;">(支持点击上方操作按钮、拖拽文件到此处，或使用顶部/底部传输栏)</div>
      </div>`;
    } else {
      emptyHtml = `<div class="su-dual-pane-empty">${tab.path ? (tab.items.length && hasActiveFilter ? `当前筛选无结果（本地实际共 ${tab.items.length} 项）` : '此文件夹为空') : '点击“选择”或“＋”打开文件夹'}</div>`;
    }

    const cards = tab.loading
      ? '<div class="su-dual-pane-empty">正在读取文件夹…</div>'
      : items.length
        ? renderDualGroupedItems(items, tab)
        : emptyHtml;
    host.classList.toggle('su-active-target-pane', pane.role === 'target' && side === activeDualTarget);
    host.innerHTML = `<div class="su-dual-pane-role"><strong>窗口 ${dualPaneOrder.indexOf(side) + 1}</strong><select data-action="pane-role" title="设置此窗口是选择待整理文件的原文件窗口，还是接收文件的目标窗口"><option value="source" ${pane.role === 'source' ? 'selected' : ''}>原文件夹</option><option value="target" ${pane.role === 'target' ? 'selected' : ''}>目标文件夹</option></select>${pane.role === 'target' ? `<button data-action="activate-target" title="将此目标窗口设为当前分配目标窗口" class="su-dual-target-pick${side === activeDualTarget ? ' active' : ''}">${side === activeDualTarget ? '当前目标' : '设为当前目标'}</button><button data-action="assign-to-this-folder" title="将原文件窗口中选中的文件分配到当前打开的文件夹（标记待移动，不立即执行）" class="su-dual-target-pick" style="border-color:#10b981; color:#065f46; background:#ecfdf5; font-weight:600;">📥 仅分配</button><button data-action="direct-move-to-pane" title="将原文件窗口中的文件直接移动到当前打开的文件夹（立即执行）" class="su-dual-target-pick" style="border-color:#f59e0b; color:#b45309; background:#fffbeb; font-weight:600;">📦 立即移动</button><button data-action="direct-copy-to-pane" title="将原文件窗口中的文件直接复制到当前打开的文件夹（立即执行）" class="su-dual-target-pick" style="border-color:#3b82f6; color:#1d4ed8; background:#eff6ff; font-weight:600;">📋 立即复制</button>` : ''}</div>
      <div class="su-dual-pane-tabs">${pane.tabs.map(item => `<button class="su-dual-pane-tab${item.id === tab.id ? ' active' : ''}" data-tab-id="${item.id}" title="切换到标签页：${esc(item.name)}"><span class="su-dual-tab-name">${esc(item.name)}</span>${pane.tabs.length > 1 ? '<span class="su-dual-tab-close" title="关闭此标签页">×</span>' : ''}</button>`).join('')}<button class="su-dual-tab-add" title="选择另一个文件夹并在新标签页中打开">＋</button></div>
      <div class="su-dual-shortcut-bar"><span class="su-dual-shortcut-label">全局常用</span>${dualGlobalShortcuts.map((shortcut, index) => `<button class="su-dual-path-shortcut${shortcut.path === tab.path ? ' active' : ''}" data-shortcut-index="${index}" title="在当前窗口快速打开：${esc(shortcut.path)}"><span>${esc(shortcut.name)}</span><i title="从所有窗口删除此快捷路径">×</i></button>`).join('')}<button class="su-dual-add-shortcut" data-action="add-shortcut" title="添加一个所有宫格窗口都能使用的常用文件夹标签">＋常用路径</button></div>
      <div class="su-dual-pane-address"><button class="su-dual-pane-tool su-dual-nav-tool" data-action="back" title="返回此标签页浏览过的上一个位置" ${tab.historyIndex > 0 ? '' : 'disabled'}>←</button><button class="su-dual-pane-tool su-dual-nav-tool" data-action="forward" title="前往此标签页浏览历史中的下一个位置" ${tab.historyIndex >= 0 && tab.historyIndex < tab.history.length - 1 ? '' : 'disabled'}>→</button><button class="su-dual-pane-tool su-dual-nav-tool" data-action="up" title="进入当前文件夹的上一级文件夹" ${tab.path ? '' : 'disabled'}>↑</button><div class="su-dual-pane-path" title="当前文件夹：${esc(pathLabel)}">📂 ${esc(pathLabel)}</div><button class="su-dual-pane-tool" data-action="pick" title="重新选择当前标签页显示的本地文件夹；macOS 系统窗口中可按 ⌘⇧N 新建文件夹">选择</button><button class="su-dual-pane-tool su-dual-new-open" data-action="new-folder" title="在当前路径中新建单个文件夹，并立即进入这个新文件夹" ${tab.path ? '' : 'disabled'}>＋新建</button><button class="su-dual-pane-tool su-dual-batch-new" data-action="batch-new-folders" title="在当前文件夹中批量新建多个子文件夹（支持多行输入一次建多个）" ${tab.path ? '' : 'disabled'}>🗂️ 批量新建</button><button class="su-dual-pane-tool" data-action="open" title="在 Finder 中打开当前文件夹" ${tab.path ? '' : 'disabled'}>↗</button><button class="su-dual-pane-tool" data-action="refresh" title="重新读取当前文件夹，更新本地新增、删除和改名内容" ${tab.path ? '' : 'disabled'}>🔄</button></div>
      <div class="su-dual-pane-controls"><select class="su-dual-pane-filter" data-action="type-filter" title="按文件类型筛选当前窗口"><option value="all" ${tab.filter === 'all' ? 'selected' : ''}>全部类型</option><option value="folder" ${tab.filter === 'folder' ? 'selected' : ''}>文件夹</option><option value="image" ${tab.filter === 'image' ? 'selected' : ''}>图片</option><option value="video" ${tab.filter === 'video' ? 'selected' : ''}>视频</option><option value="audio" ${tab.filter === 'audio' ? 'selected' : ''}>音频</option><option value="document" ${tab.filter === 'document' ? 'selected' : ''}>文档</option><option value="other" ${tab.filter === 'other' ? 'selected' : ''}>其他</option></select><select class="su-dual-pane-filter" data-action="date-filter" title="按本地文件的最后修改时间筛选当前窗口"><option value="all" ${(tab.dateFilter || 'all') === 'all' ? 'selected' : ''}>全部时间</option><option value="today" ${tab.dateFilter === 'today' ? 'selected' : ''}>今天</option><option value="3d" ${tab.dateFilter === '3d' ? 'selected' : ''}>近 3 天</option><option value="7d" ${tab.dateFilter === '7d' ? 'selected' : ''}>近 7 天</option><option value="30d" ${tab.dateFilter === '30d' ? 'selected' : ''}>近 30 天</option></select><select class="su-dual-pane-filter" data-action="search-mode" title="选择名称关键词是包含匹配还是排除匹配"><option value="include" ${(tab.searchMode || 'include') === 'include' ? 'selected' : ''}>名称包含</option><option value="exclude" ${tab.searchMode === 'exclude' ? 'selected' : ''}>名称排除</option></select><input class="su-dual-pane-search" value="${esc(tab.search)}" placeholder="输入名称关键词…" title="输入文件或文件夹名称关键词进行筛选"><select class="su-dual-pane-filter" data-action="sort" title="设置当前窗口中文件和文件夹的排列顺序"><option value="name-asc" ${tab.sort === 'name-asc' ? 'selected' : ''}>名称 ↑</option><option value="name-desc" ${tab.sort === 'name-desc' ? 'selected' : ''}>名称 ↓</option><option value="date-desc" ${tab.sort === 'date-desc' ? 'selected' : ''}>时间 ↓</option><option value="date-asc" ${tab.sort === 'date-asc' ? 'selected' : ''}>时间 ↑</option></select><div class="su-dual-card-size" title="单独调整当前标签页的卡片和缩略图大小"><span>缩略图</span><button data-action="card-size-down" title="缩小当前标签页的卡片和缩略图" ${(Number(tab.cardSize) || 118) <= 78 ? 'disabled' : ''}>−</button><output>${Math.round((Number(tab.cardSize) || 118) / 118 * 100)}%</output><button data-action="card-size-up" title="放大当前标签页的卡片和缩略图" ${(Number(tab.cardSize) || 118) >= 218 ? 'disabled' : ''}>＋</button></div><button class="su-dual-pane-filter" data-action="dedup" title="扫描当前文件夹及其子文件夹，按文件内容查找重复文件；确认后才会移入废纸篓" ${tab.path ? '' : 'disabled'}>🧹 去重</button><button class="su-dual-pane-filter" data-action="flatten-folder" title="将所选文件夹及其所有子文件夹中的文件收纳到该文件夹；同名文件自动重命名并清理空目录">🗂️ 收纳所选</button><button class="su-dual-pane-filter" data-action="select-all" title="选择或取消选择当前筛选结果中的全部项目">全选</button><button class="su-dual-pane-view active" data-action="view" title="在网格缩略图和紧凑列表之间切换">${tab.view === 'grid' ? '☷ 列表' : '▦ 网格'}</button></div>
      <div class="su-dual-pane-content${tab.view === 'list' ? ' list' : ''}" style="--su-dual-card-size:${Math.min(320, Math.max(80, Number(tab.cardSize) || 130))}px">${cards}</div>`;

    observeDualFolderThumbnails(host);

    const groupSelect = document.createElement('select');
    groupSelect.className = 'su-dual-pane-filter';
    groupSelect.dataset.action = 'group-by';
    groupSelect.title = '将当前窗口的结果按日期或类型分组';
    groupSelect.innerHTML = `<option value="none">不分组</option><option value="date">日期分组</option><option value="type">类型分组</option>`;
    groupSelect.value = ['date','type'].includes(tab.groupBy) ? tab.groupBy : 'none';
    const cardSizeControl = host.querySelector('.su-dual-card-size');
    cardSizeControl?.parentElement?.insertBefore(groupSelect, cardSizeControl);
    const effectiveCardSize = Math.min(320, Math.max(80, Number(tab.cardSize) || 130));
    const sizeOutput = cardSizeControl?.querySelector('output');
    if (sizeOutput) sizeOutput.textContent = `${Math.round(effectiveCardSize / 130 * 100)}%`;
    const sizeButtons = cardSizeControl?.querySelectorAll('button');
    if (sizeButtons?.[0]) sizeButtons[0].disabled = effectiveCardSize <= 80;
    if (sizeButtons?.[1]) sizeButtons[1].disabled = effectiveCardSize >= 320;

    host.querySelector('[data-action="pane-role"]')?.addEventListener('change', event => {
      pane.role = event.target.value;
      if (pane.role === 'target') activeDualTarget = side;
      else if (activeDualTarget === side) activeDualTarget = dualPaneOrder.find(id => dualPanes[id].role === 'target') || '';
      saveDualPanes(); renderSymmetricDualWorkspace();
    });
    host.querySelector('[data-action="activate-target"]')?.addEventListener('click', () => {
      activeDualTarget = side; saveDualPanes(); renderSymmetricDualWorkspace();
    });
    host.querySelectorAll('[data-action="assign-to-this-folder"]').forEach(button => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!tab.path) return;
        activeDualTarget = side;
        let assigned = 0;
        sourceSides.forEach(sourceSide => {
          const sourceTab = activeDualTab(sourceSide);
          if (!sourceTab?.selected?.size) return;
          sourceTab.selected.forEach(sourcePath => {
            dualAssignments.set(sourcePath, tab.path);
            assigned += 1;
          });
          sourceTab.selected.clear();
          sourceTab._lastClickedPath = null;
        });
        if (assigned) {
          updateDualTransferBar();
          renderSymmetricDualWorkspace();
          if (dualSidebarVisible) renderLocalFolderList();
          if (typeof showToast === 'function') {
            showToast(`已将 ${assigned} 个项目分配到「${tab.name || tab.path.split(/[/\\]/).pop()}」`, 'success');
          }
        } else {
          if (typeof showToast === 'function') {
            showToast('请先在左侧原文件窗口中勾选要分配的文件或文件夹', 'info');
          }
        }
      });
    });
    host.querySelectorAll('[data-action="direct-move-to-pane"]').forEach(button => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        directTransferToPane(side, 'move');
      });
    });
    host.querySelectorAll('[data-action="direct-copy-to-pane"]').forEach(button => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        directTransferToPane(side, 'copy');
      });
    });

    host.querySelectorAll('.su-dual-pane-tab').forEach(button => button.addEventListener('click', event => {
      if (event.target.closest('.su-dual-tab-close')) {
        if (pane.tabs.length <= 1) return;
        const index = pane.tabs.findIndex(item => item.id === button.dataset.tabId);
        pane.tabs.splice(index, 1);
        if (pane.activeId === button.dataset.tabId) pane.activeId = pane.tabs[Math.max(0, index - 1)].id;
        saveDualPanes(); renderSymmetricDualPane(side); updateDualTransferBar();
        return;
      }
      pane.activeId = button.dataset.tabId; saveDualPanes(); renderSymmetricDualPane(side); updateDualTransferBar();
    }));
    host.querySelector('.su-dual-tab-add')?.addEventListener('click', () => pickDualFolder(side, true));
    host.querySelector('[data-action="add-shortcut"]')?.addEventListener('click', async () => {
      const picked = await window.bridge?.localFiles?.pickFolder?.({ title: `为窗口 ${dualPaneOrder.indexOf(side) + 1} 添加常用路径` });
      const folderPath = Array.isArray(picked) ? picked[0] : picked;
      if (!folderPath) return;
      if (dualGlobalShortcuts.some(shortcut => shortcut.path === folderPath)) { showToast('这个文件夹已经在全局常用路径中。'); return; }
      const defaultName = folderPath.replace(/[\\/]+$/, '').split(/[/\\]/).pop() || '常用路径';
      const name = await showPrompt('快捷路径标签名称：', defaultName);
      if (!name?.trim()) return;
      dualGlobalShortcuts.push({ name: name.trim(), path: folderPath });
      saveDualPanes(); renderSymmetricDualWorkspace();
    });
    host.querySelectorAll('.su-dual-path-shortcut').forEach(button => button.addEventListener('click', event => {
      const index = Number(button.dataset.shortcutIndex);
      if (event.target.closest('i')) {
        dualGlobalShortcuts.splice(index, 1); saveDualPanes(); renderSymmetricDualWorkspace(); return;
      }
      const shortcut = dualGlobalShortcuts[index];
      if (shortcut?.path) navigateDualTab(side, tab, shortcut.path);
    }));
    host.querySelector('[data-action="pick"]')?.addEventListener('click', () => pickDualFolder(side, false));
    host.querySelector('[data-action="refresh"]')?.addEventListener('click', () => loadDualTab(side, tab, true));
    host.querySelector('[data-action="open"]')?.addEventListener('click', () => window.bridge?.openPath?.(tab.path));
    host.querySelector('[data-action="back"]')?.addEventListener('click', () => travelDualHistory(side, tab, -1));
    host.querySelector('[data-action="forward"]')?.addEventListener('click', () => travelDualHistory(side, tab, 1));
    host.querySelector('[data-action="up"]')?.addEventListener('click', () => { const parent = tab.path.replace(/[/\\][^/\\]+$/, ''); if (parent && parent !== tab.path) navigateDualTab(side, tab, parent); });
    host.querySelector('[data-action="new-folder"]')?.addEventListener('click', async () => {
      const name = await showPrompt('新建文件夹名称：', '');
      if (!name?.trim()) return;
      const result = await window.bridge?.localFiles?.createFolder?.(tab.path, name.trim());
      if (!result?.success) { alert('新建文件夹失败：' + (result?.error || '未知错误')); return; }
      navigateDualTab(side, tab, result.path);
      if (typeof showToast === 'function') showToast(`已新建并打开：${result.name}`, 'success');
    });
    host.querySelector('[data-action="batch-new-folders"]')?.addEventListener('click', async () => {
      if (!tab.path) { showToast('请先选择或打开一个文件夹', 'info'); return; }
      const folderName = tab.name || tab.path.split(/[/\\]/).pop() || '当前文件夹';
      await promptCreateFolders(tab.path, folderName);
      await loadDualTab(side, tab, true);
    });
    host.querySelector('[data-action="type-filter"]')?.addEventListener('change', event => { tab.filter = event.target.value; saveDualPanes(); renderSymmetricDualPane(side); });
    host.querySelector('[data-action="date-filter"]')?.addEventListener('change', event => { tab.dateFilter = event.target.value; saveDualPanes(); renderSymmetricDualPane(side); });
    host.querySelector('[data-action="search-mode"]')?.addEventListener('change', event => { tab.searchMode = event.target.value; saveDualPanes(); renderSymmetricDualPane(side); });
    host.querySelector('[data-action="select-all"]')?.addEventListener('click', () => {
      const visiblePaths = sortedDualItems(tab).map(item => item.path);
      const allSelected = visiblePaths.length && visiblePaths.every(itemPath => tab.selected.has(itemPath));
      tab.selected = allSelected ? new Set() : new Set(visiblePaths);
      renderSymmetricDualPane(side); updateDualTransferBar();
    });
    host.querySelector('.su-dual-pane-search')?.addEventListener('input', event => {
      tab.search = event.target.value;
      renderSymmetricDualPane(side);
      const nextInput = host.querySelector('.su-dual-pane-search');
      nextInput?.focus();
      nextInput?.setSelectionRange(tab.search.length, tab.search.length);
    });
    host.querySelector('[data-action="sort"]')?.addEventListener('change', event => { tab.sort = event.target.value; saveDualPanes(); renderSymmetricDualPane(side); });
    host.querySelector('[data-action="group-by"]')?.addEventListener('change', event => { tab.groupBy = event.target.value; saveDualPanes(); renderSymmetricDualPane(side); });
    host.querySelector('[data-action="card-size-down"]')?.addEventListener('click', () => { tab.cardSize = Math.max(80, (Number(tab.cardSize) || 130) - 10); saveDualPanes(); renderSymmetricDualPane(side); });
    host.querySelector('[data-action="card-size-up"]')?.addEventListener('click', () => { tab.cardSize = Math.min(320, (Number(tab.cardSize) || 130) + 10); saveDualPanes(); renderSymmetricDualPane(side); });
    host.querySelector('[data-action="dedup"]')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      const originalText = button.textContent;
      button.disabled = true; button.textContent = '⏳ 扫描中';
      try {
        const files = await window.bridge?.localFiles?.scanFolder?.(tab.path, { force: true }) || [];
        if (files.length < 2) { showToast('当前文件夹及子文件夹中不足两个文件。'); return; }
        button.textContent = '⏳ 查重中';
        const result = await window.bridge?.localFiles?.findDuplicates?.(files.map(file => file.path));
        if (!result?.success) { alert('查重失败：' + (result?.error || '未知错误')); return; }
        if (!result.duplicateGroups?.length) { showToast('没有发现内容完全一致的重复文件。', 'success'); return; }
        showDuplicateReviewModal(result.duplicateGroups, () => loadDualTab(side, tab, true));
      } catch (error) {
        alert('查重出错：' + error.message);
      } finally {
        if (button.isConnected) { button.disabled = false; button.textContent = originalText; }
      }
    });
    host.querySelector('[data-action="flatten-folder"]')?.addEventListener('click', async event => {
      const selectedFolders = tab.items.filter(item => item.isDirectory && tab.selected.has(item.path));
      if (!selectedFolders.length) {
        showToast('请先选中需要整理的文件夹。', 'info');
        return;
      }
      // 父、子目录同时被选中时仅处理父目录，避免子目录被重复整理。
      const folders = selectedFolders.filter(folder => !selectedFolders.some(other => other.path !== folder.path && folder.path.startsWith(other.path + (/\\/.test(other.path) ? '\\' : '/'))));
      const skippedNested = selectedFolders.length - folders.length;
      const folderNames = folders.slice(0, 3).map(folder => `「${folder.name}」`).join('、');
      const moreLabel = folders.length > 3 ? ` 等 ${folders.length} 个文件夹` : '';
      if (!confirm(`确定整理 ${folderNames}${moreLabel} 吗？\n\n每个文件夹内所有子文件夹中的文件会移到各自的根目录；同名文件会自动重命名，空子文件夹会被删除。${skippedNested ? `\n\n已自动跳过 ${skippedNested} 个已包含在父文件夹内的选择。` : ''}`)) return;
      const button = event.currentTarget;
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = '⏳ 整理中';
      try {
        let moved = 0;
        let renamed = 0;
        let removedDirectories = 0;
        const failures = [];
        for (const folder of folders) {
          const result = await window.bridge?.localFiles?.flattenFolder?.(folder.path);
          if (!result?.success) {
            failures.push(`「${folder.name}」：${result?.error || '未知错误'}`);
            continue;
          }
          moved += result.moved || 0;
          renamed += result.renamed || 0;
          removedDirectories += result.removedDirectories || 0;
        }
        tab.selected.clear();
        await loadDualTab(side, tab, true);
        if (failures.length) alert(`部分文件夹整理失败：\n${failures.join('\n')}`);
        showToast(`整理完成：处理 ${folders.length - failures.length}/${folders.length} 个文件夹，移动 ${moved} 个文件，清理 ${removedDirectories} 个空文件夹${renamed ? `，${renamed} 个同名文件已重命名` : ''}。`, failures.length ? 'info' : 'success');
      } catch (error) {
        alert('整理出错：' + error.message);
      } finally {
        if (button.isConnected) { button.disabled = false; button.textContent = originalText; }
      }
    });
    host.querySelector('[data-action="view"]')?.addEventListener('click', () => { tab.view = tab.view === 'grid' ? 'list' : 'grid'; saveDualPanes(); renderSymmetricDualPane(side); });

    // Enable marquee selection on the dual pane content area
    initDualPaneMarquee(host, side, tab);

    // Clicking background of the pane content clears selection
    const contentEl = host.querySelector('.su-dual-pane-content');
    if (contentEl) {
      if (savedScroll > 0) {
        contentEl.scrollTop = savedScroll;
      }
      contentEl.addEventListener('scroll', () => {
        tab._savedScrollTop = contentEl.scrollTop;
      }, { passive: true });

      contentEl.addEventListener('click', (e) => {
        if (tab._justMarqueeSelected && Date.now() - tab._justMarqueeSelected < 250) return;
        if (e.target.closest('.su-dual-target-empty-dropzone')) return;
        if (e.target === contentEl || e.target.classList.contains('su-dual-group-section') || e.target.closest('.su-dual-pane-empty')) {
          tab.selected.clear();
          tab._lastClickedPath = null;
          host.querySelectorAll('.su-dual-item.selected').forEach(c => c.classList.remove('selected'));
          updateDualTransferBar();
        }
      });

      contentEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.su-dual-item')) return;
        e.preventDefault();
        if (!tab.path) return;
        const folderName = tab.name || tab.path.split(/[/\\]/).pop() || '当前文件夹';
        const emptyMenuItems = [
          { icon: '📁', label: '新建单个文件夹', action: async () => {
            const name = await showPrompt('新建文件夹名称：', '');
            if (!name?.trim()) return;
            const res = await window.bridge?.localFiles?.createFolder?.(tab.path, name.trim());
            if (res?.success) { await loadDualTab(side, tab, true); showToast(`已新建文件夹：${res.name}`, 'success'); }
          }},
          { icon: '🗂️', label: '批量新建文件夹（每行一个）', action: async () => {
            await promptCreateFolders(tab.path, folderName);
            await loadDualTab(side, tab, true);
          }},
          { icon: '🔄', label: '刷新当前窗口', action: () => loadDualTab(side, tab, true) },
          { icon: '↗', label: '在 Finder 中打开', action: () => window.bridge?.openPath?.(tab.path) }
        ];
        showLocalContextMenu(e.clientX, e.clientY, emptyMenuItems);
      });

      // Direct Drag & Drop into target pane
      if (pane.role === 'target' && tab.path) {
        contentEl.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          contentEl.classList.add('su-drag-over');
        });
        contentEl.addEventListener('dragleave', () => {
          contentEl.classList.remove('su-drag-over');
        });
        contentEl.addEventListener('drop', (e) => {
          e.preventDefault();
          contentEl.classList.remove('su-drag-over');
          directTransferToPane(side, 'move');
        });
      }
    }

    host.querySelectorAll('.su-dual-item').forEach(card => {
      card.addEventListener('click', event => {
        if (tab._justMarqueeSelected && Date.now() - tab._justMarqueeSelected < 250) return;
        const playBtn = event.target.closest('.su-dual-video-play');
        if (playBtn) {
          event.stopPropagation();
          const videoSrc = playBtn.dataset.videoSrc || localFileUrl(card.dataset.itemPath);
          if (videoSrc) showVideoPlayer(videoSrc);
          return;
        }
        const itemPath = card.dataset.itemPath;
        // Shift-click range selection
        if (event.shiftKey && tab._lastClickedPath) {
          const sortedItems = sortedDualItems(tab);
          const lastIdx = sortedItems.findIndex(x => x.path === tab._lastClickedPath);
          const currIdx = sortedItems.findIndex(x => x.path === itemPath);
          if (lastIdx >= 0 && currIdx >= 0) {
            const [start, end] = [Math.min(lastIdx, currIdx), Math.max(lastIdx, currIdx)];
            for (let i = start; i <= end; i++) {
              tab.selected.add(sortedItems[i].path);
            }
          } else {
            tab.selected.add(itemPath);
          }
        } else {
          // Toggle selection directly without clearing previous selections (default multi-select, exactly like 本地整理)
          if (tab.selected.has(itemPath)) {
            tab.selected.delete(itemPath);
          } else {
            tab.selected.add(itemPath);
          }
        }
        tab._lastClickedPath = itemPath;
        if (pane.role === 'target' && card.dataset.itemDir === '1' && tab.selected.has(itemPath)) {
          activeDualTarget = side;
          let assigned = 0;
          dualPaneOrder.slice(0, dualLayoutCount).forEach(sourceSide => {
            if (dualPanes[sourceSide]?.role !== 'source') return;
            const sourceTab = activeDualTab(sourceSide);
            if (!sourceTab?.selected?.size) return;
            sourceTab.selected.forEach(sourcePath => {
              dualAssignments.set(sourcePath, itemPath);
              assigned += 1;
            });
            sourceTab.selected.clear();
            sourceTab._lastClickedPath = null;
          });
          tab.selected.delete(itemPath);
          if (assigned && typeof showToast === 'function') {
            showToast(`已将 ${assigned} 个项目分配到「${card.querySelector('.su-dual-item-name')?.textContent || '目标文件夹'}」`, 'success');
          }
          renderSymmetricDualWorkspace();
          if (dualSidebarVisible) renderLocalFolderList();
          return;
        }
        host.querySelectorAll('.su-dual-item').forEach(c => {
          c.classList.toggle('selected', tab.selected.has(c.dataset.itemPath));
        });
        updateDualTransferBar();
        if (dualSidebarVisible) renderLocalFolderList();
      });
      card.addEventListener('dblclick', (event) => {
        if (event.target.closest('.su-dual-video-play')) return;
        if (card.dataset.itemDir === '1') {
          navigateDualTab(side, tab, card.dataset.itemPath);
        } else if (card.dataset.itemVideo === '1') {
          showVideoPlayer(localFileUrl(card.dataset.itemPath));
        } else if (card.dataset.itemImage === '1') {
          showImageLightbox(localFileUrl(card.dataset.itemPath));
        } else {
          window.bridge?.openPath?.(card.dataset.itemPath || tab.path);
        }
      });
      card.addEventListener('contextmenu', event => {
        event.preventDefault();
        const item = tab.items.find(entry => entry.path === card.dataset.itemPath);
        if (!item) return;
        const menuItems = [];
        if (item.isDirectory) {
          menuItems.push({ icon:'📂', label:'进入文件夹', action:() => navigateDualTab(side, tab, item.path) });
          menuItems.push({
            icon: '🗂️', label: '在内部批量新建子文件夹', action: async () => {
              await promptCreateFolders(item.path, item.name);
              await loadDualTab(side, tab, true);
            }
          });
          if (!localTargetFolders.some(f => f.path === item.path)) {
            menuItems.push({
              icon: '🎯', label: '设为目标文件夹', action: () => {
                localTargetFolders.push({ id: 'lf-' + (++localTargetCounter) + '-' + Date.now(), name: item.name, path: item.path, group: '' });
                saveLocalTargetFolders();
                renderSlotList();
                showToast(`已将「${item.name}」设为目标文件夹`, 'success');
              }
            });
          } else {
            menuItems.push({
              icon: '🚫', label: '取消目标文件夹', action: () => {
                const target = localTargetFolders.find(f => f.path === item.path);
                if (target) removeLocalFolder(target.id);
              }
            });
          }
        } else {
          const isVideo = item.mimeType?.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm|m4v|ogg)$/i.test(item.name || '');
          const isImage = item.mimeType?.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(item.name || '');
          if (isVideo) {
            menuItems.push({ icon:'▶', label:'播放视频', action:() => showVideoPlayer(localFileUrl(item.path)) });
          } else if (isImage) {
            menuItems.push({ icon:'🖼️', label:'查看大图', action:() => showImageLightbox(localFileUrl(item.path)) });
          }
          menuItems.push({ icon:'🔍', label:'在 Finder 中显示', action:() => window.bridge?.openPath?.(tab.path) });
        }
        menuItems.push(
          { icon:'✏️', label:'重命名', action:async () => { const name = await showPrompt('重命名：', item.name); if (!name?.trim() || name.trim() === item.name) return; const result = await window.bridge?.renameLocalFiles?.([{ source:item.path, newName:name.trim(), conflictStyle:'number' }]); if (!result?.renamed?.length) alert('重命名失败：' + (result?.errors?.[0]?.message || '未知错误')); await loadDualTab(side, tab, true); } },
          { icon:'🗑️', label:'移到系统废纸篓', action:async () => { if (!confirm(`确定将「${item.name}」移到系统废纸篓？`)) return; const result = await window.bridge?.localFiles?.trashFiles?.([item.path]); if (!result?.success) alert('删除失败'); await loadDualTab(side, tab, true); } }
        );
        if (dualAssignments.has(item.path)) menuItems.splice(1, 0, { icon:'↩️', label:'取消此项目分配', action:() => { dualAssignments.delete(item.path); updateDualTransferBar(); showToast(`已取消「${item.name}」的分配`, 'success'); } });
        showLocalContextMenu(event.clientX, event.clientY, menuItems);
      });
    });
  }

  async function pickDualFolder(side, newTab) {
    try {
      const picked = await window.bridge?.localFiles?.pickFolder?.({ title: `窗口 ${dualPaneOrder.indexOf(side) + 1} 选择文件夹` });
      const folderPath = Array.isArray(picked) ? picked[0] : picked;
      if (!folderPath) return;
      const pane = dualPanes[side];
      let tab = activeDualTab(side);
      if (newTab || !tab) { tab = makeDualTab(folderPath); pane.tabs.push(tab); pane.activeId = tab.id; }
      else { navigateDualTab(side, tab, folderPath); }
      saveDualPanes();
      await loadDualTab(side, tab, true);
    } catch (err) {
      console.error('[MultiWindow] 选择文件夹失败:', err);
      if (typeof showToast === 'function') {
        showToast(`选择文件夹失败: ${err?.message || err}`, 'error');
      }
    }
  }

  function renderSymmetricDualWorkspace() {
    loadDualPanes();
    ensureDualPaneCount(dualLayoutCount, dualLayoutColumns);
    const workspace = $('su-dual-workspace');
    if (!workspace) return;
    const savedWorkspaceTop = workspace.scrollTop;
    const savedWorkspaceLeft = workspace.scrollLeft;
    const visible = dualPaneOrder.slice(0, dualLayoutCount);
    const cols = dualLayoutColumns;
    const rows = Math.ceil(dualLayoutCount / cols);

    if (dualLayoutCount === 2 && cols === 2) {
      workspace.classList.add('su-two-pane-layout');
    } else {
      workspace.classList.remove('su-two-pane-layout');
    }

    if (!Array.isArray(dualColRatios) || dualColRatios.length !== cols) {
      dualColRatios = cols === 2 && dualLayoutCount === 2
        ? [dualPaneRatio, 1 - dualPaneRatio]
        : Array(cols).fill(1 / cols);
    }
    if (!Array.isArray(dualRowRatios) || dualRowRatios.length !== rows) {
      dualRowRatios = Array(rows).fill(1 / rows);
    }
    if (!Array.isArray(dualRowHeights) || dualRowHeights.length !== rows) {
      const defaultH = rows === 1 ? null : Math.max(380, Math.floor(((workspace.clientHeight || 700) - (rows - 1) * 6 - 16) / rows) || 400);
      dualRowHeights = rows === 1 ? [] : Array(rows).fill(defaultH);
    }

    const colTracks = [];
    for (let c = 0; c < cols; c++) {
      const r = Math.max(0.08, dualColRatios[c] || (1 / cols));
      colTracks.push(`${Math.round(r * 10000) / 100}fr`);
      if (c < cols - 1) colTracks.push('6px');
    }
    workspace.style.gridTemplateColumns = colTracks.join(' ');

    const rowTracks = [];
    if (rows === 1) {
      rowTracks.push('1fr');
    } else {
      for (let r = 0; r < rows; r++) {
        const h = Math.max(240, Math.round(dualRowHeights[r] || 400));
        rowTracks.push(`${h}px`);
        rowTracks.push('6px');
      }
    }
    workspace.style.gridTemplateRows = rowTracks.join(' ');

    const elementsHtml = [];

    // 1. Panes
    visible.forEach((side, index) => {
      const r = Math.floor(index / cols);
      const c = index % cols;
      const gridRow = 2 * r + 1;
      const gridCol = 2 * c + 1;
      elementsHtml.push(`<div class="su-dual-pane" data-dual-side="${side}" style="grid-row:${gridRow}; grid-column:${gridCol};"></div>`);
    });

    // 2. Vertical Column Resizers
    for (let c = 0; c < cols - 1; c++) {
      const gridCol = 2 * c + 2;
      elementsHtml.push(`<div class="su-dual-resizer su-dual-resizer-col" data-resizer-col="${c}" style="grid-column:${gridCol}; grid-row:1 / -1;" title="左右拖动调整窗口宽度"><span>⋮</span></div>`);
    }

    // 3. Horizontal Row Resizers (Every row has its own bottom resizer)
    if (rows > 1) {
      for (let r = 0; r < rows; r++) {
        const gridRow = 2 * r + 2;
        elementsHtml.push(`<div class="su-dual-resizer su-dual-resizer-row" data-resizer-row="${r}" style="grid-row:${gridRow}; grid-column:1 / -1;" title="上下拖动调整第 ${r + 1} 行窗口高度"><span>⋯</span></div>`);
      }
    }

    workspace.innerHTML = elementsHtml.join('');

    visible.forEach(side => renderSymmetricDualPane(side));
    bindDualResizers();
    visible.forEach(side => { const tab = activeDualTab(side); if (tab?.path && !tab.items.length && !tab.loading) loadDualTab(side, tab); });
    document.querySelectorAll('.su-multi-layout-btn').forEach(button => button.classList.toggle('active', button.dataset.layoutCount === String(dualLayoutCount) || (button.dataset.layoutCount === 'custom' && ![2,4,6,8].includes(dualLayoutCount))));
    const summary = $('su-multi-layout-summary');
    if (summary) summary.textContent = `${dualLayoutCount} 个窗口 · ${dualLayoutColumns} 列 · 点击目标窗口可切换接收位置`;
    updateDualTransferBar();

    if (savedWorkspaceTop > 0) workspace.scrollTop = savedWorkspaceTop;
    if (savedWorkspaceLeft > 0) workspace.scrollLeft = savedWorkspaceLeft;
  }

  function bindDualResizers() {
    const workspace = $('su-dual-workspace');
    if (!workspace) return;
    const cols = dualLayoutColumns;
    const rows = Math.ceil(dualLayoutCount / cols);

    // 左右拖拽调列宽
    workspace.querySelectorAll('.su-dual-resizer-col').forEach(resizer => {
      const colIndex = parseInt(resizer.dataset.resizerCol, 10);
      if (isNaN(colIndex)) return;

      resizer.onpointerdown = event => {
        event.preventDefault();
        event.stopPropagation();
        resizer.classList.add('dragging');
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';

        const rect = workspace.getBoundingClientRect();
        const availableWidth = Math.max(100, rect.width - (cols - 1) * 6);
        const startX = event.clientX;

        if (!Array.isArray(dualColRatios) || dualColRatios.length !== cols) {
          dualColRatios = Array(cols).fill(1 / cols);
        }
        const initialRatios = [...dualColRatios];
        const initialC0 = initialRatios[colIndex] || (1 / cols);
        const initialC1 = initialRatios[colIndex + 1] || (1 / cols);
        const pairSum = initialC0 + initialC1;

        const onPointerMove = moveEvent => {
          const deltaX = moveEvent.clientX - startX;
          const deltaRatio = deltaX / availableWidth;
          const minRatio = 0.10 * pairSum;
          const maxRatio = 0.90 * pairSum;
          const newC0 = Math.min(maxRatio, Math.max(minRatio, initialC0 + deltaRatio));
          const newC1 = pairSum - newC0;

          dualColRatios[colIndex] = newC0;
          dualColRatios[colIndex + 1] = newC1;
          if (dualLayoutCount === 2 && cols === 2) {
            dualPaneRatio = Math.min(0.78, Math.max(0.22, newC0 / pairSum));
          }

          const colTracks = [];
          for (let c = 0; c < cols; c++) {
            const r = Math.max(0.08, dualColRatios[c] || (1 / cols));
            colTracks.push(`${Math.round(r * 10000) / 100}fr`);
            if (c < cols - 1) colTracks.push('6px');
          }
          workspace.style.gridTemplateColumns = colTracks.join(' ');
        };

        const onPointerUp = () => {
          resizer.classList.remove('dragging');
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
          window.removeEventListener('pointermove', onPointerMove);
          window.removeEventListener('pointerup', onPointerUp);
          window.removeEventListener('pointercancel', onPointerUp);
          saveDualPanes();
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
      };
    });

    // 上下拖拽调行高（每行独立自由调节）
    workspace.querySelectorAll('.su-dual-resizer-row').forEach(resizer => {
      const rowIndex = parseInt(resizer.dataset.resizerRow, 10);
      if (isNaN(rowIndex)) return;

      resizer.onpointerdown = event => {
        event.preventDefault();
        event.stopPropagation();
        resizer.classList.add('dragging');
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'row-resize';

        const startY = event.clientY;
        if (!Array.isArray(dualRowHeights) || dualRowHeights.length !== rows) {
          const defaultH = Math.max(380, Math.floor(((workspace.clientHeight || 700) - rows * 6 - 16) / rows) || 400);
          dualRowHeights = Array(rows).fill(defaultH);
        }
        const initialH = dualRowHeights[rowIndex] || 400;

        const onPointerMove = moveEvent => {
          const deltaY = moveEvent.clientY - startY;
          const newH = Math.max(200, initialH + deltaY);
          dualRowHeights[rowIndex] = newH;

          const rowTracks = [];
          for (let r = 0; r < rows; r++) {
            rowTracks.push(`${Math.max(200, Math.round(dualRowHeights[r] || 400))}px`);
            rowTracks.push('6px');
          }
          workspace.style.gridTemplateRows = rowTracks.join(' ');
        };

        const onPointerUp = () => {
          resizer.classList.remove('dragging');
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
          window.removeEventListener('pointermove', onPointerMove);
          window.removeEventListener('pointerup', onPointerUp);
          window.removeEventListener('pointercancel', onPointerUp);
          saveDualPanes();
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
      };
    });
  }

  function updateDualTransferBar() {
    const sourcePanes = dualPaneOrder.slice(0, dualLayoutCount).filter(id => dualPanes[id]?.role === 'source');
    const sourceCount = sourcePanes.reduce((sum, id) => sum + (activeDualTab(id)?.selected.size || 0), 0);
    const assignedCount = dualAssignments.size;
    document.querySelectorAll('.su-dual-selection-info').forEach(info => { info.textContent = `已分配 ${assignedCount} 项${sourceCount ? ` · 当前仍选中 ${sourceCount} 项，可点击目标文件夹继续分配` : ''}`; });
    document.querySelectorAll('[data-dual-transfer]').forEach(button => { button.disabled = !assignedCount; });
    updateDualBindingHints();
  }

  function updateDualBindingHints() {
    document.querySelectorAll('.su-dual-binding-hint,.su-dual-binding-count').forEach(element => element.remove());
    if (!dualAssignments.size) return;
    const targetCounts = new Map();
    const targetSources = new Map();
    dualAssignments.forEach((targetPath, sourcePath) => {
      targetCounts.set(targetPath, (targetCounts.get(targetPath) || 0) + 1);
      if (!targetSources.has(targetPath)) targetSources.set(targetPath, []);
      targetSources.get(targetPath).push(sourcePath);
    });
    dualPaneOrder.slice(0, dualLayoutCount).forEach(side => {
      const pane = dualPanes[side];
      const tab = activeDualTab(side);
      const host = document.querySelector(`.su-dual-pane[data-dual-side="${side}"]`);
      if (!host || !tab) return;
      if (pane.role === 'source') {
        host.querySelectorAll('.su-dual-item').forEach(card => {
          const targetPath = dualAssignments.get(card.dataset.itemPath);
          if (!targetPath) return;
          const targetName = targetPath.replace(/[\\/]+$/, '').split(/[/\\]/).pop() || targetPath;
          const hint = document.createElement('div');
          hint.className = 'su-dual-binding-hint';
          hint.title = `当前待复制或移动到：${targetPath}`;
          const label = document.createElement('span');
          label.textContent = `→ ${targetName}`;
          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.title = '仅取消此项目的分配，不删除或移动文件';
          cancel.textContent = '×';
          cancel.addEventListener('click', event => {
            event.preventDefault(); event.stopPropagation();
            dualAssignments.delete(card.dataset.itemPath);
            updateDualTransferBar();
            if (typeof showToast === 'function') showToast('已取消此项目分配', 'success');
          });
          hint.append(label, cancel);
          card.appendChild(hint);
        });
      } else if (pane.role === 'target') {
        [...host.querySelectorAll('.su-dual-item[data-item-dir="1"]')].filter(card => targetCounts.has(card.dataset.itemPath)).forEach(card => {
          const count = targetCounts.get(card.dataset.itemPath);
          const sourcePaths = targetSources.get(card.dataset.itemPath) || [];
          const nameCounts = new Map();
          sourcePaths.forEach(sourcePath => {
            const name = sourcePath.replace(/[\\/]+$/, '').split(/[/\\]/).pop() || sourcePath;
            nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
          });
          const detailLines = sourcePaths.map((sourcePath, index) => {
            const name = sourcePath.replace(/[\\/]+$/, '').split(/[/\\]/).pop() || sourcePath;
            return `${index + 1}. ${nameCounts.get(name) > 1 ? sourcePath : name}`;
          });
          const badge = document.createElement('span');
          badge.className = 'su-dual-binding-count';
          badge.title = `已绑定 ${count} 个项目：\n${detailLines.join('\n')}`;
          badge.textContent = String(count);
          card.appendChild(badge);
        });
      }
    });
  }

  async function transferDualSelection(action) {
    if (!dualAssignments.size) return;
    const allSourceItems = new Map();
    dualPaneOrder.slice(0, dualLayoutCount).filter(id => dualPanes[id]?.role === 'source').forEach(side => {
      dualPanes[side].tabs.forEach(tab => tab.items.forEach(item => allSourceItems.set(item.path, { ...item, sourceSide: side })));
    });
    const chosen = [...dualAssignments].map(([sourcePath, targetPath]) => ({ ...(allSourceItems.get(sourcePath) || { path: sourcePath, isDirectory: false }), targetPath })).filter(item => item.path && item.targetPath);
    let success = 0;
    for (const item of chosen) {
      const result = item.isDirectory
        ? (action === 'move' ? await window.bridge?.localFiles?.moveFolderToFolder?.(item.path, item.targetPath, { conflict:'rename' }) : await window.bridge?.localFiles?.copyFolderToFolder?.(item.path, item.targetPath, { conflict:'rename' }))
        : (action === 'move' ? await window.bridge?.localFiles?.moveToFolder?.(item.path, item.targetPath, { conflict:'rename' }) : await window.bridge?.localFiles?.copyToFolder?.(item.path, item.targetPath, { conflict:'rename' }));
      if (result?.success) { success++; dualAssignments.delete(item.path); }
    }
    dualPaneOrder.slice(0, dualLayoutCount).forEach(side => activeDualTab(side)?.selected.clear());
    await Promise.all(dualPaneOrder.slice(0, dualLayoutCount).map(side => loadDualTab(side, activeDualTab(side), true)));
    if (typeof showToast === 'function') showToast(`${action === 'move' ? '移动' : '复制'}完成：${success} / ${chosen.length}`, success === chosen.length ? 'success' : 'info');
  }

  function toggleDualSidebar(visible) {
    if (typeof visible === 'boolean') {
      dualSidebarVisible = visible;
    } else {
      dualSidebarVisible = !dualSidebarVisible;
    }
    try { localStorage.setItem(DUAL_SIDEBAR_VISIBLE_KEY, String(dualSidebarVisible)); } catch (_) {}
    updateModeUI();
    if (dualSidebarVisible && (workMode === 'local-dual' || workMode === 'local-organize')) {
      renderLocalFolderList();
    }
  }

  function switchWorkMode(mode) {
    if (mode === workMode) return;
    workMode = mode;
    saveWorkMode();
    // Reset assign map when switching modes
    assignMap = {};
    localOrgDone = {};
    uploadedMap = {};
    selectedIds.clear();
    selectedFolderPaths.clear();
    updateModeUI();
    if (mode === 'local-dual') {
      loadDualPanes();
      // Entering dual mode always starts the left pane from the folder that was
      // being viewed in the normal local organizer, while keeping its other tabs.
      const currentSource = localFolderPath || localFolderPaths[0] || '';
      if (currentSource) {
        let sourceTab = dualPanes.left.tabs.find(tab => tab.path === currentSource);
        if (!sourceTab) { sourceTab = makeDualTab(currentSource); dualPanes.left.tabs.push(sourceTab); }
        dualPanes.left.activeId = sourceTab.id;
      }
      renderSymmetricDualWorkspace();
      if (dualSidebarVisible) {
        renderLocalFolderList();
      }
    }
    else { renderSlotList(); renderFileGrid(); }
    updateActionBar();
    renderRecentSlots();
  }

  function updateModeUI() {
    const panel = $('sort-upload-panel');
    if (!panel) return;
    const isLocalMode = workMode === 'local-organize' || workMode === 'local-dual';
    panel.classList.toggle('su-mode-local', isLocalMode);
    panel.classList.toggle('su-mode-upload', !isLocalMode);
    panel.classList.toggle('su-mode-dual', workMode === 'local-dual');
    panel.classList.toggle('su-dual-sidebar-show', workMode === 'local-dual' && dualSidebarVisible);
    const dualWorkspace = $('su-dual-workspace');
    const dualTransferBar = $('su-dual-transfer-bar');
    const dualTransferBarTop = $('su-dual-transfer-bar-top');
    const multiLayoutBar = $('su-multi-layout-bar');
    if (dualWorkspace) dualWorkspace.hidden = workMode !== 'local-dual';
    if (dualTransferBar) dualTransferBar.hidden = workMode !== 'local-dual';
    if (dualTransferBarTop) dualTransferBarTop.hidden = workMode !== 'local-dual';
    if (multiLayoutBar) multiLayoutBar.hidden = workMode !== 'local-dual';
    // Mode switch buttons
    panel.querySelectorAll('.su-mode-switch-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === workMode);
    });

    // Dual sidebar toggle button & close button
    const dualSidebarToggleBtn = $('su-dual-sidebar-toggle-btn');
    if (dualSidebarToggleBtn) {
      dualSidebarToggleBtn.classList.toggle('active', dualSidebarVisible);
      dualSidebarToggleBtn.textContent = dualSidebarVisible ? '📁 目标侧边栏 (已开启)' : '📁 目标侧边栏';
      dualSidebarToggleBtn.title = dualSidebarVisible ? '隐藏本地目标文件夹侧边栏' : '在多窗口右侧显示本地目标文件夹侧边栏（可将多窗口文件直接分配到侧边栏目标）';
    }
    const dualSidebarCloseBtn = $('su-dual-sidebar-close-btn');
    if (dualSidebarCloseBtn) {
      dualSidebarCloseBtn.style.display = (workMode === 'local-dual' && dualSidebarVisible) ? '' : 'none';
    }

    // Sidebar header
    const headerLabel = panel.querySelector('.su-slot-header > span');
    if (headerLabel) headerLabel.textContent = isLocalMode ? '📁 目标文件夹' : '📤 上传卡片';
    // Show/hide upload-specific buttons
    const batchBtn = $('su-batch-edit-btn');
    const sheetsBtn = $('su-import-sheets-btn');
    if (batchBtn) {
      batchBtn.style.display = '';
      batchBtn.title = isLocalMode ? '批量管理本地目标文件夹' : '批量编辑上传卡片';
    }
    if (sheetsBtn) sheetsBtn.style.display = isLocalMode ? 'none' : '';
    // Show/hide local organize action dropdown
    const localDropdown = $('su-local-action-dropdown');
    if (localDropdown) localDropdown.style.display = isLocalMode ? 'inline-block' : 'none';
    const archivedLocalFoldersBtn = $('su-show-archived-local-folders');
    if (archivedLocalFoldersBtn) {
      archivedLocalFoldersBtn.style.display = isLocalMode ? '' : 'none';
      const archivedCount = localTargetFolders.filter(folder => folder.archived).length;
      archivedLocalFoldersBtn.textContent = showArchivedLocalFolders
        ? '← 返回目标文件夹'
        : `🗃️ 已归档${archivedCount ? ` (${archivedCount})` : ''}`;
    }
    const localViewToggle = $('su-local-folder-view-toggle');
    if (localViewToggle) {
      localViewToggle.style.display = isLocalMode ? '' : 'none';
      localViewToggle.textContent = localFolderViewMode === 'grid' ? '☷ 列表' : '▦ 网格';
      localViewToggle.title = localFolderViewMode === 'grid' ? '切换为列表显示' : '切换为网格平铺';
    }
    const localFolderSort = $('su-local-folder-sort');
    if (localFolderSort) {
      localFolderSort.style.display = isLocalMode ? '' : 'none';
      localFolderSort.value = localFolderSortMode;
    }
    const refreshTargetsBtn = $('su-refresh-target-folders');
    if (refreshTargetsBtn) refreshTargetsBtn.style.display = isLocalMode ? '' : 'none';
    const uploadDropdown = $('su-upload-action-dropdown');
    if (uploadDropdown) uploadDropdown.style.display = isLocalMode ? 'none' : 'inline-block';


    // Keep individual buttons hidden to save space
    const addFolderBtn = $('su-add-local-folder');
    if (addFolderBtn) addFolderBtn.style.display = 'none';
    const addSubfoldersBtn = $('su-add-local-subfolders');
    if (addSubfoldersBtn) addSubfoldersBtn.style.display = 'none';
    const exportBtn = $('su-export-preset');
    const importBtn = $('su-import-preset');
    const mergeBtn = $('su-merge-preset');
    if (exportBtn) exportBtn.style.display = 'none';
    if (importBtn) importBtn.style.display = 'none';
    if (mergeBtn) mergeBtn.style.display = 'none';

    const dedupBtn = $('su-dedup-btn');
    if (dedupBtn) dedupBtn.style.display = workMode === 'local-organize' ? '' : 'none';
    // Org bar
    const orgBar = panel.querySelector('.su-org-bar');
    if (orgBar) orgBar.style.display = workMode === 'local-organize' ? 'none' : '';
    // Local org bar
    const localOrgBar = $('su-local-org-bar');
    if (localOrgBar) localOrgBar.style.display = isLocalMode ? '' : 'none';
  }

  async function addLocalFolder(group) {
    const dirs = await window.bridge?.localFiles?.pickFolder?.({ multi: true, title: '选择目标文件夹（可多选）' });
    if (!dirs) return;
    const dirList = Array.isArray(dirs) ? dirs : [dirs];
    let added = 0;
    for (const dir of dirList) {
      const name = dir.split('/').pop() || dir.split('\\').pop() || dir;
      if (localTargetFolders.some(f => f.path === dir)) continue;
      localTargetFolders.push({ id: 'lf-' + (++localTargetCounter) + '-' + Date.now(), name, path: dir, group: group || '' });
      added++;
    }
    if (added) {
      saveLocalTargetFolders();
      renderSlotList();
    }
  }

  async function addLocalSubfolders() {
    const parentDir = await window.bridge?.localFiles?.pickFolder?.({ title: '选择包含子文件夹的父目录' });
    if (!parentDir) return;
    const subfolders = await window.bridge?.localFiles?.getSubfolders?.(parentDir);
    if (!subfolders || !subfolders.length) {
      alert('所选文件夹下没有找到子文件夹');
      return;
    }
    const parentName = parentDir.split('/').pop() || parentDir.split('\\').pop() || parentDir;
    const groupName = parentName;
    groupParents[groupName] = parentDir;
    saveGroupParents();
    let added = 0;
    for (const sub of subfolders) {
      if (localTargetFolders.some(f => f.path === sub.path)) continue;
      localTargetFolders.push({
        id: 'lf-' + (++localTargetCounter) + '-' + Date.now(),
        name: sub.name,
        path: sub.path,
        group: groupName
      });
      added++;
    }
    if (added) {
      saveLocalTargetFolders();
      renderSlotList();
      alert(`成功导入 ${added} 个子文件夹作为目标文件夹，已归类 to 分组「${groupName}」`);
    } else {
      alert('所有子文件夹已存在，未导入新目标文件夹');
    }
  }

  async function syncLocalSubfolders(groupName) {
    const parentDir = groupParents[groupName];
    if (!parentDir) {
      alert(`无法找到该分组「${groupName}」对应的父目录物理路径，请使用「获取子文件夹」重新导入。`);
      return;
    }
    try {
      const subfolders = await window.bridge?.localFiles?.getSubfolders?.(parentDir);
      if (!subfolders || !subfolders.length) {
        alert(`所选物理父目录下没有找到任何子文件夹`);
        return;
      }
      let added = 0;
      for (const sub of subfolders) {
        if (localTargetFolders.some(f => f.path === sub.path)) continue;
        localTargetFolders.push({
          id: 'lf-' + (++localTargetCounter) + '-' + Date.now(),
          name: sub.name,
          path: sub.path,
          group: groupName
        });
        added++;
      }
      if (added) {
        saveLocalTargetFolders();
        renderSlotList();
        alert(`同步完成：在分组「${groupName}」下新增导入了 ${added} 个子分类文件夹！`);
      } else {
        alert(`已是最新状态：未发现新增的子分类。`);
      }
    } catch (e) {
      console.error('Failed to sync subfolders for group ' + groupName, e);
      alert('同步失败: ' + e.message);
    }
  }

  function removeLocalFolder(folderId) {
    localTargetFolders = localTargetFolders.filter(f => f.id !== folderId);
    Object.keys(assignMap).forEach(k => { if (assignMap[k] === folderId) delete assignMap[k]; });
    saveLocalTargetFolders();
    renderSlotList();
    renderFileGrid();
    updateActionBar();
  }

  function setLocalFolderGroup(folderId, newGroup) {
    const folder = localTargetFolders.find(f => f.id === folderId);
    if (folder) { folder.group = newGroup || ''; saveLocalTargetFolders(); renderSlotList(); }
  }

  function updateLocalPathsAfterRename(oldPath, newPath, folderRelPath, newFolderName) {
    const oldPathNorm = oldPath.replace(/\\/g, '/');
    const newPathNorm = newPath.replace(/\\/g, '/');

    const isSubOrEqual = (p) => {
      if (!p) return false;
      const pNorm = p.replace(/\\/g, '/');
      return pNorm === oldPathNorm || pNorm.startsWith(oldPathNorm + '/');
    };

    const replacePrefix = (p) => {
      const pNorm = p.replace(/\\/g, '/');
      if (pNorm === oldPathNorm) return newPath;
      if (pNorm.startsWith(oldPathNorm + '/')) {
        const relative = p.slice(oldPath.length);
        return newPath + relative;
      }
      return p;
    };

    // Update localTargetFolders
    localTargetFolders.forEach(f => {
      if (f.path && isSubOrEqual(f.path)) {
        const prevPath = f.path;
        f.path = replacePrefix(f.path);
        delete autoAvatarCache[f.id]; // Clear auto-avatar cache since path changed
        delete autoAvatarThumbnailCache[f.id];
        if (prevPath === oldPath) {
          f.name = newFolderName || newPath.split(/[/\\]/).pop();
        }
      }
    });
    saveLocalTargetFolders();

    // Update active tab and all tabs
    tabs.forEach(tab => {
      // 1. Update root folderPath & folderPaths
      if (tab.folderPath && isSubOrEqual(tab.folderPath)) {
        tab.folderPath = replacePrefix(tab.folderPath);
      }
      if (Array.isArray(tab.folderPaths)) {
        tab.folderPaths = tab.folderPaths.map(p => isSubOrEqual(p) ? replacePrefix(p) : p);
      }
      
      // Update tab.folderName if it matched old folder name
      const oldFolderNameFromPath = oldPath.split(/[/\\]/).pop();
      const newFolderNameFromPath = newPath.split(/[/\\]/).pop();
      if (tab.folderName === oldFolderNameFromPath) {
        tab.folderName = newFolderName || newFolderNameFromPath;
      }
      if (tab.name === oldFolderNameFromPath) {
        tab.name = newFolderName || newFolderNameFromPath;
      }

      // 2. Update localFiles in tab
      if (Array.isArray(tab.localFiles)) {
        tab.localFiles.forEach(f => {
          if (f.path && isSubOrEqual(f.path)) {
            f.path = replacePrefix(f.path);
            f.id = f.path; // update ID as it is based on path
          }
        });
      }

      // 3. Update selectedIds in tab
      if (tab.selectedIds instanceof Set) {
        const updatedSel = new Set();
        tab.selectedIds.forEach(id => {
          if (isSubOrEqual(id)) {
            updatedSel.add(replacePrefix(id));
          } else {
            updatedSel.add(id);
          }
        });
        tab.selectedIds = updatedSel;
      }

      // 4. Update assignMap in tab
      if (tab.assignMap && typeof tab.assignMap === 'object') {
        const newAssignMap = {};
        Object.entries(tab.assignMap).forEach(([k, v]) => {
          let newKey = k;
          if (k.startsWith('folder:')) {
            const rel = k.slice(7);
            if (folderRelPath && (rel === folderRelPath || rel.startsWith(folderRelPath + '/'))) {
              const parentRel = folderRelPath.includes('/') ? folderRelPath.slice(0, folderRelPath.lastIndexOf('/')) : '';
              const actualNewName = newFolderName || newFolderNameFromPath;
              const newRelPath = parentRel ? parentRel + '/' + actualNewName : actualNewName;
              if (rel === folderRelPath) {
                newKey = 'folder:' + newRelPath;
              } else {
                newKey = 'folder:' + newRelPath + rel.slice(folderRelPath.length);
              }
            }
          } else if (isSubOrEqual(k)) {
            newKey = replacePrefix(k);
          }
          newAssignMap[newKey] = v;
        });
        tab.assignMap = newAssignMap;
      }

      // 5. Update uploadedMap in tab
      if (tab.uploadedMap && typeof tab.uploadedMap === 'object') {
        const newUploadedMap = {};
        Object.entries(tab.uploadedMap).forEach(([k, v]) => {
          const newKey = isSubOrEqual(k) ? replacePrefix(k) : k;
          newUploadedMap[newKey] = v;
        });
        tab.uploadedMap = newUploadedMap;
      }
    });

    // Update active memory states
    localFolderPaths = localFolderPaths.map(p => isSubOrEqual(p) ? replacePrefix(p) : p);
    if (localFolderPath && isSubOrEqual(localFolderPath)) {
      localFolderPath = replacePrefix(localFolderPath);
    }

    localFiles.forEach(f => {
      if (f.path && isSubOrEqual(f.path)) {
        f.path = replacePrefix(f.path);
        f.id = f.path;
      }
    });

    const updatedSelectedIds = new Set();
    selectedIds.forEach(id => {
      if (isSubOrEqual(id)) {
        updatedSelectedIds.add(replacePrefix(id));
      } else {
        updatedSelectedIds.add(id);
      }
    });
    selectedIds = updatedSelectedIds;

    const newAssignMap = {};
    Object.entries(assignMap).forEach(([k, v]) => {
      let newKey = k;
      if (k.startsWith('folder:')) {
        const rel = k.slice(7);
        if (folderRelPath && (rel === folderRelPath || rel.startsWith(folderRelPath + '/'))) {
          const parentRel = folderRelPath.includes('/') ? folderRelPath.slice(0, folderRelPath.lastIndexOf('/')) : '';
          const actualNewName = newFolderName || newFolderNameFromPath;
          const newRelPath = parentRel ? parentRel + '/' + actualNewName : actualNewName;
          if (rel === folderRelPath) {
            newKey = 'folder:' + newRelPath;
          } else {
            newKey = 'folder:' + newRelPath + rel.slice(folderRelPath.length);
          }
        }
      } else if (isSubOrEqual(k)) {
        newKey = replacePrefix(k);
      }
      newAssignMap[newKey] = v;
    });
    assignMap = newAssignMap;

    const newUploadedMap = {};
    Object.entries(uploadedMap).forEach(([k, v]) => {
      const newKey = isSubOrEqual(k) ? replacePrefix(k) : k;
      newUploadedMap[newKey] = v;
    });
    uploadedMap = newUploadedMap;

    const newLocalOrgDone = {};
    Object.entries(localOrgDone).forEach(([k, v]) => {
      const newKey = isSubOrEqual(k) ? replacePrefix(k) : k;
      newLocalOrgDone[newKey] = v;
    });
    localOrgDone = newLocalOrgDone;

    saveTabs();
  }

  async function editLocalFolderName(folderId) {
    const folder = localTargetFolders.find(f => f.id === folderId);
    if (!folder) return;
    if (!folder.path) {
      if (typeof showToast === 'function') showToast('❌ 此目标没有关联本地文件夹，无法重命名', 'error');
      return;
    }
    const newName = await showPrompt('重命名本地文件夹（会实际修改磁盘名称）：', folder.name);
    const desiredName = newName?.trim();
    if (!desiredName || desiredName === folder.name) return;

    const result = await window.bridge?.renameLocalFiles?.([{
      source: folder.path,
      newName: desiredName,
      conflictStyle: 'number'
    }]);
    const renamed = result?.renamed?.[0];
    if (!renamed) {
      const error = result?.errors?.[0]?.message || '重命名失败';
      if (typeof showToast === 'function') showToast(`❌ 本地文件夹未改名：${error}`, 'error');
      return;
    }

    // 同步所有引用该目录的标签页、文件路径、目标文件夹和选择状态。
    updateLocalPathsAfterRename(folder.path, renamed.path, '', renamed.name);
    renderSlotList();
    renderTabBar();
    renderFileGrid();
    if (typeof showToast === 'function') {
      const suffix = renamed.name === desiredName ? '' : `（因同名已改为「${renamed.name}」）`;
      showToast(`✅ 本地文件夹已重命名${suffix}`, 'success');
    }
  }

  function isPathVideo(src) {
    if (!src) return false;
    const pathPart = src.split('?')[0];
    const ext = pathPart.slice(pathPart.lastIndexOf('.')).toLowerCase();
    return ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.ogg'].includes(ext);
  }

  function localFileUrl(filePath) {
    return toSafeFileUrl(filePath);
  }

  function updateAutoAvatarThumbnailInDom(folderId, thumbnailPathOrUrl) {
    const thumbnailUrl = (thumbnailPathOrUrl && thumbnailPathOrUrl.startsWith('data:'))
      ? thumbnailPathOrUrl
      : localFileUrl(thumbnailPathOrUrl);
    document.querySelectorAll('.su-local-folder-card').forEach(card => {
      if (card.dataset.slotId !== folderId) return;
      const image = card.querySelector('.su-local-folder-video-thumb');
      const placeholder = card.querySelector('.su-local-folder-video-placeholder');
      if (!image) return;
      image.src = thumbnailUrl;
      image.style.display = '';
      if (placeholder) placeholder.style.display = 'none';
    });
  }

  function pumpAutoAvatarThumbnails() {
    while (autoAvatarThumbnailActive < MAX_AUTO_AVATAR_THUMBNAILS && autoAvatarThumbnailQueue.length) {
      const task = autoAvatarThumbnailQueue.shift();
      autoAvatarThumbnailActive += 1;
      const getThumb = async () => {
        let result = '';
        try {
          const thumbnailPath = await window.bridge?.localFiles?.getVideoThumbnail?.(task.mediaPath, 240);
          if (thumbnailPath) result = thumbnailPath;
        } catch (_) {}
        if (!result) {
          try {
            result = await generateHtml5VideoThumbnail(localFileUrl(task.mediaPath));
          } catch (_) {}
        }
        return result;
      };

      getThumb()
        .then(thumbnailPathOrUrl => {
          if (!thumbnailPathOrUrl) return;
          const folder = localTargetFolders.find(item => item.id === task.folderId);
          const currentMedia = folder?.avatar || autoAvatarCache[task.folderId];
          if (!folder || (currentMedia && currentMedia !== task.mediaPath)) return;
          autoAvatarThumbnailCache[task.folderId] = thumbnailPathOrUrl;
          autoAvatarCacheDirty = true;
          updateAutoAvatarThumbnailInDom(task.folderId, thumbnailPathOrUrl);
        })
        .catch(error => {
          console.warn('Failed to generate video avatar thumbnail for ' + task.folderId, error);
        })
        .finally(() => {
          autoAvatarThumbnailActive -= 1;
          autoAvatarThumbnailQueued.delete(task.folderId);
          if (!autoAvatarThumbnailQueue.length && autoAvatarThumbnailActive === 0) {
            savePersistentAutoAvatarCache();
          }
          pumpAutoAvatarThumbnails();
        });
    }
  }

  function requestAutoAvatarThumbnail(folderId, mediaPath) {
    if (!folderId || !mediaPath || autoAvatarThumbnailCache[folderId] || autoAvatarThumbnailQueued.has(folderId)) return;
    if (/^https?:/i.test(mediaPath)) return;
    autoAvatarThumbnailQueued.add(folderId);
    autoAvatarThumbnailQueue.push({ folderId, mediaPath });
    pumpAutoAvatarThumbnails();
  }

  function pumpAutoAvatarScans() {
    while (autoAvatarScanActive < MAX_AUTO_AVATAR_SCANS && autoAvatarScanQueue.length) {
      const task = autoAvatarScanQueue.shift();
      const folder = localTargetFolders.find(item => item.id === task.folderId);
      if (!folder || folder.path !== task.folderPath) continue;
      autoAvatarScanActive += 1;
      Promise.resolve(window.bridge?.localFiles?.getFolderAvatarMedia?.(task.folderPath))
        .then(latestMedia => {
          autoAvatarCache[task.folderId] = latestMedia || null;
          delete autoAvatarThumbnailCache[task.folderId];
          autoAvatarCacheMeta[task.folderId] = Date.now();
          autoAvatarCacheDirty = true;
        })
        .catch(error => {
          console.error('Failed to load auto avatar for ' + task.folderId, error);
          autoAvatarCache[task.folderId] = null;
          autoAvatarCacheMeta[task.folderId] = Date.now();
          autoAvatarCacheDirty = true;
        })
        .finally(() => {
          autoAvatarScanActive -= 1;
          if (!autoAvatarScanQueue.length && autoAvatarScanActive === 0) {
            savePersistentAutoAvatarCache();
            if (workMode === 'local-organize') renderSlotList();
          }
          pumpAutoAvatarScans();
        });
    }
  }

  function loadAutoAvatar(folderId, folderPath) {
    if (!folderPath) {
      autoAvatarCache[folderId] = null;
      autoAvatarCacheMeta[folderId] = Date.now();
      autoAvatarCacheDirty = true;
      return;
    }
    if (autoAvatarScanQueue.some(task => task.folderId === folderId)) return;
    autoAvatarScanQueue.push({ folderId, folderPath });
    pumpAutoAvatarScans();
  }

  async function loadCloudAutoAvatar(folderId) {
    if (!folderId) return;
    try {
      const token = await getCloudAccessToken();
      if (!token) {
        autoCloudAvatarCache[folderId] = null;
        return;
      }
      const q = encodeURIComponent(`'${folderId}' in parents and (mimeType starts with 'image/' or mimeType starts with 'video/') and trashed = false`);
      const fields = encodeURIComponent('files(thumbnailLink)');
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=createdTime%20desc&pageSize=1`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        autoCloudAvatarCache[folderId] = null;
        return;
      }
      const data = await res.json();
      const latestMedia = data.files?.[0]?.thumbnailLink || null;
      if (latestMedia) {
        autoCloudAvatarCache[folderId] = latestMedia;
        renderSlotList();
      } else {
        autoCloudAvatarCache[folderId] = null;
      }
    } catch (e) {
      console.error('Failed to load cloud auto avatar for ' + folderId, e);
      autoCloudAvatarCache[folderId] = null;
    }
  }

  function renderLocalFolderCard(f) {
    const idx = localTargetFolders.indexOf(f);
    const color = COLORS[idx % COLORS.length];
    const dualCount = workMode === 'local-dual' ? [...dualAssignments.values()].filter(tp => tp === f.path).length : 0;
    const count = workMode === 'local-dual' ? dualCount : Object.values(assignMap).filter(id => id === f.id).length;
    const subLabel = f.subfolderRule === 'date' ? '日期' : f.subfolderRule === 'date-cn' ? '中文' : f.subfolderRule === 'yearmonth' ? '年月' : f.subfolderRule === 'custom' ? (f.subfolderCustom || '自定义') : '';
    const subBadge = f.subfolderRule ? `<span style="font-size:9px;background:#e8f0fe;color:#1a73e8;padding:1px 4px;border-radius:3px;">${subLabel}</span>` : '';
    
    // Avatar calculation
    let avatarSrc = '';
    let avatarMediaPath = '';
    let isAuto = false;
    
    if (f.avatar) {
      avatarMediaPath = f.avatar;
      avatarSrc = toSafeFileUrl(f.avatar);
    } else {
      const cached = autoAvatarCache[f.id];
      if (typeof cached === 'string') {
        avatarMediaPath = cached;
        avatarSrc = toSafeFileUrl(cached);
        isAuto = true;
      } else {
        if (cached === undefined) {
          autoAvatarCache[f.id] = null;
          loadAutoAvatar(f.id, f.path);
        }
        // Fallback to in-memory assigned images & videos
        const assignedMedia = localFiles.filter(file => {
          const cat = fileCategory(file.mimeType);
          return assignMap[file.id] === f.id && (cat === 'image' || cat === 'video');
        });
        if (assignedMedia.length) {
          assignedMedia.sort((a, b) => {
            const timeA = a.updatedAt || (a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0);
            const timeB = b.updatedAt || (b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0);
            return timeB - timeA;
          });
          avatarMediaPath = assignedMedia[0].path;
          avatarSrc = toSafeFileUrl(assignedMedia[0].path);
          isAuto = true;
        }
      }
    }
    
    const avatarObjPos = f.avatarPos ? `object-position:${f.avatarPos.x}% ${f.avatarPos.y}%` : '';
    const isVideo = isPathVideo(avatarSrc);
    const videoThumbnailPath = isVideo ? autoAvatarThumbnailCache[f.id] : '';
    if (isVideo && !videoThumbnailPath) requestAutoAvatarThumbnail(f.id, avatarMediaPath);
    const avatarHtml = avatarSrc
      ? (isVideo
          ? `<img class="su-local-folder-avatar su-local-folder-video-thumb${isAuto ? ' auto-avatar' : ''}"${videoThumbnailPath ? ` src="${localFileUrl(videoThumbnailPath)}"` : ''} loading="lazy" decoding="async" style="${avatarObjPos};${videoThumbnailPath ? '' : 'display:none'}" onerror="this.style.display='none';this.nextElementSibling.style.display=''" data-folder-id="${f.id}" title="视频静态预览图（已缓存）" /><span class="su-local-folder-avatar-placeholder su-local-folder-video-placeholder" style="background:${color};${videoThumbnailPath ? 'display:none' : ''}" data-folder-id="${f.id}" title="正在后台生成视频预览图">🎬</span>`
          : `<img class="su-local-folder-avatar${isAuto ? ' auto-avatar' : ''}" src="${avatarSrc}" loading="lazy" decoding="async" style="${avatarObjPos}" onerror="this.style.display='none';this.nextElementSibling.style.display=''" data-folder-id="${f.id}" title="双击编辑头像" /><span class="su-local-folder-avatar-placeholder" style="background:${color};display:none" data-folder-id="${f.id}" title="双击设置头像">${(f.name || '?')[0]}</span>`
        )
      : `<span class="su-local-folder-avatar-placeholder" style="background:${color}" data-folder-id="${f.id}" title="双击设置头像">${(f.name || '?')[0]}</span>`;
    return `<div class="su-slot-card su-local-folder-card" data-slot-id="${f.id}" title="${f.path}">
      <div class="su-folder-row1">
        ${avatarHtml}
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;">
          <div style="display:flex;align-items:center;gap:4px;">
            <span class="su-folder-name" style="font-size:13px;font-weight:600;">${f.name}</span>${subBadge}
            ${count ? `<span class="su-slot-count-inline">${count}</span>` : ''}
            <span style="flex:1"></span>
            <button class="su-local-folder-archive-btn" data-folder-id="${f.id}" title="${f.archived ? '恢复归档' : '归档并隐藏此目标'}">${f.archived ? '↩️' : '🗃️'}</button>
            <button class="su-local-folder-menu-btn" data-folder-id="${f.id}" data-folder-path="${f.path}" title="更多操作">⋯</button>
          </div>
          <div class="su-folder-row2" style="margin-left:0;"><span class="su-folder-path-text" style="max-width:none;">${f.path}</span></div>
        </div>
      </div>
    </div>`;
  }

  function renderLocalFolderList() {
    const container = $('su-slot-list');
    if (!container) return;
    // Assigning files refreshes this list to update its counters. Keep the user's
    // current position instead of jumping back to the top after every assignment.
    const previousScrollTop = container.scrollTop;
    const previousScrollLeft = container.scrollLeft;
    const sidebar = container.closest('.su-slot-sidebar');
    container.classList.toggle('su-local-folder-grid', localFolderViewMode === 'grid');
    sidebar?.classList.toggle('su-local-folder-grid-sidebar', localFolderViewMode === 'grid');
    const q = slotSearchQuery.toLowerCase();
    const filtered = localTargetFolders.filter(f => {
      if (showArchivedLocalFolders ? !f.archived : f.archived) return false;
      if (!q) return true;
      return f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q) || (f.group || '').toLowerCase().includes(q);
    });

    if (!filtered.length) {
      container.innerHTML = `<div class="su-local-empty" style="text-align:center;padding:24px 12px;color:#94a3b8;font-size:13px;word-break:keep-all;">
        <div style="font-size:32px;margin-bottom:8px;opacity:0.5;">📁</div>
        <p style="margin:0 0 8px">${showArchivedLocalFolders ? '没有已归档的目标文件夹' : '还没有目标文件夹'}</p>
        <p style="margin:0;font-size:12px;opacity:0.7">点击上方「+ 添加文件夹」按钮<br/>选择本地文件夹作为分类目标</p>
      </div>`;
      return;
    }

    // Group folders
    const groups = {};
    filtered.forEach(f => {
      const g = f.group || '';
      (groups[g] = groups[g] || []).push(f);
    });
    const originalIndex = new Map(localTargetFolders.map((folder, index) => [folder.id, index]));
    const compareFolders = (a, b) => {
      const indexA = originalIndex.get(a.id) ?? 0;
      const indexB = originalIndex.get(b.id) ?? 0;
      if (localFolderSortMode === 'added-desc') return indexB - indexA;
      if (localFolderSortMode === 'name-asc' || localFolderSortMode === 'name-desc') {
        const direction = localFolderSortMode === 'name-desc' ? -1 : 1;
        const byName = String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN', {
          numeric: true,
          sensitivity: 'base'
        });
        return byName ? byName * direction : indexA - indexB;
      }
      return indexA - indexB;
    };
    const groupNames = Object.keys(groups).sort((a, b) => {
      if (a === '' && b !== '') return 1;
      if (b === '' && a !== '') return -1;
      return a.localeCompare(b, 'zh-CN');
    });

    let html = '';
    for (const gName of groupNames) {
      const items = [...groups[gName]].sort(compareFolders);
      const isCollapsed = collapsedLocalGroups.has(gName);
      if (gName) {
        const groupCount = items.reduce((sum, f) => sum + Object.values(assignMap).filter(id => id === f.id).length, 0);
        const hasParent = groupParents[gName] ? true : false;
        const archiveGroupBtn = `<button class="su-group-archive-btn" data-group="${gName}" title="${showArchivedLocalFolders ? '恢复本组所有目标文件夹' : '归档并隐藏本组所有目标文件夹'}">${showArchivedLocalFolders ? '恢复' : '归档'}</button>`;
        const syncBtn = hasParent 
          ? `<button class="su-group-sync-btn" data-group="${gName}" title="同步/刷新物理子文件夹" style="background:transparent; border:none; color:#2e7d32; cursor:pointer; font-size:11px; padding:0; margin-left:8px; display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:4px; transition:all 0.15s; outline:none;">🔄</button>` 
          : '';
        html += `<div class="su-slot-group-label${isCollapsed ? ' collapsed' : ''}" data-group="${gName}" style="display:flex; align-items:center; width:100%; box-sizing:border-box;">
          <span class="su-group-arrow">▼</span>
          <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${gName}</span>
          <span style="color:#999; font-weight:400; font-size:10px; margin-left:4px; flex-shrink:0;">(${items.length}个${groupCount ? ' · 已分配' + groupCount : ''})</span>
          ${archiveGroupBtn}
          ${syncBtn}
        </div>`;
      }
      html += `<div class="su-slot-group-items${isCollapsed ? ' collapsed' : ''}" data-group-items="${gName}">`;
      items.forEach(f => { html += renderLocalFolderCard(f); });
      html += '</div>';
    }
    container.innerHTML = html;
    container.scrollTop = previousScrollTop;
    container.scrollLeft = previousScrollLeft;

    // Group toggle
    container.querySelectorAll('.su-slot-group-label').forEach(label => {
      label.addEventListener('click', (e) => {
        if (e.target.closest('.su-group-sync-btn, .su-group-archive-btn')) return; // Ignore action buttons
        const g = label.dataset.group;
        if (collapsedLocalGroups.has(g)) collapsedLocalGroups.delete(g); else collapsedLocalGroups.add(g);
        label.classList.toggle('collapsed');
        const items = container.querySelector(`[data-group-items="${g}"]`);
        if (items) items.classList.toggle('collapsed');
      });
    });

    // Group sync click listener
    container.querySelectorAll('.su-group-sync-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent toggling collapse
        const g = btn.dataset.group;
        btn.style.transform = 'rotate(360deg)';
        btn.style.transition = 'transform 0.5s ease';
        setTimeout(() => {
          btn.style.transform = '';
          btn.style.transition = '';
        }, 500);
        syncLocalSubfolders(g);
      });
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'rgba(0,0,0,0.06)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'transparent';
      });
    });
    // Archive or restore every target folder in this group at once.
    container.querySelectorAll('.su-group-archive-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const groupName = btn.dataset.group;
        const groupFolders = localTargetFolders.filter(folder => (folder.group || '') === groupName);
        if (!groupFolders.length) return;
        const shouldArchive = !showArchivedLocalFolders;
        groupFolders.forEach(folder => { folder.archived = shouldArchive; });
        saveLocalTargetFolders();
        renderSlotList();
        if (typeof showToast === 'function') {
          showToast(shouldArchive ? `🗃️ 已归档分组「${groupName}」的 ${groupFolders.length} 个目标` : `✅ 已恢复分组「${groupName}」的 ${groupFolders.length} 个目标`, 'success');
        }
      });
    });
    // Click → assign & Right-click → context menu
    container.querySelectorAll('.su-local-folder-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.su-local-folder-menu-btn') || e.target.closest('.su-local-folder-archive-btn') || e.target.closest('.su-local-folder-avatar') || e.target.closest('.su-local-folder-avatar-placeholder') || e.target.closest('.su-local-folder-avatar-btn')) return;
        assignSelectedToSlot(card.dataset.slotId);
      });
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menuBtn = card.querySelector('.su-local-folder-menu-btn');
        if (menuBtn) {
          // Temporarily move the button to mouse coordinates or just click it
          // Actually, just dispatch a click event to the menu button
          // But the menu positions itself based on the button. Let's modify the menu code to use mouse coords if available.
          menuBtn.dispatchEvent(new MouseEvent('click', { clientX: e.clientX, clientY: e.clientY }));
        }
      });
    });

    // ⋯ Menu button → show dropdown with all actions
    container.querySelectorAll('.su-local-folder-archive-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const folder = localTargetFolders.find(item => item.id === btn.dataset.folderId);
        if (!folder) return;
        folder.archived = !folder.archived;
        saveLocalTargetFolders();
        renderSlotList();
        if (typeof showToast === 'function') showToast(folder.archived ? `🗃️ 已归档「${folder.name}」` : `✅ 已恢复「${folder.name}」`, 'success');
      });
    });
    container.querySelectorAll('.su-local-folder-menu-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close any existing menu
        document.querySelector('.su-folder-ctx-menu')?.remove();

        const fid = btn.dataset.folderId;
        const fpath = btn.dataset.folderPath;
        const folder = localTargetFolders.find(f => f.id === fid);

        const menu = document.createElement('div');
        menu.className = 'su-folder-ctx-menu';
        menu.innerHTML = `
          <div class="su-ctx-item" data-action="open">📂 在 Finder 中打开</div>
          <div class="su-ctx-item" data-action="new-tab">📑 在新标签页打开</div>
          <div class="su-ctx-item" data-action="new-sub">📁+ 新建子文件夹</div>
          <div class="su-ctx-sep"></div>
          <div class="su-ctx-item" data-action="edit">✏️ 重命名本地文件夹</div>
          <div class="su-ctx-item" data-action="rename-disk">✏️ 重命名物理文件夹</div>
          <div class="su-ctx-item" data-action="subfolder">📋 子文件夹规则</div>
          <div class="su-ctx-item" data-action="group">🏷️ 设置分组</div>
          <div class="su-ctx-item" data-action="avatar">🖼️ 设置头像</div>
          <div class="su-ctx-item" data-action="archive">${folder?.archived ? '↩️ 恢复归档' : '🗃️ 归档并隐藏'}</div>
          <div class="su-ctx-sep"></div>
          <div class="su-ctx-item su-ctx-danger" data-action="remove">✕ 移除此目标</div>
        `;

        // Append first to measure height
        menu.style.position = 'fixed';
        menu.style.left = '-9999px';
        menu.style.top = '0px';
        menu.style.zIndex = '99999';
        document.body.appendChild(menu);

        // Position menu below button, or above if not enough space
        const rect = btn.getBoundingClientRect();
        const menuHeight = menu.offsetHeight;
        let topPos = rect.bottom + 4;
        if (topPos + menuHeight > window.innerHeight) {
          topPos = rect.top - menuHeight - 4;
        }

        menu.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
        menu.style.top = topPos + 'px';

        // Handle menu item clicks
        menu.addEventListener('click', async (ev) => {
          const item = ev.target.closest('.su-ctx-item');
          if (!item) return;
          const action = item.dataset.action;
          menu.remove();

          switch (action) {
            case 'open':
              if (fpath && window.bridge?.openPath) window.bridge.openPath(fpath);
              break;
            case 'new-tab':
              if (fpath) {
                if (workMode === 'local-dual') {
                  const targetPane = activeDualTarget || dualPaneOrder.slice(0, dualLayoutCount).find(id => dualPanes[id]?.role === 'target') || dualPaneOrder[0];
                  const pane = dualPanes[targetPane];
                  if (pane) {
                    const tab = makeDualTab(fpath, folder?.name || fpath.split('/').pop());
                    pane.tabs.push(tab);
                    pane.activeId = tab.id;
                    saveDualPanes();
                    renderSymmetricDualWorkspace();
                    loadDualTab(targetPane, tab, true);
                    if (typeof showToast === 'function') showToast(`已在窗口 ${dualPaneOrder.indexOf(targetPane) + 1} 打开「${folder?.name || fpath.split('/').pop()}」`, 'success');
                  }
                } else {
                  const newTab = createTab(fpath, folder?.name || fpath.split('/').pop());
                  saveTabs();
                  switchTab(newTab.id);
                  scanFolder(fpath);
                }
              }
              break;
            case 'new-sub': {
              const folderName = await showPrompt('在目标文件夹内新建子文件夹：', '');
              if (!folderName || !folderName.trim()) break;
              const result = await window.bridge?.localFiles?.createFolder?.(fpath, folderName.trim());
              if (result?.success) {
                const newPath = result.path;
                if (!localTargetFolders.some(f => f.path === newPath)) {
                  localTargetFolders.push({ id: 'lf-' + (++localTargetCounter) + '-' + Date.now(), name: result.name, path: newPath, group: folder?.group || '' });
                  saveLocalTargetFolders();
                  renderSlotList();
                }
              } else {
                alert('新建子文件夹失败: ' + (result?.error || '未知错误'));
              }
              break;
            }
            case 'edit':
              editLocalFolderName(fid);
              break;
            case 'rename-disk': {
              const oldName = fpath.split(/[/\\]/).pop() || '';
              const newName = await showPrompt('重命名磁盘文件夹（此操作会修改物理目录名）：', oldName);
              if (!newName || !newName.trim() || newName.trim() === oldName) break;
              
              const result = await window.bridge?.renameLocalFiles?.([{ source: fpath, newName: newName.trim() }]);
              if (result?.renamed?.length) {
                const oldPath = fpath;
                const parentDir = oldPath.replace(/[/\\][^/\\]+$/, '');
                const separator = oldPath.includes('\\') ? '\\' : '/';
                const newPath = parentDir + separator + newName.trim();
                
                // Update paths
                updateLocalPathsAfterRename(oldPath, newPath, null, newName.trim());
                
                await refreshAllFolders();
                renderSlotList();
              } else if (result?.errors?.length) {
                alert('重命名失败: ' + result.errors[0].message);
              }
              break;
            }
            case 'subfolder':
              // Trigger the subfolder popup on the menu button
              showSubfolderPopup(btn, fid);
              break;
            case 'group': {
              const existing = [...new Set(localTargetFolders.map(f => f.group).filter(Boolean))];
              const hint = existing.length ? `\u73b0\u6709\u5206\u7ec4\uff1a${existing.join(', ')}\n\u8f93\u5165\u5206\u7ec4\u540d\uff08\u7559\u7a7a\u53d6\u6d88\u5206\u7ec4\uff09\uff1a` : '\u8f93\u5165\u5206\u7ec4\u540d\uff08\u7559\u7a7a\u53d6\u6d88\u5206\u7ec4\uff09\uff1a';
              const g = await showPrompt(hint, folder?.group || '');
              if (g !== null) setLocalFolderGroup(fid, g.trim());
              break;
            }
            case 'avatar':
              pickAvatarForFolder(fid);
              break;
            case 'archive':
              if (!folder) break;
              folder.archived = !folder.archived;
              saveLocalTargetFolders();
              renderSlotList();
              if (typeof showToast === 'function') showToast(folder.archived ? `🗃️ 已归档「${folder.name}」` : `✅ 已恢复「${folder.name}」`, 'success');
              break;
            case 'remove':
              removeLocalFolder(fid);
              break;
          }
        });

        // Close menu on outside click
        const closeMenu = (ev2) => {
          if (!menu.contains(ev2.target)) { menu.remove(); document.removeEventListener('click', closeMenu, true); }
        };
        setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
      });
    });
    // Set avatar (double-click only, so a normal click never changes it by mistake)
    async function pickAvatarForFolder(fid) {
      const imgPath = await window.bridge?.localFiles?.pickImage?.();
      if (!imgPath) return;
      const folder = localTargetFolders.find(f => f.id === fid);
      if (!folder) return;
      // Open crop/position modal
      showAvatarCropModal(folder, imgPath);
    }
    container.querySelectorAll('.su-local-folder-avatar-btn, .su-local-folder-avatar, .su-local-folder-avatar-placeholder').forEach(el => {
      el.style.cursor = 'default';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const fid = el.dataset.folderId;
        if (fid) pickAvatarForFolder(fid);
      });
    });
    // Hover preview for avatar images/videos
    container.querySelectorAll('.su-local-folder-avatar').forEach(avatar => {
      let popup = null;
      avatar.addEventListener('mouseenter', (e) => {
        popup = document.createElement('div');
        popup.className = 'su-avatar-preview-popup';
        
        let previewEl;
        if (avatar.tagName === 'VIDEO') {
          previewEl = document.createElement('video');
          previewEl.src = avatar.src;
          previewEl.autoplay = true;
          previewEl.loop = true;
          previewEl.muted = true;
          previewEl.style.width = '100%';
          previewEl.style.height = '100%';
          previewEl.style.objectFit = 'cover';
        } else {
          previewEl = document.createElement('img');
          previewEl.src = avatar.src;
          previewEl.style.width = '100%';
          previewEl.style.height = '100%';
          previewEl.style.objectFit = 'cover';
        }
        
        if (avatar.style.objectPosition) previewEl.style.objectPosition = avatar.style.objectPosition;
        popup.appendChild(previewEl);
        popup.style.left = (e.clientX + 15) + 'px';
        popup.style.top = Math.max(10, e.clientY - 100) + 'px';
        document.body.appendChild(popup);
      });
      avatar.addEventListener('mousemove', (e) => {
        if (popup) {
          popup.style.left = (e.clientX + 15) + 'px';
          popup.style.top = Math.max(10, e.clientY - 100) + 'px';
        }
      });
      avatar.addEventListener('mouseleave', () => {
        if (popup) { popup.remove(); popup = null; }
      });
    });
    // Set subfolder rule per folder
    container.querySelectorAll('.su-local-folder-subfolder').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const folder = localTargetFolders.find(f => f.id === btn.dataset.folderId);
        if (!folder) return;
        // Create inline dropdown
        const existing = document.querySelector('.su-subfolder-popup');
        if (existing) existing.remove();
        const popup = document.createElement('div');
        popup.className = 'su-subfolder-popup';
        popup.style.cssText = 'position:absolute;z-index:9999;background:#fff;border:1px solid #e0e0e0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);padding:6px 0;min-width:180px;font-size:12px;';
        const options = [
          { value: '', label: '❌ 不建子文件夹' },
          { value: 'date', label: '📅 按日期 (2026-04-26)' },
          { value: 'date-cn', label: '📅 中文日期 (4月26日)' },
          { value: 'yearmonth', label: '📅 按年月 (2026-04)' },
          { value: 'custom', label: '✏️ 自定义名称...' },
        ];
        options.forEach(opt => {
          const item = document.createElement('div');
          item.style.cssText = `padding:6px 14px;cursor:pointer;${folder.subfolderRule === opt.value ? 'background:#e8f0fe;color:#1a73e8;font-weight:600;' : ''}`;
          item.textContent = opt.label;
          item.addEventListener('mouseenter', () => { item.style.background = '#f0f4f9'; });
          item.addEventListener('mouseleave', () => { item.style.background = folder.subfolderRule === opt.value ? '#e8f0fe' : ''; });
          item.addEventListener('click', async () => {
            popup.remove();
            if (opt.value === 'custom') {
              const name = await showPrompt('子文件夹名称：', folder.subfolderCustom || '');
              if (name !== null) {
                folder.subfolderRule = 'custom';
                folder.subfolderCustom = name.trim() || '未命名';
              }
            } else {
              folder.subfolderRule = opt.value;
              folder.subfolderCustom = '';
            }
            saveLocalTargetFolders();
            renderSlotList();
          });
          popup.append(item);
        });
        const rect = btn.getBoundingClientRect();
        popup.style.left = rect.left + 'px';
        popup.style.top = rect.bottom + 4 + 'px';
        popup.style.position = 'fixed';
        document.body.append(popup);
        const dismiss = (ev) => { if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('click', dismiss); } };
        setTimeout(() => document.addEventListener('click', dismiss), 10);
      });
    });
  }

  // Resolve a tree folder relPath to an absolute disk path
  function resolveRelPathToDisk(relPath) {
    if (!relPath) return '';
    if (localFolderPaths.length === 1) {
      return localFolderPaths[0] + '/' + relPath;
    }
    // In multi-folder mode, the first part of relPath is the source folder name
    const topFolder = relPath.split('/')[0];
    const matched = localFolderPaths.find(p => {
      const name = p.split('/').pop() || p.split('\\').pop() || p;
      return name === topFolder;
    });
    if (matched) {
      const rest = relPath.split('/').slice(1).join('/');
      return rest ? matched + '/' + rest : matched;
    }

    // Older/mixed multi-source scans keep relPath relative to each source root
    // instead of prefixing it with the source folder name. Recover the source
    // root from an actual scanned file path so folder-level organize still works.
    const normalizedRelPath = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const fileInFolder = localFiles.find(file => {
      const fileRelPath = String(file.relPath || file.relativePath || file.name || '').replace(/\\/g, '/');
      return fileRelPath.startsWith(normalizedRelPath + '/');
    });
    if (fileInFolder?.path) {
      const normalizedFilePath = String(fileInFolder.path).replace(/\\/g, '/');
      const normalizedFileRelPath = String(fileInFolder.relPath || fileInFolder.relativePath || fileInFolder.name || '').replace(/\\/g, '/');
      if (normalizedFilePath.endsWith('/' + normalizedFileRelPath)) {
        const sourceRoot = normalizedFilePath.slice(0, -(normalizedFileRelPath.length + 1));
        return sourceRoot + '/' + normalizedRelPath;
      }
    }
    return '';
  }

  async function startLocalOrganize(action) {
    const assigned = Object.entries(assignMap);
    if (!assigned.length) return;

    // Each move/copy is a new run. Old failed statuses must not be included in
    // the current progress summary or remain visible on newly assigned files.
    localOrgDone = {};

    // Separate folder assignments and file assignments
    const folderAssigns = assigned.filter(([k]) => k.startsWith('folder:'));
    const fileAssigns = assigned.filter(([k]) => !k.startsWith('folder:'));

    const totalItems = assigned.length;
    let doneCount = 0;

    const progressBar = $('su-progress-bar');
    const progressFill = $('su-progress-fill');
    const progressText = $('su-progress-text');
    if (progressBar) progressBar.hidden = false;
    if (progressText) progressText.hidden = false;

    // Helper to compute subfolder target
    function getTargetDir(folder) {
      let targetDir = folder.path;
      const useRule = folder.subfolderRule || (localOrgDateSub ? subfolderRule : '');
      if (useRule) {
        const d = new Date();
        let subName = '';
        switch (useRule) {
          case 'date':
            subName = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
            break;
          case 'date-cn':
            subName = (d.getMonth()+1) + '月' + d.getDate() + '日';
            break;
          case 'yearmonth':
            subName = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
            break;
          case 'custom':
            subName = (folder.subfolderCustom || subfolderCustom || '').trim() || '未命名';
            break;
          default:
            subName = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        }
        targetDir += '/' + subName;
      }
      return targetDir;
    }

    // ── Process folder-level assignments ──
    const movedFolderRelPaths = []; // track for post-move cleanup
    for (const [key, folderId] of folderAssigns) {
      const relPath = key.slice('folder:'.length);
      const folder = localTargetFolders.find(f => f.id === folderId);
      if (!folder) continue;
      const srcDiskPath = resolveRelPathToDisk(relPath);
      if (!srcDiskPath) {
        localOrgDone[key] = {
          folderId,
          folderName: folder.name,
          status: 'fail',
          action,
          error: `无法定位源文件夹：${relPath}（请刷新源文件夹后重试）`
        };
        doneCount++;
        if (progressFill) progressFill.style.width = (doneCount / totalItems * 100) + '%';
        continue;
      }
      const targetDir = getTargetDir(folder);
      const folderName = srcDiskPath.split('/').pop();
      if (progressText) progressText.textContent = `${action === 'move' ? '移动' : '复制'}文件夹... ${folderName} → ${folder.name}`;
      try {
        let result;
        if (action === 'move') {
          result = await window.bridge?.localFiles?.moveFolderToFolder?.(srcDiskPath, targetDir, { conflict: localOrgConflictRule });
        } else {
          result = await window.bridge?.localFiles?.copyFolderToFolder?.(srcDiskPath, targetDir, { conflict: localOrgConflictRule });
        }
        if (!result || result.success === false) {
          console.warn('Folder organize returned failure:', relPath, result?.error);
          localOrgDone[key] = { folderId, folderName: folder.name, status: 'fail', action, error: result?.error || '整理服务没有返回结果，请重启软件后重试' };
        } else {
          const isSkipped = result && result.status === 'skip';
          localOrgDone[key] = { folderId, folderName: folder.name, status: 'done', action, skipped: isSkipped };
          if (action === 'move' && !isSkipped) movedFolderRelPaths.push(relPath);
        }
      } catch (err) {
        console.warn('Folder organize failed:', relPath, err);
        localOrgDone[key] = { folderId, folderName: folder.name, status: 'fail', action, error: err?.message || '未知错误' };
      }
      doneCount++;
      if (progressFill) progressFill.style.width = (doneCount / totalItems * 100) + '%';
    }

    // ── Process file-level assignments ──
    const fileGroups = {};
    fileAssigns.forEach(([fileId, folderId]) => {
      (fileGroups[folderId] = fileGroups[folderId] || []).push(fileId);
    });

    for (const [folderId, fileIds] of Object.entries(fileGroups)) {
      const folder = localTargetFolders.find(f => f.id === folderId);
      if (!folder) continue;

      for (const fileId of fileIds) {
        const file = localFiles.find(f => f.id === fileId);
        if (!file) continue;
        const targetDir = getTargetDir(folder);
        try {
          let result;
          if (action === 'move') {
            result = await window.bridge?.localFiles?.moveToFolder?.(file.path, targetDir, { conflict: localOrgConflictRule });
          } else {
            result = await window.bridge?.localFiles?.copyToFolder?.(file.path, targetDir, { conflict: localOrgConflictRule });
          }
          if (!result || result.success === false) {
            console.warn('Local organize returned failure:', file.name, result?.error);
            localOrgDone[fileId] = { folderId, folderName: folder.name, status: 'fail', action, error: result?.error || '整理服务没有返回结果，请重启软件后重试' };
          } else {
            const isSkipped = result && result.status === 'skip';
            localOrgDone[fileId] = { folderId, folderName: folder.name, status: 'done', action, skipped: isSkipped };
          }
        } catch (err) {
          console.warn('Local organize failed:', file.name, err);
          localOrgDone[fileId] = { folderId, folderName: folder.name, status: 'fail', action, error: err?.message || '未知错误' };
        }
        doneCount++;
        if (progressFill) progressFill.style.width = (doneCount / totalItems * 100) + '%';
        if (progressText) progressText.textContent = `${action === 'move' ? '移动' : '复制'}中... ${doneCount}/${totalItems} → ${folder.name}`;
      }
    }

    const allDone = Object.values(localOrgDone);
    const doneOk = allDone.filter(u => u.status === 'done').length;
    const doneFail = allDone.filter(u => u.status === 'fail').length;
    const failedItems = allDone.filter(item => item.status === 'fail');
    const failureHint = failedItems.length ? `：${failedItems[0].error || '未知错误'}${failedItems.length > 1 ? `（另有 ${failedItems.length - 1} 项）` : ''}` : '';
    if (progressText) progressText.textContent = `整理完成 ✅ 成功 ${doneOk} / 失败 ${doneFail}${failureHint}`;
    if (doneFail && typeof showToast === 'function') showToast(`移动/复制失败：${failureHint.slice(1)}`, 'error');

    // Post-move cleanup: remove successfully moved files & folders from list & clear assignments
    if (action === 'move') {
      // Remove files that were inside moved folders
      if (movedFolderRelPaths.length) {
        localFiles = localFiles.filter(f => {
          const rel = f.relPath || f.name || '';
          return !movedFolderRelPaths.some(fp => rel === fp || rel.startsWith(fp + '/'));
        });
        // Clean up file-level assigns & selections for files under moved folders
        Object.keys(assignMap).forEach(k => {
          if (k.startsWith('folder:')) return;
          const file = localFiles.find(lf => lf.id === k);
          if (!file) { delete assignMap[k]; delete localOrgDone[k]; selectedIds.delete(k); }
        });
      }
      // Remove folder assignments (for successfully moved folders)
      movedFolderRelPaths.forEach(fp => {
        delete assignMap['folder:' + fp];
        delete localOrgDone['folder:' + fp];
        selectedFolderPaths.delete(fp);
      });

      // For folders that were skipped during move, clear their assignment & selection but they remain in list
      const skippedFolderKeys = Object.entries(localOrgDone)
        .filter(([k, info]) => k.startsWith('folder:') && info.status === 'done' && info.action === 'move' && info.skipped)
        .map(([id]) => id);
      skippedFolderKeys.forEach(key => {
        delete assignMap[key];
        delete localOrgDone[key];
        selectedFolderPaths.delete(key.slice('folder:'.length));
      });

      // Remove individually moved files (not skipped) from localFiles list
      const movedFileIds = Object.entries(localOrgDone)
        .filter(([k, info]) => !k.startsWith('folder:') && info.status === 'done' && info.action === 'move' && !info.skipped)
        .map(([id]) => id);
      if (movedFileIds.length) {
        localFiles = localFiles.filter(f => !movedFileIds.includes(f.id));
        movedFileIds.forEach(id => {
          delete assignMap[id];
          delete localOrgDone[id];
          selectedIds.delete(id);
        });
      }

      // For files that were skipped during move, clear their assignment & selection but keep them in localFiles list
      const skippedFileIds = Object.entries(localOrgDone)
        .filter(([k, info]) => !k.startsWith('folder:') && info.status === 'done' && info.action === 'move' && info.skipped)
        .map(([id]) => id);
      skippedFileIds.forEach(id => {
        delete assignMap[id];
        delete localOrgDone[id];
        selectedIds.delete(id);
      });
    }
    // For copy: clear assignments so count resets, but keep files in list
    if (action === 'copy') {
      const copiedKeys = Object.entries(localOrgDone)
        .filter(([, info]) => info.status === 'done' && info.action === 'copy')
        .map(([id]) => id);
      copiedKeys.forEach(id => {
        delete assignMap[id];
        delete localOrgDone[id];
        if (id.startsWith('folder:')) selectedFolderPaths.delete(id.slice('folder:'.length));
      });
    }

    // Clear auto-avatar cache for processed target folders so they re-scan and pick up the new files
    const processedFolderIds = new Set();
    folderAssigns.forEach(([, fid]) => processedFolderIds.add(fid));
    fileAssigns.forEach(([, fid]) => processedFolderIds.add(fid));
    processedFolderIds.forEach(fid => {
      delete autoAvatarCache[fid];
      delete autoAvatarThumbnailCache[fid];
    });

    renderFileGrid();
    updateActionBar();
    if (workMode === 'local-organize') renderSlotList();
  }

  async function transferToDualTarget(action) {
    if (!dualTargetPath) return;
    const files = localFiles.filter(file => selectedIds.has(file.id) && file.path);
    if (!files.length) return;
    let completed = 0;
    for (const file of files) {
      const result = action === 'move'
        ? await window.bridge?.localFiles?.moveToFolder?.(file.path, dualTargetPath, { conflict: 'rename' })
        : await window.bridge?.localFiles?.copyToFolder?.(file.path, dualTargetPath, { conflict: 'rename' });
      if (result?.success) {
        completed++;
        if (action === 'move') {
          localFiles = localFiles.filter(item => item.id !== file.id);
          selectedIds.delete(file.id);
        }
      }
    }
    const tab = tabs.find(tabItem => tabItem.id === activeTabId);
    if (tab) tab.localFiles = localFiles;
    await openDualTarget(dualTargetPath);
    renderFileGrid();
    updateActionBar();
    if (typeof showToast === 'function') showToast(`${action === 'move' ? '移动' : '复制'}完成：${completed} / ${files.length} 个文件`, completed === files.length ? 'success' : 'info');
  }

  // ── Batch table editor ──
  function openBatchEditor() {
    $('su-batch-modal').hidden = false;
    populateBatchToolbar();
    renderBatchTable();
  }

  function closeBatchEditor() { $('su-batch-modal').hidden = true; }

  function getMainOptions(selected) {
    const cats = (typeof state !== 'undefined' && Array.isArray(state.categories)) ? state.categories : [];
    return `<option value="">--选择--</option>` + cats.map(c => `<option value="${c.name}"${c.name === selected ? ' selected' : ''}>${c.name}</option>`).join('');
  }
  function getSubOptions(main, selected) {
    const cats = (typeof state !== 'undefined' && Array.isArray(state.categories)) ? state.categories : [];
    const cat = cats.find(c => c.name === main);
    if (!cat || !cat.subs) return `<option value="">--</option>`;
    return `<option value="">--选择--</option>` + cat.subs.map(s => `<option value="${s.name}"${s.name === selected ? ' selected' : ''}>${s.name}</option>`).join('');
  }
  function getNamingOptions(selected) {
    const presets = (typeof state !== 'undefined' && Array.isArray(state.namingPresets)) ? state.namingPresets : [];
    return `<option value="">--默认--</option>` + presets.map(p => `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${p.label || p.id}</option>`).join('');
  }
  function getTaskTypeOptions(selected) {
    const types = (typeof getKnownTaskTypes === 'function') ? getKnownTaskTypes() : [];
    return `<option value="">--选择--</option>` + types.map(t => `<option value="${t}"${t === selected ? ' selected' : ''}>${t}</option>`).join('');
  }

  function renderBatchTable() {
    const tbody = $('su-batch-tbody');
    if (!tbody) return;
    const slots = getSlots();
    tbody.innerHTML = slots.map((s, i) => {
      const av = s.avatar || '';
      const avSrc = parseImageFormula(av);
      const isCustom = s.mode === 'custom-link';
      return `<tr data-idx="${i}">
      <td><input type="checkbox" class="su-batch-row-check" /></td>
      <td class="su-col-optional"><input type="text" value="${s.groupLabel || ''}" data-field="groupLabel" placeholder="分组" /></td>
      <td class="su-avatar-cell su-col-optional" data-idx="${i}">
        <div class="su-avatar-drop" title="点击选择图片 或 拖拽图片到此处">
          ${avSrc ? `<img class="su-avatar-preview" src="${avSrc}" />` : '<span class="su-avatar-placeholder-btn">＋</span>'}
        </div>
        <input type="text" value="${av}" data-field="avatar" class="su-avatar-url-input" placeholder="URL" />
        <input type="file" accept="image/*" class="su-avatar-file-input" style="display:none" />
      </td>
      <td><input type="text" value="${s.displayName || ''}" data-field="displayName" placeholder="卡片名称" /></td>
      <td><select data-field="mode" class="su-mode-select"><option value="library"${!isCustom ? ' selected' : ''}>入库</option><option value="custom-link"${isCustom ? ' selected' : ''}>自定义</option></select></td>
      <td class="su-col-custom"${!isCustom ? ' style="opacity:0.3"' : ''}><input type="text" value="${s.customLink || ''}" data-field="customLink" placeholder="Drive文件夹链接" /></td>
      <td class="su-col-optional"><input type="checkbox" data-field="skipCreateSubfolder" ${s.skipCreateSubfolder ? 'checked' : ''} /></td>
      <td><select data-field="taskType">${getTaskTypeOptions(s.taskType || '')}</select></td>
      <td class="su-col-optional"><input type="text" value="${s.extraLink || ''}" data-field="extraLink" placeholder="专页链接" /></td>
      <td class="su-col-optional"><input type="text" value="${s.pageName || ''}" data-field="pageName" placeholder="专页名称" /></td>
      <td class="su-col-optional"><input type="text" value="${s.admin || ''}" data-field="admin" placeholder="管理员" /></td>
      <td class="su-col-lib"${isCustom ? ' style="opacity:0.3"' : ''}><select data-field="mainCategory" class="su-main-cat-select">${getMainOptions(s.mainCategory)}</select></td>
      <td class="su-col-lib"${isCustom ? ' style="opacity:0.3"' : ''}><select data-field="subCategory" class="su-sub-cat-select">${getSubOptions(s.mainCategory, s.subCategory)}</select></td>
      <td class="su-col-lib su-col-optional"${isCustom ? ' style="opacity:0.3"' : ''}><select data-field="namingPresetId">${getNamingOptions(s.namingPresetId || '')}</select></td>
      <td class="su-col-lib su-col-optional"${isCustom ? ' style="opacity:0.3"' : ''}><select data-field="folderNamingPresetId">${getNamingOptions(s.folderNamingPresetId || '')}</select></td>
      <td class="su-col-lib su-col-optional"${isCustom ? ' style="opacity:0.3"' : ''}><input type="text" value="${s.subject || ''}" data-field="subject" placeholder="主题" /></td>
      <td class="su-col-lib su-col-optional"${isCustom ? ' style="opacity:0.3"' : ''}><input type="text" value="${s.eventName || ''}" data-field="eventName" placeholder="事件名称" /></td>
      <td class="su-col-lib su-col-optional"${isCustom ? ' style="opacity:0.3"' : ''}><input type="text" value="${s.distribution || ''}" data-field="distribution" placeholder="分发方式" /></td>
    </tr>`;
    }).join('');

    // Avatar cell interactions
    tbody.querySelectorAll('.su-avatar-cell').forEach(cell => {
      const dropArea = cell.querySelector('.su-avatar-drop');
      const fileInput = cell.querySelector('.su-avatar-file-input');
      const urlInput = cell.querySelector('.su-avatar-url-input');
      dropArea.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        const f = fileInput.files[0];
        if (!f) return;
        const p = f.path || (window.bridge?.getPathForFile?.(f));
        if (p) {
          urlInput.value = p;
          const src = toSafeFileUrl(p);
          dropArea.innerHTML = `<img class="su-avatar-preview" src="${src}" />`;
        }
      });
      dropArea.addEventListener('dragover', e => { e.preventDefault(); dropArea.classList.add('drag-over'); });
      dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
      dropArea.addEventListener('drop', e => {
        e.preventDefault(); dropArea.classList.remove('drag-over');
        const f = e.dataTransfer?.files?.[0];
        if (f && f.type.startsWith('image/')) {
          const p = f.path || (window.bridge?.getPathForFile?.(f));
          if (p) {
            urlInput.value = p;
            const src = toSafeFileUrl(p);
            dropArea.innerHTML = `<img class="su-avatar-preview" src="${src}" />`;
          }
        }
      });
      urlInput.addEventListener('change', () => {
        const src = parseImageFormula(urlInput.value);
        if (src) {
          dropArea.innerHTML = '';
          const img = document.createElement('img');
          img.className = 'su-avatar-preview';
          img.src = src;
          dropArea.appendChild(img);
        } else {
          dropArea.innerHTML = '<span class="su-avatar-placeholder-btn">＋</span>';
        }
      });
    });

    // Main → Sub category cascade
    tbody.querySelectorAll('.su-main-cat-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const tr = sel.closest('tr');
        const subSel = tr.querySelector('.su-sub-cat-select');
        if (subSel) subSel.innerHTML = getSubOptions(sel.value, '');
      });
    });

    // Mode change → toggle lib/custom column visibility per row + update global visibility
    tbody.querySelectorAll('.su-mode-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const tr = sel.closest('tr');
        const isCustom = sel.value === 'custom-link';
        tr.querySelectorAll('.su-col-lib').forEach(td => td.style.opacity = isCustom ? '0.3' : '1');
        tr.querySelectorAll('.su-col-custom').forEach(td => td.style.opacity = isCustom ? '1' : '0.3');
        updateBatchColumnVisibility();
      });
    });

    updateBatchColumnVisibility();
  }

  /** Scan all rows to determine dominant mode and hide irrelevant columns */
  function updateBatchColumnVisibility() {
    const table = $('su-batch-table');
    if (!table) return;
    const tbody = $('su-batch-tbody');
    if (!tbody) return;

    const modes = new Set();
    tbody.querySelectorAll('.su-mode-select').forEach(sel => modes.add(sel.value));
    // Also check slots directly for rows not yet rendered
    if (modes.size === 0) {
      getSlots().forEach(s => modes.add(s.mode || 'library'));
    }

    if (modes.size === 1 && modes.has('custom-link')) {
      table.dataset.batchMode = 'custom';
    } else if (modes.size === 1 && modes.has('library')) {
      table.dataset.batchMode = 'library';
    } else {
      table.dataset.batchMode = 'mixed';
    }
  }

  function saveBatchEdits() {
    const tbody = $('su-batch-tbody');
    if (!tbody) return;
    const slots = getSlots();
    tbody.querySelectorAll('tr').forEach(tr => {
      const idx = parseInt(tr.dataset.idx);
      const slot = slots[idx];
      if (!slot) return;
      tr.querySelectorAll('[data-field]').forEach(el => {
        const field = el.dataset.field;
        if (field === 'skipCreateSubfolder') {
          slot[field] = el.checked;
          return;
        }
        const val = el.value;
        if (field === 'mode') { slot.mode = val; }
        else { slot[field] = val; }
        if (field === 'customLink' && val) {
          slot.customFolderId = (typeof extractDriveFolderId === 'function') ? extractDriveFolderId(val) : val;
        }
      });
    });
    if (typeof persistSlotPresets === 'function') persistSlotPresets();
    if (typeof renderSlots === 'function') renderSlots();
    renderSlotList();
    closeBatchEditor();
  }

  // ── Local organize target folders batch editor ──
  function openLocalBatchEditor() {
    $('su-local-batch-modal').hidden = false;
    renderLocalBatchTable();
  }

  function closeLocalBatchEditor() {
    $('su-local-batch-modal').hidden = true;
  }

  function renderLocalBatchTable() {
    const tbody = $('su-local-batch-tbody');
    if (!tbody) return;
    
    // Create new datalist for autocomplete
    const oldDatalist = $('su-local-groups-list');
    if (oldDatalist) oldDatalist.remove();
    const existingGroups = [...new Set(localTargetFolders.map(f => f.group).filter(Boolean))];
    const datalist = document.createElement('datalist');
    datalist.id = 'su-local-groups-list';
    existingGroups.forEach(g => {
      const option = document.createElement('option');
      option.value = g;
      datalist.appendChild(option);
    });
    document.body.appendChild(datalist);
    
    tbody.innerHTML = localTargetFolders.map((f, i) => {
      const color = COLORS[i % COLORS.length];
      let avatarSrc = '';
      let avatarMediaPath = '';
      if (f.avatar) {
        avatarMediaPath = f.avatar;
        avatarSrc = toSafeFileUrl(f.avatar);
      } else {
        const cached = autoAvatarCache[f.id];
        if (typeof cached === 'string') {
          avatarMediaPath = cached;
          avatarSrc = toSafeFileUrl(cached);
        }
      }
      
      const isVideo = isPathVideo(avatarSrc);
      const videoThumbnailPath = isVideo ? autoAvatarThumbnailCache[f.id] : '';
      if (isVideo && !videoThumbnailPath) requestAutoAvatarThumbnail(f.id, avatarMediaPath);
      const avatarHtml = avatarSrc
        ? (isVideo
            ? (videoThumbnailPath
                ? `<img class="su-avatar-preview" src="${localFileUrl(videoThumbnailPath)}" loading="lazy" decoding="async" style="width:30px;height:30px;object-fit:cover;border-radius:4px;" />`
                : `<span style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;background:${color};color:#fff;font-size:14px;border-radius:4px;">🎬</span>`)
            : `<img class="su-avatar-preview" src="${avatarSrc}" style="width:30px;height:30px;object-fit:cover;border-radius:4px;" />`
          )
        : `<span style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;background:${color};color:#fff;font-size:12px;font-weight:600;border-radius:4px;">${(f.name || '?')[0]}</span>`;

      const subRules = [
        { val: '', label: '无 (直接归档)' },
        { val: 'date', label: '日期 (YYYYMMDD)' },
        { val: 'date-cn', label: '中文日期 (YYYY年MM月DD日)' },
        { val: 'yearmonth', label: '年月 (YYYYMM)' },
        { val: 'custom', label: '自定义规则内容' }
      ];
      const ruleOptions = subRules.map(r => `<option value="${r.val}"${r.val === (f.subfolderRule || '') ? ' selected' : ''}>${r.label}</option>`).join('');

      return `<tr data-idx="${i}">
        <td><input type="checkbox" class="su-local-batch-row-check" /></td>
        <td><input type="text" value="${f.group || ''}" data-field="group" placeholder="分组" list="su-local-groups-list" /></td>
        <td class="su-local-avatar-cell" data-idx="${i}" style="text-align:center;vertical-align:middle;">
          <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
            <div class="su-local-avatar-drop" style="width:30px;height:30px;cursor:pointer;display:flex;align-items:center;justify-content:center;border:1px dashed #ccc;border-radius:4px;" title="点击设置头像">
              ${avatarHtml}
            </div>
            <input type="hidden" value="${f.avatar || ''}" data-field="avatar" class="su-local-avatar-url-input" />
            <input type="file" accept="image/*" class="su-local-avatar-file-input" style="display:none" />
          </div>
        </td>
        <td><input type="text" value="${f.name || ''}" data-field="name" placeholder="显示名称" /></td>
        <td>
          <div style="display:flex;gap:4px;align-items:center;">
            <input type="text" value="${f.path || ''}" data-field="path" placeholder="物理路径" style="flex:1;" />
            <button class="su-btn su-btn-sm su-local-batch-pick-path" title="选择磁盘路径" style="padding:0 6px;height:26px;">📁</button>
          </div>
        </td>
        <td>
          <select data-field="subfolderRule" class="su-local-subrule-select">
            ${ruleOptions}
          </select>
        </td>
        <td>
          <input type="text" value="${f.subfolderCustom || ''}" data-field="subfolderCustom" placeholder="仅在自定义规则下生效" ${f.subfolderRule === 'custom' ? '' : 'disabled style="opacity:0.5;"'} />
        </td>
      </tr>`;
    }).join('');

    // Attach row events
    tbody.querySelectorAll('.su-local-avatar-cell').forEach(cell => {
      const dropArea = cell.querySelector('.su-local-avatar-drop');
      const fileInput = cell.querySelector('.su-local-avatar-file-input');
      const hiddenInput = cell.querySelector('.su-local-avatar-url-input');
      dropArea.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        const p = file.path || (window.bridge?.getPathForFile?.(file));
        if (p) {
          hiddenInput.value = p;
          const src = toSafeFileUrl(p);
          dropArea.innerHTML = `<img class="su-avatar-preview" src="${src}" style="width:30px;height:30px;object-fit:cover;border-radius:4px;" />`;
        }
      });
    });

    tbody.querySelectorAll('.su-local-batch-pick-path').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const pathInput = tr.querySelector('[data-field="path"]');
        const dir = await window.bridge?.localFiles?.pickFolder?.({ title: '选择本地磁盘物理路径' });
        if (dir) {
          pathInput.value = dir;
          const nameInput = tr.querySelector('[data-field="name"]');
          if (nameInput && !nameInput.value.trim()) {
            nameInput.value = dir.split(/[/\\]/).pop() || dir;
          }
        }
      });
    });

    tbody.querySelectorAll('.su-local-subrule-select').forEach(sel => {
      sel.addEventListener('change', () => {
        const tr = sel.closest('tr');
        const customInput = tr.querySelector('[data-field="subfolderCustom"]');
        if (customInput) {
          const isCustom = sel.value === 'custom';
          customInput.disabled = !isCustom;
          customInput.style.opacity = isCustom ? '1' : '0.5';
        }
      });
    });
  }

  function addLocalBatchRow() {
    const tbody = $('su-local-batch-tbody');
    if (!tbody) return;
    
    const i = tbody.querySelectorAll('tr').length;
    const color = COLORS[i % COLORS.length];
    const tr = document.createElement('tr');
    tr.dataset.idx = i;
    
    const subRules = [
      { val: '', label: '无 (直接归档)' },
      { val: 'date', label: '日期 (YYYYMMDD)' },
      { val: 'date-cn', label: '中文日期 (YYYY年MM月DD日)' },
      { val: 'yearmonth', label: '年月 (YYYYMM)' },
      { val: 'custom', label: '自定义规则内容' }
    ];
    const ruleOptions = subRules.map(r => `<option value="${r.val}">${r.label}</option>`).join('');

    tr.innerHTML = `
      <td><input type="checkbox" class="su-local-batch-row-check" /></td>
      <td><input type="text" value="" data-field="group" placeholder="分组" /></td>
      <td class="su-local-avatar-cell" data-idx="${i}" style="text-align:center;vertical-align:middle;">
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
          <div class="su-local-avatar-drop" style="width:30px;height:30px;cursor:pointer;display:flex;align-items:center;justify-content:center;border:1px dashed #ccc;border-radius:4px;" title="点击设置头像">
            <span style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;background:${color};color:#fff;font-size:12px;font-weight:600;border-radius:4px;">?</span>
          </div>
          <input type="hidden" value="" data-field="avatar" class="su-local-avatar-url-input" />
          <input type="file" accept="image/*" class="su-local-avatar-file-input" style="display:none" />
        </div>
      </td>
      <td><input type="text" value="" data-field="name" placeholder="显示名称" /></td>
      <td>
        <div style="display:flex;gap:4px;align-items:center;">
          <input type="text" value="" data-field="path" placeholder="物理路径" style="flex:1;" />
          <button class="su-btn su-btn-sm su-local-batch-pick-path" title="选择磁盘路径" style="padding:0 6px;height:26px;">📁</button>
        </div>
      </td>
      <td>
        <select data-field="subfolderRule" class="su-local-subrule-select">
          ${ruleOptions}
        </select>
      </td>
      <td>
        <input type="text" value="" data-field="subfolderCustom" placeholder="仅在自定义规则下生效" disabled style="opacity:0.5;" />
      </td>
    `;
    
    const cell = tr.querySelector('.su-local-avatar-cell');
    const dropArea = cell.querySelector('.su-local-avatar-drop');
    const fileInput = cell.querySelector('.su-local-avatar-file-input');
    const hiddenInput = cell.querySelector('.su-local-avatar-url-input');
    dropArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      const p = file.path || (window.bridge?.getPathForFile?.(file));
      if (p) {
        hiddenInput.value = p;
        const src = toSafeFileUrl(p);
        dropArea.innerHTML = `<img class="su-avatar-preview" src="${src}" style="width:30px;height:30px;object-fit:cover;border-radius:4px;" />`;
      }
    });

    tr.querySelector('.su-local-batch-pick-path').addEventListener('click', async () => {
      const pathInput = tr.querySelector('[data-field="path"]');
      const dir = await window.bridge?.localFiles?.pickFolder?.({ title: '选择本地磁盘物理路径' });
      if (dir) {
        pathInput.value = dir;
        const nameInput = tr.querySelector('[data-field="name"]');
        if (nameInput && !nameInput.value.trim()) {
          nameInput.value = dir.split(/[/\\]/).pop() || dir;
        }
      }
    });

    tr.querySelector('.su-local-subrule-select').addEventListener('change', (e) => {
      const customInput = tr.querySelector('[data-field="subfolderCustom"]');
      if (customInput) {
        const isCustom = e.target.value === 'custom';
        customInput.disabled = !isCustom;
        customInput.style.opacity = isCustom ? '1' : '0.5';
      }
    });

    tbody.appendChild(tr);
  }

  function deleteLocalBatchSelectedRows() {
    const tbody = $('su-local-batch-tbody');
    if (!tbody) return;
    const checked = tbody.querySelectorAll('.su-local-batch-row-check:checked');
    if (!checked.length) {
      alert('请先勾选要删除的行！');
      return;
    }
    if (confirm(`确认要删除选中的 ${checked.length} 个目标文件夹吗？`)) {
      checked.forEach(chk => {
        chk.closest('tr').remove();
      });
      tbody.querySelectorAll('tr').forEach((tr, index) => {
        tr.dataset.idx = index;
      });
    }
  }

  function saveLocalBatchEdits() {
    const tbody = $('su-local-batch-tbody');
    if (!tbody) return;
    
    const trs = tbody.querySelectorAll('tr');
    const newTargetFolders = [];
    
    for (const tr of trs) {
      const idx = parseInt(tr.dataset.idx);
      const existing = localTargetFolders[idx] || {};
      
      const item = {
        id: existing.id || ('lf-' + (++localTargetCounter) + '-' + Date.now()),
        name: tr.querySelector('[data-field="name"]').value.trim(),
        path: tr.querySelector('[data-field="path"]').value.trim(),
        group: tr.querySelector('[data-field="group"]').value.trim(),
        avatar: tr.querySelector('[data-field="avatar"]').value,
        avatarPos: existing.avatarPos || null,
        subfolderRule: tr.querySelector('[data-field="subfolderRule"]').value,
        subfolderCustom: tr.querySelector('[data-field="subfolderCustom"]').value.trim()
      };
      
      if (!item.name || !item.path) {
        alert('保存失败：显示名称和物理路径不能为空！');
        return;
      }
      
      newTargetFolders.push(item);
    }
    
    localTargetFolders = newTargetFolders;
    saveLocalTargetFolders();
    renderSlotList();
    closeLocalBatchEditor();
  }

  // Helper: save current batch table edits back to state.slots without closing the modal
  function saveBatchEditsInPlace() {
    const tbody = $('su-batch-tbody');
    if (!tbody) return;
    const slots = getSlots();
    tbody.querySelectorAll('tr').forEach(tr => {
      const idx = parseInt(tr.dataset.idx);
      const slot = slots[idx];
      if (!slot) return;
      tr.querySelectorAll('[data-field]').forEach(el => {
        const field = el.dataset.field;
        if (field === 'skipCreateSubfolder') {
          slot[field] = el.checked;
          return;
        }
        const val = el.value;
        if (field === 'mode') { slot.mode = val; }
        else { slot[field] = val; }
        if (field === 'customLink' && val) {
          slot.customFolderId = (typeof extractDriveFolderId === 'function') ? extractDriveFolderId(val) : val;
        }
      });
    });
  }

  function batchAddRow() {
    saveBatchEditsInPlace();
    if (typeof addSlot === 'function') addSlot({});
    renderBatchTable();
  }

  function batchDeleteChecked() {
    saveBatchEditsInPlace();
    const tbody = $('su-batch-tbody');
    const slots = getSlots();
    const toRemove = [];
    tbody.querySelectorAll('tr').forEach(tr => {
      if (tr.querySelector('.su-batch-row-check')?.checked) {
        toRemove.push(parseInt(tr.dataset.idx));
      }
    });
    toRemove.sort((a, b) => b - a).forEach(idx => {
      if (typeof removeSlot === 'function' && slots[idx]) removeSlot(slots[idx].id);
    });
    renderBatchTable();
  }

  const PASTE_FIELD_MAP = {
    '分类名称': 'mainCategory', '主分类': 'mainCategory', 'maincategory': 'mainCategory',
    '子分类': 'subCategory', 'subcategory': 'subCategory',
    '分组': 'groupLabel', 'group': 'groupLabel',
    '模式': 'mode', 'mode': 'mode',
    '目标链接': 'customLink', '链接': 'customLink', 'link': 'customLink',
    '显示名称': 'displayName', 'displayname': 'displayName', '名称': 'displayName',
    '头像': 'avatar', 'avatar': 'avatar', '图片': 'avatar', 'image': 'avatar',
    '专页链接': 'extraLink', '账号链接': 'extraLink', 'extralink': 'extraLink', 'pagelink': 'extraLink'
  };
  // Fixed column order fallback (no header)
  const PASTE_FIXED_ORDER = ['mainCategory', 'subCategory', 'groupLabel', 'mode', 'customLink', 'displayName', 'avatar', 'extraLink'];

  async function batchPaste() {
    try {
      saveBatchEditsInPlace();
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) return;
      const rows = text.split('\n').filter(r => r.trim());
      if (!rows.length) return;

      // Detect header: check if first row's cells match known field names
      const firstCols = rows[0].split('\t').map(c => c.trim().toLowerCase());
      const headerHits = firstCols.filter(c => PASTE_FIELD_MAP[c]).length;
      const hasHeader = headerHits >= 2; // at least 2 columns recognized as headers

      let colMap = {};
      let dataStart = 0;
      let isSingleColLink = false;
      if (hasHeader) {
        firstCols.forEach((h, i) => { if (PASTE_FIELD_MAP[h]) colMap[PASTE_FIELD_MAP[h]] = i; });
        dataStart = 1;
      } else {
        if (firstCols.length === 1 && parseDriveLink(firstCols[0])) {
          isSingleColLink = true;
          colMap['customLink'] = 0;
        } else {
          PASTE_FIXED_ORDER.forEach((f, i) => { colMap[f] = i; });
        }
        dataStart = 0;
      }

      let count = 0;
      for (let i = dataStart; i < rows.length; i++) {
        const cols = rows[i].split('\t');
        if (cols.length < 1) continue;
        const preset = {};
        Object.entries(colMap).forEach(([field, idx]) => {
          let val = (cols[idx] || '').trim();
          if (field === 'mode') val = (val === '自定义' || val === 'custom-link') ? 'custom-link' : 'library';
          if (field === 'avatar') val = parseImageFormula(val);
          preset[field] = val;
        });
        if (isSingleColLink) preset.mode = 'custom-link';
        if (preset.mainCategory || preset.displayName || preset.subCategory || preset.customLink) {
          if (typeof addSlot === 'function') { addSlot(preset); count++; }
        }
      }

      if (typeof persistSlotPresets === 'function') persistSlotPresets();
      renderBatchTable();
      renderSlotList();
      alert(`已从剪贴板粘贴添加 ${count} 个卡片${hasHeader ? '（已识别表头）' : '（按默认列顺序）'}`);
    } catch (e) { console.warn('粘贴失败:', e); alert('粘贴失败: ' + e.message); }
  }

  // ── Batch toolbar operations ──

  /** Populate the toolbar dropdowns with current state data */
  function populateBatchToolbar() {
    const cats = (typeof state !== 'undefined' && Array.isArray(state.categories)) ? state.categories : [];
    const mainSel = $('su-batch-set-main');
    if (mainSel) {
      mainSel.innerHTML = `<option value="">--不设--</option>` + cats.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
    }
    // Sub defaults to empty until main is chosen
    const subSel = $('su-batch-set-sub');
    if (subSel) subSel.innerHTML = `<option value="">--不设--</option>`;
    // Main → Sub cascade in toolbar
    mainSel?.addEventListener('change', () => {
      const cat = cats.find(c => c.name === mainSel.value);
      if (subSel) {
        subSel.innerHTML = `<option value="">--不设--</option>` +
          (cat?.subs || []).map(s => `<option value="${s.name}">${s.name}</option>`).join('');
      }
    });
    // Task types
    const taskSel = $('su-batch-set-tasktype');
    if (taskSel) {
      const types = (typeof getKnownTaskTypes === 'function') ? getKnownTaskTypes() : [];
      taskSel.innerHTML = `<option value="">--不设--</option>` + types.map(t => `<option value="${t}">${t}</option>`).join('');
    }
    // Naming presets
    const namingSel = $('su-batch-set-naming');
    const folderNamingSel = $('su-batch-set-foldernaming');
    if (namingSel || folderNamingSel) {
      const presets = (typeof state !== 'undefined' && Array.isArray(state.namingPresets)) ? state.namingPresets : [];
      const presetHtml = `<option value="">--不设--</option>` + presets.map(p => `<option value="${p.id}">${p.label || p.id}</option>`).join('');
      if (namingSel) namingSel.innerHTML = presetHtml;
      if (folderNamingSel) folderNamingSel.innerHTML = presetHtml;
    }
  }

  /** Apply toolbar field values to all checked rows */
  function batchApplyFields() {
    saveBatchEditsInPlace();
    const tbody = $('su-batch-tbody');
    if (!tbody) return;
    const slots = getSlots();
    const checkedRows = [];
    tbody.querySelectorAll('tr').forEach(tr => {
      if (tr.querySelector('.su-batch-row-check')?.checked) {
        checkedRows.push(parseInt(tr.dataset.idx));
      }
    });
    if (!checkedRows.length) {
      alert('请先勾选要设置的行');
      return;
    }

    const mainVal = $('su-batch-set-main')?.value;
    const subVal = $('su-batch-set-sub')?.value;
    const groupVal = $('su-batch-set-group')?.value?.trim();
    const avatarVal = $('su-batch-set-avatar')?.value?.trim();
    const modeVal = $('su-batch-set-mode')?.value;
    const taskVal = $('su-batch-set-tasktype')?.value;
    const namingVal = $('su-batch-set-naming')?.value;
    const folderNamingVal = $('su-batch-set-foldernaming')?.value;

    let changed = 0;
    checkedRows.forEach(idx => {
      const slot = slots[idx];
      if (!slot) return;
      if (mainVal) { slot.mainCategory = mainVal; changed++; }
      if (subVal) { slot.subCategory = subVal; changed++; }
      if (groupVal) { slot.groupLabel = groupVal; changed++; }
      if (avatarVal) { slot.avatar = avatarVal; changed++; }
      if (modeVal) { slot.mode = modeVal; changed++; }
      if (taskVal) { slot.taskType = taskVal; changed++; }
      if (namingVal) { slot.namingPresetId = namingVal; changed++; }
      if (folderNamingVal) { slot.folderNamingPresetId = folderNamingVal; changed++; }
    });

    if (changed === 0) {
      alert('请至少在工具栏中选择一个要设置的值');
      return;
    }

    if (typeof persistSlotPresets === 'function') persistSlotPresets();
    renderBatchTable();
    alert(`已将设置应用到 ${checkedRows.length} 行`);
  }

  /** Extract a Google Drive folder ID from any Drive URL format */
  function parseDriveLink(raw) {
    const s = (raw || '').trim().replace(/^"|"$/g, '');
    if (!s) return '';
    // Pure ID (20+ alphanumeric chars)
    if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
    try {
      const url = new URL(s);
      // ?id=xxx
      const qid = url.searchParams.get('id');
      if (qid && /^[a-zA-Z0-9_-]{10,}$/.test(qid)) return qid;
      const segs = url.pathname.split('/').filter(Boolean);
      // /drive/folders/xxx or /drive/u/0/folders/xxx
      const fi = segs.lastIndexOf('folders');
      if (fi !== -1 && segs[fi + 1]) return segs[fi + 1].split('?')[0];
      // /file/d/xxx or /document/d/xxx
      const di = segs.lastIndexOf('d');
      if (di !== -1 && segs[di + 1]) return segs[di + 1].split('?')[0];
      // /open?id=xxx  (already handled by query param)
    } catch (_) { /* not a URL */ }
    // Fallback: extract longest ID-like substring
    const m = s.match(/[a-zA-Z0-9_-]{20,}/);
    return m ? m[0] : '';
  }

  /** Show a dialog to paste multiple Drive links, then distribute to rows */
  function batchPasteLinks() {
    saveBatchEditsInPlace();
    // Remove any existing dialog
    document.querySelector('.su-batch-link-dialog-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'su-batch-link-dialog-overlay';
    overlay.innerHTML = `
      <div class="su-batch-link-dialog">
        <div class="su-batch-link-dialog-header">
          <h4>📋 批量粘贴 Google Drive 链接</h4>
          <button class="su-btn su-btn-sm su-link-dialog-close">✕</button>
        </div>
        <div class="su-batch-link-dialog-body">
          <textarea id="su-link-paste-area" placeholder="每行粘贴一条 Google Drive 文件夹链接，支持各种格式：&#10;&#10;https://drive.google.com/drive/folders/xxxxx&#10;https://drive.google.com/drive/u/0/folders/xxxxx&#10;https://drive.google.com/open?id=xxxxx&#10;纯文件夹ID (如 1AbCdEfGhIjKlMnOpQrStUv)&#10;&#10;也可以直接从表格粘贴一整列链接"></textarea>
          <div style="display:flex;gap:8px;margin:8px 0;align-items:center;">
            <label style="font-size:12px;color:#555;font-weight:600;">粘贴模式：</label>
            <label style="font-size:12px;cursor:pointer;"><input type="radio" name="su-paste-mode" value="replace" checked style="margin-right:3px"/>覆盖（从第1行起替换）</label>
            <label style="font-size:12px;cursor:pointer;"><input type="radio" name="su-paste-mode" value="fill" style="margin-right:3px"/>补全（仅填空行）</label>
            <label style="font-size:12px;cursor:pointer;"><input type="radio" name="su-paste-mode" value="append" style="margin-right:3px"/>新增（全部创建新行）</label>
          </div>
          <p class="hint">
            ✅ 支持格式：folders/xxx、open?id=xxx、file/d/xxx、纯ID<br/>
            📌 <strong>覆盖</strong>: 按顺序替换勾选行或全部行 | <strong>补全</strong>: 只填没链接的行 | <strong>新增</strong>: 全部创建新行
          </p>
        </div>
        <div class="su-batch-link-dialog-footer">
          <span class="info" id="su-link-count-info">已识别 0 条链接</span>
          <div class="actions">
            <button class="su-btn su-link-dialog-cancel">取消</button>
            <button class="su-btn su-btn-primary su-link-dialog-apply">确认分配</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const textarea = overlay.querySelector('#su-link-paste-area');
    const countInfo = overlay.querySelector('#su-link-count-info');
    const closeBtn = overlay.querySelector('.su-link-dialog-close');
    const cancelBtn = overlay.querySelector('.su-link-dialog-cancel');
    const applyBtn = overlay.querySelector('.su-link-dialog-apply');

    // Live count
    textarea.addEventListener('input', () => {
      const lines = textarea.value.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);
      const validCount = lines.filter(l => parseDriveLink(l)).length;
      countInfo.textContent = `已识别 ${validCount} 条有效链接（共 ${lines.length} 行）`;
    });

    const close = () => overlay.remove();
    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    applyBtn.addEventListener('click', () => {
      const lines = textarea.value.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);
      const links = lines.map(l => ({ raw: l, id: parseDriveLink(l) })).filter(x => x.id);
      if (!links.length) { alert('未识别到有效的 Drive 链接'); return; }

      const mode = overlay.querySelector('input[name="su-paste-mode"]:checked')?.value || 'replace';
      const slots = getSlots();
      const tbody = $('su-batch-tbody');
      const results = []; // track what was done

      if (mode === 'append') {
        // All links create new rows
        links.forEach((link, i) => {
          if (typeof addSlot === 'function') {
            addSlot({ mode: 'custom-link', customLink: link.raw, customFolderId: link.id });
            results.push(`🆕 新增第 ${slots.length + i + 1} 行 → ${link.raw.substring(0, 50)}...`);
          }
        });
      } else if (mode === 'fill') {
        // Only fill slots that have no customLink
        let li = 0;
        for (let si = 0; si < slots.length && li < links.length; si++) {
          if (!slots[si].customLink && !slots[si].lastFolderLink) {
            slots[si].mode = 'custom-link';
            slots[si].customLink = links[li].raw;
            slots[si].customFolderId = links[li].id;
            results.push(`📝 第 ${si + 1} 行 (${getSlotName(slots[si])}) ← 补全`);
            li++;
          }
        }
        // Remaining links create new rows
        while (li < links.length) {
          if (typeof addSlot === 'function') {
            addSlot({ mode: 'custom-link', customLink: links[li].raw, customFolderId: links[li].id });
            results.push(`🆕 新增行 ← ${links[li].raw.substring(0, 50)}...`);
          }
          li++;
        }
      } else {
        // Replace mode: use checked rows or sequential
        let targetIndices = [];
        if (tbody) {
          tbody.querySelectorAll('tr').forEach(tr => {
            if (tr.querySelector('.su-batch-row-check')?.checked) {
              targetIndices.push(parseInt(tr.dataset.idx));
            }
          });
        }
        if (!targetIndices.length) {
          targetIndices = slots.map((_, i) => i);
        }

        for (let li = 0; li < links.length; li++) {
          if (li < targetIndices.length) {
            const idx = targetIndices[li];
            const slot = slots[idx];
            if (!slot) continue;
            const oldLink = slot.customLink || '';
            slot.mode = 'custom-link';
            slot.customLink = links[li].raw;
            slot.customFolderId = links[li].id;
            results.push(`🔄 第 ${idx + 1} 行 (${getSlotName(slot)})${oldLink ? ' [已替换]' : ' [新填入]'}`);
          } else {
            if (typeof addSlot === 'function') {
              addSlot({ mode: 'custom-link', customLink: links[li].raw, customFolderId: links[li].id });
              results.push(`🆕 新增行 ← ${links[li].raw.substring(0, 50)}...`);
            }
          }
        }
      }

      if (typeof persistSlotPresets === 'function') persistSlotPresets();
      renderBatchTable();
      renderSlotList();
      close();
      // Show detailed result
      const summary = `✅ 已处理 ${results.length} 条链接\n\n${results.join('\n')}`;
      alert(summary);
    });

    // Auto-focus and try reading clipboard
    setTimeout(() => {
      textarea.focus();
      navigator.clipboard?.readText?.().then(text => {
        if (text && text.trim() && !textarea.value) {
          // Only auto-fill if it looks like it contains Drive links
          const lines = text.split(/[\n\r]+/).filter(l => l.trim());
          const hasLinks = lines.some(l => parseDriveLink(l.trim()));
          if (hasLinks) {
            textarea.value = text;
            textarea.dispatchEvent(new Event('input'));
          }
        }
      }).catch(() => {});
    }, 100);
  }

  async function batchAddMulti() {
    const countStr = await prompt('要添加几行？', '5');
    if (!countStr) return;
    const count = parseInt(countStr);
    if (!count || count < 1 || count > 100) { alert('请输入 1-100 的数字'); return; }
    saveBatchEditsInPlace();
    for (let i = 0; i < count; i++) {
      if (typeof addSlot === 'function') addSlot({});
    }
    renderBatchTable();
    alert(`已添加 ${count} 行`);
  }

  // ── Sheets import ──
  function openSheetsImport() { $('su-sheets-modal').hidden = false; }
  function closeSheetsImport() { $('su-sheets-modal').hidden = true; }

  async function previewSheets() {
    const url = $('su-sheets-url')?.value?.trim();
    if (!url) return;
    const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!idMatch) { alert('无效的 Google Sheets 链接'); return; }
    const sheetId = idMatch[1];
    const tabName = $('su-sheets-tab')?.value?.trim() || '';

    try {
      const token = await window.bridge?.getAccessToken?.();
      if (!token?.token) { alert('请先登录 Google'); return; }
      let apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName || 'Sheet1')}`;
      const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token.token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows = data.values || [];
      if (rows.length < 2) { alert('表格数据不足'); return; }

      const area = $('su-sheets-preview-area');
      const _escCell = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      area.hidden = false;
      area.innerHTML = `<table><thead><tr>${rows[0].map(h => `<th>${_escCell(h)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1, 20).map(r => `<tr>${r.map(c => `<td>${_escCell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table><p style="color:#666;margin-top:6px">显示前 ${Math.min(rows.length - 1, 19)} 行 / 共 ${rows.length - 1} 行</p>`;

      // Store for import
      area._sheetsData = rows;
      $('su-sheets-import').disabled = false;
    } catch (e) {
      alert('读取失败: ' + e.message);
    }
  }

  function importFromSheets() {
    const area = $('su-sheets-preview-area');
    const rows = area?._sheetsData;
    if (!rows || rows.length < 2) return;

    const headers = rows[0].map(h => h.trim().toLowerCase());
    const colMap = {};
    const fieldMap = {
      '分类名称': 'mainCategory', '主分类': 'mainCategory', 'maincategory': 'mainCategory',
      '子分类': 'subCategory', 'subcategory': 'subCategory',
      '分组': 'groupLabel', 'group': 'groupLabel', 'grouplabel': 'groupLabel',
      '模式': 'mode', 'mode': 'mode',
      '目标链接': 'customLink', '链接': 'customLink', 'link': 'customLink', 'customlink': 'customLink',
      '显示名称': 'displayName', 'displayname': 'displayName', '名称': 'displayName',
      '头像': 'avatar', 'avatar': 'avatar', '图片': 'avatar', 'image': 'avatar',
      '专页链接': 'extraLink', '账号链接': 'extraLink', 'extralink': 'extraLink', 'pagelink': 'extraLink', 'extra': 'extraLink'
    };
    headers.forEach((h, i) => { if (fieldMap[h]) colMap[fieldMap[h]] = i; });

    let count = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const preset = {};
      Object.entries(colMap).forEach(([field, col]) => {
        let val = (r[col] || '').trim();
        if (field === 'mode') val = (val === '自定义' || val === 'custom-link') ? 'custom-link' : 'library';
        if (field === 'avatar') val = parseImageFormula(val);
        preset[field] = val;
      });
      if (preset.mainCategory || preset.displayName) {
        if (typeof addSlot === 'function') addSlot(preset);
        count++;
      }
    }
    if (typeof persistSlotPresets === 'function') persistSlotPresets();
    if (typeof renderSlots === 'function') renderSlots();
    renderSlotList();
    closeSheetsImport();
    alert(`成功导入 ${count} 个分类卡片`);
  }

  // ── Drop zone ──
  function setupDropZone() {
    const zone = $('su-drop-zone');
    const panel = $('sort-upload-panel');
    if (!zone || !panel) return;

    ['dragenter', 'dragover'].forEach(ev => {
      panel.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('drag-over'); });
    });
    ['dragleave', 'drop'].forEach(ev => {
      panel.addEventListener(ev, () => zone.classList.remove('drag-over'));
    });
    panel.addEventListener('drop', async e => {
      e.preventDefault();
      const paths = [];
      if (e.dataTransfer?.files) {
        for (const f of e.dataTransfer.files) {
          const p = f.path || (window.bridge?.getPathForFile?.(f));
          if (p) paths.push({ id: p, name: f.name, path: p, size: f.size, mimeType: f.type || 'application/octet-stream', isLocal: true });
        }
      }
      if (paths.length) {
        const existingIds = new Set(localFiles.map(lf => lf.id));
        paths.forEach(f => {
          if (!existingIds.has(f.id)) {
            localFiles.push(f);
            existingIds.add(f.id);
          }
        });
        renderFileGrid();
        updateActionBar();
      }
    });
  }

  // ── Marquee Selection ──
  function initMarqueeSelection() {
    const area = $('su-file-area') || document.querySelector('#sort-upload-panel .su-file-area');
    if (!area) return;

    // Prevent native drag on images/videos from interfering with click/marquee selection
    area.addEventListener('dragstart', (e) => e.preventDefault());

    let isSelecting = false;
    let isPending = false;
    let startX = 0, startY = 0;
    let selectionBox = null;
    let initialSelected = new Set();
    let startedOnCard = false;
    const DRAG_THRESHOLD = 8;
    const CARD_DRAG_THRESHOLD = 40; // Higher threshold when starting on a card to avoid accidental marquee

    function isInteractiveSelectionTarget(target) {
      return Boolean(target.closest(
        'button, input, select, textarea, a, .su-video-badge, .su-file-delete, .su-select-popup'
      ));
    }

    function beginSelection(e) {
      isSelecting = true;
      isPending = false;

      if (e.ctrlKey || e.metaKey || e.shiftKey || startedOnCard) {
        // When starting on a card, preserve existing selections (additive)
        // to avoid clearing everything on accidental drag
        initialSelected = new Set(selectedIds);
      } else {
        selectedIds.clear();
        initialSelected = new Set();
        updateFileCardsInPlace();
        updateActionBar();
      }

      selectionBox = document.createElement('div');
      selectionBox.className = 'su-selection-box';
      selectionBox.style.left = startX + 'px';
      selectionBox.style.top = startY + 'px';
      selectionBox.style.width = '0px';
      selectionBox.style.height = '0px';
      document.body.appendChild(selectionBox);
    }

    area.addEventListener('mousedown', (e) => {
      // Ignore if clicking on interactive elements
      if (isInteractiveSelectionTarget(e.target)) return;
      if (e.button !== 0) return; // Only left click

      startedOnCard = !!e.target.closest('.su-file-card');
      isPending = true;
      startX = e.clientX;
      startY = e.clientY;
    });

    document.addEventListener('mousemove', (e) => {
      if (!isPending && (!isSelecting || !selectionBox)) return;
      if (isPending && e.buttons !== 1) {
        isPending = false;
        return;
      }

      const currentX = e.clientX;
      const currentY = e.clientY;
      const width = Math.abs(currentX - startX);
      const height = Math.abs(currentY - startY);

      if (isPending) {
        const threshold = startedOnCard ? CARD_DRAG_THRESHOLD : DRAG_THRESHOLD;
        if (width < threshold && height < threshold) return;
        beginSelection(e);
      }

      if (!selectionBox) return;

      const left = Math.min(startX, currentX);
      const top = Math.min(startY, currentY);

      selectionBox.style.left = left + 'px';
      selectionBox.style.top = top + 'px';
      selectionBox.style.width = width + 'px';
      selectionBox.style.height = height + 'px';

      // Calculate intersection
      const boxRect = { left, top, right: left + width, bottom: top + height };

      const cards = area.querySelectorAll('.su-file-card');
      const newSelected = new Set(initialSelected);

      cards.forEach(card => {
        const cardRect = card.getBoundingClientRect();

        const isIntersecting = !(
          cardRect.right < boxRect.left ||
          cardRect.left > boxRect.right ||
          cardRect.bottom < boxRect.top ||
          cardRect.top > boxRect.bottom
        );

        if (isIntersecting) {
          const ids = card.dataset.id
            ? [card.dataset.id]
            : getFileIdsUnderTreeFolder(card.dataset.folder);

          ids.forEach(id => {
            if (e.altKey && initialSelected.has(id)) {
               newSelected.delete(id); // Alt to deselect
            } else {
               newSelected.add(id);
            }
          });
        } else if (card.dataset.folder) {
          const ids = getFileIdsUnderTreeFolder(card.dataset.folder);
          if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
            ids.forEach(id => {
              if (!initialSelected.has(id)) newSelected.delete(id);
            });
          }
        }
      });

      selectedIds = newSelected;
      updateFileCardsInPlace();
      updateFolderCardSelectionState(area);
      updateActionBar();
      e.preventDefault();
    });

    const stopSelection = () => {
      if (isPending) {
        isPending = false;
      }
      if (isSelecting) {
        isSelecting = false;
        // Only suppress card clicks if we actually drew a visible selection box
        if (selectionBox) {
          const boxW = parseInt(selectionBox.style.width) || 0;
          const boxH = parseInt(selectionBox.style.height) || 0;
          if (boxW > DRAG_THRESHOLD || boxH > DRAG_THRESHOLD) {
            suppressNextFileCardClick = true;
            setTimeout(() => { suppressNextFileCardClick = false; }, 250);
          }
          selectionBox.remove();
          selectionBox = null;
        }
      }
    };

    document.addEventListener('mouseup', stopSelection);
  }

  // ── Keyboard shortcuts ──
  function handleKeydown(e) {
    if ($('sort-upload-panel')?.style.display === 'none') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  }

  // ── 右键菜单（本地整理通用） ──
  let _localCtxMenu = null;
  function showLocalContextMenu(x, y, items) {
    // 过滤掉 hidden 的项
    items = items.filter(i => !i.hidden);
    if (!items.length) return;

    // 移除旧菜单
    if (_localCtxMenu) _localCtxMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'do-context-menu'; // 复用云端分拣的样式
    menu.style.cssText = 'position:fixed;z-index:99999;max-height:calc(100vh - 16px);overflow-y:auto;';
    document.body.appendChild(menu);
    _localCtxMenu = menu;

    items.forEach(item => {
      const btn = document.createElement('div');
      btn.className = 'do-ctx-item';
      btn.innerHTML = `<span class="do-ctx-icon">${item.icon}</span><span>${item.label}</span>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        _localCtxMenu = null;
        item.action();
      });
      menu.appendChild(btn);
    });

    // 定位（确保不超出视口）
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuW = 200;
    const menuH = Math.min(items.length * 36 + 12, vh - 16);
    const left = x + menuW > vw ? x - menuW : x;
    const top = y + menuH > vh ? vh - menuH - 8 : y;
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';

    // 点击其他地方关闭
    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        _localCtxMenu = null;
        document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 10);
  }

  function getCurrentSourceDiskPath() {
    if (currentTreePath) return resolveRelPathToDisk(currentTreePath);
    if (localFolderPaths.length === 1) return localFolderPaths[0];
    if (!localFolderPaths.length && localFolderPath) return localFolderPath;
    return '';
  }

  async function promptCreateFolder(parentDiskPath, parentName) {
    const name = await showPrompt(`在「${parentName}」中新建文件夹：`, '');
    const requestedName = name?.trim();
    if (!requestedName) return;

    const result = await window.bridge?.localFiles?.createFolder?.(parentDiskPath, requestedName);
    if (!result?.success) {
      alert('新建文件夹失败: ' + (result?.error || '未知错误'));
      return;
    }

    await refreshAllFolders({ preserveTreePath: true });
    const createdName = result.name || requestedName;
    const renamedHint = createdName !== requestedName ? `（原名称「${requestedName}」已自动调整）` : '';
    showToast(`✅ 已创建文件夹「${createdName}」${renamedHint}`, 'success');
  }

  async function promptCreateFolders(parentDiskPath, parentName) {
    const text = await showMultilinePrompt(`在「${parentName}」中批量新建文件夹（每行一个）：`, '');
    if (!text?.trim()) return;

    const inputNames = text.split(/[\r\n]+/).map(name => name.trim()).filter(Boolean);
    const uniqueNames = [];
    const seenNames = new Set();
    const failures = [];
    for (const name of inputNames) {
      if (seenNames.has(name)) {
        failures.push({ name, error: '输入重复' });
        continue;
      }
      seenNames.add(name);
      uniqueNames.push(name);
    }
    if (!uniqueNames.length) return;

    const created = [];
    const adjusted = [];
    for (const name of uniqueNames) {
      const result = await window.bridge?.localFiles?.createFolder?.(parentDiskPath, name);
      if (result?.success) {
        const createdName = result.name || name;
        created.push(createdName);
        if (createdName !== name) adjusted.push(`${name} → ${createdName}`);
      } else {
        failures.push({ name, error: result?.error || '未知错误' });
      }
    }

    if (created.length) await refreshAllFolders({ preserveTreePath: true });

    if (!failures.length && !adjusted.length) {
      showToast(`✅ 成功新建 ${created.length} 个文件夹`, 'success');
      return;
    }

    const summary = [`批量新建完成：成功 ${created.length} 个，未创建 ${failures.length} 个。`];
    if (adjusted.length) {
      summary.push('', '以下名称已自动调整：', ...adjusted.slice(0, 10));
    }
    if (failures.length) {
      summary.push('', '未创建项目：', ...failures.slice(0, 12).map(item => `• ${item.name}：${item.error}`));
      if (failures.length > 12) summary.push(`…另有 ${failures.length - 12} 项`);
    }
    alert(summary.join('\n'));
    showToast(
      created.length ? `⚠️ 已新建 ${created.length} 个，${failures.length} 个未创建` : '❌ 没有创建任何文件夹',
      created.length ? 'warning' : 'error'
    );
  }

  function openSortUploadPanel() {
    const sortBtn = $('view-sort-upload');
    const panel = $('sort-upload-panel');
    const catPanel = $('category-panel');

    document.querySelectorAll('.view-switch button').forEach(b => b.classList.remove('active'));
    sortBtn?.classList.add('active');

    if (catPanel) catPanel.style.display = 'none';
    if (panel) panel.style.display = '';

    updateModeUI();
    if (workMode === 'local-dual') {
      renderSymmetricDualWorkspace();
      if (dualSidebarVisible) renderLocalFolderList();
    } else {
      renderSlotList();
      renderFileGrid();
    }
    updateActionBar();
    renderRecentSlots();
  }

  // ── Init ──
  function init() {
    if (initialized) return;
    initialized = true;
    initMarqueeSelection();
    // Create initial tab
    if (tabs.length === 0) {
      const firstTab = createTab('', '新标签');
      activeTabId = firstTab.id;
    }
    renderTabBar();

    // Mode switch
    const sortBtn = $('view-sort-upload');
    if (sortBtn) {
      sortBtn.addEventListener('click', () => {
        const isActive = sortBtn.classList.contains('active');
        if (isActive) return;
        openSortUploadPanel();
      });
    }

    // Also handle normal/review switching back — belt-and-suspenders
    document.querySelectorAll('#view-normal, #view-review').forEach(btn => {
      btn.addEventListener('click', () => {
        const panel = $('sort-upload-panel');
        if (panel) panel.style.display = 'none';
        const catPanel = $('category-panel');
        if (catPanel) catPanel.style.display = '';
        sortBtn?.classList.remove('active');
      });
    });

    // Pick folder
    $('su-pick-folder')?.addEventListener('click', pickFolder);
    $('su-refresh-folder')?.addEventListener('click', () => { if (localFolderPaths.length) refreshAllFolders(); else if (localFolderPath) scanFolder(localFolderPath); });

    // Scan progress
    window.bridge?.localFiles?.onScanProgress?.((data) => {
      const el = $('su-folder-path');
      if (el) {
        const name = data.folder.split('/').pop() || data.folder;
        el.textContent = `${name} (扫描中... ${data.count} 个文件)`;
      }
    });

    // Folder Watcher Events
    window.bridge?.localFiles?.onFolderRenamed?.(({ id, newPath, newName }) => {
      console.log('Folder renamed:', id, newPath, newName);
      const f = localTargetFolders.find(x => x.id === id);
      if (f) {
        updateLocalPathsAfterRename(f.path, newPath, '', newName);
        if (workMode === 'local-organize') {
          renderSlotList();
          renderFileGrid();
        }
        if (typeof showToast === 'function') showToast(`✅ 已同步本地文件夹改名：${newName}`, 'success');
      }
    });

    window.bridge?.localFiles?.onFolderMissing?.(({ id, path }) => {
      console.log('Folder missing:', id, path);
      const folder = localTargetFolders.find(item => item.id === id);
      if (!folder) return;
      // The directory no longer exists on disk: remove this stale target and assignments.
      removeLocalFolder(id);
      if (typeof showToast === 'function') showToast(`已移除不存在的本地目标：「${folder.name}」`, 'info');
    });

    // Search & Filter & Sort
    $('su-search')?.addEventListener('input', e => { 
      searchQuery = e.target.value; 
      const btn = $('su-file-search-toggle-btn');
      if (btn) {
        if (searchQuery) {
          btn.style.background = '#e8f0fe';
          btn.style.color = '#3b82f6';
          btn.style.borderColor = '#3b82f6';
        } else {
          btn.style.background = '';
          btn.style.color = '';
          btn.style.borderColor = '';
        }
      }
      renderFileGrid(); 
    });
    $('su-name-filter')?.addEventListener('change', e => {
      nameFilterMode = e.target.value;
      const input = $('su-name-filter-input');
      if (input) {
        input.style.display = nameFilterMode === 'all' ? 'none' : 'inline-block';
        if (nameFilterMode !== 'all') input.focus();
      }
      renderFileGrid();
    });
    $('su-name-filter-input')?.addEventListener('input', e => {
      nameFilterQuery = e.target.value;
      renderFileGrid();
    });
    $('su-date-filter')?.addEventListener('change', e => { 
      dateFilter = e.target.value; 
      const customWrap = $('su-date-custom-wrap');
      const monthWrap = $('su-month-custom-wrap');
      if (customWrap) {
        customWrap.style.display = (dateFilter === 'custom') ? 'inline-flex' : 'none';
      }
      if (monthWrap) {
        monthWrap.style.display = (dateFilter === 'custom-month') ? 'inline-flex' : 'none';
      }
      renderFileGrid(); 
    });
    $('su-date-custom-start')?.addEventListener('input', e => { customStart = e.target.value; renderFileGrid(); });
    $('su-date-custom-start')?.addEventListener('change', e => { customStart = e.target.value; renderFileGrid(); });
    $('su-date-custom-end')?.addEventListener('input', e => { customEnd = e.target.value; renderFileGrid(); });
    $('su-date-custom-end')?.addEventListener('change', e => { customEnd = e.target.value; renderFileGrid(); });
    $('su-month-custom-val')?.addEventListener('input', e => { customMonth = e.target.value; renderFileGrid(); });
    $('su-month-custom-val')?.addEventListener('change', e => { customMonth = e.target.value; renderFileGrid(); });
    $('su-sort-order')?.addEventListener('change', e => { sortOrder = e.target.value; renderFileGrid(); });
    $('su-clear-custom-order')?.addEventListener('click', () => {
      if (!customDisplayOrderPaths.length && !customFolderOrderPaths.length) return;
      customDisplayOrderPaths = [];
      customFolderOrderPaths = [];
      saveCurrentTab();
      saveTabs();
      renderFileGrid();
      updateActionBar();
      if (typeof showToast === 'function') showToast('已恢复为顶部选择的默认排序', 'success');
    });
    $('su-slot-search')?.addEventListener('input', e => { 
      slotSearchQuery = e.target.value; 
      renderSlotList(); 
      const btn = $('su-search-toggle-btn');
      if (btn) {
        if (slotSearchQuery) {
          btn.style.background = '#e8f0fe';
          btn.style.color = '#4285f4';
          btn.style.borderColor = '#4285f4';
        } else {
          btn.style.background = '';
          btn.style.color = '';
          btn.style.borderColor = '';
        }
      }
    });

    // Type filters
    document.querySelectorAll('.su-type-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.su-type-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        typeFilter = chip.dataset.type;
        renderFileGrid();
      });
    });

    // View mode toggle (flat / tree)
    document.querySelectorAll('.su-view-mode').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.su-view-mode').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fileViewMode = btn.dataset.mode;
        currentTreePath = ''; // reset path on mode switch
        renderFileGrid();
      });
    });

    // Thumbnail size slider
    $('su-thumb-size')?.addEventListener('input', e => {
      const size = e.target.value + 'px';
      const grid = $('su-file-grid');
      if (grid) grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${size}, 1fr))`;
    });

    // Selection dropdown menu
    $('su-batch-rename-btn')?.addEventListener('click', batchRenameSelectedFiles);
    $('su-select-menu-btn')?.addEventListener('click', () => {
      const existing = document.querySelector('.su-select-popup');
      if (existing) { existing.remove(); return; }
      const btn = $('su-select-menu-btn');
      const popup = document.createElement('div');
      popup.className = 'su-select-popup';
      popup.style.cssText = 'position:absolute;top:100%;left:0;z-index:9999;background:#fff;border:1px solid #e0e0e0;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.12);padding:4px 0;min-width:100px;font-size:12px;margin-top:4px;';
      const items = [
        { label: '☑ 全选', action: () => { filteredFiles().forEach(f => selectedIds.add(f.id)); updateFileCardsInPlace(); updateActionBar(); }},
        { label: '⇌ 反选', action: () => { filteredFiles().forEach(f => { if (selectedIds.has(f.id)) selectedIds.delete(f.id); else selectedIds.add(f.id); }); updateFileCardsInPlace(); updateActionBar(); }},
        { label: '☐ 取消选择', action: () => { selectedIds.clear(); updateFileCardsInPlace(); updateActionBar(); }},
      ];

      if (selectedIds.size > 0) {
        items.push({
          label: `↕️ 排序 / 分组 (${selectedIds.size})`,
          action: batchRenameSelectedFiles
        });
        items.push({
          label: `📋 复制已选 (${selectedIds.size})`,
          action: async () => {
            const paths = [];
            filteredFiles().forEach(f => {
              if (selectedIds.has(f.id) && f.path) paths.push(f.path);
            });
            if (!paths.length) return;
            const res = await window.bridge?.localFiles?.copyToClipboard(paths);
            if (res && res.success) {
              if (typeof showToast === 'function') showToast(`✅ 成功复制 ${paths.length} 个文件到剪贴板`, 'success');
            } else {
              if (typeof showToast === 'function') showToast('❌ 复制失败', 'error');
            }
          }
        });
      }

      items.forEach(it => {
        const item = document.createElement('div');
        item.textContent = it.label;
        item.style.cssText = 'padding:5px 12px;cursor:pointer;white-space:nowrap;';
        item.addEventListener('mouseenter', () => { item.style.background = '#f0f4f9'; });
        item.addEventListener('mouseleave', () => { item.style.background = ''; });
        item.addEventListener('click', () => { popup.remove(); it.action(); });
        popup.append(item);
      });
      btn.parentElement.append(popup);
      const dismiss = (ev) => { if (!popup.contains(ev.target) && ev.target !== btn) { popup.remove(); document.removeEventListener('click', dismiss); } };
      setTimeout(() => document.addEventListener('click', dismiss), 10);
    });

    // Action bar
    $('su-unassign-selected')?.addEventListener('click', () => {
      let removed = 0;
      selectedIds.forEach(id => {
        if (!assignMap[id]) return;
        delete assignMap[id];
        delete localOrgDone[id];
        removed++;
      });
      selectedFolderPaths.forEach(path => {
        const key = 'folder:' + path;
        if (!assignMap[key]) return;
        delete assignMap[key];
        delete localOrgDone[key];
        removed++;
      });
      if (!removed) return;
      updateFileCardsInPlace();
      renderSlotList();
      updateActionBar();
      if (typeof showToast === 'function') showToast(`已取消 ${removed} 个所选项目的分配`, 'success');
    });
    $('su-clear-assign')?.addEventListener('click', () => {
      assignMap = {};
      localOrgDone = {};
      selectedIds.clear();
      selectedFolderPaths.clear();
      updateFileCardsInPlace();
      renderSlotList();
      updateActionBar();
    });
    $('su-start-upload')?.addEventListener('click', startSortUpload);
    $('su-folder-upload')?.addEventListener('click', folderUploadToDrive);

    // Dedup button
    $('su-dedup-btn')?.addEventListener('click', async () => {
      if (!localFiles || localFiles.length === 0) return;
      if (localFiles.length < 2) {
        showToast('当前文件夹文件数量不足以查重。');
        return;
      }

      const dedupBtn = $('su-dedup-btn');
      const oriText = dedupBtn.textContent;
      dedupBtn.textContent = '⏳ 查重中...';
      dedupBtn.disabled = true;

      try {
        const paths = localFiles.map(f => f.path);
        const res = await window.bridge?.localFiles?.findDuplicates(paths);
        if (res && res.success) {
          if (res.duplicateGroups && res.duplicateGroups.length > 0) {
            showDuplicateReviewModal(res.duplicateGroups);
          } else {
            showToast('没有发现内容完全一致的重复文件。', 'success');
          }
        } else {
          alert('查重失败: ' + (res?.error || '未知错误'));
        }
      } catch (e) {
        console.error(e);
        alert('查重出错: ' + e.message);
      } finally {
        dedupBtn.textContent = oriText;
        dedupBtn.disabled = false;
      }
    });

    // Cloud org toggles
    $('su-cloud-subfolder')?.addEventListener('change', e => {
      cloudSubfolderEnabled = e.target.checked;
    });

    // Batch editor
    $('su-batch-edit-btn')?.addEventListener('click', () => {
      if (workMode === 'local-organize') {
        openLocalBatchEditor();
      } else {
        openBatchEditor();
      }
    });
    $('su-batch-close')?.addEventListener('click', closeBatchEditor);
    $('su-batch-save')?.addEventListener('click', saveBatchEdits);
    $('su-batch-add-row')?.addEventListener('click', batchAddRow);
    $('su-batch-del-rows')?.addEventListener('click', batchDeleteChecked);
    $('su-batch-paste')?.addEventListener('click', batchPaste);
    $('su-batch-check-all')?.addEventListener('change', e => {
      $('su-batch-tbody')?.querySelectorAll('.su-batch-row-check').forEach(cb => { cb.checked = e.target.checked; });
    });

    // Local target folder batch editor
    $('su-local-batch-close')?.addEventListener('click', closeLocalBatchEditor);
    $('su-local-batch-save')?.addEventListener('click', saveLocalBatchEdits);
    $('su-local-batch-add-row')?.addEventListener('click', addLocalBatchRow);
    $('su-local-batch-del-rows')?.addEventListener('click', deleteLocalBatchSelectedRows);
    $('su-local-batch-check-all')?.addEventListener('change', e => {
      $('su-local-batch-tbody')?.querySelectorAll('.su-local-batch-row-check').forEach(cb => { cb.checked = e.target.checked; });
    });
    // Batch toolbar buttons
    $('su-batch-apply-fields')?.addEventListener('click', batchApplyFields);
    $('su-batch-pick-avatar')?.addEventListener('click', async () => {
      const imgPath = await window.bridge?.localFiles?.pickImage?.();
      if (imgPath) {
        const input = $('su-batch-set-avatar');
        if (input) input.value = imgPath;
      }
    });
    $('su-batch-paste-links')?.addEventListener('click', batchPasteLinks);
    $('su-batch-add-multi')?.addEventListener('click', batchAddMulti);
    // Hide optional columns toggle
    $('su-batch-hide-optional')?.addEventListener('change', function() {
      const table = $('su-batch-table');
      if (table) table.dataset.hideOptional = this.checked ? 'true' : 'false';
    });

    // Sheets import
    $('su-import-sheets-btn')?.addEventListener('click', openSheetsImport);
    $('su-sheets-close')?.addEventListener('click', closeSheetsImport);
    $('su-sheets-preview')?.addEventListener('click', previewSheets);
    $('su-sheets-import')?.addEventListener('click', importFromSheets);

    // Drop zone
    setupDropZone();

    // Keyboard
    document.addEventListener('keydown', handleKeydown);

    // ── Local Organize Mode Init ──
    loadLocalTargetFolders();
    loadGroupParents();
    loadWorkMode();
    loadTabs();

    // Auto-scan restored source folders from saved tabs
    if (tabs.length && activeTabId) {
      const firstTab = tabs.find(t => t.id === activeTabId) || tabs[0];
      if (firstTab) {
        loadTab(firstTab.id);
        if (localFolderPaths.length) {
          $('su-refresh-folder').disabled = false;
          // Async scan without blocking init
          (async () => {
            const existingIds = new Set(localFiles.map(lf => lf.id));
            for (const dir of localFolderPaths) {
              $('su-folder-path').textContent = `恢复中: ${dir}...`;
              const files = await window.bridge?.localFiles?.scanFolder?.(dir);
              if (Array.isArray(files)) {
                files.forEach(f => {
                  if (!existingIds.has(f.id)) {
                    localFiles.push(f);
                    existingIds.add(f.id);
                  }
                });
              }
            }
            const tab = tabs.find(t => t.id === activeTabId);
            if (tab) { tab.localFiles = localFiles; }
            updateFolderPathDisplay();
            renderTabBar();
            renderFileGrid();
            updateActionBar();
          })();
        } else {
          updateFolderPathDisplay();
          renderTabBar();
          renderFileGrid();
          updateActionBar();
        }
      }
    }

    // Mode switch buttons
    document.querySelectorAll('.su-mode-switch-btn').forEach(btn => {
      btn.addEventListener('click', () => switchWorkMode(btn.dataset.mode));
    });
    $('su-local-folder-view-toggle')?.addEventListener('click', () => {
      localFolderViewMode = localFolderViewMode === 'grid' ? 'list' : 'grid';
      try { localStorage.setItem(LOCAL_FOLDER_VIEW_KEY, localFolderViewMode); } catch (_) {}
      updateModeUI();
      if (workMode === 'local-organize') renderLocalFolderList();
    });
    $('su-local-folder-sort')?.addEventListener('change', (e) => {
      localFolderSortMode = e.target.value;
      try { localStorage.setItem(LOCAL_FOLDER_SORT_KEY, localFolderSortMode); } catch (_) {}
      if (workMode === 'local-organize') renderLocalFolderList();
    });
    $('su-show-archived-local-folders')?.addEventListener('click', () => {
      showArchivedLocalFolders = !showArchivedLocalFolders;
      updateModeUI();
      renderSlotList();
    });
    $('su-refresh-target-folders')?.addEventListener('click', async () => {
      const validation = await window.bridge?.localFiles?.validateFolders?.(localTargetFolders) || [];
      const missingIds = new Set(validation.filter(item => !item.exists).map(item => item.id));
      const missingFolders = localTargetFolders.filter(folder => missingIds.has(folder.id));
      if (missingIds.size) {
        localTargetFolders = localTargetFolders.filter(folder => !missingIds.has(folder.id));
        Object.keys(assignMap).forEach(key => {
          if (missingIds.has(assignMap[key])) delete assignMap[key];
        });
        saveLocalTargetFolders();
      }
      localTargetFolders.forEach(folder => {
        delete autoAvatarCache[folder.id];
        delete autoAvatarThumbnailCache[folder.id];
        loadAutoAvatar(folder.id, folder.path);
      });
      renderSlotList();
      renderFileGrid();
      if (typeof showToast === 'function') {
        showToast(missingFolders.length ? `已同步：移除 ${missingFolders.length} 个不存在的本地目标` : '已同步本地目标文件夹', 'success');
      }
    });

    // Add local folder button
    $('su-add-local-folder')?.addEventListener('click', () => addLocalFolder());
    $('su-add-local-subfolders')?.addEventListener('click', () => addLocalSubfolders());
    $('su-export-preset')?.addEventListener('click', exportPresetHandler);
    $('su-import-preset')?.addEventListener('click', importPresetHandler);
    $('su-merge-preset')?.addEventListener('click', mergePresetsHandler);

    // Local organize actions dropdown menu
    $('su-local-action-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = document.querySelector('.su-local-action-popup');
      if (existing) { existing.remove(); return; }
      
      const btn = $('su-local-action-btn');
      const popup = document.createElement('div');
      popup.className = 'su-local-action-popup';
      
      const rootShort = defaultTargetRoot ? ('.../' + (defaultTargetRoot.replace(/\\/g, '/').split('/').pop() || defaultTargetRoot)) : '';
      const archivedCount = localTargetFolders.filter(folder => folder.archived).length;
      const items = [
        { label: '➕ 添加文件夹', action: () => $('su-add-local-folder')?.click() },
        { label: '⚡ 获取子文件夹', action: () => $('su-add-local-subfolders')?.click() },
        { label: showArchivedLocalFolders ? '← 返回正常目标' : `🗃️ 已归档${archivedCount ? ` (${archivedCount})` : ''}`, action: () => {
          showArchivedLocalFolders = !showArchivedLocalFolders;
          renderSlotList();
        }},
        { divider: true },
        { label: defaultTargetRoot ? `📂 总文件夹: ${rootShort}` : '📂 设置默认总文件夹', action: async () => {
          const dir = await window.bridge?.localFiles?.pickFolder?.({ title: '选择默认目标总文件夹' });
          if (!dir) return;
          const picked = Array.isArray(dir) ? dir[0] : dir;
          if (!picked) return;
          defaultTargetRoot = picked;
          saveDefaultTargetRoot();
          if (typeof showToast === 'function') showToast('✅ 已设置默认总文件夹: ' + picked.split('/').pop(), 'success');
        }},
        { label: '📁 新建目标文件夹', action: async () => {
          if (!defaultTargetRoot) {
            // 如果还没设过总文件夹，先让用户选
            const dir = await window.bridge?.localFiles?.pickFolder?.({ title: '请先选择默认目标总文件夹' });
            if (!dir) return;
            const picked = Array.isArray(dir) ? dir[0] : dir;
            if (!picked) return;
            defaultTargetRoot = picked;
            saveDefaultTargetRoot();
          }
          const folderName = await showPrompt('在总文件夹内新建目标文件夹：', '');
          if (!folderName || !folderName.trim()) return;
          const result = await window.bridge?.localFiles?.createFolder?.(defaultTargetRoot, folderName.trim());
          if (result?.success) {
            const newPath = result.path;
            if (!localTargetFolders.some(f => f.path === newPath)) {
              const rootName = defaultTargetRoot.replace(/\\/g, '/').split('/').pop() || '';
              localTargetFolders.push({
                id: 'lf-' + (++localTargetCounter) + '-' + Date.now(),
                name: result.name,
                path: newPath,
                group: rootName
              });
              // 确保 groupParents 也记录了总文件夹路径
              if (rootName && !groupParents[rootName]) {
                groupParents[rootName] = defaultTargetRoot;
                saveGroupParents();
              }
              saveLocalTargetFolders();
              renderSlotList();
              if (typeof showToast === 'function') showToast(`✅ 已创建「${result.name}」并添加为目标`, 'success');
            } else {
              if (typeof showToast === 'function') showToast('该文件夹已在目标列表中', 'info');
            }
          } else {
            alert('新建文件夹失败: ' + (result?.error || '未知错误'));
          }
        }},
        { label: '📁 批量新建目标文件夹', action: async () => {
          if (!defaultTargetRoot) {
            // 如果还没设过总文件夹，先让用户选
            const dir = await window.bridge?.localFiles?.pickFolder?.({ title: '请先选择默认目标总文件夹' });
            if (!dir) return;
            const picked = Array.isArray(dir) ? dir[0] : dir;
            if (!picked) return;
            defaultTargetRoot = picked;
            saveDefaultTargetRoot();
          }
          const text = await showMultilinePrompt('在总文件夹内批量新建目标文件夹（每行一个文件夹名称）：', '');
          if (!text || !text.trim()) return;
          const folderNames = text.split(/[\r\n]+/).map(n => n.trim()).filter(Boolean);
          if (!folderNames.length) return;

          let successCount = 0;
          let existCount = 0;
          const rootName = defaultTargetRoot.replace(/\\/g, '/').split('/').pop() || '';

          for (const name of folderNames) {
            const result = await window.bridge?.localFiles?.createFolder?.(defaultTargetRoot, name);
            if (result?.success) {
              const newPath = result.path;
              if (!localTargetFolders.some(f => f.path === newPath)) {
                localTargetFolders.push({
                  id: 'lf-' + (++localTargetCounter) + '-' + Date.now(),
                  name: result.name,
                  path: newPath,
                  group: rootName
                });
                successCount++;
              } else {
                existCount++;
              }
            }
          }

          if (successCount > 0) {
            if (rootName && !groupParents[rootName]) {
              groupParents[rootName] = defaultTargetRoot;
              saveGroupParents();
            }
            saveLocalTargetFolders();
            renderSlotList();
          }

          let msg = `✅ 批量创建完成：成功新建并添加 ${successCount} 个目标文件夹。`;
          if (existCount > 0) msg += `\n⚠️ 有 ${existCount} 个文件夹已在目标列表中。`;
          alert(msg);
        }},
        { divider: true },
        { label: '📤 导出预设', action: () => $('su-export-preset')?.click() },
        { label: '📥 导入预设', action: () => $('su-import-preset')?.click() },
        { label: '🔀 合并分类', action: () => $('su-merge-preset')?.click() }
      ];
      
      items.forEach(it => {
        if (it.divider) {
          const div = document.createElement('div');
          div.style.cssText = 'height:1px;background:#eee;margin:4px 0;';
          popup.appendChild(div);
          return;
        }
        const item = document.createElement('div');
        item.style.cssText = 'padding:6px 14px;cursor:pointer;white-space:nowrap;transition:background 0.15s;color:#333;text-align:left;';
        item.textContent = it.label;
        item.addEventListener('mouseenter', () => { item.style.background = '#f5f5f5'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
        item.addEventListener('click', () => {
          popup.remove();
          it.action();
        });
        popup.appendChild(item);
      });
      
      // Position fixed & append to body to avoid overflow clipping from parent elements
      const rect = btn.getBoundingClientRect();
      popup.style.cssText = `
        position: fixed;
        z-index: 99999;
        background: #fff;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.12);
        padding: 6px 0;
        min-width: 140px;
        font-size: 12px;
        top: ${rect.bottom + 4}px;
        left: ${rect.left}px;
      `;
      
      document.body.appendChild(popup);
      
      const closePopup = (ev) => {
        if (!popup.contains(ev.target) && ev.target !== btn) {
          popup.remove();
          document.removeEventListener('click', closePopup, true);
        }
      };
      setTimeout(() => document.addEventListener('click', closePopup, true), 0);
    });

    // Upload organize actions dropdown menu
    $('su-upload-action-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = document.querySelector('.su-upload-action-popup');
      if (existing) { existing.remove(); return; }
      
      const btn = $('su-upload-action-btn');
      const popup = document.createElement('div');
      popup.className = 'su-upload-action-popup';
      
      const rootShort = defaultCloudRootName ? (defaultCloudRootName.length > 10 ? defaultCloudRootName.slice(0, 10) + '...' : defaultCloudRootName) : '';
      const items = [
        { label: defaultCloudRoot ? `📂 云端总文件夹: ${rootShort}` : '📂 设置默认云端总文件夹', action: async () => {
          const rawUrl = await showPrompt('请输入 Google Drive 默认目标总文件夹链接/ID：', defaultCloudRootLink || '');
          if (!rawUrl || !rawUrl.trim()) return;
          const folderId = parseDriveLink(rawUrl.trim());
          if (!folderId) { alert('无法解析链接，请输入有效的 Google Drive 文件夹 URL 或 ID'); return; }
          
          if (typeof showToast === 'function') showToast('正在读取文件夹信息...', 'info');
          try {
            const info = await fetchCloudFolderInfo(folderId);
            defaultCloudRoot = folderId;
            defaultCloudRootName = info.name || '云端总文件夹';
            defaultCloudRootLink = rawUrl.trim();
            saveDefaultCloudRoot();
            if (typeof showToast === 'function') showToast('✅ 已设置默认云端总文件夹: ' + defaultCloudRootName, 'success');
          } catch (err) {
            alert('获取文件夹名称失败，请确保已登录 Google 且链接有读取权限: ' + err.message);
          }
        }},
        { divider: true },
        { label: '📁 新建云端目标文件夹', action: async () => {
          if (!defaultCloudRoot) {
            alert('请先设置默认云端总文件夹');
            return;
          }
          const folderName = await showPrompt('在云端总文件夹内新建文件夹并创建卡片：', '');
          if (!folderName || !folderName.trim()) return;
          
          if (typeof showToast === 'function') showToast('正在创建云端文件夹...', 'info');
          const result = await createCloudFolder(defaultCloudRoot, folderName.trim());
          if (result?.success) {
            if (typeof addSlot === 'function') {
              addSlot({
                mode: 'custom-link',
                customLink: result.folder.link,
                customFolderId: result.folder.id,
                displayName: result.folder.name,
                groupLabel: defaultCloudRootName || '云端总文件夹'
              });
              if (typeof persistSlotPresets === 'function') persistSlotPresets();
              renderSlotList();
            }
            if (typeof showToast === 'function') showToast(`✅ 已创建文件夹「${result.folder.name}」并新建卡片`, 'success');
          } else {
            alert('创建云端文件夹失败: ' + (result?.error || '未知错误'));
          }
        }},
        { label: '📁 批量新建云端目标文件夹', action: async () => {
          if (!defaultCloudRoot) {
            alert('请先设置默认云端总文件夹');
            return;
          }
          const text = await showMultilinePrompt('在云端总文件夹内批量新建文件夹并创建卡片（每行一个名称）：', '');
          if (!text || !text.trim()) return;
          const folderNames = text.split(/[\r\n]+/).map(n => n.trim()).filter(Boolean);
          if (!folderNames.length) return;

          if (typeof showToast === 'function') showToast(`正在批量创建 ${folderNames.length} 个文件夹...`, 'info');
          let successCount = 0;
          let failCount = 0;

          for (const name of folderNames) {
            const result = await createCloudFolder(defaultCloudRoot, name);
            if (result?.success) {
              if (typeof addSlot === 'function') {
                addSlot({
                  mode: 'custom-link',
                  customLink: result.folder.link,
                  customFolderId: result.folder.id,
                  displayName: result.folder.name,
                  groupLabel: defaultCloudRootName || '云端总文件夹'
                });
              }
              successCount++;
            } else {
              console.error('Failed to create cloud folder', name, result?.error);
              failCount++;
            }
          }

          if (successCount > 0) {
            if (typeof persistSlotPresets === 'function') persistSlotPresets();
            renderSlotList();
          }

          let msg = `✅ 批量创建完成：成功新建并添加 ${successCount} 个云端卡片。`;
          if (failCount > 0) msg += `\n❌ 有 ${failCount} 个文件夹创建失败，请查看日志或检查网络。`;
          alert(msg);
        }},
        { label: '⚡ 扫描总文件夹导入卡片', action: async () => {
          const rawUrl = await showPrompt('请输入 Google Drive 总文件夹链接/ID：', defaultCloudRootLink || '');
          if (!rawUrl || !rawUrl.trim()) return;
          const folderId = parseDriveLink(rawUrl.trim());
          if (!folderId) { alert('无法解析链接，请输入有效的 Google Drive 文件夹 URL 或 ID'); return; }

          if (typeof showToast === 'function') showToast('正在获取文件夹信息并扫描...', 'info');
          try {
            const token = await getCloudAccessToken();
            if (!token) {
              alert('请确保已登录 Google 且授权成功');
              return;
            }

            let folderName = '云端总文件夹';
            try {
              const info = await fetchCloudFolderInfo(folderId);
              folderName = info.name || '云端总文件夹';
              defaultCloudRoot = folderId;
              defaultCloudRootName = folderName;
              defaultCloudRootLink = rawUrl.trim();
              saveDefaultCloudRoot();
            } catch (err) {
              console.warn('Failed to fetch parent folder name: ', err);
            }

            const q = encodeURIComponent(`'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
            const fields = encodeURIComponent('files(id,name)');
            const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000`;
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) {
              const err = await res.json().catch(()=>({}));
              throw new Error(err?.error?.message || `HTTP ${res.status}`);
            }
            const data = await res.json();
            const subfolders = data.files || [];
            if (!subfolders || !subfolders.length) {
              alert('在该云端总文件夹下未找到任何一级子文件夹！');
              return;
            }

            const slots = getSlots();
            let addedCount = 0;
            for (const sub of subfolders) {
              const exists = slots.some(s => s.customFolderId === sub.id || parseDriveLink(s.customLink || '') === sub.id);
              if (!exists) {
                if (typeof addSlot === 'function') {
                  addSlot({
                    mode: 'custom-link',
                    customLink: `https://drive.google.com/drive/folders/${sub.id}`,
                    customFolderId: sub.id,
                    displayName: sub.name,
                    groupLabel: defaultCloudRootName || '云端总文件夹'
                  });
                  addedCount++;
                }
              }
            }
            
            if (addedCount > 0) {
              if (typeof persistSlotPresets === 'function') persistSlotPresets();
              renderSlotList();
              if (typeof showToast === 'function') showToast(`✅ 成功扫描并导入了 ${addedCount} 个子文件夹卡片`, 'success');
            } else {
              if (typeof showToast === 'function') showToast('所有子文件夹已存在于卡片列表中', 'info');
            }
          } catch (err) {
            alert('扫描子文件夹失败: ' + err.message);
          }
        }},
        { label: '🔗 批量导入云盘链接', action: async () => {
          const text = await showMultilinePrompt('请输入 Google Drive 文件夹链接（每行一个）：', '');
          if (!text || !text.trim()) return;
          const lines = text.split(/[\r\n]+/).map(n => n.trim()).filter(Boolean);
          if (!lines.length) return;

          if (typeof showToast === 'function') showToast(`正在解析并导入 ${lines.length} 个文件夹链接...`, 'info');
          let successCount = 0;
          let failCount = 0;
          const slots = getSlots();

          for (const line of lines) {
            const folderId = parseDriveLink(line);
            if (!folderId) {
              failCount++;
              continue;
            }
            const exists = slots.some(s => s.customFolderId === folderId || parseDriveLink(s.customLink || '') === folderId);
            if (exists) {
              continue;
            }

            try {
              const info = await fetchCloudFolderInfo(folderId);
              if (typeof addSlot === 'function') {
                addSlot({
                  mode: 'custom-link',
                  customLink: `https://drive.google.com/drive/folders/${folderId}`,
                  customFolderId: folderId,
                  displayName: info.name || '云端文件夹',
                  groupLabel: defaultCloudRootName || '云端总文件夹'
                });
                successCount++;
              }
            } catch (err) {
              console.error('Failed to fetch info for folder: ' + folderId, err);
              failCount++;
            }
          }

          if (successCount > 0) {
            if (typeof persistSlotPresets === 'function') persistSlotPresets();
            renderSlotList();
          }

          let msg = `✅ 批量导入完成：成功导入 ${successCount} 个目标文件夹卡片。`;
          if (failCount > 0) msg += `\n⚠️ 有 ${failCount} 个链接解析或读取失败（请确保链接有读取权限）。`;
          alert(msg);
        }},
        { divider: true },
        { label: '📥 导入预设', action: () => $('su-import-preset')?.click() },
        { label: '📤 导出预设', action: () => $('su-export-preset')?.click() },
        { label: '🔀 合并分类', action: () => $('su-merge-preset')?.click() }
      ];
      
      items.forEach(it => {
        if (it.divider) {
          const div = document.createElement('div');
          div.style.cssText = 'height:1px;background:#eee;margin:4px 0;';
          popup.appendChild(div);
          return;
        }
        const item = document.createElement('div');
        item.style.cssText = 'padding:6px 14px;cursor:pointer;white-space:nowrap;transition:background 0.15s;color:#333;text-align:left;';
        item.textContent = it.label;
        item.addEventListener('mouseenter', () => { item.style.background = '#f5f5f5'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
        item.addEventListener('click', () => {
          popup.remove();
          it.action();
        });
        popup.appendChild(item);
      });
      
      // Position fixed & append to body to avoid overflow clipping from parent elements
      const rect = btn.getBoundingClientRect();
      popup.style.cssText = `
        position: fixed;
        z-index: 99999;
        background: #fff;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.12);
        padding: 6px 0;
        min-width: 140px;
        font-size: 12px;
        top: ${rect.bottom + 4}px;
        left: ${rect.left}px;
      `;
      
      document.body.appendChild(popup);
      
      const closePopup = (ev) => {
        if (!popup.contains(ev.target) && ev.target !== btn) {
          popup.remove();
          document.removeEventListener('click', closePopup, true);
        }
      };
      setTimeout(() => document.addEventListener('click', closePopup, true), 0);
    });


    // Search toggle button click logic
    $('su-search-toggle-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const popup = $('su-search-popup');
      if (!popup) return;
      const isHidden = popup.style.display === 'none';
      popup.style.display = isHidden ? 'block' : 'none';
      if (isHidden) {
        const input = $('su-slot-search');
        if (input) {
          input.focus();
          input.select();
        }
      }
    });

    // Close search popup when clicking outside
    document.addEventListener('click', (ev) => {
      const popup = $('su-search-popup');
      const btn = $('su-search-toggle-btn');
      if (popup && popup.style.display === 'block') {
        if (!popup.contains(ev.target) && !btn?.contains(ev.target)) {
          popup.style.display = 'none';
        }
      }
      
      const fileSearchPopup = $('su-file-search-popup');
      const fileSearchBtn = $('su-file-search-toggle-btn');
      if (fileSearchPopup && fileSearchPopup.style.display === 'block') {
        if (!fileSearchPopup.contains(ev.target) && !fileSearchBtn?.contains(ev.target)) {
          fileSearchPopup.style.display = 'none';
        }
      }

      const setPopup = $('su-settings-popup');
      const setBtn = $('su-settings-toggle-btn');
      if (setPopup && setPopup.style.display === 'block') {
        if (!setPopup.contains(ev.target) && !setBtn?.contains(ev.target) && !ev.target.closest('#su-waste-folder-pick') && !ev.target.closest('#su-waste-folder-clear')) {
          setPopup.style.display = 'none';
        }
      }
      const tabPopup = document.querySelector('.su-tab-dropdown-popup');
      const tabBtn = $('su-tab-dropdown-btn');
      if (tabPopup) {
        if (!tabPopup.contains(ev.target) && ev.target !== tabBtn) {
          tabPopup.remove();
        }
      }
    }, true);

    // Toggle settings popup click logic
    $('su-settings-toggle-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const popup = $('su-settings-popup');
      if (!popup) return;
      const willShow = popup.style.display === 'none';
      popup.style.display = willShow ? 'block' : 'none';
      if (willShow) {
        const rect = e.currentTarget.getBoundingClientRect();
        popup.style.position = 'fixed';
        popup.style.top = `${rect.bottom + 6}px`;
        popup.style.right = 'auto';
        popup.style.left = `${Math.max(8, Math.min(rect.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 8))}px`;
      }
    });

    // Toggle file search popup click logic
    $('su-file-search-toggle-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const popup = $('su-file-search-popup');
      if (!popup) return;
      const isHidden = popup.style.display === 'none';
      popup.style.display = isHidden ? 'block' : 'none';
      if (isHidden) {
        const input = $('su-search');
        if (input) {
          input.focus();
          input.select();
        }
      }
    });

    // Tab dropdown menu to show all tabs with their folder paths
    $('su-tab-dropdown-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = document.querySelector('.su-tab-dropdown-popup');
      if (existing) { existing.remove(); return; }
      
      const btn = $('su-tab-dropdown-btn');
      const popup = document.createElement('div');
      popup.className = 'su-tab-dropdown-popup';
      popup.style.cssText = 'position:absolute;top:100%;left:0;z-index:9999;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.12);padding:6px 0;min-width:260px;max-width:380px;font-size:12px;margin-top:4px;box-sizing:border-box;';
      
      if (!tabs || tabs.length === 0) {
        const emptyItem = document.createElement('div');
        emptyItem.style.cssText = 'padding:6px 14px;color:#94a3b8;font-style:italic;text-align:left;';
        emptyItem.textContent = '(无标签页)';
        popup.appendChild(emptyItem);
      } else {
        tabs.forEach(t => {
          const item = document.createElement('div');
          item.style.cssText = 'padding:6px 14px;cursor:pointer;transition:background 0.15s;text-align:left;display:flex;flex-direction:column;gap:2px;box-sizing:border-box;';
          
          const isActive = t.id === activeTabId;
          
          // Tab title/name
          const titleSpan = document.createElement('span');
          titleSpan.style.cssText = `font-weight:600;font-size:11px;color:${isActive ? '#3b82f6' : '#334155'};`;
          const fileCount = t.localFiles?.length || 0;
          titleSpan.textContent = (t.name || t.folderName || '未命名') + (fileCount ? ` (${fileCount}个文件)` : '');
          item.appendChild(titleSpan);
          
          // Tab associated folder path
          const pathSpan = document.createElement('span');
          pathSpan.style.cssText = 'font-size:10px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;width:100%;';
          pathSpan.textContent = t.folderPath || '(未关联文件夹)';
          pathSpan.title = t.folderPath || '';
          item.appendChild(pathSpan);
          
          if (isActive) {
            item.style.background = '#e8f0fe'; // Light blue highlight for active tab
          }
          
          item.addEventListener('mouseenter', () => { item.style.background = isActive ? '#d0e1fd' : '#f1f5f9'; });
          item.addEventListener('mouseleave', () => { item.style.background = isActive ? '#e8f0fe' : 'transparent'; });
          
          item.addEventListener('click', () => {
            popup.remove();
            switchTab(t.id);
          });
          popup.appendChild(item);
        });
      }
      
      btn.parentElement.appendChild(popup);
      
      const closePopup = (ev) => {
        if (!popup.contains(ev.target) && ev.target !== btn) {
          popup.remove();
          document.removeEventListener('click', closePopup, true);
        }
      };
      setTimeout(() => document.addEventListener('click', closePopup, true), 0);
    });

    // Local organize action buttons
    $('su-local-copy')?.addEventListener('click', () => workMode === 'local-dual' ? transferDualSelection('copy') : startLocalOrganize('copy'));
    $('su-local-move')?.addEventListener('click', () => workMode === 'local-dual' ? transferDualSelection('move') : startLocalOrganize('move'));

    // Local org settings toggles
    const dateSubCb = $('su-local-org-date-sub');
    const ruleSelect = $('su-local-org-subfolder-rule');
    const customInput = $('su-local-org-subfolder-custom');
    if (dateSubCb) {
      dateSubCb.addEventListener('change', e => {
        localOrgDateSub = e.target.checked;
        if (ruleSelect) ruleSelect.style.display = localOrgDateSub ? '' : 'none';
        if (customInput) customInput.style.display = (localOrgDateSub && subfolderRule === 'custom') ? '' : 'none';
      });
    }
    if (ruleSelect) {
      ruleSelect.addEventListener('change', e => {
        subfolderRule = e.target.value;
        if (customInput) customInput.style.display = subfolderRule === 'custom' ? '' : 'none';
      });
    }
    if (customInput) {
      customInput.addEventListener('input', e => { subfolderCustom = e.target.value; });
    }

    // ── Waste folder (废品箱) ──
    loadWasteFolder();
    loadDefaultTargetRoot();
    loadDefaultCloudRoot();
    const wasteDisplay = $('su-waste-folder-display');
    const wasteClearBtn = $('su-waste-folder-clear');
    function updateWasteFolderUI() {
      if (wasteDisplay) {
        if (wasteFolderPath) {
          const parts = wasteFolderPath.replace(/\\/g, '/').split('/').filter(Boolean);
          const short = parts.length > 1 ? '.../' + parts[parts.length - 1] : wasteFolderPath;
          wasteDisplay.textContent = short;
          wasteDisplay.title = wasteFolderPath;
        } else {
          wasteDisplay.textContent = '未设置（自动建 _废品）';
          wasteDisplay.title = '';
        }
      }
      if (wasteClearBtn) wasteClearBtn.style.display = wasteFolderPath ? '' : 'none';
    }
    updateWasteFolderUI();

    $('su-waste-folder-pick')?.addEventListener('click', async () => {
      const result = await window.bridge?.localFiles?.pickFolder?.();
      if (result) {
        wasteFolderPath = result;
        saveWasteFolder();
        updateWasteFolderUI();
      }
    });
    $('su-waste-folder-clear')?.addEventListener('click', () => {
      wasteFolderPath = '';
      saveWasteFolder();
      updateWasteFolderUI();
    });

    // ── Local Org Conflict Rule dropdown ──
    loadLocalOrgConflict();
    const conflictRuleSelect = $('su-local-org-conflict-rule');
    if (conflictRuleSelect) {
      conflictRuleSelect.value = localOrgConflictRule;
      conflictRuleSelect.addEventListener('change', e => {
        localOrgConflictRule = e.target.value;
        saveLocalOrgConflict();
      });
    }

    // ── Hover Magnify Toggle ──
    const hoverToggle = $('su-hover-magnify-toggle');
    if (hoverToggle) {
      const savedHover = localStorage.getItem('su-hover-magnify') === 'true';
      window.hoverMagnifyEnabled = savedHover;
      hoverToggle.checked = savedHover;
      hoverToggle.addEventListener('change', (e) => {
        window.hoverMagnifyEnabled = e.target.checked;
        localStorage.setItem('su-hover-magnify', e.target.checked);
      });
    }

    // ── 文件内容区空白处右键菜单 ──
    // 监听外层内容区，确保卡片下方的大块空白区域也可以命中。
    const fileArea = $('su-file-area');
    if (fileArea) {
      fileArea.addEventListener('contextmenu', (e) => {
        // 文件/文件夹卡片保留各自的右键菜单。
        if (e.target.closest('.su-file-card') || e.target.closest('.su-pagination-bar')) return;
        e.preventDefault();
        e.stopPropagation();

        const currentDiskPath = getCurrentSourceDiskPath();
        if (!currentDiskPath) return; // 未打开文件夹，或多源根目录无法确定创建位置。

        const currentName = currentDiskPath.replace(/\\/g, '/').split('/').pop() || '当前文件夹';
        const items = [
          { icon: '📁', label: '新建文件夹', action: () => promptCreateFolder(currentDiskPath, currentName) },
          { icon: '🗂️', label: '批量新建文件夹', action: () => promptCreateFolders(currentDiskPath, currentName) },
          { icon: '📂', label: '在 Finder 中打开', action: () => {
            if (window.bridge?.openPath) window.bridge.openPath(currentDiskPath);
          }}
        ];
        showLocalContextMenu(e.clientX, e.clientY, items);
      });
    }

    // ── Symmetric dual-pane workspace ──
    document.querySelectorAll('.su-multi-layout-btn').forEach(button => button.addEventListener('click', async () => {
      if (!button.dataset.layoutCount) return;
      let count = button.dataset.layoutCount;
      let columns;
      if (count === 'custom') {
        const value = await showPrompt('自定义窗口数量（2–12）：', String(dualLayoutCount));
        if (!value) return;
        count = Math.min(12, Math.max(2, parseInt(value, 10) || 2));
        const columnValue = await showPrompt('每行显示几列（1–4）：', String(Math.min(4, Math.ceil(Math.sqrt(count)))));
        if (!columnValue) return;
        columns = Math.min(4, Math.max(1, parseInt(columnValue, 10) || 2));
      } else {
        count = Number(count);
        columns = count === 2 ? 2 : (count === 6 ? 3 : (count === 8 ? 4 : 2));
      }
      ensureDualPaneCount(count, columns); saveDualPanes(); renderSymmetricDualWorkspace();
    }));
    $('su-multi-layout-reset')?.addEventListener('click', () => {
      dualPaneRatio = 0.5;
      if ([2, 4, 6, 8].includes(dualLayoutCount)) dualLayoutColumns = dualLayoutCount === 2 ? 2 : (dualLayoutCount === 6 ? 3 : (dualLayoutCount === 8 ? 4 : 2));
      dualColRatios = Array(dualLayoutColumns).fill(1 / dualLayoutColumns);
      const rows = Math.ceil(dualLayoutCount / dualLayoutColumns);
      dualRowRatios = Array(rows).fill(1 / rows);
      dualRowHeights = [];
      saveDualPanes();
      renderSymmetricDualWorkspace();
      if (typeof showToast === 'function') showToast(dualLayoutCount === 2 ? '已恢复左右平分' : '已恢复默认等宽等高布局', 'success');
    });
    $('su-multi-export-config')?.addEventListener('click', async () => {
      const result = await window.bridge?.localFiles?.exportWorkspaceConfig?.(JSON.stringify(buildDualWorkspaceConfig(), null, 2));
      if (result?.success) showToast('多窗口配置已导出', 'success');
      else if (!result?.canceled) alert('导出配置失败：' + (result?.error || '未知错误'));
    });
    $('su-multi-import-config')?.addEventListener('click', async () => {
      const result = await window.bridge?.localFiles?.importWorkspaceConfig?.();
      if (!result?.success) { if (!result?.canceled) alert('导入配置失败：' + (result?.error || '未知错误')); return; }
      try {
        const config = JSON.parse(result.content);
        if (!confirm('导入将替换当前宫格布局、标签页和常用路径，但不会移动或删除任何文件。确定继续？')) return;
        applyDualWorkspaceConfig(config);
        showToast('多窗口配置已导入', 'success');
      } catch (error) {
        alert('导入配置失败：' + error.message);
      }
    });
    $('su-dual-sidebar-toggle-btn')?.addEventListener('click', () => toggleDualSidebar());
    $('su-dual-sidebar-close-btn')?.addEventListener('click', () => toggleDualSidebar(false));
    document.querySelectorAll('[data-dual-transfer="copy"]').forEach(button => button.addEventListener('click', () => transferDualSelection('copy')));
    document.querySelectorAll('[data-dual-transfer="move"]').forEach(button => button.addEventListener('click', () => transferDualSelection('move')));
    document.querySelectorAll('[data-dual-transfer="clear-all"]').forEach(button => button.addEventListener('click', () => {
      if (!dualAssignments.size) return;
      dualAssignments.clear();
      updateDualTransferBar();
      renderSymmetricDualWorkspace();
      if (typeof showToast === 'function') showToast('已取消全部项目的分配', 'info');
    }));

    // Apply initial mode UI
    updateModeUI();
    if (workMode === 'local-dual') {
      renderSymmetricDualWorkspace();
      if (dualSidebarVisible) renderLocalFolderList();
    }
  }

  window.VideoKitGlobalHistory.register('sort-upload',{contexts:['media'],capture:()=>({localFiles,selectedIds,selectedFolderPaths,assignMap,recentSlotIds,localFolderPath,localFolderPaths,currentPage,pageSize,typeFilter,searchQuery,nameFilterMode,nameFilterQuery,slotSearchQuery,collapsedGroups,dateFilter,customStart,customEnd,customMonth,sortOrder,customDisplayOrderPaths,customFolderOrderPaths,cloudSubfolderEnabled,fileViewMode,currentTreePath,workMode,localTargetFolders,showArchivedLocalFolders,dualSidebarVisible,dualTargetRoot,dualTargetPath,dualPaneRatio,dualColRatios,dualRowRatios,dualRowHeights,dualPaneCounter,dualLayoutCount,dualLayoutColumns,activeDualTarget,dualPaneOrder,dualGlobalShortcuts,localTargetCounter,localOrgDateSub,subfolderRule,subfolderCustom,collapsedLocalGroups,localOrgConflictRule,wasteFolderPath,defaultTargetRoot,groupParents,tabs,activeTabId,tabCounter,defaultCloudRoot,defaultCloudRootName,defaultCloudRootLink,dualTargetItems,dualAssignments,dualPanes}),restore:s=>{localFiles=s.localFiles;selectedIds=s.selectedIds;selectedFolderPaths=s.selectedFolderPaths;assignMap=s.assignMap;recentSlotIds=s.recentSlotIds;localFolderPath=s.localFolderPath;localFolderPaths=s.localFolderPaths;currentPage=s.currentPage;pageSize=s.pageSize;typeFilter=s.typeFilter;searchQuery=s.searchQuery;nameFilterMode=s.nameFilterMode;nameFilterQuery=s.nameFilterQuery;slotSearchQuery=s.slotSearchQuery;collapsedGroups=s.collapsedGroups;dateFilter=s.dateFilter;customStart=s.customStart;customEnd=s.customEnd;customMonth=s.customMonth;sortOrder=s.sortOrder;customDisplayOrderPaths=s.customDisplayOrderPaths;customFolderOrderPaths=s.customFolderOrderPaths;cloudSubfolderEnabled=s.cloudSubfolderEnabled;fileViewMode=s.fileViewMode;currentTreePath=s.currentTreePath;workMode=s.workMode;localTargetFolders=s.localTargetFolders;showArchivedLocalFolders=s.showArchivedLocalFolders;dualSidebarVisible=s.dualSidebarVisible;dualTargetRoot=s.dualTargetRoot;dualTargetPath=s.dualTargetPath;dualPaneRatio=s.dualPaneRatio;dualColRatios=s.dualColRatios;dualRowRatios=s.dualRowRatios;dualRowHeights=s.dualRowHeights;dualPaneCounter=s.dualPaneCounter;dualLayoutCount=s.dualLayoutCount;dualLayoutColumns=s.dualLayoutColumns;activeDualTarget=s.activeDualTarget;dualPaneOrder=s.dualPaneOrder;dualGlobalShortcuts=s.dualGlobalShortcuts;localTargetCounter=s.localTargetCounter;localOrgDateSub=s.localOrgDateSub;subfolderRule=s.subfolderRule;subfolderCustom=s.subfolderCustom;collapsedLocalGroups=s.collapsedLocalGroups;localOrgConflictRule=s.localOrgConflictRule;wasteFolderPath=s.wasteFolderPath;defaultTargetRoot=s.defaultTargetRoot;groupParents=s.groupParents;tabs=s.tabs;activeTabId=s.activeTabId;tabCounter=s.tabCounter;defaultCloudRoot=s.defaultCloudRoot;defaultCloudRootName=s.defaultCloudRootName;defaultCloudRootLink=s.defaultCloudRootLink;dualTargetItems=s.dualTargetItems;dualAssignments.clear();for(const[k,v]of s.dualAssignments)dualAssignments.set(k,v);for(const k of Object.keys(dualPanes))delete dualPanes[k];Object.assign(dualPanes,s.dualPanes);},render:()=>{if(initialized){renderTabBar();renderLocalFolderList();if(workMode==='local-dual')renderSymmetricDualWorkspace();else renderFileGrid();}}});

  window.SortUpload = {
    init,
    open() {
      init();
      openSortUploadPanel();
    }
  };

  if ($('sort-upload-panel') && $('view-sort-upload')?.classList.contains('active')) {
    init();
  }
})();
