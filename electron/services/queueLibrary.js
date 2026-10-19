const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function validate(snapshot) {
    if (snapshot?.version !== '2.0' || !Array.isArray(snapshot.tabs) || !snapshot.tabs.length ||
        snapshot.tabs.some(tab => !tab || !Array.isArray(tab.tasks) || tab.tasks.some(t => !t || typeof t !== 'object' || Array.isArray(t)))) {
        throw new Error('队列数据无效');
    }
}

function summarize(snapshot) {
    const audio = new Set(), video = new Set();
    let tasks = 0, subtitles = 0;
    const visit = (value, key = '') => {
        if (typeof value === 'string') {
            if (/\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)$/i.test(value)) audio.add(value.toLowerCase().replace(/\\/g, '/'));
            if (/\.(mp4|mov|mkv|webm|avi|m4v|wmv|mpeg|mpg)$/i.test(value)) video.add(value.toLowerCase().replace(/\\/g, '/'));
        } else if (Array.isArray(value)) value.forEach(v => visit(v, key));
        else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => {
            if (/path|file|pool|clips|cover|overlays/i.test(k)) visit(v, k);
        });
    };
    for (const tab of snapshot.tabs) for (const task of tab.tasks) {
        tasks++;
        if (task.srtPath || task.segments?.length || task.srtContent) subtitles++;
        visit(task);
    }
    return { tasks, audio: audio.size, video: video.size, subtitles, tabs: snapshot.tabs.length };
}

function createQueueLibrary(root, extraRoots = []) {
    const allRoots = [...new Set([root, ...(Array.isArray(extraRoots) ? extraRoots : [])].filter(Boolean).map(r => path.resolve(r)))];
    const validateId = id => {
        if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error('队列编号无效');
        return String(id);
    };
    const filename = (id, dir = root) => path.join(dir, `${validateId(id)}.json`);
    const findExistingFile = id => {
        const safeId = validateId(id);
        for (const dir of allRoots) {
            const p = path.join(dir, `${safeId}.json`);
            if (fs.existsSync(p)) return p;
        }
        return path.join(root, `${safeId}.json`);
    };
    return {
        save(name, snapshot) {
            validate(snapshot);
            name = String(name || '').trim().slice(0, 120);
            if (!name) throw new Error('请输入队列名称');
            const copy = JSON.parse(JSON.stringify(snapshot));
            for (const tab of copy.tabs) for (const task of tab.tasks) {
                if (task.srtPath && fs.existsSync(task.srtPath)) task.srtContent = fs.readFileSync(task.srtPath, 'utf8');
            }
            const entry = { id: crypto.randomUUID(), name, savedAt: new Date().toISOString(), counts: summarize(copy), snapshot: copy };
            const jsonStr = JSON.stringify(entry);
            fs.mkdirSync(root, { recursive: true });
            const target = filename(entry.id, root);
            const temporary = `${target}.tmp`;
            try {
                fs.writeFileSync(temporary, jsonStr, { flag: 'wx' });
                fs.renameSync(temporary, target);
            } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
            for (const otherRoot of allRoots) {
                if (otherRoot === path.resolve(root)) continue;
                try {
                    fs.mkdirSync(otherRoot, { recursive: true });
                    const otherTarget = filename(entry.id, otherRoot);
                    const otherTmp = `${otherTarget}.${process.pid}.tmp`;
                    fs.writeFileSync(otherTmp, jsonStr, 'utf8');
                    fs.renameSync(otherTmp, otherTarget);
                } catch (_) { }
            }
            const { snapshot: _, ...metadata } = entry;
            return { ...metadata, filePath: target };
        },
        list() {
            const byId = new Map();
            for (const dir of allRoots) {
                if (!fs.existsSync(dir)) continue;
                let files = [];
                try { files = fs.readdirSync(dir); } catch (_) { continue; }
                for (const f of files) {
                    if (!/^[a-f0-9-]{36}\.json$/.test(f)) continue;
                    const id = path.basename(f, '.json');
                    if (byId.has(id)) continue;
                    const fullPath = path.join(dir, f);
                    try {
                        const entry = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                        validate(entry.snapshot);
                        // Sync to primary root if found only in secondary/portable root
                        let resolvedPath = fullPath;
                        const primaryTarget = path.join(root, f);
                        if (path.resolve(dir) !== path.resolve(root)) {
                            try {
                                if (!fs.existsSync(primaryTarget)) {
                                    fs.mkdirSync(root, { recursive: true });
                                    fs.copyFileSync(fullPath, primaryTarget);
                                }
                                resolvedPath = primaryTarget;
                            } catch (_) { }
                        }
                        byId.set(id, {
                            id,
                            name: entry.name,
                            savedAt: entry.savedAt,
                            counts: summarize(entry.snapshot),
                            filePath: resolvedPath,
                        });
                    } catch { /* ignore corrupted */ }
                }
            }
            return Array.from(byId.values()).sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
        },
        load(id) {
            const targetFile = findExistingFile(id);
            const entry = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
            validate(entry.snapshot);
            const restoreDir = path.join(root, 'restored-subtitles', crypto.randomUUID());
            let index = 0;
            for (const tab of entry.snapshot.tabs) for (const task of tab.tasks) {
                if (typeof task.srtContent === 'string') {
                    fs.mkdirSync(restoreDir, { recursive: true });
                    task.srtPath = path.join(restoreDir, `${++index}.srt`);
                    fs.writeFileSync(task.srtPath, task.srtContent, 'utf8');
                }
            }
            entry.filePath = targetFile;
            return entry;
        },
    };
}

module.exports = { createQueueLibrary, summarize, validate };
