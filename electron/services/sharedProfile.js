/**
 * Shared profile, preset, and workspace unification across Installed, Dev, and
 * Portable (Green) builds of VideoKit.
 *
 * Ensures that even when running as a portable/green copy (with or without
 * `portable.flag`), VideoKit seamlessly reads and synchronizes presets,
 * templates, and batch workspaces with the installed version.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function getAppUserDataDir() {
    try {
        const { app } = require('electron');
        if (app && typeof app.getPath === 'function') {
            return app.getPath('userData');
        }
    } catch (_) { }
    return '';
}

/**
 * Unit/integration check scripts point `userData` at a temporary directory
 * inside `os.tmpdir()`. Keep those test runs isolated from the user's real
 * installed profile.
 */
function isIsolatedTestProfile(customDir = '') {
    if (process.env.VIDEOKIT_TEST_PROFILE === '1') return true;
    const target = customDir || getAppUserDataDir();
    if (!target) return false;
    try {
        const normalizedTarget = path.resolve(target).toLowerCase();
        const normalizedTmp = path.resolve(os.tmpdir()).toLowerCase();
        return normalizedTarget === normalizedTmp || normalizedTarget.startsWith(normalizedTmp + path.sep);
    } catch (_) {
        return false;
    }
}

function getStandardInstalledUserDataDir() {
    const home = os.homedir();
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'videokit');
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'videokit');
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'videokit');
}

function getHomeDotVideokitDir() {
    return path.join(os.homedir(), '.videokit');
}

function getPortableDataDir() {
    try {
        const execDir = path.dirname(process.execPath || '');
        if (!execDir) return '';
        const flagPath = path.join(execDir, 'portable.flag');
        const dataDir = path.join(execDir, 'portable-data');
        if (fs.existsSync(flagPath) || fs.existsSync(dataDir)) {
            return dataDir;
        }
    } catch (_) { }
    return '';
}

function uniqueNormalizedPaths(paths) {
    const seen = new Set();
    const result = [];
    for (const p of paths) {
        if (!p || typeof p !== 'string') continue;
        try {
            const resolved = path.resolve(p);
            const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
            if (!seen.has(key)) {
                seen.add(key);
                result.push(resolved);
            }
        } catch (_) { }
    }
    return result;
}

/**
 * Primary shared profile root:
 * Always prefers the standard installed userData directory (`%APPDATA%/videokit`)
 * on normal runs so that portable/green/dev builds save projects, workspaces,
 * and queues directly into the installed directory for seamless sharing.
 */
function getPrimarySharedProfileDir() {
    const currentUserData = getAppUserDataDir();
    if (isIsolatedTestProfile(currentUserData)) {
        return currentUserData ? path.resolve(currentUserData) : '';
    }
    const installedDir = getStandardInstalledUserDataDir();
    if (installedDir) return path.resolve(installedDir);
    return currentUserData ? path.resolve(currentUserData) : getHomeDotVideokitDir();
}

/**
 * Candidate profile / userData roots for sharing presets, templates, and workspaces.
 * Primary active directory is listed first.
 */
function getCandidateProfileDirs() {
    const currentUserData = getAppUserDataDir();
    if (isIsolatedTestProfile(currentUserData)) {
        return currentUserData ? [path.resolve(currentUserData)] : [];
    }
    const portableDir = getPortableDataDir();
    const installedDir = getStandardInstalledUserDataDir();
    const homeDotDir = getHomeDotVideokitDir();
    return uniqueNormalizedPaths([
        installedDir,
        currentUserData,
        portableDir,
        homeDotDir,
    ]);
}

function getCandidatePresetDirs() {
    return getCandidateProfileDirs().map(dir => path.join(dir, 'videokit-presets'));
}

function getCandidateProjectDirs() {
    return uniqueNormalizedPaths([
        path.join(getPrimarySharedProfileDir(), 'projects'),
        ...getCandidateProfileDirs().map(dir => path.join(dir, 'projects')),
    ]);
}

