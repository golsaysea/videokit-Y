/**
 * Gladia 语音转文字服务 — 完整移植自 core/gladia_api.py
 * 支持长音频自动切分（通过 FFmpeg 静音检测）、分段转录、API key 轮换
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');
const { formatMediaError } = require('./media-error');

// Reuse centralised path resolution from ffmpeg.js so that
// FFMPEG_PATH / FFPROBE_PATH env vars set by main.js are honoured.
let _resolveCommand;
try {
    _resolveCommand = require('./ffmpeg').resolveCommand;
} catch (_) {
    _resolveCommand = null;
}
function resolveCmd(cmd) {
    if (_resolveCommand) return _resolveCommand(cmd);
    if (cmd === 'ffmpeg' && process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    if (cmd === 'ffprobe' && process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
    return cmd;
}

// execFile 的 timeout 不会响应 AbortSignal。自动剪辑点击“停止”时，必须主动
// 结束正在跑的 FFmpeg，否则一次音频转换最长可让界面等待五分钟。
function execFileWithSignal(command, args, options, signal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let child;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener?.('abort', abort);
            fn(value);
        };
        const abort = () => {
            try { child?.kill('SIGTERM'); } catch (_) {}
            finish(reject, new Error('任务已停止'));
        };
        if (signal?.aborted) return abort();
        child = execFile(command, args, options, (error, stdout, stderr) => {
            if (error) return finish(reject, { error, stdout, stderr });
            finish(resolve, { stdout, stderr });
        });
        signal?.addEventListener?.('abort', abort, { once: true });
    });
}

const GLADIA_API_URL = 'https://api.gladia.io';

function parseGladiaErrorText(body) {
    const text = Buffer.isBuffer(body) ? body.toString() : String(body || '');
    try {
        const data = JSON.parse(text);
        if (data && typeof data === 'object') {
            return data.message || data.error || text;
        }
    } catch (_) { }
    return text;
}

function isGladiaRateLimit(status, body) {
    const errText = parseGladiaErrorText(body).toLowerCase();
    return status === 429 ||
        errText.includes('rate limit') ||
        errText.includes('limit exceeded') ||
        errText.includes('too many requests') ||
        errText.includes('quota');
}

function classifyGladiaError(message) {
    const text = String(message || '');
    const lower = text.toLowerCase();
    if (text.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
        return {
            type: 'auth',
            friendly: '401 Unauthorized (接口鉴权失败，请检查 Key 是否正确或已过期)',
        };
    }
    if (text.includes('403') || lower.includes('forbidden')) {
        return {
            type: 'auth',
            friendly: '403 Forbidden (无权限，可能账号受限)',
        };
    }
    if (lower.includes('insufficient credit') || lower.includes('insufficient balance') ||
        lower.includes('not enough credit') || lower.includes('credits exhausted') ||
        lower.includes('usage quota') || lower.includes('monthly usage') ||
        lower.includes('audio quota') || lower.includes('quota exceeded')) {
        return {
            type: 'quota',
            friendly: `额度已用完或余额不足${text ? `：${text.slice(0, 260)}` : ''}`,
        };
    }
    if (lower.includes('concurren') || lower.includes('simultaneous') ||
        lower.includes('too many transcription') || lower.includes('max transcription') ||
        lower.includes('already processing')) {
        return {
            type: 'concurrency',
            friendly: `并发任务已达上限，请等待正在处理的任务完成后重试${text ? `：${text.slice(0, 260)}` : ''}`,
        };
    }
    if (text.includes('LIMIT_EXCEEDED') || text.includes('429') ||
        lower.includes('rate limit') ||
        lower.includes('limit exceeded') ||
        lower.includes('too many requests')) {
        return {
            type: 'rate_limit',
            friendly: `请求频率过高（429），请降低批量并发或稍后重试${text ? `：${text.slice(0, 260)}` : ''}`,
        };
    }
    if (/\b5\d\d\b/.test(text) || lower.includes('service unavailable') || lower.includes('bad gateway')) {
        return { type: 'service', friendly: `Gladia 服务端暂时异常${text ? `：${text.slice(0, 260)}` : ''}` };
    }
    if (lower.includes('econn') || lower.includes('enotfound') || lower.includes('socket') || lower.includes('network')) {
        return { type: 'network', friendly: `网络连接失败${text ? `：${text.slice(0, 260)}` : ''}` };
    }
    if (lower.includes('timeout') || text.includes('超时')) {
        return {
            type: 'timeout',
            friendly: '连接超时 (Timeout)',
        };
    }
    return {
        type: 'other',
        friendly: text || '未知错误',
    };
}

// ==================== HTTP 请求工具 ====================

function gladiaRequest(method, urlStr, headers, body, timeout = 120000, signal = null) {
    // Intentional: sending user data (audio/text) to Gladia API for transcription
    const requestBody = body ? Buffer.from(body) : null;
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const client = url.protocol === 'https:' ? https : http;
        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method,
            headers,
            timeout,
        };
        let settled = false;
        let absoluteTimeoutTimer = null;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (absoluteTimeoutTimer) clearTimeout(absoluteTimeoutTimer);
            signal?.removeEventListener?.('abort', abort);
            fn(value);
        };
        const abort = () => {
            req.destroy();
            finish(reject, new Error('任务已停止'));
        };
        const req = client.request(options, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                finish(resolve, { status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers });
            });
        });
        if (signal?.aborted) return abort();
        signal?.addEventListener?.('abort', abort, { once: true });
        // ClientRequest 的 timeout 只是“socket 无活动”超时；上传持续写入时，
        // 即使服务端永远不回包也不会触发。这里增加整体时限，避免 UI 无限等待。
        absoluteTimeoutTimer = setTimeout(() => {
            req.destroy();
            finish(reject, new Error(`Gladia 请求总超时（${Math.round(timeout / 1000)} 秒）`));
        }, timeout);
        req.on('timeout', () => { req.destroy(); finish(reject, new Error('Gladia 请求超时')); });
        req.on('error', error => finish(reject, signal?.aborted ? new Error('任务已停止') : error));
        if (requestBody) req.write(requestBody);
        req.end();
    });
}

// ==================== FFmpeg 音频处理 ====================

/**
 * 从视频文件中提取音频（替代 Python extract_audio_from_video）
 */
