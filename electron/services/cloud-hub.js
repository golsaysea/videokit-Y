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
                    material_folder_hint: String(item.material_folder_hint || '').trim(),
                    updated_at: item.updated_at || null,
                });
            }
        }
    } else if (rawProjects && typeof rawProjects === 'object') {
        const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
        for (const [dateKey, val] of Object.entries(rawProjects)) {
            if (UNSAFE_KEYS.has(dateKey)) continue;
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
        single_google_drive_url: String(raw.single_google_drive_url || '').trim(),
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
    const singleGoogleDriveUrl = input.single_google_drive_url !== undefined
        ? String(input.single_google_drive_url || '').trim()
        : current.single_google_drive_url;
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
        single_google_drive_url: singleGoogleDriveUrl,
        last_sync_at: input.last_sync_at !== undefined ? input.last_sync_at : current.last_sync_at,
        last_sync_summary: input.last_sync_summary !== undefined ? input.last_sync_summary : current.last_sync_summary,
        daily_projects: dailyProjects,
    };
    settings.writeJSON(getCloudHubSettingsPath(), toSave);
    return loadCloudHubSettings();
}

function decodeHtmlEntities(str) {
    return String(str || '')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&#x27;/gi, "'");
}

function extractDateFromText(primaryText = '', fallbackDateText = '') {
    const src = String(primaryText || '');
    let m = src.match(/\b(20\d{2})[-_.](\d{1,2})[-_.](\d{1,2})\b/);
    if (m) {
        return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    }
    m = src.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
    if (m) {
        return `${m[1]}-${m[2]}-${m[3]}`;
    }
    const curYear = new Date().getFullYear();
    m = src.match(/(?:^|[^\d])(\d{1,2})[-_.月](\d{1,2})日?(?:[^\d]|$)/);
    if (m) {
        const mon = parseInt(m[1], 10);
        const day = parseInt(m[2], 10);
        if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
            return `${curYear}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
    }
    if (fallbackDateText) {
        const parsed = Date.parse(fallbackDateText);
        if (Number.isFinite(parsed)) {
            return new Date(parsed).toISOString().slice(0, 10);
        }
    }
    return new Date().toISOString().slice(0, 10);
}

/**
 * Extracts Google Drive folder ID from folder share URLs:
 * - https://drive.google.com/drive/folders/FOLDER_ID?usp=sharing
 * - https://drive.google.com/drive/u/0/folders/FOLDER_ID
 * - https://drive.google.com/embeddedfolderview?id=FOLDER_ID#list
 */
function extractGoogleDriveFolderId(rawUrl) {
    const str = String(rawUrl || '').trim();
    if (!str) return null;
    const mFolder = str.match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?)?folders\/([a-zA-Z0-9_-]{10,})/i);
    if (mFolder) return mFolder[1];
    try {
        const u = new URL(str);
        if (/(^|\.)drive\.google\.com$/i.test(u.hostname) && /embeddedfolderview/i.test(u.pathname)) {
            const idParam = u.searchParams.get('id');
            if (idParam && /^[a-zA-Z0-9_-]{10,}$/.test(idParam)) return idParam;
        }
    } catch (_) {}
    return null;
}

/**
 * Extracts Google Docs ID from docs.google.com/document/d/DOC_ID/...
 */
function extractGoogleDocId(rawUrl) {
    const str = String(rawUrl || '').trim();
    if (!str) return null;
    const mDoc = str.match(/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{10,})/i);
    return mDoc ? mDoc[1] : null;
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
    if (!str || extractGoogleDriveFolderId(str)) return null;
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
 * Resolves share links (Google Drive file, Google Doc txt export, Dropbox, GitHub blob) into direct download URLs.
 */
function resolveCloudDownloadUrl(rawUrl) {
    const clean = String(rawUrl || '').trim();
    if (!clean) return '';
    const docId = extractGoogleDocId(clean);
    if (docId) {
        return `https://docs.google.com/document/d/${encodeURIComponent(docId)}/export?format=txt`;
    }
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

function isGoogleDriveAccessDeniedHtml(html) {
    const text = String(html || '');
    return /accounts\.google\.com\/ServiceLogin|accounts\.google\.com\/v3\/signin|<title>\s*Sign in\s*[-–|]?/i.test(text);
}

/**
 * Parses Google Drive embeddedfolderview HTML into files and subfolders without requiring OAuth/API keys.
 */
function parseGoogleDriveEmbeddedFolderHtml(html) {
    const src = String(html || '');
    if (isGoogleDriveAccessDeniedHtml(src)) {
        throw new Error('Google Drive 文件夹未公开访问权限，请在网盘将其共享设为「知道链接的任何人可查看」');
    }

    const files = [];
    const folders = [];
    const seenIds = new Set();

    const pushEntry = (hrefRaw, titleRaw, modifiedRaw = '', entryIdAttr = '') => {
        const href = decodeHtmlEntities(hrefRaw).trim();
        const title = decodeHtmlEntities(String(titleRaw || '').replace(/<[^>]+>/g, '')).trim();
        const lastModified = decodeHtmlEntities(String(modifiedRaw || '').replace(/<[^>]+>/g, '')).trim();
        if (!href && !entryIdAttr) return;

        const folderId = extractGoogleDriveFolderId(href);
        if (folderId) {
            if (seenIds.has('folder:' + folderId)) return;
            seenIds.add('folder:' + folderId);
            folders.push({
                id: folderId,
                name: title || folderId,
                url: `https://drive.google.com/drive/folders/${folderId}`,
                lastModified,
            });
            return;
        }

        const docId = extractGoogleDocId(href);
        const fileId = docId || extractGoogleDriveFileId(href) || (/^[a-zA-Z0-9_-]{10,}$/.test(entryIdAttr) ? entryIdAttr : '');
        if (!fileId) return;
        if (seenIds.has('file:' + fileId)) return;
        seenIds.add('file:' + fileId);

        const viewUrl = docId
            ? `https://docs.google.com/document/d/${docId}/edit`
            : `https://drive.google.com/file/d/${fileId}/view`;
        files.push({
            id: fileId,
            name: title || fileId,
            url: viewUrl,
            lastModified,
            isGoogleDoc: Boolean(docId),
        });
    };

    const chunks = src.split(/<div[^>]+class="(?:[^"]*\s)?flip-entry(?=[\s"])[^"]*"/i);
    for (let i = 1; i < chunks.length; i++) {
        const block = chunks[i];
        const idMatch = block.match(/^\s*[^>]*\bid="entry-([a-zA-Z0-9_-]{10,})"/i);
        const hrefMatch = block.match(/<a[^>]+href="([^"]+)"/i);
        const titleMatch = block.match(/<div[^>]+class="[^"]*flip-entry-title[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        const modMatch = block.match(/<div[^>]+class="[^"]*flip-entry-last-modified[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        pushEntry(hrefMatch ? hrefMatch[1] : '', titleMatch ? titleMatch[1] : '', modMatch ? modMatch[1] : '', idMatch ? idMatch[1] : '');
    }

    if (files.length === 0 && folders.length === 0) {
        const anchorRe = /<a[^>]+href="(https?:\/\/(?:drive|docs)\.google\.com\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = anchorRe.exec(src)) !== null) {
            pushEntry(match[1], match[2], '', '');
        }
    }

    return { files, folders };
}

const IGNORED_CLOUD_JSON_FILES = new Set([
    '工程清单.json',
    'manifest.json',
    'package.json',
    'package-lock.json',
    'cloud_hub_settings.json',
    'tsconfig.json',
]);

function isEditableProjectFilename(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    if (IGNORED_CLOUD_JSON_FILES.has(trimmed.toLowerCase())) return false;
    return /\.(?:reels-project\.)?json$/i.test(trimmed);
}

function cleanProjectTitleFromFilename(name) {
    return String(name || '').trim()
        .replace(/\.reels-project\.json$/i, '')
        .replace(/\.json$/i, '')
        .trim() || '云端工程';
}

async function fetchGoogleDriveFolderProjects(folderUrl, options = {}) {
    const rootFolderId = extractGoogleDriveFolderId(folderUrl);
    if (!rootFolderId) return [];

    const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 1;
    const maxSubfolders = Number.isFinite(options.maxSubfolders) ? options.maxSubfolders : 8;
    const visited = new Set();
    const collected = [];

    const walkFolder = async (folderId, folderLabel, depth) => {
        if (!folderId || visited.has(folderId)) return;
        visited.add(folderId);

        const embedUrl = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`;
        const res = await fetch(embedUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VideoKit/4.6.0',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            redirect: 'follow',
        });
        if (!res.ok) {
            throw new Error(`读取 Google Drive 文件夹失败 (HTTP ${res.status})`);
        }
        const html = await res.text();
        const { files, folders } = parseGoogleDriveEmbeddedFolderHtml(html);

        for (const file of files) {
            if (!isEditableProjectFilename(file.name)) continue;
            const date = extractDateFromText(`${folderLabel} ${file.name}`, file.lastModified);
            const cleanTitle = cleanProjectTitleFromFilename(file.name);
            collected.push({
                id: 'dp_gd_' + file.id.slice(0, 12),
                date,
                title: folderLabel ? `${cleanTitle} (${folderLabel})` : cleanTitle,
                url: file.url,
                drive_url: file.url,
                note: folderLabel ? `来自谷歌文件夹「${folderLabel}」` : '来自谷歌共享文件夹（可直接下载编辑）',
                material_folder_hint: folderLabel || cleanTitle,
            });
        }

        if (depth < maxDepth && folders.length > 0) {
            for (const sub of folders.slice(0, maxSubfolders)) {
                try {
                    await walkFolder(sub.id, sub.name || '', depth + 1);
                } catch (_) {
                    // 子文件夹读取失败时不中断其他工程收集
                }
            }
        }
    };

    await walkFolder(rootFolderId, '', 0);
    return normalizeDailyProjects(collected);
}

async function fetchGoogleDocProjects(docUrl) {
    const rawText = await fetchTextWithDriveBypass(docUrl);
    const trimmed = String(rawText || '').replace(/^\uFEFF/, '').trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed.tabs) || Array.isArray(parsed.tasks)) {
                return [{
                    id: 'dp_gdoc_' + (extractGoogleDocId(docUrl) || 'doc').slice(0, 10),
                    date: new Date().toISOString().slice(0, 10),
                    title: parsed.name || 'Google 文档可编辑工程',
                    url: docUrl,
                    note: '直接来自 Google 文档中的工程 JSON',
                }];
            }
        } catch (_) {}
    }

    const lines = trimmed.split(/\r?\n/);
    const entries = [];
    for (const line of lines) {
        const urlMatch = line.match(/https?:\/\/[^\s"'<>]+/i);
        if (!urlMatch) continue;
        const foundUrl = urlMatch[0].replace(/[),.;]+$/, '');
        let parsedFoundUrl;
        try {
            parsedFoundUrl = _assertSafeHttpUrl(foundUrl, { allowPrivateHttp: false, label: 'Google 文档清单链接' });
        } catch (_) {
            continue;
        }
        const host = String(parsedFoundUrl.hostname || '').toLowerCase();
        const isGoogleHost = /(^|\.)(drive|docs)\.google\.com$/.test(host);
        const isJsonPath = /\.json$/i.test(String(parsedFoundUrl.pathname || ''));
        if (!isGoogleHost && !isJsonPath) continue;
        const prefixText = line.slice(0, urlMatch.index).replace(/[:：\-—|]+$/, '').trim();
        const date = extractDateFromText(prefixText || foundUrl);
        if (extractGoogleDriveFolderId(foundUrl)) {
            const folderEntries = await fetchGoogleDriveFolderProjects(foundUrl, { maxDepth: 1 });
            entries.push(...folderEntries);
        } else {
            entries.push({
                id: 'dp_doclink_' + Buffer.from(foundUrl).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10),
                date,
                title: prefixText || `${date} 云端工程`,
                url: foundUrl,
                note: '来自 Google 文档链接清单',
            });
        }
    }
    return normalizeDailyProjects(entries);
}

async function resolveProjectsFromGoogleUrl(rawUrl, fallbackTitle = '云端可编辑工程') {
    const clean = String(rawUrl || '').trim();
    if (!clean) return [];
    if (extractGoogleDriveFolderId(clean)) {
        return await fetchGoogleDriveFolderProjects(clean, { maxDepth: 1 });
    }
    if (extractGoogleDocId(clean)) {
        return await fetchGoogleDocProjects(clean);
    }
    return normalizeDailyProjects([{
        id: 'dp_single_' + Buffer.from(clean).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10),
        date: extractDateFromText(clean),
        title: fallbackTitle,
        url: clean,
        note: '来自 Cloudflare 单链可编辑工程',
    }]);
}

function _assertSafeHttpUrl(rawUrl, { allowPrivateHttp = false, requireHttpsGoogle = false, label = '远程链接' } = {}) {
    const clean = String(rawUrl || '').trim();
    if (!clean) throw new Error(`${label}为空`);
    let u;
    try {
        u = new URL(clean);
    } catch (_) {
        throw new Error(`${label}格式无效`);
    }
    const proto = String(u.protocol || '').toLowerCase();
    if (u.username || u.password) {
        throw new Error(`${label}不允许包含认证凭据`);
    }
    if (requireHttpsGoogle) {
        const host = String(u.hostname || '').toLowerCase();
        if (proto !== 'https:' || !/(^|\.)((drive|docs|usercontent)\.google\.com|googleusercontent\.com)$/.test(host)) {
            throw new Error(`${label}必须是受信任的 Google HTTPS 域名`);
        }
        return u;
    }
    if (proto !== 'https:' && proto !== 'http:') {
        throw new Error(`${label}仅支持 http/https 协议`);
    }
    if (!allowPrivateHttp) {
        const host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
        if (!host || host === 'localhost' || host.endsWith('.local') || host === '::1' || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /^(fc|fd|fe80:)/i.test(host)) {
            throw new Error(`${label}不允许指向内网或本机地址`);
        }
    }
    return u;
}

function buildHubRequestUrl(hubUrl, token = '') {
    const u = _assertSafeHttpUrl(hubUrl, { allowPrivateHttp: true, label: 'Cloudflare 总链接 URL' });
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
        'User-Agent': 'VideoKit-CloudHub/4.6.0',
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
    _assertSafeHttpUrl(directUrl, { allowPrivateHttp: true, label: '远程下载链接' });
    const gdriveId = extractGoogleDriveFileId(rawUrl);

    const res = await fetch(directUrl, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VideoKit/4.6.0',
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
        const u2 = _assertSafeHttpUrl(actionUrl, { requireHttpsGoogle: true, label: 'Google Drive 确认链接' });
        u2.searchParams.set('id', gdriveId);
        u2.searchParams.set('export', 'download');
        u2.searchParams.set('confirm', confirmMatch ? confirmMatch[1] : 't');
        if (uuidMatch) u2.searchParams.set('uuid', uuidMatch[1]);

        const res2 = await fetch(u2.toString(), {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VideoKit/4.6.0',
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

    // 4. Daily Projects ("日期贴") — 支持列表配置或单个 Google Drive 链接（文件夹 / 单工程 / Google 文档）
    const remoteProjectsRaw = payload.daily_projects ?? payload.projects ?? payload.dailyProjects;
    const singleGoogleUrl = String(
        payload.google_drive_url
        || payload.drive_url
        || payload.project_url
        || payload.projects_url
        || payload.gdrive_url
        || payload.folder_url
        || payload.google_url
        || ''
    ).trim();

    let nextDailyProjects = remoteProjectsRaw !== undefined
        ? normalizeDailyProjects(remoteProjectsRaw)
        : (singleGoogleUrl ? [] : saved.daily_projects);
    let folderWarning = '';

    // 展开列表中本身就是 Google Drive 文件夹 / Google 文档的条目
    const expandedProjects = [];
    for (const item of nextDailyProjects) {
        if (extractGoogleDriveFolderId(item.url) || extractGoogleDocId(item.url)) {
            try {
                const sub = await resolveProjectsFromGoogleUrl(item.url, item.title);
                expandedProjects.push(...sub);
            } catch (err) {
                folderWarning = folderWarning || (err?.message || String(err));
                expandedProjects.push(item);
            }
        } else {
            expandedProjects.push(item);
        }
    }

    if (singleGoogleUrl) {
        if (/这里替换成你的|your[_-]?google/i.test(singleGoogleUrl)) {
            folderWarning = 'Worker 中 google_drive_url 还是示例占位符，请替换成真实的 Google Drive 共享链接';
        } else {
            try {
                const resolvedSingle = await resolveProjectsFromGoogleUrl(
                    singleGoogleUrl,
                    String(payload.project_title || payload.title || '云端可编辑工程').trim()
                );
                expandedProjects.push(...resolvedSingle);
                if (resolvedSingle.length === 0 && extractGoogleDriveFolderId(singleGoogleUrl)) {
                    folderWarning = '已在云盘打开该谷歌文件夹，但暂未发现 .json / .reels-project.json 工程文件';
                }
            } catch (err) {
                folderWarning = folderWarning || (err?.message || String(err));
            }
        }
    }

    if (remoteProjectsRaw !== undefined || singleGoogleUrl) {
        const dedupByUrl = new Map();
        for (const p of expandedProjects) {
            if (!p?.url) continue;
            const driveFileId = extractGoogleDriveFileId(p.url);
            const driveFolderId = extractGoogleDriveFolderId(p.url);
            const dedupKey = driveFileId
                ? `gdrive-file:${driveFileId}`
                : driveFolderId
                    ? `gdrive-folder:${driveFolderId}`
                    : p.url;
            if (!dedupByUrl.has(dedupKey)) {
                dedupByUrl.set(dedupKey, p);
            }
        }
        nextDailyProjects = normalizeDailyProjects([...dedupByUrl.values()]);
    }

    const summary = {
        mode,
        primary_transcription: nextPrimary,
        groq: nextGroq.length,
        gladia: nextGladia.length,
        deepgram: nextDeepgram.length,
        gemini: nextGemini.length,
        elevenlabs: nextEl.length,
        daily_projects: nextDailyProjects.length,
        single_google_drive_url: singleGoogleUrl,
        folder_warning: folderWarning,
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
        single_google_drive_url: singleGoogleUrl,
        daily_projects: nextDailyProjects,
    });

    return {
        ok: true,
        status: 'success',
        stats: summary.counts,
        summary,
        folder_warning: folderWarning,
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
 * Recursively indexes media files by normalized path suffixes and lowercase basename inside
 * localMaterialRoot (up to maxDepth = 4) for automatic cross-machine path relinking.
 */
function buildLocalMaterialIndex(rootDir, maxDepth = 4) {
    const byBasename = new Map();
    const bySuffix = new Map();
    if (!rootDir || typeof rootDir !== 'string' || !fs.existsSync(rootDir)) {
        return { byBasename, bySuffix };
    }

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
                if (!byBasename.has(key)) {
                    byBasename.set(key, full);
                }
                const parts = full.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
                for (const depthCount of [2, 3]) {
                    if (parts.length >= depthCount) {
                        const suffix = parts.slice(-depthCount).join('/');
                        if (!bySuffix.has(suffix)) {
                            bySuffix.set(suffix, full);
                        }
                    }
                }
            }
        }
    };
    walk(rootDir, 0);
    return { byBasename, bySuffix };
}

function relinkProjectMediaPaths(projectData, localMaterialRoot) {
    const stats = { relinkedCount: 0, missingCount: 0, checkedCount: 0, fixed: 0, missing: 0 };
    if (!projectData || typeof projectData !== 'object') return stats;

    // Packaged batches with group subfolders have depth up to 5 (<root>/<group>/<task>-工程/<role>/<file>).
    const index = buildLocalMaterialIndex(localMaterialRoot, 5);
    const unwrapLocalUrl = (raw) => {
        const str = String(raw || '');
        if (/^local-media:\/\//i.test(str)) {
            let p = str.slice('local-media://'.length).split('?')[0].split('#')[0];
            if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
            try { p = decodeURIComponent(p); } catch (_) {}
            return { prefix: 'local-media://', rawPath: p };
        }
        return { prefix: '', rawPath: str };
    };
    const lookupIndex = (rawPath) => {
        const parts = rawPath.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
        for (const depthCount of [3, 2]) {
            if (parts.length >= depthCount) {
                const suffix = parts.slice(-depthCount).join('/');
                if (index.bySuffix.has(suffix)) return index.bySuffix.get(suffix);
            }
        }
        const base = parts[parts.length - 1] || '';
        return (base && index.byBasename.has(base)) ? index.byBasename.get(base) : '';
    };
    const resolvePathIfMissing = (origPath) => {
        if (!origPath || typeof origPath !== 'string') return origPath;
        if (/^(data|blob|https?):/i.test(origPath)) return origPath;
        const { prefix, rawPath } = unwrapLocalUrl(origPath);
        if (!rawPath) return origPath;
        stats.checkedCount++;
        if (fs.existsSync(rawPath)) return origPath;
        const matched = lookupIndex(rawPath);
        if (matched) {
            stats.relinkedCount++;
            stats.fixed++;
            if (!prefix) return matched;
            const norm = matched.replace(/\\/g, '/');
            return norm.startsWith('/') ? `${prefix}${norm}` : `${prefix}/${norm}`;
        }
        stats.missingCount++;
        stats.missing++;
        return origPath;
    };
    const relinkPipeKey = (keyStr) => {
        if (!keyStr || typeof keyStr !== 'string' || keyStr === '[]') return keyStr;
        return keyStr.split(';').map((seg) => {
            const pipeIdx = seg.indexOf('|');
            if (pipeIdx <= 0) return seg;
            const segPath = seg.slice(0, pipeIdx);
            if (!/[\\/]/.test(segPath)) return seg;
            return `${resolvePathIfMissing(segPath)}${seg.slice(pipeIdx)}`;
        }).join(';');
    };
    const relinkWatermarks = (wms) => {
        if (!Array.isArray(wms)) return;
        for (const wm of wms) {
            if (wm && typeof wm === 'object' && wm.imagePath) {
                wm.imagePath = resolvePathIfMissing(wm.imagePath);
            }
        }
    };

    relinkWatermarks(projectData.watermarks);

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
            for (const arrField of ['bgPaths', 'bgClipPool', 'bgmClipPool']) {
                if (Array.isArray(task[arrField])) {
                    task[arrField] = task[arrField].map(p => resolvePathIfMissing(p));
                }
            }
            if (Array.isArray(task.insertClips)) {
                task.insertClips = task.insertClips.map((clip) => {
                    if (typeof clip === 'string') return resolvePathIfMissing(clip);
                    if (clip && typeof clip === 'object') {
                        for (const k of ['path', 'filePath', 'src', 'url']) {
                            if (typeof clip[k] === 'string' && clip[k]) clip[k] = resolvePathIfMissing(clip[k]);
                        }
                    }
                    return clip;
                });
            }
            if (task.introMedia) {
                if (typeof task.introMedia === 'string') {
                    task.introMedia = resolvePathIfMissing(task.introMedia);
                } else if (typeof task.introMedia === 'object') {
                    for (const k of ['path', 'filePath', 'bgPath', 'url']) {
                        if (typeof task.introMedia[k] === 'string' && task.introMedia[k]) {
                            task.introMedia[k] = resolvePathIfMissing(task.introMedia[k]);
                        }
                    }
                }
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
            if (task.timeline && typeof task.timeline === 'object') {
                if (task.timeline.sources && typeof task.timeline.sources === 'object') {
                    for (const srcObj of Object.values(task.timeline.sources)) {
                        if (srcObj && typeof srcObj === 'object' && srcObj.path) {
                            srcObj.path = resolvePathIfMissing(srcObj.path);
                        }
                    }
                }
                if (task.timeline.backgroundSegmentKey) {
                    task.timeline.backgroundSegmentKey = relinkPipeKey(task.timeline.backgroundSegmentKey);
                }
                if (task.timeline.insertClipKey) {
                    task.timeline.insertClipKey = relinkPipeKey(task.timeline.insertClipKey);
                }
            }
            relinkWatermarks(task.watermarks);
        }
    }
    return stats;
}

/**
 * Splits a flat task list (e.g. packaged batch or legacy project JSON) into tabs
 * when tasks carry `_batchTabId`/`_batchTabName` or `_folderQueueId`/`_folderQueueName`.
 */
function splitFlatTasksIntoTabs(rawTasks, options = {}) {
    const fallbackName = String(options.fallbackName || '云端工程').trim() || '云端工程';
    const materialDir = String(options.materialDir || '');
    const topStyle = (options.topStyle && typeof options.topStyle === 'object') ? options.topStyle : null;
    const baseStamp = Date.now().toString(36);

    const groups = new Map();
    for (const raw of (Array.isArray(rawTasks) ? rawTasks : [])) {
        if (!raw || typeof raw !== 'object') continue;
        const task = (topStyle && !raw.subtitleStyle && !raw.style)
            ? {
                ...raw,
                style: JSON.parse(JSON.stringify(topStyle)),
                subtitleStyle: JSON.parse(JSON.stringify(topStyle)),
            }
            : raw;

        const batchTabId = String(task._batchTabId || '').trim();
        const batchTabName = String(task._batchTabName || '').trim();
        const batchTabGroup = String(task._batchTabGroup || '').trim();
        const queueId = String(task._folderQueueId || '').trim();
        const queueName = String(task._folderQueueName || '').trim();

        let groupKey = '__default__';
        let tabName = fallbackName;
        let folderQueueId = '';
        if (batchTabId || batchTabName) {
            groupKey = batchTabId ? `tab:${batchTabId}` : `tabname:${batchTabName}`;
            tabName = batchTabName || fallbackName;
            folderQueueId = queueId;
        } else if (queueId || queueName) {
            groupKey = queueId ? `queue:${queueId}` : `queuename:${queueName}`;
            tabName = queueName || fallbackName;
            folderQueueId = queueId;
        }

        if (!groups.has(groupKey)) {
            groups.set(groupKey, {
                name: tabName,
                group: batchTabGroup,
                folderQueueId,
                tasks: [],
            });
        }
        const entry = groups.get(groupKey);
        if (!entry.group && batchTabGroup) entry.group = batchTabGroup;
        entry.tasks.push(task);
    }

    const tabs = [];
    let idx = 1;
    for (const entry of groups.values()) {
        tabs.push({
            id: `tab_cloud_${baseStamp}_${idx++}`,
            name: entry.name,
            ...(entry.group ? { group: entry.group } : {}),
            materialDir,
            ...(entry.folderQueueId ? { folderQueueId: entry.folderQueueId } : {}),
            tasks: entry.tasks,
        });
    }
    if (!tabs.length) {
        tabs.push({
            id: `tab_cloud_${baseStamp}_1`,
            name: fallbackName,
            materialDir,
            tasks: [],
        });
    }
    return tabs;
}

/**
 * Downloads a VideoKit project JSON from Google Drive (file or folder), Google Doc, or any URL,
 * validates it, and optionally relinks media paths using local_material_root.
 */
async function downloadCloudProject(input = {}) {
    let targetUrl = String(input.url || '').trim();
    if (!targetUrl) throw new Error('请提供云端工程链接（支持 Google Drive 文件夹、工程文件或直链）');

    let resolvedTitle = input.title || '';
    let resolvedDate = input.date || '';

    if (extractGoogleDriveFolderId(targetUrl)) {
        const folderProjects = await fetchGoogleDriveFolderProjects(targetUrl);
        if (folderProjects.length === 0) {
            throw new Error('该 Google Drive 文件夹里暂无可编辑的 .json / .reels-project.json 工程文件（请确认已在网盘放入软件保存的工程文件）');
        }
        if (folderProjects.length > 1) {
            saveCloudHubSettings({ single_google_drive_url: targetUrl, daily_projects: folderProjects });
            return {
                ok: true,
                status: 'folder_listed',
                projects: folderProjects,
                message: `已从谷歌文件夹读取到 ${folderProjects.length} 个可编辑工程，请点击对应工程卡片加载`,
            };
        }
        targetUrl = folderProjects[0].url;
        resolvedTitle = resolvedTitle || folderProjects[0].title;
        resolvedDate = resolvedDate || folderProjects[0].date;
    } else if (extractGoogleDocId(targetUrl)) {
        const docProjects = await fetchGoogleDocProjects(targetUrl);
        if (docProjects.length === 0) {
            throw new Error('该 Google 文档中未识别到可编辑工程 JSON 或网盘工程链接');
        }
        if (docProjects.length > 1) {
            saveCloudHubSettings({ single_google_drive_url: targetUrl, daily_projects: docProjects });
            return {
                ok: true,
                status: 'folder_listed',
                projects: docProjects,
                message: `已从 Google 文档读取到 ${docProjects.length} 个可编辑工程，请点击对应工程卡片加载`,
            };
        }
        targetUrl = docProjects[0].url;
        resolvedTitle = resolvedTitle || docProjects[0].title;
        resolvedDate = resolvedDate || docProjects[0].date;
    }

    const currentSettings = loadCloudHubSettings();
    const localMaterialRoot = String(input.local_material_root ?? currentSettings.local_material_root ?? '').trim();

    const text = await fetchTextWithDriveBypass(targetUrl, buildHubHeaders(currentSettings.access_token));
    let projectData;
    try {
        projectData = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
    } catch (_) {
        throw new Error('下载的文件不是有效的工程 JSON（请确认 Google Drive 文件权限已设为“知道链接的任何人可查看”）');
    }

    // Normalize single-project (.reels-project.json) or flat packaged task list into v2.0 multi-tab format
    if (!Array.isArray(projectData.tabs)) {
        if (Array.isArray(projectData.tasks)) {
            const topStyle = (projectData.style && typeof projectData.style === 'object') ? projectData.style : null;
            const splitTabs = splitFlatTasksIntoTabs(projectData.tasks, {
                fallbackName: resolvedTitle || projectData.name || '云端工程',
                materialDir: localMaterialRoot || '',
                topStyle,
            });
            projectData = {
                version: '2.0',
                timestamp: new Date().toISOString(),
                ...(topStyle ? { style: topStyle } : {}),
                ...(projectData.exportOpts && typeof projectData.exportOpts === 'object' ? { exportOpts: projectData.exportOpts } : {}),
                ...(Array.isArray(projectData.watermarks) ? { watermarks: projectData.watermarks } : {}),
                ...(projectData.collapsedTabGroups && typeof projectData.collapsedTabGroups === 'object'
                    ? { collapsedTabGroups: projectData.collapsedTabGroups } : {}),
                activeTabId: splitTabs[0]?.id || '',
                tabs: splitTabs,
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
            const safeLabel = [resolvedDate, resolvedTitle || '云端工程'].filter(Boolean).join('_').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || '云端工程';
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

function getWorkerTemplateCode(variant = 'kv') {
    const fileName = variant === 'simple' ? 'cloudflare-hub-simple-worker.js' : 'cloudflare-hub-worker.js';
    try {
        const workerPath = path.join(__dirname, '..', '..', 'scripts', fileName);
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
    extractGoogleDriveFolderId,
    extractGoogleDocId,
    parseGoogleDriveEmbeddedFolderHtml,
    fetchGoogleDriveFolderProjects,
    fetchGoogleDocProjects,
    resolveCloudDownloadUrl,
    syncFromCloudHub,
    pushToCloudHub,
    downloadCloudProject,
    splitFlatTasksIntoTabs,
    relinkProjectMediaPaths,
    getWorkerTemplateCode,
};
