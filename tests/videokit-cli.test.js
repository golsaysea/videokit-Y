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
const { validateTaskFile, buildTaskASS } = require('../bin/videokit-cli.cjs');

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
