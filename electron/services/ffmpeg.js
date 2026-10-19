/**
 * FFmpeg/FFprobe 操作封装
 * 替代 Python 后端中所有 subprocess.run(ffmpeg/ffprobe...) 调用
 */
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { formatMediaError, formatProcessStartError } = require('./media-error');

// 超时默认值
const DEFAULT_TIMEOUT = 600000; // 10 分钟
const PROBE_TIMEOUT = 30000;    // 30 秒
// FFmpeg 会把连续的编码进度写到 stderr。长视频或批量导出时若完整累积，
// Electron 主进程会持续涨内存，最终可能把渲染窗口拖至白屏。保留末尾日志
// 仍足够给 formatMediaError 提取实际失败原因。
const MAX_PROCESS_LOG_CHARS = 4 * 1024 * 1024;

function appendProcessLog(previous, chunk) {
    const next = previous + String(chunk || '');
    return next.length > MAX_PROCESS_LOG_CHARS
        ? next.slice(-MAX_PROCESS_LOG_CHARS)
        : next;
}

function expandHomePath(p) {
    if (!p || typeof p !== 'string') return p;
    if (p === '~') return os.homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}

/**
 * 解析命令路径 - 优先使用环境变量中配置的路径
 */
function resolveCommand(cmd) {
    if (cmd === 'ffmpeg' && process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    if (cmd === 'ffprobe' && process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
    if (cmd !== 'ffmpeg' && cmd !== 'ffprobe') return cmd;

    // Do not rely solely on main.js having populated environment variables.
    // Transcription can be invoked from a freshly loaded/cached service module,
    // and packaged builds may not expose the bundled binary on the system PATH.
    const exeName = process.platform === 'win32' ? `${cmd}.exe` : cmd;
    const roots = [
        path.join(__dirname, '..', '..', 'vendor'),
        typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'vendor') : '',
        process.platform === 'win32' && process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'Programs', 'videokit', 'resources', 'vendor')
            : '',
    ].filter(Boolean);
    const relativeDirs = process.platform === 'win32'
        ? [path.join('ffmpeg', 'bin'), path.join('windows', 'ffmpeg', 'bin'), 'ffmpeg']
        : process.platform === 'darwin'
            ? ['ffmpeg', path.join('darwin', 'ffmpeg')]
            : ['ffmpeg', path.join('linux', 'ffmpeg'), path.join('linux', 'ffmpeg', 'bin')];
    for (const root of roots) {
        for (const relativeDir of relativeDirs) {
            const candidate = path.join(root, relativeDir, exeName);
            if (fs.existsSync(candidate)) {
                if (cmd === 'ffmpeg') process.env.FFMPEG_PATH = candidate;
                else process.env.FFPROBE_PATH = candidate;
                return candidate;
            }
        }
    }
    return cmd;
}

/**
 * 执行 FFmpeg/FFprobe 命令，返回 Promise
 */
function runCommand(cmd, args, options = {}) {
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    const resolvedCmd = resolveCommand(cmd);
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const proc = spawn(resolvedCmd, args, {
            timeout,
            env: { ...process.env, ...options.env },
            cwd: options.cwd,
        });
        let cancelled = false;
        const abort = () => {
            cancelled = true;
            try { proc.kill('SIGTERM'); } catch (_) { }
        };
        if (options.signal) {
            if (options.signal.aborted) abort();
            else options.signal.addEventListener('abort', abort, { once: true });
        }
        proc.stdout.on('data', d => { stdout = appendProcessLog(stdout, d); });
        proc.stderr.on('data', d => { stderr = appendProcessLog(stderr, d); });
        proc.on('close', code => {
            if (options.signal) options.signal.removeEventListener('abort', abort);
            if (cancelled || options.signal?.aborted) {
                reject(new Error('任务已停止'));
                return;
            }
            if (code === 0 || options.allowNonZero) {
                resolve({ stdout, stderr, code });
            } else {
                console.error(`[FFmpeg] 退出码 ${code} [${cmd}]:\n${stderr}`);
                reject(new Error(formatMediaError(stderr, {
                    action: cmd === 'ffprobe' ? '读取媒体信息' : '媒体处理',
                    code,
                })));
            }
        });
        proc.on('error', (err) => {
            console.error(`[FFmpeg] ${cmd} 启动失败 (${resolvedCmd}):`, err);
            reject(new Error(formatProcessStartError(cmd, resolvedCmd, err)));
        });
    });
}

// 递归搜索文件（限深度，跳过隐藏目录）
function _findFileRecursive(dir, fileName, maxDepth) {
    if (maxDepth <= 0) return null;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile() && entry.name === fileName) {
                return path.join(dir, entry.name);
            }
        }
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                const found = _findFileRecursive(path.join(dir, entry.name), fileName, maxDepth - 1);
                if (found) return found;
            }
        }
    } catch (e) { }
    return null;
}

// 通用媒体路径修复：搜索常见目录
function _resolveMediaPath(filePath) {
    const bareFileName = path.basename(filePath);
    const searchDirs = [
        path.join(os.homedir(), 'Downloads'),
        path.join(os.homedir(), 'Desktop'),
        path.join(os.homedir(), 'Documents'),
    ];
    for (const searchDir of searchDirs) {
        if (!fs.existsSync(searchDir)) continue;
        const found = _findFileRecursive(searchDir, bareFileName, 4);
        if (found) {
            console.log(`[PathResolve] 自动修复: "${filePath}" → "${found}"`);
            return found;
        }
    }
    return null;
}


