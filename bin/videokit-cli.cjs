#!/usr/bin/env node
'use strict';

/**
 * VideoKit Headless CLI (videokit-cli)
 *
 * Pure Node.js + FFmpeg command-line interface for headless Linux/Windows/macOS
 * video rendering, validation, batch execution, and TTS synthesis.
 * Does NOT require X11 / Wayland / DISPLAY or Electron BrowserWindow.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const ReelsSubtitleProcessor = require('../src/reels-subtitle-processor.js');

const EXIT_CODES = {
    OK: 0,
    GENERAL_ERROR: 1,
    VALIDATION_ERROR: 2,
    RESOURCE_NOT_FOUND: 3,
    RENDER_ERROR: 4,
    API_KEY_MISSING: 5,
};

class CLIError extends Error {
    constructor(code, message, exitCode = EXIT_CODES.GENERAL_ERROR, taskId = null) {
        super(message);
        this.name = 'CLIError';
        this.code = code;
        this.exitCode = exitCode;
        this.taskId = taskId;
    }
}

function getPackageVersion() {
    try {
        const pkgPath = path.resolve(__dirname, '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.version || '4.5.2';
    } catch {
        return '4.5.2';
    }
}

function emitStdoutJson(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitStderrJson(obj) {
    process.stderr.write(JSON.stringify(obj) + '\n');
}

function logStderr(msg) {
    process.stderr.write(`${msg}\n`);
}

function printHelp() {
    const version = getPackageVersion();
    const helpText = `videokit-cli v${version} — Headless CLI for VideoKit Reels rendering & validation

Usage:
  videokit-cli reels --task <task.json> [--output <out.mp4>] [options]
  videokit-cli reels --batch <tasks-dir-or-manifest.json> [--output-dir <dir>] [options]
  videokit-cli validate --task <task.json>
  videokit-cli tts --task <tts-task.json> [--config <config.json>]
  videokit-cli --version
  videokit-cli --help

Options:
  --task <file>              Single task JSON file path
  --batch <dir-or-file>      Batch task directory or batch manifest JSON file
  --output, -o <file>        Single task output MP4 path (overrides task.output)
  --output-dir <dir>         Output directory for tasks (default: ./out)
  --config <file>            Config JSON path (default: ~/.config/videokit/config.json)
  --quality <high|medium|low> Render quality preset (default: medium)
  --dry-run                  Validate task and print ffmpeg command without rendering
  --overwrite                Overwrite existing output file
  --skip-existing            Skip tasks whose output file already exists
  --fail-fast                Stop batch execution immediately on first task failure
  --timeout <sec>            Per-task render timeout in seconds (default: 600)
  --quiet, -q                Suppress progress JSON lines on stdout
  --keep-temp                Keep temporary .ass and working directory for debugging
  --jobs <N>                 Parallel worker count in batch mode (default: 1)

Exit Codes:
  0  Success
  1  General runtime error
  2  Invalid CLI arguments or task JSON validation error
  3  Missing input media file, font, or ffmpeg/ffprobe binary
  4  FFmpeg render failure or render timeout
  5  Missing required API key (TTS / transcription)
`;
    process.stdout.write(helpText);
}

/**
 * Parse CLI arguments
 */
function parseArgs(argv) {
    const args = {
        subcommand: null,
        task: null,
        batch: null,
        output: null,
        outputDir: null,
        config: null,
        quality: null,
        dryRun: false,
        overwrite: false,
        skipExisting: false,
        failFast: false,
        timeout: 600,
        quiet: false,
        keepTemp: false,
        jobs: 1,
        version: false,
        help: false,
    };

    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--headless') {
            continue;
        }
        if (token === '--version' || token === '-v') {
            args.version = true;
            continue;
        }
        if (token === '--help' || token === '-h') {
            args.help = true;
            continue;
        }
        if (token === '--dry-run') {
            args.dryRun = true;
            continue;
        }
        if (token === '--overwrite') {
            args.overwrite = true;
            continue;
        }
        if (token === '--skip-existing') {
            args.skipExisting = true;
            continue;
        }
        if (token === '--fail-fast') {
            args.failFast = true;
            continue;
        }
        if (token === '--quiet' || token === '-q') {
            args.quiet = true;
            continue;
        }
        if (token === '--keep-temp') {
            args.keepTemp = true;
            continue;
        }

        const readValue = (flagName) => {
            if (i + 1 >= argv.length) {
                throw new CLIError('INVALID_ARGS', `Missing value for ${flagName}`, EXIT_CODES.VALIDATION_ERROR);
            }
            return argv[++i];
        };

        if (token === '--task') {
            args.task = readValue('--task');
        } else if (token.startsWith('--task=')) {
            args.task = token.slice('--task='.length);
        } else if (token === '--batch') {
            args.batch = readValue('--batch');
        } else if (token.startsWith('--batch=')) {
            args.batch = token.slice('--batch='.length);
        } else if (token === '--output' || token === '-o') {
            args.output = readValue(token);
        } else if (token.startsWith('--output=')) {
            args.output = token.slice('--output='.length);
        } else if (token === '--output-dir') {
            args.outputDir = readValue('--output-dir');
        } else if (token.startsWith('--output-dir=')) {
            args.outputDir = token.slice('--output-dir='.length);
        } else if (token === '--config') {
            args.config = readValue('--config');
        } else if (token.startsWith('--config=')) {
            args.config = token.slice('--config='.length);
        } else if (token === '--quality') {
            args.quality = readValue('--quality');
        } else if (token.startsWith('--quality=')) {
            args.quality = token.slice('--quality='.length);
        } else if (token === '--timeout') {
            const val = Number(readValue('--timeout'));
            if (!Number.isFinite(val) || val <= 0) {
                throw new CLIError('INVALID_ARGS', `Invalid --timeout value: ${val}`, EXIT_CODES.VALIDATION_ERROR);
            }
            args.timeout = val;
        } else if (token.startsWith('--timeout=')) {
            const val = Number(token.slice('--timeout='.length));
            if (!Number.isFinite(val) || val <= 0) {
                throw new CLIError('INVALID_ARGS', `Invalid --timeout value: ${val}`, EXIT_CODES.VALIDATION_ERROR);
            }
            args.timeout = val;
        } else if (token === '--jobs') {
            const val = parseInt(readValue('--jobs'), 10);
            if (!Number.isFinite(val) || val < 1) {
                throw new CLIError('INVALID_ARGS', `Invalid --jobs value: ${val}`, EXIT_CODES.VALIDATION_ERROR);
            }
            args.jobs = val;
        } else if (token.startsWith('--jobs=')) {
            const val = parseInt(token.slice('--jobs='.length), 10);
            if (!Number.isFinite(val) || val < 1) {
                throw new CLIError('INVALID_ARGS', `Invalid --jobs value: ${val}`, EXIT_CODES.VALIDATION_ERROR);
            }
            args.jobs = val;
        } else if (token.startsWith('-')) {
            throw new CLIError('INVALID_ARGS', `Unknown option: ${token}`, EXIT_CODES.VALIDATION_ERROR);
        } else {
            positional.push(token);
        }
    }

    if (positional.length > 0) {
        args.subcommand = positional[0];
    }

    return args;
}

/**
 * Locate ffmpeg & ffprobe binaries
 */
