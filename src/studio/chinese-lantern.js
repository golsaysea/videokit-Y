/**
 * chinese-lantern.js — Exquisite Chinese Palace & Lotus Flower Lantern Ornaments
 * 中国传统花灯（宫灯 / 莲花灯笼）精细矢量装饰与静夜氛围组件
 */

export const LANTERN_MODES = {
    lit: { id: 'lit', label: '🏮 花灯暖光', shortLabel: '花灯', desc: '静夜星空 + 暖意花灯轻摇微光' },
    calm: { id: 'calm', label: '🕯️ 静夜常亮', shortLabel: '常亮', desc: '花灯静止微暖，零摆动更专注' },
    off: { id: 'off', label: '✨ 纯净星空', shortLabel: '星空', desc: '仅保留极简深邃星空夜色' },
};

let _svgUidCounter = 0;

/**
 * Build a crisp Chinese octagonal/lotus flower lantern SVG string.
 * @param {object} [opts]
 * @param {number} [opts.width=56]
 * @param {number} [opts.height=106]
 * @param {'palace'|'lotus'} [opts.variant='palace']
 * @param {number} [opts.cordLength=16]
 */
export function buildChineseLanternSvg(opts = {}) {
    const uid = `vkl${++_svgUidCounter}`;
    const width = Number(opts.width) || 56;
    const height = Number(opts.height) || 106;
    const variant = opts.variant === 'lotus' ? 'lotus' : 'palace';
    const cordLength = Math.max(6, Math.min(34, Number(opts.cordLength) || 16));

    const bodyPath = variant === 'lotus'
        ? 'M22 30 C13 38, 12 60, 22 72 L38 72 C48 60, 47 38, 38 30 Z'
        : 'M18 32 L14 52 L19 72 L41 72 L46 52 L42 32 Z';

    const innerRibLeft = variant === 'lotus'
        ? 'M26 30 C21 43, 21 60, 26 72'
        : 'M24 32 L22 52 L24 72';

    const innerRibRight = variant === 'lotus'
        ? 'M34 30 C39 43, 39 60, 34 72'
        : 'M36 32 L38 52 L36 72';

    return `<svg width="${width}" height="${height}" viewBox="0 0 60 116" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="${uid}-core" cx="50%" cy="48%" r="58%">
      <stop offset="0%" stop-color="#fff8d6" />
      <stop offset="38%" stop-color="#ffbe55" />
      <stop offset="76%" stop-color="#eb6a2b" />
      <stop offset="100%" stop-color="#9e2a1b" />
    </radialGradient>
    <linearGradient id="${uid}-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffe094" />
      <stop offset="50%" stop-color="#eab354" />
      <stop offset="100%" stop-color="#b57420" />
    </linearGradient>
    <linearGradient id="${uid}-tassel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e84a27" />
      <stop offset="65%" stop-color="#c9351c" />
      <stop offset="100%" stop-color="#8b1d12" stop-opacity="0.7" />
    </linearGradient>
  </defs>

  <!-- 挂绳与金环 -->
  <line x1="30" y1="0" x2="30" y2="${cordLength}" stroke="#eab354" stroke-width="1.3" stroke-opacity="0.82" />
  <circle cx="30" cy="${cordLength + 3}" r="3" stroke="url(#${uid}-gold)" stroke-width="1.4" fill="#1b110d" />

  <!-- 宫灯翘角屋檐冠盖 -->
  <path d="M13 31 Q21 25 30 22 Q39 25 47 31 L43 34 L17 34 Z" fill="#2a1610" stroke="url(#${uid}-gold)" stroke-width="1.15" stroke-linejoin="round" />
  <path d="M10 30 Q14 31 18 30" stroke="url(#${uid}-gold)" stroke-width="1.2" stroke-linecap="round" />
  <path d="M42 30 Q46 31 50 30" stroke="url(#${uid}-gold)" stroke-width="1.2" stroke-linecap="round" />
  <circle cx="30" cy="22" r="2.2" fill="url(#${uid}-gold)" />

  <!-- 暖意灯笼主体 -->
  <path d="${bodyPath}" fill="url(#${uid}-core)" stroke="url(#${uid}-gold)" stroke-width="1.35" stroke-linejoin="round" />

  <!-- 柔和内部烛心光晕 -->
  <ellipse cx="30" cy="51" rx="8.5" ry="12" fill="#fff7d6" opacity="0.42" />
  <ellipse cx="30" cy="51" rx="3.2" ry="6.5" fill="#ffffff" opacity="0.78" />

  <!-- 古典窗格/花瓣骨线 -->
  <path d="${innerRibLeft}" stroke="#ffd88a" stroke-opacity="0.55" stroke-width="0.95" />
  <path d="${innerRibRight}" stroke="#ffd88a" stroke-opacity="0.55" stroke-width="0.95" />
  <line x1="15" y1="45" x2="45" y2="45" stroke="#ffd88a" stroke-opacity="0.34" stroke-width="0.8" />
  <line x1="15" y1="58" x2="45" y2="58" stroke="#ffd88a" stroke-opacity="0.34" stroke-width="0.8" />
  <!-- 中央莲花/梅花纹剪影 -->
  <path d="M30 43 C27.5 47, 27 51, 30 55 C33 51, 32.5 47, 30 43 Z" fill="#fff4d0" fill-opacity="0.35" />

  <!-- 底部托座 -->
  <path d="M18 72 L42 72 L38 77 L22 77 Z" fill="#2a1610" stroke="url(#${uid}-gold)" stroke-width="1.15" stroke-linejoin="round" />

  <!-- 盘长中国结 -->
  <path d="M30 77 L34.5 81.5 L30 86 L25.5 81.5 Z" fill="#d93b20" stroke="#f6c465" stroke-width="1" />
  <circle cx="30" cy="81.5" r="1.4" fill="#fde68a" />

  <!-- 流苏丝穗 -->
  <path d="M27.5 88 L26 112 M30 88 L30 115 M32.5 88 L34 112" stroke="url(#${uid}-tassel)" stroke-width="1.45" stroke-linecap="round" />
  <rect x="26.5" y="86.5" width="7" height="2.4" rx="1" fill="url(#${uid}-gold)" />
</svg>`;
}

