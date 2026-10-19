// ==================== 一键配音字幕 ====================

// 任务数据
let vwTasks = [];
let vwRetryAllRunning = false;
let vwWorkflowRunning = false;
let vwWorkflowPauseRequested = false;
let vwWorkflowBatchOutputDir = '';
const VW_RESUME_STORAGE_KEY = 'videokit_voiceover_resume_v1';

// 从字幕服务返回的错误中提取识别文本。TEXT_MISMATCH 会把实际听写结果放在 JSON 中，
// 单独保存后，用户无需在一长串错误信息里查找它。
function vwGetRecognizedTextFromError(errorMessage) {
    const message = String(errorMessage || '');
    const match = message.match(/\{\s*"code"\s*:\s*"(?:TEXT_MISMATCH|AUTO_SOURCE_MATCH_NOT_FOUND)"[\s\S]*\}/);
    if (!match) return '';
    try {
        return String(JSON.parse(match[0]).recognized_text || '').trim();
    } catch (_) {
        return '';
    }
}

function saveVWResumeState() {
    try {
        localStorage.setItem(VW_RESUME_STORAGE_KEY, JSON.stringify({
            version: 1,
            savedAt: Date.now(),
            batchOutputDir: vwWorkflowBatchOutputDir || window._vwLastOutputFolder || '',
            tasks: vwTasks
        }));
    } catch (error) {
        console.warn('[一键配音] 保存续跑状态失败:', error);
    }
}

function restoreVWResumeState() {
    try {
        const saved = JSON.parse(localStorage.getItem(VW_RESUME_STORAGE_KEY) || 'null');
        if (!saved || !Array.isArray(saved.tasks) || saved.tasks.length === 0) return false;
        vwTasks = saved.tasks.map((task, index) => ({
            ...task,
            id: Number.isInteger(task.id) ? task.id : index,
            // 应用被关闭时仍处于 generating 的请求无法确认结果，恢复为失败以便续跑。
            status: task.status === 'generating' ? 'error' : (task.status || 'pending'),
            error: task.status === 'generating'
                ? '上次运行被中断，等待继续'
                : (task.error || null)
        }));
        vwWorkflowBatchOutputDir = String(saved.batchOutputDir || '');
        window._vwLastOutputFolder = vwWorkflowBatchOutputDir;
        return true;
    } catch (error) {
        console.warn('[一键配音] 恢复续跑状态失败:', error);
        return false;
    }
}

function playVWCompletionSound() {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        const ctx = new AudioContextClass();
        const now = ctx.currentTime;
        [659.25, 783.99, 987.77].forEach((frequency, index) => {
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            const start = now + index * 0.13;
            oscillator.type = 'sine';
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.16, start + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            oscillator.start(start);
            oscillator.stop(start + 0.23);
        });
        setTimeout(() => ctx.close().catch(() => {}), 900);
    } catch (error) {
        console.warn('[一键配音] 播放完成提示音失败:', error);
    }
}

function vwUpdateFolderModeUI() {
    const mode = document.getElementById('vw-folder-mode')?.value || 'column';
    const countWrap = document.getElementById('vw-folder-count-wrap');
    if (countWrap) countWrap.style.display = mode === 'count' ? 'inline-flex' : 'none';
}

function vwLooksLikeBgmPath(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    return /[\\/]/.test(text) || /\.(mp3|wav|m4a|aac|flac|ogg|wma)$/i.test(text);
}

function vwApplyFolderGrouping(rows) {
    const mode = document.getElementById('vw-folder-mode')?.value || 'column';
    const groupSize = Math.max(
        1,
        Math.min(999, parseInt(document.getElementById('vw-folder-count')?.value || '6', 10) || 6)
    );
    return rows.map((row, index) => {
        let folderName = '';
        if (mode === 'column') {
            folderName = String(row.folderName || '').trim();
        } else if (mode === 'count') {
            folderName = `第${String(Math.floor(index / groupSize) + 1).padStart(2, '0')}组`;
        }
        return { ...row, folderName };
    });
}

// 刷新音色列表
async function refreshVWVoices() {
    const select = document.getElementById('vw-default-voice');
    if (!select) return;

    try {
        const response = await apiFetch(`${API_BASE}/elevenlabs/voices`);
        const data = await response.json();

        if (data.voices && data.voices.length > 0) {
            select.innerHTML = data.voices.map(v => {
                const shortId = v.voice_id ? escapeHtml(v.voice_id.slice(0, 8)) + '...' : '';
                const catLabel = (typeof _voiceCategoryLabel === 'function')
                    ? _voiceCategoryLabel(v.category)
                    : (v.category === 'premade' ? '🆓 [免费]' : '💰 [付费]');
                const cleanName = String(v.name || '').replace(/^\[[^\]]+\]\s*/, '');
                return `<option value="${escapeHtml(v.voice_id)}" data-category="${escapeHtml(v.category || 'premade')}" data-full-voice-id="${escapeHtml(v.voice_id)}">${escapeHtml(catLabel)} ${escapeHtml(cleanName)} (${shortId})</option>`;
            }).join('');

            // 设置或刷新 Voice ID 提示行
            _setupVWVoiceTip(select);
        } else if (data.error) {
            select.innerHTML = `<option value="">错误: ${escapeHtml(data.error)}</option>`;
            showToast(`获取音色失败: ${data.error}`, 'error');
        } else {
            select.innerHTML = '<option value="">[未找到音色，请检查网络或Key]</option>';
        }
    } catch (error) {
        console.error('获取音色失败:', error);
        select.innerHTML = '<option value="">[网络或后端错误]</option>';
        showToast('获取音色异常，后端可能未响应', 'error');
    }
}

/** 在一键配音音色下拉框下方显示完整 Voice ID + 免费/付费标签 */
function _setupVWVoiceTip(select) {
    let tip = document.getElementById('vw-voice-id-tip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'vw-voice-id-tip';
        tip.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 4px; font-family: monospace; cursor: pointer; padding: 2px 8px; background: rgba(255,255,255,0.03); border-radius: 4px; display: none; transition: all 0.2s;';
        tip.title = '点击复制 Voice ID';
        tip.onclick = () => {
            const vid = select.value;
            if (vid) {
                navigator.clipboard.writeText(vid).then(() => showToast(`已复制 Voice ID: ${vid}`, 'success'));
            }
        };
        // 插入到 select 的父容器后面
        select.parentNode.appendChild(tip);
    }

    const updateTip = () => {
        const opt = select.options[select.selectedIndex];
        if (opt && opt.value) {
            const cat = opt.dataset?.category || 'premade';
            const isFree = cat === 'premade';
            const freeTag = isFree
                ? '<span style="color:#00d9a5;font-size:10px;margin-left:6px;">✅ 免费API可用</span>'
                : '<span style="color:#ff9f43;font-size:10px;margin-left:6px;">💳 需付费订阅</span>';
            tip.innerHTML = `Voice ID: <span style="color:var(--text-primary);">${escapeHtml(opt.value)}</span>${freeTag}`;
            tip.style.display = 'block';
        } else {
            tip.style.display = 'none';
        }
    };

    // Remove old listener to avoid duplicates
    select.removeEventListener('change', select._vwTipHandler);
    select._vwTipHandler = updateTip;
    select.addEventListener('change', updateTip);
    setTimeout(updateTip, 100);
}

