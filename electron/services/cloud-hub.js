/**
 * Cloud Hub & Daily Project Sync Service
 *
 * Powers:
 * 1. Remote API Key Pool & Config sync from a master Cloudflare Worker / KV / R2 / JSON URL
 * 2. Daily Project ("日期贴") listing & one-click Google Drive direct download + smart local material relinking
 */
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

function getCloudHubSettingsPath() {
    return path.join(settings.getBackendDir(), 'cloud_hub_settings.json');
}

function getSafeStorage() {
    try { return require('electron').safeStorage; } catch { return null; }
}

function encryptSecret(secret) {
    const clean = String(secret || '').trim();
    if (!clean) return { token: '', token_encrypted: '' };
    const safeStorage = getSafeStorage();
    if (safeStorage?.isEncryptionAvailable?.()) {
        try {
            return {
                token: '',
                token_encrypted: safeStorage.encryptString(clean).toString('base64'),
            };
        } catch (_) {}
    }
    return { token: clean, token_encrypted: '' };
}

function decryptSecret(data) {
    if (data?.token && typeof data.token === 'string' && data.token.trim()) {
        return data.token.trim();
    }
    if (data?.token_encrypted && typeof data.token_encrypted === 'string') {
        const safeStorage = getSafeStorage();
        if (safeStorage?.isEncryptionAvailable?.()) {
            try {
                return safeStorage.decryptString(Buffer.from(data.token_encrypted, 'base64')).trim();
            } catch (_) {}
        }
    }
    return '';
}

function normalizeKeyArray(val) {
    if (Array.isArray(val)) {
        return [...new Set(val.map(v => String(v || '').trim()).filter(Boolean))];
    }
    if (typeof val === 'string') {
        return [...new Set(val.split(/[\r\n,]+/).map(v => v.trim()).filter(Boolean))];
    }
    return [];
}

