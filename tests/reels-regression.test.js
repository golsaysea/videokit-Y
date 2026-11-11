const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadBrowserScript(relPath, sandboxExtras = {}) {
    const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    const windowObj = sandboxExtras.window || {};
    const documentObj = sandboxExtras.document || {
        head: { appendChild() {}, querySelector: () => null },
        body: { appendChild() {} },
        createElement: () => ({
            style: {},
            dataset: {},
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            appendChild() {},
            addEventListener() {},
            setAttribute() {},
            getContext: () => ({
                font: '',
                globalAlpha: 1,
                save() {},
                restore() {},
                beginPath() {},
                closePath() {},
                moveTo() {},
                lineTo() {},
                quadraticCurveTo() {},
                bezierCurveTo() {},
                arc() {},
                arcTo() {},
                rect() {},
                clip() {},
                fill() {},
                stroke() {},
                fillRect() {},
                strokeRect() {},
                clearRect() {},
                fillText() {},
                strokeText() {},
                translate() {},
                rotate() {},
                scale() {},
                setLineDash() {},
                createPattern: () => ({}),
                createLinearGradient: () => ({ addColorStop() {} }),
                createRadialGradient: () => ({ addColorStop() {} }),
                measureText: (txt) => ({ width: String(txt || '').length * 10 }),
            }),
        }),
        getElementById: () => null,
        querySelectorAll: () => [],
    };
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        Promise,
        Map,
        Set,
        URL,
        Math,
        Date,
        Intl,
        JSON,
        Array,
        Object,
        String,
        Number,
        Boolean,
        RegExp,
        Error,
        parseFloat,
        parseInt,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        navigator: { onLine: true },
        Path2D: class MockPath2D {
            constructor(d = '') { this.d = d; }
        },
        FontFace: class MockFontFace {
            constructor(family, source, descriptors = {}) {
                this.family = family;
                this.source = source;
                this.descriptors = descriptors;
            }
            async load() { return this; }
        },
        localStorage: {
            _store: new Map(),
            getItem(k) { return this._store.has(k) ? this._store.get(k) : null; },
            setItem(k, v) { this._store.set(k, String(v)); },
            removeItem(k) { this._store.delete(k); },
        },
        CSS: { escape: (s) => String(s) },
        ...sandboxExtras,
        window: windowObj,
        document: documentObj,
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = sandbox.document;
    sandbox.window.localStorage = sandbox.localStorage;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: relPath });
    return sandbox;
}

test('Item 4: Wide color gamut detection & BT.709 auto-conversion', async () => {
    const hdrPreview = require(path.join(ROOT, 'electron/services/reels-hdr-preview.js'));
    const { classifyVideoColorProfile, buildBt709ConversionFilter, createPreviewService } = hdrPreview;

    // 1. HLG
    const hlg = classifyVideoColorProfile({
        color_transfer: 'arib-std-b67',
        color_primaries: 'bt2020',
        color_space: 'bt2020nc',
        pix_fmt: 'yuv420p10le',
    });
    assert.equal(hlg.needsConversion, true);
    assert.equal(hlg.isHdr, true);
    assert.equal(hlg.reason, 'hlg');
    assert.match(buildBt709ConversionFilter(hlg), /libplacebo=.*colorspace=bt709:color_primaries=bt709:color_trc=bt709/);

    // 2. PQ (SMPTE 2084)
    const pq = classifyVideoColorProfile({
        color_transfer: 'smpte2084',
        color_primaries: 'bt2020',
        color_space: 'bt2020nc',
    });
    assert.equal(pq.needsConversion, true);
    assert.equal(pq.isHdr, true);
    assert.equal(pq.reason, 'pq');

    // 3. BT.2020 SDR
    const bt2020Sdr = classifyVideoColorProfile({
        color_transfer: 'bt709',
        color_primaries: 'bt2020',
        color_space: 'bt2020nc',
    });
    assert.equal(bt2020Sdr.needsConversion, true);
    assert.equal(bt2020Sdr.isHdr, false);
    assert.equal(bt2020Sdr.isWideGamut, true);
    assert.equal(bt2020Sdr.reason, 'bt2020-sdr');

    // 4. Display P3
    const p3 = classifyVideoColorProfile({
        color_transfer: 'iec61966-2-1',
        color_primaries: 'smpte432',
        color_space: 'bt709',
    });
    assert.equal(p3.needsConversion, true);
    assert.equal(p3.isWideGamut, true);
    assert.equal(p3.reason, 'p3');

    // 5. Partial metadata fallback (only matrix or 10-bit wide gamut hint)
    const partial = classifyVideoColorProfile({
        color_transfer: 'unknown',
        color_primaries: '',
        color_space: 'bt2020nc',
    });
    assert.equal(partial.needsConversion, true);
    assert.equal(partial.hasIncompleteMetadata, true);
    assert.equal(partial.safeInputPrimaries, 'bt2020');
    assert.match(buildBt709ConversionFilter(partial), /out_color_matrix=bt709:out_range=tv,format=yuv420p/);

    // 6. Standard BT.709 passthrough
    const bt709 = classifyVideoColorProfile({
        color_transfer: 'bt709',
        color_primaries: 'bt709',
        color_space: 'bt709',
        pix_fmt: 'yuv420p',
    });
    assert.equal(bt709.needsConversion, false);
    assert.equal(bt709.reason, 'bt709');

    // Verify BT.709 video is directly returned without invoking ffmpeg
    const tmpFile = path.join(ROOT, 'package.json'); // existing file on disk
    let ffmpegCalls = 0;
    const prepare = createPreviewService(async (cmd) => {
        if (cmd === 'ffprobe') {
            return {
                stdout: JSON.stringify({
                    streams: [{
                        color_transfer: 'bt709',
                        color_primaries: 'bt709',
                        color_space: 'bt709',
                        pix_fmt: 'yuv420p',
                    }],
                }),
            };
        }
        ffmpegCalls++;
        return { stdout: '' };
    }, () => path.join(ROOT, 'tests/.tmp-cache'));
    const resultPath = await prepare(tmpFile);
    assert.equal(resultPath, tmpFile);
    assert.equal(ffmpegCalls, 0);
});

test('Items 5, 6, 7, 8, 9, 10: T-subtitle style engine, animations, connected box & canvas rendering', () => {
    const sandbox = loadBrowserScript('src/reels-style-engine.js');
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);

    const StyleEngine = sandbox.window.ReelsStyleEngine;
    const AnimEngine = sandbox.window.ReelsAnimEngine;
    const ReelsCanvasRenderer = sandbox.window.ReelsCanvasRenderer;

    // Style defaults & preset compatibility
    const defaultStyle = StyleEngine.DEFAULT_SUBTITLE_STYLE;
    assert.equal(defaultStyle.text_gradient_scope, 'line');
    assert.equal(defaultStyle.uppercase, false);
    assert.equal(defaultStyle.highlight_enabled, true);
    assert.equal(defaultStyle.box_connected, true);
    assert.equal(defaultStyle.box_concave_radius, 10);
    assert.equal(defaultStyle.box_snap_threshold, 18);
    assert.equal(defaultStyle.char_anim_intensity, 1.0);
    assert.equal(defaultStyle.char_anim_duration, 0.28);
    assert.equal(defaultStyle.char_anim_stagger, 0.04);

    // 6 new per-character animations
    const newCharAnims = [
        'char_float_up',
        'char_pop_elastic',
        'char_wave',
        'char_drop_bounce',
        'char_squash_bounce',
        'char_center_spread',
    ];
    for (const animKey of newCharAnims) {
        assert.equal(AnimEngine.isCharAnimType(animKey), true, `${animKey} should be recognized by isCharAnimType`);

        const activeState = AnimEngine.computeCharAnimTransform(animKey, 0.05, 0, 6, 0, 3.0, {
            intensity: 1.5,
            duration: 0.3,
            stagger: 0.04,
            fontSize: 80,
        });
        assert.ok(activeState, `computeCharAnimTransform returned null for ${animKey}`);
        assert.equal(typeof activeState.dx, 'number');
        assert.equal(typeof activeState.dy, 'number');
        assert.equal(typeof activeState.scaleX, 'number');
        assert.equal(typeof activeState.scaleY, 'number');
        assert.equal(typeof activeState.alpha, 'number');
    }

    // Connected adaptive box path & snap threshold
    const drawnTexts = [];
    const gradientSpans = [];
    const fillStyles = [];
    const arcToCorners = [];
    const mockCtx = {
        canvas: { width: 1080, height: 1920 },
        font: '700 74px "Arial", sans-serif',
        textBaseline: 'top',
        lineJoin: 'round',
        miterLimit: 2,
        lineWidth: 1,
        strokeStyle: '#000',
        _fillStyle: '#fff',
        get fillStyle() { return this._fillStyle; },
        set fillStyle(v) { this._fillStyle = v; fillStyles.push(v); },
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        arcTo(x1, y1, x2, y2, r) { arcToCorners.push({ x1, y1, x2, y2, r }); },
        quadraticCurveTo() {},
        fill() {},
        stroke() {},
        fillRect() {},
        clearRect() {},
        measureText: (txt) => ({
            width: String(txt || '').length * 20,
            actualBoundingBoxAscent: 55,
            actualBoundingBoxDescent: 15,
        }),
        createLinearGradient: (x0, y0, x1, y1) => {
            const g = { x0, y0, x1, y1, stops: [], addColorStop(p, c) { this.stops.push([p, c]); } };
            gradientSpans.push(g);
            return g;
        },
        fillText: (txt) => { drawnTexts.push(String(txt)); },
        strokeText: () => {},
    };
    const mockCanvas = {
        width: 1080,
        height: 1920,
        getContext: () => mockCtx,
    };
    const renderer = new ReelsCanvasRenderer(mockCanvas);

    // 1) Adjacent lines within snapThreshold=18 align into a single 4-corner outer contour
    arcToCorners.length = 0;
    renderer._buildConnectedAdaptiveBoxPath(
        mockCtx,
        [
            { left: 100, right: 400, top: 200, bottom: 260 },
            { left: 106, right: 394, top: 264, bottom: 324 }, // diff=6 <= 18
        ],
        12,
        10,
        18
    );
    assert.equal(arcToCorners.length, 4, 'Adjacent lines within snapThreshold should snap into 4 outer corners without small steps');

    // 2) Adjacent lines differing beyond snapThreshold=18 form an 8-corner stepped connected contour (with concave radius)
    arcToCorners.length = 0;
    renderer._buildConnectedAdaptiveBoxPath(
        mockCtx,
        [
            { left: 100, right: 500, top: 200, bottom: 260 },
            { left: 180, right: 420, top: 264, bottom: 324 }, // diff=80 > 18
        ],
        12,
        9,
        18
    );
    assert.equal(arcToCorners.length, 8, 'Lines differing beyond snapThreshold should form a connected contour with 8 corners');
    assert.ok(arcToCorners.some(c => Math.abs(c.r - 9) < 0.01), 'Concave corners should use concaveRadius');

    // Non-destructive uppercase, highlight toggle, and line vs word gradient rendering
    const segment = {
        start: 0,
        end: 5,
        text: 'hello world',
        words: [
            { word: 'hello', start: 0, end: 2 },
            { word: 'world', start: 2, end: 5 },
        ],
    };

    const styleLineGrad = StyleEngine.mergeStyle({
        uppercase: true,
        highlight_enabled: false,
        color_text: '#ff0000,#00ff00',
        color_high: '#ff00ff',
        text_gradient_scope: 'line',
        text_gradient_direction: 'horizontal',
        anim_in_type: 'none',
    });

    drawnTexts.length = 0;
    gradientSpans.length = 0;
    fillStyles.length = 0;
    renderer.renderSubtitle(styleLineGrad, segment, 1.0, 1080, 1920);

    // Original segment must remain lowercase (non-destructive)
    assert.equal(segment.text, 'hello world');
    assert.equal(segment.words[0].word, 'hello');
    assert.equal(segment.words[1].word, 'world');
    // Rendered text must be uppercase (drawn either whole-word or per-char when letter_spacing > 0)
    const combinedDrawn = drawnTexts.join('');
    assert.ok(combinedDrawn.includes('HELLO'), 'Expected HELLO to be drawn when uppercase=true');
    assert.ok(combinedDrawn.includes('WORLD'), 'Expected WORLD to be drawn when uppercase=true');
    assert.equal(combinedDrawn.includes('hello'), false);
    // Highlight color should NOT be used when highlight_enabled=false
    assert.equal(fillStyles.includes('#ff00ff'), false);
    // Line gradient span should cover the full line width (> single word width)
    const lineGradSpan = Math.max(...gradientSpans.map(g => Math.abs(g.x1 - g.x0)));
    gradientSpans.length = 0;

    const styleWordGrad = StyleEngine.mergeStyle({
        uppercase: true,
        highlight_enabled: false,
        color_text: '#ff0000,#00ff00',
        text_gradient_scope: 'word',
        text_gradient_direction: 'horizontal',
        anim_in_type: 'none',
    });
    renderer.renderSubtitle(styleWordGrad, segment, 1.0, 1080, 1920);
    const wordGradSpan = Math.max(...gradientSpans.map(g => Math.abs(g.x1 - g.x0)));
    assert.ok(lineGradSpan > wordGradSpan, `Expected line gradient span (${lineGradSpan}) > word gradient span (${wordGradSpan})`);
});

test('Items 11 & 12: Unified font catalog, change detection, and Google Fonts on-demand cache', async () => {
    const scanFontsArgs = [];
    const selectEls = new Map();
    const expectedIds = [
        'reels-font-family',
        'reels-fullpage-typewriter-title-font',
        'rop-font',
        'rop-title-font',
        'rop-body-font',
        'rop-footer-font',
        'rop-scroll-title-font',
        'rop-scroll-font',
    ];
    for (const id of expectedIds) {
        const parent = {
            classList: { contains: () => true },
            querySelector: () => ({ textContent: '', style: {} }),
            insertBefore() {},
            appendChild() {},
        };
        selectEls.set(id, {
            id,
            value: 'Montserrat',
            innerHTML: '',
            style: {},
            dataset: {},
            selectedOptions: [{ textContent: 'Montserrat' }],
            parentElement: parent,
            classList: { add() {}, remove() {}, contains: () => false },
            appendChild() {},
        });
    }

    const appendedLinks = [];
    const sandbox = loadBrowserScript('src/reels-font-manager.js', {
        window: {
            addEventListener() {},
            electronAPI: {
                scanFonts: async (opts) => {
                    scanFontsArgs.push(opts || {});
                    return [
                        { family: 'CustomEmbeddedFont', path: 'C:/fonts/custom.ttf', system: false },
                        { family: 'Arial', path: 'C:/Windows/Fonts/arial.ttf', system: true },
                    ];
                },
                fetchGoogleFonts: async () => ")]}'\n" + JSON.stringify({ familyMetadataList: [] }),
                toFileUrl: (p) => `file:///${String(p).replace(/\\/g, '/')}`,
            },
        },
        document: {
            head: {
                appendChild: (el) => {
                    appendedLinks.push(el);
                    if (typeof el.onload === 'function') el.onload();
                },
                querySelector: (sel) => {
                    const m = sel.match(/href="([^"]+)"/);
                    if (!m) return null;
                    return appendedLinks.find(l => l.href === m[1]) || null;
                },
            },
            body: { appendChild() {} },
            fonts: { add() {}, load: async () => {}, ready: Promise.resolve() },
            getElementById: (id) => selectEls.get(id) || null,
            querySelectorAll: (sel) => {
                if (sel.startsWith('#')) {
                    const el = selectEls.get(sel.slice(1));
                    return el ? [el] : [];
                }
                return [];
            },
            createElement: (tag) => ({
                tagName: tag,
                style: {},
                dataset: {},
                innerHTML: '',
                children: [],
                classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
                appendChild(c) { this.children.push(c); },
                remove() {},
                addEventListener() {},
                getContext: () => ({
                    font: '',
                    measureText: (txt) => ({ width: String(txt || '').length * 10 }),
                }),
            }),
        },
    });

    assert.deepEqual(Array.from(sandbox.window.UNIFIED_FONT_SELECT_IDS), expectedIds);

    const fm = sandbox.window.getFontManager();
    await fm.register();
    assert.equal(scanFontsArgs.length, 1);

    const catalog = fm.getUnifiedFontCatalog();
    assert.ok(catalog.groups.embedded.includes('CustomEmbeddedFont'));
    assert.ok(catalog.groups.system.includes('Arial'));
    assert.ok(catalog.groups.google.length > 0);

    // Calling refreshCatalogIfChanged(true) passes skipSystemRescan: true so Windows fonts are not rescanned
    await fm.refreshCatalogIfChanged(true);
    assert.equal(scanFontsArgs.length, 2);
    assert.equal(scanFontsArgs[1].skipSystemRescan, true);

    // Google Font on-demand load should deduplicate stylesheet injection
    const linksBefore = appendedLinks.length;
    await Promise.all([fm.loadGoogleFont(' Anton '), fm.loadGoogleFont('Anton')]);
    const antonLinks = appendedLinks.slice(linksBefore).filter(l => String(l.href || '').includes('Anton'));
    assert.equal(antonLinks.length, 1, 'Google Font stylesheet should only be injected once per family');
});

test('Item 13: Scroll text real-time preview responds immediately to uppercase and letter spacing', () => {
    const drawnTexts = [];
    const mockCtx = {
        canvas: { width: 1080, height: 1920 },
        font: '',
        direction: 'ltr',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        fillStyle: '#fff',
        strokeStyle: '#000',
        lineWidth: 1,
        lineJoin: 'round',
        miterLimit: 2,
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
        beginPath() {},
        closePath() {},
        rect() {},
        fillRect() {},
        clearRect() {},
        drawImage() {},
        clip() {},
        moveTo() {},
        lineTo() {},
        arcTo() {},
        quadraticCurveTo() {},
        fill() {},
        stroke() {},
        strokeRect() {},
        setLineDash() {},
        arc() {},
        ellipse() {},
        bezierCurveTo() {},
        createPattern: () => ({}),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        measureText: (txt) => ({ width: String(txt || '').length * 18 }),
        fillText: (txt) => { drawnTexts.push(String(txt)); },
        strokeText: () => {},
    };

    const sandbox = loadBrowserScript('src/reels-overlay.js', {
        document: {
            createElement: () => ({
                width: 1080,
                height: 1920,
                style: {},
                dataset: {},
                classList: { add() {}, remove() {}, contains: () => false },
                appendChild() {},
                getContext: () => mockCtx,
            }),
        },
    });
    const ReelsOverlay = sandbox.window.ReelsOverlay;

    const ov = ReelsOverlay.createScrollOverlay({
        content: 'hello scroll world test line wrapping',
        scroll_uppercase: false,
        scroll_letter_spacing: 0,
        fontsize: 36,
        text_width: 300,
        start: 0,
        end: 10,
        _exporting: true,
    });

    ReelsOverlay.drawOverlay(mockCtx, ov, 1.0, 1080, 1920);
    assert.ok(drawnTexts.some(t => t.includes('hello')), 'Should draw lowercase when scroll_uppercase=false');

    // Toggle scroll_uppercase to true without changing fontsize
    drawnTexts.length = 0;
    ov.scroll_uppercase = true;
    ReelsOverlay.drawOverlay(mockCtx, ov, 1.0, 1080, 1920);
    assert.ok(drawnTexts.some(t => t.includes('HELLO')), 'Should immediately draw uppercase when scroll_uppercase=true without changing fontsize');

    // Increase scroll_letter_spacing without changing fontsize -> more wrapped lines
    const linesBefore = drawnTexts.length;
    drawnTexts.length = 0;
    ov.scroll_letter_spacing = 25;
    ReelsOverlay.drawOverlay(mockCtx, ov, 1.0, 1080, 1920);
    assert.ok(drawnTexts.length > linesBefore, 'Increasing scroll_letter_spacing should immediately re-wrap and draw with new spacing');

    // Verify reels-overlay-panel.js binds rop-scroll-uppercase & rop-scroll-letterspacing
    const panelCode = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    assert.match(panelCode, /rop-scroll-uppercase/);
    assert.match(panelCode, /rop-scroll-letterspacing/);
});

