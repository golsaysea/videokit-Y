/**
 * Reels 開場效果智能配樂 / 音效庫與路徑解析器
 * 統一服務於：預覽 V1 / V2 播放器、開場面闆試聽與上傳、Electron WYSIWYG / CLI / 網頁版混音導出
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ReelsIntroAudio = factory();
    }
}(typeof globalThis !== 'undefined' ? globalThis : window, function () {
    'use strict';

    const INTRO_AUDIO_TRACKS = [
        {
            id: 'curtain_grand_fanfare',
            fileName: 'curtain_grand_fanfare.mp3',
            name: '🎭 剧院丝绒开幕·温暖弦乐号角',
            group: '剧场 / 典礼',
            mood: '大气 · 仪式感',
            durationSec: 3.8,
            defaultVolume: 82,
        },
        {
            id: 'morning_sheer_harp',
            fileName: 'morning_sheer_harp.mp3',
            name: '🌬️ 晨曦微风纱帘·竖琴暖阳',
            group: '温馨 / 治愈',
            mood: '轻柔 · 居家晨光',
            durationSec: 3.8,
            defaultVolume: 88,
        },
        {
            id: 'patriotic_freedom_anthem',
            fileName: 'patriotic_freedom_anthem.mp3',
            name: '🇺🇸 北美礼赞·军鼓铜管荣耀开场',
            group: '爱国 / 国旗',
            mood: '庄严 · 荣耀感',
            durationSec: 3.8,
            defaultVolume: 82,
        },
        {
            id: 'eagle_canyon_drum',
            fileName: 'eagle_canyon_drum.mp3',
            name: '🦅 雄鹰峡谷战鼓·水墨破空声效',
            group: '震撼 / 自然',
            mood: '力量 · 破空冲击',
            durationSec: 3.8,
            defaultVolume: 82,
        },
        {
            id: 'cardinal_woodland_chime',
            fileName: 'cardinal_woodland_chime.mp3',
            name: '🐦 红雀晨林清啼·灵动风铃竖琴',
            group: '灵动 / 红雀',
            mood: '清脆 · 天使信使',
            durationSec: 3.8,
            defaultVolume: 88,
        },
        {
            id: 'parchment_paper_quill',
            fileName: 'parchment_paper_quill.mp3',
            name: '📜 羊皮书页翻响·温柔钢琴轻启',
            group: '极简 / 纸质',
            mood: '雅致 · 翻页质感',
            durationSec: 3.8,
            defaultVolume: 88,
        },
        {
            id: 'dark_cinema_pulse',
            fileName: 'dark_cinema_pulse.mp3',
            name: '🖤 深邃影院重低音·破黑聚光声效',
            group: '电影 / 黑场',
            mood: '深沉 · 高级感',
            durationSec: 3.8,
            defaultVolume: 84,
        },
        {
            id: 'wooden_doors_sanctuary',
            fileName: 'wooden_doors_sanctuary.mp3',
            name: '🚪 木门窗扇开启·圣光暖阳和弦',
            group: '木门 / 百叶窗',
            mood: '温暖 · 迎宾光束',
            durationSec: 3.8,
            defaultVolume: 86,
        },
        {
            id: 'winter_crystal_bells',
            fileName: 'winter_crystal_bells.mp3',
            name: '❄️ 冰雪晶铃融霜·冬日奇幻音效',
            group: '冰雪 / 冬日',
            mood: '晶莹 · 加拿大冬雪',
            durationSec: 3.8,
            defaultVolume: 86,
        },
        {
            id: 'countdown_321_tension',
            fileName: 'countdown_321_tension.mp3',
            name: '⏱️ 电影胶片3·2·1机械读秒脉冲',
            group: '快门 / 读秒',
            mood: '紧迫 · 吸睛停顿',
            durationSec: 3.8,
            defaultVolume: 85,
        },
        {
            id: 'xmas_wonder_glockenspiel',
            fileName: 'xmas_wonder_glockenspiel.mp3',
            name: '🎄 圣诞钟琴奇缘·节日暖心序曲',
            group: '圣诞 / 节日',
            mood: '喜悦 · 温暖铃音',
            durationSec: 3.8,
            defaultVolume: 86,
        },
        {
            id: 'sacred_prayer_organ',
            fileName: 'sacred_prayer_organ.mp3',
            name: '✝️ 教堂圣光管风琴·晨祷阿们颂',
            group: '祷告 / 教堂',
            mood: '神圣 · 庄重平和',
            durationSec: 3.8,
            defaultVolume: 86,
        },
        {
            id: 'holiday_gift_sparkle',
            fileName: 'holiday_gift_sparkle.mp3',
            name: '🎁 礼盒丝带拆封·欢快星芒拨弦',
            group: '礼盒 / 庆祝',
            mood: '惊喜 · 拆封期待',
            durationSec: 3.8,
            defaultVolume: 86,
        },
        {
            id: 'viral_hook_punch',
            fileName: 'viral_hook_punch.mp3',
            name: '⚡ 爆款斜体闪击·重击转场上升',
            group: '爆款 / 节奏',
            mood: '干脆 · 抓耳留存',
            durationSec: 3.8,
            defaultVolume: 80,
        },
        {
            id: 'crt_glitch_powerup',
            fileName: 'crt_glitch_powerup.mp3',
            name: '📼 CRT老电视开机·电流脉冲RGB扫频',
            group: '科技 / 复古',
            mood: '电流 · 赛博开机',
            durationSec: 3.8,
            defaultVolume: 82,
        },
        {
            id: 'film_burn_whoosh',
            fileName: 'film_burn_whoosh.mp3',
            name: '🎞️ 35mm胶片灼烧·暖阳过曝转场音效',
            group: '胶片 / 电影',
            mood: '热烈 · 光影闪烁',
            durationSec: 3.8,
            defaultVolume: 84,
        },
        {
            id: 'polaroid_shutter_snap',
            fileName: 'polaroid_shutter_snap.mp3',
            name: '📸 拍立得快门咔嚓·手账纸张滑出音',
            group: '拍立得 / 手账',
            mood: '清脆 · 怀旧记忆',
            durationSec: 3.8,
            defaultVolume: 86,
        },
        {
            id: 'prism_glass_shimmer',
            fileName: 'prism_glass_shimmer.mp3',
            name: '💎 水晶棱镜折射·空灵现代高频闪烁',
            group: '现代 / 奢华',
            mood: '通透 · 高级质感',
            durationSec: 3.8,
            defaultVolume: 84,
        },
        {
            id: 'cloud_part_heavenly_breeze',
            fileName: 'cloud_part_heavenly_breeze.mp3',
            name: '☁️ 穿云而出·圣洁风声空灵天籁微风',
            group: '云雾 / 天籁',
            mood: '澄澈 · 破云而出',
            durationSec: 3.8,
            defaultVolume: 82,
        },
        {
            id: 'cloud_dawn_angelic_swoosh',
            fileName: 'cloud_dawn_angelic_swoosh.mp3',
            name: '🌅 圣光金云拨雾·晨祷天籁竖琴',
            group: '云雾 / 天籁',
            mood: '温暖 · 晨曦圣光',
            durationSec: 3.8,
            defaultVolume: 82,
        },
        {
            id: 'impact_cinema_boom',
            fileName: 'impact_cinema_boom.mp3',
            name: '💥 电影重低音轰击·史诗震慑开篇',
            group: '💥 冲击重音 / 纯音效开场',
            mood: '震撼 · 低频冲击',
            durationSec: 3.2,
            defaultVolume: 96,
        },
        {
            id: 'impact_riser_slam',
            fileName: 'impact_riser_slam.mp3',
            name: '⚡ 极速蓄力撞击·拉升重锤落地',
            group: '💥 冲击重音 / 纯音效开场',
            mood: '抓耳 · 蓄力重击',
            durationSec: 3.2,
            defaultVolume: 95,
        },
        {
            id: 'impact_whip_whoosh',
            fileName: 'impact_whip_whoosh.mp3',
            name: '💨 利落甩屏飓风·0.7s破空风声',
            group: '💥 冲击重音 / 纯音效开场',
            mood: '干脆 · 甩屏切入',
            durationSec: 3.2,
            defaultVolume: 92,
        },
        {
            id: 'impact_sacred_cathedral_bell',
            fileName: 'impact_sacred_cathedral_bell.mp3',
            name: '🔔 教堂沉钟一响·庄严灵魂震颤',
            group: '💥 冲击重音 / 纯音效开场',
            mood: '神圣 · 祷告敬畏',
            durationSec: 3.2,
            defaultVolume: 92,
        },
        {
            id: 'impact_heartbeat_double',
            fileName: 'impact_heartbeat_double.mp3',
            name: '💓 沉重双心跳声·走心悬念抓人',
            group: '💥 冲击重音 / 纯音效开场',
            mood: '揪心 · 情绪代入',
            durationSec: 3.2,
            defaultVolume: 96,
        },
        {
            id: 'impact_thunder_crack',
            fileName: 'impact_thunder_crack.mp3',
            name: '⛈️ 惊雷震撼劈落·命运转折轰鸣',
            group: '💥 冲击重音 / 纯音效开场',
            mood: '轰鸣 · 强力醒脑',
            durationSec: 3.2,
            defaultVolume: 95,
        },
        {
            id: 'impact_camera_flash_shutter',
            fileName: 'impact_camera_flash_shutter.mp3',
            name: '📸 单反快门定格·瞬间吸睛咔嚓',
            group: '💥 冲击重音 / 纯音效开场',
            mood: '锐利 · 瞬间锁屏',
            durationSec: 3.2,
            defaultVolume: 92,
        },
        {
            id: 'impact_piano_deep_chord',
            fileName: 'impact_piano_deep_chord.mp3',
            name: '🎹 深情钢琴重和弦·故事感共鸣',
            group: '💥 冲击重音 / 纯音效开场',
            mood: '深沉 · 催泪走心',
            durationSec: 3.2,
            defaultVolume: 90,
        },
        {
            id: 'impact_sword_metallic_ring',
            fileName: 'impact_sword_metallic_ring.mp3',
            name: '⚔️ 寒锋出鞘铿锵·破局锐利共鸣',
            group: '💥 冲击重音 / 纯音效开场',
            mood: '锋利 · 观点破局',
            durationSec: 3.2,
            defaultVolume: 92,
        },
        {
            id: 'impact_news_breaking_hit',
            fileName: 'impact_news_breaking_hit.mp3',
            name: '🚨 突发快讯重击·节奏定调双响',
            group: '💥 冲击重音 / 纯音效开场',
            mood: '紧凑 · 权威开篇',
            durationSec: 3.2,
            defaultVolume: 94,
        },
    ];

    const INTRO_AUDIO_TRACK_MAP = Object.create(null);
    for (const item of INTRO_AUDIO_TRACKS) {
        INTRO_AUDIO_TRACK_MAP[item.id] = item;
    }

    // Complete 1-to-1 curated audio mapping for every built-in intro preset ID.
    const INTRO_PRESET_AUDIO_MAP = {
        // Countdown / Ring / Prayer / Hook
        xmas_cp01: 'xmas_wonder_glockenspiel',
        xmas_auto_days: 'xmas_wonder_glockenspiel',
        thx_auto_days: 'sacred_prayer_organ',
        newyear_countdown: 'holiday_gift_sparkle',
        ready_321: 'countdown_321_tension',
        morning_prayer_gold: 'sacred_prayer_organ',
        fb_yellow_stack_hook: 'viral_hook_punch',

        // Theater velvet & sheer curtains
        curtain_red_reveal: 'curtain_grand_fanfare',
        curtain_burgundy_opera: 'curtain_grand_fanfare',
        curtain_emerald_xmas: 'xmas_wonder_glockenspiel',
        curtain_navy_chapel: 'curtain_grand_fanfare',
        curtain_ivory_linen: 'morning_sheer_harp',
        curtain_blush_satin: 'morning_sheer_harp',
        curtain_champagne_pearl: 'morning_sheer_harp',
        curtain_midnight_star: 'sacred_prayer_organ',
        curtain_red_sweep_up: 'curtain_grand_fanfare',
        curtain_gold_sweep_up: 'curtain_grand_fanfare',
        curtain_sheer_white: 'morning_sheer_harp',
        curtain_sheer_amber: 'morning_sheer_harp',

        // Window blinds & shutters
        blinds_plantation_white: 'wooden_doors_sanctuary',
        blinds_espresso_walnut: 'wooden_doors_sanctuary',
        blinds_golden_morning: 'morning_sheer_harp',
        blinds_sage_cottage: 'wooden_doors_sanctuary',
        blinds_frost_birch: 'winter_crystal_bells',
        blinds_vertical_ivory: 'morning_sheer_harp',
        blinds_midnight_louver: 'dark_cinema_pulse',
        blinds_autumn_maple: 'wooden_doors_sanctuary',

        // Barn / Chapel / Christmas doors
        doors_rustic_barn_cedar: 'wooden_doors_sanctuary',
        doors_whitewash_barn: 'wooden_doors_sanctuary',
        doors_chapel_mahogany: 'sacred_prayer_organ',
        doors_xmas_wreath: 'xmas_wonder_glockenspiel',
        doors_french_black_glass: 'wooden_doors_sanctuary',
        doors_navy_executive: 'curtain_grand_fanfare',
        doors_autumn_maple: 'wooden_doors_sanctuary',
        doors_frost_cabin: 'winter_crystal_bells',

        // Frost / Snow / Glass wipe
        frost_canadian_thaw: 'winter_crystal_bells',
        frost_morning_dew: 'morning_sheer_harp',
        frost_xmas_snow_sweep: 'winter_crystal_bells',
        frost_aurora_ice: 'winter_crystal_bells',
        frost_fireplace_haze: 'morning_sheer_harp',
        frost_lavender_mist: 'morning_sheer_harp',

        // Iris / Shutter / Film Leader / Cross
        iris_hollywood_gold: 'curtain_grand_fanfare',
        iris_film_321_leader: 'countdown_321_tension',
        iris_sunrise_glow: 'morning_sheer_harp',
        iris_bethlehem_star: 'xmas_wonder_glockenspiel',
        iris_chapel_cross: 'sacred_prayer_organ',
        iris_camera_shutter: 'countdown_321_tension',
        iris_diamond_luxury: 'countdown_321_tension',
        iris_midnight_keyhole: 'curtain_grand_fanfare',

        // Gift & Scroll
        gift_xmas_red_gold: 'holiday_gift_sparkle',
        gift_canadian_plaid: 'holiday_gift_sparkle',
        gift_champagne_bow: 'holiday_gift_sparkle',
        gift_emerald_ribbon: 'holiday_gift_sparkle',
        scroll_parchment_unroll: 'parchment_paper_quill',
        scroll_royal_wax_seal: 'parchment_paper_quill',

        // Black screen reveals
        black_slit_fb: 'dark_cinema_pulse',
        black_slit_delay: 'dark_cinema_pulse',
        black_fade_zero: 'dark_cinema_pulse',
        black_fade_in: 'dark_cinema_pulse',
        black_letterbox_open: 'dark_cinema_pulse',
        black_spotlight_wake: 'dark_cinema_pulse',
        black_film_flash: 'countdown_321_tension',
        black_blinds_matte: 'dark_cinema_pulse',

        // Bald eagle ink reveals
        eagle_ink_slash: 'eagle_canyon_drum',
        eagle_wings_split: 'eagle_canyon_drum',
        eagle_gold_obsidian: 'eagle_canyon_drum',
        eagle_morning_grace: 'eagle_canyon_drum',
        eagle_ink_zero: 'eagle_canyon_drum',

        // Patriotic US / Canada flags
        flag_usa_wave: 'patriotic_freedom_anthem',
        flag_usa_part: 'patriotic_freedom_anthem',
        flag_canada_maple: 'patriotic_freedom_anthem',
        flag_usa_zero: 'patriotic_freedom_anthem',

        // Northern Cardinal birds
        cardinal_snow_pine: 'cardinal_woodland_chime',
        cardinal_gold_angel: 'cardinal_woodland_chime',
        cardinal_ink_slash: 'cardinal_woodland_chime',
        cardinal_dawn_split: 'cardinal_woodland_chime',
        cardinal_zero_start: 'cardinal_woodland_chime',

        // Parchment / Newspaper / Morandi watercolor / Frosted paper
        paper_parchment_turn: 'parchment_paper_quill',
        paper_parchment_zero: 'parchment_paper_quill',
        paper_newspaper_flip: 'parchment_paper_quill',
        paper_newspaper_tear: 'parchment_paper_quill',
        paper_linen_minimal: 'morning_sheer_harp',
        paper_frosted_glass: 'parchment_paper_quill',
        watercolor_morandi_sage: 'morning_sheer_harp',
        watercolor_dusty_rose: 'morning_sheer_harp',
        watercolor_slate_mist: 'parchment_paper_quill',
        watercolor_oatmeal_zero: 'morning_sheer_harp',
        watercolor_clay_drift: 'morning_sheer_harp',
        watercolor_mint_porcelain: 'morning_sheer_harp',

        // 2026 Novel Openers: CRT/VHS Glitch, 35mm Film Burn, Polaroid/Magazine, Prism Split
        glitch_crt_power_on: 'crt_glitch_powerup',
        glitch_vhs_tracking: 'crt_glitch_powerup',
        glitch_cyber_rgb_slice: 'viral_hook_punch',
        film_burn_amber_flash: 'film_burn_whoosh',
        film_burn_dreamy_rose: 'film_burn_whoosh',
        polaroid_snap_toss: 'polaroid_shutter_snap',
        magazine_cutout_peel: 'polaroid_shutter_snap',
        polaroid_zero_memory: 'polaroid_shutter_snap',
        prism_triple_panel: 'prism_glass_shimmer',
        prism_diagonal_slice: 'prism_glass_shimmer',

        // Volumetric 2D FBM cloud noise parting reveals
        cloud_part_white_iris: 'cloud_part_heavenly_breeze',
        cloud_part_golden_dawn: 'cloud_dawn_angelic_swoosh',
        cloud_part_rose_heaven: 'cloud_dawn_angelic_swoosh',
        cloud_part_blue_storm_clear: 'cloud_part_heavenly_breeze',

        // Pure audio-only impact SFX openers (zero visual overlay)
        sfx_cinema_boom: 'impact_cinema_boom',
        sfx_riser_slam: 'impact_riser_slam',
        sfx_whip_whoosh: 'impact_whip_whoosh',
        sfx_sacred_bell: 'impact_sacred_cathedral_bell',
        sfx_heartbeat_drop: 'impact_heartbeat_double',
        sfx_thunder_crack: 'impact_thunder_crack',
        sfx_shutter_freeze: 'impact_camera_flash_shutter',
        sfx_piano_deep_drop: 'impact_piano_deep_chord',
        sfx_sword_ring: 'impact_sword_metallic_ring',
        sfx_news_breaking_hit: 'impact_news_breaking_hit',
        sfx_boom_zero_sync: 'impact_cinema_boom',
    };

    function getIntroAudioTrackMeta(trackId) {
        if (!trackId || typeof trackId !== 'string') return null;
        return INTRO_AUDIO_TRACK_MAP[trackId] || null;
    }

    function getDefaultIntroAudioForPreset(presetOrId) {
        if (typeof presetOrId === 'string') {
            if (INTRO_PRESET_AUDIO_MAP[presetOrId]) return INTRO_PRESET_AUDIO_MAP[presetOrId];
            return 'curtain_grand_fanfare';
        }
        const preset = presetOrId || {};
        const id = preset.intro_style || preset.id || '';
        if (id && INTRO_PRESET_AUDIO_MAP[id]) return INTRO_PRESET_AUDIO_MAP[id];

        const cat = preset.intro_category || '';
        const layout = preset.intro_layout || '';
        const style = preset.intro_curtain_style || '';
        const theme = preset.intro_curtain_theme || '';

        if (cat === 'flag' || layout === 'flag_reveal') return 'patriotic_freedom_anthem';
        if (cat === 'eagle' || layout === 'eagle_ink_reveal') return 'eagle_canyon_drum';
        if (cat === 'cardinal' || layout === 'cardinal_reveal') return 'cardinal_woodland_chime';
        if (cat === 'glitch' || layout === 'glitch_reveal') {
            return style === 'cyber_rgb_slice' ? 'viral_hook_punch' : 'crt_glitch_powerup';
        }
        if (cat === 'film_burn' || layout === 'film_burn_reveal') return 'film_burn_whoosh';
        if (cat === 'polaroid' || layout === 'polaroid_reveal') return 'polaroid_shutter_snap';
        if (cat === 'prism' || layout === 'prism_reveal') return 'prism_glass_shimmer';
        if (cat === 'sfx_only' || layout === 'audio_only') return 'impact_cinema_boom';
        if (cat === 'clouds' || layout === 'cloud_reveal') {
            return (theme === 'cloud_golden_dawn' || theme === 'cloud_rose_heaven' || style === 'cloud_part_golden' || style === 'cloud_part_rose')
                ? 'cloud_dawn_angelic_swoosh'
                : 'cloud_part_heavenly_breeze';
        }
        if (cat === 'paper' || layout === 'paper_reveal') {
            return (style === 'watercolor_wash' || style === 'minimal_linen_slide') ? 'morning_sheer_harp' : 'parchment_paper_quill';
        }
        if (cat === 'black' || layout === 'black_reveal') return style === 'film_wake' ? 'countdown_321_tension' : 'dark_cinema_pulse';
        if (cat === 'frost' || layout === 'frost_wipe') return 'winter_crystal_bells';
        if (cat === 'blinds' || cat === 'doors' || layout === 'blinds_reveal' || layout === 'doors_reveal') {
            if (theme === 'emerald_xmas') return 'xmas_wonder_glockenspiel';
            if (theme === 'mahogany_chapel') return 'sacred_prayer_organ';
            if (theme === 'frost_ice_blue') return 'winter_crystal_bells';
            return 'wooden_doors_sanctuary';
        }
        if (cat === 'iris' || layout === 'iris_spotlight') {
            if (style === 'cross_light') return 'sacred_prayer_organ';
            if (style === 'star_iris') return 'xmas_wonder_glockenspiel';
            if (style === 'film_leader' || style === 'shutter_blades') return 'countdown_321_tension';
            return 'curtain_grand_fanfare';
        }
        if (cat === 'gift' || layout === 'gift_scroll_reveal') {
            return (style === 'wax_scroll' || style === 'envelope_flap') ? 'parchment_paper_quill' : 'holiday_gift_sparkle';
        }
        if (cat === 'curtain' || layout === 'curtain_reveal') {
            if (style === 'sheer_breeze' || theme === 'ivory_linen' || theme === 'blush_rose_gold') return 'morning_sheer_harp';
            if (theme === 'emerald_xmas') return 'xmas_wonder_glockenspiel';
            return 'curtain_grand_fanfare';
        }
        if (layout === 'kinetic_stack') return 'viral_hook_punch';
        if (preset.intro_center_mode === 'countdown_sec') return 'countdown_321_tension';
        return 'xmas_wonder_glockenspiel';
    }

    function resolveIntroAudioPresetId(ov) {
        if (!ov || typeof ov !== 'object') return 'curtain_grand_fanfare';
        const raw = ov.intro_audio_preset;
        if (raw === 'none') return 'none';
        if (raw === 'custom') return 'custom';
        if (raw && raw !== 'auto' && INTRO_AUDIO_TRACK_MAP[raw]) return raw;
        return getDefaultIntroAudioForPreset(ov);
    }

    function normalizeMediaFilePath(rawPath) {
        if (!rawPath || typeof rawPath !== 'string') return '';
        const trimmed = rawPath.trim();
        if (!trimmed) return '';
        if (/^(https?|blob|data):/i.test(trimmed)) return trimmed;
        if (/^(?:local-media|file):\/\//i.test(trimmed)) {
            const asFileUrl = trimmed.replace(/^local-media:/i, 'file:');
            if (typeof require === 'function') {
                try {
                    const { fileURLToPath } = require('url');
                    let p = fileURLToPath(asFileUrl);
                    if (typeof process !== 'undefined' && process.platform === 'win32' && /^\/+[a-zA-Z]:/.test(p)) {
                        p = p.replace(/^\/+([a-zA-Z]:)/, '$1');
                    }
                    return p;
                } catch (_) {}
            }
            try {
                let decoded = decodeURIComponent(asFileUrl.replace(/^file:\/\//i, ''));
                if (/^\/+[a-zA-Z]:/.test(decoded)) decoded = decoded.replace(/^\/+([a-zA-Z]:)/, '$1');
                return decoded;
            } catch (_) {}
        }
        return trimmed;
    }

    function _getNodeRequire() {
        try {
            if (typeof require === 'function') return require;
            if (typeof window !== 'undefined' && typeof window.require === 'function') return window.require;
        } catch (_) {}
        return null;
    }

    function resolveIntroAudioFsPath(ovOrId, opts = {}) {
        const req = _getNodeRequire();
        let fs = null;
        let path = null;
        if (req) {
            try {
                fs = req('fs');
                path = req('path');
            } catch (_) {}
        }

        let trackId = '';
        let customPath = '';
        if (typeof ovOrId === 'string') {
            trackId = ovOrId;
        } else if (ovOrId && typeof ovOrId === 'object') {
            trackId = resolveIntroAudioPresetId(ovOrId);
            customPath = ovOrId.intro_audio_custom_path || '';
        }
        if (trackId === 'none') return '';
        if (trackId === 'custom') {
            const cleaned = normalizeMediaFilePath(customPath);
            if (!cleaned) return '';
            if (/^https?:/i.test(cleaned) || /^blob:/i.test(cleaned)) return cleaned;
            if (fs && !fs.existsSync(cleaned)) return '';
            return cleaned;
        }

        const meta = getIntroAudioTrackMeta(trackId);
        if (!meta) return '';

        const rel = `intro-audio/${meta.fileName}`;
        if (fs && path) {
            const candidates = [];
            if (opts.assetsDir) candidates.push(path.join(opts.assetsDir, 'intro-audio', meta.fileName));
            if (typeof process !== 'undefined' && typeof process.resourcesPath === 'string' && process.resourcesPath) {
                candidates.push(path.join(process.resourcesPath, 'assets', 'intro-audio', meta.fileName));
            }
            if (typeof __dirname === 'string') {
                candidates.push(path.join(__dirname, '..', 'assets', 'intro-audio', meta.fileName));
                candidates.push(path.join(__dirname, 'assets', 'intro-audio', meta.fileName));
            }
            if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
                candidates.push(path.join(process.cwd(), 'assets', 'intro-audio', meta.fileName));
                candidates.push(path.join(process.cwd(), 'dist', 'assets', 'intro-audio', meta.fileName));
            }
            for (const cand of candidates) {
                try {
                    if (cand && fs.existsSync(cand)) return cand;
                } catch (_) {}
            }
        }
        return rel;
    }

    function resolveIntroAudioPlayableUrl(ovOrId) {
        let trackId = '';
        let customPath = '';
        if (typeof ovOrId === 'string') {
            trackId = ovOrId;
        } else if (ovOrId && typeof ovOrId === 'object') {
            trackId = resolveIntroAudioPresetId(ovOrId);
            customPath = ovOrId.intro_audio_custom_path || '';
        }
        if (!trackId || trackId === 'none') return '';

        const toUrl = (raw) => {
            if (!raw) return '';
            if (/^(https?|blob|data|local-media):/i.test(raw)) return raw;
            if (typeof window !== 'undefined' && typeof window.electronAPI?.toFileUrl === 'function') {
                return window.electronAPI.toFileUrl(raw);
            }
            if (/^file:\/\//i.test(raw)) return raw;
            return raw;
        };

        if (trackId === 'custom') {
            return customPath ? toUrl(customPath) : '';
        }

        const meta = getIntroAudioTrackMeta(trackId);
        if (!meta) return '';
        const rel = `intro-audio/${meta.fileName}`;

        if (typeof window !== 'undefined' && typeof window.electronAPI?.resolveAssetUrl === 'function') {
            try {
                const resolved = window.electronAPI.resolveAssetUrl(rel);
                if (resolved) return resolved;
            } catch (_) {}
        }

        const fsPath = resolveIntroAudioFsPath(trackId);
        if (fsPath && fsPath !== rel) {
            return toUrl(fsPath);
        }

        if (typeof window !== 'undefined' && window.location) {
            if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
                return `/assets/${rel}`;
            }
            return `./assets/${rel}`;
        }
        return `/assets/${rel}`;
    }

    function findActiveIntroOverlay(overlays, options = {}) {
        if (!Array.isArray(overlays) || !overlays.length) return null;
        if (options.showIntro === false) return null;
        for (let i = overlays.length - 1; i >= 0; i--) {
            const ov = overlays[i];
            if (ov && !ov.disabled && (ov.type === 'intro_countdown' || ov.is_intro_countdown)) {
                return ov;
            }
        }
        return null;
    }

    function getIntroAudioDefaultVolume(ov) {
        const trackId = resolveIntroAudioPresetId(ov);
        if (trackId === 'none') return 0;
        const meta = getIntroAudioTrackMeta(trackId);
        const baseVol = meta?.defaultVolume ?? 85;
        return ov && ov.intro_delay_body === false ? Math.round(baseVol * 0.65) : baseVol;
    }

    function buildIntroAudioClipForTask({ task, overlays, showIntro = true, assetsDir = '', timelineStart = 0 } = {}) {
        const ovList = Array.isArray(overlays) ? overlays : (Array.isArray(task?.overlays) ? task.overlays : []);
        const introOv = findActiveIntroOverlay(ovList, { showIntro });
        if (!introOv) return null;

        const trackId = resolveIntroAudioPresetId(introOv);
        if (!trackId || trackId === 'none') return null;

        const sourcePath = resolveIntroAudioFsPath(introOv, { assetsDir });
        if (!sourcePath || (!/^https?:/i.test(sourcePath) && !sourcePath.includes('/') && !sourcePath.includes('\\'))) {
            // Unresolved relative fallback on disk when missing
            if (!sourcePath || sourcePath.startsWith('intro-audio/')) {
                const req = _getNodeRequire();
                if (req) return null;
            }
        }
        if (!sourcePath) return null;

        const startSec = Math.max(0, Number(introOv.start) || 0);
        const endSec = Math.max(startSec + 0.4, Number(introOv.end) || 2.5);
        const durSec = Math.max(0.4, endSec - startSec);
        const rawVol = introOv.intro_audio_volume;
        const volume = Number.isFinite(Number(rawVol))
            ? Math.max(0, Math.min(200, Number(rawVol)))
            : getIntroAudioDefaultVolume(introOv);
        if (volume <= 0) return null;

        const rawFade = introOv.intro_audio_fade_out;
        const fadeOut = Number.isFinite(Number(rawFade))
            ? Math.max(0, Math.min(durSec * 0.75, Number(rawFade)))
            : Math.min(0.45, durSec * 0.3);

        return {
            sourcePath,
            audioMode: 'mix',
            timelineStart: Math.max(0, (Number(timelineStart) || 0) + startSec),
            duration: durSec,
            sourceTrimStart: 0,
            volume,
            fadeOut,
            isIntroAudio: true,
            trackId,
        };
    }

    function computeIntroAudioPlaybackState(overlays, mainTime, options = {}) {
        const showIntro = options.showIntro !== undefined ? Boolean(options.showIntro) : true;
        const introOv = findActiveIntroOverlay(overlays, { showIntro });
        if (!introOv) {
            return { url: '', active: false, localTime: 0, gain: 0, ovStart: 0, ovEnd: 0, trackId: 'none' };
        }
        const trackId = resolveIntroAudioPresetId(introOv);
        if (!trackId || trackId === 'none') {
            return { url: '', active: false, localTime: 0, gain: 0, ovStart: 0, ovEnd: 0, trackId: 'none' };
        }
        const url = resolveIntroAudioPlayableUrl(introOv);
        if (!url) {
            return { url: '', active: false, localTime: 0, gain: 0, ovStart: 0, ovEnd: 0, trackId };
        }
        const ovStart = Math.max(0, Number(introOv.start) || 0);
        const ovEnd = Math.max(ovStart + 0.4, Number(introOv.end) || 2.5);
        const dur = Math.max(0.4, ovEnd - ovStart);
        const rawVol = introOv.intro_audio_volume;
        const baseVolPct = Number.isFinite(Number(rawVol))
            ? Math.max(0, Math.min(200, Number(rawVol)))
            : getIntroAudioDefaultVolume(introOv);
        const rawFade = introOv.intro_audio_fade_out;
        const fadeOut = Number.isFinite(Number(rawFade))
            ? Math.max(0, Math.min(dur * 0.75, Number(rawFade)))
            : Math.min(0.45, dur * 0.3);

        const t = Number(mainTime);
        const active = Number.isFinite(t) && t >= ovStart && t < ovEnd;
        const localTime = active ? Math.max(0, t - ovStart) : 0;
        let env = 1;
        if (!active) {
            env = 0;
        } else if (fadeOut > 0.01 && localTime > dur - fadeOut) {
            env = Math.max(0, (dur - localTime) / fadeOut);
        }
        const gain = Math.max(0, (baseVolPct / 100) * env);

        return {
            url,
            active,
            localTime,
            gain,
            baseVolPct,
            fadeOut,
            ovStart,
            ovEnd,
            trackId,
        };
    }

    return {
        INTRO_AUDIO_TRACKS,
        INTRO_AUDIO_TRACK_MAP,
        INTRO_PRESET_AUDIO_MAP,
        getIntroAudioTrackMeta,
        getDefaultIntroAudioForPreset,
        getIntroAudioDefaultVolume,
        resolveIntroAudioPresetId,
        normalizeMediaFilePath,
        resolveIntroAudioFsPath,
        resolveIntroAudioPlayableUrl,
        findActiveIntroOverlay,
        buildIntroAudioClipForTask,
        computeIntroAudioPlaybackState,
    };
}));
