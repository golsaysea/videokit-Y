/**
 * reels-style-engine.js — Subtitle style data model & defaults.
 * 
 * ✅ 移植自 AutoSub_v8/core/AutoSub_v4.0.py STYLE_KEYS + SubtitleStylePanel
 * 
 * Provides:
 * - DEFAULT_SUBTITLE_STYLE: all ~80 style keys with sensible defaults
 * - copyStyle(): deep-clone a style object
 * - mergeStyle(): merge partial overrides into a base style
 * - Preset save/load via electron-store or localStorage
 */

// ───────────────────────────────────────────────────────
// Complete style keys — 1:1 from AutoSub STYLE_KEYS
// ───────────────────────────────────────────────────────

const DEFAULT_SUBTITLE_STYLE = {
    // ── Font ──
    font_family: 'Arimo',
    font_weight: 700,
    fontsize: 74,
    bold: true,
    italic: false,
    letter_spacing: 0,
    text_direction: 'auto', // auto | ltr | rtl
    word_spacing: 0,
    random_word_spacing: 0,
    random_line_spacing: 0,
    random_spacing_seed: 1,
    random_position_use_layout_range: false,
    random_position_height_percent: 35,
    mixed_layout: 'none', // none | stack | focus | collage | stairs | cycle

    // ── Position ──
    pos_x: 0.5,       // 0~1 normalized (0.5 = center)
    pos_y: 0.5,       // 0~1 normalized (0.5 = center)
    rotation: 0,
    opacity_text_global: 1.0,

    // ── Colors ──
    color_text: '#FFFFFF',
    text_gradient_direction: 'horizontal',
    text_gradient_scope: 'line', // 'line' (整句渐变) | 'word' (每个单词独立渐变)
    color_high: '#FFD700',      // current-word highlight color
    high_gradient_direction: 'horizontal',
    high_gradient_scope: 'word',
    highlight_enabled: true,    // 朗读高亮开关
    highlight_scale_enabled: false, // 朗读当前词放大开关
    highlight_scale: 125,       // 朗读当前词放大比例 (%)
    hide_until_spoken: false,   // 未读文字透明开关（读到才出字）
    unread_opacity: 0,          // 未读文字不透明度 (0~100%)
    text_align: 'center',       // 字幕对齐方式: center | left | right | smart_left_center
    color_bg: '#000000',
    color_shadow: '#000000',
    opacity_bg: 150,
    opacity_shadow: 150,

    // ── Background box ──
    use_box: false,
    box_padding_x: 12,
    box_padding_y: 8,
    box_radius: 8,
    box_blur: 0,
    box_adaptive_width: false,
    box_connected: true,        // 连体贴合背景
    box_wipe_enabled: false,    // 逐行左→右进度条擦除背景
    box_concave_radius: 10,     // 连体背景内凹圆角
    box_snap_threshold: 18,     // 相邻行宽度接近自动对齐阈值(px)
    box_brush_style: 'rect',
    box_brush_color_mode: 'tint',
    box_custom_brush_data: '',
    box_brush_w: 0,
    box_brush_h: 0,
    box_brush_x: 0,
    box_brush_y: 0,
    box_brush_solid: 100,

    // ── Basic stroke ──
    use_stroke: true,
    border_width: 3,
    opacity_outline: 255,
    color_outline: '#3E2723',

    // ── Dynamic highlight box ──
    karaoke_highlight: true,
    dynamic_box: false,
    color_high_bg: '#FFD700',
    opacity_high_bg: 0.3,
    dynamic_radius: 6,
    dynamic_box_stroke: false,
    dynamic_box_stroke_width: 2,

    // ── Advanced Typography ──
    text_transform: 'none',
    uppercase: false,

    // ── Scrolling Lyrics Mode ──
    scrolling_mode: false,
    scrolling_visible_lines: 3,
    scrolling_opacity_context: 0.3,

    // ── Shadow ──
    shadow_blur: 4,
    shadow_offset_x: 0,
    shadow_offset_y: 2,

    // ── Underline ──
    use_underline: false,
    color_underline: '#FFD700',

    // ── Highlight box padding ──
    high_padding: 4,
    high_offset_y: 0,

    // ── Text wrapping ──
    wrap_width_percent: 90,
    auto_wrap: true,
    wrap_lines: 2,
    wrap_left: 0,
    wrap_right: 0,
    line_spacing: 1.2,

    // ── Legacy stroke/shadow (compatibility) ──
    stroke: true,
    stroke_width: 3,
    shadow: true,
    shadow_offset: 2,
    bg_enabled: false,
    bg_opacity: 0.6,
    bg_padding: 10,
    bg_radius: 8,
    color: '#FFFFFF',
    stroke_color: '#3E2723',
    bg_color: '#000000',

    // ── Animation (Phase 1) ──
    anim_in_type: 'fade',
    anim_in_duration: 0.3,
    anim_in_easing: 'ease_out',
    anim_out_type: 'fade',
    anim_out_duration: 0.25,
    anim_out_easing: 'ease_in_out',

    // ── Typewriter ──
    tw_revealed_color: '#FFFFFF',
    tw_revealed_stroke_color: '#000000',
    tw_revealed_opacity: 1.0,
    tw_revealed_stroke_opacity: 1.0,
    tw_unrevealed_color: '#808080',
    tw_unrevealed_stroke_color: '#404040',
    tw_unrevealed_opacity: 0,
    fullpage_typewriter: false,
    fullpage_typewriter_reveal_type: 'char',
    fullpage_typewriter_align: 'center',
    fullpage_typewriter_cursor: true,
    fullpage_typewriter_keep_background: true,
    fullpage_typewriter_title_font_follow: true,
    fullpage_typewriter_title_stroke_independent: false,
    fullpage_typewriter_title_stroke_enabled: true,
    fullpage_typewriter_title_stroke_color: '#3e2723',
    fullpage_typewriter_title_stroke_width: 3,
    fullpage_typewriter_title_stroke_opacity: 255,
    fullpage_typewriter_title_box_enabled: true,
    fullpage_typewriter_title_box_color: "#000000",
    fullpage_typewriter_title_box_opacity: 180,
    fullpage_typewriter_body_stroke_independent: false,
    fullpage_typewriter_body_stroke_enabled: true,
    fullpage_typewriter_body_stroke_color: '#3e2723',
    fullpage_typewriter_body_stroke_width: 3,
    fullpage_typewriter_body_stroke_opacity: 255,
    fullpage_typewriter_body_box_enabled: true,
    fullpage_typewriter_body_box_color: "#000000",
    fullpage_typewriter_body_box_opacity: 180,
    fullpage_typewriter_auto_sequence: true,
    fullpage_typewriter_split: false,
    fullpage_typewriter_title_auto: true,
    fullpage_typewriter_title_text: "",
    fullpage_typewriter_title_font: "",
    fullpage_typewriter_title_size: 56,
    fullpage_typewriter_title_weight: "700",
    fullpage_typewriter_title_color: "#FFD700",
    fullpage_typewriter_title_x: 50,
    fullpage_typewriter_title_y: 20,
    fullpage_typewriter_title_delay: 0,
    fullpage_typewriter_title_reveal: "char",
    fullpage_typewriter_title_cursor: true,
    fullpage_typewriter_body_reveal: "sentence",
    fullpage_typewriter_body_delay: 0,
    fullpage_typewriter_body_x: 50,
    fullpage_typewriter_body_y: 60,
    fullpage_typewriter_body_cursor: true,
    fullpage_typewriter_cursor_image: '',
    fullpage_typewriter_cursor_image_anchor_x: 50,
    fullpage_typewriter_cursor_image_anchor_y: 50,
    fullpage_typewriter_cursor_kind: 'char',
    fullpage_typewriter_speech_sync: true,
    fullpage_typewriter_cursor_scale: 1,
    fullpage_typewriter_cursor_offset_x: 0,
    fullpage_typewriter_cursor_offset_y: 0,
    fullpage_typewriter_cursor_angle: 0,
    fullpage_typewriter_cursor_char: '|',
    fullpage_typewriter_cursor_color: '#FFD700',
    fullpage_typewriter_first_line_bold: true,
    fullpage_typewriter_first_line_scale: 1.2,
    fullpage_typewriter_first_line_color: '',
    fullpage_typewriter_auto_page: true,

    // ── Scatter Pop ──
    scatter_max_words: 3,
    scatter_seed: 1,
    scatter_min_scale: 0.8,
    scatter_max_scale: 1.5,
    scatter_min_rotate: 0,
    scatter_max_rotate: 0,
    scatter_accum_prob: 0.5,
    scatter_area_left: 15,
    scatter_area_right: 85,
    scatter_area_top: 25,
    scatter_area_bottom: 75,

    // ── Character bounce & Extended Per-Char Animations ──
    char_bounce_height: 20,
    char_bounce_stagger: 0.05,
    char_anim_intensity: 1.0,
    char_anim_duration: 0.28,
    char_anim_stagger: 0.04,

    // ── Dynamic box animation ──
    dyn_box_anim: false,
    dyn_box_anim_overshoot: 1.3,
    dyn_box_anim_duration: 0.15,

    // ── Speed Trail ──
    speed_trail_enabled: false,
    speed_trail_layers: 5,
    speed_trail_step: -8,
    speed_trail_color: '#FFFFFF',
    speed_trail_opacity: 80,

    // ── Phase 2 animations ──
    // Floating
    floating_amplitude: 8,
    floating_period: 2.0,
    // Bullet reveal
    bullet_stagger: 0.15,
    // Metronome
    metronome_bpm: 120,
    // Flash highlight
    flash_color: '#FFFFFF',
    flash_duration: 0.1,
    // Holy glow
    holy_glow_radius: 6,
    holy_glow_color: '#FFFFAA',
    holy_glow_period: 3.0,
    // Letter jump
    letter_jump_scale: 1.5,
    letter_jump_duration: 0.2,
    // Word pop random
    word_pop_random_min_scale: 0.7,
    word_pop_random_max_scale: 1.34,
    word_pop_random_duration: 0.22,
    word_pop_random_unread_opacity: 0.0,
    word_pop_random_read_opacity: 1.0,
    word_pop_random_pulse_min_scale: 1.08,
    word_pop_random_pulse_max_scale: 1.38,
    word_pop_random_pulse_duration: 0.22,
    // Block typography (line-fit square layout)
    block_typography_enabled: false,
    block_scale_min: 0.78,
    block_scale_max: 1.6,
    // Active line focus (2-line active/inactive scale switching)
    active_line_focus_enabled: false,
    inactive_line_scale: 0.62,
    // Blur → Sharp
    blur_sharp_max: 20,
    blur_sharp_clear_frac: 0.4,
    only_show_active_word: false,
    // Kinetic glow stack (accumulating hero-word phrase stack)
    kinetic_group_words: 3,
    kinetic_scale_min: 0.66,
    kinetic_scale_max: 1.90,
    kinetic_line_gap: 0.14,
    kinetic_pop_duration: 0.16,
    kinetic_old_word_opacity: 0.92,
    kinetic_old_glow_opacity: 0.78,
    kinetic_glow_color: '#E7FF00',
    kinetic_glow_blur: 64,
    kinetic_background_dim: 0.52,
    kinetic_tint_opacity: 0.26,
    kinetic_vignette_strength: 0.96,
    kinetic_vignette_radius: 0.62,
    kinetic_spotlight_opacity: 0.42,

    // ── Ambient optical glow (illuminates background behind text) ──
    ambient_glow_enabled: false,
    ambient_glow_color: '#FFFB8F',
    ambient_glow_radius: 650,
    ambient_glow_opacity: 0.65,
    ambient_glow_blend_mode: 'lighter',
    ambient_lighting_enabled: false,
    ambient_dark_color: '#000000',
    ambient_dark_opacity: 0.70,
    ambient_dark_center_opacity: 0.70,
    ambient_dark_radius: 0.75,

    // ── Multi-layer stroke expansion ──
    stroke_expand_enabled: false,
    stroke_expand_layers: 3,
    stroke_expand_step: 2,
    stroke_expand_feather: 1,
    stroke_expand_colors: ['#000000', '#333333', '#666666'],
    stroke_expand_layer_widths: [3, 5, 7],
    stroke_expand_layer_feathers: [0, 0.5, 1.0],
    effect_controls_enabled: false,
    effect_inner_outline_width: 5,
    effect_glow_range: 22,
    effect_glow_blur: 18,
    effect_glow_opacity: 70,

    // ── Gradient background ──
    bg_gradient_enabled: false,
    bg_gradient_type: 'linear',     // linear | radial
    bg_gradient_colors: ['#000000', '#333333'],
    bg_gradient_highlight: false,

    // ── Dynamic box images ──
    dyn_box_image_enabled: false,
    dyn_box_images: [],
    dyn_box_image_path: '',
    dyn_box_image_scale: 1.0,
    dyn_box_image_offset_x: 0,
    dyn_box_image_offset_y: 0,
    dyn_box_image_blend: 'normal',

    // ── Metronome read/unread styles ──
    metro_read_color: '#FFFFFF',
    metro_read_stroke_color: '#000000',
    metro_read_stroke_width: 3,
    metro_read_opacity: 1.0,
    metro_unread_color: '#808080',
    metro_unread_stroke_color: '#404040',
    metro_unread_stroke_width: 2,
    metro_unread_opacity: 0.4,

    // ── Box color transition ──
    box_transition_enabled: false,
    box_transition_color_to: '#FF6600',

    // ── Advanced subtitle text-box ──
    advanced_textbox_enabled: false,
    advanced_textbox_x: 0,
    advanced_textbox_y: 0,
    advanced_textbox_w: 100,
    advanced_textbox_h: 100,
    advanced_textbox_align: 'center',
    advanced_textbox_valign: 'center',

    // ── Advanced text-box extra params ──
    adv_bg_enabled: false,
    adv_bg_offset_x: 0,
    adv_bg_offset_y: 0,
    adv_bg_w: 100,
    adv_bg_h: 50,
    adv_bg_radius: 8,
    adv_bg_color: '#000000',
    adv_bg_opacity: 0.6,
    adv_bg_gradient_enabled: false,
    adv_bg_gradient_type: 'linear',
    adv_bg_gradient_colors: ['#000000', '#333333'],
    adv_bg_gradient_highlight: false,
    adv_line_spacing: 1.2,
    adv_text_align: 'center',
    adv_stroke_enabled: false,
    adv_stroke_width: 2,
    adv_stroke_color: '#000000',
    adv_stroke_opacity: 1.0,

    // ── Global Video Mask ──
    global_mask_enabled: false,
    global_mask_color: '#000000',
    global_mask_opacity: 0.5,

    // ── Audio spectrum ──
    spectrum_enabled: false,
    spectrum_bands: 32,
    spectrum_bar_width: 6,
    spectrum_bar_gap: 2,
    spectrum_max_height: 60,
    spectrum_color_bottom: '#4444FF',
    spectrum_color_top: '#FF4444',
    spectrum_position: 'bottom',    // bottom | top | behind
    spectrum_shape: 'bars',         // bars | curve | zigzag | dots | hearts
    spectrum_dual: false,
    spectrum_top_shape: 'bars',
    spectrum_opacity: 0.8,
    spectrum_roundness: 4,
};

