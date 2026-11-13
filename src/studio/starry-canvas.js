/**
 * starry-canvas.js — Quiet Atmospheric Sky Canvas (Night / Autumn / Snow / Christmas)
 * 极低功耗静谧场景画布：夜景星空 · 暮秋红枫 · 静冬雪夜 · 圣诞暖夜（24fps限频 + 离开窗口自动休眠）
 */

const ATMOSPHERIC_SCENES = {
    'starry-lantern': {
        sky: ['#04060e', '#070b17', '#0b1122'],
        nebula: ['rgba(67, 118, 206, 0.075)', 'rgba(42, 66, 138, 0.032)', 'rgba(4, 6, 14, 0)'],
        cornerGlow: ['rgba(255, 186, 73, 0.14)', 'rgba(232, 93, 53, 0.045)'],
        starPalette: ['#f8fafc', '#e2e8f0', '#cfe2ff', '#fef3c7', '#fde68a'],
        effect: 'night_lantern',
    },
    'starry-ink': {
        sky: ['#04060f', '#070c1a', '#0c1328'],
        nebula: ['rgba(96, 165, 250, 0.08)', 'rgba(67, 56, 202, 0.03)', 'rgba(4, 6, 14, 0)'],
        cornerGlow: null,
        starPalette: ['#f8fafc', '#e0f2fe', '#bfdbfe', '#dbeafe', '#c7d2fe'],
        effect: 'night_pure',
    },
    'autumn-night': {
        sky: ['#090505', '#130b09', '#1b0f0a'],
        nebula: ['rgba(234, 140, 66, 0.085)', 'rgba(180, 65, 42, 0.035)', 'rgba(9, 5, 5, 0)'],
        cornerGlow: ['rgba(245, 158, 11, 0.16)', 'rgba(217, 72, 59, 0.055)'],
        starPalette: ['#fff7ed', '#fed7aa', '#fdba74', '#fde68a', '#fecaca'],
        effect: 'autumn_leaves',
    },
    'snow-night': {
        sky: ['#040812', '#081222', '#0d1b30'],
        nebula: ['rgba(125, 211, 252, 0.085)', 'rgba(56, 189, 248, 0.032)', 'rgba(4, 8, 18, 0)'],
        cornerGlow: ['rgba(186, 230, 253, 0.13)', 'rgba(125, 211, 252, 0.04)'],
        starPalette: ['#f8fafc', '#e0f2fe', '#bae6fd', '#dbeafe', '#ffffff'],
        effect: 'winter_snow',
    },
    'christmas-eve': {
        sky: ['#040907', '#081510', '#0e2018'],
        nebula: ['rgba(245, 196, 81, 0.075)', 'rgba(22, 101, 52, 0.05)', 'rgba(4, 9, 7, 0)'],
        cornerGlow: ['rgba(245, 196, 81, 0.16)', 'rgba(217, 72, 72, 0.055)'],
        starPalette: ['#fffbeb', '#fde68a', '#fecaca', '#d1fae5', '#ffffff'],
        effect: 'christmas_snow',
    },
};

