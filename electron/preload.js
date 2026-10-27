const { contextBridge, ipcRenderer, webUtils, webFrame, clipboard } = require('electron');

// 预设过去只在 Chromium localStorage 中保存；重打包后只要页面 origin 改变，
// 那套数据库就可能不可见。启动时同步从 userData/videokit-presets 恢复，随后
// 定期镜像回文件。只收集预设/模板相关键，绝不触碰 API Key 等设置。
const _persistentPresetKey = (key) => /(?:preset|template|watermark|brush)/i.test(String(key || ''));
const _persistentPresetOverrides = new Map();
let _workspaceLastHash='',_workspaceLastBackupAt=0;
const _readPersistentPresetValues = () => {
    const values = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && _persistentPresetKey(key)) values[key] = localStorage.getItem(key);
        }
    } catch (_) { }
    for (const [key, value] of _persistentPresetOverrides) values[key] = value;
    return values;
};
try {
    const response = ipcRenderer.sendSync('persistent-presets:hydrate', _readPersistentPresetValues());
    if (response?.ok) {
        for (const [key, value] of Object.entries(response.values || {})) {
            try { localStorage.setItem(key, value); } catch (error) {
                if (['reels_overlay_group_presets','reels_subtitle_presets'].includes(key)) _persistentPresetOverrides.set(key, value);
                console.warn('[Presets] Cache restore failed:', error.message);
            }
        }
    }
} catch (_) { /* The main process may not have registered during an abnormal early startup. */ }
let _persistentPresetLast = '';
const _savePersistentPresets = () => {
    const values = _readPersistentPresetValues();
    const serialised = JSON.stringify(values);
    if (serialised === _persistentPresetLast) return;
    ipcRenderer.invoke('persistent-presets:save', values).then(response => {
        if (response?.ok) _persistentPresetLast = serialised;
        else console.warn('[Presets] Disk save failed:', response?.error);
    }).catch(error => console.warn('[Presets] Disk save failed:', error.message));
};
setInterval(_savePersistentPresets, 2000);
window.addEventListener('beforeunload', _savePersistentPresets);

// File objects passed through contextBridge can lose the identity required by
// webUtils.getPathForFile().  Capture paths in the preload world while handling
// the original drop event, then let the renderer consume that one drop's paths.
// This is especially important for the batch Reels table, which must persist
// absolute paths instead of only file names.
let _lastDroppedFilePaths = [];
window.addEventListener('drop', (event) => {
    try {
        _lastDroppedFilePaths = Array.from(event.dataTransfer?.files || [])
            .map((file) => webUtils.getPathForFile(file))
            .filter(Boolean);
    } catch (error) {
        _lastDroppedFilePaths = [];
        console.warn('[preload] unable to capture dropped file paths:', error?.message);
    }
}, true);
const fs = require('fs');
const path = require('path');
const sharedProfile = require('./services/sharedProfile');
// Electron's renderer has no app.getPath(). Ask the trusted main process so a
// custom/test profile cannot fall back to ~/.videokit and overwrite a workspace.
let _runtimeProfilePaths = null;
try { const result = ipcRenderer.sendSync('profile:runtime-paths'); if (result?.ok) _runtimeProfilePaths = result; } catch (_) {}

// Rebase profile-owned paths when moving this personal portable copy,
// without breaking valid paths that point to an existing installed profile.
try {
    const portableRoot = path.dirname(process.execPath);
    if (fs.existsSync(path.join(portableRoot, 'portable.flag'))) {
        const profile = path.join(portableRoot, 'portable-data');
        const marker = path.join(profile, 'portable-location.json');
        const previous = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')).root : '';
        const installedUserData = sharedProfile.getPrimarySharedProfileDir() || path.join(process.env.APPDATA || '', 'videokit');
        const unifiedProjectsDir = path.join(installedUserData, 'projects');
        try { fs.mkdirSync(unifiedProjectsDir, { recursive: true }); } catch (_) {}
        const installedResources = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'videokit', 'resources');
        const replacements = [
            ...(!fs.existsSync(installedUserData) ? [[installedUserData, profile]] : []),
            ...(!fs.existsSync(installedResources) ? [[installedResources, path.join(portableRoot, 'resources')]] : []),
            ...(previous && previous !== portableRoot && !fs.existsSync(previous) ? [[previous, portableRoot]] : []),
        ];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const oldValue = localStorage.getItem(key);
            let value = oldValue;
            for (const [from, to] of replacements) {
                for (const [a, b] of [[JSON.stringify(from).slice(1,-1), JSON.stringify(to).slice(1,-1)], [from, to], [from.replaceAll('\\','/'), to.replaceAll('\\','/')]]) {
                    if (a && a !== b) value = value.split(a).join(b);
                }
            }
            if (key === 'reels_batch_config_autosave') {
                const data = JSON.parse(value);
                if (!data.projectDir || !fs.existsSync(data.projectDir) || String(data.projectDir).toLowerCase().includes('portable-data')) {
                    data.projectDir = unifiedProjectsDir;
                }
                value = JSON.stringify(data);
            }
            if (value !== oldValue) localStorage.setItem(key, value);
        }
        fs.mkdirSync(profile, { recursive: true });
        fs.writeFileSync(marker, JSON.stringify({root:portableRoot}), 'utf8');
    }
} catch (error) { console.error('[Portable] Profile migration failed:', error); }


