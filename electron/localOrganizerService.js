const { assertTrustedRenderer } = require('./services/trustedRenderer');
const { app, dialog, shell, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

let resolveFFmpeg = null;
try {
    resolveFFmpeg = require('./services/ffmpeg').resolveCommand;
} catch (_) {}

function getFfmpegCommand() {
    if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
    if (typeof resolveFFmpeg === 'function') {
        const cmd = resolveFFmpeg('ffmpeg');
        if (cmd && fs.existsSync(cmd)) return cmd;
    }
    const isWin = process.platform === 'win32';
    const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : path.join(__dirname, '..');
    const resPath = process.resourcesPath || '';
    const candidates = isWin
        ? [
            path.join(appPath, 'vendor', 'windows', 'ffmpeg', 'bin', 'ffmpeg.exe'),
            path.join(appPath, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe'),
            path.join(resPath, 'vendor', 'windows', 'ffmpeg', 'bin', 'ffmpeg.exe'),
            path.join(resPath, 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe'),
            path.join(resPath, 'vendor', 'ffmpeg', 'ffmpeg.exe'),
            path.join(resPath, 'ffmpeg.exe'),
            path.join(appPath, 'bin', 'ffmpeg.exe')
        ]
        : [
            path.join(appPath, 'vendor', 'darwin', 'ffmpeg', 'ffmpeg'),
            path.join(appPath, 'vendor', 'ffmpeg', 'ffmpeg'),
            path.join(resPath, 'vendor', 'darwin', 'ffmpeg', 'ffmpeg'),
            path.join(resPath, 'vendor', 'ffmpeg', 'ffmpeg'),
            path.join(resPath, 'ffmpeg'),
            '/opt/homebrew/bin/ffmpeg',
            '/usr/local/bin/ffmpeg'
        ];
    return candidates.find(candidate => candidate && fs.existsSync(candidate)) || 'ffmpeg';
}

function runExecFile(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { windowsHide: true }, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

const SCAN_MIME_MAP = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
    '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.avif': 'image/avif',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/avi', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
    '.m4v': 'video/x-m4v', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t',
    '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip', '.rar': 'application/x-rar', '.7z': 'application/x-7z-compressed',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
    '.psd': 'image/vnd.adobe.photoshop', '.ai': 'application/postscript',
    '.txt': 'text/plain', '.md': 'text/markdown', '.rtf': 'application/rtf', '.csv': 'text/csv', '.json': 'application/json',
    '.srt': 'application/x-subrip', '.vtt': 'text/vtt',
};
const SCAN_MAX_FILES = 15000;

function getUniqueDestPath(targetDir, baseName) {
    let destPath = path.join(targetDir, baseName);
    if (!fs.existsSync(destPath)) return destPath;
    const ext = path.extname(baseName);
    const nameOnly = path.basename(baseName, ext);
    let counter = 1;
    while (fs.existsSync(destPath)) {
        destPath = path.join(targetDir, `${nameOnly} (${counter})${ext}`);
        counter++;
    }
    return destPath;
}

function validateFolderTransferPaths(srcDir, targetDir) {
    const sourcePath = path.resolve(srcDir);
    const targetPath = path.resolve(targetDir);
    if (sourcePath === targetPath) {
        throw new Error('目标文件夹不能与源文件夹相同');
    }
    if (targetPath.startsWith(sourcePath + path.sep)) {
        throw new Error('目标文件夹不能位于源文件夹内部，否则会产生递归复制');
    }
    return { sourcePath, targetPath };
}

// Folder merge is deliberately content-based: folders with the same name are
// opened and merged, while only name-clashing files receive a " (1)" suffix.
// This keeps a collection root tidy without ever overwriting an existing file.
function mergePathIsInside(childPath, parentPath) {
    const child = path.resolve(childPath);
    const parent = path.resolve(parentPath);
    return child === parent || child.startsWith(parent + path.sep);
}

function validateFolderMergePaths(targetRoot, sources) {
    const isFolderList = targetRoot && typeof targetRoot === 'object' && targetRoot.type === 'folders';
    const rawTargetPaths = isFolderList ? targetRoot.paths : [targetRoot];
    if (!Array.isArray(rawTargetPaths) || rawTargetPaths.length === 0) throw new Error('请先选择目标总文件夹或目标文件夹');
    const targetPaths = rawTargetPaths.map((target) => path.resolve(target || ''));
    for (const targetPath of targetPaths) {
        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
            throw new Error(`目标文件夹不存在或不是文件夹: ${targetPath || '未指定'}`);
        }
    }
    const targetNames = new Map();
    if (isFolderList) {
        for (const targetPath of targetPaths) {
            const name = path.basename(targetPath);
            if (targetNames.has(name)) throw new Error(`目标文件夹名称重复，无法判断应合并到哪一个: ${name}`);
            targetNames.set(name, targetPath);
        }
    }
    if (!Array.isArray(sources) || sources.length === 0) throw new Error('请至少添加一个待合并文件夹');
    const seen = new Set();
    const normalized = sources.map((source) => {
        const sourcePath = path.resolve(source?.path || '');
        if (!source?.path || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
            throw new Error(`来源文件夹不存在: ${source?.path || '未指定'}`);
        }
        for (const targetPath of targetPaths) {
            if (mergePathIsInside(sourcePath, targetPath) || mergePathIsInside(targetPath, sourcePath)) {
                throw new Error('目标文件夹不能与来源重叠或互相包含');
            }
        }
        if (seen.has(sourcePath)) throw new Error(`重复添加了来源文件夹: ${sourcePath}`);
        seen.add(sourcePath);
        return { path: sourcePath, type: source.type === 'root' ? 'root' : 'folder' };
    });
    return {
        target: isFolderList
            ? { type: 'folders', paths: targetPaths, byName: targetNames }
            : { type: 'root', path: targetPaths[0] },
        sources: normalized
    };
}

function uniqueMergePath(targetDir, name, reserved) {
    let candidate = path.join(targetDir, name);
    const exists = (candidatePath) => fs.existsSync(candidatePath) || reserved.has(candidatePath);
    if (!exists(candidate)) return candidate;
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let index = 1;
    do {
        candidate = path.join(targetDir, `${stem} (${index})${ext}`);
        index += 1;
    } while (exists(candidate));
    return candidate;
}

function executeFolderMerge(targetConfig, sourceEntries, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const mode = options.mode === 'copy' ? 'copy' : 'move';
    const reserved = new Map();
    const stats = { files: 0, mergedFolders: 0, createdFolders: 0, renamed: 0, samples: [] };
    const remember = (message) => { if (stats.samples.length < 30) stats.samples.push(message); };
    const exists = (targetPath) => fs.existsSync(targetPath) || reserved.has(targetPath);
    const mark = (targetPath, type) => reserved.set(targetPath, type);
    const destinationForName = (name) => {
        if (targetConfig.type === 'root') return path.join(targetConfig.path, name);
        const destination = targetConfig.byName.get(name);
        if (!destination) throw new Error(`没有找到同名目标文件夹「${name}」，请将它添加为目标文件夹`);
        return destination;
    };

    const transferFile = (sourcePath, targetDir, fileName) => {
        let destination = path.join(targetDir, fileName);
        if (exists(destination)) {
            destination = uniqueMergePath(targetDir, fileName, reserved);
            stats.renamed += 1;
            remember(`${fileName} → ${path.basename(destination)}`);
        }
        mark(destination, 'file');
        stats.files += 1;
        if (dryRun) return;
        fs.mkdirSync(targetDir, { recursive: true });
        if (mode === 'copy') {
            fs.copyFileSync(sourcePath, destination);
            return;
        }
        try {
            fs.renameSync(sourcePath, destination);
        } catch (error) {
            if (error.code !== 'EXDEV') throw error;
            fs.copyFileSync(sourcePath, destination);
            fs.unlinkSync(sourcePath);
        }
    };

    const mergeDirectory = (sourceDir, destinationDir) => {
        const destinationExists = exists(destinationDir);
        if (destinationExists && ((fs.existsSync(destinationDir) && !fs.statSync(destinationDir).isDirectory()) || reserved.get(destinationDir) === 'file')) {
            const renamedDestination = uniqueMergePath(path.dirname(destinationDir), path.basename(destinationDir), reserved);
            stats.renamed += 1;
            remember(`${path.basename(destinationDir)} 文件夹 → ${path.basename(renamedDestination)}`);
            destinationDir = renamedDestination;
        }
        if (exists(destinationDir)) stats.mergedFolders += 1;
        else {
            mark(destinationDir, 'dir');
            stats.createdFolders += 1;
            if (!dryRun) fs.mkdirSync(destinationDir, { recursive: true });
        }
        const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
        for (const entry of entries) {
            const from = path.join(sourceDir, entry.name);
            const to = path.join(destinationDir, entry.name);
            if (entry.isDirectory()) mergeDirectory(from, to);
            else transferFile(from, destinationDir, entry.name);
        }
        if (!dryRun && mode === 'move') {
            try { fs.rmdirSync(sourceDir); } catch (_) { /* a skipped special file keeps the source folder */ }
        }
    };

    for (const source of sourceEntries) {
        if (source.type === 'root') {
            const entries = fs.readdirSync(source.path, { withFileTypes: true });
            for (const entry of entries) {
                const from = path.join(source.path, entry.name);
                if (entry.isDirectory()) mergeDirectory(from, destinationForName(entry.name));
                else {
                    if (targetConfig.type !== 'root') throw new Error(`总来源目录中的文件「${entry.name}」需要使用“目标总文件夹”模式`);
                    transferFile(from, targetConfig.path, entry.name);
                }
            }
            if (!dryRun && mode === 'move') {
                try { fs.rmdirSync(source.path); } catch (_) { /* non-empty roots are retained */ }
            }
        } else {
            mergeDirectory(source.path, destinationForName(path.basename(source.path)));
        }
    }
    return stats;
}

async function getLocalDirectorySummary(folderPath) {
    let count = 0;
    let totalSize = 0;
    const pending = [folderPath];
    while (pending.length) {
        const current = pending.pop();
        let children;
        try { children = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
        for (const child of children) {
            if (child.name.startsWith('.')) continue;
            const childPath = path.join(current, child.name);
            if (child.isDirectory()) { pending.push(childPath); continue; }
            if (!child.isFile() && !child.isSymbolicLink()) continue;
            try {
                const stat = await fs.promises.stat(childPath);
                if (!stat.isFile()) continue;
                count += 1;
                totalSize += stat.size;
            } catch {}
        }
    }
    return { count, totalSize };
}

const LETTER_PREFIXES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function insertPrefixBeforeCounter(name, prefix) {
    if (!name || !prefix) return name;
    const dotIndex = name.lastIndexOf('.');
    const base = dotIndex !== -1 ? name.slice(0, dotIndex) : name;
    const ext = dotIndex !== -1 ? name.slice(dotIndex) : '';
    const match = base.match(/^(.*?)(\d+)$/);
    if (match) return `${match[1]}${prefix}${match[2]}${ext}`;
    return `${prefix}${name}`;
}

const localVideoThumbnailInflight = new Map();

function getSafeWindow(getMainWindow) {
    try {
        const win = getMainWindow?.();
        return (win && !win.isDestroyed()) ? win : null;
    } catch (_) {
        return null;
    }
}

function registerLocalOrganizer(rawIpcMain, getMainWindow) {
    const ipcMain = { handle: (channel, listener) => rawIpcMain.handle(channel, (event, ...args) => { assertTrustedRenderer(event); return listener(event, ...args); }) };
    // 1. 本地选择文件夹
    ipcMain.handle('local:pick-folder', async (_event, options = {}) => {
        const win = getSafeWindow(getMainWindow);
        const dialogOpts = {
            properties: ['openDirectory', 'createDirectory', ...(options.multi ? ['multiSelections'] : [])],
            title: options.title || '选择本地文件夹'
        };
        if (options.defaultPath) dialogOpts.defaultPath = options.defaultPath;
        const result = win
            ? await dialog.showOpenDialog(win, dialogOpts)
            : await dialog.showOpenDialog(dialogOpts);
        if (result.canceled || !result.filePaths.length) return null;
        return options.multi ? result.filePaths : result.filePaths[0];
    });

    // 2. 本地选择图片
    ipcMain.handle('local:pick-image', async () => {
        const win = getSafeWindow(getMainWindow);
        const dialogOpts = {
            properties: ['openFile'],
            filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
            title: '选择分类预览图'
        };
        const result = win
            ? await dialog.showOpenDialog(win, dialogOpts)
            : await dialog.showOpenDialog(dialogOpts);
        if (result.canceled || !result.filePaths.length) return null;
        return result.filePaths[0];
    });

    // 3. 读取子文件夹列表
    ipcMain.handle('local:get-subfolders', async (_event, folderPath) => {
        try {
            if (!folderPath || !fs.existsSync(folderPath)) return [];
            const fsP = fs.promises;
            const entries = await fsP.readdir(folderPath, { withFileTypes: true });
            const subfolders = [];
            const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.Trash', '.Spotlight-V100', '.fseventsd', 'Library', '.cache', '$RECYCLE.BIN', 'System Volume Information']);
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name)) continue;
                    subfolders.push({
                        name: entry.name,
                        path: path.join(folderPath, entry.name)
                    });
                }
            }
            return subfolders;
        } catch (error) {
            console.error('[LocalOrg] 获取子文件夹失败:', error);
            return [];
        }
    });

    // 4. 读取单层目录详细内容
    ipcMain.handle('local:list-directory', async (_event, folderPath) => {
        try {
            if (!folderPath || !fs.existsSync(folderPath)) return { exists: false, items: [] };
            const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
            const items = [];
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const itemPath = path.join(folderPath, entry.name);
                let stat;
                try {
                    stat = await fs.promises.stat(itemPath);
                } catch {
                    continue;
                }
                if (stat.isDirectory()) {
                    const summary = await getLocalDirectorySummary(itemPath);
                    items.push({
                        name: entry.name,
                        path: itemPath,
                        isDirectory: true,
                        isSymbolicLink: entry.isSymbolicLink(),
                        modifiedTime: stat.mtime.toISOString(),
                        createdTime: stat.birthtime.toISOString(),
                        count: summary.count,
                        totalSize: summary.totalSize
                    });
                } else if (stat.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    items.push({
                        name: entry.name,
                        path: itemPath,
                        isDirectory: false,
                        isSymbolicLink: entry.isSymbolicLink(),
                        size: stat.size,
                        modifiedTime: stat.mtime.toISOString(),
                        createdTime: stat.birthtime.toISOString(),
                        mimeType: SCAN_MIME_MAP[ext] || 'application/octet-stream'
                    });
                }
            }
            return { success: true, exists: true, items };
        } catch (error) {
            console.error('[LocalOrg] 读取目录失败:', error);
            return { success: false, exists: false, items: [], error: error.message };
        }
    });

    // 5. 递归扫描文件夹中的文件
    ipcMain.handle('local:scan-folder', async (_event, folderPath, options = {}) => {
        try {
            if (!folderPath || !fs.existsSync(folderPath)) return [];
            const cacheDir = path.join(app.getPath('userData'), 'local-scan-cache');
            const cacheKey = crypto.createHash('sha1').update(folderPath).digest('hex');
            const cachePath = path.join(cacheDir, `${cacheKey}.json`);
            const rootStat = await fs.promises.stat(folderPath);
            if (!options.force && fs.existsSync(cachePath)) {
                try {
                    const cached = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
                    if (
                        cached?.version === 1 &&
                        cached.folderPath === folderPath &&
                        cached.rootMtimeMs === rootStat.mtimeMs &&
                        Array.isArray(cached.files)
                    ) {
                        return cached.files;
                    }
                } catch (_) {}
            }
            const results = [];
            const fsP = fs.promises;
            const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.Trash', '.Spotlight-V100', '.fseventsd', 'Library', '.cache', '$RECYCLE.BIN', 'System Volume Information']);

            let totalScanned = 0;
            let lastProgressTime = 0;

            const walk = async (dir, relPath, depth = 0) => {
                if (depth > 6) return;
                let entries;
                try { entries = await fsP.readdir(dir, { withFileTypes: true }); } catch { return; }
                for (const entry of entries) {
                    if (results.length >= SCAN_MAX_FILES) return;
                    if (entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);
                    const rel = relPath ? `${relPath}/${entry.name}` : entry.name;
                    if (entry.isDirectory()) {
                        if (SKIP_DIRS.has(entry.name)) continue;
                        await walk(fullPath, rel, depth + 1);
                    } else if (entry.isFile()) {
                        const ext = path.extname(entry.name).toLowerCase();
                        if (!SCAN_MIME_MAP[ext]) continue;
                        try {
                            const stat = await fsP.stat(fullPath);
                            totalScanned++;
                            results.push({
                                id: `file-${Date.now()}-${results.length}`,
                                name: entry.name,
                                path: fullPath,
                                relativePath: rel,
                                size: stat.size,
                                modifiedTime: stat.mtime.toISOString(),
                                createdTime: stat.birthtime.toISOString(),
                                mimeType: SCAN_MIME_MAP[ext] || 'application/octet-stream',
                                extension: ext
                            });

                            const now = Date.now();
                            if (now - lastProgressTime > 150) {
                                lastProgressTime = now;
                                const win = getMainWindow?.();
                                win?.webContents?.send('local:scan-progress', { folder: folderPath, count: totalScanned });
                            }
                        } catch {}
                    }
                }
            };

            await walk(folderPath, '');
            try {
                await fs.promises.mkdir(cacheDir, { recursive: true });
                await fs.promises.writeFile(cachePath, JSON.stringify({
                    version: 1,
                    folderPath,
                    rootMtimeMs: rootStat.mtimeMs,
                    files: results
                }), 'utf8');
            } catch (_) {}
            return results;
        } catch (error) {
            console.error('[LocalOrg] 扫描文件夹失败:', error);
            return [];
        }
    });

    // 6. 获取文件夹头像媒体
    ipcMain.handle('local:get-folder-avatar-media', async (_event, folderPath) => {
        try {
            if (!folderPath || !fs.existsSync(folderPath)) return null;
            const fsP = fs.promises;
            const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);
            const videoExts = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.ogg']);
            const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.Trash', '.Spotlight-V100', '.fseventsd', 'Library', '.cache', '$RECYCLE.BIN', 'System Volume Information']);

            const maxDepth = 2;
            const maxSubdirsToSearch = 5;
            const maxEntriesToInspect = 100;

            const search = async (dir, depth) => {
                if (depth > maxDepth) return null;
                let entries;
                try { entries = await fsP.readdir(dir, { withFileTypes: true }); } catch { return null; }

                const subdirs = [];
                let count = 0;

                for (const entry of entries) {
                    if (count++ > maxEntriesToInspect) break;
                    if (entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);

                    if (entry.isDirectory()) {
                        if (!SKIP_DIRS.has(entry.name)) subdirs.push(fullPath);
                    } else {
                        const ext = path.extname(entry.name).toLowerCase();
                        if (imageExts.has(ext) || videoExts.has(ext)) return fullPath;
                    }
                }

                if (depth < maxDepth) {
                    let searchedCount = 0;
                    for (const subdir of subdirs) {
                        if (searchedCount++ >= maxSubdirsToSearch) break;
                        const found = await search(subdir, depth + 1);
                        if (found) return found;
                    }
                }
                return null;
            };

            return await search(folderPath, 1);
        } catch (error) {
            console.error('[LocalOrg] 获取文件夹头像媒体失败:', error);
            return null;
        }
    });

    // 7. 视频缩略图生成与缓存（限制并发数并复用缓存）
    const MAX_THUMB_CONCURRENCY = 2;
    let activeThumbCount = 0;
    const thumbWaitQueue = [];
    const acquireThumbSlot = () => new Promise(resolve => {
        if (activeThumbCount < MAX_THUMB_CONCURRENCY) {
            activeThumbCount++;
            resolve();
        } else {
            thumbWaitQueue.push(resolve);
        }
    });
    const releaseThumbSlot = () => {
        if (thumbWaitQueue.length > 0) {
            const next = thumbWaitQueue.shift();
            next();
        } else {
            activeThumbCount = Math.max(0, activeThumbCount - 1);
        }
    };

    ipcMain.handle('local:video-thumbnail', async (_event, filePath, requestedSize = 240) => {
        try {
            if (!filePath || !fs.existsSync(filePath)) return null;
            const stat = await fs.promises.stat(filePath);
            const size = Math.max(96, Math.min(480, Number(requestedSize) || 240));
            const cacheDir = path.join(app.getPath('userData'), 'local-video-thumbnails');
            const cacheKey = crypto
                .createHash('sha1')
                .update(`${filePath}|${stat.size}|${stat.mtimeMs}|${size}`)
                .digest('hex');
            const thumbnailPath = path.join(cacheDir, `${cacheKey}.jpg`);

            if (fs.existsSync(thumbnailPath)) return thumbnailPath;
            if (localVideoThumbnailInflight.has(cacheKey)) {
                return await localVideoThumbnailInflight.get(cacheKey);
            }

            const job = (async () => {
                await acquireThumbSlot();
                await fs.promises.mkdir(cacheDir, { recursive: true });
                const temporaryPath = path.join(cacheDir, `${cacheKey}.${process.pid}.tmp.jpg`);
                try {
                    if (fs.existsSync(thumbnailPath)) return thumbnailPath;
                    await runExecFile(getFfmpegCommand(), [
                        '-hide_banner',
                        '-loglevel', 'error',
                        '-ss', '1',
                        '-i', filePath,
                        '-frames:v', '1',
                        '-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
                        '-q:v', '4',
                        '-y',
                        temporaryPath
                    ]);
                    if (!fs.existsSync(temporaryPath)) {
                        await runExecFile(getFfmpegCommand(), [
                            '-hide_banner',
                            '-loglevel', 'error',
                            '-ss', '0',
                            '-i', filePath,
                            '-frames:v', '1',
                            '-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
                            '-q:v', '4',
                            '-y',
                            temporaryPath
                        ]);
                    }
                    if (!fs.existsSync(temporaryPath)) return null;
                    await fs.promises.rename(temporaryPath, thumbnailPath);
                    return thumbnailPath;
                } catch (error) {
                    try {
                        if (fs.existsSync(temporaryPath)) await fs.promises.unlink(temporaryPath);
                    } catch (_) {}
                    return null;
                } finally {
                    releaseThumbSlot();
                }
            })();

            localVideoThumbnailInflight.set(cacheKey, job);
            try {
                return await job;
            } finally {
                localVideoThumbnailInflight.delete(cacheKey);
            }
        } catch (error) {
            return null;
        }
    });

    // 8. 图片缩略图 URL
    ipcMain.handle('local:thumbnail', async (_event, filePath) => {
        try {
            if (!filePath || !fs.existsSync(filePath)) return null;
            const ext = path.extname(filePath).toLowerCase();
            const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tiff', '.tif', '.avif'];
            if (imageExts.includes(ext)) {
                return pathToFileURL(filePath).href.replace(/^file:/i, 'local-media:');
            }
            return null;
        } catch (_) {
            return null;
        }
    });

    // 9. 扁平化文件夹
    ipcMain.handle('local:flatten-folder', async (_event, folderPath) => {
        try {
            if (!folderPath || !fs.existsSync(folderPath)) return { success: false, error: '文件夹不存在' };
            const files = [];
            const fsP = fs.promises;
            const walk = async (dir) => {
                const entries = await fsP.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name.startsWith('.')) continue;
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) await walk(full);
                    else if (entry.isFile()) files.push(full);
                }
            };
            await walk(folderPath);
            let moved = 0;
            for (const file of files) {
                if (path.dirname(file) === folderPath) continue;
                const base = path.basename(file);
                const dest = getUniqueDestPath(folderPath, base);
                await fsP.rename(file, dest);
                moved++;
            }
            return { success: true, movedCount: moved };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // 10. 复制单个文件到文件夹
    ipcMain.handle('local:copy-to-folder', async (_event, filePath, targetDir, options = {}) => {
        try {
            if (!filePath || !targetDir) return { success: false, error: '缺少参数' };
            if (!fs.existsSync(filePath)) return { success: false, error: '源文件不存在' };
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            const conflictRule = typeof options === 'string' ? options : (options?.conflict || 'rename');
            const baseName = path.basename(filePath);
            let destPath = path.join(targetDir, baseName);
            if (fs.existsSync(destPath)) {
                if (conflictRule === 'skip') return { success: true, status: 'skip', destPath, destination: destPath };
                if (conflictRule === 'overwrite') { /* will overwrite */ }
                else destPath = getUniqueDestPath(targetDir, baseName);
            }
            fs.copyFileSync(filePath, destPath);
            return { success: true, destPath, destination: destPath };
        } catch (error) {
            console.error('[LocalOrg] 复制文件失败:', error);
            return { success: false, error: error.message };
        }
    });

    // 11. 移动单个文件到文件夹
    ipcMain.handle('local:move-to-folder', async (_event, filePath, targetDir, options = {}) => {
        try {
            if (!filePath || !targetDir) return { success: false, error: '缺少参数' };
            if (!fs.existsSync(filePath)) return { success: false, error: '源文件不存在' };
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            const conflictRule = typeof options === 'string' ? options : (options?.conflict || 'rename');
            const baseName = path.basename(filePath);
            let destPath = path.join(targetDir, baseName);
            if (fs.existsSync(destPath)) {
                if (conflictRule === 'skip') return { success: true, status: 'skip', destPath, destination: destPath };
                if (conflictRule === 'overwrite') { /* will overwrite */ }
                else destPath = getUniqueDestPath(targetDir, baseName);
            }
            const srcStat = fs.statSync(filePath);
            const srcSize = srcStat.size;
            try {
                fs.renameSync(filePath, destPath);
            } catch (_) {
                fs.copyFileSync(filePath, destPath);
                if (!fs.existsSync(destPath)) return { success: false, error: '复制后目标文件不存在，已保留源文件' };
                const destStat = fs.statSync(destPath);
                if (destStat.size !== srcSize) {
                    try { fs.unlinkSync(destPath); } catch (_) {}
                    return { success: false, error: `文件大小校验失败 (${srcSize} vs ${destStat.size})，已保留源文件` };
                }
                fs.unlinkSync(filePath);
            }
            return { success: true, destPath, destination: destPath };
        } catch (error) {
            console.error('[LocalOrg] 移动文件失败:', error);
            return { success: false, error: error.message };
        }
    });

    // 12. 查找和删除重复项
    ipcMain.handle('local:remove-duplicates', async (_event, filePaths) => {
        try {
            if (!filePaths || !filePaths.length) return { success: false, error: '没有文件' };
            const fsP = fs.promises;
            const sizeMap = new Map();
            for (const p of filePaths) {
                try {
                    const stat = await fsP.stat(p);
                    if (stat.isFile()) {
                        const sz = stat.size;
                        if (!sizeMap.has(sz)) sizeMap.set(sz, []);
                        sizeMap.get(sz).push(p);
                    }
                } catch (_) {}
            }
            const trashed = [];
            let bytesSaved = 0;
            for (const [sz, paths] of sizeMap.entries()) {
                if (paths.length > 1) {
                    const hashMap = new Map();
                    for (const p of paths) {
                        try {
                            const fileBuffer = await fsP.readFile(p);
                            const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
                            if (hashMap.has(hash)) {
                                await shell.trashItem(p);
                                trashed.push(p);
                                bytesSaved += sz;
                            } else {
                                hashMap.set(hash, p);
                            }
                        } catch (_) {}
                    }
                }
            }
            return { success: true, trashedCount: trashed.length, trashedFiles: trashed, bytesSaved };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('local:find-duplicates', async (_event, filePaths) => {
        try {
            if (!filePaths || !filePaths.length) return { success: true, duplicateGroups: [] };
            const fsP = fs.promises;
            const sizeMap = new Map();
            for (const p of filePaths) {
                try {
                    const stat = await fsP.stat(p);
                    if (stat.isFile()) {
                        const sz = stat.size;
                        if (!sizeMap.has(sz)) sizeMap.set(sz, []);
                        sizeMap.get(sz).push(p);
                    }
                } catch (_) {}
            }
            const groups = [];
            for (const [, paths] of sizeMap.entries()) {
                if (paths.length > 1) {
                    const hashMap = new Map();
                    for (const p of paths) {
                        try {
                            const buf = await fsP.readFile(p);
                            const hash = crypto.createHash('sha256').update(buf).digest('hex');
                            if (!hashMap.has(hash)) hashMap.set(hash, []);
                            hashMap.get(hash).push(p);
                        } catch (_) {}
                    }
                    for (const group of hashMap.values()) {
                        if (group.length > 1) groups.push(group);
                    }
                }
            }
            return { success: true, duplicateGroups: groups };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 13. 移入废纸篓
    ipcMain.handle('local:trash-files', async (_event, filePaths) => {
        try {
            if (!filePaths || !filePaths.length) return { success: false, error: '没有文件' };
            const trashed = [];
            const failed = [];
            for (const fp of filePaths) {
                try {
                    await shell.trashItem(fp);
                    trashed.push(fp);
                } catch (err) {
                    failed.push({ path: fp, error: err.message });
                }
            }
            return { success: failed.length === 0, trashedCount: trashed.length, trashed, failed };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 14. 复制文件到剪贴板
    ipcMain.handle('local:copy-to-clipboard', async (_event, filePaths) => {
        try {
            if (!filePaths || !filePaths.length) return { success: false, error: '没有文件' };
            if (process.platform === 'darwin') {
                const escaped = filePaths.map(p => `POSIX file "${String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ');
                const script = `tell application "Finder" to set the clipboard to {${escaped}}`;
                await new Promise((resolve, reject) => {
                    execFile('osascript', ['-e', script], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            } else {
                if (filePaths.length === 1 && (filePaths[0].endsWith('.png') || filePaths[0].endsWith('.jpg'))) {
                    clipboard.writeImage(nativeImage.createFromPath(filePaths[0]));
                } else {
                    clipboard.writeText(filePaths.join('\n'));
                }
            }
            return { success: true, count: filePaths.length };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 15. 新建文件夹
    ipcMain.handle('local:create-folder', async (_event, parentDir, folderName) => {
        try {
            if (!parentDir || !folderName) return { success: false, error: '缺少参数' };
            if (!fs.existsSync(parentDir)) return { success: false, error: '父目录不存在' };
            const safeName = folderName.replace(/[<>:"/\\|?*]/g, '_').trim();
            if (!safeName) return { success: false, error: '文件夹名称无效' };
            const newPath = path.join(parentDir, safeName);
            if (fs.existsSync(newPath)) return { success: false, error: '该文件夹已存在' };
            fs.mkdirSync(newPath, { recursive: true });
            return { success: true, path: newPath, name: safeName };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 16. 移动整个文件夹
    ipcMain.handle('local:move-folder-to-folder', async (_event, srcDir, targetDir, options = {}) => {
        try {
            if (!srcDir || !targetDir) return { success: false, error: '缺少参数' };
            const { sourcePath, targetPath } = validateFolderTransferPaths(srcDir, targetDir);
            if (!fs.existsSync(sourcePath)) return { success: false, error: '源文件夹不存在' };
            const stat = fs.statSync(sourcePath);
            if (!stat.isDirectory()) return { success: false, error: '源路径不是文件夹' };
            if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
            const conflictRule = options.conflict || 'rename';
            const folderName = path.basename(sourcePath);
            let destPath = path.join(targetPath, folderName);
            if (fs.existsSync(destPath)) {
                if (conflictRule === 'skip') return { success: true, status: 'skip', destPath };
                if (conflictRule === 'overwrite') { /* will merge/overwrite */ }
                else {
                    let counter = 1;
                    while (fs.existsSync(destPath)) {
                        destPath = path.join(targetPath, `${folderName} (${counter})`);
                        counter++;
                    }
                }
            }
            try {
                fs.renameSync(sourcePath, destPath);
            } catch (renameErr) {
                if (renameErr.code !== 'EXDEV') throw renameErr;
                const fsP = fs.promises;
                const copyDirRecursive = async (src, dest) => {
                    fs.mkdirSync(dest, { recursive: true });
                    const entries = await fsP.readdir(src, { withFileTypes: true });
                    for (const entry of entries) {
                        const srcP = path.join(src, entry.name);
                        const destP = path.join(dest, entry.name);
                        if (entry.isDirectory()) await copyDirRecursive(srcP, destP);
                        else fs.copyFileSync(srcP, destP);
                    }
                };
                await copyDirRecursive(sourcePath, destPath);
                if (!fs.existsSync(destPath)) return { success: false, error: '复制后目标文件夹不存在，已保留源文件夹' };
                fs.rmSync(sourcePath, { recursive: true, force: true });
            }
            return { success: true, destPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 17. 复制整个文件夹
    ipcMain.handle('local:copy-folder-to-folder', async (_event, srcDir, targetDir, options = {}) => {
        try {
            if (!srcDir || !targetDir) return { success: false, error: '缺少参数' };
            const { sourcePath, targetPath } = validateFolderTransferPaths(srcDir, targetDir);
            if (!fs.existsSync(sourcePath)) return { success: false, error: '源文件夹不存在' };
            const stat = fs.statSync(sourcePath);
            if (!stat.isDirectory()) return { success: false, error: '源路径不是文件夹' };
            if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
            const conflictRule = options.conflict || 'rename';
            const folderName = path.basename(sourcePath);
            let destPath = path.join(targetPath, folderName);
            if (fs.existsSync(destPath)) {
                if (conflictRule === 'skip') return { success: true, status: 'skip', destPath };
                if (conflictRule === 'overwrite') { /* will merge/overwrite */ }
                else {
                    let counter = 1;
                    while (fs.existsSync(destPath)) {
                        destPath = path.join(targetPath, `${folderName} (${counter})`);
                        counter++;
                    }
                }
            }
            const fsP = fs.promises;
            const copyDirRecursive = async (src, dest) => {
                fs.mkdirSync(dest, { recursive: true });
                const entries = await fsP.readdir(src, { withFileTypes: true });
                for (const entry of entries) {
                    const srcP = path.join(src, entry.name);
                    const destP = path.join(dest, entry.name);
                    if (entry.isDirectory()) await copyDirRecursive(srcP, destP);
                    else fs.copyFileSync(srcP, destP);
                }
            };
            await copyDirRecursive(sourcePath, destPath);
            return { success: true, destPath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 18. Merge material folders into one collection root. Sources tagged "root"
    // contribute their immediate child folders; "folder" contributes itself as a
    // same-named child folder in the target.
    ipcMain.handle('local:merge-material-folders', async (_event, targetRoot, sources, options = {}) => {
        try {
            const { target, sources: normalizedSources } = validateFolderMergePaths(targetRoot, sources);
            const result = executeFolderMerge(target, normalizedSources, {
                dryRun: Boolean(options.dryRun),
                mode: options.mode
            });
            return { success: true, targetPaths: target.type === 'root' ? [target.path] : target.paths, mode: options.mode === 'copy' ? 'copy' : 'move', ...result };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 19. 预设导出与导入
    ipcMain.handle('local:export-preset', async (_event, jsonStr) => {
        try {
            const win = getSafeWindow(getMainWindow);
            const dialogOpts = {
                title: '导出本地整理预设',
                defaultPath: `本地整理预设_${new Date().toISOString().slice(0, 10)}.json`,
                filters: [{ name: 'JSON 文件', extensions: ['json'] }]
            };
            const { filePath, canceled } = win
                ? await dialog.showSaveDialog(win, dialogOpts)
                : await dialog.showSaveDialog(dialogOpts);
            if (canceled || !filePath) return { success: false, canceled: true };
            fs.writeFileSync(filePath, jsonStr, 'utf-8');
            return { success: true, filePath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('local:import-preset', async () => {
        try {
            const win = getSafeWindow(getMainWindow);
            const dialogOpts = {
                title: '导入本地整理预设',
                filters: [{ name: 'JSON 文件', extensions: ['json'] }],
                properties: ['openFile']
            };
            const { filePaths, canceled } = win
                ? await dialog.showOpenDialog(win, dialogOpts)
                : await dialog.showOpenDialog(dialogOpts);
            if (canceled || !filePaths?.length) return { success: false, canceled: true };
            const content = fs.readFileSync(filePaths[0], 'utf-8');
            return { success: true, content, filePath: filePaths[0] };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 19. 批量导入预设合并
    ipcMain.handle('local:import-presets-multi', async () => {
        try {
            const win = getSafeWindow(getMainWindow);
            const dialogOpts = {
                title: '选择要合并的预设文件（可多选）',
                filters: [{ name: 'JSON 文件', extensions: ['json'] }],
                properties: ['openFile', 'multiSelections']
            };
            const { filePaths, canceled } = win
                ? await dialog.showOpenDialog(win, dialogOpts)
                : await dialog.showOpenDialog(dialogOpts);
            if (canceled || !filePaths?.length) return { success: false, canceled: true };
            const results = [];
            for (const fp of filePaths) {
                try {
                    const content = fs.readFileSync(fp, 'utf-8');
                    results.push({ content, filePath: fp, error: null });
                } catch (err) {
                    results.push({ content: null, filePath: fp, error: err.message });
                }
            }
            return { success: true, files: results };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 20. 多窗口工作区配置导出与导入
    ipcMain.handle('local:export-workspace-config', async (_event, jsonStr) => {
        try {
            const win = getSafeWindow(getMainWindow);
            const dialogOpts = {
                title: '导出多窗口整理配置',
                defaultPath: `多窗口整理配置_${new Date().toISOString().slice(0, 10)}.json`,
                filters: [{ name: 'JSON 配置', extensions: ['json'] }]
            };
            const { filePath, canceled } = win
                ? await dialog.showSaveDialog(win, dialogOpts)
                : await dialog.showSaveDialog(dialogOpts);
            if (canceled || !filePath) return { success: false, canceled: true };
            fs.writeFileSync(filePath, jsonStr, 'utf-8');
            return { success: true, filePath };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('local:import-workspace-config', async () => {
        try {
            const win = getSafeWindow(getMainWindow);
            const dialogOpts = {
                title: '导入多窗口整理配置',
                filters: [{ name: 'JSON 配置', extensions: ['json'] }],
                properties: ['openFile']
            };
            const { filePaths, canceled } = win
                ? await dialog.showOpenDialog(win, dialogOpts)
                : await dialog.showOpenDialog(dialogOpts);
            if (canceled || !filePaths?.length) return { success: false, canceled: true };
            return { success: true, content: fs.readFileSync(filePaths[0], 'utf-8'), filePath: filePaths[0] };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // 21. 文件夹状态监控与校验
    ipcMain.handle('local:watch-folders', async () => {
        // 轻量保留接口契约，避免前端未捕获异常
        return { success: true };
    });

    ipcMain.handle('local:validate-folders', async (_event, folders = []) => {
        const results = [];
        for (const f of folders) {
            const exists = f.path && fs.existsSync(f.path);
            results.push({ id: f.id, exists });
        }
        return results;
    });

    // 22. 本地批量重命名
    ipcMain.handle('files:rename-local', async (_event, payload = [], extraArg) => {
        let isSingleCall = false;
        let items = payload;
        if (typeof payload === 'string' && typeof extraArg === 'string') {
            isSingleCall = true;
            items = [{ source: payload, newName: extraArg }];
        } else if (!Array.isArray(items)) {
            items = items ? [items] : [];
        }
        if (!items.length) {
            return isSingleCall ? { success: false, error: '缺少参数' } : { renamed: [], errors: [] };
        }
        const renamed = [];
        const errors = [];
        const reservedTargets = new Set();

        const insertNumberSuffix = (fileName, number) => {
            const ext = path.extname(fileName);
            const stem = ext ? fileName.slice(0, -ext.length) : fileName;
            return `${stem} (${number})${ext}`;
        };

        const ensureUniqueName = async (directory, desiredName, conflictStyle = 'letter') => {
            if (!desiredName || desiredName !== path.basename(desiredName) || desiredName === '.' || desiredName === '..') {
                throw new Error('文件名无效');
            }
            let attempt = -1;
            const maxAttempts = conflictStyle === 'number' ? 9999 : LETTER_PREFIXES.length;
            while (attempt < maxAttempts) {
                const candidate = attempt < 0
                    ? desiredName
                    : conflictStyle === 'number'
                        ? insertNumberSuffix(desiredName, attempt + 2)
                        : insertPrefixBeforeCounter(desiredName, LETTER_PREFIXES[attempt]);
                const targetPath = path.join(directory, candidate);
                const targetKey = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
                if (reservedTargets.has(targetKey)) { attempt++; continue; }
                try {
                    await fs.promises.access(targetPath, fs.constants.F_OK);
                    attempt++;
                    continue;
                } catch (accessError) {
                    if (accessError.code === 'ENOENT') {
                        reservedTargets.add(targetKey);
                        return { targetPath, finalName: candidate };
                    }
                    throw accessError;
                }
            }
            const error = new Error('无法生成唯一文件名');
            error.code = 'EEXIST';
            throw error;
        };

        for (const entry of items) {
            try {
                const source = entry?.source || entry?.oldPath || entry?.path;
                const desiredName = (entry?.newName || entry?.name || (entry?.newPath ? path.basename(entry.newPath) : '')).trim();
                if (!source || !desiredName) throw new Error('参数不完整');
                const directory = entry.directory || path.dirname(source);
                const currentName = path.basename(source);
                if (currentName === desiredName) {
                    renamed.push({ id: entry?.id, slotId: entry?.slotId, path: source, name: desiredName, target: source, newName: desiredName });
                    continue;
                }
                await fs.promises.access(source, fs.constants.F_OK);
                const { targetPath, finalName } = await ensureUniqueName(
                    directory,
                    desiredName,
                    entry.conflictStyle === 'number' ? 'number' : 'letter'
                );
                await fs.promises.rename(source, targetPath);
                renamed.push({ id: entry?.id, slotId: entry?.slotId, path: targetPath, name: finalName, target: targetPath, newName: finalName });
            } catch (error) {
                errors.push({ id: entry?.id, slotId: entry?.slotId, source: entry?.source, error: error.message });
            }
        }
        if (isSingleCall) {
            if (renamed.length > 0) {
                return { success: true, path: renamed[0].target, name: renamed[0].newName, ...renamed[0] };
            }
            return { success: false, error: errors[0]?.error || '重命名失败' };
        }
        return { renamed, errors, success: errors.length === 0 };
    });

    // 23. 打开路径与外部链接
    ipcMain.handle('open-path', async (_event, targetPath) => {
        try {
            if (!targetPath || !fs.existsSync(targetPath)) return { success: false, error: '路径不存在' };
            const stat = fs.statSync(targetPath);
            if (stat.isDirectory()) {
                await shell.openPath(targetPath);
            } else {
                shell.showItemInFolder(targetPath);
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('open-external', async (_event, url) => {
        try {
            if (!url || typeof url !== 'string') return { success: false, error: 'Invalid URL' };
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
                return { success: false, error: 'Blocked non-HTTP(S) external URL' };
            }
            await shell.openExternal(parsed.toString());
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
}

module.exports = {
    registerLocalOrganizer
};
