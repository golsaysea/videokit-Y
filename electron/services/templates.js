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
        try {
            let arr;
            try {
                arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
                if (!Array.isArray(arr)) throw new Error('Invalid template index');
            } catch (_) {
                // Recover summaries from authoritative project files only when the
                // index is missing or damaged. Never replace project contents.
                arr = [];
                if (fs.existsSync(dir)) {
                    for (const filename of fs.readdirSync(dir)) {
                        if (!/^tpl_[a-zA-Z0-9._-]+\.json$/.test(filename)) continue;
                        try {
                            const data = JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8'));
                            if (!data.id || `${safeTemplateId(data.id)}.json` !== filename || !data.projectData) continue;
                            arr.push({id:data.id, name:data.name || '', description:data.description || '',
                                thumbnail:data.thumbnail || '', tags:data.tags || [], createdAt:data.createdAt,
                                updatedAt:data.updatedAt, taskCount:data.projectData.tasks?.length || 0});
                        } catch (_) { /* A damaged file must not hide healthy templates. */ }
                    }
                    if (arr.length) {
                        try {
                            if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.before-recovery-${Date.now()}`);
                            const temp = `${p}.recovery-${process.pid}.tmp`;
                            fs.writeFileSync(temp, JSON.stringify(arr, null, 2), 'utf8');
                            fs.renameSync(temp, p);
                        } catch (_) { /* Keep recovered summaries available even on a read-only directory. */ }
                    }
                }
            }
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
    const items = [...byId.values()].sort((a, b) => (Date.parse(b.updatedAt || b.createdAt || '') || 0) - (Date.parse(a.updatedAt || a.createdAt || '') || 0));
    try {
        const order = JSON.parse(fs.readFileSync(path.join(getTemplatesDir(), 'order.json'), 'utf8'));
        if (Array.isArray(order)) {
            const ranks = new Map(order.map((id,i) => [id,i]));
            items.sort((a,b) => (ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.id) ?? Number.MAX_SAFE_INTEGER));
        }
    } catch (_) {}
    return items;
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
const templateMetadataCache = new Map();
function listTemplates() {
    return readIndex().map(item => {
        for (const dir of getAllTemplateDirs()) {
            const file = path.join(dir, `${safeTemplateId(item.id)}.json`);
            if (!fs.existsSync(file)) continue;
            try {
                const stat = fs.statSync(file);
                const key = `${file}:${stat.size}:${stat.mtimeMs}`;
                let metadata = templateMetadataCache.get(item.id);
                if (!metadata || metadata.key !== key) {
                    const data = JSON.parse(fs.readFileSync(file,'utf8'));
                    const tasks = data.projectData?.tasks || [];
                    const types = new Set();
                    for (const task of tasks) {
                        for (const overlay of task.overlays || []) {
                            if (overlay.type === 'scroll') types.add('滚动字幕');
                            if (overlay.type === 'textcard') types.add('文字卡片');
                        }
                        if (task.segments?.length) types.add('普通字幕');
                    }
                    metadata = {key, templateType:[...types].sort().join(' / ') || '视频', sizeBytes:stat.size};
                    templateMetadataCache.set(item.id,metadata);
                }
                return {...item,templateType:metadata.templateType,sizeBytes:metadata.sizeBytes};
            } catch (_) {}
        }
        return {...item,templateType:'未知',sizeBytes:0};
    });
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
function saveTemplate({ id, name, description, thumbnail, tags, projectData, folderId }) {
    if (folderId !== undefined && folderId !== '' && !readTemplateFolders().folders.some(folder => folder.id === folderId)) {
        throw new Error('保存目标文件夹不存在，请重新选择文件夹');
    }
    const now = new Date().toISOString();
    const templateId = id ? safeTemplateId(id) : `tpl_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    if (id) backupTemplate(templateId);
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
    if (folderId !== undefined) moveTemplatesToFolder([templateId], folderId || '');
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

function backupTemplate(id) {
    const file = path.join(getTemplatesDir(), `${safeTemplateId(id)}.json`);
    if (!fs.existsSync(file)) return;
    const backups = path.join(getTemplatesDir(), 'backups', safeTemplateId(id));
    fs.mkdirSync(backups, { recursive: true });
    fs.copyFileSync(file, path.join(backups, `${Date.now()}-${crypto.randomUUID().slice(0,8)}.json`));
}
function reorderTemplates(ids) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('无效的模板顺序');
    const existing = readIndex().map(item => item.id);
    if (ids.length !== existing.length || ids.some(id => !existing.includes(id))) throw new Error('模板列表已变化，请重新打开模板库后排序');
    const target = path.join(getTemplatesDir(), 'order.json');
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ids), 'utf8'); fs.renameSync(tmp, target);
    return { success: true };
}
function updateTemplateThumbnail(id, thumbnail) {
    if (typeof thumbnail !== 'string') throw new Error('无效的封面');
    const template = getTemplate(id);
    backupTemplate(id);
    template.thumbnail = thumbnail;
    const file = path.join(getTemplatesDir(), `${safeTemplateId(id)}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(template,null,2), 'utf8'); fs.renameSync(tmp,file);
    const index = readIndex();
    const entry = index.find(item => item.id === id);
    if (entry) entry.thumbnail = thumbnail;
    writeIndex(index);
    return { success:true };
}
module.exports.reorderTemplates = reorderTemplates;
module.exports.updateTemplateThumbnail = updateTemplateThumbnail;

function readTemplateFolders() {
    const file = path.join(getTemplatesDir(),'folders.json');
    if (!fs.existsSync(file)) return {folders:[],assignments:{}};
    const data = JSON.parse(fs.readFileSync(file,'utf8'));
    if (!Array.isArray(data.folders) || !data.assignments || typeof data.assignments !== 'object' || Array.isArray(data.assignments)) throw new Error('文件夹数据无效');
    return data;
}
function writeTemplateFolders(data) {
    const file = path.join(getTemplatesDir(),'folders.json');
    if (fs.existsSync(file)) fs.copyFileSync(file,file+'.bak');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp,JSON.stringify(data,null,2),'utf8');fs.renameSync(tmp,file);
}
function createTemplateFolder(name) {
    name=String(name || '').trim();if(!name || name.length>200)throw new Error('请输入有效的文件夹名称（最多200字）');
    const data=readTemplateFolders();
    if(data.folders.some(f=>f.name===name))throw new Error('已有同名文件夹');
    const now=new Date().toISOString();const folder={id:'folder_'+crypto.randomUUID(),name,createdAt:now,updatedAt:now};
    data.folders.push(folder);writeTemplateFolders(data);return {success:true,folder};
}
function renameTemplateFolder(id,name) {
    name=String(name || '').trim();if(!name || name.length>200)throw new Error('请输入有效的文件夹名称（最多200字）');
    const data=readTemplateFolders(),folder=data.folders.find(f=>f.id===id);if(!folder)throw new Error('文件夹不存在');
    if(data.folders.some(f=>f.id!==id&&f.name===name))throw new Error('已有同名文件夹');
    folder.name=name;folder.updatedAt=new Date().toISOString();writeTemplateFolders(data);return {success:true};
}
function moveTemplatesToFolder(ids,folderId) {
    if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'))throw new Error('请选择模板');
    const data=readTemplateFolders();folderId=folderId || '';
    if(folderId&&!data.folders.some(f=>f.id===folderId))throw new Error('文件夹不存在');
    const available=new Set(readIndex().map(t=>t.id));if(ids.some(id=>!available.has(id)))throw new Error('模板不存在');
    const affected=new Set([folderId]);
    for(const id of ids){affected.add(data.assignments[id]);if(folderId)data.assignments[id]=folderId;else delete data.assignments[id];}
    for(const f of data.folders)if(affected.has(f.id))f.updatedAt=new Date().toISOString();
    writeTemplateFolders(data);return {success:true};
}
module.exports.readTemplateFolders=readTemplateFolders;
module.exports.createTemplateFolder=createTemplateFolder;
module.exports.renameTemplateFolder=renameTemplateFolder;
module.exports.moveTemplatesToFolder=moveTemplatesToFolder;

function deleteEmptyTemplateFolder(id) {
    const data=readTemplateFolders();if(!data.folders.some(f=>f.id===id))throw new Error('文件夹不存在');
    const available=new Set(readIndex().map(t=>t.id));
    if(Object.entries(data.assignments).some(([key,value])=>value===id&&available.has(key)))throw new Error('请先移出文件夹内的模板');
    data.folders=data.folders.filter(f=>f.id!==id);for(const key of Object.keys(data.assignments))if(data.assignments[key]===id)delete data.assignments[key];
    writeTemplateFolders(data);return {success:true};
}
module.exports.deleteEmptyTemplateFolder=deleteEmptyTemplateFolder;

function reorderTemplateLibrary(order){
    if(!Array.isArray(order)||order.some(id=>typeof id!=='string')||new Set(order).size!==order.length)throw new Error('无效的排列顺序');
    const data=readTemplateFolders(),expected=[...data.folders.map(f=>'f:'+f.id),...readIndex().filter(t=>!data.assignments[t.id]).map(t=>'t:'+t.id)];
    const valid=new Set(expected);if(order.length!==expected.length||order.some(id=>!valid.has(id)))throw new Error('模板库已变化，请刷新后重试');
    data.libraryOrder=order;writeTemplateFolders(data);return {success:true};
}
module.exports.reorderTemplateLibrary=reorderTemplateLibrary;