// Consume an explicitly staged recovery once, before renderer autosave starts.
try {
    const pendingRecovery = path.join(__dirname, '..', '..', 'reels-recovery-pending.json');
    if (fs.existsSync(pendingRecovery) && location.pathname.endsWith('/dist/index.html')) {
        const recoveryRaw = fs.readFileSync(pendingRecovery, 'utf8');
        const recovery = JSON.parse(recoveryRaw);
        if (recovery.version !== '2.0' || !Array.isArray(recovery.tabs) || !recovery.tabs.length) throw new Error('Invalid recovery');
        const previous = localStorage.getItem('reels_batch_config_autosave');
        if (previous) fs.writeFileSync(pendingRecovery + '.previous.json', previous, 'utf8');
        localStorage.setItem('reels_batch_config_autosave', recoveryRaw);
        if (localStorage.getItem('reels_batch_config_autosave') !== recoveryRaw) throw new Error('Recovery verification failed');
        fs.renameSync(pendingRecovery, pendingRecovery + '.applied');
        console.log('[Recovery] Restored batch tabs:', recovery.tabs.length);
    }
} catch (error) { console.error('[Recovery] Failed:', error); }

const { pathToFileURL, fileURLToPath } = require('url');

function resolveAssetUrl(fileName) {
    if (!fileName) return '';

    const candidates = [];
    if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'assets', fileName));
    }
    candidates.push(path.join(__dirname, '..', 'assets', fileName));
    candidates.push(path.join(__dirname, '..', 'dist', 'assets', fileName));

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                return toFileUrl(p);
            }
        } catch { }
    }
    return '';
}