function normalizeDailyProjects(rawProjects) {
    const out = [];
    if (Array.isArray(rawProjects)) {
        for (const item of rawProjects) {
            if (!item) continue;
            if (typeof item === 'string') {
                const url = item.trim();
                if (url) {
                    out.push({
                        id: 'dp_' + Buffer.from(url).toString('base64').slice(0, 10),
                        date: new Date().toISOString().slice(0, 10),
                        title: '云端工程',
                        url,
                        note: '',
                    });
                }
                continue;
            }
            if (typeof item === 'object') {
                const url = String(item.url || item.link || item.gdrive_url || item.drive_url || '').trim();
                if (!url) continue;
                const date = String(item.date || item.day || new Date().toISOString().slice(0, 10)).trim();
                const title = String(item.title || item.name || item.label || `${date} 云端工程`).trim();
                const note = String(item.note || item.desc || item.description || '').trim();
                out.push({
                    id: String(item.id || ('dp_' + date.replace(/[^0-9]/g, '') + '_' + Buffer.from(url).toString('base64').slice(0, 8))),
                    date,
                    title,
                    url,
                    note,
                    updated_at: item.updated_at || null,
                });
            }
        }
    } else if (rawProjects && typeof rawProjects === 'object') {
        for (const [dateKey, val] of Object.entries(rawProjects)) {
            if (typeof val === 'string' && val.trim()) {
                out.push({
                    id: 'dp_' + dateKey,
                    date: dateKey,
                    title: `${dateKey} 每日工程`,
                    url: val.trim(),
                    note: '',
                });
            } else if (val && typeof val === 'object' && (val.url || val.link)) {
                out.push({
                    id: String(val.id || ('dp_' + dateKey)),
                    date: String(val.date || dateKey),
                    title: String(val.title || val.name || `${dateKey} 每日工程`),
                    url: String(val.url || val.link).trim(),
                    note: String(val.note || ''),
                });
            }
        }
    }
    return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

function loadCloudHubSettings() {
    const raw = settings.readJSON(getCloudHubSettingsPath()) || {};
    const accessToken = decryptSecret(raw);
    return {
        hub_url: String(raw.hub_url || '').trim(),
        access_token: accessToken,
        has_token: Boolean(accessToken),
        sync_mode: raw.sync_mode === 'overwrite' ? 'overwrite' : 'merge',
        auto_sync_on_startup: raw.auto_sync_on_startup !== false,
        local_material_root: String(raw.local_material_root || '').trim(),
        last_sync_at: raw.last_sync_at || null,
        last_sync_summary: raw.last_sync_summary || null,
        daily_projects: normalizeDailyProjects(raw.daily_projects || []),
    };
}

function saveCloudHubSettings(input = {}) {
    const current = loadCloudHubSettings();
    const hubUrl = input.hub_url !== undefined ? String(input.hub_url || '').trim() : current.hub_url;
    const accessToken = input.access_token !== undefined ? String(input.access_token || '').trim() : current.access_token;
    const syncMode = (input.sync_mode || current.sync_mode) === 'overwrite' ? 'overwrite' : 'merge';
    const autoSync = input.auto_sync_on_startup !== undefined ? Boolean(input.auto_sync_on_startup) : current.auto_sync_on_startup;
    const localMaterialRoot = input.local_material_root !== undefined
        ? String(input.local_material_root || '').trim()
        : current.local_material_root;
    const dailyProjects = input.daily_projects !== undefined
        ? normalizeDailyProjects(input.daily_projects)
        : current.daily_projects;

    const secretObj = encryptSecret(accessToken);
    const toSave = {
        version: 1,
        hub_url: hubUrl,
        ...secretObj,
        sync_mode: syncMode,
        auto_sync_on_startup: autoSync,
        local_material_root: localMaterialRoot,
        last_sync_at: input.last_sync_at !== undefined ? input.last_sync_at : current.last_sync_at,
        last_sync_summary: input.last_sync_summary !== undefined ? input.last_sync_summary : current.last_sync_summary,
        daily_projects: dailyProjects,
    };
    settings.writeJSON(getCloudHubSettingsPath(), toSave);
    return loadCloudHubSettings();
}

/**
 * Extracts Google Drive file ID from common share URLs:
 * - https://drive.google.com/file/d/FILE_ID/view?usp=sharing
 * - https://drive.google.com/open?id=FILE_ID
 * - https://drive.google.com/uc?id=FILE_ID&export=download
 * - https://docs.google.com/document/d/FILE_ID/...
 */
function extractGoogleDriveFileId(rawUrl) {
    const str = String(rawUrl || '').trim();
    if (!str) return null;
    const mFile = str.match(/\/(?:file|document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]{10,})/i);
    if (mFile) return mFile[1];
    try {
        const u = new URL(str);
        if (/(^|\.)((drive|docs)\.google\.com|drive\.usercontent\.google\.com)$/i.test(u.hostname)) {
            const idParam = u.searchParams.get('id');
            if (idParam && /^[a-zA-Z0-9_-]{10,}$/.test(idParam)) return idParam;
        }
    } catch (_) {}
    return null;
}

/**
 * Resolves share links (Google Drive, Dropbox, GitHub blob) into direct download URLs.
 */
