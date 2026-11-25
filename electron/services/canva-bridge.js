'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

const presetsMod = require('../../src/reels-presets-init');
const rendererMod = require('../../src/reels-canvas-renderer');
const overlayMod = require('../../src/reels-overlay');
const ffmpegService = require('./ffmpeg');
const edgeTts = require('./edgeTts');
const cliMod = require('../../bin/videokit-cli.cjs');

const DEFAULT_MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 90 * 1000;

const EXTRA_WRITING_CURSOR_ICONS = Object.freeze([
    { id: 'cardinal_feather', emoji: '🪶', label: '红雀红褐羽毛', category: '飞羽红雀' },
    { id: 'northern_cardinal', emoji: '🐦', label: '红雀鸟松枝', category: '飞羽红雀' },
    { id: 'cardinal_quill_gold', emoji: '✒️', label: '红雀棕羽金笔', category: '飞羽红雀' },
    { id: 'amber_autumn_feather', emoji: '🍂', label: '焦糖琥珀金羽', category: '飞羽红雀' },
    { id: 'crimson_rose_feather', emoji: '🥀', label: '绯红玫瑰金羽', category: '飞羽红雀' },
    { id: 'frost_crystal_feather', emoji: '❄️', label: '冰晶银蓝雪羽', category: '飞羽红雀' },
    { id: 'peacock_plumage', emoji: '🦚', label: '翡翠孔雀翎羽', category: '飞羽红雀' },
    { id: 'dove_white_feather', emoji: '🕊️', label: '圣洁鎏金白羽', category: '飞羽红雀' },
    { id: 'quill', emoji: '🪶', label: '复古羽毛笔', category: '经典手写' },
    { id: 'feather_gold', emoji: '🪶', label: '金色鹅毛笔', category: '经典手写' },
    { id: 'fountain_pen', emoji: '✒️', label: '经典钢笔尖', category: '经典手写' },
    { id: 'brush', emoji: '🖌️', label: '手绘毛笔刷', category: '经典手写' },
    { id: 'rose', emoji: '🌹', label: '玫瑰花笔尖', category: '自然元素' },
    { id: 'dove', emoji: '🕊️', label: '和平白鸽', category: '自然元素' },
    { id: 'cross_light', emoji: '✝️', label: '圣光十字', category: '信仰祈祷' },
]);

function isPrivateOrLocalHostname(rawHost) {
    const host = String(rawHost || '')
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .split('%')[0]
        .trim();
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host === '::1' || host === '::') return true;
    if (/^(fc|fd|fe80:)/i.test(host)) return true;
    if (/^::ffff:(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host)) return true;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
    return false;
}

/**
 * 校验来自 Canva 插件或外部传入的媒体下载链接，防止 SSRF 与内网探测。
 */
function assertSafeCanvaMediaUrl(rawUrl, options = {}) {
    const label = options.label || 'Canva 媒体链接';
    const clean = String(rawUrl || '').trim();
    if (!clean) throw new Error(`${label}不能为空`);
    if (clean.length > 4096) throw new Error(`${label}长度超出限制`);

    let parsed;
    try {
        parsed = new URL(clean);
    } catch (_) {
        throw new Error(`${label}格式无效`);
    }

    if (parsed.username || parsed.password) {
        throw new Error(`${label}不允许包含认证凭据`);
    }

    const proto = String(parsed.protocol || '').toLowerCase();
    const allowInsecure = Boolean(options.allowInsecureTestHttp);
    if (allowInsecure) {
        if (proto !== 'https:' && proto !== 'http:') {
            throw new Error(`${label}仅支持 http/https 协议`);
        }
    } else if (proto !== 'https:') {
        throw new Error(`${label}必须使用 HTTPS 协议`);
    }

    if (!options.allowLocalhost && isPrivateOrLocalHostname(parsed.hostname)) {
        throw new Error(`${label}不允许指向本机或内网地址`);
    }
    return parsed;
}

function resolvePublicBaseUrl(req, env = process.env) {
    const explicit = String((env && env.VIDEOKIT_PUBLIC_BASE_URL) || '').trim().replace(/\/+$/, '');
    if (explicit) return explicit;
    const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const proto = (forwardedProto === 'https' || forwardedProto === 'http')
        ? forwardedProto
        : 'https';
    const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '127.0.0.1:5080')
        .split(',')[0]
        .trim();
    return `${proto}://${host}`;
}