function getCandidateQueueLibraryDirs() {
    return uniqueNormalizedPaths([
        path.join(getPrimarySharedProfileDir(), 'queue-library'),
        ...getCandidateProfileDirs().map(dir => path.join(dir, 'queue-library')),
    ]);
}

function getCandidateTemplateDirs() {
    const currentUserData = getAppUserDataDir();
    if (isIsolatedTestProfile(currentUserData)) {
        return currentUserData ? [path.join(path.resolve(currentUserData), 'videokit-templates')] : [];
    }
    return uniqueNormalizedPaths([
        path.join(getStandardInstalledUserDataDir(), 'videokit-templates'),
        currentUserData ? path.join(currentUserData, 'videokit-templates') : '',
        getPortableDataDir() ? path.join(getPortableDataDir(), 'videokit-templates') : '',
    ]);
}

// ─────────────────────────────────────────────────────────────────────────
// Pure-JS Chromium LevelDB reader (lock-free, read-only)
// Reads Local Storage keys from installed / portable userData even while
// another VideoKit instance holds the LevelDB LOCK.
// ─────────────────────────────────────────────────────────────────────────

function _readVarint(buf, pos) {
    let res = 0;
    let shift = 0;
    while (pos < buf.length) {
        const b = buf[pos++];
        res += (b & 0x7f) * Math.pow(2, shift);
        if (!(b & 0x80)) return [res, pos];
        shift += 7;
        if (shift > 53) break;
    }
    return [res, pos];
}

function _snappyUncompress(buf) {
    let [uncompLen, pos] = _readVarint(buf, 0);
    if (!Number.isFinite(uncompLen) || uncompLen < 0 || uncompLen > 64 * 1024 * 1024) {
        throw new Error('Invalid Snappy uncompressed length');
    }
    const out = Buffer.alloc(uncompLen);
    let outPos = 0;
    while (pos < buf.length && outPos < uncompLen) {
        const c = buf[pos++];
        const tag = c & 0x03;
        if (tag === 0) {
            let len = (c >>> 2) + 1;
            if (len > 60) {
                const extraBytes = len - 60;
                len = 0;
                for (let i = 0; i < extraBytes; i++) len |= buf[pos++] << (8 * i);
                len += 1;
            }
            buf.copy(out, outPos, pos, pos + len);
            pos += len;
            outPos += len;
        } else {
            let len;
            let offset;
            if (tag === 1) {
                len = ((c >>> 2) & 0x07) + 4;
                offset = ((c & 0xe0) << 3) | buf[pos++];
            } else if (tag === 2) {
                len = (c >>> 2) + 1;
                offset = buf.readUInt16LE(pos);
                pos += 2;
            } else {
                len = (c >>> 2) + 1;
                offset = buf.readUInt32LE(pos);
                pos += 4;
            }
            if (offset <= 0 || outPos - offset < 0) throw new Error('Invalid Snappy copy offset');
            for (let i = 0; i < len && outPos < uncompLen; i++) {
                out[outPos] = out[outPos - offset];
                outPos++;
            }
        }
    }
    return out;
}

function _decodeLocalStorageValue(valBuf) {
    if (!Buffer.isBuffer(valBuf) || valBuf.length === 0) return '';
    const prefix = valBuf[0];
    if (prefix === 0x00) {
        return valBuf.subarray(1).toString('utf16le');
    }
    if (prefix === 0x01) {
        return valBuf.subarray(1).toString('latin1');
    }
    return valBuf.toString('utf8');
}

function _parseLocalStorageKey(userKeyBuf) {
    if (!Buffer.isBuffer(userKeyBuf) || userKeyBuf.length < 3 || userKeyBuf[0] !== 0x5f) return null; // '_'
    const nulIdx = userKeyBuf.indexOf(0x00, 1);
    if (nulIdx === -1 || nulIdx + 1 >= userKeyBuf.length) return null;
    const origin = userKeyBuf.subarray(1, nulIdx).toString('utf8');
    const keyBuf = userKeyBuf.subarray(nulIdx + 1);
    const key = _decodeLocalStorageValue(keyBuf);
    if (!key) return null;
    return { origin, key };
}