test('Items 1, 2, 3: Batch Reels workspace persistence on delete, natural sort, thumbnail concurrency & focus stability', () => {
    // 1. Deleted tasks must not reappear when workspace is saved with 0 tasks
    const os = require('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-regression-'));
    try {
        // Test countWorkspaceTasks and readUnifiedBatchWorkspace empty-workspace priority logic
        const sharedProfile = require(path.join(ROOT, 'electron/services/sharedProfile.js'));
        assert.equal(sharedProfile.countWorkspaceTasks({ tabs: [{ id: 'tab_1', tasks: [] }] }), 0);
        assert.equal(sharedProfile.countWorkspaceTasks({ tabs: [{ id: 'tab_1', tasks: [{ id: 't1' }] }] }), 1);

        const sharedProfileCode = fs.readFileSync(path.join(ROOT, 'electron/services/sharedProfile.js'), 'utf8');
        assert.match(sharedProfileCode, /newestOverall\.taskCount\s*===\s*0/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // 2. Verify static thumbnail cache, concurrency limiter, single hover video, and row-targeted drop in reels-batch-table.js
    const batchTableCode = fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8');
    assert.match(batchTableCode, /_rbtResolveStaticVideoThumbnail/);
    assert.match(batchTableCode, /_rbtRunWithThumbConcurrency/);
    assert.match(batchTableCode, /stopHoverPreviewVideo/);
    assert.match(batchTableCode, /reelsSyncTaskRemovalToBatchTabs/);
    assert.match(batchTableCode, /isRowDirectBgDrop/);

    // 3. Verify overlay template name focus protection in reels-overlay-panel.js & reels-bulk-create.js
    const overlayPanelCode = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    assert.match(overlayPanelCode, /ropEditorEventGuard/);
    assert.match(overlayPanelCode, /rop-tpl-name-input/);

    // 4. Verify reverse-dropped audio files keep their native paths paired and sort into 019..023
    const fnMatch = batchTableCode.match(/function _naturalSortByName\(a,\s*b\)\s*\{[\s\S]*?\n\}/);
    assert.ok(fnMatch, '_naturalSortByName should exist in reels-batch-table.js');
    const naturalSortByName = new Function(`return (${fnMatch[0]})`)();

    const reverseDroppedNames = [
        '023_Imagine Jesus smiling at you as you share this verse.mp3',
        '022_Your daughter needs this prayer today.mp3',
        '021_Oh my God, woman watching this, stop for a second.mp3',
        '020_Repeat after me.mp3',
        '019_A warning from God, but 99_ will skip it.mp3',
    ];
    const droppedPaths = reverseDroppedNames.map(n => `C:\\Users\\User\\Audio\\${n}`);
    const rawFiles = reverseDroppedNames.map(n => ({ name: n }));
    rawFiles.forEach((f, idx) => { f._nativePath = droppedPaths[idx]; });
    const sortedFiles = rawFiles.sort(naturalSortByName);

    assert.deepEqual(
        sortedFiles.map(f => f._nativePath.split('\\').pop()),
        [
            '019_A warning from God, but 99_ will skip it.mp3',
            '020_Repeat after me.mp3',
            '021_Oh my God, woman watching this, stop for a second.mp3',
            '022_Your daughter needs this prayer today.mp3',
            '023_Imagine Jesus smiling at you as you share this verse.mp3',
        ]
    );

    // 5. Verify ReelsOverlayPanel defines _esc and all this._xxx() methods, and renders preset select & scroll overlay list
    const vm = require('node:vm');
    const selectEl = { value: '', innerHTML: '' };
    const listEl = {
        innerHTML: '',
        querySelectorAll: () => [],
    };
    const mockContainer = {
        innerHTML: '',
        querySelector: (sel) => {
            if (sel === '#rop-group-preset-select') return selectEl;
            if (sel === '#rop-overlay-list') return listEl;
            return null;
        },
        querySelectorAll: () => [],
    };
    const panelSandbox = {
        window: {},
        document: {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
            createElement: () => ({ textContent: '', id: '' }),
            head: { appendChild: () => {} },
        },
        localStorage: {
            getItem: (k) => k === 'reels_overlay_group_presets'
                ? JSON.stringify({ '下滚定版': [{ type: 'scroll', content: 'Amen' }] })
                : null,
            setItem: () => {},
        },
        requestAnimationFrame: (cb) => { cb(); return 1; },
        cancelAnimationFrame: () => {},
        console,
    };
    panelSandbox.window = panelSandbox;
    vm.createContext(panelSandbox);
    vm.runInContext(`${overlayPanelCode}\nwindow.ReelsOverlayPanel = ReelsOverlayPanel;`, panelSandbox);

    const ReelsOverlayPanel = panelSandbox.ReelsOverlayPanel;
    assert.equal(typeof ReelsOverlayPanel.prototype._esc, 'function', 'ReelsOverlayPanel.prototype._esc must be a function');
    assert.equal(ReelsOverlayPanel.prototype._esc('<script>"test"</script>'), '&lt;script&gt;&quot;test&quot;&lt;/script&gt;');

    const fakePanel = Object.create(ReelsOverlayPanel.prototype);
    fakePanel.container = mockContainer;
    fakePanel._selectedOv = { id: 'ov_scroll_1' };
    fakePanel.videoCanvas = {
        overlayMgr: {
            overlays: [
                { id: 'ov_scroll_1', type: 'scroll', content: '滚动字幕内容测试' },
            ],
        },
    };

    fakePanel._refreshOverlayGroupPresetSelect();
    assert.match(selectEl.innerHTML, /下滚定版/, 'Preset select should render custom presets from reels_overlay_group_presets');

    fakePanel._refreshList();
    assert.match(listEl.innerHTML, /ov_scroll_1/, 'Overlay list should render scroll overlay item');
    assert.match(listEl.innerHTML, /滚动: 滚动字幕内容测试/, 'Overlay list should display scroll overlay label');

    // 6. Verify CodeCacheGuard rotates stale Code Cache on version upgrade or incomplete boot while preserving user projects & presets
    const codeCacheGuard = require(path.join(ROOT, 'electron/services/codeCacheGuard.js'));
    const cacheTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-codecache-'));
    try {
        const codeCacheDir = path.join(cacheTestDir, 'Code Cache');
        const presetsDir = path.join(cacheTestDir, 'videokit-presets');
        fs.mkdirSync(path.join(codeCacheDir, 'js'), { recursive: true });
        fs.writeFileSync(path.join(codeCacheDir, 'js', 'stale_bytecode'), 'old-v8-cache', 'utf8');
        fs.mkdirSync(presetsDir, { recursive: true });
        fs.writeFileSync(path.join(presetsDir, 'local-storage-presets.json'), '{"keep":true}', 'utf8');

        // First upgrade from untracked version with existing Code Cache -> should rotate
        const firstRun = codeCacheGuard.ensureFreshCodeCacheOnStartup({
            userDataDir: cacheTestDir,
            appVersion: '4.4.43-fix',
            electronVersion: '33.4.11',
            chromeVersion: '130.0.0',
            isPackaged: true,
        });
        assert.equal(firstRun.rotated, true, 'Should rotate existing Code Cache on first tracked upgrade');
        assert.equal(fs.existsSync(codeCacheDir), false, 'Old Code Cache should be moved out of the way');
        assert.ok(fs.existsSync(firstRun.backupPath), 'Backup Code Cache directory should be preserved');
        assert.equal(
            fs.readFileSync(path.join(presetsDir, 'local-storage-presets.json'), 'utf8'),
            '{"keep":true}',
            'User presets and project files must never be modified'
        );

        // Recreate Code Cache as Chromium would, then run again with same version -> should NOT rotate
        fs.mkdirSync(codeCacheDir, { recursive: true });
        const secondRun = codeCacheGuard.ensureFreshCodeCacheOnStartup({
            userDataDir: cacheTestDir,
            appVersion: '4.4.43-fix',
            electronVersion: '33.4.11',
            chromeVersion: '130.0.0',
            isPackaged: true,
        });
        assert.equal(secondRun.rotated, false, 'Should not rotate Code Cache when version and runtime are unchanged');
        assert.equal(fs.existsSync(codeCacheDir), true, 'Code Cache should remain intact on normal launch');

        // Simulate version update -> should rotate Code Cache AND clear GPUCache / DawnGraphiteCache / DawnWebGPUCache
        fs.mkdirSync(path.join(cacheTestDir, 'GPUCache'), { recursive: true });
        fs.writeFileSync(path.join(cacheTestDir, 'GPUCache', 'shader.bin'), 'stale-gpu', 'utf8');
        const upgradeRun = codeCacheGuard.ensureFreshCodeCacheOnStartup({
            userDataDir: cacheTestDir,
            appVersion: '4.4.44',
            electronVersion: '33.4.11',
            chromeVersion: '130.0.0',
            isPackaged: true,
        });
        assert.equal(upgradeRun.rotated, true, 'Should rotate Code Cache when appVersion changes');
        assert.equal(fs.existsSync(path.join(cacheTestDir, 'GPUCache')), false, 'Should clear auxiliary GPUCache on version upgrade');

        // Verify main.js and updater.js post-update startup & white-screen recovery guards
        const mainJsSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
        assert.ok(
            mainJsSrc.includes('typeof window.switchTab === "function" && window._reelsState') ||
            mainJsSrc.includes('typeof window.reelsSelectTask === "function" && typeof window.ReelsStyleEngine?.mergeStyle === "function" && window._reelsState'),
            'main.js must verify JS bundle execution, not just static HTML DOM'
        );
        assert.ok(mainJsSrc.includes('app._updateRestartApproved'), 'main.js close handler must not block update restart');
        assert.ok(mainJsSrc.includes('app.releaseSingleInstanceLock()'), 'main.js must release single-instance lock on quit/close');
        const updaterJsSrc = fs.readFileSync(path.join(ROOT, 'electron/updater.js'), 'utf8');
        assert.ok(updaterJsSrc.includes('await prepareForUpdateRestart()'), 'updater.js must flush workspace and release locks before quitAndInstall');
        assert.ok(updaterJsSrc.includes('autoUpdater.quitAndInstall(false, true)'), 'updater.js must pass isForceRunAfter=true to quitAndInstall');
    } finally {
        fs.rmSync(cacheTestDir, { recursive: true, force: true });
    }
});




test('Mixed typography presets retain settings, reveal cumulatively, and keep stable layout', () => {
    const sandbox = loadBrowserScript('src/reels-style-engine.js', { window: { addEventListener() {} } });
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);
    const engine = sandbox.window.ReelsStyleEngine;
    const presets = sandbox.window.REELS_BUILTIN_PRESETS;
    const ctx = { globalAlpha: 1, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
        measureText(text) { return { width: String(text).length * (parseFloat(this.font.match(/([\d.]+)px/)[1])) * .6 }; } };
    const renderer = new sandbox.window.ReelsCanvasRenderer({ getContext: () => ctx });
    let drawn = [];
    renderer._drawWord = (_, text, x, y) => drawn.push({ text, x, y, font: ctx.font });
    const words = 'I thank you for this 14th day of October'.split(' ');
    const seg = { start: 0, end: 10, text: words.join(' '), words: words.map((word, i) => ({ word, start: i, end: i + .8 })) };
    for (const [name, preset] of Object.entries(presets).filter(([name]) => name.startsWith('动态混排'))) {
        const style = engine.mergeStyle(preset);
        assert.equal(engine.saveNamedSubtitlePreset('test mixed', style), true);
        assert.equal(engine.applySubtitlePreset('test mixed').mixed_layout, preset.mixed_layout);
        drawn = []; renderer.renderSubtitle(style, seg, .4, 1080, 1920);
        assert.deepEqual(drawn.map(x => x.text), ['I'], name);
        const first = drawn[0];
        drawn = []; renderer.renderSubtitle(style, seg, 9, 1080, 1920);
        assert.deepEqual(drawn.map(x => x.text), words, name);
        assert.deepEqual(drawn[0], first, 'revealing later words must not move earlier words');
        assert.ok(drawn.every(x => Number.isFinite(x.x) && Number.isFinite(x.y)));
        drawn = []; renderer.renderSubtitle(style, seg, 10, 1080, 1920);
        assert.equal(drawn.length, 0, 'group clears at end');
        drawn = []; renderer.renderSubtitle(style, { ...seg, edited_text: 'Changed script' }, 9, 1080, 1920);
        assert.deepEqual(drawn.map(x => x.text), ['Changed', 'script']);
    }
    assert.equal(engine.applySubtitlePreset('默认白字').mixed_layout, 'none');
    drawn = [];
    renderer.renderSubtitle(engine.mergeStyle({ mixed_layout: 'stack' }), { start: 0, end: 3, text: '中文混排测试' }, 2.99, 1080, 1920);
    assert.equal(drawn.map(x => x.text).join(''), '中文混排测试');

    // Smart copy-adaptive behavior:
    // 1) Long 13-word sentence never leaves a 1-word orphan screen
    const longWords = 'Stop scrolling right now, because God hears every single prayer you whisper today'.split(' ');
    const longTokens = longWords.map((w, i) => ({
        text: w,
        clean: w.replace(/\W+/g, '').toLowerCase(),
        start: i * 0.5,
        end: (i + 1) * 0.5,
        isCjk: false,
        hasClauseBreak: w.endsWith(','),
        hasStrongBreak: false,
        weight: renderer._scoreMixedLayoutToken({ text: w }, i, longWords.length),
    }));
    const groups = renderer._partitionMixedLayoutGroups(longTokens);
    assert.ok(groups.length >= 2, '13-word sentence should split into multiple readable screens');
    assert.ok(groups.every(g => g.length >= 3), 'No screen group should be a 1-word or 2-word orphan');

    // 2) Focus mode picks impact keyword ("prayer") over stop words ("for", "a") and centers rows
    const shortWords = ['Wait', 'for', 'a', 'miracle', 'today'];
    const shortTokens = shortWords.map((w, i) => ({
        text: w,
        clean: w.toLowerCase(),
        weight: renderer._scoreMixedLayoutToken({ text: w }, i, shortWords.length),
    }));
    const focusRows = renderer._buildSmartMixedRows(shortTokens, 'focus');
    assert.equal(focusRows.length, 3, '5-word focus phrase should build a clean 3-row poster');
    const heroRow = focusRows.find(r => r.emphasisFlags.every(Boolean));
    assert.ok(heroRow && heroRow.tokens.some(t => t.clean === 'miracle'), 'Hero focus row should highlight the keyword "miracle"');

    // 3) 4 short balanced words -> Left-Right-Left-Right interleaved [词1] / [词2] / [词3] / [词4]
    drawn = [];
    renderer.renderSubtitle(
        engine.mergeStyle({ mixed_layout: 'cycle' }),
        { start: 0, end: 4, text: 'Stop and pray now' },
        3.9,
        1080,
        1920
    );
    assert.deepEqual(drawn.map(x => x.text), ['Stop', 'and', 'pray', 'now']);
    assert.equal(drawn[0].x, 0, '[词1] should be on the left column');
    assert.ok(drawn[1].x > 0, '[词2] should be staggered to the right column');
    assert.equal(drawn[2].x, 0, '[词3] should be on the left column');
    assert.equal(drawn[3].x, drawn[1].x, '[词4] should align with [词2] on the right column');

    // 4) 4 words with a long word + short word -> must NOT use 4-row Left-Right-Left-Right zigzag
    const mismatchWords = ['Wait', 'for', 'breakthrough', 'now'];
    const mismatchTokens = mismatchWords.map((w, i) => ({
        text: w,
        clean: w.toLowerCase(),
        isCjk: false,
        weight: renderer._scoreMixedLayoutToken({ text: w }, i, mismatchWords.length),
    }));
    assert.equal(renderer._isFourShortWordsBalanced(mismatchTokens), false, 'Long word + short word should not qualify as 4 balanced short words');
    assert.notEqual(renderer._selectSmartMixedMode(mismatchTokens, 'cycle', 1), 'stairs', 'Cycle mode should avoid stairs when 4 words have long+short mismatch');
    const mismatchStairsRows = renderer._buildSmartMixedRows(mismatchTokens, 'stairs');
    assert.ok(mismatchStairsRows.length < 4, 'Even in explicit stairs mode, 4 words with long+short mismatch should group into <4 rows');

    // 5) Stack mode (top big / middle small / bottom big) packs middle short words together onto one row
    const stackWords = ['Stop', 'right', 'now', 'and', 'pray'];
    const stackTokens = stackWords.map((w, i) => ({
        text: w,
        clean: w.toLowerCase(),
        isCjk: false,
        weight: renderer._scoreMixedLayoutToken({ text: w }, i, stackWords.length),
    }));
    const stackRows = renderer._buildSmartMixedRows(stackTokens, 'stack');
    assert.equal(stackRows.length, 3, '5-word stack phrase should pack middle words onto a single middle row (3 rows total)');
    assert.deepEqual(stackRows[0].tokens.map(t => t.text), ['Stop']);
    assert.deepEqual(stackRows[1].tokens.map(t => t.text), ['right', 'now', 'and'], 'Middle row should combine all 3 short words together');
    assert.deepEqual(stackRows[2].tokens.map(t => t.text), ['pray']);

    // 6) Mixed layout pairs with rich entrance/exit animations without shifting word coordinates
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    const baselineDrawn = [];
    renderer._drawWord = (_, text, x, y) => baselineDrawn.push({ text, x, y, font: ctx.font });
    renderer.renderSubtitle(
        engine.mergeStyle({ mixed_layout: 'stack', anim_in_type: 'none', anim_out_type: 'none' }),
        { start: 0, end: 5, text: 'Stop right now and pray' },
        4.6,
        1080,
        1920
    );
    for (const animType of ['fade', 'slide_up', 'slide_left', 'pop', 'word_pop_random_pulse', 'char_bounce', 'letter_jump', 'floating', 'bullet_reveal', 'blur_sharp']) {
        drawn = [];
        renderer._drawWord = (_, text, x, y) => drawn.push({ text, x, y, font: ctx.font });
        renderer.renderSubtitle(
            engine.mergeStyle({
                mixed_layout: 'stack',
                anim_in_type: animType,
                anim_in_duration: 0.3,
                anim_out_type: 'pop',
                anim_out_duration: 0.25,
            }),
            { start: 0, end: 5, text: 'Stop right now and pray' },
            4.6,
            1080,
            1920
        );
        assert.deepEqual(drawn, baselineDrawn, `Mixed layout coordinates must remain identical with anim_in_type=${animType}`);
    }
    // Bullet reveal reveals the entire middle row ('right now and') together when the first word of that row starts
    drawn = [];
    renderer.renderSubtitle(
        engine.mergeStyle({ mixed_layout: 'stack', anim_in_type: 'bullet_reveal', anim_in_duration: 0.25 }),
        { start: 0, end: 5, text: 'Stop right now and pray' },
        1.2,
        1080,
        1920
    );
    assert.deepEqual(drawn.map(x => x.text), ['Stop', 'right', 'now', 'and'], 'bullet_reveal should reveal the whole middle row together');

    // 7) Read-along highlight (朗读高亮) tracks the active spoken word across gaps and toggles cleanly on first click
    const coloredDraws = [];
    renderer._drawWord = (_, text, x, y, color) => coloredDraws.push({ text, x, y, color });
    const gapSeg = {
        start: 0,
        end: 3,
        text: 'Stop and pray',
        words: [
            { word: 'Stop', start: 0.15, end: 0.60 },
            { word: 'and', start: 0.95, end: 1.35 },
            { word: 'pray', start: 1.75, end: 2.30 },
        ],
    };
    const hlOnStyle = engine.mergeStyle({
        mixed_layout: 'stack',
        color_text: '#FFFFFF',
        color_high: '#FFD700',
        highlight_enabled: true,
        karaoke_highlight: true,
    });
    // At t=0.0 (paused at segment start before words[0].start=0.15): first word appears and is highlighted
    coloredDraws.length = 0;
    renderer.renderSubtitle(hlOnStyle, gapSeg, 0.0, 1080, 1920);
    assert.deepEqual(coloredDraws.map(d => ({ text: d.text, color: d.color })), [
        { text: 'Stop', color: '#FFD700' },
    ]);
    // At t=0.75 (inside silence gap between 'Stop' end=0.60 and 'and' start=0.95): 'Stop' stays highlighted
    coloredDraws.length = 0;
    renderer.renderSubtitle(hlOnStyle, gapSeg, 0.75, 1080, 1920);
    assert.deepEqual(coloredDraws.map(d => ({ text: d.text, color: d.color })), [
        { text: 'Stop', color: '#FFD700' },
    ]);
    // At t=2.0 (speaking 'pray'): only 'pray' is highlighted in #FFD700, earlier emphasis word 'Stop' returns to #FFFFFF
    coloredDraws.length = 0;
    renderer.renderSubtitle(hlOnStyle, gapSeg, 2.0, 1080, 1920);
    assert.deepEqual(coloredDraws.map(d => ({ text: d.text, color: d.color })), [
        { text: 'Stop', color: '#FFFFFF' },
        { text: 'and', color: '#FFFFFF' },
        { text: 'pray', color: '#FFD700' },
    ]);
    // Toggling highlight_enabled=false immediately turns all words to color_text (#FFFFFF)
    coloredDraws.length = 0;
    renderer.renderSubtitle({ ...hlOnStyle, highlight_enabled: false }, gapSeg, 2.0, 1080, 1920);
    assert.ok(coloredDraws.every(d => d.color === '#FFFFFF'), 'All words should use color_text when highlight_enabled is false');

    // 8) Microsoft Edge-TTS uses Sec-MS-GEC v2 token format and keys preview cache by voice/rate/pitch
    const edgeTtsSrc = fs.readFileSync(path.join(ROOT, 'electron/services/edgeTts.js'), 'utf8');
    assert.ok(edgeTtsSrc.includes('`2-${CHROMIUM_FULL_VERSION}`'), 'edgeTts.js must use Sec-MS-GEC-Version v2');
    assert.ok(edgeTtsSrc.includes('_cs64Digest(strToHash, digest)'), 'edgeTts.js must generate CS64+SHA256 Sec-MS-GEC v2 tokens');
    const msTtsSrc = fs.readFileSync(path.join(ROOT, 'src/microsoft-tts.js'), 'utf8');
    assert.ok(msTtsSrc.includes('row._previewCacheKey === cacheKey'), 'microsoft-tts.js must key preview cache by voice, rate, pitch, and text');

    // 9) Google TTS service & standalone Google Voice Studio tab support Gemini AI voices, Cloud TTS voices, and 20-preset keyless Google Translate voices
    const googleTts = require(path.join(ROOT, 'electron/services/googleTts.js'));
    assert.equal(googleTts.GEMINI_VOICES.length, 30, 'Should provide 30 prebuilt Gemini AI voices');
    assert.equal(googleTts.GEMINI_PERSONA_VOICES.length, 24, 'Should provide 24 curated Gemini persona voices');
    assert.ok(googleTts.GOOGLE_CLOUD_VOICES.length >= 40, 'Should provide flagship Google Cloud TTS voices');
    assert.ok(googleTts.GOOGLE_TRANSLATE_VOICES.length >= 50, 'Should provide 52 keyless Google Translate locales');
    assert.equal(googleTts.GOOGLE_TRANSLATE_VOICE_PRESETS.length, 20, 'Should provide 20 Female & Male presets per locale in keyless mode');
    const wavBuf = googleTts.wrapPcm16ToWav(Buffer.alloc(4800), 24000, 1);
    assert.equal(wavBuf.subarray(0, 4).toString('ascii'), 'RIFF', 'wrapPcm16ToWav should produce valid RIFF WAV header');
    assert.equal(wavBuf.length, 4844, 'wrapPcm16ToWav should add 44-byte WAV header');
    const indexHtml = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    assert.ok(indexHtml.includes('data-tab="google-tts"'), 'index.html should include the 谷歌配音 tab button');
    assert.ok(indexHtml.includes('id="google-tts-panel"'), 'index.html should include the #google-tts-panel container');
    assert.ok(indexHtml.includes('id="gemini-tts-keys"'), 'index.html should include the dedicated #gemini-tts-keys setting in Settings');
    assert.ok(indexHtml.includes('id="gg-api-keys"'), 'index.html should include the inline #gg-api-keys drawer in Google Voice Studio');
    assert.ok(indexHtml.includes('src="google-tts.js"'), 'index.html should load google-tts.js');

    // 10) Clearing or replacing background media purges timeline/renderPlan cache, resets video alignment state, and clears v2 transcription & HDR preview caches
    const ReelsRenderPlan = require(path.join(ROOT, 'src/reels-render-plan.js'));
    const ReelsTaskDerivation = require(path.join(ROOT, 'src/reels-task-derivation.js'));

    const cachedTask = {
        bgPath: 'C:/videos/old_cached.mp4',
        videoPath: 'C:/videos/old_cached.mp4',
        audioPath: 'C:/audio/voice.mp3',
    };
    ReelsRenderPlan.syncLegacyFields(cachedTask);
    const getBgClipPaths = (tl) => tl.tracks
        .flatMap(t => t.clips || [])
        .filter(c => c._extra?.role === 'background')
        .map(c => tl.sources[c.sourceId]?.path);
    assert.deepEqual(getBgClipPaths(cachedTask.timeline), ['C:/videos/old_cached.mp4']);

    // Replacing bgPath with a new video must update timeline tracks and never revert to old_cached.mp4 on syncLegacyFields
    cachedTask.bgPath = 'C:/videos/new_today.mp4';
    cachedTask.videoPath = 'C:/videos/new_today.mp4';
    ReelsRenderPlan.syncLegacyFields(cachedTask);
    assert.equal(cachedTask.bgPath, 'C:/videos/new_today.mp4', 'syncLegacyFields must not overwrite new bgPath with old cached timeline clip');
    assert.equal(cachedTask.videoPath, 'C:/videos/new_today.mp4', 'syncLegacyFields must keep new videoPath');
    assert.deepEqual(getBgClipPaths(cachedTask.timeline), ['C:/videos/new_today.mp4']);

    // Clearing bgPath must remove background & source_audio clips from timeline
    cachedTask.bgPath = '';
    cachedTask.videoPath = '';
    ReelsRenderPlan.syncLegacyFields(cachedTask);
    assert.equal(cachedTask.bgPath, '', 'Cleared bgPath must stay empty after syncLegacyFields');
    assert.deepEqual(getBgClipPaths(cachedTask.timeline), [], 'Background track clips must be emptied when bgPath is cleared');

    // ReelsTaskDerivation.resetContent must also strip template timeline & renderPlan
    const derived = ReelsTaskDerivation.resetContent({
        bgPath: 'C:/videos/template.mp4',
        timeline: cachedTask.timeline,
        renderPlan: cachedTask.renderPlan,
    });
    assert.equal(derived.timeline, undefined, 'Derived task must not inherit template timeline');
    assert.equal(derived.renderPlan, undefined, 'Derived task must not inherit template renderPlan');

    // Verify reelsPurgeTaskBackgroundMedia and v2 cache cleanup hooks exist
    const batchTableSrc = fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8');
    assert.ok(batchTableSrc.includes('window.reelsPurgeTaskBackgroundMedia =') && batchTableSrc.includes('_rbtPurgeTaskBackgroundMedia'), 'reels-batch-table.js must expose reelsPurgeTaskBackgroundMedia');
    const apiRouterSrc = fs.readFileSync(path.join(ROOT, 'electron/apiRouter.js'), 'utf8');
    assert.ok(apiRouterSrc.includes('hdrPreview.clearReelsPreviewCache(rawPaths, clearAll)'), 'subtitle/clear-cache must also purge HDR preview cache');
    assert.ok(apiRouterSrc.includes('`_${fileName}_${audioCacheKey}_`'), 'subtitle/clear-cache must delete v2 transcription cache files');

    // 11) Video duration probing prefers shorter v:0 stream duration over longer audio/container format.duration & pads direct loop fade with tpad
    const ffmpegSrc = fs.readFileSync(path.join(ROOT, 'electron/services/ffmpeg.js'), 'utf8');
    assert.ok(ffmpegSrc.includes('Math.min(streamDur, formatDur)'), 'ffmpeg.js getDuration must use Math.min(streamDur, formatDur) for videos with longer audio tracks');
    const rawvideoSrc = fs.readFileSync(path.join(ROOT, 'electron/services/ffmpeg-rawvideo.js'), 'utf8');
    assert.ok(rawvideoSrc.includes('Math.min(streamDur, formatDur)'), 'ffmpeg-rawvideo.js getMediaDuration must use Math.min(streamDur, formatDur)');
    assert.ok(rawvideoSrc.includes('tpad=stop_mode=clone:stop_duration='), 'normalizedDirectBackgroundFilter must pad background streams with tpad to prevent premature EOF (exit code 0)');

    // 12) Highlight word zoom (highlight_scale_enabled + highlight_scale), unread transparency (hide_until_spoken + unread_opacity), and alignment (left/center/right/smart_left_center)
    assert.ok(indexHtml.includes('id="reels-highlight-scale-enabled"'), 'index.html should include #reels-highlight-scale-enabled');
    assert.ok(indexHtml.includes('id="reels-highlight-scale"'), 'index.html should include #reels-highlight-scale');
    assert.ok(indexHtml.includes('id="reels-hide-until-spoken"'), 'index.html should include #reels-hide-until-spoken');
    assert.ok(indexHtml.includes('id="reels-text-align"'), 'index.html should include #reels-text-align');
    assert.ok(indexHtml.includes('value="smart_left_center"'), 'index.html should include smart_left_center option');

    const overlayPanelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    assert.ok(overlayPanelSrc.includes('id="rop-scroll-tw-hide-unread"'), 'reels-overlay-panel.js should include #rop-scroll-tw-hide-unread');
    assert.ok(overlayPanelSrc.includes('id="rop-scroll-tw-active-scale-enabled"'), 'reels-overlay-panel.js should include #rop-scroll-tw-active-scale-enabled');
    assert.ok(overlayPanelSrc.includes('value="smart_left_center"'), 'reels-overlay-panel.js should include smart_left_center option');

    // Verify regular subtitle active word zoom and hide_until_spoken
    renderer._drawWord = (_, text, x, y) => drawn.push({ text, x, y, font: ctx.font });
    {
        const scaleOps = [];
        const origScale = ctx.scale;
        ctx.scale = (sx, sy) => scaleOps.push({ sx, sy });
        const segZoom = {
            start: 0,
            end: 3,
            text: 'First Second Third',
            words: [
                { word: 'First', start: 0.0, end: 1.0 },
                { word: 'Second', start: 1.0, end: 2.0 },
                { word: 'Third', start: 2.0, end: 3.0 },
            ],
        };
        const styleZoom = engine.mergeStyle({
            mixed_layout: 'none',
            anim_in_type: 'none',
            anim_out_type: 'none',
            highlight_enabled: true,
            highlight_scale_enabled: true,
            highlight_scale: 140,
            hide_until_spoken: true,
            unread_opacity: 0,
            use_stroke: false,
        });
        drawn = [];
        renderer.renderSubtitle(styleZoom, segZoom, 1.5, 1080, 1920);
        assert.deepEqual(drawn.map(d => d.text), ['First', 'Second'], 'hide_until_spoken with unread_opacity=0 must hide future words until spoken');
        assert.ok(scaleOps.some(o => Math.abs(o.sx - 1.4) < 0.01), 'Active spoken word must be scaled by highlight_scale (140% -> 1.4x)');
        ctx.scale = origScale;
    }

    // Verify regular subtitle smart_left_center alignment (narrative line left-aligned, short focal line centered, never right-aligned)
    {
        const segAlign = {
            start: 0,
            end: 2,
            text: 'We walk by faith every single day\nAmen!',
        };
        const styleLeft = engine.mergeStyle({
            mixed_layout: 'none',
            anim_in_type: 'none',
            anim_out_type: 'none',
            text_align: 'left',
            use_stroke: false,
        });
        drawn = [];
        renderer.renderSubtitle(styleLeft, segAlign, 1.0, 1080, 1920);
        const leftFirstLineX = drawn.find(o => o.text === 'We')?.x;
        const leftSecondLineX = drawn.find(o => o.text === 'Amen!')?.x;
        assert.ok(Math.abs(leftFirstLineX - leftSecondLineX) < 1e-3, 'text_align=left must align both lines to the exact same left X');

        drawn = [];
        const styleSmart = engine.mergeStyle({
            mixed_layout: 'none',
            anim_in_type: 'none',
            anim_out_type: 'none',
            text_align: 'smart_left_center',
            use_stroke: false,
        });
        renderer.renderSubtitle(styleSmart, segAlign, 1.0, 1080, 1920);
        const smartFirstLineX = drawn.find(o => o.text === 'We')?.x;
        const smartSecondLineX = drawn.find(o => o.text === 'Amen!')?.x;
        assert.ok(Math.abs(smartFirstLineX - leftFirstLineX) < 1e-3, 'smart_left_center must left-align the narrative line');
        assert.ok(smartSecondLineX > smartFirstLineX + 20, 'smart_left_center must center the short focal impact line');
    }

    // Verify mixed_layout smart_left_center eliminates right-hand stairs indents and combines left + center
    {
        drawn = [];
        renderer.renderSubtitle(
            engine.mergeStyle({ mixed_layout: 'stairs', text_align: 'smart_left_center', anim_in_type: 'none', anim_out_type: 'none' }),
            { start: 0, end: 4, text: 'Stop and pray now' },
            3.9,
            1080,
            1920
        );
        assert.equal(drawn[0].x, 0, 'smart_left_center in mixed_layout must left-align primary row at x=0');
        assert.equal(drawn[1].x, 0, 'smart_left_center in mixed_layout must not right-indent row 2');
        assert.ok(drawn[3].x > 0, 'smart_left_center in mixed_layout should center the final emphasis word');
    }

    // 13) Music MV mode & Transcription Model Selector with Pros/Advantages
    assert.ok(batchTableSrc.includes('id="rbt-align-model"'), 'reels-batch-table.js should include #rbt-align-model selector');
    assert.ok(batchTableSrc.includes('window.showAlignModelGuideModal'), 'reels-batch-table.js should expose window.showAlignModelGuideModal');
    assert.ok(indexHtml.includes('id="subtitle-align-model"'), 'index.html should include #subtitle-align-model selector');
    assert.ok(indexHtml.includes('id="reels-align-model"'), 'index.html should include #reels-align-model selector');
    assert.ok(apiRouterSrc.includes('buildEffectiveTranscriptionConfig'), 'apiRouter.js should include buildEffectiveTranscriptionConfig');
    assert.ok(apiRouterSrc.includes('cleanMusicLyricsText'), 'apiRouter.js should include cleanMusicLyricsText');
    const cloudTransSrc = fs.readFileSync(path.join(ROOT, 'electron/services/cloudTranscription.js'), 'utf8');
    assert.ok(cloudTransSrc.includes('promptHint ? { prompt: promptHint }'), 'cloudTranscription.js should inject lyrics prompt into Groq Whisper');
    const gladiaSrc = fs.readFileSync(path.join(ROOT, 'electron/services/gladia.js'), 'utf8');
    assert.ok(gladiaSrc.includes('highpass=f=160,lowpass=f=4800,dynaudnorm=f=150:g=15'), 'gladia.js should apply vocal frequency isolation filter in musicMode');

    // 14) Queue-wide Background / Content Video / BGM sync & batch apply in #inspector-tab-background
    const batchReelsSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    assert.ok(indexHtml.includes('id="reels-bg-sync-all-queue"'), 'index.html should include #reels-bg-sync-all-queue checkbox');
    assert.ok(indexHtml.includes('id="reels-bg-queue-scope"'), 'index.html should include #reels-bg-queue-scope selector');
    assert.ok(indexHtml.includes('id="reels-cv-x-num"') && indexHtml.includes('id="reels-cv-y-num"'), 'index.html should include Content Video X/Y offset inputs');
    assert.ok(indexHtml.includes('reelsApplyCvConfigToAllTasks'), 'index.html should include reelsApplyCvConfigToAllTasks button');
    assert.ok(indexHtml.includes('reelsCopyBgToCvAllTasks'), 'index.html should include reelsCopyBgToCvAllTasks button');
    assert.ok(batchReelsSrc.includes('window.reelsApplyCvConfigToAllTasks = function()'), 'batch-reels.js should define window.reelsApplyCvConfigToAllTasks');
    assert.ok(batchReelsSrc.includes('window.reelsApplyBgConfigToAllTasks = function()'), 'batch-reels.js should define window.reelsApplyBgConfigToAllTasks');
    assert.ok(batchReelsSrc.includes('window.reelsApplyBgmConfigToAllTasks = function()'), 'batch-reels.js should define window.reelsApplyBgmConfigToAllTasks');
    assert.ok(batchReelsSrc.includes('window.reelsCopyBgToCvAllTasks = function()'), 'batch-reels.js should define window.reelsCopyBgToCvAllTasks');
    assert.ok(batchReelsSrc.includes('window.reelsApplyAllBgCvBgmToQueue = function()'), 'batch-reels.js should define window.reelsApplyAllBgCvBgmToQueue');

    // 15) Progressive per-line background bar wipe ("红底条逐行擦除 (爆款)" / box_wipe)
    assert.ok(indexHtml.includes('id="reels-box-wipe"'), 'index.html should include #reels-box-wipe checkbox');
    assert.ok(indexHtml.includes('value="box_wipe"'), 'index.html should include box_wipe option in #reels-anim-in');
    const redBarPreset = engine.applySubtitlePreset('红底条逐行擦除 (爆款)');
    assert.ok(presets['红底条逐行擦除 (爆款)'], 'REELS_BUILTIN_PRESETS should include 红底条逐行擦除 (爆款)');
    assert.ok(redBarPreset, 'BUILTIN_PRESETS should include 红底条逐行擦除 (爆款)');
    assert.equal(redBarPreset.color_bg, '#991A1C', 'Preset should use deep crimson red #991A1C background bar');
    assert.equal(redBarPreset.box_wipe_enabled, true, 'Preset should enable box_wipe_enabled');
    assert.equal(redBarPreset.anim_in_type, 'box_wipe', 'Preset should use anim_in_type=box_wipe');
    assert.equal(redBarPreset.box_adaptive_width, true, 'Preset should use adaptive per-line width');
    assert.equal(redBarPreset.box_connected, false, 'Preset should keep per-line bars separated');
    assert.equal(redBarPreset.bold, true, 'Preset should use bold text');
    assert.equal(redBarPreset.italic, true, 'Preset should use italic text');

    const animEngine = sandbox.window.ReelsAnimEngine;
    assert.equal(typeof animEngine.computeBoxWipeLineWidths, 'function', 'ReelsAnimEngine must export computeBoxWipeLineWidths');
    // Line 1 width = 560, Line 2 width = 388 (total = 948) over 0..2s
    const wStart = animEngine.computeBoxWipeLineWidths(0.0, 0.0, 2.0, [560, 388]);
    assert.ok(wStart[0] > 20 && wStart[0] < 60, 'At segment start, Line 1 bar should start with a small visible leading tab');
    assert.equal(wStart[1], 0, 'At segment start, Line 2 bar must be 0 width');

    const wMidLine1 = animEngine.computeBoxWipeLineWidths(0.5, 0.0, 2.0, [560, 388]);
    assert.ok(wMidLine1[0] > 240 && wMidLine1[0] < 320, 'Midway through Line 1, Line 1 bar should be partially wiped');
    assert.equal(wMidLine1[1], 0, 'While Line 1 is still wiping, Line 2 bar must remain 0 width');

    const wMidLine2 = animEngine.computeBoxWipeLineWidths(1.5, 0.0, 2.0, [560, 388]);
    assert.equal(wMidLine2[0], 560, 'Once sweep passes Line 1 width, Line 1 bar must stay at 100% full width');
    assert.ok(wMidLine2[1] > 150 && wMidLine2[1] < 260, 'While sweeping Line 2, Line 2 bar should be partially wiped');

    const wEnd = animEngine.computeBoxWipeLineWidths(2.0, 0.0, 2.0, [560, 388]);
    assert.deepEqual(wEnd, [560, 388], 'At segment end, both Line 1 and Line 2 bars must reach full width');

    // Verify ReelsCanvasRenderer draws all text lines from segment start while progressively wiping the two line bars
    {
        const lineToCalls = [];
        ctx.beginPath = () => {};
        ctx.moveTo = () => {};
        ctx.lineTo = (x, y) => lineToCalls.push({ x, y });
        ctx.quadraticCurveTo = () => {};
        ctx.closePath = () => {};
        ctx.fill = () => {};
        ctx.stroke = () => {};
        ctx.fillText = () => {};
        ctx.strokeText = () => {};
        drawn = [];
        const segWipe = {
            start: 0,
            end: 2,
            text: "Even if you don't have\nthe strength to pray,",
        };
        renderer.renderSubtitle(redBarPreset, segWipe, 0.2, 1080, 1920);
        const maxRightEarly = Math.max(...lineToCalls.map(p => p.x));
        assert.ok(drawn.length >= 2, 'All subtitle lines must be visible while the red bar wipes behind them');

        lineToCalls.length = 0;
        renderer.renderSubtitle(redBarPreset, segWipe, 0.9, 1080, 1920);
        const maxRightLate = Math.max(...lineToCalls.map(p => p.x));
        assert.ok(maxRightLate > maxRightEarly + 150, 'Red bar right edge must expand significantly from early frame to late frame');
    }

    // 16) Coral red slide-up relay preset ("珊瑚红逐词上滑 (爆款)") & trailing punctuation preservation
    const coralSlidePreset = engine.applySubtitlePreset('珊瑚红逐词上滑 (爆款)');
    assert.equal(coralSlidePreset.color_high, '#FA4E68', 'Coral preset should use #FA4E68 highlight color');
    assert.equal(coralSlidePreset.anim_in_type, 'slide_up', 'Coral preset should use slide_up entrance');
    assert.equal(coralSlidePreset.anim_out_type, 'slide_up', 'Coral preset should use slide_up exit');
    {
        const colorDraws = [];
        renderer._drawWord = (_, text, x, y, color) => colorDraws.push({ text, color });
        renderer.renderSubtitle(
            coralSlidePreset,
            {
                start: 0,
                end: 2,
                text: '14: 6, Jesus',
                words: [
                    { word: '14:', start: 0.0, end: 0.6 },
                    { word: '6,', start: 0.6, end: 1.2 },
                    { word: 'Jesus', start: 1.2, end: 2.0 },
                ],
            },
            0.8,
            1080,
            1920
        );
        assert.deepEqual(colorDraws, [
            { text: '14:', color: '#FFFFFF' },
            { text: '6', color: '#FA4E68' },
            { text: ',', color: '#FFFFFF' },
            { text: 'Jesus', color: '#FFFFFF' },
        ], 'Active word "6," must highlight "6" in #FA4E68 while keeping trailing comma "," in #FFFFFF');
    }

    // 17) Continuous forward 3D zoom + rapid char typewriter ("远景打字推进 (爆款)" / zoom_typewriter)
    assert.ok(indexHtml.includes('value="zoom_typewriter"'), 'index.html should include zoom_typewriter option in #reels-anim-in');
    const zoomTwPreset = engine.applySubtitlePreset('远景打字推进 (爆款)');
    assert.equal(zoomTwPreset.anim_in_type, 'zoom_typewriter', 'Zoom typewriter preset should use anim_in_type=zoom_typewriter');
    assert.equal(zoomTwPreset.text_transform, 'none', 'Zoom typewriter preset should not force uppercase by default');
    assert.equal(zoomTwPreset.uppercase, false, 'Zoom typewriter preset should have uppercase=false by default');
    const zStart = animEngine.computeZoomTypewriterState(0.05, 0.0, 1.5, 10);
    const zMid = animEngine.computeZoomTypewriterState(0.6, 0.0, 1.5, 10);
    const zEnd = animEngine.computeZoomTypewriterState(1.45, 0.0, 1.5, 10);
    assert.ok(zStart.blockScale < 0.5 && zStart.revealedChars < 10, 'Early in segment, block scale starts small and characters are typing');
    assert.equal(zMid.revealedChars, 10, 'By 0.6s, all characters have finished typing');
    assert.ok(zEnd.blockScale > 1.15 && zEnd.blockScale > zMid.blockScale, 'Block scale continues zooming forward through the end of the segment');

    // 18) Active 2-line focus switching ("双行焦点放大 (爆款)" / line_focus)
    assert.ok(indexHtml.includes('value="line_focus"'), 'index.html should include line_focus option in #reels-anim-in');
    const lineFocusPreset = engine.applySubtitlePreset('双行焦点放大 (爆款)');
    assert.equal(lineFocusPreset.anim_in_type, 'line_focus', 'Line focus preset should use anim_in_type=line_focus');
    assert.equal(lineFocusPreset.active_line_focus_enabled, true, 'Line focus preset should enable active_line_focus_enabled');
    assert.equal(lineFocusPreset.inactive_line_scale, 0.62, 'Line focus preset should set inactive_line_scale=0.62');
    assert.equal(lineFocusPreset.color_high, '#FBFD07', 'Line focus preset should highlight active word in #FBFD07 yellow');
    assert.equal(lineFocusPreset.italic, true, 'Line focus preset should use bold italic comic typography');
    assert.equal(lineFocusPreset.text_transform, 'none', 'Line focus preset should not force uppercase by default');
    assert.equal(lineFocusPreset.uppercase, false, 'Line focus preset should have uppercase=false by default');

    const lfScalesLine1 = animEngine.computeActiveLineFocusScales(
        [{ startWordIdx: 0, endWordIdx: 3 }, { startWordIdx: 3, endWordIdx: 6 }],
        1, 1.0, 0.62
    );
    assert.equal(lfScalesLine1.activeLineIdx, 0);
    assert.deepEqual(Array.from(lfScalesLine1.scales), [1.0, 0.62], 'When active word is on Line 1, Line 1 is 1.0x and Line 2 is 0.62x');

    const lfScalesLine2 = animEngine.computeActiveLineFocusScales(
        [{ startWordIdx: 0, endWordIdx: 3 }, { startWordIdx: 3, endWordIdx: 6 }],
        4, 1.0, 0.62
    );
    assert.equal(lfScalesLine2.activeLineIdx, 1);
    assert.deepEqual(Array.from(lfScalesLine2.scales), [0.62, 1.0], 'When active word moves to Line 2, Line 1 shrinks to 0.62x and Line 2 expands to 1.0x');

    {
        const lfDraws = [];
        let curScale = 1.0;
        const scaleStack = [];
        const origSave = ctx.save;
        const origRestore = ctx.restore;
        const origScale = ctx.scale;
        ctx.save = () => { scaleStack.push(curScale); if (origSave) origSave.call(ctx); };
        ctx.restore = () => { curScale = scaleStack.pop() ?? 1.0; if (origRestore) origRestore.call(ctx); };
        ctx.scale = (sx, sy) => { curScale *= sx; if (origScale) origScale.call(ctx, sx, sy); };
        renderer._drawWord = (_, text, x, y, color) => lfDraws.push({ text, x, y, color, scale: Number(curScale.toFixed(2)) });

        const seg6 = {
            start: 0.0,
            end: 1.8,
            text: 'If Jesus means nothing to you',
            words: [
                { word: 'If', start: 0.0, end: 0.3 },
                { word: 'Jesus', start: 0.3, end: 0.6 },
                { word: 'means', start: 0.6, end: 0.9 },
                { word: 'nothing', start: 0.9, end: 1.2 },
                { word: 'to', start: 1.2, end: 1.5 },
                { word: 'you', start: 1.5, end: 1.8 },
            ],
        };

        // At t = 0.45s ("Jesus" on Line 1 is spoken): Line 1 at 1.0x with Jesus in #FBFD07; Line 2 at 0.62x in #FFFFFF (preserving original casing when uppercase is unchecked)
        lfDraws.length = 0;
        renderer.renderSubtitle(lineFocusPreset, seg6, 0.45, 1080, 1920);
        assert.deepEqual(
            lfDraws.map(d => ({ text: d.text, color: d.color, scale: d.scale })),
            [
                { text: 'If', color: '#FFFFFF', scale: 1.0 },
                { text: 'Jesus', color: '#FBFD07', scale: 1.0 },
                { text: 'means', color: '#FFFFFF', scale: 1.0 },
                { text: 'nothing', color: '#FFFFFF', scale: 0.62 },
                { text: 'to', color: '#FFFFFF', scale: 0.62 },
                { text: 'you', color: '#FFFFFF', scale: 0.62 },
            ],
            'Single 6-word segment splits into 2 balanced lines with Line 1 enlarged (1.0x) and Line 2 shrunk (0.62x)'
        );

        // At t = 1.05s ("nothing" on Line 2 is spoken): Line 1 shrinks to 0.62x in #FFFFFF; Line 2 expands to 1.0x with nothing in #FBFD07
        lfDraws.length = 0;
        renderer.renderSubtitle(lineFocusPreset, seg6, 1.05, 1080, 1920);
        assert.deepEqual(
            lfDraws.map(d => ({ text: d.text, color: d.color, scale: d.scale })),
            [
                { text: 'If', color: '#FFFFFF', scale: 0.62 },
                { text: 'Jesus', color: '#FFFFFF', scale: 0.62 },
                { text: 'means', color: '#FFFFFF', scale: 0.62 },
                { text: 'nothing', color: '#FBFD07', scale: 1.0 },
                { text: 'to', color: '#FFFFFF', scale: 1.0 },
                { text: 'you', color: '#FFFFFF', scale: 1.0 },
            ],
            'When speech reaches Line 2, Line 1 shrinks to 0.62x and Line 2 expands to 1.0x with active word highlighted'
        );

        // Consecutive short 3-word context segments should also auto-pair into a 2-line active-focus block
        const shortSegs = [
            { start: 0.0, end: 0.9, text: 'You can keep' },
            { start: 0.9, end: 1.8, text: 'scrolling down but' },
        ];
        renderer.setContextSegments(shortSegs);
        lfDraws.length = 0;
        renderer.renderSubtitle(lineFocusPreset, shortSegs[0], 0.45, 1080, 1920);
        assert.equal(lfDraws.length, 6, 'Consecutive 3-word segments in _contextSegments should auto-pair into 6 words across 2 lines');
        assert.equal(lfDraws[0].scale, 1.0, 'First paired segment line should be 1.0x while active');
        assert.equal(lfDraws[3].scale, 0.62, 'Second paired segment line should be 0.62x while inactive');
        renderer.setContextSegments([]);
    }
});

