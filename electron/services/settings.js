/**
 * Settings and file management service
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const archiver = require('archiver');

// ==================== JSON Settings ====================

function getBackendDir() {
    let dir = null;
    try {
        const { app } = require('electron');
        if (app && typeof app.getPath === 'function') {
            dir = path.join(app.getPath('userData'), 'backend');
        }
    } catch { }

    if (!dir) {
        dir = path.join(os.homedir(), 'Library', 'Application Support', 'videokit', 'backend');
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getAllCandidateBackendDirs() {
    const list = [getBackendDir()];
    try {
        const sharedProfile = require('./sharedProfile');
        for (const profileDir of sharedProfile.getCandidateProfileDirs()) {
            const candidate = path.join(profileDir, 'backend');
            if (!list.includes(candidate) && fs.existsSync(candidate)) list.push(candidate);
        }
    } catch { }
    try {
        const legacy1 = path.join(os.homedir(), 'Library', 'Application Support', 'videokit', 'backend');
        if (!list.includes(legacy1) && fs.existsSync(legacy1)) list.push(legacy1);
    } catch { }
    try {
        const legacy2 = path.join(os.homedir(), 'Library', 'Application Support', 'pymediatools', 'backend');
        if (!list.includes(legacy2) && fs.existsSync(legacy2)) list.push(legacy2);
    } catch { }
    try {
        const workspaceDir = path.join(__dirname, '..', '..', 'backend');
        if (!list.includes(workspaceDir) && fs.existsSync(workspaceDir)) list.push(workspaceDir);
    } catch { }
    return list;
}

function getSecureTmpDir(subDir) {
    let baseDir;
    try {
        const { app } = require('electron');
        baseDir = path.join(app.getPath('userData'), 'tmp');
    } catch {
        baseDir = path.join(os.homedir(), '.videokit_tmp');
    }
    const dir = subDir ? path.join(baseDir, subDir) : baseDir;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function secureTmpFile(prefix, ext) {
    const dir = getSecureTmpDir();
    return path.join(dir, `${prefix}_${crypto.randomUUID()}${ext || ''}`);
}

function readJSON(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

function writeJSON(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// Gladia Keys
function getGladiaKeysPath() { return path.join(getBackendDir(), 'gladia_keys.json'); }

function loadGladiaKeys() {
    const allKeys = [];
    for (const dir of getAllCandidateBackendDirs()) {
        const file = path.join(dir, 'gladia_keys.json');
        const data = readJSON(file);
        if (data && Array.isArray(data.keys)) {
            for (const k of data.keys) {
                const clean = String(k || '').trim();
                if (clean && !allKeys.includes(clean)) allKeys.push(clean);
            }
        }
    }
    // Also check if transcription_providers.json has Gladia keys
    for (const dir of getAllCandidateBackendDirs()) {
        const transPath = path.join(dir, 'transcription_providers.json');
        const trans = readJSON(transPath);
        if (Array.isArray(trans?.providers?.gladia?.keys)) {
            for (const k of trans.providers.gladia.keys) {
                const clean = String(k || '').trim();
                if (clean && !allKeys.includes(clean)) allKeys.push(clean);
            }
        }
    }
    return { keys: allKeys };
}

function saveGladiaKeys(data) {
    let keys = Array.isArray(data?.keys) ? data.keys : [];
    keys = keys.map(k => String(k || '').trim()).filter(Boolean);
    const payload = { keys: [...new Set(keys)] };
    const primaryFile = getGladiaKeysPath();
    writeJSON(primaryFile, payload);

    // Also sync to transcription_providers.json in userData
    try {
        const transPath = getTranscriptionSettingsPath();
        const trans = readJSON(transPath) || { version: 1, providers: {} };
        if (!trans.providers) trans.providers = {};
        if (!trans.providers.gladia) trans.providers.gladia = {};
        trans.providers.gladia.keys = payload.keys;
        writeJSON(transPath, trans);
    } catch { }
}

// Cloud transcription providers (Deepgram, Groq, Gladia)
function getTranscriptionSettingsPath() { return path.join(getBackendDir(), 'transcription_providers.json'); }

function getSafeStorage() {
    try { return require('electron').safeStorage; } catch { return null; }
}

function decryptTranscriptionKeys(payload) {
    if (Array.isArray(payload?.keys) && payload.keys.length > 0) {
        return payload.keys.map(k => String(k || '').trim()).filter(Boolean);
    }
    if (!payload?.keys_encrypted) return [];
    const safeStorage = getSafeStorage();
    if (!safeStorage?.isEncryptionAvailable?.()) return [];
    try {
        const keys = JSON.parse(safeStorage.decryptString(Buffer.from(payload.keys_encrypted, 'base64')));
        return Array.isArray(keys) ? keys.map(k => String(k || '').trim()).filter(Boolean) : [];
    } catch { return []; }
}

function encryptTranscriptionKeys(keys) {
    const clean = (Array.isArray(keys) ? keys : []).map(k => String(k || '').trim()).filter(Boolean);
    const safeStorage = getSafeStorage();
    if (safeStorage?.isEncryptionAvailable?.()) {
        try {
            return {
                keys_encrypted: safeStorage.encryptString(JSON.stringify(clean)).toString('base64'),
            };
        } catch { }
    }
    return { keys: clean };
}

function normalizeProvider(value) {
    return ['deepgram', 'groq', 'gladia'].includes(value) ? value : null;
}

function getEffectiveConcurrency(config) {
    return 1;
}

function loadTranscriptionProviders() {
    const commonPath = getTranscriptionSettingsPath();
    const raw = readJSON(commonPath);
    
    // Auto-migrate from all candidate backend dirs
    const candidateDirs = getAllCandidateBackendDirs();
    const mergedProviders = { deepgram: [], groq: [], gladia: [] };
    let foundPrimary = null;
    let foundConcurrency = null;

    for (const dir of candidateDirs) {
        const file = path.join(dir, 'transcription_providers.json');
        const fileData = readJSON(file);
        if (fileData) {
            if (!foundPrimary && fileData.primary) foundPrimary = fileData.primary;
            if (!foundConcurrency && fileData.concurrency) foundConcurrency = fileData.concurrency;
            for (const name of ['deepgram', 'groq', 'gladia']) {
                const p = fileData.providers?.[name];
                if (p) {
                    const keys = decryptTranscriptionKeys(p);
                    for (const k of keys) {
                        if (k && !mergedProviders[name].includes(k)) mergedProviders[name].push(k);
                    }
                }
            }
        }
    }

    // Always merge historical gladia_keys.json into gladia provider
    const gladiaLegacy = loadGladiaKeys().keys || [];
    for (const k of gladiaLegacy) {
        if (k && !mergedProviders.gladia.includes(k)) mergedProviders.gladia.push(k);
    }

    const primary = normalizeProvider(foundPrimary || raw?.primary) || 'gladia';
    const allProviders = ['deepgram', 'groq', 'gladia'];
    const others = allProviders.filter(p => p !== primary);

    const result = {
        primary,
        fallback: others[0] || 'groq',
        rescue: others[1] || 'gladia',
        concurrency: 1,
        providers: {
            deepgram: { keys: mergedProviders.deepgram, source: mergedProviders.deepgram.length ? 'saved' : 'none' },
            groq: { keys: mergedProviders.groq, source: mergedProviders.groq.length ? 'saved' : 'none' },
            gladia: { keys: mergedProviders.gladia, source: mergedProviders.gladia.length ? 'saved' : 'none' }
        }
    };

    // If common storage was missing, persist the merged keys now
    if (!raw || !raw.providers || (!Array.isArray(raw.providers?.gladia?.keys) && !raw.providers?.gladia?.keys_encrypted)) {
        try {
            saveTranscriptionProviders({
                primary: result.primary,
                concurrency: result.concurrency,
                deepgram_keys: result.providers.deepgram.keys,
                groq_keys: result.providers.groq.keys,
                gladia_keys: result.providers.gladia.keys,
            });
        } catch (_) { }
    }

    return result;
}

function getPublicTranscriptionProviders() {
    const data = loadTranscriptionProviders();
    const maskKey = key => {
        const value = String(key || '');
        if (value.length <= 8) return '••••••••';
        return `${value.slice(0, 4)}••••${value.slice(-4)}`;
    };
    return {
        primary: data.primary,
        fallback: data.fallback,
        rescue: data.rescue,
        concurrency: data.concurrency,
        providers: Object.fromEntries(Object.entries(data.providers).map(([name, item]) => [name, {
            configured: item.keys.length > 0,
            keyCount: item.keys.length,
            keyPreviews: item.keys.map(maskKey),
            editableKeys: item.keys || [],
            source: item.source,
        }])),
    };
}

function saveTranscriptionProviders(input = {}) {
    const existing = loadTranscriptionProviders();
    const providers = {};
    const plainGladiaKeys = [];
    for (const name of ['deepgram', 'groq', 'gladia']) {
        let keys;
        if (Object.prototype.hasOwnProperty.call(input, `${name}_keys`)) {
            keys = (Array.isArray(input[`${name}_keys`]) ? input[`${name}_keys`] : [])
                .map(k => String(k || '').trim()).filter(Boolean);
        } else {
            keys = existing.providers?.[name]?.keys || [];
        }
        const uniqueKeys = [...new Set(keys)];
        if (name === 'gladia') plainGladiaKeys.push(...uniqueKeys);
        providers[name] = encryptTranscriptionKeys(uniqueKeys);
    }

    const primary = normalizeProvider(input.primary) || normalizeProvider(existing.primary) || 'gladia';
    const allProviders = ['deepgram', 'groq', 'gladia'];
    const others = allProviders.filter(p => p !== primary);
    // 总设置只服务于其他转录入口，固定串行。自动剪辑会在每次请求中单独覆盖。
    const concurrency = 1;

    const payload = {
        version: 1,
        primary,
        fallback: others[0] || 'groq',
        rescue: others[1] || 'gladia',
        concurrency,
        providers,
    };

    // 保存是“权威覆盖”，同步所有非源码仓库的用户数据候选目录（绝不写入源码仓库 backend/ 目录）。
    const workspaceDir = path.resolve(__dirname, '..', '..', 'backend');
    const candidateDirs = getAllCandidateBackendDirs().filter(dir => path.resolve(dir) !== workspaceDir);
    for (const dir of candidateDirs) {
        try { writeJSON(path.join(dir, 'transcription_providers.json'), payload); } catch { }
    }

    // 3. Keep gladia_keys.json in sync in userData for legacy compatibility
    try {
        const gladiaPayload = { keys: plainGladiaKeys };
        writeJSON(getGladiaKeysPath(), gladiaPayload);
        for (const dir of candidateDirs) {
            try { writeJSON(path.join(dir, 'gladia_keys.json'), gladiaPayload); } catch { }
        }
    } catch { }

    return getPublicTranscriptionProviders();
}

// Gemini Keys
const DEFAULT_GEMINI_PROMPT = "ElevenLabs 配音文案格式化助手 — 为祷告/宣告/属灵鼓励/短视频旁白文案添加情感标签、拆句断行、排节奏，可直接复制粘贴用于 ElevenLabs 生成配音\n\n## 核心用途\n用于 ElevenLabs 配音\n场景：祷告 / 宣告 / 属灵鼓励 / 短视频旁白\n需要可直接复制粘贴使用\n\n## 情感标签（最重要）\n✅ 只用情感 / 语气标签（如 [calm] [reverent] [faith-filled]）\n❌ 不要 emoji\n❌ 不要解释标签含义\n标签要：克制、稳定、不浮夸、不戏剧化\n\n## 节奏与结构\n每段都有清晰停顿\n常用：[pause]\n适合：跟读、默读、夜间 / 安静场景\n长文也要分层，不能一口气读完\n\n## 语气取向\n偏向：祷告感、安抚感、权柄但不咆哮\n避免：情绪炸裂、表演感、过度煽动\n\n## 内容处理原则\n❌ 不改原文意思\n❌ 不擅自删句\n❌ 不加新神学内容\n❌ 不删除标题\n对于文案中关于上帝的单词、代词都要标准的首字母大写（如 God / He / Him / His / Lord / Father）\n只做三件事：拆句断行、排节奏、加合适的情感标签\n\n## 输出要求 - 分两部分\n你需要输出两个结果，用 ||| 分隔：\n1. 加标签结果：带情感标签的完整文案（用于 ElevenLabs 配音）\n2. 断句结果：根据标签合理断行后的文案（用于字幕显示）\n\n断行规则：\n- 断句合理，符合语言习惯\n- 每行不超过 4 个单词，便于字幕显示\n- 也不要太短（至少有完整的意思单元）\n- 在 [pause] 标签处自然断行\n- 断句结果不包含情感标签，只保留纯文本\n- ⚠️ 断句结果不包含省略号（...），省略号仅用于配音的加标签结果\n\n输出格式示例：\n[calm] Lord... I come before You today, with a grateful heart...\n|||\nLord,\nI come before You today,\nwith a grateful heart.\n\n## 批量处理输出规则\n你需要处理多条文案，每条以 [编号] 开头。\n对于每条文案，输出格式为：[编号] 加标签结果|||断句结果\n⚠️ 断句结果中的换行用 \\\\n 表示（字面的反斜杠n），不要真正换行，保持每条结果在同一行。\n每条结果占一行。";

function getGeminiKeysPath() { return path.join(getBackendDir(), 'gemini_keys.json'); }
function loadGeminiKeys() {
    const data = readJSON(getGeminiKeysPath()) || { keys: [], tts_keys: [] };
    const mergedKeys = [];
    const mergedTtsKeys = [];
    const addClean = (arr, target) => {
        if (!Array.isArray(arr)) return;
        for (const k of arr) {
            const clean = typeof k === 'string' ? k.trim() : '';
            if (clean && !target.includes(clean)) target.push(clean);
        }
    };
    addClean(data.keys, mergedKeys);
    addClean(data.tts_keys, mergedTtsKeys);
    for (const dir of getAllCandidateBackendDirs()) {
        const candidate = readJSON(path.join(dir, 'gemini_keys.json'));
        if (candidate) {
            addClean(candidate.keys, mergedKeys);
            addClean(candidate.tts_keys, mergedTtsKeys);
        }
    }
    data.keys = mergedKeys;
    data.tts_keys = mergedTtsKeys.length ? mergedTtsKeys : [...mergedKeys];
    if (!data.tts_model) data.tts_model = 'gemini-2.5-flash-preview-tts';
    // 迁移旧版界面曾保存的无效/非标准模型 ID。
    const legacyModelMap = {
        'gemini-3.1-pro': 'gemini-3.1-pro-preview',
        'gemini-3.1-flash': 'gemini-3.5-flash',
        'gemma-4-26b-it': 'gemma-4-26b-a4b-it',
    };
    if (legacyModelMap[data.model]) data.model = legacyModelMap[data.model];
    if (!data.model) data.model = 'gemini-3.5-flash-lite';
    if (!data.prompt || !data.prompt.trim()) {
        data.prompt = DEFAULT_GEMINI_PROMPT;
    }
    return data;
}
function saveGeminiKeys(data) {
    const existing = readJSON(getGeminiKeysPath()) || {};
    const next = { ...existing, ...data };
    if (Array.isArray(next.keys)) {
        next.keys = next.keys.map(k => typeof k === 'string' ? k.trim() : '').filter(Boolean);
    }
    if (Array.isArray(next.tts_keys)) {
        next.tts_keys = next.tts_keys.map(k => typeof k === 'string' ? k.trim() : '').filter(Boolean);
    }
    writeJSON(getGeminiKeysPath(), next);
}

// ElevenLabs Settings
function getElevenLabsSettingsPath() { return path.join(getBackendDir(), 'elevenlabs_settings.json'); }
function loadElevenLabsSettings() {
    const data = readJSON(getElevenLabsSettingsPath()) || {};
    let keys = data.api_keys || [];
    if (typeof keys === 'string') keys = [keys];
    if (keys.length === 0 && data.api_key) keys = [data.api_key];
    keys = keys.filter(k => typeof k === 'string' && k.trim());
    return {
        api_key: keys[0] || '',
        api_keys: keys,
        use_web_token: !!data.use_web_token
    };
}
function saveElevenLabsSettings(inputData) {
    const existingData = readJSON(getElevenLabsSettingsPath()) || {};
    let keys = inputData.api_keys || [];
    if (typeof keys === 'string') keys = [keys];
    if (keys.length === 0 && inputData.api_key) keys = [inputData.api_key];
    keys = keys.filter(k => typeof k === 'string' && k.trim());
    keys = [...new Set(keys.map(k => k.trim()))];

    const existingStatus = normalizeElevenLabsKeysWithStatus(existingData.keys_with_status);
    const existingByKey = new Map(existingStatus.map(entry => [entry.key, entry]));
    const keysWithStatus = keys.map(key => ({
        ...(existingByKey.get(key) || {}),
        key,
        enabled: true,
        manual_disabled: false,
        auto_disabled: false,
        auto_disabled_reason: ''
    }));

    const payload = {
        ...existingData,
        api_key: keys[0] || '',
        api_keys: keys,
        keys_with_status: keysWithStatus
    };

    if (inputData.use_web_token !== undefined) {
        payload.use_web_token = !!inputData.use_web_token;
    }

    writeJSON(getElevenLabsSettingsPath(), payload);
    return payload;
}

// ElevenLabs Keys with Status
function normalizeElevenLabsKeysWithStatus(value) {
    if (Array.isArray(value)) {
        return value
            .map(entry => typeof entry === 'string' ? { key: entry, enabled: true } : entry)
            .filter(entry => entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key.trim());
    }
    if (typeof value === 'string' && value.trim()) {
        return [{ key: value.trim(), enabled: true }];
    }
    if (value && typeof value === 'object') {
        return Object.values(value)
            .map(entry => typeof entry === 'string' ? { key: entry, enabled: true } : entry)
            .filter(entry => entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key.trim());
    }
    return [];
}

function loadElevenLabsKeysWithStatus() {
    const data = readJSON(getElevenLabsSettingsPath()) || {};
    const kws = normalizeElevenLabsKeysWithStatus(data.keys_with_status);
    if (kws.length > 0) return kws;
    const legacyKeys = Array.isArray(data.api_keys) ? data.api_keys : (data.api_keys ? [data.api_keys] : []);
    return legacyKeys.map(k => ({ key: k, enabled: true })).filter(entry => entry.key && entry.key.trim());
}
function saveElevenLabsKeysWithStatus(keysData) {
    const data = readJSON(getElevenLabsSettingsPath()) || {};
    data.keys_with_status = normalizeElevenLabsKeysWithStatus(keysData);
    writeJSON(getElevenLabsSettingsPath(), data);
}

function addElevenLabsKey(key) {
    const cleanKey = typeof key === 'string' ? key.trim() : '';
    if (!cleanKey) throw new Error('Key 不能为空');
    const data = readJSON(getElevenLabsSettingsPath()) || {};
    const keys = loadElevenLabsKeysWithStatus();
    if (keys.some(entry => entry.key === cleanKey)) throw new Error('Key 已存在');
    keys.push({
        key: cleanKey,
        enabled: true,
        manual_disabled: false,
        auto_disabled: false,
        auto_disabled_reason: ''
    });
    data.keys_with_status = keys;
    data.api_keys = keys.map(entry => entry.key);
    data.api_key = data.api_keys[0] || '';
    writeJSON(getElevenLabsSettingsPath(), data);
}

function deleteElevenLabsKey(index) {
    const data = readJSON(getElevenLabsSettingsPath()) || {};
    const keys = loadElevenLabsKeysWithStatus();
    if (!Number.isInteger(index) || index < 0 || index >= keys.length) throw new Error('索引无效');
    keys.splice(index, 1);
    data.keys_with_status = keys;
    data.api_keys = keys.map(entry => entry.key);
    data.api_key = data.api_keys[0] || '';
    writeJSON(getElevenLabsSettingsPath(), data);
}

function updateElevenLabsKeys(actionData) {
    const data = readJSON(getElevenLabsSettingsPath()) || {};
    const keys = loadElevenLabsKeysWithStatus();
    const action = actionData && actionData.action;

    if (action === 'toggle') {
        const index = actionData.index;
        if (!Number.isInteger(index) || index < 0 || index >= keys.length) throw new Error('索引无效');
        const nextEnabled = keys[index].enabled === false;
        keys[index].enabled = nextEnabled;
        keys[index].manual_disabled = !nextEnabled;
        if (nextEnabled) {
            keys[index].auto_disabled = false;
            keys[index].auto_disabled_reason = '';
        }
        data.keys_with_status = keys;
        writeJSON(getElevenLabsSettingsPath(), data);
        return { enabled: nextEnabled };
    }

    if (action === 'move') {
        const from = actionData.from;
        const to = actionData.to;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= keys.length || to < 0 || to >= keys.length) {
            throw new Error('索引无效');
        }
        const [item] = keys.splice(from, 1);
        keys.splice(to, 0, item);
        data.keys_with_status = keys;
        data.api_keys = keys.map(entry => entry.key);
        data.api_key = data.api_keys[0] || '';
        writeJSON(getElevenLabsSettingsPath(), data);
        return { message: '顺序已更新' };
    }

    if (action === 'reorder') {
        const nextKeys = normalizeElevenLabsKeysWithStatus(actionData.keys);
        data.keys_with_status = nextKeys;
        data.api_keys = nextKeys.map(entry => entry.key);
        data.api_key = data.api_keys[0] || '';
        writeJSON(getElevenLabsSettingsPath(), data);
        return { message: '顺序已更新' };
    }

    throw new Error('无效操作');
}

// Replace Rules
function getReplaceRulesPath() { return path.join(getBackendDir(), 'replace_rules.json'); }
function loadReplaceRules() { return readJSON(getReplaceRulesPath()) || { rules: [] }; }
function saveReplaceRules(data) { writeJSON(getReplaceRulesPath(), data); }

// ==================== File Operations ====================

function openFolder(folderPath) {
    if (!folderPath || typeof folderPath !== 'string') {
        return Promise.reject(new Error('路径无效'));
    }
    let expandedPath = folderPath;
    if (expandedPath === '~') {
        expandedPath = os.homedir();
    } else if (expandedPath.startsWith('~/') || expandedPath.startsWith('~\\')) {
        expandedPath = path.join(os.homedir(), expandedPath.slice(2));
    }

    if (!fs.existsSync(expandedPath)) {
        try {
            fs.mkdirSync(expandedPath, { recursive: true });
        } catch {
            throw new Error('路径不存在且创建失败: ' + expandedPath);
        }
    }

    try {
        const { shell } = require('electron');
        const stat = fs.statSync(expandedPath);
        if (!stat.isDirectory()) {
            shell.showItemInFolder(expandedPath);
            return Promise.resolve({ message: '已在文件夹中显示' });
        }
        return shell.openPath(expandedPath).then((errMsg) => {
            if (errMsg) throw new Error(errMsg);
            return { message: '已打开' };
        });
    } catch (err) {
        return Promise.reject(new Error('打开文件夹失败: ' + err.message));
    }
}

// Upload directory
const UPLOAD_DIR = path.join(getBackendDir(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function uploadFile(buffer, filename) {
    const safeName = path.basename(String(filename || 'upload.bin')).replace(/[\0]/g, '') || 'upload.bin';
    const destPath = path.join(UPLOAD_DIR, safeName);
    fs.writeFileSync(destPath, buffer);
    return { path: destPath };
}

function createZip(files, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', () => resolve(outputPath));
        archive.on('error', reject);
        archive.pipe(output);
        for (const f of files) {
            if (fs.existsSync(f)) {
                archive.file(f, { name: path.basename(f) });
            }
        }
        archive.finalize();
    });
}

// ==================== Language Config ====================

const LANGUAGES = {
    en: { name: 'en', display: '英文', gladia: 'english' },
    ja: { name: 'ja', display: '日文', gladia: 'japanese' },
    ko: { name: 'ko', display: '韩文', gladia: 'korean' },
    es: { name: 'es', display: '西班牙文', gladia: 'spanish' },
    fr: { name: 'fr', display: '法文', gladia: 'french' },
    de: { name: 'de', display: '德文', gladia: 'german' },
    pt: { name: 'pt', display: '葡萄牙文', gladia: 'portuguese' },
    it: { name: 'it', display: '意大利文', gladia: 'italian' },
    zh: { name: 'zh', display: '中文', gladia: 'chinese' },
    ar: { name: 'ar', display: '阿拉伯文', gladia: 'arabic' },
    ru: { name: 'ru', display: '俄文', gladia: 'russian' },
};

function getLanguages() {
    return Object.entries(LANGUAGES).map(([code, lang]) => ({
        code,
        name: lang.name,
        display: lang.display,
    }));
}

module.exports = {
    getBackendDir,
    getSecureTmpDir,
    secureTmpFile,
    readJSON,
    writeJSON,
    loadGladiaKeys,
    saveGladiaKeys,
    loadTranscriptionProviders,
    getPublicTranscriptionProviders,
    saveTranscriptionProviders,
    getEffectiveConcurrency,
    loadGeminiKeys,
    saveGeminiKeys,
    loadElevenLabsSettings,
    saveElevenLabsSettings,
    loadElevenLabsKeysWithStatus,
    saveElevenLabsKeysWithStatus,
    addElevenLabsKey,
    deleteElevenLabsKey,
    updateElevenLabsKeys,
    loadReplaceRules,
    saveReplaceRules,
    openFolder,
    uploadFile,
    createZip,
    getLanguages,
    LANGUAGES,
    UPLOAD_DIR,
    DEFAULT_GEMINI_PROMPT,
};
