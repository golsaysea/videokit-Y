#!/usr/bin/env node
'use strict';

/**
 * VideoKit Native Web Server (bin/videokit-web-server.cjs)
 *
 * Serves the VideoKit web UI (dist/ or src/) together with the HTTP RPC &
 * media-streaming backend required by src/web-bridge.js.
 * Allows users and cloud assistants to operate VideoKit directly in any web browser.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

const repoRoot = path.resolve(__dirname, '..');
const settingsService = require('../electron/services/settings');
const sharedProfile = require('../electron/services/sharedProfile');

// Initialize standalone userData & temp paths before loading apiRouter
const defaultUserDataDir = process.env.VIDEOKIT_DATA_DIR
    || sharedProfile.getPrimarySharedProfileDir()
    || path.join(os.homedir(), '.videokit');
const defaultTempDir = path.join(os.tmpdir(), 'videokit-web-temp');
fs.mkdirSync(defaultUserDataDir, { recursive: true });
fs.mkdirSync(defaultTempDir, { recursive: true });

try {
    settingsService.configureExportPaths({
        userData: defaultUserDataDir,
        tempDir: defaultTempDir,
        systemDirs: [os.homedir(), os.tmpdir(), defaultUserDataDir],
    });
} catch (_) {}

const ffmpegService = require('../electron/services/ffmpeg');
const { routeAPI, routeUpload } = require('../electron/apiRouter');
const { renderReelsTask, getPackageVersion } = require('./videokit-cli.cjs');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.ttc': 'font/collection',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.srt': 'text/plain; charset=utf-8',
    '.ass': 'text/plain; charset=utf-8',
};

function getConfiguredToken() {
    if (process.env.VIDEOKIT_API_TOKEN && process.env.VIDEOKIT_API_TOKEN.trim()) {
        return process.env.VIDEOKIT_API_TOKEN.trim();
    }
    try {
        const cfgPath = path.join(os.homedir(), '.config', 'videokit', 'config.json');
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            if (cfg && cfg.api_token) return String(cfg.api_token).trim();
        }
    } catch (_) {}
    return '';
}

function checkAuth(req, urlObj, overrideToken = '') {
    const expected = overrideToken || getConfiguredToken();
    if (!expected) return true;
    let provided = '';
    const authHeader = String(req.headers['authorization'] || '');
    if (authHeader.startsWith('Bearer ')) {
        provided = authHeader.slice(7).trim();
    } else if (urlObj.searchParams.get('token')) {
        provided = String(urlObj.searchParams.get('token')).trim();
    }
    if (!provided) return false;
    const bufA = Buffer.from(provided);
    const bufB = Buffer.from(expected);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function sendJson(res, statusCode, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end(body);
}

function readRequestBuffer(req, maxBytes = 500 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                reject(new Error('Request payload too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function streamFileWithRange(req, res, filePath, asAttachment = false) {
    if (!filePath || !fs.existsSync(filePath)) {
        sendJson(res, 404, { ok: false, error: `File not found: ${filePath}` });
        return;
    }
    let stat;
    try {
        stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            sendJson(res, 404, { ok: false, error: 'Not a regular file' });
            return;
        }
    } catch (err) {
        sendJson(res, 404, { ok: false, error: err.message });
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
    };
    if (asAttachment) {
        const safeName = encodeURIComponent(path.basename(filePath));
        headers['Content-Disposition'] = `attachment; filename*=UTF-8''${safeName}`;
    }

    const range = req.headers.range;
    if (range) {
        const match = range.match(/bytes=(\d*)-(\d*)/);
        if (match) {
            const start = match[1] ? parseInt(match[1], 10) : 0;
            const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
            if (start >= stat.size || end >= stat.size || start > end) {
                res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                res.end();
                return;
            }
            headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
            headers['Content-Length'] = end - start + 1;
            res.writeHead(206, headers);
            fs.createReadStream(filePath, { start, end }).pipe(res);
            return;
        }
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
}

function getProjectsDir() {
    const dir = path.join(defaultUserDataDir, 'projects');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getPresetsDir() {
    const dir = path.join(defaultUserDataDir, 'videokit-presets');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getUploadsDir() {
    const dir = path.join(defaultUserDataDir, 'web-uploads');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function scanAllFontsForWeb() {
    const fontDirs = [
        path.join(repoRoot, 'resources', 'fonts'),
        path.join(repoRoot, 'assets', 'fonts'),
    ];
    const fonts = [];
    const presentFamilies = new Set();
    const inferWeightStyle = (fileName) => {
        const base = path.parse(fileName).name.toLowerCase();
        const style = /(italic|oblique)/.test(base) ? 'italic' : 'normal';
        let weight = '400';
        if (/\bblack\b/.test(base)) weight = '900';
        else if (/extra[\s_-]*bold|ultra[\s_-]*bold|heavy/.test(base)) weight = '800';
        else if (/\bsemi[\s_-]*bold\b|\bdemi[\s_-]*bold\b/.test(base)) weight = '600';
        else if (/\bbold\b/.test(base)) weight = '700';
        else if (/\bmedium\b/.test(base)) weight = '500';
        else if (/extra[\s_-]*light|ultra[\s_-]*light/.test(base)) weight = '200';
        else if (/\blight\b/.test(base)) weight = '300';
        else if (/\bthin\b|\bhairline\b/.test(base)) weight = '100';
        else if (/variablefont/.test(base)) weight = '100 900';
        return { weight, style };
    };
    for (const dir of fontDirs) {
        if (!fs.existsSync(dir)) continue;
        const walk = (d, parentFamily) => {
            let entries = [];
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) {
                    walk(full, entry.name.replace(/_/g, ' ').trim());
                } else if (/\.(ttf|otf|ttc|woff|woff2)$/i.test(entry.name)) {
                    const family = parentFamily || path.basename(entry.name, path.extname(entry.name))
                        .replace(/([a-z])([A-Z])/g, '$1 $2')
                        .replace(/[-_](Regular|Bold|Italic|Medium|Light|Black|VariableFont.*)/i, '')
                        .replace(/[_-]+/g, ' ')
                        .trim();
                    const { weight, style } = inferWeightStyle(entry.name);
                    presentFamilies.add(family.toLowerCase());
                    fonts.push({ family, name: family, path: full, weight, style, system: false, source: 'bundled' });
                }
            }
        };
        walk(dir, '');
    }

    const assetsFontsDir = path.join(repoRoot, 'assets', 'fonts');
    const aliasDefs = [
        { families: ['Comic Sans MS', 'Balsamiq Sans'], files: [
            { rel: 'Comic_Relief/ComicRelief-Regular.ttf', weight: '400', style: 'normal' },
            { rel: 'Comic_Relief/ComicRelief-Bold.ttf', weight: '700', style: 'normal' },
        ]},
        { families: ['Segoe UI'], files: [
            { rel: 'Fira_Sans/FiraSans-Regular.ttf', weight: '400', style: 'normal' },
            { rel: 'Fira_Sans/FiraSans-Medium.ttf', weight: '500', style: 'normal' },
            { rel: 'Fira_Sans/FiraSans-SemiBold.ttf', weight: '600', style: 'normal' },
            { rel: 'Fira_Sans/FiraSans-Bold.ttf', weight: '700', style: 'normal' },
            { rel: 'Fira_Sans/FiraSans-ExtraBold.ttf', weight: '800', style: 'normal' },
            { rel: 'Fira_Sans/FiraSans-Black.ttf', weight: '900', style: 'normal' },
            { rel: 'Fira_Sans/FiraSans-Italic.ttf', weight: '400', style: 'italic' },
            { rel: 'Fira_Sans/FiraSans-BoldItalic.ttf', weight: '700', style: 'italic' },
            { rel: 'Fira_Sans/FiraSans-ExtraBoldItalic.ttf', weight: '800', style: 'italic' },
            { rel: 'Fira_Sans/FiraSans-BlackItalic.ttf', weight: '900', style: 'italic' },
        ]},
        { families: ['Impact'], files: [
            { rel: 'Anton/Anton-Regular.ttf', weight: '400', style: 'normal' },
            { rel: 'Anton/Anton-Regular.ttf', weight: '700', style: 'normal' },
            { rel: 'Anton/Anton-Regular.ttf', weight: '900', style: 'normal' },
        ]},
        { families: ['Arial Black'], files: [
            { rel: 'Archivo_Black/ArchivoBlack-Regular.ttf', weight: '400', style: 'normal' },
            { rel: 'Archivo_Black/ArchivoBlack-Regular.ttf', weight: '700', style: 'normal' },
            { rel: 'Archivo_Black/ArchivoBlack-Regular.ttf', weight: '900', style: 'normal' },
        ]},
        { families: ['Georgia', 'Times New Roman'], files: [
            { rel: 'Gelasio/Gelasio-VariableFont_wght.ttf', weight: '100 900', style: 'normal' },
            { rel: 'Gelasio/Gelasio-Italic-VariableFont_wght.ttf', weight: '100 900', style: 'italic' },
        ]},
        { families: ['Arial', 'Helvetica'], files: [
            { rel: 'Arimo/Arimo-Regular.ttf', weight: '400', style: 'normal' },
            { rel: 'Arimo/Arimo-Bold.ttf', weight: '700', style: 'normal' },
            { rel: 'Arimo/Arimo-Italic.ttf', weight: '400', style: 'italic' },
            { rel: 'Arimo/Arimo-BoldItalic.ttf', weight: '700', style: 'italic' },
        ]},
        { families: ['Noto Sans SC'], files: [
            { rel: 'Noto Sans/NotoSans-VariableFont-wght-Regular.ttf', weight: '100 900', style: 'normal' },
        ]},
    ];
    for (const def of aliasDefs) {
        for (const fam of def.families) {
            if (presentFamilies.has(fam.toLowerCase())) continue;
            for (const f of def.files) {
                const full = path.join(assetsFontsDir, f.rel);
                if (fs.existsSync(full)) {
                    fonts.push({ family: fam, name: fam, path: full, weight: f.weight, style: f.style, system: false, source: 'bundled-alias' });
                }
            }
        }
    }
    return fonts;
}

/**
 * Handle RPC methods invoked by src/web-bridge.js
 */
