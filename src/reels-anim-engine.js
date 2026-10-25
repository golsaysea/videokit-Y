/**
 * reels-anim-engine.js — Stateless per-frame animation computation for subtitles & text overlays.
 * 
 * ✅ 完整移植自 AutoSub_v8/core/anim_engine.py
 * All functions are pure: given current_time and timing parameters,
 * they return a value that the renderer can use directly.
 * No state machines, no caches, no side effects.
 */

// ───────────────────────────────────────────────────────
// 1.  Easing Functions   (input t ∈ [0, 1] → output ∈ [0, 1])
// ───────────────────────────────────────────────────────

function linear(t) { return t; }

function easeInCubic(t) { return t * t * t; }

function easeOutCubic(t) { return 1.0 - Math.pow(1.0 - t, 3); }

function easeInOutCubic(t) {
    return t < 0.5 ? 4.0 * t * t * t : 1.0 - Math.pow(-2.0 * t + 2.0, 3) / 2.0;
}

function easeOutBounce(t) {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1.0 / d1) return n1 * t * t;
    if (t < 2.0 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
    if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
    t -= 2.625 / d1; return n1 * t * t + 0.984375;
}

function easeOutElastic(t) {
    if (t <= 0.0) return 0.0;
    if (t >= 1.0) return 1.0;
    const c4 = (2.0 * Math.PI) / 3.0;
    return Math.pow(2.0, -10.0 * t) * Math.sin((t * 10.0 - 0.75) * c4) + 1.0;
}

function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1.0;
    return 1.0 + c3 * Math.pow(t - 1.0, 3) + c1 * Math.pow(t - 1.0, 2);
}

function easeInBack(t) {
    const c1 = 1.70158, c3 = c1 + 1.0;
    return c3 * t * t * t - c1 * t * t;
}