// All style keys list (for iteration / validation)
const STYLE_KEYS = Object.keys(DEFAULT_SUBTITLE_STYLE);

// ───────────────────────────────────────────────────────
// Style utility functions
// ───────────────────────────────────────────────────────

/**
 * Deep-clone a style object.
 */
function copyStyle(style) {
    if (!style || typeof style !== 'object') return { ...DEFAULT_SUBTITLE_STYLE };
    return JSON.parse(JSON.stringify(style));
}

/**
 * Create a full style with defaults, then apply overrides.
 */
function mergeStyle(overrides) {
    const base = copyStyle(DEFAULT_SUBTITLE_STYLE);
    if (!overrides || typeof overrides !== 'object') return base;
    for (const key of STYLE_KEYS) {
        if (key in overrides) {
            base[key] = typeof overrides[key] === 'object' && Array.isArray(overrides[key])
                ? [...overrides[key]]
                : overrides[key];
        }
    }
    if ('bold' in overrides && !('font_weight' in overrides)) {
        base.font_weight = overrides.bold ? 700 : 400;
    } else if ('font_weight' in overrides && !('bold' in overrides)) {
        base.bold = (parseInt(overrides.font_weight, 10) || 400) >= 600;
    }
    return base;
}

/**
 * Extract only STYLE_KEYS from a mixed object (sanitize).
 */