async function handleWebBridgeRpc(method, params = {}) {
    switch (method) {
        case 'getAppVersion': {
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
                return pkg.version || '4.5.3';
            } catch {
                return '4.5.3';
            }
        }

        case 'apiCall': {
            const endpoint = String(params.endpoint || '');
            const data = params.data || {};
            try {
                const result = await routeAPI(endpoint, data);
                return { success: true, data: result };
            } catch (err) {
                return { success: false, error: err.message || String(err) };
            }
        }

        case 'apiUpload': {
            const endpoint = String(params.endpoint || '');
            const buf = Buffer.from(String(params.base64 || ''), 'base64');
            const fileName = String(params.fileName || 'upload.bin');
            const formData = params.formData || {};
            try {
                const result = await routeUpload(endpoint, buf, fileName, formData);
                return { success: true, data: result };
            } catch (err) {
                return { success: false, error: err.message || String(err) };
            }
        }

        case 'webListDir': {
            let dirPath = params.dirPath ? String(params.dirPath).trim() : '';
            if (!dirPath || !fs.existsSync(dirPath)) {
                dirPath = getUploadsDir();
            }
            const resolved = path.resolve(dirPath);
            const stat = fs.statSync(resolved);
            const targetDir = stat.isDirectory() ? resolved : path.dirname(resolved);
            const rawEntries = fs.readdirSync(targetDir, { withFileTypes: true });
            const entries = [];
            for (const entry of rawEntries) {
                if (entry.name.startsWith('.')) continue;
                const full = path.join(targetDir, entry.name);
                try {
                    const st = fs.statSync(full);
                    entries.push({
                        name: entry.name,
                        path: full,
                        isDirectory: st.isDirectory(),
                        size: st.size,
                        mtimeMs: st.mtimeMs,
                    });
                } catch (_) {}
            }
            entries.sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name, undefined, { numeric: true });
            });
            return { currentDir: targetDir, entries, items: entries };
        }

        case 'webCreateDir': {
            const parentDir = params.parentDir && fs.existsSync(params.parentDir)
                ? path.resolve(params.parentDir)
                : getUploadsDir();
            const safeName = path.basename(String(params.name || 'NewFolder').trim());
            const full = path.join(parentDir, safeName);
            fs.mkdirSync(full, { recursive: true });
            return { ok: true, path: full };
        }

        case 'fsExists':
            return Boolean(params.path && fs.existsSync(params.path));

        case 'isDirectory':
            try {
                return Boolean(params.path && fs.existsSync(params.path) && fs.statSync(params.path).isDirectory());
            } catch {
                return false;
            }

        case 'fsStat':
            try {
                const s = fs.statSync(params.path);
                return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory(), isFile: s.isFile() };
            } catch {
                return null;
            }

        case 'fsReaddir':
            try {
                return fs.readdirSync(params.path, { withFileTypes: true }).map(e => ({
                    name: e.name,
                    isDirectory: e.isDirectory(),
                    isFile: e.isFile(),
                }));
            } catch {
                return [];
            }

        case 'readFileText':
            try {
                return fs.readFileSync(params.filePath, 'utf-8');
            } catch {
                return '';
            }

        case 'writeFileText':
            try {
                fs.mkdirSync(path.dirname(params.filePath), { recursive: true });
                fs.writeFileSync(params.filePath, String(params.content ?? ''), 'utf-8');
                return true;
            } catch {
                return false;
            }

        case 'ensureDirectory':
            if (params.dirPath) fs.mkdirSync(params.dirPath, { recursive: true });
            return true;

        case 'checkFilesExist': {
            const results = {};
            for (const p of (params.filePaths || [])) {
                try { results[p] = fs.existsSync(p); } catch { results[p] = false; }
            }
            return results;
        }

        case 'scanDirectory':
        case 'local:listDirectory': {
            const dirPath = params.dirPath || params.folderPath;
            if (!dirPath || !fs.existsSync(dirPath)) {
                return method === 'local:listDirectory' ? { success: false, exists: false, items: [] } : [];
            }
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            const files = [];
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const fullPath = path.join(dirPath, entry.name);
                try {
                    const st = fs.statSync(fullPath);
                    files.push({
                        name: entry.name,
                        path: fullPath,
                        size: st.size,
                        mtime: st.mtimeMs,
                        modifiedTime: new Date(st.mtimeMs).toISOString(),
                        isDirectory: st.isDirectory(),
                    });
                } catch (_) {}
            }
            if (method === 'local:listDirectory') {
                return { success: true, exists: true, items: files };
            }
            return files;
        }

        case 'scanDirectoryRecursive':
        case 'local:scanFolder': {
            const dirPath = params.dirPath || params.folderPath;
            const options = params.options || {};
            const maxDepth = Math.max(0, Math.min(50, Number(options.maxDepth) || 20));
            const excludedNames = new Set((options.excludedNames || ['_auto_edit', 'backup_clips', '已排除素材', '已排除'])
                .map(n => String(n || '').toLowerCase()));
            const files = [];
            if (!dirPath || !fs.existsSync(dirPath)) return files;
            const walk = (cur, depth) => {
                if (depth > maxDepth) return;
                let entries = [];
                try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
                for (const entry of entries) {
                    if (entry.name.startsWith('.')) continue;
                    const full = path.join(cur, entry.name);
                    if (entry.isSymbolicLink()) continue;
                    if (entry.isDirectory()) {
                        if (!excludedNames.has(entry.name.toLowerCase())) walk(full, depth + 1);
                        continue;
                    }
                    if (!entry.isFile()) continue;
                    try {
                        const st = fs.statSync(full);
                        files.push({
                            name: entry.name,
                            path: full,
                            relativePath: path.relative(dirPath, full),
                            size: st.size,
                            mtime: st.mtimeMs,
                            isDirectory: false,
                        });
                    } catch (_) {}
                }
            };
            walk(dirPath, 0);
            return files;
        }

        case 'searchFilesRecursive': {
            const { searchDir, fileNames = [], maxDepth = 5 } = params;
            const result = {};
            const targetSet = new Set(fileNames.map(n => String(n).toLowerCase()));
            if (!searchDir || !fs.existsSync(searchDir)) return result;
            const walk = (dir, depth) => {
                if (depth > maxDepth) return;
                let entries = [];
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
                for (const entry of entries) {
                    if (entry.name.startsWith('.')) continue;
                    const full = path.join(dir, entry.name);
                    if (entry.isFile()) {
                        const lower = entry.name.toLowerCase();
                        if (targetSet.has(lower) && !result[lower]) result[lower] = full;
                    } else if (entry.isDirectory()) {
                        walk(full, depth + 1);
                    }
                }
            };
            walk(searchDir, 0);
            return result;
        }

        case 'getDownloadsPath':
            return path.join(defaultUserDataDir, 'exports');

        case 'getDefaultProjectDir':
            return getProjectsDir();

        case 'readReelsOutputDirectory': {
            try {
                const f = path.join(defaultUserDataDir, 'ui-preferences.json');
                if (fs.existsSync(f)) {
                    return JSON.parse(fs.readFileSync(f, 'utf-8')).reelsOutputDir || path.join(defaultUserDataDir, 'exports');
                }
            } catch (_) {}
            const expDir = path.join(defaultUserDataDir, 'exports');
            fs.mkdirSync(expDir, { recursive: true });
            return expDir;
        }

        case 'saveReelsOutputDirectory': {
            const dir = String(params.dir || '').trim();
            if (!dir) return { ok: false, error: '目录不能为空' };
            fs.mkdirSync(dir, { recursive: true });
            const f = path.join(defaultUserDataDir, 'ui-preferences.json');
            fs.writeFileSync(f, JSON.stringify({ reelsOutputDir: dir }, null, 2), 'utf-8');
            return { ok: true };
        }

        case 'readPersistentPreset': {
            const key = String(params.key || '').replace(/[^a-zA-Z0-9_-]/g, '');
            const f = path.join(getPresetsDir(), `${key}.json`);
            if (fs.existsSync(f)) return fs.readFileSync(f, 'utf-8');
            return '{}';
        }

        case 'savePersistentPreset': {
            const key = String(params.key || '').replace(/[^a-zA-Z0-9_-]/g, '');
            const f = path.join(getPresetsDir(), `${key}.json`);
            fs.writeFileSync(f, String(params.value || '{}'), 'utf-8');
            return { ok: true };
        }

        case 'readBatchWorkspace': {
            const f = path.join(getProjectsDir(), 'workspace-autosave.json');
            if (fs.existsSync(f)) return fs.readFileSync(f, 'utf-8');
            return sharedProfile.readUnifiedBatchWorkspace() || '';
        }

        case 'saveBatchWorkspace': {
            const f = path.join(getProjectsDir(), 'workspace-autosave.json');
            fs.writeFileSync(f, String(params.content || ''), 'utf-8');
            return true;
        }

        case 'listSharedProjectFiles': {
            const dir = params.customDir && fs.existsSync(params.customDir) ? params.customDir : getProjectsDir();
            const entries = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.json'));
            return entries.map(fname => {
                const full = path.join(dir, fname);
                const st = fs.statSync(full);
                return { filename: fname, path: full, mtimeMs: st.mtimeMs, size: st.size };
            });
        }

        case 'saveSharedProjectFile': {
            const dir = params.customDir ? path.resolve(params.customDir) : getProjectsDir();
            fs.mkdirSync(dir, { recursive: true });
            const safeName = path.basename(String(params.fileName || 'Project.json'));
            fs.writeFileSync(path.join(dir, safeName), String(params.content || ''), 'utf-8');
            return true;
        }

        case 'getMediaDuration':
            return await ffmpegService.getMediaDuration(params.filePath);

        case 'getMediaDurationDetail':
            if (typeof ffmpegService.getMediaDurationDetail === 'function') {
                return await ffmpegService.getMediaDurationDetail(params.filePath);
            }
            return { ok: true, duration: await ffmpegService.getMediaDuration(params.filePath) };

        case 'reelsDetectSilence':
            return await ffmpegService.detectSilence(params.filePath, Number(params.noiseDb ?? -35), Number(params.minDuration ?? 0.35));

        case 'scanFonts':
            return scanAllFontsForWeb();

        case 'fetchGoogleFonts':
            return [];

        case 'burnSubtitles': {
            const { videoPath, assContent, outputPath } = params;
            const out = outputPath || path.join(defaultUserDataDir, 'exports', `burn_${Date.now()}.mp4`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            const assPath = path.join(defaultTempDir, `sub_${Date.now()}.ass`);
            fs.writeFileSync(assPath, String(assContent || ''), 'utf-8');
            await ffmpegService.burnSubtitles(videoPath, assPath, out);
            try { fs.unlinkSync(assPath); } catch (_) {}
            return { success: true, outputPath: out };
        }

        case 'reelsCompose': {
            const data = params || {};
            const out = data.output_path || path.join(defaultUserDataDir, 'exports', `reel_${Date.now()}.mp4`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            const res = await ffmpegService.composeReel({
                backgroundPath: data.background_path,
                voicePath: data.voice_path,
                assContent: data.ass_content,
                outputPath: out,
                crf: parseInt(data.crf || 23, 10),
                useGPU: Boolean(data.use_gpu),
                loopFade: data.loop_fade !== false,
                loopFadeDur: parseFloat(data.loop_fade_dur ?? 1.0),
                voiceVolume: parseFloat(data.voice_volume ?? 1.0),
                bgVolume: parseFloat(data.bg_volume ?? 0.0),
                bgmPath: data.bgm_path || '',
                bgmVolume: parseFloat(data.bgm_volume ?? 0),
                bgmStart: Math.max(0, parseFloat(data.bgm_start ?? 0) || 0),
            });
            return { success: true, data: { ...res, outputPath: out } };
        }

        case 'isolatedWysiwygExport': {
            const p = params.params || params || {};
            const outPath = p.outputPath || path.join(defaultUserDataDir, 'exports', `reel_${Date.now()}.mp4`);
            fs.mkdirSync(path.dirname(outPath), { recursive: true });

            const taskDir = fs.mkdtempSync(path.join(defaultTempDir, 'web-reel-task-'));
            const taskFile = path.join(taskDir, 'task.json');
            const w = Number(p.targetWidth) === 1080 ? 1080 : 720;
            const h = w === 1080 ? 1920 : 1280;
            const fps = [24, 25, 30].includes(Number(p.fps)) ? Number(p.fps) : 30;

            const taskObj = {
                id: String(params.requestId || `web-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, '_'),
                engine: 'auto',
                width: w,
                height: h,
                fps,
                duration: Number(p.customDuration) > 0 ? Number(p.customDuration) : undefined,
                bgPath: p.backgroundPath || undefined,
                bgClipPool: Array.isArray(p.bgClipPool) && p.bgClipPool.length > 0 ? p.bgClipPool : undefined,
                contentVideoPath: p.contentVideoPath || undefined,
                audioPath: p.voicePath || undefined,
                bgmPath: p.bgmPath || undefined,
                segments: Array.isArray(p.segments) ? p.segments : [],
                subtitle: p.style || {},
                overlays: Array.isArray(p.overlays) ? p.overlays : [],
                output: outPath,
            };
            fs.writeFileSync(taskFile, JSON.stringify(taskObj, null, 2), 'utf-8');
            try {
                const res = await renderReelsTask(taskFile, { output: outPath, overwrite: true, quiet: true }, true);
                return { success: true, outputPath: res.output || outPath, engine: res.engine };
            } finally {
                try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch (_) {}
            }
        }

        case 'getCacheInfo':
            return { path: defaultTempDir, sizeBytes: 0, formattedSize: '0 MB' };

        case 'clearCache':
            return { success: true };

        default:
            return null;
    }
}

function createWebServer(options = {}) {
    const distDir = path.join(repoRoot, 'dist');
    const srcDir = path.join(repoRoot, 'src');
    const assetsDir = path.join(repoRoot, 'assets');
    const fontsDir = path.join(repoRoot, 'resources', 'fonts');
    const customToken = options && options.token ? String(options.token).trim() : '';

    return http.createServer(async (req, res) => {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            });
            res.end();
            return;
        }

        const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const pathname = decodeURIComponent(urlObj.pathname);
        const activeToken = customToken || getConfiguredToken();

        if (pathname === '/api/health') {
            sendJson(res, 200, {
                status: 'ok',
                mode: 'web-bridge',
                version: typeof getPackageVersion === 'function' ? getPackageVersion() : '4.5.3',
                auth_required: Boolean(activeToken),
            });
            return;
        }

        if (pathname.startsWith('/api/')) {
            if (!checkAuth(req, urlObj, activeToken)) {
                sendJson(res, 401, { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
                return;
            }
        }

        if (pathname === '/api/web-bridge/media' && req.method === 'GET') {
            const rawPath = urlObj.searchParams.get('path') || '';
            if (!rawPath || rawPath.split(/[\\/]+/).includes('..')) {
                sendJson(res, 400, { ok: false, error: 'Invalid media path' });
                return;
            }
            streamFileWithRange(req, res, path.resolve(rawPath), false);
            return;
        }

        if (pathname === '/api/web-bridge/download' && req.method === 'GET') {
            const rawPath = urlObj.searchParams.get('path') || '';
            if (!rawPath || rawPath.split(/[\\/]+/).includes('..')) {
                sendJson(res, 400, { ok: false, error: 'Invalid download path' });
                return;
            }
            streamFileWithRange(req, res, path.resolve(rawPath), true);
            return;
        }

        if (pathname === '/api/web-bridge/upload-raw' && req.method === 'POST') {
            try {
                const rawName = path.basename(String(urlObj.searchParams.get('filename') || urlObj.searchParams.get('name') || 'upload.bin'));
                const targetDirParam = urlObj.searchParams.get('targetDir') || '';
                if (!rawName || rawName.includes('..')) {
                    sendJson(res, 400, { ok: false, error: 'Invalid filename' });
                    return;
                }
                const targetDir = (targetDirParam && fs.existsSync(targetDirParam))
                    ? path.resolve(targetDirParam)
                    : getUploadsDir();
                fs.mkdirSync(targetDir, { recursive: true });
                const destPath = path.join(targetDir, rawName);
                const buf = await readRequestBuffer(req);
                fs.writeFileSync(destPath, buf);
                sendJson(res, 200, { ok: true, path: destPath, size: buf.length });
            } catch (err) {
                sendJson(res, 500, { ok: false, error: err.message });
            }
            return;
        }

        if (pathname === '/api/web-bridge/rpc' && req.method === 'POST') {
            try {
                const buf = await readRequestBuffer(req);
                const body = JSON.parse(buf.toString('utf-8') || '{}');
                const rpcMethod = body.method || body.action;
                let rpcParams = body.params || {};
                if (!body.params && Array.isArray(body.args)) {
                    if (rpcMethod === 'webListDir' || rpcMethod === 'scanDirectory' || rpcMethod === 'scanDirectoryRecursive') {
                        rpcParams = { dirPath: body.args[0], options: body.args[1] };
                    } else if (body.args[0] && typeof body.args[0] === 'object') {
                        rpcParams = body.args[0];
                    }
                }
                const result = await handleWebBridgeRpc(rpcMethod, rpcParams);
                sendJson(res, 200, { ok: true, result });
            } catch (err) {
                sendJson(res, 500, { ok: false, error: err.message || String(err) });
            }
            return;
        }

        // Static assets (/assets/*)
        if (pathname.startsWith('/assets/')) {
            const rel = pathname.slice('/assets/'.length);
            if (!rel.includes('..')) {
                const cand1 = path.join(distDir, 'assets', rel);
                const cand2 = path.join(assetsDir, rel);
                if (fs.existsSync(cand1)) return streamFileWithRange(req, res, cand1);
                if (fs.existsSync(cand2)) return streamFileWithRange(req, res, cand2);
            }
        }

        // Static fonts (/fonts/*)
        if (pathname.startsWith('/fonts/')) {
            const rel = pathname.slice('/fonts/'.length);
            if (!rel.includes('..')) {
                const fontCand = path.join(fontsDir, rel);
                if (fs.existsSync(fontCand)) return streamFileWithRange(req, res, fontCand);
            }
        }

        // Serve frontend static files from dist/ (or src/)
        const webRoot = fs.existsSync(path.join(distDir, 'index.html')) ? distDir : srcDir;
        const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        if (relPath.split(/[\\/]+/).includes('..')) {
            sendJson(res, 400, { ok: false, error: 'Invalid path' });
            return;
        }
        let targetFile = path.join(webRoot, relPath);
        if (!fs.existsSync(targetFile) && webRoot === distDir) {
            const srcFallback = path.join(srcDir, relPath);
            if (fs.existsSync(srcFallback)) targetFile = srcFallback;
        }
        if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
            streamFileWithRange(req, res, targetFile, false);
            return;
        }

        sendJson(res, 404, { ok: false, error: `Not found: ${pathname}` });
    });
}

if (require.main === module) {
    const port = Number(process.env.VIDEOKIT_WEB_PORT || process.env.VIDEOKIT_PORT || 5080);
    const host = process.env.VIDEOKIT_WEB_HOST || process.env.VIDEOKIT_HOST || '0.0.0.0';
    const server = createWebServer();
    server.listen(port, host, () => {
        console.log(`[VideoKit Web] Native Web UI running at http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
        console.log(`[VideoKit Web] Data & uploads directory: ${defaultUserDataDir}`);
    });
}

module.exports = {
    createWebServer,
    handleWebBridgeRpc,
};