function resolveFFmpegBinaries(taskId = null) {
    const isWin = process.platform === 'win32';
    const exeSuffix = isWin ? '.exe' : '';
    const platformFolder = isWin ? 'windows' : (process.platform === 'darwin' ? 'darwin' : 'linux');
    const repoRoot = path.resolve(__dirname, '..');

    const candidateDirs = [
        path.join(repoRoot, 'vendor', platformFolder, 'ffmpeg', 'bin'),
        path.join(repoRoot, 'vendor', platformFolder, 'ffmpeg'),
        path.join(repoRoot, 'vendor', 'ffmpeg', 'bin'),
        path.join(repoRoot, 'vendor', 'ffmpeg'),
        process.resourcesPath ? path.join(process.resourcesPath, 'vendor', 'ffmpeg', 'bin') : null,
        process.resourcesPath ? path.join(process.resourcesPath, 'vendor', 'ffmpeg') : null,
        path.join(repoRoot, '..', 'vendor', 'ffmpeg', 'bin'),
        path.join(repoRoot, '..', 'vendor', 'ffmpeg'),
        (isWin && process.env.LOCALAPPDATA)
            ? path.join(process.env.LOCALAPPDATA, 'Programs', 'videokit', 'resources', 'vendor', 'ffmpeg', 'bin')
            : null,
        (isWin && process.env.LOCALAPPDATA)
            ? path.join(process.env.LOCALAPPDATA, 'Programs', 'videokit', 'resources', 'vendor', 'ffmpeg')
            : null,
    ].filter(Boolean);

    function findBinary(envVar, baseName) {
        if (process.env[envVar] && fs.existsSync(process.env[envVar])) {
            return process.env[envVar];
        }
        for (const dir of candidateDirs) {
            const full = path.join(dir, `${baseName}${exeSuffix}`);
            if (fs.existsSync(full)) {
                return full;
            }
        }
        const probe = spawnSync(`${baseName}${exeSuffix}`, ['-version'], {
            stdio: 'ignore',
            timeout: 5000,
            windowsHide: true,
        });
        if (!probe.error && probe.status === 0) {
            return `${baseName}${exeSuffix}`;
        }
        throw new CLIError(
            'FFMPEG_NOT_FOUND',
            `Required binary '${baseName}' was not found in vendor directories or system PATH`,
            EXIT_CODES.RESOURCE_NOT_FOUND,
            taskId
        );
    }

    return {
        ffmpeg: findBinary('FFMPEG_PATH', 'ffmpeg'),
        ffprobe: findBinary('FFPROBE_PATH', 'ffprobe'),
    };
}

/**
 * Probe media file duration (seconds) using ffprobe
 */
function probeMediaDuration(ffprobeBin, filePath) {
    const res = spawnSync(
        ffprobeBin,
        [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath,
        ],
        { encoding: 'utf-8', timeout: 15000, windowsHide: true }
    );
    if (!res.error && res.status === 0) {
        const val = parseFloat(String(res.stdout || '').trim());
        if (Number.isFinite(val) && val > 0) return val;
    }
    const streamRes = spawnSync(
        ffprobeBin,
        [
            '-v', 'error',
            '-show_entries', 'stream=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath,
        ],
        { encoding: 'utf-8', timeout: 15000, windowsHide: true }
    );
    if (!streamRes.error && streamRes.status === 0) {
        const lines = String(streamRes.stdout || '').trim().split(/\r?\n/);
        for (const line of lines) {
            const val = parseFloat(line.trim());
            if (Number.isFinite(val) && val > 0) return val;
        }
    }
    return 0;
}

/**
 * Recursively collect all font files (.ttf, .otf, .ttc) in a directory
 */
function collectFontFiles(dir, out = []) {
    if (!dir || !fs.existsSync(dir)) return out;
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectFontFiles(fullPath, out);
        } else if (/\.(ttf|otf|ttc)$/i.test(entry.name)) {
            out.push(fullPath);
        }
    }
    return out;
}

function normalizeFontKey(str) {
    return String(str || '')
        .toLowerCase()
        .replace(/[-_\s]+/g, '')
        .replace(/\.(ttf|otf|ttc)$/i, '')
        .replace(/(regular|bold|italic|light|medium|black|variablefont.*|wght.*)$/i, '');
}

/**
 * Resolve font family to bundled or system font files.
 * Throws CLIError('FONT_NOT_FOUND', ..., 3) if the requested font does not exist.
 */
function resolveFontFamily(fontFamilyRaw, taskId = null) {
    const requestedFamily = String(fontFamilyRaw || 'Arial').trim() || 'Arial';
    const requestedKey = normalizeFontKey(requestedFamily);
    const repoRoot = path.resolve(__dirname, '..');

    const bundledDirs = [
        path.join(repoRoot, 'resources', 'fonts'),
        path.join(repoRoot, 'assets', 'fonts'),
        process.resourcesPath ? path.join(process.resourcesPath, 'fonts') : null,
        process.resourcesPath ? path.join(process.resourcesPath, 'resources', 'fonts') : null,
        process.resourcesPath ? path.join(process.resourcesPath, 'assets', 'fonts') : null,
        path.join(repoRoot, '..', 'resources', 'fonts'),
        path.join(repoRoot, '..', 'assets', 'fonts'),
    ].filter(Boolean);

    const bundledFiles = [];
    for (const d of bundledDirs) {
        collectFontFiles(d, bundledFiles);
    }

    const matchedFiles = [];
    for (const file of bundledFiles) {
        const baseName = path.basename(file);
        const parentName = path.basename(path.dirname(file));
        if (
            normalizeFontKey(baseName) === requestedKey ||
            normalizeFontKey(parentName) === requestedKey ||
            baseName.toLowerCase().startsWith(requestedFamily.toLowerCase().replace(/\s+/g, '')) ||
            parentName.toLowerCase().replace(/_/g, ' ') === requestedFamily.toLowerCase()
        ) {
            matchedFiles.push(file);
        }
    }

    if (matchedFiles.length > 0) {
        return {
            fontFamily: requestedFamily,
            fontFiles: matchedFiles,
        };
    }

    // Check system font directories
    const systemDirs = [];
    if (process.platform === 'win32') {
        const winDir = process.env.WINDIR || 'C:\\Windows';
        systemDirs.push(path.join(winDir, 'Fonts'));
        if (process.env.LOCALAPPDATA) {
            systemDirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
        }
    } else if (process.platform === 'darwin') {
        systemDirs.push('/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts'));
    } else {
        systemDirs.push(
            '/usr/share/fonts',
            '/usr/local/share/fonts',
            path.join(os.homedir(), '.local', 'share', 'fonts'),
            path.join(os.homedir(), '.fonts')
        );
    }

    const winFontAliases = {
        arial: ['arial.ttf', 'arialbd.ttf', 'arimo-regular.ttf', 'arimo-bold.ttf'],
        helvetica: ['arial.ttf', 'arimo-regular.ttf'],
        sansserif: ['arial.ttf', 'arimo-regular.ttf', 'dejavusans.ttf'],
        impact: ['impact.ttf'],
        timesnewroman: ['times.ttf', 'timesbd.ttf'],
        couriernew: ['cour.ttf', 'courbd.ttf'],
        verdana: ['verdana.ttf', 'verdanab.ttf'],
        tahoma: ['tahoma.ttf', 'tahomabd.ttf'],
        trebuchetms: ['trebuc.ttf', 'trebucbd.ttf'],
        georgia: ['georgia.ttf', 'georgiab.ttf'],
        microsoftyahei: ['msyh.ttc', 'msyhbd.ttc'],
        simhei: ['simhei.ttf'],
    };

    const aliasCandidates = winFontAliases[requestedKey] || [];

    for (const sysDir of systemDirs) {
        if (!fs.existsSync(sysDir)) continue;
        // Fast check for direct alias files in systemDirs root
        for (const alias of aliasCandidates) {
            const candidate = path.join(sysDir, alias);
            if (fs.existsSync(candidate)) {
                matchedFiles.push(candidate);
            }
        }
        if (matchedFiles.length > 0) break;

        const sysFiles = collectFontFiles(sysDir);
        for (const file of sysFiles) {
            const base = path.basename(file);
            if (
                normalizeFontKey(base) === requestedKey ||
                aliasCandidates.includes(base.toLowerCase())
            ) {
                matchedFiles.push(file);
            }
        }
        if (matchedFiles.length > 0) break;
    }

    // On Linux/macOS, also check fc-list if available
    if (matchedFiles.length === 0 && process.platform !== 'win32') {
        const fcRes = spawnSync('fc-list', [':', 'family', 'file'], {
            encoding: 'utf-8',
            timeout: 5000,
        });
        if (!fcRes.error && fcRes.status === 0 && fcRes.stdout) {
            const lines = fcRes.stdout.split(/\r?\n/);
            for (const line of lines) {
                const lower = line.toLowerCase();
                if (lower.includes(requestedFamily.toLowerCase())) {
                    const colonIdx = line.indexOf(':');
                    if (colonIdx > 0) {
                        const fileCand = line.slice(0, colonIdx).trim();
                        if (fs.existsSync(fileCand)) {
                            matchedFiles.push(fileCand);
                        }
                    }
                }
            }
        }
    }

    // Offline fallback for default Arial / Helvetica / sans-serif using bundled Arimo font
    if (matchedFiles.length === 0 && ['arial', 'helvetica', 'sans', 'sansserif'].includes(requestedKey)) {
        const arimoFiles = bundledFiles.filter(f => /arimo/i.test(path.basename(f)));
        if (arimoFiles.length > 0) {
            return {
                fontFamily: requestedFamily,
                fontFiles: arimoFiles,
            };
        }
    }

    if (matchedFiles.length === 0) {
        throw new CLIError(
            'FONT_NOT_FOUND',
            `Font family '${requestedFamily}' was not found in bundled fonts or system fonts`,
            EXIT_CODES.RESOURCE_NOT_FOUND,
            taskId
        );
    }

    return {
        fontFamily: requestedFamily,
        fontFiles: matchedFiles,
    };
}

