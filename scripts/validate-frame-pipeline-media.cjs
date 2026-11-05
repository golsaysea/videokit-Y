'use strict';
// Real FFmpeg with the production bridge/receiver/export queue. Native Electron
// MessagePorts and complete Canvas exports are validated by the companion script.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const raw = require('../electron/services/ffmpeg-rawvideo');
const settings = require('../electron/services/settings');
const { createReelsFrameBridge } = require('../electron/services/reels-frame-bridge');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-frame-media-'));
const originalTmp = settings.getSecureTmpDir;
settings.getSecureTmpDir = () => temp;

(async () => {
    const outputPath = path.join(temp, 'result.mp4');
    const sessionId = await raw.handleWysiwygIPC('start', { width: 192, height: 320, fps: 15, totalFrames: 30, targetDuration: 2, useGPU: false, outputPath, qualityPreset: 'ultrafast' });
    assert.ok(sessionId);
    const ipc = new EventEmitter(), main = new EventEmitter();
    let renderer, acknowledgements = 0;
    main.start = () => {};
    main.close = () => queueMicrotask(() => renderer?.onclose?.());
    main.postMessage = data => {
        if (data.type === 'ack') acknowledgements++;
        queueMicrotask(() => renderer.onmessage?.({ data: structuredClone(data) }));
    };
    ipc.invoke = (_channel, action, data) => raw.handleWysiwygIPC(action, data);
    ipc.send = (_channel, data) => {
        renderer = { start() {}, close() { queueMicrotask(() => main.emit('close')); }, postMessage(value, transfer) {
            assert.equal(transfer, undefined, 'frame data must not be transferred to MessagePortMain');
            queueMicrotask(() => main.emit('message', { data: structuredClone(value) }));
        } };
        const attached = raw.attachFramePipeline(sessionId, main, { onFailure: error => ipc.emit('reels-frame-pipeline-failed', {}, { requestId: data.requestId, error: error.message }) });
        assert.equal(attached.ok, true);
        queueMicrotask(() => ipc.emit('reels-frame-pipeline-ready', { ports: [renderer] }, { requestId: data.requestId, ok: true }));
    };
    const bridge = createReelsFrameBridge(ipc);
    try {
        const context = { window: { electronAPI: { ...bridge.api, reelsComposeWysiwyg: (action, data) => raw.handleWysiwygIPC(action, data) } }, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, ArrayBuffer, Uint8Array, Image: class {} };
        vm.createContext(context);
        vm.runInContext(fs.readFileSync(path.join(root, 'src/reels-frame-pipeline.js'), 'utf8'), context);
        const pipeline = context.window.ReelsFramePipeline.create(sessionId, 3);
        for (let i = 0; i < 30; i++) {
            const pixels = Buffer.alloc(192 * 320 * 4);
            for (let p = 0; p < pixels.length; p += 4) { pixels[p] = i * 7; pixels[p + 1] = 120; pixels[p + 2] = 180; pixels[p + 3] = 255; }
            await pipeline.send(pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength));
        }
        await pipeline.drain();
        const result = await raw.handleWysiwygIPC('finish', { sessionId });
        assert.equal(result.output_path, outputPath, result.error);
        const meta = JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,duration', '-of', 'json', outputPath], { encoding: 'utf8' }));
        assert.equal(Number(meta.streams[0].nb_read_frames), 30);
        assert.ok(Math.abs(Number(meta.streams[0].duration) - 2) < .1);
        assert.equal(acknowledgements, 30);
        assert.equal(raw._test.activeSessionCount(), 0);
        console.log(JSON.stringify({ realFFmpeg: true, nativeElectronPort: false, frames: 30, acknowledgements, duration: meta.streams[0].duration, pass: true }));
    } finally {
        bridge.dispose();
        await raw.handleWysiwygIPC('abort', { sessionId });
    }
    // Full alpha-overlay output must preserve the last rendered frame too.
    const background = path.join(temp, 'background.png');
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=192x320', '-frames:v', '1', '-threads', '1', background]);
    for (const fps of [12, 30]) {
        const totalFrames = Math.round(1.5 * fps), outputPath = path.join(temp, `alpha-${fps}.mp4`);
        const sessionId = await raw.handleWysiwygIPC('start', { width: 192, height: 320, fps, totalFrames, targetDuration: 1.5, outputPath, alphaOverlayBgPath: background, useGPU: false, qualityPreset: 'ultrafast' });
        try {
            for (let index = 0; index < totalFrames; index++) {
                const result = await raw.handleWysiwygIPC('frame', { sessionId, raw: Buffer.alloc(192 * 320 * 4, index * 5) });
                assert.equal(result.ok, true, result.error);
            }
            const result = await raw.handleWysiwygIPC('finish', { sessionId });
            assert.equal(result.output_path, outputPath, result.error);
            const meta = JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,duration', '-of', 'json', outputPath], { encoding: 'utf8' }));
            assert.equal(Number(meta.streams[0].nb_read_frames), totalFrames);
            assert.ok(Math.abs(Number(meta.streams[0].duration) - 1.5) < .01);
            console.log(JSON.stringify({ alphaOverlay: true, fps, expectedFrames: totalFrames, actualFrames: Number(meta.streams[0].nb_read_frames), pass: true }));
        } finally { await raw.handleWysiwygIPC('abort', { sessionId }); }
    }
    assert.equal(raw._test.activeSessionCount(), 0);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    settings.getSecureTmpDir = originalTmp;
    fs.rmSync(temp, { recursive: true, force: true });
});