function extractStyleKeys(obj) {
    if (!obj || typeof obj !== 'object') return {};
    const result = {};
    for (const key of STYLE_KEYS) {
        if (key in obj) {
            result[key] = typeof obj[key] === 'object' && Array.isArray(obj[key])
                ? [...obj[key]]
                : typeof obj[key] === 'object' && obj[key] !== null
                    ? JSON.parse(JSON.stringify(obj[key]))
                    : obj[key];
        }
    }
    return result;
}

function _stableStyleValue(value) {
    if (Array.isArray(value)) return value.map(_stableStyleValue);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = _stableStyleValue(value[key]);
    return result;
}

/**
 * Build a deterministic fingerprint for semantic preset comparison.
 * Missing keys are filled from defaults, so a compact preset and an equivalent
 * fully-expanded preset are treated as the same style.
 */
function subtitleStyleFingerprint(style) {
    return JSON.stringify(_stableStyleValue(mergeStyle(extractStyleKeys(style))));
}

/**
 * Merge multiple parsed preset files before writing them to localStorage.
 * The first selected file/name wins inside the batch. Identical styles are
 * removed even when their names differ; actual same-name style changes remain
 * in `conflicts` so the UI can ask once whether to overwrite them.
 */
function prepareSubtitlePresetBatchImport(bundles, existingPresets = {}) {
    const result = {
        payload: { presets: {} },
        duplicates: [],
        batchConflicts: [],
        conflicts: [],
        invalid: [],
    };
    const selectedNames = new Map();
    const selectedContent = new Map();

    for (const bundle of Array.isArray(bundles) ? bundles : []) {
        const source = String(bundle?.source || '未命名文件');
        const incoming = bundle?.data;
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)
            || !incoming.presets || typeof incoming.presets !== 'object' || Array.isArray(incoming.presets)) {
            result.invalid.push(source);
            continue;
        }
        if (!result.payload.default && incoming.default && typeof incoming.default === 'object') {
            result.payload.default = extractStyleKeys(incoming.default);
        }
        for (const [rawName, style] of Object.entries(incoming.presets)) {
            const name = String(rawName || '').trim();
            if (!name || !style || typeof style !== 'object' || Array.isArray(style)) {
                result.invalid.push(`${source}: ${name || '空名称'}`);
                continue;
            }
            const normalized = extractStyleKeys(style);
            const fingerprint = subtitleStyleFingerprint(normalized);
            if (selectedNames.has(name)) {
                if (selectedNames.get(name) === fingerprint) result.duplicates.push(name);
                else result.batchConflicts.push(name);
                continue;
            }
            if (selectedContent.has(fingerprint)) {
                result.duplicates.push(name);
                continue;
            }
            selectedNames.set(name, fingerprint);
            selectedContent.set(fingerprint, name);
            result.payload.presets[name] = normalized;
        }
    }

    const existingContent = new Map();
    for (const [name, style] of Object.entries(existingPresets || {})) {
        const fingerprint = subtitleStyleFingerprint(style);
        if (!existingContent.has(fingerprint)) existingContent.set(fingerprint, name);
    }
    for (const [name, style] of Object.entries({ ...result.payload.presets })) {
        const fingerprint = subtitleStyleFingerprint(style);
        if (Object.prototype.hasOwnProperty.call(existingPresets || {}, name)) {
            if (subtitleStyleFingerprint(existingPresets[name]) === fingerprint) {
                delete result.payload.presets[name];
                result.duplicates.push(name);
            } else if (existingContent.has(fingerprint) && existingContent.get(fingerprint) !== name) {
                delete result.payload.presets[name];
                result.duplicates.push(name);
            } else {
                result.conflicts.push(name);
            }
            continue;
        }
        if (existingContent.has(fingerprint)) {
            delete result.payload.presets[name];
            result.duplicates.push(name);
        }
    }
    return result;
}

// ───────────────────────────────────────────────────────
// Preset management (localStorage-based for browser)
// ───────────────────────────────────────────────────────

const PRESET_STORAGE_KEY = 'reels_subtitle_presets';
let _lastSubtitlePresetSaveError = '';
function getLastPresetSaveError() { return _lastSubtitlePresetSaveError; }
const MAX_PRESETS = 200;