/**
 * Parse SRT content (handles UTF-8 BOM, CRLF, LF)
 */
function parseSRTContent(rawContent, taskId = null) {
    const clean = String(rawContent || '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();

    if (!clean) {
        throw new CLIError('INVALID_SRT', 'SRT file is empty', EXIT_CODES.VALIDATION_ERROR, taskId);
    }

    const blocks = clean.split(/\n{2,}/);
    const segments = [];
    const timeRe = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

    const toSec = (h, m, s, ms) =>
        parseInt(h, 10) * 3600 +
        parseInt(m, 10) * 60 +
        parseInt(s, 10) +
        parseInt(String(ms).padEnd(3, '0'), 10) / 1000;

    for (const block of blocks) {
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) continue;

        let timeLineIdx = 0;
        if (!timeRe.test(lines[0]) && lines.length >= 2 && timeRe.test(lines[1])) {
            timeLineIdx = 1;
        }
        const match = lines[timeLineIdx].match(timeRe);
        if (!match) continue;

        const start = toSec(match[1], match[2], match[3], match[4]);
        const end = toSec(match[5], match[6], match[7], match[8]);
        const text = lines.slice(timeLineIdx + 1).join('\n');

        segments.push({ start, end, text });
    }

    if (segments.length === 0) {
        throw new CLIError('INVALID_SRT', 'No valid subtitle entries found in SRT file', EXIT_CODES.VALIDATION_ERROR, taskId);
    }

    return segments;
}

/**
 * Resolve a path from task JSON relative to taskDir, rejecting '..' path traversal.
 */
function resolveTaskPath(rawPath, taskDir, fieldName, taskId = null) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
        throw new CLIError('INVALID_SCHEMA', `Invalid path for field '${fieldName}'`, EXIT_CODES.VALIDATION_ERROR, taskId);
    }
    const trimmed = rawPath.trim();
    if (!path.isAbsolute(trimmed)) {
        const parts = trimmed.split(/[\\/]+/);
        if (parts.includes('..')) {
            throw new CLIError(
                'PATH_TRAVERSAL',
                `Relative path in '${fieldName}' cannot contain '..' traversal: ${trimmed}`,
                EXIT_CODES.VALIDATION_ERROR,
                taskId
            );
        }
        const resolved = path.resolve(taskDir, trimmed);
        const rel = path.relative(taskDir, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new CLIError(
                'PATH_TRAVERSAL',
                `Path '${trimmed}' escapes task directory '${taskDir}'`,
                EXIT_CODES.VALIDATION_ERROR,
                taskId
            );
        }
        return resolved;
    }
    return path.resolve(trimmed);
}

function assertFileExistsAndNonEmpty(filePath, fieldName, taskId = null) {
    if (!fs.existsSync(filePath)) {
        throw new CLIError(
            'FILE_NOT_FOUND',
            `File not found for '${fieldName}': ${filePath}`,
            EXIT_CODES.RESOURCE_NOT_FOUND,
            taskId
        );
    }
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        throw new CLIError(
            'FILE_NOT_FOUND',
            `Cannot stat file for '${fieldName}': ${filePath}`,
            EXIT_CODES.RESOURCE_NOT_FOUND,
            taskId
        );
    }
    if (!stat.isFile() || stat.size === 0) {
        throw new CLIError(
            'FILE_NOT_FOUND',
            `File is empty or not a regular file for '${fieldName}': ${filePath}`,
            EXIT_CODES.RESOURCE_NOT_FOUND,
            taskId
        );
    }
}

/**
 * Validate a task JSON file and return normalized task plan.
 */