function _readLdbFileEntries(filePath) {
    const entries = [];
    try {
        const buf = fs.readFileSync(filePath);
        if (buf.length < 48) return entries;
        const footer = buf.subarray(buf.length - 48);
        let [, p1] = _readVarint(footer, 0);
        let [, p2] = _readVarint(footer, p1);
        let [idxOffset, p3] = _readVarint(footer, p2);
        let [idxSize] = _readVarint(footer, p3);
        if (!Number.isFinite(idxOffset) || !Number.isFinite(idxSize) || idxOffset + idxSize + 5 > buf.length) {
            return entries;
        }
        const readBlock = (offset, size) => {
            if (offset < 0 || size < 0 || offset + size + 1 > buf.length) return null;
            const compressionType = buf[offset + size];
            const raw = buf.subarray(offset, offset + size);
            return compressionType === 1 ? _snappyUncompress(raw) : raw;
        };
        const parseDataBlock = (block) => {
            if (!block || block.length < 4) return [];
            const numRestarts = block.readUInt32LE(block.length - 4);
            const limit = block.length - 4 * (1 + numRestarts);
            if (limit <= 0 || limit > block.length) return [];
            let p = 0;
            let lastKey = Buffer.alloc(0);
            const blockEntries = [];
            while (p < limit) {
                let shared, nonShared, valLen;
                [shared, p] = _readVarint(block, p);
                [nonShared, p] = _readVarint(block, p);
                [valLen, p] = _readVarint(block, p);
                if (p + nonShared + valLen > limit) break;
                const keyDelta = block.subarray(p, p + nonShared);
                p += nonShared;
                const val = block.subarray(p, p + valLen);
                p += valLen;
                const fullInternalKey = Buffer.concat([lastKey.subarray(0, shared), keyDelta]);
                lastKey = fullInternalKey;
                if (fullInternalKey.length < 8) continue;
                const userKey = fullInternalKey.subarray(0, fullInternalKey.length - 8);
                const seqAndType = fullInternalKey.readBigUInt64LE(fullInternalKey.length - 8);
                const valueType = Number(seqAndType & 0xffn);
                const seq = Number(seqAndType >> 8n);
                blockEntries.push({ userKey, val, valueType, seq });
            }
            return blockEntries;
        };
        const idxBlock = readBlock(idxOffset, idxSize);
        for (const ie of parseDataBlock(idxBlock)) {
            let [bOff, bp1] = _readVarint(ie.val, 0);
            let [bSize] = _readVarint(ie.val, bp1);
            try {
                const dBlock = readBlock(bOff, bSize);
                entries.push(...parseDataBlock(dBlock));
            } catch (_) { }
        }
    } catch (_) { }
    return entries;
}

function _readLogFileEntries(filePath) {
    const entries = [];
    try {
        const buf = fs.readFileSync(filePath);
        const kBlockSize = 32768;
        const kHeaderSize = 7;
        let offset = 0;
        let current = [];
        const records = [];
        while (offset + kHeaderSize <= buf.length) {
            const blockRem = kBlockSize - (offset % kBlockSize);
            if (blockRem < kHeaderSize) {
                offset += blockRem;
                continue;
            }
            const len = buf.readUInt16LE(offset + 4);
            const type = buf[offset + 6];
            if ((len === 0 && type === 0) || type > 4 || offset + kHeaderSize + len > buf.length) {
                offset += blockRem;
                current = [];
                continue;
            }
            const frag = buf.subarray(offset + kHeaderSize, offset + kHeaderSize + len);
            offset += kHeaderSize + len;
            if (type === 1) {
                records.push(frag);
                current = [];
            } else if (type === 2) {
                current = [frag];
            } else if (type === 3 && current.length) {
                current.push(frag);
            } else if (type === 4 && current.length) {
                current.push(frag);
                records.push(Buffer.concat(current));
                current = [];
            }
        }
        for (const record of records) {
            if (record.length < 12) continue;
            const baseSeq = Number(record.readBigUInt64LE(0));
            const count = record.readUInt32LE(8);
            let p = 12;
            for (let i = 0; i < count && p < record.length; i++) {
                const valueType = record[p++];
                let kLen;
                [kLen, p] = _readVarint(record, p);
                if (p + kLen > record.length) break;
                const userKey = record.subarray(p, p + kLen);
                p += kLen;
                let val = Buffer.alloc(0);
                if (valueType === 1) {
                    let vLen;
                    [vLen, p] = _readVarint(record, p);
                    if (p + vLen > record.length) break;
                    val = record.subarray(p, p + vLen);
                    p += vLen;
                }
                entries.push({ userKey, val, valueType, seq: baseSeq + i });
            }
        }
    } catch (_) { }
    return entries;
}