const BUILTIN_PRESETS = {
    // ── 爆贴底框系列 ──
    "红底条逐行擦除 (爆款)": {
        font_family: "Segoe UI",
        font_weight: 800,
        fontsize: 78,
        bold: true,
        italic: true,
        letter_spacing: 0,
        color_text: "#FFFFFF",
        color_high: "#FFFFFF",
        karaoke_highlight: false,
        highlight_enabled: false,
        use_stroke: true,
        color_outline: "#000000",
        border_width: 5,
        opacity_outline: 255,
        shadow_blur: 0,
        shadow_offset_x: 0,
        shadow_offset_y: 0,
        opacity_shadow: 0,
        use_box: true,
        box_adaptive_width: true,
        box_connected: false,
        box_wipe_enabled: true,
        color_bg: "#991A1C",
        opacity_bg: 255,
        box_radius: 0,
        box_blur: 0,
        box_padding_x: 22,
        box_padding_y: 12,
        dynamic_box: false,
        use_underline: false,
        bg_gradient_enabled: false,
        box_transition_enabled: false,
        global_mask_enabled: false,
        pos_x: 0.5,
        pos_y: 0.71,
        wrap_width_percent: 82,
        line_spacing: 24,
        anim_in_type: "box_wipe",
        anim_in_duration: 0,
        anim_out_type: "none",
        anim_out_duration: 0,
    },
    "焦糖橙_黄高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#9D4512", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#F5D678", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "深海蓝_黄高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#0E4B7E", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#F6D371", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "暗夜青_青高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#033045", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#00BFFF", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "明亮紫_黄高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#9D70A8", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#EFE174", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "奶油底_藏青高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#EAD3B3", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#213555", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "浅丁香_藏青高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#B0B6CE", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#2A3A5A", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "砖红_金黄高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#B34A4D", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#FFD700", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "亮蓝_明黄高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#008CDE", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#FFEB3B", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "深紫_粉红高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#350B4D", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#FF80AB", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "棕褐_奶黄高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#8C3B0E", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#FFF59D", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "暗蓝灰_薄荷高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#1D3B4C", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#A7FFEB", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    
    // ── 经典系列 ──
    "逐个大小出字-55": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 72, color_text: "#FFFFFF", color_high: "#fff701", use_box: false, use_stroke: true, border_width: 6, color_outline: "#3E2723", opacity_outline: 255, shadow_blur: 0, dynamic_box: true, color_high_bg: "#c61e00", opacity_high_bg: 255, dynamic_radius: 8, line_spacing: 1.12, font_weight: 900 },
    "逐个大小出字-45": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 45, color_text: "#FFFFFF", color_high: "#fbff00", use_box: false, use_stroke: true, border_width: 6, color_outline: "#0A192F", opacity_outline: 255, dynamic_box: false, shadow_blur: 0, line_spacing: 1.12, font_weight: 900 },
    "深蓝大底框+红色动画": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 45, color_text: "#FFFFFF", color_high: "#ffffff", use_box: true, box_adaptive_width: false, color_bg: "#1A2238", opacity_bg: 165, box_radius: 26, box_padding_x: 37, box_padding_y: 15, use_stroke: false, dynamic_box: true, color_high_bg: "#c61e00", opacity_high_bg: 255, dynamic_radius: 7, line_spacing: 1.56, font_weight: 900 },
    "深褐底框+红色动画": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 55, color_text: "#FFFFFF", color_high: "#ffffff", use_box: true, box_adaptive_width: true, color_bg: "#2C1E16", opacity_bg: 128, box_radius: 25, box_padding_x: 21, box_padding_y: 6, use_stroke: false, dynamic_box: true, color_high_bg: "#c61e00", opacity_high_bg: 255, dynamic_radius: 9, line_spacing: 1.51, font_weight: 900 },
    "逐个出字+红色动画": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 58, color_text: "#FFFFFF", color_high: "#f0f000", use_box: false, use_stroke: true, border_width: 6, color_outline: "#1B1229", opacity_outline: 255, dynamic_box: true, color_high_bg: "#cc0003", opacity_high_bg: 255, dynamic_radius: 8, line_spacing: 1.12, font_weight: 900 },
    "极简纯文+电光青高亮": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 56, color_text: "#F0F0F0", color_high: "#00FFFF", use_box: false, use_stroke: true, border_width: 3, color_outline: "#022B3A", opacity_outline: 255, shadow_blur: 8, color_shadow: "#022B3A", opacity_shadow: 204, shadow_offset_x: 3, shadow_offset_y: 3, dynamic_box: false, line_spacing: 1.2, font_weight: 900 },
    "重金大字+强对比排版": { karaoke_highlight: true, font_family: "Impact", fontsize: 68, color_text: "#FFFFFF", color_high: "#FFD700", use_box: false, use_stroke: true, border_width: 8, color_outline: "#2A241D", opacity_outline: 255, dynamic_box: false, line_spacing: 1.1, font_weight: 900 },
    "蓝底白字+动感回弹": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 48, color_text: "#FFFFFF", color_high: "#FFFFFF", use_box: true, box_adaptive_width: true, color_bg: "#1E90FF", opacity_bg: 216, box_radius: 8, box_padding_x: 15, box_padding_y: 6, use_stroke: false, dynamic_box: true, color_high_bg: "#FF0050", opacity_high_bg: 255, dynamic_radius: 8, line_spacing: 1.4, font_weight: 900 },
    "逐个出字大小-爆贴": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 72, color_text: "#FFFFFF", color_high: "#fff701", use_box: false, use_stroke: true, border_width: 6, color_outline: "#2D1B4E", opacity_outline: 255, dynamic_box: true, color_high_bg: "#c61e00", opacity_high_bg: 255, dynamic_radius: 8, line_spacing: 1.27, font_weight: 900 },

    // ── 社交风格系列 ──
    "黑边_粉红高亮": { karaoke_highlight: true, font_family: "Impact", fontsize: 68, color_text: "#FFFFFF", color_high: "#FF69B4", use_box: false, use_stroke: true, border_width: 8, color_outline: "#000000", opacity_outline: 255, shadow_blur: 0, line_spacing: 1.1, font_weight: 900, text_transform: "uppercase" },
    "黑边_薄荷高亮": { karaoke_highlight: true, font_family: "Impact", fontsize: 68, color_text: "#FFFFFF", color_high: "#00FA9A", use_box: false, use_stroke: true, border_width: 8, color_outline: "#000000", opacity_outline: 255, shadow_blur: 0, line_spacing: 1.1, font_weight: 900, text_transform: "uppercase" },
    "黑边_电蓝高亮": { karaoke_highlight: true, font_family: "Impact", fontsize: 68, color_text: "#FFFFFF", color_high: "#4169E1", use_box: false, use_stroke: true, border_width: 8, color_outline: "#000000", opacity_outline: 255, shadow_blur: 0, line_spacing: 1.1, font_weight: 900, text_transform: "uppercase" },
    "滚动歌词_粉高亮": { scrolling_mode: true, scrolling_visible_lines: 3, scrolling_opacity_context: 0.25, karaoke_highlight: true, font_family: "Impact", fontsize: 68, color_text: "#FFFFFF", color_high: "#FF69B4", use_box: false, use_stroke: true, border_width: 8, color_outline: "#000000", opacity_outline: 255, shadow_blur: 0, line_spacing: 1.1, font_weight: 900, text_transform: "uppercase" },
    "白底框_紫字高亮": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 60, color_text: "#000000", color_high: "#8A2BE2", use_box: true, box_adaptive_width: true, color_bg: "#FFFFFF", opacity_bg: 255, box_radius: 4, box_padding_x: 20, box_padding_y: 10, use_stroke: false, shadow_blur: 0, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "黑底框_粉字高亮": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 60, color_text: "#FFFFFF", color_high: "#FF69B4", use_box: true, box_adaptive_width: true, color_bg: "#333333", opacity_bg: 255, box_radius: 4, box_padding_x: 20, box_padding_y: 10, use_stroke: false, shadow_blur: 0, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "软阴影_青字高亮": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 65, color_text: "#FFFFFF", color_high: "#00FFFF", use_box: false, use_stroke: false, shadow_blur: 12, color_shadow: "#000000", opacity_shadow: 200, shadow_offset_x: 0, shadow_offset_y: 4, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "硬阴影_黄字高亮": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 65, color_text: "#FFFFFF", color_high: "#FFD700", use_box: false, use_stroke: false, shadow_blur: 0, color_shadow: "#000000", opacity_shadow: 255, shadow_offset_x: 6, shadow_offset_y: 6, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "紫色动态底框": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 60, color_text: "#FFFFFF", color_high: "#FFFFFF", use_box: false, use_stroke: false, shadow_blur: 4, color_shadow: "#000000", opacity_shadow: 150, shadow_offset_x: 2, shadow_offset_y: 2, dynamic_box: true, color_high_bg: "#7B68EE", opacity_high_bg: 255, dynamic_radius: 8, line_spacing: 1.2, font_weight: 900 },
    "荧光绿底框_黑字": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 60, color_text: "#000000", color_high: "#000000", use_box: true, box_adaptive_width: true, color_bg: "#ADFF2F", opacity_bg: 255, box_radius: 6, box_padding_x: 20, box_padding_y: 10, use_stroke: false, shadow_blur: 0, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "纯白发光字": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 65, color_text: "#FFFFFF", color_high: "#FFFFFF", use_box: false, use_stroke: false, shadow_blur: 15, color_shadow: "#FFFFFF", opacity_shadow: 200, shadow_offset_x: 0, shadow_offset_y: 0, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "粉红发光字": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 65, color_text: "#FF69B4", color_high: "#FF69B4", use_box: false, use_stroke: false, shadow_blur: 15, color_shadow: "#FF69B4", opacity_shadow: 200, shadow_offset_x: 0, shadow_offset_y: 0, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "全屏打字机_金黄光标": {
        fullpage_typewriter: true,
        fullpage_typewriter_reveal_type: "char",
        fullpage_typewriter_cursor: true,
        fullpage_typewriter_cursor_char: "|",
        fullpage_typewriter_cursor_color: "#FFD700",
        tw_unrevealed_opacity: 0,
        fontsize: 58,
        color_text: "#FFFFFF",
        use_box: true,
        color_bg: "#000000",
        opacity_bg: 180,
        box_radius: 12,
        box_padding_x: 24,
        box_padding_y: 20,
        line_spacing: 8,
        global_mask_enabled: true,
        global_mask_color: "#000000",
        global_mask_opacity: 0.4,
        pos_y: 0.5,
        wrap_width_percent: 85,
        use_stroke: false,
        anim_in_type: "none",
        anim_out_type: "none"
    },
    "随机分散气泡卡片": {
        anim_in_type: "scatter_pop",
        scatter_max_words: 3,
        scatter_min_scale: 0.9,
        scatter_max_scale: 1.4,
        scatter_min_rotate: -8,
        scatter_max_rotate: 8,
        scatter_accum_prob: 0.5,
        use_box: true,
        color_bg: "#6A0DAD",
        opacity_bg: 220,
        box_radius: 12,
        box_padding_x: 16,
        box_padding_y: 12,
        color_text: "#FFFFFF",
        color_high: "#FFD700",
        fontsize: 52,
        bold: true,
        use_stroke: false,
        anim_out_type: "none"
    },
    "随机单词定位": {
        anim_in_type: "word_random_position",
        scatter_seed: 1,
        scatter_min_scale: 0.95,
        scatter_max_scale: 1.35,
        scatter_min_rotate: 0,
        scatter_max_rotate: 0,
        scatter_area_left: 15,
        scatter_area_right: 85,
        scatter_area_top: 25,
        scatter_area_bottom: 75,
        random_position_use_layout_range: true,
        random_position_height_percent: 40,
        word_pop_random_duration: 0.16,
        font_family: "Anton",
        font_weight: 700,
        color_text: "#FFFFFF",
        color_high: "#FFFFFF",
        fontsize: 82,
        bold: true,
        letter_spacing: 1,
        use_stroke: true,
        color_outline: "#000000",
        border_width: 7,
        use_box: false,
        shadow_blur: 3,
        color_shadow: "#000000",
        pos_y: 0.5,
        wrap_width_percent: 40,
        anim_out_type: "none"
    },
    "霓虹蓝粉渐变框": {
        font_family: "Segoe UI",
        font_weight: 900,
        color_text: "#FFFFFF",
        color_high: "#FFFFFF",
        fontsize: 58,
        bold: true,
        italic: false,
        letter_spacing: 0,
        use_stroke: false,
        border_width: 0,
        use_box: true,
        color_bg: "#1e70ff",
        opacity_bg: 255,
        box_padding_x: 24,
        box_padding_y: 15,
        box_radius: 12,
        box_blur: 0,
        shadow_blur: 0,
        bg_gradient_enabled: true,
        bg_gradient_type: "linear_h",
        bg_gradient_colors: "#1e70ff,#9c42c7,#ff2e93",
        bg_gradient_highlight: false,
        use_underline: false,
        dynamic_box: false,
        global_mask_enabled: false,
        pos_y: 0.5,
        wrap_width_percent: 85,
        anim_in_type: "pop",
        anim_in_duration: 0.3,
        anim_out_type: "fade",
        anim_out_duration: 0.25,
    },
    "黄线框高亮_逐词弹出": {
        font_family: "Segoe UI",
        font_weight: 900,
        color_text: "#FFFFFF",
        color_high: "#FFD700",
        fontsize: 66,
        bold: true,
        italic: true,
        letter_spacing: 1,
        use_stroke: false,
        border_width: 0,
        use_box: false,
        shadow_blur: 4,
        color_shadow: "#000000",
        dynamic_box: true,
        color_high_bg: "#FFD700",
        opacity_high_bg: 255,
        dynamic_radius: 4,
        high_padding: 6,
        dynamic_box_stroke: true,
        dynamic_box_stroke_width: 3,
        karaoke_highlight: true,
        pos_y: 0.5,
        wrap_width_percent: 85,
        anim_in_type: "word_pop_random_pulse",
        anim_in_duration: 0.22,
        anim_out_type: "fade",
        anim_out_duration: 0.2
    },
    "硬阴影_黄白斜体": {
        font_family: "Segoe UI",
        font_weight: 900,
        color_text: "#FFFFFF",
        color_high: "#FFD700",
        fontsize: 76,
        bold: true,
        italic: true,
        letter_spacing: 1,
        use_stroke: true,
        color_outline: "#000000",
        border_width: 3,
        use_box: false,
        shadow_blur: 0,
        color_shadow: "#111111",
        shadow_offset_x: 6,
        shadow_offset_y: 6,
        opacity_shadow: 255,
        pos_y: 0.5,
        wrap_width_percent: 85,
        anim_in_type: "word_pop_random_pulse",
        anim_in_duration: 0.22,
        anim_out_type: "fade",
        anim_out_duration: 0.2,
    },
    "撞色黄底框高亮": {
        font_family: "Segoe UI",
        font_weight: 900,
        color_text: "#FFFFFF",
        color_high: "#FFFFFF",
        fontsize: 66,
        bold: true,
        italic: false,
        letter_spacing: 1,
        use_stroke: false,
        border_width: 0,
        use_box: false,
        shadow_blur: 0,
        dynamic_box: true,
        color_high_bg: "#FFD700",
        opacity_high_bg: 255,
        dynamic_radius: 2,
        high_padding: 8,
        dynamic_box_stroke: false,
        dyn_box_anim: false,
        pos_y: 0.5,
        wrap_width_percent: 85,
        anim_in_type: "none",
        anim_in_duration: 0,
        anim_out_type: "none",
        anim_out_duration: 0,
    },
    "红橙渐变_硬阴影": {
        font_family: "Segoe UI",
        font_weight: 900,
        color_text: "#ff2a85,#ff9f21",
        text_gradient_direction: "vertical",
        color_high: "#FFFFFF",
        fontsize: 76,
        bold: true,
        italic: false,
        letter_spacing: 1,
        use_stroke: true,
        color_outline: "#000000",
        border_width: 3,
        use_box: false,
        shadow_blur: 0,
        color_shadow: "#111111",
        shadow_offset_x: 4,
        shadow_offset_y: 4,
        opacity_shadow: 255,
        pos_y: 0.5,
        wrap_width_percent: 85,
        anim_in_type: "word_pop_random_pulse",
        anim_in_duration: 0.22,
        anim_out_type: "fade",
        anim_out_duration: 0.2,
    },
    "霓虹双色发光": {
        font_family: "Segoe UI",
        font_weight: 900,
        color_text: "#FFFFFF",
        color_high: "#FFFFFF",
        fontsize: 72,
        bold: true,
        italic: false,
        letter_spacing: 1,
        use_stroke: false,
        border_width: 0,
        use_box: false,
        shadow_blur: 15,
        color_shadow: "#bd00ff,#00f0ff",
        shadow_offset_x: 0,
        shadow_offset_y: 0,
        opacity_shadow: 255,
        pos_y: 0.5,
        wrap_width_percent: 85,
        anim_in_type: "word_pop_random_pulse",
        anim_in_duration: 0.22,
        anim_out_type: "fade",
        anim_out_duration: 0.2,
    },
    "风驰幻影_白斜体": {
        font_family: "Segoe UI",
        font_weight: 900,
        color_text: "#FFFFFF",
        color_high: "#FFFFFF",
        fontsize: 72,
        bold: true,
        italic: true,
        letter_spacing: 2,
        use_stroke: false,
        border_width: 0,
        use_box: false,
        shadow_blur: 0,
        speed_trail_enabled: true,
        speed_trail_layers: 6,
        speed_trail_step: -6,
        speed_trail_color: "#FFFFFF",
        speed_trail_opacity: 120,
        pos_y: 0.5,
        wrap_width_percent: 85,
        anim_in_type: "pop",
        anim_in_duration: 0.25,
        anim_out_type: "fade",
        anim_out_duration: 0.2,
    },

    "珊瑚红逐词上滑 (爆款)": {
        font_family: "Montserrat",
        color_text: "#FFFFFF",
        color_high: "#FA4E68",
        highlight_enabled: true,
        karaoke_highlight: true,
        fontsize: 66,
        bold: true,
        italic: false,
        font_weight: 700,
        letter_spacing: 0,
        word_spacing: 0,
        line_spacing: 16,
        text_align: "center",
        use_stroke: true,
        color_outline: "#000000",
        opacity_outline: 255,
        border_width: 4.5,
        use_box: false,
        box_wipe_enabled: false,
        shadow_blur: 0,
        shadow_offset_x: 0,
        shadow_offset_y: 0,
        opacity_shadow: 0,
        use_underline: false,
        dynamic_box: false,
        global_mask_enabled: false,
        pos_x: 0.5,
        pos_y: 0.25,
        wrap_width_percent: 82,
        anim_in_type: "slide_up",
        anim_in_duration: 0.16,
        anim_in_easing: "ease_out",
        anim_out_type: "slide_up",
        anim_out_duration: 0.14,
        anim_out_easing: "ease_in_out",
    },

    "远景打字推进 (爆款)": {
        font_family: "Playfair Display",
        color_text: "#FFFFFF",
        color_high: "#FFFFFF",
        highlight_enabled: false,
        karaoke_highlight: false,
        text_transform: "uppercase",
        fontsize: 76,
        bold: true,
        italic: false,
        font_weight: 700,
        letter_spacing: 1,
        word_spacing: 2,
        line_spacing: 8,
        text_align: "center",
        use_stroke: true,
        color_outline: "#000000",
        opacity_outline: 240,
        border_width: 2.5,
        use_box: false,
        box_wipe_enabled: false,
        shadow_blur: 6,
        shadow_offset_x: 2,
        shadow_offset_y: 3,
        color_shadow: "#000000",
        opacity_shadow: 210,
        use_underline: false,
        dynamic_box: false,
        global_mask_enabled: false,
        pos_x: 0.5,
        pos_y: 0.45,
        wrap_width_percent: 84,
        anim_in_type: "zoom_typewriter",
        anim_in_duration: 0.35,
        anim_out_type: "none",
        anim_out_duration: 0,
        typewriter_reveal_type: "char",
        tw_unrevealed_opacity: 0,
    },

    "双行焦点放大 (爆款)": {
        font_family: "Comic Sans MS",
        color_text: "#FFFFFF",
        color_high: "#FBFD07",
        highlight_enabled: true,
        karaoke_highlight: true,
        active_line_focus_enabled: true,
        inactive_line_scale: 0.62,
        text_transform: "uppercase",
        uppercase: true,
        fontsize: 76,
        bold: true,
        italic: true,
        font_weight: 900,
        letter_spacing: 0,
        word_spacing: 0,
        line_spacing: 10,
        text_align: "center",
        use_stroke: true,
        color_outline: "#000000",
        opacity_outline: 255,
        border_width: 7,
        use_box: false,
        box_wipe_enabled: false,
        shadow_blur: 4,
        shadow_offset_x: 0,
        shadow_offset_y: 3,
        color_shadow: "#000000",
        opacity_shadow: 180,
        use_underline: false,
        dynamic_box: false,
        global_mask_enabled: false,
        pos_x: 0.5,
        pos_y: 0.56,
        wrap_width_percent: 86,
        anim_in_type: "line_focus",
        anim_in_duration: 0.2,
        anim_out_type: "none",
        anim_out_duration: 0,
    },

    "参考_黄绿辉光逐词叠排": {
        font_family: "Playfair Display",
        font_weight: 800,
        fontsize: 112,
        bold: true,
        italic: false,
        letter_spacing: -1,
        word_spacing: 0,
        color_text: "#FFFDF2",
        color_high: "#FFFFFF",
        use_stroke: false,
        border_width: 0,
        use_box: false,
        shadow_blur: 0,
        pos_x: 0.50,
        pos_y: 0.50,
        wrap_width_percent: 76,
        anim_in_type: "kinetic_glow_stack",
        anim_in_duration: 0.22,
        anim_out_type: "none",
        anim_out_duration: 0.18,
        kinetic_group_words: 3,
        kinetic_scale_min: 0.66,
        kinetic_scale_max: 1.90,
        kinetic_line_gap: 0.08,
        kinetic_pop_duration: 0.22,
        kinetic_old_word_opacity: 0.92,
        kinetic_old_glow_opacity: 0.78,
        kinetic_glow_color: "#E7FF00",
        kinetic_glow_blur: 64,
        kinetic_background_dim: 0.52,
        kinetic_tint_opacity: 0.26,
        kinetic_vignette_strength: 0.96,
        kinetic_vignette_radius: 0.62,
        kinetic_spotlight_opacity: 0.42,
    },

    "参考_红黑描边粗斜体弹入": {
        font_family: "Arial Black",
        font_weight: 900,
        fontsize: 76,
        bold: true,
        italic: true,
        letter_spacing: 0,
        word_spacing: 0,
        color_text: "#FFFBE0,#FFD66B,#EAA000",
        color_high: "#FFFBE0,#FFD66B,#EAA000",
        karaoke_highlight: false,
        use_box: false,
        use_stroke: true,
        border_width: 4,
        color_outline: "#080808",
        opacity_outline: 255,
        stroke_expand_enabled: true,
        stroke_expand_layers: 3,
        stroke_expand_step: 4,
        stroke_expand_feather: 8,
        stroke_expand_colors: ["#080808", "#FF2438", "#B00018"],
        stroke_expand_layer_widths: [11, 18, 25],
        stroke_expand_layer_feathers: [2, 15, 30],
        effect_controls_enabled: true,
        effect_inner_outline_width: 11,
        effect_glow_range: 25,
        effect_glow_blur: 30,
        effect_glow_opacity: 70,
        shadow_blur: 0,
        shadow_offset_x: 2,
        shadow_offset_y: 5,
        color_shadow: "#000000",
        opacity_shadow: 0,
        pos_x: 0.5,
        pos_y: 0.74,
        wrap_width_percent: 86,
        wrap_lines: 2,
        line_spacing: 1.0,
        anim_in_type: "pop",
        anim_in_duration: 0.14,
        anim_in_easing: "linear",
        anim_out_type: "none",
        anim_out_duration: 0.05,
    }
};