// 从剪贴板粘贴数据
async function vwPasteFromClipboard() {
    try {
        const clipboardItems = await navigator.clipboard.read();
        let rows = [];

        // 读取当前全选复选框状态作为新任务默认值
        const audioSubtitleOnly = document.getElementById('vw-audio-subtitle-only')?.checked ?? false;
        const defaultSplit = audioSubtitleOnly ? false : (document.getElementById('vw-select-all-split')?.checked ?? true);
        const defaultMp4 = audioSubtitleOnly ? false : (document.getElementById('vw-select-all-mp4')?.checked ?? false);

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
                    // 把 <br> 标签替换成换行符
                    let clone = cell.cloneNode(true);
                    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                    // 把 <p> 和 <div> 也替换成换行
                    clone.querySelectorAll('p, div').forEach(el => {
                        el.insertAdjacentText('beforebegin', '\n');
                    });
                    return clone.textContent.trim();
                };

                tableRows.forEach(tr => {
                    const cells = tr.querySelectorAll('td, th');
                    if (cells.length >= 1) {
                        const ttsText = getCellTextWithBreaks(cells[0]);
                        let subtitleText = cells.length >= 2 ? getCellTextWithBreaks(cells[1]) : ttsText;
                        if (!subtitleText) subtitleText = ttsText; // 如果第二列为空白，直接使用第一列文案

                        const voiceId = cells[2]?.textContent.trim() || '';
                        let bgmPath = cells[3]?.textContent.trim() || '';
                        let folderName = cells[4]?.textContent.trim() || '';
                        // 没有配乐列时，允许第4列直接作为文件夹名。
                        if (!folderName && bgmPath && !vwLooksLikeBgmPath(bgmPath)) {
                            folderName = bgmPath;
                            bgmPath = '';
                        }
                        if (ttsText) {
                            rows.push({ ttsText, subtitleText, voiceId, bgmPath, folderName, audioSubtitleOnly, split: defaultSplit, exportMp4: defaultMp4 });
                        }
                    }
                });
            }

            // 如果 HTML 没数据，尝试纯文本
            if (rows.length === 0 && item.types.includes('text/plain')) {
                const blob = await item.getType('text/plain');
                const text = await blob.text();
                const lines = text.split('\n').filter(l => l.trim());

                lines.forEach(line => {
                    const parts = line.split('\t');
                    if (parts.length >= 1) {
                        const ttsText = parts[0]?.trim() || '';
                        let subtitleText = parts.length >= 2 ? (parts[1]?.trim() || '') : ttsText;
                        if (!subtitleText) subtitleText = ttsText; // 如果第二列为空白，直接使用第一列文案
                        
                        // 只在有真实内容时压入
                        if (ttsText) {
                            let bgmPath = parts[3]?.trim() || '';
                            let folderName = parts[4]?.trim() || '';
                            if (!folderName && bgmPath && !vwLooksLikeBgmPath(bgmPath)) {
                                folderName = bgmPath;
                                bgmPath = '';
                            }
                            rows.push({
                                ttsText: ttsText,
                                subtitleText: subtitleText,
                                voiceId: parts[2]?.trim() || '',
                                bgmPath,
                                folderName,
                                audioSubtitleOnly,
                                split: defaultSplit,
                                exportMp4: defaultMp4
                            });
                        }
                    }
                });
            }
        }

        if (rows.length === 0) {
            showToast('未识别到有效数据', 'warning');
            return;
        }

        rows = vwApplyFolderGrouping(rows);
        vwTasks = rows.map((row, idx) => ({
            id: idx,
            ...row,
            selected: false,
            bgmPath: row.bgmPath || '',
            status: 'pending',
            error: null,
            audioPath: null,
            srtPath: null,
            subtitleTxtPath: null,
            mp4Path: null,
            segments: null,
            recognizedText: '',
            outputGroupName: null
        }));
        // 新粘贴的数据属于新批次；只有同一批任务暂停后继续时才复用输出目录。
        vwWorkflowBatchOutputDir = '';
        window._vwLastOutputFolder = '';

        renderVWTasks();
        updateVWTaskCount();
        resetVWWorkflowUI(true);
        showToast(`已添加 ${vwTasks.length} 条任务`, 'success');

    } catch (error) {
        showToast('粘贴失败: ' + error.message, 'error');
    }
}

