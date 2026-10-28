const { app, BrowserWindow, ipcMain, MessageChannelMain, dialog, powerSaveBlocker, protocol, shell, net, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { Readable } = require('stream');
const ffmpegService = require('./services/ffmpeg');
const { initAutoUpdater } = require('./updater');

const { assertTrustedRenderer, isTrustedRendererUrl } = require('./services/trustedRenderer');
function handleTrusted(channel, listener) {
    return ipcMain.handle(channel, (event, ...args) => { assertTrustedRenderer(event); return listener(event, ...args); });
}
const DEV_SERVER_PORT = Number(process.env.VITE_PORT) || 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

// Node.js API 路由器 —— 替代 Python Flask 后端
const { registerAPIHandlers } = require('./apiRouter');
const persistentPresetStore = require('./services/persistentPresetStore');
const overlayPresetPackage = require('./services/overlayPresetPackage');
const sharedProfile = require('./services/sharedProfile');
const codeCacheGuard = require('./services/codeCacheGuard');

ipcMain.on('profile:runtime-paths', (event) => {
    try {
        assertTrustedRenderer(event);
        event.returnValue = { ok: true, current: app.getPath('userData'), primary: sharedProfile.getPrimarySharedProfileDir(), candidates: sharedProfile.getCandidateProfileDirs(), isolated: sharedProfile.isIsolatedTestProfile() };
    } catch (_) { event.returnValue = { ok: false }; }
});

ipcMain.on('workspace:read-startup', (event) => { try { assertTrustedRenderer(event); event.returnValue = sharedProfile.readUnifiedBatchWorkspace(); } catch (_) { event.returnValue = ''; } });
let mainWindow;
let appIsReady = false;
let powerSaveId = null;
let isQuitting = false;
const templateWindows = new Map(); // templateId → BrowserWindow
const isolatedReelsRenderers = new Map(); // requestId → BrowserWindow
let idleCacheMaintenance = null;
let manualCacheCleaning = false;
function startIdleCacheMaintenance() {
    const {powerMonitor}=require('electron');
    const {execFile}=require('child_process');
    const {createIdleCacheCleaner}=require(path.join(process.resourcesPath,'idle-cache-cleaner.js'));
    let processCheckAt=0,processBusy=true;
    const canRun=()=>{
        try{return !isQuitting&&!manualCacheCleaning&&isolatedReelsRenderers.size===0&&BrowserWindow.getAllWindows().length>0&&powerMonitor.getSystemIdleTime()>=120;}catch(_){return false;}
    };
    const isIdle=async()=>{
        if(!canRun())return false;
        for(const win of BrowserWindow.getAllWindows()){
            if(win.isDestroyed()||win.webContents.isDestroyed()||win.webContents.isLoading())return false;
            let timeout;
            try{
                const busy=await Promise.race([
                    win.webContents.executeJavaScript(`(()=>{
                        const state=typeof _reelsState==='object'?_reelsState:null;
                        return !!state?.isExporting || !!state?.isPlaying ||
                            !!state?.tasks?.some(t=>t.status==='generating'||t.concatStatus==='generating') ||
                            [...document.querySelectorAll('video,audio')].some(m=>!m.paused&&!m.ended);
                    })()`),
                    new Promise(resolve=>{timeout=setTimeout(()=>resolve(true),2000);})
                ]);
                if(busy)return false;
            }catch(_){return false;}finally{clearTimeout(timeout);}
        }
        if(process.platform==='win32'&&Date.now()-processCheckAt>10000){
            processBusy=await new Promise(resolve=>execFile('tasklist.exe',['/FI','IMAGENAME eq ffmpeg.exe','/FO','CSV','/NH'],{windowsHide:true,timeout:5000},(error,stdout)=>resolve(!!error||/"ffmpeg\.exe"/i.test(stdout))));
            processCheckAt=Date.now();
        }else if(process.platform!=='win32')processBusy=false;
        return canRun()&&!processBusy;
    };
    const userData=app.getPath('userData');
    const tmp=require('./services/settings').getSecureTmpDir();
    idleCacheMaintenance=createIdleCacheCleaner({
        canRun,isIdle,log,
        getRoots:()=>[
            ...['Cache','Code Cache','GPUCache','DawnGraphiteCache','DawnWebGPUCache'].map(name=>({path:path.join(userData,name),remove:false})),
            {path:path.join(tmp,'videokit_overlay_cache'),remove:true},
            {path:path.join(tmp,'reels-hdr-preview'),remove:true}
        ],
        clearHttpCache:async()=>{
            const sessions=new Set(BrowserWindow.getAllWindows().map(w=>w.webContents.session));
            for(const session of sessions){
                if(!canRun())break;
                await session.clearCache();
                if(canRun()&&typeof session.clearCodeCaches==='function')await session.clearCodeCaches({});
            }
        }
    });
    idleCacheMaintenance.start();
    log('[IdleCache] enabled: threshold=10GiB, target=8GiB, idle=120s, interval=300s');
}
let latestRendererCrashReport = null;

// 保留不含任务内容的崩溃诊断，用户可将该文件反馈给开发者定位问题。
function writeRendererCrashReport(details = {}) {
    const reason = String(details?.reason || '');
    // 正常退出、开发者热重载、进程主动终止 (killed/clean-exit/code 15) 不属于异常崩溃，不写入日志
    if (
        isQuitting ||
        app.isQuitting ||
        reason === 'clean-exit' ||
        reason === 'killed' ||
        details?.exitCode === 0 ||
        details?.exitCode === 15
    ) {
        return null;
    }
    try {
        const dir = path.join(app.getPath('userData'), 'diagnostics');
        fs.mkdirSync(dir, { recursive: true });
        const diagnosticFile = path.join(dir, 'renderer-crashes.jsonl');
        const report = {
            timestamp: new Date().toISOString(),
            appVersion: app.getVersion(),
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            platform: process.platform,
            arch: process.arch,
            diagnosticFile,
            ...details,
        };
        fs.appendFileSync(diagnosticFile, `${JSON.stringify(report)}\n`, 'utf8');
        latestRendererCrashReport = report;
        log(`[CrashReport] ${JSON.stringify(report)}`);
        return report;
    } catch (error) {
        log(`[CrashReport] 写入失败: ${error.message}`);
        return null;
    }
}

function getLatestRendererCrashReport() {
    if (latestRendererCrashReport) {
        const reason = String(latestRendererCrashReport.reason || '');
        if (reason === 'clean-exit' || reason === 'killed') return null;
        return latestRendererCrashReport;
    }
    try {
        const diagnosticFile = path.join(app.getPath('userData'), 'diagnostics', 'renderer-crashes.jsonl');
        if (!fs.existsSync(diagnosticFile)) return null;
        const lines = fs.readFileSync(diagnosticFile, 'utf8').trim().split('\n').filter(Boolean);
        if (!lines.length) return null;
        const last = JSON.parse(lines[lines.length - 1]);
        const reason = String(last?.reason || '');
        if (reason === 'clean-exit' || reason === 'killed') return null;
        // Windows 下旧进程退出/重启更新时 Crashpad 管道先断开会产生 exitCode = -36861 (0xFFFF7003)，
        // 新进程刚启动读取磁盘日志时不应将其当作当前运行崩溃告警展示
        if (Number(last?.exitCode) === -36861) return null;
        // 只有 60 秒内发生的真实崩溃（比如异常闪退后刚拉起恢复）才返回给前端展示，避免冷启动翻出历史旧账
        const reportTime = new Date(last?.timestamp).getTime();
        if (isNaN(reportTime) || Date.now() - reportTime > 60000) return null;
        latestRendererCrashReport = { ...last, diagnosticFile };
        return latestRendererCrashReport;
    } catch (error) {
        log(`[CrashReport] 读取失败: ${error.message}`);
        return null;
    }
}

function _savedBatchTaskCount(raw) {
    if (!raw) return 0;
    try {
        const data = JSON.parse(raw);
        if (Array.isArray(data.tabs)) {
            return data.tabs.reduce((sum, tab) => sum + (Array.isArray(tab?.tasks) ? tab.tasks.length : 0), 0);
        }
        return Array.isArray(data.tasks) ? data.tasks.length : 0;
    } catch {
        return 0;
    }
}

/**
 * 开发版由旧 file:// 页面切到本地 Vite 服务后，Chromium 会使用另一套
 * localStorage origin。仅在 localhost 没有有效任务时，把旧 file:// 数据复制过来；
 * 当前开发数据始终优先，避免覆盖用户刚做的新工程。
 */
async function migrateLegacyFileStorageToDevOrigin(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;

    let legacyWindow = null;
    try {
        const hasWorkspace = Boolean(sharedProfile.readUnifiedBatchWorkspace());
        if(hasWorkspace){log('[Workspace] Valid disk workspace: skip legacy cache migration');return false;}
        const currentStore = await targetWindow.webContents.executeJavaScript(
            'Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>{const k=localStorage.key(i);return [k,localStorage.getItem(k)]}))',
            true
        );
        if (currentStore?.videokit_disable_file_origin_migration) {
            log('[StorageMigration] 已有可靠恢复标记，跳过旧 file:// 自动迁移');
            return false;
        }
        const currentBatchCount = _savedBatchTaskCount(currentStore?.reels_batch_config_autosave);

        legacyWindow = new BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
            },
        });
        await legacyWindow.loadFile(path.join(__dirname, '../src/storage-bridge.html'));
        const legacyStore = await legacyWindow.webContents.executeJavaScript(
            'Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>{const k=localStorage.key(i);return [k,localStorage.getItem(k)]}))',
            true
        );
        const legacyBatchCount = _savedBatchTaskCount(legacyStore?.reels_batch_config_autosave);
        const merged = { ...(currentStore || {}) };
        let copied = 0;
        let restoredLegacyBatch = false;

        for (const [key, value] of Object.entries(legacyStore || {})) {
            if (merged[key] == null) {
                merged[key] = value;
                copied++;
            }
        }
        // 旧 file:// 工程明显更完整时，先备份 localhost 当前工程，再恢复旧工程。
        // 这样既能找回历史内容，也不会丢掉切换来源后新建的少量任务。
        if (legacyBatchCount > currentBatchCount) {
            if (currentStore?.reels_batch_config_autosave) {
                merged.reels_batch_config_autosave_before_file_migration = currentStore.reels_batch_config_autosave;
            }
            merged.reels_batch_config_autosave = legacyStore.reels_batch_config_autosave;
            merged.reels_batch_file_origin_migrated_at = new Date().toISOString();
            copied++;
            restoredLegacyBatch = true;
        }
        if (!copied) return false;

        const serialized = JSON.stringify(merged);
        await targetWindow.webContents.executeJavaScript(
            `(()=>{const data=${serialized};for(const [k,v] of Object.entries(data)){localStorage.setItem(k,v)};return true})()`,
            true
        );
        const finalBatchCount = restoredLegacyBatch ? legacyBatchCount : currentBatchCount;
        log(`[StorageMigration] 已从 file:// 迁移 ${copied} 个本地存储项；批量任务 ${currentBatchCount} -> ${finalBatchCount}`);

        // 批量表格恢复函数在首次 DOMContentLoaded 时已经运行过，迁移后刷新一次，
        // 让所有模块按正常初始化顺序读取迁移后的数据。
        if (restoredLegacyBatch && !targetWindow.isDestroyed()) {
            targetWindow.webContents.reloadIgnoringCache();
        }
        return true;
    } catch (error) {
        log(`[StorageMigration] 旧版数据迁移失败: ${error.message}`);
        return false;
    } finally {
        if (legacyWindow && !legacyWindow.isDestroyed()) legacyWindow.destroy();
    }
}

/** 只读导出旧 file:// 批量配置，用于核对跨 origin 丢失的任务样式。 */
async function snapshotLegacyBatchForStyleAudit(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;
    const requestPath = path.join(__dirname, '..', '.videokit-style-audit-request.json');
    if (!fs.existsSync(requestPath)) return false;
    let legacyWindow = null;
    try {
        legacyWindow = new BrowserWindow({
            show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        });
        await legacyWindow.loadFile(path.join(__dirname, '../src/storage-bridge.html'));
        const legacyRaw = await legacyWindow.webContents.executeJavaScript(
            'localStorage.getItem("reels_batch_config_autosave") || ""', true
        );
        if (!legacyRaw) throw new Error('旧 file:// 批量配置不存在');
        const auditDir = path.join(app.getPath('userData'), 'batch-recovery');
        fs.mkdirSync(auditDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputPath = path.join(auditDir, `legacy-style-audit-${stamp}.json`);
        fs.writeFileSync(outputPath, legacyRaw, 'utf-8');
        fs.renameSync(requestPath, path.join(__dirname, '..', '.videokit-style-audit-completed.json'));
        log(`[StyleAudit] 已只读导出旧批量配置 ${_savedBatchTaskCount(legacyRaw)} 条: ${outputPath}`);
        return true;
    } catch (error) {
        log(`[StyleAudit] 导出失败: ${error.message}`);
        return false;
    } finally {
        if (legacyWindow && !legacyWindow.isDestroyed()) legacyWindow.destroy();
    }
}

function _naturalTemplateNameSort(a, b) {
    return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
    });
}

/**
 * 从用户明确保存过的分队列模板重建批量任务。模板带创建时间和完整 projectData，
 * 比跨 origin 的“最后一份 localStorage”更适合作为指定日期的恢复来源。
 */
