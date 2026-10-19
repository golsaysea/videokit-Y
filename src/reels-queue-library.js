/* Named queue snapshots: disk storage through Electron's local API. */
async function _queueRequest(action, payload) {
    const response = await apiFetch(`${API_BASE}/${action}`, payload === undefined ? undefined : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || '操作失败');
    return data;
}

function _queueDialog(title) {
    document.getElementById('rbt-queue-dialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'rbt-queue-dialog';
    dialog.style.cssText = 'width:min(860px,90vw);max-height:80vh;overflow:auto;background:#20232b;color:#eee;border:1px solid #505563;border-radius:12px;padding:24px;';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const close = document.createElement('button');
    close.textContent = '关闭';
    close.className = 'rbt-btn';
    close.style.float = 'right';
    close.onclick = () => dialog.close();
    dialog.append(close, heading);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
    return dialog;
}

function _queueBusy() {
    return window._reelsState?.isExporting ||
        ['rbt-align-all-btn', 'rbt-align-multikey-btn'].some(id => document.getElementById(id)?.disabled);
}

function _captureNamedQueue() {
    if (_queueBusy()) throw new Error('请等待当前导出或字幕对齐结束后再保存队列');
    _applyBatchTableChanges();
    const project = collectCurrentProjectState();
    _syncTasksToActiveTab();
    const table = window.reelsCaptureBatchTableState();
    if (!table.tabs.some(tab => tab.tasks.length)) throw new Error('没有任务可以保存');
    project.exportOpts.targetWidth = window._reelsState.targetWidth || 1080;
    project.exportOpts.targetHeight = window._reelsState.targetHeight || 1920;
    delete project.tasks;
    delete project.batchTable;
    return { ...table, version: '2.0', timestamp: new Date().toISOString(), project };
}

async function _saveNamedQueue() {
    const dialog = _queueDialog('保存队列');
    dialog.insertAdjacentHTML('beforeend', `<p>保存全部标签页的任务、字幕、音频关联和样式设置。原音视频保留在原位置，请勿移动或删除。</p>
        <label>队列名称 <input data-name maxlength="120" style="width:65%;padding:8px"></label>
        <p data-message role="status"></p><button data-save class="rbt-btn rbt-btn-primary">保存</button>`);
    const input = dialog.querySelector('[data-name]');
    input.value = `队列 ${new Date().toLocaleString()}`;
    input.focus(); input.select();
    dialog.querySelector('[data-save]').onclick = async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const name = input.value.trim();
            if (!name) throw new Error('请输入队列名称');
            const result = await _queueRequest('queue-library/save', { name, snapshot: _captureNamedQueue() });
            dialog.close();
            showToast(`已保存“${result.name}”：${result.counts.tasks} 个任务`, 'success');
        } catch (error) {
            dialog.querySelector('[data-message]').textContent = error.message;
        } finally { button.disabled = false; }
    };
}