// 渲染任务列表
function renderVWTasks() {
    const container = document.getElementById('vw-task-list');
    if (!container) return;

    if (vwTasks.length === 0) {
        container.innerHTML = '<p class="hint" style="text-align: center;">请从表格粘贴数据...</p>';
        return;
    }

    container.innerHTML = vwTasks.map((task, idx) => `
        <div class="vw-task-card" data-id="${task.id}" style="background: var(--bg-secondary); border-radius: 6px; padding: 10px; margin-bottom: 8px; border-left: 3px solid ${getStatusColor(task.status)};">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                <span style="font-size: 11px; color: var(--text-muted);">#${idx + 1}</span>
                <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; user-select: none;" title="用于批量设置配乐">
                    <input type="checkbox" class="vw-row-checkbox" data-id="${task.id}" ${task.selected ? 'checked' : ''} onchange="vwToggleRowSelect(${task.id}, this.checked)" style="cursor: pointer;">
                    <span>选中</span>
                </label>
                <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; user-select: none;" title="拆分后不能导出黑屏MP4">
                    <input type="checkbox" class="vw-split-checkbox" data-id="${task.id}" ${task.split ? 'checked' : ''} onchange="vwToggleSplit(${task.id}, this.checked)" style="cursor: pointer;">
                    <span>拆分</span>
                </label>
                <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; user-select: none;" title="导出黑屏双声道MP4（会自动取消拆分）">
                    <input type="checkbox" class="vw-mp4-checkbox" data-id="${task.id}" ${task.exportMp4 ? 'checked' : ''} onchange="vwToggleMp4(${task.id}, this.checked)" style="cursor: pointer;">
                    <span>黑屏MP4</span>
                </label>
                <span class="vw-task-status" style="margin-left: auto; font-size: 11px; padding: 2px 6px; border-radius: 3px; background: ${getStatusBg(task.status)}; color: ${getStatusColor(task.status)};">
                    ${getStatusText(task.status)}
                </span>
            </div>
            <div style="font-size: 12px; color: var(--text-primary); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(task.ttsText)}">
                <strong>[列1] TTS配音:</strong> ${escapeHtml(task.ttsText.substring(0, 80))}${task.ttsText.length > 80 ? '...' : ''}
            </div>
            <div style="font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(task.subtitleText)}">
                <strong>[列2] AI字幕原文:</strong> ${escapeHtml(task.subtitleText.substring(0, 60).replace(/\n/g, ' | '))}${task.subtitleText.length > 60 ? '...' : ''}
            </div>
            ${task.voiceId ? `<div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">音色: ${escapeHtml(task.voiceId)}</div>` : ''}
            ${task.folderName ? `<div style="font-size:10px;color:#74c0fc;margin-top:2px;">📁 账号: ${escapeHtml(task.folderName)}</div>` : ''}
            <div style="display:flex;align-items:center;gap:6px;margin-top:4px;font-size:10px;color:var(--text-muted);">
                <span style="min-width:30px;">配乐:</span>
                <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(task.bgmPath || '')}">
                    ${task.bgmPath ? escapeHtml(vwGetFileName(task.bgmPath)) : '未设置'}
                </span>
                <button class="btn btn-secondary" style="padding:1px 6px;font-size:10px;" onclick="vwPickTaskBgm(${task.id})">选择</button>
                ${task.bgmPath ? `<button class="btn btn-secondary" style="padding:1px 6px;font-size:10px;" onclick="vwClearTaskBgm(${task.id})">清空</button>` : ''}
            </div>
            ${task.error ? `<div style="font-size: 10px; color: #ff6b6b; margin-top: 4px;">❌ ${escapeHtml(task.error)}</div>` : ''}
            ${task.recognizedText ? `<div style="font-size: 10px; color: #74c0fc; margin-top: 4px; white-space: pre-wrap; word-break: break-word;"><strong>🎙️ 识别结果：</strong>${escapeHtml(task.recognizedText)}</div>` : ''}
            <div style="margin-top:6px;">
                <button class="btn btn-secondary" onclick="vwEditAndRerunTask(${task.id})" style="padding:3px 9px;font-size:11px;">✏️ 编辑并重新执行</button>
            </div>
            ${task.status === 'partial' ? `<button class="btn btn-primary" onclick="retryVWSubtitles(${task.id})" style="padding:3px 9px;font-size:11px;margin-top:6px;">🔄 只重新生成字幕</button><span style="font-size:10px;color:#51cf66;margin-left:7px;">配音MP3已保留，不会重新配音</span>` : ''}
            ${task.mp4Path ? `<div style="font-size: 10px; color: #51cf66; margin-top: 4px;">🎬 MP4: ${escapeHtml(task.mp4Path)}</div>` : ''}
            ${task.segments ? `<div style="font-size: 10px; color: #51cf66; margin-top: 4px;">✅ ${task.segments.length} 个片段</div>` : ''}
        </div>
    `).join('');
    updateSelectAllState();
    const retryAllBtn = document.getElementById('vw-retry-all-subtitles-btn');
    if (retryAllBtn) {
        const retryableCount = vwTasks.filter(task =>
            task.status === 'partial' && task.audioPath && task.outputFolder && task.taskPrefix
        ).length;
        retryAllBtn.disabled = vwRetryAllRunning || retryableCount === 0;
        retryAllBtn.textContent = vwRetryAllRunning
            ? '⏳ 正在重试失败字幕...'
            : `🔄 重试所有失败字幕${retryableCount ? ` (${retryableCount})` : ''}`;
    }
    saveVWResumeState();
}

function getStatusColor(status) {
    const colors = {
        pending: '#868e96',
        generating: '#ffd43b',
        splitting: '#74c0fc',
        aligning: '#b197fc',
        done: '#51cf66',
        partial: '#ff9f43',
        error: '#ff6b6b'
    };
    return colors[status] || colors.pending;
}

function getStatusBg(status) {
    return getStatusColor(status) + '22';
}

function getStatusText(status) {
    const texts = {
        pending: '待处理',
        generating: '生成音频...',
        splitting: '智能拆分...',
        aligning: '对齐字幕...',
        done: '完成',
        partial: '配音成功 · 字幕失败',
        error: '失败'
    };
    return texts[status] || '未知';
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function vwGetFileName(filePath) {
    if (!filePath) return '';
    return String(filePath).split(/[\\/]/).pop() || String(filePath);
}

function vwBuildBatchFolderName(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d}_${hh}${mm}_一键配音`;
}

async function vwResolveOutputBaseDir(rawOutputDir) {
    const trimmed = String(rawOutputDir || '').trim();
    if (trimmed) return trimmed.replace(/[\\/]+$/, '') || trimmed;
    if (window.electronAPI && window.electronAPI.getDownloadsPath) {
        try {
            const downloads = await window.electronAPI.getDownloadsPath();
            if (downloads) return String(downloads).replace(/[\\/]+$/, '') || String(downloads);
        } catch (_) { }
    }
    return '~/Downloads';
}

async function vwCreateBatchOutputDir(rawOutputDir) {
    const baseDir = await vwResolveOutputBaseDir(rawOutputDir);
    const sep = baseDir.includes('\\') ? '\\' : '/';
    return `${baseDir}${sep}${vwBuildBatchFolderName()}`;
}

function vwPickAudioFilePath() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.mp3,.wav,.m4a,.aac,.flac,.ogg';
        input.onchange = () => {
            const f = input.files && input.files[0];
            if (!f) return resolve(null);
            const pickedPath = f.path || '';
            if (!pickedPath) {
                showToast('无法读取本地文件路径，请在 Electron 桌面版中使用此功能', 'warning');
                return resolve(null);
            }
            resolve(pickedPath || null);
        };
        input.click();
    });
}

async function vwPickTaskBgm(id) {
    const task = vwTasks.find(t => t.id === id);
    if (!task) return;
    const picked = await vwPickAudioFilePath();
    if (!picked) return;
    task.bgmPath = picked;
    renderVWTasks();
    updateVWTaskCount();
}

function vwClearTaskBgm(id) {
    const task = vwTasks.find(t => t.id === id);
    if (!task) return;
    task.bgmPath = '';
    renderVWTasks();
    updateVWTaskCount();
}

