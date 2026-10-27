/**
 * reels-project.js — 项目管理（保存/加载）
 * 
 * 完整移植自 AutoSub_v8:
 *   - collect_project_data()  → 项目序列化
 *   - apply_project_data()    → 项目反序列化
 *   - _normalize_project_data → 版本兼容修复
 * 
 * 项目以 JSON 格式存储，包含：
 *   - 所有任务（视频路径、字幕片段、样式）
 *   - 时间线（轨道、片段、媒体源）
 *   - 导出设置
 *   - UI 状态
 */

const PROJECT_VERSION = '2.0.0';

const REELS_TASK_EXTRA_FIELDS = [
    'txtPath', 'txtContent', 'ttsText', 'ttsVoiceId', 'aiScript', 'aligned',
    'exportName', 'status', 'error',
    'bgScale', 'bgRotation', 'bgX', 'bgY', 'bgFlipH', 'bgFlipV', 'bgDurScale', 'audioDurScale',
    'bgMode', 'bgClipPool', 'bgTransition', 'bgTransDur', 'bgClipSettings', 'bgMinClipDur', 'bgMaxClipDur',
    'bgmPath', 'bgmVolume', 'bgmStart', 'bgVideoVolume',
    'bgmMode', 'bgmClipPool', 'bgmClipActivePool', 'bgmClipOrder',
    'contentVideoPath', 'contentVideoTrimStart', 'contentVideoTrimEnd',
    'contentVideoScale', 'contentVideoX', 'contentVideoY', 'contentVideoVolume',
    'contentVideoFlipH', 'contentVideoFlipV',
    'contentVideoCrop', 'contentVideoBlurBg', 'contentVideoDirectBg', 'contentVideoBlur', 'contentVideoBrightness',
    'overlays', 'cover', 'watermarks',
    'pipPath',
    'hookFile', 'hookTrimStart', 'hookTrimEnd', 'hookSpeed',
    'hookTransition', 'hookTransDuration', 'hook',
    // 每条任务独立的插入素材时间线。旧工程没有该字段时保持空数组，
    // 不会改变已有背景/覆层的预览或导出结果。
    'insertClips', 'insertMediaFolder', 'insertMediaFiles', 'insertDefaultsOverride', 'visualOverlayOrder',
    'customDuration',
    // 文案自动剪辑送入 Reels 时保留来源工程、原片和审核快照，供以后追溯和二剪。
    'autoEditProject',
    '_overlayPresetName',
    'firstSubtitleStyleOverride',
    'writingTitle', 'writingSplit',
];

function _clonePlain(value) {
    if (value === undefined) return undefined;
    try {
        // 使用 replacer 过滤掉 _ 开头的运行时临时属性
        // (如 _allOverlays 造成循环引用, _renderedX/_renderedY 等渲染缓存)
        return JSON.parse(JSON.stringify(value, (key, val) => {
            if (key && key.startsWith('_') && key !== '_subtitlePreset' && key !== '_overlayPresetName') return undefined;
            return val;
        }));
    } catch (e) {
        console.warn('[Project] _clonePlain failed for value, stripping problematic keys:', e.message);
        return undefined;
    }
}

// ═══════════════════════════════════════════════════════
// 1. Collect Project Data (序列化)
// ═══════════════════════════════════════════════════════

/**
 * 将当前工作状态序列化为可保存的 JSON 对象。
 * @param {object} state - 当前应用状态
 * @param {Array} state.tasks - 任务列表
 * @param {object} state.style - 全局字幕样式
 * @param {object} state.exportOpts - 导出选项
 * @param {number} state.selectedIdx - 当前选中任务
 * @returns {object} 项目数据
 */