test('kinetic_glow_stack preset, independent outline/glow controls, and fullpage typewriter auto-pagination work', () => {
    const sandbox = loadBrowserScript('src/reels-style-engine.js', { window: { addEventListener() {} } });
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);

    const ReelsStyleEngine = sandbox.window.ReelsStyleEngine;
    const REELS_BUILTIN_PRESETS = sandbox.window.REELS_BUILTIN_PRESETS;
    const ReelsAnimEngine = sandbox.window.ReelsAnimEngine;
    const ReelsCanvasRenderer = sandbox.window.ReelsCanvasRenderer;

    // 1. Check presets and animation label
    const kineticPreset = ReelsStyleEngine.applySubtitlePreset('参考_黄绿辉光逐词叠排');
    assert.ok(kineticPreset, '参考_黄绿辉光逐词叠排 should exist in BUILTIN_PRESETS');
    assert.equal(kineticPreset.anim_in_type, 'kinetic_glow_stack');
    assert.ok(REELS_BUILTIN_PRESETS['参考_黄绿辉光逐词叠排'], '参考_黄绿辉光逐词叠排 should exist in REELS_BUILTIN_PRESETS');

    const redOutlinePreset = ReelsStyleEngine.applySubtitlePreset('参考_红黑描边粗斜体弹入');
    assert.ok(redOutlinePreset, '参考_红黑描边粗斜体弹入 should exist in BUILTIN_PRESETS');
    assert.equal(redOutlinePreset.stroke_expand_enabled, true);
    assert.ok(REELS_BUILTIN_PRESETS['参考_红黑描边粗斜体弹入'], '参考_红黑描边粗斜体弹入 should exist in REELS_BUILTIN_PRESETS');

    const animValues = Array.from(ReelsAnimEngine.ANIM_TYPE_LABELS).map(pair => pair[1]);
    assert.ok(animValues.includes('kinetic_glow_stack'), 'ANIM_TYPE_LABELS should include kinetic_glow_stack');

    // 2. Check independent outline/glow controls (_resolveStrokeExpandLayerMetrics / _resolveStrokeExpandLayerOpacity)
    const makeGradient = () => ({ addColorStop() {} });
    const ctx = {
        globalAlpha: 1,
        font: '700 72px sans-serif',
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
        fillRect() {},
        strokeText() {},
        fillText() {},
        createLinearGradient: makeGradient,
        createRadialGradient: makeGradient,
        measureText(text) {
            const m = this.font && this.font.match(/([\d.]+)px/);
            const sz = m ? parseFloat(m[1]) : 72;
            return { width: String(text).length * sz * 0.6 };
        },
    };
    const renderer = new ReelsCanvasRenderer({ getContext: () => ctx });
    const m0 = renderer._resolveStrokeExpandLayerMetrics(redOutlinePreset, 0, 3, 5, 8);
    const m1 = renderer._resolveStrokeExpandLayerMetrics(redOutlinePreset, 1, 3, 5, 8);
    const m2 = renderer._resolveStrokeExpandLayerMetrics(redOutlinePreset, 2, 3, 5, 8);
    assert.deepEqual([m0.width, m1.width, m2.width], [11, 25, 42.6]);
    assert.deepEqual([m0.feather, m1.feather, m2.feather], [2, 30, 27]);

    const customEffectStyle = {
        ...redOutlinePreset,
        effect_controls_enabled: true,
        effect_inner_outline_width: 4,
        effect_glow_range: 28,
        effect_glow_blur: 20,
        effect_glow_opacity: 50,
    };
    const cm0 = renderer._resolveStrokeExpandLayerMetrics(customEffectStyle, 0, 3, 5, 8);
    const cm1 = renderer._resolveStrokeExpandLayerMetrics(customEffectStyle, 1, 3, 5, 8);
    const cm2 = renderer._resolveStrokeExpandLayerMetrics(customEffectStyle, 2, 3, 5, 8);
    assert.equal(cm0.width, 4);
    assert.equal(cm1.width, 28);
    assert.ok(cm2.width > 28);
    assert.equal(cm1.feather, 20);
    assert.equal(renderer._resolveStrokeExpandLayerOpacity(customEffectStyle, 0), 1);
    assert.equal(renderer._resolveStrokeExpandLayerOpacity(customEffectStyle, 2), 0.5);

    // 3. Render kinetic_glow_stack without throwing and verify words are drawn
    const segment = {
        start: 0.0,
        end: 1.5,
        text: 'Shine bright today',
        words: [
            { word: 'Shine', start: 0.0, end: 0.5 },
            { word: 'bright', start: 0.5, end: 1.0 },
            { word: 'today', start: 1.0, end: 1.5 },
        ],
    };
    let backdropCalls = 0;
    const origBackdrop = renderer.renderKineticGlowBackdrop.bind(renderer);
    renderer.renderKineticGlowBackdrop = (st, w, h) => {
        backdropCalls += 1;
        return origBackdrop(st, w, h);
    };
    renderer.renderSubtitle(kineticPreset, segment, 1.2, 1080, 1920, false, false);
    assert.equal(backdropCalls, 1, 'renderSubtitle should draw kinetic backdrop when _skipKineticBackdrop is false');
    renderer.renderSubtitle(kineticPreset, segment, 1.2, 1080, 1920, false, true);
    assert.equal(backdropCalls, 1, 'renderSubtitle should skip kinetic backdrop when _skipKineticBackdrop is true');
});