function toFileUrl(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    if (/^(https?|data|blob):/i.test(filePath)) return filePath;
    try {
        let nativePath = filePath;
        let suffix = '';
        const hashIdx = nativePath.indexOf('#');
        if (hashIdx !== -1) {
            let completePath = nativePath;
            if (/^(local-media|file):\/\//i.test(completePath)) {
                completePath = fileURLToPath(completePath.replace(/^local-media:/i, 'file:').replace(/#/g, '%23'));
            }
            if (fs.existsSync(completePath)) nativePath = completePath;
            else {
                suffix = nativePath.slice(hashIdx);
                nativePath = nativePath.slice(0, hashIdx);
            }
        }
        if (/^local-media:\/\//i.test(nativePath)) {
            nativePath = fileURLToPath(nativePath.replace(/^local-media:/i, 'file:'));
        } else if (/^file:\/\//i.test(nativePath)) {
            nativePath = fileURLToPath(nativePath);
        }
        nativePath = sharedProfile.resolveSharedProfileFilePath(nativePath);
        // Node 自带的 URL 转换会正确处理 Windows 盘符、UNC、中文、空格和 #/%。
        return pathToFileURL(nativePath).href.replace(/^file:/i, 'local-media:') + suffix;
    } catch (_) {
        return filePath;
    }
}

function localMediaUrlToPath(value) {
    if (!value || typeof value !== 'string') return value;
    try {
        if (/^local-media:\/\//i.test(value)) return fileURLToPath(value.replace(/^local-media:/i, 'file:'));
        if (/^file:\/\//i.test(value)) return fileURLToPath(value);
    } catch (_) { }
    return value;
}

function fileExists(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    let p = filePath.trim();
    if (!p || /^blob:|^data:|^https?:/i.test(p)) return true;
    p = localMediaUrlToPath(p);
    try {
        const resolved = sharedProfile.resolveSharedProfileFilePath(path.resolve(p));
        return fs.existsSync(resolved);
    } catch {
        return false;
    }
}

// 暴露 API 给渲染进程
const _autoSaveDir = _runtimeProfilePaths?.primary || sharedProfile.getPrimarySharedProfileDir() || path.join(require('os').homedir(), '.videokit');
const _autoSavePath = path.join(_autoSaveDir, 'autosave.json');
try { if (!fs.existsSync(_autoSaveDir)) fs.mkdirSync(_autoSaveDir, { recursive: true }); } catch (_) {}
const _getProfileDataDir = () => {
    return _runtimeProfilePaths?.primary || sharedProfile.getPrimarySharedProfileDir() || _autoSaveDir;
};
const _getAllProfileDataDirs = () => {
    const primary = _getProfileDataDir();
    const candidates = _runtimeProfilePaths?.candidates || sharedProfile.getCandidateProfileDirs();
    return [...new Set([primary, ...candidates].filter(Boolean))];
};
const _getDefaultProjectDir = () => {
    const dir = path.join(_getProfileDataDir(), 'projects');
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
};

const _reelsFramePipelineRequests = new Map();
const _reelsFramePipelines = new Map();
ipcRenderer.on('reels-frame-pipeline-ready', (event, data = {}) => {
    const pending = _reelsFramePipelineRequests.get(data.requestId);
    if (!pending) return;
    _reelsFramePipelineRequests.delete(data.requestId);
    clearTimeout(pending.timer);
    const port = event.ports && event.ports[0];
    if (data.ok && port) {
        const pipelineId = data.requestId;
        const pipeline = { port, pending: new Map() };
        port.onmessage = (portEvent) => {
            const ack = portEvent.data || {};
            if (ack.type !== 'ack') return;
            const waiter = pipeline.pending.get(ack.seq);
            if (!waiter) return;
            pipeline.pending.delete(ack.seq);
            if (ack.ok) waiter.resolve(ack);
            else waiter.reject(new Error(ack.error || '帧流水线写入失败'));
        };
        port.start && port.start();
        _reelsFramePipelines.set(pipelineId, pipeline);
        pending.resolve(pipelineId);
    } else pending.reject(new Error(data.error || '无法建立帧流水线'));
});

const safeOpenPath = async (targetPath) => {
    try {
        return await ipcRenderer.invoke('open-path', targetPath);
    } catch (err) {
        if (err?.message?.includes('No handler registered')) {
            return await ipcRenderer.invoke('show-item-in-folder', targetPath);
        }
        throw err;
    }
};

const safeOpenExternal = async (url) => {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) {
        return { success: false, error: 'Blocked non-HTTP(S) external URL' };
    }
    try {
        return await ipcRenderer.invoke('open-external', url.trim());
    } catch (err) {
        if (err?.message?.includes('No handler registered')) {
            return await ipcRenderer.invoke('open-external-url', url.trim());
        }
        throw err;
    }
};

const localFilesBridge = {
    pickFolder: async (options) => {
        try {
            return await ipcRenderer.invoke('local:pick-folder', options);
        } catch (err) {
            if (err?.message?.includes('No handler registered')) {
                console.warn('[Preload] Fallback: local:pick-folder not registered, calling select-directory');
                return options?.multi
                    ? await ipcRenderer.invoke('select-directories')
                    : await ipcRenderer.invoke('select-directory');
            }
            throw err;
        }
    },
    pickImage: async () => {
        try {
            return await ipcRenderer.invoke('local:pick-image');
        } catch (err) {
            if (err?.message?.includes('No handler registered')) {
                const files = await ipcRenderer.invoke('select-files', {
                    title: '选择分类预览图',
                    multiple: false,
                    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
                });
                return files?.[0] || null;
            }
            throw err;
        }
    },
    getSubfolders: (folderPath) => ipcRenderer.invoke('local:get-subfolders', folderPath),
    listDirectory: async (folderPath, options) => {
        try {
            return await ipcRenderer.invoke('local:list-directory', folderPath, options);
        } catch (err) {
            if (err?.message?.includes('No handler registered')) {
                console.warn('[Preload] Fallback: local:list-directory not registered, calling scan-directory');
                const files = await ipcRenderer.invoke('scan-directory', folderPath);
                return {
                    success: Boolean(files),
                    exists: Boolean(files),
                    items: (files || []).map(f => ({
                        name: f.name,
                        path: f.path,
                        isDirectory: Boolean(f.isDirectory),
                        size: f.size || 0,
                        modifiedTime: new Date(f.mtime || Date.now()).toISOString()
                    }))
                };
            }
            throw err;
        }
    },
    scanFolder: (folderPath, options) => ipcRenderer.invoke('local:scan-folder', folderPath, options),
    getFolderAvatarMedia: (folderPath) => ipcRenderer.invoke('local:get-folder-avatar-media', folderPath),
    getVideoThumbnail: (filePath, size) => ipcRenderer.invoke('local:video-thumbnail', filePath, size),
    getLocalThumbnail: (filePath) => ipcRenderer.invoke('local:thumbnail', filePath),
    flattenFolder: (folderPath) => ipcRenderer.invoke('local:flatten-folder', folderPath),
    copyToFolder: (filePath, targetDir, options) => ipcRenderer.invoke('local:copy-to-folder', filePath, targetDir, options),
    moveToFolder: (filePath, targetDir, options) => ipcRenderer.invoke('local:move-to-folder', filePath, targetDir, options),
    removeDuplicates: (filePaths) => ipcRenderer.invoke('local:remove-duplicates', filePaths),
    findDuplicates: (filePaths) => ipcRenderer.invoke('local:find-duplicates', filePaths),
    trashFiles: (filePaths) => ipcRenderer.invoke('local:trash-files', filePaths),
    copyToClipboard: (filePaths) => ipcRenderer.invoke('local:copy-to-clipboard', filePaths),
    createFolder: (parentDir, folderName) => ipcRenderer.invoke('local:create-folder', parentDir, folderName),
    moveFolderToFolder: (srcDir, targetDir, options) => ipcRenderer.invoke('local:move-folder-to-folder', srcDir, targetDir, options),
    copyFolderToFolder: (srcDir, targetDir, options) => ipcRenderer.invoke('local:copy-folder-to-folder', srcDir, targetDir, options),
    mergeMaterialFolders: (targetRoot, sources, options) => ipcRenderer.invoke('local:merge-material-folders', targetRoot, sources, options),
    exportPreset: (jsonStr) => ipcRenderer.invoke('local:export-preset', jsonStr),
    importPreset: () => ipcRenderer.invoke('local:import-preset'),
    importPresetsMulti: () => ipcRenderer.invoke('local:import-presets-multi'),
    exportWorkspaceConfig: (jsonStr) => ipcRenderer.invoke('local:export-workspace-config', jsonStr),
    importWorkspaceConfig: () => ipcRenderer.invoke('local:import-workspace-config'),
    watchFolders: (folders) => ipcRenderer.invoke('local:watch-folders', folders),
    validateFolders: (folders) => ipcRenderer.invoke('local:validate-folders', folders),
    onScanProgress: (callback) => {
        ipcRenderer.removeAllListeners('local:scan-progress');
        ipcRenderer.on('local:scan-progress', (_event, data) => callback?.(data));
    },
    onFolderRenamed: (callback) => {
        ipcRenderer.removeAllListeners('local:folder-renamed');
        ipcRenderer.on('local:folder-renamed', (_event, data) => callback?.(data));
    },
    onFolderMissing: (callback) => {
        ipcRenderer.removeAllListeners('local:folder-missing');
        ipcRenderer.on('local:folder-missing', (_event, data) => callback?.(data));
    }
};

function _getGlobalFontFavorites(){
    let seed=[];try{seed=JSON.parse(localStorage.getItem('fp_favorites') || '[]');}catch(_){}
    const response=ipcRenderer.sendSync('font-favorites:get',seed);
    if(response?.ok){try{localStorage.setItem('fp_favorites',JSON.stringify(response.favorites));}catch(_){}return response.favorites;}
    return Array.isArray(seed)?seed:[];
}
contextBridge.exposeInMainWorld('electronAPI', {
    importLocalFont:(fileName,bytes)=>ipcRenderer.invoke('import-local-font',{fileName,bytes}),
    getFontFavorites:()=>_getGlobalFontFavorites(),
    toggleFontFavorite:(family)=>{_getGlobalFontFavorites();const response=ipcRenderer.sendSync('font-favorites:toggle',family);if(!response?.ok)throw Error(response?.error || '字体收藏保存失败');try{localStorage.setItem('fp_favorites',JSON.stringify(response.favorites));}catch(_){}return response.favorites;},
    saveFontFavorites:(values)=>{const response=ipcRenderer.sendSync('font-favorites:set',values);if(!response?.ok)throw Error(response?.error || '字体收藏保存失败');try{localStorage.setItem('fp_favorites',JSON.stringify(response.favorites));}catch(_){}return response.favorites;},
    readReelsOutputDirectory: () => {
        for (const profile of _getAllProfileDataDirs()) {
            try {
                const file = path.join(profile, 'ui-preferences.json');
                const dir = JSON.parse(fs.readFileSync(file, 'utf8')).reelsOutputDir || '';
                if (dir) return dir;
            } catch (_) { }
        }
        return '';
    },
    saveReelsOutputDirectory: (dir) => {
        try {
            if (typeof dir !== 'string' || !dir.trim()) throw new Error('目录不能为空');
            const trimmed = dir.trim();
            for (const profile of _getAllProfileDataDirs()) {
                try {
                    fs.mkdirSync(profile, { recursive: true });
                    const file = path.join(profile, 'ui-preferences.json');
                    let values = {};
                    try { values = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { }
                    values.reelsOutputDir = trimmed;
                    const temp = file + '.' + process.pid + '.tmp';
                    fs.writeFileSync(temp, JSON.stringify(values), 'utf8');
                    fs.renameSync(temp, file);
                } catch (_) { }
            }
            return { ok: true };
        } catch (error) { return { ok: false, error: error.message }; }
    },
    readOverlayGroupPresets: () => _persistentPresetOverrides.get('reels_overlay_group_presets') ?? localStorage.getItem('reels_overlay_group_presets') ?? '{}',
    saveOverlayGroupPresets: (value) => {
        const response = ipcRenderer.sendSync('persistent-presets:set', 'reels_overlay_group_presets', value);
        if (response?.ok) {
            try {
                localStorage.setItem('reels_overlay_group_presets', value);
                _persistentPresetOverrides.delete('reels_overlay_group_presets');
            } catch (error) {
                _persistentPresetOverrides.set('reels_overlay_group_presets', value);
                console.warn('[Presets] Cache save failed:', error.message);
            }
        }
        return response;
    },
    readSubtitlePresets: () => _persistentPresetOverrides.get('reels_subtitle_presets') ?? localStorage.getItem('reels_subtitle_presets') ?? '{}',
    saveSubtitlePresets: (value) => {
        const response = ipcRenderer.sendSync('persistent-presets:set', 'reels_subtitle_presets', value);
        if (response?.ok) {
            try {
                localStorage.setItem('reels_subtitle_presets', value);
                _persistentPresetOverrides.delete('reels_subtitle_presets');
            } catch (error) {
                _persistentPresetOverrides.set('reels_subtitle_presets', value);
                console.warn('[Presets] Cache save failed:', error.message);
            }
        }
        return response;
    },
    // 平台信息
    platform: process.platform,
    autoSavePath: _autoSavePath,
    resolveAssetUrl,
    toFileUrl,
    fileExists,
    // 获取 File 对象的本地完整路径（contextIsolation 下 File.path 不可用）
    getFilePath: (file) => {
        try {
            const p = webUtils.getPathForFile(file);
            console.log('[preload.getFilePath] success:', p);
            return p;
        } catch (e) {
            console.error('[preload.getFilePath] FAILED:', e.message, 'file:', typeof file, file?.name);
            return '';
        }
    },
    consumeDroppedFilePaths: () => {
        const paths = _lastDroppedFilePaths;
        _lastDroppedFilePaths = [];
        return paths;
    },
    isDirectory: (filePath) => {
        try {
            return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
        } catch {
            return false;
        }
    },
    fsExists: (p) => {
        try { return fs.existsSync(p); } catch { return false; }
    },
    fsStat: (p) => {
        try {
            const s = fs.statSync(p);
            return {
                size: s.size,
                mtimeMs: s.mtimeMs,
                isDirectory: s.isDirectory(),
                isFile: s.isFile()
            };
        } catch {
            return null;
        }
    },
    fsReaddir: (p) => {
        try {
            return fs.readdirSync(p, { withFileTypes: true }).map(e => ({
                name: e.name,
                isDirectory: e.isDirectory(),
                isFile: e.isFile()
            }));
        } catch {
            return [];
        }
    },
    pathJoin: (...args) => path.join(...args),
    pathBasename: (p) => path.basename(p),
    pathDirname: (p) => path.dirname(p),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    exportOverlayPresetPackage: (presets) => ipcRenderer.invoke('export-overlay-preset-package', presets),
    importOverlayPresetPackage: (packagePath) => ipcRenderer.invoke('import-overlay-preset-package', packagePath),
    saveOverlayPresetAssets: (preset) => ipcRenderer.invoke('save-overlay-preset-assets', preset),
    writeClipboardText: (text) => {
        clipboard.writeText(String(text || ''));
        return true;
    },
    writeClipboardImage: (filePath) => {
        try {
            const { nativeImage } = require('electron');
            const cleanPath = localMediaUrlToPath(filePath);
            const img = nativeImage.createFromPath(cleanPath);
            if (!img || img.isEmpty()) return false;
            clipboard.writeImage(img);
            return true;
        } catch (e) {
            console.error('writeClipboardImage error:', e);
            return false;
        }
    },

    // 选择目录
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    selectDirectories: () => ipcRenderer.invoke('select-directories'),
    readWritingCursorImage: (source) => new Uint8Array(fs.readFileSync(sharedProfile.resolveSharedProfileFilePath(source))),
    importWritingCursorImage: (source) => {
        try{
            const ext=path.extname(source).toLowerCase();
            if(!['.png','.jpg','.jpeg','.webp','.gif'].includes(ext))throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片');
            const bytes=fs.readFileSync(source),hash=require('crypto').createHash('sha256').update(bytes).digest('hex');
            const root=path.join(_getProfileDataDir(),'videokit-presets','writing-images');
            fs.mkdirSync(root,{recursive:true});const target=path.join(root,hash+ext);
            if(!fs.existsSync(target))fs.writeFileSync(target,bytes,{flag:'wx'});
            for (const dir of _getAllProfileDataDirs()) {
                try {
                    const mirrorRoot = path.join(dir, 'videokit-presets', 'writing-images');
                    fs.mkdirSync(mirrorRoot, { recursive: true });
                    const mirrorTarget = path.join(mirrorRoot, hash + ext);
                    if (!fs.existsSync(mirrorTarget)) fs.writeFileSync(mirrorTarget, bytes, { flag: 'wx' });
                } catch (_) { }
            }
            return {ok:true,path:target};
        }catch(error){return {ok:false,error:error.message};}
    },
    selectFiles: (options) => ipcRenderer.invoke('select-files', options),
    saveFile: (options) => ipcRenderer.invoke('save-file', options),

    scanDirectory: (dirPath) => ipcRenderer.invoke('scan-directory', dirPath),
    // 本地多窗口整理与文件分拣能力
    localFiles: localFilesBridge,
    scanDirectoryRecursive: (dirPath, options) => ipcRenderer.invoke('scan-directory-recursive', dirPath, options),
    searchFilesRecursive: (searchDir, fileNames, maxDepth) => ipcRenderer.invoke('search-files-recursive', searchDir, fileNames, maxDepth),
    checkFilesExist: (filePaths) => ipcRenderer.invoke('check-files-exist', filePaths),
    getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),

    // 批量Reels - 烧录字幕
    burnSubtitles: (opts) => ipcRenderer.invoke('burn-subtitles', opts),
    reelsCompose: (opts) => ipcRenderer.invoke('reels-compose', opts),
    concatVideo: (opts) => ipcRenderer.invoke('concat-video', opts),
    reelsComposeWysiwyg: (action, data) => ipcRenderer.invoke('reels-compose-wysiwyg', action, data),
    reelsDetectSilence: (data) => ipcRenderer.invoke('reels-detect-silence', data),
    collectReelsProjectAssets: (data) => ipcRenderer.invoke('collect-reels-project-assets', data),
    copyReelsProjectPackage: (data) => ipcRenderer.invoke('copy-reels-project-package', data),
    createReelsFramePipeline: (sessionId) => new Promise((resolve, reject) => {
        const requestId = `reels-pipe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => {
            _reelsFramePipelineRequests.delete(requestId);
            reject(new Error('建立帧流水线超时'));
        }, 8000);
        _reelsFramePipelineRequests.set(requestId, { resolve, reject, timer });
        ipcRenderer.send('reels-frame-pipeline-open', { sessionId, requestId });
    }),
    sendReelsFramePipeline: (pipelineId, seq, raw) => new Promise((resolve, reject) => {
        const pipeline = _reelsFramePipelines.get(pipelineId);
        if (!pipeline) { reject(new Error('帧流水线不存在或已关闭')); return; }
        pipeline.pending.set(seq, { resolve, reject });
        try { pipeline.port.postMessage({ type: 'frame', seq, raw }, [raw]); }
        catch (err) { pipeline.pending.delete(seq); reject(err); }
    }),
    closeReelsFramePipeline: (pipelineId) => {
        const pipeline = _reelsFramePipelines.get(pipelineId);
        if (!pipeline) return;
        _reelsFramePipelines.delete(pipelineId);
        try { pipeline.port.close(); } catch (_) { }
    },
    getMediaDuration: (filePath) => {
        if (!filePath || typeof filePath !== 'string') return 0;
        const cleanPath = localMediaUrlToPath(filePath);
        return ipcRenderer.invoke('get-media-duration', cleanPath);
    },
    getMediaDurationDetail: (filePath) => {
        if (!filePath || typeof filePath !== 'string') {
            return Promise.resolve({ ok: false, duration: null, code: 'EMPTY_PATH', reason: '文件路径为空' });
        }
        return ipcRenderer.invoke('get-media-duration-detail', localMediaUrlToPath(filePath));
    },
    saveRenderedAudio: (wavData) => ipcRenderer.invoke('save-rendered-audio', wavData),
    readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
    // 分层 PNG 序列导出
    savePngFrame: (opts) => ipcRenderer.invoke('save-png-frame', opts),
    exportAudioMp3: (opts) => ipcRenderer.invoke('export-audio-mp3', opts),
    ensureDirectory: (dirPath) => ipcRenderer.invoke('ensure-directory', dirPath),

    // V3 并行影子窗口导出
    parallelWysiwygExport: (opts) => ipcRenderer.invoke('parallel-wysiwyg-export', opts),
    onParallelProgress: (callback) => {
        const handler = (_, data) => callback(data);
        ipcRenderer.on('parallel-export-progress', handler);
        return () => ipcRenderer.removeListener('parallel-export-progress', handler);
    },
    isolatedWysiwygExport: (opts) => ipcRenderer.invoke('isolated-wysiwyg-export', opts),
    cancelIsolatedWysiwygExport: (requestId) => ipcRenderer.send('cancel-isolated-wysiwyg-export', requestId),
    getLatestCrashDiagnostic: () => ipcRenderer.invoke('get-latest-crash-diagnostic'),
    onReelsCrashDiagnostic: (callback) => {
        const handler = (_, data) => callback(data);
        ipcRenderer.on('reels-crash-diagnostic', handler);
        return () => ipcRenderer.removeListener('reels-crash-diagnostic', handler);
    },
    onIsolatedWysiwygProgress: (requestId, callback) => {
        const handler = (_, data) => {
            if (data && data.requestId === requestId) callback(data);
        };
        ipcRenderer.on('isolated-wysiwyg-progress', handler);
        return () => ipcRenderer.removeListener('isolated-wysiwyg-progress', handler);
    },

    // 自动更新
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    getUpdateChannel: () => ipcRenderer.invoke('get-update-channel'),
    setUpdateChannel: (channel) => ipcRenderer.invoke('set-update-channel', channel),
    onUpdateStatus: (callback) => {
        const handler = (_, data) => callback(data);
        ipcRenderer.on('update-status', handler);
        return () => ipcRenderer.removeListener('update-status', handler);
    },

    // 扫描本地字体
    scanFonts: () => ipcRenderer.invoke('scan-fonts'),
    fetchGoogleFonts: () => ipcRenderer.invoke('fetch-google-fonts'),

    // 读取文件内容（支持跨安装版/绿色版共享目录解析）
    readFileText: (filePath) => {
        try {
            const resolved = sharedProfile.resolveSharedProfileFilePath(filePath);
            return fs.readFileSync(resolved, 'utf-8');
        } catch {
            return '';
        }
    },

    // 统一工程目录（优先指向安装版 %APPDATA%/videokit/projects，绿色版/开发版共享同一目录）
    getDefaultProjectDir: () => _getDefaultProjectDir(),
    getCandidateProjectDirs: () => sharedProfile.getCandidateProjectDirs(),
    listSharedProjectFiles: (customDir = '') => {
        try {
            const primaryDir = _getDefaultProjectDir();
            const candidateDirs = [...new Set([
                primaryDir,
                ...(customDir ? [path.resolve(customDir)] : []),
                ...sharedProfile.getCandidateProjectDirs(),
            ].filter(Boolean))];
            const byName = new Map();
            for (const dir of candidateDirs) {
                if (!fs.existsSync(dir)) continue;
                let entries = [];
                try { entries = fs.readdirSync(dir); } catch (_) { continue; }
                for (const fname of entries) {
                    if (!fname.toLowerCase().endsWith('.json')) continue;
                    if (/^workspace-previous-\d+\.json$/i.test(fname)) continue;
                    const fullPath = path.join(dir, fname);
                    let stat = null;
                    try {
                        stat = fs.statSync(fullPath);
                        if (!stat.isFile()) continue;
                    } catch (_) { continue; }
                    const key = fname.toLowerCase();
                    const existing = byName.get(key);
                    if (!existing || stat.mtimeMs > existing.mtimeMs + 500) {
                        byName.set(key, {
                            filename: fname,
                            path: fullPath,
                            mtimeMs: stat.mtimeMs,
                            size: stat.size,
                        });
                    }
                }
            }
            // Ensure any project found only in portable-data is also synced into primary installed projects dir
            for (const item of byName.values()) {
                if (primaryDir && path.resolve(path.dirname(item.path)).toLowerCase() !== path.resolve(primaryDir).toLowerCase()) {
                    const targetInPrimary = path.join(primaryDir, item.filename);
                    try {
                        if (!fs.existsSync(targetInPrimary) || fs.statSync(targetInPrimary).mtimeMs < item.mtimeMs - 500) {
                            fs.mkdirSync(primaryDir, { recursive: true });
                            fs.copyFileSync(item.path, targetInPrimary);
                        }
                        item.path = targetInPrimary;
                    } catch (_) { }
                }
            }
            return Array.from(byName.values()).sort((a, b) => a.filename.localeCompare(b.filename));
        } catch (e) {
            console.warn('[Projects] listSharedProjectFiles failed:', e.message);
            return [];
        }
    },
    saveSharedProjectFile: (fileName, content, customDir = '') => {
        try {
            const safeName = path.basename(String(fileName || 'UntitledProject.json').trim() || 'UntitledProject.json');
            const primaryDir = _getDefaultProjectDir();
            const targetDirs = [...new Set([
                ...(customDir ? [path.resolve(customDir)] : []),
                primaryDir,
                ...sharedProfile.getCandidateProjectDirs(),
            ].filter(Boolean))];
            let savedPrimary = false;
            const now = Date.now();
            for (const dir of targetDirs) {
                try {
                    fs.mkdirSync(dir, { recursive: true });
                    const targetFile = path.join(dir, safeName);
                    const tempFile = `${targetFile}.${process.pid}.${now}.tmp`;
                    fs.writeFileSync(tempFile, content, 'utf8');
                    fs.renameSync(tempFile, targetFile);
                    if (path.resolve(dir).toLowerCase() === path.resolve(primaryDir).toLowerCase()) {
                        savedPrimary = true;
                    }
                } catch (_) { }
            }
            return savedPrimary;
        } catch (e) {
            console.error('[Projects] saveSharedProjectFile failed:', e.message);
            return false;
        }
    },

    // 写入文件内容 (用于保存工程)
    readBatchWorkspace: () => {
        if (location.hash.startsWith('#template=')) return '';
        try {
            const raw = ipcRenderer.sendSync('workspace:read-startup');
            if (raw) {
                try {
                    _workspaceLastHash = require('crypto').createHash('sha256').update(raw.replace(/"timestamp":"[^"]*",?/, '')).digest('hex');
                } catch (_) { }
            }
            return raw;
        } catch (e) { console.warn('[Workspace] Read failed:', e.message); }
        return '';
    },
    saveBatchWorkspace: (content) => {
        if (location.hash.startsWith('#template=')) return true;
        try {
            const data = JSON.parse(content);
            if (data.version !== '2.0' || !Array.isArray(data.tabs) || !data.tabs.length) return false;
            const profile = _getProfileDataDir();
            if (!profile) return false;
            const dir = path.join(profile, 'projects');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, 'workspace-autosave.json');
            const hash = require('crypto').createHash('sha256').update(content.replace(/"timestamp":"[^"]*",?/, '')).digest('hex');
            if (hash === _workspaceLastHash && fs.existsSync(file)) {
                return true;
            }
            const now = Date.now();
            if (hash !== _workspaceLastHash && fs.existsSync(file) && (!_workspaceLastBackupAt || now - _workspaceLastBackupAt > 30000)) {
                for (let i = 4; i >= 1; i--) {
                    const old = path.join(dir, 'workspace-previous-' + i + '.json');
                    const next = path.join(dir, 'workspace-previous-' + (i + 1) + '.json');
                    if (fs.existsSync(old)) fs.copyFileSync(old, next);
                }
                fs.copyFileSync(file, path.join(dir, 'workspace-previous-1.json'));
                _workspaceLastBackupAt = now;
            }
            const writeAtomic = (targetFile) => {
                fs.mkdirSync(path.dirname(targetFile), { recursive: true });
                const temp = targetFile + '.' + process.pid + '.' + now + '.tmp';
                fs.writeFileSync(temp, content, 'utf8');
                fs.renameSync(temp, targetFile);
            };
            writeAtomic(file);
            for (const otherProfile of _getAllProfileDataDirs()) {
                const otherFile = path.join(otherProfile, 'projects', 'workspace-autosave.json');
                if (path.resolve(otherFile) === path.resolve(file)) continue;
                fs.promises.mkdir(path.dirname(otherFile), { recursive: true })
                    .then(() => {
                        const temp = otherFile + '.' + process.pid + '.' + now + '.tmp';
                        return fs.promises.writeFile(temp, content, 'utf8').then(() => fs.promises.rename(temp, otherFile));
                    })
                    .catch(() => { });
            }
            _workspaceLastHash = hash;
            return true;
        } catch (e) { console.error('[Workspace] Save failed:', e.message); return false; }
    },
    chooseBatchImportMode: (counts) => ipcRenderer.invoke('batch-project:choose-import-mode', counts),
    writeFileText: (filePath, content) => {
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, 'utf-8');
            return true;
        } catch (e) {
            console.error('Write File Error:', e);
            return false;
        }
    },

    // ==================== 统一 API 调用接口 ====================
    // 替代 fetch(`${API_BASE}/endpoint`, ...) 的调用方式
    // 用法: const result = await window.electronAPI.apiCall('elevenlabs/voices', { key_index: 0 })
    apiCall: (endpoint, data) => ipcRenderer.invoke('api-call', endpoint, data),
    onElevenLabsWebAuthStatus: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('elevenlabs-web-auth-status', handler);
        return () => ipcRenderer.removeListener('elevenlabs-web-auth-status', handler);
    },

    // 文件上传专用接口
    // 用法: const result = await window.electronAPI.apiUpload('upload', fileArrayBuffer, fileName, { extra: 'data' })
    apiUpload: (endpoint, fileBuffer, fileName, formData) =>
        ipcRenderer.invoke('api-upload', endpoint, fileBuffer, fileName, formData),

    // Wav2Lip 进度事件监听
    onWav2LipProgress: (callback) => {
        ipcRenderer.on('wav2lip-progress', (event, data) => callback(data));
    },

    // 批量下载进度事件监听
    onBatchDownloadProgress: (callback) => {
        ipcRenderer.on('batch-download-progress', (event, data) => callback(data));
    },

    // 链接截图进度事件监听
    onUrlThumbnailProgress: (callback) => {
        ipcRenderer.on('url-thumbnail-progress', (event, data) => callback(event, data));
    },

    onAutoEditProgress: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('auto-edit-progress', handler);
        return () => ipcRenderer.removeListener('auto-edit-progress', handler);
    },

    onAutoEditArchiveProgress: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('autoedit-archive-progress', handler);
        return () => ipcRenderer.removeListener('autoedit-archive-progress', handler);
    },

    onSubtitleProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('subtitle-progress', handler);
        return () => ipcRenderer.removeListener('subtitle-progress', handler);
    },

    // 在 Finder/Explorer 中高亮显示文件
    showItemInFolder: (filePath) => {
        ipcRenderer.invoke('show-item-in-folder', filePath).catch(() => {});
    },

    // 用系统默认浏览器打开链接
    openExternal: (url) => {
        ipcRenderer.invoke('open-external-url', url).catch(() => {});
    },

    // 缓存管理
    getCacheInfo: () => ipcRenderer.invoke('get-cache-info'),
    clearCache: () => ipcRenderer.invoke('clear-cache'),
    openCacheFolder: () => ipcRenderer.invoke('open-cache-folder'),
    setCachePath: (newPath) => ipcRenderer.invoke('set-cache-path', newPath),

    // 界面缩放（使用 Electron 原生 webFrame，正确处理布局视口）
    setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
    getZoomFactor: () => webFrame.getZoomFactor(),


    // 屏幕取色器（解决 Windows 吸管无法吸取窗口外颜色）
    screenPickColor: () => ipcRenderer.invoke('screen-pick-color'),

    // 模板多窗口
    openTemplateWindow: (templateId, templateName) => ipcRenderer.invoke('open-template-window', templateId, templateName),
});

// 兼容 ITEN 原生桥接层 bridge 对象
contextBridge.exposeInMainWorld('bridge', {
    toFileUrl,
    getPathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file) || '';
        } catch (_) {
            return file?.path || '';
        }
    },
    openPath: safeOpenPath,
    openExternal: safeOpenExternal,
    renameLocalFiles: (payload) => ipcRenderer.invoke('files:rename-local', payload),
    on: (channel, listener) => {
        const handler = (_event, ...args) => listener(...args);
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
    },
    removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener),
    localFiles: localFilesBridge
});

ipcRenderer.on('template-library:navigate',(_event,direction)=>{if(direction==='back'||direction==='forward')window.dispatchEvent(new CustomEvent('videokit-template-navigation',{detail:direction}));});
