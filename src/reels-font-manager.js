/**
 * reels-font-manager.js — 字体管理器
 * 
 * 移植自 AutoSub_v8 FontManager:
 *   - 内嵌字体扫描与注册 (使用 CSS @font-face)
 *   - 白名单过滤
 *   - 字体列表管理
 *   - 字体缓存
 * 
 * 在 Electron 环境通过 IPC 扫描 fonts/ 目录；
 * 在浏览器环境使用 Google Fonts CDN 或本地字体列表。
 */

// ═══════════════════════════════════════════════════════
// 1. Default Font Configuration
// ═══════════════════════════════════════════════════════

const DEFAULT_FONT_FAMILY = 'Arial';

// 内置字体白名单 — 可安全使用的字体
const BUILTIN_FONTS = [
    // 英文
    'Arial', 'Helvetica', 'Impact', 'Georgia', 'Verdana',
    'Times New Roman', 'Courier New', 'Comic Sans MS',
    // 中文
    'Microsoft YaHei', '微软雅黑', 'SimHei', '黑体',
    'SimSun', '宋体', 'KaiTi', '楷体',
    'STHeiti', 'STSong', 'STKaiti', 'STFangsong',
    'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Noto Serif SC',
    // 日文
    'MS Gothic', 'Yu Gothic', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP',
    // 韩文
    'Malgun Gothic', 'Noto Sans KR',
    // 设计字体
    'Montserrat', 'Roboto', 'Open Sans', 'Lato', 'Oswald', 'Poppins',
    'Raleway', 'Inter', 'Outfit', 'Bebas Neue', 'Playfair Display', 'Crimson Pro',
];

// Google Fonts CDN 可加载的字体列表（按需懒加载，~200+ 热门字体）
const GOOGLE_FONTS = [
    // ── Sans-Serif 无衬线 (热门) ──
    'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins',
    'Inter', 'Raleway', 'Outfit', 'Oswald', 'Nunito',
    'Nunito Sans', 'Source Sans 3', 'Ubuntu', 'Rubik', 'Work Sans',
    'Quicksand', 'Mulish', 'Karla', 'Barlow', 'DM Sans',
    'Manrope', 'Figtree', 'Lexend', 'Space Grotesk', 'Sora',
    'Albert Sans', 'Plus Jakarta Sans', 'Red Hat Display', 'Urbanist', 'Jost',
    'Exo 2', 'Archivo', 'Archivo Black', 'Cabin', 'Hind', 'Mukta',
    'Overpass', 'Titillium Web', 'Fira Sans', 'Signika', 'Catamaran',
    'PT Sans', 'Roboto Condensed', 'Noto Sans Display', 'IBM Plex Sans',
    'IBM Plex Serif', 'Roboto Flex', 'Roboto Serif', 'Arimo', 'Tinos',
    'Play', 'Russo One', 'Cuprum', 'Literata', 'Noto Sans Tagalog',
    'Noto Sans Arabic', 'Noto Naskh Arabic', 'Noto Kufi Arabic',
    'Cairo', 'Tajawal', 'Almarai', 'Amiri', 'Changa',
    'El Messiri', 'Lateef', 'Scheherazade New', 'Reem Kufi',
    'Mada', 'Markazi Text', 'IBM Plex Sans Arabic', 'Readex Pro',
    'Noto Sans', 'Noto Sans SC', 'Noto Sans JP', 'Noto Sans KR',
    'Noto Sans TC', 'Noto Sans HK',
    // ── Sans-Serif 无衬线 (更多) ──
    'Kanit', 'Josefin Sans', 'Libre Franklin', 'Asap', 'Dosis',
    'IBM Plex Sans', 'Yanone Kaffeesatz', 'Abel', 'Saira', 'Teko',
    'Prompt', 'Varela Round', 'Questrial', 'Archivo Narrow', 'Armata',
    'Public Sans', 'Nanum Gothic', 'Red Hat Text', 'Chivo', 'Heebo',
    'Assistant', 'Encode Sans', 'Encode Sans Condensed', 'Pathway Gothic One', 'Zen Kaku Gothic New',
    'Readex Pro', 'Atkinson Hyperlegible', 'Wix Madefor Display', 'Schibsted Grotesk', 'Geist',
    'Instrument Sans', 'Onest', 'Afacad', 'Bricolage Grotesque', 'Funnel Sans',
    // ── Serif 衬线 ──
    'Playfair Display', 'Crimson Pro', 'Lora', 'Merriweather', 'Libre Baskerville',
    'Noto Serif', 'Noto Serif SC', 'Noto Serif JP', 'Noto Serif KR',
    'Source Serif 4', 'EB Garamond', 'Cormorant Garamond', 'Bitter',
    'DM Serif Display', 'Libre Caslon Display', 'Gelasio', 'Spectral',
    'Brygada 1918', 'Vollkorn', 'Cardo',
    'PT Serif', 'Roboto Slab', 'Arvo', 'Domine', 'Rokkitt',
    'Josefin Slab', 'Slabo 27px', 'Noticia Text', 'Unna', 'Faustina',
    'Alegreya', 'Crimson Text', 'Old Standard TT', 'Sorts Mill Goudy',
    'Cormorant', 'Fraunces', 'Newsreader', 'Instrument Serif', 'Young Serif',
    'Bodoni Moda', 'Prata', 'Lora', 'Gentium Book Plus',
    // ── Display 标题/装饰 ──
    'Bebas Neue', 'Anton', 'Righteous', 'Fredoka', 'Lilita One',
    'Bowlby One SC', 'Black Ops One', 'Bungee', 'Orbitron',
    'Abril Fatface', 'Alfa Slab One', 'Comfortaa', 'Passion One',
    'Baloo 2', 'Bangers', 'Russo One', 'Press Start 2P',
    'Lobster Two', 'Fugaz One', 'Concert One', 'Bungee Shade',
    'Monoton', 'Fascinate Inline', 'Rampart One', 'Shrikhand',
    'Bree Serif', 'Crete Round', 'Patua One', 'Ultra',
    'Secular One', 'Staatliches', 'Francois One', 'Passion One',
    'Graduate', 'Oleo Script', 'Modak', 'Faster One',
    'Chango', 'Bungee Inline', 'Silkscreen', 'Rubik Mono One',
    'Rubik Glitch', 'Rubik Wet Paint', 'Rubik Burned', 'Rubik Dirt',
    'Climate Crisis', 'Nabla', 'Bagel Fat One', 'Honk',
    // ── Handwriting 手写/书法 ──
    'Permanent Marker', 'Pacifico', 'Lobster', 'Satisfy', 'Dancing Script',
    'Caveat', 'Kalam', 'Patrick Hand', 'Indie Flower', 'Shadows Into Light',
    'Amatic SC', 'Great Vibes', 'Sacramento', 'Yellowtail', 'Allura',
    'Courgette', 'Kaushan Script', 'Tangerine', 'Alex Brush', 'Pinyon Script',
    'Cookie', 'Damion', 'Mr Dafoe', 'Marck Script', 'Handlee',
    'Architects Daughter', 'Covered By Your Grace', 'Rock Salt', 'Reenie Beanie',
    'Homemade Apple', 'Just Another Hand', 'Nothing You Could Do', 'Cedarville Cursive',
    'Gloria Hallelujah', 'Gochi Hand', 'Coming Soon', 'La Belle Aurore',
    'Pangolin', 'Sue Ellen Francisco', 'Schoolbell', 'Short Stack',
    // ── Monospace 等宽 ──
    'Fira Code', 'JetBrains Mono', 'Source Code Pro', 'Roboto Mono',
    'Space Mono', 'IBM Plex Mono', 'Ubuntu Mono',
    'Inconsolata', 'PT Mono', 'Anonymous Pro', 'Cousine',
    'Share Tech Mono', 'Cutive Mono', 'Major Mono Display', 'Xanh Mono',
    'Azeret Mono', 'Red Hat Mono', 'Martian Mono', 'Geist Mono',
    // ── 中文/CJK 特色 ──
    'LXGW WenKai', 'LXGW WenKai TC', 'Ma Shan Zheng',
    'ZCOOL XiaoWei', 'ZCOOL QingKe HuangYou', 'ZCOOL KuaiLe',
    'Liu Jian Mao Cao', 'Long Cang', 'Zhi Mang Xing',
    'Noto Sans Mono', 'Noto Serif Display',
];

