const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_FILE_NAME = '.videokit-code-cache-state.json';
const BOOT_PENDING_FILE_NAME = '.videokit-renderer-boot-pending.json';
const BACKUP_PREFIX = 'Code Cache.before-videokit-repair-';

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

    fs.renameSync(cacheDir, backupPath);

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

    try {
        if (hadIncompleteBoot) {
            fs.rmSync(bootPendingFile, { force: true });
        }
    } catch (_) {}

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
    rotateCodeCacheDir,
    ensureFreshCodeCacheOnStartup,
    markRendererBootPending,
    markRendererBootComplete,
};