function guessMediaExtension(rawUrl, contentType = '') {
    const ct = String(contentType || '').toLowerCase();
    if (ct.includes('video/quicktime')) return '.mov';
    if (ct.includes('video/webm')) return '.webm';
    if (ct.includes('video/x-matroska')) return '.mkv';
    if (ct.includes('video/mp4')) return '.mp4';
    if (ct.includes('image/png')) return '.png';
    if (ct.includes('image/jpeg')) return '.jpg';
    if (ct.includes('image/webp')) return '.webp';
    if (ct.includes('image/gif')) return '.gif';
    if (ct.includes('audio/mpeg')) return '.mp3';
    if (ct.includes('audio/wav')) return '.wav';
    try {
        const pathname = new URL(rawUrl).pathname;
        const ext = path.extname(pathname).toLowerCase();
        if (['.mp4', '.mov', '.webm', '.mkv', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.wav', '.m4a'].includes(ext)) {
            return ext;
        }
    } catch (_) {}
    return '.mp4';
}

async function downloadSafeRemoteMedia(rawUrl, destDir, baseName = 'input', options = {}) {
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_DOWNLOAD_BYTES;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_FETCH_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('当前 Node 运行时缺少 fetch 实现');
    }

    let currentUrl = assertSafeCanvaMediaUrl(rawUrl, options).toString();
    let res = null;
    for (let hop = 0; hop < 5; hop++) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
            res = await fetchImpl(currentUrl, {
                method: 'GET',
                redirect: 'manual',
                signal: controller ? controller.signal : undefined,
                headers: {
                    'User-Agent': 'VideoKit-CanvaBridge/4.6.22',
                },
            });
        } finally {
            if (timer) clearTimeout(timer);
        }

        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers?.get?.('location');
            if (!loc) throw new Error(`媒体下载重定向缺少 Location (HTTP ${res.status})`);
            const nextUrl = new URL(loc, currentUrl).toString();
            currentUrl = assertSafeCanvaMediaUrl(nextUrl, options).toString();
            continue;
        }
        break;
    }

    if (!res || !res.ok) {
        throw new Error(`下载媒体失败 (HTTP ${res ? res.status : 'unknown'})`);
    }

    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
    const contentLength = Number(res.headers?.get?.('content-length') || 0);
    if (contentLength > maxBytes) {
        throw new Error(`媒体文件体积过大 (${contentLength} bytes > ${maxBytes})`);
    }
    if (contentType && contentType.includes('text/html')) {
        throw new Error(`远端返回了网页而非媒体文件 (${contentType})`);
    }

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length === 0) {
        throw new Error('下载的媒体文件为空');
    }
    if (buf.length > maxBytes) {
        throw new Error(`媒体文件体积超出限制 (${buf.length} bytes)`);
    }

    const ext = guessMediaExtension(currentUrl, contentType);
    const outPath = path.join(destDir, `${baseName}${ext}`);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(outPath, buf);
    return { path: outPath, size: buf.length, contentType, ext };
}

/**
 * 将普通多行脚本按字符权重切分为递增不重叠的字幕时间段。
 */
function buildAutoSegmentsFromText(rawText, totalDurationSec = 10) {
    const clean = String(rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!clean) return [];

    let lines = clean.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length === 1 && clean.length > 60) {
        const sentenceParts = clean
            .split(/(?<=[.!?。！？])\s+/)
            .map(s => s.trim())
            .filter(Boolean);
        if (sentenceParts.length > 1) lines = sentenceParts;
    }

    const dur = Math.max(1.0, Number(totalDurationSec) || 10);
    const weights = lines.map(l => Math.max(4, l.replace(/\s+/g, '').length));
    const totalWeight = weights.reduce((a, b) => a + b, 0) || lines.length;

    const segments = [];
    let cursor = 0;
    for (let i = 0; i < lines.length; i++) {
        const isLast = i === lines.length - 1;
        const share = (weights[i] / totalWeight) * dur;
        const nextEnd = isLast
            ? dur
            : Math.min(dur, Math.max(cursor + 0.12, Math.round((cursor + share) * 1000) / 1000));
        if (nextEnd <= cursor) continue;
        segments.push({
            start: Math.round(cursor * 1000) / 1000,
            end: Math.round(nextEnd * 1000) / 1000,
            text: lines[i],
        });
        cursor = nextEnd;
    }
    return segments;
}