test('bold toggle and font_weight sync across style engine, font manager, and canvas renderer', () => {
    const sandbox = loadBrowserScript('src/reels-style-engine.js', { window: { addEventListener() {} } });
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);
    loadBrowserScript('src/reels-font-manager.js', sandbox);

    const ReelsStyleEngine = sandbox.window.ReelsStyleEngine;
    const ReelsCanvasRenderer = sandbox.window.ReelsCanvasRenderer;
    const ReelsFontManager = sandbox.window.ReelsFontManager;

    const mergedUnbold = ReelsStyleEngine.mergeStyle({ bold: false });
    assert.equal(mergedUnbold.bold, false);
    assert.equal(mergedUnbold.font_weight, 400);

    const mergedBold = ReelsStyleEngine.mergeStyle({ font_weight: 400, bold: true });
    assert.equal(mergedBold.bold, true);

    const fm = new ReelsFontManager();
    fm._registerLocalFont('CustomSingleFileFont', 'C:/fonts/CustomSingleFileFont.ttf');
    const entries = fm.getFontWeightEntries('CustomSingleFileFont', 'normal').map(e => e.value);
    assert.ok(entries.includes('400'), 'Single-file font should expose Regular (400) weight entry');
    assert.ok(entries.includes('700'), 'Single-file font should expose Bold (700) weight entry');

    const seenFonts = [];
    const ctx = {
        globalAlpha: 1,
        font: '700 72px sans-serif',
        direction: 'ltr',
        textAlign: 'left',
        textBaseline: 'top',
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
        fillRect() {},
        strokeText() {},
        fillText() { seenFonts.push(this.font); },
        measureText(text) { return { width: String(text).length * 24 }; },
    };
    const renderer = new ReelsCanvasRenderer({ getContext: () => ctx });
    const segment = {
        start: 0,
        end: 2,
        text: 'Hello world',
        words: [{ word: 'Hello', start: 0, end: 1 }, { word: 'world', start: 1, end: 2 }],
    };
    renderer.renderSubtitle({ font_family: 'Arial', fontsize: 72, font_weight: 700, bold: false }, segment, 0.5, 1080, 1920);
    assert.ok(seenFonts.some(f => /^400\s+72px/.test(f)), 'Canvas renderer should use weight 400 when bold is explicitly false');

    seenFonts.length = 0;
    renderer.renderSubtitle({ font_family: 'Arial', fontsize: 72, font_weight: 400, bold: true }, segment, 0.5, 1080, 1920);
    assert.ok(seenFonts.some(f => /^700\s+72px/.test(f)), 'Canvas renderer should use weight 700 when bold is explicitly true');
});

test('export HDR / wide-gamut color conversion filter normalizes input to SDR BT.709', () => {
    const rawvideo = require('../electron/services/ffmpeg-rawvideo');
    const buildFilter = rawvideo._test.buildInputBt709ConvertFilter;
    assert.equal(typeof buildFilter, 'function');

    const sdrFilter = buildFilter({
        needsConversion: false,
        isHdr: false,
        colorTransfer: 'bt709',
        colorPrimaries: 'bt709',
        colorSpace: 'bt709',
        pixFmt: 'yuv420p',
    }, 'nonexistent_ffmpeg');
    assert.ok(sdrFilter.includes('out_color_matrix=bt709:out_range=tv'), 'SDR input filter should enforce BT.709 color matrix and TV range');
    assert.ok(sdrFilter.includes('setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'), 'SDR input filter should enforce bt709 stream params');

    const hdrFilter = buildFilter({
        needsConversion: true,
        isHdr: true,
        isWideGamut: true,
        hasIncompleteMetadata: false,
        colorTransfer: 'arib-std-b67',
        colorPrimaries: 'bt2020',
        colorSpace: 'bt2020nc',
        pixFmt: 'yuv420p10le',
    }, 'nonexistent_ffmpeg');
    assert.ok(hdrFilter.includes('tonemap=tonemap=hable') || hdrFilter.includes('tonemapping=bt.2390'), 'HDR input filter should tone-map HDR to SDR');
    assert.ok(hdrFilter.includes('setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'), 'HDR input filter should enforce bt709 stream params');

    const bgChain = rawvideo._test.normalizedDirectBackgroundFilter(
        0,
        'scale=1080:1920,setsar=1',
        'setpts=PTS-STARTPTS',
        30,
        'bg',
        0,
        {
            needsConversion: true,
            isHdr: true,
            isWideGamut: true,
            hasIncompleteMetadata: false,
            colorTransfer: 'smpte2084',
            colorPrimaries: 'bt2020',
            colorSpace: 'bt2020nc',
            pixFmt: 'yuv420p10le',
        }
    );
    assert.ok(bgChain.startsWith('[0:v]'), 'Direct background filter should start with [0:v]');
    assert.ok(bgChain.includes('setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'), 'Direct background filter should include BT.709 setparams');
    assert.ok(bgChain.endsWith('[bg]'), 'Direct background filter should end with [bg]');
});

test('merged 4.4.47 customized features: font preferences, font metadata, export CPU budget, and custom download range UI', () => {
    const tmpProfile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vk-font-prefs-'));
    try {
        const { createFontPreferences } = require('../electron/services/fontPreferences');
        const prefs = createFontPreferences(tmpProfile);
        assert.deepEqual(prefs.read(['Inter', 'Anton']), ['Inter', 'Anton']);
        const afterToggle = prefs.toggle('Inter');
        assert.deepEqual(afterToggle, ['Anton']);
        const afterAdd = prefs.toggle('Montserrat');
        assert.deepEqual(afterAdd, ['Anton', 'Montserrat']);
    } finally {
        fs.rmSync(tmpProfile, { recursive: true, force: true });
    }

    const fontMeta = require('../electron/services/fontMetadata');
    assert.equal(typeof fontMeta.readFontMetadata, 'function');

    const cpuBudget = require('../resources/export-cpu-budget');
    assert.equal(typeof cpuBudget.assign, 'function');
    assert.equal(typeof cpuBudget.createBudgetManager, 'function');

    const indexHtml = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    assert.ok(indexHtml.includes('id="reels-download-mode"'), 'index.html should include #reels-download-mode');
    assert.ok(indexHtml.includes('id="reels-download-range"'), 'index.html should include #reels-download-range');
});

test('Synthetic bold on single-weight fonts and default off state for scroll typewriter effect', () => {
    // 1. Test Canvas 2D synthetic bold engine on a mock CanvasRenderingContext2D
    const fillCalls = [];
    const strokeCalls = [];
    function MockCtx() {
        this.font = '400 40px "SingleWeightFont", sans-serif';
        this.shadowColor = 'rgba(0,0,0,0.8)';
        this.shadowBlur = 6;
        this.shadowOffsetX = 2;
        this.shadowOffsetY = 2;
        this.lineWidth = 4;
    }
    MockCtx.prototype.save = function () {};
    MockCtx.prototype.restore = function () {};
    MockCtx.prototype.fillText = function (text, x, y) {
        if (this._isProbe) return;
        fillCalls.push({ text, x, y, font: this.font, shadowBlur: this.shadowBlur });
    };
    MockCtx.prototype.strokeText = function (text, x, y) {
        if (this._isProbe) return;
        strokeCalls.push({ text, x, y, font: this.font, lineWidth: this.lineWidth, shadowBlur: this.shadowBlur });
    };

    // Probe canvas returns identical pixels for 400 and 700 (simulating a single-weight font like Anton/Impact/single-file TTF)
    const identicalPixels = new Uint8ClampedArray(160 * 48 * 4);
    identicalPixels[3] = 255;
    identicalPixels[7] = 200;
    const probeCtx = {
        _isProbe: true,
        font: '',
        fillStyle: '#fff',
        textBaseline: 'top',
        clearRect() {},
        fillText() {},
        measureText: () => ({ width: 80 }),
        getImageData: () => ({ data: identicalPixels }),
    };

    const rendererSandbox = loadBrowserScript('src/reels-canvas-renderer.js', {
        CanvasRenderingContext2D: MockCtx,
        document: {
            createElement: () => ({
                width: 160,
                height: 48,
                getContext: () => probeCtx,
            }),
        },
    });

    assert.equal(typeof rendererSandbox.window.installCanvasSyntheticBoldSupport, 'function');
    const c = new MockCtx();

    // Weight 400 -> single pass
    fillCalls.length = 0;
    c.font = '400 48px "SingleWeightFont", sans-serif';
    c.fillText('Hello', 100, 200);
    assert.equal(fillCalls.length, 1, 'Weight 400 must render in a single fillText pass');

    // Weight 700 (B checked) on single-weight font -> synthetic faux-bold multi-pass with shadow only on first pass
    fillCalls.length = 0;
    c.font = '700 48px "SingleWeightFont", sans-serif';
    c.fillText('Hello', 100, 200);
    assert.ok(fillCalls.length > 1, 'Weight 700 on single-weight font must synthesize faux-bold passes');
    assert.equal(fillCalls[0].shadowBlur, 6, 'First pass preserves text shadow');
    assert.ok(fillCalls.slice(1).every(call => call.shadowBlur === 0), 'Offset faux-bold passes suppress duplicate shadow');

    // StrokeText with weight 700 -> multi-pass offset stroke to match synthetic bold glyph contour
    strokeCalls.length = 0;
    c.lineWidth = 4;
    c.strokeText('Hello', 100, 200);
    assert.equal(strokeCalls.length, 4, 'Synthetic bold strokeText performs 4 micro-offset passes matching emboldened glyph');
    assert.equal(strokeCalls[0].shadowBlur, 6, 'First stroke pass preserves shadow');
    assert.ok(strokeCalls.slice(1).every(call => call.shadowBlur === 0), 'Offset stroke passes suppress duplicate shadow');

    // 2. Test overlay bold & scroll default typewriter off state
    const drawnFonts = [];
    const ovCtx = {
        canvas: { width: 1080, height: 1920 },
        font: '',
        direction: 'ltr',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        fillStyle: '#fff',
        strokeStyle: '#000',
        lineWidth: 1,
        lineJoin: 'round',
        miterLimit: 2,
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
        beginPath() {},
        closePath() {},
        rect() {},
        fillRect() {},
        clearRect() {},
        drawImage() {},
        clip() {},
        moveTo() {},
        lineTo() {},
        arcTo() {},
        quadraticCurveTo() {},
        fill() {},
        stroke() {},
        strokeRect() {},
        setLineDash() {},
        arc() {},
        ellipse() {},
        bezierCurveTo() {},
        createPattern: () => ({}),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        measureText: (txt) => ({ width: String(txt || '').length * 18 }),
        fillText() { drawnFonts.push(this.font); },
        strokeText() {},
    };
    const ovSandbox = loadBrowserScript('src/reels-overlay.js', {
        document: {
            createElement: () => ({
                width: 1080,
                height: 1920,
                style: {},
                dataset: {},
                classList: { add() {}, remove() {}, contains: () => false },
                appendChild() {},
                getContext: () => ovCtx,
            }),
        },
    });
    const ReelsOverlay = ovSandbox.window.ReelsOverlay;

    // Text overlay with bold=true even if font_weight=400 must render with 700
    const textOv = ReelsOverlay.createTextOverlay({ content: 'Bold Test', bold: true, font_weight: 400, _exporting: true });
    drawnFonts.length = 0;
    ReelsOverlay.drawOverlay(ovCtx, textOv, 1.0, 1080, 1920);
    assert.ok(drawnFonts.some(f => /\b700\b/.test(f)), 'bold=true must force weight >= 600 even if font_weight was 400');

    // Default scroll overlay must have scroll_typewriter_enabled === false
    const scrollOv = ReelsOverlay.createScrollOverlay({ content: 'Line 1\nLine 2' });
    assert.equal(scrollOv.scroll_typewriter_enabled, false, 'Default scroll overlay must not enable typewriter effect');

    // Verify #rop-scroll-tw-details is hidden by default in reels-overlay-panel.js
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    assert.ok(
        panelSrc.includes('id="rop-scroll-tw-details" class="rop-grid" style="grid-column:span 2;display:none;"'),
        '#rop-scroll-tw-details must be hidden by default when #rop-scroll-tw-enabled is off'
    );

    // Verify uppercase toggle is authoritative and presets do not force uppercase when unchecked
    const applyTransform = rendererSandbox.window.ReelsCanvasRenderer.prototype._applyTextTransform;
    assert.equal(
        applyTransform('God leads me.', { uppercase: false, text_transform: 'uppercase' }),
        'God leads me.',
        'Unchecked uppercase (false) must override residual text_transform="uppercase"'
    );
    assert.equal(
        applyTransform('God leads me.', { uppercase: true, text_transform: 'none' }),
        'GOD LEADS ME.',
        'Checked uppercase (true) must uppercase text'
    );
    const styleSandbox = loadBrowserScript('src/reels-style-engine.js', { window: { addEventListener() {} } });
    loadBrowserScript('src/reels-presets-init.js', styleSandbox);
    const engine = styleSandbox.window.ReelsStyleEngine;
    const lineFocusStyle = engine.applySubtitlePreset('双行焦点放大 (爆款)');
    assert.equal(lineFocusStyle.uppercase, false, '双行焦点放大 (爆款) should not force uppercase by default');
    assert.equal(lineFocusStyle.text_transform, 'none', '双行焦点放大 (爆款) should have text_transform="none" by default');
    const mergedUnchecked = engine.mergeStyle({ text_transform: 'uppercase', uppercase: false });
    assert.equal(mergedUnchecked.uppercase, false);
    assert.equal(mergedUnchecked.text_transform, 'none');

    // 3. Test scroll typewriter active-word highlight in 'char' reveal mode, title digit/word ASR mismatch, and pause bridging
    const fillRecords = [];
    ovCtx.fillText = function (txt, x, y) {
        drawnFonts.push(this.font);
        fillRecords.push({ text: String(txt), fillStyle: String(this.fillStyle), x, y });
    };
    const twScrollOv = ReelsOverlay.createScrollOverlay({
        scroll_title: 'JESUS IS COMING – THESE 4 DOORS ARE CLOSING NUMBER 4 COULD CLOSE TONIGHT.',
        scroll_title_fixed: true,
        scroll_title_uppercase: true,
        content: 'Many people think they still\nhave time. Pray tomorrow.',
        scroll_uppercase: false,
        color: '#FFFFFF',
        scroll_typewriter_enabled: true,
        scroll_tw_speech_sync: true,
        scroll_tw_reveal_type: 'char',
        scroll_tw_hide_unread: false,
        scroll_tw_unrevealed_opacity: 100,
        scroll_tw_active_highlight: true,
        scroll_tw_active_color: '#ffd700',
        feather_top: 0,
        feather_bottom: 0,
        start: 0,
        end: 10,
        _taskSegments: [
            {
                start: 0.0,
                end: 3.0,
                text: 'Jesus is coming these four doors are closing number four could close tonight',
            },
            {
                start: 3.2,
                end: 8.0,
                text: 'Many people think they still have time. Pray tomorrow.',
                words: [
                    { word: 'Many', start: 3.2, end: 3.6 },
                    { word: 'people', start: 3.6, end: 4.1 },
                    { word: 'think', start: 4.1, end: 4.5 },
                    { word: 'they', start: 4.5, end: 4.9 },
                    { word: 'still', start: 4.9, end: 5.3 },
                    { word: 'have', start: 5.5, end: 5.9 },
                    { word: 'time.', start: 5.9, end: 6.4 },
                    { word: 'Pray', start: 6.7, end: 7.2 },
                    { word: 'tomorrow.', start: 7.2, end: 8.0 },
                ],
            },
        ],
    });

    // At t = 0.0s (paused at start before body speech begins at 3.2s): first word "Many" must be highlighted in #ffd700
    fillRecords.length = 0;
    ReelsOverlay.drawOverlay(ovCtx, twScrollOv, 0.0, 1080, 1920);
    assert.ok(
        fillRecords.some(r => r.text.includes('Many') && r.fillStyle.toLowerCase() === '#ffd700'),
        'At t=0.0s in char mode with hide_unread=false, full first word "Many" must be highlighted in #ffd700'
    );

    // At t = 6.55s (inside pause between "time." end=6.4s and "Pray" start=6.7s): "time." stays highlighted in #ffd700
    fillRecords.length = 0;
    ReelsOverlay.drawOverlay(ovCtx, twScrollOv, 6.55, 1080, 1920);
    assert.ok(
        fillRecords.some(r => r.text.includes('time') && r.fillStyle.toLowerCase() === '#ffd700'),
        'During inter-word pause (6.55s), active word highlight must bridge gap instead of dropping out'
    );

    // At t = 6.9s (middle of "Pray" [6.7..7.2]): the entire word "Pray" is highlighted in #ffd700 even in char reveal mode
    fillRecords.length = 0;
    ReelsOverlay.drawOverlay(ovCtx, twScrollOv, 6.9, 1080, 1920);
    assert.ok(
        fillRecords.some(r => r.text === 'Pray' && r.fillStyle.toLowerCase() === '#ffd700'),
        'At t=6.9s in char reveal mode, the entire active word "Pray" must be highlighted as one run in #ffd700'
    );
    assert.ok(
        fillRecords.some(r => r.text.includes('have time.') && r.fillStyle.toLowerCase() === '#ffffff'),
        'Already spoken words on the same line must render in base #FFFFFF color'
    );

    // 4. When paused at t=0.0s (or in Preset Editor with _staticPreview=true) with hide_unread=true (unrevealed_opacity=0),
    // enabling scroll_typewriter_enabled must show a static preview demonstration (first ~2-3 lines + ribbon backing) instead of disappearing
    const twHiddenUnreadOv = ReelsOverlay.createScrollOverlay({
        scroll_title: '',
        scroll_title_enabled: false,
        content: 'Line one of the prayer.\nLine two of the prayer.\nLine three of the prayer.\nLine four of the prayer.',
        scroll_uppercase: false,
        color: '#FFFDF9',
        scroll_body_bg_enabled: true,
        scroll_body_bg_style: 'xmas_candy_ribbon',
        scroll_body_bg_mode: 'inline-joined',
        scroll_typewriter_enabled: true,
        scroll_tw_speech_sync: true,
        scroll_tw_reveal_type: 'char',
        scroll_tw_hide_unread: true,
        scroll_tw_unrevealed_opacity: 0,
        scroll_tw_active_highlight: true,
        scroll_tw_active_color: '#ffd700',
        start: 0,
        end: 12,
        _exporting: false,
        _previewPlaying: false,
        _taskSegments: [
            {
                start: 4.0,
                end: 10.0,
                text: 'Line one of the prayer. Line two of the prayer. Line three of the prayer. Line four of the prayer.',
            },
        ],
    });
    fillRecords.length = 0;
    ReelsOverlay.drawOverlay(ovCtx, twHiddenUnreadOv, 0.0, 1080, 1920);
    assert.ok(
        fillRecords.some(r => r.text.includes('Line one')),
        'Paused preview at t=0.0s with hide_unread=true must show demonstration lines instead of blanking out the subtitle'
    );
    // Preset editor static preview (_exporting: true, _staticPreview: true) at t=0.0s must also show demonstration lines
    fillRecords.length = 0;
    ReelsOverlay.drawOverlay(ovCtx, { ...twHiddenUnreadOv, _exporting: true, _staticPreview: true }, 0.0, 1080, 1920);
    assert.ok(
        fillRecords.some(r => r.text.includes('Line one')),
        'Preset editor static preview at t=0.0s with hide_unread=true must show demonstration lines'
    );
});

test('Chengpin 04 style preset: natural 5-word auto-pagination, top-heavy balanced 2-line wrap, two-pass sticker outline, and push-apart active word scale', () => {
    const sandbox = loadBrowserScript('src/reels-style-engine.js', { window: { addEventListener() {} } });
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);
    const engine = sandbox.window.ReelsStyleEngine;
    const presetName = '🟢 绿字放大推开_双行爆款 (成品04同款)';
    const style = engine.applySubtitlePreset(presetName);

    assert.equal(style.highlight_scale_enabled, true);
    assert.equal(style.highlight_push_apart, true);
    assert.equal(style.max_words_per_segment, 5);
    assert.equal(style.max_words_per_line, 4);
    assert.equal(style.balanced_two_line_wrap, true);
    assert.equal(style.uppercase, true);

    const callOrder = [];
    const ctx = {
        globalAlpha: 1,
        font: '900 82px Montserrat',
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
        strokeText(txt) { callOrder.push({ kind: 'stroke', text: String(txt), strokeStyle: String(this.strokeStyle) }); },
        fillText(txt) { callOrder.push({ kind: 'fill', text: String(txt), fillStyle: String(this.fillStyle) }); },
        measureText(text) {
            const pxMatch = String(this.font || '').match(/([\d.]+)px/);
            const px = pxMatch ? parseFloat(pxMatch[1]) : 82;
            return { width: String(text).length * px * 0.58 };
        }
    };
    const renderer = new sandbox.window.ReelsCanvasRenderer({ getContext: () => ctx });

    const rawWords = ['3', 'signs', 'God', 'is', 'protecting', 'you', 'from', 'harm.'];
    const seg = {
        start: 0,
        end: 4.0,
        text: rawWords.join(' '),
        words: rawWords.map((w, i) => ({ word: w, start: i * 0.5, end: (i + 1) * 0.5 }))
    };

    const drawnWords = [];
    const origDrawWord = renderer._drawWord.bind(renderer);
    renderer._drawWord = function (c, text, x, y, color, st, isHighlight, wordScale, useStroke) {
        drawnWords.push({ text, x, y, color, isHighlight, wordScale });
        return origDrawWord(c, text, x, y, color, st, isHighlight, wordScale, useStroke);
    };

    // Page 1 at t = 0.7s ("signs" is active on line 1 of ["3 SIGNS GOD IS", "PROTECTING"])
    drawnWords.length = 0;
    callOrder.length = 0;
    renderer.renderSubtitle(style, seg, 0.7, 1080, 1920);
    assert.deepEqual(
        drawnWords.map(w => w.text),
        ['3', 'SIGNS', 'GOD', 'IS', 'PROTECTING'],
        'First sub-page should auto-paginate to 5 words'
    );
    // Verify 2-line balanced wrap: first 4 words on line 1 (same y), 5th word on line 2 (larger y)
    assert.equal(drawnWords[0].y, drawnWords[1].y);
    assert.equal(drawnWords[1].y, drawnWords[2].y);
    assert.equal(drawnWords[2].y, drawnWords[3].y);
    assert.ok(drawnWords[4].y > drawnWords[0].y, '5th word "PROTECTING" wraps onto line 2');

    // Verify two-pass unified sticker outline: all strokeText calls happen before any non-shadow word fillText call
    const firstTextFillIdx = callOrder.findIndex(c => c.kind === 'fill' && c.fillStyle.toUpperCase() !== '#000000');
    const lastStrokeIdx = callOrder.map(c => c.kind).lastIndexOf('stroke');
    assert.ok(firstTextFillIdx > lastStrokeIdx && lastStrokeIdx >= 0, 'All outer strokes must be drawn before any word fill');

    // Verify push-apart active word scale: compare gap around "SIGNS" when active (t=0.7s) vs inactive (t=2.2s when "PROTECTING" is active)
    const signsActiveLeftGap = drawnWords[1].x - drawnWords[0].x;
    const signsActiveRightGap = drawnWords[2].x - drawnWords[1].x;

    drawnWords.length = 0;
    renderer.renderSubtitle(style, seg, 2.2, 1080, 1920);
    const signsInactiveLeftGap = drawnWords[1].x - drawnWords[0].x;
    const signsInactiveRightGap = drawnWords[2].x - drawnWords[1].x;

    assert.ok(
        signsActiveLeftGap > signsInactiveLeftGap && signsActiveRightGap > signsInactiveRightGap,
        'When "SIGNS" scales up to 138%, highlight_push_apart must push "3" left and "GOD" right so words never overlap'
    );

    // Page 2 at t = 2.7s ("YOU FROM HARM.")
    drawnWords.length = 0;
    renderer.renderSubtitle(style, seg, 2.7, 1080, 1920);
    assert.deepEqual(
        drawnWords.map(w => w.text),
        ['YOU', 'FROM', 'HARM.'],
        'Second sub-page should show remaining 3 words'
    );
    assert.equal(drawnWords[0].y, drawnWords[1].y, '"YOU FROM" on line 1');
    assert.ok(drawnWords[2].y > drawnWords[0].y, '"HARM." on line 2');
});

test('Task deletion in left list and batch table prevents drag hijack and never resurrects deleted tasks on close', () => {
    const batchReelsSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    const batchTableSrc = fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8');
    const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');

    assert.ok(
        batchReelsSrc.includes(".reels-task-delete-btn, .reels-task-duplicate-btn"),
        'reelsTaskDragStart must ignore pointer/drag events originating on delete/duplicate buttons'
    );
    assert.ok(
        batchReelsSrc.includes('window.reelsRemoveSelectedTasks = reelsRemoveSelectedTasks;') &&
        batchReelsSrc.includes('window.reelsRemoveBatchGroup = reelsRemoveBatchGroup;') &&
        batchReelsSrc.includes('window.reelsRemoveIncompleteTasksInGroup = reelsRemoveIncompleteTasksInGroup;'),
        'batch-reels.js must expose batch delete, group delete, and incomplete task cleanup helpers'
    );
    assert.ok(
        batchTableSrc.includes('window.reelsSyncActiveBatchTabFromId = reelsSyncActiveBatchTabFromId;'),
        'reels-batch-table.js must expose reelsSyncActiveBatchTabFromId so selecting a task syncs the active batch tab'
    );
    assert.ok(
        batchTableSrc.includes('if (_batchTableState.editSessionSnapshot)') &&
        batchTableSrc.includes('if (_batchTableState.openedGroupedProjection && Array.isArray(_batchTableState.openedGroupedProjection.tasks))'),
        'reelsSyncTaskRemovalToBatchTabs must also purge deleted tasks from editSessionSnapshot and openedGroupedProjection'
    );
    assert.ok(
        batchTableSrc.includes('id="rbt-top-apply-btn"'),
        'Batch table top toolbar must include #rbt-top-apply-btn (保存并关闭)'
    );
    assert.ok(
        indexHtmlSrc.includes('id="reels-batch-delete-btn"'),
        'index.html must include #reels-batch-delete-btn (删除已选) in the task list header'
    );
});

