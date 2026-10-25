const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let originalFs = fs;
try {
    // In Electron, require('fs') treats app.asar as a virtual directory.
    // original-fs stats the actual .asar archive file on disk.
    originalFs = require('original-fs');
} catch (_) {
    originalFs = fs;
}

const STATE_FILE_NAME = '.videokit-code-cache-state.json';
const BOOT_PENDING_FILE_NAME = '.videokit-renderer-boot-pending.json';
const BACKUP_PREFIX = 'Code Cache.before-videokit-repair-';
const AUX_GPU_CACHE_DIRS = ['GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache'];

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (_) {}
}

function formatTimestamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
        `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    );
}

function getBundleSignature(appPath) {
    if (!appPath) return '';
    try {
        // When packaged with asar, appPath points to .../resources/app.asar
        if (originalFs && typeof originalFs.existsSync === 'function' && originalFs.existsSync(appPath)) {
            const rawStat = originalFs.statSync(appPath);
            if (rawStat.isFile()) {
                return `asar:${rawStat.size}:${Math.trunc(rawStat.mtimeMs)}`;
            }
        }
        if (fs.existsSync(appPath)) {
            const stat = fs.statSync(appPath);
            if (stat.isFile()) {
                return `asar:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
            }
            const distIndex = path.join(appPath, 'dist', 'index.html');
            if (fs.existsSync(distIndex)) {
                const idxStat = fs.statSync(distIndex);
                return `dist:${idxStat.size}:${Math.trunc(idxStat.mtimeMs)}`;
            }
        }
    } catch (_) {
        // Ignore stat errors on virtual paths
    }
    return '';
}

function clearAuxiliaryGpuCaches(rootDir, log = () => {}) {
    if (!rootDir || typeof rootDir !== 'string') return;
    const root = path.resolve(rootDir);
    for (const dirName of AUX_GPU_CACHE_DIRS) {
        const target = path.resolve(root, dirName);
        if (path.dirname(target).toLowerCase() !== root.toLowerCase()) continue;
        try {
            if (!fs.existsSync(target)) continue;
            const lstat = fs.lstatSync(target);
            if (lstat.isSymbolicLink() || !lstat.isDirectory()) continue;
            fs.rmSync(target, { recursive: true, force: true });
        } catch (err) {
            log(`[CodeCacheGuard] 清理辅助着色器缓存跳过 (${dirName}): ${err.message}`);
        }
    }
}