async function extractAudioFromVideo(videoPath, outputDir, audioFormat = 'wav', signal = null, options = {}) {
    const baseName = path.parse(videoPath).name;
    const audioPath = path.join(outputDir, `${baseName}.${audioFormat}`);
    fs.mkdirSync(outputDir, { recursive: true });

    const ffmpegPath = resolveCmd('ffmpeg');
    const useMusicFilter = !!options?.musicMode;
    const buildArgs = (withFilter) => {
        const a = ['-y', '-i', videoPath, '-vn'];
        if (withFilter) {
            // 音乐MV人声频段提纯：削减160Hz以下鼓点低频与4800Hz以上镲片高频伴奏干扰，并动态均衡人声响度
            a.push('-af', 'highpass=f=160,lowpass=f=4800,dynaudnorm=f=150:g=15');
        }
        if (audioFormat === 'wav') {
            a.push('-ar', '32000', '-ac', '1');
        } else {
            a.push('-ar', '44100', '-ac', '1', '-b:a', '192k');
        }
        a.push(audioPath);
        return a;
    };

    try {
        try {
            await execFileWithSignal(ffmpegPath, buildArgs(useMusicFilter), { timeout: 300000 }, signal);
        } catch (filterErr) {
            if (!useMusicFilter || signal?.aborted || filterErr?.message === '任务已停止') throw filterErr;
            console.warn('[Gladia] 音乐人声滤波提取失败，回退标准提取:', filterErr?.message || '');
            await execFileWithSignal(ffmpegPath, buildArgs(false), { timeout: 300000 }, signal);
        }
        return audioPath;
    } catch (failure) {
        if (signal?.aborted || failure?.message === '任务已停止') throw new Error('任务已停止');
        const err = failure?.error || failure;
        const stderr = failure?.stderr || '';
        console.error(`[Gladia] FFmpeg 提取音频失败:\n${stderr || err?.message}`);
        throw new Error(formatMediaError(stderr || err?.message, { action: '提取音频', code: err?.code }));
    }
}

