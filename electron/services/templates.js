/**
 * templates.js — 视频模板预设 CRUD 服务
 * 
 * 存储位置: userData/videokit-templates/
 *   - index.json          模板索引（轻量，含缩略图 base64）
 *   - tpl_<id>.json       模板完整数据（项目工程数据）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const sharedProfile = require('./sharedProfile');

function safeTemplateId(id) {
    const clean = path.basename(String(id || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!clean || clean === '.' || clean === '..') {
        throw new Error('无效的模板 ID');
    }
    return clean;
}

function getTemplatesDir() {
    const dir = path.join(app.getPath('userData'), 'videokit-templates');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function getAllTemplateDirs() {
    const dirs = sharedProfile.getCandidateTemplateDirs();
    return dirs.length ? dirs : [getTemplatesDir()];
}

function getIndexPath() {
    return path.join(getTemplatesDir(), 'index.json');
}

function readIndex() {
    const byId = new Map();
    for (const dir of [...getAllTemplateDirs()].reverse()) {
        const p = path.join(dir, 'index.json');
        if (!fs.existsSync(p)) continue;
        try {
            const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
            if (!Array.isArray(arr)) continue;
            for (const item of arr) {
                if (!item || !item.id) continue;
                const existing = byId.get(item.id);
                const oldTime = existing ? (Date.parse(existing.updatedAt || existing.createdAt || '') || 0) : -1;
                const newTime = Date.parse(item.updatedAt || item.createdAt || '') || 0;
                if (!existing || newTime >= oldTime) {
                    byId.set(item.id, item);
                }
            }
        } catch { }
    }
    return [...byId.values()].sort((a, b) => (Date.parse(b.updatedAt || b.createdAt || '') || 0) - (Date.parse(a.updatedAt || a.createdAt || '') || 0));
}

function writeIndex(index) {
    const body = JSON.stringify(index, null, 2);
    fs.writeFileSync(getIndexPath(), body, 'utf-8');
    if (!sharedProfile.isIsolatedTestProfile()) {
        for (const dir of getAllTemplateDirs()) {
            const p = path.join(dir, 'index.json');
            if (path.resolve(p) === path.resolve(getIndexPath())) continue;
            try {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(p, body, 'utf-8');
            } catch { }
        }
    }
}

/**
 * 列出所有模板（返回索引信息，不含完整工程数据）
 */
function listTemplates() {
    return readIndex();
}

/**
 * 获取单个模板的完整数据
 */
function getTemplate(id) {
    const safeId = safeTemplateId(id);
    for (const dir of getAllTemplateDirs()) {
        const filePath = path.join(dir, `${safeId}.json`);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
    }
    throw new Error(`模板不存在: ${safeId}`);
}

/**
 * 保存模板
 * @param {object} params
 * @param {string} params.name - 模板名称
 * @param {string} [params.description] - 描述
 * @param {string} [params.thumbnail] - 缩略图 base64
 * @param {string[]} [params.tags] - 标签
 * @param {object} params.projectData - 完整工程数据 (collectProjectData 的输出)
 * @param {string} [params.id] - 已有 ID（更新时传入）
 */
function saveTemplate({ id, name, description, thumbnail, tags, projectData }) {
    const now = new Date().toISOString();
    const templateId = id ? safeTemplateId(id) : `tpl_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    // 完整数据写入独立文件
    const fullData = {
        id: templateId,
        name,
        description: description || '',
        thumbnail: thumbnail || '',
        tags: tags || [],
        createdAt: now,
        updatedAt: now,
        projectData,
    };

    const filePath = path.join(getTemplatesDir(), `${templateId}.json`);

    // 如果是更新，保留原始创建时间
    if (id) {
        for (const dir of getAllTemplateDirs()) {
            const candidate = path.join(dir, `${templateId}.json`);
            if (fs.existsSync(candidate)) {
                try {
                    const existing = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
                    fullData.createdAt = existing.createdAt || now;
                    break;
                } catch { /* use now */ }
            }
        }
    }

    const fullBody = JSON.stringify(fullData, null, 2);
    fs.writeFileSync(filePath, fullBody, 'utf-8');
    if (!sharedProfile.isIsolatedTestProfile()) {
        for (const dir of getAllTemplateDirs()) {
            const mirrorPath = path.join(dir, `${templateId}.json`);
            if (path.resolve(mirrorPath) === path.resolve(filePath)) continue;
            try {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(mirrorPath, fullBody, 'utf-8');
            } catch { }
        }
    }

    // 更新索引
    const index = readIndex();
    const existingIdx = index.findIndex(t => t.id === templateId);
    const indexEntry = {
        id: templateId,
        name,
        description: description || '',
        thumbnail: thumbnail || '',
        tags: tags || [],
        createdAt: fullData.createdAt,
        updatedAt: now,
        // 摘要信息
        taskCount: projectData?.tasks?.length || 0,
    };

    if (existingIdx >= 0) {
        index[existingIdx] = indexEntry;
    } else {
        index.unshift(indexEntry); // 新模板排在最前面
    }

    writeIndex(index);
    return { id: templateId, success: true };
}

/**
 * 删除模板
 */
function deleteTemplate(id) {
    const safeId = safeTemplateId(id);
    // 删除数据文件
    for (const dir of getAllTemplateDirs()) {
        const filePath = path.join(dir, `${safeId}.json`);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch { }
        }
    }

    // 更新索引
    const index = readIndex();
    const filtered = index.filter(t => t.id !== safeId);
    writeIndex(filtered);

    return { success: true };
}

/**
 * 重命名模板
 */
function renameTemplate(id, newName) {
    const safeId = safeTemplateId(id);
    let targetPath = '';
    for (const dir of getAllTemplateDirs()) {
        const candidate = path.join(dir, `${safeId}.json`);
        if (fs.existsSync(candidate)) {
            targetPath = candidate;
            break;
        }
    }
    if (!targetPath) {
        throw new Error(`模板不存在: ${safeId}`);
    }

    // 更新数据文件
    const data = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
    data.name = newName;
    data.updatedAt = new Date().toISOString();
    const body = JSON.stringify(data, null, 2);
    fs.writeFileSync(path.join(getTemplatesDir(), `${safeId}.json`), body, 'utf-8');
    if (!sharedProfile.isIsolatedTestProfile()) {
        for (const dir of getAllTemplateDirs()) {
            const mirrorPath = path.join(dir, `${safeId}.json`);
            try {
                if (fs.existsSync(mirrorPath)) fs.writeFileSync(mirrorPath, body, 'utf-8');
            } catch { }
        }
    }

    // 更新索引
    const index = readIndex();
    const entry = index.find(t => t.id === safeId);
    if (entry) {
        entry.name = newName;
        entry.updatedAt = data.updatedAt;
    }
    writeIndex(index);

    return { success: true };
}

module.exports = {
    listTemplates,
    getTemplate,
    saveTemplate,
    deleteTemplate,
    renameTemplate,
};
