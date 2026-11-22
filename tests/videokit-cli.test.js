'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliScript = path.join(repoRoot, 'bin', 'videokit-cli.cjs');
const demoDir = path.join(repoRoot, 'examples', 'cli-demo');
const { validateTaskFile, buildTaskASS, buildFFmpegArgs, parseArgs, runSelfUpdateCommand } = require('../bin/videokit-cli.cjs');
const { resolveWebRoot } = require('../bin/videokit-web-server.cjs');

function runCliProcess(args, extraEnv = {}) {
    return spawnSync(process.execPath, [cliScript, ...args], {
        cwd: repoRoot,
        env: { ...process.env, DISPLAY: '', ...extraEnv },
        encoding: 'utf-8',
        timeout: 120000,
        windowsHide: true,
    });
}

test('A1: videokit-cli --help and --version succeed without DISPLAY', () => {
    const helpRes = runCliProcess(['--help']);
    assert.equal(helpRes.status, 0);
    assert.match(helpRes.stdout, /videokit-cli v/);
    assert.match(helpRes.stdout, /Usage:/);

    const verRes = runCliProcess(['--version']);
    assert.equal(verRes.status, 0);
    assert.match(verRes.stdout.trim(), /^videokit-cli \d+\.\d+\.\d+/);
});

test('A2 & A8: Single-task render (image + inline segments) and ASS structure verification', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cli-a2-'));
    try {
        const taskPath = path.join(demoDir, 'task-0001.json');
        const outMp4 = path.join(tmpDir, 'test-0001.mp4');

        // Verify ASS generation (A8)
        const plan = validateTaskFile(taskPath, { output: outMp4 });
        const ass = buildTaskASS(plan);
        assert.match(ass, /PlayResX: 720/);
        assert.match(ass, /PlayResY: 1280/);
        assert.match(ass, /Style: Default,Anton,49,/);
        assert.match(ass, /\\pos\(360,666\)/);
        assert.match(ass, /\{\\kf\d+\\1c&H0000D7FF\}/);
        assert.match(ass, /Style: Credit,Anton,/);
        assert.match(ass, /Dialogue: 10,0:00:00\.00,0:00:03\.00,Credit,,0,0,0,,AI Created/);

        // Render MP4 (A2)
        const res = runCliProcess(['reels', '--task', taskPath, '--output', outMp4, '--quality', 'low']);
        assert.equal(res.status, 0, `Expected exit 0, stderr=${res.stderr}`);
        assert.equal(fs.existsSync(outMp4), true);
        assert.equal(fs.existsSync(`${outMp4}.tmp`), false);

        const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
        const lastJson = JSON.parse(lines[lines.length - 1]);
        assert.equal(lastJson.status, 'ok');
        assert.equal(lastJson.width, 720);
        assert.equal(lastJson.height, 1280);
        assert.ok(Math.abs(lastJson.duration - 3.0) <= 0.25, `Duration ${lastJson.duration} should be ~3.0s`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('A3: Single-task render (image + srtPath) succeeds', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cli-a3-'));
    try {
        const taskPath = path.join(demoDir, 'task-0002-srt.json');
        const outMp4 = path.join(tmpDir, 'test-0002.mp4');

        const res = runCliProcess(['reels', '--task', taskPath, '--output', outMp4, '--quiet']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);
        assert.equal(fs.existsSync(outMp4), true);

        const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
        assert.equal(lines.length, 1, '--quiet should only emit the final result JSON line');
        const payload = JSON.parse(lines[0]);
        assert.equal(payload.status, 'ok');
        assert.equal(payload.width, 720);
        assert.equal(payload.height, 1280);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('A4 & A9: Batch render generates manifest.json and --skip-existing skips completed outputs', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cli-a4-'));
    try {
        const batchPath = path.join(demoDir, 'batch-demo.json');
        const res = runCliProcess(['reels', '--batch', batchPath, '--output-dir', tmpDir, '--quality', 'low', '--quiet']);
        assert.equal(res.status, 0, `stderr=${res.stderr}`);

        const manifestPath = path.join(tmpDir, 'manifest.json');
        assert.equal(fs.existsSync(manifestPath), true);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        assert.equal(manifest.total, 2);
        assert.equal(manifest.succeeded, 2);
        assert.equal(manifest.failed, 0);
        assert.equal(fs.existsSync(path.join(tmpDir, '0001.mp4')), true);
        assert.equal(fs.existsSync(path.join(tmpDir, '0002.mp4')), true);

        // Re-run with --skip-existing (A9)
        const startMs = Date.now();
        const skipRes = runCliProcess(['reels', '--batch', batchPath, '--output-dir', tmpDir, '--skip-existing', '--quiet']);
        const elapsedMs = Date.now() - startMs;
        assert.equal(skipRes.status, 0);
        assert.ok(elapsedMs < 5000, `Expected fast skip (<5s), took ${elapsedMs}ms`);
        const skipManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        assert.equal(skipManifest.succeeded, 2);
        assert.equal(skipManifest.results[0].status, 'skipped');
        assert.equal(skipManifest.results[1].status, 'skipped');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('A5, A6, A7: Validation error codes for missing file (3), missing font (3), invalid dims/overlap/traversal (2)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cli-val-'));
    try {
        // A5: Missing material file -> exit 3, FILE_NOT_FOUND
        const missingFileTask = path.join(tmpDir, 'missing-file.json');
        fs.writeFileSync(missingFileTask, JSON.stringify({
            id: 'err-file',
            width: 720,
            height: 1280,
            bgPath: './nonexistent-bg.png',
        }));
        const resFile = runCliProcess(['validate', '--task', missingFileTask]);
        assert.equal(resFile.status, 3);
        const errFile = JSON.parse(resFile.stderr.trim().split(/\r?\n/).pop());
        assert.equal(errFile.code, 'FILE_NOT_FOUND');

        // A6: Missing font -> exit 3, FONT_NOT_FOUND
        const missingFontTask = path.join(tmpDir, 'missing-font.json');
        fs.writeFileSync(missingFontTask, JSON.stringify({
            id: 'err-font',
            width: 720,
            height: 1280,
            bgPath: path.join(demoDir, 'heaven-0001.png'),
            subtitle: { font_family: 'NonExistentFont_XYZ_999' },
        }));
        const resFont = runCliProcess(['validate', '--task', missingFontTask]);
        assert.equal(resFont.status, 3);
        const errFont = JSON.parse(resFont.stderr.trim().split(/\r?\n/).pop());
        assert.equal(errFont.code, 'FONT_NOT_FOUND');

        // A7a: Invalid dimensions -> exit 2, INVALID_DIMENSIONS
        const badDimsTask = path.join(tmpDir, 'bad-dims.json');
        fs.writeFileSync(badDimsTask, JSON.stringify({
            id: 'err-dims',
            width: 500,
            height: 500,
            bgPath: path.join(demoDir, 'heaven-0001.png'),
        }));
        const resDims = runCliProcess(['validate', '--task', badDimsTask]);
        assert.equal(resDims.status, 2);
        const errDims = JSON.parse(resDims.stderr.trim().split(/\r?\n/).pop());
        assert.equal(errDims.code, 'INVALID_DIMENSIONS');

        // A7b: Overlapping segments -> exit 2, SEGMENT_OVERLAP
        const overlapTask = path.join(tmpDir, 'overlap.json');
        fs.writeFileSync(overlapTask, JSON.stringify({
            id: 'err-overlap',
            width: 720,
            height: 1280,
            bgPath: path.join(demoDir, 'heaven-0001.png'),
            segments: [
                { start: 0, end: 2.0, text: 'First line' },
                { start: 1.5, end: 3.0, text: 'Overlapping second line' },
            ],
        }));
        const resOverlap = runCliProcess(['validate', '--task', overlapTask]);
        assert.equal(resOverlap.status, 2);
        const errOverlap = JSON.parse(resOverlap.stderr.trim().split(/\r?\n/).pop());
        assert.equal(errOverlap.code, 'SEGMENT_OVERLAP');

        // A7c: Path traversal -> exit 2, PATH_TRAVERSAL
        const traversalTask = path.join(tmpDir, 'traversal.json');
        fs.writeFileSync(traversalTask, JSON.stringify({
            id: 'err-traversal',
            width: 720,
            height: 1280,
            bgPath: '../outside.png',
        }));
        const resTrav = runCliProcess(['validate', '--task', traversalTask]);
        assert.equal(resTrav.status, 2);
        const errTrav = JSON.parse(resTrav.stderr.trim().split(/\r?\n/).pop());
        assert.equal(errTrav.code, 'PATH_TRAVERSAL');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('A10: Batch mode continues on single task failure by default and stops immediately with --fail-fast', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cli-a10-'));
    try {
        const badTask = path.join(tmpDir, '01-bad.json');
        const goodTask = path.join(demoDir, 'task-0001.json');
        fs.writeFileSync(badTask, JSON.stringify({
            id: 'bad-01',
            width: 720,
            height: 1280,
            bgPath: './missing.png',
        }));
        const batchManifest = path.join(tmpDir, 'batch.json');
        fs.writeFileSync(batchManifest, JSON.stringify({
            batch_id: 'partial-test',
            tasks: [badTask, goodTask],
        }));

        // Default: continues after badTask and completes goodTask
        const outDir1 = path.join(tmpDir, 'out1');
        const res1 = runCliProcess(['reels', '--batch', batchManifest, '--output-dir', outDir1, '--quality', 'low', '--quiet']);
        assert.notEqual(res1.status, 0);
        const m1 = JSON.parse(fs.readFileSync(path.join(outDir1, 'manifest.json'), 'utf-8'));
        assert.equal(m1.succeeded, 1);
        assert.equal(m1.failed, 1);
        assert.equal(m1.results.length, 2);

        // --fail-fast: stops after badTask
        const outDir2 = path.join(tmpDir, 'out2');
        const res2 = runCliProcess(['reels', '--batch', batchManifest, '--output-dir', outDir2, '--fail-fast', '--quiet']);
        assert.notEqual(res2.status, 0);
        const m2 = JSON.parse(fs.readFileSync(path.join(outDir2, 'manifest.json'), 'utf-8'));
        assert.equal(m2.succeeded, 0);
        assert.equal(m2.failed, 1);
        assert.equal(m2.results.length, 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('A11: --timeout kills ffmpeg and cleans up .tmp file with exit code 4', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cli-a11-'));
    try {
        const slowTask = path.join(tmpDir, 'slow.json');
        const outMp4 = path.join(tmpDir, 'slow.mp4');
        fs.writeFileSync(slowTask, JSON.stringify({
            id: 'slow-01',
            width: 1080,
            height: 1920,
            fps: 30,
            duration: 60,
            quality: 'high',
            bgPath: path.join(demoDir, 'heaven-0001.png'),
        }));

        const res = runCliProcess(['reels', '--task', slowTask, '--output', outMp4, '--timeout', '0.1', '--quiet']);
        assert.equal(res.status, 4);
        const errPayload = JSON.parse(res.stderr.trim().split(/\r?\n/).pop());
        assert.equal(errPayload.code, 'RENDER_TIMEOUT');
        assert.equal(fs.existsSync(outMp4), false);
        assert.equal(fs.existsSync(`${outMp4}.tmp`), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Backend fixes (§8): server.py Waitress args, /api/srt/seamless srtInfos, /api/media/convert makedirs', () => {
    const serverPy = fs.readFileSync(path.join(repoRoot, 'backend', 'server.py'), 'utf-8');

    // Bug 1: recv_timeout removed and Exception caught on Waitress startup
    assert.equal(serverPy.includes('recv_timeout='), false, 'recv_timeout should be removed from waitress.serve');
    assert.match(serverPy, /except Exception as waitress_err:/);

    // Bug 2: /api/srt/seamless uses srt_info.srtInfos and startTime/endTime
    assert.equal(serverPy.includes('srt_info.srt_data'), false, 'srt_info.srt_data should be replaced with srt_info.srtInfos');
    assert.match(serverPy, /srt_info\.srtInfos\[i\]\['endTime'\]\s*=\s*srt_info\.srtInfos\[i\s*\+\s*1\]\['startTime'\]/);

    // Bug 3: /api/media/convert ensures out_dir exists
    assert.match(serverPy, /out_dir = output_dir if output_dir else os\.path\.dirname\(file_path\)\s+if out_dir:\s+os\.makedirs\(out_dir, exist_ok=True\)/);
});

test('A13: Engine routing (auto | ass | wysiwyg), preset single-source-of-truth, and renderer_version lock', () => {
    const { resolveTaskEngine, validateTaskFile, CLIError } = require('../bin/videokit-cli.cjs');
    const { REELS_BUILTIN_PRESETS } = require('../src/reels-presets-init.js');

    assert.ok(REELS_BUILTIN_PRESETS && Object.keys(REELS_BUILTIN_PRESETS).length >= 60, 'Should share 60+ builtin presets from src/reels-presets-init.js');

    // All 15 Canvas-exclusive animation types must route to wysiwyg in auto mode
    const canvasAnims = [
        'metronome', 'flash_highlight', 'char_bounce', 'letter_jump', 'zoom_typewriter',
        'line_focus', 'floating', 'bullet_reveal', 'scatter_pop', 'word_random_position',
        'box_wipe', 'kinetic_glow_stack', 'underline_sweep', 'three_word_focus_stack',
        'rolling_rainbow_karaoke',
    ];
    for (const anim of canvasAnims) {
        const route = resolveTaskEngine({ engine: 'auto' }, { anim_in_type: anim }, [], {}, 't-anim');
        assert.equal(route.engine, 'wysiwyg', `anim_in_type=${anim} should route to wysiwyg`);
        assert.match(route.engineReason, new RegExp(anim));
    }

    // ASS-compatible animations route to ass in auto mode
    for (const anim of ['none', 'fade', 'pop', 'slide_up', 'typewriter', 'blur_sharp', 'holy_glow', 'word_pop_random', 'word_pop_random_pulse']) {
        const route = resolveTaskEngine({ engine: 'auto' }, { anim_in_type: anim }, [], {}, 't-ass');
        assert.equal(route.engine, 'ass', `anim_in_type=${anim} should route to ass`);
    }

    // Forcing engine='ass' on a Canvas-exclusive task must throw CLIError with exitCode 2
    assert.throws(
        () => resolveTaskEngine({ engine: 'ass' }, { anim_in_type: 'char_bounce' }, [], {}, 't-force-ass'),
        (err) => err instanceof CLIError && err.code === 'ENGINE_UNSUPPORTED' && err.exitCode === 2
    );

    // Mismatched renderer_version must fail with exitCode 2
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cli-a13-'));
    try {
        const mismatchTask = path.join(tmpDir, 'mismatch.json');
        fs.writeFileSync(mismatchTask, JSON.stringify({
            id: 'mismatch-01',
            renderer_version: '0.0.1-mismatch',
            width: 720,
            height: 1280,
            bgPath: path.join(demoDir, 'heaven-0001.png'),
        }));
        const res = runCliProcess(['validate', '--task', mismatchTask]);
        assert.equal(res.status, 2);
        const errPayload = JSON.parse(res.stderr.trim().split(/\r?\n/).pop());
        assert.equal(errPayload.code, 'RENDERER_VERSION_MISMATCH');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('A14: WYSIWYG engine routing and render with Canvas-exclusive preset', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cli-a14-'));
    try {
        const taskPath = path.join(tmpDir, 'wysiwyg-task.json');
        const outMp4 = path.join(tmpDir, 'wysiwyg-out.mp4');
        fs.writeFileSync(taskPath, JSON.stringify({
            id: 'wysiwyg-01',
            engine: 'auto',
            preset: '逐字放大',
            width: 720,
            height: 1280,
            fps: 24,
            duration: 1.5,
            quality: 'low',
            bgPath: path.join(demoDir, 'heaven-0001.png'),
            segments: [
                { start: 0.1, end: 1.3, text: 'Canvas bounce glow test' },
            ],
        }));

        const valRes = runCliProcess(['validate', '--task', taskPath]);
        assert.equal(valRes.status, 0);
        const valJson = JSON.parse(valRes.stdout.trim());
        assert.equal(valJson.engine, 'wysiwyg');

        const renderRes = runCliProcess(['reels', '--task', taskPath, '--output', outMp4, '--quiet'], {
            VIDEOKIT_WYSIWYG_BACKEND: 'ass-fallback',
        });
        assert.equal(renderRes.status, 0, `Expected exit 0, stderr: ${renderRes.stderr}`);
        const renderJson = JSON.parse(renderRes.stdout.trim().split(/\r?\n/).pop());
        assert.equal(renderJson.status, 'ok');
        assert.equal(renderJson.engine, 'wysiwyg');
        assert.ok(fs.existsSync(outMp4) && fs.statSync(outMp4).size > 1000);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('A15: ASS word_pop_random & Hormozi preset deterministic seed, per-word Dialogue events, and render', () => {
    const { validateTaskFile, buildTaskASS } = require('../bin/videokit-cli.cjs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cli-a15-'));
    try {
        const taskPath = path.join(tmpDir, 'hormozi.json');
        const outMp4 = path.join(tmpDir, 'hormozi.mp4');
        fs.writeFileSync(taskPath, JSON.stringify({
            id: 'hormozi-01',
            preset: 'Hormozi 风格字幕',
            width: 720,
            height: 1280,
            fps: 30,
            duration: 2.0,
            quality: 'low',
            bgPath: path.join(demoDir, 'heaven-0001.png'),
            subtitle: {
                font_family: 'Arial',
                color_text: '#FFFFFF',
                color_high: '#FFD700',
            },
            segments: [
                {
                    start: 0.0,
                    end: 1.8,
                    text: 'Never give up today',
                    words: [
                        { word: 'Never', start: 0.0, end: 0.4 },
                        { word: 'give', start: 0.4, end: 0.8 },
                        { word: 'up', start: 0.8, end: 1.2 },
                        { word: 'today', start: 1.2, end: 1.8 },
                    ],
                },
            ],
        }));

        const plan = validateTaskFile(taskPath, {});
        assert.equal(plan.engine, 'ass');
        const ass1 = buildTaskASS(plan);
        const ass2 = buildTaskASS(plan);
        assert.equal(ass1, ass2, 'word_pop_random ASS output must be 100% deterministic across runs');
        assert.match(ass1, /\\an7\\pos\(\d+,\d+\)\\1c&H0000D7FF\\fscx\d+\\fscy\d+\\t\(0,\d+,\\fscx\d+\\fscy\d+\)/);

        const res = runCliProcess(['reels', '--task', taskPath, '--output', outMp4, '--quiet']);
        assert.equal(res.status, 0, `Expected exit 0, stderr: ${res.stderr}`);
        assert.ok(fs.existsSync(outMp4) && fs.statSync(outMp4).size > 1000);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('A16-A18: server.py Waitress map_size removed, Bearer Token auth, and /api/reels/render queue', () => {
    const serverPy = fs.readFileSync(path.join(repoRoot, 'backend', 'server.py'), 'utf-8');

    // A16: map_size removed from waitress.serve and VIDEOKIT_HOST supported
    assert.equal(serverPy.includes('map_size='), false, 'map_size must be removed from waitress.serve');
    assert.match(serverPy, /VIDEOKIT_HOST/);

    // A17: Bearer Token authentication middleware present
    assert.match(serverPy, /VIDEOKIT_API_TOKEN/);
    assert.match(serverPy, /hmac\.compare_digest\(provided_token,\s*expected_token\)/);

    // A18: Remote render queue endpoints and path traversal / extension whitelist checks present
    assert.match(serverPy, /@app\.route\('\/api\/reels\/render',\s*methods=\['POST'\]\)/);
    assert.match(serverPy, /@app\.route\('\/api\/reels\/render\/<task_id>',\s*methods=\['GET'\]\)/);
    assert.match(serverPy, /@app\.route\('\/api\/reels\/render\/<task_id>\/download',\s*methods=\['GET'\]\)/);
    assert.match(serverPy, /_ALLOWED_RENDER_EXTENSIONS/);
});

test('A19: Native Web Edition (web-bridge.js + videokit-web-server.cjs) RPC, upload, Range streaming, and Token auth', async () => {
    const http = require('http');
    const { createWebServer } = require('../bin/videokit-web-server.cjs');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videokit-web-test-'));
    const server = createWebServer({ token: 'secret-web-token' });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const httpReq = (reqPath, { method = 'GET', headers = {}, body = null } = {}) =>
        new Promise((resolve, reject) => {
            const req = http.request(
                { hostname: '127.0.0.1', port, path: reqPath, method, headers },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        const buf = Buffer.concat(chunks);
                        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8') });
                    });
                }
            );
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });

    try {
        // 1. /api/health is public
        const healthRes = await httpReq('/api/health');
        assert.equal(healthRes.status, 200);
        const healthJson = JSON.parse(healthRes.text);
        assert.equal(healthJson.status, 'ok');
        assert.equal(healthJson.auth_required, true);

        // 2. Unauthorized RPC is rejected with 401
        const unauthRes = await httpReq('/api/web-bridge/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'getAppVersion', args: [] }),
        });
        assert.equal(unauthRes.status, 401);

        // 3. Authorized RPC works (getAppVersion, webListDir, scanFonts)
        const authHeaders = {
            'Content-Type': 'application/json',
            Authorization: 'Bearer secret-web-token',
        };
        const verRes = await httpReq('/api/web-bridge/rpc', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ action: 'getAppVersion', args: [] }),
        });
        assert.equal(verRes.status, 200);
        const verJson = JSON.parse(verRes.text);
        assert.equal(verJson.ok, true);
        assert.match(verJson.result, /^\d+\.\d+\.\d+/);

        const listRes = await httpReq('/api/web-bridge/rpc', {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ action: 'webListDir', args: [demoDir] }),
        });
        assert.equal(listRes.status, 200);
        const listJson = JSON.parse(listRes.text);
        assert.equal(listJson.ok, true);
        assert.ok(Array.isArray(listJson.result.items) && listJson.result.items.length > 0);

        // 4. Raw upload endpoint saves file and returns server path
        const sampleBytes = Buffer.from('WEB_BRIDGE_UPLOAD_TEST_CONTENT_1234567890');
        const upRes = await httpReq('/api/web-bridge/upload-raw?name=sample.txt', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer secret-web-token',
                'Content-Type': 'application/octet-stream',
            },
            body: sampleBytes,
        });
        assert.equal(upRes.status, 200);
        const upJson = JSON.parse(upRes.text);
        assert.equal(upJson.ok, true);
        assert.ok(fs.existsSync(upJson.path));

        // 5. Media endpoint supports HTTP Range (206 Partial Content) with token query param
        const mediaRes = await httpReq(
            `/api/web-bridge/media?path=${encodeURIComponent(upJson.path)}&token=secret-web-token`,
            {
                method: 'GET',
                headers: { Range: 'bytes=0-9' },
            }
        );
        assert.equal(mediaRes.status, 206);
        assert.equal(mediaRes.text, 'WEB_BRIDGE');

        // Clean up uploaded file
        try { fs.unlinkSync(upJson.path); } catch (_) {}
    } finally {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('A20: All 114 preset IDs (se-*, sub-*, scroll-*, ov-*), Canvas style routing, font fallbacks, and real Electron WYSIWYG worker render', () => {
    const { validateTaskFile, resolveFontFamily } = require('../bin/videokit-cli.cjs');
    const {
        REELS_PRESET_ID_MAP,
        REELS_OVERLAY_PRESET_ID_MAP,
        REELS_BUILTIN_SCROLL_STYLE_PRESETS,
        REELS_SCROLL_PRESET_ID_MAP,
        resolveBuiltinPreset,
    } = require('../src/reels-presets-init.js');

    // 1. All 284 subtitle/scroll preset IDs + 35 overlay preset IDs + 428 scroll style IDs (sc-01..sc-214 & scroll-01..scroll-214) must resolve
    const subIds = Object.keys(REELS_PRESET_ID_MAP);
    const ovIds = Object.keys(REELS_OVERLAY_PRESET_ID_MAP);
    const scIds = Object.keys(REELS_SCROLL_PRESET_ID_MAP);
    assert.equal(subIds.length, 284, 'Expected 284 subtitle/scroll preset IDs');
    assert.equal(ovIds.length, 35, 'Expected 35 overlay preset IDs');
    assert.equal(Object.keys(REELS_BUILTIN_SCROLL_STYLE_PRESETS).length, 214, 'Expected all 214 builtin scroll style presets');
    assert.equal(scIds.length, 428, 'Expected all 428 scroll style ID mappings (sc-01..sc-214 & scroll-01..scroll-214)');
    for (const id of [...subIds, ...ovIds, ...scIds]) {
        const resolved = resolveBuiltinPreset(id);
        assert.ok(resolved, `Preset ID ${id} must resolve`);
    }
    for (let n = 1; n <= 214; n++) {
        const pad = n < 10 ? `0${n}` : `${n}`;
        assert.ok(resolveBuiltinPreset(`sc-${pad}`), `Legacy preset ID sc-${pad} must still resolve`);
        assert.ok(resolveBuiltinPreset(`scroll-${pad}`), `Legacy preset alias scroll-${pad} must still resolve`);
    }

    // 2. Font resolution for Windows/macOS and all 214 scroll preset fonts
    const scrollFonts = Array.from(new Set(
        Object.values(REELS_BUILTIN_SCROLL_STYLE_PRESETS)
            .map(p => p && p.font_family)
            .filter(Boolean)
    ));
    for (const fam of ['Comic Sans MS', 'Balsamiq Sans', 'Segoe UI', 'Impact', 'Arial Black', 'Georgia', 'Times New Roman', 'Noto Sans SC', 'Kalam', 'LXGW WenKai', 'Permanent Marker', 'Patrick Hand', 'Handlee', 'Encode Sans Condensed', 'Jost', 'Anton', 'Playfair Display', ...scrollFonts]) {
        const info = resolveFontFamily(fam);
        assert.ok(info && Array.isArray(info.fontFiles) && info.fontFiles.length > 0, `Font ${fam} should resolve to font files`);
    }

    // 3. Validate preset IDs and Canvas-exclusive engine routing + real Electron WYSIWYG render
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cli-a20-'));
    try {
        for (const presetId of ['se-01', 'se-12', 'sub-03', 'sub-25', 'sub-27', 'sub-35', 'sub-36', 'sub-39', 'sub-40', 'sub-53', 'sub-55', 'sub-68', 'sub-70', 'sub-228', 'sub-229', 'sub-235', 'sub-240', 'sub-244', 'sub-245', 'sub-246', 'sub-248', 'sub-250', 'sub-251', 'scroll-blessed-grace', 'scroll-lyrics-pink', 'ov-01', 'ov-15', 'ov-16', 'ov-17', 'ov-19', 'ov-21', 'ov-23', 'ov-27', 'ov-28', 'ov-30', 'ov-33', 'ov-34', 'ov-35', 'sc-01', 'sc-13', 'sc-25', 'sc-26', 'sc-30', 'sc-34', 'sc-35', 'sc-38', 'sc-39', 'sc-40', 'sc-41', 'sc-49', 'sc-65', 'sc-81', 'sc-97', 'sc-115', 'sc-133', 'sc-148', 'sc-149', 'sc-162', 'sc-175', 'sc-187', 'sc-198', 'sc-199', 'sc-206', 'sc-214', 'scroll-15', 'scroll-49', 'scroll-148', 'scroll-149', 'scroll-198', 'scroll-199', 'scroll-214']) {
            const p = path.join(tmpDir, `task-${presetId}.json`);
            fs.writeFileSync(p, JSON.stringify({
                id: `check-${presetId}`,
                engine: 'auto',
                preset: presetId,
                width: 720,
                height: 1280,
                scroll_title: 'MORNING PRAYER',
                bgPath: path.join(demoDir, 'heaven-0001.png'),
                segments: [{ start: 0.0, end: 1.0, text: 'Amen blessed grace' }],
            }));
            const plan = validateTaskFile(p, {});
            assert.equal(plan.engine, 'wysiwyg', `Preset ${presetId} should route to wysiwyg in auto mode`);
            if (presetId.startsWith('sc-') || /^scroll-\d+$/.test(presetId)) {
                assert.equal(plan.showSubtitle, false, `Scroll preset ${presetId} should disable duplicate T-subtitle by default`);
                assert.equal(plan.overlays.length, 1);
                assert.equal(plan.overlays[0].type, 'scroll');
                assert.equal(plan.overlays[0].content, 'Amen blessed grace');
                assert.equal(plan.overlays[0].scroll_title, 'MORNING PRAYER');
            }
        }

        // 4. Real Electron --headless-wysiwyg-worker render (no ass-fallback)
        const realTaskPath = path.join(tmpDir, 'real-wysiwyg.json');
        const realOutMp4 = path.join(tmpDir, 'real-wysiwyg.mp4');
        fs.writeFileSync(realTaskPath, JSON.stringify({
            id: 'real-wysiwyg-01',
            engine: 'wysiwyg',
            preset: 'sub-55',
            width: 720,
            height: 1280,
            fps: 24,
            duration: 0.5,
            quality: 'low',
            bgPath: path.join(demoDir, 'heaven-0001.png'),
            segments: [
                { start: 0.0, end: 0.5, text: 'Merry Christmas' },
            ],
        }));
        const res = runCliProcess(['reels', '--task', realTaskPath, '--output', realOutMp4, '--quiet']);
        assert.equal(res.status, 0, `Real Electron WYSIWYG render failed: ${res.stderr}`);
        assert.ok(fs.existsSync(realOutMp4) && fs.statSync(realOutMp4).size > 1000, 'Real WYSIWYG output MP4 should exist and be non-empty');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('A21: web server resolveWebRoot avoids stale dist/ after source updates', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-webroot-'));
    try {
        const distDir = path.join(tmpDir, 'dist');
        const srcDir = path.join(tmpDir, 'src');
        fs.mkdirSync(distDir, { recursive: true });
        fs.mkdirSync(srcDir, { recursive: true });

        const distIndex = path.join(distDir, 'index.html');
        const srcIndex = path.join(srcDir, 'index.html');
        const srcApp = path.join(srcDir, 'app.js');

        // 1. Missing dist/ -> serves src/
        fs.writeFileSync(srcIndex, '<html>src</html>');
        fs.writeFileSync(srcApp, 'console.log(1);');
        assert.deepEqual(resolveWebRoot(distDir, srcDir, {}), { root: srcDir, source: 'src', reason: 'no_dist' });

        // 2. Stale dist/ (src file newer than dist/index.html) -> serves src/
        fs.writeFileSync(distIndex, '<html>dist</html>');
        const nowSec = Math.floor(Date.now() / 1000);
        fs.utimesSync(distIndex, nowSec - 10, nowSec - 10);
        fs.utimesSync(srcApp, nowSec, nowSec);
        assert.deepEqual(resolveWebRoot(distDir, srcDir, {}), { root: srcDir, source: 'src', reason: 'src_newer' });

        // 3. Fresh dist/ (dist/index.html newer than all src/) -> serves dist/
        fs.utimesSync(distIndex, nowSec + 10, nowSec + 10);
        assert.deepEqual(resolveWebRoot(distDir, srcDir, {}), { root: distDir, source: 'dist', reason: 'dist_fresh' });

        // 4. VIDEOKIT_WEB_USE_SRC=1 -> forces src/
        assert.deepEqual(resolveWebRoot(distDir, srcDir, { VIDEOKIT_WEB_USE_SRC: '1' }), { root: srcDir, source: 'src', reason: 'env' });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('A22: CLI intro_countdown computes introDelaySec, shifts ASS subtitles, and emits FFmpeg adelay', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-intro-'));
    try {
        // Create valid 0.5s 8kHz mono 16-bit PCM WAV file so ffprobe and buildFFmpegArgs work offline
        const sampleRate = 8000;
        const numSamples = 4000;
        const dataSize = numSamples * 2;
        const wavBuf = Buffer.alloc(44 + dataSize);
        wavBuf.write('RIFF', 0);
        wavBuf.writeUInt32LE(36 + dataSize, 4);
        wavBuf.write('WAVEfmt ', 8);
        wavBuf.writeUInt32LE(16, 16);
        wavBuf.writeUInt16LE(1, 20);
        wavBuf.writeUInt16LE(1, 22);
        wavBuf.writeUInt32LE(sampleRate, 24);
        wavBuf.writeUInt32LE(sampleRate * 2, 28);
        wavBuf.writeUInt16LE(2, 32);
        wavBuf.writeUInt16LE(16, 34);
        wavBuf.write('data', 36);
        wavBuf.writeUInt32LE(dataSize, 40);
        const wavPath = path.join(tmpDir, 'voice.wav');
        fs.writeFileSync(wavPath, wavBuf);

        const taskPath = path.join(tmpDir, 'intro-task.json');
        fs.writeFileSync(taskPath, JSON.stringify({
            id: 'intro-delay-test',
            engine: 'auto',
            preset: 'sub-03',
            width: 720,
            height: 1280,
            bgPath: path.join(demoDir, 'heaven-0001.png'),
            audioPath: wavPath,
            segments: [{ start: 0.2, end: 1.0, text: 'Amen' }],
            overlays: [
                {
                    id: 'intro-ring-1',
                    type: 'intro_countdown',
                    is_intro_countdown: true,
                    intro_delay_body: true,
                    start: 0,
                    end: 3.5,
                    target_date: '12.25',
                },
            ],
        }));

        const plan = validateTaskFile(taskPath, {});
        assert.equal(plan.introDelaySec, 3.5);
        assert.ok(plan.bodyDuration >= 0.45 && plan.bodyDuration <= 0.55, `Expected bodyDuration ~0.5s, got ${plan.bodyDuration}`);
        assert.ok(plan.targetDuration >= 3.95 && plan.targetDuration <= 4.05, `Expected targetDuration ~4.0s, got ${plan.targetDuration}`);

        const assText = buildTaskASS(plan);
        assert.match(assText, /Dialogue:.*0:00:03\.70,0:00:04\.50/, 'ASS dialogue start/end must shift by +3.5s intro delay');

        const ffmpegArgs = buildFFmpegArgs(plan, path.join(tmpDir, 'out.mp4'));
        const filterComplexIdx = ffmpegArgs.indexOf('-filter_complex');
        assert.ok(filterComplexIdx >= 0);
        const fc = ffmpegArgs[filterComplexIdx + 1];
        assert.match(fc, /adelay=3500\|3500/, 'Pure FFmpeg audio filtergraph must delay voice audio by 3500ms');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('A23: CLI update subcommand parsing, mocked update check, and cloud-update.sh validation', async () => {
    const parsed = parseArgs(['update', '--check', '--beta', '--stash', '--json', '--branch', 'main']);
    assert.equal(parsed.subcommand, 'update');
    assert.equal(parsed.check, true);
    assert.equal(parsed.beta, true);
    assert.equal(parsed.stash, true);
    assert.equal(parsed.json, true);
    assert.equal(parsed.branch, 'main');

    const mockGitClean = (gitArgs) => {
        if (gitArgs[0] === 'remote') return 'https://github.com/golsaysea/videokit-Y.git';
        if (gitArgs[0] === 'rev-parse' && gitArgs[1] === '--abbrev-ref') return 'main';
        if (gitArgs[0] === 'rev-parse' && gitArgs[1] === '--short') return '833ba6d';
        if (gitArgs[0] === 'status') return '';
        return '';
    };

    const newerReport = await runSelfUpdateCommand(
        { check: true, beta: true },
        {
            silent: true,
            getVersion: () => '4.6.3-beta',
            execGit: mockGitClean,
            fetchReleases: async () => [
                { tag_name: 'v4.6.4-beta', prerelease: true, draft: false, html_url: 'https://github.com/golsaysea/videokit-Y/releases/tag/v4.6.4-beta' },
                { tag_name: 'v4.6.3-beta', prerelease: true, draft: false, html_url: 'https://github.com/golsaysea/videokit-Y/releases/tag/v4.6.3-beta' },
            ],
        }
    );
    assert.equal(newerReport.update_available, true);
    assert.equal(newerReport.latest_version, '4.6.4-beta');
    assert.equal(newerReport.latest_tag, 'v4.6.4-beta');

    const sameReport = await runSelfUpdateCommand(
        { check: true, beta: true },
        {
            silent: true,
            getVersion: () => '4.6.4-beta',
            execGit: mockGitClean,
            fetchReleases: async () => [
                { tag_name: 'v4.6.4-beta', prerelease: true, draft: false, html_url: 'https://github.com/golsaysea/videokit-Y/releases/tag/v4.6.4-beta' },
            ],
        }
    );
    assert.equal(sameReport.update_available, false);

    // Dirty tree without --stash must reject cleanly instead of overwriting work
    await assert.rejects(
        () => runSelfUpdateCommand(
            { check: false, stash: false },
            {
                silent: true,
                getVersion: () => '4.6.3-beta',
                execGit: (gitArgs) => (gitArgs[0] === 'status' ? ' M src/app.js' : mockGitClean(gitArgs)),
                fetchReleases: async () => [],
            }
        ),
        (err) => err && err.code === 'DIRTY_WORKTREE'
    );

    const cloudScriptPath = path.join(repoRoot, 'scripts', 'cloud-update.sh');
    assert.ok(fs.existsSync(cloudScriptPath), 'scripts/cloud-update.sh must exist');
    const cloudScriptText = fs.readFileSync(cloudScriptPath, 'utf-8');
    assert.equal(cloudScriptText.includes('\r\n'), false, 'scripts/cloud-update.sh must use LF line endings for Linux');
    assert.match(cloudScriptText, /--check/);
    assert.match(cloudScriptText, /--stash/);
});

test('A24: CLI routes draggable Christmas sticker overlays to wysiwyg engine automatically', () => {
    const { resolveTaskEngine } = require('../bin/videokit-cli.cjs');
    const routed = resolveTaskEngine({ engine: 'auto' }, {}, [{ type: 'sticker', sticker_kind: 'jingle_bell', x: 410, y: 220, w: 260, h: 260 }]);
    assert.equal(routed.engine, 'wysiwyg');
    assert.match(routed.engineReason, /overlay_type=sticker/);
});

test('A25: Canva bridge SSRF protection, preset catalog, async job queue, tokenized media endpoints, and Canva App scaffold', async () => {
    const http = require('node:http');
    const {
        assertSafeCanvaMediaUrl,
        buildAutoSegmentsFromText,
        buildCanvaPresetCatalog,
        CanvaJobManager,
    } = require('../electron/services/canva-bridge');
    const { createWebServer } = require('../bin/videokit-web-server.cjs');

    // 1. Strict HTTPS & SSRF protections
    assert.throws(() => assertSafeCanvaMediaUrl('http://example.com/a.mp4'), /HTTPS/);
    assert.throws(() => assertSafeCanvaMediaUrl('https://localhost/a.mp4'), /本机或内网/);
    assert.throws(() => assertSafeCanvaMediaUrl('https://127.0.0.1/a.mp4'), /本机或内网/);
    assert.throws(() => assertSafeCanvaMediaUrl('https://169.254.169.254/latest/meta-data'), /本机或内网/);
    assert.throws(() => assertSafeCanvaMediaUrl('https://192.168.1.10/a.mp4'), /本机或内网/);
    assert.throws(() => assertSafeCanvaMediaUrl('https://[::1]/a.mp4'), /本机或内网/);
    assert.throws(() => assertSafeCanvaMediaUrl('https://user:pass@export-download.canva.com/a.mp4'), /凭据/);
    assert.equal(assertSafeCanvaMediaUrl('https://export-download.canva.com/v/clip.mp4').hostname, 'export-download.canva.com');

    // 2. Auto timed segments from multiline text
    const segs = buildAutoSegmentsFromText('Line one prayer.\nLine two peace and grace.', 8);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].start, 0);
    assert.ok(segs[0].end > 0 && segs[0].end <= segs[1].start + 0.001);
    assert.equal(segs[1].end, 8);

    // 3. Preset catalog reflects restored 214 scroll styles + 251 subtitles + Cardinal feather cursor + sentence reveal
    const catalog = buildCanvaPresetCatalog();
    assert.equal(catalog.scrolls.length, 214, 'Canva catalog must expose all 214 restored sc-* presets');
    assert.equal(catalog.subtitles.length, 251, 'Canva catalog must expose all 251 sub-* presets');
    assert.equal(catalog.overlays.length, 35, 'Canva catalog must expose all 35 ov-* presets');
    assert.ok(catalog.cursorIcons.some(c => c.id === 'cardinal_feather'), 'Canva catalog must include cardinal_feather');
    assert.ok(catalog.revealTypes.some(r => r.id === 'sentence'), 'Canva catalog must include sentence reveal option');

    // 4. End-to-end async Canva render HTTP flow via createWebServer
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-canva-test-'));
    const recordedTasks = [];
    let webServer = null;
    let mockCanvaServer = null;
    try {
        mockCanvaServer = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'video/mp4' });
            res.end(Buffer.from('FAKE_CANVA_MP4_BYTES_123456'));
        });
        await new Promise(resolve => mockCanvaServer.listen(0, '127.0.0.1', resolve));
        const mockCanvaPort = mockCanvaServer.address().port;

        const jobMgr = new CanvaJobManager({
            workRoot: tmpRoot,
            allowInsecureTestHttp: true,
            allowLocalhostMedia: true,
            ffmpeg: {
                getDuration: async () => 6.0,
                runCommand: async (_cmd, args) => {
                    const outThumb = args[args.length - 1];
                    fs.writeFileSync(outThumb, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
                },
            },
            renderReelsTask: async (taskFile, cliArgs) => {
                const taskJson = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
                recordedTasks.push(taskJson);
                fs.writeFileSync(cliArgs.output, Buffer.from('RENDERED_VIDEOKIT_MP4'));
                return { output: cliArgs.output, engine: 'wysiwyg', duration: taskJson.duration };
            },
        });

        webServer = createWebServer({ token: 'canva-test-token', canvaJobManager: jobMgr });
        await new Promise(resolve => webServer.listen(0, '127.0.0.1', resolve));
        const serverPort = webServer.address().port;
        const base = `http://127.0.0.1:${serverPort}`;

        // Unauthorized call rejected
        const unauthRes = await fetch(`${base}/api/canva/presets`);
        assert.equal(unauthRes.status, 401);

        // Authorized presets listing
        const presetsRes = await fetch(`${base}/api/canva/presets`, {
            headers: { Authorization: 'Bearer canva-test-token' },
        });
        assert.equal(presetsRes.status, 200);
        const presetsBody = await presetsRes.json();
        assert.equal(presetsBody.scrolls.length, 214);

        // Submit Canva render job with Cardinal feather & sentence reveal behind forwarded HTTPS proxy headers
        const renderRes = await fetch(`${base}/api/canva/render`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer canva-test-token',
                'Content-Type': 'application/json',
                'X-Forwarded-Proto': 'https',
                'X-Forwarded-Host': 'studio.example.com',
            },
            body: JSON.stringify({
                mediaUrl: `http://127.0.0.1:${mockCanvaPort}/page-export.mp4`,
                preset: 'sc-39',
                revealType: 'sentence',
                cursorKind: 'cardinal_feather',
                scrollTitle: 'MORNING PRAYER',
                text: 'Line one.\nLine two.',
            }),
        });
        assert.equal(renderRes.status, 202);
        const created = await renderRes.json();
        assert.ok(created.jobId);
        assert.equal(created.statusUrl, `https://studio.example.com/api/canva/jobs/${created.jobId}`);

        // Wait for async job completion
        await jobMgr.jobs.get(created.jobId)._promise;

        const statusRes = await fetch(`${base}/api/canva/jobs/${created.jobId}`, {
            headers: { Authorization: 'Bearer canva-test-token' },
        });
        assert.equal(statusRes.status, 200);
        const jobStatus = await statusRes.json();
        assert.equal(jobStatus.status, 'done');
        assert.ok(jobStatus.outputUrl.startsWith(`https://studio.example.com/api/canva/files/${created.jobId}/`));
        assert.ok(jobStatus.outputUrl.endsWith('/render.mp4'));
        assert.ok(jobStatus.thumbnailUrl.endsWith('/thumb.jpg'));

        // Verify generated VideoKit task JSON properties
        assert.equal(recordedTasks.length, 1);
        assert.equal(recordedTasks[0].duration, 6.0);
        assert.equal(recordedTasks[0].bgVolume, 1.0);
        assert.equal(recordedTasks[0].overlays[0].scroll_tw_reveal_type, 'sentence');
        assert.equal(recordedTasks[0].overlays[0].scroll_tw_cursor_kind, 'cardinal_feather');

        // Verify tokenized file route works for Canva fetch (HEAD + GET 200 OK) & rejects forged tokens
        const fileRel = new URL(jobStatus.outputUrl).pathname;
        const badFileRes = await fetch(`${base}/api/canva/files/${created.jobId}/deadbeef00000000/render.mp4`);
        assert.equal(badFileRes.status, 403);

        const headRes = await fetch(`${base}${fileRel}`, { method: 'HEAD' });
        assert.equal(headRes.status, 200);
        assert.equal(headRes.headers.get('content-type'), 'video/mp4');

        const dlRes = await fetch(`${base}${fileRel}`);
        assert.equal(dlRes.status, 200);
        assert.equal(await dlRes.text(), 'RENDERED_VIDEOKIT_MP4');
    } finally {
        if (webServer) await new Promise(r => webServer.close(r));
        if (mockCanvaServer) await new Promise(r => mockCanvaServer.close(r));
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }

    // 5. Verify Canva App plugin scaffold exists & wires official Canva SDK APIs
    const appDir = path.join(repoRoot, 'canva-app');
    const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'canva-app.json'), 'utf-8'));
    const permNames = manifest.runtime.permissions.map(p => p.name);
    for (const reqPerm of ['canva:design:content:read', 'canva:design:content:write', 'canva:asset:private:write']) {
        assert.ok(permNames.includes(reqPerm), `canva-app.json must request permission ${reqPerm}`);
    }
    const appTsx = fs.readFileSync(path.join(appDir, 'src', 'app.tsx'), 'utf-8');
    assert.match(appTsx, /requestExport/);
    assert.match(appTsx, /upload\(/);
    assert.match(appTsx, /addElementAtPoint/);
    assert.match(appTsx, /addElementAtCursor/);
    assert.match(appTsx, /cardinal_feather/);
    assert.ok(fs.existsSync(path.join(repoRoot, 'docs', 'CANVA_APP_SETUP.md')));
});