/** 获取音频/视频时长（秒） */
async function getDuration(filePath) {
    if (!filePath || typeof filePath !== 'string') return null;
    let cleanPath = filePath;
    if (cleanPath.startsWith('local-media://')) {
        cleanPath = cleanPath.replace(/^local-media:\/\//i, '');
    }
    // On Windows, if cleanPath starts with "/", e.g. "/C:/Users/...", remove the leading "/"
    if (process.platform === 'win32' && cleanPath.startsWith('/') && cleanPath.includes(':')) {
        cleanPath = cleanPath.substring(1);
    }
    filePath = cleanPath;

    // 路径自动修复：如果不是绝对路径或文件不存在，尝试搜索
    if (filePath && (!path.isAbsolute(filePath) || !fs.existsSync(filePath))) {
        const bareFileName = path.basename(filePath);
        const searchDirs = [
            path.join(os.homedir(), 'Downloads'),
            path.join(os.homedir(), 'Desktop'),
            path.join(os.homedir(), 'Documents'),
        ];
        for (const searchDir of searchDirs) {
            if (!fs.existsSync(searchDir)) continue;
            const found = _findFileRecursive(searchDir, bareFileName, 4);
            if (found) {
                console.log(`[getDuration] 自动修复路径: "${filePath}" → "${found}"`);
                filePath = found;
                break;
            }
        }
    }
    // 方法1: 通过 format=duration 获取
    try {
        const { stdout, stderr } = await runCommand('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { timeout: PROBE_TIMEOUT });
        const dur = parseFloat(stdout.trim());
        if (!isNaN(dur) && dur > 0) return dur;
        console.warn(`[getDuration] format=duration 返回无效值: stdout="${stdout.trim()}", stderr="${(stderr || '').trim()}", file=${filePath}`);
    } catch (e) {
        console.warn(`[getDuration] 方法1失败 (format=duration): ${e.message}, file=${filePath}`);
    }

    // 方法2: 通过 stream=duration 获取（某些容器格式 format 级别没有 duration）
    try {
        const { stdout, stderr } = await runCommand('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { timeout: PROBE_TIMEOUT });
        const dur = parseFloat(stdout.trim());
        if (!isNaN(dur) && dur > 0) {
            console.log(`[getDuration] 方法2成功 (stream=duration): ${dur}s, file=${filePath}`);
            return dur;
        }
    } catch (e) {
        console.warn(`[getDuration] 方法2失败 (stream=duration): ${e.message}`);
    }

    // 方法3: 用 ffprobe -count_packets 计算时长（最准确但最慢）
    try {
        const { stdout } = await runCommand('ffprobe', [
            '-v', 'error',
            '-count_packets',
            '-show_entries', 'stream=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { timeout: PROBE_TIMEOUT * 2 });
        // 可能返回多行（多流），取第一个有效值
        for (const line of stdout.split('\n')) {
            const dur = parseFloat(line.trim());
            if (!isNaN(dur) && dur > 0) {
                console.log(`[getDuration] 方法3成功 (count_packets): ${dur}s, file=${filePath}`);
                return dur;
            }
        }
    } catch (e) {
        console.warn(`[getDuration] 方法3失败 (count_packets): ${e.message}`);
    }

    console.error(`[getDuration] 所有方法均失败, file=${filePath}`);
    return null;
}

/** 获取媒体时长及可直接展示给用户的失败原因。 */
async function getDurationDetailed(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return { ok: false, duration: null, code: 'EMPTY_PATH', reason: '文件路径为空' };
    }
    let cleanPath = filePath.replace(/^local-media:\/\//i, '');
    if (process.platform === 'win32' && cleanPath.startsWith('/') && /^[\/][A-Za-z]:/.test(cleanPath)) {
        cleanPath = cleanPath.slice(1);
    }
    if (!fs.existsSync(cleanPath)) {
        return { ok: false, duration: null, code: 'NOT_FOUND', reason: '文件不存在或路径已经失效', path: cleanPath };
    }
    let stat;
    try { stat = fs.statSync(cleanPath); } catch (error) {
        return { ok: false, duration: null, code: 'ACCESS_FAILED', reason: `无法读取文件：${error.message}`, path: cleanPath };
    }
    if (!stat.isFile()) {
        return { ok: false, duration: null, code: 'NOT_FILE', reason: '路径不是媒体文件', path: cleanPath };
    }
    if (stat.size <= 0) {
        return { ok: false, duration: null, code: 'EMPTY_FILE', reason: '文件大小为 0，可能尚未写入完成', path: cleanPath, size: stat.size };
    }

    const duration = await getDuration(cleanPath);
    if (Number.isFinite(duration) && duration > 0) {
        return { ok: true, duration, code: 'OK', reason: '', path: cleanPath, size: stat.size };
    }

    let diagnostic = '';
    try {
        const { stdout, stderr } = await runCommand('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=format_name,duration',
            '-of', 'json',
            cleanPath,
        ], { timeout: PROBE_TIMEOUT });
        diagnostic = `${stderr || ''} ${stdout || ''}`.trim();
    } catch (error) {
        diagnostic = String(error?.message || error || '');
    }
    const lower = diagnostic.toLowerCase();
    let code = 'NO_DURATION';
    let reason = '文件中没有可用的时长信息，可能是异常封装或时间戳缺失';
    if (/moov atom not found|invalid data found|end of file|error reading header|could not find codec parameters/.test(lower)) {
        code = 'DAMAGED_OR_INCOMPLETE';
        reason = '文件可能未写入完成、已损坏，或 MP4 索引信息缺失';
    } else if (/permission denied|operation not permitted|access is denied|being used by another process/.test(lower)) {
        code = 'PERMISSION_DENIED';
        reason = '文件无法访问，可能被其他程序占用或没有读取权限';
    } else if (/timed?\s*out|timeout|signal.*term|退出码 null/.test(lower)) {
        code = 'PROBE_TIMEOUT';
        reason = '读取媒体信息超时，文件可能位于响应缓慢的外接盘、网络盘或同步目录';
    } else if (/ffprobe.*(enoent|not found)|spawn.*enoent/.test(lower)) {
        code = 'FFPROBE_UNAVAILABLE';
        reason = 'FFprobe 无法启动，请检查软件内置的媒体组件';
    }
    return { ok: false, duration: null, code, reason, path: cleanPath, size: stat.size };
}

/** 获取帧率 */
async function getFrameRate(filePath) {
    try {
        const { stdout } = await runCommand('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=r_frame_rate',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { timeout: PROBE_TIMEOUT });
        const fpsStr = stdout.trim();
        if (fpsStr.includes('/')) {
            const [num, den] = fpsStr.split('/');
            return parseFloat(num) / parseFloat(den);
        }
        return parseFloat(fpsStr) || 30.0;
    } catch {
        return 30.0;
    }
}

/** 获取分辨率 */
async function getResolution(filePath) {
    try {
        const { stdout } = await runCommand('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'csv=p=0',
            filePath
        ], { timeout: PROBE_TIMEOUT });
        // ffprobe csv 输出 "1920,1080" → 转为 "1920x1080"
        return stdout.trim().replace(',', 'x');
    } catch {
        return '';
    }
}

/** 获取波形峰值数据 */
async function getWaveform(filePath, numPeaks = 300) {
    const { stdout } = await runCommand('ffmpeg', [
        '-hide_banner', '-i', filePath,
        '-ac', '1', '-ar', '8000',
        '-f', 'f32le', '-'
    ], { timeout: 120000 });

    // stdout 是 Buffer 形式的原始 float32 数据
    const raw = Buffer.from(stdout, 'binary');
    const numSamples = Math.floor(raw.length / 4);
    if (numSamples === 0) return { peaks: [], duration: 0, numPeaks: 0 };

    const samples = [];
    for (let i = 0; i < numSamples; i++) {
        samples.push(raw.readFloatLE(i * 4));
    }

    const blockSize = Math.max(1, Math.floor(numSamples / numPeaks));
    const peaks = [];
    for (let i = 0; i < Math.min(numPeaks, Math.floor(numSamples / blockSize)); i++) {
        const start = i * blockSize;
        const end = Math.min(start + blockSize, numSamples);
        let maxVal = 0;
        for (let j = start; j < end; j++) {
            maxVal = Math.max(maxVal, Math.abs(samples[j]));
        }
        peaks.push(maxVal);
    }

    const maxPeak = Math.max(...peaks) || 1;
    const normalized = peaks.map(p => Math.round((p / maxPeak) * 10000) / 10000);
    const duration = await getDuration(filePath) || (numSamples / 8000);

    return { peaks: normalized, duration: Math.round(duration * 1000) / 1000, numPeaks: normalized.length };
}

/**
 * 获取波形 — 使用 pipe（二进制安全）
 */
function getWaveformBinary(filePath, numPeaks = 300) {
    return new Promise(async (resolve, reject) => {
        const proc = spawn(resolveCommand('ffmpeg'), [
            '-hide_banner', '-i', filePath,
            '-ac', '1', '-ar', '8000',
            '-f', 'f32le', 'pipe:1'
        ], { timeout: 120000 });

        const chunks = [];
        proc.stdout.on('data', chunk => chunks.push(chunk));
        proc.stderr.on('data', () => { }); // 忽略 stderr
        proc.on('close', async (code) => {
            const raw = Buffer.concat(chunks);
            const numSamples = Math.floor(raw.length / 4);
            if (numSamples === 0) {
                const dur = await getDuration(filePath) || 0;
                return resolve({ peaks: [], duration: dur, numPeaks: 0 });
            }

            const blockSize = Math.max(1, Math.floor(numSamples / numPeaks));
            const peaks = [];
            for (let i = 0; i < Math.min(numPeaks, Math.floor(numSamples / blockSize)); i++) {
                const start = i * blockSize;
                const end = Math.min(start + blockSize, numSamples);
                let maxVal = 0;
                for (let j = start; j < end; j++) {
                    const val = Math.abs(raw.readFloatLE(j * 4));
                    if (val > maxVal) maxVal = val;
                }
                peaks.push(maxVal);
            }

            const maxPeak = Math.max(...peaks) || 1;
            const normalized = peaks.map(p => Math.round((p / maxPeak) * 10000) / 10000);
            const duration = await getDuration(filePath) || (numSamples / 8000);

            resolve({
                peaks: normalized,
                duration: Math.round(duration * 1000) / 1000,
                numPeaks: normalized.length
            });
        });
        proc.on('error', reject);
    });
}

/** 场景检测 */
async function sceneDetect(filePath, threshold = 0.05, minInterval = 0.5) {
    const duration = await getDuration(filePath);
    if (!duration) throw new Error(`无法获取视频时长，请检查文件是否有效: ${path.basename(filePath)}`);

    const fps = await getFrameRate(filePath);
    const resolution = await getResolution(filePath);

    // 使用 select 滤镜检测场景变化
    // threshold 越小越灵敏（0.03 = 非常灵敏, 0.1 = 中等, 0.3 = 只检测硬切）
    const { stderr } = await runCommand('ffmpeg', [
        '-hide_banner', '-i', filePath,
        '-vf', `select='gt(scene,${threshold})',showinfo`,
        '-f', 'null', '-'
    ], { timeout: DEFAULT_TIMEOUT, allowNonZero: true });

    const scenePoints = [];
    let lastTime = -minInterval;
    const ptsRegex = /pts_time:\s*([0-9.]+)/;

    for (const line of stderr.split('\n')) {
        if (line.includes('showinfo') && line.includes('pts_time')) {
            const m = line.match(ptsRegex);
            if (m) {
                const ptsTime = parseFloat(m[1]);
                if (ptsTime < 0.2) continue;  // 跳过片头极早帧
                if (ptsTime - lastTime < minInterval) continue;  // 去重
                scenePoints.push({
                    time: Math.round(ptsTime * 1000) / 1000,
                    time_str: formatSceneTime(ptsTime)
                });
                lastTime = ptsTime;
            }
        }
    }

    // 构建片段
    const boundaries = [0, ...scenePoints.map(p => p.time), duration];
    const segments = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
        const segStart = boundaries[i];
        const segEnd = boundaries[i + 1];
        const segDur = segEnd - segStart;
        segments.push({
            index: i + 1,
            start: Math.round(segStart * 1000) / 1000,
            end: Math.round(segEnd * 1000) / 1000,
            start_str: formatSceneTime(segStart),
            end_str: formatSceneTime(segEnd),
            duration: Math.round(segDur * 1000) / 1000,
            duration_str: formatSceneTime(segDur)
        });
    }

    return {
        message: `检测到 ${scenePoints.length} 个场景切换点，共 ${segments.length} 个片段`,
        file: filePath,
        duration: Math.round(duration * 1000) / 1000,
        fps: Math.round(fps * 100) / 100,
        resolution,
        threshold,
        scene_points: scenePoints,
        scenes: segments,
        segments
    };
}

/**
 * 场景检测 + 智能关键帧提取（合并版，支持预览/导出两步流程）
 * 
 * preview=true 时：生成 320px 宽的低质量缩略图用于预览确认
 * preview=false 时：生成原始尺寸高质量帧到正式输出目录
 */
function sceneBuildOutputDir(filePath, outputDir, suffix, folderMode = 'per_video', batchName = '') {
    const baseName = path.parse(filePath).name;
    const outDir = outputDir || path.dirname(filePath);
    if (folderMode === 'batch') {
        const safeBatchName = String(batchName || 'scene_batch')
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .replace(/\s+/g, '_')
            .slice(0, 120) || 'scene_batch';
        return path.join(outDir, safeBatchName);
    }
    return path.join(outDir, `${baseName}_${suffix}`);
}

async function sceneDetectFrames(filePath, options = {}) {
    const {
        threshold = 0.3,
        minInterval = 0.5,
        framesPerScene = 0,
        format = 'jpg',
        quality = 2,
        outputDir = '',
        boundaryOffset = 0.04,
        cleanOld = false,
        folderMode = 'per_video',
        batchName = '',
    } = options;

    // 1. 场景检测
    const detectResult = await sceneDetect(filePath, threshold, minInterval);
    const { duration, fps, resolution, scene_points, segments } = detectResult;

    // 2. 构建输出目录
    const baseName = path.parse(filePath).name;
    const framesDir = sceneBuildOutputDir(filePath, outputDir, 'keyframes', folderMode, batchName);

    // 清除旧文件
    if (cleanOld && fs.existsSync(framesDir)) {
        const oldFiles = fs.readdirSync(framesDir);
        for (const f of oldFiles) {
            try { fs.unlinkSync(path.join(framesDir, f)); } catch (_) {}
        }
    }
    fs.mkdirSync(framesDir, { recursive: true });

    // 3. 计算所有需要截取的时间点
    const frameTimestamps = _buildFrameTimestamps(segments, duration, framesPerScene, boundaryOffset);

    // 4. 批量截帧
    const results = [];
    let success = 0;
    let failed = 0;

    for (let i = 0; i < frameTimestamps.length; i++) {
        const frame = frameTimestamps[i];
        const idx = String(i + 1).padStart(3, '0');
        const timeTag = formatSceneTime(frame.time).replace(/:/g, '.');
        const typeTag = frame.type;
        const filename = `${baseName}_${idx}_${typeTag}_${timeTag}.${format}`;
        const outputPath = path.join(framesDir, filename);

        try {
            const args = [
                '-y',
                '-ss', frame.time.toFixed(3),
                '-i', filePath,
                '-vframes', '1',
            ];
            if (format === 'jpg') args.push('-q:v', String(quality));
            args.push(outputPath);

            await runCommand('ffmpeg', args, { timeout: 15000 });

            if (fs.existsSync(outputPath)) {
                results.push({
                    status: 'ok',
                    index: i + 1,
                    type: frame.type,
                    label: frame.label,
                    scene: frame.scene,
                    time: frame.time,
                    time_str: formatSceneTime(frame.time),
                    filename,
                    output: outputPath,
                });
                success++;
            } else {
                throw new Error('输出文件未生成');
            }
        } catch (e) {
            results.push({
                status: 'error',
                index: i + 1,
                type: frame.type,
                label: frame.label,
                scene: frame.scene,
                time: frame.time,
                time_str: formatSceneTime(frame.time),
                error: e.message,
            });
            failed++;
        }
    }

    return {
        message: `检测到 ${scene_points.length} 个场景切换点，导出 ${success} 帧${failed > 0 ? `（${failed} 帧失败）` : ''}`,
        file: filePath,
        duration: Math.round(duration * 1000) / 1000,
        fps: Math.round(fps * 100) / 100,
        resolution,
        threshold,
        total_scenes: segments.length,
        scene_points,
        segments,
        frames: results,
        success,
        failed,
        output_dir: framesDir,
    };
}

/**
 * 根据确认的帧列表，导出高清关键帧
 * @param {string} filePath - 视频文件路径
 * @param {Array} frameList - [{time, type, label, scene}] 确认的帧列表
 * @param {object} options - {format, quality, outputDir}
 */
async function sceneExportFrames(filePath, frameList, options = {}) {
    const {
        format = 'jpg',
        quality = 2,
        outputDir = '',
        cleanOld = false,
        folderMode = 'per_video',
        batchName = '',
    } = options;

    const baseName = path.parse(filePath).name;
    const framesDir = sceneBuildOutputDir(filePath, outputDir, 'keyframes', folderMode, batchName);
    fs.mkdirSync(framesDir, { recursive: true });

    // 清除旧文件
    if (cleanOld) {
        try {
            const oldFiles = fs.readdirSync(framesDir);
            for (const f of oldFiles) {
                try { fs.unlinkSync(path.join(framesDir, f)); } catch {}
            }
            console.log(`[SceneExport] 已清除 ${oldFiles.length} 个旧文件`);
        } catch {}
    }

    const results = [];
    let success = 0;
    let failed = 0;

    for (let i = 0; i < frameList.length; i++) {
        const frame = frameList[i];
        const idx = String(i + 1).padStart(3, '0');
        const timeTag = formatSceneTime(frame.time).replace(/:/g, '.');
        const typeTag = frame.type || 'frame';
        const filename = `${baseName}_${idx}_${typeTag}_${timeTag}.${format}`;
        const outputPath = path.join(framesDir, filename);

        try {
            const args = [
                '-y',
                '-ss', parseFloat(frame.time).toFixed(3),
                '-i', filePath,
                '-vframes', '1',
            ];
            if (format === 'jpg') args.push('-q:v', String(quality));
            args.push(outputPath);

            await runCommand('ffmpeg', args, { timeout: 15000 });

            if (fs.existsSync(outputPath)) {
                results.push({
                    status: 'ok',
                    index: i + 1,
                    type: frame.type,
                    label: frame.label,
                    scene: frame.scene,
                    time: frame.time,
                    time_str: formatSceneTime(frame.time),
                    filename,
                    output: outputPath,
                });
                success++;
            } else {
                throw new Error('输出文件未生成');
            }
        } catch (e) {
            results.push({
                status: 'error',
                index: i + 1,
                time: frame.time,
                error: e.message,
            });
            failed++;
        }
    }

    return {
        message: `导出完成: ${success} 帧${failed > 0 ? `（${failed} 帧失败）` : ''}`,
        file: filePath,
        frames: results,
        success,
        failed,
        output_dir: framesDir,
    };
}

/** 内部工具：计算关键帧时间点列表 */
function _buildFrameTimestamps(segments, duration, framesPerScene, boundaryOffset) {
    const frameTimestamps = [];
    let frameIndex = 0;

    // 首帧
    frameTimestamps.push({ time: 0, type: 'first', label: '首帧', scene: 0, index: frameIndex++ });

    // 场景边界帧 + 场景内均匀采样
    for (let sIdx = 0; sIdx < segments.length; sIdx++) {
        const seg = segments[sIdx];

        if (framesPerScene > 0) {
            const segDur = seg.end - seg.start;
            for (let f = 0; f < framesPerScene; f++) {
                let t;
                if (framesPerScene === 1) {
                    t = seg.start + segDur / 2;
                } else {
                    t = seg.start + (segDur * (f + 1)) / (framesPerScene + 1);
                }
                t = Math.max(seg.start + 0.01, Math.min(seg.end - 0.01, t));
                frameTimestamps.push({
                    time: Math.round(t * 1000) / 1000, type: 'sample',
                    label: `场景${seg.index}-采样${f + 1}`, scene: seg.index, index: frameIndex++,
                });
            }
        }

        if (sIdx < segments.length - 1) {
            const switchTime = seg.end;
            const endFrameTime = Math.max(0.01, switchTime - boundaryOffset);
            frameTimestamps.push({
                time: Math.round(endFrameTime * 1000) / 1000, type: 'scene_end',
                label: `场景${seg.index}-结束`, scene: seg.index, sceneSwitch: sIdx + 1, index: frameIndex++,
            });
            const startFrameTime = Math.min(duration - 0.01, switchTime + boundaryOffset);
            frameTimestamps.push({
                time: Math.round(startFrameTime * 1000) / 1000, type: 'scene_start',
                label: `场景${segments[sIdx + 1].index}-开始`, scene: segments[sIdx + 1].index, sceneSwitch: sIdx + 1, index: frameIndex++,
            });
        }
    }

    // 尾帧
    const lastFrameTime = Math.max(0, duration - 0.05);
    frameTimestamps.push({
        time: Math.round(lastFrameTime * 1000) / 1000, type: 'last', label: '尾帧',
        scene: segments.length > 0 ? segments[segments.length - 1].index : 0, index: frameIndex++,
    });

    // 去重
    frameTimestamps.sort((a, b) => a.time - b.time);
    const deduped = [];
    for (const frame of frameTimestamps) {
        if (deduped.length === 0 || frame.time - deduped[deduped.length - 1].time >= 0.02) {
            deduped.push(frame);
        }
    }
    return deduped;
}

function clampWatermarkOpacity(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

function sceneWatermarkPosition(position, image = false, offsetX = 24, offsetY = 24) {
    const width = image ? 'w' : 'tw';
    const height = image ? 'h' : 'th';
    const mainWidth = image ? 'W' : 'w';
    const mainHeight = image ? 'H' : 'h';
    const xOffset = Math.max(0, Number(offsetX) || 0);
    const yOffset = Math.max(0, Number(offsetY) || 0);
    switch (position) {
        case 'top-left': return [String(xOffset), String(yOffset)];
        case 'top-center': return [`(${mainWidth}-${width})/2`, String(yOffset)];
        case 'bottom-left': return [String(xOffset), `${mainHeight}-${height}-${yOffset}`];
        case 'bottom-right': return [`${mainWidth}-${width}-${xOffset}`, `${mainHeight}-${height}-${yOffset}`];
        case 'bottom-center': return [`(${mainWidth}-${width})/2`, `${mainHeight}-${height}-${yOffset}`];
        case 'center': return [`(${mainWidth}-${width})/2`, `(${mainHeight}-${height})/2`];
        default: return [`${mainWidth}-${width}-${xOffset}`, String(yOffset)];
    }
}

function escapeDrawtextValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\\\'").replace(/:/g, '\\:').replace(/%/g, '\\%');
}

/** 场景拆分 */
async function sceneSplit(filePath, segments, outputDir, options = {}) {
    const baseName = path.parse(filePath).name;
    const ext = path.extname(filePath).toLowerCase();
    const sceneOutputDir = sceneBuildOutputDir(filePath, outputDir, 'scenes', options.folderMode, options.batchName);
    fs.mkdirSync(sceneOutputDir, { recursive: true });

    const exported = [];
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const start = parseFloat(seg.start || 0);
        const end = parseFloat(seg.end || 0);
        if (end - start <= 0) continue;

        const idx = seg.index || (i + 1);
        const outputFilename = `${baseName}_scene${String(idx).padStart(3, '0')}${ext}`;
        const outputPath = path.join(sceneOutputDir, outputFilename);

        const watermarks = Array.isArray(options.watermarks)
            ? options.watermarks
            : (options.watermark ? [options.watermark] : []);
        const args = [
            '-y', '-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', filePath,
        ];

        const filters = [];
        let lastVideo = '0:v';
        let inputIndex = 1;
        for (let wIdx = 0; wIdx < watermarks.length; wIdx++) {
            const watermark = watermarks[wIdx];
            const outputLabel = `wmv${wIdx}`;
            if (watermark?.type === 'image') {
                if (!watermark.image_path || !fs.existsSync(watermark.image_path)) throw new Error('图片水印文件不存在');
                const imageWidth = Math.max(10, Math.min(2000, parseInt(watermark.image_width) || 180));
                const opacity = clampWatermarkOpacity(watermark.opacity, 1);
                const [x, y] = sceneWatermarkPosition(watermark.position, true, watermark.offset_x, watermark.offset_y);
                const imageLabel = `wmi${wIdx}`;
                args.push('-loop', '1', '-i', watermark.image_path);
                filters.push(`[${inputIndex}:v]scale=${imageWidth}:-1,format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}[${imageLabel}]`);
                filters.push(`[${lastVideo}][${imageLabel}]overlay=${x}:${y}:format=auto[${outputLabel}]`);
                inputIndex++;
            } else if (watermark?.type === 'text') {
                const [x, y] = sceneWatermarkPosition(watermark.position, false, watermark.offset_x, watermark.offset_y);
                const fontSize = Math.max(8, Math.min(300, parseInt(watermark.font_size) || 32));
                const textOpacity = clampWatermarkOpacity(watermark.opacity, 0.8);
                const bgOpacity = clampWatermarkOpacity(watermark.background_opacity, 0.35);
                const color = String(watermark.color || '#ffffff').replace('#', '');
                const backgroundColor = String(watermark.background_color || '#000000').replace('#', '');
                let filter = `[${lastVideo}]drawtext=text='${escapeDrawtextValue(watermark.text || 'AI Generated')}':font='${escapeDrawtextValue(watermark.font || 'Arial')}':fontsize=${fontSize}:fontcolor=0x${color}@${textOpacity.toFixed(2)}:x=${x}:y=${y}`;
                if (watermark.background !== false) {
                    const padding = Math.max(0, Math.min(100, Number(watermark.background_padding ?? 12)));
                    filter += `:box=1:boxborderw=${padding}:boxcolor=0x${backgroundColor}@${bgOpacity.toFixed(2)}`;
                }
                if (watermark.stroke !== false) filter += `:borderw=${Math.max(0, Math.min(20, Number(watermark.stroke_width) || 2))}:bordercolor=0x${String(watermark.stroke_color || '#000000').replace('#', '')}@${textOpacity.toFixed(2)}`;
                if (watermark.shadow) filter += ':shadowx=2:shadowy=2:shadowcolor=black@0.5';
                filters.push(`${filter}[${outputLabel}]`);
            } else {
                continue;
            }
            lastVideo = outputLabel;
        }
        if (filters.length) {
            args.push('-filter_complex', filters.join(';'), '-map', `[${lastVideo}]`, '-map', '0:a?', '-shortest');
        }

        args.push(
            '-c:v', 'libx264', '-crf', '15', '-preset', 'medium',
            '-c:a', 'aac', '-b:a', '192k',
            '-avoid_negative_ts', 'make_zero',
            outputPath
        );
        await runCommand('ffmpeg', args, { timeout: Math.max(DEFAULT_TIMEOUT, 3600000) });

        exported.push({
            path: outputPath,
            filename: outputFilename,
            index: idx,
            start, end,
            duration: Math.round((end - start) * 1000) / 1000
        });
    }

    return {
        message: `成功导出 ${exported.length} 个片段到 ${sceneOutputDir}`,
        output_dir: sceneOutputDir,
        files: exported
    };
}

/** 精确裁切 */
async function mediaTrim(filePath, startTime, endTime, outputDir, precise = true) {
    const baseName = path.parse(filePath).name;
    const ext = path.extname(filePath).toLowerCase();
    const outDir = outputDir || path.dirname(filePath);
    const duration = endTime - startTime;
    const startStr = formatSceneTime(startTime);
    const endStr = formatSceneTime(endTime);
    const outputFilename = `${baseName}_trimmed_${startStr.replace(/:/g, '.')}-${endStr.replace(/:/g, '.')}${ext}`;
    const outputPath = path.join(outDir, outputFilename);

    let args;
    if (precise) {
        args = [
            '-y', '-i', filePath,
            '-ss', startTime.toFixed(3), '-to', endTime.toFixed(3),
            '-c:v', 'libx264', '-crf', '15', '-preset', 'medium',
            '-c:a', 'aac', '-b:a', '192k',
            '-avoid_negative_ts', 'make_zero',
            outputPath
        ];
    } else {
        args = [
            '-y', '-ss', startTime.toFixed(3),
            '-i', filePath,
            '-t', duration.toFixed(3),
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            outputPath
        ];
    }

    await runCommand('ffmpeg', args);
    const outDuration = await getDuration(outputPath);

    return {
        message: `裁切完成: ${outputFilename}`,
        output_path: outputPath,
        output_filename: outputFilename,
        duration: outDuration ? Math.round(outDuration * 1000) / 1000 : Math.round(duration * 1000) / 1000,
        mode: precise ? '精确' : '快速'
    };
}

/** 批量提取视频截图（支持首帧/尾帧模式） */
async function batchThumbnail(videoFiles, outputDir, format = 'jpg', quality = 2, mode = 'first') {
    fs.mkdirSync(outputDir, { recursive: true });
    const results = [];

    for (let i = 0; i < videoFiles.length; i++) {
        const filePath = videoFiles[i];
        const baseName = path.parse(filePath).name;
        const outFile = path.join(outputDir, `${baseName}.${format}`);

        try {
            let args;
            if (mode === 'last') {
                // 尾帧模式：-sseof -3 定位到最后3秒，-update 1 持续覆盖输出
                // 最终文件就是绝对最后一帧
                args = ['-y', '-sseof', '-3', '-i', filePath, '-update', '1'];
            } else {
                // 首帧模式（默认）
                args = ['-y', '-i', filePath, '-vframes', '1'];
            }
            if (format === 'jpg') {
                args.push('-q:v', String(quality));
            }
            args.push(outFile);
            await runCommand('ffmpeg', args, { timeout: 30000 });
            results.push({ path: outFile, source: filePath, success: true });
        } catch (e) {
            results.push({ source: filePath, success: false, error: e.message });
        }
    }
    return results;
}

/** 构建黑屏 MP4 命令参数 */
function buildBlackMp4Args(filePath, outputPath, start, duration, size = '1280x720', fps = 24) {
    const args = ['-y'];

    // 黑屏视频源
    if (duration != null) {
        args.push('-f', 'lavfi', '-i', `color=c=black:s=${size}:r=${fps}:d=${duration}`);
    } else {
        args.push('-f', 'lavfi', '-i', `color=c=black:s=${size}:r=${fps}`);
    }

    // 音频输入
    if (start > 0) {
        args.push('-ss', start.toFixed(3));
    }
    args.push('-i', filePath);

    // 混合滤镜：确保双声道
    args.push(
        '-filter_complex',
        `[1:a]aformat=channel_layouts=stereo[stereo];[0:v][stereo]concat=n=1:v=1:a=1[outv][outa]`,
        '-map', '[outv]', '-map', '[outa]'
    );

    // 编码设置
    args.push(
        '-c:v', 'libx264', '-crf', '15', '-preset', 'medium',
        '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
        '-shortest',
        outputPath
    );

    return args;
}

/** 简化版黑屏 MP4 生成 */
async function generateBlackMp4(filePath, outputPath, start = 0, duration = null) {
    // 获取音频时长（失败时退化为 shortest 模式，不阻断导出）
    let resolvedDuration = duration;
    if (resolvedDuration == null) {
        resolvedDuration = await getDuration(filePath);
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const args = buildBlackMp4Args(filePath, outputPath, start, resolvedDuration, '1920x1080', 30);
    await runCommand('ffmpeg', args);

    if (!fs.existsSync(outputPath)) {
        throw new Error(`黑屏 MP4 未生成: ${outputPath}`);
    }
}

function isImageMedia(filePath) {
    const ext = path.extname(filePath || '').toLowerCase();
    return ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp';
}

function escapeAssPathForFilter(assPath) {
    // Normalize all backslashes to forward slashes, then escape
    // remaining backslashes, colons and single-quotes for FFmpeg's libass subtitle filter.
    const normalized = String(assPath || '').split('\\').join('/');
    return normalized
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/'/g, "'\\''")
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/ /g, '\\ ');
}

let _cachedFlatFontsDir = null;

function resolveLibassFontsDir() {
    if (_cachedFlatFontsDir && fs.existsSync(_cachedFlatFontsDir)) {
        return _cachedFlatFontsDir;
    }

    const candidates = [];
    try {
        const { app } = require('electron');
        if (app && app.isPackaged && process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, 'assets', 'fonts'));
        }
    } catch { }
    candidates.push(path.join(__dirname, '..', '..', 'assets', 'fonts'));
    
    let sourceFontsDir = '';
    for (const dir of candidates) {
        try {
            if (dir && fs.existsSync(dir)) {
                sourceFontsDir = dir;
                break;
            }
        } catch { }
    }

    if (!sourceFontsDir) return '';

    // Create a temporary flat directory to copy all font files so libass on Windows can find them
    try {
        const flatDir = path.join(os.tmpdir(), `videokit_flat_fonts_${crypto.createHash('md5').update(sourceFontsDir).digest('hex')}`);
        
        if (!fs.existsSync(flatDir)) {
            fs.mkdirSync(flatDir, { recursive: true });
        }

        // Recursively copy all ttf/otf files to flatDir
        function copyFontsRecursively(srcDir) {
            const entries = fs.readdirSync(srcDir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(srcDir, entry.name);
                if (entry.isDirectory()) {
                    copyFontsRecursively(fullPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (ext === '.ttf' || ext === '.otf') {
                        const destPath = path.join(flatDir, entry.name);
                        if (!fs.existsSync(destPath)) {
                            try {
                                fs.copyFileSync(fullPath, destPath);
                            } catch (e) {
                                console.error(`[resolveLibassFontsDir] Copy font failed: ${fullPath} -> ${destPath}`, e);
                            }
                        }
                    }
                }
            }
        }

        console.log(`[resolveLibassFontsDir] Generating flat fonts directory from ${sourceFontsDir} to ${flatDir}...`);
        copyFontsRecursively(sourceFontsDir);
        _cachedFlatFontsDir = flatDir;
        return flatDir;
    } catch (e) {
        console.error('[resolveLibassFontsDir] Flattening fonts directory failed, falling back to source path', e);
        return sourceFontsDir;
    }
}