async function recoverPendingBatchFromTemplates(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;
    const requestPath = path.join(__dirname, '..', '.videokit-recovery-request.json');
    if (!fs.existsSync(requestPath)) return false;

    try {
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
        const matcher = new RegExp(request.templateNamePattern || '.*');
        const templatesDir = path.join(app.getPath('userData'), 'videokit-templates');
        const indexPath = path.join(templatesDir, 'index.json');
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        const selected = index
            .filter(item => matcher.test(String(item.name || '')))
            .filter(item => !request.createdDate || String(item.createdAt || '').startsWith(request.createdDate))
            .sort(_naturalTemplateNameSort);
        if (!selected.length) throw new Error('没有找到符合恢复条件的队列模板');

        const tasks = [];
        const seenTaskIds = new Set();
        for (const item of selected) {
            const full = JSON.parse(fs.readFileSync(path.join(templatesDir, `${item.id}.json`), 'utf-8'));
            const templateTasks = Array.isArray(full?.projectData?.tasks) ? full.projectData.tasks : [];
            for (const sourceTask of templateTasks) {
                const task = JSON.parse(JSON.stringify(sourceTask));
                const mediaPath = task.audioPath || task.videoPath || task.bgPath || task.srtPath || '';
                const sourceFolder = mediaPath ? path.dirname(mediaPath) : '';
                const queueNameMatch = String(item.name || '').match(/_([0-9]+)$/);
                const queueName = queueNameMatch ? queueNameMatch[1] : (sourceFolder ? path.basename(sourceFolder) : item.name);
                task._sourceFolder = task._sourceFolder || sourceFolder;
                // 恢复时以“已保存的模板”作为队列边界。不能沿用模板内旧的
                // folderQueueId：多个后续任务队列可能循环使用同一批素材，路径一样
                // 但仍是独立队列。沿用旧 ID 会让启动去重把 18×6 误压成 6 条。
                task._folderQueueId = `template:${item.id}`;
                task._folderQueueName = queueName;
                if (task.id && seenTaskIds.has(task.id)) continue;
                if (task.id) seenTaskIds.add(task.id);
                tasks.push(task);
            }
        }
        if (!tasks.length) throw new Error('匹配模板中没有任务数据');

        const now = new Date().toISOString();
        const recoveryConfig = {
            timestamp: now,
            version: '2.0',
            activeTabId: 'tab_recovered_0806',
            nextTabId: 2,
            projectDir: '',
            projectName: 'Recovered_0806_Project.json',
            recoverySource: {
                label: request.label || '队列模板恢复',
                templateIds: selected.map(item => item.id),
                templateCreatedAt: selected.map(item => item.createdAt),
            },
            tabs: [{
                id: 'tab_recovered_0806',
                name: '批量导入任务',
                materialDir: '',
                folderQueueId: '',
                externalFolderQueuesCombined: true,
                lastRefreshTime: now,
                tasks,
            }],
        };

        const currentRaw = await targetWindow.webContents.executeJavaScript(
            'localStorage.getItem("reels_batch_config_autosave") || ""',
            true
        );
        const recoveryDir = path.join(app.getPath('userData'), 'batch-recovery');
        fs.mkdirSync(recoveryDir, { recursive: true });
        const stamp = now.replace(/[:.]/g, '-');
        if (currentRaw) fs.writeFileSync(path.join(recoveryDir, `before-${stamp}.json`), currentRaw, 'utf-8');
        fs.writeFileSync(path.join(recoveryDir, `recovered-${stamp}.json`), JSON.stringify(recoveryConfig, null, 2), 'utf-8');

        const configJson = JSON.stringify(recoveryConfig);
        const backupKey = `reels_batch_config_backup_${Date.now()}`;
        await targetWindow.webContents.executeJavaScript(
            `(()=>{const old=localStorage.getItem('reels_batch_config_autosave');` +
            `if(old)localStorage.setItem(${JSON.stringify(backupKey)},old);` +
            // 紧接着的 reload 会触发旧页面 beforeunload。必须先禁止旧页面
            // 把内存中的旧 6 条任务又覆盖到刚写好的 108 条恢复配置上。
            `window._skipBatchSaveBeforeUnload=true;` +
            `localStorage.setItem('reels_batch_config_autosave',${JSON.stringify(configJson)});return true})()`,
            true
        );

        const completedPath = path.join(__dirname, '..', '.videokit-recovery-completed.json');
        fs.renameSync(requestPath, completedPath);
        log(`[TemplateRecovery] 已从 ${selected.length} 个模板恢复 ${tasks.length} 条任务：${request.label || ''}`);
        if (!targetWindow.isDestroyed()) targetWindow.webContents.reloadIgnoringCache();
        return true;
    } catch (error) {
        log(`[TemplateRecovery] 恢复失败: ${error.message}`);
        return false;
    }
}

/** 从指定队列模板只恢复字幕样式，不改动当前任务的素材、字幕和对齐结果。 */
async function recoverPendingStylesFromTemplates(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;
    const requestPath = path.join(__dirname, '..', '.videokit-style-recovery-request.json');
    if (!fs.existsSync(requestPath)) return false;
    try {
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
        const matcher = new RegExp(request.templateNamePattern || '.*');
        const templatesDir = path.join(app.getPath('userData'), 'videokit-templates');
        const index = JSON.parse(fs.readFileSync(path.join(templatesDir, 'index.json'), 'utf-8'));
        const selected = index
            .filter(item => matcher.test(String(item.name || '')))
            .filter(item => !request.createdDate || String(item.createdAt || '').startsWith(request.createdDate))
            .sort(_naturalTemplateNameSort);
        if (!selected.length) throw new Error('没有找到指定的队列模板');

        const queueSources = new Map();
        for (const item of selected) {
            const full = JSON.parse(fs.readFileSync(path.join(templatesDir, `${item.id}.json`), 'utf-8'));
            const queueMatch = String(item.name || '').match(/^0806_([0-9]+)/);
            if (!queueMatch) continue;
            const sourceTasks = Array.isArray(full?.projectData?.tasks) ? full.projectData.tasks : [];
            const byId = new Map(sourceTasks.filter(t => t.id).map(t => [String(t.id), t]));
            const byAudio = new Map(sourceTasks.filter(t => t.audioPath).map(t => [String(t.audioPath), t]));
            const byName = new Map(sourceTasks.filter(t => t.baseName).map(t => [String(t.baseName).toLowerCase(), t]));
            queueSources.set(queueMatch[1], { sourceTasks, byId, byAudio, byName });
        }

        const currentRaw = await targetWindow.webContents.executeJavaScript(
            'localStorage.getItem("reels_batch_config_autosave") || ""', true
        );
        if (!currentRaw) throw new Error('当前批量配置不存在');
        const config = JSON.parse(currentRaw);
        let restored = 0;
        for (const tab of (config.tabs || [])) {
            for (const task of (tab.tasks || [])) {
                const queueName = String(task._folderQueueName || '').trim();
                const source = queueSources.get(queueName);
                if (!source) continue;
                const matched = (task.id && source.byId.get(String(task.id)))
                    || (task.audioPath && source.byAudio.get(String(task.audioPath)))
                    || (task.baseName && source.byName.get(String(task.baseName).toLowerCase()));
                if (!matched) continue;
                // 旧模板的 task.style 是当时真正渲染的队列样式；
                // subtitleStyle 在部分队列只有单条旧副本，不能用它覆盖整队。
                const style = matched.style || matched.subtitleStyle;
                if (!style || typeof style !== 'object' || !Object.keys(style).length) continue;
                task.style = JSON.parse(JSON.stringify(style));
                task.subtitleStyle = JSON.parse(JSON.stringify(style));
                if (matched._subtitlePreset) task._subtitlePreset = matched._subtitlePreset;
                else delete task._subtitlePreset;
                restored++;
            }
        }
        if (!restored) throw new Error('当前任务与队列模板没有匹配上');

        const recoveryDir = path.join(app.getPath('userData'), 'batch-recovery');
        fs.mkdirSync(recoveryDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(recoveryDir, `before-style-recovery-${stamp}.json`), currentRaw, 'utf-8');
        config.timestamp = new Date().toISOString();
        config.styleRecovery = { restored, label: request.label || '', at: config.timestamp };
        const nextRaw = JSON.stringify(config);
        fs.writeFileSync(path.join(recoveryDir, `after-style-recovery-${stamp}.json`), JSON.stringify(config, null, 2), 'utf-8');
        await targetWindow.webContents.executeJavaScript(
            `(()=>{window._skipBatchSaveBeforeUnload=true;localStorage.setItem('reels_batch_config_autosave',${JSON.stringify(nextRaw)});return true})()`,
            true
        );
        fs.renameSync(requestPath, path.join(__dirname, '..', '.videokit-style-recovery-completed.json'));
        log(`[StyleRecovery] 已从 ${selected.length} 个队列模板恢复 ${restored} 条任务的字幕样式`);
        if (!targetWindow.isDestroyed()) targetWindow.webContents.reloadIgnoringCache();
        return true;
    } catch (error) {
        log(`[StyleRecovery] 恢复失败: ${error.message}`);
        return false;
    }
}

async function repairPendingTemplateThumbnails(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;
    const requestPath = path.join(__dirname, '..', '.videokit-thumbnail-repair-request.json');
    if (!fs.existsSync(requestPath)) return false;
    try {
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
        const matcher = new RegExp(request.templateNamePattern || '.*');
        const templatesDir = path.join(app.getPath('userData'), 'videokit-templates');
        const index = JSON.parse(fs.readFileSync(path.join(templatesDir, 'index.json'), 'utf-8'));
        const ids = index
            .filter(item => matcher.test(String(item.name || '')))
            .filter(item => !request.createdDate || String(item.createdAt || '').startsWith(request.createdDate))
            .sort(_naturalTemplateNameSort)
            .map(item => item.id);
        if (!ids.length) throw new Error('没有找到需要修复封面的模板');

        const expression = `(async()=>{` +
            `localStorage.setItem('videokit_disable_file_origin_migration',${JSON.stringify(request.label || 'template-recovery')});` +
            `if(typeof window._repairTemplateThumbnailsByIds!=='function')throw new Error('封面修复函数未加载');` +
            `return await window._repairTemplateThumbnailsByIds(${JSON.stringify(ids)},{silent:true})` +
            `})()`;
        const result = await targetWindow.webContents.executeJavaScript(expression, true);
        const completedPath = path.join(__dirname, '..', '.videokit-thumbnail-repair-completed.json');
        fs.renameSync(requestPath, completedPath);
        log(`[ThumbnailRepair] ${request.label || ''}：成功 ${result?.repaired || 0}，失败 ${result?.failed || 0}`);
        return true;
    } catch (error) {
        log(`[ThumbnailRepair] 修复失败: ${error.message}`);
        return false;
    }
}

async function logBatchStartupState(targetWindow, label = 'startup') {
    if (!targetWindow || targetWindow.isDestroyed()) return;
    try {
        const state = await targetWindow.webContents.executeJavaScript(
            `(()=>{const tabs=(window._batchTableState?.tabs||[]).map(t=>({name:t.name,count:t.tasks?.length||0}));` +
            `return {memoryTasks:window._reelsState?.tasks?.length||0,` +
            `tabs,savedTotal:tabs.reduce((n,t)=>n+t.count,0)}})()`,
            true
        );
        log(`[BatchStartup:${label}] ${JSON.stringify(state)}`);
    } catch (error) {
        log(`[BatchStartup:${label}] 读取失败: ${error.message}`);
    }
}

// local-media 用于渲染本地生成的预览图/媒体。必须在 app.ready 前声明权限，
// 否则 video/img 的 range/fetch 行为在部分 Electron 版本里会不稳定。
try {
    app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
} catch (_) {}

try {
    protocol.registerSchemesAsPrivileged([{
        scheme: 'local-media',
        privileges: {
            secure: true,
            supportFetchAPI: true,
            stream: true,
            corsEnabled: true,
        },
    }]);
} catch (e) {
    console.warn('[Protocol] local-media privilege registration skipped:', e.message);
}

// Portable profile lives beside the executable.
const _portableRoot = app.isPackaged ? path.dirname(process.execPath) : '';
const _portableMode = Boolean(_portableRoot && fs.existsSync(path.join(_portableRoot, 'portable.flag')));
if (_portableMode) {
    const portableUserData = path.join(_portableRoot, 'portable-data');
    fs.mkdirSync(portableUserData, { recursive: true });
    app.setPath('userData', portableUserData);
}
// ── 自定义缓存路径（必须在 app.ready 之前设置）──
const _cacheConfigPath = path.join(app.isPackaged ? path.dirname(process.execPath) : __dirname, '.videokit-cache-config.json');
function _loadCacheConfig() {
    try {
        if (fs.existsSync(_cacheConfigPath)) {
            const cfg = JSON.parse(fs.readFileSync(_cacheConfigPath, 'utf-8'));
            if (cfg.userDataPath && fs.existsSync(cfg.userDataPath)) {
                return cfg.userDataPath;
            }
        }
    } catch (e) { /* ignore */ }
    return null;
}
const _customUserData = _portableMode ? null : _loadCacheConfig();
if (_customUserData) {
    app.setPath('userData', _customUserData);
}

// The editor is the only workspace owner; a second launch focuses it.
// On packaged update/restart, the previous process may still be releasing its lock for a few hundred ms.
let _workspaceInstanceOwner = app.requestSingleInstanceLock();
if (!_workspaceInstanceOwner && app.isPackaged) {
    for (let retry = 0; retry < 8 && !_workspaceInstanceOwner; retry++) {
        try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        } catch (_) {}
        _workspaceInstanceOwner = app.requestSingleInstanceLock();
    }
}
if (!_workspaceInstanceOwner) {
    if (!app.isPackaged) {
        dialog.showMessageBoxSync({
            type: 'info',
            title: '源码测试版未启动',
            message: '已有 VideoKit 正在运行，本次源码测试版没有启动。',
            detail: `程序会唤起已有窗口，因此该窗口可能没有本文件夹的新功能。\n请先保存工程并退出已有 VideoKit，再运行本文件夹的启动脚本。\n\n本次源码目录：${path.resolve(__dirname, '..')}`,
            buttons: ['知道了'],
        });
    }
    app.exit(0);
}
app.on('second-instance', () => {
    if (isQuitting || app.isQuitting) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
});

// 日志文件路径
const logDir = (app && app.isPackaged)
    ? path.join(app.getPath('userData'), 'logs')
    : path.join(__dirname, '..', 'logs');

// 确保日志目录存在
function ensureLogDir() {
    try {
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    } catch (e) {
        console.error('Failed to create log directory:', e);
    }
}

// 写日志到文件
function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);

    try {
        ensureLogDir();
        const logFile = path.join(logDir, 'app.log');
        fs.appendFileSync(logFile, logMessage + '\n');
    } catch (e) {
        // 忽略日志写入错误
    }
}

// ── 自动处理更新后 Code Cache 导致的白屏（必须在 app.ready 前执行，保留全部工程/预设/配置）──
let _startupCodeCacheStatus = { rotated: false, needsSessionCacheClear: false };
if (_workspaceInstanceOwner) {
    try {
        _startupCodeCacheStatus = codeCacheGuard.ensureFreshCodeCacheOnStartup({
            userDataDir: app.getPath('userData'),
            appVersion: app.getVersion(),
            appPath: app.getAppPath(),
            electronVersion: process.versions.electron,
            chromeVersion: process.versions.chrome,
            isPackaged: app.isPackaged,
            log,
        });
    } catch (e) {
        log(`[CodeCacheGuard] 启动前检查异常: ${e.message}`);
    }
}

// 获取资源路径
function getResourcePath(relativePath) {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, relativePath);
    }
    return path.join(__dirname, '..', relativePath);
}