function resolveCloudDownloadUrl(rawUrl) {
    const clean = String(rawUrl || '').trim();
    if (!clean) return '';
    const gdriveId = extractGoogleDriveFileId(clean);
    if (gdriveId) {
        return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(gdriveId)}&confirm=t`;
    }
    try {
        const u = new URL(clean);
        if (/(\.|^)dropbox\.com$/i.test(u.hostname)) {
            u.searchParams.set('dl', '1');
            return u.toString();
        }
        if (u.hostname === 'github.com' && u.pathname.includes('/blob/')) {
            u.hostname = 'raw.githubusercontent.com';
            u.pathname = u.pathname.replace('/blob/', '/');
            return u.toString();
        }
    } catch (_) {}
    return clean;
}

function buildHubRequestUrl(hubUrl, token = '') {
    const clean = String(hubUrl || '').trim();
    if (!clean) throw new Error('请先填写 Cloudflare 总链接 URL');
    const u = new URL(clean);
    if (!u.searchParams.has('format')) {
        u.searchParams.set('format', 'json');
    }
    if (token && !u.searchParams.has('token')) {
        u.searchParams.set('token', token);
    }
    return u.toString();
}

function buildHubHeaders(token = '') {
    const headers = {
        'Accept': 'application/json',
        'User-Agent': 'VideoKit-CloudHub/4.5.8',
    };
    const cleanToken = String(token || '').trim();
    if (cleanToken) {
        headers['X-Hub-Token'] = cleanToken;
        headers['Authorization'] = `Bearer ${cleanToken}`;
    }
    return headers;
}

async function fetchTextWithDriveBypass(rawUrl, customHeaders = {}) {
    const directUrl = resolveCloudDownloadUrl(rawUrl);
    if (!directUrl) throw new Error('下载链接为空');
    const gdriveId = extractGoogleDriveFileId(rawUrl);

    const res = await fetch(directUrl, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VideoKit/4.5.8',
            ...customHeaders,
        },
        redirect: 'follow',
    });
    if (!res.ok) {
        throw new Error(`云端请求失败 (HTTP ${res.status} ${res.statusText})`);
    }
    const text = await res.text();

    // Handle Google Drive large-file virus-scan HTML confirmation page if returned
    if (gdriveId && /^\s*<!DOCTYPE html>|^\s*<html/i.test(text)) {
        const confirmMatch = text.match(/name="confirm"\s+value="([^"]+)"/i);
        const uuidMatch = text.match(/name="uuid"\s+value="([^"]+)"/i);
        const actionMatch = text.match(/<form[^>]+action="([^"]+)"/i);
        const actionUrl = actionMatch ? actionMatch[1].replace(/&amp;/g, '&') : 'https://drive.usercontent.google.com/download';
        const u2 = new URL(actionUrl);
        u2.searchParams.set('id', gdriveId);
        u2.searchParams.set('export', 'download');
        u2.searchParams.set('confirm', confirmMatch ? confirmMatch[1] : 't');
        if (uuidMatch) u2.searchParams.set('uuid', uuidMatch[1]);

        const res2 = await fetch(u2.toString(), {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VideoKit/4.5.8',
                ...customHeaders,
            },
            redirect: 'follow',
        });
        if (!res2.ok) {
            throw new Error(`Google Drive 确认下载失败 (HTTP ${res2.status})`);
        }
        return await res2.text();
    }

    return text;
}

/**
 * Syncs API keys (Groq, Gladia, Deepgram, Gemini, ElevenLabs) and daily project links
 * from the configured Cloudflare Hub URL.
 */
async function syncFromCloudHub(input = {}) {
    const saved = saveCloudHubSettings(input);
    const hubUrl = saved.hub_url;
    if (!hubUrl) {
        throw new Error('请先填写 Cloudflare 总配置链接');
    }

    const reqUrl = buildHubRequestUrl(hubUrl, saved.access_token);
    const text = await fetchTextWithDriveBypass(reqUrl, buildHubHeaders(saved.access_token));
    let remote;
    try {
        remote = JSON.parse(text);
    } catch (_) {
        throw new Error('云端返回的内容不是有效的 JSON 格式，请检查链接是否正确');
    }
    if (remote && remote.ok === false && remote.error) {
        throw new Error(remote.error);
    }
    const payload = (remote && typeof remote.data === 'object' && !Array.isArray(remote.data))
        ? remote.data
        : remote;

    const mode = saved.sync_mode === 'overwrite' ? 'overwrite' : 'merge';
    const mergeList = (localList, remoteList, hasRemoteField) => {
        if (!hasRemoteField) return localList;
        if (mode === 'overwrite') return remoteList;
        return [...new Set([...localList, ...remoteList])];
    };

    // 1. Transcription Providers (Groq, Gladia, Deepgram)
    const currentTrans = settings.loadTranscriptionProviders();
    const hasGroq = payload.groq_keys !== undefined || payload.providers?.groq !== undefined;
    const hasGladia = payload.gladia_keys !== undefined || payload.providers?.gladia !== undefined;
    const hasDeepgram = payload.deepgram_keys !== undefined || payload.providers?.deepgram !== undefined;

    const remoteGroq = normalizeKeyArray(payload.groq_keys ?? payload.providers?.groq?.keys ?? payload.providers?.groq);
    const remoteGladia = normalizeKeyArray(payload.gladia_keys ?? payload.providers?.gladia?.keys ?? payload.providers?.gladia);
    const remoteDeepgram = normalizeKeyArray(payload.deepgram_keys ?? payload.providers?.deepgram?.keys ?? payload.providers?.deepgram);

    const nextGroq = mergeList(currentTrans.providers?.groq?.keys || [], remoteGroq, hasGroq);
    const nextGladia = mergeList(currentTrans.providers?.gladia?.keys || [], remoteGladia, hasGladia);
    const nextDeepgram = mergeList(currentTrans.providers?.deepgram?.keys || [], remoteDeepgram, hasDeepgram);
    const nextPrimary = payload.primary_transcription || payload.primary || currentTrans.primary || 'groq';

    if (hasGroq || hasGladia || hasDeepgram || payload.primary_transcription || payload.primary) {
        settings.saveTranscriptionProviders({
            primary: nextPrimary,
            groq_keys: nextGroq,
            gladia_keys: nextGladia,
            deepgram_keys: nextDeepgram,
        });
    }

    // 2. Gemini Keys
    const currentGemini = settings.loadGeminiKeys();
    const hasGemini = payload.gemini_keys !== undefined || payload.gemini?.keys !== undefined;
    const hasGeminiTts = payload.gemini_tts_keys !== undefined || payload.gemini?.tts_keys !== undefined;
    const remoteGemini = normalizeKeyArray(payload.gemini_keys ?? payload.gemini?.keys);
    const remoteGeminiTts = normalizeKeyArray(payload.gemini_tts_keys ?? payload.gemini?.tts_keys);
    const nextGemini = mergeList(currentGemini.keys || [], remoteGemini, hasGemini);
    const nextGeminiTts = mergeList(currentGemini.tts_keys || [], remoteGeminiTts, hasGeminiTts);

    if (hasGemini || hasGeminiTts || payload.gemini_model || payload.gemini_prompt) {
        settings.saveGeminiKeys({
            keys: nextGemini,
            tts_keys: nextGeminiTts.length ? nextGeminiTts : nextGemini,
            model: payload.gemini_model || payload.gemini?.model || currentGemini.model,
            prompt: payload.gemini_prompt || payload.gemini?.prompt || currentGemini.prompt,
        });
    }

    // 3. ElevenLabs Keys
    const currentEl = settings.loadElevenLabsSettings();
    const hasEl = payload.elevenlabs_keys !== undefined || payload.elevenlabs?.api_keys !== undefined;
    const remoteEl = normalizeKeyArray(payload.elevenlabs_keys ?? payload.elevenlabs?.api_keys);
    const nextEl = mergeList(currentEl.api_keys || [], remoteEl, hasEl);
    if (hasEl) {
        settings.saveElevenLabsSettings({
            api_keys: nextEl,
        });
    }

    // 4. Daily Projects ("日期贴")
    const remoteProjectsRaw = payload.daily_projects ?? payload.projects ?? payload.dailyProjects;
    const nextDailyProjects = remoteProjectsRaw !== undefined
        ? normalizeDailyProjects(remoteProjectsRaw)
        : saved.daily_projects;

    const summary = {
        mode,
        primary_transcription: nextPrimary,
        groq: nextGroq.length,
        gladia: nextGladia.length,
        deepgram: nextDeepgram.length,
        gemini: nextGemini.length,
        elevenlabs: nextEl.length,
        daily_projects: nextDailyProjects.length,
        counts: {
            groq: nextGroq.length,
            gladia: nextGladia.length,
            deepgram: nextDeepgram.length,
            gemini: nextGemini.length,
            elevenlabs: nextEl.length,
            daily_projects: nextDailyProjects.length,
        },
        remote_added: {
            groq: remoteGroq.length,
            gladia: remoteGladia.length,
            deepgram: remoteDeepgram.length,
            gemini: remoteGemini.length,
            elevenlabs: remoteEl.length,
        },
    };

    const updatedSettings = saveCloudHubSettings({
        last_sync_at: new Date().toISOString(),
        last_sync_summary: summary,
        daily_projects: nextDailyProjects,
    });

    return {
        ok: true,
        status: 'success',
        stats: summary.counts,
        summary,
        settings: updatedSettings,
    };
}

/**
 * Pushes local API keys or adds/removes a Daily Project entry to the Cloudflare Worker Hub
 * (and also persists locally in cloud_hub_settings.json).
 */
async function pushToCloudHub(input = {}) {
    const settingsPatch = { ...(input.settings || {}) };
    if (typeof input.hub_url === 'string' && input.hub_url.trim()) settingsPatch.hub_url = input.hub_url.trim();
    if (typeof input.access_token === 'string' && input.access_token.trim()) settingsPatch.access_token = input.access_token.trim();
    const current = saveCloudHubSettings(settingsPatch);
    const action = input.action || 'push_all';

    // Always update local daily_projects list first so local management works even without a remote Worker
    if (action === 'add_daily_project' && input.project) {
        const proj = {
            id: input.project.id || ('dp_' + Date.now().toString(36)),
            date: String(input.project.date || new Date().toISOString().slice(0, 10)).trim(),
            title: String(input.project.title || '每日云端工程').trim(),
            url: String(input.project.url || input.project.drive_url || '').trim(),
            drive_url: String(input.project.url || input.project.drive_url || '').trim(),
            note: String(input.project.note || '').trim(),
            material_folder_hint: String(input.project.material_folder_hint || '').trim(),
            updated_at: new Date().toISOString(),
        };
        if (!proj.url) throw new Error('请填写 Google Drive 或云端工程链接');
        const nextList = [
            proj,
            ...(current.daily_projects || []).filter(p => !(p.date === proj.date && p.title === proj.title && p.url === proj.url)),
        ];
        saveCloudHubSettings({ daily_projects: nextList });
    } else if (action === 'delete_daily_project') {
        const nextList = (current.daily_projects || []).filter((p, idx) => {
            if (input.id && p.id === input.id) return false;
            if (typeof input.index === 'number' && idx === input.index) return false;
            return true;
        });
        saveCloudHubSettings({ daily_projects: nextList });
    }

    const latest = loadCloudHubSettings();
    if (!latest.hub_url) {
        return {
            ok: true,
            status: 'success',
            local_only: true,
            settings: latest,
            message: '已保存在本机日期贴列表（未配置 Cloudflare 总链接，跳过远程推送）',
        };
    }

    const trans = settings.loadTranscriptionProviders();
    const gemini = settings.loadGeminiKeys();
    const el = settings.loadElevenLabsSettings();

    const postBody = (action === 'add_daily_project' || action === 'delete_daily_project')
        ? input
        : {
            version: 1,
            primary_transcription: trans.primary || 'groq',
            groq_keys: trans.providers?.groq?.keys || [],
            gladia_keys: trans.providers?.gladia?.keys || [],
            deepgram_keys: trans.providers?.deepgram?.keys || [],
            gemini_keys: gemini.keys || [],
            gemini_tts_keys: gemini.tts_keys || [],
            gemini_model: gemini.model || 'gemini-3.5-flash-lite',
            elevenlabs_keys: el.api_keys || [],
            daily_projects: latest.daily_projects || [],
        };

    const reqUrl = buildHubRequestUrl(latest.hub_url, latest.access_token);
    const res = await fetch(reqUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...buildHubHeaders(latest.access_token),
        },
        body: JSON.stringify(postBody),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`推送到 Cloudflare 失败 (HTTP ${res.status}): ${errText.slice(0, 160)}`);
    }
    const respJson = await res.json().catch(() => ({}));
    if (respJson?.data?.daily_projects) {
        saveCloudHubSettings({ daily_projects: respJson.data.daily_projects });
    }
    return {
        ok: true,
        status: 'success',
        local_only: false,
        settings: loadCloudHubSettings(),
        message: '已成功同步到 Cloudflare 云端中控台',
    };
}

/**
 * Recursively indexes media files by lowercase basename inside localMaterialRoot (up to maxDepth = 4)
 * for automatic cross-machine path relinking when loading a Google Drive project.
 */
function buildLocalMaterialIndex(rootDir, maxDepth = 4) {
    const fileMap = new Map();
    if (!rootDir || typeof rootDir !== 'string' || !fs.existsSync(rootDir)) return fileMap;

    const walk = (dir, depth) => {
        if (depth > maxDepth) return;
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            return;
        }
        for (const entry of entries) {
            if (!entry || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full, depth + 1);
            } else if (entry.isFile()) {
                const key = entry.name.toLowerCase();
                if (!fileMap.has(key)) {
                    fileMap.set(key, full);
                }
            }
        }
    };
    walk(rootDir, 0);
    return fileMap;
}

function relinkProjectMediaPaths(projectData, localMaterialRoot) {
    const stats = { relinkedCount: 0, missingCount: 0, checkedCount: 0, fixed: 0, missing: 0 };
    if (!projectData || typeof projectData !== 'object') return stats;

    const fileMap = buildLocalMaterialIndex(localMaterialRoot, 4);
    const resolvePathIfMissing = (origPath) => {
        if (!origPath || typeof origPath !== 'string') return origPath;
        if (/^(data|blob|https?):/i.test(origPath)) return origPath;
        stats.checkedCount++;
        if (fs.existsSync(origPath)) return origPath;
        const base = path.basename(origPath.replace(/\\/g, '/')).toLowerCase();
        if (base && fileMap.has(base)) {
            stats.relinkedCount++;
            stats.fixed++;
            return fileMap.get(base);
        }
        stats.missingCount++;
        stats.missing++;
        return origPath;
    };

    const tabs = Array.isArray(projectData.tabs)
        ? projectData.tabs
        : (Array.isArray(projectData.tasks) ? [{ id: 'tab_1', name: '云端工程', tasks: projectData.tasks }] : []);

    for (const tab of tabs) {
        if (tab.materialDir && !fs.existsSync(tab.materialDir) && localMaterialRoot && fs.existsSync(localMaterialRoot)) {
            tab.materialDir = localMaterialRoot;
        }
        for (const task of (tab.tasks || [])) {
            if (!task || typeof task !== 'object') continue;
            for (const field of ['bgPath', 'videoPath', 'audioPath', 'voicePath', 'srtPath', 'txtPath', 'pipPath', 'hookFile', 'contentVideoPath', 'bgmPath']) {
                if (task[field]) task[field] = resolvePathIfMissing(task[field]);
            }
            if (task.cover && task.cover.bgPath) {
                task.cover.bgPath = resolvePathIfMissing(task.cover.bgPath);
            }
            if (Array.isArray(task.bgPaths)) {
                task.bgPaths = task.bgPaths.map(p => resolvePathIfMissing(p));
            }
            if (Array.isArray(task.bgClipPool)) {
                task.bgClipPool = task.bgClipPool.map(p => resolvePathIfMissing(p));
            }
            if (Array.isArray(task.bgmClipPool)) {
                task.bgmClipPool = task.bgmClipPool.map(p => resolvePathIfMissing(p));
            }
            if (Array.isArray(task.overlays)) {
                for (const ov of task.overlays) {
                    if (!ov || typeof ov !== 'object') continue;
                    if ((ov.type === 'image' || ov.type === 'video') && ov.content) {
                        ov.content = resolvePathIfMissing(ov.content);
                    }
                    if (ov.is_phone_cta && ov.cta_image_src) {
                        ov.cta_image_src = resolvePathIfMissing(ov.cta_image_src);
                    }
                }
            }
        }
    }
    return stats;
}

/**
 * Downloads a VideoKit project JSON from Google Drive (or any URL),
 * validates it, and optionally relinks media paths using local_material_root.
 */
async function downloadCloudProject(input = {}) {
    const rawUrl = String(input.url || '').trim();
    if (!rawUrl) throw new Error('请提供云端工程链接（支持 Google Drive 分享链接或直链）');

    const currentSettings = loadCloudHubSettings();
    const localMaterialRoot = String(input.local_material_root ?? currentSettings.local_material_root ?? '').trim();

    const text = await fetchTextWithDriveBypass(rawUrl, buildHubHeaders(currentSettings.access_token));
    let projectData;
    try {
        projectData = JSON.parse(text);
    } catch (_) {
        throw new Error('下载的文件不是有效的工程 JSON（请确认 Google Drive 文件权限已设为“知道链接的任何人可读”）');
    }

    // Normalize single-tab or legacy task list format into v2.0 multi-tab project format
    if (!Array.isArray(projectData.tabs)) {
        if (Array.isArray(projectData.tasks)) {
            projectData = {
                version: '2.0',
                timestamp: new Date().toISOString(),
                tabs: [{
                    id: 'tab_cloud_' + Date.now().toString(36),
                    name: input.title || projectData.name || '云端工程',
                    materialDir: localMaterialRoot || '',
                    tasks: projectData.tasks,
                }],
            };
        } else {
            throw new Error('工程 JSON 缺少 tabs 或 tasks 列表');
        }
    }

    const relinkStats = relinkProjectMediaPaths(projectData, localMaterialRoot);
    const totalTasks = (projectData.tabs || []).reduce((sum, t) => sum + ((t && Array.isArray(t.tasks)) ? t.tasks.length : 0), 0);

    let savedPath = '';
    if (input.save_dir && typeof input.save_dir === 'string' && fs.existsSync(input.save_dir)) {
        try {
            const safeLabel = [input.date, input.title || '云端工程'].filter(Boolean).join('_').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || '云端工程';
            savedPath = path.join(input.save_dir, `${safeLabel}.json`);
            settings.writeJSON(savedPath, projectData);
        } catch (_) {
            savedPath = '';
        }
    }

    return {
        ok: true,
        status: 'success',
        project: projectData,
        projectData,
        saved_path: savedPath,
        tabs_count: projectData.tabs.length,
        tasks_count: totalTasks,
        tabCount: projectData.tabs.length,
        taskCount: totalTasks,
        relink_stats: relinkStats,
        relinkStats,
    };
}

function getWorkerTemplateCode() {
    try {
        const workerPath = path.join(__dirname, '..', '..', 'scripts', 'cloudflare-hub-worker.js');
        if (fs.existsSync(workerPath)) {
            return fs.readFileSync(workerPath, 'utf-8');
        }
    } catch (_) {}
    return '';
}

module.exports = {
    loadCloudHubSettings,
    saveCloudHubSettings,
    extractGoogleDriveFileId,
    resolveCloudDownloadUrl,
    syncFromCloudHub,
    pushToCloudHub,
    downloadCloudProject,
    relinkProjectMediaPaths,
    getWorkerTemplateCode,
};