function collectProjectData(state) {
    const { tasks = [], backgroundLibrary = [], style = {}, exportOpts = {}, selectedIdx = -1 } = state;

    const tasksData = tasks.map(task => {
        const taskData = {
            baseName: task.baseName || '',
            bgPath: task.bgPath || task.videoPath || '',
            videoPath: task.videoPath || '',
            audioPath: task.audioPath || '',
            srtPath: task.srtPath || '',
            fileName: task.fileName || '',
            segments: _sanitizeSegments(task.segments || []),
            style: JSON.parse(JSON.stringify(task.style || task.subtitleStyle || style)),
        };

        if (task.subtitleStyle) {
            taskData.subtitleStyle = JSON.parse(JSON.stringify(task.subtitleStyle));
        }
        if (task._subtitlePreset) {
            taskData._subtitlePreset = task._subtitlePreset;
        }

        for (const field of REELS_TASK_EXTRA_FIELDS) {
            if (task[field] !== undefined) {
                const cloned = _clonePlain(task[field]);
                if (cloned !== undefined) taskData[field] = cloned;
            }
        }

        // blob: URL 不可序列化（重载后失效），保存时剥离
        if (task.bgSrcUrl && !String(task.bgSrcUrl).startsWith('blob:')) {
            taskData.bgSrcUrl = task.bgSrcUrl;
        }
        if (task.srcUrl && !String(task.srcUrl).startsWith('blob:')) {
            taskData.srcUrl = task.srcUrl;
        }

        // 时间线序列化
        if (task.timeline) {
            if (typeof task.timeline.toJSON === 'function') {
                taskData.timeline = task.timeline.toJSON();
            } else {
            taskData.timeline = _clonePlain(task.timeline);
            }
        }

        // 覆层
        if (task.textOverlays) {
            taskData.textOverlays = _clonePlain(task.textOverlays);
        }
        if (task.imageOverlays) {
            taskData.imageOverlays = _clonePlain(task.imageOverlays);
        }

        // 前置片段
        if (task.introMedia) {
            taskData.introMedia = JSON.parse(JSON.stringify(task.introMedia));
        }

        // 音量
        taskData.srcVolume = task.srcVolume || 1.0;

        return taskData;
    });

    return {
        version: PROJECT_VERSION,
        createdAt: new Date().toISOString(),
        app: 'VideoKit',
        style: JSON.parse(JSON.stringify(style)),
        exportOpts: JSON.parse(JSON.stringify(exportOpts)),
        tasks: tasksData,
        backgroundLibrary: JSON.parse(JSON.stringify(backgroundLibrary || [])),
        selectedIdx: selectedIdx,
    };
}

// ═══════════════════════════════════════════════════════
// 2. Apply Project Data (反序列化)
// ═══════════════════════════════════════════════════════

/**
 * 从保存的项目数据恢复工作状态。
 * @param {object} data - 项目 JSON 数据
 * @returns {object} 恢复的状态 { tasks, style, exportOpts, selectedIdx, warnings }
 */
function applyProjectData(data) {
    if (!data || typeof data !== 'object') {
        return { tasks: [], style: {}, exportOpts: {}, selectedIdx: -1, warnings: ['无效的项目数据'] };
    }

    // 版本兼容修复
    const normalized = _normalizeProjectData(data);
    const warnings = [];

    const tasks = (normalized.tasks || []).map(t => {
        const bgPath = t.bgPath || t.videoPath || t.path || t.video || '';
        const subtitleStyle = t.subtitleStyle || t.subtitle_style || t.style || {};
        // 恢复时：重新生成可用的 file:// URL，不使用过期的 blob URL
        let restoredSrcUrl = t.bgSrcUrl || t.srcUrl || null;
        if (restoredSrcUrl && String(restoredSrcUrl).startsWith('blob:')) {
            restoredSrcUrl = null; // blob URL 已失效
        }
        if (!restoredSrcUrl && bgPath && (bgPath.includes('/') || bgPath.includes('\\'))) {
            // 从绝对路径生成有效的 file:// URL
            if (window.electronAPI && window.electronAPI.toFileUrl) {
                restoredSrcUrl = window.electronAPI.toFileUrl(bgPath);
            }
        }
        const task = {
            ...(_clonePlain(t) || {}),
            baseName: t.baseName || _extractFileName(bgPath).replace(/\.[^.]+$/, ''),
            bgPath: bgPath,
            videoPath: t.videoPath || bgPath,
            bgSrcUrl: restoredSrcUrl,
            srcUrl: restoredSrcUrl,
            audioPath: t.audioPath || '',
            srtPath: t.srtPath || '',
            fileName: t.fileName || _extractFileName(bgPath || t.audioPath || ''),
            segments: t.segments || [],
            style: t.style || normalized.style || {},
            subtitleStyle,
            _subtitlePreset: t._subtitlePreset || t.subtitlePreset || t.subtitle_preset || '',
            srcVolume: t.srcVolume || 1.0,
        };

        // 检查文件是否存在 (仅记录警告，不阻断)
        if (task.bgPath && !task.bgPath.startsWith('/') && !task.bgPath.startsWith('C:')) {
            warnings.push(`相对路径: ${task.bgPath}`);
        }

        // 时间线反序列化
        if (t.timeline && window.ReelsTimeline) {
            task.timeline = ReelsTimeline.Timeline.fromJSON(t.timeline);
        } else if (t.timeline) {
            task.timeline = t.timeline;
        }

        // 覆层
        task.textOverlays = t.textOverlays || t.text_overlays || [];
        task.imageOverlays = t.imageOverlays || t.image_overlays || [];
        task.introMedia = t.introMedia || t.intro_media || null;

        for (const field of REELS_TASK_EXTRA_FIELDS) {
            if (t[field] !== undefined) {
                const cloned = _clonePlain(t[field]);
                if (cloned !== undefined) task[field] = cloned;
            }
        }

        return task;
    });

    return {
        tasks,
        backgroundLibrary: normalized.backgroundLibrary || normalized.background_library || [],
        style: normalized.style || {},
        exportOpts: normalized.exportOpts || normalized.export_opts || {},
        selectedIdx: normalized.selectedIdx || normalized.curr_idx || 0,
        warnings,
    };
}

