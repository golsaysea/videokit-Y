/* Standalone Google Voice Studio batch workshop (Google Translate Free + Gemini AI 30 Multi-Voices). */
(() => {
    const KEY = 'videokit_google_tts_queue_v1';
    const FALLBACK_VOICES = [
        { voice_id: 'gtrans:en-US', ShortName: 'Google-en-US', engine: 'translate', Locale: 'en-US', locale: 'en-US', DisplayName: '美式英语 · 标准自然女声 (Standard)', LocalName: '🌐 美式英语 · 标准自然女声 (Standard)', Gender: 'Female', gender: 'Female', trait: '标准自然女声 (Standard)' },
        { voice_id: 'gtrans:en-US:female_warm', ShortName: 'Google-en-US-female_warm', engine: 'translate', Locale: 'en-US', locale: 'en-US', DisplayName: '美式英语 · 温柔治愈女声 (Warm & Gentle)', LocalName: '🌐 美式英语 · 温柔治愈女声 (Warm & Gentle)', Gender: 'Female', gender: 'Female', trait: '温柔治愈女声 (Warm & Gentle)' },
        { voice_id: 'gtrans:en-US:female_bright', ShortName: 'Google-en-US-female_bright', engine: 'translate', Locale: 'en-US', locale: 'en-US', DisplayName: '美式英语 · 清亮活力少女 (Bright & Youthful)', LocalName: '🌐 美式英语 · 清亮活力少女 (Bright & Youthful)', Gender: 'Female', gender: 'Female', trait: '清亮活力少女 (Bright & Youthful)' },
        { voice_id: 'gtrans:en-US:female_calm', ShortName: 'Google-en-US-female_calm', engine: 'translate', Locale: 'en-US', locale: 'en-US', DisplayName: '美式英语 · 知性沉稳女声 (Calm Narrator)', LocalName: '🌐 美式英语 · 知性沉稳女声 (Calm Narrator)', Gender: 'Female', gender: 'Female', trait: '知性沉稳女声 (Calm Narrator)' },
        { voice_id: 'gtrans:en-US:female_story', ShortName: 'Google-en-US-female_story', engine: 'translate', Locale: 'en-US', locale: 'en-US', DisplayName: '美式英语 · 深情故事女声 (Storyteller)', LocalName: '🌐 美式英语 · 深情故事女声 (Storyteller)', Gender: 'Female', gender: 'Female', trait: '深情故事女声 (Storyteller)' },
        { voice_id: 'gtrans:en-US:female_crisp', ShortName: 'Google-en-US-female_crisp', engine: 'translate', Locale: 'en-US', locale: 'en-US', DisplayName: '美式英语 · 清晰播音女声 (Crisp Broadcast)', LocalName: '🌐 美式英语 · 清晰播音女声 (Crisp Broadcast)', Gender: 'Female', gender: 'Female', trait: '清晰播音女声 (Crisp Broadcast)' },
        { voice_id: 'gtrans:en-US:male_calm', ShortName: 'Google-en-US-male_calm', engine: 'translate', Locale: 'en-US', locale: 'en-US', DisplayName: '美式英语 · 沉稳解说男声 (Calm Narrator)', LocalName: '🌐 美式英语 · 沉稳解说男声 (Calm Narrator)', Gender: 'Male', gender: 'Male', trait: '沉稳解说男声 (Calm Narrator)' },
        { voice_id: 'gtrans:en-US:male_deep', ShortName: 'Google-en-US-male_deep', engine: 'translate', Locale: 'en-US', locale: 'en-US', DisplayName: '美式英语 · 浑厚磁性男声 (Deep Baritone)', LocalName: '🌐 美式英语 · 浑厚磁性男声 (Deep Baritone)', Gender: 'Male', gender: 'Male', trait: '浑厚磁性男声 (Deep Baritone)' },
        { voice_id: 'gtrans:en-US:male_pastor', ShortName: 'Google-en-US-male_pastor', engine: 'translate', Locale: 'en-US', locale: 'en-US', DisplayName: '美式英语 · 庄重祈祷男声 (Reverent Pastor)', LocalName: '🌐 美式英语 · 庄重祈祷男声 (Reverent Pastor)', Gender: 'Male', gender: 'Male', trait: '庄重祈祷男声 (Reverent Pastor)' },
        { voice_id: 'gtrans:en-US:male_warm', ShortName: 'Google-en-US-male_warm', engine: 'translate', Locale: 'en-US', locale: 'en-US', DisplayName: '美式英语 · 温和青年男声 (Warm Tenor)', LocalName: '🌐 美式英语 · 温和青年男声 (Warm Tenor)', Gender: 'Male', gender: 'Male', trait: '温和青年男声 (Warm Tenor)' },
        { voice_id: 'gtrans:en-US:male_broadcast', ShortName: 'Google-en-US-male_broadcast', engine: 'translate', Locale: 'en-US', locale: 'en-US', DisplayName: '美式英语 · 铿锵播音男声 (Broadcast Anchor)', LocalName: '🌐 美式英语 · 铿锵播音男声 (Broadcast Anchor)', Gender: 'Male', gender: 'Male', trait: '铿锵播音男声 (Broadcast Anchor)' },
        { voice_id: 'gtrans:en-US:male_elder', ShortName: 'Google-en-US-male_elder', engine: 'translate', Locale: 'en-US', locale: 'en-US', DisplayName: '美式英语 · 慈祥长者男声 (Wise Elder)', LocalName: '🌐 美式英语 · 慈祥长者男声 (Wise Elder)', Gender: 'Male', gender: 'Male', trait: '慈祥长者男声 (Wise Elder)' },
        { voice_id: 'gtrans:en-GB', ShortName: 'Google-en-GB', engine: 'translate', Locale: 'en-GB', locale: 'en-GB', DisplayName: '英式英语 · 标准自然女声 (Standard)', LocalName: '🌐 英式英语 · 标准自然女声 (Standard)', Gender: 'Female', gender: 'Female', trait: '标准自然女声 (Standard)' },
        { voice_id: 'gtrans:en-GB:male_calm', ShortName: 'Google-en-GB-male_calm', engine: 'translate', Locale: 'en-GB', locale: 'en-GB', DisplayName: '英式英语 · 沉稳解说男声 (Calm Narrator)', LocalName: '🌐 英式英语 · 沉稳解说男声 (Calm Narrator)', Gender: 'Male', gender: 'Male', trait: '沉稳解说男声 (Calm Narrator)' },
        { voice_id: 'gtrans:zh-CN', ShortName: 'Google-zh-CN', engine: 'translate', Locale: 'zh-CN', locale: 'zh-CN', DisplayName: '普通话 · 标准自然女声 (Standard)', LocalName: '🌐 普通话 · 标准自然女声 (Standard)', Gender: 'Female', gender: 'Female', trait: '标准自然女声 (Standard)' },
        { voice_id: 'gtrans:zh-CN:male_calm', ShortName: 'Google-zh-CN-male_calm', engine: 'translate', Locale: 'zh-CN', locale: 'zh-CN', DisplayName: '普通话 · 沉稳解说男声 (Calm Narrator)', LocalName: '🌐 普通话 · 沉稳解说男声 (Calm Narrator)', Gender: 'Male', gender: 'Male', trait: '沉稳解说男声 (Calm Narrator)' },
        { voice_id: 'gemini:Kore', ShortName: 'Kore', engine: 'gemini', Locale: 'multi', locale: 'multi', DisplayName: 'Gemini Kore', LocalName: '✨ Gemini Kore · 坚定自然 (Firm)', Gender: 'Female', gender: 'Female', trait: '坚定自然 (Firm)' },
        { voice_id: 'gemini:Zephyr', ShortName: 'Zephyr', engine: 'gemini', Locale: 'multi', locale: 'multi', DisplayName: 'Gemini Zephyr', LocalName: '✨ Gemini Zephyr · 明亮清澈 (Bright)', Gender: 'Female', gender: 'Female', trait: '明亮清澈 (Bright)' },
        { voice_id: 'gemini:Aoede', ShortName: 'Aoede', engine: 'gemini', Locale: 'multi', locale: 'multi', DisplayName: 'Gemini Aoede', LocalName: '✨ Gemini Aoede · 轻快自然 (Breezy)', Gender: 'Female', gender: 'Female', trait: '轻快自然 (Breezy)' },
        { voice_id: 'gemini:Leda', ShortName: 'Leda', engine: 'gemini', Locale: 'multi', locale: 'multi', DisplayName: 'Gemini Leda', LocalName: '✨ Gemini Leda · 年轻活力 (Youthful)', Gender: 'Female', gender: 'Female', trait: '年轻活力 (Youthful)' },
        { voice_id: 'gemini:Puck', ShortName: 'Puck', engine: 'gemini', Locale: 'multi', locale: 'multi', DisplayName: 'Gemini Puck', LocalName: '✨ Gemini Puck · 欢快有活力 (Upbeat)', Gender: 'Male', gender: 'Male', trait: '欢快有活力 (Upbeat)' },
        { voice_id: 'gemini:Charon', ShortName: 'Charon', engine: 'gemini', Locale: 'multi', locale: 'multi', DisplayName: 'Gemini Charon', LocalName: '✨ Gemini Charon · 沉稳播音 (Informative)', Gender: 'Male', gender: 'Male', trait: '沉稳播音 (Informative)' },
        { voice_id: 'gemini:Fenrir', ShortName: 'Fenrir', engine: 'gemini', Locale: 'multi', locale: 'multi', DisplayName: 'Gemini Fenrir', LocalName: '✨ Gemini Fenrir · 激昂有力 (Excitable)', Gender: 'Male', gender: 'Male', trait: '激昂有力 (Excitable)' },
        { voice_id: 'gemini:Orus', ShortName: 'Orus', engine: 'gemini', Locale: 'multi', locale: 'multi', DisplayName: 'Gemini Orus', LocalName: '✨ Gemini Orus · 坚定浑厚 (Firm)', Gender: 'Male', gender: 'Male', trait: '坚定浑厚 (Firm)' },
    ];

    let rows = [];
    let voices = [];
    let geminiKeyCount = 0;
    let running = false;
    let stopping = false;
    let lastOutput = '';
    let requestNumber = 0;

    let currentAudio = null;
    let currentAudioUrl = '';
    let currentPlayBtn = null;
    let currentPlayRowId = '';
    let previewRunId = 0;

    const $ = id => document.getElementById('gg-' + id);
    const zipFormatInputs = () => [...document.querySelectorAll('input[name="ggZipFormat"]')];

    function setStatus(text) {
        const el = $('progress');
        if (el) el.textContent = text || 'Ready';
    }

    function setProgress(done, total) {
        const fill = $('progress-fill');
        if (!fill) return;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        fill.style.width = `${pct}%`;
        fill.textContent = pct > 0 ? `${pct}%` : '';
    }

    function selectedZipFormats() {
        const checked = zipFormatInputs().find(input => input.checked)?.value || 'mp3';
        return checked === 'both' ? ['mp3', 'mp4'] : [checked];
    }

    function zipFormatLabel() {
        const formats = selectedZipFormats();
        return formats.length > 1 ? 'MP3+MP4' : formats[0].toUpperCase();
    }

    function updateZipButtonText() {
        const btn = $('create-zip');
        if (btn) btn.textContent = `打包 ${zipFormatLabel()} ZIP`;
    }

    function ensureAtLeastOneRow() {
        if (!rows.length) {
            rows.push({
                id: crypto.randomUUID(),
                text: '',
                name: '文案 1',
                state: 'waiting',
                audio: '',
                mp4: '',
                srt: '',
                fileName: '',
                baseName: '',
                error: '',
            });
        }
    }

    function save() {
        try {
            const serializableRows = rows.map(r => ({
                id: r.id,
                text: r.text || '',
                name: r.name || '',
                state: r.state === 'running' ? 'waiting' : (r.state || 'waiting'),
                audio: r.audio || '',
                mp4: r.mp4 || '',
                srt: r.srt || '',
                fileName: r.fileName || '',
                baseName: r.baseName || '',
                error: r.error || '',
            }));
            const zipFmt = zipFormatInputs().find(i => i.checked)?.value || 'mp3';
            localStorage.setItem(KEY, JSON.stringify({
                rows: serializableRows,
                engine: $('engine')?.value || 'all',
                language: $('language')?.value || 'en-US',
                voice: $('voice')?.value || 'gtrans:en-US',
                rate: $('rate')?.value || '+0%',
                style: $('style')?.value || 'natural',
                output: $('output')?.value || '',
                taskFolder: $('task-folder')?.value || '第一期',
                zipFormat: zipFmt,
                draft: $('text')?.value || '',
                lastOutput,
            }));
        } catch (error) {
            setStatus('自动保存失败：' + error.message);
        }
    }

    async function request(endpoint, data) {
        const response = await apiFetch(API_BASE + '/' + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        const value = await response.json();
        if (!response.ok || value.error) throw new Error(value.error || '请求失败');
        return value;
    }

    function stopAudio(invalidate = true) {
        if (invalidate) previewRunId += 1;
        if (currentAudio) {
            try {
                currentAudio.pause();
                currentAudio.currentTime = 0;
            } catch (_) {}
        }
        if (currentAudioUrl) {
            try { URL.revokeObjectURL(currentAudioUrl); } catch (_) {}
            currentAudioUrl = '';
        }
        currentAudio = null;
        if (currentPlayBtn) {
            currentPlayBtn.disabled = false;
            currentPlayBtn.textContent = currentPlayBtn.dataset.label || '试听';
            currentPlayBtn = null;
        }
        currentPlayRowId = '';
    }

    function base64ToUint8Array(base64) {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    async function playAudioBase64(base64, button, row, statusEl, activeLabel = '播放中 (点击停止)') {
        const runId = ++previewRunId;
        stopAudio(false);
        currentPlayBtn = button;
        currentPlayRowId = row ? row.id : '';
        if (button) {
            button.disabled = false;
            button.textContent = activeLabel;
        }
        if (statusEl) statusEl.textContent = '播放中';

        const bytes = base64ToUint8Array(base64);
        const isWav = bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
        const blob = new Blob([bytes], { type: isWav ? 'audio/wav' : 'audio/mpeg' });
        currentAudioUrl = URL.createObjectURL(blob);
        currentAudio = new Audio(currentAudioUrl);

        return new Promise((resolve, reject) => {
            currentAudio.onended = () => {
                if (runId === previewRunId) {
                    if (button) button.textContent = button.dataset.label || '试听';
                    currentPlayBtn = null;
                    currentPlayRowId = '';
                    if (statusEl) statusEl.textContent = row?.fileName || '试听完成';
                }
                resolve();
            };
            currentAudio.onerror = () => {
                if (button) button.textContent = button.dataset.label || '试听';
                currentPlayBtn = null;
                currentPlayRowId = '';
                if (statusEl) statusEl.textContent = '播放失败';
                reject(new Error('音频播放失败'));
            };
            currentAudio.play().catch(err => {
                if (button) button.textContent = button.dataset.label || '试听';
                currentPlayBtn = null;
                currentPlayRowId = '';
                reject(err);
            });
        });
    }

    function currentVoiceSettings() {
        return {
            voice: $('voice')?.value || 'gtrans:en-US',
            rate: $('rate')?.value || '+0%',
            style: $('style')?.value || 'natural',
        };
    }

    async function previewRow(row, button, statusEl, fullTextMode = false) {
        if (currentAudio && currentPlayBtn === button) {
            stopAudio(true);
            if (statusEl) statusEl.textContent = row.fileName || '已停止试听';
            return;
        }
        const rawText = String(row.text || '').trim();
        if (!rawText) {
            if (statusEl) statusEl.textContent = '请先输入文案';
            setStatus('请先在卡片中输入要试听的文案');
            return;
        }

        const sampleText = fullTextMode ? rawText : rawText.slice(0, 60);
        const opts = currentVoiceSettings();
        const cacheKey = `${opts.voice}|${opts.rate}|${opts.style}|${sampleText}`;

        if (!fullTextMode && row.audioBase64 && !row._dirtyPreview && row._previewCacheKey === cacheKey) {
            try {
                await playAudioBase64(row.audioBase64, button, row, statusEl);
                return;
            } catch (_) {}
        }
        if (fullTextMode && row.fullAudioBase64 && !row._dirtyFull && row._fullCacheKey === cacheKey) {
            try {
                await playAudioBase64(row.fullAudioBase64, button, row, statusEl);
                return;
            } catch (_) {}
        }

        const runId = ++previewRunId;
        stopAudio(false);
        currentPlayBtn = button;
        button.disabled = true;
        button.textContent = '生成中…';
        if (statusEl) statusEl.textContent = '试听生成中…';
        setStatus(`正在生成试听：${sampleText.slice(0, 24)}…`);

        try {
            const res = await request('google-tts/preview', {
                text: sampleText,
                voice: opts.voice,
                rate: opts.rate,
                style: opts.style,
            });
            if (runId !== previewRunId) return;
            if (fullTextMode) {
                row.fullAudioBase64 = res.audio_base64;
                row._fullCacheKey = cacheKey;
                row._dirtyFull = false;
            } else {
                row.audioBase64 = res.audio_base64;
                row._previewCacheKey = cacheKey;
                row._dirtyPreview = false;
            }
            setStatus('正在播放试听音频');
            await playAudioBase64(res.audio_base64, button, row, statusEl);
            setStatus('试听完成');
        } catch (error) {
            if (button) {
                button.disabled = false;
                button.textContent = button.dataset.label || '试听';
            }
            currentPlayBtn = null;
            if (statusEl) statusEl.textContent = '试听失败';
            setStatus('试听失败：' + error.message);
        }
    }

    async function showOrOpenFile(filePath, openDirectly = false) {
        if (!filePath) return;
        try {
            if (!openDirectly && window.electronAPI?.showItemInFolder) {
                await window.electronAPI.showItemInFolder(filePath);
            } else if (window.electronAPI?.openPath) {
                await window.electronAPI.openPath(filePath);
            }
        } catch (e) {
            setStatus(e.message);
        }
    }

    function sanitizeFilename(text) {
        return String(text || '').trim().slice(0, 14).replace(/[\\/:*?"<>|\r\n]/g, '_') || 'untitled';
    }

    function updateTotal() {
        const nonEmptyCount = rows.filter(r => String(r.text || '').trim()).length;
        const totalChars = rows.reduce((n, r) => n + Array.from(String(r.text || '')).length, 0);
        if ($('total')) $('total').textContent = `${rows.length} 张卡片（有效文案 ${nonEmptyCount} 条）· 共 ${totalChars} 字`;
        if ($('card-count')) $('card-count').textContent = `${rows.length} 条文案 · 可直接在卡片中输入文案点击「试听」即时预览声音`;
    }

    function refreshControls() {
        const hasGenerated = rows.some(r => r.state === 'success' && (r.audio || r.fullAudioBase64));
        const hasPending = rows.some(r => String(r.text || '').trim());
        for (const id of ['engine', 'language', 'new', 'add', 'import', 'clear', 'choose-output', 'voice', 'rate', 'style', 'voice-search', 'refresh', 'split', 'text', 'task-folder', 'output']) {
            const el = $(id);
            if (el) el.disabled = running;
        }
        for (const input of zipFormatInputs()) input.disabled = running;
        if ($('start')) {
            $('start').disabled = running || !hasPending;
            $('start').textContent = running ? '生成中…' : '批量生成';
        }
        if ($('stop')) $('stop').disabled = !running || stopping;
        if ($('preview-all')) $('preview-all').disabled = running || !hasGenerated;
        if ($('create-zip')) $('create-zip').disabled = running || !hasGenerated;
        updateZipButtonText();
        updateTotal();
    }

    const stateLabels = {
        waiting: '等待',
        running: '生成中…',
        success: '已完成',
        error: '失败',
    };

    function makeCardButton(label, extraClass = '') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ms-btn' + (extraClass ? ' ' + extraClass : '');
        btn.textContent = label;
        btn.dataset.label = label;
        return btn;
    }

    function render() {
        ensureAtLeastOneRow();
        const queue = $('queue');
        if (!queue) return;
        queue.replaceChildren();

        rows.forEach((row, index) => {
            const card = document.createElement('article');
            card.className = 'ms-script-card' + (row.state === 'success' ? ' done' : row.state === 'error' ? ' failed' : '');

            const head = document.createElement('div');
            head.className = 'ms-card-head';

            const leftWrap = document.createElement('div');
            leftWrap.style.cssText = 'display:flex;align-items:center;gap:10px;';
            const numBadge = document.createElement('span');
            numBadge.className = 'ms-card-number';
            numBadge.textContent = `#${String(index + 1).padStart(2, '0')}`;

            const charCount = document.createElement('span');
            charCount.style.cssText = 'font-size:12px;color:var(--ms-muted);';
            charCount.textContent = `${Array.from(String(row.text || '')).length} 字`;
            leftWrap.append(numBadge, charCount);

            const statusSpan = document.createElement('span');
            statusSpan.className = 'ms-card-status';
            if (row.error) {
                statusSpan.textContent = row.error;
                statusSpan.style.color = '#ff8d85';
            } else if (row.state === 'success' && row.fileName) {
                statusSpan.textContent = row.fileName;
            } else {
                statusSpan.textContent = stateLabels[row.state] || '等待';
            }

            head.append(leftWrap, statusSpan);

            const textarea = document.createElement('textarea');
            textarea.placeholder = '输入或从 Excel / Sheets 粘贴文案（粘贴多行自动拆分为多张卡片）…';
            textarea.value = row.text || '';
            textarea.spellcheck = false;
            textarea.disabled = running;

            textarea.addEventListener('paste', event => {
                if (running || !event.clipboardData) return;
                const raw = event.clipboardData.getData('text/plain') || '';
                const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
                if (lines.length <= 1) return;
                event.preventDefault();
                row.text = lines[0];
                row._dirtyPreview = true;
                row._dirtyFull = true;
                row.state = 'waiting';
                const newRows = lines.slice(1).map((line, idx) => ({
                    id: crypto.randomUUID(),
                    text: line,
                    name: `文案 ${index + 2 + idx}`,
                    state: 'waiting',
                    audio: '',
                    mp4: '',
                    srt: '',
                    fileName: '',
                    baseName: '',
                    error: '',
                }));
                rows.splice(index + 1, 0, ...newRows);
                save();
                render();
                setStatus(`已自动拆分粘贴 ${lines.length} 条文案`);
            });

            textarea.addEventListener('input', () => {
                row.text = textarea.value;
                row._dirtyPreview = true;
                row._dirtyFull = true;
                if (row.state === 'success' || row.state === 'error') {
                    row.state = 'waiting';
                    row.error = '';
                    card.classList.remove('done', 'failed');
                }
                charCount.textContent = `${Array.from(String(row.text || '')).length} 字`;
                statusSpan.textContent = row.text.trim() ? '已修改 · 可试听' : '等待';
                statusSpan.style.color = '';
                updateTotal();
                refreshControls();
                save();
            });

            const foot = document.createElement('div');
            foot.className = 'ms-card-foot';

            const previewBtn = makeCardButton('试听');
            previewBtn.disabled = running;
            previewBtn.onclick = () => previewRow(row, previewBtn, statusSpan, false);

            const fullPlayBtn = makeCardButton('试听完整');
            fullPlayBtn.disabled = running;
            fullPlayBtn.onclick = () => previewRow(row, fullPlayBtn, statusSpan, true);

            const hasSavedFiles = Boolean(row.state === 'success' && row.audio);

            const mp3Btn = makeCardButton('MP3');
            mp3Btn.disabled = !hasSavedFiles || running;
            mp3Btn.onclick = () => showOrOpenFile(row.audio, true);

            const mp4Btn = makeCardButton('MP4');
            mp4Btn.disabled = !hasSavedFiles || !row.mp4 || running;
            mp4Btn.onclick = () => showOrOpenFile(row.mp4, true);

            const srtBtn = makeCardButton('SRT');
            srtBtn.disabled = !hasSavedFiles || !row.srt || running;
            srtBtn.onclick = () => showOrOpenFile(row.srt, false);

            const posBtn = makeCardButton('位置');
            posBtn.disabled = !hasSavedFiles || running;
            posBtn.onclick = () => showOrOpenFile(row.audio || row.mp4 || row.srt, false);

            const delBtn = makeCardButton('删除', 'ms-btn-danger');
            delBtn.disabled = running;
            delBtn.onclick = () => {
                if (currentPlayRowId === row.id) stopAudio(true);
                rows = rows.filter(r => r !== row);
                ensureAtLeastOneRow();
                save();
                render();
            };

            foot.append(previewBtn, fullPlayBtn, mp3Btn, mp4Btn, srtBtn, posBtn, delBtn);
            card.append(head, textarea, foot);
            queue.append(card);
        });

        refreshControls();
    }

    const _localeLabelCache = new Map();
    let _langDisplayNames = null;
    let _regionDisplayNames = null;

    function localeLabel(locale) {
        if (!locale || locale === 'all') return '全部语言 (All)';
        if (locale === 'en') return '英语 - 全部口音 (English All)';
        if (locale === 'zh') return '中文 - 全部口音 (Chinese All)';
        if (locale === 'multi') return '✨ 多语言自适应 (Gemini AI)';
        if (_localeLabelCache.has(locale)) return _localeLabelCache.get(locale);
        let result = locale;
        try {
            if (!_langDisplayNames) _langDisplayNames = new Intl.DisplayNames(['zh-CN'], { type: 'language' });
            if (!_regionDisplayNames) _regionDisplayNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
            const [lang, region] = String(locale).split('-');
            const langName = _langDisplayNames.of(lang) || lang;
            const regionName = region ? _regionDisplayNames.of(region) : '';
            result = regionName ? `${langName} - ${regionName} (${locale})` : `${langName} (${locale})`;
        } catch (_) {
            result = locale;
        }
        _localeLabelCache.set(locale, result);
        return result;
    }

    function voiceDisplayLabel(v) {
        const gender = v.gender === 'Female' || v.Gender === 'Female' ? '女声'
            : v.gender === 'Male' || v.Gender === 'Male' ? '男声'
            : (v.gender || v.Gender || '');
        const localName = v.LocalName || v.DisplayName || v.ShortName || v.voice_id;
        return `${localName}${gender ? ' · ' + gender : ''}`;
    }

    function populateLanguages(preferredLocale) {
        const select = $('language');
        if (!select) return;
        const current = preferredLocale || select.value || 'en-US';
        const locales = [...new Set(voices.map(v => v.locale || v.Locale).filter(l => l && l !== 'multi'))]
            .sort((a, b) => {
                if (a === 'en-US') return -1;
                if (b === 'en-US') return 1;
                if (a.startsWith('en-') !== b.startsWith('en-')) return a.startsWith('en-') ? -1 : 1;
                if (a.startsWith('zh-') !== b.startsWith('zh-')) return a.startsWith('zh-') ? -1 : 1;
                return localeLabel(a).localeCompare(localeLabel(b), 'zh-CN');
            });

        select.replaceChildren(
            new Option('全部语言 (All)', 'all'),
            new Option('英语 - 全部口音 (English All)', 'en'),
            new Option('中文 - 全部口音 (Chinese All)', 'zh'),
        );
        for (const loc of locales) {
            select.add(new Option(localeLabel(loc), loc));
        }
        if (current === 'all' || current === 'en' || current === 'zh' || locales.includes(current)) {
            select.value = current;
        } else if (locales.includes('en-US')) {
            select.value = 'en-US';
        } else if (locales.length) {
            select.value = locales[0];
        }
    }

    function fillVoices(selectedVoiceId = $('voice')?.value) {
        const select = $('voice');
        if (!select) return;
        const engine = $('engine')?.value || 'all';
        const q = ($('voice-search')?.value || '').trim().toLowerCase();
        const lang = $('language')?.value || 'en-US';

        const filtered = voices.filter(v => {
            if (engine !== 'all' && v.engine !== engine) return false;
            const loc = v.locale || v.Locale || '';
            const matchLang = lang === 'all' || loc === 'multi' || loc === lang || loc.split('-')[0] === lang;
            if (!matchLang) return false;
            if (!q) return true;
            const hay = `${v.voice_id} ${v.ShortName || ''} ${v.LocalName || ''} ${v.DisplayName || ''} ${v.name || ''} ${loc} ${v.gender || ''} ${v.trait || ''}`.toLowerCase();
            return hay.includes(q);
        });

        select.replaceChildren();
        for (const v of filtered) {
            select.add(new Option(voiceDisplayLabel(v), v.voice_id));
        }

        if (selectedVoiceId && filtered.some(v => v.voice_id === selectedVoiceId)) {
            select.value = selectedVoiceId;
        } else {
            const preferred = [
                engine === 'gemini' ? 'gemini:Kore' : `gtrans:${lang !== 'all' && lang !== 'en' && lang !== 'zh' ? lang : 'en-US'}`,
                'gtrans:en-US',
                'gemini:Kore',
                'gemini:Puck',
            ].find(id => filtered.some(v => v.voice_id === id));
            if (preferred) select.value = preferred;
            else if (filtered[0]) select.value = filtered[0].voice_id;
        }

        if (select.value !== selectedVoiceId) {
            rows.forEach(r => { r._dirtyPreview = true; r._dirtyFull = true; });
        }

        if ($('voice-status')) {
            const femaleCount = filtered.filter(v => (v.gender || v.Gender) === 'Female').length;
            const maleCount = filtered.filter(v => (v.gender || v.Gender) === 'Male').length;
            const keyHint = geminiKeyCount > 0
                ? `已配置 ${geminiKeyCount} 个 Gemini Key`
                : '免Key直连含多款男女音色可直接用；Gemini 30音色可在「设置」填入免费Key';
            $('voice-status').textContent = `当前可选 ${filtered.length} 个音色（女声 ${femaleCount} / 男声 ${maleCount}）· ${keyHint}`;
        }
    }

    async function loadVoices(forceRefresh = false) {
        const number = ++requestNumber;
        const selectedVoice = $('voice')?.value;
        const selectedLang = $('language')?.value;
        if ($('voice-status')) $('voice-status').textContent = '正在加载谷歌音色…';
        try {
            const data = await request('google-tts/voices', { refresh: forceRefresh === true });
            if (number !== requestNumber) return;
            geminiKeyCount = Number(data.geminiKeyCount) || 0;
            if (Array.isArray(data.ttsKeys) && $('api-keys') && document.activeElement !== $('api-keys')) {
                $('api-keys').value = data.ttsKeys.join('\n');
            }
            if (data.ttsModel && $('tts-model')) {
                $('tts-model').value = data.ttsModel;
            }
            if ($('toggle-key-box')) {
                $('toggle-key-box').textContent = geminiKeyCount > 0
                    ? `🔑 Gemini Key (${geminiKeyCount})`
                    : '🔑 添加 Gemini TTS Key';
            }
            voices = Array.isArray(data.voices) && data.voices.length ? data.voices : FALLBACK_VOICES;
            populateLanguages(selectedLang);
            fillVoices(selectedVoice);
            const translateCount = voices.filter(v => v.engine === 'translate').length;
            const aiCount = voices.filter(v => v.engine === 'gemini').length;
            setStatus(`已加载 ${voices.length} 个谷歌语音（含 ${aiCount} 个 Gemini/Cloud 原生真人音色 + ${translateCount} 个免Key直连音色）`);
            save();
        } catch (error) {
            if (number !== requestNumber) return;
            voices = FALLBACK_VOICES;
            populateLanguages(selectedLang);
            fillVoices(selectedVoice);
            if ($('voice-status')) $('voice-status').textContent = '使用内置常用谷歌音色';
            setStatus('已加载内置常用谷歌音色');
        }
    }

    function parseCells(text) {
        const cells = [];
        let cell = '', quoted = false;
        text = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (c === '"' && (quoted || cell === '')) {
                if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
                else quoted = !quoted;
            } else if (!quoted && (c === '\t' || c === '\n')) {
                cells.push(cell);
                cell = '';
            } else {
                cell += c;
            }
        }
        cells.push(cell);
        return cells;
    }

    function clipboardCells(data) {
        const html = data.getData('text/html');
        if (html) {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const table = doc.querySelector('table');
            if (table) {
                return Array.from(table.rows).flatMap(row => Array.from(row.cells).map(cell => {
                    cell.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                    return cell.textContent;
                }));
            }
        }
        const plain = data.getData('text/plain') || '';
        return plain.includes('\t') || $('split')?.value === 'cells' ? parseCells(plain) : null;
    }

    function appendTextRow(text, customName) {
        const clean = String(text || '').trim();
        if (!clean) return;
        if (rows.length === 1 && !String(rows[0].text || '').trim() && rows[0].state !== 'success') {
            rows[0].text = clean;
            rows[0].name = customName || '文案 1';
            rows[0].state = 'waiting';
            rows[0]._dirtyPreview = true;
            rows[0]._dirtyFull = true;
            return;
        }
        rows.push({
            id: crypto.randomUUID(),
            text: clean,
            name: customName || `文案 ${rows.length + 1}`,
            state: 'waiting',
            audio: '',
            mp4: '',
            srt: '',
            fileName: '',
            baseName: '',
            error: '',
        });
    }

    async function startBatchGenerate() {
        if (running) return;
        const opts = currentVoiceSettings();
        const validRows = rows.filter(r => String(r.text || '').trim());
        if (!validRows.length) {
            setStatus('没有可生成的文案，请先在卡片中输入文案');
            return;
        }

        running = true;
        stopping = false;
        stopAudio(true);
        setProgress(0, validRows.length);
        render();

        let completed = 0;
        let failed = 0;
        try {
            const baseFolder = ($('output')?.value || '').trim() || await window.electronAPI.getDownloadsPath();
            if (!baseFolder) throw new Error('请选择保存目录');
            if ($('output') && !$('output').value) $('output').value = baseFolder;
            const taskName = ($('task-folder')?.value || '').trim() || '第一期';

            for (let i = 0; i < validRows.length; i++) {
                if (stopping) break;
                const row = validRows[i];
                const seq = String(i + 1).padStart(2, '0');
                const fileName = `${seq}_${sanitizeFilename(row.text)}.mp3`;

                row.state = 'running';
                row.error = '';
                render();
                setStatus(`正在生成 ${i + 1}/${validRows.length}：${fileName}`);

                try {
                    const result = await request('google-tts/save-item', {
                        text: row.text,
                        voice: opts.voice,
                        rate: opts.rate,
                        style: opts.style,
                        baseFolder,
                        taskName,
                        fileName,
                    });
                    row.audio = result.paths?.mp3 || '';
                    row.mp4 = result.paths?.mp4 || '';
                    row.srt = result.paths?.srt || '';
                    row.fileName = result.fileName || fileName;
                    row.baseName = result.baseName || fileName.replace(/\.mp3$/i, '');
                    row.fullAudioBase64 = result.audio_base64 || '';
                    row._fullCacheKey = `${opts.voice}|${opts.rate}|${opts.style}|${String(row.text || '').trim()}`;
                    row._dirtyFull = false;
                    row.state = 'success';
                    row.error = '';
                    lastOutput = result.folder || baseFolder;
                    completed++;
                } catch (err) {
                    row.state = 'error';
                    row.error = err.message;
                    failed++;
                }
                setProgress(i + 1, validRows.length);
                save();
                render();
            }
            setStatus(`${stopping ? '已停止' : '全部完成'}：成功 ${completed} 条${failed ? `，失败 ${failed} 条` : ''} · 目录：${lastOutput}`);
        } catch (error) {
            setStatus('生成失败：' + error.message);
        } finally {
            running = false;
            stopping = false;
            save();
            render();
        }
    }

    async function previewAllGenerated() {
        const generated = rows.filter(r => r.state === 'success' && (r.fullAudioBase64 || r.text));
        if (!generated.length || running) return;
        const btn = $('preview-all');
        if (currentAudio && currentPlayBtn === btn) {
            stopAudio(true);
            setStatus('已停止全部试听');
            return;
        }
        try {
            for (let i = 0; i < generated.length; i++) {
                const row = generated[i];
                setStatus(`正在顺序试听 ${i + 1}/${generated.length}：${row.fileName || row.name}`);
                const opts = currentVoiceSettings();
                const expectedKey = `${opts.voice}|${opts.rate}|${opts.style}|${String(row.text || '').trim()}`;
                let b64 = (row._fullCacheKey === expectedKey && !row._dirtyFull) ? row.fullAudioBase64 : '';
                if (!b64) {
                    const res = await request('google-tts/preview', {
                        text: row.text,
                        voice: opts.voice,
                        rate: opts.rate,
                        style: opts.style,
                    });
                    b64 = res.audio_base64;
                    row.fullAudioBase64 = b64;
                    row._fullCacheKey = expectedKey;
                    row._dirtyFull = false;
                }
                await playAudioBase64(b64, btn, row, null, `试听中 (${i + 1}/${generated.length})`);
            }
            setStatus('全部试听完成');
        } catch (error) {
            setStatus('试听中断：' + error.message);
        } finally {
            if (btn) btn.textContent = '试听全部';
            refreshControls();
        }
    }

    async function createZipArchive() {
        const generated = rows.filter(r => r.state === 'success' && r.audio);
        if (!generated.length || running) {
            setStatus('还没有已生成的音频文件可打包');
            return;
        }
        const baseFolder = ($('output')?.value || '').trim() || await window.electronAPI.getDownloadsPath();
        const taskName = ($('task-folder')?.value || '').trim() || '第一期';
        const formats = selectedZipFormats();
        const label = zipFormatLabel();
        const zipName = `${sanitizeFilename(taskName)}_Google_${label.replace('+', '_')}.zip`;

        const btn = $('create-zip');
        if (btn) btn.disabled = true;
        setStatus(`正在打包 ${label} ZIP…`);

        try {
            const result = await request('google-tts/create-zip', {
                baseFolder,
                taskName,
                zipName,
                formats,
                files: generated.map(r => ({
                    fileName: r.fileName,
                    baseName: r.baseName,
                    paths: { mp3: r.audio, mp4: r.mp4, srt: r.srt },
                })),
            });
            setStatus(`ZIP 已保存：${result.zipPath}`);
            await showOrOpenFile(result.zipPath, false);
        } catch (error) {
            setStatus('打包失败：' + error.message);
        } finally {
            refreshControls();
        }
    }

    document.addEventListener('DOMContentLoaded', async () => {
        if (!$('queue')) return;
        voices = FALLBACK_VOICES;
        populateLanguages('en-US');
        fillVoices('gtrans:en-US');

        try {
            const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
            if (Array.isArray(stored.rows) && stored.rows.length) {
                rows = stored.rows
                    .filter(r => r && typeof r.text === 'string')
                    .map(r => ({ ...r, state: r.state === 'running' ? 'waiting' : (r.state || 'waiting') }));
            }
            if (stored.engine && $('engine')) $('engine').value = stored.engine;
            if (stored.language && $('language')) populateLanguages(stored.language);
            if (stored.voice && $('voice')) fillVoices(stored.voice);
            if (stored.rate && $('rate')) $('rate').value = stored.rate;
            if (stored.style && $('style')) $('style').value = stored.style;
            if (stored.output && $('output')) $('output').value = stored.output;
            if (stored.taskFolder && $('task-folder')) $('task-folder').value = stored.taskFolder;
            if (stored.draft && $('text')) $('text').value = stored.draft;
            if (stored.zipFormat) {
                const targetRadio = zipFormatInputs().find(i => i.value === stored.zipFormat);
                if (targetRadio) targetRadio.checked = true;
            }
            lastOutput = stored.lastOutput || '';
        } catch (_) {
            setStatus('已初始化默认文案列表');
        }

        if ($('output') && !$('output').value && window.electronAPI?.getDownloadsPath) {
            try {
                $('output').value = await window.electronAPI.getDownloadsPath();
            } catch (_) {}
        }

        ensureAtLeastOneRow();

        $('add').onclick = () => {
            const text = $('text').value;
            const mode = $('split').value;
            const parts = mode === 'cells'
                ? parseCells(text)
                : mode === 'whole'
                    ? [text]
                    : text.split(mode === 'line' ? /\r?\n/ : /\r?\n\s*\r?\n/);
            parts.forEach(t => appendTextRow(t));
            $('text').value = '';
            save();
            render();
        };

        $('new').onclick = () => {
            rows.push({
                id: crypto.randomUUID(),
                text: '',
                name: '文案 ' + (rows.length + 1),
                state: 'waiting',
                audio: '',
                mp4: '',
                srt: '',
                fileName: '',
                baseName: '',
                error: '',
            });
            save();
            render();
            const lastCardTextarea = $('queue')?.lastElementChild?.querySelector('textarea');
            if (lastCardTextarea) lastCardTextarea.focus();
        };

        $('text').addEventListener('paste', event => {
            if (running || !event.clipboardData) return;
            const cells = clipboardCells(event.clipboardData);
            if (!cells) return;
            event.preventDefault();
            let added = 0;
            cells.forEach(t => {
                if (String(t || '').trim()) {
                    appendTextRow(t);
                    added++;
                }
            });
            save();
            render();
            setStatus(`已从粘贴内容添加 ${added} 条文案`);
        });

        if ($('engine')) {
            $('engine').onchange = () => {
                fillVoices();
                save();
            };
        }

        $('language').onchange = () => {
            if ($('voice-search')) $('voice-search').value = '';
            fillVoices();
            save();
        };

        $('import').onclick = () => $('files').click();
        $('files').onchange = async event => {
            try {
                for (const file of event.target.files) {
                    appendTextRow(await file.text(), file.name.replace(/\.txt$/i, ''));
                }
                save();
                render();
            } catch (error) {
                setStatus('导入失败：' + error.message);
            }
            event.target.value = '';
        };

        $('clear').onclick = () => {
            if (rows.length && rows.some(r => r.text.trim()) && !confirm('确定清空当前文案列表？（已保存到本地磁盘的音频文件会保留）')) return;
            stopAudio(true);
            rows = [];
            ensureAtLeastOneRow();
            setProgress(0, 0);
            save();
            render();
            setStatus('已清空文案列表');
        };

        $('choose-output').onclick = async () => {
            try {
                const dir = await window.electronAPI.selectDirectory();
                if (dir) {
                    $('output').value = dir;
                    save();
                }
            } catch (e) {
                setStatus(e.message);
            }
        };

        $('open-output').onclick = async () => {
            try {
                const base = ($('output')?.value || '').trim() || await window.electronAPI.getDownloadsPath();
                const task = ($('task-folder')?.value || '').trim();
                const target = lastOutput || (task ? `${base.replace(/[\\/]+$/, '')}/${task}` : base);
                if (target) await window.electronAPI.openPath(target);
            } catch (e) {
                setStatus(e.message);
            }
        };

        $('refresh').onclick = () => loadVoices(true);
        if ($('toggle-key-box') && $('key-drawer')) {
            $('toggle-key-box').onclick = () => {
                const open = $('key-drawer').style.display !== 'none';
                $('key-drawer').style.display = open ? 'none' : 'block';
                if (!open && $('api-keys')) $('api-keys').focus();
            };
        }
        if ($('save-keys')) {
            $('save-keys').onclick = async () => {
                const raw = ($('api-keys')?.value || '').split('\n').map(k => k.trim()).filter(Boolean);
                const ttsModel = $('tts-model')?.value || 'gemini-2.5-flash-preview-tts';
                const statusEl = $('key-test-status');
                try {
                    await request('google-tts/keys', { tts_keys: raw, tts_model: ttsModel, syncAllKeys: true });
                    const settingsTtsEl = document.getElementById('gemini-tts-keys');
                    if (settingsTtsEl) {
                        settingsTtsEl.value = raw.join('\n');
                        if (typeof window.refreshKeyTable === 'function') window.refreshKeyTable('gemini-tts-keys');
                    }
                    const settingsModelEl = document.getElementById('gemini-tts-model');
                    if (settingsModelEl) settingsModelEl.value = ttsModel;
                    if (statusEl) {
                        statusEl.style.color = '#6ee7b7';
                        statusEl.textContent = `✅ 已保存 ${raw.length} 个 Gemini TTS API Key`;
                    }
                    await loadVoices(true);
                } catch (err) {
                    if (statusEl) {
                        statusEl.style.color = '#ff8a8a';
                        statusEl.textContent = '❌ 保存失败: ' + err.message;
                    }
                }
            };
        }
        if ($('test-keys')) {
            $('test-keys').onclick = async () => {
                const raw = ($('api-keys')?.value || '').split('\n').map(k => k.trim()).filter(Boolean);
                const ttsModel = $('tts-model')?.value || 'gemini-2.5-flash-preview-tts';
                const statusEl = $('key-test-status');
                if (!raw.length) {
                    if (statusEl) {
                        statusEl.style.color = '#fbbf24';
                        statusEl.textContent = '⚠️ 请先在输入框粘贴至少一个 Gemini API Key';
                    }
                    return;
                }
                if (statusEl) {
                    statusEl.style.color = 'var(--ms-muted)';
                    statusEl.textContent = `⏳ 正在测试 ${raw.length} 个 Key (${ttsModel})...`;
                }
                try {
                    const data = await request('google-tts/test-keys', { keys: raw, model: ttsModel });
                    const results = Array.isArray(data.results) ? data.results : [];
                    const pass = results.filter(r => r.valid).length;
                    if (statusEl) {
                        statusEl.style.color = pass > 0 ? '#6ee7b7' : '#ff8a8a';
                        statusEl.textContent = results.map(r => `${r.masked}: ${r.message}`).join('\n');
                    }
                } catch (err) {
                    if (statusEl) {
                        statusEl.style.color = '#ff8a8a';
                        statusEl.textContent = '❌ 测试失败: ' + err.message;
                    }
                }
            };
        }
        window.addEventListener('vk-gemini-tts-keys-updated', () => loadVoices(false));
        $('voice-search').oninput = () => fillVoices();
        $('voice').onchange = () => {
            rows.forEach(r => { r._dirtyPreview = true; r._dirtyFull = true; });
            save();
        };
        $('rate').onchange = () => {
            rows.forEach(r => { r._dirtyPreview = true; r._dirtyFull = true; });
            save();
        };
        if ($('style')) {
            $('style').onchange = () => {
                rows.forEach(r => { r._dirtyPreview = true; r._dirtyFull = true; });
                save();
            };
        }
        if ($('output')) $('output').oninput = save;
        if ($('task-folder')) $('task-folder').oninput = save;
        $('text').oninput = save;

        for (const input of zipFormatInputs()) {
            input.addEventListener('change', () => {
                refreshControls();
                save();
            });
        }

        $('start').onclick = startBatchGenerate;
        $('stop').onclick = () => {
            stopping = true;
            setStatus('将在当前任务完成后停止，剩余任务可稍后继续');
            render();
        };
        if ($('preview-all')) $('preview-all').onclick = previewAllGenerated;
        if ($('create-zip')) $('create-zip').onclick = createZipArchive;

        const tabBtn = document.querySelector('[data-tab="google-tts"]');
        if (tabBtn) {
            tabBtn.addEventListener('click', () => {
                loadVoices(false);
            });
        }

        render();
        setTimeout(() => {
            if (document.getElementById('google-tts-panel')?.classList.contains('active')) loadVoices(false);
        }, 2200);
    });
})();