function validateTaskFile(taskFilePath, cliArgs = {}) {
    const absTaskPath = path.resolve(taskFilePath);
    if (!fs.existsSync(absTaskPath)) {
        throw new CLIError(
            'FILE_NOT_FOUND',
            `Task file not found: ${absTaskPath}`,
            EXIT_CODES.RESOURCE_NOT_FOUND
        );
    }

    let rawJson;
    try {
        rawJson = fs.readFileSync(absTaskPath, 'utf-8').replace(/^\uFEFF/, '');
    } catch (err) {
        throw new CLIError('FILE_NOT_FOUND', `Failed to read task file: ${err.message}`, EXIT_CODES.RESOURCE_NOT_FOUND);
    }

    let task;
    try {
        task = JSON.parse(rawJson);
    } catch (err) {
        throw new CLIError('INVALID_JSON', `Invalid JSON in task file ${absTaskPath}: ${err.message}`, EXIT_CODES.VALIDATION_ERROR);
    }

    if (!task || typeof task !== 'object' || Array.isArray(task)) {
        throw new CLIError('INVALID_SCHEMA', 'Task JSON root must be an object', EXIT_CODES.VALIDATION_ERROR);
    }

    const taskDir = path.dirname(absTaskPath);
    const taskId = String(task.id || path.basename(absTaskPath, path.extname(absTaskPath)) || '0001');

    // Validate dimensions (only 720x1280 or 1080x1920 allowed per §3.2)
    const width = task.width !== undefined ? Number(task.width) : 720;
    const height = task.height !== undefined ? Number(task.height) : 1280;
    const validDims = (width === 720 && height === 1280) || (width === 1080 && height === 1920);
    if (!Number.isInteger(width) || !Number.isInteger(height) || !validDims) {
        throw new CLIError(
            'INVALID_DIMENSIONS',
            `Invalid dimensions ${width}x${height}; only 720x1280 and 1080x1920 are supported`,
            EXIT_CODES.VALIDATION_ERROR,
            taskId
        );
    }

    // Validate fps (only 24, 25, 30 allowed per §3.2)
    const fps = task.fps !== undefined ? Number(task.fps) : 30;
    if (![24, 25, 30].includes(fps)) {
        throw new CLIError(
            'INVALID_FPS',
            `Invalid fps '${task.fps}'; only 24, 25, or 30 are supported`,
            EXIT_CODES.VALIDATION_ERROR,
            taskId
        );
    }

    // Validate quality
    const quality = String(cliArgs.quality || task.quality || 'medium').toLowerCase();
    if (!['high', 'medium', 'low'].includes(quality)) {
        throw new CLIError(
            'INVALID_ARGS',
            `Invalid quality '${quality}'; must be high, medium, or low`,
            EXIT_CODES.VALIDATION_ERROR,
            taskId
        );
    }

    // Validate background sources
    const hasBgPath = typeof task.bgPath === 'string' && task.bgPath.trim() !== '';
    const hasBgClipPool = Array.isArray(task.bgClipPool) && task.bgClipPool.length > 0;
    const hasContentVideo = typeof task.contentVideoPath === 'string' && task.contentVideoPath.trim() !== '';

    if (!hasBgPath && !hasBgClipPool && !hasContentVideo) {
        throw new CLIError(
            'INVALID_SCHEMA',
            'Task must provide at least one of bgPath, bgClipPool, or contentVideoPath',
            EXIT_CODES.VALIDATION_ERROR,
            taskId
        );
    }

    const bgPath = hasBgPath ? resolveTaskPath(task.bgPath, taskDir, 'bgPath', taskId) : null;
    if (bgPath) assertFileExistsAndNonEmpty(bgPath, 'bgPath', taskId);

    const contentVideoPath = hasContentVideo
        ? resolveTaskPath(task.contentVideoPath, taskDir, 'contentVideoPath', taskId)
        : null;
    if (contentVideoPath) assertFileExistsAndNonEmpty(contentVideoPath, 'contentVideoPath', taskId);

    const bgClipPool = hasBgClipPool
        ? task.bgClipPool.map((p, idx) => {
            const resolved = resolveTaskPath(p, taskDir, `bgClipPool[${idx}]`, taskId);
            assertFileExistsAndNonEmpty(resolved, `bgClipPool[${idx}]`, taskId);
            return resolved;
        })
        : [];

    // Validate audio & BGM
    const audioPath = (typeof task.audioPath === 'string' && task.audioPath.trim())
        ? resolveTaskPath(task.audioPath, taskDir, 'audioPath', taskId)
        : null;
    if (audioPath) assertFileExistsAndNonEmpty(audioPath, 'audioPath', taskId);

    const bgmPath = (typeof task.bgmPath === 'string' && task.bgmPath.trim())
        ? resolveTaskPath(task.bgmPath, taskDir, 'bgmPath', taskId)
        : null;
    if (bgmPath) assertFileExistsAndNonEmpty(bgmPath, 'bgmPath', taskId);

    // Validate segments / srtPath
    let segments = [];
    const srtPath = (typeof task.srtPath === 'string' && task.srtPath.trim())
        ? resolveTaskPath(task.srtPath, taskDir, 'srtPath', taskId)
        : null;

    if (Array.isArray(task.segments) && task.segments.length > 0) {
        segments = task.segments.map((seg, idx) => {
            if (!seg || typeof seg !== 'object') {
                throw new CLIError('INVALID_SCHEMA', `segments[${idx}] must be an object`, EXIT_CODES.VALIDATION_ERROR, taskId);
            }
            const start = Number(seg.start);
            const end = Number(seg.end);
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end) {
                throw new CLIError(
                    'INVALID_SEGMENT_TIME',
                    `Invalid segment time at segments[${idx}]: start=${seg.start}, end=${seg.end} (must satisfy 0 <= start < end)`,
                    EXIT_CODES.VALIDATION_ERROR,
                    taskId
                );
            }
            return {
                start,
                end,
                text: String(seg.text ?? ''),
                words: Array.isArray(seg.words) ? seg.words : undefined,
            };
        });
    } else if (srtPath) {
        assertFileExistsAndNonEmpty(srtPath, 'srtPath', taskId);
        const srtContent = fs.readFileSync(srtPath, 'utf-8');
        segments = parseSRTContent(srtContent, taskId);
        for (let idx = 0; idx < segments.length; idx++) {
            const seg = segments[idx];
            if (!Number.isFinite(seg.start) || !Number.isFinite(seg.end) || seg.start < 0 || seg.start >= seg.end) {
                throw new CLIError(
                    'INVALID_SEGMENT_TIME',
                    `Invalid SRT segment time at index ${idx + 1}: start=${seg.start}, end=${seg.end}`,
                    EXIT_CODES.VALIDATION_ERROR,
                    taskId
                );
            }
        }
    }

    // Check segment ordering and overlap
    for (let i = 1; i < segments.length; i++) {
        const prev = segments[i - 1];
        const curr = segments[i];
        if (curr.start < prev.end - 0.001) {
            throw new CLIError(
                'SEGMENT_OVERLAP',
                `Subtitle segment ${i} (start=${curr.start}s) overlaps with previous segment ${i - 1} (end=${prev.end}s)`,
                EXIT_CODES.VALIDATION_ERROR,
                taskId
            );
        }
    }

    // Check ffmpeg/ffprobe availability
    const binaries = resolveFFmpegBinaries(taskId);

    // Check font availability
    const subConfig = (task.subtitle && typeof task.subtitle === 'object') ? task.subtitle : {};
    const fontInfo = resolveFontFamily(subConfig.font_family || 'Arial', taskId);

    // Compute target duration
    const maxSegEnd = segments.reduce((m, s) => Math.max(m, s.end), 0);
    let probedAudioDuration = 0;
    if (audioPath) {
        probedAudioDuration = probeMediaDuration(binaries.ffprobe, audioPath);
    }

    let targetDuration = Number(task.duration);
    if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
        if (probedAudioDuration > 0) {
            targetDuration = probedAudioDuration;
        } else if (maxSegEnd > 0) {
            targetDuration = maxSegEnd;
        } else {
            targetDuration = 10;
        }
    }
    targetDuration = Math.round(targetDuration * 1000) / 1000;

    // Resolve output path
    // Priority: CLI --output > CLI --output-dir > task.output > ./out/<id>.mp4
    let outputPath = null;
    if (cliArgs.output) {
        outputPath = path.resolve(cliArgs.output);
    } else if (cliArgs.outputDir) {
        const outDir = path.resolve(cliArgs.outputDir);
        const fileName = (typeof task.output === 'string' && task.output.trim())
            ? path.basename(task.output.trim())
            : `${taskId}.mp4`;
        outputPath = path.join(outDir, fileName);
    } else if (typeof task.output === 'string' && task.output.trim()) {
        outputPath = resolveTaskPath(task.output, taskDir, 'output', taskId);
    } else {
        const outDir = path.resolve('./out');
        outputPath = path.join(outDir, `${taskId}.mp4`);
    }

    return {
        taskId,
        taskFilePath: absTaskPath,
        taskDir,
        width,
        height,
        fps,
        quality,
        motion: String(task.motion || 'none').toLowerCase(),
        bgPath,
        bgClipPool,
        contentVideoPath,
        audioPath,
        bgmPath,
        srtPath,
        segments,
        subtitle: subConfig,
        fontInfo,
        binaries,
        targetDuration,
        outputPath,
    };
}