function vwToggleRowSelect(id, checked) {
    const task = vwTasks.find(t => t.id === id);
    if (!task) return;
    task.selected = !!checked;
    updateSelectAllState();
    updateVWTaskCount();
}

function vwToggleAllRows() {
    const checked = document.getElementById('vw-select-all-rows')?.checked || false;
    vwTasks.forEach(t => { t.selected = checked; });
    renderVWTasks();
    updateVWTaskCount();
}

async function vwApplyBgmToSelected() {
    const selected = vwTasks.filter(t => t.selected);
    if (selected.length === 0) {
        showToast('请先勾选要批量设置的行', 'warning');
        return;
    }
    const picked = await vwPickAudioFilePath();
    if (!picked) return;
    selected.forEach(t => { t.bgmPath = picked; });
    renderVWTasks();
    updateVWTaskCount();
    showToast(`已为 ${selected.length} 条任务设置配乐`, 'success');
}

function vwClearBgmForSelected() {
    const selected = vwTasks.filter(t => t.selected);
    if (selected.length === 0) {
        showToast('请先勾选要清空的行', 'warning');
        return;
    }
    selected.forEach(t => { t.bgmPath = ''; });
    renderVWTasks();
    updateVWTaskCount();
    showToast(`已清空 ${selected.length} 条任务的配乐`, 'success');
}

// 切换单个任务的拆分状态
function vwToggleSplit(id, checked) {
    const task = vwTasks.find(t => t.id === id);
    if (task) {
        // 如果传入了 checked 参数，使用它；否则切换
        task.split = checked !== undefined ? checked : !task.split;
        // 如果勾选拆分，自动取消黑屏MP4
        if (task.split) {
            task.exportMp4 = false;
            const onlyCb = document.getElementById('vw-audio-subtitle-only');
            if (onlyCb) onlyCb.checked = false;
        }
        renderVWTasks();
        updateVWTaskCount();
        updateSelectAllState();  // 更新全选状态
    }
}

// 切换单个任务的黑屏MP4状态
function vwToggleMp4(id, checked) {
    const task = vwTasks.find(t => t.id === id);
    if (task) {
        // 如果传入了 checked 参数，使用它；否则切换
        const newValue = checked !== undefined ? checked : !task.exportMp4;

        if (newValue) {
            // 如果勾选黑屏MP4，自动取消拆分
            task.split = false;
            const onlyCb = document.getElementById('vw-audio-subtitle-only');
            if (onlyCb) onlyCb.checked = false;
        }
        task.exportMp4 = newValue;

        renderVWTasks();  // 重新渲染以更新UI
        updateVWTaskCount();
        updateSelectAllState();  // 更新全选状态
    }
}

// 全选/取消拆分
function vwToggleAllSplit() {
    const checked = document.getElementById('vw-select-all-split').checked;
    vwTasks.forEach(t => {
        t.split = checked;
        if (checked) t.exportMp4 = false;  // 互斥：拆分时取消黑屏MP4
    });
    // 如果勾选了拆分，自动取消全选黑屏MP4
    if (checked) {
        document.getElementById('vw-select-all-mp4').checked = false;
        const onlyCb = document.getElementById('vw-audio-subtitle-only');
        if (onlyCb) onlyCb.checked = false;
    }
    renderVWTasks();
    updateVWTaskCount();
}

// 全选/取消黑屏MP4
function vwToggleAllMp4() {
    const checked = document.getElementById('vw-select-all-mp4').checked;

    // 如果要勾选黑屏MP4，先取消全选拆分
    if (checked) {
        document.getElementById('vw-select-all-split').checked = false;
        const onlyCb = document.getElementById('vw-audio-subtitle-only');
        if (onlyCb) onlyCb.checked = false;
        vwTasks.forEach(t => {
            t.split = false;
            t.exportMp4 = true;
        });
    } else {
        vwTasks.forEach(t => {
            t.exportMp4 = false;
        });
    }
    renderVWTasks();
    updateVWTaskCount();
}

// 仅生成完整音频和字幕：统一关闭拆分、MP4 和 FCPXML。
function vwToggleAudioSubtitleOnly() {
    const checked = document.getElementById('vw-audio-subtitle-only')?.checked ?? false;
    vwTasks.forEach(task => { task.audioSubtitleOnly = checked; });
    if (!checked) {
        renderVWTasks();
        return;
    }

    const splitCb = document.getElementById('vw-select-all-split');
    const mp4Cb = document.getElementById('vw-select-all-mp4');
    const fcpxmlCb = document.getElementById('vw-export-fcpxml');
    if (splitCb) splitCb.checked = false;
    if (mp4Cb) mp4Cb.checked = false;
    if (fcpxmlCb) fcpxmlCb.checked = false;

    vwTasks.forEach(task => {
        task.split = false;
        task.exportMp4 = false;
    });
    renderVWTasks();
    updateVWTaskCount();
    showToast('已切换为仅音频+字幕：只生成 MP3 和 SRT', 'success');
}

// 更新全选复选框状态（根据当前任务状态）
function updateSelectAllState() {
    const allSplit = vwTasks.length > 0 && vwTasks.every(t => t.split);
    const noneSplit = vwTasks.every(t => !t.split);
    const allMp4 = vwTasks.length > 0 && vwTasks.every(t => t.exportMp4);
    const noneMp4 = vwTasks.every(t => !t.exportMp4);
    const allRows = vwTasks.length > 0 && vwTasks.every(t => t.selected);
    const noneRows = vwTasks.every(t => !t.selected);

    const splitCb = document.getElementById('vw-select-all-split');
    const mp4Cb = document.getElementById('vw-select-all-mp4');
    const rowCb = document.getElementById('vw-select-all-rows');

    if (splitCb) {
        splitCb.checked = allSplit;
        splitCb.indeterminate = !allSplit && !noneSplit;
    }
    if (mp4Cb) {
        mp4Cb.checked = allMp4;
        mp4Cb.indeterminate = !allMp4 && !noneMp4;
    }
    if (rowCb) {
        rowCb.checked = allRows;
        rowCb.indeterminate = !allRows && !noneRows;
    }
}

// 反选拆分
function vwInvertSplit() {
    vwTasks.forEach(t => {
        t.split = !t.split;
        if (t.split) t.exportMp4 = false;
    });
    renderVWTasks();
    updateVWTaskCount();
}

// 清空任务
function vwClearAll() {
    if (vwWorkflowRunning || vwRetryAllRunning) {
        showToast('任务仍在执行，请先暂停并等待当前请求结束后再清空', 'warning');
        return;
    }

    vwTasks = [];
    vwWorkflowBatchOutputDir = '';
    vwWorkflowPauseRequested = false;
    window._vwLastOutputFolder = '';
    try {
        localStorage.removeItem(VW_RESUME_STORAGE_KEY);
    } catch (error) {
        console.warn('[一键配音] 清除续跑状态失败:', error);
    }
    renderVWTasks();
    updateVWTaskCount();
    updateSelectAllState();
    resetVWWorkflowUI(false);
    showToast('已清空一键配音字幕任务', 'info');
}