export function createStarryBackdrop(options = {}) {
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const win = options.window || (typeof window !== 'undefined' ? window : null);
    if (!doc || !doc.body) {
        return { destroy() {}, setMode() {}, renderOnce() {}, refreshVisibility() {} };
    }

    let canvas = doc.getElementById('vk-starry-canvas');
    if (!canvas) {
        canvas = doc.createElement('canvas');
        canvas.id = 'vk-starry-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        doc.body.insertBefore(canvas, doc.body.firstChild);
    }

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
        return { destroy() {}, setMode() {}, renderOnce() {} };
    }

    let mode = options.mode || 'lit'; // 'lit' | 'calm' | 'off'
    let rafId = 0;
    let lastPaintTime = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let destroyed = false;

    const prefersReducedMotion = () =>
        Boolean(win?.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);

    const getActiveSceneId = () => {
        const cl = doc.body?.classList;
        if (!cl) return null;
        for (const id of Object.keys(ATMOSPHERIC_SCENES)) {
            if (cl.contains(`theme-${id}`)) return id;
        }
        return null;
    };

    const isThemeVisible = () => Boolean(getActiveSceneId());

    const stars = Array.from({ length: 138 }, (_, idx) => {
        const seed = (idx * 9301 + 49297) % 233280 / 233280;
        const seed2 = ((idx + 17) * 7919 + 104729) % 233280 / 233280;
        const seed3 = ((idx + 53) * 4253 + 31991) % 233280 / 233280;
        return {
            xRatio: seed,
            yRatio: seed2,
            radius: 0.45 + Math.pow(seed3, 2) * 1.45,
            baseAlpha: 0.16 + seed3 * 0.56,
            twinkleAmp: 0.08 + seed * 0.24,
            speed: 0.35 + seed2 * 0.75,
            phase: seed3 * Math.PI * 2,
            paletteIdx: idx % 5,
            hasCrossGlow: idx % 19 === 0,
        };
    });

    const fireflies = Array.from({ length: 18 }, (_, idx) => {
        const s1 = ((idx + 7) * 6133 + 12347) % 10000 / 10000;
        const s2 = ((idx + 29) * 3571 + 49157) % 10000 / 10000;
        const sideRight = idx % 2 === 0;
        const xBase = sideRight ? (0.72 + s1 * 0.26) : (0.02 + s1 * 0.24);
        return {
            xRatio: xBase,
            yRatio: s2,
            radius: 1.0 + (idx % 3) * 0.55,
            vy: 0.002 + s1 * 0.004,
            swayFreq: 0.4 + s2 * 0.5,
            phase: idx * 0.9,
            isCrimson: idx % 5 === 0,
        };
    });

    const mapleColors = ['#e05a47', '#ea8c42', '#d9483b', '#f59e0b', '#c2410c'];
    const mapleLeaves = Array.from({ length: 20 }, (_, idx) => {
        const s1 = ((idx + 11) * 7331 + 19417) % 10000 / 10000;
        const s2 = ((idx + 37) * 4813 + 38291) % 10000 / 10000;
        const sideRight = idx % 2 === 0;
        return {
            xRatio: sideRight ? (0.74 + s1 * 0.24) : (0.02 + s1 * 0.24),
            yRatio: s2,
            size: 3.8 + (idx % 3) * 1.6,
            vy: 0.008 + s1 * 0.009,
            swayAmp: 16 + s2 * 18,
            swayFreq: 0.55 + s1 * 0.45,
            rotSpeed: (idx % 2 === 0 ? 1 : -1) * (0.45 + s2 * 0.55),
            phase: idx * 1.15,
            color: mapleColors[idx % mapleColors.length],
        };
    });

    const snowflakes = Array.from({ length: 38 }, (_, idx) => {
        const s1 = ((idx + 13) * 5113 + 27191) % 10000 / 10000;
        const s2 = ((idx + 41) * 8291 + 14983) % 10000 / 10000;
        // Edge-weighted distribution keeps central video canvas crisp and clean
        const edgeBand = idx % 5 !== 0;
        const xRatio = edgeBand
            ? (idx % 2 === 0 ? 0.72 + s1 * 0.26 : 0.02 + s1 * 0.26)
            : (0.28 + s1 * 0.44);
        return {
            xRatio,
            yRatio: s2,
            radius: edgeBand ? (1.1 + (idx % 3) * 0.65) : (0.85 + (idx % 2) * 0.4),
            baseAlpha: edgeBand ? (0.22 + s1 * 0.35) : (0.10 + s1 * 0.14),
            vy: 0.011 + s1 * 0.014,
            swayAmp: 10 + s2 * 14,
            swayFreq: 0.5 + s2 * 0.6,
            phase: idx * 0.85,
            isCrispFlake: idx % 7 === 0,
        };
    });

    let shootingStar = null;
    let nextShootAt = 8000;

    function resize() {
        dpr = Math.min(win?.devicePixelRatio || 1, 1.5);
        width = Math.max(320, win?.innerWidth || 1280);
        height = Math.max(240, win?.innerHeight || 800);
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
    }

    function drawLeafShape(cx, cy, size, angle, color, alpha) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const pts = [
            [0, -1.2],
            [0.35, -0.45],
            [1.05, -0.35],
            [0.45, 0.15],
            [0.7, 0.85],
            [0, 0.45],
            [-0.7, 0.85],
            [-0.45, 0.15],
            [-1.05, -0.35],
            [-0.35, -0.45],
        ];
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
            const px = pts[i][0] * size;
            const py = pts[i][1] * size;
            const rx = cx + px * cos - py * sin;
            const ry = cy + px * sin + py * cos;
            if (i === 0) ctx.moveTo(rx, ry);
            else ctx.lineTo(rx, ry);
        }
        ctx.fill();
    }

    function drawFrame(nowMs, staticMode = false) {
        if (destroyed || !width || !height) return;
        const sceneId = getActiveSceneId() || 'christmas-eve';
        const palette = ATMOSPHERIC_SCENES[sceneId] || ATMOSPHERIC_SCENES['christmas-eve'];

        ctx.save();
        ctx.scale(dpr, dpr);

        // Deep quiet atmospheric sky gradient
        const skyGrad = ctx.createLinearGradient(0, 0, width * 0.25, height);
        skyGrad.addColorStop(0, palette.sky[0]);
        skyGrad.addColorStop(0.52, palette.sky[1]);
        skyGrad.addColorStop(1, palette.sky[2]);
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, width, height);

        // Subtle atmospheric diagonal glow
        const nebulaGrad = ctx.createRadialGradient(
            width * 0.68, height * 0.28, 20,
            width * 0.68, height * 0.28, Math.max(width, height) * 0.58
        );
        nebulaGrad.addColorStop(0, palette.nebula[0]);
        nebulaGrad.addColorStop(0.5, palette.nebula[1]);
        nebulaGrad.addColorStop(1, palette.nebula[2]);
        ctx.fillStyle = nebulaGrad;
        ctx.fillRect(0, 0, width, height);

        // Soft corner warm / frost ornament glow when scene accent is active
        const isOrnamentLit = mode !== 'off' && Boolean(palette.cornerGlow);
        if (isOrnamentLit) {
            const glowGrad = ctx.createRadialGradient(width - 70, 54, 6, width - 70, 54, 340);
            glowGrad.addColorStop(0, palette.cornerGlow[0]);
            glowGrad.addColorStop(0.45, palette.cornerGlow[1]);
            glowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
            ctx.fillStyle = glowGrad;
            ctx.fillRect(0, 0, width, height);
        }

        const t = staticMode ? 0 : nowMs * 0.001;

        // Stars
        for (const s of stars) {
            const x = s.xRatio * width;
            const y = s.yRatio * height;
            const pulse = staticMode ? 0 : Math.sin(t * s.speed + s.phase) * s.twinkleAmp;
            const alpha = Math.max(0.06, Math.min(0.95, s.baseAlpha + pulse));
            ctx.globalAlpha = alpha;
            ctx.fillStyle = palette.starPalette[s.paletteIdx % palette.starPalette.length];
            ctx.beginPath();
            ctx.arc(x, y, s.radius, 0, Math.PI * 2);
            ctx.fill();

            if (s.hasCrossGlow && alpha > 0.45) {
                ctx.globalAlpha = alpha * 0.35;
                ctx.fillRect(x - s.radius * 3, y - 0.35, s.radius * 6, 0.7);
                ctx.fillRect(x - 0.35, y - s.radius * 3, 0.7, s.radius * 6);
            }
        }

        // Scene-specific quiet atmospheric particles when lit
        if (!staticMode && mode === 'lit') {
            if (palette.effect === 'autumn_leaves') {
                for (const lf of mapleLeaves) {
                    const yWrap = ((lf.yRatio + t * lf.vy) % 1 + 1) % 1;
                    const xDrift = Math.sin(t * lf.swayFreq + lf.phase) * lf.swayAmp;
                    const lx = lf.xRatio * width + xDrift;
                    const ly = yWrap * height;
                    const angle = Math.sin(t * lf.rotSpeed + lf.phase) * 0.95;
                    const alpha = 0.24 + 0.14 * Math.sin(t * 0.9 + lf.phase);
                    drawLeafShape(lx, ly, lf.size, angle, lf.color, alpha);
                }
            } else if (palette.effect === 'winter_snow' || palette.effect === 'christmas_snow') {
                for (const sf of snowflakes) {
                    const yWrap = ((sf.yRatio + t * sf.vy) % 1 + 1) % 1;
                    const xDrift = Math.sin(t * sf.swayFreq + sf.phase) * sf.swayAmp;
                    const sx = sf.xRatio * width + xDrift;
                    const sy = yWrap * height;
                    ctx.globalAlpha = sf.baseAlpha;
                    ctx.fillStyle = '#e8f4ff';
                    ctx.beginPath();
                    ctx.arc(sx, sy, sf.radius, 0, Math.PI * 2);
                    ctx.fill();
                    if (sf.isCrispFlake) {
                        ctx.globalAlpha = sf.baseAlpha * 0.5;
                        ctx.fillRect(sx - sf.radius * 2.2, sy - 0.35, sf.radius * 4.4, 0.7);
                        ctx.fillRect(sx - 0.35, sy - sf.radius * 2.2, 0.7, sf.radius * 4.4);
                    }
                }
                if (palette.effect === 'christmas_snow') {
                    for (const f of fireflies) {
                        const fy = f.yRatio * height;
                        const fx = f.xRatio * width;
                        const fa = 0.10 + 0.18 * (0.5 + 0.5 * Math.sin(t * 1.1 + f.phase));
                        ctx.globalAlpha = fa;
                        ctx.fillStyle = f.isCrimson ? '#f87171' : '#f5c451';
                        ctx.beginPath();
                        ctx.arc(fx, fy, f.radius * 1.35, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            } else if (palette.effect === 'night_lantern') {
                for (const f of fireflies) {
                    const yWrap = ((f.yRatio - t * f.vy) % 1 + 1) % 1;
                    const xDrift = Math.sin(t * f.swayFreq + f.phase) * 14;
                    const fx = f.xRatio * width + xDrift;
                    const fy = yWrap * height;
                    const fa = 0.12 + 0.22 * (0.5 + 0.5 * Math.sin(t * 1.4 + f.phase));
                    ctx.globalAlpha = fa;
                    ctx.fillStyle = '#fbbf24';
                    ctx.beginPath();
                    ctx.arc(fx, fy, f.radius, 0, Math.PI * 2);
                    ctx.fill();
                }

                // Rare quiet shooting star
                if (!shootingStar && nowMs >= nextShootAt) {
                    shootingStar = {
                        startX: width * (0.28 + Math.random() * 0.48),
                        startY: height * (0.08 + Math.random() * 0.18),
                        vx: 380 + Math.random() * 140,
                        vy: 135 + Math.random() * 70,
                        bornAt: nowMs,
                        lifeMs: 850,
                    };
                    nextShootAt = nowMs + 18000 + Math.random() * 14000;
                }
                if (shootingStar) {
                    const age = nowMs - shootingStar.bornAt;
                    if (age >= shootingStar.lifeMs) {
                        shootingStar = null;
                    } else {
                        const p = age / shootingStar.lifeMs;
                        const fade = Math.sin(p * Math.PI);
                        const headX = shootingStar.startX + shootingStar.vx * (age / 1000);
                        const headY = shootingStar.startY + shootingStar.vy * (age / 1000);
                        const tailX = headX - shootingStar.vx * 0.14;
                        const tailY = headY - shootingStar.vy * 0.14;
                        const shootGrad = ctx.createLinearGradient(tailX, tailY, headX, headY);
                        shootGrad.addColorStop(0, 'rgba(226, 232, 240, 0)');
                        shootGrad.addColorStop(1, `rgba(254, 243, 199, ${(0.55 * fade).toFixed(3)})`);
                        ctx.globalAlpha = 1;
                        ctx.strokeStyle = shootGrad;
                        ctx.lineWidth = 1.4;
                        ctx.beginPath();
                        ctx.moveTo(tailX, tailY);
                        ctx.lineTo(headX, headY);
                        ctx.stroke();
                    }
                }
            }
        }

        ctx.restore();
    }

    function loop(now) {
        if (destroyed) return;
        rafId = 0;

        if (doc.hidden || !isThemeVisible()) {
            return;
        }

        const isStatic = mode === 'calm' || mode === 'off' || prefersReducedMotion();
        if (isStatic) {
            drawFrame(now, true);
            return;
        }

        if (now - lastPaintTime >= 42) {
            lastPaintTime = now;
            drawFrame(now, false);
        }
        rafId = win.requestAnimationFrame(loop);
    }

    function kick() {
        if (destroyed || !win?.requestAnimationFrame) return;
        if (!rafId && !doc.hidden && isThemeVisible()) {
            rafId = win.requestAnimationFrame(loop);
        }
    }

    const onVisibility = () => {
        if (!doc.hidden) kick();
    };
    const onResize = () => {
        resize();
        drawFrame(performance.now(), mode !== 'lit');
    };

    resize();
    doc.addEventListener('visibilitychange', onVisibility);
    win?.addEventListener('resize', onResize);

    // Paint initial static night sky synchronously to avoid any dark flash, then start gentle loop
    drawFrame(0, mode !== 'lit');
    kick();

    return {
        setMode(nextMode) {
            mode = nextMode || 'lit';
            drawFrame(performance.now(), mode !== 'lit');
            if (mode === 'lit') kick();
        },
        renderOnce() {
            resize();
            drawFrame(performance.now(), mode !== 'lit');
        },
        refreshVisibility: kick,
        destroy() {
            destroyed = true;
            if (rafId && win?.cancelAnimationFrame) win.cancelAnimationFrame(rafId);
            doc.removeEventListener('visibilitychange', onVisibility);
            win?.removeEventListener('resize', onResize);
            canvas?.remove();
        },
    };
}