const _leveldbCache = new Map();

/**
 * Read Chromium Local Storage records from `<userDataDir>/Local Storage/leveldb`.
 * Returns `{ byOrigin: { [origin]: { [key]: value } }, latestByKey: { [key]: { value, seq, origin } } }`.
 */
function readChromiumLocalStorage(userDataDir) {
    const result = { byOrigin: {}, latestByKey: {} };
    if (!userDataDir) return result;
    const cacheKey = path.resolve(userDataDir);
    if (_leveldbCache.has(cacheKey)) return _leveldbCache.get(cacheKey);
    const leveldbDir = path.join(userDataDir, 'Local Storage', 'leveldb');
    if (!fs.existsSync(leveldbDir)) {
        _leveldbCache.set(cacheKey, result);
        return result;
    }
    try {
        const files = fs.readdirSync(leveldbDir);
        const ldbFiles = files.filter(f => f.endsWith('.ldb')).sort();
        const logFiles = files.filter(f => f.endsWith('.log')).sort();
        const rawEntries = [];
        for (const f of ldbFiles) rawEntries.push(..._readLdbFileEntries(path.join(leveldbDir, f)));
        for (const f of logFiles) rawEntries.push(..._readLogFileEntries(path.join(leveldbDir, f)));
        rawEntries.sort((a, b) => (a.seq || 0) - (a.seq || 0));

        const stateByOriginKey = new Map();
        for (const entry of rawEntries) {
            const parsed = _parseLocalStorageKey(entry.userKey);
            if (!parsed) continue;
            const compound = `${parsed.origin}\x00${parsed.key}`;
            if (entry.valueType === 0) {
                stateByOriginKey.delete(compound);
            } else if (entry.valueType === 1) {
                stateByOriginKey.set(compound, {
                    origin: parsed.origin,
                    key: parsed.key,
                    value: _decodeLocalStorageValue(entry.val),
                    seq: entry.seq || 0,
                });
            }
        }

        for (const item of stateByOriginKey.values()) {
            if (!result.byOrigin[item.origin]) result.byOrigin[item.origin] = {};
            result.byOrigin[item.origin][item.key] = item.value;
            const prev = result.latestByKey[item.key];
            if (!prev || item.seq >= prev.seq) {
                result.latestByKey[item.key] = {
                    value: item.value,
                    seq: item.seq,
                    origin: item.origin,
                };
            }
        }
    } catch (_) { }
    _leveldbCache.set(cacheKey, result);
    return result;
}

/**
 * Count total tasks inside a batch workspace JSON object.
 */
function countWorkspaceTasks(data) {
    if (!data || typeof data !== 'object') return 0;
    if (Array.isArray(data.tabs)) {
        return data.tabs.reduce((sum, tab) => sum + (Array.isArray(tab?.tasks) ? tab.tasks.length : 0), 0);
    }
    if (Array.isArray(data.tasks)) return data.tasks.length;
    return 0;
}

/**
 * Convert a legacy v1 / ReelsProject `autosave.json` object into a v2.0 batch workspace.
 */