/**
 * Generate ASS subtitle content for a validated task plan.
 */
function buildTaskASS(plan) {
    const { width, height, segments, subtitle: sub, fontInfo, targetDuration } = plan;
    const scale = width / 1080;

    const baseFontSize = Number(sub.fontsize) > 0 ? Number(sub.fontsize) : 74;
    const scaledFontSize = Math.max(12, Math.round(baseFontSize * scale));
    const baseBorderW = sub.border_width !== undefined ? Number(sub.border_width) : 3;
    const scaledBorderW = Math.max(0, Math.round(baseBorderW * scale * 10) / 10);
    const baseShadowBlur = sub.shadow_blur !== undefined ? Number(sub.shadow_blur) : 0;
    const scaledShadowBlur = Math.max(0, Math.round(baseShadowBlur * scale * 10) / 10);
    const scaledSpacing = sub.letter_spacing !== undefined ? Math.round(Number(sub.letter_spacing) * scale * 10) / 10 : 0;

    const colorText = sub.color_text || sub.primary_color || '#FFFFFF';
    const colorOutline = sub.color_outline || sub.outline_color || '#000000';
    const colorHigh = sub.color_high || sub.keyword_color || (sub.highlight === 'word-by-word' ? '#FFD700' : '');
    const karaokeHighlight = sub.karaoke_highlight !== undefined
        ? Boolean(sub.karaoke_highlight)
        : (sub.highlight ? sub.highlight === 'word-by-word' : Boolean(colorHigh));

    const styleObj = {
        ...sub,
        font_family: fontInfo.fontFamily,
        fontsize: scaledFontSize,
        bold: sub.bold !== false,
        italic: Boolean(sub.italic),
        color_text: colorText,
        color_outline: colorOutline,
        color_high: colorHigh,
        karaoke_highlight: karaokeHighlight,
        use_stroke: sub.use_stroke !== false,
        border_width: scaledBorderW,
        shadow_blur: scaledShadowBlur,
        letter_spacing: scaledSpacing,
        pos_x: sub.pos_x !== undefined ? Number(sub.pos_x) : 0.5,
        pos_y: sub.pos_y !== undefined ? Number(sub.pos_y) : 0.5,
        anim_in_type: sub.anim_in_type || 'none',
        anim_out_type: sub.anim_out_type || 'none',
        credit: typeof sub.credit === 'string' ? sub.credit : '',
        credit_position: sub.credit_position || 'top-right',
    };

    const segmentsWithWords = ReelsSubtitleProcessor.srtToSegmentsWithWords(
        segments.map(s => ({ ...s, _timeUnit: 'sec' }))
    );

    return ReelsSubtitleProcessor.generateEnhancedASS(segmentsWithWords, styleObj, {
        videoW: width,
        videoH: height,
        karaokeHighlight,
        duration: targetDuration,
    });
}

function isImagePath(filePath) {
    return /\.(png|jpe?g|webp|bmp)$/i.test(String(filePath || ''));
}

/**
 * Build FFmpeg command arguments for a validated task plan.
 * Executes inside `tempDir` so ASS and fonts paths are simple relative names (`subtitles.ass`, `fonts`).
 */