// ═══════════════════════════════════════════════════════
// 3. Version Normalization (版本兼容修复)
// ═══════════════════════════════════════════════════════

function _normalizeProjectData(data) {
    const version = data.version || '1.0.0';
    const result = JSON.parse(JSON.stringify(data));

    // 普通打字机过去没有独立的“未现字透明度”控件，却把缺失值当成
    // 100/255（或样式引擎的 0.4）来画。旧工程因此会露出后续灰字。
    // 这些都是历史默认值，不是用户可在当时明确设置的普通打字机参数；
    // 只迁移一次，之后用户在新控件设置的值绝不再被覆盖。
    const migrateTypewriterUnreadOpacity = (style) => {
        if (!style || typeof style !== 'object' || style._typewriterUnreadOpacityV2) return;
        if (style.anim_in_type === 'typewriter') {
            const raw = style.tw_unrevealed_opacity;
            if (raw === undefined || raw === 0.4 || raw === 100) {
                style.tw_unrevealed_opacity = 0;
            }
        }
        style._typewriterUnreadOpacityV2 = true;
    };
    migrateTypewriterUnreadOpacity(result.style);

    // AutoSub 旧格式兼容
    if (result.tasks) {
        for (const task of result.tasks) {
            // 旧字段映射
            if (task.path && !task.videoPath) task.videoPath = task.path;
            if (task.video && !task.videoPath) task.videoPath = task.video;
            if (!task.bgPath && task.videoPath) task.bgPath = task.videoPath;

            // 样式修复：确保关键字段存在
            if (task.style) {
                if (!task.style.font_family) task.style.font_family = 'Arial';
                if (!task.style.fontsize) task.style.fontsize = 74;
                if (task.style.color_text === undefined) task.style.color_text = '#FFFFFF';
            }
            migrateTypewriterUnreadOpacity(task.style);
            migrateTypewriterUnreadOpacity(task.subtitleStyle);
            migrateTypewriterUnreadOpacity(task.subtitle_style);

            // segments 修复：确保 start/end 是秒
            if (task.segments) {
                for (const seg of task.segments) {
                    // 毫秒 → 秒 转换 (如果值 > 1000 视为毫秒)
                    if (typeof seg.start === 'number' && seg.start > 1000) {
                        seg.start = seg.start / 1000;
                    }
                    if (typeof seg.end === 'number' && seg.end > 1000) {
                        seg.end = seg.end / 1000;
                    }
                }
            }
        }
    }

    return result;
}

// ═══════════════════════════════════════════════════════
// 4. Save & Load (文件读写)
// ═══════════════════════════════════════════════════════

/**
 * 保存项目到文件。
 * @param {object} state - 当前应用状态
 */