function buildCanvaPresetCatalog() {
    const subtitles = Object.entries(presetsMod.REELS_PRESET_ID_MAP || {})
        .filter(([code]) => /^sub-\d+$/i.test(code))
        .map(([code, name]) => ({ id: code, name, kind: 'subtitle' }));

    const scrolls = Object.entries(presetsMod.REELS_SCROLL_PRESET_ID_MAP || {})
        .filter(([code]) => /^sc-\d+$/i.test(code))
        .map(([code, name]) => {
            const preset = presetsMod.REELS_BUILTIN_SCROLL_STYLE_PRESETS?.[name];
            return {
                id: code,
                name,
                category: preset?.category || '经典描边滚动',
                kind: 'scroll',
            };
        });

    const overlays = Object.entries(presetsMod.REELS_OVERLAY_PRESET_ID_MAP || {})
        .filter(([code]) => /^ov-\d+$/i.test(code))
        .map(([code, name]) => ({ id: code, name, kind: 'overlay' }));

    const iconSeen = new Set();
    const cursorIcons = [];
    for (const item of [...EXTRA_WRITING_CURSOR_ICONS, ...(rendererMod.HOLIDAY_ICON_CATALOG || [])]) {
        if (!item || !item.id || iconSeen.has(item.id)) continue;
        iconSeen.add(item.id);
        cursorIcons.push({
            id: item.id,
            emoji: item.emoji || '🪶',
            label: item.label || item.id,
            category: item.category || '默认',
        });
    }

    const intros = (typeof overlayMod.listIntroPresets === 'function' ? overlayMod.listIntroPresets() : [])
        .map((item) => ({
            id: item.id,
            name: item.name,
            tag: item.tag,
            category: item.category,
            layout: item.layout,
            curtainTheme: item.curtain_theme,
            curtainStyle: item.curtain_style,
            duration: item.duration,
            delayBody: item.delay_body,
            kind: 'intro',
        }));

    return {
        version: typeof cliMod.getPackageVersion === 'function' ? cliMod.getPackageVersion() : '4.6.22',
        subtitles,
        scrolls,
        overlays,
        intros,
        introThemes: overlayMod.INTRO_REVEAL_THEMES || {},
        cursorIcons,
        revealTypes: [
            { id: 'sentence', label: '按整句 (逐句)' },
            { id: 'word', label: '按单词 (逐词)' },
            { id: 'char', label: '按字符 (逐字)' },
        ],
    };
}

class CanvaJobManager {
    constructor(options = {}) {
        this.workRoot = options.workRoot || path.join(os.tmpdir(), 'videokit-canva-jobs');
        this.jobTtlMs = Number(options.jobTtlMs) > 0 ? Number(options.jobTtlMs) : DEFAULT_JOB_TTL_MS;
        this.allowInsecureTestHttp = Boolean(options.allowInsecureTestHttp);
        this.allowLocalhostMedia = Boolean(options.allowLocalhostMedia);
        this.jobs = new Map();
        this.renderReelsTask = options.renderReelsTask || cliMod.renderReelsTask;
        this.parseSRTContent = options.parseSRTContent || cliMod.parseSRTContent;
        this.ffmpeg = options.ffmpeg || ffmpegService;
        this.edgeTts = options.edgeTts || edgeTts;
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        fs.mkdirSync(this.workRoot, { recursive: true });
    }

    cleanupExpiredJobs(nowMs = Date.now()) {
        for (const [jobId, job] of this.jobs.entries()) {
            if (job.expiresAt && nowMs > job.expiresAt) {
                this.jobs.delete(jobId);
                try { fs.rmSync(job.jobDir, { recursive: true, force: true }); } catch (_) {}
            }
        }
    }

    createJob(payload = {}, publicBaseUrl = '') {
        this.cleanupExpiredJobs();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('请求体必须为 JSON 对象');
        }
        const mediaUrl = String(payload.mediaUrl || payload.bgUrl || payload.videoUrl || '').trim();
        assertSafeCanvaMediaUrl(mediaUrl, {
            allowInsecureTestHttp: this.allowInsecureTestHttp,
            allowLocalhost: this.allowLocalhostMedia,
            label: 'Canva 输入媒体链接',
        });

        const audioUrl = payload.audioUrl ? String(payload.audioUrl).trim() : '';
        if (audioUrl) {
            assertSafeCanvaMediaUrl(audioUrl, {
                allowInsecureTestHttp: this.allowInsecureTestHttp,
                allowLocalhost: this.allowLocalhostMedia,
                label: '外部音频链接',
            });
        }

        // Validate optional intro preset synchronously so invalid IDs fail fast with 400
        const resolvedIntroOverlay = this._resolveIntroOverlay(payload);

