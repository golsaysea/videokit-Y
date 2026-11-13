/**
 * web-bridge.js — Browser-mode polyfill for window.electronAPI & window.bridge
 *
 * When VideoKit is opened in a standard web browser (served by bin/videokit-web-server.cjs),
 * this script provides a complete, compatible window.electronAPI and window.bridge layer
 * backed by HTTP RPC, streaming media endpoints, and an in-page cloud directory picker.
 *
 * When running inside the Electron desktop app, window.electronAPI is already injected by
 * electron/preload.js, so this file exits immediately as a no-op.
 */
(function initVideoKitWebBridge() {
    if (typeof window === 'undefined' || window.electronAPI) {
        return;
    }

    console.log('[WebBridge] Browser environment detected — initializing VideoKit Web Bridge');

    // ── Token management ──
    function getApiToken() {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const qToken = urlParams.get('token');
            if (qToken) {
                localStorage.setItem('videokit_api_token', qToken);
                return qToken;
            }
            return localStorage.getItem('videokit_api_token') || '';
        } catch (_) {
            return '';
        }
    }

    function buildAuthHeaders(extra = {}) {
        const headers = { ...extra };
        const token = getApiToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        return headers;
    }

    function appendTokenQuery(url) {
        const token = getApiToken();
        if (!token) return url;
        return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }

    // ── Path helpers ──
    function cleanLocalMediaUrl(value) {
        if (!value || typeof value !== 'string') return '';
        let s = value.trim();
        if (/^local-media:\/\//i.test(s)) {
            s = s.replace(/^local-media:\/\/+/i, '/');
            try { s = decodeURIComponent(s); } catch (_) {}
            if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
            return s;
        }
        if (/^file:\/\//i.test(s)) {
            s = s.replace(/^file:\/\/+/i, '/');
            try { s = decodeURIComponent(s); } catch (_) {}
            if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
            return s;
        }
        if (s.includes('/api/web-bridge/media?')) {
            try {
                const u = new URL(s, window.location.origin);
                return u.searchParams.get('path') || s;
            } catch (_) {}
        }
        return s;
    }

    function toFileUrl(filePath) {
        if (!filePath || typeof filePath !== 'string') return '';
        const trimmed = filePath.trim();
        if (!trimmed) return '';
        if (/^(https?|data|blob):/i.test(trimmed) || trimmed.startsWith('/api/web-bridge/media')) {
            return trimmed;
        }
        let suffix = '';
        let raw = trimmed;
        const hashIdx = raw.indexOf('#');
        if (hashIdx !== -1) {
            suffix = raw.slice(hashIdx);
            raw = raw.slice(0, hashIdx);
        }
        const clean = cleanLocalMediaUrl(raw);
        return appendTokenQuery(`/api/web-bridge/media?path=${encodeURIComponent(clean)}`) + suffix;
    }

    function resolveAssetUrl(fileName) {
        if (!fileName) return '';
        const clean = String(fileName).replace(/^[/\\]+/, '');
        return appendTokenQuery(`/assets/${encodeURIComponent(clean)}`);
    }

    // Automatically rewrite local-media:// URLs assigned directly to img/video/audio .src
    function patchMediaElementSrc(Proto) {
        if (!Proto) return;
        const desc = Object.getOwnPropertyDescriptor(Proto, 'src');
        if (!desc || !desc.set || !desc.get) return;
        Object.defineProperty(Proto, 'src', {
            configurable: true,
            enumerable: true,
            get() {
                return desc.get.call(this);
            },
            set(val) {
                if (typeof val === 'string' && /^local-media:\/\//i.test(val)) {
                    desc.set.call(this, toFileUrl(val));
                } else {
                    desc.set.call(this, val);
                }
            },
        });
    }
    try {
        if (typeof HTMLMediaElement !== 'undefined') patchMediaElementSrc(HTMLMediaElement.prototype);
        if (typeof HTMLImageElement !== 'undefined') patchMediaElementSrc(HTMLImageElement.prototype);
    } catch (_) {}

    // ── RPC communication with bin/videokit-web-server.cjs ──
    async function rpcAsync(method, params = {}) {
        const res = await fetch('/api/web-bridge/rpc', {
            method: 'POST',
            headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ method, params }),
        });
        const json = await res.json();
        if (!res.ok || json.ok === false) {
            throw new Error(json.error || `RPC ${method} failed (${res.status})`);
        }
        return json.result;
    }

    function rpcSync(method, params = {}, fallbackValue = null) {
        try {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/web-bridge/rpc', false);
            xhr.setRequestHeader('Content-Type', 'application/json');
            const token = getApiToken();
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            xhr.send(JSON.stringify({ method, params }));
            if (xhr.status >= 200 && xhr.status < 300) {
                const parsed = JSON.parse(xhr.responseText);
                if (parsed && parsed.ok !== false) return parsed.result;
            }
        } catch (err) {
            console.warn(`[WebBridge] rpcSync(${method}) error:`, err.message);
        }
        return fallbackValue;
    }

    // Upload a browser File object synchronously or asynchronously to server workspace
    function uploadBrowserFileSync(file, targetDir = '') {
        if (!file || !(file instanceof File)) return '';
        if (file._serverPath) return file._serverPath;
        if (file.path && (file.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file.path))) {
            return file.path;
        }
        try {
            const xhr = new XMLHttpRequest();
            const qs = new URLSearchParams({
                filename: file.name || 'upload.bin',
                targetDir: targetDir || '',
            });
            xhr.open('POST', appendTokenQuery(`/api/web-bridge/upload-raw?${qs.toString()}`), false);
            const token = getApiToken();
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.send(file);
            if (xhr.status >= 200 && xhr.status < 300) {
                const data = JSON.parse(xhr.responseText);
                if (data && data.path) {
                    try {
                        Object.defineProperty(file, 'path', { value: data.path, configurable: true });
                        file._serverPath = data.path;
                    } catch (_) {
                        file._serverPath = data.path;
                    }
                    return data.path;
                }
            }
        } catch (err) {
            console.warn('[WebBridge] uploadBrowserFileSync failed:', err.message);
        }
        return '';
    }

    let _lastDroppedFilePaths = [];
    window.addEventListener('drop', (event) => {
        try {
            const files = Array.from(event.dataTransfer?.files || []);
            _lastDroppedFilePaths = files.map(f => uploadBrowserFileSync(f)).filter(Boolean);
        } catch (_) {
            _lastDroppedFilePaths = [];
        }
    }, true);

    // ── Automation hook for Cloud Assistant ──
    const _queuedPickerPaths = [];
    window._videokitWebSetNextPath = function (pathOrPaths) {
        _queuedPickerPaths.push(pathOrPaths);
        return true;
    };

    // ── In-page Cloud File/Folder Browser Modal ──
    function openCloudPathModal({ mode = 'directory', multiple = false, title = '选择云端目录或上传文件', defaultPath = '' } = {}) {
        if (_queuedPickerPaths.length > 0) {
            const next = _queuedPickerPaths.shift();
            if (mode === 'save') {
                return Promise.resolve({ success: true, filePath: Array.isArray(next) ? next[0] : String(next) });
            }
            if (multiple) {
                return Promise.resolve(Array.isArray(next) ? next : [String(next)]);
            }
            return Promise.resolve(Array.isArray(next) ? next[0] : String(next));
        }

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.id = 'vk-web-picker-modal';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;';

            const card = document.createElement('div');
            card.style.cssText = 'width:680px;max-width:94vw;max-height:85vh;background:#181b22;color:#f1f5f9;border:1px solid #334155;border-radius:12px;display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,0.6);overflow:hidden;';

            const header = document.createElement('div');
            header.style.cssText = 'padding:14px 18px;background:#0f172a;border-bottom:1px solid #334155;display:flex;justify-content:space-between;align-items:center;';
            header.innerHTML = `<div style="font-weight:700;font-size:15px;">☁️ ${title}</div>`;
            const closeBtn = document.createElement('button');
            closeBtn.textContent = '✕';
            closeBtn.style.cssText = 'background:transparent;border:none;color:#94a3b8;font-size:16px;cursor:pointer;';
            header.appendChild(closeBtn);

            const body = document.createElement('div');
            body.style.cssText = 'padding:14px 18px;display:flex;flex-direction:column;gap:10px;overflow:hidden;flex:1;';

            const pathRow = document.createElement('div');
            pathRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
            const upBtn = document.createElement('button');
            upBtn.textContent = '⬆ 上级';
            upBtn.style.cssText = 'padding:6px 10px;background:#334155;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;';
            const pathInput = document.createElement('input');
            pathInput.id = 'vk-web-picker-path-input';
            pathInput.type = 'text';
            pathInput.placeholder = '输入或选择云服务器路径...';
            pathInput.style.cssText = 'flex:1;padding:7px 10px;background:#0f172a;color:#f8fafc;border:1px solid #475569;border-radius:6px;font-size:13px;';
            const goBtn = document.createElement('button');
            goBtn.textContent = '前往';
            goBtn.style.cssText = 'padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;';
            pathRow.append(upBtn, pathInput, goBtn);

            const actionRow = document.createElement('div');
            actionRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';
            const mkdirBtn = document.createElement('button');
            mkdirBtn.textContent = '📁 新建文件夹';
            mkdirBtn.style.cssText = 'padding:5px 10px;background:#1e293b;color:#cbd5e1;border:1px solid #475569;border-radius:6px;cursor:pointer;font-size:12px;';

            const uploadLabel = document.createElement('label');
            uploadLabel.textContent = '📤 从本机上传文件到当前目录';
            uploadLabel.style.cssText = 'padding:5px 12px;background:#059669;color:#fff;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;';
            const uploadInput = document.createElement('input');
            uploadInput.type = 'file';
            uploadInput.multiple = true;
            uploadInput.style.display = 'none';
            uploadLabel.appendChild(uploadInput);

            const statusSpan = document.createElement('span');
            statusSpan.style.cssText = 'font-size:12px;color:#94a3b8;margin-left:auto;';
            actionRow.append(mkdirBtn, uploadLabel, statusSpan);

            const listBox = document.createElement('div');
            listBox.style.cssText = 'height:300px;overflow-y:auto;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:6px;';

            const footer = document.createElement('div');
            footer.style.cssText = 'padding:12px 18px;background:#0f172a;border-top:1px solid #334155;display:flex;justify-content:flex-end;gap:10px;';
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = '取消';
            cancelBtn.style.cssText = 'padding:7px 16px;background:#334155;color:#f1f5f9;border:none;border-radius:6px;cursor:pointer;font-size:13px;';
            const confirmBtn = document.createElement('button');
            confirmBtn.id = 'vk-web-picker-confirm-btn';
            confirmBtn.textContent = mode === 'save' ? '保存到此路径' : '确定选择';
            confirmBtn.style.cssText = 'padding:7px 18px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;';
            footer.append(cancelBtn, confirmBtn);

            body.append(pathRow, actionRow, listBox);
            card.append(header, body, footer);
            overlay.appendChild(card);
            document.body.appendChild(overlay);

            let currentDir = defaultPath || '';
            const selectedFiles = new Set();

            async function loadDir(targetDir) {
                try {
                    const info = await rpcAsync('webListDir', { dirPath: targetDir });
                    currentDir = info.currentDir;
                    pathInput.value = mode === 'save' && defaultPath && !targetDir ? defaultPath : currentDir;
                    selectedFiles.clear();
                    listBox.innerHTML = '';

                    if (!info.entries || info.entries.length === 0) {
                        listBox.innerHTML = '<div style="padding:20px;text-align:center;color:#64748b;font-size:13px;">此目录为空（可直接点击上方“从本机上传文件到当前目录”）</div>';
                        return;
                    }

                    for (const entry of info.entries) {
                        const row = document.createElement('div');
                        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;cursor:pointer;font-size:13px;user-select:none;';
                        row.onmouseenter = () => { if (!selectedFiles.has(entry.path)) row.style.background = '#1e293b'; };
                        row.onmouseleave = () => { if (!selectedFiles.has(entry.path)) row.style.background = 'transparent'; };

                        const icon = entry.isDirectory ? '📁' : '📄';
                        const sizeText = entry.isDirectory ? '' : `${(entry.size / 1024).toFixed(1)} KB`;
                        row.innerHTML = `<span>${icon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${entry.name}</span><span style="color:#64748b;font-size:11px;">${sizeText}</span>`;

                        row.onclick = () => {
                            if (entry.isDirectory) {
                                loadDir(entry.path);
                            } else if (mode !== 'directory') {
                                if (!multiple) {
                                    selectedFiles.clear();
                                    Array.from(listBox.children).forEach(c => { c.style.background = 'transparent'; });
                                }
                                if (selectedFiles.has(entry.path)) {
                                    selectedFiles.delete(entry.path);
                                    row.style.background = 'transparent';
                                } else {
                                    selectedFiles.add(entry.path);
                                    row.style.background = '#1d4ed8';
                                }
                                pathInput.value = entry.path;
                            }
                        };
                        listBox.appendChild(row);
                    }
                } catch (err) {
                    statusSpan.textContent = `读取失败: ${err.message}`;
                }
            }

            upBtn.onclick = () => {
                if (!currentDir) return;
                const parent = currentDir.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '') || '/';
                loadDir(parent);
            };
            goBtn.onclick = () => loadDir(pathInput.value.trim());
            mkdirBtn.onclick = async () => {
                const name = window.prompt('请输入新建文件夹名称:', '新素材目录');
                if (!name) return;
                try {
                    const res = await rpcAsync('webCreateDir', { parentDir: currentDir, name: name.trim() });
                    if (res && res.path) loadDir(res.path);
                } catch (err) {
                    statusSpan.textContent = err.message;
                }
            };
            uploadInput.onchange = async () => {
                const files = Array.from(uploadInput.files || []);
                if (!files.length) return;
                statusSpan.textContent = `正在上传 ${files.length} 个文件...`;
                const uploadedPaths = [];
                for (const f of files) {
                    const p = uploadBrowserFileSync(f, currentDir);
                    if (p) uploadedPaths.push(p);
                }
                statusSpan.textContent = `已上传 ${uploadedPaths.length} 个文件`;
                await loadDir(currentDir);
                if (mode === 'files' && uploadedPaths.length > 0) {
                    uploadedPaths.forEach(p => selectedFiles.add(p));
                    pathInput.value = uploadedPaths[0];
                }
            };

            function finish(val) {
                overlay.remove();
                resolve(val);
            }

            closeBtn.onclick = () => finish(mode === 'save' ? { success: false, canceled: true } : null);
            cancelBtn.onclick = () => finish(mode === 'save' ? { success: false, canceled: true } : null);
            confirmBtn.onclick = () => {
                const val = pathInput.value.trim() || currentDir;
                if (mode === 'save') {
                    return finish({ success: Boolean(val), filePath: val });
                }
                if (mode === 'files') {
                    const arr = selectedFiles.size > 0 ? Array.from(selectedFiles) : (val ? [val] : []);
                    return finish(arr.length ? arr : null);
                }
                if (multiple) {
                    return finish(val ? [val] : null);
                }
                return finish(val || null);
            };

            loadDir(currentDir);
        });
    }

    // ── Event listener registries for progress callbacks ──
    const _isolatedProgressListeners = new Map();
    const _channelListeners = new Map();

    function addChannelListener(channel, cb) {
        if (!_channelListeners.has(channel)) _channelListeners.set(channel, new Set());
        _channelListeners.get(channel).add(cb);
        return () => _channelListeners.get(channel)?.delete(cb);
    }

    // ── Show download banner when a web export finishes ──
    function showWebDownloadToast(outputPath) {
        if (!outputPath) return;
        const dlUrl = appendTokenQuery(`/api/web-bridge/download?path=${encodeURIComponent(outputPath)}`);
        let container = document.getElementById('vk-web-download-toast');
        if (!container) {
            container = document.createElement('div');
            container.id = 'vk-web-download-toast';
            container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999998;background:#0f172a;border:1px solid #22c55e;color:#f8fafc;padding:12px 16px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.5);display:flex;align-items:center;gap:12px;font-size:13px;';
            document.body.appendChild(container);
        }
        const fileName = outputPath.replace(/\\/g, '/').split('/').pop() || 'output.mp4';
        container.innerHTML = `
            <span>✅ 导出完成: <b>${fileName}</b></span>
            <a href="${dlUrl}" download="${fileName}" style="padding:5px 12px;background:#22c55e;color:#052e16;font-weight:700;border-radius:6px;text-decoration:none;">⬇ 下载到本地</a>
            <button onclick="this.parentElement.remove()" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;">✕</button>
        `;
    }

    // ── Build localFilesBridge ──
    const localFilesBridge = {
        pickFolder: (options) => openCloudPathModal({ mode: 'directory', multiple: Boolean(options?.multi), title: '选择云端素材文件夹' }),
        pickImage: async () => {
            const files = await openCloudPathModal({ mode: 'files', multiple: false, title: '选择图片' });
            return files?.[0] || null;
        },
        getSubfolders: (folderPath) => rpcAsync('local:getSubfolders', { folderPath }),
        listDirectory: (folderPath, options) => rpcAsync('local:listDirectory', { folderPath, options }),
        scanFolder: (folderPath, options) => rpcAsync('local:scanFolder', { folderPath, options }),
        getFolderAvatarMedia: () => Promise.resolve(null),
        getVideoThumbnail: (filePath) => Promise.resolve(toFileUrl(filePath)),
        getLocalThumbnail: (filePath) => Promise.resolve(toFileUrl(filePath)),
        flattenFolder: (folderPath) => rpcAsync('local:flattenFolder', { folderPath }),
        copyToFolder: (filePath, targetDir, options) => rpcAsync('local:copyToFolder', { filePath, targetDir, options }),
        moveToFolder: (filePath, targetDir, options) => rpcAsync('local:moveToFolder', { filePath, targetDir, options }),
        removeDuplicates: () => Promise.resolve({ removed: 0 }),
        findDuplicates: () => Promise.resolve([]),
        trashFiles: (filePaths) => rpcAsync('local:trashFiles', { filePaths }),
        copyToClipboard: () => Promise.resolve(true),
        createFolder: (parentDir, folderName) => rpcAsync('webCreateDir', { parentDir, name: folderName }),
        moveFolderToFolder: (srcDir, targetDir) => rpcAsync('local:moveToFolder', { filePath: srcDir, targetDir }),
        copyFolderToFolder: (srcDir, targetDir) => rpcAsync('local:copyToFolder', { filePath: srcDir, targetDir }),
        mergeMaterialFolders: () => Promise.resolve({ ok: true }),
        exportPreset: async (jsonStr) => {
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `videokit-preset-${Date.now()}.json`;
            a.click();
            return { success: true };
        },
        importPreset: () => Promise.resolve(null),
        importPresetsMulti: () => Promise.resolve([]),
        exportWorkspaceConfig: async (jsonStr) => {
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `videokit-workspace-${Date.now()}.json`;
            a.click();
            return { success: true };
        },
        importWorkspaceConfig: () => Promise.resolve(null),
        watchFolders: () => Promise.resolve(true),
        validateFolders: (folders) => rpcAsync('checkFilesExist', { filePaths: folders || [] }),
        onScanProgress: (cb) => addChannelListener('local:scan-progress', cb),
        onFolderRenamed: (cb) => addChannelListener('local:folder-renamed', cb),
        onFolderMissing: (cb) => addChannelListener('local:folder-missing', cb),
    };

    // ── Expose window.electronAPI ──
    window.electronAPI = {
        isWebBridge: true,
        platform: 'linux',
        autoSavePath: '/cloud/.videokit/autosave.json',
        resolveAssetUrl,
        toFileUrl,
        fileExists: (p) => {
            if (!p || typeof p !== 'string') return false;
            if (/^(blob|data|https?):/i.test(p.trim())) return true;
            return Boolean(rpcSync('fsExists', { path: cleanLocalMediaUrl(p) }, false));
        },
        getFilePath: (file) => uploadBrowserFileSync(file),
        consumeDroppedFilePaths: () => {
            const paths = _lastDroppedFilePaths;
            _lastDroppedFilePaths = [];
            return paths;
        },
        isDirectory: (p) => Boolean(rpcSync('isDirectory', { path: cleanLocalMediaUrl(p) }, false)),
        fsExists: (p) => Boolean(rpcSync('fsExists', { path: cleanLocalMediaUrl(p) }, false)),
        fsStat: (p) => rpcSync('fsStat', { path: cleanLocalMediaUrl(p) }, null),
        fsReaddir: (p) => rpcSync('fsReaddir', { path: cleanLocalMediaUrl(p) }, []),
        pathJoin: (...args) => args.filter(Boolean).join('/').replace(/\/+/g, '/'),
        pathBasename: (p) => String(p || '').replace(/\\/g, '/').split('/').pop() || '',
        pathDirname: (p) => {
            const s = String(p || '').replace(/\\/g, '/');
            const idx = s.lastIndexOf('/');
            return idx > 0 ? s.slice(0, idx) : '/';
        },
        getAppVersion: () => rpcAsync('getAppVersion'),

        // Font favorites & presets
        importLocalFont: async (fileName, bytes) => {
            const b64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
            return rpcAsync('importLocalFont', { fileName, base64: b64 });
        },
        getFontFavorites: () => {
            try { return JSON.parse(localStorage.getItem('fp_favorites') || '[]'); } catch (_) { return []; }
        },
        toggleFontFavorite: (family) => {
            const favs = window.electronAPI.getFontFavorites();
            const idx = favs.indexOf(family);
            if (idx >= 0) favs.splice(idx, 1);
            else favs.push(family);
            localStorage.setItem('fp_favorites', JSON.stringify(favs));
            return favs;
        },
        saveFontFavorites: (values) => {
            localStorage.setItem('fp_favorites', JSON.stringify(values || []));
            return values || [];
        },
        readReelsOutputDirectory: () => rpcSync('readReelsOutputDirectory', {}, ''),
        saveReelsOutputDirectory: (dir) => rpcSync('saveReelsOutputDirectory', { dir }, { ok: true }),
        readOverlayGroupPresets: () => rpcSync('readPersistentPreset', { key: 'reels_overlay_group_presets' }, localStorage.getItem('reels_overlay_group_presets') || '{}'),
        saveOverlayGroupPresets: (value) => {
            try { localStorage.setItem('reels_overlay_group_presets', value); } catch (_) {}
            return rpcSync('savePersistentPreset', { key: 'reels_overlay_group_presets', value }, { ok: true });
        },
        readSubtitlePresets: () => rpcSync('readPersistentPreset', { key: 'reels_subtitle_presets' }, localStorage.getItem('reels_subtitle_presets') || '{}'),
        saveSubtitlePresets: (value) => {
            try { localStorage.setItem('reels_subtitle_presets', value); } catch (_) {}
            return rpcSync('savePersistentPreset', { key: 'reels_subtitle_presets', value }, { ok: true });
        },
        exportOverlayPresetPackage: (presets) => rpcAsync('exportOverlayPresetPackage', { presets }),
        importOverlayPresetPackage: (packagePath) => rpcAsync('importOverlayPresetPackage', { packagePath }),
        saveOverlayPresetAssets: (preset) => rpcAsync('saveOverlayPresetAssets', { preset }),

        writeClipboardText: (text) => {
            try { navigator.clipboard?.writeText(String(text || '')); } catch (_) {}
            return true;
        },
        writeClipboardImage: () => false,

        // Pickers
        selectDirectory: () => openCloudPathModal({ mode: 'directory', multiple: false, title: '选择云端文件夹' }),
        selectDirectories: () => openCloudPathModal({ mode: 'directory', multiple: true, title: '选择多个云端文件夹' }),
        selectFiles: (options = {}) => openCloudPathModal({ mode: 'files', multiple: options.multiple !== false, title: options.title || '选择云端文件或上传' }),
        saveFile: async (options = {}) => {
            const res = await openCloudPathModal({
                mode: 'save',
                title: options.title || '保存到云端路径',
                defaultPath: options.defaultPath || '',
            });
            if (res && res.success && res.filePath && options.content !== undefined) {
                await rpcAsync('writeFileText', { filePath: res.filePath, content: String(options.content) });
            }
            return res || { success: false, canceled: true };
        },
        readWritingCursorImage: () => new Uint8Array(0),
        importWritingCursorImage: (source) => Promise.resolve({ ok: true, path: source }),

        // Directory scanning
        scanDirectory: (dirPath) => rpcAsync('scanDirectory', { dirPath: cleanLocalMediaUrl(dirPath) }),
        localFiles: localFilesBridge,
        scanDirectoryRecursive: (dirPath, options) => rpcAsync('scanDirectoryRecursive', { dirPath: cleanLocalMediaUrl(dirPath), options }),
        searchFilesRecursive: (searchDir, fileNames, maxDepth) => rpcAsync('searchFilesRecursive', { searchDir: cleanLocalMediaUrl(searchDir), fileNames, maxDepth }),
        checkFilesExist: (filePaths) => rpcAsync('checkFilesExist', { filePaths: (filePaths || []).map(cleanLocalMediaUrl) }),
        getDownloadsPath: () => rpcAsync('getDownloadsPath'),

        // Media & Reels Export
        burnSubtitles: async (opts) => {
            const res = await rpcAsync('burnSubtitles', opts);
            if (res?.outputPath) showWebDownloadToast(res.outputPath);
            return res;
        },
        reelsCompose: async (opts) => {
            const res = await rpcAsync('reelsCompose', opts);
            if (res?.data?.outputPath || opts?.output_path) showWebDownloadToast(res?.data?.outputPath || opts?.output_path);
            return res;
        },
        concatVideo: (opts) => rpcAsync('concatVideo', opts),
        reelsComposeWysiwyg: (action, data) => rpcAsync('reelsComposeWysiwyg', { action, data }),
        reelsDetectSilence: (data) => rpcAsync('reelsDetectSilence', data),
        collectReelsProjectAssets: (data) => rpcAsync('collectReelsProjectAssets', data),
        copyReelsProjectPackage: (data) => rpcAsync('copyReelsProjectPackage', data),
        createReelsFramePipeline: () => Promise.resolve({ ok: true }),
        sendReelsFramePipeline: () => Promise.resolve({ ok: true }),
        closeReelsFramePipeline: () => Promise.resolve({ ok: true }),

        getMediaDuration: (filePath) => {
            if (!filePath || typeof filePath !== 'string') return Promise.resolve(0);
            return rpcAsync('getMediaDuration', { filePath: cleanLocalMediaUrl(filePath) });
        },
        getMediaDurationDetail: (filePath) => {
            if (!filePath || typeof filePath !== 'string') {
                return Promise.resolve({ ok: false, duration: null, code: 'EMPTY_PATH', reason: '文件路径为空' });
            }
            return rpcAsync('getMediaDurationDetail', { filePath: cleanLocalMediaUrl(filePath) });
        },
        saveRenderedAudio: (wavData) => {
            const b64 = btoa(String.fromCharCode(...new Uint8Array(wavData)));
            return rpcAsync('saveRenderedAudio', { base64: b64 });
        },
        readFileBuffer: async (filePath) => {
            const res = await fetch(toFileUrl(filePath));
            return await res.arrayBuffer();
        },
        savePngFrame: (opts) => rpcAsync('savePngFrame', opts),
        exportAudioMp3: (opts) => rpcAsync('exportAudioMp3', opts),
        ensureDirectory: (dirPath) => rpcAsync('ensureDirectory', { dirPath: cleanLocalMediaUrl(dirPath) }),

        parallelWysiwygExport: async (opts) => {
            const res = await rpcAsync('isolatedWysiwygExport', opts);
            if (res?.outputPath) showWebDownloadToast(res.outputPath);
            return res;
        },
        onParallelProgress: (cb) => addChannelListener('parallel-export-progress', cb),
        isolatedWysiwygExport: async (opts = {}) => {
            const requestId = String(opts.requestId || `web-export-${Date.now()}`);
            const cbs = _isolatedProgressListeners.get(requestId) || [];
            cbs.forEach(fn => fn({ requestId, pct: 5, stage: 'running', message: '云端正在渲染导出...' }));
            const res = await rpcAsync('isolatedWysiwygExport', { requestId, params: opts.params || {} });
            cbs.forEach(fn => fn({ requestId, pct: 100, stage: 'done', message: '导出完成' }));
            if (res?.outputPath || opts?.params?.outputPath) {
                showWebDownloadToast(res?.outputPath || opts?.params?.outputPath);
            }
            return res;
        },
        showReelsExportError: (payload) => {
            window.alert(`视频导出失败:\n${payload?.detail || '未知错误'}`);
            return Promise.resolve();
        },
        cancelIsolatedWysiwygExport: (requestId) => {
            rpcAsync('cancelIsolatedWysiwygExport', { requestId }).catch(() => {});
        },
        getLatestCrashDiagnostic: () => Promise.resolve(null),
        onReelsCrashDiagnostic: () => () => {},
        onIsolatedWysiwygProgress: (requestId, callback) => {
            if (!_isolatedProgressListeners.has(requestId)) {
                _isolatedProgressListeners.set(requestId, new Set());
            }
            _isolatedProgressListeners.get(requestId).add(callback);
            return () => _isolatedProgressListeners.get(requestId)?.delete(callback);
        },

        // Auto-updater stubs
        checkForUpdates: () => Promise.resolve({ updateAvailable: false }),
        downloadUpdate: () => Promise.resolve(),
        installUpdate: () => Promise.resolve(),
        getUpdateChannel: () => Promise.resolve('stable'),
        setUpdateChannel: () => Promise.resolve('stable'),
        getUpdatePrefs: () => Promise.resolve({ channel: 'stable', notifyStable: true, notifyBeta: false }),
        setUpdatePrefs: (prefs = {}) => Promise.resolve({ channel: prefs.notifyBeta ? 'beta' : 'stable', notifyStable: prefs.notifyStable !== false, notifyBeta: Boolean(prefs.notifyBeta) }),
        onUpdateStatus: () => () => {},

        // Fonts
        scanFonts: () => rpcAsync('scanFonts'),
        fetchGoogleFonts: () => rpcAsync('fetchGoogleFonts'),

        // File I/O & Workspace Persistence
        readFileText: (filePath) => rpcSync('readFileText', { filePath: cleanLocalMediaUrl(filePath) }, ''),
        writeFileText: (filePath, content) => Boolean(rpcSync('writeFileText', { filePath: cleanLocalMediaUrl(filePath), content }, false)),
        getDefaultProjectDir: () => rpcSync('getDefaultProjectDir', {}, '/cloud/.videokit/projects'),
        getCandidateProjectDirs: () => [rpcSync('getDefaultProjectDir', {}, '/cloud/.videokit/projects')],
        listSharedProjectFiles: (customDir = '') => rpcSync('listSharedProjectFiles', { customDir }, []),
        saveSharedProjectFile: (fileName, content, customDir = '') => Boolean(rpcSync('saveSharedProjectFile', { fileName, content, customDir }, false)),
        readBatchWorkspace: () => rpcSync('readBatchWorkspace', {}, ''),
        saveBatchWorkspace: (content) => Boolean(rpcSync('saveBatchWorkspace', { content }, false)),
        chooseBatchImportMode: () => Promise.resolve('append'),

        // Unified API & Upload
        apiCall: (endpoint, data) => rpcAsync('apiCall', { endpoint, data }),
        onElevenLabsWebAuthStatus: () => () => {},
        apiUpload: async (endpoint, fileBuffer, fileName, formData) => {
            const bytes = new Uint8Array(fileBuffer);
            let binary = '';
            const chunkSize = 0x8000;
            for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
            }
            const base64 = btoa(binary);
            return rpcAsync('apiUpload', { endpoint, base64, fileName, formData });
        },

        // Progress listeners
        onWav2LipProgress: (cb) => addChannelListener('wav2lip-progress', cb),
        onBatchDownloadProgress: (cb) => addChannelListener('batch-download-progress', cb),
        onUrlThumbnailProgress: (cb) => addChannelListener('url-thumbnail-progress', cb),
        onAutoEditProgress: (cb) => addChannelListener('auto-edit-progress', cb),
        onAutoEditArchiveProgress: (cb) => addChannelListener('autoedit-archive-progress', cb),
        onSubtitleProgress: (cb) => addChannelListener('subtitle-progress', cb),

        showItemInFolder: (filePath) => showWebDownloadToast(cleanLocalMediaUrl(filePath)),
        openExternal: (url) => { if (url) window.open(url, '_blank', 'noopener'); },

        getCacheInfo: () => rpcAsync('getCacheInfo'),
        clearCache: () => rpcAsync('clearCache'),
        openCacheFolder: () => Promise.resolve(),
        setCachePath: () => Promise.resolve({ success: true }),

        setZoomFactor: (factor) => { document.body.style.zoom = String(factor || 1); },
        getZoomFactor: () => parseFloat(document.body.style.zoom || '1') || 1,
        screenPickColor: async () => {
            if (window.EyeDropper) {
                try {
                    const ed = new window.EyeDropper();
                    const res = await ed.open();
                    return res?.sRGBHex || null;
                } catch (_) {}
            }
            return null;
        },
        openTemplateWindow: () => Promise.resolve(),
    };

    window.bridge = {
        toFileUrl,
        getPathForFile: (file) => uploadBrowserFileSync(file),
        openPath: async (p) => { showWebDownloadToast(cleanLocalMediaUrl(p)); return { success: true }; },
        openExternal: async (url) => { if (url) window.open(url, '_blank', 'noopener'); return { success: true }; },
        renameLocalFiles: (payload) => rpcAsync('files:renameLocal', payload),
        on: (channel, listener) => addChannelListener(channel, listener),
        removeListener: (channel, listener) => _channelListeners.get(channel)?.delete(listener),
        localFiles: localFilesBridge,
    };
})();
