/**
 * 自动更新模块 — 基于 GitHub Releases + electron-updater
 * 
 * 双通道发布：
 *   - 正式版 (stable): tag 格式 v2.2.0 → GitHub Release (非 prerelease)
 *   - 测试版 (beta):   tag 格式 v2.3.0-beta.1 → GitHub Release (prerelease)
 * 
 * 绿色版 (zip) 支持：
 *   - 检测到当前是绿色版（无安装器）时，自动下载 zip 包并解压覆盖当前目录
 *   - 安装版则使用标准 electron-updater 的 quitAndInstall()
 * 
 * 用户可在设置中切换是否接收测试版更新。
 */
let autoUpdater = null;
try {
    autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {
    console.warn('[Updater] electron-updater not available in dev mode:', e.message);
}
const { app, BrowserWindow, ipcMain: rawIpcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const { assertTrustedRenderer } = require('./services/trustedRenderer');
const ipcMain = { handle: (channel, listener) => rawIpcMain.handle(channel, (event, ...args) => { assertTrustedRenderer(event); return listener(event, ...args); }) };
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

let mainWindow = null;
let log = console.log;

// 绿色版状态
let _isPortable = false;
let _portableDir = '';          // 绿色版 exe 所在目录
let _pendingPortableUpdate = null; // { version, zipUrl, releaseNotes }
let _pendingPortableStagingDir = ''; // Windows 文件被占用时的暂存解压目录

async function prepareForUpdateRestart() {
    // Template editors own their unsaved work; never destroy them during update.
    const windows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed());
    if (windows.some(win => win !== mainWindow)) {
        await dialog.showMessageBox(mainWindow, {type:'info', title:'请先保存工程', message:'请先保存并关闭其它工程窗口，等待导出结束后再安装更新。', buttons:['返回软件']});
        throw new Error('更新已暂停：请先保存并关闭其它工程窗口。');
    }
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && !mainWindow.webContents.isCrashed()) {
        const result = await mainWindow.webContents.executeJavaScript(`(()=>{
            if(window._reelsState?.isExporting)return {ok:false,error:'正在导出，请结束后再更新'};
            if(typeof window.reelsFlushWorkspaceBeforeClose!=='function')return {ok:false,error:'工程尚未加载完成'};
            return window.reelsFlushWorkspaceBeforeClose();
        })()`, true);
        if (!result?.ok) throw new Error(result?.error || '更新前保存工程失败');
        try { await mainWindow.webContents.session.clearCodeCaches({}); } catch (_) {}
    }
    app.isQuitting = true;
    app._updateRestartApproved = true;
    try { app.releaseSingleInstanceLock(); } catch (_) {}
}