function easeInOutBack(t) {
    const c1 = 1.70158, c2 = c1 * 1.525;
    if (t < 0.5) return (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2;
    return (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
}

function easeInQuad(t) { return t * t; }
function easeOutQuad(t) { return 1.0 - Math.pow(1.0 - t, 2); }

function easeInOutQuad(t) {
    return t < 0.5 ? 2.0 * t * t : 1.0 - Math.pow(-2.0 * t + 2.0, 2) / 2.0;
}

function easeOutExpo(t) {
    return t >= 1.0 ? 1.0 : 1.0 - Math.pow(2.0, -10.0 * t);
}

function easeInOutExpo(t) {
    if (t <= 0.0) return 0.0;
    if (t >= 1.0) return 1.0;
    return t < 0.5
        ? Math.pow(2.0, 20.0 * t - 10.0) / 2.0
        : (2.0 - Math.pow(2.0, -20.0 * t + 10.0)) / 2.0;
}

const EASING_MAP = {
    linear,
    ease_in: easeInCubic,
    ease_out: easeOutCubic,
    ease_in_out: easeInOutCubic,
    ease_in_quad: easeInQuad,
    ease_out_quad: easeOutQuad,
    ease_in_out_quad: easeInOutQuad,
    ease_out_expo: easeOutExpo,
    ease_in_out_expo: easeInOutExpo,
    bounce: easeOutBounce,
    elastic: easeOutElastic,
    back: easeOutBack,
    back_in_out: easeInOutBack,
};

// Chinese labels → internal names (used by UI combo boxes)
const EASING_LABELS = [
    ['线性', 'linear'],
    ['渐出(柔和)', 'ease_out'],
    ['渐入', 'ease_in'],
    ['渐入渐出', 'ease_in_out'],
    ['渐出(轻)', 'ease_out_quad'],
    ['渐入渐出(轻)', 'ease_in_out_quad'],
    ['渐出(快)', 'ease_out_expo'],
    ['渐入渐出(快)', 'ease_in_out_expo'],
    ['弹跳', 'bounce'],
    ['弹性', 'elastic'],
    ['回弹', 'back'],
    ['回弹渐入渐出', 'back_in_out'],
];

// Animation type labels (Chinese → internal)
const ANIM_TYPE_LABELS = [
    ['无', 'none'],
    ['淡入淡出', 'fade'],
    ['上滑', 'slide_up'],
    ['下滑', 'slide_down'],
    ['左滑', 'slide_left'],
    ['右滑', 'slide_right'],
    ['弹出', 'pop'],
    ['打字机', 'typewriter'],
    ['逐字弹跳', 'char_bounce'],
    ['逐字放大', 'letter_jump'],
    ['逐字上浮', 'char_float_up'],
    ['逐字弹性放大', 'char_pop_elastic'],
    ['逐字波浪', 'char_wave'],
    ['逐字落下回弹', 'char_drop_bounce'],
    ['逐字挤压弹跳', 'char_squash_bounce'],
    ['中心扩散', 'char_center_spread'],
    ['逐词弹出(随机)', 'word_pop_random'],
    ['逐词弹出(回弹)', 'word_pop_random_pulse'],
    ['节奏逐词', 'metronome'],
    ['模糊渐清', 'blur_sharp'],
    ['圣光', 'holy_glow'],
    ['漂浮', 'floating'],
    ['逐行出现', 'bullet_reveal'],
    ['底条进度擦除', 'box_wipe'],
    ['远景打字推进', 'zoom_typewriter'],
    ['闪光高亮', 'flash_highlight'],
];

const CHAR_ANIM_TYPES = [
    'char_float_up',
    'char_pop_elastic',
    'char_wave',
    'char_drop_bounce',
    'char_squash_bounce',
    'char_center_spread',
];

function isCharAnimType(type) {
    return CHAR_ANIM_TYPES.includes(type);
}

// Transition presets for video/image/text clips
const DEFAULT_TRANSITION_DURATION = 0.35;

const TRANSITION_PRESETS = [
    ['无', 'none'],
    ['淡入淡出(仅开头)', 'fade_in'],
    ['淡入淡出(仅结尾)', 'fade_out'],
    ['淡入淡出(双向)', 'fade_both'],
    ['突入突出(仅开头)', 'pop_in'],
    ['突入突出(仅结尾)', 'pop_out'],
    ['突入突出(双向)', 'pop_both'],
    ['左摇右晃(仅开头)', 'sway_in'],
    ['左摇右晃(仅结尾)', 'sway_out'],
    ['左摇右晃(双向)', 'sway_both'],
    ['左滑(仅开头)', 'slide_left_in'],
    ['右滑(仅开头)', 'slide_right_in'],
    ['上滑(仅开头)', 'slide_up_in'],
    ['下滑(仅开头)', 'slide_down_in'],
    ['左滑(仅结尾)', 'slide_left_out'],
    ['右滑(仅结尾)', 'slide_right_out'],
    ['上滑(仅结尾)', 'slide_up_out'],
    ['下滑(仅结尾)', 'slide_down_out'],
    ['左滑(双向)', 'slide_left_both'],
    ['右滑(双向)', 'slide_right_both'],
    ['上滑(双向)', 'slide_up_both'],
    ['下滑(双向)', 'slide_down_both'],
];

function _getEasing(name) {
    return EASING_MAP[name] || easeOutCubic;
}

// ───────────────────────────────────────────────────────
// 2.  Core progress computation
// ───────────────────────────────────────────────────────

/**
 * Compute a visibility progress value in [0.0, 1.0].
 * @returns {[number, number]} [inProgress, outProgress]
 */
function computeAnimProgress(currentTime, segStart, segEnd,
    animInDur, animOutDur,
    easingIn = 'ease_out', easingOut = 'ease_in_out') {
    animInDur = Math.max(0.0, Number(animInDur));
    animOutDur = Math.max(0.0, Number(animOutDur));

    const dtFromStart = currentTime - segStart;
    const dtToEnd = segEnd - currentTime;

    let inProgress = 1.0;
    if (animInDur > 0 && dtFromStart < animInDur) {
        const raw = Math.max(0.0, Math.min(1.0, dtFromStart / animInDur));
        inProgress = _getEasing(easingIn)(raw);
    }

    let outProgress = 1.0;
    if (animOutDur > 0 && dtToEnd < animOutDur) {
        const raw = Math.max(0.0, Math.min(1.0, dtToEnd / animOutDur));
        outProgress = _getEasing(easingOut)(raw);
    }

    return [inProgress, outProgress];
}

/**
 * Return the number of revealed characters (int) for a typewriter effect.
 */
function computeTypewriterProgress(currentTime, segStart, segEnd, totalChars, twSpeed = 1.0) {
    if (totalChars <= 0) return 0;
    const segDur = Math.max(0.001, segEnd - segStart);
    const elapsed = Math.max(0.0, currentTime - segStart);
    const revealDur = segDur / Math.max(0.1, twSpeed);
    const frac = Math.min(1.0, elapsed / revealDur);
    return Math.floor(frac * totalChars);
}

/**
 * Return a vertical offset (pixels, negative = up) for a single character
 * in a staggered bounce animation.
 */
function computeCharBounceOffset(currentTime, charIndex, segStart, segDur,
    totalChars, bounceHeight = 20, stagger = 0.05, easingName = 'bounce') {
    const bounceDur = 0.3;
    const charStart = segStart + charIndex * stagger;
    const dt = currentTime - charStart;
    if (dt < 0) return 0.0;
    if (dt > bounceDur) return 0.0;
    const raw = dt / bounceDur;
    const eased = _getEasing(easingName)(raw);
    return -bounceHeight * Math.sin(Math.PI * eased);
}

/**
 * Compute per-character animation transform { dx, dy, scaleX, scaleY, alpha }
 * for extended T-subtitle per-char animations:
 * - char_float_up (逐字上浮)
 * - char_pop_elastic (逐字弹性放大)
 * - char_wave (逐字波浪)
 * - char_drop_bounce (逐字落下回弹)
 * - char_squash_bounce (逐字挤压弹跳)
 * - char_center_spread (中心扩散)
 */
function computeCharAnimTransform(type, currentTime, charIndex, totalChars, segStart, segEnd, opts = {}) {
    const intensity = Math.max(0.1, Math.min(4.0, Number(opts.intensity ?? 1.0) || 1.0));
    const charDur = Math.max(0.05, Math.min(3.0, Number(opts.duration ?? 0.28) || 0.28));
    const stagger = Math.max(0.0, Math.min(1.0, Number(opts.stagger ?? 0.04) ?? 0.04));
    const fontSize = Math.max(12, Number(opts.fontSize || 74));
    const count = Math.max(1, totalChars || 1);

    if (currentTime == null || !Number.isFinite(currentTime)) {
        return { dx: 0, dy: 0, scaleX: 1, scaleY: 1, alpha: 1 };
    }

    if (type === 'char_center_spread') {
        const centerIdx = (count - 1) / 2;
        const distFromCenter = Math.abs(charIndex - centerIdx);
        const signed = charIndex - centerIdx;
        const charStart = segStart + distFromCenter * stagger;
        const dt = currentTime - charStart;
        if (dt <= 0) {
            return { dx: -signed * fontSize * 0.38 * intensity, dy: 0, scaleX: 0.15, scaleY: 0.15, alpha: 0 };
        }
        if (dt >= charDur) {
            return { dx: 0, dy: 0, scaleX: 1, scaleY: 1, alpha: 1 };
        }
        const t = dt / charDur;
        const ePos = easeOutCubic(t);
        const eScale = easeOutBack(t);
        return {
            dx: -signed * (fontSize * 0.38 * intensity) * (1 - ePos),
            dy: 0,
            scaleX: Math.max(0.08, 0.2 + 0.8 * eScale),
            scaleY: Math.max(0.08, 0.2 + 0.8 * eScale),
            alpha: Math.min(1, easeOutQuad(Math.min(1, t * 1.4))),
        };
    }

    const charStart = segStart + charIndex * stagger;
    const dt = currentTime - charStart;

    if (type === 'char_float_up') {
        const offsetPx = fontSize * 0.45 * intensity;
        if (dt <= 0) return { dx: 0, dy: offsetPx, scaleX: 1, scaleY: 1, alpha: 0 };
        if (dt >= charDur) return { dx: 0, dy: 0, scaleX: 1, scaleY: 1, alpha: 1 };
        const t = dt / charDur;
        const e = easeOutCubic(t);
        return {
            dx: 0,
            dy: (1 - e) * offsetPx,
            scaleX: 1,
            scaleY: 1,
            alpha: Math.min(1, easeOutQuad(Math.min(1, t * 1.35))),
        };
    }

    if (type === 'char_pop_elastic') {
        if (dt <= 0) return { dx: 0, dy: 0, scaleX: 0.01, scaleY: 0.01, alpha: 0 };
        if (dt >= charDur) return { dx: 0, dy: 0, scaleX: 1, scaleY: 1, alpha: 1 };
        const t = dt / charDur;
        const base = easeOutQuad(Math.min(1, t * 2.2));
        const overshoot = 1 + 0.42 * intensity * Math.pow(2, -6.5 * t) * Math.sin(t * 2.2 * Math.PI);
        const sc = Math.max(0.05, base * overshoot);
        return {
            dx: 0,
            dy: 0,
            scaleX: sc,
            scaleY: sc,
            alpha: Math.min(1, t * 3.0),
        };
    }

    if (type === 'char_wave') {
        const waveWindow = charDur * 1.6;
        if (dt <= 0 || dt >= waveWindow) return { dx: 0, dy: 0, scaleX: 1, scaleY: 1, alpha: 1 };
        const phase = (dt / Math.max(0.08, charDur)) * Math.PI * 2;
        const env = Math.sin(Math.min(1, dt / waveWindow) * Math.PI);
        const dy = -Math.sin(phase) * (fontSize * 0.30 * intensity) * env;
        return { dx: 0, dy, scaleX: 1, scaleY: 1, alpha: 1 };
    }

    if (type === 'char_drop_bounce') {
        const dropPx = fontSize * 0.65 * intensity;
        if (dt <= 0) return { dx: 0, dy: -dropPx, scaleX: 1, scaleY: 1, alpha: 0 };
        if (dt >= charDur) return { dx: 0, dy: 0, scaleX: 1, scaleY: 1, alpha: 1 };
        const t = dt / charDur;
        const b = easeOutBounce(t);
        return {
            dx: 0,
            dy: -(1 - b) * dropPx,
            scaleX: 1,
            scaleY: 1,
            alpha: Math.min(1, t * 3.2),
        };
    }

    if (type === 'char_squash_bounce') {
        if (dt <= 0) return { dx: 0, dy: fontSize * 0.32 * intensity, scaleX: 1.25, scaleY: 0.65, alpha: 0 };
        if (dt >= charDur) return { dx: 0, dy: 0, scaleX: 1, scaleY: 1, alpha: 1 };
        const t = dt / charDur;
        const dy = -Math.sin(t * Math.PI) * (fontSize * 0.36 * intensity) * (1 - t * 0.35);
        const sq = Math.sin(t * Math.PI * 2.5) * Math.pow(1 - t, 1.4) * 0.32 * intensity;
        return {
            dx: 0,
            dy,
            scaleX: Math.max(0.4, 1 - sq),
            scaleY: Math.max(0.4, 1 + sq),
            alpha: Math.min(1, t * 3.5),
        };
    }

    return { dx: 0, dy: 0, scaleX: 1, scaleY: 1, alpha: 1 };
}

/**
 * Return a scale factor for the dynamic highlight box.
 */
function computeDynBoxScale(currentTime, wordStart, wordEnd,
    overshoot = 1.3, animDuration = 0.15, easingName = 'back') {
    const dt = currentTime - wordStart;
    if (dt < 0) return 0.0;
    if (animDuration <= 0) return 1.0;
    if (dt >= animDuration) return 1.0;
    const raw = dt / animDuration;
    return _getEasing(easingName)(raw);
}

/**
 * Given progress (0→1), return [dx, dy] pixel offset for slide animations.
 * @param {number} progress - Animation progress (0 to 1)
 * @param {string} slideType - 'slide_up' | 'slide_down' | 'slide_left' | 'slide_right'
 * @param {number} distance - Movement distance in pixels
 * @param {boolean} isExit - True if this is an exit animation
 */
function computeSlideOffset(progress, slideType, distance = 80, isExit = false) {
    const p = Math.max(0.0, Math.min(1.0, progress));
    const smooth = p * p * (3.0 - 2.0 * p); // smoothstep
    const remaining = 1.0 - smooth;
    if (isExit) {
        if (slideType === 'slide_up') return [0.0, -remaining * distance];
        if (slideType === 'slide_down') return [0.0, remaining * distance];
        if (slideType === 'slide_left') return [-remaining * distance, 0.0];
        if (slideType === 'slide_right') return [remaining * distance, 0.0];
    } else {
        if (slideType === 'slide_up') return [0.0, remaining * distance];
        if (slideType === 'slide_down') return [0.0, -remaining * distance];
        if (slideType === 'slide_left') return [remaining * distance, 0.0];
        if (slideType === 'slide_right') return [-remaining * distance, 0.0];
    }
    return [0.0, 0.0];
}

/**
 * Given progress 0→1, return a scale factor for pop/zoom animation.
 */
function computePopScale(progress, overshoot = 1.15) {
    if (progress >= 1.0) return 1.0;
    if (progress <= 0.0) return 0.0;
    return easeOutBack(progress);
}

function _parseTransitionPreset(preset) {
    if (!preset || preset === 'none') return [null, null];
    const parts = String(preset).split('_');
    if (parts.length >= 2 && ['in', 'out', 'both'].includes(parts[parts.length - 1])) {
        const scope = parts[parts.length - 1];
        const typeName = parts.slice(0, -1).join('_');
        return [typeName, scope];
    }
    return [String(preset), 'both'];
}

/**
 * Return an inertial left-right sway offset (pixels).
 */
function computeSwayOffset(progress, amplitude = 24.0, cycles = 2.5, decay = 4.0) {
    const p = Math.max(0.0, Math.min(1.0, Number(progress)));
    if (p >= 1.0) return 0.0;
    const phase = Math.PI / 2.0;
    return amplitude * Math.sin(2.0 * Math.PI * cycles * p + phase) * Math.exp(-decay * p);
}

/**
 * Compute transition parameters for a clip/overlay.
 * @returns {[number, number, number, number]} [opacityFactor, scale, dx, dy]
 */
function computeTransitionParams(currentTime, segStart, segEnd,
    preset, duration = DEFAULT_TRANSITION_DURATION,
    slideDistance = 80.0) {
    if (currentTime == null) return [1.0, 1.0, 0.0, 0.0];
    const [typeName, scope] = _parseTransitionPreset(preset);
    if (!typeName) return [1.0, 1.0, 0.0, 0.0];

    const dur = Math.max(0.0, Number(duration));
    const inDur = (scope === 'in' || scope === 'both') ? dur : 0.0;
    const outDur = (scope === 'out' || scope === 'both') ? dur : 0.0;
    const [inProg, outProg] = computeAnimProgress(
        Number(currentTime), Number(segStart), Number(segEnd),
        inDur, outDur, 'ease_out', 'ease_out'
    );

    let opacityFactor = 1.0, scale = 1.0, dx = 0.0, dy = 0.0;

    if (typeName === 'fade') {
        if (scope === 'in' || scope === 'both') opacityFactor = Math.min(opacityFactor, inProg);
        if (scope === 'out' || scope === 'both') opacityFactor = Math.min(opacityFactor, outProg);
    }

    if (typeName === 'pop') {
        let popP = 1.0;
        if (scope === 'in' || scope === 'both') popP = Math.min(popP, computePopScale(inProg));
        if (scope === 'out' || scope === 'both') popP = Math.min(popP, computePopScale(outProg));
        scale *= popP;
    }

    if (typeName.startsWith('slide_')) {
        if (scope === 'in' || scope === 'both') {
            const [sx, sy] = computeSlideOffset(inProg, typeName, slideDistance, false);
            dx += sx; dy += sy;
        }
        if (scope === 'out' || scope === 'both') {
            const [sx, sy] = computeSlideOffset(outProg, typeName, slideDistance, true);
            dx += sx; dy += sy;
        }
    }

    if (typeName === 'sway') {
        if (scope === 'in' || scope === 'both') dx += computeSwayOffset(inProg);
        if (scope === 'out' || scope === 'both') dx += computeSwayOffset(1.0 - outProg);
    }

    return [opacityFactor, scale, dx, dy];
}

// ───────────────────────────────────────────────────────
// 3.  Phase 2 animation helpers
// ───────────────────────────────────────────────────────

/** Sinusoidal vertical float. Returns dy in pixels. */
function computeFloatingOffset(currentTime, segStart, amplitude = 8.0, period = 2.0) {
    const dt = currentTime - segStart;
    return amplitude * Math.sin(2.0 * Math.PI * dt / Math.max(0.1, period));
}

/** Return opacity 0.0~1.0 for a specific line in bullet-reveal mode. */
function computeBulletRevealLineAlpha(currentTime, segStart, segEnd,
    lineIndex, totalLines, stagger = 0.15) {
    if (totalLines <= 0) return 1.0;
    const segDur = Math.max(0.001, segEnd - segStart);
    const lineStart = segStart + lineIndex * stagger;
    const fadeDur = Math.min(0.3, segDur / Math.max(1, totalLines));
    const dt = currentTime - lineStart;
    if (dt < 0) return 0.0;
    if (dt >= fadeDur) return 1.0;
    return easeOutCubic(dt / fadeDur);
}

/** Return true if word should be visible based on fixed BPM cadence. */
function computeMetronomeWordVisible(currentTime, segStart, segEnd,
    wordIndex, totalWords, bpm = 120.0) {
    if (totalWords <= 0) return true;
    const beatInterval = 60.0 / Math.max(1.0, bpm);
    const wordAppearTime = segStart + wordIndex * beatInterval;
    return currentTime >= wordAppearTime;
}

/** Return flash intensity 0.0~1.0. */
function computeFlashHighlight(currentTime, segStart, flashDuration = 0.1) {
    const dt = currentTime - segStart;
    if (dt < 0 || dt > flashDuration) return 0.0;
    return 1.0 - (dt / flashDuration);
}

/** Return [glowAlphaFactor, glowExpansion]. */
function computeHolyGlow(currentTime, segStart, segEnd,
    glowRadius = 6, fadePeriod = 3.0) {
    const dt = currentTime - segStart;
    const pulse = 0.65 + 0.35 * Math.sin(2.0 * Math.PI * dt / Math.max(0.1, fadePeriod));
    return [pulse, glowRadius];
}

/** Return scale factor for the currently-spoken word in letter-jump mode. */
function computeLetterJumpScale(currentTime, wordStart, wordEnd,
    jumpScale = 1.5, animDuration = 0.2) {
    const dt = currentTime - wordStart;
    const wordDur = Math.max(0.001, wordEnd - wordStart);
    if (dt < 0 || dt > wordDur) return 1.0;
    const half = animDuration / 2.0;
    if (dt < half) {
        const raw = dt / half;
        return 1.0 + (jumpScale - 1.0) * easeOutCubic(raw);
    } else if (dt < animDuration) {
        const raw = (dt - half) / half;
        return jumpScale - (jumpScale - 1.0) * easeOutCubic(raw);
    }
    return 1.0;
}

/** Return scale factor for per-word print-in with deterministic random final size. */
function computeWordRandomPopScale(currentTime, wordStart, wordEnd, wordIndex = 0, segStart = 0,
    minScale = 0.7, maxScale = 1.34, animDuration = 0.22) {
    const dt = currentTime - wordStart;
    if (dt < 0) return 0.0;

    const dur = Math.max(0.06, Number(animDuration) || 0.22);
    const minS = Number(minScale) || 0.7;
    const maxS = Math.max(minS, Number(maxScale) || 1.34);
    const key = (Number(wordIndex) + 1.0) * 12.9898 + Number(segStart) * 78.233 + Number(wordStart) * 37.719;
    const rand = (Math.sin(key) * 43758.5453) % 1;
    const rand01 = rand < 0 ? rand + 1 : rand;
    const finalScale = minS + (maxS - minS) * rand01;

    if (dt >= dur) return finalScale;
    const p = Math.max(0.0, Math.min(1.0, dt / dur));
    const startScale = 0.56;
    return startScale + (finalScale - startScale) * easeOutBack(p);
}

/** Return scale factor for per-word pop pulse that settles back to 1.0. */
function computeWordRandomPulseScale(currentTime, wordStart, wordEnd, wordIndex = 0, segStart = 0,
    minScale = 1.08, maxScale = 1.38, animDuration = 0.22) {
    const dt = currentTime - wordStart;
    if (dt < 0) return 0.0;

    const dur = Math.max(0.06, Number(animDuration) || 0.22);
    const minS = Number(minScale) || 1.08;
    const maxS = Math.max(minS, Number(maxScale) || 1.38);
    const key = (Number(wordIndex) + 1.0) * 12.9898 + Number(segStart) * 78.233 + Number(wordStart) * 37.719;
    const rand = (Math.sin(key) * 43758.5453) % 1;
    const rand01 = rand < 0 ? rand + 1 : rand;
    const peak = minS + (maxS - minS) * rand01;

    const inDur = dur * 0.45;
    if (dt <= inDur) {
        const p = Math.max(0.0, Math.min(1.0, dt / inDur));
        return 0.72 + (peak - 0.72) * easeOutBack(p);
    }
    if (dt <= dur) {
        const p = Math.max(0.0, Math.min(1.0, (dt - inDur) / Math.max(0.001, dur - inDur)));
        return peak - (peak - 1.0) * easeOutCubic(p);
    }
    return 1.0;
}

/** Return blur radius (int). Starts at maxBlur, reaches 0 at clearFrac of duration. */
function computeBlurSharpRadius(currentTime, segStart, segEnd,
    maxBlur = 20, clearFrac = 0.4) {
    const segDur = Math.max(0.001, segEnd - segStart);
    const dt = currentTime - segStart;
    const clearTime = segDur * clearFrac;
    if (dt >= clearTime) return 0;
    const frac = dt / clearTime;
    return Math.round(maxBlur * (1.0 - easeOutCubic(frac)));
}

/** Return list of [strokeWidth, alphaFactor] for multi-layer stroke expansion. */
function computeMultiStrokeLayers(baseWidth, layerCount, expansionStep, featherWidth) {
    const layers = [];
    for (let i = 0; i < layerCount; i++) {
        const w = baseWidth + i * expansionStep;
        let alpha = 1.0;
        if (featherWidth > 0 && layerCount > 1) {
            alpha = 1.0 - (i / (layerCount - 1));
        }
        layers.push([w, alpha]);
    }
    return layers;
}

// ───────────────────────────────────────────────────────
// 4.  Audio spectrum animation helpers
// ───────────────────────────────────────────────────────

function computeSpectrumBarHeights(bars, maxHeight, smoothing = 0.7) {
    return bars.map(b => Math.min(maxHeight, b * maxHeight));
}

function computeSpectrumColors(numBars, baseHue = 0.55, saturation = 0.8,
    lightness = 0.6, hueSpread = 0.3) {
    const colors = [];
    for (let i = 0; i < numBars; i++) {
        const h = ((baseHue + (i / Math.max(1, numBars - 1)) * hueSpread) % 1.0) * 360;
        colors.push(`hsl(${h}, ${saturation * 100}%, ${lightness * 100}%)`);
    }
    return colors;
}

// ───────────────────────────────────────────────────────
// 5.  Dynamic image attachment effects
// ───────────────────────────────────────────────────────

/** Return [angleDeg, dx, dy] for subtle wobble/shake animation. */
function computeDynImgWobble(currentTime, period = 0.8, amplitude = 3.0) {
    const t = currentTime * 2 * Math.PI / Math.max(0.1, period);
    const angle = amplitude * Math.sin(t) * 0.5;
    const dx = amplitude * Math.sin(t * 1.3) * 0.3;
    const dy = amplitude * Math.cos(t * 0.9) * 0.3;
    return [angle, dx, dy];
}

/** Return scale factor for breathing/pulse effect. */
function computeDynImgPulse(currentTime, period = 1.0, minScale = 0.9, maxScale = 1.1) {
    const t = currentTime * 2 * Math.PI / Math.max(0.1, period);
    const frac = (Math.sin(t) + 1.0) / 2.0;
    return minScale + frac * (maxScale - minScale);
}

/** Return alpha factor for breathing opacity effect. */
function computeDynImgBreatheAlpha(currentTime, period = 1.5, minAlpha = 0.4, maxAlpha = 1.0) {
    const t = currentTime * 2 * Math.PI / Math.max(0.1, period);
    const frac = (Math.sin(t) + 1.0) / 2.0;
    return minAlpha + frac * (maxAlpha - minAlpha);
}

/** Return [r, g, b, a] for box color that transitions based on reading progress. */
function computeBoxColorTransition(currentTime, segStart, segEnd,
    wordsInfo, colorFrom, colorTo) {
    if (!wordsInfo || wordsInfo.length === 0) return colorFrom;
    const segDur = Math.max(0.001, segEnd - segStart);
    const progress = Math.max(0.0, Math.min(1.0, (currentTime - segStart) / segDur));
    return [
        Math.round(colorFrom[0] + (colorTo[0] - colorFrom[0]) * progress),
        Math.round(colorFrom[1] + (colorTo[1] - colorFrom[1]) * progress),
        Math.round(colorFrom[2] + (colorTo[2] - colorFrom[2]) * progress),
        Math.round(colorFrom[3] + (colorTo[3] - colorFrom[3]) * progress),
    ];
}

/**
 * Compute per-line visible background bar widths for progressive left-to-right
 * line-by-line background bar wipe ("底条进度擦除").
 * Line 0 wipes 0→100% first; once Line 0 reaches 100%, it stays full while
 * Line 1 wipes 0→100% at the same constant horizontal sweep speed, etc.
 *
 * @param {number|null} currentTime
 * @param {number} segStart
 * @param {number} segEnd
 * @param {number[]} lineWidths - Full box width of each visible line
 * @param {object} [opts]
 * @returns {number[]} Visible width for each line in [0, lineWidths[i]]
 */
function computeBoxWipeLineWidths(currentTime, segStart, segEnd, lineWidths, opts = {}) {
    if (!Array.isArray(lineWidths) || lineWidths.length === 0) return [];
    const widths = lineWidths.map(w => Math.max(0, Number(w) || 0));
    const totalW = widths.reduce((sum, w) => sum + w, 0);
    if (totalW <= 0) return widths.map(() => 0);

    if (currentTime == null || !Number.isFinite(currentTime)) {
        return widths.slice();
    }

    const segDur = Math.max(0.001, (Number(segEnd) || 0) - (Number(segStart) || 0));
    const rawFrac = Math.max(0.0, Math.min(1.0, (currentTime - (Number(segStart) || 0)) / segDur));
    const minStartFrac = Number.isFinite(Number(opts.minStartFrac))
        ? Math.max(0.0, Math.min(0.25, Number(opts.minStartFrac)))
        : 0.04;
    const frac = minStartFrac + (1.0 - minStartFrac) * rawFrac;
    const sweptDist = frac * totalW;

    let accumBefore = 0;
    return widths.map((w) => {
        const visW = Math.max(0, Math.min(w, sweptDist - accumBefore));
        accumBefore += w;
        return visW;
    });
}

/**
 * Compute continuous 3D forward zoom scale + rapid character-by-character
 * typewriter reveal state ("远景打字推进").
 *
 * @param {number|null} currentTime
 * @param {number} segStart
 * @param {number} segEnd
 * @param {number} totalChars
 * @param {object} [opts]
 * @returns {{ blockScale: number, revealedChars: number, activeCharIdx: number, activeCharProgress: number }}
 */
function computeZoomTypewriterState(currentTime, segStart, segEnd, totalChars, opts = {}) {
    const count = Math.max(1, Number(totalChars) || 1);
    if (currentTime == null || !Number.isFinite(Number(currentTime))) {
        return { blockScale: 1.0, revealedChars: count, activeCharIdx: -1, activeCharProgress: 1.0 };
    }
    const segDur = Math.max(0.001, Number(segEnd) - Number(segStart));
    const elapsed = Math.max(0.0, Number(currentTime) - Number(segStart));
    const segFrac = Math.max(0.0, Math.min(1.0, elapsed / segDur));

    const startScale = Number.isFinite(Number(opts.startScale)) ? Number(opts.startScale) : 0.42;
    const endScale = Number.isFinite(Number(opts.endScale)) ? Number(opts.endScale) : 1.26;
    const blockScale = startScale + (endScale - startScale) * Math.pow(segFrac, 1.12);

    const revealDur = Math.min(segDur * 0.36, Math.max(0.18, count * 0.036));
    if (elapsed >= revealDur) {
        return { blockScale, revealedChars: count, activeCharIdx: -1, activeCharProgress: 1.0 };
    }
    const rawUnits = Math.max(0.35, (elapsed / Math.max(0.001, revealDur)) * count);
    const revealedChars = Math.max(1, Math.min(count, Math.ceil(rawUnits)));
    const fracInChar = rawUnits - Math.floor(rawUnits);
    const activeCharProgress = fracInChar > 0.001 ? Math.max(0.35, Math.min(1.0, fracInChar)) : 1.0;
    return {
        blockScale,
        revealedChars,
        activeCharIdx: revealedChars - 1,
        activeCharProgress,
    };
}

// Spectrum shape types
const SPECTRUM_SHAPES = [
    ['频谱条', 'bars'],
    ['曲线', 'curve'],
    ['折线', 'zigzag'],
    ['圆点', 'dots'],
    ['爱心', 'hearts'],
];

// ───────────────────────────────────────────────────────
// Exports (global scope for browser, or module.exports for Node)
// ───────────────────────────────────────────────────────

const ReelsAnimEngine = {
    // Easing
    EASING_MAP, EASING_LABELS, ANIM_TYPE_LABELS,
    CHAR_ANIM_TYPES, isCharAnimType,
    TRANSITION_PRESETS, DEFAULT_TRANSITION_DURATION, SPECTRUM_SHAPES,
    // Core
    computeAnimProgress,
    computeTypewriterProgress,
    computeCharBounceOffset,
    computeCharAnimTransform,
    computeDynBoxScale,
    computeSlideOffset,
    computePopScale,
    computeSwayOffset,
    computeTransitionParams,
    // Phase 2
    computeFloatingOffset,
    computeBulletRevealLineAlpha,
    computeMetronomeWordVisible,
    computeFlashHighlight,
    computeHolyGlow,
    computeLetterJumpScale,
    computeWordRandomPopScale,
    computeWordRandomPulseScale,
    computeBlurSharpRadius,
    computeMultiStrokeLayers,
    // Spectrum
    computeSpectrumBarHeights,
    computeSpectrumColors,
    // Dynamic image
    computeDynImgWobble,
    computeDynImgPulse,
    computeDynImgBreatheAlpha,
    computeBoxColorTransition,
    computeBoxWipeLineWidths,
    computeZoomTypewriterState,
};

// Browser global
if (typeof window !== 'undefined') window.ReelsAnimEngine = ReelsAnimEngine;
// Node.js module
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsAnimEngine;