// 将执行区恢复到尚未开始的状态，避免新批次或清空后残留上一次的进度。
function resetVWWorkflowUI(hasTasks = vwTasks.length > 0) {
    const startBtn = document.getElementById('vw-start-btn');
    const pauseBtn = document.getElementById('vw-pause-btn');
    const restartAllBtn = document.getElementById('vw-restart-all-btn');
    const retryAllBtn = document.getElementById('vw-retry-all-subtitles-btn');
    const progressEl = document.getElementById('vw-progress');
    const progressTextEl = document.getElementById('vw-progress-text');
    const progressPercentEl = document.getElementById('vw-progress-percent');
    const progressBarEl = document.getElementById('vw-progress-bar');

    if (startBtn) {
        startBtn.disabled = !hasTasks;
        startBtn.textContent = '🚀 开始生成配音字幕';
    }
    if (pauseBtn) {
        pauseBtn.disabled = true;
        pauseBtn.textContent = '⏸ 暂停';
    }
    if (restartAllBtn) restartAllBtn.disabled = !hasTasks;
    if (retryAllBtn) {
        retryAllBtn.disabled = true;
        retryAllBtn.textContent = '🔄 重试所有失败字幕';
    }
    if (progressEl) progressEl.style.display = 'none';
    if (progressTextEl) progressTextEl.textContent = '准备中...';
    if (progressPercentEl) progressPercentEl.textContent = '0%';
    if (progressBarEl) progressBarEl.style.width = '0%';
}

// 更新任务计数
function updateVWTaskCount() {
    const countEl = document.getElementById('vw-task-count');
    if (countEl) {
        const splitCount = vwTasks.filter(t => t.split).length;
        const mp4Count = vwTasks.filter(t => t.exportMp4).length;
        const selectedCount = vwTasks.filter(t => t.selected).length;
        const bgmCount = vwTasks.filter(t => !!t.bgmPath).length;
        const folderCount = new Set(vwTasks.map(t => String(t.folderName || '').trim()).filter(Boolean)).size;
        const alignedCount = vwTasks.filter(t => t.status === 'done' && t.srtPath).length;
        const mismatchCount = vwTasks.filter(t => Boolean(t.recognizedText)).length;
        const pendingRecognitionCount = vwTasks.filter(t => !t.recognizedText && !t.srtPath && ['pending', 'generating', 'aligning'].includes(t.status)).length;
        countEl.textContent = `共 ${vwTasks.length} 条，${folderCount} 个账号文件夹，已选 ${selectedCount} 条，${splitCount} 条拆分，${mp4Count} 条黑屏MP4，${bgmCount} 条配乐；字幕：已对齐 ${alignedCount}，文本不匹配 ${mismatchCount}，待识别 ${pendingRecognitionCount}`;
    }
}

// 更新进度
function updateVWProgress(current, total, text) {
    const progressEl = document.getElementById('vw-progress');
    const textEl = document.getElementById('vw-progress-text');
    const percentEl = document.getElementById('vw-progress-percent');
    const barEl = document.getElementById('vw-progress-bar');

    progressEl.style.display = 'block';
    textEl.textContent = text;
    const percent = Math.round((current / total) * 100);
    percentEl.textContent = percent + '%';
    barEl.style.width = percent + '%';
}

// 开始工作流
function pauseVoiceoverWorkflow() {
    if (!vwWorkflowRunning) return;
    vwWorkflowPauseRequested = true;
    const pauseBtn = document.getElementById('vw-pause-btn');
    if (pauseBtn) {
        pauseBtn.disabled = true;
        pauseBtn.textContent = '⏳ 正在安全暂停...';
    }
    const textEl = document.getElementById('vw-progress-text');
    if (textEl) textEl.textContent = '正在安全暂停：已发出的任务完成后停止领取新任务';
    showToast('正在安全暂停，当前已发出的任务不会被强行中断', 'warning');
}

async function restartAllVoiceoverWorkflow() {
    if (vwWorkflowRunning) {
        showToast('请先暂停并等待当前任务停止', 'warning');
        return;
    }
    if (!vwTasks.length) {
        showToast('请先添加任务', 'warning');
        return;
    }
    if (!confirm('确定全部重新生成吗？已经成功的配音、字幕和 MP4 也会重新调用并生成到新的批次文件夹。')) return;
    vwTasks.forEach(task => {
        task.status = 'pending';
        task.error = null;
        task.recognizedText = '';
        task.audioPath = null;
        task.srtPath = null;
        task.subtitleTxtPath = null;
        task.mp4Path = null;
        task.segments = null;
        task.outputFolder = null;
        task.taskPrefix = null;
        task.outputGroupName = null;
    });
    vwWorkflowBatchOutputDir = '';
    window._vwLastOutputFolder = '';
    renderVWTasks();
    await startVoiceoverWorkflow(true);
}