function _quotePowerShellLiteral(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

function launchPortableRestart() {
    if (process.platform === 'win32' && _pendingPortableStagingDir && fs.existsSync(_pendingPortableStagingDir)) {
        try {
            const scriptPath = path.join(_portableDir, '.videokit-portable-apply.ps1');
            let unpackRoot = _pendingPortableStagingDir;
            try {
                const entries = fs.readdirSync(_pendingPortableStagingDir, { withFileTypes: true });
                if (entries.length === 1 && entries[0].isDirectory() && !fs.existsSync(path.join(_pendingPortableStagingDir, path.basename(process.execPath)))) {
                    unpackRoot = path.join(_pendingPortableStagingDir, entries[0].name);
                }
            } catch (_) {}
            const psContent = [
                '$ErrorActionPreference = "Stop"',
                `$targetPid = ${process.pid}`,
                'for ($i = 0; $i -lt 60; $i++) {',
                '    if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { break }',
                '    Start-Sleep -Milliseconds 250',
                '}',
                `$src = ${_quotePowerShellLiteral(unpackRoot)}`,
                `$dst = ${_quotePowerShellLiteral(_portableDir)}`,
                `$staging = ${_quotePowerShellLiteral(_pendingPortableStagingDir)}`,
                'if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) { throw "VideoKit has not exited" }',
                'if (Test-Path -LiteralPath $src) {',
                '    Get-ChildItem -LiteralPath $src -Force | ForEach-Object {',
                '        Copy-Item -LiteralPath $_.FullName -Destination $dst -Recurse -Force',
                '    }',
                '}',
                'Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue',
                `Start-Process -FilePath ${_quotePowerShellLiteral(process.execPath)} -WorkingDirectory $dst -WindowStyle Hidden`,
                'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
            ].join('\r\n');
            fs.writeFileSync(scriptPath, psContent, 'utf8');
            const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
            app.exit(0);
            return;
        } catch (err) {
            log(`[Updater-Portable] 启动暂存覆盖脚本失败，回退直接重启: ${err.message}`);
        }
    }
    app.relaunch();
    app.exit(0);
}

// 使用 electron-store 持久化更新通道偏好
let store = null;
try {
    const Store = require('electron-store');
    store = new Store({ name: 'updater-settings' });
} catch (e) {
    // fallback: 无持久化，默认 stable
}

/**
 * 检测是否为绿色版（非安装版）
 * 安装版特征：在同目录或上级目录有 Uninstall *.exe
 * 绿色版特征：没有安装器痕迹，直接从 zip 解压运行
 */
function detectPortableMode() {
    if (process.platform !== 'win32') return false;

    const exeDir = path.dirname(process.execPath);

    // 检查同目录是否有 Uninstall*.exe（NSIS 安装标志）
    try {
        const files = fs.readdirSync(exeDir);
        const hasUninstaller = files.some(f => /^unins/i.test(f) && f.endsWith('.exe'));
        if (hasUninstaller) return false;
    } catch { /* 读取失败当作绿色版 */ }

    // 检查是否在 AppData 标准安装目录下
    const localAppData = process.env.LOCALAPPDATA || '';
    if (localAppData && exeDir.toLowerCase().startsWith(localAppData.toLowerCase())) {
        // 在 LOCALAPPDATA 下 → 大概率是安装版
        return false;
    }

    // 检查是否在 Program Files 下
    const progFiles = process.env['ProgramFiles'] || '';
    const progFiles86 = process.env['ProgramFiles(x86)'] || '';
    if (progFiles && exeDir.toLowerCase().startsWith(progFiles.toLowerCase())) return false;
    if (progFiles86 && exeDir.toLowerCase().startsWith(progFiles86.toLowerCase())) return false;

    return true;
}

/**
 * 读取更新通道与提醒偏好（正式版提醒默认开启，测试版提醒默认关闭）
 */
function getUpdatePrefs() {
    const notifyStable = store ? store.get('notifyStableUpdates', true) !== false : true;
    const notifyBeta = store ? store.get('notifyBetaUpdates', false) === true : false;
    return {
        channel: notifyBeta ? 'beta' : 'stable',
        notifyStable,
        notifyBeta,
    };
}

/**
 * 获取当前更新通道
 * @returns {'stable' | 'beta'}
 */
function getUpdateChannel() {
    return getUpdatePrefs().channel;
}

function _applyChannelToAutoUpdater(prefs = getUpdatePrefs()) {
    if (!autoUpdater) return;
    autoUpdater.allowPrerelease = Boolean(prefs.notifyBeta);

    // 关键：如果当前是测试版，关闭测试版并切回 stable 时允许降级到正式版
    const currentVersion = require('electron').app.getVersion();
    const currentIsBeta = isBetaVersion(currentVersion);
    if (!prefs.notifyBeta && currentIsBeta) {
        autoUpdater.allowDowngrade = true;
        log(`[Updater] 当前为测试版 v${currentVersion}，已启用降级模式，可回退到正式版`);
    } else {
        autoUpdater.allowDowngrade = false;
    }

    log(`[Updater] 更新通道已切换为: ${prefs.channel} (allowPrerelease=${autoUpdater.allowPrerelease}, allowDowngrade=${autoUpdater.allowDowngrade}, notifyStable=${prefs.notifyStable}, notifyBeta=${prefs.notifyBeta})`);
}

/**
 * 更新提醒偏好及更新通道
 */
function setUpdatePrefs(prefs = {}) {
    const cur = getUpdatePrefs();
    let nextStable = cur.notifyStable;
    let nextBeta = cur.notifyBeta;
    if (typeof prefs.notifyStable === 'boolean') {
        nextStable = prefs.notifyStable;
    }
    if (typeof prefs.notifyBeta === 'boolean') {
        nextBeta = prefs.notifyBeta;
    } else if (typeof prefs.channel === 'string') {
        nextBeta = prefs.channel === 'beta';
    }
    const nextChannel = nextBeta ? 'beta' : 'stable';
    if (store) {
        store.set('notifyStableUpdates', nextStable);
        store.set('notifyBetaUpdates', nextBeta);
        store.set('updateChannel', nextChannel);
    }
    const resolved = getUpdatePrefs();
    _applyChannelToAutoUpdater(resolved);
    return resolved;
}

/**
 * 设置更新通道
 * @param {'stable' | 'beta'} channel
 */
function setUpdateChannel(channel) {
    return setUpdatePrefs({ channel: channel === 'beta' ? 'beta' : 'stable' });
}

/**
 * 检测当前版本是否为测试版
 */
function isBetaVersion(version) {
    return /-(beta|alpha|rc|dev)\b/i.test(version || '');
}

function buildUpdateAvailableMessage(version, isBeta) {
    return isBeta
        ? `发现测试版 v${version}，是否尝试？（备注：测试版本不稳定，不建议尝试）`
        : `最终版本 v${version} 更新了，是否尝试？`;
}

function shouldSuppressUpdateToast(isBeta, isManual) {
    if (isManual) return false;
    const prefs = getUpdatePrefs();
    return isBeta ? !prefs.notifyBeta : !prefs.notifyStable;
}

// ==================== 绿色版更新逻辑 ====================

/**
 * 从 GitHub Releases API 获取最新版本的 zip 下载链接
 */
async function fetchLatestZipUrl(allowPrerelease) {
    // 从 app-update.yml 读取 owner/repo 信息
    const appUpdateYml = path.join(process.resourcesPath || '', 'app-update.yml');
    let owner = 'golsaysea';
    let repo = 'videokit-Y';

    try {
        const yml = fs.readFileSync(appUpdateYml, 'utf-8');
        const ownerMatch = yml.match(/owner:\s*(.+)/);
        const repoMatch = yml.match(/repo:\s*(.+)/);
        if (ownerMatch) owner = ownerMatch[1].trim();
        if (repoMatch) repo = repoMatch[1].trim();
    } catch (e) {
        log(`[Updater-Portable] 无法解析 app-update.yml，使用默认 repo: ${owner}/${repo}`);
    }

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`;
    log(`[Updater-Portable] 查询 GitHub Releases: ${apiUrl}`);

    const releases = await httpGetJson(apiUrl);
    if (!Array.isArray(releases) || releases.length === 0) {
        throw new Error('未找到任何发布版本');
    }

    const currentVersion = app.getVersion();
    const candidates = [];

    // 过滤：选择合适的 release
    for (const release of releases) {
        if (release.draft) continue;

        const tagVersion = (release.tag_name || '').replace(/^v/, '');
        if (!tagVersion) continue;
        const releaseIsBeta = Boolean(release.prerelease || isBetaVersion(tagVersion));
        if (!allowPrerelease && releaseIsBeta) continue;

        // 比较版本号，只更新到更高版本
        if (compareVersions(tagVersion, currentVersion) <= 0) {
            continue;
        }

        // 查找 zip 资源（Windows zip）
        const zipAsset = (release.assets || []).find(a => {
            const name = a.name.toLowerCase();
            return name.endsWith('.zip') && (name.includes('setup') || name.includes('win'));
        });

        if (zipAsset) {
            candidates.push({
                version: tagVersion,
                zipUrl: zipAsset.browser_download_url,
                zipSize: zipAsset.size,
                releaseNotes: release.body || '',
                isBeta: releaseIsBeta,
            });
        }
    }

    if (candidates.length > 0) {
        candidates.sort((a, b) => compareVersions(b.version, a.version));
        return candidates[0];
    }

    return null; // 没有新版本
}

/**
 * 简单版本比较 (1.2.3 vs 1.2.4)
 * 返回: >0 表示 a>b, <0 表示 a<b, 0 表示相等
 */
function compareVersions(a, b) {
    const [baseA, preA = ''] = String(a || '').split('-', 2);
    const [baseB, preB = ''] = String(b || '').split('-', 2);
    const pa = baseA.split('.').map(Number);
    const pb = baseB.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return na - nb;
    }
    const aHasPre = Boolean(preA);
    const bHasPre = Boolean(preB);
    if (aHasPre && !bHasPre) return -1;
    if (!aHasPre && bHasPre) return 1;
    if (aHasPre && bHasPre) {
        const partsA = preA.split(/[.-]/);
        const partsB = preB.split(/[.-]/);
        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
            const sa = partsA[i] ?? '';
            const sb = partsB[i] ?? '';
            const na = Number(sa);
            const nb = Number(sb);
            if (!Number.isNaN(na) && !Number.isNaN(nb)) {
                if (na !== nb) return na - nb;
            } else if (sa !== sb) {
                return sa.localeCompare(sb);
            }
        }
    }
    return 0;
}

/**
 * 下载文件到本地
 */
function downloadFile(url, destPath, onProgress, redirects = 0) {
    let parsed;
    try { parsed = new URL(url); } catch { return Promise.reject(new Error('更新下载地址无效')); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || redirects > 10) {
        return Promise.reject(new Error('更新下载必须使用 HTTPS，且重定向不能超过 10 次'));
    }
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const request = https.get(url, { headers: { 'User-Agent': 'VideoKit-Updater' } }, (response) => {
            // 处理重定向
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                file.close();
                fs.unlinkSync(destPath);
                response.resume();
                let nextUrl;
                try { nextUrl = new URL(response.headers.location, url).href; } catch { return reject(new Error('更新重定向地址无效')); }
                return downloadFile(nextUrl, destPath, onProgress, redirects + 1).then(resolve).catch(reject);
            }

            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(destPath);
                return reject(new Error(`下载失败: HTTP ${response.statusCode}`));
            }

            const totalSize = parseInt(response.headers['content-length'] || '0', 10);
            let downloaded = 0;

            response.on('data', (chunk) => {
                downloaded += chunk.length;
                if (onProgress && totalSize > 0) {
                    onProgress(Math.round(downloaded / totalSize * 100), downloaded, totalSize);
                }
            });

            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve(destPath);
            });
        });

        file.on('error', (err) => { request.destroy(); reject(err); });
        request.on('error', (err) => {
            file.close();
            try { fs.unlinkSync(destPath); } catch (_) {}
            reject(err);
        });

        request.setTimeout(120000, () => {
            request.destroy();
            reject(new Error('下载超时'));
        });
    });
}

/**
 * HTTPS GET JSON
 */
function httpGetJson(url, redirects = 0) {
    let parsed;
    try { parsed = new URL(url); } catch { return Promise.reject(new Error('更新元数据地址无效')); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || redirects > 10) {
        return Promise.reject(new Error('更新元数据请求必须使用 HTTPS，且重定向不能超过 10 次'));
    }
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'VideoKit-Updater', 'Accept': 'application/vnd.github.v3+json' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                let nextUrl;
                try { nextUrl = new URL(res.headers.location, url).href; } catch { return reject(new Error('更新元数据重定向地址无效')); }
                return httpGetJson(nextUrl, redirects + 1).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

/**
 * 绿色版更新：下载 zip → 解压到当前目录 → 重启
 */
async function portableUpdate(info) {
    const { version, zipUrl } = info;
    const tmpDir = path.join(_portableDir, '.update-tmp');

    try {
        // 确保临时目录存在
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }

        const zipPath = path.join(tmpDir, `VideoKit-${version}.zip`);

        log(`[Updater-Portable] 开始下载 zip: ${zipUrl}`);
        sendToRenderer('update-status', { status: 'downloading', message: '绿色版更新下载中...', percent: 0 });

        // 下载 zip
        await downloadFile(zipUrl, zipPath, (percent, downloaded, total) => {
            sendToRenderer('update-status', {
                status: 'downloading',
                message: `下载中... ${percent}%`,
                percent,
                transferred: downloaded,
                total,
            });
        });

        log(`[Updater-Portable] 下载完成，开始解压到: ${_portableDir}`);
        sendToRenderer('update-status', { status: 'downloading', message: '解压更新文件中...', percent: 100 });

        // 解压覆盖当前目录（Windows 下若运行中的 exe/dll/asar 被锁，自动降级解压至暂存目录并在退出后覆盖）
        const extract = require('./services/safeExtract');
        _pendingPortableStagingDir = '';
        try {
            if (process.platform === 'win32') throw new Error('Windows 更新使用退出后覆盖');
            await extract(zipPath, { dir: _portableDir });
            log(`[Updater-Portable] 解压完成 v${version}`);
        } catch (extractErr) {
            if (process.platform === 'win32') {
                const stagingDir = path.join(_portableDir, '.update-staging');
                log(`[Updater-Portable] 直接覆盖遇到文件占用 (${extractErr.message})，改用暂存目录解压: ${stagingDir}`);
                try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
                fs.mkdirSync(stagingDir, { recursive: true });
                await extract(zipPath, { dir: stagingDir });
                _pendingPortableStagingDir = stagingDir;
                log(`[Updater-Portable] 暂存解压完成 v${version}，将在退出后自动替换并重启`);
            } else {
                throw extractErr;
            }
        }

        // 清理临时文件
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {
            log(`[Updater-Portable] 清理临时文件失败（不影响更新）: ${e.message}`);
        }

        sendToRenderer('update-status', {
            status: 'downloaded',
            message: `v${version} 已更新完成，重启即可使用`,
            version,
        });

        // 不再弹出阻塞式重启提示窗，由渲染层右上角更新提醒卡片引导用户重启
    } catch (err) {
        log(`[Updater-Portable] 更新失败: ${err.message}`);
        sendToRenderer('update-status', {
            status: 'error',
            message: `绿色版更新失败: ${err.message}`,
        });

        // 清理临时目录
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

        throw err;
    }
}

/**
 * 绿色版检查更新
 */
async function portableCheckForUpdates(options = {}) {
    const isManual = Boolean(options && options.manual);
    try {
        const prefs = getUpdatePrefs();
        sendToRenderer('update-status', { status: 'checking', message: '正在检查更新...', manual: isManual });

        const info = await fetchLatestZipUrl(Boolean(prefs.notifyBeta));

        if (!info) {
            log('[Updater-Portable] 当前已是最新版本');
            sendToRenderer('update-status', { status: 'up-to-date', message: '当前已是最新版本', manual: isManual });
            return { success: true, version: null };
        }

        const isBeta = Boolean(info.isBeta);
        const channelLabel = isBeta ? '🧪 测试版' : '✅ 正式版';
        const availableMsg = buildUpdateAvailableMessage(info.version, isBeta);
        const notifySuppressed = shouldSuppressUpdateToast(isBeta, isManual);
        log(`[Updater-Portable] 发现新版本: v${info.version} (${channelLabel}, suppressed=${notifySuppressed})`);

        _pendingPortableUpdate = info;

        sendToRenderer('update-status', {
            status: 'available',
            message: availableMsg,
            version: info.version,
            isBeta,
            manual: isManual,
            notifySuppressed,
            zipSize: info.zipSize || 0,
            releaseNotes: info.releaseNotes,
        });

        // 不再弹出阻塞式更新询问框，由渲染层右上角更新提醒卡片非阻塞提示

        return { success: true, version: info.version, isBeta };
    } catch (err) {
        log(`[Updater-Portable] 检查更新失败: ${err.message}`);
        sendToRenderer('update-status', { status: 'error', message: `更新检查失败: ${err.message}`, manual: isManual });
        return { success: false, error: err.message };
    }
}

// ==================== 主初始化 ====================

function _buildUpdatePrefsPayload() {
    const prefs = getUpdatePrefs();
    const ver = app.getVersion();
    return {
        ...prefs,
        currentVersion: ver,
        isBeta: isBetaVersion(ver),
        isPortable: _isPortable,
    };
}

function initAutoUpdater(win, logFn) {
    mainWindow = win;
    if (logFn) log = logFn;

    // 偏好读写始终可用（含开发/预览模式）
    ipcMain.handle('get-update-channel', () => _buildUpdatePrefsPayload());
    ipcMain.handle('get-update-prefs', () => _buildUpdatePrefsPayload());
    ipcMain.handle('set-update-channel', (event, ch) => {
        setUpdateChannel(ch);
        return { success: true, ..._buildUpdatePrefsPayload() };
    });
    ipcMain.handle('set-update-prefs', (event, prefs) => {
        setUpdatePrefs(prefs || {});
        return { success: true, ..._buildUpdatePrefsPayload() };
    });

    if (!autoUpdater) {
        log('[Updater] autoUpdater 不可用（开发模式），跳过自动更新检查初始化');
        return;
    }

    const appUpdateYml = path.join(process.resourcesPath || '', 'app-update.yml');
    if (!fs.existsSync(appUpdateYml)) {
        log('[Updater] 未检测到 app-update.yml，跳过自动更新初始化');
        return;
    }

    // 检测绿色版
    _isPortable = detectPortableMode();
    _portableDir = path.dirname(process.execPath);
    log(`[Updater] 运行模式: ${_isPortable ? '绿色版 (portable)' : '安装版 (NSIS)'}, 目录: ${_portableDir}`);

    // 读取用户通道与提醒偏好
    const initPrefs = getUpdatePrefs();

    if (_isPortable) {
        // ═══════════════ 绿色版：自定义更新流程 ═══════════════
        log(`[Updater-Portable] 初始化绿色版更新 — 通道: ${initPrefs.channel}, 正式版提醒: ${initPrefs.notifyStable}, 测试版提醒: ${initPrefs.notifyBeta}`);

        // IPC: 手动检查更新
        ipcMain.handle('check-for-updates', async (_event, opts) => {
            const isManual = opts && typeof opts.manual === 'boolean' ? opts.manual : true;
            return portableCheckForUpdates({ manual: isManual });
        });

        // IPC: 手动下载更新（绿色版下载 + 解压一体化）
        ipcMain.handle('download-update', async () => {
            if (!_pendingPortableUpdate) {
                return { success: false, error: '没有待下载的更新' };
            }
            try {
                await portableUpdate(_pendingPortableUpdate);
                return { success: true };
            } catch (err) {
                return { success: false, error: err.message };
            }
        });

        // IPC: 安装更新并重启（绿色版直接重启）
        ipcMain.handle('install-update', async () => {
            try {
                await prepareForUpdateRestart();
                launchPortableRestart();
                return { success: true };
            } catch (error) {
                return { success: false, error: error?.message || String(error) };
            }
        });

        // 启动后延迟 8 秒自动检查（当开启任意提醒开关时触发）
        setTimeout(() => {
            const curPrefs = getUpdatePrefs();
            if (!curPrefs.notifyStable && !curPrefs.notifyBeta) {
                log('[Updater-Portable] 已关闭正式版与测试版自动更新提醒，跳过启动检查');
                return;
            }
            log('[Updater-Portable] 自动检查更新...');
            portableCheckForUpdates({ manual: false }).catch(err => {
                log(`[Updater-Portable] 自动检查失败: ${err.message}`);
            });
        }, 8000);

        log('[Updater-Portable] 绿色版更新模块已初始化');
        return;
    }

    // ═══════════════ 安装版：标准 electron-updater 流程 ═══════════════

    let _currentCheckIsManual = false;

    // 配置
    autoUpdater.autoDownload = false;           // 不自动下载，先提示用户
    autoUpdater.autoInstallOnAppQuit = true;    // 退出时自动安装
    _applyChannelToAutoUpdater(initPrefs);

    log(`[Updater] 初始化 — 通道: ${initPrefs.channel}, allowPrerelease: ${autoUpdater.allowPrerelease}, allowDowngrade: ${autoUpdater.allowDowngrade || false}, notifyStable: ${initPrefs.notifyStable}, notifyBeta: ${initPrefs.notifyBeta}`);

    // ==================== 事件监听 ====================

    autoUpdater.on('checking-for-update', () => {
        log('[Updater] 正在检查更新...');
        sendToRenderer('update-status', { status: 'checking', message: '正在检查更新...', manual: _currentCheckIsManual });
    });

    autoUpdater.on('update-available', (info) => {
        const isBeta = isBetaVersion(info.version);
        const isManual = _currentCheckIsManual;
        _currentCheckIsManual = false;
        const channelLabel = isBeta ? '🧪 测试版' : '✅ 正式版';
        const availableMsg = buildUpdateAvailableMessage(info.version, isBeta);
        const notifySuppressed = shouldSuppressUpdateToast(isBeta, isManual);
        log(`[Updater] 发现新版本: v${info.version} (${channelLabel}, suppressed=${notifySuppressed})`);

        // 兼容处理不同格式的 releaseNotes (string / Array)
        let notesText = '无更新说明';
        if (info.releaseNotes) {
            if (typeof info.releaseNotes === 'string') {
                notesText = info.releaseNotes;
            } else if (Array.isArray(info.releaseNotes)) {
                notesText = info.releaseNotes.map(n => {
                    if (typeof n === 'string') return n;
                    if (n && typeof n === 'object') {
                        return n.note || '';
                    }
                    return String(n);
                }).filter(Boolean).join('\n\n');
            } else {
                notesText = String(info.releaseNotes);
            }
        }

        sendToRenderer('update-status', {
            status: 'available',
            message: availableMsg,
            version: info.version,
            isBeta,
            manual: isManual,
            notifySuppressed,
            releaseNotes: notesText,
            releaseDate: info.releaseDate || '',
        });

        // 不再弹出阻塞式更新询问框，由渲染层右上角更新提醒卡片非阻塞引导下载
    });

    autoUpdater.on('update-not-available', () => {
        const isManual = _currentCheckIsManual;
        _currentCheckIsManual = false;
        log('[Updater] 当前已是最新版本');
        sendToRenderer('update-status', { status: 'up-to-date', message: '当前已是最新版本', manual: isManual });
    });

    autoUpdater.on('download-progress', (progress) => {
        const percent = Math.round(progress.percent);
        log(`[Updater] 下载进度: ${percent}%`);
        sendToRenderer('update-status', {
            status: 'downloading',
            message: `下载更新中... ${percent}%`,
            percent,
            bytesPerSecond: progress.bytesPerSecond,
            transferred: progress.transferred,
            total: progress.total,
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        const isBeta = isBetaVersion(info.version);
        log(`[Updater] 更新下载完成: v${info.version}`);
        sendToRenderer('update-status', {
            status: 'downloaded',
            message: `v${info.version} 已下载完成，重启即可安装`,
            version: info.version,
            isBeta,
        });

        // 不再弹出阻塞式重启提示窗，由渲染层右上角更新提醒卡片引导重启
    });

    autoUpdater.on('error', (error) => {
        const isManual = _currentCheckIsManual;
        _currentCheckIsManual = false;
        log(`[Updater] 更新错误: ${error.message}`);
        sendToRenderer('update-status', {
            status: 'error',
            message: `更新检查失败: ${error.message}`,
            manual: isManual,
        });
    });

    // ==================== IPC 接口 ====================

    // 手动检查更新
    ipcMain.handle('check-for-updates', async (_event, opts) => {
        _currentCheckIsManual = opts && typeof opts.manual === 'boolean' ? opts.manual : true;
        try {
            const result = await autoUpdater.checkForUpdates();
            return { success: true, version: result?.updateInfo?.version };
        } catch (error) {
            _currentCheckIsManual = false;
            return { success: false, error: error.message };
        }
    });

    // 手动下载更新
    ipcMain.handle('download-update', async () => {
        try {
            await autoUpdater.downloadUpdate();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 安装更新并重启
    ipcMain.handle('install-update', async () => {
        try {
            await prepareForUpdateRestart();
            autoUpdater.quitAndInstall(false, true);
            return { success: true };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    // 启动后延迟 5 秒自动检查更新（当开启任意提醒开关时触发）
    setTimeout(() => {
        const curPrefs = getUpdatePrefs();
        if (!curPrefs.notifyStable && !curPrefs.notifyBeta) {
            log('[Updater] 已关闭正式版与测试版自动更新提醒，跳过启动检查');
            return;
        }
        log('[Updater] 自动检查更新...');
        _currentCheckIsManual = false;
        autoUpdater.checkForUpdates().catch(err => {
            _currentCheckIsManual = false;
            log(`[Updater] 自动检查失败: ${err.message}`);
        });
    }, 5000);

    log('[Updater] 自动更新模块已初始化');
}

function sendToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

module.exports = { initAutoUpdater };