// Apple Silicon 版不能把 Intel-only 的 ffmpeg 当成可靠依赖。部分机器安装了
// Rosetta 时它会碰巧工作，未安装时则所有媒体探测都失败，前端只能看到 0 秒
// 和 0% 匹配，极难定位。这里同时校验 Mach-O 架构和实际可启动性。
function isUsableMacMediaBinary(binaryPath) {
    if (!binaryPath || !fs.existsSync(binaryPath)) return false;
    try {
        const archProbe = spawnSync('/usr/bin/lipo', ['-archs', binaryPath], {
            timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        });
        const arches = String(archProbe.stdout || '').trim().split(/\s+/).filter(Boolean);
        const requiredArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
        if (arches.length && !arches.includes(requiredArch)) {
            log(`[FFmpeg] Skipping incompatible ${binaryPath}; needs ${requiredArch}, has ${arches.join(', ')}`);
            return false;
        }
        const runProbe = spawnSync(binaryPath, ['-version'], {
            timeout: 5000, stdio: 'ignore'
        });
        if (runProbe.error || runProbe.status !== 0) {
            log(`[FFmpeg] Cannot start ${binaryPath}: ${runProbe.error?.message || `exit ${runProbe.status}`}`);
            return false;
        }
        return true;
    } catch (error) {
        log(`[FFmpeg] Cannot validate ${binaryPath}: ${error.message}`);
        return false;
    }
}

function findUsableMacMediaPair(name) {
    const systemDirs = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin'];
    for (const dir of systemDirs) {
        const candidate = path.join(dir, name);
        if (isUsableMacMediaBinary(candidate)) return candidate;
    }
    return '';
}

// 获取 FFmpeg 路径并注入到 PATH
function setupFFmpegPath() {
    // macOS: 检查打包的 FFmpeg
    if (process.platform === 'darwin') {
        const candidates = [
            path.join(getResourcePath('vendor'), 'ffmpeg'),
            path.join(getResourcePath('vendor'), 'darwin', 'ffmpeg'),
        ];
        log(`[FFmpeg] macOS resource path: ${getResourcePath('vendor')}`);
        let found = false;
        for (const vendorFfmpeg of candidates) {
            log(`[FFmpeg] Checking candidate: ${vendorFfmpeg} exists=${fs.existsSync(vendorFfmpeg)}`);
            if (fs.existsSync(vendorFfmpeg)) {
                const ffmpegExe = path.join(vendorFfmpeg, 'ffmpeg');
                const ffprobeExe = path.join(vendorFfmpeg, 'ffprobe');
                log(`[FFmpeg]   ffmpeg: ${ffmpegExe} exists=${fs.existsSync(ffmpegExe)}`);
                log(`[FFmpeg]   ffprobe: ${ffprobeExe} exists=${fs.existsSync(ffprobeExe)}`);
                if (isUsableMacMediaBinary(ffmpegExe) && isUsableMacMediaBinary(ffprobeExe)) {
                    log(`Using vendor FFmpeg on macOS: ${vendorFfmpeg}`);
                    process.env.PATH = `${vendorFfmpeg}${path.delimiter}${process.env.PATH || ''}`;
                    if (fs.existsSync(ffmpegExe)) process.env.FFMPEG_PATH = ffmpegExe;
                    if (fs.existsSync(ffprobeExe)) process.env.FFPROBE_PATH = ffprobeExe;
                    found = true;
                    break;
                }
            }
        }
        if (!found) {
            // 内置二进制不存在、损坏或架构不匹配时，明确使用用户已安装的
            // 系统版本。不能只修改 PATH，否则 ffmpeg.js 会再次扫描并选回
            // 那个不可执行的内置 Intel 版本。
            const systemFfmpeg = findUsableMacMediaPair('ffmpeg');
            const systemFfprobe = findUsableMacMediaPair('ffprobe');
            if (systemFfmpeg && systemFfprobe) {
                process.env.FFMPEG_PATH = systemFfmpeg;
                process.env.FFPROBE_PATH = systemFfprobe;
                const systemDir = path.dirname(systemFfmpeg);
                process.env.PATH = `${systemDir}${path.delimiter}${process.env.PATH || ''}`;
                log(`Using compatible system FFmpeg on macOS: ${systemDir}`);
                found = true;
            }
        }
        if (!found) {
            // 回退到系统安装的 FFmpeg
            const macPaths = [
                '/opt/homebrew/bin',
                '/usr/local/bin',
                '/opt/local/bin',
            ];
            const existingPath = process.env.PATH || '';
            const additionalPaths = macPaths.filter(p => !existingPath.includes(p)).join(path.delimiter);
            if (additionalPaths) {
                process.env.PATH = `${additionalPaths}${path.delimiter}${existingPath}`;
            }
            log(`[FFmpeg] WARNING: ffmpeg/ffprobe not found in any candidate path! Fallback to system PATH: ${process.env.PATH}`);
        }
    } else if (process.platform === 'win32') {
        // Packaged: extraResources maps vendor/windows/ffmpeg → vendor/ffmpeg
        // Dev: files sit at vendor/windows/ffmpeg/bin
        const candidates = [
            path.join(getResourcePath('vendor'), 'ffmpeg', 'bin'),
            path.join(getResourcePath('vendor'), 'windows', 'ffmpeg', 'bin'),
            // 额外的 fallback：直接在 vendor/ffmpeg 下（无 bin 子目录的情况）
            path.join(getResourcePath('vendor'), 'ffmpeg'),
            ...(process.env.LOCALAPPDATA ? [
                path.join(process.env.LOCALAPPDATA, 'Programs', 'videokit', 'resources', 'vendor', 'ffmpeg', 'bin'),
                path.join(process.env.LOCALAPPDATA, 'Programs', 'videokit', 'resources', 'vendor', 'ffmpeg'),
            ] : []),
        ];
        log(`[FFmpeg] Windows resource path: ${getResourcePath('vendor')}`);
        let found = false;
        for (const vendorFfmpeg of candidates) {
            log(`[FFmpeg] Checking candidate: ${vendorFfmpeg} exists=${fs.existsSync(vendorFfmpeg)}`);
            if (fs.existsSync(vendorFfmpeg)) {
                const ffmpegExe = path.join(vendorFfmpeg, 'ffmpeg.exe');
                const ffprobeExe = path.join(vendorFfmpeg, 'ffprobe.exe');
                log(`[FFmpeg]   ffmpeg.exe: ${ffmpegExe} exists=${fs.existsSync(ffmpegExe)}`);
                log(`[FFmpeg]   ffprobe.exe: ${ffprobeExe} exists=${fs.existsSync(ffprobeExe)}`);
                if (fs.existsSync(ffmpegExe) || fs.existsSync(ffprobeExe)) {
                    log(`Using vendor FFmpeg on Windows: ${vendorFfmpeg}`);
                    process.env.PATH = `${vendorFfmpeg}${path.delimiter}${process.env.PATH || ''}`;
                    if (fs.existsSync(ffmpegExe)) process.env.FFMPEG_PATH = ffmpegExe;
                    if (fs.existsSync(ffprobeExe)) process.env.FFPROBE_PATH = ffprobeExe;
                    found = true;
                    break;
                }
            }
        }
        if (!found) {
            log(`[FFmpeg] WARNING: ffmpeg/ffprobe not found in any candidate path!`);
        }
    }
}

