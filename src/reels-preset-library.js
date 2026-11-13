/**
 * reels-preset-library.js — Dedicated Animated Subtitle Effect Preview Window
 * + Free/Viral Online & ASS/JSON Preset Reader.
 */
(() => {
    const FAVORITES_STORAGE_KEY = 'vk_subtitle_favorite_presets_v1';
    const ONLINE_CACHE_KEY = 'vk_community_viral_presets_cache_v1';
    const DEFAULT_COMMUNITY_FEED_URL = 'https://raw.githubusercontent.com/golsaysea/videokit-Y/main/presets/community-viral-presets.json';

    const BUILTIN_COMMUNITY_PACKS = [
        {
            id: 'viral-creators-2026',
            name: '🔥 2026 短视频达人免费爆款包',
            description: '灵感源自 Hormozi / Submagic / OpusClip / Iman / Ali Abdaal 高留存口播模板',
            group: '🌐 网络爆款 · 达人同款',
            presets: {
                '🌐 达人_紫电胶囊快剪': {
                    font_family: 'Montserrat', font_weight: 900, fontsize: 70, bold: true, uppercase: true,
                    color_text: '#FFFFFF', color_high: '#FFFFFF', highlight_enabled: true, karaoke_highlight: true,
                    dynamic_box: true, color_high_bg: '#7C3AED', opacity_high_bg: 0.95, dynamic_radius: 14,
                    use_stroke: true, color_outline: '#1E1B4B', opacity_outline: 255, border_width: 5,
                    pos_x: 0.5, pos_y: 0.60, wrap_width_percent: 82, wrap_lines: 2,
                    max_words_per_segment: 4, max_words_per_line: 2,
                    anim_in_type: 'word_pop_random_pulse', anim_in_duration: 0.18, anim_in_easing: 'back',
                },
                '🌐 达人_荧光酸黄双词冲击': {
                    font_family: 'Anton', font_weight: 900, fontsize: 84, bold: true, uppercase: true,
                    color_text: '#F8FAFC', color_high: '#D9F99D', highlight_enabled: true, karaoke_highlight: true,
                    highlight_scale_enabled: true, highlight_scale: 132, highlight_push_apart: true,
                    use_stroke: true, color_outline: '#052E16', opacity_outline: 255, border_width: 8,
                    shadow_blur: 6, shadow_offset_y: 5, color_shadow: '#000000', opacity_shadow: 240,
                    pos_x: 0.5, pos_y: 0.57, max_words_per_segment: 3, max_words_per_line: 2,
                    anim_in_type: 'word_pop_random', anim_in_duration: 0.18, anim_in_easing: 'back',
                },
                '🌐 达人_琥珀流金高级访谈': {
                    font_family: 'Plus Jakarta Sans', font_weight: 700, fontsize: 58, bold: true,
                    color_text: '#FFFBEB', color_high: '#F59E0B', highlight_enabled: true, karaoke_highlight: true,
                    use_stroke: true, color_outline: '#1C1917', opacity_outline: 235, border_width: 3,
                    shadow_blur: 14, shadow_offset_y: 3, color_shadow: '#000000', opacity_shadow: 210,
                    pos_x: 0.5, pos_y: 0.72, wrap_width_percent: 82, wrap_lines: 2,
                    anim_in_type: 'blur_sharp', anim_in_duration: 0.34, anim_in_easing: 'ease_out',
                },
                '🌐 达人_三词叠加极夜霓虹': {
                    font_family: 'Rubik', font_weight: 900, fontsize: 68, bold: true, uppercase: true,
                    color_text: '#F8FAFC', color_high: '#38BDF8', highlight_enabled: true, karaoke_highlight: true,
                    kinetic_glow_color: '#38BDF8', kinetic_glow_blur: 66,
                    kinetic_vignette_strength: 0.94, kinetic_spotlight_opacity: 0.44,
                    use_stroke: true, color_outline: '#082F49', opacity_outline: 255, border_width: 5,
                    pos_x: 0.5, pos_y: 0.50, max_words_per_segment: 3, wrap_lines: 3,
                    anim_in_type: 'kinetic_glow_stack', anim_in_duration: 0.22, anim_in_easing: 'back',
                },
            },
        },
        {
            id: 'free-ass-fansub-pack',
            name: '🎭 开源动漫/ASS 免费特效字幕包',
            description: '兼容开源 Aegisub / Fansub 双色描边、霓虹柔光与四行彩虹卡拉OK',
            group: '🌐 网络爆款 · 开源ASS风格',
            presets: {
                '🎭 ASS_晴空樱粉柔光番剧体': {
                    font_family: 'Poppins', font_weight: 700, fontsize: 60, bold: true,
                    color_text: '#FFF1F2', color_high: '#F472B6', highlight_enabled: true, karaoke_highlight: true,
                    use_stroke: true, color_outline: '#500724', opacity_outline: 255, border_width: 4.5,
                    holy_glow_color: '#FBCFE8', holy_glow_radius: 9,
                    pos_x: 0.5, pos_y: 0.78, wrap_width_percent: 86, wrap_lines: 2,
                    anim_in_type: 'holy_glow', anim_in_duration: 0.26, anim_in_easing: 'ease_out',
                },
                '🎭 ASS_燃系动漫橘红双扩边': {
                    font_family: 'Oswald', font_weight: 800, fontsize: 68, bold: true, uppercase: true,
                    color_text: '#FEF08A', color_high: '#EF4444', highlight_enabled: true, karaoke_highlight: true,
                    use_stroke: true, color_outline: '#09090B', opacity_outline: 255, border_width: 5.5,
                    stroke_expand_enabled: true, stroke_expand_layers: 3, stroke_expand_step: 3,
                    stroke_expand_feather: 3, stroke_expand_colors: '#F97316,#7C2D12,#09090B',
                    pos_x: 0.5, pos_y: 0.74, wrap_width_percent: 84, wrap_lines: 2,
                    anim_in_type: 'char_pop_elastic', anim_in_duration: 0.28, anim_in_easing: 'back',
                },
                '🎭 ASS_OP歌词彩虹渐进卡拉OK': {
                    font_family: 'Outfit', font_weight: 700, fontsize: 58, bold: true,
                    color_text: '#FFFFFF', color_high: '#67E8F9', highlight_enabled: true, karaoke_highlight: true,
                    scrolling_mode: true, scrolling_visible_lines: 4, scrolling_opacity_context: 0.34,
                    rolling_rainbow_colors: '#38BDF8,#818CF8,#C084FC,#F472B6,#FBBF24',
                    use_stroke: true, color_outline: '#0F172A', opacity_outline: 250, border_width: 4,
                    pos_x: 0.5, pos_y: 0.56, wrap_lines: 4,
                    anim_in_type: 'rolling_rainbow_karaoke', anim_in_duration: 0.25, anim_in_easing: 'ease_out',
                },
            },
        },
        {
            id: 'viral-podcast-editorial-free',
            name: '📰 爆款播客 & 杂志剪报免费拓展包',
            description: '适合知识科普、读书金句、商业访谈与手账贴纸风口播',
            group: '🌐 网络爆款 · 知识剪报',
            presets: {
                '📰 社区_复古绿色邮报贴字': {
                    font_family: 'Playfair Display', font_weight: 700, fontsize: 58, bold: true,
                    color_text: '#064E3B', color_high: '#D97706', highlight_enabled: true, karaoke_highlight: true,
                    use_stroke: false, use_box: true, box_adaptive_width: true, box_connected: true,
                    box_brush_style: 'torn_cream_paper', color_bg: '#FAF5EC', opacity_bg: 255,
                    box_padding_x: 24, box_padding_y: 12, box_radius: 10, pos_x: 0.5, pos_y: 0.68,
                    anim_in_type: 'fade', anim_in_duration: 0.2, anim_in_easing: 'ease_out',
                },
                '📰 社区_深海青底金字知识卡': {
                    font_family: 'Bricolage Grotesque', font_weight: 700, fontsize: 56, bold: true,
                    color_text: '#F0FDFA', color_high: '#FACC15', highlight_enabled: true, karaoke_highlight: true,
                    use_stroke: false, use_box: true, box_wipe_enabled: true, box_adaptive_width: true,
                    box_connected: true, color_bg: '#115E59', opacity_bg: 238,
                    box_padding_x: 24, box_padding_y: 12, box_radius: 10, pos_x: 0.5, pos_y: 0.74,
                    anim_in_type: 'box_wipe', anim_in_duration: 0.3, anim_in_easing: 'ease_out',
                },
                '📰 社区_黑金硬核播客金句框': {
                    font_family: 'Space Grotesk', font_weight: 700, fontsize: 56, bold: true,
                    color_text: '#FEF9C3', color_high: '#F97316', highlight_enabled: true, karaoke_highlight: true,
                    use_stroke: false, use_box: true, box_adaptive_width: true, box_connected: true,
                    box_brush_style: 'dark_film_matte', color_bg: '#191A20', opacity_bg: 255,
                    box_padding_x: 24, box_padding_y: 12, box_radius: 10, pos_x: 0.5, pos_y: 0.72,
                    anim_in_type: 'slide_up', anim_in_duration: 0.2, anim_in_easing: 'ease_out',
                },
            },
        },
    ];

    const QUICK_TEXT_SCRIPTS = [
        {
            id: 'en_viral',
            label: '英文爆款',
            text: "Stop scrolling and watch how captions boost retention",
            segments: [
                { start: 0, end: 2.8, text: 'Stop scrolling right now', words: [
                    { word: 'Stop', start: 0, end: 0.7 }, { word: 'scrolling', start: 0.7, end: 1.4 },
                    { word: 'right', start: 1.4, end: 2.1 }, { word: 'now', start: 2.1, end: 2.8 },
                ] },
                { start: 2.8, end: 5.8, text: 'Watch this viral caption', words: [
                    { word: 'Watch', start: 2.8, end: 3.55 }, { word: 'this', start: 3.55, end: 4.3 },
                    { word: 'viral', start: 4.3, end: 5.05 }, { word: 'caption', start: 5.05, end: 5.8 },
                ] },
                { start: 5.8, end: 9.0, text: 'Double your watch time', words: [
                    { word: 'Double', start: 5.8, end: 6.6 }, { word: 'your', start: 6.6, end: 7.4 },
                    { word: 'watch', start: 7.4, end: 8.2 }, { word: 'time', start: 8.2, end: 9.0 },
                ] },
            ],
        },
        {
            id: 'bilingual',
            label: '中英口播',
            text: 'Sample 字幕 效果 实时 预览',
            segments: [
                { start: 0, end: 3, text: 'Sample subtitle font preview', words: [
                    { word: 'Sample', start: 0, end: 0.75 }, { word: 'subtitle', start: 0.75, end: 1.5 },
                    { word: 'font', start: 1.5, end: 2.25 }, { word: 'preview', start: 2.25, end: 3 },
                ] },
                { start: 3, end: 6, text: '无需 点击 实时 看效果', words: [
                    { word: '无需', start: 3, end: 3.75 }, { word: '点击', start: 3.75, end: 4.5 },
                    { word: '实时', start: 4.5, end: 5.25 }, { word: '看效果', start: 5.25, end: 6 },
                ] },
                { start: 6, end: 9, text: '导出 效果 完全 一致', words: [
                    { word: '导出', start: 6, end: 6.75 }, { word: '效果', start: 6.75, end: 7.5 },
                    { word: '完全', start: 7.5, end: 8.25 }, { word: '一致', start: 8.25, end: 9 },
                ] },
            ],
        },
        {
            id: 'faith',
            label: '信仰金句',
            text: 'Thank You God for every blessing',
            segments: [
                { start: 0, end: 3, text: 'Thank You God always', words: [
                    { word: 'Thank', start: 0, end: 0.75 }, { word: 'You', start: 0.75, end: 1.5 },
                    { word: 'God', start: 1.5, end: 2.25 }, { word: 'always', start: 2.25, end: 3 },
                ] },
                { start: 3, end: 6, text: 'Grace surrounds your life', words: [
                    { word: 'Grace', start: 3, end: 3.75 }, { word: 'surrounds', start: 3.75, end: 4.5 },
                    { word: 'your', start: 4.5, end: 5.25 }, { word: 'life', start: 5.25, end: 6 },
                ] },
                { start: 6, end: 9, text: 'Walk in peace today', words: [
                    { word: 'Walk', start: 6, end: 6.75 }, { word: 'in', start: 6.75, end: 7.5 },
                    { word: 'peace', start: 7.5, end: 8.25 }, { word: 'today', start: 8.25, end: 9 },
                ] },
            ],
        },
        {
            id: 'zh_hook',
            label: '中文金句',
            text: '掌握 这三个 底层 逻辑',
            segments: [
                { start: 0, end: 3, text: '掌握 这三个 关键 技巧', words: [
                    { word: '掌握', start: 0, end: 0.75 }, { word: '这三个', start: 0.75, end: 1.5 },
                    { word: '关键', start: 1.5, end: 2.25 }, { word: '技巧', start: 2.25, end: 3 },
                ] },
                { start: 3, end: 6, text: '流量 转化 立刻 翻倍', words: [
                    { word: '流量', start: 3, end: 3.75 }, { word: '转化', start: 3.75, end: 4.5 },
                    { word: '立刻', start: 4.5, end: 5.25 }, { word: '翻倍', start: 5.25, end: 6 },
                ] },
                { start: 6, end: 9, text: '点赞 收藏 慢慢 研究', words: [
                    { word: '点赞', start: 6, end: 6.75 }, { word: '收藏', start: 6.75, end: 7.5 },
                    { word: '慢慢', start: 7.5, end: 8.25 }, { word: '研究', start: 8.25, end: 9 },
                ] },
            ],
        },
    ];

    function _esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function _sanitizeStyleObject(rawObj) {
        if (!rawObj || typeof rawObj !== 'object') return {};
        const engine = typeof window !== 'undefined' ? window.ReelsStyleEngine : (typeof globalThis !== 'undefined' ? globalThis.ReelsStyleEngine : null);
        if (engine && typeof engine.extractStyleKeys === 'function') {
            return engine.extractStyleKeys(rawObj);
        }
        const safe = {};
        for (const [k, v] of Object.entries(rawObj)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            safe[k] = v;
        }
        return safe;
    }

    /**
     * Convert ASS/SSA color (&HAABBGGRR or &HBBGGRR) to CSS hex and 0..255 opacity.
     */
    function parseAssColorToHex(rawColor, fallbackHex = '#FFFFFF') {
        const cleaned = String(rawColor || '').trim().replace(/^&H/i, '').replace(/&$/g, '');
        if (/^[0-9a-f]{8}$/i.test(cleaned)) {
            const aa = parseInt(cleaned.slice(0, 2), 16);
            const bb = cleaned.slice(2, 4);
            const gg = cleaned.slice(4, 6);
            const rr = cleaned.slice(6, 8);
            const opacity255 = Math.max(0, Math.min(255, 255 - aa));
            return {
                hex: `#${rr}${gg}${bb}`.toUpperCase(),
                opacity255,
                alpha: +(opacity255 / 255).toFixed(3),
            };
        }
        if (/^[0-9a-f]{6}$/i.test(cleaned)) {
            const bb = cleaned.slice(0, 2);
            const gg = cleaned.slice(2, 4);
            const rr = cleaned.slice(4, 6);
            return { hex: `#${rr}${gg}${bb}`.toUpperCase(), opacity255: 255, alpha: 1 };
        }
        if (/^#[0-9a-f]{6}$/i.test(String(rawColor || '').trim())) {
            return { hex: String(rawColor).trim().toUpperCase(), opacity255: 255, alpha: 1 };
        }
        return { hex: fallbackHex, opacity255: 255, alpha: 1 };
    }

    /**
     * Parse Aegisub .ass / .ssa subtitle styles ([V4+ Styles] / [V4 Styles]) + event tag hints
     * into VideoKit subtitle preset objects.
     */
    function parseAssStylesToPresets(assText, prefixLabel = '🎭 ASS') {
        const text = String(assText || '');
        const lines = text.split(/\r?\n/);
        const presets = {};
        const warnings = [];

        const hasKaraokeTags = /\{[^}]*\\k[fo]?\d+/i.test(text);
        const hasFadeTags = /\{[^}]*\\fad(?:e)?\(/i.test(text);
        const hasBlurTags = /\{[^}]*\\(?:blur|be)\d+/i.test(text);

        let inStylesSection = false;
        let columns = [
            'Name', 'Fontname', 'Fontsize', 'PrimaryColour', 'SecondaryColour',
            'OutlineColour', 'BackColour', 'Bold', 'Italic', 'Underline',
            'StrikeOut', 'ScaleX', 'ScaleY', 'Spacing', 'Angle',
            'BorderStyle', 'Outline', 'Shadow', 'Alignment', 'MarginL', 'MarginR', 'MarginV', 'Encoding',
        ];

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith(';')) continue;
            if (/^\[.+\]$/.test(line)) {
                inStylesSection = /^\[V4\+?\s*Styles\]$/i.test(line);
                continue;
            }
            if (!inStylesSection) continue;

            if (/^Format:/i.test(line)) {
                columns = line.slice(7).split(',').map(c => c.trim());
                continue;
            }
            if (!/^Style:/i.test(line)) continue;

            const rawValues = line.slice(6).split(',');
            if (rawValues.length < 3) continue;
            const row = {};
            columns.forEach((col, idx) => {
                row[col.toLowerCase()] = (rawValues[idx] ?? '').trim();
            });

            const styleName = (row.name || `Style_${Object.keys(presets).length + 1}`).replace(/[\r\n]/g, ' ').trim();
            if (!styleName || styleName === '__proto__' || styleName === 'constructor' || styleName === 'prototype') continue;

            const primary = parseAssColorToHex(row.primarycolour, '#FFFFFF');
            const secondary = parseAssColorToHex(row.secondarycolour, '#FFD700');
            const outline = parseAssColorToHex(row.outlinecolour, '#000000');
            const back = parseAssColorToHex(row.backcolour, '#000000');

            const rawFontSize = parseFloat(row.fontsize);
            const fontsize = Number.isFinite(rawFontSize)
                ? Math.max(24, Math.min(120, Math.round(rawFontSize * (rawFontSize < 40 ? 1.45 : 1))))
                : 60;
            const isBold = row.bold === '-1' || row.bold === '1' || parseInt(row.bold, 10) >= 600;
            const isItalic = row.italic === '-1' || row.italic === '1';
            const isUnderline = row.underline === '-1' || row.underline === '1';
            const borderStyle = parseInt(row.borderstyle, 10) || 1;
            const outlineWidth = Math.max(0, Math.min(18, parseFloat(row.outline) || 3));
            const shadowDist = Math.max(0, Math.min(16, parseFloat(row.shadow) || 0));
            const spacing = Number.isFinite(parseFloat(row.spacing)) ? Math.max(-4, Math.min(20, parseFloat(row.spacing))) : 0;
            const alignment = parseInt(row.alignment, 10) || 2;

            let pos_y = 0.76;
            if (alignment >= 7) pos_y = 0.22;
            else if (alignment >= 4) pos_y = 0.50;

            const horiz = (alignment - 1) % 3;
            const text_align = horiz === 0 ? 'left' : (horiz === 2 ? 'right' : 'center');
            const useBox = borderStyle === 3;
            const highlightColor = (secondary.hex !== primary.hex) ? secondary.hex : '#FFD700';

            const mapped = {
                font_family: (row.fontname || 'Montserrat').replace(/^@/, '').trim() || 'Montserrat',
                font_weight: isBold ? 800 : 500,
                fontsize,
                bold: isBold,
                italic: isItalic,
                letter_spacing: spacing,
                text_align,
                color_text: primary.hex,
                color_high: highlightColor,
                highlight_enabled: true,
                karaoke_highlight: hasKaraokeTags || secondary.hex !== primary.hex,
                use_stroke: !useBox && outlineWidth > 0,
                color_outline: outline.hex,
                opacity_outline: outline.opacity255,
                border_width: outlineWidth || 3,
                use_box: useBox,
                box_adaptive_width: useBox,
                box_connected: useBox,
                color_bg: useBox ? (back.hex || outline.hex) : '#000000',
                opacity_bg: useBox ? Math.max(120, back.opacity255) : 180,
                box_padding_x: 22,
                box_padding_y: 12,
                box_radius: 10,
                use_underline: isUnderline,
                color_underline: highlightColor,
                shadow_blur: hasBlurTags ? 10 : Math.min(12, shadowDist * 2.5),
                shadow_offset_x: shadowDist > 0 ? shadowDist : 0,
                shadow_offset_y: shadowDist > 0 ? shadowDist : 2,
                color_shadow: back.hex || '#000000',
                opacity_shadow: shadowDist > 0 ? Math.max(140, back.opacity255) : 160,
                pos_x: 0.5,
                pos_y,
                wrap_width_percent: 84,
                wrap_lines: 2,
                anim_in_type: hasBlurTags ? 'holy_glow' : (hasFadeTags ? 'fade' : (hasKaraokeTags ? 'pop' : 'fade')),
                anim_in_duration: 0.24,
                anim_in_easing: 'ease_out',
                anim_out_type: 'fade',
                anim_out_duration: 0.14,
            };

            const finalName = prefixLabel ? `${prefixLabel}_${styleName}` : styleName;
            presets[finalName] = _sanitizeStyleObject(mapped);
        }

        if (Object.keys(presets).length === 0) {
            warnings.push('未检测到 [V4+ Styles] 中的 Style: 行');
        }
        return { presets, warnings, eventHints: { hasKaraokeTags, hasFadeTags, hasBlurTags } };
    }

    /**
     * Normalize community JSON objects (supporting both VideoKit STYLE_KEYS and camelCase/external field names).
     */
    function normalizeExternalPresetObject(rawStyle) {
        if (!rawStyle || typeof rawStyle !== 'object') return {};
        const src = { ...rawStyle };
        const aliasMap = {
            font: 'font_family',
            fontFamily: 'font_family',
            fontName: 'font_family',
            fontSize: 'fontsize',
            size: 'fontsize',
            fontWeight: 'font_weight',
            color: 'color_text',
            textColor: 'color_text',
            primaryColor: 'color_text',
            highlightColor: 'color_high',
            activeColor: 'color_high',
            secondaryColor: 'color_high',
            strokeColor: 'color_outline',
            outlineColor: 'color_outline',
            strokeWidth: 'border_width',
            outlineWidth: 'border_width',
            backgroundColor: 'color_bg',
            bgColor: 'color_bg',
            boxColor: 'color_bg',
            borderRadius: 'box_radius',
            animation: 'anim_in_type',
            animIn: 'anim_in_type',
            glowColor: 'holy_glow_color',
            glowRadius: 'holy_glow_radius',
            shadowColor: 'color_shadow',
            posY: 'pos_y',
            posX: 'pos_x',
            textAlign: 'text_align',
            align: 'text_align',
        };
        for (const [extKey, targetKey] of Object.entries(aliasMap)) {
            if (extKey in src && src[extKey] !== undefined && !(targetKey in src)) {
                src[targetKey] = src[extKey];
            }
        }
        if ('backgroundColor' in src || 'bgColor' in src || 'boxColor' in src) {
            if (!('use_box' in src)) src.use_box = true;
        }
        if ('strokeWidth' in src && !('use_stroke' in src)) {
            src.use_stroke = Number(src.strokeWidth) > 0;
        }
        return _sanitizeStyleObject(src);
    }

    /**
     * Parse arbitrary preset bundle payloads (.ass/.ssa or .json).
     */
    function parsePresetBundlePayload(rawText, sourceLabel = '导入') {
        const text = String(rawText || '').trim();
        if (!text) return { format: 'empty', packs: [], presets: {} };

        // 1) Detect ASS / SSA format
        if (/\[V4\+?\s*Styles\]/i.test(text) || /^\[Script Info\]/im.test(text)) {
            const parsed = parseAssStylesToPresets(text, '🎭 ASS');
            return {
                format: 'ass',
                packs: [{
                    id: 'ass-import',
                    name: `${sourceLabel} (.ASS 样式)`,
                    group: '🌐 网络爆款 · ASS导入',
                    presets: parsed.presets,
                }],
                presets: parsed.presets,
                warnings: parsed.warnings,
            };
        }

        // 2) JSON format
        const parsedJson = JSON.parse(text);
        if (!parsedJson || typeof parsedJson !== 'object') {
            throw new Error('无效的预设数据结构');
        }

        const packs = [];
        const combinedPresets = {};

        const addEntry = (name, styleObj) => {
            const cleanName = String(name || '').trim();
            if (!cleanName || cleanName === '__proto__' || cleanName === 'constructor' || cleanName === 'prototype') return;
            const norm = normalizeExternalPresetObject(styleObj);
            if (Object.keys(norm).length > 0) combinedPresets[cleanName] = norm;
        };

        if (Array.isArray(parsedJson.packs)) {
            for (const pack of parsedJson.packs) {
                if (!pack || typeof pack !== 'object' || !pack.presets || typeof pack.presets !== 'object') continue;
                const cleanPackPresets = {};
                for (const [k, v] of Object.entries(pack.presets)) {
                    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
                    const norm = normalizeExternalPresetObject(v);
                    if (Object.keys(norm).length > 0) {
                        cleanPackPresets[k] = norm;
                        combinedPresets[k] = norm;
                    }
                }
                if (Object.keys(cleanPackPresets).length > 0) {
                    packs.push({
                        id: String(pack.id || `pack-${packs.length + 1}`),
                        name: String(pack.name || '社区免费效果包'),
                        description: String(pack.description || ''),
                        group: String(pack.group || '🌐 网络爆款导入'),
                        presets: cleanPackPresets,
                    });
                }
            }
            return { format: 'community-packs', packs, presets: combinedPresets };
        }

        if (Array.isArray(parsedJson)) {
            parsedJson.forEach((item, idx) => {
                if (!item || typeof item !== 'object') return;
                const name = item.name || item.title || item.id || `${sourceLabel}_${idx + 1}`;
                addEntry(name, item.style || item);
            });
        } else if (parsedJson.presets && typeof parsedJson.presets === 'object') {
            for (const [name, styleObj] of Object.entries(parsedJson.presets)) addEntry(name, styleObj);
        } else if ('font_family' in parsedJson || 'fontFamily' in parsedJson || 'color_text' in parsedJson || 'color' in parsedJson) {
            addEntry(`${sourceLabel}_预设`, parsedJson);
        } else {
            for (const [name, styleObj] of Object.entries(parsedJson)) addEntry(name, styleObj);
        }

        if (Object.keys(combinedPresets).length > 0) {
            packs.push({
                id: 'json-import',
                name: `${sourceLabel}`,
                group: '🌐 网络爆款导入',
                presets: combinedPresets,
            });
        }

        return { format: 'json', packs, presets: combinedPresets };
    }

    function getEffectFeatureTags(style = {}) {
        const s = style || {};
        const anim = String(s.anim_in_type || 'none');
        const tags = [];
        const keys = new Set();

        if (anim.includes('word_pop') || s.highlight_scale_enabled || anim === 'three_word_focus_stack' || anim === 'line_focus') {
            keys.add('word_pop');
            tags.push('🔥 逐词焦点');
        }
        if (s.holy_glow_radius > 0 || anim === 'holy_glow' || anim === 'kinetic_glow_stack' || s.ambient_glow_enabled || s.stroke_expand_enabled) {
            keys.add('glow');
            tags.push('✨ 辉光霓虹');
        }
        if (s.scrolling_mode || anim.startsWith('rolling_')) {
            keys.add('rolling');
            tags.push('🎤 多行滚词');
        }
        if (s.box_brush_style && s.box_brush_style !== 'rect') {
            keys.add('cutout');
            tags.push('✂️ 剪报笔刷');
        }
        if (s.extrude_3d_enabled) {
            keys.add('3d');
            tags.push('🧊 3D立体');
        }
        if (anim === 'typewriter' || anim === 'zoom_typewriter' || anim === 'underline_sweep' || anim === 'box_wipe' || anim === 'feather_wipe' || anim === 'speech_feather_wipe' || anim === 'blur_sharp') {
            keys.add('laser_type');
            tags.push('⌨️ 扫字/打字');
        }
        if (s.text_gradient_enabled || s.high_gradient_enabled || s.outline_gradient_enabled) {
            keys.add('gradient');
            tags.push('🎨 渐变');
        }
        if (s.use_box || s.dynamic_box) {
            keys.add('box');
            tags.push('🎯 底框');
        }
        if (anim.startsWith('char_') || anim === 'letter_jump' || s.speed_trail_enabled) {
            keys.add('char_physics');
            tags.push('⚡ 逐字动效');
        }
        return { keys, tags: tags.slice(0, 3) };
    }

    async function fetchRemotePresetSource(rawUrl) {
        const cleanUrl = String(rawUrl || '').trim();
        if (!/^https:\/\//i.test(cleanUrl)) {
            throw new Error('请输入有效的 https:// 公开链接');
        }
        let text = '';
        if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.fetchRemotePresetPack === 'function') {
            const resp = await window.electronAPI.fetchRemotePresetPack(cleanUrl);
            if (!resp || !resp.ok) throw new Error(resp?.error || '远程读取失败');
            text = resp.text;
        } else {
            const resp = await fetch(cleanUrl, { signal: AbortSignal.timeout(8000) });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            text = await resp.text();
        }
        const hostName = (() => { try { return new URL(cleanUrl).hostname; } catch { return '在线预设'; } })();
        return parsePresetBundlePayload(text, hostName);
    }

    function _loadFavorites() {
        try {
            const raw = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || '[]');
            return new Set(Array.isArray(raw) ? raw : []);
        } catch {
            return new Set();
        }
    }

    function _saveFavorites(favSet) {
        try {
            localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(favSet)));
        } catch (_) {}
    }

    function _loadCommunityPacks() {
        try {
            const cached = JSON.parse(localStorage.getItem(ONLINE_CACHE_KEY) || 'null');
            if (cached && Array.isArray(cached.packs) && cached.packs.length > 0) {
                return { packs: cached.packs, syncedAt: cached.syncedAt || 0, source: 'remote-cache' };
            }
        } catch (_) {}
        return { packs: BUILTIN_COMMUNITY_PACKS, syncedAt: 0, source: 'builtin' };
    }

    function _saveCommunityPacks(packs) {
        try {
            localStorage.setItem(ONLINE_CACHE_KEY, JSON.stringify({ packs, syncedAt: Date.now() }));
        } catch (_) {}
    }

    function _buildDynamicPreviewSegments(customSentence) {
        const raw = String(customSentence || '').trim();
        if (!raw) return QUICK_TEXT_SCRIPTS[1].segments;
        const words = raw.split(/\s+/).filter(Boolean);
        if (words.length <= 1) {
            const chars = Array.from(raw);
            const seg1 = chars.slice(0, Math.ceil(chars.length / 2)).join('');
            const seg2 = chars.slice(Math.ceil(chars.length / 2)).join('') || seg1;
            return [
                { start: 0, end: 3, text: raw, words: [{ word: raw, start: 0, end: 3 }] },
                { start: 3, end: 6, text: seg1, words: [{ word: seg1, start: 3, end: 6 }] },
                { start: 6, end: 9, text: seg2, words: [{ word: seg2, start: 6, end: 9 }] },
            ];
        }
        const buildSeg = (chunk, start, end) => {
            const dur = (end - start) / Math.max(1, chunk.length);
            return {
                start,
                end,
                text: chunk.join(' '),
                words: chunk.map((w, i) => ({ word: w, start: start + i * dur, end: start + (i + 1) * dur })),
            };
        };
        const c1 = words.slice(0, Math.min(4, words.length));
        const c2 = words.length > 4 ? words.slice(4, 8) : words.slice(0, Math.min(4, words.length));
        return [buildSeg(c1, 0, 3), buildSeg(c2, 3, 6), buildSeg(c1, 6, 9)];
    }

    function _drawBackdrop(ctx, width, height, sceneId, posterImg) {
        ctx.save();
        if (sceneId === 'video' && posterImg) {
            const ir = posterImg.naturalWidth / Math.max(1, posterImg.naturalHeight);
            const cr = width / height;
            let dw = width, dh = height, dx = 0, dy = 0;
            if (ir > cr) {
                dw = height * ir;
                dx = (width - dw) * 0.5;
            } else {
                dh = width / ir;
                dy = (height - dh) * 0.5;
            }
            ctx.drawImage(posterImg, dx, dy, dw, dh);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
            ctx.fillRect(0, 0, width, height);
            ctx.restore();
            return;
        }
        if (sceneId === 'warm') {
            const g = ctx.createLinearGradient(0, 0, width, height);
            g.addColorStop(0, '#431407');
            g.addColorStop(0.5, '#7c2d12');
            g.addColorStop(1, '#1c1917');
            ctx.fillStyle = g;
        } else if (sceneId === 'daylight') {
            const g = ctx.createLinearGradient(0, 0, 0, height);
            g.addColorStop(0, '#e2e8f0');
            g.addColorStop(0.6, '#cbd5e1');
            g.addColorStop(1, '#94a3b8');
            ctx.fillStyle = g;
        } else if (sceneId === 'cyber') {
            const g = ctx.createLinearGradient(0, 0, width, height);
            g.addColorStop(0, '#0f172a');
            g.addColorStop(0.45, '#3b0764');
            g.addColorStop(1, '#082f49');
            ctx.fillStyle = g;
        } else {
            const g = ctx.createLinearGradient(0, 0, 0, height);
            g.addColorStop(0, '#0b0d17');
            g.addColorStop(1, '#14172b');
            ctx.fillStyle = g;
        }
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
    }

    /**
     * Launch the full-featured Animated Subtitle Effect Preview Window.
     * Supports standalone invocation OR callback `{ currentVal, onSelect, initialGroup }`.
     */
    function reelsOpenSubtitlePresetLibrary(options = {}) {
        if (typeof options === 'function') options = { onSelect: options };
        if (!window.ReelsStyleEngine?.getPresetsByCategory) return;

        // Avoid duplicate open modals
        document.querySelectorAll('.reels-subtitle-preset-library').forEach(el => el.remove());

        const hiddenInput = document.getElementById('reels-preset-select');
        const initialCurrentName = String(options.currentVal ?? hiddenInput?.value ?? '').trim();
        const { categorized = [], presetsMap = {} } = window.ReelsStyleEngine.getPresetsByCategory();
        const myPresetNames = categorized.find(g => g.category === '💾 我的预设')?.names || [];
        const favorites = _loadFavorites();
        const currentAppliedStyle = (typeof _readStyleFromUI === 'function' ? _readStyleFromUI() : null)
            || window.ReelsStyleEngine.mergeStyle({});

        const NEW_VIRAL_CODES = new Set(Array.from({ length: 100 }, (_, i) => `sub-${128 + i}`));

        // Build flat item metadata array
        const items = [];
        categorized.forEach(group => {
            const isCustomGroup = group.category.startsWith('💾');
            group.names.forEach(name => {
                const rawStyle = presetsMap[name] || {};
                const merged = window.ReelsStyleEngine.mergeStyle(rawStyle);
                const code = typeof window.getSubtitlePresetCode === 'function' ? window.getSubtitlePresetCode(name) : '';
                const feat = getEffectFeatureTags(merged);
                const animated = (merged.anim_in_type && merged.anim_in_type !== 'none')
                    || merged.box_wipe_enabled || merged.dynamic_box || merged.karaoke_highlight || merged.highlight_enabled;
                items.push({
                    index: items.length,
                    name,
                    code,
                    category: group.category,
                    isCustom: isCustomGroup,
                    isNewViral: NEW_VIRAL_CODES.has(code),
                    isOnlineImported: group.category.includes('🌐') || name.startsWith('🌐') || name.startsWith('🎭') || name.startsWith('📰 社区_'),
                    style: merged,
                    animated: Boolean(animated),
                    featureKeys: feat.keys,
                    tags: feat.tags,
                    searchBlob: `${code} ${name} ${merged.font_family || ''} ${merged.anim_in_type || ''} ${group.category} ${feat.tags.join(' ')}`.toLowerCase(),
                });
            });
        });

        const modal = document.createElement('div');
        modal.className = 'reels-subtitle-preset-library';

        const countAll = items.length;
        const countNew = items.filter(it => it.isNewViral).length;
        const countFav = items.filter(it => favorites.has(it.name)).length;
        const countOnline = items.filter(it => it.isOnlineImported).length;

        const categoryButtonsHtml = categorized.map(g =>
            `<button type="button" class="rsp-nav-btn" data-group="${_esc(g.category)}"><span>${_esc(g.category)}</span><small>${g.names.length}</small></button>`
        ).join('');

        const cardsHtml = items.map(it => {
            const codeBadge = it.code ? `<span class="rsp-code-badge">${_esc(it.code)}</span>` : '';
            const isFav = favorites.has(it.name);
            const tagHtml = it.tags.slice(0, 2).map(t => `<span class="rsp-tag">${_esc(t)}</span>`).join('');
            return `<article class="rsp-card${it.name === initialCurrentName ? ' is-selected' : ''}" data-index="${it.index}" data-name="${_esc(it.name)}" data-group="${_esc(it.category)}" data-animated="${it.animated ? 'true' : 'false'}">
                <div class="rsp-card-media">
                    <canvas class="rsp-preview-canvas" width="270" height="480" data-index="${it.index}" aria-label="${_esc(it.name)}"></canvas>
                    <button type="button" class="rsp-fav-btn${isFav ? ' is-fav' : ''}" title="收藏 / 取消收藏">${isFav ? '★' : '☆'}</button>
                    ${it.animated ? '<span class="rsp-motion-pill">▶ 动效</span>' : ''}
                </div>
                <div class="rsp-name" title="${_esc(it.name)}">${codeBadge}${_esc(it.name)}</div>
                <div class="rsp-tags-row">${tagHtml}<span class="rsp-font-chip">${_esc(it.style.font_family || 'Arimo')}</span></div>
                <div class="rsp-card-actions">
                    <button type="button" class="rsp-use">选用</button>
                    ${it.isCustom ? '<button type="button" class="rsp-move-group">分组</button><button type="button" class="rsp-delete">删除</button>' : ''}
                </div>
            </article>`;
        }).join('');

        modal.innerHTML = `<div class="rsp-shell">
            <header>
                <div class="rsp-header-title">
                    <h2>🎬 字幕效果独立预览窗</h2>
                    <span class="rsp-total-badge">共 ${countAll} 款 · sub-01 ~ sub-227</span>
                </div>
                <div class="rsp-header-controls">
                    <input type="text" class="rsp-search-input" placeholder="🔍 搜索编号 / 名称 / 字体 (如 sub-128 / Hormozi / 3D / 霓虹)...">
                    <button type="button" class="rsp-action-btn rsp-toggle-online" title="联网读取免费字幕包、网络爆款模板、导入 .ASS / JSON 效果">🌐 读取免费 / 网络爆款</button>
                    <button type="button" class="rsp-action-btn rsp-quick-import-file" title="直接选择本地 .json 或 .ass / .ssa 免费特效文件">📥 导入 .JSON / .ASS</button>
                    <button type="button" class="rsp-clear-mine" ${myPresetNames.length ? '' : 'disabled'} title="只删除“我的预设”分组">清空自存</button>
                    <button type="button" class="rsp-close" title="关闭 (ESC)">✕</button>
                </div>
            </header>
            <div class="rsp-online-drawer" hidden></div>
            <div class="rsp-main">
                <aside>
                    <div class="rsp-aside-label">⚡ 快速筛选</div>
                    <button type="button" class="rsp-nav-btn active" data-group="all"><span>全部字幕效果</span><small>${countAll}</small></button>
                    <button type="button" class="rsp-nav-btn" data-group="__new_viral__"><span>✨ 2026新增100款爆款</span><small>${countNew}</small></button>
                    <button type="button" class="rsp-nav-btn" data-group="__favorites__"><span>⭐ 我的收藏</span><small class="rsp-fav-count">${countFav}</small></button>
                    <button type="button" class="rsp-nav-btn" data-group="__online_imported__"><span>🌐 网络/ASS导入效果</span><small>${countOnline}</small></button>
                    <div class="rsp-aside-label">🎛️ 特效类型</div>
                    <div class="rsp-feature-chips">
                        <button type="button" class="rsp-chip" data-feat="word_pop">🔥 逐词焦点</button>
                        <button type="button" class="rsp-chip" data-feat="glow">✨ 辉光霓虹</button>
                        <button type="button" class="rsp-chip" data-feat="rolling">🎤 多行滚词</button>
                        <button type="button" class="rsp-chip" data-feat="cutout">✂️ 剪报笔刷</button>
                        <button type="button" class="rsp-chip" data-feat="3d">🧊 3D立体</button>
                        <button type="button" class="rsp-chip" data-feat="laser_type">⌨️ 打字激光</button>
                        <button type="button" class="rsp-chip" data-feat="gradient">🎨 渐变色</button>
                        <button type="button" class="rsp-chip" data-feat="box">🎯 底框</button>
                    </div>
                    <div class="rsp-aside-label">📂 全部分类</div>
                    ${categoryButtonsHtml}
                </aside>
                <section class="rsp-grid-pane">
                    <div class="rsp-filter-status"></div>
                    <div class="rsp-grid">${cardsHtml || '<p>暂无预设</p>'}</div>
                </section>
                <aside class="rsp-stage" aria-label="右侧高清实时效果预览台">
                    <div class="rsp-stage-header">
                        <div class="rsp-stage-title-wrap">
                            <span class="rsp-stage-code"></span>
                            <h3 class="rsp-stage-name">点击左侧任意效果即时预览</h3>
                        </div>
                        <button type="button" class="rsp-stage-fav" title="收藏当前效果">☆</button>
                    </div>
                    <div class="rsp-stage-viewport">
                        <canvas class="rsp-stage-canvas" width="360" height="640"></canvas>
                        <button type="button" class="rsp-compare-btn" title="按住临时显示当前视频原样式进行对比">👁️ 按住对比当前</button>
                    </div>
                    <div class="rsp-stage-transport">
                        <button type="button" class="rsp-play-toggle">⏸ 暂停</button>
                        <input type="range" class="rsp-scrub" min="0" max="9" step="0.05" value="1.4">
                        <span class="rsp-time-readout">1.4s</span>
                        <select class="rsp-speed-select" title="播放倍速">
                            <option value="0.5">0.5x</option>
                            <option value="1" selected>1.0x</option>
                            <option value="1.5">1.5x</option>
                        </select>
                    </div>
                    <div class="rsp-stage-scenes">
                        <span>背景场景:</span>
                        <button type="button" class="rsp-scene-btn active" data-scene="dark">🌑 暗夜</button>
                        <button type="button" class="rsp-scene-btn" data-scene="warm">🌅 暖色</button>
                        <button type="button" class="rsp-scene-btn" data-scene="daylight">☀️ 白底</button>
                        <button type="button" class="rsp-scene-btn" data-scene="cyber">🌆 霓虹</button>
                        <button type="button" class="rsp-scene-btn" data-scene="video">🖼️ 画面</button>
                    </div>
                    <div class="rsp-stage-script">
                        <input type="text" class="rsp-custom-text" placeholder="输入自定义测试台词 (实时预览)..." value="">
                        <div class="rsp-script-pills">
                            <button type="button" data-script="bilingual" class="active">中英双语</button>
                            <button type="button" data-script="en_viral">英文爆款</button>
                            <button type="button" data-script="zh_hook">中文金句</button>
                            <button type="button" data-script="faith">信仰金句</button>
                        </div>
                    </div>
                    <div class="rsp-stage-specs"></div>
                    <div class="rsp-stage-cta">
                        <button type="button" class="rsp-stage-apply">✅ 立即应用此效果</button>
                        <button type="button" class="rsp-stage-save-copy" title="另存到我的预设并自定义分组">💾 另存</button>
                    </div>
                </aside>
            </div>
        </div>`;

        document.body.appendChild(modal);

        // ── Runtime State & Renderers ──
        let selectedItem = items.find(it => it.name === initialCurrentName) || items.find(it => it.code === 'sub-128') || items[0] || null;
        let previewOverrideItem = null; // Allows live previewing un-imported community/ASS items!
        let activeGroup = options.initialGroup || 'all';
        let activeFeature = '';
        let stagePlaying = true;
        let stageTime = 1.4;
        let stageSpeed = 1.0;
        let stageScene = 'dark';
        let stageSegments = QUICK_TEXT_SCRIPTS[1].segments;
        let comparingOriginal = false;
        let lastTick = performance.now();
        let stageRafId = null;
        const activeCardRafs = new Set();
        let disposed = false;

        const stageCanvas = modal.querySelector('.rsp-stage-canvas');
        const stageCtx = stageCanvas.getContext('2d');
        const stageRenderer = window.ReelsCanvasRenderer ? new window.ReelsCanvasRenderer(stageCanvas) : null;
        if (stageRenderer) stageRenderer.setContextSegments(stageSegments);

        const posterImg = (() => {
            try {
                const t = typeof _getSelectedTask === 'function' ? _getSelectedTask() : null;
                if (t?.video && typeof window.reelsGetBackgroundPoster === 'function') {
                    return window.reelsGetBackgroundPoster(t.video);
                }
            } catch (_) {}
            return null;
        })();

        const getStaticPreviewTime = (style, seg) => {
            const isBoxWipe = Boolean(style.box_wipe_enabled || style.anim_in_type === 'box_wipe');
            const isLineFocus = Boolean(style.active_line_focus_enabled || style.anim_in_type === 'line_focus');
            const isUnderline = style.anim_in_type === 'underline_sweep';
            const isStack = ['three_word_focus_stack', 'kinetic_glow_stack', 'rolling_rainbow_karaoke', 'rolling_quill_karaoke'].includes(style.anim_in_type);
            const isFeather = style.anim_in_type === 'feather_wipe' || style.anim_in_type === 'speech_feather_wipe';
            if (isBoxWipe) return seg.start + (seg.end - seg.start) * 0.65;
            if (isLineFocus) return seg.start + (seg.end - seg.start) * 0.35;
            if (isUnderline) return seg.start + 0.24;
            if (isStack) return seg.start + (seg.end - seg.start) * 0.52;
            if (isFeather) return seg.start + (seg.end - seg.start) * 0.72;
            return seg.end - 0.05;
        };

        const buildStaticCardStyle = (style) => {
            const isBoxWipe = Boolean(style.box_wipe_enabled || style.anim_in_type === 'box_wipe');
            const isLineFocus = Boolean(style.active_line_focus_enabled || style.anim_in_type === 'line_focus');
            const preserve = isBoxWipe || isLineFocus || [
                'underline_sweep', 'three_word_focus_stack', 'kinetic_glow_stack',
                'rolling_rainbow_karaoke', 'rolling_quill_karaoke', 'feather_wipe', 'speech_feather_wipe',
            ].includes(style.anim_in_type);
            return {
                ...style,
                anim_in_type: isBoxWipe ? 'box_wipe' : (isLineFocus ? 'line_focus' : (preserve ? style.anim_in_type : 'none')),
                anim_out_type: 'none',
                dynamic_box: false,
                karaoke_highlight: preserve ? Boolean(style.karaoke_highlight ?? true) : false,
                highlight_enabled: preserve ? Boolean(style.highlight_enabled ?? true) : style.highlight_enabled,
                word_pop: false,
                fullpage_typewriter: false,
            };
        };

        const cardRenderers = new WeakMap();
        const renderCardCanvas = (canvas, timeOverride = null, animated = false) => {
            if (!window.ReelsCanvasRenderer) return;
            const item = items[Number(canvas.dataset.index)];
            if (!item) return;
            let entry = cardRenderers.get(canvas);
            if (!entry) {
                const renderer = new window.ReelsCanvasRenderer(canvas);
                renderer.setContextSegments(stageSegments);
                entry = { renderer, ctx: canvas.getContext('2d') };
                cardRenderers.set(canvas, entry);
            }
            const { renderer, ctx } = entry;
            renderer.setContextSegments(stageSegments);
            const firstSeg = stageSegments[0];
            const t = timeOverride !== null ? timeOverride : getStaticPreviewTime(item.style, firstSeg);
            const activeSeg = animated
                ? (stageSegments.find(seg => t >= seg.start && t <= seg.end) || firstSeg)
                : firstSeg;
            ctx.save();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#11111f';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.restore();
            ctx.save();
            ctx.scale(canvas.width / 1080, canvas.height / 1920);
            renderer.renderSubtitle(animated ? item.style : buildStaticCardStyle(item.style), activeSeg, t, 1080, 1920);
            ctx.restore();
            canvas.dataset.rendered = '1';
        };

        // ── Lazy Card Thumbnail Queue via IntersectionObserver (fast startup for 260+ presets) ──
        const lazyQueue = [];
        let lazyScheduled = false;
        const pumpLazyQueue = () => {
            lazyScheduled = false;
            if (disposed || !modal.isConnected) return;
            const batch = lazyQueue.splice(0, 4);
            for (const canvas of batch) {
                if (canvas.isConnected && canvas.closest('.rsp-card')?.style.display !== 'none') {
                    renderCardCanvas(canvas, null, false);
                }
            }
            if (lazyQueue.length > 0 && !lazyScheduled) {
                lazyScheduled = true;
                requestAnimationFrame(pumpLazyQueue);
            }
        };
        const thumbObserver = new IntersectionObserver(entries => {
            for (const ent of entries) {
                if (!ent.isIntersecting) continue;
                const canvas = ent.target;
                if (canvas.dataset.rendered !== '1') {
                    lazyQueue.push(canvas);
                    if (!lazyScheduled) {
                        lazyScheduled = true;
                        requestAnimationFrame(pumpLazyQueue);
                    }
                }
            }
        }, { root: modal.querySelector('.rsp-grid-pane'), rootMargin: '220px' });

        modal.querySelectorAll('.rsp-preview-canvas').forEach(canvas => {
            canvas._subtitlePresetDraw = () => renderCardCanvas(canvas, null, false);
            thumbObserver.observe(canvas);
            const card = canvas.closest('.rsp-card');
            let hoverRaf = null;
            card.addEventListener('mouseenter', () => {
                if (hoverRaf !== null) return;
                const startedAt = performance.now();
                const tick = (now) => {
                    activeCardRafs.delete(hoverRaf);
                    if (disposed || !card.isConnected || !card.getClientRects().length) { hoverRaf = null; return; }
                    const sec = ((now - startedAt) / 1000) % 9;
                    renderCardCanvas(canvas, sec, true);
                    hoverRaf = requestAnimationFrame(tick);
                    activeCardRafs.add(hoverRaf);
                };
                hoverRaf = requestAnimationFrame(tick);
                activeCardRafs.add(hoverRaf);
            });
            card.addEventListener('mouseleave', () => {
                if (hoverRaf !== null) cancelAnimationFrame(hoverRaf);
                activeCardRafs.delete(hoverRaf);
                hoverRaf = null;
                renderCardCanvas(canvas, null, false);
            });
        });

        window.reelsObservePresetFonts?.(
            modal,
            '.rsp-preview-canvas',
            canvas => items[Number(canvas.dataset.index)]?.style?.font_family,
            canvas => {
                canvas.dataset.rendered = '0';
                renderCardCanvas(canvas, null, false);
            }
        );

        // ── Stage Live Loop & Inspector Sync ──
        const syncStageHeaderAndSpecs = () => {
            const active = previewOverrideItem || selectedItem;
            if (!active) return;
            const st = active.style || {};
            const codeEl = modal.querySelector('.rsp-stage-code');
            const nameEl = modal.querySelector('.rsp-stage-name');
            const favBtn = modal.querySelector('.rsp-stage-fav');
            const applyBtn = modal.querySelector('.rsp-stage-apply');
            const specsEl = modal.querySelector('.rsp-stage-specs');

            if (codeEl) codeEl.textContent = active.code || (previewOverrideItem ? '试看未导入' : '自定义');
            if (nameEl) nameEl.textContent = active.name;
            if (favBtn) {
                const isFav = favorites.has(active.name);
                favBtn.textContent = isFav ? '★' : '☆';
                favBtn.classList.toggle('is-fav', isFav);
                favBtn.style.display = previewOverrideItem ? 'none' : '';
            }
            if (applyBtn) {
                applyBtn.textContent = previewOverrideItem ? '📥 导入并应用此免费效果' : '✅ 立即应用此效果';
            }
            if (specsEl) {
                const specPairs = [
                    ['字体', st.font_family || 'Arimo'],
                    ['字号', `${st.fontsize || 74}px`],
                    ['动效', st.anim_in_type || 'none'],
                    ['排版', st.mixed_layout && st.mixed_layout !== 'none' ? st.mixed_layout : `posY ${Math.round((st.pos_y ?? 0.5) * 100)}%`],
                ];
                specsEl.innerHTML = specPairs.map(([k, v]) =>
                    `<div class="rsp-spec-pill"><span>${_esc(k)}</span><strong>${_esc(v)}</strong></div>`
                ).join('');
            }
            // Ensure active font loads immediately for HD stage
            if (st.font_family && typeof window.getFontManager === 'function') {
                window.getFontManager().ensureFontsLoaded([st.font_family]).catch(() => {});
            }
        };

        const renderStageFrame = () => {
            if (!stageRenderer || !stageCtx) return;
            const active = comparingOriginal
                ? { name: '当前原样式', style: currentAppliedStyle }
                : (previewOverrideItem || selectedItem);
            if (!active) return;
            _drawBackdrop(stageCtx, stageCanvas.width, stageCanvas.height, stageScene, posterImg);
            const seg = stageSegments.find(s => stageTime >= s.start && stageTime <= s.end) || stageSegments[0];
            stageCtx.save();
            stageCtx.scale(stageCanvas.width / 1080, stageCanvas.height / 1920);
            stageRenderer.renderSubtitle(active.style, seg, stageTime, 1080, 1920);
            stageCtx.restore();
            const scrub = modal.querySelector('.rsp-scrub');
            const readout = modal.querySelector('.rsp-time-readout');
            if (scrub && Number(scrub.value) !== Number(stageTime.toFixed(2))) scrub.value = stageTime.toFixed(2);
            if (readout) readout.textContent = `${stageTime.toFixed(1)}s`;
        };

        const runStageLoop = (now) => {
            if (disposed || !modal.isConnected) return;
            const dt = Math.min(0.1, (now - lastTick) / 1000);
            lastTick = now;
            if (stagePlaying) {
                stageTime = (stageTime + dt * stageSpeed) % 9.0;
            }
            renderStageFrame();
            stageRafId = requestAnimationFrame(runStageLoop);
        };
        syncStageHeaderAndSpecs();
        stageRafId = requestAnimationFrame(runStageLoop);

        // ── Apply Action Helper ──
        const applyPresetName = (selectedVal, customStyleObj = null) => {
            if (customStyleObj && selectedVal && window.ReelsStyleEngine.saveNamedSubtitlePreset) {
                window.ReelsStyleEngine.saveNamedSubtitlePreset(selectedVal, customStyleObj, '🌐 网络爆款导入');
            }
            if (typeof options.onSelect === 'function') {
                options.onSelect(selectedVal || '');
                closeModal();
                return;
            }
            if (hiddenInput) {
                hiddenInput.value = selectedVal || '';
                const scope = typeof _getSubtitleStyleScope === 'function' ? _getSubtitleStyleScope() : 'task';
                const targets = scope === 'all'
                    ? (_reelsState.tasks || [])
                    : (scope === 'folder' && typeof _getCurrentReelsGroupTasks === 'function'
                        ? _getCurrentReelsGroupTasks()
                        : [typeof _getSelectedTask === 'function' ? _getSelectedTask() : null].filter(Boolean));
                targets.forEach(t => { t._subtitlePreset = ''; });
                if (typeof reelsLoadPresetQuick === 'function') reelsLoadPresetQuick();
                else if (typeof reelsLoadPreset === 'function') reelsLoadPreset();
            }
            const span = document.querySelector('#reels-preset-select-trigger span');
            if (span) {
                const disp = (selectedVal && typeof window.formatSubtitlePresetDisplayName === 'function')
                    ? window.formatSubtitlePresetDisplayName(selectedVal)
                    : selectedVal;
                span.textContent = disp || '-- 改全部样式 --';
            }
            closeModal();
        };

        const closeModal = () => {
            disposed = true;
            if (stageRafId !== null) cancelAnimationFrame(stageRafId);
            activeCardRafs.forEach(id => cancelAnimationFrame(id));
            activeCardRafs.clear();
            thumbObserver.disconnect();
            document.removeEventListener('keydown', onKeyDown);
            modal.remove();
        };

        const onKeyDown = (ev) => {
            if (ev.key === 'Escape') closeModal();
        };
        document.addEventListener('keydown', onKeyDown);

        // ── Filtering Logic ──
        const applyFilters = () => {
            const q = (modal.querySelector('.rsp-search-input')?.value || '').trim().toLowerCase();
            let shown = 0;
            modal.querySelectorAll('.rsp-card').forEach(card => {
                const it = items[Number(card.dataset.index)];
                if (!it) return;
                let matchGroup = true;
                if (activeGroup === '__favorites__') matchGroup = favorites.has(it.name);
                else if (activeGroup === '__new_viral__') matchGroup = it.isNewViral;
                else if (activeGroup === '__online_imported__') matchGroup = it.isOnlineImported;
                else if (activeGroup !== 'all') matchGroup = it.category === activeGroup;

                const matchFeat = !activeFeature || it.featureKeys.has(activeFeature);
                const matchQuery = !q || it.searchBlob.includes(q);
                const visible = matchGroup && matchFeat && matchQuery;
                card.style.display = visible ? '' : 'none';
                if (visible) shown++;
            });
            const statusEl = modal.querySelector('.rsp-filter-status');
            if (statusEl) {
                statusEl.textContent = `当前显示 ${shown} / ${items.length} 款 · 点击卡片看右侧大屏动态，双击直接选用`;
            }
        };
        const activeNavBtn = Array.from(modal.querySelectorAll('aside .rsp-nav-btn')).find(b => b.dataset.group === activeGroup);
        if (activeNavBtn) {
            modal.querySelectorAll('aside .rsp-nav-btn').forEach(b => b.classList.remove('active'));
            activeNavBtn.classList.add('active');
        }
        applyFilters();

        // ── Wire Card & Sidebar Events ──
        modal.querySelectorAll('aside .rsp-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.querySelectorAll('aside .rsp-nav-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                activeGroup = btn.dataset.group || 'all';
                const activeNavBtn = Array.from(modal.querySelectorAll('aside .rsp-nav-btn')).find(b => b.dataset.group === activeGroup);
        if (activeNavBtn) {
            modal.querySelectorAll('aside .rsp-nav-btn').forEach(b => b.classList.remove('active'));
            activeNavBtn.classList.add('active');
        }
        applyFilters();
            });
        });

        modal.querySelectorAll('.rsp-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const feat = chip.dataset.feat || '';
                const wasActive = chip.classList.contains('active');
                modal.querySelectorAll('.rsp-chip').forEach(c => c.classList.remove('active'));
                if (!wasActive) {
                    chip.classList.add('active');
                    activeFeature = feat;
                } else {
                    activeFeature = '';
                }
                const activeNavBtn = Array.from(modal.querySelectorAll('aside .rsp-nav-btn')).find(b => b.dataset.group === activeGroup);
        if (activeNavBtn) {
            modal.querySelectorAll('aside .rsp-nav-btn').forEach(b => b.classList.remove('active'));
            activeNavBtn.classList.add('active');
        }
        applyFilters();
            });
        });

        const searchInput = modal.querySelector('.rsp-search-input');
        if (searchInput) searchInput.addEventListener('input', applyFilters);

        const toggleFavorite = (name) => {
            if (!name) return;
            if (favorites.has(name)) favorites.delete(name);
            else favorites.add(name);
            _saveFavorites(favorites);
            modal.querySelectorAll('.rsp-fav-count').forEach(el => { el.textContent = favorites.size; });
            modal.querySelectorAll('.rsp-card').forEach(card => {
                if (card.dataset.name === name) {
                    const btn = card.querySelector('.rsp-fav-btn');
                    if (btn) {
                        const isFav = favorites.has(name);
                        btn.textContent = isFav ? '★' : '☆';
                        btn.classList.toggle('is-fav', isFav);
                    }
                }
            });
            syncStageHeaderAndSpecs();
            if (activeGroup === '__favorites__') applyFilters();
        };

        modal.querySelector('.rsp-grid')?.addEventListener('click', (ev) => {
            const favBtn = ev.target.closest('.rsp-fav-btn');
            if (favBtn) {
                ev.stopPropagation();
                const card = favBtn.closest('.rsp-card');
                toggleFavorite(card?.dataset.name);
                return;
            }
            const useBtn = ev.target.closest('.rsp-use');
            if (useBtn) {
                ev.stopPropagation();
                applyPresetName(useBtn.closest('.rsp-card')?.dataset.name);
                return;
            }
            const delBtn = ev.target.closest('.rsp-delete');
            if (delBtn) {
                ev.stopPropagation();
                const card = delBtn.closest('.rsp-card');
                const name = card?.dataset.name;
                if (name && confirm(`删除动态字幕预设「${name}」？`)) {
                    window.ReelsStyleEngine.deleteSubtitlePreset(name);
                    card.remove();
                    if (typeof _reelsRefreshPresetList === 'function') _reelsRefreshPresetList();
                }
                return;
            }
            const moveBtn = ev.target.closest('.rsp-move-group');
            if (moveBtn) {
                ev.stopPropagation();
                const card = moveBtn.closest('.rsp-card');
                const currentGroup = String(card.dataset.group || '').replace(/^💾\s*/, '') || '我的预设';
                const savedGroups = categorized.filter(g => g.category.startsWith('💾')).map(g => g.category.replace(/^💾\s*/, ''));
                Promise.resolve(typeof reelsChoosePresetGroup === 'function' ? reelsChoosePresetGroup('移动预设分组', currentGroup, savedGroups) : prompt('输入目标分组名', currentGroup))
                    .then(nextGroup => {
                        if (!nextGroup || !String(nextGroup).trim()) return;
                        window.ReelsStyleEngine.setSubtitlePresetGroup(card.dataset.name, String(nextGroup).trim());
                        closeModal();
                        reelsOpenSubtitlePresetLibrary(options);
                    });
                return;
            }
            const card = ev.target.closest('.rsp-card');
            if (card) {
                previewOverrideItem = null;
                selectedItem = items[Number(card.dataset.index)] || selectedItem;
                modal.querySelectorAll('.rsp-card').forEach(c => c.classList.remove('is-selected'));
                card.classList.add('is-selected');
                stageTime = 0.05;
                stagePlaying = true;
                modal.querySelector('.rsp-play-toggle').textContent = '⏸ 暂停';
                syncStageHeaderAndSpecs();
            }
        });

        modal.querySelector('.rsp-grid')?.addEventListener('dblclick', (ev) => {
            const card = ev.target.closest('.rsp-card');
            if (card) applyPresetName(card.dataset.name);
        });

        // ── Wire Right Stage Controls ──
        modal.querySelector('.rsp-play-toggle').addEventListener('click', (ev) => {
            stagePlaying = !stagePlaying;
            ev.currentTarget.textContent = stagePlaying ? '⏸ 暂停' : '▶ 播放';
        });
        modal.querySelector('.rsp-scrub').addEventListener('input', (ev) => {
            stageTime = Math.max(0, Math.min(8.99, parseFloat(ev.currentTarget.value) || 0));
            renderStageFrame();
        });
        modal.querySelector('.rsp-speed-select').addEventListener('change', (ev) => {
            stageSpeed = parseFloat(ev.currentTarget.value) || 1.0;
        });
        modal.querySelectorAll('.rsp-scene-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.querySelectorAll('.rsp-scene-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                stageScene = btn.dataset.scene || 'dark';
                renderStageFrame();
            });
        });
        modal.querySelectorAll('.rsp-script-pills button').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.querySelectorAll('.rsp-script-pills button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const found = QUICK_TEXT_SCRIPTS.find(s => s.id === btn.dataset.script);
                if (found) {
                    stageSegments = found.segments;
                    if (stageRenderer) stageRenderer.setContextSegments(stageSegments);
                    modal.querySelector('.rsp-custom-text').value = '';
                    stageTime = 0.05;
                    modal.querySelectorAll('.rsp-preview-canvas[data-rendered="1"]').forEach(c => renderCardCanvas(c, null, false));
                }
            });
        });
        modal.querySelector('.rsp-custom-text').addEventListener('input', (ev) => {
            stageSegments = _buildDynamicPreviewSegments(ev.currentTarget.value);
            if (stageRenderer) stageRenderer.setContextSegments(stageSegments);
            stageTime = 0.05;
        });
        const compareBtn = modal.querySelector('.rsp-compare-btn');
        if (compareBtn) {
            const setComp = (val) => { comparingOriginal = val; renderStageFrame(); };
            compareBtn.addEventListener('mousedown', () => setComp(true));
            compareBtn.addEventListener('mouseup', () => setComp(false));
            compareBtn.addEventListener('mouseleave', () => setComp(false));
            compareBtn.addEventListener('touchstart', () => setComp(true), { passive: true });
            compareBtn.addEventListener('touchend', () => setComp(false));
        }
        modal.querySelector('.rsp-stage-fav').addEventListener('click', () => {
            if (selectedItem && !previewOverrideItem) toggleFavorite(selectedItem.name);
        });
        modal.querySelector('.rsp-stage-apply').addEventListener('click', () => {
            if (previewOverrideItem) {
                applyPresetName(previewOverrideItem.name, previewOverrideItem.style);
            } else if (selectedItem) {
                applyPresetName(selectedItem.name);
            }
        });
        modal.querySelector('.rsp-stage-save-copy').addEventListener('click', () => {
            const active = previewOverrideItem || selectedItem;
            if (!active) return;
            const nextName = prompt('另存为我的字幕预设名称：', `${active.name}_副本`);
            if (!nextName || !nextName.trim()) return;
            if (window.ReelsStyleEngine.saveNamedSubtitlePreset(nextName.trim(), active.style, '我的预设')) {
                if (typeof showToast === 'function') showToast(`✅ 已保存为「${nextName.trim()}」`, 'success');
                closeModal();
                reelsOpenSubtitlePresetLibrary(options);
            } else {
                alert(window.ReelsStyleEngine.getLastPresetSaveError?.() || '保存失败');
            }
        });

        // ── Online / Free / ASS Drawer ──
        const drawer = modal.querySelector('.rsp-online-drawer');
        let communityState = _loadCommunityPacks();

        const importParsedPresets = (presetsObj, groupName = '🌐 网络爆款导入') => {
            const existing = window.ReelsStyleEngine.loadSubtitlePresets().presets || {};
            const sanitized = {};
            for (const [k, v] of Object.entries(presetsObj || {})) {
                sanitized[k] = _sanitizeStyleObject(v);
            }
            const payloadStr = JSON.stringify({ presets: sanitized });
            const res = window.ReelsStyleEngine.importSubtitlePresets(payloadStr, false, groupName);
            const addedCount = res.added?.length || 0;
            const dupCount = (res.duplicates?.length || 0) + (res.skipped?.length || 0);
            if (typeof _reelsRefreshPresetList === 'function') _reelsRefreshPresetList();
            if (typeof showToast === 'function') {
                showToast(`✅ 成功导入 ${addedCount} 个效果（归入「${groupName}」${dupCount ? `，跳过重复 ${dupCount} 个` : ''}）`, 'success', 4500);
            }
            if (addedCount > 0 || Object.keys(existing).length) {
                closeModal();
                reelsOpenSubtitlePresetLibrary({ ...options, initialGroup: `💾 ${groupName}` });
            }
        };

        const renderOnlineDrawer = (urlResult = null, statusNote = '') => {
            const packCards = communityState.packs.map((pack, pIdx) => {
                const entries = Object.entries(pack.presets || {});
                const chips = entries.map(([name, st]) =>
                    `<div class="rsp-pack-item">
                        <span title="${_esc(name)}">${_esc(name)}</span>
                        <div style="display:flex;gap:4px;">
                            <button type="button" class="rsp-mini-btn rsp-preview-community" data-pack="${pIdx}" data-preset="${_esc(name)}">👁️ 试看</button>
                            <button type="button" class="rsp-mini-btn rsp-add-single" data-pack="${pIdx}" data-preset="${_esc(name)}">+ 导入</button>
                        </div>
                    </div>`
                ).join('');
                return `<div class="rsp-pack-card">
                    <div class="rsp-pack-head">
                        <div>
                            <strong>${_esc(pack.name)}</strong>
                            <p>${_esc(pack.description || `包含 ${entries.length} 款可免费导入效果`)}</p>
                        </div>
                        <button type="button" class="rsp-action-btn rsp-import-whole-pack" data-pack="${pIdx}">📥 导入整包 (${entries.length})</button>
                    </div>
                    <div class="rsp-pack-items">${chips}</div>
                </div>`;
            }).join('');

            const urlPreviewHtml = urlResult ? (() => {
                const entries = Object.entries(urlResult.presets || {});
                return `<div class="rsp-pack-card" style="border-color:#38bdf8;">
                    <div class="rsp-pack-head">
                        <div><strong>🔍 解析到 ${entries.length} 个免费样式 (${_esc(urlResult.format)})</strong></div>
                        <button type="button" class="rsp-action-btn rsp-import-parsed-url">📥 全部导入</button>
                    </div>
                    <div class="rsp-pack-items">${entries.map(([name]) =>
                        `<div class="rsp-pack-item"><span>${_esc(name)}</span><button type="button" class="rsp-mini-btn rsp-preview-url-item" data-preset="${_esc(name)}">👁️ 试看</button></div>`
                    ).join('')}</div>
                </div>`;
            })() : '';

            drawer.innerHTML = `<div class="rsp-drawer-inner">
                <div class="rsp-drawer-top">
                    <div>
                        <strong>🌐 读取免费效果 & 网络爆款中心</strong>
                        <span class="rsp-drawer-note">${_esc(statusNote || '支持一键联网同步社区爆款包、读取开源 .ASS 特效字幕文件或 HTTPS 链接')}</span>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;">
                        <button type="button" class="rsp-action-btn rsp-sync-feed-btn">🔄 联网刷新爆款包</button>
                        <button type="button" class="rsp-action-btn rsp-drawer-close">收起 ▲</button>
                    </div>
                </div>
                <div class="rsp-url-row">
                    <input type="url" class="rsp-url-input" placeholder="粘贴公开 HTTPS 字幕包/ASS 样式链接 (如 https://raw.githubusercontent.com/.../*.ass 或 *.json)">
                    <button type="button" class="rsp-action-btn rsp-fetch-url-btn">🌐 联网读取并试看</button>
                    <button type="button" class="rsp-action-btn rsp-paste-ass-toggle">📋 粘贴 ASS / JSON 文本</button>
                </div>
                <div class="rsp-paste-box" hidden>
                    <textarea class="rsp-paste-textarea" rows="4" placeholder="粘贴开源 Aegisub .ASS [V4+ Styles] 内容或 JSON 预设包..."></textarea>
                    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px;">
                        <button type="button" class="rsp-action-btn rsp-parse-paste-btn">✨ 解析并试看效果</button>
                    </div>
                </div>
                ${urlPreviewHtml}
                <div class="rsp-packs-grid">${packCards}</div>
            </div>`;

            drawer.querySelector('.rsp-drawer-close').onclick = () => { drawer.hidden = true; };
            drawer.querySelector('.rsp-sync-feed-btn').onclick = async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                btn.textContent = '⏳ 正在联网同步...';
                try {
                    const remote = await fetchRemotePresetSource(DEFAULT_COMMUNITY_FEED_URL);
                    if (remote.packs.length > 0) {
                        communityState = { packs: remote.packs, syncedAt: Date.now(), source: 'remote' };
                        _saveCommunityPacks(remote.packs);
                        renderOnlineDrawer(urlResult, `✅ 已联网更新 ${Object.keys(remote.presets).length} 款社区最新爆款`);
                    } else {
                        renderOnlineDrawer(urlResult, 'ℹ️ 已是内置最新社区爆款列表');
                    }
                } catch (err) {
                    renderOnlineDrawer(urlResult, `⚠️ 远程同步暂不可达 (${err.message})，已展示本地免费爆款包`);
                }
            };
            drawer.querySelector('.rsp-paste-ass-toggle').onclick = () => {
                const box = drawer.querySelector('.rsp-paste-box');
                box.hidden = !box.hidden;
            };
            drawer.querySelector('.rsp-parse-paste-btn').onclick = () => {
                try {
                    const txt = drawer.querySelector('.rsp-paste-textarea').value;
                    const parsed = parsePresetBundlePayload(txt, '文本导入');
                    if (Object.keys(parsed.presets).length === 0) {
                        alert('未识别到有效的字幕样式 (.ASS Style 行或 JSON)');
                        return;
                    }
                    renderOnlineDrawer(parsed, `✅ 成功解析 ${Object.keys(parsed.presets).length} 个免费样式`);
                } catch (err) {
                    alert(`解析失败：${err.message}`);
                }
            };
            drawer.querySelector('.rsp-fetch-url-btn').onclick = async (ev) => {
                const url = drawer.querySelector('.rsp-url-input').value.trim();
                const btn = ev.currentTarget;
                btn.disabled = true;
                btn.textContent = '⏳ 读取中...';
                try {
                    const parsed = await fetchRemotePresetSource(url);
                    if (Object.keys(parsed.presets).length === 0) throw new Error('链接中未发现有效样式');
                    renderOnlineDrawer(parsed, `✅ 在线解析成功 (${Object.keys(parsed.presets).length} 个效果)，可先试看或导入`);
                } catch (err) {
                    renderOnlineDrawer(null, `❌ 读取失败: ${err.message}`);
                }
            };
            drawer.querySelectorAll('.rsp-preview-community').forEach(btn => {
                btn.onclick = () => {
                    const pack = communityState.packs[Number(btn.dataset.pack)];
                    const name = btn.dataset.preset;
                    if (!pack?.presets?.[name]) return;
                    previewOverrideItem = {
                        name,
                        code: '在线试看',
                        style: window.ReelsStyleEngine.mergeStyle(pack.presets[name]),
                    };
                    stageTime = 0.05;
                    stagePlaying = true;
                    syncStageHeaderAndSpecs();
                };
            });
            drawer.querySelectorAll('.rsp-add-single').forEach(btn => {
                btn.onclick = () => {
                    const pack = communityState.packs[Number(btn.dataset.pack)];
                    const name = btn.dataset.preset;
                    if (!pack?.presets?.[name]) return;
                    importParsedPresets({ [name]: pack.presets[name] }, pack.group || '🌐 网络爆款导入');
                };
            });
            drawer.querySelectorAll('.rsp-import-whole-pack').forEach(btn => {
                btn.onclick = () => {
                    const pack = communityState.packs[Number(btn.dataset.pack)];
                    if (!pack?.presets) return;
                    importParsedPresets(pack.presets, pack.group || '🌐 网络爆款导入');
                };
            });
            drawer.querySelectorAll('.rsp-preview-url-item').forEach(btn => {
                btn.onclick = () => {
                    const name = btn.dataset.preset;
                    if (!urlResult?.presets?.[name]) return;
                    previewOverrideItem = {
                        name,
                        code: '免费解析试看',
                        style: window.ReelsStyleEngine.mergeStyle(urlResult.presets[name]),
                    };
                    stageTime = 0.05;
                    stagePlaying = true;
                    syncStageHeaderAndSpecs();
                };
            });
            const importUrlAll = drawer.querySelector('.rsp-import-parsed-url');
            if (importUrlAll && urlResult) {
                importUrlAll.onclick = () => importParsedPresets(urlResult.presets, urlResult.packs?.[0]?.group || '🌐 网络爆款导入');
            }
        };

        modal.querySelector('.rsp-toggle-online').addEventListener('click', () => {
            drawer.hidden = !drawer.hidden;
            if (!drawer.hidden) renderOnlineDrawer();
        });

        modal.querySelector('.rsp-quick-import-file').addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,.ass,.ssa';
            input.multiple = true;
            input.onchange = async (ev) => {
                const files = Array.from(ev.target.files || []);
                if (!files.length) return;
                const combined = {};
                let lastGroup = '🎭 免费特效导入';
                for (const file of files) {
                    try {
                        const raw = await file.text();
                        const parsed = parsePresetBundlePayload(raw, file.name.replace(/\.[^.]+$/, ''));
                        Object.assign(combined, parsed.presets || {});
                        if (parsed.format === 'ass') lastGroup = '🎭 ASS特效导入';
                        else if (parsed.packs?.[0]?.group) lastGroup = parsed.packs[0].group;
                    } catch (err) {
                        console.error('[PresetImport] 读取失败:', file.name, err);
                    }
                }
                if (Object.keys(combined).length === 0) {
                    alert('所选文件中未找到可用的字幕样式 (.json / .ass)');
                    return;
                }
                importParsedPresets(combined, lastGroup);
            };
            input.click();
        });

        modal.querySelector('.rsp-close').addEventListener('click', closeModal);
        modal.querySelector('.rsp-clear-mine').addEventListener('click', () => {
            if (!myPresetNames.length) return;
            if (!confirm(`确定清空“我的预设”中的 ${myPresetNames.length} 个预设吗？`)) return;
            myPresetNames.forEach(n => window.ReelsStyleEngine.deleteSubtitlePreset(n));
            if (typeof _reelsRefreshPresetList === 'function') _reelsRefreshPresetList();
            closeModal();
            reelsOpenSubtitlePresetLibrary(options);
        });
    }

    const api = {
        BUILTIN_COMMUNITY_PACKS,
        parseAssColorToHex,
        parseAssStylesToPresets,
        normalizeExternalPresetObject,
        parsePresetBundlePayload,
        getEffectFeatureTags,
        fetchRemotePresetSource,
        reelsOpenSubtitlePresetLibrary,
    };

    if (typeof window !== 'undefined') {
        window.ReelsPresetLibrary = api;
        window.ReelsPresetOnlineLoader = api;
        window.reelsOpenSubtitlePresetLibrary = reelsOpenSubtitlePresetLibrary;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})();