// Category mapping for collapsible preset picker
const PRESET_CATEGORIES = {
    '🔤 动态混排': ['动态混排 · 自动轮换','动态混排 · 首尾大字','动态混排 · 中间强调','动态混排 · 大小拼接','动态混排 · 阶梯错位'],
    '🎯 底框样式': ['红底条逐行擦除 (爆款)','焦糖橙_黄高亮','深海蓝_黄高亮','暗夜青_青高亮','明亮紫_黄高亮','奶油底_藏青高亮','浅丁香_藏青高亮','砖红_金黄高亮','亮蓝_明黄高亮','深紫_粉红高亮','棕褐_奶黄高亮','暗蓝灰_薄荷高亮','白底框_紫字高亮','黑底框_粉字高亮','荧光绿底框_黑字','深蓝大底框+红色动画','深褐底框+红色动画','粉色气泡','渐变蓝色框','霓虹蓝粉渐变框','红色警报'],
    '📝 基础字幕': ['默认白字','黄字黑边 (经典)','上滑入场','左滑入场','黑底白字 (新闻)'],
    '🎤 卡拉OK高亮': ['双行焦点放大 (爆款)','珊瑚红逐词上滑 (爆款)','卡拉OK高亮','节奏逐词','闪光高亮','黑边_粉红高亮','黑边_薄荷高亮','黑边_电蓝高亮','极简纯文+电光青高亮','重金大字+强对比排版'],
    '🔥 逐词动态': ['单词聚焦_自适应色块','逐个大小出字-55','逐个大小出字-45','逐个出字+红色动画','逐个出字大小-爆贴','蓝底白字+动感回弹','黄线框高亮_逐词弹出','撞色黄底框高亮','紫色动态底框','逐字放大','逐词弹出(随机大小)','逐词弹出(随机回弹)','Hormozi 风格字幕'],
    '✨ 特殊动画': ['参考_黄绿辉光逐词叠排','参考_红黑描边粗斜体弹入','远景打字推进 (爆款)','打字机模式','逐行出现','悬浮漂移','霓虹多层描边','滚动歌词_粉高亮','圣光降临','阴影沉浸式','全屏打字机_金黄光标','随机分散气泡卡片','随机单词定位','风驰幻影_白斜体'],
    '💫 阴影发光': ['金色霓虹环境光','参考_黄绿辉光逐词叠排','参考_红黑描边粗斜体弹入','软阴影_青字高亮','硬阴影_黄字高亮','纯白发光字','粉红发光字','硬阴影_黄白斜体','红橙渐变_硬阴影','霓虹双色发光'],
};