// 创建主窗口
function createWindow() {
    if (mainWindow) {
        mainWindow.focus();
        return;
    }

    if (!appIsReady || !_workspaceInstanceOwner) return;

    const windowOptions = {
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 700,
        title: app.isPackaged ? 'VideoKit' : 'VideoKit — 源码测试版',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            // Reels preview is canvas-driven. Keep its media decoders and
            // animation clock alive when the user briefly switches apps.
            backgroundThrottling: false,
            webSecurity: true,  // Re-enabled for security; local media loads via local-media:// protocol
            preload: path.join(__dirname, 'preload.js')
        },
    };

    // macOS 专用：隐藏标题栏 + 红绿灯按钮位置
    if (process.platform === 'darwin') {
        windowOptions.titleBarStyle = 'hiddenInset';
        windowOptions.trafficLightPosition = { x: 15, y: 15 };
    }

    mainWindow = new BrowserWindow(windowOptions);
    attachTemplateLibraryNavigation(mainWindow);
    if (!app.isPackaged) {
        mainWindow.webContents.on('page-title-updated', event => {
            event.preventDefault();
            mainWindow.setTitle(`VideoKit — 源码测试版 · ${path.basename(path.resolve(__dirname, '..'))}`);
        });
    }
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!isTrustedRendererUrl(url, { packaged: app.isPackaged, port: DEV_SERVER_PORT })) event.preventDefault();
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
    });
    let workspaceCloseApproved = false;
    let workspaceCloseSaving = false;
    let rendererAutoRecoveryCount = 0;

    // renderer 异常退出时，beforeunload 不一定会运行；由主进程记录原因并在运行期自动恢复页面。
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        // 忽略正常退出、窗口关闭/重启过程以及系统 SIGTERM(15) 终止
        if (
            isQuitting ||
            app.isQuitting ||
            workspaceCloseApproved ||
            workspaceCloseSaving ||
            !mainWindow ||
            mainWindow.isDestroyed() ||
            details?.reason === 'clean-exit' ||
            details?.reason === 'killed' ||
            details?.exitCode === 0 ||
            details?.exitCode === 15
        ) {
            return;
        }
        writeRendererCrashReport({
            process: details?.process || 'renderer',
            reason: details?.reason || 'unknown',
            exitCode: Number.isFinite(details?.exitCode) ? details.exitCode : null,
        });
        // 如果主窗口仍在运行期发生渲染进程崩溃（如内存峰值/显卡驱动重置），自动清理 Code Cache 并重载恢复
        if (rendererAutoRecoveryCount < 3) {
            rendererAutoRecoveryCount++;
            log(`[CrashRecovery] 主窗口渲染进程异常退出 (reason=${details?.reason}, code=${details?.exitCode})，正在自动重载恢复 (${rendererAutoRecoveryCount}/3)...`);
            setTimeout(async () => {
                if (isQuitting || app.isQuitting || workspaceCloseApproved || !mainWindow || mainWindow.isDestroyed()) return;
                try {
                    await mainWindow.webContents.session.clearCodeCaches({});
                } catch (_) {}
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.reloadIgnoringCache();
                }
            }, 400);
        }
    });

    if (!app.isPackaged) {
        let loadRetries = 0;
        const loadDevServer = () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.loadURL(DEV_SERVER_URL).catch(() => {});
            }
        };
        mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
            if (validatedURL && validatedURL.includes(`localhost:${DEV_SERVER_PORT}`) && loadRetries < 25) {
                loadRetries++;
                setTimeout(() => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        loadDevServer();
                    }
                }, 600);
            } else if (loadRetries >= 25) {
                const localHtml = path.join(__dirname, '../dist/index.html');
                const fs = require('fs');
                if (fs.existsSync(localHtml) && mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.loadFile(localHtml);
                }
            }
        });
        loadDevServer();
        if (process.env.VIDEOKIT_DEVTOOLS === '1') {
            mainWindow.webContents.openDevTools();
        }
        mainWindow.webContents.once('did-finish-load', async () => {
            const recovered = await recoverPendingBatchFromTemplates(mainWindow);
            const stylesRecovered = recovered ? false : await recoverPendingStylesFromTemplates(mainWindow);
            const repaired = (recovered || stylesRecovered) ? false : await repairPendingTemplateThumbnails(mainWindow);
            const audited = (!recovered && !stylesRecovered && !repaired) ? await snapshotLegacyBatchForStyleAudit(mainWindow) : false;
            if (!recovered && !stylesRecovered && !repaired && !audited) await migrateLegacyFileStorageToDevOrigin(mainWindow);
            setTimeout(() => logBatchStartupState(mainWindow), 2500);
            setTimeout(() => logBatchStartupState(mainWindow, 'settled'), 12000);
        });

        // ── 开发者热启动与热重载机制 (Hot Reload / Relaunch) ──
        if (!global._isWatching) {
            global._isWatching = true;
            const fs = require('fs');
            const watchReadyAt = Date.now() + 4000;
            const mtimeCache = new Map();
            const hasRealFileModification = (baseDir, relPath) => {
                if (Date.now() < watchReadyAt) return false;
                try {
                    const full = path.join(baseDir, relPath);
                    if (!fs.existsSync(full)) return false;
                    const mtime = fs.statSync(full).mtimeMs;
                    if (mtime < watchReadyAt) return false;
                    const prev = mtimeCache.get(full) || 0;
                    if (mtime <= prev + 50) return false;
                    mtimeCache.set(full, mtime);
                    return true;
                } catch (_) {
                    return false;
                }
            };

            // 监听主进程目录 (electron/) 变化 ➔ 自动重启 Electron 应用
            let relaunchTimeout;
            const electronDir = path.join(__dirname);
            fs.watch(electronDir, { recursive: true }, (eventType, filename) => {
                if (filename && (filename.endsWith('.js') || filename.endsWith('.json') || filename.endsWith('.html'))) {
                    if (!hasRealFileModification(electronDir, filename)) return;
                    clearTimeout(relaunchTimeout);
                    relaunchTimeout = setTimeout(() => {
                        log(`[HotReload] 主进程文件改变: ${filename}，正在重启 Electron...`);
                        isQuitting = true;
                        app.isQuitting = true;
                        app.relaunch();
                        app.exit(0);
                    }, 300);
                }
            });

            // 监听渲染进程目录 (src/) 变化 ➔ 自动重载/刷新浏览器窗口
            let reloadTimeout;
            const srcDir = path.join(__dirname, '..', 'src');
            if (fs.existsSync(srcDir)) {
                fs.watch(srcDir, { recursive: true }, (eventType, filename) => {
                    if (filename && (filename.endsWith('.js') || filename.endsWith('.css') || filename.endsWith('.html'))) {
                        if (!hasRealFileModification(srcDir, filename)) return;
                        clearTimeout(reloadTimeout);
                        reloadTimeout = setTimeout(() => {
                            log(`[HotReload] 渲染进程文件改变: ${filename}，正在刷新页面...`);
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.reloadIgnoringCache();
                            }
                        }, 300);
                    }
                });
            }
        }
    } else {
        const userDataDir = app.getPath('userData');
        const distHtmlPath = path.join(__dirname, '../dist/index.html');
        let packagedCacheRetried = false;
        let rendererBootVerified = false;
        let bootWatchdogTimer = null;

        codeCacheGuard.markRendererBootPending(userDataDir, {
            appVersion: app.getVersion(),
        });

        const clearBootWatchdog = () => {
            if (bootWatchdogTimer) {
                clearTimeout(bootWatchdogTimer);
                bootWatchdogTimer = null;
            }
        };

        const recoverFromWhiteScreen = async (reason) => {
            clearBootWatchdog();
            if (packagedCacheRetried || rendererBootVerified || !mainWindow || mainWindow.isDestroyed()) return;
            packagedCacheRetried = true;
            log(`[CodeCacheGuard] 检测到渲染异常或白屏 (${reason})，正在自动清理 Code Cache 并重载...`);
            try {
                codeCacheGuard.rotateCodeCacheDir(userDataDir, { reason: `runtime-${reason}` });
            } catch (_) {}
            try {
                await mainWindow.webContents.session.clearCodeCaches({});
                await mainWindow.webContents.session.clearCache();
                await mainWindow.webContents.session.clearStorageData({
                    storages: ['shadercache', 'cachestorage'],
                });
            } catch (_) {}
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.reloadIgnoringCache();
            }
        };

        mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
            recoverFromWhiteScreen(`did-fail-load:${errorCode}:${errorDescription}`);
        });

        mainWindow.webContents.on('did-finish-load', async () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            try {
                // Verify both DOM structure AND core frontend JS bundle execution (`window.reelsSelectTask`, `window.ReelsStyleEngine` and `window._reelsState`).
                // Static HTML alone has document.body.children.length > 0 even when V8 Code Cache fails to execute scripts.
                const jsAndDomHealthy = await mainWindow.webContents.executeJavaScript(
                    'Boolean(document.body && document.body.children && document.body.children.length > 0 && typeof window.reelsSelectTask === "function" && typeof window.ReelsStyleEngine?.mergeStyle === "function" && window._reelsState)',
                    true
                );
                if (jsAndDomHealthy) {
                    rendererBootVerified = true;
                    clearBootWatchdog();
                    codeCacheGuard.markRendererBootComplete(userDataDir);
                } else {
                    await recoverFromWhiteScreen('scripts-not-initialized-after-load');
                }
            } catch (err) {
                await recoverFromWhiteScreen(`dom-check-error:${err.message}`);
            }
        });

        (async () => {
            if (_startupCodeCacheStatus?.needsSessionCacheClear && mainWindow && !mainWindow.isDestroyed()) {
                try {
                    await mainWindow.webContents.session.clearCodeCaches({});
                    await mainWindow.webContents.session.clearCache();
                } catch (_) {}
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
                bootWatchdogTimer = setTimeout(async () => {
                    if (rendererBootVerified || !mainWindow || mainWindow.isDestroyed()) return;
                    try {
                        const ready = await mainWindow.webContents.executeJavaScript('Boolean(window._reelsState && typeof window.reelsSelectTask === "function" && typeof window.ReelsStyleEngine?.mergeStyle === "function")', true);
                        if (ready) { rendererBootVerified = true; codeCacheGuard.markRendererBootComplete(userDataDir); return; }
                    } catch (_) {}
                    await recoverFromWhiteScreen('startup-watchdog-timeout');
                }, 10000);
                mainWindow.loadFile(distHtmlPath);
            }
        })();
    }

    mainWindow.on('close',async event=>{
        if(workspaceCloseApproved || app._updateRestartApproved || mainWindow?.webContents?.isDestroyed())return;
        event.preventDefault();
        if(workspaceCloseSaving)return;
        workspaceCloseSaving=true;
        const closingWindow=mainWindow;
        try{
            const result=await closingWindow.webContents.executeJavaScript(`(()=>{
                if(typeof window.reelsFlushWorkspaceBeforeClose!=='function')return {ok:true,skipped:true};
                const result=window.reelsFlushWorkspaceBeforeClose();
                if(result?.ok)window._workspaceCloseAlreadySaved=true;
                return result;
            })()`,true);
            if(!result?.ok)throw new Error(result?.error||'自动保存未完成');
            workspaceCloseApproved=true;
            closingWindow.close();
        }catch(error){
            log('[Workspace] Close save failed: '+error.message);
            if(!closingWindow.isDestroyed())dialog.showMessageBoxSync(closingWindow,{type:'error',title:'自动保存失败',message:'当前编辑未能保存，已取消退出。',detail:error.message,buttons:['返回软件'],defaultId:0});
        }finally{workspaceCloseSaving=false;}
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// 应用启动
app.whenReady().then(async () => {
    if(!_workspaceInstanceOwner)return;
    appIsReady = true;
    log('=== App Ready (Node.js Backend) ===');

    protocol.handle('local-media', async (request) => {
        // 不用 standard:true → URL 不会被解析为 host/path 格式
        // local-media:///Users/ww/file.mp4 → 直接截取 scheme 后的路径
        const afterScheme = request.url.replace(/^local-media:\/\//, '');
        const cleanPath = afterScheme.split('?')[0].split('#')[0];
        let filePath = decodeURIComponent(cleanPath);
        // On Windows, if filePath starts with "/" followed by a drive letter (e.g. "/C:"), remove the leading "/"
        if (process.platform === 'win32' && filePath.startsWith('/') && filePath.includes(':')) {
            filePath = filePath.substring(1);
        }
        let resolved = sharedProfile.resolveSharedProfileFilePath(path.resolve(filePath));

        try {
            // SBP-004: Validate file extension for security
            const allowedExtensions = [
                // Video
                '.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.3gp', '.m4v', '.wmv', '.ts',
                // Audio
                '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.amr',
                // Image
                '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.ico', '.tiff', '.tif', '.avif',
                // Subtitles/Data
                '.json', '.txt', '.srt', '.vtt', '.fcpxml', '.xml', '.drt', '.zip',
                // Fonts
                '.ttf', '.otf', '.woff', '.woff2'
            ];
            let ext = path.extname(resolved).toLowerCase();
            if (!allowedExtensions.includes(ext)) {
                console.error('[local-media] Access blocked for invalid extension:', ext, 'path:', resolved);
                return new Response('Access Denied', { status: 403 });
            }
            const baseNameLower = path.basename(resolved).toLowerCase();
            const blockedBasenames = new Set([
                'gladia_keys.json',
                'gemini_keys.json',
                'elevenlabs_settings.json',
                'transcription_providers.json',
                '.videokit-cache-config.json',
                'settings.json',
                '.env',
                '.env.local',
                '.env.production',
            ]);
            if (blockedBasenames.has(baseNameLower)) {
                console.error('[local-media] Access blocked for sensitive file:', baseNameLower);
                return new Response('Access Denied', { status: 403 });
            }

            if (!fs.existsSync(resolved)) {
                console.error('[local-media] File not found:', resolved);
                return new Response('Not Found', { status: 404 });
            }

            if (request.url.includes('?reelsPreview=sdr-v2') && request.method !== 'OPTIONS') {
                resolved = await require('./services/reels-hdr-preview').prepareReelsPreview(resolved);
                ext = path.extname(resolved).toLowerCase();
            }

            const stat = fs.statSync(resolved);
            const size = stat.size;
            const mimeTypes = {
                '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
                '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.flv': 'video/x-flv', '.3gp': 'video/3gpp',
                '.m4v': 'video/mp4', '.wmv': 'video/x-ms-wmv', '.ts': 'video/mp2t',
                '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
                '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
                '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.amr': 'audio/amr',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
                '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.avif': 'image/avif',
                '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
                '.srt': 'application/x-subrip', '.vtt': 'text/vtt', '.xml': 'application/xml',
                '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
            };
            const baseHeaders = {
                'Content-Type': mimeTypes[ext] || 'application/octet-stream',
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
                'Access-Control-Allow-Headers': '*',
                'Cache-Control': 'no-cache',
            };

            if (request.method === 'OPTIONS') {
                return new Response(null, { status: 204, headers: baseHeaders });
            }

            const rangeHeader = request.headers.get('range');
            let start = 0;
            let end = Math.max(0, size - 1);
            let status = 200;
            if (rangeHeader) {
                const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
                if (!match) {
                    return new Response(null, {
                        status: 416,
                        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
                    });
                }
                if (match[1] === '' && match[2] !== '') {
                    const suffixLength = Math.min(size, parseInt(match[2], 10));
                    start = Math.max(0, size - suffixLength);
                } else {
                    start = parseInt(match[1] || '0', 10);
                    if (match[2] !== '') end = Math.min(end, parseInt(match[2], 10));
                }
                if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) {
                    return new Response(null, {
                        status: 416,
                        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
                    });
                }
                status = 206;
            }

            const contentLength = Math.max(0, end - start + 1);
            const headers = {
                ...baseHeaders,
                'Content-Length': String(contentLength),
            };
            if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            if (request.method === 'HEAD') return new Response(null, { status, headers });

            const nodeStream = fs.createReadStream(resolved, { start, end });
            return new Response(Readable.toWeb(nodeStream), { status, headers });
        } catch (e) {
            console.error('[local-media] Error:', e.message, 'File:', resolved);
            return new Response('Internal Error: ' + e.message, { status: 500 });
        }
    });

    // 设置 FFmpeg 环境
    setupFFmpegPath();
    log(`FFmpeg PATH configured`);

    // ==================== IPC 处理 - 基本功能 ====================
    const fontPreferences=require('./services/fontPreferences').createFontPreferences(app.getPath('userData'));
    ipcMain.on('font-favorites:get',(event,seed)=>{try{assertTrustedRenderer(event);event.returnValue={ok:true,favorites:fontPreferences.read(seed)};}catch(error){event.returnValue={ok:false,error:error.message};}});
    ipcMain.on('font-favorites:toggle',(event,family)=>{try{assertTrustedRenderer(event);event.returnValue={ok:true,favorites:fontPreferences.toggle(family)};}catch(error){event.returnValue={ok:false,error:error.message};}});
    ipcMain.on('font-favorites:set',(event,values)=>{try{assertTrustedRenderer(event);if(!Array.isArray(values))throw Error('无效的字体收藏');event.returnValue={ok:true,favorites:fontPreferences.save(values)};}catch(error){event.returnValue={ok:false,error:error.message};}});

    // 预设先在 preload 同步恢复，确保页面脚本读取 localStorage 前已经拿到
    // 免安装包之间共用的用户目录副本。
    ipcMain.on('persistent-presets:hydrate', (event, values) => {
        try { assertTrustedRenderer(event); event.returnValue = { ok: true, values: persistentPresetStore.hydrate(values) }; }
        catch (error) { event.returnValue = { ok: false, error: error.message, values: {} }; }
    });
    handleTrusted('persistent-presets:save', async (_event, values) => {
        try { return { ok: true, ...persistentPresetStore.writeSnapshot(values) }; }
        catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.on('persistent-presets:set', (event, key, value) => {
        try {
            assertTrustedRenderer(event);
            if (!['reels_overlay_group_presets','reels_subtitle_presets'].includes(key) || typeof value !== 'string') throw new Error('无效的预设数据');
            const parsed = JSON.parse(value);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('无效的覆层预设格式');
            const values = persistentPresetStore.readSnapshot();
            values[key] = value;
            event.returnValue = { ok: true, ...persistentPresetStore.writeSnapshot(values) };
        } catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
    handleTrusted('export-overlay-preset-package', async (_event, presets) => {
        const result = await dialog.showSaveDialog(mainWindow, { title: '导出含媒体的覆层预设包', defaultPath: `overlay_presets_${Date.now()}.zip`, filters: [{ name: 'VideoKit 预设包', extensions: ['zip'] }] });
        if (result.canceled || !result.filePath) return { ok: false, canceled: true };
        try { return { ok: true, ...(await overlayPresetPackage.exportPackage({ presets, outputPath: result.filePath })), path: result.filePath }; }
        catch (error) { return { ok: false, error: error.message }; }
    });
    const mirrorPresetSubdir = async (sourceDir, subDirName) => {
        if (sharedProfile.isIsolatedTestProfile() || !fs.existsSync(sourceDir)) return;
        for (const presetDir of sharedProfile.getCandidatePresetDirs()) {
            const targetDir = path.join(presetDir, subDirName);
            if (path.resolve(targetDir) === path.resolve(sourceDir)) continue;
            try {
                await fs.promises.mkdir(targetDir, { recursive: true });
                await fs.promises.cp(sourceDir, targetDir, { recursive: true, force: false });
            } catch (_) { }
        }
    };
    handleTrusted('import-overlay-preset-package', async (_event, packagePath) => {
        try {
            const destinationDir = path.join(app.getPath('userData'), 'videokit-presets', 'imported-overlay-assets');
            const imported = await overlayPresetPackage.importPackage({ packagePath, destinationDir });
            await mirrorPresetSubdir(destinationDir, 'imported-overlay-assets');
            return { ok: true, ...imported };
        } catch (error) { return { ok: false, error: error.message }; }
    });
    handleTrusted('save-overlay-preset-assets', async (_event, preset) => {
        try {
            const destinationDir = path.join(app.getPath('userData'), 'videokit-presets', 'saved-overlay-assets');
            const saved = await overlayPresetPackage.savePresetAssets({ preset, destinationDir });
            await mirrorPresetSubdir(destinationDir, 'saved-overlay-assets');
            return { ok: true, ...saved };
        } catch (error) { return { ok: false, error: error.message }; }
    });

    handleTrusted('batch-project:choose-import-mode', async (event, counts = {}) => {
        const owner = BrowserWindow.fromWebContents(event.sender);
        const options = {
            type: 'question', title: '加载工程', message: '请选择导入方式',
            detail: `当前有 ${Number(counts.current) || 0} 个工程标签页，将导入 ${Number(counts.incoming) || 0} 个。\n\n追加：保留原有工程，新增导入的标签页。\n覆盖：先备份原有工程，再替换全部标签页。`,
            buttons: ['追加到现有工程', '覆盖所有工程', '取消'], defaultId: 0, cancelId: 2, noLink: true,
        };
        const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
        return ['append', 'replace', 'cancel'][result.response] || 'cancel';
    });

    handleTrusted('get-app-version', () => {
        return app.getVersion();
    });

    handleTrusted('select-directory', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'createDirectory'],
            title: '选择输出目录'
        });
        if (!result.canceled && result.filePaths.length > 0) {
            return result.filePaths[0];
        }
        return null;
    });

    handleTrusted('select-directories', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'multiSelections'],
            title: '选择多个视频文件夹（每个文件夹创建一个任务）'
        });
        return !result.canceled ? result.filePaths : [];
    });

    handleTrusted('select-files', async (event, options = {}) => {
        const props = options.properties || ['openFile'];
        if (options.multiple !== false && !props.includes('multiSelections')) props.push('multiSelections');
        const dialogOpts = {
            properties: props,
            title: options.title || '选择文件',
        };
        if (options.defaultPath) dialogOpts.defaultPath = options.defaultPath;
        if (options.filters) dialogOpts.filters = options.filters;
        const result = await dialog.showOpenDialog(mainWindow, dialogOpts);
        if (!result.canceled && result.filePaths.length > 0) {
            return result.filePaths;
        }
        return null;
    });

    handleTrusted('save-file', async (_event, options = {}) => {
        const dialogOpts = {
            title: options.title || '保存文件',
        };
        if (options.defaultPath) dialogOpts.defaultPath = options.defaultPath;
        if (options.filters) dialogOpts.filters = options.filters;
        const result = await dialog.showSaveDialog(mainWindow, dialogOpts);
        if (result.canceled || !result.filePath) {
            return { success: false, canceled: true };
        }
        if (typeof options.content === 'string' || Buffer.isBuffer(options.content)) {
            const fs = require('fs');
            await fs.promises.writeFile(result.filePath, options.content);
        }
        return { success: true, filePath: result.filePath };
    });

    handleTrusted('scan-directory', async (event, dirPath) => {
        const fs = require('fs');
        const pathModule = require('path');
        try {
            if (!dirPath || !fs.existsSync(dirPath)) return [];
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            const files = [];
            for (const entry of entries) {
                if (!entry.name.startsWith('.')) {
                    const fullPath = pathModule.join(dirPath, entry.name);
                    try {
                        const stat = fs.statSync(fullPath);
                        files.push({
                            name: entry.name,
                            path: fullPath,
                            size: stat.size,
                            mtime: stat.mtimeMs,
                            isDirectory: stat.isDirectory()
                        });
                    } catch { /* skip unreadable files */ }
                }
            }
            return files;
        } catch (e) {
            console.error('scan-directory error:', e);
            return [];
        }
    });

    // ==================== 本地多窗口整理与文件分拣 ====================
    try {
        const { registerLocalOrganizer } = require('./localOrganizerService');
        registerLocalOrganizer(ipcMain, () => mainWindow);
        log('LocalOrganizerService registered successfully');
    } catch (err) {
        console.error('[Main] Failed to register localOrganizerService:', err);
    }

    // Recursively scan source media while keeping every descendant attached to
    // the selected top-level task folder. Generated output/backup directories
    // are excluded so a later rescan cannot import finished videos as sources.
    handleTrusted('scan-directory-recursive', async (event, dirPath, options = {}) => {
        const fs = require('fs');
        const pathModule = require('path');
        const maxDepth = Math.max(0, Math.min(50, Number(options.maxDepth) || 20));
        const excludedNames = new Set((options.excludedNames || ['_auto_edit', 'backup_clips', '已排除素材', '已排除'])
            .map(name => String(name || '').toLocaleLowerCase()).filter(Boolean));
        // 审核记录保存在“审核批次_时间”目录，且其中通常有移动后的不合格素材；
        // 它只供 visual-review-load 读取 review.json，绝不能再次混入素材扫描。
        const isReviewBatchDir = name => String(name || '').toLocaleLowerCase().startsWith('审核批次');
        const files = [];
        if (!dirPath || !fs.existsSync(dirPath)) return files;

        function walk(currentDir, depth) {
            if (depth > maxDepth) return;
            let entries = [];
            try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const fullPath = pathModule.join(currentDir, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    if (!excludedNames.has(entry.name.toLocaleLowerCase()) && !isReviewBatchDir(entry.name)) walk(fullPath, depth + 1);
                    continue;
                }
                if (!entry.isFile()) continue;
                try {
                    const stat = fs.statSync(fullPath);
                    files.push({
                        name: entry.name,
                        path: fullPath,
                        relativePath: pathModule.relative(dirPath, fullPath),
                        size: stat.size,
                        mtime: stat.mtimeMs,
                        isDirectory: false,
                    });
                } catch (_) { /* skip unreadable files */ }
            }
        }
        walk(dirPath, 0);
        return files;
    });

    // IPC: 递归搜索指定文件名（查找素材功能）
    handleTrusted('search-files-recursive', async (event, searchDir, fileNames, maxDepth = 5) => {
        const result = new Map();
        const targetSet = new Set(fileNames.map(n => n.toLowerCase()));

        function walk(dir, depth) {
            if (depth > maxDepth) return;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isFile()) {
                    const lower = entry.name.toLowerCase();
                    if (targetSet.has(lower) && !result.has(lower)) {
                        result.set(lower, fullPath);
                        if (result.size >= targetSet.size) return;
                    }
                } else if (entry.isDirectory()) {
                    walk(fullPath, depth + 1);
                    if (result.size >= targetSet.size) return;
                }
            }
        }

        walk(searchDir, 0);
        const obj = {};
        for (const [k, v] of result) obj[k] = v;
        return obj;
    });

    // IPC: 批量检查文件是否存在
    handleTrusted('check-files-exist', async (event, filePaths) => {
        const results = {};
        for (const p of filePaths) {
            try { results[p] = fs.existsSync(p); } catch (_) { results[p] = false; }
        }
        return results;
    });

    handleTrusted('get-downloads-path', async () => {
        try {
            return app.getPath('downloads');
        } catch (e) {
            return null;
        }
    });

    // IPC: 批量Reels - 烧录字幕到视频
    handleTrusted('burn-subtitles', async (event, { videoPath, assContent, outputPath, crf, useGPU }) => {
        const { execFile, spawnSync } = require('child_process');
        const settingsService = require('./services/settings');
        const assPath = settingsService.secureTmpFile('reels_sub', '.ass');

        if (!outputPath) throw new Error('缺少输出路径');
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        // Write ASS content to temp file
        fs.writeFileSync(assPath, assContent, 'utf-8');
        log(`[Reels] Burning subtitles: ${videoPath} → ${outputPath}`);

        return new Promise((resolve, reject) => {
            const ffmpegBin = ffmpegService.resolveCommand ? ffmpegService.resolveCommand('ffmpeg') : 'ffmpeg';
            const platform = process.platform;
            let vcodec = 'libx264';
            let encoderArgs = ['-crf', String(crf || 23), '-preset', 'medium'];

            if (useGPU) {
                if (platform === 'darwin') {
                    vcodec = 'h264_videotoolbox';
                    encoderArgs = ['-b:v', '8M'];
                } else if (platform === 'win32') {
                    const candidates = [
                        { codec: 'h264_nvenc', args: ['-preset', 'p4', '-cq', String(crf || 23), '-b:v', '0'] },
                        { codec: 'h264_amf', args: ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(crf || 23), '-qp_p', String(crf || 23)] },
                        { codec: 'h264_qsv', args: ['-global_quality', String(crf || 23)] },
                    ];
                    for (const enc of candidates) {
                        const probe = spawnSync(ffmpegBin, [
                            '-y', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1',
                            '-c:v', enc.codec, '-frames:v', '1', '-f', 'null', '-'
                        ], { timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] });
                        if (probe.status === 0) {
                            vcodec = enc.codec;
                            encoderArgs = enc.args;
                            log(`[Reels] burn-subtitles GPU encoder: ${enc.codec}`);
                            break;
                        }
                    }
                }
            }

            const args = [
                '-i', videoPath,
                '-vf', `ass='${ffmpegService.escapeAssPathForFilter(assPath)}'`,
                '-c:a', 'copy',
                '-c:v', vcodec,
                ...encoderArgs,
                '-y',
                outputPath
            ];
            execFile(ffmpegBin, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
                // Clean up temp ASS file
                try { fs.unlinkSync(assPath); } catch (e) { /* ignore */ }
                if (err) {
                    log(`[Reels] FFmpeg error: ${stderr}`);
                    reject(new Error(ffmpegService.formatMediaError(stderr || err.message, {
                        action: '字幕烧录',
                        code: err.code,
                    })));
                } else {
                    log(`[Reels] Export done: ${outputPath}`);
                    resolve({ success: true, outputPath });
                }
            });
        });
    });

    // IPC: 批量Reels - 合成背景+配音+字幕（直连通道，避免依赖 apiRouter 路由版本）
    handleTrusted('reels-compose', async (event, payload) => {
        const data = payload || {};
        if (!data.background_path) throw new Error('缺少背景素材路径');
        if (!data.voice_path) throw new Error('缺少配音音频路径');
        if (!data.ass_content) throw new Error('缺少 ASS 字幕内容');
        if (!data.output_path) throw new Error('缺少输出路径');
        const res = await ffmpegService.composeReel({
            backgroundPath: data.background_path,
            voicePath: data.voice_path,
            assContent: data.ass_content,
            outputPath: data.output_path,
            crf: parseInt(data.crf || 23, 10),
            useGPU: data.use_gpu === true,
            loopFade: data.loop_fade !== false,
            loopFadeDur: parseFloat(data.loop_fade_dur ?? 1.0),
            voiceVolume: parseFloat(data.voice_volume ?? 1.0),
            bgVolume: parseFloat(data.bg_volume ?? 0.0),
            bgmPath: data.bgm_path || '',
            bgmVolume: parseFloat(data.bgm_volume ?? 0),
            bgmStart: Math.max(0, parseFloat(data.bgm_start ?? 0) || 0),
        });
        return { success: true, data: res };
    });

    // IPC: WYSIWYG 逐帧渲染导出（与 Canvas 预览 100% 一致）
    const { handleWysiwygIPC, attachFramePipeline, parallelExport } = require('./services/ffmpeg-rawvideo');
    handleTrusted('reels-compose-wysiwyg', async (event, action, data) => {
        const result = await handleWysiwygIPC(action, data);
        // 隐藏 renderer 若被系统终止，确保它启动的 FFmpeg 会话也被回收。
        if (action === 'start' && typeof result === 'string') {
            const sessionId = result;
            event.sender.once('destroyed', () => {
                handleWysiwygIPC('abort', { sessionId }).catch(() => {});
            });
        }
        return result;
    });
    // Reels 插入素材：只分析本地音轨停顿，不调用外部 AI 服务。
    handleTrusted('reels-detect-silence', async (event, data = {}) => {
        if (!data.filePath) throw new Error('缺少待检测的音视频文件');
        return ffmpegService.detectSilence(data.filePath, Number(data.noiseDb ?? -35), Number(data.minDuration ?? .35));
    });
    ipcMain.on('reels-frame-pipeline-open', (event, data = {}) => {
        try { assertTrustedRenderer(event); } catch { return; }
        const { port1, port2 } = new MessageChannelMain();
        const result = attachFramePipeline(data.sessionId, port1);
        try {
            event.sender.postMessage('reels-frame-pipeline-ready', {
                requestId: data.requestId,
                ...result,
            }, [port2]);
        } catch (err) {
            try { port1.close(); port2.close(); } catch (_) { }
            console.warn('[WYSIWYG] 无法建立帧流水线:', err.message);
        }
    });

    // IPC: 并行影子窗口导出（V3 多切片渲染）
    handleTrusted('parallel-wysiwyg-export', async (event, opts) => {
        return parallelExport(opts, mainWindow);
    });
    handleTrusted('get-latest-crash-diagnostic', () => getLatestRendererCrashReport());

    // 每个队列任务使用一次性隐藏 renderer。任务完成后销毁窗口，Chromium 会把
    // 该任务的 Canvas、图片与媒体解码缓存整体归还，不再累积到主界面进程。
    handleTrusted('isolated-wysiwyg-export', async (event, opts = {}) => {
        const requestId = String(opts.requestId || `isolated-${Date.now()}`);
        if (isolatedReelsRenderers.has(requestId)) throw new Error('后台渲染任务 ID 重复');
        const owner = event.sender;
        const htmlPath = path.join(__dirname, 'isolated-wysiwyg-renderer.html');
        const scriptBase = app.isPackaged
            ? path.join(__dirname, '..', 'dist')
            : path.join(__dirname, '..', 'src');
        const scriptPaths = [
            'reels-text-direction.js',
            'reels-anim-engine.js',
            'reels-rich-text.js',
            'reels-canvas-renderer.js',
            'reels-overlay.js',
            'fonts-metadata.js',
            'reels-font-manager.js',
            'reels-wysiwyg-export.js',
        ].map(name => path.join(scriptBase, name));

        return new Promise((resolve, reject) => {
            const win = new BrowserWindow({
                show: false,
                width: 160,
                height: 160,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                    backgroundThrottling: false,
                    webSecurity: false,
                },
            });
            isolatedReelsRenderers.set(requestId, win);
            let settled = false;
            const timeout = setTimeout(() => finish(new Error('后台渲染任务超时（60 分钟）')), 60 * 60 * 1000);

            const removeListeners = () => {
                ipcMain.removeListener('isolated-wysiwyg-ready', onReady);
                ipcMain.removeListener('isolated-wysiwyg-progress', onProgress);
                ipcMain.removeListener('isolated-wysiwyg-log', onLog);
                ipcMain.removeListener('isolated-wysiwyg-result', onResult);
            };
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                removeListeners();
                isolatedReelsRenderers.delete(requestId);
                if (!win.isDestroyed()) win.destroy();
                if (error) reject(error);
                else resolve(result);
            };
            const fromThisWindow = ipcEvent => ipcEvent.sender === win.webContents;
            const onReady = async ipcEvent => {
                if (!fromThisWindow(ipcEvent)) return;
                try { await require(process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'export-cpu-budget.js')) ? path.join(process.resourcesPath, 'export-cpu-budget.js') : path.join(__dirname, '..', 'resources', 'export-cpu-budget.js')).assign(win.webContents.getOSProcessId()); }
                catch (error) { finish(error); return; }
                if (win.isDestroyed()) return;
                win.webContents.send('isolated-wysiwyg-run', {
                    requestId,
                    params: opts.params || {},
                    scriptPaths,
                });
            };
            const onProgress = (ipcEvent, data = {}) => {
                if (!fromThisWindow(ipcEvent)) return;
                if (!owner.isDestroyed()) owner.send('isolated-wysiwyg-progress', { requestId, ...data });
            };
            const onLog = (ipcEvent, data = {}) => {
                if (!fromThisWindow(ipcEvent)) return;
                log(`[IsolatedReels:${requestId}] ${String(data.message || '')}`);
            };
            const onResult = (ipcEvent, data = {}) => {
                if (!fromThisWindow(ipcEvent)) return;
                if (data.success) finish(null, data.result || {});
                else finish(new Error(data.error || '后台渲染失败'));
            };
            ipcMain.on('isolated-wysiwyg-ready', onReady);
            ipcMain.on('isolated-wysiwyg-progress', onProgress);
            ipcMain.on('isolated-wysiwyg-log', onLog);
            ipcMain.on('isolated-wysiwyg-result', onResult);
            win.webContents.once('render-process-gone', (_goneEvent, details = {}) => {
                if (settled) return;
                const report = writeRendererCrashReport({
                    process: 'isolated-reels-renderer',
                    reason: details.reason || 'unknown',
                    exitCode: Number.isFinite(details.exitCode) ? details.exitCode : null,
                });
                if (report && !owner.isDestroyed()) owner.send('reels-crash-diagnostic', report);
                finish(new Error(`后台渲染进程异常退出：${details.reason || 'unknown'}`));
            });
            win.loadFile(htmlPath).catch(error => finish(error));
        });
    });
    ipcMain.on('cancel-isolated-wysiwyg-export', (_event, requestId) => {
        try { assertTrustedRenderer(_event); } catch { return; }
        const win = isolatedReelsRenderers.get(String(requestId || ''));
        if (win && !win.isDestroyed()) win.webContents.send('isolated-wysiwyg-cancel');
    });

    // IPC: 视频首尾拼接 (Hook -> Main)
    handleTrusted('concat-video', async (event, payload) => {
        return ffmpegService.concatVideo(payload);
    });

    // IPC: 保存 Web Audio 离线渲染的音频（WYSIWYG 混音）
    handleTrusted('save-rendered-audio', async (event, wavData) => {
        const settingsService = require('./services/settings');
        const tmpPath = settingsService.secureTmpFile('reels_rendered_audio', '.wav');
        const buffer = Buffer.from(wavData);
        fs.writeFileSync(tmpPath, buffer);
        log(`[WYSIWYG] 保存预渲染音频: ${tmpPath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
        return tmpPath;
    });

    // IPC: 保存 PNG 帧（分层 PNG 序列导出用）
    handleTrusted('save-png-frame', async (event, { outputPath: pngPath, rawRGBA, width, height, isPng }) => {
        try {
            if (!pngPath || typeof pngPath !== 'string' || path.extname(pngPath).toLowerCase() !== '.png') {
                return { ok: false, error: '无效的 PNG 帧输出路径（必须为 .png 文件）' };
            }
            // 已经是 PNG 数据，直接写入
            if (isPng) {
                fs.writeFileSync(pngPath, Buffer.from(rawRGBA));
                return { ok: true };
            }

            // Raw RGBA → PNG 转换
            try {
                const { PNG } = require('pngjs');
                const png = new PNG({ width, height });
                const buf = Buffer.from(rawRGBA);
                buf.copy(png.data);
                const pngBuffer = PNG.sync.write(png);
                fs.writeFileSync(pngPath, pngBuffer);
                return { ok: true };
            } catch (e) {
                // Fallback: use FFmpeg to convert raw RGBA to PNG
                const settingsService = require('./services/settings');
                const tmpRaw = settingsService.secureTmpFile('frame_raw', '.rgba');
                fs.writeFileSync(tmpRaw, Buffer.from(rawRGBA));
                const ffmpeg = ffmpegService.resolveCommand('ffmpeg');
                const { spawnSync } = require('child_process');
                const result = spawnSync(ffmpeg, [
                    '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
                    '-s', `${width}x${height}`,
                    '-i', tmpRaw,
                    '-frames:v', '1',
                    pngPath
                ], { timeout: 10000 });
                try { fs.unlinkSync(tmpRaw); } catch (_) { }
                if (result.status === 0) return { ok: true };
                const stderr = result.stderr?.toString() || '';
                log(`[Layers] PNG 帧转换失败 (code=${result.status}): ${stderr}`);
                return {
                    ok: false,
                    error: ffmpegService.formatMediaError(stderr, {
                        action: 'PNG 帧转换',
                        code: result.status,
                    }),
                };
            }
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // IPC: 导出音频为 MP3（分层 PNG 序列导出用）
    handleTrusted('export-audio-mp3', async (event, { inputPath, outputPath: mp3Path, volume, startTime = 0 }) => {
        if (!inputPath || !fs.existsSync(inputPath)) {
            return { ok: false, error: `音频文件不存在或已被移动，请重新选择：${inputPath || '未选择文件'}` };
        }
        const ffmpeg = ffmpegService.resolveCommand('ffmpeg');
        const { spawnSync } = require('child_process');
        const args = ['-y'];
        if (Number(startTime) > 0) args.push('-ss', Number(startTime).toFixed(3));
        args.push('-i', inputPath);
        if (volume != null && volume !== 1.0) {
            args.push('-af', `volume=${volume}`);
        }
        args.push('-c:a', 'libmp3lame', '-b:a', '192k', mp3Path);
        const result = spawnSync(ffmpeg, args, { timeout: 120000 });
        if (result.status !== 0) {
            const stderr = result.stderr?.toString() || result.error?.message || '';
            log(`[Layers] MP3 导出失败 (code=${result.status}): ${stderr}`);
            return {
                ok: false,
                error: ffmpegService.formatMediaError(stderr, {
                    action: 'MP3 音频导出',
                    code: result.status,
                    missingLabel: '音频文件',
                }),
            };
        }
        log(`[Layers] 音频导出: ${mp3Path}`);
        return { ok: true, path: mp3Path };
    });

    // IPC: 确保目录存在
    handleTrusted('ensure-directory', async (event, dirPath) => {
        try {
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // 将文案自动剪辑的“可二剪工程”整理到成片旁。只复制，不移动或删除原文件；
    // 重复执行会更新同名工程文件夹，避免用户在多个目录里找素材。
    handleTrusted('collect-reels-project-assets', async (event, payload = {}) => {
        const outputPath = String(payload.outputPath || '');
        if (!outputPath || !path.isAbsolute(outputPath)) return { ok: false, error: '缺少有效的成片路径' };
        const outputDir = path.dirname(outputPath);
        const baseName = path.basename(outputPath, path.extname(outputPath)) || '成片';
        const projectDir = path.join(outputDir, `${baseName}-工程`);
        // 主成片放在工程包根目录，双击就能看到；其余辅助材料再按类型收纳。
        const roleDirs = { output: '', derived: '关联成片和音频', subtitle: '字幕', reels: 'Reels工程', analysis: '自动剪辑分析', source: '原始片段' };
        const assets = Array.isArray(payload.assets) ? payload.assets : [];
        const copied = [];
        const missing = [];
        const usedTargets = new Set();
        const safeName = value => String(value || '').replace(/[\\/:*?"<>|]/g, '_');
        try {
            await fs.promises.mkdir(projectDir, { recursive: true });
            for (let index = 0; index < assets.length; index++) {
                const asset = assets[index] || {};
                const sourcePath = String(asset.path || '');
                if (!sourcePath || !path.isAbsolute(sourcePath)) continue;
                const role = Object.prototype.hasOwnProperty.call(roleDirs, asset.role) ? asset.role : 'source';
                if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
                    missing.push({ role, path: sourcePath });
                    continue;
                }
                const targetDir = roleDirs[role] ? path.join(projectDir, roleDirs[role]) : projectDir;
                await fs.promises.mkdir(targetDir, { recursive: true });
                const originalName = safeName(path.basename(sourcePath)) || `素材_${index + 1}`;
                let targetName = originalName;
                let suffix = 2;
                while (usedTargets.has(path.join(targetDir, targetName))) {
                    const ext = path.extname(originalName);
                    targetName = `${path.basename(originalName, ext)}_${suffix++}${ext}`;
                }
                const targetPath = path.join(targetDir, targetName);
                usedTargets.add(targetPath);
                await fs.promises.copyFile(sourcePath, targetPath);
                copied.push({ role, sourcePath, path: targetPath });
            }
            const manifest = {
                version: 1,
                createdAt: new Date().toISOString(),
                sourceOutputPath: outputPath,
                copied,
                missing,
                note: '这是可二剪工程包。原始文件未被移动或删除。',
            };
            const scriptText = String(payload.scriptText || '');
            await fs.promises.writeFile(path.join(projectDir, '文案.txt'), scriptText, 'utf8');
            await fs.promises.writeFile(path.join(projectDir, '工程清单.json'), JSON.stringify(manifest, null, 2), 'utf8');
            return { ok: true, complete: missing.length === 0, projectDir, copied, missing };
        } catch (error) {
            return { ok: false, error: error.message || String(error), projectDir, copied, missing };
        }
    });

    // Reels 最终导出可选择在最终成片旁再复制一份工程包。只复制，不移动源工程；
    // 这样既保留自动剪辑输出处的原工程，也方便把成片和二剪资料一起交付或归档。
    handleTrusted('copy-reels-project-package', async (event, payload = {}) => {
        const sourceProjectDir = String(payload.sourceProjectDir || '');
        const outputPath = String(payload.outputPath || '');
        if (!sourceProjectDir || !path.isAbsolute(sourceProjectDir) || !fs.existsSync(sourceProjectDir) || !fs.statSync(sourceProjectDir).isDirectory()) {
            return { ok: false, error: '原工程文件夹不存在' };
        }
        if (!outputPath || !path.isAbsolute(outputPath)) return { ok: false, error: '缺少有效的最终成片路径' };
        const baseName = path.basename(outputPath, path.extname(outputPath)) || '成片';
        const targetProjectDir = path.join(path.dirname(outputPath), `${baseName}-工程`);
        try {
            const sourceResolved = await fs.promises.realpath(sourceProjectDir);
            const targetResolved = path.resolve(targetProjectDir);
            if (sourceResolved !== targetResolved) {
                await fs.promises.mkdir(targetProjectDir, { recursive: true });
                await fs.promises.cp(sourceProjectDir, targetProjectDir, { recursive: true, force: true });
            }
            const overlayAssets = Array.isArray(payload.overlayAssets) ? payload.overlayAssets : [];
            const overlayDir = path.join(targetProjectDir, '覆层素材');
            const overlayPathMap = new Map();
            const usedOverlayNames = new Set();
            for (const sourcePath of overlayAssets) {
                if (!sourcePath || !path.isAbsolute(sourcePath) || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
                await fs.promises.mkdir(overlayDir, { recursive: true });
                const sourceName = path.basename(sourcePath).replace(/[\\/:*?"<>|]/g, '_') || '覆层素材';
                const ext = path.extname(sourceName);
                const stem = path.basename(sourceName, ext);
                let targetName = sourceName;
                let sequence = 2;
                while (usedOverlayNames.has(targetName)) targetName = `${stem}_${sequence++}${ext}`;
                usedOverlayNames.add(targetName);
                const targetPath = path.join(overlayDir, targetName);
                await fs.promises.copyFile(sourcePath, targetPath);
                overlayPathMap.set(sourcePath, targetPath);
            }
            // 旧工程包可能在“分析文件自动收集”上线前创建。仅打包时仍要从
            // 当前任务记录的原始路径补齐分析工程/报告，不能只相信源工程夹。
            const analysisAssets = Array.isArray(payload.analysisAssets) ? payload.analysisAssets : [];
            const analysisDir = path.join(targetProjectDir, '自动剪辑分析');
            const portablePathMap = new Map();
            const originalDir = path.join(targetProjectDir, '原始片段');
            const usedOriginalNames = new Set();
            for (const sourcePath of (Array.isArray(payload.originalClips) ? payload.originalClips : [])) {
                if (!sourcePath || !path.isAbsolute(sourcePath) || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
                await fs.promises.mkdir(originalDir, { recursive: true });
                const sourceName = path.basename(sourcePath);
                const ext = path.extname(sourceName);
                const stem = path.basename(sourceName, ext);
                let targetName = sourceName;
                let sequence = 2;
                while (usedOriginalNames.has(targetName)) targetName = `${stem}_${sequence++}${ext}`;
                usedOriginalNames.add(targetName);
                const targetPath = path.join(originalDir, targetName);
                await fs.promises.copyFile(sourcePath, targetPath);
                portablePathMap.set(sourcePath, targetPath);
            }
            for (const sourcePath of analysisAssets) {
                if (!sourcePath || !path.isAbsolute(sourcePath) || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
                await fs.promises.mkdir(analysisDir, { recursive: true });
                await fs.promises.copyFile(sourcePath, path.join(analysisDir, path.basename(sourcePath)));
            }
            // 一次自动剪辑的每片段转录 txt/json 都在 auto_edit_… 输出目录中。
            // 打包必须带上整个分析目录，不能只抽取总工程 JSON，否则无法回看
            // 单片段的识别证据。已独立收集的“成片名-工程”子目录不再嵌套复制。
            const analysisOutputDir = String(payload.analysisOutputDir || '');
            let analysisTargetDir = '';
            if (analysisOutputDir && path.isAbsolute(analysisOutputDir) && fs.existsSync(analysisOutputDir) && fs.statSync(analysisOutputDir).isDirectory()) {
                analysisTargetDir = path.join(analysisDir, path.basename(path.resolve(analysisOutputDir)) || '本次分析');
                const sourceResolved = await fs.promises.realpath(analysisOutputDir);
                const targetResolved = path.resolve(analysisTargetDir);
                if (!targetResolved.startsWith(`${sourceResolved}${path.sep}`) && targetResolved !== sourceResolved) {
                    await fs.promises.cp(analysisOutputDir, analysisTargetDir, {
                        recursive: true,
                        force: true,
                        filter: source => !String(source).endsWith('-工程'),
                    });
                    portablePathMap.set(analysisOutputDir, analysisTargetDir);
                }
            }
            const rebasePath = value => {
                if (typeof value !== 'string') return value;
                for (const [from, to] of portablePathMap) {
                    if (value === from) return to;
                    if (value.startsWith(`${from}${path.sep}`)) return `${to}${value.slice(from.length)}`;
                }
                return value;
            };
            const rebaseJson = value => {
                if (Array.isArray(value)) return value.map(rebaseJson);
                if (!value || typeof value !== 'object') return rebasePath(value);
                Object.keys(value).forEach(key => { value[key] = rebaseJson(value[key]); });
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
                    } catch (_) { /* 非工程 JSON 或格式异常时保留原文件 */ }
                }
            }
            await fs.promises.writeFile(path.join(targetProjectDir, '文案.txt'), String(payload.scriptText || ''), 'utf8');
            if (payload.reelsProjectData && typeof payload.reelsProjectData === 'object') {
                const projectData = JSON.parse(JSON.stringify(payload.reelsProjectData));
                const remapPaths = value => {
                    if (Array.isArray(value)) return value.map(remapPaths);
                    if (!value || typeof value !== 'object') return overlayPathMap.get(value) || rebasePath(value);
                    Object.keys(value).forEach(key => { value[key] = remapPaths(value[key]); });
                    return value;
                };
                remapPaths(projectData);
                const reelsDir = path.join(targetProjectDir, 'Reels工程');
                await fs.promises.mkdir(reelsDir, { recursive: true });
                await fs.promises.writeFile(
                    path.join(reelsDir, `${baseName}.reels-project.json`),
                    JSON.stringify(projectData, null, 2),
                    'utf8'
                );
            }
            return { ok: true, projectDir: targetProjectDir };
        } catch (error) {
            return { ok: false, error: error.message || String(error), projectDir: targetProjectDir };
        }
    });

    // IPC: 获取媒体时长
    handleTrusted('get-media-duration', async (event, filePath) => {
        return ffmpegService.getDuration(filePath);
    });
    handleTrusted('get-media-duration-detail', async (event, filePath) => {
        return ffmpegService.getDurationDetailed(filePath);
    });

    // IPC: 读取音频文件为 WAV Buffer（供渲染进程的 Web Audio decodeAudioData 使用）
    // 先用 FFmpeg 转成 WAV（支持 mp4/mp3 等任何格式）
    handleTrusted('read-file-buffer', async (event, filePath) => {
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(`文件不存在: ${filePath}`);
        }
        const allowedAudioVideoExts = new Set([
            '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.amr',
            '.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.3gp', '.m4v', '.wmv', '.ts'
        ]);
        const ext = path.extname(String(filePath)).toLowerCase();
        if (!allowedAudioVideoExts.has(ext)) {
            throw new Error(`不支持的音视频文件格式: ${ext || '未知'}`);
        }
        const settingsService = require('./services/settings');
        const { spawnSync } = require('child_process');
        const ffmpeg = ffmpegService.resolveCommand('ffmpeg');

        // 转为 WAV 供 Web Audio 使用
        const wavPath = settingsService.secureTmpFile('voice_decode', '.wav');
        const result = spawnSync(ffmpeg, [
            '-y', '-i', filePath,
            '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
            wavPath,
        ], { timeout: 30000 });

        if (result.status !== 0 || !fs.existsSync(wavPath)) {
            // 回退：直接读原文件
            log(`[read-file-buffer] FFmpeg 转 WAV 失败，直接读原文件`);
            return fs.readFileSync(filePath);
        }

        const buf = fs.readFileSync(wavPath);
        try { fs.unlinkSync(wavPath); } catch (_) { }
        log(`[read-file-buffer] ${filePath} → WAV ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
        return buf;
    });

    // IPC: 在 Finder/Explorer 中高亮文件或打开所在目录
    handleTrusted('show-item-in-folder', async (event, fullPath) => {
        if (!fullPath || typeof fullPath !== 'string') return { ok: false };
        try {
            let target = fullPath.trim();
            const hashIdx = target.indexOf('#');
            if (hashIdx !== -1) target = target.slice(0, hashIdx);
            if (/^local-media:\/\//i.test(target)) {
                target = require('url').fileURLToPath(target.replace(/^local-media:/i, 'file:'));
            } else if (/^file:\/\//i.test(target)) {
                target = require('url').fileURLToPath(target);
            }
            const sharedProfile = require('./services/sharedProfile');
            target = sharedProfile.resolveSharedProfileFilePath(path.resolve(target));
            if (fs.existsSync(target)) {
                const stat = fs.statSync(target);
                if (stat.isDirectory()) {
                    await shell.openPath(target);
                } else {
                    shell.showItemInFolder(target);
                }
                return { ok: true, path: target };
            }
            const parentDir = path.dirname(target);
            if (parentDir && fs.existsSync(parentDir)) {
                await shell.openPath(parentDir);
                return { ok: true, path: parentDir, parentFallback: true };
            }
        } catch (err) {
            log(`[show-item-in-folder] failed for ${fullPath}: ${err.message}`);
        }
        return { ok: false };
    });

    // IPC: 用系统默认浏览器打开链接
    handleTrusted('open-external-url', (event, url) => {
        if (url && typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
            shell.openExternal(url);
        }
    });

    // IPC: 获取 Google Fonts 目录，绕过 CORS
    handleTrusted('fetch-google-fonts', async () => {
        try {
            const { net } = require('electron');
            const response = await net.fetch('https://fonts.google.com/metadata/fonts', {
                signal: AbortSignal.timeout(8000),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            return text;
        } catch (err) {
            console.error('[Fonts] fetch-google-fonts failed:', err.message);
            throw err;
        }
    });

    // IPC: 扫描本地字体目录 + 系统字体（缓存系统字体，避免重复扫描 Windows 字体；本地字体目录变化时自动更新）
    const uploadedFontHashCache=new Map();
    handleTrusted('import-local-font',async(_event,{fileName,bytes}={})=>{
        const name=path.basename(String(fileName||'')).replace(/[<>:"/\\|?*]/g,'_');
        if(!['.ttf','.otf','.woff','.woff2','.ttc','.dfont'].includes(path.extname(name).toLowerCase()))throw Error('不支持的字体格式');
        const body=Buffer.from(bytes||[]);if(!body.length||body.length>32*1024*1024)throw Error('字体文件为空或超过32MB');
        const hash=require('crypto').createHash('sha256').update(body).digest('hex').slice(0,16);
        const dir=path.join(path.dirname(process.execPath),'Fonts');fs.mkdirSync(dir,{recursive:true});
        const fontExtensions=new Set(['.ttf','.otf','.woff','.woff2','.ttc','.dfont']);
        const fileHash=file=>{const stat=fs.statSync(file),signature=stat.size+':'+stat.mtimeMs,previous=uploadedFontHashCache.get(file);if(previous?.signature===signature)return previous.hash;const digest=require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0,16);uploadedFontHashCache.set(file,{signature,hash:digest});return digest;};
        const findExisting=(folder,depth=0)=>{if(depth>8)return null;for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const candidate=path.join(folder,entry.name);if(entry.isDirectory()){const found=findExisting(candidate,depth+1);if(found)return found;}else if(entry.isFile()&&fontExtensions.has(path.extname(entry.name).toLowerCase())){const stat=fs.statSync(candidate);if(stat.size===body.length&&fileHash(candidate)===hash)return candidate;}}return null;};
        const existing=findExisting(dir);let file=existing||path.join(dir,name);
        if(!existing&&fs.existsSync(file)&&fileHash(file)!==hash){const parsed=path.parse(name);file=path.join(dir,parsed.name+'-'+hash+parsed.ext);}
        if(!fs.existsSync(file))fs.writeFileSync(file,body);
        let savedMetadata={};try{savedMetadata=JSON.parse(fs.readFileSync(path.join(path.dirname(file),'font-metadata.json'),'utf8'))[path.basename(file)]||{};}catch(_){}
        const details={...require('./services/fontMetadata').readFontMetadata(file),...savedMetadata};
        const family=details.family||path.parse(name).name.replace(/[-_]/g,' ').trim();
        const data={family,weight:details.weight||'400',style:'normal',path:file,system:false};
        const manifest=path.join(path.dirname(file),'font-metadata.json');let metadata={};if(fs.existsSync(manifest))metadata=JSON.parse(fs.readFileSync(manifest,'utf8'));metadata[path.basename(file)]={family,weight:data.weight,style:data.style};const temporary=manifest+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,JSON.stringify(metadata,null,2),'utf8');fs.renameSync(temporary,manifest);
        return data;
    });
    let _cachedSystemFonts = null;
    let _cachedLocalFonts = null;
    let _cachedLocalFontsSig = '';
    handleTrusted('scan-fonts', async (event, options = {}) => {
        try {
            const os = require('os');
            const fontExts = new Set(['.ttf', '.otf', '.woff', '.woff2', '.ttc', '.dfont']);

            function inferWeightAndStyle(fileName) {
                const base = path.parse(fileName).name.toLowerCase();
                const style = /(italic|oblique)/.test(base) ? 'italic' : 'normal';
                let weight = '400';
                let hasExplicit = false;

                const rules = [
                    [/extra[\s_-]*black|ultra[\s_-]*black/, '900'],
                    [/\bblack\b/, '900'],
                    [/extra[\s_-]*bold|ultra[\s_-]*bold|heavy/, '800'],
                    [/\bsemi[\s_-]*bold\b|\bdemi[\s_-]*bold\b/, '600'],
                    [/\bbold\b/, '700'],
                    [/\bmedium\b/, '500'],
                    [/\bbook\b|\bregular\b|\bnormal\b/, '400'],
                    [/extra[\s_-]*light|ultra[\s_-]*light/, '200'],
                    [/\blight\b/, '300'],
                    [/\bthin\b|\bhairline\b/, '100'],
                ];
                for (const [re, w] of rules) {
                    if (re.test(base)) {
                        weight = w;
                        hasExplicit = true;
                        break;
                    }
                }

                if (!hasExplicit && /variablefont/.test(base)) {
                    weight = '100 900';
                }
                return { weight, style, hasExplicit };
            }

            function cleanFamilyNameFromFile(fileName) {
                let raw = path.parse(fileName).name;
                // Split CamelCase: "AppleSDGothicNeo" → "Apple SD Gothic Neo"
                raw = raw.replace(/([a-z])([A-Z])/g, '$1 $2')
                         .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
                raw = raw.replace(/[_-]+/g, ' ');
                // Remove weight/style tokens
                const cleaned = raw
                    .replace(/\b(italic|oblique|regular|normal|book|medium|semibold|semi bold|demibold|demi bold|bold|extrabold|extra bold|ultrabold|ultra bold|black|extrablack|extra black|ultrablack|ultra black|heavy|light|extralight|extra light|ultralight|ultra light|thin|hairline|variablefont|wght|wdth|opsz)\b/gi, '')
                    // Remove macOS suffixes like "HB" (Harfbuzz variants)
                    .replace(/\bHB\b$/i, '')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
                return cleaned || raw.trim();
            }

            function computeLocalDirSig(dirs) {
                const parts = [];
                for (const d of dirs) {
                    if (!d || !fs.existsSync(d)) {
                        parts.push(`${d}:missing`);
                        continue;
                    }
                    try {
                        const st = fs.statSync(d);
                        const entries = fs.readdirSync(d);
                        parts.push(`${d}:${Math.round(st.mtimeMs)}:${entries.length}:${entries.join(',')}`);
                    } catch (_) {
                        parts.push(`${d}:err`);
                    }
                }
                return parts.join('|');
            }

            // ── 扫描单个目录 ──
            function scanDir(dirPath, isSystemFont = false) {
                const results = [];
                if (!dirPath || !fs.existsSync(dirPath)) return results;
                try {
                    let directoryMetadata={};try{directoryMetadata=JSON.parse(fs.readFileSync(path.join(dirPath,'font-metadata.json'),'utf8'));}catch(_){}
                    const items = fs.readdirSync(dirPath, { withFileTypes: true });
                    for (const item of items) {
                        if (item.name.startsWith('.')) continue;
                        const fullPath = path.join(dirPath, item.name);
                        if (item.isDirectory()) {
                            const familyName = item.name.replace(/_/g, ' ');
                            try {
                                const files = fs.readdirSync(fullPath);
                                let importedMetadata = {};
                                try { importedMetadata = JSON.parse(fs.readFileSync(path.join(fullPath, 'font-metadata.json'), 'utf8')); } catch (_) {}

                                for (const fontFile of files) {
                                    const ext = path.extname(fontFile).toLowerCase();
                                    if (!fontExts.has(ext)) {
                                        const child=path.join(fullPath,fontFile);
                                        try{if(fs.lstatSync(child).isDirectory())results.push(...scanDir(child,isSystemFont));}catch(_){}
                                        continue;
                                    }
                                    const inferred = inferWeightAndStyle(fontFile);
                                    const parsedMeta = require('./services/fontMetadata').readFontMetadata(path.join(fullPath, fontFile)) || {};
                                    const imported = importedMetadata[fontFile] || {};
                                    const resolvedWeight = imported.weight
                                        || ((inferred.hasExplicit && (!parsedMeta.weight || parsedMeta.weight === '400')) ? inferred.weight : (parsedMeta.weight || inferred.weight));
                                    const resolvedStyle = imported.style
                                        || ((inferred.style === 'italic' && (!parsedMeta.style || parsedMeta.style === 'normal')) ? 'italic' : (parsedMeta.style || inferred.style));
                                    const rawFamily = imported.family || parsedMeta.family || familyName;
                                    const normalizedFamily = cleanFamilyNameFromFile(rawFamily).replace(/_/g, ' ') || familyName;
                                    results.push({
                                        family: normalizedFamily,
                                        path: path.join(fullPath, fontFile),
                                        weight: resolvedWeight,
                                        style: resolvedStyle,
                                        system: isSystemFont,
                                    });
                                }
                            } catch { /* skip unreadable dirs */ }
                        } else if (item.isFile() && fontExts.has(path.extname(item.name).toLowerCase())) {
                            const inferred = inferWeightAndStyle(item.name);
                            const parsedMeta = require('./services/fontMetadata').readFontMetadata(fullPath) || {};
                            const imported = directoryMetadata[item.name] || {};
                            const details = { ...parsedMeta, ...imported };
                            const rawFamily = details.family || cleanFamilyNameFromFile(item.name).replace(/_/g, ' ');
                            const familyName = cleanFamilyNameFromFile(rawFamily).replace(/_/g, ' ') || rawFamily;
                            const resolvedWeight = imported.weight
                                || ((inferred.hasExplicit && (!parsedMeta.weight || parsedMeta.weight === '400')) ? inferred.weight : (parsedMeta.weight || inferred.weight));
                            const resolvedStyle = imported.style
                                || ((inferred.style === 'italic' && (!parsedMeta.style || parsedMeta.style === 'normal')) ? 'italic' : (parsedMeta.style || inferred.style));
                            results.push({
                                family: familyName,
                                path: fullPath,
                                weight: resolvedWeight,
                                style: resolvedStyle,
                                system: isSystemFont,
                            });
                        }
                    }
                } catch (err) {
                    log(`[Fonts] Error scanning ${dirPath}: ${err.message}`);
                }
                return results;
            }

            // ── 1. 项目内置字体 (assets/fonts + fonts-local) ──
            const fontsDir = app.isPackaged
                ? path.join(process.resourcesPath, 'assets', 'fonts')
                : path.join(__dirname, '..', 'assets', 'fonts');
            const localDirs = [path.join(path.dirname(process.execPath),'Fonts'), fontsDir];
            if (!app.isPackaged) localDirs.push(path.join(__dirname, '..', 'fonts-local'));

            const currentLocalSig = computeLocalDirSig(localDirs);
            if (!_cachedLocalFonts || _cachedLocalFontsSig !== currentLocalSig || options?.forceRescanLocal) {
                const localScanned = [];
                for (const dir of localDirs) {
                    localScanned.push(...scanDir(dir, false));
                }
                _cachedLocalFonts = localScanned;
                _cachedLocalFontsSig = currentLocalSig;
            }

            // ── 2. 系统字体目录（缓存避免反复扫描 Windows 字体）──
            if (!_cachedSystemFonts || options?.forceRescanSystem) {
                const systemDirs = [];
                if (process.platform === 'darwin') {
                    systemDirs.push('/Library/Fonts');
                    systemDirs.push(path.join(os.homedir(), 'Library', 'Fonts'));
                    systemDirs.push('/System/Library/Fonts');
                    systemDirs.push('/System/Library/Fonts/Supplemental');
                } else if (process.platform === 'win32') {
                    const winFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
                    systemDirs.push(winFonts);
                    const userFonts = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts');
                    systemDirs.push(userFonts);
                } else {
                    systemDirs.push('/usr/share/fonts');
                    systemDirs.push('/usr/local/share/fonts');
                    systemDirs.push(path.join(os.homedir(), '.fonts'));
                    systemDirs.push(path.join(os.homedir(), '.local', 'share', 'fonts'));
                }

                const sysScanned = [];
                for (const dir of systemDirs) {
                    sysScanned.push(...scanDir(dir, true));
                }
                _cachedSystemFonts = sysScanned;
                log(`[Fonts] scanned ${_cachedLocalFonts.length + _cachedSystemFonts.length} font files (${systemDirs.length} system dirs + assets)`);
            }

            return [..._cachedLocalFonts, ..._cachedSystemFonts];
        } catch (err) {
            log(`[Fonts] scanning error: ${err.message}`);
            return [];
        }
    });

    // ==================== IPC 处理 - 缓存管理 ====================
    handleTrusted('get-cache-info', async () => {
        const userDataPath = app.getPath('userData');
        const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage'];
        let totalSize = 0;
        const details = [];
        for (const dir of cacheDirs) {
            const dirPath = path.join(userDataPath, dir);
            if (fs.existsSync(dirPath)) {
                const size = getDirSize(dirPath);
                totalSize += size;
                details.push({ name: dir, size });
            }
        }
        const overlayCachePath = path.join(userDataPath, 'tmp', 'videokit_overlay_cache');
        if (fs.existsSync(overlayCachePath)) {
            const size = getDirSize(overlayCachePath);
            totalSize += size;
            details.push({ name: 'GIF/视频覆层帧缓存', size });
        }
        return { path: userDataPath, totalSize, details };
    });

    handleTrusted('clear-cache', async () => {
        manualCacheCleaning = true;
        idleCacheMaintenance?.cancel();
        try {
        const userDataPath = app.getPath('userData');
        const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage'];
        let freedSize = 0;
        for (const dir of cacheDirs) {
            const dirPath = path.join(userDataPath, dir);
            if (fs.existsSync(dirPath)) {
                try {
                    freedSize += getDirSize(dirPath);
                    fs.rmSync(dirPath, { recursive: true, force: true });
                    log(`[Cache] Cleared: ${dirPath}`);
                } catch (e) {
                    log(`[Cache] Failed to clear ${dirPath}: ${e.message}`);
                }
            }
        }
        // Transparent GIF/video overlays are expanded into PNG sequences here.
        // They are reproducible runtime data, not user media or project data.
        const overlayCachePath = path.join(userDataPath, 'tmp', 'videokit_overlay_cache');
        if (fs.existsSync(overlayCachePath)) {
            try {
                freedSize += getDirSize(overlayCachePath);
                fs.rmSync(overlayCachePath, { recursive: true, force: true });
                log(`[Cache] Cleared: ${overlayCachePath}`);
            } catch (e) {
                log(`[Cache] Failed to clear ${overlayCachePath}: ${e.message}`);
            }
        }
        return { ok: true, freedSize };
        } finally { manualCacheCleaning = false; }
    });

    handleTrusted('open-cache-folder', () => {
        const userDataPath = app.getPath('userData');
        shell.openPath(userDataPath);
    });

    handleTrusted('set-cache-path', async (event, newPath) => {
        if (!newPath) {
            // 清除自定义路径，恢复默认
            try { fs.unlinkSync(_cacheConfigPath); } catch (_) {}
            return { ok: true, needRestart: true };
        }
        // 确保目录存在
        if (!fs.existsSync(newPath)) {
            try { fs.mkdirSync(newPath, { recursive: true }); } catch (e) {
                return { ok: false, error: '无法创建目录: ' + e.message };
            }
        }
        // 保存配置
        try {
            fs.writeFileSync(_cacheConfigPath, JSON.stringify({ userDataPath: newPath }, null, 2), 'utf-8');
            log(`[Cache] 缓存路径已更改为: ${newPath}，重启后生效`);
            return { ok: true, needRestart: true };
        } catch (e) {
            return { ok: false, error: '保存配置失败: ' + e.message };
        }
    });

    function getDirSize(dirPath) {
        let size = 0;
        try {
            const items = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dirPath, item.name);
                try {
                    if (item.isDirectory()) {
                        size += getDirSize(fullPath);
                    } else {
                        size += fs.statSync(fullPath).size;
                    }
                } catch { /* skip */ }
            }
        } catch { /* skip */ }
        return size;
    }

    // 注册 API 路由（替代 Python Flask 后端）
    registerAPIHandlers();
    log('API handlers registered - no Python backend needed');

    // ==================== 屏幕取色器（解决 Windows 吸管无法吸取窗口外颜色） ====================
    handleTrusted('screen-pick-color', async () => {
        try {
            // 获取主显示器信息
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width: sw, height: sh } = primaryDisplay.size;
            const scaleFactor = primaryDisplay.scaleFactor || 1;

            // 截取整个屏幕
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: sw * scaleFactor, height: sh * scaleFactor },
            });
            if (!sources || sources.length === 0) {
                log('[ColorPicker] No screen source found');
                return null;
            }
            const screenshot = sources[0].thumbnail;
            const dataUrl = screenshot.toDataURL();

            return new Promise((resolve) => {
                // 创建全屏透明窗口，覆盖整个屏幕
                const pickerWin = new BrowserWindow({
                    x: 0, y: 0,
                    width: sw, height: sh,
                    frame: false,
                    transparent: false,
                    alwaysOnTop: true,
                    skipTaskbar: true,
                    fullscreen: false,
                    resizable: false,
                    movable: false,
                    focusable: true,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                        sandbox: true,
                    },
                });

                pickerWin.setMenuBarVisibility(false);
                pickerWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
                pickerWin.webContents.on('will-navigate', (e) => e.preventDefault());

                // 注入 HTML：显示截图 + 点击取色
                const html = `<!DOCTYPE html>
<html><head><style>
  * { margin:0; padding:0; }
  html, body { width:100%; height:100%; overflow:hidden; cursor:crosshair; }
  canvas { display:block; width:100%; height:100%; }
  #loupe {
    position:fixed; pointer-events:none; display:none;
    width:120px; height:120px; border-radius:50%;
    border:3px solid #fff; box-shadow:0 0 12px rgba(0,0,0,.6);
    overflow:hidden; z-index:999;
    image-rendering: pixelated;
  }
  #loupe canvas { width:120px; height:120px; image-rendering:pixelated; }
  #crosshair {
    position:fixed; pointer-events:none; display:none;
    width:1px; height:1px; z-index:1000;
  }
  #crosshair::before, #crosshair::after {
    content:''; position:absolute; background:rgba(255,255,255,.6);
  }
  #crosshair::before { width:1px; height:20px; left:0; top:-10px; }
  #crosshair::after { width:20px; height:1px; left:-10px; top:0; }
  #colorLabel {
    position:fixed; pointer-events:none; display:none;
    padding:4px 10px; border-radius:4px;
    font:bold 13px/1.2 monospace; color:#fff;
    background:rgba(0,0,0,.75); z-index:1001;
    white-space:nowrap;
  }
</style></head><body>
<canvas id="c"></canvas>
<div id="loupe"><canvas id="lc" width="120" height="120"></canvas></div>
<div id="crosshair"></div>
<div id="colorLabel"></div>
<script>
  const img = new Image();
  const scaleFactor = ${scaleFactor};
  img.onload = () => {
    const c = document.getElementById('c');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    const loupe = document.getElementById('loupe');
    const lc = document.getElementById('lc');
    const lctx = lc.getContext('2d', { willReadFrequently: true });
    const crosshair = document.getElementById('crosshair');
    const colorLabel = document.getElementById('colorLabel');

    function getColor(x, y) {
      const px = Math.round(x * scaleFactor);
      const py = Math.round(y * scaleFactor);
      const d = ctx.getImageData(px, py, 1, 1).data;
      return '#' + [d[0],d[1],d[2]].map(v => v.toString(16).padStart(2,'0')).join('');
    }

    document.addEventListener('mousemove', e => {
      const x = e.clientX, y = e.clientY;
      // 放大镜
      loupe.style.display = 'block';
      crosshair.style.display = 'block';
      colorLabel.style.display = 'block';

      // 放大镜位置：跟随鼠标但偏移
      let lx = x + 20, ly = y - 140;
      if (lx + 130 > window.innerWidth) lx = x - 140;
      if (ly < 10) ly = y + 20;
      loupe.style.left = lx + 'px';
      loupe.style.top = ly + 'px';

      // 绘制放大区域 (8x 放大)
      const zoom = 8;
      const srcSize = 15; // 15x15 像素区域
      const px = Math.round(x * scaleFactor);
      const py = Math.round(y * scaleFactor);
      lctx.clearRect(0, 0, 120, 120);
      lctx.imageSmoothingEnabled = false;
      lctx.drawImage(c,
        px - srcSize/2, py - srcSize/2, srcSize, srcSize,
        0, 0, 120, 120
      );
      // 中心十字线
      lctx.strokeStyle = 'rgba(255,255,255,0.8)';
      lctx.lineWidth = 1;
      lctx.strokeRect(56, 56, 8, 8);

      crosshair.style.left = x + 'px';
      crosshair.style.top = y + 'px';

      const hex = getColor(x, y);
      colorLabel.textContent = hex.toUpperCase();
      colorLabel.style.left = (lx) + 'px';
      colorLabel.style.top = (ly + 128) + 'px';
      colorLabel.style.borderLeft = '4px solid ' + hex;
    });

    document.addEventListener('mousedown', e => {
      e.preventDefault();
      const hex = getColor(e.clientX, e.clientY);
      // 使用 document.title 通信回主进程
      document.title = 'PICKED:' + hex;
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        document.title = 'PICKED:';
      }
    });
  };
  img.src = "${dataUrl}";
</script></body></html>`;

                pickerWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

                // 监听 title 变化获取拾取结果
                pickerWin.webContents.on('page-title-updated', (e, title) => {
                    if (title.startsWith('PICKED:')) {
                        const hex = title.replace('PICKED:', '').trim();
                        pickerWin.destroy();
                        resolve(hex || null);
                    }
                });

                pickerWin.on('closed', () => {
                    resolve(null);
                });

                // 安全超时：30 秒后自动关闭
                setTimeout(() => {
                    if (!pickerWin.isDestroyed()) pickerWin.destroy();
                }, 30000);
            });
        } catch (err) {
            log('[ColorPicker] Error: ' + err.message);
            return null;
        }
    });

    // ==================== 模板多窗口支持 ====================
    handleTrusted('open-template-window', (event, templateId, templateName) => {
        // 如果已有该模板的窗口，聚焦它
        if (templateWindows.has(templateId)) {
            const existingWin = templateWindows.get(templateId);
            if (!existingWin.isDestroyed()) {
                existingWin.focus();
                return { success: true, reused: true };
            }
            templateWindows.delete(templateId);
        }

        const winOpts = {
            width: 1200,
            height: 800,
            minWidth: 900,
            minHeight: 700,
            title: `模板: ${templateName || templateId}`,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: false,
                backgroundThrottling: false,
                webSecurity: true, // Re-enabled for security; local media loads via local-media:// protocol
                preload: path.join(__dirname, 'preload.js'),
            },
        };

        if (process.platform === 'darwin') {
            winOpts.titleBarStyle = 'hiddenInset';
            winOpts.trafficLightPosition = { x: 15, y: 15 };
        }

        const win = new BrowserWindow(winOpts);
        attachTemplateLibraryNavigation(win);
        win.webContents.on('will-navigate', (event, url) => {
            if (!isTrustedRendererUrl(url, { packaged: app.isPackaged, port: DEV_SERVER_PORT })) event.preventDefault();
        });
        win.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
            return { action: 'deny' };
        });

        // 通过 URL hash 传递模板 ID，前端启动时读取
        if (!app.isPackaged) {
            win.loadURL(`${DEV_SERVER_URL}/#template=${templateId}`);
            win.webContents.openDevTools();
        } else {
            win.loadFile(path.join(__dirname, '../dist/index.html'), {
                hash: `template=${templateId}`,
            });
        }

        templateWindows.set(templateId, win);
        win.on('closed', () => {
            templateWindows.delete(templateId);
        });

        log(`[Template] 打开模板窗口: ${templateName} (${templateId})`);
        return { success: true, reused: false };
    });

    // 防止 macOS App Nap
    if (process.platform === 'darwin') {
        powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
        log(`PowerSaveBlocker started: ${powerSaveId}`);
    }

    // 直接创建窗口（不需要等待后端启动了！）
    createWindow();

    try { startIdleCacheMaintenance(); } catch (error) { log('[IdleCache] 初始化失败: '+error.message); }

    // 自动更新：仅在打包版启用（开发模式跳过）
    if (app.isPackaged && mainWindow && !_portableMode) {
        initAutoUpdater(mainWindow, log);
    } else {
        log('[Updater] 开发模式，跳过自动更新初始化');
        // 开发模式下注册 fallback handler，避免前端报错
        handleTrusted('get-update-channel', () => ({
            channel: 'stable', currentVersion: app.getVersion(), isBeta: false,
        }));
        handleTrusted('set-update-channel', () => ({ success: true, channel: 'stable' }));
    }
});

app.on('window-all-closed', () => {
    isQuitting = true;
    app.isQuitting = true;
    try {
        if (typeof app.releaseSingleInstanceLock === 'function') {
            app.releaseSingleInstanceLock();
        }
    } catch (_) {}
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (appIsReady && BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('before-quit', () => {
    isQuitting = true;
    idleCacheMaintenance?.stop();
    app.isQuitting = true;
    try {
        if (typeof app.releaseSingleInstanceLock === 'function') {
            app.releaseSingleInstanceLock();
        }
    } catch (_) {}
});

function attachTemplateLibraryNavigation(win){
    win.on('app-command',(_event,command)=>{
        const direction=command==='browser-backward'?'back':command==='browser-forward'?'forward':null;
        if(direction&&!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('template-library:navigate',direction);
    });
}
