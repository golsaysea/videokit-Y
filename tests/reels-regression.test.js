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
                ellipse() {},
                rect() {},
                roundRect() {},
                drawImage() {},
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
    assert.ok(indexHtml.includes('data-suite-tab="google-tts"'), 'index.html should include the 谷歌配音 sidebar tab button');
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
    for (const kind of [
        'candy_cane', 'christmas_tree', 'holly_berry', 'snowflake_wand', 'santa_feather', 'jingle_bell',
        'maple_leaf', 'wheat_stalk', 'acorn', 'minimal_pumpkin', 'warm_mug', 'olive_branch',
    ]) {
        assert.equal(isTip(kind), true, `Seasonal writing tip "${kind}" must be registered in BUILTIN_WRITING_TIP_KINDS`);
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
        'thx_oat_linen_letterpress',
        'thx_terracotta_botanical',
        'thx_sage_gratitude_frame',
        'thx_spiced_amber_hearth',
        'thx_espresso_gold_minimal',
        'thx_heirloom_kraft_twine',
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
    sandbox.ReelsStyleEngine = sandbox.window.ReelsStyleEngine;
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    sandbox.ReelsAnimEngine = sandbox.window.ReelsAnimEngine;
    loadBrowserScript('src/reels-overlay.js', sandbox);
    sandbox.ReelsOverlay = sandbox.window.ReelsOverlay;
    sandbox.ReelsBrushEngine = sandbox.window.ReelsBrushEngine;
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

    // 3. autoEdit.js aligns audio PTS, guards against sub-frame micro-cuts, and invalidates old cut cache via version: 5
    assert.ok(autoEditSrc.includes('aresample=async=1:first_pts=0,${audioRemoveFilter}asetpts=PTS-STARTPTS'), 'autoEdit.js must use aresample=async=1:first_pts=0 when cutting segments');
    assert.ok(autoEditSrc.includes('plan.end - plan.start < 0.35'), 'autoEdit.js must guard against sub-0.35s micro-cut segments');
    assert.match(autoEditSrc, /const cacheKeyPayload = \{\s*version: 5,/, 'autoEdit.js must bump cacheKeyPayload version to 5 so earlier cut caches are re-cut cleanly with timescale 90000, PTS sync, and uniform BT.709 color');

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

test('20 new innovative presets (sub-78..sub-97), zero duplicate presets across categories, and adjustable kinetic_glow_stack', () => {
    const styleSandbox = loadBrowserScript('src/reels-style-engine.js');
    loadBrowserScript('src/reels-presets-init.js', styleSandbox);
    const engine = styleSandbox.window.ReelsStyleEngine;
    const resolveBuiltinPreset = styleSandbox.window.resolveBuiltinPreset;

    // 1) Verify zero duplicate preset names across PRESET_CATEGORIES and getPresetsByCategory()
    const { categorized, presetsMap } = engine.getPresetsByCategory();
    const seenAcrossCategories = new Map();
    for (const group of categorized) {
        for (const name of group.names) {
            assert.ok(
                !seenAcrossCategories.has(name),
                `Preset "${name}" must not appear in multiple categories (found in both "${seenAcrossCategories.get(name)}" and "${group.category}")`
            );
            seenAcrossCategories.set(name, group.category);
        }
    }

    // 2) Verify all 50 new presets sub-78 through sub-127 exist, resolve, have unique fingerprints, and are categorized
    const seenFingerprints = new Map();
    for (let i = 78; i <= 127; i++) {
        const code = `sub-${i}`;
        const resolved = resolveBuiltinPreset(code);
        assert.ok(resolved && resolved.kind === 'subtitle', `${code} must resolve as a builtin subtitle preset`);
        assert.ok(presetsMap[resolved.name], `${code} (${resolved.name}) must exist in presetsMap`);
        assert.ok(seenAcrossCategories.has(resolved.name), `${code} (${resolved.name}) must belong to exactly one category`);
        const fp = engine.subtitleStyleFingerprint(presetsMap[resolved.name]);
        assert.ok(!seenFingerprints.has(fp), `${code} (${resolved.name}) must have a distinct style fingerprint from ${seenFingerprints.get(fp)}`);
        seenFingerprints.set(fp, code);
    }

    // 3) Verify kinetic_glow_stack ([sub-38] 参考_黄绿辉光逐词叠排) responds to custom glow radius, color_high, stroke, and box
    const fillOps = [];
    const strokeOps = [];
    const roundRectCalls = [];
    const ctx = {
        canvas: { width: 1080, height: 1920 },
        font: '',
        direction: 'ltr',
        textBaseline: 'top',
        textAlign: 'left',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        fillStyle: '#fff',
        strokeStyle: '#000',
        lineWidth: 1,
        lineJoin: 'round',
        lineCap: 'round',
        miterLimit: 2,
        shadowBlur: 0,
        shadowColor: 'transparent',
        shadowOffsetX: 0,
        shadowOffsetY: 0,
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
        clip() {},
        moveTo() {},
        lineTo() {},
        arcTo() {},
        quadraticCurveTo() {},
        bezierCurveTo() {},
        arc() {},
        ellipse() {},
        fill() {},
        stroke() {},
        setLineDash() {},
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        measureText: (txt) => ({ width: String(txt || '').length * 22 }),
        fillText(text) {
            fillOps.push({
                text: String(text),
                fillStyle: String(this.fillStyle),
                shadowBlur: this.shadowBlur,
                shadowColor: String(this.shadowColor),
            });
        },
        strokeText(text) {
            strokeOps.push({
                text: String(text),
                strokeStyle: String(this.strokeStyle),
                lineWidth: this.lineWidth,
            });
        },
    };

    const rendererSandbox = loadBrowserScript('src/reels-canvas-renderer.js', {
        document: {
            createElement: () => ({
                width: 1080,
                height: 1920,
                getContext: () => ctx,
            }),
        },
    });
    const ReelsCanvasRenderer = rendererSandbox.window.ReelsCanvasRenderer;
    const renderer = new ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: () => ctx });
    const origRoundRect = renderer._roundRect.bind(renderer);
    renderer._roundRect = function (...args) {
        roundRectCalls.push(args);
        return origRoundRect(...args);
    };

    const baseGlowPreset = engine.mergeStyle({
        ...presetsMap['参考_黄绿辉光逐词叠排'],
        holy_glow_color: '#00E5FF',
        kinetic_glow_color: '#00E5FF',
        holy_glow_radius: 18,
        kinetic_glow_blur: 18,
        color_text: '#FFFFFF',
        color_high: '#FF2A85',
        highlight_enabled: true,
        use_stroke: true,
        color_outline: '#112233',
        border_width: 6,
        use_box: true,
        color_bg: '#050811',
        opacity_bg: 180,
    });
    const seg = {
        start: 0,
        end: 1.5,
        text: 'God is good',
        words: [
            { word: 'God', start: 0.0, end: 0.5 },
            { word: 'is', start: 0.5, end: 1.0 },
            { word: 'good', start: 1.0, end: 1.5 },
        ],
    };
    renderer.setContextSegments([seg]);
    renderer.renderSubtitle(baseGlowPreset, seg, 0.75, 1080, 1920);

    // Active word "is" must use color_high (#FF2A85), spoken word "God" uses color_text (#FFFFFF)
    assert.ok(fillOps.some(op => op.text === 'is' && op.fillStyle.toUpperCase() === '#FF2A85'), 'Active word in kinetic_glow_stack must respect color_high');
    assert.ok(fillOps.some(op => op.text === 'God' && op.fillStyle.toUpperCase() === '#FFFFFF'), 'Non-active spoken word in kinetic_glow_stack must use color_text');
    // Glow pass must use custom glow radius (18) and glow color (#00E5FF)
    assert.ok(fillOps.some(op => op.shadowColor.toUpperCase() === '#00E5FF' && Math.abs(op.shadowBlur - 18) < 1), 'kinetic_glow_stack must respect customized glow radius and color');
    // Stroke must be rendered when use_stroke=true and border_width=6
    assert.ok(strokeOps.length > 0 && strokeOps.some(op => op.strokeStyle.toUpperCase() === '#112233'), 'kinetic_glow_stack must render outline when use_stroke is enabled');
    // Box must be rendered when use_box=true
    assert.ok(roundRectCalls.length > 0, 'kinetic_glow_stack must render background box when use_box is enabled');

    // 4) Verify 50 newly added free Google Fonts are registered in GOOGLE_FONTS, getUnifiedFontCatalog(), and FONTS_METADATA
    const metaSandbox = loadBrowserScript('src/fonts-metadata.js');
    const fontSandbox = loadBrowserScript('src/reels-font-manager.js', {
        window: { FONTS_METADATA: metaSandbox.window.FONTS_METADATA },
    });
    const fm = fontSandbox.window.getFontManager();
    assert.ok(fm, 'getFontManager() should return ReelsFontManager instance');
    for (const gf of fontSandbox.window.GOOGLE_FONTS) {
        if (!fm._allowedFonts.includes(gf)) fm._allowedFonts.push(gf);
    }
    const catalog = fm.getUnifiedFontCatalog();
    const new50GoogleFonts = [
        'Syne', 'League Spartan', 'Hanken Grotesk', 'Be Vietnam Pro', 'Gabarito',
        'Chakra Petch', 'Rajdhani', 'Michroma', 'Syncopate', 'Lexend Deca',
        'Spline Sans', 'Epilogue', 'Cinzel', 'Cinzel Decorative', 'Castoro Titling',
        'Marcellus', 'Vidaloka', 'Rozha One', 'Gloock', 'Bellefair',
        'Caudex', 'Mate SC', 'Titan One', 'Luckiest Guy', 'Boogaloo',
        'Carter One', 'Paytone One', 'Calistoga', 'Racing Sans One', 'Black Han Sans',
        'Dela Gothic One', 'Bungee Spice', 'Chewy', 'Rowdies', 'Parisienne',
        'Italianno', 'Mrs Saint Delafield', 'Petit Formal Script', 'Sriracha', 'Mali',
        'Nanum Pen Script', 'Sedgwick Ave Display', 'Courier Prime', 'Special Elite', 'VT323',
        'DM Mono', 'Noto Serif TC', 'Noto Serif HK', 'Shippori Mincho', 'Yuji Syuku',
    ];
    const new50EnglishGoogleFonts = [
        'Antonio', 'Six Caps', 'Fjalla One', 'Akshar', 'Cabin Condensed',
        'Saira Condensed', 'Saira Stencil One', 'Aldrich', 'Electrolize', 'Quantico',
        'Audiowide', 'Oxanium', 'Gruppo', 'Julius Sans One', 'Cormorant Upright',
        'Playfair Display SC', 'Chonburi', 'Antic Didone', 'Rufina', 'Trirong',
        'Taviraj', 'Alike Angular', 'Bentham', 'Radley', 'Fanwood Text',
        'Italiana', 'Sigmar One', 'Wendy One', 'Ceviche One', 'Fredericka the Great',
        'Rye', 'Sancreek', 'Smokum', 'Creepster', 'Nosifer',
        'Eater', 'Wallpoet', 'Plaster', 'Megrim', 'Zen Dots',
        'Mr De Haviland', 'Herr Von Muellerhoff', 'Miss Fajardose', 'Rochester', 'Niconne',
        'Yesteryear', 'Rancho', 'Nova Mono', 'Syne Mono', 'Overpass Mono',
    ];
    assert.equal(new50GoogleFonts.length, 50);
    assert.equal(new50EnglishGoogleFonts.length, 50);
    for (const fontName of [...new50GoogleFonts, ...new50EnglishGoogleFonts]) {
        assert.ok(fontSandbox.window.GOOGLE_FONTS.includes(fontName), `GOOGLE_FONTS should include ${fontName}`);
        assert.ok(catalog.groups.google.includes(fontName), `Unified catalog google group should include ${fontName}`);
        assert.ok(catalog.displayNames[fontName], `displayNames should have a Chinese label for ${fontName}`);
        const meta = fm._getFontMetadata(fontName);
        assert.ok(meta && meta.source === 'google' && Array.isArray(meta.aliases) && meta.aliases.length > 0, `FONTS_METADATA should provide rich metadata for ${fontName}`);
    }

    // 5) Verify _applyGoogleCatalogItems parses full Google Fonts API metadata (1960+ catalog items)
    const parsedFamilies = fm._applyGoogleCatalogItems([
        {
            family: 'Aboreto',
            category: 'Display',
            subsets: ['menu', 'latin', 'latin-ext'],
            popularity: 120,
            trending: 45,
            dateAdded: '2022-08-10',
            fonts: { '400': {} },
        },
        {
            family: 'Zen Maru Gothic',
            category: 'Sans Serif',
            subsets: ['menu', 'japanese', 'latin'],
            popularity: 85,
            trending: 30,
            dateAdded: '2021-10-01',
            fonts: { '300': {}, '400': {}, '500': {}, '700': {}, '900': {} },
        },
    ]);
    assert.deepEqual([...parsedFamilies], ['Aboreto', 'Zen Maru Gothic']);
    const aboretoMeta = fm._getFontMetadata('Aboreto');
    assert.equal(aboretoMeta.category, 'display');
    assert.equal(aboretoMeta.trendingRank, 45);
    const zenMeta = fm._getFontMetadata('Zen Maru Gothic');
    assert.equal(zenMeta.category, 'cjk');
    assert.equal(zenMeta.subCategory, 'sans');
    assert.ok(fm.getFontWeightOptions('Zen Maru Gothic').includes('900'), 'Registered Google Font variants should include weight 900');
});

test('100 new viral/aesthetic presets (sub-128..sub-227), unique fingerprints, ASS/JSON preset studio parser & custom group import', async () => {
    const fs = require('node:fs');
    const path = require('node:path');

    // 1) Load style engine & all 260 builtin presets (160 existing + 100 new sub-128..sub-227)
    const styleSandbox = loadBrowserScript('src/reels-style-engine.js');
    loadBrowserScript('src/reels-presets-init.js', styleSandbox);
    const engine = styleSandbox.window.ReelsStyleEngine;
    const resolveBuiltinPreset = styleSandbox.window.resolveBuiltinPreset;

    assert.ok(engine.MAX_PRESETS >= 500, 'MAX_PRESETS should accommodate 260+ builtins plus user/online packs');

    // 2) Verify zero duplicate preset names across PRESET_CATEGORIES & getPresetsByCategory()
    const { categorized, presetsMap } = engine.getPresetsByCategory();
    const seenAcrossCategories = new Map();
    for (const group of categorized) {
        for (const name of group.names) {
            assert.ok(
                !seenAcrossCategories.has(name),
                `Preset "${name}" must not appear in multiple categories (both "${seenAcrossCategories.get(name)}" and "${group.category}")`
            );
            seenAcrossCategories.set(name, group.category);
        }
    }

    // Check fingerprint uniqueness across ALL presets in presetsMap
    const allFingerprints = new Map();
    for (const [name, style] of Object.entries(presetsMap)) {
        const fp = engine.subtitleStyleFingerprint(style);
        assert.ok(!allFingerprints.has(fp), `Preset "${name}" duplicates style fingerprint of "${allFingerprints.get(fp)}"`);
        allFingerprints.set(fp, name);
    }

    // 3) Verify every new preset sub-128 through sub-227 resolves, is categorized, and renders cleanly
    const mockCtx = {
        canvas: { width: 1080, height: 1920 },
        font: '',
        direction: 'ltr',
        textBaseline: 'top',
        textAlign: 'left',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        fillStyle: '#fff',
        strokeStyle: '#000',
        lineWidth: 1,
        lineJoin: 'round',
        lineCap: 'round',
        miterLimit: 2,
        shadowBlur: 0,
        shadowColor: 'transparent',
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
        beginPath() {},
        closePath() {},
        rect() {},
        roundRect() {},
        fillRect() {},
        strokeRect() {},
        clearRect() {},
        clip() {},
        moveTo() {},
        lineTo() {},
        arcTo() {},
        quadraticCurveTo() {},
        bezierCurveTo() {},
        arc() {},
        ellipse() {},
        fill() {},
        stroke() {},
        setLineDash() {},
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        measureText: (txt) => ({ width: String(txt || '').length * 22 }),
        fillText() { fillCount++; },
        strokeText() {},
    };
    let fillCount = 0;
    const rendererSandbox = loadBrowserScript('src/reels-canvas-renderer.js', {
        document: {
            createElement: () => ({
                width: 1080,
                height: 1920,
                getContext: () => mockCtx,
            }),
        },
    });
    const ReelsCanvasRenderer = rendererSandbox.window.ReelsCanvasRenderer;
    const renderer = new ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: () => mockCtx });
    const sampleSeg = {
        start: 0,
        end: 2.0,
        text: 'Viral Glow 爆款测试',
        words: [
            { word: 'Viral', start: 0, end: 0.6 },
            { word: 'Glow', start: 0.6, end: 1.2 },
            { word: '爆款测试', start: 1.2, end: 2.0 },
        ],
    };
    renderer.setContextSegments([sampleSeg]);

    for (let i = 128; i <= 227; i++) {
        const code = `sub-${i}`;
        const resolved = resolveBuiltinPreset(code);
        assert.ok(resolved && resolved.kind === 'subtitle', `${code} must resolve as builtin subtitle preset`);
        assert.ok(presetsMap[resolved.name], `${code} (${resolved.name}) must exist in presetsMap`);
        assert.ok(seenAcrossCategories.has(resolved.name), `${code} (${resolved.name}) must be categorized`);

        fillCount = 0;
        const merged = engine.mergeStyle(presetsMap[resolved.name]);
        renderer.renderSubtitle(merged, sampleSeg, 0.75, 1080, 1920);
        assert.ok(fillCount > 0, `${code} (${resolved.name}) must render visible text draws`);
    }

    // 4) Load reels-preset-library.js and verify ASS / JSON / community pack parsing + prototype pollution protection
    loadBrowserScript('src/reels-preset-library.js', styleSandbox);
    const lib = styleSandbox.window.ReelsPresetLibrary;
    assert.ok(lib, 'ReelsPresetLibrary should attach to window');
    assert.ok(Array.isArray(lib.BUILTIN_COMMUNITY_PACKS) && lib.BUILTIN_COMMUNITY_PACKS.length >= 3, 'BUILTIN_COMMUNITY_PACKS should provide curated packs');

    // Check community JSON feed file on disk
    const feedPath = path.join(__dirname, '..', 'presets', 'community-viral-presets.json');
    const feedRaw = fs.readFileSync(feedPath, 'utf8');
    const feedParsed = lib.parsePresetBundlePayload(feedRaw, 'community-feed');
    assert.equal(feedParsed.format, 'community-packs');
    assert.ok(feedParsed.packs.length >= 3, 'Community JSON feed should parse at least 3 packs');
    assert.ok(Object.keys(feedParsed.presets).length >= 10, 'Community JSON feed should contain at least 10 presets');

    // ASS color conversion (&HAABBGGRR & &HBBGGRR)
    const goldColor = lib.parseAssColorToHex('&H0000D7FF');
    assert.equal(goldColor.hex, '#FFD700');
    assert.equal(goldColor.opacity255, 255);
    const semiBlue = lib.parseAssColorToHex('&H80FF8800');
    assert.equal(semiBlue.hex, '#0088FF');
    assert.equal(semiBlue.opacity255, 127);

    // Aegisub .ass parser
    const sampleAss = [
        '[Script Info]',
        'Title: Demo',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        'Style: TopCard,Montserrat,56,&H0000FFFF,&H000000FF,&H00111111,&H40000000,-1,0,0,0,100,100,2,0,3,4,2,8,20,20,40,1',
        'Style: __proto__,Arial,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1',
        '',
        '[Events]',
        'Dialogue: 0,0:00:00.00,0:00:02.00,TopCard,,0,0,0,,{\\k30\\blur3\\fad(100,100)}Hello World',
    ].join('\n');
    const assParsed = lib.parseAssStylesToPresets(sampleAss, '🎭 ASS');
    assert.ok(!Object.prototype.hasOwnProperty.call(assParsed.presets, '__proto__'), '__proto__ style name must be filtered');
    const topCard = assParsed.presets['🎭 ASS_TopCard'];
    assert.ok(topCard, 'Parsed ASS style should preserve Name with prefix');
    assert.equal(topCard.font_family, 'Montserrat');
    assert.equal(topCard.color_text, '#FFFF00');
    assert.equal(topCard.color_high, '#FF0000');
    assert.equal(topCard.use_box, true);
    assert.equal(topCard.pos_y, 0.22);
    assert.equal(topCard.text_align, 'center');
    assert.equal(assParsed.eventHints.hasKaraokeTags, true);
    assert.equal(assParsed.eventHints.hasBlurTags, true);
    assert.equal(assParsed.eventHints.hasFadeTags, true);

    // CamelCase external JSON normalization & prototype pollution stripping
    const maliciousJson = '{"__proto__":{"color_text":"#123456"},"Viral Card":{"fontFamily":"Bangers","textColor":"#FFFFFF","highlightColor":"#00FF88","backgroundColor":"#111111","strokeWidth":4,"borderRadius":14,"glowColor":"#FF00AA","glowRadius":16}}';
    const jsonParsed = lib.parsePresetBundlePayload(maliciousJson, 'external');
    assert.ok(!Object.prototype.hasOwnProperty.call(jsonParsed.presets, '__proto__'));
    const viralCard = jsonParsed.presets['Viral Card'];
    assert.ok(viralCard);
    assert.equal(viralCard.font_family, 'Bangers');
    assert.equal(viralCard.color_text, '#FFFFFF');
    assert.equal(viralCard.color_high, '#00FF88');
    assert.equal(viralCard.color_bg, '#111111');
    assert.equal(viralCard.use_box, true);
    assert.equal(viralCard.use_stroke, true);
    assert.equal(viralCard.border_width, 4);
    assert.equal(viralCard.box_radius, 14);
    assert.equal(viralCard.holy_glow_color, '#FF00AA');
    assert.equal(viralCard.holy_glow_radius, 16);

    const feat = lib.getEffectFeatureTags(viralCard);
    assert.ok(feat.keys.has('glow') && feat.keys.has('box'), 'Feature tagger should detect glow and box attributes');

    // Remote fetcher must reject non-HTTPS URLs upfront
    await assert.rejects(() => lib.fetchRemotePresetSource('http://127.0.0.1/test.json'), /https/i);
    await assert.rejects(() => lib.fetchRemotePresetSource('javascript:alert(1)'), /https/i);

    // 5) Import community presets into custom group without mutating built-ins
    const importRes = engine.importSubtitlePresets(JSON.stringify({ presets: feedParsed.presets }), false, '🌐 社区免费预设');
    assert.ok(importRes && importRes.added.length >= 10, `Expected >= 10 imported community presets, got ${JSON.stringify(importRes)}`);
    const afterImport = engine.getPresetsByCategory();
    const communityGroup = afterImport.categorized.find(g => g.category === '💾 🌐 社区免费预设');
    assert.ok(communityGroup && communityGroup.names.length >= 10, 'Imported presets should appear under target custom category');
});

test('starry-lantern theme, Chinese flower lantern SVG, command palette, and file:// Vite bundle integrity', async () => {
    const { pathToFileURL } = require('node:url');

    const lanternMod = await import(pathToFileURL(path.join(ROOT, 'src/studio/chinese-lantern.js')).href);
    const paletteMod = await import(pathToFileURL(path.join(ROOT, 'src/studio/command-palette.js')).href);
    const starryMod = await import(pathToFileURL(path.join(ROOT, 'src/studio/starry-canvas.js')).href);
    const perfMod = await import(pathToFileURL(path.join(ROOT, 'src/studio/perf-bridge.js')).href);

    // 1) Chinese flower lantern SVG generator (palace + lotus variants, unique gradient IDs, safe static markup)
    assert.ok(lanternMod.LANTERN_MODES.lit && lanternMod.LANTERN_MODES.calm && lanternMod.LANTERN_MODES.off);
    const svgPalace = lanternMod.buildChineseLanternSvg({ variant: 'palace', width: 50, height: 96, cordLength: 18 });
    const svgLotus = lanternMod.buildChineseLanternSvg({ variant: 'lotus', width: 38, height: 74, cordLength: 10 });
    assert.match(svgPalace, /^<svg\s[\s\S]*<\/svg>$/);
    assert.match(svgLotus, /^<svg\s[\s\S]*<\/svg>$/);
    assert.ok(!/<script/i.test(svgPalace) && !/<script/i.test(svgLotus));
    const palaceIdMatch = svgPalace.match(/id="(vkl\d+)-core"/);
    const lotusIdMatch = svgLotus.match(/id="(vkl\d+)-core"/);
    assert.ok(palaceIdMatch && lotusIdMatch && palaceIdMatch[1] !== lotusIdMatch[1], 'Each SVG should emit distinct gradient IDs');

    // Mount stage & test poetic empty placeholder + lantern mode attributes
    const makeEl = (tag) => {
        const attrs = {};
        const el = {
            tagName: tag.toUpperCase(),
            id: '',
            className: '',
            style: {},
            children: [],
            textContent: '',
            _html: '',
            set innerHTML(val) { this._html = String(val); },
            get innerHTML() { return this._html; },
            setAttribute(k, v) { attrs[k] = String(v); },
            getAttribute(k) { return attrs[k] ?? null; },
            appendChild(child) { this.children.push(child); return child; },
            insertBefore(child) { this.children.unshift(child); return child; },
            querySelector() { return null; },
            addEventListener() {},
            removeEventListener() {},
            remove() { this._removed = true; },
            getContext() {
                const grad = { addColorStop() {} };
                return {
                    fillStyle: '',
                    strokeStyle: '',
                    globalAlpha: 1,
                    lineWidth: 1,
                    save() {},
                    restore() {},
                    scale() {},
                    createLinearGradient: () => grad,
                    createRadialGradient: () => grad,
                    fillRect() {},
                    beginPath() {},
                    arc() {},
                    fill() {},
                    stroke() {},
                    moveTo() {},
                    lineTo() {},
                };
            },
        };
        return el;
    };
    const mockElementsById = new Map();
    const bodyClasses = new Set(['theme-starry-lantern']);
    const placeholderEl = makeEl('div');
    placeholderEl.id = 'reels-preview-placeholder';
    mockElementsById.set('reels-preview-placeholder', placeholderEl);

    const listeners = new Map();
    const mockDoc = {
        hidden: false,
        body: {
            children: [],
            classList: {
                contains: (c) => bodyClasses.has(c),
                toggle: (c, force) => (force === undefined ? (bodyClasses.has(c) ? bodyClasses.delete(c) : bodyClasses.add(c)) : (force ? bodyClasses.add(c) : bodyClasses.delete(c))),
            },
            setAttribute(k, v) { this[k] = String(v); },
            appendChild(child) { if (child.id) mockElementsById.set(child.id, child); this.children.push(child); return child; },
            insertBefore(child) { if (child.id) mockElementsById.set(child.id, child); this.children.unshift(child); return child; },
        },
        getElementById: (id) => mockElementsById.get(id) || null,
        createElement: (tag) => makeEl(tag),
        querySelectorAll: (sel) => {
            if (sel === '.titlebar .tab[data-tab]') {
                return [{ getAttribute: () => 'batch-reels', textContent: '🎬 字幕工作台', click() {} }];
            }
            return [];
        },
        addEventListener(evt, fn) { listeners.set(evt, fn); },
        removeEventListener(evt) { listeners.delete(evt); },
    };

    const lanternStage = lanternMod.mountChineseLanternStage(mockDoc);
    assert.ok(mockElementsById.has('vk-lantern-stage'), 'Lantern corner stage should mount');
    assert.match(mockElementsById.get('vk-lantern-stage').innerHTML, /vk-lantern-eave-right/);
    assert.strictEqual(placeholderEl.children.length, 1, 'Empty preview placeholder should show poetic starry greeting');
    lanternStage.setMode('calm');
    assert.strictEqual(mockDoc.body['data-lantern-mode'], 'calm');
    lanternStage.setMode('invalid-fallback');
    assert.strictEqual(mockDoc.body['data-lantern-mode'], 'lit');

    // 2) Starry canvas backdrop init, mode change, and cleanup
    let rafCounter = 0;
    const mockWin = {
        devicePixelRatio: 1,
        innerWidth: 1280,
        innerHeight: 800,
        requestAnimationFrame() { return ++rafCounter; },
        cancelAnimationFrame() {},
        addEventListener() {},
        removeEventListener() {},
        matchMedia: () => ({ matches: false }),
    };
    const starry = starryMod.createStarryBackdrop({ document: mockDoc, window: mockWin, mode: 'lit' });
    assert.ok(mockElementsById.has('vk-starry-canvas'), 'Starry night canvas should mount');
    assert.strictEqual(mockElementsById.get('vk-starry-canvas').getAttribute('aria-hidden'), 'true');
    assert.ok(rafCounter >= 1, 'Initial frame should schedule animation when lit');
    starry.setMode('calm');
    starry.renderOnce();
    starry.destroy();
    assert.strictEqual(mockElementsById.get('vk-starry-canvas')._removed, true);

    // 3) Frame coalescer & HTML escaping + command palette indexing
    let coalescedRuns = 0;
    const timers = [];
    const fakeWin = {
        requestAnimationFrame(fn) { const id = timers.push(fn); return id; },
        cancelAnimationFrame(id) { timers[id - 1] = null; },
    };
    const coalescer = perfMod.createFrameCoalescer(fakeWin);
    coalescer.schedule('list', () => { coalescedRuns += 1; });
    coalescer.schedule('list', () => { coalescedRuns += 10; });
    for (const fn of timers) { if (typeof fn === 'function') fn(); }
    assert.strictEqual(coalescedRuns, 10, 'Coalescer should cancel superseded rAF work for the same key');

    assert.strictEqual(paletteMod.escapeHtml('<script>"a&b"</script>'), '&lt;script&gt;&quot;a&amp;b&quot;&lt;/script&gt;');
    const styleSandbox = loadBrowserScript('src/reels-style-engine.js');
    loadBrowserScript('src/reels-presets-init.js', styleSandbox);
    const styleEngine = styleSandbox.window.ReelsStyleEngine;
    const cmdItems = paletteMod.buildCommandItems({
        document: mockDoc,
        window: { ReelsStyleEngine: styleEngine, getSubtitlePresetCode: (n) => n.slice(0, 4) },
    });
    assert.ok(cmdItems.some(i => i.id === 'theme-starry-lantern'));
    assert.ok(cmdItems.some(i => i.id === 'lantern-calm'));
    assert.ok(cmdItems.some(i => i.id === 'tab-batch-reels'));
    assert.ok(cmdItems.filter(i => i.id.startsWith('preset-')).length >= 220, 'Command palette should index all subtitle presets');

    // 4) app.js theme presets + one-time starry default upgrade without overriding explicit dark preference
    const appSrc = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
    const themeStart = appSrc.indexOf("const THEME_KEY = 'videokit-theme';");
    assert.ok(themeStart !== -1, 'src/app.js should define THEME_KEY');
    const initCallIdx = appSrc.indexOf('initTheme();', themeStart);
    assert.ok(initCallIdx !== -1, 'src/app.js should invoke initTheme()');
    const themeBlock = appSrc.slice(themeStart, initCallIdx + 'initTheme();'.length);

    function runThemeSandbox(initialStorage = {}) {
        const store = { ...initialStorage };
        const cssVars = {};
        const rootClasses = new Set();
        const bodyClassesSet = new Set();
        let studioThemeNotified = null;
        const sandbox = {
            window: {
                VideoKitStudio: { onThemeChange(id) { studioThemeNotified = id; } },
                applyCustomThemeFromAccent: () => {},
            },
            localStorage: {
                getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
                setItem: (k, v) => { store[k] = String(v); },
            },
            document: {
                documentElement: {
                    style: { setProperty: (k, v) => { cssVars[k] = v; } },
                    classList: { toggle: (c, f) => (f ? rootClasses.add(c) : rootClasses.delete(c)) },
                },
                body: {
                    classList: {
                        add: (c) => bodyClassesSet.add(c),
                        remove: (c) => bodyClassesSet.delete(c),
                        toggle: (c, f) => (f ? bodyClassesSet.add(c) : bodyClassesSet.delete(c)),
                        contains: (c) => bodyClassesSet.has(c),
                    },
                },
                querySelectorAll: () => [],
            },
            applyThemeCardsSelection() {},
        };
        vm.runInNewContext(themeBlock, sandbox);
        return { sandbox, store, cssVars, rootClasses, bodyClassesSet, getStudioTheme: () => studioThemeNotified };
    }

    const freshBoot = runThemeSandbox({});
    assert.ok(freshBoot.sandbox.window.THEME_PRESETS['starry-lantern'], 'THEME_PRESETS should include starry-lantern');
    assert.ok(freshBoot.sandbox.window.THEME_PRESETS['christmas-eve'], 'THEME_PRESETS should include christmas-eve');
    assert.ok(freshBoot.sandbox.window.THEME_PRESETS['starry-ink'], 'THEME_PRESETS should include starry-ink');
    for (const existing of ['dark', 'light', 'eyecare', 'midnight', 'contrast']) {
        assert.ok(freshBoot.sandbox.window.THEME_PRESETS[existing], `Existing theme '${existing}' must be preserved`);
    }
    assert.strictEqual(freshBoot.store['videokit-theme'], 'christmas-eve', 'Fresh boot should default to christmas-eve');
    assert.strictEqual(freshBoot.store['vk_christmas_default_v1'], '1');
    assert.ok(freshBoot.bodyClassesSet.has('theme-christmas-eve'));
    assert.strictEqual(freshBoot.getStudioTheme(), 'christmas-eve');

    const migratedLegacyStarry = runThemeSandbox({ 'videokit-theme': 'starry-lantern', 'vk_starry_default_v1': '1' });
    assert.strictEqual(migratedLegacyStarry.store['videokit-theme'], 'christmas-eve', 'Legacy default starry-lantern should migrate once to christmas-eve');
    assert.ok(migratedLegacyStarry.bodyClassesSet.has('theme-christmas-eve'));

    const explicitDarkBoot = runThemeSandbox({ 'videokit-theme': 'dark', 'vk_christmas_default_v1': '1' });
    assert.strictEqual(explicitDarkBoot.store['videokit-theme'], 'dark', 'Explicit dark preference after migration must stay dark');
    assert.ok(!explicitDarkBoot.bodyClassesSet.has('theme-christmas-eve'));

    // 5) Electron instant dark window background & packaged dist file:// compatibility
    const mainJs = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    assert.match(mainJs, /backgroundColor:\s*'#060d0a'/, 'Electron mainWindow should pre-paint deep Christmas pine dark background');
    const distHtmlPath = path.join(ROOT, 'dist/index.html');
    if (fs.existsSync(distHtmlPath)) {
        const distHtml = fs.readFileSync(distHtmlPath, 'utf8');
        assert.ok(!/<script[^>]+type="module"[^>]+src="\.\/assets\//i.test(distHtml), 'Packaged dist/index.html must not emit ES module script tags on file://');
        assert.ok(!/crossorigin[^>]+assets\//i.test(distHtml), 'Packaged dist/index.html assets must not emit crossorigin attribute on file://');
    }
});

test('electron/main.js waits for app.whenReady() before calling dialog when single-instance lock is already held', async () => {
    const Module = require('node:module');
    const os = require('node:os');
    const mainPath = path.resolve(ROOT, 'electron/main.js');
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-lock-test-'));

    const origLoad = Module._load;
    let isReady = false;
    let resolveReady;
    const readyPromise = new Promise((res) => { resolveReady = res; });
    const dialogCalls = [];
    const exitCodes = [];
    const ipcOn = () => {};

    const mockElectron = {
        app: {
            isPackaged: false,
            commandLine: { appendSwitch() {} },
            getPath: () => tmpUserData,
            setPath() {},
            requestSingleInstanceLock: () => false,
            whenReady: () => readyPromise,
            exit: (code) => { exitCodes.push(code); },
            on() {},
        },
        BrowserWindow: class {},
        ipcMain: { on: ipcOn, handle: ipcOn },
        MessageChannelMain: class {},
        dialog: {
            showMessageBoxSync(opts) {
                if (!isReady) {
                    throw new Error('dialog module can only be used after app is ready');
                }
                dialogCalls.push(opts);
                return 0;
            },
        },
        powerSaveBlocker: { start: () => 0, stop() {} },
        protocol: { registerSchemesAsPrivileged() {} },
        shell: {},
        net: {},
        screen: {},
        desktopCapturer: {},
    };

    delete require.cache[mainPath];
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'electron') return mockElectron;
        return origLoad.apply(this, arguments);
    };

    try {
        // Must NOT throw synchronously before app is ready
        require(mainPath);
        assert.strictEqual(dialogCalls.length, 0, 'dialog must not be invoked before app.whenReady()');
        assert.strictEqual(exitCodes.length, 0, 'dev secondary instance must wait to show warning dialog before exiting');

        isReady = true;
        resolveReady();
        await new Promise((r) => setImmediate(r));

        assert.strictEqual(dialogCalls.length, 1, 'dialog should show once app is ready');
        assert.strictEqual(dialogCalls[0].title, '源码测试版未启动');
        assert.deepStrictEqual(exitCodes, [0]);
    } finally {
        Module._load = origLoad;
        delete require.cache[mainPath];
        try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    }
});

test('dev-desktop launcher skips busy Vite port automatically and wires cmd/npm entrypoints', async () => {
    const net = require('node:net');
    const devDesktop = require(path.join(ROOT, 'scripts/dev-desktop.cjs'));

    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen({ port: 0, host: '127.0.0.1' }, resolve));
    const occupiedPort = blocker.address().port;

    try {
        assert.strictEqual(await devDesktop.isPortAvailable(occupiedPort), false, 'Occupied localhost port must be detected');
        const nextPort = await devDesktop.findAvailablePort(occupiedPort, 10);
        assert.ok(nextPort > occupiedPort && nextPort <= occupiedPort + 10, `Expected fallback port > ${occupiedPort}, got ${nextPort}`);
    } finally {
        await new Promise((resolve) => blocker.close(resolve));
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.scripts['electron:dev'], 'node scripts/dev-desktop.cjs');
    const startCmd = fs.readFileSync(path.join(ROOT, 'start-videokit.cmd'), 'utf8');
    assert.match(startCmd, /node scripts\\dev-desktop\.cjs/);
    const cnCmd = fs.readFileSync(path.join(ROOT, '双击启动测试.cmd'), 'utf8');
    assert.match(cnCmd, /node scripts\\dev-desktop\.cjs/);
});

test('Facebook Reel 1109400195335683 style: speech_feather_wipe + sub-228 Shrikhand preset + word pause sync & stationary layout', () => {
    const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    assert.ok(indexHtmlSrc.includes('<option value="speech_feather_wipe">人声逐字羽化</option>'));

    const batchReelsSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    assert.ok(batchReelsSrc.includes("anim_in_type: 'speech_feather_wipe'"), 'batch-reels should expose speech_feather_wipe quick preset');

    const presetLibSrc = fs.readFileSync(path.join(ROOT, 'src/reels-preset-library.js'), 'utf8');
    assert.ok(presetLibSrc.includes("'speech_feather_wipe'"), 'preset library should preserve/tag speech_feather_wipe');

    // Verify Shrikhand (offline bundled + metadata) and Knewave (Google Font) registration
    assert.ok(fs.existsSync(path.join(ROOT, 'assets/fonts/Shrikhand/Shrikhand-Regular.ttf')), 'Bundled Shrikhand-Regular.ttf should exist offline');
    const metaSandbox = loadBrowserScript('src/fonts-metadata.js');
    const fontSandbox = loadBrowserScript('src/reels-font-manager.js', {
        window: { FONTS_METADATA: metaSandbox.window.FONTS_METADATA },
    });
    assert.ok(fontSandbox.window.GOOGLE_FONTS.includes('Shrikhand'));
    assert.ok(fontSandbox.window.GOOGLE_FONTS.includes('Knewave'));
    const fm = fontSandbox.window.getFontManager();
    const fontsArr = metaSandbox.window.FONTS_METADATA.fonts;
    assert.ok(Array.isArray(fontsArr));
    assert.ok(fontsArr.some(f => f && f.family === 'Shrikhand'), 'FONTS_METADATA should include Shrikhand');
    assert.ok(fontsArr.some(f => f && f.family === 'Knewave'), 'FONTS_METADATA should include Knewave');
    assert.ok(fm._getFontMetadata('Shrikhand'), 'FontManager metadata lookup should return Shrikhand');
    assert.ok(fm._getFontMetadata('Knewave'), 'FontManager metadata lookup should return Knewave');

    // Verify sub-228 preset resolution, category membership, and unique fingerprint
    const sandbox = loadBrowserScript('src/reels-style-engine.js', { window: { addEventListener() {} } });
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);

    const { ReelsStyleEngine, ReelsAnimEngine, ReelsCanvasRenderer, resolveBuiltinPreset } = sandbox.window;
    const resolved = resolveBuiltinPreset('sub-228');
    assert.ok(resolved && resolved.preset, 'sub-228 must resolve to Reel 1109400195335683 preset');
    assert.equal(resolved.name, '✝️ 启示粗斜刷_人声逐字羽化显字');

    const style = ReelsStyleEngine.applySubtitlePreset(resolved.name);
    assert.equal(style.font_family, 'Shrikhand');
    assert.equal(style.color_text, '#FFFFFF');
    assert.equal(style.color_outline, '#000000');
    assert.equal(style.border_width, 6.5);
    assert.equal(style.highlight_enabled, false);
    assert.equal(style.karaoke_highlight, false);
    assert.equal(style.use_box, false);
    assert.equal(style.anim_in_type, 'speech_feather_wipe');
    assert.equal(style.pos_y, 0.56);

    const { categorized, presetsMap } = ReelsStyleEngine.getPresetsByCategory();
    const laserGroup = categorized.find(g => g.category === '✨ 物理动效 · 激光打字机');
    assert.ok(laserGroup && laserGroup.names.includes(resolved.name), 'sub-228 must be categorized under 物理动效 · 激光打字机');
    const targetFp = ReelsStyleEngine.subtitleStyleFingerprint(presetsMap[resolved.name]);
    const dupCount = Object.values(presetsMap).filter(st => ReelsStyleEngine.subtitleStyleFingerprint(st) === targetFp).length;
    assert.equal(dupCount, 1, 'sub-228 must have a unique style fingerprint');

    // Verify CLI routing forces wysiwyg Canvas engine
    const cliMod = require('../bin/videokit-cli.cjs');
    assert.ok(cliMod.CANVAS_EXCLUSIVE_ANIMATIONS.has('speech_feather_wipe'));
    const route = cliMod.resolveTaskEngine({}, style, [], {}, 'reel-1109400195335683-test');
    assert.equal(route.engine, 'wysiwyg');

    // Verify computeSpeechFeatherWipeState word-anchor sync, pause hold, synchronized stroke/fill, and fallback
    const wordAnchors = [
        { start: 0.0, end: 0.5, startDist: 0, endDist: 180 },
        { start: 1.0, end: 1.6, startDist: 205, endDist: 420 },
    ];
    const statePauseStart = ReelsAnimEngine.computeSpeechFeatherWipeState(0.55, 0.0, 2.5, [420], { fontSize: 64, wordAnchors });
    const statePauseEnd = ReelsAnimEngine.computeSpeechFeatherWipeState(0.95, 0.0, 2.5, [420], { fontSize: 64, wordAnchors });
    assert.equal(statePauseStart.active, true);
    assert.equal(statePauseStart.isSpeechFeatherWipe, true);
    assert.equal(statePauseStart.barAlpha, 0);
    assert.ok(Math.abs(statePauseStart.sweptDist - statePauseEnd.sweptDist) < 0.001, 'Sweep must hold steady during inter-word silence');

    const firstWordChar = ReelsAnimEngine.computeSpeechFeatherWipeCharReveal(20, statePauseStart);
    const futureWordChar = ReelsAnimEngine.computeSpeechFeatherWipeCharReveal(320, statePauseStart);
    assert.ok(firstWordChar.fillAlpha > 0.95 && firstWordChar.strokeAlpha > 0.95, 'Spoken word must be solidly revealed');
    assert.equal(futureWordChar.fillAlpha, 0, 'Unspoken word after pause must stay hidden');
    assert.equal(futureWordChar.strokeAlpha, 0);

    // Synchronized white fill + black outline (tight transition window ~0.72em vs 2.15em wide mist)
    assert.ok(statePauseStart.transitionWindow < 64, 'Speech feather transition window should be tight (<1em)');
    const frontRev = ReelsAnimEngine.computeSpeechFeatherWipeCharReveal(statePauseStart.sweptDist, statePauseStart);
    assert.ok(frontRev.strokeAlpha > 0.25 && Math.abs(frontRev.fillAlpha - frontRev.strokeAlpha) < 0.25, 'Fill and outline must reveal synchronously');

    // Linear full-segment fallback when no word anchors are available
    const fallbackEarly = ReelsAnimEngine.computeSpeechFeatherWipeState(0.2, 0.0, 2.0, [400], { fontSize: 64 });
    const fallbackLate = ReelsAnimEngine.computeSpeechFeatherWipeState(1.5, 0.0, 2.0, [400], { fontSize: 64 });
    assert.ok(fallbackLate.sweptDist > fallbackEarly.sweptDist);

    // End-to-end multi-line word-timed render test: stationary layout & progressive partial reveal
    const drawOps = [];
    const alphaStack = [];
    const ctx = {
        font: '400 64px Shrikhand',
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
        bezierCurveTo() {},
        arc() {},
        arcTo() {},
        rect() {},
        roundRect() {},
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
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
        measureText(txt) { return { width: String(txt || '').length * 22, actualBoundingBoxAscent: 46, actualBoundingBoxDescent: 12 }; },
        fillText(txt, x, y) { drawOps.push({ op: 'fill', text: String(txt), x, y, style: this.fillStyle, alpha: this.globalAlpha }); },
        strokeText(txt, x, y) { drawOps.push({ op: 'stroke', text: String(txt), x, y, style: this.strokeStyle, alpha: this.globalAlpha }); },
    };

    const renderer = new ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: () => ctx });
    const timedSeg = {
        start: 0.0,
        end: 3.2,
        text: 'If you ask me what to do\nwhen life stops making sense,\nthis is what I would say:',
        words: [
            { word: 'If', start: 0.05, end: 0.22 },
            { word: 'you', start: 0.22, end: 0.38 },
            { word: 'ask', start: 0.38, end: 0.58 },
            { word: 'me', start: 0.58, end: 0.72 },
            { word: 'what', start: 0.72, end: 0.90 },
            { word: 'to', start: 0.90, end: 1.04 },
            { word: 'do', start: 1.04, end: 1.25 },
            { word: 'when', start: 1.45, end: 1.65 },
            { word: 'life', start: 1.65, end: 1.85 },
            { word: 'stops', start: 1.85, end: 2.05 },
            { word: 'making', start: 2.05, end: 2.25 },
            { word: 'sense,', start: 2.25, end: 2.45 },
            { word: 'this', start: 2.55, end: 2.68 },
            { word: 'is', start: 2.68, end: 2.78 },
            { word: 'what', start: 2.78, end: 2.90 },
            { word: 'I', start: 2.90, end: 2.98 },
            { word: 'would', start: 2.98, end: 3.10 },
            { word: 'say:', start: 3.10, end: 3.20 },
        ],
    };

    const collectFills = (t) => {
        drawOps.length = 0;
        renderer.renderSubtitle(style, timedSeg, t, 1080, 1920);
        return drawOps.slice();
    };

    const opsEarly = collectFills(0.35);
    const opsMid = collectFills(1.32); // pause after 'do' on line 1; line 3 not spoken yet
    const opsFull = collectFills(3.20);

    const strokeIdx = opsMid.findIndex(d => d.op === 'stroke');
    const firstFillIdx = opsMid.findIndex(d => d.op === 'fill');
    assert.ok(strokeIdx >= 0 && firstFillIdx > strokeIdx, 'Black contour strokes must render before white character fills');

    const midText = opsMid.filter(d => d.op === 'fill').map(d => d.text).join('');
    assert.ok(midText.includes('If'), 'Earlier spoken characters must be drawn at mid-sentence');
    assert.ok(!midText.includes('say:'), 'Unspoken final line must stay completely invisible during earlier pause');

    const fullText = opsFull.filter(d => d.op === 'fill').map(d => d.text).join('');
    assert.ok(fullText.includes('say:'), 'Final line must be fully drawn at end of segment');

    // Stationary layout anchor check for the first character 'I' of 'If'
    const isWhiteFaceI = (d) => d.op === 'fill' && d.text === 'I' && d.style === '#FFFFFF' && d.alpha > 0.9;
    const firstI_early = opsEarly.find(isWhiteFaceI);
    const firstI_mid = opsMid.find(isWhiteFaceI);
    const firstI_full = opsFull.find(isWhiteFaceI);
    assert.ok(firstI_early && firstI_mid && firstI_full);
    assert.ok(Math.abs(firstI_early.x - firstI_full.x) < 0.01, 'Earlier word X position must remain stationary as later words appear');
    assert.ok(Math.abs(firstI_mid.y - firstI_full.y) < 0.01, 'Earlier word Y position must remain stationary');
});

test('Windows frameless titleBarOverlay chrome, November seasonal themes (autumn/snow/christmas), and layout styling integrity', async () => {
    const { pathToFileURL } = require('node:url');

    // 1) Electron Main & Preload Windows chromeless menu + dark titleBarOverlay contract
    const mainJs = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');
    assert.match(mainJs, /nativeTheme,\s*Menu/, 'electron/main.js must import nativeTheme and Menu');
    assert.match(mainJs, /Menu\.setApplicationMenu\(null\)/, 'Non-darwin platforms must hide native File/Edit white menu bar');
    assert.match(mainJs, /titleBarStyle\s*[:=]\s*'hidden'/, 'Windows/Linux must use hidden titleBarStyle');
    assert.match(mainJs, /autoHideMenuBar\s*[:=]\s*true/, 'Windows must set autoHideMenuBar: true');
    assert.match(mainJs, /titleBarOverlay\s*[:=]\s*\{/, 'Windows must configure dark titleBarOverlay');
    assert.match(mainJs, /handleTrusted\('window:set-titlebar-theme'/, 'Must expose window:set-titlebar-theme trusted IPC handler');
    assert.match(mainJs, /applyPlatformWindowChrome\([\s\S]*?'open-template-window'|open-template-window[\s\S]*?applyPlatformWindowChrome/, 'Template window must also receive platform window chrome');
    assert.match(preloadJs, /setTitlebarTheme:\s*\(themeInfo\)\s*=>\s*ipcRenderer\.invoke\('window:set-titlebar-theme',\s*themeInfo\)/);

    // 2) app.js THEME_PRESETS includes autumn-night, snow-night, christmas-eve & syncs Electron titleBarOverlay
    const appSrc = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
    const themeStart = appSrc.indexOf("const THEME_KEY = 'videokit-theme';");
    const initCallIdx = appSrc.indexOf('initTheme();', themeStart);
    assert.ok(themeStart !== -1 && initCallIdx > themeStart);
    const themeBlock = appSrc.slice(themeStart, initCallIdx + 'initTheme();'.length);

    const store = {};
    const bodyClassesSet = new Set();
    const ipcThemeCalls = [];
    const studioCalls = [];
    const sandbox = {
        window: {
            electronAPI: {
                setTitlebarTheme(payload) { ipcThemeCalls.push(payload); },
            },
            VideoKitStudio: {
                onThemeChange(id, meta) { studioCalls.push({ id, meta }); },
            },
            applyCustomThemeFromAccent: () => {},
        },
        localStorage: {
            getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
        },
        document: {
            documentElement: {
                style: { setProperty() {} },
                classList: { toggle() {} },
            },
            body: {
                classList: {
                    add: (c) => bodyClassesSet.add(c),
                    remove: (c) => bodyClassesSet.delete(c),
                    toggle: (c, f) => (f ? bodyClassesSet.add(c) : bodyClassesSet.delete(c)),
                    contains: (c) => bodyClassesSet.has(c),
                },
            },
            querySelectorAll: () => [],
        },
        applyThemeCardsSelection() {},
    };
    vm.runInNewContext(themeBlock, sandbox);
    const presets = sandbox.window.THEME_PRESETS;
    for (const id of ['starry-lantern', 'starry-ink', 'autumn-night', 'snow-night', 'christmas-eve', 'dark', 'light', 'eyecare', 'midnight', 'contrast']) {
        assert.ok(presets[id], `THEME_PRESETS must define '${id}'`);
    }
    for (const seasonalId of ['autumn-night', 'snow-night', 'christmas-eve']) {
        sandbox.window.applyTheme(seasonalId);
        assert.ok(bodyClassesSet.has(`theme-${seasonalId}`), `Applying ${seasonalId} must add body.theme-${seasonalId}`);
        assert.strictEqual(store['videokit-theme'], seasonalId);
        assert.strictEqual(studioCalls[studioCalls.length - 1]?.id, seasonalId);
        assert.strictEqual(ipcThemeCalls[ipcThemeCalls.length - 1]?.isLight, false);
        assert.match(ipcThemeCalls[ipcThemeCalls.length - 1]?.color || '', /^#[0-9a-f]{6}$/i);
    }
    sandbox.window.applyTheme('light');
    assert.strictEqual(ipcThemeCalls[ipcThemeCalls.length - 1]?.isLight, true);

    // 3) Seasonal stage ornaments & canvas particles render cleanly across autumn/snow/christmas/starry
    const lanternMod = await import(pathToFileURL(path.join(ROOT, 'src/studio/chinese-lantern.js')).href);
    const starryMod = await import(pathToFileURL(path.join(ROOT, 'src/studio/starry-canvas.js')).href);
    const paletteMod = await import(pathToFileURL(path.join(ROOT, 'src/studio/command-palette.js')).href);

    const byId = new Map();
    const sceneClasses = new Set(['theme-starry-lantern']);
    const makeEl = (tag) => ({
        tagName: tag.toUpperCase(),
        id: '',
        className: '',
        style: {},
        children: [],
        innerHTML: '',
        textContent: '',
        setAttribute() {},
        appendChild(c) { this.children.push(c); return c; },
        insertBefore(c) { this.children.unshift(c); return c; },
        querySelector() { return null; },
        remove() {},
        getContext() {
            const grad = { addColorStop() {} };
            return {
                fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1,
                save() {}, restore() {}, scale() {},
                createLinearGradient: () => grad, createRadialGradient: () => grad,
                fillRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, closePath() {},
            };
        },
    });
    const ph = makeEl('div');
    ph.id = 'reels-preview-placeholder';
    byId.set(ph.id, ph);
    const mockDoc = {
        hidden: false,
        body: {
            children: [],
            classList: {
                contains: (c) => sceneClasses.has(c),
                toggle: (c, f) => (f === undefined ? (sceneClasses.has(c) ? sceneClasses.delete(c) : sceneClasses.add(c)) : (f ? sceneClasses.add(c) : sceneClasses.delete(c))),
            },
            setAttribute() {},
            appendChild(c) { if (c.id) byId.set(c.id, c); this.children.push(c); return c; },
            insertBefore(c) { if (c.id) byId.set(c.id, c); this.children.unshift(c); return c; },
        },
        getElementById: (id) => byId.get(id) || null,
        createElement: (t) => makeEl(t),
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
    };
    const stage = lanternMod.mountChineseLanternStage(mockDoc);
    const backdrop = starryMod.createStarryBackdrop({
        document: mockDoc,
        window: { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {} },
        mode: 'lit',
    });
    for (const sId of ['autumn-night', 'snow-night', 'christmas-eve', 'starry-ink', 'starry-lantern']) {
        for (const k of Array.from(sceneClasses)) sceneClasses.delete(k);
        sceneClasses.add(`theme-${sId}`);
        stage.setSceneTheme(sId);
        backdrop.renderOnce();
        const stHtml = byId.get('vk-lantern-stage').innerHTML;
        assert.ok(stHtml.includes('<svg') && !/<script/i.test(stHtml), `${sId} corner ornament SVG must be valid & safe`);
    }
    backdrop.destroy();
    stage.destroy();

    // 4) Command palette & CSS selectors verify seasonal entries & Windows inset layout
    const cmdItems = paletteMod.buildCommandItems({ document: mockDoc, window: {} });
    assert.ok(cmdItems.some(i => i.id === 'theme-autumn-night'));
    assert.ok(cmdItems.some(i => i.id === 'theme-snow-night'));
    assert.ok(cmdItems.some(i => i.id === 'theme-christmas-eve'));

    const starryCss = fs.readFileSync(path.join(ROOT, 'src/studio/starry-theme.css'), 'utf8');
    const mainCss = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
    assert.match(starryCss, /body\.theme-autumn-night/);
    assert.match(starryCss, /body\.theme-snow-night/);
    assert.match(starryCss, /body\.theme-christmas-eve/);
    assert.match(starryCss, /\.vk-theme-popover/);
    assert.match(starryCss, /body\.theme-light\s+\.vk-pill-btn/);
    assert.match(mainCss, /body\.platform-win32\s+\.titlebar[\s\S]*?--vk-win-controls-inset/);
    assert.match(mainCss, /#reels-batch-table-container[\s\S]*?--window-chrome-height/);
    assert.match(mainCss, /\.rop-scroll-accordion/);
});

test('Scroll subtitle inspector organizes controls into clean collapsibles while preserving all IDs and badge updates', () => {
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    const startIdx = panelSrc.indexOf('<div id="rop-scroll-props"');
    const endIdx = panelSrc.indexOf('<div id="rop-textcard-props"');
    assert.ok(startIdx !== -1 && endIdx > startIdx, 'Must locate #rop-scroll-props block before #rop-textcard-props');
    const scrollBlock = panelSrc.slice(startIdx, endIdx);

    // Outer accordions: title + body open by default; effects, tw, motion, feather, bgadv collapsed by default
    assert.match(scrollBlock, /<details class="rop-scroll-accordion" id="rop-scroll-acc-title" open>/);
    assert.match(scrollBlock, /<details class="rop-scroll-accordion" id="rop-scroll-acc-body" open>/);
    for (const collapsedId of ['rop-scroll-acc-effects', 'rop-scroll-acc-tw', 'rop-scroll-acc-motion', 'rop-scroll-acc-feather', 'rop-scroll-acc-bgadv']) {
        assert.match(scrollBlock, new RegExp(`<details class="rop-scroll-accordion" id="${collapsedId}">`), `${collapsedId} must be collapsed by default`);
    }
    assert.match(scrollBlock, /<details class="rop-scroll-subacc" id="rop-scroll-acc-corner-badge">/);
    assert.match(scrollBlock, /<details class="rop-scroll-subacc" id="rop-scroll-acc-ribbon">/);
    assert.match(scrollBlock, /<details class="rop-scroll-subacc" id="rop-scroll-acc-tw-presets">/);
    assert.match(scrollBlock, /<details class="rop-scroll-subacc" id="rop-scroll-acc-tw-icons">/);

    // All preset/button counts remain intact inside accordions
    assert.strictEqual((scrollBlock.match(/class="[^"]*rop-scroll-card-bg-preset/g) || []).length, 25);
    assert.strictEqual((scrollBlock.match(/class="[^"]*rop-scroll-corner-badge-quick/g) || []).length, 13);
    assert.strictEqual((scrollBlock.match(/class="[^"]*rop-scroll-body-bg-preset/g) || []).length, 13);
    assert.strictEqual((scrollBlock.match(/class="[^"]*rop-scroll-tw-style-preset/g) || []).length, 14);
    assert.strictEqual((scrollBlock.match(/class="[^"]*rop-scroll-tw-icon-chip/g) || []).length, 41);
    assert.strictEqual((scrollBlock.match(/class="[^"]*rop-scroll-feather-preset/g) || []).length, 5);

    // Critical DOM element IDs remain identically addressable
    const requiredIds = [
        'rop-scroll-apply-all', 'rop-scroll-style-picker-btn', 'rop-scroll-style-preset-select',
        'rop-scroll-title', 'rop-scroll-title-deco-opacity', 'rop-scroll-content', 'rop-scroll-body-bg-pad-bottom',
        'rop-scroll-bg-width-quick', 'rop-scroll-bg-height-quick-num', 'rop-scroll-bg-opacity-quick',
        'rop-scroll-bg-scroll-follow-quick', 'rop-scroll-bg-body-only-quick',
        'rop-scroll-body-bg-pad-h-quick', 'rop-scroll-body-bg-pad-v-quick', 'rop-scroll-body-bg-opacity-quick',
        'rop-scroll-tw-enabled', 'rop-scroll-tw-details', 'rop-scroll-tw-icon-grid', 'rop-scroll-tw-cursor-image-row',
        'rop-scroll-show-end', 'rop-scroll-speed', 'rop-scroll-focus-flow-enabled',
        'rop-scroll-feather-mode', 'rop-scroll-feather-right-offset',
        'rop-scroll-bg-enabled', 'rop-scroll-bg-style', 'rop-scroll-bg-top-mascot', 'rop-scroll-bg-blur-amount',
    ];
    for (const id of requiredIds) {
        assert.ok(scrollBlock.includes(`id="${id}"`), `Preserved scroll control ID missing: #${id}`);
    }

    // Verify _updateScrollAccordionBadges method exists and updates badge text cleanly
    const methodMatch = panelSrc.match(/_updateScrollAccordionBadges\(ov\)\s*\{[\s\S]*?\n    \}/);
    assert.ok(methodMatch, '_updateScrollAccordionBadges(ov) helper should be defined on ReelsOverlayPanel');
    const badgeEls = new Map();
    const makeBadgeEl = () => ({
        textContent: '',
        classes: new Set(),
        classList: { toggle(c, f) { f ? this._owner.classes.add(c) : this._owner.classes.delete(c); } },
    });
    for (const id of [
        'rop-scroll-acc-title-badge', 'rop-scroll-acc-body-badge', 'rop-scroll-acc-effects-badge',
        'rop-scroll-acc-corner-badge-val', 'rop-scroll-acc-ribbon-val', 'rop-scroll-acc-tw-badge',
        'rop-scroll-acc-motion-badge', 'rop-scroll-acc-feather-badge', 'rop-scroll-acc-bgadv-badge',
    ]) {
        const b = makeBadgeEl();
        b.classList._owner = b;
        badgeEls.set(`#${id}`, b);
    }
    const fn = new Function('ov', `return (function ${methodMatch[0].replace(/^_updateScrollAccordionBadges/, '_updateScrollAccordionBadges')}).call(this, ov);`);
    fn.call({ container: { querySelector: (sel) => badgeEls.get(sel) || null } }, {
        scroll_title: 'Autumn',
        fontsize: 48,
        content: 'Line 1\nLine 2',
        scroll_bg_enabled: true,
        scroll_body_bg_enabled: true,
        scroll_body_bg_style: 'newspaper_cutout',
        scroll_bg_bookmark_enabled: true,
        scroll_bg_bookmark_style: 'swallowtail',
        scroll_typewriter_enabled: true,
        scroll_focus_flow_enabled: true,
        scroll_feather_top: 90,
        scroll_feather_bottom: 60,
    });
    assert.strictEqual(badgeEls.get('#rop-scroll-acc-title-badge').textContent, '已填 6字');
    assert.strictEqual(badgeEls.get('#rop-scroll-acc-body-badge').textContent, '48px · 2行');
    assert.strictEqual(badgeEls.get('#rop-scroll-acc-effects-badge').textContent, '画板+底衬');
    assert.strictEqual(badgeEls.get('#rop-scroll-acc-tw-badge').textContent, '已开启');
    assert.strictEqual(badgeEls.get('#rop-scroll-acc-motion-badge').textContent, '焦点起停');
    assert.strictEqual(badgeEls.get('#rop-scroll-acc-feather-badge').textContent, '上90 / 下60');
    assert.strictEqual(badgeEls.get('#rop-scroll-acc-bgadv-badge').textContent, '已启用');
});

test('Top nav groups subtitle tools and voice tools into sidebars and renames Media Tools', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
    const appJs = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
    const paletteJs = fs.readFileSync(path.join(ROOT, 'src/studio/command-palette.js'), 'utf8');

    const navMatch = html.match(/<nav class="tabs">[\s\S]*?<\/nav>/);
    assert.ok(navMatch, 'index.html must contain top <nav class="tabs">');
    const navHtml = navMatch[0];
    assert.ok(navHtml.includes('data-tab="subtitle-suite">字幕工具<'));
    assert.ok(navHtml.includes('data-tab="voice-suite">声音工具<'));
    assert.ok(navHtml.includes('data-tab="media">媒体工具<'));
    assert.ok(!navHtml.includes('媒体转换'));
    for (const removedTopTab of ['voiceover-workflow', 'elevenlabs', 'microsoft-tts', 'google-tts', 'subtitle', 'srt-tools']) {
        assert.ok(!navHtml.includes(`data-tab="${removedTopTab}"`), `Top nav should no longer expose standalone tab ${removedTopTab}`);
    }

    assert.ok(html.includes('<section id="subtitle-suite-panel" class="panel vk-suite-panel"'));
    assert.ok(html.includes('<aside class="vk-suite-sidebar" data-suite="subtitle-suite">'));
    assert.ok(html.includes('data-suite-tab="voiceover-workflow"'));
    assert.ok(html.includes('data-suite-tab="subtitle"'));
    assert.ok(html.includes('data-suite-tab="srt-tools"'));

    assert.ok(html.includes('<section id="voice-suite-panel" class="panel vk-suite-panel"'));
    assert.ok(html.includes('<aside class="vk-suite-sidebar" data-suite="voice-suite">'));
    assert.ok(html.includes('data-suite-tab="elevenlabs"'));
    assert.ok(html.includes('data-suite-tab="microsoft-tts"'));
    assert.ok(html.includes('data-suite-tab="google-tts"'));

    // Every original panel stays intact with unique ID and balanced <section> tags
    assert.strictEqual((html.match(/<section\b/g) || []).length, (html.match(/<\/section>/g) || []).length);
    for (const id of [
        'voiceover-workflow-panel',
        'subtitle-panel',
        'srt-tools-panel',
        'elevenlabs-panel',
        'microsoft-tts-panel',
        'google-tts-panel',
    ]) {
        assert.strictEqual((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `Expected unique panel ${id}`);
    }

    assert.match(css, /\.vk-suite-panel > \.panel-content/);
    assert.match(css, /\.vk-suite-sidebar/);
    assert.match(css, /\.vk-suite-workbench/);

    assert.ok(appJs.includes('PANEL_SUITE_PARENTS'));
    assert.ok(appJs.includes('function activateSuiteSubtab('));
    assert.ok(appJs.includes('function initSuiteSidebars()'));
    assert.ok(paletteJs.includes('.vk-suite-sidebar[data-suite] .sidebar-item[data-suite-tab]'));

    // Bespoke VideoKit checkmark SVG logo lockup + standalone asset
    assert.ok(html.includes('class="vk-brand-lockup"') && html.includes('class="vk-brand-logo"'));
    assert.ok(css.includes('.vk-brand-lockup') && css.includes('.vk-brand-logo'));
    const logoSvg = fs.readFileSync(path.join(ROOT, 'assets/videokit-logo.svg'), 'utf8');
    assert.ok(logoSvg.includes('<path d="M8.2 16.4 L13.5 21.8 L24.0 10.0"'));
});

test('Decor panel & inline decor inspector organize controls into collapsibles while preserving all IDs and live badges', () => {
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');

    // 1) Inline #rop-decor-props accordions inside ReelsOverlayPanel
    const ropDecorStart = panelSrc.indexOf('<div id="rop-decor-props"');
    const ropDecorEnd = panelSrc.indexOf('<!-- 滚动字幕属性');
    assert.ok(ropDecorStart !== -1 && ropDecorEnd > ropDecorStart, 'Must locate #rop-decor-props block');
    const ropDecorBlock = panelSrc.slice(ropDecorStart, ropDecorEnd);

    for (const id of ['rop-decor-acc-dark', 'rop-decor-acc-grain', 'rop-decor-acc-effects', 'rop-decor-acc-layout']) {
        assert.match(ropDecorBlock, new RegExp(`<details class="rop-scroll-accordion" id="${id}">`), `${id} must be collapsed by default`);
        assert.ok(ropDecorBlock.includes(`id="${id}-badge"`), `${id}-badge must exist`);
    }
    for (const controlId of [
        'rop-open-dedicated-decor-tab', 'rop-decor-apply-all', 'rop-decor-fit-fullscreen', 'rop-decor-fit-card',
        'rop-decor-style', 'rop-decor-layout', 'rop-decor-dark-vignette', 'rop-decor-vignette-spread', 'rop-decor-dark-tint',
        'rop-decor-grain-intensity', 'rop-decor-grain-size', 'rop-decor-grain-warmth', 'rop-decor-film-scratches', 'rop-decor-light-leak',
        'rop-decor-floating-particles', 'rop-decor-particle-mode', 'rop-decor-glow-stars', 'rop-decor-snowflakes',
        'rop-decor-corner-ornaments', 'rop-decor-edge-garland', 'rop-decor-density', 'rop-decor-size', 'rop-decor-glow',
        'rop-decor-speed', 'rop-decor-margin', 'rop-decor-center-clear', 'rop-decor-color1', 'rop-decor-color2',
    ]) {
        assert.ok(ropDecorBlock.includes(`id="${controlId}"`), `Preserved inline decor control missing: #${controlId}`);
    }

    // 2) Standalone ReelsDecorPanel accordions & Phone CTA collapsible structure
    const rdpStart = panelSrc.indexOf('class ReelsDecorPanel');
    assert.ok(rdpStart !== -1, 'ReelsDecorPanel class must exist');
    const rdpBlock = panelSrc.slice(rdpStart);

    assert.match(rdpBlock, /<details class="rop-scroll-accordion rdp-accordion" id="rdp-acc-presets" open>/);
    for (const collapsedId of ['rdp-acc-effects', 'rdp-acc-dark', 'rdp-acc-grain', 'rdp-acc-layout']) {
        assert.match(rdpBlock, new RegExp(`<details class="rop-scroll-accordion rdp-accordion" id="${collapsedId}">`), `${collapsedId} must be collapsed by default`);
    }
    assert.match(rdpBlock, /<details class="rop-scroll-subacc rdp-cta-subacc" id="rdp-acc-cta">/);
    assert.match(rdpBlock, /<details class="rop-scroll-subacc" id="rdp-acc-cta-timing" open>/);
    assert.match(rdpBlock, /<details class="rop-scroll-subacc" id="rdp-acc-cta-anim">/);

    for (const id of [
        'rdp-master-bar', 'rdp-master-enable', 'rdp-master-status-badge',
        'rdp-style-scope', 'rdp-apply-all', 'rdp-add-layer-btn', 'rdp-fit-full-btn', 'rdp-fit-card-btn', 'rdp-clear-layers-btn', 'rdp-layer-list',
        'rdp-style-select', 'rdp-preset-grid',
        'rdp-floating-particles', 'rdp-particle-mode', 'rdp-glow-stars', 'rdp-snowflakes', 'rdp-corner-ornaments', 'rdp-edge-garland',
        'rdp-dark-enabled', 'rdp-dark-vignette', 'rdp-vignette-spread', 'rdp-dark-tint',
        'rdp-grain-enabled', 'rdp-grain-intensity', 'rdp-grain-size', 'rdp-grain-warmth', 'rdp-film-scratches', 'rdp-light-leak',
        'rdp-layout', 'rdp-density', 'rdp-size', 'rdp-glow', 'rdp-speed', 'rdp-margin', 'rdp-center-clear', 'rdp-opacity', 'rdp-color1', 'rdp-color2',
        'rdp-phone-cta-card', 'rdp-cta-enable', 'rdp-cta-status-badge', 'rdp-cta-preview-btn', 'rdp-cta-delete-btn',
        'rdp-cta-mode-image', 'rdp-cta-mode-text', 'rdp-cta-image-section', 'rdp-cta-upload-btn', 'rdp-cta-reuse-last-btn',
        'rdp-cta-file-input', 'rdp-cta-img-dropzone', 'rdp-cta-img-thumb', 'rdp-cta-img-name', 'rdp-cta-clear-img-btn',
        'rdp-cta-img-width', 'rdp-cta-img-scale', 'rdp-cta-text-section', 'rdp-cta-style', 'rdp-cta-body', 'rdp-cta-title',
        'rdp-cta-mask-mode', 'rdp-cta-mask-color', 'rdp-cta-mask-opacity', 'rdp-cta-mask-radius', 'rdp-cta-pad-h',
        'rdp-cta-text-color', 'rdp-cta-phone-color', 'rdp-cta-fontsize', 'rdp-cta-text-width',
        'rdp-cta-x', 'rdp-cta-y', 'rdp-cta-start', 'rdp-cta-end', 'rdp-cta-end-full',
        'rdp-cta-anim-in', 'rdp-cta-anim-dur', 'rdp-cta-anim-out', 'rdp-cta-loop-anim',
    ]) {
        assert.ok(rdpBlock.includes(`id="${id}"`), `Preserved ReelsDecorPanel control missing: #${id}`);
    }
    assert.strictEqual((rdpBlock.match(/class="rdp-cat-btn/g) || []).length, 7, 'All 7 decor category filter pills must remain');
    assert.strictEqual((rdpBlock.match(/class="rdp-tint-chip"/g) || []).length, 5, 'All 5 dark tint chips must remain');
    assert.strictEqual((rdpBlock.match(/class="rop-btn rdp-cta-pos-btn"/g) || []).length, 5, 'All 5 Phone CTA position quick buttons must remain');
    assert.strictEqual((rdpBlock.match(/class="rop-btn rdp-cta-time-chip"/g) || []).length, 9, 'All 9 Phone CTA quick timing chips must remain');

    // 3) CSS styling classes for Decor Panel accordions & light mode overrides
    for (const selector of ['.rdp-root', '.rdp-master-bar', '.rdp-layer-card', '.rdp-preset-grid', '.rdp-cta-card', '.rdp-cta-header']) {
        assert.ok(cssSrc.includes(selector), `styles.css must define ${selector}`);
    }

    // 4) Live summary badge computation check via _computeDecorSummaryBadges
    const helperMatch = panelSrc.match(/function _computeDecorSummaryBadges\(ov\)\s*\{[\s\S]*?\n\}/);
    assert.ok(helperMatch, '_computeDecorSummaryBadges(ov) helper must be defined');
    const sandbox = {
        window: {
            ReelsOverlay: {
                DECOR_OVERLAY_STYLES: {
                    dark_starlight_mist: { name: '🌌 暗夜星空黑底 + 呼吸星芒微粒' },
                },
            },
        },
    };
    vm.runInNewContext(`${helperMatch[0]}; this._computeDecorSummaryBadges = _computeDecorSummaryBadges;`, sandbox);
    const activeSummary = sandbox._computeDecorSummaryBadges({
        decor_style: 'dark_starlight_mist',
        decor_dark_enabled: true,
        decor_dark_vignette: 72,
        decor_grain_enabled: true,
        decor_grain_intensity: 28,
        decor_film_scratches: true,
        decor_floating_particles: true,
        decor_glow_stars: true,
        decor_snowflakes: true,
        decor_layout: 'edges_and_float',
        decor_density: 90,
    });
    assert.strictEqual(activeSummary.presetLabel, '暗夜星空黑底 + 呼吸星芒微粒');
    assert.strictEqual(activeSummary.presetActive, true);
    assert.strictEqual(activeSummary.darkLabel, '已启用 · 72%');
    assert.strictEqual(activeSummary.darkActive, true);
    assert.strictEqual(activeSummary.grainLabel, '颗粒28%·划痕');
    assert.strictEqual(activeSummary.grainActive, true);
    assert.strictEqual(activeSummary.effectsLabel, '粒子·星芒 +1');
    assert.strictEqual(activeSummary.effectsActive, true);
    assert.strictEqual(activeSummary.layoutLabel, '边缘+漂浮 · 密度90');

    const emptySummary = sandbox._computeDecorSummaryBadges(null);
    assert.strictEqual(emptySummary.presetLabel, '未选择');
    assert.strictEqual(emptySummary.darkLabel, '已关闭');
    assert.strictEqual(emptySummary.grainLabel, '已关闭');
});

test('startup disables auto-opening template library and converts update prompts to top-right non-blocking toast', () => {
    const templatesSrc = fs.readFileSync(path.join(ROOT, 'src/reels-templates.js'), 'utf8');
    const updaterSrc = fs.readFileSync(path.join(ROOT, 'electron/updater.js'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');

    // 1) Template library must NOT auto-open when location.hash lacks #template=...
    const hashFnMatch = templatesSrc.match(/function _checkHashForTemplate\(\)\s*\{[\s\S]*?const templateId = match\[1\];/);
    assert.ok(hashFnMatch, '_checkHashForTemplate must remain defined');
    assert.ok(
        !/\bopenTemplateLibrary\s*\(/.test(hashFnMatch[0]),
        '_checkHashForTemplate must not auto-open Template Library on normal launch'
    );
    assert.ok(
        templatesSrc.includes('function openTemplateLibrary('),
        'Manual openTemplateLibrary() API must still exist'
    );

    // 2) Electron updater must NOT show blocking dialog.showMessageBox prompts for update notifications
    const dialogMatches = updaterSrc.match(/dialog\.showMessageBox\s*\(/g) || [];
    assert.strictEqual(
        dialogMatches.length,
        1,
        'Only prepareForUpdateRestart multi-window safety guard should keep dialog.showMessageBox'
    );
    const prepareGuardMatch = updaterSrc.match(/async function prepareForUpdateRestart\(\)\s*\{[\s\S]*?\n\}/);
    assert.ok(prepareGuardMatch && prepareGuardMatch[0].includes('dialog.showMessageBox('), 'Safety guard inside prepareForUpdateRestart must remain');
    assert.strictEqual(
        (updaterSrc.match(/catch \(error\) \{\s*return \{ success: false, error: error\?\.message/g) || []).length,
        2,
        'Both portable and NSIS install-update handlers must return structured failure objects'
    );

    // 3) CSS defines fixed top-right corner update toast styling + light mode support
    assert.ok(cssSrc.includes('.vk-update-toast {'), 'styles.css must define .vk-update-toast');
    assert.ok(cssSrc.includes('top: calc(var(--window-chrome-height, 38px) + 10px);'), 'Update toast must dock cleanly below top titlebar');
    assert.ok(cssSrc.includes('body.theme-light .vk-update-toast {'), 'styles.css must theme update toast for light mode');

    // 4) Runtime behavior of top-right corner update toast helper in sandboxed VM
    const escMatch = appSrc.match(/function escapeHtml\(str\)\s*\{[\s\S]*?\n\}/);
    const helperMatch = appSrc.match(/const _appUpdateUiState = \{[\s\S]*?async function _installDownloadedAppUpdate\(\)\s*\{[\s\S]*?\n\}/);
    assert.ok(escMatch && helperMatch, 'Renderer corner update toast helpers must be present in src/app.js');

    const created = new Map();
    const makeClassList = () => {
        const set = new Set();
        return {
            add: (...cls) => cls.forEach((c) => set.add(c)),
            remove: (...cls) => cls.forEach((c) => set.delete(c)),
            contains: (c) => set.has(c),
        };
    };
    const makeElement = (tag) => {
        const attrs = {};
        const cl = makeClassList();
        const el = {
            tagName: tag.toUpperCase(),
            id: '',
            className: '',
            classList: cl,
            dataset: {},
            innerHTML: '',
            setAttribute: (k, v) => { attrs[k] = String(v); },
            getAttribute: (k) => attrs[k] || null,
            querySelectorAll: () => [],
            querySelector: () => null,
        };
        return el;
    };

    const sandbox = {
        requestAnimationFrame: (fn) => fn(),
        window: { electronAPI: { downloadUpdate: async () => ({ success: true }), installUpdate: async () => ({ success: true }) } },
        document: {
            body: {
                appendChild(el) {
                    if (el.id) created.set(el.id, el);
                },
            },
            getElementById(id) {
                return created.get(id) || null;
            },
            createElement: makeElement,
            querySelector: () => null,
        },
        showToast: () => {},
    };
    vm.runInNewContext(
        `${escMatch[0]}\n${helperMatch[0]}\nthis._handleAppUpdateStatusEvent = _handleAppUpdateStatusEvent;\nthis._dismissUpdateCornerToast = _dismissUpdateCornerToast;\nthis._appUpdateUiState = _appUpdateUiState;`,
        sandbox
    );

    // Silent background checking / error should NOT create or show corner toast
    sandbox._handleAppUpdateStatusEvent({ status: 'checking' });
    sandbox._handleAppUpdateStatusEvent({ status: 'error', message: 'offline timeout' });
    assert.strictEqual(created.get('vk-update-toast'), undefined, 'Background checking/error must stay silent in corner toast');

    // Available update surfaces corner toast and escapes XSS payloads
    sandbox._handleAppUpdateStatusEvent({
        status: 'available',
        version: '4.6.0<img src=x onerror=alert(1)>',
        releaseNotes: '<script>evil()</script>优化速度',
        zipSize: 52428800,
    });
    const toast = created.get('vk-update-toast');
    assert.ok(toast, 'Available update must create #vk-update-toast');
    assert.ok(toast.classList.contains('is-visible'), 'Available update must show #vk-update-toast');
    assert.ok(!toast.innerHTML.includes('<script>'), 'Release notes must be HTML-escaped');
    assert.ok(!toast.innerHTML.includes('<img src=x'), 'Version string must be HTML-escaped');
    assert.ok(toast.innerHTML.includes('50.0 MB'), 'Portable download size should format cleanly');

    // Dismissing hides toast and mutes repeated background notification for the same version
    sandbox._dismissUpdateCornerToast(true);
    assert.ok(!toast.classList.contains('is-visible'), 'Dismissing must hide toast');
    sandbox._handleAppUpdateStatusEvent({ status: 'available', version: '4.6.0<img src=x onerror=alert(1)>' });
    assert.ok(!toast.classList.contains('is-visible'), 'Dismissed version should not re-open automatically');

    // Downloaded update resurfaces toast with restart action
    sandbox._handleAppUpdateStatusEvent({ status: 'downloaded', version: '4.6.0' });
    assert.ok(toast.classList.contains('is-visible'), 'Downloaded state must surface corner toast');
    assert.strictEqual(toast.dataset.status, 'downloaded');
    assert.ok(toast.innerHTML.includes('立即重启安装'), 'Downloaded toast must offer restart-and-install button');

    // Up-to-date closes any visible toast
    sandbox._handleAppUpdateStatusEvent({ status: 'up-to-date' });
    assert.ok(!toast.classList.contains('is-visible'), 'up-to-date should hide toast');
});

test('Mixed color-space auto-edit clips do not truncate Reels exports via mid-stream filtergraph reconfig', async (t) => {
    const os = require('node:os');
    const { spawnSync } = require('node:child_process');
    const ffmpegService = require('../electron/services/ffmpeg');
    const rawvideo = require('../electron/services/ffmpeg-rawvideo');
    const autoEditSrc = fs.readFileSync(path.join(ROOT, 'electron/services/autoEdit.js'), 'utf8');
    const rawvideoSrc = fs.readFileSync(path.join(ROOT, 'electron/services/ffmpeg-rawvideo.js'), 'utf8');
    const ffmpegSrc = fs.readFileSync(path.join(ROOT, 'electron/services/ffmpeg.js'), 'utf8');

    assert.deepEqual(rawvideo.videoInputStabilizeArgs(path.join(os.tmpdir(), 'auto_edit.mp4')), ['-reinit_filter', '0']);
    assert.deepEqual(rawvideo.videoInputStabilizeArgs(path.join(os.tmpdir(), 'poster.png')), []);
    assert.deepEqual(rawvideo.videoInputStabilizeArgs(path.join(os.tmpdir(), 'overlay.gif')), []);
    assert.ok(rawvideoSrc.includes('videoInputStabilizeArgs('), 'ffmpeg-rawvideo must pass videoInputStabilizeArgs before decoded video inputs');
    assert.ok(ffmpegSrc.includes("'-reinit_filter', '0'"), 'ffmpeg.js composeReel/concat normalization must keep filtergraphs stable across mid-stream metadata switches');
    assert.ok(autoEditSrc.includes('STANDARD_BT709_ENCODER_ARGS'), 'autoEdit.js must stamp uniform BT.709 color tags onto every cut segment');

    const ffmpegBin = ffmpegService.resolveCommand('ffmpeg');
    const ffprobeBin = ffmpegService.resolveCommand('ffprobe');
    if (spawnSync(ffmpegBin, ['-version'], { encoding: 'utf8' }).status !== 0) {
        return t.skip('ffmpeg binary unavailable in test environment');
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk_colorspace_trunc_'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const clipA = path.join(tmpDir, 'clip_smpte170m.mp4');
    const clipB = path.join(tmpDir, 'clip_bt709.mp4');
    const mixedLegacy = path.join(tmpDir, 'legacy_mixed.mp4');
    const normalizedOut = path.join(tmpDir, 'concat_normalized.mp4');

    const mkClip = (outPath, colorArgs) => {
        const res = spawnSync(ffmpegBin, [
            '-y',
            '-f', 'lavfi', '-i', 'color=c=navy:s=360x640:r=30:d=2',
            '-f', 'lavfi', '-i', 'anullsrc=cl=stereo:r=48000:d=2',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
            ...colorArgs,
            '-video_track_timescale', '90000',
            '-c:a', 'aac', '-shortest',
            outPath,
        ], { encoding: 'utf8' });
        assert.equal(res.status, 0, `failed to synthesize test clip ${path.basename(outPath)}: ${res.stderr}`);
    };

    mkClip(clipA, ['-color_range', 'tv', '-colorspace', 'smpte170m', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1']);
    mkClip(clipB, ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']);

    const mismatch = await ffmpegService.hasConcatStreamMismatch([clipA, clipB]);
    assert.equal(mismatch.mismatched, true, 'hasConcatStreamMismatch must detect smpte170m vs bt709 clips');

    // Create a legacy mixed-color MP4 via stream copy (simulates pre-fix auto-edit output)
    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listFile, [clipA, clipB].map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const concatRes = spawnSync(ffmpegBin, [
        '-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', mixedLegacy,
    ], { encoding: 'utf8' });
    assert.equal(concatRes.status, 0, concatRes.stderr);

    // Control without -reinit_filter 0 truncates at the color switch boundary (~2s / <=70 frames)
    const truncatedOut = path.join(tmpDir, 'truncated_overlay.mp4');
    const bgFilter = rawvideo._test.normalizedDirectBackgroundFilter(
        0,
        'scale=360:640:force_original_aspect_ratio=increase,crop=360:640,setsar=1',
        'setpts=PTS-STARTPTS',
        30,
        'bg',
        5,
        mixedLegacy
    );
    const graphArgs = [
        '-f', 'lavfi', '-i', 'color=c=black@0.0:s=360x640:r=30:d=4,format=rgba',
        '-filter_complex', `${bgFilter};[1:v]settb=1/30,setpts=N[fg];[bg][fg]overlay=0:0:format=auto:shortest=1,fps=30,format=yuv420p[outv]`,
        '-map', '[outv]', '-c:v', 'libx264', '-preset', 'ultrafast', '-frames:v', '120',
    ];
    const unstabilizedRes = spawnSync(ffmpegBin, [
        '-y', '-v', 'info', '-fflags', '+genpts', '-i', mixedLegacy, ...graphArgs, truncatedOut,
    ], { encoding: 'utf8' });
    assert.equal(unstabilizedRes.status, 0);
    assert.ok(unstabilizedRes.stderr.includes('Reconfiguring filter graph'), 'control run should trigger filtergraph reconfiguration on color switch');
    const unstabProbe = JSON.parse(spawnSync(ffprobeBin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames,duration', '-of', 'json', truncatedOut], { encoding: 'utf8' }).stdout);
    assert.ok(Number(unstabProbe.streams[0].nb_frames) <= 70, `expected unstabilized export to truncate near 60 frames, got ${unstabProbe.streams[0].nb_frames}`);

    // Consumer guarantee: -reinit_filter 0 keeps full ~4.0s (>=118 frames) when overlaying onto legacy mixed MP4
    const stabilizedOut = path.join(tmpDir, 'stabilized_overlay.mp4');
    const overlayRes = spawnSync(ffmpegBin, [
        '-y', '-v', 'info',
        ...rawvideo.videoInputStabilizeArgs(mixedLegacy), '-fflags', '+genpts', '-i', mixedLegacy, ...graphArgs, stabilizedOut,
    ], { encoding: 'utf8' });
    assert.equal(overlayRes.status, 0, overlayRes.stderr);
    assert.ok(!overlayRes.stderr.includes('Reconfiguring filter graph'), 'stabilized export must not reconfig filtergraph mid-stream');
    const stabProbe = JSON.parse(spawnSync(ffprobeBin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames,duration', '-of', 'json', stabilizedOut], { encoding: 'utf8' }).stdout);
    assert.ok(Number(stabProbe.streams[0].nb_frames) >= 118, `stabilized export must retain full ~4s (>=118 frames) across color switch, got ${stabProbe.streams[0].nb_frames}`);
    assert.ok(Number(stabProbe.streams[0].duration) >= 3.9, `stabilized export must retain full ~4s duration, got ${stabProbe.streams[0].duration}`);

    // Producer guarantee: concatClips auto-normalizes mismatched clips even with skipNormalization: true
    const concatFixed = await ffmpegService.concatClips({
        clips: [clipA, clipB],
        outputPath: normalizedOut,
        targetWidth: 360,
        targetHeight: 640,
        fps: 30,
        preset: 'ultrafast',
        skipNormalization: true,
    });
    assert.equal(concatFixed.success, true);
    assert.ok(concatFixed.duration >= 3.85, `auto-normalized concatClips duration=${concatFixed.duration}`);
    const frameColors = (JSON.parse(spawnSync(ffprobeBin, [
        '-v', 'error', '-select_streams', 'v:0', '-show_frames',
        '-show_entries', 'frame=color_space,color_transfer,color_primaries,color_range', '-of', 'json', normalizedOut,
    ], { encoding: 'utf8' }).stdout || '{}').frames || []).map(
        f => `${f.color_range}|${f.color_space}|${f.color_transfer}|${f.color_primaries}`
    );
    assert.deepEqual([...new Set(frameColors)], ['tv|bt709|bt709|bt709'], `expected uniform BT.709 frame color tags after concatClips`);
});

test('auto-edit and voiced_bg preview/export keep audible dialogue when bg volume is 0 and project lacks voiced_bg workMode', async () => {
    const batchReelsSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    const previewV2Src = fs.readFileSync(path.join(ROOT, 'src/reels-preview-v2.js'), 'utf8');
    const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    const rawvideoSrc = fs.readFileSync(path.join(ROOT, 'electron/services/ffmpeg-rawvideo.js'), 'utf8');

    // 1. HTML and V2 preview media elements declare crossorigin="anonymous" for WebAudio local-media routing
    for (const id of ['reels-preview-video', 'reels-preview-hook-video', 'reels-preview-contentvideo', 'reels-preview-audio']) {
        const re = new RegExp(`id="${id}"[^>]*crossorigin="anonymous"`, 'i');
        assert.match(indexHtmlSrc, re, `${id} must declare crossorigin="anonymous"`);
    }
    assert.match(previewV2Src, /data-role="bg-video"[^>]*crossorigin="anonymous"/i);
    assert.match(previewV2Src, /data-role="audio"[^>]*crossorigin="anonymous"/i);

    // 2. Project save/history snapshot persists workMode and project restore infers voiced_bg for auto-edit projects
    assert.ok(batchReelsSrc.includes('workMode: _getWorkMode(),'), 'batch-reels project state must save workMode');
    assert.ok(batchReelsSrc.includes('const inferredAutoEditMode = (!explicitWorkMode'), 'applyRestoredProject must infer voiced_bg for auto-edit tasks');
    assert.ok(batchReelsSrc.includes('function _hasTaskVoiceAudio(task, audioEl)'), 'batch-reels must define _hasTaskVoiceAudio');
    assert.ok(batchReelsSrc.includes('function _getEffectiveTaskVoiceDurScale(task, explicitBgPath, explicitWorkMode)'), 'batch-reels must define _getEffectiveTaskVoiceDurScale');
    assert.ok(batchReelsSrc.includes('const resolvedVoiceSource = voiceSource || (isAutoEditVoiceBg ? bgPath : null);'), 'reelsStartBatch must pass resolvedVoiceSource for auto-edit tasks even in default srt mode');

    // 3. Execute real batch-reels helper logic inside VM to verify volume & bgAsVoice resolution
    const extractFn = (name) => {
        const start = batchReelsSrc.indexOf(`function ${name}(`);
        assert.ok(start >= 0, `expected ${name} in batch-reels.js`);
        const sigEnd = batchReelsSrc.indexOf(') {', start);
        assert.ok(sigEnd >= 0, `expected ) { for ${name}`);
        const openBrace = sigEnd + 2;
        let depth = 0;
        for (let i = openBrace; i < batchReelsSrc.length; i++) {
            if (batchReelsSrc[i] === '{') depth++;
            else if (batchReelsSrc[i] === '}') {
                depth--;
                if (depth === 0) return batchReelsSrc.slice(start, i + 1);
            }
        }
        throw new Error(`unclosed function ${name}`);
    };
    const domValues = new Map([
        ['reels-work-mode', { value: 'srt' }],
        ['reels-voice-volume', { value: '100' }],
        ['reels-bg-volume', { value: '0' }],
    ]);
    const helperCtx = {
        window: {},
        document: { getElementById: (id) => domValues.get(id) || null },
        _reelsState: { tasks: [], selectedIdx: 0 },
        _getSelectedTask: () => helperCtx._reelsState.tasks[helperCtx._reelsState.selectedIdx] || null,
        _resolvePreviewBackgroundPath: (task) => ({ path: (task && (task.bgPath || task.videoPath)) || '', isMulti: task?.bgMode === 'multi' }),
        _isImagePath: (p) => /\.(png|jpe?g|webp|bmp)$/i.test(String(p || '')),
        _getGlobalVoiceVolumePercent: () => parseFloat(domValues.get('reels-voice-volume').value),
        _getGlobalBgVolumePercent: () => parseFloat(domValues.get('reels-bg-volume').value),
    };
    vm.createContext(helperCtx);
    const fnNames = [
        '_getWorkMode',
        '_getEffectiveBgClipPool',
        '_getEffectiveBgVolumePercent',
        '_getEffectiveVoiceVolumePercent',
        '_isSingleAutoEditTask',
        '_isTaskUsingBgAsVoice',
        '_getEffectiveTaskVoiceDurScale',
        '_resolveTaskVoiceVolumePercent',
    ];
    vm.runInContext(fnNames.map(extractFn).join('\n'), helperCtx);

    const os = require('node:os');
    const autoEditTask = {
        _autoEditSource: true,
        alignSource: 'auto_edit',
        audioPath: '',
        bgPath: path.join(os.tmpdir(), 'auto_edit_sample.mp4'),
        bgDurScale: 115,
    };
    assert.equal(helperCtx._isTaskUsingBgAsVoice(autoEditTask), true, 'auto-edit task without audioPath uses bg as voice even when workMode is srt');
    assert.equal(helperCtx._resolveTaskVoiceVolumePercent(autoEditTask), 100, 'auto-edit task uses voice volume (100) even when global bg volume is 0');
    assert.equal(helperCtx._getEffectiveTaskVoiceDurScale(autoEditTask), 115, 'auto-edit task uses bgDurScale for voice playbackRate');

    const regularSrtBrollTask = { audioPath: '', bgPath: path.join(os.tmpdir(), 'broll.mp4') };
    assert.equal(helperCtx._isTaskUsingBgAsVoice(regularSrtBrollTask), false, 'regular B-roll in srt mode does not become voice');

    domValues.get('reels-work-mode').value = 'voiced_bg';
    const voicedBgTask = { audioPath: '', bgPath: path.join(os.tmpdir(), 'voiced.mp4') };
    assert.equal(helperCtx._resolveTaskVoiceVolumePercent(voicedBgTask), 100, 'voiced_bg task falls back to voice volume when global bg volume is 0 and task is not muted');
    assert.equal(helperCtx._resolveTaskVoiceVolumePercent({ ...voicedBgTask, bgVideoVolume: 0 }), 0, 'explicit task bgVideoVolume=0 stays muted');
    domValues.get('reels-bg-volume').value = '65';
    assert.equal(helperCtx._resolveTaskVoiceVolumePercent(voicedBgTask), 65, 'voiced_bg task uses non-zero global bg volume');

    const sampleClip = path.join(os.tmpdir(), 'clip_a.mp4');
    const multiClipTask = { audioPath: '', bgMode: 'multi', bgClipPool: [sampleClip], bgPath: sampleClip };
    assert.equal(helperCtx._isTaskUsingBgAsVoice(multiClipTask), false, 'multi-clip task does not alias single bgPath as voice');

    // 4. Preview V2 runtime safety guards
    assert.ok(previewV2Src.includes('const gainNode = routed && state.mediaSources.has(media) && state.gainNodes.get(media);'), 'V2 applyVolume must verify mediaSources.has(media)');
    assert.ok(previewV2Src.includes('function resolvedVoicedBgVolume(task)'), 'V2 must resolve voiced_bg/auto-edit volume on bgVideo');
    assert.ok(previewV2Src.includes('if (state.audioCtx && state.audioCtx.state === \'suspended\')'), 'V2 must resume suspended AudioContext');

    // 5. ffmpeg-rawvideo mixAudio source & real FFmpeg behavior test
    assert.ok(rawvideoSrc.includes('voiceVolume = typeof voiceVolume === \'number\' ? voiceVolume : 1.0;'), 'renderAudio voice output must preserve configured voiceVolume');
    assert.ok(rawvideoSrc.includes('if (renderedBgAudio && wantBgAudio)'), 'rawvideo !voicePath branch must not mix renderedBgAudio at volume 0');
    assert.ok(rawvideoSrc.includes('if (renderedBgAudio && bgVolumeVal2 > 0.001)'), 'rawvideo voicePath branch must guard renderedBgAudio with bgVolumeVal2 > 0.001');

    const rawvideo = require('../electron/services/ffmpeg-rawvideo');
    const ffmpegService = require('../electron/services/ffmpeg');
    const ffmpegBin = ffmpegService.resolveCommand('ffmpeg');
    const { spawnSync } = require('node:child_process');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-audio-reg-'));
    try {
        const tempVideo = path.join(tmpDir, 'video_only.mp4');
        const tempVideo2 = path.join(tmpDir, 'video_only_2.mp4');
        const audibleBg = path.join(tmpDir, 'audible_bg.mp4');
        const renderedWav = path.join(tmpDir, 'rendered_voice.wav');
        const outAudible = path.join(tmpDir, 'out_audible.mp4');
        const outSilentSkipped = path.join(tmpDir, 'out_no_silent_bg.mp4');

        let r = spawnSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1.2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', tempVideo], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        fs.copyFileSync(tempVideo, tempVideo2);
        r = spawnSync(ffmpegBin, [
            '-y',
            '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:d=1.2',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', audibleBg,
        ], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        r = spawnSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-c:a', 'pcm_s16le', renderedWav], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);

        const renderCalls = [];
        rawvideo.configureExportRuntime({
            renderAudio: async (opts) => {
                renderCalls.push(opts);
                const copyWav = path.join(tmpDir, `render_${renderCalls.length}.wav`);
                fs.copyFileSync(renderedWav, copyWav);
                return copyWav;
            },
        });

        await rawvideo._test.mixAudio({
            tempVideo,
            outputPath: outAudible,
            voicePath: audibleBg,
            backgroundPath: audibleBg,
            voiceVolume: 1.0,
            bgVolume: 0,
            bgHasAudio: false,
            bgmVolume: 0,
            reverbEnabled: true,
            reverbPreset: 'hall',
            reverbMix: 15,
            stereoWidth: 100,
            audioFxTarget: 'all',
            duration: 1.2,
            outputDuration: 1.2,
        });
        assert.equal(renderCalls.length, 1, 'auto-edit session with voicePath + reverb renders voice once');

        const volDetect = spawnSync(ffmpegBin, ['-i', outAudible, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
        const meanMatch = volDetect.stderr.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/);
        assert.ok(meanMatch, `expected volumedetect output, got: ${volDetect.stderr}`);
        assert.ok(parseFloat(meanMatch[1]) > -30, `exported voice audio must be audible (> -30 dB), got ${meanMatch[1]} dB`);

        renderCalls.length = 0;
        await rawvideo._test.mixAudio({
            tempVideo: tempVideo2,
            outputPath: outSilentSkipped,
            voicePath: null,
            backgroundPath: audibleBg,
            voiceVolume: 1.0,
            bgVolume: 0,
            bgHasAudio: false,
            bgmVolume: 0,
            reverbEnabled: true,
            audioFxTarget: 'all',
            duration: 1.2,
            outputDuration: 1.2,
        });
        assert.equal(renderCalls.length, 0, 'muted bg (bgVolume=0) without voicePath must not run renderAudio on backgroundPath');
    } finally {
        rawvideo.configureExportRuntime({ renderAudio: null });
        await require('../resources/export-cpu-budget').close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Cloudflare Hub Worker handles KV binding guard, token auth, and round-trips keys and daily projects with cloud-hub service', async () => {
    const cloudHub = require('../electron/services/cloud-hub');
    const settingsService = require('../electron/services/settings');
    const os = require('node:os');

    const workerSrc = cloudHub.getWorkerTemplateCode();
    assert.ok(workerSrc.includes('export default'), 'Worker template must export default fetch handler');

    // Load ES module Worker cleanly using dynamic import data URL
    const dataUrl = `data:text/javascript;base64,${Buffer.from(workerSrc, 'utf8').toString('base64')}`;
    const workerMod = await import(dataUrl);
    const worker = workerMod.default;
    assert.equal(typeof worker?.fetch, 'function');

    // 1. Unbound HUB_KV must refuse writes with HTTP 503 and surface kv_bound: false on GET
    const unboundGetRes = await worker.fetch(new Request('https://hub.example.workers.dev/?format=json'), {});
    assert.equal(unboundGetRes.status, 200);
    const unboundGetJson = await unboundGetRes.json();
    assert.equal(unboundGetJson.kv_bound, false);

    const unboundPostRes = await worker.fetch(new Request('https://hub.example.workers.dev/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groq_keys: ['gsk_test'] }),
    }), {});
    assert.equal(unboundPostRes.status, 503);
    const unboundPostJson = await unboundPostRes.json();
    assert.equal(unboundPostJson.ok, false);
    assert.equal(unboundPostJson.kv_bound, false);

    // 2. HTML Admin page serves without JSON auth barrier and includes escaping + KV check UI
    const htmlRes = await worker.fetch(new Request('https://hub.example.workers.dev/', {
        headers: { Accept: 'text/html' },
    }), { HUB_TOKEN: 'team-secret' });
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('VideoKit 云端中控台') && html.includes('gemini_tts_keys') && html.includes('kv-warning'));

    // 3. Full authenticated round-trip using in-memory KV + isolated fake settings store
    const kvMap = new Map();
    const env = {
        HUB_TOKEN: 'team-secret',
        HUB_KV: {
            get: async (k) => kvMap.get(k) ?? null,
            put: async (k, v) => { kvMap.set(k, String(v)); },
        },
    };

    const unauthRes = await worker.fetch(new Request('https://hub.example.workers.dev/?format=json'), env);
    assert.equal(unauthRes.status, 401);

    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cloudhub-e2e-'));
    const fakeState = {
        transcription: { primary: 'groq', providers: { groq: { keys: ['gsk_push_1', 'gsk_push_2'] }, gladia: { keys: ['gl_1'] }, deepgram: { keys: [] } } },
        gemini: { keys: ['AIza_1'], tts_keys: ['AIza_tts_1'], model: 'gemini-3.5-flash-lite', prompt: '' },
        elevenlabs: { api_keys: ['sk_el_1'] },
    };

    const settingsResolved = require.resolve('../electron/services/settings');
    const cloudHubResolved = require.resolve('../electron/services/cloud-hub');
    const origMethods = {
        getBackendDir: settingsService.getBackendDir,
        loadTranscriptionProviders: settingsService.loadTranscriptionProviders,
        saveTranscriptionProviders: settingsService.saveTranscriptionProviders,
        loadGeminiKeys: settingsService.loadGeminiKeys,
        saveGeminiKeys: settingsService.saveGeminiKeys,
        loadElevenLabsSettings: settingsService.loadElevenLabsSettings,
        saveElevenLabsSettings: settingsService.saveElevenLabsSettings,
    };
    const origFetch = globalThis.fetch;

    try {
        settingsService.getBackendDir = () => storeDir;
        settingsService.loadTranscriptionProviders = () => JSON.parse(JSON.stringify(fakeState.transcription));
        settingsService.saveTranscriptionProviders = (inp) => {
            fakeState.transcription = {
                primary: inp.primary || fakeState.transcription.primary,
                providers: {
                    groq: { keys: [...(inp.groq_keys || [])] },
                    gladia: { keys: [...(inp.gladia_keys || [])] },
                    deepgram: { keys: [...(inp.deepgram_keys || [])] },
                },
            };
        };
        settingsService.loadGeminiKeys = () => JSON.parse(JSON.stringify(fakeState.gemini));
        settingsService.saveGeminiKeys = (inp) => {
            fakeState.gemini = { ...fakeState.gemini, ...inp };
        };
        settingsService.loadElevenLabsSettings = () => JSON.parse(JSON.stringify(fakeState.elevenlabs));
        settingsService.saveElevenLabsSettings = (inp) => {
            fakeState.elevenlabs = { api_keys: [...(inp.api_keys || [])] };
        };
        delete require.cache[cloudHubResolved];
        const isolatedHub = require('../electron/services/cloud-hub');

        globalThis.fetch = async (url, init = {}) => {
            return await worker.fetch(new Request(String(url), init), env);
        };

        const pushRes = await isolatedHub.pushToCloudHub({
            hub_url: 'https://hub.example.workers.dev',
            access_token: 'team-secret',
            action: 'push_local_all',
        });
        assert.equal(pushRes.ok, true);

        const addRes = await isolatedHub.pushToCloudHub({
            action: 'add_daily_project',
            project: {
                date: '2026-11-13',
                title: '11月13日祷告任务',
                url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/view',
                note: '测试备注',
            },
        });
        assert.equal(addRes.ok, true);

        // Wipe local keys, then pull fresh from Worker via syncFromCloudHub
        fakeState.transcription.providers = { groq: { keys: [] }, gladia: { keys: [] }, deepgram: { keys: [] } };
        fakeState.gemini.keys = [];
        fakeState.gemini.tts_keys = [];
        fakeState.elevenlabs.api_keys = [];

        const syncRes = await isolatedHub.syncFromCloudHub({
            hub_url: 'https://hub.example.workers.dev',
            access_token: 'team-secret',
            sync_mode: 'overwrite',
        });
        assert.equal(syncRes.ok, true);
        assert.deepEqual(fakeState.transcription.providers.groq.keys, ['gsk_push_1', 'gsk_push_2']);
        assert.deepEqual(fakeState.transcription.providers.gladia.keys, ['gl_1']);
        assert.deepEqual(fakeState.gemini.keys, ['AIza_1']);
        assert.deepEqual(fakeState.gemini.tts_keys, ['AIza_tts_1']);
        assert.deepEqual(fakeState.elevenlabs.api_keys, ['sk_el_1']);
        assert.equal(syncRes.settings.daily_projects.length, 1);
        assert.equal(syncRes.settings.daily_projects[0].title, '11月13日祷告任务');

        const projId = syncRes.settings.daily_projects[0].id;
        const delRes = await isolatedHub.pushToCloudHub({
            action: 'delete_daily_project',
            id: projId,
        });
        assert.equal(delRes.ok, true);
        const syncAfterDel = await isolatedHub.syncFromCloudHub({ sync_mode: 'overwrite' });
        assert.equal(syncAfterDel.settings.daily_projects.length, 0);
    } finally {
        globalThis.fetch = origFetch;
        Object.assign(settingsService, origMethods);
        delete require.cache[cloudHubResolved];
        require.cache[settingsResolved].exports = settingsService;
        fs.rmSync(storeDir, { recursive: true, force: true });
    }
});

test('Simple Cloudflare Worker template and single Google Drive folder/project URL sync end-to-end', async () => {
    const os = require('node:os');
    const vm = require('node:vm');
    const settingsService = require('../electron/services/settings');
    const cloudHub = require('../electron/services/cloud-hub');

    // 1. Verify simple worker template load & execution with zero KV setup
    const simpleSrc = cloudHub.getWorkerTemplateCode('simple');
    const kvSrc = cloudHub.getWorkerTemplateCode('kv');
    assert.ok(simpleSrc.includes('google_drive_url') && simpleSrc.includes('groq_keys'));
    assert.ok(kvSrc.includes('HUB_KV'));

    const simpleWorker = vm.runInNewContext(
        simpleSrc.replace(/export\s+default\s+\{/, 'module.exports = {'),
        { module: { exports: {} }, Response, URL }
    );
    const defaultResp = await simpleWorker.fetch(new Request('https://simple.example.workers.dev/'), {});
    assert.equal(defaultResp.status, 200);
    const defaultJson = await defaultResp.json();
    assert.ok(Array.isArray(defaultJson.groq_keys) && typeof defaultJson.google_drive_url === 'string');

    // Verify URL extractors for Google Drive folders & Docs
    assert.equal(
        cloudHub.extractGoogleDriveFolderId('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrSt?usp=sharing'),
        '1AbCdEfGhIjKlMnOpQrSt'
    );
    assert.equal(
        cloudHub.extractGoogleDriveFileId('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrSt?usp=sharing'),
        null
    );
    assert.equal(
        cloudHub.resolveCloudDownloadUrl('https://docs.google.com/document/d/1DocId1234567890AbC/edit'),
        'https://docs.google.com/document/d/1DocId1234567890AbC/export?format=txt'
    );

    // 2. End-to-end sync using simple Worker payload with keys + ONE Google Drive folder URL
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-simplehub-'));
    const matDir = path.join(storeDir, 'materials');
    const pkgSub1 = path.join(matDir, '103_task', '人声音频');
    const pkgSub2 = path.join(matDir, '127_task', '人声音频');
    const wmSub = path.join(matDir, '103_task', '覆层素材');
    fs.mkdirSync(pkgSub1, { recursive: true });
    fs.mkdirSync(pkgSub2, { recursive: true });
    fs.mkdirSync(wmSub, { recursive: true });
    const fakeClipPath = path.join(matDir, 'sermon_cut_01.mp4');
    const dupVoice1 = path.join(pkgSub1, 'shared_voice.mp3');
    const dupVoice2 = path.join(pkgSub2, 'shared_voice.mp3');
    const timelineExtraClip = path.join(matDir, 'broll_timeline.mp4');
    const wmImgPath = path.join(wmSub, 'brand_logo.png');
    fs.writeFileSync(fakeClipPath, 'video');
    fs.writeFileSync(dupVoice1, 'voice-103');
    fs.writeFileSync(dupVoice2, 'voice-127');
    fs.writeFileSync(timelineExtraClip, 'broll');
    fs.writeFileSync(wmImgPath, 'png');

    const settingsResolved = require.resolve('../electron/services/settings');
    const cloudHubResolved = require.resolve('../electron/services/cloud-hub');
    const fakeState = {
        transcription: { primary: 'groq', providers: { groq: { keys: [] }, gladia: { keys: [] }, deepgram: { keys: [] } } },
        gemini: { keys: [], tts_keys: [], model: 'gemini-3.5-flash-lite', prompt: '' },
        elevenlabs: { api_keys: [] },
    };
    const origMethods = {
        getBackendDir: settingsService.getBackendDir,
        loadTranscriptionProviders: settingsService.loadTranscriptionProviders,
        saveTranscriptionProviders: settingsService.saveTranscriptionProviders,
        loadGeminiKeys: settingsService.loadGeminiKeys,
        saveGeminiKeys: settingsService.saveGeminiKeys,
        loadElevenLabsSettings: settingsService.loadElevenLabsSettings,
        saveElevenLabsSettings: settingsService.saveElevenLabsSettings,
    };
    const origFetch = globalThis.fetch;

    const rootFolderHtml = `
      <div class="flip-entry" id="entry-1ProjFileRoot12345">
        <a href="https://drive.google.com/file/d/1ProjFileRoot12345/view?usp=drivesdk">
          <div class="flip-entry-title">2026-11-13_今日主日工程.reels-project.json</div>
          <div class="flip-entry-last-modified">Nov 13, 2026</div>
        </a>
      </div>
      <div class="flip-entry" id="entry-1RawMediaIgnored12">
        <a href="https://drive.google.com/file/d/1RawMediaIgnored12/view?usp=drivesdk">
          <div class="flip-entry-title">sermon_cut_01.mp4</div>
        </a>
      </div>
      <div class="flip-entry" id="entry-1SubFolderNov12345">
        <a href="https://drive.google.com/drive/folders/1SubFolderNov12345?usp=drivesdk">
          <div class="flip-entry-title">2026-11-12</div>
        </a>
      </div>`;
    const subFolderHtml = `
      <div class="flip-entry" id="entry-1ProjFileSub123456">
        <a href="https://drive.google.com/file/d/1ProjFileSub123456/view?usp=drivesdk">
          <div class="flip-entry-title">福音短片批量.json</div>
        </a>
      </div>
      <div class="flip-entry" id="entry-1ManifestIgnored12">
        <a href="https://drive.google.com/file/d/1ManifestIgnored12/view?usp=drivesdk">
          <div class="flip-entry-title">工程清单.json</div>
        </a>
      </div>`;
    const sampleReelsProject = {
        version: '2.0.0',
        style: { fontSize: 68, fontColor: '#ffffff' },
        exportOpts: { workMode: 'voiced_bg', voiceVolume: 100, bgVolume: 0 },
        watermarks: [{ type: 'image', imagePath: 'local-media:///Z:/missing/103_task/覆层素材/brand_logo.png', enabled: true }],
        tasks: [{
            baseName: 'sermon_cut_01',
            bgPath: path.join('D:', 'other_machine', 'sermon_cut_01.mp4'),
            audioPath: path.join('D:', 'other_machine', '127_task', '人声音频', 'shared_voice.mp3'),
            insertClips: [{ path: path.join('D:', 'other_machine', 'broll_timeline.mp4') }],
            introMedia: { path: path.join('D:', 'other_machine', 'sermon_cut_01.mp4') },
            timeline: {
                sources: { src1: { id: 'src1', path: path.join('D:', 'other_machine', 'broll_timeline.mp4') } },
                backgroundSegmentKey: path.join('D:', 'other_machine', 'sermon_cut_01.mp4') + '|0|5|0|5|1|0',
            },
            segments: [{ start: 0, end: 2.5, text: 'Test line' }],
        }],
    };

    try {
        settingsService.getBackendDir = () => storeDir;
        settingsService.loadTranscriptionProviders = () => JSON.parse(JSON.stringify(fakeState.transcription));
        settingsService.saveTranscriptionProviders = (inp) => {
            fakeState.transcription = {
                primary: inp.primary || 'groq',
                providers: {
                    groq: { keys: [...(inp.groq_keys || [])] },
                    gladia: { keys: [...(inp.gladia_keys || [])] },
                    deepgram: { keys: [...(inp.deepgram_keys || [])] },
                },
            };
        };
        settingsService.loadGeminiKeys = () => JSON.parse(JSON.stringify(fakeState.gemini));
        settingsService.saveGeminiKeys = (inp) => { fakeState.gemini = { ...fakeState.gemini, ...inp }; };
        settingsService.loadElevenLabsSettings = () => JSON.parse(JSON.stringify(fakeState.elevenlabs));
        settingsService.saveElevenLabsSettings = (inp) => { fakeState.elevenlabs = { api_keys: [...(inp.api_keys || [])] }; };

        delete require.cache[cloudHubResolved];
        const isolatedHub = require('../electron/services/cloud-hub');

        globalThis.fetch = async (url) => {
            const u = String(url);
            if (u.startsWith('https://simple.example.workers.dev')) {
                return new Response(JSON.stringify({
                    primary_transcription: 'groq',
                    groq_keys: ['gsk_simple_1'],
                    gemini_keys: ['AIza_simple_1'],
                    elevenlabs_keys: ['sk_simple_1'],
                    google_drive_url: 'https://drive.google.com/drive/folders/1RootFolder123456?usp=sharing',
                }), { headers: { 'Content-Type': 'application/json' } });
            }
            if (u.includes('embeddedfolderview?id=1RootFolder123456')) {
                return new Response(rootFolderHtml, { status: 200 });
            }
            if (u.includes('embeddedfolderview?id=1SubFolderNov12345')) {
                return new Response(subFolderHtml, { status: 200 });
            }
            if (u.includes('id=1ProjFileRoot12345')) {
                return new Response(JSON.stringify(sampleReelsProject), { status: 200 });
            }
            return new Response('not found', { status: 404 });
        };

        const syncRes = await isolatedHub.syncFromCloudHub({
            hub_url: 'https://simple.example.workers.dev',
            local_material_root: matDir,
        });
        assert.equal(syncRes.ok, true);
        assert.equal(syncRes.folder_warning, '');
        assert.deepEqual(fakeState.transcription.providers.groq.keys, ['gsk_simple_1']);
        assert.deepEqual(fakeState.gemini.keys, ['AIza_simple_1']);
        assert.deepEqual(fakeState.elevenlabs.api_keys, ['sk_simple_1']);
        assert.equal(syncRes.settings.single_google_drive_url, 'https://drive.google.com/drive/folders/1RootFolder123456?usp=sharing');
        assert.equal(syncRes.settings.daily_projects.length, 2, 'should ignore .mp4 media and list both .json projects across root and subfolder');
        assert.equal(syncRes.settings.daily_projects[0].date, '2026-11-13');
        assert.equal(syncRes.settings.daily_projects[1].date, '2026-11-12');

        // Direct folder URL in downloadCloudProject lists all editable projects rather than failing JSON parse
        const folderListRes = await isolatedHub.downloadCloudProject({
            url: 'https://drive.google.com/drive/folders/1RootFolder123456?usp=sharing',
        });
        assert.equal(folderListRes.status, 'folder_listed');
        assert.equal(folderListRes.projects.length, 2);

        // Downloading .reels-project.json preserves style, exportOpts, and relinks local media
        const dlRes = await isolatedHub.downloadCloudProject({
            url: syncRes.settings.daily_projects[0].url,
            title: syncRes.settings.daily_projects[0].title,
            local_material_root: matDir,
        });
        assert.equal(dlRes.status, 'success');
        assert.equal(dlRes.tasks_count, 1);
        assert.equal(dlRes.project.exportOpts.workMode, 'voiced_bg');
        assert.equal(dlRes.project.style.fontSize, 68);
        assert.equal(dlRes.project.tabs[0].tasks[0].bgPath, fakeClipPath);
        assert.equal(dlRes.project.tabs[0].tasks[0].audioPath, dupVoice2, 'suffix match should distinguish duplicate basenames across task folders');
        assert.equal(dlRes.project.tabs[0].tasks[0].insertClips[0].path, timelineExtraClip);
        assert.equal(dlRes.project.tabs[0].tasks[0].introMedia.path, fakeClipPath);
        assert.equal(dlRes.project.tabs[0].tasks[0].timeline.sources.src1.path, timelineExtraClip);
        assert.equal(dlRes.project.tabs[0].tasks[0].timeline.backgroundSegmentKey, `${fakeClipPath}|0|5|0|5|1|0`);
        assert.ok(dlRes.project.watermarks[0].imagePath.startsWith('local-media:///'));
        assert.ok(dlRes.project.watermarks[0].imagePath.endsWith(wmImgPath.replace(/\\/g, '/')));
        assert.equal(dlRes.project.tabs[0].tasks[0].subtitleStyle.fontSize, 68);
    } finally {
        globalThis.fetch = origFetch;
        Object.assign(settingsService, origMethods);
        delete require.cache[cloudHubResolved];
        require.cache[settingsResolved].exports = settingsService;
        fs.rmSync(storeDir, { recursive: true, force: true });
    }
});

test('Reels package-only and export-copy bundle regular batch tasks and remap paths', async () => {
    const os = require('node:os');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-packager-'));
    try {
        const srcMediaDir = path.join(tmpRoot, 'source-media');
        const outDir = path.join(tmpRoot, 'output-packages');
        fs.mkdirSync(srcMediaDir, { recursive: true });
        fs.mkdirSync(outDir, { recursive: true });

        const bgFile = path.join(srcMediaDir, 'bg_loop.mp4');
        const audioFile = path.join(srcMediaDir, 'voice_001.mp3');
        const srtFile = path.join(srcMediaDir, 'sub_001.srt');
        const bgmFile = path.join(srcMediaDir, 'bgm_calm.mp3');
        const overlayImg = path.join(srcMediaDir, 'sticker.png');
        const insertClip = path.join(srcMediaDir, 'broll.mp4');
        const missingAsset = path.join(srcMediaDir, 'deleted_later.png');
        fs.writeFileSync(bgFile, 'bg-video-bytes');
        fs.writeFileSync(audioFile, 'mp3-bytes');
        fs.writeFileSync(srtFile, '1\n00:00:00,000 --> 00:00:02,000\nHello world\n');
        fs.writeFileSync(bgmFile, 'bgm-bytes');
        fs.writeFileSync(overlayImg, 'png-bytes');
        fs.writeFileSync(insertClip, 'broll-bytes');

        const { packageReelsProject } = require(path.join(ROOT, 'electron/services/projectPackager.js'));
        const result = await packageReelsProject({
            sourceProjectDir: '',
            outputPath: path.join(outDir, '001_RegularTask.mp4'),
            scriptText: 'Hello world',
            taskAssets: [
                { role: 'background', path: bgFile },
                { role: 'background', path: bgFile }, // duplicate reference must copy only once
                { role: 'audio', path: audioFile },
                { role: 'subtitle', path: srtFile },
                { role: 'bgm', path: bgmFile },
                { role: 'media', path: insertClip },
                { role: 'overlay', path: overlayImg },
                { role: 'overlay', path: missingAsset },
            ],
            reelsProjectData: {
                version: '2.0.0',
                app: 'VideoKit',
                watermarks: [{ type: 'image', imagePath: overlayImg }],
                tasks: [
                    {
                        id: 'task_regular_1',
                        baseName: '001_RegularTask',
                        bgPath: bgFile,
                        videoPath: bgFile,
                        bgSrcUrl: 'file:///C:/stale/bg_loop.mp4',
                        srcUrl: 'file:///C:/stale/bg_loop.mp4',
                        audioPath: audioFile,
                        srtPath: srtFile,
                        bgmPath: bgmFile,
                        insertClips: [{ id: 'ins_1', path: insertClip }],
                        overlays: [
                            { type: 'image', src: overlayImg },
                            { type: 'text', content: 'Keep plain text content untouched' },
                        ],
                    },
                ],
            },
        });

        assert.equal(result.ok, true);
        assert.equal(result.copiedCount, 6);
        assert.equal(result.missing.length, 1);
        assert.equal(result.missing[0].path, missingAsset);

        const pkgDir = result.projectDir;
        assert.equal(fs.existsSync(path.join(pkgDir, '背景素材', 'bg_loop.mp4')), true);
        assert.equal(fs.existsSync(path.join(pkgDir, '背景素材', 'bg_loop_2.mp4')), false);
        assert.equal(fs.existsSync(path.join(pkgDir, '人声音频', 'voice_001.mp3')), true);
        assert.equal(fs.existsSync(path.join(pkgDir, '字幕', 'sub_001.srt')), true);
        assert.equal(fs.existsSync(path.join(pkgDir, '背景音乐', 'bgm_calm.mp3')), true);
        assert.equal(fs.existsSync(path.join(pkgDir, '辅助素材', 'broll.mp4')), true);
        assert.equal(fs.existsSync(path.join(pkgDir, '覆层素材', 'sticker.png')), true);
        assert.equal(fs.existsSync(path.join(pkgDir, '文案.txt')), true);
        assert.equal(fs.existsSync(path.join(pkgDir, '工程清单.json')), true);

        const savedProject = JSON.parse(fs.readFileSync(result.projectJsonPath, 'utf8'));
        const savedTask = savedProject.tasks[0];
        assert.equal(savedTask.bgPath, path.join(pkgDir, '背景素材', 'bg_loop.mp4'));
        assert.equal(savedTask.videoPath, path.join(pkgDir, '背景素材', 'bg_loop.mp4'));
        assert.equal(savedTask.bgSrcUrl, undefined);
        assert.equal(savedTask.srcUrl, undefined);
        assert.equal(savedTask.audioPath, path.join(pkgDir, '人声音频', 'voice_001.mp3'));
        assert.equal(savedTask.srtPath, path.join(pkgDir, '字幕', 'sub_001.srt'));
        assert.equal(savedTask.insertClips[0].path, path.join(pkgDir, '辅助素材', 'broll.mp4'));
        assert.equal(savedTask.overlays[0].src, path.join(pkgDir, '覆层素材', 'sticker.png'));
        assert.equal(savedTask.overlays[1].content, 'Keep plain text content untouched');
        assert.equal(savedProject.watermarks[0].imagePath, path.join(pkgDir, '覆层素材', 'sticker.png'));

        // Verify button ID & batch packaging wiring in HTML + batch-reels.js + main.js
        const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
        assert.match(html, /id="reels-package-project-btn"[^>]*onclick="reelsPackageSelectedProjects\(\)"/);
        assert.doesNotMatch(html, /id="reels-package-project-btn"[^>]*onclick="reelsSelectOutputDir\(\)"/);

        const batchJs = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
        assert.doesNotMatch(batchJs, /filter\(task\s*=>\s*task\._exportSelected\s*!==\s*false\s*&&\s*task\.autoEditProject\)/);
        assert.match(batchJs, /function _collectReelsTaskMediaAssets\(task\)/);
        assert.match(batchJs, /if \(copyProjectToOutput && doMp4\)/);
        assert.match(batchJs, /批量工程_\$\{packedTasks\.length\}个任务\.json/);

        const mainJs = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
        assert.match(mainJs, /handleTrusted\('copy-reels-project-package'[\s\S]*?projectPackager/);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});


test('Tab small-groups, grouped batch packaging subfolders, and multi-group restore round-trip', async () => {
    const os = require('node:os');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-tabgroup-pkg-'));
    const writtenFiles = new Map();
    const { packageReelsProject } = require(path.join(ROOT, 'electron/services/projectPackager.js'));

    try {
        const srcMedia = path.join(tmpRoot, 'source');
        const outBase = path.join(tmpRoot, 'out');
        fs.mkdirSync(srcMedia, { recursive: true });
        fs.mkdirSync(outBase, { recursive: true });

        const bg1 = path.join(srcMedia, 'bg1.mp4');
        const bg2 = path.join(srcMedia, 'bg2.mp4');
        const bg3 = path.join(srcMedia, 'bg3.mp4');
        const v1 = path.join(srcMedia, 'v1.mp3');
        const v2 = path.join(srcMedia, 'v2.mp3');
        const v3 = path.join(srcMedia, 'v3.mp3');
        for (const f of [bg1, bg2, bg3, v1, v2, v3]) fs.writeFileSync(f, 'media-bytes');

        const makeEl = (overrides = {}) => ({
            value: '',
            checked: false,
            disabled: false,
            textContent: '',
            innerHTML: '',
            style: {},
            dataset: {},
            options: [],
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            append() {},
            prepend() {},
            appendChild() {},
            removeChild() {},
            replaceChildren() {},
            remove() {},
            scrollIntoView() {},
            contains: () => false,
            addEventListener() {},
            setAttribute() {},
            focus() {},
            click() {},
            querySelector: () => null,
            querySelectorAll: () => [],
            getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, left: 0 }),
            getContext: () => ({
                font: '', globalAlpha: 1, save() {}, restore() {}, beginPath() {}, closePath() {},
                moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, arcTo() {},
                rect() {}, clip() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {}, clearRect() {},
                fillText() {}, strokeText() {}, translate() {}, rotate() {}, scale() {}, setLineDash() {},
                createPattern: () => ({}), createLinearGradient: () => ({ addColorStop() {} }),
                createRadialGradient: () => ({ addColorStop() {} }),
                measureText: (txt) => ({ width: String(txt || '').length * 10 }),
            }),
            ...overrides,
        });
        const domElements = new Map([
            ['reels-output-dir', makeEl({ value: outBase })],
            ['reels-download-mode', makeEl({ value: 'all' })],
            ['reels-download-range', makeEl({ value: '' })],
            ['reels-export-naming-mode-outer', makeEl({ value: 'text' })],
            ['reels-naming-mode', makeEl({ value: 'text' })],
            ['reels-package-project-btn', makeEl({ textContent: '📦 仅打包工程' })],
            ['reels-export-status', makeEl()],
            ['reels-quality', makeEl({ value: 'medium' })],
            ['reels-export-engine', makeEl({ value: 'precise' })],
            ['reels-suffix', makeEl({ value: '_subtitled' })],
        ]);
        const documentStub = {
            head: makeEl(),
            body: makeEl(),
            createElement: () => makeEl(),
            getElementById: (id) => domElements.get(id) || null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            removeEventListener() {},
        };
        const sandbox = loadBrowserScript('src/reels-project.js', {
            window: {
                innerWidth: 1280,
                innerHeight: 800,
                location: { hash: '' },
                addEventListener() {},
                removeEventListener() {},
                electronAPI: {
                    toFileUrl: (p) => 'file:///' + String(p || '').replace(/\\/g, '/'),
                    ensureDirectory: async (dir) => {
                        fs.mkdirSync(dir, { recursive: true });
                        return { ok: true };
                    },
                    writeFileText: async (filePath, content) => {
                        fs.mkdirSync(path.dirname(filePath), { recursive: true });
                        fs.writeFileSync(filePath, content, 'utf8');
                        writtenFiles.set(filePath, content);
                        return true;
                    },
                    copyReelsProjectPackage: async (payload) => packageReelsProject(payload),
                    getDefaultProjectDir: () => tmpRoot,
                    saveBatchWorkspace: () => true,
                    readBatchWorkspace: () => '',
                },
            },
            document: documentStub,
            setTimeout: () => 0,
            clearTimeout: () => {},
            setInterval: () => 0,
            clearInterval: () => {},
            requestAnimationFrame: () => 0,
            getComputedStyle: () => ({ display: 'none', height: '0px' }),
            getWritingVisualStyle: (s) => s,
            reelsRefreshWritingTitleEditor: () => {},
            reelsRefreshSpeechWritingImageUI: () => {},
            showToast: () => {},
            alert: () => {},
            confirm: () => true,
        });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8'), sandbox, { filename: 'src/reels-batch-table.js' });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8'), sandbox, { filename: 'src/batch-reels.js' });

        // Initialize two tabs and assign small-groups
        vm.runInContext(`
            _batchTableState.tabs = [
                {
                    id: 'tab_3',
                    name: '标签3',
                    group: '',
                    materialDir: '',
                    tasks: [
                        { id: 't3_1', baseName: '103_task1', bgPath: ${JSON.stringify(bg1)}, videoPath: ${JSON.stringify(bg1)}, audioPath: ${JSON.stringify(v1)}, _exportSelected: true },
                        { id: 't3_2', baseName: '104_task2', bgPath: ${JSON.stringify(bg2)}, videoPath: ${JSON.stringify(bg2)}, audioPath: ${JSON.stringify(v2)}, _exportSelected: true }
                    ]
                },
                {
                    id: 'tab_41',
                    name: '标签25',
                    group: '晚祷组',
                    materialDir: '',
                    tasks: [
                        { id: 't25_1', baseName: '201_task3', bgPath: ${JSON.stringify(bg3)}, videoPath: ${JSON.stringify(bg3)}, audioPath: ${JSON.stringify(v3)}, _exportSelected: true }
                    ]
                }
            ];
            _batchTableState.activeTabId = 'tab_3';
            _batchTableState.nextTabId = 42;
            _setTabsGroup(['tab_3'], '早祷组');
            _toggleTabGroupCollapse('晚祷组');
            _restoreGroupedProjectionFromTabs(['tab_3', 'tab_41']);
        `, sandbox);

        // Verify small-group metadata, collapse state, capture/restore snapshot, and rendered HTML segments
        const groupInfo = JSON.parse(vm.runInContext(`JSON.stringify({
            segments: _buildOrderedTabSegments().map(s => ({ type: s.type, groupName: s.groupName, tabIds: (s.tabs || [s.tab]).map(t => t.id) })),
            collapsed: _batchTableState.collapsedTabGroups,
            projGroups: window._reelsState.tasks.map(t => ({ id: t.id, tabId: t._batchTabId, tabName: t._batchTabName, tabGroup: t._batchTabGroup })),
            snap: window.reelsCaptureBatchTableState(),
        })`, sandbox));

        assert.equal(groupInfo.segments.length, 2);
        assert.equal(groupInfo.segments[0].groupName, '早祷组');
        assert.equal(groupInfo.segments[1].groupName, '晚祷组');
        assert.equal(groupInfo.collapsed['晚祷组'], true);
        assert.equal(groupInfo.projGroups[0].tabGroup, '早祷组');
        assert.equal(groupInfo.projGroups[2].tabGroup, '晚祷组');
        assert.equal(groupInfo.snap.collapsedTabGroups['晚祷组'], true);
        assert.equal(groupInfo.snap.tabs[0].group, '早祷组');

        // Execute grouped batch packaging!
        await sandbox.window.reelsPackageSelectedProjects();

        const batchPkgDirs = fs.readdirSync(outBase).filter(name => name.endsWith('_工程包'));
        assert.equal(batchPkgDirs.length, 1, 'should create timestamped batch package directory');
        const pkgRoot = path.join(outBase, batchPkgDirs[0]);

        // Must create separate group subfolders for the 2 checked groups
        const group1Dir = path.join(pkgRoot, '标签3');
        const group2Dir = path.join(pkgRoot, '标签25');
        assert.equal(fs.existsSync(group1Dir), true, 'must create 标签3 group subfolder');
        assert.equal(fs.existsSync(group2Dir), true, 'must create 标签25 group subfolder');
        const g1Projects = fs.readdirSync(group1Dir).filter(d => d.endsWith('-工程'));
        const g2Projects = fs.readdirSync(group2Dir).filter(d => d.endsWith('-工程'));
        assert.equal(g1Projects.length, 2, '标签3 subfolder should contain 2 task project dirs');
        assert.equal(g2Projects.length, 1, '标签25 subfolder should contain 1 task project dir');

        // Root batch JSON must include 2 tabs + all 3 remapped tasks
        const rootJsonPath = path.join(pkgRoot, '批量工程_3个任务.json');
        assert.equal(fs.existsSync(rootJsonPath), true);
        const packagedJson = JSON.parse(fs.readFileSync(rootJsonPath, 'utf8'));
        assert.equal(packagedJson.version, '2.0');
        assert.equal(packagedJson.tabs.length, 2);
        assert.equal(packagedJson.tabs[0].name, '标签3');
        assert.equal(packagedJson.tabs[0].group, '早祷组');
        assert.equal(packagedJson.tabs[0].tasks.length, 2);
        assert.equal(packagedJson.tabs[1].name, '标签25');
        assert.equal(packagedJson.tabs[1].group, '晚祷组');
        assert.equal(packagedJson.tabs[1].tasks.length, 1);
        assert.ok(packagedJson.tabs[0].tasks[0].bgPath.includes(`${path.sep}标签3${path.sep}`));
        assert.ok(packagedJson.tabs[1].tasks[0].bgPath.includes(`${path.sep}标签25${path.sep}`));

        // Round-trip A: load packaged multi-tab JSON via ReelsProject.applyProjectData -> applyRestoredProject
        vm.runInContext(`
            _batchTableState.tabs = [{ id: 'tab_1', name: '默认', group: '', materialDir: '', tasks: [] }];
            _batchTableState.activeTabId = 'tab_1';
            _batchTableState.appliedTabIds = [];
            window._reelsState.tasks = [];
            const loadedRes = window.ReelsProject.applyProjectData(${JSON.stringify(packagedJson)});
            applyRestoredProject(loadedRes);
        `, sandbox);
        const restoredMulti = JSON.parse(vm.runInContext(`JSON.stringify({
            tabs: _batchTableState.tabs.map(t => ({ name: t.name, group: t.group, count: t.tasks.length })),
            projTabIds: [...new Set(window._reelsState.tasks.map(t => t._batchTabId))],
            projCount: window._reelsState.tasks.length,
        })`, sandbox));
        assert.equal(restoredMulti.tabs.length, 2);
        assert.equal(restoredMulti.tabs[0].name, '标签3');
        assert.equal(restoredMulti.tabs[0].group, '早祷组');
        assert.equal(restoredMulti.tabs[0].count, 2);
        assert.equal(restoredMulti.tabs[1].name, '标签25');
        assert.equal(restoredMulti.tabs[1].group, '晚祷组');
        assert.equal(restoredMulti.projTabIds.length, 2, 'projected left task list must contain 2 distinct group headers');
        assert.equal(restoredMulti.projCount, 3);

        // Round-trip B: legacy flat JSON WITHOUT tabs array (like pre-fix 批量工程_64个任务.json)
        // must ALSO split into 2 tabs & 2 projected groups when imported via Cloud Hub / BatchTable / Load Project
        const legacyFlatJson = { ...packagedJson };
        delete legacyFlatJson.tabs;
        delete legacyFlatJson.activeTabId;
        legacyFlatJson.version = '2.0.0';
        const applyCloudFn = vm.runInContext('_applyDownloadedCloudProjectToBatchTable', sandbox);
        const cloudApplied = await applyCloudFn(legacyFlatJson, rootJsonPath, 'replace', '导入包');
        assert.equal(cloudApplied.tabsCount, 2);
        assert.equal(cloudApplied.tasksCount, 3);
        const restoredFlat = JSON.parse(vm.runInContext(`JSON.stringify({
            tabs: _batchTableState.tabs.map(t => ({ name: t.name, group: t.group, count: t.tasks.length })),
            projTabNames: [...new Set(window._reelsState.tasks.map(t => t._batchTabName))],
        })`, sandbox));
        assert.deepEqual(restoredFlat.tabs, [
            { name: '标签3', group: '早祷组', count: 2 },
            { name: '标签25', group: '晚祷组', count: 1 },
        ]);
        assert.deepEqual(restoredFlat.projTabNames, ['标签3', '标签25']);

        // Round-trip C: ReelsProject -> applyRestoredProject on flat grouped JSON, plus auto-save/auto-restore of tab.group & collapsedTabGroups
        vm.runInContext(`
            _batchTableState.collapsedTabGroups = { '早祷组': true };
            _batchAutoSave({ skipSync: true, forceFullSerialize: true });
            _batchTableState.tabs = [{ id: 'tab_1', name: '默认', group: '', materialDir: '', tasks: [] }];
            _batchTableState.collapsedTabGroups = {};
            _batchAutoRestore();
        `, sandbox);
        const restoredAuto = JSON.parse(vm.runInContext(`JSON.stringify({
            tabs: _batchTableState.tabs.map(t => ({ name: t.name, group: t.group, count: t.tasks.length })),
            collapsed: _batchTableState.collapsedTabGroups,
        })`, sandbox));
        assert.equal(restoredAuto.tabs.length, 2);
        assert.equal(restoredAuto.tabs[0].group, '早祷组');
        assert.equal(restoredAuto.collapsed['早祷组'], true);

        const restoredViaProject = JSON.parse(vm.runInContext(`(() => {
            _batchTableState.tabs = [{ id: 'tab_1', name: '默认', group: '', materialDir: '', tasks: [] }];
            _batchTableState.appliedTabIds = [];
            window._reelsState.tasks = [];
            const res = window.ReelsProject.applyProjectData(${JSON.stringify(legacyFlatJson)});
            applyRestoredProject(res);
            return JSON.stringify({
                tabs: _batchTableState.tabs.map(t => ({ name: t.name, group: t.group, count: t.tasks.length })),
                projTabNames: [...new Set(window._reelsState.tasks.map(t => t._batchTabName))],
            });
        })()`, sandbox));
        assert.deepEqual(restoredViaProject.tabs, [
            { name: '标签3', group: '早祷组', count: 2 },
            { name: '标签25', group: '晚祷组', count: 1 },
        ]);
        assert.deepEqual(restoredViaProject.projTabNames, ['标签3', '标签25']);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});


test('Cloud Hub downloadCloudProject splits flat grouped batch JSON into multiple tabs and relinks nested group folders', async () => {
    const os = require('node:os');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cloud-multigroup-'));
    const storeDir = path.join(tmpRoot, 'backend');
    const matDir = path.join(tmpRoot, 'downloaded_pkg');
    const g1AssetDir = path.join(matDir, '标签3', '103_task-工程', '背景素材');
    const g2AssetDir = path.join(matDir, '标签25', '201_task-工程', '背景素材');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.mkdirSync(g1AssetDir, { recursive: true });
    fs.mkdirSync(g2AssetDir, { recursive: true });

    const localBg1 = path.join(g1AssetDir, 'clip_g1.mp4');
    const localBg2 = path.join(g2AssetDir, 'clip_g2.mp4');
    fs.writeFileSync(localBg1, 'g1');
    fs.writeFileSync(localBg2, 'g2');

    const settingsResolved = require.resolve('../electron/services/settings');
    const cloudHubResolved = require.resolve('../electron/services/cloud-hub');
    const settingsService = require(settingsResolved);
    const origGetBackendDir = settingsService.getBackendDir;
    const origFetch = globalThis.fetch;

    const flatPackagedJson = {
        version: '2.0.0',
        app: 'VideoKit',
        tasks: [
            {
                baseName: '103_task',
                _batchTabId: 'tab_3',
                _batchTabName: '标签3',
                _batchTabGroup: '早祷组',
                bgPath: 'C:\\MacOther\\2026-11-13_0617_工程包\\标签3\\103_task-工程\\背景素材\\clip_g1.mp4',
            },
            {
                baseName: '201_task',
                _batchTabId: 'tab_41',
                _batchTabName: '标签25',
                _batchTabGroup: '晚祷组',
                bgPath: 'C:\\MacOther\\2026-11-13_0617_工程包\\标签25\\201_task-工程\\背景素材\\clip_g2.mp4',
            },
        ],
    };

    try {
        settingsService.getBackendDir = () => storeDir;
        delete require.cache[cloudHubResolved];
        const isolatedHub = require('../electron/services/cloud-hub');
        globalThis.fetch = async (url) => {
            if (String(url).includes('1FlatBatchMultiGrp')) {
                return new Response(JSON.stringify(flatPackagedJson), { status: 200 });
            }
            return new Response('not found', { status: 404 });
        };

        const res = await isolatedHub.downloadCloudProject({
            url: 'https://drive.google.com/file/d/1FlatBatchMultiGrp/view?usp=sharing',
            local_material_root: matDir,
        });
        assert.equal(res.status, 'success');
        assert.equal(res.tabs_count, 2);
        assert.equal(res.tasks_count, 2);
        assert.equal(res.project.tabs[0].name, '标签3');
        assert.equal(res.project.tabs[0].group, '早祷组');
        assert.equal(res.project.tabs[1].name, '标签25');
        assert.equal(res.project.tabs[1].group, '晚祷组');
        assert.equal(res.relink_stats.fixed, 2);
        assert.equal(res.relink_stats.missing, 0);
        assert.equal(res.project.tabs[0].tasks[0].bgPath, localBg1);
        assert.equal(res.project.tabs[1].tasks[0].bgPath, localBg2);
    } finally {
        globalThis.fetch = origFetch;
        settingsService.getBackendDir = origGetBackendDir;
        delete require.cache[cloudHubResolved];
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('Project packager & loader preserve watermarks (attribution), persist to localStorage, and sanitize unsafe JSON keys', async () => {
    const os = require('node:os');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-wm-attr-'));
    try {
        const srcMedia = path.join(tmpRoot, 'media');
        const outDir = path.join(tmpRoot, 'out');
        fs.mkdirSync(srcMedia, { recursive: true });
        fs.mkdirSync(outDir, { recursive: true });

        const sigLogo = path.join(srcMedia, 'author_sig.png');
        fs.writeFileSync(sigLogo, 'png-signature-bytes');

        const { packageReelsProject } = require(path.join(ROOT, 'electron/services/projectPackager.js'));
        const localMediaUrl = 'local-media:///' + sigLogo.replace(/\\/g, '/');
        const maliciousPayload = JSON.parse(`{
            "version": "2.0.0",
            "app": "VideoKit",
            "__proto__": { "pollutedPackager": true },
            "watermarks": [
                { "id": "wm_sig", "type": "text", "text": "@AuthorSignature", "enabled": true, "position": "bottom-right" },
                { "id": "wm_img", "type": "image", "imagePath": ${JSON.stringify(localMediaUrl)}, "enabled": true, "position": "top-left" }
            ],
            "tasks": [{ "id": "t1", "baseName": "001_sig" }]
        }`);

        const packed = await packageReelsProject({
            outputPath: path.join(outDir, '001_sig.mp4'),
            taskAssets: [{ role: 'overlay', path: sigLogo }],
            reelsProjectData: maliciousPayload,
        });
        assert.equal(packed.ok, true);
        assert.equal(({}).pollutedPackager, undefined);

        const saved = JSON.parse(fs.readFileSync(packed.projectJsonPath, 'utf8'));
        assert.equal(saved.watermarks[0].text, '@AuthorSignature');
        assert.equal(saved.watermarks[1].imagePath, path.join(packed.projectDir, '覆层素材', 'author_sig.png'));
        assert.equal(Object.prototype.hasOwnProperty.call(saved, '__proto__'), false);

        // Verify ReelsProject.collectProjectData, _batchExportConfig, _applyImportedTabsToState, and applyRestoredProject round-trip
        const wmListEl = { innerHTML: '', querySelectorAll: () => [], appendChild() {} };
        const storage = new Map();
        const localStorageStub = {
            getItem: (k) => (storage.has(k) ? storage.get(k) : null),
            setItem: (k, v) => storage.set(k, String(v)),
            removeItem: (k) => storage.delete(k),
        };
        const sandbox = loadBrowserScript('src/reels-project.js', {
            window: {
                innerWidth: 1280,
                innerHeight: 800,
                location: { hash: '' },
                addEventListener() {},
                removeEventListener() {},
                localStorage: localStorageStub,
                electronAPI: {
                    toFileUrl: (p) => 'file:///' + String(p || '').replace(/\\/g, '/'),
                    saveBatchWorkspace: () => true,
                    readBatchWorkspace: () => '',
                },
            },
            localStorage: localStorageStub,
            document: {
                head: { appendChild() {} },
                body: { appendChild() {}, querySelectorAll: () => [] },
                createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, querySelectorAll: () => [], addEventListener() {} }),
                getElementById: (id) => (id === 'reels-watermark-list' ? wmListEl : null),
                querySelector: () => null,
                querySelectorAll: () => [],
                addEventListener() {},
                removeEventListener() {},
            },
            setTimeout: () => 0,
            clearTimeout: () => {},
            setInterval: () => 0,
            clearInterval: () => {},
            requestAnimationFrame: () => 0,
            getComputedStyle: () => ({ display: 'none', height: '0px' }),
            getWritingVisualStyle: (s) => s,
            reelsRefreshWritingTitleEditor: () => {},
            reelsRefreshSpeechWritingImageUI: () => {},
            showToast: () => {},
            alert: () => {},
            confirm: () => true,
        });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8'), sandbox, { filename: 'src/reels-batch-table.js' });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8'), sandbox, { filename: 'src/batch-reels.js' });

        const collected = vm.runInContext(`(() => {
            window._reelsState.watermarks = [
                { id: 'wm_brand', type: 'text', text: '@TeamBrand', enabled: true, position: 'bottom-left' }
            ];
            return JSON.stringify(window.ReelsProject.collectProjectData({
                tasks: [{ id: 't1', baseName: '001' }],
                style: {},
                exportOpts: {},
                watermarks: window._reelsState.watermarks,
            }));
        })()`, sandbox);
        const collectedObj = JSON.parse(collected);
        assert.equal(collectedObj.watermarks[0].text, '@TeamBrand');

        // Recipient imports Cloud package in append mode while only having factory-disabled watermarks
        const importedRes = await vm.runInContext(`(async () => {
            window._reelsState.watermarks = [{ id: 'wm_default', type: 'text', text: 'AI Generated', enabled: false }];
            window.localStorage.setItem('reels_watermarks', JSON.stringify(window._reelsState.watermarks));
            await _applyDownloadedCloudProjectToBatchTable(${JSON.stringify(saved)}, '', 'append', '带署名工程');
            return JSON.stringify({
                stateWms: window._reelsState.watermarks,
                lsWms: JSON.parse(window.localStorage.getItem('reels_watermarks') || '[]'),
                wmHtml: document.getElementById('reels-watermark-list').innerHTML,
            });
        })()`, sandbox);
        const parsedAfterCloud = JSON.parse(importedRes);
        assert.equal(parsedAfterCloud.stateWms[0].text, '@AuthorSignature');
        assert.equal(parsedAfterCloud.lsWms[0].text, '@AuthorSignature');
        assert.match(parsedAfterCloud.wmHtml, /@AuthorSignature/);

        // Recipient opens single project snapshot via applyRestoredProject -> persists & refreshes UI
        const restoredSingle = JSON.parse(vm.runInContext(`(() => {
            window._reelsState.watermarks = [{ id: 'wm_old', type: 'text', text: 'OldLocal', enabled: true }];
            applyRestoredProject({
                success: true,
                tasks: [{ id: 't_single', baseName: '002' }],
                style: {},
                exportOpts: {},
                watermarks: [{ id: 'wm_next', type: 'text', text: '@SingleSnapSig', enabled: true, position: 'top-right' }],
                selectedIdx: -1,
            });
            return JSON.stringify({
                stateWms: window._reelsState.watermarks,
                lsWms: JSON.parse(window.localStorage.getItem('reels_watermarks') || '[]'),
                wmHtml: document.getElementById('reels-watermark-list').innerHTML,
            });
        })()`, sandbox));
        assert.equal(restoredSingle.stateWms[0].text, '@SingleSnapSig');
        assert.equal(restoredSingle.lsWms[0].text, '@SingleSnapSig');
        assert.match(restoredSingle.wmHtml, /@SingleSnapSig/);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});


test('Tab visibility project manager (open vs background) and duplicate cloud project prevention', async () => {
    const os = require('node:os');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-projmgr-'));
    let persistedWorkspace = '';
    try {
        const containerStub = {
            innerHTML: '',
            style: {},
            addEventListener() {},
            removeEventListener() {},
            querySelector: () => null,
            querySelectorAll: () => [],
            cloneNode() {
                const clone = {
                    ...containerStub,
                    style: {},
                    parentNode: null,
                    addEventListener() {},
                    removeEventListener() {},
                };
                clone.parentNode = { replaceChild() {} };
                return clone;
            },
        };
        containerStub.parentNode = {
            replaceChild(nextNode) {
                containerStub.innerHTML = nextNode.innerHTML || containerStub.innerHTML;
            },
        };
        const sandbox = loadBrowserScript('src/reels-project.js', {
            window: {
                innerWidth: 1280,
                innerHeight: 800,
                location: { hash: '' },
                addEventListener() {},
                removeEventListener() {},
                electronAPI: {
                    toFileUrl: (p) => 'file:///' + String(p || '').replace(/\\/g, '/'),
                    saveBatchWorkspace: (s) => { persistedWorkspace = s; return true; },
                    readBatchWorkspace: () => persistedWorkspace,
                    getDefaultProjectDir: () => tmpRoot,
                },
            },
            document: {
                head: { appendChild() {} },
                body: { appendChild() {}, querySelectorAll: () => [] },
                createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} }),
                getElementById: (id) => (id === 'reels-batch-table-container' ? containerStub : null),
                querySelector: () => null,
                querySelectorAll: () => [],
                addEventListener() {},
                removeEventListener() {},
            },
            setTimeout: () => 0,
            clearTimeout: () => {},
            setInterval: () => 0,
            clearInterval: () => {},
            requestAnimationFrame: () => 0,
            getComputedStyle: () => ({ display: 'none', height: '0px' }),
            getWritingVisualStyle: (s) => s,
            reelsRefreshWritingTitleEditor: () => {},
            reelsRefreshSpeechWritingImageUI: () => {},
            showToast: () => {},
            alert: () => {},
            confirm: () => true,
        });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8'), sandbox, { filename: 'src/reels-batch-table.js' });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8'), sandbox, { filename: 'src/batch-reels.js' });

        // Setup 3 tabs: 2 visible, 1 moved to background via reelsSetVisibleBatchTabs
        const visResult = JSON.parse(vm.runInContext(`(() => {
            _batchTableState.container = document.getElementById('reels-batch-table-container');
            _batchTableState.tabs = [
                { id: 'tab_1', name: '早祷工程', group: '祈祷组', hidden: false, tasks: [{ id: 't1', baseName: 'm1' }] },
                { id: 'tab_2', name: '晚祷工程', group: '祈祷组', hidden: false, tasks: [{ id: 't2', baseName: 'e1' }] },
                { id: 'tab_3', name: '备用老工程', group: '存档', hidden: false, tasks: [{ id: 't3', baseName: 'old1' }] },
            ];
            _batchTableState.activeTabId = 'tab_1';
            _batchTableState.nextTabId = 4;
            window.reelsSetVisibleBatchTabs(['tab_1', 'tab_2']);
            return JSON.stringify({
                tabStates: _batchTableState.tabs.map(t => ({ id: t.id, hidden: !!t.hidden })),
                projectedTaskIds: window._reelsState.tasks.map(t => t.id),
                activeTabId: _batchTableState.activeTabId,
            });
        })()`, sandbox));
        assert.deepEqual(visResult.tabStates, [
            { id: 'tab_1', hidden: false },
            { id: 'tab_2', hidden: false },
            { id: 'tab_3', hidden: true },
        ]);
        assert.deepEqual(visResult.projectedTaskIds, ['t1', 't2']);

        // Auto-restore after restart must preserve hidden flag and keep background tab out of left workspace list
        const afterRestart = JSON.parse(vm.runInContext(`(() => {
            _batchTableState.tabs = [{ id: 'tab_x', name: '默认', tasks: [] }];
            window._reelsState.tasks = [];
            _batchAutoRestore();
            return JSON.stringify({
                tabStates: _batchTableState.tabs.map(t => ({ id: t.id, hidden: !!t.hidden })),
                projectedTaskIds: window._reelsState.tasks.map(t => t.id),
            });
        })()`, sandbox));
        assert.deepEqual(afterRestart.tabStates, [
            { id: 'tab_1', hidden: false },
            { id: 'tab_2', hidden: false },
            { id: 'tab_3', hidden: true },
        ]);
        assert.deepEqual(afterRestart.projectedTaskIds, ['t1', 't2']);

        // Cloud Hub duplicate detection & in-place replace vs skip
        const dupTest = await vm.runInContext(`(async () => {
            const url = 'https://drive.google.com/file/d/1DupProjectABC123/view?usp=sharing';
            const cKey = _extractCloudSourceKey(url);
            await _applyDownloadedCloudProjectToBatchTable(
                { version: '2.0.0', tasks: [{ id: 'c1', baseName: 'v1_task' }] },
                '', 'append', '2026-11-13_测试重名工程',
                { cloudKey: cKey, cloudUrl: url }
            );
            const countAfterFirst = _batchTableState.tabs.length;

            // Even if moved to background, _findExistingTabsForCloudEntry must detect it with ?usp=drive_link variant
            const cloudTab = _batchTableState.tabs[_batchTableState.tabs.length - 1];
            cloudTab.hidden = true;
            const foundInBg = _findExistingTabsForCloudEntry({
                title: '测试重名工程',
                date: '2026-11-13',
                url: 'https://drive.google.com/file/d/1DupProjectABC123/view?usp=drive_link',
            });

            // Re-apply with skip -> must NOT append duplicate tab
            const skipRes = await _applyDownloadedCloudProjectToBatchTable(
                { version: '2.0.0', tasks: [{ id: 'c2', baseName: 'v2_skip' }] },
                '', 'append', '2026-11-13_测试重名工程',
                { cloudKey: cKey, cloudUrl: url, duplicateStrategy: 'skip' }
            );
            const countAfterSkip = _batchTableState.tabs.length;

            // Re-apply with replace -> must update existing tab in place without adding duplicate tab
            const replaceRes = await _applyDownloadedCloudProjectToBatchTable(
                { version: '2.0.0', tasks: [{ id: 'c3', baseName: 'v3_updated' }] },
                '', 'append', '2026-11-13_测试重名工程',
                { cloudKey: cKey, cloudUrl: url, duplicateStrategy: 'replace' }
            );
            const countAfterReplace = _batchTableState.tabs.length;
            const updatedTab = _batchTableState.tabs.find(t => t.id === cloudTab.id);

            return JSON.stringify({
                countAfterFirst,
                foundMatchedCount: foundInBg.matchedTabs.length,
                countAfterSkip,
                skipRes,
                countAfterReplace,
                replaceRes,
                updatedTaskBase: updatedTab?.tasks?.[0]?.baseName || '',
                updatedHidden: !!updatedTab?.hidden,
            });
        })()`, sandbox);
        const dupParsed = JSON.parse(dupTest);
        assert.equal(dupParsed.foundMatchedCount, 1);
        assert.equal(dupParsed.countAfterSkip, dupParsed.countAfterFirst);
        assert.equal(dupParsed.skipRes.skippedDuplicates, 1);
        assert.equal(dupParsed.skipRes.tabsAdded, 0);
        assert.equal(dupParsed.countAfterReplace, dupParsed.countAfterFirst);
        assert.equal(dupParsed.replaceRes.tabsUpdated, 1);
        assert.equal(dupParsed.replaceRes.tabsAdded, 0);
        assert.equal(dupParsed.updatedTaskBase, 'v3_updated');
        assert.equal(dupParsed.updatedHidden, false);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});


test('Cloud Hub SSRF & unsafe protocol/prototype guards reject dangerous inputs', async () => {
    const os = require('node:os');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-hub-sec-'));
    const settingsResolved = require.resolve('../electron/services/settings');
    const cloudHubResolved = require.resolve('../electron/services/cloud-hub');
    const settingsService = require(settingsResolved);
    const origGetBackendDir = settingsService.getBackendDir;
    const origFetch = globalThis.fetch;
    try {
        settingsService.getBackendDir = () => tmpRoot;
        delete require.cache[cloudHubResolved];
        const hub = require('../electron/services/cloud-hub');

        await assert.rejects(() => hub.syncFromCloudHub({ hub_url: 'file:///C:/Windows/win.ini' }), /http\/https/);
        await assert.rejects(() => hub.syncFromCloudHub({ hub_url: 'https://user:secret@example.com/hub' }), /凭据/);
        await assert.rejects(() => hub.downloadCloudProject({ url: 'file:///etc/passwd' }), /http\/https/);

        const docText = [
            '恶意本地探测 http://127.0.0.1:9999/?q=drive.google.com',
            '合法工程 https://drive.google.com/file/d/1SafeGoogleDocLink/view?usp=sharing',
        ].join('\n');
        globalThis.fetch = async () => new Response(docText, { status: 200 });
        const docEntries = await hub.fetchGoogleDocProjects('https://docs.google.com/document/d/1TestDocListId/edit');
        assert.equal(docEntries.length, 1);
        assert.match(docEntries[0].url, /1SafeGoogleDocLink/);

        // Verify syncFromCloudHub rejects prototype pollution in daily_projects map & deduplicates Drive variants
        const protoPayloadJson = '{"daily_projects":{"__proto__":"https://evil.example/p.json","2026-11-13":"https://drive.google.com/file/d/1DupFileXyz123/view?usp=sharing"},"projects":[{"date":"2026-11-13","title":"dup","url":"https://drive.google.com/file/d/1DupFileXyz123/view?usp=drive_link"}]}';
        globalThis.fetch = async () => new Response(protoPayloadJson, { status: 200 });
        const syncRes = await hub.syncFromCloudHub({ hub_url: 'https://hub.example.workers.dev' });
        assert.equal(syncRes.ok, true);
        assert.equal(({}).polluted, undefined);
        assert.equal(syncRes.settings.daily_projects.length, 1);
    } finally {
        globalThis.fetch = origFetch;
        settingsService.getBackendDir = origGetBackendDir;
        delete require.cache[cloudHubResolved];
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('Project Library nested 3-level folders, move cycle guard, scoped rename & per-folder reorder', () => {
    const os = require('node:os');
    const Module = require('node:module');
    const origLoad = Module._load;
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-tpl-nest-'));
    const templatesResolved = require.resolve('../electron/services/templates');
    const mockApp = { getPath: () => tmpUserData };
    const mockShared = {
        getCandidateTemplateDirs: () => [path.join(tmpUserData, 'videokit-templates')],
        isIsolatedTestProfile: () => true,
    };

    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'electron') return { app: mockApp };
            if (request === './sharedProfile' && parent && parent.filename.endsWith(`${path.sep}templates.js`)) {
                return mockShared;
            }
            return origLoad.apply(this, arguments);
        };
        delete require.cache[templatesResolved];
        const templates = require('../electron/services/templates');

        const l1 = templates.createTemplateFolder('2026-11').folder;
        const l1b = templates.createTemplateFolder('2026-12').folder;
        const l2 = templates.createTemplateFolder('祈祷赛道', l1.id).folder;
        const l2SameInOtherParent = templates.createTemplateFolder('祈祷赛道', l1b.id).folder;
        const l3 = templates.createTemplateFolder('早上账号组', l2.id).folder;
        const l3Sib = templates.createTemplateFolder('晚上账号组', l2.id).folder;

        assert.equal(l2.parentId, l1.id);
        assert.equal(l2SameInOtherParent.parentId, l1b.id);
        assert.equal(l3.parentId, l2.id);

        assert.throws(() => templates.createTemplateFolder('祈祷赛道', l1.id), /同名文件夹/);
        assert.throws(() => templates.moveTemplateFolders([l1.id], l3.id), /子文件夹/);
        assert.throws(() => templates.moveTemplateFolders([l1.id], l1.id), /自己/);
        assert.throws(() => templates.deleteEmptyTemplateFolder(l1.id), /子文件夹/);

        const p1 = templates.saveTemplate({
            name: '层级1直接工程',
            folderId: l1.id,
            projectData: { tasks: [{ baseName: 't1' }] },
        });
        const p3 = templates.saveTemplate({
            name: '层级3账号1',
            folderId: l3.id,
            thumbnail: 'data:image/png;base64,thumb_lvl3',
            projectData: { tasks: [{ baseName: 't3' }] },
        });
        assert.throws(() => templates.deleteEmptyTemplateFolder(l3.id), /移出文件夹内的模板/);

        const fetched = templates.getTemplatesByIds([p3.id, p1.id]);
        assert.equal(fetched.length, 2);
        assert.equal(fetched[0].id, p3.id);
        assert.equal(fetched[0].projectData.tasks[0].baseName, 't3');
        assert.equal(fetched[1].id, p1.id);

        // Reorder Level-1 directory (child folder + direct project) independently from root
        templates.reorderTemplateLibrary([`t:${p1.id}`, `f:${l2.id}`], l1.id);
        const foldersState = templates.readTemplateFolders();
        assert.deepEqual(foldersState.folderOrders[l1.id], [`t:${p1.id}`, `f:${l2.id}`]);

        // Move empty sibling folder l3Sib from l2 -> l1b cleanly
        templates.moveTemplateFolders([l3Sib.id], l1b.id);
        const moved = templates.readTemplateFolders().folders.find(f => f.id === l3Sib.id);
        assert.equal(moved.parentId, l1b.id);

        // Once l3Sib has no children or templates, delete succeeds
        assert.equal(templates.deleteEmptyTemplateFolder(l3Sib.id).success, true);
    } finally {
        Module._load = origLoad;
        delete require.cache[templatesResolved];
        fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
});

test('Project Library strict Level-3 workspace + Batch Table + working panel sync & thumbnails', async () => {
    const foldersDb = [
        { id: 'f_lvl1', name: '一级', parentId: '', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' },
        { id: 'f_lvl2', name: '二级', parentId: 'f_lvl1', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' },
        { id: 'f_lvl3', name: '三级', parentId: 'f_lvl2', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' },
        { id: 'f_lvl3_sib', name: '三级兄弟', parentId: 'f_lvl2', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' },
        { id: 'f_lvl4', name: '四级子目录', parentId: 'f_lvl3', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' },
    ];
    const assignmentsDb = {
        tpl_l1: 'f_lvl1',
        tpl_l2: 'f_lvl2',
        tpl_sib3: 'f_lvl3_sib',
        tpl_l4: 'f_lvl4',
    };
    const templatesDb = new Map([
        ['tpl_l1', { id: 'tpl_l1', name: '一级直属', thumbnail: 'data:image/png;base64,l1', updatedAt: '2026-11-01T00:00:00Z', projectData: { tasks: [{ id: 'x1', baseName: 'l1_task' }] } }],
        ['tpl_l2', { id: 'tpl_l2', name: '二级直属', thumbnail: 'data:image/png;base64,l2', updatedAt: '2026-11-01T00:00:00Z', projectData: { tasks: [{ id: 'x2', baseName: 'l2_task' }] } }],
        ['tpl_sib3', { id: 'tpl_sib3', name: '兄弟文件夹工程', thumbnail: 'data:image/png;base64,sib3', updatedAt: '2026-11-01T00:00:00Z', projectData: { tasks: [{ id: 'x3', baseName: 'sib3_task' }] } }],
        ['tpl_l4', { id: 'tpl_l4', name: '四级子工程', thumbnail: 'data:image/png;base64,l4', updatedAt: '2026-11-01T00:00:00Z', projectData: { tasks: [{ id: 'x4', baseName: 'l4_task' }] } }],
    ]);
    for (let i = 1; i <= 10; i++) {
        const id = `tpl_3_${i}`;
        assignmentsDb[id] = 'f_lvl3';
        templatesDb.set(id, {
            id,
            name: `三级标签_${i}`,
            thumbnail: `data:image/png;base64,thumb_${i}`,
            updatedAt: `2026-11-13T08:${String(i).padStart(2, '0')}:00Z`,
            projectData: {
                tasks: [{ id: `task_${i}`, baseName: `video_${i}`, txtContent: `hello_${i}` }],
                style: { fontSize: 52 },
            },
        });
    }

    const savedBackPayloads = [];
    const apiFetchMock = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : {};
        const okJson = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
        const u = String(url || '');
        if (u.endsWith('/live-projects/folders/list') || u.endsWith('/templates/folders/list')) {
            return okJson({ folders: foldersDb, assignments: assignmentsDb, folderOrders: {} });
        }
        if (u.endsWith('/live-projects/list') || u.endsWith('/templates/list')) {
            const list = [...templatesDb.values()].map(t => ({
                id: t.id, name: t.name, thumbnail: t.thumbnail, updatedAt: t.updatedAt, taskCount: t.projectData.tasks.length,
            }));
            return okJson(list);
        }
        if (u.endsWith('/live-projects/get-many') || u.endsWith('/templates/get-many')) {
            const list = (body.ids || []).map(id => templatesDb.get(id)).filter(Boolean);
            return okJson(list);
        }
        if (u.endsWith('/live-projects/get') || u.endsWith('/templates/get')) {
            return okJson(templatesDb.get(body.id) || null);
        }
        if (u.endsWith('/live-projects/save') || u.endsWith('/templates/save')) {
            savedBackPayloads.push(body);
            const id = body.id || `prj_new_${savedBackPayloads.length}`;
            const updated = {
                id,
                name: body.name,
                thumbnail: body.thumbnail || '',
                updatedAt: '2026-11-13T09:30:00Z',
                projectData: body.projectData,
            };
            templatesDb.set(id, updated);
            if (body.folderId !== undefined) {
                if (body.folderId) assignmentsDb[id] = body.folderId;
                else delete assignmentsDb[id];
            }
            return okJson({ id, success: true });
        }
        if (u.endsWith('/live-projects/rename') || u.endsWith('/templates/rename')) {
            const t = templatesDb.get(body.id);
            if (t) t.name = body.name;
            return okJson({ success: true });
        }
        return okJson({ success: true });
    };

    const makeEl = (overrides = {}) => ({
        value: '',
        checked: false,
        disabled: false,
        textContent: '',
        innerHTML: '',
        style: {},
        dataset: {},
        options: [],
        children: [],
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild() {},
        removeChild() {},
        remove() {},
        contains: () => false,
        addEventListener() {},
        setAttribute() {},
        focus() {},
        click() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, left: 0 }),
        getContext: () => ({
            font: '', globalAlpha: 1, save() {}, restore() {}, beginPath() {}, closePath() {},
            moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, arcTo() {},
            rect() {}, clip() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {}, clearRect() {},
            fillText() {}, strokeText() {}, translate() {}, rotate() {}, scale() {}, setLineDash() {},
            createPattern: () => ({}), createLinearGradient: () => ({ addColorStop() {} }),
            createRadialGradient: () => ({ addColorStop() {} }),
            measureText: (txt) => ({ width: String(txt || '').length * 10 }),
        }),
        ...overrides,
    });
    const domElements = new Map([
        ['reels-task-list', makeEl()],
        ['reels-task-count', makeEl()],
        ['reels-task-panel-count', makeEl()],
        ['reels-active-folder-bar', makeEl()],
        ['reels-batch-table-container', makeEl({ style: { display: 'none' } })],
        ['reels-work-mode', makeEl({ value: 'srt' })],
        ['reels-quality', makeEl({ value: 'medium' })],
        ['reels-export-engine', makeEl({ value: 'precise' })],
        ['reels-suffix', makeEl({ value: '_subtitled' })],
        ['reels-naming-mode', makeEl({ value: 'text' })],
        ['reels-task-name-display', makeEl({ value: 'full' })],
    ]);
    const documentStub = {
        head: makeEl(),
        body: makeEl(),
        createElement: () => makeEl(),
        getElementById: (id) => domElements.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
    };

    const sandbox = loadBrowserScript('src/reels-project.js', {
        window: {
            innerWidth: 1280,
            innerHeight: 800,
            location: { hash: '' },
            addEventListener() {},
            removeEventListener() {},
            electronAPI: {
                toFileUrl: (p) => 'file:///' + String(p || '').replace(/\\/g, '/'),
                getDefaultProjectDir: () => '',
                saveBatchWorkspace: () => true,
                readBatchWorkspace: () => '',
            },
        },
        document: documentStub,
        API_BASE: 'http://127.0.0.1:0/api',
        apiFetch: apiFetchMock,
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        requestAnimationFrame: () => 0,
        getComputedStyle: () => ({ display: 'none', height: '0px' }),
        getWritingVisualStyle: (s) => s,
        reelsRefreshWritingTitleEditor: () => {},
        reelsRefreshSpeechWritingImageUI: () => {},
        showToast: () => {},
        alert: () => {},
        confirm: () => true,
    });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8'), sandbox, { filename: 'src/reels-batch-table.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8'), sandbox, { filename: 'src/batch-reels.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-templates.js'), 'utf8'), sandbox, { filename: 'src/reels-templates.js' });

    // 1. Apply Level-3 folder: strictly imports its 10 direct children ONLY
    const appliedAll = await sandbox.window.reelsApplyFolderById('f_lvl3');
    assert.equal(appliedAll, true);
    const fullState = JSON.parse(vm.runInContext(`JSON.stringify({
        tabCount: _batchTableState.tabs.length,
        tabNames: _batchTableState.tabs.map(t => t.name),
        tplIds: _batchTableState.tabs.map(t => t.libraryTemplateId),
        folderId: _batchTableState.activeLibraryFolderId,
        folderPath: _batchTableState.activeLibraryFolderPath,
        scopeMode: _batchTableState.libraryScopeMode,
        taskCount: window._reelsState.tasks.length,
        taskTabNames: window._reelsState.tasks.map(t => t._batchTabName),
    })`, sandbox));
    assert.equal(fullState.tabCount, 10);
    assert.equal(fullState.folderId, 'f_lvl3');
    assert.equal(fullState.folderPath, '一级 / 二级 / 三级');
    assert.equal(fullState.scopeMode, 'folder');
    assert.equal(fullState.taskCount, 10);
    assert.ok(!fullState.tplIds.includes('tpl_l1'));
    assert.ok(!fullState.tplIds.includes('tpl_l2'));
    assert.ok(!fullState.tplIds.includes('tpl_sib3'));
    assert.ok(!fullState.tplIds.includes('tpl_l4'));

    // Working panel renders Level-3 breadcrumb banner + 10 group thumbnails
    const taskListHtml = domElements.get('reels-task-list').innerHTML;
    assert.match(taskListHtml, /class="reels-batch-group-thumb"/);
    assert.match(taskListHtml, /data:image\/png;base64,thumb_1/);
    assert.match(taskListHtml, /data:image\/png;base64,thumb_10/);
    const activeBar = domElements.get('reels-active-folder-bar');
    assert.match(activeBar.innerHTML, /一级 \/ 二级 \/ 三级/);
    assert.match(activeBar.innerHTML, /10 个标签/);

    // Batch Table renders folder scope pill + tab thumbnails
    vm.runInContext(`reelsToggleBatchTable();`, sandbox);
    const tableHtml = domElements.get('reels-batch-table-container').innerHTML;
    assert.match(tableHtml, /class="rbt-folder-scope-bar"/);
    assert.match(tableHtml, /一级 \/ 二级 \/ 三级/);
    assert.match(tableHtml, /class="rbt-tab-thumb"/);
    assert.match(tableHtml, /data:image\/png;base64,thumb_1/);

    // Close Batch Table -> restores all 10 Level-3 tabs back onto working panel
    vm.runInContext(`reelsToggleBatchTable({ saveOnClose: true });`, sandbox);
    assert.equal(sandbox.window._reelsState.tasks.length, 10);

    // 2. Multi-select apply 2 cards -> workspace & Batch Table show ONLY those 2, then upgrade back to full folder
    await sandbox.window.reelsApplyLibraryProjects(
        [templatesDb.get('tpl_3_1'), templatesDb.get('tpl_3_4')],
        { folderId: 'f_lvl3', folderPath: '一级 / 二级 / 三级', folderTotalCount: 10, scopeMode: 'selected', confirmSwitch: false }
    );
    const subState = JSON.parse(vm.runInContext(`JSON.stringify({
        tabCount: _batchTableState.tabs.length,
        scopeMode: _batchTableState.libraryScopeMode,
        taskCount: window._reelsState.tasks.length,
    })`, sandbox));
    assert.equal(subState.tabCount, 2);
    assert.equal(subState.scopeMode, 'selected');
    assert.equal(subState.taskCount, 2);

    // Clicking "读取本级全部" expands back cleanly to all 10 Level-3 tabs only
    await sandbox.window.reelsSyncWorkspaceWithActiveFolder({ upgradeToFolderScope: true, forceFullFolder: true });
    assert.equal(vm.runInContext(`_batchTableState.tabs.length`, sandbox), 10);

    // Editing tab & syncing back updates library inside f_lvl3
    vm.runInContext(`_batchTableState.tabs[0].tasks[0].txtContent = 'edited_lvl3_text'; _batchTableState.tabs[0]._libraryDirty = true;`, sandbox);
    const writeRes = await sandbox.window.reelsSyncWorkspaceTabsBackToLibraryFolder({ silent: true, onlyDirty: true });
    assert.equal(writeRes.updated, 1);
    assert.equal(savedBackPayloads.length, 1);
    assert.equal(savedBackPayloads[0].folderId, 'f_lvl3');
    assert.equal(savedBackPayloads[0].projectData.tasks[0].txtContent, 'edited_lvl3_text');

    // Verify UI & CRLF contracts
    const indexHtml = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    const templatesRaw = fs.readFileSync(path.join(ROOT, 'src/reels-templates.js'), 'utf8');
    assert.match(indexHtml, /🗂️ 工程项目/);
    assert.match(indexHtml, /📂 模板库/);
    assert.match(indexHtml, /id="reels-active-folder-bar"/);
    assert.match(templatesRaw, /tpl-card-check/);
    assert.match(templatesRaw, /tpl-apply-selected-btn/);
    assert.match(templatesRaw, /tpl-apply-folder-btn/);
    assert.ok(templatesRaw.includes('\r\n'), 'src/reels-templates.js must keep CRLF line endings');
});

test('Project Library auto-archives live workspace tabs (open, hidden & combined queues) and extracts multi-tab project payloads', async () => {
    const os = require('node:os');
    const Module = require('node:module');
    const origLoad = Module._load;
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-tpl-auto-'));
    const templatesResolved = require.resolve('../electron/services/templates');
    const mockApp = { getPath: () => tmpUserData };
    const mockShared = {
        getCandidateTemplateDirs: () => [path.join(tmpUserData, 'videokit-templates')],
        getCandidateLiveProjectDirs: () => [path.join(tmpUserData, 'videokit-live-projects')],
        isIsolatedTestProfile: () => true,
    };

    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'electron') return { app: mockApp };
            if (request === './sharedProfile' && parent && parent.filename.endsWith(`${path.sep}templates.js`)) {
                return mockShared;
            }
            return origLoad.apply(this, arguments);
        };
        delete require.cache[templatesResolved];
        const tplService = require('../electron/services/templates');

        const apiFetchMock = async (url, init = {}) => {
            const u = String(url || '');
            const body = init.body ? JSON.parse(init.body) : {};
            let res = { success: true };
            if (u.endsWith('/live-projects/folders/list')) res = tplService.readLiveProjectFolders();
            else if (u.endsWith('/live-projects/folders/create')) res = tplService.createLiveProjectFolder(body.name, body.parentId || '');
            else if (u.endsWith('/live-projects/folders/reorder')) res = tplService.reorderLiveProjectLibrary(body.order, body.parentId || '');
            else if (u.endsWith('/live-projects/list')) res = tplService.listLiveProjects();
            else if (u.endsWith('/live-projects/get')) res = tplService.getLiveProject(body.id);
            else if (u.endsWith('/live-projects/get-many')) res = tplService.getLiveProjectsByIds(body.ids || []);
            else if (u.endsWith('/live-projects/save')) res = tplService.saveLiveProject(body);
            else if (u.endsWith('/templates/folders/list')) res = tplService.readTemplateFolders();
            else if (u.endsWith('/templates/folders/create')) res = tplService.createTemplateFolder(body.name, body.parentId || '');
            else if (u.endsWith('/templates/folders/reorder')) res = tplService.reorderTemplateLibrary(body.order, body.parentId || '');
            else if (u.endsWith('/templates/list')) res = tplService.listTemplates();
            else if (u.endsWith('/templates/get')) res = tplService.getTemplate(body.id);
            else if (u.endsWith('/templates/get-many')) res = tplService.getTemplatesByIds(body.ids || []);
            else if (u.endsWith('/templates/save')) res = tplService.saveTemplate(body);
            return { ok: true, async json() { return { data: res }; } };
        };

        const makeEl = (overrides = {}) => ({
            value: '', checked: false, disabled: false, textContent: '', innerHTML: '', style: {}, dataset: {},
            options: [], children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            appendChild() {}, removeChild() {}, remove() {}, contains: () => false, addEventListener() {},
            setAttribute() {}, focus() {}, click() {}, querySelector: () => null, querySelectorAll: () => [],
            getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, left: 0 }),
            ...overrides,
        });
        const domElements = new Map([
            ['reels-task-list', makeEl()],
            ['reels-task-count', makeEl()],
            ['reels-task-panel-count', makeEl()],
            ['reels-active-folder-bar', makeEl()],
            ['reels-batch-table-container', makeEl({ style: { display: 'none' } })],
            ['reels-work-mode', makeEl({ value: 'srt' })],
        ]);
        const documentStub = {
            head: makeEl(),
            body: makeEl(),
            createElement: () => makeEl(),
            getElementById: (id) => domElements.get(id) || null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            removeEventListener() {},
        };

        const sandbox = loadBrowserScript('src/reels-project.js', {
            window: {
                innerWidth: 1280, innerHeight: 800, location: { hash: '' },
                addEventListener() {}, removeEventListener() {},
                electronAPI: { toFileUrl: (p) => 'file:///' + String(p || '').replace(/\\/g, '/'), getDefaultProjectDir: () => '', saveBatchWorkspace: () => true, readBatchWorkspace: () => '' },
            },
            document: documentStub,
            API_BASE: 'http://127.0.0.1:0/api',
            apiFetch: apiFetchMock,
            setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0,
            getComputedStyle: () => ({ display: 'none', height: '0px' }),
            getWritingVisualStyle: (s) => s,
            reelsRefreshWritingTitleEditor: () => {},
            reelsRefreshSpeechWritingImageUI: () => {},
            showToast: () => {}, alert: () => {}, confirm: () => true,
        });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8'), sandbox, { filename: 'src/reels-batch-table.js' });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8'), sandbox, { filename: 'src/batch-reels.js' });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-templates.js'), 'utf8'), sandbox, { filename: 'src/reels-templates.js' });

        // Simulate realistic pre-existing unarchived workspace:
        // - tab_open (visible, group: '分组A')
        // - tab_bg (hidden in background, group: '分组B')
        // - tab_combined (_externalFolderQueuesCombined with 2 queue groups inside one tab)
        // - orphan task with _folderQueueId in window._reelsState.tasks not yet inside tabs
        vm.runInContext(`
            _batchTableState.tabs = [
                { id: 'tab_open', name: '早班号1', group: '分组A', hidden: false, tasks: [{ id: 'task_a1', baseName: 'vA1', bgPath: 'C:/a1.mp4', _batchTabId: 'tab_open', _batchTabName: '早班号1' }] },
                { id: 'tab_bg', name: '晚班号2', group: '分组B', hidden: true, tasks: [{ id: 'task_b1', baseName: 'vB1', bgPath: 'C:/b1.mp4' }] },
                { id: 'tab_combined', name: '批量导入任务', group: '', hidden: false, _externalFolderQueuesCombined: true, tasks: [
                    { id: 'task_q1', baseName: 'vq1', bgPath: 'C:/q1.mp4', _batchTabId: 'tab_combined', _folderQueueId: 'q_1', _folderQueueName: '队列账号X' },
                    { id: 'task_q2', baseName: 'vq2', bgPath: 'C:/q2.mp4', _batchTabId: 'tab_combined', _folderQueueId: 'q_2', _folderQueueName: '队列账号Y' }
                ] }
            ];
            _batchTableState.activeTabId = 'tab_open';
            _batchTableState.nextTabId = 10;
            window._reelsState.tasks = [
                { id: 'task_a1', baseName: 'vA1', bgPath: 'C:/a1.mp4', _batchTabId: 'tab_open', _batchTabName: '早班号1', _batchProjection: true },
                { id: 'task_orphan', baseName: 'vo1', bgPath: 'C:/o1.mp4', _folderQueueId: 'q_3', _folderQueueName: '新拖入账号Z' }
            ];
        `, sandbox);

        const groups = JSON.parse(JSON.stringify(sandbox.window.reelsCollectWorkspaceProjectGroups()));
        assert.equal(groups.length, 5);
        assert.deepEqual(groups.map(g => g.name), ['早班号1', '晚班号2', '队列账号X', '队列账号Y', '新拖入账号Z']);
        assert.equal(groups[1].hidden, true);

        const cand = JSON.parse(JSON.stringify(sandbox.window.reelsGetWorkspaceSaveCandidateInfo()));
        assert.equal(cand.totalGroups, 5);
        assert.equal(cand.unarchivedGroups.length, 5);
        assert.deepEqual(cand.groupNames, ['分组A', '分组B']);

        // Auto-archive with group subfolders enabled
        const ok1 = await sandbox.window.reelsAutoArchiveWorkspaceToLibrary({
            folderName: '我的自动工程',
            splitByGroup: true,
            captureThumbnails: false,
        });
        assert.equal(ok1, true);

        const foldersAfter = tplService.readLiveProjectFolders();
        const rootFolder = foldersAfter.folders.find(f => f.name === '我的自动工程');
        assert.ok(rootFolder);
        const subA = foldersAfter.folders.find(f => f.parentId === rootFolder.id && f.name === '分组A');
        const subB = foldersAfter.folders.find(f => f.parentId === rootFolder.id && f.name === '分组B');
        assert.ok(subA && subB);

        const listAfter = tplService.listLiveProjects();
        assert.equal(listAfter.length, 5);
        assert.equal(tplService.listTemplates().length, 0, 'Auto-archiving live workspace must keep sealed templates store isolated');
        assert.ok(listAfter.every(t => !t.name.includes('[Q-')), 'Clean tab names should not append [Q-xxxx]');
        assert.equal(foldersAfter.assignments[listAfter.find(t => t.name === '早班号1').id], subA.id);
        assert.equal(foldersAfter.assignments[listAfter.find(t => t.name === '晚班号2').id], subB.id);
        assert.equal(foldersAfter.assignments[listAfter.find(t => t.name === '队列账号X').id], rootFolder.id);

        // Verify combined tab was cleanly split into promoted real tabs & bound with libraryTemplateId
        const boundTabState = JSON.parse(vm.runInContext(`JSON.stringify(_batchTableState.tabs.map(t => ({
            name: t.name, hidden: t.hidden, tplId: t.libraryTemplateId, fId: t.libraryFolderId
        })))`, sandbox));
        assert.equal(boundTabState.length, 5);
        assert.ok(boundTabState.every(t => !!t.tplId && !!t.fId));
        assert.equal(boundTabState.find(t => t.name === '晚班号2').hidden, true);

        // Next, verify single-folder auto-archive without subgroup split binds activeLibraryFolderId immediately
        vm.runInContext(`
            _batchTableState.tabs.forEach(t => { t.libraryTemplateId = ''; t.libraryFolderId = ''; t.group = ''; });
            _batchTableState.activeLibraryFolderId = '';
        `, sandbox);
        const ok2 = await sandbox.window.reelsAutoArchiveWorkspaceToLibrary({
            folderName: '统一管理工程',
            splitByGroup: false,
            captureThumbnails: false,
        });
        assert.equal(ok2, true);
        const unifiedState = JSON.parse(vm.runInContext(`JSON.stringify({
            folderId: _batchTableState.activeLibraryFolderId,
            folderPath: _batchTableState.activeLibraryFolderPath,
            barHtml: document.getElementById('reels-active-folder-bar').innerHTML
        })`, sandbox));
        const unifiedFolder = tplService.readLiveProjectFolders().folders.find(f => f.name === '统一管理工程');
        assert.equal(unifiedState.folderId, unifiedFolder.id);
        assert.match(unifiedState.folderPath, /统一管理工程/);
        assert.match(unifiedState.barHtml, /统一管理工程/);

        // Verify multi-format tab recognition in _extractTabsFromProjectPayload
        const p200 = JSON.parse(JSON.stringify(sandbox.window.reelsExtractTabsFromProjectPayload({
            version: '2.0.0',
            tabs: [
                { id: 't1', name: '标签一', group: '组1', tasks: [{ baseName: 'a' }] },
                { id: 't2', name: '标签二', group: '组2', tasks: [{ baseName: 'b' }] },
            ],
        }, '测试文件')));
        assert.equal(p200.mode, 'multi-tab');
        assert.equal(p200.items.length, 2);
        assert.equal(p200.items[0].group, '组1');

        const pWrapped = JSON.parse(JSON.stringify(sandbox.window.reelsExtractTabsFromProjectPayload({
            name: '打包卡片',
            projectData: {
                version: '2.0.0',
                tasks: [
                    { baseName: 'q1a', _folderQueueId: 'qf1', _folderQueueName: '内部标签1' },
                    { baseName: 'q2a', _folderQueueId: 'qf2', _folderQueueName: '内部标签2' },
                ],
            },
        }, '打包卡片')));
        assert.equal(pWrapped.mode, 'multi-tab');
        assert.deepEqual(pWrapped.items.map(i => i.name), ['内部标签1', '内部标签2']);

        const pFlatSingle = JSON.parse(JSON.stringify(sandbox.window.reelsExtractTabsFromProjectPayload({
            version: '2.0.0',
            tasks: [{ baseName: 'single_1' }, { baseName: 'single_2' }],
        }, '独立工程JSON')));
        assert.equal(pFlatSingle.mode, 'single');
        assert.equal(pFlatSingle.items[0].name, '独立工程JSON');
        assert.equal(pFlatSingle.items[0].projectData.tasks.length, 2);
    } finally {
        Module._load = origLoad;
        delete require.cache[templatesResolved];
        fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
});

test('Christmas default theme and update reminder prefs (stable ON by default, beta OFF by default with warning remark)', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');
    const updaterSrc = fs.readFileSync(path.join(ROOT, 'electron/updater.js'), 'utf8');
    const studioSrc = fs.readFileSync(path.join(ROOT, 'src/studio/main.js'), 'utf8');

    // 1) UI & preload expose default Christmas action + update reminder switches
    assert.ok(htmlSrc.includes(`onclick="applyTheme('christmas-eve')"`), 'Settings reset-default theme button must restore christmas-eve');
    assert.ok(htmlSrc.includes('id="update-notify-stable-checkbox" checked'), 'Stable update reminder checkbox must default to checked');
    const betaInputTag = htmlSrc.match(/<input[^>]*id="update-notify-beta-checkbox"[^>]*>/)?.[0] || '';
    assert.ok(betaInputTag && !/\schecked(?:\s|>|=)/i.test(betaInputTag), 'Beta update reminder checkbox must default to unchecked');
    assert.ok(preloadSrc.includes("getUpdatePrefs: () => ipcRenderer.invoke('get-update-prefs')"));
    assert.ok(preloadSrc.includes("setUpdatePrefs: (prefs) => ipcRenderer.invoke('set-update-prefs', prefs)"));
    assert.match(studioSrc, /function resolveCurrentThemeId[\s\S]*?return 'christmas-eve';/);

    // 2) updater.js defaults notifyStableUpdates=true, notifyBetaUpdates=false and registers prefs IPCs
    const Module = require('node:module');
    const updaterResolved = require.resolve(path.join(ROOT, 'electron/updater.js'));
    const origLoad = Module._load;
    const storeMap = new Map();
    const ipcHandlers = new Map();
    const sentEvents = [];
    const autoUpdaterMock = {
        allowPrerelease: false,
        allowDowngrade: false,
        autoDownload: true,
        autoInstallOnAppQuit: false,
        on() {},
        checkForUpdates: async () => ({ updateInfo: { version: '4.6.0' } }),
    };

    try {
        Module._load = function patchedLoad(request, parent, isMain) {
            if (request === 'electron') {
                return {
                    app: { getVersion: () => '4.6.0', isPackaged: false, exit() {}, relaunch() {}, releaseSingleInstanceLock() {} },
                    BrowserWindow: { getAllWindows: () => [] },
                    ipcMain: { handle: (ch, fn) => ipcHandlers.set(ch, fn) },
                    dialog: { showMessageBox: async () => ({ response: 0 }) },
                };
            }
            if (request === 'electron-updater') return { autoUpdater: autoUpdaterMock };
            if (request === 'electron-store') {
                return class MockStore {
                    get(k, def) { return storeMap.has(k) ? storeMap.get(k) : def; }
                    set(k, v) { storeMap.set(k, v); }
                };
            }
            if (request === './services/trustedRenderer') {
                return { assertTrustedRenderer() {} };
            }
            return origLoad.apply(this, arguments);
        };
        delete require.cache[updaterResolved];
        const { initAutoUpdater } = require(updaterResolved);
        const mockWin = { isDestroyed: () => false, webContents: { send: (ch, data) => sentEvents.push({ ch, data }) } };
        initAutoUpdater(mockWin, () => {});

        const getPrefsFn = ipcHandlers.get('get-update-prefs');
        const setPrefsFn = ipcHandlers.get('set-update-prefs');
        assert.ok(typeof getPrefsFn === 'function' && typeof setPrefsFn === 'function', 'Updater must register pref IPC handlers');

        const initial = getPrefsFn({});
        assert.strictEqual(initial.notifyStable, true, 'notifyStable must default to true');
        assert.strictEqual(initial.notifyBeta, false, 'notifyBeta must default to false');
        assert.strictEqual(initial.channel, 'stable');

        const enabledBeta = setPrefsFn({}, { notifyBeta: true });
        assert.strictEqual(enabledBeta.notifyBeta, true);
        assert.strictEqual(enabledBeta.channel, 'beta');
        assert.strictEqual(autoUpdaterMock.allowPrerelease, true);

        const disabledBeta = setPrefsFn({}, { notifyBeta: false });
        assert.strictEqual(disabledBeta.notifyBeta, false);
        assert.strictEqual(disabledBeta.channel, 'stable');
        assert.strictEqual(autoUpdaterMock.allowPrerelease, false);
    } finally {
        Module._load = origLoad;
        delete require.cache[updaterResolved];
    }

    assert.ok(updaterSrc.includes('发现测试版 v${version}，是否尝试？（备注：测试版本不稳定，不建议尝试）'));
    assert.ok(updaterSrc.includes('最终版本 v${version} 更新了，是否尝试？'));

    // 3) Renderer toast gating & copy for stable vs beta updates
    const escMatch = appSrc.match(/function escapeHtml\(str\)\s*\{[\s\S]*?\n\}/);
    const helperMatch = appSrc.match(/const _appUpdateUiState = \{[\s\S]*?async function _installDownloadedAppUpdate\(\)\s*\{[\s\S]*?\n\}/);
    assert.ok(escMatch && helperMatch);

    const created = new Map();
    const localMap = new Map();
    const makeClassList = () => {
        const set = new Set();
        return {
            add: (...cls) => cls.forEach((c) => set.add(c)),
            remove: (...cls) => cls.forEach((c) => set.delete(c)),
            contains: (c) => set.has(c),
        };
    };
    const makeEl = (tag) => {
        const attrs = {};
        return {
            tagName: tag.toUpperCase(),
            id: '',
            classList: makeClassList(),
            dataset: {},
            innerHTML: '',
            setAttribute: (k, v) => { attrs[k] = String(v); },
            getAttribute: (k) => attrs[k] || null,
            querySelectorAll: () => [],
            querySelector: () => null,
        };
    };

    const sandbox = {
        requestAnimationFrame: (fn) => fn(),
        localStorage: {
            getItem: (k) => (localMap.has(k) ? localMap.get(k) : null),
            setItem: (k, v) => localMap.set(k, String(v)),
        },
        window: { electronAPI: { downloadUpdate: async () => ({ success: true }), installUpdate: async () => ({ success: true }) } },
        document: {
            body: { appendChild(el) { if (el.id) created.set(el.id, el); } },
            getElementById: (id) => created.get(id) || null,
            createElement: makeEl,
            querySelector: () => null,
        },
        showToast: () => {},
    };
    vm.runInNewContext(
        `${escMatch[0]}\n${helperMatch[0]}\nthis._handleAppUpdateStatusEvent = _handleAppUpdateStatusEvent;\nthis._dismissUpdateCornerToast = _dismissUpdateCornerToast;\nthis._appUpdateUiState = _appUpdateUiState;\nthis._writeUpdateNotifyPrefsToStorage = _writeUpdateNotifyPrefsToStorage;`,
        sandbox
    );

    // Default: notifyBeta=false -> background beta update stays suppressed
    sandbox._handleAppUpdateStatusEvent({ status: 'available', version: '4.6.1-beta.1', isBeta: true });
    assert.strictEqual(created.get('vk-update-toast'), undefined, 'Background beta notification must stay suppressed when notifyBeta is off');

    // Default: notifyStable=true -> background final release pops up with expected wording
    sandbox._handleAppUpdateStatusEvent({ status: 'available', version: '4.6.1', isBeta: false });
    const toast = created.get('vk-update-toast');
    assert.ok(toast && toast.classList.contains('is-visible'));
    assert.ok(toast.innerHTML.includes('最终版本更新了，是否尝试？'), 'Stable prompt must tell user final version updated and ask whether to try');
    sandbox._dismissUpdateCornerToast(false);

    // Turn ON beta reminder -> background beta notification shows with explicit unstable warning remark
    sandbox._writeUpdateNotifyPrefsToStorage({ notifyBeta: true });
    sandbox._handleAppUpdateStatusEvent({ status: 'available', version: '4.6.1-beta.2', isBeta: true });
    assert.ok(toast.classList.contains('is-visible'), 'Enabled beta reminder must show beta update toast');
    assert.ok(toast.innerHTML.includes('是否尝试？'), 'Beta toast must ask whether to try');
    assert.ok(toast.innerHTML.includes('备注：测试版本不稳定，不建议尝试'), 'Beta toast must display unstable warning remark');
    sandbox._dismissUpdateCornerToast(false);

    // Turn OFF stable reminder -> background stable notification suppressed, manual check still shows
    sandbox._writeUpdateNotifyPrefsToStorage({ notifyStable: false });
    sandbox._handleAppUpdateStatusEvent({ status: 'available', version: '4.6.2', isBeta: false });
    assert.ok(!toast.classList.contains('is-visible'), 'Background stable toast must stay hidden when notifyStable is disabled');
    sandbox._handleAppUpdateStatusEvent({ status: 'available', version: '4.6.2', isBeta: false, manual: true });
    assert.ok(toast.classList.contains('is-visible'), 'Manual update check must still show toast even if background reminder is muted');
});

test('Decor panel supports explicit apply-this-page (task) and apply-this-tab (tab) options without leaking across tabs', () => {
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');

    // 1. UI controls exist in both ReelsDecorPanel and inline ReelsOverlayPanel decor props
    for (const id of [
        'rdp-apply-page-btn',
        'rdp-apply-tab-btn',
        'rdp-scope-badge',
        'rop-decor-apply-page-btn',
        'rop-decor-apply-tab-btn',
    ]) {
        assert.ok(panelSrc.includes(`id="${id}"`), `Missing decor scope control #${id}`);
    }
    assert.match(panelSrc, /<select id="rdp-style-scope"[\s\S]*?<option value="task">[\s\S]*?<option value="tab">/);
    assert.match(panelSrc, /<select id="rop-style-scope"[\s\S]*?<option value="task">[\s\S]*?<option value="tab">/);
    assert.ok(cssSrc.includes('.rdp-scope-btn.is-active'), 'styles.css must style active decor scope buttons');
    assert.ok(!panelSrc.includes("mainScope.dispatchEvent(new Event('change'))"), 'Changing decor scope must not dispatch #rop-style-scope change to overwrite non-decor overlays');

    // 2. Behavioral verification via VM sandbox
    const makeDomEl = (initial = {}) => ({
        value: initial.value ?? '',
        checked: initial.checked ?? false,
        textContent: '',
        style: {},
        _classes: new Set(),
        classList: {
            toggle(name, force) {
                const on = force === undefined ? !this._set.has(name) : Boolean(force);
                if (on) this._set.add(name); else this._set.delete(name);
            },
            contains(name) { return this._set.has(name); },
            _set: new Set(),
        },
        listeners: {},
        addEventListener(ev, fn) { this.listeners[ev] = fn; },
    });

    const rdpScopeEl = makeDomEl({ value: 'folder' });
    const rdpApplyAllEl = makeDomEl({ checked: true });
    const rdpPageBtn = makeDomEl();
    const rdpTabBtn = makeDomEl();
    const rdpBadge = makeDomEl();
    const ropScopeEl = makeDomEl({ value: 'folder' });
    const ropDecorApplyAllEl = makeDomEl({ checked: true });

    const rdpMap = {
        '#rdp-style-scope': rdpScopeEl,
        '#rdp-apply-all': rdpApplyAllEl,
        '#rdp-apply-page-btn': rdpPageBtn,
        '#rdp-apply-tab-btn': rdpTabBtn,
        '#rdp-scope-badge': rdpBadge,
    };
    const ropMap = {
        '#rop-style-scope': ropScopeEl,
        '#rop-decor-apply-all': ropDecorApplyAllEl,
    };

    const tA1 = {
        id: 'tA1',
        _batchTabId: 'tabA',
        _folderQueueId: 'q1',
        overlays: [
            { id: 'card_A1', type: 'textcard', body_text: 'Keep A1 card' },
            { id: 'dec_A1', type: 'decor', decor_style: 'xmas_holly_pine_garland', opacity: 255 },
        ],
    };
    const tA2 = {
        id: 'tA2',
        _batchTabId: 'tabA',
        _folderQueueId: 'q2',
        overlays: [
            { id: 'card_A2', type: 'textcard', body_text: 'Keep A2 card' },
        ],
    };
    const tA3Hidden = {
        id: 'tA3',
        _batchTabId: 'tabA',
        _folderQueueId: 'q2',
        overlays: [
            { id: 'card_A3', type: 'textcard', body_text: 'Keep hidden A3 card' },
        ],
    };
    const tB1 = {
        id: 'tB1',
        _batchTabId: 'tabB',
        _folderQueueId: 'qB',
        overlays: [
            { id: 'card_B1', type: 'textcard', body_text: 'Keep B1 card' },
            { id: 'dec_B1', type: 'decor', decor_style: 'cinema_35mm_grain', opacity: 255 },
        ],
    };
    const tC1Singleton = {
        id: 'tC1',
        _batchTabId: 'tabC',
        _folderQueueId: 'qC',
        overlays: [],
    };

    const toasts = [];
    const sandbox = {
        console,
        document: {
            head: { appendChild: () => {} },
            getElementById: (id) => ({
                'rop-style-scope': ropScopeEl,
                'rop-decor-apply-all': ropDecorApplyAllEl,
                'rdp-style-scope': rdpScopeEl,
                'rdp-apply-all': rdpApplyAllEl,
            }[id] || null),
            createElement: () => makeDomEl(),
        },
        _batchTableState: {
            activeTabId: 'tabA',
            tabs: [
                { id: 'tabA', name: 'Tab A', tasks: [tA1, tA2, tA3Hidden], _dirty: false },
                { id: 'tabB', name: 'Tab B', tasks: [tB1], _dirty: false },
                { id: 'tabC', name: 'Tab C', tasks: [tC1Singleton], _dirty: false },
            ],
        },
        _reelsState: {
            tasks: [tA1, tA2, tB1],
            selectedIdx: 0,
        },
        _syncTasksToActiveTab: () => {},
        _batchAutoSave: () => {},
        _renderTaskList: () => {},
        showToast: (msg, type) => toasts.push({ msg, type }),
        localStorage: { getItem: () => null, setItem: () => {} },
        requestAnimationFrame: (cb) => { cb(); return 1; },
        cancelAnimationFrame: () => {},
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`${panelSrc}\nwindow.ReelsOverlayPanel = ReelsOverlayPanel;\nwindow.ReelsDecorPanel = ReelsDecorPanel;`, sandbox);

    const ovPanel = Object.create(sandbox.ReelsOverlayPanel.prototype);
    ovPanel.container = { querySelector: (sel) => ropMap[sel] || null };
    ovPanel.videoCanvas = { overlayMgr: { overlays: tA1.overlays } };

    const decorPanel = Object.create(sandbox.ReelsDecorPanel.prototype);
    decorPanel.container = { querySelector: (sel) => rdpMap[sel] || null, querySelectorAll: () => [] };
    decorPanel.linkedOverlayPanel = ovPanel;
    decorPanel.videoCanvas = {
        overlayMgr: { overlays: tA1.overlays },
        onOverlayChange: () => {},
    };

    // Case A: Singleton batch tab under 'folder' must NOT leak to other tabs
    sandbox._reelsState.tasks = [tC1Singleton, tB1];
    sandbox._reelsState.selectedIdx = 0;
    const singletonFolderTasks = ovPanel._getStyleApplyScopeTasks('folder');
    assert.deepStrictEqual(singletonFolderTasks.map(t => t.id), ['tC1'], 'Singleton folder queue inside a batch tab must stay inside its own tab');

    // Case B: Apply to this tab ('tab') copies decor across all subgroups & hidden tasks of tabA, leaves tabB untouched
    sandbox._reelsState.tasks = [tA1, tA2, tB1];
    sandbox._reelsState.selectedIdx = 0;
    decorPanel.applyDecorScopeMode('tab', { toast: true });

    assert.strictEqual(rdpScopeEl.value, 'tab');
    assert.strictEqual(rdpApplyAllEl.checked, true);
    assert.ok(rdpTabBtn.classList.contains('is-active'), 'Apply-this-tab button must highlight in tab mode');
    assert.ok(!rdpPageBtn.classList.contains('is-active'));
    assert.strictEqual(tA2.overlays.find(o => o.type === 'decor')?.decor_style, 'xmas_holly_pine_garland', 'tA2 in another subgroup of same tab must receive decor');
    assert.strictEqual(tA3Hidden.overlays.find(o => o.type === 'decor')?.decor_style, 'xmas_holly_pine_garland', 'Hidden task tA3 in same tab must receive decor');
    assert.strictEqual(tA2.overlays.find(o => o.type === 'textcard')?.body_text, 'Keep A2 card', 'Existing textcard overlay in tA2 must stay intact');
    assert.strictEqual(tB1.overlays.find(o => o.type === 'decor')?.decor_style, 'cinema_35mm_grain', 'Other tab tB1 decor must remain untouched');
    assert.strictEqual(sandbox._batchTableState.tabs[0]._dirty, true, 'Synced tabA must be marked dirty');
    assert.ok(toasts.some(t => t.msg.includes('应用到本标签页')));

    // Case C: Switch to Apply-This-Page Only ('task') -> later edits on tA1 stay isolated to tA1
    decorPanel.applyDecorScopeMode('task', { toast: true });
    assert.strictEqual(rdpScopeEl.value, 'task');
    assert.strictEqual(rdpApplyAllEl.checked, false);
    assert.strictEqual(ropDecorApplyAllEl.checked, false);
    assert.ok(rdpPageBtn.classList.contains('is-active'), 'Apply-this-page button must highlight in task mode');
    assert.ok(!rdpTabBtn.classList.contains('is-active'));

    tA1.overlays.find(o => o.type === 'decor').decor_style = 'glowing_starfield';
    decorPanel._syncDecorStackToScopeTasks();
    assert.strictEqual(tA2.overlays.find(o => o.type === 'decor')?.decor_style, 'xmas_holly_pine_garland', 'In task (apply-this-page) mode, sibling tA2 in same tab must NOT be overwritten');
    assert.strictEqual(tB1.overlays.find(o => o.type === 'decor')?.decor_style, 'cinema_35mm_grain', 'In task mode, tabB must remain untouched');
});

test('All 214 scroll presets (sc-01..sc-214) + all 31 boards & 78 emblems render cleanly without collapsing variants', () => {
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

    const { ReelsOverlay, ReelsBrushEngine, REELS_BUILTIN_SCROLL_STYLE_PRESETS, REELS_SCROLL_PRESET_ID_MAP, resolveBuiltinPreset } = sandbox.window;

    assert.strictEqual(Object.keys(REELS_BUILTIN_SCROLL_STYLE_PRESETS).length, 214, 'Expected all 214 built-in scroll style presets');
    assert.strictEqual(Object.keys(REELS_SCROLL_PRESET_ID_MAP).length, 428, 'Expected all 428 scroll preset ID mappings (sc-01..214 & scroll-01..214)');

    const newBoardIds = [
        'kraft_torn_note', 'kraft_stamped_letter', 'kraft_espresso_prayer',
        'minimal_ivory_stationery', 'minimal_sage_linen', 'minimal_blush_vellum', 'minimal_slate_clean',
        'plaid_buffalo_red', 'plaid_country_gingham', 'plaid_heritage_beige', 'plaid_forest_tartan', 'plaid_pastel_lilac',
        'vintage_aged_manuscript', 'vintage_botanical_herbarium', 'vintage_hymnal_navy',
        'old_photo_sepia_mount', 'old_photo_polaroid_frame', 'old_photo_film_strip', 'old_photo_archive_matte',
    ];
    const newXmasBoardIds = [
        'xmas_burgundy_gold_foil', 'xmas_royal_tartan_plaid', 'xmas_nativity_bethlehem',
        'xmas_cathedral_stained_glass', 'xmas_kraft_winter_botanical', 'xmas_cotton_letterpress',
        'xmas_winter_sage_wreath', 'xmas_candlelit_hearth', 'xmas_frosted_ice_silver',
        'xmas_advent_violet_gold', 'xmas_evergreen_crimson_plaid', 'xmas_silent_night_hymnal',
    ];
    for (const bid of [...newBoardIds, ...newXmasBoardIds]) {
        assert.ok(ReelsBrushEngine.CARD_BACKGROUND_STYLES[bid], `CARD_BACKGROUND_STYLES must define ${bid}`);
    }

    const emblemMeta = ReelsOverlay.NA_PRAYER_EMBLEM_META;
    const emblemKeys = Object.keys(emblemMeta || {});
    assert.strictEqual(emblemKeys.length, 78, 'Expected 78 North American, Catholic, Christmas & Thanksgiving emblems in NA_PRAYER_EMBLEM_META');
    for (const thxKey of ['na_thx_maple', 'na_thx_wheat', 'na_thx_acorn', 'na_thx_heirloom_pumpkin', 'na_thx_autumn_mug', 'na_thx_olive_wreath']) {
        assert.ok(emblemMeta[thxKey], `Expected Thanksgiving emblem "${thxKey}" in NA_PRAYER_EMBLEM_META`);
    }

    const drawCalls = { fillText: 0, translate: 0 };
    const mockCtx = {
        canvas: { width: 1080, height: 1920 },
        font: '700 44px Lora',
        fillStyle: '#FFFFFF',
        strokeStyle: '#000000',
        lineWidth: 1,
        lineCap: 'round',
        lineJoin: 'round',
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
        translate() { drawCalls.translate++; },
        rotate() {},
        scale() {},
        setLineDash() {},
        fill() {},
        stroke() {},
        fillRect() {},
        strokeRect() {},
        clearRect() {},
        drawImage() {},
        fillText() { drawCalls.fillText++; },
        strokeText() {},
        measureText(t) { return { width: String(t || '').length * 20 }; },
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
        createPattern() { return null; },
    };

    // 1. Validate & render all 214 scroll presets sc-01..sc-214 directly without alias collapsing
    const seenNames = new Set();
    const seenCardBoardsInNaSpecs = new Set();
    const seenCategories = new Set();
    const seenXmasEmblems = new Set();
    for (let num = 1; num <= 214; num++) {
        const pad = num < 10 ? `0${num}` : `${num}`;
        const scId = `sc-${pad}`;
        const aliasId = `scroll-${pad}`;
        const resolved = resolveBuiltinPreset(scId);
        const aliasResolved = resolveBuiltinPreset(aliasId);
        assert.ok(resolved && resolved.kind === 'scroll_style' && resolved.style, `${scId} must resolve`);
        assert.strictEqual(resolved.id, scId, `${scId} must resolve directly to itself without collapsing`);
        assert.ok(aliasResolved && aliasResolved.name === resolved.name, `${aliasId} must alias ${resolved.name}`);
        assert.ok(!seenNames.has(resolved.name), `Duplicate scroll style name: ${resolved.name}`);
        seenNames.add(resolved.name);
        seenCategories.add(resolved.category);
        const style = resolved.style;
        if (style.bg_enabled && style.bg_style) {
            assert.ok(ReelsBrushEngine.CARD_BACKGROUND_STYLES[style.bg_style], `${scId} bg_style ${style.bg_style} must exist`);
        }
        if (num >= 49) {
            seenCardBoardsInNaSpecs.add(style.bg_style);
            assert.strictEqual(style.bg_width, 0, `${scId} card width must auto-follow subtitle clip box (bg_width === 0)`);
            assert.strictEqual(style.bg_height, 0, `${scId} card height must auto-follow subtitle clip box (bg_height === 0)`);
            assert.strictEqual(style.bg_scroll_follow, true, `${scId} must enable bg_scroll_follow`);
            assert.strictEqual(style.feather_mode, 'clip', `${scId} must use clip feathering so card and text fade/expand together`);
        }
        if (num >= 149 && num <= 198) {
            if (style.bg_bookmark_style) seenXmasEmblems.add(style.bg_bookmark_style);
            if (style.bg_top_mascot && style.bg_top_mascot !== 'none') seenXmasEmblems.add(style.bg_top_mascot);
        }

        const ov = ReelsOverlay.createScrollOverlay({
            ...resolved.style,
            scroll_title: num >= 149 && num <= 198 ? 'CHRISTMAS BLESSING' : 'MORNING PRAYER',
            content: 'Heavenly Father, thank You for grace.\nGuide our steps in peace today.\nAmen.',
            x: 40,
            y: 440,
            w: 1000,
            h: 980,
            start: 0,
            end: 12,
            _taskSegments: [
                { start: 0, end: 4, text: 'Heavenly Father, thank You for grace.' },
                { start: 4, end: 8, text: 'Guide our steps in peace today.' },
                { start: 8, end: 12, text: 'Amen.' },
            ],
        });
        ReelsOverlay.drawOverlay(mockCtx, ov, 3.2, 1080, 1920);
    }

    assert.ok(seenCategories.size >= 16, `Expected full scroll preset categories, got ${seenCategories.size}`);
    assert.ok(drawCalls.fillText > 200, 'Expected fillText calls when rendering all 214 presets');
    for (const bid of [...newBoardIds, ...newXmasBoardIds]) {
        assert.ok(seenCardBoardsInNaSpecs.has(bid), `At least one sc-49..sc-198 preset must showcase board ${bid}`);
    }
    const expectedXmasEmblems = emblemKeys.filter(k => k.startsWith('na_xmas_'));
    assert.strictEqual(expectedXmasEmblems.length, 12, 'Expected 12 na_xmas_* emblems');
    for (const eid of expectedXmasEmblems) {
        assert.ok(seenXmasEmblems.has(eid), `Christmas presets sc-149..sc-198 must feature emblem ${eid}`);
    }

    // Verify every single board definition in newBoardIds + newXmasBoardIds still draws cleanly via createScrollOverlay
    for (const bid of [...newBoardIds, ...newXmasBoardIds]) {
        const ovBoard = ReelsOverlay.createScrollOverlay({
            scroll_title: 'BLESSING',
            content: 'Grace and peace to your home.',
            bg_enabled: true,
            bg_style: bid,
            bg_scroll_follow: true,
            start: 0,
            end: 8,
        });
        ReelsOverlay.drawOverlay(mockCtx, ovBoard, 2.0, 1080, 1920);
    }

    // 2. Render all 72 NA & Christmas emblems both as corner ribbon badge AND top crest mascot
    for (const emblemId of emblemKeys) {
        const ovBadgeAndMascot = ReelsOverlay.createScrollOverlay({
            scroll_title: 'BLESSING',
            content: 'Peace and hope be with you.',
            bg_enabled: true,
            bg_style: 'kraft_torn_note',
            bg_bookmark_enabled: true,
            bg_bookmark_style: emblemId,
            bg_top_mascot: emblemId,
            start: 0,
            end: 8,
        });
        ReelsOverlay.drawOverlay(mockCtx, ovBadgeAndMascot, 2.5, 1080, 1920);
    }
});

test('Atmospheric Scroll Style Preview Studio Modal (.rsl-dialog): categories, material filters, live search, HD stage text update, and Apply', () => {
    const cssSrc = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
    for (const cls of ['.rsl-backdrop', '.rsl-dialog', '.rsl-body', '.rsl-aside', '.rsl-grid', '.rsl-stage', '.rsl-stage-canvas', '.rsl-apply-cta']) {
        assert.ok(cssSrc.includes(cls), `src/styles.css must define spacious scroll studio selector ${cls}`);
    }

    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    const makeClassList = (initial = []) => {
        const set = new Set(initial.filter(Boolean));
        return {
            _set: set,
            add(...names) { names.forEach(n => set.add(n)); },
            remove(...names) { names.forEach(n => set.delete(n)); },
            toggle(name, force) {
                const on = force === undefined ? !set.has(name) : Boolean(force);
                if (on) set.add(name); else set.delete(name);
                return on;
            },
            contains(name) { return set.has(name); },
        };
    };
    const makeCanvasMock = (w = 216, h = 384) => ({
        width: w,
        height: h,
        dataset: {},
        style: {},
        classList: makeClassList(),
        listeners: {},
        addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
        dispatchEvent(ev) { (this.listeners[ev.type] || []).forEach(fn => fn({ currentTarget: this, target: this, stopPropagation() {}, ...ev })); },
        getContext() {
            return {
                canvas: { width: w, height: h },
                save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
                quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, ellipse() {}, rect() {}, clip() {},
                translate() {}, rotate() {}, scale() {}, setLineDash() {}, fill() {}, stroke() {},
                fillRect() {}, strokeRect() {}, clearRect() {}, drawImage() {},
                fillText() {}, strokeText() {},
                measureText(t) { return { width: String(t || '').length * 16 }; },
                createLinearGradient() { return { addColorStop() {} }; },
                createRadialGradient() { return { addColorStop() {} }; },
                createPattern() { return null; },
            };
        },
    });
    const makeNode = (opts = {}) => {
        const classList = makeClassList(opts.classes || []);
        const node = {
            id: opts.id || '',
            value: opts.value || '',
            textContent: opts.textContent || '',
            innerHTML: '',
            style: {},
            dataset: { ...(opts.dataset || {}) },
            classList,
            get className() { return Array.from(classList._set).join(' '); },
            set className(val) {
                classList._set.clear();
                String(val || '').split(/\s+/).filter(Boolean).forEach(n => classList._set.add(n));
            },
            isConnected: false,
            listeners: {},
            childrenMap: {},
            addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
            dispatchEvent(ev = {}) {
                const evt = { type: ev.type || 'click', currentTarget: node, target: ev.target || node, key: ev.key || '', stopPropagation() {}, ...ev };
                (this.listeners[evt.type] || []).forEach(fn => fn(evt));
            },
            focus() {},
            remove() { node.isConnected = false; if (appendedById[node.id] === node) delete appendedById[node.id]; },
            querySelector(sel) { return node.childrenMap[sel] || node.querySelectorAll(sel)[0] || null; },
            querySelectorAll(sel) { return node._allMap?.[sel] || []; },
        };
        return node;
    };

    const appendedById = {};
    const rafQueue = [];
    const docListeners = {};
    const drawOverlayCalls = [];

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

    const origDrawOverlay = sandbox.window.ReelsOverlay.drawOverlay.bind(sandbox.window.ReelsOverlay);
    sandbox.window.ReelsOverlay.drawOverlay = (ctx, ov, t, w, h) => {
        drawOverlayCalls.push({ id: ov.preset_id || '', title: ov.scroll_title, content: ov.content, t });
        return origDrawOverlay(ctx, ov, t, w, h);
    };

    const mockBody = {
        appendChild(el) {
            el.isConnected = true;
            if (el.id) appendedById[el.id] = el;
        },
    };
    const buildModalWrapper = () => {
        const m = makeNode();
        let rawHtml = '';
        Object.defineProperty(m, 'innerHTML', {
            get() { return rawHtml; },
            set(val) {
                rawHtml = String(val || '');
                const cards = [];
                const cardCanvases = [];
                const navBtns = [];
                const chips = [];
                const sceneBtns = [];
                const scriptBtns = [];

                const navRe = /<button[^>]*class="rsl-nav-btn(?:\s+active)?"[^>]*data-group="([^"]*)"/g;
                for (let match; (match = navRe.exec(rawHtml)) !== null;) {
                    navBtns.push(makeNode({ dataset: { group: match[1] }, classes: match[0].includes('active') ? ['rsl-nav-btn', 'active'] : ['rsl-nav-btn'] }));
                }
                const chipRe = /<button[^>]*class="rsl-chip"[^>]*data-flag="([^"]*)"/g;
                for (let match; (match = chipRe.exec(rawHtml)) !== null;) {
                    chips.push(makeNode({ dataset: { flag: match[1] }, classes: ['rsl-chip'] }));
                }
                const sceneRe = /data-scene="([^"]*)"/g;
                for (let match; (match = sceneRe.exec(rawHtml)) !== null;) {
                    sceneBtns.push(makeNode({ dataset: { scene: match[1] }, classes: match[1] === 'sanctuary' ? ['rsl-btn-sm', 'active'] : ['rsl-btn-sm'] }));
                }
                const scriptRe = /data-script="([^"]*)"/g;
                for (let match; (match = scriptRe.exec(rawHtml)) !== null;) {
                    scriptBtns.push(makeNode({ dataset: { script: match[1] } }));
                }
                const cardRe = /<article class="rsl-card([^"]*)" data-index="(\d+)" data-key="([^"]*)">/g;
                for (let match; (match = cardRe.exec(rawHtml)) !== null;) {
                    const cardNode = makeNode({
                        dataset: { index: match[2], key: match[3] },
                        classes: match[1].includes('is-selected') ? ['rsl-card', 'is-selected'] : ['rsl-card'],
                    });
                    const c = makeCanvasMock(216, 384);
                    c.dataset.index = match[2];
                    c.closest = () => cardNode;
                    const favBtn = makeNode({ classes: ['rsl-fav-btn'] });
                    const useBtn = makeNode({ classes: ['rsl-use-btn'] });
                    cardNode.childrenMap = { '.rsl-canvas': c, '.rsl-fav-btn': favBtn, '.rsl-use-btn': useBtn };
                    cards.push(cardNode);
                    cardCanvases.push(c);
                }

                const searchInput = makeNode({ id: 'rop-scroll-picker-search' });
                const closeBtn = makeNode({ id: 'rop-scroll-picker-close' });
                const readout = makeNode();
                const stageCanvas = makeCanvasMock(270, 480);
                const stageCode = makeNode();
                const stageName = makeNode();
                const stageFav = makeNode();
                const favCount = makeNode();
                const specs = makeNode();
                const scrub = makeNode({ value: '3.2' });
                const timeVal = makeNode();
                const playBtn = makeNode();
                const speedSel = makeNode({ value: '1' });
                const textArea = makeNode();
                const applyCta = makeNode();
                const gridPane = makeNode();

                m.childrenMap = {
                    '#rop-scroll-picker-search': searchInput,
                    '#rop-scroll-picker-close': closeBtn,
                    '.rsl-count-readout': readout,
                    '.rsl-stage-canvas': stageCanvas,
                    '.rsl-stage-code': stageCode,
                    '.rsl-stage-name': stageName,
                    '.rsl-stage-fav': stageFav,
                    '.rsl-fav-count': favCount,
                    '.rsl-specs': specs,
                    '.rsl-scrub': scrub,
                    '.rsl-time-val': timeVal,
                    '.rsl-play-btn': playBtn,
                    '.rsl-speed-sel': speedSel,
                    '.rsl-text-input': textArea,
                    '.rsl-apply-cta': applyCta,
                    '.rsl-grid-pane': gridPane,
                };
                m._allMap = {
                    '.rsl-card': cards,
                    '.rsl-canvas': cardCanvases,
                    '.rsl-canvas[data-rendered="1"]': [],
                    '.rsl-nav-btn': navBtns,
                    '.rsl-chip': chips,
                    '[data-scene]': sceneBtns,
                    '[data-script]': scriptBtns,
                };
            },
        });
        return m;
    };

    sandbox.document = {
        body: mockBody,
        head: { appendChild() {} },
        getElementById: (id) => appendedById[id] || null,
        createElement: (tag) => (tag === 'div' ? buildModalWrapper() : makeNode()),
        addEventListener: (ev, fn) => { (docListeners[ev] ||= []).push(fn); },
        removeEventListener: () => {},
    };
    sandbox.localStorage = { getItem: () => null, setItem: () => {} };
    sandbox.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
    sandbox.cancelAnimationFrame = () => {};
    sandbox.setTimeout = () => 1;
    sandbox.performance = { now: () => 1000 };
    sandbox.REELS_BUILTIN_SCROLL_STYLE_PRESETS = sandbox.window.REELS_BUILTIN_SCROLL_STYLE_PRESETS;
    sandbox._reelsState = sandbox.window._reelsState = { tasks: [], selectedIdx: 0 };

    vm.runInContext(`${panelSrc}\nwindow.ReelsOverlayPanel = ReelsOverlayPanel;`, sandbox);

    const appliedKeys = [];
    const panel = Object.create(sandbox.window.ReelsOverlayPanel.prototype);
    panel.container = makeNode();
    panel._selectedOv = { scroll_style_preset_id: 'sc-49', scroll_title: '' };
    panel._getCustomScrollStylePresets = () => ({});
    panel._applyScrollStylePresetByKey = (k) => appliedKeys.push(k);

    // 1. Open spacious scroll preview studio modal
    panel._openScrollStylePresetPicker(null);
    const modal = appendedById['rop-scroll-style-picker-popover'];
    assert.ok(modal && modal.classList.contains('rsl-backdrop'), 'Modal #rop-scroll-style-picker-popover must use rsl-backdrop class');
    assert.ok(modal.innerHTML.includes('rsl-dialog'), 'Modal must render centered .rsl-dialog');
    assert.strictEqual(modal.querySelectorAll('.rsl-card').length, 214, 'All 214 scroll cards must render inside studio grid');
    assert.ok(modal.querySelectorAll('.rsl-chip').length >= 12, 'Expected full material/element filter chips including life and christmas');
    assert.ok(rafQueue.length > 0, 'Lazy canvas thumbnail & stage RAF loops must be scheduled');

    // Flush lazy thumbnail pump batch (renders first 4 cards cleanly)
    const beforeThumbs = drawOverlayCalls.length;
    if (rafQueue.length > 0) rafQueue[0](1016);
    assert.ok(drawOverlayCalls.length > beforeThumbs, 'Lazy card pump should render card thumbnails onto canvases');

    // 2. Material chip filter ('oldphoto' & 'christmas') narrows visible cards cleanly
    const oldPhotoChip = modal.querySelectorAll('.rsl-chip').find(c => c.dataset.flag === 'oldphoto');
    assert.ok(oldPhotoChip, 'Expected 老照片 filter chip');
    oldPhotoChip.dispatchEvent({ type: 'click' });
    const visibleAfterChip = modal.querySelectorAll('.rsl-card').filter(c => c.style.display !== 'none');
    assert.ok(visibleAfterChip.length > 0 && visibleAfterChip.length < 214, 'Selecting oldphoto chip should filter cards');
    assert.ok(modal.querySelector('.rsl-count-readout').textContent.includes(`显示 ${visibleAfterChip.length} / 214`));

    // Verify Christmas chip shows all 50 Christmas cards sc-149..sc-198 (and does NOT include sc-199..sc-214 Thanksgiving cards)
    oldPhotoChip.dispatchEvent({ type: 'click' });
    const xmasChip = modal.querySelectorAll('.rsl-chip').find(c => c.dataset.flag === 'christmas');
    assert.ok(xmasChip, 'Expected 🎄 圣诞贺卡 filter chip');
    xmasChip.dispatchEvent({ type: 'click' });
    const xmasCards = modal.querySelectorAll('.rsl-card').filter(c => c.style.display !== 'none');
    assert.ok(xmasCards.length >= 50 && xmasCards.length < 214, `Expected >= 50 Christmas scroll cards without overflowing into sc-199..214, got ${xmasCards.length}`);

    // Verify Thanksgiving chip shows all 16 Thanksgiving cards sc-199..sc-214 minimalist autumn/prayer cards
    xmasChip.dispatchEvent({ type: 'click' });
    const thxChip = modal.querySelectorAll('.rsl-chip').find(c => c.dataset.flag === 'thanksgiving');
    assert.ok(thxChip, 'Expected 🍂 感恩节极简 filter chip');
    thxChip.dispatchEvent({ type: 'click' });
    const thxCards = modal.querySelectorAll('.rsl-card').filter(c => c.style.display !== 'none');
    assert.ok(thxCards.length >= 16 && thxCards.length < 214, `Expected >= 16 Thanksgiving scroll cards without leaking Christmas deck, got ${thxCards.length}`);

    // Clear chip & search for 白头鹰
    thxChip.dispatchEvent({ type: 'click' });
    const searchEl = modal.querySelector('#rop-scroll-picker-search');
    searchEl.value = '白头鹰';
    searchEl.dispatchEvent({ type: 'input' });
    const eagleCards = modal.querySelectorAll('.rsl-card').filter(c => c.style.display !== 'none');
    assert.ok(eagleCards.length >= 1 && eagleCards.length < 15, 'Searching 白头鹰 must match the bald eagle prayer preset(s)');

    // 3. Edit live stage sample prayer text & apply matched preset
    const customInput = modal.querySelector('.rsl-text-input');
    customInput.value = 'God bless this home with peace.\nAmen.';
    customInput.dispatchEvent({ type: 'input' });
    assert.ok(drawOverlayCalls.some(c => c.content === 'God bless this home with peace.\nAmen.'), 'Stage preview must re-render with user custom prayer text');

    eagleCards[0].dispatchEvent({ type: 'click' });
    modal.querySelector('.rsl-apply-cta').dispatchEvent({ type: 'click' });
    assert.strictEqual(appliedKeys.length, 1);
    assert.strictEqual(appliedKeys[0], eagleCards[0].dataset.key, 'One-click Apply must apply the selected preset key');
    assert.strictEqual(appendedById['rop-scroll-style-picker-popover'], undefined, 'Modal must close and clean up after applying');
});

test('Batch table keeps bottom .rbt-footer visible below window chrome bar and .rbt-folder-scope-bar', () => {
    const batchTableSrc = fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8');
    const stylesCss = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');

    assert.match(batchTableSrc, /\.rbt-panel\s*\{[^}]*max-height:\s*min\(100%,\s*calc\(100vh - var\(--window-chrome-height,\s*38px\) - 32px\)\)[^}]*box-sizing:\s*border-box;/);
    assert.match(batchTableSrc, /\.rbt-main-col\s*\{[^}]*max-height:\s*100%/);
    assert.match(batchTableSrc, /_fitBatchTableToViewport\(\);\s*_scheduleFitBatchTableToViewport\(\);/);
    assert.match(stylesCss, /\.rbt-folder-scope-bar\s*\{[^}]*flex-shrink:\s*0;/);
    assert.match(stylesCss, /\.rsl-backdrop\s*\{[^}]*inset:\s*var\(--window-chrome-height,\s*38px\)\s+0\s+0;/);
    assert.match(stylesCss, /\.rsl-dialog\s*\{[^}]*height:\s*min\(890px,\s*100%\);/);

    let containerRectH = 730;
    let containerClientH = 730;
    const makeRegion = (height) => ({
        style: {},
        offsetHeight: height,
        clientHeight: height,
        getBoundingClientRect: () => ({ height }),
    });
    const folderScopeBar = makeRegion(34);
    const tabbar = makeRegion(42);
    const header = makeRegion(36);
    const actionsPanel = makeRegion(220);
    const footer = makeRegion(40);
    const tableWrap = { style: {} };
    const panelSelectors = {
        '.rbt-folder-scope-bar': folderScopeBar,
        '.rbt-tabbar': tabbar,
        '.rbt-header': header,
        '.rbt-actions-panel': actionsPanel,
        '.rbt-footer': footer,
    };
    const panel = {
        style: {},
        offsetHeight: 700,
        clientHeight: 698,
        querySelector: (sel) => panelSelectors[sel] || null,
    };
    const containerSelectors = {
        '.rbt-panel': panel,
        '.rbt-table-wrap': tableWrap,
    };
    const container = {
        style: { display: 'flex' },
        get clientHeight() { return containerClientH; },
        getBoundingClientRect: () => ({ height: containerRectH }),
        querySelector: (sel) => containerSelectors[sel] || null,
    };
    const mockComputedStyle = (el) => {
        if (el === container) {
            return { display: 'flex', paddingTop: '16px', paddingBottom: '16px', top: '38px' };
        }
        return { display: 'flex', paddingTop: '0px', paddingBottom: '0px', top: '0px' };
    };
    const winObj = {
        innerWidth: 1280,
        innerHeight: 768,
        location: { hash: '' },
        addEventListener() {},
        removeEventListener() {},
        getComputedStyle: mockComputedStyle,
        electronAPI: { toFileUrl: (p) => p, getDefaultProjectDir: () => '' },
    };
    const sandbox = loadBrowserScript('src/reels-batch-table.js', {
        window: winObj,
        document: {
            head: { appendChild() {} },
            body: { appendChild() {}, querySelectorAll: () => [] },
            documentElement: { clientHeight: 768 },
            createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, querySelectorAll: () => [], addEventListener() {} }),
            getElementById: (id) => (id === 'reels-batch-table-container' ? container : null),
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            removeEventListener() {},
        },
        getComputedStyle: mockComputedStyle,
        requestAnimationFrame: () => 0,
        setTimeout: () => 0,
        clearTimeout: () => {},
        showToast: () => {},
        alert: () => {},
        confirm: () => true,
    });

    const first = JSON.parse(vm.runInContext(`(() => {
        _batchTableState.container = document.getElementById('reels-batch-table-container');
        _fitBatchTableToViewport();
        return JSON.stringify({
            panelMaxHeight: document.getElementById('reels-batch-table-container').querySelector('.rbt-panel').style.maxHeight,
            actionsMaxHeight: document.getElementById('reels-batch-table-container').querySelector('.rbt-panel').querySelector('.rbt-actions-panel').style.maxHeight,
            tableMaxHeight: document.getElementById('reels-batch-table-container').querySelector('.rbt-table-wrap').style.maxHeight,
        });
    })()`, sandbox));

    assert.strictEqual(first.panelMaxHeight, '698px');
    assert.strictEqual(first.actionsMaxHeight, '265px');
    assert.strictEqual(first.tableMaxHeight, '320px');
    assert.ok(34 + 42 + 36 + 220 + parseInt(first.tableMaxHeight, 10) + 40 <= 698 - 2, 'Total vertical children must leave room for .rbt-footer inside .rbt-panel');

    // Fallback path before layout rect exists: must still subtract window chrome top offset (38px) + .rbt-folder-scope-bar
    containerRectH = 0;
    containerClientH = 0;
    winObj.innerHeight = 680;
    const fallback = JSON.parse(vm.runInContext(`(() => {
        _fitBatchTableToViewport();
        return JSON.stringify({
            panelMaxHeight: document.getElementById('reels-batch-table-container').querySelector('.rbt-panel').style.maxHeight,
            tableMaxHeight: document.getElementById('reels-batch-table-container').querySelector('.rbt-table-wrap').style.maxHeight,
        });
    })()`, sandbox));

    assert.strictEqual(fallback.panelMaxHeight, '610px');
    assert.strictEqual(fallback.tableMaxHeight, '232px');
});

test('Scroll card backgrounds auto-follow subtitle box, sync feathering/negative-offset expansion, and coalesce rapid color-picker drags', () => {
    const overlaySandbox = loadBrowserScript('src/reels-anim-engine.js', {
        window: { addEventListener() {} },
    });
    overlaySandbox.ReelsAnimEngine = overlaySandbox.window.ReelsAnimEngine;
    loadBrowserScript('src/reels-overlay.js', overlaySandbox);
    overlaySandbox.ReelsOverlay = overlaySandbox.window.ReelsOverlay;
    overlaySandbox.ReelsBrushEngine = overlaySandbox.window.ReelsBrushEngine;
    loadBrowserScript('src/reels-style-engine.js', overlaySandbox);
    overlaySandbox.ReelsStyleEngine = overlaySandbox.window.ReelsStyleEngine;
    loadBrowserScript('src/reels-canvas-renderer.js', overlaySandbox);
    loadBrowserScript('src/reels-presets-init.js', overlaySandbox);

    const ReelsOverlay = overlaySandbox.window.ReelsOverlay;
    const ReelsBrushEngine = overlaySandbox.window.ReelsBrushEngine;
    const resolveBuiltinPreset = overlaySandbox.window.resolveBuiltinPreset;
    assert.ok(ReelsOverlay && ReelsBrushEngine, 'window.ReelsOverlay and ReelsBrushEngine must be exposed');
    assert.strictEqual(typeof resolveBuiltinPreset, 'function', 'window.resolveBuiltinPreset must be exposed');

    let sc164 = null;
    for (let n = 49; n <= 198; n++) {
        const candidate = resolveBuiltinPreset(`sc-${n}`);
        if (candidate?.style?.bg_style === 'xmas_cathedral_stained_glass') {
            sc164 = candidate;
            break;
        }
    }
    assert.ok(sc164 && sc164.style, 'xmas_cathedral_stained_glass preset must resolve');
    assert.strictEqual(sc164.style.bg_style, 'xmas_cathedral_stained_glass');
    assert.strictEqual(sc164.style.bg_width, 0);
    assert.strictEqual(sc164.style.bg_height, 0);
    assert.strictEqual(sc164.style.bg_scroll_follow, true);
    assert.strictEqual(sc164.style.feather_mode, 'clip');

    const canvasCalls = { drawImage: 0, fillRect: 0, gradStops: 0, compositeOps: [] };
    const createMockCtx = () => ({
        font: '',
        globalAlpha: 1,
        save() {},
        restore() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        bezierCurveTo() {},
        quadraticCurveTo() {},
        arc() {},
        arcTo() {},
        ellipse() {},
        rect() {},
        roundRect() {},
        clip() {},
        setLineDash() {},
        fill() { canvasCalls.fillRect++; },
        stroke() {},
        fillRect() { canvasCalls.fillRect++; },
        strokeRect() {},
        clearRect() {},
        translate() {},
        scale() {},
        rotate() {},
        setTransform() {},
        drawImage() { canvasCalls.drawImage++; },
        measureText: (t) => ({ width: String(t || '').length * 16 }),
        fillText() {},
        strokeText() {},
        createPattern: () => ({}),
        createLinearGradient: () => ({ addColorStop() { canvasCalls.gradStops++; } }),
        createRadialGradient: () => ({ addColorStop() { canvasCalls.gradStops++; } }),
        set globalCompositeOperation(v) { canvasCalls.compositeOps.push(v); this._gco = v; },
        get globalCompositeOperation() { return this._gco || 'source-over'; },
    });

    // Enable real-like canvas node detection for offscreen feather & themed card composite paths
    const prevDocCreate = overlaySandbox.document.createElement;
    overlaySandbox.document.createElement = (tag) => {
        if (String(tag).toLowerCase() === 'canvas') {
            const cCtx = createMockCtx();
            return {
                nodeName: 'CANVAS',
                tagName: 'CANVAS',
                width: 1080,
                height: 1920,
                getContext: () => cCtx,
            };
        }
        return prevDocCreate(tag);
    };

    const mainCtx = createMockCtx();

    // (a) Changing ov.w / ov.h resizes _renderedW / _renderedH dynamically on sc-164
    const smallOv = ReelsOverlay.createScrollOverlay({
        ...sc164.style,
        scroll_title: '',
        content: 'Grace and peace to you in this quiet season.',
        x: 180,
        y: 500,
        w: 520,
        h: 420,
        start: 0,
        end: 10,
    });
    ReelsOverlay.drawOverlay(mainCtx, smallOv, 2.0, 1080, 1920);
    const smallW = smallOv._renderedW;
    const smallH = smallOv._renderedH;

    const largeOv = ReelsOverlay.createScrollOverlay({
        ...sc164.style,
        scroll_title: '',
        content: 'Grace and peace to you in this quiet season.',
        x: 90,
        y: 380,
        w: 840,
        h: 880,
        start: 0,
        end: 10,
    });
    ReelsOverlay.drawOverlay(mainCtx, largeOv, 2.0, 1080, 1920);
    assert.ok(largeOv._renderedW > smallW + 200, `Expected wider clip box to widen rendered card (${largeOv._renderedW} vs ${smallW})`);
    assert.ok(largeOv._renderedH > smallH + 350, `Expected taller clip box to heighten rendered card (${largeOv._renderedH} vs ${smallH})`);

    // (b) Negative feather offsets expand auto-sized card outward, and drawThemedCardBackground + _drawScrollOverlay apply feather gradients cleanly
    const expandedOv = ReelsOverlay.createScrollOverlay({
        ...sc164.style,
        scroll_title: '',
        content: 'Peace be with you.',
        x: 140,
        y: 440,
        w: 600,
        h: 500,
        feather_top: 80,
        feather_bottom: 90,
        feather_top_offset: -40,
        feather_bottom_offset: -50,
        feather_left_offset: -20,
        feather_right_offset: -30,
        start: 0,
        end: 10,
    });
    ReelsOverlay.drawOverlay(mainCtx, expandedOv, 2.0, 1080, 1920);
    assert.ok(expandedOv._renderedW >= 600 + 20 + 30, 'Negative left/right offsets should expand auto-sized card width');
    assert.ok(expandedOv._renderedH >= 500 + 40 + 50, 'Negative top/bottom offsets should expand auto-sized card height');
    assert.ok(canvasCalls.gradStops > 0 && canvasCalls.compositeOps.includes('destination-in'), 'Card feather composite should apply destination-in gradients');

    const prevGradStops = canvasCalls.gradStops;
    ReelsBrushEngine.drawThemedCardBackground(mainCtx, 100, 200, 720, 640, 24, {
        style: 'xmas_cathedral_stained_glass',
        seedKey: 'test-themed-feather',
        opacity: 0.92,
        edgeFeatherPx: 36,
    });
    assert.ok(canvasCalls.gradStops > prevGradStops, 'drawThemedCardBackground with edgeFeatherPx > 0 must draw feather gradients');

    // (c) Continuous color-picker input events coalesce heavy scope sync / autosave / task-list rebuild while change commits immediately
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    const timers = [];
    let rafQueue = [];
    let nextId = 1;
    let autoSaveCount = 0;
    let renderTaskListCount = 0;
    let syncTabCount = 0;
    let onOverlayChangeCount = 0;
    let renderCount = 0;

    const makeInput = (id, value) => {
        const listeners = {};
        return {
            id,
            value,
            type: id.endsWith('hex') ? 'text' : 'color',
            dataset: {},
            style: { setProperty() {}, removeProperty() {} },
            classList: { add() {}, remove() {}, contains: () => false },
            parentNode: null,
            children: [],
            appendChild(child) { if (child && typeof child === 'object') child.parentNode = this; this.children.push(child); return child; },
            insertBefore(newNode) { if (newNode && typeof newNode === 'object') newNode.parentNode = this; this.children.push(newNode); return newNode; },
            addEventListener(evt, fn) { (listeners[evt] ||= []).push(fn); },
            dispatch(evt) { (listeners[evt] || []).forEach(fn => fn({ type: evt, target: this })); },
        };
    };
    const parentEl = makeInput('rop-parent', '');
    const colorEl = makeInput('rop-scroll-color', '#ffffff');
    parentEl.appendChild(colorEl);
    const scopeEl = makeInput('rop-style-scope', 'folder');
    const applyAllEl = { id: 'rop-scroll-apply-all', type: 'checkbox', checked: true, addEventListener() {} };

    const panelSandbox = {
        window: {
            ReelsGradientPicker: null,
            ReelsPreviewV2: { isOpen: () => false, requestRender() {}, render() {} },
            ReelsOverlay: { measureScrollMotion: () => null },
            _reelsState: {
                tasks: [
                    { id: 't1', overlays: [{ id: 'ov1', type: 'scroll', color: '#ffffff' }] },
                    { id: 't2', overlays: [{ id: 'ov2', type: 'scroll', color: '#ffffff' }] },
                ],
                selectedIdx: 0,
            },
        },
        document: {
            head: { appendChild() {}, querySelector: () => null },
            body: { appendChild() {} },
            getElementById: (id) => (id === 'rop-style-scope' ? scopeEl : null),
            createElement: (tag) => makeInput(tag || 'dyn', ''),
        },
        setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms, cleared: false }); return id; },
        clearTimeout: (id) => { const t = timers.find(x => x.id === id); if (t) t.cleared = true; },
        requestAnimationFrame: (fn) => { const id = nextId++; rafQueue.push({ id, fn, cancelled: false }); return id; },
        cancelAnimationFrame: (id) => { const r = rafQueue.find(x => x.id === id); if (r) r.cancelled = true; },
        _syncCurrentOverlayEditorToSelectedTask: () => {},
        _syncTasksToActiveTab: () => { syncTabCount++; },
        _batchAutoSave: () => { autoSaveCount++; },
        _renderTaskList: () => { renderTaskListCount++; },
    };
    panelSandbox.window.window = panelSandbox.window;
    vm.createContext(panelSandbox);
    vm.runInContext(`${panelSrc}\nwindow.ReelsOverlayPanel = ReelsOverlayPanel;`, panelSandbox);

    const panel = Object.create(panelSandbox.window.ReelsOverlayPanel.prototype);
    const elMap = {
        '#rop-scroll-color': colorEl,
        '#rop-style-scope': scopeEl,
        '#rop-scroll-apply-all': applyAllEl,
    };
    panel.container = {
        querySelector: (sel) => elMap[sel] || null,
        querySelectorAll: () => [],
    };
    panel.videoCanvas = {
        render: () => { renderCount++; },
        onOverlayChange: () => { onOverlayChangeCount++; },
    };
    panel._selectedOv = panelSandbox.window._reelsState.tasks[0].overlays[0];
    panel._val = (id, v) => { const el = elMap['#' + id]; if (el) el.value = v; };
    panel._get = (id) => {
        if (id === 'rop-scroll-color') return colorEl.value;
        if (id === 'rop-scroll-apply-all') return true;
        return '';
    };
    panel._updateAnimStartRef = () => {};
    panel._updateScrollAccordionBadges = () => {};
    panel._enhanceColorInput(colorEl);

    for (const hex of ['#ff1111', '#ff2222', '#ff3333', '#ff4444', '#ff5555']) {
        colorEl.value = hex;
        colorEl.dispatch('input');
    }
    assert.strictEqual(onOverlayChangeCount, 0, 'Rapid color input events must not synchronously fire onOverlayChange');
    assert.strictEqual(autoSaveCount, 0, 'Rapid color input events must not trigger synchronous autosave');
    assert.strictEqual(syncTabCount, 0, 'Rapid color input events must not trigger synchronous tab sync');
    assert.strictEqual(renderTaskListCount, 0, 'Color styling must not rebuild task list DOM');

    // Coalesced rAF renders preview once without heavy sync
    for (const r of rafQueue) {
        if (!r.cancelled) r.fn();
    }
    rafQueue = [];
    assert.strictEqual(renderCount, 1, 'Multiple color input events in a frame must coalesce into one canvas render');

    // Final change event commits immediately
    colorEl.value = '#12ab34';
    colorEl.dispatch('change');
    for (const r of rafQueue) {
        if (!r.cancelled) r.fn();
    }
    assert.strictEqual(panelSandbox.window._reelsState.tasks[1].overlays[0].color.toLowerCase(), '#12ab34', 'Color change commit must propagate to scoped tasks');
    assert.ok(onOverlayChangeCount >= 1, 'Color change event must notify videoCanvas.onOverlayChange');
    assert.ok(autoSaveCount >= 1 && syncTabCount >= 1, 'Color change commit must persist tab & autosave');
    assert.strictEqual(renderTaskListCount, 0, 'Color style change must not trigger full _renderTaskList DOM rebuild');
});

test('ReelsExportScheduler scales memory for long 2-min multi-clip jobs, caps maxActive<=3, and guards low freemem', async () => {
    const os = require('node:os');
    const { ReelsExportScheduler, estimateExportBytes } = require('../electron/services/reels-export-scheduler.js');

    const shortBytes = estimateExportBytes({ targetWidth: 1080, targetHeight: 1920, duration: 20, bgClipPool: [] });
    const longMultiBytes = estimateExportBytes({
        targetWidth: 1080,
        targetHeight: 1920,
        duration: 120,
        bgClipPool: ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'e.mp4', 'f.mp4'],
    });
    assert.ok(longMultiBytes > shortBytes * 1.4, 'Long duration + multi-clip pool must scale estimated memory bytes');

    const defaultScheduler = new ReelsExportScheduler();
    assert.ok(defaultScheduler.maxActive <= 3, `Expected maxActive <= 3, got ${defaultScheduler.maxActive}`);

    const origFreemem = os.freemem;
    let fakeFreeBytes = 700 * 1024 * 1024;
    os.freemem = () => fakeFreeBytes;
    try {
        const scheduler = new ReelsExportScheduler({ maxActive: 3, maxBytes: 4 * 1024 * 1024 * 1024 });
        const release1 = await scheduler.acquire({ targetWidth: 1080, targetHeight: 1920, duration: 120 });
        assert.strictEqual(scheduler.active, 1);

        let secondStarted = false;
        const p2 = scheduler.acquire({ targetWidth: 1080, targetHeight: 1920, duration: 120 }).then((rel) => {
            secondStarted = true;
            return rel;
        });
        await new Promise((r) => setTimeout(r, 20));
        assert.strictEqual(secondStarted, false, '2nd job must wait while active >= 1 and freemem < 1200MB');

        fakeFreeBytes = 3 * 1024 * 1024 * 1024;
        release1();
        const release2 = await p2;
        assert.strictEqual(secondStarted, true, '2nd job must start once first releases and freemem recovers');
        release2();
    } finally {
        os.freemem = origFreemem;
    }
});

test('ReelsOverlay bypasses card bitmap cache while scrolling/exporting and ReelsCanvasRenderer.dispose shrinks surfaces', () => {
    class MockCanvasElement {
        constructor(w = 300, h = 150) {
            this.width = w;
            this.height = h;
            this.style = {};
            this.dataset = {};
            this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
        }
        appendChild() {}
        addEventListener() {}
        setAttribute() {}
        getContext() {
            return {
                canvas: this,
                font: '',
                globalAlpha: 1,
                globalCompositeOperation: 'source-over',
                filter: 'none',
                shadowColor: 'transparent',
                shadowBlur: 0,
                shadowOffsetX: 0,
                shadowOffsetY: 0,
                setTransform() {},
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
                roundRect() {},
                clip() {},
                fill() {},
                stroke() {},
                fillRect() {},
                strokeRect() {},
                clearRect() {},
                fillText() {},
                strokeText() {},
                drawImage() {},
                translate() {},
                rotate() {},
                scale() {},
                setLineDash() {},
                createPattern: () => ({}),
                createLinearGradient: () => ({ addColorStop() {} }),
                createRadialGradient: () => ({ addColorStop() {} }),
                measureText: (txt) => ({ width: String(txt || '').length * 10 }),
            };
        }
    }

    const createdCanvases = [];
    const ovCode = fs.readFileSync(path.join(ROOT, 'src/reels-overlay.js'), 'utf8');
    const crCode = fs.readFileSync(path.join(ROOT, 'src/reels-canvas-renderer.js'), 'utf8');
    const winObj = {
        HTMLCanvasElement: MockCanvasElement,
        devicePixelRatio: 1,
        ReelsTextDirection: null,
        ReelsRichText: null,
    };
    const docObj = {
        head: { appendChild() {}, querySelector: () => null },
        body: { appendChild() {} },
        createElement: (tag) => {
            if (tag === 'canvas') {
                const c = new MockCanvasElement(300, 150);
                createdCanvases.push(c);
                return c;
            }
            return { style: {}, dataset: {}, classList: { add() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} };
        },
        getElementById: () => null,
        querySelectorAll: () => [],
    };
    const vmCtx = vm.createContext({
        console, Math, Date, Intl, JSON, Array, Object, String, Number, Boolean, RegExp, Error,
        Map, Set, parseFloat, parseInt, isNaN, isFinite,
        HTMLCanvasElement: MockCanvasElement,
        OffscreenCanvas: undefined,
        performance: { now: () => Date.now() },
        document: docObj,
        window: winObj,
        globalThis: winObj,
    });
    winObj.document = docObj;
    winObj.window = winObj;
    vm.runInContext(ovCode, vmCtx);
    vm.runInContext(crCode, vmCtx);

    assert.strictEqual(typeof winObj.ReelsOverlay.clearRuntimeCaches, 'function', 'ReelsOverlay must export clearRuntimeCaches');

    // Simulate exporting 10 scrolling frames with card backdrop: should NOT allocate 10 persistent cached card bitmaps
    const hostCanvas = new MockCanvasElement(1080, 1920);
    const hostCtx = hostCanvas.getContext('2d');
    const countBeforeDraw = createdCanvases.length;
    const scrollOv = {
        type: 'scroll',
        enabled: true,
        _exporting: true,
        content: 'Long Christmas scrolling reflection line '.repeat(12),
        scroll_bg_enabled: true,
        scroll_bg_color: '#1b1b2f',
        scroll_bg_alpha: 0.9,
        scroll_bg_feather: 12,
        scroll_speed: 80,
        scroll_start: 0,
        scroll_end: 120,
        x: 50, y: 50, w: 80, h: 70,
        fontSize: 42,
    };
    for (let f = 0; f < 10; f++) {
        winObj.ReelsOverlay.drawOverlay(hostCtx, scrollOv, f * 0.5, 1080, 1920);
    }
    const countAfterDraw = createdCanvases.length;
    assert.ok(countAfterDraw - countBeforeDraw <= 6, `Expected bounded scratch canvases during 10 export frames, created ${countAfterDraw - countBeforeDraw}`);

    const renderer = new winObj.ReelsCanvasRenderer(hostCanvas);
    const ambient = renderer._getAmbientLightingLayer(1080, 1920);
    assert.strictEqual(ambient.width, 1080);
    assert.strictEqual(ambient.height, 1920);
    renderer._writingCursorMeasureCanvas = new MockCanvasElement(200, 100);
    renderer.dispose();
    assert.strictEqual(ambient.width, 0, 'dispose() must zero ambient canvas width');
    assert.strictEqual(ambient.height, 0, 'dispose() must zero ambient canvas height');
    assert.strictEqual(renderer._ambientLightingLayer, null);
    assert.strictEqual(renderer._writingCursorMeasureCanvas, null);

    // Clear caches and ensure scratch canvases are shrunk to 0x0
    winObj.ReelsOverlay.clearRuntimeCaches();
    const nonZeroAfterClear = createdCanvases.filter(c => c.width > 0 || c.height > 0);
    assert.strictEqual(nonZeroAfterClear.length, 0, 'clearRuntimeCaches() must zero dimensions of all cached DOM canvases');
});

test('Batch export journal, safe concurrency default, completion notify, and startup styling safeguards are wired', () => {
    const batchSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');
    const viteSrc = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');

    // Startup unstyled flash protection
    assert.ok(viteSrc.includes('starry-theme.css') && viteSrc.includes('<link rel="stylesheet" href='), 'vite build must keep synchronous stylesheet links in dist/index.html');
    assert.ok(mainSrc.includes('show: false') && mainSrc.includes("mainWindow.once('ready-to-show'"), 'mainWindow must defer reveal until ready-to-show');
    assert.ok(mainSrc.includes('app.setAppUserModelId'), 'Windows notifications require AppUserModelId');
    assert.ok(mainSrc.includes('verify-export-outputs') && mainSrc.includes('read-reels-export-journal') && mainSrc.includes('notify-export-complete'), 'main process must expose journal, verify, and completion notification IPCs');
    assert.ok(preloadSrc.includes('verifyExportOutputs:') && preloadSrc.includes('notifyExportComplete:') && preloadSrc.includes('saveReelsExportJournal:'), 'preload must expose new export IPCs');
    assert.ok(htmlSrc.includes('id="reels-export-recovery-bar"'), 'index.html must include recovery bar element');
    assert.ok(batchSrc.includes("'reels-export-concurrency': '2'"), 'Default export concurrency must be 2');

    // Evaluate pure helpers & notification pipeline from src/batch-reels.js
    const startIdx = batchSrc.indexOf('let _reelsActiveExportJournal = null;');
    const endIdx = batchSrc.indexOf('function _reelsInitJobProgressUI(jobs) {', startIdx);
    const concurrencyStart = batchSrc.indexOf('function _resolveSafeReelsExportConcurrency(');
    const concurrencyEnd = batchSrc.indexOf('function _sanitizeReelsExportRecycleEvery(', concurrencyStart);
    assert.ok(startIdx > 0 && endIdx > startIdx && concurrencyStart > 0 && concurrencyEnd > concurrencyStart);

    const notified = [];
    const taskbarCalls = [];
    const toasts = [];
    const savedIpc = [];
    const store = new Map();
    const batchWin = {
        electronAPI: {
            saveReelsExportJournal: async (j) => { savedIpc.push(JSON.parse(JSON.stringify(j))); return { ok: true }; },
            readReelsExportJournal: async () => null,
            clearReelsExportJournal: async () => { savedIpc.push(null); return { ok: true }; },
            notifyExportComplete: async (p) => { notified.push(p); return { ok: true }; },
            setExportTaskbarProgress: async (v, o) => { taskbarCalls.push([v, o]); return true; },
        },
        AudioContext: undefined,
        webkitAudioContext: undefined,
    };
    const vmCtx = vm.createContext({
        console, Math, Date, JSON, Array, Object, String, Number, Boolean, Set, Map, Promise,
        REELS_EXPORT_RESUME_KEY: 'videokit_reels_export_resume_v1',
        _reelsState: { tasks: [{ id: 't1', fileName: 'a.mp4' }, { id: 't2', fileName: 'b.mp4' }], isExporting: false },
        window: batchWin,
        document: { getElementById: () => null },
        localStorage: {
            getItem: (k) => store.get(k) || null,
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
        },
        showToast: (msg, type) => toasts.push({ msg, type }),
        setTimeout, clearTimeout,
    });
    vmCtx.window.window = vmCtx.window;
    vm.runInContext(batchSrc.slice(startIdx, endIdx) + '\n' + batchSrc.slice(concurrencyStart, concurrencyEnd), vmCtx);

    assert.strictEqual(vmCtx._resolveSafeReelsExportConcurrency(undefined, 10), 2);
    assert.strictEqual(vmCtx._resolveSafeReelsExportConcurrency('10', 3), 3);
    assert.strictEqual(vmCtx._resolveSafeReelsExportConcurrency('4', 30), 4);

    const journal = {
        jobs: [
            { index: 0, taskId: 't1', fileName: 'a.mp4', status: 'success', outputPath: 'C:/out/a.mp4', finalOutputPath: 'C:/out/a.mp4' },
            { index: 1, taskId: 't2', fileName: 'b.mp4', status: 'failed', outputPath: 'C:/out/b.mp4', finalOutputPath: 'C:/out/b.mp4' },
            { index: 2, taskId: 't3', fileName: 'c.mp4', status: 'success', outputPath: 'C:/out/c.mp4', finalOutputPath: 'C:/out/c_final.mp4' },
        ],
    };
    // Disk check shows a.mp4 exists, b.mp4 missing, c_final.mp4 missing (e.g. stale status)
    const classified = vmCtx._classifyReelsJournalJobs(journal, {
        'C:/out/a.mp4': true,
        'C:/out/b.mp4': false,
        'C:/out/c_final.mp4': false,
        'C:/out/c.mp4': false,
    });
    assert.strictEqual(classified.verifiedSuccessCount, 1);
    assert.deepStrictEqual([...classified.unfinishedIndices], [1, 2]);
    assert.deepStrictEqual([...classified.failedIndices], [1, 2]);

    const matched = vmCtx._matchJournalJobsToTasks(journal, [{ id: 't1', fileName: 'a.mp4' }, { id: 't2', fileName: 'b.mp4' }]);
    assert.deepStrictEqual([...matched.matchedTaskIndices], [0, 1]);

    return vmCtx._reelsNotifyExportFinished({
        okCount: 29,
        failCount: 1,
        totalJobs: 30,
        canceled: false,
        outputDir: 'C:/out',
        latestPath: 'C:/out/a.mp4',
    }).then(() => {
        assert.strictEqual(notified.length, 1, 'Export finish must trigger native notification IPC');
        assert.ok(notified[0].title.includes('29/30'));
        assert.strictEqual(taskbarCalls.length >= 1, true);
        assert.strictEqual(toasts.length, 1);
    });
});

test('Auto-color rule color picker, hex input, and keyword textarea preserve DOM nodes without jumping or rebuilding rules', () => {
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    let nextId = 1;
    let rafQueue = [];
    const timers = [];

    const makeEl = (tagName = 'div') => {
        const listeners = {};
        let _innerHTML = '';
        const classes = new Set();
        const node = {
            tagName: String(tagName).toUpperCase(),
            nodeType: 1,
            id: '',
            type: '',
            value: '',
            className: '',
            checked: false,
            dataset: {},
            style: { cssText: '', display: '', setProperty() {}, removeProperty() {} },
            parentNode: null,
            children: [],
            classList: {
                add: (...cls) => cls.forEach((c) => classes.add(c)),
                remove: (...cls) => cls.forEach((c) => classes.delete(c)),
                contains: (c) => classes.has(c),
            },
            set innerHTML(val) {
                _innerHTML = String(val);
                this.children.forEach((c) => {
                    if (c && typeof c === 'object') c.parentNode = null;
                });
                this.children = [];
            },
            get innerHTML() {
                return _innerHTML;
            },
            appendChild(child) {
                if (child && typeof child === 'object') {
                    if (child.parentNode && Array.isArray(child.parentNode.children)) {
                        const oldIdx = child.parentNode.children.indexOf(child);
                        if (oldIdx >= 0) child.parentNode.children.splice(oldIdx, 1);
                    }
                    child.parentNode = this;
                    this.children.push(child);
                }
                return child;
            },
            insertBefore(newNode, refNode) {
                if (!newNode || typeof newNode !== 'object') return newNode;
                if (newNode.parentNode && Array.isArray(newNode.parentNode.children)) {
                    const oldIdx = newNode.parentNode.children.indexOf(newNode);
                    if (oldIdx >= 0) newNode.parentNode.children.splice(oldIdx, 1);
                }
                newNode.parentNode = this;
                const refIdx = refNode ? this.children.indexOf(refNode) : -1;
                if (refIdx >= 0) this.children.splice(refIdx, 0, newNode);
                else this.children.push(newNode);
                return newNode;
            },
            contains(target) {
                let cur = target;
                while (cur) {
                    if (cur === this) return true;
                    cur = cur.parentNode;
                }
                return false;
            },
            addEventListener(evt, fn) {
                (listeners[evt] ||= []).push(fn);
            },
            dispatch(evt) {
                (listeners[evt] || []).forEach((fn) => fn({ type: evt, target: this }));
            },
        };
        return node;
    };

    const findNodes = (root, predicate, out = []) => {
        if (!root || typeof root !== 'object') return out;
        if (predicate(root)) out.push(root);
        if (Array.isArray(root.children)) {
            root.children.forEach((c) => findNodes(c, predicate, out));
        }
        return out;
    };

    const flushRaf = () => {
        const current = rafQueue;
        rafQueue = [];
        for (const entry of current) {
            if (!entry.cancelled) entry.fn();
        }
    };

    const autoColorProps = makeEl('div');
    autoColorProps.id = 'rop-autocolor-props';
    const rulesContainer = makeEl('div');
    rulesContainer.id = 'rop-autocolor-rules';
    autoColorProps.appendChild(rulesContainer);
    const scopeEl = makeEl('select');
    scopeEl.id = 'rop-style-scope';
    scopeEl.value = 'folder';
    const scrollColorEl = makeEl('input');
    scrollColorEl.id = 'rop-scroll-color';
    scrollColorEl.value = '#ffffff';
    const scrollApplyAllEl = makeEl('input');
    scrollApplyAllEl.id = 'rop-scroll-apply-all';
    scrollApplyAllEl.type = 'checkbox';
    scrollApplyAllEl.checked = true;

    const tasks = [
        {
            id: 't1',
            overlays: [
                {
                    id: 'ov1',
                    type: 'scroll',
                    color: '#ffffff',
                    auto_color_rules: [{ type: 'keyword', keywords: ['Jesus', 'God'], color: '#d3cf5a', bold: true }],
                },
            ],
        },
        {
            id: 't2',
            overlays: [{ id: 'ov2', type: 'scroll', color: '#ffffff', auto_color_rules: [] }],
        },
    ];

    const sandbox = {
        window: {
            ReelsGradientPicker: null,
            ReelsPreviewV2: { isOpen: () => false, requestRender() {}, render() {} },
            ReelsOverlay: { measureScrollMotion: () => null },
            _reelsState: { tasks, selectedIdx: 0 },
        },
        document: {
            head: makeEl('head'),
            body: makeEl('body'),
            getElementById: (id) => (id === 'rop-style-scope' ? scopeEl : null),
            createElement: (tag) => makeEl(tag),
            createTextNode: (text) => ({ nodeType: 3, textContent: text, parentNode: null }),
        },
        localStorage: { getItem: () => null, setItem() {} },
        Option: function (text, value) { this.text = text; this.value = value; },
        setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms, cleared: false }); return id; },
        clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; },
        requestAnimationFrame: (fn) => { const id = nextId++; rafQueue.push({ id, fn, cancelled: false }); return id; },
        cancelAnimationFrame: (id) => { const r = rafQueue.find((x) => x.id === id); if (r) r.cancelled = true; },
        _syncCurrentOverlayEditorToSelectedTask: () => {},
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(`${panelSrc}\nwindow.ReelsOverlayPanel = ReelsOverlayPanel;`, sandbox);

    const panel = Object.create(sandbox.window.ReelsOverlayPanel.prototype);
    const elMap = {
        '#rop-autocolor-props': autoColorProps,
        '#rop-autocolor-rules': rulesContainer,
        '#rop-style-scope': scopeEl,
        '#rop-scroll-color': scrollColorEl,
        '#rop-scroll-apply-all': scrollApplyAllEl,
    };
    panel.container = {
        querySelector: (sel) => elMap[sel] || null,
        querySelectorAll: () => [],
    };
    panel._selectedOv = tasks[0].overlays[0];
    panel._val = (id, v) => { const el = elMap['#' + id]; if (el) el.value = v; };
    panel._get = (id) => {
        if (id === 'rop-scroll-apply-all') return true;
        if (id === 'rop-scroll-color') return scrollColorEl.value;
        return '';
    };
    panel._updateAnimStartRef = () => {};
    panel._updateScrollAccordionBadges = () => {};

    let renderCount = 0;
    let onOverlayChangeCalls = 0;
    let syncFromOverlayCalls = 0;
    // Reproduce the real ReelsOverlayPanel videoCanvas.onOverlayChange wrapper (lines ~4444-4453)
    panel.videoCanvas = {
        render: () => { renderCount++; },
        onOverlayChange: (ov) => {
            onOverlayChangeCalls++;
            if (!ov || typeof ov !== 'object' || panel._panelSyncingOverlay) return;
            syncFromOverlayCalls++;
            panel._renderAutoColorRules();
        },
    };

    let renderAutoColorCount = 0;
    const origRenderAutoColor = sandbox.window.ReelsOverlayPanel.prototype._renderAutoColorRules;
    panel._renderAutoColorRules = function () {
        renderAutoColorCount++;
        return origRenderAutoColor.call(this);
    };

    panel._renderAutoColorRules();
    const colorPicker = findNodes(rulesContainer, (n) => n.tagName === 'INPUT' && n.type === 'color')[0];
    const hexInput = findNodes(rulesContainer, (n) => n.tagName === 'INPUT' && n.className === 'rop-color-hex')[0];
    const kwInput = findNodes(rulesContainer, (n) => n.tagName === 'TEXTAREA')[0];
    assert.ok(colorPicker && hexInput && kwInput, 'Auto-color rule controls must render');
    assert.strictEqual(hexInput.value, '#d3cf5a');

    // Reset counters after initial render
    renderAutoColorCount = 0;
    syncFromOverlayCalls = 0;
    renderCount = 0;
    onOverlayChangeCalls = 0;

    // 1. Continuous <input type="color"> drags must keep DOM nodes mounted & popup alive
    for (const hex of ['#e0b020', '#ff1122', '#33aa44']) {
        colorPicker.value = hex;
        colorPicker.dispatch('input');
    }
    assert.strictEqual(rulesContainer.contains(colorPicker), true, 'colorPicker must remain in DOM during input drag');
    assert.strictEqual(rulesContainer.contains(hexInput), true, 'hexInput must remain in DOM during input drag');
    assert.strictEqual(renderAutoColorCount, 0, 'Color input events must not rebuild #rop-autocolor-rules');
    assert.strictEqual(syncFromOverlayCalls, 0, 'Panel-initiated color changes must not re-enter _syncFromOverlay');
    assert.strictEqual(tasks[0].overlays[0].auto_color_rules[0].color, '#33aa44');
    assert.strictEqual(hexInput.value, '#33aa44');

    flushRaf();
    assert.strictEqual(renderCount, 1, 'Continuous color drag in a frame must coalesce to 1 render');

    // 2. Final change event commits cleanly without rebuilding rule DOM
    colorPicker.value = '#12ab34';
    colorPicker.dispatch('change');
    flushRaf();
    assert.strictEqual(rulesContainer.contains(colorPicker), true, 'colorPicker must remain in DOM on change commit');
    assert.strictEqual(renderAutoColorCount, 0);
    assert.strictEqual(syncFromOverlayCalls, 0);
    assert.strictEqual(onOverlayChangeCalls, 1);
    assert.strictEqual(tasks[0].overlays[0].auto_color_rules[0].color, '#12ab34');
    assert.strictEqual(tasks[1].overlays[0].auto_color_rules[0].color, '#12ab34');

    // 3. Editing hex input preserves DOM and syncs picker + rule + scoped tasks
    hexInput.value = '#aa55ff';
    hexInput.dispatch('input');
    hexInput.dispatch('change');
    flushRaf();
    assert.strictEqual(rulesContainer.contains(hexInput), true);
    assert.strictEqual(renderAutoColorCount, 0);
    assert.strictEqual(syncFromOverlayCalls, 0);
    assert.strictEqual(colorPicker.value, '#aa55ff');
    assert.strictEqual(tasks[0].overlays[0].auto_color_rules[0].color, '#aa55ff');
    assert.strictEqual(onOverlayChangeCalls, 2);

    // 4. Editing keyword textarea preserves DOM and commits without rebuilding rules
    kwInput.value = 'Jesus\nGrace';
    kwInput.dispatch('input');
    kwInput.dispatch('change');
    flushRaf();
    assert.strictEqual(rulesContainer.contains(kwInput), true);
    assert.strictEqual(renderAutoColorCount, 0);
    assert.strictEqual(syncFromOverlayCalls, 0);
    assert.deepStrictEqual([...tasks[0].overlays[0].auto_color_rules[0].keywords], ['Jesus', 'Grace']);
    assert.strictEqual(onOverlayChangeCalls, 3);

    // 5. Generic _syncToOverlay must not wipe #rop-autocolor-rules DOM either
    panel._syncToOverlay({ commit: false });
    assert.strictEqual(rulesContainer.contains(colorPicker), true);
    assert.strictEqual(renderAutoColorCount, 0);
});

test('End-to-end reelsStartExport persists Array resolvedBaseNames and reelsResumeExportFromJournal retries only failed jobs', async () => {
    const os = require('node:os');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-export-e2e-'));
    try {
        const srcMedia = path.join(tmpRoot, 'media');
        const outDir = path.join(tmpRoot, 'out');
        fs.mkdirSync(srcMedia, { recursive: true });
        fs.mkdirSync(outDir, { recursive: true });

        const bg1 = path.join(srcMedia, 'bg1.mp4');
        const bg2 = path.join(srcMedia, 'bg2.mp4');
        const v1 = path.join(srcMedia, 'v1.mp3');
        const v2 = path.join(srcMedia, 'v2.mp3');
        for (const f of [bg1, bg2, v1, v2]) fs.writeFileSync(f, Buffer.alloc(512, 7));

        const makeEl = (overrides = {}) => ({
            value: '',
            checked: false,
            disabled: false,
            textContent: '',
            innerHTML: '',
            style: {},
            dataset: {},
            options: [],
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            append() {},
            prepend() {},
            appendChild() {},
            removeChild() {},
            replaceChildren() {},
            remove() {},
            scrollIntoView() {},
            contains: () => false,
            addEventListener() {},
            setAttribute() {},
            focus() {},
            click() {},
            querySelector: () => null,
            querySelectorAll: () => [],
            getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, left: 0 }),
            getContext: () => ({
                font: '', globalAlpha: 1, save() {}, restore() {}, beginPath() {}, closePath() {},
                moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, arcTo() {},
                rect() {}, clip() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {}, clearRect() {},
                fillText() {}, strokeText() {}, translate() {}, rotate() {}, scale() {}, setLineDash() {},
                createPattern: () => ({}), createLinearGradient: () => ({ addColorStop() {} }),
                createRadialGradient: () => ({ addColorStop() {} }),
                measureText: (txt) => ({ width: String(txt || '').length * 10 }),
            }),
            ...overrides,
        });

        const domElements = new Map([
            ['reels-output-dir', makeEl({ value: outDir })],
            ['reels-quality', makeEl({ value: 'medium' })],
            ['reels-export-engine', makeEl({ value: 'precise' })],
            ['reels-suffix', makeEl({ value: '' })],
            ['reels-export-naming-mode-outer', makeEl({ value: 'text' })],
            ['reels-naming-mode', makeEl({ value: 'text' })],
            ['reels-download-mode', makeEl({ value: 'all' })],
            ['reels-download-range', makeEl({ value: '' })],
            ['reels-export-format', makeEl({ value: 'mp4' })],
            ['reels-export-concurrency', makeEl({ value: '1' })],
            ['reels-export-btn', makeEl({ textContent: '开始导出' })],
            ['reels-export-status', makeEl()],
            ['reels-export-progress', makeEl()],
            ['reels-export-recovery-bar', makeEl({ style: { display: 'none' } })],
            ['reels-export-job-progress-list', makeEl()],
        ]);
        const documentStub = {
            head: makeEl(),
            body: makeEl(),
            createElement: () => makeEl(),
            getElementById: (id) => domElements.get(id) || null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            removeEventListener() {},
        };

        const exportErrors = [];
        const notifications = [];
        const isolatedCalls = [];
        let ipcJournalState = null;
        let failSecondJob = true;

        const sandbox = loadBrowserScript('src/reels-project.js', {
            window: {
                innerWidth: 1280,
                innerHeight: 800,
                location: { hash: '' },
                addEventListener() {},
                removeEventListener() {},
                AudioContext: undefined,
                webkitAudioContext: undefined,
                reelsWysiwygExport: async (params) => {
                    const outPath = params?.outputPath || params?.output_path;
                    if (failSecondJob && (!outPath || String(outPath).includes('bg2'))) {
                        throw new Error('simulated fallback failure on job 1');
                    }
                    fs.mkdirSync(path.dirname(outPath), { recursive: true });
                    fs.writeFileSync(outPath, Buffer.alloc(8192, 0x55));
                    return { success: true, output_path: outPath };
                },
                electronAPI: {
                    toFileUrl: (p) => 'file:///' + String(p || '').replace(/\\/g, '/'),
                    ensureDirectory: async (dir) => {
                        fs.mkdirSync(dir, { recursive: true });
                        return { ok: true };
                    },
                    getMediaDuration: async () => 5,
                    getMediaDurationDetail: async () => ({ duration: 5 }),
                    checkFilesExist: async (paths = []) => {
                        const res = {};
                        for (const p of paths) res[p] = fs.existsSync(p);
                        return res;
                    },
                    verifyExportOutputs: async (paths = []) => {
                        const res = {};
                        for (const p of (Array.isArray(paths) ? paths : [])) {
                            try {
                                const st = fs.statSync(p);
                                res[p] = st.isFile() && st.size > 4096;
                            } catch (_) {
                                res[p] = false;
                            }
                        }
                        return res;
                    },
                    onIsolatedWysiwygProgress: () => () => {},
                    cancelIsolatedWysiwygExport: async () => ({ cancelled: true }),
                    reelsComposeWysiwyg: async () => ({ success: true }),
                    isolatedWysiwygExport: async (opts) => {
                        const p = opts?.params || {};
                        const outPath = p.outputPath || p.output_path || opts?.outputPath || opts?.output_path;
                        isolatedCalls.push({ requestId: opts?.requestId, outPath });
                        if (failSecondJob && String(outPath).includes('bg2')) {
                            throw new Error('simulated failure on job 1');
                        }
                        fs.mkdirSync(path.dirname(outPath), { recursive: true });
                        fs.writeFileSync(outPath, Buffer.alloc(8192, 0x55));
                        return { success: true, output_path: outPath };
                    },
                    saveReelsExportJournal: async (j) => {
                        ipcJournalState = JSON.parse(JSON.stringify(j));
                        return { ok: true };
                    },
                    readReelsExportJournal: async () => (ipcJournalState ? JSON.parse(JSON.stringify(ipcJournalState)) : null),
                    clearReelsExportJournal: async () => {
                        ipcJournalState = null;
                        return { ok: true };
                    },
                    setExportTaskbarProgress: async () => true,
                    notifyExportComplete: async (payload) => {
                        notifications.push(payload);
                        return { ok: true };
                    },
                    showReelsExportError: async (payload) => {
                        exportErrors.push(payload);
                        return { ok: true };
                    },
                    getDefaultProjectDir: () => tmpRoot,
                    saveBatchWorkspace: () => true,
                    readBatchWorkspace: () => '',
                },
            },
            document: documentStub,
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            requestAnimationFrame: (cb) => { if (typeof cb === 'function') cb(0); return 0; },
            getComputedStyle: () => ({ display: 'none', height: '0px' }),
            getWritingVisualStyle: (s) => s,
            reelsRefreshWritingTitleEditor: () => {},
            reelsRefreshSpeechWritingImageUI: () => {},
            showToast: () => {},
            alert: (msg) => exportErrors.push({ alert: msg }),
            confirm: () => true,
        });
        sandbox.localStorage.setItem('reelsQualityReminderShown', 'true');
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-render-plan.js'), 'utf8'), sandbox, { filename: 'src/reels-render-plan.js' });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8'), sandbox, { filename: 'src/reels-batch-table.js' });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8'), sandbox, { filename: 'src/batch-reels.js' });

        // 1. _resolveReelsJobBaseNames must return a real Array (supports .slice()) and _normalizeReelsResolvedBaseNames normalizes legacy objects
        const dedupCheck = JSON.parse(vm.runInContext(`JSON.stringify((() => {
            const arr = _resolveReelsJobBaseNames([
                { task: { baseName: 'same_name' } },
                { task: { baseName: 'same_name' } },
                { task: { baseName: 'unique_name' } },
            ], 'text');
            const normalizedLegacy = _normalizeReelsResolvedBaseNames({ 0: 'legacy_0', 1: 'legacy_1' }, 2);
            return {
                isArray: Array.isArray(arr),
                sliced: typeof arr.slice === 'function' ? arr.slice() : null,
                legacyIsArray: Array.isArray(normalizedLegacy),
                legacySliced: typeof normalizedLegacy.slice === 'function' ? normalizedLegacy.slice() : null,
            };
        })())`, sandbox));
        assert.strictEqual(dedupCheck.isArray, true, '_resolveReelsJobBaseNames must return an Array');
        assert.deepStrictEqual(dedupCheck.sliced, ['001_same_name', '002_same_name', '003_unique_name']);
        assert.strictEqual(dedupCheck.legacyIsArray, true, '_normalizeReelsResolvedBaseNames must return an Array for legacy objects');
        assert.deepStrictEqual(dedupCheck.legacySliced, ['legacy_0', 'legacy_1']);

        // 2. Real reelsStartExport() with 2 tasks: job 0 succeeds, job 1 fails
        vm.runInContext(`
            _reelsState.tasks = [
                { id: 'task_a', baseName: 'alpha_clip', fileName: 'alpha_clip', rowNumber: 1, bgPath: ${JSON.stringify(bg1)}, videoPath: ${JSON.stringify(bg1)}, audioPath: ${JSON.stringify(v1)}, _exportSelected: true, overlays: [] },
                { id: 'task_b', baseName: 'beta_clip', fileName: 'beta_clip', rowNumber: 2, bgPath: ${JSON.stringify(bg2)}, videoPath: ${JSON.stringify(bg2)}, audioPath: ${JSON.stringify(v2)}, _exportSelected: true, overlays: [] },
            ];
            _reelsState.selectedIndices = new Set([0, 1]);
            _reelsState.targetWidth = 1080;
            _reelsState.targetHeight = 1920;
            _reelsState.fps = 30;
            _reelsState.watermarks = [];
        `, sandbox);

        await sandbox.reelsStartExport();

        assert.deepStrictEqual(exportErrors, [], 'reelsStartExport must not hit _exportResolvedNames.slice or showReelsExportError');
        assert.strictEqual(isolatedCalls.length, 2, 'Initial batch export must attempt both job 0 and job 1');

        const storedRaw = sandbox.localStorage.getItem('videokit_reels_export_resume_v1');
        assert.ok(storedRaw, 'Partial failure must persist export resume journal to localStorage');
        const savedJournal = JSON.parse(storedRaw);
        assert.strictEqual(Array.isArray(savedJournal.resolvedBaseNames), true, 'journal.resolvedBaseNames must serialize as an Array');
        assert.strictEqual(savedJournal.resolvedBaseNames.length, 2);
        assert.strictEqual(savedJournal.jobs[0].status, 'success');
        assert.strictEqual(savedJournal.jobs[1].status, 'failed');
        assert.ok(ipcJournalState && Array.isArray(ipcJournalState.resolvedBaseNames));

        // 3. Resume failed-only via real reelsResumeExportFromJournal('failed-only'): runs ONLY job 1
        failSecondJob = false;
        notifications.length = 0;
        await sandbox.reelsResumeExportFromJournal('failed-only');

        assert.deepStrictEqual(exportErrors, [], 'Resumed export must not raise export errors');
        assert.strictEqual(isolatedCalls.length, 3, 'Resume failed-only must invoke isolatedWysiwygExport only once for failed job 1');
        assert.ok(String(isolatedCalls[2].outPath).includes('bg2'), 'Resumed call must target failed job 1 output');
        assert.strictEqual(sandbox.localStorage.getItem('videokit_reels_export_resume_v1'), null, 'Completed resume must clear localStorage export journal');
        assert.strictEqual(ipcJournalState, null, 'Completed resume must clear IPC export journal');
        assert.ok(notifications.length >= 1, 'Completed export must fire notification');
        assert.ok(fs.statSync(isolatedCalls[0].outPath).size > 4096);
        assert.ok(fs.statSync(isolatedCalls[2].outPath).size > 4096);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('Thanksgiving Pinterest minimalist presets (sub-229..sub-244), sc-199..sc-214 cards, and box_wipe leading cursor + brush clip', () => {
    const sandbox = loadBrowserScript('src/reels-style-engine.js', { window: { addEventListener() {} } });
    sandbox.ReelsStyleEngine = sandbox.window.ReelsStyleEngine;
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    sandbox.ReelsAnimEngine = sandbox.window.ReelsAnimEngine;
    loadBrowserScript('src/reels-overlay.js', sandbox);
    sandbox.ReelsOverlay = sandbox.window.ReelsOverlay;
    sandbox.ReelsBrushEngine = sandbox.window.ReelsBrushEngine;
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);

    const {
        ReelsStyleEngine,
        ReelsCanvasRenderer,
        ReelsBrushEngine,
        ReelsOverlay,
        resolveBuiltinPreset,
        REELS_BUILTIN_SCROLL_STYLE_PRESETS,
    } = sandbox.window;

    // 1. All 16 minimalist Thanksgiving T-subtitle presets sub-229..sub-244 resolve, appear in category, and have unique fingerprints
    const { categorized, presetsMap } = ReelsStyleEngine.getPresetsByCategory();
    const thxGroup = categorized.find(g => g.category === '🍂 感恩节 · 简约秋日与祈祷');
    assert.ok(thxGroup, 'PRESET_CATEGORIES must include 🍂 感恩节 · 简约秋日与祈祷');
    assert.strictEqual(thxGroup.names.length, 16, `Expected 16 Thanksgiving presets in category, got ${thxGroup.names.length}`);

    const thxTips = ['maple_leaf', 'wheat_stalk', 'acorn', 'minimal_pumpkin', 'warm_mug', 'olive_branch'];
    const makeCtx = () => {
        const ops = [];
        let saveCount = 0;
        let restoreCount = 0;
        const grad = { addColorStop() {} };
        const ctx = {
            canvas: { width: 1080, height: 1920 },
            globalAlpha: 1,
            globalCompositeOperation: 'source-over',
            font: '600 54px Georgia',
            fillStyle: '#FFFFFF',
            strokeStyle: '#000000',
            lineWidth: 2,
            lineCap: 'round',
            lineJoin: 'round',
            miterLimit: 10,
            textAlign: 'left',
            textBaseline: 'alphabetic',
            shadowColor: 'transparent',
            shadowBlur: 0,
            shadowOffsetX: 0,
            shadowOffsetY: 0,
            save() { saveCount++; ops.push({ op: 'save' }); },
            restore() { restoreCount++; ops.push({ op: 'restore' }); },
            beginPath() { ops.push({ op: 'beginPath' }); },
            closePath() {},
            moveTo(x, y) { ops.push({ op: 'moveTo', x, y }); },
            lineTo(x, y) { ops.push({ op: 'lineTo', x, y }); },
            quadraticCurveTo() {},
            bezierCurveTo() {},
            arc(x, y, r) { ops.push({ op: 'arc', x, y, r }); },
            arcTo() {},
            ellipse(x, y, rx, ry) { ops.push({ op: 'ellipse', x, y, rx, ry }); },
            rect(x, y, w, h) { ops.push({ op: 'rect', x, y, w, h }); },
            roundRect(x, y, w, h) { ops.push({ op: 'roundRect', x, y, w, h }); },
            clip() { ops.push({ op: 'clip' }); },
            fill() { ops.push({ op: 'fill', style: this.fillStyle }); },
            stroke() { ops.push({ op: 'stroke', style: this.strokeStyle }); },
            fillRect(x, y, w, h) { ops.push({ op: 'fillRect', x, y, w, h }); },
            strokeRect(x, y, w, h) { ops.push({ op: 'strokeRect', x, y, w, h }); },
            clearRect() {},
            drawImage() { ops.push({ op: 'drawImage' }); },
            translate(x, y) { ops.push({ op: 'translate', x, y }); },
            rotate(a) { ops.push({ op: 'rotate', a }); },
            scale(sx, sy) { ops.push({ op: 'scale', sx, sy }); },
            setTransform() {},
            resetTransform() {},
            setLineDash() {},
            createPattern() { return {}; },
            createLinearGradient() { return grad; },
            createRadialGradient() { return grad; },
            measureText(txt) {
                return {
                    width: String(txt || '').length * 24,
                    actualBoundingBoxAscent: 42,
                    actualBoundingBoxDescent: 12,
                };
            },
            fillText(txt, x, y) { ops.push({ op: 'fillText', text: String(txt), x, y }); },
            strokeText(txt, x, y) { ops.push({ op: 'strokeText', text: String(txt), x, y }); },
            _ops: ops,
            _counts: () => ({ saveCount, restoreCount }),
        };
        return ctx;
    };

    for (let n = 229; n <= 244; n++) {
        const res = resolveBuiltinPreset(`sub-${n}`);
        assert.ok(res && res.preset, `sub-${n} must resolve`);
        assert.ok(thxGroup.names.includes(res.name), `sub-${n} (${res.name}) must belong to Thanksgiving category`);
        const st = ReelsStyleEngine.applySubtitlePreset(res.name);
        assert.equal(st.anim_in_type, 'box_wipe', `sub-${n} should use box_wipe animation`);
        assert.equal(st.use_box, true, `sub-${n} should enable background slab`);
        const fp = ReelsStyleEngine.subtitleStyleFingerprint(presetsMap[res.name]);
        const dupCount = Object.values(presetsMap).filter(x => ReelsStyleEngine.subtitleStyleFingerprint(x) === fp).length;
        assert.equal(dupCount, 1, `sub-${n} (${res.name}) must have a unique style fingerprint`);

        const c = makeCtx();
        const r = new ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: () => c });
        r.renderSubtitle(st, { start: 0, end: 3.0, text: 'Give thanks with a grateful heart\nin every season of life' }, 1.1, 1080, 1920);
        const { saveCount, restoreCount } = c._counts();
        assert.equal(saveCount, restoreCount, `sub-${n} renderSubtitle must balance ctx.save()/restore()`);
        assert.ok(c._ops.some(op => op.op === 'fillText'), `sub-${n} renderSubtitle must draw subtitle text`);
    }

    // 2. Render each of the 6 new Thanksgiving vector cursor icons & verify box_wipe leading-edge progression + non-squashed brush clip
    const brushCalls = [];
    const origDrawBrush = ReelsBrushEngine.drawBrush.bind(ReelsBrushEngine);
    ReelsBrushEngine.drawBrush = (ctx, x, y, w, h, opts) => {
        brushCalls.push({ x, y, w, h, style: opts?.style });
        return origDrawBrush(ctx, x, y, w, h, opts);
    };
    sandbox.window.ReelsBrushEngine.drawBrush = ReelsBrushEngine.drawBrush;

    const tipCtxEarly = makeCtx();
    const tipCtxLate = makeCtx();
    const tipRendererEarly = new ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: () => tipCtxEarly });
    const tipRendererLate = new ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: () => tipCtxLate });
    const baseWipeStyle = {
        ...ReelsStyleEngine.applySubtitlePreset('sub-230'),
        use_box: true,
        box_brush_style: 'watercolor',
        anim_in_type: 'box_wipe',
        subtitle_cursor_enabled: true,
        fullpage_typewriter_cursor_kind: 'maple_leaf',
        fullpage_typewriter_cursor_scale: 1.0,
    };
    const wipeSeg = { start: 0, end: 2.0, text: 'Walking through quiet autumn grace\nunder golden maple trees' };
    tipRendererEarly.renderSubtitle(baseWipeStyle, wipeSeg, 0.25, 1080, 1920);
    const earlyBrushCount = brushCalls.length;
    tipRendererLate.renderSubtitle(baseWipeStyle, wipeSeg, 1.35, 1080, 1920);

    // Brush engine must always receive full un-squashed box width while ctx.clip clips horizontally
    assert.ok(earlyBrushCount >= 1 && brushCalls.length >= earlyBrushCount + 2, 'drawBrush must be invoked for brush box_wipe at both early and late times');
    const widthsEarly = brushCalls.slice(0, earlyBrushCount).map(b => b.w);
    const widthsLate = brushCalls.slice(earlyBrushCount).map(b => b.w);
    assert.ok(Math.abs(Math.max(...widthsEarly) - Math.max(...widthsLate)) < 1, 'box_wipe brush drawBrush width must remain full un-squashed width and wipe via ctx.clip()');
    assert.ok(tipCtxEarly._ops.some(o => o.op === 'clip') && tipCtxLate._ops.some(o => o.op === 'clip'), 'box_wipe brush render must clip horizontally');

    // Moving leading cursor translates further right/down between t=0.25 and t=1.35
    const maxTipTranslate = (ops) => {
        const fillsIdx = ops.findIndex(o => o.op === 'fillText');
        const tipOps = fillsIdx >= 0 ? ops.slice(fillsIdx) : ops;
        const trs = tipOps.filter(o => o.op === 'translate' && Number.isFinite(o.x) && o.x > 0);
        return trs.length ? trs[trs.length - 1] : null;
    };
    const trEarly = maxTipTranslate(tipCtxEarly._ops);
    const trLate = maxTipTranslate(tipCtxLate._ops);
    assert.ok(trEarly && trLate, 'box_wipe with subtitle_cursor_enabled must draw vector writing tip via ctx.translate');
    assert.ok(trLate.y > trEarly.y || (Math.abs(trLate.y - trEarly.y) < 1 && trLate.x > trEarly.x), `Expected leading-edge cursor at t=1.35 (${JSON.stringify(trLate)}) to advance past t=0.25 (${JSON.stringify(trEarly)})`);

    // Every new Thanksgiving icon kind renders cleanly without throwing or leaking ctx state
    for (const kind of thxTips) {
        const kc = makeCtx();
        const kr = new ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: () => kc });
        kr.renderSubtitle({ ...baseWipeStyle, fullpage_typewriter_cursor_kind: kind }, wipeSeg, 0.85, 1080, 1920);
        const { saveCount, restoreCount } = kc._counts();
        assert.equal(saveCount, restoreCount, `Cursor tip "${kind}" must balance ctx.save()/restore()`);
        assert.ok(kc._ops.some(o => o.op === 'translate' && o.x > 0), `Cursor tip "${kind}" must render vector artwork`);
    }

    // RichText box_wipe + subtitle_cursor_enabled with keyword spans renders cleanly
    const richCtx = makeCtx();
    const richRenderer = new ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: () => richCtx });
    richRenderer.renderSubtitle(
        {
            ...baseWipeStyle,
            keywords: [{ words: ['grace'], color: '#9E472A', bold: true }],
            highlight_rules: [{ words: ['grace'], color: '#9E472A', bold: true }],
        },
        wipeSeg,
        0.9,
        1080,
        1920
    );
    const richCounts = richCtx._counts();
    assert.equal(richCounts.saveCount, richCounts.restoreCount, 'drawRichText box_wipe + cursor must balance save/restore');
    assert.ok(richCtx._ops.some(o => o.op === 'fillText'), 'drawRichText box_wipe + cursor must render text');

    // 3. Verify all 16 Thanksgiving scroll prayer/lifestyle cards resolve directly without aliasing
    for (let sc = 199; sc <= 214; sc++) {
        const resolved = resolveBuiltinPreset(`sc-${sc}`);
        assert.ok(resolved && resolved.style, `sc-${sc} must resolve via resolveBuiltinPreset with .style`);
        assert.equal(resolved.category, '🍂 感恩节 · 极简秋日与祈祷卡', `sc-${sc} must carry Thanksgiving category`);
        const scPreset = REELS_BUILTIN_SCROLL_STYLE_PRESETS[resolved.name];
        assert.ok(scPreset, `sc-${sc} resolved target "${resolved.name}" must exist in REELS_BUILTIN_SCROLL_STYLE_PRESETS`);
        assert.strictEqual(scPreset.preset_id, `sc-${sc}`, `sc-${sc} must map directly to itself`);
        assert.equal(scPreset.category, '🍂 感恩节 · 极简秋日与祈祷卡', `sc-${sc} preset must carry Thanksgiving category`);
        assert.ok(String(scPreset.bg_style || '').startsWith('thx_'), `sc-${sc} must use a Thanksgiving thx_* card board (got ${scPreset.bg_style})`);

        const scCtx = makeCtx();
        const ov = ReelsOverlay.createScrollOverlay({
            ...scPreset,
            x: 80, y: 360, w: 920, h: 1200,
            scroll_title: 'Thankful & Peaceful',
            scroll_title_enabled: true,
            content: 'Lord, thank You for warm mornings,\nsteady provision, and quiet gratitude.',
        });
        ReelsOverlay.drawOverlay(scCtx, ov, 1.2, 1080, 1920);
        const counts = scCtx._counts();
        assert.equal(counts.saveCount, counts.restoreCount, `sc-${sc} drawOverlay must balance ctx.save()/restore()`);
        assert.ok(scCtx._ops.some(o => o.op === 'fillText'), `sc-${sc} drawOverlay must draw text`);
    }
});

test('UI toggle/button/grain responsiveness: ReelsDecorPanel & ReelsOverlayPanel coalesce renders, skip sync AutoSave/task rebuild, and history skips redundant pointerdown snapshots', () => {
    const os = require('node:os');
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    const batchReelsSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    const previewV2Src = fs.readFileSync(path.join(ROOT, 'src/reels-preview-v2.js'), 'utf8');

    // 1. Test ReelsDecorPanel checkbox/slider toggles & flush
    const makeControl = (id, { type = 'checkbox', tagName = 'INPUT', checked = false, value = '' } = {}) => {
        const listeners = {};
        const classes = new Set();
        return {
            id,
            type,
            tagName,
            checked,
            value,
            dataset: {},
            style: {},
            textContent: '',
            innerHTML: '',
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                toggle: (c, f) => (f === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (f ? classes.add(c) : classes.delete(c))),
                contains: (c) => classes.has(c),
            },
            addEventListener(evt, fn) { (listeners[evt] ||= []).push(fn); },
            dispatch(evt) { (listeners[evt] || []).forEach(fn => fn({ type: evt, target: this, preventDefault() {}, stopPropagation() {} })); },
            querySelector: () => null,
            querySelectorAll: () => [],
        };
    };

    const rdpControls = {
        '#rdp-style-select': makeControl('rdp-style-select', { type: '', tagName: 'SELECT', value: 'dark_floating_dust' }),
        '#rdp-style-scope': makeControl('rdp-style-scope', { type: '', tagName: 'SELECT', value: 'folder' }),
        '#rdp-apply-all': makeControl('rdp-apply-all', { checked: true }),
        '#rdp-dark-enabled': makeControl('rdp-dark-enabled', { checked: true }),
        '#rdp-dark-vignette': makeControl('rdp-dark-vignette', { type: 'range', value: '60' }),
        '#rdp-vignette-spread': makeControl('rdp-vignette-spread', { type: 'range', value: '55' }),
        '#rdp-dark-tint': makeControl('rdp-dark-tint', { type: 'color', value: '#05070C' }),
        '#rdp-grain-enabled': makeControl('rdp-grain-enabled', { checked: false }),
        '#rdp-grain-intensity': makeControl('rdp-grain-intensity', { type: 'range', value: '0' }),
        '#rdp-grain-size': makeControl('rdp-grain-size', { type: 'range', value: '100' }),
        '#rdp-grain-warmth': makeControl('rdp-grain-warmth', { type: 'range', value: '0' }),
        '#rdp-film-scratches': makeControl('rdp-film-scratches', { checked: false }),
        '#rdp-light-leak': makeControl('rdp-light-leak', { checked: false }),
        '#rdp-floating-particles': makeControl('rdp-floating-particles', { checked: true }),
        '#rdp-particle-mode': makeControl('rdp-particle-mode', { type: '', tagName: 'SELECT', value: 'dust' }),
        '#rdp-glow-stars': makeControl('rdp-glow-stars', { checked: false }),
        '#rdp-snowflakes': makeControl('rdp-snowflakes', { checked: false }),
        '#rdp-corner-ornaments': makeControl('rdp-corner-ornaments', { checked: false }),
        '#rdp-edge-garland': makeControl('rdp-edge-garland', { checked: false }),
        '#rdp-layout': makeControl('rdp-layout', { type: '', tagName: 'SELECT', value: 'edges_and_float' }),
        '#rdp-density': makeControl('rdp-density', { type: 'range', value: '55' }),
        '#rdp-size': makeControl('rdp-size', { type: 'range', value: '100' }),
        '#rdp-glow': makeControl('rdp-glow', { type: 'range', value: '100' }),
        '#rdp-speed': makeControl('rdp-speed', { type: 'range', value: '100' }),
        '#rdp-margin': makeControl('rdp-margin', { type: 'range', value: '36' }),
        '#rdp-center-clear': makeControl('rdp-center-clear', { type: 'range', value: '65' }),
        '#rdp-opacity': makeControl('rdp-opacity', { type: 'range', value: '255' }),
        '#rdp-color1': makeControl('rdp-color1', { type: 'color', value: '#FFD700' }),
        '#rdp-color2': makeControl('rdp-color2', { type: 'color', value: '#FFFDF5' }),
        '#rdp-layer-list': makeControl('rdp-layer-list', { type: '', tagName: 'DIV' }),
    };

    const t1 = {
        id: 't1',
        _batchTabId: 'tab1',
        _folderQueueId: 'q1',
        overlays: [{ id: 'dec_1', type: 'decor', decor_style: 'dark_floating_dust', decor_grain_enabled: false, decor_grain_intensity: 0 }],
    };
    const t2 = {
        id: 't2',
        _batchTabId: 'tab1',
        _folderQueueId: 'q1',
        overlays: [{ id: 'dec_2', type: 'decor', decor_style: 'dark_floating_dust', decor_grain_enabled: false, decor_grain_intensity: 0 }],
    };

    let autoSaveCount = 0;
    let renderTaskListCount = 0;
    let syncTabCount = 0;
    let syncEditorCount = 0;
    let canvasRenderCount = 0;
    let onOverlayChangeCount = 0;
    let v2RequestRenderCount = 0;
    let v2SyncRenderCount = 0;
    let historyScheduleCount = 0;
    let layerListRenderCount = 0;
    let nextTimerId = 1;
    let timers = [];
    let rafQueue = [];

    const sandbox = {
        console,
        Math,
        JSON,
        Date,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Set,
        Map,
        window: {},
        document: {
            head: { appendChild() {}, querySelector: () => null },
            body: { appendChild() {} },
            getElementById: (id) => rdpControls['#' + id] || null,
            createElement: (tag) => makeControl('dyn_' + tag, { type: '', tagName: tag }),
        },
        _reelsState: { tasks: [t1, t2], selectedIdx: 0 },
        _batchTableState: { activeTabId: 'tab1', tabs: [{ id: 'tab1', tasks: [t1, t2], _dirty: false }] },
        _syncCurrentOverlayEditorToSelectedTask: () => { syncEditorCount++; },
        _syncTasksToActiveTab: () => { syncTabCount++; },
        _batchAutoSave: () => { autoSaveCount++; return true; },
        _renderTaskList: () => { renderTaskListCount++; },
        _scheduleReelsHistorySave: () => { historyScheduleCount++; },
        ReelsPreviewV2: {
            isOpen: () => true,
            requestRender: () => { v2RequestRenderCount++; },
            render: () => { v2SyncRenderCount++; },
        },
        ReelsOverlay: {
            DECOR_OVERLAY_STYLES: { dark_floating_dust: { name: '黑金微粒' } },
            createDecorOverlay: (opts) => ({ id: 'dec_new', type: 'decor', ...opts }),
        },
        setTimeout: (fn, ms) => { const id = nextTimerId++; timers.push({ id, fn, ms, cleared: false }); return id; },
        clearTimeout: (id) => { const item = timers.find(t => t.id === id); if (item) item.cleared = true; },
        requestAnimationFrame: (fn) => { const id = nextTimerId++; rafQueue.push({ id, fn, cancelled: false }); return id; },
        cancelAnimationFrame: (id) => { const item = rafQueue.find(r => r.id === id); if (item) item.cancelled = true; },
        localStorage: { getItem: () => null, setItem: () => {} },
    };
    sandbox.window = sandbox;
    sandbox.ReelsPreviewV2 = sandbox.ReelsPreviewV2;
    vm.createContext(sandbox);
    vm.runInContext(`${panelSrc}\nwindow.ReelsOverlayPanel = ReelsOverlayPanel;\nwindow.ReelsDecorPanel = ReelsDecorPanel;`, sandbox);

    const grainReadout = makeControl('rdp-grain-intensity-num', { type: 'number', value: '0' });
    grainReadout.dataset = { link: 'rdp-grain-intensity' };
    const decorPanel = Object.create(sandbox.ReelsDecorPanel.prototype);
    decorPanel.container = {
        querySelector: (sel) => rdpControls[sel] || null,
        querySelectorAll: (sel) => (sel === '.rop-num-readout[data-link]' ? [grainReadout] : []),
    };
    decorPanel.linkedOverlayPanel = { _refreshList: () => {}, _syncFromOverlay: () => {} };
    decorPanel.videoCanvas = {
        overlayMgr: { overlays: t1.overlays },
        render: () => { canvasRenderCount++; },
        onOverlayChange: () => { onOverlayChangeCount++; },
    };
    decorPanel._selectedDecorId = 'dec_1';
    decorPanel._activeCategory = 'all';
    decorPanel._syncing = false;
    const origRenderLayerList = decorPanel._renderLayerList.bind(decorPanel);
    decorPanel._renderLayerList = () => { layerListRenderCount++; origRenderLayerList(); };
    decorPanel._bindEvents();

    // Simulate clicking "电影颗粒" checkbox (Chromium emits both input & change) + dragging grain intensity
    rdpControls['#rdp-grain-enabled'].checked = true;
    rdpControls['#rdp-grain-enabled'].dispatch('input');
    rdpControls['#rdp-grain-enabled'].dispatch('change');
    for (const val of ['25', '50', '78']) {
        rdpControls['#rdp-grain-intensity'].value = val;
        rdpControls['#rdp-grain-intensity'].dispatch('input');
    }

    assert.strictEqual(autoSaveCount, 0, 'Toggling grain / dragging slider must NOT run _batchAutoSave synchronously on click');
    assert.strictEqual(renderTaskListCount, 0, 'Toggling grain must NOT synchronously rebuild #reels-task-list DOM');
    assert.strictEqual(syncTabCount, 0, 'Toggling grain must NOT synchronously call _syncTasksToActiveTab');
    assert.strictEqual(onOverlayChangeCount, 0, 'Toggling grain must NOT synchronously invoke onOverlayChange/timeline rebuild');
    assert.strictEqual(v2SyncRenderCount, 0, 'Toggling grain must NOT synchronously invoke ReelsPreviewV2.render()');
    assert.strictEqual(t1.overlays[0].decor_grain_enabled, true, 'Active task overlay model must update immediately in memory');
    assert.strictEqual(t1.overlays[0].decor_grain_intensity, 78, 'Active task overlay grain intensity must update immediately in memory');

    // Drain rAF -> coalesces canvas + V2 preview + layer list into one frame without heavy persistence
    for (const r of rafQueue) {
        if (!r.cancelled) r.fn();
    }
    rafQueue = [];
    assert.strictEqual(canvasRenderCount, 1, 'Multiple click/slider events in a frame must coalesce into 1 canvas render');
    assert.strictEqual(v2RequestRenderCount, 1, 'Decor changes must coalesce V2 preview render via requestRender()');
    assert.strictEqual(layerListRenderCount, 1, 'Layer list UI refresh must coalesce to 1 update per frame');
    assert.strictEqual(autoSaveCount, 0, 'Frame paint must finish before _batchAutoSave runs');

    // Run debounced scope sync timer (reset timer excluded since ms===0)
    const syncTimers = timers.filter(t => !t.cleared && t.ms > 0);
    assert.ok(syncTimers.length >= 1, 'Debounced scope sync timer must be scheduled');
    syncTimers.forEach(t => t.fn());
    assert.strictEqual(t2.overlays[0].decor_grain_enabled, true, 'Debounced flush must propagate grain enable to scoped sibling task t2');
    assert.strictEqual(t2.overlays[0].decor_grain_intensity, 78, 'Debounced flush must propagate grain intensity to scoped sibling task t2');
    assert.strictEqual(autoSaveCount, 1, 'Debounced flush must invoke _batchAutoSave once after burst');
    assert.strictEqual(syncEditorCount, 0, 'Non-structural grain toggle must not force full timeline rebuild via _syncCurrentOverlayEditorToSelectedTask');
    assert.strictEqual(renderTaskListCount, 0, 'Non-structural grain toggle must not rebuild #reels-task-list DOM even on debounced flush');
    assert.strictEqual(historyScheduleCount, 1, 'Debounced flush must schedule background undo history save');

    // 2. Verify ReelsOverlayPanel discrete checkbox deduplicates input+change & defers commit sync off synchronous click turn
    const ropCheckbox = makeControl('rop-disabled', { checked: true });
    let ropCommitCalls = 0;
    const ropSandbox = {
        console,
        setTimeout: (fn, ms) => { const id = nextTimerId++; timers.push({ id, fn, ms, cleared: false }); return id; },
        clearTimeout: (id) => { const item = timers.find(t => t.id === id); if (item) item.cleared = true; },
        window: {},
    };
    ropSandbox.window = ropSandbox;
    vm.createContext(ropSandbox);
    const helperStart = panelSrc.indexOf('function _isDiscreteOverlayControl(');
    const helperEnd = panelSrc.indexOf('/** 四舍五入', helperStart);
    vm.runInContext(panelSrc.slice(helperStart, helperEnd), ropSandbox);
    ropSandbox._bindDiscreteAwareSync(ropCheckbox, () => { ropCommitCalls++; });
    ropCheckbox.dispatch('input');
    ropCheckbox.dispatch('change');
    assert.strictEqual(ropCommitCalls, 1, '_bindDiscreteAwareSync must deduplicate input + change on checkbox click');

    // 3. Verify V2 & V1 preview toggle handlers use requestRender instead of synchronous render()
    assert.ok(!previewV2Src.includes("subtitleToggle?.addEventListener('change', () => {\n            if (exportSubtitleToggle) exportSubtitleToggle.checked = subtitleToggle.checked;\n            if (typeof window.reelsOnSubtitleToggleChange === 'function') {\n                window.reelsOnSubtitleToggleChange(exportSubtitleToggle || subtitleToggle);\n            }\n            render();"), 'Preview V2 toggles must not call synchronous render()');
    const toggleStart = batchReelsSrc.indexOf('function _requestReelsPreviewV2Render(');
    const toggleEnd = batchReelsSrc.indexOf('window.reelsOnDecorToggleChange =', toggleStart);
    assert.ok(toggleStart > 0 && toggleEnd > toggleStart);
    let v1PrevCalls = 0;
    let v2Req = 0;
    let v2Sync = 0;
    const toggleCtx = {
        window: {
            ReelsPreviewV2: { requestRender: () => { v2Req++; }, render: () => { v2Sync++; } },
        },
        document: { getElementById: () => null, querySelector: () => null },
        _reelsState: {},
        reelsUpdatePreview: () => { v1PrevCalls++; },
        showToast: () => {},
        alert: () => {},
    };
    vm.createContext(toggleCtx);
    vm.runInContext(`${batchReelsSrc.slice(toggleStart, toggleEnd)}\nwindow.reelsOnDecorToggleChange = reelsOnDecorToggleChange;`, toggleCtx);
    toggleCtx.reelsOnSubtitleToggleChange({ checked: false });
    toggleCtx.reelsOnOverlayToggleChange({ checked: false });
    toggleCtx.reelsOnDecorToggleChange({ checked: false });
    assert.strictEqual(v1PrevCalls, 3);
    assert.strictEqual(v2Req, 3, 'Toggle handlers must schedule ReelsPreviewV2.requestRender()');
    assert.strictEqual(v2Sync, 0, 'Toggle handlers must not call synchronous ReelsPreviewV2.render()');

    // 4. Verify history listeners skip synchronous snapshot on pointerdown once baseline exists & flush on _flushReelsHistory
    const histStart = batchReelsSrc.indexOf('function _reelsHistoryEventInEditor(');
    const histEnd = batchReelsSrc.indexOf('setTimeout(()=>{if(_reelsHistoryStack.length===0)', histStart);
    assert.ok(histStart > 0 && histEnd > histStart);
    const docListeners = {};
    let historySaves = 0;
    let idleQueued = 0;
    const histTimers = [];
    const btnTarget = { closest: (sel) => (sel.includes('button') ? btnTarget : null), type: 'button', tagName: 'BUTTON' };
    const histCtx = {
        window: {
            reelsSaveHistory: () => { historySaves++; },
            reelsUndo: () => {},
            reelsRedo: () => {},
        },
        document: {
            getElementById: (id) => (id === 'batch-reels-panel' ? { classList: { contains: () => true } } : null),
            addEventListener: (evt, fn) => { (docListeners[evt] ||= []).push(fn); },
        },
        _reelsState: { tasks: new Array(30).fill({}), selectedIdx: 0 },
        _reelsHistoryStack: ['S0'],
        _isRestoringHistory: false,
        setTimeout: (fn, ms) => { const id = nextTimerId++; histTimers.push({ id, fn, ms, cleared: false }); return id; },
        clearTimeout: (id) => { const item = histTimers.find(t => t.id === id); if (item) item.cleared = true; },
        requestIdleCallback: (fn) => { idleQueued++; return 1; },
        cancelIdleCallback: () => {},
    };
    vm.createContext(histCtx);
    vm.runInContext(batchReelsSrc.slice(histStart, histEnd), histCtx);
    docListeners.pointerdown.forEach(fn => fn({ target: btnTarget, defaultPrevented: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false }));
    assert.strictEqual(historySaves, 0, 'pointerdown with existing undo baseline must NOT synchronously serialize full project history');
    docListeners.click.forEach(fn => fn({ target: btnTarget }));
    assert.strictEqual(historySaves, 0, 'click must debounce history snapshot rather than running synchronously');
    assert.ok(histTimers.some(t => !t.cleared && t.ms >= 250), 'click must schedule debounced history snapshot (>=250ms, not 0ms)');
    histCtx._flushReelsHistory();
    assert.strictEqual(historySaves, 1, '_flushReelsHistory must synchronously capture pending history before Undo/Export/Save');

    // 5. Verify preload.js queues batch workspace disk writes off the synchronous UI call stack and flushes via flushWorkspaceSaves()
    const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');
    assert.ok(preloadSrc.includes('_writeBatchWorkspaceContent') && preloadSrc.includes('flushWorkspaceSaves:'), 'preload.js must provide non-blocking workspace saver and flushWorkspaceSaves');
    const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-preload-async-'));
    try {
        const exposed = {};
        let beforeUnloadHandler = null;
        const preloadSandbox = {
            require: (id) => {
                if (id === 'electron') {
                    return {
                        contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
                        ipcRenderer: { sendSync: () => ({ ok: true, profileDir: tmpProfile, projectsDir: path.join(tmpProfile, 'projects') }), invoke: async () => ({}), on: () => {}, removeListener: () => {} },
                        webUtils: { getPathForFile: () => '' },
                        webFrame: { setZoomFactor() {}, getZoomFactor: () => 1 },
                        clipboard: {},
                    };
                }
                if (id === './services/sharedProfile') return { getPrimarySharedProfileDir: () => tmpProfile, getCandidateProfileDirs: () => [tmpProfile], getCandidateProjectDirs: () => [path.join(tmpProfile, 'projects')] };
                if (id === './services/reels-frame-bridge') return { createReelsFrameBridge: () => ({}) };
                return require(id);
            },
            __dirname: path.join(ROOT, 'electron'),
            process,
            console,
            Buffer,
            location: { hash: '' },
            localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {} },
            window: { addEventListener: (evt, fn) => { if (evt === 'beforeunload') beforeUnloadHandler = fn; }, dispatchEvent: () => {} },
            CustomEvent: function(n, o) { this.type = n; this.detail = o?.detail; },
            setInterval: () => 1,
            setTimeout: (fn) => { return 1; },
            clearTimeout: () => {},
        };
        vm.createContext(preloadSandbox);
        vm.runInContext(preloadSrc, preloadSandbox);
        assert.strictEqual(exposed.electronAPI.saveBatchWorkspace('{"version":"1.0"}'), false, 'Invalid workspace payload must synchronously return false');
        const payload = JSON.stringify({ version: '2.0', tabs: [{ id: 'tab_1', tasks: [{ id: 't1' }] }] });
        const wsFile = path.join(tmpProfile, 'projects', 'workspace-autosave.json');
        assert.strictEqual(exposed.electronAPI.saveBatchWorkspace(payload), true, 'Valid workspace payload must return true immediately');
        assert.strictEqual(fs.existsSync(wsFile), false, 'saveBatchWorkspace must NOT synchronously write disk inside click turn');
        assert.strictEqual(typeof beforeUnloadHandler, 'function', 'preload.js must register beforeunload flush');
        exposed.electronAPI.flushWorkspaceSaves();
        assert.strictEqual(fs.existsSync(wsFile), true, 'flushWorkspaceSaves() must flush queued workspace payload to disk synchronously');
        assert.strictEqual(fs.readFileSync(wsFile, 'utf8'), payload);
    } finally {
        fs.rmSync(tmpProfile, { recursive: true, force: true });
    }
});

test('Live Projects and Sealed Templates keep isolated stores, support blank tabs and safe template import', () => {
    const os = require('node:os');
    const Module = require('node:module');
    const origLoad = Module._load;
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-split-stores-'));
    const templatesResolved = require.resolve('../electron/services/templates');
    const mockApp = { getPath: () => tmpUserData };
    const mockShared = {
        getCandidateTemplateDirs: () => [path.join(tmpUserData, 'videokit-templates')],
        getCandidateLiveProjectDirs: () => [path.join(tmpUserData, 'videokit-live-projects')],
        isIsolatedTestProfile: () => true,
    };

    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'electron') return { app: mockApp };
            if (request === './sharedProfile' && parent && parent.filename.endsWith(`${path.sep}templates.js`)) {
                return mockShared;
            }
            return origLoad.apply(this, arguments);
        };
        delete require.cache[templatesResolved];
        const tplService = require('../electron/services/templates');

        const tplFolder = tplService.createTemplateFolder('节日模板').folder;
        assert.ok(tplFolder.id);
        const sealed = tplService.saveTemplate({
            name: '感恩节爆款',
            folderId: tplFolder.id,
            projectData: { tasks: [{ id: 's1', baseName: 'hook', txtContent: 'sealed' }], style: { fontSize: 54 } },
        });
        assert.ok(sealed.id.startsWith('tpl_'));
        assert.ok(fs.existsSync(path.join(tmpUserData, 'videokit-templates', `${sealed.id}.json`)));
        assert.equal(tplService.listTemplates().length, 1);
        assert.equal(tplService.listLiveProjects().length, 0);

        const liveFolder = tplService.createLiveProjectFolder('正在制作').folder;
        assert.ok(liveFolder.id);
        const blank = tplService.saveLiveProject({
            name: '新建空白标签',
            folderId: liveFolder.id,
            projectData: { tasks: [] },
        });
        assert.ok(blank.id.startsWith('prj_'));
        assert.ok(fs.existsSync(path.join(tmpUserData, 'videokit-live-projects', `${blank.id}.json`)));
        const liveListBeforeImport = tplService.listLiveProjects();
        assert.equal(liveListBeforeImport.length, 1);
        assert.equal(liveListBeforeImport[0].templateType, '空白标签');
        assert.equal(liveListBeforeImport[0].taskCount, 0);
        assert.equal(tplService.listTemplates().length, 1);

        const imported = tplService.importTemplatesIntoLiveProjects({ copyAllFolders: true });
        assert.equal(imported.importedCount, 1);
        const liveFolders = tplService.readLiveProjectFolders();
        const importedFolder = liveFolders.folders.find(f => f.name === '节日模板');
        assert.ok(importedFolder);
        const importedLive = tplService.listLiveProjects().find(p => p.name === '感恩节爆款');
        assert.ok(importedLive && importedLive.id.startsWith('prj_'));
        assert.equal(liveFolders.assignments[importedLive.id], importedFolder.id);

        // Modifying or deleting the imported live project must NEVER mutate the sealed template
        tplService.saveLiveProject({
            id: importedLive.id,
            name: '感恩节爆款-已改名',
            projectData: { tasks: [{ id: 's1', baseName: 'hook', txtContent: 'mutated_live' }] },
        });
        assert.equal(tplService.getTemplate(sealed.id).name, '感恩节爆款');
        assert.equal(tplService.getTemplate(sealed.id).projectData.tasks[0].txtContent, 'sealed');
        tplService.deleteLiveProject(importedLive.id);
        assert.equal(tplService.listTemplates().length, 1);
        assert.equal(tplService.getTemplate(sealed.id).projectData.tasks[0].txtContent, 'sealed');
    } finally {
        Module._load = origLoad;
        delete require.cache[templatesResolved];
        fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
});

test('Workspace tabs auto-save blank & edited Live Projects while Sealed Templates load as isolated non-overwriting copies', async () => {
    const os = require('node:os');
    const Module = require('node:module');
    const origLoad = Module._load;
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-live-vs-sealed-'));
    const templatesResolved = require.resolve('../electron/services/templates');
    const mockApp = { getPath: () => tmpUserData };
    const mockShared = {
        getCandidateTemplateDirs: () => [path.join(tmpUserData, 'videokit-templates')],
        getCandidateLiveProjectDirs: () => [path.join(tmpUserData, 'videokit-live-projects')],
        isIsolatedTestProfile: () => true,
    };

    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'electron') return { app: mockApp };
            if (request === './sharedProfile' && parent && parent.filename.endsWith(`${path.sep}templates.js`)) {
                return mockShared;
            }
            return origLoad.apply(this, arguments);
        };
        delete require.cache[templatesResolved];
        const tplService = require('../electron/services/templates');

        const liveFolder = tplService.createLiveProjectFolder('日常工作工程').folder;
        const sealedSaved = tplService.saveTemplate({
            name: '感恩节爆款模板',
            projectData: {
                tasks: [{ id: 's1', baseName: 'prayer', txtContent: 'sealed snapshot' }],
                style: { fontSize: 60 },
            },
        });

        const liveSaveCalls = [];
        const tplSaveCalls = [];
        const apiFetchMock = async (url, init = {}) => {
            const u = String(url || '');
            const body = init.body ? JSON.parse(init.body) : {};
            let res = { success: true };
            if (u.endsWith('/live-projects/folders/list')) res = tplService.readLiveProjectFolders();
            else if (u.endsWith('/live-projects/folders/create')) res = tplService.createLiveProjectFolder(body.name, body.parentId || '');
            else if (u.endsWith('/live-projects/list')) res = tplService.listLiveProjects();
            else if (u.endsWith('/live-projects/get')) res = tplService.getLiveProject(body.id);
            else if (u.endsWith('/live-projects/get-many')) res = tplService.getLiveProjectsByIds(body.ids || []);
            else if (u.endsWith('/live-projects/save')) { liveSaveCalls.push(body); res = tplService.saveLiveProject(body); }
            else if (u.endsWith('/templates/folders/list')) res = tplService.readTemplateFolders();
            else if (u.endsWith('/templates/list')) res = tplService.listTemplates();
            else if (u.endsWith('/templates/get')) res = tplService.getTemplate(body.id);
            else if (u.endsWith('/templates/save')) { tplSaveCalls.push(body); res = tplService.saveTemplate(body); }
            return { ok: true, status: 200, json: async () => ({ data: res }) };
        };

        const makeEl = (overrides = {}) => ({
            value: '', checked: false, disabled: false, textContent: '', innerHTML: '', style: {}, dataset: {},
            options: [], children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            appendChild() {}, removeChild() {}, remove() {}, contains: () => false, addEventListener() {}, setAttribute() {},
            focus() {}, click() {}, querySelector: () => null, querySelectorAll: () => [],
            getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, left: 0 }),
            getContext: () => ({
                font: '', globalAlpha: 1, save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
                quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, arcTo() {}, rect() {}, clip() {}, fill() {}, stroke() {},
                fillRect() {}, strokeRect() {}, clearRect() {}, fillText() {}, strokeText() {}, translate() {}, rotate() {},
                scale() {}, setLineDash() {}, createPattern: () => ({}), createLinearGradient: () => ({ addColorStop() {} }),
                createRadialGradient: () => ({ addColorStop() {} }), measureText: (txt) => ({ width: String(txt || '').length * 10 }),
            }),
            ...overrides,
        });
        const domElements = new Map([
            ['reels-task-list', makeEl()],
            ['reels-task-count', makeEl()],
            ['reels-task-panel-count', makeEl()],
            ['reels-active-folder-bar', makeEl()],
            ['reels-batch-table-container', makeEl({ style: { display: 'none' } })],
            ['reels-work-mode', makeEl({ value: 'srt' })],
            ['reels-quality', makeEl({ value: 'medium' })],
            ['reels-export-engine', makeEl({ value: 'precise' })],
            ['reels-suffix', makeEl({ value: '_subtitled' })],
            ['reels-naming-mode', makeEl({ value: 'text' })],
            ['reels-task-name-display', makeEl({ value: 'full' })],
        ]);
        const documentStub = {
            head: makeEl(), body: makeEl(), createElement: () => makeEl(),
            getElementById: (id) => domElements.get(id) || null,
            querySelector: () => null, querySelectorAll: () => [],
            addEventListener() {}, removeEventListener() {},
        };

        const sandbox = loadBrowserScript('src/reels-project.js', {
            window: {
                innerWidth: 1280, innerHeight: 800, location: { hash: '' },
                addEventListener() {}, removeEventListener() {},
                electronAPI: {
                    toFileUrl: (p) => 'file:///' + String(p || '').replace(/\\/g, '/'),
                    getDefaultProjectDir: () => '',
                    saveBatchWorkspace: () => true,
                    readBatchWorkspace: () => '',
                },
            },
            document: documentStub,
            API_BASE: 'http://127.0.0.1:0/api',
            apiFetch: apiFetchMock,
            setTimeout: () => 0,
            clearTimeout: () => {},
            setInterval: () => 0,
            clearInterval: () => {},
            requestAnimationFrame: () => 0,
            getComputedStyle: () => ({ display: 'none', height: '0px' }),
            getWritingVisualStyle: (s) => s,
            reelsRefreshWritingTitleEditor: () => {},
            reelsRefreshSpeechWritingImageUI: () => {},
            showToast: () => {},
            alert: () => {},
            confirm: () => true,
        });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8'), sandbox, { filename: 'src/reels-batch-table.js' });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8'), sandbox, { filename: 'src/batch-reels.js' });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-templates.js'), 'utf8'), sandbox, { filename: 'src/reels-templates.js' });

        assert.equal(typeof sandbox.window.openProjectLibrary, 'function');
        assert.equal(typeof sandbox.window.openTemplateLibrary, 'function');

        // 1. Creating a blank tab immediately marks it as a Live Project and saves empty tasks to /live-projects/save
        vm.runInContext(`
            _batchTableState.tabs = [];
            _batchTableState.activeTabId = '';
            _batchTableState.activeLibraryFolderId = ${JSON.stringify(liveFolder.id)};
            _batchTableState.activeLibraryFolderPath = '日常工作工程';
            _batchTableState.libraryScopeMode = 'folder';
            _addTab('空白工作标签', '', { activate: true });
        `, sandbox);
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        const tabAfterBlank = JSON.parse(vm.runInContext(`JSON.stringify(_batchTableState.tabs[0])`, sandbox));
        assert.equal(tabAfterBlank._isLiveProject, true);
        assert.equal(tabAfterBlank.libraryFolderId, liveFolder.id);
        assert.ok(tabAfterBlank.libraryTemplateId.startsWith('prj_'));
        assert.equal(tplSaveCalls.length, 0);
        const savedBlankRecord = tplService.getLiveProject(tabAfterBlank.libraryTemplateId);
        assert.equal(savedBlankRecord.name, '空白工作标签');
        assert.equal(savedBlankRecord.projectData.tasks.length, 0);

        // 2. Editing the tab syncs tasks back to Live Projects store (still never /templates/save)
        vm.runInContext(`
            window._reelsState.tasks = [{ id: 't_live', baseName: 'clip1', txtContent: 'updated live copy' }];
            _syncTasksToActiveTab();
        `, sandbox);
        await sandbox.window.reelsSyncWorkspaceTabsBackToLibraryFolder({ silent: true, onlyDirty: true });
        assert.equal(tplSaveCalls.length, 0);
        assert.equal(tplService.getLiveProject(tabAfterBlank.libraryTemplateId).projectData.tasks[0].txtContent, 'updated live copy');

        // 3. Loading a Sealed Template creates an isolated copy that never auto-overwrites templates or live projects
        const liveCallsBeforeSealed = liveSaveCalls.length;
        const sealedPayload = tplService.getTemplate(sealedSaved.id);
        await sandbox.window.reelsApplySealedTemplate(sealedPayload);
        const sealedTabState = JSON.parse(vm.runInContext(`JSON.stringify({
            tab: _batchTableState.tabs.find(t => t.id === _batchTableState.activeTabId),
            activeFolderId: _batchTableState.activeLibraryFolderId,
            txtContent: window._reelsState.tasks[0]?.txtContent,
        })`, sandbox));
        assert.equal(sealedTabState.tab.libraryTemplateId, '');
        assert.equal(sealedTabState.tab.libraryFolderId, '');
        assert.equal(sealedTabState.tab._fromSealedTemplate, true);
        assert.equal(sealedTabState.tab._isLiveProject, false);
        assert.equal(sealedTabState.activeFolderId, '');
        assert.equal(sealedTabState.txtContent, 'sealed snapshot');

        vm.runInContext(`
            window._reelsState.tasks[0].txtContent = 'local derivative';
            _syncTasksToActiveTab();
            reelsMarkStyleDirty({ type: 'change' });
        `, sandbox);
        await sandbox.window.reelsSyncWorkspaceTabsBackToLibraryFolder({ silent: true, onlyDirty: true });
        assert.equal(tplSaveCalls.length, 0, 'Editing a sealed template copy must NEVER auto-overwrite /templates/save');
        assert.equal(liveSaveCalls.length, liveCallsBeforeSealed, 'Editing a standalone sealed template copy must NOT leak to /live-projects/save');
        assert.equal(tplService.getTemplate(sealedSaved.id).projectData.tasks[0].txtContent, 'sealed snapshot');
    } finally {
        Module._load = origLoad;
        delete require.cache[templatesResolved];
        fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
});

test('Project Library and Template Library provide prominent select-all, multi-select mode, Shift-range, invert, folder checkboxes and batch delete/move', async () => {
    const os = require('node:os');
    const Module = require('node:module');
    const origLoad = Module._load;
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-lib-multiselect-'));
    const templatesResolved = require.resolve('../electron/services/templates');
    const mockApp = { getPath: () => tmpUserData };
    const mockShared = {
        getCandidateTemplateDirs: () => [path.join(tmpUserData, 'videokit-templates')],
        getCandidateLiveProjectDirs: () => [path.join(tmpUserData, 'videokit-live-projects')],
        isIsolatedTestProfile: () => true,
    };

    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'electron') return { app: mockApp };
            if (request === './sharedProfile' && parent && parent.filename.endsWith(`${path.sep}templates.js`)) {
                return mockShared;
            }
            return origLoad.apply(this, arguments);
        };
        delete require.cache[templatesResolved];
        const tplService = require('../electron/services/templates');

        const fEmpty = tplService.createLiveProjectFolder('空文件夹可删').folder;
        const fSub = tplService.createLiveProjectFolder('深层子文件夹', fEmpty.id).folder;
        const p1 = tplService.saveLiveProject({ name: '工程A', projectData: { tasks: [] } });
        const p2 = tplService.saveLiveProject({ name: '工程B', projectData: { tasks: [{ id: 't2', baseName: 'v2' }] } });
        const p3 = tplService.saveLiveProject({ name: '工程C', projectData: { tasks: [{ id: 't3', baseName: 'v3' }] } });
        const sealedT = tplService.saveTemplate({ name: '封存参考模板', projectData: { tasks: [{ id: 'st1', baseName: 's' }] } });

        const apiFetchMock = async (url, init = {}) => {
            const u = String(url || '');
            const body = init.body ? JSON.parse(init.body) : {};
            let res = { success: true };
            if (u.endsWith('/live-projects/folders/list')) res = tplService.readLiveProjectFolders();
            else if (u.endsWith('/live-projects/folders/delete')) res = tplService.deleteEmptyLiveProjectFolder(body.id);
            else if (u.endsWith('/live-projects/folders/move')) res = tplService.moveLiveProjectsToFolder(body.ids, body.folderId || '');
            else if (u.endsWith('/live-projects/folders/move-folders')) res = tplService.moveLiveProjectFolders(body.folderIds, body.targetParentId || '');
            else if (u.endsWith('/live-projects/list')) res = tplService.listLiveProjects();
            else if (u.endsWith('/live-projects/get')) res = tplService.getLiveProject(body.id);
            else if (u.endsWith('/live-projects/delete')) res = tplService.deleteLiveProject(body.id);
            else if (u.endsWith('/templates/folders/list')) res = tplService.readTemplateFolders();
            else if (u.endsWith('/templates/list')) res = tplService.listTemplates();
            else if (u.endsWith('/templates/get')) res = tplService.getTemplate(body.id);
            return { ok: true, status: 200, json: async () => ({ data: res }) };
        };

        const elementsById = new Map();
        const trackedClasses = new Set();
        const makeEl = (tag = 'div', overrides = {}) => {
            const el = {
                tagName: String(tag).toUpperCase(),
                id: '',
                value: '',
                checked: false,
                disabled: false,
                textContent: '',
                innerHTML: '',
                style: {},
                dataset: {},
                options: [],
                children: [],
                scrollTop: 0,
                isConnected: true,
                classList: {
                    add(...cs) { cs.forEach(c => el._cls?.add(c)); },
                    remove(...cs) { cs.forEach(c => el._cls?.delete(c)); },
                    toggle(c, force) {
                        if (force === undefined) {
                            if (el._cls.has(c)) { el._cls.delete(c); return false; }
                            el._cls.add(c); return true;
                        }
                        if (force) el._cls.add(c); else el._cls.delete(c);
                        return !!force;
                    },
                    contains: (c) => el._cls.has(c),
                },
                _cls: new Set(),
                setAttribute() {},
                removeAttribute() {},
                getAttribute: () => '',
                addEventListener() {},
                removeEventListener() {},
                appendChild(child) {
                    if (child && child.id) elementsById.set(child.id, child);
                    el.children.push(child);
                    return child;
                },
                removeChild() {},
                remove() { if (el.id) elementsById.delete(el.id); },
                contains: () => false,
                closest: () => null,
                focus() {},
                click() {},
                getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }),
                querySelector(sel) {
                    if (sel === '[data-role="grid-container"]') return el._gridContainer;
                    if (sel === '[data-role="selected-count"]') return el._selCountEl;
                    if (sel === '[data-act="select-all"]') return el._selAllBtn;
                    if (sel === '[data-act="invert-selection"]') return el._invertBtn;
                    if (sel === '[data-act="clear-selection"]') return el._clearBtn;
                    if (sel === '[data-act="toggle-multi-mode"]') return el._multiBtn;
                    if (sel === '[data-act="batch-move"]') return el._moveBtn;
                    if (sel === '[data-act="batch-delete"]') return el._delBtn;
                    if (sel === '#tpl-apply-selected-btn') return el._applySelBtn;
                    if (sel === '#lpl-append-selected-btn') return el._appendSelBtn;
                    if (sel === '#lpl-seal-to-tpl-btn') return el._sealBtn;
                    if (sel === '#tpl-copy-selected-to-live-btn') return el._copyLiveBtn;
                    return null;
                },
                querySelectorAll: () => [],
                ...overrides,
            };
            Object.defineProperty(el, 'id', {
                get() { return el._idVal || ''; },
                set(v) {
                    if (el._idVal) elementsById.delete(el._idVal);
                    el._idVal = String(v || '');
                    if (el._idVal) elementsById.set(el._idVal, el);
                },
            });
            return el;
        };

        const bodyEl = makeEl('body');
        const createdModals = [];
        const documentStub = {
            head: makeEl('head'),
            body: bodyEl,
            readyState: 'complete',
            createElement: (tag) => {
                const el = makeEl(tag);
                if (String(tag).toLowerCase() === 'div') {
                    el._gridContainer = makeEl('div');
                    el._selCountEl = makeEl('span');
                    el._selAllBtn = makeEl('button');
                    el._invertBtn = makeEl('button');
                    el._clearBtn = makeEl('button');
                    el._multiBtn = makeEl('button');
                    el._moveBtn = makeEl('button');
                    el._delBtn = makeEl('button');
                    el._applySelBtn = makeEl('button');
                    el._appendSelBtn = makeEl('button');
                    el._sealBtn = makeEl('button');
                    el._copyLiveBtn = makeEl('button');
                    createdModals.push(el);
                }
                return el;
            },
            getElementById: (id) => elementsById.get(id) || null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener() {},
            removeEventListener() {},
        };

        const storage = new Map();
        const sandbox = loadBrowserScript('src/reels-project.js', {
            window: {
                innerWidth: 1280, innerHeight: 800, location: { hash: '' },
                addEventListener() {}, removeEventListener() {},
                electronAPI: {
                    toFileUrl: (p) => 'file:///' + String(p || '').replace(/\\/g, '/'),
                    getDefaultProjectDir: () => '',
                    saveBatchWorkspace: () => true,
                    readBatchWorkspace: () => '',
                },
            },
            document: documentStub,
            localStorage: {
                getItem: (k) => storage.get(k) ?? null,
                setItem: (k, v) => storage.set(k, String(v)),
            },
            API_BASE: 'http://127.0.0.1:0/api',
            apiFetch: apiFetchMock,
            setTimeout: () => 0,
            clearTimeout: () => {},
            setInterval: () => 0,
            clearInterval: () => {},
            requestAnimationFrame: () => 0,
            cancelAnimationFrame: () => {},
            getComputedStyle: () => ({ display: 'flex', height: '0px', marginTop: '0', marginBottom: '0' }),
            ResizeObserver: function () { return { observe() {}, disconnect() {} }; },
            AbortController: globalThis.AbortController,
            showToast: () => {},
            alert: () => {},
            confirm: () => true,
        });
        sandbox.window.localStorage = sandbox.localStorage;
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-templates.js'), 'utf8'), sandbox, { filename: 'src/reels-templates.js' });

        // 1. Open Live Project Library and verify dedicated selection toolbar & folder checkboxes in rendered HTML
        sandbox.window.openProjectLibrary({ preserveRoot: true });
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        const lplModal = elementsById.get('live-project-library-modal');
        assert.ok(lplModal, 'live-project-library-modal must exist');
        assert.match(lplModal.innerHTML, /data-role="selection-bar"/);
        assert.match(lplModal.innerHTML, /id="lpl-select-all-btn"/);
        assert.match(lplModal.innerHTML, /data-act="invert-selection"/);
        assert.match(lplModal.innerHTML, /data-act="clear-selection"/);
        assert.match(lplModal.innerHTML, /data-act="toggle-multi-mode"/);
        assert.match(lplModal.innerHTML, /id="lpl-append-selected-btn"/);
        assert.match(lplModal.innerHTML, /id="lpl-move-selected-btn"/);
        assert.match(lplModal.innerHTML, /id="lpl-delete-selected-btn"/);
        assert.match(lplModal._gridContainer.innerHTML, /tpl-folder-check/);
        assert.match(lplModal._gridContainer.innerHTML, /tpl-card-check/);

        // 2. Test Select All -> selects ALL items + folders in current view, second call unselects all
        vm.runInContext(`_selectAllLibraryItems(_getLibState('liveProject'));`, sandbox);
        const allSel = JSON.parse(vm.runInContext(`JSON.stringify({
            items: [...document.getElementById('live-project-library-modal')._selectedItemIds],
            folders: [...document.getElementById('live-project-library-modal')._selectedFolderIds],
            allBtn: document.getElementById('live-project-library-modal')._selAllBtn.textContent,
            countText: document.getElementById('live-project-library-modal')._selCountEl.textContent,
        })`, sandbox));
        assert.equal(allSel.items.length, 3);
        assert.deepEqual(allSel.folders, [fEmpty.id]);
        assert.match(allSel.allBtn, /取消全选\(4\)/);
        assert.match(allSel.countText, /3 个工程 · 1 个文件夹/);

        vm.runInContext(`_selectAllLibraryItems(_getLibState('liveProject'));`, sandbox);
        assert.equal(lplModal._selectedItemIds.size, 0);
        assert.equal(lplModal._selectedFolderIds.size, 0);

        // 3. Test Multi-Select Mode + Shift Range + Invert Selection across folders & items
        vm.runInContext(`(() => {
            const m = document.getElementById('live-project-library-modal');
            const st = _getLibState('liveProject');
            _toggleMultiSelectMode(st);
            _applyCardSelectionAction(st, m, 'f:' + ${JSON.stringify(fEmpty.id)}, { fromCheckbox: false });
            _applyCardSelectionAction(st, m, 't:' + ${JSON.stringify(p2.id)}, { fromCheckbox: false });
        })()`, sandbox);
        assert.equal(lplModal._multiSelectMode, true);
        assert.equal(lplModal.classList.contains('vk-multi-select-on'), true);
        assert.equal(lplModal._selectedFolderIds.has(fEmpty.id), true);
        assert.equal(lplModal._selectedItemIds.has(p2.id), true);
        assert.equal(lplModal._selectedItemIds.size, 1, 'Multi-select mode must accumulate plain clicks without Ctrl');

        // Shift-range from p1 -> p3 selects all 3 projects
        vm.runInContext(`(() => {
            const m = document.getElementById('live-project-library-modal');
            const st = _getLibState('liveProject');
            _clearLibrarySelection(st);
            _applyCardSelectionAction(st, m, 't:' + ${JSON.stringify(p1.id)}, {});
            _applyCardSelectionAction(st, m, 't:' + ${JSON.stringify(p3.id)}, { shiftKey: true });
        })()`, sandbox);
        assert.equal(lplModal._selectedItemIds.size, 3);

        // Invert selection -> deselects all 3 projects and selects the 1 folder
        vm.runInContext(`_invertLibrarySelection(_getLibState('liveProject'));`, sandbox);
        assert.equal(lplModal._selectedItemIds.size, 0);
        assert.deepEqual([...lplModal._selectedFolderIds], [fEmpty.id]);

        // 4. Test Batch Delete of multiple selected items (while deleting nested folders safely leaf-first when empty)
        // Remove nested fSub so fEmpty is empty, select fEmpty + p1 + p2 -> batch delete deletes all 3 in one action
        tplService.deleteEmptyLiveProjectFolder(fSub.id);
        vm.runInContext(`(() => {
            const m = document.getElementById('live-project-library-modal');
            m._selectedItemIds = new Set([${JSON.stringify(p1.id)}, ${JSON.stringify(p2.id)}]);
            m._selectedFolderIds = new Set([${JSON.stringify(fEmpty.id)}]);
        })()`, sandbox);
        await vm.runInContext(`_batchDeleteLibrarySelection(_getLibState('liveProject'))`, sandbox);
        assert.deepEqual(tplService.listLiveProjects().map(x => x.id), [p3.id]);
        assert.equal(tplService.readLiveProjectFolders().folders.length, 0);
        assert.equal(tplService.getTemplate(sealedT.id).name, '封存参考模板', 'Sealed template must stay isolated');

        // 5. Open Template Library and verify it also includes the full multi-select & batch bar
        sandbox.window.openTemplateLibrary();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        const tplModal = elementsById.get('template-library-modal');
        assert.ok(tplModal);
        assert.match(tplModal.innerHTML, /data-role="selection-bar"/);
        assert.match(tplModal.innerHTML, /id="tpl-select-all-btn"/);
        assert.match(tplModal.innerHTML, /id="tpl-copy-selected-to-live-btn"/);
        assert.match(tplModal.innerHTML, /id="tpl-move-selected-btn"/);
        assert.match(tplModal.innerHTML, /id="tpl-delete-selected-btn"/);
    } finally {
        Module._load = origLoad;
        delete require.cache[templatesResolved];
        fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
});




































test('Opening multiple live projects deduplicates watermarks and keeps watermark & discrete style controls responsive', async () => {
    const store = new Map();
    const localStorageStub = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
    };

    const windowListeners = new Map();
    const docListeners = new Map();
    const savedBackPayloads = [];
    let focusCalls = 0;
    let selectCalls = 0;

    function createWatermarkNumEl(initialVal) {
        const listeners = new Map();
        return {
            value: String(initialVal),
            style: {},
            attributes: { min: '8', max: '80', step: '1' },
            getAttribute(k) { return this.attributes[k] ?? null; },
            addEventListener(type, fn) {
                if (!listeners.has(type)) listeners.set(type, []);
                listeners.get(type).push(fn);
            },
            dispatchEvent(ev) {
                if (this._onInputSync) this._onInputSync();
                for (const fn of listeners.get(ev.type) || []) fn(ev);
                return true;
            },
            focus() { focusCalls++; },
            select() { selectCalls++; },
        };
    }

    const wmListEl = {
        _innerHTML: '',
        _numEls: [],
        _rows: [],
        get innerHTML() { return this._innerHTML; },
        set innerHTML(val) {
            this._innerHTML = String(val);
            const matches = [...this._innerHTML.matchAll(/class="wm-row"/g)];
            this._numEls = [];
            this._rows = matches.map((_, idx) => {
                const fontEl = createWatermarkNumEl(25);
                this._numEls.push(fontEl);
                return {
                    querySelector(sel) {
                        if (sel === '.wm-enabled') return { checked: idx !== 2 };
                        if (sel === '.wm-type') return { value: idx === 2 ? 'image' : 'text' };
                        if (sel === '.wm-position') return { value: idx === 0 ? 'top-right' : (idx === 1 ? 'bottom-left' : 'center') };
                        if (sel === '.wm-x' || sel === '.wm-y') return { value: '0' };
                        if (sel === '.wm-text') return { value: idx === 0 ? 'AI Generated 58' : 'Attribution to11.ai' };
                        if (sel === '.wm-fontsize') return fontEl;
                        if (sel === '.wm-color') return { value: '#FFFFFF' };
                        if (sel === '.wm-bgcolor') return { value: '#000000' };
                        if (sel === '.wm-bgopacity') return { value: '50' };
                        if (sel === '.wm-textopacity') return { value: '80' };
                        if (sel === '.wm-imagepath') return { value: 'assets/colossyan.png' };
                        if (sel === '.wm-imagescale') return { value: '100' };
                        if (sel === '.wm-imageanchor') return { value: 'center' };
                        if (sel === '.wm-opacity') return { value: '100' };
                        if (sel === '.wm-fliph' || sel === '.wm-flipv') return { checked: false };
                        return null;
                    },
                };
            });
        },
        querySelectorAll(sel) {
            if (sel === 'input[type="number"]') return this._numEls;
            if (sel === '.wm-row') return this._rows;
            return [];
        },
    };

    const countEl = { textContent: '' };
    const presetSelectEl = { value: '', innerHTML: '', appendChild() {} };
    const boldCheckEl = {
        id: 'reels-bold-test',
        type: 'checkbox',
        checked: false,
        dataset: {},
        closest(sel) { return sel === '#inspector-tab-subtitle' ? this : null; },
    };
    const scopeBarEl = { style: {}, innerHTML: '' };
    const batchPanelEl = { classList: { contains: (c) => c === 'active' }, style: { display: '' } };

    const domMap = new Map([
        ['reels-watermark-list', wmListEl],
        ['reels-wm-count', countEl],
        ['reels-watermark-scope-bar', scopeBarEl],
        ['reels-watermark-preset-select', presetSelectEl],
        ['batch-reels-panel', batchPanelEl],
    ]);

    const sandbox = vm.createContext({
        console,
        Map,
        Set,
        Date,
        Math,
        JSON,
        Number,
        String,
        Array,
        Object,
        Promise,
        Error,
        Event: function Event(type, opts = {}) { this.type = type; this.bubbles = Boolean(opts?.bubbles); },
        window: null,
        API_BASE: 'http://127.0.0.1:18999/api',
        apiFetch: async (url, init = {}) => {
            if (url.endsWith('/live-projects/save')) {
                savedBackPayloads.push(JSON.parse(init.body));
                return { ok: true, json: async () => ({ success: true, id: 'lp_saved' }) };
            }
            return { ok: true, json: async () => ({ success: true, data: [] }) };
        },
        electronAPI: {
            resolveAssetUrl: (f) => `local-media:///C:/Users/User/AppData/Local/Programs/VideoKit/resources/assets/${f}`,
            toFileUrl: (p) => p,
            saveBatchWorkspace: () => true,
            readBatchWorkspace: () => '',
        },
        localStorage: localStorageStub,
        document: {
            activeElement: null,
            head: { appendChild() {} },
            body: { appendChild() {}, querySelectorAll: () => [] },
            createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, querySelectorAll: () => [], addEventListener() {} }),
            getElementById: (id) => domMap.get(id) || null,
            querySelector: () => null,
            querySelectorAll: (sel) => (sel === '#reels-watermark-list .wm-row' ? wmListEl._rows : []),
            addEventListener(type, fn, capture) {
                const key = `${type}:${Boolean(capture)}`;
                if (!docListeners.has(key)) docListeners.set(key, []);
                docListeners.get(key).push(fn);
            },
            removeEventListener(type, fn, capture) {
                const key = `${type}:${Boolean(capture)}`;
                const list = docListeners.get(key);
                if (list) docListeners.set(key, list.filter(x => x !== fn));
            },
        },
        setTimeout: () => 1,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        requestAnimationFrame: (cb) => { cb(); return 1; },
        cancelAnimationFrame: () => {},
        getComputedStyle: () => ({ display: 'none', height: '0px' }),
        getWritingVisualStyle: (s) => s,
        reelsRefreshWritingTitleEditor: () => {},
        reelsRefreshSpeechWritingImageUI: () => {},
        showToast: () => {},
        alert: () => {},
        confirm: () => true,
    });
    sandbox.window = sandbox;
    sandbox.window.addEventListener = (type, fn) => {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
    };
    sandbox.window.removeEventListener = (type, fn) => {
        const list = windowListeners.get(type);
        if (list) windowListeners.set(type, list.filter(x => x !== fn));
    };

    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-project.js'), 'utf8'), sandbox, { filename: 'src/reels-project.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8'), sandbox, { filename: 'src/reels-batch-table.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8'), sandbox, { filename: 'src/batch-reels.js' });

    vm.runInContext(`(() => {
        reelsUpdatePreview = () => { window._previewCalls = (window._previewCalls || 0) + 1; };
    })()`, sandbox);
    const previewCalls = () => vm.runInContext('window._previewCalls || 0', sandbox);

    // 1. Pre-existing duplicated localStorage watermarks (e.g. from v4.6.2) are auto-healed on load
    const w1 = { type: 'text', text: 'AI Generated 58', fontSize: 25, color: '#FFFFFF', textOpacity: 0.8, bgColor: '#000000', bgOpacity: 0.5, position: 'top-right', enabled: true };
    const w2 = { type: 'text', text: 'Attribution to11.ai', fontSize: 20, color: '#FFFFFF', textOpacity: 1.0, bgColor: '#000000', bgOpacity: 0.5, position: 'bottom-left', enabled: true };
    const w3Pkg = { type: 'image', imagePath: 'local-media:///C:/Users/User/AppData/Local/Programs/VideoKit/resources/assets/colossyan.png', imageScale: 100, imageAnchor: 'center', opacity: 1.0, position: 'center', enabled: false };
    const w3Dev = { type: 'image', imagePath: 'assets/colossyan.png', imageScale: 100, imageAnchor: 'center', opacity: 1.0, position: 'center', enabled: false };
    store.set('reels_watermarks', JSON.stringify([w1, w2, w3Pkg, { ...w1 }, { ...w2 }, { ...w3Dev }]));
    vm.runInContext(`_reelsLoadWatermarks();`, sandbox);
    assert.equal(vm.runInContext(`window._reelsState.watermarks.length`, sandbox), 3);
    assert.equal(JSON.parse(store.get('reels_watermarks')).length, 3);

    // 2. Opening 3 live projects via reelsApplyLibraryProjects does NOT triple watermarks (stays 3, NOT 9!)
    await sandbox.window.reelsApplyLibraryProjects([
        { tplData: { id: 'lp1', name: '工程1', projectData: { tasks: [{ id: 't1', baseName: 'a' }], style: {}, exportOpts: {}, watermarks: [w1, w2, w3Pkg] } }, summary: { id: 'lp1', name: '工程1' } },
        { tplData: { id: 'lp2', name: '工程2', projectData: { tasks: [{ id: 't2', baseName: 'b' }], style: {}, exportOpts: {}, watermarks: [w1, w2, w3Dev] } }, summary: { id: 'lp2', name: '工程2' } },
        { tplData: { id: 'lp3', name: '工程3', projectData: { tasks: [{ id: 't3', baseName: 'c' }], style: {}, exportOpts: {}, watermarks: [w1, w2, w3Pkg] } }, summary: { id: 'lp3', name: '工程3' } },
    ], { folderId: 'f1', folderPath: '主工程区', confirmSwitch: false });
    assert.equal(vm.runInContext(`window._reelsState.watermarks.length`, sandbox), 3);
    assert.equal(countEl.textContent, '3 个');
    assert.equal(wmListEl._rows.length, 3);

    // 3. Watermark controls remain responsive:
    // 3a. Single click focuses & selects numeric input; dragging updates value & syncs to state + preview
    const numEvents = new Map();
    const origQueryAll = wmListEl.querySelectorAll.bind(wmListEl);
    wmListEl.querySelectorAll = (sel) => {
        const res = origQueryAll(sel);
        if (sel === 'input[type="number"]') {
            for (const el of res) {
                el._onInputSync = () => sandbox.window._reelsSyncWatermarkFromUI?.();
                el.addEventListener = (t, fn) => {
                    if (!numEvents.has(el)) numEvents.set(el, new Map());
                    const m = numEvents.get(el);
                    if (!m.has(t)) m.set(t, []);
                    m.get(t).push(fn);
                };
            }
        }
        return res;
    };
    vm.runInContext(`_reelsRefreshWatermarkUI(); window._reelsSyncWatermarkFromUI = _reelsSyncWatermarkFromUI;`, sandbox);
    const activeNumEl = wmListEl._numEls[0];
    const mdownFn = numEvents.get(activeNumEl).get('mousedown')[0];

    mdownFn({ stopPropagation() {}, preventDefault() {}, clientX: 100 });
    for (const fn of [...(docListeners.get('mouseup:false') || [])]) fn({});
    assert.equal(focusCalls, 1, 'single click on numeric watermark field must focus for direct typing');
    assert.equal(selectCalls, 1, 'single click on numeric watermark field must select for direct typing');

    const beforeDragPreview = previewCalls();
    mdownFn({ stopPropagation() {}, preventDefault() {}, clientX: 100 });
    for (const fn of [...(docListeners.get('mousemove:false') || [])]) fn({ clientX: 112, shiftKey: false });
    for (const fn of [...(docListeners.get('mouseup:false') || [])]) fn({});
    assert.equal(Number(activeNumEl.value), 37);
    assert.equal(vm.runInContext(`window._reelsState.watermarks[0].fontSize`, sandbox), 37);
    assert.ok(previewCalls() > beforeDragPreview);

    // 3b. Add & Remove watermark update preview AND mark live tabs dirty immediately
    const beforeAddPreview = previewCalls();
    vm.runInContext(`_batchTableState.tabs.forEach(t => { t._libraryDirty = false; }); reelsAddWatermark();`, sandbox);
    assert.equal(vm.runInContext(`window._reelsState.watermarks.length`, sandbox), 4);
    assert.ok(previewCalls() > beforeAddPreview, 'reelsAddWatermark must trigger preview refresh');
    assert.equal(vm.runInContext(`_batchTableState.tabs.some(t => t._libraryDirty)`, sandbox), true);

    const afterAddPreview = previewCalls();
    vm.runInContext(`_batchTableState.tabs.forEach(t => { t._libraryDirty = false; }); reelsRemoveWatermark(3);`, sandbox);
    assert.equal(vm.runInContext(`window._reelsState.watermarks.length`, sandbox), 3);
    assert.ok(previewCalls() > afterAddPreview, 'reelsRemoveWatermark must trigger preview refresh');
    assert.equal(vm.runInContext(`_batchTableState.tabs.some(t => t._libraryDirty)`, sandbox), true);

    // Syncing live projects back persists deduplicated watermarks
    const saveRes = await sandbox.window.reelsSyncWorkspaceTabsBackToLibraryFolder({ silent: true, onlyDirty: true });
    assert.ok(saveRes.updated >= 1);
    assert.equal(savedBackPayloads[0].projectData.watermarks.length, 3);

    // 4. Discrete control (checkbox) in subtitle inspector marks live tab dirty immediately,
    //    and _reelsHistoryRangeGesture clears even if pointerup happens outside editor or on blur
    vm.runInContext(`_batchTableState.tabs.forEach(t => { t._libraryDirty = false; });`, sandbox);
    for (const fn of (docListeners.get('input:false') || [])) {
        fn({ type: 'input', target: boldCheckEl });
    }
    assert.equal(vm.runInContext(`_batchTableState.tabs.some(t => t._libraryDirty)`, sandbox), true);

    for (const fn of (docListeners.get('pointerdown:true') || [])) {
        fn({ type: 'pointerdown', target: { type: 'range', closest: () => batchPanelEl } });
    }
    assert.equal(vm.runInContext(`_reelsHistoryRangeGesture`, sandbox), true);
    for (const fn of (docListeners.get('pointerup:false') || [])) {
        fn({ type: 'pointerup', target: { closest: () => null } });
    }
    assert.equal(vm.runInContext(`_reelsHistoryRangeGesture`, sandbox), false);

    // 5. Cloud/network project import NEVER appends onto local watermarks; tabs with dedicated
    //    watermarks use their own, while tabs without dedicated watermarks fall back to local default
    const cloudWm = { type: 'text', text: '@CloudExclusive', fontSize: 22, position: 'bottom-right', enabled: true };
    await vm.runInContext(`_applyDownloadedCloudProjectToBatchTable(${JSON.stringify({
        version: '2.0',
        watermarks: [cloudWm],
        tabs: [{ name: '云端专属工程', tasks: [{ id: 'tc1', baseName: 'c1' }] }],
    })}, '', 'append', '云端专属工程')`, sandbox);
    // Active state switches ONLY to the cloud tab's watermark (length 1, NOT 3+1=4!)
    assert.deepEqual(
        JSON.parse(vm.runInContext(`JSON.stringify(window._reelsState.watermarks.map(w => w.text))`, sandbox)),
        ['@CloudExclusive']
    );
    // LocalStorage default remains intact for local tabs!
    assert.equal(JSON.parse(store.get('reels_watermarks')).length, 3);
    assert.match(scopeBarEl.innerHTML, /专属水印/);

    // Importing a second cloud project WITHOUT watermarks uses local default for that new tab
    await vm.runInContext(`_applyDownloadedCloudProjectToBatchTable(${JSON.stringify({
        version: '2.0',
        tabs: [{ name: '无水印云端工程', tasks: [{ id: 'tc2', baseName: 'c2' }] }],
    })}, '', 'append', '无水印云端工程')`, sandbox);
    assert.equal(
        vm.runInContext(`window._resolveReelsWatermarksForTask(_batchTableState.tabs.find(t => t.name === '云端专属工程').tasks[0]).map(w => w.text).join(',')`, sandbox),
        '@CloudExclusive'
    );
    assert.equal(
        vm.runInContext(`window._resolveReelsWatermarksForTask(_batchTableState.tabs.find(t => t.name === '无水印云端工程').tasks[0]).length`, sandbox),
        3
    );

    // Switching back to the first local tab shows local default again & updates scope bar
    vm.runInContext(`_switchToTab(_batchTableState.tabs[0].id);`, sandbox);
    assert.equal(vm.runInContext(`window._reelsState.watermarks.length`, sandbox), 3);
    assert.match(scopeBarEl.innerHTML, /本机默认水印/);

    // Switching back to cloud tab -> fork/reset/promote helpers work cleanly
    vm.runInContext(`_switchToTab(_batchTableState.tabs.find(t => t.name === '云端专属工程').id);`, sandbox);
    assert.deepEqual(
        JSON.parse(vm.runInContext(`JSON.stringify(window._reelsState.watermarks.map(w => w.text))`, sandbox)),
        ['@CloudExclusive']
    );
    vm.runInContext(`reelsResetTabWatermarkToDefault();`, sandbox);
    assert.equal(vm.runInContext(`window._reelsState.watermarks.length`, sandbox), 3);
    assert.match(scopeBarEl.innerHTML, /本机默认水印/);

    // Syncing replace mode keeps only the latest watermarks
    vm.runInContext(`reelsForkTabWatermarkFromDefault(); window._reelsState.watermarks = [${JSON.stringify(cloudWm)}]; reelsPromoteTabWatermarkToDefault();`, sandbox);
    assert.deepEqual(JSON.parse(store.get('reels_watermarks')).map(w => w.text), ['@CloudExclusive']);
});

test('ElevenLabs TTS extracts the first sentence of the script and preserves sequence numbering for sorting', () => {
    const elevenlabsService = require('../electron/services/elevenlabs');

    // 1. Extracts first sentence cleanly (strips [tags], <break>, numbering, and stops at first sentence end)
    assert.equal(
        elevenlabsService.extractFirstSentenceForFilename('[whispers] 1. Stop scrolling right now! Look at what God did today.'),
        'Stop scrolling right now'
    );
    assert.equal(
        elevenlabsService.extractFirstSentenceForFilename('[excited] "不要害怕，因为我与你同在。"这是第二句话，不应该进文件名。'),
        '不要害怕，因为我与你同在'
    );
    assert.equal(
        elevenlabsService.extractFirstSentenceForFilename('First line of prayer\nSecond line of prayer'),
        'First line of prayer'
    );

    // 2. buildTTSSavePath uses seqPrefix + extracted first sentence so generated files sort in exact order
    const path1 = path.basename(elevenlabsService.buildTTSSavePath('[sighs] God is with you today. Do not worry.', 'mp3_44100_128', 'batch', '001'));
    const path2 = path.basename(elevenlabsService.buildTTSSavePath('[warm] A blessing is coming your way! Believe it.', 'mp3_44100_128', 'batch', '002'));
    const path3 = path.basename(elevenlabsService.buildTTSSavePath('10. Zeta is the last letter. Alpha is first.', 'mp3_44100_128', 'batch', '003'));

    assert.equal(path1, '001-God is with you today-batch.mp3');
    assert.equal(path2, '002-A blessing is coming your way-batch.mp3');
    assert.equal(path3, '003-Zeta is the last letter-batch.mp3');

    const sorted = [path3, path1, path2].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    assert.deepEqual(sorted, [path1, path2, path3]);
});

test('Auto-color rich-text subtitle wrapping never overlaps Line 2 onto Line 1 when ctx.textBaseline was top', () => {
    const ReelsRichText = require('../src/reels-rich-text');
    const { ReelsCanvasRenderer } = require('../src/reels-canvas-renderer');
    global.ReelsRichText = ReelsRichText;

    const fillCalls = [];
    const mockCtx = {
        direction: 'ltr',
        textAlign: 'left',
        textBaseline: 'top', // Simulate normal renderSubtitle leaving textBaseline = 'top'
        font: '700 74px Arial',
        fillStyle: '#FFFFFF',
        strokeStyle: '#000000',
        globalAlpha: 1,
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        beginPath() {},
        closePath() {},
        fill() {},
        stroke() {},
        fillRect() {},
        strokeText() {},
        fillText(text, x, y) {
            fillCalls.push({ text, x, y, fillStyle: this.fillStyle, textBaseline: this.textBaseline });
        },
        measureText(str) {
            const s = String(str || '');
            const w = s.length * 36;
            // In HTML5 Canvas, when textBaseline === 'top', actualBoundingBoxAscent is negative (~ -5px)
            // and when textBaseline === 'alphabetic', actualBoundingBoxAscent is positive (~ +58px)
            if (this.textBaseline === 'top') {
                return { width: w, actualBoundingBoxAscent: -5, actualBoundingBoxDescent: 62 };
            }
            return { width: w, actualBoundingBoxAscent: 58, actualBoundingBoxDescent: 16 };
        },
    };

    const mockCanvas = {
        width: 1080,
        height: 1920,
        getContext: () => mockCtx,
    };

    const renderer = new ReelsCanvasRenderer(mockCanvas);
    const style = {
        font_family: 'Arial',
        fontsize: 74,
        color_text: '#FFFFFF',
        use_stroke: true,
        border_width: 3,
        wrap_width_percent: 80, // ~864px maxWidth -> "menciona qué día nació" (~792px) fits on line 1, "Jesús." wraps to line 2
        auto_wrap: true,
        auto_color_rules: [
            { type: 'custom', keywords: ['Jesús'], color: '#FFD700', bold: true },
        ],
    };
    const segment = {
        start: 0,
        end: 3,
        text: 'menciona qué día nació Jesús.',
    };

    renderer.renderSubtitle(style, segment, 1.0, 1080, 1920);

    const line1Call = fillCalls.find(c => c.text === 'menciona');
    const jesusCall = fillCalls.find(c => c.text === 'Jesús');
    const dotCall = fillCalls.find(c => c.text === '.');

    assert.ok(line1Call, 'Line 1 word "menciona" should be rendered');
    assert.ok(jesusCall, 'Auto-colored keyword "Jesús" should be rendered');
    assert.ok(dotCall, 'Trailing period "." should be rendered');
    assert.equal(jesusCall.fillStyle, '#FFD700');
    assert.equal(jesusCall.y, dotCall.y, '"Jesús" and "." must share the same Line 2 baseline');
    assert.ok(
        jesusCall.y - line1Call.y >= 74 * 1.15,
        `Line 2 ("Jesús.") baseline Y (${jesusCall.y}) must be separated from Line 1 ("menciona") baseline Y (${line1Call.y}) by at least one full line height (>= ${74 * 1.15}px)`
    );
});

test('Festival Countdown Ring Intro (cp-01 style): presets, canvas render, font collection, timeline offset, FFmpeg voice delay, and DecorPanel queue sync', async () => {
    // 1. Load ReelsOverlay & test presets, date calculation, delay resolution, and Canvas drawOverlay
    const ovSandbox = loadBrowserScript('src/reels-overlay.js');
    const RO = ovSandbox.window.ReelsOverlay;
    assert.ok(RO, 'ReelsOverlay must be exposed');
    assert.equal(Object.keys(RO.INTRO_RING_THEMES).length, 5, '5 intro ring color themes should exist');
    assert.equal(Object.keys(RO.INTRO_CURTAIN_THEMES).length, 4, '4 intro curtain velvet themes should exist');
    assert.equal(Object.keys(RO.INTRO_COUNTDOWN_PRESETS).length, 8, '8 intro countdown/opening presets should exist');

    // Date calculation matches cp-01 sample: Nov 18 -> Dec 25 = 37 days; supports dots, slashes & Chinese month/day formats
    assert.equal(RO.computeIntroDaysRemaining('12-25', 0, new Date(2026, 10, 18)), 37);
    assert.equal(RO.computeIntroDaysRemaining('12.25', -1, new Date(2026, 10, 19)), 35);
    assert.equal(RO.computeIntroDaysRemaining('12月24日', 0, new Date(2026, 10, 19)), 35);
    assert.equal(RO.computeIntroDaysRemaining('2026年12月25日', -1, new Date(2026, 10, 19)), 35);
    assert.equal(RO.computeIntroDaysRemaining('2026-12-25', -2, new Date(2026, 10, 18)), 35);

    const xmasOv = RO.createIntroCountdownOverlay({ intro_style: 'xmas_cp01', _previewPlaying: true });
    assert.equal(xmasOv.type, 'intro_countdown');
    assert.equal(xmasOv.is_intro_countdown, true);
    assert.equal(xmasOv.intro_delay_body, true);
    assert.equal(xmasOv.end, 3.0);
    assert.equal(RO.getIntroDelaySec([xmasOv]), 3.0);

    // Zero-delay overlay mode & disabled state return 0 delay
    assert.equal(RO.getIntroDelaySec([{ ...xmasOv, intro_delay_body: false }]), 0);
    assert.equal(RO.getIntroDelaySec([{ ...xmasOv, disabled: true }]), 0);
    assert.equal(RO.getIntroDelaySec([xmasOv], { showDecor: false, showOverlay: false }), 0);

    for (const presetId of Object.keys(RO.INTRO_COUNTDOWN_PRESETS)) {
        const presetOv = RO.createIntroCountdownOverlay({ intro_style: presetId, _previewPlaying: true });
        let saves = 0;
        let restores = 0;
        const drawnTexts = [];
        const arcCalls = [];
        const rectCalls = [];
        const mockGrad = { addColorStop() {} };
        const mockCtx = {
            globalAlpha: 1,
            font: '',
            fillStyle: '#fff',
            strokeStyle: '#000',
            lineWidth: 1,
            lineCap: 'butt',
            lineJoin: 'miter',
            textAlign: 'center',
            textBaseline: 'middle',
            shadowColor: 'transparent',
            shadowBlur: 0,
            shadowOffsetX: 0,
            shadowOffsetY: 0,
            save() { saves++; },
            restore() { restores++; },
            beginPath() {},
            closePath() {},
            moveTo() {},
            lineTo() {},
            quadraticCurveTo() {},
            bezierCurveTo() {},
            arc(cx, cy, r, a0, a1) { arcCalls.push({ cx, cy, r, a0, a1 }); },
            rect() {},
            roundRect() {},
            clip() {},
            fill() {},
            stroke() {},
            fillRect(rx, ry, rw, rh) { rectCalls.push({ x: rx, y: ry, w: rw, h: rh }); },
            strokeRect() {},
            fillText(txt) { drawnTexts.push(String(txt)); },
            strokeText() {},
            translate() {},
            rotate() {},
            scale() {},
            setLineDash() {},
            createLinearGradient() { return mockGrad; },
            createRadialGradient() { return mockGrad; },
            measureText: (txt) => ({ width: String(txt || '').length * 14 }),
        };

        // Paused at 0s snapshot should still render preview visuals
        const pausedOv = { ...presetOv, _previewPlaying: false };
        RO.drawOverlay(mockCtx, pausedOv, 0.0, 1080, 1920);
        assert.equal(saves, restores, `drawOverlay at t=0 paused for ${presetId} must balance save/restore`);
        if (presetOv.intro_layout === 'kinetic_stack') {
            assert.ok(drawnTexts.length >= 2, `Paused snapshot for ${presetId} must draw kinetic stacked intro words`);
        } else if (presetOv.intro_layout === 'curtain_reveal') {
            assert.ok(rectCalls.length >= 2, `Paused snapshot for ${presetId} must draw left & right velvet curtain panels`);
        } else {
            assert.ok(arcCalls.length >= 2, `Paused snapshot for ${presetId} must draw base ring and sweep arc`);
        }

        // Mid-animation frame
        drawnTexts.length = 0;
        RO.drawOverlay(mockCtx, presetOv, 1.4, 1080, 1920);
        assert.equal(saves, restores, `drawOverlay at t=1.4 for ${presetId} must balance save/restore`);
        if (presetId === 'ready_321') {
            assert.ok(drawnTexts.includes('2'), 'countdown_sec at t=1.4s of 3.0s should display "2"');
        } else if (presetId === 'xmas_cp01') {
            assert.ok(drawnTexts.includes('37'), 'xmas_cp01 fixed center should render "37"');
            assert.ok(drawnTexts.includes('Christmas'), 'xmas_cp01 bottom script should render "Christmas"');
        } else if (presetId === 'fb_yellow_stack_hook') {
            assert.ok(drawnTexts.length >= 1, 'fb_yellow_stack_hook should draw opening stack words at t=1.4s');
        } else if (presetId === 'curtain_red_reveal') {
            assert.ok(rectCalls.length >= 4, 'curtain_red_reveal should draw opening velvet panels at t=1.4s');
        }

        // Past end duration renders nothing
        const beforePast = presetOv.intro_layout === 'kinetic_stack'
            ? drawnTexts.length
            : (presetOv.intro_layout === 'curtain_reveal' ? rectCalls.length : arcCalls.length);
        RO.drawOverlay(mockCtx, presetOv, presetOv.end + 0.5, 1080, 1920);
        const afterPast = presetOv.intro_layout === 'kinetic_stack'
            ? drawnTexts.length
            : (presetOv.intro_layout === 'curtain_reveal' ? rectCalls.length : arcCalls.length);
        assert.equal(afterPast, beforePast, `Intro ${presetId} should not render after its end duration`);
    }

    // 2. ReelsFontManager.collectFonts picks up intro_top / intro_center / intro_bottom font families
    const fmSandbox = loadBrowserScript('src/reels-font-manager.js');
    const collected = fmSandbox.window.getFontManager().collectFonts({
        overlays: [RO.createIntroCountdownOverlay({ intro_style: 'morning_prayer_gold' })],
    });
    assert.ok(collected.includes('Montserrat'), 'collectFonts must include intro_top_font_family');
    assert.ok(collected.includes('Anton'), 'collectFonts must include intro_center_font_family');
    assert.ok(collected.includes('Great Vibes'), 'collectFonts must include intro_bottom_font_family (Great Vibes)');

    // 3. ReelsRenderPlan.getEditorTracks shifts voice/subs/body overlays by +introDelay only when intro_delay_body=true
    const tlSandbox = loadBrowserScript('src/reels-timeline.js', { window: { ReelsOverlay: RO } });
    const rpSandbox = loadBrowserScript('src/reels-render-plan.js', {
        window: tlSandbox.window,
    });
    const RRP = rpSandbox.window.ReelsRenderPlan;
    const sampleTaskDelayed = {
        bgPath: 'bg.mp4',
        audioPath: 'voice.mp3',
        audioDur: 8.0,
        segments: [{ start: 0, end: 8, text: 'Prayer begins after intro.' }],
        overlays: [
            RO.createIntroCountdownOverlay({ intro_style: 'xmas_cp01', end: 3.0, intro_delay_body: true }),
            { id: 'ov_decor', type: 'decor', start: 0, end: 9999 },
            { id: 'ov_scroll', type: 'scroll', content: 'Scroll body', start: 0, end: 9999 },
        ],
    };
    const delayedPlan = RRP.getEditorTracks(sampleTaskDelayed, { duration: 11.0 });
    assert.ok(Array.isArray(delayedPlan), 'getEditorTracks returns track array');
    assert.equal(RRP.getIntroDelaySecForTask(sampleTaskDelayed), 3.0);
    const introTrack = delayedPlan.find(tr => tr._overlayType === 'intro_countdown');
    const subsTrack = delayedPlan.find(tr => tr.type === 'subs');
    const voiceTrack = delayedPlan.find(tr => tr.role === 'voice' || tr.clips?.some(c => c._timelineRole === 'voice'));
    const scrollTrack = delayedPlan.find(tr => tr._overlayType === 'scroll');
    const decorTrack = delayedPlan.find(tr => tr._overlayType === 'decor');
    assert.ok(introTrack && introTrack.clips[0].start === 0 && introTrack.clips[0].end === 3.0);
    assert.ok(subsTrack && subsTrack.clips[0].start === 3.0 && subsTrack.clips[0].end === 11.0);
    assert.ok(voiceTrack && voiceTrack.clips[0].start === 3.0, 'Voice track must shift right by +introDelay (3.0s)');
    assert.ok(scrollTrack && scrollTrack.clips[0].start === 3.0 && scrollTrack.clips[0].end === 11.0);
    assert.ok(decorTrack && decorTrack.clips[0].start === 0 && decorTrack.clips[0].end === 11.0);

    // With intro_delay_body = false, body tracks stay at t = 0
    const zeroDelayTask = {
        ...sampleTaskDelayed,
        overlays: [
            RO.createIntroCountdownOverlay({ intro_style: 'xmas_cp01', end: 3.0, intro_delay_body: false }),
            { id: 'ov_scroll', type: 'scroll', content: 'Scroll body', start: 0, end: 9999 },
        ],
    };
    const zeroDelayPlan = RRP.getEditorTracks(zeroDelayTask, { duration: 8.0 });
    assert.equal(RRP.getIntroDelaySecForTask(zeroDelayTask), 0);
    assert.equal(zeroDelayPlan.find(tr => tr.type === 'subs').clips[0].start, 0);
    assert.equal(zeroDelayPlan.find(tr => tr.role === 'voice').clips[0].start, 0);
    assert.equal(zeroDelayPlan.find(tr => tr._overlayType === 'scroll').clips[0].start, 0);

    // 4. Verify FFmpeg rawvideo voiceDelay adelay filter & WYSIWYG/Preview integration hooks
    const ffmpegRawSrc = fs.readFileSync(path.join(ROOT, 'electron/services/ffmpeg-rawvideo.js'), 'utf8');
    const wysiwygSrc = fs.readFileSync(path.join(ROOT, 'src/reels-wysiwyg-export.js'), 'utf8');
    const batchSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    const previewV2Src = fs.readFileSync(path.join(ROOT, 'src/reels-preview-v2.js'), 'utf8');
    assert.match(ffmpegRawSrc, /voiceDelayMs\s*=.*session\.voiceDelay/);
    assert.match(ffmpegRawSrc, /adelay=\$\{voiceDelayMs\}\|\$\{voiceDelayMs\}/);
    assert.match(wysiwygSrc, /introDelaySec\s*=/);
    assert.match(wysiwygSrc, /bodyTime\s*=\s*introDelaySec\s*>\s*0\s*\?\s*\(t\s*-\s*introDelaySec\)\s*:\s*t/);
    assert.match(wysiwygSrc, /voiceDelay:\s*introDelaySec/);
    assert.match(batchSrc, /function _getTaskIntroDelaySec\(/);
    assert.match(batchSrc, /voiceDelay:\s*introDelaySec/);
    assert.match(previewV2Src, /function getIntroDelayDuration\(/);
    assert.match(previewV2Src, /inIntroLead/);

    // 5. ReelsDecorPanel & ReelsOverlayPanel UI controls, list exclusion & queue sync
    const makeDomEl = (id, init = {}) => {
        const listeners = {};
        const classes = new Set();
        return {
            id,
            type: init.type || '',
            tagName: init.tagName || 'INPUT',
            checked: Boolean(init.checked),
            value: init.value !== undefined ? String(init.value) : '',
            open: Boolean(init.open),
            dataset: init.dataset || {},
            style: {},
            textContent: '',
            innerHTML: '',
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                toggle: (c, f) => (f === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (f ? classes.add(c) : classes.delete(c))),
                contains: (c) => classes.has(c),
            },
            addEventListener(evt, fn) { (listeners[evt] ||= []).push(fn); },
            dispatch(evt) { (listeners[evt] || []).forEach(fn => fn({ type: evt, target: this, preventDefault() {}, stopPropagation() {} })); },
            querySelector: () => null,
            querySelectorAll: () => [],
        };
    };
    const controls = new Map();
    const regEl = (sel, el) => { controls.set(sel, el); return el; };
    regEl('#rdp-master-enable', makeDomEl('rdp-master-enable', { type: 'checkbox', checked: true }));
    regEl('#rdp-style-scope', makeDomEl('rdp-style-scope', { tagName: 'SELECT', value: 'folder' }));
    regEl('#rdp-apply-all', makeDomEl('rdp-apply-all', { type: 'checkbox', checked: true }));
    regEl('#rdp-acc-intro', makeDomEl('rdp-acc-intro', { tagName: 'DETAILS', open: false }));
    regEl('#rdp-intro-enable', makeDomEl('rdp-intro-enable', { type: 'checkbox', checked: false }));
    regEl('#rdp-intro-status-badge', makeDomEl('rdp-intro-status-badge', { tagName: 'SPAN' }));
    regEl('#rdp-acc-intro-badge', makeDomEl('rdp-acc-intro-badge', { tagName: 'SPAN' }));
    regEl('#rdp-intro-preview-btn', makeDomEl('rdp-intro-preview-btn', { tagName: 'BUTTON' }));
    regEl('#rdp-intro-delete-btn', makeDomEl('rdp-intro-delete-btn', { tagName: 'BUTTON' }));
    regEl('#rdp-intro-duration', makeDomEl('rdp-intro-duration', { type: 'range', value: '3.0' }));
    regEl('#rdp-intro-duration-num', makeDomEl('rdp-intro-duration-num', { type: 'number', value: '3.0', dataset: { introLink: 'rdp-intro-duration' } }));
    regEl('#rdp-intro-delay-body', makeDomEl('rdp-intro-delay-body', { type: 'checkbox', checked: true }));
    regEl('#rdp-intro-top-text', makeDomEl('rdp-intro-top-text', { type: 'text', value: 'DAYS BEFORE' }));
    regEl('#rdp-intro-top-color', makeDomEl('rdp-intro-top-color', { type: 'color', value: '#FFFFFF' }));
    regEl('#rdp-intro-center-mode', makeDomEl('rdp-intro-center-mode', { tagName: 'SELECT', value: 'fixed' }));
    regEl('#rdp-intro-center-text', makeDomEl('rdp-intro-center-text', { type: 'text', value: '37' }));
    regEl('#rdp-intro-center-color', makeDomEl('rdp-intro-center-color', { type: 'color', value: '#FACC15' }));
    regEl('#rdp-intro-target-date', makeDomEl('rdp-intro-target-date', { type: 'text', value: '12-25' }));
    regEl('#rdp-intro-day-offset', makeDomEl('rdp-intro-day-offset', { type: 'number', value: '0' }));
    regEl('#rdp-intro-fixed-wrap', makeDomEl('rdp-intro-fixed-wrap', { tagName: 'DIV' }));
    regEl('#rdp-intro-date-wrap', makeDomEl('rdp-intro-date-wrap', { tagName: 'DIV' }));
    regEl('#rdp-intro-days-preview', makeDomEl('rdp-intro-days-preview', { tagName: 'SPAN' }));
    regEl('#rdp-intro-bottom-text', makeDomEl('rdp-intro-bottom-text', { type: 'text', value: 'Christmas' }));
    regEl('#rdp-intro-bottom-color', makeDomEl('rdp-intro-bottom-color', { type: 'color', value: '#FFFFFF' }));
    regEl('#rdp-intro-underline-enabled', makeDomEl('rdp-intro-underline-enabled', { type: 'checkbox', checked: true }));
    regEl('#rdp-intro-underline-color', makeDomEl('rdp-intro-underline-color', { type: 'color', value: '#FACC15' }));
    regEl('#rdp-intro-ring-theme', makeDomEl('rdp-intro-ring-theme', { tagName: 'SELECT', value: 'xmas_rainbow' }));
    regEl('#rdp-intro-top-font', makeDomEl('rdp-intro-top-font', { tagName: 'SELECT', value: 'Montserrat' }));
    regEl('#rdp-intro-center-font', makeDomEl('rdp-intro-center-font', { tagName: 'SELECT', value: 'Anton' }));
    regEl('#rdp-intro-bottom-font', makeDomEl('rdp-intro-bottom-font', { tagName: 'SELECT', value: 'Pacifico' }));
    regEl('#rdp-intro-ring-radius', makeDomEl('rdp-intro-ring-radius', { type: 'range', value: '268' }));
    regEl('#rdp-intro-ring-thickness', makeDomEl('rdp-intro-ring-thickness', { type: 'range', value: '12' }));
    regEl('#rdp-intro-spark-enabled', makeDomEl('rdp-intro-spark-enabled', { type: 'checkbox', checked: true }));
    regEl('#rdp-intro-snow-enabled', makeDomEl('rdp-intro-snow-enabled', { type: 'checkbox', checked: true }));
    regEl('#rdp-intro-snow-density', makeDomEl('rdp-intro-snow-density', { type: 'range', value: '32' }));
    regEl('#rdp-intro-scrim', makeDomEl('rdp-intro-scrim', { type: 'range', value: '16' }));
    regEl('#rdp-intro-scale', makeDomEl('rdp-intro-scale', { type: 'range', value: '100' }));
    regEl('#rdp-intro-offset-y', makeDomEl('rdp-intro-offset-y', { type: 'range', value: '-20' }));
    regEl('#rdp-intro-offset-x', makeDomEl('rdp-intro-offset-x', { type: 'range', value: '0' }));
    regEl('#rdp-layer-list', makeDomEl('rdp-layer-list', { tagName: 'DIV' }));

    const listEl = makeDomEl('rop-overlay-list', { tagName: 'DIV' });
    const tA = { id: 'ta', _batchTabId: 'tab_intro', _folderQueueId: 'q_intro', overlays: [{ id: 'txt_a', type: 'text', content: 'Body Copy' }] };
    const tB = { id: 'tb', _batchTabId: 'tab_intro', _folderQueueId: 'q_intro', overlays: [{ id: 'txt_b', type: 'text', content: 'Task B Copy' }] };
    const mgr = {
        overlays: tA.overlays,
        add(o) { this.overlays.push(o); },
        remove(id) { this.overlays = this.overlays.filter(o => o.id !== id); },
    };
    const proxyCanvas = {
        overlayMgr: mgr,
        getOrderedOverlays: () => mgr.overlays,
        addOverlay(o) { mgr.overlays.push(o); tA.overlays = mgr.overlays; },
        removeOverlay(id) { mgr.overlays = mgr.overlays.filter(o => o.id !== id); tA.overlays = mgr.overlays; },
        getOverlayAboveSubtitle: () => true,
        render() {},
        onOverlayChange() {},
    };
    let timelineSyncCalls = 0;
    const panelContainer = {
        _innerHTML: '',
        set innerHTML(v) { this._innerHTML = String(v); },
        get innerHTML() { return this._innerHTML; },
        querySelector: (sel) => controls.get(sel) || null,
        querySelectorAll: (sel) => (sel === '.rop-num-readout[data-intro-link]' ? [controls.get('#rdp-intro-duration-num')] : []),
    };
    const uiSandbox = {
        console, Math, JSON, Date, Number, String, Boolean, Array, Object, Set, Map,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        setTimeout, clearTimeout,
        requestAnimationFrame: (cb) => 1,
        cancelAnimationFrame() {},
        window: {},
        document: {
            head: { appendChild() {}, querySelector: () => null },
            body: { appendChild() {} },
            getElementById: (id) => (id === 'rop-overlay-list' ? listEl : (controls.get('#' + id) || null)),
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => makeDomEl('tmp'),
        },
        _updateTimelineForTask() { timelineSyncCalls++; },
        _applyPreviewLoopMode() {},
    };
    uiSandbox.window = uiSandbox;
    uiSandbox.window.ReelsOverlay = RO;
    uiSandbox.window._reelsState = { selectedIdx: 0, tasks: [tA, tB] };
    uiSandbox.window._updateTimelineForTask = uiSandbox._updateTimelineForTask;
    uiSandbox.window._applyPreviewLoopMode = uiSandbox._applyPreviewLoopMode;

    vm.createContext(uiSandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8'), uiSandbox);

    const dp = new uiSandbox.window.ReelsDecorPanel(panelContainer, proxyCanvas, {
        container: { querySelector: (sel) => (sel === '#rop-overlay-list' ? listEl : null) },
        _refreshList() {
            const raw = proxyCanvas.getOrderedOverlays();
            const filtered = raw.filter(o => o && o.type !== 'decor' && !o.is_phone_cta && !o.is_intro_countdown && o.type !== 'intro_countdown');
            listEl.innerHTML = filtered.map(o => o.id).join(',');
        },
    });

    // Apply Christmas cp-01 preset -> creates intro_countdown, syncs to Task B, excludes from #rop-overlay-list
    const created = dp.applyIntroPreset('xmas_cp01');
    assert.ok(created && created.is_intro_countdown, 'applyIntroPreset must create an intro_countdown overlay');
    assert.equal(controls.get('#rdp-intro-enable').checked, true);
    assert.equal(controls.get('#rdp-acc-intro').open, true);
    assert.ok(timelineSyncCalls >= 1, 'Applying intro preset should trigger timeline recompute');
    dp.linkedOverlayPanel._refreshList();
    assert.equal(listEl.innerHTML, 'txt_a', '#rop-overlay-list must exclude intro_countdown overlays');

    // Sync to Task B in same queue
    const tbIntro = tB.overlays.find(o => o && o.is_intro_countdown);
    assert.ok(tbIntro, 'Scope sync must propagate intro_countdown to Task B');
    assert.notEqual(tbIntro.id, created.id, 'Task B intro copy must get a distinct ID');
    assert.equal(tbIntro.intro_top_text, 'DAYS BEFORE');
    assert.equal(tbIntro.end, 3.0);

    // Adjust duration to 4.2s and disable delay body -> syncs immediately to overlay & Task B
    controls.get('#rdp-intro-duration').value = '4.2';
    controls.get('#rdp-intro-duration').dispatch('input');
    controls.get('#rdp-intro-delay-body').checked = false;
    controls.get('#rdp-intro-delay-body').dispatch('change');
    assert.equal(created.end, 4.2);
    assert.equal(created.intro_delay_body, false);
    dp._syncDecorStackToScopeTasks({ structuralChange: true });
    assert.equal(tB.overlays.find(o => o.is_intro_countdown).end, 4.2);
    assert.equal(tB.overlays.find(o => o.is_intro_countdown).intro_delay_body, false);

    // Delete intro removes from both Task A and synced Task B
    controls.get('#rdp-intro-delete-btn').dispatch('click');
    assert.equal(tA.overlays.some(o => o.is_intro_countdown), false);
    assert.equal(tB.overlays.some(o => o.is_intro_countdown), false);
    assert.equal(controls.get('#rdp-intro-enable').checked, false);
});

test('Christian devotional creative card presets (ov-16..ov-35) & Muse template absorption are unique, support inline-full & JSON import, resolve fonts, and draw cleanly', () => {
    const {
        REELS_BUILTIN_OVERLAY_GROUP_PRESETS,
        REELS_OVERLAY_PRESET_ID_MAP,
        resolveBuiltinPreset,
    } = require('../src/reels-presets-init.js');
    const { resolveFontFamily } = require('../bin/videokit-cli.cjs');

    const ovKeys = Object.keys(REELS_OVERLAY_PRESET_ID_MAP);
    assert.equal(ovKeys.length, 35);
    const sigs = new Set();
    const newStructuralSigs = new Set();
    for (let n = 1; n <= 35; n++) {
        const code = `ov-${n < 10 ? '0' + n : n}`;
        const name = REELS_OVERLAY_PRESET_ID_MAP[code];
        assert.ok(name, `${code} must exist in REELS_OVERLAY_PRESET_ID_MAP`);
        const layers = REELS_BUILTIN_OVERLAY_GROUP_PRESETS[name];
        assert.ok(Array.isArray(layers) && layers.length >= 1, `${name} must have >=1 layer`);
        const resolved = resolveBuiltinPreset(code);
        assert.ok(resolved && resolved.kind === 'overlay', `${code} must resolve as overlay preset`);
        // Uniqueness fingerprint across visual styling/composition fields + colors
        const fp = JSON.stringify(layers.map(l => ({
            type: l.type, layout_mode: l.layout_mode, card_enabled: l.card_enabled, card_color: l.card_color,
            card_opacity: l.card_opacity, card_blur: l.card_blur_enabled, border: l.card_border_sides, feather: l.card_feather_dir,
            tBrush: l.title_bg_brush_style, bBrush: l.body_bg_brush_style, fBrush: l.footer_bg_brush_style,
            bBgMode: l.body_bg_mode, bBg: l.body_bg_color, tColor: l.title_color, bColor: l.body_color, fColor: l.footer_color,
            tFont: l.title_font_family, bFont: l.body_font_family, fFont: l.footer_font_family,
            flipper: l.flipper_enabled, deco: l.title_deco_style, decor: l.decor_style, intro: l.intro_style,
        })));
        assert.ok(!sigs.has(fp), `Overlay preset ${code} (${name}) must have a unique non-duplicate preset signature`);
        sigs.add(fp);
        if (n >= 16) {
            const structFp = JSON.stringify(layers.map(l => ({
                type: l.type, layout_mode: l.layout_mode, card_enabled: l.card_enabled, card_color: l.type === 'solid_mask' ? l.card_color : undefined,
                card_blur: Boolean(l.card_blur_enabled), border: l.card_border_sides || 'none',
                feather: l.card_feather_dir || 'none', radius_tl: l.radius_tl || 0,
                tBrush: l.title_bg_brush_style || '', bBrush: l.body_bg_brush_style || '', fBrush: l.footer_bg_brush_style || '',
                bBgMode: l.body_bg_mode || '', bBg: l.body_bg_mode === 'inline-full' ? l.body_bg_color : '',
                tFont: l.title_font_family || '', bFont: l.body_font_family || '',
                flipper: Boolean(l.flipper_enabled), deco: l.title_deco_style || '', decor: l.decor_style || '', intro: l.intro_style || '',
            })));
            assert.ok(!newStructuralSigs.has(structFp), `New preset ${code} (${name}) must be structurally creative and non-repetitive`);
            newStructuralSigs.add(structFp);
        }
    }

    const roSandbox = loadBrowserScript('src/reels-overlay.js', {
        window: {
            ReelsBrushEngine: { drawBrush() {} },
        },
    });
    roSandbox.ReelsBrushEngine = roSandbox.window.ReelsBrushEngine;
    const RO = roSandbox.window.ReelsOverlay;

    for (let n = 16; n <= 35; n++) {
        const code = `ov-${n}`;
        const layers = resolveBuiltinPreset(code).overlays;
        for (const layer of layers) {
            for (const fKey of ['title_font_family', 'body_font_family', 'footer_font_family', 'intro_top_font_family', 'intro_center_font_family', 'intro_bottom_font_family']) {
                if (layer[fKey]) {
                    const info = resolveFontFamily(layer[fKey]);
                    assert.ok(info && info.fontFiles.length > 0, `Font ${layer[fKey]} in ${code} must resolve`);
                }
            }
            let saves = 0;
            let restores = 0;
            const roundRectWidths = [];
            const mockGrad = { addColorStop() {} };
            const mockCtx = {
                direction: 'ltr', textAlign: 'center', textBaseline: 'alphabetic', globalAlpha: 1,
                font: '', fillStyle: '#fff', strokeStyle: '#000', lineWidth: 1, letterSpacing: '0px',
                save() { saves++; }, restore() { restores++; },
                beginPath() {}, closePath() {}, moveTo() {}, lineTo(x) {},
                quadraticCurveTo(cpx, cpy, x) {}, bezierCurveTo() {},
                arc() {}, arcTo() {}, ellipse() {}, rect() {}, roundRect() {}, clip() {},
                fill() {}, stroke() {}, fillRect() {}, strokeRect() {}, clearRect() {}, drawImage() {},
                fillText() {}, strokeText() {}, translate() {}, rotate() {}, scale() {}, setLineDash() {},
                createPattern() { return {}; }, createLinearGradient() { return mockGrad; }, createRadialGradient() { return mockGrad; },
                measureText: (txt) => ({ width: String(txt || '').length * 14, actualBoundingBoxAscent: 32, actualBoundingBoxDescent: 8 }),
            };
            const testT = layer.type === 'intro_countdown' ? 1.8 : 0.8;
            RO.drawOverlay(mockCtx, { ...layer, _exporting: true }, testT, 1080, 1920);
            assert.equal(saves, restores, `Preset ${code} layer(${layer.type}) drawOverlay must balance save/restore`);
        }
    }

    // Verify Muse text-layout-settings.json import converter cleanly builds VideoKit solid_mask + textcard layers
    const panelStore = new Map();
    const importSandbox = {
        console, Math, JSON, Date, Number, String, Boolean, Array, Object, Set, Map,
        alert() {}, confirm: () => true,
        localStorage: {
            getItem: (k) => (panelStore.has(k) ? panelStore.get(k) : null),
            setItem: (k, v) => panelStore.set(k, String(v)),
        },
        document: {
            head: { appendChild() {}, querySelector: () => null },
            body: { appendChild() {} },
            createElement: () => ({ id: '', textContent: '', style: {}, addEventListener() {} }),
            getElementById: () => null,
            querySelectorAll: () => [],
        },
        window: {},
    };
    importSandbox.window = importSandbox;
    vm.createContext(importSandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8'), importSandbox);
    const opProto = importSandbox.window.ReelsOverlayPanel.prototype;
    const fakePanel = Object.create(opProto);
    fakePanel._getOverlayGroupPresets = () => JSON.parse(panelStore.get('reels_overlay_group_presets') || '{}');
    fakePanel._setOverlayGroupPresets = (v) => panelStore.set('reels_overlay_group_presets', JSON.stringify(v));
    fakePanel._notifyOverlayPresetsChanged = () => {};

    fakePanel._mergeImportedOverlayGroupPresets({
        presetId: 'FB-26',
        mode: 'bars',
        gradStart: '#000000',
        gradEnd: '#000000',
        titleColor: '#FFFFFF',
        bodyBar: '#000000',
        bodyColor: '#FFFFFF',
        bodyOpacity: 0,
        titleOpacity: 0,
        textShadow: true,
        maskColor: '#000000',
        maskOpacity: 50,
        barFull: true,
        titleHL: 'GOD',
        titleHLColor: '#FFD400',
        titleFont: "'Playfair Display',serif",
        bodyFont: "'Libre Baskerville',serif",
        titleSize: 72,
        bodySize: 44,
        align: 'center',
    });
    const savedPresets = JSON.parse(panelStore.get('reels_overlay_group_presets') || '{}');
    const museConverted = savedPresets['Muse_FB-26'];
    assert.ok(Array.isArray(museConverted) && museConverted.length === 2, 'Muse masked template converts to solid_mask + textcard layers');
    assert.equal(museConverted[0].type, 'solid_mask');
    assert.equal(museConverted[0].card_opacity, 50);
    assert.equal(museConverted[1].type, 'textcard');
    assert.equal(museConverted[1].title_font_family, 'Playfair Display');
    assert.equal(museConverted[1].body_font_family, 'Libre Baskerville');
    assert.equal(museConverted[1].auto_color_rules[0].keywords[0], 'GOD');
});

test('Christmas sticker icons (32 shaded vector icons), draggable sticker overlays, and Christmas subtitle combos (sub-245..sub-250)', () => {
    const sandbox = {
        console,
        Math,
        JSON,
        Date,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Set,
        Map,
        Path2D: class MockPath2D { constructor(d) { this.d = d; } },
        Image: class MockImage {},
        window: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    loadBrowserScript('src/reels-style-engine.js', sandbox);
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);
    loadBrowserScript('src/reels-overlay.js', sandbox);

    const catalog = sandbox.window.HOLIDAY_ICON_CATALOG;
    assert.ok(Array.isArray(catalog) && catalog.length >= 32, `Expected >=32 holiday icons, got ${catalog?.length}`);
    const ids = new Set(catalog.map((i) => i.id));
    assert.equal(ids.size, catalog.length, 'Every Christmas icon ID must be unique');

    let drawCalls = 0;
    let rotateCalls = 0;
    const makeSpyCtx = () => ({
        lineCap: 'butt',
        lineJoin: 'miter',
        lineWidth: 1,
        globalAlpha: 1,
        shadowColor: '',
        shadowBlur: 0,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        fillStyle: '#000',
        strokeStyle: '#000',
        save() {},
        restore() {},
        translate() {},
        rotate(a) { if (Math.abs(a) > 1e-6) rotateCalls++; },
        scale() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        bezierCurveTo() {},
        arc() {},
        ellipse() {},
        rect() {},
        roundRect() {},
        setLineDash() {},
        fill() { drawCalls++; },
        stroke() { drawCalls++; },
        fillRect() { drawCalls++; },
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
    });

    // 1. Every holiday icon renders cleanly both as a centered sticker AND as a subtitle companion tip
    for (const item of catalog) {
        assert.equal(sandbox.window.isImageOrVectorWritingTip(item.id), true, `Icon ${item.id} must register as writing tip`);
        const ctx1 = makeSpyCtx();
        const before1 = drawCalls;
        const ok1 = sandbox.window.drawHolidayStickerIcon(ctx1, item.id, 100, 100, 180, { time: 0.8 });
        assert.equal(ok1, true, `drawHolidayStickerIcon should draw ${item.id}`);
        assert.ok(drawCalls > before1, `${item.id} should issue canvas draw operations`);

        const ctx2 = makeSpyCtx();
        const before2 = drawCalls;
        sandbox.window.drawSpeechWritingTip(ctx2, item.id, 10, 40, 32, 0);
        assert.ok(drawCalls > before2, `drawSpeechWritingTip should draw ${item.id}`);
    }

    // 2. Draggable sticker overlays render, update hitTest boxes, and sway cleanly
    const RO = sandbox.window.ReelsOverlay;
    assert.equal(typeof RO.createStickerOverlay, 'function');
    const bellOv = RO.createStickerOverlay({
        sticker_kind: 'jingle_bell',
        cta_loop_anim: 'sway_bell',
        x: 410, y: 220, w: 260, h: 260,
        anim_in_type: 'elastic_pop', anim_in_duration: 0.4,
    });
    assert.equal(bellOv.type, 'sticker');
    assert.equal(bellOv.sticker_kind, 'jingle_bell');
    bellOv._exporting = true;

    rotateCalls = 0;
    const mgr = new RO.OverlayManager();
    mgr.addOverlay(bellOv);
    const spy = makeSpyCtx();
    mgr.renderAll(spy, 1.35, 1080, 1920);
    assert.ok(rotateCalls > 0, 'sway_bell loop animation should rotate during playback/export');
    assert.equal(bellOv._renderedX, 410);
    assert.equal(bellOv._renderedY, 220);
    assert.equal(bellOv._renderedW, 260);
    assert.equal(bellOv._renderedH, 260);
    assert.equal(mgr.hitTest(540, 350, 1.35)?.id, bellOv.id, 'Sticker should be draggable via hitTest inside box');
    assert.equal(mgr.hitTest(50, 50, 1.35), null, 'Sticker hitTest outside box should miss');

    // Twinkle mode with sparkles
    const globeOv = RO.createStickerOverlay({
        sticker_kind: 'xmas_snow_globe',
        cta_loop_anim: 'twinkle',
        sticker_sparkles: true,
        x: 100, y: 200, w: 200, h: 200,
    });
    globeOv._exporting = true;
    const beforeSpark = drawCalls;
    RO.drawOverlay(makeSpyCtx(), globeOv, 0.35, 1080, 1920);
    assert.ok(drawCalls > beforeSpark);

    // 3. New Christmas subtitle presets (sub-245..sub-250) & UI wiring
    const idMap = sandbox.window.REELS_PRESET_ID_MAP;
    const presets = sandbox.window.REELS_BUILTIN_PRESETS;
    for (const code of ['sub-245', 'sub-246', 'sub-247', 'sub-248', 'sub-249', 'sub-250']) {
        const name = idMap[code];
        assert.ok(name && presets[name], `${code} Christmas subtitle preset should exist`);
    }
    const emeraldStyle = presets[idMap['sub-245']];
    assert.equal(emeraldStyle.color_bg, '#129E4D');
    assert.equal(emeraldStyle.box_connected, true);
    assert.equal(emeraldStyle.color_text, '#FFFFFF');

    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    const batchSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    assert.match(panelSrc, /rop-add-sticker/);
    assert.match(panelSrc, /'sticker'/);
    assert.match(panelSrc, /data-pos="sub-below"/);
    assert.match(panelSrc, /data-pos="bottom-center"/);
    assert.match(panelSrc, /data-pos="bottom-left"/);
    assert.match(panelSrc, /data-pos="bottom-right"/);
    assert.match(htmlSrc, /reels-xmas-subtitle-icon-grid/);
    assert.match(htmlSrc, /reels-xmas-icon-adjust-bar/);
    assert.match(htmlSrc, /reels-xmas-ctl-size/);
    assert.match(htmlSrc, /reels-xmas-ctl-x/);
    assert.match(htmlSrc, /reels-xmas-ctl-y/);
    assert.match(htmlSrc, /reels-xmas-ctl-angle/);
    assert.match(htmlSrc, /reels-xmas-ctl-anim/);
    assert.match(htmlSrc, /data-pos="sub-below"/);
    assert.match(htmlSrc, /data-pos="bottom-center"/);
    assert.match(htmlSrc, /reelsApplyChristmasComboPreset\('xmas_combo_tree_bells'\)/);
    assert.match(batchSrc, /reelsSyncChristmasIconAdjustUI/);
});

test('media bind_scroll follow survives paused fade selection, template fallback, inverted bounds, hitTest, and batch task sync', () => {
    const sandbox = {
        console,
        Math,
        JSON,
        Date,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Set,
        Map,
        Path2D: class MockPath2D { constructor(d) { this.d = d; } },
        Image: class MockImage {},
        window: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    loadBrowserScript('src/reels-style-engine.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);
    loadBrowserScript('src/reels-overlay.js', sandbox);
    const RO = sandbox.window.ReelsOverlay;
    assert.ok(RO);

    const makeCtx = () => ({
        lineCap: 'butt',
        lineJoin: 'miter',
        lineWidth: 1,
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        shadowColor: '',
        shadowBlur: 0,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        fillStyle: '#000',
        strokeStyle: '#000',
        font: '40px Arial',
        direction: 'ltr',
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
        clip() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        bezierCurveTo() {},
        arc() {},
        ellipse() {},
        rect() {},
        roundRect() {},
        setLineDash() {},
        fill() {},
        stroke() {},
        fillRect() {},
        strokeRect() {},
        clearRect() {},
        fillText() {},
        strokeText() {},
        drawImage() {},
        measureText: (txt) => ({
            width: String(txt || '').length * 16,
            actualBoundingBoxAscent: 32,
            actualBoundingBoxDescent: 8,
        }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
    });

    // 1. Bound media in paused editor at t=0 with anim_in_type='fade' must evaluate scroll at t=0 (not shifted t=0.45s)
    const scrollOv = RO.createScrollOverlay({
        content: 'Line 1 words\nLine 2 words',
        scroll_from_y: 1200,
        scroll_to_y: 300,
        scroll_end_y_auto: false,
        start: 0,
        end: 10,
        scroll_end_auto: false,
    });
    scrollOv.id = 'scroll_a';
    scrollOv._templateOverlayId = 'tpl_scroll_1';
    const mediaAtT0 = RO.createImageOverlay({
        content: '',
        x: 100,
        y: 100,
        w: 200,
        h: 200,
        start: 0,
        end: 10,
        anim_in_type: 'fade',
        anim_in_duration: 0.4,
    });
    mediaAtT0.id = 'img_bind_1';
    mediaAtT0.bind_scroll_overlay_id = 'scroll_a';
    mediaAtT0.bind_scroll_offset_y = 0;
    mediaAtT0._selected = true;

    const mgr = new RO.OverlayManager();
    mgr.addOverlay(scrollOv);
    mgr.addOverlay(mediaAtT0);
    mgr.renderAll(makeCtx(), 0, 1080, 1920);
    const yAtPausedSelectedT0 = mediaAtT0._renderedY;
    assert.ok(Number.isFinite(yAtPausedSelectedT0));
    assert.ok(Math.abs(yAtPausedSelectedT0 - scrollOv._scrollBodyFirstLineY) < 0.01, 'Selected fade media at t=0 should follow scroll line 1 at t=0, not t+inDur');

    // 2. Inverted clamp bounds (min=900, max=300) still move & clamp cleanly inside [300, 900]
    mediaAtT0.bind_scroll_clamp_min_y = 900;
    mediaAtT0.bind_scroll_clamp_max_y = 300;
    mediaAtT0._selected = false;
    mgr.renderAll(makeCtx(), 5, 1080, 1920);
    assert.ok(mediaAtT0._renderedY >= 300 && mediaAtT0._renderedY <= 900);

    // 3. hitTest uses _renderedX/_renderedY so user can click bound media at its moved position
    mediaAtT0.bind_scroll_clamp_min_y = null;
    mediaAtT0.bind_scroll_clamp_max_y = null;
    mgr.renderAll(makeCtx(), 8, 1080, 1920);
    assert.equal(mgr.hitTest(150, mediaAtT0._renderedY + 50, 8)?.id, mediaAtT0.id);

    // 4. Stale ID recovers via _bindScrollTemplateOverlayId fallback
    const clonedMedia = RO.createImageOverlay({
        content: '',
        x: 50,
        y: 50,
        w: 180,
        h: 180,
        start: 0,
        end: 10,
    });
    clonedMedia.id = 'img_bind_cloned';
    clonedMedia.bind_scroll_overlay_id = 'stale_deleted_scroll_id';
    clonedMedia._bindScrollTemplateOverlayId = 'tpl_scroll_1';
    clonedMedia.bind_scroll_offset_y = 12;
    clonedMedia._allOverlays = [scrollOv];
    RO.drawOverlay(makeCtx(), clonedMedia, 5, 1080, 1920);
    RO.drawOverlay(makeCtx(), scrollOv, 5, 1080, 1920);
    assert.equal(Math.round(clonedMedia._renderedY), Math.round(scrollOv._scrollBodyFirstLineY + 12));

    // 5. Sticker overlay can also bind & follow scrolling text
    const boundSticker = RO.createStickerOverlay({
        sticker_kind: 'jingle_bell',
        x: 410,
        y: 220,
        w: 220,
        h: 220,
        start: 0,
        end: 10,
    });
    boundSticker.id = 'stk_bind_1';
    boundSticker.bind_scroll_overlay_id = 'scroll_a';
    boundSticker.bind_scroll_offset_y = -25;
    boundSticker._allOverlays = [scrollOv];
    RO.drawOverlay(makeCtx(), boundSticker, 4, 1080, 1920);
    RO.drawOverlay(makeCtx(), scrollOv, 4, 1080, 1920);
    assert.equal(Math.round(boundSticker._renderedY), Math.round(scrollOv._scrollBodyFirstLineY - 25));

    // 6. _applyGenericOverlayStyleToAllTasks remaps bind_scroll_overlay_id per target task (no cross-task stale ID leak)
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    const fnStart = panelSrc.indexOf('    _findMatchingOverlayInTask(task, sourceOv) {');
    const fnEnd = panelSrc.indexOf('    _applyTextcardStyleToAllTasks(ov) {', fnStart);
    const panelSnippet = `class FakePanel { constructor() { this.videoCanvas = null; } _shouldSyncStyleToScope() { return true; } _getStyleApplyScopeTasks() { return this._tasks; } _afterScopeStyleSync() {}\n${panelSrc.slice(fnStart, fnEnd)}\n}`;
    const task1Scroll = { id: 'sc_task1', type: 'scroll', _templateOverlayId: 'tpl_sc' };
    const task1Img = { id: 'img_task1', type: 'image', bind_scroll_overlay_id: 'sc_task1', bind_scroll_offset_y: 45 };
    const task2Scroll = { id: 'sc_task2', type: 'scroll', _templateOverlayId: 'tpl_sc' };
    const task2Img = { id: 'img_task2', type: 'image', bind_scroll_overlay_id: 'sc_task2', bind_scroll_offset_y: 0 };
    const panelCtx = { window: { _reelsState: { tasks: [], selectedIdx: 0 } }, console };
    vm.createContext(panelCtx);
    const PanelCls = vm.runInContext(`(${panelSnippet})`, panelCtx);
    const p = new PanelCls();
    const task1 = { overlays: [task1Scroll, task1Img] };
    const task2 = { overlays: [task2Scroll, task2Img] };
    p.videoCanvas = { scopedTask: task1, overlayMgr: { overlays: task1.overlays } };
    p._tasks = [task1, task2];
    panelCtx.window._reelsState.tasks = [task1, task2];
    p._applyGenericOverlayStyleToAllTasks(task1Img);
    assert.equal(task2Img.bind_scroll_offset_y, 45, 'Offset should sync to task2');
    assert.equal(task2Img.bind_scroll_overlay_id, 'sc_task2', 'task2 must keep its own scroll overlay ID, not task1 ID');
});

test('Cardinal reddish-brown feather, 7 new aesthetic feather/cardinal icons, and sentence-level cursor following in T-subtitle and scroll', () => {
    const sandbox = {
        console,
        Math,
        JSON,
        Date,
        Number,
        String,
        Boolean,
        Array,
        Object,
        Set,
        Map,
        Path2D: class MockPath2D { constructor(d) { this.d = d; } },
        Image: class MockImage {},
        window: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    loadBrowserScript('src/reels-anim-engine.js', sandbox);
    loadBrowserScript('src/reels-style-engine.js', sandbox);
    loadBrowserScript('src/reels-presets-init.js', sandbox);
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);
    loadBrowserScript('src/reels-overlay.js', sandbox);

    const newIds = [
        'cardinal_feather', 'northern_cardinal', 'cardinal_quill_gold', 'amber_autumn_feather',
        'crimson_rose_feather', 'frost_crystal_feather', 'peacock_plumage', 'dove_white_feather',
    ];
    let ops = 0;
    const makeCtx = () => ({
        lineCap: 'butt', lineJoin: 'miter', lineWidth: 1, globalAlpha: 1,
        globalCompositeOperation: 'source-over', shadowColor: '', shadowBlur: 0,
        shadowOffsetX: 0, shadowOffsetY: 0, fillStyle: '#000', strokeStyle: '#000',
        font: '40px Arial', direction: 'ltr', textBaseline: 'alphabetic', textAlign: 'left',
        save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, clip() {},
        beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
        bezierCurveTo() {}, arc() {}, ellipse() {}, rect() {}, roundRect() {}, setLineDash() {},
        fill() { ops++; }, stroke() { ops++; }, fillRect() { ops++; }, strokeRect() {}, clearRect() {},
        fillText() { ops++; }, strokeText() {}, drawImage() { ops++; },
        measureText: (txt) => ({
            width: String(txt || '').length * 14,
            actualBoundingBoxAscent: 28,
            actualBoundingBoxDescent: 8,
        }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
    });

    for (const id of newIds) {
        assert.equal(sandbox.window.isImageOrVectorWritingTip(id), true, `${id} must be registered as writing tip`);
        assert.ok(sandbox.window.HOLIDAY_ICON_MAP[id], `${id} must exist in HOLIDAY_ICON_CATALOG`);
        const before = ops;
        assert.equal(sandbox.window.drawHolidayStickerIcon(makeCtx(), id, 120, 120, 160, { time: 0.4 }), true);
        assert.ok(ops > before, `${id} should draw sticker geometry`);
        const beforeTip = ops;
        sandbox.window.drawSpeechWritingTip(makeCtx(), id, 40, 80, 36, -8);
        assert.ok(ops > beforeTip, `${id} should draw speech writing tip`);
    }

    // Standard T-subtitle sentence reveal + cardinal_feather cursor
    const renderer = new sandbox.window.ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: makeCtx });
    const drawnTexts = [];
    renderer.ctx = {
        ...makeCtx(),
        fillText(t) { ops++; drawnTexts.push(String(t)); },
    };
    const seg = {
        start: 0, end: 4,
        text: 'Cardinals appear. Angels are near.',
        words: [
            { word: 'Cardinals', start: 0.0, end: 0.8 },
            { word: 'appear.', start: 0.8, end: 1.6 },
            { word: 'Angels', start: 2.0, end: 2.6 },
            { word: 'are', start: 2.6, end: 3.1 },
            { word: 'near.', start: 3.1, end: 3.8 },
        ],
    };
    const style = {
        ...sandbox.window.REELS_SUBTITLE_DEFAULTS,
        anim_in_type: 'typewriter',
        typewriter_reveal_type: 'sentence',
        tw_unrevealed_opacity: 0,
        subtitle_cursor_enabled: true,
        fullpage_typewriter_cursor_kind: 'cardinal_feather',
    };
    renderer.renderSubtitle(style, seg, 0.2, 1080, 1920);
    const joinedAt02 = drawnTexts.join(' ');
    assert.ok(joinedAt02.includes('Cardinals') && joinedAt02.includes('appear.'), 'First sentence reveals together at 0.2s');
    assert.ok(!joinedAt02.includes('Angels'), 'Second sentence stays hidden until second sentence begins');

    // Scroll subtitle sentence mode + cardinal_feather
    const scrollOv = sandbox.window.ReelsOverlay.createScrollOverlay({
        content: 'Cardinals appear.\nAngels are near.',
        scroll_typewriter_enabled: true,
        scroll_tw_reveal_type: 'sentence',
        scroll_tw_cursor_enabled: true,
        scroll_tw_cursor_kind: 'cardinal_feather',
        scroll_tw_hide_unread: true,
        start: 0,
        end: 6,
    });
    const beforeScroll = ops;
    sandbox.window.ReelsOverlay.drawOverlay(makeCtx(), scrollOv, 1.5, 1080, 1920);
    assert.ok(ops > beforeScroll, 'Scroll sentence mode with cardinal_feather should draw');

    const htmlSrc = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    assert.match(htmlSrc, /cardinal_feather/);
    assert.match(htmlSrc, /id="reels-typewriter-reveal-type"[\s\S]*?<option value="sentence">/);
    assert.match(panelSrc, /cardinal_feather/);
});

test('Scroll line-by-line highlight mode: panel event bindings, speech_or_progress default & cursor/underline sync', () => {
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    const fieldsStart = panelSrc.indexOf('const fields = [');
    const fieldsEnd = panelSrc.indexOf('for (const fid of fields)', fieldsStart);
    assert.ok(fieldsStart > 0 && fieldsEnd > fieldsStart, 'fields array must exist in _bindEvents');
    const fieldsBlock = panelSrc.slice(fieldsStart, fieldsEnd);
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
        'rop-scroll-bg-top-mascot',
    ]) {
        assert.ok(fieldsBlock.includes(`'${id}'`), `#${id} must be bound in _bindEvents fields`);
    }
    assert.match(panelSrc, /_val\('rop-scroll-tw-line-track-mode',\s*ov\.scroll_tw_line_track_mode\s*\|\|\s*'speech_or_progress'\)/);
    assert.match(panelSrc, /ov\.scroll_tw_line_track_mode\s*=\s*this\._get\('rop-scroll-tw-line-track-mode'\)\s*\|\|\s*'speech_or_progress'/);

    const tipCalls = [];
    const fillTexts = [];
    const underlineStrokes = [];
    let movePt = null;
    const makeCtx = () => ({
        canvas: { width: 1080, height: 1920 },
        font: '700 44px Arial',
        fillStyle: '#FFFFFF',
        strokeStyle: '#000000',
        lineWidth: 1,
        lineCap: 'butt',
        lineJoin: 'miter',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        save() {},
        restore() {},
        beginPath() {},
        closePath() {},
        moveTo(x, y) { movePt = { x, y }; },
        lineTo(x, y) { if (movePt) this._lastSeg = { x0: movePt.x, y0: movePt.y, x1: x, y1: y }; },
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
        stroke() {
            if (String(this.strokeStyle).toUpperCase() === '#E2B95B' && this._lastSeg) {
                underlineStrokes.push({ ...this._lastSeg });
            }
        },
        fillRect() {},
        strokeRect() {},
        clearRect() {},
        drawImage() {},
        fillText(text, x, y) {
            fillTexts.push({ text: String(text), x, y, fillStyle: String(this.fillStyle) });
        },
        strokeText() {},
        measureText: (txt) => ({
            width: String(txt || '').length * 20,
            actualBoundingBoxAscent: 32,
            actualBoundingBoxDescent: 8,
        }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
    });

    const sandbox = loadBrowserScript('src/reels-overlay.js', {
        window: { addEventListener() {} },
        drawSpeechWritingTip(_ctx, kind, x, y) {
            tipCalls.push({ kind, x, y });
        },
    });
    const ReelsOverlay = sandbox.window.ReelsOverlay;

    const lines = [
        'Today you will receive a',
        'gift from God if you',
        'read this to the end.',
        'God forgives me, God',
        'protects me, God hears',
        'me, God is with me.',
    ];
    // Include an overlapping end timestamp on line 0 to verify line tracking never stalls on line 0
    const segments = [
        { start: 0.0, end: 6.2, text: lines[0] },
        { start: 2.0, end: 3.5, text: lines[1] },
        { start: 3.5, end: 5.0, text: lines[2] },
        { start: 5.0, end: 7.0, text: lines[3] },
        { start: 7.0, end: 8.8, text: lines[4] },
        { start: 8.8, end: 10.5, text: lines[5] },
    ];

    const ovSpeech = ReelsOverlay.createScrollOverlay({
        content: lines.join('\n'),
        scroll_uppercase: false,
        fontsize: 44,
        line_spacing: 20,
        scroll_static: true,
        scroll_typewriter_enabled: true,
        scroll_tw_reveal_type: 'line',
        scroll_tw_line_track_mode: 'speech_or_progress',
        scroll_tw_hide_unread: false,
        scroll_tw_unrevealed_opacity: 100,
        scroll_tw_active_highlight: true,
        scroll_tw_active_color: '#FFD700',
        scroll_tw_keep_read_color: true,
        scroll_tw_active_scale_enabled: true,
        scroll_tw_active_scale: 125,
        scroll_tw_underline_enabled: true,
        scroll_tw_underline_color: '#E2B95B',
        scroll_tw_cursor_enabled: true,
        scroll_tw_cursor_kind: 'quill',
        feather_top: 0,
        feather_bottom: 0,
        start: 0,
        end: 12,
    });
    ovSpeech._taskSegments = segments;

    ReelsOverlay.drawOverlay(makeCtx(), ovSpeech, 5.4, 1080, 1920);
    const activeLineDraw = fillTexts.find(f => f.text.includes('God forgives me, God'));
    assert.ok(activeLineDraw, 'Active line 4 should render as a single merged run');
    assert.equal(activeLineDraw.fillStyle.toUpperCase(), '#FFD700', 'Active line 4 must be highlighted #FFD700');
    const line1Draw = fillTexts.find(f => f.text.includes('Today you will receive a'));
    const line2Draw = fillTexts.find(f => f.text.includes('gift from God if you'));
    const line5Draw = fillTexts.find(f => f.text.includes('protects me, God hears'));
    assert.equal(line1Draw.fillStyle.toUpperCase(), '#FFD700', 'Read line 1 keeps highlight color');
    assert.equal(line2Draw.fillStyle.toUpperCase(), '#FFD700', 'Read line 2 keeps highlight color');
    assert.equal(line5Draw.fillStyle.toUpperCase(), '#FFFFFF', 'Unread line 5 stays base color');
    assert.equal(underlineStrokes.length, 1, 'Exactly one following underline should be drawn');
    assert.ok(underlineStrokes[0].y0 > activeLineDraw.y && underlineStrokes[0].y0 < activeLineDraw.y + 40, 'Underline must sit beneath active line 4, not line 1');
    assert.equal(tipCalls.length, 1, 'Feather cursor should be drawn');
    assert.ok(Math.abs(tipCalls[0].y - activeLineDraw.y) < 30, 'Feather cursor must stay on active line 4');

    // Focus-zone mode with cursor enabled must keep cursor anchored on the focus-zone active line
    fillTexts.length = 0;
    underlineStrokes.length = 0;
    tipCalls.length = 0;
    const ovFocus = ReelsOverlay.createScrollOverlay({
        ...ovSpeech,
        id: 'scroll_focus_line_cursor_test',
        scroll_tw_line_track_mode: 'focus_zone',
        scroll_tw_active_scale_enabled: false,
        scroll_focus_start_pct: 5,
        scroll_focus_end_pct: 5,
    });
    ovFocus._taskSegments = segments;
    ReelsOverlay.drawOverlay(makeCtx(), ovFocus, 5.4, 1080, 1920);
    const focusLine1Draw = fillTexts.find(f => f.text.includes('Today you will receive a'));
    assert.equal(focusLine1Draw.fillStyle.toUpperCase(), '#FFD700', 'Focus zone targets top line 1');
    assert.equal(tipCalls.length, 1, 'Cursor should still render in focus-zone mode');
    assert.ok(Math.abs(tipCalls[0].y - focusLine1Draw.y) < 30, 'Cursor must stay on focus-zone highlighted line 1 instead of drifting to line 4');
});

test('Facebook Reel 4817870781833385 preset sub-251: Poppins stacked white/orange black-stroke mixed layout & word_spacing', () => {
    const sandbox = loadBrowserScript('src/reels-anim-engine.js', {
        window: { addEventListener() {} },
        localStorage: { getItem() { return null; }, setItem() {} },
    });
    sandbox.ReelsAnimEngine = sandbox.window.ReelsAnimEngine;
    loadBrowserScript('src/reels-style-engine.js', sandbox);
    sandbox.ReelsStyleEngine = sandbox.window.ReelsStyleEngine;
    loadBrowserScript('src/reels-canvas-renderer.js', sandbox);
    loadBrowserScript('src/reels-presets-init.js', sandbox);

    const resolved = sandbox.window.resolveBuiltinPreset('sub-251');
    assert.ok(resolved && resolved.kind === 'subtitle' && resolved.preset, 'sub-251 must resolve');
    assert.equal(resolved.name, '🧡 祈祷橙白黑边_动态首尾大字 (Daily Prayers同款)');
    assert.equal(resolved.preset.font_family, 'Poppins');
    assert.equal(resolved.preset.mixed_layout, 'stack');
    assert.equal(resolved.preset.color_text, '#FFFFFF');
    assert.equal(resolved.preset.color_high, '#FF6A00');
    assert.equal(resolved.preset.color_outline, '#000000');
    assert.equal(resolved.preset.border_width, 8);
    assert.equal(resolved.preset.word_spacing, 14);
    assert.equal(resolved.preset.shadow_blur, 0);

    const { categorized } = sandbox.window.ReelsStyleEngine.getPresetsByCategory();
    const mixedCat = categorized.find(c => c.category === '🔤 动态混排');
    assert.ok(mixedCat && mixedCat.names.includes(resolved.name), 'sub-251 must appear under 🔤 动态混排');
    const occurrences = categorized.filter(c => c.names.includes(resolved.name)).length;
    assert.equal(occurrences, 1, 'sub-251 must belong to exactly one category');

    const drawn = [];
    const makeCtx = () => ({
        canvas: { width: 1080, height: 1920 },
        font: '800 76px "Poppins"',
        fillStyle: '#FFFFFF',
        strokeStyle: '#000000',
        lineWidth: 1,
        lineJoin: 'miter',
        miterLimit: 10,
        globalAlpha: 1,
        textAlign: 'left',
        textBaseline: 'top',
        shadowColor: '',
        shadowBlur: 0,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        fill() {},
        stroke() {},
        fillText(t, x, y) { drawn.push({ kind: 'fill', text: String(t), x, y, style: String(this.fillStyle), font: this.font }); },
        strokeText(t, x, y) { drawn.push({ kind: 'stroke', text: String(t), x, y, style: String(this.strokeStyle), lineWidth: this.lineWidth, font: this.font }); },
        measureText: (txt) => ({ width: String(txt || '').length * 24, actualBoundingBoxAscent: 40, actualBoundingBoxDescent: 10 }),
        createLinearGradient: () => ({ addColorStop() {} }),
    });

    const renderer = new sandbox.window.ReelsCanvasRenderer({ width: 1080, height: 1920, getContext: makeCtx });
    renderer.ctx = makeCtx();
    const seg = {
        start: 0,
        end: 3.5,
        text: 'and the deepest valleys, there were times',
        words: [
            { word: 'and', start: 0.0, end: 0.4 },
            { word: 'the', start: 0.4, end: 0.7 },
            { word: 'deepest', start: 0.7, end: 1.2 },
            { word: 'valleys,', start: 1.2, end: 1.8 },
            { word: 'there', start: 1.8, end: 2.3 },
            { word: 'were', start: 2.3, end: 2.8 },
            { word: 'times', start: 2.8, end: 3.5 },
        ],
    };
    const mergedStyle = sandbox.window.ReelsStyleEngine.mergeStyle(resolved.preset);
    renderer.renderSubtitle(mergedStyle, seg, 3.1, 1080, 1920);
    const fillTimes = drawn.find(d => d.kind === 'fill' && d.text === 'times');
    const fillAnd = drawn.find(d => d.kind === 'fill' && d.text === 'and');
    const fillThe = drawn.find(d => d.kind === 'fill' && d.text === 'the');
    const fillDeepest = drawn.find(d => d.kind === 'fill' && d.text === 'deepest');
    const strokeTimes = drawn.find(d => d.kind === 'stroke' && d.text === 'times');
    assert.ok(fillTimes && fillAnd && fillThe && fillDeepest && strokeTimes, 'Expected stacked words to render');
    assert.equal(fillTimes.style.toUpperCase(), '#FF6A00', 'Currently active word must highlight orange #FF6A00');
    assert.equal(fillAnd.style.toUpperCase(), '#FFFFFF', 'Read word must remain pure white #FFFFFF');
    assert.equal(strokeTimes.style.toUpperCase(), '#000000', 'Word outline must be pure black #000000');
    assert.equal(strokeTimes.lineWidth, 16, 'Border width 8 renders 16px stroke');
    const sz = (f) => parseFloat(String(f).match(/([\d.]+)px/)?.[1] || '0');
    assert.ok(sz(fillTimes.font) > sz(fillDeepest.font), 'Stack edge emphasis word must be larger than middle row word');

    // Verify word_spacing widens horizontal gap between same-row words in mixed layout
    const wideGap = fillDeepest.x - fillThe.x;
    drawn.length = 0;
    renderer.renderSubtitle({ ...mergedStyle, word_spacing: 0 }, seg, 3.1, 1080, 1920);
    const tightThe = drawn.find(d => d.kind === 'fill' && d.text === 'the');
    const tightDeepest = drawn.find(d => d.kind === 'fill' && d.text === 'deepest');
    assert.ok(wideGap > (tightDeepest.x - tightThe.x), 'Configured word_spacing: 14 must widen inter-word spacing in mixed layout');
});

test('Sticker overlays persist across full duration, animate sway_bell/twinkle, survive static export & multi-page sync, and batch-reels defines isMediaPlaying', () => {
    const ovSandbox = loadBrowserScript('src/reels-overlay.js', {
        performance,
        window: {
            performance,
            ReelsAnimEngine: {
                computeAnimProgress: (t, s, e, inDur) => [inDur > 0 ? Math.max(0, Math.min(1, (t - s) / inDur)) : 1, 1],
                computePopScale: (p) => p,
                EASING_MAP: { elastic: (p) => p, bounce: (p) => p },
                computeSlideOffset: () => [0, 0],
            },
        },
    });
    const RO = ovSandbox.window.ReelsOverlay;

    const sticker = RO.createStickerOverlay({ sticker_kind: 'jingle_bell', cta_loop_anim: 'sway_bell', anim_in_type: 'elastic_pop' });
    assert.equal(sticker.scroll_end_auto, true, 'Stickers default to full-duration auto mode');
    assert.equal(RO.isFullDurationAutoOverlay(sticker), true);

    const trackCalls = [];
    const makeTrackCtx = () => {
        const ctx = {
            globalAlpha: 1,
            font: '',
            fillStyle: '#fff',
            strokeStyle: '#000',
            shadowColor: 'transparent',
            shadowBlur: 0,
            shadowOffsetX: 0,
            shadowOffsetY: 0,
            lineWidth: 1,
            save() { trackCalls.push({ op: 'save', alpha: ctx.globalAlpha }); },
            restore() { trackCalls.push({ op: 'restore' }); },
            translate() {},
            rotate(rad) { trackCalls.push({ op: 'rotate', rad }); },
            scale(sx, sy) { trackCalls.push({ op: 'scale', sx, sy }); },
            beginPath() {},
            closePath() {},
            moveTo() {},
            lineTo() {},
            quadraticCurveTo() {},
            bezierCurveTo() {},
            arc() {},
            ellipse() {},
            rect() {},
            roundRect() {},
            fill() { trackCalls.push({ op: 'fill', alpha: ctx.globalAlpha, fillStyle: ctx.fillStyle }); },
            stroke() {},
            fillRect() {},
            strokeRect() {},
            fillText() {},
            strokeText() {},
            createLinearGradient() { return { addColorStop() {} }; },
            createRadialGradient() { return { addColorStop() {} }; },
            measureText: (t) => ({ width: String(t || '').length * 10 }),
        };
        return ctx;
    };

    // 1) Full-duration persistence even if end was transiently set below currentTime (e.g. 5s vs 25s)
    const shrunkEndAuto = { ...sticker, end: 5, _previewPlaying: true };
    trackCalls.length = 0;
    RO.drawOverlay(makeTrackCtx(), shrunkEndAuto, 25.0, 1080, 1920);
    assert.ok(trackCalls.some(c => c.op === 'fill'), 'Auto-full sticker must keep rendering past transient end (t=25s)');

    // Explicit manual cutoff stops rendering past end
    const manualCutoff = { ...sticker, scroll_end_auto: false, end: 5, _previewPlaying: true };
    trackCalls.length = 0;
    RO.drawOverlay(makeTrackCtx(), manualCutoff, 6.5, 1080, 1920);
    assert.equal(trackCalls.some(c => c.op === 'fill'), false, 'Manual end cutoff (scroll_end_auto=false) stops at t=6.5s');

    // 2) Static PNG export (_staticPreview: true at t=0 with elastic_pop) renders full visibility (never zero-scaled)
    trackCalls.length = 0;
    RO.drawOverlay(makeTrackCtx(), { ...sticker, _exporting: true, _staticPreview: true }, 0, 1080, 1920);
    assert.ok(trackCalls.some(c => c.op === 'fill'), '_staticPreview must draw sticker fills at t=0');
    assert.ok(!trackCalls.some(c => c.op === 'scale' && Math.abs(c.sx) < 0.1), '_staticPreview must not zero-scale elastic_pop at t=0');

    // 3) sway_bell rotates continuously during playback and during immediate dropdown preview, stays still when paused
    trackCalls.length = 0;
    RO.drawOverlay(makeTrackCtx(), { ...sticker, _previewPlaying: false }, 1.2, 1080, 1920);
    const pausedRotates = trackCalls.filter(c => c.op === 'rotate').map(c => c.rad);

    trackCalls.length = 0;
    RO.drawOverlay(makeTrackCtx(), { ...sticker, _previewPlaying: true }, 1.2, 1080, 1920);
    const playingRotates = trackCalls.filter(c => c.op === 'rotate').map(c => c.rad);
    assert.ok(playingRotates.length === pausedRotates.length + 1, 'Playing sticker adds outer sway_bell rotation transform');
    assert.ok(Math.abs(playingRotates[0]) > 0.01, `Playing outer sway_bell rotation (${playingRotates[0]}) must be non-zero`);

    trackCalls.length = 0;
    const now = performance.now();
    RO.drawOverlay(makeTrackCtx(), {
        ...sticker,
        _previewPlaying: false,
        _ctaAnimPreviewStart: now - 150,
        _loopPreviewImmediate: true,
    }, 0, 1080, 1920);
    const previewRotates = trackCalls.filter(c => c.op === 'rotate').map(c => c.rad);
    assert.ok(previewRotates.length === pausedRotates.length + 1, 'Immediate loop preview rotates immediately on change even at t=0 paused');
    assert.ok(Math.abs(previewRotates[0]) > 0.01, `Immediate loop preview sway angle (${previewRotates[0]}) must be non-zero`);

    // twinkle emits sparkle stars during playback
    trackCalls.length = 0;
    RO.drawOverlay(makeTrackCtx(), { ...sticker, cta_loop_anim: 'twinkle', _previewPlaying: true }, 1.2, 1080, 1920);
    assert.ok(trackCalls.some(c => c.op === 'scale' && Math.abs(c.sx - 1) > 0.001), 'twinkle scales smoothly during playback');

    // 4) Source contract checks on src/batch-reels.js for isMediaPlaying & sticker sync
    const batchSrc = fs.readFileSync(path.join(ROOT, 'src/batch-reels.js'), 'utf8');
    const declIdx = batchSrc.indexOf('const isMediaPlaying = _isPreviewActuallyPlaying(');
    const firstUseIdx = batchSrc.indexOf('!isMediaPlaying');
    assert.ok(declIdx > 0 && declIdx < firstUseIdx, 'const isMediaPlaying must be declared before its first read in _reelsUpdatePreviewInternal');
    assert.ok(batchSrc.includes('window._syncOverlayStackToScopeTasks = function'), 'batch-reels.js must define window._syncOverlayStackToScopeTasks');
    assert.ok(batchSrc.includes('_previewPlaying: Boolean(isMediaPlaying)'), 'All rendered overlays must receive _previewPlaying');
    assert.ok(batchSrc.includes('window.reelsSyncChristmasIconAdjustUI()'), 'reelsSelectTask must refresh Christmas icon adjust UI');

    // 5) Multi-task / multi-page scope sync + #rop-anim-loop preservation in ReelsOverlayPanel
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    assert.ok(panelSrc.includes('<option value="sway_bell">'), '#rop-anim-loop must include sway_bell');
    assert.ok(panelSrc.includes('<option value="twinkle">'), '#rop-anim-loop must include twinkle');

    const task1 = { id: 't_1', _batchTabId: 'tab_a', overlays: [{ id: 'card_1', type: 'textcard', title_text: 'T1' }] };
    const task2 = { id: 't_2', _batchTabId: 'tab_a', overlays: [{ id: 'card_2', type: 'textcard', title_text: 'T2' }] };
    const tabs = [{ id: 'tab_a', tasks: [task1, task2] }];
    let syncTabCalls = 0;
    let saveCalls = 0;
    const panelSandbox = loadBrowserScript('src/reels-overlay-panel.js', {
        window: {
            ReelsOverlay: RO,
            _reelsState: { tasks: [task1, task2], selectedIdx: 1 },
        },
        document: {
            ...ovSandbox.document,
            getElementById: (id) => (id === 'reels-style-scope' ? { value: 'folder' } : (id === 'rop-style-scope' ? { value: 'folder' } : null)),
            querySelectorAll: () => [],
        },
    });
    panelSandbox._batchTableState = { activeTabId: 'tab_a', tabs };
    panelSandbox._syncTasksToActiveTab = () => { syncTabCalls++; };
    panelSandbox._batchAutoSave = () => { saveCalls++; };
    panelSandbox._syncCurrentOverlayEditorToSelectedTask = () => {
        task2.overlays = [...mgrOverlays];
    };

    const mgrOverlays = [...task2.overlays];
    const fakePanel = Object.create(panelSandbox.window.ReelsOverlayPanel.prototype);
    fakePanel.container = { querySelector: (sel) => (sel === '#rop-style-scope' ? { value: 'folder' } : null) };
    fakePanel.videoCanvas = {
        overlayMgr: { overlays: mgrOverlays },
        addOverlay(ov) { mgrOverlays.push(ov); },
        removeOverlay(id) {
            const idx = mgrOverlays.findIndex(o => o && o.id === id);
            if (idx >= 0) mgrOverlays.splice(idx, 1);
        },
    };
    const addedSticker = { ...RO.createStickerOverlay({ sticker_kind: 'jingle_bell', cta_loop_anim: 'sway_bell' }), id: 'ov_Bell_T2' };
    mgrOverlays.push(addedSticker);
    fakePanel._syncStickerStackToScopeTasks({ source: 'subtitle', structuralChange: true, immediate: true });
    assert.ok(task1.overlays.some(o => o.type === 'sticker' && o.sticker_kind === 'jingle_bell' && o.cta_loop_anim === 'sway_bell'), 'Sticker added on task 2 must sync to task 1');
    assert.ok(task1.overlays.some(o => o.id === 'card_1'), 'Syncing stickers to task 1 must preserve task 1 textcards');
    assert.ok(syncTabCalls > 0 && saveCalls > 0, 'Sticker sync must persist to active tab and batch store');

    // Deleting from task 2 propagates removal across scope while keeping task 1 non-sticker layers
    fakePanel.videoCanvas.removeOverlay(addedSticker.id);
    fakePanel._syncStickerStackToScopeTasks({ source: 'subtitle', structuralChange: true, immediate: true });
    assert.equal(task1.overlays.some(o => o.type === 'sticker'), false, 'Deleting sticker on task 2 removes synced sticker from task 1');
    assert.ok(task1.overlays.some(o => o.id === 'card_1'), 'Task 1 non-sticker layers survive sticker deletion sync');

    // _createTaskFromTemplate retains sticker/decor/intro overlays
    const btSrc = fs.readFileSync(path.join(ROOT, 'src/reels-batch-table.js'), 'utf8');
    assert.ok(btSrc.includes("ov.type === 'sticker'"), '_createTaskFromTemplate must preserve sticker overlays');
});

test('Facebook Reel 1705707007643836 standalone opening effect (fb_yellow_stack_hook): progressive white+yellow italic stack, body sub coordination & DecorPanel UI', () => {
    const ovSandbox = loadBrowserScript('src/reels-overlay.js');
    const RO = ovSandbox.window.ReelsOverlay;

    const hookOv = RO.createIntroCountdownOverlay({ intro_style: 'fb_yellow_stack_hook' });
    assert.equal(hookOv.intro_layout, 'kinetic_stack');
    assert.equal(hookOv.intro_delay_body, false);
    assert.equal(hookOv.end, 4.0);
    assert.equal(hookOv.intro_top_color, '#FFFFFF');
    assert.equal(hookOv.intro_center_color, '#FFE600');
    assert.equal(hookOv.intro_backdrop_scrim, 0);

    // 0s simultaneous intro does not delay voice audio, but suppresses colliding body T-subtitles during [0, 4.0]
    assert.equal(RO.getIntroDelaySec([hookOv]), 0);
    assert.equal(RO.isIntroSuppressingBodySubtitles([hookOv], 1.2), true);
    assert.equal(RO.isIntroSuppressingBodySubtitles([hookOv], 4.5), false);
    // Optional delayed-body mode shifts voice & does not suppress shifted body subtitles
    assert.equal(RO.getIntroDelaySec([{ ...hookOv, intro_delay_body: true }]), 4.0);
    assert.equal(RO.isIntroSuppressingBodySubtitles([{ ...hookOv, intro_delay_body: true }], 1.2), false);

    const drawCalls = [];
    const makeCtx = () => ({
        globalAlpha: 1,
        font: '',
        fillStyle: '#fff',
        strokeStyle: '#000',
        lineWidth: 1,
        lineJoin: 'miter',
        miterLimit: 10,
        textAlign: 'center',
        textBaseline: 'middle',
        shadowColor: 'transparent',
        shadowBlur: 0,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        save() {},
        restore() {},
        translate() {},
        scale() {},
        beginPath() {},
        arc() {},
        fillRect() {},
        strokeText(t) { drawCalls.push({ kind: 'stroke', text: String(t), style: String(this.strokeStyle), lineWidth: this.lineWidth, font: this.font }); },
        fillText(t, x, y) { drawCalls.push({ kind: 'fill', text: String(t), x, y, style: String(this.fillStyle), font: this.font }); },
        measureText: (t) => ({ width: String(t || '').length * 36 }),
    });

    const segs = [{
        start: 0,
        end: 3.8,
        text: "Those who don't skip, but you stop!",
        words: [
            { word: 'Those', start: 0.0, end: 0.4 },
            { word: 'who', start: 0.4, end: 0.8 },
            { word: "don't", start: 0.8, end: 1.3 },
            { word: 'skip,', start: 1.3, end: 1.9 },
            { word: 'but', start: 2.0, end: 2.3 },
            { word: 'you', start: 2.3, end: 2.7 },
            { word: 'stop!', start: 2.8, end: 3.6 },
        ],
    }];

    // Mid beat 1 at t=1.0s ("don't" active): "Those" (white, smaller) + "who" (white) + "don't" (yellow, largest)
    drawCalls.length = 0;
    RO.drawOverlay(makeCtx(), { ...hookOv, _previewPlaying: true, _taskSegments: segs }, 1.0, 1080, 1920);
    const fills = drawCalls.filter(c => c.kind === 'fill');
    assert.deepEqual(fills.map(f => f.text), ['Those', 'who', "don't"]);
    assert.equal(fills[0].style.toUpperCase(), '#FFFFFF');
    assert.equal(fills[1].style.toUpperCase(), '#FFFFFF');
    assert.equal(fills[2].style.toUpperCase(), '#FFE600');
    const px = (f) => parseFloat(String(f.font).match(/([\d.]+)px/)?.[1] || '0');
    assert.ok(px(fills[2]) > px(fills[1]) && px(fills[1]) > px(fills[0]), 'Bottom active yellow focus word must be largest');
    assert.ok(fills[0].font.startsWith('italic 900'), 'Kinetic stack must render in 900 italic font weight');
    assert.ok(drawCalls.some(c => c.kind === 'stroke' && c.text === "don't" && c.style.toUpperCase() === '#000000'), 'Focus word must have black outline');

    // DecorPanel UI exposes fb_yellow_stack_hook & toggles kinetic/ring sections
    const panelSrc = fs.readFileSync(path.join(ROOT, 'src/reels-overlay-panel.js'), 'utf8');
    assert.ok(panelSrc.includes('rdp-intro-kinetic-section'), 'DecorPanel must include rdp-intro-kinetic-section');
    assert.ok(panelSrc.includes('rdp-intro-hook-source') && panelSrc.includes('rdp-intro-hook-text'), 'DecorPanel must include hook source and custom text inputs');
    const secStyles = {};
    const makeFakeSection = (id) => ({ style: { display: '' } });
    secStyles['#rdp-intro-kinetic-section'] = makeFakeSection('#rdp-intro-kinetic-section');
    secStyles['#rdp-intro-ring-section'] = makeFakeSection('#rdp-intro-ring-section');
    const panelSandbox = loadBrowserScript('src/reels-overlay-panel.js', { window: { ReelsOverlay: RO } });
    const decorProto = panelSandbox.window.ReelsDecorPanel.prototype;
    const fakeDecor = Object.create(decorProto);
    fakeDecor.container = {
        querySelector: (sel) => secStyles[sel] || null,
        querySelectorAll: () => [],
    };
    fakeDecor._setVal = () => {};
    fakeDecor._updateIntroBadges = () => {};
    fakeDecor._syncIntroUI(hookOv);
    assert.equal(secStyles['#rdp-intro-kinetic-section'].style.display, 'flex');
    assert.equal(secStyles['#rdp-intro-ring-section'].style.display, 'none');

    const ringOv = RO.createIntroCountdownOverlay({ intro_style: 'xmas_cp01' });
    fakeDecor._syncIntroUI(ringOv);
    assert.equal(secStyles['#rdp-intro-kinetic-section'].style.display, 'none');
    assert.equal(secStyles['#rdp-intro-ring-section'].style.display, 'flex');
});

test('Facebook Reel 29521209597533436 crimson velvet curtain reveal intro (curtain_red_reveal): part_center physics, sweep_up, valance & DecorPanel UI', () => {
    const ovSandbox = loadBrowserScript('src/reels-overlay.js');
    const RO = ovSandbox.window.ReelsOverlay;

    const curtainOv = RO.createIntroCountdownOverlay({ intro_style: 'curtain_red_reveal' });
    assert.equal(curtainOv.intro_layout, 'curtain_reveal');
    assert.equal(curtainOv.intro_curtain_theme, 'crimson_velvet');
    assert.equal(curtainOv.intro_curtain_style, 'part_center');
    assert.equal(curtainOv.intro_curtain_valance, false);
    assert.equal(curtainOv.intro_delay_body, true);
    assert.equal(curtainOv.end, 2.2);

    const drawOps = [];
    const makeCtx = () => {
        const ctx = {
            globalAlpha: 1,
            font: '',
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 1,
            lineJoin: 'miter',
            textAlign: 'left',
            textBaseline: 'alphabetic',
            shadowColor: 'transparent',
            shadowBlur: 0,
            save() {},
            restore() {},
            translate() {},
            scale() {},
            beginPath() { drawOps.push({ op: 'beginPath' }); },
            closePath() {},
            moveTo() {},
            lineTo() {},
            quadraticCurveTo() {},
            clip() {},
            fill() { drawOps.push({ op: 'fill', alpha: ctx.globalAlpha }); },
            stroke() { drawOps.push({ op: 'stroke', strokeStyle: ctx.strokeStyle }); },
            fillRect(x, y, w, h) { drawOps.push({ op: 'fillRect', x, y, w, h, alpha: ctx.globalAlpha }); },
            fillText(t) { drawOps.push({ op: 'fillText', text: String(t), alpha: ctx.globalAlpha }); },
            strokeText() {},
            createLinearGradient(x0, y0, x1, y1) {
                const stops = [];
                drawOps.push({ op: 'grad', x0, y0, x1, y1, stops });
                return { addColorStop(off, col) { stops.push([off, col]); } };
            },
            measureText: (t) => ({ width: String(t || '').length * 20 }),
        };
        return ctx;
    };

    // 1) Playback t=0.05s starts fully closed at solid opaque alpha (~1.0), spanning left [0..542] & right [538..1080]
    drawOps.length = 0;
    RO.drawOverlay(makeCtx(), { ...curtainOv, _previewPlaying: true }, 0.05, 1080, 1920);
    const closedRects = drawOps.filter(o => o.op === 'fillRect' && o.w > 400 && o.h === 1920);
    assert.ok(closedRects.length >= 2, 'Closed curtain renders left and right half panels');
    assert.ok(closedRects.every(r => r.alpha >= 0.99), 'Curtain must start 100% opaque without semi-transparent fade-in');

    // 2) Mid-open t=1.2s parts curtains symmetrically toward edges & leaves center stage clear
    drawOps.length = 0;
    RO.drawOverlay(makeCtx(), { ...curtainOv, _previewPlaying: true }, 1.2, 1080, 1920);
    const midPanelGrads = drawOps.filter(o => o.op === 'grad' && o.stops.some(s => s[1] === '#C9181D'));
    assert.equal(midPanelGrads.length, 2, 'Two crimson velvet pleat gradients (left + right) render while parting');
    const leftGradWidth = midPanelGrads[0].x1;
    assert.ok(leftGradWidth > 40 && leftGradWidth < 460, `Left panel recedes as curtain parts (got x1=${leftGradWidth})`);

    // 3) sweep_up mode with gold valance & optional opening title
    drawOps.length = 0;
    RO.drawOverlay(makeCtx(), {
        ...curtainOv,
        _previewPlaying: true,
        intro_curtain_style: 'sweep_up',
        intro_curtain_valance: true,
        intro_center_text: 'TONIGHT',
    }, 1.0, 1080, 1920);
    const sweepFullWidthRects = drawOps.filter(o => o.op === 'fillRect' && o.w === 1080 && o.h > 100 && o.h < 1900);
    assert.ok(sweepFullWidthRects.length >= 1, 'sweep_up draws rising full-width velvet curtain');
    assert.ok(drawOps.some(o => o.op === 'stroke' && o.strokeStyle === '#FACC15'), 'valance draws gold trim');
    assert.ok(drawOps.some(o => o.op === 'fillText' && o.text === 'TONIGHT'), 'optional curtain headline renders before disappearing');

    // 4) Past end renders nothing
    drawOps.length = 0;
    RO.drawOverlay(makeCtx(), { ...curtainOv, _previewPlaying: true }, 2.3, 1080, 1920);
    assert.equal(drawOps.length, 0, 'After intro.end curtain stops drawing completely');

    // 5) DecorPanel UI shows curtain section and hides ring/kinetic/shared sections
    const panelSandbox = loadBrowserScript('src/reels-overlay-panel.js', { window: { ReelsOverlay: RO } });
    const fakeDecor = Object.create(panelSandbox.window.ReelsDecorPanel.prototype);
    const secStyles = {
        '#rdp-intro-kinetic-section': { style: { display: '' } },
        '#rdp-intro-curtain-section': { style: { display: '' } },
        '#rdp-intro-ring-section': { style: { display: '' } },
        '#rdp-intro-shared-layout-section': { style: { display: '' } },
    };
    fakeDecor.container = { querySelector: (sel) => secStyles[sel] || null, querySelectorAll: () => [] };
    fakeDecor._setVal = () => {};
    fakeDecor._updateIntroBadges = () => {};
    fakeDecor._syncIntroUI(curtainOv);
    assert.equal(secStyles['#rdp-intro-curtain-section'].style.display, 'flex');
    assert.equal(secStyles['#rdp-intro-kinetic-section'].style.display, 'none');
    assert.equal(secStyles['#rdp-intro-ring-section'].style.display, 'none');
    assert.equal(secStyles['#rdp-intro-shared-layout-section'].style.display, 'none');
});