function getPresetsByCategory() {
    const data = loadSubtitlePresets();
    const allPresets = data.presets || {};
    const allNames = Object.keys(allPresets);
    const categorized = [];
    const used = new Set();

    // Add categorized built-in presets
    for (const [catName, presetNames] of Object.entries(PRESET_CATEGORIES)) {
        const items = presetNames.filter(n => n in allPresets);
        if (items.length > 0) {
            categorized.push({ category: catName, names: items });
            items.forEach(n => used.add(n));
        }
    }

    // 用户预设允许自定义分组；旧预设未设置分组时归入“我的预设”。
    const userGroups = new Map();
    const presetGroups = data.presetGroups || {};
    allNames.filter(n => !used.has(n)).forEach(name => {
        const group = String(presetGroups[name] || '我的预设').trim() || '我的预设';
        if (!userGroups.has(group)) userGroups.set(group, []);
        userGroups.get(group).push(name);
    });
    [...userGroups.entries()].reverse().forEach(([group, names]) => {
        categorized.unshift({ category: `💾 ${group}`, names });
    });

    return { categorized, presetsMap: allPresets };
}

function _loadPresetsFromStorage() {
    try {
        const raw = typeof window !== 'undefined' && window.electronAPI?.readSubtitlePresets ? window.electronAPI.readSubtitlePresets() : localStorage.getItem(PRESET_STORAGE_KEY);
        if (!raw) {
            console.warn('[StyleEngine] localStorage 中无预设数据 (key:', PRESET_STORAGE_KEY, ')');
            return { default: {}, presets: {}, presetGroups: {} };
        }
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || Array.isArray(data)) return { default: {}, presets: {}, presetGroups: {} };
        data.default = data.default || {};
        data.presets = data.presets || {};
        data.presetGroups = data.presetGroups || {};
        return data;
    } catch (e) {
        console.error('[StyleEngine] 读取预设失败:', e);
        return { default: {}, presets: {}, presetGroups: {} };
    }
}