async function startVoiceoverWorkflow(forceAll = false, singleTaskId = null) {
    if (vwWorkflowRunning) {
        showToast('任务正在执行中', 'warning');
        return;
    }
    if (vwTasks.length === 0) {
        showToast('请先添加任务', 'warning');
        return;
    }

    const runnableIndices = [];
    vwTasks.forEach((task, index) => {
        if (singleTaskId !== null
            ? task.id === singleTaskId
            : (forceAll || task.status === 'pending' || task.status === 'error' || task.status === 'generating')) {
            runnableIndices.push(index);
        }
    });
    if (runnableIndices.length === 0) {
        const partialCount = vwTasks.filter(task => task.status === 'partial').length;
        showToast(
            partialCount
                ? `没有未生成任务；另有 ${partialCount} 条仅字幕失败，请使用“重试所有失败字幕”`
                : '所有任务均已完成，无需重复生成',
            partialCount ? 'warning' : 'success'
        );
        return;
    }

    const defaultVoice = document.getElementById('vw-default-voice').value;
    const modelId = document.getElementById('vw-model')?.value || 'eleven_v3';
    const maxDuration = parseInt(document.getElementById('vw-max-duration').value) || 30;
    const rawTailSilence = parseFloat(document.getElementById('vw-tail-silence')?.value || '0');
    const tailSilence = Number.isFinite(rawTailSilence) && rawTailSilence > 0
        ? Math.max(0.1, Math.min(5, rawTailSilence))
        : 0;
    const rawConcurrency = parseInt(document.getElementById('vw-concurrency')?.value || '5', 10);
    const requestedConcurrency = Math.max(1, Math.min(20, Number.isFinite(rawConcurrency) ? rawConcurrency : 5));
    const gladiaKeys = String(document.getElementById('gladia-keys')?.value || '')
        .split('\n').map(key => key.trim()).filter(Boolean);
    const outputDirInput = document.getElementById('vw-output-dir');
    const outputDir = outputDirInput.value.trim();

    if (!defaultVoice) {
        showToast('请选择默认音色', 'warning');
        return;
    }

    let availableKeyCount = 1;
    try {
        const keyCountResponse = await apiFetch(`${API_BASE}/elevenlabs/key-count`);
        const keyCountData = await keyCountResponse.json();
        availableKeyCount = Math.max(1, parseInt(keyCountData.count, 10) || 1);
    } catch (error) {
        console.warn('[一键配音] 无法读取 Key 数量，并发数按 1 处理:', error);
    }
    const availableGladiaKeyCount = Math.max(1, gladiaKeys.length);
    const concurrency = Math.min(requestedConcurrency, availableKeyCount, availableGladiaKeyCount);
    if (concurrency < requestedConcurrency) {
        showToast(
            `可用 Key：ElevenLabs ${availableKeyCount} 个、Gladia ${gladiaKeys.length} 个；并发数已从 ${requestedConcurrency} 降为 ${concurrency}`,
            'warning'
        );
    }

    const isResume = !forceAll && !!vwWorkflowBatchOutputDir;
    const batchOutputDir = isResume
        ? vwWorkflowBatchOutputDir
        : await vwCreateBatchOutputDir(outputDir);
    vwWorkflowBatchOutputDir = batchOutputDir;
    window._vwLastOutputFolder = batchOutputDir;

    const btn = document.getElementById('vw-start-btn');
    const pauseBtn = document.getElementById('vw-pause-btn');
    const restartAllBtn = document.getElementById('vw-restart-all-btn');
    vwWorkflowRunning = true;
    vwWorkflowPauseRequested = false;
    btn.disabled = true;
    btn.textContent = '⏳ 处理中...';
    if (pauseBtn) {
        pauseBtn.disabled = false;
        pauseBtn.textContent = '⏸ 暂停';
    }
    if (restartAllBtn) restartAllBtn.disabled = true;

    const total = runnableIndices.length * 3;  // 每个任务 3 步
    let current = 0;

    try {
        let nextTaskIndex = 0;
        let completedTasks = 0;
        const workerCount = Math.min(concurrency, runnableIndices.length);

        async function processTask(i, workerIndex) {
            const task = vwTasks[i];
            const voiceId = task.voiceId || defaultVoice;

            task.status = 'generating';
            task.recognizedText = '';
            renderVWTasks();
            updateVWProgress(current, total, `并发 ${workerCount} · Worker ${workerIndex + 1} 正在处理 #${i + 1}`);

            try {
                const audioSubtitleOnly = document.getElementById('vw-audio-subtitle-only')?.checked ?? false;
                task.audioSubtitleOnly = audioSubtitleOnly;
                const exportFcpxml = audioSubtitleOnly
                    ? false
                    : (document.getElementById('vw-export-fcpxml')?.checked ?? true);
                // 每个 worker 从不同 Key 开始；首选 Key 不可用时，后端会按此顺序轮询其余 Key。
                const workerGladiaKeys = gladiaKeys.length > 0
                    ? gladiaKeys.map((_, offset) => gladiaKeys[(workerIndex + offset) % gladiaKeys.length])
                    : [];
                const alignLang = document.getElementById('vw-align-lang')?.value || '英语';
                const ttsResponse = await apiFetch(`${API_BASE}/elevenlabs/tts-workflow`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: task.ttsText,
                        voice_id: voiceId,
                        model_id: modelId,
                        task_index: i,
                        key_index: workerIndex,
                        // 兜底互斥：导出黑屏MP4时，强制不拆分
                        need_split: task.exportMp4 ? false : task.split,
                        max_duration: maxDuration,
                        subtitle_text: task.subtitleText,
                        bgm_path: task.bgmPath || '',
                        tail_silence: tailSilence,
                        export_mp4: task.exportMp4,  // 从任务读取
                        export_fcpxml: exportFcpxml,  // 导出达芬奇字幕
                        seamless_fcpxml: true,  // 默认无缝字幕
                        output_dir: batchOutputDir,
                        group_name: task.folderName || '',
                        export_subtitle_txt: !audioSubtitleOnly,
                        // 每个 worker 使用不同的首选 Gladia Key，并在失败时自动轮换备用 Key。
                        gladia_keys: workerGladiaKeys,
                        language: alignLang
                    })
                });

                const ttsData = await ttsResponse.json();

                if (!ttsResponse.ok) {
                    throw new Error(ttsData.error || '生成失败');
                }

                task.audioPath = ttsData.audio_path;
                task.srtPath = ttsData.srt_path || null;
                task.subtitleTxtPath = ttsData.subtitle_txt_path || null;
                task.outputFolder = ttsData.output_folder;
                task.taskPrefix = ttsData.task_prefix;
                task.outputGroupName = ttsData.group_name || '';
                task.mp4Path = ttsData.mp4_path || null;
                task.segments = ttsData.segments;
                task.status = ttsData.partial_success ? 'partial' : 'done';
                task.error = ttsData.subtitle_error ? `字幕生成失败：${ttsData.subtitle_error}` : null;
                task.recognizedText = ttsData.recognized_text || vwGetRecognizedTextFromError(ttsData.subtitle_error);

            } catch (err) {
                task.status = 'error';
                task.error = err.message;
            }

            current += 3;
            completedTasks++;
            renderVWTasks();
            updateVWProgress(
                current,
                total,
                `本次已完成 ${completedTasks}/${runnableIndices.length} · ${workerCount} 个 worker 并发`
            );
        }

        async function runWorker(workerIndex) {
            while (true) {
                if (vwWorkflowPauseRequested) return;
                const queueIndex = nextTaskIndex++;
                if (queueIndex >= runnableIndices.length) return;
                const taskIndex = runnableIndices[queueIndex];
                await processTask(taskIndex, workerIndex);
            }
        }

        await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) => runWorker(workerIndex)));

        const successCount = vwTasks.filter(t => t.status === 'done').length;
        const remainingCount = vwTasks.filter(t => t.status === 'pending' || t.status === 'error' || t.status === 'generating').length;
        if (vwWorkflowPauseRequested && remainingCount > 0) {
            showToast(`已暂停；还有 ${remainingCount} 条未完成，点击“继续未完成”即可续跑`, 'warning');
        } else {
            showToast(`完成！成功 ${successCount}/${vwTasks.length} 条，输出: ${batchOutputDir}`, successCount === vwTasks.length ? 'success' : 'warning');
            playVWCompletionSound();
        }

    } catch (error) {
        showToast('工作流执行失败: ' + error.message, 'error');
    } finally {
        vwWorkflowRunning = false;
        btn.disabled = false;
        const remainingCount = vwTasks.filter(t => t.status === 'pending' || t.status === 'error' || t.status === 'generating').length;
        btn.textContent = remainingCount > 0 ? `▶️ 继续未完成 (${remainingCount})` : '✅ 已全部生成';
        if (pauseBtn) {
            pauseBtn.disabled = true;
            pauseBtn.textContent = '⏸ 暂停';
        }
        if (restartAllBtn) restartAllBtn.disabled = false;
        if (!vwWorkflowPauseRequested || remainingCount === 0) {
            document.getElementById('vw-progress').style.display = 'none';
        }
        vwWorkflowPauseRequested = false;
    }
}