test('Christmas writing pens, subtitle ribbon bands, ornaments, and presets are registered and render cleanly', () => {
    const sandbox = loadBrowserScript('src/reels-style-engine.js', { window: { addEventListener() {} } });
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-overlay.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);

    const isTip = sandbox.window.isImageOrVectorWritingTip;
    for (const kind of ['candy_cane', 'christmas_tree', 'holly_berry', 'snowflake_wand', 'santa_feather', 'jingle_bell']) {
        assert.equal(isTip(kind), true, `Christmas writing tip "${kind}" must be registered in BUILTIN_WRITING_TIP_KINDS`);
    }

    const brushEngine = sandbox.window.ReelsBrushEngine;
    for (const bandStyle of ['xmas_candy_ribbon', 'xmas_velvet_gold', 'xmas_pine_snow', 'xmas_gingerbread_tag', 'xmas_frost_ice']) {
        assert.equal(brushEngine.isTextBackingStyle(bandStyle), true, `Christmas backing style "${bandStyle}" must be registered in ReelsBrushEngine.TEXT_BACKING_STYLES`);
    }
    for (const cardStyle of [
        'newspaper_page',
        'newspaper_sepia_page',
        'torn_parchment_board',
        'kraft_clipboard',
        'grid_notebook_page',
        'dark_film_board',
        'xmas_candy_frame',
        'xmas_velvet_gold_board',
        'xmas_pine_snow_board',
        'xmas_gingerbread_card',
        'xmas_starry_snow_night',
        'xmas_cream_holly_letter',
    ]) {
        assert.equal(brushEngine.isCardBackgroundStyle(cardStyle), true, `Card background style "${cardStyle}" must be registered in ReelsBrushEngine.CARD_BACKGROUND_STYLES`);
        let saveCount = 0;
        let restoreCount = 0;
        const mockGrad = { addColorStop() {} };
        const mockCtx = {
            globalAlpha: 1,
            save() { saveCount++; },
            restore() { restoreCount++; },
            beginPath() {},
            closePath() {},
            moveTo() {},
            lineTo() {},
            quadraticCurveTo() {},
            bezierCurveTo() {},
            arc() {},
            arcTo() {},
            rect() {},
            clip() {},
            fill() {},
            stroke() {},
            fillRect() {},
            strokeRect() {},
            clearRect() {},
            translate() {},
            rotate() {},
            scale() {},
            setLineDash() {},
            createPattern() { return {}; },
            createLinearGradient() { return mockGrad; },
            createRadialGradient() { return mockGrad; },
        };
        const translations = [];
        mockCtx.translate = (tx, ty) => { translations.push([tx, ty]); };
        brushEngine.drawThemedCardBackground(mockCtx, 40, 420, 1000, 1130, 16, {
            style: cardStyle,
            opacity: 0.96,
            scrollOffsetY: -245,
        });
        assert.equal(saveCount, restoreCount, `drawThemedCardBackground("${cardStyle}") must balance ctx.save() and ctx.restore() so canvas clip state never leaks`);
        assert.ok(translations.length > 0, `drawThemedCardBackground("${cardStyle}") with scrollOffsetY must translate interior texture/elements in a loop`);
    }

    // Verify createScrollOverlay supports custom card/border dimensions & upward scroll follow
    const scrollOv = sandbox.window.ReelsOverlay.createScrollOverlay({
        bg_enabled: true,
        bg_style: 'newspaper_page',
        bg_width: 860,
        bg_height: 980,
        bg_offset_x: 10,
        bg_offset_y: -15,
        bg_body_only: true,
    });
    assert.equal(scrollOv.bg_width, 860);
    assert.equal(scrollOv.bg_height, 980);
    assert.equal(scrollOv.bg_offset_x, 10);
    assert.equal(scrollOv.bg_offset_y, -15);
    assert.equal(scrollOv.bg_body_only, true);
    assert.equal(scrollOv.bg_scroll_follow, true, 'bg_scroll_follow should default to true so newspaper/card backgrounds scroll upward with subtitles');

    // Verify bg_body_only with Auto height (bg_height=0) hugs bottom body text and never covers top title or middle video
    const mockGradForScroll = { addColorStop() {} };
    const makeScrollMockCtx = () => ({
        globalAlpha: 1,
        font: '48px sans-serif',
        save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
        quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, arcTo() {}, ellipse() {},
        rect() {}, clip() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {},
        clearRect() {}, drawImage() {}, translate() {}, rotate() {}, scale() {},
        setLineDash() {}, fillText() {}, strokeText() {},
        measureText(str) { return { width: String(str || '').length * 22 }; },
        createPattern() { return {}; },
        createLinearGradient() { return mockGradForScroll; },
        createRadialGradient() { return mockGradForScroll; },
    });
    const bodyOnlyAutoOv = sandbox.window.ReelsOverlay.createScrollOverlay({
        x: 70, y: 400, w: 940, h: 1120,
        scroll_title: 'JESUS IS COMING BACK - ONLY 3\nSIGNS REMAIN',
        scroll_title_enabled: true,
        scroll_title_fixed: true,
        scroll_title_independent: false,
        scroll_from_y: 1450,
        scroll_speed: 120,
        content: 'You may have\nscrolled past many\nvideos about the end\ntimes without stopping',
        bg_enabled: true,
        bg_style: 'newspaper_page',
        bg_padding_top: 55,
        bg_padding_bottom: 50,
        bg_body_only: true,
        bg_height: 0,
    });
    sandbox.window.ReelsOverlay.drawOverlay(makeScrollMockCtx(), bodyOnlyAutoOv, 2.5, 1080, 1920);
    assert.ok(bodyOnlyAutoOv._renderedY > 600, `Expected bg_body_only Auto card Y (${bodyOnlyAutoOv._renderedY}) to stay strictly below fixed title (y=400..596)`);
    assert.ok(bodyOnlyAutoOv._renderedY > 1000, `Expected bg_body_only Auto card Y (${bodyOnlyAutoOv._renderedY}) at t=2.5s to hug bottom scrolling body text instead of covering middle video`);

    // Verify bg_body_only with explicit bg_height anchors to bottom of body area
    const bodyOnlyFixedHOv = sandbox.window.ReelsOverlay.createScrollOverlay({
        x: 70, y: 400, w: 940, h: 1120,
        scroll_title: 'JESUS IS COMING BACK - ONLY 3\nSIGNS REMAIN',
        scroll_title_enabled: true,
        scroll_title_fixed: true,
        scroll_title_independent: false,
        scroll_from_y: 1450,
        scroll_speed: 120,
        content: 'You may have\nscrolled past many\nvideos about the end',
        bg_enabled: true,
        bg_style: 'newspaper_page',
        bg_padding_top: 55,
        bg_padding_bottom: 50,
        bg_body_only: true,
        bg_height: 420,
        bg_width: 820,
    });
    sandbox.window.ReelsOverlay.drawOverlay(makeScrollMockCtx(), bodyOnlyFixedHOv, 2.5, 1080, 1920);
    assert.equal(bodyOnlyFixedHOv._renderedW, 820, 'Explicit bg_width=820 must set rendered card width to 820');
    assert.equal(bodyOnlyFixedHOv._renderedH, 420, 'Explicit bg_height=420 must set rendered card height to 420');
    assert.equal(bodyOnlyFixedHOv._renderedY, 1100, 'Explicit bg_height=420 with bg_body_only=true must anchor to bottom (1520 - 420 = 1100)');

    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    assert.ok(panelSrc.includes('id="rop-scroll-bg-style"'), 'Scroll overlay panel must include #rop-scroll-bg-style dropdown');
    assert.ok(panelSrc.includes('id="rop-scroll-title-bg-style"'), 'Scroll overlay panel must include #rop-scroll-title-bg-style dropdown');
    assert.ok(panelSrc.includes('rop-scroll-card-bg-preset'), 'Scroll overlay panel must include one-click .rop-scroll-card-bg-preset buttons');
    assert.ok(panelSrc.includes('rop-scroll-body-bg-preset'), 'Scroll overlay panel must include one-click .rop-scroll-body-bg-preset buttons');
    assert.ok(panelSrc.includes('id="rop-scroll-bg-width"'), 'Scroll overlay panel must include #rop-scroll-bg-width control');
    assert.ok(panelSrc.includes('id="rop-scroll-bg-height"'), 'Scroll overlay panel must include #rop-scroll-bg-height control');
    assert.ok(panelSrc.includes('id="rop-scroll-bg-scroll-follow"'), 'Scroll overlay panel must include #rop-scroll-bg-scroll-follow checkbox');
    assert.ok(panelSrc.includes('id="rop-scroll-bg-width-quick"'), 'Scroll overlay panel must include top quick width slider');
    assert.ok(panelSrc.includes('id="rop-scroll-body-bg-pad-h-quick"'), 'Scroll overlay panel must include top quick per-line length slider');

    const previewV2Src = fs.readFileSync(path.join(ROOT, 'src/reels-preview-v2.js'), 'utf8');
    assert.ok(previewV2Src.includes('hitTestOverlayHandle'), 'Preview V2 must support interactive 8-handle overlay resizing on canvas');

    // Verify Decor Overlay (30款点缀图层: 黑色氛围模板 / 飘浮粒子 / 电影颗粒 / 回忆颗粒感 / 发光星星 / 圣诞装饰 / 复古角框)
    assert.equal(typeof sandbox.window.ReelsOverlay.createDecorOverlay, 'function', 'ReelsOverlay.createDecorOverlay must exist');
    assert.equal(typeof sandbox.window.ReelsOverlay.applyDecorStylePreset, 'function', 'ReelsOverlay.applyDecorStylePreset must exist');
    const decorStyles = sandbox.window.ReelsOverlay.DECOR_OVERLAY_STYLES;
    assert.equal(Object.keys(decorStyles).length, 34, 'DECOR_OVERLAY_STYLES must provide 34 built-in embellishment & grain styles (including 4 Veterans Day styles)');
    for (const styleKey of Object.keys(decorStyles)) {
        const decorOv = sandbox.window.ReelsOverlay.createDecorOverlay({
            decor_style: styleKey,
            decor_snowflakes: true,
        });
        let saves = 0;
        let restores = 0;
        const mockGrad = { addColorStop() {} };
        const mockCtx = {
            globalAlpha: 1,
            save() { saves++; },
            restore() { restores++; },
            beginPath() {},
            closePath() {},
            moveTo() {},
            lineTo() {},
            quadraticCurveTo() {},
            bezierCurveTo() {},
            arc() {},
            arcTo() {},
            ellipse() {},
            rect() {},
            clip() {},
            fill() {},
            stroke() {},
            fillRect() {},
            strokeRect() {},
            clearRect() {},
            drawImage() {},
            translate() {},
            rotate() {},
            scale() {},
            setLineDash() {},
            createPattern() { return {}; },
            createLinearGradient() { return mockGrad; },
            createRadialGradient() { return mockGrad; },
        };
        sandbox.window.ReelsOverlay.drawOverlay(mockCtx, decorOv, 1.5, 1080, 1920);
        assert.equal(saves, restores, `drawOverlay for decor_style="${styleKey}" must balance ctx.save() and ctx.restore()`);
    }
    assert.ok(panelSrc.includes('id="rop-add-decor"'), 'Overlay panel must include + ✨ 点缀图层 button');
    assert.ok(panelSrc.includes('id="rop-decor-props"'), 'Overlay panel must include #rop-decor-props section');
    assert.ok(panelSrc.includes('class ReelsDecorPanel'), 'Overlay panel module must define standalone ReelsDecorPanel for the dedicated tab');
    assert.ok(panelSrc.includes('id="rdp-master-enable"'), 'ReelsDecorPanel must include master enable checkbox #rdp-master-enable');
    assert.ok(panelSrc.includes('id="rdp-dark-enabled"'), 'ReelsDecorPanel must include dark template enable checkbox #rdp-dark-enabled');
    assert.ok(panelSrc.includes('id="rdp-grain-enabled"'), 'ReelsDecorPanel must include film grain enable checkbox #rdp-grain-enabled');

    // Verify decor_dark_enabled and decor_grain_enabled switches gate rendering independently
    const toggleTestOv = sandbox.window.ReelsOverlay.createDecorOverlay({
        decor_style: 'dark_floating_dust',
        decor_dark_vignette: 85,
        decor_dark_enabled: false,
        decor_grain_intensity: 60,
        decor_grain_warmth: 40,
        decor_grain_enabled: false,
        decor_floating_particles: false,
        decor_glow_stars: false,
        decor_snowflakes: false,
        decor_corner_ornaments: false,
        decor_edge_garland: false,
        decor_film_scratches: false,
        decor_light_leak: false,
    });
    let fillRectCalls = 0;
    const silentGrad = { addColorStop() {} };
    const toggleCtx = {
        globalAlpha: 1,
        save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
        quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, arcTo() {}, ellipse() {}, rect() {}, clip() {},
        fill() {}, stroke() {}, strokeRect() {}, clearRect() {}, drawImage() {}, translate() {}, rotate() {}, scale() {}, setLineDash() {},
        fillRect() { fillRectCalls++; },
        createPattern() { return {}; },
        createLinearGradient() { return silentGrad; },
        createRadialGradient() { return silentGrad; },
    };
    sandbox.window.ReelsOverlay.drawOverlay(toggleCtx, toggleTestOv, 1.0, 1080, 1920);
    assert.equal(fillRectCalls, 0, 'When all sub-effects (including decor_dark_enabled and decor_grain_enabled) are unchecked, drawOverlay must draw 0 fillRect calls');

    toggleTestOv.decor_dark_enabled = true;
    sandbox.window.ReelsOverlay.drawOverlay(toggleCtx, toggleTestOv, 1.0, 1080, 1920);
    assert.ok(fillRectCalls > 0, 'When decor_dark_enabled is checked, dark template vignette must render');

    // Verify independent preview/export toggle and middle-layer z-order across all pipelines
    const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    assert.ok(indexHtmlSrc.includes('data-tab="decor"'), 'Inspector tab bar must include standalone ✨ 点缀与颗粒 tab button');
    assert.ok(indexHtmlSrc.includes('id="inspector-tab-decor"'), 'Inspector must include #inspector-tab-decor container');
    assert.ok(indexHtmlSrc.includes('id="reels-decor-panel-root"'), 'Inspector must include #reels-decor-panel-root mount node');
    assert.ok(indexHtmlSrc.includes('id="reels-decor-toggle"'), 'Preview bar must include dedicated #reels-decor-toggle checkbox');
    assert.ok(previewV2Src.includes('data-role="decor"'), 'Preview V2 bar must include dedicated [data-role="decor"] checkbox');
    assert.ok(previewV2Src.includes("drawOverlays(ctx, task, overlayTime, w, h, phase, 'middle')"), 'Preview V2 must render middle decor/insert layer before subtitles and regular overlays');

    const batchReelsSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    assert.ok(batchReelsSrc.includes('function _isReelsDecorToggleEnabled()'), 'batch-reels.js must define _isReelsDecorToggleEnabled()');
    assert.ok(batchReelsSrc.includes('function reelsOnDecorToggleChange(checkbox)'), 'batch-reels.js must define reelsOnDecorToggleChange(checkbox)');
    assert.ok(batchReelsSrc.includes("renderOverlays('middle')"), 'V1 preview must render middle decor/insert layer before subtitles and regular overlays');
    assert.ok(batchReelsSrc.includes('_reelsState.decorPanel.refresh()'), 'reelsSelectTask must refresh ReelsDecorPanel when switching tasks');
    assert.ok(panelSrc.includes('_syncDecorStackToScopeTasks()'), 'ReelsDecorPanel must synchronize the full decor layer stack across scoped tasks');

    const wysiwygSrc = fs.readFileSync(path.join(ROOT, 'src/reels-wysiwyg-export.js'), 'utf8');
    assert.ok(wysiwygSrc.includes('drawOverlayGroup(middleOvs)'), 'WYSIWYG export must render middle decor/insert layer before subtitles and regular overlays');

    // Verify ReelsRenderPlan orders decor between insert clips and regular overlays
    loadBrowserScript('src/reels-render-plan.js', sandbox);
    const mockTask = {
        overlays: [
            { id: 'ov_card', type: 'textcard', title_text: 'Top Card' },
            { id: 'ov_decor', type: 'decor', decor_style: 'dark_floating_dust' },
            { id: 'ov_scroll', type: 'scroll', content: 'Scrolling text' },
        ],
        visualOverlayOrder: ['overlay:ov_card', 'overlay:ov_decor', 'overlay:ov_scroll'],
    };
    const composited = sandbox.window.ReelsRenderPlan.getCompositedOverlays(mockTask, { forExport: true });
    assert.equal(composited[0].id, 'ov_decor', 'getCompositedOverlays must always place decor middle-layer before textcard/scroll overlays');
    assert.ok(composited[0].z_index < composited[1].z_index && composited[0].z_index < composited[2].z_index, 'Decor overlay must have lower z_index than regular overlays');

    const presets = sandbox.window.REELS_BUILTIN_PRESETS;
    for (const presetName of [
        '🎄 圣诞红绿金_双行推开爆款',
        '🍬 圣诞拐杖糖斜纹带_手写笔出字',
        '🎅 圣诞红丝绒烫金_冬青装饰带',
        '❄️ 圣诞松林覆雪带_暖金发光字',
        '🍪 圣诞姜饼糖霜签_复古剪报字',
    ]) {
        assert.ok(presets[presetName], `Built-in Christmas preset "${presetName}" must exist`);
    }
});

test('All built-in subtitle presets (including fullpage_typewriter newspaper cutout & candy ribbon) render without error and produce visible on-screen output', () => {
    const sandbox = loadBrowserScript('src/reels-style-engine.js', { window: { addEventListener() {} } });
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    loadBrowserScript('src/reels-overlay.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);

    const engine = sandbox.window.ReelsStyleEngine;
    const allPresets = engine.loadSubtitlePresets().presets;
    const presetNames = Object.keys(allPresets);
    assert.ok(presetNames.length >= 70, `Expected at least 70 built-in subtitle presets, got ${presetNames.length}`);

    const drawnWords = [];
    const fillTextCalls = [];
    let cutoutCalls = 0;
    const origCutout = sandbox.window.ReelsBrushEngine.drawTextCutoutBacking.bind(sandbox.window.ReelsBrushEngine);
    sandbox.window.ReelsBrushEngine.drawTextCutoutBacking = function (ctx, lines, opts) {
        cutoutCalls++;
        return origCutout(ctx, lines, opts);
    };

    const mockGrad = { addColorStop() {} };
    const ctx = {
        canvas: { width: 1080, height: 1920 },
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        font: '700 74px sans-serif',
        fillStyle: '#fff',
        strokeStyle: '#000',
        lineWidth: 2,
        lineJoin: 'round',
        miterLimit: 2,
        direction: 'ltr',
        textAlign: 'left',
        textBaseline: 'top',
        save() {},
        restore() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        bezierCurveTo() {},
        arc() {},
        arcTo() {},
        ellipse() {},
        rect() {},
        clip() {},
        fill() {},
        stroke() {},
        fillRect() {},
        strokeRect() {},
        clearRect() {},
        drawImage() {},
        translate() {},
        rotate() {},
        scale() {},
        setLineDash() {},
        createPattern() { return {}; },
        createLinearGradient() { return mockGrad; },
        createRadialGradient() { return mockGrad; },
        measureText(txt) {
            const m = String(this.font || '').match(/([\d.]+)px/);
            const px = m ? parseFloat(m[1]) : 74;
            return {
                width: String(txt || '').length * px * 0.55,
                actualBoundingBoxAscent: px * 0.75,
                actualBoundingBoxDescent: px * 0.22,
            };
        },
        fillText(txt, x, y) { fillTextCalls.push({ text: String(txt), x, y, alpha: this.globalAlpha }); },
        strokeText() {},
    };

    const renderer = new sandbox.window.ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: () => ctx });
    const origDrawWord = renderer._drawWord.bind(renderer);
    renderer._drawWord = function (c, text, x, y, color, ...rest) {
        drawnWords.push({ text: String(text), x, y, color });
        return origDrawWord(c, text, x, y, color, ...rest);
    };

    // Build a 12-segment script (simulating a full 36-second Reels video) so fullpage_typewriter tests multi-page pagination
    const multiSegments = Array.from({ length: 12 }, (_, idx) => {
        const s0 = idx * 3.0;
        const rawWords = ['God', 'is', 'opening', 'a', 'new', 'door', 'for', 'you'];
        return {
            start: s0,
            end: s0 + 2.8,
            text: rawWords.join(' '),
            words: rawWords.map((w, wi) => ({
                word: w,
                start: s0 + wi * 0.35,
                end: s0 + (wi + 1) * 0.35,
            })),
        };
    });

    for (const name of presetNames) {
        const style = engine.applySubtitlePreset(name);
        assert.ok(style, `Preset "${name}" must resolve to a valid style object`);
        renderer.setContextSegments(multiSegments, multiSegments.map(s => s.text).join(' '));

        drawnWords.length = 0;
        fillTextCalls.length = 0;
        renderer.renderSubtitle(style, multiSegments[0], 0.45, 1080, 1920);
        assert.ok(
            drawnWords.length > 0 || fillTextCalls.length > 0,
            `Preset "${name}" must draw visible subtitle text at t=0.45s`
        );
    }

    // Specifically verify "📰 复古报纸剪报整屏 (多行累积)" and "🍬 圣诞拐杖糖斜纹带_手写笔出字" at t=0.0s and t=1.2s
    for (const twPresetName of ['📰 复古报纸剪报整屏 (多行累积)', '🍬 圣诞拐杖糖斜纹带_手写笔出字']) {
        const style = engine.applySubtitlePreset(twPresetName);
        renderer.setContextSegments(multiSegments, multiSegments.map(s => s.text).join(' '));

        drawnWords.length = 0;
        cutoutCalls = 0;
        renderer.renderSubtitle(style, multiSegments[0], 0.0, 1080, 1920);
        assert.ok(drawnWords.length > 0, `"${twPresetName}" must draw visible text at t=0.0s`);
        assert.ok(cutoutCalls > 0, `"${twPresetName}" must draw its cutout backing at t=0.0s without ReferenceError`);
        assert.ok(
            drawnWords.every(w => w.y >= 0 && w.y <= 1920),
            `"${twPresetName}" must paginate long multi-segment scripts so all visible lines stay on-screen (0..1920), got Y=${drawnWords.map(w => Math.round(w.y)).join(',')}`
        );
    }

    // Verify quick-cut / talking-head export protections against "视频编码收尾超时"
    const rawvideoSrc = fs.readFileSync(path.join(ROOT, 'electron/services/ffmpeg-rawvideo.js'), 'utf8');
    assert.ok(
        rawvideoSrc.includes('const needAlphaStreamLoop = !isAlphaBgImage && !useDirectLoopFade') &&
        rawvideoSrc.includes("args.push('-fflags', '+genpts', '-i', opts.alphaOverlayBgPath);"),
        'startSession must avoid infinite -stream_loop -1 on single-pass/talking-head clips so tpad=stop_mode=clone works cleanly at EOF'
    );
    assert.ok(
        rawvideoSrc.includes('tpad=stop_mode=clone:stop_duration=5') &&
        rawvideoSrc.includes('setpts=PTS-STARTPTS'),
        'ffmpeg-rawvideo.js must pad non-looped extractSimpleLoop with tpad and normalize start_pts'
    );
    const wysiwygExportSrc = fs.readFileSync(path.join(ROOT, 'src/reels-wysiwyg-export.js'), 'utf8');
    assert.ok(
        wysiwygExportSrc.includes('_alphaFallbackRetried: true') &&
        wysiwygExportSrc.includes('!params._alphaFallbackRetried'),
        'reelsWysiwygExport must automatically fall back from alphaOverlayBgPath to standard frame-extraction mode if fast alpha overlay fails or times out'
    );
});