/** 将任意 FFmpeg 可读的音/视频媒体标准化为语音识别用的 PCM WAV。 */
async function normalizeMediaForTranscription(mediaPath, outputDir, signal = null, options = {}) {
    if (!mediaPath) {
        throw new Error('缺少音频或视频文件路径');
    }
    let cleanPath = String(mediaPath).trim();
    if (cleanPath.startsWith('file://')) {
        try { cleanPath = decodeURIComponent(cleanPath.replace(/^file:\/\//i, '')); } catch (_) { cleanPath = cleanPath.replace(/^file:\/\//i, ''); }
    }
    if (!fs.existsSync(cleanPath)) {
        throw new Error(`音频/视频文件不存在或已被移动：${cleanPath}`);
    }
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'transcription_input.wav');
    const useMusicFilter = !!options?.musicMode;
    const buildArgs = (withFilter) => {
        const a = ['-y', '-v', 'error', '-i', cleanPath, '-map', '0:a:0?', '-vn'];
        if (withFilter) {
            a.push('-af', 'highpass=f=160,lowpass=f=4800,dynaudnorm=f=150:g=15');
        }
        a.push('-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath);
        return a;
    };
    try {
        try {
            await execFileWithSignal(resolveCmd('ffmpeg'), buildArgs(useMusicFilter), { timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, signal);
        } catch (filterErr) {
            if (!useMusicFilter || signal?.aborted || filterErr?.message === '任务已停止') throw filterErr;
            console.warn('[Gladia] 音乐人声滤波标准化失败，回退标准转换:', filterErr?.message || '');
            await execFileWithSignal(resolveCmd('ffmpeg'), buildArgs(false), { timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, signal);
        }
    } catch (failure) {
        if (signal?.aborted || failure?.message === '任务已停止') throw new Error('任务已停止');
        const err = failure?.error || failure;
        const detail = String(failure?.stderr || err?.message || '').trim();
        console.error(`[Gladia] 标准化音频失败:\n${detail}`);
        if (!detail && (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 44)) {
            throw new Error(`素材「${path.basename(cleanPath)}」中未检测到有效音轨。如果该卡片是静音/无声视频，请在“人声-音频”列添加配音音频(MP3)或切换识别源为有声音的视频。`);
        }
        throw new Error(detail
            ? formatMediaError(detail, { action: '读取或转换音频', code: err?.code, missingLabel: '音频文件', mediaPath: cleanPath })
            : `读取或转换音频失败：素材「${path.basename(cleanPath)}」中没有可用音轨，或文件已损坏`);
    }
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 44) {
        throw new Error(`读取或转换音频失败：素材「${path.basename(cleanPath)}」中没有可用音轨，或文件已损坏`);
    }
    return outputPath;
}

/**
 * 获取音频时长（秒）
 */
async function getAudioDuration(filePath) {
    const ffprobePath = resolveCmd('ffprobe');
    return new Promise((resolve, reject) => {
        execFile(ffprobePath, [
            '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', filePath
        ], { timeout: 30000 }, (err, stdout) => {
            if (err) return reject(err);
            resolve(parseFloat(stdout.trim()) || 0);
        });
    });
}

/**
 * 通过 FFmpeg 检测静音，返回静音中点列表（毫秒）
 * 替代 Python pydub.silence.detect_silence
 */
async function detectSilencePoints(filePath, silenceThreshDb = -30, minSilenceLen = 0.5) {
    const ffmpegPath = resolveCmd('ffmpeg');
    return new Promise((resolve, reject) => {
        const args = [
            '-i', filePath, '-af',
            `silencedetect=noise=${silenceThreshDb}dB:d=${minSilenceLen}`,
            '-f', 'null', '-'
        ];
        const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', () => {
            const points = [];
            const startRegex = /silence_start:\s*([\d.]+)/g;
            const endRegex = /silence_end:\s*([\d.]+)/g;
            const starts = [];
            const ends = [];
            let m;
            while ((m = startRegex.exec(stderr))) starts.push(parseFloat(m[1]));
            while ((m = endRegex.exec(stderr))) ends.push(parseFloat(m[1]));

            for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
                const midMs = Math.round(((starts[i] + ends[i]) / 2) * 1000);
                points.push(midMs);
            }
            resolve(points);
        });
        proc.on('error', reject);
    });
}

/**
 * 按静音切分长音频 — 替代 Python split_audio_on_silence
 * 使用 FFmpeg 进行切分
 */
async function splitAudioOnSilence(audioPath, outputDir, minMinutes = 5.0, maxMinutes = 50.0, audioFormat = 'wav') {
    fs.mkdirSync(outputDir, { recursive: true });
    const baseName = path.parse(audioPath).name;

    // 获取总时长（毫秒）
    const totalDurationSec = await getAudioDuration(audioPath);
    const totalMs = Math.round(totalDurationSec * 1000);
    const minMs = minMinutes * 60 * 1000;
    const maxMs = maxMinutes * 60 * 1000;

    // 如果总时长小于最大限制，无需切分
    if (totalMs <= maxMs) {
        return [{ path: audioPath, duration: totalDurationSec }];
    }

    // 检测静音点
    const silencePoints = await detectSilencePoints(audioPath, -30, 0.5);

    // 计算片段
    const segmentsMs = [];
    let start = 0;

    for (const splitPoint of silencePoints) {
        if (splitPoint - start >= minMs) {
            while (splitPoint - start > maxMs) {
                const mid = start + maxMs;
                segmentsMs.push([start, mid]);
                start = mid;
            }
            segmentsMs.push([start, splitPoint]);
            start = splitPoint;
        }
    }
    if (start < totalMs) {
        segmentsMs.push([start, totalMs]);
    }

    // 合并太短的最后一段
    if (segmentsMs.length >= 2) {
        const last = segmentsMs[segmentsMs.length - 1];
        const lastDur = last[1] - last[0];
        if (lastDur < 60000) {
            const prev = segmentsMs[segmentsMs.length - 2];
            segmentsMs[segmentsMs.length - 2] = [prev[0], last[1]];
            segmentsMs.pop();
        }
    }

    // 如果只有一段，直接返回
    if (segmentsMs.length <= 1) {
        return [{ path: audioPath, duration: totalDurationSec }];
    }

    // 用 FFmpeg 切分每段
    const ffmpegPath = resolveCmd('ffmpeg');
    const segments = [];

    for (let idx = 0; idx < segmentsMs.length; idx++) {
        const [segStart, segEnd] = segmentsMs[idx];
        const segPath = path.join(outputDir, `${baseName}_part${idx + 1}.${audioFormat}`);
        const startSec = segStart / 1000;
        const durSec = (segEnd - segStart) / 1000;

        const args = ['-y', '-i', audioPath, '-ss', String(startSec), '-t', String(durSec)];
        if (audioFormat !== 'wav') {
            args.push('-ac', '1', '-b:a', '192k');
        } else {
            args.push('-ac', '1', '-ar', '32000');
        }
        args.push(segPath);

        await new Promise((resolve, reject) => {
            execFile(ffmpegPath, args, { timeout: 120000 }, (err, _stdout, stderr) => {
                if (err) {
                    console.error(`[Gladia] FFmpeg 切分音频失败:\n${stderr || err.message}`);
                    return reject(new Error(formatMediaError(stderr || err.message, {
                        action: '切分音频',
                        code: err.code,
                    })));
                }
                resolve();
            });
        });

        segments.push({ path: segPath, duration: durSec });
    }

    return segments;
}

// ==================== Gladia API ====================

/**
 * 上传音频文件到 Gladia v2
 */
async function uploadAudio(apiKey, filePath, signal = null) {
    const fileData = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');

    let body = '';
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="audio"; filename="${fileName}"\r\n`;
    body += `Content-Type: application/octet-stream\r\n\r\n`;

    const bodyStart = Buffer.from(body, 'utf-8');
    const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const fullBody = Buffer.concat([bodyStart, fileData, bodyEnd]);

    const res = await gladiaRequest('POST', `${GLADIA_API_URL}/v2/upload`, {
        'x-gladia-key': apiKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length,
    // 分段后的 WAV 一般只有几十秒，正常上传不应超过一分钟。旧的 5 分钟
    // 超时会让断网/服务端半开连接表现成“任务一直卡着不动”。
    }, fullBody, 90000, signal);

    if (res.status !== 200 && res.status !== 201) {
        const errText = res.body.toString().slice(0, 500);
        // 检查是否 limit exceeded
        if (isGladiaRateLimit(res.status, res.body)) {
            throw new Error(`LIMIT_EXCEEDED: ${parseGladiaErrorText(res.body).slice(0, 300)}`);
        }
        throw new Error(`Gladia 上传失败: ${res.status} - ${errText}`);
    }

    const data = JSON.parse(res.body.toString());
    return data.audio_url || data.url;
}

/**
 * 发起转录请求 (v2)
 */
async function startTranscription(apiKey, audioUrl, language = 'english', signal = null) {
    // Gladia v2 使用 language_config.languages 数组，且需要语言代码（如 'en'）
    // 如果传入的是英文名，尝试映射到代码
    const { LANGUAGES } = require('./subtitleUtils');
    let langCode = language;
    for (const [code, info] of Object.entries(LANGUAGES)) {
        if (info.language === language || info.name === language) {
            langCode = code;
            break;
        }
    }

    const payloadObj = {
        audio_url: audioUrl,
    };

    // 只在非自动检测时设置语言
    if (langCode && langCode !== 'auto') {
        payloadObj.language_config = {
            languages: [langCode],
        };
    }

    const payload = JSON.stringify(payloadObj);

    const res = await gladiaRequest('POST', `${GLADIA_API_URL}/v2/pre-recorded`, {
        'x-gladia-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
    }, payload, 30000, signal);

    if (res.status !== 200 && res.status !== 201) {
        const errText = parseGladiaErrorText(res.body);
        if (isGladiaRateLimit(res.status, res.body)) {
            throw new Error(`LIMIT_EXCEEDED: Gladia 转录请求限流 (${res.status}) - ${errText.slice(0, 300)}`);
        }
        throw new Error(`Gladia 转录请求失败: ${res.status} - ${errText.slice(0, 300)}`);
    }

    const data = JSON.parse(res.body.toString());
    // result_url 仍可用，但它通常指向旧的 /v2/transcription/:id 路径。
    // 优先使用 Gladia 当前文档推荐的 pre-recorded 结果端点，避免旧端点
    // 在服务升级期间出现不必要的轮询异常或长时间等待。
    return data.id
        ? `${GLADIA_API_URL}/v2/pre-recorded/${encodeURIComponent(String(data.id))}`
        : data.result_url;
}

/**
 * 轮询转录结果
 */
async function pollResult(apiKey, resultUrl, maxAttempts = 60, interval = 3000, signal = null) {
    let parsedPollUrl;
    try {
        parsedPollUrl = new URL(String(resultUrl || ''));
    } catch {
        throw new Error('Gladia 轮询地址无效');
    }
    if (parsedPollUrl.protocol !== 'https:' || (parsedPollUrl.hostname !== 'api.gladia.io' && !parsedPollUrl.hostname.endsWith('.gladia.io'))) {
        throw new Error(`拒绝向非受信任的 Gladia 域名发送 API Key: ${parsedPollUrl.hostname}`);
    }
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted) throw new Error('任务已停止');
        console.log(`Gladia 轮询尝试 ${attempt + 1}/${maxAttempts}...`);
        const res = await gladiaRequest('GET', resultUrl, {
            'x-gladia-key': apiKey,
            'Accept': 'application/json',
        }, null, 15000, signal);

        if (res.status === 200) {
            const data = JSON.parse(res.body.toString());
            const status = (data.status || '').toLowerCase();
            if ((data.result || data.transcription) && (status === 'done' || status === 'completed' || !status)) {
                console.log('Gladia 异步转录完成！');
                return data;
            } else if (status === 'error') {
                throw new Error(`Gladia 转录出错: ${JSON.stringify(data)}`);
            }
            console.log(`Gladia 状态: ${status}, 等待...`);
        } else if (res.status === 202) {
            console.log('Gladia 仍在处理...');
        } else {
            const errText = res.body.toString();
            const lowerErr = errText.toLowerCase();
            if (res.status === 429 || lowerErr.includes('limit exceeded') || lowerErr.includes('quota') || lowerErr.includes('rate limit') || lowerErr.includes('concurren')) {
                throw new Error(`LIMIT_EXCEEDED: Gladia 轮询受限 (${res.status}) - ${parseGladiaErrorText(res.body).slice(0, 300)}`);
            }
            throw new Error(`Gladia 轮询错误: ${res.status} - ${errText.slice(0, 300)}`);
        }
        await new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(new Error('任务已停止'));
            const timer = setTimeout(done, interval);
            const abort = () => { clearTimeout(timer); done(new Error('任务已停止')); };
            function done(error) {
                signal?.removeEventListener?.('abort', abort);
                error ? reject(error) : resolve();
            }
            signal?.addEventListener?.('abort', abort, { once: true });
        });
    }
    throw new Error('Gladia 转录超时: 已达最大轮询次数');
}

/**
 * 解析 Gladia 转录结果为统一格式 — 移植自 get_json_result
 * @param {Object} transcribeResult  Gladia API 返回值
 * @param {Array}  lastResult       累积结果数组
 * @param {Array}  fullTextList     全文词列表
 * @param {number} startTime        时间偏移（秒，用于分段合并）
 */
function getJsonResult(transcribeResult, lastResult, fullTextList, startTime) {
    if (!transcribeResult) return false;

    const synthesizeWords = (text, audioStart, audioEnd) => {
        const cleanText = String(text || '').trim();
        if (!cleanText) return [];
        const tokens = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(cleanText)
            ? Array.from(cleanText).filter(char => char.trim())
            : cleanText.split(/\s+/).filter(Boolean);
        const safeEnd = audioEnd > audioStart ? audioEnd : audioStart + Math.max(0.4, tokens.length * 0.25);
        const step = (safeEnd - audioStart) / Math.max(1, tokens.length);
        return tokens.map((word, index) => ({
            word,
            start: audioStart + step * index,
            end: audioStart + step * (index + 1),
            score: 0,
        }));
    };

    // Try to find the list of utterances / segments in various possible fields
    let utterances = null;

    if (transcribeResult.result?.transcription?.utterances) {
        utterances = transcribeResult.result.transcription.utterances;
    } else if (Array.isArray(transcribeResult.results)) {
        utterances = transcribeResult.results;
    } else if (transcribeResult.transcription?.utterances) {
        utterances = transcribeResult.transcription.utterances;
    } else if (Array.isArray(transcribeResult.result?.transcription)) {
        utterances = transcribeResult.result.transcription;
    } else if (Array.isArray(transcribeResult.result?.utterances)) {
        utterances = transcribeResult.result.utterances;
    }

    if (Array.isArray(utterances)) {
        if (utterances.length === 0) {
            const transcription = transcribeResult.result?.transcription || transcribeResult.transcription || {};
            const fallbackText = transcription.full_transcript || transcription.fullTranscript || transcription.text || '';
            if (String(fallbackText).trim()) {
                const rawDuration = Number(transcribeResult.metadata?.audio_duration || transcribeResult.result?.metadata?.audio_duration || 0);
                const audioStart = startTime;
                const audioEnd = startTime + Math.max(0, rawDuration);
                const words = synthesizeWords(fallbackText, audioStart, audioEnd);
                fullTextList.push(...words.map(word => word.word));
                lastResult.push({ text: String(fallbackText).trim(), audio_start: audioStart, audio_end: words.at(-1)?.end || audioEnd, words });
                console.log('Gladia 未返回逐句时间轴，已使用完整转录文字生成词时间轴');
                return true;
            }
            console.log('Gladia 返回空转录结构，按识别服务异常处理');
            return true;
        }

        for (const item of utterances) {
            const audioStart = (item.start !== undefined ? item.start : item.time_begin || 0) + startTime;
            const audioEnd = (item.end !== undefined ? item.end : item.time_end || 0) + startTime;
            const part = {
                text: item.text || item.transcription || '',
                audio_start: audioStart,
                audio_end: audioEnd,
                duration: audioEnd - audioStart,
                words: [],
            };

            const apiWords = item.words || [];
            for (const wordInfo of apiWords) {
                const word = (wordInfo.word || '').trim();
                if (!word) continue;
                fullTextList.push(word);
                part.words.push({
                    word,
                    start: (wordInfo.start !== undefined ? wordInfo.start : wordInfo.time_begin || 0) + startTime,
                    end: (wordInfo.end !== undefined ? wordInfo.end : wordInfo.time_end || 0) + startTime,
                    score: wordInfo.confidence !== undefined ? wordInfo.confidence : wordInfo.score || 0,
                });
            }
            if (part.words.length === 0 && part.text.trim()) {
                part.words = synthesizeWords(part.text, audioStart, audioEnd);
                fullTextList.push(...part.words.map(word => word.word));
                console.log('Gladia 仅返回句子文字，已生成均匀逐词时间轴');
            }
            lastResult.push(part);
        }
        return true;
    }

    // v1 API 格式 (prediction)
    const prediction = transcribeResult.prediction;
    if (Array.isArray(prediction)) {
        if (prediction.length === 0) {
            console.log('Gladia prediction 为空，按识别服务异常处理');
            return true;
        }

        for (const item of prediction) {
            const audioStart = (item.time_begin || 0) + startTime;
            const audioEnd = (item.time_end || 0) + startTime;
            const part = {
                text: item.transcription || '',
                audio_start: audioStart,
                audio_end: audioEnd,
                duration: audioEnd - audioStart,
                words: [],
            };

            const apiWords = item.words || [];
            for (const wordInfo of apiWords) {
                const word = (wordInfo.word || '').trim();
                if (!word) continue;
                fullTextList.push(word);
                part.words.push({
                    word,
                    start: (wordInfo.time_begin || 0) + startTime,
                    end: (wordInfo.time_end || 0) + startTime,
                    score: wordInfo.confidence || 0,
                });
            }
            if (part.words.length === 0 && part.text.trim()) {
                part.words = synthesizeWords(part.text, audioStart, audioEnd);
                fullTextList.push(...part.words.map(word => word.word));
                console.log('Gladia v1 仅返回句子文字，已生成均匀逐词时间轴');
            }
            lastResult.push(part);
        }
        return true;
    }

    return false;
}

// ==================== 主接口 ====================

/**
 * 完整的转录流程 — 完整移植自 transcribe_audio_from_gladia
 * 支持长音频自动切分、错误重试、API Key 轮换
 *
 * @param {string}   mediaPath    音频/视频文件路径
 * @param {string[]} apiKeys      Gladia API Key 数组
 * @param {string}   language     语言（英文名）
 * @param {string}   jsonPath     结果 JSON 保存路径
 * @param {string}   txtPath      纯文本保存路径
 * @param {number}   minMinutes   最小切分时长（分钟）
 * @param {Function} onProgress   进度回调
 * @returns {Object} { wordTimeInfo, fullText }
 */
async function transcribeAudioFull(mediaPath, apiKeys, language, jsonPath, txtPath, minMinutes = 5.0, onProgress = null, signal = null, options = {}) {
    const throwIfAborted = () => { if (signal?.aborted) throw new Error('任务已停止'); };
    throwIfAborted();
    if (!apiKeys || apiKeys.length === 0) {
        throw new Error('无可用 Gladia Key，请添加 Gladia key。');
    }

    const settings = require('./settings');
    const tmpDir = path.join(settings.getSecureTmpDir(), `gladia_${crypto.randomUUID()}`);
    // 统一成单声道 PCM WAV，避免 AAC/FLAC/OGG/特殊 WAV 编码直接进识别端时失败。
    if (onProgress) onProgress(options?.musicMode ? '正在提取并提纯音乐人声...' : '正在读取并转换音频');
    const audioPath = await normalizeMediaForTranscription(mediaPath, tmpDir, signal, options);

    // 切分音频（音乐模式下提高最小时长避免歌曲前奏/间奏被误切）
    if (onProgress) onProgress('切分音频');
    const effectiveMinMinutes = options?.musicMode ? Math.max(8.0, Number(minMinutes) || 5.0) : minMinutes;
    const segments = await splitAudioOnSilence(audioPath, tmpDir, effectiveMinMinutes, 50.0, 'wav');

    // 开始转录
    let curStartTime = 0;
    const lastResult = [];
    const fullTextList = [];
    let curKeyIndex = 0;

    if (onProgress) onProgress('开始转录音频');

    for (let idx = 0; idx < segments.length; idx++) {
        throwIfAborted();
        const { path: segPath, duration } = segments[idx];

        if (onProgress) onProgress(`转录进度: ${idx + 1}/${segments.length}`);

        let success = false;
        const keyErrors = [];
        const keyErrorTypes = [];

        // 尝试每个 key，每个 key 最多重试 3 次
        for (let keyAttempt = curKeyIndex; keyAttempt < apiKeys.length; keyAttempt++) {
            const apiKey = apiKeys[keyAttempt];
            let lastKeyError = null;

            for (let retry = 0; retry < 3; retry++) {
                try {
                    throwIfAborted();
                    // 上传
                    const audioUrl = await uploadAudio(apiKey, segPath, signal);

                    // 转录
                    const resultUrl = await startTranscription(apiKey, audioUrl, language, signal);

                    // 轮询结果
                    const result = await pollResult(apiKey, resultUrl, 60, 3000, signal);

                    // 解析结果
                    const ok = getJsonResult(result, lastResult, fullTextList, curStartTime);
                    if (!ok) {
                        throw new Error('转录结果有问题');
                    }

                    success = true;
                    curKeyIndex = keyAttempt; // 记住当前 key
                    break;
                } catch (e) {
                    if (signal?.aborted || String(e?.message || '') === '任务已停止') throw e;
                    console.error(`Gladia 转录失败 (key ${keyAttempt + 1}, 重试 ${retry + 1}): ${e.message}`);
                    lastKeyError = e.message;

                    const failureType = classifyGladiaError(e.message).type;

                    if (['auth', 'quota', 'concurrency', 'rate_limit'].includes(failureType)) {
                        console.log(`Gladia 当前 Key 不可继续 (${failureType})，切换下一个 API key`);
                        break; // 跳到下一个 key
                    }

                    // 其他错误继续重试
                    if (retry < 2) {
                        await new Promise((resolve, reject) => {
                            if (signal?.aborted) return reject(new Error('任务已停止'));
                            const timer = setTimeout(done, 2000);
                            const abort = () => { clearTimeout(timer); done(new Error('任务已停止')); };
                            function done(error) { signal?.removeEventListener?.('abort', abort); error ? reject(error) : resolve(); }
                            signal?.addEventListener?.('abort', abort, { once: true });
                        });
                    }
                }
            }

            if (success) {
                break;
            } else {
                const maskedKey = apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '***';
                const classified = classifyGladiaError(lastKeyError);
                keyErrorTypes.push(classified.type);
                keyErrors.push(`- Key #${keyAttempt + 1} (${maskedKey}): ${classified.friendly}`);
            }
        }

        if (!success) {
            const uniqueTypes = [...new Set(keyErrorTypes)];
            let summary = '转录失败';
            if (uniqueTypes.length === 1 && uniqueTypes[0] === 'quota') {
                summary = 'Gladia 额度已用完或账户余额不足。请到 Gladia 后台查看本月 Usage/Billing。';
            } else if (uniqueTypes.length === 1 && uniqueTypes[0] === 'concurrency') {
                summary = 'Gladia 并发任务已达上限，但额度不一定用完。请等待其他任务完成，或降低批量并发数后重试。';
            } else if (uniqueTypes.length === 1 && uniqueTypes[0] === 'rate_limit') {
                summary = 'Gladia 请求频率过高（429），但不代表额度用完。请降低批量并发数或稍后重试。';
            } else if (uniqueTypes.length === 1 && uniqueTypes[0] === 'auth') {
                summary = 'Gladia Key 鉴权失败，请检查 Key 是否正确、过期或账号权限受限。';
            } else if (uniqueTypes.length === 1 && uniqueTypes[0] === 'timeout') {
                summary = 'Gladia 请求超时，可能是网络或接口响应过慢。请稍后重试。';
            } else if (uniqueTypes.includes('quota')) {
                summary = 'Gladia 转录失败，其中至少一个 Key 的额度或余额不足。';
            } else if (uniqueTypes.includes('concurrency')) {
                summary = 'Gladia 转录失败，其中至少一个账户达到并发上限。';
            } else if (uniqueTypes.includes('rate_limit')) {
                summary = 'Gladia 转录失败，其中包含请求频率限制（不等于额度不足）。';
            } else if (uniqueTypes.includes('auth')) {
                summary = 'Gladia 转录失败，其中包含 Key 鉴权失败。';
            } else {
                summary = 'Gladia 转录失败，具体原因见下方明细。';
            }
            throw new Error(`${summary}\n详细错误原因：\n${keyErrors.join('\n')}`);
        }

        curStartTime += duration;
    }

    // 保存结果
    if (jsonPath) {
        const jsonDir = path.dirname(jsonPath);
        fs.mkdirSync(jsonDir, { recursive: true });
        fs.writeFileSync(jsonPath, JSON.stringify(lastResult, null, 2), 'utf-8');
    }

    const fullText = fullTextList.join(' ');
    if (txtPath) {
        const txtDir = path.dirname(txtPath);
        fs.mkdirSync(txtDir, { recursive: true });
        fs.writeFileSync(txtPath, fullText, 'utf-8');
    }

    if (txtPath && audioPath && fs.existsSync(audioPath)) {
        try {
            if (txtPath.includes('_autoedit.txt')) {
                const cacheWavPath = txtPath.replace('_autoedit.txt', '_autoedit.wav');
                fs.copyFileSync(audioPath, cacheWavPath);
            }
        } catch (copyErr) {
            console.error('保存提取的音频缓存失败:', copyErr);
        }
    }

    // 清理临时文件
    try {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    } catch { /* 忽略清理错误 */ }

    return { wordTimeInfo: lastResult, fullText };
}

/**
 * 简化版转录接口（兼容之前的 API）
 */
async function transcribeAudio(filePath, gladiaKeys, language = 'english', onProgress = null) {
    // 如果传入的 language 是中文名称，转为英文
    const { LANGUAGES } = require('./subtitleUtils');
    let langEn = language;
    for (const info of Object.values(LANGUAGES)) {
        if (info.name === language || info.code === language) {
            langEn = info.language;
            break;
        }
    }

    return transcribeAudioFull(filePath, gladiaKeys, langEn, null, null, 5.0, onProgress);
}

module.exports = {
    transcribeAudio,
    transcribeAudioFull,
    uploadAudio,
    startTranscription,
    pollResult,
    extractAudioFromVideo,
    splitAudioOnSilence,
    getJsonResult,
    _test: { classifyGladiaError, parseGladiaErrorText },
};