export function buildSeasonalCornerSvg(sceneTheme = 'christmas-eve', opts = {}) {
    const uid = `vks${++_svgUidCounter}`;
    const w = Number(opts.width) || 54;
    const h = Number(opts.height) || 96;
    if (sceneTheme === 'autumn-night') {
        return `<svg width="${w}" height="${h}" viewBox="0 0 60 110" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="${uid}-maple" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f59e0b" />
      <stop offset="55%" stop-color="#ea580c" />
      <stop offset="100%" stop-color="#b91c1c" />
    </linearGradient>
    <radialGradient id="${uid}-amber" cx="50%" cy="46%" r="55%">
      <stop offset="0%" stop-color="#fef3c7" />
      <stop offset="60%" stop-color="#ea8c42" />
      <stop offset="100%" stop-color="#9a3412" />
    </radialGradient>
  </defs>
  <path d="M46 0 Q38 18 28 32" stroke="#b45309" stroke-width="1.5" stroke-linecap="round" />
  <circle cx="28" cy="34" r="3" stroke="#f59e0b" stroke-width="1.2" fill="#1c0d07" />
  <path d="M18 39 C15 52 16 66 28 73 C40 66 41 52 38 39 Z" fill="url(#${uid}-amber)" stroke="#f59e0b" stroke-width="1.2" />
  <ellipse cx="28" cy="54" rx="5" ry="9" fill="#fff7ed" opacity="0.58" />
  <path d="M42 18 L49 12 L47 21 L55 24 L46 27 L48 34 L41 28 L35 32 L38 24 L31 20 L40 19 Z" fill="url(#${uid}-maple)" opacity="0.92" />
  <path d="M26 75 L25 98 M28 75 L28 102 M30 75 L31 98" stroke="#ea580c" stroke-width="1.3" stroke-linecap="round" />
</svg>`;
    }
    if (sceneTheme === 'snow-night') {
        return `<svg width="${w}" height="${h}" viewBox="0 0 60 110" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="${uid}-ice" cx="50%" cy="50%" r="55%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="50%" stop-color="#bae6fd" />
      <stop offset="100%" stop-color="#0284c7" />
    </radialGradient>
  </defs>
  <line x1="30" y1="0" x2="30" y2="26" stroke="#7dd3fc" stroke-width="1.2" stroke-opacity="0.7" />
  <circle cx="30" cy="48" r="18" fill="url(#${uid}-ice)" opacity="0.18" />
  <g stroke="#bae6fd" stroke-width="1.5" stroke-linecap="round">
    <line x1="30" y1="26" x2="30" y2="70" />
    <line x1="11" y1="37" x2="49" y2="59" />
    <line x1="49" y1="37" x2="11" y2="59" />
    <path d="M25 31 L30 35 L35 31 M25 65 L30 61 L35 65" />
    <path d="M16 34 L20 40 L14 43 M44 34 L40 40 L46 43" />
    <path d="M14 53 L20 56 L16 62 M46 53 L40 56 L44 62" />
  </g>
  <circle cx="30" cy="48" r="3.4" fill="#f0f9ff" />
</svg>`;
    }
    if (sceneTheme === 'christmas-eve') {
        return `<svg width="${w}" height="${h}" viewBox="0 0 60 110" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="${uid}-bauble" cx="42%" cy="38%" r="58%">
      <stop offset="0%" stop-color="#fff8d6" />
      <stop offset="35%" stop-color="#ef4444" />
      <stop offset="85%" stop-color="#991b1b" />
      <stop offset="100%" stop-color="#450a0a" />
    </radialGradient>
    <linearGradient id="${uid}-xmasgold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fef08a" />
      <stop offset="100%" stop-color="#d97706" />
    </linearGradient>
  </defs>
  <line x1="30" y1="0" x2="30" y2="22" stroke="url(#${uid}-xmasgold)" stroke-width="1.3" />
  <path d="M16 26 Q30 16 44 26 Q36 31 30 27 Q24 31 16 26 Z" fill="#15803d" stroke="#4ade80" stroke-width="0.9" />
  <circle cx="28" cy="24" r="2.1" fill="#ef4444" />
  <circle cx="33" cy="25" r="2.1" fill="#f59e0b" />
  <rect x="25" y="29" width="10" height="4.5" rx="1.2" fill="url(#${uid}-xmasgold)" />
  <circle cx="30" cy="54" r="20" fill="url(#${uid}-bauble)" stroke="url(#${uid}-xmasgold)" stroke-width="1.2" />
  <path d="M30 42 L32.2 48.2 L38.5 48.4 L33.4 52.3 L35.2 58.5 L30 54.8 L24.8 58.5 L26.6 52.3 L21.5 48.4 L27.8 48.2 Z" fill="#fde68a" opacity="0.9" />
  <ellipse cx="23" cy="46" rx="3" ry="5" fill="#ffffff" opacity="0.35" transform="rotate(-20 23 46)" />
</svg>`;
    }
    return buildChineseLanternSvg({ width: w, height: h, variant: 'palace', cordLength: opts.cordLength || 16 });
}