test('scroll card quick opacity slider, repeat maker modal, and ai-cn-date smart naming are wired', () => {
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    const overlaySrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay.js'), 'utf8');
    const batchTableSrc = fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8');
    const batchReelsSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    const apiRouterSrc = fs.readFileSync(path.join(ROOT, 'electron/apiRouter.js'), 'utf8');
    const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');

    // 1. Scroll background quick opacity sliders & feather-inset card height
    assert.ok(panelSrc.includes('id="rop-scroll-bg-opacity-quick"') && panelSrc.includes('id="rop-scroll-bg-opacity-quick-num"'));
    assert.ok(panelSrc.includes('id="rop-scroll-body-bg-opacity-quick"') && panelSrc.includes('id="rop-scroll-body-bg-opacity-quick-num"'));
    assert.ok(overlaySrc.includes('const _fTopInset = Math.max(0, parseFloat(ov.feather_top_offset ?? 0))'));
    assert.ok(overlaySrc.includes('const effClipY = ov.bg_body_only ? bodyClipTopBase : clipY;'));

    // 2. Repeat Maker (🔁 重复制作) buttons, modal, and alignment reuse
    assert.ok(batchTableSrc.includes('id="rbt-repeat-maker-bar-btn"'));
    assert.ok(batchTableSrc.includes('id="rbt-th-repeat-maker-btn"'));
    assert.ok(batchTableSrc.includes('id="rbt-repeat-maker-btn"'));
    assert.ok(batchTableSrc.includes('function _showRepeatMakerModal()'));
    assert.ok(batchTableSrc.includes('reused_same_audio_text'));

    // 3. AI Chinese first-sentence + context upper/lower part naming (20261102-文案第一句)
    assert.ok(apiRouterSrc.includes("case 'ai/smart-export-names':"));
    assert.ok(indexHtmlSrc.includes('<option value="ai-cn-date">'));
    assert.ok(batchTableSrc.includes('<option value="ai-cn-date"'));
    assert.ok(batchReelsSrc.includes('async function _ensureReelsAiChineseExportNames('));

    // 4. Underline sweep ("底线扫描显字" / "✨ 极简底线扫描显字 (I AM BLESSED同款)")
    assert.ok(indexHtmlSrc.includes('<option value="underline_sweep">底线扫描显字</option>'));
    const sandbox = loadBrowserScript('src/reels-style-engine.js', { window: { addEventListener() {} } });
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);

    const ReelsStyleEngine = sandbox.window.ReelsStyleEngine;
    const ReelsAnimEngine = sandbox.window.ReelsAnimEngine;
    const ReelsCanvasRenderer = sandbox.window.ReelsCanvasRenderer;

    const blessedPreset = ReelsStyleEngine.applySubtitlePreset('✨ 极简底线扫描显字 (I AM BLESSED同款)');
    assert.equal(blessedPreset.anim_in_type, 'underline_sweep');
    assert.equal(blessedPreset.uppercase, true);
    assert.equal(blessedPreset.max_words_per_segment, 4);

    const sweepEarly = ReelsAnimEngine.computeUnderlineSweepState(0.12, 0.0, 2.0, [300], { sweepDuration: 0.46, fontSize: 52 });
    assert.equal(sweepEarly.active, true);
    assert.ok(sweepEarly.barW > 10 && sweepEarly.barAlpha > 0.5, 'Scan bar should be visible mid-sweep');
    const leftCharRev = ReelsAnimEngine.computeUnderlineSweepCharReveal(10, sweepEarly);
    const rightCharRev = ReelsAnimEngine.computeUnderlineSweepCharReveal(280, sweepEarly);
    assert.ok(leftCharRev.fillAlpha > 0.9 && leftCharRev.strokeAlpha > 0.8, 'Left character already swept should be crisp');
    assert.ok(Math.abs(rightCharRev.fillAlpha - 0.26) < 0.05 && rightCharRev.strokeAlpha < 0.05, 'Right character not yet swept should be soft ghost silhouette without dark stroke');

    const sweepDone = ReelsAnimEngine.computeUnderlineSweepState(0.85, 0.0, 2.0, [300], { sweepDuration: 0.46, fontSize: 52 });
    assert.equal(sweepDone.active, false);
    assert.equal(sweepDone.barAlpha, 0);

    const mockGrad = { addColorStop() {} };
    let barDraws = 0;
    const charAlphas = [];
    const alphaStack = [];
    const ctx = {
        font: '800 52px Montserrat',
        globalAlpha: 1,
        save() { alphaStack.push(this.globalAlpha); },
        restore() { if (alphaStack.length) this.globalAlpha = alphaStack.pop(); },
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        arcTo() {},
        fill() {},
        stroke() {},
        fillRect() {},
        translate() {},
        rotate() {},
        scale() {},
        createLinearGradient() { return mockGrad; },
        createRadialGradient() { return mockGrad; },
        measureText(txt) { return { width: String(txt || '').length * 28, actualBoundingBoxAscent: 38, actualBoundingBoxDescent: 10 }; },
        fillText(txt) { charAlphas.push({ text: String(txt), alpha: Number(this.globalAlpha.toFixed(2)) }); },
        strokeText() {},
    };
    const renderer = new ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: () => ctx });
    const origDrawBar = renderer._drawUnderlineSweepBar.bind(renderer);
    renderer._drawUnderlineSweepBar = function (...args) {
        barDraws++;
        return origDrawBar(...args);
    };
    const seg = {
        start: 0,
        end: 2.0,
        text: 'I am blessed',
        words: [
            { word: 'I', start: 0, end: 0.4 },
            { word: 'am', start: 0.4, end: 0.9 },
            { word: 'blessed', start: 0.9, end: 2.0 },
        ],
    };
    renderer.renderSubtitle(blessedPreset, seg, 0.18, 1080, 1920);
    assert.equal(barDraws, 1, 'Should draw glowing underline scan bar during sweep');
    assert.ok(charAlphas.some(c => c.alpha > 0.9) && charAlphas.some(c => c.alpha < 0.4), 'During sweep, left chars are opaque and right chars are ghosted');

    // 5. Three-word hero focus stack ("三词叠排(中词放大)" / "💎 三词叠排_中词放大_电光青 (IF JESUS同款)")
    assert.ok(indexHtmlSrc.includes('<option value="three_word_focus_stack">三词叠排(中词放大)</option>'));
    const jesusPreset = ReelsStyleEngine.applySubtitlePreset('💎 三词叠排_中词放大_电光青 (IF JESUS同款)');
    assert.equal(jesusPreset.anim_in_type, 'three_word_focus_stack');
    assert.equal(jesusPreset.three_word_hero_scale, 1.92);
    assert.equal(jesusPreset.color_high, '#1CEBFF');
    assert.equal(jesusPreset.color_text, '#FFFFFF');
    assert.equal(jesusPreset.uppercase, true);
    assert.equal(jesusPreset.italic, true);

    const stackDraws = [];
    const origDrawWord = renderer._drawWord.bind(renderer);
    renderer._drawWord = function (c, wordText, wx, wy, wColor, ...rest) {
        stackDraws.push({ text: wordText, x: wx, y: wy, color: wColor, font: c.font });
        return origDrawWord(c, wordText, wx, wy, wColor, ...rest);
    };

    const sixWordSeg = {
        start: 0.0,
        end: 3.6,
        text: 'If Jesus means nothing to you,',
        words: [
            { word: 'If', start: 0.0, end: 0.5 },
            { word: 'Jesus', start: 0.5, end: 1.1 },
            { word: 'means', start: 1.1, end: 1.8 },
            { word: 'nothing', start: 1.8, end: 2.3 },
            { word: 'to', start: 2.3, end: 2.7 },
            { word: 'you,', start: 2.7, end: 3.1 },
        ],
    };

    // Word 1 ("IF") active: only 1 word on screen, in electric cyan (#1CEBFF)
    stackDraws.length = 0;
    renderer.renderSubtitle(jesusPreset, sixWordSeg, 0.25, 1080, 1920);
    assert.equal(stackDraws.length, 1);
    assert.equal(stackDraws[0].text, 'IF');
    assert.equal(stackDraws[0].color, '#1CEBFF');
    const slot0FixedY = stackDraws[0].y;

    // Word 2 ("JESUS") active: "IF" stays at exact same Y in white (#FFFFFF), "JESUS" appears below in cyan (#1CEBFF) at ~1.92x size
    stackDraws.length = 0;
    renderer.renderSubtitle(jesusPreset, sixWordSeg, 0.75, 1080, 1920);
    assert.equal(stackDraws.length, 2);
    assert.equal(stackDraws[0].text, 'IF');
    assert.equal(stackDraws[0].color, '#FFFFFF');
    assert.ok(Math.abs(stackDraws[0].y - slot0FixedY) < 1e-3, 'Slot 0 Y must stay fixed without jumping when Slot 1 appears');
    assert.equal(stackDraws[1].text, 'JESUS');
    assert.equal(stackDraws[1].color, '#1CEBFF');
    assert.ok(stackDraws[1].font.includes(`${46 * 1.92}px`), 'Middle hero word must render at 1.92x hero font size');

    // Word 3 ("MEANS") active: "IF" and "JESUS" are white, "MEANS" is cyan at bottom slot
    stackDraws.length = 0;
    renderer.renderSubtitle(jesusPreset, sixWordSeg, 1.35, 1080, 1920);
    assert.equal(stackDraws.length, 3);
    assert.deepEqual(stackDraws.map(d => d.text), ['IF', 'JESUS', 'MEANS']);
    assert.deepEqual(stackDraws.map(d => d.color), ['#FFFFFF', '#FFFFFF', '#1CEBFF']);

    // Group 2 ("NOTHING" / "TO" / "YOU,") comma pause at t=3.35s: all 3 words remain visible and "YOU," settles to white during pause
    stackDraws.length = 0;
    renderer.renderSubtitle(jesusPreset, sixWordSeg, 3.35, 1080, 1920);
    assert.equal(stackDraws.length, 3);
    assert.deepEqual(stackDraws.map(d => d.text), ['NOTHING', 'TO', 'YOU,']);
    assert.deepEqual(stackDraws.map(d => d.color), ['#FFFFFF', '#FFFFFF', '#FFFFFF']);

    // 6. One-click clean empty batch tabs ("🧹 一键清理空标签")
    assert.ok(batchTableSrc.includes('id="rbt-clean-empty-tabs-btn"'));
    assert.ok(batchTableSrc.includes('id="rbt-clean-empty-tabs-bar-btn"'));
    assert.ok(batchTableSrc.includes('function _cleanEmptyTabs'));
    assert.ok(batchTableSrc.includes('window.reelsCleanEmptyBatchTabs = _cleanEmptyTabs'));

    // 7. 4-line rolling rainbow karaoke ("🌈 四行滚词_彩虹渐变跟读 (成品01同款)" / rolling_rainbow_karaoke)
    assert.ok(indexHtmlSrc.includes('<option value="rolling_rainbow_karaoke">🌈 四行滚词(彩虹跟读)</option>'));
    const rainbowPreset = ReelsStyleEngine.applySubtitlePreset('🌈 四行滚词_彩虹渐变跟读 (成品01同款)');
    assert.equal(rainbowPreset.anim_in_type, 'rolling_rainbow_karaoke');
    assert.equal(rainbowPreset.color_text, '#FFFFFF');
    assert.ok(rainbowPreset.rolling_rainbow_colors.includes('#FF3824') && rainbowPreset.rolling_rainbow_colors.includes('#9B4DFF'));

    const rollingSeg = {
        start: 0.0,
        end: 6.0,
        text: 'Jesus says, do not skip this message. Stop scrolling right now.',
        words: [
            { word: 'Jesus', start: 0.0, end: 0.5 },
            { word: 'says,', start: 0.5, end: 1.0 },
            { word: 'do', start: 1.0, end: 1.4 },
            { word: 'not', start: 1.4, end: 1.8 },
            { word: 'skip', start: 1.8, end: 2.3 },
            { word: 'this', start: 2.3, end: 2.7 },
            { word: 'message.', start: 2.7, end: 3.4 },
            { word: 'Stop', start: 3.5, end: 4.1 },
            { word: 'scrolling', start: 4.1, end: 4.8 },
            { word: 'right', start: 4.8, end: 5.3 },
            { word: 'now.', start: 5.3, end: 5.9 },
        ],
    };

    stackDraws.length = 0;
    renderer.renderSubtitle(rainbowPreset, rollingSeg, 1.2, 1080, 1920);
    // At t=1.2s, "Jesus", "says,", "do" are spoken (rainbow gradient); "not", "skip", etc. are unspoken (#FFFFFF)
    const jesusDraw = stackDraws.find(d => d.text === 'Jesus');
    const saysDraw = stackDraws.find(d => d.text === 'says,');
    const doDraw = stackDraws.find(d => d.text === 'do');
    const notDraw = stackDraws.find(d => d.text === 'not');
    assert.ok(jesusDraw && jesusDraw.color.includes('#FF3824'), 'Spoken word "Jesus" should remain rainbow gradient');
    assert.ok(saysDraw && saysDraw.color.includes('#FF3824'), 'Spoken word "says," should remain rainbow gradient');
    assert.ok(doDraw && doDraw.color.includes('#FF3824'), 'Active word "do" should render in rainbow gradient');
    assert.equal(notDraw?.color, '#FFFFFF', 'Unspoken word "not" on the same line should render in pure white');
});

test('Google Sheets scroll subtitle paste accurately recognizes each cell (HTML table, multi-line TSV, unquoted leading quotes, and merged columns)', () => {
    const sandbox = loadBrowserScript('src/reels-task-derivation.js', {
        window: { addEventListener() {} },
        localStorage: { getItem: () => null, setItem() {} },
        document: {
            addEventListener() {},
            getElementById: () => null,
            createElement: () => ({
                style: {},
                appendChild() {},
                querySelector: () => null,
                querySelectorAll: () => [],
            }),
            body: { appendChild() {} },
        },
    });
    loadBrowserScript('src/reels-batch-table.js', sandbox);

    const parseTSV = sandbox.window._parseBatchTSV;
    const normalizeRows = sandbox.window._normalizeSpreadsheetRows;
    assert.equal(typeof parseTSV, 'function', '_parseBatchTSV must be exposed');
    assert.equal(typeof normalizeRows, 'function', '_normalizeSpreadsheetRows must be exposed');

    // 1. Multi-line cells wrapped in RFC-4180 quotes by Google Sheets
    const multiLineClip = '"First cell line 1\nFirst cell line 2"\r\n"Second cell line 1\nSecond cell line 2\nSecond cell line 3"\r\nSingle line third cell';
    const parsedMulti = JSON.parse(JSON.stringify(normalizeRows(parseTSV(multiLineClip))));
    assert.equal(parsedMulti.length, 3, 'Should recognize 3 separate Google Sheets cells');
    assert.deepEqual(parsedMulti[0], ['First cell line 1\nFirst cell line 2']);
    assert.deepEqual(parsedMulti[1], ['Second cell line 1\nSecond cell line 2\nSecond cell line 3']);
    assert.deepEqual(parsedMulti[2], ['Single line third cell']);

    // 2. Single-line Google Sheets cells starting with literal double-quote (unwrapped in text/plain)
    const leadingQuoteClip = [
        '"Fear not," says the Lord to you today.',
        '"Lord Jesus, I pray for my family',
        'Amen and amen.',
    ].join('\r\n');
    const parsedQuotes = JSON.parse(JSON.stringify(normalizeRows(parseTSV(leadingQuoteClip))));
    assert.equal(parsedQuotes.length, 3, 'Cells starting with literal quote must not merge subsequent rows or split mid-sentence');
    assert.deepEqual(parsedQuotes[0], ['"Fear not," says the Lord to you today.']);
    assert.deepEqual(parsedQuotes[1], ['"Lord Jesus, I pray for my family']);
    assert.deepEqual(parsedQuotes[2], ['Amen and amen.']);

    // 3. Merged columns in Google Sheets (trailing or leading empty tab columns)
    const mergedColsClip = '"Scroll script 1\nLine 2"\t\t\r\n"Scroll script 2\nLine 2"\t\t';
    const parsedMerged = JSON.parse(JSON.stringify(normalizeRows(parseTSV(mergedColsClip))));
    assert.equal(parsedMerged.length, 2);
    assert.equal(parsedMerged[0].length, 1, 'Trailing empty columns from merged cells must be stripped so row is treated as single-column body');
    assert.equal(parsedMerged[0][0], 'Scroll script 1\nLine 2');
    assert.equal(parsedMerged[1][0], 'Scroll script 2\nLine 2');

    const leadingEmptyColClip = '\tCell A\r\n\tCell B';
    const parsedLeadingEmpty = JSON.parse(JSON.stringify(normalizeRows(parseTSV(leadingEmptyColClip))));
    assert.deepEqual(parsedLeadingEmpty, [['Cell A'], ['Cell B']], 'Leading empty column across all rows must be stripped');
});

test('Phone CTA is extracted to Decor Panel (#rdp-phone-cta-card) and supports custom Phone Image upload, positioning, scaling, and animations', () => {
    const overlayPanelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    assert.ok(overlayPanelSrc.includes('id="rdp-phone-cta-card"'), 'ReelsDecorPanel must include dedicated #rdp-phone-cta-card section');
    assert.ok(overlayPanelSrc.includes('id="rdp-cta-upload-btn"'), 'ReelsDecorPanel must include #rdp-cta-upload-btn for uploading custom phone images');
    assert.ok(overlayPanelSrc.includes('id="rdp-cta-mode-image"') && overlayPanelSrc.includes('id="rdp-cta-mode-text"'), 'ReelsDecorPanel must include image and text mode switcher buttons');

    const sandbox = loadBrowserScript('src/reels-anim-engine.js', {
        navigator: { userAgent: 'win32' },
    });
    sandbox.ReelsAnimEngine = sandbox.window.ReelsAnimEngine;
    loadBrowserScript('src/reels-overlay.js', sandbox);
    const ReelsOverlay = sandbox.window.ReelsOverlay;

    const ctaImgOv = ReelsOverlay.createPhoneCtaOverlay({
        cta_mode: 'image',
        cta_image_src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        cta_image_name: 'custom-phone-banner.png',
        cta_image_scale: 110,
        x: 100,
        y: 1360,
        w: 880,
        h: 220,
        start: 30,
        end: 9999,
        anim_in_type: 'ring_shake',
        cta_loop_anim: 'pulse',
    });

    assert.equal(ctaImgOv.is_phone_cta, true);
    assert.equal(ctaImgOv.cta_mode, 'image');
    assert.equal(ctaImgOv.cta_image_name, 'custom-phone-banner.png');
    assert.equal(ctaImgOv.cta_image_scale, 110);

    // Simulate preloaded export/preview image (880x220 aspect = 4:1)
    ctaImgOv._exporting = true;
    ctaImgOv._exportImage = { naturalWidth: 880, naturalHeight: 220, width: 880, height: 220 };

    const drawnImages = [];
    const ctx = sandbox.document.createElement('canvas').getContext('2d');
    ctx.drawImage = (img, dx, dy, dw, dh) => {
        drawnImages.push({ img, dx, dy, dw, dh });
    };

    // Before 30s -> should not draw during export
    ReelsOverlay.drawOverlay(ctx, ctaImgOv, 15.0, 1080, 1920);
    assert.equal(drawnImages.length, 0, 'Phone CTA image should not render before start time (30s) during export');

    // At 31s -> should draw custom phone image with 110% scale and populate _renderedX/_renderedY/_renderedW/_renderedH
    ReelsOverlay.drawOverlay(ctx, ctaImgOv, 31.0, 1080, 1920);
    assert.equal(drawnImages.length, 1, 'Phone CTA image should render after start time (30s)');
    assert.ok(Math.abs(drawnImages[0].dw - 880 * 1.1) < 0.5, 'Rendered image width should reflect w * cta_image_scale (880 * 110% = 968)');
    assert.ok(Math.abs(drawnImages[0].dh - 220 * 1.1) < 0.5, 'Rendered image height should preserve aspect ratio (220 * 110% = 242)');
    assert.ok(Number.isFinite(ctaImgOv._renderedX) && Number.isFinite(ctaImgOv._renderedY), '_renderedX and _renderedY must be populated for canvas drag/resize');
    assert.ok(Math.abs(ctaImgOv._renderedW - 968) < 0.5 && Math.abs(ctaImgOv._renderedH - 242) < 0.5, '_renderedW and _renderedH must match drawn image bounds');

    // Verify Windows file path with primeImageCache AND paused editor at exact start time (e.g. currentTime === 5.0 === start)
    const winPath = 'C:\\Users\\User\\Downloads\\ChatGPT Image 2026年.png';
    let passedToElectronToFileUrl = null;
    sandbox.window.electronAPI = {
        toFileUrl(p) {
            passedToElectronToFileUrl = p;
            return 'local-media:///C:/Users/User/Downloads/ChatGPT%20Image%202026%E5%B9%B4.png';
        },
    };
    const fakeImg = { naturalWidth: 920, naturalHeight: 230, width: 920, height: 230 };
    ReelsOverlay.primeImageCache(winPath, fakeImg);
    assert.equal(passedToElectronToFileUrl, winPath, 'toFileUrl must receive raw Windows path without prepended leading slash');

    const ctaWinOv = ReelsOverlay.createPhoneCtaOverlay({
        cta_mode: 'image',
        cta_image_src: winPath,
        cta_image_scale: 80,
        w: 920,
        h: 230,
        start: 5,
        end: 9999,
        anim_in_type: 'ring_shake',
        anim_in_duration: 0.55,
    });
    ctaWinOv._selected = true;
    drawnImages.length = 0;
    let drawnAlphaAtExactStart = 0;
    ctx.drawImage = (img, dx, dy, dw, dh) => {
        drawnAlphaAtExactStart = ctx.globalAlpha;
        drawnImages.push({ img, dx, dy, dw, dh });
    };
    // Paused at exact start time (currentTime === 5.0, start === 5.0)
    ReelsOverlay.drawOverlay(ctx, ctaWinOv, 5.0, 1080, 1920);
    assert.equal(drawnImages.length, 1, 'Phone CTA image must render when paused at exact start time (5.0s)');
    assert.ok(drawnAlphaAtExactStart > 0.95, `Phone CTA image must render at full opacity when paused at start time, got alpha=${drawnAlphaAtExactStart}`);
});

