/* Standalone Edge speech batch workshop (Clipchamp Voice Studio layout). */
(() => {
    const KEY = 'videokit_microsoft_tts_queue_v1';
    const FALLBACK_VOICES = [
        { voice_id: 'edge:en-US-AvaMultilingualNeural', ShortName: 'en-US-AvaMultilingualNeural', Locale: 'en-US', locale: 'en-US', DisplayName: 'Ava Multilingual', LocalName: 'Ava Multilingual', Gender: 'Female', gender: 'Female' },
        { voice_id: 'edge:en-US-EmmaMultilingualNeural', ShortName: 'en-US-EmmaMultilingualNeural', Locale: 'en-US', locale: 'en-US', DisplayName: 'Emma Multilingual', LocalName: 'Emma Multilingual', Gender: 'Female', gender: 'Female' },
        { voice_id: 'edge:en-US-AndrewMultilingualNeural', ShortName: 'en-US-AndrewMultilingualNeural', Locale: 'en-US', locale: 'en-US', DisplayName: 'Andrew Multilingual', LocalName: 'Andrew Multilingual', Gender: 'Male', gender: 'Male' },
        { voice_id: 'edge:en-US-AriaNeural', ShortName: 'en-US-AriaNeural', Locale: 'en-US', locale: 'en-US', DisplayName: 'Aria', LocalName: 'Aria', Gender: 'Female', gender: 'Female' },
        { voice_id: 'edge:en-US-GuyNeural', ShortName: 'en-US-GuyNeural', Locale: 'en-US', locale: 'en-US', DisplayName: 'Guy', LocalName: 'Guy', Gender: 'Male', gender: 'Male' },
        { voice_id: 'edge:en-GB-SoniaNeural', ShortName: 'en-GB-SoniaNeural', Locale: 'en-GB', locale: 'en-GB', DisplayName: 'Sonia', LocalName: 'Sonia', Gender: 'Female', gender: 'Female' },
        { voice_id: 'edge:en-GB-RyanNeural', ShortName: 'en-GB-RyanNeural', Locale: 'en-GB', locale: 'en-GB', DisplayName: 'Ryan', LocalName: 'Ryan', Gender: 'Male', gender: 'Male' },
        { voice_id: 'edge:zh-CN-XiaoxiaoNeural', ShortName: 'zh-CN-XiaoxiaoNeural', Locale: 'zh-CN', locale: 'zh-CN', DisplayName: 'Xiaoxiao', LocalName: '晓晓', Gender: 'Female', gender: 'Female' },
        { voice_id: 'edge:zh-CN-YunxiNeural', ShortName: 'zh-CN-YunxiNeural', Locale: 'zh-CN', locale: 'zh-CN', DisplayName: 'Yunxi', LocalName: '云希', Gender: 'Male', gender: 'Male' },
        { voice_id: 'edge:zh-CN-YunjianNeural', ShortName: 'zh-CN-YunjianNeural', Locale: 'zh-CN', locale: 'zh-CN', DisplayName: 'Yunjian', LocalName: '云健', Gender: 'Male', gender: 'Male' },
        { voice_id: 'edge:it-IT-ElsaNeural', ShortName: 'it-IT-ElsaNeural', Locale: 'it-IT', locale: 'it-IT', DisplayName: 'Elsa', LocalName: 'Elsa', Gender: 'Female', gender: 'Female' },
        { voice_id: 'edge:it-IT-DiegoNeural', ShortName: 'it-IT-DiegoNeural', Locale: 'it-IT', locale: 'it-IT', DisplayName: 'Diego', LocalName: 'Diego', Gender: 'Male', gender: 'Male' },
    ];

    let rows = [];
    let voices = [];
    let running = false;
    let stopping = false;
    let lastOutput = '';
    let requestNumber = 0;

    let currentAudio = null;
    let currentAudioUrl = '';
    let currentPlayBtn = null;
    let currentPlayRowId = '';
    let previewRunId = 0;

    const $ = id => document.getElementById('ms-' + id);
    const zipFormatInputs = () => [...document.querySelectorAll('input[name="msZipFormat"]')];

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
                language: $('language')?.value || 'en-US',
                voice: $('voice')?.value || 'edge:en-US-AvaMultilingualNeural',
                rate: $('rate')?.value || '+0%',
                pitch: $('pitch')?.value || '+0Hz',
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
        const blob = new Blob([bytes], { type: 'audio/mpeg' });
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
            voice: $('voice')?.value || 'edge:en-US-AvaMultilingualNeural',
            rate: $('rate')?.value || '+0%',
            pitch: $('pitch')?.value || '+0Hz',
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
        const cacheKey = `${opts.voice}|${opts.rate}|${opts.pitch}|${sampleText}`;

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
            const res = await request('edge-tts/preview', {
                text: sampleText,
                voice: opts.voice,
                rate: opts.rate,
                pitch: opts.pitch,
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
        for (const id of ['language', 'new', 'add', 'import', 'clear', 'choose-output', 'voice', 'rate', 'pitch', 'voice-search', 'refresh', 'split', 'text', 'task-folder', 'output']) {
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
        if (!locale || locale === 'all') return '全部语言';
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
        const shortName = String(v.ShortName || v.voice_id || '').replace(/^edge:/, '');
        const localName = v.LocalName || v.DisplayName || shortName;
        const gender = v.gender === 'Female' || v.Gender === 'Female' ? 'Female (女声)'
            : v.gender === 'Male' || v.Gender === 'Male' ? 'Male (男声)'
            : (v.gender || v.Gender || '');
        return `${localName}${gender ? ' · ' + gender : ''} · ${shortName}`;
    }

    function populateLanguages(preferredLocale) {
        const select = $('language');
        if (!select) return;
        const current = preferredLocale || select.value || 'en-US';
        const locales = [...new Set(voices.map(v => v.locale || v.Locale).filter(Boolean))]
            .sort((a, b) => {
                if (a === 'en-US') return -1;
                if (b === 'en-US') return 1;
                if (a.startsWith('en-') !== b.startsWith('en-')) return a.startsWith('en-') ? -1 : 1;
                if (a.startsWith('zh-') !== b.startsWith('zh-')) return a.startsWith('zh-') ? -1 : 1;
                return localeLabel(a).localeCompare(localeLabel(b), 'zh-CN');
            });

        select.replaceChildren(new Option('全部语言 (All)', 'all'));
        for (const loc of locales) {
            select.add(new Option(localeLabel(loc), loc));
        }
        if (current === 'all' || locales.includes(current)) {
            select.value = current;
        } else if (current === 'en' && locales.includes('en-US')) {
            select.value = 'en-US';
        } else if (locales.includes('en-US')) {
            select.value = 'en-US';
        } else if (locales.length) {
            select.value = locales[0];
        }
    }

    function fillVoices(selectedVoiceId = $('voice')?.value) {
        const select = $('voice');
        if (!select) return;
        const q = ($('voice-search')?.value || '').trim().toLowerCase().replace('中文', 'zh-');
        const lang = $('language')?.value || 'en-US';

        const filtered = voices.filter(v => {
            const loc = v.locale || v.Locale || '';
            const matchLang = lang === 'all' || loc === lang || loc.split('-')[0] === lang;
            if (!matchLang) return false;
            if (!q) return true;
            const hay = `${v.voice_id} ${v.ShortName || ''} ${v.LocalName || ''} ${v.DisplayName || ''} ${v.name || ''} ${loc} ${v.gender || ''}`.toLowerCase();
            return hay.includes(q);
        });

        select.replaceChildren();
        for (const v of filtered) {
            const vid = v.voice_id.startsWith('edge:') ? v.voice_id : `edge:${v.ShortName || v.voice_id}`;
            select.add(new Option(voiceDisplayLabel(v), vid));
        }

        const normalizedSelected = selectedVoiceId
            ? (selectedVoiceId.startsWith('edge:') ? selectedVoiceId : `edge:${selectedVoiceId}`)
            : '';

        if (normalizedSelected && filtered.some(v => v.voice_id === normalizedSelected)) {
            select.value = normalizedSelected;
        } else {
            const preferred = [
                'edge:en-US-AvaMultilingualNeural',
                'edge:en-US-EmmaMultilingualNeural',
                'edge:en-US-AriaNeural',
                'edge:zh-CN-XiaoxiaoNeural',
            ].find(id => filtered.some(v => v.voice_id === id));
            if (preferred) select.value = preferred;
            else if (filtered[0]) select.value = filtered[0].voice_id;
        }

        if (select.value !== normalizedSelected) {
            rows.forEach(r => { r._dirtyPreview = true; r._dirtyFull = true; });
        }

        if ($('voice-status')) {
            $('voice-status').textContent = `显示 ${filtered.length} / ${voices.length} 个微软音色`;
        }
    }

    async function loadVoices(forceRefresh = false) {
        const number = ++requestNumber;
        const selectedVoice = $('voice')?.value;
        const selectedLang = $('language')?.value;
        if ($('voice-status')) $('voice-status').textContent = '正在加载微软音色…';
        try {
            const data = await request('edge-tts/voices', { refresh: forceRefresh === true });
            if (number !== requestNumber) return;
            voices = (Array.isArray(data.voices) && data.voices.length ? data.voices : FALLBACK_VOICES).map(v => ({
                ...v,
                voice_id: String(v.voice_id || v.ShortName || '').startsWith('edge:')
                    ? String(v.voice_id || v.ShortName)
                    : `edge:${v.ShortName || v.voice_id}`,
                locale: v.locale || v.Locale || 'en-US',
                gender: v.gender || v.Gender || '',
            }));
            populateLanguages(selectedLang);
            fillVoices(selectedVoice);
            setStatus(data.status === 'fallback' ? '已加载内置常用语音列表' : `已加载 ${voices.length} 个语音，默认英文`);
            save();
        } catch (error) {
            if (number !== requestNumber) return;
            voices = FALLBACK_VOICES;
            populateLanguages(selectedLang);
            fillVoices(selectedVoice);
            if ($('voice-status')) $('voice-status').textContent = '使用内置常用音色';
            setStatus('已加载内置常用音色');
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
        if (!opts.voice.startsWith('edge:')) {
            setStatus('请先选择一个微软音色');
            return;
        }
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
                    const result = await request('edge-tts/save-item', {
                        text: row.text,
                        voice: opts.voice,
                        rate: opts.rate,
                        pitch: opts.pitch,
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
                    row._fullCacheKey = `${opts.voice}|${opts.rate}|${opts.pitch}|${String(row.text || '').trim()}`;
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
                const expectedKey = `${opts.voice}|${opts.rate}|${opts.pitch}|${String(row.text || '').trim()}`;
                let b64 = (row._fullCacheKey === expectedKey && !row._dirtyFull) ? row.fullAudioBase64 : '';
                if (!b64) {
                    const res = await request('edge-tts/preview', {
                        text: row.text,
                        voice: opts.voice,
                        rate: opts.rate,
                        pitch: opts.pitch,
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
        const zipName = `${sanitizeFilename(taskName)}_${label.replace('+', '_')}.zip`;

        const btn = $('create-zip');
        if (btn) btn.disabled = true;
        setStatus(`正在打包 ${label} ZIP…`);

        try {
            const result = await request('edge-tts/create-zip', {
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
        voices = FALLBACK_VOICES;
        populateLanguages('en-US');
        fillVoices('edge:en-US-AvaMultilingualNeural');

        try {
            const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
            if (Array.isArray(stored.rows) && stored.rows.length) {
                rows = stored.rows
                    .filter(r => r && typeof r.text === 'string')
                    .map(r => ({ ...r, state: r.state === 'running' ? 'waiting' : (r.state || 'waiting') }));
            }
            if (stored.language && $('language')) {
                populateLanguages(stored.language);
            }
            if (stored.voice && $('voice')) {
                fillVoices(stored.voice);
            }
            if (stored.rate && $('rate')) $('rate').value = stored.rate;
            if (stored.pitch && $('pitch')) $('pitch').value = stored.pitch;
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
        $('voice-search').oninput = () => fillVoices();
        $('voice').onchange = () => {
            rows.forEach(r => { r._dirtyPreview = true; r._dirtyFull = true; });
            save();
        };
        $('rate').onchange = () => {
            rows.forEach(r => { r._dirtyPreview = true; r._dirtyFull = true; });
            save();
        };
        if ($('pitch')) {
            $('pitch').onchange = () => {
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

        const tabBtn = document.querySelector('[data-tab="microsoft-tts"]');
        if (tabBtn) {
            tabBtn.addEventListener('click', () => {
                if (voices.length <= FALLBACK_VOICES.length) loadVoices(false);
            });
        }

        render();
        setTimeout(() => {
            if (document.getElementById('microsoft-tts-panel')?.classList.contains('active')) loadVoices(false);
        }, 2000);
    });
})();