async function _openQueueLibrary() {
    const dialog = _queueDialog('调用已保存队列');
    dialog.insertAdjacentHTML('beforeend', '<p>选择队列可恢复全部标签页、字幕及素材配置（右键或点击“📂 打开位置”可查看工程存储目录）。</p><p data-message role="status">正在读取…</p><div data-list></div>');
    const message = dialog.querySelector('[data-message]');
    try {
        const { queues } = await _queueRequest('queue-library/list');
        message.textContent = queues.length ? `共 ${queues.length} 个队列，按保存时间排列` : '还没有保存的队列，请先点击“保存队列”。';
        for (const entry of queues) {
            const row = document.createElement('section');
            row.style.cssText = 'padding:16px;margin-top:10px;border:1px solid #454b59;border-radius:8px;cursor:context-menu;';
            row.title = entry.filePath ? `右键打开存储位置: ${entry.filePath}` : '右键打开存储位置';
            const title = document.createElement('strong'); title.textContent = entry.name;
            const detail = document.createElement('p');
            const c = entry.counts;
            detail.textContent = `${new Date(entry.savedAt).toLocaleString()} · ${c.tabs} 个标签页 · ${c.tasks} 个任务 · ${c.audio} 个音频 · ${c.video} 个视频 · ${c.subtitles} 个字幕任务`;
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
            const load = document.createElement('button'); load.className = 'rbt-btn rbt-btn-primary'; load.textContent = '调用此队列';
            const revealBtn = document.createElement('button');
            revealBtn.className = 'rbt-btn';
            revealBtn.textContent = '📂 打开存储位置';
            const openQueueLocation = () => {
                const targetPath = entry.filePath || (window.electronAPI?.getDefaultProjectDir ? window.electronAPI.getDefaultProjectDir() : '');
                if (targetPath && window.electronAPI?.showItemInFolder) {
                    window.electronAPI.showItemInFolder(targetPath);
                }
            };
            revealBtn.onclick = (e) => {
                e.stopPropagation();
                openQueueLocation();
            };
            row.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                openQueueLocation();
            };
            load.onclick = async () => {
                load.disabled = true;
                try {
                    if (_queueBusy()) throw new Error('请等待当前导出或字幕对齐结束');
                    if (!confirm(`调用“${entry.name}”将替换当前任务表。是否继续？\n当前非空队列会先自动保存为恢复备份。`)) return;
                    // Persist the current work before replacing it, including uncommitted table edits.
                    _applyBatchTableChanges();
                    _syncTasksToActiveTab();
                    if (_batchTableState.tabs.some(tab => tab.tasks.length)) {
                        await _queueRequest('queue-library/save', { name: `调用前备份 ${new Date().toLocaleString()}`, snapshot: _captureNamedQueue() });
                    }
                    const { snapshot } = await _queueRequest('queue-library/load', { id: entry.id });
                    if (_queueBusy()) throw new Error('任务仍在运行，请稍后调用');
                    const tasks = snapshot.tabs.flatMap((tab, tabOrder) => tab.tasks.map((task, taskOrder) => ({
                        ...task, _batchProjection: true, _batchTabId: tab.id, _batchTabName: tab.name,
                        _batchTabOrder: tabOrder, _batchTaskOrder: taskOrder,
                    })));
                    const batchTable = { ...snapshot, appliedTabIds: snapshot.tabs.map(tab => tab.id), selectedRows: [] };
                    // Use unified installed projectDir before rendering the restored queue.
                    _batchTableState.projectDir = window.electronAPI?.getDefaultProjectDir?.() || '';
                    _batchTableState.projectName = 'UntitledProject.json';
                    applyRestoredProject({ ...snapshot.project, tasks, batchTable, selectedIdx: -1 });
                    _batchAutoSave({ skipSync: true });
                    window.ReelsProject?.autoSaveProject(collectCurrentProjectState());
                    dialog.close();
                    showToast(`已调用“${entry.name}”`, 'success');
                } catch (error) { message.textContent = `调用失败：${error.message}`; }
                finally { load.disabled = false; }
            };
            btnRow.append(load, revealBtn);
            row.append(title, detail, btnRow);
            dialog.querySelector('[data-list]').append(row);
        }
    } catch (error) { message.textContent = `读取失败：${error.message}`; }
}

async function _openQueueTranscriptionSettings() {
    const dialog = _queueDialog('云端转录 API');
    dialog.insertAdjacentHTML('beforeend', `<p>选择字幕识别的首选服务。Groq 使用 Whisper Large V3 Turbo；密钥保存在本机，失败时沿用已有备用服务设置。</p>
        <label>首选服务 <select data-provider><option value="groq">Groq</option><option value="gladia">Gladia</option><option value="deepgram">Deepgram</option></select></label>
        <p data-status role="status">正在加载…</p>
        <label>API Key（每行一个）<textarea data-keys rows="5" autocomplete="off" spellcheck="false" style="display:block;width:100%;margin:12px 0;box-sizing:border-box"></textarea></label>
        <button data-save class="rbt-btn rbt-btn-primary" disabled>保存并设为首选</button>`);
    const provider = dialog.querySelector('[data-provider]');
    const keys = dialog.querySelector('[data-keys]');
    const status = dialog.querySelector('[data-status]');
    const button = dialog.querySelector('[data-save]');
    try {
        const config = await _queueRequest('settings/transcription-providers');
        const drafts = Object.fromEntries(['groq', 'gladia', 'deepgram'].map(name => [name, (config.providers?.[name]?.editableKeys || []).join('\n')]));
        provider.value = config.primary || 'groq';
        let previous = provider.value;
        const display = () => { keys.value = drafts[provider.value]; status.textContent = `当前首选：${config.primary}。已有识别缓存会复用；需要重新请求时勾选“强制重新转录”。`; };
        display(); button.disabled = false;
        provider.onchange = () => { drafts[previous] = keys.value; previous = provider.value; display(); };
        button.onclick = async () => {
            button.disabled = true;
            try {
                const pool = keys.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                if (!pool.length) throw new Error('请填写所选服务的 API Key');
                await _queueRequest('settings/transcription-providers', { primary: provider.value, [`${provider.value}_keys`]: pool });
                await loadSettings();
                dialog.close(); showToast(`已启用 ${provider.value} 转录`, 'success');
            } catch (error) { status.textContent = error.message; }
            finally { button.disabled = false; }
        };
    } catch (error) { status.textContent = `设置加载失败：${error.message}`; }
}

