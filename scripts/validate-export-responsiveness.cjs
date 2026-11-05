'use strict';
// Actual shipped main/preload/isolated renderer/utility process, without provider requests.
const { app, nativeImage, dialog } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const root = path.resolve(__dirname, '..');
const mainModule = process.env.VIDEOKIT_MAIN_UNDER_TEST || path.join(root, 'electron/main.js');
if (process.env.VIDEOKIT_PACKAGED_RESOURCES) {
    Object.defineProperty(process, 'resourcesPath', { value: path.resolve(process.env.VIDEOKIT_PACKAGED_RESOURCES) });
}
// Keep the fixture isolated, including on hosts that prohibit singleton Unix sockets.
process.env.VIDEOKIT_TEST_PROFILE = '1';
app.requestSingleInstanceLock = () => true;
app.releaseSingleInstanceLock = () => {};
const errorDialogs = [];
dialog.showMessageBox = async (...args) => {
    const options = args[1] || args[0];
    if (options.type === 'error') errorDialogs.push(options);
    return { response: 0 };
};
const { ReelsExportService } = require(path.join(path.dirname(mainModule), 'services/reels-export-service.js'));
const ensureWorker = ReelsExportService.prototype.ensureWorker;
let liveService;
ReelsExportService.prototype.ensureWorker = function () { liveService = this; return ensureWorker.apply(this, arguments); };
const output = path.resolve(process.env.VIDEOKIT_RESPONSIVENESS_DIR || path.join(root, '../validation-export-responsiveness'));
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
Object.defineProperty(app, 'isPackaged', { value: true });
let main, done = false;
const deadline = setTimeout(() => finish(new Error('Export responsiveness validation timed out')), 240000);
const pings = [], report = { pass: false };
function finish(error) {
    if (done) return; done = true; clearTimeout(deadline);
    if (error) { console.error(error.stack); fs.writeFileSync(path.join(output, 'failure.txt'), error.stack); }
    // Let production shutdown reap its utility/FFmpeg children.
    process.exitCode = error ? 1 : 0; app.quit();
}
async function checkVideo(file, expected) {
    const { stdout } = await execFile(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,duration,width,height', '-of', 'json', file]);
    const probe = JSON.parse(stdout);
    assert.equal(Number(probe.streams[0].nb_read_frames), expected);
    assert.equal(Number(probe.streams[0].width), 1080); assert.equal(Number(probe.streams[0].height), 1920);
    return probe.streams[0];
}
async function evaluate(source) {
    const result = await main.webContents.executeJavaScript(`(async()=>{try{return {value:await (${source})}}catch(error){return {error:error.stack||String(error)}}})()`);
    if (result.error) throw new Error(result.error); return result.value;
}
async function waitIdle() {
    for (let i = 0; i < 150; i++) {
        const result = await evaluate("electronAPI.reelsComposeWysiwyg('status',{})");
        if (result.activeSessions === 0 && result.activeProcesses === 0) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Cancelled export left encoder/preparation processes alive');
}
app.on('browser-window-created', (_event, win) => {
    if (main) return; main = win;
    win.webContents.once('did-finish-load', async () => {
        let pingTimer;
        try {
            await new Promise(resolve => setTimeout(resolve, 700));
            const background = path.join(output, 'background.png');
            fs.writeFileSync(background, nativeImage.createFromBitmap(Buffer.alloc(360 * 640 * 4, 180), { width: 360, height: 640 }).toPNG());
            let pingRunning = false, moves = 0;
            const bounds = main.getBounds();
            pingTimer = setInterval(async () => {
                if (pingRunning || done || main.isDestroyed()) return; pingRunning = true;
                const started = Date.now();
                try {
                    main.setPosition(bounds.x + (moves++ % 3) * 8, bounds.y + (moves % 2) * 6);
                    assert.equal(await main.webContents.executeJavaScript('21*2'), 42);
                    pings.push(Date.now() - started);
                } finally { pingRunning = false; }
            }, 50);
            const cases = ['precise', 'pipeline', 'hardware', 'pipeline'].map((engine, index) => ({ engine, requestId: 'responsiveness-' + index,
                outputPath: path.join(output, engine + '-' + index + '.mp4') }));
            const common = { backgroundPath: background, alphaOverlayBgPath: background, customDuration: .7, fps: 30,
                targetWidth: 1080, targetHeight: 1920, loopFade: false, bgVolume: 0, qualityPreset: 'ultrafast', overlays: [],
                style: { visual_engine_enabled: true, mixed_layout: 'stack', font_family: 'Arial', fontsize: 74, line_spacing: 6,
                    color_text: '#FF0000,#0000FF', color_high: '#FFD700', highlight_enabled: true, text_gradient_scope: 'line', pos_x: .5, pos_y: .5 },
                segments: [{ start: 0, end: .7, text: 'May hope fill your home', words: ['May', 'hope', 'fill', 'your', 'home'].map((word, i) => ({ word, start: i * .14, end: (i + 1) * .14 })) }] };
            report.batch = await evaluate(`(async()=>{
                const common=${JSON.stringify(common)}, cases=${JSON.stringify(cases)}, queued=[];
                const jobs=cases.map(item=>{
                    const unsubscribe=electronAPI.onIsolatedWysiwygProgress(item.requestId,data=>{if(data.stage==='queued')queued.push(data.message)});
                    return electronAPI.isolatedWysiwygExport({requestId:item.requestId,params:{...common,outputPath:item.outputPath,exportEngine:item.engine,useGPU:item.engine==='hardware'}}).finally(unsubscribe);
                });
                const cancelId='cancel-queued';let sawQueued=false;
                const unsubscribe=electronAPI.onIsolatedWysiwygProgress(cancelId,data=>{if(data.stage==='queued'){sawQueued=true;electronAPI.cancelIsolatedWysiwygExport(cancelId)}});
                const cancelled=await electronAPI.isolatedWysiwygExport({requestId:cancelId,params:{...common,outputPath:${JSON.stringify(path.join(output, 'cancel-queued.mp4'))},exportEngine:'pipeline'}}).finally(unsubscribe);
                const results=await Promise.all(jobs);
                if(!sawQueued||!cancelled.cancelled)throw Error('Queued cancellation did not finish');
                if(!results.every(result=>result.output_path))throw Error('Concurrent export did not finish');
                return {results,queued,queuedCancellation:cancelled.cancelled};
            })()`);
            assert.ok(report.batch.queued.length >= 1, 'Global memory budget did not queue any of four 1080p jobs');
            report.frames = await Promise.all(cases.map(async item => ({ engine: item.engine, ...await checkVideo(item.outputPath, 21) })));
            report.afterBatch = await waitIdle();
            assert.equal(report.afterBatch.transportStats.frameControlCalls, 0, 'Pixel frames still traveled through main control IPC');
            assert.ok(report.afterBatch.transportStats.attachedPipelines >= 4);
            report.activeCancellation = await evaluate(`(async()=>{
                const requestId='cancel-active';let requested=false;
                const unsubscribe=electronAPI.onIsolatedWysiwygProgress(requestId,data=>{if(!requested&&data.pct>20){requested=true;electronAPI.cancelIsolatedWysiwygExport(requestId)}});
                const result=await electronAPI.isolatedWysiwygExport({requestId,params:{...${JSON.stringify(common)},customDuration:10,outputPath:${JSON.stringify(path.join(output, 'cancel-active.mp4'))},exportEngine:'pipeline'}}).finally(unsubscribe);
                return {requested,cancelled:result.cancelled===true};
            })()`);
            assert.equal(report.activeCancellation.cancelled, true); report.afterCancellation = await waitIdle();
            // A killed utility must reject its pending controls and a later export must restart it.
            assert.ok(liveService?.child, 'Production export service did not start a utility process');
            report.previousUtilityPid = liveService.child.pid; liveService.child.kill();
            await new Promise(resolve => setTimeout(resolve, 300));
            report.recovered = await evaluate(`electronAPI.isolatedWysiwygExport({requestId:'after-worker-restart',params:{...${JSON.stringify(common)},outputPath:${JSON.stringify(path.join(output, 'recovered.mp4'))},exportEngine:'pipeline'}})`);
            await checkVideo(report.recovered.output_path, 21); report.finalStatus = await waitIdle();
            report.restartedUtilityPid = liveService.child.pid;
            report.startupError = await evaluate(`(async()=>{
                const original=window._reelsStartExportImpl;
                try{
                    window._reelsStartExportImpl=async()=>{throw Error('fixture: startup dependency missing')};
                    const result=await reelsStartExport();
                    return {error:result.error,buttonEnabled:!document.getElementById('reels-export-btn').disabled};
                }finally{window._reelsStartExportImpl=original}
            })()`);
            assert.equal(report.startupError.buttonEnabled, true);
            assert.equal(report.startupError.error, 'fixture: startup dependency missing');
            assert.equal(errorDialogs.length, 1, 'Startup failure did not reach the real native dialog IPC');
            assert.match(errorDialogs[0].detail, /startup dependency missing/);
            report.errorDialogs = errorDialogs.length;
            clearInterval(pingTimer); pingTimer = null;
            assert.ok(pings.length >= 5, 'Window responsiveness was not sampled');
            const sorted = pings.slice().sort((a, b) => a - b);
            report.window = { movements: moves, samples: pings.length, pingP95Ms: sorted[Math.floor(sorted.length * .95)], maxPingMs: Math.max(...pings) };
            assert.ok(report.window.pingP95Ms < 500, 'Main/UI ping p95 exceeded 500ms');
            assert.ok(report.window.maxPingMs < 2500, 'Main/UI stopped responding for at least 2.5 seconds');
            report.pass = true;
            fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
            if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Actual main + utility + native window/export checks\n```json\n' + JSON.stringify(report, null, 2) + '\n```\n');
            console.log(JSON.stringify(report)); finish();
        } catch (error) { clearInterval(pingTimer); finish(error); }
    });
});
require(mainModule);