function _savePresetsToStorage(data) {
    _lastSubtitlePresetSaveError = '';
    try {
        const json = JSON.stringify(data);
        if(typeof window !== 'undefined' && window.electronAPI?.saveSubtitlePresets) {
            const result=window.electronAPI.saveSubtitlePresets(json);
            if(!result?.ok){_lastSubtitlePresetSaveError=result?.error||'无法写入字幕预设库';return false;}
        }else localStorage.setItem(PRESET_STORAGE_KEY, json);
        console.log(`[StyleEngine] 预设已保存 (${(json.length / 1024).toFixed(1)}KB, ${Object.keys(data.presets || {}).length}个预设)`);
        return true;
    } catch (e) {
        _lastSubtitlePresetSaveError = e.message || String(e);
        console.error(`[StyleEngine] 保存预设失败:`, e);
        return false;
    }
}

function loadSubtitlePresets() {
    const data = _loadPresetsFromStorage();
    data.default = extractStyleKeys(data.default);
    const presets = {};
    // 加载内置预设（style-engine 自带）
    for (const [name, style] of Object.entries(BUILTIN_PRESETS)) {
        presets[name] = extractStyleKeys(style);
    }
    // 加载 presets-init.js 中的内置预设（如果已注册到 window）
    if (typeof window !== 'undefined' && window.REELS_BUILTIN_PRESETS) {
        for (const [name, style] of Object.entries(window.REELS_BUILTIN_PRESETS)) {
            presets[name] = extractStyleKeys(style);
        }
    }
    // 加载用户预设 (覆盖同名内置预设)
    for (const [name, style] of Object.entries(data.presets || {})) {
        presets[name] = extractStyleKeys(style);
    }
    data.presets = presets;
    return data;
}