const SCENE_STAGE_GREETINGS = {
    'starry-lantern': { title: '夜色静美 · 灵感待启', sub: '拖入素材或选择左侧任务即可实时预览', color: '#fde68a' },
    'starry-ink': { title: '静谧深空 · 专注剪辑', sub: '拖入素材或选择左侧任务即可实时预览', color: '#bae6fd' },
    'autumn-night': { title: '暮秋枫夜 · 暖光微醺', sub: '十一月秋景模式 · 拖入素材即可实时预览', color: '#fed7aa' },
    'snow-night': { title: '静冬雪夜 · 银霜映影', sub: '十一月雪景模式 · 拖入素材即可实时预览', color: '#e0f2fe' },
    'christmas-eve': { title: '圣诞暖夜 · 星灯伴剪', sub: '圣诞主题模式 · 拖入素材即可实时预览', color: '#fde68a' },
};

/**
 * Mount peaceful Chinese corner eaves flower lanterns + seasonal corner scenes + empty preview greeting.
 */
export function mountChineseLanternStage(doc = document) {
    if (!doc || !doc.body) return { setMode() {}, setSceneTheme() {}, destroy() {} };

    let currentScene = 'christmas-eve';

    let stage = doc.getElementById('vk-lantern-stage');
    function renderStageOrnaments(sceneId) {
        if (!stage) return;
        if (sceneId === 'autumn-night') {
            stage.innerHTML = `
                <div class="vk-lantern-eave vk-lantern-eave-right">
                    <div class="vk-lantern-hanger is-compact">
                        <div class="vk-lantern-halo"></div>
                        ${buildChineseLanternSvg({ width: 38, height: 74, variant: 'lotus', cordLength: 10 })}
                    </div>
                    <div class="vk-lantern-hanger">
                        <div class="vk-lantern-halo"></div>
                        ${buildSeasonalCornerSvg('autumn-night', { width: 50, height: 94 })}
                    </div>
                </div>
            `;
        } else if (sceneId === 'snow-night') {
            stage.innerHTML = `
                <div class="vk-lantern-eave vk-lantern-eave-right">
                    <div class="vk-lantern-hanger is-compact">
                        <div class="vk-lantern-halo"></div>
                        ${buildSeasonalCornerSvg('snow-night', { width: 38, height: 70 })}
                    </div>
                    <div class="vk-lantern-hanger">
                        <div class="vk-lantern-halo"></div>
                        ${buildSeasonalCornerSvg('snow-night', { width: 52, height: 92 })}
                    </div>
                </div>
            `;
        } else if (sceneId === 'christmas-eve') {
            stage.innerHTML = `
                <div class="vk-lantern-eave vk-lantern-eave-right">
                    <div class="vk-lantern-hanger is-compact">
                        <div class="vk-lantern-halo"></div>
                        ${buildSeasonalCornerSvg('snow-night', { width: 36, height: 68 })}
                    </div>
                    <div class="vk-lantern-hanger">
                        <div class="vk-lantern-halo"></div>
                        ${buildSeasonalCornerSvg('christmas-eve', { width: 52, height: 96 })}
                    </div>
                </div>
            `;
        } else {
            stage.innerHTML = `
                <div class="vk-lantern-eave vk-lantern-eave-right">
                    <div class="vk-lantern-hanger is-compact">
                        <div class="vk-lantern-halo"></div>
                        ${buildChineseLanternSvg({ width: 38, height: 74, variant: 'lotus', cordLength: 10 })}
                    </div>
                    <div class="vk-lantern-hanger">
                        <div class="vk-lantern-halo"></div>
                        ${buildChineseLanternSvg({ width: 50, height: 96, variant: 'palace', cordLength: 18 })}
                    </div>
                </div>
            `;
        }
    }

    if (!stage) {
        stage = doc.createElement('div');
        stage.id = 'vk-lantern-stage';
        stage.setAttribute('aria-hidden', 'true');
        renderStageOrnaments(currentScene);
        doc.body.appendChild(stage);
    }

    function updateEmptyPreview(sceneId) {
        const placeholder = doc.getElementById('reels-preview-placeholder');
        if (!placeholder) return;
        const meta = SCENE_STAGE_GREETINGS[sceneId] || SCENE_STAGE_GREETINGS['christmas-eve'];
        const existingPoetic = placeholder.querySelector?.('.vk-preview-poetic-empty');
        if (!existingPoetic) {
            const poetic = doc.createElement('div');
            poetic.className = 'vk-preview-poetic-empty';
            poetic.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;user-select:none;';
            const initOrnament = (sceneId === 'starry-lantern' || sceneId === 'starry-ink')
                ? buildChineseLanternSvg({ width: 44, height: 84, variant: 'lotus', cordLength: 12 })
                : buildSeasonalCornerSvg(sceneId, { width: 46, height: 86 });
            poetic.innerHTML = `
                <div class="vk-preview-ornament" style="opacity:0.9;filter:drop-shadow(0 0 14px rgba(246,178,75,0.28));">
                    ${initOrnament}
                </div>
                <div class="vk-preview-title" style="font-size:12.5px;font-weight:600;letter-spacing:0.4px;color:${meta.color};">${meta.title}</div>
                <div class="vk-preview-sub" style="font-size:11px;color:rgba(203,213,225,0.68);">${meta.sub}</div>
            `;
            placeholder.textContent = '';
            placeholder.appendChild(poetic);
        } else {
            const ornEl = existingPoetic.querySelector('.vk-preview-ornament');
            const titleEl = existingPoetic.querySelector('.vk-preview-title');
            const subEl = existingPoetic.querySelector('.vk-preview-sub');
            if (ornEl) {
                ornEl.innerHTML = (sceneId === 'starry-lantern' || sceneId === 'starry-ink')
                    ? buildChineseLanternSvg({ width: 44, height: 84, variant: 'lotus', cordLength: 12 })
                    : buildSeasonalCornerSvg(sceneId, { width: 46, height: 86 });
            }
            if (titleEl) {
                titleEl.style.color = meta.color;
                titleEl.textContent = meta.title;
            }
            if (subEl) subEl.textContent = meta.sub;
        }
    }

    updateEmptyPreview(currentScene);

    return {
        setMode(modeId) {
            const safeMode = LANTERN_MODES[modeId] ? modeId : 'lit';
            doc.body.setAttribute('data-lantern-mode', safeMode);
        },
        setSceneTheme(themeId) {
            const next = SCENE_STAGE_GREETINGS[themeId] ? themeId : 'christmas-eve';
            if (next !== currentScene) {
                currentScene = next;
                renderStageOrnaments(currentScene);
                updateEmptyPreview(currentScene);
            }
        },
        destroy() {
            stage?.remove();
        },
    };
}