// 默认展开时优先展示的热门 Google 字体。
// 覆盖英文短视频常用、欧洲语言、俄语/西里尔文、希腊语、菲律宾语、阿拉伯语等场景。
const POPULAR_GOOGLE_FONTS = [
    'Roboto', 'Open Sans', 'Montserrat', 'Lato', 'Poppins',
    'Inter', 'Oswald', 'Nunito Sans', 'Nunito', 'Raleway',
    'Rubik', 'Ubuntu', 'Fira Sans', 'Source Sans 3', 'DM Sans',
    'Work Sans', 'Merriweather', 'Playfair Display', 'Lora', 'Roboto Slab',
    'Bebas Neue', 'Anton', 'Archivo Black', 'Barlow', 'Barlow Condensed',
    'Roboto Condensed', 'PT Sans', 'PT Serif', 'PT Mono', 'Noto Sans',
    'Noto Serif', 'Noto Sans Display', 'Noto Serif Display', 'Noto Sans Mono', 'IBM Plex Sans',
    'IBM Plex Serif', 'IBM Plex Mono', 'Manrope', 'Exo 2', 'Comfortaa',
    'Russo One', 'Play', 'Cuprum', 'Cormorant Garamond', 'Cormorant',
    'Caveat', 'Pacifico', 'Rubik Mono One', 'Tinos', 'Arimo',
    'Roboto Flex', 'Roboto Serif', 'Roboto Mono', 'Libre Franklin', 'Karla',
    'Mulish', 'Quicksand', 'Lexend', 'Jost', 'Urbanist',
    'Outfit', 'Figtree', 'Space Grotesk', 'Sora', 'Plus Jakarta Sans',
    'Red Hat Display', 'Albert Sans', 'Overpass', 'Titillium Web', 'Kanit',
    'Josefin Sans', 'Asap', 'Dosis', 'Cabin', 'Hind',
    'Mukta', 'Signika', 'Catamaran', 'Public Sans', 'Heebo',
    'Assistant', 'Encode Sans', 'Readex Pro', 'Atkinson Hyperlegible', 'Instrument Sans',
    'Onest', 'Afacad', 'Bricolage Grotesque', 'Funnel Sans', 'Libre Baskerville',
    'Crimson Pro', 'EB Garamond', 'Bitter', 'DM Serif Display', 'Gelasio',
    'Spectral', 'Vollkorn', 'Cardo', 'Arvo', 'Domine',
    'Rokkitt', 'Alegreya', 'Crimson Text', 'Fraunces', 'Newsreader',
    'Instrument Serif', 'Young Serif', 'Bodoni Moda', 'Prata', 'Abril Fatface',
    'Alfa Slab One', 'Lilita One', 'Passion One', 'Bangers', 'Lobster',
    'Lobster Two', 'Permanent Marker', 'Satisfy', 'Dancing Script', 'Kalam',
    'Indie Flower', 'Great Vibes', 'Allura', 'Courgette', 'Cookie',
    // 欧洲语言 / 拉丁扩展 / 希腊语 / 西里尔文常用
    'Noto Sans', 'Noto Serif', 'Noto Sans Display', 'Noto Serif Display',
    'Noto Sans Mono', 'Noto Sans Georgian', 'Noto Serif Georgian',
    'Noto Sans Armenian', 'Noto Serif Armenian', 'Noto Sans Hebrew',
    'Noto Serif Hebrew', 'Noto Sans Greek', 'Noto Serif Greek',
    'Noto Sans Devanagari', 'Noto Sans Tagalog',
    'PT Sans', 'PT Serif', 'PT Mono', 'Ubuntu', 'Ubuntu Condensed',
    'Ubuntu Mono', 'Fira Sans', 'Fira Sans Condensed', 'Fira Sans Extra Condensed',
    'Fira Code', 'Roboto Condensed', 'Roboto Mono', 'Roboto Slab',
    'Literata', 'Spectral', 'Alegreya Sans', 'Alegreya',
    'Merriweather Sans', 'Source Serif 4', 'IBM Plex Sans',
    'IBM Plex Serif', 'IBM Plex Mono', 'Libre Franklin', 'Libre Baskerville',
    'Libre Caslon Text', 'Libre Caslon Display', 'Bitter', 'Vollkorn',
    'Cormorant', 'Cormorant Garamond', 'Cormorant Infant', 'Cormorant SC',
    'Cormorant Unicase', 'Gelasio', 'Old Standard TT', 'Neucha',
    'Philosopher', 'Forum', 'Oranienbaum', 'Poiret One', 'Yeseva One',
    'Tenor Sans', 'Jura', 'Didact Gothic', 'Scada', 'Podkova',
    'Prata', 'Kelly Slab', 'Pangolin', 'Bad Script', 'Marck Script',
    'Comfortaa', 'Exo 2', 'Play', 'Russo One', 'Cuprum',
    'Rubik Mono One', 'Rubik Glitch', 'Rubik Beastly', 'Sofia Sans',
    'Sofia Sans Condensed', 'Sofia Sans Extra Condensed', 'Sofia Sans Semi Condensed',
    'Ysabeau', 'Ysabeau SC', 'Ysabeau Infant', 'Ysabeau Office',
    'Commissioner', 'Afacad', 'Onest', 'Geologica', 'Wix Madefor Display',
    'Wix Madefor Text', 'Geist', 'Geist Mono', 'Manrope',
    // 阿拉伯语 / 中东语言常用
    'Noto Sans Arabic', 'Noto Naskh Arabic', 'Noto Kufi Arabic',
    'Cairo', 'Tajawal', 'Almarai', 'Amiri', 'Changa',
    'El Messiri', 'Lateef', 'Scheherazade New', 'Reem Kufi',
    'Reem Kufi Fun', 'Reem Kufi Ink', 'Mada', 'Markazi Text',
    'IBM Plex Sans Arabic', 'Readex Pro', 'Aref Ruqaa', 'Aref Ruqaa Ink',
    'Lalezar', 'Lemonada', 'Rakkas', 'Mirza', 'Katibeh',
    'Harmattan', 'Noto Nastaliq Urdu', 'Noto Sans Hebrew',
    'Noto Serif Hebrew',
];

// ═══════════════════════════════════════════════════════
// 2. FontManager Class
// ═══════════════════════════════════════════════════════

const UNIFIED_FONT_SELECT_IDS = [
    'reels-font-family',
    'reels-fullpage-typewriter-title-font',
    'rop-font',
    'rop-title-font',
    'rop-body-font',
    'rop-footer-font',
    'rop-scroll-title-font',
    'rop-scroll-font',
];