function saveDefaultSubtitleStyle(style) {
    const data = _loadPresetsFromStorage();
    data.default = extractStyleKeys(style);
    return _savePresetsToStorage(data);
}

function saveNamedSubtitlePreset(name, style, group = '') {
    _lastSubtitlePresetSaveError = '';
    if (typeof name !== 'string' || !name.trim()) {_lastSubtitlePresetSaveError='请输入非空的字幕预设名称';return false;}
    name=name.trim();
    const data = _loadPresetsFromStorage();
    const presets = data.presets || {};
    if (!Object.prototype.hasOwnProperty.call(presets,name) && Object.keys(presets).length >= MAX_PRESETS) {_lastSubtitlePresetSaveError=`自存字幕预设已达到 ${MAX_PRESETS} 个，可覆盖已有预设或删除不用的预设后再保存`;return false;}
    presets[name] = extractStyleKeys(style);
    data.presets = presets;
    if (group) data.presetGroups[name] = String(group).trim() || '我的预设';
    return _savePresetsToStorage(data);
}

function deleteSubtitlePreset(name) {
    const data = _loadPresetsFromStorage();
    const presets = data.presets || {};
    if (name in presets) {
        delete presets[name];
        delete data.presetGroups[name];
        data.presets = presets;
        return _savePresetsToStorage(data);
    }
    return false;
}

function renameSubtitlePreset(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return false;
    const data = _loadPresetsFromStorage();
    const presets = data.presets || {};
    if (!(oldName in presets)) return false;
    if (newName in presets) return false;
    presets[newName] = presets[oldName];
    delete presets[oldName];
    if (data.presetGroups[oldName]) { data.presetGroups[newName] = data.presetGroups[oldName]; delete data.presetGroups[oldName]; }
    data.presets = presets;
    return _savePresetsToStorage(data);
}

function setSubtitlePresetGroup(name, group) {
    const data = _loadPresetsFromStorage();
    if (!(name in (data.presets || {}))) return false;
    const normalized = String(group || '').trim() || '我的预设';
    data.presetGroups[name] = normalized;
    return _savePresetsToStorage(data);
}

function applySubtitlePreset(name) {
    const data = loadSubtitlePresets();
    const presets = data.presets || {};
    if (name in presets) return mergeStyle(presets[name]);
    return mergeStyle(data.default);
}

function exportSubtitlePresets() {
    // 只导出用户自定义预设（排除内置预设），避免导入时产生大量冲突
    const data = _loadPresetsFromStorage();
    const userPresets = data.presets || {};
    return JSON.stringify({ default: data.default || {}, presets: userPresets }, null, 2);
}

function importSubtitlePresets(jsonString, overwriteConflicts = false) {
    const result = { added: [], conflicts: [], skipped: [], duplicates: [] };
    try {
        const incoming = JSON.parse(jsonString);
        if (typeof incoming !== 'object') return result;
        const data = _loadPresetsFromStorage();
        if (incoming.default) {
            data.default = extractStyleKeys(incoming.default);
        }
        const presets = data.presets || {};
        const allExistingPresets = loadSubtitlePresets().presets || {};
        const existingContent = new Map();
        for (const [existingName, existingStyle] of Object.entries(allExistingPresets)) {
            const fingerprint = subtitleStyleFingerprint(existingStyle);
            if (!existingContent.has(fingerprint)) existingContent.set(fingerprint, existingName);
        }
        // 收集内置预设名，导入时跳过纯内置预设（避免污染用户存储）
        const builtinNames = new Set(Object.keys(BUILTIN_PRESETS));
        for (const [name, style] of Object.entries(incoming.presets || {})) {
            const normalizedStyle = extractStyleKeys(style);
            const fingerprint = subtitleStyleFingerprint(normalizedStyle);
            // 如果是内置预设且本地没有用户覆盖版本，跳过
            if (builtinNames.has(name) && !(name in presets)) {
                result.skipped.push(name);
                continue;
            }
            if (Object.keys(presets).length >= MAX_PRESETS && !(name in presets)) {
                result.skipped.push(name);
                continue;
            }
            if (name in presets) {
                if (subtitleStyleFingerprint(presets[name]) === fingerprint) {
                    result.duplicates.push(name);
                    continue;
                }
                if (existingContent.has(fingerprint) && existingContent.get(fingerprint) !== name) {
                    result.duplicates.push(name);
                    continue;
                }
                if (overwriteConflicts) {
                    presets[name] = normalizedStyle;
                    allExistingPresets[name] = normalizedStyle;
                    existingContent.clear();
                    for (const [existingName, existingStyle] of Object.entries(allExistingPresets)) {
                        const currentFingerprint = subtitleStyleFingerprint(existingStyle);
                        if (!existingContent.has(currentFingerprint)) existingContent.set(currentFingerprint, existingName);
                    }
                    result.conflicts.push(name);
                } else {
                    result.skipped.push(name);
                }
                continue;
            }
            if (existingContent.has(fingerprint)) {
                result.duplicates.push(name);
                continue;
            }
            presets[name] = normalizedStyle;
            allExistingPresets[name] = normalizedStyle;
            existingContent.set(fingerprint, name);
            result.added.push(name);
        }
        data.presets = presets;
        _savePresetsToStorage(data);
    } catch (e) {
        console.error('[StyleEngine] 导入预设失败:', e);
    }
    return result;
}

// ───────────────────────────────────────────────────────
// Exports
// ───────────────────────────────────────────────────────

const ReelsStyleEngine = {
    DEFAULT_SUBTITLE_STYLE,
    STYLE_KEYS,
    MAX_PRESETS,
    getLastPresetSaveError,
    // Utils
    copyStyle,
    mergeStyle,
    extractStyleKeys,
    subtitleStyleFingerprint,
    prepareSubtitlePresetBatchImport,
    // Presets
    loadSubtitlePresets,
    saveDefaultSubtitleStyle,
    saveNamedSubtitlePreset,
    deleteSubtitlePreset,
    renameSubtitlePreset,
    setSubtitlePresetGroup,
    applySubtitlePreset,
    exportSubtitlePresets,
    importSubtitlePresets,
    getPresetsByCategory,
};

if (typeof window !== 'undefined') window.ReelsStyleEngine = ReelsStyleEngine;
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsStyleEngine;