function convertLegacyAutosaveToWorkspace(data, fallbackTimeMs = 0) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.tasks) || data.tasks.length === 0) {
        return null;
    }
    const timestamp = data.timestamp || data.createdAt || data.savedAt || (fallbackTimeMs ? new Date(fallbackTimeMs).toISOString() : new Date().toISOString());
    return {
        timestamp,
        version: '2.0',
        activeTabId: 'tab_1',
        nextTabId: 2,
        projectDir: '',
        projectName: 'UntitledProject.json',
        uiState: data.style ? {
            globalSubtitleStyle: data.style,
        } : undefined,
        tabs: [
            {
                id: 'tab_1',
                name: '默认',
                materialDir: '',
                lastRefreshTime: timestamp,
                tasks: data.tasks,
            },
        ],
    };
}

/**
 * Read the most up-to-date batch workspace across all shared profile directories
 * AND installed/portable Chromium Local Storage (`reels_batch_config_autosave`).
 */
function readUnifiedBatchWorkspace() {
    const candidates = [];
    const addCandidate = (raw, source, fallbackTimeMs = 0, priorityBoost = 0) => {
        if (!raw || typeof raw !== 'string') return;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return;
            let workspace = null;
            let normalizedRaw = raw;
            if (parsed.version === '2.0' && Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
                workspace = parsed;
            } else if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
                workspace = convertLegacyAutosaveToWorkspace(parsed, fallbackTimeMs);
                if (workspace) normalizedRaw = JSON.stringify(workspace);
            }
            if (!workspace) return;
            const taskCount = countWorkspaceTasks(workspace);
            const parsedTime = Date.parse(workspace.timestamp || workspace.createdAt || '');
            const timeMs = Number.isFinite(parsedTime) ? parsedTime : fallbackTimeMs;
            candidates.push({
                raw: normalizedRaw,
                workspace,
                source,
                taskCount,
                timeMs: timeMs || 0,
                priorityBoost,
            });
        } catch (_) { }
    };

    const profileDirs = getCandidateProfileDirs();
    for (const dir of profileDirs) {
        for (const name of ['workspace-autosave.json', 'UntitledProject.json']) {
            const file = path.join(dir, 'projects', name);
            try {
                if (fs.existsSync(file)) {
                    const stat = fs.statSync(file);
                    const rawText = fs.readFileSync(file, 'utf8');
                    addCandidate(rawText, file, stat.mtimeMs, 2);
                    // Also check the referenced active named project file if different
                    try {
                        const parsed = JSON.parse(rawText);
                        const refName = parsed?.projectName;
                        if (refName && refName !== 'workspace-autosave.json' && refName !== 'UntitledProject.json') {
                            const refFile = path.join(dir, 'projects', path.basename(refName));
                            if (fs.existsSync(refFile)) {
                                const refStat = fs.statSync(refFile);
                                addCandidate(fs.readFileSync(refFile, 'utf8'), refFile, refStat.mtimeMs, 2);
                            }
                        }
                    } catch (_) { }
                }
            } catch (_) { }
        }
    }

    // Only inspect Chromium Local Storage or legacy autosave.json when no disk
    // workspace-autosave.json with tasks exists yet (first-run migration).
    const hasDiskWorkspaceWithTasks = candidates.some(c => c.taskCount > 0 && c.priorityBoost >= 2);
    if (!isIsolatedTestProfile() && !hasDiskWorkspaceWithTasks) {
        for (const dir of profileDirs) {
            const leveldbDir = path.join(dir, 'Local Storage', 'leveldb');
            if (!fs.existsSync(leveldbDir)) continue;
            let newestMtime = 0;
            try {
                for (const f of fs.readdirSync(leveldbDir)) {
                    if (f.endsWith('.ldb') || f.endsWith('.log')) {
                        const st = fs.statSync(path.join(leveldbDir, f));
                        if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
                    }
                }
            } catch (_) { }
            const store = readChromiumLocalStorage(dir);
            for (const [origin, map] of Object.entries(store.byOrigin)) {
                if (map.reels_batch_config_autosave) {
                    addCandidate(map.reels_batch_config_autosave, `leveldb:${dir}:${origin}`, newestMtime, 1);
                }
            }
        }

        // Fallback: legacy ~/.videokit/autosave.json (only when no v2.0 multi-tab workspace has tasks)
        const hasMultiTabWithTasks = candidates.some(c => c.taskCount > 0 && c.priorityBoost >= 1);
        if (!hasMultiTabWithTasks) {
            for (const dir of profileDirs) {
                const autoSaveFile = path.join(dir, 'autosave.json');
                try {
                    if (fs.existsSync(autoSaveFile)) {
                        const stat = fs.statSync(autoSaveFile);
                        addCandidate(fs.readFileSync(autoSaveFile, 'utf8'), autoSaveFile, stat.mtimeMs, 0);
                    }
                } catch (_) { }
            }
        }
    }

    if (!candidates.length) return '';

    const nonEmpty = candidates.filter(c => c.taskCount > 0);
    const pool = nonEmpty.length > 0 ? nonEmpty : candidates;
    pool.sort((a, b) => {
        if (b.timeMs !== a.timeMs) return b.timeMs - a.timeMs;
        if (b.taskCount !== a.taskCount) return b.taskCount - a.taskCount;
        return b.priorityBoost - a.priorityBoost;
    });

    // If the best candidate is an explicitly cleared disk workspace (0 tasks) that is
    // at least as new as the newest non-empty workspace, respect the user's clear/delete action.
    if (nonEmpty.length > 0) {
        const newestOverall = [...candidates].sort((a, b) => b.timeMs - a.timeMs)[0];
        if (newestOverall && newestOverall.taskCount === 0 && newestOverall.priorityBoost >= 1 && newestOverall.timeMs >= pool[0].timeMs) {
            return newestOverall.raw;
        }
    }

    return pool[0].raw;
}