function parseResolutionText(resolutionText) {
    const m = String(resolutionText || '').trim().match(/^(\d+)\s*x\s*(\d+)$/i);
    if (!m) return null;
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { width: w, height: h };
}

function alignAssPlayRes(assContent, width, height) {
    if (!assContent || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return assContent;
    }
    const text = String(assContent);
    const hasX = /(^|\n)\s*PlayResX\s*:/i.test(text);
    const hasY = /(^|\n)\s*PlayResY\s*:/i.test(text);
    const withX = text.replace(/(^|\n)\s*PlayResX\s*:[^\n]*/i, `$1PlayResX: ${Math.round(width)}`);
    const withXY = withX.replace(/(^|\n)\s*PlayResY\s*:[^\n]*/i, `$1PlayResY: ${Math.round(height)}`);
    if (hasX && hasY) return withXY;
    return withXY;
}

function buildPortraitCoverFilter(width = 1080, height = 1920) {
    const w = Math.max(2, parseInt(width, 10) || 1080);
    const h = Math.max(2, parseInt(height, 10) || 1920);
    // 先等比放大到覆盖目标，再中心裁切，最后校正像素宽高比
    return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
}

const DEFAULT_LOOP_FADE_DUR = 1.0;
const MAX_LOOP_FADE_SEGMENTS = 32;
const DEFAULT_VOICE_VOLUME = 1.0;
const DEFAULT_BG_VOLUME = 0.1;