// 编辑单条任务后重新执行；使用当前批次输出目录，避免意外重新跑其余任务。
function vwEditAndRerunTask(id) {
    if (vwWorkflowRunning) {
        showToast('当前有任务正在执行，请完成或暂停后再重新执行单条任务', 'warning');
        return;
    }
    const task = vwTasks.find(item => item.id === id);
    if (!task) return;

    document.getElementById('vw-task-editor-modal')?.remove();
    const voiceSelect = document.getElementById('vw-default-voice');
    const voices = Array.from(voiceSelect?.options || []).filter(option => option.value);
    const selectedVoiceId = task.voiceId || voiceSelect?.value || '';
    if (selectedVoiceId && !voices.some(option => option.value === selectedVoiceId)) {
        voices.unshift({ value: selectedVoiceId, textContent: `当前音色 (${selectedVoiceId})` });
    }

    const modal = document.createElement('div');
    modal.id = 'vw-task-editor-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.62);padding:20px;';
    modal.innerHTML = `
        <div role="dialog" aria-modal="true" aria-label="编辑并重新执行任务" style="width:min(760px,100%);max-height:90vh;overflow:auto;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:10px;padding:18px;box-shadow:0 16px 48px rgba(0,0,0,.45);">
            <h3 style="margin:0 0 14px;">编辑并重新执行 #${vwTasks.indexOf(task) + 1}</h3>
            <label style="display:block;font-size:12px;margin-bottom:5px;">人声配音文案</label>
            <textarea id="vw-edit-tts-text" class="textarea" rows="5" style="width:100%;box-sizing:border-box;"></textarea>
            <label style="display:block;font-size:12px;margin:12px 0 5px;">字幕断行文本</label>
            <textarea id="vw-edit-subtitle-text" class="textarea" rows="6" style="width:100%;box-sizing:border-box;"></textarea>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
                <label style="font-size:12px;">音色<select id="vw-edit-voice" class="select" style="display:block;width:100%;margin-top:5px;"></select></label>
                <label style="font-size:12px;">账号/文件夹命名<input id="vw-edit-folder" class="input" style="display:block;width:100%;box-sizing:border-box;margin-top:5px;" placeholder="留空则不分账号文件夹"></label>
            </div>
            <p style="font-size:11px;color:var(--text-muted);margin:12px 0;">保存后仅重新执行这一条的配音、字幕和当前勾选的拆分/MP4设置；其他任务不会执行。</p>
            <div style="display:flex;justify-content:flex-end;gap:8px;"><button type="button" class="btn btn-secondary" id="vw-edit-cancel">取消</button><button type="button" class="btn btn-primary" id="vw-edit-submit">🚀 保存并重新执行</button></div>
        </div>`;
    document.body.appendChild(modal);
    const ttsInput = modal.querySelector('#vw-edit-tts-text');
    const subtitleInput = modal.querySelector('#vw-edit-subtitle-text');
    const voiceInput = modal.querySelector('#vw-edit-voice');
    const folderInput = modal.querySelector('#vw-edit-folder');
    ttsInput.value = task.ttsText || '';
    subtitleInput.value = task.subtitleText || '';
    voices.forEach(option => {
        const item = document.createElement('option');
        item.value = option.value;
        item.textContent = option.textContent || option.value;
        item.selected = option.value === selectedVoiceId;
        voiceInput.appendChild(item);
    });
    folderInput.value = task.folderName || '';
    modal.querySelector('#vw-edit-cancel').onclick = () => modal.remove();
    modal.addEventListener('click', (event) => { if (event.target === modal) modal.remove(); });
    modal.querySelector('#vw-edit-submit').onclick = async () => {
        const ttsText = ttsInput.value.trim();
        const subtitleText = subtitleInput.value.trim();
        const voiceId = voiceInput.value;
        if (!ttsText || !subtitleText || !voiceId) {
            showToast('请填写人声配音文案、字幕断行文本并选择音色', 'warning');
            return;
        }
        task.ttsText = ttsText;
        task.subtitleText = subtitleText;
        task.voiceId = voiceId;
        task.folderName = folderInput.value.trim();
        task.error = null;
        task.recognizedText = '';
        modal.remove();
        renderVWTasks();
        updateVWTaskCount();
        await startVoiceoverWorkflow(false, task.id);
    };
    ttsInput.focus();
}

async function retryVWSubtitles(id) {
    const task = vwTasks.find(item => item.id === id);
    if (!task?.audioPath || !task?.outputFolder || !task?.taskPrefix) {
        showToast('找不到已生成的配音文件或任务信息，无法只重试字幕', 'error');
        return;
    }
    task.status = 'aligning';
    task.error = null;
    task.recognizedText = '';
    renderVWTasks();
    try {
        const gladiaKeys = String(document.getElementById('gladia-keys')?.value || '').split('\n').map(key => key.trim()).filter(Boolean);
        await retryVWSubtitleTask(task, gladiaKeys);
        showToast('字幕已重新生成，原配音没有重新调用', 'success');
        playVWCompletionSound();
    } catch (error) {
        task.status = 'partial';
        task.error = `字幕重试失败：${error.message}`;
        task.recognizedText = vwGetRecognizedTextFromError(error.message);
        showToast(task.error, 'error');
    }
    renderVWTasks();
}