async function saveProject(state, options = {}) {
    // 这是唯一会打开 macOS 原生“另存为”窗口的工程保存入口。启动恢复、
    // 自动保存和热更新绝不能调用它；它们应写各自的静默恢复文件。
    if (options.interactive !== true) {
        console.warn('[ReelsProject] 忽略未授权的交互式工程保存请求');
        return { success: false, canceled: true, ignored: true };
    }
    const projectData = collectProjectData(state);
    const json = JSON.stringify(projectData, null, 2);

    if (window.electronAPI && window.electronAPI.saveFile) {
        // Electron 环境：使用原生保存对话框
        const result = await window.electronAPI.saveFile({
            defaultPath: `reels_project_${_dateStr()}.json`,
            filters: [
                { name: 'Reels Project', extensions: ['json'] },
            ],
            content: json,
        });
        return result;
    } else {
        // 浏览器环境：下载
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `reels_project_${_dateStr()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        return { success: true };
    }
}

// 自动剪辑成片送入 Reels 后，立即在成片旁写入完整工程。清空当前队列不会
// 删除该 JSON；以后用“加载工程”打开即可继续改字幕、覆层和时间线。
async function saveAutoEditRecoveryProject(state, task, autoEditResult = {}) {
    const outputPath = String(autoEditResult.output_path || autoEditResult.outputPath || task?.bgPath || '');
    if (!outputPath || !window.electronAPI?.writeFileText) return { ok: false, path: '' };
    const slash = Math.max(outputPath.lastIndexOf('/'), outputPath.lastIndexOf('\\'));
    if (slash < 0) return { ok: false, path: '' };
    const outputDir = outputPath.slice(0, slash);
    const baseName = outputPath.slice(slash + 1).replace(/\.[^.]+$/, '') || 'auto_edit';
    const sep = outputDir.includes('\\') ? '\\' : '/';
    const projectPath = `${outputDir}${sep}${baseName}.reels-project.json`;
    const projectData = collectProjectData(state);
    projectData.autoEditRecovery = {
        version: 1,
        createdAt: new Date().toISOString(),
        outputPath,
        srtPath: autoEditResult.srt_path || autoEditResult.srtPath || task?.srtPath || '',
        autoEditAnalysisProjectPath: autoEditResult.project_path || autoEditResult.projectPath || task?.autoEditProject?.analysisProjectPath || '',
        note: '自动保存：可在批量 Reels 的“加载项目”中打开，继续二次编辑。',
    };
    const ok = window.electronAPI.writeFileText(projectPath, JSON.stringify(projectData, null, 2));
    if (ok !== true) return { ok: false, path: '' };

    const analysisProjectPath = autoEditResult.project_path || autoEditResult.projectPath || task?.autoEditProject?.analysisProjectPath || '';
    const originalClips = Array.isArray(autoEditResult.clips)
        ? autoEditResult.clips
        : (Array.isArray(task?.autoEditProject?.originalClips) ? task.autoEditProject.originalClips : []);
    let collection = { ok: false, projectDir: '' };
    if (typeof window.electronAPI.collectReelsProjectAssets === 'function') {
        const derivativePaths = [
            autoEditResult.final_video_path, autoEditResult.finalVideoPath,
            autoEditResult.subtitled_path, autoEditResult.subtitledPath,
            autoEditResult.mp3_path, autoEditResult.mp3Path,
            autoEditResult.voice_changed_mp3_path, autoEditResult.voiceChangedMp3Path,
            autoEditResult.voice_changed_video_path, autoEditResult.voiceChangedVideoPath,
            autoEditResult.manual_audio_path, autoEditResult.manualAudioPath,
            autoEditResult.manual_audio_video_path, autoEditResult.manualAudioVideoPath,
        ].filter(Boolean);
        const scriptText = String(
            autoEditResult.script_text || autoEditResult.scriptText || task?.autoEditProject?.scriptText ||
            (Array.isArray(task?.segments)
                ? task.segments.map(segment => segment?.edited_text || segment?.text || '').filter(Boolean).join('\n')
                : '')
        );
        collection = await window.electronAPI.collectReelsProjectAssets({
            outputPath,
            scriptText,
            assets: [
                { role: 'output', path: outputPath },
                ...derivativePaths.filter(path => path !== outputPath).map(path => ({ role: 'derived', path })),
                { role: 'subtitle', path: autoEditResult.srt_path || autoEditResult.srtPath || task?.srtPath || '' },
                { role: 'reels', path: projectPath },
                { role: 'analysis', path: analysisProjectPath },
                { role: 'analysis', path: autoEditResult.report_path || autoEditResult.reportPath || task?.autoEditProject?.analysisReportPath || '' },
                ...originalClips.map(path => ({ role: 'source', path })),
            ],
        });
    }
    return { ok: true, path: projectPath, collection };
}

/**
 * 从文件加载项目。
 * @returns {Promise<object>} 恢复的状态
 */
async function loadProject() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) { resolve(null); return; }

            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const result = applyProjectData(data);
                resolve(result);
            } catch (err) {
                console.error('[Project] Failed to load:', err);
                alert(`项目加载失败: ${err.message}`);
                resolve(null);
            }
        };
        input.click();
    });
}

/**
 * 自动保存到文件系统（优先）或 localStorage（降级）。
 * localStorage 有 5-10MB 限制，大项目（含大量 word-level segments）会静默失败。
 */
function autoSaveProject(state) {
    try {
        const projectData = collectProjectData(state);
        const json = JSON.stringify(projectData);

        // 优先写入文件系统（无大小限制）
        if (window.electronAPI && window.electronAPI.writeFileText) {
            const savePath = _getAutoSaveFilePath();
            if (savePath) {
                window.electronAPI.writeFileText(savePath, json);
                window.electronAPI.writeFileText(savePath + '.time', new Date().toISOString());
                return;
            }
        }

        // 降级: localStorage
        localStorage.setItem('reels_autosave', json);
        localStorage.setItem('reels_autosave_time', new Date().toISOString());
    } catch (err) {
        console.warn('[Project] Auto-save failed:', err);
    }
}

/**
 * 从文件系统（优先）或 localStorage 恢复自动保存。
 */
function loadAutoSave() {
    try {
        let json = null;
        let time = null;

        // 优先从文件系统读取
        if (window.electronAPI && window.electronAPI.readFileText) {
            const savePath = _getAutoSaveFilePath();
            if (savePath) {
                const content = window.electronAPI.readFileText(savePath);
                if (content && content.length > 2) {
                    json = content;
                    time = window.electronAPI.readFileText(savePath + '.time') || '';
                }
            }
        }

        // 降级: localStorage
        if (!json) {
            json = localStorage.getItem('reels_autosave');
            time = localStorage.getItem('reels_autosave_time');
        }

        if (!json) return null;

        const data = JSON.parse(json);
        const result = applyProjectData(data);
        result.autoSaveTime = time;
        return result;
    } catch (err) {
        console.warn('[Project] Auto-load failed:', err);
        return null;
    }
}

/** 获取自动保存文件路径（由 preload.js 预计算） */
function _getAutoSaveFilePath() {
    if (window.electronAPI && window.electronAPI.autoSavePath) {
        return window.electronAPI.autoSavePath;
    }
    return null;
}

/**
 * 清除自动保存。
 */
function clearAutoSave() {
    localStorage.removeItem('reels_autosave');
    localStorage.removeItem('reels_autosave_time');
}

// ═══════════════════════════════════════════════════════
// 5. Utilities
// ═══════════════════════════════════════════════════════

function _sanitizeSegments(segments) {
    return (segments || []).map(seg => ({
        start: seg.start,
        end: seg.end,
        text: seg.text || '',
        edited_text: seg.edited_text || undefined,
        styled_ranges: seg.styled_ranges || undefined,
        style_override: seg.style_override || undefined,
        words: seg.words || undefined,
    })).filter(s => typeof s.start === 'number' && typeof s.end === 'number');
}

function _extractFileName(path) {
    if (!path) return '';
    return path.split('/').pop().split('\\').pop() || '';
}

function _dateStr() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

const ReelsProject = {
    PROJECT_VERSION,
    collectProjectData,
    applyProjectData,
    saveProject,
    saveAutoEditRecoveryProject,
    loadProject,
    autoSaveProject,
    loadAutoSave,
    clearAutoSave,
};

if (typeof window !== 'undefined') window.ReelsProject = ReelsProject;
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsProject;