class ReelsFontManager {
    constructor() {
        this._registered = false;
        this._registerPromise = null;
        this._allowedFonts = [...BUILTIN_FONTS];
        this._customFonts = [];   // 用户上传的自定义字体
        this._systemFonts = new Set();   // 系统扫描到的字体
        this._embeddedFonts = new Set(); // 内置 assets/fonts 字体
        this._registeredEmbeddedPaths = new Set();
        this._fontCache = {};
        this._loadedGoogleFonts = new Set();
        this._loadingGoogleFontPromises = new Map();
        this._injectedStylesheetUrls = new Set();
        this._fontVariants = new Map(); // family -> Set of "weight|style"
        this._catalogSignature = '';
        this._lastDirCheckAt = 0;

        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('focus', () => {
                if (this._registered) {
                    this.refreshCatalogIfChanged().catch(() => {});
                }
            });
        }
    }

    /**
     * 注册字体系统。
     * - 白名单字体：通过 Canvas 检测系统是否已安装
     * - Electron 环境：扫描 fonts/ 目录 + 系统字体目录
     *   - 系统字体：直接加入白名单（已安装，无需 FontFace 注册）
     *   - 内置字体：通过 FontFace API 注册（确保可用）
     */
    async register() {
        if (this._registered) {
            await this.refreshCatalogIfChanged();
            return true;
        }
        if (this._registerPromise) {
            return this._registerPromise;
        }
        this._registerPromise = this._doRegister().finally(() => {
            this._registerPromise = null;
        });
        return this._registerPromise;
    }

    async _doRegister() {
        // 检测白名单字体可用性
        const available = [];
        for (const font of BUILTIN_FONTS) {
            if (this._isFontAvailable(font)) {
                available.push(font);
                this._recordVariant(font, '400', 'normal');
                this._recordVariant(font, '700', 'normal');
            }
        }

        // 加载 Electron 扫描的字体 (内置 + 系统)
        if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.scanFonts) {
            try {
                const scannedFonts = await window.electronAPI.scanFonts();
                if (Array.isArray(scannedFonts)) {
                    const systemFamilies = new Set();
                    const embeddedFonts = [];

                    for (const fontInfo of scannedFonts) {
                        if (!fontInfo.family) continue;
                        if (fontInfo.system) {
                            // 系统字体 — 直接加入白名单，不加载 FontFace
                            systemFamilies.add(fontInfo.family);
                            this._systemFonts.add(fontInfo.family);
                            this._recordVariant(fontInfo.family, fontInfo.weight || '400', fontInfo.style || 'normal');
                        } else {
                            // 内置字体 — 需要 FontFace 注册
                            embeddedFonts.push(fontInfo);
                        }
                    }

                    // 批量添加系统字体到白名单
                    for (const family of systemFamilies) {
                        if (!available.includes(family)) {
                            available.push(family);
                        }
                    }

                    // 逐个注册内置字体
                    for (const fontInfo of embeddedFonts) {
                        await this._registerLocalFont(fontInfo);
                        this._embeddedFonts.add(fontInfo.family);
                        if (fontInfo.family && !available.includes(fontInfo.family)) {
                            available.push(fontInfo.family);
                        }
                    }

                    console.log(`[FontManager] ${systemFamilies.size} system font families, ${embeddedFonts.length} embedded fonts loaded`);
                }
            } catch (err) {
                console.warn('[FontManager] Failed to scan fonts:', err);
            }
        }

        const merged = new Set(available.length > 0 ? available : [...BUILTIN_FONTS]);
        // Always expose hardcoded Google-font families in selector
        for (const gf of GOOGLE_FONTS) merged.add(gf);

        // ── 动态拉取 Google Fonts 全量列表 (1700+) ──
        const dynamicGoogleFonts = await this._fetchGoogleFontsCatalog();
        if (dynamicGoogleFonts.length > 0) {
            this._googleFontsFull = new Set(dynamicGoogleFonts);
            for (const gf of dynamicGoogleFonts) merged.add(gf);
        } else {
            this._googleFontsFull = new Set(GOOGLE_FONTS);
        }

        this._allowedFonts = Array.from(merged);
        this._registered = true;
        this._lastDirCheckAt = Date.now();
        this._catalogSignature = this.getAllFonts().join('|');
        this.refreshAllFontSelects();

        const googleCount = this._googleFontsFull ? this._googleFontsFull.size : GOOGLE_FONTS.length;
        console.log(`[FontManager] ✅ Registered ${this._allowedFonts.length} fonts total — 💻 系统:${this._systemFonts.size} | 🌐 Google:${googleCount} | 📦 内置:${this._embeddedFonts.size} | 📤 自定义:${this._customFonts.length}`);
        return true;
    }

    /**
     * 检查字体目录是否有新增/变化，并在变化时自动刷新所有字体选择器（不会重新扫描 Windows 系统字体）。
     */
    async refreshCatalogIfChanged(force = false) {
        const now = Date.now();
        if (!force && now - this._lastDirCheckAt < 3000) return false;
        this._lastDirCheckAt = now;

        if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.scanFonts === 'function') {
            try {
                const scannedFonts = await window.electronAPI.scanFonts({ skipSystemRescan: true });
                if (Array.isArray(scannedFonts)) {
                    let addedLocal = false;
                    for (const fontInfo of scannedFonts) {
                        if (!fontInfo || !fontInfo.family) continue;
                        if (fontInfo.system) {
                            if (!this._systemFonts.has(fontInfo.family)) {
                                this._systemFonts.add(fontInfo.family);
                                if (!this._allowedFonts.includes(fontInfo.family)) {
                                    this._allowedFonts.push(fontInfo.family);
                                }
                                this._recordVariant(fontInfo.family, fontInfo.weight || '400', fontInfo.style || 'normal');
                            }
                        } else {
                            if (!this._registeredEmbeddedPaths.has(fontInfo.path)) {
                                await this._registerLocalFont(fontInfo);
                                addedLocal = true;
                            }
                            if (!this._embeddedFonts.has(fontInfo.family)) {
                                this._embeddedFonts.add(fontInfo.family);
                                addedLocal = true;
                            }
                            if (!this._allowedFonts.includes(fontInfo.family)) {
                                this._allowedFonts.push(fontInfo.family);
                                addedLocal = true;
                            }
                        }
                    }
                    const nextSig = this.getAllFonts().join('|');
                    if (addedLocal || nextSig !== this._catalogSignature) {
                        this._catalogSignature = nextSig;
                        this.refreshAllFontSelects();
                        return true;
                    }
                }
            } catch (err) {
                console.warn('[FontManager] refreshCatalogIfChanged failed:', err);
            }
        }
        return false;
    }

    /**
     * 从 Google Fonts 公开 API 拉取全量字体列表 (~1700+)。
     * 结果缓存到 localStorage，7天内不重复请求。
     * 离线或请求失败时返回空数组（回退到硬编码列表）。
     */
    async _fetchGoogleFontsCatalog() {
        const CACHE_KEY = 'gfonts_catalog';
        const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7天

        // 1. 尝试从缓存读取
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const { ts, fonts } = JSON.parse(cached);
                if (Date.now() - ts < CACHE_TTL && Array.isArray(fonts) && fonts.length > 100) {
                    console.log(`[FontManager] Google Fonts 目录缓存命中: ${fonts.length} 个字体`);
                    return fonts;
                }
            }
        } catch { /* ignore parse errors */ }

        // 2. 离线时跳过
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            return [];
        }

        // 3. 从 Google Fonts API 拉取
        try {
            let text;
            if (window.electronAPI && typeof window.electronAPI.fetchGoogleFonts === 'function') {
                text = await window.electronAPI.fetchGoogleFonts();
            } else {
                const resp = await fetch('https://fonts.google.com/metadata/fonts', {
                    signal: AbortSignal.timeout(8000),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                text = await resp.text();
            }
            // Google Fonts metadata 前面有 )]}' 安全前缀，需要去掉
            const jsonStr = text.replace(/^\)\]\}'\n?/, '');
            const data = JSON.parse(jsonStr);

            let fontFamilies = [];
            if (data.familyMetadataList && Array.isArray(data.familyMetadataList)) {
                fontFamilies = data.familyMetadataList.map(f => f.family).filter(Boolean);
            }

            if (fontFamilies.length > 100) {
                // 缓存到 localStorage
                try {
                    localStorage.setItem(CACHE_KEY, JSON.stringify({
                        ts: Date.now(),
                        fonts: fontFamilies,
                    }));
                } catch { /* quota exceeded — ignore */ }
                console.log(`[FontManager] 🌐 Google Fonts 全量目录: ${fontFamilies.length} 个字体已加载`);
                return fontFamilies;
            }
        } catch (err) {
            console.warn(`[FontManager] Google Fonts 目录拉取失败:`, err.message);
        }

        return [];
    }

    /**
     * 检测某字体是否在系统中可用 (通过 Canvas fallback 测量)。
     */
    _isFontAvailable(fontFamily) {
        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const testStr = 'abcdefghijklmnopqrstuvwxyz0123456789';

            ctx.font = `72px monospace`;
            const baselineWidth = ctx.measureText(testStr).width;

            ctx.font = `72px "${fontFamily}", monospace`;
            const testWidth = ctx.measureText(testStr).width;

            return testWidth !== baselineWidth;
        } catch {
            return false;
        }
    }

    /**
     * 通过 @font-face 注册本地字体文件。
     */
    async _registerLocalFont(fontInfo) {
        if (!fontInfo.path || !fontInfo.family) return;
        if (this._registeredEmbeddedPaths.has(fontInfo.path)) {
            if (!this._allowedFonts.includes(fontInfo.family)) {
                this._allowedFonts.push(fontInfo.family);
            }
            this._recordVariant(fontInfo.family, String(fontInfo.weight || '400'), String(fontInfo.style || 'normal'));
            return;
        }
        try {
            const fontUrl = (window.electronAPI && window.electronAPI.toFileUrl)
                ? window.electronAPI.toFileUrl(fontInfo.path)
                : fontInfo.path;

            const descriptors = {};
            if (fontInfo.weight) descriptors.weight = String(fontInfo.weight);
            if (fontInfo.style) descriptors.style = String(fontInfo.style);
            const fontFace = new FontFace(fontInfo.family, `url("${fontUrl}")`, descriptors);
            await fontFace.load();
            document.fonts.add(fontFace);
            this._registeredEmbeddedPaths.add(fontInfo.path);

            if (!this._allowedFonts.includes(fontInfo.family)) {
                this._allowedFonts.push(fontInfo.family);
            }
            this._recordVariant(fontInfo.family, descriptors.weight || '400', descriptors.style || 'normal');
        } catch (err) {
            console.warn(`[FontManager] Failed to load font: ${fontInfo.family}`, err);
        }
    }

    /**
     * 按需从 Google Fonts 加载字体（带内存与样式表缓存、并发去重）。
     * 仅在联网且字体未通过系统/本地注册时才从 CDN 加载。
     */
    async loadGoogleFont(fontFamily) {
        if (!fontFamily) return;
        fontFamily = String(fontFamily).trim();
        if (!fontFamily || fontFamily.includes(',')) return;
        if (this._loadedGoogleFonts.has(fontFamily)) return;
        if (this._loadingGoogleFontPromises.has(fontFamily)) {
            return this._loadingGoogleFontPromises.get(fontFamily);
        }

        // 允许加载硬编码列表或动态拉取的全量目录中的字体
        const isGoogleFont = GOOGLE_FONTS.includes(fontFamily) ||
            (this._googleFontsFull && this._googleFontsFull.has(fontFamily));
        if (!isGoogleFont) return;

        // 如果已通过系统/内置/上传字体注册，无需从 CDN 加载
        if (this._customFonts.includes(fontFamily) || this._systemFonts.has(fontFamily) || this._embeddedFonts.has(fontFamily) || this._isFontAvailable(fontFamily)) {
            this._loadedGoogleFonts.add(fontFamily);
            return;
        }

        // 离线时跳过（避免 Electron 中的 MIME type 报错）
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            console.warn(`[FontManager] Offline, skipping Google Font: ${fontFamily}`);
            return;
        }

        const loadPromise = (async () => {
            try {
                const encoded = fontFamily.replace(/ /g, '+');
                try {
                    await this._injectGoogleFontStylesheet(`https://fonts.googleapis.com/css2?family=${encoded}:wght@100;200;300;400;500;600;700;800;900&display=swap`);
                } catch (_) {
                    // 降级：部分单字重字体（如 Anton, Bebas Neue）不支持 wght 范围，使用默认无参数请求
                    await this._injectGoogleFontStylesheet(`https://fonts.googleapis.com/css2?family=${encoded}&display=swap`);
                }

                if (typeof document !== 'undefined' && document.fonts && typeof document.fonts.load === 'function') {
                    await Promise.race([
                        Promise.all(['400', '700'].map((weight) =>
                            document.fonts.load(`${weight} 16px "${fontFamily}"`).catch(() => {})
                        )),
                        new Promise(r => setTimeout(r, 1500)),
                    ]);
                }
                this._loadedGoogleFonts.add(fontFamily);

                if (!this._allowedFonts.includes(fontFamily)) {
                    this._allowedFonts.push(fontFamily);
                }
                for (const w of ['100', '200', '300', '400', '500', '600', '700', '800', '900']) {
                    this._recordVariant(fontFamily, w, 'normal');
                    this._recordVariant(fontFamily, w, 'italic');
                }

                console.log(`[FontManager] Loaded Google Font: ${fontFamily}`);
            } catch (err) {
                console.warn(`[FontManager] Failed to load Google Font: ${fontFamily}`, err);
            } finally {
                this._loadingGoogleFontPromises.delete(fontFamily);
            }
        })();

        this._loadingGoogleFontPromises.set(fontFamily, loadPromise);
        return loadPromise;
    }

    /**
     * 辅助插入 Google Fonts CSS 规则并等待加载（复用已注入的 link 标签）
     */
    _injectGoogleFontStylesheet(url) {
        if (this._injectedStylesheetUrls.has(url)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            if (typeof document === 'undefined' || !document.head) return resolve();
            const existing = document.head.querySelector(`link[rel="stylesheet"][href="${url}"]`);
            if (existing) {
                this._injectedStylesheetUrls.add(url);
                return resolve();
            }
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = url;
            link.onload = () => {
                this._injectedStylesheetUrls.add(url);
                resolve();
            };
            link.onerror = () => {
                link.remove();
                reject(new Error(`Google Fonts stylesheet failed: ${url}`));
            };
            document.head.appendChild(link);
        });
    }

    /**
     * 从任务配置中深度提取所有涉及的字体名称（字幕、覆层、富文本、段落覆盖、水印等）。
     */
    collectFonts({ style, segments, overlays, watermarks, cover } = {}) {
        const fonts = new Set();
        if (style && style.font_family) fonts.add(style.font_family);
        if (Array.isArray(segments)) {
            for (const seg of segments) {
                if (!seg) continue;
                const segStyle = seg.style_override || seg.subtitle_style;
                if (segStyle && segStyle.font_family) fonts.add(segStyle.font_family);
                if (Array.isArray(seg.styled_ranges)) {
                    for (const r of seg.styled_ranges) {
                        if (r && r.font_family) fonts.add(r.font_family);
                    }
                }
            }
        }
        const scanOverlays = (ovList) => {
            if (!Array.isArray(ovList)) return;
            for (const ov of ovList) {
                if (!ov || ov.disabled) continue;
                if (ov.font_family) fonts.add(ov.font_family);
                if (ov.title_font_family) fonts.add(ov.title_font_family);
                if (ov.body_font_family) fonts.add(ov.body_font_family);
                if (ov.footer_font_family) fonts.add(ov.footer_font_family);
            }
        };
        scanOverlays(overlays);
        if (cover && cover.enabled) {
            scanOverlays(cover.overlays);
        }
        if (Array.isArray(watermarks)) {
            for (const wm of watermarks) {
                if (wm && wm.font_family) fonts.add(wm.font_family);
            }
        }
        return Array.from(fonts).filter(Boolean);
    }

    /**
     * 确保字体系统已注册并完全预加载指定字体（含本地注册与 Google Fonts 加载 + document.fonts.ready）。
     */
    async ensureFontsLoaded(fonts = []) {
        if (!this._registered) {
            try {
                await this.register();
            } catch (e) {
                console.warn('[FontManager] register failed:', e);
            }
        }
        const list = Array.isArray(fonts) ? fonts : [fonts];
        for (const font of list) {
            if (!font) continue;
            try {
                await this.loadGoogleFont(font);
            } catch (e) {
                console.warn(`[FontManager] Failed to preload font "${font}":`, e);
            }
        }
        if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
            try {
                await document.fonts.ready;
            } catch (e) {
                console.warn('[FontManager] document.fonts.ready wait error:', e);
            }
        }
    }

    /**
     * 用户上传自定义字体文件。
     */
    async uploadFont(file) {
        if (!file) return null;

        try {
            const buffer = await file.arrayBuffer();
            // 从文件名推断 family name
            const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
            const familyName = baseName.charAt(0).toUpperCase() + baseName.slice(1);

            const fontFace = new FontFace(familyName, buffer, { weight: '100 900', style: 'normal' });
            await fontFace.load();
            document.fonts.add(fontFace);

            if (!this._customFonts.includes(familyName)) {
                this._customFonts.push(familyName);
            }
            if (!this._allowedFonts.includes(familyName)) {
                this._allowedFonts.push(familyName);
            }
            this._recordVariant(familyName, '100 900', 'normal');
            this._catalogSignature = this.getAllFonts().join('|');
            this.refreshAllFontSelects({ [familyName]: familyName });

            console.log(`[FontManager] Uploaded custom font: ${familyName}`);
            return familyName;
        } catch (err) {
            console.error('[FontManager] Failed to upload font:', err);
            return null;
        }
    }

    /**
     * 白名单过滤 — 非白名单字体强制替换为默认字体。
     */
    sanitizeFontFamily(name) {
        if (!name) return DEFAULT_FONT_FAMILY;
        name = String(name).trim();
        if (this._allowedFonts.includes(name)) return name;
        if (this._customFonts.includes(name)) return name;
        return DEFAULT_FONT_FAMILY;
    }

    /**
     * 获取所有可用字体列表。
     */
    getAllFonts() {
        const fonts = new Set([...this._allowedFonts, ...GOOGLE_FONTS, ...this._customFonts]);
        if (this._googleFontsFull) {
            for (const font of this._googleFontsFull) fonts.add(font);
        }
        return Array.from(fonts).sort();
    }

    _recordVariant(fontFamily, weight = '400', style = 'normal') {
        if (!fontFamily) return;
        if (!this._fontVariants.has(fontFamily)) this._fontVariants.set(fontFamily, new Set());
        this._fontVariants.get(fontFamily).add(`${String(weight)}|String(style)`.replace('String(style)', String(style)));
    }

    _weightLabel(weight) {
        const w = parseInt(weight, 10);
        if (!Number.isFinite(w)) return String(weight || 'Regular');
        if (w <= 150) return 'Thin';
        if (w <= 250) return 'ExtraLight';
        if (w <= 350) return 'Light';
        if (w <= 450) return 'Regular';
        if (w <= 550) return 'Medium';
        if (w <= 650) return 'SemiBold';
        if (w <= 750) return 'Bold';
        if (w <= 850) return 'ExtraBold';
        return 'Black';
    }

    getFontWeightEntries(fontFamily, preferStyle = 'normal') {
        const fallbackWeights = ['100', '200', '300', '400', '500', '600', '700', '800', '900'];
        const fallback = fallbackWeights.map(w => ({ value: w, label: this._weightLabel(w), style: 'normal' }));

        const variants = this._fontVariants.get(fontFamily);
        if (!variants || variants.size === 0) return fallback;

        const parsed = [];
        for (const v of variants) {
            const [weightRaw, styleRaw] = String(v).split('|');
            const style = styleRaw || 'normal';
            const weight = String(weightRaw || '400');
            if (weight.includes(' ')) {
                for (const fw of fallbackWeights) {
                    parsed.push({ value: fw, style });
                }
            } else if (/^\d+$/.test(weight)) {
                parsed.push({ value: weight, style });
            }
        }

        if (parsed.length === 0) return fallback;

        const hasPreferredStyle = parsed.some(p => p.style === preferStyle);
        const effective = hasPreferredStyle
            ? parsed.filter(p => p.style === preferStyle)
            : parsed;

        const uniq = new Map();
        for (const p of effective) {
            if (!uniq.has(p.value)) {
                uniq.set(p.value, { value: p.value, label: this._weightLabel(p.value), style: p.style });
            }
        }
        const list = Array.from(uniq.values()).sort((a, b) => Number(a.value) - Number(b.value));
        return list.length > 0 ? list : fallback;
    }

    getFontWeightOptions(fontFamily) {
        return this.getFontWeightEntries(fontFamily, 'normal').map(x => x.value);
    }

    _ensureFontMetadataIndex() {
        if (this._fontMetadataIndex) return this._fontMetadataIndex;
        const index = new Map();
        const fonts = window.FONTS_METADATA && Array.isArray(window.FONTS_METADATA.fonts)
            ? window.FONTS_METADATA.fonts
            : [];
        for (const meta of fonts) {
            if (meta && meta.family) index.set(meta.family.toLowerCase(), meta);
        }
        this._fontMetadataIndex = index;
        return index;
    }

    _getFontMetadata(fontName) {
        if (!fontName) return {};
        const exact = this._ensureFontMetadataIndex().get(String(fontName).toLowerCase());
        if (exact) return exact;
        return this._inferFontMetadata(fontName);
    }

    _inferFontMetadata(fontName) {
        const name = String(fontName || '');
        const lower = name.toLowerCase();
        let category = 'sans';
        if (lower.includes('serif') || ['georgia', 'times new roman', 'lora', 'merriweather', 'garamond', 'baskerville', 'bodoni', 'prata', 'cardo', 'literata'].some(x => lower.includes(x))) category = 'serif';
        if (lower.includes('mono') || lower.includes('code') || lower.includes('console') || lower.includes('courier')) category = 'mono';
        if (lower.includes('script') || lower.includes('hand') || lower.includes('cursive') || ['pacifico', 'lobster', 'caveat', 'kalam', 'satisfy'].some(x => lower.includes(x))) category = 'script';
        if (['anton', 'bebas', 'display', 'black', 'condensed', 'poster', 'bungee', 'orbitron', 'righteous', 'fatface', 'slab', 'impact'].some(x => lower.includes(x))) category = 'display';
        if (/[\u4e00-\u9fff]/.test(name) || lower.includes('noto sans sc') || lower.includes('noto serif sc') || lower.includes('kaiti') || lower.includes('heiti') || lower.includes('song') || lower.includes('wenkai')) category = 'cjk';

        const regions = [];
        if (lower.includes('arabic') || ['cairo', 'tajawal', 'amiri', 'almarai', 'kufi', 'naskh'].some(x => lower.includes(x))) regions.push('arabic');
        if (lower.includes('tagalog')) regions.push('philippines');
        if (category === 'cjk') regions.push('cjk');
        if (['pt ', 'fira', 'ubuntu', 'manrope', 'literata', 'ysabeau', 'cormorant', 'alegreya'].some(x => lower.includes(x))) regions.push('europe');
        if (regions.length === 0) regions.push('us', 'europe');

        const useCases = [];
        if (category === 'sans') useCases.push('subtitle', 'tech');
        if (category === 'serif') useCases.push('luxury', 'narrative');
        if (category === 'display') useCases.push('viral', 'poster');
        if (category === 'script') useCases.push('kids', 'lifestyle');
        if (category === 'mono') useCases.push('tech', 'game');
        if (category === 'cjk') useCases.push('subtitle', 'documentary');

        return {
            family: name,
            category,
            regions: Array.from(new Set(regions)),
            useCases: Array.from(new Set(useCases)),
            popularity: 55,
            aliases: [],
            inferred: true,
        };
    }

    _escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[ch]));
    }

    _getFontSource(font, groups = {}) {
        if (groups.custom && groups.custom.includes(font)) return 'custom';
        if (groups.embedded && groups.embedded.includes(font)) return 'embedded';
        if (groups.system && groups.system.includes(font)) return 'system';
        return 'google';
    }

    _sourceLabel(source) {
        return {
            google: 'Google',
            system: '系统',
            embedded: '内置',
            custom: '上传',
        }[source] || source || '字体';
    }

    /**
     * 获取统一的字体目录分组与显示名称，供 T 字幕、普通文字覆层、文本卡片标题/正文/页脚、滚动字幕共用。
     */
    getUnifiedFontCatalog() {
        const fonts = this.getAllFonts();
        const displayNames = {
            'Microsoft YaHei': '微软雅黑', '微软雅黑': '微软雅黑',
            'SimHei': '黑体', '黑体': '黑体',
            'SimSun': '宋体', '宋体': '宋体',
            'KaiTi': '楷体', '楷体': '楷体',
            'STHeiti': '华文黑体', 'STSong': '华文宋体',
            'STKaiti': '华文楷体', 'STFangsong': '华文仿宋',
            'PingFang SC': '苹方', 'Hiragino Sans GB': '冬青黑体',
            'Noto Sans SC': 'Noto Sans SC (思源黑体)',
            'Noto Serif SC': 'Noto Serif SC (思源宋体)',
            'Noto Sans JP': 'Noto Sans JP (日文黑体)',
            'Noto Sans KR': 'Noto Sans KR (韩文黑体)',
            'Noto Sans TC': 'Noto Sans TC (繁体黑体)',
            'Noto Sans HK': 'Noto Sans HK (香港黑体)',
            'Noto Serif JP': 'Noto Serif JP (日文宋体)',
            'Noto Serif KR': 'Noto Serif KR (韩文宋体)',
            'MS Gothic': 'MS Gothic (日文)', 'Yu Gothic': 'Yu Gothic (日文)',
            'Malgun Gothic': 'Malgun Gothic (韩文)',
            'Hiragino Kaku Gothic ProN': '冬青角ゴシック (日文)',
            'LXGW WenKai': '霞鹜文楷', 'Ma Shan Zheng': '马善政楷',
            'ZCOOL XiaoWei': '站酷小薇', 'ZCOOL QingKe HuangYou': '站酷庆科黄油',
            'Liu Jian Mao Cao': '流建毛草', 'Long Cang': '龙藏',
            'Zhi Mang Xing': '芫荽行书',
            'Crimson Pro': 'Crimson Pro (衬线)',
            'Playfair Display': 'Playfair Display (衬线)',
            'Lora': 'Lora (衬线)', 'Merriweather': 'Merriweather (衬线)',
            'EB Garamond': 'EB Garamond (衬线)',
            'DM Serif Display': 'DM Serif Display (标题)',
            'Bebas Neue': 'Bebas Neue (标题)', 'Anton': 'Anton (标题)',
            'Abril Fatface': 'Abril Fatface (标题)',
            'Fira Code': 'Fira Code (等宽)', 'JetBrains Mono': 'JetBrains Mono (等宽)',
            'Source Code Pro': 'Source Code Pro (等宽)', 'Roboto Mono': 'Roboto Mono (等宽)',
            'Space Mono': 'Space Mono (等宽)', 'IBM Plex Mono': 'IBM Plex Mono (等宽)',
            'Pacifico': 'Pacifico (手写)', 'Dancing Script': 'Dancing Script (手写)',
            'Lobster': 'Lobster (手写)', 'Satisfy': 'Satisfy (手写)',
            'Permanent Marker': 'Permanent Marker (手写)',
            'Press Start 2P': 'Press Start 2P (像素)',
        };

        const googleFontsSet = this._googleFontsFull || new Set(GOOGLE_FONTS);
        const groups = {
            system: [],   // 系统自带
            google: [],   // Google 免费
            embedded: [], // 内置字体
            custom: [],   // 用户上传
        };

        for (const font of fonts) {
            if (this._customFonts.includes(font)) {
                groups.custom.push(font);
            } else if (this._embeddedFonts.has(font)) {
                groups.embedded.push(font);
            } else if (googleFontsSet.has(font) && !this._systemFonts.has(font)) {
                groups.google.push(font);
            } else {
                groups.system.push(font);
            }
        }

        const priority = new Map(POPULAR_GOOGLE_FONTS.map((font, idx) => [font, idx]));
        const popularFirst = (a, b) => {
            const ap = priority.has(a) ? priority.get(a) : Number.POSITIVE_INFINITY;
            const bp = priority.has(b) ? priority.get(b) : Number.POSITIVE_INFINITY;
            if (ap !== bp) return ap - bp;
            return a.localeCompare(b, undefined, { sensitivity: 'base' });
        };

        groups.google.sort(popularFirst);
        groups.embedded.sort(popularFirst);
        groups.system.sort(popularFirst);
        groups.custom.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

        const groupDefs = [
            { key: 'system',   label: '💻 系统字体', emoji: '💻' },
            { key: 'google',   label: '🌐 Google 免费 · 热门优先', emoji: '🌐' },
            { key: 'embedded', label: '📦 内置字体', emoji: '📦' },
            { key: 'custom',   label: '📤 用户上传', emoji: '📤' },
        ];

        return {
            fonts,
            groups,
            groupDefs,
            displayNames,
            signature: fonts.join('|'),
        };
    }

    /**
     * 刷新页面内所有已知的字体选择器（包含 T 字幕、全屏打字机标题、普通文字覆层、文本卡片标题/正文/页脚、滚动字幕标题/正文，以及多面板实例）。
     */
    refreshAllFontSelects(preferredValues = {}) {
        if (typeof document === 'undefined') return;
        const targets = new Set();
        for (const id of UNIFIED_FONT_SELECT_IDS) {
            document.querySelectorAll(`#${id}`).forEach(el => targets.add(el));
        }
        document.querySelectorAll('select.fp-hidden-select').forEach(el => targets.add(el));
        for (const selectEl of targets) {
            const id = selectEl.id || '';
            const val = Object.prototype.hasOwnProperty.call(preferredValues, id)
                ? preferredValues[id]
                : selectEl.value;
            this.refreshFontSelect(selectEl, val);
        }
        if (this._advModal && typeof this._advModal.refreshCatalog === 'function') {
            const catalog = this.getUnifiedFontCatalog();
            this._advModal.refreshCatalog(catalog.displayNames, catalog.groups);
        }
    }

    /**
     * 刷新字体下拉框 — 带分类分组。
     * @param {string|HTMLSelectElement} selectTarget - <select> 的 ID 或实际元素
     * @param {string} currentValue - 当前选中值
     */
    refreshFontSelect(selectTarget, currentValue) {
        // 覆层批量预览会同时打开第二个面板，两个面板都有同名的 select ID。
        // 接收实际元素才能保证刷新的是调用者所在面板，而不是 document 中第一个。
        const select = typeof selectTarget === 'string'
            ? (typeof document !== 'undefined' ? document.getElementById(selectTarget) : null)
            : selectTarget;
        if (!select) return;

        const { fonts, groups, groupDefs, displayNames: DISPLAY_NAMES } = this.getUnifiedFontCatalog();
        const oldValue = select.value;

        // ── 填充隐藏 <select>（保证 form 兼容 + .value 正常工作）──
        select.innerHTML = '';
        const allowEmpty = select.dataset.allowEmpty === 'true';
        // 旧模板里可能保存 CSS 字体候选串，例如
        // "Georgia, Times New Roman, Playfair Display, serif"。Canvas 能正确
        // 使用这串候选字体；选择器也必须保留该值，不能静默回退成 Arial。
        const hasTemplateFontStack = !!currentValue && !fonts.includes(currentValue);
        if (allowEmpty) {
            const empty = document.createElement('option');
            empty.value = '';
            empty.textContent = select.dataset.emptyLabel || '跟随默认字体';
            select.appendChild(empty);
        }
        if (hasTemplateFontStack) {
            const templateFont = document.createElement('option');
            templateFont.value = currentValue;
            const primaryFont = String(currentValue).split(',')[0].trim().replace(/^['"]|['"]$/g, '');
            templateFont.textContent = `${primaryFont || currentValue}（模板字体）`;
            select.appendChild(templateFont);
        }
        for (const { key } of groupDefs) {
            for (const font of groups[key]) {
                const opt = document.createElement('option');
                opt.value = font;
                opt.textContent = DISPLAY_NAMES[font] || font;
                select.appendChild(opt);
            }
        }

        // 恢复选中
        if (allowEmpty && !currentValue) {
            // 空值是一个有效选择：例如滚动标题可继承正文字体。
            select.value = '';
        } else if (currentValue && (fonts.includes(currentValue) || hasTemplateFontStack)) {
            select.value = currentValue;
        } else if (oldValue && fonts.includes(oldValue)) {
            select.value = oldValue;
        } else {
            select.value = DEFAULT_FONT_FAMILY;
        }

        // ── 搜索式下拉框 ──
        this._ensureFontPickerCSS();
        this._buildFontPicker(select, groups, groupDefs, DISPLAY_NAMES);
    }

    /**
     * 注入字体搜索下拉框的全局 CSS（只注入一次）。
     */
    _ensureFontPickerCSS() {
        if (document.getElementById('font-picker-css')) return;
        const style = document.createElement('style');
        style.id = 'font-picker-css';
        style.textContent = `
            /* Wrapper Button replacing select */
            .fp-wrap { position:relative; display:inline-block; }
            .fp-hidden-select { display:none !important; }
            .fp-btn {
                width:100%; box-sizing:border-box; text-align:left;
                padding:6px 24px 6px 12px; border:1px solid var(--border-color, #555);
                border-radius:6px; font-size:13px; cursor:pointer;
                background:var(--bg-input, #1e1e2e); color:var(--text-primary, #eee);
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis; position:relative;
                height: 30px; line-height: 16px;
            }
            .fp-btn:hover { border-color:var(--accent, #4c9eff); }
            .fp-btn::after {
                content: '▼'; position:absolute; right:8px; top:50%; transform:translateY(-50%);
                font-size:10px; color:var(--text-muted, #888);
            }
            
            /* Advanced Modal */
            .fp-modal-overlay {
                position:fixed; top:0; left:0; width:100vw; height:100vh;
                background:rgba(0,0,0,0.6); backdrop-filter:blur(4px);
                z-index:999999; display:flex; justify-content:center; align-items:center;
                opacity:0; pointer-events:none; transition:opacity 0.2s;
            }
            .fp-modal-overlay.fp-open { opacity:1; pointer-events:auto; }
            
            .fp-modal {
                width:1120px; max-width:96vw; height:680px; max-height:92vh;
                background:#1e1e2e; border-radius:8px; box-shadow:0 20px 50px rgba(0,0,0,0.5);
                display:flex; overflow:hidden; border:1px solid #333;
            }
            
            /* Sidebar */
            .fp-sidebar {
                width:210px; background:rgba(255,255,255,0.03); border-right:1px solid #333;
                padding:16px 0; overflow-y:auto; display:flex; flex-direction:column;
            }
            .fp-side-title {
                font-size:11px; font-weight:bold; color:#888; text-transform:uppercase;
                margin:16px 16px 8px 16px; letter-spacing:1px;
            }
            .fp-side-title:first-child { margin-top:0; }
            .fp-side-item {
                padding:8px 16px; font-size:13px; color:#ccc; cursor:pointer;
                display:flex; align-items:center; gap:8px;
            }
            .fp-side-item:hover { background:rgba(255,255,255,0.08); color:#fff; }
            .fp-side-item.fp-active { background:rgba(76, 158, 255, 0.15); color:#4c9eff; border-right:3px solid #4c9eff; }
            
            /* Main Content */
            .fp-main { flex:1; display:flex; flex-direction:column; background:#181825; }
            .fp-content { flex:1; min-height:0; display:flex; }
            .fp-results { flex:1; min-width:0; display:flex; flex-direction:column; }
            
            /* Header */
            .fp-header {
                padding:16px; border-bottom:1px solid #333; display:flex; gap:16px; align-items:center;
            }
            .fp-search-box {
                flex:1; position:relative;
            }
            .fp-search-input {
                width:100%; padding:8px 12px 8px 32px; background:#11111b; border:1px solid #333;
                border-radius:8px; color:#fff; font-size:13px; outline:none;
            }
            .fp-search-input:focus { border-color:#4c9eff; }
            .fp-search-icon {
                position:absolute; left:12px; top:50%; transform:translateY(-50%); color:#888;
            }
            .fp-preview-input {
                width:200px; padding:8px 12px; background:#11111b; border:1px solid #333;
                border-radius:6px; color:#fff; font-size:13px; outline:none;
            }
            .fp-preview-field { width:220px; display:flex; flex-direction:column; gap:4px; }
            .fp-preview-field .fp-preview-input { width:100%; }
            .fp-preview-hint { font-size:10px; color:#7d879a; line-height:1; }
            .fp-global-toggle {
                height:34px; padding:0 12px; border:1px solid #333; border-radius:8px;
                background:#11111b; color:#aab4c8; cursor:pointer; font-size:12px;
                white-space:nowrap;
            }
            .fp-global-toggle.fp-active-filter {
                border-color:#60d394; background:rgba(96,211,148,0.12); color:#d8ffe8;
            }
            .fp-close-btn {
                background:none; border:none; color:#888; font-size:20px; cursor:pointer; padding:0 8px;
            }
            .fp-close-btn:hover { color:#fff; }
            
            /* Top Recommendations */
            .fp-reco-area {
                padding:12px 16px; border-bottom:1px solid #333; background:#1e1e2e;
            }
            .fp-reco-title { font-size:11px; color:#888; margin-bottom:8px; }
            .fp-reco-tags { display:flex; gap:8px; flex-wrap:wrap; }
            .fp-reco-tag {
                padding:4px 10px; background:#2a2a3e; border-radius:8px; font-size:12px;
                color:#ccc; cursor:pointer; border:1px solid transparent;
            }
            .fp-reco-tag:hover, .fp-reco-tag.fp-active-filter { background:#3a3a4e; color:#fff; border-color:#4c9eff; }
            .fp-candidate-area {
                display:none; padding:10px 16px; border-bottom:1px solid #333; background:#171724;
            }
            .fp-candidate-area.fp-show { display:block; }
            .fp-candidate-title { font-size:11px; color:#8f97aa; margin-bottom:8px; }
            .fp-candidate-list { display:flex; gap:8px; flex-wrap:wrap; }
            .fp-candidate-chip {
                display:inline-flex; align-items:center; gap:6px; max-width:180px; height:28px;
                padding:0 8px; border:1px solid #333; border-radius:6px; background:#11111b;
                color:#dce3f2; cursor:pointer; font-size:12px;
            }
            .fp-candidate-chip.fp-active-filter { border-color:#4c9eff; background:#243b5f; color:#fff; }
            .fp-candidate-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .fp-candidate-remove {
                border:none; background:transparent; color:#8f97aa; cursor:pointer; padding:0; font-size:13px;
            }
            .fp-candidate-remove:hover { color:#fff; }
            
            /* Grid */
            .fp-grid-wrap { flex:1; overflow-y:auto; padding:16px; }
            .fp-grid {
                display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:12px;
            }
            
            /* Cards */
            .fp-card {
                background:#1e1e2e; border:1px solid #333; border-radius:8px; padding:14px;
                cursor:pointer; transition:all 0.2s ease; position:relative; overflow:hidden;
                min-height:168px; display:flex; flex-direction:column;
            }
            .fp-card:hover, .fp-card.fp-selected { border-color:#4c9eff; box-shadow:0 8px 16px rgba(0,0,0,0.3); }
            .fp-card.fp-selected { background:#202844; }
            .fp-card.fp-current { border-color:#60d394; }
            .fp-card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:10px; min-height:28px; }
            .fp-card-name { font-size:20px; color:#fff; line-height:1.15; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
            .fp-card-preview {
                font-size:14px; color:#aaa; line-height:1.35; min-height:54px; max-height:64px;
                overflow:hidden; display:flex; flex-direction:column; justify-content:center; margin-bottom:10px;
            }
            .fp-card-preview-cn { font-size:12px; color:#8f97aa; line-height:1.35; margin-top:5px; }
            .fp-current-badge {
                display:inline-flex; align-items:center; height:18px; padding:0 5px; border-radius:4px;
                background:rgba(96,211,148,0.12); color:#60d394; border:1px solid rgba(96,211,148,0.35);
                font-size:10px; font-weight:700; white-space:nowrap;
            }
            .fp-share-badge {
                display:inline-flex; align-items:center; height:18px; padding:0 5px; border-radius:4px;
                font-size:10px; font-weight:700; white-space:nowrap;
            }
            .fp-share-badge.fp-portable {
                color:#60d394; background:rgba(96,211,148,0.12); border:1px solid rgba(96,211,148,0.32);
            }
            .fp-share-badge.fp-local-only {
                color:#f9e2af; background:rgba(249,226,175,0.1); border:1px solid rgba(249,226,175,0.3);
            }
            .fp-share-badge.fp-font-file {
                color:#fab387; background:rgba(250,179,135,0.1); border:1px solid rgba(250,179,135,0.32);
            }
            .fp-add-candidate-btn {
                height:24px; padding:0 8px; border:1px solid #444; border-radius:5px;
                background:#171724; color:#b8c0d4; cursor:pointer; font-size:11px; white-space:nowrap;
            }
            .fp-add-candidate-btn:hover { border-color:#4c9eff; color:#fff; }
            .fp-add-candidate-btn.fp-added { border-color:#60d394; color:#60d394; background:rgba(96,211,148,0.08); }
            
            /* Tags */
            .fp-card-footer { display:flex; justify-content:space-between; align-items:flex-end; gap:8px; margin-top:auto; }
            .fp-card-tags { display:flex; gap:5px; flex-wrap:wrap; max-height:42px; overflow:hidden; min-width:0; }
            .fp-card-tag {
                font-size:10px; padding:2px 5px; border-radius:4px;
                background:rgba(255,255,255,0.05); color:#888; text-transform:uppercase;
            }
            .fp-tag-serif { color:#cba6f7; background:rgba(203,166,247,0.1); }
            .fp-tag-sans { color:#89b4fa; background:rgba(137,180,250,0.1); }
            .fp-tag-display { color:#f38ba8; background:rgba(243,139,168,0.1); }
            .fp-tag-viral { color:#f9e2af; background:rgba(249,226,175,0.1); border:1px solid rgba(249,226,175,0.3); }
            .fp-tag-script { color:#fab387; background:rgba(250,179,135,0.1); }
            .fp-tag-mono { color:#94e2d5; background:rgba(148,226,213,0.1); }
            .fp-tag-cjk { color:#a6e3a1; background:rgba(166,227,161,0.1); }
            
            /* Inspector */
            .fp-inspector {
                width:304px; border-left:1px solid #333; background:#151521;
                padding:14px; display:flex; flex-direction:column; gap:10px; overflow-y:auto;
            }
            .fp-ins-title { font-size:12px; color:#8f97aa; font-weight:700; }
            .fp-current-line {
                display:flex; align-items:center; gap:8px; padding:8px 10px; background:#10101a;
                border:1px solid #303044; border-radius:6px; font-size:12px; color:#b8c0d4;
            }
            .fp-current-font { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#fff; }
            .fp-compare-tabs { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
            .fp-compare-btn {
                height:30px; border:1px solid #333; border-radius:6px; background:#11111b; color:#9aa3b8;
                cursor:pointer; font-size:12px;
            }
            .fp-compare-btn.fp-active-filter { border-color:#4c9eff; background:#243b5f; color:#fff; }
            .fp-ins-name { font-size:20px; color:#fff; line-height:1.15; word-break:break-word; max-height:48px; overflow:hidden; }
            .fp-video-preview {
                aspect-ratio:9 / 16; width:100%; min-height:260px; max-height:330px; background:#0a0a12;
                border:1px solid #303044; border-radius:8px; position:relative; overflow:hidden;
            }
            .fp-video-preview::before {
                content:''; position:absolute; inset:0;
                background:linear-gradient(180deg, #20202d 0%, #101018 52%, #050509 100%);
            }
            .fp-preview-subtitle {
                position:absolute; left:18px; right:18px; bottom:42px; text-align:center;
                font-size:22px; line-height:1.08; color:#fff; font-weight:700;
                text-shadow:0 2px 8px rgba(0,0,0,0.8);
            }
            .fp-preview-subtitle-cn {
                display:block; margin-top:8px; font-size:15px; color:#f0f3ff;
            }
            .fp-ins-tags { display:flex; gap:5px; flex-wrap:wrap; max-height:44px; overflow:hidden; }
            .fp-control-row { display:flex; align-items:center; gap:8px; }
            .fp-control-row label { width:48px; font-size:12px; color:#8f97aa; }
            .fp-control-row select, .fp-control-row button {
                flex:1; height:30px; background:#11111b; color:#eee; border:1px solid #333; border-radius:6px;
            }
            .fp-control-row button.fp-active-filter { border-color:#4c9eff; color:#fff; background:#243b5f; }
            .fp-apply-main {
                height:36px; border:none; border-radius:6px; background:#4c9eff; color:#fff;
                font-weight:700; cursor:pointer;
            }
            .fp-apply-main:hover { background:#6aaeff; }
        `;
        document.head.appendChild(style);
    }

    _buildFontPicker(select, groups, groupDefs, displayNames) {
        let wrap = select.parentElement;
        if (!wrap || !wrap.classList.contains('fp-wrap')) {
            wrap = document.createElement('div');
            wrap.className = 'fp-wrap';
            const sw = select.style.width || select.style.minWidth;
            if (sw) wrap.style.width = sw;
            wrap.style.minWidth = select.style.minWidth || '120px';
            wrap.style.flex = select.style.flex || '';

            select.parentElement.insertBefore(wrap, select);
            select.classList.add('fp-hidden-select');
            wrap.appendChild(select);

            const btn = document.createElement('div');
            btn.className = 'fp-btn';
            wrap.insertBefore(btn, select);
            
            btn.addEventListener('click', () => {
                this._openAdvancedFontPicker(select);
            });
        }
        
        const btn = wrap.querySelector('.fp-btn');
        const isInherited = select.dataset.allowEmpty === 'true' && !select.value;
        const currentFont = select.value || DEFAULT_FONT_FAMILY;
        const selectedLabel = select.selectedOptions[0]?.textContent;
        btn.textContent = isInherited
            ? (select.dataset.emptyLabel || '跟随默认字体')
            : (selectedLabel || displayNames[currentFont] || currentFont);
        // CSS 候选串本身已经带逗号；把它套进一对引号会变成不存在的字体名。
        btn.style.fontFamily = isInherited ? 'inherit' : currentFont.includes(',') ? currentFont : `"${currentFont}", sans-serif`;
    }

    _openAdvancedFontPicker(selectEl, displayNames, groups) {
        if (!this._advModal) {
            this._advModal = this._createAdvancedModal();
        }
        const catalog = this.getUnifiedFontCatalog();
        this._advModal.show(selectEl, catalog.displayNames, catalog.groups);
        // 异步检查本地字体目录是否有变更（不会重新扫描 Windows 字体）
        if (this._registered) {
            this.refreshCatalogIfChanged().catch(() => {});
        }
    }

    _createAdvancedModal() {
        const overlay = document.createElement('div');
        overlay.className = 'fp-modal-overlay';
        
        const modal = document.createElement('div');
        modal.className = 'fp-modal';
        
        const sidebar = document.createElement('div');
        sidebar.className = 'fp-sidebar';
        sidebar.innerHTML = `
            <div class="fp-side-title">推荐</div>
            <div class="fp-side-item fp-active" data-cat="all">🌟 所有字体</div>
            <div class="fp-side-item" data-cat="subtitled">📦 Subtitled 导入</div>
            <div class="fp-side-item" data-cat="trending">🔥 热门精选</div>
            <div class="fp-side-item" data-cat="recent">🕘 最近使用</div>
            <div class="fp-side-item" data-cat="favorites">❤️ 我的收藏</div>
            
            <div class="fp-side-title">风格</div>
            <div class="fp-side-item" data-cat="sans">Aa 无衬线 (Sans)</div>
            <div class="fp-side-item" data-cat="serif">Aa 衬线 (Serif)</div>
            <div class="fp-side-item" data-cat="display">Ab 展示体 (Display)</div>
            <div class="fp-side-item" data-cat="script">✍️ 手写 (Script)</div>
            <div class="fp-side-item" data-cat="mono">_ 等宽 (Mono)</div>
            <div class="fp-side-item" data-cat="cjk">🌏 中文/日韩 (CJK)</div>
            
            <div class="fp-side-title">地域 / 语种</div>
            <div class="fp-side-item" data-reg="us">🇺🇸 美国常用</div>
            <div class="fp-side-item" data-reg="uk">🇬🇧 英国高级</div>
            <div class="fp-side-item" data-reg="europe">🇪🇺 欧洲现代</div>
            <div class="fp-side-item" data-reg="philippines">🇵🇭 菲律宾/东南亚</div>
            <div class="fp-side-item" data-reg="arabic">العربية 阿拉伯/中东</div>
            
            <div class="fp-side-title">来源</div>
            <div class="fp-side-item" data-source="portable">✅ 可分享字体</div>
            <div class="fp-side-item" data-source="google">🌐 Google 免费</div>
            <div class="fp-side-item" data-source="system">💻 系统与自带</div>
            <div class="fp-side-item" data-source="custom">📤 我的上传</div>
        `;
        
        const main = document.createElement('div');
        main.className = 'fp-main';
        main.innerHTML = `
            <div class="fp-header">
                <div class="fp-search-box">
                    <span class="fp-search-icon">🔍</span>
                    <input type="text" class="fp-search-input" placeholder="智能搜索：如 '短视频', '高级', '英式'...">
                </div>
                <div class="fp-preview-field">
                    <input type="text" class="fp-preview-input" placeholder="输入预览文字..." value="Make it unforgettable">
                    <div class="fp-preview-hint">预览文字，不会写入字幕</div>
                </div>
                <button type="button" class="fp-global-toggle fp-active-filter" title="打开后，任何分类都只显示适合分享预设的字体">仅可分享</button>
                <button class="fp-close-btn">×</button>
            </div>
            <div class="fp-reco-area">
                <div class="fp-reco-title">🎯 高命中率预设</div>
                <div class="fp-reco-tags">
                    <div class="fp-reco-tag" data-use="viral">短视频爆款</div>
                    <div class="fp-reco-tag" data-use="subtitle">字幕清晰</div>
                    <div class="fp-reco-tag" data-use="luxury">高级品牌感</div>
                    <div class="fp-reco-tag" data-use="news">新闻纪录片</div>
                    <div class="fp-reco-tag" data-use="tech">科技感</div>
                    <div class="fp-reco-tag" data-use="kids">儿童轻松</div>
                </div>
            </div>
            <div class="fp-candidate-area">
                <div class="fp-candidate-title">候选对比：点击字体名快速切换预览</div>
                <div class="fp-candidate-list"></div>
            </div>
            <div class="fp-content">
                <div class="fp-results">
                    <div class="fp-grid-wrap">
                        <div class="fp-grid"></div>
                    </div>
                </div>
                <div class="fp-inspector">
                    <div class="fp-ins-title">当前预览</div>
                    <div class="fp-current-line">
                        <span>正在使用</span>
                        <span class="fp-current-font">Arial</span>
                    </div>
                    <div class="fp-compare-tabs">
                        <button type="button" class="fp-compare-btn" data-mode="current">看当前</button>
                        <button type="button" class="fp-compare-btn fp-active-filter" data-mode="candidate">看候选</button>
                    </div>
                    <div class="fp-ins-name">Inter</div>
                    <div class="fp-video-preview">
                        <div class="fp-preview-subtitle">
                            Make it unforgettable
                            <span class="fp-preview-subtitle-cn">高级字幕预览</span>
                        </div>
                    </div>
                    <div class="fp-ins-tags"></div>
                    <div class="fp-control-row">
                        <label>字重</label>
                        <select class="fp-weight-select">
                            <option value="400">Regular</option>
                            <option value="700">Bold</option>
                            <option value="900">Black</option>
                        </select>
                    </div>
                    <div class="fp-control-row">
                        <label>样式</label>
                        <button type="button" class="fp-italic-toggle">斜体预览</button>
                    </div>
                    <button type="button" class="fp-apply-main">应用字体</button>
                </div>
            </div>
        `;
        
        modal.appendChild(sidebar);
        modal.appendChild(main);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        const grid = main.querySelector('.fp-grid');
        const searchInput = main.querySelector('.fp-search-input');
        const previewInput = main.querySelector('.fp-preview-input');
        const closeBtn = main.querySelector('.fp-close-btn');
        const portableToggle = main.querySelector('.fp-global-toggle');
        const sideItems = sidebar.querySelectorAll('.fp-side-item');
        const recoTags = main.querySelectorAll('.fp-reco-tag');
        const candidateArea = main.querySelector('.fp-candidate-area');
        const candidateListEl = main.querySelector('.fp-candidate-list');
        const inspectorName = main.querySelector('.fp-ins-name');
        const inspectorTags = main.querySelector('.fp-ins-tags');
        const inspectorSubtitle = main.querySelector('.fp-preview-subtitle');
        const weightSelect = main.querySelector('.fp-weight-select');
        const italicToggle = main.querySelector('.fp-italic-toggle');
        const applyMainBtn = main.querySelector('.fp-apply-main');
        const currentFontLabel = main.querySelector('.fp-current-font');
        const compareButtons = main.querySelectorAll('.fp-compare-btn');
        
        let currentSelect = null;
        let currentDisplayNames = {};
        let currentGroups = {};
        let activeCategory = 'all';
        let activeRegion = null;
        let activeSource = null;
        let activeUseCase = null;
        let portableOnly = true;
        let currentFont = DEFAULT_FONT_FAMILY;
        let selectedFont = DEFAULT_FONT_FAMILY;
        let candidateFonts = [];
        let previewMode = 'candidate';
        let selectedItalic = false;
        
        const self = this;
        
        const getMetadata = (fontName) => self._getFontMetadata(fontName);
        
        const getFavorites = () => JSON.parse(localStorage.getItem('fp_favorites') || '[]');
        const toggleFavorite = (font) => {
            let favs = getFavorites();
            if (favs.includes(font)) favs = favs.filter(f => f !== font);
            else favs.push(font);
            localStorage.setItem('fp_favorites', JSON.stringify(favs));
            renderGrid();
        };
        
        const getRecents = () => JSON.parse(localStorage.getItem('fp_recents') || '[]');
        const addRecent = (font) => {
            let recs = getRecents().filter(f => f !== font);
            recs.unshift(font);
            if (recs.length > 20) recs = recs.slice(0, 20);
            localStorage.setItem('fp_recents', JSON.stringify(recs));
        };

        const renderCandidates = () => {
            candidateArea.classList.toggle('fp-show', candidateFonts.length > 0);
            candidateListEl.innerHTML = '';
            for (const font of candidateFonts) {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = `fp-candidate-chip${font === selectedFont ? ' fp-active-filter' : ''}`;
                chip.style.fontFamily = `"${font}", sans-serif`;
                chip.innerHTML = `
                    <span class="fp-candidate-name">${self._escapeHtml(currentDisplayNames[font] || font)}</span>
                    <span class="fp-candidate-remove" title="移出候选">×</span>
                `;
                chip.addEventListener('click', () => selectFont(font));
                chip.querySelector('.fp-candidate-remove').addEventListener('click', (e) => {
                    e.stopPropagation();
                    candidateFonts = candidateFonts.filter(f => f !== font);
                    if (selectedFont === font) {
                        selectedFont = candidateFonts[0] || currentFont || DEFAULT_FONT_FAMILY;
                        previewMode = selectedFont === currentFont ? 'current' : 'candidate';
                        renderInspector();
                    }
                    renderCandidates();
                    renderGrid();
                });
                candidateListEl.appendChild(chip);
            }
        };

        const addCandidate = (font) => {
            if (!font) return;
            candidateFonts = candidateFonts.filter(f => f !== font);
            candidateFonts.unshift(font);
            if (candidateFonts.length > 8) candidateFonts = candidateFonts.slice(0, 8);
            selectFont(font);
            renderCandidates();
            renderGrid();
        };

        const getRelatedWeightSelect = () => {
            if (!currentSelect || !currentSelect.id) return null;
            const map = {
                'rop-font': 'rop-font-weight',
                'rop-title-font': 'rop-title-weight',
                'rop-body-font': 'rop-body-weight',
                'rop-footer-font': 'rop-footer-weight',
                'rop-scroll-title-font': 'rop-scroll-title-weight',
                'rop-scroll-font': 'rop-scroll-weight',
            };
            const id = map[currentSelect.id];
            return id ? document.getElementById(id) : null;
        };
        
        const applyFont = (font) => {
            if (currentSelect) {
                currentSelect.value = font;
                currentSelect.dispatchEvent(new Event('change', { bubbles: true }));
                const relatedWeight = getRelatedWeightSelect();
                if (relatedWeight && weightSelect.value) {
                    relatedWeight.value = weightSelect.value;
                    relatedWeight.dispatchEvent(new Event('change', { bubbles: true }));
                }
                const btn = currentSelect.parentElement.querySelector('.fp-btn');
                if (btn) {
                    btn.textContent = currentDisplayNames[font] || font;
                    btn.style.fontFamily = `"${font}", sans-serif`;
                }
                self.loadGoogleFont(font).catch(() => {});
            }
            addRecent(font);
            closeModal();
        };

        const renderInspector = () => {
            const font = previewMode === 'current'
                ? (currentFont || DEFAULT_FONT_FAMILY)
                : (selectedFont || DEFAULT_FONT_FAMILY);
            const meta = getMetadata(font);
            const source = self._getFontSource(font, currentGroups);
            const displayName = currentDisplayNames[font] || font;
            const previewText = self._escapeHtml(previewInput.value || 'Make it unforgettable');
            inspectorName.textContent = displayName;
            inspectorName.style.fontFamily = `"${font}", sans-serif`;
            inspectorSubtitle.style.fontFamily = `"${font}", sans-serif`;
            inspectorSubtitle.innerHTML = `${previewText}<span class="fp-preview-subtitle-cn">高级字幕预览</span>`;

            const tags = [
                font === currentFont ? '正在使用' : '候选',
                meta.category ? meta.category.toUpperCase() : null,
                self._sourceLabel(source),
                ...(meta.regions || []).slice(0, 2),
                ...(meta.useCases || []).slice(0, 2),
            ].filter(Boolean);
            inspectorTags.innerHTML = tags.map(tag => `<span class="fp-card-tag">${self._escapeHtml(tag)}</span>`).join('');

            const weights = self.getFontWeightEntries(font, 'normal');
            const currentWeight = weightSelect.value || '700';
            weightSelect.innerHTML = weights.map(w => `<option value="${self._escapeHtml(w.value)}">${self._escapeHtml(w.label)} ${self._escapeHtml(w.value)}</option>`).join('');
            weightSelect.value = weights.some(w => w.value === currentWeight) ? currentWeight : (weights.find(w => w.value === '700')?.value || weights[0]?.value || '400');
            inspectorSubtitle.style.fontWeight = weightSelect.value || '700';
            inspectorSubtitle.style.fontStyle = selectedItalic ? 'italic' : 'normal';
            currentFontLabel.textContent = currentDisplayNames[currentFont] || currentFont || DEFAULT_FONT_FAMILY;
            currentFontLabel.style.fontFamily = `"${currentFont || DEFAULT_FONT_FAMILY}", sans-serif`;
            compareButtons.forEach(btn => btn.classList.toggle('fp-active-filter', btn.dataset.mode === previewMode));
            applyMainBtn.textContent = selectedFont === currentFont ? '已是当前字体' : '应用候选字体';
            applyMainBtn.disabled = selectedFont === currentFont;
            applyMainBtn.style.opacity = selectedFont === currentFont ? '0.55' : '1';
            renderCandidates();
        };

        const selectFont = (font) => {
            selectedFont = font || DEFAULT_FONT_FAMILY;
            previewMode = 'candidate';
            self.loadGoogleFont(selectedFont).catch(() => {});
            renderInspector();
            grid.querySelectorAll('.fp-card').forEach(card => {
                card.classList.toggle('fp-selected', card.dataset.font === selectedFont);
            });
            renderCandidates();
        };
        
        const renderGrid = () => {
            grid.innerHTML = '';
            const query = searchInput.value.toLowerCase().trim();
            const previewText = previewInput.value || 'Make it unforgettable';
            const favs = getFavorites();
            const recs = getRecents();
            
            let allFonts = [];
            if (currentGroups.system) allFonts.push(...currentGroups.system);
            if (currentGroups.google) allFonts.push(...currentGroups.google);
            if (currentGroups.embedded) allFonts.push(...currentGroups.embedded);
            if (currentGroups.custom) allFonts.push(...currentGroups.custom);
            allFonts = [...new Set(allFonts)];
            
            const filtered = allFonts.filter(font => {
                const meta = getMetadata(font);
                const displayName = currentDisplayNames[font] || font;
                
                if (query) {
                    const matchName = font.toLowerCase().includes(query) || displayName.toLowerCase().includes(query);
                    const matchAlias = meta.aliases && meta.aliases.some(a => a.toLowerCase().includes(query));
                    const matchTags = meta.useCases && meta.useCases.some(u => u.toLowerCase().includes(query));
                    const matchRegion = meta.regions && meta.regions.some(r => r.toLowerCase().includes(query));
                    const matchCategory = meta.category && meta.category.toLowerCase().includes(query);
                    if (!matchName && !matchAlias && !matchTags && !matchRegion && !matchCategory) return false;
                }
                
                if (activeCategory === 'subtitled') {
                    if (meta.importedFrom !== 'subtitled') return false;
                } else if (activeCategory === 'favorites') {
                    if (!favs.includes(font)) return false;
                } else if (activeCategory === 'recent') {
                    if (!recs.includes(font)) return false;
                } else if (activeCategory !== 'all' && activeCategory !== 'trending') {
                    if (meta.category !== activeCategory) {
                        if (!meta.category && activeCategory === 'sans' && font.toLowerCase().includes('sans')) return true;
                        if (!meta.category && activeCategory === 'serif' && font.toLowerCase().includes('serif')) return true;
                        if (!meta.category && activeCategory === 'mono' && font.toLowerCase().includes('mono')) return true;
                        if (!meta.category && activeCategory === 'cjk' && font.match(/[\u4e00-\u9fa5]/)) return true;
                        return false;
                    }
                }
                
                if (activeCategory === 'trending' && (!meta.popularity || meta.popularity < 90)) return false;
                if (activeRegion && (!meta.regions || !meta.regions.includes(activeRegion))) return false;
                if (activeUseCase && (!meta.useCases || !meta.useCases.includes(activeUseCase))) return false;
                
                if (activeSource === 'system' && !currentGroups.system.includes(font) && !currentGroups.embedded.includes(font)) return false;
                if (activeSource === 'google' && !currentGroups.google.includes(font)) return false;
                if (activeSource === 'portable' && !currentGroups.google.includes(font) && !currentGroups.embedded.includes(font)) return false;
                if (activeSource === 'custom' && !currentGroups.custom.includes(font)) return false;
                if (portableOnly && !currentGroups.google.includes(font) && !currentGroups.embedded.includes(font)) return false;
                
                return true;
            });
            
            filtered.sort((a, b) => {
                if (activeCategory === 'recent') {
                    return recs.indexOf(a) - recs.indexOf(b);
                }
                const mA = getMetadata(a).popularity || 50;
                const mB = getMetadata(b).popularity || 50;
                return mB - mA;
            });
            
            const toRender = filtered.slice(0, 150);
            
            for (const font of toRender) {
                const meta = getMetadata(font);
                const isFav = favs.includes(font);
                const source = self._getFontSource(font, currentGroups);
                
                const isCurrentFont = font === currentFont;
                const isCandidate = candidateFonts.includes(font);
                const card = document.createElement('div');
                card.className = `fp-card${font === selectedFont ? ' fp-selected' : ''}${isCurrentFont ? ' fp-current' : ''}`;
                card.dataset.font = font;
                
                let tagsHtml = '';
                if (meta.category) {
                    tagsHtml += `<span class="fp-card-tag fp-tag-${self._escapeHtml(meta.category)}">${self._escapeHtml(meta.category.toUpperCase())}</span>`;
                }
                if (meta.useCases && meta.useCases.includes('viral')) tagsHtml += `<span class="fp-card-tag fp-tag-viral">🔥 爆款</span>`;
                else if (meta.popularity >= 95) tagsHtml += `<span class="fp-card-tag">⭐ 热门</span>`;
                
                if (meta.aliases && meta.aliases[0]) tagsHtml += `<span class="fp-card-tag">${self._escapeHtml(meta.aliases[0])}</span>`;
                if (isCurrentFont) tagsHtml += `<span class="fp-current-badge">正在使用</span>`;
                if (source === 'google' || source === 'embedded') {
                    tagsHtml += `<span class="fp-share-badge fp-portable">可分享</span>`;
                } else if (source === 'custom') {
                    tagsHtml += `<span class="fp-share-badge fp-font-file">需字体文件</span>`;
                } else {
                    tagsHtml += `<span class="fp-share-badge fp-local-only">本机字体</span>`;
                }
                tagsHtml += `<span class="fp-card-tag" style="background:rgba(255,255,255,0.1);">${self._escapeHtml(self._sourceLabel(source))}</span>`;
                const safeFont = self._escapeHtml(font);
                const safeName = self._escapeHtml(currentDisplayNames[font] || font);
                const safePreview = self._escapeHtml(previewText);
                
                card.innerHTML = `
                    <div class="fp-card-head">
                        <div class="fp-card-name" style="font-family: '${safeFont}', sans-serif;" title="${safeFont}">${safeName}</div>
                        <button class="fp-fav-btn" style="background:none; border:none; cursor:pointer; font-size:16px; color:${isFav ? '#f38ba8' : '#555'};" title="收藏">
                            ${isFav ? '❤️' : '♡'}
                        </button>
                    </div>
                    <div class="fp-card-preview" style="font-family: '${safeFont}', sans-serif;">
                        ${safePreview}
                        <div class="fp-card-preview-cn">高级字幕预览</div>
                    </div>
                    <div class="fp-card-footer">
                        <div class="fp-card-tags">${tagsHtml}</div>
                        <div style="display:flex; gap:6px; flex-shrink:0;">
                            <button class="fp-add-candidate-btn${isCandidate ? ' fp-added' : ''}" type="button">${isCandidate ? '已候选' : '+候选'}</button>
                            <button class="fp-apply-btn" style="padding:4px 10px; background:#4c9eff; color:#fff; border:none; border-radius:4px; font-size:12px; cursor:pointer;">应用</button>
                        </div>
                    </div>
                `;
                
                card.querySelector('.fp-fav-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleFavorite(font);
                });
                
                card.querySelector('.fp-apply-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    applyFont(font);
                });
                card.querySelector('.fp-add-candidate-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    addCandidate(font);
                });
                
                card.addEventListener('click', () => selectFont(font));
                
                grid.appendChild(card);
            }
            
            if (filtered.length === 0) grid.innerHTML = '<div style="color:#888; padding:20px;">未找到匹配的字体。</div>';
        };
        
        const closeModal = () => overlay.classList.remove('fp-open');
        closeBtn.addEventListener('click', closeModal);
        overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeModal(); });
        
        searchInput.addEventListener('input', renderGrid);
        previewInput.addEventListener('input', () => {
            renderGrid();
            renderInspector();
        });
        weightSelect.addEventListener('change', renderInspector);
        compareButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                previewMode = btn.dataset.mode || 'candidate';
                renderInspector();
            });
        });
        italicToggle.addEventListener('click', () => {
            selectedItalic = !selectedItalic;
            italicToggle.classList.toggle('fp-active-filter', selectedItalic);
            renderInspector();
        });
        applyMainBtn.addEventListener('click', () => applyFont(selectedFont));
        portableToggle.addEventListener('click', () => {
            portableOnly = !portableOnly;
            portableToggle.classList.toggle('fp-active-filter', portableOnly);
            portableToggle.textContent = portableOnly ? '仅可分享' : '全部来源';
            renderGrid();
        });
        
        sideItems.forEach(item => {
            item.addEventListener('click', () => {
                sideItems.forEach(i => i.classList.remove('fp-active'));
                item.classList.add('fp-active');
                activeCategory = item.dataset.cat || 'all';
                activeRegion = item.dataset.reg || null;
                activeSource = item.dataset.source || null;
                if (activeSource === 'portable') portableOnly = true;
                if (activeSource === 'system' || activeSource === 'custom') portableOnly = false;
                portableToggle.classList.toggle('fp-active-filter', portableOnly);
                portableToggle.textContent = portableOnly ? '仅可分享' : '全部来源';
                activeUseCase = null;
                recoTags.forEach(t => t.classList.remove('fp-active-filter'));
                searchInput.value = '';
                renderGrid();
            });
        });
        
        recoTags.forEach(tag => {
            tag.addEventListener('click', () => {
                const nextUse = tag.dataset.use;
                activeUseCase = activeUseCase === nextUse ? null : nextUse;
                recoTags.forEach(t => t.classList.toggle('fp-active-filter', t === tag && activeUseCase === nextUse));
                sideItems.forEach(i => i.classList.remove('fp-active'));
                document.querySelector('.fp-side-item[data-cat="all"]').classList.add('fp-active');
                activeCategory = 'all'; activeRegion = null; activeSource = null;
                searchInput.value = '';
                renderGrid();
            });
        });
        
        return {
            refreshCatalog: (displayNames, groups) => {
                currentDisplayNames = displayNames || currentDisplayNames;
                currentGroups = groups || currentGroups;
                if (overlay.classList.contains('fp-open')) {
                    renderInspector();
                    renderGrid();
                }
            },
            show: (selectEl, displayNames, groups) => {
                currentSelect = selectEl;
                currentDisplayNames = displayNames;
                currentGroups = groups;
                currentFont = selectEl.value || DEFAULT_FONT_FAMILY;
                selectedFont = currentFont;
                candidateFonts = currentFont ? [currentFont] : [];
                previewMode = 'candidate';
                activeCategory = 'all';
                activeRegion = null;
                activeSource = null;
                activeUseCase = null;
                selectedItalic = false;
                portableOnly = false;
                portableToggle.classList.remove('fp-active-filter');
                portableToggle.textContent = '全部来源';
                searchInput.value = '';
                sideItems.forEach(i => i.classList.toggle('fp-active', i.dataset.cat === 'all'));
                recoTags.forEach(t => t.classList.remove('fp-active-filter'));
                overlay.classList.add('fp-open');
                renderInspector();
                renderCandidates();
                renderGrid();
                searchInput.focus();
            }
        };
    }
}

// ═══════════════════════════════════════════════════════
// Singleton
// ═══════════════════════════════════════════════════════

let _fontManagerInstance = null;

function getFontManager() {
    if (!_fontManagerInstance) {
        _fontManagerInstance = new ReelsFontManager();
    }
    return _fontManagerInstance;
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

if (typeof window !== 'undefined') {
    window.ReelsFontManager = ReelsFontManager;
    window.getFontManager = getFontManager;
    window.DEFAULT_FONT_FAMILY = DEFAULT_FONT_FAMILY;
    window.BUILTIN_FONTS = BUILTIN_FONTS;
    window.GOOGLE_FONTS = GOOGLE_FONTS;
    window.UNIFIED_FONT_SELECT_IDS = UNIFIED_FONT_SELECT_IDS;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ReelsFontManager, getFontManager, DEFAULT_FONT_FAMILY, BUILTIN_FONTS, GOOGLE_FONTS, UNIFIED_FONT_SELECT_IDS };
}