async function retryVWSubtitleTask(task, gladiaKeys) {
    const response = await apiFetch(`${API_BASE}/elevenlabs/retry-workflow-subtitles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                audio_path: task.audioPath,
                subtitle_text: task.subtitleText,
                output_dir: task.outputFolder,
                task_prefix: task.taskPrefix,
                // 新任务使用“总目录 → 内容类型 → 账号”层级；旧续跑任务没有该字段时保持原路径。
                group_name: task.outputGroupName || '',
                gladia_keys: gladiaKeys,
                language: document.getElementById('vw-align-lang')?.value || '英语',
                export_fcpxml: document.getElementById('vw-export-fcpxml')?.checked ?? true,
                seamless_fcpxml: true,
                export_subtitle_txt: task.audioSubtitleOnly !== true,
            }),
        });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '字幕重试失败');
    task.srtPath = data.srt_path;
    task.subtitleTxtPath = data.subtitle_txt_path;
    task.status = 'done';
    task.error = null;
    task.recognizedText = data.recognized_text || '';
    return data;
}

async function retryAllVWSubtitles() {
    if (vwRetryAllRunning) return;
    const retryTasks = vwTasks.filter(task =>
        task.status === 'partial' && task.audioPath && task.outputFolder && task.taskPrefix
    );
    if (retryTasks.length === 0) {
        showToast('没有可重试的字幕失败任务', 'info');
        return;
    }

    const allGladiaKeys = String(document.getElementById('gladia-keys')?.value || '')
        .split('\n').map(key => key.trim()).filter(Boolean);
    if (allGladiaKeys.length === 0) {
        showToast('未配置 Gladia API Key，无法批量重试字幕', 'error');
        return;
    }

    const requestedConcurrency = Math.max(
        1,
        Math.min(20, parseInt(document.getElementById('vw-concurrency')?.value || '5', 10) || 5)
    );
    const workerCount = Math.min(requestedConcurrency, allGladiaKeys.length, retryTasks.length);
    let nextIndex = 0;
    let completed = 0;
    let succeeded = 0;
    vwRetryAllRunning = true;
    renderVWTasks();
    updateVWProgress(0, retryTasks.length, `准备重试 ${retryTasks.length} 条失败字幕`);

    async function runRetryWorker(workerIndex) {
        const workerKeys = allGladiaKeys.map(
            (_, offset) => allGladiaKeys[(workerIndex + offset) % allGladiaKeys.length]
        );
        while (true) {
            const index = nextIndex++;
            if (index >= retryTasks.length) return;
            const task = retryTasks[index];
            task.status = 'aligning';
            task.error = null;
            task.recognizedText = '';
            renderVWTasks();
            try {
                await retryVWSubtitleTask(task, workerKeys);
                succeeded++;
            } catch (error) {
                task.status = 'partial';
                task.error = `字幕重试失败：${error.message}`;
                task.recognizedText = vwGetRecognizedTextFromError(error.message);
            }
            completed++;
            renderVWTasks();
            updateVWProgress(
                completed,
                retryTasks.length,
                `字幕重试 ${completed}/${retryTasks.length} · 成功 ${succeeded} · 并发 ${workerCount}`
            );
        }
    }

    try {
        await Promise.all(Array.from({ length: workerCount }, (_, index) => runRetryWorker(index)));
        const failed = retryTasks.length - succeeded;
        showToast(
            `字幕批量重试完成：成功 ${succeeded}，失败 ${failed}；原配音没有重新调用`,
            failed === 0 ? 'success' : 'warning',
            6000
        );
        playVWCompletionSound();
    } finally {
        vwRetryAllRunning = false;
        renderVWTasks();
        document.getElementById('vw-progress').style.display = 'none';
    }
}

// 页面加载时刷新音色
let vwPageInitialized = false;
function initVWPageOnce() {
    if (vwPageInitialized) return;
    vwPageInitialized = true;
    if (restoreVWResumeState()) {
        renderVWTasks();
        updateVWTaskCount();
        const startBtn = document.getElementById('vw-start-btn');
        const restartAllBtn = document.getElementById('vw-restart-all-btn');
        const remainingCount = vwTasks.filter(task =>
            task.status === 'pending' || task.status === 'error' || task.status === 'generating'
        ).length;
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.textContent = remainingCount > 0
                ? `▶️ 继续未完成 (${remainingCount})`
                : '✅ 已全部生成';
        }
        if (restartAllBtn) restartAllBtn.disabled = false;
        showToast(`已恢复上次一键配音任务：${vwTasks.length} 条，未完成 ${remainingCount} 条`, 'info');
    }
    setTimeout(refreshVWVoices, 1000);
}
window.initVWPageOnce = initVWPageOnce;


// 浏览输出目录
async function vwBrowseOutputDir() {
    // 检查是否在 Electron 环境
    if (window.electronAPI && window.electronAPI.selectDirectory) {
        try {
            const dirPath = await window.electronAPI.selectDirectory();
            if (dirPath) {
                document.getElementById('vw-output-dir').value = dirPath;
            }
        } catch (err) {
            console.error('选择目录失败:', err);
            showToast('选择目录失败', 'error');
        }
    } else if (window.require) {
        // 直接使用 Electron remote
        try {
            const { dialog } = window.require('@electron/remote');
            const result = await dialog.showOpenDialog({
                properties: ['openDirectory', 'createDirectory'],
                title: '选择输出目录'
            });
            if (!result.canceled && result.filePaths.length > 0) {
                document.getElementById('vw-output-dir').value = result.filePaths[0];
            }
        } catch (err) {
            console.error('选择目录失败:', err);
            // 回退：让用户直接编辑输入框
            showToast('请直接在输入框中输入完整路径', 'info');
            document.getElementById('vw-output-dir').focus();
        }
    } else {
        // 浏览器环境
        showToast('请直接在输入框中输入完整路径', 'info');
        document.getElementById('vw-output-dir').focus();
    }
}

// 打开输出文件夹
async function vwOpenOutputDir() {
    let outputDir = window._vwLastOutputFolder || document.getElementById('vw-output-dir').value.trim();

    if (!outputDir) {
        outputDir = await vwResolveOutputBaseDir('');
    }

    // 调用后端 API 打开文件夹
    try {
        const response = await apiFetch(`${API_BASE}/open-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: outputDir })
        });

        const result = await response.json();
        if (!response.ok) {
            showToast('打开失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (err) {
        console.error('打开文件夹失败:', err);
        showToast('打开失败，文件夹可能不存在', 'error');
    }
}

window.VideoKitGlobalHistory.register('voiceover-workflow',{contexts:['voiceover-workflow'],capture:()=>({tasks:vwTasks,output:vwWorkflowBatchOutputDir}),restore:state=>{vwTasks=state.tasks;vwWorkflowBatchOutputDir=state.output;},busy:()=>vwWorkflowRunning||vwRetryAllRunning||vwTasks.some(task=>task.status==='generating'),render:()=>{renderVWTasks();saveVWResumeState();}});