function buildFFmpegArgs(plan, tmpOutputPath) {
    const {
        width,
        height,
        fps,
        quality,
        motion,
        bgPath,
        bgClipPool,
        contentVideoPath,
        audioPath,
        bgmPath,
        segments,
        subtitle,
        targetDuration,
        binaries,
    } = plan;

    const qualityMap = {
        high: { crf: '15', preset: 'slow' },
        medium: { crf: '18', preset: 'medium' },
        low: { crf: '23', preset: 'fast' },
    };
    const q = qualityMap[quality] || qualityMap.medium;
    const durStr = targetDuration.toFixed(3);

    const inputs = ['-y'];
    const filterParts = [];
    let inputIdx = 0;

    const hasAssOverlay = segments.length > 0 || Boolean(subtitle && subtitle.credit);
    const assFilter = hasAssOverlay ? `,ass=filename=subtitles.ass:fontsdir=fonts` : '';

    // 1. Visual Inputs
    if (bgClipPool && bgClipPool.length > 0) {
        // Repeat clips from bgClipPool until total duration >= targetDuration
        const expandedClips = [];
        let accDur = 0;
        let safetyCounter = 0;
        while (accDur < targetDuration && safetyCounter < 200) {
            for (const clipPath of bgClipPool) {
                expandedClips.push(clipPath);
                const clipDur = isImagePath(clipPath)
                    ? 5.0
                    : (probeMediaDuration(binaries.ffprobe, clipPath) || 5.0);
                accDur += clipDur;
                safetyCounter++;
                if (accDur >= targetDuration || safetyCounter >= 200) break;
            }
        }

        const concatLabels = [];
        for (let i = 0; i < expandedClips.length; i++) {
            const clipPath = expandedClips[i];
            if (isImagePath(clipPath)) {
                inputs.push('-loop', '1', '-framerate', String(fps), '-t', '5', '-i', clipPath);
            } else {
                inputs.push('-i', clipPath);
            }
            const idx = inputIdx++;
            filterParts.push(
                `[${idx}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p[vclip${i}]`
            );
            concatLabels.push(`[vclip${i}]`);
        }

        filterParts.push(
            `${concatLabels.join('')}concat=n=${expandedClips.length}:v=1:a=0,trim=duration=${durStr},setpts=PTS-STARTPTS${assFilter}[vout]`
        );
    } else {
        const primaryVisual = contentVideoPath || bgPath;
        if (isImagePath(primaryVisual)) {
            inputs.push('-loop', '1', '-framerate', String(fps), '-t', durStr, '-i', primaryVisual);
            const idx = inputIdx++;
            let motionFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps}`;
            if (motion === 'zoom_in' || motion === 'ken_burns') {
                const sw = Math.round(width * 1.16);
                const sh = Math.round(height * 1.16);
                motionFilter = `scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},crop=w=${width}:h=${height}:x='(iw-ow)/2':y='(ih-oh)/2',setsar=1,fps=${fps}`;
            } else if (motion === 'pan_up') {
                const sw = Math.round(width * 1.12);
                const sh = Math.round(height * 1.12);
                motionFilter = `scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},crop=w=${width}:h=${height}:x='(iw-ow)/2':y='(ih-oh)*max(0,1-t/${durStr})',setsar=1,fps=${fps}`;
            } else if (motion === 'pan_down') {
                const sw = Math.round(width * 1.12);
                const sh = Math.round(height * 1.12);
                motionFilter = `scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},crop=w=${width}:h=${height}:x='(iw-ow)/2':y='(ih-oh)*min(1,t/${durStr})',setsar=1,fps=${fps}`;
            }
            filterParts.push(`[${idx}:v]${motionFilter},format=yuv420p${assFilter}[vout]`);
        } else {
            inputs.push('-stream_loop', '-1', '-t', durStr, '-i', primaryVisual);
            const idx = inputIdx++;
            filterParts.push(
                `[${idx}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p${assFilter}[vout]`
            );
        }
    }

    // 2. Audio Inputs
    if (audioPath && bgmPath) {
        inputs.push('-i', audioPath);
        const voiceIdx = inputIdx++;
        inputs.push('-stream_loop', '-1', '-t', durStr, '-i', bgmPath);
        const bgmIdx = inputIdx++;
        filterParts.push(
            `[${voiceIdx}:a]aresample=48000,apad=whole_dur=${durStr},atrim=0:${durStr},asetpts=PTS-STARTPTS[voice];` +
            `[${bgmIdx}:a]aresample=48000,volume=0.20,atrim=0:${durStr},asetpts=PTS-STARTPTS[bgm];` +
            `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`
        );
    } else if (audioPath) {
        inputs.push('-i', audioPath);
        const voiceIdx = inputIdx++;
        filterParts.push(
            `[${voiceIdx}:a]aresample=48000,apad=whole_dur=${durStr},atrim=0:${durStr},asetpts=PTS-STARTPTS[aout]`
        );
    } else if (bgmPath) {
        inputs.push('-stream_loop', '-1', '-t', durStr, '-i', bgmPath);
        const bgmIdx = inputIdx++;
        filterParts.push(
            `[${bgmIdx}:a]aresample=48000,atrim=0:${durStr},asetpts=PTS-STARTPTS[aout]`
        );
    } else {
        inputs.push('-f', 'lavfi', '-t', durStr, '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        const silentIdx = inputIdx++;
        filterParts.push(`[${silentIdx}:a]atrim=0:${durStr},asetpts=PTS-STARTPTS[aout]`);
    }

    const filterComplex = filterParts.join(';');

    return [
        ...inputs,
        '-filter_complex', filterComplex,
        '-map', '[vout]',
        '-map', '[aout]',
        '-c:v', 'libx264',
        '-preset', q.preset,
        '-crf', q.crf,
        '-pix_fmt', 'yuv420p',
        '-r', String(fps),
        '-c:a', 'aac',
        '-ar', '48000',
        '-ac', '2',
        '-b:a', '192k',
        '-movflags', '+faststart',
        '-t', durStr,
        '-f', 'mp4',
        tmpOutputPath,
    ];
}

/**
 * Render a single Reels task
 */
async function renderReelsTask(taskFilePath, cliArgs = {}, isBatch = false) {
    const plan = validateTaskFile(taskFilePath, cliArgs);
    const { taskId, width, height, targetDuration, outputPath, binaries, fontInfo } = plan;

    const outDir = path.dirname(outputPath);
    fs.mkdirSync(outDir, { recursive: true });

    // Check existing output file
    if (fs.existsSync(outputPath)) {
        const stat = fs.statSync(outputPath);
        if (stat.size > 0) {
            if (cliArgs.skipExisting) {
                const skippedResult = {
                    status: 'ok',
                    skipped: true,
                    task: taskId,
                    output: outputPath,
                    duration: targetDuration,
                    width,
                    height,
                };
                if (!isBatch) {
                    emitStdoutJson(skippedResult);
                }
                return { ...skippedResult, status: 'skipped' };
            }
            if (!cliArgs.overwrite && !cliArgs.dryRun) {
                throw new CLIError(
                    'OUTPUT_EXISTS',
                    `Output file already exists: ${outputPath} (pass --overwrite to replace or --skip-existing to skip)`,
                    EXIT_CODES.GENERAL_ERROR,
                    taskId
                );
            }
        }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `videokit-cli-${taskId}-`));
    const fontsDir = path.join(tempDir, 'fonts');
    fs.mkdirSync(fontsDir, { recursive: true });

    for (const fontFile of fontInfo.fontFiles) {
        const destFont = path.join(fontsDir, path.basename(fontFile));
        if (!fs.existsSync(destFont)) {
            try {
                fs.copyFileSync(fontFile, destFont);
            } catch {
                // Ignore copy errors if unreadable system font
            }
        }
    }

    const assContent = buildTaskASS(plan);
    const assPath = path.join(tempDir, 'subtitles.ass');
    fs.writeFileSync(assPath, assContent, 'utf-8');

    if (cliArgs.keepTemp) {
        logStderr(`[videokit-cli] Kept temp directory: ${tempDir}`);
        logStderr(`[videokit-cli] Generated ASS file: ${assPath}`);
    }

    const tmpOutputPath = `${outputPath}.tmp`;
    const ffmpegArgs = buildFFmpegArgs(plan, tmpOutputPath);

    if (cliArgs.dryRun) {
        logStderr(`[videokit-cli] [dry-run] ${binaries.ffmpeg} ${ffmpegArgs.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
        if (!cliArgs.keepTemp) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }
        const dryResult = {
            status: 'ok',
            dry_run: true,
            task: taskId,
            output: outputPath,
            duration: targetDuration,
            width,
            height,
        };
        if (!isBatch) {
            emitStdoutJson(dryResult);
        }
        return dryResult;
    }

    try {
        if (fs.existsSync(tmpOutputPath)) {
            fs.unlinkSync(tmpOutputPath);
        }
    } catch {}

    return new Promise((resolve, reject) => {
        let timedOut = false;
        let lastProgressPercent = -1;
        let stderrTail = '';

        const child = spawn(binaries.ffmpeg, ffmpegArgs, {
            cwd: tempDir,
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
        });

        const timeoutMs = Math.max(1, Number(cliArgs.timeout || 600)) * 1000;
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                child.kill('SIGKILL');
            } catch {}
        }, timeoutMs);

        if (!cliArgs.quiet) {
            emitStdoutJson({ status: 'progress', task: taskId, percent: 0 });
            lastProgressPercent = 0;
        }

        child.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf-8');
            stderrTail = (stderrTail + text).slice(-4000);

            if (!cliArgs.quiet && targetDuration > 0) {
                const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
                if (timeMatch) {
                    const sec =
                        parseInt(timeMatch[1], 10) * 3600 +
                        parseInt(timeMatch[2], 10) * 60 +
                        parseFloat(timeMatch[3]);
                    const pct = Math.min(99, Math.max(0, Math.floor((sec / targetDuration) * 100)));
                    if (pct >= lastProgressPercent + 10) {
                        lastProgressPercent = pct;
                        emitStdoutJson({ status: 'progress', task: taskId, percent: pct });
                    }
                }
            }
        });

        const cleanupTemp = () => {
            if (!cliArgs.keepTemp) {
                try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
            }
        };

        const cleanupTmpOutput = () => {
            try {
                if (fs.existsSync(tmpOutputPath)) {
                    fs.unlinkSync(tmpOutputPath);
                }
            } catch {}
        };

        child.on('error', (err) => {
            clearTimeout(timer);
            cleanupTmpOutput();
            cleanupTemp();
            reject(new CLIError('RENDER_FAILED', `FFmpeg spawn error: ${err.message}`, EXIT_CODES.RENDER_ERROR, taskId));
        });

        child.on('close', (code) => {
            clearTimeout(timer);

            if (timedOut) {
                cleanupTmpOutput();
                cleanupTemp();
                return reject(
                    new CLIError(
                        'RENDER_TIMEOUT',
                        `FFmpeg render timed out after ${cliArgs.timeout || 600}s`,
                        EXIT_CODES.RENDER_ERROR,
                        taskId
                    )
                );
            }

            if (code !== 0) {
                cleanupTmpOutput();
                cleanupTemp();
                const lastLines = stderrTail.trim().split(/\r?\n/).slice(-5).join(' | ');
                return reject(
                    new CLIError(
                        'RENDER_FAILED',
                        `FFmpeg exited with code ${code}: ${lastLines}`,
                        EXIT_CODES.RENDER_ERROR,
                        taskId
                    )
                );
            }

            if (!fs.existsSync(tmpOutputPath) || fs.statSync(tmpOutputPath).size === 0) {
                cleanupTmpOutput();
                cleanupTemp();
                return reject(
                    new CLIError(
                        'RENDER_FAILED',
                        'FFmpeg produced an empty or missing output file',
                        EXIT_CODES.RENDER_ERROR,
                        taskId
                    )
                );
            }

            try {
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
                fs.renameSync(tmpOutputPath, outputPath);
            } catch (renameErr) {
                cleanupTmpOutput();
                cleanupTemp();
                return reject(
                    new CLIError(
                        'RENDER_FAILED',
                        `Failed to finalize output file ${outputPath}: ${renameErr.message}`,
                        EXIT_CODES.RENDER_ERROR,
                        taskId
                    )
                );
            }

            cleanupTemp();

            if (!cliArgs.quiet && lastProgressPercent < 100) {
                emitStdoutJson({ status: 'progress', task: taskId, percent: 100 });
            }

            const actualDuration = probeMediaDuration(binaries.ffprobe, outputPath) || targetDuration;
            const finalResult = {
                status: 'ok',
                output: outputPath,
                duration: Math.round(actualDuration * 100) / 100,
                width,
                height,
            };

            if (!isBatch) {
                emitStdoutJson(finalResult);
            }

            resolve({
                ...finalResult,
                task: taskId,
            });
        });
    });
}

