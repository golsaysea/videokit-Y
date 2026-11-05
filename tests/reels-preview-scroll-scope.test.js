const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

test('legacy preview service never invokes a transcode command', async () => {
    const { createPreviewService, classifyVideoColorProfile } = require('../electron/services/reels-hdr-preview');
    let called = 0;
    const service = createPreviewService(async () => { called++; throw Error('unexpected ffmpeg'); }, () => { called++; throw Error('unexpected cache'); });
    for (const file of ['a.mp4', 'b.mov', 'c.mkv'].map(name => path.join(os.tmpdir(), name))) {
        assert.equal(await service(file), file);
    }
    assert.equal(called, 0);
    assert.equal(typeof classifyVideoColorProfile, 'function');
});

test('Reels player keeps original local-media URL without proxy parameter', () => {
    const source = fs.readFileSync(path.join(root, 'src/batch-reels.js'), 'utf8');
    const start = source.indexOf('function _toPlayablePath(');
    const end = source.indexOf('\n/**', start);
    assert.ok(start >= 0 && end > start, 'production player path function found');
    const context = {
        window: { electronAPI: { fileExists: () => true, toFileUrl: path => path } },
        URL, _reelsFileExists: () => true, _normalizeWatermarkPath: p => p
    };
    vm.runInNewContext(source.slice(start, end), context);
    const unchanged = 'local-media:///C:/media/video%20one.mp4?foo=bar';
    assert.equal(context._toPlayablePath(unchanged), unchanged);
    const historical = 'local-media:///C:/media/video%20one.mp4?foo=bar&reelsPreview=sdr-v2';
    const got = context._toPlayablePath(historical);
    assert.equal(new URL(got).searchParams.get('reelsPreview'), null);
    assert.equal(new URL(got).searchParams.get('foo'), 'bar');
});

test('scroll shared-style method excludes end and auto/manual status', () => {
    const source = fs.readFileSync(path.join(root, 'src/reels-overlay-panel.js'), 'utf8');
    const start = source.indexOf('    _applyScrollStyleToAllTasks(ov) {');
    const end = source.indexOf('\n    // 根据【样式作用】', start);
    assert.ok(start >= 0 && end > start);
    const method = source.slice(start, end);
    const create = new Function('return ({' + method + '})');
    const panel = create();
    const a = { type: 'scroll', end: 20, scroll_end_auto: false, color: '#fff' };
    const b = { type: 'scroll', end: 45, scroll_end_auto: true, color: '#000' };
    const c = { type: 'scroll', end: 60, scroll_end_auto: true, color: '#000' };
    panel._getStyleApplyScopeTasks = () => [{ overlay: a }, { overlay: b }, { overlay: c }];
    panel._extractScrollStyle = ov => ({ end: ov.end, scroll_end_auto: ov.scroll_end_auto, color: ov.color });
    panel._findMatchingOverlayInTask = task => task.overlay;
    panel._applyScrollStyleToAllTasks(a);
    assert.deepEqual([a.end, b.end, c.end], [20, 45, 60]);
    assert.deepEqual([a.scroll_end_auto, b.scroll_end_auto, c.scroll_end_auto], [false, true, true]);
    assert.equal(b.color, '#fff');
    assert.equal(c.color, '#fff');
});