function sanitizeLoopFadeDuration(value) {
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOOP_FADE_DUR;
    return Math.max(0.1, Math.min(3, n));
}

function calcLoopFadeSegmentCount(voiceDuration, bgDuration, fadeDuration) {
    if (!Number.isFinite(voiceDuration) || voiceDuration <= 0) return 0;
    if (!Number.isFinite(bgDuration) || bgDuration <= 0) return 0;
    if (voiceDuration <= bgDuration) return 1;
    const step = bgDuration - fadeDuration;
    if (step <= 0.05) return 0;
    return Math.ceil((voiceDuration - bgDuration) / step) + 1;
}

function sanitizeVolumeGain(value, fallback) {
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.max(0, Math.min(2, n));
}

async function getPrimaryStreamDuration(filePath, streamSelector) {
    try {
        const { stdout } = await runCommand('ffprobe', [
            '-v', 'error',
            '-select_streams', streamSelector,
            '-show_entries', 'stream=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { timeout: PROBE_TIMEOUT });

        for (const line of String(stdout || '').split('\n')) {
            const v = parseFloat(line.trim());
            if (Number.isFinite(v) && v > 0) return v;
        }
    } catch (e) {
        console.warn(`[getPrimaryStreamDuration] ${streamSelector} 失败: ${e.message}`);
    }
    return null;
}

async function hasAudioStream(filePath) {
    try {
        const { stdout } = await runCommand('ffprobe', [
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=index',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { timeout: PROBE_TIMEOUT });
        return String(stdout || '').trim().length > 0;
    } catch (e) {
        return false;
    }
}

/**
 * Reels 合成:
 * - 背景素材自动循环（视频）或静态保持（图片）
 * - 使用人声音频作为主时长
 * - 烧录 ASS 字幕
 */
async function composeReel({
    backgroundPath,
    voicePath,
    assContent,
    outputPath,
    crf = 18,
    useGPU = false,
    loopFade = true,
    loopFadeDur = DEFAULT_LOOP_FADE_DUR,
    voiceVolume = DEFAULT_VOICE_VOLUME,
    bgVolume = DEFAULT_BG_VOLUME,
    bgmPath = '',
    bgmVolume = 0,
    bgmStart = 0,
    forcePortrait = true,
    targetWidth = 1080,
    targetHeight = 1920,
}) {
    backgroundPath = expandHomePath(backgroundPath);
    voicePath = expandHomePath(voicePath);
    outputPath = expandHomePath(outputPath);

    // 路径自动修复
    if (backgroundPath && (!path.isAbsolute(backgroundPath) || !fs.existsSync(backgroundPath))) {
        const found = _resolveMediaPath(backgroundPath);
        if (found) backgroundPath = found;
    }
    if (voicePath && (!path.isAbsolute(voicePath) || !fs.existsSync(voicePath))) {
        const found = _resolveMediaPath(voicePath);
        if (found) voicePath = found;
    }

    if (!backgroundPath) throw new Error('缺少 backgroundPath');
    if (!voicePath) throw new Error('缺少 voicePath');
    if (!assContent) throw new Error('缺少 assContent');
    if (!outputPath) throw new Error('缺少 outputPath');
    if (!fs.existsSync(backgroundPath)) throw new Error(`背景素材不存在: ${backgroundPath}`);
    if (!fs.existsSync(voicePath)) throw new Error(`音频不存在: ${voicePath}`);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const portraitCoverFilter = buildPortraitCoverFilter(targetWidth, targetHeight);

    // 关键：让 ASS PlayRes 与最终输出分辨率一致，避免导出字号相对预览被放大/缩小。
    let assFinal = assContent;
    try {
        if (forcePortrait) {
            assFinal = alignAssPlayRes(assContent, targetWidth, targetHeight);
        } else {
            const bgRes = parseResolutionText(await getResolution(backgroundPath));
            if (bgRes) {
                assFinal = alignAssPlayRes(assContent, bgRes.width, bgRes.height);
            }
        }
    } catch (e) {
        console.warn(`[composeReel] 对齐 ASS PlayRes 失败，继续使用原始 ASS: ${e.message}`);
    }

    const settings = require('./settings');
    const assPath = settings.secureTmpFile('reels_compose', '.ass');
    fs.writeFileSync(assPath, assFinal, 'utf-8');

    let vcodec = 'libx264';
    let preset = 'medium';
    const platform = process.platform;
    if (useGPU) {
        if (platform === 'darwin') {
            vcodec = 'h264_videotoolbox';
            preset = null;
        } else if (platform === 'win32') {
            // 按优先级：NVENC(Nvidia) → AMF(AMD) → QSV(Intel)
            // 在这个 fallback 路径中只做简单选择，实际主路径走 WYSIWYG 引擎有完整探测
            const { spawnSync } = require('child_process');
            const ffmpegBin = resolveCommand('ffmpeg');
            const testEncoders = [
                { codec: 'h264_nvenc', preset: 'p4' },
                { codec: 'h264_amf', preset: null },
                { codec: 'h264_qsv', preset: null },
            ];
            let found = false;
            for (const enc of testEncoders) {
                try {
                    const r = spawnSync(ffmpegBin, [
                        '-y', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1',
                        '-c:v', enc.codec, '-frames:v', '1', '-f', 'null', '-'
                    ], { timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] });
                    if (r.status === 0) {
                        vcodec = enc.codec;
                        preset = enc.preset;
                        found = true;
                        console.log(`[composeReel] GPU 编码器: ${enc.codec}`);
                        break;
                    }
                } catch (_) {}
            }
            if (!found) {
                console.log(`[composeReel] Windows GPU 编码器均不可用，回退 CPU`);
                vcodec = 'libx264';
                preset = 'medium';
            }
        }
    }

    const fontsDir = resolveLibassFontsDir();
    const subtitleFilter = fontsDir
        ? `subtitles='${escapeAssPathForFilter(assPath)}':fontsdir='${escapeAssPathForFilter(fontsDir)}'`
        : `subtitles='${escapeAssPathForFilter(assPath)}'`;
    const args = ['-y'];
    const imageBackground = isImageMedia(backgroundPath);
    const fadeEnabled = loopFade !== false && !imageBackground;
    const fadeDuration = sanitizeLoopFadeDuration(loopFadeDur);
    const voiceGain = sanitizeVolumeGain(voiceVolume, DEFAULT_VOICE_VOLUME);
    const bgGain = sanitizeVolumeGain(bgVolume, DEFAULT_BG_VOLUME);
    const needBgMix = !imageBackground && bgGain > 0;
    const hasBgMixAudio = needBgMix ? await hasAudioStream(backgroundPath) : false;
    // BGM support
    const hasBgm = bgmPath && fs.existsSync(bgmPath) && parseFloat(bgmVolume) > 0.001;
    const bgmGain = hasBgm ? sanitizeVolumeGain(bgmVolume, 0) : 0;
    const bgmSeek = Math.max(0, Number(bgmStart) || 0);

    let usingFadeLoop = false;
    if (fadeEnabled) {
        const [voiceDuration, bgVideoDuration, bgFallbackDuration] = await Promise.all([
            getDuration(voicePath),
            getPrimaryStreamDuration(backgroundPath, 'v:0'),
            getDuration(backgroundPath),
        ]);
        const bgDuration = (Number.isFinite(bgVideoDuration) && bgVideoDuration > 0)
            ? bgVideoDuration
            : bgFallbackDuration;
        const segCount = calcLoopFadeSegmentCount(voiceDuration, bgDuration, fadeDuration);

        if (segCount >= 2 && segCount <= MAX_LOOP_FADE_SEGMENTS) {
            for (let i = 0; i < segCount; i++) {
                args.push('-i', backgroundPath);
            }
            const bgAudioInputIdx = hasBgMixAudio ? segCount : -1;
            let nextIdx = hasBgMixAudio ? segCount + 1 : segCount;
            if (hasBgMixAudio) {
                args.push('-stream_loop', '-1', '-i', backgroundPath);
            }
            const bgmInputIdx = hasBgm ? nextIdx : -1;
            if (hasBgm) {
                if (bgmSeek > 0) args.push('-ss', bgmSeek.toFixed(3));
                args.push('-stream_loop', '-1', '-i', bgmPath);
                nextIdx++;
            }
            const audioInputIdx = nextIdx;
            args.push('-i', voicePath);

            const step = bgDuration - fadeDuration;
            const filterGraph = ['[0:v]setpts=PTS-STARTPTS[v0]'];
            let prevLabel = 'v0';

            for (let i = 1; i < segCount; i++) {
                const inLabel = `v${i}`;
                const outLabel = i === segCount - 1 ? 'vxf' : `vx${i}`;
                const offset = Math.max(0, (i * step) - 0.01).toFixed(3);
                filterGraph.push(`[${i}:v]setpts=PTS-STARTPTS[${inLabel}]`);
                filterGraph.push(
                    `[${prevLabel}][${inLabel}]xfade=transition=fade:duration=${fadeDuration.toFixed(3)}:offset=${offset}[${outLabel}]`
                );
                prevLabel = outLabel;
            }
            if (forcePortrait) {
                filterGraph.push(`[${prevLabel}]${portraitCoverFilter}[vfit]`);
                filterGraph.push(`[vfit]${subtitleFilter}[vout]`);
            } else {
                filterGraph.push(`[${prevLabel}]${subtitleFilter}[vout]`);
            }

            // Audio mixing (voice + background + BGM)
            let audioMap = `${audioInputIdx}:a:0`;
            const audioMixLabels = [];
            if (hasBgMixAudio) {
                filterGraph.push(`[${bgAudioInputIdx}:a]volume=${bgGain.toFixed(3)}[bgmix]`);
                audioMixLabels.push('[bgmix]');
            }
            filterGraph.push(`[${audioInputIdx}:a]volume=${voiceGain.toFixed(3)}[vomix]`);
            audioMixLabels.push('[vomix]');
            if (hasBgm) {
                filterGraph.push(`[${bgmInputIdx}:a]volume=${bgmGain.toFixed(3)}[bgmmus]`);
                audioMixLabels.push('[bgmmus]');
            }
            if (audioMixLabels.length >= 2) {
                // Keep additive loudness behavior aligned with preview playback.
                filterGraph.push(`${audioMixLabels.join('')}amix=inputs=${audioMixLabels.length}:duration=shortest:dropout_transition=0:normalize=0[aout]`);
                audioMap = '[aout]';
            } else if (Math.abs(voiceGain - 1.0) > 0.001) {
                audioMap = '[vomix]';
            }

            args.push(
                '-filter_complex', filterGraph.join(';'),
                '-map', '[vout]',
                '-map', audioMap
            );
            usingFadeLoop = true;
        } else if (segCount > MAX_LOOP_FADE_SEGMENTS) {
            console.warn(`[composeReel] 循环转场片段过多(${segCount})，回退到普通循环模式`);
        }
    }

    if (!usingFadeLoop) {
        if (imageBackground) {
            args.push('-loop', '1', '-i', backgroundPath);
        } else {
            args.push('-stream_loop', '-1', '-i', backgroundPath);
        }
        args.push('-i', voicePath);
        // BGM input (index 2: 0=bg, 1=voice)
        let bgmSimpleIdx = -1;
        if (hasBgm) {
            bgmSimpleIdx = 2;
            if (bgmSeek > 0) args.push('-ss', bgmSeek.toFixed(3));
            args.push('-stream_loop', '-1', '-i', bgmPath);
        }
        const needAudioFilter = hasBgMixAudio || hasBgm || Math.abs(voiceGain - 1.0) > 0.001;
        if (needAudioFilter) {
            const vf = forcePortrait ? `${portraitCoverFilter},${subtitleFilter}` : subtitleFilter;
            const filterGraph = [`[0:v]${vf}[vout]`];
            const mixLabels = [];
            if (hasBgMixAudio) {
                filterGraph.push(`[0:a]volume=${bgGain.toFixed(3)}[bgmix]`);
                mixLabels.push('[bgmix]');
            }
            filterGraph.push(`[1:a]volume=${voiceGain.toFixed(3)}[vomix]`);
            mixLabels.push('[vomix]');
            if (hasBgm && bgmSimpleIdx >= 0) {
                filterGraph.push(`[${bgmSimpleIdx}:a]volume=${bgmGain.toFixed(3)}[bgmmus]`);
                mixLabels.push('[bgmmus]');
            }
            if (mixLabels.length >= 2) {
                // Keep additive loudness behavior aligned with preview playback.
                filterGraph.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=shortest:dropout_transition=0:normalize=0[aout]`);
            } else {
                filterGraph.push('[vomix]anull[aout]');
            }
            args.push(
                '-filter_complex', filterGraph.join(';'),
                '-map', '[vout]',
                '-map', '[aout]'
            );
        } else {
            args.push(
                '-vf', forcePortrait ? `${portraitCoverFilter},${subtitleFilter}` : subtitleFilter,
                '-map', '0:v:0',
                '-map', '1:a:0'
            );
        }
    }

    args.push('-c:v', vcodec);

    if (vcodec === 'h264_videotoolbox') {
        args.push('-b:v', '8M');
    } else if (vcodec === 'h264_nvenc') {
        args.push('-preset', preset || 'p4', '-cq', String(Math.max(1, Math.min(51, crf || 18))), '-b:v', '0');
    } else if (vcodec === 'h264_amf') {
        args.push('-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(Math.max(0, Math.min(51, crf || 18))), '-qp_p', String(Math.max(0, Math.min(51, crf || 18))));
    } else if (vcodec === 'h264_qsv') {
        args.push('-global_quality', String(Math.max(1, Math.min(51, crf || 18))));
    } else {
        args.push('-crf', String(crf || 18));
        if (preset) args.push('-preset', preset);
    }

    args.push(
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-movflags', '+faststart',
        outputPath
    );

    try {
        await runCommand('ffmpeg', args, { timeout: Math.max(DEFAULT_TIMEOUT, 3600000) });
    } finally {
        try { fs.unlinkSync(assPath); } catch (e) { /* ignore */ }
    }

    return { output_path: outputPath };
}

/**
 * 媒体转换
 */
async function mediaConvert(filePath, mode, outDir, options = {}) {
    const baseName = path.parse(filePath).name;
    const ext = path.extname(filePath).toLowerCase();
    fs.mkdirSync(outDir, { recursive: true });

    const modeConfigs = {
        'mp3': { outputExt: '.mp3', type: 'audio' },
        'wav': { outputExt: '.wav', type: 'audio' },
        'aac': { outputExt: '.aac', type: 'audio' },
        'flac': { outputExt: '.flac', type: 'audio' },
        'mp4': { outputExt: '.mp4', type: 'video' },
        'h264': { outputExt: '_h264.mp4', type: 'video' },
        'x264': { outputExt: '_x264.mp4', type: 'video' },
        'mov': { outputExt: '.mov', type: 'video' },
        'dnxhr': { outputExt: '_dnxhr.mov', type: 'video' },
        'dnxhr_hqx': { outputExt: '_dnxhr_hqx.mov', type: 'video' },
        'webm': { outputExt: '.webm', type: 'video' },
        'gif': { outputExt: '.gif', type: 'video' },
        'audio_black': { outputExt: '.mp4', type: 'audio_black' },
        'audio_split': { outputExt: '', type: 'audio_split' },
        'png': { outputExt: '.png', type: 'image' },
        'jpg': { outputExt: '.jpg', type: 'image' },
        'jpeg': { outputExt: '.jpeg', type: 'image' },
        'jepg': { outputExt: '.jpeg', type: 'image' },
    };

    const config = modeConfigs[mode];
    if (!config) throw new Error(`不支持的转换模式: ${mode}`);

    const results = [];

    if (config.type === 'audio') {
        const outputPath = path.join(outDir, `${baseName}${config.outputExt}`);
        let args;
        switch (mode) {
            case 'mp3':
                args = ['-y', '-i', filePath, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '2', outputPath];
                break;
            case 'wav':
                args = ['-y', '-i', filePath, '-vn', '-acodec', 'pcm_s16le', outputPath];
                break;
            case 'aac':
                args = ['-y', '-i', filePath, '-vn', '-c:a', 'aac', '-b:a', '192k', outputPath];
                break;
            case 'flac':
                args = ['-y', '-i', filePath, '-vn', '-c:a', 'flac', outputPath];
                break;
        }
        await runCommand('ffmpeg', args);
        results.push(outputPath);
    } else if (config.type === 'video') {
        const outputPath = path.join(outDir, `${baseName}${config.outputExt}`);
        let args;
        switch (mode) {
            case 'mp4':
            case 'h264':
                args = ['-y', '-i', filePath, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', outputPath];
                break;
            case 'x264':
                args = ['-y', '-i', filePath, '-c:v', 'libx264', '-crf', String(options.crf || 23), '-preset', options.preset || 'slow', '-c:a', 'aac', '-b:a', '192k', outputPath];
                break;
            case 'mov':
                args = ['-y', '-i', filePath, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', outputPath];
                break;
            case 'dnxhr':
                args = ['-y', '-i', filePath, '-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq', '-pix_fmt', 'yuv422p', '-c:a', 'pcm_s16le', outputPath];
                break;
            case 'dnxhr_hqx':
                args = ['-y', '-i', filePath, '-c:v', 'dnxhd', '-profile:v', 'dnxhr_hqx', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s24le', outputPath];
                break;
            case 'webm':
                args = ['-y', '-i', filePath, '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-c:a', 'libopus', outputPath];
                break;
            case 'gif':
                args = ['-y', '-i', filePath,
                    '-vf', `fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
                    '-loop', '0', outputPath];
                break;
        }
        await runCommand('ffmpeg', args);
        results.push(outputPath);
    } else if (config.type === 'audio_black') {
        const outputPath = path.join(outDir, `${baseName}.mp4`);
        await generateBlackMp4(filePath, outputPath);
        results.push(outputPath);
    } else if (config.type === 'audio_split') {
        // 音频裁切导出 - 由 mediaConvertBatch 中处理
    } else if (config.type === 'image') {
        const outputPath = path.join(outDir, `${baseName}${config.outputExt}`);
        const args = ['-y', '-i', filePath];
        if (mode === 'jpg' || mode === 'jpeg' || mode === 'jepg') {
            args.push('-q:v', '2');
        }
        args.push(outputPath);
        await runCommand('ffmpeg', args);
        results.push(outputPath);
    }

    return results;
}

/** 静音检测（替代 moviepy 的 silence_detect） */
async function detectSilence(filePath, noiseDb = -30, minDuration = 0.5) {
    const { stderr } = await runCommand('ffmpeg', [
        '-hide_banner', '-i', filePath,
        '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
        '-f', 'null', '-'
    ], { timeout: DEFAULT_TIMEOUT, allowNonZero: true });

    const silencePoints = [];
    const startRegex = /silence_start:\s*([0-9.]+)/g;
    const endRegex = /silence_end:\s*([0-9.]+)/g;

    let m;
    const starts = [];
    const ends = [];
    while ((m = startRegex.exec(stderr))) starts.push(parseFloat(m[1]));
    while ((m = endRegex.exec(stderr))) ends.push(parseFloat(m[1]));

    for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
        silencePoints.push({
            start: starts[i],
            end: ends[i],
            mid: (starts[i] + ends[i]) / 2
        });
    }
    return silencePoints;
}

/** 智能分割分析（替代 moviepy 的 split_audio_on_silence） */
async function smartSplitAnalyze(filePath, maxDuration = 29) {
    const totalDuration = await getDuration(filePath);
    if (!totalDuration) throw new Error(`无法获取音频时长，请检查文件是否有效: ${path.basename(filePath)}`);

    // 用 FFmpeg silencedetect 检测静音点
    const silencePoints = await detectSilence(filePath, -30, 0.3);
    const silenceMids = silencePoints.map(s => s.mid);

    // 基于静音点计算分割
    const cutPoints = [0.0];
    let currentPos = 0.0;

    while (currentPos < totalDuration) {
        if (totalDuration - currentPos <= maxDuration) {
            cutPoints.push(totalDuration);
            break;
        }

        const searchLimit = currentPos + maxDuration;
        const searchStart = Math.max(currentPos + 5, searchLimit - 10);

        // 在搜索范围内找最佳静音点
        let bestCut = searchLimit;
        let minVol = Infinity;

        for (const mid of silenceMids) {
            if (mid >= searchStart && mid <= searchLimit) {
                bestCut = mid;
                break; // 取第一个在范围内的静音点
            }
        }

        if (bestCut - currentPos < 5.0) {
            bestCut = searchLimit;
        }

        cutPoints.push(bestCut);
        currentPos = bestCut;
    }

    // 构建分段信息
    const segments = [];
    for (let i = 0; i < cutPoints.length - 1; i++) {
        const start = cutPoints[i];
        const end = cutPoints[i + 1];
        segments.push({
            index: i + 1,
            start: Math.round(start * 100) / 100,
            end: Math.round(end * 100) / 100,
            duration: Math.round((end - start) * 100) / 100
        });
    }

    return {
        total_duration: Math.round(totalDuration * 100) / 100,
        max_duration: maxDuration,
        cut_points: cutPoints.map(p => Math.round(p * 100) / 100),
        segments,
        segment_count: segments.length
    };
}

/** 批量剪辑 — 将一个视频按命名片段列表导出多个文件 */
async function batchCut(filePath, segments, outputDir, precise = true) {
    const baseName = path.parse(filePath).name;
    const ext = path.extname(filePath).toLowerCase();
    const outDir = outputDir || path.dirname(filePath);
    const cutOutputDir = path.join(outDir, `${baseName}_cuts`);
    fs.mkdirSync(cutOutputDir, { recursive: true });

    // 获取视频总时长（用于 "到结尾" 的片段）
    const totalDuration = await getDuration(filePath);

    const exported = [];
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const start = parseFloat(seg.start || 0);
        let end = seg.end != null && seg.end !== '' ? parseFloat(seg.end) : null;
        if (end == null && totalDuration) end = totalDuration;
        if (end == null) throw new Error(`片段 #${i + 1}: 无法确定结束时间（无法获取视频总时长）`);
        if (end - start <= 0) continue;

        // 文件名：序号_名称
        const safeName = (seg.name || `片段${i + 1}`).replace(/[/\\:*?"<>|]/g, '_');
        const idx = String(i + 1).padStart(2, '0');
        const outputFilename = `${idx}_${safeName}${ext}`;
        const outputPath = path.join(cutOutputDir, outputFilename);

        let args;
        if (precise) {
            // 精确模式：重编码，帧级精准
            args = [
                '-y', '-i', filePath,
                '-ss', start.toFixed(3), '-to', end.toFixed(3),
                '-c:v', 'libx264', '-crf', '15', '-preset', 'medium',
                '-c:a', 'aac', '-b:a', '192k',
                '-avoid_negative_ts', 'make_zero',
                outputPath
            ];
        } else {
            // 快速模式：stream copy
            args = [
                '-y', '-ss', start.toFixed(3),
                '-i', filePath,
                '-to', (end - start).toFixed(3),
                '-c', 'copy',
                '-avoid_negative_ts', 'make_zero',
                outputPath
            ];
        }

        await runCommand('ffmpeg', args);

        exported.push({
            path: outputPath,
            filename: outputFilename,
            name: seg.name || `片段${i + 1}`,
            index: i + 1,
            start, end,
            duration: Math.round((end - start) * 1000) / 1000,
            mode: precise ? '精确' : '快速'
        });
    }

    return {
        message: `成功导出 ${exported.length} 个片段到 ${cutOutputDir}`,
        output_dir: cutOutputDir,
        files: exported,
        mode: precise ? '精确' : '快速'
    };
}

// ==================== 工具函数 ====================

function formatSceneTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

function parseTimecode(token, fps = 25) {
    const parts = token.split(':');
    if (parts.length === 4) {
        // HH:MM:SS:FF (NLE timecode with frames)
        return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]) + parseFloat(parts[3]) / fps;
    } else if (parts.length === 3) {
        return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
        return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(token);
}

function parseCutPoints(raw) {
    if (!raw || !raw.trim()) return [];
    const normalized = raw.replace(/，/g, ',').replace(/；/g, ';');
    const tokens = normalized.split(/[,\s;]+/).filter(t => t.trim());
    return tokens.map(t => {
        const val = parseTimecode(t.trim());
        if (isNaN(val) || val < 0) throw new Error(`无效的分割点: ${t}`);
        return val;
    }).sort((a, b) => a - b);
}

function buildSegments(cutPoints) {
    if (cutPoints.length === 0) return [[0, null]];
    const segments = [];
    segments.push([0, cutPoints[0]]);
    for (let i = 0; i < cutPoints.length - 1; i++) {
        segments.push([cutPoints[i], cutPoints[i + 1]]);
    }
    segments.push([cutPoints[cutPoints.length - 1], null]);
    return segments;
}

async function applyAudioFx(filePath, outDir, data) {
    const rawVideo = require('./ffmpeg-rawvideo');
    const settings = require('./settings');
    const { reverbEnabled, reverbPreset, reverbMix, stereoWidth } = data;
    
    console.log('[AudioFX] 开始处理:', filePath);
    console.log('[AudioFX] 参数:', { reverbEnabled, reverbPreset, reverbMix, stereoWidth });
    
    const baseName = path.parse(filePath).name;
    const ext = path.extname(filePath).toLowerCase();
    const isVideo = ['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(ext);
    
    // 如果是视频文件，先用 FFmpeg 提取音频为 WAV（Chromium decodeAudioData 无法解码视频容器）
    let audioInputPath = filePath;
    let tmpExtractedWav = null;
    
    if (isVideo) {
        tmpExtractedWav = settings.secureTmpFile('audiofx_extracted', '.wav');
        console.log('[AudioFX] 视频文件，先提取音频:', tmpExtractedWav);
        await runCommand('ffmpeg', [
            '-y', '-i', filePath,
            '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
            tmpExtractedWav
        ]);
        audioInputPath = tmpExtractedWav;
    }
    
    // WebAudio render
    console.log('[AudioFX] 开始 Chromium Web Audio 渲染...');
    const wavPath = await rawVideo.renderChromiumAudioWav({
        filePath: audioInputPath,
        reverbEnabled: reverbEnabled || false,
        reverbPreset: reverbPreset || 'hall',
        reverbMix: reverbMix || 30,
        stereoWidth: stereoWidth || 100
    });
    console.log('[AudioFX] Chromium 渲染完成:', wavPath);
    
    // 清理提取的临时音频
    if (tmpExtractedWav) {
        try { fs.unlinkSync(tmpExtractedWav); } catch(e) {}
    }

    let outputPath = '';
    
    if (isVideo) {
        outputPath = path.join(outDir, `${baseName}_audioFX${ext}`);
        console.log('[AudioFX] 视频模式，重新封装:', outputPath);
        await runCommand('ffmpeg', [
            '-y', 
            '-i', filePath, 
            '-i', wavPath,
            '-map', '0:v', 
            '-map', '1:a', 
            '-c:v', 'copy', 
            '-c:a', 'aac', '-b:a', '192k', 
            outputPath
        ]);
    } else {
        // 用户选择的输出格式，默认回退到输入格式或 mp3
        const userFormat = (data.outputFormat || '').toLowerCase();
        const formatMap = { 'mp3': '.mp3', 'wav': '.wav', 'flac': '.flac', 'm4a': '.m4a' };
        const outExt = formatMap[userFormat] || (['.mp3', '.wav', '.flac', '.m4a'].includes(ext) ? ext : '.mp3');
        outputPath = path.join(outDir, `${baseName}_audioFX${outExt}`);
        console.log('[AudioFX] 音频模式，输出格式:', outExt, '输出:', outputPath);
        if (outExt === '.wav') {
            await runCommand('ffmpeg', ['-y', '-i', wavPath, '-c:a', 'copy', outputPath]);
        } else if (outExt === '.mp3') {
            await runCommand('ffmpeg', ['-y', '-i', wavPath, '-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '2', outputPath]);
        } else if (outExt === '.flac') {
            await runCommand('ffmpeg', ['-y', '-i', wavPath, '-c:a', 'flac', outputPath]);
        } else if (outExt === '.m4a') {
            await runCommand('ffmpeg', ['-y', '-i', wavPath, '-c:a', 'aac', '-b:a', '192k', outputPath]);
        } else {
            await runCommand('ffmpeg', ['-y', '-i', wavPath, '-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '2', outputPath]);
        }
    }

    try { fs.unlinkSync(wavPath); } catch(e) {}
    console.log('[AudioFX] 完成:', outputPath);
    return [outputPath];
}

/**
 * 文字水印：使用 FFmpeg drawtext 滤镜给视频添加文字水印
 */
async function applyWatermark(filePath, outDir, wmOpts = {}) {
    const baseName = path.parse(filePath).name;
    const ext = path.extname(filePath).toLowerCase();
    const outputPath = path.join(outDir, `${baseName}_watermark${ext === '.mov' ? '.mov' : '.mp4'}`);

    const text = (wmOpts.text || 'AI Generated').replace(/'/g, "'\\''").replace(/:/g, '\\:');
    const font = wmOpts.font || 'Arial';
    const fontSize = parseInt(wmOpts.font_size) || 24;
    const color = wmOpts.color || '#ffffff';
    const opacity = parseFloat(wmOpts.opacity ?? 1);
    const hasStroke = wmOpts.stroke !== false;
    const strokeColor = wmOpts.stroke_color || '#000000';
    const strokeWidth = parseInt(wmOpts.stroke_width) || 2;
    const hasShadow = wmOpts.shadow === true;
    const posX = wmOpts.x || 'w-tw-10';
    const posY = wmOpts.y || '10';

    // 颜色转换：#RRGGBB -> FFmpeg 的 RRGGBB@opacity 格式
    const hexToFFmpegColor = (hex, alpha) => {
        const clean = hex.replace('#', '');
        const a = Math.max(0, Math.min(1, alpha));
        return `0x${clean}@${a.toFixed(2)}`;
    };

    const fontColor = hexToFFmpegColor(color, opacity);

    // 解析字体路径 — 尝试从系统字体目录找
    let fontFile = '';
    const fontsDir = resolveLibassFontsDir();
    if (fontsDir) {
        const candidates = [
            `${font}.ttf`, `${font}.otf`, `${font}.TTF`, `${font}.OTF`,
            `${font.replace(/\s/g, '')}.ttf`, `${font.replace(/\s/g, '')}.otf`,
        ];
        for (const c of candidates) {
            const p = path.join(fontsDir, c);
            if (fs.existsSync(p)) { fontFile = p; break; }
        }
    }
    // macOS 系统字体  
    if (!fontFile && process.platform === 'darwin') {
        const sysFonts = ['/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')];
        outer: for (const dir of sysFonts) {
            try {
                const files = fs.readdirSync(dir);
                for (const f of files) {
                    if (f.toLowerCase().includes(font.toLowerCase()) && /\.(ttf|otf|ttc)$/i.test(f)) {
                        fontFile = path.join(dir, f);
                        break outer;
                    }
                }
            } catch { }
        }
    }
    // Windows 系统字体
    if (!fontFile && process.platform === 'win32') {
        const winFontsDir = 'C:\\Windows\\Fonts';
        try {
            const files = fs.readdirSync(winFontsDir);
            for (const f of files) {
                if (f.toLowerCase().includes(font.toLowerCase()) && /\.(ttf|otf|ttc)$/i.test(f)) {
                    fontFile = path.join(winFontsDir, f);
                    break;
                }
            }
        } catch { }
    }

    // 构建 drawtext 滤镜
    let drawtext = `drawtext=text='${text}':fontsize=${fontSize}:fontcolor=${fontColor}:x=${posX}:y=${posY}`;
    if (fontFile) {
        const escapedFontFile = fontFile.replace(/\\/g, '/').replace(/:/g, '\\:');
        drawtext += `:fontfile='${escapedFontFile}'`;
    } else {
        drawtext += `:font='${font}'`;
    }
    if (hasStroke) {
        const bColor = hexToFFmpegColor(strokeColor, opacity);
        drawtext += `:borderw=${strokeWidth}:bordercolor=${bColor}`;
    }
    if (hasShadow) {
        drawtext += `:shadowx=2:shadowy=2:shadowcolor=0x000000@0.5`;
    }

    console.log('[Watermark] drawtext filter:', drawtext);

    const args = [
        '-y', '-i', filePath,
        '-vf', drawtext,
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        outputPath
    ];

    await runCommand('ffmpeg', args, { timeout: Math.max(DEFAULT_TIMEOUT, 3600000) });

    if (!fs.existsSync(outputPath)) {
        throw new Error(`水印输出文件未生成: ${outputPath}`);
    }

    console.log('[Watermark] 完成:', outputPath);
    return [outputPath];
}

/** 获取内置预设 Logo 的完整本地路径 */
function getPresetLogoPath(preset) {
    const presetFiles = {
        hailuo: 'Hailuo.png',
        vidu: 'vidu.png',
        veo: 'Veo.png',
        heygen: 'HeyGen.png',
        dream: 'Dream.png',
        ai_generated: 'AI_Generated.png'
    };
    const fileName = presetFiles[preset];
    if (!fileName) return null;

    const candidates = [];
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'assets', fileName));
    }
    candidates.push(path.join(__dirname, '..', '..', 'assets', fileName));
    candidates.push(path.join(__dirname, '..', '..', 'dist', 'assets', fileName));
    candidates.push(path.join(__dirname, '..', 'assets', fileName));
    candidates.push(path.join(__dirname, 'assets', fileName));

    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

/** 给视频叠加图片 Logo (自定义或预设) */
async function applyLogo(filePath, outDir, options = {}) {
    const baseName = path.parse(filePath).name;
    const ext = path.extname(filePath).toLowerCase();
    const outputPath = path.join(outDir, `${baseName}_logo${ext === '.mov' ? '.mov' : '.mp4'}`);

    const mode = options.mode || 'custom_logo';
    let logoPath = '';
    let x = 590;
    let y = 1810;
    let w = 400;
    let h = 90;

    if (mode === 'custom_logo') {
        const custom = options.custom_logo || {};
        logoPath = custom.path;
        x = parseInt(custom.x) ?? 590;
        y = parseInt(custom.y) ?? 1810;
        w = parseInt(custom.width) ?? 400;
        h = parseInt(custom.height) ?? 90;
    } else {
        // 预设 Logo
        logoPath = getPresetLogoPath(mode);
        const override = options.logo_override || {};
        x = parseInt(override.x) ?? 590;
        y = parseInt(override.y) ?? 1810;
        w = parseInt(override.width) ?? 400;
        h = parseInt(override.height) ?? 90;
    }

    if (!logoPath || !fs.existsSync(logoPath)) {
        throw new Error(`找不到 Logo 图片文件: ${logoPath || mode}`);
    }

    // 构建 filter_complex 表达式：缩放 Logo 并强制设置 sar=1 防止拉伸，然后 overlay 叠加
    const filterComplex = `[1:v]scale=${w}:${h},setsar=1[logo];[0:v][logo]overlay=${x}:${y}`;

    const args = [
        '-y',
        '-i', filePath,
        '-i', logoPath,
        '-filter_complex', filterComplex,
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        outputPath
    ];

    console.log('[Logo] filter_complex:', filterComplex, 'logoPath:', logoPath);

    await runCommand('ffmpeg', args, { timeout: Math.max(DEFAULT_TIMEOUT, 3600000) });

    if (!fs.existsSync(outputPath)) {
        throw new Error(`Logo 视频输出文件未生成: ${outputPath}`);
    }

    console.log('[Logo] 叠加完成:', outputPath);
    return [outputPath];
}

function _escapeConcatListPath(filePath) {
    return String(filePath).replace(/'/g, "'\\''");
}

async function hasAudioTrack(filePath) {
    try {
        const { stdout } = await runCommand('ffprobe', [
            '-v', 'error',
            '-select_streams', 'a',
            '-show_entries', 'stream=codec_type',
            '-of', 'csv=p=0',
            filePath
        ], { timeout: PROBE_TIMEOUT });
        return stdout.trim().length > 0;
    } catch (_) {
        return false;
    }
}

async function concatClips(opts = {}) {
    const {
        clips = [],
        outputPath,
        targetWidth = 1080,
        targetHeight = 1920,
        fps = 30,
        crf = 18,
        preset = 'fast',
        skipNormalization = false,
    } = opts;

    const validClips = (clips || []).filter(p => p && fs.existsSync(p));
    if (validClips.length < 2) throw new Error('至少需要 2 个有效视频片段');
    if (!outputPath) throw new Error('缺少输出路径');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const sessionId = crypto.randomBytes(4).toString('hex');
    const tmpDir = path.join(os.tmpdir(), `videokit_concat_${sessionId}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const normalized = [];
    try {
        if (skipNormalization) {
            normalized.push(...validClips);
        } else {
            for (let i = 0; i < validClips.length; i++) {
                const src = validClips[i];
                const out = path.join(tmpDir, `clip_${String(i + 1).padStart(4, '0')}.mp4`);
                const hasAudio = await hasAudioTrack(src);
                const args = ['-y', '-i', src];
                let filterComplex;
                if (hasAudio) {
                    filterComplex = `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},fps=${fps},setsar=1[v];[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a]`;
                } else {
                    args.push('-f', 'lavfi', '-i', 'anullsrc=cl=stereo:r=48000');
                    filterComplex = `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},fps=${fps},setsar=1[v];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a]`;
                }
                args.push(
                    '-filter_complex', filterComplex,
                    '-map', '[v]', '-map', '[a]',
                    '-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
                    '-c:a', 'aac', '-b:a', '192k',
                    '-shortest',
                    out
                );
                console.log(`[ConcatClips] 归一化 ${i + 1}/${validClips.length}: ${path.basename(src)}`);
                await runCommand('ffmpeg', args, { timeout: Math.max(DEFAULT_TIMEOUT, 1800000) });
                normalized.push(out);
            }
        }

        const listPath = path.join(tmpDir, 'concat_list.txt');
        const listContent = normalized.map(p => `file '${_escapeConcatListPath(p)}'`).join('\n');
        fs.writeFileSync(listPath, listContent, 'utf-8');

        await runCommand('ffmpeg', [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', listPath,
            '-c', 'copy',
            outputPath
        ], { timeout: Math.max(DEFAULT_TIMEOUT, 1800000) });

        const duration = await getDuration(outputPath);
        return {
            success: true,
            outputPath,
            output_path: outputPath,
            clip_count: validClips.length,
            duration,
        };
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
    }
}

function _mapXfadeTransition(transition) {
    const map = {
        crossfade: 'fade',
        fade: 'fade',
        fade_black: 'fadeblack',
        fadeblack: 'fadeblack',
        fade_white: 'fadewhite',
        fadewhite: 'fadewhite',
        slide_left: 'slideleft',
        slide_right: 'slideright',
        wipe_left: 'wipeleft',
    };
    return map[transition] || 'fade';
}

async function concatClipsWithTransitions(opts = {}) {
    const {
        clips = [],
        outputPath,
        targetWidth = 1080,
        targetHeight = 1920,
        fps = 30,
        crf = 18,
        preset = 'fast',
        transition = 'crossfade',
        transitionDuration = 0.35,
        skipNormalization = false,
    } = opts;

    const validClips = (clips || []).filter(p => p && fs.existsSync(p));
    if (validClips.length < 2) throw new Error('至少需要 2 个有效视频片段');
    if (!outputPath) throw new Error('缺少输出路径');

    const baseTransDur = Math.max(0, Math.min(3, parseFloat(transitionDuration) || 0));
    if (!transition || transition === 'none' || baseTransDur <= 0.03) {
        return await concatClips({ clips: validClips, outputPath, targetWidth, targetHeight, fps, crf, preset, skipNormalization });
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const sessionId = crypto.randomBytes(4).toString('hex');
    const tmpDir = path.join(os.tmpdir(), `videokit_concat_xfade_${sessionId}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const normalized = [];
    const durations = [];
    try {
        if (skipNormalization) {
            normalized.push(...validClips);
            for (const c of validClips) {
                durations.push(await getDuration(c) || 0);
            }
        } else {
            for (let i = 0; i < validClips.length; i++) {
                const src = validClips[i];
                const out = path.join(tmpDir, `clip_${String(i + 1).padStart(4, '0')}.mp4`);
                const hasAudio = await hasAudioTrack(src);
                const args = ['-y', '-i', src];
                let filterComplex;
                if (hasAudio) {
                    filterComplex = `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},fps=${fps},settb=AVTB,setsar=1[v];[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a]`;
                } else {
                    args.push('-f', 'lavfi', '-i', 'anullsrc=cl=stereo:r=48000');
                    filterComplex = `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},fps=${fps},settb=AVTB,setsar=1[v];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a]`;
                }
                args.push(
                    '-filter_complex', filterComplex,
                    '-map', '[v]', '-map', '[a]',
                    '-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
                    '-c:a', 'aac', '-b:a', '192k',
                    '-shortest',
                    out
                );
                console.log(`[ConcatXfade] 归一化 ${i + 1}/${validClips.length}: ${path.basename(src)}`);
                await runCommand('ffmpeg', args, { timeout: Math.max(DEFAULT_TIMEOUT, 1800000) });
                normalized.push(out);
                durations.push(await getDuration(out) || 0);
            }
        }

        const transitionDurations = [];
        for (let i = 1; i < normalized.length; i++) {
            const tDur = Math.min(baseTransDur, durations[i - 1] * 0.45, durations[i] * 0.45);
            transitionDurations.push(tDur > 0.05 ? tDur : 0);
        }
        if (transitionDurations.every(d => d <= 0)) {
            return await concatClips({ clips: validClips, outputPath, targetWidth, targetHeight, fps, crf, preset });
        }

        const args = ['-y'];
        normalized.forEach(p => args.push('-i', p));

        const filters = [];
        for (let i = 0; i < normalized.length; i++) {
            filters.push(`[${i}:v]fps=${fps},settb=AVTB,setsar=1[v${i}]`);
            filters.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`);
        }

        const xfadeName = _mapXfadeTransition(transition);
        let videoLabel = 'v0';
        let audioLabel = 'a0';
        let timelineDur = durations[0] || 0;

        for (let i = 1; i < normalized.length; i++) {
            const tDur = transitionDurations[i - 1];
            const outV = `vx${i}`;
            const outA = `ax${i}`;
            if (tDur > 0) {
                const offset = Math.max(0.01, timelineDur - tDur);
                filters.push(`[${videoLabel}][v${i}]xfade=transition=${xfadeName}:duration=${tDur.toFixed(3)}:offset=${offset.toFixed(3)}[${outV}]`);
                filters.push(`[${audioLabel}][a${i}]acrossfade=d=${tDur.toFixed(3)}[${outA}]`);
                timelineDur += (durations[i] || 0) - tDur;
            } else {
                filters.push(`[${videoLabel}][${audioLabel}][v${i}][a${i}]concat=n=2:v=1:a=1[${outV}][${outA}]`);
                timelineDur += durations[i] || 0;
            }
            videoLabel = outV;
            audioLabel = outA;
        }

        args.push(
            '-filter_complex', filters.join(';'),
            '-map', `[${videoLabel}]`,
            '-map', `[${audioLabel}]`,
            '-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
            '-c:a', 'aac', '-b:a', '192k',
            outputPath
        );
        await runCommand('ffmpeg', args, { timeout: Math.max(DEFAULT_TIMEOUT, 1800000) });

        const duration = await getDuration(outputPath);
        return {
            success: true,
            outputPath,
            output_path: outputPath,
            clip_count: validClips.length,
            duration,
            transition,
            transition_duration: baseTransDur,
        };
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
    }
}

/**
 * 视频首尾拼接，处理 Hook 片段与正片的拼接（包含分辨率归一化、转场滤镜、音视频轨道同步）
 * @param {object} opts
 */
async function concatVideo(opts) {
    const {
        introPath, mainPath, outputPath,
        speed = 1.0, transition = 'none', transDuration = 0.5,
        targetWidth = 1080, targetHeight = 1920, fps = 30
    } = opts;

    if (!fs.existsSync(introPath)) throw new Error(`找不到前置素材: ${introPath}`);
    if (!fs.existsSync(mainPath)) throw new Error(`找不到正片素材: ${mainPath}`);

    try {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    } catch (e) {
        console.warn(`[ConcatVideo] Failed to create directory: ${e.message}`);
    }

    const util = require('util');
    const { execFile } = require('child_process');
    const execFileAsync = util.promisify(execFile);
    const ffprobe = resolveCommand('ffprobe');

    // 1. 探测 Hook 是否包含音频流
    let hookHasAudio = false;
    try {
        const { stdout } = await execFileAsync(ffprobe, [
            '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', introPath
        ]);
        hookHasAudio = stdout.trim().length > 0;
    } catch (e) { }

    const sessionId = crypto.randomBytes(4).toString('hex');
    const tmpDir = os.tmpdir();
    const hookNormPath = path.join(tmpDir, `hook_norm_${sessionId}.mp4`);

    let filterComplex = '';
    const speedRatio = speed > 0 ? parseFloat(speed) : 1.0;
    const vPts = (1.0 / speedRatio).toFixed(5);
    
    // a. 画面归一化（缩放、黑边填充、帧率、变速）
    filterComplex += `[0:v]setpts=${vPts}*PTS,scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,fps=${fps}[vout];`;

    // b. 音频归一化（无音频则使用空白音轨，同步变速调音）
    if (hookHasAudio) {
        if (speedRatio !== 1.0) {
            if (speedRatio >= 0.5 && speedRatio <= 2.0) {
                filterComplex += `[0:a]atempo=${speedRatio},aformat=sample_rates=48000:channel_layouts=stereo[aout]`;
            } else if (speedRatio > 2.0 && speedRatio <= 4.0) {
                filterComplex += `[0:a]atempo=2.0,atempo=${(speedRatio/2.0).toFixed(4)},aformat=sample_rates=48000:channel_layouts=stereo[aout]`;
            } else if (speedRatio < 0.5 && speedRatio >= 0.25) {
                filterComplex += `[0:a]atempo=0.5,atempo=${(speedRatio/0.5).toFixed(4)},aformat=sample_rates=48000:channel_layouts=stereo[aout]`;
            } else {
                filterComplex += `[0:a]anull,aformat=sample_rates=48000:channel_layouts=stereo[aout]`;
            }
        } else {
            filterComplex += `[0:a]aformat=sample_rates=48000:channel_layouts=stereo[aout]`;
        }
    } else {
        filterComplex += `[1:a]aformat=sample_rates=48000:channel_layouts=stereo[aout]`;
    }

    const normArgs = [
        '-y',
        '-i', introPath,
        '-f', 'lavfi', '-i', 'anullsrc=cl=stereo:r=48000',
    ];

    // Add trimming AFTER -i (post-input seek — safe with filter_complex in FFmpeg 8.0)
    // Using -ss after input for precise frame-accurate seek
    const trimStart = (opts.trimStart != null && opts.trimStart > 0) ? parseFloat(opts.trimStart) : 0;
    const trimEnd   = (opts.trimEnd   != null && opts.trimEnd   > 0) ? parseFloat(opts.trimEnd)   : null;
    const trimFilterParts = [];
    if (trimStart > 0 || trimEnd != null) {
        // Build atrim/trim via filter_complex instead of input flags to avoid FFmpeg 8.0 EINVAL
        const vTrimEnd = trimEnd != null ? `:end=${trimEnd}` : '';
        const aTrimEnd = trimEnd != null ? `:end=${trimEnd}` : '';
        // Prepend trim to existing filterComplex video chain
        // Replace the first [0:v] reference with a trim-then-setpts chain
        filterComplex = filterComplex.replace(
            '[0:v]setpts=',
            `[0:v]trim=start=${trimStart}${vTrimEnd},setpts=PTS-STARTPTS,setpts=`
        );
        if (hookHasAudio) {
            // Also trim audio — insert atrim before the existing [0:a] chain
            filterComplex = filterComplex.replace(
                '[0:a]atempo',
                `[0:a]atrim=start=${trimStart}${aTrimEnd},asetpts=PTS-STARTPTS,atempo`
            ).replace(
                '[0:a]anull',
                `[0:a]atrim=start=${trimStart}${aTrimEnd},asetpts=PTS-STARTPTS,anull`
            ).replace(
                '[0:a]aformat',
                `[0:a]atrim=start=${trimStart}${aTrimEnd},asetpts=PTS-STARTPTS,aformat`
            );
        }
    }

    normArgs.push(
        '-filter_complex', filterComplex,
        '-map', '[vout]',
        '-map', '[aout]',
        '-c:v', 'libx264', '-crf', '18', '-preset', 'ultrafast',
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest',
        hookNormPath
    );

    console.log('[ConcatVideo] 预处理 Hook 参数:', normArgs.join(' '));
    try {
        await runCommand('ffmpeg', normArgs, { timeout: 300000 });
    } catch (e) {
        console.error('[ConcatVideo] Hook 预处理失败:', e.message);
        throw e;
    }

    const hookDur = await getDuration(hookNormPath);
    console.log(`[ConcatVideo] Hook 预处理完成 (时长: ${hookDur}s)`);

    // 探测正片是否有音频流（无音频时需要补静音轨）
    let mainHasAudio = false;
    try {
        const { stdout: mainAudioOut } = await execFileAsync(ffprobe, [
            '-v', 'error', '-select_streams', 'a',
            '-show_entries', 'stream=codec_type',
            '-of', 'csv=p=0', mainPath
        ]);
        mainHasAudio = mainAudioOut.trim().length > 0;
    } catch (e) { }
    console.log(`[ConcatVideo] mainHasAudio=${mainHasAudio}`);

    const concatArgs = ['-y', '-i', hookNormPath, '-i', mainPath];
    // 如果正片没有音频，补一个静音轨（索引2）
    if (!mainHasAudio) {
        concatArgs.push('-f', 'lavfi', '-i', 'anullsrc=cl=stereo:r=48000');
    }
    const finalTransDur = parseFloat(transDuration) || 0;

    // Map UI anim engine preset to standard xfade transition names
    const FFMPEG_XFADE_MAP = {
        'fade_in': 'fade', 'fade_out': 'fade', 'fade_both': 'fade',
        'pop_in': 'zoomin', 'pop_out': 'zoomin', 'pop_both': 'zoomin',
        'sway_in': 'smoothleft', 'sway_out': 'smoothright', 'sway_both': 'smoothleft',
        'slide_left_in': 'slideleft', 'slide_right_in': 'slideright', 'slide_up_in': 'slideup', 'slide_down_in': 'slidedown',
        'slide_left_out': 'slideleft', 'slide_right_out': 'slideright', 'slide_up_out': 'slideup', 'slide_down_out': 'slidedown',
        'slide_left_both': 'slideleft', 'slide_right_both': 'slideright', 'slide_up_both': 'slideup', 'slide_down_both': 'slidedown'
    };
    const xfadeName = FFMPEG_XFADE_MAP[transition] || transition;

    const mainAudioLabel = mainHasAudio ? '1:a' : '2:a';
    const hookVideoFilter = `[0:v]fps=${fps},settb=AVTB,setsar=1[v0]`;
    const mainVideoFilter = `[1:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,fps=${fps},settb=AVTB,setsar=1[v1]`;

    if (transition === 'none' || finalTransDur <= 0 || hookDur <= finalTransDur) {
        // 硬切拼接 — 统一画面、SAR 和音频参数，避免 FFmpeg 8 concat 严格校验失败
        concatArgs.push(
            '-filter_complex', `${hookVideoFilter};${mainVideoFilter};[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0];[${mainAudioLabel}]aformat=sample_rates=48000:channel_layouts=stereo[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`,
            '-map', '[v]', '-map', '[a]'
        );
    } else {
        const offset = Math.max(0.1, hookDur - finalTransDur).toFixed(3);
        // xfade 要求两个输入 timebase/SAR 完全一致 — 用 fps+settb+setsar 统一，并统一音频参数
        concatArgs.push(
            '-filter_complex', `${hookVideoFilter};${mainVideoFilter};[v0][v1]xfade=transition=${xfadeName}:duration=${finalTransDur}:offset=${offset}[v];[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0];[${mainAudioLabel}]aformat=sample_rates=48000:channel_layouts=stereo[a1];[a0][a1]acrossfade=d=${finalTransDur}[a]`,
            '-map', '[v]', '-map', '[a]'
        );
    }

    concatArgs.push('-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-c:a', 'aac', '-b:a', '192k', outputPath);
    
    console.log('[ConcatVideo] 合并正片参数:', concatArgs.join(' '));
    await runCommand('ffmpeg', concatArgs, { timeout: 600000 });

    try { fs.unlinkSync(hookNormPath); } catch (e) {}
    
    return { success: true, outputPath };
}

module.exports = {
    resolveCommand,
    runCommand,
    getDuration,
    getDurationDetailed,
    getFrameRate,
    getResolution,
    getWaveformBinary,
    sceneDetect,
    sceneDetectFrames,
    sceneExportFrames,
    sceneSplit,
    mediaTrim,
    batchThumbnail,
    generateBlackMp4,
    mediaConvert,
    detectSilence,
    smartSplitAnalyze,
    applyAudioFx,
    applyWatermark,
    applyLogo,
    formatSceneTime,
    parseTimecode,
    parseCutPoints,
    buildSegments,
    buildBlackMp4Args,
    batchCut,
    composeReel,
    concatVideo,
    concatClips,
    concatClipsWithTransitions,
    hasAudioTrack,
    escapeAssPathForFilter,
    formatMediaError,
};
