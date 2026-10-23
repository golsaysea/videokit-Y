/**
 * Cloud transcription adapters with a provider-level fallback.
 * All callers receive Gladia-compatible utterances so subtitle alignment and
 * auto editing do not need to care which provider produced the timestamps.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { extractAudioFromVideo, splitAudioOnSilence } = require('./gladia');
const gladiaService = require('./gladia');
const settings = require('./settings');

const PROVIDER_LABEL = { deepgram: 'Deepgram', groq: 'Groq', gladia: 'Gladia' };

// Gladia 的并发槽按 Key 独占。auto-edit 可同时跑多个任务，每个任务又可
// 同时转录多个片段；只有在这里统一排队，才能避免每个任务各自开池后把同一个
// Key 打满。一个请求占用一个 Key，直到该媒体的上传、转录和轮询全部完成。
const activeGladiaKeys = new Set();
const gladiaWaiters = [];
let gladiaKeyCursor = 0;

function normalizeGladiaKeys(keys = []) {
    return [...new Set(keys.map(key => String(key || '').trim()).filter(Boolean))];
}

function chooseAvailableGladiaKey(keys) {
    if (!keys.length) return null;
    for (let offset = 0; offset < keys.length; offset++) {
        const index = (gladiaKeyCursor + offset) % keys.length;
        if (!activeGladiaKeys.has(keys[index])) {
            gladiaKeyCursor = (index + 1) % keys.length;
            return keys[index];
        }
    }
    return null;
}

function acquireGladiaKey(keys, signal) {
    const candidates = normalizeGladiaKeys(keys);
    if (!candidates.length) return Promise.reject(new Error('Gladia 未配置 API Key'));
    const available = chooseAvailableGladiaKey(candidates);
    if (available) {
        activeGladiaKeys.add(available);
        return Promise.resolve({ key: available, release: () => releaseGladiaKey(available) });
    }
    return new Promise((resolve, reject) => {
        const waiter = { candidates, resolve, reject, signal, abort: null };
        waiter.abort = () => {
            const index = gladiaWaiters.indexOf(waiter);
            if (index >= 0) gladiaWaiters.splice(index, 1);
            reject(new Error('任务已停止'));
        };
        if (signal?.aborted) return waiter.abort();
        signal?.addEventListener?.('abort', waiter.abort, { once: true });
        gladiaWaiters.push(waiter);
    });
}

function releaseGladiaKey(key) {
    activeGladiaKeys.delete(key);
    for (let index = 0; index < gladiaWaiters.length; index++) {
        const waiter = gladiaWaiters[index];
        if (!waiter.candidates.includes(key)) continue;
        gladiaWaiters.splice(index, 1);
        waiter.signal?.removeEventListener?.('abort', waiter.abort);
        activeGladiaKeys.add(key);
        waiter.resolve({ key, release: () => releaseGladiaKey(key) });
        return;
    }
}

function request({ url, method = 'POST', headers = {}, body, timeout = 120000, signal }) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        let settled = false;
        let timer;
        const done = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', abort);
            fn(value);
        };
        const req = https.request({ hostname: target.hostname, path: target.pathname + target.search, method, headers, timeout }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => done(resolve, { status: res.statusCode, body: Buffer.concat(chunks) }));
        });
        const abort = () => { req.destroy(); done(reject, new Error('任务已停止')); };
        if (signal?.aborted) return abort();
        signal?.addEventListener?.('abort', abort, { once: true });
        timer = setTimeout(() => { req.destroy(); done(reject, new Error('请求总超时（120 秒）')); }, timeout);
        req.on('timeout', () => { req.destroy(); done(reject, new Error('请求超时')); });
        req.on('error', error => done(reject, signal?.aborted ? new Error('任务已停止') : error));
        if (body) req.write(body);
        req.end();
    });
}

function parseResponse(provider, response) {
    const text = response.body.toString('utf8');
    if (response.status < 200 || response.status >= 300) {
        let message = text;
        try { message = JSON.parse(text).error?.message || JSON.parse(text).err_msg || JSON.parse(text).message || text; } catch { }
        throw new Error(`${PROVIDER_LABEL[provider]} HTTP ${response.status}: ${String(message).slice(0, 300)}`);
    }
    try { return JSON.parse(text); } catch { throw new Error(`${PROVIDER_LABEL[provider]} 返回了无效响应`); }
}

function multipart(filePath, fields) {
    const boundary = `----VideoKit${crypto.randomUUID().replaceAll('-', '')}`;
    const chunks = [];
    for (const [name, value] of Object.entries(fields)) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\nContent-Type: audio/wav\r\n\r\n`));
    chunks.push(fs.readFileSync(filePath));
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function normalizeToIsoCode(language) {
    if (!language || language === 'auto') return '';
    const clean = String(language).toLowerCase().trim();
    if (clean === 'en' || clean === 'english' || clean === '英语') return 'en';
    if (clean === 'zh' || clean === 'chinese' || clean === '中文' || clean === 'zh-cn' || clean === 'mandarin') return 'zh';
    if (clean === 'ja' || clean === 'japanese' || clean === '日语') return 'ja';
    if (clean === 'ko' || clean === 'korean' || clean === '韩语') return 'ko';
    if (clean === 'de' || clean === 'german' || clean === '德语') return 'de';
    if (clean === 'fr' || clean === 'french' || clean === '法语') return 'fr';
    if (clean === 'es' || clean === 'spanish' || clean === '西班牙语') return 'es';
    if (clean === 'ru' || clean === 'russian' || clean === '俄语') return 'ru';
    try {
        const { LANGUAGES } = require('./subtitleUtils');
        for (const [code, info] of Object.entries(LANGUAGES || {})) {
            if (code === clean || info.language?.toLowerCase() === clean || info.name === clean) return code;
        }
    } catch (_) { }
    return clean;
}

function formatTimeWithMs(timestamp) {
    const d = new Date(timestamp || Date.now());
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function getRecordsFilePath() {
    return path.join(settings.getSecureTmpDir('videokit_log'), 'transcription_records.json');
}

let transcriptionRecords = null;

function loadTranscriptionRecords() {
    try {
        const file = getRecordsFilePath();
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Array.isArray(data)) return data;
        }
    } catch (_) { }
    return [];
}

function getTranscriptionRecords() {
    if (!transcriptionRecords) {
        transcriptionRecords = loadTranscriptionRecords();
    }
    return transcriptionRecords;
}

function saveTranscriptionRecords() {
    try {
        const file = getRecordsFilePath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify((transcriptionRecords || []).slice(0, 500), null, 2), 'utf8');
    } catch (_) { }
}

function addTranscriptionRecord(record) {
    const list = getTranscriptionRecords();
    list.unshift(record);
    if (list.length > 500) list.length = 500;
    saveTranscriptionRecords();
}

function updateTranscriptionRecord(id, updates) {
    const list = getTranscriptionRecords();
    const item = list.find(r => r.id === id);
    if (item) {
        Object.assign(item, updates);
        saveTranscriptionRecords();
    }
}

function clearTranscriptionRecords() {
    transcriptionRecords = [];
    try {
        const file = getRecordsFilePath();
        if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) { }
}

async function transcribeSegment(provider, filePath, key, language, signal, meta = {}) {
    const iso = normalizeToIsoCode(language);
    const recordId = crypto.randomUUID();
    const startTime = Date.now();
    const sendTimeStr = formatTimeWithMs(startTime);
    let fileSizeStr = '';
    try {
        const sz = fs.statSync(filePath).size;
        fileSizeStr = (sz / 1024).toFixed(1) + ' KB';
    } catch (_) { }

    const maskKey = (k) => {
        const s = String(k || '');
        return s.length > 8 ? `${s.slice(0, 4)}••••${s.slice(-4)}` : '••••••••';
    };

    const promptHint = String(meta.promptHint || '').trim().slice(0, 600);
    const musicMode = !!meta.musicMode;
    const baseModelName = provider === 'deepgram' ? 'nova-3'
        : (provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper');
    const modelName = (provider === 'groq' && (musicMode || promptHint))
        ? `${baseModelName} (${musicMode ? 'MV歌唱增强' : '歌词引导'})`
        : baseModelName;

    const record = {
        id: recordId,
        mediaName: meta.mediaName || path.basename(meta.mediaPath || filePath),
        segmentIndex: (meta.segmentIndex !== undefined ? meta.segmentIndex + 1 : 1),
        totalSegments: meta.totalSegments || 1,
        provider,
        providerLabel: PROVIDER_LABEL[provider] || provider,
        model: modelName,
        language: iso || language || 'auto',
        fileSize: fileSizeStr,
        keyPreview: maskKey(key),
        sendTime: sendTimeStr,
        status: 'sending',
        durationMs: null,
        durationSec: null,
        finishTime: null,
        textPreview: '',
        wordsCount: 0,
        error: null,
    };
    addTranscriptionRecord(record);

    console.log(`[云端转录] 🚀 [${record.providerLabel}] 发送切片 [${record.mediaName}] (${record.segmentIndex}/${record.totalSegments}) 模型: ${modelName} 大小: ${record.fileSize} 时间: ${record.sendTime}`);

    try {
        let result;
        if (provider === 'groq') {
            const form = multipart(filePath, {
                // Groq 已于 2025-08-23 下线 distil-whisper-large-v3-en；
                // Turbo 是官方推荐替代，并支持英语及多语言转录。
                // 传入歌词/文案 prompt 可显著提升唱歌MV/伴奏下的人声识别准确率。
                model: 'whisper-large-v3-turbo',
                response_format: 'verbose_json',
                'timestamp_granularities[]': 'word',
                ...(iso ? { language: iso } : {}),
                ...(promptHint ? { prompt: promptHint } : {}),
            });
            const data = parseResponse('groq', await request({
                url: 'https://api.groq.com/openai/v1/audio/transcriptions',
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': form.contentType, 'Content-Length': form.body.length }, body: form.body, signal,
            }));
            let rawWords = Array.isArray(data.words) ? data.words : [];
            if (!rawWords.length && Array.isArray(data.segments)) {
                for (const seg of data.segments) {
                    if (Array.isArray(seg.words) && seg.words.length) {
                        rawWords.push(...seg.words);
                    } else if (seg.text && String(seg.text).trim()) {
                        const segStart = Number(seg.start || 0);
                        const segEnd = Math.max(segStart + 0.4, Number(seg.end || segStart + 1));
                        const cleanSeg = String(seg.text).trim();
                        const tokens = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(cleanSeg)
                            ? Array.from(cleanSeg).filter(c => c.trim())
                            : cleanSeg.split(/\s+/).filter(Boolean);
                        const step = (segEnd - segStart) / Math.max(1, tokens.length);
                        tokens.forEach((w, idx) => {
                            rawWords.push({ word: w, start: segStart + step * idx, end: segStart + step * (idx + 1) });
                        });
                    }
                }
            }
            result = { text: data.text || '', words: rawWords };
        } else {
            const body = fs.readFileSync(filePath);
            const deepgramLang = iso || 'en';
            const query = new URLSearchParams({
                model: 'nova-3',
                language: deepgramLang,
                smart_format: 'true',
                punctuate: 'true',
            });
            const data = parseResponse('deepgram', await request({
                url: `https://api.deepgram.com/v1/listen?${query.toString()}`,
                headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav', 'Content-Length': body.length }, body, signal,
            }));
            const alternative = data.results?.channels?.[0]?.alternatives?.[0] || {};
            result = { text: alternative.transcript || '', words: Array.isArray(alternative.words) ? alternative.words : [] };
        }

        const durationMs = Date.now() - startTime;
        const durationSec = (durationMs / 1000).toFixed(2) + 's';
        const finishTime = formatTimeWithMs(Date.now());
        const textPreview = (result.text || '').trim().slice(0, 80);
        const wordsCount = Array.isArray(result.words) ? result.words.length : 0;

        updateTranscriptionRecord(recordId, {
            status: 'success',
            durationMs,
            durationSec,
            finishTime,
            textPreview,
            wordsCount,
        });

        console.log(`[云端转录] ⚡ [${record.providerLabel}] 完成切片 [${record.mediaName}] (${record.segmentIndex}/${record.totalSegments}) 耗时: ${durationSec} 识别字数: ${wordsCount} 文字: "${textPreview}"`);

        return result;
    } catch (error) {
        const durationMs = Date.now() - startTime;
        const durationSec = (durationMs / 1000).toFixed(2) + 's';
        const finishTime = formatTimeWithMs(Date.now());

        updateTranscriptionRecord(recordId, {
            status: 'failed',
            durationMs,
            durationSec,
            finishTime,
            error: error.message,
        });

        console.warn(`[云端转录] ❌ [${record.providerLabel}] 切片失败 [${record.mediaName}] (${record.segmentIndex}/${record.totalSegments}) 耗时: ${durationSec} 错误: ${error.message}`);
        throw error;
    }
}

async function transcribeProvider(mediaPath, provider, keys, language, jsonPath, txtPath, minMinutes, onProgress, signal, options = {}) {
    if (!keys?.length) throw new Error(`${PROVIDER_LABEL[provider]} 未配置 API Key`);
    if (provider === 'gladia') {
        // 不让同一 Gladia Key 同时处理两个媒体。这样“每任务 3 路 × 同时 2
        // 个任务”在配置 6 个 Key 时恰好可以跑满 6 路，第 7 路自动排队。
        const slot = await acquireGladiaKey(keys, signal);
        const recordId = crypto.randomUUID();
        const startTime = Date.now();
        const record = {
            id: recordId,
            mediaName: path.basename(mediaPath),
            segmentIndex: 1,
            totalSegments: 1,
            provider: 'gladia',
            providerLabel: 'Gladia',
            model: options?.musicMode ? 'whisper (MV歌唱增强)' : 'whisper',
            language: language || 'auto',
            fileSize: '',
            keyPreview: `${slot.key.slice(0, 4)}••••${slot.key.slice(-4)}`,
            sendTime: formatTimeWithMs(startTime),
            status: 'sending',
            durationMs: null,
            durationSec: null,
            finishTime: null,
            textPreview: '',
            wordsCount: 0,
            error: null,
        };
        addTranscriptionRecord(record);
        console.log(`[云端转录] 🚀 [Gladia] 发送请求 [${record.mediaName}] 时间: ${record.sendTime}`);
        try {
            const result = await gladiaService.transcribeAudioFull(mediaPath, [slot.key], language, jsonPath, txtPath, minMinutes, onProgress, signal, options);
            const durationMs = Date.now() - startTime;
            const durationSec = (durationMs / 1000).toFixed(2) + 's';
            const finishTime = formatTimeWithMs(Date.now());
            const textPreview = (result.fullText || '').trim().slice(0, 80);
            const wordsCount = Array.isArray(result.wordTimeInfo) ? result.wordTimeInfo.reduce((acc, u) => acc + (u.words?.length || 0), 0) : 0;
            updateTranscriptionRecord(recordId, {
                status: 'success',
                durationMs,
                durationSec,
                finishTime,
                textPreview,
                wordsCount,
            });
            console.log(`[云端转录] ⚡ [Gladia] 完成转录 [${record.mediaName}] 耗时: ${durationSec} 字数: ${wordsCount}`);
            return { ...result, provider };
        } catch (err) {
            const durationMs = Date.now() - startTime;
            const durationSec = (durationMs / 1000).toFixed(2) + 's';
            const finishTime = formatTimeWithMs(Date.now());
            updateTranscriptionRecord(recordId, {
                status: 'failed',
                durationMs,
                durationSec,
                finishTime,
                error: err.message,
            });
            console.warn(`[云端转录] ❌ [Gladia] 转录失败 [${record.mediaName}] 耗时: ${durationSec} 错误: ${err.message}`);
            throw err;
        } finally {
            slot.release();
        }
    }
    const tmpDir = path.join(settings.getSecureTmpDir(), `transcription_${provider}_${crypto.randomUUID()}`);
    try {
        onProgress?.(`🎙️ [${PROVIDER_LABEL[provider]}] ${options?.musicMode ? '正在提取并提纯音乐人声...' : '正在提取音频...'}`);
        const audioPath = await extractAudioFromVideo(mediaPath, tmpDir, 'wav', signal, options);
        // Groq's standard upload limit is 25 MB.  32 kHz mono WAV is roughly
        // 3.8 MB/minute, so cap chunks at the caller's five-minute default.
        const effectiveMinMinutes = options?.musicMode ? Math.max(6, Number(minMinutes) || 5) : minMinutes;
        const segments = await splitAudioOnSilence(audioPath, tmpDir, effectiveMinMinutes, Math.max(1, effectiveMinMinutes), 'wav');
        const utterances = [], texts = [];
        let offset = 0;
        for (let index = 0; index < segments.length; index++) {
            if (signal?.aborted) throw new Error('任务已停止');
            onProgress?.(`🎙️ [${PROVIDER_LABEL[provider]}] 转录进度 ${index + 1}/${segments.length}`);
            let result, lastError;
            for (const key of keys) {
                try {
                    result = await transcribeSegment(provider, segments[index].path, key, language, signal, {
                        mediaPath,
                        mediaName: path.basename(mediaPath),
                        segmentIndex: index,
                        totalSegments: segments.length,
                        promptHint: options?.promptHint || '',
                        musicMode: !!options?.musicMode,
                    });
                    break;
                } catch (error) {
                    lastError = error;
                    if (signal?.aborted) throw error;
                }
            }
            if (!result) throw lastError || new Error(`${PROVIDER_LABEL[provider]} 未返回结果`);
            let words = result.words.map(rawWord => {
                // Deepgram 同时返回 word（裸词）和 punctuated_word（带标点）。
                // Groq 的 word 有时会携带前导空白。统一保留标点、移除词边界
                // 的空白，才能让“逐词拼出的文本”和 API 返回全文一致。
                const word = String(rawWord.punctuated_word || rawWord.word || '').trim();
                return {
                    word,
                    start: Number(rawWord.start || 0) + offset,
                    end: Number(rawWord.end || 0) + offset,
                    confidence: Number(rawWord.confidence ?? 0),
                };
            }).filter(word => word.word);
            if (result.text?.trim() && !words.length) {
                const cleanSegText = String(result.text).trim();
                const tokens = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(cleanSegText)
                    ? Array.from(cleanSegText).filter(c => c.trim())
                    : cleanSegText.split(/\s+/).filter(Boolean);
                const segDur = Math.max(0.4, Number(segments[index].duration) || tokens.length * 0.25);
                const step = segDur / Math.max(1, tokens.length);
                words = tokens.map((w, wIdx) => ({
                    word: w,
                    start: offset + step * wIdx,
                    end: offset + step * (wIdx + 1),
                    confidence: 0,
                }));
            }
            if (!result.text?.trim() || !words.length) {
                const hint = provider === 'deepgram'
                    ? '（Deepgram 强降噪容易过滤音乐伴奏人声，唱歌MV建议切换为「🎸 音乐MV专享」或「🎵 Groq Whisper」模型）'
                    : '';
                throw new Error(`${PROVIDER_LABEL[provider]} 未返回逐词时间码${hint}`);
            }
            utterances.push({ text: result.text, audio_start: offset, audio_end: offset + segments[index].duration, words });
            texts.push(result.text);
            offset += segments[index].duration;
        }
        const fullText = texts.join(' ');
        if (jsonPath) { fs.mkdirSync(path.dirname(jsonPath), { recursive: true }); fs.writeFileSync(jsonPath, JSON.stringify(utterances, null, 2)); }
        if (txtPath) { fs.mkdirSync(path.dirname(txtPath), { recursive: true }); fs.writeFileSync(txtPath, fullText); }
        return { wordTimeInfo: utterances, fullText, provider };
    } finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { } }
}

async function transcribeWithFallback(mediaPath, config, language, jsonPath, txtPath, minMinutes = 5, onProgress, signal, options = {}) {
    const order = [...new Set([config?.primary, config?.fallback, config?.rescue].filter(p => ['deepgram', 'groq', 'gladia'].includes(p)))];
    if (!order.length) throw new Error('请在设置中配置至少一个转录服务 API Key');
    const effectiveOptions = {
        musicMode: !!(options?.musicMode ?? config?.musicMode),
        promptHint: String(options?.promptHint ?? config?.promptHint ?? '').trim(),
    };
    const errors = [];
    for (const provider of order) {
        const keys = config?.providers?.[provider]?.keys || [];
        if (!keys.length) { errors.push(`${PROVIDER_LABEL[provider]}：未配置 Key`); continue; }
        try {
            console.log(`[云端转录] 🎙️ 正在调用 ${PROVIDER_LABEL[provider]}${effectiveOptions.musicMode ? ' [音乐MV增强]' : ''}...`);
            onProgress?.(`🎙️ 正在通过 ${PROVIDER_LABEL[provider]}${effectiveOptions.musicMode ? ' (音乐MV增强)' : ''} 进行语音转录...`);
            const res = await transcribeProvider(mediaPath, provider, keys, language, jsonPath, txtPath, minMinutes, onProgress, signal, effectiveOptions);
            console.log(`[云端转录] ✅ ${PROVIDER_LABEL[provider]} 转录成功`);
            return res;
        }
        catch (error) {
            if (signal?.aborted) throw error;
            console.warn(`[云端转录] ⚠️ ${PROVIDER_LABEL[provider]} 失败: ${error.message}，正在切换备用服务`);
            errors.push(`${PROVIDER_LABEL[provider]}：${error.message}`);
            onProgress?.(`${PROVIDER_LABEL[provider]} 不可用，正在切换备用服务`);
        }
    }
    throw new Error(`所有已配置的转录服务均失败：\n${errors.join('\n')}`);
}

module.exports = {
    transcribeWithFallback,
    transcribeProvider,
    getTranscriptionRecords,
    clearTranscriptionRecords,
    _test: { multipart, parseResponse }
};
