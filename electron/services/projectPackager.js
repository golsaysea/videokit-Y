const fs = require('fs');
const path = require('path');

const TASK_ASSET_ROLE_DIRS = {
    background: '背景素材',
    audio: '人声音频',
    subtitle: '字幕',
    script: '文案',
    bgm: '背景音乐',
    media: '辅助素材',
    overlay: '覆层素材',
    source: '原始片段',
    analysis: '自动剪辑分析',
};

function _toPathKey(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return '';
    try {
        const resolved = path.resolve(raw);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    } catch (_) {
        return process.platform === 'win32' ? raw.toLowerCase() : raw;
    }
}

function _sanitizeFileName(name, fallback = '素材') {
    const cleaned = String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
    return cleaned || fallback;
}

/**
 * Package a Reels task (regular batch task or auto-edit task) and all of its
 * referenced media, subtitle, overlay, and optional auto-edit analysis assets
 * into a self-contained portable directory alongside or inside the output path.
 */
async function packageReelsProject(payload = {}) {
    const sourceProjectDir = String(payload.sourceProjectDir || '').trim();
    const outputPath = String(payload.outputPath || '').trim();
    if (!outputPath || !path.isAbsolute(outputPath)) {
        return { ok: false, error: '缺少有效的目标输出路径' };
    }

    const baseName = path.basename(outputPath, path.extname(outputPath)) || 'Reels工程';
    const targetProjectDir = path.join(path.dirname(outputPath), `${baseName}-工程`);
    const hasExistingSourceDir = Boolean(
        sourceProjectDir
        && path.isAbsolute(sourceProjectDir)
        && fs.existsSync(sourceProjectDir)
        && fs.statSync(sourceProjectDir).isDirectory()
    );

    const copied = [];
    const missing = [];
    const missingKeys = new Set();
    const portablePathMap = new Map(); // normalized key -> targetPath
    const prefixRebaseList = [];
    const usedNamesByDir = new Map();

    const recordMap = (fromPath, toPath) => {
        if (!fromPath || !toPath) return;
        const key = _toPathKey(fromPath);
        if (key) portablePathMap.set(key, toPath);
        portablePathMap.set(String(fromPath), toPath);
    };

    const _unwrapMediaUrl = (value) => {
        const str = String(value || '').trim();
        if (!/^(local-media|file):\/\//i.test(str)) return '';
        let p = str.replace(/^(local-media|file):\/\//i, '').split('?')[0].split('#')[0];
        try { p = decodeURIComponent(p); } catch (_) {}
        if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
        else if (/^localhost\//i.test(p)) {
            p = p.slice('localhost'.length);
            if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
        }
        return p;
    };
    const resolveMappedPath = (value) => {
        if (typeof value !== 'string' || !value) return value;
        const direct = portablePathMap.get(value) || portablePathMap.get(_toPathKey(value));
        if (direct) return direct;
        const unwrapped = _unwrapMediaUrl(value);
        if (unwrapped) {
            const mapped = portablePathMap.get(unwrapped) || portablePathMap.get(_toPathKey(unwrapped));
            if (mapped) return mapped;
        }
        const valueKey = _toPathKey(value);
        for (const [fromRaw, fromKey, toDir] of prefixRebaseList) {
            if (valueKey === fromKey) return toDir;
            const sep = fromRaw.includes('\\') ? '\\' : '/';
            const normalizedPrefix = fromKey.endsWith(path.sep.toLowerCase()) || fromKey.endsWith(path.sep)
                ? fromKey
                : `${fromKey}${path.sep}`;
            if (valueKey.startsWith(normalizedPrefix)) {
                return `${toDir}${value.slice(fromRaw.length)}`;
            }
            if (value.startsWith(`${fromRaw}${sep}`)) {
                return `${toDir}${value.slice(fromRaw.length)}`;
            }
        }
        return value;
    };

    const copyAssetFile = async (sourcePath, targetDir, role) => {
        const cleanSource = String(sourcePath || '').trim();
        if (!cleanSource || !path.isAbsolute(cleanSource)) return null;
        const key = _toPathKey(cleanSource);
        if (portablePathMap.has(key)) {
            return portablePathMap.get(key);
        }
        if (!fs.existsSync(cleanSource) || !fs.statSync(cleanSource).isFile()) {
            const missKey = `${role}:${key}`;
            if (!missingKeys.has(missKey)) {
                missingKeys.add(missKey);
                missing.push({ role, path: cleanSource });
            }
            return null;
        }
        await fs.promises.mkdir(targetDir, { recursive: true });
        if (!usedNamesByDir.has(targetDir)) usedNamesByDir.set(targetDir, new Set());
        const used = usedNamesByDir.get(targetDir);
        const origName = _sanitizeFileName(path.basename(cleanSource), '素材');
        const ext = path.extname(origName);
        const stem = path.basename(origName, ext);
        let candidate = origName;
        let seq = 2;
        while (used.has(candidate.toLowerCase())) {
            candidate = `${stem}_${seq++}${ext}`;
        }
        used.add(candidate.toLowerCase());
        const targetPath = path.join(targetDir, candidate);
        await fs.promises.copyFile(cleanSource, targetPath);
        recordMap(cleanSource, targetPath);
        copied.push({ role, sourcePath: cleanSource, path: targetPath });
        return targetPath;
    };

    try {
        await fs.promises.mkdir(targetProjectDir, { recursive: true });

        if (hasExistingSourceDir) {
            const sourceResolved = await fs.promises.realpath(sourceProjectDir);
            const targetResolved = path.resolve(targetProjectDir);
            if (_toPathKey(sourceResolved) !== _toPathKey(targetResolved)) {
                await fs.promises.cp(sourceProjectDir, targetProjectDir, { recursive: true, force: true });
            }
            // If sourceProjectDir already holds the main auto-edit output or subtitle at known locations,
            // map them so we avoid duplicating large videos into a second subfolder.
            const sourceOutputPath = String(payload.sourceOutputPath || '').trim();
            if (sourceOutputPath) {
                const existingRootCopy = path.join(targetProjectDir, path.basename(sourceOutputPath));
                if (fs.existsSync(existingRootCopy) && fs.statSync(existingRootCopy).isFile()) {
                    recordMap(sourceOutputPath, existingRootCopy);
                }
            }
        }

        // 1. Copy typed assets for regular Reels batch tasks & supplemental auto-edit assets
        const taskAssets = Array.isArray(payload.taskAssets) ? payload.taskAssets : [];
        for (const asset of taskAssets) {
            const rawPath = typeof asset === 'string' ? asset : asset?.path;
            const role = typeof asset === 'object' && asset?.role && TASK_ASSET_ROLE_DIRS[asset.role]
                ? asset.role
                : 'media';
            await copyAssetFile(rawPath, path.join(targetProjectDir, TASK_ASSET_ROLE_DIRS[role]), role);
        }

        // 2. Copy legacy overlayAssets list if supplied separately
        for (const sourcePath of (Array.isArray(payload.overlayAssets) ? payload.overlayAssets : [])) {
            await copyAssetFile(sourcePath, path.join(targetProjectDir, TASK_ASSET_ROLE_DIRS.overlay), 'overlay');
        }

        // 3. Copy auto-edit original clips & analysis files/folder when present
        for (const sourcePath of (Array.isArray(payload.originalClips) ? payload.originalClips : [])) {
            await copyAssetFile(sourcePath, path.join(targetProjectDir, TASK_ASSET_ROLE_DIRS.source), 'source');
        }
        const analysisDir = path.join(targetProjectDir, TASK_ASSET_ROLE_DIRS.analysis);
        for (const sourcePath of (Array.isArray(payload.analysisAssets) ? payload.analysisAssets : [])) {
            await copyAssetFile(sourcePath, analysisDir, 'analysis');
        }

        const analysisOutputDir = String(payload.analysisOutputDir || '').trim();
        let analysisTargetDir = '';
        if (analysisOutputDir && path.isAbsolute(analysisOutputDir) && fs.existsSync(analysisOutputDir) && fs.statSync(analysisOutputDir).isDirectory()) {
            analysisTargetDir = path.join(analysisDir, _sanitizeFileName(path.basename(path.resolve(analysisOutputDir)), '本次分析'));
            const sourceResolved = await fs.promises.realpath(analysisOutputDir);
            const targetResolved = path.resolve(analysisTargetDir);
            if (!targetResolved.startsWith(`${sourceResolved}${path.sep}`) && _toPathKey(targetResolved) !== _toPathKey(sourceResolved)) {
                await fs.promises.cp(analysisOutputDir, analysisTargetDir, {
                    recursive: true,
                    force: true,
                    filter: source => !String(source).endsWith('-工程'),
                });
                recordMap(analysisOutputDir, analysisTargetDir);
                prefixRebaseList.push([analysisOutputDir, _toPathKey(analysisOutputDir), analysisTargetDir]);
            }
        }

        const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
        const rebaseJson = (value) => {
            if (Array.isArray(value)) return value.map(rebaseJson);
            if (!value || typeof value !== 'object') return resolveMappedPath(value);
            Object.keys(value).forEach((key) => {
                if (UNSAFE_KEYS.has(key)) {
                    delete value[key];
                    return;
                }
                value[key] = rebaseJson(value[key]);
            });
            return value;
        };

        if (analysisTargetDir && fs.existsSync(analysisTargetDir)) {
            const files = await fs.promises.readdir(analysisTargetDir, { recursive: true });
            for (const relativePath of files) {
                if (!String(relativePath).toLowerCase().endsWith('.json')) continue;
                const jsonPath = path.join(analysisTargetDir, relativePath);
                try {
                    const data = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
                    await fs.promises.writeFile(jsonPath, JSON.stringify(rebaseJson(data), null, 2), 'utf8');
                } catch (_) { /* 保留无法解析的非工程 JSON */ }
            }
        }

        // Write 文案.txt without clobbering existing content when scriptText is blank
        const scriptTxtPath = path.join(targetProjectDir, '文案.txt');
        const scriptText = String(payload.scriptText || '');
        if (scriptText || !fs.existsSync(scriptTxtPath)) {
            await fs.promises.writeFile(scriptTxtPath, scriptText, 'utf8');
        }

        let projectJsonPath = '';
        let remappedTasks = [];
        let remappedWatermarks = null;
        if (payload.reelsProjectData && typeof payload.reelsProjectData === 'object') {
            const projectData = JSON.parse(JSON.stringify(payload.reelsProjectData));
            const remapTaskObjectUrls = (value) => {
                if (Array.isArray(value)) {
                    value.forEach(remapTaskObjectUrls);
                    return;
                }
                if (!value || typeof value !== 'object') return;
                // Clear stale file:/// URLs when paths have been remapped or converted so applyProjectData
                // rebuilds fresh local file:// URLs from remapped bgPath/videoPath on any machine.
                if (Object.prototype.hasOwnProperty.call(value, 'bgPath') || Object.prototype.hasOwnProperty.call(value, 'videoPath')) {
                    delete value.bgSrcUrl;
                    delete value.srcUrl;
                }
                Object.values(value).forEach(remapTaskObjectUrls);
            };
            rebaseJson(projectData);
            remapTaskObjectUrls(projectData);
            const reelsDir = path.join(targetProjectDir, 'Reels工程');
            await fs.promises.mkdir(reelsDir, { recursive: true });
            projectJsonPath = path.join(reelsDir, `${baseName}.reels-project.json`);
            await fs.promises.writeFile(projectJsonPath, JSON.stringify(projectData, null, 2), 'utf8');
            remappedTasks = Array.isArray(projectData.tasks) ? projectData.tasks : [];
            if (Array.isArray(projectData.watermarks)) remappedWatermarks = projectData.watermarks;
        }

        // Write or update 工程清单.json so callers & operators see complete asset status
        const manifestPath = path.join(targetProjectDir, '工程清单.json');
        let existingManifest = null;
        if (fs.existsSync(manifestPath)) {
            try {
                existingManifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
            } catch (_) { existingManifest = null; }
        }
        const manifest = {
            version: 1,
            createdAt: existingManifest?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            mode: hasExistingSourceDir ? 'auto-edit+reels' : 'reels-task',
            sourceOutputPath: payload.sourceOutputPath || existingManifest?.sourceOutputPath || outputPath,
            reelsProjectFile: projectJsonPath,
            copied: [...(Array.isArray(existingManifest?.copied) ? existingManifest.copied : []), ...copied],
            missing,
            note: '这是可二剪工程包。原始文件未被移动或删除。',
        };
        await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

        return {
            ok: true,
            projectDir: targetProjectDir,
            projectJsonPath,
            copiedCount: copied.length,
            missing,
            packedTask: remappedTasks[0] || null,
            packedWatermarks: remappedWatermarks,
        };
    } catch (error) {
        return {
            ok: false,
            error: error.message || String(error),
            projectDir: targetProjectDir,
            missing,
        };
    }
}

module.exports = {
    TASK_ASSET_ROLE_DIRS,
    packageReelsProject,
};