test('Cloudflare Hub service parses Google Drive share links, relinks local media paths, and provides Worker template', () => {
    const cloudHub = require('../electron/services/cloud-hub');

    // 1. Google Drive URL extraction & direct download conversion
    const shareUrl1 = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/view?usp=sharing';
    const shareUrl2 = 'https://drive.google.com/open?id=1ZyXwVuTsRqPoNmLkJiHgFeDcBa654321';
    assert.equal(cloudHub.extractGoogleDriveFileId(shareUrl1), '1AbCdEfGhIjKlMnOpQrStUvWxYz123456');
    assert.equal(cloudHub.extractGoogleDriveFileId(shareUrl2), '1ZyXwVuTsRqPoNmLkJiHgFeDcBa654321');
    assert.equal(
        cloudHub.resolveCloudDownloadUrl(shareUrl1),
        'https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrStUvWxYz123456&confirm=t'
    );

    // 2. Relink media paths against a temporary local material root directory
    const os = require('node:os');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cloudhub-test-'));
    try {
        const subFolder = path.join(tmpRoot, '2026-11-06_素材');
        fs.mkdirSync(subFolder, { recursive: true });
        const localBg = path.join(subFolder, 'morning_prayer_bg.mp4');
        const localAudio = path.join(subFolder, 'voice_01.mp3');
        const localSrt = path.join(subFolder, 'voice_01.srt');
        const localCta = path.join(subFolder, 'whatsapp_cta.png');
        fs.writeFileSync(localBg, 'fake-mp4');
        fs.writeFileSync(localAudio, 'fake-mp3');
        fs.writeFileSync(localSrt, '1\n00:00:00,000 --> 00:00:02,000\nAmen\n');
        fs.writeFileSync(localCta, 'fake-png');

        const mockProject = {
            version: '2.0',
            tabs: [
                {
                    id: 'tab_1',
                    name: '11月6日工程',
                    tasks: [
                        {
                            id: 't1',
                            bgPath: 'D:\\OtherUser\\Desktop\\morning_prayer_bg.mp4',
                            audioPath: '/Users/macuser/Downloads/voice_01.mp3',
                            srtPath: 'C:\\MissingFolder\\voice_01.srt',
                            overlays: [
                                {
                                    type: 'textcard',
                                    is_phone_cta: true,
                                    cta_image_src: 'E:\\OldPath\\whatsapp_cta.png',
                                },
                            ],
                        },
                    ],
                },
            ],
        };

        const stats = cloudHub.relinkProjectMediaPaths(mockProject, tmpRoot);
        assert.equal(stats.fixed, 4, 'Should relink bgPath, audioPath, srtPath, and overlay cta_image_src');
        assert.equal(stats.missing, 0, 'No media paths should remain missing');
        const task0 = mockProject.tabs[0].tasks[0];
        assert.equal(task0.bgPath, localBg);
        assert.equal(task0.audioPath, localAudio);
        assert.equal(task0.srtPath, localSrt);
        assert.equal(task0.overlays[0].cta_image_src, localCta);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    // 3. Worker template code & UI dialog presence
    const workerCode = cloudHub.getWorkerTemplateCode();
    assert.ok(workerCode.includes('Cloudflare Worker 单文件完整版'), 'Worker template code should be readable');
    const batchTableSrc = fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8');
    assert.ok(batchTableSrc.includes('window.openCloudHubDialog = async function'), 'openCloudHubDialog must be defined in reels-batch-table.js');
    assert.ok(batchTableSrc.includes('settings/cloud-hub/download-project'), 'Cloud Hub dialog must wire up Google Drive project download');
});

test('Scroll feather slider+manual negative input UI and Batch Table in-place scroll content update without duplicate overlays', () => {
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    // 1. All 8 scroll feather controls must use .rop-slider-combo (range slider + .rop-num-readout manual input) and allow negative values
    for (const fid of [
        'rop-scroll-feather-top',
        'rop-scroll-feather-top-offset',
        'rop-scroll-feather-bottom',
        'rop-scroll-feather-bottom-offset',
        'rop-scroll-feather-left',
        'rop-scroll-feather-left-offset',
        'rop-scroll-feather-right',
        'rop-scroll-feather-right-offset',
    ]) {
        assert.ok(
            panelSrc.includes(`type="range" id="${fid}"`) && panelSrc.includes(`class="rop-num-readout" data-link="${fid}"`),
            `Scroll feather control ${fid} must provide both a range slider and a manual number input box (.rop-num-readout)`
        );
    }
    assert.ok(panelSrc.includes('id="rop-scroll-feather-mode"'), 'Scroll feather panel must include #rop-scroll-feather-mode selector');
    assert.ok(panelSrc.includes('rop-scroll-feather-preset'), 'Scroll feather panel must include .rop-scroll-feather-preset quick buttons');

    // 2. Verify classic clip feather default, preset card size preservation, and negative feather/offset support in ReelsOverlay
    const ovSandbox = loadBrowserScript('src/reels-overlay.js', {});
    const ReelsOverlay = ovSandbox.window.ReelsOverlay;
    const defaultScrollOv = ReelsOverlay.createScrollOverlay();
    assert.equal(defaultScrollOv.feather_mode, 'clip', 'Scroll overlays must default to classic early clip-box feathering ("clip")');
    const legacyPresetOv = ReelsOverlay.createScrollOverlay({
        x: 90,
        y: 320,
        w: 900,
        h: 980,
        bg_enabled: true,
        bg_padding_top: 55,
        bg_padding_bottom: 55,
        bg_padding_left: 16,
        bg_padding_right: 16,
        feather_top: 120,
        feather_bottom: 160,
        feather_bottom_offset: 140,
        content: 'Legacy preset line 1\nLegacy preset line 2\nLegacy preset line 3',
    });
    delete legacyPresetOv.feather_mode;
    const mockCtx = Object.assign(ovSandbox.document.createElement('canvas').getContext('2d'), { drawImage() {} });
    ReelsOverlay.drawOverlay(mockCtx, legacyPresetOv, 1.0, 1080, 1920);
    assert.equal(legacyPresetOv._renderedY, 320 - 55, 'Imported preset card Y must preserve bg_padding_top without feather trimming');
    assert.equal(legacyPresetOv._renderedH, 980 + 55 + 55, 'Imported preset card height must preserve h + bg_padding_top + bg_padding_bottom without feather trimming');
    const axisNeg = ReelsOverlay._computeScrollFeatherAxis(600, -50, -80, 100, -40);
    assert.equal(axisNeg.sFeather, 80, 'Negative feather (-80) must preserve 80px feather width');
    assert.equal(axisNeg.expandStart, 130, 'Negative offset (-50) + negative feather (-80) must compute 130px outward expansion');
    assert.equal(axisNeg.expandEnd, 40, 'Negative end offset (-40) must compute 40px outward expansion');

    // 3. Verify Batch Table updates existing locked/styled scroll overlay in-place and auto-heals accidental duplicate default scroll overlays
    const btSandbox = loadBrowserScript('src/reels-task-derivation.js', {
        window: { addEventListener() {}, ReelsOverlay },
        localStorage: { getItem: () => null, setItem() {} },
        document: {
            addEventListener() {},
            getElementById: () => null,
            createElement: () => ({ style: {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] }),
            body: { appendChild() {} },
        },
    });
    loadBrowserScript('src/reels-batch-table.js', btSandbox);

    const taskWithPollutedDup = {
        id: 'task_341',
        overlays: [
            {
                id: 'ov_styled_vet',
                type: 'scroll',
                fixed_text: true, // accidentally locked by old decor/panel sync
                font_family: 'Playfair Display',
                fontsize: 52,
                color: '#FFFDF9',
                scroll_body_bg_enabled: true,
                scroll_body_bg_style: 'vet_stars_stripes_ribbon',
                content: 'Old Veterans Day script',
                scroll_styled_ranges: [{ start: 0, end: 8, style: { color: '#FBBF24' } }],
            },
            {
                id: 'ov_accidental_default',
                type: 'scroll',
                fixed_text: false,
                font_family: 'Arial',
                fontsize: 40,
                color: '#ffffff',
                content: 'Veterans Day is right around the corner!',
            },
        ],
    };

    btSandbox.window._applyOverlayFieldWithTarget(
        taskWithPollutedDup,
        'scroll_body',
        'Behind our freedom is their sacrifice. Our hearts are full of gratitude.',
        'ov_styled_vet',
        0,
        'scroll'
    );

    const remainingScrolls = taskWithPollutedDup.overlays.filter(o => o.type === 'scroll');
    assert.equal(remainingScrolls.length, 1, 'Accidental duplicate default scroll overlay must be removed and no new scroll overlay added');
    assert.equal(remainingScrolls[0].id, 'ov_styled_vet', 'Styled scroll overlay must be preserved');
    assert.equal(remainingScrolls[0].fixed_text, false, 'Scroll overlay must be unlocked (fixed_text = false)');
    assert.equal(remainingScrolls[0].scroll_body_bg_style, 'vet_stars_stripes_ribbon', 'Styled ribbon backing must remain intact');
    assert.equal(
        remainingScrolls[0].content,
        'Behind our freedom is their sacrifice. Our hearts are full of gratitude.',
        'Edited scroll_body from Batch Table must update the styled scroll overlay in-place'
    );
    assert.equal(remainingScrolls[0].scroll_styled_ranges, null, 'Stale styled ranges must be cleared when scroll content changes');
});

test('Facebook Reel 1147901021035006 prayer bookmark card + peace dove rose + line-by-line gold highlight & underline preset and controls', () => {
    const sandbox = loadBrowserScript('src/reels-overlay.js', {
        window: { addEventListener() {} },
    });
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    const ReelsOverlay = sandbox.window.ReelsOverlay;
    const resolveBuiltinPreset = sandbox.window.resolveBuiltinPreset;

    // 1. Verify presets sc-39, sc-40, sc-41 and ov-15 resolve properly
    const sc39 = resolveBuiltinPreset('sc-39');
    assert.ok(sc39 && sc39.kind === 'scroll_style' && sc39.style, 'sc-39 preset must resolve');
    assert.equal(sc39.style.bg_style, 'prayer_bookmark_green');
    assert.equal(sc39.style.bg_edge_feather, 38);
    assert.equal(sc39.style.bg_bookmark_enabled, true);
    assert.equal(sc39.style.bg_top_mascot, 'peace_dove_rose');
    assert.equal(sc39.style.scroll_tw_reveal_type, 'line');
    assert.equal(sc39.style.scroll_tw_underline_enabled, true);
    assert.equal(sc39.style.scroll_focus_flow_enabled, true);

    const sc40 = resolveBuiltinPreset('sc-40');
    assert.ok(sc40 && sc40.kind === 'scroll_style' && sc40.style.bg_style === 'prayer_bookmark_brown', 'sc-40 preset must resolve');
    const sc41 = resolveBuiltinPreset('sc-41');
    assert.ok(sc41 && sc41.kind === 'scroll_style' && sc41.style.bg_style === 'prayer_bookmark_navy', 'sc-41 preset must resolve');

    const ov15 = resolveBuiltinPreset('ov-15');
    assert.ok(ov15 && ov15.kind === 'overlay' && Array.isArray(ov15.overlays), 'ov-15 overlay group preset must resolve');
    const scrollInOv15 = ov15.overlays.find(o => o.type === 'scroll');
    assert.ok(scrollInOv15, 'ov-15 must contain a scroll overlay');
    assert.equal(scrollInOv15.bg_top_mascot, 'peace_dove_rose');
    assert.equal(scrollInOv15.scroll_tw_reveal_type, 'line');
    assert.equal(scrollInOv15.scroll_tw_underline_enabled, true);

    // 2. Verify Canvas rendering of _drawScrollOverlay with sc-39 style
    const fillCalls = [];
    const strokeCalls = [];
    const mockCtx = {
        canvas: { width: 1080, height: 1920 },
        font: '700 44px "Playfair Display"',
        fillStyle: '#FFFFFF',
        strokeStyle: '#000000',
        lineWidth: 1,
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        save() {},
        restore() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        bezierCurveTo() {},
        arc() {},
        ellipse() {},
        rect() {},
        clip() {},
        translate() {},
        rotate() {},
        scale() {},
        setLineDash() {},
        fill() { fillCalls.push(this.fillStyle); },
        stroke() { strokeCalls.push({ style: this.strokeStyle, width: this.lineWidth }); },
        fillRect() { fillCalls.push(this.fillStyle); },
        strokeRect() {},
        clearRect() {},
        drawImage() {},
        fillText(text, x, y) { fillCalls.push({ text, x, y, fillStyle: this.fillStyle }); },
        strokeText() {},
        measureText(text) { return { width: String(text || '').length * 22 }; },
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
    };

    const ov = ReelsOverlay.createScrollOverlay({
        ...sc39.style,
        content: 'Before you scroll away\nlet me pray for you\nHeavenly Father\nGive this person peace\nAmen',
        start: 0,
        end: 10,
        feather_top: 0,
        feather_bottom: 0,
    });
    ReelsOverlay.drawOverlay(mockCtx, ov, 3.5, 1080, 1920);

    const textFills = fillCalls.filter(c => c && typeof c === 'object' && typeof c.text === 'string');
    assert.ok(textFills.length >= 5, 'Should render multiple prayer lines');
    assert.ok(
        textFills.some(t => String(t.fillStyle).toUpperCase() === '#E2CC85'),
        'Active focus-zone line must be highlighted in gold (#E2CC85)'
    );
    assert.ok(
        strokeCalls.some(s => String(s.style).toUpperCase() === '#D9C27E'),
        'Following horizontal gold underline (#D9C27E) must be stroked beneath the active line'
    );

    // 3. Verify UI controls in src/reels-overlay-panel.js
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    for (const id of [
        'rop-scroll-tw-line-track-mode',
        'rop-scroll-tw-underline-enabled',
        'rop-scroll-tw-underline-color',
        'rop-scroll-tw-underline-style',
        'rop-scroll-tw-underline-width-mode',
        'rop-scroll-tw-underline-width-ratio',
        'rop-scroll-tw-underline-thickness',
        'rop-scroll-tw-underline-offset-y',
        'rop-scroll-tw-underline-opacity',
        'rop-scroll-focus-flow-enabled',
        'rop-scroll-focus-start-pct',
        'rop-scroll-focus-end-pct',
        'rop-scroll-bg-edge-feather',
        'rop-scroll-bg-bookmark-enabled',
        'rop-scroll-bg-bookmark-style',
        'rop-scroll-bg-bookmark-pos',
        'rop-scroll-bg-bookmark-color',
        'rop-scroll-bg-bookmark-width',
        'rop-scroll-bg-bookmark-height',
        'rop-scroll-bg-bookmark-inset',
        'rop-scroll-bg-top-mascot',
        'rop-scroll-bg-top-mascot-scale',
        'rop-scroll-bg-top-mascot-offset-x',
        'rop-scroll-bg-top-mascot-offset-y',
        'rop-scroll-bg-top-mascot-speed',
    ]) {
        assert.ok(panelSrc.includes(`id="${id}"`), `UI control #${id} must exist in src/reels-overlay-panel.js`);
    }
});

test('Designer card backgrounds + 12 top-left corner badges, standard T-subtitle US flag/medal emerging cursor icons, and numbered T-subtitle presets', () => {
    const sandbox = loadBrowserScript('src/reels-anim-engine.js', {
        window: { addEventListener() {} },
    });
    sandbox.ReelsAnimEngine = sandbox.window.ReelsAnimEngine;
    loadBrowserScript('src/reels-overlay.js', sandbox);
    sandbox.ReelsOverlay = sandbox.window.ReelsOverlay;
    sandbox.ReelsBrushEngine = sandbox.window.ReelsBrushEngine;
    loadBrowserScript('src/reels-style-engine.js', sandbox);
    sandbox.ReelsStyleEngine = sandbox.window.ReelsStyleEngine;
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);
    loadBrowserScript('src/reels-presets-init.js', sandbox);

    const ReelsOverlay = sandbox.window.ReelsOverlay;
    const ReelsBrushEngine = sandbox.window.ReelsBrushEngine;
    const ReelsCanvasRenderer = sandbox.window.ReelsCanvasRenderer;
    const resolveBuiltinPreset = sandbox.window.resolveBuiltinPreset;
    const getSubtitlePresetCode = sandbox.window.getSubtitlePresetCode;
    const formatSubtitlePresetDisplayName = sandbox.window.formatSubtitlePresetDisplayName;

    // 1. Verify 6 new designer card background styles & scroll presets sc-42 ~ sc-47
    for (const [scId, bgStyle, bmStyle] of [
        ['sc-42', 'prayer_bookmark_burgundy', 'rose_emblem'],
        ['sc-43', 'veteran_shield_card', 'us_star_shield'],
        ['sc-44', 'vintage_wax_parchment', 'gold_wax_seal'],
        ['sc-45', 'royal_olive_emerald', 'olive_wreath_tag'],
        ['sc-46', 'editorial_quote_obsidian', 'quote_mark_badge'],
        ['sc-47', 'sacred_ivory_crown', 'royal_crown_tag'],
    ]) {
        assert.ok(ReelsBrushEngine.CARD_BACKGROUND_STYLES[bgStyle], `CARD_BACKGROUND_STYLES must include ${bgStyle}`);
        const resolved = resolveBuiltinPreset(scId);
        assert.ok(resolved && resolved.kind === 'scroll_style', `${scId} must resolve as scroll_style preset`);
        assert.equal(resolved.style.bg_style, bgStyle);
        assert.equal(resolved.style.bg_bookmark_style, bmStyle);
    }

    // Render all 12 corner badge styles via drawOverlay without error
    const mockCtx = {
        canvas: { width: 1080, height: 1920 },
        font: '700 44px Georgia',
        fillStyle: '#FFFFFF',
        strokeStyle: '#000000',
        lineWidth: 1,
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        save() {},
        restore() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        bezierCurveTo() {},
        arc() {},
        ellipse() {},
        rect() {},
        clip() {},
        translate() {},
        rotate() {},
        scale() {},
        setLineDash() {},
        fill() {},
        stroke() {},
        fillRect() {},
        strokeRect() {},
        clearRect() {},
        drawImage() {},
        fillText() {},
        strokeText() {},
        measureText(t) { return { width: String(t || '').length * 20 }; },
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
    };

    for (const badgeStyle of [
        'swallowtail', 'cross_tag', 'rounded_tab',
        'us_star_shield', 'gold_wax_seal', 'rose_emblem',
        'olive_wreath_tag', 'folded_dog_ear', 'royal_crown_tag',
        'heart_prayer_tag', 'poppy_honor_tag', 'quote_mark_badge',
    ]) {
        const ov = ReelsOverlay.createScrollOverlay({
            content: 'Honor and Gratitude\nThank you Veterans',
            bg_enabled: true,
            bg_style: 'veteran_shield_card',
            bg_bookmark_enabled: true,
            bg_bookmark_style: badgeStyle,
            start: 0,
            end: 8,
        });
        ReelsOverlay.drawOverlay(mockCtx, ov, 2.0, 1080, 1920);
    }

    // 2. Verify standard T-subtitle emerging word cursor icon (subtitle_cursor_enabled + us_flag_shield) & sub-72 ~ sub-75
    for (const subId of ['sub-68', 'sub-69', 'sub-70', 'sub-71', 'sub-72', 'sub-73', 'sub-74', 'sub-75']) {
        const p = resolveBuiltinPreset(subId);
        assert.ok(p && p.kind === 'subtitle' && p.preset, `${subId} must resolve as a built-in subtitle preset`);
        assert.equal(p.preset.subtitle_cursor_enabled, true, `${subId} must enable subtitle_cursor_enabled`);
    }

    let tipRotateCalled = false;
    const subCtx = {
        ...mockCtx,
        rotate(rad) { if (typeof rad === 'number') tipRotateCalled = true; },
    };
    const subCanvas = { width: 1080, height: 1920, getContext: () => subCtx };
    const renderer = new ReelsCanvasRenderer(subCanvas);
    const sub72 = resolveBuiltinPreset('sub-72').preset;
    renderer.renderSubtitle(
        sub72,
        {
            start: 0,
            end: 3,
            text: 'Honor our veterans today',
            words: [
                { word: 'Honor', start: 0, end: 0.7 },
                { word: 'our', start: 0.7, end: 1.4 },
                { word: 'veterans', start: 1.4, end: 2.2 },
                { word: 'today', start: 2.2, end: 3.0 },
            ],
        },
        1.6,
        1080,
        1920
    );
    assert.ok(tipRotateCalled, 'Standard T-subtitle renderSubtitle must draw the US flag shield writing tip icon when subtitle_cursor_enabled is true');

    // 3. Verify T-subtitle preset numbering helpers (getSubtitlePresetCode & formatSubtitlePresetDisplayName)
    assert.equal(getSubtitlePresetCode('默认白字'), 'sub-01');
    assert.equal(getSubtitlePresetCode('🇺🇸 星条旗荣耀绶带_星盾出字 (退伍军人节)'), 'sub-68');
    assert.equal(getSubtitlePresetCode('🇺🇸 星条旗金盾跟读出字_T字幕双行款'), 'sub-72');
    assert.equal(getSubtitlePresetCode('焦糖橙_黄高亮'), 'se-01');
    assert.equal(
        formatSubtitlePresetDisplayName('🇺🇸 星条旗金盾跟读出字_T字幕双行款'),
        '[sub-72] 🇺🇸 星条旗金盾跟读出字_T字幕双行款'
    );
});

test('Playback 10s stop & render stutter fixes: feather canvas pooling, scroll auto-end preservation, circular loop sync, and xfade duration probing', () => {
    let createdCanvasCount = 0;
    const mockGrad = { addColorStop() {} };
    const makeCtx = () => ({
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        font: '40px sans-serif',
        save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
        quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, arcTo() {}, ellipse() {},
        rect() {}, clip() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {},
        clearRect() {}, drawImage() {}, translate() {}, rotate() {}, scale() {},
        setTransform() {}, setLineDash() {}, fillText() {}, strokeText() {},
        measureText(str) { return { width: String(str || '').length * 18, actualBoundingBoxAscent: 30, actualBoundingBoxDescent: 8 }; },
        createLinearGradient() { return mockGrad; },
        createRadialGradient() { return mockGrad; },
    });

    const sandbox = loadBrowserScript('src/reels-anim-engine.js', {
        document: {
            head: { appendChild() {}, querySelector: () => null },
            body: { appendChild() {} },
            fonts: { check: () => true },
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: (tag) => {
                if (tag === 'canvas') createdCanvasCount++;
                return {
                    width: 1080,
                    height: 1920,
                    style: {},
                    dataset: {},
                    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
                    appendChild() {},
                    addEventListener() {},
                    setAttribute() {},
                    getContext: () => makeCtx(),
                };
            },
        },
    });
    Object.assign(sandbox, sandbox.window);
    for (const rel of [
        'src/reels-text-direction.js',
        'src/reels-rich-text.js',
        'src/reels-scroll-timing.js',
        'src/reels-timeline.js',
        'src/reels-render-plan.js',
        'src/reels-overlay.js',
    ]) {
        loadBrowserScript(rel, sandbox);
        Object.assign(sandbox, sandbox.window);
    }

    const { ReelsOverlay, ReelsScrollTiming, ReelsRenderPlan } = sandbox.window;
    const baseOv = ReelsOverlay.createScrollOverlay({
        content: 'Line one\nLine two\nLine three\nLine four',
        feather_bottom: 80,
    });
    assert.equal(baseOv.scroll_end_auto, true, 'Newly created scroll overlay with default end must have scroll_end_auto=true');

    const task = {
        audioPath: 'C:/audio/voice_45s.mp3',
        bgPath: 'C:/video/bg_10s.mp4',
        overlays: [baseOv],
        segments: [{ start: 0, end: 45, text: 'hello' }],
    };
    const mediaDurations = {
        'C:/audio/voice_45s.mp3': 45,
        'C:/video/bg_10s.mp4': 10,
    };

    // Simulate 60 frames of preview/export where each frame passes a shallow clone via renderingOverlay + spread
    createdCanvasCount = 0;
    const mainCtx = makeCtx();
    for (let f = 0; f < 60; f++) {
        const effective = ReelsScrollTiming.renderingOverlay(baseOv, task, { bodyDuration: 45, mediaDurations });
        const frameClone = { ...effective, _exporting: true };
        ReelsOverlay.drawOverlay(mainCtx, frameClone, f * 0.5, 1080, 1920);
    }
    assert.equal(createdCanvasCount, 1, 'Scroll feather offscreen canvas must be pooled and allocated only once across 60 cloned-overlay frames');
    assert.equal(baseOv.end, 10, 'Live scroll overlay end must not be mutated during frame rendering');

    // Verify getEditorTracks projects auto-end scroll overlay to full task duration (45s), not 10s
    const tracks = ReelsRenderPlan.getEditorTracks(task, { duration: 45 });
    const scrollTrack = tracks.find(t => t.type === 'overlay' && t._overlayType === 'scroll');
    assert.ok(scrollTrack && scrollTrack.clips.length === 1, 'Scroll overlay track should exist');
    assert.equal(scrollTrack.clips[0].end, 45, 'Auto-end scroll overlay clip on timeline must span full 45s task duration instead of stopping at 10s');

    // Verify syncLegacyFields does not lock timelineBackgroundTrim unless manually trimmed
    ReelsRenderPlan.syncLegacyFields(task);
    assert.equal(task.timelineBackgroundTrim, undefined, 'Auto-generated background timeline clip must not set task.timelineBackgroundTrim');

    // Verify Preview V2 sets loop attribute on background/content/bgm media and uses circular loop distance
    const previewV2Src = fs.readFileSync(path.join(ROOT, 'src/reels-preview-v2.js'), 'utf8');
    assert.match(previewV2Src, /data-role="bg-video"[^>]*\bloop\b/, 'V2 bg-video element must have loop attribute');
    assert.match(previewV2Src, /function setMediaTime\(media,\s*target,\s*loopDuration\s*=\s*0\)/, 'setMediaTime must accept loopDuration for circular wrap-around distance');
    assert.ok(!previewV2Src.includes('ov.end = measured.end'), 'Preview V2 must not overwrite ov.end with measured.end');

    // Verify ffmpeg-rawvideo probes nb_frames & uses + 0.5s tolerance for loopFade
    const rawVideoSrc = fs.readFileSync(path.join(ROOT, 'electron/services/ffmpeg-rawvideo.js'), 'utf8');
    assert.match(rawVideoSrc, /nb_frames,avg_frame_rate,r_frame_rate/, 'getMediaDuration must probe nb_frames and frame rate to prevent tpad freeze');
    assert.match(rawVideoSrc, /targetDuration\s*>\s*scaledBgDuration\s*\+\s*0\.5/, 'useDirectLoopFade must require targetDuration > scaledBgDuration + 0.5');
});