function pruneOldCodeCacheBackups(rootDir, maxBackups = 2) {
    try {
        const entries = fs.readdirSync(rootDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name.startsWith(BACKUP_PREFIX))
            .map((d) => {
                const fullPath = path.join(rootDir, d.name);
                let mtimeMs = 0;
                try {
                    mtimeMs = fs.statSync(fullPath).mtimeMs;
                } catch (_) {}
                return { name: d.name, fullPath, mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        for (const oldEntry of entries.slice(maxBackups)) {
            try {
                fs.rmSync(oldEntry.fullPath, { recursive: true, force: true });
            } catch (_) {}
        }
    } catch (_) {}
}

/**
 * Safely backs up and resets `<userDataDir>/Code Cache` by renaming it to
 * `Code Cache.before-videokit-repair-<timestamp>-<id>`, matching the exact
 * non-destructive behavior of `VideoKit_白屏修复_保留工程.bat`.
 * Never modifies Local Storage, presets, templates, or project files.
 */
function rotateCodeCacheDir(userDataDir, options = {}) {
    if (!userDataDir || typeof userDataDir !== 'string') {
        return { rotated: false, reason: 'invalid-user-data-dir' };
    }
    const root = path.resolve(userDataDir);
    const cacheDir = path.resolve(root, 'Code Cache');

    if (path.dirname(cacheDir).toLowerCase() !== root.toLowerCase()) {
        throw new Error('缓存路径校验失败，已停止。');
    }

    if (!fs.existsSync(cacheDir)) {
        return { rotated: false, reason: 'not-found', cacheDir };
    }

    const lstat = fs.lstatSync(cacheDir);
    if (lstat.isSymbolicLink()) {
        throw new Error(`代码缓存目录是链接，已停止以免操作错误位置：${cacheDir}`);
    }
    if (!lstat.isDirectory()) {
        return { rotated: false, reason: 'not-directory', cacheDir };
    }

    const suffix = `${formatTimestamp()}-${crypto.randomBytes(3).toString('hex')}`;
    const backupName = `${BACKUP_PREFIX}${suffix}`;
    const backupPath = path.join(root, backupName);

    let renamed = false;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.renameSync(cacheDir, backupPath);
            renamed = true;
            break;
        } catch (err) {
            lastErr = err;
            if (attempt === 0) {
                sleepSync(150);
            }
        }
    }

    if (renamed) {
        const maxBackups = Number.isFinite(options.maxBackups) ? options.maxBackups : 2;
        if (maxBackups >= 1) {
            pruneOldCodeCacheBackups(root, maxBackups);
        }
        return {
            rotated: true,
            reason: options.reason || 'manual',
            cacheDir,
            backupName,
            backupPath,
        };
    }

    // Fallback on Windows when the top-level 'Code Cache' directory handle is briefly held:
    // purge unlocked inner bytecode directories ('js', 'wasm', 'webui_js') in-place.
    try {
        const innerEntries = fs.readdirSync(cacheDir);
        let remainingFiles = 0;
        for (const entryName of innerEntries) {
            const entryPath = path.join(cacheDir, entryName);
            try {
                fs.rmSync(entryPath, { recursive: true, force: true });
            } catch (_) {}
            if (fs.existsSync(entryPath)) {
                try {
                    const st = fs.statSync(entryPath);
                    if (st.isDirectory()) {
                        remainingFiles += fs.readdirSync(entryPath).length;
                    } else {
                        remainingFiles += 1;
                    }
                } catch (_) {
                    remainingFiles += 1;
                }
            }
        }
        if (remainingFiles === 0) {
            return {
                rotated: true,
                clearedInPlace: true,
                reason: options.reason || 'manual',
                cacheDir,
                backupName: '(cleared-in-place)',
                backupPath: cacheDir,
            };
        }
    } catch (_) {}

    if (lastErr) {
        throw lastErr;
    }
    return { rotated: false, reason: 'locked', cacheDir };
}

/**
 * Checks whether the app version, Electron/Chromium runtime, bundle signature,
 * or previous startup state requires rotating `Code Cache` before Chromium
 * opens the profile directory.
 */
function ensureFreshCodeCacheOnStartup({
    userDataDir,
    appVersion = '',
    appPath = '',
    electronVersion = process.versions.electron || '',
    chromeVersion = process.versions.chrome || '',
    isPackaged = false,
    log = () => {},
} = {}) {
    if (!userDataDir) return { rotated: false, reason: 'no-user-data' };

    const root = path.resolve(userDataDir);
    const stateFile = path.join(root, STATE_FILE_NAME);
    const bootPendingFile = path.join(root, BOOT_PENDING_FILE_NAME);
    const cacheDir = path.join(root, 'Code Cache');

    const currentFingerprint = {
        appVersion: String(appVersion || ''),
        electronVersion: String(electronVersion || ''),
        chromeVersion: String(chromeVersion || ''),
        isPackaged: Boolean(isPackaged),
        bundleSignature: getBundleSignature(appPath),
    };

    let prevState = null;
    try {
        if (fs.existsSync(stateFile)) {
            prevState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        }
    } catch (_) {
        prevState = null;
    }

    const hadIncompleteBoot = fs.existsSync(bootPendingFile);
    const hasExistingCodeCache = fs.existsSync(cacheDir);

    let rotationReason = '';
    if (hadIncompleteBoot) {
        rotationReason = 'previous-boot-incomplete';
    } else if (!prevState) {
        if (hasExistingCodeCache) {
            rotationReason = 'first-tracked-upgrade';
        }
    } else if (
        prevState.appVersion !== currentFingerprint.appVersion ||
        prevState.electronVersion !== currentFingerprint.electronVersion ||
        prevState.chromeVersion !== currentFingerprint.chromeVersion ||
        (currentFingerprint.bundleSignature &&
            prevState.bundleSignature &&
            prevState.bundleSignature !== currentFingerprint.bundleSignature)
    ) {
        rotationReason = `version-or-bundle-changed(${prevState.appVersion || 'unknown'}->${currentFingerprint.appVersion})`;
    }

    let rotationResult = { rotated: false, reason: rotationReason || 'up-to-date' };
    if (rotationReason) {
        clearAuxiliaryGpuCaches(root, log);
    }
    if (rotationReason && hasExistingCodeCache) {
        try {
            rotationResult = rotateCodeCacheDir(root, { reason: rotationReason });
            if (rotationResult.rotated) {
                log(`[CodeCacheGuard] 已自动备份并重建 Code Cache (${rotationReason}): ${rotationResult.backupPath}`);
            }
        } catch (err) {
            log(`[CodeCacheGuard] 旋转 Code Cache 失败 (${rotationReason}): ${err.message}`);
            rotationResult = { rotated: false, reason: rotationReason, error: err.message };
        }
    }

    const rotationFailedWithExistingCache = Boolean(rotationReason && hasExistingCodeCache && !rotationResult.rotated);

    try {
        if (hadIncompleteBoot && !rotationFailedWithExistingCache) {
            fs.rmSync(bootPendingFile, { force: true });
        }
    } catch (_) {}

    // Only mark currentFingerprint as up-to-date in stateFile if rotation was not needed
    // or succeeded. If rotation failed (e.g. EPERM lock), preserve previous state so next boot retries.
    if (!rotationFailedWithExistingCache) {
        try {
            fs.mkdirSync(root, { recursive: true });
            fs.writeFileSync(
                stateFile,
                JSON.stringify(
                    {
                        ...currentFingerprint,
                        updatedAt: new Date().toISOString(),
                        lastRotationReason: rotationResult.rotated ? rotationReason : (prevState?.lastRotationReason || ''),
                        lastBackupName: rotationResult.rotated ? rotationResult.backupName : (prevState?.lastBackupName || ''),
                    },
                    null,
                    2
                ),
                'utf8'
            );
        } catch (err) {
            log(`[CodeCacheGuard] 写入状态文件失败: ${err.message}`);
        }
    }

    return {
        ...rotationResult,
        needsSessionCacheClear: Boolean(rotationReason),
    };
}

function markRendererBootPending(userDataDir, meta = {}) {
    if (!userDataDir) return;
    try {
        const root = path.resolve(userDataDir);
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(
            path.join(root, BOOT_PENDING_FILE_NAME),
            JSON.stringify({ startedAt: new Date().toISOString(), ...meta }),
            'utf8'
        );
    } catch (_) {}
}

function markRendererBootComplete(userDataDir) {
    if (!userDataDir) return;
    try {
        const bootPendingFile = path.join(path.resolve(userDataDir), BOOT_PENDING_FILE_NAME);
        if (fs.existsSync(bootPendingFile)) {
            fs.rmSync(bootPendingFile, { force: true });
        }
    } catch (_) {}
}

module.exports = {
    STATE_FILE_NAME,
    BOOT_PENDING_FILE_NAME,
    BACKUP_PREFIX,
    AUX_GPU_CACHE_DIRS,
    clearAuxiliaryGpuCaches,
    rotateCodeCacheDir,
    ensureFreshCodeCacheOnStartup,
    markRendererBootPending,
    markRendererBootComplete,
};