/**
 * Run batch Reels tasks from a directory or batch manifest JSON file
 */
async function runBatchReels(batchInput, cliArgs = {}) {
    const absBatch = path.resolve(batchInput);
    if (!fs.existsSync(absBatch)) {
        throw new CLIError('FILE_NOT_FOUND', `Batch path not found: ${absBatch}`, EXIT_CODES.RESOURCE_NOT_FOUND);
    }

    const stat = fs.statSync(absBatch);
    let taskFiles = [];
    let batchId = new Date().toISOString().slice(0, 10) + '-batch';

    if (stat.isDirectory()) {
        batchId = path.basename(absBatch) || batchId;
        const entries = fs.readdirSync(absBatch)
            .filter(name => name.toLowerCase().endsWith('.json') && name.toLowerCase() !== 'manifest.json')
            .sort();
        taskFiles = entries.map(name => path.join(absBatch, name));
    } else {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(absBatch, 'utf-8').replace(/^\uFEFF/, ''));
        } catch (err) {
            throw new CLIError('INVALID_JSON', `Invalid batch manifest JSON: ${err.message}`, EXIT_CODES.VALIDATION_ERROR);
        }
        const baseDir = path.dirname(absBatch);
        if (Array.isArray(parsed)) {
            taskFiles = parsed.map((item, idx) =>
                typeof item === 'string'
                    ? resolveTaskPath(item, baseDir, `tasks[${idx}]`)
                    : null
            ).filter(Boolean);
        } else if (parsed && typeof parsed === 'object') {
            if (parsed.batch_id) batchId = String(parsed.batch_id);
            if (Array.isArray(parsed.tasks)) {
                taskFiles = parsed.tasks.map((item, idx) => {
                    if (typeof item === 'string') {
                        return resolveTaskPath(item, baseDir, `tasks[${idx}]`);
                    }
                    if (item && typeof item === 'object' && typeof item.task === 'string') {
                        return resolveTaskPath(item.task, baseDir, `tasks[${idx}].task`);
                    }
                    throw new CLIError('INVALID_SCHEMA', `Invalid batch task entry at tasks[${idx}]`, EXIT_CODES.VALIDATION_ERROR);
                });
            }
        }
    }

    if (taskFiles.length === 0) {
        throw new CLIError('INVALID_SCHEMA', `No task JSON files found in batch input: ${absBatch}`, EXIT_CODES.VALIDATION_ERROR);
    }

    const outDir = path.resolve(cliArgs.outputDir || './out');
    fs.mkdirSync(outDir, { recursive: true });

    const results = new Array(taskFiles.length);
    let succeeded = 0;
    let failed = 0;
    let aborted = false;
    let nextIdx = 0;
    const concurrency = Math.max(1, Math.min(cliArgs.jobs || 1, taskFiles.length));

    async function worker() {
        while (!aborted) {
            const idx = nextIdx++;
            if (idx >= taskFiles.length) break;
            const taskFile = taskFiles[idx];
            const fallbackId = path.basename(taskFile, path.extname(taskFile));
            try {
                const res = await renderReelsTask(
                    taskFile,
                    { ...cliArgs, outputDir: outDir, output: null },
                    true
                );
                succeeded++;
                results[idx] = {
                    task: res.task || fallbackId,
                    status: res.status || 'ok',
                    output: res.output,
                    duration: res.duration,
                };
            } catch (err) {
                failed++;
                const taskId = (err && err.taskId) || fallbackId;
                const code = (err && err.code) || 'RENDER_FAILED';
                const message = (err && err.message) || String(err);
                emitStderrJson({
                    status: 'error',
                    code,
                    message,
                    task: taskId,
                });
                results[idx] = {
                    task: taskId,
                    status: 'error',
                    code,
                    error: message,
                };
                if (cliArgs.failFast) {
                    aborted = true;
                    break;
                }
            }
        }
    }

    const workers = [];
    for (let w = 0; w < concurrency; w++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    const finalResults = results.filter(Boolean);
    const manifestPath = path.join(outDir, 'manifest.json');
    const manifestData = {
        batch_id: batchId,
        total: taskFiles.length,
        succeeded,
        failed,
        results: finalResults,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2) + '\n', 'utf-8');

    if (failed > 0) {
        emitStdoutJson({
            status: 'error',
            manifest: manifestPath,
            total: taskFiles.length,
            succeeded,
            failed,
        });
        process.exitCode = EXIT_CODES.GENERAL_ERROR;
        return manifestData;
    }

    emitStdoutJson({
        status: 'ok',
        manifest: manifestPath,
        total: taskFiles.length,
        succeeded,
        failed: 0,
    });
    return manifestData;
}

/**
 * Load headless config file + environment variable overrides (§5)
 */