test('Scope sync (同步到作用范围) across singleton folder queues & auto-shutdown 10s countdown option', () => {
    const overlayPanelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    const batchReelsSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    const batchTableSrc = fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8');
    const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    const mainJsSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const preloadJsSrc = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');

    // 1. Verify _getStyleApplyScopeTasks & _getCurrentReelsGroupTasks expand singleton _folderQueueId to sameTab/allTasks
    assert.match(overlayPanelSrc, /if\s*\(scoped\.length\s*<=\s*1\s*&&\s*allTasks\.length\s*>\s*1\)/, '_getStyleApplyScopeTasks must expand singleton folder queue to batch tab or all tasks');
    assert.match(batchReelsSrc, /if\s*\(sameFolder\.length\s*>\s*1\s*\|\|\s*allTasks\.length\s*<=\s*1\)\s*return\s*sameFolder;/, '_getCurrentReelsGroupTasks must expand singleton folder queue to batch tab or all tasks');

    // 2. Verify _afterScopeStyleSync persists scope changes and flushes pending sync on task switch
    assert.match(overlayPanelSrc, /_afterScopeStyleSync\(scopedTasks\)/, 'Overlay Panel must define and call _afterScopeStyleSync(scopedTasks)');
    assert.match(overlayPanelSrc, /_flushPendingScopeSync\(\)/, 'Overlay Panel must flush pending scope sync on select/deselect');
    assert.match(batchReelsSrc, /_reelsState\.overlayPanel\._flushPendingScopeSync\(\)/, 'reelsSelectTask must flush pending scope sync before switching tasks');
    assert.match(batchTableSrc, /subStyleScope\s*===\s*'all'\s*\|\|\s*ovStyleScope\s*===\s*'all'/, '_syncGroupedProjectionToTabs must check both reels-style-scope and rop-style-scope for all-tabs sync');

    // 3. Verify Auto-Shutdown option is unchecked by default and implements 10s cancellable countdown
    const shutdownCheckboxMatch = indexHtmlSrc.match(/<input[^>]*id="reels-export-auto-shutdown"[^>]*>/);
    assert.ok(shutdownCheckboxMatch, 'reels-export-auto-shutdown checkbox must exist in index.html');
    assert.ok(!/\bchecked\b/i.test(shutdownCheckboxMatch[0]), 'reels-export-auto-shutdown must default to unchecked');
    assert.match(batchReelsSrc, /function\s+_reelsShowAutoShutdownModal\(/, 'batch-reels.js must define _reelsShowAutoShutdownModal');
    assert.match(batchReelsSrc, /reels-cancel-auto-shutdown-btn/, '_reelsShowAutoShutdownModal must include cancel shutdown button');
    assert.match(mainJsSrc, /handleTrusted\('system:shutdown-now'/, 'electron/main.js must register trusted system:shutdown-now handler');
    assert.match(mainJsSrc, /handleTrusted\('system:cancel-shutdown'/, 'electron/main.js must register trusted system:cancel-shutdown handler');
    assert.match(preloadJsSrc, /triggerSystemShutdown:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('system:shutdown-now'\)/, 'preload.js must expose triggerSystemShutdown');
    assert.match(preloadJsSrc, /cancelSystemShutdown:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('system:cancel-shutdown'\)/, 'preload.js must expose cancelSystemShutdown');
});

test('Zooming background & xfade loop stutter fix: exact frame timebase (settb=1/fps,setpts=N), framerate sub-frame interpolation, and tail-xfade avoidance', () => {
    const rawvideo = require(path.join(ROOT, 'electron/services/ffmpeg-rawvideo.js'));
    const rawvideoSrc = fs.readFileSync(path.join(ROOT, 'electron/services/ffmpeg-rawvideo.js'), 'utf8');

    // 1. normalizedDirectBackgroundFilter must use settb=1/30,setpts=N (no settb=AVTB) and framerate interpolation for video clips
    const videoFilter = rawvideo._test.normalizedDirectBackgroundFilter(
        0,
        'scale=1080:1920,setsar=1',
        'setpts=PTS-STARTPTS',
        30,
        'bg0',
        2,
        'C:/videos/ai_zoom_24fps.mp4'
    );
    assert.ok(videoFilter.includes('framerate=fps=30:interp_start=0:interp_end=255:scene=8.2,fps=30'), 'Video background filter must smoothly interpolate 24/25fps camera zoom/pan to target fps');
    assert.ok(videoFilter.includes('tpad=stop_mode=clone:stop_duration=2.00,settb=1/30,setpts=N[bg0]'), 'Video background filter must normalize timebase to 1/fps and PTS=N after tpad');
    assert.ok(!videoFilter.includes('settb=AVTB'), 'Video background filter must not use settb=AVTB which causes 1us rounding drift after xfade');

    // 2. computeLoopFadePlan must avoid redundant tail-end xfade on 8.0s clip -> 15.067s video
    const plan = rawvideo._test.computeLoopFadePlan(8.0, 15.067, 1.0, 30);
    assert.equal(plan.segCount, 2, '8.0s background covering 15.067s video must use 2 segments (1 xfade) instead of 3 segments (which caused a redundant zoom reset at 13.87s)');
    assert.equal(plan.fadeFrames, 26);
    assert.equal(plan.stepFrames, 212);
    assert.ok(Math.abs((plan.step + 8.0) - 15.066667) < 0.001, '2 segments must cover the full 15.067s duration');

    // 3. startSession and prepareBg must re-lock settb=1/${safeFps},setpts=N after xfade and on [fg] before overlay
    assert.ok(!rawvideoSrc.includes('settb=AVTB'), 'ffmpeg-rawvideo.js must not use settb=AVTB in xfade/overlay filtergraphs');
    assert.match(rawvideoSrc, /xfade=transition=fade:duration=\$\{fadeDur\.toFixed\(6\)\}:offset=\$\{\(i \* step\)\.toFixed\(6\)\},settb=1\/\$\{safeFps\},setpts=N/, 'startSession xfade must re-lock settb=1/fps,setpts=N');
    assert.match(rawvideoSrc, /settb=1\/\$\{safeFps\},setpts=N\[fg\];\[bg\]\[fg\]overlay=0:0/, 'Foreground rawvideo stream must lock settb=1/fps,setpts=N before overlay');
});

test('BatchCut & AutoEdit clip cutting/concatenation fix: default precise mode, A/V PTS sync, and xfade video duration lock', () => {
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
    const ffmpegSrc = fs.readFileSync(path.join(ROOT, 'electron/services/ffmpeg.js'), 'utf8');
    const autoEditSrc = fs.readFileSync(path.join(ROOT, 'electron/services/autoEdit.js'), 'utf8');

    // 1. BatchCut UI defaults to precise mode checked and 0s padding
    assert.match(htmlSrc, /id="batchcut-precise-mode"\s+checked/, 'batchcut-precise-mode must be checked by default to prevent non-keyframe jump cuts and lip-sync drift');
    assert.ok(appSrc.includes("document.getElementById('batchcut-precise-mode')?.checked ?? true"), 'startBatchCut must default precise to true');

    // 2. batchCut & concatClips & concatClipsWithTransitions align A/V timestamps and probe actual video stream duration
    assert.ok(ffmpegSrc.includes('async function _getEffectiveClipDuration(filePath)'), 'ffmpeg.js must probe effective video+container duration via _getEffectiveClipDuration');
    assert.ok(ffmpegSrc.includes('aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS'), 'ffmpeg.js must align audio start PTS with video');
    assert.ok(ffmpegSrc.includes('检测到直拼视频轨时长'), 'concatClips must verify output video stream duration against container duration and auto-recover if video ended early');
    assert.ok(ffmpegSrc.includes('timelineDur - tDur - frameStep * 0.5'), 'concatClipsWithTransitions must keep safety margin before EOF on xfade offset so video never freezes into a static frame');

    // 3. autoEdit.js aligns audio PTS, guards against sub-frame micro-cuts, and invalidates old cut cache via version: 4
    assert.ok(autoEditSrc.includes('aresample=async=1:first_pts=0,${audioRemoveFilter}asetpts=PTS-STARTPTS'), 'autoEdit.js must use aresample=async=1:first_pts=0 when cutting segments');
    assert.ok(autoEditSrc.includes('plan.end - plan.start < 0.35'), 'autoEdit.js must guard against sub-0.35s micro-cut segments');
    assert.match(autoEditSrc, /const cacheKeyPayload = \{\s*version: 4,/, 'autoEdit.js must bump cacheKeyPayload version to 4 so pre-4.5.8 cut caches are re-cut with timescale 90000 and PTS sync');

    // 4. AutoEdit batch task script synchronization & recovery from skipped/sendToReels=false state
    assert.ok(appSrc.includes('function syncAutoEditBatchPendingScriptInputs()'), 'app.js must define syncAutoEditBatchPendingScriptInputs to flush pending script inputs before analysis/smart-pairing');
    assert.ok(appSrc.includes('oninput="updateAutoEditBatchScriptLive(${i},this.value)"'), 'Task card script textarea must sync live on input so background thumbnail renders do not lose typed scripts');
    assert.ok(appSrc.includes('const tasksWithScript = activeTasks.filter(t => t.script?.trim());'), 'startAutoEditBatchAnalysis must recover tasks that have scripts even if sendToReels was previously set to false');
});

test('Batch Reels multi-clip & auto-concat 30s truncation fix: tasks 2..N preserve full 2m+ duration instead of truncating to first 30s clip', () => {
    const ReelsRenderPlan = require(path.join(ROOT, 'src/reels-render-plan.js'));
    const batchReelsSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    const batchTableSrc = fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8');
    const wysiwygSrc = fs.readFileSync(path.join(ROOT, 'src/reels-wysiwyg-export.js'), 'utf8');
    const layeredSrc = fs.readFileSync(path.join(ROOT, 'src/reels-layered-export.js'), 'utf8');
    const rawvideoSrc = fs.readFileSync(path.join(ROOT, 'electron/services/ffmpeg-rawvideo.js'), 'utf8');
    const ffmpegSrc = fs.readFileSync(path.join(ROOT, 'electron/services/ffmpeg.js'), 'utf8');
    const autoEditSrc = fs.readFileSync(path.join(ROOT, 'electron/services/autoEdit.js'), 'utf8');

    // 1. Unselected multi-clip tasks (Tasks 2, 3, 4, 5) must NOT have bgPath overwritten with bgClipPool[0] (30s) by syncLegacyFields
    const task2 = {
        bgMode: 'multi',
        bgPath: '',
        videoPath: '',
        bgClipPool: ['C:/clips/clip1_30s.mp4', 'C:/clips/clip2_30s.mp4', 'C:/clips/clip3_30s.mp4', 'C:/clips/clip4_30s.mp4', 'C:/clips/clip5_27s.mp4'],
        segments: [{ start: 0, end: 147, text: 'Full 2m27s sermon subtitle' }],
    };
    assert.equal(ReelsRenderPlan.fillBackgroundLoops(task2, { duration: 147 }), false, 'fillBackgroundLoops must skip multi-clip tasks');
    ReelsRenderPlan.syncLegacyFields(task2, { width: 1080, height: 1920 });
    assert.equal(task2.bgPath, '', 'syncLegacyFields must not write bgClipPool[0] (30s clip) into task.bgPath on unselected multi-clip tasks');
    assert.equal(task2.videoPath, '', 'syncLegacyFields must not write bgClipPool[0] (30s clip) into task.videoPath on unselected multi-clip tasks');

    // 2. batch-reels.js must not use bgPath (pool[0]) as voiceSource when task is in multi-clip mode, and must auto-concat unconcatenated clipPool tasks before export
    assert.ok(
        batchReelsSrc.includes("const isMultiBgTask = task.bgMode === 'multi' && effectiveBgClipPool.length > 0;"),
        'reelsStartBatch must detect multi-clip background tasks before assigning voiceSource'
    );
    assert.ok(
        batchReelsSrc.includes("const voiceSource = task.audioPath || ((workMode === 'voiced_bg' && !isMultiBgTask) ? bgPath : null);"),
        'reelsStartBatch must not pass single-clip bgPath as voiceSource when isMultiBgTask is true'
    );
    assert.ok(
        batchReelsSrc.includes('await window.reelsConcatTaskClipPool(taskIdx);'),
        'reelsStartBatch must auto-concatenate any task with clipPoolDir/clipPool that was not manually concatenated before export'
    );

    // 3. reels-batch-table.js _applyPoolToTask must clear stale single-clip bgPath/videoPath when applying multi-clip pool to rows 2..N
    assert.ok(
        batchTableSrc.includes("if (task.bgMode === 'multi') {\n                targetTask.bgPath = '';") ||
        batchTableSrc.includes("if (task.bgMode === 'multi') {\r\n                targetTask.bgPath = '';"),
        '_applyPoolToTask must clear stale single-clip bgPath on target rows when applying multi-clip pool'
    );
    assert.ok(
        batchTableSrc.includes('window.reelsConcatTaskClipPool = _rbtConcatTaskClipPool;'),
        'reels-batch-table.js must expose window.reelsConcatTaskClipPool for pre-export auto-concatenation'
    );

    // 4. reels-wysiwyg-export.js & reels-layered-export.js must guard against voicePath being in bgClipPool and align single voiced_bg duration to effectiveSubDuration
    assert.ok(
        wysiwygSrc.includes('if (isMultiClip && voicePath && (voicePath === backgroundPath || bgClipPool.includes(voicePath)))'),
        'reels-wysiwyg-export.js must clear voicePath when it points to a background pool clip in multi-clip mode'
    );
    assert.ok(
        wysiwygSrc.includes('if (!isMultiClip && backgroundPath && voicePath === backgroundPath && effectiveSubDuration > duration)'),
        'reels-wysiwyg-export.js must extend duration to effectiveSubDuration when a voiced_bg clip is shorter than its subtitles'
    );
    assert.ok(
        layeredSrc.includes('if (isMultiClip && voicePath && (voicePath === backgroundPath || bgClipPool.includes(voicePath)))'),
        'reels-layered-export.js must clear voicePath when it points to a background pool clip in multi-clip mode'
    );

    // 5. ffmpeg-rawvideo.js, ffmpeg.js & autoEdit.js must prevent xfade/concat/mixAudio premature 30s termination
    assert.ok(
        rawvideoSrc.includes('tpad=stop_mode=clone:stop_duration=2,settb=1/${safeFps},setpts=N'),
        'prepareBg multi-clip xfade must pad clips with tpad=stop_mode=clone:stop_duration=2 so clip 0 never hits premature EOF at 30s'
    );
    assert.ok(
        rawvideoSrc.includes("const voicePadTail = getSessionVideoDuration(session) > 0 ? ',apad' : '';"),
        'mixAudio must pad [voice] with apad so -shortest never truncates a 2m+ rendered video to a 30s audio stream'
    );
    assert.ok(
        ffmpegSrc.includes('const expectedTotalDur = clipDurs.reduce('),
        'concatClips must verify output video duration against expectedTotalDur (sum of input clips) and fallback to normalizeAllClips if truncated'
    );
    assert.ok(
        ffmpegSrc.includes("'-video_track_timescale', '90000'") && autoEditSrc.includes("'-video_track_timescale', '90000'"),
        'concatClips and autoEdit must lock -video_track_timescale 90000 for seamless stream-copy concatenation'
    );

    // 6. AutoEdit -> Batch Reels single-video 30s loop/truncation guards across tasks 2..N
    assert.ok(
        batchReelsSrc.includes('function _domElementMatchesMediaPath(el, targetPath)') &&
        batchReelsSrc.includes('_domElementMatchesMediaPath(video, bgPath)'),
        '_getVideoDuration must verify preview <video> src matches task bgPath before reading or caching video.duration'
    );
    assert.ok(
        batchReelsSrc.includes('let _autoEditReelsCreateQueue = Promise.resolve();'),
        'reelsCreateTaskFromAutoEditResult must serialize concurrent batch auto-edit completions so tasks 2..N do not race on _reelsState'
    );
    assert.ok(
        batchReelsSrc.includes('const videoDuration = Math.max(probedDuration, subtitleDuration, reviewSegmentsDuration);'),
        'reelsCreateTaskFromAutoEditResult must protect videoDuration with subtitleDuration and reviewSegmentsDuration lower bounds'
    );
    assert.ok(
        autoEditSrc.includes('output_duration: effectiveOutputDuration,'),
        'autoEditByScript must return authoritative output_duration for Batch Reels'
    );
    assert.ok(
        wysiwygSrc.includes('voiceSameAsBg: Boolean(!isMultiClip && backgroundPath && ((voicePath && voicePath === backgroundPath) || isAutoEditTask))'),
        'reelsWysiwygExport must pass voiceSameAsBg and authoritative alphaBgDuration to startSession so 2m+ auto-edit videos are not xfade-looped at 30s'
    );
    assert.ok(
        rawvideoSrc.includes('const trustFullBgDuration = Boolean(opts.voiceSameAsBg || opts.isAutoEditTask)'),
        'ffmpeg-rawvideo startSession must trust full authoritative duration when a single voiced/auto-edit background probe is truncated'
    );
});

test('sub-76 autumn 3D gradient outline + feather_wipe (Thank You God reel style) renders soft white mist lead and 3D gradient extrusion', () => {
    const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    assert.ok(indexHtmlSrc.includes('<option value="feather_wipe">羽化擦除显字</option>'));

    const sandbox = loadBrowserScript('src/reels-style-engine.js', { window: { addEventListener() {} } });
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);

    const ReelsStyleEngine = sandbox.window.ReelsStyleEngine;
    const ReelsAnimEngine = sandbox.window.ReelsAnimEngine;
    const ReelsCanvasRenderer = sandbox.window.ReelsCanvasRenderer;

    const resolved = sandbox.window.resolveBuiltinPreset('sub-76');
    assert.ok(resolved && resolved.preset, 'sub-76 must resolve to Thank You God preset');
    assert.equal(resolved.name, '🍁 秋枫暖橙3D立体_羽化擦除 (Thank You God同款)');

    const style = ReelsStyleEngine.applySubtitlePreset('🍁 秋枫暖橙3D立体_羽化擦除 (Thank You God同款)');
    assert.equal(style.anim_in_type, 'feather_wipe');
    assert.equal(style.extrude_3d_enabled, true);
    assert.equal(style.outline_gradient_enabled, true);
    assert.equal(style.outline_gradient_direction, 'vertical');
    assert.equal(style.outline_gradient_scope, 'block');
    assert.equal(style.pos_y, 0.23);

    // Verify feather_wipe state & char reveal:
    // - Unrevealed characters ahead of wipe are 100% invisible (fillAlpha = 0, strokeAlpha = 0)
    // - Leading-edge characters have white fill leading ahead of 3D stroke/extrusion (fillAlpha > strokeAlpha)
    const wipeMid = ReelsAnimEngine.computeFeatherWipeState(0.55, 0.0, 4.0, [420, 400], { sweepDuration: 1.15, fontSize: 52 });
    assert.equal(wipeMid.active, true);
    assert.equal(wipeMid.barAlpha, 0, 'feather_wipe must not draw an underline bar');

    const revealedChar = ReelsAnimEngine.computeFeatherWipeCharReveal(20, wipeMid);
    assert.ok(revealedChar.fillAlpha > 0.95 && revealedChar.strokeAlpha > 0.9, 'Left revealed char must have full white fill and 3D outline');

    const edgeDist = wipeMid.sweptDist + wipeMid.transitionWindow * 0.2;
    const edgeChar = ReelsAnimEngine.computeFeatherWipeCharReveal(edgeDist, wipeMid);
    assert.ok(edgeChar.fillAlpha > edgeChar.strokeAlpha, 'At feather wipe front, white fill mist must lead ahead of 3D outline');

    const unrevealedChar = ReelsAnimEngine.computeFeatherWipeCharReveal(760, wipeMid);
    assert.equal(unrevealedChar.fillAlpha, 0, 'Characters ahead of wipe front must be completely invisible');
    assert.equal(unrevealedChar.strokeAlpha, 0, 'Characters ahead of wipe front must have zero stroke');

    // Render 2-line segment via ReelsCanvasRenderer and verify gradient + 3D extrusion steps + two-pass order
    const gradStops = [];
    const drawOps = [];
    const alphaStack = [];
    const ctx = {
        font: '700 52px Fredoka',
        globalAlpha: 1,
        fillStyle: '#FFFFFF',
        strokeStyle: '#000000',
        save() { alphaStack.push(this.globalAlpha); },
        restore() { if (alphaStack.length) this.globalAlpha = alphaStack.pop(); },
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        arcTo() {},
        fill() {},
        stroke() {},
        fillRect() {},
        translate() {},
        rotate() {},
        scale() {},
        createLinearGradient(x0, y0, x1, y1) {
            const g = {
                isGrad: true,
                x0, y0, x1, y1,
                stops: [],
                addColorStop(offset, color) {
                    this.stops.push({ offset, color });
                    gradStops.push({ offset, color });
                },
            };
            return g;
        },
        createRadialGradient() { return { addColorStop() {} }; },
        measureText(txt) { return { width: String(txt || '').length * 24, actualBoundingBoxAscent: 38, actualBoundingBoxDescent: 10 }; },
        fillText(txt, x, y) { drawOps.push({ op: 'fill', text: String(txt), x, y, style: this.fillStyle, alpha: Number(this.globalAlpha.toFixed(3)) }); },
        strokeText(txt, x, y) { drawOps.push({ op: 'stroke', text: String(txt), x, y, style: this.strokeStyle, alpha: Number(this.globalAlpha.toFixed(3)) }); },
    };

    const renderer = new ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: () => ctx });
    const seg = {
        start: 0.0,
        end: 4.0,
        text: 'Thank you God, for all the good\nYou keep sending my way',
    };
    renderer.renderSubtitle(style, seg, 0.6, 1080, 1920);

    assert.ok(gradStops.length >= 3, 'Vertical block gradient must be created for 3D extrusion & outline');
    const strokeIdx = drawOps.findIndex(d => d.op === 'stroke' && d.style && d.style.isGrad);
    const whiteFillIdx = drawOps.findIndex(d => d.op === 'fill' && d.style === '#FFFFFF');
    assert.ok(strokeIdx >= 0 && whiteFillIdx > strokeIdx, '3D gradient outline pass must be drawn before white character fill pass');
});

test('Anointed Woman preset (sub-77 / sc-48) renders 3-line progressive sliding window + per-line dark pill box + active word green sweep + golden feather quill', () => {
    const sandbox = loadBrowserScript('src/reels-style-engine.js', { window: { addEventListener() {} } });
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);

    const ReelsStyleEngine = sandbox.window.ReelsStyleEngine;
    const ReelsCanvasRenderer = sandbox.window.ReelsCanvasRenderer;

    const sub77 = sandbox.window.resolveBuiltinPreset('sub-77');
    assert.ok(sub77 && sub77.kind === 'subtitle', 'sub-77 must resolve as a built-in subtitle preset');
    assert.equal(sub77.name, '🪶 三行滚词_金羽绿字跟读 (Anointed Woman同款)');
    assert.equal(sub77.preset.anim_in_type, 'rolling_quill_karaoke');
    assert.equal(sub77.preset.font_family, 'Dancing Script');
    assert.equal(sub77.preset.color_text, '#FFFFFF');
    assert.equal(sub77.preset.color_high, '#18A84B');
    assert.equal(sub77.preset.use_box, true);
    assert.equal(sub77.preset.fullpage_typewriter_cursor_kind, 'feather_gold');
    assert.equal(sub77.preset.scrolling_visible_lines, 3);

    const sc48 = sandbox.window.resolveBuiltinPreset('sc-48');
    assert.ok(sc48 && sc48.kind === 'scroll_style', 'sc-48 must resolve as a built-in scroll style preset');
    assert.equal(sc48.style.scroll_tw_cursor_kind, 'feather_gold');
    assert.equal(sc48.style.scroll_tw_active_color, '#18A84B');
    assert.equal(sc48.style.scroll_tw_active_char_sweep, true);

    const style = ReelsStyleEngine.applySubtitlePreset('🪶 三行滚词_金羽绿字跟读 (Anointed Woman同款)');
    const fillOps = [];
    const clipRects = [];
    const stateStack = [];
    const ctx = {
        font: '',
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        globalAlpha: 1,
        textAlign: 'left',
        textBaseline: 'top',
        direction: 'ltr',
        save() { stateStack.push({ alpha: this.globalAlpha, fillStyle: this.fillStyle, font: this.font }); },
        restore() {
            const prev = stateStack.pop();
            if (prev) {
                this.globalAlpha = prev.alpha;
                this.fillStyle = prev.fillStyle;
                this.font = prev.font;
            }
        },
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        bezierCurveTo() {},
        arc() {},
        ellipse() {},
        arcTo() {},
        rect(x, y, w, h) { this._lastRect = { x, y, w, h }; },
        clip() { if (this._lastRect) clipRects.push({ ...this._lastRect }); },
        fill() {},
        stroke() {},
        fillRect() {},
        translate() {},
        rotate() {},
        scale() {},
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
        measureText(txt) { return { width: String(txt || '').length * 22, actualBoundingBoxAscent: 42, actualBoundingBoxDescent: 12 }; },
        fillText(txt, x, y) {
            fillOps.push({ text: String(txt), x, y, style: String(this.fillStyle), alpha: Number(this.globalAlpha.toFixed(3)) });
        },
        strokeText() {},
    };

    const renderer = new ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: () => ctx });
    const segments = [
        {
            start: 0.0,
            end: 0.9,
            text: 'You are an',
            words: [
                { word: 'You', start: 0.0, end: 0.3 },
                { word: 'are', start: 0.3, end: 0.6 },
                { word: 'an', start: 0.6, end: 0.9 },
            ],
        },
        {
            start: 1.0,
            end: 1.8,
            text: 'anointed woman.',
            words: [
                { word: 'anointed', start: 1.0, end: 1.4 },
                { word: 'woman.', start: 1.4, end: 1.8 },
            ],
        },
        {
            start: 1.9,
            end: 2.9,
            text: 'What was meant',
            words: [
                { word: 'What', start: 1.9, end: 2.2 },
                { word: 'was', start: 2.2, end: 2.5 },
                { word: 'meant', start: 2.5, end: 2.9 },
            ],
        },
        {
            start: 3.0,
            end: 4.0,
            text: 'to destroy you',
            words: [
                { word: 'to', start: 3.0, end: 3.3 },
                { word: 'destroy', start: 3.3, end: 3.7 },
                { word: 'you', start: 3.7, end: 4.0 },
            ],
        },
    ];
    renderer.setContextSegments(segments);

    // 1) At t = 0.45s (Line 1 active on "are"): only Line 1 ("You", "are", "an") is rendered, and "are" has green sweep
    fillOps.length = 0;
    clipRects.length = 0;
    renderer.renderSubtitle(style, segments[0], 0.45, 1080, 1920);
    assert.ok(fillOps.some(op => op.text === 'You' && op.style.toUpperCase() === '#FFFFFF'), 'Line 1 spoken word "You" must return to white #FFFFFF');
    assert.ok(fillOps.some(op => op.text === 'are' && op.style.toUpperCase() === '#18A84B'), 'Active word "are" must be swept with emerald green #18A84B');
    assert.ok(!fillOps.some(op => op.text === 'anointed'), 'Line 2 must not be visible yet during Line 1');
    assert.equal(clipRects.length, 1, 'Exactly one horizontal clip sweep must be applied for the active word');

    // 2) At t = 2.65s (Line 3 active on "meant"): 3 lines visible ("You", "anointed", "meant")
    fillOps.length = 0;
    renderer.renderSubtitle(style, segments[2], 2.65, 1080, 1920);
    assert.ok(fillOps.some(op => op.text === 'You'), 'Line 1 must still be visible when Line 3 is active');
    assert.ok(fillOps.some(op => op.text === 'anointed'), 'Line 2 must be visible when Line 3 is active');
    assert.ok(fillOps.some(op => op.text === 'meant' && op.style.toUpperCase() === '#18A84B'), 'Active word "meant" on Line 3 must sweep in #18A84B');

    // 3) At t = 3.55s (Line 4 active on "destroy", past step transition): Line 1 ("You") has scrolled out, 3 lines [Line 2, Line 3, Line 4] remain
    fillOps.length = 0;
    renderer.renderSubtitle(style, segments[3], 3.55, 1080, 1920);
    assert.ok(!fillOps.some(op => op.text === 'You' && op.alpha > 0.05), 'Line 1 ("You") must drop off once Line 4 has scrolled into the 3-line window');
    assert.ok(fillOps.some(op => op.text === 'anointed'), 'Line 2 must now sit at the top of the 3-line window');
    assert.ok(fillOps.some(op => op.text === 'What'), 'Line 3 must sit in the middle of the 3-line window');
    assert.ok(fillOps.some(op => op.text === 'destroy' && op.style.toUpperCase() === '#18A84B'), 'Active word "destroy" on Line 4 must sweep in #18A84B');
});





