        const jobId = 'cv_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
        const fileToken = crypto.randomBytes(24).toString('hex');
        const jobDir = path.join(this.workRoot, jobId);
        fs.mkdirSync(jobDir, { recursive: true });

        const job = {
            id: jobId,
            fileToken,
            jobDir,
            status: 'queued',
            progress: 0,
            message: '已进入 VideoKit 渲染队列',
            createdAt: Date.now(),
            expiresAt: Date.now() + this.jobTtlMs,
            outputPath: path.join(jobDir, 'render.mp4'),
            thumbPath: path.join(jobDir, 'thumb.jpg'),
            publicBaseUrl: String(publicBaseUrl || '').replace(/\/+$/, ''),
            _resolvedIntro: resolvedIntroOverlay,
            outputUrl: '',
            thumbnailUrl: '',
            engine: '',
            durationSec: 0,
            error: null,
        };
        this.jobs.set(jobId, job);

        job._promise = this._processJob(job, { ...payload, mediaUrl, audioUrl }).catch((err) => {
            job.status = 'error';
            job.error = err && err.message ? err.message : String(err);
            job.message = `渲染失败: ${job.error}`;
        });

        return this.serializeJob(job);
    }

    _resolveIntroOverlay(payload = {}) {
        const introInput = payload.intro !== undefined
            ? payload.intro
            : (payload.introPreset ?? payload.intro_preset ?? payload.introStyle ?? payload.intro_style);
        if (introInput === undefined || introInput === null || introInput === false || introInput === '') {
            return null;
        }
        if (typeof overlayMod.resolveIntroOverlayConfig !== 'function') return null;
        const introOverrides = {
            ...(payload.introDuration !== undefined ? { duration: payload.introDuration } : {}),
            ...(payload.introDelayBody !== undefined ? { delay_body: payload.introDelayBody } : {}),
            ...(payload.introTheme !== undefined ? { theme: payload.introTheme } : {}),
            ...(payload.introCurtainStyle !== undefined ? { curtain_style: payload.introCurtainStyle } : {}),
            ...(payload.introColor1 !== undefined ? { color1: payload.introColor1 } : {}),
            ...(payload.introColor2 !== undefined ? { color2: payload.introColor2 } : {}),
            ...(payload.introTopText !== undefined ? { top_text: payload.introTopText } : {}),
            ...(payload.introBottomText !== undefined ? { bottom_text: payload.introBottomText } : {}),
            ...(payload.introHookText !== undefined ? { hook_text: payload.introHookText } : {}),
        };
        return overlayMod.resolveIntroOverlayConfig(introInput, introOverrides);
    }

    serializeJob(job) {
        if (!job) return null;
        return {
            ok: job.status !== 'error',
            jobId: job.id,
            status: job.status,
            progress: job.progress,
            message: job.message,
            engine: job.engine || undefined,
            durationSec: job.durationSec || undefined,
            outputUrl: job.outputUrl || undefined,
            thumbnailUrl: job.thumbnailUrl || undefined,
            error: job.error || undefined,
            expiresAt: job.expiresAt,
        };
    }

    getJob(jobId) {
        this.cleanupExpiredJobs();
        const cleanId = String(jobId || '').trim();
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(cleanId)) return null;
        return this.jobs.get(cleanId) || null;
    }

    resolveProtectedFile(jobId, providedToken, fileKind = 'video') {
        const cleanId = String(jobId || '').trim();
        const tokenStr = String(providedToken || '').trim();
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(cleanId) || !/^[a-f0-9]{16,128}$/i.test(tokenStr)) {
            return { errorCode: 403, error: 'Invalid file access token' };
        }
        const job = this.jobs.get(cleanId);
        if (!job) {
            return { errorCode: 404, error: 'Job not found or expired' };
        }
        if (Date.now() > job.expiresAt) {
            return { errorCode: 410, error: 'Job download link expired' };
        }
        const expectedBuf = Buffer.from(job.fileToken, 'utf8');
        const providedBuf = Buffer.from(tokenStr, 'utf8');
        if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
            return { errorCode: 403, error: 'Forbidden' };
        }
        const targetPath = fileKind === 'thumb' ? job.thumbPath : job.outputPath;
        if (!targetPath || !fs.existsSync(targetPath)) {
            return { errorCode: 404, error: 'Rendered file not ready' };
        }
        return { filePath: targetPath, job };
    }

    async _generateThumbnail(videoPath, thumbPath) {
        try {
            await this.ffmpeg.runCommand('ffmpeg', [
                '-y', '-ss', '0.5', '-i', videoPath, '-frames:v', '1', '-q:v', '3', thumbPath,
            ], { timeout: 20000 });
            if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) return true;
        } catch (_) {}
        try {
            await this.ffmpeg.runCommand('ffmpeg', [
                '-y', '-ss', '0', '-i', videoPath, '-frames:v', '1', '-q:v', '3', thumbPath,
            ], { timeout: 20000 });
            return fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0;
        } catch (_) {
            return false;
        }
    }

    async _processJob(job, payload) {
        const downloadOpts = {
            allowInsecureTestHttp: this.allowInsecureTestHttp,
            allowLocalhost: this.allowLocalhostMedia,
            fetchImpl: this.fetchImpl,
        };

        job.status = 'downloading';
        job.progress = 12;
        job.message = '正在从 Canva 获取页面媒体素材';
        const bgMedia = await downloadSafeRemoteMedia(payload.mediaUrl, job.jobDir, 'canva_input', downloadOpts);

        let probedDur = 0;
        try {
            const det = await this.ffmpeg.getDuration(bgMedia.path);
            if (Number.isFinite(det) && det > 0) probedDur = det;
        } catch (_) {}

        let audioPath;
        let segments = [];
        const rawText = String(payload.text || payload.scrollText || '').trim();
        const rawSrt = String(payload.srt || '').trim();

        if (Array.isArray(payload.segments) && payload.segments.length > 0) {
            segments = payload.segments.map((s, idx) => {
                const start = Number(s.start);
                const end = Number(s.end);
                if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end) {
                    throw new Error(`第 ${idx + 1} 段字幕时间无效`);
                }
                return { start, end, text: String(s.text ?? ''), ...(Array.isArray(s.words) ? { words: s.words } : {}) };
            });
        } else if (rawSrt) {
            segments = this.parseSRTContent(rawSrt, job.id);
        }

        if (payload.audioUrl) {
            job.status = 'downloading_audio';
            job.progress = 26;
            job.message = '正在拉取外部配音音轨';
            const aud = await downloadSafeRemoteMedia(payload.audioUrl, job.jobDir, 'external_audio', downloadOpts);
            audioPath = aud.path;
        } else if (payload.edgeVoice && rawText) {
            job.status = 'synthesizing_tts';
            job.progress = 30;
            job.message = `正在合成 Edge 配音 (${payload.edgeVoice})`;
            const ttsRes = await this.edgeTts.synthesize(rawText, payload.edgeVoice, payload.edgeRate || '+0%');
            audioPath = path.join(job.jobDir, 'tts_voice.mp3');
            fs.writeFileSync(audioPath, ttsRes.audio);
            if (segments.length === 0 && ttsRes.srt && ttsRes.srt.trim()) {
                try {
                    segments = this.parseSRTContent(ttsRes.srt, job.id);
                } catch (_) {}
            }
        }

        let audioDuration = 0;
        if (audioPath) {
            try {
                const aDur = await this.ffmpeg.getDuration(audioPath);
                if (Number.isFinite(aDur) && aDur > 0) audioDuration = aDur;
            } catch (_) {}
        }

        const explicitDuration = Number(payload.duration);
        const effectiveDuration = (Number.isFinite(explicitDuration) && explicitDuration > 0)
            ? explicitDuration
            : (audioDuration > 0 ? audioDuration : (probedDur > 0 ? probedDur : 10));

        if (segments.length === 0 && rawText) {
            segments = buildAutoSegmentsFromText(rawText, effectiveDuration);
        }

        const presetCode = String(payload.preset || 'sub-245').trim();
        const revealType = ['sentence', 'word', 'char'].includes(String(payload.revealType || '').toLowerCase())
            ? String(payload.revealType).toLowerCase()
            : '';
        const cursorKind = payload.cursorKind !== undefined ? String(payload.cursorKind).trim() : '';

        const resolvedPreset = typeof presetsMod.resolveBuiltinPreset === 'function'
            ? presetsMod.resolveBuiltinPreset(presetCode)
            : null;
        if (!resolvedPreset) {
            throw new Error(`未找到预设编号或名称: ${presetCode}`);
        }

        const resolvedIntroOverlay = job._resolvedIntro !== undefined
            ? job._resolvedIntro
            : this._resolveIntroOverlay(payload);

        const hasExplicitDuration = Number.isFinite(explicitDuration) && explicitDuration > 0;
        const width = Number(payload.width) === 1080 ? 1080 : 720;
        const height = width === 1080 ? 1920 : 1280;
        const fps = [24, 25, 30].includes(Number(payload.fps)) ? Number(payload.fps) : 30;
        const quality = ['high', 'medium', 'low'].includes(String(payload.quality || '').toLowerCase())
            ? String(payload.quality).toLowerCase()
            : 'medium';

        const taskObj = {
            id: job.id,
            engine: resolvedIntroOverlay ? 'wysiwyg' : String(payload.engine || 'auto'),
            width,
            height,
            fps,
            quality,
            ...((hasExplicitDuration || !audioPath) ? { duration: effectiveDuration } : {}),
            bgPath: bgMedia.path,
            ...(resolvedIntroOverlay ? { intro: { ...resolvedIntroOverlay, preset: resolvedIntroOverlay.intro_style } } : {}),
            ...(audioPath ? { audioPath } : {}),
            ...(payload.voiceVolume !== undefined ? { voiceVolume: Number(payload.voiceVolume) } : {}),
            bgVolume: payload.bgVolume !== undefined
                ? Number(payload.bgVolume)
                : (audioPath ? (payload.muteBgVideo === false ? 0.25 : 0.15) : 1.0),
            segments,
            preset: presetCode,
            ...(payload.scrollTitle ? { scroll_title: String(payload.scrollTitle) } : {}),
            ...(rawText ? { scroll_text: rawText } : {}),
            output: job.outputPath,
        };

        if (resolvedPreset.kind === 'subtitle') {
            const subOverrides = (payload.subtitle && typeof payload.subtitle === 'object') ? { ...payload.subtitle } : {};
            if (revealType) {
                subOverrides.typewriter_reveal_type = revealType;
            }
            if (cursorKind && cursorKind !== 'none') {
                subOverrides.subtitle_cursor_enabled = true;
                subOverrides.fullpage_typewriter_cursor_kind = cursorKind;
            } else if (cursorKind === 'none') {
                subOverrides.subtitle_cursor_enabled = false;
            }
            if (Object.keys(subOverrides).length > 0) {
                taskObj.subtitle = subOverrides;
            }
        } else if (resolvedPreset.kind === 'scroll_style') {
            const ov = JSON.parse(JSON.stringify(resolvedPreset.overlays[0]));
            ov.content = rawText || segments.map(s => s.text).join('\n');
            if (payload.scrollTitle) ov.scroll_title = String(payload.scrollTitle);
            if (revealType) {
                ov.scroll_typewriter_enabled = true;
                ov.scroll_tw_reveal_type = revealType;
            }
            if (cursorKind && cursorKind !== 'none') {
                ov.scroll_typewriter_enabled = true;
                ov.scroll_tw_cursor_enabled = true;
                ov.scroll_tw_cursor_kind = cursorKind;
            } else if (cursorKind === 'none') {
                ov.scroll_tw_cursor_enabled = false;
            }
            taskObj.overlays = [ov];
        }

        const taskFile = path.join(job.jobDir, 'task.json');
        fs.writeFileSync(taskFile, JSON.stringify(taskObj, null, 2), 'utf-8');

        job.status = 'rendering';
        job.progress = 55;
        job.message = '正在使用 VideoKit 引擎合成字幕与特效';

        const renderRes = await this.renderReelsTask(taskFile, {
            output: job.outputPath,
            overwrite: true,
            quiet: true,
        }, true);

        const hasThumb = await this._generateThumbnail(job.outputPath, job.thumbPath);
        const base = job.publicBaseUrl ? `${job.publicBaseUrl}` : '';
        job.outputUrl = `${base}/api/canva/files/${encodeURIComponent(job.id)}/${encodeURIComponent(job.fileToken)}/render.mp4`;
        job.thumbnailUrl = hasThumb
            ? `${base}/api/canva/files/${encodeURIComponent(job.id)}/${encodeURIComponent(job.fileToken)}/thumb.jpg`
            : '';
        job.engine = renderRes?.engine || taskObj.engine;
        job.durationSec = renderRes?.duration || effectiveDuration;
        job.progress = 100;
        job.status = 'done';
        job.message = 'VideoKit 渲染完成，可插入 Canva 页面';
    }
}

module.exports = {
    assertSafeCanvaMediaUrl,
    isPrivateOrLocalHostname,
    resolvePublicBaseUrl,
    buildAutoSegmentsFromText,
    buildCanvaPresetCatalog,
    downloadSafeRemoteMedia,
    CanvaJobManager,
};