function loadHeadlessConfig(configPathRaw) {
    const defaultPath = path.join(os.homedir(), '.config', 'videokit', 'config.json');
    const configPath = configPathRaw ? path.resolve(configPathRaw) : defaultPath;
    let fileCfg = {};
    if (fs.existsSync(configPath)) {
        try {
            fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, ''));
        } catch (err) {
            throw new CLIError('INVALID_JSON', `Failed to parse config file ${configPath}: ${err.message}`, EXIT_CODES.VALIDATION_ERROR);
        }
    }

    return {
        elevenlabs_api_key: process.env.ELEVENLABS_API_KEY || fileCfg.elevenlabs_api_key || '',
        deepgram_api_key: process.env.DEEPGRAM_API_KEY || fileCfg.deepgram_api_key || '',
        gladia_api_key: process.env.GLADIA_API_KEY || fileCfg.gladia_api_key || '',
        groq_api_key: process.env.GROQ_API_KEY || fileCfg.groq_api_key || '',
        default_voice_id: fileCfg.default_voice_id || '',
        default_model: fileCfg.default_model || 'eleven_multilingual_v2',
        http_proxy: process.env.HTTP_PROXY || process.env.HTTPS_PROXY || fileCfg.http_proxy || '',
    };
}

/**
 * Run TTS subcommand (`videokit-cli tts --task <tts-task.json>`)
 */
async function runTtsCommand(taskFilePath, cliArgs = {}) {
    const absTaskPath = path.resolve(taskFilePath);
    if (!fs.existsSync(absTaskPath)) {
        throw new CLIError('FILE_NOT_FOUND', `TTS task file not found: ${absTaskPath}`, EXIT_CODES.RESOURCE_NOT_FOUND);
    }

    let task;
    try {
        task = JSON.parse(fs.readFileSync(absTaskPath, 'utf-8').replace(/^\uFEFF/, ''));
    } catch (err) {
        throw new CLIError('INVALID_JSON', `Invalid JSON in TTS task file: ${err.message}`, EXIT_CODES.VALIDATION_ERROR);
    }

    const taskId = String(task.id || path.basename(absTaskPath, path.extname(absTaskPath)) || '0001');
    const cfg = loadHeadlessConfig(cliArgs.config);
    const apiKey = task.api_key || cfg.elevenlabs_api_key;
    if (!apiKey) {
        throw new CLIError(
            'API_KEY_MISSING',
            'Missing ElevenLabs API key. Set ELEVENLABS_API_KEY or configure ~/.config/videokit/config.json',
            EXIT_CODES.API_KEY_MISSING,
            taskId
        );
    }

    const text = String(task.text || '').trim();
    const voiceId = String(task.voice_id || cfg.default_voice_id || '').trim();
    if (!text || !voiceId) {
        throw new CLIError(
            'INVALID_SCHEMA',
            'TTS task requires non-empty "text" and "voice_id"',
            EXIT_CODES.VALIDATION_ERROR,
            taskId
        );
    }

    const taskDir = path.dirname(absTaskPath);
    const outDir = path.resolve(cliArgs.outputDir || './out');
    fs.mkdirSync(outDir, { recursive: true });
    const outputAudioPath = cliArgs.output
        ? path.resolve(cliArgs.output)
        : (task.output ? resolveTaskPath(task.output, taskDir, 'output', taskId) : path.join(outDir, `${taskId}.mp3`));

    if (cliArgs.dryRun) {
        emitStdoutJson({
            status: 'ok',
            dry_run: true,
            task: taskId,
            audioPath: outputAudioPath,
        });
        return;
    }

    const modelId = task.model_id || cfg.default_model || 'eleven_multilingual_v2';
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: {
                stability: typeof task.stability === 'number' ? task.stability : 0.5,
                similarity_boost: typeof task.similarity_boost === 'number' ? task.similarity_boost : 0.75,
            },
        }),
    });

    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new CLIError(
            'TTS_API_ERROR',
            `ElevenLabs API error (${response.status}): ${errBody.slice(0, 300)}`,
            EXIT_CODES.GENERAL_ERROR,
            taskId
        );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(outputAudioPath), { recursive: true });
    fs.writeFileSync(outputAudioPath, buffer);

    emitStdoutJson({
        status: 'ok',
        task: taskId,
        audioPath: outputAudioPath,
    });
}

/**
 * Main CLI entrypoint
 */
async function runCli(argv = process.argv.slice(2)) {
    try {
        const args = parseArgs(argv);

        if (args.version) {
            process.stdout.write(`videokit-cli ${getPackageVersion()}\n`);
            return EXIT_CODES.OK;
        }

        if (args.help || (!args.subcommand && argv.length === 0)) {
            printHelp();
            return EXIT_CODES.OK;
        }

        if (!args.subcommand) {
            throw new CLIError('INVALID_ARGS', 'Missing subcommand (expected: reels, validate, or tts)', EXIT_CODES.VALIDATION_ERROR);
        }

        if (args.subcommand === 'validate') {
            if (!args.task) {
                throw new CLIError('INVALID_ARGS', 'validate subcommand requires --task <task.json>', EXIT_CODES.VALIDATION_ERROR);
            }
            const plan = validateTaskFile(args.task, args);
            emitStdoutJson({
                status: 'ok',
                valid: true,
                task: plan.taskId,
                duration: plan.targetDuration,
                width: plan.width,
                height: plan.height,
                fps: plan.fps,
                segments: plan.segments.length,
                output: plan.outputPath,
            });
            return EXIT_CODES.OK;
        }

        if (args.subcommand === 'reels') {
            if (args.batch) {
                const manifest = await runBatchReels(args.batch, args);
                return manifest.failed > 0 ? EXIT_CODES.GENERAL_ERROR : EXIT_CODES.OK;
            }
            if (!args.task) {
                throw new CLIError('INVALID_ARGS', 'reels subcommand requires --task <task.json> or --batch <dir-or-manifest.json>', EXIT_CODES.VALIDATION_ERROR);
            }
            await renderReelsTask(args.task, args, false);
            return EXIT_CODES.OK;
        }

        if (args.subcommand === 'tts') {
            if (!args.task) {
                throw new CLIError('INVALID_ARGS', 'tts subcommand requires --task <tts-task.json>', EXIT_CODES.VALIDATION_ERROR);
            }
            await runTtsCommand(args.task, args);
            return EXIT_CODES.OK;
        }

        throw new CLIError('INVALID_ARGS', `Unknown subcommand: ${args.subcommand}`, EXIT_CODES.VALIDATION_ERROR);
    } catch (err) {
        const exitCode = (err && typeof err.exitCode === 'number') ? err.exitCode : EXIT_CODES.GENERAL_ERROR;
        const code = (err && err.code) ? err.code : 'INTERNAL_ERROR';
        const message = (err && err.message) ? err.message : String(err);
        const taskId = (err && err.taskId) ? err.taskId : undefined;

        const payload = { status: 'error', code, message };
        if (taskId) payload.task = taskId;
        emitStderrJson(payload);
        process.exitCode = exitCode;
        return exitCode;
    }
}

if (require.main === module) {
    runCli().then((code) => {
        process.exit(code);
    });
}

module.exports = {
    EXIT_CODES,
    CLIError,
    parseArgs,
    validateTaskFile,
    buildTaskASS,
    buildFFmpegArgs,
    renderReelsTask,
    runBatchReels,
    runCli,
};