/**
 * If a file path inside one profile directory (e.g. `portable-data/videokit-presets/...`
 * or `%APPDATA%/videokit/videokit-presets/...`) does not exist at the given path,
 * check the same relative subpath across all other shared profile directories.
 */
function resolveSharedProfileFilePath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return inputPath;
    try {
        const resolved = path.resolve(inputPath);
        if (fs.existsSync(resolved)) return resolved;
        if (isIsolatedTestProfile()) return inputPath;

        const profileDirs = getCandidateProfileDirs();
        const normalizedInput = process.platform === 'win32' ? resolved.toLowerCase() : resolved;

        for (const baseDir of profileDirs) {
            const normalizedBase = process.platform === 'win32' ? baseDir.toLowerCase() : baseDir;
            if (normalizedInput.startsWith(normalizedBase + path.sep)) {
                const rel = resolved.slice(baseDir.length + 1);
                for (const otherDir of profileDirs) {
                    const candidate = path.join(otherDir, rel);
                    if (fs.existsSync(candidate)) return candidate;
                }
            }
        }

        // Also match by `videokit-presets/<subpath>`, `videokit-templates/<subpath>`,
        // `projects/<subpath>`, or `queue-library/<subpath>` even if moved.
        for (const marker of ['videokit-presets', 'videokit-templates', 'projects', 'queue-library']) {
            const regex = new RegExp(`(?:^|[\\\\/])${marker}[\\\\/](.+)$`, 'i');
            const match = resolved.match(regex);
            if (match && match[1]) {
                for (const otherDir of profileDirs) {
                    const candidate = path.join(otherDir, marker, match[1]);
                    if (fs.existsSync(candidate)) return candidate;
                }
            }
        }
    } catch (_) { }
    return inputPath;
}

module.exports = {
    getAppUserDataDir,
    isIsolatedTestProfile,
    getStandardInstalledUserDataDir,
    getPrimarySharedProfileDir,
    getHomeDotVideokitDir,
    getPortableDataDir,
    getCandidateProfileDirs,
    getCandidatePresetDirs,
    getCandidateProjectDirs,
    getCandidateQueueLibraryDirs,
    getCandidateTemplateDirs,
    readChromiumLocalStorage,
    countWorkspaceTasks,
    readUnifiedBatchWorkspace,
    resolveSharedProfileFilePath,
};
